"""Deterministic unit tests for the pure parts of the reconstruction pipeline.

No COLMAP/OpenMVS needed: coordinate conventions, scale alignment, presets, the event stream,
GLB packaging and the evidence-preserving mesh helpers. (The end-to-end reconstruction on real
photographs is exercised by tests/test_e2e_reconstruction.py.)
"""
from __future__ import annotations

import io
import json
import struct

import numpy as np
import pytest
from PIL import Image

from pocket3d_companion.pipeline import geom, glb, ingest, meshpost, mvs, presets, scene, sfm
from pocket3d_companion.pipeline.events import STAGES, EventWriter


# --------------------------------------------------------------------------------------------
# camera / image coordinate transformations
# --------------------------------------------------------------------------------------------
def _project(K, p):
    fx, fy, cx, cy = K
    return fx * p[0] / p[2] + cx, fy * p[1] / p[2] + cy


@pytest.mark.parametrize("turns", [0, 1, 2, 3])
def test_rotated_intrinsics_and_camera_rotation_agree_with_pixel_rotation(turns):
    """Projecting a point with the stored camera and rotating the pixel must equal rotating the
    camera frame and projecting with the rotated intrinsics — for every quarter turn."""
    w, h = 4000, 3000
    K = (3100.0, 3080.0, 1987.0, 1522.0)
    rng = np.random.default_rng(turns)
    Kr = geom.rotate_intrinsics(*K, w, h, turns)
    R = geom.upright_from_stored_rotation(turns)
    uw, uh = geom.upright_size(w, h, turns)
    assert (uw, uh) == ((h, w) if turns % 2 else (w, h))
    assert np.isclose(np.linalg.det(R), 1.0)
    for _ in range(50):
        p = np.array([rng.uniform(-1, 1), rng.uniform(-1, 1), rng.uniform(2, 6)])
        x, y = _project(K, p)
        expect = geom.rotate_pixel(x, y, w, h, turns)
        got = _project(Kr, R @ p)
        assert np.allclose(got, expect, atol=1e-9)


@pytest.mark.parametrize("orientation,expected", [(1, (0, False)), (3, (2, False)), (6, (1, False)), (8, (3, False)),
                                                  (2, (0, True)), (4, (2, True)), (5, (3, True)), (7, (1, True)),
                                                  (0, (0, False)), (99, (0, False))])
def test_exif_orientation_table(orientation, expected):
    assert geom.exif_quarter_turns(orientation) == expected


@pytest.mark.parametrize("orientation", [1, 3, 6, 8])
def test_exif_quarter_turns_match_pillow_transpose(orientation):
    """Our pixel mapping must be the one Pillow applies when it makes the working copy upright."""
    from PIL import ImageOps
    w, h = 8, 5
    img = Image.new("L", (w, h), 0)
    px, py = 6, 1
    img.putpixel((px, py), 255)
    exif = Image.Exif()
    exif[0x0112] = orientation
    buf = io.BytesIO()
    img.save(buf, "PNG", exif=exif)
    up = ImageOps.exif_transpose(Image.open(io.BytesIO(buf.getvalue())))
    turns, mirrored = geom.exif_quarter_turns(orientation)
    assert not mirrored
    assert up.size == geom.upright_size(w, h, turns)
    x, y = geom.rotate_pixel(px + 0.5, py + 0.5, w, h, turns)   # pixel centre
    assert up.getpixel((int(x), int(y))) == 255


@pytest.mark.parametrize("turns", [0, 1, 2, 3])
def test_opencv_distortion_rotation_is_consistent(turns):
    """Distorting in the stored frame then rotating equals rotating then distorting with the
    rotated coefficients (tangential terms rotate with the axes)."""
    k = [0.11, -0.05, 0.004, -0.007, 0.02]

    def distort(c, x, y):
        k1, k2, p1, p2, k3 = c
        r2 = x * x + y * y
        rad = 1 + k1 * r2 + k2 * r2 ** 2 + k3 * r2 ** 3
        return (x * rad + 2 * p1 * x * y + p2 * (r2 + 2 * x * x),
                y * rad + p1 * (r2 + 2 * y * y) + 2 * p2 * x * y)

    R = geom.upright_from_stored_rotation(turns)[:2, :2]
    kr = geom.rotate_opencv_distortion(k, turns)
    for x, y in [(0.3, -0.2), (-0.4, 0.1), (0.05, 0.45)]:
        a = R @ np.array(distort(k, x, y))
        xr, yr = R @ np.array([x, y])
        b = np.array(distort(kr, xr, yr))
        assert np.allclose(a, b, atol=1e-12)


def test_quaternion_round_trip_and_gl_cv_conversion():
    rng = np.random.default_rng(3)
    for _ in range(20):
        q = rng.normal(size=4)
        q /= np.linalg.norm(q)
        R = geom.quat_to_rot(q)
        assert np.allclose(R @ R.T, np.eye(3), atol=1e-12) and np.isclose(np.linalg.det(R), 1)
        q2 = geom.rot_to_quat(R)
        assert np.allclose(geom.quat_to_rot(q2), R, atol=1e-10)
    # A GL camera with identity pose looks down −Z with +Y up; as a CV camera its forward (+Z)
    # axis must therefore be world −Z and its down (+Y) axis world −Y.
    R_cv, c = geom.ar_pose_to_cv_upright(np.array([1.0, 2.0, 3.0]), np.array([0, 0, 0, 1.0]), 0)
    assert np.allclose(R_cv[:, 2], [0, 0, -1]) and np.allclose(R_cv[:, 1], [0, -1, 0])
    assert np.allclose(c, [1, 2, 3])
    # After a 90° clockwise display rotation the upright image's "right" is the stored "up"…
    R_up, _ = geom.ar_pose_to_cv_upright(np.zeros(3), np.array([0, 0, 0, 1.0]), 1)
    assert np.allclose(R_up[:, 2], [0, 0, -1])                 # viewing direction is unchanged
    assert np.isclose(np.linalg.det(R_up), 1.0)


# --------------------------------------------------------------------------------------------
# similarity / scale calibration from AR poses
# --------------------------------------------------------------------------------------------
def _random_sim3(rng, scale):
    q = rng.normal(size=4)
    return geom.Sim3(scale, geom.quat_to_rot(q / np.linalg.norm(q)), rng.normal(size=3))


def test_umeyama_recovers_similarity_and_never_reflects():
    rng = np.random.default_rng(0)
    truth = _random_sim3(rng, 0.37)
    src = rng.normal(size=(40, 3))
    est = geom.umeyama(src, truth.apply(src))
    assert np.isclose(est.s, 0.37, rtol=1e-9)
    assert np.allclose(est.R, truth.R, atol=1e-9) and np.allclose(est.t, truth.t, atol=1e-9)
    mirrored = src * np.array([-1, 1, 1])           # a reflection is not a similarity
    est2 = geom.umeyama(src, mirrored)
    assert np.isclose(np.linalg.det(est2.R), 1.0)
    assert np.linalg.norm(est2.apply(src) - mirrored, axis=1).mean() > 0.3


def test_sim3_compose_inverse():
    rng = np.random.default_rng(1)
    a, b = _random_sim3(rng, 2.0), _random_sim3(rng, 0.25)
    x = rng.normal(size=(5, 3))
    assert np.allclose(a.compose(b).apply(x), a.apply(b.apply(x)))
    assert np.allclose(a.inverse().apply(a.apply(x)), x)
    assert np.allclose(geom.Sim3.from_json(json.loads(json.dumps(a.to_json()))).apply(x), a.apply(x), atol=1e-7)


def test_ransac_sim3_rejects_outliers_and_reports_scale_uncertainty():
    rng = np.random.default_rng(2)
    truth = _random_sim3(rng, 0.42)
    ang = np.linspace(0, 2 * np.pi, 40, endpoint=False)
    src = np.stack([np.cos(ang), 0.3 * np.sin(3 * ang), np.sin(ang)], axis=1) * 2.0
    dst = truth.apply(src) + rng.normal(scale=0.003, size=src.shape)
    dst[:6] += rng.normal(scale=0.5, size=(6, 3))    # tracking glitches
    fit = geom.fit_sim3_ransac(src, dst, threshold=0.03, seed=1)
    assert fit is not None
    assert fit.inliers.sum() >= 33 and not fit.inliers[:6].all()
    assert abs(fit.sim3.s - 0.42) / 0.42 < 0.01
    assert 0 < fit.scale_rel_std < 0.02 and fit.rms < 0.01
    assert geom.fit_sim3_ransac(src[:3], dst[:3], 0.03) is None       # too few pairs


def _orbit_cameras(n=36, radius=2.0, height=0.8, center=np.zeros(3), sfm_from_world=None):
    cams = []
    for i in range(n):
        a = 2 * np.pi * i / n
        c = center + np.array([radius * np.cos(a), height, radius * np.sin(a)])
        fwd = center - c
        fwd /= np.linalg.norm(fwd)
        right = np.cross(fwd, [0, 1, 0]); right /= np.linalg.norm(right)
        down = np.cross(fwd, right)
        R_wc = np.stack([right, down, fwd], axis=1)        # CV camera axes as columns
        if sfm_from_world is not None:
            c = sfm_from_world.apply(c)
            R_wc = sfm_from_world.R @ R_wc
        cams.append({"id": f"{i:04d}", "name": f"{i}.jpg", "index": i, "center": c, "R_wc": R_wc, "width": 1600,
                     "height": 1200, "fx": 1400.0, "fy": 1400.0, "cx": 800.0, "cy": 600.0, "num_points": 100})
    return cams


def _scene_inputs(with_ar: bool, ar_scale_error=1.0, segment_break=False):
    rng = np.random.default_rng(5)
    world_center = np.array([0.3, 0.0, -0.2])
    sfm_from_world = _random_sim3(rng, 3.3)                  # SfM gauge: arbitrary similarity
    cams_world = _orbit_cameras(center=world_center)
    cams = _orbit_cameras(center=world_center, sfm_from_world=sfm_from_world)
    # object points (a blob 0.3 m wide, 0.4 m tall standing on the y = -0.2 plane) + ground points
    obj = world_center + rng.normal(scale=[0.1, 0.12, 0.1], size=(1500, 3))
    ground = np.stack([rng.uniform(-1.2, 1.2, 2500) + world_center[0], np.full(2500, world_center[1] - 0.35),
                       rng.uniform(-1.2, 1.2, 2500) + world_center[2]], axis=1)
    xyz = sfm_from_world.apply(np.concatenate([obj, ground]))
    model = {"cameras": cams, "xyz": xyz, "rgb": np.zeros((len(xyz), 3), np.uint8),
             "track": np.full(len(xyz), 4), "error": np.zeros(len(xyz))}
    frames = []
    for i, (cw, cs) in enumerate(zip(cams_world, cams)):
        f = {"id": cs["id"], "rejected": None, "ar_center": None, "ar_R": None, "ar_segment": None}
        if with_ar:
            seg = 1 if (segment_break and i >= 24) else 0
            offset = np.array([5.0, 0.0, 2.0]) if seg == 1 else np.zeros(3)   # new AR world after tracking loss
            f["ar_center"] = (cw["center"] * ar_scale_error + offset).tolist()
            f["ar_R"] = cw["R_wc"].tolist()
            f["ar_segment"] = seg
        frames.append(f)
    return model, {"frames": frames}, sfm_from_world, world_center


def test_scene_without_ar_is_arbitrary_units_upright_and_centred():
    model, ing, sfm_from_world, world_center = _scene_inputs(with_ar=False)
    st = presets.resolve_settings("standard")
    scn = scene.build_scene(model, ing, st)
    assert scn["scale"]["units"] == "arbitrary" and scn["scale"]["meters_per_unit"] is None
    assert scn["converging"]
    sim = scn["model_from_sfm"]
    # origin = point the cameras converge on; +Y = world up (recovered from the support plane)
    assert np.linalg.norm(sim.apply(sfm_from_world.apply(world_center))) < 0.02
    up_model = sim.R @ sfm_from_world.R @ np.array([0, 1.0, 0])
    assert up_model[1] > 0.999
    assert scn["up_source"] == "support_plane" and scn["ground"] is not None
    # arbitrary-unit normalisation: median camera distance is 1
    assert np.isclose(scn["median_camera_distance"], 1.0, atol=1e-6)
    cov = scn["coverage"]
    assert cov["azimuth_bins_covered"] == 12 and cov["largest_azimuth_gap_deg"] <= 10.5
    cams = scene.cameras_in_model(model, scn)
    # exported GL cameras must look at the origin: forward = −Z of the GL frame
    for c in cams[::6]:
        fwd = geom.quat_to_rot(np.array(c["q"])) @ np.array([0, 0, -1.0])
        to_center = -np.array(c["position"]) / np.linalg.norm(c["position"])
        assert fwd @ to_center > 0.999
        assert np.allclose(fwd, c["forward"], atol=1e-4)


def test_scene_with_valid_ar_poses_yields_metric_scale_with_uncertainty():
    model, ing, sfm_from_world, _ = _scene_inputs(with_ar=True)
    scn = scene.build_scene(model, ing, presets.resolve_settings("standard"))
    sc = scn["scale"]
    assert sc["units"] == "meters" and sc["source"] == "ar_tracking"
    assert sc["relative_uncertainty"] >= scene.AR_SCALE_FLOOR          # never claims better than the floor
    # model units are metres: camera orbit radius was sqrt(2² + 0.8²)
    assert np.isclose(scn["median_camera_distance"], np.hypot(2.0, 0.8), rtol=1e-3)
    assert scn["up_source"] == "ar_gravity"
    assert np.isclose(scn["model_from_sfm"].s, 1 / 3.3, rtol=1e-3)


def test_tracking_segments_are_never_merged():
    """After tracking loss the AR world may have jumped: each segment is aligned on its own and
    the best one is used; poses from the other segment do not corrupt the scale."""
    model, ing, _, _ = _scene_inputs(with_ar=True, segment_break=True)
    scn = scene.build_scene(model, ing, presets.resolve_settings("standard"))
    segs = scn["ar_alignment"]["segments"]
    assert [s["segment"] for s in segs] == [0, 1]
    assert scn["scale"]["units"] == "meters"
    assert scn["scale"]["alignment"]["segment"] == 0
    assert np.isclose(scn["median_camera_distance"], np.hypot(2.0, 0.8), rtol=1e-3)


def test_inconsistent_ar_poses_are_rejected_not_trusted():
    model, ing, _, _ = _scene_inputs(with_ar=True)
    rng = np.random.default_rng(9)
    for f in ing["frames"]:                               # AR positions unrelated to the photos
        f["ar_center"] = rng.normal(size=3).tolist()
    scn = scene.build_scene(model, ing, presets.resolve_settings("standard"))
    assert scn["scale"]["units"] == "arbitrary"
    assert any(w["code"] == "ar_scale_rejected" for w in scn["warnings"])


def test_ar_orientation_convention_mismatch_is_detected():
    """Right positions but orientations in the wrong convention (e.g. a forgotten GL→CV flip)
    must not be accepted silently."""
    model, ing, _, _ = _scene_inputs(with_ar=True)
    for f in ing["frames"]:
        f["ar_R"] = (np.array(f["ar_R"]) @ geom.GL_FROM_CV).tolist()
    scn = scene.build_scene(model, ing, presets.resolve_settings("standard"))
    assert scn["scale"]["units"] == "arbitrary"
    assert scn["ar_alignment"]["segments"][0]["reason"] == "orientation_mismatch"


def test_viewpoint_bins_fill_only_from_distinct_viewpoints():
    up = np.array([0, 1.0, 0])
    same = np.tile(np.array([[1.0, 0.2, 0.0]]), (50, 1))
    b = geom.viewpoint_bins(same, np.zeros(3), up)
    assert b["azimuth_bins_covered"] == 1 and b["bands_covered"] == 1 and np.sum(b["counts"]) == 50
    ring = np.array([[np.cos(a), 0.2, np.sin(a)] for a in np.linspace(0, 2 * np.pi, 30, endpoint=False)])
    b = geom.viewpoint_bins(ring, np.zeros(3), up)
    assert b["azimuth_bins_covered"] == 12 and b["largest_azimuth_gap_deg"] == pytest.approx(12.0, abs=0.01)
    half = ring[:15]
    assert geom.viewpoint_bins(half, np.zeros(3), up)["largest_azimuth_gap_deg"] > 180


def test_focus_point_and_plane_fit():
    cams = _orbit_cameras(center=np.array([0.5, 0.1, -0.3]))
    p, cond = geom.focus_point(np.array([c["center"] for c in cams]), np.array([c["R_wc"][:, 2] for c in cams]))
    assert np.allclose(p, [0.5, 0.1, -0.3], atol=1e-6) and cond > 0.05
    par = np.tile([0, 0, 1.0], (10, 1))                                     # parallel axes: no focus
    _, cond2 = geom.focus_point(np.random.default_rng(0).normal(size=(10, 3)), par)
    assert cond2 < 1e-6
    rng = np.random.default_rng(4)
    pts = np.concatenate([np.stack([rng.uniform(-1, 1, 500), np.full(500, -0.4) + rng.normal(scale=0.002, size=500),
                                    rng.uniform(-1, 1, 500)], axis=1), rng.normal(scale=0.3, size=(200, 3))])
    n, d, mask = geom.fit_plane_ransac(pts, 0.01, normal_prior=np.array([0, 1.0, 0]), seed=1)
    assert n[1] > 0.999 and abs(d - 0.4) < 0.005 and mask[:500].mean() > 0.95
    assert geom.fit_plane_ransac(pts, 0.01, normal_prior=np.array([1.0, 0, 0]), max_angle_deg=10, seed=1) is None \
        or True  # a vertical prior may legitimately find nothing; must not raise


# --------------------------------------------------------------------------------------------
# ingest: focal priors
# --------------------------------------------------------------------------------------------
def test_focal_prior_sources():
    f, src = ingest.focal_prior_px({"focal_35mm": 26.0}, 4000, 3000)
    assert src == "exif35" and f == pytest.approx(26 / 43.2666 * 5000, rel=1e-6)
    # focal-plane resolution is only trusted when the file was verifiably not resized
    exif = {"focal_mm": 30.0, "focal_plane_px_per_mm": 232.0}
    assert ingest.focal_prior_px(exif, 1200, 800) == (None, "default")
    f, src = ingest.focal_prior_px(dict(exif, pixel_x_dimension=5184.0, pixel_y_dimension=3456.0), 5184, 3456)
    assert src == "exif" and f == pytest.approx(6960.0)
    f, src = ingest.focal_prior_px(dict(exif, pixel_x_dimension=5184.0, pixel_y_dimension=3456.0), 1296, 864)
    assert f == pytest.approx(6960.0 / 4)                # resized file: prior rescaled
    assert ingest.focal_prior_px({"focal_35mm": 9000.0}, 4000, 3000) == (None, "default")   # implausible


def test_ingest_makes_upright_working_copies_and_keeps_originals(tmp_path):
    originals = tmp_path / "orig"
    originals.mkdir()
    files = []
    rng = np.random.default_rng(0)
    for i, (orientation, size) in enumerate([(1, (640, 480)), (6, (640, 480)), (3, (640, 480)), (1, (3200, 2400))]):
        img = Image.fromarray(rng.integers(0, 255, (size[1], size[0], 3), dtype=np.uint8))
        exif = Image.Exif()
        exif[0x0112] = orientation
        p = originals / f"{i + 1:04d}.bin"
        img.save(p, "JPEG", quality=90, exif=exif)
        files.append({"id": f"{i + 1:04d}", "name": f"IMG_{i}.jpg", "size": p.stat().st_size})
    (originals / "0005.bin").write_bytes(b"this is not an image")
    files.append({"id": "0005", "name": "broken.jpg", "size": 20})
    cap = tmp_path / "capture.json"
    cap.write_text(json.dumps({"format": 1, "source": "camera", "frames": [
        {"id": "0002", "intrinsics": {"fx": 500.0, "fy": 510.0, "cx": 300.0, "cy": 250.0, "source": "camera2"},
         "pose": {"t": [0, 0, 0], "q": [0, 0, 0, 1], "segment": 2}}]}))
    before = {p.name: p.read_bytes() for p in originals.iterdir()}
    job = {"originals_dir": str(originals), "capture_path": str(cap), "files": files}
    seen = []
    out = ingest.run_ingest(job, presets.resolve_settings("preview"), tmp_path / "work", 2, lambda f, m="": seen.append(f))
    assert {p.name: p.read_bytes() for p in originals.iterdir()} == before          # originals untouched
    fr = {f["id"]: f for f in out["frames"]}
    assert out["rejected"] == [{"id": "0005", "reason": "unreadable"}]
    assert (fr["0001"]["work_w"], fr["0001"]["work_h"]) == (640, 480) and not fr["0001"]["recompressed"]
    assert (tmp_path / "work/images/0001.jpg").read_bytes() == before["0001.bin"]   # byte-identical, no re-encode
    assert (fr["0002"]["work_w"], fr["0002"]["work_h"]) == (480, 640) and fr["0002"]["quarter_turns"] == 1
    with Image.open(tmp_path / "work/images/0002.jpg") as im:
        assert im.size == (480, 640)
    assert max(fr["0004"]["work_w"], fr["0004"]["work_h"]) == 1600 and fr["0004"]["scale"] == pytest.approx(0.5)
    # capture intrinsics rotated into the upright image: fx/fy swap, principal point rotates
    assert fr["0002"]["focal_source"] == "capture" and fr["0002"]["cx"] == pytest.approx(480 - 250.0)
    assert fr["0002"]["cy"] == pytest.approx(300.0) and fr["0002"]["ar_segment"] == 2
    assert seen and seen[-1] == pytest.approx(1.0)
    # different pixel sizes / priors never share one calibrated camera
    assert len(out["groups"]) >= 3


# --------------------------------------------------------------------------------------------
# presets, events, matching pairs, memory adaptation
# --------------------------------------------------------------------------------------------
def test_presets_validation_and_fingerprint():
    s = presets.resolve_settings("standard", {"mesh_target_faces": 50000, "_test": {"x": 1}})
    assert s["mesh_target_faces"] == 50000 and s["_test"] == {"x": 1}
    for bad in ({"nope": 1}, {"mesh_target_faces": "many"}, {"mesh_target_faces": 1}, {"refine": 1},
                {"texture_format": "gif"}, {"dense_views": 2.5}):
        with pytest.raises(presets.SettingsError):
            presets.resolve_settings("standard", bad)
    with pytest.raises(presets.SettingsError):
        presets.resolve_settings("ultra")
    a = presets.settings_fingerprint("standard", presets.resolve_settings("standard"))
    b = presets.settings_fingerprint("standard", presets.resolve_settings("standard", {"_test": 1}))
    c = presets.settings_fingerprint("standard", presets.resolve_settings("standard", {"dense_views": 4}))
    assert a == b != c
    assert set(presets.PRESETS) == {"preview", "standard", "high"}


def test_event_stream_is_monotonic_and_overall_follows_real_stage_progress(tmp_path):
    ev = EventWriter(tmp_path, [s for s in STAGES if s != "refine"])
    ev.stage_start("ingest"); ev.progress(0.5, "half", force=True); ev.stage_end()
    ev.stage_start("features"); ev.progress(1.0, force=True); ev.progress(0.2, force=True); ev.stage_end()
    ev.diagnostics({"a": 1}); ev.artifact("x.json", 3, "ab", "preview"); ev.error("boom", "msg", ["try"])
    lines = [json.loads(line) for line in (tmp_path / "events.jsonl").read_text().splitlines()]
    assert [e["seq"] for e in lines] == list(range(1, len(lines) + 1))
    overall = [e["overall"] for e in lines]
    assert all(b >= a - 1e-9 for a, b in zip(overall, overall[1:])) and overall[-1] < 0.2
    assert lines[0]["data"] == {"index": 0, "count": 9}
    assert lines[-1]["data"] == {"code": "boom", "message": "msg", "guidance": ["try"]}
    assert "refine" not in ev._active


def test_candidate_pairs():
    assert len(sfm.candidate_pairs(10, "exhaustive")) == 45
    seq = sfm.candidate_pairs(200, "sequential")
    assert len(seq) < 200 * 199 / 2 / 4
    s = set(seq)
    assert all(a < b for a, b in seq) and (0, 1) in s and (0, 14) in s and (0, 199) in s   # wraps around the orbit
    assert all((i, i + 1) in s for i in range(199))


def test_memory_adaptation_only_lowers_resolution():
    frames = [{"work_w": 2400, "work_h": 1600}] * 72
    assert mvs.dense_side_for_memory(1200, 72, frames, 16000) == (1200, False)
    side, reduced = mvs.dense_side_for_memory(1200, 72, frames, 4096)
    assert reduced and 480 <= side < 1200 and side % 16 == 0
    assert mvs.dense_side_for_memory(1200, 8, frames[:8], 4096) == (1200, False)
    assert sfm.feature_threads(16, 16000, 2400) == 7 and sfm.feature_threads(16, 2000, 2400) == 1


# --------------------------------------------------------------------------------------------
# mesh helpers + GLB packaging
# --------------------------------------------------------------------------------------------
def _grid(n=6):
    xs, ys = np.meshgrid(np.arange(n, dtype=float), np.arange(n, dtype=float))
    V = np.stack([xs.ravel(), np.zeros(n * n), ys.ravel()], axis=1)
    F = []
    for j in range(n - 1):
        for i in range(n - 1):
            a = j * n + i
            F += [[a, a + n, a + 1], [a + 1, a + n, a + n + 1]]
    return V, np.array(F)


def test_boundary_stats_counts_holes_as_loops():
    V, F = _grid(6)
    b = meshpost.boundary_stats(F, V)
    assert b["boundary_loops"] == 1 and b["boundary_edges"] == 20 and b["boundary_length"] == pytest.approx(20.0)
    centre = V[F].mean(1)
    hole = (np.abs(centre[:, 0] - 2.5) < 0.6) & (np.abs(centre[:, 2] - 2.5) < 0.6)
    b2 = meshpost.boundary_stats(F[~hole], V)
    assert b2["boundary_loops"] == 2                      # outer rim + the hole: holes are preserved, countable


def test_components_and_compact():
    V, F = _grid(4)
    V2 = np.concatenate([V, V + [10, 0, 0]])
    F2 = np.concatenate([F, F + len(V)])
    labels = meshpost.face_components(F2, len(V2))
    assert len(np.unique(labels)) == 2 and (labels[: len(F)] == labels[0]).all()
    Vc, Fc = meshpost.compact(V2, F2[len(F):])
    assert len(Vc) == len(V) and Fc.min() == 0 and np.allclose(Vc, V + [10, 0, 0])


def test_split_nonmanifold_vertices_separates_bowtie_without_moving_geometry():
    # two triangles sharing only one vertex (a "bow tie")
    V = np.array([[0, 0, 0], [1, 0, 0], [0, 1, 0], [-1, 0, 0], [0, -1, 0]], dtype=float)
    F = np.array([[0, 1, 2], [0, 3, 4]])
    V2, F2, added = meshpost.split_nonmanifold_vertices(V, F)
    assert added == 1 and len(V2) == 6
    assert np.allclose(np.sort(V2[F2].reshape(-1, 3), axis=0), np.sort(V[F].reshape(-1, 3), axis=0))
    assert len(set(F2[0]) & set(F2[1])) == 0
    Vg, Fg = _grid(5)                                    # a manifold mesh is left untouched
    V3, F3, added3 = meshpost.split_nonmanifold_vertices(Vg, Fg)
    assert added3 == 0 and len(V3) == len(Vg)
    assert meshpost.face_areas(V3, F3).sum() == pytest.approx(16.0)


def test_ply_mesh_writer_layout(tmp_path):
    V, F = _grid(3)
    p = tmp_path / "m.ply"
    meshpost.write_ply_mesh(p, V, F)
    raw = p.read_bytes()
    head, body = raw.split(b"end_header\n", 1)
    assert b"element vertex 9" in head and b"element face 8" in head and b"property list uchar int vertex_indices" in head
    assert len(body) == 9 * 12 + 8 * 13
    assert struct.unpack_from("<3f", body, 12) == (1.0, 0.0, 0.0)
    assert struct.unpack_from("<B3i", body, 9 * 12) == (3, 0, 3, 1)


def test_glb_round_trip_preserves_geometry_uv_confidence_and_texture_bytes(tmp_path):
    V, F = _grid(4)
    N = np.tile([0, 1.0, 0], (len(V), 1))
    uv = np.stack([V[:, 0] / 3, V[:, 2] / 3], axis=1)
    conf = np.linspace(0, 1, len(V))
    buf = io.BytesIO()
    Image.fromarray(np.random.default_rng(0).integers(0, 255, (8, 8, 3), dtype=np.uint8)).save(buf, "JPEG")
    tex = buf.getvalue()
    extras = {"pocket3d": {"format": 1, "scale": {"units": "arbitrary"}, "holes_preserved": True}}
    path = tmp_path / "m.glb"
    glb.write_glb(path, V, N, uv, conf, [{"indices": F[:9], "image": tex, "mime": "image/jpeg", "name": "a"},
                                         {"indices": F[9:], "image": None, "mime": None, "name": "b"}], extras)
    raw = path.read_bytes()
    magic, version, total = struct.unpack_from("<III", raw, 0)
    assert magic == 0x46546C67 and version == 2 and total == len(raw) and len(raw) % 4 == 0
    back = glb.read_glb(path)
    assert np.allclose(back["positions"], V) and np.allclose(back["uvs"], uv, atol=1e-6)
    assert np.allclose(back["confidence"], conf, atol=1e-6)
    assert np.array_equal(back["faces"], F) and len(back["primitives"]) == 2
    assert back["images"][0]["bytes"] == tex                                  # texture is embedded untouched
    assert back["extras"] == extras
    js = back["json"]
    pos_acc = js["accessors"][js["meshes"][0]["primitives"][0]["attributes"]["POSITION"]]
    assert pos_acc["min"] == [0.0, 0.0, 0.0] and pos_acc["max"] == [3.0, 0.0, 3.0]
    assert all(v["byteOffset"] % 4 == 0 for v in js["bufferViews"])
    assert js["materials"][0]["pbrMetallicRoughness"]["baseColorTexture"]["index"] == 0
    assert "baseColorTexture" not in js["materials"][1]["pbrMetallicRoughness"]
    with pytest.raises(ValueError):
        glb.write_glb(tmp_path / "e.glb", V, N, uv, conf, [{"indices": F[:0], "image": None, "mime": None}], {})


def test_refine_resolution_adapts_to_memory_or_is_skipped():
    frames = [{"work_w": 3600, "work_h": 2400}] * 49
    assert mvs.refine_level_for_memory(49, frames, 8700) == 1      # default companion limit: half-size photos
    assert mvs.refine_level_for_memory(49, frames, 5120) == 2      # measured: level 1 peaks at 6.0 GB
    assert mvs.refine_level_for_memory(49, frames, 2000) == 3
    assert mvs.refine_level_for_memory(400, frames, 1200) is None     # reported as skipped, never silently dropped


def test_focal_drift_widens_ar_scale_uncertainty_and_device_calibration_is_trusted():
    model, ing, _, _ = _scene_inputs(with_ar=True)
    ids = [c["id"] for c in model["cameras"]]
    st = presets.resolve_settings("standard")
    # (a) EXIF prior that bundle adjustment moved by 10 % (as measured on the tumbler dataset)
    ing_a = dict(ing, groups=[{"frames": ids, "focal_px": 1400.0 / 1.10, "has_focal_prior": True, "focal_source": "exif35"}])
    a = scene.build_scene(model, ing_a, st)
    assert a["focal"]["max_drift"] == pytest.approx(0.10, abs=1e-3)
    assert a["scale"]["units"] == "meters" and a["scale"]["relative_uncertainty"] >= 0.10
    # (b) prior and solution agree: only the 3 % floors remain
    ing_b = dict(ing, groups=[{"frames": ids, "focal_px": 1400.0, "has_focal_prior": True, "focal_source": "exif35"}])
    b = scene.build_scene(model, ing_b, st)
    assert 0.04 <= b["scale"]["relative_uncertainty"] < 0.06
    # (c) no prior at all: self-calibrated focal => at least 8 %
    ing_c = dict(ing, groups=[{"frames": ids, "focal_px": 1920.0, "has_focal_prior": False, "focal_source": "default"}])
    c = scene.build_scene(model, ing_c, st)
    assert c["scale"]["relative_uncertainty"] >= 0.08 and c["focal"]["max_drift"] is None
    # (d) device calibration kept fixed: tighter than (b), but never below the visual-inertial floor
    ing_d = dict(ing, groups=[{"frames": ids, "focal_px": 1400.0, "has_focal_prior": True, "focal_source": "capture"}])
    d = scene.build_scene(model, ing_d, st, focal_fixed=True)
    assert scene.AR_SCALE_FLOOR < d["scale"]["relative_uncertainty"] < b["scale"]["relative_uncertainty"]
    # without AR nothing metric is claimed, whatever the focal says
    model2, ing2, _, _ = _scene_inputs(with_ar=False)
    e = scene.build_scene(model2, dict(ing2, groups=ing_a["groups"]), st)
    assert e["scale"]["units"] == "arbitrary" and e["scale"]["relative_uncertainty"] is None


def test_region_boundary_counts_holes_not_the_cut_around_the_region():
    V, F = _grid(9)
    centre = V[F].mean(1)
    hole = (np.abs(centre[:, 0] - 4.0) < 0.6) & (np.abs(centre[:, 2] - 4.0) < 0.6)
    Fh = F[~hole]                                               # the whole mesh: rim + one hole
    region = (np.abs(V[Fh].mean(1)[:, 0] - 4.0) < 2.6) & (np.abs(V[Fh].mean(1)[:, 2] - 4.0) < 2.6)
    naive = meshpost.boundary_stats(Fh[region], V)
    real = meshpost.boundary_stats(Fh[region], V, whole=Fh)
    assert naive["boundary_loops"] == 2                         # the cut-out square counted as if it were a hole
    assert real["boundary_loops"] == 1 and real["cut_edges_excluded"] > 0
    assert real["boundary_edges"] == meshpost.boundary_stats(Fh, V)["boundary_edges"] - 32   # minus the outer rim (4 x 8)
    solid = meshpost.boundary_stats(F[(np.abs(centre[:, 0] - 4.0) < 2.6)], V, whole=F)
    assert solid["boundary_loops"] >= 0 and solid["cut_edges_excluded"] > 0


def test_parallax_ratio_separates_orbit_from_turning_on_the_spot():
    model, _, _, _ = _scene_inputs(with_ar=False)
    assert scene.parallax_ratio(model) > 1.0                               # full orbit
    half = dict(model, cameras=model["cameras"][:6])                       # a 50° arc still has parallax
    assert scene.parallax_ratio(half) > 0.3
    rng = np.random.default_rng(0)
    spot = dict(model, cameras=[dict(c, center=np.array([1.0, 0.5, 0.2]) + rng.normal(scale=1e-3, size=3))
                                for c in model["cameras"]])
    assert scene.parallax_ratio(spot) < 0.01                               # panorama: all cameras in one place
    assert scene.parallax_ratio(dict(model, cameras=model["cameras"][:1])) == 0.0


def test_lacks_parallax_uses_two_view_configurations_measured_on_real_runs():
    pano = {"pairs_classified": 20, "pairs_without_3d_evidence": 20}           # synthetic panorama
    tumbler = {"pairs_classified": 153, "pairs_without_3d_evidence": 90}       # object on a carpet: floor plane dominates
    dino = {"pairs_classified": 236, "pairs_without_3d_evidence": 3}
    assert sfm.lacks_parallax(pano) and not sfm.lacks_parallax(tumbler) and not sfm.lacks_parallax(dino)
    assert not sfm.lacks_parallax(None) and not sfm.lacks_parallax({"pairs_classified": 2, "pairs_without_3d_evidence": 2})


def test_rotation_conventions_match_the_phone_literals():
    """Same literal table as android/core ImageGeometryTest.rotationConventionsMatchTheCompanionLiterals."""
    k = (1000.0, 1010.0, 620.0, 350.0)                       # stored image 1280 x 720
    expect_k = {0: (1000.0, 1010.0, 620.0, 350.0), 1: (1010.0, 1000.0, 370.0, 620.0),
                2: (1000.0, 1010.0, 660.0, 370.0), 3: (1010.0, 1000.0, 350.0, 660.0)}
    expect_pixel = {0: (100.0, 40.0), 1: (680.0, 100.0), 2: (1180.0, 680.0), 3: (40.0, 1180.0)}
    for t in range(4):
        assert geom.rotate_intrinsics(*k, 1280, 720, t) == expect_k[t]
        assert geom.rotate_pixel(100.0, 40.0, 1280, 720, t) == expect_pixel[t]


def test_two_view_configuration_names_survive_integer_values():
    """The image's pycolmap returns the configuration of stored two-view geometries as a bare
    int; counting those under "6" instead of PLANAR_OR_PANORAMIC silently disabled the
    turning-on-the-spot diagnosis (found by the container e2e test)."""
    from pocket3d_companion.pipeline import sfm

    class Enumish:                      # what pycolmap returns in other code paths
        def __init__(self, name, value): self.name, self.value = name, value
        def __int__(self): return self.value
    for value, name in sfm.TWO_VIEW_CONFIG_NAMES.items():
        assert sfm.two_view_config_name(Enumish(name, value)) == name
        assert sfm.two_view_config_name(value) == name
        assert sfm.two_view_config_name(np.int64(value)) == name
    assert sfm.NO_3D_CONFIGS <= set(sfm.TWO_VIEW_CONFIG_NAMES.values())
    assert sfm.two_view_config_name(6) == "PLANAR_OR_PANORAMIC"
    assert sfm.two_view_config_name("nonsense") == "nonsense"
    counted = {sfm.two_view_config_name(6): 18, sfm.two_view_config_name(7): 2}
    flat = sum(v for k, v in counted.items() if k in sfm.NO_3D_CONFIGS)
    assert sfm.lacks_parallax({"pairs_classified": 20, "pairs_without_3d_evidence": flat})
    assert not sfm.lacks_parallax({"pairs_classified": 153, "pairs_without_3d_evidence": 90})
