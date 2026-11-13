"""Model frame, scale, viewpoint coverage and the provisional sparse preview.

Runs right after SfM so that the sparse preview and the final mesh share one coordinate frame:

    model = s * R @ sfm + t        (geom.Sim3 `model_from_sfm`)

* origin  — the point the cameras converge on (the object), see geom.focus_point;
* +Y      — up: gravity from validated AR tracking when available, otherwise the mean camera
            'up' refined by the support plane the object stands on (if one is found);
* scale   — metres only when AR tracking positions agree with the SfM camera positions under
            one similarity transform (validated, with an uncertainty estimate). Otherwise the
            unit is ARBITRARY: normalised so the median camera-to-object distance is 1.0, and
            every consumer is told so explicitly.
"""
from __future__ import annotations

import base64

import numpy as np

from . import geom

AR_SCALE_FLOOR = 0.03  # assumed lower bound of visual-inertial scale error (not measured per device)


def _unit(v):
    v = np.asarray(v, dtype=float)
    n = np.linalg.norm(v)
    return v / n if n > 0 else v


def align_ar(cams: list[dict], frames_by_id: dict, seed: int) -> dict | None:
    """Similarity between SfM camera centres and AR tracking positions, per tracking segment.
    Segments are never merged: after tracking loss the AR world frame may have changed."""
    segs: dict[int, list[tuple[np.ndarray, np.ndarray, np.ndarray, np.ndarray]]] = {}
    for c in cams:
        fr = frames_by_id.get(c["id"])
        if fr and fr.get("ar_center") is not None and fr.get("ar_R") is not None:
            segs.setdefault(int(fr.get("ar_segment") or 0), []).append(
                (c["center"], np.array(fr["ar_center"]), c["R_wc"], np.array(fr["ar_R"])))
    report = []
    best = None
    for seg, pairs in sorted(segs.items()):
        entry = {"segment": seg, "frames": len(pairs), "accepted": False}
        report.append(entry)
        if len(pairs) < 6:
            entry["reason"] = "too_few_tracked_frames"
            continue
        src = np.array([p[0] for p in pairs])
        dst = np.array([p[1] for p in pairs])
        spread = float(np.sqrt(((dst - dst.mean(0)) ** 2).sum(1).mean()))
        entry["baseline_rms_m"] = round(spread, 4)
        if spread < 0.05:
            entry["reason"] = "camera_barely_moved"
            continue
        fit = geom.fit_sim3_ransac(src, dst, threshold=max(0.015, 0.06 * spread), seed=seed)
        if fit is None:
            entry["reason"] = "no_consistent_alignment"
            continue
        inl = int(fit.inliers.sum())
        # Rotation check: aligned SfM camera orientations must agree with the AR orientations.
        # A convention mix-up (wrong axis flip / image rotation) shows up here, not in positions.
        angles = []
        for (c_sfm, c_ar, R_sfm, R_ar), ok in zip(pairs, fit.inliers):
            if not ok:
                continue
            dR = (fit.sim3.R @ R_sfm).T @ R_ar
            angles.append(np.degrees(np.arccos(np.clip((np.trace(dR) - 1) / 2, -1, 1))))
        med_angle = float(np.median(angles)) if angles else 180.0
        entry.update({"inliers": inl, "inlier_fraction": round(inl / len(pairs), 3),
                      "rms_m": round(fit.rms, 4), "scale_m_per_sfm_unit": fit.sim3.s,
                      "scale_bootstrap_rel_std": round(fit.scale_rel_std, 5),
                      "rotation_residual_deg": round(med_angle, 2)})
        if inl < 6 or inl < 0.6 * len(pairs):
            entry["reason"] = "low_consensus"
            continue
        if not np.isfinite(fit.scale_rel_std) or fit.scale_rel_std > 0.05:
            entry["reason"] = "scale_unstable"
            continue
        if med_angle > 12.0:
            entry["reason"] = "orientation_mismatch"
            continue
        entry["accepted"] = True
        # (the focal-length term is added in build_scene: it does not depend on the segment)
        rel_unc = float(np.sqrt((2 * fit.scale_rel_std) ** 2 + (fit.rms / max(fit.extent, 1e-9)) ** 2 * 0.25
                                + AR_SCALE_FLOOR ** 2))
        cand = {"segment": seg, "sim3": fit.sim3, "inliers": inl, "relative_uncertainty": rel_unc,
                "rms_m": fit.rms, "rotation_residual_deg": med_angle}
        if best is None or inl > best["inliers"]:
            best = cand
    return {"segments": report, "best": best} if report else None


def parallax_ratio(model: dict) -> float:
    """Largest distance between camera centres divided by the median camera-to-point distance.
    ≈ 2 for a full orbit, ≈ 0.2–1 for a partial walk-around, ≈ 0 when the camera only turned on
    the spot (a panorama) — in which case any 'reconstruction' is numerically meaningless."""
    centers = np.array([c["center"] for c in model["cameras"]], dtype=float)
    xyz = np.asarray(model["xyz"], dtype=float)
    if len(centers) < 2 or len(xyz) == 0:
        return 0.0
    spread = float(np.linalg.norm(centers.max(0) - centers.min(0)))
    depth = float(np.median(np.linalg.norm(xyz - centers.mean(0), axis=1)))
    return spread / depth if depth > 0 else 0.0


def focal_consistency(model: dict, ingest: dict, focal_fixed: bool = False) -> dict:
    """How far the focal length solved by bundle adjustment is from the prior (capture
    calibration or EXIF), and the scale uncertainty that follows from it.

    For an object-centred capture a focal-length error of x % moves all cameras ~x % closer to
    or farther from the object without visibly hurting the fit, so any scale derived from
    CAMERA positions (AR tracking, ground-truth poses) carries about that relative error. The
    reconstructed shape is not affected."""
    by_frame = {c["id"]: c for c in model["cameras"]}
    ratios, sources = [], set()
    for g in ingest.get("groups", []):
        fx = [by_frame[i]["fx"] for i in g["frames"] if i in by_frame]
        if not fx:
            continue
        sources.add(g.get("focal_source", "default"))
        if g.get("has_focal_prior") and g.get("focal_px"):
            ratios.append(float(np.median(fx)) / float(g["focal_px"]))
    drift = max((abs(r - 1.0) for r in ratios), default=None)
    if focal_fixed:
        term, basis = 0.02, "device calibration kept fixed"
    elif ratios and len(ratios) == len(ingest.get("groups", [])):
        term, basis = max(0.03, drift), "focal length refined from a metadata prior"
    else:
        term, basis = 0.08, "focal length self-calibrated without a usable prior"
    return {"solved_over_prior": [round(r, 4) for r in ratios], "max_drift": None if drift is None else round(drift, 4),
            "prior_sources": sorted(sources), "scale_uncertainty_term": round(term, 4), "basis": basis}


def build_scene(model: dict, ingest: dict, settings: dict, focal_fixed: bool = False) -> dict:
    cams = model["cameras"]
    centers = np.array([c["center"] for c in cams])
    fwd = np.array([c["R_wc"][:, 2] for c in cams])
    ups = np.array([-c["R_wc"][:, 1] for c in cams])
    warnings: list[dict] = []

    x0, cond = geom.focus_point(centers, fwd)
    in_front = float((((x0 - centers) * fwd).sum(1) > 0).mean())
    xyz, track = model["xyz"], model["track"]
    good = track >= 3 if (track >= 3).sum() >= 50 else np.ones(len(xyz), bool)
    converging = cond > 0.01 and in_front > 0.7
    if not converging:
        # Forward-facing / panning capture: there is no orbit centre; use the bulk of the points.
        x0 = np.median(xyz[good], axis=0) if good.any() else centers.mean(0)
        warnings.append({"code": "cameras_do_not_converge",
                         "message": "The camera views do not converge on a single object. Walk around the "
                                    "object while keeping it centred to get an all-round model."})
    cam_dist = np.linalg.norm(centers - x0, axis=1)
    D = float(np.median(cam_dist))

    frames_by_id = {f["id"]: f for f in ingest["frames"]}
    ar = align_ar(cams, frames_by_id, int(settings["seed"]))
    up_source = "camera_up"
    up = _unit(ups.mean(0))
    scale_info: dict
    focal = focal_consistency(model, ingest, focal_fixed)
    if ar and ar["best"]:
        b = ar["best"]
        up = _unit(b["sim3"].R.T @ np.array([0.0, 1.0, 0.0]))
        up_source = "ar_gravity"
        s_model = float(b["sim3"].s)
        rel = float(np.sqrt(b["relative_uncertainty"] ** 2 + focal["scale_uncertainty_term"] ** 2))
        scale_info = {"units": "meters", "source": "ar_tracking", "meters_per_unit": 1.0,
                      "relative_uncertainty": round(rel, 4),
                      "note": "Metric scale estimated by aligning SfM camera positions to AR tracking "
                              "positions. The uncertainty combines the alignment itself, an assumed 3% "
                              "floor for visual-inertial scale drift and the focal-length/camera-distance "
                              f"ambiguity ({focal['basis']}: ±{focal['scale_uncertainty_term'] * 100:.0f}%). "
                              "Verify with a known distance for measurements that matter.",
                      "alignment": {"segment": b["segment"], "inliers": b["inliers"], "rms_m": round(b["rms_m"], 4),
                                    "rotation_residual_deg": round(b["rotation_residual_deg"], 2)}}
    else:
        s_model = 1.0 / D if D > 0 else 1.0
        scale_info = {"units": "arbitrary", "source": "none", "meters_per_unit": None,
                      "relative_uncertainty": None,
                      "note": "Photographs alone do not determine real-world size. Units are arbitrary "
                              "(median camera-to-object distance = 1). Calibrate with a known distance to "
                              "get real measurements."}
        if ar:
            warnings.append({"code": "ar_scale_rejected",
                             "message": "AR tracking positions were supplied but did not agree with the "
                                        "reconstructed camera positions; they were not used for scale."})

    # Support plane (table/floor) from sparse points near the object, below the focus point.
    ground = None
    near = good & (np.linalg.norm(xyz - x0, axis=1) < 1.2 * D)
    pts = xyz[near]
    if len(pts) >= 80:
        fit = geom.fit_plane_ransac(pts, threshold=0.012 * D, seed=int(settings["seed"]), normal_prior=up,
                                    max_angle_deg=35.0 if up_source == "camera_up" else 12.0)
        if fit is not None:
            n, d, mask = fit
            below_focus = float(n @ x0 + d) > 0.02 * D          # plane lies under the focus point
            cams_above = float(((centers @ n + d) > 0).mean())   # cameras look at it from above
            if mask.sum() >= max(60, 0.12 * len(pts)) and below_focus and cams_above > 0.8:
                ground = {"n_sfm": n, "d_sfm": d, "inliers": int(mask.sum()), "points_considered": int(len(pts))}
                if up_source == "camera_up":
                    up, up_source = n, "support_plane"

    # Model frame axes
    y = _unit(up)
    ref = centers[0] - x0
    z = ref - (ref @ y) * y
    if np.linalg.norm(z) < 1e-6 * max(D, 1e-9):
        z = np.cross(y, [1.0, 0, 0])
    z = _unit(z)
    x = np.cross(y, z)
    R = np.stack([x, y, z])
    sim = geom.Sim3(s_model, R, -s_model * R @ x0)

    positions = sim.apply(centers)
    coverage = geom.viewpoint_bins(positions, np.zeros(3), np.array([0.0, 1.0, 0.0]))
    coverage["kind"] = "registered_viewpoints"
    coverage["note"] = ("Where registered photos were taken from, around the object. This is viewpoint "
                        "coverage — it does not prove the facing surface was reconstructed.")

    pm = sim.apply(xyz)
    inner = good & (np.linalg.norm(xyz - x0, axis=1) < 0.85 * cam_dist.min()) if converging else good
    r_obj = float(np.percentile(np.linalg.norm(pm[inner], axis=1), 90)) if inner.sum() >= 20 else float(0.5 * D * s_model)
    ground_model = None
    if ground is not None:
        # plane in model frame: n_m = R n ; point p_m = sim(p)
        n_m = R @ ground["n_sfm"]
        p_sfm = -ground["d_sfm"] * ground["n_sfm"]
        d_m = -float(n_m @ sim.apply(p_sfm))
        ground_model = {"normal": n_m.round(6).tolist(), "d": round(d_m, 6), "height_y": round(-d_m / n_m[1], 6),
                        "source": "sparse_points", "inliers": ground["inliers"]}

    return {
        "model_from_sfm": sim,
        "scale": scale_info,
        "up_source": up_source,
        "converging": bool(converging),
        "axis_conditioning": round(float(cond), 4),
        "median_camera_distance_sfm": D,
        "median_camera_distance": round(D * s_model, 5),
        "min_camera_distance": round(float(cam_dist.min()) * s_model, 5),
        "object_radius_estimate": round(r_obj, 5),
        "ground": ground_model,
        "coverage": coverage,
        "ar_alignment": {"segments": ar["segments"]} if ar else None,
        "focal": focal,
        "warnings": warnings,
    }


def cameras_in_model(model: dict, scene: dict) -> list[dict]:
    """Registered cameras in the model frame. Orientation is exported as a camera-to-model
    quaternion in the GL camera convention (+X right, +Y up, −Z forward; glTF/OpenGL), for the
    upright image. Intrinsics are those of the upright working image in pixels."""
    sim: geom.Sim3 = scene["model_from_sfm"]
    out = []
    for c in model["cameras"]:
        R_mc_cv = sim.R @ c["R_wc"]
        R_mc_gl = R_mc_cv @ geom.GL_FROM_CV
        pos = sim.apply(c["center"])
        out.append({
            "id": c["id"], "name": c["name"], "index": c["index"],
            "position": np.round(pos, 6).tolist(),
            "q": np.round(geom.rot_to_quat(R_mc_gl), 7).tolist(),
            "forward": np.round(R_mc_cv[:, 2], 6).tolist(),
            "width": c["width"], "height": c["height"],
            "fx": round(c["fx"], 4), "fy": round(c["fy"], 4), "cx": round(c["cx"], 4), "cy": round(c["cy"], 4),
            "fov_y_deg": round(float(np.degrees(2 * np.arctan(c["height"] / (2 * c["fy"])))), 3),
            "sparse_points": c["num_points"],
        })
    return out


def sparse_preview(model: dict, scene: dict, cams_model: list[dict], unregistered: list[dict],
                   max_points: int = 40_000, seed: int = 1) -> dict:
    """Provisional preview: SfM tie points and camera poses in the model frame. This is NOT the
    final surface — only evidence that the photos register and roughly where the object is."""
    sim: geom.Sim3 = scene["model_from_sfm"]
    xyz = sim.apply(model["xyz"])
    rgb = model["rgb"]
    # keep the neighbourhood of the object; far background points only clutter the preview
    r = np.linalg.norm(xyz, axis=1)
    limit = 3.0 * max(scene["median_camera_distance"], 1e-9)
    keep = np.flatnonzero((r < limit) & np.isfinite(xyz).all(1))
    if len(keep) > max_points:
        rng = np.random.default_rng(seed)
        keep = np.sort(rng.choice(keep, max_points, replace=False))
    p = xyz[keep].astype("<f4")
    c = rgb[keep].astype(np.uint8)
    return {
        "format": 1, "provisional": True, "kind": "sparse_sfm",
        "note": "Provisional sparse preview from structure-from-motion on the companion: tie points and "
                "camera positions only. The final surface is produced by the dense stages.",
        "frame": "model", "units": scene["scale"]["units"],
        "points": {"count": int(len(p)), "total_in_model": int(len(xyz)),
                   "xyz_f32_b64": base64.b64encode(p.tobytes()).decode(),
                   "rgb_u8_b64": base64.b64encode(c.tobytes()).decode()},
        "cameras": cams_model, "unregistered": unregistered,
        "object": {"center": [0.0, 0.0, 0.0], "radius_estimate": scene["object_radius_estimate"]},
        "ground": scene["ground"],
        "coverage": scene["coverage"],
    }
