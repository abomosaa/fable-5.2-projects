#!/usr/bin/env python3
"""List the NAVI images of one extracted scene in original capture order
(sorted by `filename_original`; NAVI's 000..NNN names are shuffled), with the
camera centre in the scan/object frame (mm), its distance from the scan origin,
and the angular step (deg, as seen from the scan origin) to the previous capture.

Stdlib only; run with `python3 -I` (the JSON is downloaded, untrusted data and
is only parsed).

usage: python3 -I navi_capture_order.py <dataset_dir>   > <dataset_dir>/capture_order.txt
"""
import json
import math
import os
import sys


def quat_to_R(q):
    w, x, y, z = q
    s = 2.0 / (w * w + x * x + y * y + z * z)
    return [
        [1 - s * (y * y + z * z), s * (x * y - z * w), s * (x * z + y * w)],
        [s * (x * y + z * w), 1 - s * (x * x + z * z), s * (y * z - x * w)],
        [s * (x * z - y * w), s * (y * z + x * w), 1 - s * (x * x + y * y)],
    ]


def main():
    root = sys.argv[1]
    with open(os.path.join(root, "reference", "annotations.json"), encoding="utf-8") as fh:
        ann = json.load(fh)
    ann.sort(key=lambda a: a["filename_original"])
    print("# pos file filename_original dist_mm Cx Cy Cz step_deg occluded")
    prev = None
    for i, a in enumerate(ann):
        R = quat_to_R(a["camera"]["q"])
        t = a["camera"]["t"]
        # x_cam = R x_obj + t  ->  camera centre C = -R^T t
        C = [-(R[0][k] * t[0] + R[1][k] * t[1] + R[2][k] * t[2]) for k in range(3)]
        n = math.sqrt(sum(c * c for c in C))
        d = [c / n for c in C]
        if prev is None:
            step = "nan"
        else:
            dot = max(-1.0, min(1.0, sum(p * q for p, q in zip(d, prev))))
            step = f"{math.degrees(math.acos(dot)):.1f}"
        print(f"{i:02d} {a['filename']} {a['filename_original']} {n:.1f} "
              f"{C[0]:.1f} {C[1]:.1f} {C[2]:.1f} {step} {str(a['occluded']).lower()}")
        prev = d


if __name__ == "__main__":
    main()
