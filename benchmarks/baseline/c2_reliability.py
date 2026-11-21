"""CAND-2 baseline — Reliability (fault tolerance / recoverability) of the asynchronous chain.

Fault-injection scenarios (ex6bloco2.md, section 5.1). Every fault is injected with the
docker CLI or the RabbitMQ management API; the application code is unchanged.

  c2a  broker restart (H-06): stop video_tool, submit 4 video Apply requests, restart
       rabbitmq, start video_tool again and count lost jobs.
  c2b  worker death (H-05): `docker kill` video_tool at >= 50 % progress (3 repetitions);
       redelivery, recovery time, MongoDB state and ffprobe integrity of out/.
  c2c  blocked worker (H-10): `docker pause` video_tool at >= 50 % progress and watch, for
       120 s, whether the broker ever takes the unacked message back (heartbeat=0).
  c2d  (1) img_storage stopped while the worker result is being handled on project_queue
       (H-07): is the run left pending / is the reply retried?
       (2) fatal errors (H-05): an invalid trim reaching the worker through the public API,
       a message with a missing input file and a malformed message injected in video_queue:
       number of attempts, worker restarts and presence of a dead-letter queue.

Usage (repository root, stack running, after c1_performance.py warmup):
  benchmarks/baseline/.venv/Scripts/python.exe benchmarks/baseline/c2_reliability.py c2a|c2b|c2c|c2d|all
"""
import argparse
import json
import time
import uuid

import requests

from common import (RABBIT_API, RABBIT_AUTH, SAMPLES, Client, Events, compose, container,
                    iso, log, mongo_projects, parse_iso, pid_match, project_tokens, queue, results_db,
                    save_json, sh, utcnow, wait_rabbit, worker_events)
from c1_performance import JOB_TIMEOUT, prepare, wait_idle

SHORT = SAMPLES / "sample_10s_720p.mp4"
DONE = ("process-update", "process-error")


# --------------------------------------------------------------------------- helpers
def state(svc):
    r = sh(["docker", "inspect", "-f",
            "{{.State.Status}}|{{.State.Running}}|{{.State.Paused}}|{{.RestartCount}}|{{.State.ExitCode}}|{{.State.StartedAt}}",
            container(svc)], check=False)
    parts = r.stdout.strip().split("|")
    if len(parts) < 6:
        return {"status": "missing"}
    return {"status": parts[0], "running": parts[1] == "true", "paused": parts[2] == "true",
            "restart_count": int(parts[3]), "exit_code": int(parts[4]), "started_at": parts[5]}


def project_state(pid):
    procs = mongo_projects(f"return db.processes.count({{project_id: {pid_match(pid)}}});")
    return {"pending_process_docs": procs, "result_rows": results_db(pid),
            "tokens": project_tokens(pid)}


def out_integrity(user_id, pid):
    """List the project's out/ directory on the shared volume and ffprobe every file."""
    base = f"/app/images/users/{user_id}/projects/{pid}"
    ls = sh(["docker", "exec", container("projects"), "sh", "-c",
             f"find {base} -type f 2>/dev/null | sort"], check=False).stdout.split()
    files = []
    for f in ls:
        probe = sh(["docker", "exec", container("projects"), "ffprobe", "-v", "error",
                    "-show_entries", "format=duration,size:stream=codec_name",
                    "-of", "json", f], check=False)
        files.append({"path": f.replace(base, "<project>"), "ffprobe_ok": probe.returncode == 0,
                      "probe": (json.loads(probe.stdout) if probe.returncode == 0 and probe.stdout.strip() else probe.stderr.strip()[:200])})
    partial = [f["path"] for f in files if ".part" in f["path"]]
    return {"files": files, "partial_files": partial}


def wait_progress(ev, since, pct, timeout=600):
    return ev.wait_for(lambda e: e["event"] == "video-progress"
                       and not (e["data"] or {}).get("preview")
                       and (e["data"] or {}).get("percent", 0) >= pct, timeout, since)


def ensure_running(svc, timeout=120):
    s = state(svc)
    if not s.get("running") or s.get("paused"):
        if s.get("paused"):
            sh(["docker", "unpause", container(svc)], check=False)
        else:
            compose("start", svc)
    end = time.time() + timeout
    while time.time() < end:
        s = state(svc)
        if s.get("running") and not s.get("paused"):
            return s
        time.sleep(1)
    return s


def queue_when(pred, name="video_queue", timeout=30):
    """The management API refreshes queue statistics every ~5 s: poll until pred(q) holds
    (or the timeout ends) and return the last reading."""
    end = time.time() + timeout
    q = None
    while True:
        try:
            q = queue(name)
            if pred(q):
                return q
        except Exception:  # noqa: BLE001
            pass
        if time.time() > end:
            return q
        time.sleep(1)


def consumers(qname):
    try:
        return queue(qname)["consumers"]
    except Exception:  # noqa: BLE001
        return None


def health_snapshot():
    svcs = ["projects", "ws_gateway", "video_tool", "img_storage", "rabbitmq"]
    return {"containers": {s: state(s) for s in svcs},
            "consumers": {q: consumers(q) for q in ("project_queue", "video_queue", "ws_queue")}}


def heal(label):
    """After a scenario, make sure the consumers are back. Records anything that had to be
    restarted by hand (that itself is a measured outcome: no automatic recovery)."""
    actions = []
    for svc in ("rabbitmq", "img_storage", "video_tool", "projects", "ws_gateway"):
        s = state(svc)
        if not s.get("running") or s.get("paused"):
            ensure_running(svc)
            actions.append(f"started {svc}")
    wait_rabbit()
    time.sleep(5)
    for q, svc in (("project_queue", "projects"), ("ws_queue", "ws_gateway"), ("video_queue", "video_tool")):
        if not consumers(q):
            compose("restart", svc)
            actions.append(f"restarted {svc} (0 consumers on {q})")
            time.sleep(10)
    if actions:
        log(f"  heal after {label}: {actions}")
    return actions


# --------------------------------------------------------------------------- C2-A
def c2a(_args):
    log("C2-A broker restart with 4 jobs waiting in video_queue")
    heal("pre-c2a")
    wait_idle()
    users = [Client() for _ in range(4)]
    evs = [Events(u) for u in users]
    pids = [prepare(u, f"c2a-u{i}", SHORT)[0] for i, u in enumerate(users)]
    compose("stop", "video_tool")
    t_sub = []
    for u, pid in zip(users, pids):
        t0, _, st, _ = u.process(pid)
        t_sub.append((t0, st))
    q_before = queue_when(lambda q: (q["messages_ready"] or 0) >= len(pids) and q["consumers"] == 0)
    before = {pid: project_state(pid) for pid in pids}
    log(f"  queue before restart: {q_before}")
    t_restart = time.time()
    compose("restart", "rabbitmq", timeout=300)
    wait_rabbit()
    time.sleep(15)  # let the statistics of the restarted broker settle
    q_after = queue()
    health_after_restart = health_snapshot()
    log(f"  queue after restart: {q_after}")
    compose("start", "video_tool")
    t_vt = time.time()
    deadline = t_vt + 180
    dones = [ev.wait_for(lambda e: e["event"] in DONE, max(0, deadline - time.time()), t_sub[i][0])
             for i, ev in enumerate(evs)]
    completed = sum(1 for d in dones if d and d["event"] == "process-update")
    after = {pid: project_state(pid) for pid in pids}
    for ev in evs:
        ev.close()
    heal_actions = heal("c2a")
    out = {
        "scenario": "C2-A", "submitted": len(pids), "http_status": [s for _, s in t_sub],
        "queue_before_restart": q_before, "queue_after_restart": q_after,
        "completed_within_180s": completed, "lost": len(pids) - completed,
        "loss_pct": round(100 * (len(pids) - completed) / len(pids), 1),
        "events": [d and d["event"] for d in dones],
        "project_state_before": before, "project_state_after": after,
        "stuck_runs": sum(1 for s in after.values() if s["pending_process_docs"]),
        "health_after_restart": health_after_restart,
        "manual_recovery_actions": heal_actions,
        "restart_at": iso(t_restart),
    }
    log(f"  -> lost {out['lost']}/4 ({out['loss_pct']} %), stuck runs {out['stuck_runs']}, heal {heal_actions}")
    save_json("c2a_broker_restart.json", out)
    return out


# --------------------------------------------------------------------------- C2-B
def c2b(args):
    reps = []
    for rep in range(1, args.reps + 1):
        log(f"C2-B worker kill rep={rep}")
        heal(f"pre-c2b-{rep}")
        wait_idle()
        u = Client()
        ev = Events(u)
        pid, _ = prepare(u, f"c2b-r{rep}", SHORT)
        since = iso(time.time() - 2)
        t0, _, st, _ = u.process(pid)
        p = wait_progress(ev, t0, 50)
        if not p:
            reps.append({"rep": rep, "error": "50 % progress never reached"})
            ev.close()
            continue
        pct = p["data"]["percent"]
        rc_before = state("video_tool")["restart_count"]
        t_kill = time.time()
        sh(["docker", "kill", container("video_tool")])
        log(f"  killed video_tool at {pct} %")
        q_after_kill = None
        auto_restart_s = None
        for _ in range(60):
            time.sleep(0.5)
            if q_after_kill is None:
                try:
                    q_after_kill = queue()
                except Exception:  # noqa: BLE001
                    pass
            s = state("video_tool")
            if s.get("running"):
                auto_restart_s = round(time.time() - t_kill, 2)
                break
        manual_start = None
        if auto_restart_s is None:
            manual_start = iso()
            log("  video_tool did not restart by itself in 30 s: starting it by hand")
            ensure_running("video_tool")
        d = ev.wait_for(lambda e: e["event"] in DONE, JOB_TIMEOUT, t_kill)
        time.sleep(3)
        worker = worker_events(since)
        msg = next((m for m, w in worker.items() if m.startswith("request-")), None)
        starts = worker.get(msg, {}).get("starts", []) if msg else []
        rec = {
            "rep": rep, "http_status": st, "killed_at_percent": pct, "kill_at": iso(t_kill),
            "restart_count_before": rc_before, "restart_count_after": state("video_tool")["restart_count"],
            "auto_restart_after_s": auto_restart_s, "manual_start_at": manual_start,
            "queue_right_after_kill": q_after_kill,
            "msg_id": msg, "worker_starts": len(starts),
            "redelivered": len(starts) >= 2,
            "completion_event": d and d["event"],
            "recovery_total_s": round(d["t"] - t_kill, 3) if d else None,
            "first_attempt_to_kill_s": round(t_kill - t0, 3),
            "state": project_state(pid), "integrity": out_integrity(u.user_id, pid),
        }
        if len(starts) >= 2:
            rec["redelivery_start_vm"] = starts[1].isoformat()
        log(f"  -> redelivered={rec['redelivered']} completion={rec['completion_event']} "
            f"recovery {rec['recovery_total_s']} s, auto restart {auto_restart_s} s, "
            f"partial files {rec['integrity']['partial_files']}")
        reps.append(rec)
        ev.close()
    heal("c2b")
    out = {"scenario": "C2-B", "reps": reps}
    save_json("c2b_worker_kill.json", out)
    return out


# --------------------------------------------------------------------------- C2-C
def c2c(args):
    log("C2-C worker paused for 120 s")
    heal("pre-c2c")
    wait_idle()
    u = Client()
    ev = Events(u)
    pid, _ = prepare(u, "c2c", SHORT)
    since = iso(time.time() - 2)
    t0, _, st, _ = u.process(pid)
    p = wait_progress(ev, t0, 50)
    pct = p["data"]["percent"] if p else None
    t_pause = time.time()
    sh(["docker", "pause", container("video_tool")])
    log(f"  paused at {pct} %")
    samples = []
    taken_back_s = None
    while time.time() - t_pause < args.pause_window:
        q = queue()
        samples.append({"t_s": round(time.time() - t_pause, 1), **{k: q[k] for k in (
            "messages_ready", "messages_unacknowledged", "consumers")}})
        if taken_back_s is None and (q["messages_ready"] or 0) > 0:
            taken_back_s = samples[-1]["t_s"]
        time.sleep(5)
    events_during = [e["event"] for e in ev.snapshot() if t_pause <= e["t"] < time.time()]
    t_unpause = time.time()
    sh(["docker", "unpause", container("video_tool")])
    d = ev.wait_for(lambda e: e["event"] in DONE, JOB_TIMEOUT, t_unpause)
    time.sleep(3)
    worker = worker_events(since)
    msg = next((m for m in worker if m.startswith("request-")), None)
    out = {
        "scenario": "C2-C", "http_status": st, "paused_at_percent": pct,
        "pause_window_s": args.pause_window, "queue_samples": samples,
        "broker_took_message_back_after_s": taken_back_s,
        "unacked_whole_window": all((s["messages_unacknowledged"] or 0) >= 1 for s in samples),
        "user_events_during_pause": sorted(set(events_during)),
        "completion_event_after_unpause": d and d["event"],
        "completion_after_unpause_s": round(d["t"] - t_unpause, 3) if d else None,
        "worker_starts": len(worker.get(msg, {}).get("starts", [])) if msg else None,
        "state": project_state(pid),
    }
    ev.close()
    heal("c2c")
    log(f"  -> taken back after {taken_back_s} s; unacked whole window {out['unacked_whole_window']}; "
        f"after unpause {out['completion_event_after_unpause']} in {out['completion_after_unpause_s']} s")
    save_json("c2c_worker_pause.json", out)
    return out


# --------------------------------------------------------------------------- C2-D
def publish_video_queue(body):
    r = requests.post(f"{RABBIT_API}/exchanges/%2F/picturas/publish", auth=RABBIT_AUTH, json={
        "properties": {}, "routing_key": "video_queue",
        "payload": json.dumps(body), "payload_encoding": "string"}, timeout=10)
    r.raise_for_status()
    return r.json()


def c2d(args):
    out = {"scenario": "C2-D"}
    # ---- (1) img_storage unavailable while projects handles the worker reply
    log("C2-D(1) img_storage stopped during the reply on project_queue")
    heal("pre-c2d1")
    wait_idle()
    u = Client()
    ev = Events(u)
    pid, _ = prepare(u, "c2d-storage", SHORT)
    since = iso(time.time() - 2)
    t0, _, st, _ = u.process(pid)
    p = wait_progress(ev, t0, 50)
    compose("stop", "img_storage")
    t_stop = time.time()
    log(f"  img_storage stopped at {p and p['data']['percent']} %")
    d = ev.wait_for(lambda e: e["event"] in DONE, 600, t0)
    pq_after = queue("project_queue")
    during = project_state(pid)
    time.sleep(args.storage_down)
    compose("start", "img_storage")
    t_start = time.time()
    time.sleep(60)  # does anything retry once the dependency is back?
    later = project_state(pid)
    worker = worker_events(since)
    msg = next((m for m in worker if m.startswith("request-")), None)
    errors = [e for e in ev.snapshot() if e["event"] == "process-error" and e["t"] >= t0]
    # can the user simply apply again?
    t2, _, st2, _ = u.process(pid)
    d2 = ev.wait_for(lambda e: e["event"] in DONE, JOB_TIMEOUT, t2)
    out["storage_failure"] = {
        "http_status": st, "storage_down_s": round(t_start - t_stop, 1),
        "first_event": d and d["event"], "first_event_data": d and d["data"],
        "worker_finished_ok": bool(worker.get(msg, {}).get("ok")) if msg else None,
        "worker_starts": len(worker.get(msg, {}).get("starts", [])) if msg else None,
        "project_queue_after": pq_after,
        "state_while_storage_down": during, "state_60s_after_storage_back": later,
        "process_error_events": len(errors),
        "retried_automatically": len(worker.get(msg, {}).get("starts", [])) > 1 if msg else None,
        "reapply_status": st2, "reapply_event": d2 and d2["event"],
    }
    ev.close()
    log(f"  -> {out['storage_failure']['first_event']} / pending docs "
        f"{later['pending_process_docs']} / results {len(later['result_rows'])} / reapply {out['storage_failure']['reapply_event']}")

    # ---- (2a) deterministic worker error through the public API (invalid trim)
    log("C2-D(2a) invalid trim (start beyond the end of the video) through the API")
    heal("pre-c2d2")
    wait_idle()
    u = Client()
    ev = Events(u)
    pid = u.create_project("c2d-invalid-trim")
    u.upload_video(pid, SHORT)
    img = u.media_ids(pid)[0]
    u.add_tool(pid, "trim", {"start": 50, "end": 60, "imgId": img})
    since = iso(time.time() - 2)
    t0, _, st, body = u.process(pid)
    d = ev.wait_for(lambda e: e["event"] in DONE, 300, t0)
    time.sleep(15)
    worker = worker_events(since)
    msg = next((m for m in worker if m.startswith("request-")), None)
    out["invalid_trim"] = {
        "http_status": st, "http_body": body[:200], "event": d and d["event"],
        "event_data": d and d["data"], "seconds": round(d["t"] - t0, 3) if d else None,
        "worker_attempts": len(worker.get(msg, {}).get("starts", [])) if msg else None,
        "state": project_state(pid),
    }
    ev.close()
    log(f"  -> {out['invalid_trim']['event']} attempts {out['invalid_trim']['worker_attempts']}")

    # ---- (2b) missing input file (error inside processing, handled by the worker)
    log("C2-D(2b) message with a missing input file injected in video_queue")
    wait_idle()
    since = iso(time.time() - 2)
    mid = f"request-bench-missing-{uuid.uuid4()}"
    publish_video_queue({"messageId": mid, "timestamp": iso(), "procedure": "video",
                         "parameters": {"inputImageURI": "/app/images/bench/does-not-exist.mp4",
                                        "outputImageURI": "/app/images/bench/out.mp4",
                                        "tools": [{"procedure": "brightness", "params": {"brightness": 1.2}}],
                                        "preview": False}})
    time.sleep(20)
    w = worker_events(since).get(mid, {})
    out["missing_input"] = {"msg_id": mid, "worker_attempts": len(w.get("starts", [])),
                            "queue_after_20s": queue()}

    # ---- (2c) malformed message that crashes the worker (poison pill)
    log("C2-D(2c) malformed message (tools is not a list) injected in video_queue — watching 90 s")
    wait_idle()
    since_dt = utcnow()
    rc0 = state("video_tool")["restart_count"]
    mid = f"request-bench-poison-{uuid.uuid4()}"
    publish_video_queue({"messageId": mid, "timestamp": iso(), "procedure": "video",
                         "parameters": {"inputImageURI": "x", "outputImageURI": "y", "tools": "not-a-list"}})
    samples = []
    t_pub = time.time()
    while time.time() - t_pub < args.poison_window:
        s = state("video_tool")
        try:
            q = queue()
        except Exception:  # noqa: BLE001
            q = {}
        samples.append({"t_s": round(time.time() - t_pub, 1), "restart_count": s.get("restart_count"),
                        "status": s.get("status"), "messages": q.get("messages"),
                        "unacked": q.get("messages_unacknowledged")})
        time.sleep(5)
    logs = sh(["docker", "logs", "--since", since_dt.isoformat(), container("video_tool")], check=False)
    tracebacks = (logs.stdout + logs.stderr).count("Traceback")
    q_end = queue()
    out["poison_pill"] = {
        "msg_id": mid, "window_s": args.poison_window,
        "worker_restarts_in_window": samples[-1]["restart_count"] - rc0 if samples else None,
        "tracebacks_in_window": tracebacks, "queue_at_end": q_end,
        "message_still_in_queue": (q_end["messages"] or 0) > 0, "samples": samples,
    }
    log(f"  -> worker restarts {out['poison_pill']['worker_restarts_in_window']}, "
        f"tracebacks {tracebacks}, still queued {out['poison_pill']['message_still_in_queue']}")
    # clean-up: remove the poison message so the stack is usable again
    requests.delete(f"{RABBIT_API}/queues/%2F/video_queue/contents", auth=RABBIT_AUTH, timeout=10)
    out["poison_pill"]["cleanup"] = "video_queue purged through the management API"

    # ---- dead-letter configuration
    qs = requests.get(f"{RABBIT_API}/queues/%2F", auth=RABBIT_AUTH, timeout=10).json()
    out["dead_letter"] = {
        "queues_with_dlx": [q["name"] for q in qs if "x-dead-letter-exchange" in (q.get("arguments") or {})],
        "queues_named_dead_or_dlq": [q["name"] for q in qs if "dead" in q["name"] or "dlq" in q["name"]],
        "video_queue_arguments": next((q.get("arguments") for q in qs if q["name"] == "video_queue"), None),
        "policies": requests.get(f"{RABBIT_API}/policies", auth=RABBIT_AUTH, timeout=10).json(),
    }
    out["heal"] = heal("c2d")
    save_json("c2d_failures.json", out)
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("scenario", choices=["c2a", "c2b", "c2c", "c2d", "all"])
    ap.add_argument("--reps", type=int, default=3, help="C2-B repetitions")
    ap.add_argument("--pause-window", type=int, default=120)
    ap.add_argument("--storage-down", type=int, default=30)
    ap.add_argument("--poison-window", type=int, default=90)
    args = ap.parse_args()
    fns = {"c2a": c2a, "c2b": c2b, "c2c": c2c, "c2d": c2d}
    for name in (fns if args.scenario == "all" else [args.scenario]):
        fns[name](args)


if __name__ == "__main__":
    main()
