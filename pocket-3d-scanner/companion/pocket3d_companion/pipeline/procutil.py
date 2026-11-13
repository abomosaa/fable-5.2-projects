"""Bounded, cancellable execution of external reconstruction tools (OpenMVS)."""
from __future__ import annotations

import os
import signal
import subprocess
import threading
import time
from pathlib import Path

import psutil

from .errors import Cancelled, PipelineError

_children: set[subprocess.Popen] = set()
_children_lock = threading.Lock()


def kill_children() -> None:
    """Terminate every tool process started by this worker (used on cancel/SIGTERM)."""
    with _children_lock:
        procs = list(_children)
    for p in procs:
        try:
            p.terminate()
        except ProcessLookupError:
            pass
    deadline = time.time() + 3
    for p in procs:
        try:
            p.wait(timeout=max(0.1, deadline - time.time()))
        except subprocess.TimeoutExpired:
            try:
                p.kill()
            except ProcessLookupError:
                pass


def tree_rss_mb(pid: int) -> float:
    try:
        proc = psutil.Process(pid)
        total = proc.memory_info().rss
        for c in proc.children(recursive=True):
            try:
                total += c.memory_info().rss
            except psutil.Error:
                pass
        return total / 1e6
    except psutil.Error:
        return 0.0


class PeakRss:
    """Samples this worker's whole process tree; the peak goes into the job diagnostics."""

    def __init__(self, interval: float = 0.5):
        self.peak_mb = 0.0
        self.stage_peak_mb = 0.0
        self._stop = threading.Event()
        self._interval = interval
        self._thread = threading.Thread(target=self._run, daemon=True)

    def _run(self):
        pid = os.getpid()
        while not self._stop.wait(self._interval):
            v = tree_rss_mb(pid)
            self.peak_mb = max(self.peak_mb, v)
            self.stage_peak_mb = max(self.stage_peak_mb, v)

    def start(self):
        self._thread.start()
        return self

    def reset_stage(self) -> float:
        v = self.stage_peak_mb
        self.stage_peak_mb = 0.0
        return v

    def stop(self):
        self._stop.set()


def run_tool(cmd: list[str], cwd: Path, log_path: Path, cancel: threading.Event, on_line=None,
             timeout_s: float | None = None, name: str | None = None) -> None:
    """Run an external tool, streaming its output to `log_path` and to `on_line(str)` (used to
    derive progress from the tool's own messages). Raises PipelineError on non-zero exit and
    Cancelled when `cancel` is set (the tool is terminated)."""
    name = name or Path(cmd[0]).name
    with open(log_path, "ab") as log:
        log.write(("\n$ " + " ".join(cmd) + "\n").encode())
        log.flush()
        proc = subprocess.Popen(cmd, cwd=str(cwd), stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                                stdin=subprocess.DEVNULL)
        with _children_lock:
            _children.add(proc)
        tail: list[str] = []

        def pump():
            assert proc.stdout is not None
            buf = b""
            while True:
                chunk = proc.stdout.read1(65536)
                if not chunk:
                    break
                log.write(chunk)
                log.flush()
                buf += chunk
                # OpenMVS progress updates end with '\r'
                parts = buf.replace(b"\r", b"\n").split(b"\n")
                buf = parts.pop()
                for raw in parts:
                    line = raw.decode("utf-8", "replace").strip()
                    if not line:
                        continue
                    tail.append(line)
                    del tail[:-30]
                    if on_line:
                        try:
                            on_line(line)
                        except Exception:
                            pass

        t = threading.Thread(target=pump, daemon=True)
        t.start()
        t0 = time.time()
        try:
            while True:
                try:
                    rc = proc.wait(timeout=0.25)
                    break
                except subprocess.TimeoutExpired:
                    pass
                if cancel.is_set():
                    proc.terminate()
                    try:
                        proc.wait(timeout=5)
                    except subprocess.TimeoutExpired:
                        proc.kill()
                    raise Cancelled()
                if timeout_s and time.time() - t0 > timeout_s:
                    proc.kill()
                    raise PipelineError("tool_timeout", f"{name} exceeded its time limit of {int(timeout_s)} s.")
        finally:
            t.join(timeout=5)
            with _children_lock:
                _children.discard(proc)
    if rc != 0:
        if rc in (-signal.SIGKILL, 137):
            raise PipelineError(
                "out_of_memory",
                f"{name} was killed by the operating system, most likely because it ran out of memory.",
                ["Use a lower quality preset, or give the companion more memory (see README: resource limits)."])
        detail = " | ".join(tail[-3:])[-400:]
        raise PipelineError("tool_failed", f"{name} failed (exit {rc}). {detail}")
