# textured — AliceVision "Buddha" (plaster Buddha head)

| | |
|---|---|
| Category | `textured` — textured object with irregular geometry |
| Object | A weathered, matte plaster/stone-like Buddha head (tightly curled "snail-shell" hair bumps, face relief) standing on a wooden table with printed fiducial-marker sheets around it |
| Images | 67 PNG, 2736 x 1540, 8-bit RGB, **no EXIF** (`images/00001._c.png` … `00067._c.png`, upstream names kept) |
| Source | https://github.com/alicevision/dataset_buddha (commit `9067f679eb5a772c3e818b7a12dc35882c071858`), also archived as https://doi.org/10.5281/zenodo.1203283 |
| Authors | Simone Gasparini, Fabien Castan, Yann Lanthony (AliceVision / LADIO project) |
| License | **CC BY 4.0** — see `LICENSE.source.txt`, full text in `upstream/LICENSE.md` |
| Reference | none (no scan, no documented dimensions; scale is arbitrary) |
| Size | 282 MB |

## Why it fits
Real hand-held photographs; the camera moves around a stationary object (upstream README: "67 images of a Buddha
head placed on a table. The images cover the whole object."). The surface is matte with fine speckle/dirt, and the
geometry is strongly non-convex at small scale (rows of hair bumps, ears, facial features), which makes it a good
"should reconstruct well" case. The textured table and marker sheets help camera registration.

## Camera information
* No EXIF. Camera make/model is not documented upstream.
* `cameras/NNNNN_P.txt` — upstream 3x4 projection matrix `P = K [R | t]` per image (pixel coordinates, origin at
  the top-left; world units arbitrary). These were **estimated by the authors' SfM**, they are not ground truth
  ("for each camera a file containing the estimated projection matrix is given, so that the MVS algorithm can be
  tested from this geometry").
* `cameras/mvs.ini` — upstream CMPMVS-style config (image count / resolutions).
* `cameras/intrinsics_from_P.json` — **derived by us** (`_scripts/p_to_krt.py`, RQ decomposition). All 67 matrices
  share one pinhole camera: `fx = fy = 1860.90 px, cx = 1368.76, cy = 774.25`, zero skew (i.e. ~73° horizontal
  FOV). The `._c` suffix and the shared distortion-free K indicate the images are the authors' undistorted
  outputs, but upstream does not state this explicitly. Not covered by `SHA256SUMS` (floating-point output).

## Caveats
* The images are **not in capture order** and are a mix of landscape shots and portrait shots stored sideways
  (no orientation metadata) — use exhaustive matching, not sequential matching.
* White balance / exposure varies between shots; a few are close-ups.
* Taking every Nth image gives a wide-baseline set that does not register reliably (an every-6th subset
  registered only 2 of 12 images in a quick COLMAP check), so do not thin this set that way.
* The upstream `*_seeds.bin` (SfM seed points) and `buddha_mini6/` were not downloaded.

## Files
`images/` (67), `cameras/` (67 `*_P.txt`, `mvs.ini`, derived `intrinsics_from_P.json`), `upstream/` (README,
LICENSE), `urls.tsv` (exact download URLs), `SHA256SUMS`, `LICENSE.source.txt`.
