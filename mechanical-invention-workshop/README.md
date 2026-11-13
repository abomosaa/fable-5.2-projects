# Mechanism Workshop

A self-contained browser application for inventing planar mechanisms: sketch
and place parts, assemble them with joints, drive them with motors, **simulate
them with a real constraint-based multibody solver**, see *why* they fail
(interference, impossible assemblies, dead-centres, stalls, slipping feet,
floating cam followers), and export parts you can manufacture.

It is an authoring tool, not an animation: every showcase is an ordinary
project file built with the same operations the editor exposes, and everything
that moves, moves because the solver satisfied joints and forces.

> Not certified engineering analysis. No structural FEA, fatigue, tolerance
> stack-up or safety verification. See [docs/SIMULATION.md](docs/SIMULATION.md)
> for exactly what is and is not modelled.

## Launch

Requirements: Node.js ≥ 20 (developed on 26.13) and a browser with WebGL 2 and
WebAssembly (current Chrome, Edge, Firefox).

```bash
npm install     # once; needs the npm registry
npm start       # the one launch command: builds on first run, then serves the app
```

`npm start` prints the address (default `http://127.0.0.1:4173`; if that port
is busy it picks the next free one, or set `PORT=8080 npm start`). After
`npm install` nothing else is downloaded: the app, the five showcases, the
simulation and all exports work offline and without an account. Projects are
stored in the browser (localStorage) and can be exported/imported as `.json`.

Other commands:

| Command | What it does |
|---|---|
| `npm test` | 144 deterministic unit tests (units, sketch solver, solver vs analytic references, geometry, persistence, undo/redo, exports) |
| `npm run e2e` | End-to-end workflows in the real UI with Playwright (app must be running; `MW_URL=http://127.0.0.1:4173/ npm run e2e`) |
| `npm run profile` | Measures solver step time and joint error for every showcase on this machine |
| `npm run examples` | Regenerates `public/examples/*.json` from `src/examples/*.ts` |
| `npm run export-samples` then `npm run verify-exports` | Exports every custom part of every showcase and checks the files with independent readers (Python: trimesh, ezdxf). One-time setup: `uv venv .venv && uv pip install --python .venv/bin/python -r scripts/requirements-verify.txt` |
| `npm run dev` | Vite dev server with hot reload |

## Five-minute tour

1. **Examples → Four-bar linkage**, press **Space**. The orange curve is the
   path of a point on the coupler; drag the orange marker to trace another
   point. Select the rocker, change *Length A–B*, and the assembly re-solves.
2. **Variants** (right panel, nothing selected): try *Invalid: crank too long*
   — the run stops at the dead-centre with a Grashof diagnosis — and *coupler
   too short* — the assembly cannot be closed, and says which joints gape.
3. **Examples → Walking linkage robot**. Nothing is grounded; green arrows are
   floor reactions on the feet. Set *Friction μ* to 0.08 and watch it lose.
4. Start from scratch: **Library → Link** (twice), drag one link so a hole
   snaps onto the other's hole (a pivot is created), use **Pivot** to pin a
   hole to empty space (ground), select that pivot and click **Motor on
   selected joint**, press **Space**.
5. **Manufacture** tab: select a part → STL / 3MF / dimensioned drawing / DXF.

Controls are listed in [docs/CONTROLS.md](docs/CONTROLS.md) and under **?** in the app.

## What is in the box

- **Workspace**: 3D viewport (orbit/pan/zoom, perspective/orthographic, seven
  standard views, saved inspection cameras, capped section view, exploded view,
  transparency, scale bar, measurement with snapping), assembly tree with
  groups/suppression/rename, searchable library, inspector with units on every
  field, sketch mode, simulation transport, plots, diagnostics.
- **Parts** (all parametric, geometry generated from dimensions): links
  (binary/ternary), crank discs, involute spur gears, racks, shafts, bearings,
  plate cams (motion-program or eccentric), roller followers, flanged pulleys,
  slotted guides and open channels, slider blocks, base plates with hole
  patterns, sketched/extruded parts, fasteners, motor bodies.
- **Joints**: revolute, prismatic, rigid, gear mesh, rack-and-pinion, belt,
  cam contact, springs; limits, Coulomb friction, viscous damping; servo and
  DC-curve motors with torque limits, ramps and reversal; external forces and
  torques with time windows.
- **Sketcher**: lines, circles, arcs, rectangles; coincident, fixed,
  horizontal, vertical, distance, angle, radius, parallel, perpendicular,
  equal, point-on, tangent; reports under-constrained (with DOF), redundant
  and conflicting constraints; a conflicting constraint is not applied and
  never collapses or deforms the geometry.
- **Simulation**: kinematic (geometry only) and dynamic (forces, gravity,
  contact, friction) modes, fixed timestep, pause / single step / reset /
  playback speed, bit-for-bit repeatable replay, run comparison, CSV export.
- **Opening files**: every value in a project file (including variant values)
  is validated against the same limits the inspector enforces; an invalid file is rejected with the list
  of problems and nothing is opened or stored.
- **Runs start only from a sound design**: any error-level diagnostic (open
  joints, a coupling that cannot work, a part that cannot be built, a DC motor
  without stall torque) blocks Play with the reason.
- **Diagnostics**: degrees of freedom from Jacobian rank, redundant
  constraints, open/impossible assemblies, part–part interference on true
  geometry, dead-centre lock-up with Grashof analysis, near-singular
  configurations, motor stall / back-driving, cam follower float, pressure
  angle, joint limits, locomotion slip and tipping, solver divergence.
- **Manufacturing**: STL and 3MF (closed-manifold checked; parts whose geometry
  could not be built as specified — e.g. holes that had to be left out — are
  refused with the reason),
  dimensioned drawings (SVG), cutting profiles (DXF/SVG with true circles and
  hole centres), BOM distinguishing custom from purchased parts, assembly
  guide with exploded views, explicit clearances built into the geometry.

## Documentation

| File | Contents |
|---|---|
| [docs/CONTROLS.md](docs/CONTROLS.md) | Mouse, keyboard, tools, numeric input |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | Code layout, data model, how edits/undo/simulation fit together |
| [docs/SIMULATION.md](docs/SIMULATION.md) | Solver formulation, idealisations, limits, what each plotted quantity means |
| [docs/VERIFICATION.md](docs/VERIFICATION.md) | Measured results: analytic references, constraint drift, performance, export validation, end-to-end proof |
| [docs/review/](docs/review/) | Independent review findings and what was done about them |
| [THIRD_PARTY_LICENSES.md](THIRD_PARTY_LICENSES.md) | Dependencies, licences, attribution |
