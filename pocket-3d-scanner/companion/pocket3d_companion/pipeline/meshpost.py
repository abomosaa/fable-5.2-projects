"""Evidence-preserving mesh clean-up between surface reconstruction and texturing.

* finds the support plane (table/floor) in the dense points and levels the model frame to it;
* separates the object from its surroundings geometrically (no learned segmentation, no
  invented silhouette) and derives a *suggested* crop box — delivered as editable metadata;
* keeps a generous region around the object so that the boundary stays editable on the phone;
* removes faces that have no dense-stereo support nearby (surface the Delaunay graph-cut
  spanned across unobserved space) — these become visible holes;
* removes tiny floating components and decimates to the preset's triangle budget.

Nothing here fills holes or synthesises surface.
"""
from __future__ import annotations

import struct
from pathlib import Path

import numpy as np

from . import geom
from .errors import PipelineError


def write_ply_mesh(path: Path, vertices: np.ndarray, faces: np.ndarray) -> None:
    """Binary little-endian PLY (float32 vertices, int32 faces) as read by OpenMVS."""
    v = np.ascontiguousarray(vertices, dtype="<f4")
    f = np.ascontiguousarray(faces, dtype="<i4")
    header = ("ply\nformat binary_little_endian 1.0\n"
              f"element vertex {len(v)}\nproperty float x\nproperty float y\nproperty float z\n"
              f"element face {len(f)}\nproperty list uchar int vertex_indices\nend_header\n").encode()
    rec = np.empty(len(f), dtype=[("n", "u1"), ("i", "<i4", 3)])
    rec["n"] = 3
    rec["i"] = f
    with open(path, "wb") as fh:
        fh.write(header)
        fh.write(v.tobytes())
        fh.write(rec.tobytes())


def face_areas(V: np.ndarray, F: np.ndarray) -> np.ndarray:
    a, b, c = V[F[:, 0]], V[F[:, 1]], V[F[:, 2]]
    return 0.5 * np.linalg.norm(np.cross(b - a, c - a), axis=1)


def face_components(F: np.ndarray, n_vertices: int) -> np.ndarray:
    """Connected-component label per face (faces sharing a vertex are connected)."""
    from scipy.sparse import coo_matrix
    from scipy.sparse.csgraph import connected_components
    if len(F) == 0:
        return np.zeros(0, dtype=int)
    rows = np.concatenate([F[:, 0], F[:, 1]])
    cols = np.concatenate([F[:, 1], F[:, 2]])
    g = coo_matrix((np.ones(len(rows), dtype=np.int8), (rows, cols)), shape=(n_vertices, n_vertices))
    _, vlabel = connected_components(g, directed=False)
    return vlabel[F[:, 0]]


def compact(V: np.ndarray, F: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    used = np.zeros(len(V), dtype=bool)
    used[F.reshape(-1)] = True
    remap = np.cumsum(used) - 1
    return V[used], remap[F]


def split_nonmanifold_vertices(V: np.ndarray, F: np.ndarray) -> tuple[np.ndarray, np.ndarray, int]:
    """Make the mesh vertex-manifold without changing its shape: a vertex whose incident faces
    form several fans that are not connected through shared (two-face) edges is duplicated, one
    copy per fan. Cropping and decimation create such 'bow-tie' vertices, and OpenMVS' texture
    seam levelling requires a vertex-manifold mesh. Returns (V, F, number of added vertices)."""
    from scipy.sparse import coo_matrix
    from scipy.sparse.csgraph import connected_components
    nf = len(F)
    if nf == 0:
        return V, F, 0
    # half-edges: face f, local corners (i, j) for edge between F[f, i] and F[f, j]
    fi = np.repeat(np.arange(nf), 3)
    li = np.tile(np.array([0, 1, 2]), nf)
    lj = np.tile(np.array([1, 2, 0]), nf)
    a, b = F[fi, li], F[fi, lj]
    lo, hi = np.minimum(a, b), np.maximum(a, b)
    key = lo.astype(np.int64) * (int(F.max()) + 1) + hi
    order = np.argsort(key, kind="stable")
    ks = key[order]
    start = np.flatnonzero(np.r_[True, ks[1:] != ks[:-1]])
    count = np.diff(np.r_[start, len(ks)])
    two = start[count == 2]           # edges shared by exactly two faces
    h1, h2 = order[two], order[two + 1]
    # corner ids: 3 * face + local index. Unite the two corners at each endpoint of the edge.
    c_lo_1 = np.where(a[h1] == lo[h1], 3 * fi[h1] + li[h1], 3 * fi[h1] + lj[h1])
    c_hi_1 = np.where(a[h1] == lo[h1], 3 * fi[h1] + lj[h1], 3 * fi[h1] + li[h1])
    c_lo_2 = np.where(a[h2] == lo[h2], 3 * fi[h2] + li[h2], 3 * fi[h2] + lj[h2])
    c_hi_2 = np.where(a[h2] == lo[h2], 3 * fi[h2] + lj[h2], 3 * fi[h2] + li[h2])
    rows = np.concatenate([c_lo_1, c_hi_1])
    cols = np.concatenate([c_lo_2, c_hi_2])
    g = coo_matrix((np.ones(len(rows), dtype=np.int8), (rows, cols)), shape=(3 * nf, 3 * nf))
    _, label = connected_components(g, directed=False)
    corner_vertex = F.reshape(-1)
    # new vertex per (original vertex, fan) pair
    pair = corner_vertex.astype(np.int64) * (int(label.max()) + 1) + label
    uniq, inv = np.unique(pair, return_inverse=True)
    new_vertex_orig = (uniq // (int(label.max()) + 1)).astype(np.int64)
    V2 = V[new_vertex_orig]
    F2 = inv.reshape(-1, 3)
    return V2, F2, int(len(V2) - len(np.unique(corner_vertex)))


def _boundary_edges(F: np.ndarray, n: int) -> tuple[np.ndarray, np.ndarray]:
    e = np.concatenate([F[:, [0, 1]], F[:, [1, 2]], F[:, [2, 0]]])
    e = np.sort(e, axis=1)
    key = e[:, 0].astype(np.int64) * n + e[:, 1]
    uniq, idx, counts = np.unique(key, return_index=True, return_counts=True)
    return e[idx[counts == 1]], uniq[counts == 1]


def boundary_stats(F: np.ndarray, V: np.ndarray | None = None, whole: np.ndarray | None = None) -> dict:
    """Open boundary edges (edges used by exactly one face) and the loops they form. Each loop
    is a hole or the open rim of the scan.

    With `whole` (the faces of the complete mesh that `F` is a sub-region of) only edges that are
    open in the complete mesh are counted: edges that merely lie where the region was cut out of
    the surrounding surface are not holes."""
    if len(F) == 0:
        return {"boundary_edges": 0, "boundary_loops": 0, "boundary_length": 0.0}
    n = int(max(F.max(), whole.max() if whole is not None and len(whole) else 0)) + 1
    be, keys = _boundary_edges(F, n)
    cut = 0
    if whole is not None:
        _, whole_keys = _boundary_edges(whole, n)
        real = np.isin(keys, whole_keys)
        cut = int((~real).sum())
        be = be[real]
    if whole is not None and len(be) == 0:
        return {"boundary_edges": 0, "boundary_loops": 0, "boundary_length": 0.0, "cut_edges_excluded": cut}
    if len(be) == 0:
        return {"boundary_edges": 0, "boundary_loops": 0, "boundary_length": 0.0}
    from scipy.sparse import coo_matrix
    from scipy.sparse.csgraph import connected_components
    verts, inv = np.unique(be.reshape(-1), return_inverse=True)
    inv = inv.reshape(-1, 2)
    g = coo_matrix((np.ones(len(inv), dtype=np.int8), (inv[:, 0], inv[:, 1])), shape=(len(verts), len(verts)))
    n_loops, _ = connected_components(g, directed=False)
    length = float(np.linalg.norm(V[be[:, 0]] - V[be[:, 1]], axis=1).sum()) if V is not None else 0.0
    out = {"boundary_edges": int(len(be)), "boundary_loops": int(n_loops), "boundary_length": round(length, 5)}
    if whole is not None:
        out["cut_edges_excluded"] = cut
    return out


def crop_and_clean(work: Path, scene: dict, settings: dict, threads: int, progress) -> dict:
    import open3d as o3d
    from scipy.spatial import cKDTree

    mvs = work / "mvs"
    seed = int(settings["seed"])
    rng = np.random.default_rng(seed)
    mesh = o3d.io.read_triangle_mesh(str(mvs / "scene_mesh.ply"))
    V_sfm = np.asarray(mesh.vertices, dtype=float)
    F = np.asarray(mesh.triangles, dtype=np.int64)
    pcd = o3d.io.read_point_cloud(str(mvs / "scene_dense.ply"))
    P_sfm = np.asarray(pcd.points, dtype=float)
    if len(F) == 0 or len(P_sfm) == 0:
        raise PipelineError("mesh_failed", "Surface reconstruction produced no usable mesh.")
    progress(0.1, "Analysing dense points")

    sim: geom.Sim3 = scene["model_from_sfm"]
    Dmed = float(scene["median_camera_distance"])
    Dmin = float(scene["min_camera_distance"])
    converging = bool(scene["converging"])
    P = sim.apply(P_sfm)

    # ---- support plane from dense points ------------------------------------------------------
    horiz = np.hypot(P[:, 0], P[:, 2])
    region = (horiz < 0.9 * Dmin) & (np.abs(P[:, 1]) < 1.5 * Dmed) if converging else np.ones(len(P), bool)
    idx = np.flatnonzero(region)
    ground = None
    Y = np.array([0.0, 1.0, 0.0])
    if len(idx) >= 500:
        sub = idx if len(idx) <= 150_000 else rng.choice(idx, 150_000, replace=False)
        tight = scene["up_source"] in ("ar_gravity", "support_plane")
        fit = geom.fit_plane_ransac(P[sub], threshold=0.006 * Dmed, iterations=600, seed=seed, normal_prior=Y,
                                    max_angle_deg=12.0 if tight else 35.0)
        if fit is not None:
            n, d, mask = fit
            sd = P[sub] @ n + d
            frac = float(mask.mean())
            below = float((sd < -0.02 * Dmed).mean())
            if frac >= 0.10 and d > 0.02 * Dmed and below < 0.2:
                rms = float(np.sqrt((sd[mask] ** 2).mean()))
                ground = {"n": n, "d": float(d), "inlier_fraction": round(frac, 3), "rms": rms}
    relevelled = False
    if ground is not None and scene["up_source"] != "ar_gravity":
        # Level the model frame to the support plane (gravity is unknown without AR tracking).
        Rlev = geom.rotation_aligning(ground["n"], Y)
        sim = geom.Sim3(1.0, Rlev, np.zeros(3)).compose(sim)
        P = sim.apply(P_sfm)
        ground["n"] = Y.copy()
        relevelled = True
    V = sim.apply(V_sfm)
    progress(0.3, "Separating object from surroundings")

    fc = V[F].mean(1)
    areas = face_areas(V, F)
    if ground is not None:
        n, d = ground["n"], ground["d"]
        tau = max(0.012 * Dmed, 2.5 * ground["rms"])
        sdv = V @ n + d
        cand = (sdv[F] > tau).any(axis=1) & ((fc @ n + d) > 0.3 * tau)
    else:
        tau = 0.012 * Dmed
        cand = np.ones(len(F), bool)
    if converging:
        cand &= (np.hypot(fc[:, 0], fc[:, 2]) < 0.92 * Dmin) & (np.linalg.norm(fc, axis=1) < 1.5 * Dmed)

    obj_box = None
    if cand.sum() >= 30:
        Fc = F[cand]
        labels = face_components(Fc, len(V))
        uniq, inv = np.unique(labels, return_inverse=True)
        a_c = areas[cand]
        comp_area = np.bincount(inv, weights=a_c)
        cen = np.stack([np.bincount(inv, weights=a_c * fc[cand][:, k]) for k in range(3)], axis=1) / np.maximum(comp_area[:, None], 1e-30)
        dist_h = np.hypot(cen[:, 0], cen[:, 2])
        score = comp_area * np.exp(-(dist_h / (0.35 * Dmed)) ** 2)
        main = int(np.argmax(score))
        vm = np.unique(Fc[inv == main].reshape(-1))
        lo, hi = V[vm].min(0), V[vm].max(0)
        size = hi - lo
        lo_e, hi_e = lo - 0.15 * size, hi + 0.15 * size
        extra = (comp_area >= 0.003 * comp_area[main]) & (cen >= lo_e).all(1) & (cen <= hi_e).all(1)
        extra[main] = True
        # Separate pieces of noticeable size inside the box (a stand, clamps, a neighbouring
        # object) mean the box probably contains things that are not the object.
        foreign_fraction = float(comp_area[extra].sum() - comp_area[main]) / float(comp_area[main])
        vsel = np.unique(Fc[extra[inv]].reshape(-1))
        lo, hi = V[vsel].min(0), V[vsel].max(0)
        obj_box = (lo, hi)
    else:
        foreign_fraction = None
    if obj_box is None:
        r = float(scene["object_radius_estimate"])
        obj_box = (np.array([-r, -r, -r]), np.array([r, r, r]))
    lo, hi = obj_box
    pad = 0.04 * float(np.linalg.norm(hi - lo))
    crop_lo, crop_hi = lo - pad, hi + pad
    if ground is not None:
        ground_y_at_center = None
        n, d = ground["n"], ground["d"]
        if abs(n[1]) > 0.5:
            cx, cz = 0.5 * (lo[0] + hi[0]), 0.5 * (lo[2] + hi[2])
            ground_y_at_center = -(d + n[0] * cx + n[2] * cz) / n[1]
            # just above the support plane's own noise: do not cut into the object's contact area
            crop_lo[1] = ground_y_at_center + max(0.2 * tau, 2.0 * ground["rms"])
    # generous delivered region: the suggested box plus a margin, including a patch of the support
    m = float(settings["roi_margin"])
    size = crop_hi - crop_lo
    del_lo = crop_lo - np.array([m * size[0], 0.0, m * size[2]]) - np.array([0.0, 0.5 * m * size[1], 0.0])
    del_hi = crop_hi + m * size
    if ground is not None and ground_y_at_center is not None:
        del_lo[1] = ground_y_at_center - 3.0 * tau
    keep = (fc >= del_lo).all(1) & (fc <= del_hi).all(1)
    if keep.sum() < 30:
        raise PipelineError("mesh_failed", "No reconstructed surface was found around the object.",
                            ["Keep the object centred in every photo and walk all the way around it."])
    faces_before = int(len(F))
    F1 = F[keep]
    progress(0.5, "Checking photographic support")

    # ---- dense-support test: drop faces spanning unobserved space ------------------------------
    pin = (P >= del_lo - 0.1 * size).all(1) & (P <= del_hi + 0.1 * size).all(1)
    Pk = P[pin]
    if len(Pk) < 100:
        raise PipelineError("dense_failed", "Dense stereo found almost no surface points on the object.",
                            ["The object is probably too plain, glossy or transparent. Add texture or matte it."])
    tree = cKDTree(Pk)
    sample = Pk if len(Pk) <= 20_000 else Pk[rng.choice(len(Pk), 20_000, replace=False)]
    dd, _ = tree.query(sample, k=2, workers=threads)
    spacing = float(np.median(dd[:, 1]))
    vused = np.unique(F1.reshape(-1))
    dv = np.full(len(V), np.inf)
    dv[vused] = tree.query(V[vused], k=1, workers=threads)[0]
    factor = float(settings["unsupported_distance_factor"])
    unsupported = dv[F1].min(axis=1) > factor * spacing
    area1 = areas[keep]
    unsupported_area_fraction = float(area1[unsupported].sum() / max(area1.sum(), 1e-30))
    F2 = F1[~unsupported]
    if len(F2) < 30:
        raise PipelineError("mesh_failed", "The reconstructed surface has no dense support.")

    # ---- stray components ----------------------------------------------------------------------
    labels = face_components(F2, len(V))
    uniq, inv = np.unique(labels, return_inverse=True)
    a2 = areas[keep][~unsupported]
    comp_area = np.bincount(inv, weights=a2)
    comp_faces = np.bincount(inv)
    small = (comp_area < 0.001 * comp_area.max()) | (comp_faces < 25)
    stray = small[inv]
    F3 = F2[~stray]
    removed_components = int(small.sum())
    progress(0.7, "Simplifying to triangle budget")

    V3, F3 = compact(V, F3)
    target = int(settings["mesh_target_faces"])
    decimated = False
    if len(F3) > target:
        m3 = o3d.geometry.TriangleMesh(o3d.utility.Vector3dVector(V3), o3d.utility.Vector3iVector(F3.astype(np.int32)))
        m3 = m3.simplify_quadric_decimation(target_number_of_triangles=target, boundary_weight=4.0)
        m3.remove_degenerate_triangles()
        m3.remove_duplicated_triangles()
        m3.remove_unreferenced_vertices()
        V3 = np.asarray(m3.vertices, dtype=float)
        F3 = np.asarray(m3.triangles, dtype=np.int64)
        decimated = True
    V3, F3 = compact(V3, F3)
    V3, F3, split = split_nonmanifold_vertices(V3, F3)
    write_ply_mesh(mvs / "mesh_roi.ply", sim.inverse().apply(V3), F3)
    np.save(work / "dense_roi_sfm.npy", sim.inverse().apply(Pk).astype(np.float32))
    progress(1.0, "Mesh cleaned")

    out_ground = None
    if ground is not None:
        out_ground = {"normal": np.round(ground["n"], 6).tolist(), "d": round(ground["d"], 6),
                      "inlier_fraction": ground["inlier_fraction"], "rms": round(ground["rms"], 6),
                      "source": "dense_points", "tolerance": round(tau, 6)}
    center = 0.5 * (crop_lo + crop_hi)
    half = 0.5 * (crop_hi - crop_lo)
    return {
        "model_from_sfm": sim,
        "relevelled": relevelled,
        "ground": out_ground,
        "suggested_crop": {"center": np.round(center, 6).tolist(), "half_extents": np.round(half, 6).tolist(),
                           "rotation": [0.0, 0.0, 0.0, 1.0],
                           "basis": "largest connected surface near the camera focus, above the support plane"
                                    if ground is not None else "largest connected surface near the camera focus",
                           "uncertain": bool(ground is None or (foreign_fraction or 0.0) > 0.02),
                           "separate_pieces_area_fraction": None if foreign_fraction is None else round(foreign_fraction, 4)},
        "delivered_box": {"min": np.round(del_lo, 6).tolist(), "max": np.round(del_hi, 6).tolist()},
        "dense_spacing": spacing,
        "dense_points_in_region": int(len(Pk)),
        "stats": {"raw_faces": faces_before, "faces_in_region": int(keep.sum()),
                  "unsupported_faces_removed": int(unsupported.sum()),
                  "unsupported_area_fraction": round(unsupported_area_fraction, 4),
                  "stray_components_removed": removed_components,
                  "stray_faces_removed": int(stray.sum()),
                  "decimated": decimated, "nonmanifold_vertices_split": split, "faces": int(len(F3)), "vertices": int(len(V3))},
    }
