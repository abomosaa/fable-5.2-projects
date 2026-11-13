"""HTTPS API of the companion (docs/companion-protocol.md §1–§3).

The server only ever listens; it makes no outbound connections. Everything except
``GET /v1/hello`` and ``POST /v1/pair`` requires a bearer token, and every session/job is
visible only to the device that created it.
"""
from __future__ import annotations

import asyncio
import fcntl
import json
import logging
import os
import socket
import sys
import time
import traceback
import uuid
from pathlib import Path
from typing import Any, Awaitable, Callable

from aiohttp import ClientPayloadError, web

from . import __version__
from .config import MIB, Config, cpu_model, cpu_threads, detect_lan_ipv4, memory_total_bytes
from .jobs import JobManager
from .security import (DeviceStore, PairingFailed, PairingLocked, PairingManager, certificate_fingerprint,
                       clean_device_name, ensure_certificate, make_ssl_context, pairing_banner, pairing_uri,
                       write_pairing_file)
from .storage import (ApiError, SessionStore, UUID4_RE, UUID_RE, atomic_write_json, bad_request, dir_size,
                      read_json, remove_stale_tmp, strict_loads)

log = logging.getLogger("pocket3d.server")


class _NoRequestDataFilter(logging.Filter):
    """aiohttp quotes malformed request lines and headers in its error logs — text that can
    contain a bearer token. Keep the event, drop the quoted bytes and the traceback."""

    def filter(self, record: logging.LogRecord) -> bool:
        if record.exc_info:
            exc = record.exc_info[1]
            record.msg = f"{record.getMessage()} ({type(exc).__name__})"
            record.args = None
            record.exc_info = None
            record.exc_text = None
        return True


_http_log = logging.getLogger("pocket3d.http")     # handed to aiohttp instead of "aiohttp.server"
_http_log.addFilter(_NoRequestDataFilter())

API_VERSION = 1
PRODUCT = "pocket3d-companion"
_PUBLIC_PATHS = frozenset({"/v1/hello", "/v1/pair"})
DEVICE_ID = web.RequestKey("device_id", str)   # set by the auth middleware
_DOWNLOAD_CHUNK = 256 * 1024
_CONTENT_TYPES = {".glb": "model/gltf-binary", ".json": "application/json",
                  ".log": "text/plain; charset=utf-8", ".txt": "text/plain; charset=utf-8"}


def _json(data: Any, status: int = 200, headers: dict | None = None) -> web.Response:
    return web.Response(body=json.dumps(data, ensure_ascii=False, allow_nan=False).encode("utf-8"),
                        status=status, content_type="application/json", charset="utf-8", headers=headers)


def _error(status: int, code: str, message: str, extra: dict | None = None,
           headers: dict | None = None) -> web.Response:
    body = {"error": {"code": code, "message": message}}
    body.update(extra or {})
    return _json(body, status=status, headers=headers)


def _etag_matches(header: str | None, etag: str) -> bool:
    if not header:
        return False
    return any(part.strip().removeprefix("W/").strip('"') == etag.strip('"') or part.strip() == "*"
               for part in header.split(","))


class CompanionServer:
    def __init__(self, cfg: Config, announce: Callable[[str], None] | None = None):
        self.cfg = cfg
        self._announce = announce if announce is not None else self._print
        self.port = 0
        self.fingerprint = ""
        self.server_id = ""
        self.server_name = ""
        self.advertise: list[str] = []
        self.devices: DeviceStore
        self.sessions: SessionStore
        self.jobs: JobManager
        self.pairing: PairingManager
        self._runner: web.AppRunner | None = None
        self._site: web.TCPSite | None = None
        self._lock_fd: int | None = None
        self._timer: asyncio.Task | None = None
        self._background: set[asyncio.Task] = set()
        self._purge_lock = asyncio.Lock()
        self._started = False

    @staticmethod
    def _print(text: str) -> None:
        print(text, flush=True)

    # ======================================================================================
    # lifecycle
    # ======================================================================================
    @property
    def pairing_file(self) -> Path:
        return self.cfg.data_dir / "pairing.txt"

    @property
    def pid_file(self) -> Path:
        return self.cfg.data_dir / "server.pid"

    def current_pairing_uri(self) -> str:
        return pairing_uri(self.advertise, self.cfg.advertise_port or self.port, self.fingerprint,
                           self.pairing.code)

    def _acquire_lock(self) -> None:
        fd = os.open(self.cfg.data_dir / "server.lock", os.O_RDWR | os.O_CREAT, 0o600)
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError:
            os.close(fd)
            raise RuntimeError(f"another companion is already using the data directory {self.cfg.data_dir}") from None
        self._lock_fd = fd

    def _load_identity(self) -> None:
        path = self.cfg.data_dir / "server.json"
        doc: dict = {}
        if path.exists():
            doc = read_json(path)
        if not UUID_RE.match(str(doc.get("server_id", ""))):
            doc["server_id"] = str(uuid.uuid4())
        name = self.cfg.server_name or doc.get("name") or socket.gethostname() or "companion"
        name = clean_device_name(name) or "companion"
        if doc.get("name") != name or not path.exists():
            doc["name"] = name
            atomic_write_json(path, {"server_id": doc["server_id"], "name": name})
        self.server_id, self.server_name = doc["server_id"], name

    async def start(self) -> None:
        cfg = self.cfg
        cfg.data_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
        self._acquire_lock()
        try:
            remove_stale_tmp(cfg.data_dir)
            self._load_identity()
            self.advertise = list(cfg.advertise) or detect_lan_ipv4() or ["127.0.0.1"]
            cert, key = ensure_certificate(cfg.tls_dir, self.advertise)
            self.fingerprint = certificate_fingerprint(cert)
            ssl_ctx = make_ssl_context(cert, key)
            self.devices = DeviceStore(cfg.data_dir)
            self.sessions = SessionStore(cfg)
            self.sessions.load()
            self.jobs = JobManager(cfg, self.sessions)
            self.jobs.load()

            self._runner = web.AppRunner(self._build_app(), access_log=None, logger=_http_log,
                                         handle_signals=False,
                                         shutdown_timeout=1.0, keepalive_timeout=75,
                                         auto_decompress=False)
            await self._runner.setup()
            self._site = web.TCPSite(self._runner, cfg.host, cfg.port, ssl_context=ssl_ctx, reuse_address=True)
            await self._site.start()
            self.port = self._runner.addresses[0][1]
            self._started = True
            atomic_write_json(self.pid_file, {"pid": os.getpid(), "port": self.port, "started_at": time.time()})

            self.pairing = PairingManager(cfg.pairing_code_ttl_s, cfg.pairing_max_attempts, cfg.pairing_lock_s,
                                          on_rotate=self._on_pairing_rotate)
            self._timer = asyncio.get_running_loop().create_task(self._pairing_timer())
            self.jobs.start()
            self._spawn(self._process_purges())
            log.info("listening on https://%s:%d (data: %s; %d job(s) at a time, %d threads, %d MB per job)",
                     cfg.host, self.port, cfg.data_dir, cfg.max_parallel_jobs, cfg.job_threads, cfg.job_memory_mb)
        except BaseException:
            await self.stop()
            raise

    async def stop(self, *, abandon_workers: bool = False) -> None:
        """Stop serving. Running jobs become ``interrupted`` (their workers are terminated).
        ``abandon_workers=True`` imitates a killed companion instead and is only for tests."""
        if self._timer is not None:
            self._timer.cancel()
            self._timer = None
        if self._site is not None:
            await self._site.stop()
            self._site = None
        if getattr(self, "jobs", None) is not None:
            if abandon_workers:
                await self.jobs.abandon()
            else:
                await self.jobs.stop()
        for t in list(self._background):
            t.cancel()
        if self._background:
            await asyncio.gather(*self._background, return_exceptions=True)
        if self._runner is not None:
            await self._runner.cleanup()
            self._runner = None
        if self._started:
            for p in (self.pairing_file, self.pid_file):
                try:
                    os.unlink(p)
                except OSError:
                    pass
            self._started = False
        if self._lock_fd is not None:
            os.close(self._lock_fd)
            self._lock_fd = None

    def _spawn(self, coro: Awaitable) -> None:
        task = asyncio.get_running_loop().create_task(coro)   # type: ignore[arg-type]
        self._background.add(task)
        task.add_done_callback(self._background.discard)

    # -- pairing code announcements ----------------------------------------------------------
    def _on_pairing_rotate(self, code: str, reason: str) -> None:
        uri = pairing_uri(self.advertise, self.cfg.advertise_port or self.port, self.fingerprint, code)
        try:
            write_pairing_file(self.pairing_file, uri)
        except OSError as e:
            log.error("cannot write pairing.txt (%s)", type(e).__name__)
        self._announce(pairing_banner(uri, server_name=self.server_name,
                                      expires_in_s=self.cfg.pairing_code_ttl_s, qr_mode=self.cfg.qr))

    def rotate_pairing_code(self) -> None:
        """Replace the pairing code now (SIGUSR1 / ``pair --rotate``). Safe to call at any time."""
        if self._started and getattr(self, "pairing", None) is not None:
            self.pairing.rotate("requested")

    async def _pairing_timer(self) -> None:
        last_housekeeping = 0.0
        while True:
            await asyncio.sleep(min(self.pairing.seconds_until_expiry() + 0.01, 3600.0))
            self.pairing.expire_if_due()
            if time.time() - last_housekeeping >= 600.0:
                last_housekeeping = time.time()
                try:
                    await self.housekeeping()
                except Exception:      # housekeeping must never take the server down
                    log.exception("housekeeping failed")

    async def housekeeping(self, now: float | None = None) -> dict:
        """Remove data nobody can use any more (see Config.work_ttl_s / upload_ttl_s)."""
        now = time.time() if now is None else now
        freed_jobs = await self.jobs.purge_stale_work(now)
        stale = []
        in_use = {j.session_id for j in self.jobs.jobs.values() if not j.deleted}
        for s in list(self.sessions.sessions.values()):
            if not s.complete and s.session_id not in in_use and now - s.updated_at > self.cfg.upload_ttl_s:
                stale.append(s)
        for s in stale:
            await self._delete_session(s)
        if freed_jobs or stale:
            log.info("housekeeping: cleared work data of %d job(s), removed %d abandoned upload(s)",
                     len(freed_jobs), len(stale))
        return {"jobs": freed_jobs, "sessions": [s.session_id for s in stale]}

    # -- revoked devices whose data should be removed (``devices revoke --purge``) -----------
    async def _process_purges(self) -> None:
        async with self._purge_lock:
            for device_id in list(self.devices.purge_pending):
                for s in self.sessions.owned_by(device_id):
                    await self._delete_session(s)
                for j in self.jobs.owned_by(device_id):
                    await self.jobs.delete(j)
                self.devices.purge_done(device_id)
                log.info("removed all data of revoked device %s", device_id)

    async def _delete_session(self, s: Any) -> None:
        if s.deleted:
            return
        s.deleted = True                      # no new jobs or uploads from here on
        await self.jobs.delete_for_session(s.session_id)
        await self.sessions.delete(s)
        log.info("session %s deleted", s.session_id)

    # ======================================================================================
    # app
    # ======================================================================================
    def _build_app(self) -> web.Application:
        app = web.Application(middlewares=[self._mw_errors, self._mw_auth],
                              client_max_size=self.cfg.max_json_bytes)
        r = app.router
        r.add_get("/v1/hello", self.h_hello)
        r.add_post("/v1/pair", self.h_pair)
        r.add_get("/v1/status", self.h_status)
        r.add_get("/v1/sessions", self.h_sessions)
        r.add_put("/v1/sessions/{session_id}", self.h_session_put)
        r.add_get("/v1/sessions/{session_id}", self.h_session_get)
        r.add_delete("/v1/sessions/{session_id}", self.h_session_delete)
        r.add_put("/v1/sessions/{session_id}/files/{file_id}", self.h_file_put)
        r.add_get("/v1/jobs", self.h_jobs)
        r.add_put("/v1/jobs/{job_id}", self.h_job_put)
        r.add_get("/v1/jobs/{job_id}", self.h_job_get)
        r.add_delete("/v1/jobs/{job_id}", self.h_job_delete)
        r.add_post("/v1/jobs/{job_id}/cancel", self.h_job_cancel)
        r.add_post("/v1/jobs/{job_id}/retry", self.h_job_retry)
        r.add_get("/v1/jobs/{job_id}/artifacts/{name}", self.h_artifact)
        app.on_response_prepare.append(self._on_prepare)
        return app

    @staticmethod
    async def _on_prepare(request: web.Request, response: web.StreamResponse) -> None:
        response.headers["Server"] = PRODUCT
        response.headers.setdefault("Cache-Control", "no-store")

    @web.middleware
    async def _mw_errors(self, request: web.Request, handler: Any) -> web.StreamResponse:
        t0 = time.monotonic()
        try:
            response = await handler(request)
        except ApiError as e:
            response = _error(e.status, e.code, e.message, e.extra, e.headers)
        except web.HTTPException as e:
            if e.status < 400:
                raise
            code = {401: "unauthorized", 404: "not_found", 413: "limit_exceeded"}.get(
                e.status, "server_error" if e.status >= 500 else "bad_request")
            message = {404: "no such endpoint", 405: "method not allowed",
                       413: "the request body is too large"}.get(e.status, e.reason or "request rejected")
            headers = {"Allow": e.headers["Allow"]} if "Allow" in e.headers else None
            response = _error(e.status, code, message, headers=headers)
        except asyncio.CancelledError:
            raise
        except (ConnectionError, asyncio.IncompleteReadError, ClientPayloadError):
            # Ordinary on a phone (Wi-Fi lost mid-upload). Whatever was stored stays resumable;
            # this response usually cannot be delivered any more.
            log.debug("client went away during %s %s", request.method, self._route_name(request))
            response = _error(400, "bad_request", "the connection was lost while reading the request")
        except Exception as e:
            # Exception *messages* can quote request data (names, metadata); log only the type
            # and where it happened.
            log.error("unhandled %s in %s %s\n%s", type(e).__name__, request.method, self._route_name(request),
                      "".join(traceback.format_tb(e.__traceback__)).rstrip())
            response = _error(500, "server_error", "internal error")
        log.debug("%s %s -> %d (%.0f ms)", request.method, self._route_name(request), response.status,
                  (time.monotonic() - t0) * 1000)
        return response

    @staticmethod
    def _route_name(request: web.Request) -> str:
        resource = request.match_info.route.resource
        return resource.canonical if resource is not None else "<unmatched>"

    @web.middleware
    async def _mw_auth(self, request: web.Request, handler: Any) -> web.StreamResponse:
        if request.path in _PUBLIC_PATHS:
            return await handler(request)
        scheme, _, token = request.headers.get("Authorization", "").partition(" ")
        token = token.strip()
        if self.devices.refresh_if_changed() and self.devices.purge_pending:
            self._spawn(self._process_purges())
        device = self.devices.authenticate(token) if scheme.lower() == "bearer" and token else None
        if device is None:
            raise ApiError(401, "unauthorized", "missing or invalid bearer token",
                           headers={"WWW-Authenticate": "Bearer"})
        request[DEVICE_ID] = device["device_id"]
        self.devices.touch(device["device_id"])
        return await handler(request)

    async def _body(self, request: web.Request, max_bytes: int | None = None) -> Any:
        if max_bytes is not None and (request.content_length or 0) > max_bytes:
            raise ApiError(413, "limit_exceeded", "the request body is too large")
        try:                               # size is bounded by client_max_size → 413
            raw = await asyncio.wait_for(request.read(), self.cfg.upload_idle_timeout_s)
        except asyncio.TimeoutError:
            raise ApiError(408, "bad_request", "the request body did not arrive in time") from None
        if max_bytes is not None and len(raw) > max_bytes:
            raise ApiError(413, "limit_exceeded", "the request body is too large")
        try:
            return strict_loads(raw)
        except (ValueError, RecursionError):
            raise bad_request("the request body is not valid JSON") from None

    # ======================================================================================
    # handlers: hello / pair / status
    # ======================================================================================
    async def h_hello(self, request: web.Request) -> web.Response:
        return _json({"product": PRODUCT, "api": API_VERSION, "version": __version__,
                      "server_id": self.server_id, "server_name": self.server_name})

    async def h_pair(self, request: web.Request) -> web.Response:
        body = await self._body(request, max_bytes=self.cfg.max_pair_body_bytes)   # unauthenticated: keep it tiny
        if not isinstance(body, dict) or not isinstance(body.get("code"), str):
            raise bad_request("code is required")
        device_id = body.get("device_id")
        if device_id is not None and (not isinstance(device_id, str) or not UUID_RE.match(device_id)):
            raise bad_request("device_id must be a lower-case UUID")
        name = clean_device_name(body.get("device_name", ""))
        try:
            self.pairing.redeem(body["code"], source=request.remote or "")
        except PairingLocked as e:
            retry = max(1, int(e.retry_after + 0.999))
            raise ApiError(429, "pairing_locked",
                           f"too many pairing attempts from this device; try again in {retry} s",
                           extra={"retry_after": retry}, headers={"Retry-After": str(retry)}) from None
        except PairingFailed:
            log.warning("wrong pairing code from %s (%d wrong attempts since start)", request.remote,
                        self.pairing.failed_attempts)
            raise ApiError(403, "pairing_failed", "wrong or expired pairing code") from None
        # Keeping an existing identity needs proof of possession of its current token.
        scheme, _, old_token = request.headers.get("Authorization", "").partition(" ")
        holder = self.devices.authenticate(old_token.strip()) if scheme.lower() == "bearer" and old_token.strip() else None
        proven = holder is not None and device_id is not None and holder["device_id"] == device_id
        device_id, token = self.devices.register(name or "device", device_id, proven=proven)
        log.info("paired device %s", device_id)
        return _json({"token": token, "device_id": device_id, "server_id": self.server_id,
                      "server_name": self.server_name})

    async def h_status(self, request: web.Request) -> web.Response:
        cfg = self.cfg
        return _json({
            "version": __version__, "api": API_VERSION, "server_id": self.server_id,
            "server_name": self.server_name,
            "hardware": {"cpu_model": cpu_model(), "cpu_threads": cpu_threads(),
                         "mem_total_mb": memory_total_bytes() // MIB, "gpu": None},
            "resources": {"max_parallel_jobs": cfg.max_parallel_jobs, "job_threads": cfg.job_threads,
                          "job_memory_mb": cfg.job_memory_mb,
                          "disk_free_mb": self.sessions.free_bytes() // MIB},
            "queue": self.jobs.counts(),
            "limits": cfg.limits.to_json(),
            "presets": self.jobs.presets})

    # ======================================================================================
    # handlers: sessions
    # ======================================================================================
    async def h_sessions(self, request: web.Request) -> web.Response:
        owner = request[DEVICE_ID]
        loop = asyncio.get_running_loop()
        out = []
        for s in self.sessions.owned_by(owner):
            jobs = self.jobs.for_session(s.session_id)
            disk = await loop.run_in_executor(None, lambda s=s, jobs=jobs: dir_size(s.dir)
                                              + sum(dir_size(j.dir) for j in jobs))
            d = s.describe()
            out.append({"session_id": s.session_id, "name": s.name, "file_count": len(s.files),
                        "total_bytes": d["total_bytes"], "received_bytes": d["received_bytes"],
                        "complete": d["complete"], "created_at": s.created_at, "updated_at": s.updated_at,
                        "disk_bytes": disk, "jobs": [j.job_id for j in jobs]})
        return _json({"sessions": out})

    async def h_session_put(self, request: web.Request) -> web.Response:
        session_id = request.match_info["session_id"]
        if not UUID4_RE.match(session_id):
            raise bad_request("session_id must be a lower-case UUIDv4")
        body = await self._body(request)
        s, created = self.sessions.put_manifest(request[DEVICE_ID], session_id, body,
                                                self.jobs.session_has_active_job)
        if created:
            log.info("session %s created (%d files, %d bytes)", s.session_id, len(s.files), s.total_bytes)
        return _json(s.describe())

    async def h_session_get(self, request: web.Request) -> web.Response:
        s = self.sessions.get(request[DEVICE_ID], request.match_info["session_id"])
        return _json(s.describe())

    async def h_session_delete(self, request: web.Request) -> web.Response:
        s = self.sessions.get(request[DEVICE_ID], request.match_info["session_id"])
        await self._delete_session(s)
        return web.Response(status=204)

    async def h_file_put(self, request: web.Request) -> web.Response:
        s = self.sessions.get(request[DEVICE_ID], request.match_info["session_id"])
        raw_offset = request.headers.get("Upload-Offset", "0").strip()
        if not raw_offset.isascii() or not raw_offset.isdigit() or len(raw_offset) > 18:
            raise bad_request("Upload-Offset must be a non-negative integer")
        result = await self.sessions.receive(s, request.match_info["file_id"], int(raw_offset),
                                             request.content_length, request.content)
        return _json(result)

    # ======================================================================================
    # handlers: jobs
    # ======================================================================================
    async def h_jobs(self, request: web.Request) -> web.Response:
        session_id = request.query.get("session_id")
        if session_id is not None and not UUID4_RE.match(session_id):
            raise bad_request("session_id must be a lower-case UUIDv4")
        jobs = self.jobs.owned_by(request[DEVICE_ID], session_id)
        return _json({"jobs": [self.jobs.to_json(j) for j in jobs]})

    async def h_job_put(self, request: web.Request) -> web.Response:
        job_id = request.match_info["job_id"]
        if not UUID4_RE.match(job_id):
            raise bad_request("job_id must be a lower-case UUIDv4")
        body = await self._body(request)
        job, created = self.jobs.submit(request[DEVICE_ID], job_id, body)
        return _json(self.jobs.to_json(job), status=201 if created else 200)

    async def h_job_get(self, request: web.Request) -> web.Response:
        job = self.jobs.get(request[DEVICE_ID], request.match_info["job_id"])
        try:
            since = int(request.query.get("since", "0"))
            wait = float(request.query.get("wait", "0"))
        except ValueError:
            raise bad_request("since must be an integer and wait a number") from None
        if since < 0 or not (0 <= wait < float("inf")):
            raise bad_request("since and wait must not be negative")
        events, last_seq = await self.jobs.wait_events(job, since, wait)
        return _json({"job": self.jobs.to_json(job), "events": events, "last_seq": last_seq})

    async def h_job_cancel(self, request: web.Request) -> web.Response:
        job = self.jobs.get(request[DEVICE_ID], request.match_info["job_id"])
        self.jobs.cancel(job)
        return _json(self.jobs.to_json(job))

    async def h_job_retry(self, request: web.Request) -> web.Response:
        job = self.jobs.get(request[DEVICE_ID], request.match_info["job_id"])
        await self.jobs.retry(job)
        return _json(self.jobs.to_json(job))

    async def h_job_delete(self, request: web.Request) -> web.Response:
        job = self.jobs.get(request[DEVICE_ID], request.match_info["job_id"])
        await self.jobs.delete(job)
        return web.Response(status=204)

    async def h_artifact(self, request: web.Request) -> web.StreamResponse:
        job = self.jobs.get(request[DEVICE_ID], request.match_info["job_id"])
        path, meta = self.jobs.artifact_file(job, request.match_info["name"])
        try:
            f = open(path, "rb")
        except OSError:
            raise ApiError(404, "not_found", "artifact not found") from None
        try:
            size = os.fstat(f.fileno()).st_size
            # A stable validator exists only once the artifact is final and unchanged on disk.
            etag = f'"{meta["sha256"]}"' if meta is not None and meta["size"] == size else None
            headers = {"Accept-Ranges": "bytes",
                       "Content-Type": _CONTENT_TYPES.get(path.suffix.lower(), "application/octet-stream")}
            if etag:
                headers["ETag"] = etag
                if _etag_matches(request.headers.get("If-None-Match"), etag):
                    return web.Response(status=304, headers={"ETag": etag})
            try:
                rng = request.http_range
            except ValueError:
                raise ApiError(416, "bad_request", "unsupported Range header",
                               headers={"Content-Range": f"bytes */{size}"}) from None
            start, stop, status = 0, size, 200
            if_range = request.headers.get("If-Range")
            if (rng.start is not None or rng.stop is not None) and (
                    if_range is None or (etag is not None and _etag_matches(if_range, etag))):
                if rng.start is not None and rng.start < 0:      # bytes=-n (the last n bytes)
                    start, stop = max(0, size + rng.start), size
                else:
                    start = rng.start or 0
                    stop = size if rng.stop is None else min(rng.stop, size)
                if start >= size or start >= stop:
                    raise ApiError(416, "bad_request", "the requested range is not available",
                                   headers={"Content-Range": f"bytes */{size}"})
                status = 206
                headers["Content-Range"] = f"bytes {start}-{stop - 1}/{size}"
            headers["Content-Length"] = str(stop - start)
            response = web.StreamResponse(status=status, headers=headers)
            await response.prepare(request)
            f.seek(start)
            remaining = stop - start
            while remaining > 0:
                chunk = f.read(min(_DOWNLOAD_CHUNK, remaining))
                if not chunk:
                    break
                remaining -= len(chunk)
                await response.write(chunk)
            await response.write_eof()
            return response
        finally:
            f.close()


async def serve(cfg: Config) -> None:
    """Run the companion until SIGINT/SIGTERM. SIGUSR1 replaces the pairing code."""
    import signal
    server = CompanionServer(cfg)
    loop = asyncio.get_running_loop()
    stop = asyncio.Event()
    for sig in (signal.SIGINT, signal.SIGTERM):
        loop.add_signal_handler(sig, stop.set)
    loop.add_signal_handler(signal.SIGUSR1, server.rotate_pairing_code)   # before the pid file exists
    await server.start()
    try:
        await stop.wait()
    finally:
        log.info("shutting down")
        print("Stopping (running jobs are marked interrupted and can be retried) …", file=sys.stderr, flush=True)
        await server.stop()
