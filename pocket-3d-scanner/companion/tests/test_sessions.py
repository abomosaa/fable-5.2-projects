"""Session manifests, resumable uploads, image validation, path safety, ownership."""
from __future__ import annotations

import asyncio
import io
import json
import os

import pytest
from PIL import Image

from conftest import KIB, make_image, manifest, new_id, wait_until


def files_by_id(body: dict) -> dict:
    return {f["id"]: f for f in body["files"]}


# -- manifest --------------------------------------------------------------------------------

async def test_create_get_and_list_session(harness, client, photos):
    sid = new_id()
    capture = {"format": 1, "source": "camera", "frames": [{"id": "0001", "width": 96, "height": 64}],
               "note": "kept verbatim"}
    status, body = await client.put(f"/v1/sessions/{sid}", manifest(photos, name="Garden gnome", capture=capture))
    assert status == 200
    assert body["session_id"] == sid and body["name"] == "Garden gnome" and body["complete"] is False
    assert body["total_bytes"] == sum(map(len, photos.values())) and body["received_bytes"] == 0
    assert body["files"] == [{"id": fid, "size": len(b), "received": 0, "complete": False, "error": None}
                             for fid, b in photos.items()]
    assert json.loads((harness.session_dir(sid) / "capture.json").read_text()) == capture

    status, again = await client.get(f"/v1/sessions/{sid}")
    assert status == 200 and again == body

    for fid, data in photos.items():
        status, up = await client.upload(sid, fid, data)
        assert status == 200 and up == {"id": fid, "received": len(data), "complete": True}
    status, body = await client.get(f"/v1/sessions/{sid}")
    assert body["complete"] is True and body["received_bytes"] == body["total_bytes"]

    # Stored under the validated id, never under the client's file name.
    assert sorted(p.name for p in (harness.session_dir(sid) / "originals").iterdir()) == \
        [f"{fid}.bin" for fid in sorted(photos)]

    status, listing = await client.get("/v1/sessions")
    assert status == 200 and len(listing["sessions"]) == 1
    entry = listing["sessions"][0]
    assert entry["session_id"] == sid and entry["file_count"] == 3 and entry["jobs"] == []
    assert entry["total_bytes"] == body["total_bytes"] and entry["disk_bytes"] >= body["total_bytes"]


@pytest.mark.parametrize("mutate, status, code", [
    (lambda m: m["files"][0].update(id="../../etc/passwd"), 400, "bad_request"),
    (lambda m: m["files"][0].update(id=".."), 400, "bad_request"),
    (lambda m: m["files"][0].update(id="a/b"), 400, "bad_request"),
    (lambda m: m["files"][0].update(id="a.bin"), 400, "bad_request"),
    (lambda m: m["files"][0].update(id=""), 400, "bad_request"),
    (lambda m: m["files"][0].update(id="x" * 33), 400, "bad_request"),
    (lambda m: m["files"][0].update(id=7), 400, "bad_request"),
    (lambda m: m["files"][1].update(id=m["files"][0]["id"]), 400, "bad_request"),
    (lambda m: m["files"][0].update(sha256="xyz"), 400, "bad_request"),
    (lambda m: m["files"][0].update(size=0), 400, "bad_request"),
    (lambda m: m["files"][0].update(size=-5), 400, "bad_request"),
    (lambda m: m["files"][0].update(size="12"), 400, "bad_request"),
    (lambda m: m["files"][0].update(size=True), 400, "bad_request"),
    (lambda m: m["files"][0].update(name="n" * 300), 400, "bad_request"),
    (lambda m: m.update(files="nope"), 400, "bad_request"),
    (lambda m: m.update(capture=[1, 2]), 400, "bad_request"),
    (lambda m: m.update(name=5), 400, "bad_request"),
    (lambda m: m["files"][0].update(size=512 * KIB + 1), 413, "limit_exceeded"),       # per-image limit
    (lambda m: [f.update(size=500 * KIB) for f in m["files"]] and m["files"].extend(
        {"id": f"x{i}", "name": "", "size": 500 * KIB, "sha256": "0" * 64} for i in range(2)), 413, "limit_exceeded"),
    (lambda m: m["files"].extend({"id": f"x{i}", "name": "", "size": 10, "sha256": "0" * 64}
                                 for i in range(18)), 422, "limit_exceeded"),           # 21 > max_images
    (lambda m: m["files"].pop(), 422, "limit_exceeded"),                                # 2 < min_images
])
async def test_manifest_validation_and_limits(harness, client, photos, mutate, status, code):
    m = manifest(photos)
    mutate(m)
    got, body = await client.put(f"/v1/sessions/{new_id()}", m)
    assert (got, body["error"]["code"]) == (status, code), body
    assert body["error"]["message"]
    assert not any((harness.data_dir / "sessions").iterdir())      # nothing was created


async def test_manifest_rejects_non_json_and_non_finite_numbers(client, photos):
    for raw in (b"not json", b"[]", b'{"name":"x","files":[],"capture":{"v":NaN}}'):
        status, body = await client.call("PUT", f"/v1/sessions/{new_id()}", data=raw)
        assert status == 400 and body["error"]["code"] == "bad_request"


async def test_insufficient_storage_is_reported(harness, photos):
    await harness.start(disk_reserve_mb=10**9)        # pretend the disk is (almost) full
    c = await harness.paired()
    status, body = await c.put(f"/v1/sessions/{new_id()}", manifest(photos))
    assert status == 507 and body["error"]["code"] == "insufficient_storage"


# -- path safety -----------------------------------------------------------------------------

BAD_IDS = ["..", "%2e%2e", "..%2F..%2Fetc%2Fpasswd", "%2Fetc%2Fpasswd", "a%00b", "A" * 40,
           "0b2b6b34-6a3b-4f4e-8f0b-2f8e9d5c1a7", "0B2B6B34-6A3B-4F4E-8F0B-2F8E9D5C1A70", "sessions", "."]


async def test_path_traversal_attempts_in_ids_are_rejected(harness, client, photos):
    sid = await client.create_session(photos)
    jid = await client.submit(sid, {"mode": "succeed"})
    await client.wait_job(jid, "succeeded")
    before = sorted(str(p.relative_to(harness.data_dir)) for p in harness.data_dir.rglob("*"))
    outside = sorted(p.name for p in harness.data_dir.parent.iterdir())

    for bad in BAD_IDS:
        for method, path in (("GET", f"/v1/sessions/{bad}"), ("PUT", f"/v1/sessions/{bad}"),
                             ("DELETE", f"/v1/sessions/{bad}"), ("GET", f"/v1/jobs/{bad}"),
                             ("PUT", f"/v1/jobs/{bad}"), ("DELETE", f"/v1/jobs/{bad}"),
                             ("POST", f"/v1/jobs/{bad}/cancel"), ("POST", f"/v1/jobs/{bad}/retry"),
                             ("GET", f"/v1/jobs/{bad}/artifacts/model.glb"),
                             ("PUT", f"/v1/sessions/{bad}/files/0001")):
            kw = {"data": json.dumps(manifest(photos)).encode()} if method == "PUT" else {}
            status, body = await client.call(method, path, **kw)
            assert status == 400 and body["error"]["code"] == "bad_request", (method, path, status)

    for bad in ["..", "%2e%2e", "..%2F0001", "0001.bin", "..%2F..%2Fsession.json", "a%00b", "x" * 33, "0001%2F"]:
        status, body = await client.call("PUT", f"/v1/sessions/{sid}/files/{bad}", data=b"abc",
                                         headers={"Upload-Offset": "0"})
        assert status == 400 and body["error"]["code"] == "bad_request", bad

    for bad in ["..", "..%2Fjob.json", "%2e%2e%2fstate.json", "..%2F..%2F..%2Fdevices.json", ".hidden",
                "a%00b", "out%2Fmodel.glb", "x" * 80]:
        status, body = await client.call("GET", f"/v1/jobs/{jid}/artifacts/{bad}")
        assert status == 400 and body["error"]["code"] == "bad_request", bad
    # Well-formed names of files that exist in the job directory but are not artifacts:
    for name in ["result.json", "job.json", "state.json", "events.jsonl", "work"]:
        status, body = await client.call("GET", f"/v1/jobs/{jid}/artifacts/{name}")
        assert status == 404 and body["error"]["code"] == "not_found", name
    # A literal slash never reaches a handler.
    status, body = await client.call("GET", f"/v1/jobs/{jid}/artifacts/../state.json")
    assert status in (400, 404)
    status, body = await client.call("GET", f"/v1/sessions/{sid}/originals/0001.bin")
    assert status == 404

    assert sorted(str(p.relative_to(harness.data_dir)) for p in harness.data_dir.rglob("*")) == before
    assert sorted(p.name for p in harness.data_dir.parent.iterdir()) == outside


# -- ownership -------------------------------------------------------------------------------

async def test_ownership_isolation_between_two_devices(harness, client, photos):
    alice, bob = client, await harness.paired("Bob's phone")
    sid = await alice.create_session(photos)
    jid = await alice.submit(sid, {"mode": "succeed"})
    await alice.wait_job(jid, "succeeded")

    def is_404(result):
        status, body = result
        return status == 404 and body["error"]["code"] == "not_found"

    assert is_404(await bob.get(f"/v1/sessions/{sid}"))
    assert is_404(await bob.put(f"/v1/sessions/{sid}", manifest(photos)))
    assert is_404(await bob.upload(sid, "0001", photos["0001"]))
    assert is_404(await bob.delete(f"/v1/sessions/{sid}"))
    assert is_404(await bob.put(f"/v1/jobs/{new_id()}", {"session_id": sid, "preset": "preview"}))
    assert is_404(await bob.put(f"/v1/jobs/{jid}", {"session_id": sid, "preset": "preview",
                                                    "settings": {"_test": {"mode": "succeed"}}}))
    assert is_404(await bob.get(f"/v1/jobs/{jid}"))
    assert is_404(await bob.post(f"/v1/jobs/{jid}/cancel"))
    assert is_404(await bob.post(f"/v1/jobs/{jid}/retry"))
    assert is_404(await bob.delete(f"/v1/jobs/{jid}"))
    assert is_404(await bob.get(f"/v1/jobs/{jid}/artifacts/model.glb"))
    assert is_404(await bob.get(f"/v1/jobs/{jid}/artifacts/pipeline.log"))
    assert (await bob.get("/v1/sessions")) == (200, {"sessions": []})
    assert (await bob.get("/v1/jobs")) == (200, {"jobs": []})
    assert (await bob.get(f"/v1/jobs?session_id={sid}")) == (200, {"jobs": []})

    # Nothing of Alice's was touched.
    status, body = await alice.get(f"/v1/sessions/{sid}")
    assert status == 200 and body["complete"] is True
    status, data, _ = await alice.raw("GET", f"/v1/jobs/{jid}/artifacts/model.glb")
    assert status == 200 and data.startswith(b"FAKE-GLB")
    status, body = await alice.get("/v1/jobs")
    assert [j["job_id"] for j in body["jobs"]] == [jid]


# -- resumable upload ------------------------------------------------------------------------

async def test_upload_in_chunks_with_offsets(harness, client, photos):
    sid = await client.create_session(photos, upload=False)
    data = photos["0001"]
    a, b = len(data) // 3, 2 * len(data) // 3
    status, body = await client.upload(sid, "0001", data[:a])
    assert (status, body) == (200, {"id": "0001", "received": a, "complete": False})
    status, body = await client.upload(sid, "0001", data[a:b], offset=a)
    assert (status, body) == (200, {"id": "0001", "received": b, "complete": False})
    status, body = await client.get(f"/v1/sessions/{sid}")
    assert files_by_id(body)["0001"]["received"] == b and body["received_bytes"] == b
    status, body = await client.upload(sid, "0001", data[b:], offset=b)
    assert (status, body) == (200, {"id": "0001", "received": len(data), "complete": True})
    assert (harness.session_dir(sid) / "originals" / "0001.bin").read_bytes() == data


async def test_wrong_offset_returns_409_with_received(client, photos):
    sid = await client.create_session(photos, upload=False)
    data = photos["0001"]
    await client.upload(sid, "0001", data[:100])
    for offset in (0, 50, 101, len(data), 10**12):
        status, body = await client.upload(sid, "0001", data[offset:offset + 10] or b"x", offset=offset)
        assert status == 409 and body["error"]["code"] == "offset_mismatch" and body["received"] == 100
    for bad in ("-1", "abc", "1.5", ""):
        status, body = await client.call("PUT", f"/v1/sessions/{sid}/files/0001", data=b"x",
                                         headers={"Upload-Offset": bad})
        assert status == 400, bad
    status, body = await client.upload(sid, "0001", data[100:], offset=100)
    assert status == 200 and body["complete"] is True
    # A completed file reports its full size; re-sending is refused without touching it.
    status, body = await client.upload(sid, "0001", data, offset=0)
    assert status == 409 and body["received"] == len(data)
    status, body = await client.upload(sid, "0001", b"", offset=len(data))
    assert (status, body) == (200, {"id": "0001", "received": len(data), "complete": True})
    status, body = await client.upload(sid, "nope", b"x")
    assert status == 404


async def test_upload_interrupted_mid_file_can_be_resumed(harness, client, photos):
    sid = await client.create_session(photos, upload=False)
    data = make_image(size=(800, 600), seed=99)          # a few hundred kB: several network chunks
    assert len(data) > 200 * KIB
    blobs = dict(photos, **{"0001": data})
    status, _ = await client.put(f"/v1/sessions/{sid}", manifest(blobs))
    assert status == 200
    cut = 150 * KIB

    async def dying_body():
        yield data[:cut]
        await asyncio.sleep(0.2)                         # let the server store what it got
        raise ConnectionResetError("phone walked out of Wi-Fi range")

    with pytest.raises(Exception):
        await client.call("PUT", f"/v1/sessions/{sid}/files/0001", data=dying_body(),
                          headers={"Upload-Offset": "0", "Content-Length": str(len(data))})

    async def stored():
        _, body = await client.get(f"/v1/sessions/{sid}")
        return files_by_id(body)["0001"]["received"]
    received = await wait_until(stored)
    assert 0 < received <= cut
    on_disk = (harness.session_dir(sid) / "originals" / "0001.bin").read_bytes()
    assert on_disk == data[:received]                    # a clean prefix, nothing torn

    status, body = await client.upload(sid, "0001", data, offset=0)      # naive restart from 0
    assert status == 409 and body["received"] == received
    status, body = await client.upload(sid, "0001", data[received:], offset=received)
    assert (status, body) == (200, {"id": "0001", "received": len(data), "complete": True})


async def test_checksum_mismatch_resets_the_file(harness, client, photos):
    sid = await client.create_session(photos, upload=False)
    data = photos["0001"]
    corrupted = bytes([data[0] ^ 0xFF]) + data[1:]
    status, body = await client.upload(sid, "0001", corrupted)
    assert status == 422 and body["error"]["code"] == "checksum_mismatch"
    status, body = await client.get(f"/v1/sessions/{sid}")
    assert files_by_id(body)["0001"] == {"id": "0001", "size": len(data), "received": 0, "complete": False,
                                         "error": None}
    assert not (harness.session_dir(sid) / "originals" / "0001.bin").exists()
    # Same when the damage is in a resumed part (the running hash must cover all parts).
    half = len(data) // 2
    await client.upload(sid, "0001", data[:half])
    status, body = await client.upload(sid, "0001", corrupted[half:-1] + b"\x00", offset=half)
    assert status == 422 and body["error"]["code"] == "checksum_mismatch"
    status, body = await client.upload(sid, "0001", data)
    assert status == 200 and body["complete"] is True


async def test_body_larger_than_declared_size_is_rejected(harness, client, photos):
    sid = await client.create_session(photos, upload=False)
    data = photos["0001"]
    path = harness.session_dir(sid) / "originals" / "0001.bin"

    status, body = await client.upload(sid, "0001", data + b"extra")           # Content-Length too big
    assert status == 413 and body["error"]["code"] == "limit_exceeded"
    assert not path.exists()

    async def endless():                                                       # chunked, no Content-Length
        for _ in range(64):
            yield b"\xff" * 16 * KIB
    status, body = await client.call("PUT", f"/v1/sessions/{sid}/files/0001", data=endless(),
                                     headers={"Upload-Offset": "0"})
    assert status == 413 and body["error"]["code"] == "limit_exceeded"
    assert not path.exists()                                                   # nothing of it was kept

    await client.upload(sid, "0001", data[:100])
    status, body = await client.call("PUT", f"/v1/sessions/{sid}/files/0001", data=endless(),
                                     headers={"Upload-Offset": "100"})
    assert status == 413
    assert path.read_bytes() == data[:100]                                     # earlier bytes survive
    status, body = await client.upload(sid, "0001", data[100:], offset=100)
    assert status == 200 and body["complete"] is True


def _png(size, color=(10, 200, 30)) -> bytes:
    buf = io.BytesIO()
    Image.new("RGB", size, color).save(buf, format="PNG")
    return buf.getvalue()


def _gif() -> bytes:
    buf = io.BytesIO()
    Image.new("P", (96, 64)).save(buf, format="GIF")
    return buf.getvalue()


def _corrupt_png() -> bytes:
    raw = bytearray(make_image("PNG", seed=5))
    raw[len(raw) // 2] ^= 0xFF                      # breaks a chunk CRC
    return bytes(raw)


REJECTED = {
    "text": b"this is definitely not a photograph\n" * 50,
    "zeros": bytes(4096),
    "html": b"<html><script>alert(1)</script></html>",
    "truncated_header": make_image()[:20],
    "gif": _gif(),                                   # a real image, but not an accepted format
    "too_small": make_image(size=(31, 200)),         # short side below min_image_side (32)
    "too_many_pixels": _png((1100, 1000)),           # 1.1 MP > max_image_pixels (1 MP), tiny file
    "bomb": _png((9000, 9000)),                      # 81 MP in a few hundred kB
    "corrupt_png": _corrupt_png(),
}


@pytest.mark.parametrize("kind", sorted(REJECTED))
async def test_invalid_image_is_rejected(harness, client, photos, kind):
    bad = REJECTED[kind]
    assert len(bad) <= 512 * KIB
    blobs = dict(photos, **{"0002": bad})
    sid = await client.create_session(blobs, upload=False)
    status, body = await client.upload(sid, "0002", bad)             # checksum is right, content is not
    assert status == 422 and body["error"]["code"] == "unsupported_format", body
    status, body = await client.get(f"/v1/sessions/{sid}")
    entry = files_by_id(body)["0002"]
    assert entry["complete"] is False and entry["received"] == 0 and entry["error"].startswith("unsupported_format")
    assert not (harness.session_dir(sid) / "originals" / "0002.bin").exists()

    for fid in ("0001", "0003"):
        await client.upload(sid, fid, photos[fid])
    status, body = await client.get(f"/v1/sessions/{sid}")
    assert body["complete"] is False
    status, body = await client.put(f"/v1/jobs/{new_id()}", {"session_id": sid, "preset": "preview"})
    assert status == 409 and body["error"]["code"] == "incomplete_upload"

    # The phone replaces the bad file with a good one (new size/sha256 in the manifest).
    status, body = await client.put(f"/v1/sessions/{sid}", manifest(photos))
    assert status == 200 and files_by_id(body)["0002"]["error"] is None
    assert files_by_id(body)["0001"]["complete"] is True             # untouched files keep their bytes
    status, body = await client.upload(sid, "0002", photos["0002"])
    assert status == 200 and body["complete"] is True


def _mpo() -> bytes:
    """JPEG with a second picture attached, as phones write them (gain map, depth map)."""
    frames = [Image.open(io.BytesIO(make_image(seed=s))) for s in (7, 8)]
    buf = io.BytesIO()
    frames[0].save(buf, format="MPO", save_all=True, append_images=frames[1:])
    return buf.getvalue()


@pytest.mark.parametrize("fmt, expected", [("JPEG", "jpeg"), ("PNG", "png"), ("WEBP", "webp"), ("HEIF", "heic"),
                                           ("MPO", "jpeg")])
async def test_supported_formats_are_sniffed_from_content(harness, client, photos, fmt, expected):
    if fmt == "HEIF":
        import pillow_heif
        pillow_heif.register_heif_opener()
    try:
        data = _mpo() if fmt == "MPO" else make_image(fmt, seed=7)
    except Exception as e:      # an encoder missing from this Pillow build is not a companion bug
        pytest.skip(f"cannot encode {fmt} here: {e}")
    blobs = dict(photos, **{"0002": data})
    sid = new_id()
    m = manifest(blobs)
    m["files"][1]["name"] = "misleading_name.txt"                     # names are never used for sniffing
    status, _ = await client.put(f"/v1/sessions/{sid}", m)
    assert status == 200
    status, body = await client.upload(sid, "0002", data)
    assert status == 200 and body["complete"] is True
    stored = json.loads((harness.session_dir(sid) / "session.json").read_text())
    assert files_by_id(stored)["0002"]["image"] == {"format": expected, "width": 96, "height": 64}


# -- re-PUT ----------------------------------------------------------------------------------

async def test_reput_manifest_resets_changed_files_and_deletes_removed_ones(harness, client):
    blobs = {f"{i:04d}": make_image(seed=20 + i) for i in range(1, 6)}
    sid = await client.create_session(blobs, upload=False)
    originals = harness.session_dir(sid) / "originals"
    for fid in ("0001", "0002", "0003", "0005"):
        await client.upload(sid, fid, blobs[fid])
    await client.upload(sid, "0004", blobs["0004"][:500])

    # Identical manifest (e.g. the app restarted): nothing is lost.
    status, body = await client.put(f"/v1/sessions/{sid}", manifest(blobs, name="Renamed"))
    assert status == 200 and body["name"] == "Renamed"
    assert [f["received"] for f in body["files"]] == [len(blobs["0001"]), len(blobs["0002"]), len(blobs["0003"]),
                                                      500, len(blobs["0005"])]

    changed = dict(blobs)
    del changed["0005"]                                   # removed
    changed["0002"] = make_image(seed=77)                 # replaced (new sha256/size)
    changed["0006"] = make_image(seed=78)                 # added
    status, body = await client.put(f"/v1/sessions/{sid}", manifest(changed))
    assert status == 200
    got = files_by_id(body)
    assert list(got) == ["0001", "0002", "0003", "0004", "0006"]
    assert got["0001"]["complete"] and got["0003"]["complete"]
    assert got["0002"] == {"id": "0002", "size": len(changed["0002"]), "received": 0, "complete": False,
                           "error": None}
    assert got["0004"]["received"] == 500 and got["0006"]["received"] == 0
    assert sorted(p.name for p in originals.iterdir()) == ["0001.bin", "0003.bin", "0004.bin"]

    status, body = await client.upload(sid, "0005", blobs["0005"])
    assert status == 404
    for fid in ("0002", "0006"):
        await client.upload(sid, fid, changed[fid])
    status, body = await client.upload(sid, "0004", changed["0004"][500:], offset=500)
    assert status == 200 and body["complete"] is True
    status, body = await client.get(f"/v1/sessions/{sid}")
    assert body["complete"] is True


async def test_reput_with_changed_files_conflicts_while_a_job_is_active(client, photos):
    sid = await client.create_session(photos)
    jid = await client.submit(sid, {"mode": "sleep", "seconds": 30})
    await client.wait_job(jid, "running")
    changed = dict(photos, **{"0003": make_image(seed=55)})
    status, body = await client.put(f"/v1/sessions/{sid}", manifest(changed))
    assert status == 409 and body["error"]["code"] == "conflict"
    status, body = await client.put(f"/v1/sessions/{sid}", manifest(photos, name="Only a new name"))
    assert status == 200 and body["name"] == "Only a new name" and body["complete"] is True
    status, body = await client.put(f"/v1/sessions/{sid}", manifest(photos, capture={"format": 1, "changed": True}))
    assert status == 409 and body["error"]["code"] == "conflict"       # the worker reads capture.json

    await client.post(f"/v1/jobs/{jid}/cancel")
    await client.wait_job(jid, "cancelled")
    status, body = await client.put(f"/v1/sessions/{sid}", manifest(changed))
    assert status == 200 and body["complete"] is False


# -- delete ----------------------------------------------------------------------------------

async def test_delete_session_removes_photos_and_job_data_from_disk(harness, client, photos):
    sid = await client.create_session(photos)
    done = await client.submit(sid, {"mode": "succeed"})
    await client.wait_job(done, "succeeded")
    running = await client.submit(sid, {"mode": "sleep", "seconds": 60, "spawn_child": True})
    await client.wait_job(running, "running")
    await wait_until(lambda: (harness.job_dir(running) / "work" / "child.pid").exists())
    pids = harness.worker_pids()
    assert len(pids) >= 2

    keep = await client.create_session({k: make_image(seed=40 + i) for i, k in enumerate(photos)})

    status, body = await client.delete(f"/v1/sessions/{sid}")
    assert status == 204 and body is None
    assert not harness.session_dir(sid).exists()
    assert not harness.job_dir(done).exists() and not harness.job_dir(running).exists()
    from conftest import pid_alive
    assert not any(pid_alive(p) for p in pids)

    for path in (f"/v1/sessions/{sid}", f"/v1/jobs/{done}", f"/v1/jobs/{running}",
                 f"/v1/jobs/{done}/artifacts/model.glb"):
        status, body = await client.get(path)
        assert status == 404
    status, body = await client.delete(f"/v1/sessions/{sid}")
    assert status == 404
    status, body = await client.get("/v1/sessions")
    assert [s["session_id"] for s in body["sessions"]] == [keep]
    assert harness.session_dir(keep).exists()
    assert os.listdir(harness.data_dir / "jobs") == []


async def test_truncated_image_with_matching_checksum_is_rejected(harness, client):
    """The first third of a real JPEG, declared with its own (correct) size and SHA-256, has a
    valid header but no usable pixels: it must not be accepted as a photograph."""
    import hashlib
    import random
    rnd = random.Random(1)
    from PIL import Image
    import io
    img = Image.frombytes("RGB", (640, 480), bytes(rnd.getrandbits(8) for _ in range(640 * 480 * 3)))
    buf = io.BytesIO(); img.save(buf, "JPEG", quality=90)
    cut = buf.getvalue()[: len(buf.getvalue()) // 3]
    good = [make_image(seed=i) for i in (1, 2)]
    sid = new_id()
    files = [{"id": "cut", "name": "cut.jpg", "size": len(cut), "sha256": hashlib.sha256(cut).hexdigest()}] + \
            [{"id": f"g{i}", "name": f"g{i}.jpg", "size": len(g), "sha256": hashlib.sha256(g).hexdigest()} for i, g in enumerate(good)]
    status, _ = await client.put(f"/v1/sessions/{sid}", {"name": "x", "capture": {}, "files": files})
    assert status == 200
    status, body = await client.upload(sid, "cut", cut)
    assert status == 422 and body["error"]["code"] == "unsupported_format"
    status, body = await client.get(f"/v1/sessions/{sid}")
    entry = next(f for f in body["files"] if f["id"] == "cut")
    assert entry["complete"] is False and entry["received"] == 0 and entry["error"]
