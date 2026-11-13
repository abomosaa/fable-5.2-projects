# Architecture

TypeScript, React 19, three.js, manifold-3d (WASM geometry kernel), Vite.
Everything under `src/core` is pure TypeScript with no DOM access: it runs
identically in the browser, in the unit tests and in the Node scripts that
generate the showcase projects and the export samples.

```
src/core/
  units.ts            internal unit system (mm·kg·s·rad), display conversion, input parser
  math/               dense linear algebra (Cholesky with rank handling, rank-revealing elimination, SVD), 2D polygons
  model/              project document types, authoring operations (pure functions), scripted Builder
  parts/              parametric component catalogue: parameter schemas + geometry builders, involute/rack/cam profiles
  geom/kernel.ts      manifold-3d wrapper: solids from extrusion stacks, 2D booleans/offsets, independent mesh check
  sketch/             planar constraint solver, closed-profile extraction, sketch editing operations
  assembly/           compile (design → rigid bodies + constraints), design-time assembly solve, interference
  sim/                multibody solver, run recorder + probes + runtime diagnostics, explanations
  export/             STL, 3MF, drawing SVG, DXF/SVG profiles, BOM, assembly guide, printability check
src/examples/         the five showcases, written against the public Builder/ops API
src/ui/               React application: store (undo/redo, sim controller), viewport, panels, sketch editor
scripts/              launcher, example generator, profiler, export samples, independent verifiers, e2e workflows
tests/                vitest suites
```

## Design data vs. simulation state

`Project` (`model/types.ts`) is the only thing that is saved, undone and
exported: parts (kind, parameters, pose, material, grounded/suppressed),
joints, loads, probes, plots, groups, sketches, variants, cameras, simulation
settings, clearances and unit preferences. It is treated as immutable; every
authoring operation in `model/ops.ts` returns a new project with structural
sharing.

The simulation never writes to the project. `SimRunner` (`sim/runner.ts`)
compiles a project into a `MechModel`, owns the transient state (`q`, `v`,
recorded history, runtime diagnostics) and is discarded on reset or whenever
the design changes. "Reset" therefore cannot lose edits, and replay from the
initial conditions is bit-for-bit repeatable (tested).

## Edit pipeline and undo

`ui/store.ts` holds the current project, an undo stack of previous projects
and the UI state. `commit(label, fn)` is the single transaction entry point:

1. apply the pure edit `fn(project)`;
2. re-solve the assembly (`assembly/solve.ts`): gear/rack centre distances are
   propagated, then a minimum-movement Newton projection closes all joints;
3. if no pose satisfies the joints the edit is still applied, the poses are
   left untouched and an `assembly.cannot-close` diagnostic names the joints;
4. push the previous project on the undo stack, clear redo, schedule autosave,
   and invalidate the simulation runner.

Interactive drags use `beginTxn / previewTxn / endTxn` so a whole drag is one
undo step (Esc cancels). Undo/redo restore the exact previous project objects.

## Geometry

Every part is a stack of extruded 2D regions ("layers": contours in the
part's XY plane, extruded between two Z values). The same layers are used for

- rendering (unioned into a closed solid by manifold-3d, creased normals, edge lines),
- mass, centre of mass and polar inertia (exact polygon integrals × density),
- interference checks (profile overlap for parts whose Z ranges overlap),
- floor contact shapes, ports (holes, centres, rollers) that joints attach to,
- export (STL/3MF from the same solid; DXF/SVG/drawings from the same contours).

There are no decorative stand-in meshes. Clearances (`hole`, `slide`,
`backlash`, `minFeature`) are parameters of the geometry builders.

## Compiling a mechanism

`assembly/compile.ts` turns the project into rigid bodies and constraints:

- grounded parts and parts rigidly attached to them become the static world;
  other rigid clusters are merged into single bodies (mass, COM and inertia
  combined), so rigid joints cost nothing and cannot drift;
- revolute and prismatic joints become bilateral constraint rows and define
  joint coordinates used by motors, limits, friction and damping;
- gear, rack-and-pinion and belt joints become one holonomic row each, written
  on the pitch geometry relative to the line of centres (so they also hold on
  a moving carrier);
- cam joints become a contact on the cam's pitch curve; springs and loads
  become force elements; with the floor enabled every round end and hull
  corner of every moving part becomes a potential contact point;
- anything inconsistent (missing ports, module mismatch, wrong centre
  distance, rack on the wrong side, …) is returned as a diagnostic.

## Rendering and the frame loop

`ui/viewport/SceneView.ts` owns the three.js scene. Each animation frame it
asks the simulation controller to advance fixed steps for the wall-clock time
that has passed (× playback speed) within a time budget, then draws part poses
from the runner (or from the design when idle). The physical timestep is
therefore independent of the frame rate; if the solver cannot keep up the run
simply progresses slower than real time and the achieved factor is shown.

## Persistence

Projects are stored in `localStorage` (`ui/persist.ts`): an index, one entry
per saved project and a separate autosave slot per project used for recovery.
Projects can be exported and imported as JSON files. The showcase projects in
`public/examples/` are plain project files produced by `npm run examples`; a
test asserts they equal the builders' output (same structure, keys and text;
numbers to 1e-9) and that a builder gives byte-identical output when run twice.
Byte equality with the shipped files is not asserted: different builds of the
JavaScript runtime round `sin`/`cos`/`atan2` differently in the last digit.
