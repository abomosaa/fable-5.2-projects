# Cutline architecture

Cutline is a Rust video editor that runs anywhere a browser and FFmpeg run: one
server binary (with the web UI embedded) does the editing, media processing and
rendering; the browser is the workspace.

```
┌──────────────────────────── browser ────────────────────────────┐
│ media bin · preview monitor · inspector · transcript · timeline  │
│   read-only mirror of the project document + resolved layers     │
└───────▲──────────────── commands (HTTP) ─────────────┬───────────┘
        │ changes / status (SSE)                       ▼
┌───────┴──────────────── cutline-server (axum) ──────────────────┐
│ projects (autosave, undo history) · assets (probe, proxy,        │
│ thumbnails, waveform) · transcription jobs (Soniox) · render     │
│ jobs (FFmpeg) · assistant (Pi SDK sidecar) · embedded web UI     │
└───────▲──────────────────────────────────────────────────────────┘
        │ pure function calls
┌───────┴──────────────── cutline-core (no I/O) ──────────────────┐
│ time model · project document · commands · undo/redo sessions ·  │
│ resolved layers · transcript mapping · captions · render plans   │
└──────────────────────────────────────────────────────────────────┘
```

| Path | What it is |
| --- | --- |
| `crates/core` | Deterministic engine. No I/O, clocks or randomness. |
| `crates/server` | HTTP API, persistence, media pipeline, Soniox client, FFmpeg runner, assistant bridge. Binary: `cutline`. |
| `web/` | The UI: plain ES modules + Preact/htm (vendored). No build step; embedded into the binary. |
| `sidecar/` | Node sidecar running the Pi SDK for the live editing assistant. |
| `e2e/` | Playwright browser tests. |

## One timeline representation

Everything — the timeline view, the preview, the transcript, captions and the
export — is derived from the same **project document** (`core::model::Project`).
The browser never edits it. It sends a typed **command** with the revision it was
made against; the server validates and applies it atomically and answers with a
**change** (document patch + re-resolved layers + history state). There is no
UI-only editing state that could drift from what gets rendered.

### Time model (`core::time`)

All times are integer **ticks**: 1 tick = 1/705 600 000 s ("flicks"). That base
divides evenly by every common frame rate (24, 25, 30, 50, 60 and the NTSC rates)
and audio sample rate, so frame and sample boundaries are exact integers and
nothing drifts.

Three time domains are distinct Rust types, so they cannot be mixed up:

| Type | Meaning |
| --- | --- |
| `TimelineTime` | Position on the output timeline. Always frame-aligned for edit points. |
| `ClipTime` | Position relative to a clip's first output frame. |
| `SourceTime` | Position inside a source media file. |

A clip stores `start`/`duration` (timeline), `source_in` (source) and an exact
rational `speed`; conversions only happen through `Clip::clip_time`,
`Clip::source_time_at` and `Clip::timeline_time_of`. Frame/timebase conversion
(`FrameRate::frame_to_ticks`, `ticks_to_frame_*`, `snap`) is exact for all supported
rates.

### Document (`core::model`)

`Project` holds settings (resolution up to 4096×2160, frame rate up to 60 fps,
sample rate, background, caption style), immutable `AssetInfo` facts, ordered
tracks (video / audio / caption), clips, transitions, markers, and the
transcript-editing overlay (corrections, speaker names, removal audit trail).
Ids are generated from a counter inside the document, so edits are reproducible.

Clips carry `link_id` (A/V link, DaVinci Resolve style) and `group_id`. A video
asset with sound becomes a **linked** video clip + audio clip; with *linked
selection* on they select, move, trim and split together, Alt-click addresses one
side, and the timeline flags linked clips that drift out of sync (with "Move into
sync").

### Commands (`core::commands`)

About forty commands cover every mutation (add / move / trim / slip / split /
delete / ripple / duplicate / paste / speed / properties / link / group /
transitions / tracks / markers / settings / transcript edits / captions / batch).
`apply(project, command, env)` works on a private copy, normalises it (prunes
transitions whose clips no longer touch, dissolves one-member links, clamps fades)
and validates every invariant (no overlaps, frame alignment, source ranges inside
the media, …). Any error leaves the project untouched — commands are atomic.

Edit semantics worth knowing:

* **Overwrite** is the default placement (like professional NLEs): placing or
  moving a clip replaces what is under it. **Insert** ripples later material.
* **Ripple delete / ripple trim** shift later clips on *all unlocked tracks* by one
  common amount so tracks stay in sync. If a clip on another track still overlaps
  the removed range, the gap is closed as far as possible and a notice is returned.
* **Transitions** are centred on a cut and use spare source media ("handles");
  where a clip has none, the first/last frame is held, so a transition can always
  be added.

### Sessions, revisions, undo (`core::history`)

A `Session` is a document plus its undo history. Every command must name the
revision it was made against; a mismatch is rejected as `stale_revision` and
nothing changes. Each committed command records a forward and a backward
**patch** (a diff of the document); undo/redo apply them, are validated like any
edit, and bump the revision. History is bounded by entries and weight and is
persisted, so undo survives a restart.

### Resolved layers (`core::resolve`)

Clip fades and transitions are resolved into concrete, time-stamped **layers**:
active extent (including transition handles), source position, opacity/gain ramps,
slide motion, gain, paint rank. The browser preview and the FFmpeg render plan both
consume these layers — neither re-implements transition semantics — which is what
keeps preview and export consistent.

## Media pipeline (`server::import`, `server::assets`)

Upload (streamed to disk) → `ffprobe` → the asset's facts are added to the project
→ in the background: poster, filmstrip sprite, waveform peaks, preview audio (AAC),
speech audio (FLAC 16 kHz mono) and a 720p H.264 proxy with short GOPs. An asset
is usable on the timeline as soon as probing succeeds. Probe failures (not media,
no streams, zero duration, missing FFmpeg) are classified into actionable messages.
The preview plays proxies; **exports always read the original files**.

## Preview (`web/js/player`)

A transport clock (monotonic, frame-accurate) is the single source of "now".
Media elements are slaved to it: one `<video>` per active picture layer (pre-rolled
before cuts, reused across source-contiguous splits), one `<audio>` per audible
layer routed through WebAudio gain nodes. A WebGL compositor (2D-canvas fallback)
draws layers with the same layout, colour and text conventions as the exporter.

## Transcript-based editing

* **Provider**: Soniox Files + async transcription APIs (`server::soniox`), model
  `stt-async-v5` by default, with speaker diarization and language identification.
  The key (`SONIOX_API_KEY`) is read only by the server and never serialised.
* **Jobs** (`server::transcription`): queued → uploading → processing → completed /
  failed (retryable or not) / cancelled, persisted per asset and resumable after a
  restart. Remote files and transcriptions are deleted when a job completes, fails
  or is cancelled, and when a project is deleted.
* **Normalisation** (`core::soniox`): provider tokens are stored verbatim; a
  word-level view (merged sub-word tokens, attached punctuation, per-word timing,
  speaker, language, confidence) points back into them.
* **Mapping** (`core::mapping`): the *timeline transcript* — the words audible in
  the current edit, each with its exact timeline time — is derived from the
  document and the per-asset transcripts. It follows cuts, gaps, overlapping
  clips, speed changes and removed ranges by construction.
* **Edits**: deleting words is `RippleDeleteSource` — the source ranges are mapped
  through the clip that shows them, the clip (and its linked partner) is cut and
  the gap is rippled closed; every cut is recorded in an audit trail (asset, source
  range, timeline range, reason, text). Removed ranges stay visible in the
  transcript and can be restored structurally (`HealCuts`).
* **Corrections** are an overlay keyed by word index in the project document
  (undoable). The provider's tokens and timings are never modified, and corrected
  words are marked in the UI together with their original text.
* Filler-word review, silence detection (from the real waveform, protecting spoken
  words), caption generation and transcript-based rough cuts all produce ordinary
  commands.

## Export (`core::render`, `server::render`)

`build_plan` turns the document + layers into a deterministic **render plan**: the
timeline is split into frame-aligned chunks; each chunk is one FFmpeg process with
a filter graph that composites the layers (crop, scale, rotate, flip, colour,
opacity, fades, slides, text and captions via `drawtext`), mixes the audio
(speed, gain, fades) and writes an intermediate with an exact frame and sample
count; chunks are joined without re-encoding the picture and the audio is encoded
once. Chunking bounds the graph size and open inputs for large projects, enables
parallel rendering, real progress, cancellation and precise failure reporting.
H.264, H.265 and VP9 are supported up to 4096×2160 at 60 fps.

## Assistant (`core::tools`, `server::assistant`, `sidecar/`)

The assistant never edits the document directly. Each tool call is validated in
`core::tools` and turned into a core command, so AI edits get the same validation,
revisioning and undo as UI edits. Live mode runs the model loop in a Node sidecar
built on the Pi SDK (`@mariozechner/pi-agent-core`); tool calls round-trip to the
Rust server over stdio. Fixture mode replaces the model with a deterministic,
clearly labelled rule-based planner that uses the same tool path.

## Persistence

`<data>/projects/<id>/project.json` is written atomically (temp file + fsync +
rename) after every committed change — that is the autosave. `history.json` is
flushed shortly after edits and on shutdown. `<data>/assets/<id>/` holds the
original media and everything derived from it; assets are owned by projects and
deleted with their last owner. `<data>/exports/<job>/` holds finished exports.

## Performance notes

* Core operations are linear in the number of clips at worst; on a 6 000-clip
  project a split takes ~20 ms end to end on the server.
* Changes are sent as patches (changed clips and layers only), not whole documents.
* The timeline is canvas-drawn and virtualised: only clips intersecting the
  viewport are drawn and mirrored into the DOM (for accessibility and hit
  testing); it stays at 60 fps while scrolling, zooming and playing with thousands
  of clips.
* The preview engine indexes layers by time, so per-frame work depends on what is
  on screen, not on project size.
* Rendering is chunked and parallel; proxies keep 4K sources smooth in the browser.

## Assumptions

* Single user, local or trusted network. There is no authentication; bind to
  `127.0.0.1` (the default) unless you add your own access control.
* FFmpeg 6.1 or newer on the server.
* Media import is not part of the undo history (removing an asset from the bin is).
* Text is rendered with the bundled Inter font so preview and export match; lines
  break only where the user puts line breaks.
* Fixture mode exists for review and tests: transcripts and the assistant are
  deterministic and labelled as fixture data in the UI. Live mode uses the real
  Soniox API and the real Pi SDK.
