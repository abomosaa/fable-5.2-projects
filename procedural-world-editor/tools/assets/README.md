# Asset pipeline

Builds the bundled, offline asset library in `public/assets/` from CC0 sources (Poly Haven; one grass texture from
ambientCG). What ships is the processed output; these scripts are the reproducible procedure behind it.

```
npm ci                                  # three, playwright, sharp, meshoptimizer
npm run assets                          # = node tools/assets/fetch-assets.mjs
node tools/assets/preview.mjs           # optional: contact sheets + structural checks -> .cache/asset-previews/
```

| File | Purpose |
|---|---|
| `catalog.mjs` | The curated list: texture sets (with their terrain/structure `role`) and models (category, LOD profile, how sets are split into variants). |
| `sources.lock.json` | Pinned inputs: for every asset the exact file URLs, byte sizes and sha256 (plus name, authors, license, dimensions). |
| `fetch-assets.mjs` | Downloads the pinned files into `.cache/assets-src/<id>/`, verifies size + sha256, then runs `process.mjs`. `--pin` resolves catalog entries that are not in the lock yet through the Poly Haven API and pins them. `--only a,b`, `--force`, `--no-process`, `--quick`. |
| `process.mjs` / `worker.mjs` | Runs the conversion in worker processes (incremental, cached in `.cache/assets-build/`), writes `public/assets/manifest.json` and `ASSETS.md`. |
| `preview.mjs` | Renders every model LOD and texture set with stock three.js (`GLTFLoader`) in headless Chromium (Playwright, hardware WebGL via ANGLE/Vulkan) and checks each GLB against the manifest. |
| `lib/` | `texset` (texture sets), `model` (LOD construction), `mesh` (meshoptimizer simplification, components), `foliage` (component culling), `cards` (baked cluster cards), `modeltex` (texture baking), `glb` (GLB writer), `gltf-read` (glTF reader), `render` + `sheet` (previews). |
| `dev/` | Scratch diagnostics used while tuning (close-up renders, component statistics, atlas dumps). |

## What the processing does

**Texture sets** (`public/assets/textures/<id>/`): 2K PNG source maps are resampled to 2048² JPEG -
`diff.jpg` (sRGB albedo), `nor.jpg` (OpenGL normal, +Y up), `arm.jpg` (R = AO, G = roughness, B = metalness) - and
`disp.jpg`, an 8-bit greyscale 1024² displacement map stretched to the 0.1-99.9 percentile range of the 16-bit source.
The manifest records the real-world tile size and the linear average colour.

**Models** (`public/assets/models/<id>/lod{0,1[,2]}.glb`): the Poly Haven glTF (2K textures, up to 17 M triangles) is
read with a small dependency-free reader, node transforms are baked, multi-object sets are split into variants
(`<id>__a`, `<id>__b`, ...), and each variant is re-centred: metres, +Y up, origin at the centre of the base
(trees/plants: centroid of the stem base; everything else: bounding-box centre), min y = 0. Every LOD is one mesh
with one primitive per material, attributes POSITION / NORMAL / TEXCOORD_0 (float32), uint16 or uint32 indices,
embedded JPEG (opaque) or WebP (`EXT_texture_webp`, alpha) textures. No Draco / meshopt / KTX2: stock `GLTFLoader`
loads the files without any decoder.

- *Rocks, dead wood, props*: attribute-aware edge collapse (meshoptimizer `simplifyWithAttributes`, position-welded,
  escalating to permissive / sloppy modes only if the budget cannot be met), normals recomputed for scans.
- *Foliage* (alpha-tested materials) is never edge-collapsed as a whole. Per LOD one of two strategies is chosen:
  - **component culling** - connected components (leaf / blade cards) are sampled evenly along a Morton curve,
    each kept card is reduced towards its quad, and the survivors are scaled about their centroid by
    1/sqrt(kept area fraction) so the crown keeps its coverage. Used while that scale stays below ~2-3x.
  - **cluster cards** - when culling would need a larger scale (conifers model every needle as its own strip: 10^5-10^6
    components per tree) the fine foliage and thin twigs are clustered into sprig- / bough-sized groups, representative
    clusters are rasterised into an atlas (albedo + coverage-preserving alpha, normal, ORM) and each cluster becomes
    one or two textured quads at true scale. Card normals point away from the trunk axis ("crown normals").
- *Trunk and branches* are simplified per connected component with meshoptimizer; twigs smaller than a card are
  baked into the cards.

Budgets (triangles, lod0 / lod1 / lod2): trees 45k / 9k / 2k (conifers are capped at 30-36k / 8-9k / 2k in the
catalog), saplings + shrubs 8k / 1.5k, ground cover + grass
1.2k / 250, rocks 16k / 3k / 500, dead wood 12k / 2.5k / 400, props 15k / 2.5k.

## Trust boundary

Downloads are untrusted data. They are written only below `.cache/assets-src/<id>/` (paths from the lock file are
confined to that directory, URLs must be https), are verified against the pinned sha256 before use, and are only
ever *read* (JSON, binary buffers, images decoded by sharp). Nothing in the download directory is executed, and no
interpreter is started with it as working directory. glTF buffer/image URIs that escape the asset directory are
rejected.
