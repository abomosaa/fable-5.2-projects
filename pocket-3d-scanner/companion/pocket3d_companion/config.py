"""Companion configuration: defaults, environment overrides and resource detection.

Precedence (lowest → highest): built-in defaults, ``<data>/config.json`` (optional, same keys
as the dataclass fields), ``POCKET3D_*`` environment variables, command-line flags.
"""
from __future__ import annotations

import json
import math
import os
import shlex
import sys
from dataclasses import dataclass, field, fields
from pathlib import Path

import psutil

MIB = 1024 * 1024

DEFAULT_WORKER_CMD = [sys.executable, "-m", "pocket3d_companion.pipeline", "--job-dir", "{job_dir}"]

# Interfaces that never carry the phone's traffic (container bridges etc.).
_VIRTUAL_IFACE_PREFIXES = ("lo", "docker", "podman", "veth", "br-", "virbr", "cni", "flannel", "lxc")


def _cgroup_cpu_quota() -> float | None:
    """CPU quota of the current cgroup (v2) in cores, e.g. set by ``podman run --cpus``."""
    try:
        quota, period = Path("/sys/fs/cgroup/cpu.max").read_text().split()[:2]
        if quota != "max" and float(period) > 0:
            return float(quota) / float(period)
    except (OSError, ValueError):
        pass
    return None


def _cgroup_memory_limit() -> int | None:
    try:
        raw = Path("/sys/fs/cgroup/memory.max").read_text().strip()
        if raw != "max":
            return int(raw)
    except (OSError, ValueError):
        pass
    return None


def cpu_threads() -> int:
    """Hardware threads usable by this process."""
    try:
        n = len(os.sched_getaffinity(0))
    except (AttributeError, OSError):
        n = os.cpu_count() or 1
    return max(1, n)


def memory_total_bytes() -> int:
    """Memory available to the companion: host RAM, capped by the container limit if any."""
    total = psutil.virtual_memory().total
    limit = _cgroup_memory_limit()
    return min(total, limit) if limit else total


def cpu_model() -> str:
    try:
        with open("/proc/cpuinfo", encoding="utf-8", errors="replace") as f:
            for line in f:
                if line.lower().startswith("model name"):
                    return line.split(":", 1)[1].strip()
    except OSError:
        pass
    import platform
    return platform.processor() or platform.machine() or "unknown"


def detect_lan_ipv4() -> list[str]:
    """Non-loopback IPv4 addresses of interfaces that are up (candidates for the pairing QR)."""
    import socket
    out: list[str] = []
    try:
        stats = psutil.net_if_stats()
        for name, addrs in psutil.net_if_addrs().items():
            st = stats.get(name)
            if st is not None and not st.isup:
                continue
            if name.startswith(_VIRTUAL_IFACE_PREFIXES):
                continue
            for a in addrs:
                if a.family == socket.AF_INET and a.address and not a.address.startswith(("127.", "169.254.")):
                    if a.address not in out:
                        out.append(a.address)
    except Exception:  # pragma: no cover - psutil platform quirks
        pass
    return out


def _default_job_threads(max_parallel: int) -> int:
    quota = _cgroup_cpu_quota()
    usable = math.floor(quota) if quota else cpu_threads() // 2  # half the host unless already limited
    return max(1, int(usable) // max(1, max_parallel))


def _default_job_memory_mb(max_parallel: int) -> int:
    budget = int(memory_total_bytes() * 0.8 / MIB) // max(1, max_parallel)
    return max(512, min(10240, budget))


@dataclass
class Limits:
    max_images: int = 400
    min_images: int = 3
    max_image_bytes: int = 64 * MIB
    max_image_pixels: int = 80_000_000
    min_image_side: int = 320
    max_session_bytes: int = 8 * 1024 * MIB
    formats: tuple[str, ...] = ("jpeg", "png", "webp", "heic")

    def to_json(self) -> dict:
        return {"max_images": self.max_images, "min_images": self.min_images,
                "max_image_bytes": self.max_image_bytes, "max_image_pixels": self.max_image_pixels,
                "min_image_side": self.min_image_side, "max_session_bytes": self.max_session_bytes,
                "formats": list(self.formats)}


@dataclass
class Config:
    data_dir: Path = Path("./companion-data")
    host: str = "0.0.0.0"
    port: int = 8443
    advertise: list[str] = field(default_factory=list)   # empty = auto-detect
    advertise_port: int = 0                              # 0 = the port actually bound
    server_name: str = ""                                # empty = hostname
    qr: str = "dark"                                     # dark | light | off (terminal background)

    max_parallel_jobs: int = 1
    job_threads: int = 0                                 # 0 = auto
    job_memory_mb: int = 0                               # 0 = auto
    job_timeout_s: float = 6 * 3600.0
    # Housekeeping (bounded disk use): intermediate data of a finished job is removed at once on
    # success and after `work_ttl_s` otherwise (a retry within that time reuses finished stages);
    # uploads that were never completed and belong to no job are removed after `upload_ttl_s`.
    work_ttl_s: float = 24 * 3600.0
    upload_ttl_s: float = 7 * 24 * 3600.0
    max_active_jobs_per_device: int = 4
    max_pair_body_bytes: int = 4096
    cancel_grace_s: float = 10.0                         # SIGTERM → SIGKILL escalation
    watchdog_interval_s: float = 1.0
    event_poll_s: float = 0.25
    worker_cmd: list[str] = field(default_factory=lambda: list(DEFAULT_WORKER_CMD))

    limits: Limits = field(default_factory=Limits)
    max_json_bytes: int = 8 * MIB                        # session manifest / capture metadata
    disk_reserve_mb: int = 512                           # never fill the disk below this
    upload_idle_timeout_s: float = 60.0
    max_long_poll_s: float = 30.0

    pairing_code_ttl_s: float = 600.0
    pairing_max_attempts: int = 5
    pairing_lock_s: float = 60.0

    def finalize(self) -> "Config":
        self.data_dir = Path(self.data_dir).expanduser().resolve()
        self.max_parallel_jobs = max(1, int(self.max_parallel_jobs))
        if self.job_threads <= 0:
            self.job_threads = _default_job_threads(self.max_parallel_jobs)
        if self.job_memory_mb <= 0:
            self.job_memory_mb = _default_job_memory_mb(self.max_parallel_jobs)
        if self.qr not in ("dark", "light", "off"):
            raise ValueError("qr must be one of dark, light, off")
        if not self.worker_cmd or not all(isinstance(a, str) for a in self.worker_cmd):
            raise ValueError("worker_cmd must be a non-empty list of strings")
        return self

    # -- paths -------------------------------------------------------------------------------
    @property
    def sessions_dir(self) -> Path:
        return self.data_dir / "sessions"

    @property
    def jobs_dir(self) -> Path:
        return self.data_dir / "jobs"

    @property
    def tls_dir(self) -> Path:
        return self.data_dir / "tls"


_ENV = {  # env var → (field, parser)
    "POCKET3D_HOST": ("host", str),
    "POCKET3D_PORT": ("port", int),
    "POCKET3D_ADVERTISE_PORT": ("advertise_port", int),
    "POCKET3D_SERVER_NAME": ("server_name", str),
    "POCKET3D_QR": ("qr", str),
    "POCKET3D_MAX_PARALLEL_JOBS": ("max_parallel_jobs", int),
    "POCKET3D_JOB_THREADS": ("job_threads", int),
    "POCKET3D_JOB_MEMORY_MB": ("job_memory_mb", int),
    "POCKET3D_JOB_TIMEOUT_S": ("job_timeout_s", float),
    "POCKET3D_CANCEL_GRACE_S": ("cancel_grace_s", float),
    "POCKET3D_DISK_RESERVE_MB": ("disk_reserve_mb", int),
}


def parse_worker_cmd(raw: str) -> list[str]:
    """``POCKET3D_WORKER_CMD`` is either a JSON list or a shell-style string."""
    raw = raw.strip()
    if raw.startswith("["):
        cmd = json.loads(raw)
    else:
        cmd = shlex.split(raw)
    if not isinstance(cmd, list) or not cmd or not all(isinstance(a, str) for a in cmd):
        raise ValueError("POCKET3D_WORKER_CMD must be a non-empty list of strings")
    return cmd


def parse_address_list(raw: str) -> list[str]:
    return [p for p in (s.strip() for s in raw.replace(",", " ").split()) if p]


def load_config(overrides: dict | None = None, env: dict | None = None) -> Config:
    """Build the configuration from defaults, ``config.json``, the environment and overrides
    (``None`` values in ``overrides`` are ignored so argparse results can be passed directly)."""
    env = os.environ if env is None else env
    overrides = {k: v for k, v in (overrides or {}).items() if v is not None}
    cfg = Config()
    data_dir = overrides.get("data_dir") or env.get("POCKET3D_DATA") or cfg.data_dir
    cfg.data_dir = Path(data_dir)

    known = {f.name for f in fields(Config)} - {"data_dir", "limits"}
    file_path = Path(cfg.data_dir) / "config.json"
    if file_path.is_file():
        doc = json.loads(file_path.read_text(encoding="utf-8"))
        if not isinstance(doc, dict):
            raise ValueError("config.json must contain a JSON object")
        for k, v in doc.items():
            if k == "limits" and isinstance(v, dict):
                for lk, lv in v.items():
                    if lk in {f.name for f in fields(Limits)} and lk != "formats":
                        setattr(cfg.limits, lk, int(lv))
            elif k in known:
                setattr(cfg, k, v)
            else:
                raise ValueError(f"config.json: unknown key {k!r}")

    for var, (name, parser) in _ENV.items():
        if env.get(var):
            setattr(cfg, name, parser(env[var]))
    if env.get("POCKET3D_WORKER_CMD"):
        cfg.worker_cmd = parse_worker_cmd(env["POCKET3D_WORKER_CMD"])
    if env.get("POCKET3D_ADVERTISE"):
        cfg.advertise = parse_address_list(env["POCKET3D_ADVERTISE"])

    for k, v in overrides.items():
        if k == "data_dir":
            continue
        if k not in known:
            raise ValueError(f"unknown configuration key {k!r}")
        setattr(cfg, k, v)
    return cfg.finalize()
