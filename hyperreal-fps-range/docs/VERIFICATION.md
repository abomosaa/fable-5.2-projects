# Verification

What was actually run and measured, with the evidence each number comes from. The section *Final build* directly
below lists what was re-run on the build that is delivered (`evidence/round5/`). The longer body further down is
the **round-3** evidence set (`evidence/round3/`): it covers things that were not changed afterwards (audio
analysis in detail, preset benchmarks, impact timing) and is kept as measured then. `evidence/round4/` is an
intermediate build (reviewed in `reviews/round4/REVIEW.md`); rounds 1–2 are kept because the earlier reviews
refer to them.

**Nobody listened to the audio or played with their own hands.** The build and its checks were done by AI agents
that cannot hear and that drive the game through scripted input. Audio is verified by loopback capture and
signal analysis; "feel" is not verified at all. Independent reviews: `reviews/round1/REVIEW.md`,
`reviews/round2/REVIEW.md`, `reviews/round3/REVIEW.md`, `reviews/round4/REVIEW.md`, `reviews/round5/REVIEW.md`
(summary: `reviews/SUMMARY.md`). What is still wrong: `docs/KNOWN_ISSUES.md`.

## Setup

| | |
|---|---|
| Machine | Intel Core i7-14700K, 32 GB RAM, Intel Arc B580 12 GB (Mesa 26.2.6, Vulkan), Linux 7.3 (CachyOS), PipeWire 1.6 at 48 kHz |
| Build | Godot 4.7.2-stable, Forward+; project `game/` run with the vendored engine binary; the exported standalone build was checked separately (below) |
| Display | 1920×1080 virtual output of the running Hyprland compositor (60 Hz), game window compositor-fullscreen (round 1 recordings had a desktop bar over the top 45 px; round 2 does not) |
| Quality | preset **High** (default), render scale 1.0, MSAA 4x, vertical FOV 62°; other settings at defaults unless stated |
| Input | scripted: `game/scripts/core/autoplay.gd` injects action presses and relative mouse motion through `Input.parse_input_event` — the same path as real input. Aiming is done by turning the view with mouse motion until the sights line up; shots are not placed by code |
| Capture | `tools/capture/run.sh … --record`: wf-recorder (wlr-screencopy) of the virtual output at 60 fps + the game's audio from a PipeWire null-sink monitor (loopback, FLAC) in one MKV; the game writes `events.jsonl` (simulation events, shots, bullet hits, audio voices, state dumps) |
| Analysis | `tools/analysis/analyze_capture.py`, `impact_excess.py`, `bursts.py`, `bands.py`, `sight_track.py`, `hitch_load.py`, `hitch_procs.py` (with `tools/capture/loadlog.sh`, `procwatch.py`) |

Reproduce: `tools/capture/run.sh tools/capture/scripts/<name>.json <out_dir> [--record] [--no-vsync]` (needs a
Hyprland session; see `tools/TOOLING.md`). Each run uses a throw-away settings profile.

**Conditions of the round-3 runs:** the machine was shared with another CPU-heavy job (load average ≈ 9–12) and
the process group was memory-capped (soft limit 4 GB, hit 2174 times in the session). Rounds 1–2 were recorded on
an otherwise idle, uncapped machine. Where that matters it is said below.

## Final build (`evidence/round5/`)

Changes after the third and fourth reviews: the recoil return error is applied about the eye, varies in direction
and is steered out by a damped correction (round 4 had it always upward, parked, then gliding — the reviewer called
that mechanical); a separate small error of the gun in the hands (front post off-centre in the notch); trousers
re-textured and hips moved back (a dark crescent beside the boot is gone); soft contact shade under the boots; a
weak hands-only fill light under the roof; every frame over 34 ms is logged with the wall clock in capture runs.
Audio, targets, projectiles, the weapon state machine and the environment geometry were not changed after round 3.

**Conditions:** the machine was shared with another project for most runs (logged per half second for the
endurance and benchmark runs); one endurance run had the machine nearly idle for its first 250 s. The host was
short of memory throughout (≈9 GB in swap).

| Re-run on the final build | Result |
|---|---|
| Deterministic tests, stress test (`tests_output.txt`, `stress_targets_output.txt`) | 6 files, 0 failures; 505 projectiles, 0 failures |
| `main/` (`v_main.json`, recorded, 22 shots) | Bookkeeping as in round 3: slide lock after 9 shots, dead trigger, empty reload → chambered + 7, decock, thumb-cock, tactical reload keeps the partial magazine; rounds + shots constant in every state dump. Double-action first shot 104 ms after the press, single-action 1.5–5.7 ms. **18 of 22 shots struck a target** (round 3: 19; round 4: 17): quick follow-up shots go where the not-yet-corrected sights point. Aimed shots on paper: 17, 24, 10 mm from the aimed centre at 10 m; 22, 29, 16 mm at 15 m (all in the ten ring) |
| Audio in `main/` (`analysis.json`, plots, `impact_excess.txt`) | Peak −10.3 dBFS at the default 60 % master, 0 full-scale samples, 0 clipped runs. Audio onset vs first changed video frame: median +9 ms (+1 … +22), 21 shots matched; logged shot time vs audio onset jitter SD 2.6 ms. Bay vs pad: 17 vs 7 reflections; first-50 ms RMS −26.1 vs −26.9 dBFS; −20 dB time 58 vs 13 ms; 50–300 ms energy −8.5 vs −14.0 dB; L/R correlation 0.52 vs 0.83 — the same picture as round 3 (identical audio code) |
| Recoil recovery (`main/sight_track.txt`, `check/sight_track.txt`; `tools/analysis/sight_track.py`, template match of the rear sight in the recording) | Eight aimed shots of `main`: sights 4–14 px (median 9) from their pre-shot position at frame 12 after the shot, median 6 px at frame 18, 2 px at frame 24, 1 px at frame 32. Direction at frame 12 differs from shot to shot (e.g. +3/−14, +9/+1, −1/+4, −4/+1 px x/y; negative y is up). The offset changes every frame — no stationary phase |
| `check/` (recorded, `r4_check.json`) | Screenshots d01–d07 and video: aimed view from the bay (gloves and sleeves readable, not brighter than the timber beside them), look-down standing and walking in the bay and on the pad (no dark crescent; the swinging leg is a cloth-textured trouser leg), view from the back of the bay |
| `edge/`, `edge_relaunch/` | Blocked = 1.0 at the block wall and at a divider, 0.5 crouched at the bench; second reload press ignored; pause and focus loss in the middle of a double-action stroke: no shot, magazines unchanged, next fresh press fires; focus loss mid-reload: the reload completes; a shot 248 mm right of centre marks paper and backer, the next one marks **only the backer**; FOV 80, master 50 %, "headphones" and reload-on-H read back after relaunch |
| `bench_preset_high/` (uncapped, fresh launch, 1.2–9.7 outside cores busy) | Bay 9.9 ms avg, p99 11.8, max 12.3; pad 11.4 ms avg, p99 14.2, max 15.3; no frame over 16.7 ms. (The round-4 run of this benchmark, on a busier machine, had p99 13.9 / 16.2 and one frame over 16.7 ms in each window) |
| `endurance/`, `endurance_idle/`, `endurance_mem/`, `endurance_probe/` with per-process logs | See *Extended session* below. P99 18.5–41.6 ms and 1, 5, 107 and 492 frames over 34 ms depending on what else the machine was doing; **no run of the final build is free of long frames** |
| `standalone_offline/` | The re-exported build (`build/RangeDay/`, newer than every source file) in a network-less namespace: 69 sound groups, two shots with all five layers, 0 engine errors. Repeated after the last source change (`standalone_offline_final/`) |
| `./setup.sh` | Run end to end on this checkout after the last change (asset check, import, export) |

After the `main/`, `check/`, `edge/` and benchmark captures were recorded, one more change was made: capture-only
logging of long frames (`main.gd`, `weapon_view.gd`; active only when an event log is open, i.e. never in normal
play). `endurance_probe/`, the tests and the standalone check were run after it.

**Not re-run on the final build:** the Low / Medium / Ultra preset benchmarks, the firing benchmark, the
per-voice impact-timing statistics and the `bay_light/` views; those figures below are from round 3.

## Sessions (`evidence/round3/`)

| Dir | Script | What it exercises |
|---|---|---|
| `main/` (recorded, 96 s) | `v_main.json` | launch → look around → aim → double-action first shot and single-action shots on paper at 10 m → 4-shot string on the 10 m gong → 15 m gong until the slide locks → dead trigger → empty reload → inspect → safety on (decock) / off → thumb-cock → walk out of the bay with one shot at the bay edge and one between → open pad: paper at 15 m, steel at 25 m, tactical reload, steel at 50 m, bottle, clays, can |
| `edge/` (recorded, 94 s) | `v_edge.json` | walking into the block wall, a divider and the bench (crouched); firing pressed against the wall; repeated reload presses; trigger before the magazine is released; reload spam while changing stance; inspect interrupted by aiming and by reload; pause and focus loss in the middle of a double-action stroke and of a reload; shots just inside/outside the paper edge; target distance change; group inspector; reset targets; restart session; key rebinding; settings change |
| `edge_relaunch/` | `v_persist_check.json` | second launch on the same profile: settings and bindings read back |
| `bench_fire/` | `bench_fire.json` (uncapped) | first magazine from a cold start, a rapid string, idle |
| `bench_preset_*/` | one fresh launch per preset (uncapped) | frame time in the bay and on the pad |
| `endurance/` | `endurance.json` | 5.4 minutes: 22 magazines of aim–fire–reload cycles on paper and steel, breakables every third cycle, 4 target resets, 3 session restarts |
| `tests_output.txt`, `stress_targets_output.txt` | headless | deterministic tests; 500-shot target/effects stress run |
| `body/`, `bay_light/` | `look_body.json`, `look_fix2.json` | look-down views of the body (bay, pad, walking, crouched); bay interior views |
| `standalone_offline/` | `smoke.json` | the exported build inside a network-less namespace |

## Results

### Weapon state and bookkeeping (state dumps in `events.jsonl`)

* Start: 8 + 1, hammer down, safety off, 6 magazines (49 rounds). First shot double action
  (input → ignition 101–107 ms: the 110 ms stroke, frame-quantised), following shots single action
  (input → ignition 1–8 ms, i.e. within the frame the press arrives; ≈1 ms on the idle machine).
* After 9 shots: chamber empty, slide locked, hammer cocked; a trigger press gives `dead_trigger`, no shot.
  Empty reload → chambered + 7. Tactical reload → 8 + 1 with the partial magazine kept. Rounds + shots fired is
  constant in every state dump of every session (49 at start; e.g. 40 after 9 shots, 36 after 13).
* Safety on: hammer drops before the lever reaches SAFE, trigger dead; safety off: hammer stays down, next shot
  double action; thumb-cocking gives a single-action first shot.
* Repeated reload presses during a reload are ignored (one clean reload). A trigger press before the magazine
  catch is pressed cancels the reload and fires; after that point the trigger is ignored until the reload is done.
* Pause or focus loss in the middle of a double-action stroke: stroke aborted, **no shot** on resume even with
  the button still held (shots stays 9 across `paused_mid_da` → `resumed…` → `focus_lost…` → `after_focus_return`);
  the next fresh press fires. Focus loss mid-reload: the reload resumes and completes (8 + 1). Restart: 49 rounds.
* Found and fixed during verification: a weapon-inertia spring blew up on a very long frame (gun pointing into
  the sky after a hitch) — now sub-stepped and guarded; a second reload press used to cancel the reload; a held
  trigger used to fire on resume.

### Projectiles and targets

* Paper at 10 m, three aimed shots (double + single action): logged hits 24, 26 and 11 mm from the centre the
  script aimed at (9, 8, 10 mm in round 2, before the larger post-shot hold offset), scored 10; bullets continue paper → backer → berm (flight 29 ms to 10 m, 44 ms to 15 m, 74 ms
  to 25 m, 153 ms to 50 m, ≈165 ms to the berm).
* Edge: a shot 238 mm right of centre (paper half-width 266.7 mm) marks paper and backer; the next, 295 mm
  right, marks **only the backer** and goes on to the berm (`edge/events.jsonl`, bullets 11–12).
* Wall: walked into the block wall, the gun is drawn back (blocked = 1.0) and the muzzle stays 7.7 cm in front of
  the wall plane; a shot fired there hits the block wall. Same against a divider (8.5 cm clear); half-retracted
  at the bench when crouched (muzzle 9 cm above the bench top).
* Steel: plates at 10, 15, 25 and 50 m hit; logged impulse 2.55–2.72 kg·m/s for centred hits (lower for edge
  hits: 1.9–2.4); measured swing in the stress test 31.9° / 19.8° / 13.2° for the 8 / 10 / 12 inch plates
  (reference estimate 34° / 21° / 14°), at rest after 6.3 / 4.1 / 3.1 s.
* Breakables break on the logged hit, bullets continue to the berm; cans are knocked off the shelf.
* The movable stand reports 7 / 10 / 15 / 25 m and logged hits are at z = −distance (hit at z = −15.0 after moving).
* Visible changes since round 2, checked in frames: no pistol surface visible between the gloves in the aimed and
  ready views (`main/02…`, `13…`; ray-checked by the arms build); a body is visible when looking down
  (`body/*.png`); the bay interior is darker and the back wall has a brightness gradient (`bay_light/*.png`; the
  reviewer measured a gradient along the wall, not a front-to-back one). The round-3 claim that the sights came
  back visibly off the previous picture was **not confirmed** by the reviewer (≤ 3.8 px); it was reworked
  afterwards, see *Final build*.
* Reset clears holes and marks and restores breakables; restart also refills magazines.
* Deterministic tests (`game/tests/run_tests.gd`, headless): **6 files, 0 failures** — weapon state machine and
  ammunition conservation incl. a 24 000-step random-input fuzz and frame-rate independence; ballistics (drag
  table, zero, time of flight, energy, recoil model incl. shot-to-shot variation); audio scheduling (image-source
  geometry, bay vs pad, berm echo timing, sample-accurate reflection rendering, propagation delay through the
  real audio director, mechanism-sound alignment, pool bounds); projectile collision (1 mm sheet at 25 m, 1 mm
  inside/outside an edge, oblique, wall, pass-through speeds); targets (ring boundaries, mm mapping, steel impulse,
  reset, fragment bounds); UI statistics. Stress test: 505 projectiles, 10 resets, node count constant (1595),
  pools within caps, everything asleep at the end.

### Audio (loopback capture; `main/analysis.json`, `main/audio_overview.png`, `main/shot_*.png`, `main/impact_excess.txt`)

| Measure | Value |
|---|---|
| Sample peak, whole session, master at the default 60 % | −10.8 dBFS (edge session −9.9); 0 full-scale samples, 0 clipped runs |
| Shot peak, shot-to-shot spread | SD 0.6 dB (level jitter ±0.6 dB, six takes, pitch ±0.6 %) |
| Audio onset vs first changed video frame | median −7 ms (−20 … +25) in `main`; +11 ms (0 … +21) in `edge`; round 2: +14 ms and −3 ms. One frame is 16.7 ms and the capture path itself has frame-level uncertainty; the independent reviewer measured ±8.3 ms (its quantisation) in 39 of 41 shots |
| Logged shot time vs audio onset, jitter | SD 3 ms |
| Ambience bed between shots | −66 dBFS RMS (high-passed at 90 Hz); shot peak −11 dBFS. Plain shots are back at the bed level within 0.5 s (−65.5 … −66.7 dBFS at 0.5–1.0 s) in the bay and on the pad |

**Covered bay vs open pad, same gun, shots that struck no ringing target (4 each):**

| | Covered bay | Open pad |
|---|---|---|
| Early reflections rendered (image sources) | 17 | 7 |
| RMS of the first 50 ms | −26.0 dBFS | −26.9 dBFS |
| Time for the envelope to fall 20 dB | 52 ms | 14 ms |
| Energy 50–300 ms re first 50 ms | −9.0 dB | −14.1 dB |
| L/R correlation of the first 50 ms | 0.58 | 0.81 (the real recording: 0.78) |
| Spectral centroid of the first 250 ms | 3.7 kHz | 4.7 kHz |
| Level 100 / 200 / 300 ms after the shot (50 ms RMS) | −42.5 / −55.0 / −65.9 dBFS | −46.2 / −57.8 / −68.0 dBFS, with a +8 dB bump at 350 ms (backstop return, path ≈ 113 m → 0.33 s) |

The difference comes from geometry evaluated at the shooter's position plus an enclosure factor for the late
field: the shot fired at the bay edge logged enclosure 1.00 (9 reflections), between bay and pad 0.63 (3), on
the pad 0.10 (7, incl. the far block wall). The early level under the roof is only ≈1 dB above the pad
(reference estimate +2–3 dB); the reverberant energy after 50 ms is 5 dB higher.

Compared with the real 2 m recording the game's output carries more energy at 63–125 Hz in a 0.5 s window
(−20 / −13 dB re total against −39 / −22 dB). After the ambience was high-passed this remains and is attributed
to the berm-echo layer, which uses distant-perspective recordings that are low-frequency dominated — an
attribution by elimination, not a separate measurement.

**Impact sounds arrive when physics says** (bullet flight + sound return). From the `audio_world` log lines:
the voice for the 10.6 m gong started 33.3 ms after the hit (ideal 31.0), 15.7 m: 50.0 ms (45.8), berm at 54 m:
166.7 ms (157.3); over 25 impact sounds the start is 0.1–16.3 ms after the ideal arrival (median 4.4 ms) and
never before it. In the recording the 25 m plate appears in the 150 ms bin after the shot (ideal 148 ms) and
the 50 m plate in the 300 ms bin (ideal 298–302 ms), 10–27 dB above the tail of a plain shot
(`main/impact_excess.txt`).

**Level calibration** (`world_cal.json` runs): a Steam Audio voice is linear only for gains ≥ 0 dB and its built-in
distance law ignores the reference distance, so distance attenuation is applied by the game and voices run at
+60 dB into a −52 dB bus (the binaural path measured 8 dB below the engine's stereo path). Sources at ±90° give a
6–8 dB inter-aural level difference; a source behind an earth berm measured ≈11 dB lower (occlusion).

**Not measurable here:** timbre, perceived balance, whether layering is audible as layering, HRTF
externalisation, comfort. Quiet layers (brass, footsteps, cloth, paper hits) were checked for presence and level
only.

### Performance (`bench_*`, 1920×1080, uncapped; round 3, shared machine)

| Preset (fresh launch each) | Bay | Open pad |
|---|---|---|
| Low | 2.7 ms avg, p99 3.7 (370 fps) | 2.6 ms, p99 3.9 |
| Medium | 5.5 ms, p99 6.5 (182 fps) | 6.0 ms, p99 7.4 |
| **High (default)** | 9.8 ms, p99 10.9, max 11.4 (102 fps) | 11.4 ms, p99 13.1, max 13.3 (88 fps) |
| Ultra | 20.1 ms, p99 21.8 (50 fps) — does not hold 60 on this GPU | 21.9 ms, p99 25.0 |

| High, while firing (uncapped) | avg | p95 | p99 | max |
|---|---|---|---|---|
| First magazine from a cold start (9 shots, aiming) | 11.6 ms | 12.5 | 13.0 | 13.8 |
| Rapid string (8 shots at 0.22 s) | 11.4 ms | 12.4 | 13.0 | 14.0 |

No first-shot hitch (shaders and effect pools are pre-warmed behind the loading screen). Switching preset at
run time is not free: switching to Ultra stalls for seconds while the voxel GI starts. Per-feature cost at High
(ms, round-1 measurement): voxel GI 4.9 (now Ultra only), all vegetation 3.2–4.4, sun shadows 4.1–4.7, MSAA 4x
2.2–3.4, soft-shadow filter 1.1–1.6, SSIL 0.4, SSAO 0.2, glow 0.2. VRAM in use ≈ 4.1 GB; process memory (RSS)
peaked at 0.94 GB for the engine + project and 1.19 GB for the exported build.

V-synced play (what a user sees on a 60 Hz display): the recorded main session shows 6139 frames in 102.3 s; the
reviewer found no repeated frames during motion in the round-1 and round-2 recordings and one in the round-3 main
recording (at 49.42 s, shared machine); the game's own frame timer jitters around the refresh — see the endurance figures.

### Extended session (`endurance.json`, V-synced, default settings) — eight runs

All: ≈325 s, 184–186 shots, 4 target resets, 3 session restarts, 0 script errors, node count constant, pools
within caps at the end, 0 queued sounds, engine static memory +3 MB over the run (e.g. 225.8 → 228.9 MB).

| Run | What else the machine was doing | p50 / p95 / p99 / max frame time | Frames over 34 ms |
|---|---|---|---|
| Round 2 (`round2/endurance`) | idle, no memory limit | 16.7 / 17.8 / 21.6 / 27.1 ms | none (max 27 ms) |
| Round 3 (`round3/endurance`) | another project; this process group throttled at its memory soft limit | 16.7 / 24.2 / 33.7 / 438 ms | not logged per frame; stalls of 144–438 ms |
| Round 4 a (`round4/endurance`) | load average 4–22 | 16.7 / 21.0 / 25.8 / 65.9 ms | 47 of 19 490 |
| Round 4 b (`round4/endurance_idle`) | idle for ≈130 s, then another project's jobs | 16.7 / 18.1 / 25.6 / 86.3 ms | 57 of 19 342, none in the first 130 s |
| Final 1 (`round5/endurance`) | a steady 8 cores of load in another process group for 140 s, then 1–9 | 16.7 / 18.3 / 19.6 / 65.7 ms | 1 of 19 437 |
| Final 2 (`round5/endurance_idle`) | nearly idle for ≈250 s, then another project's jobs; host ≈9 GB in swap | 16.7 / 17.6 / **18.5** / 150 ms | 5 of 19 407, all 93–150 ms |
| Final 3 (`round5/endurance_mem`) | another project using a median of 7.7 cores in the game's own process group | 16.7 / 18.9 / 25.6 / 230 ms | 107 of 19 280 |
| Final 4 (`round5/endurance_probe`) | few CPU cores busy, but a `chrome` process of another application bursting and the host swapping out heavily (≈730 000 pages, 9.6 s of page-reclaim CPU) | 16.7 / 27.9 / **41.6** / **846 ms** | **492 of 17 675** |

Per-process logs for the four final-build runs: `procwatch.csv` (sampler `tools/capture/procwatch.py`, every 0.5 s:
CPU time of the game and of other processes with the top three named, how long the game's threads waited for a
CPU; from the third run on also page faults, swap and page-reclaim activity) and `hitch_procs.txt`
(`tools/analysis/hitch_procs.py`). In the fourth run the game itself recorded, for every long frame, how long its
main thread was computing, waiting for a CPU, or blocked (`events.jsonl`, `hitch` events; `association.txt`).

**Plain statement of the result: frame pacing on this machine was good only when the game had the machine to
itself.** P50 is always one refresh; the tail depends on what else is running, and in the worst run the game
stuttered badly for a third of the session.

What the logs support:

* No leak, no growth, no physics instability in any run.
* **CPU contention** explains the long frames of the run with competing jobs in the same process group (Final 3:
  game threads waited 574 ms per half second in intervals with a long frame against 107 ms in the others; page
  faults and swap were not associated) and the single long frame of Final 1.
* **In the worst run (Final 4) it was not CPU contention.** In all 492 long frames the main thread was blocked —
  neither computing nor waiting for a CPU (median wait 0.5 ms). 81 % of the half-seconds with a long frame had a
  `chrome` process of another application busy within ±1 s (17 % of the others); 44 % had page reclaim or
  swap-out (5 % of the others). The stretches without either were clean. A browser process competes for the same
  GPU and the same memory; which of the two blocked the game was not separated.
* **Not the game's reload code:** no weapon-event handler took more than 3 ms in any of the 23 reloads of that
  run, including the ones inside the stalls. (The reviewer had noted that four of the five long frames of Final 2
  fell at the magazine swap of a reload.)
* The 144–438 ms stalls of round 3 appeared only while the process group was throttled at its memory limit.

What they do **not** support:

* **A clean bill for the build.** There is no five-minute run of the final build without a long frame; the only
  clean run is the round-2 build on an idle machine (worst frame 27 ms), and the final build has since gained a
  body mesh, five fill lights, three decals and one small light. The five 93–150 ms frames of Final 2 occurred
  with little else running and were recorded before the in-game probe existed: host memory reclaim was active in
  those half-seconds, but the compositor, the GPU driver and the game are not excluded.
* Any statement about a machine that is not short of memory and not sharing its GPU: none was available.
* Why 8 cores of competing load cost one long frame in Final 1 and 107 in Final 3. The known difference is that
  the competing jobs were in another process group the first time and in the game's own group the second; that
  is an inference.

### Settings, pause, exit

Settings and bindings changed in one run (FOV 80, master 50 %, dynamic range "headphones", reload on H) were read
back on the next launch (`edge_relaunch/events.jsonl`); the rebound key triggers a reload through the raw key
path. Pause menu, group inspector and loading screen: `edge/e06…e08`, `evidence/ui/`. Scripted quit exits with
code 0; Godot prints leaked-instance warnings at exit (no effect during play).

### Offline and assets

`tools/check_assets.sh` passes (models, scenes, 326 sound files in 53 groups). The game has no network code;
the exported standalone build (`build/RangeDay/RangeDay.x86_64`, 74 MB + ≈1 GB data) was run inside a network-less
namespace (`unshare -r -n`: only a down loopback interface, `curl` fails) with a scripted session after the last
change: real environment loaded, 69 sound groups, two shots with all five layers, reload completed, 60 fps
(`evidence/round3/standalone_offline/`; repeated on the final build in `evidence/round5/standalone_offline/`). `./setup.sh` was run end to end on this checkout (engine already
present: asset check, import, export in 7 s); the first-time download path was exercised only when the
engine was originally fetched with the same URLs and checksums.

## Not verified / limitations

* No human has played or listened. Input latency was not measured end to end (only input → simulation, ≈1 ms
  for single-action shots; shot → presented frame within one to two frames in the recordings).
* Real-time capture is 60 fps: events shorter than a frame (slide cycle 55 ms, flash) are seen in 1–4 frames.
* Other GPUs, other compositors, Windows: not tested. Fullscreen/resizing: UI harness only.
* HRTF correctness beyond left/right level differences was not assessed.
* The analysis file's `noise_floor_dbfs: −240` is the digital silence before the game starts, not the floor in play.
