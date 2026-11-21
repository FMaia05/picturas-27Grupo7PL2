"""Shared helpers for the Phase 2 baseline measurements (CAND-1 and CAND-2).

Everything goes through the public entry point (nginx, https://localhost:8080) as the
browser does, except the observation instruments: `docker` CLI (logs, stats, kill,
pause), the RabbitMQ management API (http://localhost:15672) and read-only queries to
the projects MongoDB through `docker exec`. No application code is changed.

Clocks: client-side times come from the host clock (time.time(), UTC); container
log timestamps and MongoDB `createdAt` come from the Docker VM clock. Intervals are
only computed between timestamps of the same clock, except where stated in the report.
"""
import datetime as dt
import json
import os
import re
import subprocess
import threading
import time
import uuid
from pathlib import Path

import requests
import socketio
import urllib3

urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)

BASE = os.environ.get("PICTURAS_URL", "https://localhost:8080")
API = f"{BASE}/api-gateway"
RABBIT_API = os.environ.get("RABBIT_API", "http://localhost:15672/api")
RABBIT_AUTH = ("user", "password")  # committed in docker-compose.yaml / definitions.json
# Compose project name. The baseline runs as a separate project so it gets clean volumes
# without touching docker-compose.yaml or older stacks (containers: <project>-<svc>-1).
PROJECT = os.environ.get("PICTURAS_PROJECT", "picturas-baseline")

ROOT = Path(__file__).resolve().parent
REPO = ROOT.parent.parent
SAMPLES = REPO / "samples" / "video"
RESULTS = ROOT / "results"
RESULTS.mkdir(exist_ok=True)


def utcnow():
    return dt.datetime.now(dt.timezone.utc)


def iso(t=None):
    if t is None:
        return utcnow().isoformat()
    return dt.datetime.fromtimestamp(t, dt.timezone.utc).isoformat()


def parse_iso(s):
    s = s.strip().replace("Z", "+00:00")
    # docker gives nanoseconds; python wants at most microseconds
    m = re.match(r"(.*\.\d{6})\d*(\+.*)", s)
    if m:
        s = m.group(1) + m.group(2)
    return dt.datetime.fromisoformat(s)


def log(msg):
    print(f"[{utcnow().strftime('%H:%M:%S')}] {msg}", flush=True)


def container(service):
    return f"{PROJECT}-{service}-1"


def sh(cmd, check=True, timeout=600):
    r = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout,
                       encoding="utf-8", errors="replace")
    if check and r.returncode != 0:
        raise RuntimeError(f"{' '.join(cmd)} failed ({r.returncode}): {r.stderr.strip()}")
    return r


# --------------------------------------------------------------------------- API
class Client:
    """One registered user talking to the API gateway."""

    def __init__(self, kind="premium"):
        self.s = requests.Session()
        self.s.verify = False
        self.s.trust_env = False  # REQUESTS_CA_BUNDLE in the environment would override verify=False
        tag = uuid.uuid4().hex[:10]
        self.email = f"bench-{tag}@baseline.test"
        self.password = f"Bench-{tag}"
        r = self.s.post(f"{API}/users", json={
            "name": f"bench {tag}", "email": self.email,
            "password": self.password, "type": kind,
        })
        r.raise_for_status()
        body = r.json()
        self.jwt = body["jwt"]
        self.user_id = body["user"]["_id"]
        self.s.headers["Authorization"] = f"Bearer {self.jwt}"
        self.versions = {}

    def _v(self, pid, resp):
        v = resp.headers.get("X-Project-Version")
        if v is not None:
            self.versions[pid] = int(v)

    def create_project(self, name):
        r = self.s.post(f"{API}/projects/{self.user_id}", json={"name": name})
        r.raise_for_status()
        p = r.json()
        self.versions[p["_id"]] = int(p.get("version", 0))
        return p["_id"]

    def upload_video(self, pid, path):
        path = Path(path)
        mime = {".mp4": "video/mp4", ".mov": "video/quicktime", ".webm": "video/webm"}[path.suffix]
        with open(path, "rb") as f:
            r = self.s.post(f"{API}/projects/{self.user_id}/{pid}/video",
                            files={"video": (path.name, f, mime)},
                            headers={"X-Project-Version": str(self.versions[pid])})
        if r.status_code >= 300:
            raise RuntimeError(f"upload {path.name}: {r.status_code} {r.text}")
        self._v(pid, r)

    def add_tool(self, pid, procedure, params):
        r = self.s.post(f"{API}/projects/{self.user_id}/{pid}/tool",
                        json={"procedure": procedure, "params": params},
                        headers={"X-Project-Version": str(self.versions[pid])})
        if r.status_code >= 300:
            raise RuntimeError(f"tool {procedure}: {r.status_code} {r.text}")
        self._v(pid, r)

    def project(self, pid):
        r = self.s.get(f"{API}/projects/{self.user_id}/{pid}")
        r.raise_for_status()
        p = r.json()
        if "version" in p:
            self.versions[pid] = int(p["version"])
        return p

    def media_ids(self, pid):
        return [str(i["_id"]) for i in self.project(pid)["imgs"]]

    def process(self, pid):
        """POST /process. Returns (t_before, t_after, status, body)."""
        self.project(pid)  # refresh version
        t0 = time.time()
        r = self.s.post(f"{API}/projects/{self.user_id}/{pid}/process", json={},
                        headers={"X-Project-Version": str(self.versions[pid])})
        t1 = time.time()
        self._v(pid, r)
        return t0, t1, r.status_code, r.text

    def preview(self, pid, img_id):
        t0 = time.time()
        r = self.s.post(f"{API}/projects/{self.user_id}/{pid}/preview/{img_id}", json={})
        t1 = time.time()
        return t0, t1, r.status_code, r.text

    def results(self, pid):
        r = self.s.get(f"{API}/projects/{self.user_id}/{pid}/process/url")
        return r.status_code, (r.json() if r.status_code == 200 else r.text)


# --------------------------------------------------------------------------- Socket.IO
class Events:
    """Socket.IO listener (through nginx) that timestamps every event of one user."""

    NAMES = ["video-progress", "process-update", "process-error",
             "preview-ready", "preview-error", "authError"]

    def __init__(self, client):
        self.items = []
        self.lock = threading.Lock()
        self.cond = threading.Condition(self.lock)
        self.sio = socketio.Client(ssl_verify=False, reconnection=True)
        for name in self.NAMES:
            self.sio.on(name, self._handler(name))
        self.sio.connect(BASE, auth={"token": client.jwt}, transports=["websocket"],
                         socketio_path="socket.io", wait_timeout=20)

    def _handler(self, name):
        def h(data=None):
            with self.cond:
                self.items.append({"t": time.time(), "event": name, "data": data})
                self.cond.notify_all()
        return h

    def mark(self):
        """Index of the next event to arrive. Events carry no request id (e.g. preview-ready
        only has a URL) and Windows timestamps have ~15 ms resolution, so sequential
        requests are paired with events by arrival order, not by time."""
        with self.lock:
            return len(self.items)

    def wait_for(self, pred, timeout, since=0.0, after_index=0):
        """Block until an event e (index >= after_index, e['t'] >= since) with pred(e)."""
        end = time.time() + timeout
        with self.cond:
            while True:
                for e in self.items[after_index:]:
                    if e["t"] >= since and pred(e):
                        return e
                left = end - time.time()
                if left <= 0:
                    return None
                self.cond.wait(min(left, 1.0))

    def snapshot(self):
        with self.lock:
            return list(self.items)

    def close(self):
        try:
            self.sio.disconnect()
        except Exception:
            pass


# --------------------------------------------------------------------------- MongoDB (read-only)
def mongo_projects(js):
    """Evaluate JS in the projects MongoDB (db 'project') and return parsed JSON."""
    code = f"var r = (function(){{ {js} }})(); print(JSON.stringify(r));"
    r = sh(["docker", "exec", container("projects_mongoDB"), "mongo", "--port", "27018",
            "--quiet", "project", "--eval", code])
    out = r.stdout.strip().splitlines()
    return json.loads(out[-1]) if out else None


def pid_match(project_id):
    """Mongo filter value for a project id stored as ObjectId (or, defensively, string)."""
    return f"{{$in: [ObjectId('{project_id}'), '{project_id}']}}"


def processes(project_id):
    return mongo_projects(
        f"return db.processes.find({{project_id: {pid_match(project_id)}}}).toArray().map(function(p){{"
        f"return {{msg_id: p.msg_id, img_id: (p.img_id.str || String(p.img_id)), createdAt: p.createdAt, token: p.token}};}});"
    ) or []


def results_db(project_id):
    return mongo_projects(
        f"return db.results.find({{project_id: {pid_match(project_id)}}}).toArray().map(function(p){{"
        f"return {{img_id: (p.img_id.str || String(p.img_id)), type: p.type, file_name: p.file_name, token: p.token}};}});"
    ) or []


def project_tokens(project_id):
    return mongo_projects(
        f"var p = db.projects.findOne({{_id: ObjectId('{project_id}')}});"
        f"return p ? {{activeToken: p.activeToken, committedToken: p.committedToken}} : null;"
    )


# --------------------------------------------------------------------------- RabbitMQ
def queue(name="video_queue"):
    r = requests.get(f"{RABBIT_API}/queues/%2F/{name}", auth=RABBIT_AUTH, timeout=10)
    r.raise_for_status()
    q = r.json()
    return {k: q.get(k) for k in ("messages", "messages_ready", "messages_unacknowledged",
                                  "consumers", "durable", "arguments", "policy")}


def wait_rabbit(timeout=180):
    end = time.time() + timeout
    while time.time() < end:
        try:
            queue()
            return True
        except Exception:
            time.sleep(2)
    return False


# --------------------------------------------------------------------------- docker
def compose(*args, check=True, timeout=600):
    return sh(["docker", "compose", "-p", PROJECT, "-f", str(REPO / "docker-compose.yaml"), *args],
              check=check, timeout=timeout)


def video_tool_log(since_iso):
    """`[video] msg=...` lines of video_tool since a UTC instant, with docker timestamps."""
    r = sh(["docker", "logs", "--timestamps", "--since", since_iso, container("video_tool")],
           check=False)
    lines = []
    for raw in (r.stdout + r.stderr).splitlines():
        parts = raw.split(" ", 1)
        if len(parts) == 2 and "[video]" in parts[1]:
            lines.append((parse_iso(parts[0]), parts[1]))
    return lines


def worker_events(since_iso):
    """Map msg_id -> {'starts': [ts...], 'ok': ts|None} from video_tool logs."""
    out = {}
    for ts, line in video_tool_log(since_iso):
        m = re.search(r"msg=(\S+)", line)
        if not m:
            continue
        d = out.setdefault(m.group(1), {"starts": [], "ok": None, "ok_line": None})
        if " ok " in line:
            d["ok"] = ts
            d["ok_line"] = line
        elif "preview=" in line:
            d["starts"].append(ts)
    return out


class StatsSampler(threading.Thread):
    """Samples `docker stats --no-stream` every `period` seconds into rows."""

    def __init__(self, services, period=1.0):
        super().__init__(daemon=True)
        self.names = [container(s) for s in services]
        self.period = period
        self.rows = []
        self._halt = threading.Event()

    @staticmethod
    def _mem_mb(s):
        used = s.split("/")[0].strip()
        m = re.match(r"([\d.]+)\s*([KMG]i?B|B)", used)
        if not m:
            return None
        v, u = float(m.group(1)), m.group(2)
        return v * {"B": 1 / 2**20, "KiB": 1 / 1024, "KB": 1 / 1024, "MiB": 1, "MB": 1,
                    "GiB": 1024, "GB": 1024}[u]

    def run(self):
        fmt = "{{.Name}};{{.CPUPerc}};{{.MemUsage}}"
        while not self._halt.is_set():
            t = time.time()
            r = sh(["docker", "stats", "--no-stream", "--format", fmt, *self.names], check=False)
            for line in r.stdout.splitlines():
                try:
                    name, cpu, mem = line.split(";")
                    self.rows.append({"t": t, "container": name,
                                      "cpu_pct": float(cpu.strip().rstrip("%") or 0),
                                      "mem_mb": self._mem_mb(mem)})
                except ValueError:
                    pass
            self._halt.wait(max(0.0, self.period - (time.time() - t)))

    def stop(self):
        self._halt.set()
        self.join(timeout=15)

    def peaks(self):
        out = {}
        for r in self.rows:
            d = out.setdefault(r["container"], {"cpu_pct_max": 0.0, "mem_mb_max": 0.0, "samples": 0})
            d["samples"] += 1
            d["cpu_pct_max"] = max(d["cpu_pct_max"], r["cpu_pct"])
            if r["mem_mb"] is not None:
                d["mem_mb_max"] = max(d["mem_mb_max"], r["mem_mb"])
        return out


# --------------------------------------------------------------------------- output
def percentile(values, p):
    """Nearest-rank percentile (no interpolation); honest for small samples."""
    if not values:
        return None
    v = sorted(values)
    import math
    k = max(1, math.ceil(p / 100 * len(v)))
    return v[k - 1]


def save_json(name, data):
    path = RESULTS / name
    path.write_text(json.dumps(data, indent=2, default=str), encoding="utf-8")
    log(f"saved {path.relative_to(REPO)}")
    return path


def save_csv(name, rows):
    import csv
    path = RESULTS / name
    if not rows:
        path.write_text("", encoding="utf-8")
        return path
    keys = list(dict.fromkeys(k for r in rows for k in r))
    with open(path, "w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=keys)
        w.writeheader()
        w.writerows(rows)
    log(f"saved {path.relative_to(REPO)}")
    return path
