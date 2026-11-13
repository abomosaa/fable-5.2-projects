# Cutline

A video editor written in Rust that runs anywhere a browser and FFmpeg run. One
server binary does the editing, media processing and rendering and serves the
workspace UI (embedded in the binary — no front-end build step).

* Multitrack timeline with linked A/V clips (DaVinci Resolve style), snapping,
  trim / ripple trim, split, ripple & lift delete, duplicate, groups, transitions,
  speed, fades, text, captions, transform / crop / colour, markers.
* Frame-accurate preview that stays in sync with the playhead across cuts.
* Transcript-based editing on Soniox: searchable synchronized transcript, delete
  words to cut video, filler and silence removal, corrections that keep the
  original tokens, captions, rough cuts.
* Real exports rendered by FFmpeg (composited video, mixed audio, text, captions)
  up to 4K at 60 fps, with progress, cancellation and actionable errors.
* Transactional undo/redo, autosave, and full restore after a restart.

## Requirements

* Rust 1.85+ (the repo pins 1.95 via `rust-toolchain.toml`)
* FFmpeg and ffprobe 6.1 or newer on `PATH` (or `FFMPEG_PATH` / `FFPROBE_PATH`)
* A current Chromium, Firefox or Safari
* Optional: Node 20+ for the browser tests and for the live editing assistant

## Run

```bash
# Review / demo mode: no external services, deterministic fixture speech data
cargo run --release -- --fixture

# Live mode: real Soniox transcription
cp .env.example .env        # then set SONIOX_API_KEY
cargo run --release
```

Open <http://127.0.0.1:4310>. Projects, media and exports are stored in `./data`
(`--data-dir` to change, `--port` / `--host` for the address; `cargo run -- --help`
lists everything).

### Fixture mode vs live mode

| | Fixture mode (`--fixture`) | Live mode (default) |
| --- | --- | --- |
| Transcripts | Deterministic synthetic speech, labelled **Fixture** everywhere it appears | Soniox Files + async transcription API, model `stt-async-v5` (`SONIOX_MODEL` to change), speaker diarization and language identification on |
| Assistant | Rule-based planner, labelled as not being an AI model | Pi SDK (`@mariozechner/pi-agent-core`) in `sidecar/` — run `npm ci --prefix sidecar` once and set a provider key such as `ANTHROPIC_API_KEY` |
| Network | None | Soniox, and your LLM provider if you use the assistant |

`SONIOX_API_KEY` and provider keys are read only by the server. They are never
sent to the browser, logged or written to project files. In live mode without a
key, transcription jobs fail with a message saying so — nothing is faked.

Media editing, preview and export behave identically in both modes.

## Using it

1. **New project** on the start page, then **Import** (or drop files on the media
   bin): video, audio, images, `.srt` / `.vtt`. Clips are usable as soon as they
   are analysed; previews, filmstrips and waveforms follow.
2. Drag media to the timeline or double-click it to append. Video with sound
   arrives as a linked pair.
3. Edit: drag to move, drag edges to trim (hold Ctrl/⌘ for ripple trim), `S` to
   split, `Delete` / `Shift+Delete` for lift / ripple delete. Right-click anything
   for more. Press `?` for all shortcuts.
4. **Transcript** tab → *Enable transcript editing*. Click words to seek, select
   words and press `Delete` to cut them out of the video, use *Clean up* for filler
   words and silences, *Captions* to generate captions, *Source* for rough cuts.
5. **Export** → pick size, frame rate, codec and quality. The finished file plays
   in the dialog and can be downloaded.

Linked selection (chain button, `Ctrl/⌘+Shift+L`) works as in Resolve: when on,
linked video and audio select, move, trim and split together; Alt-click targets
one side; clips that drift apart show a red offset badge and can be moved back
into sync from the context menu.

## Tests

```bash
cargo test --workspace            # ~400 tests, no network or secrets needed
cd e2e && npm ci && npx playwright test   # browser tests (starts its own fixture server)
node --test sidecar/test/         # Pi SDK sidecar protocol tests (after npm ci --prefix sidecar)
```

What they cover:

* **Core** (`crates/core/tests`): frame/timebase conversion and source-time
  arithmetic; every command (validation, atomic rejection, trim / split / ripple
  semantics, transitions, links); undo/redo round trips, stale-revision rejection
  and persistence round trips; a seeded random-edit soak that checks invariants
  after every step; Soniox token and status normalisation; transcript ⇄ timeline
  mapping across gaps, overlapping clips, speed changes and removed ranges;
  captions; silence detection; render-plan generation; assistant tool-argument
  validation.
* **Server** (`crates/server`): media-probe failure classification; project
  persistence across restarts; the transcription job lifecycle and remote cleanup
  with deterministic adapters; real FFmpeg renders checked at pixel and sample
  level (cuts, speed, transitions, text, captions, mixing, 4K60, cancellation,
  failures); a full HTTP round trip from upload to export; the assistant bridge
  against the real Pi sidecar with a local mock model endpoint.
* **Browser** (`e2e/tests`): with generated media — import, add to the timeline,
  split, trim, a transcript-linked ripple edit, captions, save and reload, and an
  export that is verified to be a playable H.264 file with audio and the exact
  expected frame count.

The render and import tests need FFmpeg; the browser tests use an installed
Playwright Chromium (`npx playwright install chromium` if you have none, or set
`CHROME_PATH`).

## Layout

```
crates/core      deterministic engine: time, document, commands, undo, layers,
                 transcript mapping, captions, render plans, assistant tools
crates/server    HTTP API, persistence, media pipeline, Soniox, FFmpeg, assistant
web/             the UI (ES modules + vendored Preact/htm, embedded at build time)
sidecar/         Pi SDK sidecar for the live assistant
e2e/             Playwright tests
docs/            architecture notes
```

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the time model, the command
and revision model, how transcript edits map to source ranges, and how the render
pipeline works.

## Assumptions and limits

* Single user on a local or trusted network; there is no authentication. The
  server binds to `127.0.0.1` by default.
* Importing media is not an undo step (removing media from the bin is).
* Text and captions render in the bundled Inter font so the preview and the
  export match; lines break only where you put line breaks.
* The preview plays 720p proxies; exports always use the original files. Preview
  and export share layout, colour and text rules but are different renderers, so
  small sub-pixel differences are possible.
* Cross dissolves keep the outgoing picture opaque under the incoming one (a true
  dissolve for full-frame clips; for picture-in-picture clips the outgoing clip
  does not fade).
* Ripple edits move every unlocked track by the same amount to keep sync; when a
  clip on another track is in the way the gap is closed as far as possible and you
  are told.
* Caption generation replaces previously generated captions and leaves captions
  you edited by hand alone.
* A cancelled Soniox upload whose file id was never received cannot be cleaned up
  remotely (the id is unknown); every other path deletes remote files and
  transcriptions on completion, failure, cancellation and project deletion.
