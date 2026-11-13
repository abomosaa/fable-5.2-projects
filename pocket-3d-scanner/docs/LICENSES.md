# Source, asset and licence manifest

Everything Pocket 3D Scanner ships, downloads at build time, or uses as example data, with its
origin and licence. Nothing here is a paid API, a hosted service or a pretrained generative
model: reconstruction uses classical photogrammetry only.

## 1. Reconstruction companion (container image `pocket3d-companion:1.0`)

| Component | Version / pin | Where it comes from | Licence | How it is used |
|---|---|---|---|---|
| COLMAP via **pycolmap** | 4.2.1 (PyPI wheel, CPU build) | `companion/requirements.lock` | BSD-3-Clause | SIFT features, matching, geometric verification, incremental SfM, bundle adjustment, undistortion |
| **OpenMVS** | tag `v2.3.0`, built from source | https://github.com/cdcseacave/openMVS | AGPL-3.0 | Dense depth maps, fusion, Delaunay graph-cut meshing, refinement, texturing. Run as separate executables. Two one-line local patches (see `companion/Containerfile`): `Util::formatTime` buffer-size fix, `Mesh::SaveOBJ` empty-index fix |
| **VCGlib** (OpenMVS fork) | commit `658ba36d0a56…` | https://github.com/cdcseacave/VCG | GPL-3.0 | Build dependency of OpenMVS (mesh cleaning) |
| Open3D | 0.20.0 | PyPI | MIT | Mesh/point-cloud I/O, quadric decimation, ray casting for view support |
| NumPy / SciPy | 2.5.4 / 1.18.1 | PyPI | BSD-3-Clause | Geometry, KD-trees, graph components |
| Pillow / pillow-heif | 13.0.0 / 1.8.1 | PyPI | MIT-CMU / BSD-3-Clause (bundles libheif LGPL-3.0, libde265 LGPL-3.0, x265 GPL-2.0 for HEIC decoding) | Image decoding, EXIF, working copies |
| aiohttp | 3.14.5 | PyPI | Apache-2.0 | HTTPS server |
| cryptography | 50.0.2 | PyPI | Apache-2.0 OR BSD-3-Clause | Self-signed TLS certificate |
| qrcode / psutil | 8.2 / 7.2.2 | PyPI | BSD / BSD-3-Clause | Pairing QR in the terminal / memory watchdog |
| Ubuntu 24.04 base + runtime libraries | apt (OpenCV 4.6.0, Ceres 2.2.0, Boost 1.83, GMP, MPFR, libjpeg-turbo, libpng, libtiff, Python 3.12) | `docker.io/library/ubuntu:24.04` | per package (Apache-2.0, BSD, LGPL, MPL, PSF …) | Runtime of OpenMVS and Python |
| CGAL, Eigen (build stage only) | Ubuntu 24.04 packages | apt | GPL-3.0/LGPL-3.0, MPL-2.0 | Linked into / used by OpenMVS at build time |

All 76 Python packages in the image with their declared licences: `docs/licenses/companion-python-packages.md`.

**Copyleft note.** OpenMVS is AGPL-3.0 and VCGlib GPL-3.0. The companion invokes the unmodified
(except for the two documented patches) OpenMVS command-line programs as separate processes
and the image is built from the pinned public sources by `companion/Containerfile`, which is
the corresponding source offer. The image is self-describing: `/opt/pocket3d/NOTICE.md` lists
the components, pins, patches and where the sources come from, and the upstream licence texts of
OpenMVS and VCGlib are in `/opt/openmvs/licenses/` (`podman run --rm --entrypoint cat
pocket3d-companion:1.0 /opt/pocket3d/NOTICE.md`). If you redistribute the image, ship this
manifest and the Containerfile with it.

**This project's own code** (everything under `android/`, `companion/pocket3d_companion/`,
`tools/`) has **no licence chosen yet**: there is no `LICENSE` file at the repository root, so
all rights are reserved by its author until one is added. That is a decision for the owner, not
something to default silently; note that the companion *image* as a combined work contains
AGPL/GPL programs, which constrains how the image (not the app) may be redistributed.

## 2. Android app

| Component | Version | Licence | Use |
|---|---|---|---|
| Kotlin, kotlinx.coroutines, kotlinx.serialization | 2.2.10 / 1.10.2 / 1.9.0 | Apache-2.0 | Language, concurrency, JSON |
| AndroidX (Core, Activity, Lifecycle, Navigation, Compose BOM 2025.09.00, Material 3, ExifInterface) | see `android/gradle/libs.versions.toml` | Apache-2.0 | UI and platform glue |
| CameraX | 1.5.0 | Apache-2.0 | Camera capture, QR scanning preview |
| Google ARCore SDK (`com.google.ar:core`) | 1.50.0 | Apache-2.0 (SDK); "Google Play Services for AR" on the device is governed by Google's terms | Motion tracking for capture guidance, AR placement |
| OkHttp | 4.12.0 | Apache-2.0 | HTTPS client with certificate pinning |
| ZXing core | 3.5.3 | Apache-2.0 | Decoding the pairing QR code on-device |
| Android Gradle Plugin / Gradle | 8.13.2 / 8.14.3 | Apache-2.0 | Build only |

The app's own mesh processing (GLB/OBJ/PLY I/O, quadric simplification, hole filling, clipping,
BVH) is written for this project in `android/core` and has no third-party code.
Test-only: JUnit 4 (EPL-1.0), OkHttp MockWebServer (Apache-2.0), AndroidX Test + Compose UI test (Apache-2.0), Khronos glTF sample assets used
as reader fixtures (see `android/core/src/test/resources/README.md`).

## 3. Evaluation tooling (not part of the product)

| Component | Version | Licence | Use |
|---|---|---|---|
| trimesh | 4.11.2 | MIT | Independent glTF loader for renders and the scan comparison |
| Khronos glTF-Validator (`gltf-validator` npm) | 2.0.0-dev.3.10 | Apache-2.0 | Independent validation of exported GLB files |
| Open3D, NumPy, SciPy, Pillow | as above | as above | Distance computation, ICP |

## 4. Example datasets (real photographs; not committed, fetched by `datasets/fetch.sh`)

| Dataset dir | Object | Photos | Source | Author | Licence | Reference data |
|---|---|---|---|---|---|---|
| `datasets/textured` | Plaster Buddha head (textured, irregular) | 67 | AliceVision `dataset_buddha` (GitHub / Zenodo 1203283) | AliceVision contributors | CC BY 4.0 | none |
| `datasets/concave` | Townley well-head, British Museum (deep cavity) | 72 used of 144 | see `datasets/concave/README.md` | see README | **CC BY-NC-SA 4.0 (non-commercial)** | documented dimensions (Ø 84 cm, height 81.9 cm) |
| `datasets/difficult` | Glossy plastic tumbler (low texture, reflective) | 20 | NAVI v1.0 (Google Research) | Jampani, Maninis, Engelhardt et al. | CC BY (paper) / Apache-2.0 (project page) | structured-light 3D scan (mm), poses |
| `datasets/groundtruth` | Triceratops toy (textured, with reference) | 50 | NAVI v1.0 | as above | as above | structured-light 3D scan (mm), poses, masks |
| `datasets/smoke` | 12 consecutive, downscaled photos of `groundtruth` (committed, 1.2 MB) | 12 | derived | as above | as above | — |

Licence texts / proof excerpts with URLs and retrieval dates are stored next to each dataset
(`datasets/<name>/LICENSE.source.txt`, `datasets/<name>/upstream/`), checksums in
`datasets/<name>/SHA256SUMS`, candidates that were rejected for unclear licences in
`datasets/MANIFEST.md`.

The models in `results/` are outputs of this project's pipeline on those photographs and
inherit the dataset licences (in particular: the well-head results are non-commercial).

## 5. Things deliberately not used

No paid or hosted API, no cloud storage, no analytics/telemetry SDK, no learned
segmentation/depth/generative model, no fonts or icon packs beyond Material icons (Apache-2.0).
