"""Run the real pipeline on a folder of photographs without the HTTP server.

    python -m pocket3d_companion.pipeline.localjob --images DIR --job-dir OUT --preset standard

Used by the benchmark/evaluation tools and the end-to-end smoke test. It builds exactly the job
directory the server would build (docs/companion-protocol.md §4) and then runs the worker.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import shutil
import sys
import uuid
from pathlib import Path

IMAGE_EXT = {".jpg", ".jpeg", ".png", ".webp", ".heic", ".heif"}


def make_job(images: Path, job_dir: Path, preset: str, settings: dict, threads: int, memory_mb: int,
             capture: Path | None = None, limit: int | None = None) -> Path:
    files = sorted(p for p in images.iterdir() if p.suffix.lower() in IMAGE_EXT)
    if limit:
        files = files[:limit]
    job_dir.mkdir(parents=True, exist_ok=True)
    originals = job_dir / "session" / "originals"
    originals.mkdir(parents=True, exist_ok=True)
    manifest = []
    for i, p in enumerate(files):
        fid = f"{i + 1:04d}"
        dst = originals / f"{fid}.bin"
        if not dst.exists():
            try:
                os.link(p, dst)
            except OSError:
                shutil.copyfile(p, dst)
        h = hashlib.sha256(p.read_bytes()).hexdigest()
        manifest.append({"id": fid, "name": p.name, "size": p.stat().st_size, "sha256": h})
    cap_path = job_dir / "session" / "capture.json"
    if capture:
        shutil.copyfile(capture, cap_path)
    else:
        cap_path.write_text(json.dumps({"format": 1, "source": "import", "frames": [
            {"id": m["id"], "name": m["name"]} for m in manifest]}))
    job = {"job_id": str(uuid.uuid4()), "session_id": str(uuid.uuid4()), "preset": preset, "settings": settings,
           "attempt": 1, "originals_dir": str(originals.resolve()), "capture_path": str(cap_path.resolve()),
           "files": manifest, "limits": {"threads": threads, "memory_mb": memory_mb}}
    jp = job_dir / "job.json"
    if jp.exists():  # keep ids stable across retries so checkpoints are reused
        old = json.loads(jp.read_text())
        job["job_id"], job["session_id"] = old.get("job_id", job["job_id"]), old.get("session_id", job["session_id"])
        job["attempt"] = int(old.get("attempt", 0)) + 1
    jp.write_text(json.dumps(job, indent=1))
    return job_dir


def main(argv=None) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--images", required=True, type=Path)
    ap.add_argument("--job-dir", required=True, type=Path)
    ap.add_argument("--preset", default="standard")
    ap.add_argument("--set", action="append", default=[], help="override: key=value (JSON value)")
    ap.add_argument("--threads", type=int, default=os.cpu_count() or 4)
    ap.add_argument("--memory-mb", type=int, default=8192)
    ap.add_argument("--capture", type=Path)
    ap.add_argument("--limit", type=int)
    a = ap.parse_args(argv)
    settings = {}
    for kv in a.set:
        k, v = kv.split("=", 1)
        settings[k] = json.loads(v)
    make_job(a.images, a.job_dir, a.preset, settings, a.threads, a.memory_mb, a.capture, a.limit)
    from .runner import main as run_main
    return run_main(["--job-dir", str(a.job_dir)])


if __name__ == "__main__":
    sys.exit(main())
