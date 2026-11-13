// Model processing: Poly Haven glTF (+ external .bin/.jpg/.png) -> real-time LOD GLBs.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { loadGltf, readAccessor, traverse, resolveInside } from './gltf-read.mjs';
import {
  meshReady, triCount, vertCount, bboxOf, transformGeometry, concatPrims, compactPrim, simplifyToBudget,
  recomputeNormals, analyseComponents, extractComponents, chunkComponents,
} from './mesh.mjs';
import { buildFoliageLod } from './foliage.mjs';
import { buildCardLod } from './cards.mjs';
import { alphaBaseColor, opaqueBaseColor, normalMap, ormMap } from './modeltex.mjs';
import { writeGlb } from './glb.mjs';

export const PIPELINE_VERSION = 2;

/**
 * Processing profiles. budgets = max triangles per LOD (the number of budgets is the number of LODs written).
 * Vegetation profiles:
 *   barkShare     part of the budget reserved for trunk/branches when foliage has to be reduced
 *   maxGeomScale  foliage is reduced by culling connected components (leaf / blade cards) and scaling the survivors
 *                 by 1/sqrt(kept fraction) as long as that scale stays below this value; harsher reductions are
 *                 rebuilt as baked cluster cards (lib/cards.mjs)
 *   cardSize      [fraction of plant height, min m, max m] target size of a cluster card per LOD
 *   atlas / tiles card atlas size (px) and tiles per side, per LOD
 */
export const PROFILES = {
  rock: { budgets: [16000, 3000, 500], normals: 'recompute', doubleSided: false, pivot: 'bbox' },
  deadwood: { budgets: [12000, 2500, 400], normals: 'recompute', doubleSided: false, pivot: 'bbox' },
  deadwood_small: { budgets: [3000, 600], normals: 'recompute', doubleSided: false, pivot: 'bbox' },
  prop: { budgets: [15000, 2500], normals: 'keep', doubleSided: true, pivot: 'bbox' },
  tree: { budgets: [45000, 9000, 2000], normals: 'keep', doubleSided: false, pivot: 'base', vegetation: true, barkShare: [0.25, 0.25, 0.3], maxGeomScale: [2.0, 2.4, 2.8],
    cardSize: [[0.032, 0.14, 0.5], [0.055, 0.25, 0.9], [0.11, 0.5, 1.8]], atlas: [2048, 1024, 512], tiles: [8, 4, 4] },
  sapling: { budgets: [8000, 1500], normals: 'keep', doubleSided: false, pivot: 'base', vegetation: true, barkShare: [0.25, 0.25], maxGeomScale: [2.0, 2.6],
    cardSize: [[0.07, 0.07, 0.3], [0.16, 0.14, 0.6]], atlas: [1024, 512], tiles: [4, 4] },
  bush: { budgets: [8000, 1500], normals: 'keep', doubleSided: false, pivot: 'base', vegetation: true, barkShare: [0.2, 0.2], maxGeomScale: [2.2, 2.6],
    cardSize: [[0.06, 0.08, 0.3], [0.14, 0.15, 0.6]], atlas: [1024, 512], tiles: [4, 4] },
  shrub: { budgets: [8000, 1500], normals: 'keep', doubleSided: false, pivot: 'base', vegetation: true, barkShare: [0.25, 0.25], maxGeomScale: [2.2, 3.0],
    cardSize: [[0.1, 0.05, 0.3], [0.22, 0.1, 0.6]], atlas: [1024, 512], tiles: [4, 4] },
  ground: { budgets: [1200, 250], normals: 'keep', doubleSided: false, pivot: 'base', vegetation: true, barkShare: [0.2, 0.15], maxGeomScale: [2.4, 3.2],
    cardSize: [[0.25, 0.04, 0.3], [0.45, 0.08, 0.6]], atlas: [512, 256], tiles: [4, 2] },
};
export const ALPHA_CUTOFF = 0.4;
// [baseColor, normal, orm] pixel sizes per LOD
const TEX_UNIQUE = [[1024, 1024, 512], [512, 512, 256], [256, 256, 256]];
const TEX_HERO = [[2048, 2048, 1024], [1024, 512, 512], [512, 256, 256]];
const TEX_TILING = [[512, 512, 512], [512, 256, 256], [256, 256, 128]];
const TEX_FOLIAGE = [[1024, 512, 512], [512, 256, 256], [256, 256, 128]];

const natural = (a, b) => a.localeCompare(b, 'en', { numeric: true, sensitivity: 'base' });
const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const round = (v, d = 4) => +v.toFixed(d);

// ---------------------------------------------------------------- source materials

function texInfo(gltf, ref) {
  if (!ref) return null;
  const tex = gltf.json.textures[ref.index];
  const srcIdx = tex.source ?? tex.extensions?.EXT_texture_webp?.source;
  const img = gltf.json.images[srcIdx];
  if (!img?.uri) throw new Error('embedded/bufferView images are not expected in Poly Haven glTFs');
  const xf = ref.extensions?.KHR_texture_transform;
  return { file: resolveInside(gltf.dir, img.uri), uri: img.uri, xf: xf ? { offset: xf.offset ?? [0, 0], scale: xf.scale ?? [1, 1], rotation: xf.rotation ?? 0 } : null, scale: ref.scale };
}

function resolveMaterials(gltf, src, rawDir, id, log) {
  const alphaSources = src.files.filter((f) => f.role === 'alpha-source');
  return (gltf.json.materials ?? []).map((m, mi) => {
    const pbr = m.pbrMetallicRoughness ?? {};
    const base = texInfo(gltf, pbr.baseColorTexture);
    const normal = texInfo(gltf, m.normalTexture);
    const mr = texInfo(gltf, pbr.metallicRoughnessTexture);
    let alphaMode = m.alphaMode ?? 'OPAQUE';
    let alphaFile = null;
    if (base) {
      // "<id>_<part>_diff_2k.jpg" -> part ; look for the separate "<part>_alpha|opacity" map (or bare Alpha/opacity when there
      // is no part). Several Poly Haven glTFs flag cut-out foliage as OPAQUE, so a matching alpha map wins over alphaMode.
      const stem = path.basename(base.uri).replace(/\.[a-z]+$/i, '');
      const mm = stem.match(new RegExp(`^${id}_?(.*?)_?(?:diff|diffuse|col|color)_\\d+k$`, 'i'));
      const part = mm ? mm[1] : '';
      const find = (k) => alphaSources.find((f) => f.map.toLowerCase() === (part ? `${part}_${k}` : k).toLowerCase());
      const hit = find('alpha') ?? find('opacity') ?? (alphaMode !== 'OPAQUE' ? find('mask') : null);
      if (hit) { alphaFile = path.join(rawDir, hit.path); if (alphaMode === 'OPAQUE') alphaMode = 'MASK'; }
      else if (alphaMode !== 'OPAQUE') { log(`material "${m.name}" is ${alphaMode} but no alpha map was found -> treated as OPAQUE`); alphaMode = 'OPAQUE'; }
    } else if (alphaMode !== 'OPAQUE') alphaMode = 'OPAQUE';
    const mrKind = mr ? (/_arm_/i.test(mr.uri) ? 'arm' : /_rough/i.test(mr.uri) ? 'rough' : 'mr') : null;
    return {
      index: mi, name: m.name ?? `material_${mi}`, alphaMode, alphaCutoff: m.alphaCutoff ?? 0.5, alphaFile, base, normal, mr, mrKind,
      baseColorFactor: pbr.baseColorFactor, metallicFactor: pbr.metallicFactor ?? 1, roughnessFactor: pbr.roughnessFactor ?? 1,
      key: [base?.file, normal?.file, mr?.file, alphaFile, alphaMode === 'OPAQUE' ? 'O' : alphaMode, (pbr.baseColorFactor ?? []).join(','), base ? '' : m.name].join('|'),
    };
  });
}

// ---------------------------------------------------------------- geometry extraction

function bakeUvTransform(uv, xf) {
  if (!xf) return uv;
  const out = new Float32Array(uv.length);
  const c = Math.cos(xf.rotation), s = Math.sin(xf.rotation);
  for (let i = 0; i < uv.length; i += 2) {
    const u = uv[i] * xf.scale[0], v = uv[i + 1] * xf.scale[1];
    out[i] = c * u + s * v + xf.offset[0];
    out[i + 1] = -s * u + c * v + xf.offset[1];
  }
  return out;
}

/**
 * Cylindrical UVs about a (possibly leaning) vertical axis for bark geometry that ships without usable texture
 * coordinates. The axis follows the centroid of the geometry per height slice; texels stay roughly square.
 */
function cylindricalUv(p) {
  const n = vertCount(p);
  const box = bboxOf(p.pos);
  const BINS = 24, h = Math.max(1e-6, box.max[1] - box.min[1]);
  const cx = new Float64Array(BINS), cz = new Float64Array(BINS), cn = new Float64Array(BINS);
  const binOf = (y) => Math.min(BINS - 1, Math.max(0, Math.floor(((y - box.min[1]) / h) * BINS)));
  for (let i = 0; i < n; i++) { const b = binOf(p.pos[i * 3 + 1]); cx[b] += p.pos[i * 3]; cz[b] += p.pos[i * 3 + 2]; cn[b]++; }
  let last = -1;
  for (let b = 0; b < BINS; b++) { if (cn[b]) { cx[b] /= cn[b]; cz[b] /= cn[b]; last = b; } }
  for (let b = 0; b < BINS; b++) if (!cn[b]) { let k = b; while (k < BINS && !cn[k]) k++; const s = k < BINS ? k : last; cx[b] = cx[s]; cz[b] = cz[s]; }
  const centre = (y) => { const f = ((y - box.min[1]) / h) * BINS - 0.5, b0 = Math.min(BINS - 1, Math.max(0, Math.floor(f))), b1 = Math.min(BINS - 1, b0 + 1), t = Math.min(1, Math.max(0, f - b0)); return [cx[b0] * (1 - t) + cx[b1] * t, cz[b0] * (1 - t) + cz[b1] * t]; };
  const radii = [];
  for (let i = 0; i < n; i += Math.max(1, Math.floor(n / 4000))) { const c = centre(p.pos[i * 3 + 1]); radii.push(Math.hypot(p.pos[i * 3] - c[0], p.pos[i * 3 + 2] - c[1])); }
  radii.sort((x, y) => x - y);
  const circ = 2 * Math.PI * Math.max(0.02, radii[Math.floor(radii.length / 2)] ?? 0.1);
  const pos = Array.from(p.pos), nrm = Array.from(p.nrm), uv = new Array(n * 2);
  for (let i = 0; i < n; i++) {
    const c = centre(p.pos[i * 3 + 1]);
    uv[i * 2] = Math.atan2(p.pos[i * 3 + 2] - c[1], p.pos[i * 3] - c[0]) / (2 * Math.PI) + 0.5;
    uv[i * 2 + 1] = -(p.pos[i * 3 + 1] - box.min[1]) / circ;
  }
  const idx = Uint32Array.from(p.idx);
  const dup = new Map();
  for (let t = 0; t < idx.length; t += 3) {
    const us = [uv[idx[t] * 2], uv[idx[t + 1] * 2], uv[idx[t + 2] * 2]];
    if (Math.max(...us) - Math.min(...us) <= 0.5) continue;
    for (let k = 0; k < 3; k++) {
      const v = idx[t + k];
      if (uv[v * 2] >= 0.5) continue;
      let d = dup.get(v);
      if (d === undefined) {
        d = pos.length / 3; dup.set(v, d);
        pos.push(pos[v * 3], pos[v * 3 + 1], pos[v * 3 + 2]); nrm.push(nrm[v * 3], nrm[v * 3 + 1], nrm[v * 3 + 2]); uv.push(uv[v * 2] + 1, uv[v * 2 + 1]);
      }
      idx[t + k] = d;
    }
  }
  return { pos: Float32Array.from(pos), nrm: Float32Array.from(nrm), uv: Float32Array.from(uv), idx };
}

/**
 * Poly Haven conifer trunks blend a scanned trunk base (unique UVs) into a tiling bark material further up, driven by
 * the COLOR_1 vertex mask - information the glTF export drops (the upper trunk then samples a sliver of the scan
 * atlas and turns black). Split the trunk on that mask: returns [scanPart, barkPart] (either may be null).
 */
function splitTrunkByMask(p, mask) {
  const n = vertCount(p);
  let hi = 0, yHi = 0, yLo = 0;
  for (let i = 0; i < n; i++) { if (mask[i] > 0.5) { hi++; yHi += p.pos[i * 3 + 1]; } else yLo += p.pos[i * 3 + 1]; }
  if (!hi || hi === n || yHi / hi <= yLo / (n - hi)) return null; // not the "scanned base + masked upper trunk" construct
  const a = [], b = [];
  for (let t = 0; t < p.idx.length; t += 3) {
    const m = (mask[p.idx[t]] + mask[p.idx[t + 1]] + mask[p.idx[t + 2]]) / 3;
    (m > 0.5 ? b : a).push(p.idx[t], p.idx[t + 1], p.idx[t + 2]);
  }
  const part = (ids) => (ids.length ? compactPrim({ ...p, idx: Uint32Array.from(ids) }) : null);
  return [part(a), part(b)];
}

/** All primitives below a scene root, in world space, grouped by output material key. */
function collectGroup(gltf, materials, rootIndices, log) {
  const byKey = new Map();
  for (const root of rootIndices) {
    traverse(gltf.json, root, (node, world) => {
      if (node.mesh == null) return;
      for (const prim of gltf.json.meshes[node.mesh].primitives) {
        if ((prim.mode ?? 4) !== 4) { log(`skipping non-triangle primitive (mode ${prim.mode})`); continue; }
        const mat = materials[prim.material ?? 0];
        const pos0 = readAccessor(gltf, prim.attributes.POSITION).array;
        const nrm0 = prim.attributes.NORMAL != null ? readAccessor(gltf, prim.attributes.NORMAL).array : null;
        const { pos, nrm, flipped } = transformGeometry(pos0, nrm0, world);
        const nv = pos.length / 3;
        let idx = prim.indices != null ? Uint32Array.from(readAccessor(gltf, prim.indices, { asIndices: true }).array) : Uint32Array.from({ length: nv }, (_, i) => i);
        if (flipped) for (let i = 0; i < idx.length; i += 3) { const t = idx[i + 1]; idx[i + 1] = idx[i + 2]; idx[i + 2] = t; }
        let p = { pos, nrm: nrm ?? new Float32Array(nv * 3), uv: null, idx };
        if (!nrm) p = recomputeNormals({ ...p, uv: new Float32Array(nv * 2) });
        if (prim.attributes.TEXCOORD_0 != null) p.uv = bakeUvTransform(Float32Array.from(readAccessor(gltf, prim.attributes.TEXCOORD_0).array), mat.base?.xf);
        else { log(`primitive with material "${mat.name}" has no UVs -> cylindrical projection`); p.uv = new Float32Array(nv * 2); p = cylindricalUv(p); }
        const add = (m, q) => { if (!byKey.has(m.key)) byKey.set(m.key, { mat: m, prims: [] }); byKey.get(m.key).prims.push(q); };
        const barkMat = /trunk/i.test(mat.name) && prim.attributes.COLOR_1 != null ? materials.find((m) => /_bark$/i.test(m.name) && m.base) : null;
        if (barkMat) {
          const col = readAccessor(gltf, prim.attributes.COLOR_1);
          const mask = new Float32Array(nv);
          for (let i = 0; i < nv; i++) mask[i] = col.array[i * col.itemSize];
          const parts = p.pos.length / 3 === nv ? splitTrunkByMask(p, mask) : null;
          if (parts) {
            log(`trunk "${mat.name}": upper part (COLOR_1 mask) re-mapped onto tiling bark "${barkMat.name}"`);
            if (parts[0]) add(mat, parts[0]);
            if (parts[1]) add(barkMat, cylindricalUv(parts[1]));
            continue;
          }
        }
        add(mat, p);
      }
    });
  }
  return [...byKey.values()].map(({ mat, prims }) => ({ mat, prim: concatPrims(prims) }));
}

/**
 * Split a group whose meshes contain several objects laid out side by side on the ground plane.
 * Returns arrays of per-material prims, one per cluster, ordered along X then Z.
 */
function spatialSplit(group, { gapFraction = 0.02, minShare = 0.02 } = {}, log) {
  const box = { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] };
  for (const g of group) bboxOf(g.prim.pos, box);
  const ex = box.max[0] - box.min[0], ez = box.max[2] - box.min[2];
  const cell = Math.max(0.01, Math.max(ex, ez) * gapFraction);
  const gw = Math.ceil(ex / cell) + 3, gh = Math.ceil(ez / cell) + 3;
  const occ = new Uint8Array(gw * gh);
  const analysed = group.map((g) => ({ ...g, comps: analyseComponents(g.prim) }));
  const cx = (x) => Math.floor((x - box.min[0]) / cell) + 1, cz = (z) => Math.floor((z - box.min[2]) / cell) + 1;
  for (const a of analysed) for (let c = 0; c < a.comps.count; c++) {
    for (let z = cz(a.comps.bmin[c * 3 + 2]); z <= cz(a.comps.bmax[c * 3 + 2]); z++) for (let x = cx(a.comps.bmin[c * 3]); x <= cx(a.comps.bmax[c * 3]); x++) occ[z * gw + x] = 1;
  }
  const label = new Int32Array(gw * gh).fill(-1);
  let nl = 0;
  for (let i = 0; i < occ.length; i++) {
    if (!occ[i] || label[i] >= 0) continue;
    const stack = [i]; label[i] = nl;
    while (stack.length) {
      const j = stack.pop(), x = j % gw, z = (j / gw) | 0;
      for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) {
        const xx = x + dx, zz = z + dz;
        if (xx < 0 || zz < 0 || xx >= gw || zz >= gh) continue;
        const k = zz * gw + xx;
        if (occ[k] && label[k] < 0) { label[k] = nl; stack.push(k); }
      }
    }
    nl++;
  }
  const clusters = Array.from({ length: nl }, () => ({ tris: 0, minX: Infinity, minZ: Infinity, ids: analysed.map(() => []) }));
  let total = 0;
  analysed.forEach((a, ai) => {
    for (let c = 0; c < a.comps.count; c++) {
      const l = label[cz(a.comps.cen[c * 3 + 2]) * gw + cx(a.comps.cen[c * 3])];
      const cl = clusters[l < 0 ? 0 : l];
      cl.ids[ai].push(c); cl.tris += a.comps.tris[c]; total += a.comps.tris[c];
      cl.minX = Math.min(cl.minX, a.comps.bmin[c * 3]); cl.minZ = Math.min(cl.minZ, a.comps.bmin[c * 3 + 2]);
    }
  });
  const big = clusters.filter((c) => c.tris >= total * minShare / Math.max(1, clusters.length) && c.tris >= 8);
  const dropped = clusters.length - big.length;
  if (dropped) log(`spatial split: ignored ${dropped} tiny cluster(s)`);
  const rowTol = Math.max(ez * 0.25, cell * 2);
  big.sort((a, b) => (Math.abs(a.minZ - b.minZ) > rowTol ? a.minZ - b.minZ : a.minX - b.minX));
  return big.map((cl) => analysed.map((a, ai) => (cl.ids[ai].length ? { mat: a.mat, prim: extractComponents(a.prim, a.comps, cl.ids[ai].sort((x, y) => x - y)) } : null)).filter(Boolean));
}

// ---------------------------------------------------------------- LOD construction

function uvRange(p) {
  let u0 = Infinity, u1 = -Infinity, v0 = Infinity, v1 = -Infinity;
  for (let i = 0; i < p.uv.length; i += 2) { const u = p.uv[i], v = p.uv[i + 1]; if (u < u0) u0 = u; if (u > u1) u1 = u; if (v < v0) v0 = v; if (v > v1) v1 = v; }
  return Math.max(u1 - u0, v1 - v0);
}

const compDiag = (comps, c) => Math.hypot(comps.bmax[c * 3] - comps.bmin[c * 3], comps.bmax[c * 3 + 1] - comps.bmin[c * 3 + 1], comps.bmax[c * 3 + 2] - comps.bmin[c * 3 + 2]);

/** Simplify a set of solid (bark) components towards a budget; the smallest components are dropped first if there are too many. */
function structuralLod(solids, picks, budget, recompute, log) {
  // picks: [{ gi, c, diag, tris }]
  const maxComps = Math.max(1, Math.floor(budget / 10));
  let kept = [...picks].sort((a, b) => b.diag - a.diag || a.gi - b.gi || a.c - b.c).slice(0, maxComps);
  const total = kept.reduce((s, k) => s + k.tris, 0);
  const out = [];
  solids.forEach((g, gi) => {
    const ids = kept.filter((k) => k.gi === gi).map((k) => k.c).sort((x, y) => x - y);
    if (!ids.length) return;
    const t = ids.reduce((s, c) => s + g.comps.tris[c], 0);
    let p = ids.length === g.comps.count ? g.prim : extractComponents(g.prim, g.comps, ids);
    const share = Math.max(Math.min(t, 12), Math.floor(budget * (t / total)));
    if (t > share) {
      p = simplifyToBudget(p, share, { sloppy: false, log });
      if (recompute && t > triCount(p) * 1.5) p = recomputeNormals(p);
    }
    if (triCount(p)) out.push({ mat: g.mat, prim: p, foliage: false });
  });
  return out;
}

async function buildLods(group, profile, entry, log) {
  let budgets = entry.budgets ?? profile.budgets;
  const recompute = profile.normals === 'recompute';
  if (!entry.budgets && !profile.vegetation && entry.profile !== 'prop') {
    // hand-sized stones do not need boulder budgets
    const b = { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] };
    for (const g of group) bboxOf(g.prim.pos, b);
    const size = Math.max(b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2]);
    if (size < 0.5) budgets = budgets.map((v) => Math.round(v * 0.3));
  }
  if (!profile.vegetation) {
    // ---- rocks / scans / props: plain attribute-aware simplification per material
    const total = group.reduce((s, g) => s + triCount(g.prim), 0);
    const lods = [], stats = [];
    for (let l = 0; l < budgets.length; l++) {
      const out = [];
      for (const g of group) {
        const t = triCount(g.prim);
        const share = Math.max(Math.min(t, 12), Math.floor(budgets[l] * (t / total)));
        let p = g.prim;
        if (t > share) {
          p = simplifyToBudget(p, share, { pick: entry.profile === 'prop' ? 'area' : 'first', log: (m) => log(`lod${l} ${g.mat.name}: ${m}`) });
          if (recompute && t > triCount(p) * 1.5) p = recomputeNormals(p);
        }
        if (triCount(p)) out.push({ mat: g.mat, prim: p, foliage: false });
      }
      lods.push(out); stats.push({ solid: out.reduce((s, o) => s + triCount(o.prim), 0) });
    }
    return { lods, stats };
  }

  // ---- vegetation
  const nl = budgets.length;
  const solids = group.filter((g) => g.mat.alphaMode === 'OPAQUE').map((g) => ({ ...g, comps: analyseComponents(g.prim) }));
  const alphas = group.filter((g) => g.mat.alphaMode !== 'OPAQUE').map((g) => ({ ...g, comps: analyseComponents(g.prim) }));
  const solidTris = solids.reduce((s, g) => s + triCount(g.prim), 0), alphaTris = alphas.reduce((s, g) => s + triCount(g.prim), 0);
  let alphaMin = 0;
  for (const g of alphas) for (let c = 0; c < g.comps.count; c++) alphaMin += Math.min(g.comps.tris[c], Math.max(2, Math.ceil(g.comps.tris[c] / 12))); // see foliage.mjs
  const allSolid = [];
  solids.forEach((g, gi) => { for (let c = 0; c < g.comps.count; c++) allSolid.push({ gi, c, diag: compDiag(g.comps, c), tris: g.comps.tris[c] }); });
  const box = { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] };
  for (const g of group) bboxOf(g.prim.pos, box);
  const treeAxis = [(box.min[0] + box.max[0]) / 2, (box.min[2] + box.max[2]) / 2];
  const height = box.max[1] - box.min[1];
  const lods = [], stats = [];
  for (let l = 0; l < nl; l++) {
    const B = budgets[l];
    const share = (entry.barkShare ?? profile.barkShare)[l];
    let barkBudget = alphaTris ? Math.min(solidTris, Math.round(B * share)) : B;
    if (alphaTris && alphaTris <= B - barkBudget) barkBudget = Math.min(solidTris, B - alphaTris);
    const fineBudget = Math.max(0, B - barkBudget);
    // Component culling keeps a fraction p of the leaf/blade cards (each reduced to its quad at worst) and scales the
    // survivors by 1/sqrt(p). Beyond maxGeomScale that turns foliage into blobs, so the LOD is rebuilt as cluster cards.
    const p = alphaMin ? Math.min(1, fineBudget / alphaMin) : 1;
    const maxGeomScale = (entry.maxGeomScale ?? profile.maxGeomScale)[l];
    const useCards = entry.cards?.[l] ?? (alphaTris > fineBudget && 1 / Math.sqrt(p) > maxGeomScale);
    const out = [];
    if (!useCards) {
      out.push(...structuralLod(solids, allSolid, barkBudget, recompute, (m) => log(`lod${l}: ${m}`)));
      const used = out.reduce((s, o) => s + triCount(o.prim), 0);
      let st = {};
      for (const g of alphas) {
        const b = Math.max(2, Math.floor((B - used) * (triCount(g.prim) / alphaTris)));
        const r = buildFoliageLod(g.prim, g.comps, { budget: b, maxScale: maxGeomScale, minTris: entry.minCardTris ?? 2, coverage: 1.15 });
        st = { comps: (st.comps ?? 0) + g.comps.count, kept: (st.kept ?? 0) + r.kept, scale: round(Math.max(st.scale ?? 0, r.scale), 2) };
        if (triCount(r.prim)) out.push({ mat: g.mat, prim: r.prim, foliage: true });
      }
      stats.push({ mode: 'geometry', solid: used, foliage: out.filter((o) => o.foliage).reduce((s, o) => s + triCount(o.prim), 0), ...st });
    } else {
      // cluster cards: twigs smaller than a card are baked into the cards, only larger limbs stay real geometry
      const [frac, lo, hi] = (entry.cardSize ?? profile.cardSize)[l];
      const d = Math.min(hi, Math.max(lo, height * frac));
      const tau = 0.8 * d;
      const structural = allSolid.filter((s) => s.diag >= tau);
      const fineSolid = allSolid.filter((s) => s.diag < tau);
      const parts = [];
      for (const g of alphas) { const comps = chunkComponents(g.prim, g.comps, 1.5 * d); parts.push({ prim: g.prim, comps, ids: Array.from({ length: comps.count }, (_, i) => i), mat: g.mat }); }
      solids.forEach((g, gi) => { const ids = fineSolid.filter((s) => s.gi === gi).map((s) => s.c); if (ids.length) parts.push({ prim: g.prim, comps: g.comps, ids, mat: g.mat }); });
      const r = await buildCardLod(parts, {
        maxCards: Math.max(2, Math.floor(fineBudget / 2)), cardSize: d, atlas: (entry.atlas ?? profile.atlas)[l], tiles: (entry.tiles ?? profile.tiles)[l], treeAxis,
        alphaCutoff: ALPHA_CUTOFF, planes: entry.planes?.[l] ?? 2, facing: (entry.facing ?? profile.facing ?? ['pca', 'pca', 'pca'])[l], coverageBoost: [1, 1.1, 1.2][l], shade: entry.cardShade ?? 1, crown: [0.7, 0.85, 1][l], roughen: [0.6, 0.8, 0.9][l], floorTight: [0.8, 0.86, 0.86][l], floorWide: [0.4, 0.6, 0.6][l],
      });
      const cardTris = triCount(r.prim);
      const structTris = structural.reduce((s, k) => s + k.tris, 0);
      const bark = structuralLod(solids, structural, Math.min(structTris, Math.max(barkBudget, Math.min(B - cardTris, Math.round(B * share * 1.6)))), recompute, (m) => log(`lod${l}: ${m}`));
      out.push(...bark);
      out.push({ mat: { name: 'cards', alphaMode: 'MASK', alphaCutoff: ALPHA_CUTOFF }, prim: r.prim, foliage: true, cardTex: r.textures });
      stats.push({ mode: 'cards', solid: bark.reduce((s, o) => s + triCount(o.prim), 0), foliage: cardTris, cards: r.cards, clusters: r.clusters, cardSize: round(r.cardSize, 3), target: round(d, 3), bakedTwigs: fineSolid.length });
    }
    lods.push(out);
  }
  return { lods, stats };
}

function pivotOf(lod0, profile) {
  const box = { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] };
  for (const o of lod0) bboxOf(o.prim.pos, box);
  let px = (box.min[0] + box.max[0]) / 2, pz = (box.min[2] + box.max[2]) / 2;
  if (profile.pivot === 'base') {
    // vegetation: stand on the centroid of the lowest slice of the stem/trunk so instances can be planted on slopes
    const src = lod0.some((o) => !o.foliage) ? lod0.filter((o) => !o.foliage) : lod0;
    const sb = { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] };
    for (const o of src) bboxOf(o.prim.pos, sb);
    const h = box.max[1] - box.min[1];
    const top = sb.min[1] + Math.max(0.01, 0.03 * h);
    let sx = 0, sz = 0, n = 0;
    for (const o of src) for (let i = 0; i < o.prim.pos.length; i += 3) if (o.prim.pos[i + 1] <= top) { sx += o.prim.pos[i]; sz += o.prim.pos[i + 2]; n++; }
    if (n) { px = sx / n; pz = sz / n; }
  }
  return [px, box.min[1], pz];
}

// ---------------------------------------------------------------- textures / output

async function materialTextures(mat, lod, { foliage, tiling, small, hero, big }) {
  let sizes = foliage ? TEX_FOLIAGE[lod] : tiling ? TEX_TILING[lod] : hero ? TEX_HERO[lod] : TEX_UNIQUE[lod];
  if (foliage && big && lod === 0) sizes = [2048, 1024, 512];
  if (small) sizes = sizes.map((s) => Math.max(128, s >> 1));
  const out = {};
  if (mat.base) out.baseColor = mat.alphaMode !== 'OPAQUE' ? await alphaBaseColor(mat.base.file, mat.alphaFile, sizes[0], { mode: mat.alphaMode, cutoff: ALPHA_CUTOFF }) : await opaqueBaseColor(mat.base.file, sizes[0]);
  if (mat.normal) out.normal = await normalMap(mat.normal.file, sizes[1]);
  if (mat.mr) out.orm = await ormMap(mat.mr.file, sizes[2], mat.mrKind);
  return { ...out, sizes };
}

/**
 * Approximate trunk radius just above the root flare. Stem vertices of a low slice are measured from the slice's
 * median axis; low branches are rejected by keeping only vertices within 2.5x the lower-quartile distance.
 */
function trunkRadiusOf(prims, height) {
  const median = (a) => { a.sort((x, y) => x - y); return a[a.length >> 1]; };
  for (const [y0, y1] of [[0.05, 0.1], [0.02, 0.12], [0, 0.2]]) {
    const xs = [], zs = [];
    for (const p of prims) for (let i = 0; i < p.pos.length; i += 3) { const y = p.pos[i + 1]; if (y >= y0 * height && y <= y1 * height) { xs.push(p.pos[i]); zs.push(p.pos[i + 2]); } }
    if (xs.length < 6) continue;
    const cx = median([...xs]), cz = median([...zs]);
    const d = xs.map((x, i) => Math.hypot(x - cx, zs[i] - cz)).sort((a, b) => a - b);
    const lim = 2.5 * Math.max(1e-4, d[d.length >> 2]);
    let s = 0, n = 0;
    for (const v of d) { if (v > lim) break; s += v; n++; }
    return s / n;
  }
  return null;
}

/**
 * Process one catalog model entry. Returns one result per output model (variants when the source is a set).
 */
export async function processModel(entry, src, { srcDir, outModels, log = () => {} }) {
  await meshReady;
  const profile = PROFILES[entry.profile];
  if (!profile) throw new Error(`unknown profile ${entry.profile}`);
  const gltf = loadGltf(path.join(srcDir, src.gltf));
  const materials = resolveMaterials(gltf, src, srcDir, entry.id, log);
  const scene = gltf.json.scenes[gltf.json.scene ?? 0];
  let roots = [...scene.nodes].sort((a, b) => natural(gltf.json.nodes[a].name ?? '', gltf.json.nodes[b].name ?? '') || a - b);
  if (entry.nodes) { const re = new RegExp(entry.nodes); roots = roots.filter((r) => re.test(gltf.json.nodes[r].name ?? '')); if (!roots.length) throw new Error(`no root node matches /${entry.nodes}/`); }

  // ---- variants
  let groups; // [{ suffix, nodeName, group }]
  if (entry.split === 'nodes' && roots.length > 1) groups = roots.map((r) => ({ nodeName: gltf.json.nodes[r].name, group: collectGroup(gltf, materials, [r], log) }));
  else groups = [{ nodeName: gltf.json.nodes[roots[0]].name, group: collectGroup(gltf, materials, roots, log) }];
  if (entry.spatial) {
    groups = groups.flatMap((g) => {
      const parts = spatialSplit(g.group, entry.spatial === true ? {} : entry.spatial, log);
      return parts.length > 1 ? parts.map((group) => ({ nodeName: g.nodeName, group })) : [g];
    });
  }
  groups = groups.filter((g) => g.group.length);
  const multi = groups.length > 1;
  if (entry.only) groups = groups.filter((_, i) => entry.only.includes(i));
  groups.forEach((g, i) => { g.suffix = multi ? `__${String.fromCharCode(97 + i)}` : ''; });

  const results = [];
  for (const g of groups) {
    const id = (entry.out ?? entry.id).toLowerCase() + g.suffix;
    const vlog = (m) => log(`[${id}] ${m}`);
    const srcTris = g.group.reduce((s, x) => s + triCount(x.prim), 0);
    const { lods, stats } = await buildLods(g.group, profile, entry, vlog);
    const pivot = pivotOf(lods[0], profile);
    const box0 = { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] };
    for (const o of lods[0]) bboxOf(o.prim.pos, box0);
    const dims = [0, 1, 2].map((k) => box0.max[k] - box0.min[k]);
    const small = Math.max(...dims) < 0.5;
    const big = dims[1] > 4;
    const outDir = path.join(outModels, id);
    fs.rmSync(outDir, { recursive: true, force: true });
    fs.mkdirSync(outDir, { recursive: true });
    const res = {
      id, variant: g.suffix ? g.suffix.slice(2) : null, sourceNode: g.nodeName, sourceTriangles: srcTris, lods: [], bounds: null, height: 0, radius: 0,
      materials: [], lodStats: stats, bytes: 0, sha256: {},
    };
    for (let l = 0; l < lods.length; l++) {
      const prims = [], mats = [];
      for (const o of lods[l]) {
        const p = o.prim;
        const pos = new Float32Array(p.pos.length);
        for (let i = 0; i < pos.length; i += 3) { pos[i] = p.pos[i] - pivot[0]; pos[i + 1] = p.pos[i + 1] - pivot[1]; pos[i + 2] = p.pos[i + 2] - pivot[2]; }
        // cluster cards / re-scaled foliage of the lower LODs may poke a little below the base plane: keep min y >= 0
        if (l > 0 || o.cardTex) for (let i = 1; i < pos.length; i += 3) if (pos[i] < 0) pos[i] = 0;
        const tiling = uvRange(o.prim) > 2.5;
        const isFoliage = o.foliage || o.mat.alphaMode !== 'OPAQUE';
        const tex = o.cardTex ?? await materialTextures(o.mat, l, { foliage: isFoliage, tiling, small, hero: !!entry.hero, big });
        const prefix = profile.vegetation ? (isFoliage ? 'foliage_' : 'bark_') : '';
        const name = prefix + o.mat.name.replace(new RegExp(`^${entry.id}_?`, 'i'), '').replace(/^$/, entry.id.toLowerCase());
        const masked = isFoliage || o.mat.alphaMode === 'MASK';
        mats.push({
          name, baseColor: tex.baseColor, normal: tex.normal, orm: tex.orm, hasOcclusion: o.cardTex ? true : o.mat.mrKind === 'arm',
          alphaMode: masked ? 'MASK' : o.mat.alphaMode, alphaCutoff: ALPHA_CUTOFF,
          doubleSided: masked || o.mat.alphaMode !== 'OPAQUE' ? true : profile.doubleSided,
          baseColorFactor: o.mat.baseColorFactor, metallicFactor: o.cardTex ? 1 : o.mat.mr ? o.mat.metallicFactor : (o.mat.metallicFactor ?? 0), roughnessFactor: o.cardTex ? 1 : o.mat.roughnessFactor,
          normalScale: o.mat.normal?.scale,
        });
        prims.push({ pos, nrm: p.nrm, uv: p.uv, idx: p.idx, material: mats.length - 1 });
        if (l === 0) res.materials.push({ name, foliage: isFoliage });
      }
      const glb = writeGlb({ name: `${id}_lod${l}`, prims, materials: mats });
      const rel = `models/${id}/lod${l}.glb`;
      fs.writeFileSync(path.join(outDir, `lod${l}.glb`), glb);
      res.sha256[rel] = sha256(glb); res.bytes += glb.length;
      res.lods.push({
        file: rel, triangles: prims.reduce((s, p) => s + p.idx.length / 3, 0), vertices: prims.reduce((s, p) => s + p.pos.length / 3, 0), bytes: glb.length,
        mode: stats[l].mode ?? 'mesh', materials: mats.map((m) => m.name), textureSize: Math.max(0, ...mats.map((m, i) => (lods[l][i].cardTex?.sizes ?? [0])[0])) || undefined,
      });
      if (l === 0) {
        const b = { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] };
        let r2 = 0;
        for (const p of prims) { bboxOf(p.pos, b); for (let i = 0; i < p.pos.length; i += 3) r2 = Math.max(r2, p.pos[i] * p.pos[i] + p.pos[i + 2] * p.pos[i + 2]); }
        res.bounds = { min: b.min.map((v) => round(v)), max: b.max.map((v) => round(v)) };
        res.height = round(b.max[1]); res.radius = round(Math.sqrt(r2));
        if (/^tree_/.test(entry.category)) {
          const stems = prims.filter((_, i) => !res.materials[i].foliage);
          const tr = trunkRadiusOf(stems.length ? stems : prims, b.max[1]);
          if (tr != null) res.trunkRadius = round(tr, 3);
        }
      }
    }
    vlog(`src ${srcTris} tris -> ${res.lods.map((x) => x.triangles).join(' / ')} | size ${dims.map((d) => d.toFixed(2)).join(' x ')} m | ${(res.bytes / 1e6).toFixed(1)} MB | ${JSON.stringify(stats)}`);
    results.push(res);
  }
  return results;
}
