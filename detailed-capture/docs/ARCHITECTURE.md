# Architecture and numerical limitations

Detailed Capture is a native Android app (Kotlin, Jetpack Compose, CameraX) on top of a C++17 image-processing core
(`core/`, OpenCV 4.12). The same core is compiled for the phone (NDK, `libdcjni.so`) and for Linux (`dcap` CLI,
`dcore_tests`), so the evaluation and the tests execute exactly the code that runs on the device.

```
android/app            Kotlin UI: projects, capture map, camera, frame inspector, manual points, tiled viewer, export
  └─ cpp/jni.cpp       one generic JNI entry point: call(command, jsonArgs) + progress polling + cancel tokens
core/                  C++ core (no Android dependencies)
  geom                 homographies, EXIF orientation transforms, radial model, transform validation
  meta, imageio        EXIF/ICC parsing, oriented decoding, colour-space conversion, streaming PNG/TIFF/JPEG writers
  features             sharpness/exposure analysis, tiled multi-level SIFT, matching, robust pair estimation
  ba                   global refinement (Levenberg–Marquardt, Huber loss, optional shared radial distortion)
  registrar            registration graph, dense refinement/verification, classification, coverage map, live locate
  compose              output grid, tone/colour matching, MRF seam selection, tiled multi-band blending, pyramid
  export               reversible edits, flat export, tile package, source inspection, measurement
  project, api         project store (single owner of project.json), undo/redo, command dispatcher
eval/                  synthetic capture simulator, pipeline runner, scoring (Python, independent of the core)
```

Everything runs on the device. There is no network code, no account, no cloud service and no generative model.

## Coordinate conventions

All stored coordinates are **continuous**: pixel `(i, j)` covers `[i, i+1) × [j, j+1)` and its centre is
`(i+0.5, j+0.5)`. Conversions to OpenCV's index convention happen only at call boundaries (`toIndexConvention`).

| space | definition |
|---|---|
| stored | raster as encoded in the file |
| oriented | after the EXIF orientation (1–8); all frame coordinates in the project are oriented, full resolution |
| canvas | the oriented overview after optional radial undistortion; unit = one overview pixel |
| output | canvas × S (S = output scale; `scaleX/scaleY` differ from S by < 1 px over the whole image because the size is integral) |
| export | output after the reversible view edits (perspective → 90° turns → straighten → crop) |

A registered frame maps `oriented frame px → undistort(k1) → H (3×3) → canvas`. The radial model is
`u = c + (p − c)(1 + k1·r²)` with `r` normalised by the half diagonal. With these conventions enlarging by S maps the
centre of pixel 0 to `0.5·S`, so pyramids, tiles, crops and exports stay registered at every level
(test `transform_composition`).

## Pipeline

1. **Input normalisation.** The original bytes are copied unchanged into `originals/`. The core parses EXIF
   (orientation, camera, lens, exposure) and ICC (classified by colourant tags as sRGB / Display P3 / Adobe RGB /
   unknown). Decoding ignores the decoder's own orientation handling and applies the orientation as an exact pixel
   permutation. Formats the core cannot decode (HEIC, WebP, TIFF, DNG) get a lossless PNG working copy made by the
   platform decoder; the original stays next to it. The overview's colour space is the working space; frames in
   another known space are converted with a matrix in linear light.
2. **Quality analysis** per frame: blur estimate on a 16×N grid (ratio of strong gradients before/after a known
   re-blur, noise-corrected, repeated on 2× and 4× reduced copies so that heavy blur is measurable), clipped
   highlights/shadows, largest blown-out blob (glare), noise.
3. **Features.** SIFT (RootSIFT descriptors) extracted in overlapping tiles on several pyramid levels with disjoint
   scale ranges, which bounds memory to ~150 MB regardless of image size (OpenCV's SIFT up-samples by 2). Overview:
   up to 40 k features at ≤ 4096 px; close-ups: up to 5 k at ≤ 2000 px.
4. **Pair estimation** (`estimatePair`): k-NN matching + ratio test → pose clustering on scale ratio and rotation
   (handles large scale gaps with low inlier ratios) → MAGSAC homography → guided matching (recovers matches the
   ratio test discarded) → least-squares polish → validation (no mirroring/folding, bounded anisotropy and
   perspective, residual, inlier spread).
   *Ambiguity test:* alternative placements are generated from near-tie matches and from the translational
   self-similarity of the destination under the footprint, then scored by the same guided matching. Comparable
   support ⇒ the placement is not unique (repeating pattern).
   *Parallax diagnostics:* matches consistent with an epipolar geometry but not with the plane are recorded.
5. **Registration graph.** Every close-up is matched to the overview (restricted to the tapped region first, when
   there is one) and to overlapping neighbours. Frames with a unique overview match are placed directly; others are
   placed through chains of neighbour edges (`H_u = H_p · H_{u→p}`) — this is what makes intermediate-distance frames
   useful. Ambiguous edges are never used for chaining. An ambiguous overview match is resolved only if one
   candidate agrees with the overview cell by cell and the other does not (a unique landmark), or by a neighbour.
   Frames without a path to the overview get **no position** (`disconnected`).
6. **Dense refinement.** Each placed frame is warped to overview resolution and block-matched against the overview
   (48 px blocks, ±12 then ±5 px search, NCC with sub-pixel peak, ambiguous peaks discarded); a homography is refit
   by MAGSAC. This corrects mild false alignments that sparse features produce on text and supplies dense,
   well-spread anchor correspondences.
7. **Global refinement.** Levenberg–Marquardt over all placed frames (8 parameters each, overview fixed as gauge)
   with Huber loss on anchor residuals (canvas px) and pair residuals (close-up px). One radial coefficient per lens
   group (same camera/lens/focal length, the overview included when it shares the optics) is solved only when the
   overlaps constrain it (≥ 3 frames, ≥ 150 pair observations) and is kept only if it lowers the robust cost by
   more than 15 % with |k1| ≤ 0.2 — "reliable calibration" in practice means self-calibration from the overlaps.
8. **Dense verification** at overview resolution: local ZNCC between the warped frame and the overview. Cells that
   disagree (or where the close-up is measurably blurrier than the overview, judged by gradient energy relative to
   local contrast) are masked; so are cells with *coherent* off-plane matches (re-checked against the refined model;
   scattered wrong matches on repeated glyphs are ignored). Median ZNCC < 0.25 rejects the frame (content mismatch),
   < 0.45 marks it uncertain.
9. **Classification** into accepted / rejected / uncertain / unprocessed with machine-readable reasons and
   plain-language messages (`reasonText`). Frames are accepted only if they are placed, verified, add detail
   (sampling × relative sharpness ≥ 1.15×), are mostly consistent, and have no unresolved conflicts.
10. **Coverage** is a raster over the overview (≤ 256×256 cells): per cell the best accepted, unmasked frame's
    `scale × min(1, σ_overview/σ_closeup)`. "Verified ≥ 1.5×" is the fraction of cells above 1.5. Gaps are connected
    low-detail regions; the suggestion marker is the point deepest inside each gap.
11. **Composition.**
    * Output scale S = upper range of the accepted frames' effective gain, bounded by settings (max scale, max MP).
    * At "seam resolution" (≤ 1.2 MP) every frame is warped, tone-matched to the overview (per-channel gain; a mild
      contrast/offset term only when large-scale tonal variation supports it, fitted on low-passed images so that
      the overview's blur is not mistaken for lower contrast) and corrected by a smooth low-frequency gain field
      (clamped), so close-ups share the overview's exposure, white balance and illumination while keeping their own
      high frequencies.
    * Source selection is a multi-label MRF solved with alpha-expansion (graph cuts): data term = loss of effective
      detail relative to the best source (dead zone 8 %), smoothness = colour disagreement along the seam. The
      overview is the fallback label everywhere; masked cells are invalid. User overrides bias the data term.
    * Rendering is tiled: 1024 px blocks (512 on low-memory devices) with a 96 px margin, aligned to 16 px. Each
      source is resampled **once** (Lanczos-4 for close-ups, bicubic for the overview) directly from the original
      pixels into the output grid, then blended with a 5-band Laplacian pyramid using hard masks at the finest band,
      so high-frequency detail comes from exactly one photograph (no ghosting, no averaging of sharp and blurry
      frames). Different block layouts produce identical pixels (test `tile_boundaries`).
    * Per tile the contributing frames and their area fractions are recorded (provenance), the label map and the
      detail map are stored at seam resolution.
    * Tiles are lossless PNG in Deep Zoom layout; lower levels are 2×2 area averages.
    * The run directory is `results/<run>.tmp` with a persisted plan and a block journal: a cancelled or killed run
      resumes without redoing finished blocks and yields bit-identical output (test `cancel_restart_resume`).
      Commit is a directory rename followed by an atomic project update; the previous result is deleted only
      afterwards. Blocks whose inputs are unchanged are hard-linked from the previous result (incremental recompute).
12. **Viewing and export.** The viewer draws pyramid tiles under the edit transform supplied by the core, so the
    preview and the export use the same matrix and colour maths. Flat exports are streamed row by row (bounded
    memory). 90° turns and crops are exact pixel copies; straightening and perspective resample once (Lanczos-4).

## What is deliberately not done

* No generative model, no super-resolution network, no deconvolution, no sharpening, no texture synthesis.
* No averaging of overlapping frames (it would trade real detail for noise reduction and risks ghosting).
* No geometry-aware (3-D) mode. Non-planar content is detected and masked/rejected, not "solved".

## Numerical and practical limits

| item | limit / behaviour |
|---|---|
| Scale gap per step | Direct overview matching depends on texture. In the evaluation sets it succeeded up to ≈ 6.5× on the synthetic text set and up to ≈ 11× on the real mosaic set (with few matches); on dense text most 3× frames needed a neighbour chain, and a 14× frame could only be chained and stayed *uncertain*. Plan for 2–4× per step and use intermediate frames beyond that. Chains accumulate no visible drift because every placed frame is re-anchored densely to the overview. |
| Absolute placement | Anchored to the overview, so limited by overview resolution: ≈ 0.02–0.1 overview px in the synthetic tests, i.e. 0.1–0.5 output px at 3–6×. Relative (seam) alignment between neighbours is measured separately (EVALUATION.md). |
| Planarity detection | Works on a 16×N cell grid per photo at overview resolution (ZNCC, one-sided structure, brightness difference > 30 grey levels, coherent off-plane matches). Displaced content smaller than a cell, or with too little contrast against what the overview shows there, is not detected. The evaluation's "structural agreement with the overview" table quantifies what remains. |
| Acceptance tolerance | A frame is accepted up to 1.5 overview px RMS anchor residual and 6 close-up px RMS pair residual; beyond that it is "uncertain: high_residual" and not composited unless the user forces it. |
| Planarity | One homography per frame. Relief, curvature, parallax ⇒ masked cells, `parallax`/`inconsistent` verdicts. Slight page curl may pass verification but shows as residuals of a few pixels. |
| Lens distortion | One radial term per lens group, estimated from overlaps. Strong fisheye or decentring is not modelled. Phone JPEGs are normally already corrected. |
| Blur estimate | Edge-based; meaningful between ~0.5 and ~12 px. Texture-free cells are not measurable and inherit the frame median. The detail estimate is relative to the overview's own measured sharpness. |
| Detail estimate | `estimatedDetailMP` is an estimate from sampling density and measured blur, not a measurement of the subject. |
| Bit depth / colour | 8 bits per channel throughout. 16-bit sources are reduced to 8 bits. Working space = overview's; its ICC profile is passed through to exports. Unknown profiles are used as-is with a warning. |
| Tone matching | Global gain (+ contrast within ±10 %) + smooth gain field (±25–33 %). Local lighting differences beyond that (hard shadows, glare) remain; glare cells typically fail verification and are masked. |
| Sizes | Sources up to 110 MP each; ≤ 250 accepted frames per fusion; output bounded by the user setting (default 400 MP) and storage. Rendering memory is bounded by block size × threads + decode cache, not by output size. |
| JPEG export | ≤ 65 535 px per side (format limit); the app refuses rather than down-scales. |
| Measurements | Pixel distances only, unless an explicit reference length is supplied; then value ± 1σ from endpoint placement, registration residual and the stated reference uncertainty. Valid only on the reference's plane. |

## Project format

```
<project>/project.json        frames, transforms, statuses, edits, undo/redo, settings, result summary, job state
          originals/          byte-exact source files (+ RAW sidecars)
          work/               feature caches, thumbnails, coverage map, registration cache, working PNG copies
          results/<run>/      manifest.json, tiles/<level>/<col>_<row>.png, labels.png, detail.png, result.dzi
```

`project.json` is written by one owner (the core) via temp file + fsync + rename. Long jobs work on a snapshot and
merge their results under a lock, so photos can be added while registration runs. A project archive (`.dcap.zip`)
is this folder zipped (feature caches excluded) and can be re-imported on another device.
