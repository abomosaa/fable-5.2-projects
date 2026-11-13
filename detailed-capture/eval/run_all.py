#!/usr/bin/env python3
"""Runs the whole synthetic evaluation: pipeline + scoring for every set, writes eval/results/<set>/report.json
and eval/results/summary.json. Usage: run_all.py [--sets wave,document,...] [--threads 4]"""
import argparse, json, os, platform, shutil, sys, time
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import dcrun, evaluate

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..")
ap = argparse.ArgumentParser()
ap.add_argument("--sets", default="wave,wave_distorted,document,repetitive,relief")
ap.add_argument("--threads", type=int, default=4)
ap.add_argument("--out", default=os.path.join(ROOT, "eval", "results"))
a = ap.parse_args()
summary = {}
for name in a.sets.split(","):
    set_dir = os.path.join(ROOT, "datasets", "synthetic", "sets", name)
    proj = os.path.join(ROOT, "eval", "work", name)
    out_dir = os.path.join(a.out, "synthetic_" + name)
    os.makedirs(out_dir, exist_ok=True)
    t0 = time.time()
    run = dcrun.run_set(set_dir, proj, threads=a.threads)
    open(os.path.join(out_dir, "frames.txt"), "w").write(dcrun.summarize(run) + "\n")
    rep = evaluate.eval_synthetic(set_dir, proj, out_dir)
    rep["timing"] = run["timing"]
    rep["images"] = 1 + len(run["names"])
    json.dump(rep, open(os.path.join(out_dir, "report.json"), "w"), indent=1)
    # keep a viewable copy of the actual output
    if run["result"]:
        dcrun.call("export.flat", {"dir": proj, "format": "jpeg", "path": os.path.join(out_dir, "fused_preview.jpg"), "scale": min(1.0, 2400.0 / run["result"]["width"]), "quality": 90})
    summary[name] = {"images": rep["images"], "timing": run["timing"], "registration": rep["registration"], "quality_supported": rep.get("quality_supported"),
                     "quality_overview_only": rep.get("quality_overview_only"), "overview_consistency": rep.get("overview_consistency"), "result": rep.get("result"), "glyphs": rep.get("glyphs"), "bars": rep.get("bars"),
                     "statuses": {r["file"]: [r["expect"], r["status"], r["reasons"]] for r in rep["frames"]}}
    print(f"== {name}: {time.time() - t0:.1f}s", json.dumps(rep["registration"]), json.dumps(rep.get("quality_supported")), flush=True)
    print(dcrun.summarize(run), flush=True)
summary["_environment"] = {"machine": platform.machine(), "processor": platform.processor(), "cpus": os.cpu_count(), "threads_used": a.threads, "python": platform.python_version()}
prev = {}
sp = os.path.join(a.out, "summary.json")
if os.path.exists(sp):
    prev = json.load(open(sp))
prev.update(summary)
json.dump(prev, open(sp, "w"), indent=1)
