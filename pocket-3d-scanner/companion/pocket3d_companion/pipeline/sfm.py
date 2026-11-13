"""Stages `features`, `matching`, `sfm`: structure-from-motion with COLMAP (pycolmap).

Feature extraction (SIFT), exhaustive/sequential matching with geometric verification,
incremental mapping with bundle adjustment. Camera intrinsics start from the capture/EXIF
priors prepared by `ingest` and are refined by bundle adjustment.
"""
from __future__ import annotations

from pathlib import Path

import numpy as np

from .errors import GUIDANCE_REGISTRATION, Cancelled, PipelineError


def _pc():
    import pycolmap  # imported lazily so pure-python modules stay importable without it
    return pycolmap


def _camera_params(model: str, g: dict) -> list[float]:
    f, cx, cy = g["focal_px"], g["cx"], g["cy"]
    d = g.get("distortion") or [0.0] * 5
    if model == "SIMPLE_PINHOLE":
        return [f, cx, cy]
    if model == "PINHOLE":
        return [f, f, cx, cy]
    if model == "SIMPLE_RADIAL":
        return [f, cx, cy, d[0]]
    if model == "RADIAL":
        return [f, cx, cy, d[0], d[1]]
    if model == "OPENCV":
        return [f, f, cx, cy, d[0], d[1], d[2], d[3]]
    raise ValueError(model)


def feature_threads(threads: int, memory_mb: int, feature_max_side: int) -> int:
    """SIFT with first_octave = -1 builds a 2x up-sampled float scale space per worker; bound the
    number of workers by memory (measured: ≈ 1.3 GB per worker at 2400 px, scaling with area)."""
    per_worker_mb = 1300.0 * (feature_max_side / 2400.0) ** 2
    by_mem = int(max(1, (memory_mb * 0.6) // per_worker_mb))
    return max(1, min(threads, by_mem))


def run_features(ingest: dict, work: Path, settings: dict, threads: int, memory_mb: int, progress, cancel) -> dict:
    pycolmap = _pc()
    col = work / "colmap"
    col.mkdir(parents=True, exist_ok=True)
    db_path = col / "database.db"
    for p in (db_path, col / "database.db-shm", col / "database.db-wal"):
        if p.exists():
            p.unlink()
    model = settings["camera_model"]
    frames = {f["id"]: f for f in ingest["frames"] if not f["rejected"]}
    db = pycolmap.Database.open(db_path)
    cam_ids = []
    try:
        for g in ingest["groups"]:
            cam = pycolmap.Camera(model=model, width=int(g["width"]), height=int(g["height"]),
                                  params=_camera_params(model, g))
            cam.has_prior_focal_length = bool(g["has_focal_prior"])
            cam_ids.append(db.write_camera(cam))
    finally:
        db.close()

    eo = pycolmap.FeatureExtractionOptions()
    eo.max_image_size = int(settings["feature_max_side"])
    eo.num_threads = feature_threads(threads, memory_mb, int(settings["feature_max_side"]))
    eo.use_gpu = False
    eo.sift.max_num_features = int(settings["max_features"])
    total = len(frames)
    done = 0
    for g, cam_id in zip(ingest["groups"], cam_ids):
        names = [frames[i]["work_name"] for i in g["frames"]]
        ro = pycolmap.ImageReaderOptions()
        ro.camera_model = model
        ro.existing_camera_id = cam_id
        chunk = max(eo.num_threads, 4)
        for i in range(0, len(names), chunk):
            if cancel.is_set():
                raise Cancelled()
            part = names[i:i + chunk]
            pycolmap.extract_features(db_path, work / "images", image_names=part,
                                      camera_mode=pycolmap.CameraMode.SINGLE, reader_options=ro,
                                      extraction_options=eo, device=pycolmap.Device.cpu)
            done += len(part)
            progress(done / total, f"Features {done}/{total} photos")
    db = pycolmap.Database.open(db_path)
    try:
        per_image = {}
        for img in db.read_all_images():
            per_image[img.name] = int(db.num_keypoints_for_image(img.image_id))
        n_cams = db.num_cameras()
    finally:
        db.close()
    counts = [per_image.get(f["work_name"], 0) for f in frames.values()]
    return {"database": str(db_path), "features_per_image": per_image, "extract_threads": eo.num_threads,
            "median_features": int(np.median(counts)) if counts else 0, "cameras": int(n_cams)}


def candidate_pairs(n: int, mode: str) -> list[tuple[int, int]]:
    """Image pairs (indices into the capture order) to match.

    exhaustive: every pair. sequential: each photo against its next 14 neighbours plus
    progressively farther ones (20, 28, 40, 56, …), with wrap-around because an orbit capture
    returns to where it started."""
    if mode == "exhaustive":
        return [(i, j) for i in range(n) for j in range(i + 1, n)]
    offsets = list(range(1, 15))
    d = 20.0
    while d < n / 2:
        offsets.append(int(round(d)))
        d *= 1.4
    pairs = set()
    for i in range(n):
        for off in offsets:
            j = (i + off) % n
            if i != j:
                pairs.add((min(i, j), max(i, j)))
    return sorted(pairs)


def run_matching(ingest: dict, work: Path, settings: dict, threads: int, progress, cancel) -> dict:
    """Descriptor matching + geometric verification, run in chunks of image pairs so that
    progress reflects pairs actually processed and cancellation is honoured between chunks.
    (The database is only ever touched through COLMAP's own SQLite instance: a second SQLite
    library in the same process does not share POSIX locks with it.)"""
    pycolmap = _pc()
    db_path = work / "colmap" / "database.db"
    frames = sorted((f for f in ingest["frames"] if not f["rejected"]), key=lambda f: f["index"])
    n = len(frames)
    mode = settings["matcher"]
    ordered = ingest.get("capture_source") in ("camera", "camera_ar")
    if mode == "auto":
        mode = "exhaustive" if (n <= int(settings["exhaustive_max_images"]) or not ordered) else "sequential"
    pairs = candidate_pairs(n, mode)
    db = pycolmap.Database.open(db_path)
    try:
        db.clear_matches()
        db.clear_two_view_geometries()
    finally:
        db.close()
    mo = pycolmap.FeatureMatchingOptions()
    mo.num_threads = threads
    mo.use_gpu = False
    vo = pycolmap.TwoViewGeometryOptions()
    vo.ransac.random_seed = int(settings["seed"])
    chunk = int(min(600, max(60, len(pairs) // 25 + 1)))
    pair_file = work / "colmap" / "pairs.txt"
    done = 0
    for i in range(0, len(pairs), chunk):
        if cancel.is_set():
            raise Cancelled()
        part = pairs[i:i + chunk]
        pair_file.write_text("".join(f"{frames[a]['work_name']} {frames[b]['work_name']}\n" for a, b in part))
        po = pycolmap.ImportedPairingOptions()
        po.match_list_path = str(pair_file)
        po.block_size = len(part)
        pycolmap.match_image_pairs(db_path, matching_options=mo, pairing_options=po, verification_options=vo,
                                   device=pycolmap.Device.cpu)
        done += len(part)
        progress(done / len(pairs), f"Matched {done}/{len(pairs)} photo pairs")
    if cancel.is_set():
        raise Cancelled()
    db = pycolmap.Database.open(db_path)
    configs: dict[str, int] = {}
    try:
        verified = int(db.num_verified_image_pairs())
        inliers = int(db.num_inlier_matches())
        try:
            r = db.read_two_view_geometries()
            for g in (r[1] if isinstance(r, tuple) else r):
                if len(g.inlier_matches) >= 15:
                    name = two_view_config_name(g.config)
                    configs[name] = configs.get(name, 0) + 1
        except Exception:                 # diagnostic only; never fail matching because of it
            configs = {}
    finally:
        db.close()
    # Pairs whose geometry is explained by a homography alone (pure rotation or one plane) carry
    # no evidence of 3D structure; COLMAP labels them PANORAMIC / PLANAR_OR_PANORAMIC.
    flat = sum(v for k, v in configs.items() if k in NO_3D_CONFIGS)
    return {"mode": mode, "pairs_tested": len(pairs), "pairs_verified": verified, "inlier_matches": inliers,
            "pairs_possible": n * (n - 1) // 2, "pair_configurations": configs,
            "pairs_without_3d_evidence": flat, "pairs_classified": int(sum(configs.values()))}


NO_3D_CONFIGS = {"PANORAMIC", "PLANAR_OR_PANORAMIC", "WATERMARK", "DEGENERATE"}


# colmap::TwoViewGeometry::ConfigurationType (COLMAP 4.x), checked against pycolmap 4.2.1 in the image.
TWO_VIEW_CONFIG_NAMES = {0: "UNDEFINED", 1: "DEGENERATE", 2: "CALIBRATED", 3: "UNCALIBRATED", 4: "PLANAR",
                         5: "PANORAMIC", 6: "PLANAR_OR_PANORAMIC", 7: "WATERMARK", 8: "MULTIPLE",
                         9: "CALIBRATED_RIG"}


def two_view_config_name(config: object) -> str:
    """COLMAP's two-view configuration as its enum name. Depending on how the geometry was read,
    pycolmap hands out the enum or a bare integer (6 for PLANAR_OR_PANORAMIC); a number must
    never reach the name-based classification below."""
    name = getattr(config, "name", None)
    if isinstance(name, str):
        return name
    try:
        return TWO_VIEW_CONFIG_NAMES[int(config)]      # type: ignore[call-overload]
    except (KeyError, TypeError, ValueError):
        return str(config)


def lacks_parallax(matching: dict | None) -> bool:
    """True when (nearly) every matched photo pair is explained by a homography: the camera
    turned on the spot, or the scene is one flat surface. Measured on the example data: 100 % of
    the pairs for a synthetic panorama, 59 % for the tumbler on its carpet (dominant floor
    plane), 3–25 % for the other objects."""
    m = matching or {}
    classified = m.get("pairs_classified", 0)
    return classified >= 3 and m.get("pairs_without_3d_evidence", 0) >= 0.9 * classified


GUIDANCE_PARALLAX = [
    "Walk around the object: the camera has to change position between photos, not just direction.",
    "Keep the object centred while you move, with a step of roughly 10–15° around it between photos.",
    "Standing in one place and turning (a panorama) or zooming cannot give depth, however many photos overlap.",
]


def run_mapping(ingest: dict, work: Path, settings: dict, threads: int, progress, cancel,
                matching: dict | None = None) -> dict:
    """Incremental SfM. Keeps the largest model; images outside it are reported as unregistered —
    separate models are never merged without shared geometry."""
    pycolmap = _pc()
    db_path = work / "colmap" / "database.db"
    out = work / "colmap" / "sparse"
    if out.exists():
        import shutil
        shutil.rmtree(out)
    out.mkdir(parents=True)
    frames = [f for f in ingest["frames"] if not f["rejected"]]
    n = len(frames)
    if lacks_parallax(matching):
        # COLMAP can still "solve" such a set (it happily fits a bogus focal length and distortion),
        # but the result is numerically meaningless: stop here with the real reason.
        raise PipelineError(
            "no_parallax",
            "The photos match each other well, but they contain no parallax: the camera seems to have turned on "
            "the spot (or the scene is a single flat surface), so depth cannot be recovered.",
            GUIDANCE_PARALLAX)
    opts = pycolmap.IncrementalPipelineOptions()
    opts.num_threads = threads
    opts.min_model_size = 3
    opts.multiple_models = True
    opts.max_num_models = 10
    opts.extract_colors = True
    # Cameras registered without any 3D structure (2D-2D only) are useless for dense stereo and
    # make degenerate "reconstructions" out of panoramas: do not accept them.
    if hasattr(opts, "structure_less_registration_fallback"):
        opts.structure_less_registration_fallback = False
    if hasattr(opts, "structure_less_registration_only"):
        opts.structure_less_registration_only = False
    opts.random_seed = int(settings["seed"])
    opts.mapper.random_seed = int(settings["seed"])
    # Calibration from only a handful of views is unstable: keep principal point fixed (default)
    # and let BA refine focal length + radial distortion — except when every camera comes with a
    # device calibration (ARCore / Camera2 intrinsics): for small objects seen from all around,
    # focal length and camera distance are nearly interchangeable in bundle adjustment (measured
    # on the tumbler dataset: 10 % focal drift with a perfectly good shape), so a calibrated
    # focal length is kept fixed rather than "refined" away.
    focal_fixed = bool(ingest["groups"]) and all(g.get("focal_source") == "capture" for g in ingest["groups"])
    if focal_fixed:
        opts.ba_refine_focal_length = False
    state = {"attempt": 0, "count": 0, "best": 0}

    def on_initial():
        state["attempt"] += 1
        state["count"] = 2
        _report()

    def on_next():
        state["count"] += 1
        _report()

    def _report():
        state["best"] = max(state["best"], state["count"])
        progress(min(0.98, state["best"] / max(n, 1)),
                 f"Registered {state['count']}/{n} cameras" + (f" (model {state['attempt']})" if state["attempt"] > 1 else ""))
        if cancel.is_set():
            raise Cancelled()

    pycolmap.set_random_seed(int(settings["seed"]))
    try:
        recs = pycolmap.incremental_mapping(db_path, work / "images", out, options=opts,
                                            initial_image_pair_callback=on_initial, next_image_callback=on_next)
    except Cancelled:
        raise
    except Exception as e:  # pycolmap wraps callback exceptions
        if cancel.is_set():
            raise Cancelled() from e
        raise
    if cancel.is_set():
        raise Cancelled()
    models = sorted(((r.num_reg_images(), k) for k, r in recs.items()), reverse=True)
    name_to_id = {f["work_name"]: f["id"] for f in frames}
    # A "model" with cameras but (almost) no triangulated points is not a reconstruction.
    def _usable(count_key):
        r = recs[count_key[1]]
        return r.num_points3D() >= max(30, 5 * count_key[0])
    models = [m for m in models if _usable(m)]
    if not models or models[0][0] < 2:
        # Plenty of verified matches but no reconstruction: the photos see the same things without
        # parallax (camera turned on the spot / zoomed). More overlap or texture would not help.
        m = matching or {}
        verified, tested, inliers = m.get("pairs_verified", 0), m.get("pairs_tested", 0), m.get("inlier_matches", 0)
        if tested and verified >= max(3, 0.3 * tested) and inliers >= 100 * verified:
            raise PipelineError(
                "no_parallax",
                "The photos match each other well, but they contain no parallax: the camera seems to have "
                "turned on the spot (or only zoomed) instead of moving around the object, so depth cannot be recovered.",
                GUIDANCE_PARALLAX)
        raise PipelineError(
            "insufficient_registration",
            "No two photographs could be related geometrically, so no camera positions were recovered.",
            GUIDANCE_REGISTRATION)
    best = recs[models[0][1]]
    best_dir = work / "colmap" / "best"
    best_dir.mkdir(exist_ok=True)
    best.write(best_dir)
    registered = sorted(name_to_id[img.name] for img in best.images.values() if img.has_pose and img.name in name_to_id)
    other_models = []
    in_other: dict[str, int] = {}
    for cnt, k in models[1:]:
        ids = sorted(name_to_id[i.name] for i in recs[k].images.values() if i.has_pose and i.name in name_to_id)
        other_models.append({"cameras": len(ids), "frames": ids})
        for i in ids:
            in_other.setdefault(i, len(other_models) - 1)
    unregistered = []
    for f in frames:
        if f["id"] in registered:
            continue
        reason = "separate_group" if f["id"] in in_other else "no_reliable_matches"
        unregistered.append({"id": f["id"], "reason": reason})
    min_needed = max(int(settings["min_registered"]), int(np.ceil(float(settings["min_registered_fraction"]) * n)))
    summary = {
        "input_frames": n, "registered": len(registered), "registered_ids": registered,
        "unregistered": unregistered, "other_models": other_models,
        "sparse_points": int(best.num_points3D()),
        "mean_reprojection_error_px": round(float(best.compute_mean_reprojection_error()), 4),
        "mean_track_length": round(float(best.compute_mean_track_length()), 3),
        "mean_observations_per_image": round(float(best.compute_mean_observations_per_reg_image()), 1),
        "cameras": [{"camera_id": int(cid), "model": cam.model.name, "width": int(cam.width), "height": int(cam.height),
                     "params": [round(float(p), 6) for p in cam.params],
                     "has_prior_focal_length": bool(cam.has_prior_focal_length)}
                    for cid, cam in best.cameras.items()],
        "model_dir": str(best_dir),
        "focal_length_fixed_from_device_calibration": focal_fixed,
    }
    if len(registered) < min_needed:
        raise PipelineError(
            "insufficient_registration",
            f"Only {len(registered)} of {n} photographs could be registered into one consistent set of camera "
            f"positions (need at least {min_needed}).",
            GUIDANCE_REGISTRATION, )
    return summary


def load_model(model_dir: str | Path, ingest: dict) -> dict:
    """Read the chosen sparse model into plain numpy structures (SfM frame, CV cameras)."""
    pycolmap = _pc()
    rec = pycolmap.Reconstruction(str(model_dir))
    name_to_frame = {f["work_name"]: f for f in ingest["frames"] if not f["rejected"]}
    cams = []
    for img in rec.images.values():
        if not img.has_pose or img.name not in name_to_frame:
            continue
        cfw = img.cam_from_world() if callable(img.cam_from_world) else img.cam_from_world
        R_cw = np.asarray(cfw.rotation.matrix(), dtype=float)
        t_cw = np.asarray(cfw.translation, dtype=float)
        cam = rec.cameras[img.camera_id]
        fr = name_to_frame[img.name]
        cams.append({
            "id": fr["id"], "name": fr["name"], "index": fr["index"], "image_id": int(img.image_id),
            "work_name": img.name,
            "R_wc": R_cw.T, "center": -R_cw.T @ t_cw,
            "width": int(cam.width), "height": int(cam.height),
            "fx": float(cam.focal_length_x), "fy": float(cam.focal_length_y),
            "cx": float(cam.principal_point_x), "cy": float(cam.principal_point_y),
            "model": cam.model.name, "params": [float(p) for p in cam.params],
            "num_points": int(img.num_points3D),
        })
    cams.sort(key=lambda c: c["index"])
    pts = rec.points3D
    xyz = np.array([p.xyz for p in pts.values()], dtype=float).reshape(-1, 3)
    rgb = np.array([p.color for p in pts.values()], dtype=np.uint8).reshape(-1, 3)
    track = np.array([p.track.length() for p in pts.values()], dtype=int)
    err = np.array([p.error for p in pts.values()], dtype=float)
    return {"cameras": cams, "xyz": xyz, "rgb": rgb, "track": track, "error": err}
