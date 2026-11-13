# smoke_alt — alternative 12-image smoke set (derived from `concave`, NON-COMMERCIAL)

| | |
|---|---|
| Category | `smoke` (fallback) — frame-filling, richly textured object with ~22° steps; use if `../smoke/` does not register reliably |
| Object | The Townley Well-head (marble well-head, 84 cm diameter, 81.9 cm high) — see `../concave/README.md` |
| Images | 12 JPEG, **1200 x 795** (downscaled from 4928 x 3264), 2.8 MB in total |
| Camera | Nikon D5100 at 22 mm (33 mm equiv.); EXIF carried over, incl. `FocalLengthIn35mmFilm = 33` |
| Source / license | British Museum / Daniel Pett — **CC BY-NC-SA 4.0 (non-commercial, share-alike)**; modified copies, see `LICENSE.source.txt` |
| Reference | none beyond the documented object dimensions (84 cm diameter, 81.9 cm height) |

## Exact derivation (reproducible: `bash _scripts/make_smoke_alt.sh concave smoke_alt`)
1. Take the first 12 files of the `LC_ALL=C` sorted `concave/images/` listing: DSC_0486, 0488, 0490, …, 0508
   (i.e. every 2nd original capture of the first 23 frames of the upper orbit — about 250° of the 360° orbit at
   ≈22° steps, whole object and rim opening in view).
2. Each file: `magick concave/images/DSC_xxxx.JPG -resize 1200x1200 -quality 90 smoke_alt/images/DSC_xxxx.jpg`
   (ImageMagick 7.1.2-35 Q16-HDRI; no auto-orient; metadata kept).

## Intrinsics / EXIF
Nominal focal length for the resized images: 33 mm equiv. → `f ≈ 1200 x 33/36 = 1100 px` (APS-C: 22 mm on a
23.6 mm-wide sensor → 1119 px); principal point at the centre (600, 397.5). `PixelXDimension/PixelYDimension`
EXIF tags are stale (still 4928 x 3264).

## Caveats
* **Non-commercial, share-alike**: keep out of any commercially distributed artifact; if committed, keep this
  folder's `LICENSE.source.txt` with it. Prefer `../smoke/` (permissive) when it works.
* Not validated by a reconstruction run on our side. Orbit spacing estimated from the frame count (32 frames
  per 360°), not measured.
* `fetch.sh` re-derives it only if `smoke_alt/images/` is missing (needs `concave/` and ImageMagick).

## Files
`images/` (12), `SHA256SUMS`, `LICENSE.source.txt`.
