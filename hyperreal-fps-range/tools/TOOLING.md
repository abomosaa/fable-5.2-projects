# Shared tooling (for automated build/verification on this workstation)

All paths are relative to the repo root `/home/h4ni0/benchmark/fable-5.2/hyperreal-fps-range/fable-5.2`.

| Tool | Path |
|---|---|
| Godot 4.7.2 stable (editor binary, also runs projects) | `tools/vendor/godot/Godot_v4.7.2-stable_linux.x86_64` |
| Blender 4.5 LTS (headless: `blender -b --python script.py`) | `tools/vendor/blender/blender` |
| Python venv with numpy/scipy/soundfile/matplotlib/pillow | `tools/vendor/pyenv/bin/python` |
| wf-recorder (real-time screen+audio capture of the virtual output) | `tools/vendor/wf-src/build/wf-recorder` |
| ffmpeg / ffprobe / ImageMagick (`magick`) | system |

## Running a Godot window WITHOUT touching the user's desktop

The user's real monitors and speakers must not be disturbed. A virtual 1920x1080 Hyprland
output named `FPSRANGE` exists, plus a compositor rule: any Godot project whose
`application/config/name` starts with `fpsr-` opens there as an unfocused floating
1920x1080 window. So:

```bash
source tools/capture/env.sh        # exports WAYLAND_DISPLAY, HYPRLAND_INSTANCE_SIGNATURE, GODOT, PY, CAP_SINK...
cap_setup                          # idempotent
PULSE_SINK=$CAP_SINK $GODOT --path <project_dir> --display-driver wayland [-- your args]
```

* ALWAYS set `PULSE_SINK=$CAP_SINK` (a null sink) so nothing plays on the user's speakers.
* NEVER use `hyprctl dispatch`/focus commands that move the user's focus, and never launch windows
  whose project name does not start with `fpsr-`.
* Several agents share that virtual output, so do NOT rely on `grim` screenshots of it. Capture
  from inside the engine instead: `get_viewport().get_texture().get_image().save_png(path)` after
  a few rendered frames (wait ≥ 30 frames so GI/TAA/exposure settle), then `get_tree().quit()`.
* `--headless` gives a dummy renderer (no images) but is fine for import (`--headless --import`),
  logic tests and scripts.
* Always make scripts self-terminate (quit after N frames / seconds); wrap runs in `timeout 120`.

## Rebuilding the capture tools (only needed for re-running the verification captures)

* `wf-recorder` (MIT): `git clone https://github.com/ammen99/wf-recorder tools/vendor/wf-src`, apply
  `tools/capture/wf-recorder-ffmpeg9.patch` (three FFmpeg ≥ 8 API changes in `src/frame-writer.cpp`), then
  `meson setup build --buildtype=release && ninja -C build`.
* Python: `uv venv tools/vendor/pyenv --python 3.12 && uv pip install --python tools/vendor/pyenv/bin/python numpy scipy soundfile matplotlib pillow`.
* Blender 4.5 LTS portable in `tools/vendor/blender/` (asset pipelines under `tools/build/` only).
* `tools/capture/env.sh teardown` removes the virtual output and the null sink again.

## Frame-pacing attribution (added for review rounds 4–5)

* The game logs every frame longer than 34 ms as a `hitch` event with the wall clock when an event log is open
  (capture runs only).
* `tools/capture/loadlog.sh <out.csv>` — 4 Hz machine-wide log (load average, cgroup memory and memory-limit
  events, kernel pressure-stall totals); analysed with `tools/analysis/hitch_load.py <events.jsonl> <load.csv>`.
* `tools/capture/procwatch.py <out.csv> [interval]` — per interval: CPU time of the game, of this session's other
  processes and of all outside processes (top three named), and how long the game's threads waited for a CPU
  (`/proc/<pid>/task/*/schedstat`); analysed with `tools/analysis/hitch_procs.py <events.jsonl> <procwatch.csv>`.
  Start it in the background before `tools/capture/run.sh …` and kill it afterwards. Reads `/proc` only.
* `tools/analysis/sight_track.py <capture.mkv> <shot time in the video> …` — template-matches the rear sight after
  each given shot and prints its offset from the pre-shot position per frame.
