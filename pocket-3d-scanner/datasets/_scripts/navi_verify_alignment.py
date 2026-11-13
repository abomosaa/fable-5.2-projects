#!/usr/bin/env python3
"""Empirically check the NAVI ground-truth conventions for one extracted scene.

Projects (a subsample of) the scan vertices into every image with the pose in
`reference/annotations.json` and reports
  * the fraction of projected vertices that land on the shipped object mask,
  * the median |z_cam - decoded GT depth| at those pixels,
for two candidate camera conventions (OpenCV: +z forward, +y down;
OpenGL: -z forward, +y up). The convention with ~100 % mask hits is the right one.

Also prints the scan bounding box (units) and writes nothing.
Run with `python3 -I` (inputs are downloaded, untrusted files; they are only
parsed as text / decoded as PNG).

usage: python3 -I navi_verify_alignment.py <dataset_dir>
"""
import json
import os
import sys

import numpy as np
from PIL import Image

Image.MAX_IMAGE_PIXELS = 64_000_000


def quat_to_R(q):
    w, x, y, z = q
    s = 2.0 / (w * w + x * x + y * y + z * z)
    return np.array([
        [1 - s * (y * y + z * z), s * (x * y - z * w), s * (x * z + y * w)],
        [s * (x * y + z * w), 1 - s * (x * x + z * z), s * (y * z - x * w)],
        [s * (x * z - y * w), s * (y * z + x * w), 1 - s * (x * x + y * y)],
    ])


def load_obj_vertices(path, max_vertices=20000):
    verts = []
    with open(path, "r", encoding="ascii", errors="replace") as fh:
        for line in fh:
            if line.startswith("v "):
                p = line.split()
                verts.append((float(p[1]), float(p[2]), float(p[3])))
    v = np.array(verts)
    full_min, full_max = v.min(0), v.max(0)
    if len(v) > max_vertices:
        v = v[:: len(v) // max_vertices]
    return v, full_min, full_max, len(verts)


def decode_depth(png_path):
    # NAVI data_util.decode_depth: uint16 PNG stores disparity*65535*10; 0 = background.
    d = np.asarray(Image.open(png_path)).astype(np.float64) / (65535.0 * 10.0)
    with np.errstate(divide="ignore"):
        return np.where(d > 0, 1.0 / d, np.inf)


def main():
    root = sys.argv[1]
    ref = os.path.join(root, "reference")
    scan_dir = os.path.join(ref, "3d_scan")
    obj = [f for f in sorted(os.listdir(scan_dir)) if f.endswith(".obj")][0]
    v, bmin, bmax, nv = load_obj_vertices(os.path.join(scan_dir, obj))
    ext = bmax - bmin
    print(f"scan {obj}: {nv} vertices, bbox min {bmin.round(2).tolist()} max {bmax.round(2).tolist()}")
    print(f"scan bbox extent (scan units) = {ext.round(2).tolist()}")

    with open(os.path.join(ref, "annotations.json"), "r", encoding="utf-8") as fh:
        ann = json.load(fh)

    stats = {"opencv": [], "opengl": []}
    depth_err = {"opencv": [], "opengl": []}
    dists = []
    for a in ann:
        h, w = a["image_size"]
        f = a["camera"]["focal_length"]
        R = quat_to_R(a["camera"]["q"])
        t = np.array(a["camera"]["t"])
        xc = v @ R.T + t
        dists.append(float(np.linalg.norm(t)))
        stem = os.path.splitext(a["filename"])[0]
        mask = np.asarray(Image.open(os.path.join(ref, "masks", stem + ".png")).convert("L")) > 0
        dpath = os.path.join(ref, "depth", stem + ".png")
        depth = decode_depth(dpath) if os.path.exists(dpath) else None
        assert mask.shape == (h, w), (mask.shape, h, w)
        for name in ("opencv", "opengl"):
            if name == "opencv":
                z = xc[:, 2]
                u = f * xc[:, 0] / z + w / 2.0
                vv = f * xc[:, 1] / z + h / 2.0
            else:
                z = -xc[:, 2]
                u = f * xc[:, 0] / z + w / 2.0
                vv = h / 2.0 - f * xc[:, 1] / z
            ok = (z > 0) & (u >= 0) & (u < w) & (vv >= 0) & (vv < h)
            ui = u[ok].astype(int)
            vi = vv[ok].astype(int)
            hit = mask[vi, ui]
            stats[name].append(hit.sum() / max(1, len(z)))
            if depth is not None and hit.any():
                dd = depth[vi[hit], ui[hit]]
                e = np.abs(dd - z[ok][hit])
                # vertices on the far side of the object are legitimately behind the depth map
                depth_err[name].append(float(np.percentile(e[np.isfinite(e)], 25)))
    for name in ("opencv", "opengl"):
        s = np.array(stats[name])
        msg = f"{name}: vertices-on-mask fraction mean={s.mean():.3f} min={s.min():.3f}"
        if depth_err[name]:
            msg += f"; 25th-pct |z - gt_depth| (scan units) median over images={np.median(depth_err[name]):.3f}"
        print(msg)
    d = np.array(dists)
    print(f"camera-to-object-origin distance (scan units): min={d.min():.1f} median={np.median(d):.1f} max={d.max():.1f}")
    print(f"images={len(ann)} focal_px={sorted(set(round(a['camera']['focal_length'], 2) for a in ann))} "
          f"image_size_hw={sorted(set(tuple(a['image_size']) for a in ann))}")


if __name__ == "__main__":
    main()
