# Terraforge — procedural world editor

Terraforge is a browser-based editor for authoring realistic outdoor environments: seeded terrain
with real drainage structure, rivers that carve their own channels and flow, lakes, a coast with
refracted and breaking swell, biome-driven vegetation and rocks, roads, trails and buildings, a
physically based sky — and export to heightmaps, masks, glTF and structured placement data.

It runs entirely on your machine: a small Node server stores projects as plain folders and serves
the editor; rendering is WebGL2 (three.js for the scene graph, custom shaders for everything that
is drawn). No account, cloud service, API key or CDN is used at run time.

> Honest status: the application is a working authoring tool (unit tests and an end-to-end UI test
> pass, exports load in an independent viewer) and its three showcase worlds are real, editable
> projects. The stated realism target — an independent reviewer scoring ≥ 9.5 / 10 overall and for
> water against photographs — has **not** been reached: the delivered build scored **4.67 overall
> and 4.44 for water** (review 005, FAIL). `reviews/README.md` lists every review and why the score
> has levelled off; `docs/ARCHITECTURE.md` lists the physical approximations and known limitations.

## Requirements

- Node.js ≥ 20 (developed on 26) and npm.
- A Chromium-based browser (or Firefox ≥ 130) with WebGL2, float render targets
  (`EXT_color_buffer_float`, `OES_texture_float_linear`) and preferably `EXT_clip_control`
  (reversed depth). A discrete or recent integrated GPU; 4 GB of video memory is comfortable.
- ~1 GB of disk for dependencies and the bundled asset library.

## Setup and launch

```bash
npm install          # dependencies (three, vite, vitest, playwright, sharp, gltf-validator)
npm start            # builds the editor and serves it at http://127.0.0.1:5173/
```

`npm start -- --port 8080` changes the port. `npm run dev` runs the same server with hot reload.
The asset library (`public/assets`, 284 MB of CC0 scans) is bundled with the project; if it is
ever missing, `npm run assets` re-downloads the pinned sources (size + SHA-256 verified) and
re-processes them. Missing assets produce an explicit error, never a silent substitute.

On first start the three showcase projects are copied from `showcases/` into `projects/`:

| project | what it shows |
|---|---|
| **Mountain Valley** | clear river with pools, riffles, boulders and wet banks through a conifer valley; foot trail and trail huts |
| **Sheltered Lake** | drowned-valley lake behind a moraine, reed beds, mixed forest, jetty with floating objects, cabin and road |
| **Rugged Coast** | sandy bay between rocky headlands with sea stacks; refracted swell that shoals, breaks and runs up the beach |

They are ordinary projects built by `npm run showcases` with the same code the editor uses; edit
them freely (Projects ▸ *Restore* brings back the shipped version).

## Using the editor

- **Top bar** — Projects (open / new / duplicate / package / restore), project name, Save, Undo /
  Redo, camera mode, simulation pause, quality preset, Export, Help (F1).
- **Tool strip** (left edge) — Select/move, Sculpt, Paint, River, Lake, Road, Trail, Structure,
  Object, Touch-water.
- **Scene tab** — hierarchy: terrain, sea, lakes, rivers, roads, biomes and their scatter layers,
  settlements, structures, objects. **Assets tab** — model and material browser.
- **Inspector** — options of the active tool and properties of the selection.
  **Sky & light**, **Water**, **World** tabs hold environment, water optics / sea state, and terrain
  generation / erosion / material rules.
- **Status bar** — messages, cursor position / altitude / water depth, frame rate and brush latency.

The full control guide is in [`docs/CONTROLS.md`](docs/CONTROLS.md) (also F1 in the editor).

Typical session: *Projects ▸ New world…* (preset + seed) → sculpt or erode → draw a river (it
carves a descending channel and fills with flowing water) → paint a biome or tune its rules → draw
a road, place a cabin → set time of day and weather → Save → Export.

Everything you do is undoable (Ctrl+Z / Ctrl+Shift+Z), autosaved once a minute to a separate slot
(offered for recovery after a crash) and stored in `projects/<id>/` as a portable folder
(`project.json` + compressed layers + `assets.lock.json`; heights are stored losslessly, so a
reopened project derives exactly the same water, materials and vegetation). *Projects ▸ Package* downloads a
`.tar.gz` containing the project and every asset it references.

## Export

*Export…* writes to `exports/<project>/<timestamp>/`:

- `heightmap_16bit.png`, `heightmap_float32.raw`, `heightmap.json`
- masks (ground materials, biome index, water depth / type / flow, moisture, roads, sediment, exclusion) + `masks.json`
- `scene.glb` — terrain with baked base colour, water surfaces, GPU-instanced vegetation and rocks
  (`EXT_mesh_gpu_instancing`), structures, objects, roads
- `placements.json`, `environment.json`, `export_report.json`, `README_EXPORT.md`

Renderer-specific features that do not survive export are listed in `README_EXPORT.md` (wave and
flow animation, foam, caustics, refraction / reflections, wind, atmosphere and clouds, near-camera
grass, the layered terrain material). Verify an export with an independent loader:

```bash
npm run verify:export -- exports/<project>/<timestamp>
```

(Khronos glTF validator + stock three.js `GLTFLoader` in a separate viewer page + numeric checks
of scale, heights, placements and masks; writes screenshots and `verify_report.json`.)

## Tests and checks

```bash
npm test                         # deterministic unit / integration tests (vitest, Node)
node tools/functional-test.mjs   # end-to-end: launches `npm start`, drives the real UI headless
node tools/perf.mjs              # frame-time and edit-latency measurements → docs/PERFORMANCE.md
node tools/evidence.mjs <dir>    # unretouched stills / frame sequences for realism review
node tools/freeze-build.mjs <dir> # frozen production copy that a review is run against
```

## Documentation

- [`docs/CONTROLS.md`](docs/CONTROLS.md) — controls and tool reference
- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — architecture, data model, physical approximations, limitations
- [`docs/PERFORMANCE.md`](docs/PERFORMANCE.md) — measured performance on the development machine
- [`ASSETS.md`](ASSETS.md) — every bundled asset with source URL, author, licence (all CC0) and processing
- [`docs/verification/`](docs/verification) — last functional-test and export-verification reports
- [`reviews/`](reviews/README.md) — independent realism reviews with their evidence

## Repository layout

```
server/            local HTTP server + project storage API
src/core/          DOM-free world model: terrain generation, erosion, paths, carving, water field,
                   biome rules, scatter, structures, project I/O (shared by editor, tools, tests)
src/render/        WebGL2 renderer: atmosphere, shadows, terrain, water simulation + shading,
                   vegetation instancing, objects / buoyancy, post-processing
src/editor/        editor shell: app, undo history, tools, camera, panels, overlays, storage client
src/export/        exporter (PNG / GLB / JSON), no three.js or DOM dependency
src/workers/       background worker for generation and erosion
showcases/         shipped showcase projects        projects/   your working projects (created on first run)
public/assets/     bundled CC0 asset library + manifest
tools/             asset pipeline, showcase builder, evidence capture, functional test, export verifier
tests/             vitest suites
reviews/           preserved independent reviews and evidence
```
