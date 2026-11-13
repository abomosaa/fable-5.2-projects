"""Shared fixtures: a real companion server on a random localhost port with real TLS, a client
that pins the certificate fingerprint (as the phone does), and small real images."""
from __future__ import annotations

import asyncio
import hashlib
import io
import json
import os
import random
import signal
import sys
import uuid
from pathlib import Path

import aiohttp
import psutil
import pytest
from PIL import Image

from pocket3d_companion.config import Config, Limits
from pocket3d_companion.security import parse_pairing_uri
from pocket3d_companion.server import CompanionServer

FAKE_WORKER_CMD = [sys.executable, "-m", "pocket3d_companion.fake_worker", "--job-dir", "{job_dir}"]
KIB = 1024
TERMINAL_STATES = {"succeeded", "failed", "cancelled", "interrupted"}


@pytest.fixture(autouse=True)
def _allow_fake_worker(monkeypatch):
    monkeypatch.setenv("POCKET3D_ALLOW_FAKE_WORKER", "1")


def make_config(data_dir: Path, **overrides) -> Config:
    limits = overrides.pop("limits", None) or Limits(
        max_images=20, min_images=3, max_image_bytes=512 * KIB, max_image_pixels=1_000_000,
        min_image_side=32, max_session_bytes=2048 * KIB)
    cfg = Config(data_dir=data_dir, host="127.0.0.1", port=0, advertise=["127.0.0.1"], qr="off",
                 worker_cmd=list(FAKE_WORKER_CMD), limits=limits, job_threads=2, job_memory_mb=512,
                 cancel_grace_s=2.0, watchdog_interval_s=0.1, event_poll_s=0.03, disk_reserve_mb=1,
                 upload_idle_timeout_s=5.0)
    for k, v in overrides.items():
        assert hasattr(cfg, k), k
        setattr(cfg, k, v)
    return cfg.finalize()


# -- images ----------------------------------------------------------------------------------

def make_image(fmt: str = "JPEG", size: tuple[int, int] = (96, 64), seed: int = 0) -> bytes:
    """A small real image with deterministic noise (so that every seed gives different bytes)."""
    im = Image.frombytes("RGB", size, random.Random(seed).randbytes(size[0] * size[1] * 3))
    buf = io.BytesIO()
    im.save(buf, format=fmt)
    return buf.getvalue()


def sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def manifest(blobs: dict[str, bytes], name: str = "Test object", capture: dict | None = None) -> dict:
    return {"name": name, "capture": capture if capture is not None else {"format": 1, "source": "import", "frames": []},
            "files": [{"id": fid, "name": f"IMG_{fid}.jpg", "size": len(b), "sha256": sha256(b)}
                      for fid, b in blobs.items()]}


@pytest.fixture(scope="session")
def photos() -> dict[str, bytes]:
    return {f"{i:04d}": make_image(seed=i) for i in range(1, 4)}


def new_id() -> str:
    return str(uuid.uuid4())


# -- client ----------------------------------------------------------------------------------

class Client:
    """HTTPS client that trusts exactly one certificate: the pinned SHA-256 fingerprint."""

    def __init__(self, port: int, fingerprint: str, token: str | None = None):
        self.base = f"https://127.0.0.1:{port}"
        self.token = token
        self.device_id: str | None = None
        self._session = aiohttp.ClientSession(
            connector=aiohttp.TCPConnector(ssl=aiohttp.Fingerprint(bytes.fromhex(fingerprint))),
            timeout=aiohttp.ClientTimeout(total=40))

    async def close(self) -> None:
        await self._session.close()

    def _headers(self, headers: dict | None, auth: bool) -> dict:
        h = dict(headers or {})
        if auth and self.token and "Authorization" not in h:
            h["Authorization"] = f"Bearer {self.token}"
        return h

    async def raw(self, method: str, path: str, *, auth: bool = True, headers: dict | None = None, **kw):
        """Returns (status, body bytes, headers). ``path`` is sent exactly as given."""
        from yarl import URL
        url = URL(self.base + path, encoded=True)
        async with self._session.request(method, url, headers=self._headers(headers, auth), **kw) as r:
            return r.status, await r.read(), r.headers

    async def call(self, method: str, path: str, **kw):
        """Returns (status, decoded JSON or None)."""
        status, body, _ = await self.raw(method, path, **kw)
        return status, (json.loads(body) if body else None)

    async def get(self, path: str, **kw):
        return await self.call("GET", path, **kw)

    async def put(self, path: str, body=None, **kw):
        return await self.call("PUT", path, json=body, **kw)

    async def post(self, path: str, body=None, **kw):
        return await self.call("POST", path, json=body, **kw)

    async def delete(self, path: str, **kw):
        return await self.call("DELETE", path, **kw)

    # -- protocol helpers --------------------------------------------------------------------
    async def upload(self, session_id: str, file_id: str, data: bytes, offset: int = 0, **kw):
        return await self.call("PUT", f"/v1/sessions/{session_id}/files/{file_id}", data=data,
                               headers={"Upload-Offset": str(offset), "Content-Type": "application/octet-stream"},
                               **kw)

    async def create_session(self, blobs: dict[str, bytes], upload: bool = True, session_id: str | None = None,
                             **mf) -> str:
        sid = session_id or new_id()
        status, body = await self.put(f"/v1/sessions/{sid}", manifest(blobs, **mf))
        assert status == 200, body
        if upload:
            for fid, data in blobs.items():
                status, body = await self.upload(sid, fid, data)
                assert status == 200 and body["complete"] is True, body
        return sid

    async def submit(self, session_id: str, test: dict | None = None, preset: str = "preview",
                     job_id: str | None = None, expect: int = 201) -> str:
        jid = job_id or new_id()
        settings = {"_test": test} if test is not None else {}
        status, body = await self.put(f"/v1/jobs/{jid}", {"session_id": session_id, "preset": preset,
                                                          "settings": settings})
        assert status == expect, body
        return jid

    async def job(self, job_id: str) -> dict:
        status, body = await self.get(f"/v1/jobs/{job_id}")
        assert status == 200, body
        return body["job"]

    async def wait_job(self, job_id: str, states, timeout: float = 15.0) -> dict:
        """Long-poll until the job reaches one of ``states``."""
        states = {states} if isinstance(states, str) else set(states)
        loop = asyncio.get_running_loop()
        deadline = loop.time() + timeout
        since = 0
        while True:
            status, body = await self.get(f"/v1/jobs/{job_id}?since={since}&wait=1")
            assert status == 200, body
            since = body["last_seq"]
            state = body["job"]["state"]
            if state in states:
                return body["job"]
            assert state not in TERMINAL_STATES, f"job ended as {state}, expected {states}: {body['job']}"
            assert loop.time() < deadline, f"job stuck in {state}: {body['job']}"
            if not body["events"]:
                await asyncio.sleep(0.02)

    async def all_events(self, job_id: str) -> list[dict]:
        status, body = await self.get(f"/v1/jobs/{job_id}?since=0")
        assert status == 200
        return body["events"]


# -- server harness --------------------------------------------------------------------------

class Harness:
    def __init__(self, data_dir: Path):
        self.data_dir = data_dir
        self.server: CompanionServer | None = None
        self.banners: list[str] = []
        self._clients: list[Client] = []
        self._servers: list[CompanionServer] = []

    async def start(self, **overrides) -> CompanionServer:
        server = CompanionServer(make_config(self.data_dir, **overrides), announce=self.banners.append)
        await server.start()
        self.server = server
        self._servers.append(server)
        return server

    async def stop(self, **kw) -> None:
        for c in self._clients:        # like a phone losing its connection
            await c.close()
        self._clients.clear()
        if self.server is not None:
            await self.server.stop(**kw)
            self.server = None

    async def restart(self, *, crash: bool = False, **overrides) -> CompanionServer:
        await self.stop(abandon_workers=crash)
        return await self.start(**overrides)

    def pairing(self) -> dict:
        """What a wrapper script / the QR code provides."""
        return parse_pairing_uri((self.data_dir / "pairing.txt").read_text())

    def client(self, token: str | None = None) -> Client:
        info = self.pairing()
        c = Client(info["port"], info["fingerprint"], token)
        self._clients.append(c)
        return c

    async def paired(self, name: str = "Pixel Test", device_id: str | None = None,
                     proof_token: str | None = None) -> Client:
        """Pair a new client. `proof_token` = the current token of `device_id` (keeps the identity)."""
        c = self.client()
        body = {"code": self.pairing()["code"], "device_name": name}
        if device_id:
            body["device_id"] = device_id
        kw = {"headers": {"Authorization": f"Bearer {proof_token}"}} if proof_token else {}
        status, resp = await c.post("/v1/pair", body, auth=False, **kw)
        assert status == 200, resp
        c.token, c.device_id = resp["token"], resp["device_id"]
        return c

    def job_dir(self, job_id: str) -> Path:
        return self.data_dir / "jobs" / job_id

    def session_dir(self, session_id: str) -> Path:
        return self.data_dir / "sessions" / session_id

    def worker_pids(self) -> list[int]:
        """Pids recorded by fake workers of all jobs (worker + its child, if any)."""
        pids = []
        for f in (self.data_dir / "jobs").glob("*/work/*.pid"):
            try:
                pids.append(int(f.read_text()))
            except ValueError:
                pass
        return pids

    async def cleanup(self) -> None:
        await self.stop()
        for pid in self.worker_pids():     # abandoned by a simulated crash
            try:
                os.kill(pid, signal.SIGKILL)
            except OSError:
                pass


def pid_alive(pid: int) -> bool:
    try:
        return psutil.Process(pid).status() != psutil.STATUS_ZOMBIE
    except psutil.Error:
        return False


async def wait_until(predicate, timeout: float = 10.0, interval: float = 0.02):
    loop = asyncio.get_running_loop()
    deadline = loop.time() + timeout
    while True:
        value = predicate()
        if asyncio.iscoroutine(value):
            value = await value
        if value:
            return value
        assert loop.time() < deadline, "condition not reached in time"
        await asyncio.sleep(interval)


@pytest.fixture
async def harness(tmp_path):
    h = Harness(tmp_path / "data")
    try:
        yield h
    finally:
        await h.cleanup()


@pytest.fixture
async def server(harness):
    return await harness.start()


@pytest.fixture
async def client(harness, server):
    return await harness.paired()
