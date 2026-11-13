# Architecture and physical approximations

This document states what is **simulated**, what is **approximated**, and what is **purely
visual**. Nothing is described as more than it is. Measured numbers live in `PERFORMANCE.md`,
`reviews/` and the test output; everything else here is a description of the implementation.

## 1. Overview

```
browser                                                   node
┌───────────────────────────────────────────────────┐    ┌──────────────────────────┐
│ src/editor   App · History · Tools · Camera · UI   │    │ server/server.mjs        │
│      │ edits (document JSON + grid layers)         │◄──►│  static files            │
│      ▼                                             │    │  /api/projects  (folders)│
│ src/core     World  ── derive ──►  final terrain,  │    │  /api/.../export         │
│              (DOM-free)            water field,    │    └──────────────────────────┘
│                                    moisture, ground│
│      │ change events                weights,scatter│    src/workers/gen.worker.js
│      ▼                                             │    (generation, erosion)
│ src/render   Engine: shadows → reflection → opaque │
│              → AO/contact → water → post           │    src/export (also runs in Node)
└───────────────────────────────────────────────────┘
```

- **Engine choice.** three.js r187 provides the WebGL2 state machine, scene graph, render targets
  and math. All shading (terrain, vegetation, water, sky, post) is custom GLSL sharing one lighting
  library (`src/render/shaders/common.glsl.js`) and one set of uniforms, so every surface responds
  to the same sun, sky irradiance, shadow cascades, cloud shadows, fog and water.
- **`src/core` is DOM-free.** The editor, the showcase builder, the exporter and the tests run the
  same terrain / water / biome code, in the browser and in Node.
- **Units.** 1 unit = 1 m, +Y up, right-handed, origin at the terrain centre. Grid sample `(ix, iz)`
  sits at `x = -size/2 + ix·cell` (vertex-centred). Showcases use 2049² samples over 3072 m
  (1.5 m) or 2048 m (1.0 m). Eye height 1.7 m, walking 1.6 m/s.

## 2. Data model and procedural dependencies

A project is a folder: `project.json` (the document: terrain parameters, environment, water
bodies, roads, biomes with scatter layers, structures, settlements, objects, cameras) plus
compressed grid layers (`heights.q.gz` user heightfield — lossless 1/1024 m fixed point, delta-coded; heights are kept on that grid in memory too, so a reopened project derives bit-identically, `sediment.u8.gz`, `paint.bin.gz`
painted masks, `ring.u16.gz` surrounding terrain) and `assets.lock.json` (every referenced asset
id with its files and source URL).

Authoritative data → derived data:

```
user heightfield (generated + eroded + sculpted)
   └─ modifiers (non-destructive): roads/trails → structure pads → rivers        → final heightfield + masks
        └─ water field: sea flood, lake floods, river surface + flow + foam, shore distance, fetch, swell
             └─ drainage (priority-flood routing) → moisture
                  └─ biome selection (rules + painted) → ground-material weights
                       └─ scatter (rules × masks × painted density × exclusion × suppressed instances)
                            └─ flow re-solve around boulders that stand in a river
```

`World.deriveAll()` recomputes everything; `deriveRect()` updates only the affected region after a
brush stroke or a path edit (and re-solves water only when the edit can touch water);
`deriveWater()` / `deriveGround()` cover level changes and rule changes. Because rivers, roads and
pads are modifiers applied on top of the user surface, moving a river removes the old channel and
carves the new one. Manual work is preserved across regeneration: sculpting lives in the user
heightfield; painted materials / biomes / density / exclusion zones are separate masks; detached
or deleted scatter instances are recorded by their stable lattice key; hand-moved buildings are
detached from their settlement rule.

**Undo/redo** (`src/editor/history.js`): document edits store before/after JSON, grid edits store
before/after copies of the touched rectangle; one command restores the data and then re-derives.
Slider drags coalesce into one step. The stack is bounded by memory (700 MB) and count. Tested for
bit-exact restoration of terrain, water, weights and scatter (`tests/history.test.js`).

## 3. Terrain

1. **Landscape evolution** (`fluvial.js`): detachment-limited stream-power incision with uplift,
   `dh/dt = U − K·Aᵐ·S` (m = 0.45, n = 1), solved implicitly in downstream order over a
   priority-flood-filled surface (Braun & Willett 2013; Barnes et al. 2014), with a threshold
   hillslope (critical gradient varies with a "rock hardness" field) and light diffusion. It is run
   coarse-to-fine (129² → 1025²) over a domain twice the editable size, so the surrounding ring
   terrain is the same landscape. Presets set boundary conditions (a single valley outlet, a sea
   base level with headlands, a massif) rather than drawing shapes.
2. **Domain warp** to remove the 8-direction bias of grid flow routing.
3. **Alluvial floors**: streams with large drainage area widen their valley floor.
4. **Macro features**: moraine dam + littoral shelf (lake), beach profile with berm, sea stacks (coast).
5. Crop, bicubic upsample, slope-dependent detail noise, then **particle hydraulic erosion** and
   **thermal erosion** at full resolution (also available as editor operations, in a worker, with
   progress and cancel).

*Approximations:* "time" and rock properties are tuning parameters, not calibrated geology; no
glaciation, no sediment budget beyond the droplet model, single-valued height (no overhangs or
caves; cliffs are steep slopes with triplanar rock). Determinism: same parameters → bit-identical
heights on the same JS engine (tested).

Rendering: geometry clipmap (5 levels, morphing) displaced by a height LOD pyramid that is
min-filtered where water exists (so coarse terrain never buries a narrow river); CPU-baked
normal + horizon ambient occlusion; nine PBR layers (albedo, normal, roughness, AO, displacement)
in texture arrays, height-blended, two-scale anti-tiling, triplanar bedrock, macro colour drift,
strata banding, wetness and underwater response from the water field.

## 4. Water

One single-valued **water-surface field** over the terrain grid drives everything.

| aspect | what is done | honest classification |
|---|---|---|
| Sea / lake extent | flood fill of cells below the level from the map edge / the lake marker | exact for a still level |
| River surface | 1-D profile along the path: smoothed bed, Manning normal depth `d ∝ S^-0.3`, forced to descend | approximation of gradually varied flow; no hydraulic jumps, no backwater curves |
| River channel | carved cross-section with thalweg shift in bends, pools/riffles, bed roughness, banks/levees | geometric model |
| River velocity | 2-D steady depth-averaged flow from a stream function: `∇·((1/d)∇ψ) = 0`, ψ = 0 / Q on the banks (SOR); `v = curl ψ / d` | satisfies continuity exactly → speeds up in constrictions and shallows, slows in pools, goes around emergent boulders. No momentum equation: no eddies, recirculation or super-elevation in bends |
| River foam | steady advection–decay of a source driven by Froude number, shear and bed drop; rendered with flow-advected foam textures | physically motivated, not a bubble simulation |
| River surface relief | Bernoulli along the free surface from the solved speed: `Δη = (⟨v²⟩ − v²)/2g` against a ~4.5 m neighbourhood mean (pillows where the current stalls in front of boulders, drawdown where it races through gaps and constrictions), ±0.2–0.28 m, kept in a separate display field so nothing that decides where boulders go depends on it | steady, inviscid estimate from a depth-averaged flow |
| River surface detail | FFT slope fields advected with the flow (two-phase flow mapping); stationary humps (standing waves, length ∝ v²/g) displaced in the vertex stage and shaded per pixel where the Froude number is high, their crests feeding the foam | visual; amplitude driven by solver quantities |
| Wind waves | 4 band-limited FFT cascades (Tessendorf) of a directional JONSWAP spectrum with capillary–gravity dispersion; displacement, slopes, Jacobian foam | linear deep-water wave field; fetch limitation and depth limitation are per-pixel amplitude factors, not a spectral model |
| Lake ripples | JONSWAP spectrum generated for a 3 km fetch; amplitude follows the wind (√ of wind speed above 0.6 m/s, after the Cox–Munk slope statistics), the upwind margin is sheltered by the fetch-limited exposure, and at light wind moving gust patches leave glassy lanes between ruffled water | visual model with physical drivers; no spectral fetch model per location |
| Swell at the coast | phase from an eikonal solve `|∇φ| = k(d)` with the linear dispersion relation (refraction, wrapping around headlands), shoaling by energy-flux conservation, per-wave depth-limited breaking `H ≤ 0.78 d`, crest steepening, run-up | ray theory of linear waves; no diffraction, no wave–current interaction, no overturning (a plunging lip cannot exist on a height field); breaker foam is a rendering model driven by the breaking criterion |
| Interaction ripples | Tessendorf's iWave convolution solver (dispersive), 512² window following the focus, advected by river flow, blocked by the shore | simulated, linear, small-amplitude; window-limited |
| Buoyancy | rigid body with five hull sample points against the simulated surface (FFT read-back + swell + flow relief + level), linear + quadratic drag relative to the current, hydrostatic stability as a metacentric righting moment `m·g·GM·sinθ` (GM from the waterplane size; the point model cannot place the centre of buoyancy vertically), angular damping; heave and forward motion inject ripple sources | simplified hydrodynamics; no added mass, no wave-making resistance, no capsizing |
| Optics | Fresnel reflection (planar reflection of scene + sky, roughness from unresolved slope variance), screen-space refraction, Beer–Lambert absorption along the *refracted* path, body colour from irradiance reflectance `R ≈ 0.33·b_b/(a+b_b)`, sun glitter as GGX with variance-based width | approximations of radiative transfer; single planar reflection level per frame |
| Caustics | light-concentration `1/|det J|` of the refraction map built from second derivatives of the fine wave cascades, focused/defocused with depth, attenuated by turbidity | derived from the actual wave field at one reference depth; not ray traced |
| Shore | signed shore distance and the extension of the surface into the dry margin from an exact Euclidean distance transform; the waterline of thin water (swash sheet, lake margin) is decided analytically per pixel — interpolated surface height against the full-resolution terrain height — with a small depth lift so the coarser terrain mesh cannot poke through the film; soft depth fade, wet darkening / gloss above the waterline, sediment materials from rules; submerged surfaces lose their air-interface specular | visual |
| Lens at the surface | the waterline on the lens is evaluated per pixel from the same surface sum the water mesh uses (level + flow relief + wind waves + swell + ripples), so a half-submerged view follows the waves; dark meniscus band with a bright rim, slight refraction across it | the mesh is piecewise linear, so the line can differ from the drawn surface by a few millimetres (hidden by the band) |
| Underwater | distance attenuation and direction-dependent in-scatter in post; sparse drifting particles; on the underside of the surface Snell's window (sky, sun) with water→air Fresnel rising to total internal reflection, where a screen-space mirror image of the bed (attenuated along the reflected path) is shown; light shafts by integrating the caustic field along the view ray (8 samples); foam from below as a soft back-lit cloud; dark meniscus line where the surface crosses the lens | approximation; the mirror image only contains what is on screen, shafts are not shadowed by objects |

Additional rendering models driven by the same fields: **spray** at breaking crests (stateless GPU
sprites launched when a breaking crest of the solved swell passes their cell, ballistic, lit as a
droplet cloud — not a particle simulation, no interaction with wind or rocks); **splash foam**
where the interaction-ripple field is steep (an object plunging in); a **flow-speed overlay** for
authoring (Water tab), which colours the surface by the solved current.

Things explicitly **not** simulated: full 3-D or 2-D momentum (CFD), waterfalls / overhanging
water, physically simulated spray / splash droplets, breaking-wave overturning, sediment transport by the visible
flow, wave-induced currents.

## 5. Vegetation, rocks, structures

- **Biomes** select per cell by altitude / slope / moisture / distance to water (priority order) or
  by painting. Each biome sets ground cover and scatter layers.
- **Scatter** candidates lie on a world-anchored jittered lattice per layer; acceptance multiplies
  density, site-rule bands, clumping noise, clearing masks (roads, pads), painted density and
  exclusion. Deterministic and local: any cell can be regenerated on its own (tested).
  Persistent layers (trees, shrubs, rocks, reeds, dead wood) are stored per 64 m cell; detail
  layers (grass, ferns, flowers, cobbles) are generated around the camera only.
- **Rendering**: GPU instancing per (model, LOD) with per-instance LOD selection; LOD cross-fades
  and foliage edges use alpha-to-coverage with the coverage snapped to the MSAA sample count (exact
  quarter coverages are not dithered by the driver, so crowns show no ordered stipple); 8×3-view
  baked impostors for distant trees (and for the planar reflection), blended between the two
  nearest azimuth frames; wind
  (trunk sway + leaf flutter with travelling gusts), leaf translucency, crown self-occlusion.
- **Assets**: CC0 photogrammetry from Poly Haven (plus one ambientCG texture), decimated into LODs
  by `tools/assets` (see `ASSETS.md`). Reeds and cattails are **procedural geometry**
  (`ProceduralPlants.js`) because no redistributable scanned reed was available.
- **Structures**: parametric timber cabins / sheds (`core/structures.js`) with CC0 PBR textures and
  a stone plinth that extends below grade; model structures (jetty). Pads level the terrain; sites
  in water, too close to water, on roads or too steep are rejected. Settlement rules place
  buildings deterministically near roads.

## 6. Lighting and atmosphere

- Sun position from time, date, latitude. Rayleigh + Mie + ozone atmosphere with transmittance,
  multiple-scattering and sky-view LUTs (after Hillaire 2020); the sun colour reaching the ground
  comes from the same transmittance.
- Ambient: SH irradiance integrated from the sky LUT (plus cloud dimming and ground bounce);
  specular from a sky cube with mips.
- Clouds: one ray-marched volumetric layer (Perlin–Worley noise, Beer–powder, dual-lobe phase)
  with temporal accumulation; cloud shadows on the ground from the same coverage field (projected,
  not ray-marched).
- Shadows: 4 cascades in one atlas, texel-snapped, 9-tap PCF, receiver offset along the normal and
  towards the sun scaled by each cascade's real texel size and the incidence angle; terrain normals
  are stored in half-float (8-bit normals band smooth ground under grazing sun); screen-space AO
  and near-range (< ~100 m) sun contact shadows applied to the opaque scene (using the stored sun
  fraction) before water is drawn.
- Aerial perspective: analytic exponential Rayleigh / haze / valley fog with in-scatter colour
  from the sky LUT.
- Output: scene-referred HDR, metered exposure (partial compensation, EV offset), bloom at 3.5 %,
  AgX tone map, dither. No vignette, depth of field, film grain or colour grading.

*Approximations:* no global illumination beyond sky SH + ground bounce (no indirect light from
terrain onto terrain), clouds do not receive terrain shadows, reflection uses one plane.

## 7. Performance design

Clipmaps for terrain and water (constant triangle counts), instancing + impostors, shadow cascades
updated at decreasing rates with per-cascade caster filtering, half-resolution reflection with
impostor stand-ins, half-resolution clouds with temporal accumulation, GPU FFT in 16 passes for
all cascades at once, static far impostor buffers re-uploaded only when the camera changes cell.
Quality presets (low / medium / high / ultra) scale resolution, MSAA, shadow size, LOD distances
and detail density; the showcase evidence uses **high**.

## 8. Known limitations

- Realism: trees are decimated scans with card foliage and read as CG at close range; foam is a
  texture model; spray is a sprite model without droplets or splash-back; breaking waves cannot overturn; distant forest is
  impostors; terrain is a height field. The independent reviews in `reviews/` list what an
  unbiased observer finds wrong.
- Rivers are single-valued: no waterfalls; confluences are drawn as overlapping rivers, each
  solved separately.
- One planar reflection level per frame (nearest water body); other levels reflect with offset.
- The ripple window is 56 m; interactions outside it are not simulated.
- Sculpting near the map border can leave a small seam to the non-editable ring terrain.
- Export: see `README_EXPORT.md` written with every export.
- Browser: WebGL2 with float targets required; tested in Chromium (ANGLE/Vulkan) on Linux.
