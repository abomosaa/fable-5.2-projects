#!/usr/bin/env python3
"""Drive a RUNNING companion over its real HTTPS API exactly like the phone does.

    companion/.venv-dev/bin/python tools/e2e_companion_http.py \
        --pairing-file <companion data dir>/pairing.txt --images datasets/smoke/images \
        --preset preview --out results/_companion_http/transcript.json

Steps (each is checked, and the transcript with timings is written as evidence):
pair with the one-time code (certificate pinned by SHA-256 fingerprint) → reject of a wrong
token → session manifest → resumable upload (one file is deliberately interrupted mid-way and
resumed from the offset the server reports; one upload with a wrong offset must be refused) →
job submission → long-poll of real progress events → provisional preview download while the
job is still running → artifact download with an HTTP Range resume → SHA-256 verification.

This is an independent client: it shares no code with the Android app or the server.
"""
from __future__ import annotations

import argparse
import asyncio
import hashlib
import json
import sys
import time
import uuid
from pathlib import Path
from urllib.parse import parse_qs, urlparse

import aiohttp


async def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--pairing-file", required=True, type=Path)
    ap.add_argument("--images", required=True, type=Path)
    ap.add_argument("--preset", default="preview")
    ap.add_argument("--host", default="127.0.0.1", help="address to use instead of the advertised ones")
    ap.add_argument("--out", type=Path)
    ap.add_argument("--save-artifacts", type=Path)
    ap.add_argument("--limit", type=int, default=0)
    a = ap.parse_args()

    uri = a.pairing_file.read_text().strip().splitlines()[0]
    q = parse_qs(urlparse(uri).query)
    port, fp, code = int(q["port"][0]), q["fp"][0], q["code"][0]
    base = f"https://{a.host}:{port}"
    pin = aiohttp.Fingerprint(bytes.fromhex(fp))
    log: dict = {"base": base, "fingerprint_pinned": fp[:16] + "…", "steps": []}
    t_start = time.time()

    def step(name, **kw):
        entry = {"step": name, "t": round(time.time() - t_start, 2), **kw}
        log["steps"].append(entry)
        print(json.dumps(entry))

    files = sorted(p for p in a.images.iterdir() if p.suffix.lower() in (".jpg", ".jpeg", ".png"))
    if a.limit:
        files = files[: a.limit]
    timeout = aiohttp.ClientTimeout(total=None, sock_read=120)
    async with aiohttp.ClientSession(timeout=timeout) as http:
        # a wrong pin must fail the TLS handshake (no silent fallback)
        try:
            async with http.get(f"{base}/v1/hello", ssl=aiohttp.Fingerprint(bytes(32))):
                pass
            step("wrong_fingerprint", ok=False)
            return 1
        except aiohttp.ServerFingerprintMismatch:
            step("wrong_fingerprint_rejected", ok=True)
        async with http.get(f"{base}/v1/hello", ssl=pin) as r:
            hello = await r.json()
        step("hello", status=r.status, product=hello["product"], api=hello["api"], version=hello["version"])
        async with http.get(f"{base}/v1/status", ssl=pin) as r:
            step("status_without_token", status=r.status)
            assert r.status == 401
        async with http.post(f"{base}/v1/pair", ssl=pin, json={"code": code, "device_name": "e2e-http-client"}) as r:
            pair = await r.json()
            assert r.status == 200, pair
        token = pair["token"]
        H = {"Authorization": f"Bearer {token}"}
        step("paired", status=200, server=pair.get("server_name"))
        async with http.post(f"{base}/v1/pair", ssl=pin, json={"code": code, "device_name": "again"}) as r:
            step("pairing_code_is_single_use", status=r.status)
            assert r.status in (403, 429)
        async with http.get(f"{base}/v1/status", ssl=pin, headers={"Authorization": "Bearer " + "0" * 64}) as r:
            assert r.status == 401
        async with http.get(f"{base}/v1/status", ssl=pin, headers=H) as r:
            status = await r.json()
        step("status", hardware=status["hardware"], resources=status["resources"], presets=[p["id"] for p in status["presets"]])

        sid, jid = str(uuid.uuid4()), str(uuid.uuid4())
        manifest = []
        for i, p in enumerate(files):
            data = p.read_bytes()
            manifest.append({"id": f"{i + 1:04d}", "name": p.name, "size": len(data), "sha256": hashlib.sha256(data).hexdigest()})
        capture = {"format": 1, "source": "import", "frames": [{"id": m["id"], "name": m["name"]} for m in manifest]}
        async with http.put(f"{base}/v1/sessions/{sid}", ssl=pin, headers=H,
                            json={"name": "e2e smoke", "capture": capture, "files": manifest}) as r:
            sess = await r.json()
            assert r.status == 200, sess
        step("session_created", files=len(manifest), bytes=sum(m["size"] for m in manifest))

        async def put(fid, body, offset):
            async with http.put(f"{base}/v1/sessions/{sid}/files/{fid}", ssl=pin, data=body,
                                headers={**H, "Upload-Offset": str(offset), "Content-Type": "application/octet-stream"}) as r:
                return r.status, await r.json()

        uploaded = 0
        for i, (p, m) in enumerate(zip(files, manifest)):
            data = p.read_bytes()
            if i == 0:   # interrupted upload: first half, then ask the server where to resume
                half = len(data) // 2
                st, js = await put(m["id"], data[:half], 0)
                assert st == 200 and js["received"] == half and js["complete"] is False, js
                st, js = await put(m["id"], data[half:], 0)          # wrong offset must be refused
                assert st == 409 and js["received"] == half, (st, js)
                async with http.get(f"{base}/v1/sessions/{sid}", ssl=pin, headers=H) as r:
                    cur = next(f for f in (await r.json())["files"] if f["id"] == m["id"])
                st, js = await put(m["id"], data[cur["received"]:], cur["received"])
                assert st == 200 and js["complete"] is True, js
                step("resumable_upload", interrupted_at=half, resumed_from=cur["received"], wrong_offset_status=409)
            elif i == 1:  # corrupted bytes must be rejected by checksum
                bad = bytes([data[0] ^ 0xFF]) + data[1:]
                st, js = await put(m["id"], bad, 0)
                assert st == 422, (st, js)
                st, js = await put(m["id"], data, 0)
                assert st == 200 and js["complete"] is True, js
                step("checksum_mismatch_rejected", status=422)
            else:
                st, js = await put(m["id"], data, 0)
                assert st == 200 and js["complete"] is True, js
            uploaded += len(data)
        async with http.get(f"{base}/v1/sessions/{sid}", ssl=pin, headers=H) as r:
            sess = await r.json()
        assert sess["complete"] is True
        step("upload_complete", bytes=uploaded)

        async with http.put(f"{base}/v1/jobs/{jid}", ssl=pin, headers=H,
                            json={"session_id": sid, "preset": a.preset, "settings": {}}) as r:
            job = await r.json()
            assert r.status in (200, 201), job
        step("job_submitted", state=job["state"])

        since, stages, preview_seen, last_state, last_print = 0, [], False, None, 0.0
        progress_samples = []
        while True:
            async with http.get(f"{base}/v1/jobs/{jid}", ssl=pin, headers=H, params={"since": since, "wait": 20}) as r:
                poll = await r.json()
            job = poll["job"]
            for e in poll["events"]:
                if e["type"] == "stage_start":
                    stages.append(e["stage"])
                if e["type"] == "stage_progress":
                    progress_samples.append((e["stage"], e["progress"], e["overall"]))
            since = poll["last_seq"]
            if job["state"] != last_state or time.time() - last_print > 15:
                step("job_state", state=job["state"], stage=job.get("stage"), overall=job.get("overall_progress"), message=job.get("message"))
                last_state, last_print = job["state"], time.time()
            if not preview_seen and any(x["name"] == "sparse_preview.json" for x in job["artifacts"]) \
                    and job["state"] == "running":
                async with http.get(f"{base}/v1/jobs/{jid}/artifacts/sparse_preview.json", ssl=pin, headers=H) as r:
                    prev = json.loads(await r.read())
                preview_seen = True
                step("provisional_preview_while_running", provisional=prev["provisional"], points=prev["points"]["count"],
                     cameras=len(prev["cameras"]), stage_at_download=job.get("stage"))
            if job["state"] in ("succeeded", "failed", "cancelled", "interrupted"):
                break
        step("job_finished", state=job["state"], error=job.get("error"), stages=stages,
             progress_events=len(progress_samples))
        if job["state"] != "succeeded":
            log["job"] = job
            if a.out:
                a.out.parent.mkdir(parents=True, exist_ok=True)
                a.out.write_text(json.dumps(log, indent=1))
            return 2
        assert stages[:4] == ["ingest", "features", "matching", "sfm"] and stages[-1] == "package"
        overall = [o for _, _, o in progress_samples if o is not None]
        assert all(b >= a_ - 1e-6 for a_, b in zip(overall, overall[1:])), "overall progress went backwards"

        got = {}
        for art in job["artifacts"]:
            url = f"{base}/v1/jobs/{jid}/artifacts/{art['name']}"
            if art["name"] == "model.glb":            # resume a broken download with Range
                cut = art["size"] // 3
                async with http.get(url, ssl=pin, headers={**H, "Range": f"bytes=0-{cut - 1}"}) as r:
                    part1 = await r.read()
                    assert r.status == 206 and len(part1) == cut
                async with http.get(url, ssl=pin, headers={**H, "Range": f"bytes={cut}-"}) as r:
                    part2 = await r.read()
                    assert r.status == 206
                data = part1 + part2
                step("range_resume_download", first=cut, rest=len(part2))
            else:
                async with http.get(url, ssl=pin, headers=H) as r:
                    data = await r.read()
            assert len(data) == art["size"] and hashlib.sha256(data).hexdigest() == art["sha256"], art["name"]
            got[art["name"]] = len(data)
            if a.save_artifacts:
                a.save_artifacts.mkdir(parents=True, exist_ok=True)
                (a.save_artifacts / art["name"]).write_bytes(data)
        step("artifacts_verified", artifacts=got)
        # another device (no token) cannot fetch the model
        async with http.get(f"{base}/v1/jobs/{jid}/artifacts/model.glb", ssl=pin) as r:
            assert r.status == 401
        d = job["diagnostics"]
        log["summary"] = {"registered": d["sfm"]["registered"], "input": d["sfm"]["input_frames"],
                          "faces": d["mesh"]["faces"], "timings_s": d["timings_s"], "peak_rss_mb": d.get("peak_rss_mb"),
                          "warnings": [w["code"] for w in d.get("warnings", [])], "session_id": sid, "job_id": jid}
        step("done", **log["summary"])
        async with http.delete(f"{base}/v1/sessions/{sid}", ssl=pin, headers=H) as r:
            step("session_deleted_on_companion", status=r.status)
            assert r.status == 204
        async with http.get(f"{base}/v1/jobs/{jid}", ssl=pin, headers=H) as r:
            assert r.status == 404
    if a.out:
        a.out.parent.mkdir(parents=True, exist_ok=True)
        a.out.write_text(json.dumps(log, indent=1))
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
