"""Functional limit: a 4K video (allowed by the premium plan) under the workers' memory limits.

Generates a 3840x2160, 30 fps, 6 s video with audio, and runs an edit, a preview and automatic
subtitles on it. Records the outcome, container restarts, OOM kills and the peak memory.

  PICTURAS_PROJECT=... PICTURAS_RESULTS=... .venv/Scripts/python.exe c4k.py
"""
import subprocess
import tempfile
from pathlib import Path

from common import Events, StatsSampler, container, log, save_json, sh, worker_containers
from functional import BRIGHT, CONTRAST, PREVIEW, User, apply, project

SECONDS = 6


def make_video(path):
    cmd = ["docker", "exec", container("projects"), "ffmpeg", "-v", "error", "-f", "lavfi",
           "-i", f"testsrc2=size=3840x2160:rate=30:duration={SECONDS}", "-f", "lavfi",
           "-i", f"sine=frequency=440:duration={SECONDS}", "-c:v", "libx264", "-preset", "ultrafast",
           "-pix_fmt", "yuv420p", "-c:a", "aac", "-f", "matroska", "-"]
    raw = subprocess.run(cmd, capture_output=True, check=True).stdout
    # mp4 needs a seekable output: remux inside the container
    cmd = ["docker", "exec", "-i", container("projects"), "sh", "-c",
           "cat > /tmp/in.mkv && ffmpeg -y -v error -i /tmp/in.mkv -c copy /tmp/out.mp4 && cat /tmp/out.mp4"]
    path.write_bytes(subprocess.run(cmd, input=raw, capture_output=True, check=True).stdout)


def states():
    out = {}
    for n in worker_containers():
        r = sh(["docker", "inspect", "-f", "{{.RestartCount}}|{{.State.OOMKilled}}|{{.HostConfig.Memory}}", n])
        restarts, oom, limit = r.stdout.strip().split("|")
        events = sh(["docker", "exec", n, "sh", "-c", "grep -E '^oom_kill ' /sys/fs/cgroup/memory.events; cat /sys/fs/cgroup/memory.peak"],
                    check=False).stdout.split()
        out[n] = {"restarts": int(restarts), "oom_killed": oom, "limit_mb": int(limit) // 2**20,
                  "oom_kills_in_cgroup": int(events[1]) if len(events) > 1 else None,
                  "peak_mb": int(events[2]) // 2**20 if len(events) > 2 else None}
    return out


def main():
    video = Path(tempfile.gettempdir()) / "bench_4k.mp4"
    make_video(video)
    log(f"4K sample: {video.stat().st_size / 2**20:.1f} MB")
    c = User()
    ev = Events(c)
    out = {"before": states()}
    stats = StatsSampler([])
    stats.start()
    r = apply(c, ev, project(c, "4k edit", [video], tools=[BRIGHT, CONTRAST, ("saturation", {"saturationFactor": 1.2})]), 1)
    out["edit"] = r
    log(f"edit: {r.get('outcome')} {r.get('code', '')}")
    pid = project(c, "4k preview", [video], tools=[BRIGHT, CONTRAST])
    k = ev.mark()
    c.preview(pid, c.media_ids(pid)[0])
    e = ev.wait_for(lambda e: e["event"] in PREVIEW, 600, after_index=k)
    out["preview"] = e and {"event": e["event"], "data": str(e["data"])[:150] if e["event"] == "preview-error" else None}
    log(f"preview: {out['preview']}")
    r = apply(c, ev, project(c, "4k subtitles", [video], tools=[("subtitles", {})]), 1)
    out["subtitles"] = r
    log(f"subtitles: {r.get('outcome')} {r.get('code', '')}")
    stats.stop()
    out["after"] = states()
    out["docker_stats_peaks"] = stats.peaks()
    for n, s in out["after"].items():
        log(f"  {n}: {s}")
    ev.close()
    save_json("c4k.json", out)


if __name__ == "__main__":
    main()
