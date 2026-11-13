"""Reconstruction jobs: persistent store, FIFO scheduler and worker supervision.

Each job attempt runs the pipeline worker as a subprocess in its own session/process group
(docs/companion-protocol.md §4). The server

* writes ``job.json`` before launch and redirects the worker's stdout/stderr to ``pipeline.log``;
* tails ``events.jsonl`` (ignoring an unterminated last line) and folds events into the job;
* watches the resident memory of the worker's process tree and the wall clock;
* decides the final state itself — a job is ``succeeded`` only if the worker exited 0 *and*
  ``out/result.json`` is valid *and* every artifact it lists has the stated size and SHA-256.

Layout (``<data>/jobs/<job_id>/``): ``state.json`` (server-owned job record), ``job.json``,
``events.jsonl``, ``pipeline.log``, ``work/``, ``out/``.

Event sequence numbers served to clients are the ordinal of each valid, newline-terminated
line of ``events.jsonl`` over the whole life of the job (all attempts), which makes them
stable across companion restarts without a second copy of the log.
"""
from __future__ import annotations

import asyncio
import json
import logging
import os
import re
import shutil
import signal
import stat
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import psutil

from .config import DEFAULT_WORKER_CMD, Config
from .storage import (ApiError, SHA256_RE, SessionStore, UUID4_RE, UUID_RE, atomic_write_json, bad_request,
                      not_found, read_json, remove_stale_tmp, sha256_file, strict_loads)

log = logging.getLogger("pocket3d.jobs")

STAGES = ["ingest", "features", "matching", "sfm", "undistort", "dense", "mesh", "refine", "texture",
          "package"]
TERMINAL = frozenset({"succeeded", "failed", "cancelled", "interrupted"})
ACTIVE = frozenset({"queued", "running", "cancelling"})
RETRYABLE = frozenset({"failed", "cancelled", "interrupted"})

ARTIFACT_NAME_RE = re.compile(r"\A[A-Za-z0-9][A-Za-z0-9._-]{0,63}\Z")
LOG_ARTIFACT = "pipeline.log"
SERVER_PEAK_KEY = "peak_rss_mb"
UNFINISHED_ARTIFACT_KINDS = frozenset({"preview", "diagnostics"})   # kept when an attempt did not succeed
_RESERVED_ARTIFACT_NAMES = {"result.json"}

MAX_EVENT_LINE = 256 * 1024
MAX_TAIL_READ = 8 * 1024 * 1024
MAX_EVENTS_PER_RESPONSE = 2000
MAX_SETTINGS_BYTES = 16 * 1024
SHUTDOWN_GRACE_S = 5.0          # must fit inside a container runtime's stop timeout (10 s)

FALLBACK_PRESETS = [
    {"id": "preview", "label": "Preview",
     "description": "Fast, coarse check that the capture registers and roughly reconstructs."},
    {"id": "standard", "label": "Standard",
     "description": "Balanced detail and time. Recommended for most objects."},
    {"id": "high", "label": "High",
     "description": "Maximum detail; several times slower and needs more companion memory."},
]

_GUIDANCE = {
    "memory_limit": ["Try the Preview or Standard preset, or use fewer photos.",
                     "Give the companion more memory (job_memory_mb) if the computer has it."],
    "timeout": ["Try a faster preset or fewer photos."],
    "worker_crashed": ["Retry the job; completed stages are reused.",
                       "If it keeps failing, try a lower preset and check the pipeline log."],
    "invalid_result": ["Retry the job; completed stages are reused."],
    "worker_launch_failed": ["Check the companion installation; the reconstruction worker could not be started."],
}


def load_presets() -> list[dict]:
    """Presets offered to clients: from the pipeline package if present, else the built-in ids."""
    try:
        from .pipeline.presets import PRESETS  # type: ignore[import-not-found]
        out = [{"id": str(pid), "label": str(p.get("label", pid)), "description": str(p.get("description", ""))}
               for pid, p in PRESETS.items()]
        if out:
            return out
    except Exception:
        pass
    return [dict(p) for p in FALLBACK_PRESETS]


def _validate_settings(preset: str, settings: dict) -> None:
    """Reject settings the pipeline would refuse, if the pipeline's validator is importable."""
    try:
        from .pipeline.presets import SettingsError, resolve_settings  # type: ignore[import-not-found]
    except Exception:
        return
    try:
        resolve_settings(preset, settings)
    except SettingsError as e:
        raise bad_request(f"invalid settings: {e}") from None


def _num(v: Any) -> float | None:
    if isinstance(v, bool) or not isinstance(v, (int, float)):
        return None
    return float(v)


def _unit(v: Any) -> float | None:
    n = _num(v)
    return None if n is None else max(0.0, min(1.0, n))


def clean_artifact(meta: Any) -> dict | None:
    """Validate an artifact description coming from the worker."""
    if not isinstance(meta, dict):
        return None
    name, size, digest, kind = meta.get("name"), meta.get("size"), meta.get("sha256"), meta.get("kind", "")
    if not isinstance(name, str) or not ARTIFACT_NAME_RE.match(name) or name in _RESERVED_ARTIFACT_NAMES:
        return None
    if isinstance(size, bool) or not isinstance(size, int) or size < 0:
        return None
    if not isinstance(digest, str) or not SHA256_RE.match(digest.lower()):
        return None
    if not isinstance(kind, str) or len(kind) > 32:
        return None
    return {"name": name, "size": size, "sha256": digest.lower(), "kind": kind}


def merge_diagnostics(target: dict, data: dict) -> None:
    """Shallow merge of worker diagnostics into the job's diagnostics.

    ``peak_rss_mb`` is owned by the server (a number: peak resident memory of the whole worker
    process tree as sampled by the watchdog). The pipeline reports its own per-stage figures
    under the same name as an object; that is kept as ``peak_rss_mb_by_stage`` so the type of
    ``peak_rss_mb`` never depends on how far a job got."""
    data = dict(data)
    worker_peak = data.pop(SERVER_PEAK_KEY, None)
    if isinstance(worker_peak, dict):
        data[SERVER_PEAK_KEY + "_by_stage"] = worker_peak
    target.update(data)


def _regular_file_size(path: Path) -> int | None:
    try:
        st = os.lstat(path)
    except OSError:
        return None
    return st.st_size if stat.S_ISREG(st.st_mode) else None


def verify_artifact(out_dir: Path, meta: dict) -> str | None:
    """Return None if ``out/<name>`` matches size and SHA-256, else a description of the problem."""
    path = out_dir / meta["name"]
    size = _regular_file_size(path)
    if size is None:
        return f"artifact {meta['name']} is missing"
    if size != meta["size"]:
        return f"artifact {meta['name']} has size {size}, expected {meta['size']}"
    if sha256_file(path) != meta["sha256"]:
        return f"artifact {meta['name']} does not match its SHA-256"
    return None


def check_result(job_dir: Path) -> tuple[dict | None, str | None]:
    """Validate ``out/result.json`` and the artifacts it lists (blocking; run in a thread).

    Returns (result, None) or (None, reason)."""
    out_dir = job_dir / "out"
    path = out_dir / "result.json"
    if _regular_file_size(path) is None:
        return None, "the worker exited successfully but wrote no out/result.json"
    try:
        doc = read_json(path)
    except Exception:
        return None, "out/result.json is not valid JSON"
    if not isinstance(doc, dict) or doc.get("ok") is not True:
        return None, "out/result.json does not report success"
    raw = doc.get("artifacts")
    if not isinstance(raw, list) or not raw:
        return None, "out/result.json lists no artifacts"
    artifacts = []
    for item in raw:
        meta = clean_artifact(item)
        if meta is None:
            return None, "out/result.json contains an invalid artifact entry"
        if meta["name"] == LOG_ARTIFACT and _regular_file_size(out_dir / LOG_ARTIFACT) is None:
            continue   # the server publishes pipeline.log itself
        problem = verify_artifact(out_dir, meta)
        if problem:
            return None, problem
        artifacts.append(meta)
    if not artifacts:
        return None, "out/result.json lists no artifacts"
    diagnostics = doc.get("diagnostics")
    return {"artifacts": artifacts, "diagnostics": diagnostics if isinstance(diagnostics, dict) else {}}, None


def _rmtree(path: Path) -> None:
    shutil.rmtree(path, ignore_errors=True)


def _reset_dir(path: Path) -> None:
    shutil.rmtree(path, ignore_errors=True)
    path.mkdir(parents=True, exist_ok=True, mode=0o700)


def _signal_name(returncode: int) -> str:
    try:
        return signal.Signals(-returncode).name
    except ValueError:
        return f"signal {-returncode}"


def _kill_group(pid: int, sig: int) -> None:
    try:
        os.killpg(pid, sig)
    except (ProcessLookupError, PermissionError):
        pass


@dataclass
class Job:
    job_id: str
    owner: str
    session_id: str
    preset: str
    settings: dict
    dir: Path
    state: str = "queued"
    attempt: int = 1
    created_at: float = 0.0
    queued_at: float = 0.0
    started_at: float | None = None
    finished_at: float | None = None
    stage: str | None = None
    stage_index: int | None = None
    stage_count: int = len(STAGES)
    stage_progress: float = 0.0
    overall_progress: float = 0.0
    message: str = ""
    error: dict | None = None
    diagnostics: dict = field(default_factory=dict)
    artifacts: list = field(default_factory=list)
    last_seq: int = 0
    session_revision: str = ""
    worker_pid: int | None = None
    worker_create_time: float | None = None

    # runtime only -------------------------------------------------------------------------
    events: list | None = field(default=None, repr=False)        # None = not loaded from disk yet
    events_offset: int = field(default=0, repr=False)
    changed: asyncio.Event = field(default_factory=asyncio.Event, repr=False)
    task: asyncio.Task | None = field(default=None, repr=False)
    proc: Any = field(default=None, repr=False)
    cancel_requested: bool = False
    interrupt_requested: bool = False
    kill_reason: str | None = None
    term_sent_at: float | None = None
    grace_s: float = 0.0
    attempt_error: dict | None = None
    peak_rss: int = 0
    dirty: bool = False
    last_persist: float = 0.0
    deleted: bool = False
    busy: bool = False
    order: int = 0

    _PERSISTED = ("job_id", "owner", "session_id", "preset", "settings", "state", "attempt", "created_at",
                  "queued_at", "started_at", "finished_at", "stage", "stage_index", "stage_count",
                  "stage_progress", "overall_progress", "message", "error", "diagnostics", "artifacts",
                  "last_seq", "session_revision", "worker_pid", "worker_create_time")

    def persisted(self) -> dict:
        return {k: getattr(self, k) for k in self._PERSISTED}

    @property
    def events_path(self) -> Path:
        return self.dir / "events.jsonl"

    @property
    def log_path(self) -> Path:
        return self.dir / LOG_ARTIFACT


class JobManager:
    def __init__(self, cfg: Config, sessions: SessionStore):
        self.cfg = cfg
        self.sessions = sessions
        self.root = cfg.jobs_dir
        self.jobs: dict[str, Job] = {}
        self.presets = load_presets()
        self._preset_ids = {p["id"] for p in self.presets}
        self._running: set[str] = set()
        self._stopping = False
        self._order = 0

    # ======================================================================================
    # startup / shutdown
    # ======================================================================================
    def load(self) -> None:
        """Load jobs from disk and recover from a previous run: jobs that were running have no
        worker any more and become ``interrupted``; queued jobs stay queued."""
        self.root.mkdir(parents=True, exist_ok=True, mode=0o700)
        loaded: list[Job] = []
        for d in self.root.iterdir():
            if not d.is_dir() or d.is_symlink() or not UUID4_RE.match(d.name):
                continue
            remove_stale_tmp(d)
            try:
                loaded.append(self._load_one(d))
            except Exception as e:
                log.warning("ignoring unreadable job directory %s (%s)", d.name, type(e).__name__)
        loaded.sort(key=lambda j: (j.queued_at, j.created_at, j.job_id))
        for job in loaded:
            self._order += 1
            job.order = self._order
            self.jobs[job.job_id] = job
            if job.session_id not in self.sessions.sessions:
                # Never delete on a hunch: the session may merely have failed to load.
                log.warning("ignoring job %s: its session is not available", job.job_id)
                del self.jobs[job.job_id]
                continue
            if job.state in ("running", "cancelling"):
                self._reap_stale_worker(job)
                self._load_events(job)
                job.state = "interrupted"
                job.finished_at = time.time()
                job.message = "The companion stopped while this job was running. Retry to continue."
                job.worker_pid = job.worker_create_time = None
                self._append_log(job, f"attempt {job.attempt}: {job.state} (companion restarted)")
                self._finalize_artifacts(job, None)
                self._persist(job)
            elif job.state == "queued":
                self._load_events(job)
                self._persist(job)
        log.info("loaded %d job(s)", len(self.jobs))

    def _load_one(self, d: Path) -> Job:
        doc = read_json(d / "state.json")
        if doc.get("job_id") != d.name or not UUID_RE.match(str(doc.get("owner", ""))):
            raise ValueError("state.json does not belong to this directory")
        if doc.get("state") not in TERMINAL | ACTIVE or not UUID4_RE.match(str(doc.get("session_id", ""))):
            raise ValueError("invalid job state")
        job = Job(job_id=d.name, owner=doc["owner"], session_id=doc["session_id"], preset=str(doc["preset"]),
                  settings=doc.get("settings") if isinstance(doc.get("settings"), dict) else {}, dir=d)
        for k in Job._PERSISTED[5:]:
            if k in doc:
                setattr(job, k, doc[k])
        job.artifacts = [a for a in (clean_artifact(a) for a in (job.artifacts or [])) if a]
        if not isinstance(job.diagnostics, dict):
            job.diagnostics = {}
        return job

    def _reap_stale_worker(self, job: Job) -> None:
        """A worker can outlive a companion that was killed; make sure it is gone."""
        pid = job.worker_pid
        if not pid:
            return
        leader: psutil.Process | None = None
        try:
            leader = psutil.Process(pid)
            if job.worker_create_time is None or abs(leader.create_time() - job.worker_create_time) > 1.0:
                return   # the pid now belongs to an unrelated process
        except psutil.Error:
            leader = None
        # The worker was started as a session leader, so everything it spawned carries its pid
        # as session id — also when the worker itself is already gone. (A pid is not reused
        # while a session with that id still has members.)
        members = []
        for p in psutil.process_iter():
            try:
                if p.pid != pid and os.getsid(p.pid) == pid:
                    members.append(p)
            except (OSError, psutil.Error):
                pass
        if leader is None and not members:
            return
        log.warning("killing worker processes of job %s left over from a previous run", job.job_id)
        _kill_group(pid, signal.SIGKILL)
        for p in members:
            try:
                p.kill()
            except psutil.Error:
                pass
        psutil.wait_procs(([leader] if leader else []) + members, timeout=5)

    def start(self) -> None:
        self._stopping = False
        self._schedule()

    async def stop(self) -> None:
        """Graceful shutdown: running workers are terminated and their jobs become ``interrupted``."""
        self._stopping = True
        tasks = []
        for job in list(self.jobs.values()):
            if job.task is not None and not job.task.done():
                job.interrupt_requested = True
                self._request_termination(job, SHUTDOWN_GRACE_S)
                tasks.append(job.task)
        if tasks:
            await asyncio.gather(*tasks, return_exceptions=True)

    async def abandon(self) -> None:
        """Stop supervising without touching workers or job state — what a killed companion
        process leaves behind. Used by tests of restart recovery."""
        self._stopping = True
        tasks = [j.task for j in self.jobs.values() if j.task is not None and not j.task.done()]
        for t in tasks:
            t.cancel()
        if tasks:
            await asyncio.gather(*tasks, return_exceptions=True)

    # ======================================================================================
    # persistence / notification
    # ======================================================================================
    def _persist(self, job: Job) -> None:
        if job.deleted:
            return
        atomic_write_json(job.dir / "state.json", job.persisted())
        job.dirty = False
        job.last_persist = time.monotonic()

    def _persist_soon(self, job: Job) -> None:
        """Progress updates are frequent; write them at most once per second."""
        job.dirty = True
        if time.monotonic() - job.last_persist >= 1.0:
            self._persist(job)

    @staticmethod
    def _notify(job: Job) -> None:
        ev, job.changed = job.changed, asyncio.Event()
        ev.set()

    def _append_log(self, job: Job, text: str) -> None:
        try:
            stamp = time.strftime("%Y-%m-%d %H:%M:%S")
            fd = os.open(job.log_path, os.O_WRONLY | os.O_CREAT | os.O_APPEND | os.O_NOFOLLOW, 0o600)
            try:
                os.write(fd, f"=== [{stamp}] companion: {text} ===\n".encode())
            finally:
                os.close(fd)
        except OSError:
            pass

    # ======================================================================================
    # events
    # ======================================================================================
    @staticmethod
    def _terminate_last_line(path: Path) -> None:
        """Only called while no worker is alive: a line cut off by a crash must not swallow
        the first event of the next attempt."""
        try:
            with open(path, "rb+") as f:
                f.seek(0, os.SEEK_END)
                if f.tell() == 0:
                    return
                f.seek(-1, os.SEEK_END)
                if f.read(1) != b"\n":
                    f.write(b"\n")
        except FileNotFoundError:
            pass

    def _load_events(self, job: Job) -> None:
        """(Re)build the in-memory event list from ``events.jsonl``; apply events the persisted
        job record has not seen yet."""
        if job.events is not None:
            return
        if job.proc is None:
            self._terminate_last_line(job.events_path)
        seen = job.last_seq
        job.events, job.events_offset, job.last_seq = [], 0, 0
        while self._tail(job, apply_after=seen):
            pass

    def _tail(self, job: Job, apply_after: int = 0) -> bool:
        """Consume complete new lines of ``events.jsonl``. Returns True if anything was read."""
        assert job.events is not None
        try:
            size = os.path.getsize(job.events_path)
        except OSError:
            return False
        if size <= job.events_offset:
            return False
        with open(job.events_path, "rb") as f:
            f.seek(job.events_offset)
            data = f.read(MAX_TAIL_READ)
        end = data.rfind(b"\n")
        if end < 0:
            if len(data) >= MAX_TAIL_READ:     # absurdly long line: skip it
                job.events_offset += len(data)
                return True
            return False                        # unterminated last line: wait for the rest
        job.events_offset += end + 1
        for line in data[:end].split(b"\n"):
            line = line.strip()
            if not line or len(line) > MAX_EVENT_LINE:
                continue
            try:
                raw = strict_loads(line)
            except (ValueError, RecursionError):
                continue
            if not isinstance(raw, dict):
                continue
            job.last_seq += 1
            ev = self._normalize_event(raw, job.last_seq)
            job.events.append(ev)
            if job.last_seq > apply_after:
                self._apply_event(job, ev)
        return True

    @staticmethod
    def _normalize_event(raw: dict, seq: int) -> dict:
        type_ = raw.get("type")
        stage = raw.get("stage")
        message = raw.get("message")
        data = raw.get("data")
        return {"seq": seq, "t": _num(raw.get("t")) or 0.0,
                "type": type_[:32] if isinstance(type_, str) and type_ else "log",
                "stage": stage[:32] if isinstance(stage, str) and stage else None,
                "progress": _unit(raw.get("progress")), "overall": _unit(raw.get("overall")),
                "message": message[:2000] if isinstance(message, str) else "",
                "data": data if isinstance(data, dict) else {}}

    def _apply_event(self, job: Job, ev: dict) -> None:
        type_, data = ev["type"], ev["data"]
        if type_ in ("stage_start", "stage_progress", "stage_end"):
            if ev["stage"]:
                if ev["stage"] != job.stage or type_ == "stage_start":
                    job.stage = ev["stage"]
                    idx, cnt = data.get("index"), data.get("count")
                    if isinstance(idx, int) and not isinstance(idx, bool) and idx >= 0:
                        job.stage_index = idx
                    elif job.stage in STAGES:
                        job.stage_index = STAGES.index(job.stage)
                    else:
                        job.stage_index = None
                    if isinstance(cnt, int) and not isinstance(cnt, bool) and cnt > 0:
                        job.stage_count = cnt
            if type_ == "stage_start":
                job.stage_progress = ev["progress"] or 0.0
            elif type_ == "stage_end":
                job.stage_progress = 1.0
            elif ev["progress"] is not None:
                job.stage_progress = ev["progress"]
            if ev["message"]:
                job.message = ev["message"]
        elif type_ == "diagnostics":
            merge_diagnostics(job.diagnostics, data)
        elif type_ == "artifact":
            meta = clean_artifact(data)
            if meta is not None:
                job.artifacts = [a for a in job.artifacts if a["name"] != meta["name"]] + [meta]
        elif type_ == "error":
            guidance = data.get("guidance")
            job.attempt_error = {
                "code": str(data.get("code") or "reconstruction_failed")[:64],
                "message": str(data.get("message") or ev["message"] or "Reconstruction failed.")[:2000],
                "guidance": [str(g)[:1000] for g in guidance][:20] if isinstance(guidance, list) else []}
        if ev["overall"] is not None and type_ != "log":
            job.overall_progress = ev["overall"]

    # ======================================================================================
    # API operations
    # ======================================================================================
    def get(self, owner: str, job_id: str) -> Job:
        if not isinstance(job_id, str) or not UUID4_RE.match(job_id):
            raise bad_request("job_id must be a lower-case UUIDv4")
        job = self.jobs.get(job_id)
        if job is None or job.deleted or job.owner != owner:
            raise not_found("job")
        return job

    def owned_by(self, owner: str, session_id: str | None = None) -> list[Job]:
        return sorted((j for j in self.jobs.values()
                       if j.owner == owner and not j.deleted and (session_id is None or j.session_id == session_id)),
                      key=lambda j: (j.created_at, j.job_id))

    def for_session(self, session_id: str) -> list[Job]:
        return sorted((j for j in self.jobs.values() if j.session_id == session_id and not j.deleted),
                      key=lambda j: (j.created_at, j.job_id))

    def session_has_active_job(self, session_id: str) -> bool:
        return any(j.state in ACTIVE or j.busy     # busy: a retry is being prepared right now
                   for j in self.jobs.values() if j.session_id == session_id and not j.deleted)

    def counts(self) -> dict:
        states = [j.state for j in self.jobs.values() if not j.deleted]
        return {"running": sum(s in ("running", "cancelling") for s in states), "queued": states.count("queued")}

    def _queue(self) -> list[Job]:
        return sorted((j for j in self.jobs.values() if j.state == "queued" and not j.deleted),
                      key=lambda j: j.order)

    def to_json(self, job: Job) -> dict:
        position = 0
        if job.state == "queued":
            position = 1 + sum(1 for j in self.jobs.values()
                               if j.state == "queued" and not j.deleted and j.order < job.order)
        return {"job_id": job.job_id, "session_id": job.session_id, "preset": job.preset,
                "settings": job.settings, "state": job.state, "attempt": job.attempt,
                "queue_position": position, "created_at": job.created_at, "started_at": job.started_at,
                "finished_at": job.finished_at, "stage": job.stage, "stage_index": job.stage_index,
                "stage_count": job.stage_count, "stage_progress": job.stage_progress,
                "overall_progress": job.overall_progress, "message": job.message, "error": job.error,
                "diagnostics": job.diagnostics, "artifacts": job.artifacts}

    def submit(self, owner: str, job_id: str, body: Any) -> tuple[Job, bool]:
        """Create a job (idempotent). Returns (job, created)."""
        if not UUID4_RE.match(job_id):
            raise bad_request("job_id must be a lower-case UUIDv4")
        if not isinstance(body, dict):
            raise bad_request("body must be a JSON object")
        session_id, preset, settings = body.get("session_id"), body.get("preset"), body.get("settings", {})
        if not isinstance(session_id, str) or not UUID4_RE.match(session_id):
            raise bad_request("session_id must be a lower-case UUIDv4")
        if not isinstance(preset, str) or preset not in self._preset_ids:
            raise bad_request("preset must be one of: " + ", ".join(p["id"] for p in self.presets))
        if settings is None:
            settings = {}
        if not isinstance(settings, dict):
            raise bad_request("settings must be a JSON object")
        if len(json.dumps(settings)) > MAX_SETTINGS_BYTES:
            raise ApiError(413, "limit_exceeded", "settings are too large")
        # Keys starting with "_" are reserved for the test worker; the real pipeline is never
        # configured through them, so they are not accepted from clients in normal operation.
        if any(isinstance(k, str) and k.startswith("_") for k in settings) and \
                list(self.cfg.worker_cmd) == list(DEFAULT_WORKER_CMD):
            raise bad_request("unknown setting (names starting with '_' are reserved)")

        existing = self.jobs.get(job_id)
        if existing is not None:
            if existing.owner != owner:
                raise not_found("job")
            if existing.deleted:
                raise ApiError(409, "conflict", "a job with this id is still being deleted; try again")
            if (existing.session_id, existing.preset, existing.settings) == (session_id, preset, settings):
                return existing, False
            raise ApiError(409, "conflict", "a different job with this id already exists")

        session = self.sessions.get(owner, session_id)
        if not session.complete:
            raise ApiError(409, "incomplete_upload", "the session's photographs have not all been uploaded")
        active = sum(1 for j in self.jobs.values() if j.owner == owner and not j.deleted and j.state in ACTIVE)
        if active >= self.cfg.max_active_jobs_per_device:
            raise ApiError(429, "limit_exceeded",
                           f"this device already has {active} reconstructions queued or running; wait for one to finish")
        _validate_settings(preset, settings)

        d = self.root / job_id       # job_id is a validated UUID
        d.mkdir(parents=True, exist_ok=True, mode=0o700)
        _reset_dir(d / "work")
        _reset_dir(d / "out")
        for stale in ("events.jsonl", LOG_ARTIFACT, "job.json"):
            try:
                os.unlink(d / stale)
            except FileNotFoundError:
                pass
        now = time.time()
        self._order += 1
        job = Job(job_id=job_id, owner=owner, session_id=session_id, preset=preset, settings=settings, dir=d,
                  created_at=now, queued_at=now, session_revision=session.revision, events=[], order=self._order)
        self._persist(job)
        self.jobs[job_id] = job
        log.info("job %s queued (session %s, preset %s)", job_id, session_id, preset)
        self._schedule()
        return job, True

    def cancel(self, job: Job) -> None:
        if job.state == "queued":
            job.state = "cancelled"
            job.finished_at = time.time()
            job.message = "Cancelled."
            self._persist(job)
            self._notify(job)
            log.info("job %s cancelled while queued", job.job_id)
        elif job.state == "running":
            job.state = "cancelling"
            job.cancel_requested = True
            self._request_termination(job, self.cfg.cancel_grace_s)
            self._persist(job)
            self._notify(job)
            log.info("job %s cancelling", job.job_id)

    async def retry(self, job: Job) -> None:
        if job.state not in RETRYABLE or job.busy or (job.task is not None and not job.task.done()):
            raise ApiError(409, "conflict", f"a job in state {job.state} cannot be retried")
        session = self.sessions.sessions.get(job.session_id)
        if session is None or session.deleted:
            raise not_found("session")
        if not session.complete:
            raise ApiError(409, "incomplete_upload", "the session's photographs have not all been uploaded")
        job.busy = True            # the job stays out of the queue until its directory is ready
        try:
            loop = asyncio.get_running_loop()
            if session.revision != job.session_revision:
                # The photographs changed since the last attempt: nothing in work/ can be reused.
                await loop.run_in_executor(None, _reset_dir, job.dir / "work")
                job.session_revision = session.revision
            await loop.run_in_executor(None, _reset_dir, job.dir / "out")
        finally:
            job.busy = False
        if job.deleted:
            raise not_found("job")
        if session.deleted or not session.complete or session.revision != job.session_revision:
            raise ApiError(409, "conflict", "the session changed while the job was being re-queued")
        self._load_events(job)
        job.state = "queued"
        self._order += 1
        job.order = self._order
        job.attempt += 1
        job.queued_at = time.time()
        job.started_at = job.finished_at = None
        job.stage = job.stage_index = None
        job.stage_count = len(STAGES)
        job.stage_progress = job.overall_progress = 0.0
        job.message = ""
        job.error = None
        job.diagnostics = {}
        job.artifacts = []
        job.cancel_requested = job.interrupt_requested = False
        job.kill_reason = job.term_sent_at = job.attempt_error = None
        self._persist(job)
        self._notify(job)
        log.info("job %s re-queued (attempt %d)", job.job_id, job.attempt)
        self._schedule()

    async def delete(self, job: Job) -> None:
        """Cancel if needed, wait until the worker is really gone, then remove the job's data."""
        if job.deleted:
            return
        self.cancel(job)
        if job.task is not None and not job.task.done():
            await asyncio.gather(job.task, return_exceptions=True)
        while job.busy:                 # a retry is preparing the directory right now
            await asyncio.sleep(0.02)
        if job.deleted:
            return
        self.cancel(job)                # the retry may have re-queued it meanwhile
        job.deleted = True              # invisible from now on; the id stays reserved until …
        self._notify(job)
        try:
            await asyncio.get_running_loop().run_in_executor(None, _rmtree, job.dir)
        finally:
            self.jobs.pop(job.job_id, None)     # … its directory is gone
        log.info("job %s deleted", job.job_id)

    async def delete_for_session(self, session_id: str) -> None:
        jobs = self.for_session(session_id)
        if jobs:
            await asyncio.gather(*(self.delete(j) for j in jobs))

    async def wait_events(self, job: Job, since: int, wait: float) -> tuple[list[dict], int]:
        """Events with ``seq > since``; long-polls up to ``wait`` seconds while there are none
        and the job neither finishes nor changes state."""
        loop = asyncio.get_running_loop()
        deadline = loop.time() + max(0.0, min(wait, self.cfg.max_long_poll_s))
        state0 = job.state
        while True:
            if job.deleted:
                raise not_found("job")
            self._load_events(job)
            assert job.events is not None
            events = job.events[since:since + MAX_EVENTS_PER_RESPONSE] if since < len(job.events) else []
            remaining = deadline - loop.time()
            if events or job.state in TERMINAL or job.state != state0 or remaining <= 0:
                return events, (events[-1]["seq"] if events else job.last_seq)
            changed = job.changed
            try:
                await asyncio.wait_for(changed.wait(), remaining)
            except asyncio.TimeoutError:
                pass

    def artifact_file(self, job: Job, name: str) -> tuple[Path, dict | None]:
        """Resolve a downloadable artifact. The path is built from the server's own record of
        the artifact, never from the requested name."""
        if not isinstance(name, str) or not ARTIFACT_NAME_RE.match(name):
            raise bad_request("invalid artifact name")
        meta = next((a for a in job.artifacts if a["name"] == name), None)
        if meta is not None:
            path = job.dir / "out" / meta["name"]
            if _regular_file_size(path) is None and meta["name"] == LOG_ARTIFACT:
                path = job.log_path
        elif name == LOG_ARTIFACT:
            path = job.log_path       # live log of a job that has not finished yet
        else:
            raise not_found("artifact")
        if _regular_file_size(path) is None:
            raise not_found("artifact")
        return path, meta

    # ======================================================================================
    # scheduling and supervision
    # ======================================================================================
    def _schedule(self) -> None:
        if self._stopping:
            return
        for job in self._queue():
            if len(self._running) >= self.cfg.max_parallel_jobs:
                break
            self._running.add(job.job_id)
            job.state = "running"
            job.started_at = time.time()
            job.cancel_requested = job.interrupt_requested = False
            job.kill_reason = job.term_sent_at = job.attempt_error = None
            job.peak_rss = 0
            self._persist(job)
            self._notify(job)
            job.task = asyncio.get_running_loop().create_task(self._run(job), name=f"job-{job.job_id}")
        for job in self._queue():      # queue positions of the others changed
            self._notify(job)

    def _request_termination(self, job: Job, grace_s: float) -> None:
        """SIGTERM the worker's process group now; the supervision loop escalates to SIGKILL."""
        if job.term_sent_at is None:
            job.term_sent_at = time.monotonic()
            job.grace_s = grace_s
            if job.proc is not None and job.proc.returncode is None:
                _kill_group(job.proc.pid, signal.SIGTERM)
        else:
            job.grace_s = min(job.grace_s, grace_s)

    async def _run(self, job: Job) -> None:
        abandoned = False
        try:
            await self._run_attempt(job)
        except asyncio.CancelledError:
            abandoned = True       # see abandon(): leave everything as a killed server would
            raise
        except Exception:
            log.exception("job %s: supervision failed", job.job_id)
            if job.proc is not None:
                _kill_group(job.proc.pid, signal.SIGKILL)
            self._finish(job, "failed", {"code": "server_error",
                                         "message": "The companion failed while supervising the job.",
                                         "guidance": ["Retry the job."]})
        finally:
            job.proc = None
            self._running.discard(job.job_id)
            if not abandoned:
                self._schedule()

    def _worker_env(self) -> dict:
        env = dict(os.environ)
        threads = str(self.cfg.job_threads)
        for var in ("OMP_NUM_THREADS", "OPENBLAS_NUM_THREADS", "MKL_NUM_THREADS", "NUMEXPR_NUM_THREADS",
                    "VECLIB_MAXIMUM_THREADS"):
            env[var] = threads
        env["POCKET3D_JOB_THREADS"] = threads
        env["POCKET3D_JOB_MEMORY_MB"] = str(self.cfg.job_memory_mb)
        env["PYTHONUNBUFFERED"] = "1"
        pkg_parent = str(Path(__file__).resolve().parent.parent)   # so `-m pocket3d_companion.…` resolves
        env["PYTHONPATH"] = pkg_parent + (os.pathsep + env["PYTHONPATH"] if env.get("PYTHONPATH") else "")
        return env

    def _write_job_json(self, job: Job) -> None:
        session = self.sessions.sessions[job.session_id]
        atomic_write_json(job.dir / "job.json", {
            "job_id": job.job_id, "session_id": job.session_id, "preset": job.preset,
            "settings": job.settings, "attempt": job.attempt,
            "originals_dir": str(session.originals_dir), "capture_path": str(session.capture_path),
            "files": [{"id": f.id, "name": f.name, "size": f.size, "sha256": f.sha256}
                      for f in session.files.values()],
            "limits": {"threads": self.cfg.job_threads, "memory_mb": self.cfg.job_memory_mb}})

    async def _run_attempt(self, job: Job) -> None:
        cfg = self.cfg
        loop = asyncio.get_running_loop()
        self._load_events(job)
        (job.dir / "work").mkdir(exist_ok=True, mode=0o700)
        (job.dir / "out").mkdir(exist_ok=True, mode=0o700)
        self._terminate_last_line(job.events_path)
        if job.cancel_requested:
            self._finish(job, "cancelled", None)
            return
        if job.interrupt_requested:
            self._finish(job, "interrupted", None)
            return
        self._write_job_json(job)
        self._append_log(job, f"attempt {job.attempt} started")

        cmd = [a.replace("{job_dir}", str(job.dir)) for a in cfg.worker_cmd]
        log_fd = os.open(job.log_path, os.O_WRONLY | os.O_CREAT | os.O_APPEND | os.O_NOFOLLOW, 0o600)
        try:
            proc = await asyncio.create_subprocess_exec(
                *cmd, stdin=asyncio.subprocess.DEVNULL, stdout=log_fd, stderr=asyncio.subprocess.STDOUT,
                cwd=str(job.dir / "work"), env=self._worker_env(), start_new_session=True)
        except OSError as e:
            log.error("job %s: cannot start the worker (%s)", job.job_id, type(e).__name__)
            self._finish(job, "failed", {"code": "worker_launch_failed",
                                         "message": "The reconstruction worker could not be started.",
                                         "guidance": _GUIDANCE["worker_launch_failed"]})
            return
        finally:
            os.close(log_fd)

        job.proc = proc
        job.worker_pid = proc.pid
        try:
            ps_proc: psutil.Process | None = psutil.Process(proc.pid)
            job.worker_create_time = ps_proc.create_time()
        except psutil.Error:
            ps_proc, job.worker_create_time = None, None
        self._persist(job)
        log.info("job %s attempt %d: worker started (pid %d)", job.job_id, job.attempt, proc.pid)
        if job.term_sent_at is not None:       # cancel/shutdown arrived while we were launching
            _kill_group(proc.pid, signal.SIGTERM)

        started = time.monotonic()
        next_watch = started
        memory_limit = cfg.job_memory_mb * 1024 * 1024
        waiter = asyncio.ensure_future(proc.wait())
        try:
            while not waiter.done():
                await asyncio.wait({waiter}, timeout=cfg.event_poll_s)
                if self._tail(job):
                    self._persist_soon(job)
                    self._notify(job)
                now = time.monotonic()
                if waiter.done():
                    break
                if now >= next_watch:
                    next_watch = now + cfg.watchdog_interval_s
                    rss = await loop.run_in_executor(None, _tree_rss, ps_proc)
                    if rss > job.peak_rss:
                        job.peak_rss = rss
                        job.diagnostics["peak_rss_mb"] = round(rss / (1024 * 1024), 1)
                        self._persist_soon(job)
                    if job.kill_reason is None and rss > memory_limit:
                        log.warning("job %s: worker uses %d MB, limit is %d MB — killing it",
                                    job.job_id, rss // (1024 * 1024), cfg.job_memory_mb)
                        job.kill_reason = "memory_limit"
                        _kill_group(proc.pid, signal.SIGKILL)
                    elif job.kill_reason is None and now - started > cfg.job_timeout_s:
                        log.warning("job %s: wall-clock limit reached — terminating it", job.job_id)
                        job.kill_reason = "timeout"
                        self._request_termination(job, cfg.cancel_grace_s)
                if job.term_sent_at is not None and now - job.term_sent_at > job.grace_s:
                    _kill_group(proc.pid, signal.SIGKILL)      # did not stop in time
                if job.dirty and now - job.last_persist >= 1.0:
                    self._persist(job)
        except asyncio.CancelledError:
            waiter.cancel()
            raise
        returncode = waiter.result()
        _kill_group(proc.pid, signal.SIGKILL)      # anything the worker left behind in its group
        job.proc = None
        job.worker_pid = job.worker_create_time = None

        self._terminate_last_line(job.events_path)
        while self._tail(job):
            pass
        if job.peak_rss:
            job.diagnostics["peak_rss_mb"] = round(job.peak_rss / (1024 * 1024), 1)

        state, error, result = await self._outcome(job, returncode)
        log.info("job %s attempt %d: worker exited (%s) → %s", job.job_id, job.attempt,
                 returncode if returncode >= 0 else _signal_name(returncode), state)
        self._append_log(job, f"attempt {job.attempt} finished: {state}"
                              + (f" ({error['code']})" if error else ""))
        await loop.run_in_executor(None, self._finalize_artifacts, job, result)
        if state == "succeeded":
            # Intermediate data (depth maps, dense cloud, working images) is not needed again.
            # Cleared before the success becomes visible, so "succeeded" means "settled on disk".
            await loop.run_in_executor(None, self._clear_work, job, True)
        self._finish(job, state, error)

    async def _outcome(self, job: Job, returncode: int) -> tuple[str, dict | None, dict | None]:
        """Decide the final state of an attempt. Returns (state, error, verified result)."""
        if job.cancel_requested:
            return "cancelled", None, None
        if job.kill_reason == "memory_limit":
            return "failed", {"code": "memory_limit",
                              "message": f"Reconstruction needed more than the {self.cfg.job_memory_mb} MB "
                                         "of memory the companion allows per job and was stopped.",
                              "guidance": _GUIDANCE["memory_limit"]}, None
        if job.kill_reason == "timeout":
            return "failed", {"code": "timeout",
                              "message": "Reconstruction exceeded the companion's time limit of "
                                         f"{self.cfg.job_timeout_s / 3600:.1f} h and was stopped.",
                              "guidance": _GUIDANCE["timeout"]}, None
        if job.interrupt_requested:
            return "interrupted", None, None
        if returncode == 0:
            result, problem = await asyncio.get_running_loop().run_in_executor(None, check_result, job.dir)
            if result is not None:
                return "succeeded", None, result
            return "failed", {"code": "invalid_result",
                              "message": f"The reconstruction did not produce a verifiable result: {problem}.",
                              "guidance": _GUIDANCE["invalid_result"]}, None
        if job.attempt_error is not None and returncode in (1, 2, 3):
            return "failed", job.attempt_error, None
        if returncode == 2:
            return "failed", {"code": "reconstruction_failed",
                              "message": "Reconstruction failed without further details.", "guidance": []}, None
        if returncode == 3:
            return "failed", {"code": "invalid_input",
                              "message": "The worker rejected the job's input without further details.",
                              "guidance": []}, None
        how = (f"was killed by {_signal_name(returncode)}"
               + (" (possibly out of memory)" if returncode == -signal.SIGKILL else "")
               if returncode < 0 else f"exited with code {returncode}")
        return "failed", {"code": "worker_crashed",
                          "message": f"The reconstruction worker stopped unexpectedly: it {how}.",
                          "guidance": _GUIDANCE["worker_crashed"]}, None

    def _finalize_artifacts(self, job: Job, result: dict | None) -> None:
        """Artifact list of a finished attempt (blocking). On success exactly what result.json
        lists. Otherwise only provisional/diagnostic files the worker announced and that are
        still intact — never a model: an attempt that did not succeed has no result. The log
        is always published so that failures can be diagnosed from the phone."""
        out_dir = job.dir / "out"
        if result is not None:
            artifacts = list(result["artifacts"])
            merge_diagnostics(job.diagnostics, result["diagnostics"])
        else:
            artifacts = [a for a in job.artifacts
                         if a["kind"] in UNFINISHED_ARTIFACT_KINDS and a["name"] != LOG_ARTIFACT
                         and _regular_file_size(out_dir / a["name"]) == a["size"]]
        if not any(a["name"] == LOG_ARTIFACT for a in artifacts):
            size = _regular_file_size(job.log_path)
            if size is not None:
                try:
                    artifacts.append({"name": LOG_ARTIFACT, "size": size, "sha256": sha256_file(job.log_path),
                                      "kind": "log"})
                except OSError:
                    pass
        job.artifacts = artifacts

    def _finish(self, job: Job, state: str, error: dict | None) -> None:
        job.state = state
        job.error = error
        job.finished_at = time.time()
        if state == "succeeded":
            job.overall_progress = 1.0
            job.stage_progress = 1.0
        elif state == "cancelled":
            job.message = "Cancelled."
        elif state == "interrupted":
            job.message = "The companion stopped while this job was running. Retry to continue."
        elif error is not None:
            job.message = error["message"]
        job.worker_pid = job.worker_create_time = None
        self._persist(job)
        self._notify(job)

    def _clear_work(self, job: Job, finishing: bool = False) -> bool:
        """Delete the contents of the job's work directory — never (re)creates anything, and does
        nothing if the job was deleted or started running again in the meantime."""
        if job.deleted or (job.state not in TERMINAL and not finishing):
            return False
        work = job.dir / "work"
        try:
            children = list(work.iterdir())
        except OSError:
            return False
        for child in children:
            if child.is_dir() and not child.is_symlink():
                shutil.rmtree(child, ignore_errors=True)
            else:
                try:
                    child.unlink()
                except OSError:
                    pass
        return bool(children)

    async def purge_stale_work(self, now: float | None = None) -> list[str]:
        """Clear `work/` of jobs that ended more than `work_ttl_s` ago without success (until then
        a retry reuses the finished stages). Returns the ids of the jobs that were cleared."""
        now = time.time() if now is None else now
        cleared = []
        loop = asyncio.get_running_loop()
        for job in list(self.jobs.values()):
            if job.deleted or job.state not in TERMINAL or job.finished_at is None:
                continue
            if job.state != "succeeded" and now - job.finished_at < self.cfg.work_ttl_s:
                continue
            if await loop.run_in_executor(None, self._clear_work, job):
                cleared.append(job.job_id)
        return cleared


def _tree_rss(proc: psutil.Process | None) -> int:
    """Resident memory of the worker and all its descendants, in bytes (blocking)."""
    if proc is None:
        return 0
    total = 0
    try:
        procs = [proc] + proc.children(recursive=True)
    except psutil.Error:
        return 0
    for p in procs:
        try:
            total += p.memory_info().rss
        except psutil.Error:
            pass
    return total
