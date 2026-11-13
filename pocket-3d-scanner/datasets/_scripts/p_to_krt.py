#!/usr/bin/env python3
"""Decompose 3x4 projection matrices (AliceVision/CMPMVS `*_P.txt`) into K, R, C.

Run with `python3 -I` (the inputs are downloaded, untrusted text files; they
are only parsed as floats).

usage: python3 -I p_to_krt.py <cameras_dir> <out_json>
"""
import json
import os
import sys

import numpy as np


def rq(M):
    """RQ decomposition of a 3x3 matrix: M = K @ R, K upper-triangular with
    positive diagonal, R orthonormal."""
    P = np.flipud(np.eye(3))
    q, r = np.linalg.qr((P @ M).T)
    K = P @ r.T @ P
    R = P @ q.T
    S = np.diag(np.sign(np.diag(K)))
    return K @ S, S @ R


def main():
    cam_dir, out = sys.argv[1], sys.argv[2]
    res = {}
    for name in sorted(os.listdir(cam_dir)):
        if not name.endswith("_P.txt"):
            continue
        with open(os.path.join(cam_dir, name), "r", encoding="ascii", errors="replace") as fh:
            vals = [float(x) for x in fh.read().split()]
        if len(vals) != 12:
            raise SystemExit(f"{name}: expected 12 numbers, got {len(vals)}")
        Pm = np.array(vals).reshape(3, 4)
        K, R = rq(Pm[:, :3])
        if np.linalg.det(R) < 0:
            R = -R
            Pm = -Pm
        K = K / K[2, 2]
        C = -np.linalg.solve(Pm[:, :3], Pm[:, 3])
        res[name.replace("_P.txt", "")] = {
            "fx": K[0, 0], "fy": K[1, 1], "skew": K[0, 1],
            "cx": K[0, 2], "cy": K[1, 2],
            "R_world_to_cam": R.tolist(),
            "camera_center_world": C.tolist(),
        }
    with open(out, "w", encoding="utf-8") as fh:
        json.dump(res, fh, indent=1)
    fx = np.array([v["fx"] for v in res.values()])
    fy = np.array([v["fy"] for v in res.values()])
    cx = np.array([v["cx"] for v in res.values()])
    cy = np.array([v["cy"] for v in res.values()])
    C = np.array([v["camera_center_world"] for v in res.values()])
    print(f"n={len(res)}")
    print(f"fx min/median/max = {fx.min():.1f} / {np.median(fx):.1f} / {fx.max():.1f}")
    print(f"fy min/median/max = {fy.min():.1f} / {np.median(fy):.1f} / {fy.max():.1f}")
    print(f"cx median = {np.median(cx):.1f}, cy median = {np.median(cy):.1f}")
    print(f"camera-centre bbox extent = {(C.max(0) - C.min(0)).round(3).tolist()}")


if __name__ == "__main__":
    main()
