#!/usr/bin/env python3
"""Runs the real Detailed Capture pipeline (the same core commands the Android app calls) on a folder of photos.

  dcrun.py <set_dir> <project_dir> [--threads N] [--hints] [--no-fuse]

<set_dir> must contain overview.* and closeup_*/x_* images. Originals are copied byte-for-byte into the
project exactly like the app does.
"""
import argparse
import glob
import json
import os
import shutil
import subprocess
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
DCAP = os.environ.get("DCAP", os.path.join(HERE, "..", "build", "core", "dcap"))


def call(cmd, args, threads=4, mem=1024, quiet=True, check=True):
    p = subprocess.run([DCAP, cmd, json.dumps(args), "--threads", str(threads), "--mem", str(mem)] + (["--quiet"] if quiet else []),
                       capture_output=True, text=True)
    try:
        r = json.loads(p.stdout.strip().splitlines()[-1])
    except Exception:
        raise RuntimeError(f"{cmd} produced no JSON: {p.stdout[-500:]} {p.stderr[-2000:]}")
    if check and not r.get("ok"):
        raise RuntimeError(f"{cmd} failed: {r}")
    return r["data"] if r.get("ok") else r


def add(proj, src, role, hint=None):
    ext = os.path.splitext(src)[1].lower()
    name = os.path.basename(src)
    rel = "originals/" + name
    shutil.copyfile(src, os.path.join(proj, rel))  # byte-exact copy of the original
    args = {"dir": proj, "file": rel, "role": role, "source": "import", "originalName": name}
    if hint:
        args["hint"] = hint
    return call("frame.add", args, check=False)


def run_set(set_dir, proj, threads=4, fuse=True, hints=None, only=None, mem=1024):
    if os.path.exists(proj):
        shutil.rmtree(proj)
    t = {}
    call("project.create", {"dir": proj, "name": os.path.basename(set_dir.rstrip("/"))})
    ov = sorted(glob.glob(os.path.join(set_dir, "overview.*")))[0]
    t0 = time.time()
    r = add(proj, ov, "overview")
    assert "id" in r, r
    names = {}
    files = sorted(glob.glob(os.path.join(set_dir, "closeup_*")) + glob.glob(os.path.join(set_dir, "x_*")))
    files = [f for f in files if os.path.splitext(f)[1].lower() in (".jpg", ".jpeg", ".png", ".tif", ".tiff", ".webp")]
    if only:
        files = [f for f in files if os.path.basename(f) in only]
    add_errors = {}
    for f in files:
        r = add(proj, f, "closeup", (hints or {}).get(os.path.basename(f)))
        if "id" in r:
            names[r["id"]] = os.path.basename(f)
        else:
            add_errors[os.path.basename(f)] = r
    t["add_s"] = time.time() - t0
    t0 = time.time()
    reg = call("register", {"dir": proj}, threads=threads, mem=mem)
    t["register_s"] = time.time() - t0
    cov = call("coverage", {"dir": proj})
    res = None
    if fuse:
        t0 = time.time()
        res = call("compose", {"dir": proj}, threads=threads, mem=mem)
        t["compose_s"] = time.time() - t0
    project = call("project.load", {"dir": proj})
    return {"project": project, "registration": reg, "coverage": cov, "result": res, "names": names, "timing": t, "add_errors": add_errors}


def summarize(out):
    rows = []
    for f in out["project"]["frames"]:
        if f["role"] != "closeup":
            continue
        g = f.get("reg", {})
        rows.append((out["names"].get(f["id"], f["id"]), g.get("status"), ",".join(g.get("reasons", [])), ",".join(g.get("warnings", [])),
                     g.get("nInliers"), round(g.get("scale", 0), 2), round(g.get("effGain", 0), 2), round(g.get("zncc", -1), 2), round(g.get("residualPx", 0), 2),
                     g.get("pairs"), g.get("via", ""), round(g.get("maskedFrac", 0), 2), round(f["quality"].get("sharpSigma", 0), 2)))
    hdr = ("file", "status", "reasons", "warnings", "inl", "scale", "gain", "zncc", "resPx", "pairs", "via", "mask", "sigma")
    w = [max(len(str(r[i])) for r in rows + [hdr]) for i in range(len(hdr))]
    lines = ["  ".join(str(h).ljust(w[i]) for i, h in enumerate(hdr))]
    for r in rows:
        lines.append("  ".join(str(v).ljust(w[i]) for i, v in enumerate(r)))
    return "\n".join(lines)


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("set_dir")
    ap.add_argument("project")
    ap.add_argument("--threads", type=int, default=4)
    ap.add_argument("--no-fuse", action="store_true")
    a = ap.parse_args()
    out = run_set(a.set_dir, a.project, threads=a.threads, fuse=not a.no_fuse)
    print(summarize(out))
    print(json.dumps({k: out[k] for k in ("registration", "timing", "result", "add_errors")}, indent=1)[:3000])
    print(json.dumps(out["coverage"]["stats"]))
