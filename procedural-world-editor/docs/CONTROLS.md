# Controls

## Camera

| input | orbit (1) | fly (2) | walk (3) |
|---|---|---|---|
| right-drag (or Alt+left-drag) | orbit around the focus point | look around | look around |
| middle-drag (or Shift+right-drag) | pan | pan | — |
| wheel | zoom towards the cursor | change fly speed | field of view |
| W A S D | move the focus point over the terrain | move | walk |
| Q / E | — | down / up | — |
| Shift | faster | 4× speed | run (5.2 m/s; walk is 1.6 m/s) |
| Space | — | up | jump; rise when swimming |
| C | — | down | dive (in water deeper than 1.35 m) |
| F | frame the selection | | |

Walk mode is a grounded first-person camera at 1.7 m eye height: gravity, terrain following, a
slope limit (~50°), collision with tree trunks, boulders and building footprints, wading that slows
with depth, being pushed by the river current, and swimming with the eyes just above the surface.
Diving shows the underwater view with the waterline crossing the lens.

## Tools

| key | tool | use |
|---|---|---|
| V | Select / move | click to select; drag objects, structures, path points, lake and settlement markers; drag floating objects to tow them; Shift+click a selected path to insert a point; Q / E rotate; Delete removes |
| B | Sculpt | drag: raise, lower, flatten, smooth, terrace, carve channel, erode. `[` `]` radius, Shift = smooth, Ctrl = invert |
| P | Paint | ground material override, biome, scatter density per group, exclusion zones. Ctrl = erase |
| R | River | click points source → mouth; Enter or double-click to finish; Backspace removes the last point |
| L | Lake | click the low point of a basin; adjust the level in the inspector |
| T / Y | Road / Trail | click points; Enter or double-click to finish |
| H | Structure | cabin, shed or a structure model; click to place, Q / E rotate |
| O | Object | pick a model in the Assets tab, click to place; "Floating" puts it on water with buoyancy |
| I | Touch water | click to drop a stone, drag to stir |
| Esc | | cancel the current path / return to Select / deselect |

## Editing

| input | action |
|---|---|
| Ctrl+Z / Ctrl+Shift+Z (or Ctrl+Y) | undo / redo (every authoring operation, including erosion and regeneration) |
| Ctrl+S | save |
| K | pause / resume the simulation (water, wind, clouds) |
| F1 | help |

## Where things are

- **River** inspector: width, depth, bank width / slope, bed roughness, pools & riffles, bend
  asymmetry, discharge; per-point width / depth overrides.
- **Lake / Sea**: level; **Water** tab: swell height / period / direction, wind-wave, ripple,
  turbulence, foam and caustic scales, water type and optical coefficients.
- **Sky & light**: time of day, sun path, latitude, date, haze, clouds, fog, wind, exposure.
- **World**: generator seed / relief / detail and Regenerate, hydraulic and thermal erosion
  (progress + cancel, one undo step), ground material textures and tints, material rules (rock /
  scree slopes, tree line, snow line, beach), structure rules, "Regenerate all derived data".
- **Biome** inspector: where it grows (altitude, slope, moisture, distance to water, priority),
  ground cover, scatter layers. **Layer** inspector: density, spacing, clumping, scale, site rules,
  model list with weights. Scattered instances can be removed or detached into editable objects.
- **Settlement** inspector: building count, radius, seed, slope / water / spacing / road rules,
  Regenerate (hand-moved buildings are kept).

## View aids

- **Water tab ▸ Flow ▸ Show flow speed** — colours rivers by the solved current (blue 0 m/s, green 1, yellow 2, red ≥ 3 m/s) with streaks that move with the flow; use it to see the effect of narrowing, deepening or rerouting a channel. Not saved, not exported.
- **Paint tool ▸ Show biome map** — overlays the biome index on the terrain.
- Path inspector — reports the steepest section of a road / trail and warns when the grade limit cannot be held within the allowed cut and fill.
