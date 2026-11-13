# Device verification

## What was verified, and where

**Emulator:** Android 16 (API 36) `google_apis` x86_64 system image, Pixel 6 profile (1080×2400), 2 GB RAM,
software GPU, emulated back camera. Driven only through adb (taps, swipes, uiautomator dumps, screenshots) by
`scripts/emulator_e2e.py`, i.e. through the real UI of the release APK in `dist/`. Evidence: `docs/evidence/emulator/`
(synthetic "wave" set, final APK) and `docs/evidence/emulator_real/` (real "vatican_map_sicilia" set, 9.5–24 MP
photos; previous build of the same day), each with screenshots and `e2e_log.json`.

**Physical device: none was available.** Everything in the second table is implemented but unverified on hardware.

| Step | Result on the emulator | Evidence |
|---|---|---|
| Install release APK, first launch | OK | `01_home_empty.png` |
| Create project by importing an overview through the system photo picker | OK; original bytes copied unchanged (16/16 files in the exported archive are md5-identical to the source files) | `03_project_overview_only.png` |
| Import 15 close-ups (multi-select picker) | OK; processed in the background with progress | `04_importing_closeups.png` |
| Acceptance / rejection with reasons | 12 verified, 3 rejected (foreign photo, same-scale photo, blurred photo) — identical verdicts to the host run | `05_…`, `06_frame_*_rejected.png` |
| Coverage map from accepted footprints | "78 % verified at ≥1.5× detail", footprints, gap markers | `05_capture_map_registered.png` |
| Fusion with stage progress (the first Fuse shows the notification-permission prompt) | 4672×3504 in 17 s | `07_fusing_progress.png`, `08_fused.png` |
| Tiled viewer, zoom to 347 % | OK | `09_…`, `10_viewer_zoomed.png` |
| Compare (overview enlarged vs fused, same coordinates) | OK | `11_compare_split.png` |
| Sources overlay → tap → source photo → original pixels at 100 % | OK ("From Close-up 10 (134.jpg), sampled at 3.0× the overview, source pixel (1093, 111)") | `12_…`–`14_original_pixels_100pct.png` |
| Detail map, result details | OK (16.4 MP grid vs ≈ 9.2 MP estimated genuine detail) | `15_detail_map.png`, `16_result_details.png` |
| Edits: rotate 90°, undo, redo; crop: top-left corner, then bottom-right corner, then move; undo ×3; colour controls | rotation 3504×4672 → 4672×3504 → 3504×4672; crop 4672×3504 → 3270×2533 → 2075×1719 (kept after moving) → undo → 3270×2533 → 4672×3504 | `17_…`–`19_…`, `steps_log.txt` |
| Export PNG + native share sheet | 4672×3504, 19.6 MB; Android share sheet opened | `20_…`–`22_native_share_sheet.png`, `exported_from_device.png` |
| Tile package and project archive | written on device; archive unpacked on the host, loaded by the host core and re-fused: equal to the device export within 1 grey level (8·10⁻⁶ of samples differ) | `50_…`, `51_…`, `project_archive.dcap.zip` |
| Real 24 MP photos, 401 MP result | 7/7 close-ups verified (same as host); 22208×18051 fused on the 2 GB emulator | `emulator_real/05_…`, `emulator_real/09_viewer_fit.png` |
| Process killed during fusion → relaunch → resume | wave set (final APK): killed at block 26/70, relaunch shows "Fusion was interrupted. Finished tiles are kept." with Resume, finished 9.5 s later. Vatican set (earlier build): killed at block 365/1584, resumed from block 428 and finished | `24_…`–`28_resumed_done.png`, `emulator_real/24_…`–`28_…` |
| In-app camera (emulated scene): preview, guidance, shutter, RAW+JPEG | photo captured, stored (JPEG + 5 MB DNG sidecar), checked and correctly rejected (it does not show the subject); clipping warning shown for the emulator's white scene | `emulator_real/30_…`–`32_…` |
| Camera permission denied | explanatory screen with "Open settings / try again" and "import photos instead" | `emulator_real/41_permission_denied_screen.png` |
| Truncated source file | found during testing (a stale MediaStore entry made the picker deliver a cut-off JPEG); the core now refuses such files with a plain message (`truncated`), covered by a test | `core/tests/tests.cpp` |

Timings: see "Performance" in docs/EVALUATION.md (emulator numbers are indicative only).

## Not verified (needs a physical device)

| Item | Status |
|---|---|
| Real camera capture of overview and close-ups of a physical subject through the app | **not tested** — the emulator camera shows a synthetic scene, so no overview/close-up pair of a real subject was captured in-app. The capture → check → reject path was exercised; capture → *accept* was only exercised with imported photographs. |
| Live placement on the mini-map and overlap guidance from the preview stream | code path runs on the emulator, but "found" can never be true there; **unverified** |
| Auto-capture (gyroscope steadiness + placement + sharpness) | **unverified** (no gyroscope motion on the emulator) |
| Focus / exposure / white-balance lock, exposure compensation, lens switching | controls are shown and calls succeed on the emulator; real effect **unverified** |
| RAW (DNG) capture | works on the emulator's fake sensor; **unverified** on hardware; RAW is stored as a sidecar only |
| HEIC / Ultra-HDR / Display-P3 photos from real phones | decoding path implemented (platform decoder → working PNG; ICC classification); **not exercised** with real files |
| arm64-v8a build | compiled and packaged; **never executed** (emulator is x86_64) |
| Speed, memory pressure, thermal behaviour, battery, foreground-service survival on OEM builds | **unverified** |
| Photo picker behaviour on vendor galleries, Android 8–15 | only Android 16 was run; minSdk 26 is untested |
| Low-storage behaviour | checks exist before import, capture, fusion and export; **not exercised** on a nearly full device |

## Reproduce

```bash
export ANDROID_AVD_HOME=$PWD/.avd
echo no | avdmanager create avd -n dc_test -k "system-images;android-36;google_apis;x86_64" -d pixel_6
emulator -avd dc_test -no-window -no-audio -no-snapshot -gpu swiftshader_indirect -memory 2048 -port 5590 &
ANDROID_SERIAL=emulator-5590 scripts/emulator_e2e.py datasets/synthetic/sets/wave docs/evidence/emulator \
    --apk dist/DetailedCapture-1.0.0.apk
```

Note for testers: when replacing gallery files over adb, use new file names. Re-using a name leaves a stale
MediaStore row whose old size makes the system picker deliver a truncated stream.
