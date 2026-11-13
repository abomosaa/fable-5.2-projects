"""The command line: the real `serve` process, `pair`, `devices`, `version`."""
from __future__ import annotations

import json
import os
import signal
import subprocess
import sys
from pathlib import Path

import pytest

from conftest import Client, FAKE_WORKER_CMD, make_image, new_id, wait_until
from pocket3d_companion.security import DeviceStore, parse_pairing_uri

ROOT = Path(__file__).resolve().parent.parent


def cli(*args: str, data: Path | None = None, **kw) -> subprocess.CompletedProcess:
    env = dict(os.environ, PYTHONPATH=str(ROOT))
    env.pop("POCKET3D_DATA", None)
    if data is not None:
        env["POCKET3D_DATA"] = str(data)
    return subprocess.run([sys.executable, "-m", "pocket3d_companion", *args], env=env, capture_output=True,
                          text=True, timeout=30, **kw)


def test_version():
    r = cli("version")
    assert r.returncode == 0 and r.stdout.strip() == "1.0.0"


def test_no_command_prints_help():
    r = cli()
    assert r.returncode == 2 and "serve" in r.stdout


def test_devices_list_and_revoke(tmp_path):
    data = tmp_path / "data"
    assert cli("devices", data=data).returncode == 1            # no data directory yet
    data.mkdir()
    r = cli("devices", data=data)
    assert r.returncode == 0 and "no paired devices" in r.stdout
    store = DeviceStore(data)
    device_id, token = store.register("Pixel 8")
    r = cli("devices", "list", data=data)
    assert r.returncode == 0 and device_id in r.stdout and "Pixel 8" in r.stdout
    assert token not in r.stdout
    assert cli("devices", "revoke", "not-a-uuid", data=data).returncode == 2
    assert cli("devices", "revoke", new_id(), data=data).returncode == 1
    r = cli("devices", "revoke", device_id, data=data)
    assert r.returncode == 0 and "revoked" in r.stdout
    assert DeviceStore(data).devices == {}


def test_pair_without_a_running_companion(tmp_path):
    r = cli("pair", data=tmp_path)
    assert r.returncode == 1 and "not running" in r.stderr


async def test_serve_process_end_to_end(tmp_path):
    """Start the real process, pair through pairing.txt, run a job, rotate the code, SIGTERM."""
    # The real process runs with the production limits (short side >= 320 px).
    photos = {f"{i:04d}": make_image(size=(480, 360), seed=i) for i in range(1, 4)}
    data = tmp_path / "data"
    env = dict(os.environ, PYTHONPATH=str(ROOT), POCKET3D_DATA=str(data), POCKET3D_ALLOW_FAKE_WORKER="1",
               POCKET3D_WORKER_CMD=json.dumps(FAKE_WORKER_CMD), POCKET3D_QR="dark")
    out_path = tmp_path / "stdout.txt"
    with open(out_path, "wb") as out:
        proc = subprocess.Popen([sys.executable, "-m", "pocket3d_companion", "serve", "--host", "127.0.0.1",
                                 "--port", "0", "--advertise", "127.0.0.1,192.0.2.7", "--name", "Test bench"],
                                env=env, stdout=out, stderr=subprocess.STDOUT)
    client = None
    try:
        pairing = data / "pairing.txt"
        await wait_until(lambda: pairing.exists() or proc.poll() is not None, timeout=20)
        assert proc.poll() is None, out_path.read_text()
        info = parse_pairing_uri(pairing.read_text())
        assert info["hosts"] == ["127.0.0.1", "192.0.2.7"] and info["port"] > 0

        # pairing.txt is written just before the banner is printed.
        banner = await wait_until(lambda: (lambda t: t if "listening on" in t else None)(out_path.read_text()))
        assert pairing.read_text().strip() in banner and "Test bench" in banner
        assert "█" in banner                                # the QR code was drawn

        client = Client(info["port"], info["fingerprint"])
        status, body = await client.post("/v1/pair", {"code": info["code"], "device_name": "CLI test"}, auth=False)
        assert status == 200 and body["server_name"] == "Test bench"
        client.token = body["token"]
        sid = await client.create_session(photos)
        jid = await client.submit(sid, {"mode": "succeed"})
        await client.wait_job(jid, "succeeded")

        r = cli("devices", data=data)
        assert r.returncode == 0 and "CLI test" in r.stdout
        r = cli("pair", "--qr", "off", data=data)
        current = parse_pairing_uri(pairing.read_text())["code"]
        assert r.returncode == 0 and current in r.stdout.replace(" ", "") and current != info["code"]
        r = cli("pair", "--rotate", "--qr", "off", data=data)
        rotated = parse_pairing_uri(pairing.read_text())["code"]
        assert r.returncode == 0 and rotated != current and rotated in r.stdout.replace(" ", "")

        running = await client.submit(sid, {"mode": "sleep", "seconds": 120})
        await client.wait_job(running, "running")
        await wait_until(lambda: (data / "jobs" / running / "work" / "worker.pid").exists())
        worker = int((data / "jobs" / running / "work" / "worker.pid").read_text())

        proc.send_signal(signal.SIGTERM)                         # what `podman stop` sends
        assert proc.wait(timeout=15) == 0
        assert not pairing.exists()
        assert json.loads((data / "jobs" / running / "state.json").read_text())["state"] == "interrupted"
        with pytest.raises(ProcessLookupError):
            os.kill(worker, 0)

        log = out_path.read_text()
        for secret in (client.token, "IMG_0001"):
            assert secret not in log
    finally:
        if client is not None:
            await client.close()
        if proc.poll() is None:
            proc.kill()
            proc.wait()
