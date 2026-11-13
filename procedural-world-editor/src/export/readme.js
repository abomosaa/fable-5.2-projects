// Generated README for an export folder + the list of renderer features that are not exportable.

export const WHAT_DOES_NOT_SURVIVE = [
  { feature: 'Terrain material', detail: 'The procedural, height-blended triplanar terrain material (nine tiling PBR texture sets with slope / moisture / painted rules) is replaced by ONE baked base-colour texture on the terrain mesh. The per-layer weights are exported as mask_material_<layer>.png so the material can be rebuilt in another engine.' },
  { feature: 'Terrain resolution', detail: 'The terrain mesh is point-sampled from the heightfield (see export_report.json: scene.terrain.heightfieldStride). The full-resolution surface is in heightmap_16bit.png / heightmap_float32.raw; placements and water levels refer to that full-resolution surface, so on a decimated mesh objects can sit a few decimetres above or below the triangles.' },
  { feature: 'Wave animation', detail: 'FFT ocean waves, swell shoaling / breaking and interactive ripples (iWave) are simulated at runtime. Water is exported as static meshes at the still-water / steady-flow surface; swell and wind parameters are in environment.json.' },
  { feature: 'Flow-advected foam and flow maps', detail: 'Foam and normal-map advection are shader effects. The steady depth-averaged flow field is exported per vertex in TEXCOORD_1 of the water meshes (m/s) and as mask_flow.png.' },
  { feature: 'Water shading', detail: 'Caustics, screen-space refraction, depth-based absorption / scattering and planar reflections are renderer features. Water meshes use KHR_materials_transmission + KHR_materials_volume + KHR_materials_ior (1.333) with an attenuation colour derived from the absorption coefficients, and an alpha-blended base colour as fallback.' },
  { feature: 'Wet banks and shore foam', detail: 'Darkened wet ground near the waterline and swash foam are computed in the terrain / water shaders and are not baked.' },
  { feature: 'Wind animation', detail: 'Vegetation sway and leaf flutter are vertex-shader animation; exported plants are static. Wind direction and speed are in environment.json.' },
  { feature: 'Impostors and LOD switching', detail: 'Distant trees are drawn as impostor billboards with distance-based LOD cross-fades at runtime. The export contains one LOD per model (options.vegetationLod) as GPU instances.' },
  { feature: 'Near-camera detail scatter', detail: 'Grass, ferns, flowers and small cobbles (scatter layers with range <= 130 m) are generated around the camera at runtime and are NOT instanced into scene.glb; their rules are listed in placements.json (detailLayers).' },
  { feature: 'Sky, clouds and atmosphere', detail: 'Physically based sky, volumetric clouds, aerial perspective and valley haze are exported as parameters only (environment.json, including the sun direction vector).' },
  { feature: 'Shadows, ambient occlusion and post-processing', detail: 'Cascaded shadows, AO, tone mapping, exposure and film effects are renderer features and are not baked into textures.' },
  { feature: 'Buoyancy', detail: 'Floating objects are exported at their static rest pose on the still-water surface; the rigid-body simulation is not exported.' },
];

const fmt = (n) => (typeof n === 'number' ? (Number.isInteger(n) ? String(n) : n.toFixed(3).replace(/\.?0+$/, '')) : String(n));
const kb = (b) => (b === null || b === undefined ? '' : b > 1048576 ? (b / 1048576).toFixed(1) + ' MB' : (b / 1024).toFixed(1) + ' kB');

export function buildReadme(report, ctx) {
  const { masksDoc, heightmapDoc, depthScale, flowScale } = ctx;
  const c = report.counts;
  const s = report.scene;
  const L = [];
  L.push(`# Terraforge export - ${report.project.name || report.project.id}`);
  L.push('');
  L.push(`Exported ${report.exported} from project \`${report.project.id}\` (preset ${report.project.preset}, seed ${report.project.seed}).`);
  L.push('');
  L.push('## Conventions');
  L.push('');
  L.push('- Units: metres. Right-handed, +Y up, +X east, +Z south. The origin is the centre of the terrain.');
  L.push(`- Terrain extent: ${fmt(heightmapDoc.sizeMeters)} m x ${fmt(heightmapDoc.sizeMeters)} m, elevations ${fmt(heightmapDoc.minHeight)} m .. ${fmt(heightmapDoc.maxHeight)} m.`);
  L.push(`- Rasters are ${heightmapDoc.width} x ${heightmapDoc.height}, vertex-centred (pixel centres lie ON the terrain border): row 0 = north (z = -size/2), column 0 = west (x = -size/2), one pixel = ${fmt(heightmapDoc.cellMeters)} m.`);
  L.push('- Yaw angles are right-handed rotations about +Y (glTF quaternion `(0, sin(a/2), 0, cos(a/2))`).');
  L.push('');
  L.push('## Files');
  L.push('');
  L.push('| File | Size | Content |');
  L.push('| --- | --- | --- |');
  const describe = (name) => {
    if (name === 'scene.glb') return 'glTF 2.0 binary scene (terrain, water, instanced vegetation / rocks, structures, objects, roads)';
    if (name === 'heightmap_16bit.png') return `16-bit grayscale heightmap; height = ${fmt(heightmapDoc.heightAt0)} + value / 65535 * ${fmt(heightmapDoc.heightAt65535 - heightmapDoc.heightAt0)} m`;
    if (name === 'heightmap_float32.raw') return 'lossless heights: little-endian float32, row-major, metres';
    if (name === 'heightmap.json') return 'heightmap metadata (size, range, conventions)';
    if (name === 'masks.json') return 'encoding of every mask image';
    if (name === 'placements.json') return 'scatter instances + rules, structures, objects, rivers, lakes, sea, roads';
    if (name === 'environment.json') return 'environment settings, sun direction vector, wind, water optics, swell';
    if (name === 'export_report.json') return 'machine-readable version of this report';
    if (name === 'README_EXPORT.md') return 'this file';
    const m = masksDoc.masks[name];
    return m ? m.encoding : '';
  };
  for (const f of report.files) L.push(`| \`${f.name}\` | ${kb(f.bytes)} | ${describe(f.name)} |`);
  L.push('');
  L.push('## scene.glb');
  L.push('');
  L.push(`- ${s.nodes} nodes, ${s.meshes} meshes, ${s.materials} materials, ${s.images} embedded images (${s.imagesDeduplicated} duplicates removed by content hash), ${kb(s.bytes)}.`);
  L.push(`- Hierarchy: \`${s.hierarchy}\`.`);
  if (s.terrain) L.push(`- Terrain: ${s.terrain.vertsPerSide} x ${s.terrain.vertsPerSide} vertices (every ${s.terrain.heightfieldStride}${s.terrain.heightfieldStride === 1 ? 'st' : 'th'} heightfield sample), ${s.terrain.triangles} triangles, material \`terrain_baked\` with a ${s.terrain.textureRes} px baked base-colour texture. Quads are split along the (i+1,j)-(i,j+1) diagonal; road ribbons are draped 3 cm above the higher of this mesh surface and the bilinear heightmap.`);
  for (const w of s.water) L.push(`- Water \`${w.name}\`: ${w.kind}${w.level !== null && w.level !== undefined ? ` at ${fmt(w.level)} m` : ' (sloping surface)'}, ${fmt(w.areaM2)} m2 wet area, ${w.triangles} triangles. TEXCOORD_1 = flow velocity (vx, vz) in m/s.`);
  L.push(`- Scatter: ${c.scatterInstancesInGlb} instances in ${c.scatterNodes} EXT_mesh_gpu_instancing nodes (${c.scatterLayers} layers); ${c.scatterInstancesInPlacements} instances in placements.json${c.scatterTruncated ? ` (thinned from ${c.scatterInstancesTotal}, maxInstances)` : ''}.`);
  L.push(`- Structures: ${c.structuresInGlb} of ${c.structures}; objects: ${c.objectsInGlb} of ${c.objects}; roads / trails: ${c.roadsInGlb} of ${c.roads}.`);
  L.push(`- Triangles: ${s.uniqueTriangles} unique, about ${s.instancedTriangles} more when the instances are expanded.`);
  L.push(`- Extensions used: ${s.extensionsUsed.length ? s.extensionsUsed.join(', ') : 'none'}. Required: ${s.extensionsRequired.length ? s.extensionsRequired.join(', ') : 'none'}.`);
  L.push('  - `EXT_mesh_gpu_instancing` is required because scatter geometry is only reachable through instancing nodes.');
  if (s.extensionsRequired.includes('EXT_texture_webp')) L.push('  - `EXT_texture_webp` is required because some library models embed WebP textures, which are passed through unchanged.');
  L.push('  - Water uses `KHR_materials_transmission`, `KHR_materials_volume` and `KHR_materials_ior` (optional; an alpha-blended base colour is the fallback).');
  L.push('');
  L.push('## Masks');
  L.push('');
  L.push(`All masks are 8-bit PNG at heightmap resolution. Water depth: value / 255 * ${fmt(depthScale)} m (0 = dry). Flow: 128-centred velocity, full scale ${fmt(flowScale)} m/s. Material masks hold the nine ground-layer weights (they sum to 255 per pixel up to rounding). See \`masks.json\` for every encoding and the biome legend.`);
  L.push('');
  L.push('## What does not survive export');
  L.push('');
  L.push('The editor renders with custom shaders and runtime simulation. The following is NOT part of the exported data, or only in the simplified form described:');
  L.push('');
  for (const w of WHAT_DOES_NOT_SURVIVE) L.push(`- **${w.feature}** - ${w.detail}`);
  L.push('');
  if (Object.keys(report.skippedModels).length) {
    L.push('### Models without a mesh in scene.glb');
    L.push('');
    for (const [id, why] of Object.entries(report.skippedModels)) L.push(`- \`${id}\`: ${why} (placements are still listed in placements.json)`);
    L.push('');
  }
  if (report.warnings.length) {
    L.push('## Warnings');
    L.push('');
    for (const w of report.warnings) L.push(`- ${w}`);
    L.push('');
  }
  if (report.notes.length) {
    L.push('## Notes');
    L.push('');
    for (const w of report.notes) L.push(`- ${w}`);
    L.push('');
  }
  L.push('## Verifying');
  L.push('');
  L.push('`node tools/verify-export.mjs <this folder>` validates scene.glb with the Khronos glTF validator, loads it with the stock three.js GLTFLoader and cross-checks the meshes against the rasters and placements.');
  L.push('');
  return L.join('\n');
}
