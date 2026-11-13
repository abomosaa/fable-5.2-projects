# Controls

## Viewport

| Action | Input |
|---|---|
| Orbit | Left-drag on empty space, or right-drag anywhere |
| Pan | Middle-drag |
| Zoom (to cursor) | Mouse wheel |
| Standard views | `1` front · `2` back · `3` top · `4` bottom · `5` right · `6` left · `7` isometric, or the view buttons |
| Perspective / orthographic | `O`, or the Persp/Ortho switch |
| Zoom to fit | `F` |
| Saved inspection cameras | Amber buttons next to the view buttons (per project) |
| Transparent parts | `X` |
| Section view | Scissors button → choose normal X/Y/Z, drag the position slider, Flip |
| Exploded view | Layers slider (separates parts along the stacking axis Z) |
| Overlays | Buttons for joint symbols, motion traces, force arrows, follow-camera, grid, shadows |

The mechanism plane is XY (Y up); Z stacks parts into layers. The scale bar
(bottom-left) always shows a true length in the current length unit.

## Selecting, placing, assembling

| Action | Input |
|---|---|
| Select part / joint | Click it (joint symbols are clickable); Shift-click adds; `Esc` clears |
| Add a part | Library tab → click a component (it is dropped at the view centre, on top of what is there) |
| Move a free part | Left-drag it. Its holes/ports **snap** to other parts' ports; releasing on a snap creates a pivot (or a rigid mount onto a shaft/motor). Alt disables grid snapping |
| Pose an assembled mechanism | Left-drag any jointed part: the linkage follows through its joints |
| Rotate | `Q` / `E` ±15° (Shift ±1°), or the Rotation field |
| Nudge | Arrow keys 1 mm (Shift 10 mm) |
| Typed or keyed moves of jointed parts | X / Y / Rotation fields, `Q` / `E`, arrow keys: the value is met exactly and the rest of the mechanism follows through its joints (turning a motor-driven crank sets its start angle; a jointed group not attached to ground moves as one body). If the joints leave no freedom, nothing changes and a message says so (no undo step); if only another closure of the loop fits, the mechanism is re-posed and the message gives the resulting value |
| Change layer | `PgUp` / `PgDn`, or the Z field |
| Ground / unground | `G`, or the *Grounded* checkbox |
| Suppress | `H`, or the eye icon in the tree |
| Duplicate | `Ctrl+D`; several parts selected → *Pattern…* (linear/circular) and *Group* |
| Delete | `Del` |
| Rename | Double-click in the tree, or the name field in the inspector |

Joint tools (Library → *Joints, drives & measurement*, or keys): **Pivot** `J`,
**Slide** `P`, **Fix** `K`, Gear mesh, Rack & pinion, Belt, Cam contact,
Spring. Click the first anchor (a part's hole/port, any point on a part, or
empty space for *ground*), then the second. Blue rings show available ports;
a click inside a part's slot or bore still picks that part. The part clicked
second moves to meet the first. A pivot between a hole and *ground* pins the
hole **where it is** (the part does not jump to the clicked spot). Coupling
tools check the parts as you pick them (two gears of equal module, a gear and
a rack, a cam and a roller) and refuse anything else with the reason.
**Motor on selected joint** adds a drive to the selected pivot/slide.
**Probe** `B` records a point; **External load** places a force; **Measure**
`M` reports distance, ΔX/ΔY/ΔZ and angle between two snapped points.

## Simulation

| Action | Input |
|---|---|
| Play / pause | `Space` or the Play button |
| Single step (one fixed timestep) | `.` |
| Reset to the designed assembly | `R` |
| Playback speed | 0.05× … 4× selector (slow motion to fast-forward) |
| Kinematic / dynamic | Switch in the top bar |

Editing while a run is active restarts the run with the edited design.
Resetting never changes the design. Diagnostics are clickable: they highlight
the parts and joints involved. In the Diagnostics tab, **Solve assembly**
re-closes all joints and **Auto-stack layers** resolves part-to-part
interference by raising colliding parts along Z (it sweeps the mechanism
kinematically and moves a part only if it would otherwise overlap another).

## Editing values

Every numeric field shows its unit and accepts arithmetic and explicit units:
`25.4`, `1 in`, `2*pi rad`, `0.4 N*m`, `120 rpm`, `(30+12)/2 mm`. `↑`/`↓`
nudge by one display unit (Shift ×10, Alt ×0.1; rapid nudges are one undo
step). `Enter` or `Tab` commits, `Esc` discards what you typed. Invalid input
is rejected with a message and nothing changes; scientific notation (`1e-3`)
and sums with units (`60 mm + 1 in`) work. `Ctrl+Z` / `Ctrl+Shift+Z` undo/redo
every authoring change from anywhere — including while a field, checkbox or
menu has focus (with an uncommitted draft in a field, `Ctrl+Z` first discards
the draft). `Ctrl+S` saves; `Ctrl+O` opens the project list. With keyboard
focus on a button, checkbox or slider, `Space`/`Enter`/arrows operate that
control; after a mouse click they return to their global meaning.

## Sketch mode

Tools: `V` select/drag, `P` point, `L` line chain, rectangle, `C` circle, `A`
arc. Select geometry and click a constraint button (Fix, Coincident,
Horizontal, Vertical, Distance, Angle, Radius, Parallel, Perpendicular, Equal,
Point on, Tangent). Double-click a dimension, or use the constraint list, to
edit its value. Middle/right-drag pans, wheel zooms, `F` fits, `Del` deletes.
Blue geometry can still move, white is determined, red constraints conflict,
orange ones are redundant. *Finish sketch* returns to the assembly; double-click
a sketched part to edit its sketch again.
