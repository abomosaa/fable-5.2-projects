// Geometry / raster builders for the exporter. Pure functions over a World (no DOM, no three.js).

import { MAT_NAMES, INSTANCE_STRIDE } from '../core/biomes.js';
import { NO_WATER, WATER_RIVER, WATER_LAKE, WATER_OCEAN } from '../core/waterField.js';
import { Noise2D, hash32, smoothstep } from '../core/noise.js';
import { quatFromAxisAngle, quatMul, quatNormalize } from './glb.js';

const LIM = NO_WATER * 0.5;
export const WATER_UV_METERS = 4;

// ---------------------------------------------------------------------------------------------
// Generic helpers
// ---------------------------------------------------------------------------------------------

/** Normalise normals in place; zero / non-finite vectors become +Y. */
export function sanitizeNormals(n) {
  for (let i = 0; i < n.length; i += 3) {
    const l = Math.hypot(n[i], n[i + 1], n[i + 2]);
    if (!(l > 1e-8) || !Number.isFinite(l)) {
      n[i] = 0;
      n[i + 1] = 1;
      n[i + 2] = 0;
    } else {
      n[i] /= l;
      n[i + 1] /= l;
      n[i + 2] /= l;
    }
  }
  return n;
}

/** Area-weighted vertex normals from an indexed triangle list. */
export function computeNormals(positions, indices) {
  const n = new Float32Array(positions.length);
  for (let t = 0; t < indices.length; t += 3) {
    const a = indices[t] * 3,
      b = indices[t + 1] * 3,
      c = indices[t + 2] * 3;
    const ux = positions[b] - positions[a],
      uy = positions[b + 1] - positions[a + 1],
      uz = positions[b + 2] - positions[a + 2];
    const vx = positions[c] - positions[a],
      vy = positions[c + 1] - positions[a + 1],
      vz = positions[c + 2] - positions[a + 2];
    const nx = uy * vz - uz * vy,
      ny = uz * vx - ux * vz,
      nz = ux * vy - uy * vx;
    for (const o of [a, b, c]) {
      n[o] += nx;
      n[o + 1] += ny;
      n[o + 2] += nz;
    }
  }
  return sanitizeNormals(n);
}

export function indexArray(list, vertexCount) {
  return vertexCount > 65535 ? Uint32Array.from(list) : Uint16Array.from(list);
}

const SRGB_LUT = (() => {
  const t = new Uint8Array(4097);
  for (let i = 0; i <= 4096; i++) {
    const c = i / 4096;
    t[i] = Math.round(255 * (c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055));
  }
  return t;
})();
export function linearToSrgb8(c) {
  return SRGB_LUT[c <= 0 ? 0 : c >= 1 ? 4096 : (c * 4096 + 0.5) | 0];
}

// ---------------------------------------------------------------------------------------------
// Terrain
// ---------------------------------------------------------------------------------------------

/** Largest vertex count <= requested that point-samples the heightfield on an integer stride. */
export function terrainMeshResolution(res, requested) {
  const want = Math.max(2, Math.min(res, Math.round(requested || 513)));
  let step = Math.max(1, Math.ceil((res - 1) / (want - 1)));
  while ((res - 1) % step !== 0) step++;
  return { n: (res - 1) / step + 1, step };
}

/**
 * Indexed terrain mesh from hFinal (point sampled every `step` cells).
 * Triangulation: each quad is split along the (i+1,j)-(i,j+1) diagonal; `sample(x,z)` evaluates
 * exactly that piecewise-linear surface (used to keep road ribbons above the exported mesh).
 */
export function buildTerrainMesh(world, requestedRes) {
  const hf = world.hFinal;
  const res = hf.res;
  const { n, step } = terrainMeshResolution(res, requestedRes);
  const d = hf.data;
  const positions = new Float32Array(n * n * 3);
  const normals = new Float32Array(n * n * 3);
  const uvs = new Float32Array(n * n * 2);
  const cellM = hf.cell * step;
  const hAt = (i, j) => d[(j < 0 ? 0 : j >= n ? n - 1 : j) * step * res + (i < 0 ? 0 : i >= n ? n - 1 : i) * step];
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const v = j * n + i;
      positions[v * 3] = hf.toWorldX(i * step);
      positions[v * 3 + 1] = d[j * step * res + i * step];
      positions[v * 3 + 2] = hf.toWorldZ(j * step);
      const sx = i === 0 || i === n - 1 ? 1 : 2;
      const sz = j === 0 || j === n - 1 ? 1 : 2;
      const gx = (hAt(i + 1, j) - hAt(i - 1, j)) / (sx * cellM);
      const gz = (hAt(i, j + 1) - hAt(i, j - 1)) / (sz * cellM);
      const l = 1 / Math.hypot(gx, 1, gz);
      normals[v * 3] = -gx * l;
      normals[v * 3 + 1] = l;
      normals[v * 3 + 2] = -gz * l;
      uvs[v * 2] = i / (n - 1);
      uvs[v * 2 + 1] = j / (n - 1);
    }
  }
  const indices = new Uint32Array((n - 1) * (n - 1) * 6);
  let o = 0;
  for (let j = 0; j < n - 1; j++) {
    for (let i = 0; i < n - 1; i++) {
      const a = j * n + i,
        b = a + n,
        c = a + 1,
        e = b + 1;
      indices[o++] = a;
      indices[o++] = b;
      indices[o++] = c;
      indices[o++] = c;
      indices[o++] = b;
      indices[o++] = e;
    }
  }
  const sample = (x, z) => {
    let gx = (x + hf.half) / cellM,
      gz = (z + hf.half) / cellM;
    gx = gx < 0 ? 0 : gx > n - 1 ? n - 1 : gx;
    gz = gz < 0 ? 0 : gz > n - 1 ? n - 1 : gz;
    let i = gx | 0,
      j = gz | 0;
    if (i >= n - 1) i = n - 2;
    if (j >= n - 1) j = n - 2;
    const fx = gx - i,
      fz = gz - j;
    const h00 = hAt(i, j),
      h10 = hAt(i + 1, j),
      h01 = hAt(i, j + 1),
      h11 = hAt(i + 1, j + 1);
    if (fx + fz <= 1) return h00 + (h10 - h00) * fx + (h01 - h00) * fz;
    return h11 + (h01 - h11) * (1 - fx) + (h10 - h11) * (1 - fz);
  };
  return { n, step, cellM, positions, normals, uvs, indices, sample, triangles: indices.length / 3 };
}

/** Linear RGB colour of each of the nine ground layers: manifest avgColor x project tint. */
export function groundLayerColors(world, manifest) {
  const layers = world.project.materials?.layers || {};
  const fallback = { grass: [0.12, 0.16, 0.05], forest: [0.08, 0.07, 0.04], scree: [0.2, 0.19, 0.17], sand: [0.42, 0.35, 0.24], pebbles: [0.22, 0.2, 0.17], mud: [0.09, 0.07, 0.05], snow: [0.8, 0.8, 0.82], path: [0.2, 0.15, 0.1], rock: [0.17, 0.16, 0.14] };
  const missing = [];
  const colors = MAT_NAMES.map((name) => {
    const l = layers[name];
    const tex = l && manifest.textures ? manifest.textures[l.texture] : null;
    if (!tex || !tex.avgColor) {
      missing.push(name);
      return fallback[name];
    }
    const tint = l.tint || [1, 1, 1];
    return [tex.avgColor[0] * tint[0], tex.avgColor[1] * tint[1], tex.avgColor[2] * tint[2]];
  });
  return { colors, missing };
}

/**
 * Bake one base-colour image (RGB8, sRGB) for the terrain: ground-layer colours blended by the
 * ground weights (bilinear), modulated by subtle slope darkening and two noise octaves.
 * Row 0 = north (iz = 0); texel centres coincide with the heightfield extent (u = ix / (res-1)).
 */
export function bakeTerrainColor(world, manifest, texRes) {
  const hf = world.hFinal;
  const res = hf.res;
  const weights = world.weights;
  const { colors, missing } = groundLayerColors(world, manifest);
  const cr = colors.map((c) => c[0]),
    cg = colors.map((c) => c[1]),
    cb = colors.map((c) => c[2]);
  const out = new Uint8Array(texRes * texRes * 3);
  const noise = new Noise2D(hash32(world.project.seed | 0, 9001));
  const sc = (res - 1) / (texRes - 1);
  const texel = hf.size / (texRes - 1);
  const e = Math.max(hf.cell, texel);
  const w = new Float32Array(9);
  for (let tz = 0; tz < texRes; tz++) {
    let gz = tz * sc;
    if (gz > res - 1) gz = res - 1;
    let iz = gz | 0;
    if (iz >= res - 1) iz = res - 2;
    const fz = gz - iz;
    const z = -hf.half + tz * texel;
    for (let tx = 0; tx < texRes; tx++) {
      let gx = tx * sc;
      if (gx > res - 1) gx = res - 1;
      let ix = gx | 0;
      if (ix >= res - 1) ix = res - 2;
      const fx = gx - ix;
      const x = -hf.half + tx * texel;
      const i00 = (iz * res + ix) * 8;
      const i10 = i00 + 8,
        i01 = i00 + res * 8,
        i11 = i01 + 8;
      const w00 = (1 - fx) * (1 - fz),
        w10 = fx * (1 - fz),
        w01 = (1 - fx) * fz,
        w11 = fx * fz;
      let sum = 0;
      for (let k = 0; k < 8; k++) {
        const v = (weights[i00 + k] * w00 + weights[i10 + k] * w10 + weights[i01 + k] * w01 + weights[i11 + k] * w11) / 255;
        w[k] = v;
        sum += v;
      }
      w[8] = sum < 1 ? 1 - sum : 0;
      const norm = sum > 1 ? 1 / sum : 1;
      let r = 0,
        g = 0,
        b = 0;
      for (let k = 0; k < 9; k++) {
        const v = w[k] * (k < 8 ? norm : 1);
        r += v * cr[k];
        g += v * cg[k];
        b += v * cb[k];
      }
      const slope = Math.hypot(hf.sample(x + e, z) - hf.sample(x - e, z), hf.sample(x, z + e) - hf.sample(x, z - e)) / (2 * e);
      const shade = (1 - 0.2 * smoothstep(0.45, 1.5, slope)) * (1 + 0.11 * noise.fbm(x / 31, z / 31, 2) + 0.07 * noise.noise(x / 4.3, z / 4.3));
      const o = (tz * texRes + tx) * 3;
      out[o] = linearToSrgb8(r * shade);
      out[o + 1] = linearToSrgb8(g * shade);
      out[o + 2] = linearToSrgb8(b * shade);
    }
  }
  return { pixels: out, missingLayers: missing };
}

// ---------------------------------------------------------------------------------------------
// Water
// ---------------------------------------------------------------------------------------------

/**
 * Assign every wet cell to a named water body.
 * @returns {{label:Int16Array, bodies:Array<{name,kind,id,level,flat,cells}>}}
 */
export function labelWaterBodies(world) {
  const wf = world.water;
  const res = world.res;
  const N = res * res;
  const type = wf.type;
  const surf = wf.surf;
  const label = new Int16Array(N).fill(-1);
  const bodies = [];
  const add = (b) => {
    bodies.push({ cells: 0, ...b });
    return bodies.length - 1;
  };
  // ocean
  let oceanIdx = -1;
  for (let i = 0; i < N; i++) {
    if (type[i] === WATER_OCEAN) {
      if (oceanIdx < 0) oceanIdx = add({ name: 'water_ocean', kind: 'ocean', id: 'sea', level: world.seaLevel ?? surf[i], flat: true });
      label[i] = oceanIdx;
      bodies[oceanIdx].cells++;
    }
  }
  // lakes: connected components of equal-level lake cells, matched to the lake whose seed they contain
  const lakes = world.project.water.lakes || [];
  const lakeBody = new Map(); // lake index -> body index
  const seedCell = lakes.map((l) => {
    const ix = Math.round(world.hFinal.toGridX(l.x)),
      iz = Math.round(world.hFinal.toGridZ(l.z));
    return ix < 0 || iz < 0 || ix >= res || iz >= res ? -1 : iz * res + ix;
  });
  const comp = new Int32Array(N).fill(-1);
  const queue = new Int32Array(N);
  const comps = [];
  for (let s = 0; s < N; s++) {
    if (type[s] !== WATER_LAKE || comp[s] >= 0) continue;
    const id = comps.length;
    const level = surf[s];
    let qh = 0,
      qt = 0;
    queue[qt++] = s;
    comp[s] = id;
    while (qh < qt) {
      const c = queue[qh++];
      const cx = c % res;
      const cz = (c / res) | 0;
      for (let k = 0; k < 4; k++) {
        const x = cx + (k === 0 ? 1 : k === 1 ? -1 : 0),
          z = cz + (k === 2 ? 1 : k === 3 ? -1 : 0);
        if (x < 0 || z < 0 || x >= res || z >= res) continue;
        const i = z * res + x;
        if (comp[i] >= 0 || type[i] !== WATER_LAKE || Math.abs(surf[i] - level) > 1e-3) continue;
        comp[i] = id;
        queue[qt++] = i;
      }
    }
    comps.push({ level, cells: queue.slice(0, qt) });
  }
  comps.forEach((c, ci) => {
    let li = seedCell.findIndex((sc, k) => sc >= 0 && comp[sc] === ci && Math.abs(lakes[k].level - c.level) < 1e-3);
    if (li < 0) {
      // seed cell not part of the component (e.g. covered by a river): nearest lake with this level
      let best = Infinity;
      const c0 = c.cells[0];
      lakes.forEach((l, k) => {
        if (Math.abs(l.level - c.level) > 1e-3) return;
        const d = Math.hypot(world.hFinal.toWorldX(c0 % res) - l.x, world.hFinal.toWorldZ((c0 / res) | 0) - l.z);
        if (d < best) {
          best = d;
          li = k;
        }
      });
    }
    let bi;
    if (li >= 0) {
      if (!lakeBody.has(li)) lakeBody.set(li, add({ name: 'water_lake_' + safeName(lakes[li].id || 'l' + (li + 1)), kind: 'lake', id: lakes[li].id || 'l' + (li + 1), level: lakes[li].level, flat: true, lakeIndex: li }));
      bi = lakeBody.get(li);
    } else bi = add({ name: 'water_lake_unnamed' + (ci + 1), kind: 'lake', id: 'unnamed' + (ci + 1), level: c.level, flat: true });
    for (const i of c.cells) label[i] = bi;
    bodies[bi].cells += c.cells.length;
  });
  // rivers: cells inside each compiled river's raster; prefer the river whose profile matches the surface
  const rivers = world.compiled.rivers || [];
  const riverBody = rivers.map((c, k) => (c ? add({ name: 'water_river_' + safeName(c.id || 'r' + (k + 1)), kind: 'river', id: c.id || 'r' + (k + 1), level: null, flat: false, riverIndex: k }) : -1));
  for (const strict of [true, false]) {
    rivers.forEach((c, k) => {
      if (!c) return;
      const { rect, w, idx } = c.raster;
      for (let iz = rect.z0; iz <= rect.z1; iz++) {
        for (let ix = rect.x0; ix <= rect.x1; ix++) {
          const kk = idx[(iz - rect.z0) * w + (ix - rect.x0)];
          if (kk < 0) continue;
          const gi = iz * res + ix;
          if (type[gi] !== WATER_RIVER || label[gi] >= 0) continue;
          if (strict && Math.abs(surf[gi] - c.surf[kk]) > 0.03) continue;
          label[gi] = riverBody[k];
          bodies[riverBody[k]].cells++;
        }
      }
    });
  }
  let misc = -1;
  for (let i = 0; i < N; i++) {
    if (type[i] !== 0 && label[i] < 0) {
      if (misc < 0) misc = add({ name: 'water_river_misc', kind: 'river', id: 'misc', level: null, flat: false });
      label[i] = misc;
      bodies[misc].cells++;
    }
  }
  return { label, bodies };
}

export function safeName(s) {
  return String(s).replace(/[^a-zA-Z0-9_-]/g, '_');
}

/**
 * Triangulate the water surface. A grid quad is emitted when all four corners carry a (possibly
 * extended) surface elevation and at least one corner is wet; it belongs to the body of its first
 * wet corner. Dry corners are "skirt" vertices: the surface continues level under the bank so the
 * waterline is the true terrain intersection. Still bodies merge coplanar quads into rectangles
 * of up to `maxRect` cells; rivers keep every cell so the surface follows the long profile.
 * Per-vertex flow velocity (m/s) is returned as `flow` (vx, vz) -> TEXCOORD_1.
 */
export function buildWaterMeshes(world, labelled, maxRect = 64) {
  const wf = world.water;
  const hf = world.hFinal;
  const res = world.res;
  const q = res - 1;
  const { label, bodies } = labelled;
  const surf = wf.surf;
  const type = wf.type;
  const owner = new Int16Array(q * q).fill(-1);
  const flat = new Uint8Array(q * q);
  for (let iz = 0; iz < q; iz++) {
    for (let ix = 0; ix < q; ix++) {
      const a = iz * res + ix,
        b = a + 1,
        c = a + res,
        d = c + 1;
      if (surf[a] <= LIM || surf[b] <= LIM || surf[c] <= LIM || surf[d] <= LIM) continue;
      const first = type[a] ? a : type[b] ? b : type[c] ? c : type[d] ? d : -1;
      if (first < 0) continue;
      const o = label[first];
      if (o < 0) continue;
      owner[iz * q + ix] = o;
      const body = bodies[o];
      if (body.flat) {
        const L = body.level;
        if (Math.abs(surf[a] - L) < 1e-4 && Math.abs(surf[b] - L) < 1e-4 && Math.abs(surf[c] - L) < 1e-4 && Math.abs(surf[d] - L) < 1e-4) flat[iz * q + ix] = 1;
      }
    }
  }
  const builders = bodies.map(() => ({ pos: [], flow: [], idx: [], map: new Map(), quads: 0, rects: 0 }));
  const vert = (bd, node) => {
    let v = bd.map.get(node);
    if (v === undefined) {
      v = bd.pos.length / 3;
      bd.pos.push(hf.toWorldX(node % res), surf[node], hf.toWorldZ((node / res) | 0));
      bd.flow.push(wf.vx[node], wf.vz[node]);
      bd.map.set(node, v);
    }
    return v;
  };
  const emit = (bd, ix0, iz0, ix1, iz1) => {
    // rectangle spanning grid nodes (ix0,iz0)-(ix1,iz1)
    const a = vert(bd, iz0 * res + ix0),
      b = vert(bd, iz1 * res + ix0),
      c = vert(bd, iz0 * res + ix1),
      d = vert(bd, iz1 * res + ix1);
    bd.idx.push(a, b, c, c, b, d);
    bd.rects++;
  };
  const done = new Uint8Array(q * q);
  for (let iz = 0; iz < q; iz++) {
    for (let ix = 0; ix < q; ix++) {
      const k = iz * q + ix;
      const o = owner[k];
      if (o < 0 || done[k]) continue;
      const bd = builders[o];
      if (!flat[k]) {
        done[k] = 1;
        bd.quads++;
        emit(bd, ix, iz, ix + 1, iz + 1);
        continue;
      }
      // greedy rectangle of coplanar quads owned by the same body
      let wq = 1;
      while (wq < maxRect && ix + wq < q && owner[k + wq] === o && flat[k + wq] && !done[k + wq]) wq++;
      let hq = 1;
      outer: while (hq < maxRect && iz + hq < q) {
        const row = (iz + hq) * q + ix;
        for (let i = 0; i < wq; i++) if (owner[row + i] !== o || !flat[row + i] || done[row + i]) break outer;
        hq++;
      }
      for (let j = 0; j < hq; j++) done.fill(1, (iz + j) * q + ix, (iz + j) * q + ix + wq);
      bd.quads += wq * hq;
      emit(bd, ix, iz, ix + wq, iz + hq);
    }
  }
  const out = [];
  bodies.forEach((body, bi) => {
    const bd = builders[bi];
    if (!bd.idx.length) return;
    const positions = Float32Array.from(bd.pos);
    const indices = indexArray(bd.idx, positions.length / 3);
    const normals = computeNormals(positions, indices);
    // TEXCOORD_0: planar world-space uv (1 unit = WATER_UV_METERS) so tiling normal maps can be applied
    const uvs = new Float32Array((positions.length / 3) * 2);
    for (let v = 0; v < uvs.length / 2; v++) {
      uvs[v * 2] = positions[v * 3] / WATER_UV_METERS;
      uvs[v * 2 + 1] = positions[v * 3 + 2] / WATER_UV_METERS;
    }
    out.push({ body, positions, normals, uvs, flow: Float32Array.from(bd.flow), indices, cellQuads: bd.quads, triangles: indices.length / 3 });
  });
  return out;
}

// ---------------------------------------------------------------------------------------------
// Scatter instances
// ---------------------------------------------------------------------------------------------

/**
 * Rotation of a scatter instance, matching the renderer (src/render/Models.js instanceTransform):
 * the model is scaled, tilted by the linearised shear (x + a*y, y - a*x - b*z, z + b*y) with
 * a = tiltX, b = tiltZ - i.e. a rotation about the axis (b, 0, -a) by atan(|(a, b)|) - and then
 * yawed by +rotY about +Y (x' = x cos + z sin, z' = -x sin + z cos).
 */
export function instanceQuaternion(rotY, tiltX, tiltZ) {
  const yaw = [0, Math.sin(rotY / 2), 0, Math.cos(rotY / 2)];
  const m = Math.hypot(tiltX, tiltZ);
  if (m < 1e-6) return yaw;
  return quatNormalize(quatMul(yaw, quatFromAxisAngle(tiltZ, 0, -tiltX, Math.atan(m))));
}

const r3 = (v) => Math.round(v * 1000) / 1000;

/**
 * Gather every (non-detail) scatter instance per layer and model variant.
 * If the total exceeds maxInstances the set is thinned uniformly (deterministically).
 */
export function collectScatter(world, maxInstances) {
  const layers = world.layerList().filter((L) => !L.detail);
  const byKey = new Map(layers.map((L) => [L.key, { L, counts: new Int32Array(L.layer.models.length), kept: new Int32Array(L.layer.models.length) }]));
  const cells = [...world.scatterCells.values()].sort((a, b) => a.cz - b.cz || a.cx - b.cx);
  let total = 0;
  for (const cell of cells) {
    for (const [key, inst] of cell.layers) {
      const e = byKey.get(key);
      if (!e) continue;
      for (let i = 0; i < inst.count; i++) {
        const v = Math.floor(inst.data[i * INSTANCE_STRIDE + 7]);
        if (v >= 0 && v < e.counts.length) {
          e.counts[v]++;
          total++;
        }
      }
    }
  }
  const cap = Math.max(0, Math.floor(maxInstances ?? 400000));
  const ratio = total > cap ? cap / total : 1;
  // pass 2: decide which instances are kept (error-diffusion thinning), count per variant
  let acc = 0;
  const keepFlags = ratio < 1 ? new Uint8Array(total) : null;
  if (keepFlags) {
    let n = 0;
    for (const cell of cells) {
      for (const [key, inst] of cell.layers) {
        const e = byKey.get(key);
        if (!e) continue;
        for (let i = 0; i < inst.count; i++) {
          const v = Math.floor(inst.data[i * INSTANCE_STRIDE + 7]);
          if (!(v >= 0 && v < e.counts.length)) continue;
          acc += ratio;
          if (acc >= 1) {
            acc -= 1;
            keepFlags[n] = 1;
            e.kept[v]++;
          }
          n++;
        }
      }
    }
  } else for (const e of byKey.values()) e.kept.set(e.counts);
  for (const e of byKey.values()) {
    e.variants = Array.from(e.kept, (n) => (n > 0 ? { translation: new Float32Array(n * 3), rotation: new Float32Array(n * 4), scale: new Float32Array(n * 3), n: 0 } : null));
    e.rows = [];
  }
  let n = 0;
  let exported = 0;
  for (const cell of cells) {
    for (const [key, inst] of cell.layers) {
      const e = byKey.get(key);
      if (!e) continue;
      const d = inst.data;
      for (let i = 0; i < inst.count; i++) {
        const o = i * INSTANCE_STRIDE;
        const v = Math.floor(d[o + 7]);
        if (!(v >= 0 && v < e.counts.length)) continue;
        const keep = keepFlags ? keepFlags[n] : 1;
        n++;
        if (!keep) continue;
        const va = e.variants[v];
        const k = va.n++;
        va.translation[k * 3] = d[o];
        va.translation[k * 3 + 1] = d[o + 1];
        va.translation[k * 3 + 2] = d[o + 2];
        const qn = instanceQuaternion(d[o + 4], d[o + 5], d[o + 6]);
        va.rotation.set(qn, k * 4);
        va.scale[k * 3] = va.scale[k * 3 + 1] = va.scale[k * 3 + 2] = d[o + 3];
        e.rows.push([r3(d[o]), r3(d[o + 1]), r3(d[o + 2]), r3(d[o + 3]), r3((d[o + 4] * 180) / Math.PI), v]);
        exported++;
      }
    }
  }
  return { layers: [...byKey.values()], total, exported, truncated: ratio < 1 };
}

// ---------------------------------------------------------------------------------------------
// Roads
// ---------------------------------------------------------------------------------------------

/**
 * Ribbon mesh along a compiled road, draped on the terrain (max of the full-resolution
 * heightfield and the exported, possibly decimated, terrain mesh) plus `offset` metres.
 */
export function buildRoadRibbon(world, c, terrainSample, tileM = 2, offset = 0.03) {
  const sp = c.sp;
  const hf = world.hFinal;
  const stepK = Math.max(1, Math.round(2 / sp.ds));
  const ks = [];
  for (let k = 0; k < sp.n; k += stepK) ks.push(k);
  if (ks[ks.length - 1] !== sp.n - 1) ks.push(sp.n - 1);
  const ACROSS = 5;
  const positions = new Float32Array(ks.length * ACROSS * 3);
  const uvs = new Float32Array(ks.length * ACROSS * 2);
  const idx = [];
  ks.forEach((k, r) => {
    const nx = -sp.tz[k],
      nz = sp.tx[k];
    const hw = c.hw[k];
    for (let j = 0; j < ACROSS; j++) {
      const t = (j / (ACROSS - 1)) * 2 - 1;
      const x = Math.max(-hf.half, Math.min(hf.half, sp.x[k] + nx * t * hw));
      const z = Math.max(-hf.half, Math.min(hf.half, sp.z[k] + nz * t * hw));
      const v = r * ACROSS + j;
      positions[v * 3] = x;
      positions[v * 3 + 1] = Math.max(hf.sample(x, z), terrainSample ? terrainSample(x, z) : -Infinity) + offset;
      positions[v * 3 + 2] = z;
      uvs[v * 2] = ((t + 1) * hw) / tileM;
      uvs[v * 2 + 1] = sp.s[k] / tileM;
    }
    if (r < ks.length - 1) {
      for (let j = 0; j < ACROSS - 1; j++) {
        const a = r * ACROSS + j,
          b = a + 1,
          e = a + ACROSS,
          f = e + 1;
        idx.push(a, b, e, e, b, f);
      }
    }
  });
  const indices = indexArray(idx, positions.length / 3);
  return { positions, uvs, indices, normals: computeNormals(positions, indices), samples: ks.length, triangles: indices.length / 3 };
}
