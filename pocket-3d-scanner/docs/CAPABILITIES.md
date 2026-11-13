# Supported devices and capability matrix

The app detects capabilities from the platform at run time (*About & capabilities* in the app
shows the result for the device in hand, produced by `CapabilityProbe`). Nothing is simulated:
if the hardware or a service is missing the feature is reported as unavailable and the listed
fallback is used.

## Phone

Minimum: Android 8.0 (API 26), OpenGL ES 3.0, a back camera (only for capture — import works
without one). ABIs in the APK: `arm64-v8a`, `x86_64`.

| Feature | Requirement | With it | Without it (fallback) | Label in the app |
|---|---|---|---|---|
| Photo capture | Back camera + CAMERA permission | **Without AR tracking:** full-resolution JPEG straight from the camera (CameraX still capture), stored byte-for-byte. **With AR tracking:** the photo is the ARCore CPU camera image (the largest CPU-image size ARCore offers on the device — usually well below the sensor's still resolution) encoded once in the app as JPEG quality 97. The capture screen shows which mode is active ("AR MODE"). | Permission denied → explanation, *Open settings*, *Import photos instead* | — |
| Tracked viewpoints | ARCore supported **and** Google Play Services for AR installed | Camera poses + intrinsics stored per photo; coverage ring from tracked positions relative to the chosen object centre; tracking-loss handling with separate segments; candidate metric scale (validated later on the companion) | Orientation-sensor estimate (next row) | "Viewpoint coverage — tracked" |
| Estimated viewpoints | Rotation-vector sensor | Coverage ring from the phone's viewing direction under the orbit assumption; auto-capture by angular step | No coverage ring at all; manual capture only | "estimated from phone orientation" (provisional colour) |
| Focus / exposure / white-balance lock | Camera2 reports AE lock, AWB lock and an AF mode | *Lock focus & exposure* toggle; state stored per photo | Toggle shown as "not supported on this camera" | per-photo `focus.locked` / `exposure.locked` |
| Lens intrinsics / distortion from the device | Camera2 `LENS_INTRINSIC_CALIBRATION` / `LENS_DISTORTION` reported | Stored as capture priors (source `camera2`) | EXIF focal length (35 mm equivalent) → else self-calibration on the companion | focal source shown in photo details |
| Live quality checks (blur, exposure, duplicates, low overlap) | none | always | — | per-photo flags, editable in review |
| Depth sensor / ARCore depth | ToF/structured-light depth camera, or ARCore Depth API | **Detected and reported only** — depth is not used for reconstruction in this version | — | "detected, not used" / "not present" |
| Photo import | none | JPEG, PNG, WebP, HEIC via system picker; originals copied byte-for-byte | Unsupported/corrupt files listed with the reason | — |
| Reconstruction | Paired companion reachable on the local network | Real stage progress, diagnostics, provisional sparse preview, verified download | Not paired → pairing prompt. Unreachable → job waits and resumes; never fails for that reason alone | "On companion" |
| 3D viewer, editing, measurement, export | OpenGL ES 3.0 | Textured / solid / wireframe / evidence modes, holes, crop, delete, reorient, simplify, explicit hole repair, undo/redo, calibration, GLB/OBJ/PLY export | — | scale pill: "Uncalibrated — arbitrary units" / "AR-estimated ±x %" / "Calibrated ±x %" |
| AR placement | ARCore supported + installed + CAMERA permission | Plane detection, tap to place, drag/rotate, true size when a scale exists, explicit manual size otherwise, tracking-loss handling | Honest explanation + button to the normal 3D viewer. No camera-less "fake AR". | "True size (calibrated ±x %)" / "AR-estimated size" / "manual — not measured" / "Not to scale ×…" |
| Background processing | Foreground-service notification (permission optional) | Uploads/downloads continue in the background with an honest notification | Notification denied → still works while the app is open or the service runs silently | — |

## Companion computer

| | Minimum | Recommended | Notes |
|---|---|---|---|
| CPU | x86-64 with AVX, 4 cores | 8+ cores | All stages are CPU-only; no GPU, CUDA or OpenCL is used |
| RAM available to the container | 3.5 GB (`POCKET3D_MEMORY=3.5g`) | 10 GB (default) | With less memory the pipeline lowers depth-map and refinement resolution and reports it (`reduced_dense_resolution`, `reduced_refine_resolution`, `refine_skipped`) |
| Disk | ~2.2 GB image + photos + ~1 GB work data per running job | SSD | Work data is deleted when a job succeeds and after 24 h otherwise; results and photos stay until deleted from the phone |
| OS / runtime | Linux or macOS with podman or docker | — | Windows via WSL2 is untested |
| Network | Same LAN as the phone, inbound TCP 8443 | — | The companion's code opens no outbound connections; this is not enforced by a network policy (block egress in the host firewall if required) |
| ARM64 hosts | not built | — | The Containerfile is x86-64 only as shipped (pycolmap/Open3D wheels pinned for manylinux x86-64) |

Measured cost per preset on the example datasets: [MEASURED-RESULTS.md](MEASURED-RESULTS.md).

## Emulator vs. physical device

| | Android emulator (API 36, x86_64) | Physical phone |
|---|---|---|
| Companion address | `10.0.2.2` (always included in the pairing link) | LAN IP from the QR code |
| Camera capture | Emulated camera (virtual scene) — exercises the capture pipeline, not real optics | Real |
| ARCore | Only with the special "Google Play Services for AR … for emulator" APK; motion is synthetic | Real tracking |
| What it proves | Workflow, persistence, upload → reconstruction → download, viewer, editing, export | Additionally: real tracking, real coverage guidance, AR placement stability |

See [VERIFICATION.md](VERIFICATION.md) for what was actually exercised where.

## iOS

Not implemented. No iOS build or device test exists or is claimed.
