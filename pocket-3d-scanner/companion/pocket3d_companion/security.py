"""TLS certificate, bearer tokens, paired devices and the pairing-code lifecycle.

Secrets handling: bearer tokens are never stored (only their SHA-256), never logged, and are
compared in constant time. The pairing code exists only in memory, on the companion's own
terminal, and in ``<data>/pairing.txt`` (mode 0600) for wrapper scripts.
"""
from __future__ import annotations

import datetime as _dt
import fcntl
import hashlib
import hmac
import io
import ipaddress
import logging
import os
import secrets
import socket
import ssl
import time
import uuid
from contextlib import contextmanager
from pathlib import Path
from typing import Callable, Iterator
from urllib.parse import parse_qs, urlsplit

from .storage import UUID_RE, atomic_write_bytes, atomic_write_json, read_json

log = logging.getLogger("pocket3d.security")

PAIRING_ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ"
PAIRING_CODE_LENGTH = 8
MAX_DEVICE_NAME_CHARS = 64


# -- TLS -------------------------------------------------------------------------------------

def ensure_certificate(tls_dir: Path, extra_ips: list[str] | None = None) -> tuple[Path, Path]:
    """Create the self-signed EC P-256 certificate on first start; reuse it afterwards.

    The certificate is the companion's identity (clients pin its fingerprint), so an existing
    one is never replaced automatically.
    """
    tls_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
    cert_path, key_path = tls_dir / "cert.pem", tls_dir / "key.pem"
    if cert_path.exists() and key_path.exists():
        return cert_path, key_path

    from cryptography import x509
    from cryptography.hazmat.primitives import hashes, serialization
    from cryptography.hazmat.primitives.asymmetric import ec
    from cryptography.x509.oid import NameOID

    key = ec.generate_private_key(ec.SECP256R1())
    name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, "pocket3d-companion")])
    sans: list[x509.GeneralName] = [x509.DNSName("localhost")]
    host = socket.gethostname()
    if host and host != "localhost":
        try:
            sans.append(x509.DNSName(host))
        except Exception:
            pass
    seen = set()
    for ip in ["127.0.0.1", *(extra_ips or [])]:
        try:
            addr = ipaddress.ip_address(ip)
        except ValueError:
            continue
        if addr not in seen:
            seen.add(addr)
            sans.append(x509.IPAddress(addr))
    now = _dt.datetime.now(_dt.timezone.utc)
    cert = (x509.CertificateBuilder()
            .subject_name(name).issuer_name(name)
            .public_key(key.public_key())
            .serial_number(x509.random_serial_number())
            .not_valid_before(now - _dt.timedelta(days=1))
            .not_valid_after(now + _dt.timedelta(days=3650))
            .add_extension(x509.SubjectAlternativeName(sans), critical=False)
            .add_extension(x509.BasicConstraints(ca=False, path_length=None), critical=True)
            .sign(key, hashes.SHA256()))
    atomic_write_bytes(key_path, key.private_bytes(serialization.Encoding.PEM,
                                                   serialization.PrivateFormat.PKCS8,
                                                   serialization.NoEncryption()), mode=0o600)
    atomic_write_bytes(cert_path, cert.public_bytes(serialization.Encoding.PEM), mode=0o644)
    log.info("generated a new TLS certificate")
    return cert_path, key_path


def certificate_fingerprint(cert_path: Path) -> str:
    """SHA-256 of the certificate's DER encoding, lower-case hex (what clients pin)."""
    der = ssl.PEM_cert_to_DER_cert(Path(cert_path).read_text(encoding="ascii"))
    return hashlib.sha256(der).hexdigest()


def make_ssl_context(cert_path: Path, key_path: Path) -> ssl.SSLContext:
    ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    ctx.minimum_version = ssl.TLSVersion.TLSv1_2
    try:
        ctx.load_cert_chain(str(cert_path), str(key_path))
    except (ssl.SSLError, OSError) as e:
        raise RuntimeError(
            f"cannot load the TLS certificate in {Path(cert_path).parent} ({type(e).__name__}). "
            "To create a new identity delete that directory; every phone must then pair again."
        ) from None
    return ctx


# -- tokens and devices ----------------------------------------------------------------------

def new_token() -> str:
    return secrets.token_hex(32)   # 256 bits


def hash_token(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8", "surrogatepass")).hexdigest()


def clean_device_name(name: object) -> str:
    """Printable, bounded device name (it is shown on the companion's terminal)."""
    if not isinstance(name, str):
        return ""
    cleaned = "".join(ch for ch in name if ch.isprintable()).strip()
    return cleaned[:MAX_DEVICE_NAME_CHARS]


class DeviceStore:
    """``devices.json``: paired devices with the SHA-256 of their token.

    The CLI (``devices revoke``) may modify the file while the server runs, so every mutation
    happens under an exclusive file lock on a fresh copy, and the server re-reads the file
    whenever it changes on disk.
    """

    def __init__(self, data_dir: Path):
        self.path = Path(data_dir) / "devices.json"
        self._lock_path = Path(data_dir) / "devices.lock"
        self.devices: dict[str, dict] = {}
        self.purge_pending: list[str] = []
        self._stamp: tuple | None = None
        self.reload()

    # -- file handling -----------------------------------------------------------------------
    def _file_stamp(self) -> tuple | None:
        try:
            st = os.stat(self.path)
        except OSError:
            return None
        return (st.st_ino, st.st_mtime_ns, st.st_size)

    def reload(self) -> None:
        stamp = self._file_stamp()
        devices: dict[str, dict] = {}
        purge: list[str] = []
        if stamp is not None:
            doc = read_json(self.path)
            for d in doc.get("devices", []):
                if UUID_RE.match(str(d.get("device_id", ""))) and isinstance(d.get("token_sha256"), str):
                    devices[d["device_id"]] = {
                        "device_id": d["device_id"], "name": clean_device_name(d.get("name", "")),
                        "token_sha256": d["token_sha256"], "created_at": float(d.get("created_at", 0)),
                        "last_seen_at": float(d.get("last_seen_at", 0))}
            purge = [p for p in doc.get("purge_pending", []) if isinstance(p, str) and UUID_RE.match(p)]
        self.devices, self.purge_pending, self._stamp = devices, purge, stamp

    def refresh_if_changed(self) -> bool:
        """Pick up changes made by another process. Returns True if the file was re-read."""
        if self._file_stamp() == self._stamp:
            return False
        try:
            self.reload()
        except Exception as e:
            log.error("devices.json could not be re-read (%s); keeping the previous list", type(e).__name__)
            return False
        return True

    @contextmanager
    def _mutation(self) -> Iterator[None]:
        fd = os.open(self._lock_path, os.O_RDWR | os.O_CREAT, 0o600)
        try:
            fcntl.flock(fd, fcntl.LOCK_EX)
            self.reload()
            yield
            atomic_write_json(self.path, {"devices": list(self.devices.values()),
                                          "purge_pending": self.purge_pending})
            self._stamp = self._file_stamp()
        finally:
            os.close(fd)   # releases the lock

    # -- operations --------------------------------------------------------------------------
    def register(self, name: str, device_id: str | None = None, proven: bool = False) -> tuple[str, str]:
        """Pair a device: returns (device_id, token).

        A device keeps its identity (and therefore its sessions and jobs) across a re-pairing
        only when ``proven`` — the caller showed that device's current token. A pairing code
        alone never grants access to another device's data: without proof a fresh identity is
        issued, whatever ``device_id`` the client asked for."""
        token = new_token()
        now = time.time()
        with self._mutation():
            if device_id is None or not proven or device_id not in self.devices:
                device_id = str(uuid.uuid4())
            previous = self.devices.get(device_id)
            self.devices[device_id] = {
                "device_id": device_id, "name": clean_device_name(name), "token_sha256": hash_token(token),
                "created_at": previous["created_at"] if previous else now, "last_seen_at": now}
            if device_id in self.purge_pending:
                self.purge_pending.remove(device_id)
        return device_id, token

    def authenticate(self, token: str) -> dict | None:
        """Constant-time lookup of a bearer token; returns the device record or None."""
        digest = hash_token(token)
        found = None
        for d in self.devices.values():   # no early exit: timing must not depend on the match
            if hmac.compare_digest(d["token_sha256"], digest):
                found = d
        return found

    def touch(self, device_id: str, min_interval_s: float = 300.0) -> None:
        d = self.devices.get(device_id)
        now = time.time()
        if d is None or now - d["last_seen_at"] < min_interval_s:
            return
        with self._mutation():
            if device_id in self.devices:
                self.devices[device_id]["last_seen_at"] = now

    def revoke(self, device_id: str, purge: bool = False) -> bool:
        with self._mutation():
            existed = self.devices.pop(device_id, None) is not None
            if purge and device_id not in self.purge_pending:
                self.purge_pending.append(device_id)
        return existed

    def purge_done(self, device_id: str) -> None:
        with self._mutation():
            if device_id in self.purge_pending:
                self.purge_pending.remove(device_id)


# -- pairing ---------------------------------------------------------------------------------

class PairingFailed(Exception):
    pass


class PairingLocked(Exception):
    def __init__(self, retry_after: float):
        super().__init__("pairing is locked")
        self.retry_after = retry_after


def new_pairing_code() -> str:
    return "".join(secrets.choice(PAIRING_ALPHABET) for _ in range(PAIRING_CODE_LENGTH))


class PairingManager:
    """Single-use pairing code with expiry and rate limiting.

    * the code expires after ``ttl_s`` and is replaced (and announced) immediately;
    * a successful pairing consumes the code;
    * wrong attempts are rate limited **per source address**: ``max_attempts`` in a row, then one
      more every ``lock_s / max_attempts`` seconds (token bucket). A source that ran out is
      answered ``pairing_locked`` with the time until its next attempt — even for the right
      code, because checking first would defeat the limit;
    * a global bucket (``GLOBAL_BURST`` attempts, refilled at ``GLOBAL_RATE`` per second) bounds
      brute force from many addresses: at most a few hundred guesses per code lifetime against
      32^8 ≈ 10^12 codes.

    Wrong attempts never rotate the code and never lock other devices out: any host on the LAN
    could otherwise keep pairing unusable by sending five wrong codes a minute.
    """
    GLOBAL_BURST = 30
    GLOBAL_RATE = 0.5          # attempts per second
    MAX_SOURCES = 4096

    def __init__(self, ttl_s: float, max_attempts: int, lock_s: float,
                 on_rotate: Callable[[str, str], None] | None = None,
                 clock: Callable[[], float] = time.monotonic):
        self.ttl_s, self.max_attempts, self.lock_s = ttl_s, max(1, int(max_attempts)), lock_s
        self._on_rotate = on_rotate
        self._clock = clock
        self._buckets: dict[str, list[float]] = {}          # source -> [tokens, last_refill]
        self._global = [float(self.GLOBAL_BURST), clock()]
        self.failed_attempts = 0
        self.code = ""
        self.expires_at = 0.0
        self.rotate("start")

    def rotate(self, reason: str) -> None:
        self.code = new_pairing_code()
        self.expires_at = self._clock() + self.ttl_s
        if self._on_rotate is not None:
            self._on_rotate(self.code, reason)

    def seconds_until_expiry(self) -> float:
        return max(0.0, self.expires_at - self._clock())

    def expire_if_due(self) -> bool:
        if self._clock() >= self.expires_at:
            self.rotate("expired")
            return True
        return False

    @staticmethod
    def _take(bucket: list[float], capacity: float, rate: float, now: float) -> float:
        """Take one token; returns 0 on success, else the seconds until one is available."""
        bucket[0] = min(capacity, bucket[0] + max(0.0, now - bucket[1]) * rate)
        bucket[1] = now
        if bucket[0] >= 1.0:
            bucket[0] -= 1.0
            return 0.0
        return (1.0 - bucket[0]) / rate if rate > 0 else float("inf")

    def redeem(self, code: object, source: str = "") -> None:
        """Consume the pairing code or raise :class:`PairingFailed` / :class:`PairingLocked`."""
        now = self._clock()
        rate = self.max_attempts / self.lock_s if self.lock_s > 0 else float("inf")
        if source not in self._buckets and len(self._buckets) >= self.MAX_SOURCES:
            # forget sources whose bucket is full again; if none, new sources share one bucket
            for k in [k for k, b in self._buckets.items() if b[0] + (now - b[1]) * rate >= self.max_attempts]:
                del self._buckets[k]
            if len(self._buckets) >= self.MAX_SOURCES:
                source = "*overflow*"
        bucket = self._buckets.setdefault(source, [float(self.max_attempts), now])
        wait = self._take(bucket, self.max_attempts, rate, now)
        if wait > 0:
            raise PairingLocked(wait)
        wait = self._take(self._global, self.GLOBAL_BURST, self.GLOBAL_RATE, now)
        if wait > 0:
            bucket[0] += 1.0                      # the global limit, not this source, refused it
            raise PairingLocked(wait)
        self.expire_if_due()
        candidate = code.strip().upper() if isinstance(code, str) else ""
        if hmac.compare_digest(candidate.encode("utf-8", "replace"), self.code.encode()):
            bucket[0] = float(self.max_attempts)  # a successful pairing clears the source's record
            self.rotate("used")
            return
        self.failed_attempts += 1
        raise PairingFailed()


def pairing_uri(hosts: list[str], port: int, fingerprint: str, code: str) -> str:
    return f"pocket3d://pair?v=1&host={','.join(hosts)}&port={port}&fp={fingerprint}&code={code}"


def parse_pairing_uri(uri: str) -> dict:
    parts = urlsplit(uri.strip())
    q = {k: v[0] for k, v in parse_qs(parts.query).items()}
    return {"hosts": [h for h in q.get("host", "").split(",") if h], "port": int(q.get("port", "0")),
            "fingerprint": q.get("fp", ""), "code": q.get("code", "")}


def write_pairing_file(path: Path, uri: str) -> None:
    atomic_write_bytes(path, (uri + "\n").encode("ascii"), mode=0o600)


def _grouped(text: str, n: int = 4) -> str:
    return " ".join(text[i:i + n] for i in range(0, len(text), n))


def render_qr(data: str, mode: str = "dark") -> str:
    """Terminal QR code. ``mode`` is the terminal background: on a dark terminal the modules
    must be drawn inverted so the code has dark modules on a light field for the scanner."""
    if mode == "off":
        return ""
    try:
        import qrcode
        qr = qrcode.QRCode(border=2, error_correction=qrcode.constants.ERROR_CORRECT_L)
        qr.add_data(data)
        qr.make(fit=True)
        buf = io.StringIO()
        qr.print_ascii(out=buf, invert=(mode == "dark"))
        return buf.getvalue()
    except Exception as e:  # pragma: no cover - the text below is always sufficient to pair
        return f"(QR code unavailable: {type(e).__name__})\n"


def pairing_banner(uri: str, *, server_name: str = "", expires_in_s: float | None = None,
                   qr_mode: str = "dark") -> str:
    info = parse_pairing_uri(uri)
    lines = ["", "=" * 66, f" Pocket 3D Scanner companion{' — ' + server_name if server_name else ''}",
             " Pair a phone: scan this code in the app, or enter the details below.", "=" * 66]
    qr = render_qr(uri, qr_mode)
    if qr:
        lines.append(qr.rstrip("\n"))
    lines += [
        f"  Address      : {', '.join(info['hosts'])}   (Android emulator: 10.0.2.2)",
        f"  Port         : {info['port']}",
        f"  Fingerprint  : {_grouped(info['fingerprint'])}",
        f"  Pairing code : {_grouped(info['code'])}"
        + (f"   (single use, valid {int(round(expires_in_s / 60)) or 1} min)" if expires_in_s else ""),
        f"  {uri}",
        "=" * 66, ""]
    return "\n".join(lines)
