# concave — The Townley Well-head (British Museum)

| | |
|---|---|
| Category | `concave` — object with a deep concavity; also has **documented real-world dimensions** |
| Object | Roman Pentelic-marble well-head (puteal): a hollow cylinder ~0.8 m tall with a carved figure frieze outside and a deep, dark, weathered interior shaft, on a low grey plinth in a museum gallery |
| Images | `images_all/`: 144 JPEG, 4928 x 3264 (all originals). `images/`: 72 of them (every 2nd, see below) |
| Camera | Nikon D5100, 18–55 mm zoom, full EXIF. **Two focal lengths**: 22 mm (33 mm equiv.) for DSC_0486–0555, 18 mm (27 mm equiv.) for DSC_0556–0629 |
| Source | https://github.com/BritishMuseumDH/townleyRomanWellhead (commit `6d0f9240f1e54404a611c3cbec33d4707bef3d31`) |
| Author | Daniel Pett, Digital Humanities Lead, British Museum ("144 photographs, Nikon D5100, Agisoft Pro, 10 minute scan 2/5/17") |
| License | **CC BY-NC-SA 4.0 — NON-COMMERCIAL, share-alike** — see `LICENSE.source.txt`, full text in `upstream/LICENSE.md` |
| Reference | Documented dimensions (upstream README): **Diameter 84 cm, Height 81.9 cm**. Plus the author's own photogrammetric model (not independent ground truth) in `reference/author_model/` |
| Size | 894 MB on disk (863 MB originals; `images/` are hard links) |

## Why it fits
Real hand-held museum photographs, the photographer walks around the stationary object. The interior is a deep
cylindrical shaft that is only visible from above — a classic concavity where MVS has to work from oblique,
self-occluded views with dark, low-contrast marble.

## Capture structure (from viewing all 144 frames)
| Files | Content |
|---|---|
| DSC_0486–0517 (32) | full 360° orbit from above the rim, whole object + rim opening visible (≈11° steps, estimated as 360°/32) |
| DSC_0518–0554 (37) | looking down into the shaft / rim close-ups |
| DSC_0555–0586 (32) | low orbit at frieze height, 18 mm, gallery background |
| DSC_0587–0601 (15) | oblique close-ups of the frieze from below |
| DSC_0602–0623 (22) | orbit of the lower half and plinth |
| DSC_0624–0629 (6)  | frieze close-ups |

`images/` = files at even 0-based positions of the `LC_ALL=C` sorted `images_all/` listing (DSC_0486, 0488, …,
0628 → 72 images; built by `_scripts/make_subset.sh concave 2`, hard links, bytes untouched). This keeps every
ring at ≈22° spacing.

## Reference data and how to use it
* **Known dimensions** — "Diameter: 84 cm, Height: 81.9 cm" (upstream README; museum catalogue style figures, so
  expect ~1 cm rounding, and "diameter" is the maximum outer diameter at the rim). Suggested check: scale the
  reconstruction so the height (rim top to base, excluding the grey plinth) is 81.9 cm, then compare the measured
  rim diameter with 84 cm; or compare the scale-free ratio diameter/height = 1.026.
* `reference/author_model/well-head.obj` (+ `.mtl`, `.jpg` texture) — the author's Agisoft PhotoScan model built
  from these same photos: 150,283 vertices, **arbitrary units and frame** (not metric), and per the README a
  "False bottom added to model in Blender". It is a plausibility reference only (same input photos, different
  software), **not** an independent scan. To compare: similarity-align (scale + ICP) your mesh to it.
* No camera poses / alignment transforms are provided upstream.

## Caveats
* **Non-commercial license** — internal evaluation only (see `LICENSE.source.txt`).
* Museum visitors walk through the background of several frames (e.g. around DSC_0525–0531, 0561–0573, 0587–0595):
  moving, non-rigid background content.
* Zoom changes at DSC_0556: do not force a single shared camera for all images; group by EXIF focal length.
* Shallow depth of field in close-ups; the interior is dark and nearly textureless in places; the base sits on
  a plinth so the underside is never seen.
* Upstream `masks/` (hand-drawn object masks), the STL model and the GIF were not downloaded.

## Files
`images_all/` (144), `images/` (72), `reference/author_model/` (3), `upstream/` (README, LICENSE), `urls.tsv`,
`SHA256SUMS`, `LICENSE.source.txt`.
