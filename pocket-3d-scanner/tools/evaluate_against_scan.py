#!/usr/bin/env python3
"""Compare a reconstruction with a reference 3D scan (NAVI-style annotations).

    tools/.venv/bin/python tools/evaluate_against_scan.py \
        --job results/groundtruth_standard --dataset datasets/groundtruth \
        --out results/_evaluation/groundtruth_standard_vs_scan.json

Alignment and scale procedure (documented, no hidden tuning)
------------------------------------------------------------
1. Camera-based similarity: the reconstructed camera centres (cameras.json, model frame) are
   aligned to the ground-truth camera centres C = −R(q)ᵀ t of the same photographs (scan frame,
   millimetres) with a least-squares similarity transform (Umeyama; rotation, translation and
   ONE scale factor). This fixes scale without ever looking at the reconstructed surface.
2. The reconstructed mesh is transformed with that similarity and cropped to the scan's
   bounding box grown by `--margin-mm` (the scan contains only the object, not its support).
3. Reported three times: (a) with the camera-based alignment only, and (b) after a rigid ICP refinement
   (rotation + translation only, scale stays the camera-derived one) which removes the
   residual pose error caused by the dataset's nominal (EXIF) intrinsics.
4. Accuracy   = distance from points sampled on the reconstruction to the scan surface.
   Completeness = distance from points sampled on the scan to the reconstruction; a scan point
   counts as covered if a reconstructed surface lies within `--tau-mm`.
5. "The object" on the reconstruction is defined in two ways and both are reported:
   (i) by the dataset's ground-truth silhouettes (vertices that project inside the object mask
   in >= 90 % of the photos that see them) — independent of the distance to the scan, so it
   cannot hide errors; (ii) surface within `--object-mm` of the scan (default 5 mm), which by
   construction excludes gross errors and is reported with the discarded area share.
   Dimension checks use (i) when masks exist.
   (c) additionally after a similarity ICP (one extra scale factor): the "shape-only" error,
   i.e. what remains once the model is scaled by a known distance instead of by the cameras.
6. "User calibration" simulation: scale derived from ONE known dimension (the scan's longest
   extent), as the app's reference-distance calibration does, then the other two extents are
   compared — this is what a user with a ruler can expect.

Reprojection error is not used anywhere here.
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import numpy as np
import open3d as o3d
import trimesh


def quat_wxyz_to_R(q):
    w, x, y, z = np.asarray(q, dtype=float) / np.linalg.norm(q)
    return np.array([
        [1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w)],
        [2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w)],
        [2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)]])


def umeyama(src, dst):
    mu_s, mu_d = src.mean(0), dst.mean(0)
    xs, xd = src - mu_s, dst - mu_d
    U, D, Vt = np.linalg.svd(xd.T @ xs / len(src))
    S = np.eye(3)
    if np.linalg.det(U) * np.linalg.det(Vt) < 0:
        S[2, 2] = -1
    R = U @ S @ Vt
    s = np.trace(np.diag(D) @ S) / ((xs ** 2).sum() / len(src))
    return float(s), R, mu_d - s * R @ mu_s


def load_glb_mesh(path):
    scene = trimesh.load(str(path), force="scene", process=False)
    Vs, Fs, off = [], [], 0
    for name, g in scene.geometry.items():
        T = scene.graph.get(scene.graph.geometry_nodes[name][0])[0]
        V = trimesh.transformations.transform_points(g.vertices, T)
        Vs.append(V); Fs.append(np.asarray(g.faces) + off); off += len(V)
    return np.concatenate(Vs), np.concatenate(Fs)


def sample(V, F, n, rng):
    a, b, c = V[F[:, 0]], V[F[:, 1]], V[F[:, 2]]
    area = 0.5 * np.linalg.norm(np.cross(b - a, c - a), axis=1)
    fi = rng.choice(len(F), n, p=area / area.sum())
    r1, r2 = np.sqrt(rng.random(n)), rng.random(n)
    return a[fi] * (1 - r1)[:, None] + b[fi] * (r1 * (1 - r2))[:, None] + c[fi] * (r1 * r2)[:, None], float(area.sum())


def ray_scene(V, F):
    s = o3d.t.geometry.RaycastingScene()
    s.add_triangles(o3d.core.Tensor(V.astype(np.float32)), o3d.core.Tensor(F.astype(np.uint32)))
    return s


def dist(scene, P):
    return scene.compute_distance(o3d.core.Tensor(P.astype(np.float32))).numpy().astype(float)


class MaskViews:
    """The dataset's ground-truth silhouettes (object masks rendered from the scan in every
    photo's ground-truth camera). Used to define "the object" on the reconstruction WITHOUT
    using its distance to the scan: a vertex belongs to the object if it projects inside the
    silhouette in at least 90 % of the views that have it in frame (min. 5 views)."""

    def __init__(self, dataset: Path, ann: dict, max_views: int = 50, down: int = 4):
        from PIL import Image
        Image.MAX_IMAGE_PIXELS = None
        self.views = []
        mdir = dataset / "reference" / "masks"
        for name, g in sorted(ann.items())[:max_views]:
            mp = mdir / (Path(name).stem + ".png")
            if not mp.exists():
                continue
            h, w = g["image_size"]
            with Image.open(mp) as im:
                m = np.asarray(im.convert("L").resize((w // down, h // down), Image.NEAREST)) > 0
            self.views.append((quat_wxyz_to_R(g["camera"]["q"]), np.array(g["camera"]["t"], dtype=float),
                               float(g["camera"]["focal_length"]), w, h, m, down))

    def object_vertices(self, V: np.ndarray) -> np.ndarray:
        inside = np.zeros(len(V)); seen = np.zeros(len(V))
        for R, t, f, w, h, m, down in self.views:
            pc = V @ R.T + t
            z = pc[:, 2]
            with np.errstate(divide="ignore", invalid="ignore"):
                u = f * pc[:, 0] / z + w / 2
                v = f * pc[:, 1] / z + h / 2
            ok = (z > 1e-6) & (u >= 0) & (u < w) & (v >= 0) & (v < h)
            ui = np.clip((u[ok] / down).astype(int), 0, m.shape[1] - 1)
            vi = np.clip((v[ok] / down).astype(int), 0, m.shape[0] - 1)
            seen[ok] += 1
            inside[np.flatnonzero(ok)] += m[vi, ui]
        return (seen >= 5) & (inside >= 0.9 * np.maximum(seen, 1))


def stats(d, tau):
    return {"mean": round(float(d.mean()), 3), "median": round(float(np.median(d)), 3),
            "rms": round(float(np.sqrt((d ** 2).mean())), 3), "p90": round(float(np.percentile(d, 90)), 3),
            "p95": round(float(np.percentile(d, 95)), 3), "max": round(float(d.max()), 3),
            f"within_{tau:g}mm": round(float((d <= tau).mean()), 4),
            "within_1mm": round(float((d <= 1.0).mean()), 4)}


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--job", required=True, type=Path, help="job directory (out/model.glb, out/cameras.json) or a results/<run> directory")
    ap.add_argument("--dataset", required=True, type=Path)
    ap.add_argument("--out", type=Path)
    ap.add_argument("--margin-mm", type=float, default=6.0)
    ap.add_argument("--tau-mm", type=float, default=2.0)
    ap.add_argument("--object-mm", type=float, default=5.0,
                    help="surface farther than this from the scan is treated as support/gross error for the "
                         "object-attributed numbers and the dimension check")
    ap.add_argument("--samples", type=int, default=200_000)
    a = ap.parse_args()
    rng = np.random.default_rng(1)

    out_dir = a.job / "out" if (a.job / "out" / "model.glb").exists() else a.job   # job dir or results/<run>
    cams = json.loads((out_dir / "cameras.json").read_text())["cameras"]
    ann = {x["filename"]: x for x in json.loads((a.dataset / "reference" / "annotations.json").read_text())}
    src, dst, names = [], [], []
    for c in cams:
        g = ann.get(c["name"])
        if g is None:
            continue
        R = quat_wxyz_to_R(g["camera"]["q"])
        dst.append(-R.T @ np.array(g["camera"]["t"], dtype=float))
        src.append(c["position"]); names.append(c["name"])
    src, dst = np.array(src), np.array(dst)
    if len(src) < 4:
        print("not enough registered cameras with ground truth", file=sys.stderr)
        return 2
    s, R, t = umeyama(src, dst)
    res = np.linalg.norm((s * src @ R.T + t) - dst, axis=1)
    cam_extent = float(np.sqrt(((dst - dst.mean(0)) ** 2).sum(1).mean()))

    masks = MaskViews(a.dataset, ann) if (a.dataset / "reference" / "masks").is_dir() else None
    scan_objs = list((a.dataset / "reference" / "3d_scan").glob("*.obj"))
    scan = trimesh.load(str(scan_objs[0]), force="mesh", process=False)
    SV, SF = np.asarray(scan.vertices, dtype=float), np.asarray(scan.faces)
    lo, hi = SV.min(0), SV.max(0)
    V, F = load_glb_mesh(out_dir / "model.glb")
    Vs = s * V @ R.T + t
    fc = Vs[F].mean(1)
    keep = ((fc >= lo - a.margin_mm) & (fc <= hi + a.margin_mm)).all(1)
    Fk = F[keep]
    if len(Fk) < 100:
        print("no reconstructed surface inside the scan bounding box", file=sys.stderr)
        return 2
    scan_scene = ray_scene(SV, SF)
    P_rec, area_rec = sample(Vs, Fk, a.samples, rng)
    P_scan, area_scan = sample(SV, SF, a.samples, rng)

    def evaluate(Vx):
        Pr, _ = sample(Vx, Fk, a.samples, np.random.default_rng(2))
        rec_scene = ray_scene(Vx, Fk)
        d_acc = dist(scan_scene, Pr)
        d_comp = dist(rec_scene, P_scan)
        # "Object-attributed" surface: reconstructed faces whose three vertices lie within
        # --object-mm of the scan. This removes the support/stand that falls inside the scan's
        # bounding box, and (by construction) also any gross error larger than the threshold —
        # the discarded share is reported so it cannot hide.
        dv = np.full(len(Vx), np.inf)
        used = np.unique(Fk.reshape(-1))
        dv[used] = dist(scan_scene, Vx[used])
        obj = (dv[Fk] <= a.object_mm).all(1)
        ar = 0.5 * np.linalg.norm(np.cross(Vx[Fk[:, 1]] - Vx[Fk[:, 0]], Vx[Fk[:, 2]] - Vx[Fk[:, 0]]), axis=1)
        vo = np.unique(Fk[obj].reshape(-1)) if obj.any() else used
        ext = Vx[vo].max(0) - Vx[vo].min(0)
        by_masks = None
        if masks is not None and masks.views:
            vm = np.zeros(len(Vx), bool)
            vm[used] = masks.object_vertices(Vx[used])
            fm = vm[Fk].all(1)
            if fm.sum() >= 100:
                Pm, _ = sample(Vx, Fk[fm], a.samples, np.random.default_rng(3))
                dm = dist(scan_scene, Pm)
                vmo = np.unique(Fk[fm].reshape(-1))
                by_masks = {"accuracy_mm": stats(dm, a.tau_mm),
                            "area_fraction_of_surface_in_scan_box": round(float(ar[fm].sum() / ar.sum()), 4),
                            "extent_mm": np.round(Vx[vmo].max(0) - Vx[vmo].min(0), 2).tolist()}
        return {"accuracy_mm": stats(d_acc, a.tau_mm),
                "object_by_silhouettes": by_masks,
                "accuracy_object_attributed_mm": stats(d_acc[d_acc <= a.object_mm], a.tau_mm) if (d_acc <= a.object_mm).any() else None,
                "area_fraction_farther_than_object_threshold": round(float(ar[~obj].sum() / ar.sum()), 4),
                "completeness_mm": stats(d_comp, a.tau_mm),
                "extent_mm": np.round(ext, 2).tolist()}

    before = evaluate(Vs)
    # rigid ICP (no scale) of reconstruction samples onto scan samples
    pc_r = o3d.geometry.PointCloud(o3d.utility.Vector3dVector(P_rec))
    pc_s = o3d.geometry.PointCloud(o3d.utility.Vector3dVector(P_scan))
    pc_s.estimate_normals(o3d.geometry.KDTreeSearchParamHybrid(radius=3.0, max_nn=30))
    reg = o3d.pipelines.registration.registration_icp(
        pc_r, pc_s, 4.0, np.eye(4), o3d.pipelines.registration.TransformationEstimationPointToPlane(),
        o3d.pipelines.registration.ICPConvergenceCriteria(max_iteration=60))
    T = np.asarray(reg.transformation)
    Vi = Vs @ T[:3, :3].T + T[:3, 3]
    after = evaluate(Vi)
    # Shape-only comparison: ICP that may also change ONE scale factor (point-to-point with
    # scaling, started from the rigid result). This is what a user gets after calibrating the
    # model with a known distance: it separates "the shape is wrong" from "the camera-derived
    # scale is wrong" (focal length and camera distance trade off for small, distant objects,
    # and the dataset's own camera positions were computed with a nominal focal length).
    pc_i = o3d.geometry.PointCloud(o3d.utility.Vector3dVector(P_rec @ T[:3, :3].T + T[:3, 3]))
    T2 = np.eye(4)
    for radius in (6.0, 3.0, 1.5):
        reg2 = o3d.pipelines.registration.registration_icp(
            pc_i, pc_s, radius, T2, o3d.pipelines.registration.TransformationEstimationPointToPoint(with_scaling=True),
            o3d.pipelines.registration.ICPConvergenceCriteria(max_iteration=80))
        T2 = np.asarray(reg2.transformation)
    scale_fix = float(np.cbrt(np.linalg.det(T2[:3, :3])))
    Vsim = Vi @ T2[:3, :3].T + T2[:3, 3]
    shape_only = evaluate(Vsim)
    icp_shift = float(np.linalg.norm(T[:3, 3]))
    icp_angle = float(np.degrees(np.arccos(np.clip((np.trace(T[:3, :3]) - 1) / 2, -1, 1))))

    scan_ext = hi - lo
    # dimensions: prefer the silhouette-defined object (independent of the distance to the scan)
    ext_basis = "silhouette-defined object" if after.get("object_by_silhouettes") else "surface within --object-mm of the scan"
    ext = np.array(after["object_by_silhouettes"]["extent_mm"] if after.get("object_by_silhouettes") else after["extent_mm"])
    order = np.argsort(-scan_ext)
    # user-style calibration: one known dimension (longest) fixes the scale
    k = scan_ext[order[0]] / ext[order[0]]
    user = {"basis": ext_basis, "reference_axis_mm": round(float(scan_ext[order[0]]), 2),
            "scale_correction_vs_camera_alignment": round(float(k), 5),
            "other_dimensions": [{"scan_mm": round(float(scan_ext[i]), 2), "reconstruction_mm": round(float(ext[i] * k), 2),
                                  "error_mm": round(float(ext[i] * k - scan_ext[i]), 2),
                                  "error_percent": round(float(100 * (ext[i] * k - scan_ext[i]) / scan_ext[i]), 2)}
                                 for i in order[1:]]}
    out = {
        "dataset": str(a.dataset), "job": str(a.job),
        "procedure": "Umeyama similarity on camera centres (scale from ground-truth camera poses), crop to scan "
                     f"bbox + {a.margin_mm:g} mm, then rigid ICP (no scale) for the refined numbers.",
        "cameras_used": len(src),
        "camera_alignment": {"scale_mm_per_model_unit": round(s, 5), "residual_rms_mm": round(float(np.sqrt((res ** 2).mean())), 3),
                             "residual_max_mm": round(float(res.max()), 3), "camera_spread_rms_mm": round(cam_extent, 1)},
        "faces_inside_scan_box": int(len(Fk)), "faces_total": int(len(F)),
        "area_ratio_reconstruction_over_scan": round(area_rec / area_scan, 4),
        "camera_alignment_only": before,
        "after_rigid_icp": after,
        "shape_only_after_similarity_icp": shape_only,
        "similarity_icp_scale_correction": round(scale_fix, 5),
        "icp": {"translation_mm": round(icp_shift, 3), "rotation_deg": round(icp_angle, 3), "fitness": round(float(reg.fitness), 4)},
        "scan_extent_mm": np.round(scan_ext, 2).tolist(),
        "extent_basis": ext_basis,
        "extent_mm_after_icp": np.round(ext, 2).tolist(),
        "extent_error_mm_after_icp": np.round(ext - scan_ext, 2).tolist(),
        "single_reference_calibration": user,
        "notes": ["Completeness includes the object's underside/contact area, which no photo sees; it is "
                  "expected to stay uncovered.",
                  "Scan-box cropping keeps any support surface within the margin; this slightly raises the "
                  "accuracy tail (p95/max)."],
    }
    txt = json.dumps(out, indent=1)
    print(txt)
    if a.out:
        a.out.parent.mkdir(parents=True, exist_ok=True)
        a.out.write_text(txt + "\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
