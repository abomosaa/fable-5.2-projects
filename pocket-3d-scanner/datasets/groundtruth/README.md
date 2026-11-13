# groundtruth — NAVI `dino_5` (toy Triceratops) with a metric 3D-scanner reference

| | |
|---|---|
| Category | reference / accuracy dataset (the object itself is a **textured, irregular** shape that photogrammetry should handle) |
| Object | Hard-plastic Triceratops toy figure, ~224 x 110 x 87 mm, matte painted skin with fine scale relief, horns/frill/tail/legs; it stands on a black tablet-holder plate on a gooseneck stand in a meeting room |
| Images | 50 JPEG, 5184 x 3456 (`images/000.jpg` … `049.jpg`, NAVI names kept) |
| Camera | Canon EOS REBEL T4i, EF-S 18–55 mm at 30 mm, f/9, 1/40 s, ISO 3200; full EXIF, no orientation tag |
| Source | NAVI v1.0, `navi_v1.0/dino_5/multiview-13-canon_t4i/` inside https://storage.googleapis.com/gresearch/navi-dataset/navi_v1.0.tar.gz — https://navidataset.github.io/ , https://github.com/google/navi |
| Authors | Jampani, Maninis, Engelhardt, et al. (Google), NeurIPS 2023 |
| License | **CC-BY** (dataset, per the NAVI paper) / Apache-2.0 text on the project page — permissive, see `LICENSE.source.txt` |
| Reference | **Yes**: structured-light 3D scan (mm) + per-image ground-truth camera poses + GT masks and depth maps |
| Size | 252 MB (images 46 MB, scan 182 MB, depth 23 MB) |

## Why it fits
Real photographs ("Multiview image collections capture the same object in the same environment and pose by
moving the cameras" — NAVI README). 50 views cover the full upper hemisphere at 0.41–0.60 m distance. The object
was scanned with a professional structured-light scanner and every photo was aligned to the scan, so a
reconstruction can be compared against the scan in millimetres.

## Reference data (`reference/`)
| File | What it is |
|---|---|
| `3d_scan/dino_5.obj` (+ `.mtl`, `.jpg`) | Scanner mesh, 1,243,754 vertices, textured. **Units: millimetres**, centred at the origin, not normalised. Bounding box ±(43.61, 55.16, 112.17) mm → 87.2 x 110.3 x 224.3 mm. NAVI paper §2.1: scans were made with "EinScan-SP and EinScan Pro HD"; "We center the scans at origin, but do not normalize the shapes to preserve their metric dimensions (in mm)". |
| `annotations.json` | List of 50 entries: `filename`, `filename_original` (camera file name = capture order), `image_size` `[h, w]`, `camera.q` `[qw, qx, qy, qz]`, `camera.t` `[tx, ty, tz]`, `camera.focal_length` (px), `split`, `occluded`. |
| `masks/NNN.png` | Object silhouette rendered from the aligned scan (8-bit, non-zero = object), same size as the image. |
| `depth/NNN.png` | Depth of the aligned scan from the camera, uint16. Decode as in NAVI `data_util.decode_depth`: `disp = png / (65535 * 10)`; `depth_mm = 1 / disp`; 0 = background. |

### Coordinate conventions (verified empirically here with `_scripts/navi_verify_alignment.py`)
* `x_cam = R(q) · x_scan + t`, with `R(q)` the standard Hamilton rotation matrix of the unit quaternion
  `[qw, qx, qy, qz]` and `t` in **mm**. Camera centre in the scan frame: `C = −R(q)ᵀ t`.
* Camera frame is **OpenCV / COLMAP style**: +x right, +y down, +z forward.
  `u = f·x/z + w/2`, `v = f·y/z + h/2` (principal point at the image centre, square pixels, no distortion).
* Check performed: projecting 20k scan vertices with this convention puts 99.5 % of them on the shipped mask in
  every one of the 50 images (0 % with the OpenGL −z convention), and `z` agrees with the decoded depth map to
  ~0.3 mm.
* `focal_length` = 6950.62 px for all images. This is the **nominal EXIF value** (30 mm on a 22.3 mm-wide
  sensor), not a calibrated one, and there are no distortion coefficients. The poses come from NAVI's manual
  2D–3D alignment + verification, so treat them as accurate to roughly the millimetre/pixel level, not as
  survey-grade calibration.

### How to align a reconstruction to the scan
1. Run SfM. For every registered image take the reconstructed camera centre `C_rec` and the ground-truth centre
   `C_gt = −R(q)ᵀ t` (mm, scan frame).
2. Estimate the similarity transform (Umeyama, scale + rotation + translation) `C_rec → C_gt` and apply it to the
   reconstructed point cloud / mesh. The scale factor is also your metric-scale check.
3. Crop to the object (the scan contains **only the toy**, not the stand or room): keep geometry inside the scan
   bounding box plus a few mm, or use `masks/`.
4. Optionally refine with ICP against the scan (recommended, because of the nominal intrinsics), then report
   cloud-to-mesh distances in mm (accuracy) and scan-to-reconstruction distances (completeness).
5. Image-space alternative: compare your per-view depth with `depth/NNN.png` inside `masks/NNN.png`.

## Caveats
* `images/000…049` are in NAVI's shuffled order. `capture_order.txt` (derived by us with
  `_scripts/navi_capture_order.py`) lists them in original capture order (IMG_3412 … IMG_3463): consecutive
  captures are 6–32° apart (two 79° jumps at the very end). Thinning by "every Nth NAVI index" gives a
  wide-baseline set — an every-5th subset registered only 2 of 10 images in a quick COLMAP check.
* 7 images are flagged `occluded: true` (003, 014, 017, 018, 042, 043, 047 — the holder's clamps hide part of
  the feet/tail).
* JPEGs are strongly compressed (~0.9 MB at 18 MP), ISO 3200; the room background is mostly blank walls with
  shallow depth of field, so features come mainly from the toy, the holder and the carpet.
* The underside/feet contact area is not observed; the scan includes it.
* Upstream `.glb` duplicate of the scan and the other 16 scenes of this object were not extracted.

## Files
`images/` (50), `reference/` (annotations, 3d_scan, masks, depth), `capture_order.txt`, `upstream/` (license
texts, NAVI README), `navi_members.tsv` (tar member → path map used by `fetch.sh`), `urls.tsv`, `SHA256SUMS`,
`LICENSE.source.txt`.
