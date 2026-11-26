"""End-to-end functional regression through the public entry point (images and videos).

Runs the same scenarios against the base and against the refactored stack and stores, for
each one, what the user obtains: events, number, names and types of the results, container
and codecs (ffprobe) and a hash of the decoded frames. `compare` checks that both agree.

  PY=benchmarks/baseline/.venv/Scripts/python.exe
  PICTURAS_PROJECT=picturas-baseline PICTURAS_RESULTS=benchmarks/baseline/results $PY benchmarks/baseline/functional.py run
  PICTURAS_PROJECT=picturas-after    PICTURAS_RESULTS=benchmarks/after/results    $PY benchmarks/baseline/functional.py run
  $PY benchmarks/baseline/functional.py compare benchmarks/baseline/results benchmarks/after/results
"""
import hashlib
import json
import re
import struct
import subprocess
import sys
import time
import zlib
from pathlib import Path

from common import (API, SAMPLES, Client, Events, container, log, project_tokens, save_json, sh)

SHORT, MOV, SPEECH = SAMPLES / "sample_10s_720p.mp4", SAMPLES / "sample_6s.mov", SAMPLES / "speech_mandela_177s_1080p.webm"
DONE = ("process-update", "process-error")
PREVIEW = ("preview-ready", "preview-error")


def png(width=64, height=48):
    raw = b"".join(b"\0" + b"".join(bytes((x * 4 % 256, y * 5 % 256, 90)) for x in range(width)) for y in range(height))

    def chunk(kind, data):
        return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data))
    return (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0))
            + chunk(b"IDAT", zlib.compress(raw)) + chunk(b"IEND", b""))


class User(Client):
    def upload_image(self, pid, name="picture.png"):
        r = self.s.post(f"{API}/projects/{self.user_id}/{pid}/img", files={"image": (name, png(), "image/png")},
                        headers={"X-Project-Version": str(self.versions[pid])})
        assert r.status_code < 300, r.text
        self._v(pid, r)

    def cancel(self, pid):
        self.project(pid)
        r = self.s.delete(f"{API}/projects/{self.user_id}/{pid}/process",
                          headers={"X-Project-Version": str(self.versions[pid])})
        self._v(pid, r)
        return r.status_code

    def try_upload(self, pid, path):
        mime = {".mp4": "video/mp4", ".mov": "video/quicktime", ".webm": "video/webm"}[Path(path).suffix]
        with open(path, "rb") as f:
            return self.s.post(f"{API}/projects/{self.user_id}/{pid}/video", files={"video": (Path(path).name, f, mime)},
                               headers={"X-Project-Version": str(self.versions[pid])})

    def wait_run(self, ev, pid, since, expected, timeout=900):
        """Waits for the run to be committed (or an error event)."""
        end = time.time() + timeout
        while time.time() < end:
            errors = [e for e in ev.snapshot() if e["event"] == "process-error" and e["t"] >= since]
            t = project_tokens(pid) or {}
            updates = [e for e in ev.snapshot() if e["event"] == "process-update" and e["t"] >= since]
            if errors:
                return {"outcome": "error", "code": str(errors[0]["data"]["error_code"])}
            if t.get("committedToken") == t.get("activeToken") and len(updates) >= expected:
                return {"outcome": "committed", "updates": len(updates)}
            time.sleep(1)
        return {"outcome": "timeout", "updates": len(updates)}


def media(client, url):
    """Properties of a result: type, dimensions, codecs and a hash of the decoded content."""
    data = client.s.get(url, verify=False).content
    run = lambda *a: subprocess.run(["docker", "exec", "-i", container("projects"), *a], input=data, capture_output=True)
    probe = json.loads(run("ffprobe", "-v", "error", "-show_entries",
                           "stream=codec_name,codec_type,width,height,nb_frames:format=format_name,duration",
                           "-of", "json", "-").stdout or b"{}")
    frames = run("ffmpeg", "-v", "error", "-i", "pipe:0", "-map", "0:v:0", "-f", "framemd5", "-").stdout.decode()
    rows = [l.split(",")[-1].strip() for l in frames.splitlines() if l and not l.startswith("#")]
    return {"streams": sorted([s.get("codec_type", ""), s.get("codec_name", ""), s.get("width"), s.get("height")]
                              for s in probe.get("streams", [])) if probe.get("streams") else [],
            "frames": len(rows), "content": hashlib.sha256("".join(rows).encode()).hexdigest()[:16]}


def walk(value):
    if isinstance(value, dict):
        if isinstance(value.get("url"), str):
            yield value
        for v in value.values():
            yield from walk(v)
    elif isinstance(value, list):
        for v in value:
            yield from walk(v)


def outputs(client, pid):
    status, body = client.results(pid)
    ids = {m: f"media-{i}" for i, m in enumerate(client.media_ids(pid))}
    out = []
    for item in walk(body):
        name = item.get("name") or item.get("img_name") or item.get("file_name") or ""
        for raw, label in ids.items():
            name = name.replace(raw, label)
        out.append({"name": name, **media(client, item["url"])})
    return {"status": status, "results": sorted(out, key=lambda o: (o["name"], o["content"]))}


SCENARIOS = {}


def scenario(f):
    SCENARIOS[f.__name__] = f
    return f


def project(c, name, videos=(), images=0, tools=()):
    pid = c.create_project(name)
    for v in videos:
        c.upload_video(pid, v)
    for i in range(images):
        c.upload_image(pid, f"picture{i}.png")
    ids = c.media_ids(pid)
    for procedure, params in tools:
        c.add_tool(pid, procedure, {k: (ids[0] if v == "$0" else v) for k, v in params.items()})
    return pid


def apply(c, ev, pid, expected):
    t0, _, status, body = c.process(pid)
    if status != 201:
        return {"http": status, "body": body[:120]}
    return {"http": status, **c.wait_run(ev, pid, t0, expected), **outputs(c, pid)}


BRIGHT, CONTRAST = ("brightness", {"brightness": 1.3}), ("contrast", {"contrastFactor": 1.2})


@scenario
def image_chain(c, ev):
    return apply(c, ev, project(c, "image chain", images=3, tools=[BRIGHT, CONTRAST, ("rotate", {"degrees": 90})]), 3)


@scenario
def video_effects(c, ev):
    return apply(c, ev, project(c, "video effects", [SHORT], tools=[BRIGHT, CONTRAST, ("binarization", {"threshold": 120})]), 1)


@scenario
def video_trim_speed(c, ev):
    return apply(c, ev, project(c, "trim speed", [SHORT], tools=[
        ("trim", {"start": 2, "end": 6, "imgId": "$0"}), ("speed", {"factor": 2, "imgId": "$0"})]), 1)


@scenario
def mov_to_mp4(c, ev):
    return apply(c, ev, project(c, "mov", [MOV], tools=[BRIGHT]), 1)


@scenario
def mixed_project(c, ev):
    return apply(c, ev, project(c, "mixed", [SHORT, MOV], images=2, tools=[
        BRIGHT, ("trim", {"start": 0, "end": 3, "imgId": "$0"}), CONTRAST]), 4)


@scenario
def extract_frames(c, ev):
    return apply(c, ev, project(c, "frames", [MOV], images=1, tools=[
        BRIGHT, ("extract_frames", {"mode": "count", "count": 4, "format": "png"})]), 2)


@scenario
def subtitles_without_speech(c, ev):
    return apply(c, ev, project(c, "subtitles", [SHORT], tools=[("subtitles", {})]), 1)


@scenario
def preview_video(c, ev):
    pid = project(c, "preview", [SHORT], tools=[BRIGHT, CONTRAST])
    first = []
    for _ in range(2):  # the second one comes from the preview cache
        k = ev.mark()
        _, _, status, _ = c.preview(pid, c.media_ids(pid)[0])
        e = ev.wait_for(lambda e: e["event"] in PREVIEW, 300, after_index=k)
        urls = json.loads(e["data"]) if isinstance(e["data"], str) else e["data"]
        first.append({"http": status, "event": e["event"], "type": urls.get("mediaType"), **media(c, urls["imageUrl"])})
    return {"previews": first}


@scenario
def preview_image(c, ev):
    pid = project(c, "preview image", images=1, tools=[BRIGHT, CONTRAST])
    k = ev.mark()
    _, _, status, _ = c.preview(pid, c.media_ids(pid)[0])
    e = ev.wait_for(lambda e: e["event"] in PREVIEW, 120, after_index=k)
    urls = json.loads(e["data"])
    return {"http": status, "event": e["event"], **media(c, urls["imageUrl"])}


@scenario
def preview_contact_sheet(c, ev):
    pid = project(c, "contact", [MOV], tools=[("extract_frames", {"mode": "count", "count": 4, "format": "png"})])
    k = ev.mark()
    _, _, status, _ = c.preview(pid, c.media_ids(pid)[0])
    e = ev.wait_for(lambda e: e["event"] in PREVIEW, 300, after_index=k)
    urls = json.loads(e["data"])
    return {"http": status, "event": e["event"], "type": urls.get("mediaType"), **media(c, urls["imageUrl"])}


@scenario
def invalid_trim_is_reported(c, ev):
    return apply(c, ev, project(c, "bad trim", [SHORT], tools=[("trim", {"start": 50, "end": 60, "imgId": "$0"})]), 1)


@scenario
def cancel_then_apply_again(c, ev):
    pid = project(c, "cancel", [SHORT], tools=[BRIGHT, CONTRAST])
    t0, _, status, _ = c.process(pid)
    ev.wait_for(lambda e: e["event"] == "video-progress" and e["data"]["percent"] >= 20, 120, t0)
    cancelled = c.cancel(pid)
    c.project(pid)  # refresh the version
    c.add_tool(pid, "binarization", {"threshold": 120})
    t1, _, again, _ = c.process(pid)
    return {"http": [status, cancelled, again], **c.wait_run(ev, pid, t1, 1), **outputs(c, pid)}


@scenario
def rejected_uploads(c, ev):
    pid = c.create_project("rejected")
    out = {"corrupted": c.try_upload(pid, SAMPLES / "corrupted.mp4").status_code}
    free = User("free")
    fp = free.create_project("free")
    out["too_long_free"] = free.try_upload(fp, SAMPLES / "too_long_90s.mp4").status_code
    out["too_long_premium"] = c.try_upload(pid, SAMPLES / "too_long_90s.mp4").status_code
    return out


@scenario
def free_daily_quota(c, ev):
    free = User("free")
    fev = Events(free)
    try:
        pid = project(free, "quota", [MOV], tools=[BRIGHT, CONTRAST, ("rotate", {"degrees": 180})])
        first = apply(free, fev, pid, 1)
        _, _, status, body = free.process(pid)  # 3 + 3 > 5 operations
        return {"first": first.get("outcome"), "second_http": status}
    finally:
        fev.close()


def run(names):
    out = {}
    for name in names or SCENARIOS:
        c = User()
        ev = Events(c)
        t = time.time()
        try:
            out[name] = SCENARIOS[name](c, ev)
        except Exception as e:  # noqa: BLE001 - recorded as the result of the scenario
            out[name] = {"exception": f"{type(e).__name__}: {e}"[:300]}
        finally:
            ev.close()
        log(f"{name}: {json.dumps(out[name])[:150]} ({time.time() - t:.0f} s)")
    save_json("functional.json", out)


def compare(a, b):
    a, b = (json.loads((Path(p) / "functional.json").read_text(encoding="utf-8")) for p in (a, b))
    bad = 0
    for name in sorted(set(a) | set(b)):
        same = a.get(name) == b.get(name) and "exception" not in a.get(name, {"exception": 1})
        bad += not same
        print(f"{'SAME' if same else 'DIFF'}  {name}")
        if not same:
            print("   base :", json.dumps(a.get(name))[:700])
            print("   after:", json.dumps(b.get(name))[:700])
    print(f"{len(set(a) | set(b)) - bad} equal, {bad} different")
    return bad


if __name__ == "__main__":
    if sys.argv[1:2] == ["compare"]:
        sys.exit(1 if compare(*sys.argv[2:4]) else 0)
    run(sys.argv[2:])
