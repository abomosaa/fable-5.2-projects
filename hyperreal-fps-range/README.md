# Range Day

A first-person pistol range: one deeply modelled firearm (a P38/P1-pattern 9 mm service pistol), a compact
outdoor range with a covered firing bay and an open firing position, paper, steel and breakable targets.
Native Linux application built on Godot 4.7.2 (Forward+ / Vulkan, Jolt physics, Steam Audio HRTF).

Entertainment simulation. Not firearms instruction; no claim to reproduce real recoil force or sound pressure.

**Honest status:** built and checked by AI agents that cannot hear and that drive the game through scripted
input. Audio was verified by loopback capture and signal analysis only; nobody has listened to it or played with
their own hands. An independent reviewer scored the result 5.5–7.5 out of 10 per category (7 = current
high-fidelity commercial FPS). Frame pacing was smooth only when the test machine was otherwise idle; with other
applications competing for CPU, GPU or memory the game stuttered (details in `docs/VERIFICATION.md`). See
`docs/KNOWN_ISSUES.md` and `reviews/SUMMARY.md`.

## Run

```bash
./setup.sh     # once, needs network: fetches the pinned engine build (sha256-checked), imports assets, exports the game
./run.sh       # play (offline from here on)
```

`setup.sh` installs nothing outside this directory. All models, textures and sounds are bundled in `game/assets`
(see `ASSETS.md` for authors and licences). `tools/check_assets.sh` verifies that nothing essential is missing.
Without the exported build `./run.sh` falls back to the vendored engine binary running `game/` directly.

Requirements: x86-64 Linux, Vulkan 1.2+ GPU, PipeWire/PulseAudio or ALSA. Developed and measured on an Intel Arc
B580 at 1920×1080 (numbers in `docs/VERIFICATION.md`).

**Audio starts at a conservative level (master 60 %).** Raise it only to a comfortable level; "Headphones" and
"Night" dynamic-range modes are in *Menu → Settings → Audio*.

## Controls (defaults, all remappable in *Menu → Controls*)

| Input | Action |
|---|---|
| W A S D | Move |
| Shift (hold, moving forward) | Jog (gun lowers) |
| C / Ctrl | Crouch (toggle by default) |
| Mouse | Look |
| Right mouse (hold) | Aim down the sights |
| Alt (hold, while aiming) | Steady the hold for a few seconds |
| Left mouse | Trigger. First shot from a lowered hammer is a long double-action stroke; release early to abort |
| R | Reload (takes the fullest spare magazine; pressing the trigger before the magazine is released cancels it) |
| V | Safety / decocking lever on the slide |
| G | Thumb-cock the hammer (single-action first shot) |
| F | Inspect the pistol |
| [ / ] | Move the selectable paper target nearer / farther (7, 10, 15, 25 m) |
| Backspace | Reset targets |
| T | Inspect shot groups (true-scale target view, group size, score) |
| F5 | Restart session (refills the six magazines) |
| F1 | Cycle overlays (controls → hidden → practice read-out → both) |
| Esc | Pause / menu |

The default presentation has no crosshair, hit markers, ammunition counter or score pop-ups. An optional practice
read-out (chamber, magazine, hammer, safety, last hit) and an optional centre dot are in the settings.

## The range

* **Covered firing bay** — four lanes with benches and plywood dividers under a corrugated steel roof
  (you start here, lane 3). Sound: strong early reflections from roof, slab, dividers and walls plus a short
  reverberation.
* **Open firing position** — the pad to the right of the bay, in full sun. Sound: ground reflection, the natural
  recorded outdoor tail, slap-back from the berms.
* Walk between them; the acoustics change continuously with position (there is no reverb switch).
* Targets: paper bullseyes on stands at marked distances with persistent, exactly placed holes; hanging steel
  gongs at 10–50 m that swing and ring; glass, clay and tin on shelves. Details in `docs/VERIFICATION.md`.

## What is in this repository

| Path | Content |
|---|---|
| `game/` | The Godot project (scripts, scenes, bundled assets, tests) |
| `docs/REFERENCES.md` | Real-world references with measured / observed / approximated tags |
| `docs/APPROXIMATIONS.md` | What is simplified in the weapon, ballistics, audio, physics and rendering |
| `docs/ARCHITECTURE.md`, `docs/WEAPON_CONTRACT.md` | Module contracts, weapon/animation interface |
| `docs/VERIFICATION.md` | Measured performance, timing, audio analysis, test results, how to reproduce |
| `docs/KNOWN_ISSUES.md` | What still looks, sounds or behaves wrong, from the independent reviews |
| `ASSETS.md`, `docs/manifest/*.json` | Asset manifest: author, source URL, licence, local path, checksums |
| `reviews/` | Five independent realism reviews (`SUMMARY.md` is the index) with the reviewer's own captures |
| `evidence/` | Captures, screenshots and measurements per review round (`round5/` is the delivered build) |
| `tools/build/` | Reproducible asset pipelines (Blender / Python) |
| `tools/capture/`, `tools/analysis/` | Scripted-input capture with loopback audio, analysis scripts |

## Tests

```bash
tools/vendor/godot/Godot_v4.7.2-stable_linux.x86_64 --headless --path game --script res://tests/run_tests.gd
```

Deterministic tests of the weapon state machine and ammunition conservation, ballistics, projectile collision
boundaries (thin targets, edges, walls), target scoring/reset, audio-event scheduling and UI statistics.

## Settings

Saved to the Godot user directory (`~/.local/share/godot/app_userdata/fpsr-range/settings.cfg`, `controls.cfg`).
Field of view, aim zoom, sensitivity, hold/toggle options, camera-motion and weapon-sway scales (0 disables),
master/ambience volume, dynamic range, HRTF/stereo, quality presets, render scale, V-Sync, FPS cap, fullscreen,
overlays, HUD scale, high-contrast HUD, reduced flashes. Motion blur is not rendered by this build.
