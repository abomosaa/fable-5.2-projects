"""The shipped launcher + image + server + real pipeline, driven over HTTPS like a phone.

Starts `companion/run.sh` (hardened container: no capabilities, read-only root) on a free port
with a temporary data directory and runs the independent client `tools/e2e_companion_http.py`
against it: pairing with a pinned certificate, resumable upload, a real reconstruction of the
12 smoke photos supervised by the job manager, live progress, verified download, deletion.

Skipped when no container runtime / image is available.
    POCKET3D_E2E_IMAGE, POCKET3D_E2E_LIMIT_ARGS as in test_e2e_reconstruction.py
"""
from __future__ import annotations

import json
import os
import shutil
import socket
import subprocess
import sys
import time
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
IMAGE = os.environ.get("POCKET3D_E2E_IMAGE", "pocket3d-companion:latest")
RUNTIME = shutil.which("podman") or shutil.which("docker")
pytestmark = pytest.mark.e2e


def _free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def test_launcher_image_and_real_pipeline_over_https(tmp_path):
    if RUNTIME is None:
        pytest.skip("no container runtime (podman/docker) available")
    if subprocess.run([RUNTIME, "image", "inspect", IMAGE], capture_output=True).returncode != 0:
        pytest.skip(f"container image {IMAGE} not built")
    if not (ROOT / "datasets" / "smoke" / "images").is_dir():
        pytest.skip("smoke dataset missing")
    port, name, data = _free_port(), f"p3d-e2e-server-{os.getpid()}", tmp_path / "data"
    env = dict(os.environ, POCKET3D_IMAGE=IMAGE, POCKET3D_PORT=str(port), POCKET3D_DATA_DIR=str(data),
               POCKET3D_CONTAINER_NAME=name, POCKET3D_QR="off", POCKET3D_CPUS="4", POCKET3D_MEMORY="5g",
               POCKET3D_ADVERTISE="127.0.0.1")
    if os.environ.get("POCKET3D_E2E_LIMIT_ARGS"):
        env["POCKET3D_LIMIT_ARGS"] = os.environ["POCKET3D_E2E_LIMIT_ARGS"]
    log = open(tmp_path / "server.log", "wb")
    server = subprocess.Popen([str(ROOT / "companion" / "run.sh")], env=env, stdout=log, stderr=subprocess.STDOUT,
                              stdin=subprocess.DEVNULL, cwd=str(tmp_path))
    try:
        deadline = time.time() + 60
        while not (data / "pairing.txt").exists():
            assert server.poll() is None, (tmp_path / "server.log").read_text()[-2000:]
            assert time.time() < deadline, "the companion did not start"
            time.sleep(0.2)
        time.sleep(0.5)
        out = tmp_path / "transcript.json"
        client = subprocess.run([sys.executable, str(ROOT / "tools" / "e2e_companion_http.py"),
                                 "--pairing-file", str(data / "pairing.txt"), "--images",
                                 str(ROOT / "datasets" / "smoke" / "images"), "--preset", "preview", "--out", str(out)],
                                capture_output=True, text=True, timeout=1500)
        assert client.returncode == 0, client.stdout[-3000:] + client.stderr[-2000:]
        steps = {s["step"]: s for s in json.loads(out.read_text())["steps"]}
        for needed in ("wrong_fingerprint_rejected", "paired", "pairing_code_is_single_use", "resumable_upload",
                       "checksum_mismatch_rejected", "provisional_preview_while_running", "range_resume_download",
                       "artifacts_verified", "session_deleted_on_companion"):
            assert needed in steps, f"missing step {needed}"
        assert steps["job_finished"]["state"] == "succeeded"
        assert steps["job_finished"]["stages"][-1] == "package"
        # the job's intermediate data is gone once it has succeeded; nothing of the deleted session remains
        assert not any((data / "sessions").iterdir())
        assert not [p for p in (data / "jobs").glob("*/work/*")]
        # the container really runs hardened
        insp = json.loads(subprocess.run([RUNTIME, "inspect", name], capture_output=True, text=True).stdout)[0]
        assert insp["HostConfig"]["ReadonlyRootfs"] is True
        assert "ALL" in [c.upper().removeprefix("CAP_") for c in (insp["HostConfig"].get("CapDrop") or [])] or \
            not (insp.get("EffectiveCaps") or [])
    finally:
        subprocess.run([RUNTIME, "stop", "-t", "5", name], capture_output=True)
        try:
            server.wait(timeout=20)
        except subprocess.TimeoutExpired:
            server.kill()
        log.close()
