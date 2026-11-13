"""Capture sessions on disk: manifests, resumable streaming uploads, validation.

Layout (``<data>/sessions/<session_id>/``)::

    session.json          manifest + per-file completion state (atomic writes)
    capture.json          capture metadata exactly as sent by the phone
    originals/<id>.bin    photograph bytes; the name is derived from the validated file id,
                          never from the client-supplied file name

The number of bytes received for a file is always the size of its ``.bin`` on disk — it is
never read from a stored counter, so partial uploads survive restarts and crashes.
"""
from __future__ import annotations

import asyncio
import errno
import hashlib
import json
import logging
import os
import re
import secrets
import shutil
import stat
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable

from .config import Config
from .imagecheck import ImageRejected, validate_image

log = logging.getLogger("pocket3d.storage")

UUID4_RE = re.compile(r"\A[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\Z")
UUID_RE = re.compile(r"\A[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\Z")
# ids become file names (<id>.bin): no leading "-" (would look like an option to tools), and \Z
# instead of $ because $ also matches before a trailing newline.
FILE_ID_RE = re.compile(r"\A[A-Za-z0-9][A-Za-z0-9_-]{0,31}\Z")
SHA256_RE = re.compile(r"\A[0-9a-f]{64}\Z")

MAX_NAME_CHARS = 200
MAX_FILE_NAME_CHARS = 255
_CHUNK = 1024 * 1024


class ApiError(Exception):
    """An error that maps directly onto the protocol's error format (§2)."""

    def __init__(self, status: int, code: str, message: str, extra: dict | None = None,
                 headers: dict | None = None):
        super().__init__(message)
        self.status = status
        self.code = code
        self.message = message
        self.extra = extra or {}
        self.headers = headers or {}


def bad_request(message: str) -> ApiError:
    return ApiError(400, "bad_request", message)


def not_found(what: str = "resource") -> ApiError:
    return ApiError(404, "not_found", f"{what} not found")


# -- JSON helpers ----------------------------------------------------------------------------

def _reject_constant(name: str) -> Any:
    raise ValueError(f"non-finite number {name} is not valid JSON")


def _check_tree(obj: Any, depth: int = 0) -> None:
    """Reject values that parse but cannot be stored or sent back as valid JSON/UTF-8:
    floats that overflowed to infinity (``1e400``), lone UTF-16 surrogates in strings, and
    absurd nesting."""
    if depth > 64:
        raise ValueError("JSON is nested too deeply")
    if isinstance(obj, float):
        if obj != obj or obj in (float("inf"), float("-inf")):
            raise ValueError("non-finite number is not valid JSON")
    elif isinstance(obj, str):
        try:
            obj.encode("utf-8")
        except UnicodeEncodeError:
            raise ValueError("string contains an unpaired surrogate") from None
    elif isinstance(obj, dict):
        for k, v in obj.items():
            _check_tree(k, depth + 1)
            _check_tree(v, depth + 1)
    elif isinstance(obj, list):
        for v in obj:
            _check_tree(v, depth + 1)


def strict_loads(data: bytes | str) -> Any:
    """``json.loads`` that rejects everything we could not write back as valid JSON: NaN /
    Infinity literals, numbers that overflow to infinity, unpaired surrogates."""
    if isinstance(data, bytes):
        data = data.decode("utf-8")
    try:
        obj = json.loads(data, parse_constant=_reject_constant)
    except RecursionError:
        raise ValueError("JSON is nested too deeply") from None
    _check_tree(obj)
    return obj


def read_json(path: Path) -> Any:
    return strict_loads(Path(path).read_bytes())


def atomic_write_bytes(path: Path, data: bytes, mode: int = 0o600) -> None:
    """Write ``data`` to ``path`` atomically: temp file in the same directory, fsync, rename,
    fsync of the directory. Readers see either the old or the new content, never a mix."""
    path = Path(path)
    tmp = path.with_name(f".{path.name}.{secrets.token_hex(6)}.tmp")
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL, mode)
    try:
        with os.fdopen(fd, "wb") as f:
            f.write(data)
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp, path)
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise
    try:
        dfd = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(dfd)
        finally:
            os.close(dfd)
    except OSError:
        pass


def atomic_write_json(path: Path, obj: Any, mode: int = 0o600) -> None:
    data = json.dumps(obj, ensure_ascii=False, allow_nan=False, separators=(",", ":")).encode("utf-8")
    atomic_write_bytes(path, data, mode)


def remove_stale_tmp(directory: Path) -> None:
    """Delete leftovers of interrupted atomic writes."""
    try:
        for p in directory.iterdir():
            if p.name.startswith(".") and p.name.endswith(".tmp"):
                try:
                    p.unlink()
                except OSError:
                    pass
    except OSError:
        pass


def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        while True:
            chunk = f.read(_CHUNK)
            if not chunk:
                break
            h.update(chunk)
    return h.hexdigest()


def dir_size(path: Path) -> int:
    """Total size of regular files below ``path`` (symlinks are not followed)."""
    total = 0
    stack = [str(path)]
    while stack:
        try:
            with os.scandir(stack.pop()) as it:
                for e in it:
                    try:
                        if e.is_dir(follow_symlinks=False):
                            stack.append(e.path)
                        elif e.is_file(follow_symlinks=False):
                            total += e.stat(follow_symlinks=False).st_size
                    except OSError:
                        pass
        except OSError:
            pass
    return total


def _file_size(path: Path) -> int:
    try:
        st = os.lstat(path)
    except OSError:
        return 0
    return st.st_size if stat.S_ISREG(st.st_mode) else 0


def _unlink(path: Path) -> None:
    try:
        os.unlink(path)
    except FileNotFoundError:
        pass


# -- model -----------------------------------------------------------------------------------

@dataclass
class FileEntry:
    id: str
    name: str
    size: int
    sha256: str
    complete: bool = False
    error: str | None = None
    image: dict | None = None
    # runtime only (not persisted)
    upload_token: object | None = field(default=None, repr=False, compare=False)
    hasher: Any = field(default=None, repr=False, compare=False)
    hasher_offset: int = field(default=0, repr=False, compare=False)

    def persisted(self) -> dict:
        return {"id": self.id, "name": self.name, "size": self.size, "sha256": self.sha256,
                "complete": self.complete, "error": self.error, "image": self.image}


@dataclass
class Session:
    session_id: str
    owner: str
    name: str
    created_at: float
    updated_at: float
    dir: Path
    files: dict[str, FileEntry] = field(default_factory=dict)
    revision: str = ""
    deleted: bool = False

    @property
    def originals_dir(self) -> Path:
        return self.dir / "originals"

    @property
    def capture_path(self) -> Path:
        return self.dir / "capture.json"

    def file_path(self, entry: FileEntry) -> Path:
        # entry.id was validated against FILE_ID_RE when the manifest was accepted/loaded.
        return self.originals_dir / f"{entry.id}.bin"

    def received(self, entry: FileEntry) -> int:
        return min(_file_size(self.file_path(entry)), entry.size)

    @property
    def total_bytes(self) -> int:
        return sum(f.size for f in self.files.values())

    @property
    def complete(self) -> bool:
        return bool(self.files) and all(f.complete for f in self.files.values())

    def persisted(self) -> dict:
        return {"session_id": self.session_id, "owner": self.owner, "name": self.name,
                "created_at": self.created_at, "updated_at": self.updated_at,
                "revision": self.revision, "files": [f.persisted() for f in self.files.values()]}

    def describe(self) -> dict:
        files = []
        received_total = 0
        for f in self.files.values():
            r = f.size if f.complete else self.received(f)
            received_total += r
            files.append({"id": f.id, "size": f.size, "received": r, "complete": f.complete,
                          "error": f.error})
        return {"session_id": self.session_id, "name": self.name, "created_at": self.created_at,
                "updated_at": self.updated_at, "total_bytes": self.total_bytes,
                "received_bytes": received_total, "complete": self.complete, "files": files}


def _revision(files: list[dict], capture: Any) -> str:
    blob = json.dumps({"files": [[f["id"], f["size"], f["sha256"]] for f in files], "capture": capture},
                      sort_keys=True, separators=(",", ":"), ensure_ascii=True)
    return hashlib.sha256(blob.encode()).hexdigest()


def parse_manifest(body: Any, cfg: Config) -> tuple[str, dict, list[dict]]:
    """Validate a ``PUT /v1/sessions/{id}`` body. Returns (name, capture, files)."""
    lim = cfg.limits
    if not isinstance(body, dict):
        raise bad_request("body must be a JSON object")
    name = body.get("name", "")
    if not isinstance(name, str) or len(name) > MAX_NAME_CHARS:
        raise bad_request(f"name must be a string of at most {MAX_NAME_CHARS} characters")
    capture = body.get("capture", {})
    if capture is None:
        capture = {}
    if not isinstance(capture, dict):
        raise bad_request("capture must be a JSON object")
    if "frames" in capture and not isinstance(capture["frames"], list):
        raise bad_request("capture.frames must be an array")
    raw_files = body.get("files")
    if not isinstance(raw_files, list):
        raise bad_request("files must be an array")
    if len(raw_files) > lim.max_images:
        raise ApiError(422, "limit_exceeded", f"a session may contain at most {lim.max_images} images")
    if len(raw_files) < lim.min_images:
        raise ApiError(422, "limit_exceeded", f"a session needs at least {lim.min_images} images")
    files: list[dict] = []
    seen: set[str] = set()
    total = 0
    for i, rf in enumerate(raw_files):
        if not isinstance(rf, dict):
            raise bad_request(f"files[{i}] must be an object")
        fid = rf.get("id")
        if not isinstance(fid, str) or not FILE_ID_RE.match(fid):
            raise bad_request(f"files[{i}].id must match ^[A-Za-z0-9_-]{{1,32}}$")
        if fid in seen:
            raise bad_request(f"files[{i}].id is not unique")
        seen.add(fid)
        fname = rf.get("name", "")
        if not isinstance(fname, str) or len(fname) > MAX_FILE_NAME_CHARS:
            raise bad_request(f"files[{i}].name must be a string of at most {MAX_FILE_NAME_CHARS} characters")
        size = rf.get("size")
        if isinstance(size, bool) or not isinstance(size, int) or size < 1:
            raise bad_request(f"files[{i}].size must be a positive integer")
        if size > lim.max_image_bytes:
            raise ApiError(413, "limit_exceeded",
                           f"files[{i}] is larger than the per-image limit of {lim.max_image_bytes} bytes")
        digest = rf.get("sha256")
        if not isinstance(digest, str) or not SHA256_RE.match(digest.lower()):
            raise bad_request(f"files[{i}].sha256 must be 64 hex characters")
        total += size
        files.append({"id": fid, "name": fname, "size": size, "sha256": digest.lower()})
    if total > lim.max_session_bytes:
        raise ApiError(413, "limit_exceeded",
                       f"the session is larger than the limit of {lim.max_session_bytes} bytes")
    return name, capture, files


class SessionStore:
    def __init__(self, cfg: Config):
        self.cfg = cfg
        self.root = cfg.sessions_dir
        self.sessions: dict[str, Session] = {}

    # -- startup -----------------------------------------------------------------------------
    def load(self) -> None:
        """Load all sessions and reconcile them with the bytes actually on disk."""
        self.root.mkdir(parents=True, exist_ok=True, mode=0o700)
        for d in sorted(self.root.iterdir()):
            if not d.is_dir() or d.is_symlink() or not UUID4_RE.match(d.name):
                continue
            remove_stale_tmp(d)
            try:
                s = self._load_one(d)
            except Exception as e:  # corrupt/foreign directory: leave it alone, do not serve it
                log.warning("ignoring unreadable session directory %s (%s)", d.name, type(e).__name__)
                continue
            self.sessions[s.session_id] = s
        log.info("loaded %d session(s)", len(self.sessions))

    def _load_one(self, d: Path) -> Session:
        doc = read_json(d / "session.json")
        if doc.get("session_id") != d.name or not UUID_RE.match(str(doc.get("owner", ""))):
            raise ValueError("session.json does not belong to this directory")
        s = Session(session_id=d.name, owner=doc["owner"], name=str(doc.get("name", "")),
                    created_at=float(doc["created_at"]), updated_at=float(doc["updated_at"]),
                    dir=d, revision=str(doc.get("revision", "")))
        for rf in doc["files"]:
            if not FILE_ID_RE.match(rf["id"]) or not SHA256_RE.match(rf["sha256"]) or rf["id"] in s.files:
                raise ValueError("invalid file entry")
            err = rf.get("error")
            s.files[rf["id"]] = FileEntry(id=rf["id"], name=str(rf.get("name", "")), size=int(rf["size"]),
                                          sha256=rf["sha256"], complete=bool(rf.get("complete")),
                                          error=err if isinstance(err, str) else None,
                                          image=rf.get("image") if isinstance(rf.get("image"), dict) else None)
        s.originals_dir.mkdir(exist_ok=True, mode=0o700)
        changed = False
        known = {f"{fid}.bin" for fid in s.files}
        for p in s.originals_dir.iterdir():   # bytes of files no longer in the manifest
            if p.name not in known:
                if p.is_dir() and not p.is_symlink():
                    shutil.rmtree(p, ignore_errors=True)
                else:
                    _unlink(p)
        for f in s.files.values():
            path = s.file_path(f)
            on_disk = _file_size(path)
            if path.is_symlink() or on_disk > f.size or (f.complete and on_disk != f.size):
                # Not what we wrote: start this file over.
                _unlink(path)
                f.complete, f.image, on_disk = False, None, 0
                changed = True
            if not f.complete and f.error is None and on_disk == f.size:
                # All bytes arrived but the companion stopped before verifying them.
                changed = True
                self._verify_sync(s, f)
        if changed:
            atomic_write_json(d / "session.json", s.persisted())
        return s

    def _verify_sync(self, s: Session, f: FileEntry) -> None:
        path = s.file_path(f)
        if sha256_file(path) != f.sha256:
            _unlink(path)
            return
        try:
            f.image = validate_image(path, max_pixels=self.cfg.limits.max_image_pixels,
                                     min_side=self.cfg.limits.min_image_side)
            f.complete = True
        except ImageRejected as e:
            _unlink(path)
            f.error = f"unsupported_format: {e}"

    # -- queries -----------------------------------------------------------------------------
    def get(self, owner: str, session_id: str) -> Session:
        if not isinstance(session_id, str) or not UUID4_RE.match(session_id):
            raise bad_request("session_id must be a lower-case UUIDv4")
        s = self.sessions.get(session_id)
        if s is None or s.deleted or s.owner != owner:
            raise not_found("session")
        return s

    def owned_by(self, owner: str) -> list[Session]:
        return sorted((s for s in self.sessions.values() if s.owner == owner and not s.deleted),
                      key=lambda s: (s.created_at, s.session_id))

    def free_bytes(self) -> int:
        try:
            return shutil.disk_usage(self.cfg.data_dir).free
        except OSError:
            return 0

    def _require_space(self, need: int) -> None:
        if need > 0 and self.free_bytes() - need < self.cfg.disk_reserve_mb * 1024 * 1024:
            raise ApiError(507, "insufficient_storage",
                           "not enough free disk space on the companion for this upload")

    def _persist(self, s: Session) -> None:
        atomic_write_json(s.dir / "session.json", s.persisted())

    # -- manifest ----------------------------------------------------------------------------
    def put_manifest(self, owner: str, session_id: str, body: Any,
                     has_active_job: Callable[[str], bool]) -> tuple[Session, bool]:
        """Create or update a session. Returns (session, created)."""
        if not UUID4_RE.match(session_id):
            raise bad_request("session_id must be a lower-case UUIDv4")
        name, capture, files = parse_manifest(body, self.cfg)
        revision = _revision(files, capture)
        s = self.sessions.get(session_id)
        if s is not None and s.owner != owner:
            raise not_found("session")
        if s is not None and s.deleted:
            raise ApiError(409, "conflict", "a session with this id is still being deleted; try again")
        now = time.time()

        if s is None:
            self._require_space(sum(f["size"] for f in files))
            d = self.root / session_id          # session_id is a validated UUID
            d.mkdir(parents=True, exist_ok=True, mode=0o700)
            (d / "originals").mkdir(exist_ok=True, mode=0o700)
            s = Session(session_id=session_id, owner=owner, name=name, created_at=now, updated_at=now,
                        dir=d, revision=revision)
            for f in files:
                s.files[f["id"]] = FileEntry(**f)
                _unlink(s.file_path(s.files[f["id"]]))   # never adopt bytes we did not account for
            atomic_write_json(s.capture_path, capture)
            self._persist(s)
            self.sessions[session_id] = s
            return s, True

        if revision == s.revision:
            # Same photographs and metadata: only display names may change.
            dirty = s.name != name
            s.name = name
            for f in files:
                if s.files[f["id"]].name != f["name"]:
                    s.files[f["id"]].name = f["name"]
                    dirty = True
            if dirty:
                s.updated_at = now
                self._persist(s)
            return s, False

        if has_active_job(session_id):
            raise ApiError(409, "conflict",
                           "the session is in use by a queued or running job and cannot be changed")
        kept: dict[str, FileEntry] = {}
        need = 0
        for f in files:
            old = s.files.get(f["id"])
            if old is not None and old.size == f["size"] and old.sha256 == f["sha256"]:
                kept[f["id"]] = old
                need += f["size"] - (f["size"] if old.complete else s.received(old))
            else:
                need += f["size"]
        self._require_space(need)

        # Remove bytes first, then publish the new manifest: a crash in between leaves files
        # that merely look incomplete, never stale bytes under a new checksum.
        for fid, old in s.files.items():
            if fid not in kept:
                old.upload_token = None          # aborts an upload still streaming into it
                _unlink(s.file_path(old))
        new_files: dict[str, FileEntry] = {}
        for f in files:
            entry = kept.get(f["id"])
            if entry is None:
                entry = FileEntry(**f)
            else:
                entry.name = f["name"]
            new_files[f["id"]] = entry
        s.files = new_files
        s.name = name
        s.revision = revision
        s.updated_at = now
        atomic_write_json(s.capture_path, capture)
        self._persist(s)
        return s, False

    # -- uploads -----------------------------------------------------------------------------
    async def receive(self, s: Session, file_id: str, offset: int, content_length: int | None,
                      content: Any) -> dict:
        """Append the request body to a file at ``offset``; verify and validate on completion.

        ``content`` is the aiohttp request stream; it is consumed chunk by chunk and written
        straight to disk.
        """
        if not FILE_ID_RE.match(file_id):
            raise bad_request("file_id must match ^[A-Za-z0-9_-]{1,32}$")
        entry = s.files.get(file_id)
        if entry is None:
            raise not_found("file")
        path = s.file_path(entry)
        received = entry.size if entry.complete else s.received(entry)
        if offset != received:
            raise ApiError(409, "offset_mismatch",
                           f"Upload-Offset does not match the {received} bytes already stored",
                           extra={"received": received})
        remaining = entry.size - offset
        if content_length is not None and content_length > remaining:
            raise ApiError(413, "limit_exceeded", "the body is larger than the declared file size")
        if not entry.complete:
            self._require_space(remaining if content_length is None else content_length)

        token = object()
        entry.upload_token = token   # a newer request for the same file takes over

        def still_current() -> bool:
            return not s.deleted and s.files.get(file_id) is entry and entry.upload_token is token

        if entry.hasher is None or entry.hasher_offset != offset:
            entry.hasher = hashlib.sha256() if offset == 0 else None
            entry.hasher_offset = offset
        written = 0
        fobj = None
        loop = asyncio.get_running_loop()
        try:
            while True:
                try:
                    chunk = await asyncio.wait_for(content.readany(), self.cfg.upload_idle_timeout_s)
                except asyncio.TimeoutError:
                    raise ApiError(408, "bad_request", "upload stalled") from None
                if not chunk:
                    break
                if not still_current():
                    raise ApiError(409, "conflict", "the upload was superseded by another request")
                if offset + written + len(chunk) > entry.size:
                    # More bytes than declared: discard everything this request sent.
                    if fobj is not None:
                        fobj.close()
                        fobj = None
                    if offset == 0:
                        _unlink(path)
                    elif not entry.complete:
                        os.truncate(path, offset)
                    entry.hasher = None
                    raise ApiError(413, "limit_exceeded", "the body is larger than the declared file size")
                if fobj is None:
                    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_APPEND | os.O_NOFOLLOW, 0o600)
                    fobj = os.fdopen(fd, "ab", buffering=0)
                    entry.error = None
                try:
                    _write_all(fobj, chunk)
                except OSError as e:
                    entry.hasher = None      # disk content no longer matches the running hash
                    if e.errno in (errno.ENOSPC, errno.EDQUOT):
                        raise ApiError(507, "insufficient_storage",
                                       "the companion ran out of disk space") from None
                    raise
                written += len(chunk)
                if entry.hasher is not None:
                    entry.hasher.update(chunk)
                    entry.hasher_offset = offset + written
        finally:
            if fobj is not None:
                fobj.close()

        received = offset + written
        if entry.complete or received < entry.size:
            return {"id": entry.id, "received": received, "complete": entry.complete}

        # Last byte arrived: verify checksum, then that it really is a usable photograph.
        if entry.hasher is not None and entry.hasher_offset == entry.size:
            digest = entry.hasher.hexdigest()
        else:
            digest = await loop.run_in_executor(None, sha256_file, path)
        entry.hasher = None
        if not still_current():
            raise ApiError(409, "conflict", "the upload was superseded by another request")
        if digest != entry.sha256:
            _unlink(path)
            raise ApiError(422, "checksum_mismatch",
                           "SHA-256 of the received bytes does not match the manifest; upload the file again",
                           extra={"received": 0})
        try:
            info = await loop.run_in_executor(None, _fsync_and_validate, path,
                                              self.cfg.limits.max_image_pixels,
                                              self.cfg.limits.min_image_side)
        except ImageRejected as e:
            if still_current():
                _unlink(path)
                entry.error = f"unsupported_format: {e}"
                s.updated_at = time.time()
                self._persist(s)
            raise ApiError(422, "unsupported_format", str(e), extra={"received": 0}) from None
        if not still_current():
            raise ApiError(409, "conflict", "the upload was superseded by another request")
        entry.complete = True
        entry.error = None
        entry.image = info
        entry.upload_token = None
        s.updated_at = time.time()
        self._persist(s)
        return {"id": entry.id, "received": entry.size, "complete": True}

    # -- deletion ----------------------------------------------------------------------------
    async def delete(self, s: Session) -> None:
        """Remove the session and every photograph byte it holds (jobs are removed by the caller)."""
        s.deleted = True                 # invisible from now on; the id stays reserved until …
        for f in s.files.values():
            f.upload_token = None        # aborts uploads still streaming into the session
        try:
            await asyncio.get_running_loop().run_in_executor(None, _rmtree, s.dir)
        finally:
            self.sessions.pop(s.session_id, None)    # … its directory is gone


def _write_all(f: Any, data: bytes) -> None:
    view = memoryview(data)
    while len(view):
        n = f.write(view)
        view = view[n or 0:]


def _fsync_and_validate(path: Path, max_pixels: int, min_side: int) -> dict:
    fd = os.open(path, os.O_RDONLY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)
    return validate_image(path, max_pixels=max_pixels, min_side=min_side)


def _rmtree(path: Path) -> None:
    shutil.rmtree(path, ignore_errors=True)
    if os.path.lexists(path):          # retry once without swallowing, so real problems surface
        shutil.rmtree(path)
