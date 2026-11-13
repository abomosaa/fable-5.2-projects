"""Append-only job event stream (events.jsonl) written by the worker, tailed by the server."""
from __future__ import annotations

import json
import os
import threading
import time
from pathlib import Path

STAGES = ["ingest", "features", "matching", "sfm", "undistort", "dense", "mesh", "refine",
          "texture", "package"]

# Relative share of total run time per stage (measured on the reference hardware, standard
# preset; see docs/MEASURED-RESULTS.md). Only used to turn real per-stage progress into an
# overall fraction — a stage's own progress always comes from work actually completed.
STAGE_WEIGHTS = {"ingest": 2, "features": 6, "matching": 6, "sfm": 8, "undistort": 2, "dense": 40,
                 "mesh": 10, "refine": 30, "texture": 22, "package": 4}


class EventWriter:
    def __init__(self, job_dir: Path, active_stages: list[str] | None = None):
        self.path = Path(job_dir) / "events.jsonl"
        self._lock = threading.Lock()
        self._seq = 0
        self._active = list(active_stages or STAGES)
        self._total = float(sum(STAGE_WEIGHTS[s] for s in self._active))
        self._done = 0.0
        self._stage: str | None = None
        self._stage_progress = 0.0
        self._last_progress_emit = 0.0
        self._last_progress_value = -1.0
        self._stage_t0 = 0.0
        self.timings: dict[str, float] = {}

    # -- low level ---------------------------------------------------------------------------
    def _overall(self) -> float:
        cur = STAGE_WEIGHTS.get(self._stage, 0) * self._stage_progress if self._stage in self._active else 0.0
        return max(0.0, min(1.0, (self._done + cur) / self._total))

    def emit(self, type_: str, message: str = "", data: dict | None = None, stage: str | None = None,
             progress: float | None = None) -> None:
        with self._lock:
            self._seq += 1
            ev = {"seq": self._seq, "t": round(time.time(), 3), "type": type_,
                  "stage": stage if stage is not None else self._stage,
                  "progress": round(self._stage_progress if progress is None else progress, 4),
                  "overall": round(self._overall(), 4), "message": message}
            if data is not None:
                ev["data"] = data
            line = json.dumps(ev, separators=(",", ":")) + "\n"
            fd = os.open(self.path, os.O_WRONLY | os.O_APPEND | os.O_CREAT, 0o600)
            try:
                os.write(fd, line.encode())
            finally:
                os.close(fd)

    # -- stage helpers -----------------------------------------------------------------------
    _START_MESSAGES = {"ingest": "Checking photos", "features": "Finding image features", "matching": "Matching photos",
                       "sfm": "Solving camera positions", "undistort": "Removing lens distortion",
                       "dense": "Starting dense depth maps", "mesh": "Building surface", "refine": "Refining surface",
                       "texture": "Texturing", "package": "Packaging model"}

    def stage_start(self, stage: str, message: str = "") -> None:
        message = message or self._START_MESSAGES.get(stage, "")
        self._stage = stage
        self._stage_progress = 0.0
        self._last_progress_value = -1.0
        self._stage_t0 = time.time()
        self.emit("stage_start", message, data={"index": self._active.index(stage) if stage in self._active else -1,
                                                "count": len(self._active)})

    def progress(self, fraction: float, message: str = "", data: dict | None = None, force: bool = False) -> None:
        fraction = max(0.0, min(1.0, float(fraction)))
        self._stage_progress = max(self._stage_progress, fraction)
        now = time.time()
        if not force and now - self._last_progress_emit < 0.4 and fraction - self._last_progress_value < 0.02:
            return
        self._last_progress_emit = now
        self._last_progress_value = fraction
        self.emit("stage_progress", message, data=data)

    def stage_end(self, message: str = "", data: dict | None = None, skipped: bool = False) -> None:
        stage = self._stage
        self._stage_progress = 1.0
        elapsed = time.time() - self._stage_t0
        if stage:
            self.timings[stage] = round(elapsed, 2)
        d = dict(data or {})
        d.update({"seconds": round(elapsed, 2), "skipped": skipped})
        self.emit("stage_end", message, data=d)
        if stage in self._active:
            self._done += STAGE_WEIGHTS.get(stage, 0)
        self._stage_progress = 0.0

    def diagnostics(self, data: dict, message: str = "") -> None:
        self.emit("diagnostics", message, data=data)

    def artifact(self, name: str, size: int, sha256: str, kind: str) -> None:
        self.emit("artifact", name, data={"name": name, "size": size, "sha256": sha256, "kind": kind})

    def warning(self, code: str, message: str) -> None:
        self.emit("warning", message, data={"code": code})

    def error(self, code: str, message: str, guidance: list[str] | None = None) -> None:
        self.emit("error", message, data={"code": code, "message": message, "guidance": guidance or []})

    def log(self, message: str) -> None:
        self.emit("log", message)
