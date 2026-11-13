#!/usr/bin/env python3
"""Real-photo evaluation: full run of every set in datasets/real plus leave-one-out scoring against held-out
close-ups (independent high-resolution references). Writes eval/results/real_<set>/ and updates summary.json."""
import argparse, json, os, shutil, sys, time
import cv2, numpy as np
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import dcrun, evaluate

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..")
ap = argparse.ArgumentParser()
ap.add_argument("--sets", default="vatican_map_sicilia,alexander_mosaic_sailko,claudian_table,portonaccio_sarcophagus")
ap.add_argument("--threads", type=int, default=4)
ap.add_argument("--holdouts", type=int, default=2)
a = ap.parse_args()
out_root = os.path.join(ROOT, "eval", "results")
summary = {}

def poly_area(p):
    return abs(cv2.contourArea(np.float32(p)))

for name in a.sets.split(","):
    set_dir = os.path.join(ROOT, "datasets", "real", name)
    proj = os.path.join(ROOT, "eval", "work", "real_" + name)
    out_dir = os.path.join(out_root, "real_" + name)
    os.makedirs(out_dir, exist_ok=True)
    run = dcrun.run_set(set_dir, proj, threads=a.threads)
    open(os.path.join(out_dir, "frames.txt"), "w").write(dcrun.summarize(run) + "\n")
    project = run["project"]
    entry = {"images": 1 + len(run["names"]), "timing": run["timing"], "registration": run["registration"], "coverage": run["coverage"]["stats"],
             "result": run["result"], "statuses": {f.get("originalName"): [f["reg"].get("status"), f["reg"].get("reasons", []), f["reg"].get("warnings", []), f["reg"].get("scale")]
                                                  for f in project["frames"] if f["role"] == "closeup"},
             "megapixels": {f.get("originalName") or "overview": round(f["meta"]["width"] * f["meta"]["height"] / 1e6, 1) for f in project["frames"]}}
    print(f"== {name}\n" + dcrun.summarize(run), flush=True)
    if run["result"]:
        entry["overview_consistency"] = evaluate.overview_consistency(proj, project)
        dcrun.call("export.flat", {"dir": proj, "format": "jpeg", "path": os.path.join(out_dir, "fused_preview.jpg"), "scale": min(1.0, 2600.0 / run["result"]["width"]), "quality": 90})
        # matched full-resolution crops at the centre of the three largest-scale accepted close-ups
        acc = [f for f in project["frames"] if f["role"] == "closeup" and f["reg"].get("status") == "accepted"]
        acc.sort(key=lambda f: -f["reg"]["scale"])
        sx = run["result"]["width"] / project["frames"][0]["meta"]["width"]
        for i, f in enumerate(acc[:3]):
            c = np.mean(f["reg"]["footprint"], 0) * sx
            x, y = int(max(0, c[0] - 450)), int(max(0, c[1] - 325))
            pre = os.path.join(out_dir, f"crop{i}")
            dcrun.call("debug.crops", {"dir": proj, "x": x, "y": y, "w": 900, "h": 650, "prefix": pre})
            o, r = cv2.imread(pre + "_overview.png"), cv2.imread(pre + "_result.png")
            cv2.imwrite(os.path.join(out_dir, f"crop{i}_overview-enlarged_vs_fused_{f['originalName'].split('.')[0]}.jpg"), np.hstack([o, r]), [cv2.IMWRITE_JPEG_QUALITY, 93])
            for ext in ("_overview.png", "_result.png", "_source.png"):
                if os.path.exists(pre + ext): os.remove(pre + ext)
        # hold-out candidates: close-ups whose footprint is mostly covered by other accepted close-ups of similar scale
        cands = []
        for f in acc:
            fp = np.float32(f["reg"]["footprint"])
            cov = 0.0
            for g in acc:
                if g is f or g["reg"]["scale"] < 0.6 * f["reg"]["scale"]:
                    continue
                ia, _ = cv2.intersectConvexConvex(fp, np.float32(g["reg"]["footprint"]))
                cov = max(cov, ia / max(1.0, poly_area(fp)))
            cands.append((cov, f["originalName"]))
        cands.sort(reverse=True)
        holds = [n for c, n in cands if c > 0.45][:a.holdouts]
        entry["holdout_candidates"] = cands[:6]
        if holds:
            rep = evaluate.eval_holdout(set_dir, os.path.join(ROOT, "eval", "work"), out_dir, holds, threads=a.threads)
            entry["holdouts"] = [{k: v for k, v in h.items() if k not in ("windows", "summary")} for h in rep["holdouts"]]
            for h in holds:
                shutil.rmtree(os.path.join(ROOT, "eval", "work", "holdout_" + os.path.splitext(h)[0]), ignore_errors=True)
            print(json.dumps(entry["holdouts"], indent=1), flush=True)
    summary["real_" + name] = entry
    sp = os.path.join(out_root, "summary.json")
    prev = json.load(open(sp)) if os.path.exists(sp) else {}
    prev.update(summary)
    json.dump(prev, open(sp, "w"), indent=1)
