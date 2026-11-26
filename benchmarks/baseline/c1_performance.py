"""CAND-1 baseline — Performance efficiency (capacity / time behaviour) of video processing.

Scenarios (ex6bloco2.md, section 5.1):
  warmup  one discarded run: an Apply with automatic subtitles (forces the Faster-Whisper
          model download into the whisper_models volume) plus one discarded preview.
  c1a     homogeneous concurrency, N in {1, 2, 4} concurrent Apply requests from N premium
          users on distinct projects (sample_10s_720p.mp4, brightness + contrast +
          saturation), 3 repetitions per N. Validates H-01.
  c1b     load isolation: user A applies automatic subtitles to speech_mandela_177s_1080p.webm;
          5 s later user B requests 3 sequential 3-second previews of sample_10s_720p.mp4,
          compared with 3 previews on an idle system. Validates H-02.

Usage (from the repository root, stack running):
  benchmarks/baseline/.venv/Scripts/python.exe benchmarks/baseline/c1_performance.py warmup
  benchmarks/baseline/.venv/Scripts/python.exe benchmarks/baseline/c1_performance.py c1a [--reps 3] [--levels 1,2,4]
  benchmarks/baseline/.venv/Scripts/python.exe benchmarks/baseline/c1_performance.py c1b [--reps 1]

Definitions (per video job):
  queue_wait_s   = worker start (video_tool log, VM clock) - Process.createdAt (MongoDB,
                   VM clock): time from publication to video_queue until the worker picks it.
  service_s      = worker "ok" log line - worker start (VM clock).
  e2e_s          = Socket.IO completion event (process-update / preview-ready) arrival -
                   moment the HTTP request was sent (host clock): what the user perceives.
  throughput     = N / (last completion - first submission) * 60, in videos/min.
"""
import argparse
import random
import statistics
import threading
import time

from common import (SAMPLES, Client, Events, StatsSampler, iso, log, mongo_projects,
                    parse_iso, percentile, queue, results_db, save_csv, save_json,
                    worker_containers, worker_events)

SHORT = SAMPLES / "sample_10s_720p.mp4"
SPEECH = SAMPLES / "speech_mandela_177s_1080p.webm"
SAMPLED = ["video_tool", "projects", "rabbitmq"]
JOB_TIMEOUT = 30 * 60


def effects_pipeline(client, pid):
    # random factors make every pipeline unique, so the preview cache never answers
    client.add_tool(pid, "brightness", {"brightness": round(random.uniform(1.05, 1.35), 4)})
    client.add_tool(pid, "contrast", {"contrastFactor": round(random.uniform(1.05, 1.35), 4)})
    client.add_tool(pid, "saturation", {"saturationFactor": round(random.uniform(1.05, 1.35), 4)})


def prepare(client, name, video, tools="effects"):
    pid = client.create_project(name)
    client.upload_video(pid, video)
    if tools == "effects":
        effects_pipeline(client, pid)
    elif tools == "subtitles":
        client.add_tool(pid, "subtitles", {})
    elif tools == "brightness":
        client.add_tool(pid, "brightness", {"brightness": round(random.uniform(1.05, 1.95), 4)})
    img = client.media_ids(pid)[0]
    return pid, img


def wait_idle(timeout=600):
    end = time.time() + timeout
    while time.time() < end:
        q = queue()
        if (q["messages"] or 0) == 0:
            return q
        time.sleep(2)
    raise RuntimeError(f"video_queue not idle: {queue()}")


class ProcessPoller(threading.Thread):
    """Records msg_id -> (project_id, createdAt) of Process documents of the given projects
    while they exist (they are deleted when the job finishes)."""

    def __init__(self, project_ids, period=0.5):
        super().__init__(daemon=True)
        self.ids = list(project_ids)
        self.period = period
        self.seen = {}
        self._halt = threading.Event()

    def run(self):
        arr = ",".join(f"ObjectId('{i}'), '{i}'" for i in self.ids)
        js = (f"return db.processes.find({{project_id: {{$in: [{arr}]}}}}).toArray().map(function(p){{"
              f"return {{msg_id: p.msg_id, project_id: (p.project_id.str || String(p.project_id)), img_id: (p.img_id.str || String(p.img_id)),"
              f" createdAt: p.createdAt}};}});")
        while not self._halt.is_set():
            try:
                for p in mongo_projects(js) or []:
                    self.seen.setdefault(p["msg_id"], p)
            except Exception as e:  # noqa: BLE001 - keep sampling
                log(f"poller: {e}")
            self._halt.wait(self.period)

    def stop(self):
        self._halt.set()
        self.join(timeout=10)


def job_metrics(msg, worker, t_send, t_done):
    w = worker.get(msg["msg_id"], {})
    created = parse_iso(msg["createdAt"]) if msg.get("createdAt") else None
    start = w.get("starts", [None])[0] if w.get("starts") else None
    ok = w.get("ok")
    return {
        "msg_id": msg["msg_id"],
        "project_id": msg.get("project_id"),
        "published_vm": created.isoformat() if created else None,
        "worker_start_vm": start.isoformat() if start else None,
        "worker_ok_vm": ok.isoformat() if ok else None,
        "worker_starts": len(w.get("starts", [])),
        "worker_containers": " ".join(w.get("containers", [])),
        "queue_wait_s": round((start - created).total_seconds(), 3) if start and created else None,
        "service_s": round((ok - start).total_seconds(), 3) if ok and start else None,
        "sent_host": iso(t_send),
        "done_host": iso(t_done) if t_done else None,
        "e2e_s": round(t_done - t_send, 3) if t_done else None,
    }


# --------------------------------------------------------------------------- warm-up
def warmup(_args):
    log("warm-up: subtitles Apply on sample_10s (downloads the Whisper model) + 1 preview")
    c = Client()
    ev = Events(c)
    try:
        wait_idle()
        pid, img = prepare(c, "warmup-subtitles", SHORT, "subtitles")
        t0, t1, st, body = c.process(pid)
        log(f"  POST /process -> {st}")
        e = ev.wait_for(lambda e: e["event"] in ("process-update", "process-error"), JOB_TIMEOUT, t0)
        pid2, img2 = prepare(c, "warmup-preview", SHORT, "effects")
        p0, _, pst, _ = c.preview(pid2, img2)
        pe = ev.wait_for(lambda e: e["event"] in ("preview-ready", "preview-error"), JOB_TIMEOUT, p0)
        out = {
            "discarded": True,
            "note": "Warm-up only: not part of the baseline. Includes the Whisper model download.",
            "subtitles_apply": {"status": st, "event": e and e["event"],
                                "seconds": round(e["t"] - t0, 3) if e else None},
            "preview": {"status": pst, "event": pe and pe["event"],
                        "seconds": round(pe["t"] - p0, 3) if pe else None},
            "results": results_db(pid),
        }
        save_json("c1_warmup.json", out)
        log(f"  warm-up subtitles {out['subtitles_apply']} preview {out['preview']}")
    finally:
        ev.close()


# --------------------------------------------------------------------------- C1-A
def run_c1a_level(n, rep):
    log(f"C1-A N={n} rep={rep}: preparing {n} users/projects")
    users = [Client() for _ in range(n)]
    listeners = [Events(u) for u in users]
    projects = [prepare(u, f"c1a-n{n}-r{rep}-u{i}", SHORT)[0] for i, u in enumerate(users)]
    wait_idle()
    since = iso(time.time() - 2)
    poller = ProcessPoller(projects)
    poller.start()
    stats = StatsSampler(SAMPLED)
    stats.start()
    time.sleep(2)  # idle samples before the load

    barrier = threading.Barrier(n)
    sends = [None] * n

    def fire(i):
        barrier.wait()
        t0, t1, st, body = users[i].process(projects[i])
        sends[i] = (t0, t1, st, body)

    threads = [threading.Thread(target=fire, args=(i,)) for i in range(n)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    log(f"  POST statuses {[s[2] for s in sends]}")

    dones = []
    for i, ev in enumerate(listeners):
        e = ev.wait_for(lambda e: e["event"] in ("process-update", "process-error"),
                        JOB_TIMEOUT, sends[i][0])
        dones.append(e)
    time.sleep(3)
    stats.stop()
    poller.stop()
    worker = worker_events(since)

    jobs = []
    for i, pid in enumerate(projects):
        msgs = [m for m in poller.seen.values() if m["project_id"] == pid]
        e = dones[i]
        if not msgs:
            jobs.append({"project_id": pid, "error": "Process document never observed"})
            continue
        m = job_metrics(msgs[0], worker, sends[i][0], e["t"] if e else None)
        m.update({"user": i, "http_status": sends[i][2], "completion_event": e and e["event"],
                  "result_rows": len(results_db(pid))})
        jobs.append(m)
        for ev in listeners:
            pass
    for ev in listeners:
        ev.close()

    done_t = [d["t"] for d in dones if d and d["event"] == "process-update"]
    first_send = min(s[0] for s in sends)
    ok = len(done_t)
    makespan = (max(done_t) - first_send) if done_t else None
    summary = {
        "scenario": "C1-A", "N": n, "rep": rep, "completed": ok,
        "makespan_s": round(makespan, 3) if makespan else None,
        "throughput_videos_per_min": round(ok / makespan * 60, 3) if makespan else None,
        "queue_wait_s_mean": _mean([j.get("queue_wait_s") for j in jobs]),
        "queue_wait_s_max": _max([j.get("queue_wait_s") for j in jobs]),
        "service_s_mean": _mean([j.get("service_s") for j in jobs]),
        "e2e_s_mean": _mean([j.get("e2e_s") for j in jobs]),
        "e2e_s_max": _max([j.get("e2e_s") for j in jobs]),
        "peaks": stats.peaks(),
    }
    return summary, jobs, stats.rows


def _vals(xs):
    return [x for x in xs if isinstance(x, (int, float))]


def _mean(xs):
    v = _vals(xs)
    return round(statistics.mean(v), 3) if v else None


def _max(xs):
    v = _vals(xs)
    return round(max(v), 3) if v else None


def c1a(args):
    levels = [int(x) for x in args.levels.split(",")]
    summaries, all_jobs, all_stats = [], [], []
    for rep in range(1, args.reps + 1):
        for n in levels:
            s, jobs, rows = run_c1a_level(n, rep)
            log(f"  -> {s['completed']}/{n} done, makespan {s['makespan_s']} s, "
                f"throughput {s['throughput_videos_per_min']} v/min, wait max {s['queue_wait_s_max']} s")
            summaries.append(s)
            all_jobs += [dict(j, N=n, rep=rep) for j in jobs]
            all_stats += [dict(r, N=n, rep=rep) for r in rows]
    agg = []
    for n in levels:
        ss = [s for s in summaries if s["N"] == n]
        agg.append({
            "N": n, "reps": len(ss),
            "throughput_mean": _mean([s["throughput_videos_per_min"] for s in ss]),
            "throughput_min": min(_vals([s["throughput_videos_per_min"] for s in ss]), default=None),
            "throughput_max": _max([s["throughput_videos_per_min"] for s in ss]),
            "makespan_mean_s": _mean([s["makespan_s"] for s in ss]),
            "queue_wait_mean_s": _mean([j.get("queue_wait_s") for j in all_jobs if j["N"] == n]),
            "queue_wait_max_s": _max([j.get("queue_wait_s") for j in all_jobs if j["N"] == n]),
            "service_mean_s": _mean([j.get("service_s") for j in all_jobs if j["N"] == n]),
            "e2e_mean_s": _mean([j.get("e2e_s") for j in all_jobs if j["N"] == n]),
            "e2e_p95_s": percentile(_vals([j.get("e2e_s") for j in all_jobs if j["N"] == n]), 95),
            "worker_cpu_pct_max_per_container": _max([v["cpu_pct_max"] for s in ss for k, v in s["peaks"].items() if k in worker_containers()]),
            "worker_mem_mb_max_per_container": _max([v["mem_mb_max"] for s in ss for k, v in s["peaks"].items() if k in worker_containers()]),
            "completed": sum(s["completed"] for s in ss), "submitted": n * len(ss),
        })
    save_json("c1a_summary.json", {"runs": summaries, "aggregate": agg})
    save_csv("c1a_jobs.csv", all_jobs)
    save_csv("c1a_docker_stats.csv", all_stats)
    for a in agg:
        log(f"C1-A N={a['N']}: {a}")


# --------------------------------------------------------------------------- C1-B
def previews(client, ev, targets, label, poller_ids):
    """Sequential previews; each target is (pid, img). Returns list of dicts."""
    out = []
    for k, (pid, img) in enumerate(targets, 1):
        idx = ev.mark()
        t0, t1, st, body = client.preview(pid, img)
        e = ev.wait_for(lambda e: e["event"] in ("preview-ready", "preview-error"), JOB_TIMEOUT,
                        after_index=idx)
        out.append({"phase": label, "k": k, "project_id": pid, "http_status": st,
                    "t_send": t0, "t_ready": e["t"] if e else None,
                    "sent_host": iso(t0), "event": e and e["event"],
                    "latency_s": round(e["t"] - t0, 3) if e else None})
        log(f"  {label} preview {k}: {out[-1]['latency_s']} s ({out[-1]['event']})")
    return out


def c1b(args):
    runs = []
    for rep in range(1, args.reps + 1):
        log(f"C1-B rep={rep}: preparing users A (subtitles) and B (previews)")
        a, b = Client(), Client()
        eva, evb = Events(a), Events(b)
        pid_a, _ = prepare(a, f"c1b-r{rep}-subtitles", SPEECH, "subtitles")
        warm_target = [prepare(b, f"c1b-r{rep}-warm", SHORT, "brightness")]
        idle_targets = [prepare(b, f"c1b-r{rep}-idle-{k}", SHORT, "brightness") for k in range(3)]
        load_targets = [prepare(b, f"c1b-r{rep}-load-{k}", SHORT, "brightness") for k in range(3)]
        all_ids = [pid_a] + [p for p, _ in warm_target + idle_targets + load_targets]
        wait_idle()
        since = iso(time.time() - 2)
        poller = ProcessPoller(all_ids)
        poller.start()
        stats = StatsSampler(SAMPLED)
        stats.start()

        warm = previews(b, evb, warm_target, "warmup_discarded", all_ids)
        idle = previews(b, evb, idle_targets, "idle", all_ids)
        wait_idle()
        log("  user A: Apply with subtitles on the 177 s speech video")
        ta0, _, sta, body = a.process(pid_a)
        log(f"  POST /process -> {sta} {body[:80]}")
        time.sleep(max(0.0, 5 - (time.time() - ta0)))
        loaded = previews(b, evb, load_targets, "under_subtitles", all_ids)
        ea = eva.wait_for(lambda e: e["event"] in ("process-update", "process-error"), JOB_TIMEOUT, ta0)
        time.sleep(3)
        stats.stop()
        poller.stop()
        worker = worker_events(since)
        eva.close()
        evb.close()

        by_pid = {}
        for m in poller.seen.values():
            by_pid.setdefault(m["project_id"], []).append(m)
        t_subs_done = ea["t"] if ea else float("inf")
        for r in loaded:
            # sequential previews: only those sent before the subtitles job ended overlap it
            r["overlapped_subtitles"] = r["t_send"] < t_subs_done
        for rowset in (warm, idle, loaded):
            for r in rowset:
                msgs = by_pid.get(r["project_id"], [])
                if msgs:
                    w = job_metrics(msgs[0], worker, 0, None)
                    r.update({k: w[k] for k in ("msg_id", "queue_wait_s", "service_s", "worker_starts")})
        subs_msgs = by_pid.get(pid_a, [])
        subs = job_metrics(subs_msgs[0], worker, ta0, ea["t"] if ea else None) if subs_msgs else {}
        subs.update({"http_status": sta, "completion_event": ea and ea["event"],
                     "result_rows": len(results_db(pid_a))})

        il = _vals([r["latency_s"] for r in idle])
        ll = _vals([r["latency_s"] for r in loaded])
        ol = _vals([r["latency_s"] for r in loaded if r.get("overlapped_subtitles")])
        run = {
            "scenario": "C1-B", "rep": rep,
            "idle_latency_s": il, "loaded_latency_s": ll,
            "idle_p50_s": percentile(il, 50), "idle_p95_s": percentile(il, 95),
            "loaded_p50_s": percentile(ll, 50), "loaded_p95_s": percentile(ll, 95),
            "ratio_p50_loaded_over_idle": round(percentile(ll, 50) / percentile(il, 50), 2) if il and ll else None,
            "overlapped_latency_s": ol,
            "ratio_overlapped_max_over_idle_p50": round(max(ol) / percentile(il, 50), 1) if il and ol else None,
            "subtitles_job": subs, "previews": warm + idle + loaded, "peaks": stats.peaks(),
        }
        log(f"  idle p50 {run['idle_p50_s']} s, under subtitles p50 {run['loaded_p50_s']} s, "
            f"ratio {run['ratio_p50_loaded_over_idle']}, subtitles e2e {subs.get('e2e_s')} s")
        runs.append(run)
        save_csv(f"c1b_docker_stats_r{rep}.csv", stats.rows)
    il_all = [x for r in runs for x in r["idle_latency_s"]]
    ol_all = [x for r in runs for x in r["overlapped_latency_s"]]
    agg = {"idle_n": len(il_all), "idle_p50_s": percentile(il_all, 50), "idle_p95_s": percentile(il_all, 95),
           "overlapped_n": len(ol_all), "overlapped_p50_s": percentile(ol_all, 50),
           "overlapped_p95_s": percentile(ol_all, 95),
           "subtitles_e2e_s": [r["subtitles_job"].get("e2e_s") for r in runs]}
    log(f"C1-B aggregate: {agg}")
    save_json("c1b_summary.json", {"aggregate": agg, "runs": runs})
    save_csv("c1b_previews.csv", [dict(p, rep=r["rep"]) for r in runs for p in r["previews"]])


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("scenario", choices=["warmup", "c1a", "c1b"])
    ap.add_argument("--reps", type=int, default=None)
    ap.add_argument("--levels", default="1,2,4")
    args = ap.parse_args()
    if args.scenario == "warmup":
        warmup(args)
    elif args.scenario == "c1a":
        args.reps = args.reps or 3
        c1a(args)
    else:
        args.reps = args.reps or 1
        c1b(args)


if __name__ == "__main__":
    main()
