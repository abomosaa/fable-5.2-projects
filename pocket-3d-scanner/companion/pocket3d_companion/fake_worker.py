"""TEST-ONLY stand-in for the reconstruction pipeline worker. It reconstructs NOTHING.

This module exists so that the companion's HTTP server, job queue and worker supervision can
be tested quickly and deterministically without COLMAP/OpenMVS. It follows the server ⇄ worker
contract (docs/companion-protocol.md §4) but its "artifacts" are placeholder bytes, not a 3D
model.

It is never used by the companion on its own: the default worker command is
``python -m pocket3d_companion.pipeline``. The only way to run this module is to point the
worker command at it explicitly (``POCKET3D_WORKER_CMD`` / ``Config.worker_cmd``), which the
test-suite does. It additionally refuses to start unless ``POCKET3D_ALLOW_FAKE_WORKER=1`` is
set, and it labels everything it emits (``diagnostics.fake_worker = true``, log lines), so its
output can never be mistaken for a real reconstruction.

Behaviour is selected by ``job.settings["_test"]`` (all keys optional)::

    {"mode": "succeed",      # stages + sparse_preview.json mid-way + final artifacts + result.json
             "fail",         # diagnosed failure: `error` event, exit 2
             "crash",        # exit 1, no result.json
             "no_result",    # exit 0 WITHOUT out/result.json          (server must say `failed`)
             "bad_sha",      # exit 0, result.json lists a wrong SHA-256 (server must say `failed`)
             "sleep",        # emit one stage, then sleep `seconds` (cancel / interrupt tests)
             "memory",       # allocate `mb` MiB, then sleep `seconds` (memory watchdog test)
     "seconds": 30,          # for sleep / memory
     "mb": 200,              # for memory
     "step_delay": 0.0,      # pause between stages in the other modes
     "ignore_sigterm": false,# do not exit on SIGTERM (SIGKILL escalation test)
     "spawn_child": false,   # start a child process in the same process group (group-kill test)
     "partial_line": false,  # write one event in two halves with a pause in between
     "succeed_from_attempt": 0}   # if > job.attempt: behave as mode "fail" (retry test)

It records its pid in ``work/worker.pid`` (and ``work/child.pid``), and appends the attempt
number to ``work/attempts.log`` so tests can check that ``work/`` survives a retry.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import signal
import subprocess
import sys
import time
from pathlib import Path

STAGES = ["ingest", "features", "matching", "sfm", "undistort", "dense", "mesh", "texture", "package"]
ALLOW_ENV = "POCKET3D_ALLOW_FAKE_WORKER"


class _Events:
    def __init__(self, job_dir: Path):
        self.path = job_dir / "events.jsonl"
        self.seq = 0

    def _line(self, type_: str, stage: str | None = None, progress: float = 0.0, overall: float = 0.0,
              message: str = "", data: dict | None = None) -> bytes:
        self.seq += 1
        ev = {"seq": self.seq, "t": round(time.time(), 3), "type": type_, "stage": stage,
              "progress": progress, "overall": overall, "message": message}
        if data is not None:
            ev["data"] = data
        return (json.dumps(ev, separators=(",", ":")) + "\n").encode()

    def _append(self, raw: bytes) -> None:
        fd = os.open(self.path, os.O_WRONLY | os.O_APPEND | os.O_CREAT, 0o600)
        try:
            os.write(fd, raw)
        finally:
            os.close(fd)

    def emit(self, type_: str, stage: str | None = None, progress: float = 0.0, overall: float = 0.0,
             message: str = "", data: dict | None = None) -> None:
        self._append(self._line(type_, stage, progress, overall, message, data))

    def emit_in_two_halves(self, pause: float, *args, **kwargs) -> None:
        raw = self._line(*args, **kwargs)
        half = len(raw) // 2
        self._append(raw[:half])
        time.sleep(pause)
        self._append(raw[half:])


def _write_artifact(out: Path, name: str, payload: bytes, kind: str) -> dict:
    tmp = out / f".{name}.tmp"
    tmp.write_bytes(payload)
    os.replace(tmp, out / name)
    return {"name": name, "size": len(payload), "sha256": hashlib.sha256(payload).hexdigest(), "kind": kind}


def _write_result(out: Path, artifacts: list[dict], diagnostics: dict) -> None:
    tmp = out / ".result.json.tmp"
    tmp.write_text(json.dumps({"ok": True, "artifacts": artifacts, "diagnostics": diagnostics}))
    os.replace(tmp, out / "result.json")


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="TEST-ONLY fake pipeline worker (reconstructs nothing)")
    ap.add_argument("--job-dir", required=True)
    args = ap.parse_args(argv)
    if os.environ.get(ALLOW_ENV) != "1":
        print(f"fake_worker is a test stand-in and refuses to run without {ALLOW_ENV}=1", flush=True)
        return 4

    job_dir = Path(args.job_dir)
    job = json.loads((job_dir / "job.json").read_text())
    opts = job.get("settings", {}).get("_test") or {}
    mode = opts.get("mode", "succeed")
    seconds = float(opts.get("seconds", 30))
    step_delay = float(opts.get("step_delay", 0.0))
    work, out = job_dir / "work", job_dir / "out"
    work.mkdir(exist_ok=True)
    out.mkdir(exist_ok=True)

    child: subprocess.Popen | None = None

    def on_term(signum, frame):  # contract: terminate own children, exit 130
        if child is not None:
            child.kill()
        os._exit(130)

    signal.signal(signal.SIGTERM, signal.SIG_IGN if opts.get("ignore_sigterm") else on_term)

    print(f"FAKE WORKER (test stand-in, no reconstruction): job {job['job_id']} attempt {job['attempt']} "
          f"mode {mode}", flush=True)
    (work / "worker.pid").write_text(str(os.getpid()))
    with open(work / "attempts.log", "a") as f:
        f.write(f"{job['attempt']}\n")
    if opts.get("spawn_child"):
        # Same session/process group as this worker, so the server's group kill must reach it.
        child = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(600)"])
        (work / "child.pid").write_text(str(child.pid))

    ev = _Events(job_dir)
    env_limits = {"threads_env": os.environ.get("POCKET3D_JOB_THREADS"),
                  "memory_env": os.environ.get("POCKET3D_JOB_MEMORY_MB"),
                  "omp_env": os.environ.get("OMP_NUM_THREADS")}
    ev.emit("diagnostics", data={"fake_worker": True, "input_images": len(job.get("files", [])),
                                 "limits": job.get("limits"), "cwd": os.getcwd(), **env_limits})

    if int(opts.get("succeed_from_attempt", 0)) > int(job["attempt"]):
        mode = "fail"

    if mode == "sleep" or mode == "memory":
        ev.emit("stage_start", "ingest", 0.0, 0.0, "Reading photos", {"index": 0, "count": len(STAGES)})
        ballast = None
        if mode == "memory":
            ballast = bytearray(int(opts.get("mb", 200)) * 1024 * 1024)
            for i in range(0, len(ballast), 4096):     # touch every page so it counts as resident
                ballast[i] = 1
        ev.emit("stage_progress", "ingest", 0.5, 0.02, "Waiting (test)")
        deadline = time.monotonic() + seconds
        while time.monotonic() < deadline:
            time.sleep(0.05)
        del ballast
        return 1      # a sleeping worker that is never stopped counts as a crash

    n = len(STAGES)
    artifacts: list[dict] = []
    for i, stage in enumerate(STAGES):
        checkpoint = work / f"{stage}.done"
        reused = checkpoint.exists()
        ev.emit("stage_start", stage, 0.0, round(i / n, 4), f"{stage} started", {"index": i, "count": n})
        if step_delay and not reused:
            time.sleep(step_delay)
        if opts.get("partial_line") and stage == "features":
            ev.emit_in_two_halves(0.6, "stage_progress", stage, 0.5, round((i + 0.5) / n, 4), "half way")
        else:
            ev.emit("stage_progress", stage, 0.5, round((i + 0.5) / n, 4), f"{stage} 1/2")
        if stage == "sfm":
            if mode == "fail":
                ev.emit("error", stage, 0.5, round((i + 0.5) / n, 4), "Only 2 of 12 photos could be registered.",
                        {"code": "insufficient_registration",
                         "message": "Only 2 of 12 photos could be registered.",
                         "guidance": ["Take more photos with more overlap."]})
                return 2
            if mode == "crash":
                print("simulated crash", flush=True)
                return 1
            preview = _write_artifact(out, "sparse_preview.json", b'{"fake":true,"points":[]}', "preview")
            ev.emit("artifact", stage, 0.9, round((i + 0.9) / n, 4), "sparse_preview.json", preview)
            ev.emit("diagnostics", stage, 0.9, round((i + 0.9) / n, 4), "", {"registered_images": 3})
            artifacts.append(preview)
        checkpoint.write_text("done")
        ev.emit("stage_end", stage, 1.0, round((i + 1) / n, 4), f"{stage} done", {"reused": reused})

    payload = b"FAKE-GLB-NOT-A-MODEL " * 64      # deterministic placeholder bytes
    for name, data, kind in (("model.glb", payload, "model"),
                             ("cameras.json", b'{"fake":true,"cameras":[]}', "cameras"),
                             ("diagnostics.json", b'{"fake_worker":true}', "diagnostics")):
        meta = _write_artifact(out, name, data, kind)
        ev.emit("artifact", "package", 1.0, 1.0, name, meta)
        artifacts.append(meta)

    if mode == "no_result":
        return 0
    if mode == "bad_sha":
        broken = [dict(a) for a in artifacts]
        broken[1]["sha256"] = "0" * 64
        _write_result(out, broken, {"fake_worker": True})
        return 0
    # Like the real pipeline, report per-stage memory under the name the server also uses.
    per_stage = {"ingest": 12.5, "overall": 12.5}
    ev.emit("diagnostics", "package", 1.0, 1.0, "", {"peak_rss_mb": per_stage})
    _write_result(out, artifacts, {"fake_worker": True, "mesh_faces": 0, "peak_rss_mb": per_stage})
    return 0


if __name__ == "__main__":
    sys.exit(main())
