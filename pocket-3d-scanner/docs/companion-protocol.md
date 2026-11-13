# Companion protocol (v1)

This is the contract between the Android app and the local reconstruction companion, and
between the companion's HTTP server and its reconstruction pipeline worker. It is the single
source of truth; code on both sides is written against it.

## 1. Transport, pairing, authentication

* HTTPS only (TLS 1.2+). On first start the companion generates a self-signed EC P-256
  certificate and stores it in its data directory (`tls/cert.pem`, `tls/key.pem`). Clients never
  rely on the web PKI or hostnames: they **pin the SHA-256 fingerprint of the server
  certificate (DER)** obtained during pairing.
* Pairing material is shown only on the companion's own terminal:
  `pocket3d://pair?v=1&host=<ip>[,<ip>…]&port=<port>&fp=<sha256 hex of cert DER>&code=<pairing code>`
  rendered as a QR code and as text (host list, port, fingerprint in groups of 4, code).
* The pairing code is 8 characters from `23456789ABCDEFGHJKLMNPQRSTUVWXYZ`, single-use, expires
  after 10 minutes (a new one is generated and printed on expiry/use). Wrong attempts are
  rate limited per source address (5 in a row, then one every 12 s) and globally (30 in a row,
  then one every 2 s); they never rotate the code and never lock other devices out (§6).
* `POST /v1/pair` exchanges the code for a random 256-bit bearer token. Only the SHA-256 hash of
  the token is stored by the companion (`devices.json`). All other endpoints except
  `GET /v1/hello` require `Authorization: Bearer <token>`; failures are `401`.
* Each session/job is owned by the device that created it; other devices get `404`.
* No endpoint ever returns photographs to anyone but the owning device, and the companion's own
  code opens no outbound network connections. (This is a property of the code, not an enforced
  network policy: the container keeps its network namespace because it has to accept the phone's
  connections. Block egress in the host firewall if you need a guarantee.)

Addressing: a physical phone uses the companion's LAN IP (printed at start, embedded in the QR).
The Android emulator reaches the host's loopback through `10.0.2.2`.

## 2. Error format

Non-2xx responses carry `{"error": {"code": "<machine_code>", "message": "<human text>"}}`.
Codes used: `unauthorized`, `not_found`, `bad_request`, `pairing_failed`, `pairing_locked`,
`limit_exceeded`, `unsupported_format`, `checksum_mismatch`, `offset_mismatch`,
`incomplete_upload`, `conflict`, `insufficient_storage`, `server_error`.

## 3. Endpoints

All bodies are JSON (UTF-8) unless stated. Timestamps are Unix seconds (float).

### `GET /v1/hello` (no auth)
`{"product":"pocket3d-companion","api":1,"version":"1.0.0","server_id":"<uuid>","server_name":"<hostname>"}`

### `POST /v1/pair` (no auth)
Request `{"code":"ABCD2345","device_name":"Pixel 8","device_id":"<uuid, optional>"}` →
`200 {"token":"<hex>","device_id":"<uuid>","server_id":"<uuid>","server_name":"..."}`;
`403 pairing_failed`, `429 pairing_locked`.

### `GET /v1/status`
```
{"version":"1.0.0","api":1,"server_id":"…","server_name":"…",
 "hardware":{"cpu_model":"…","cpu_threads":28,"mem_total_mb":31791,"gpu":null},
 "resources":{"max_parallel_jobs":1,"job_threads":14,"job_memory_mb":10240,"disk_free_mb":123456},
 "queue":{"running":0,"queued":0},
 "limits":{"max_images":400,"min_images":3,"max_image_bytes":67108864,"max_image_pixels":80000000,
           "min_image_side":320,"max_session_bytes":8589934592,
           "formats":["jpeg","png","webp","heic"]},
 "presets":[{"id":"preview","label":"Preview","description":"…"}, …]}
```

### Sessions (an uploaded capture set)

`PUT /v1/sessions/{session_id}` — create or update. `session_id` is a client-generated UUIDv4
(lower-case, validated by regex). Body:
```
{"name":"Garden gnome",
 "capture": { …capture metadata, see §5… },
 "files":[{"id":"0001","name":"IMG_0001.jpg","size":3482211,"sha256":"<hex>"}, …]}
```
`id` matches `^[A-Za-z0-9_-]{1,32}$` and is unique in the session. `name` is metadata only: the
companion never uses client-supplied names as filesystem paths (stored as `originals/<id>.bin`).
Response (also returned by `GET /v1/sessions/{session_id}`):
```
{"session_id":"…","name":"…","created_at":…,"updated_at":…,"total_bytes":…,"received_bytes":…,
 "complete":false,
 "files":[{"id":"0001","size":3482211,"received":1048576,"complete":false,"error":null}, …]}
```
Re-PUT with a changed file list is allowed while no job of the session is queued/running
(`409 conflict` otherwise): files no longer listed are deleted, files whose `size`/`sha256`
changed are reset. Limits (`limit_exceeded`, HTTP 413/422) are enforced on count, per-file size
and session size; free disk space is checked (`507 insufficient_storage`).

`PUT /v1/sessions/{session_id}/files/{file_id}` — upload bytes, resumable. Headers:
`Content-Type: application/octet-stream`, `Upload-Offset: <n>`. The body is appended at offset
`n`, which must equal the bytes already stored, otherwise `409 offset_mismatch` with
`{"error":…, "received": <n>}` so the client can resume from the right place. The body may be
the whole remainder or a chunk. When the last byte arrives the companion verifies size and
SHA-256 (`422 checksum_mismatch`, file reset to 0) and validates that the file is a decodable
image of a supported format within the pixel limits (`422 unsupported_format`, file marked with
`error`). Response `{"id":"0001","received":…,"complete":true|false}`.

`GET /v1/sessions` → `{"sessions":[{"session_id","name","file_count","total_bytes","disk_bytes","jobs":[job ids]}]}`

`DELETE /v1/sessions/{session_id}` — cancels its jobs and deletes the companion's copies of the
photographs and all job data for the session. `204`.

### Jobs

`PUT /v1/jobs/{job_id}` — submit (idempotent; `job_id` is a client-generated UUIDv4). Body:
`{"session_id":"…","preset":"preview|standard|high","settings":{…optional overrides…}}`.
Requires the session upload to be complete (`409 incomplete_upload`). `201` (or `200` if the
identical job already exists) with the job object.

`GET /v1/jobs/{job_id}?since=<seq>&wait=<seconds ≤ 30>` — job object plus events with
`seq > since`; if there are none and the job is not terminal the request long-polls up to
`wait` seconds.
```
{"job":{"job_id":"…","session_id":"…","preset":"standard","settings":{…},
        "state":"queued|running|cancelling|succeeded|failed|cancelled|interrupted",
        "attempt":1,"queue_position":0,
        "created_at":…,"started_at":…,"finished_at":…,
        "stage":"dense","stage_index":5,"stage_count":10,
        "stage_progress":0.42,"overall_progress":0.61,"message":"Depth maps 21/50",
        "error":{"code":"insufficient_registration","message":"…","guidance":["…"]} | null,
        "diagnostics":{…latest merged diagnostics…},
        "artifacts":[{"name":"model.glb","size":…,"sha256":"…","kind":"model"}, …]},
 "events":[{"seq":12,"t":…,"type":"stage_progress","stage":"dense","progress":0.42,
            "overall":0.61,"message":"…","data":{…}}, …],
 "last_seq":12}
```
State semantics:
* `succeeded` only when the worker exited 0 **and** `out/result.json` exists, parses, and every
  artifact it lists exists with matching size and SHA-256. Anything else is `failed`.
* `failed` — the worker reported a diagnosed error (exit 2/3 + `error` event) or crashed.
* `cancelled` — the user cancelled; `interrupted` — the companion stopped/restarted while the
  job was running (found at startup with no live worker). Neither is ever shown as complete.
* `cancelling` is transitional while the worker process group is being terminated.

`POST /v1/jobs/{job_id}/cancel` → job object (idempotent; no-op on terminal states).
`POST /v1/jobs/{job_id}/retry` → re-queues a `failed`/`cancelled`/`interrupted` job
(`attempt += 1`; completed pipeline stages are reused from the job's work directory).
`DELETE /v1/jobs/{job_id}` → cancels if needed and removes job data. `204`.
`GET /v1/jobs?session_id=…` → `{"jobs":[job objects without events]}`.

`GET /v1/jobs/{job_id}/artifacts/{name}` — artifact bytes; supports `Range: bytes=a-` for
resumable download; `ETag` is the SHA-256. Artifacts may appear before the job finishes
(e.g. `sparse_preview.json`).

Artifact names: `sparse_preview.json` (kind `preview`, provisional), `model.glb` (kind `model`),
`cameras.json` (kind `cameras`), `diagnostics.json` (kind `diagnostics`), `pipeline.log`
(kind `log`).

## 4. Server ⇄ pipeline worker contract

The server runs each job attempt as a subprocess in its own process group:

`python -m pocket3d_companion.pipeline --job-dir <dir>`

```
<job-dir>/job.json        written by the server before launch (read-only for the worker)
<job-dir>/events.jsonl    appended by the worker, one JSON object per line
<job-dir>/work/           intermediate data + stage checkpoints (reused on retry)
<job-dir>/out/            artifacts; out/result.json is written last, atomically (tmp+rename)
<job-dir>/pipeline.log    human-readable log (worker stdout/stderr are redirected here by the server)
```
`job.json`: `{"job_id","session_id","preset","settings":{…},"attempt":n,
"originals_dir":"<abs path>","capture_path":"<abs path to capture.json>",
"files":[{"id","name","size","sha256"}],"limits":{"threads":n,"memory_mb":n}}`

Event line: `{"seq":n,"t":<unix>,"type":"stage_start|stage_progress|stage_end|diagnostics|artifact|warning|error|log","stage":"<id>","progress":0..1,"overall":0..1,"message":"…","data":{…}}`
(`seq` strictly increasing from 1 within an attempt file; the server re-numbers across attempts).
* `artifact` events: `data = {"name","size","sha256","kind"}` (file is complete in `out/`).
* `diagnostics` events: `data` is merged (shallow, by key) into the job's `diagnostics`.
* `error` events: `data = {"code","message","guidance":[…]}`.

Exit codes: `0` success (requires valid `out/result.json` =
`{"ok":true,"artifacts":[{"name","size","sha256","kind"}],"diagnostics":{…}}`), `2` diagnosed
reconstruction failure, `3` invalid input, anything else = crash. On `SIGTERM` the worker
terminates its own child processes and exits `130`.

Stage ids, in order: `ingest`, `features`, `matching`, `sfm`, `undistort`, `dense`, `mesh`,
`refine` (skipped unless the preset enables it), `texture`, `package`.

## 5. Capture metadata (`capture`)

Written by the phone, stored verbatim as `capture.json` in the session.
```
{"format":1,
 "source":"camera_ar|camera|import",
 "device":{"manufacturer":"…","model":"…","android_sdk":35},
 "frames":[
   {"id":"0001","name":"IMG_0001.jpg","timestamp_ms":1731333333000,
    "width":4032,"height":3024,          // stored pixel size, BEFORE applying EXIF orientation
    "exif_orientation":6,                // 1..8, as stored in the file (1 if absent)
    "intrinsics":{"fx":…,"fy":…,"cx":…,"cy":…,"source":"arcore|camera2|exif"} | null,
                                         // pixels, in stored (un-rotated) image coordinates
    "distortion":{"model":"opencv5","k":[k1,k2,p1,p2,k3]} | null,
    "pose":{"t":[x,y,z],"q":[x,y,z,w],"segment":0} | null,
                                         // AR tracking pose of the camera in the AR world frame:
                                         // camera-to-world, metres, world +Y = up (gravity),
                                         // camera axes OpenGL-style (+X right, +Y up, −Z forward)
                                         // relative to the STORED image orientation.
    "focus":{"locked":true,"distance_diopters":…} | null,
    "exposure":{"locked":true,"iso":…,"exposure_ns":…} | null,
    "quality":{"sharpness":…,"clipped_low":…,"clipped_high":…,"overlap":…},
    "flags":["blur","dark","duplicate","low_overlap","tracking_lost", …]}],
 "tracking":{"mode":"arcore|imu|none","segments":[{"segment":0,"frames":["0001",…]}]},
 "object_center_ar":[x,y,z] | null}
```
AR poses are *priors used for validation and metric scale estimation only*; the reconstruction
always re-estimates camera poses by structure-from-motion. Frames from different tracking
segments (tracking lost and re-initialised) are never assumed to share a coordinate system.

## 6. Clarifications (added by the server implementation — review and fold into §1–§4)

These are the decisions the server (`companion/pocket3d_companion/{server,jobs,storage,security}.py`)
took where the sections above were silent or ambiguous. They are exercised by `companion/tests`
(except the early-answer note for uploads, which is untested).

**Response shapes**
* "Job object" means the bare object `{"job_id":…, "state":…, …}`. `PUT /v1/jobs/{id}`,
  `POST …/cancel` and `POST …/retry` return it **bare**; only `GET /v1/jobs/{id}` wraps it as
  `{"job":…,"events":[…],"last_seq":n}`.
* `queue_position` is 1-based among queued jobs (1 = starts next) and `0` for a job that is not
  queued.
* `GET /v1/sessions` entries additionally carry `received_bytes`, `complete`, `created_at`,
  `updated_at`.
* `422 checksum_mismatch` and `422 unsupported_format` upload responses also carry `"received": 0`.
  `429 pairing_locked` carries `"retry_after": <seconds>` and a `Retry-After` header.

**Ids** — `session_id`/`job_id` must be lower-case UUID **version 4**
(`[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}`); `device_id` any
lower-case UUID; manifest file ids `[A-Za-z0-9][A-Za-z0-9_-]{0,31}`. Anything else is
`400 bad_request`. Artifact names must match `[A-Za-z0-9][A-Za-z0-9._-]{0,63}` (`400` otherwise);
`result.json` is reserved. All patterns are anchored to the whole string (`\A…\Z`): a trailing
newline is not accepted.

**JSON** — request bodies must be strict JSON that the server can store and return unchanged:
`NaN`/`Infinity`, lone UTF-16 surrogates and nesting deeper than 64 levels are `400 bad_request`
(nothing is created).

**Pairing** — the code is compared case-insensitively. Attempts are rate limited with token
buckets, checked *before* the code is looked at:
* per source address: `pairing_max_attempts` (5) attempts at once, refilled at one per
  `pairing_lock_s / pairing_max_attempts` (12 s). A source without tokens gets `429
  pairing_locked` with `retry_after` — also for the right code, because checking first would
  defeat the limit. A successful pairing refills that source's bucket.
* globally: 30 attempts at once, refilled at 0.5 per second, which bounds guessing from many
  addresses to a few hundred attempts per code lifetime against 32⁸ ≈ 10¹² codes.
* Wrong attempts do **not** rotate the code and do not affect other sources. (The first design —
  rotate and lock for everybody after 5 failures — let any LAN host keep pairing unusable;
  review finding R1-03.)
* The request body of `/v1/pair` is limited to 4096 bytes (`413` above).

**Device identity** — a `device_id` in the pairing request is honoured only together with proof
that the caller *is* that device: the request must carry the device's current token as
`Authorization: Bearer …`. Then the token is replaced (the old one stops working) and sessions
and jobs are kept. Without that proof — unknown id, missing or wrong token, revoked device — the
companion ignores the requested id and registers a **new** device with a fresh id, so knowing
another phone's id plus a valid pairing code never gives access to its data (R1-12). The phone
therefore keeps its token until re-pairing has succeeded.

**Limits** — HTTP `413` for byte sizes (a file above `max_image_bytes`, a session above
`max_session_bytes`, an upload body larger than the file's declared size, a JSON body above 8 MiB,
job `settings` above 16 KiB); HTTP `422` for counts (more than `max_images` or fewer than
`min_images` files in a manifest). A device may have at most 4 jobs queued or running
(`max_active_jobs_per_device`); creating another is `429 limit_exceeded`. Setting names that
start with `_` are reserved for the test worker and rejected with `400` by a companion that
runs the real pipeline.

**Retention** — the companion removes data nobody can use any more:
* a job's `work/` directory (undistorted images, depth maps, intermediate meshes — by far the
  largest part) is deleted as soon as the job **succeeds**, before the success becomes visible;
* `work/` of failed, cancelled and interrupted jobs is kept for `work_ttl_s` (24 h) so that a
  retry can reuse finished stages, then deleted by housekeeping (every 10 minutes); a retry
  after that simply starts from the first stage;
* a session whose upload was never completed and that no job refers to is deleted after
  `upload_ttl_s` (7 days) without activity;
* completed sessions, results and job records stay until the device deletes them or the device
  is revoked with `devices revoke --purge`. There is no total-disk quota beyond the per-session
  limits; the launcher prints the data directory so that it can be placed on a suitable volume.

**Sessions**
* A re-PUT with the same files (`id`,`size`,`sha256`) and the same `capture` is always accepted
  and only updates names. A change of the file list **or of `capture`** is the "changed" case
  (`409 conflict` while a job of the session is queued/running/cancelling).
* `Upload-Offset` defaults to 0. A file that is already complete reports `received = size`.
* A body that turns out larger than the declared size is rejected with `413` and the bytes of
  that request are discarded (earlier chunks are kept).
* After `unsupported_format` the stored bytes are deleted (`received` is 0) and the file's
  `error` is set until new bytes arrive or the manifest entry is replaced.
* Image validation checks the container structure (format, pixel size, PNG chunk CRCs) **and
  decodes the pixel data**: JPEGs through the decoder's 1/8-scale draft mode (cheap, still walks
  the whole entropy-coded stream), other formats in full up to 30 megapixels (larger non-JPEG
  images are structure-checked only). A truncated or corrupt file is `422 unsupported_format`.
  The pipeline's `ingest` stage decodes every image again at full size and still reports a file
  it cannot read (exit 3). Multi-picture JPEGs (MPO, e.g. with a gain map) are accepted as
  `jpeg`.
* If the server answers an upload early (`409`/`413`) while the phone is still sending, some
  HTTP stacks report a broken connection instead of the response. Clients should
  `GET /v1/sessions/{id}` to learn `received` before (re)starting any upload.

**Jobs**
* An identical re-PUT (same `session_id`, `preset`, `settings`) is `200`; the same `job_id` with
  different content is `409 conflict`.
* `retry` needs a complete session (`409 incomplete_upload`) and a retryable state (`409 conflict`
  otherwise). It resets stage/progress/error/diagnostics/artifacts, clears `out/`, keeps
  `work/` — unless the session's files or capture changed since the last attempt, in which case
  `work/` is cleared too.
* Events returned to clients are normalised: every key of the event object is present,
  `stage`/`progress`/`overall` may be `null`, `data` is always an object, and `seq` is assigned
  by the server (1, 2, 3 … over all attempts of the job, stable across companion restarts).
  A response carries at most 2000 events; `last_seq` is the `seq` of the last event returned
  (or the newest `seq` if none was returned) — keep polling with `since=last_seq`.
* A long-poll returns early when events arrive **or the job's state changes**.
* Error codes the server itself puts into `job.error.code`: `memory_limit`, `timeout`,
  `worker_crashed`, `invalid_result` (exit 0 without a verifiable `out/result.json`),
  `worker_launch_failed`, `server_error`; plus `reconstruction_failed` / `invalid_input` when the
  worker exits 2 / 3 without an `error` event.
* Error codes of the pipeline (exit 2, with `guidance` for the user) include
  `insufficient_registration`, `dense_failed`, `mesh_failed`, `refine_failed`, `texture_failed`,
  `out_of_memory`, `tool_failed`, `tool_timeout`, `tool_missing` and **`no_parallax`**: the photos match each other but ≥ 90 % of the verified pairs are explained
  by a homography alone (COLMAP two-view configuration `PLANAR_OR_PANORAMIC`, `PANORAMIC`,
  `WATERMARK` or `DEGENERATE`), i.e. the camera turned on the spot. It is raised before mapping, and again after
  mapping when the solved camera centres do not move relative to the scene depth.
* `cameras.json` states its conventions in the file: poses are camera-to-model, GL axes, for
  the upright photo; `fx, fy, cx, cy` describe the **undistorted** upright working image
  (`distortion: "removed: …"`); the solved lens models per camera group, including distortion
  coefficients and whether the focal length was held at the capture value, are under
  `calibration`.
* `diagnostics.peak_rss_mb` (a number) is owned by the server: the peak resident memory of the
  worker's whole process tree. If the worker reports a `peak_rss_mb` of its own — the pipeline
  does, as an object of per-stage values — the server exposes that as
  `diagnostics.peak_rss_mb_by_stage` instead of letting the type of `peak_rss_mb` vary.
  (The `diagnostics.json` artifact is the worker's file and is not rewritten.)
* Artifacts of a job that did not succeed: only those of kind `preview` or `diagnostics` that the
  worker announced, plus `pipeline.log`. `pipeline.log` (kind `log`) is added by the server at
  the end of every attempt; while the job runs it can be downloaded live (unlisted, no `ETag`).
* A job found `cancelling` at start-up becomes `interrupted`, like a `running` one. On a
  graceful stop (SIGTERM/SIGINT) running workers get SIGTERM, then SIGKILL after 5 s, and their
  jobs become `interrupted`; queued jobs stay queued.

**Worker contract (§4)**
* `stage_start` events should carry `data = {"index": <0-based position among the stages this
  job will run>, "count": <number of those stages>}`; the server copies them to
  `stage_index`/`stage_count` (fallback: position in the 10-stage list).
* The worker runs with cwd `<job-dir>/work`, stdin `/dev/null`, and the environment variables
  `POCKET3D_JOB_THREADS`, `POCKET3D_JOB_MEMORY_MB`, `OMP_NUM_THREADS`, `OPENBLAS_NUM_THREADS`,
  `MKL_NUM_THREADS`, `NUMEXPR_NUM_THREADS` (same values as `job.json` → `limits`).
* The memory limit is enforced by the server: it sums the resident memory of the worker's
  process tree about once per second and kills the whole process group (SIGKILL, no SIGTERM)
  above `limits.memory_mb`.
* `result.json` must list at least one artifact. It may list `pipeline.log`; if `out/pipeline.log`
  does not exist the server publishes `<job-dir>/pipeline.log` instead.
* A last line of `events.jsonl` without a trailing newline is ignored until it is completed;
  lines that are not JSON objects are skipped.
