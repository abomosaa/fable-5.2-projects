"""build_docs.py <tools_dir> <real_dir>

Merges
  tools/sets.json          local filename -> Commons title
  tools/sets_notes.json    hand-written descriptions / caveats / per-file notes
  tools/out/<set>.json     sanity.py results (and optional alternative-overview results)
  Commons API metadata     (cached in tools/out/commons_meta.json)
into real/sources.json and real/SOURCES.md.  Only reads image headers (Pillow) and hashes bytes.
"""
import hashlib
import json
import os
import sys

from PIL import Image

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import commons  # noqa: E402

Image.MAX_IMAGE_PIXELS = 120_000_000
tools, real = sys.argv[1], sys.argv[2]
sets = json.load(open(os.path.join(tools, "sets.json"), encoding="utf-8"))
notes = json.load(open(os.path.join(tools, "sets_notes.json"), encoding="utf-8"))
cache_path = os.path.join(tools, "out", "commons_meta.json")
cache = json.load(open(cache_path, encoding="utf-8")) if os.path.exists(cache_path) else {}

order = [s for s in notes["order"] if s in sets]
need = [t for s in order for _, t in sets[s]["files"] if t not in cache]
if need:
    info = commons.imageinfo(need)
    for t in need:
        cache[t] = commons.summarize(t, info[t])
    json.dump(cache, open(cache_path, "w", encoding="utf-8"), indent=1, ensure_ascii=False)


def sha1(path):
    h = hashlib.sha1()
    with open(path, "rb") as f:
        for b in iter(lambda: f.read(1 << 20), b""):
            h.update(b)
    return h.hexdigest()


def fmt_exif(e):
    bits = []
    if e.get("Model"):
        bits.append(str(e["Model"]))
    if e.get("DateTimeOriginal"):
        bits.append(str(e["DateTimeOriginal"]))
    if e.get("FocalLength"):
        bits.append("f=%gmm" % e["FocalLength"])
    return ", ".join(bits) if bits else "no EXIF"


def independence(c, ov_exif):
    """Evidence that the close-up is its own exposure rather than a crop of the overview file."""
    e = c.get("exif", {})
    ev = []
    if e.get("DateTimeOriginal") and e.get("DateTimeOriginal") != ov_exif.get("DateTimeOriginal"):
        ev.append("own EXIF timestamp")
    if e.get("Model") and ov_exif.get("Model") and e["Model"] != ov_exif["Model"]:
        ev.append("different camera")
    s = c.get("scale_factor")
    if s and s > 1.3:
        ev.append("%.1fx more px per subject unit" % s)
    if not ev:
        return "UNVERIFIED"
    return "yes (" + ", ".join(ev) + ")"


def auto_verdict(c):
    n = c.get("inliers", 0) or 0
    if c.get("registers") and n >= 100:
        return "registers cleanly"
    if c.get("registers"):
        return "registers, weak support (%d inliers)" % n
    if c.get("scale_factor"):
        return "does NOT pass the baseline threshold (%d inliers)" % n
    return "does NOT register with the single-homography baseline (%d inliers)" % n


SANITY_KEYS = ("inliers", "ratio_matches", "h_inlier_ratio", "fundamental_inliers", "h_over_f_inliers",
               "scale_factor", "scale_at_corners", "anisotropy", "rms_px_work", "best_closeup_downscale",
               "footprint_overview_px", "footprint_fraction_of_overview", "ncc_vs_overview", "registers",
               "H_overview_to_closeup_original_px")
HDR = ["| close-up | EXIF (camera, time, focal) | ratio matches | H inliers | H/F inliers | scale factor | scale range at corners | footprint (% of overview frame) | NCC | registers | independent capture? | verdict |",
       "|---|---|---|---|---|---|---|---|---|---|---|---|"]


def sanity_row(local, c, indep, verdict):
    cs = c.get("scale_at_corners")
    return "| `%s` | %s | %s | %s | %s | %s | %s | %s | %s | %s | %s | %s |" % (
        local, fmt_exif(c.get("exif", {})), c.get("ratio_matches") or "-", c.get("inliers", 0),
        c.get("h_over_f_inliers") if c.get("h_over_f_inliers") is not None else "-",
        ("%.2f" % c["scale_factor"]) if c.get("scale_factor") else "-",
        ("%.2f-%.2f" % (min(cs), max(cs))) if cs else "-",
        ("%.1f" % (100 * c["footprint_fraction_of_overview"])) if c.get("footprint_fraction_of_overview") is not None else "-",
        c.get("ncc_vs_overview") if c.get("ncc_vs_overview") is not None else "-",
        "yes" if c.get("registers") else "NO", indep, verdict)


out = {"generated_by": "datasets/tools/build_docs.py", "method": notes["method"], "sets": []}
md = ["# Real photo sets for Detailed Capture evaluation", "", notes["intro"], "", "## Sanity-check method", "",
      notes["method"], ""]
total_bytes = 0
for sname in order:
    n = notes["sets"][sname]
    chk = json.load(open(os.path.join(tools, "out", sname + ".json"), encoding="utf-8"))
    by_file = {c["file"]: c for c in chk["closeups"]}
    ovx = chk["overview"]["exif"]
    alt = n.get("alt_overview")
    alt_chk = json.load(open(os.path.join(tools, "out", alt["json"]), encoding="utf-8")) if alt else None
    alt_by_file = {c["file"]: c for c in alt_chk["closeups"]} if alt else {}
    entry = {"name": sname, "category": n["category"], "subject": n["subject"], "description": n["description"],
             "caveats": n.get("caveats", []), "directory": "datasets/real/" + sname, "files": []}
    md += ["## %s" % sname, "", "**Category:** %s  " % n["category"], "**Subject:** %s" % n["subject"], "",
           n["description"], ""]
    if n.get("caveats"):
        md += ["Caveats:", ""] + ["- " + c for c in n["caveats"]] + [""]
    md += ["| local file | title (Commons) | author | license | source page | original px | notes |",
           "|---|---|---|---|---|---|---|"]
    rows, alt_rows = [], []
    for local, title in sets[sname]["files"]:
        m = cache[title]
        path = os.path.join(real, sname, local)
        with Image.open(path) as im:
            w, h = im.size
            orient = im.getexif().get(0x0112, 1)
        stored_px = [w, h]
        if orient in (5, 6, 7, 8):  # displayed (EXIF-oriented) size, which is what cv2.imread and Commons report
            w, h = h, w
        size = os.path.getsize(path)
        total_bytes += size
        digest = sha1(path)
        identical = (digest == m["sha1"])
        fnote = n.get("file_notes", {}).get(local, "")
        stem = os.path.splitext(local)[0]
        role = "closeup" if stem.startswith("closeup") else stem  # overview / overview_alt
        f = {"local": local, "role": role, "title": title, "author": m["author"], "uploader": m["uploader"],
             "license": m["license"], "license_url": m["license_url"], "usage_terms": m["usage_terms"],
             "source_page": m["page"], "download_url": m["url"], "original_px": [m["width"], m["height"]],
             "local_px": [w, h], "stored_px": stored_px, "exif_orientation": orient, "megapixels": round(w * h / 1e6, 1), "bytes": size, "sha1": digest,
             "is_original_bytes": identical, "date_original": m["date_original"], "notes": fnote}
        if role == "overview":
            f["exif"] = ovx
        elif role == "overview_alt":
            f["exif"] = alt_chk["overview"]["exif"]
        else:
            c = by_file[local]
            v = n.get("verdicts", {}).get(local, {})
            f["exif"] = c.get("exif", {})
            f["sanity"] = {k: c.get(k) for k in SANITY_KEYS}
            f["independent_capture"] = v.get("independent") or independence(c, ovx)
            f["verdict"] = auto_verdict(c) + ("; " + v["note"] if v.get("note") else "")
            rows.append(sanity_row(local, c, f["independent_capture"], f["verdict"]))
            if alt:
                ca = alt_by_file[local]
                f["sanity_vs_overview_alt"] = {k: ca.get(k) for k in SANITY_KEYS}
                alt_rows.append(sanity_row(local, ca, independence(ca, alt_chk["overview"]["exif"]), auto_verdict(ca)))
        entry["files"].append(f)
        md.append("| `%s` | %s | %s | %s | %s | %dx%d (%.1f MP) | %s |" % (
            local, title.replace("File:", "").replace("|", "/"), m["author"] or m["uploader"], m["license"],
            m["page"], w, h, w * h / 1e6, (fnote + ("" if identical else " (NOT original bytes)") + (
                "" if orient == 1 else " [EXIF Orientation=%d: pixels stored as %dx%d]" % (orient, stored_px[0], stored_px[1]))).strip()))
    md += ["", "Sanity check vs `%s` (overview EXIF: %s). Scale = close-up px per overview px at the close-up centre, original pixel units." % (
        chk["overview"]["file"], fmt_exif(ovx)), ""] + HDR + rows + [""]
    if alt:
        md += ["Same close-ups vs `%s` (EXIF: %s). %s" % (alt["file"], fmt_exif(alt_chk["overview"]["exif"]), alt["text"]),
               ""] + HDR + alt_rows + [""]
    regs = [f for f in entry["files"] if f["role"] == "closeup"]
    ok = [f for f in regs if f["sanity"]["registers"]]
    sc = [f["sanity"]["scale_factor"] for f in ok]
    entry["summary"] = {"closeups": len(regs), "registering": len(ok),
                        "scale_factor_min": min(sc) if sc else None, "scale_factor_max": max(sc) if sc else None,
                        "inliers_min": min(f["sanity"]["inliers"] for f in ok) if ok else None,
                        "inliers_max": max(f["sanity"]["inliers"] for f in ok) if ok else None}
    md += ["Summary: %d/%d close-ups register with the baseline; scale factors %s; inliers %s." % (
        len(ok), len(regs), ("%.2f-%.2f" % (min(sc), max(sc))) if sc else "-",
        ("%d-%d" % (entry["summary"]["inliers_min"], entry["summary"]["inliers_max"])) if ok else "-"),
        "Footprint visualisation: `datasets/tools/out/%s_footprints.jpg`." % sname, ""]
    out["sets"].append(entry)

out["total_bytes"] = total_bytes
md += ["## Totals", "", "%d files, %.1f MB (%.1f MiB)." % (
    sum(len(s["files"]) for s in out["sets"]), total_bytes / 1e6, total_bytes / 2.0 ** 20), ""]
for key, title in (("general_caveats", "General caveats"), ("rejected", "Candidates considered but not delivered"),
                   ("unverified", "Not verified")):
    if notes.get(key):
        md += ["## " + title, ""] + ["- " + r for r in notes[key]] + [""]
        out[key] = notes[key]
json.dump(out, open(os.path.join(real, "sources.json"), "w", encoding="utf-8"), indent=1, ensure_ascii=False)
open(os.path.join(real, "SOURCES.md"), "w", encoding="utf-8").write("\n".join(md))
print("wrote sources.json and SOURCES.md; total %.1f MB" % (total_bytes / 1e6))
