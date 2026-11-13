"""End-to-end reconstruction smoke test on REAL photographs (datasets/smoke, 12 photos).

Runs the real pipeline — COLMAP SfM + OpenMVS dense/mesh/texture + packaging — inside the
companion container image and checks the produced model, not a mocked response.

    companion/.venv-dev/bin/python -m pytest companion/tests/test_e2e_reconstruction.py -q

Skipped (with the reason shown) when no container runtime or image is available. Settings:
    POCKET3D_E2E_IMAGE        image to test                (default pocket3d-companion:latest)
    POCKET3D_E2E_LIMIT_ARGS   container resource flags     (default "--cpus 4 --memory 4g";
                              use "--cgroups=disabled" to stay inside the caller's cgroup)
"""
from __future__ import annotations

import hashlib
import io
import json
import os
import shlex
import shutil
import signal
import subprocess
import time
from pathlib import Path

import numpy as np
import pytest
from PIL import Image

from pocket3d_companion.pipeline import geom
from pocket3d_companion.pipeline.glb import read_glb
from pocket3d_companion.pipeline.localjob import make_job

ROOT = Path(__file__).resolve().parents[2]
SMOKE = ROOT / "datasets" / "smoke" / "images"
IMAGE = os.environ.get("POCKET3D_E2E_IMAGE", "pocket3d-companion:latest")
LIMIT_ARGS = shlex.split(os.environ.get("POCKET3D_E2E_LIMIT_ARGS", "--cpus 4 --memory 4g"))
RUNTIME = shutil.which("podman") or shutil.which("docker")
THREADS = 4

pytestmark = pytest.mark.e2e


def _require_runtime():
    if not SMOKE.is_dir() or len(list(SMOKE.glob("*.jpg"))) < 8:
        pytest.skip(f"smoke dataset missing at {SMOKE}")
    if RUNTIME is None:
        pytest.skip("no container runtime (podman/docker) available")
    if subprocess.run([RUNTIME, "image", "exists", IMAGE], capture_output=True).returncode != 0 and \
            subprocess.run([RUNTIME, "image", "inspect", IMAGE], capture_output=True).returncode != 0:
        pytest.skip(f"container image {IMAGE} not built (see README: build the companion)")


def _container_cmd(job_dir: Path, name: str) -> list[str]:
    return [RUNTIME, "run", "--rm", "--name", name, *LIMIT_ARGS,
            "-v", f"{job_dir}:/job",
            "-v", f"{ROOT / 'companion' / 'pocket3d_companion'}:/opt/pocket3d/pocket3d_companion:ro",
            "--entrypoint", "python3", IMAGE, "-m", "pocket3d_companion.pipeline", "--job-dir", "/job"]


def _run_container(job_dir: Path, name: str, timeout: float) -> subprocess.CompletedProcess:
    """Run the pipeline container to completion; on timeout the CONTAINER is killed too (killing
    only the client would leave it running)."""
    try:
        return subprocess.run(_container_cmd(job_dir, name), capture_output=True, text=True, timeout=timeout)
    except subprocess.TimeoutExpired:
        subprocess.run([RUNTIME, "kill", name], capture_output=True)
        raise


def _prepare(tmp: Path, overrides: dict | None = None) -> Path:
    job_dir = tmp / "job"
    make_job(SMOKE, job_dir, "preview", overrides or {}, THREADS, 3500)
    # paths inside the container
    job = json.loads((job_dir / "job.json").read_text())
    job["originals_dir"] = "/job/session/originals"
    job["capture_path"] = "/job/session/capture.json"
    (job_dir / "job.json").write_text(json.dumps(job))
    return job_dir


def _events(job_dir: Path) -> list[dict]:
    return [json.loads(line) for line in (job_dir / "events.jsonl").read_text().splitlines() if line.strip()]


@pytest.fixture(scope="module")
def finished_job(tmp_path_factory):
    _require_runtime()
    job_dir = _prepare(tmp_path_factory.mktemp("e2e"))
    t0 = time.time()
    proc = _run_container(job_dir, f"p3d-e2e-{os.getpid()}", 1500)
    (job_dir / "container.log").write_text(proc.stdout + proc.stderr)
    return {"dir": job_dir, "returncode": proc.returncode, "seconds": time.time() - t0,
            "log": (proc.stdout + proc.stderr)[-3000:]}


def test_real_photos_reconstruct_to_a_valid_textured_model(finished_job):
    job_dir = finished_job["dir"]
    assert finished_job["returncode"] == 0, finished_job["log"]
    result = json.loads((job_dir / "out" / "result.json").read_text())
    assert result["ok"] is True
    names = {a["name"]: a for a in result["artifacts"]}
    assert {"sparse_preview.json", "model.glb", "cameras.json", "diagnostics.json"} <= set(names)
    for a in result["artifacts"]:                                # artifacts are what the manifest says
        p = job_dir / "out" / a["name"]
        assert p.stat().st_size == a["size"]
        assert hashlib.sha256(p.read_bytes()).hexdigest() == a["sha256"]

    diag = result["diagnostics"]
    sfm = diag["sfm"]
    assert sfm["input_frames"] == 12
    assert 6 <= sfm["registered"] <= 12                          # real data: not every photo registers
    assert sfm["registered"] + len(sfm["unregistered"]) == 12    # …and the rest is reported, not hidden
    assert 0 < sfm["mean_reprojection_error_px"] < 2.0
    assert diag["scale"]["units"] == "arbitrary" and diag["scale"]["meters_per_unit"] is None
    assert diag["environment"]["gpu"] is None and "companion" in diag["environment"]["where"]
    assert set(diag["timings_s"]) >= {"features", "matching", "sfm", "dense", "mesh", "texture", "package"}

    g = read_glb(job_dir / "out" / "model.glb")
    V, F, uv, conf = g["positions"], g["faces"], g["uvs"], g["confidence"]
    assert len(V) > 5000 and len(F) > 8000
    assert F.min() >= 0 and F.max() < len(V)
    assert np.isfinite(V).all() and uv is not None and conf is not None
    assert uv.min() >= -1e-6 and uv.max() <= 1 + 1e-6
    assert conf.min() >= 0 and conf.max() <= 1 and 0.2 < (conf > 0.5).mean() <= 1.0
    # geometry is a real surface of the photographed scene, not a primitive: many distinct normals
    n = np.cross(V[F[:, 1]] - V[F[:, 0]], V[F[:, 2]] - V[F[:, 0]])
    area = 0.5 * np.linalg.norm(n, axis=1)
    assert (area > 0).mean() > 0.98
    n = n[area > 0] / (2 * area[area > 0, None])
    assert np.linalg.eigvalsh(np.cov(n.T)).min() > 0.02          # normals span all directions
    # texture is a real decodable image and sampled colours vary (not a flat fill)
    assert len(g["images"]) >= 1
    tex = Image.open(io.BytesIO(g["images"][0]["bytes"])).convert("RGB")
    assert min(tex.size) >= 512
    px = np.asarray(tex)[(np.clip(uv[::50, 1], 0, 1) * (tex.size[1] - 1)).astype(int),
                         (np.clip(uv[::50, 0], 0, 1) * (tex.size[0] - 1)).astype(int)]
    assert px.std() > 10
    ex = g["extras"]["pocket3d"]
    assert ex["frame"]["up"] == "+Y" and ex["holes_preserved"] is True and ex["scale"]["units"] == "arbitrary"
    assert ex["job_id"] == json.loads((job_dir / "job.json").read_text())["job_id"]

    # cameras: registered ones are exported in the model frame and actually look at the model
    cams = json.loads((job_dir / "out" / "cameras.json").read_text())
    assert len(cams["cameras"]) == sfm["registered"]
    centre = V.mean(0)
    for c in cams["cameras"]:
        fwd = geom.quat_to_rot(np.array(c["q"])) @ np.array([0.0, 0.0, -1.0])
        to_model = centre - np.array(c["position"])
        assert fwd @ to_model / np.linalg.norm(to_model) > 0.8
    # front faces look towards the cameras that saw them (no mirrored / inside-out mesh)
    cam_pos = np.array([c["position"] for c in cams["cameras"]])
    fc = V[F].mean(1)[::20]
    fn = np.cross(V[F[:, 1]] - V[F[:, 0]], V[F[:, 2]] - V[F[:, 0]])[::20]
    nearest = cam_pos[np.argmin(((fc[:, None, :] - cam_pos[None]) ** 2).sum(-1), axis=1)]
    assert (((nearest - fc) * fn).sum(1) > 0).mean() > 0.6

    # the provisional preview shares the model frame's neighbourhood and says what it is
    prev = json.loads((job_dir / "out" / "sparse_preview.json").read_text())
    assert prev["provisional"] is True and prev["points"]["count"] > 50
    assert len(prev["cameras"]) == sfm["registered"]


def test_progress_events_come_from_real_stages_in_order(finished_job):
    assert finished_job["returncode"] == 0, finished_job["log"]
    ev = _events(finished_job["dir"])
    assert [e["seq"] for e in ev] == list(range(1, len(ev) + 1))
    starts = [e["stage"] for e in ev if e["type"] == "stage_start"]
    ends = [e["stage"] for e in ev if e["type"] == "stage_end"]
    expected = ["ingest", "features", "matching", "sfm", "undistort", "dense", "mesh", "texture", "package"]
    assert starts == expected and ends == expected
    overall = [e["overall"] for e in ev]
    assert all(b >= a - 1e-6 for a, b in zip(overall, overall[1:]))
    for stage in ("features", "matching", "sfm", "dense", "mesh", "texture"):
        prog = [e for e in ev if e["type"] == "stage_progress" and e["stage"] == stage]
        assert prog, f"no progress reported for {stage}"
        assert all(e["message"] for e in prog)
    dense = [e["message"] for e in ev if e["type"] == "stage_progress" and e["stage"] == "dense"]
    assert any("Depth maps" in m for m in dense) and any("Fus" in m for m in dense)
    # the preview artifact is announced before the dense stage starts
    seq_preview = next(e["seq"] for e in ev if e["type"] == "artifact" and e["data"]["name"] == "sparse_preview.json")
    seq_dense = next(e["seq"] for e in ev if e["type"] == "stage_start" and e["stage"] == "dense")
    assert seq_preview < seq_dense


def test_retry_reuses_finished_stages(finished_job):
    """A second attempt on the same job directory reuses the stage checkpoints (what the server's
    retry does after an interruption) and still delivers a complete, verified result."""
    assert finished_job["returncode"] == 0, finished_job["log"]
    job_dir = finished_job["dir"]
    before = (job_dir / "out" / "model.glb").read_bytes()
    (job_dir / "events.jsonl").unlink()
    shutil.rmtree(job_dir / "out")
    t0 = time.time()
    proc = _run_container(job_dir, f"p3d-e2e-retry-{os.getpid()}", 900)
    assert proc.returncode == 0, (proc.stdout + proc.stderr)[-2000:]
    ev = _events(job_dir)
    reused = [e["stage"] for e in ev if e["type"] == "stage_end" and e.get("data", {}).get("reused")]
    assert reused == ["ingest", "features", "matching", "sfm", "undistort", "dense", "mesh", "texture"]
    assert time.time() - t0 < finished_job["seconds"]
    g1, g2 = read_glb(io_path(job_dir, before)), read_glb(job_dir / "out" / "model.glb")
    assert np.array_equal(g1["faces"], g2["faces"]) and np.allclose(g1["positions"], g2["positions"])


def io_path(job_dir: Path, data: bytes) -> Path:
    p = job_dir / "previous_model.glb"
    p.write_bytes(data)
    return p


def test_cancelled_job_never_leaves_a_result(tmp_path):
    _require_runtime()
    job_dir = _prepare(tmp_path)
    name = f"p3d-e2e-cancel-{os.getpid()}"
    proc = subprocess.Popen(_container_cmd(job_dir, name), stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
    try:
        deadline = time.time() + 600
        while time.time() < deadline:                 # wait until the dense stage is really running
            if (job_dir / "events.jsonl").exists() and any(
                    e["type"] == "stage_start" and e["stage"] == "dense" for e in _events(job_dir)):
                break
            assert proc.poll() is None, "pipeline exited before the dense stage"
            time.sleep(0.2)
        else:
            pytest.fail("dense stage not reached")
        subprocess.run([RUNTIME, "kill", "--signal", "TERM", name], capture_output=True)
        rc = proc.wait(timeout=60)
    finally:
        if proc.poll() is None:
            subprocess.run([RUNTIME, "kill", name], capture_output=True)
            proc.kill()
    assert rc in (130, 128 + signal.SIGTERM), rc      # cancelled, not success and not a crash
    assert not (job_dir / "out" / "result.json").exists()
    assert not (job_dir / "out" / "model.glb").exists()
    ev = _events(job_dir)
    assert not any(e["type"] == "stage_end" and e["stage"] == "package" for e in ev)


def test_unusable_input_fails_with_diagnosis_and_guidance(tmp_path):
    """Photos with nothing to match (flat colour) must end as a diagnosed failure with recapture
    guidance — never as a 'successful' empty model."""
    _require_runtime()
    src = tmp_path / "flat"
    src.mkdir()
    rng = np.random.default_rng(0)
    for i in range(5):
        arr = np.full((480, 640, 3), 128, np.uint8) + rng.integers(0, 3, (480, 640, 3), dtype=np.uint8)
        Image.fromarray(arr).save(src / f"flat_{i}.jpg", quality=92)
    job_dir = tmp_path / "job"
    make_job(src, job_dir, "preview", {}, THREADS, 3500)
    job = json.loads((job_dir / "job.json").read_text())
    job["originals_dir"], job["capture_path"] = "/job/session/originals", "/job/session/capture.json"
    (job_dir / "job.json").write_text(json.dumps(job))
    proc = _run_container(job_dir, f"p3d-e2e-flat-{os.getpid()}", 600)
    assert proc.returncode == 2, (proc.stdout + proc.stderr)[-2000:]
    assert not (job_dir / "out" / "result.json").exists()
    err = [e for e in _events(job_dir) if e["type"] == "error"]
    assert len(err) == 1 and err[0]["data"]["code"] == "insufficient_registration"
    assert len(err[0]["data"]["guidance"]) >= 2


def _panorama_views(n: int = 7, step_deg: float = 11.0, size=(800, 600), f: float = 700.0) -> list[Image.Image]:
    """Photos from ONE camera position turning about the vertical axis (a panorama): rich
    texture, lots of overlap, zero parallax. Rendered from a procedural spherical texture."""
    rng = np.random.default_rng(7)
    th, tw = 1024, 4096
    tex = np.zeros((th, tw), np.float32)
    for cell in (4, 8, 16, 32, 64):                       # multi-scale blocks -> corners at every scale
        small = rng.random((th // cell + 1, tw // cell + 1)).astype(np.float32)
        tex += np.kron(small, np.ones((cell, cell), np.float32))[:th, :tw] / 5
    tex = (255 * (tex - tex.min()) / (tex.max() - tex.min())).astype(np.uint8)
    w, h = size
    u, v = np.meshgrid(np.arange(w) - w / 2 + 0.5, np.arange(h) - h / 2 + 0.5)
    out = []
    for i in range(n):
        yaw = np.radians(step_deg * (i - n // 2))
        dx, dy, dz = u / f, v / f, np.ones_like(u)
        x = np.cos(yaw) * dx + np.sin(yaw) * dz
        z = -np.sin(yaw) * dx + np.cos(yaw) * dz
        lon = np.arctan2(x, z)
        lat = np.arctan2(dy, np.hypot(x, z))
        tx = ((lon / (2 * np.pi) + 0.5) * tw).astype(int) % tw
        ty = np.clip(((lat / np.pi + 0.5) * th).astype(int), 0, th - 1)
        out.append(Image.fromarray(np.stack([tex[ty, tx]] * 3, axis=-1)))
    return out


def test_turning_on_the_spot_is_diagnosed_as_missing_parallax(tmp_path):
    """Photos that overlap and match well but were taken by turning in place must fail with the
    specific 'no parallax' diagnosis — not with 'add more overlap / texture', which would send
    the user in the wrong direction."""
    _require_runtime()
    src = tmp_path / "pano"
    src.mkdir()
    for i, im in enumerate(_panorama_views()):
        im.save(src / f"pano_{i:02d}.jpg", quality=92)
    job_dir = tmp_path / "job"
    make_job(src, job_dir, "preview", {}, THREADS, 3500)
    job = json.loads((job_dir / "job.json").read_text())
    job["originals_dir"], job["capture_path"] = "/job/session/originals", "/job/session/capture.json"
    (job_dir / "job.json").write_text(json.dumps(job))
    proc = _run_container(job_dir, f"p3d-e2e-pano-{os.getpid()}", 300)
    ev = _events(job_dir)
    matching = next(e["data"]["matching"] for e in ev if e["type"] == "diagnostics" and "matching" in e.get("data", {}))
    assert matching["pairs_verified"] >= 6 and matching["inlier_matches"] > 100 * matching["pairs_verified"], matching
    assert proc.returncode == 2, (proc.stdout + proc.stderr)[-2000:]
    err = [e for e in ev if e["type"] == "error"]
    assert len(err) == 1 and err[0]["data"]["code"] == "no_parallax", err
    assert any("position" in g for g in err[0]["data"]["guidance"])
    assert not (job_dir / "out" / "result.json").exists()


def test_two_view_configuration_table_matches_the_pycolmap_in_the_image():
    """`sfm.TWO_VIEW_CONFIG_NAMES` is a copy of COLMAP's enum (the unit tests run without
    pycolmap); the turning-on-the-spot diagnosis depends on it being the image's numbering."""
    _require_runtime()
    code = ("import pycolmap; from pocket3d_companion.pipeline import sfm; "
            "got = {int(m.value): m.name for m in pycolmap.TwoViewGeometryConfiguration.__members__.values()}; "
            "assert got == sfm.TWO_VIEW_CONFIG_NAMES, got; print('ok', len(got))")
    proc = subprocess.run([RUNTIME, "run", "--rm", *LIMIT_ARGS, "--entrypoint", "python3", IMAGE, "-c", code],
                          capture_output=True, text=True, timeout=120)
    assert proc.returncode == 0 and "ok 10" in proc.stdout, proc.stdout + proc.stderr
