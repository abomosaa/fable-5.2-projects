#!/usr/bin/env python3
"""Build results/SUMMARY.md from the benchmark outputs (results/<run>/diagnostics.json etc.).

    python3 tools/summarize_results.py            # writes results/SUMMARY.md and prints it

Every number comes from files produced by the real pipeline / evaluation tools; nothing is
typed in by hand.
"""
from __future__ import annotations

import json
import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
RES = ROOT / "results"


def load(p: Path):
    try:
        return json.loads(p.read_text())
    except Exception:
        return None


def fmt_time(s: float) -> str:
    return f"{int(s // 60)} min {int(s % 60):02d} s" if s >= 60 else f"{s:.0f} s"


def rows_for(dirpath: Path) -> list[dict]:
    out = []
    for d in sorted(p for p in dirpath.iterdir() if p.is_dir() and not p.name.startswith("_")):
        diag = load(d / "diagnostics.json")
        job = load(d / "job.json") or {}
        code = (d / "exit_code").read_text().strip() if (d / "exit_code").exists() else "?"
        if diag is None:
            out.append({"run": d.name, "failed": True, "exit": code})
            continue
        glb = d / "model.glb"
        o = diag["mesh"]["object_region"]
        tex = diag["texture"]["pages"]
        out.append({
            "run": d.name, "failed": False, "exit": code,
            "preset": diag["job"]["preset"], "images": diag["input"]["frames"],
            "threads": diag["environment"]["threads"], "mem_limit": diag["environment"]["memory_limit_mb"],
            "registered": f"{diag['sfm']['registered']}/{diag['sfm']['input_frames']}",
            "reproj": diag["sfm"]["mean_reprojection_error_px"], "sparse": diag["sfm"]["sparse_points"],
            "dense_pts": diag["dense"]["dense_points"], "dense_side": diag["dense"]["depth_map_max_side"],
            "faces": diag["mesh"]["faces"], "verts": diag["mesh"]["vertices"],
            "tex": " + ".join(f"{t['width']}²" for t in tex), "tex_bytes": sum(t["bytes"] for t in tex),
            "glb_mb": glb.stat().st_size / 1e6 if glb.exists() else 0,
            "time": diag["timings_s"]["total"], "timings": diag["timings_s"],
            "rss": diag.get("peak_rss_mb"), "rss_by_stage": diag.get("peak_rss_mb_by_stage", {}),
            "support": o["well_supported_area_fraction"], "weak": o["weak_area_fraction"],
            "unsupported": o["unsupported_area_fraction"], "holes": o["boundary"]["boundary_loops"],
            "viewpoints": f"{diag['viewpoint_coverage']['azimuth_bins_covered']}/12",
            "gap": diag["viewpoint_coverage"]["largest_azimuth_gap_deg"],
            "scale": diag["scale"]["units"], "warnings": [w["code"] for w in diag["warnings"]],
            "ground": bool(diag.get("ground")),
            "load": load(d / "host_load.json"),
        })
    return out


def load_table(rows: list[dict]) -> str:
    """Load average of the host around each run (other work on the machine distorts timings)."""
    rows = [r for r in rows if not r["failed"] and r.get("load")]
    if not rows:
        return ""
    L = ["### Host load around each run (1 / 5 / 15-minute load average; the machine has "
         f"{rows[0]['load'].get('cpu_threads', '?')} hardware threads)\n",
         "| Run | Threads given | Before | After |", "|---|---|---|---|"]
    for r in rows:
        lo = r["load"]
        L.append(f"| {r['run']} | {lo.get('threads_given', '?')} | {lo.get('loadavg_1_5_15_before', '?')} | {lo.get('loadavg_1_5_15_after', '?')} |")
    return "\n".join(L) + "\n"


def table(rows: list[dict]) -> str:
    L = ["| Run | Preset | Photos | Registered | Reproj. px | Dense pts | Depth px | Triangles | Texture | GLB MB | "
         "Time | Peak RSS GB | Threads / limit | Well-supported | Weak | No evidence | Open loops | Viewpoint sectors | Warnings |",
         "|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|"]
    for r in rows:
        if r["failed"]:
            L.append(f"| {r['run']} | — | — | — | — | — | — | — | — | — | — | — | — | — | — | — | — | — | FAILED (exit {r['exit']}) |")
            continue
        L.append(
            f"| {r['run']} | {r['preset']} | {r['images']} | {r['registered']} | {r['reproj']:.2f} | {r['dense_pts']:,} | "
            f"{r['dense_side']} | {r['faces']:,} | {r['tex']} | {r['glb_mb']:.1f} | {fmt_time(r['time'])} | "
            f"{(r['rss'] or 0) / 1024:.1f} | {r['threads']} / {r['mem_limit'] / 1024:.0f} GB | {r['support'] * 100:.1f}% | "
            f"{r['weak'] * 100:.1f}% | {r['unsupported'] * 100:.1f}% | {r['holes']} | {r['viewpoints']} (gap {r['gap']:.0f}°) | "
            f"{', '.join(r['warnings']) or '—'} |")
    return "\n".join(L)


def stage_table(rows: list[dict]) -> str:
    stages = ["ingest", "features", "matching", "sfm", "undistort", "dense", "mesh", "refine", "texture", "package"]
    L = ["| Run | " + " | ".join(stages) + " | total |", "|---|" + "---|" * (len(stages) + 1)]
    for r in rows:
        if r["failed"]:
            continue
        cells = []
        for s in stages:
            t = r["timings"].get(s)
            m = r["rss_by_stage"].get(s)
            cells.append("—" if t is None else f"{t:.0f} s" + (f" / {m / 1024:.1f} GB" if m else ""))
        L.append(f"| {r['run']} | " + " | ".join(cells) + f" | {fmt_time(r['time'])} |")
    return "\n".join(L)


def eval_section(dirpath: Path) -> str:
    L = []
    for f in sorted((dirpath / "_evaluation").glob("*_vs_scan.json")) if (dirpath / "_evaluation").is_dir() else []:
        e = load(f)
        if not e:
            continue
        name = f.name.replace("_vs_scan.json", "")
        ca, icp = e["camera_alignment_only"], e["after_rigid_icp"]
        L.append(f"### {name} vs. reference scan\n")
        L.append(f"*Cameras used for the similarity alignment:* {e['cameras_used']} · scale {e['camera_alignment']['scale_mm_per_model_unit']:.2f} mm per "
                 f"model unit · camera-centre residual RMS {e['camera_alignment']['residual_rms_mm']:.1f} mm over a camera spread of "
                 f"{e['camera_alignment']['camera_spread_rms_mm']:.0f} mm · ICP correction {e['icp']['translation_mm']:.2f} mm / "
                 f"{e['icp']['rotation_deg']:.2f}° (fitness {e['icp']['fitness']:.2f})\n")
        L.append("| Alignment | Surface considered | Median mm | Mean mm | RMS mm | p90 mm | p95 mm | ≤ 1 mm | ≤ 2 mm |")
        L.append("|---|---|---|---|---|---|---|---|---|")
        blocks = [("cameras only", ca), ("cameras + rigid ICP", icp)]
        if e.get("shape_only_after_similarity_icp"):
            blocks.append((f"shape only: + one scale factor (×{e['similarity_icp_scale_correction']:.3f})",
                           e["shape_only_after_similarity_icp"]))
        for label, blk in blocks:
            for sl, key in (("accuracy: all reconstructed surface in scan box", "accuracy_mm"),
                            ("accuracy: object defined by ground-truth silhouettes", "object_by_silhouettes"),
                            ("accuracy: surface within 5 mm of the scan (excludes gross errors by construction)", "accuracy_object_attributed_mm"),
                            ("completeness: scan → reconstruction", "completeness_mm")):
                s = blk.get(key)
                if key == "object_by_silhouettes" and s:
                    s = s["accuracy_mm"]
                if not s:
                    continue
                L.append(f"| {label} | {sl} | {s['median']:.2f} | {s['mean']:.2f} | {s['rms']:.2f} | {s['p90']:.2f} | {s['p95']:.2f} | "
                         f"{s['within_1mm'] * 100:.0f}% | {s['within_2mm'] * 100:.0f}% |")
        L.append("")
        L.append(f"Share of reconstructed area in the scan box farther than 5 mm from the scan (support/stand or gross error): "
                 f"{ca['area_fraction_farther_than_object_threshold'] * 100:.0f}% (cameras only), "
                 f"{icp['area_fraction_farther_than_object_threshold'] * 100:.0f}% (after ICP).\n")
        ext, scan = e.get("extent_mm_after_icp", icp["extent_mm"]), e["scan_extent_mm"]
        L.append(f"| Dimension (scan axes; {e.get('extent_basis', 'surface within 5 mm of the scan')}) | Scan mm | Reconstruction mm (scale from camera poses) | Error |")
        L.append("|---|---|---|---|")
        for i in range(3):
            L.append(f"| axis {i} | {scan[i]:.1f} | {ext[i]:.1f} | {ext[i] - scan[i]:+.1f} mm ({100 * (ext[i] - scan[i]) / scan[i]:+.1f}%) |")
        u = e["single_reference_calibration"]
        L.append("")
        L.append(f"Single known-distance calibration (longest dimension {u['reference_axis_mm']:.1f} mm used as the reference, as the "
                 f"app's scale calibration does): " + "; ".join(
                     f"{d['scan_mm']:.1f} mm measured as {d['reconstruction_mm']:.1f} mm ({d['error_percent']:+.1f}%)"
                     for d in u["other_dimensions"]) + ".\n")
    return "\n".join(L)


def main() -> int:
    parts = ["# Benchmark summary (generated by tools/summarize_results.py)\n"]
    main_rows = rows_for(RES)
    parts += ["## Runs inside the 8 GiB service limit\n", table(main_rows), "",
              "### Time / peak memory per stage\n", stage_table(main_rows), "", load_table(main_rows), eval_section(RES)]
    arch = RES / "_archive_14t10g"
    if arch.is_dir():
        rows = rows_for(arch)
        parts += ["## Earlier runs with a larger budget (14 threads, 10 GB container)\n", table(rows), "",
                  "### Time / peak memory per stage\n", stage_table(rows), "", eval_section(arch)]
    arch = RES / "_archive_refine_half_size"
    if arch.is_dir():
        rows = rows_for(arch)
        parts += ["## Earlier run: High preset with half-size refinement (before refinement adapted to the memory limit)\n",
                  "Kept because its 5.8 GB peak under a 5 GB budget is the measurement that led to the "
                  "memory model for refinement. Produced by an earlier pipeline version; not regenerated.\n",
                  table(rows), "", "### Time / peak memory per stage\n", stage_table(rows), "", eval_section(arch)]
    text = "\n".join(parts) + "\n"
    (RES / "SUMMARY.md").write_text(text)
    print(text)
    return 0


if __name__ == "__main__":
    sys.exit(main())
