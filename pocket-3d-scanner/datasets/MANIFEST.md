# Benchmark datasets — manifest

Real multi-view **photographs** (no renders) used to exercise and evaluate the Pocket 3D Scanner reconstruction
pipeline. All licenses were verified against the source pages on **2026-11-11**; the evidence (verbatim excerpts,
URLs, saved license texts) is in each `<name>/LICENSE.source.txt` and `<name>/upstream/`.

Re-create everything with `./fetch.sh` (≈2 min on a fast link; verifies SHA-256 of every file). Only ~2 MB of
metadata + the `smoke/` images are meant to be committed (`.gitignore` excludes the rest).

| Name | Category | Object | # images | Resolution | Source URL | Author | License | Reference | Download size |
|---|---|---|---|---|---|---|---|---|---|
| `textured` | textured, irregular geometry | Plaster Buddha head on a table (AliceVision "Buddha Dataset") | 67 | 2736 x 1540 PNG (no EXIF; per-image P matrices, f = 1860.9 px) | https://github.com/alicevision/dataset_buddha @ `9067f67` (DOI 10.5281/zenodo.1203283) | S. Gasparini, F. Castan, Y. Lanthony (AliceVision / LADIO) | **CC BY 4.0** | none | 282 MB |
| `concave` | deep concavity (+ known dimensions) | The Townley Well-head, marble puteal, British Museum | 144 in `images_all/`, 72 in `images/` (every 2nd) | 4928 x 3264 JPEG, EXIF (Nikon D5100, 22 mm and 18 mm) | https://github.com/BritishMuseumDH/townleyRomanWellhead @ `6d0f924` | Daniel Pett, British Museum | **CC BY-NC-SA 4.0 (NON-COMMERCIAL, share-alike)** | documented dimensions: diameter 84 cm, height 81.9 cm; author's own photogrammetry model (OBJ, arbitrary units, not independent GT) | 894 MB |
| `difficult` | glossy / low-texture, expected partial failure (+ scanner reference) | NAVI `tumbler_air_balloon`: glossy white plastic travel tumbler with blue lid, on carpet | 20 | 4080 x 3072 JPEG, EXIF (Pixel 6 Pro) | https://navidataset.github.io/ — `navi_v1.0.tar.gz`, `tumbler_air_balloon/multiview-02-pixel_6pro` | Jampani et al., Google (NAVI, NeurIPS 2023) | **CC-BY** per paper (version unstated); Apache-2.0 text on project page | 3D scan (OBJ, mm), GT camera poses, GT masks + depth | 67 MB (read from a 17 GB tarball stream, ≈2.5 GB transferred) |
| `groundtruth` | accuracy reference (textured, irregular object) | NAVI `dino_5`: Triceratops toy 224 x 110 x 87 mm on a stand | 50 | 5184 x 3456 JPEG, EXIF (Canon T4i, 30 mm) | https://navidataset.github.io/ — `navi_v1.0.tar.gz`, `dino_5/multiview-13-canon_t4i` | Jampani et al., Google (NAVI, NeurIPS 2023) | **CC-BY** per paper (version unstated); Apache-2.0 text on project page | **structured-light 3D scan (OBJ, mm, 1.24 M vertices), per-image GT poses, GT masks + depth** | 252 MB (same stream as `difficult`) |
| `smoke` | fast end-to-end test | 12 consecutive captures of `groundtruth` (≈150° arc), downscaled | 12 | 1200 x 800 JPEG, EXIF kept, `cameras.json` | derived from `groundtruth` (`_scripts/make_smoke.py`) | as `groundtruth` (modified) | as `groundtruth` | GT poses for the 12 images; scan via `groundtruth` | 1.2 MB (derived) |
| `smoke_alt` | fallback smoke test | first 12 files of `concave/images` (≈250° arc), downscaled | 12 | 1200 x 795 JPEG, EXIF kept | derived from `concave` (`_scripts/make_smoke_alt.sh`) | as `concave` (modified) | **CC BY-NC-SA 4.0 (NON-COMMERCIAL)** | object dimensions only | 2.8 MB (derived) |

Total on disk ≈ 1.5 GB.

## Layout
```
datasets/
  fetch.sh            re-download + verify            MANIFEST.md   this file
  _scripts/           helper scripts (never placed inside a dataset dir)
  <name>/
    images/           the image set to reconstruct (original bytes; for `concave` hard links into images_all/)
    images_all/       (concave only) all 144 originals
    cameras/          (textured only) upstream projection matrices + derived intrinsics
    reference/        ground truth / reference data (scan, annotations, masks, depth, author model)
    upstream/         license texts and READMEs saved from the source
    README.md  LICENSE.source.txt  SHA256SUMS  urls.tsv / navi_members.tsv (exact sources)
```

## Reference data at a glance
* `groundtruth`, `difficult`, `smoke`: `reference/annotations.json` gives, per image, `x_cam = R(q)·x_scan + t`
  (`q = [qw,qx,qy,qz]`, `t` in mm, OpenCV camera axes, focal length in px, principal point at the image centre).
  The scan OBJ is in millimetres, centred at the origin. Align a reconstruction by fitting a similarity
  transform from reconstructed camera centres to `C_gt = −R(q)ᵀ t`, crop to the scan bounding box, optionally
  refine with ICP. Conventions were verified by projection (`_scripts/navi_verify_alignment.py`); details in
  `groundtruth/README.md`. Intrinsics are nominal (EXIF-derived), not calibrated.
* `concave`: scale check against the documented 84 cm diameter / 81.9 cm height; no poses.
* `textured`: no reference.

## Handling rules followed
* Downloads are treated as untrusted data: each dataset lives in its own directory, nothing downloaded is
  executed, the NAVI tarball is never unpacked with `tar` by `fetch.sh` (whitelist extractor), all Python that
  reads downloaded files is run with `python3 -I` from `_scripts/`.
* Original image bytes are untouched for `textured`, `concave`, `difficult`, `groundtruth` (verified by
  `SHA256SUMS`). Only `smoke` / `smoke_alt` are re-encoded, and that is documented in their READMEs.

## Known limitations (read before relying on a set)
* `concave` and `smoke_alt` are **non-commercial** (CC BY-NC-SA 4.0).
* `difficult` has only 20 images (target was 25–80).
* NAVI's dataset license is stated as "CC-BY" in the paper without a version; the only license file on the
  project page is Apache-2.0. Both are permissive; see `groundtruth/LICENSE.source.txt`.
* No full reconstruction was run on any set as part of dataset preparation. Two quick COLMAP sparse checks on
  1200 px thumbnails showed that *every-Nth* thinning of the shuffled `groundtruth` / `textured` sets yields
  wide-baseline subsets that register only 2 images — hence the consecutive-capture rule for `smoke`.

## Candidates examined and not shipped
| Candidate | Outcome |
|---|---|
| AliceVision `dataset_monstree` | **Unclear license – not shipped.** Repo has no LICENSE file and the README is two lines with no license statement (GitHub API `license: null`). |
| Tanks and Temples (Ignatius, Caterpillar, Truck) | **Unclear license – not shipped.** https://www.tanksandtemples.org/license/ is self-contradictory: it says the data is "published under the Creative Commons Attribution 4.0 International (CC BY 4.0) License", but the same page is titled "Data License for non-commercial scientific research purposes" and its License Grant says commercial use "is prohibited" and the data "may not be reproduced, modified, and/or made available in any form to any third party without our prior written permission". (It would otherwise have been the natural laser-scan reference set.) |
| DTU MVS | **Unclear license – not shipped.** The dataset page (roboimagedata.compute.dtu.dk/?page_id=36) contains no license or terms text; downloads are 6 GB+ bulk zips. |
| Stanford-ORB | **Unclear license – not shipped.** No license statement on the project page; GitHub repo has no license; smallest image archive is 11 GB. |
| MobileBrick | **Unclear license – not shipped.** Code is MIT, but neither the README nor the project page states a license for the 13 GB dataset. |
| BlendedMVS | Rejected: CC BY 4.0 (README), but the images are blended renders of reconstructed meshes, not raw photographs. |
| OmniObject3D | License OK (CC BY 4.0 in README) but downloads need an OpenXLab account/CLI or Google Drive; not scriptable from original URLs, so not used. |
| CO3D | Not used: README states CC BY-NC 4.0; multi-GB per-category archives of video frames; nothing it adds over the shipped sets. |
| Wikimedia Commons "Set of 95 pictures for photogrammetry exercise" (glazed ceramic pine-cone finial, N.ELAC / USP, 95 x 6000 x 4000) | License verified (CC BY-SA 4.0 via the Commons API for all 95 files) and visually suitable as a *glossy ceramic* set; not shipped only to keep the collection small — a good extra `difficult` candidate without a reference. |
| `natowi/dataset_flowerpot` | Rejected: CC BY-SA 4.0, but it is a turntable capture ("turning the object with the reference plane and keeping the camera on the same position"), i.e. not a moving camera around a stationary object. |
| `edanvoye/photogrammetry_example_seashell` | Not used: CC BY-NC 4.0 (README); 62 images with an ArUco scale board — possible future known-scale set. |
| `MicroPasts/socketed-axe-version2` | Not used: CC BY 4.0 (LICENSE.md), 54 tripod photos of a bronze axe; capture style (turntable vs. orbit) not inspected. |
| Other `BritishMuseumDH` sets (Nandi bull, Molossian hound, …) | Alternates with documented dimensions; READMEs state CC BY-NC-SA (some repos have no LICENSE file). Not needed. |
| Zenodo "3D Archaeological Greek Pottery" records | Rejected: CC BY-SA 4.0, but they contain structured-light scan data only, no photo sets. |
| Zenodo "N-Views egg geometry dataset" | Not used: CC BY 4.0 with manual measurements, but a single 7.4 GB zip of turntable captures. |
| Zenodo "RabbitStamp", "ETN-FPI Hat-Man" | Rejected: academic-use-only terms; camera arrays, not orbits. |
| OpenMVG `ImageDataset_SceauxCastle`, Middlebury dino/temple, ETH3D, Smithsonian, Sketchfab-linked sets, Hugging Face mirrors | Not investigated in depth (building / 640x480 / scene-scale / models only); licenses **not verified** by us. |
