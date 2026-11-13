# Measured results

Everything here was produced by the shipped pipeline on real photographs and can be reproduced:

```sh
datasets/fetch.sh                                   # download the photo sets (checksums verified)
tools/run_benchmarks.sh                             # runs every dataset in the companion image
tools/render_all.sh                                 # independent renders → results/_renders/
tools/.venv/bin/python tools/evaluate_against_scan.py --job results/groundtruth_standard \
      --dataset datasets/groundtruth --out results/_evaluation/groundtruth_standard_vs_scan.json
python3 tools/summarize_results.py                  # → results/SUMMARY.md (all tables, generated)
```

Per run, `results/<run>/` keeps the inputs' manifest and settings (`job.json`), the event stream
(`events.jsonl`), tool logs, `diagnostics.json`, `cameras.json`, `sparse_preview.json` and the
model (`model.glb`). `results/SUMMARY.md` is generated from those files; the numbers below are
copied from it.

**Hardware**: Intel Core i7-14700K (20 cores / 28 threads), 32 GB RAM, Linux 7.3, container
`pocket3d-companion:1.0` (Ubuntu 24.04, COLMAP 4.2.1 via pycolmap, OpenMVS 2.3.0). **CPU only** —
the machine's GPU (Intel Arc B580) is not used by any stage. Threads and memory were limited as
stated per run. "Peak RSS" is the resident memory of the whole reconstruction process tree.

## 1. Cost and output per dataset (8 threads, 5 GB memory budget)

| Dataset (object) | Preset | Photos → registered | Time | Peak RSS | Dense points | Triangles | Texture | GLB |
|---|---|---|---|---|---|---|---|---|
| `textured` — plaster Buddha head, 2736×1540 | Preview | 67 → 67 | 3 min 11 s | 2.6 GB | 2.03 M | 60 k | 3 × 2048² | 5.1 MB |
| `textured` | Standard | 67 → 67 | 7 min 30 s | 3.7 GB | 2.54 M | 200 k | 2 × 4096² | 13.2 MB |
| `textured` (4 threads / 3 GB) | Standard | 67 → 67 | 6 min 36 s | 2.4 GB | 1.26 M | 200 k | 2 × 4096² | 13.1 MB |
| `groundtruth` — Triceratops toy, 5184×3456 | Standard | 50 → 50 | 3 min 05 s | 2.6 GB | 0.68 M | 200 k | 4096² | 9.3 MB |
| `groundtruth` | High (refined) | 50 → 49 | 6 min 30 s | 4.1 GB | 0.72 M | 400 k | 4096² + 1024² | 18.2 MB |
| `concave` — marble well-head, 4928×3264 | Standard | 72 → 72 | 6 min 46 s | 4.8 GB | 2.94 M | 200 k | 3 × 4096² + 2048² | 20.3 MB |
| `difficult` — glossy plastic tumbler, 4080×3072 | Standard | 20 → 20 | 4 min 29 s | 3.5 GB | 2.79 M | 200 k | 4096² | 8.5 MB |
| `smoke` — 12 downscaled photos of the toy | Preview | 12 → 8 | 16 s | 1.6 GB | 0.10 M | 41 k | 1024² | 1.6 MB |

Notes

* These are the runs of the delivered pipeline version (image `pocket3d-companion:1.0` as
  shipped). The workstation was shared with other work while they ran; `results/<run>/host_load.json`
  and the "Host load" table in `results/SUMMARY.md` record the load average around every run
  (5–12 on 28 hardware threads, most of it the run itself). Expect ±20 % on the times. The
  4-thread / 3 GB run is not slower than the 8-thread one because its smaller memory budget
  forces smaller depth maps (624 px instead of 896 px), i.e. less work and less detail.
* With a 5 GB budget the pipeline lowered the depth-map size on five runs (warning
  `reduced_dense_resolution`: 624–976 px instead of 1200/2000 px) and ran the High preset's
  refinement on quarter-size photos (`reduced_refine_resolution`). Every run stayed inside its
  budget (largest: 4.8 of 5.0 GB in the meshing stage of the well-head). The meshing budget is
  deliberately conservative — 1.25 GB per million dense points, the worst value measured plus
  a margin — because the companion kills a job that exceeds its limit; an earlier, tighter
  model let the same dataset reach 5.4 GB.
* Earlier measurements are kept for comparison and are labelled as such in `results/SUMMARY.md`:
  `results/_archive_14t10g` (14 threads / 10 GB, full preset resolution: 3–9 minutes,
  5.0–6.9 GB peak) and `results/_archive_refine_half_size` (High with half-size refinement
  peaking at 5.8 GB — the measurement that made refinement adapt to the limit). Both come from
  earlier pipeline versions and were not regenerated.
* Stage shares at Standard: dense depth maps 40–55 %, meshing 5–20 %, features + matching 15–30 %,
  everything else a few percent (`results/SUMMARY.md`, "Time / peak memory per stage").
* All eight GLBs pass the Khronos glTF-Validator with 0 errors, 0 warnings
  (`results/_evaluation/gltf-validator.jsonl`).

## 2. Geometric accuracy where a reference exists

Reprojection error (0.3–1.1 px here) only says that the camera solution is self-consistent. The
following compares the delivered surface with an independent **structured-light scan**.

Procedure (`tools/evaluate_against_scan.py`, documented in its header):

1. One similarity transform — rotation, translation and a single scale — from the reconstructed
   camera centres to the dataset's ground-truth camera centres. The surface is never used for
   this alignment or its scale ("cameras only").
2. Crop to the scan's bounding box + 6 mm (the scan contains only the object).
3. Report three alignments: cameras only; after a rigid ICP (no scale) that removes residual
   pose error from the dataset's nominal intrinsics; and after a similarity ICP that may also
   change one scale factor — "shape only", i.e. what remains after a known-distance calibration.
4. Report three definitions of "the surface": everything reconstructed inside the scan box;
   **the object as defined by the dataset's ground-truth silhouettes** (a reconstructed point
   counts if it projects inside the object mask in the reference views — independent of how
   close it is to the scan); and, for comparison, the surface within 5 mm of the scan (which
   excludes gross errors by construction and is therefore not a fair accuracy figure).

Accuracy = reconstruction → scan distance, completeness = scan → reconstruction distance, over
200 000 area-weighted samples each. Full tables: `results/SUMMARY.md`; raw numbers:
`results/_evaluation/*_vs_scan.json`.

### Triceratops toy (224 × 110 × 87 mm), 50 photos — `groundtruth`

| | Standard | High (refined at ¼-size photos) |
|---|---|---|
| Accuracy of the object (silhouette-defined), cameras only: median / RMS / p95; within 2 mm | 0.30 / 0.62 / 1.23 mm; 98 % | 0.30 / 0.69 / 1.40 mm; 98 % |
| Same, shape only (one extra scale factor ×0.991 / ×0.993): median / p95 | 0.19 / 1.00 mm | 0.20 / 1.08 mm |
| Accuracy of all reconstructed surface in the scan box (after ICP): median / RMS / p95 | 0.53 / 11.5 / 29.1 mm | 0.47 / 11.4 / 28.6 mm |
| Share of that surface farther than 5 mm from the scan | 21 % | 20 % |
| Completeness (after ICP): median; scan surface with a reconstruction within 2 mm | 0.45 mm; 88 % | 0.39 mm; 90 % |
| ICP correction after camera-based alignment | 0.5 mm, 0.3° | 1.0 mm, 0.2° |
| Object dimensions with the scale from camera poses (silhouette-defined extents) | −0.4 % / −3.4 % / −0.4 % | −0.5 % / −3.3 % / −0.4 % |

How to read this honestly:

* **About a fifth of the reconstructed surface inside the scan's bounding box is not the
  toy**: the toy stands on a tablet-holder plate with clamps, which is real, reconstructed
  geometry that the scan does not contain (visible in `results/_renders/groundtruth_standard_sheet.jpg`).
  That is why the all-surface RMS / p95 are large. The pipeline's geometric object separation
  cannot split a toy from the stand it touches — the suggested crop still contains part of the
  plate; removing it is a manual edit on the phone.
* The silhouette-defined rows are the fair description of the surface that *is* the toy:
  sub-millimetre, 98 % within 2 mm. They say nothing about the stand parts that an unedited
  model still contains.
* The ~10–12 % of the scan with no reconstruction within 2 mm is mainly the underside and the
  contact areas, which no photo shows; they are left open as holes.
* Dimension check with one known distance (the app's calibration method), longest dimension
  224.3 mm as the reference: the 87.2 mm dimension measures 87.2 mm (0.0 %); the 110.3 mm
  dimension measures 107.0 mm (−3.0 %). The cause of that 3 % was not isolated; the likely one
  is surface missing at the extremes of that axis (contact with the stand, thin horn tips),
  which shortens a bounding-box extent. The independent reviewer's own mask-based measurement
  of an earlier run gave +2.4 / −1.1 / +1.0 %. Read these as "dimensions good to a few percent",
  not better: bounding-box sizes are only as good as the model's completeness.
* **High is only marginally better than Standard here** (same median, slightly better
  completeness) for about twice the time, and it failed to register one photo that Standard
  registered. Standard is the default for that reason.

### Glossy tumbler (159 mm tall, Ø 78 mm), 20 photos — `difficult`

| | Standard |
|---|---|
| Registered cameras | 20 / 20, mean reprojection error **1.10 px** |
| Scale from the dataset's camera positions vs. scale that best fits the scan | off by **11 %** (×1.110) |
| With camera-derived scale: accuracy median / completeness within 2 mm | 4.2 mm / 19 % |
| Dimensions with camera-derived scale (silhouette-defined) | −8.2 % / −7.8 % / −7.4 % (uniformly too small, not distorted) |
| **Shape only** (one extra scale factor, as after a known-distance calibration), object defined by silhouettes: median / RMS / p95; within 2 mm | 0.43 / 0.88 / 1.94 mm; 95 % |
| Shape only, all surface in the scan box: median / RMS / p95 | 0.60 / 8.0 / 21.4 mm (carpet at the base, artefacts at the lid) |
| Shape only, completeness: scan surface with a reconstruction within 2 mm | 75 % |
| After calibrating on the 158.8 mm height: the two diameters (78.7 / 77.9 mm) | 78.2 mm (−0.5 %) / 78.2 mm (+0.4 %) |
| Solved focal length vs. EXIF prior | +5.8 % (vs. the dataset's nominal focal length: +10 %) |
| Pipeline's own verdict | 88 % "well supported", 23 open boundary loops |
| Warnings raised | `focal_length_drift`, `few_photos`, `inconsistent_camera_solution`, `coverage_gap` (77° without photos) |

What this case shows, after the independent reviewer's cross-check corrected our first reading
(`docs/review/round1/evidence/models/tumbler_scale_crosscheck.json`):

* **The shape is mostly right; the camera-derived size is not.** With only 20 photos of a small
  object, focal length and camera distance are nearly interchangeable in bundle adjustment. The
  solver drifted 6–10 % in focal length, which moves every camera farther away without hurting
  the fit. Aligning by camera positions then makes the object ~8 % too small in every
  dimension, which is what our first evaluation reported as "several millimetres wrong
  everywhere". Scaled by a single known distance — the app's calibration method — the same
  model is within 0.4 mm median of the scan and its diameters are right to half a percent.
* **Consequence for AR-derived scale**: a scale taken from camera positions inherits this
  ambiguity. The pipeline therefore (a) keeps device-calibrated focal lengths (ARCore/Camera2)
  fixed instead of refining them, (b) adds a focal-length term to the AR scale uncertainty
  (≥ 3 % with a metadata prior, the measured drift if larger, 8 % without any prior), and (c)
  raises `focal_length_drift` when the solved focal length is more than 5 % from the metadata
  — it does on this dataset. This logic is unit-tested with synthetic poses only; no real AR
  capture was available.
* **Real defects remain**: a quarter of the true surface has no reconstruction within 2 mm —
  a band of the glossy side wall where there were no photos (the 77° gap) and the bottom;
  the lid's glossy top is noisy; texture patches come from mismatched views
  (`results/_renders/difficult_standard_sheet.jpg`).
* **Evidence values are not an accuracy measure.** 88 % of the surface counts as "well
  supported" — photos agree about it — which is compatible with a wrong overall size. The
  evidence overlay marks the patchy regions; size errors can only be caught by calibration.

### Marble well-head (documented Ø 84 cm, height 81.9 cm), 72 photos — `concave`

No scan exists, only catalogue dimensions; the model has arbitrary units, so only the ratio
can be checked: reconstructed diameter / height = 1.042 vs. 1.026 documented (+1.6 %,
`tools/wellhead_ratio.py`, `results/_evaluation/concave_standard_ratio_check.json`). The
measurement definition (which mouldings count, where the base meets the plinth) is ambiguous
at a few percent — an earlier run of the same data gave +3.8 % — so this is a plausibility
check, not an accuracy figure. Qualitatively: the inside of the shaft — the concavity — is
reconstructed down to where the photos could see; 95 % of the object region is well supported;
two focal lengths (22 mm and 18 mm) were calibrated as separate cameras. The suggested crop
includes plinth and floor and is flagged `uncertain` (no support plane was found).

### Plaster head — `textured`

No reference geometry. 67/67 cameras, more than 99.9 % of the object region well supported, 1–3
open boundary loops (the base; edges created by the crop cut are not counted), viewpoints in
all 12 sectors. Visual check against the photographs:
`results/_renders/textured_standard_sheet.jpg`.

## 3. Phone ⇄ companion measurements

* Real HTTPS run of the independent client (`tools/e2e_companion_http.py`, transcript in
  `results/_companion_http/transcript.json`): pairing, 12-photo resumable upload (with an
  injected interruption and a wrong-offset and a corrupted-bytes attempt), reconstruction,
  Range-resumed verified download: **15.4 s** wall time, of which 14.8 s is reconstruction.
* The Android data layer (pinned-TLS client, sync engine, store) against the same live
  companion (`LiveCompanionTest`, output in `results/_phone_data_layer_live/`): 12 photos →
  COMPLETED with a verified 41 k-triangle model in ≈ 20–30 s, stages reported:
  features, matching, sfm, undistort, dense, mesh, texture, package; sparse preview available
  while running.
* Emulator walkthrough (Pixel 6 profile, API 36, software GPU): the same flow driven through
  the UI, screenshots and the exported, independently validated GLB in
  `results/_emulator_walkthrough/`.

## 4. What these numbers do not show

* No measurement was made on a physical phone: capture guidance quality, AR tracking, AR-derived
  scale and AR placement stability are unmeasured.
* On-device rendering/edit performance was only observed on the emulator's software GPU, which
  says little about real phones.
* Four objects are not a benchmark suite; the accuracy figures describe these captures, taken by
  others with good cameras, not what a hand-held phone capture will achieve.
