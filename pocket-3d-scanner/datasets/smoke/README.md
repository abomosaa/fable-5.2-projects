# smoke — 12 small images for a fast end-to-end test (derived from `groundtruth`)

| | |
|---|---|
| Category | `smoke` — fast pipeline test; inherits the metric reference of `groundtruth` |
| Object | NAVI `dino_5` Triceratops toy (224 x 110 x 87 mm) on a tablet-holder stand — see `../groundtruth/README.md` |
| Images | 12 JPEG, **1200 x 800** (downscaled from 5184 x 3456), 1.2 MB in total |
| Camera | Canon EOS REBEL T4i, 30 mm; EXIF block carried over from the originals (see caveat) |
| Source / license | NAVI v1.0 (Google) — CC-BY per paper / Apache-2.0 on project page; **modified** copies, see `LICENSE.source.txt` |
| Reference | `reference/annotations.json` (GT poses for these 12 images); scan in `../groundtruth/reference/3d_scan/dino_5.obj` (mm) |

## Exact derivation (reproducible: `python3 -I _scripts/make_smoke.py groundtruth smoke 11`)
1. Sort the 50 entries of `groundtruth/reference/annotations.json` by `filename_original` (the camera's own file
   names = capture order; NAVI's `000…049` names are shuffled).
2. Take the **12 consecutive captures at 0-based positions 11…22** of that order: IMG_3424 … IMG_3435
   = NAVI files 031, 039, 030, 041, 016, 033, 015, 026, 019, 005, 048, 045. Consecutive views are 7.7–19.9° apart
   (150° of arc in total, 0.46–0.58 m from the object); none is flagged `occluded`.
3. Each file: `magick groundtruth/images/NNN.jpg -resize 1200x1200 -quality 90 smoke/images/<pos>_navi<NNN>_<IMG_xxxx>.jpg`
   (ImageMagick 7.1.2-35 Q16-HDRI; no auto-orient; metadata kept). File names sort in capture order, so
   sequential matching also works.

Why not "every Nth image": NAVI's file order is shuffled, and an every-5th subset of the 50 images is a
wide-baseline set that registered only 2 of 10 images in a quick COLMAP check. A run of consecutive captures has
the overlap a tiny set needs.

## Intrinsics / EXIF
* `cameras.json` — nominal pinhole intrinsics for the resized files: `focal_length_px = 1608.94`
  (= 6950.62 x 1200/5184), `cx = 600`, `cy = 400`, no distortion model.
* EXIF kept: Make/Model (Canon EOS REBEL T4i), FocalLength 30 mm, lens model, exposure. **Stale tags:**
  `PixelXDimension/PixelYDimension` and `FocalPlaneX/YResolution` still describe the 5184 x 3456 original. Tools
  that derive the focal length from sensor width (COLMAP's camera database: 22.3 mm) are fine; tools that use
  FocalPlaneResolution will be off by 4.32x — prefer `cameras.json`.
* `reference/annotations.json` — the 12 NAVI ground-truth entries with `filename`, `image_size` (`[800, 1200]`)
  and `focal_length` rewritten for the resized images, plus `source_filename`; `q`, `t` (mm) unchanged. Same
  conventions as `../groundtruth/README.md` (`x_cam = R(q)·x_scan + t`, OpenCV axes).

## What to expect / caveats
* The 12 views cover only ~150° of the orbit, so a correct result is a **one-sided partial model** of the toy
  plus the holder plate — this set is for "does the pipeline run end to end", not for quality numbers.
* A metric sanity check is possible: after Sim(3)-aligning reconstructed to GT camera centres the toy should be
  ~224 mm long.
* **Not validated by an actual reconstruction run on our side** (SfM was out of scope/resources for the
  download task). The toy fills only ~25–35 % of the frame width at this resolution and the background is
  mostly blank wall, so if registration turns out to be flaky, use `../smoke_alt/` (frame-filling, richly
  textured object) or re-derive at a larger size (change `LONG_SIDE` in `_scripts/make_smoke.py`).
* Small enough (1.2 MB) to commit to the repository so the smoke test needs no network; license is permissive.
  `fetch.sh` re-derives it only if `smoke/images/` is missing; byte-identical output needs the same ImageMagick
  build (otherwise `fetch.sh` reports a checksum *warning* for this set).

## Files
`images/` (12), `cameras.json`, `reference/annotations.json`, `SHA256SUMS`, `LICENSE.source.txt`.
