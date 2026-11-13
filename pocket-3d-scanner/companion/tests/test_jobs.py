"""Job state machine, worker supervision, queue, retry, artifacts, long-poll."""
from __future__ import annotations

import asyncio
import hashlib
import json
import os
import subprocess
import sys
import time

import pytest

from conftest import FAKE_WORKER_CMD, make_image, new_id, pid_alive, wait_until
from pocket3d_companion.jobs import JobManager, check_result, load_presets

FAKE_STAGES = ["ingest", "features", "matching", "sfm", "undistort", "dense", "mesh", "texture", "package"]


@pytest.fixture
async def session_id(client, photos):
    return await client.create_session(photos)


# -- submit ----------------------------------------------------------------------------------

async def test_submit_requires_a_complete_upload(client, photos):
    sid = await client.create_session(photos, upload=False)
    await client.upload(sid, "0001", photos["0001"])
    await client.upload(sid, "0002", photos["0002"][:10])
    status, body = await client.put(f"/v1/jobs/{new_id()}", {"session_id": sid, "preset": "preview"})
    assert status == 409 and body["error"]["code"] == "incomplete_upload"
    status, body = await client.get("/v1/jobs")
    assert body == {"jobs": []}


async def test_submit_validation(harness, client, session_id):
    for body in ({"session_id": session_id, "preset": "ultra"}, {"session_id": session_id},
                 {"preset": "preview"}, {"session_id": "nope", "preset": "preview"},
                 {"session_id": session_id, "preset": "preview", "settings": [1]}, [], "x"):
        status, resp = await client.put(f"/v1/jobs/{new_id()}", body)
        assert status == 400 and resp["error"]["code"] == "bad_request", body
    status, resp = await client.put(f"/v1/jobs/{new_id()}", {"session_id": new_id(), "preset": "preview"})
    assert status == 404
    status, resp = await client.put(f"/v1/jobs/{new_id()}", {"session_id": session_id, "preset": "preview",
                                                             "settings": {"_pad": "x" * 20000}})
    assert status == 413 and resp["error"]["code"] == "limit_exceeded"
    assert os.listdir(harness.data_dir / "jobs") == []


async def test_settings_are_validated_by_the_pipeline_presets_when_available(client, session_id):
    pytest.importorskip("pocket3d_companion.pipeline.presets")
    status, resp = await client.put(f"/v1/jobs/{new_id()}", {"session_id": session_id, "preset": "preview",
                                                             "settings": {"no_such_setting": 1}})
    assert status == 400 and resp["error"]["code"] == "bad_request"


async def test_status_reports_resources_limits_and_presets(harness, client):
    status, body = await client.get("/v1/status")
    assert status == 200
    assert body["api"] == 1 and body["version"] == "1.0.0" and body["server_id"] == harness.server.server_id
    hw = body["hardware"]
    assert hw["cpu_threads"] >= 1 and hw["mem_total_mb"] > 0 and hw["cpu_model"] and hw["gpu"] is None
    assert body["resources"]["max_parallel_jobs"] == 1 and body["resources"]["job_threads"] == 2
    assert body["resources"]["job_memory_mb"] == 512 and body["resources"]["disk_free_mb"] > 0
    assert body["queue"] == {"running": 0, "queued": 0}
    assert body["limits"] == {"max_images": 20, "min_images": 3, "max_image_bytes": 512 * 1024,
                              "max_image_pixels": 1_000_000, "min_image_side": 32,
                              "max_session_bytes": 2048 * 1024, "formats": ["jpeg", "png", "webp", "heic"]}
    assert [p["id"] for p in body["presets"]] == ["preview", "standard", "high"]
    assert all(p["label"] and p["description"] for p in body["presets"])
    assert body["presets"] == load_presets()


# -- the state machine, one fake-worker mode at a time ------------------------------------------

async def test_success(harness, client, session_id, photos):
    jid = new_id()
    request = {"session_id": session_id, "preset": "standard", "settings": {"_test": {"mode": "succeed"}}}
    status, body = await client.put(f"/v1/jobs/{jid}", request)
    assert status == 201
    job = body
    assert job["job_id"] == jid and job["session_id"] == session_id and job["preset"] == "standard"
    assert job["state"] in ("queued", "running") and job["attempt"] == 1 and job["error"] is None
    assert job["settings"] == request["settings"]

    status, body = await client.put(f"/v1/jobs/{jid}", request)            # idempotent
    assert status == 200 and body["job_id"] == jid
    status, body = await client.put(f"/v1/jobs/{jid}", dict(request, preset="high"))
    assert status == 409 and body["error"]["code"] == "conflict"

    job = await client.wait_job(jid, "succeeded")
    assert job["overall_progress"] == 1.0 and job["stage"] == "package" and job["stage_progress"] == 1.0
    assert job["stage_index"] == 8 and job["stage_count"] == 9
    assert job["queue_position"] == 0 and job["error"] is None
    assert job["created_at"] <= job["started_at"] <= job["finished_at"]
    assert job["diagnostics"]["fake_worker"] is True and job["diagnostics"]["registered_images"] == 3
    assert job["diagnostics"]["mesh_faces"] == 0                           # merged from result.json
    assert job["diagnostics"]["input_images"] == len(photos)
    assert [(a["name"], a["kind"]) for a in job["artifacts"]] == [
        ("sparse_preview.json", "preview"), ("model.glb", "model"), ("cameras.json", "cameras"),
        ("diagnostics.json", "diagnostics"), ("pipeline.log", "log")]
    for a in job["artifacts"]:
        status, data, _ = await client.raw("GET", f"/v1/jobs/{jid}/artifacts/{a['name']}")
        assert status == 200 and len(data) == a["size"] and hashlib.sha256(data).hexdigest() == a["sha256"]

    events = await client.all_events(jid)
    assert [e["seq"] for e in events] == list(range(1, len(events) + 1))
    assert [e["stage"] for e in events if e["type"] == "stage_start"] == FAKE_STAGES
    assert [e["stage"] for e in events if e["type"] == "stage_end"] == FAKE_STAGES
    overall = [e["overall"] for e in events if e["type"].startswith("stage_")]
    assert overall == sorted(overall) and overall[-1] == 1.0
    names = [e["data"]["name"] for e in events if e["type"] == "artifact"]
    assert names == ["sparse_preview.json", "model.glb", "cameras.json", "diagnostics.json"]
    assert set(events[0]) == {"seq", "t", "type", "stage", "progress", "overall", "message", "data"}

    status, body = await client.get("/v1/jobs")
    assert [j["job_id"] for j in body["jobs"]] == [jid] and "events" not in body["jobs"][0]
    status, body = await client.get(f"/v1/jobs?session_id={session_id}")
    assert [j["job_id"] for j in body["jobs"]] == [jid]
    status, body = await client.get(f"/v1/jobs?session_id={new_id()}")
    assert body == {"jobs": []}
    status, body = await client.get("/v1/sessions")
    assert body["sessions"][0]["jobs"] == [jid]


async def test_job_json_follows_the_worker_contract(harness, client, session_id, photos):
    jid = await client.submit(session_id, {"mode": "succeed"}, preset="high")
    await client.wait_job(jid, "succeeded")
    doc = json.loads((harness.job_dir(jid) / "job.json").read_text())
    assert set(doc) == {"job_id", "session_id", "preset", "settings", "attempt", "originals_dir", "capture_path",
                        "files", "limits"}
    assert doc["job_id"] == jid and doc["session_id"] == session_id and doc["preset"] == "high"
    assert doc["attempt"] == 1 and doc["limits"] == {"threads": 2, "memory_mb": 512}
    assert doc["originals_dir"] == str(harness.session_dir(session_id) / "originals")
    assert doc["capture_path"] == str(harness.session_dir(session_id) / "capture.json")
    assert os.path.isabs(doc["originals_dir"]) and os.path.isfile(doc["capture_path"])
    assert doc["files"] == [{"id": fid, "name": f"IMG_{fid}.jpg", "size": len(b),
                             "sha256": hashlib.sha256(b).hexdigest()} for fid, b in photos.items()]
    for f in doc["files"]:
        assert os.path.getsize(os.path.join(doc["originals_dir"], f["id"] + ".bin")) == f["size"]
    # Thread/memory limits also reach the worker through its environment.
    job = await client.job(jid)
    assert job["diagnostics"]["threads_env"] == "2" and job["diagnostics"]["omp_env"] == "2"
    assert job["diagnostics"]["memory_env"] == "512"
    assert job["diagnostics"]["cwd"] == str(harness.job_dir(jid) / "work")
    assert "FAKE WORKER" in (harness.job_dir(jid) / "pipeline.log").read_text()   # stdout → pipeline.log


async def test_diagnosed_failure(harness, client, session_id):
    jid = await client.submit(session_id, {"mode": "fail"})
    job = await client.wait_job(jid, "failed")
    assert job["error"] == {"code": "insufficient_registration",
                            "message": "Only 2 of 12 photos could be registered.",
                            "guidance": ["Take more photos with more overlap."]}
    assert job["stage"] == "sfm" and job["overall_progress"] < 1.0 and job["finished_at"]
    assert [a["name"] for a in job["artifacts"]] == ["pipeline.log"]         # no model, but the log
    status, body = await client.get(f"/v1/jobs/{jid}/artifacts/model.glb")
    assert status == 404
    events = await client.all_events(jid)
    assert events[-1]["type"] == "error" and events[-1]["data"]["code"] == "insufficient_registration"


async def test_crash(client, session_id):
    jid = await client.submit(session_id, {"mode": "crash"})
    job = await client.wait_job(jid, "failed")
    assert job["error"]["code"] == "worker_crashed" and "code 1" in job["error"]["message"]
    assert job["error"]["guidance"]
    status, data, _ = await client.raw("GET", f"/v1/jobs/{jid}/artifacts/pipeline.log")
    assert status == 200 and b"simulated crash" in data and b"failed (worker_crashed)" in data


async def test_exit_0_without_result_json_is_a_failure(harness, client, session_id):
    jid = await client.submit(session_id, {"mode": "no_result"})
    job = await client.wait_job(jid, "failed")
    assert job["error"]["code"] == "invalid_result" and "result.json" in job["error"]["message"]
    assert (harness.job_dir(jid) / "out" / "model.glb").exists()            # it "looked" finished
    assert not (harness.job_dir(jid) / "out" / "result.json").exists()
    # A job that did not succeed offers no model — only provisional/diagnostic files and the log.
    assert [a["name"] for a in job["artifacts"]] == ["sparse_preview.json", "diagnostics.json", "pipeline.log"]
    status, body = await client.get(f"/v1/jobs/{jid}/artifacts/model.glb")
    assert status == 404


async def test_exit_0_with_wrong_artifact_sha256_is_a_failure(harness, client, session_id):
    jid = await client.submit(session_id, {"mode": "bad_sha"})
    job = await client.wait_job(jid, "failed")
    assert job["error"]["code"] == "invalid_result" and "SHA-256" in job["error"]["message"]
    assert (harness.job_dir(jid) / "out" / "result.json").exists()
    assert "model.glb" not in [a["name"] for a in job["artifacts"]]
    status, body = await client.get(f"/v1/jobs/{jid}/artifacts/model.glb")
    assert status == 404


def test_check_result_rejects_everything_that_is_not_a_verified_result(tmp_path):
    out = tmp_path / "out"
    out.mkdir()
    payload = b"model bytes"
    good = {"name": "model.glb", "size": len(payload), "sha256": hashlib.sha256(payload).hexdigest(),
            "kind": "model"}

    def result(doc) -> tuple:
        (out / "result.json").write_text(doc if isinstance(doc, str) else json.dumps(doc))
        return check_result(tmp_path)

    assert check_result(tmp_path)[0] is None                                 # no result.json
    (out / "model.glb").write_bytes(payload)
    ok, problem = result({"ok": True, "artifacts": [good], "diagnostics": {"a": 1}})
    assert problem is None and ok == {"artifacts": [good], "diagnostics": {"a": 1}}

    assert result("{truncated")[0] is None
    assert result([1, 2])[0] is None
    assert result({"ok": False, "artifacts": [good]})[0] is None
    assert result({"ok": "yes", "artifacts": [good]})[0] is None
    assert result({"ok": True})[0] is None
    assert result({"ok": True, "artifacts": []})[0] is None
    assert result({"ok": True, "artifacts": [dict(good, size=len(payload) + 1)]})[0] is None
    assert result({"ok": True, "artifacts": [dict(good, sha256="0" * 64)]})[0] is None
    assert result({"ok": True, "artifacts": [dict(good, name="missing.glb")]})[0] is None
    assert result({"ok": True, "artifacts": [dict(good, name="../out/model.glb")]})[0] is None
    assert result({"ok": True, "artifacts": [dict(good, name="result.json")]})[0] is None
    assert result({"ok": True, "artifacts": ["model.glb"]})[0] is None
    os.symlink(out / "model.glb", out / "link.glb")                          # symlinks are not artifacts
    assert result({"ok": True, "artifacts": [dict(good, name="link.glb")]})[0] is None


async def test_worker_that_cannot_be_started(harness, photos):
    await harness.start(worker_cmd=["/nonexistent/pocket3d-worker", "--job-dir", "{job_dir}"])
    c = await harness.paired()
    sid = await c.create_session(photos)
    jid = await c.submit(sid)
    job = await c.wait_job(jid, "failed")
    assert job["error"]["code"] == "worker_launch_failed"
    status, body = await c.get("/v1/status")
    assert body["queue"] == {"running": 0, "queued": 0}


def test_fake_worker_refuses_to_run_unless_explicitly_allowed(tmp_path):
    env = {k: v for k, v in os.environ.items() if k != "POCKET3D_ALLOW_FAKE_WORKER"}
    env["PYTHONPATH"] = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    cmd = [a.replace("{job_dir}", str(tmp_path)) for a in FAKE_WORKER_CMD]
    r = subprocess.run(cmd, env=env, capture_output=True, text=True, timeout=30)
    assert r.returncode == 4 and "refuses to run" in r.stdout
    assert list(tmp_path.iterdir()) == []


def test_default_worker_is_the_real_pipeline():
    from pocket3d_companion.config import Config, load_config
    assert Config().worker_cmd == [sys.executable, "-m", "pocket3d_companion.pipeline", "--job-dir", "{job_dir}"]
    cfg = load_config({"data_dir": "/tmp/pocket3d-nonexistent"}, env={})
    assert "fake" not in " ".join(cfg.worker_cmd)
    cfg = load_config({"data_dir": "/tmp/pocket3d-nonexistent"}, env={"POCKET3D_WORKER_CMD": '["a","b c"]'})
    assert cfg.worker_cmd == ["a", "b c"]


# -- cancellation ----------------------------------------------------------------------------

async def test_cancel_running_job_kills_the_whole_process_group(harness, client, session_id):
    jid = await client.submit(session_id, {"mode": "sleep", "seconds": 60, "spawn_child": True})
    await client.wait_job(jid, "running")
    work = harness.job_dir(jid) / "work"
    await wait_until(lambda: (work / "child.pid").exists() and (work / "child.pid").read_text())
    worker, child = int((work / "worker.pid").read_text()), int((work / "child.pid").read_text())
    assert pid_alive(worker) and pid_alive(child)
    assert os.getpgid(worker) == worker != os.getpgrp()          # its own process group / session
    assert os.getpgid(child) == worker and os.getsid(worker) == worker

    status, body = await client.post(f"/v1/jobs/{jid}/cancel")
    assert status == 200 and body["state"] in ("cancelling", "cancelled")
    job = await client.wait_job(jid, "cancelled")
    assert job["error"] is None and job["finished_at"] and job["overall_progress"] < 1.0
    assert not pid_alive(worker) and not pid_alive(child)
    assert "model.glb" not in [a["name"] for a in job["artifacts"]]

    status, body = await client.post(f"/v1/jobs/{jid}/cancel")   # idempotent on terminal states
    assert status == 200 and body["state"] == "cancelled"
    status, body = await client.get("/v1/status")
    assert body["queue"] == {"running": 0, "queued": 0}


async def test_cancel_escalates_to_sigkill_when_sigterm_is_ignored(harness, photos):
    await harness.start(cancel_grace_s=0.4)
    c = await harness.paired()
    sid = await c.create_session(photos)
    jid = await c.submit(sid, {"mode": "sleep", "seconds": 60, "ignore_sigterm": True, "spawn_child": True})
    await c.wait_job(jid, "running")
    work = harness.job_dir(jid) / "work"
    await wait_until(lambda: (work / "child.pid").exists() and (work / "child.pid").read_text())
    await wait_until(lambda: c.all_events(jid))                   # the worker installed its handler
    pids = harness.worker_pids()

    t0 = time.monotonic()
    status, body = await c.post(f"/v1/jobs/{jid}/cancel")
    assert body["state"] == "cancelling"                   # transitional while it is terminated
    status, body = await c.get(f"/v1/jobs/{jid}")
    assert body["job"]["state"] == "cancelling"
    await c.wait_job(jid, "cancelled")
    assert 0.3 < time.monotonic() - t0 < 5
    assert not any(pid_alive(p) for p in pids)


async def test_cancel_queued_job_never_starts_it(harness, client, session_id):
    first = await client.submit(session_id, {"mode": "sleep", "seconds": 60})
    second = await client.submit(session_id, {"mode": "succeed"})
    await client.wait_job(first, "running")
    assert (await client.job(second))["state"] == "queued"
    status, body = await client.post(f"/v1/jobs/{second}/cancel")
    assert body["state"] == "cancelled" and body["started_at"] is None
    await client.post(f"/v1/jobs/{first}/cancel")
    await client.wait_job(first, "cancelled")
    await asyncio.sleep(0.2)
    job = await client.job(second)
    assert job["state"] == "cancelled" and job["started_at"] is None
    assert not (harness.job_dir(second) / "job.json").exists()    # the worker was never launched


# -- watchdogs -------------------------------------------------------------------------------

async def test_memory_watchdog_kills_and_fails_the_job(harness, photos):
    await harness.start(job_memory_mb=96, watchdog_interval_s=0.05)
    c = await harness.paired()
    sid = await c.create_session(photos)
    ok = await c.submit(sid, {"mode": "succeed", "step_delay": 0.05})
    job = await c.wait_job(ok, "succeeded")
    assert 0 < job["diagnostics"]["peak_rss_mb"] < 96              # peak is recorded for normal jobs
    # The worker's own per-stage figures (same name, but an object) do not replace the number.
    assert job["diagnostics"]["peak_rss_mb_by_stage"] == {"ingest": 12.5, "overall": 12.5}

    jid = await c.submit(sid, {"mode": "memory", "mb": 200, "seconds": 60})
    job = await c.wait_job(jid, "failed")
    assert job["error"]["code"] == "memory_limit" and "96 MB" in job["error"]["message"]
    assert job["error"]["guidance"]
    assert job["diagnostics"]["peak_rss_mb"] > 96
    assert not any(pid_alive(p) for p in harness.worker_pids())


async def test_wall_clock_timeout_fails_the_job(harness, photos):
    await harness.start(job_timeout_s=0.4, watchdog_interval_s=0.05)
    c = await harness.paired()
    sid = await c.create_session(photos)
    jid = await c.submit(sid, {"mode": "sleep", "seconds": 60})
    job = await c.wait_job(jid, "failed")
    assert job["error"]["code"] == "timeout"
    assert not any(pid_alive(p) for p in harness.worker_pids())


# -- queue -----------------------------------------------------------------------------------

async def test_queue_is_fifo_with_positions_and_one_job_at_a_time(harness, client, session_id):
    blocker = await client.submit(session_id, {"mode": "sleep", "seconds": 60})
    await client.wait_job(blocker, "running")
    queued = [await client.submit(session_id, {"mode": "succeed", "step_delay": 0.02}) for _ in range(3)]
    states = [await client.job(j) for j in queued]
    assert [j["state"] for j in states] == ["queued"] * 3
    assert [j["queue_position"] for j in states] == [1, 2, 3]
    assert (await client.job(blocker))["queue_position"] == 0
    status, body = await client.get("/v1/status")
    assert body["queue"] == {"running": 1, "queued": 3}

    # Cancelling one in the middle closes the gap.
    await client.post(f"/v1/jobs/{queued[1]}/cancel")
    assert [(await client.job(j))["queue_position"] for j in queued] == [1, 0, 2]

    await client.post(f"/v1/jobs/{blocker}/cancel")
    done = [await client.wait_job(j, "succeeded") for j in (queued[0], queued[2])]
    assert done[0]["started_at"] <= done[0]["finished_at"] <= done[1]["started_at"]   # strictly one by one
    assert (await client.job(queued[1]))["state"] == "cancelled"
    status, body = await client.get("/v1/status")
    assert body["queue"] == {"running": 0, "queued": 0}


async def test_bounded_parallelism(harness, photos):
    await harness.start(max_parallel_jobs=2)
    c = await harness.paired()
    sid = await c.create_session(photos)
    jobs = [await c.submit(sid, {"mode": "sleep", "seconds": 60}) for _ in range(4)]
    await c.wait_job(jobs[0], "running")
    await c.wait_job(jobs[1], "running")
    await asyncio.sleep(0.2)
    assert [(await c.job(j))["state"] for j in jobs] == ["running", "running", "queued", "queued"]
    assert [(await c.job(j))["queue_position"] for j in jobs] == [0, 0, 1, 2]
    status, body = await c.get("/v1/status")
    assert body["queue"] == {"running": 2, "queued": 2} and body["resources"]["max_parallel_jobs"] == 2

    await c.post(f"/v1/jobs/{jobs[0]}/cancel")
    await c.wait_job(jobs[2], "running")
    assert [(await c.job(j))["state"] for j in jobs[1:]] == ["running", "running", "queued"]
    assert (await c.job(jobs[3]))["queue_position"] == 1


# -- retry -----------------------------------------------------------------------------------

async def test_retry_reuses_the_job_directory_and_continues_event_numbering(harness, client, session_id):
    jid = await client.submit(session_id, {"mode": "succeed", "succeed_from_attempt": 2})
    failed = await client.wait_job(jid, "failed")
    assert failed["attempt"] == 1 and failed["error"]["code"] == "insufficient_registration"
    first_events = await client.all_events(jid)
    marker = harness.job_dir(jid) / "out" / "stale.bin"
    marker.write_bytes(b"left over from attempt 1")

    status, body = await client.post(f"/v1/jobs/{jid}/retry")
    assert status == 200
    job = body
    assert job["state"] in ("queued", "running") and job["attempt"] == 2 and job["error"] is None
    assert job["finished_at"] is None and job["overall_progress"] == 0.0 and job["artifacts"] == []

    job = await client.wait_job(jid, "succeeded")
    assert job["attempt"] == 2 and job["error"] is None
    assert not marker.exists()                                            # out/ was cleared
    # work/ was kept for the retry (the "reused" stages below prove it) and is cleared once the
    # job has succeeded: intermediate data is not needed again
    for _ in range(100):
        if not any((harness.job_dir(jid) / "work").iterdir()):
            break
        await asyncio.sleep(0.02)
    assert not any((harness.job_dir(jid) / "work").iterdir())

    events = await client.all_events(jid)
    assert events[:len(first_events)] == first_events                     # history is preserved
    assert [e["seq"] for e in events] == list(range(1, len(events) + 1))  # numbering continues
    second = events[len(first_events):]
    reused = [e["stage"] for e in second if e["type"] == "stage_end" and e["data"].get("reused")]
    assert reused == ["ingest", "features", "matching"]                   # checkpoints from attempt 1
    log_text = (harness.job_dir(jid) / "pipeline.log").read_text()
    assert "attempt 1 started" in log_text and "attempt 2 started" in log_text

    status, body = await client.post(f"/v1/jobs/{jid}/retry")             # not for succeeded jobs
    assert status == 409 and body["error"]["code"] == "conflict"


async def test_retry_is_only_for_failed_cancelled_or_interrupted_jobs(client, session_id):
    jid = await client.submit(session_id, {"mode": "sleep", "seconds": 60})
    await client.wait_job(jid, "running")
    status, body = await client.post(f"/v1/jobs/{jid}/retry")
    assert status == 409 and body["error"]["code"] == "conflict"
    await client.post(f"/v1/jobs/{jid}/cancel")
    await client.wait_job(jid, "cancelled")
    status, body = await client.post(f"/v1/jobs/{jid}/retry")
    assert status == 200 and body["attempt"] == 2
    await client.wait_job(jid, "running")
    await client.post(f"/v1/jobs/{jid}/cancel")
    await client.wait_job(jid, "cancelled")


async def test_retry_after_the_photos_changed_does_not_reuse_old_work(harness, client, photos):
    sid = await client.create_session(photos)
    jid = await client.submit(sid, {"mode": "succeed", "succeed_from_attempt": 2})
    await client.wait_job(jid, "failed")
    changed = dict(photos, **{"0003": make_image(seed=1234)})
    from conftest import manifest
    status, _ = await client.put(f"/v1/sessions/{sid}", manifest(changed))
    assert status == 200
    status, body = await client.post(f"/v1/jobs/{jid}/retry")
    assert status == 409 and body["error"]["code"] == "incomplete_upload"
    await client.upload(sid, "0003", changed["0003"])
    status, body = await client.post(f"/v1/jobs/{jid}/retry")
    assert status == 200
    await client.wait_job(jid, "succeeded")
    # work/ started over: no stage of attempt 1 was reused although its checkpoints had existed
    events = await client.all_events(jid)
    last_attempt = events[max(i for i, e in enumerate(events) if e["type"] == "stage_start" and e["stage"] == "ingest"):]
    assert not [e for e in last_attempt if e["type"] == "stage_end" and e["data"].get("reused")]
    doc = json.loads((harness.job_dir(jid) / "job.json").read_text())
    assert doc["files"][2]["sha256"] == hashlib.sha256(changed["0003"]).hexdigest()


# -- artifacts -------------------------------------------------------------------------------

async def test_artifact_download_with_range_and_etag(client, session_id):
    jid = await client.submit(session_id, {"mode": "succeed"})
    job = await client.wait_job(jid, "succeeded")
    meta = next(a for a in job["artifacts"] if a["name"] == "model.glb")
    url = f"/v1/jobs/{jid}/artifacts/model.glb"
    size = meta["size"]

    status, full, headers = await client.raw("GET", url)
    assert status == 200 and len(full) == size and hashlib.sha256(full).hexdigest() == meta["sha256"]
    assert headers["ETag"] == f'"{meta["sha256"]}"' and headers["Accept-Ranges"] == "bytes"
    assert headers["Content-Length"] == str(size) and headers["Content-Type"] == "model/gltf-binary"

    status, part, headers = await client.raw("GET", url, headers={"Range": "bytes=1000-"})   # resume
    assert status == 206 and part == full[1000:]
    assert headers["Content-Range"] == f"bytes 1000-{size - 1}/{size}" and headers["ETag"] == f'"{meta["sha256"]}"'
    status, part, headers = await client.raw("GET", url, headers={"Range": "bytes=10-19"})
    assert status == 206 and part == full[10:20] and headers["Content-Range"] == f"bytes 10-19/{size}"
    status, part, headers = await client.raw("GET", url, headers={"Range": "bytes=-7"})
    assert status == 206 and part == full[-7:]
    status, part, headers = await client.raw("GET", url, headers={"Range": f"bytes=5-{size + 999}"})
    assert status == 206 and part == full[5:]
    status, part, headers = await client.raw("GET", url, headers={"Range": "bytes=0-0"})
    assert status == 206 and part == full[:1]

    status, body, headers = await client.raw("GET", url, headers={"Range": f"bytes={size}-"})
    assert status == 416 and headers["Content-Range"] == f"bytes */{size}"
    assert json.loads(body)["error"]["code"] == "bad_request"
    status, body, headers = await client.raw("GET", url, headers={"Range": "bytes=abc"})
    assert status == 416

    # If-Range with the right ETag resumes; with a stale one the whole file is sent again.
    status, part, _ = await client.raw("GET", url, headers={"Range": "bytes=100-", "If-Range": f'"{meta["sha256"]}"'})
    assert status == 206 and part == full[100:]
    status, part, _ = await client.raw("GET", url, headers={"Range": "bytes=100-", "If-Range": '"' + "0" * 64 + '"'})
    assert status == 200 and part == full
    status, part, _ = await client.raw("GET", url, headers={"If-None-Match": f'"{meta["sha256"]}"'})
    assert status == 304 and part == b""

    status, body = await client.get(f"/v1/jobs/{jid}/artifacts/nope.glb")
    assert status == 404 and body["error"]["code"] == "not_found"
    status, body = await client.get(f"/v1/jobs/{new_id()}/artifacts/model.glb")
    assert status == 404


async def test_preview_artifact_and_log_are_available_before_the_job_finishes(client, session_id):
    jid = await client.submit(session_id, {"mode": "succeed", "step_delay": 0.25})

    async def preview_listed():
        job = await client.job(jid)
        return job if any(a["name"] == "sparse_preview.json" for a in job["artifacts"]) else None
    job = await wait_until(preview_listed)
    assert job["state"] == "running" and 0 < job["overall_progress"] < 1
    assert job["stage"] in FAKE_STAGES and job["stage_count"] == 9
    status, data, headers = await client.raw("GET", f"/v1/jobs/{jid}/artifacts/sparse_preview.json")
    assert status == 200 and json.loads(data) == {"fake": True, "points": []}
    assert headers["Content-Type"] == "application/json"
    status, data, headers = await client.raw("GET", f"/v1/jobs/{jid}/artifacts/pipeline.log")
    assert status == 200 and b"FAKE WORKER" in data and "ETag" not in headers        # still growing
    status, body = await client.get(f"/v1/jobs/{jid}/artifacts/model.glb")
    assert status == 404                                                             # not announced yet
    await client.post(f"/v1/jobs/{jid}/cancel")
    await client.wait_job(jid, "cancelled")


# -- long poll -------------------------------------------------------------------------------

async def test_long_poll_semantics(client, session_id):
    jid = await client.submit(session_id, {"mode": "sleep", "seconds": 60})
    await client.wait_job(jid, "running")
    async def all_three():                                      # then the fake worker goes idle
        events = await client.all_events(jid)
        return events if len(events) >= 3 else None
    events = await wait_until(all_three)
    last = events[-1]["seq"]
    assert last == 3

    # `since` filters.
    status, body = await client.get(f"/v1/jobs/{jid}?since=1")
    assert [e["seq"] for e in body["events"]] == [2, 3] and body["last_seq"] == 3
    # Events available → returns at once even with wait.
    t0 = time.monotonic()
    status, body = await client.get(f"/v1/jobs/{jid}?since=0&wait=10")
    assert len(body["events"]) == 3 and time.monotonic() - t0 < 1
    # Nothing new, no wait → returns at once and empty.
    t0 = time.monotonic()
    status, body = await client.get(f"/v1/jobs/{jid}?since={last}")
    assert body["events"] == [] and body["last_seq"] == last and time.monotonic() - t0 < 0.5
    # Nothing new, wait → blocks for the full wait.
    t0 = time.monotonic()
    status, body = await client.get(f"/v1/jobs/{jid}?since={last}&wait=0.5")
    assert status == 200 and body["events"] == [] and body["job"]["state"] == "running"
    assert 0.45 <= time.monotonic() - t0 < 2
    # A state change wakes a waiting poll early.
    t0 = time.monotonic()
    poll = asyncio.ensure_future(client.get(f"/v1/jobs/{jid}?since={last}&wait=20"))
    await asyncio.sleep(0.2)
    assert not poll.done()
    await client.post(f"/v1/jobs/{jid}/cancel")
    status, body = await poll
    assert time.monotonic() - t0 < 5 and body["job"]["state"] in ("cancelling", "cancelled")
    await client.wait_job(jid, "cancelled")
    # Terminal job → never blocks.
    t0 = time.monotonic()
    status, body = await client.get(f"/v1/jobs/{jid}?since={last}&wait=20")
    assert body["job"]["state"] == "cancelled" and time.monotonic() - t0 < 1

    for bad in ("since=-1", "since=x", "wait=-1", "wait=nan", "wait=inf", "since=1.5"):
        status, body = await client.get(f"/v1/jobs/{jid}?{bad}")
        assert status == 400 and body["error"]["code"] == "bad_request", bad
    # `wait` above the maximum is clamped, not rejected.
    status, body = await client.get(f"/v1/jobs/{jid}?since=0&wait=3600")
    assert status == 200


async def test_long_poll_wakes_up_when_an_event_arrives(client, session_id):
    jid = await client.submit(session_id, {"mode": "succeed", "step_delay": 0.3})
    await client.wait_job(jid, "running")
    seen = (await client.get(f"/v1/jobs/{jid}?since=0&wait=5"))[1]["last_seq"]
    t0 = time.monotonic()
    status, body = await client.get(f"/v1/jobs/{jid}?since={seen}&wait=20")
    elapsed = time.monotonic() - t0
    assert body["events"] and body["events"][0]["seq"] == seen + 1 and elapsed < 5
    await client.post(f"/v1/jobs/{jid}/cancel")
    await client.wait_job(jid, "cancelled")


async def test_queued_job_long_poll_wakes_when_it_starts(client, session_id):
    blocker = await client.submit(session_id, {"mode": "sleep", "seconds": 60})
    await client.wait_job(blocker, "running")
    jid = await client.submit(session_id, {"mode": "sleep", "seconds": 60})
    poll = asyncio.ensure_future(client.get(f"/v1/jobs/{jid}?since=0&wait=20"))
    await asyncio.sleep(0.2)
    assert not poll.done()
    await client.post(f"/v1/jobs/{blocker}/cancel")
    status, body = await asyncio.wait_for(poll, 10)
    assert body["job"]["state"] == "running" or body["events"]
    await client.post(f"/v1/jobs/{jid}/cancel")
    await client.wait_job(jid, "cancelled")


# -- events ----------------------------------------------------------------------------------

async def test_event_split_across_two_writes_is_delivered_once_and_whole(client, session_id):
    jid = await client.submit(session_id, {"mode": "succeed", "partial_line": True})
    await client.wait_job(jid, "succeeded")
    events = await client.all_events(jid)
    assert [e["seq"] for e in events] == list(range(1, len(events) + 1))
    progress = [e for e in events if e["type"] == "stage_progress" and e["stage"] == "features"]
    assert len(progress) == 1 and progress[0]["message"] == "half way" and progress[0]["progress"] == 0.5
    assert len([e for e in events if e["type"] == "stage_progress"]) == len(FAKE_STAGES)


async def test_event_tailing_tolerates_garbage_and_partial_lines(harness, client, session_id):
    jid = await client.submit(session_id, {"mode": "crash"})
    await client.wait_job(jid, "failed")
    manager: JobManager = harness.server.jobs
    job = manager.jobs[jid]
    n = job.last_seq
    with open(job.events_path, "ab") as f:
        f.write(b'not json\n[1,2]\n\n{"seq":99,"t":1,"type":"log","message":"ok"}\n{"seq":100,"type":"lo')
    assert manager._tail(job) is True
    assert job.last_seq == n + 1 and job.events[-1]["message"] == "ok" and job.events[-1]["seq"] == n + 1
    assert manager._tail(job) is False                          # the unterminated tail is left alone
    with open(job.events_path, "ab") as f:
        f.write(b'g","message":"rest","progress":7,"overall":"x","stage":5}\n')
    assert manager._tail(job) is True
    last = job.events[-1]
    assert last["seq"] == n + 2 and last["message"] == "rest"
    assert last["progress"] == 1.0 and last["overall"] is None and last["stage"] is None   # sanitised


async def test_event_responses_are_capped_and_paged_with_last_seq(harness, client, session_id):
    jid = await client.submit(session_id, {"mode": "crash"})
    await client.wait_job(jid, "failed")
    job = harness.server.jobs.jobs[jid]
    n = job.last_seq
    with open(job.events_path, "ab") as f:
        for i in range(2500):
            f.write(json.dumps({"seq": i, "t": 1.0, "type": "log", "message": f"line {i}"}).encode() + b"\n")
    assert harness.server.jobs._tail(job) is True
    status, body = await client.get(f"/v1/jobs/{jid}?since=0")
    assert len(body["events"]) == 2000 and body["last_seq"] == 2000
    status, body = await client.get(f"/v1/jobs/{jid}?since={body['last_seq']}")
    assert [e["seq"] for e in body["events"]] == list(range(2001, n + 2501)) and body["last_seq"] == n + 2500
    status, body = await client.get(f"/v1/jobs/{jid}?since={n + 2500}")
    assert body["events"] == [] and body["last_seq"] == n + 2500
    status, body = await client.get(f"/v1/jobs/{jid}?since=999999")          # beyond the end: nothing
    assert body["events"] == [] and body["last_seq"] == n + 2500


# -- delete ----------------------------------------------------------------------------------

async def test_delete_job_cancels_it_and_removes_its_data(harness, client, session_id):
    jid = await client.submit(session_id, {"mode": "sleep", "seconds": 60, "spawn_child": True})
    await client.wait_job(jid, "running")
    await wait_until(lambda: (harness.job_dir(jid) / "work" / "child.pid").exists())
    await asyncio.sleep(0.05)
    pids = harness.worker_pids()
    status, body = await client.delete(f"/v1/jobs/{jid}")
    assert status == 204 and body is None
    assert not harness.job_dir(jid).exists() and not any(pid_alive(p) for p in pids)
    for method, path in (("GET", f"/v1/jobs/{jid}"), ("DELETE", f"/v1/jobs/{jid}"),
                         ("POST", f"/v1/jobs/{jid}/cancel"), ("GET", f"/v1/jobs/{jid}/artifacts/pipeline.log")):
        status, body = await client.call(method, path)
        assert status == 404
    status, body = await client.get(f"/v1/sessions/{session_id}")
    assert status == 200 and body["complete"] is True           # the photographs are untouched
    # The id can be used again for a new job.
    await client.submit(session_id, {"mode": "succeed"}, job_id=jid)
    await client.wait_job(jid, "succeeded")


async def test_housekeeping_clears_stale_work_and_abandoned_uploads_but_nothing_in_use(harness, client, photos):
    """Disk use is bounded: work data of failed/cancelled jobs goes after work_ttl_s, uploads that
    were never completed and belong to no job after upload_ttl_s. Finished results, recent
    failures (retry reuses them) and sessions with jobs are never touched."""
    sid = await client.create_session(photos)
    failed_id = await client.submit(sid, {"mode": "fail"})
    await client.wait_job(failed_id, "failed")
    ok_id = await client.submit(sid, {"mode": "succeed"})
    await client.wait_job(ok_id, "succeeded")
    work = harness.job_dir(failed_id) / "work"
    (work / "big.bin").write_bytes(b"x" * 1000)
    # an upload that was started and abandoned
    abandoned = new_id()
    spec = [{"id": f"f{i}", "name": f"{i}.jpg", "size": 10, "sha256": "0" * 64} for i in range(3)]
    status, _ = await client.put(f"/v1/sessions/{abandoned}", {"name": "x", "capture": {}, "files": spec})
    assert status == 200
    server = harness.server
    now = time.time()
    r = await server.housekeeping(now + 60)                       # nothing is old enough
    assert r == {"jobs": [], "sessions": []} and (work / "big.bin").exists()
    r = await server.housekeeping(now + server.cfg.work_ttl_s + 60)
    assert r["jobs"] == [failed_id] and not any(work.iterdir())
    assert (harness.job_dir(ok_id) / "out" / "result.json").exists()         # results stay
    assert harness.session_dir(abandoned).exists()
    r = await server.housekeeping(now + server.cfg.upload_ttl_s + 60)
    assert r["sessions"] == [abandoned] and not harness.session_dir(abandoned).exists()
    assert harness.session_dir(sid).exists()                                  # complete + has jobs: kept
    status, body = await client.get(f"/v1/jobs/{ok_id}")
    assert status == 200 and body["job"]["state"] == "succeeded"


async def test_per_device_job_cap_and_reserved_settings(harness, client, session_id):
    ids = []
    for _ in range(harness.server.cfg.max_active_jobs_per_device):
        ids.append(await client.submit(session_id, {"mode": "sleep", "seconds": 30}))
    status, body = await client.put(f"/v1/jobs/{new_id()}", {"session_id": session_id, "preset": "preview",
                                                             "settings": {"_test": {"mode": "sleep", "seconds": 30}}})
    assert status == 429 and body["error"]["code"] == "limit_exceeded"
    for j in ids:
        await client.post(f"/v1/jobs/{j}/cancel")
    for j in ids:
        await client.wait_job(j, "cancelled")
