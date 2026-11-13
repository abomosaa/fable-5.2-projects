"""Stage `package`: textured OBJ from OpenMVS → evidence-annotated GLB in the model frame."""
from __future__ import annotations

from pathlib import Path

import numpy as np

from . import geom
from .errors import PipelineError
from .glb import write_glb
from .meshpost import boundary_stats, face_areas


def parse_obj(path: Path) -> dict:
    """Parse the OBJ written by OpenMVS TextureMesh: welded `v`, per-corner `vt`, faces `f v/vt`,
    material groups (`usemtl`) and the MTL's `map_Kd` textures."""
    v, vt = [], []
    faces_v, faces_t, face_mat = [], [], []
    mats: list[str] = []
    cur = -1
    mtl = None
    with open(path, "rb") as fh:
        for raw in fh:
            if raw.startswith(b"v "):
                v.append(raw[2:])
            elif raw.startswith(b"vt "):
                vt.append(raw[3:])
            elif raw.startswith(b"f "):
                parts = raw.split()
                if len(parts) != 4:
                    raise PipelineError("texture_failed", "Unexpected non-triangular face in textured mesh.")
                a, b, c = (p.split(b"/") for p in parts[1:])
                faces_v.append((int(a[0]), int(b[0]), int(c[0])))
                faces_t.append((int(a[1]), int(b[1]), int(c[1])) if len(a) > 1 and a[1] else (0, 0, 0))
                face_mat.append(cur)
            elif raw.startswith(b"usemtl "):
                name = raw[7:].strip().decode()
                if name not in mats:
                    mats.append(name)
                cur = mats.index(name)
            elif raw.startswith(b"mtllib "):
                mtl = raw[7:].strip().decode()
    V = np.array(b" ".join(v).split(), dtype=np.float64).reshape(-1, 3) if v else np.zeros((0, 3))
    VT = np.array(b" ".join(vt).split(), dtype=np.float64).reshape(-1, 2) if vt else np.zeros((0, 2))
    Fv = np.array(faces_v, dtype=np.int64).reshape(-1, 3) - 1
    Ft = np.array(faces_t, dtype=np.int64).reshape(-1, 3) - 1
    textures: dict[str, Path] = {}
    if mtl:
        mpath = path.parent / mtl
        if mpath.exists():
            name = None
            for line in mpath.read_text().splitlines():
                line = line.strip()
                if line.startswith("newmtl "):
                    name = line[7:].strip()
                elif line.startswith("map_Kd ") and name:
                    textures[name] = path.parent / line[7:].strip()
    return {"V": V, "VT": VT, "Fv": Fv, "Ft": Ft, "face_mat": np.array(face_mat, dtype=np.int64),
            "materials": mats, "textures": textures}


def vertex_normals(V: np.ndarray, F: np.ndarray) -> np.ndarray:
    a, b, c = V[F[:, 0]], V[F[:, 1]], V[F[:, 2]]
    fn = np.cross(b - a, c - a)  # area-weighted
    N = np.zeros_like(V)
    for k in range(3):
        np.add.at(N, F[:, k], fn)
    ln = np.linalg.norm(N, axis=1, keepdims=True)
    N = np.where(ln > 1e-20, N / np.maximum(ln, 1e-20), np.array([0.0, 1.0, 0.0]))
    return N


def view_support(V: np.ndarray, N: np.ndarray, F: np.ndarray, cams: list[dict], eps: float) -> np.ndarray:
    """Number of registered cameras with an unoccluded, non-grazing view of each vertex
    (ray casting against the mesh itself)."""
    import open3d as o3d
    scene = o3d.t.geometry.RaycastingScene()
    scene.add_triangles(o3d.core.Tensor(V.astype(np.float32)), o3d.core.Tensor(F.astype(np.uint32)))
    counts = np.zeros(len(V), dtype=np.int32)
    cos_max = np.cos(np.radians(80.0))
    for c in cams:
        pos = np.array(c["position"], dtype=float)
        R_mc_gl = geom.quat_to_rot(np.array(c["q"]))
        R_mc_cv = R_mc_gl @ geom.GL_FROM_CV
        d = V - pos
        dist = np.linalg.norm(d, axis=1)
        dirs = d / np.maximum(dist[:, None], 1e-12)
        pc = d @ R_mc_cv  # camera coordinates (CV)
        z = pc[:, 2]
        with np.errstate(divide="ignore", invalid="ignore"):
            u = c["fx"] * pc[:, 0] / z + c["cx"]
            v = c["fy"] * pc[:, 1] / z + c["cy"]
        facing = -(N * dirs).sum(1) > cos_max
        infr = (z > 1e-9) & (u >= 0) & (u < c["width"]) & (v >= 0) & (v < c["height"]) & facing
        idx = np.flatnonzero(infr)
        if len(idx) == 0:
            continue
        rays = np.concatenate([np.broadcast_to(pos, (len(idx), 3)), dirs[idx]], axis=1).astype(np.float32)
        t_hit = scene.cast_rays(o3d.core.Tensor(rays))["t_hit"].numpy()
        vis = t_hit >= dist[idx] - eps
        counts[idx[vis]] += 1
    return counts


def surface_direction_coverage(V, F, conf_face, mask) -> dict:
    """Area of supported surface by outward-normal direction (12 azimuth bins x 3 bands). This is
    coverage verified by reconstructed evidence, unlike the capture-time viewpoint estimate."""
    Fm = F[mask]
    if len(Fm) == 0:
        return {"azimuth_bins": geom.AZIMUTH_BINS, "supported_area": [], "weak_area": []}
    a, b, c = V[Fm[:, 0]], V[Fm[:, 1]], V[Fm[:, 2]]
    fn = np.cross(b - a, c - a)
    area = 0.5 * np.linalg.norm(fn, axis=1)
    n = fn / np.maximum(2 * area[:, None], 1e-30)
    az = (np.degrees(np.arctan2(n[:, 2], n[:, 0])) + 360.0) % 360.0
    el = np.degrees(np.arcsin(np.clip(n[:, 1], -1, 1)))
    band = np.digitize(el, [-30.0, 45.0])  # 0 = facing down, 1 = sideways, 2 = facing up
    ab = (az // (360 / geom.AZIMUTH_BINS)).astype(int) % geom.AZIMUTH_BINS
    sup = np.zeros((3, geom.AZIMUTH_BINS))
    weak = np.zeros((3, geom.AZIMUTH_BINS))
    cf = conf_face[mask]
    np.add.at(sup, (band, ab), area * (cf >= 0.5))
    np.add.at(weak, (band, ab), area * (cf < 0.5))
    total = float(area.sum())
    side = sup[1]
    thresh = 0.25 * (side.sum() / geom.AZIMUTH_BINS) if side.sum() > 0 else 0.0
    return {"azimuth_bins": geom.AZIMUTH_BINS, "bands": ["facing_down", "sideways", "facing_up"],
            "supported_area_fraction": (sup / max(total, 1e-30)).round(5).tolist(),
            "weak_area_fraction": (weak / max(total, 1e-30)).round(5).tolist(),
            "sideways_bins_supported": int((side > thresh).sum()) if thresh > 0 else 0}


def build_package(work: Path, out: Path, obj_path: Path, scene: dict, post: dict, model: dict,
                  cams_model: list[dict], settings: dict, meta: dict, progress) -> dict:
    from scipy.spatial import cKDTree

    sim: geom.Sim3 = post["model_from_sfm"]
    progress(0.05, "Reading textured mesh")
    obj = parse_obj(obj_path)
    if len(obj["Fv"]) == 0:
        raise PipelineError("texture_failed", "Textured mesh is empty.")
    Vw = sim.apply(obj["V"])            # welded vertices, model frame
    Fw = obj["Fv"]
    Nw = vertex_normals(Vw, Fw)

    # Orientation consistency: front faces must look towards the cameras that observed them.
    cam_pos = np.array([c["position"] for c in cams_model])
    fc = Vw[Fw].mean(1)
    fn = np.cross(Vw[Fw[:, 1]] - Vw[Fw[:, 0]], Vw[Fw[:, 2]] - Vw[Fw[:, 0]])
    sample = np.arange(len(Fw)) if len(Fw) <= 20000 else np.random.default_rng(1).choice(len(Fw), 20000, replace=False)
    tree_c = cKDTree(cam_pos)
    _, nearest = tree_c.query(fc[sample], k=1)
    toward = ((cam_pos[nearest] - fc[sample]) * fn[sample]).sum(1) > 0
    flipped = False
    if toward.mean() < 0.5:
        Fw = Fw[:, [0, 2, 1]]
        obj["Ft"] = obj["Ft"][:, [0, 2, 1]]
        Nw = -Nw
        flipped = True
    progress(0.2, "Measuring photographic support")

    # ---- confidence per welded vertex ----------------------------------------------------------
    h = float(post["dense_spacing"])
    dense = sim.apply(np.load(work / "dense_roi_sfm.npy").astype(np.float64))
    tree = cKDTree(dense)
    dv, _ = tree.query(Vw, k=1, workers=-1)
    s_dense = np.clip(1.0 - (dv - h) / (3.0 * h), 0.0, 1.0)
    eps = max(4.0 * h, 1e-4 * float(scene["median_camera_distance"]))
    views = view_support(Vw, Nw, Fw, cams_model, eps)
    s_view = np.clip(views / 3.0, 0.0, 1.0)
    conf_w = (s_dense * s_view).astype(np.float32)
    progress(0.6, "Writing model")

    # ---- render vertices (split at UV seams) ---------------------------------------------------
    has_uv = len(obj["VT"]) > 0 and (obj["Ft"] >= 0).all()
    if has_uv:
        # OpenMVS writes one `vt` per face corner. Corners of the same vertex that carry the same
        # texture coordinate *in the same atlas page* are merged into one render vertex; the
        # remaining duplicates are genuine UV seams.
        corner_v = Fw.reshape(-1)
        corner_uv = obj["VT"][obj["Ft"].reshape(-1)]
        q = np.clip(np.rint(corner_uv * (1 << 20)), 0, (1 << 20) - 1).astype(np.int64)
        page = np.repeat(np.maximum(obj["face_mat"], 0), 3)
        key = np.stack([corner_v, page, q[:, 0], q[:, 1]], axis=1)
        _, first, inv = np.unique(key, axis=0, return_index=True, return_inverse=True)
        vi = corner_v[first]
        positions = Vw[vi]
        normals = Nw[vi]
        uv_first = corner_uv[first]
        uvs = np.stack([uv_first[:, 0], 1.0 - uv_first[:, 1]], axis=1)  # OBJ v is bottom-up
        conf = conf_w[vi]
        faces = inv.reshape(-1, 3)
    else:
        positions, normals, uvs, conf, faces = Vw, Nw, None, conf_w, Fw
    primitives = []
    texture_info = []
    fmt = settings["texture_format"]
    for mi, name in enumerate(obj["materials"] or ["material_0"]):
        sel = obj["face_mat"] == mi if len(obj["materials"]) else np.ones(len(faces), bool)
        if not sel.any():
            continue
        img_bytes, mime = None, None
        tpath = obj["textures"].get(name)
        if tpath and tpath.exists():
            from PIL import Image
            with Image.open(tpath) as im:
                w, hgt = im.size
                src_fmt = (im.format or "").upper()
                if (fmt == "jpeg" and src_fmt == "JPEG") or (fmt == "png" and src_fmt == "PNG"):
                    img_bytes = tpath.read_bytes()   # keep OpenMVS' encoded atlas untouched
                else:
                    import io
                    buf = io.BytesIO()
                    if fmt == "png":
                        im.convert("RGB").save(buf, "PNG", optimize=False)
                    else:
                        im.convert("RGB").save(buf, "JPEG", quality=95, subsampling=0)
                    img_bytes = buf.getvalue()
            mime = "image/png" if fmt == "png" else "image/jpeg"
            texture_info.append({"width": w, "height": hgt, "bytes": len(img_bytes), "format": fmt})
        primitives.append({"indices": faces[sel], "image": img_bytes, "mime": mime, "name": f"scan_{mi}"})

    # ---- statistics ----------------------------------------------------------------------------
    areas = face_areas(Vw, Fw)
    conf_face = conf_w[Fw].mean(1)
    total_area = float(areas.sum())
    crop = post["suggested_crop"]
    c0, he = np.array(crop["center"]), np.array(crop["half_extents"])
    fcw = Vw[Fw].mean(1)
    in_obj = (np.abs(fcw - c0) <= he).all(1)
    obj_area = float(areas[in_obj].sum())

    def frac(mask, denom):
        return round(float(areas[mask].sum() / max(denom, 1e-30)), 4)

    b_all = boundary_stats(Fw, Vw)
    b_obj = boundary_stats(Fw[in_obj], Vw, whole=Fw)     # holes only, not the cut around the region
    lo, hi = Vw.min(0), Vw.max(0)
    mesh_stats = {
        "vertices": int(len(positions)), "welded_vertices": int(len(Vw)), "faces": int(len(faces)),
        "surface_area": round(total_area, 6),
        "bbox_min": np.round(lo, 6).tolist(), "bbox_max": np.round(hi, 6).tolist(),
        "boundary": b_all, "winding_flipped_for_consistency": flipped,
        "object_region": {
            "faces": int(in_obj.sum()), "surface_area": round(obj_area, 6),
            "well_supported_area_fraction": frac(in_obj & (conf_face >= 0.5), obj_area),
            "weak_area_fraction": frac(in_obj & (conf_face < 0.5) & (conf_face >= 0.15), obj_area),
            "unsupported_area_fraction": frac(in_obj & (conf_face < 0.15), obj_area),
            "boundary": b_obj,
            "size": np.round(2 * he, 6).tolist(),
        },
        "views_per_vertex_median": float(np.median(views)),
        "untextured_area_fraction": frac(views[Fw].max(1) == 0, total_area),
    }
    surface_cov = surface_direction_coverage(Vw, Fw, conf_face, in_obj)
    surface_cov["kind"] = "verified_surface"
    surface_cov["note"] = ("Share of the object-region surface area with photographic support, by the "
                           "direction the surface faces. Derived from the reconstructed mesh and its evidence.")

    extras = {"pocket3d": {
        "format": 1, **meta,
        "frame": {"up": "+Y", "handedness": "right", "front_faces": "ccw",
                  "origin": "estimated object centre (point the cameras converge on)",
                  "model_from_sfm": sim.to_json(), "up_source": "support_plane" if post["relevelled"] else scene["up_source"]},
        "scale": scene["scale"],
        "suggested_crop": crop,
        "ground": post["ground"],
        "confidence": {"attribute": "_CONFIDENCE",
                       "definition": "min-free product of dense-stereo support (distance to nearest fused "
                                     "depth point vs. point spacing) and view support (unoccluded registered "
                                     "cameras / 3, capped at 1). 0 = no photographic evidence."},
        "holes_preserved": True,
    }}
    glb_path = out / "model.glb"
    write_glb(glb_path, positions, normals, uvs, conf, primitives, extras)
    progress(0.95, "Model written")
    return {"mesh": mesh_stats, "texture": {"pages": texture_info}, "surface_coverage": surface_cov,
            "glb": str(glb_path)}
