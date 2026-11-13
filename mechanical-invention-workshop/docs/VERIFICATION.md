# Verification results

Everything in this file was measured on the development machine by scripts in
this repository; the raw outputs are kept under `docs/verification/`. Nothing
is estimated or pre-recorded. Re-run instructions are given for each section.

**Machine**: Intel Core i7-14700K (28 logical cores), 31 GB RAM, Linux
7.3.3 (CachyOS), Node.js 26.13.0. All numbers below were re-measured on the
final build after a system update during the work (kernel 7.3.1 → 7.3.3 and a
rebuilt `nodejs` 26.13.0 package; the rebuilt runtime rounds some results
differently in the 16th–17th digit, see section 1). Browser runs used Playwright's headless
Chromium 158 with **software WebGL** (ANGLE / SwiftShader — no hardware GPU is
available to the headless browser here), viewport 1600 × 960, 3D canvas
1014 × 592, device pixel ratio 1. Hardware-accelerated frame rates were not
measured and are not claimed.

## 1. Unit tests — `npm test`

144 tests in 6 files, all passing (≈ 3 s). The independent reviewer ran the suite itself on each build it
checked (last: 144/144 on build 7).

| File | Tests | Covers |
|---|---|---|
| `tests/units.test.ts` | 6 | unit conversions, internal consistency (mN, µJ, µW), round trips of every unit, input parser (arithmetic, scientific notation, sums with mixed units), rejection of wrong units |
| `tests/sketch.test.ts` | 47 | every sketch constraint, DOF, redundant / conflicting detection (no silent deformation), dragging, closed-profile extraction, 40 seeded random trusses, conflicts that would collapse geometry are refused |
| `tests/solver.test.ts` | 27 | analytic references (below), gear / rack / belt ratios, joint limits, motors, friction, cam contact, closed-loop residuals over 60 000 steps, dead-centre handling, divergence detection, reset / bit-exact replay, DOF and redundancy, DC-motor stall diagnostics, refusal to run from an inconsistent design, slide orientation and rack positioning in the design-time solve |
| `tests/geometry.test.ts` | 18 | involute equation on flank points, backlash and hole clearance in the geometry, cam offset surface, closed solids for every catalogue part, mass properties vs closed form (also with overlapping holes), interference, auto-stack layers, parts that cannot be built as specified are errors and refused on export |
| `tests/model.test.ts` | 17 | persistence round trip, shipped examples equal builder output (structure and text exactly, numbers to 1e-9; byte-identical when built twice), **35 kinds of invalid file rejected with a specific message** (wrong types, ranges, variant values and notes, flags, reserved and duplicate ids, dangling references, unknown plot quantities, non-text titles), a rejected file leaves the open project and the store untouched, no-op edits create no undo step, storage / autosave recovery, cascading delete, duplicate / pattern, mates, variants, **typed poses** (met exactly when the mechanism can follow: four-bar rocker with the crank turning, ground-pivoted arm, walker crank phase with the chassis untouched, gear train by tooth ratio; unreachable poses not forced; free jointed groups move rigidly), **store-level undo / redo and transactions**, showcase sanity, walker force balance, unavailable quantities |
| `tests/export.test.ts` | 29 | STL / 3MF round trip, refusal of non-closed meshes, thin-feature warnings, DXF circles, drawing dimensions, BOM grouping and belt length, guide contents |

## 2. Solver against analytic references — `npx tsx scripts/measure.ts`

Raw data: `docs/verification/analytic.json`. The same cases are asserted with
the listed tolerances in `tests/solver.test.ts`.

| Case | Quantity | Reference | Measured | Error | Tolerance (asserted) | Settings |
|---|---|---|---|---|---|---|
| Compound pendulum (200 mm bar, 5° amplitude) | period | 0.740528 s | 0.740525 s | 2.8e-6 rel | 1e-4 rel | dt 1 ms, 10 s |
| Compound pendulum | total energy change over 10 s (13 periods) | 0 | −7.4e-3 µJ | 7.3e-7 rel | 1e-5 rel | dt 1 ms |
| Spring–mass (k = 0.4 N/mm, m = 100 g, A = 10 mm) | max \|x − A·cos ωt\| / A over 5 periods | 0 | 4.98e-3 | — | 5e-3 | dt 1 ms (ω·h = 0.063) |
| Spring–mass | same at dt/2 and dt/4 | ÷ 4 per halving (2nd order) | 1.24e-3 / 3.11e-4 | ratios 4.00, 4.00 | 3.2 – 4.8 | dt 0.5 / 0.25 ms |
| Gear pair 18 : 45, module 2 | speed ratio ω₂/ω₁ | −0.4 | −0.400000000 | 5.5e-13 | 1e-10 | dt 1 ms, 20 s |
| Gear pair | motor torque for a 100 N·mm load | 40 N·mm | 40.0000 N·mm | 2.8e-14 | 1e-4 N·mm | steady state |
| Gear pair | accumulated phase error z₁θ₁ + z₂θ₂ after 33 input revolutions | 0 | 9.1e-13 | — | 1e-6 | holonomic, no drift |
| Slider-crank r = 20, l = 70 mm (kinematic and dynamic) | slider position vs r·cosθ + √(l² − r²sin²θ) | closed form | 2.1e-7 mm max | — | 1e-6 mm | dt 1 ms, 3 revolutions |
| Slider-crank (kinematic) | slider velocity vs closed form (peak 207 mm/s) | closed form | 1.5e-8 mm/s max | — | 1e-6 mm/s | Jacobian solve |
| Slider-crank (dynamic) | slider velocity vs closed form | closed form | 1.14 mm/s max (0.55 % of peak) | — | 1.5 mm/s | mid-step velocity, O(h) |
| Four-bar showcase, 60 s = 60 000 steps | closed-loop joint error after projection, max over run | 0 | 9.98e-8 mm | — | 1e-6 mm | dt 1 ms, dynamic |
| Four-bar showcase | drift produced by one step before projection, max | — | 1.69e-4 mm | removed each step | reported | dt 1 ms |
| Cam + roller follower, 120 rpm (kinematic) | follower height vs base + roller + lift(θ) | cam program | 1.0e-7 mm max | — | 1e-6 mm | dt 0.5 ms |
| Cam + roller follower, 120 rpm (dynamic, spring-loaded contact) | same | cam program | 2.8e-4 mm max | — | 2e-3 mm | dt 0.5 ms |
| Block on floor, μ = 0.5 | displacement after 1 s with push 0.45·m·g | 0 (sticks) | 1.2e-15 mm | — | 1e-3 mm | dt 1 ms |
| Block on floor, μ = 0.5 | displacement after 1 s with push 0.8·m·g | 1471.00 mm (a = 0.3 g) | 1471.00 mm | 3e-15 rel | 1e-2 rel | dt 1 ms |
| Walker showcase, 2 s replayed twice | state after 2000 steps, run A vs run B | identical | bit-for-bit identical | 0 | exact | contact + friction, 38 bodies |

Other solver behaviour asserted in tests: joint limits never exceeded by more
than 1e-3 rad; a non-Grashof four-bar stops at the dead-centre in both modes
with the state left valid (joint error < 1e-6 mm) and a Grashof explanation;
a torque-limited motor reaches the same dead-centre without divergence; a
too-stiff spring is warned about before the run and stops as "diverged";
floor normal force on the walker averages the machine's weight within 2 %.

## 3. Solver cost and scene complexity — `npm run profile`

Raw data: `docs/verification/performance.json` (single-threaded JavaScript in
Node, 5 s of simulated time per run, after a 300-step warm-up).

| Showcase | Mode | dt | Bodies | Joint equations | Solver ms / step | with interference checks | Real-time factor (solver only) | Max joint error | Interference pairs | Triangles |
|---|---|---|---|---|---|---|---|---|---|---|
| Four-bar linkage | dynamic | 1 ms | 3 | 9 | 0.0038 | 0.0058 | 260× | 1.0e-7 mm | 4 | 2 796 |
| Four-bar linkage | kinematic | 1 ms | 3 | 9 | 0.0029 | 0.0046 | 338× | 1.0e-7 mm | 4 |  |
| Two-stage gear reduction | dynamic | 1 ms | 3 | 8 | 0.0033 | 0.0353 | 300× | 1.7e-13 mm | 19 | 16 820 |
| Two-stage gear reduction | kinematic | 1 ms | 3 | 9 | 0.0029 | 0.0330 | 344× | 2.9e-13 mm | 19 |  |
| Cam and spring follower | dynamic | 0.25 ms | 2 | 5 | 0.0030 | 0.0082 | 82.2× | 9.9e-8 mm | 7 | 4 568 |
| Cam and spring follower | kinematic | 0.25 ms | 2 | 6 | 0.0028 | 0.0059 | 90.4× | 1.0e-7 mm | 7 |  |
| Belt-driven slider-crank | dynamic | 1 ms | 4 | 11 | 0.0051 | 0.0143 | 197× | 1.0e-7 mm | 14 | 5 772 |
| Belt-driven slider-crank | kinematic | 1 ms | 4 | 12 | 0.0037 | 0.0101 | 269× | 8.8e-8 mm | 14 |  |
| Walking linkage robot (48 parts) | dynamic, floor contact | 1 ms | 38 | 110 | 0.3191 | 0.3766 | 3.1× | 9.7e-8 mm | 180 | 22 456 |

Geometry-kernel time to build every solid of a project: 9 – 31 ms.

## 4. In-app frame time — `MW_URL=… node scripts/e2e/05-performance.mjs`

Raw data: `docs/verification/e2e/05-performance-software.json`. **Software
rendering** (SwiftShader) only; a GPU should do better, but that was not measured.

| Showcase | Running: fps | Frame work (sim + render) avg | Solver step avg | Real-time factor at 1× | Orbiting while idle: fps | Triangles drawn | Draw calls |
|---|---|---|---|---|---|---|---|
| Four-bar linkage | 50 | 0.9 ms | 0.005 ms | 1.00× | 36 | 6 550 | 51 |
| Two-stage gear reduction | 31 | 2.3 ms | 0.007 ms | 1.00× | 24 | 34 702 | 67 |
| Cam and spring follower | 44 | 2.1 ms | 0.004 ms | 1.00× | 40 | 12 444 | 38 |
| Belt-driven slider-crank | 48 | 1.3 ms | 0.012 ms | 1.00× | 33 | 14 560 | 70 |
| Walking linkage robot | 18 | 33 ms | 0.38 ms | 1.01× | 30 | 58 134 | 502 |

The physical timestep is independent of the frame rate: all five keep real
time (1.00 – 1.01× measured) even at 18 fps because several fixed steps are
taken per frame. The
"frame work" column is JavaScript time per frame; the remainder of each frame
is the software rasteriser.

## 5. Export validation with independent readers

`npm run export-samples && npm run verify-exports` exports every custom part
of every showcase (plus a demo project covering every part kind) — 74 parts,
320 files — and checks them with trimesh 5.2.0 and ezdxf 1.4.5 against
expected values computed from the parametric model. Report:
`docs/verification/exports.md`.

**5449 of 5449 checks passed** (STL 1262, DXF 1178, profile SVG 1036, drawing
SVG 1239, 3MF 614, BOM 60, guide 60): watertight and winding-consistent
meshes, single body, Euler number matching the hole count, volume within
0.5 %, bounding box within 0.02 mm, hole radii measured on the mesh, 3MF unit
= millimetre and part numbers, DXF `$INSUNITS` = 4, closed polylines, true
`CIRCLE` entities at hole centres within 0.001 mm, drawing dimension values.
This check also caught a real defect during development (an open guide
channel exported as two disconnected bodies), which was fixed by joining the
bars with a strap.

Files exported **through the UI** in workflow 4 (a sketched 60 × 20 × 5 mm
plate with two ⌀4.2 holes) were verified separately by
`scripts/verify_ui_export.py`: 15 of 15 checks
(`docs/verification/e2e/ui-exports/verification.txt`) — e.g. bounding box
60.0000 × 20.0000 × 5.0000 mm, volume 5863.03 mm³ vs 5861.46 expected
(polygonal circles), both holes ⌀4.2000 measured on the mesh, DXF circle
centres 40.00000 mm apart.

## 6. End-to-end proof in the real UI — `npm run e2e`

Playwright drives the built application with real mouse and keyboard events.
Logs (`*.json`) and screenshots are in `docs/verification/e2e/`.
127 of 127 checks pass (6 workflows; last full run on the final build, after the last review fixes).

| Workflow | Checks | What is demonstrated |
|---|---|---|
| `01-build-linkage` | 17 | Fresh project → base plate from the library, grounded with `G` → three links sized in the inspector → Pivot tool on plate holes → **drag-snap hole onto hole creates pivots** → loop closes (4 pivots, no issues) → rename → motor on the selected joint at `45 rpm` → probe on the coupler → 1 DOF, no static errors → Play: runs, joint error < 1e-6 mm, trace sweeps 107 × 60 mm → pause, single step = exactly one timestep → reset keeps every edit |
| `02-edit-undo-save` | 18 | Rocker 70 → `55 mm`: assembly re-solves, swing grows 51.8° → 66.1° → 3 N load via the Load tool: peak motor torque 3.9 → 19.2 N·mm → previous run kept as dashed overlay → undo ×3 / redo ×3 step exactly through the three edits → rename, save, **reload: identical project** → unsaved edit **recovered from autosave** → duplicate listed in Open dialog → coupler set to 5 mm: "Assembly cannot be closed" naming four joints, project intact, Play refuses with a reason → undo restores the exact previous parts |
| `03-showcases` | 24 | All five showcases run; four-bar probe marker dragged and trace changes; non-Grashof variant locks at 23.2° with Grashof text; too-short coupler cannot assemble; gears 12 : 1 with 25.000 N·mm motor torque, tooth edit 16 → 24 moves the shaft to 72 mm and the plate hole with it, ratio 8.000, 37.500 N·mm, no interference; overloaded variant back-drives the motor; cam lift 12.000 mm, program edit → 8.000 mm, 1200 rpm variant floats (gap 0.39 mm at t = 0.27 s), stiffer spring restores contact; slider-crank stroke 36.000 / 24.000 mm, ratio 3.5000, over-long stroke → slider ↔ guide interference; walker travels +461 mm in 4 s with 1–2 loaded feet and nothing grounded, μ = 0.08 → dragged back −375 mm and reported as slipping, weak motor back-driven, an impossible leg length diagnosed, a merely unsuitable one (61.9 → 66 mm) walks at 31 mm/s with interference reported |
| `04-sketch-export-offline` | 14 | Sketch: rectangle + 2 circles → under-constrained (10 DOF) → dimensions → fully constrained, exact 60 × 20 with holes 40 mm apart → implied dimension reported redundant → contradictory 75 mm reported conflicting **and geometry unchanged** → extrude 5 mm → pinned at a hole it swings as a pendulum → 8 export files written from the UI → app reloaded with every non-local request blocked: loads, opens a showcase, simulates; **0 external requests** in the whole session |

| `06-review-regressions` | 21 | Every UI-level finding of the independent review, re-checked in the fixed build: layout fits 1280×800, 1366×768 and 1100×700 with no control off-screen; Tab-commit then Ctrl+Z undoes and the field shows the model value; Esc discards a draft; Ctrl+Z after ticking a checkbox; nudges are one undo step; `6e1` and `60 mm + 1 in` accepted; Space still plays after a mouse click on a button; 7 corrupted files rejected with a specific message, nothing stored, no exception; Slide tool picks the guide through its slot; ground pivot pins in place; Gear/Cam tools refuse incompatible parts; a link without room for its holes is an error and its STL export is refused; inch preset uses consistent units; DC motor requires a stall torque |
| `07-review-round2` | 33 | Findings of review round 2, re-checked in the fixed build: 1024×768 fits with no clipped or covered control; undo/redo with focus in the very field being undone keeps field and model in step; typed commits stay separate undo steps; files with invalid variant values or non-boolean flags rejected; a file too large for browser storage opens with an explicit "NOT stored" warning; DXF / profile SVG / drawing of an unbuildable part refused like its STL; assembly 3MF names the part it left out and the BOM marks it; Play refused while the design has an error; Auto-stack layers moves only the colliding part; plots that lost all channels are removed; a slider turns with its guide; rack & pinion is brought into mesh when coupled; dialogs trap focus and the canvas has an accessible name; sketch lines can be selected and constrained; double-click re-opens a sketch. Follow-ups from the round-2 report and its addenda: nudges merge only with nudges; a batch export names the part it skipped; a typed, nudged or keyboard (`Q`, arrows) pose that the joints do not allow is explained, leaves the field at the model value and creates no undo step; a typed rotation that re-poses the linkage says so and is one undo step; retyping the displayed value restores the branch without a message; a typed X on a free jointed pair moves the pair rigidly; a typed rotation on a ground-pivoted link with a link hanging from it is met exactly; `Q` on the four-bar rocker poses the mechanism (+15° exactly, crank follows); an arrow key on a meshed gear is never a silent adjusted move; on the walker a typed rotation on a crank web turns the crank by exactly that much while the chassis stays put, and the walker still runs; the diagnostics header follows the display units; no "damaged" message after a project that could not be stored; vertical display toolbar at 1024 × 768 |

## 7. Independent review

A separate agent that did not write the code reviewed the running product with
its own Playwright scripts, its own closed-form calculations and independent
file readers. Its reports and evidence (scripts, logs, screenshots, exported
files) are preserved unedited under `docs/review/`; `docs/review/README.md`
lists every finding with what was done about it.

- **Round 1** (`docs/review/round-1/REVIEW.md`): verdict "the simulation core
  is real and accurate" — gear ratio and torque balance to 1e-11, slider-crank
  position to 2e-7 mm, pendulum period to 3e-5, Coulomb threshold exactly at
  μ·m·g, cam lift to 1e-7 mm, walker centre of mass moving 1.6e-11 mm in 4 s
  with μ = 0 and free-falling at ½gt² with the floor off — and 23 findings
  (1 blocker, 4 major, 13 minor, 5 nits), all in usability, input validation,
  diagnostics wording and export edge cases. All were addressed.
- **Round 2** (`docs/review/round-2/REVIEW.md`): re-review of the fixed build
  plus five addenda, one per rebuilt app (builds 3 – 7). Final counts by the
  reviewer on build 7: round-1 findings **23 fixed, 0 partly, 0 not fixed**;
  round-2 findings R2-1 … R2-15 **14 fixed, 1 accepted as documented**; open:
  **0 blocker, 0 major, 0 minor, 2 nits** (R2-16, R2-17). Along the way the
  reviewer re-derived the gear showcase (240 rpm → 20 rpm, 25 N·mm), four-bar
  rocker angles for typed crank angles, slider-crank position (165.0054 mm) and
  cam lift against its own closed forms, checked about 170 hostile project
  files, and re-ran the unit tests on every build.
- **After the last review pass** two message-only changes were made for R2-16
  (a keyboard move that the joints adjust now shows the same explanation as a
  typed one) and R2-17 (i) (refusal wording). They are covered by this
  project's own end-to-end check (`07`, "arrow key on a meshed gear…") and
  were **not** seen by the reviewer. The remaining R2-17 edge cases are listed
  as open nits in `docs/review/README.md`.
