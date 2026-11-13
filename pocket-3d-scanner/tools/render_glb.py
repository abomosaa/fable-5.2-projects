#!/usr/bin/env python3
"""Render a GLB with an independent loader (trimesh) for visual QA.

    tools/.venv/bin/python tools/render_glb.py model.glb out.png [--mode textured|confidence|normals]
                                               [--views 4] [--size 640] [--crop]

A deliberately simple software renderer: the surface is densely sampled (area-weighted
barycentric samples), every sample is coloured from the *loaded* texture through the *loaded*
UVs, projected with a pinhole camera and z-buffered. It shares no code with the companion's
GLB writer or the phone's renderer, so a wrong UV flip, mirrored geometry or a broken material
shows up here.
"""
from __future__ import annotations

import argparse
import json
import sys

import numpy as np
import trimesh
from PIL import Image


def load(path: str) -> dict:
    scene = trimesh.load(path, force="scene", process=False)
    meshes = []
    for name, g in scene.geometry.items():
        T = scene.graph.get(scene.graph.geometry_nodes[name][0])[0] if name in scene.graph.geometry_nodes else np.eye(4)
        V = trimesh.transformations.transform_points(g.vertices, T)
        F = np.asarray(g.faces)
        uv = getattr(g.visual, "uv", None)
        img = None
        mat = getattr(g.visual, "material", None)
        if mat is not None:
            img = getattr(mat, "baseColorTexture", None) or getattr(mat, "image", None)
        conf = None
        va = getattr(g, "vertex_attributes", {}) or {}
        for k in ("_CONFIDENCE", "_confidence"):
            if k in va:
                conf = np.asarray(va[k]).reshape(-1)
        meshes.append({"V": V, "F": F, "uv": None if uv is None else np.asarray(uv), "img": img, "conf": conf})
    return {"meshes": meshes, "extras": (scene.metadata or {})}


def sample_surface(m: dict, n: int, rng, mode: str):
    V, F = m["V"], m["F"]
    a, b, c = V[F[:, 0]], V[F[:, 1]], V[F[:, 2]]
    cr = np.cross(b - a, c - a)
    area = 0.5 * np.linalg.norm(cr, axis=1)
    if area.sum() <= 0:
        return np.zeros((0, 3)), np.zeros((0, 3)), np.zeros((0, 3))
    fi = rng.choice(len(F), n, p=area / area.sum())
    r1, r2 = np.sqrt(rng.random(n)), rng.random(n)
    w = np.stack([1 - r1, r1 * (1 - r2), r1 * r2], axis=1)
    P = (V[F[fi]] * w[:, :, None]).sum(1)
    N = cr[fi] / np.maximum(np.linalg.norm(cr[fi], axis=1, keepdims=True), 1e-30)
    if mode == "confidence" and m["conf"] is not None:
        cf = (m["conf"][F[fi]] * w).sum(1)
        col = np.stack([1 - cf, cf, np.zeros_like(cf)], axis=1) * 0.9  # red = no evidence, green = supported
    elif mode == "normals":
        col = 0.5 + 0.5 * N
    elif m["uv"] is not None and m["img"] is not None:
        uv = (m["uv"][F[fi]] * w[:, :, None]).sum(1)
        img = np.asarray(m["img"].convert("RGB"), dtype=np.float32) / 255.0
        h, wd = img.shape[:2]
        # trimesh converts glTF UVs to a bottom-left origin on load
        x = np.clip((uv[:, 0] * wd).astype(int), 0, wd - 1)
        y = np.clip(((1.0 - uv[:, 1]) * h).astype(int), 0, h - 1)
        col = img[y, x]
    else:
        col = np.full((n, 3), 0.6)
    return P, N, col


def render(P, N, col, eye, target, up, size, fov_deg=35.0, mode="textured"):
    f = target - eye
    f /= np.linalg.norm(f)
    s = np.cross(f, up)
    s /= np.linalg.norm(s)
    u = np.cross(s, f)
    d = P - eye
    x, y, z = d @ s, d @ u, d @ f
    focal = 0.5 * size / np.tan(np.radians(fov_deg) / 2)
    ok = z > 1e-6
    px = (size / 2 + focal * x[ok] / z[ok]).astype(int)
    py = (size / 2 - focal * y[ok] / z[ok]).astype(int)
    inside = (px >= 0) & (px < size) & (py >= 0) & (py < size)
    px, py, zz = px[inside], py[inside], z[ok][inside]
    c = col[ok][inside].copy()
    n = N[ok][inside]
    view = -(d[ok][inside] / np.linalg.norm(d[ok][inside], axis=1, keepdims=True))
    facing = (n * view).sum(1)
    # Back faces (the inside of an open scan seen through a hole) are tinted dark magenta in EVERY
    # mode, so a hole can never look like supported surface.
    back = facing[:, None] < 0
    if mode == "textured":
        c = np.where(back, c * 0.35 + np.array([0.25, 0.0, 0.25]), c)
    else:
        c = np.where(back, np.array([0.22, 0.0, 0.22]) + 0.1 * c, c * (0.55 + 0.45 * np.abs(facing))[:, None])
    order = np.argsort(-zz)  # far to near; last write wins
    img = np.full((size, size, 3), 0.18, dtype=np.float32)
    img[py[order], px[order]] = c[order]
    return (np.clip(img, 0, 1) * 255).astype(np.uint8)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("glb")
    ap.add_argument("out")
    ap.add_argument("--mode", default="textured", choices=["textured", "confidence", "normals"])
    ap.add_argument("--views", type=int, default=4)
    ap.add_argument("--size", type=int, default=640)
    ap.add_argument("--samples", type=int, default=2_500_000)
    ap.add_argument("--crop", action="store_true", help="only render inside the suggested crop box from asset.extras")
    ap.add_argument("--elev", type=float, default=25.0)
    a = ap.parse_args()
    data = load(a.glb)
    rng = np.random.default_rng(1)
    Ps, Ns, Cs = [], [], []
    total_area = sum(float(np.linalg.norm(np.cross(m["V"][m["F"][:, 1]] - m["V"][m["F"][:, 0]],
                                                    m["V"][m["F"][:, 2]] - m["V"][m["F"][:, 0]]), axis=1).sum())
                     for m in data["meshes"]) or 1.0
    for m in data["meshes"]:
        ar = float(np.linalg.norm(np.cross(m["V"][m["F"][:, 1]] - m["V"][m["F"][:, 0]],
                                           m["V"][m["F"][:, 2]] - m["V"][m["F"][:, 0]]), axis=1).sum())
        P, N, C = sample_surface(m, max(1000, int(a.samples * ar / total_area)), rng, a.mode)
        Ps.append(P); Ns.append(N); Cs.append(C)
    P, N, C = np.concatenate(Ps), np.concatenate(Ns), np.concatenate(Cs)
    if a.crop:
        import struct
        raw = open(a.glb, "rb").read()
        jl = struct.unpack_from("<I", raw, 12)[0]
        ex = json.loads(raw[20:20 + jl])["asset"].get("extras", {}).get("pocket3d", {})
        crop = ex.get("suggested_crop")
        if crop:
            c0, he = np.array(crop["center"]), np.array(crop["half_extents"])
            keep = (np.abs(P - c0) <= he).all(1)
            P, N, C = P[keep], N[keep], C[keep]
    lo, hi = np.percentile(P, 1, axis=0), np.percentile(P, 99, axis=0)
    center = 0.5 * (lo + hi)
    radius = 0.5 * np.linalg.norm(hi - lo)
    dist = radius / np.tan(np.radians(35.0) / 2) * 1.05
    tiles = []
    for i in range(a.views):
        az = 2 * np.pi * i / a.views
        el = np.radians(a.elev)
        eye = center + dist * np.array([np.cos(el) * np.sin(az), np.sin(el), np.cos(el) * np.cos(az)])
        tiles.append(render(P, N, C, eye, center, np.array([0.0, 1.0, 0.0]), a.size, mode=a.mode))
    cols = min(a.views, 4)
    rows = (len(tiles) + cols - 1) // cols
    sheet = np.full((rows * a.size, cols * a.size, 3), 46, dtype=np.uint8)
    for i, t in enumerate(tiles):
        r, c = divmod(i, cols)
        sheet[r * a.size:(r + 1) * a.size, c * a.size:(c + 1) * a.size] = t
    Image.fromarray(sheet).save(a.out)
    print(f"rendered {len(P)} samples, {len(data['meshes'])} primitive(s) -> {a.out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
