# Pocket 3D Scanner

Turn overlapping photographs of a real object into a textured 3D model you can inspect, clean,
measure, export and place back into the room.

* **Android app** (Kotlin, Jetpack Compose, CameraX, ARCore, OpenGL ES 3): capture with honest
  guidance, photo import and review, job supervision, 3D viewer, editing, measurement, export,
  AR placement, project library.
* **Companion** (one container image; COLMAP + OpenMVS on the CPU): the real photogrammetric
  reconstruction, on a computer you control in your local network. No cloud, no account, no
  paid API, no internet after the image is built. Photos go only from the phone to that computer,
  over TLS pinned to the companion's certificate.

Reconstruction is real multi-view geometry: structure-from-motion, bundle adjustment, dense
stereo, Delaunay meshing, texturing. Nothing is generated or filled in: surface no photo saw
stays an open hole unless you explicitly repair it (and then it is marked as synthetic).

| | |
|---|---|
| What runs where, protocol, pipeline, limits | [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) |
| How to photograph an object | [docs/CAPTURE-GUIDE.md](docs/CAPTURE-GUIDE.md) |
| Supported devices and capabilities | [docs/CAPABILITIES.md](docs/CAPABILITIES.md) |
| Measured time, memory, accuracy on the example datasets | [docs/MEASURED-RESULTS.md](docs/MEASURED-RESULTS.md) |
| What was verified, how, and what was not | [docs/VERIFICATION.md](docs/VERIFICATION.md) |
| Independent review, findings and fixes | [docs/review/](docs/review/) |
| Sources, licences, datasets | [docs/LICENSES.md](docs/LICENSES.md), [datasets/MANIFEST.md](datasets/MANIFEST.md) |
| Phone ⇄ companion protocol | [docs/companion-protocol.md](docs/companion-protocol.md) |

## Quick start

### 1. Build and start the companion (Linux/macOS computer, podman or docker)

Requirements: x86-64 CPU with AVX, 4+ cores, **8 GB RAM recommended** (the default container
limit is 10 GB; 5 GB works — depth maps are then computed at a lower resolution and the app says
so), ~4 GB disk for the image plus space for photos and results. No GPU is used.

```sh
# one-time: builds OpenMVS 2.3.0 from pinned sources and installs pinned Python packages (~10 min)
podman build -t pocket3d-companion -f companion/Containerfile companion

# start it; prints a QR code and a pairing link
companion/run.sh
```

`companion/run.sh` settings (environment variables): `POCKET3D_PORT` (8443),
`POCKET3D_DATA_DIR` (`./companion-data`), `POCKET3D_CPUS` (half the cores), `POCKET3D_MEMORY`
(`10g`), `POCKET3D_ADVERTISE` (LAN addresses to put into the QR), `POCKET3D_LIMIT_ARGS`.
`companion/run.sh pair` shows the pairing details again, `companion/run.sh devices` lists or
revokes paired phones. Stop with Ctrl-C; projects, uploads and results survive a restart, a job
that was running is reported as *interrupted* and can be retried from the phone.

Allow inbound TCP 8443 from your LAN in the computer's firewall. Do not expose the port to the
internet.

### 2. Install the app

```sh
adb install -r dist/pocket3d-scanner-1.0.0-debug.apk      # prebuilt (arm64-v8a + x86_64)
```

`dist/` holds two builds of the same source, with checksums in `dist/SHA256SUMS`:
`…-debug.apk` (24 MB, debuggable) and `…-release.apk` (16 MB, release build type, not
debuggable; code shrinking is off). **Both are
signed with the Android debug key** — fine for side-loading and testing, not for store
distribution: sign a release with your own key (`android/app/build.gradle.kts`,
`signingConfigs`) before publishing. The two builds share the signature, so one can be installed
over the other.

Or build it (JDK 17, Android SDK platform 36 / build-tools 36; `ANDROID_HOME` set or
`android/local.properties` with `sdk.dir=…`):

```sh
cd android
./gradlew :app:assembleDebug          # → app/build/outputs/apk/debug/app-debug.apk
./gradlew test                        # JVM unit tests of all modules
```

Minimum Android 8.0 (API 26). ARCore is optional.

### 3. Pair

App → computer icon → *Scan QR code* (or paste the `pocket3d://pair?…` link). Phone and
computer must be on the same network.

* **Physical phone**: the QR contains the computer's LAN addresses; nothing to type.
* **Android emulator**: the host computer is `10.0.2.2`; `run.sh` always adds it to the link.
  Paste the link into the pairing screen, or
  `adb shell am start -a android.intent.action.VIEW -d '"<link>"'`.

### 4. Scan

*New scan* → read the capture guide → capture (or import photos) → *Review photos* →
*Reconstruct* (Preview / Standard / High) → watch real stage progress → open the model →
crop / clean / calibrate scale / measure → export GLB / OBJ / PLY or place in AR.

## Repository layout

```
android/        the app (modules: core, design, data, capture, viewer, app)
companion/      server + reconstruction pipeline, Containerfile, run.sh, tests
datasets/       example photo sets: manifest, licences, checksums, fetch.sh (photos are downloaded)
results/        actual outputs of the pipeline on those datasets (models, diagnostics, renders, evaluation),
                test run outputs (_tests), emulator walkthrough evidence
tools/          benchmark runner, independent GLB renderer/validator, scan comparison, HTTP end-to-end client
docs/           architecture, capture guide, capabilities, measured results, verification, review, licences
dist/           installable APK
```

## Tests

```sh
# companion: server, security, job state machine, pipeline units, end-to-end reconstruction of
# real photos in the container (the e2e tests skip themselves if no image/runtime is available)
cd companion && uv venv --python 3.12 .venv-dev && \
  uv pip install --python .venv-dev/bin/python -r requirements.lock -r requirements-dev.txt && \
  .venv-dev/bin/python -m pytest tests -q

# app: unit tests of every module (mesh library, edit stack, scale, job state machine, store,
# pinned-TLS client, sync engine, capture logic, viewer logic)
cd android && ./gradlew test

# app UI on a device/emulator: instrumented Compose tests of the installed app (real storage, real
# navigation). Installed with adb so that existing projects and the pairing on the device are kept —
# `connectedAndroidTest` would uninstall the app and its data afterwards.
cd android && ./gradlew :app:assembleDebug :app:assembleDebugAndroidTest && \
  adb install -r app/build/outputs/apk/debug/app-debug.apk && \
  adb install -r app/build/outputs/apk/androidTest/debug/app-debug-androidTest.apk && \
  adb shell am instrument -w dev.pocket3d.app.test/androidx.test.runner.AndroidJUnitRunner

# phone data layer against a REAL running companion doing a real reconstruction
POCKET3D_TEST_PAIRING_FILE=$PWD/companion-data/pairing.txt \
  ./gradlew :data:cleanTestDebugUnitTest :data:testDebugUnitTest --tests '*LiveCompanionTest*'

# reproduce the benchmark numbers and renders
datasets/fetch.sh && tools/run_benchmarks.sh && tools/render_all.sh && python3 tools/summarize_results.py
```

## Honest limits (short version)

* Needs a companion computer for reconstruction; the phone alone captures, reviews, views,
  edits, measures and exports.
* Shiny, transparent, texture-less, moving or very thin subjects reconstruct poorly — the
  example "difficult" dataset shows what that looks like and how the app reports it.
* Photos alone give no real-world size: lengths are "units (uncalibrated)" until you calibrate
  with a known distance, or an ARCore capture yields a validated (±≥3 %) scale.
* Physical-device camera tracking and AR placement could not be exercised in the development
  environment (no phone attached); see [docs/VERIFICATION.md](docs/VERIFICATION.md) for exactly
  what was and was not verified.
* iOS: not built, not tested, not claimed.
