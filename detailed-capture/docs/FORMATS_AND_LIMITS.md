# Formats, codecs and limits

## Input

| Format | Handling | Notes |
|---|---|---|
| JPEG (8-bit; baseline/progressive; CMYK handled by the decoder) | decoded by the core | EXIF orientation 1–8 applied as an exact pixel permutation; EXIF camera data kept; embedded ICC classified (sRGB / Display P3 / Adobe RGB / unknown) |
| PNG (8/16-bit) | decoded by the core | 16-bit is reduced to 8-bit for processing (warning `bit_depth_reduced`); `iCCP` and `eXIf` chunks read |
| HEIC/HEIF, WebP, TIFF, DNG and other RAW the device can decode | original bytes kept; a lossless PNG working copy is produced by the platform decoder (`ImageDecoder`) | RAW is "developed" by the platform, i.e. 8-bit, device-dependent rendering; the DNG itself is preserved. Whether DNG decoding works depends on the device. |
| RAW capture in-app | RAW+JPEG when CameraX reports `OUTPUT_FORMAT_RAW_JPEG` for the selected lens | the DNG is stored as a sidecar next to the JPEG; processing uses the JPEG. Not available on the emulator; untested on hardware. |

Limits: 320 px minimum side, 110 MP maximum per photo. Originals are never modified or recompressed; removal is a
reversible flag until the project is deleted.

Colour: the overview defines the working colour space. Frames in another *known* space are converted (3×3 matrix
in linear light, sRGB or γ 2.2 transfer); unknown profiles are used unchanged with a warning. The overview's ICC
profile, if it has one, is embedded verbatim in every export; without a profile exports are tagged sRGB.

## Internal

* 8-bit sources → 32-bit float during resampling and blending → 8-bit lossless PNG tiles (512 px, Deep Zoom layout).
* Each source pixel is resampled exactly once on its way to the output grid.

## Export

| Target | Codec details | Size limits | Memory |
|---|---|---|---|
| PNG | 8-bit RGB, zlib level 6, adaptive filtering, `sRGB` chunk or `iCCP` | none in the format (2³¹ px per side) | streamed, ~256 rows at a time |
| TIFF | 8-bit RGB, deflate strips, horizontal predictor, ICC tag; classic TIFF, automatically BigTIFF when the image may exceed 4 GB | none | streamed |
| JPEG | baseline, 4:4:4, quality 95 (IJG scaling), standard Huffman tables, ICC in APP2 | 65 535 px per side (format limit). Larger images are **refused** with an explanation; nothing is silently down-scaled | streamed by MCU rows |
| Tile package (.zip) | Deep Zoom (`image.dzi` + `image_files/`), PNG (lossless) or JPEG q92 tiles, self-contained `viewer.html` (no network), `manifest.json` with provenance | none | tile by tile |
| Project archive (.dcap.zip) | `project.json`, originals (stored, not re-compressed), working copies, optional result | Zip64 | streamed |

Exports apply the reversible edits: crop and 90° turns are exact pixel copies; straightening and perspective
correction resample once with Lanczos-4; colour edits are an affine transform of encoded RGB (identical to the
on-screen preview). `applyEdits=false` (CLI) exports the untouched fused image.

Practical notes: flat images above ~250 MP cannot be opened by many gallery apps and image editors even though the
file is valid; the app says so and offers the tile package. A 400 MP PNG is typically 0.5–1 GB.

## What a large pixel count does not mean

The output grid is chosen from what the accepted close-ups sample, but dimensions are not detail. The app, the
manifest (`stats.estimatedDetailMP`, `detailHistogram`, `closeupAreaFrac`) and the viewer report estimated genuine
detail separately, and the label/detail maps show exactly which areas are only the enlarged overview.
