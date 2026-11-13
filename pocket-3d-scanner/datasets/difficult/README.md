# difficult — NAVI `tumbler_air_balloon` (glossy, low-texture plastic travel tumbler)

| | |
|---|---|
| Category | `difficult` — glossy / low-texture object expected to **partly fail** photogrammetry (honest-limitations case); it also has a scanner reference, so the failure can be measured |
| Object | Double-walled plastic travel tumbler, 159 mm tall, 79 mm diameter: glossy, slightly translucent white sleeve with a sparse printed hot-air-balloon motif and a uniformly blue, glossy screw lid; standing on grey office carpet |
| Images | 20 JPEG, 4080 x 3072 (`images/000.jpg` … `019.jpg`, NAVI names kept) |
| Camera | Google Pixel 6 Pro main camera, 6.81 mm (24 mm equiv.), f/1.85; full EXIF, orientation = normal |
| Source | NAVI v1.0, `navi_v1.0/tumbler_air_balloon/multiview-02-pixel_6pro/` inside https://storage.googleapis.com/gresearch/navi-dataset/navi_v1.0.tar.gz — https://navidataset.github.io/ , https://github.com/google/navi |
| Authors | Jampani, Maninis, Engelhardt, et al. (Google), NeurIPS 2023 |
| License | **CC-BY** (dataset, per the NAVI paper) / Apache-2.0 text on the project page — permissive, see `LICENSE.source.txt` |
| Reference | **Yes**: 3D scan (mm) + per-image ground-truth camera poses + GT masks and depth maps |
| Size | 67 MB (images 31 MB, scan 30 MB) |

## Why it fits
Real phone photographs, camera moves around the stationary object (two passes around it at 0.23–0.29 m).
The carpet is richly textured, so camera registration should succeed, while the object itself is the hard part:
large untextured white areas, specular highlights that move with the viewpoint, a featureless saturated-blue lid,
and a partly see-through double wall. Expect holes/noise on the lid and the blank parts of the sleeve and good
geometry only where the balloon print is. That contrast (poses fine, surface poor) is what this set demonstrates.

## Reference data (`reference/`)
Same formats and conventions as `../groundtruth/README.md` (verified here too with
`_scripts/navi_verify_alignment.py`: 99.4 % of projected scan vertices fall on the mask in every image with the
OpenCV convention; depth agreement ~0.1 mm):
* `3d_scan/tumbler_air_balloon.obj` — scanner mesh, 374,993 vertices, **no texture / no .mtl**, units **mm**,
  centred at the origin. Bounding box ±(39.34, 79.40, 38.97) mm → 78.7 x 158.8 x 77.9 mm (+y is the tumbler axis).
* `annotations.json` — 20 entries; `x_cam = R(q)·x_scan + t` (q = `[qw,qx,qy,qz]`, t in mm), OpenCV camera axes,
  `focal_length` = 2720.0 px (nominal: 24 mm-equivalent on 4080 px), principal point at the image centre,
  `image_size` `[3072, 4080]`.
* `masks/NNN.png`, `depth/NNN.png` — as in `groundtruth`.
Alignment recipe: identical to `groundtruth` (Sim(3) from reconstructed to GT camera centres, crop to the scan
bounding box, optional ICP, distances in mm).

## Caveats
* **Only 20 images** (below the 25–80 target): NAVI's phone scenes of this object have 16–20 views each and
  cannot be merged (the object is re-posed and re-located between scenes). It is a realistic "casual user"
  capture.
* `capture_order.txt` gives the original capture order (two arcs with a 98° jump between captures 9 and 10;
  other steps 8–40°). Use exhaustive matching.
* The scan was presumably taken with the lid on, as photographed; a glossy object like this is usually matted
  for scanning, so the scan is the geometric truth but says nothing about appearance.
* How badly it fails depends on the pipeline; no reconstruction was run by us on this set.

## Files
`images/` (20), `reference/` (annotations, 3d_scan, masks, depth), `capture_order.txt`, `upstream/`,
`navi_members.tsv`, `urls.tsv`, `SHA256SUMS`, `LICENSE.source.txt`.
