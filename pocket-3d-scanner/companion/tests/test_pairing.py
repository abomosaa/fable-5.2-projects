"""Pairing, TLS pinning, authentication, device management."""
from __future__ import annotations

import asyncio
import json
import logging
import os
import stat

import aiohttp
import pytest

from conftest import Client, new_id, wait_until
from pocket3d_companion.security import (PAIRING_ALPHABET, DeviceStore, PairingFailed, PairingLocked,
                                         PairingManager, hash_token)


async def test_hello_needs_no_auth(harness, server):
    c = harness.client()
    status, body = await c.get("/v1/hello", auth=False)
    assert status == 200
    assert body["product"] == "pocket3d-companion" and body["api"] == 1 and body["version"] == "1.0.0"
    assert body["server_id"] == server.server_id and body["server_name"]


async def test_tls_fingerprint_is_pinned(harness, server):
    info = harness.pairing()
    assert info["fingerprint"] == server.fingerprint and len(info["fingerprint"]) == 64
    wrong = Client(info["port"], "00" * 32)
    try:
        with pytest.raises(aiohttp.ServerFingerprintMismatch):
            await wrong.get("/v1/hello", auth=False)
    finally:
        await wrong.close()
    # Plain HTTP is not served at all.
    async with aiohttp.ClientSession() as s:
        with pytest.raises(aiohttp.ClientError):
            async with s.get(f"http://127.0.0.1:{info['port']}/v1/hello") as r:
                await r.read()


async def test_pairing_file_and_banner(harness, server):
    path = harness.data_dir / "pairing.txt"
    assert stat.S_IMODE(os.stat(path).st_mode) == 0o600
    uri = path.read_text().strip()
    assert uri.startswith("pocket3d://pair?v=1&host=127.0.0.1&port=")
    code = harness.pairing()["code"]
    assert len(code) == 8 and set(code) <= set(PAIRING_ALPHABET)
    assert len(harness.banners) == 1 and uri in harness.banners[0]
    assert stat.S_IMODE(os.stat(harness.data_dir / "tls" / "key.pem").st_mode) == 0o600


async def test_pair_success_is_single_use(harness, server):
    code = harness.pairing()["code"]
    c = harness.client()
    status, body = await c.post("/v1/pair", {"code": code, "device_name": "Pixel 8"}, auth=False)
    assert status == 200
    assert len(body["token"]) == 64 and body["server_id"] == server.server_id
    c.token = body["token"]
    status, _ = await c.get("/v1/status")
    assert status == 200

    # The code was consumed: a new one is announced and the old one no longer works.
    assert harness.pairing()["code"] != code and len(harness.banners) == 2
    status, err = await c.post("/v1/pair", {"code": code, "device_name": "Other"}, auth=False)
    assert status == 403 and err["error"]["code"] == "pairing_failed"

    # Only the hash of the token is stored.
    raw = (harness.data_dir / "devices.json").read_text()
    assert body["token"] not in raw and hash_token(body["token"]) in raw
    assert stat.S_IMODE(os.stat(harness.data_dir / "devices.json").st_mode) == 0o600


async def test_pair_code_is_case_insensitive_and_validates_body(harness, server):
    c = harness.client()
    for bad in ({}, {"code": 12345678}, {"code": harness.pairing()["code"], "device_id": "not-a-uuid"}, [1]):
        status, err = await c.post("/v1/pair", bad, auth=False)
        assert status == 400 and err["error"]["code"] == "bad_request"
    status, err = await c.call("POST", "/v1/pair", data=b"{not json", auth=False)
    assert status == 400
    status, body = await c.post("/v1/pair", {"code": harness.pairing()["code"].lower(), "device_name": "x"},
                                auth=False)
    assert status == 200


async def test_wrong_codes_are_rate_limited_per_source_without_rotating_the_code(harness):
    await harness.start(pairing_lock_s=1.0)              # 5 attempts, then one more every 0.2 s
    c = harness.client()
    first = harness.pairing()["code"]
    for _ in range(5):
        status, err = await c.post("/v1/pair", {"code": "WRONGWRG", "device_name": "x"}, auth=False)
        assert status == 403 and err["error"]["code"] == "pairing_failed"
    status, err = await c.post("/v1/pair", {"code": "WRONGWRG", "device_name": "x"}, auth=False)
    assert status == 429 and err["error"]["code"] == "pairing_locked" and err["retry_after"] >= 1
    # out of attempts: even the right code is refused for the moment (checking first would defeat the limit)
    status, err = await c.post("/v1/pair", {"code": first, "device_name": "x"}, auth=False)
    assert status == 429
    # …but the code was NOT replaced: a wrong-code flood cannot invalidate the QR the user is about to scan
    assert harness.pairing()["code"] == first
    await asyncio.sleep(0.45)
    status, body = await c.post("/v1/pair", {"code": first, "device_name": "x"}, auth=False)
    assert status == 200 and body["token"]


async def test_pairing_code_expires_and_is_replaced(harness):
    await harness.start(pairing_code_ttl_s=0.25)
    c = harness.client()
    old = harness.pairing()["code"]
    await wait_until(lambda: harness.pairing()["code"] != old, timeout=3)
    assert len(harness.banners) >= 2                    # the new code was printed
    status, err = await c.post("/v1/pair", {"code": old, "device_name": "x"}, auth=False)
    assert status == 403 and err["error"]["code"] == "pairing_failed"


async def test_rotate_on_request(harness, server):
    old = harness.pairing()["code"]
    server.rotate_pairing_code()
    new = harness.pairing()["code"]
    assert new != old and len(harness.banners) == 2
    c = harness.client()
    status, _ = await c.post("/v1/pair", {"code": old, "device_name": "x"}, auth=False)
    assert status == 403
    status, _ = await c.post("/v1/pair", {"code": new, "device_name": "x"}, auth=False)
    assert status == 200


def test_pairing_manager_lifecycle_with_fake_clock():
    now = [1000.0]
    rotations = []
    pm = PairingManager(ttl_s=600, max_attempts=5, lock_s=60, on_rotate=lambda c, why: rotations.append(why),
                        clock=lambda: now[0])
    first = pm.code
    now[0] += 599
    with pytest.raises(PairingFailed):
        pm.redeem("AAAAAAAA" if first != "AAAAAAAA" else "BBBBBBBB", "phone")
    now[0] += 2                                         # 601 s: expired
    with pytest.raises(PairingFailed):
        pm.redeem(first, "phone")
    assert pm.code != first and rotations == ["start", "expired"]

    # an attacker burns its own attempts…
    for _ in range(5):
        with pytest.raises(PairingFailed):
            pm.redeem("", "attacker")
    with pytest.raises(PairingLocked) as e:
        pm.redeem(None, "attacker")
    assert 0 < e.value.retry_after <= 12.01             # one new attempt every 60 s / 5
    assert rotations == ["start", "expired"]            # …without replacing the code
    # …and without locking anyone else out: the phone pairs at once
    current = pm.code
    pm.redeem(current, "phone")
    assert rotations[-1] == "used" and pm.code != current
    with pytest.raises(PairingFailed):
        pm.redeem(current, "phone")                     # single use
    now[0] += 12.1
    with pytest.raises(PairingFailed):                  # the attacker gets exactly one more guess
        pm.redeem("", "attacker")
    with pytest.raises(PairingLocked):
        pm.redeem("", "attacker")


def test_pairing_brute_force_from_many_sources_is_bounded_globally():
    now = [0.0]
    pm = PairingManager(ttl_s=600, max_attempts=5, lock_s=60, clock=lambda: now[0])
    wrong = "AAAAAAAA" if pm.code != "AAAAAAAA" else "BBBBBBBB"
    guesses = 0
    for step in range(600):                             # one code lifetime, 50 fresh addresses per second
        for i in range(50):
            try:
                pm.redeem(wrong, f"10.0.{step % 250}.{i}")
            except PairingFailed:
                guesses += 1
            except PairingLocked:
                pass
        now[0] += 1.0
    assert guesses <= PairingManager.GLOBAL_BURST + PairingManager.GLOBAL_RATE * 600 + 1    # ≈ 330 of 32^8
    assert len(pm._buckets) <= PairingManager.MAX_SOURCES


AUTH_ROUTES = [
    ("GET", "/v1/status"), ("GET", "/v1/sessions"), ("PUT", "/v1/sessions/{id}"), ("GET", "/v1/sessions/{id}"),
    ("DELETE", "/v1/sessions/{id}"), ("PUT", "/v1/sessions/{id}/files/0001"), ("GET", "/v1/jobs"),
    ("PUT", "/v1/jobs/{id}"), ("GET", "/v1/jobs/{id}"), ("DELETE", "/v1/jobs/{id}"),
    ("POST", "/v1/jobs/{id}/cancel"), ("POST", "/v1/jobs/{id}/retry"),
    ("GET", "/v1/jobs/{id}/artifacts/model.glb"), ("GET", "/"), ("GET", "/v1/"), ("GET", "/v1/nope"),
]


async def test_auth_is_required_everywhere(harness, client):
    anon = harness.client()
    for method, template in AUTH_ROUTES:
        path = template.format(id=new_id())
        for headers in ({}, {"Authorization": "Bearer " + "0" * 64}, {"Authorization": "Bearer"},
                        {"Authorization": "Basic " + client.token}, {"Authorization": client.token}):
            status, body, hdrs = await anon.raw(method, path, headers=headers)
            assert status == 401, (method, path, headers)
            assert json.loads(body)["error"]["code"] == "unauthorized"
            assert hdrs["WWW-Authenticate"] == "Bearer"


async def test_unknown_paths_and_methods_use_the_error_format(client):
    for path in ("/", "/v1", "/v1/", "/v1/nope", "/v1/sessions/", f"/v1/sessions/{new_id()}/files",
                 f"/v1/sessions/{new_id()}/files/", f"/v1/jobs/{new_id()}/artifacts",
                 f"/v1/jobs/{new_id()}/artifacts/"):
        status, body = await client.get(path)
        assert status == 404 and body["error"]["code"] == "not_found", path
    status, body = await client.post("/v1/status")
    assert status == 405 and body["error"]["code"] == "bad_request"


async def test_json_body_size_limit(harness):
    await harness.start(max_json_bytes=64 * 1024)
    c = await harness.paired()
    status, body = await c.call("PUT", f"/v1/sessions/{new_id()}", data=b'{"name":"' + b"a" * 70_000 + b'"}',
                                headers={"Content-Type": "application/json"})
    assert status == 413 and body["error"]["code"] == "limit_exceeded"
    assert not any((harness.data_dir / "sessions").iterdir())


async def test_repairing_with_proof_of_the_old_token_keeps_identity_and_sessions(harness, client, photos):
    sid = await client.create_session(photos)
    again = await harness.paired("Pixel Test", device_id=client.device_id, proof_token=client.token)
    assert again.device_id == client.device_id and again.token != client.token
    status, _ = await client.get("/v1/status")
    assert status == 401                                 # the old token is dead
    status, body = await again.get(f"/v1/sessions/{sid}")
    assert status == 200 and body["complete"] is True


async def test_a_pairing_code_alone_cannot_take_over_another_devices_identity(harness, client, photos):
    """Knowing a device id (it is not a secret) plus a fresh pairing code must not give access to
    that device's photos: without the device's current token a new identity is issued."""
    sid = await client.create_session(photos)
    intruder = await harness.paired("Somebody else", device_id=client.device_id)
    assert intruder.device_id != client.device_id
    status, _ = await intruder.get(f"/v1/sessions/{sid}")
    assert status == 404
    status, body = await intruder.get("/v1/sessions")
    assert status == 200 and body["sessions"] == []
    status, _ = await client.get(f"/v1/sessions/{sid}")
    assert status == 200                                 # the owner is unaffected, its token still works
    # a wrong "proof" (someone else's valid token) does not help either
    other = await harness.paired("Third", device_id=client.device_id, proof_token=intruder.token)
    assert other.device_id not in (client.device_id,)
    status, _ = await other.get(f"/v1/sessions/{sid}")
    assert status == 404


async def test_ids_with_trailing_newline_or_leading_dash_are_rejected(harness, client, photos):
    import urllib.parse
    sid = new_id()
    files = [{"id": "ok1", "name": "a.jpg", "size": 10, "sha256": "0" * 64}]
    for bad_sid in (sid + "\n", sid + "\r", " " + sid):
        status, body = await client.put("/v1/sessions/" + urllib.parse.quote(bad_sid, safe=""),
                                        {"name": "x", "capture": {}, "files": files * 3})
        assert status == 400, bad_sid
    for bad_fid in ("nl\n", "-x", "a b", "", "x" * 33, "../x"):
        spec = [{"id": bad_fid, "name": "a.jpg", "size": 10, "sha256": "0" * 64},
                {"id": "b", "name": "b.jpg", "size": 10, "sha256": "0" * 64},
                {"id": "c", "name": "c.jpg", "size": 10, "sha256": "0" * 64}]
        status, body = await client.put(f"/v1/sessions/{sid}", {"name": "x", "capture": {}, "files": spec})
        assert status == 400 and body["error"]["code"] == "bad_request", repr(bad_fid)
    assert not any((harness.data_dir / "sessions").iterdir())


async def test_json_that_cannot_be_stored_is_rejected_cleanly(harness, client, photos):
    """1e400 parses to infinity and a lone surrogate cannot be written as UTF-8: both used to end
    in a 500 and (for the surrogate) a session that broke the device's whole session list."""
    sid = new_id()
    files = [{"id": f"f{i}", "name": f"{i}.jpg", "size": 10, "sha256": "0" * 64} for i in range(3)]
    for raw in (b'{"name":"x","capture":{"v":1e400},"files":%s}' % json.dumps(files).encode(),
                b'{"name":"\\ud800","capture":{},"files":%s}' % json.dumps(files).encode(),
                b'{"name":"x","capture":' + b"[" * 200 + b"]" * 200 + b',"files":[]}'):
        status, body = await client.call("PUT", f"/v1/sessions/{sid}", data=raw,
                                         headers={"Content-Type": "application/json"})
        assert status == 400 and body["error"]["code"] == "bad_request", raw[:60]
    assert not any((harness.data_dir / "sessions").iterdir())
    status, body = await client.get("/v1/sessions")
    assert status == 200 and body["sessions"] == []


async def test_revoking_a_device_from_the_cli_takes_effect_immediately(harness, client, photos):
    sid = await client.create_session(photos)
    status, _ = await client.get("/v1/status")
    assert status == 200
    # What `python -m pocket3d_companion devices revoke <id>` does, from another process:
    assert DeviceStore(harness.data_dir).revoke(client.device_id) is True
    status, body = await client.get("/v1/status")
    assert status == 401 and body["error"]["code"] == "unauthorized"
    assert harness.session_dir(sid).exists()             # data is kept unless --purge is given


async def test_revoke_with_purge_removes_the_devices_data(harness, client, photos):
    sid = await client.create_session(photos)
    jid = await client.submit(sid, {"mode": "succeed"})
    await client.wait_job(jid, "succeeded")
    other = await harness.paired("Other phone")
    other_sid = await other.create_session(photos)

    DeviceStore(harness.data_dir).revoke(client.device_id, purge=True)
    status, _ = await other.get("/v1/status")            # any request makes the server notice
    assert status == 200
    await wait_until(lambda: not harness.session_dir(sid).exists() and not harness.job_dir(jid).exists())
    assert harness.session_dir(other_sid).exists()
    await wait_until(lambda: json.loads((harness.data_dir / "devices.json").read_text())["purge_pending"] == [])


async def test_logs_contain_no_secrets_or_client_file_names(harness, caplog, photos):
    caplog.set_level(logging.DEBUG)
    await harness.start()
    code = harness.pairing()["code"]
    c = await harness.paired("SecretPhoneName")
    blobs = dict(photos)
    sid = new_id()
    body = {"name": "PrivateSessionTitle", "capture": {"format": 1, "frames": [{"exif_note": "ExifSecretValue"}]},
            "files": [{"id": fid, "name": f"private_holiday_{fid}.jpg", "size": len(b),
                       "sha256": __import__("hashlib").sha256(b).hexdigest()} for fid, b in blobs.items()]}
    status, _ = await c.put(f"/v1/sessions/{sid}", body)
    assert status == 200
    for fid, b in blobs.items():
        await c.upload(sid, fid, b)
    jid = await c.submit(sid, {"mode": "fail"})
    await c.wait_job(jid, "failed")
    await c.get("/v1/status", headers={"Authorization": "Bearer " + "f" * 64})
    await c.post("/v1/pair", {"code": "WRONGWRG", "device_name": "x"}, auth=False)

    # Malformed HTTP that quotes a credential (aiohttp would log the offending line verbatim).
    import ssl
    ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
    ctx.check_hostname, ctx.verify_mode = False, ssl.CERT_NONE
    reader, writer = await asyncio.open_connection("127.0.0.1", harness.server.port, ssl=ctx)
    writer.write(b"GET /v1/status HTTP/1.1\r\nAuthorization Bearer MalformedSecret\r\n\r\n")
    await writer.drain()
    assert (await reader.read(64)).startswith(b"HTTP/1.0 400")
    writer.close()

    text = caplog.text
    assert "paired device" in text and sid in text       # the log is not simply empty
    assert "Error handling request" in text and "MalformedSecret" not in text
    for secret in (c.token, code, harness.pairing()["code"], "private_holiday", "PrivateSessionTitle",
                   "ExifSecretValue", "SecretPhoneName", "f" * 64, "WRONGWRG"):
        assert secret not in text, secret
