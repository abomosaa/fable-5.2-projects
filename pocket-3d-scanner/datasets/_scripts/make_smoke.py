#!/usr/bin/env python3
"""Derive the `smoke` dataset from `groundtruth` (NAVI dino_5, multiview-13-canon_t4i).

Selection rule (deterministic, uses only reference/annotations.json):
  1. sort the 50 images by `filename_original` (= original camera file name,
     i.e. capture order; NAVI's 000..049 names are shuffled);
  2. take the 12 consecutive captures at 0-based capture-order positions
     START..START+11 (default START=11 -> IMG_3424..IMG_3435).
Each selected image is downscaled so that its long side is 1200 px with
ImageMagick (`magick <src> -resize 1200x1200 -quality 90 <dst>`; EXIF is kept,
no auto-orient), and named `<pos:02d>_navi<NNN>_<filename_original>.jpg`.

Also writes smoke/reference/annotations.json: the 12 ground-truth entries with
`filename`, `image_size` and `focal_length` rewritten for the resized images
(pose q/t and all other fields unchanged), plus smoke/cameras.json.

Only stdlib + the `magick` binary; run with `python3 -I`.

usage: python3 -I make_smoke.py <groundtruth_dir> <smoke_dir> [START]
"""
import json
import os
import subprocess
import sys

LONG_SIDE = 1200
COUNT = 12


def main():
    src_root, dst_root = sys.argv[1], sys.argv[2]
    start = int(sys.argv[3]) if len(sys.argv) > 3 else 11
    with open(os.path.join(src_root, "reference", "annotations.json"), encoding="utf-8") as fh:
        ann = json.load(fh)
    ann.sort(key=lambda a: a["filename_original"])
    chosen = ann[start:start + COUNT]
    os.makedirs(os.path.join(dst_root, "images"), exist_ok=True)
    os.makedirs(os.path.join(dst_root, "reference"), exist_ok=True)

    out_ann, cams = [], []
    for pos, a in enumerate(chosen):
        name = a["filename"]
        if "/" in name or ".." in name:
            raise SystemExit(f"suspicious filename {name!r}")
        h, w = a["image_size"]
        scale = LONG_SIDE / max(h, w)
        nh, nw = round(h * scale), round(w * scale)
        new_name = f"{pos:02d}_navi{os.path.splitext(name)[0]}_{a['filename_original']}.jpg"
        src = os.path.join(src_root, "images", name)
        dst = os.path.join(dst_root, "images", new_name)
        subprocess.run(["magick", src, "-resize", f"{LONG_SIDE}x{LONG_SIDE}", "-quality", "90", dst],
                       check=True)
        b = json.loads(json.dumps(a))
        b["filename"] = new_name
        b["source_filename"] = name
        b["image_size"] = [nh, nw]
        b["camera"]["focal_length"] = a["camera"]["focal_length"] * scale
        out_ann.append(b)
        cams.append({"filename": new_name, "source": f"groundtruth/images/{name}",
                     "filename_original": a["filename_original"],
                     "width": nw, "height": nh,
                     "focal_length_px": a["camera"]["focal_length"] * scale,
                     "cx": nw / 2.0, "cy": nh / 2.0})
    with open(os.path.join(dst_root, "reference", "annotations.json"), "w", encoding="utf-8") as fh:
        json.dump(out_ann, fh, indent=1)
        fh.write("\n")
    with open(os.path.join(dst_root, "cameras.json"), "w", encoding="utf-8") as fh:
        json.dump({"note": "nominal pinhole intrinsics (NAVI annotation focal length scaled to the "
                           "resized image; principal point at image centre; no distortion model)",
                   "resize_long_side_px": LONG_SIDE, "images": cams}, fh, indent=1)
        fh.write("\n")
    print(f"smoke: wrote {len(chosen)} images to {os.path.join(dst_root, 'images')}")


if __name__ == "__main__":
    main()
