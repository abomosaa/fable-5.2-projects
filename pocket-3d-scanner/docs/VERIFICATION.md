# Verification: what was checked, how, and what was not

Environment used for all of this: a Linux workstation (i7-14700K, 32 GB) with the Android SDK
and an **Android emulator** (Pixel 6 profile, API 36, x86_64, software GPU). **No physical
Android phone was available.** Everything that needs real optics, real motion tracking or real
AR is therefore listed under "Not verified" — nothing in that list is claimed to work on the
strength of emulator results.

## 1. Automated tests (all run, all passing at delivery)

Raw output of the final runs is archived in `results/_tests/` (pytest text + JUnit XML for the
companion, Gradle JUnit XML per app module, the instrumentation transcript, and the live
phone-data-layer run).

| Suite | Count | What it proves | How to run |
|---|---|---|---|
| Companion server (`companion/tests/test_{pairing,sessions,jobs,restart,cli}.py`) | 119 | Real TLS server on localhost with a fingerprint-pinning client: pairing code lifecycle, per-source and global rate limiting (one host cannot lock others out; brute force bounded), device identity kept only with proof of the current token, strict JSON and anchored ids, pair-body cap, truncated image rejected on upload, housekeeping of stale work data and abandoned uploads, per-device job cap, auth on every endpoint, per-device ownership, manifest limits, resumable upload (interrupt, wrong offset → 409 + offset, checksum mismatch, non-image rejected), path-traversal ids, job state machine for every worker outcome (success, diagnosed failure, crash, exit 0 without result, wrong artifact hash → failed), cancellation kills the process group, queue order, retry, Range download, long-poll, restart recovery (running → interrupted, queued resumes, partial uploads keep their offsets) | `cd companion && .venv-dev/bin/python -m pytest tests -q` |
| Pipeline units (`test_pipeline_units.py`) | 51 | Image/camera coordinate transforms for all EXIF rotations (checked against Pillow), distortion rotation, GL↔CV pose conversion, similarity fit never mirrors, RANSAC scale + uncertainty, AR scale accepted only when positions *and* orientations agree, tracking segments never merged, viewpoint bins fill only from distinct viewpoints, focal priors, upright working copies with untouched originals, presets, event stream monotonic, memory adaptation, hole counting (crop-cut edges excluded), no-parallax classification from two-view configurations, GLB round trip (texture bytes identical) | same |
| **End-to-end reconstruction of real photos** (`test_e2e_reconstruction.py`) | 7 | Runs COLMAP + OpenMVS in the container on the 12 real photos of `datasets/smoke`: valid textured model (UVs in range, texture varies, normals span all directions, faces look towards the cameras, cameras look at the model), unregistered photos reported, real stage order and progress messages, preview published before the dense stage, retry reuses checkpoints, **SIGTERM mid-dense leaves no result**, featureless input → diagnosed failure with guidance, **photos taken by turning on the spot → `no_parallax`** (not "add overlap"), enum table checked against the image's pycolmap | same (skips itself if no container runtime/image) |
| **Launcher + image + real pipeline over HTTPS** (`test_e2e_server_container.py`) | 1 | Starts the shipped image with `companion/run.sh` (hardening flags included), pairs with the pinned certificate, uploads the 12 real photos, runs the real pipeline under the real job manager, downloads and verifies the model, checks that work data is gone afterwards | same |
| App `:core` | 142 | Mesh library (GLB read/write incl. Khronos sample files, OBJ/PLY, topology, clipping, holes, quadric simplification, BVH), edit stack replay/undo/redo, measurements attached through re-orientation, repair flagged and zero-evidence, scale calibration maths and formatting, job state machine invariants (COMPLETED only via verified download; terminal phases only left by retry), coordinate conventions mirrored with the companion's numbers, coverage grid, blur/exposure/duplicate metrics, pairing-link parsing | `cd android && ./gradlew :core:test` |
| App `:data` | 55 (+1 live, run separately — §2) | Atomic, crash-safe store (torn writes, orphan temp files, re-adoption of frames), low-storage guard, duplicate/delete/export archive, active model switches only after verified download, pinned TLS against a real TLS server (wrong certificate refused before any request), resumable upload/download with integrity checks, sync engine through every phase incl. unreachable companion, cancel, interrupt → retry, restart mid-upload and mid-run without duplicated work, remote job missing, companion changed | `./gradlew :data:testDebugUnitTest` |
| App `:capture` | 109 | Auto-capture decisions (never while tracking is lost), weak-frame classification, coverage from poses (50 identical poses = 1 cell), panorama / turntable detectors, image-based turning-on-the-spot guard for the orientation-estimate mode (pan vs. orbit, blank centre gives no verdict), EXIF orientation from device rotation, NV21 packing with strides, Camera2 intrinsics crop/scale/rotate, review logic | `./gradlew :capture:testDebugUnitTest` |
| App `:viewer` | 65 | Orbit camera maths, "look from camera" equals the model camera pose for all 67 real cameras, crop gizmo, export (scale baked to metres, extras, repaired flag, textures byte-identical), export self-check rejects truncated/bit-flipped files, OBJ zip, measurement labels through reorient/undo/JSON, sparse preview parsing of a real file, shaders compile as GLSL ES 3.00 (`glslangValidator`) | `./gradlew :viewer:testDebugUnitTest` |
| **App UI, instrumented on the emulator** (`app/src/androidTest/.../AppFlowTest.kt`) | 5 | The installed app with real storage and navigation: new project → capture guide → project screen cannot reconstruct without photos; delete dialog states exactly what is removed; pairing screen validates the link and shows the fingerprint before anything is sent; settings state what runs where and report this device; an existing model opens in the viewer with one of the three scale statements and the export sheet repeats it | see the header of the test file (`adb shell am instrument …`) |

## 2. Real end-to-end runs (no mocks on either side)

| Run | Evidence |
|---|---|
| Independent Python client ⇄ running companion container: pairing with pinned certificate, wrong pin rejected, 401 without token, single-use code, resumable upload with injected interruption / wrong offset / corrupted bytes, real job with live progress, preview while running, Range-resumed download, SHA-256 verification, companion-side deletion | `tools/e2e_companion_http.py`, `results/_companion_http/transcript.json` |
| The app's real data layer (JVM) ⇄ running companion: pair, forged fingerprint refused, upload 12 real photos, real reconstruction, verified download, model parsed by the app's own GLB reader, cameras mapped to the phone's frame ids, companion copies deleted | `LiveCompanionTest`, `results/_phone_data_layer_live/` |
| Benchmarks on four real datasets + scan comparison + glTF validation + independent renders | `results/`, `docs/MEASURED-RESULTS.md` |

## 3. Emulator walkthrough of the installed APK

Driven through the real UI with adb (`tools/emu/ui.py`); screenshots `s01`–`s54` in
`results/_emulator_walkthrough/` (full size up to `s23`, 30 % downscales after that). This first
walkthrough was done on the build before the independent review; the table further down repeats
the changed behaviours on the final build.

| Step | Observed |
|---|---|
| Install `dist/pocket3d-scanner-1.0.0-debug.apk`, first launch | Library empty state |
| Pair via the `pocket3d://pair?…` link (companion on the host, reached as `10.0.2.2` / LAN IP) | Paired; address, pinned fingerprint, per-job limits, "GPU: not used" shown; pairing survives app restart |
| New scan → capture guide → import 12 photos through the system file picker | "12 of 12 selected files imported"; review screen with flags ("No camera metadata", "Blurry · 1") and the "usually too few" warning |
| Reconstruct (Preview) | Live stage list driven by companion events ("Depth maps: consistency pass 1/2, 1/8"), diagnostics (8/12 cameras registered, unregistered listed) |
| Provisional sparse preview while the job was running | 430 tie points + 8 camera frusta, "PROVISIONAL" banner |
| Open model | Textured / Solid / Wire / Evidence modes, open-edge outlines, scale pill "Uncalibrated — arbitrary units" |
| Edit → crop with the suggested box → apply | Undo available, "1 edit(s) applied", original untouched |
| Measure before calibration | "0.353 units (uncalibrated)" |
| Calibrate with a 22.4 cm reference | Pill "Calibrated from reference ±1.3%", measurement "23.0 ± 0.5 cm"; a deliberately tiny reference gave "±26%" and "5 ± 2 m" (uncertainty shown, not hidden) |
| Cameras panel | 8 registered photos; 4 "not used" with reason; viewpoint coverage "3 of 12 directions" next to, and distinct from, "verified surface support 70 %" |
| Export → Save to… (system document picker) → file pulled with adb | `exported_cropped_Model_1.glb`: Khronos validator 0 errors / 0 warnings, loads in trimesh with UVs + texture + `_CONFIDENCE`, extras carry scale statement |
| AR tab without ARCore services | "AR support could not be determined … Nothing is simulated here" + button to the 3D viewer |
| AR tab with the ARCore-for-emulator service installed, camera permission denied | "Camera permission denied" + *Open app settings* / *Open 3D viewer* |
| …permission granted | ARCore session creation fails on this software-GPU emulator; the app reports it and offers the viewer (no fake AR) |
| Library after `am force-stop` | Project listed with a thumbnail rendered from the real model |
| Kill the companion during a Standard job | "Companion unreachable — retrying"; after restarting the companion: "Interrupted … Nothing was completed" → Retry → attempt 2 → "Model ready" |
| New capture session with camera permission revoked / denied twice | Explanation, *Allow*, then "Camera access is turned off" with *Open settings*, *Import photos instead*, *Ask again* |
| Capture with the emulated camera | ARCore attempted and failed → banner, automatic fallback to the camera engine labelled "ORIENTATION ESTIMATE"; photo stored as 1280×960 JPEG q97 with EXIF orientation 6 (pixels not rotated); second identical shot → "This photo may not help — Nearly identical to another photo" with *Keep anyway*; session metadata persisted per photo (`tracking.mode = imu`, focus/exposure, sharpness, `duplicate` flag) |

A crash found this way and fixed: closing the HTTPS client on the main thread after pairing
(`NetworkOnMainThreadException`).

### Re-verification after the review fixes (final build)

Screenshots `v01`–`v13`, the two logs and the pulled exports in `results/_emulator_walkthrough/`.
App under test: `dist/pocket3d-scanner-1.0.0-debug.apk`; companion: the final image.

| Step | Observed |
|---|---|
| New scan → name → Create | Capture guide opens on top of the new project (`v02`); Back shows the project with "No photos yet" (`v03`) |
| Project actions → Delete… | Dialog lists photos, models and bytes that will be removed and what is known about companion copies (`v04`); project gone after confirming |
| Settings before any AR attempt | "Reported as supported and installed — not started yet in this session, so not confirmed to work" (`v06`) |
| New capture session | ARCore fails on this emulator → banner, fallback labelled "ORIENTATION ESTIMATE" (`v07`) |
| Settings after that failure | "Installed, but it failed to start on this device the last time it was tried" (`v10`) |
| **Turning on the spot**, auto capture on: the emulator's physical model is rotated in 3° steps without translation (`tools/emu/emu_pose.py`; the camera view pans) | One automatic photo at 12°, then "Auto capture paused — the picture slides as if the phone were only turning. Walk around the object." for the rest of the turn; the coverage ring stays at 1 of 12 (`v08_turn_in_place_log.txt`, `v08_*.png`) |
| The session of 25 photos that round 1 produced (identical pictures, only the orientation sensor turned) → Reconstruct (Preview) | Job fails after matching with "The photos match each other well, but they contain no parallax …", the three "what to try" lines about moving the camera, `Code: no_parallax`, "No model was created from this attempt" (`v13`) — in round 1 the same input was reported as "No two photographs could be related geometrically" with advice to add overlap |
| Edited model (crop, stray pieces removed, hole repair, simplify, calibrated) → Export GLB and PLY through "Save to…", files pulled with adb (`export_after_edits/`) | GLB extras: `holes_preserved: false` with a `repaired_note`, no `suggested_crop`, scale statement with ±5.7 %; Khronos validator 0 errors / 0 warnings; PLY header states units, calibration uncertainty and the `repaired` face property (`export_after_edits/extras_check.txt`) |
| **Orbiting** a framed target 4 m away (position and rotation changed together, 2° steps) | Auto capture continues (photos at 12° and 26°), no pause (`v09_orbit_log.txt`, `v09_*.png`) |

Note on the round-1 finding R1-01: `adb emu sensor set magnetic-field` (used there) changes the
orientation sensor only — the emulated camera picture stays identical — so that run produced 25
identical photos. The check above moves the device pose itself, which is the case the guard is
for. Both cases end without a model on the companion and are reported as `no_parallax`: identical
photos in the row above, a rendered panorama in the container test
`test_turning_on_the_spot_is_diagnosed_as_missing_parallax`.

## 4. Independent review

`docs/review/README.md` lists both review rounds, each finding and what was done about it; the
reviewer's reports and raw evidence are in `docs/review/round1/` and `docs/review/round2/`.

## 5. Not verified (needs hardware that was not available)

* **Physical phone**: nothing was installed or run on a real device.
* **ARCore capture engine**: session lifecycle, camera background, `acquireCameraImage` → JPEG,
  `Camera.getPose()` / `imageIntrinsics` conventions against real data, object-centre hit test,
  tracking-loss segments, auto-capture from tracked motion. Compile-checked and unit-tested at
  the logic level only. The companion re-estimates all poses and *validates* AR poses before
  using them for scale (position consensus and orientation residual), so a convention error
  would lead to "arbitrary units", not to a wrong metric scale — but that safety net itself has
  only been exercised with synthetic poses.
* **AR placement**: plane detection, anchoring, drag/rotate, true-size display, tracking loss —
  not exercised at all (ARCore does not start on the emulator used).
* **AR-derived metric scale** end to end.
* **Real optics**: blur/exposure thresholds, focus/exposure lock behaviour, Camera2 lens
  calibration on real sensors, HEIC from a phone camera, rotation-vector accuracy.
* **Performance and memory on real phone GPUs** with 200 k–400 k triangles and 4096² textures.
* **Share sheet** to other apps, notification behaviour across OEM skins, low-storage on a real
  full disk (the guard is unit-tested with an injected free-space function).
* **iOS**: not implemented.
