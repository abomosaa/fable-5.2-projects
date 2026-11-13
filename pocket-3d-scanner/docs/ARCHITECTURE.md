# Architecture and reconstruction limits

## 1. What runs where — and why

| Step | Runs on | Component |
|---|---|---|
| Camera capture, focus/exposure lock, EXIF/intrinsics/pose metadata | **Phone** | `android/capture` (CameraX; ARCore when available) |
| Blur / exposure / duplicate checks, viewpoint coverage (tracked or estimated) | **Phone** | `android/core/.../capture`, `android/capture` |
| Photo import, review, exclusion, incremental persistence | **Phone** | `android/data` (`FileProjectStore`, `AndroidPhotoImporter`) |
| Pairing, pinned-TLS upload (resumable), job supervision, verified download | **Phone ⇄ Companion** | `android/data` (`CompanionClient`, `SyncEngine`) ⇄ `companion/pocket3d_companion/{server,jobs,storage,security}.py` |
| Feature extraction, matching, SfM, bundle adjustment | **Companion** | COLMAP 4.x through pycolmap (`pipeline/sfm.py`) |
| Undistortion, dense depth maps, fusion, meshing, (refinement), texturing | **Companion** | OpenMVS 2.3.0 (`pipeline/mvs.py`) |
| Object region, support plane, evidence filtering, confidence, GLB packaging | **Companion** | `pipeline/{scene,meshpost,package,glb}.py` |
| Provisional sparse preview (computed) / (displayed) | **Companion** / **Phone** | `pipeline/scene.py` / `android/viewer` |
| Viewing, evidence overlay, crop/delete/reorient/simplify/hole repair, undo/redo | **Phone** | `android/viewer`, `android/core/.../mesh`, `.../edit` |
| Scale calibration, measurement | **Phone** | `android/core/.../scale`, `android/viewer` |
| GLB / OBJ / PLY export, sharing | **Phone** | `android/viewer/export`, `android/core/.../mesh` |
| AR placement | **Phone** (ARCore devices) | `android/viewer/ar` |

The app states this split in *About & capabilities* and labels every job screen "On companion".

### The measured decision

Before any app code was written, the full chain (COLMAP SfM → OpenMVS dense → mesh → texture)
was run on the 67-photo plaster-head dataset inside a resource-bounded container
(`results/_archive_14t10g`, `results/textured_standard*`):

| Budget (desktop x86 cores, i7-14700K) | Time | Peak RSS | Result |
|---|---|---|---|
| 14 threads / 10 GB | 9 min 00 s | 5.0 GB | 4.46 M dense points, 200 k triangles, 2 × 4096² texture |
| 8 threads / 5 GB | 6 min 01 s | 3.8 GB | depth maps reduced to 928 px to fit, same deliverable |
| **4 threads / 3 GB ("phone-like")** | **7 min 27 s** | **2.8 GB** | depth maps reduced to 736 px |

Even the smallest budget needs ~2.8 GB of resident memory and 7.5 minutes of four *desktop*
cores at full load. A phone's cores are several times slower and thermally throttled, and an
Android foreground app that holds ~3 GB is a prime target for the low-memory killer on 6–8 GB
devices; in addition the dense/meshing code depends on CGAL, Ceres, Boost and OpenCV builds
that were not ported to the NDK here. (This is a desktop proxy measurement, not an on-phone
measurement — no phone was available.) Hence:

* **Dense reconstruction runs on a bundled, self-hosted companion** (one container image, CPU
  only, no GPU or CUDA needed, no internet after the image is built).
* **The phone does everything that needs the user, the camera or the screen**, and the
  interactive mesh work, which fits easily (pure-Kotlin mesh library, 200 k–400 k triangles).

No part of the product uploads photographs anywhere except the paired companion.

## 2. Phone ⇄ companion protocol

`docs/companion-protocol.md` is the contract (v1). Summary of the security-relevant parts:

* HTTPS with a self-signed EC P-256 certificate generated on first start; the phone **pins the
  SHA-256 of the certificate** (from the QR code / pairing link) — no CA, no hostnames, no
  trust-all fallback. Cleartext is disabled in the manifest and in the client.
* Pairing: single-use 8-character code shown only on the companion's terminal (10-minute
  validity; wrong attempts are rate limited per source address and globally, without rotating
  the code, so one host cannot lock others out) → 256-bit bearer token. A device keeps its
  identity across re-pairing only by presenting its current token. The companion
  stores only the token's hash; the phone stores the token encrypted with an Android-Keystore key.
* Every session/job belongs to the device that created it; other devices get 404.
* Uploads are streamed to disk, resumable by offset, verified by SHA-256, validated as images
  (format sniffed from content, pixel data decoded, pixel/size/count limits, decompression-bomb
  guard). Client file
  names are metadata only — paths are built from validated ids.
* Jobs: FIFO queue, one at a time by default; each reconstruction is a separate process group
  with thread and memory limits, a memory watchdog, a wall-clock timeout, cancellation
  (SIGTERM → SIGKILL), and a strict completion rule: *exit 0 and a `result.json` whose every
  artifact matches size and SHA-256*. Anything else is `failed`; a stop/restart of the
  companion makes running jobs `interrupted` (never complete) and they can be retried, reusing
  finished stages.
* Container: the launcher runs the image with `--cap-drop=ALL`, `no-new-privileges`, a
  read-only root filesystem (only the data directory and a 256 MB `/tmp` are writable), CPU and
  memory limits. The process is root *inside* the container (rootless podman maps that to the
  invoking user; with rootful docker it is real root confined by the flags above). Outbound
  network access is not blocked: the code makes no outbound connections, but that is a property
  of the code, not an enforced policy.
* Retention: work data is removed on success and after 24 h otherwise; abandoned uploads after
  7 days; at most 4 active jobs per device.
* Addressing: the QR carries all LAN IPv4 addresses of the computer plus `10.0.2.2` (the
  Android emulator's alias for its host). Nothing is hard-coded in the app.

## 3. Reconstruction pipeline (companion)

Stage ids as reported to the phone: `ingest → features → matching → sfm → undistort → dense →
mesh → (refine) → texture → package`. Progress is derived from work done: photos checked,
photos with features, pair chunks matched, cameras registered (COLMAP callback), OpenMVS'
own "Estimated depth-maps N (x %)" / "Fused depth-maps" / Delaunay phase messages, texture
phases. The overall bar weights stages by their measured share of run time.

1. **ingest** — decode check; upright working copies (EXIF orientation applied to pixels, long
   side limited by the preset, byte-identical hard link when nothing changes; originals are
   never touched). Focal prior from capture intrinsics → EXIF 35 mm equivalent → focal-plane
   resolution (only if the file was provably not resized) → none. Frames with different camera
   body / zoom / size get separate calibrated cameras.
2. **features / matching** — SIFT (CPU), exhaustive pairs up to 150 photos, otherwise sequential
   with wrap-around; geometric verification (RANSAC).
3. **sfm** — COLMAP incremental mapping with bundle adjustment (focal + radial distortion
   refined). The largest consistent model is used; photos outside it are listed as
   *unregistered* with a reason. Fewer than 3 cameras or < 30 % registered → diagnosed failure
   with recapture guidance. Separate models are never merged.
4. **scene frame** (`scene.py`) — origin at the point the cameras converge on, +Y up (AR gravity
   if validated, else the support plane, else mean camera up), right-handed. **Scale**: metres
   only if AR tracking positions and SfM camera centres agree under one similarity transform
   per tracking segment (RANSAC, ≥ 60 % consensus, bootstrap scale spread ≤ 5 %, orientation
   residual ≤ 12°); the reported uncertainty never goes below 3 % and includes a
   focal-length term (device calibration is kept fixed in bundle adjustment; a drift of the
   solved focal length from the metadata widens the uncertainty). Otherwise units are
   **arbitrary** (median camera distance = 1) and labelled so everywhere.
5. **undistort** — images re-sampled to an ideal pinhole with the estimated calibration.
6. **dense** — OpenMVS PatchMatch depth maps (two geometric-consistency passes), fusion requiring
   ≥ 3 agreeing views. The depth-map size is lowered automatically if the predicted point cloud
   would not fit the job's memory limit (warning `reduced_dense_resolution`).
7. **mesh** — Delaunay tetrahedralisation + graph cut. **No hole closing** (`--close-holes 0`).
   Then `meshpost.py`: support plane from dense points, object = largest connected surface near
   the camera focus above the plane → *suggested* crop box (metadata, editable); a generous
   region around it is delivered so the boundary stays editable; faces farther than 4× the
   dense point spacing from any fused point are removed (surface the graph cut stretched over
   unobserved space becomes a visible hole); specks removed; quadric decimation to the preset's
   triangle budget; bow-tie vertices split.
8. **refine** (High preset) — OpenMVS photometric mesh refinement, at a photo scale that fits
   memory, or skipped with a warning.
9. **texture** — OpenMVS view selection with global + local seam levelling (equalises exposure
   between photos); one or more atlas pages, embedded unmodified.
10. **package** — GLB in the model frame with a per-vertex `_CONFIDENCE` attribute
    (dense-support × number of unoccluded registered views / 3), winding checked against the
    cameras, `asset.extras.pocket3d` (scale statement, suggested crop, ground plane, settings
    fingerprint, tool versions), plus `cameras.json` and `diagnostics.json`.

### Coordinate conventions (tested on both sides)

* Pixels: origin top-left, +x right, +y down. Photos are stored un-rotated with an EXIF tag;
  intrinsics / distortion / AR poses given for the stored image are rotated to the upright
  working image (`geom.py` ⇄ `ImageGeometry.kt`, mirrored unit tests with identical numbers).
* AR pose contract: camera-to-world, metres, world +Y up, GL camera axes (+X right, +Y up,
  −Z forward) relative to the stored image. Converted with `R_cv = R_gl · diag(1, −1, −1)`.
  A convention mix-up shows up as an orientation residual and the AR scale is rejected.
* Model / GLB: right-handed, +Y up, CCW front faces, UV origin top-left, no mirroring
  (similarity fits enforce det = +1).

## 4. Phone app structure

```
android/
  core     pure Kotlin/JVM: math, mesh library (GLB/OBJ/PLY, BVH, clip, holes, simplify),
           edit stack, scale, capture logic, job state machine, protocol DTOs, service interfaces
  design   theme + shared Compose components
  data     FileProjectStore (atomic, crash-safe), CompanionClient/Link, SyncEngine,
           importer, foreground sync service
  capture  capture guide, capture screen (CameraX / ARCore), frame review, import, capability probe
  viewer   OpenGL ES 3 renderer, editing tools, measurement, export, sparse preview, AR placement
  app      navigation, library, project, job, pairing, settings screens
```

* **Persistence**: one folder per project (layout in `core/project/Model.kt`); every mutation
  is temp-file + fsync + rename with a `.bak`; a photo is counted only after `commitFrame`
  returned; orphan temp files are cleaned at start, frame files missing from metadata after a
  crash are re-adopted and flagged.
* **Jobs**: `JobStateMachine` is the only way a phase changes. `COMPLETED` is reachable only
  from `DOWNLOADING` after every artifact verified; a remote "succeeded" alone is not
  completion. The active model of a project changes only at that moment, so re-running with
  other settings can never destroy a good result.
* **Editing** is non-destructive: `model.glb` is immutable; the current mesh is the base with
  an operation list replayed (`EditEngine`), which makes undo/redo and reopening exact.
  Measurements and the scale reference are stored in base coordinates and follow re-orientation.
  Hole repair is an explicit operation whose faces get a separate "repaired (unobserved)"
  material and zero confidence, preserved in exports.

## 5. Limits you should know

* **Accuracy** is that of CPU photogrammetry at moderate resolution: on the reference toy
  (NAVI Triceratops, structured-light scan) the object surface is within ~0.3–0.4 mm median of
  the scan, with a 2 mm completeness of ~90 % (the underside is never seen). On the glossy
  tumbler (20 photos) the shape is within ~0.5 mm median once scaled by a known distance, but
  a quarter of the surface is missing and the size implied by the camera positions is 11 %
  off, because focal length and camera distance are nearly interchangeable for such captures.
  See `docs/MEASURED-RESULTS.md`.
* **No learned priors**: nothing is hallucinated; unseen surface stays open. Segmentation is
  geometric (support plane + connectivity); the crop is a suggestion, wrong for objects that
  merge visually with their support (the dinosaur's stand is partly inside the suggested box).
* **Scale**: arbitrary until calibrated. AR-derived scale needs an ARCore device and is
  labelled with its uncertainty; it was validated here only with synthetic poses (unit tests),
  not with a physical phone.
* **Depth sensors** are detected and reported but not used in reconstruction in this version.
* **Texture artefacts** that the independent review found and that are not corrected: thin
  spurious membranes in concavities (under the dinosaur's tail and belly) carry background
  colour; pale rims appear at silhouette edges; a far inner wall can be seen through a hole.
  Atlas pages are sparsely filled (about 9–16 % of the UV area) — that is OpenMVS's packing.
* **Progress** is real (every step comes from a tool's own output) but stages have fixed
  weights, so the bar is not linear in time, and no remaining-time estimate is shown.
* **Smaller security properties**: the pairing code is printed to the container's log (the
  terminal is the trusted channel — keep that log private); TLS 1.2 with CBC suites is still
  offered; every paired device can read `/v1/status` (host name, limits, queue length);
  malformed HTTP requests are answered by the HTTP library, not with the JSON error format.
* **Capture sessions are not merged** (e.g. object flipped over): each is its own model.
* **Throughput**: one job at a time per companion by default; 30–70 photos take 3–9 minutes at
  Standard on a desktop CPU. No GPU acceleration is used.
* **Memory**: peak is in meshing/refinement and scales with dense points and photo count; the
  pipeline lowers depth-map/refinement resolution to fit the configured limit and says so.
