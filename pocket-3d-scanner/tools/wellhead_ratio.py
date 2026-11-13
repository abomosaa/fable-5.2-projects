#!/usr/bin/env python3
"""Scale-free shape check for the 'concave' dataset (Townley well-head, British Museum).

Documented dimensions: diameter 84 cm, height 81.9 cm  ->  diameter / height = 1.026.
The reconstruction has arbitrary units, so only the RATIO can be checked without a reference
distance. Procedure: vertical axis = model +Y; axis position = centroid of the top rim band;
radial profile r(y) = 99th percentile of horizontal distance from the axis per height slice;
the object's base is where the profile jumps to the (wider, square) plinth; diameter = 2 x the
largest profile radius within the object (the moulded rim), height = top of rim - base.
The base detection is a judgement call, so the profile is printed for inspection.
"""
import json, sys
import numpy as np, trimesh

glb = sys.argv[1] if len(sys.argv) > 1 else "results/concave_standard/model.glb"
s = trimesh.load(glb, force="scene", process=False)
V = np.concatenate([trimesh.transformations.transform_points(g.vertices, s.graph.get(s.graph.geometry_nodes[n][0])[0])
                    for n, g in s.geometry.items()])
diag = json.load(open(glb.replace("model.glb", "diagnostics.json")))
c0, he = np.array(diag["suggested_crop"]["center"]), np.array(diag["suggested_crop"]["half_extents"])
P = V[(np.abs(V - c0) <= he * 1.05).all(1)]
top = np.percentile(P[:, 1], 99.8)
band = P[P[:, 1] > top - 0.04 * (top - P[:, 1].min())]
axis = band[:, [0, 2]].mean(0)
r = np.hypot(P[:, 0] - axis[0], P[:, 2] - axis[1])
ys = np.linspace(P[:, 1].min(), top, 61)
prof = []
for a, b in zip(ys[:-1], ys[1:]):
    m = (P[:, 1] >= a) & (P[:, 1] < b)
    prof.append((0.5 * (a + b), float(np.percentile(r[m], 99)) if m.sum() > 50 else float("nan"), int(m.sum())))
prof = np.array(prof)
upper = prof[len(prof) // 2:]
r_obj = np.nanmax(upper[:, 1])
# base: going down from mid-height, the first slice whose radius exceeds the object's maximum by 8 %
base = prof[0, 0]
for y, rad, n in prof[len(prof) // 2::-1]:
    if np.isfinite(rad) and rad > 1.08 * r_obj:
        base = y + 0.5 * (ys[1] - ys[0])
        break
height = top - base
out = {"diameter_units": round(2 * r_obj, 4), "height_units": round(float(height), 4),
       "diameter_over_height": round(float(2 * r_obj / height), 4), "documented_ratio": round(84 / 81.9, 4),
       "ratio_error_percent": round(float(100 * ((2 * r_obj / height) / (84 / 81.9) - 1)), 2),
       "profile_y_radius": [[round(float(y), 3), None if not np.isfinite(rr) else round(float(rr), 3)] for y, rr, _ in prof[::3]]}
print(json.dumps(out, indent=1))
