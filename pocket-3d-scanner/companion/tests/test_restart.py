"""Everything must survive a companion restart — graceful or not."""
from __future__ import annotations

import hashlib
import json
import os
import signal

import pytest

from conftest import make_image, pid_alive, wait_until
from pocket3d_companion.server import CompanionServer
from conftest import make_config


def files_by_id(body: dict) -> dict:
    return {f["id"]: f for f in body["files"]}


async def test_identity_devices_sessions_and_partial_uploads_survive_a_restart(harness, photos):
    server = await harness.start()
    server_id, fingerprint, code = server.server_id, server.fingerprint, harness.pairing()["code"]
    c = await harness.paired()
    token = c.token
    big = make_image(size=(500, 400), seed=3)
    blobs = dict(photos, **{"0003": big})
    sid = await c.create_session(blobs, upload=False, name="Survivor")
    await c.upload(sid, "0001", blobs["0001"])
    await c.upload(sid, "0003", big[:70_000])
    status, before = await c.get(f"/v1/sessions/{sid}")

    # A stale/corrupt counter in session.json must not be trusted: only bytes on disk count.
    path = harness.session_dir(sid) / "session.json"
    doc = json.loads(path.read_text())
    for f in doc["files"]:
        f["received"] = 999_999_999
    path.write_text(json.dumps(doc))
    # Leftover of an interrupted atomic write:
    (harness.session_dir(sid) / ".session.json.deadbeef.tmp").write_text("{half")

    server = await harness.restart()
    assert server.server_id == server_id and server.fingerprint == fingerprint
    assert harness.pairing()["code"] != code                      # pairing codes are never persisted
    assert harness.pairing()["fingerprint"] == fingerprint
    assert not (harness.session_dir(sid) / ".session.json.deadbeef.tmp").exists()

    c = harness.client(token)                                     # same token, same pinned certificate
    status, after = await c.get(f"/v1/sessions/{sid}")
    assert status == 200 and after == before and after["name"] == "Survivor"
    got = files_by_id(after)
    assert got["0001"]["complete"] is True and got["0002"]["received"] == 0
    assert got["0003"]["received"] == 70_000 and got["0003"]["complete"] is False

    status, body = await c.upload(sid, "0003", big, offset=0)
    assert status == 409 and body["received"] == 70_000
    status, body = await c.upload(sid, "0003", big[70_000:], offset=70_000)   # checksum over old + new bytes
    assert (status, body) == (200, {"id": "0003", "received": len(big), "complete": True})
    await c.upload(sid, "0002", blobs["0002"])
    status, body = await c.get(f"/v1/sessions/{sid}")
    assert body["complete"] is True
    status, body = await c.get("/v1/sessions")
    assert [s["session_id"] for s in body["sessions"]] == [sid]


async def test_restart_reconciles_sessions_with_the_bytes_on_disk(harness, photos):
    await harness.start()
    c = await harness.paired()
    token = c.token
    sid = await c.create_session(photos, upload=False)
    await c.upload(sid, "0001", photos["0001"])
    originals = harness.session_dir(sid) / "originals"
    await harness.stop()

    (originals / "0001.bin").write_bytes(photos["0001"][:-5])     # a "complete" file lost its tail
    (originals / "0002.bin").write_bytes(photos["0002"])          # all bytes there, never verified
    (originals / "0003.bin").write_bytes(photos["0003"] + b"!!")  # more bytes than declared
    (originals / "stray.bin").write_bytes(b"not in the manifest")

    await harness.start()
    c = harness.client(token)
    status, body = await c.get(f"/v1/sessions/{sid}")
    got = files_by_id(body)
    assert got["0001"] == {"id": "0001", "size": len(photos["0001"]), "received": 0, "complete": False, "error": None}
    assert got["0002"]["complete"] is True                        # verified (SHA-256 + image) at startup
    assert got["0003"]["received"] == 0 and got["0003"]["complete"] is False
    assert sorted(p.name for p in originals.iterdir()) == ["0002.bin"]


async def test_killed_companion_running_job_becomes_interrupted_and_queue_resumes(harness, photos):
    await harness.start()
    c = await harness.paired()
    token = c.token
    sid = await c.create_session(photos)
    running = await c.submit(sid, {"mode": "sleep", "seconds": 120, "spawn_child": True})
    queued = await c.submit(sid, {"mode": "succeed"})
    await c.wait_job(running, "running")
    work = harness.job_dir(running) / "work"
    await wait_until(lambda: (work / "child.pid").exists() and (work / "child.pid").read_text())
    await wait_until(lambda: c.all_events(running))
    events_before = await c.all_events(running)
    assert (await c.job(queued))["state"] == "queued"
    pids = harness.worker_pids()
    assert len(pids) == 2

    # The companion dies without any clean-up (SIGKILL / power loss of the container)…
    await harness.stop(abandon_workers=True)
    assert json.loads((harness.job_dir(running) / "state.json").read_text())["state"] == "running"
    assert all(pid_alive(p) for p in pids)                        # …and its worker is orphaned.

    await harness.start()
    c = harness.client(token)
    job = await c.job(running)
    assert job["state"] == "interrupted" and job["error"] is None and job["finished_at"]
    assert job["overall_progress"] < 1.0 and "model.glb" not in [a["name"] for a in job["artifacts"]]
    assert not any(pid_alive(p) for p in pids)                    # the orphan was reaped at startup
    assert await c.all_events(running) == events_before           # same events, same numbering

    done = await c.wait_job(queued, "succeeded")                  # the queued job was scheduled again
    assert done["attempt"] == 1

    status, body = await c.post(f"/v1/jobs/{running}/retry")      # interrupted jobs can be retried
    assert status == 200 and body["attempt"] == 2
    await c.wait_job(running, "running")
    events = await wait_until(lambda: _more_events(c, running, len(events_before)))
    assert [e["seq"] for e in events] == list(range(1, len(events) + 1))
    assert (work / "attempts.log").read_text() == "1\n2\n"
    await c.post(f"/v1/jobs/{running}/cancel")
    await c.wait_job(running, "cancelled")


async def _more_events(client, job_id, n):
    events = await client.all_events(job_id)
    return events if len(events) > n else None


async def test_graceful_stop_interrupts_running_jobs_and_keeps_queued_ones(harness, photos):
    await harness.start()
    c = await harness.paired()
    token = c.token
    sid = await c.create_session(photos)
    running = await c.submit(sid, {"mode": "sleep", "seconds": 120, "spawn_child": True})
    queued = await c.submit(sid, {"mode": "sleep", "seconds": 120})
    await c.wait_job(running, "running")
    await wait_until(lambda: (harness.job_dir(running) / "work" / "child.pid").exists())
    await wait_until(lambda: c.all_events(running))
    pids = harness.worker_pids()

    await harness.stop()
    assert not any(pid_alive(p) for p in pids)
    assert json.loads((harness.job_dir(running) / "state.json").read_text())["state"] == "interrupted"
    assert json.loads((harness.job_dir(queued) / "state.json").read_text())["state"] == "queued"
    assert not (harness.job_dir(queued) / "job.json").exists()    # shutdown did not start it
    assert not (harness.data_dir / "pairing.txt").exists()        # no stale pairing code left behind

    await harness.start()
    c = harness.client(token)
    assert (await c.job(running))["state"] == "interrupted"
    job = await c.wait_job(queued, "running")
    assert job["attempt"] == 1
    await c.delete(f"/v1/jobs/{queued}")


async def test_job_cancelled_while_the_companion_died_is_not_left_cancelling(harness, photos):
    await harness.start()
    c = await harness.paired()
    token = c.token
    sid = await c.create_session(photos)
    jid = await c.submit(sid, {"mode": "sleep", "seconds": 120})
    await c.wait_job(jid, "running")
    await harness.stop(abandon_workers=True)
    path = harness.job_dir(jid) / "state.json"
    doc = json.loads(path.read_text())
    doc["state"] = "cancelling"                                    # died between SIGTERM and exit
    path.write_text(json.dumps(doc))
    pids = harness.worker_pids()

    await harness.start()
    c = harness.client(token)
    job = await c.job(jid)
    assert job["state"] == "interrupted" and not any(pid_alive(p) for p in pids)


async def test_finished_jobs_and_their_artifacts_survive_a_restart(harness, photos):
    await harness.start()
    c = await harness.paired()
    token = c.token
    sid = await c.create_session(photos)
    ok = await c.submit(sid, {"mode": "succeed"})
    bad = await c.submit(sid, {"mode": "fail"})
    before_ok, before_bad = await c.wait_job(ok, "succeeded"), await c.wait_job(bad, "failed")
    events_ok = await c.all_events(ok)
    _, model, _ = await c.raw("GET", f"/v1/jobs/{ok}/artifacts/model.glb")

    await harness.restart()
    c = harness.client(token)
    assert await c.job(ok) == before_ok and await c.job(bad) == before_bad
    assert await c.all_events(ok) == events_ok
    status, data, headers = await c.raw("GET", f"/v1/jobs/{ok}/artifacts/model.glb", headers={"Range": "bytes=100-"})
    assert status == 206 and data == model[100:]
    assert headers["ETag"].strip('"') == hashlib.sha256(model).hexdigest()
    status, body = await c.get("/v1/jobs")
    assert [j["job_id"] for j in body["jobs"]] == [ok, bad]
    status, body = await c.get("/v1/status")
    assert body["queue"] == {"running": 0, "queued": 0}

    # A failed job from before the restart can still be retried, events keep counting up.
    n = len(await c.all_events(bad))
    status, body = await c.post(f"/v1/jobs/{bad}/retry")
    assert status == 200
    await c.wait_job(bad, "failed")
    events = await c.all_events(bad)
    assert len(events) > n and [e["seq"] for e in events] == list(range(1, len(events) + 1))


async def test_deleted_data_stays_deleted_after_a_restart(harness, photos):
    await harness.start()
    c = await harness.paired()
    token = c.token
    sid = await c.create_session(photos)
    jid = await c.submit(sid, {"mode": "succeed"})
    await c.wait_job(jid, "succeeded")
    status, _ = await c.delete(f"/v1/sessions/{sid}")
    assert status == 204
    await harness.restart()
    c = harness.client(token)
    assert (await c.get("/v1/sessions")) == (200, {"sessions": []})
    assert (await c.get("/v1/jobs")) == (200, {"jobs": []})
    assert os.listdir(harness.data_dir / "sessions") == [] and os.listdir(harness.data_dir / "jobs") == []


async def test_unreadable_state_files_do_not_stop_the_companion_or_delete_data(harness, photos):
    await harness.start()
    c = await harness.paired()
    token = c.token
    good = await c.create_session(photos)
    broken = await c.create_session({k: make_image(seed=60 + i) for i, k in enumerate(photos)})
    jid = await c.submit(good, {"mode": "succeed"})
    await c.wait_job(jid, "succeeded")
    await harness.stop()
    (harness.session_dir(broken) / "session.json").write_text("{ this is not json")
    (harness.data_dir / "sessions" / "not-a-session").mkdir()
    (harness.data_dir / "jobs" / "junk.txt").write_text("x")

    await harness.start()
    c = harness.client(token)
    status, body = await c.get("/v1/sessions")
    assert [s["session_id"] for s in body["sessions"]] == [good]
    assert (await c.job(jid))["state"] == "succeeded"
    status, body = await c.get(f"/v1/sessions/{broken}")
    assert status == 404
    assert (harness.session_dir(broken) / "originals" / "0001.bin").exists()    # nothing was thrown away


async def test_two_companions_cannot_share_a_data_directory(harness):
    await harness.start()
    second = CompanionServer(make_config(harness.data_dir), announce=lambda text: None)
    with pytest.raises(RuntimeError, match="already using"):
        await second.start()
    # The failed start must not have disturbed the running instance.
    c = harness.client()
    status, body = await c.get("/v1/hello", auth=False)
    assert status == 200 and (harness.data_dir / "pairing.txt").exists()


async def test_orphaned_child_of_a_dead_worker_is_reaped_at_startup(harness, photos):
    """The companion and the worker both died, but a tool the worker had started kept running."""
    await harness.start()
    c = await harness.paired()
    token = c.token
    sid = await c.create_session(photos)
    jid = await c.submit(sid, {"mode": "sleep", "seconds": 120, "spawn_child": True})
    await c.wait_job(jid, "running")
    work = harness.job_dir(jid) / "work"
    await wait_until(lambda: (work / "child.pid").exists() and (work / "child.pid").read_text())
    worker, child = int((work / "worker.pid").read_text()), int((work / "child.pid").read_text())
    await harness.stop(abandon_workers=True)
    os.kill(worker, signal.SIGKILL)
    await wait_until(lambda: not pid_alive(worker))
    assert pid_alive(child)

    await harness.start()
    assert not pid_alive(child)
    assert (await harness.client(token).job(jid))["state"] == "interrupted"
