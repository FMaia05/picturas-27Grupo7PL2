"""PictuRAS video processing.

Decodes the video once with ffmpeg, applies the effect pipeline to every
frame with the same PIL operations as the image tools, and encodes once to
MP4/H.264 + AAC, keeping the audio.

Trim (time cut) is resolved before decoding: only the [start, end] window is
read, and the audio is cut on the same window so it stays in sync with the
picture.

Speed changes the playback rate (0.25x to 5x): frame timestamps are rescaled
while decoding and the audio tempo is changed by the same factor, so both stay
in sync. Trim times always refer to the original video.
"""
import json
import os
import subprocess
import tempfile
import uuid
from pathlib import Path
from fractions import Fraction

from PIL import Image

from effects import SUPPORTED, UnsupportedEffect, apply_frame_effects

# Preview: only the first seconds
PREVIEW_SECONDS = float(os.getenv("VIDEO_PREVIEW_SECONDS", "3"))

# Allowed playback speed factors
MIN_SPEED = 0.25
MAX_SPEED = 5.0


class InvalidVideo(Exception):
    """File is not a readable video (corrupted, no video stream, ...)."""


class InvalidTrim(Exception):
    """Trim parameters outside the video duration or with end before start."""


class InvalidSpeed(Exception):
    """Speed factor outside the allowed range or not numeric."""


class ProcessingError(Exception):
    """ffmpeg failure while decoding or encoding."""


def probe(path: str, prefer_video_duration: bool = False) -> dict:
    """Reads the video characteristics with ffprobe."""
    cmd = [
        "ffprobe", "-v", "error", "-print_format", "json",
        "-show_format", "-show_streams", path,
    ]
    res = subprocess.run(cmd, capture_output=True, text=True)
    if res.returncode != 0:
        raise InvalidVideo(f"Unreadable video file: {res.stderr.strip()[:200]}")

    data = json.loads(res.stdout or "{}")
    streams = data.get("streams", [])
    video = next((s for s in streams if s.get("codec_type") == "video"), None)
    audio = next((s for s in streams if s.get("codec_type") == "audio"), None)
    if video is None:
        raise InvalidVideo("The file has no video stream")

    fmt = data.get("format", {})
    duration = float(
        (video.get("duration") if prefer_video_duration else None)
        or fmt.get("duration") or video.get("duration") or 0
    )
    if duration <= 0:
        raise InvalidVideo("Could not determine the video duration")

    fps_str = video.get("avg_frame_rate") or video.get("r_frame_rate") or "0/1"
    try:
        fps = float(Fraction(fps_str))
    except (ZeroDivisionError, ValueError):
        fps = 0.0
    if fps <= 0:
        fps_str, fps = "25/1", 25.0

    return {
        "duration": duration,
        "width": int(video["width"]),
        "height": int(video["height"]),
        "fps": fps,
        "fps_str": fps_str,
        "video_codec": video.get("codec_name"),
        "audio_codec": audio.get("codec_name") if audio else None,
        "has_audio": audio is not None,
        "format_name": fmt.get("format_name"),
        "size_bytes": int(fmt.get("size") or os.path.getsize(path)),
    }


def resolve_trim(tools: list, duration: float) -> tuple:
    """Composes the pipeline trims, in order, into one [start, end] window in seconds.

    Each trim's times are relative to the video as it is at that point of the
    pipeline (after the previous trims).
    """
    start, end = 0.0, float(duration)
    for tool in tools:
        if tool.get("procedure") != "trim":
            continue
        params = tool.get("params") or {}
        try:
            t_start = float(params.get("start", 0))
            t_end = float(params.get("end"))
        except (TypeError, ValueError):
            raise InvalidTrim("Trim requires numeric start and end (seconds)")
        length = end - start
        if t_start < 0 or t_end <= t_start:
            raise InvalidTrim("Trim end must be after its start")
        if t_start >= length or t_end > length + 1e-3:
            raise InvalidTrim(
                f"Trim [{t_start}, {t_end}] s is outside the video duration ({length:.2f} s)"
            )
        start, end = start + t_start, start + min(t_end, length)
    return start, end


def resolve_speed(tools: list) -> float:
    """Combined playback speed of the pipeline (several speed effects multiply)."""
    factor = 1.0
    for tool in tools:
        if tool.get("procedure") != "speed":
            continue
        try:
            f = float((tool.get("params") or {}).get("factor"))
        except (TypeError, ValueError):
            raise InvalidSpeed("Speed requires a numeric factor")
        if not MIN_SPEED <= f <= MAX_SPEED:
            raise InvalidSpeed(f"Speed must be between {MIN_SPEED}x and {MAX_SPEED}x (got {f}x)")
        factor *= f
    return factor


def atempo_chain(factor: float) -> str:
    """ffmpeg atempo filters for `factor` (each atempo stage must be in [0.5, 2])."""
    stages = []
    while factor > 2.0:
        stages.append(2.0)
        factor /= 2.0
    while factor < 0.5:
        stages.append(0.5)
        factor /= 0.5
    stages.append(factor)
    return ",".join(f"atempo={s:.6f}" for s in stages)


def validate_tools(tools: list) -> None:
    extractors = [i for i, tool in enumerate(tools) if tool.get("procedure") == "extract_frames"]
    if extractors:
        from frame_extraction import InvalidExtraction, validate_params
        if extractors != [len(tools) - 1]:
            raise InvalidExtraction("Frame extraction must appear once, at the end of the pipeline")
        validate_params(tools[-1].get("params", {}))
    for tool in tools:
        if tool.get("procedure") not in SUPPORTED | {"subtitles", "extract_frames"}:
            raise UnsupportedEffect(
                f"Effect '{tool.get('procedure')}' is not available for video"
            )


def work_directory(output_path):
    directory = Path(os.getenv("VIDEO_WORK_DIR") or Path(output_path).resolve().parent)
    directory.mkdir(parents=True, exist_ok=True)
    return directory


def _process_video(input_path: str, output_path: str, tools: list,
                  progress_cb=None, preview: bool = False) -> dict:
    """Applies `tools` (ordered) to the video at `input_path` and writes MP4 to `output_path`.

    `progress_cb(percent: int)` is called as frames are processed.
    On failure no partial file is left at `output_path`.
    The original is never modified.
    """
    validate_tools(tools)
    speed = resolve_speed(tools)
    info = probe(input_path)
    start, end = resolve_trim(tools, info["duration"])
    if preview:
        # the preview shows PREVIEW_SECONDS of output, i.e. PREVIEW_SECONDS * speed of source
        end = min(end, start + PREVIEW_SECONDS * speed)
    duration = end - start

    w, h = info["width"], info["height"]
    frame_bytes = w * h * 3
    expected_frames = max(1, round(duration / speed * info["fps"]))

    # rescale timestamps by the speed factor, then resample to the original frame rate
    # (frames are dropped when speeding up and duplicated when slowing down)
    decode_cmd = [
        "ffmpeg", "-v", "error", "-ss", f"{start:.3f}", "-t", f"{duration:.3f}",
        "-i", input_path, "-map", "0:v:0", "-an",
        "-vf", f"setpts=PTS/{speed:.6f},fps={info['fps_str']}",
        "-f", "rawvideo", "-pix_fmt", "rgb24", "-",
    ]

    os.makedirs(os.path.dirname(os.path.abspath(output_path)), exist_ok=True)
    tmp_out = str(work_directory(output_path) / f"{uuid.uuid4().hex}.part.mp4")
    dec_err = tempfile.TemporaryFile()
    enc_err = tempfile.TemporaryFile()
    decoder = subprocess.Popen(decode_cmd, stdout=subprocess.PIPE, stderr=dec_err)
    encoder = None
    frames = 0
    last_pct = -1

    try:
        while True:
            raw = decoder.stdout.read(frame_bytes)
            if len(raw) < frame_bytes:
                break
            frame = Image.frombytes("RGB", (w, h), raw)
            out = apply_frame_effects(frame, tools)

            if encoder is None:
                encoder = _start_encoder(input_path, tmp_out, out.size, info,
                                         start, duration, speed, enc_err)
            encoder.stdin.write(out.tobytes())
            frames += 1

            pct = min(99, int(frames * 100 / expected_frames))
            if progress_cb and pct != last_pct and (pct - last_pct >= 2 or pct == 99):
                last_pct = pct
                progress_cb(pct)

        decoder.stdout.close()
        if decoder.wait() != 0:
            raise ProcessingError(_read(dec_err) or "Failed to decode the video")
        if encoder is None:
            raise InvalidVideo("The video has no readable frames in the requested window")
        encoder.stdin.close()
        if encoder.wait() != 0:
            raise ProcessingError(_read(enc_err) or "Failed to encode the video")

        os.replace(tmp_out, output_path)
    except BaseException:
        for p in (decoder, encoder):
            if p and p.poll() is None:
                p.kill()
                p.wait()
        if os.path.exists(tmp_out):
            os.remove(tmp_out)
        raise
    finally:
        dec_err.close()
        enc_err.close()

    if progress_cb:
        progress_cb(100)

    result = probe(output_path)
    result["frames"] = frames
    return result


def _start_encoder(input_path, out_path, size, info, start, duration, speed, err_file):
    ow, oh = size
    cmd = [
        "ffmpeg", "-y", "-v", "error",
        "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", f"{ow}x{oh}",
        "-r", info["fps_str"], "-i", "-",
    ]
    if info["has_audio"]:
        # same time window as the video => audio in sync with the picture
        cmd += ["-ss", f"{start:.3f}", "-t", f"{duration:.3f}", "-i", input_path,
                "-map", "0:v:0", "-map", "1:a:0", "-c:a", "aac", "-b:a", "128k"]
        if abs(speed - 1.0) > 1e-6:
            # same speed factor on the audio => still in sync with the picture
            cmd += ["-af", atempo_chain(speed)]
    else:
        cmd += ["-map", "0:v:0"]
    cmd += [
        # H.264/yuv420p requires even dimensions
        "-vf", "pad=ceil(iw/2)*2:ceil(ih/2)*2",
        "-c:v", "libx264", "-preset", "veryfast", "-crf", "23",
        "-pix_fmt", "yuv420p", "-movflags", "+faststart",
        "-shortest", "-f", "mp4", out_path,
    ]
    return subprocess.Popen(cmd, stdin=subprocess.PIPE, stderr=err_file)


def _read(f) -> str:
    f.seek(0)
    return f.read().decode(errors="replace").strip()[-500:]


def process_video(input_path: str, output_path: str, tools: list,
                  progress_cb=None, preview: bool = False) -> dict:
    """Run caption stages in order, keeping the existing fast path for other tools.

    Captioning is a video-to-video effect. Effects after it act on the captioned
    frames too. Work stays temporary until the entire pipeline succeeds.
    """
    validate_tools(tools)
    if tools and tools[-1].get("procedure") == "extract_frames":
        from frame_extraction import extract_frames
        if len(tools) == 1:
            # With no preceding edits, seek directly in the original. Extracting
            # a few stills must not transcode an entire long video or add a lossy
            # generation before a PNG export. Use video duration when available
            # so a longer audio stream does not create out-of-range sample times.
            return extract_frames(input_path, output_path,
                                  probe(input_path, prefer_video_duration=True),
                                  tools[-1].get("params", {}),
                                  progress_cb or (lambda _: None), preview=preview, work_dir=work_directory(output_path))
        target = Path(output_path).resolve()
        target.parent.mkdir(parents=True, exist_ok=True)
        with tempfile.TemporaryDirectory(prefix=f"frame-source-{uuid.uuid4().hex}-", dir=work_directory(target)) as work:
            edited = str(Path(work) / "edited.mp4")
            # Sampling spans the complete edited timeline, including in preview.
            info = process_video(input_path, edited, tools[:-1],
                                 lambda pct: progress_cb(int(pct * 0.7)) if progress_cb else None,
                                 preview=False)
            return extract_frames(edited, output_path, info, tools[-1].get("params", {}),
                                  lambda pct: progress_cb(70 + int(pct * 0.3)) if progress_cb else None,
                                  preview=preview, work_dir=work_directory(output_path))
    if not any(t.get("procedure") == "subtitles" for t in tools):
        return _process_video(input_path, output_path, tools, progress_cb, preview)

    from subtitles import caption_video

    stages, pending = [], []
    for tool in tools:
        if tool.get("procedure") == "subtitles":
            # Normalize the first input to MP4/H.264 even when captioning is a no-op.
            if pending or not stages:
                stages.append(pending)
                pending = []
            stages.append(None)
        else:
            pending.append(tool)
    if pending:
        stages.append(pending)

    # A preview is the first seconds of the final timeline. Cutting the initial
    # input before a later trim/speed would discard needed frames or produce the
    # wrong preview length. Keep preceding stages complete until the final
    # temporal stage; ordinary pipelines still limit input before recognition.
    # This deliberately trades more recognition work for correct downstream cuts.
    preview_stage = max(
        (index for index, stage in enumerate(stages)
         if stage is not None and any(
             tool.get("procedure") in {"trim", "speed"} for tool in stage)),
        default=0,
    )

    target = Path(output_path).resolve()
    target.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix=f"captions-{uuid.uuid4().hex}-", dir=work_directory(target)) as work:
        current = input_path
        for index, stage in enumerate(stages):
            next_path = str(Path(work) / f"stage-{index}.mp4")

            def progress(percent):
                if progress_cb:
                    progress_cb(min(99, int((index + percent / 100) * 100 / len(stages))))

            progress(0)
            if stage is None:
                caption_video(current, next_path, probe(current), progress)
            else:
                _process_video(current, next_path, stage, progress,
                               preview=preview and index == preview_stage)
            current = next_path
        result = probe(current)
        result["frames"] = round(result["duration"] * result["fps"])
        os.replace(current, target)
    if progress_cb:
        progress_cb(100)
    return result
