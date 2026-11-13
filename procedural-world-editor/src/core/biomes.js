// Biome rules: ground-material weights and scatter-layer placement, evaluated on the CPU so the
// editor, the exporter and the tests all see the same data the renderer draws.

import { Noise2D, smoothstep, clamp, hash32, hashFloat } from './noise.js';
import { NO_WATER, WATER_RIVER, WATER_LAKE, WATER_OCEAN } from './waterField.js';

// Ground material layers. Index 8 (rock) is the implicit remainder of the eight weights.
export const MAT = { grass: 0, forest: 1, scree: 2, sand: 3, pebbles: 4, mud: 5, snow: 6, path: 7, rock: 8 };
export const MAT_NAMES = ['grass', 'forest', 'scree', 'sand', 'pebbles', 'mud', 'snow', 'path', 'rock'];
export const MAT_LABELS = ['Grass', 'Forest floor', 'Scree / talus', 'Sand', 'River pebbles', 'Mud / wet soil', 'Snow', 'Path surface', 'Bedrock'];

/** Trapezoid response: 0 outside [a-f, b+f], 1 inside [a, b]. */
export function band(v, a, b, f) {
  if (v < a) return f > 0 ? clamp(1 - (a - v) / f, 0, 1) : 0;
  if (v > b) return f > 0 ? clamp(1 - (v - b) / f, 0, 1) : 0;
  return 1;
}

export function defaultMaterialRules() {
  return {
    rockSlope: [1.12, 1.6], // tan(slope) where bedrock starts / fully exposed
    screeSlope: [0.92, 1.25],
    snowLine: 2350,
    snowFade: 180,
    treeLine: 2050,
    beachTop: 2.6, // m above sea level
    shoreBand: 1.2, // m above lake / river level that stays bare (pebbles, mud)
  };
}

/**
 * Compute ground weights (8 x Uint8 per cell) and the biome index map for a grid rect.
 * ctx: { hf, wf, masks:{channel,bank,road,roadKind,clear,pad}, sediment, moisture(Uint8), paint:{biome, mat:[...], }, biomes, rules, seed, seaLevel, weights(Uint8 N*8), biomeMap(Uint8) }
 */
export function computeGround(ctx, rect) {
  const { hf, wf, masks, sediment, moisture, paint, biomes, rules, weights, biomeMap } = ctx;
  const res = hf.res;
  const cell = hf.cell;
  const h = hf.data;
  const nA = ctx._nA || (ctx._nA = new Noise2D(hash32(ctx.seed, 501)));
  const nB = ctx._nB || (ctx._nB = new Noise2D(hash32(ctx.seed, 502)));
  const sea = ctx.seaLevel;
  const w = new Float32Array(8);
  const autoOrder = biomes.map((b, i) => i).sort((a, b) => (biomes[b].auto?.priority ?? 0) - (biomes[a].auto?.priority ?? 0));
  const x0 = Math.max(1, rect.x0),
    x1 = Math.min(res - 2, rect.x1),
    z0 = Math.max(1, rect.z0),
    z1 = Math.min(res - 2, rect.z1);
  for (let iz = z0; iz <= z1; iz++) {
    const z = hf.toWorldZ(iz);
    for (let ix = x0; ix <= x1; ix++) {
      const i = iz * res + ix;
      const x = hf.toWorldX(ix);
      const alt = h[i];
      const gx = (h[i + 1] - h[i - 1]) / (2 * cell);
      const gz = (h[i + res] - h[i - res]) / (2 * cell);
      const slope = Math.hypot(gx, gz);
      const n1 = nA.fbm(x / 37, z / 37, 3);
      const n2 = nB.fbm(x / 9, z / 9, 2);
      const n3 = nA.noise(x / 140 + 31, z / 140);
      const moist = moisture[i] / 255;
      const sed = sediment ? sediment[i] : 0;
      // ---- biome selection ----
      let b = paint.biome ? paint.biome[i] : 0;
      if (b === 0 || b > biomes.length) {
        b = 0;
        const altJ = alt + n1 * 45 + n3 * 60;
        const moistJ = clamp(moist + n2 * 0.08, 0, 1);
        for (const bi of autoOrder) {
          const a = biomes[bi].auto;
          if (!a || a.enabled === false) continue;
          const altB = a.altJitter !== undefined ? alt + (altJ - alt) * a.altJitter : altJ;
          if (altB < (a.altMin ?? -1e9) || altB > (a.altMax ?? 1e9)) continue;
          if (slope > (a.slopeMax ?? 1e9) || slope < (a.slopeMin ?? 0)) continue;
          if (moistJ < (a.moistMin ?? 0) || moistJ > (a.moistMax ?? 1)) continue;
          // waterside belts are ragged: wide where the ground is damp and low, pinched elsewhere
          if (a.shoreMax !== undefined && -wf.shore[i] > a.shoreMax * (a.shoreJitter === 0 ? 1 : clamp(0.95 + n1 * 0.85 + n3 * 0.55, 0.3, 1.9))) continue;
          b = bi + 1;
          break;
        }
        if (b === 0) b = autoOrder.length ? autoOrder[autoOrder.length - 1] + 1 : 0;
      }
      biomeMap[i] = b;
      const biome = biomes[b - 1];
      w.fill(0);
      // ---- biome ground cover ----
      if (biome) {
        const g = biome.ground || {};
        const sec = g.secondary !== undefined ? smoothstep(-0.15, 0.25, n1 * 0.7 + n2 * 0.5 + (g.secondaryBias ?? -0.1)) * (g.secondaryAmount ?? 0.5) : 0;
        w[MAT[g.primary || 'grass']] += 1 - sec;
        if (sec > 0) w[MAT[g.secondary]] += sec;
      } else w[MAT.grass] = 1;
      // ---- geology: bedrock on steep slopes, talus below it, sediment fans ----
      const rockT = smoothstep(rules.rockSlope[0], rules.rockSlope[1], slope + n2 * 0.12 + n1 * 0.06);
      const screeT = smoothstep(rules.screeSlope[0], rules.screeSlope[1], slope + n1 * 0.1) * (1 - rockT);
      const alpine = smoothstep(rules.treeLine - 120, rules.treeLine + 160, alt + n1 * 60);
      let scree = Math.max(screeT * (0.55 + 0.45 * alpine), alpine * smoothstep(0.25, 0.5, slope + n2 * 0.15) * 0.7);
      scree = Math.max(scree, sed * smoothstep(0.3, 0.55, slope) * 0.8);
      for (let k = 0; k < 8; k++) w[k] *= 1 - scree;
      w[MAT.scree] += scree;
      // ---- snow ----
      const aspect = clamp(-gz * 0.6, -0.3, 0.3); // north-facing (towards -z... +z slopes face south in this convention)
      const snow = smoothstep(rules.snowLine - rules.snowFade, rules.snowLine + rules.snowFade, alt + n1 * 70 + aspect * 220) * (1 - smoothstep(0.9, 1.3, slope));
      if (snow > 0) {
        for (let k = 0; k < 8; k++) w[k] *= 1 - snow;
        w[MAT.snow] += snow;
      }
      // ---- water related ----
      const surf = wf.surf[i];
      const hasW = surf > NO_WATER * 0.5;
      const type = wf.type[i];
      if (hasW) {
        const above = alt - surf; // + above water, - below
        const shoreD = -wf.shore[i]; // metres from the waterline on land
        let bare = 0,
          sandW = 0,
          pebW = 0,
          mudW = 0;
        // classify by the nearest water body kind using masks: channel/bank => river
        const riverish = masks.bank[i] > 0;
        if (riverish) {
          const ch = masks.channel[i] / 255;
          const bk = masks.bank[i] / 255;
          bare = Math.max(ch, smoothstep(rules.shoreBand + 0.5, 0.0, above + n2 * 0.5) * bk);
          pebW = bare * (0.72 + 0.28 * n1);
          mudW = bare * smoothstep(0.1, 0.5, n3 + moist * 0.3) * 0.35 * (1 - ch);
          sandW = bare * smoothstep(0.25, 0.6, n1 * 0.6 - n3 * 0.4 + 0.1) * 0.35;
        } else if (sea !== null && Math.abs(surf - sea) < 0.01) {
          // coast: sand where sediment collected and slopes are gentle, rock stays rock
          const sandy = smoothstep(0.42, 0.2, slope) * smoothstep(0.15, 0.5, sed + 0.25 * smoothstep(0.3, 0.1, slope));
          const top = rules.beachTop + n1 * 0.6;
          const up = above < 0 ? 1 : smoothstep(top + 1.2, top - 0.3, above);
          bare = sandy * up;
          sandW = bare;
          const peb = smoothstep(0.2, 0.6, n1 * 0.8 + n2 * 0.4) * 0.5 * smoothstep(-0.5, 0.6, above) * smoothstep(1.6, 0.4, above);
          pebW = bare * peb;
          sandW -= pebW;
          // rocky shore platform: scree/cobbles at the cliff foot
          // (only in the surf zone: below wave base fine sediment settles and the bed is sand)
          const deep = smoothstep(0.8, 3.2, -above + n2 * 0.6);
          const cobble = (1 - sandy) * smoothstep(1.5, -0.5, above) * smoothstep(0.75, 0.35, slope) * 0.8 * (1 - deep * 0.9);
          pebW += cobble;
          const seabed = deep * smoothstep(0.8, 0.45, slope) * (1 - sandy);
          sandW += seabed;
          bare = Math.max(bare, cobble, seabed);
        } else {
          // lake: narrow bare shoreline, pebbles in the shallows, silt in deep water
          const band = above < 0 ? 1 : smoothstep(rules.shoreBand, 0.05, above + n2 * 0.35);
          bare = band * (above < 0 ? 1 : smoothstep(6, 1.5, shoreD));
          const deep = smoothstep(0.6, 3.0, -above);
          mudW = bare * (0.25 + 0.6 * deep + 0.2 * moist) * smoothstep(0.5, 0.2, slope);
          pebW = bare * (1 - deep) * (0.55 + 0.4 * n1);
          sandW = Math.max(0, bare - mudW - pebW) * 0.8;
        }
        if (bare > 0) {
          const keep = 1 - clamp(bare, 0, 1) * (1 - rockT * 0.85);
          for (let k = 0; k < 8; k++) w[k] *= keep;
          const f = 1 - rockT * 0.85;
          w[MAT.sand] += sandW * f;
          w[MAT.pebbles] += pebW * f;
          w[MAT.mud] += mudW * f;
        }
      }
      void type;
      // ---- bedrock exposure (applied last so cliffs cut through everything but paths) ----
      for (let k = 0; k < 8; k++) w[k] *= 1 - rockT;
      // ---- roads / trails / pads ----
      const road = masks.road[i] / 255;
      if (road > 0) {
        for (let k = 0; k < 8; k++) w[k] *= 1 - road;
        w[MAT.path] += road;
      }
      // ---- painted overrides ----
      if (paint.mat) {
        for (let m = 0; m < 9; m++) {
          const pm = paint.mat[m];
          if (!pm) continue;
          const p = pm[i] / 255;
          if (p <= 0) continue;
          for (let k = 0; k < 8; k++) w[k] *= 1 - p;
          if (m < 8) w[m] += p;
        }
      }
      let sum = 0;
      for (let k = 0; k < 8; k++) sum += w[k];
      const norm = sum > 1 ? 1 / sum : 1;
      const o = i * 8;
      for (let k = 0; k < 8; k++) weights[o + k] = Math.round(clamp(w[k] * norm, 0, 1) * 255);
    }
  }
}

/** Moisture (0..255) from drainage area, proximity to water, sediment and slope. */
export function computeMoisture(ctx, rect) {
  const { hf, wf, drainage, moisture, sediment } = ctx;
  const res = hf.res;
  const cell = hf.cell;
  const h = hf.data;
  const dres = drainage.res;
  const dsc = (dres - 1) / (res - 1);
  const x0 = Math.max(1, rect.x0),
    x1 = Math.min(res - 2, rect.x1),
    z0 = Math.max(1, rect.z0),
    z1 = Math.min(res - 2, rect.z1);
  for (let iz = z0; iz <= z1; iz++) {
    for (let ix = x0; ix <= x1; ix++) {
      const i = iz * res + ix;
      const gx = (h[i + 1] - h[i - 1]) / (2 * cell);
      const gz = (h[i + res] - h[i - res]) / (2 * cell);
      const slope = Math.hypot(gx, gz);
      // log10 drainage area: ~1.5 on ridges .. 7 in trunk valleys
      const dx = ix * dsc,
        dz = iz * dsc;
      const di = Math.min(dres - 2, dx | 0),
        dj = Math.min(dres - 2, dz | 0);
      const fx = dx - di,
        fz = dz - dj;
      const p = dj * dres + di;
      const la = drainage.data[p] * (1 - fx) * (1 - fz) + drainage.data[p + 1] * fx * (1 - fz) + drainage.data[p + dres] * (1 - fx) * fz + drainage.data[p + dres + 1] * fx * fz;
      let m = 0.28 + 0.16 * (la - 2.2) - 0.22 * smoothstep(0.4, 1.2, slope);
      const sd = -wf.shore[i];
      if (wf.surf[i] > NO_WATER * 0.5 || sd < 60) {
        m = Math.max(m, 1 - smoothstep(0, 38, sd) * 0.75);
      }
      // south-facing slopes are drier
      m += clamp(-gz, -0.5, 0.5) * 0.12;
      if (sediment) m += sediment[i] * 0.08;
      moisture[i] = Math.round(clamp(m, 0, 1) * 255);
    }
  }
}

// ------------------------------------------------------------------------------------------
// Scatter
// ------------------------------------------------------------------------------------------

const NOISE_CACHE = new Map();

export const INSTANCE_STRIDE = 8; // x, y, z, scale, rotY, tiltX, tiltZ, variant(+seed fraction)
export const SCATTER_CELL = 64; // metres

export function layerKey(biomeId, layerId) {
  return biomeId + '/' + layerId;
}

/**
 * Evaluate one scatter layer inside a world-space rectangle and append instances to `out`.
 * Candidates lie on a jittered grid anchored in world space, so results are independent of the
 * rect used to query them (cells can be regenerated individually and deterministically).
 * @returns {number} number of instances written
 */
export function scatterLayer(ctx, biomeIndex, layer, xmin, zmin, xmax, zmax, out, keysOut) {
  const { hf, wf, masks, moisture, paint, biomeMap, rules } = ctx;
  const sp = Math.max(0.2, layer.spacing);
  const lseed = hash32(ctx.seed, stringHash(layer.id), biomeIndex * 7919 + 13);
  let noise = NOISE_CACHE.get(lseed);
  if (!noise) {
    noise = new Noise2D(hash32(lseed, 3));
    NOISE_CACHE.set(lseed, noise);
  }
  const i0 = Math.floor(xmin / sp),
    i1 = Math.ceil(xmax / sp) - 1;
  const j0 = Math.floor(zmin / sp),
    j1 = Math.ceil(zmax / sp) - 1;
  const res = hf.res;
  const half = hf.half;
  const cell = hf.cell;
  const jitter = layer.jitter ?? 0.9;
  const models = layer.models;
  let wsum = 0;
  for (const m of models) wsum += m.weight ?? 1;
  const suppressed = ctx.suppressed;
  let n = 0;
  const sl = layer.slope || [0, 0.7, 0.15];
  const al = layer.altitude || [-1e9, 1e9, 0];
  const mo = layer.moisture || [0, 1, 0];
  const wd = layer.waterDist || [0.5, 1e9, 0]; // metres from the waterline on land
  const maxDepth = layer.maxDepth ?? 0; // > 0 allows standing in shallow water
  const minDepth = layer.minDepth ?? -1e9;
  const clusterScale = layer.clusterScale ?? 40;
  const clusterAmt = layer.cluster ?? 0.5;
  const density = layer.density ?? 1;
  const densPaint = paint.density ? paint.density[layer.group || 'trees'] : null;
  for (let j = j0; j <= j1; j++) {
    for (let i = i0; i <= i1; i++) {
      const hsh = hash32(i, j, lseed);
      const x = (i + 0.5 + (((hsh & 0xffff) / 65535) - 0.5) * jitter) * sp;
      const z = (j + 0.5 + ((((hsh >>> 16) & 0xffff) / 65535) - 0.5) * jitter) * sp;
      if (x < xmin || x >= xmax || z < zmin || z >= zmax) continue;
      if (x <= -half + cell * 2 || x >= half - cell * 2 || z <= -half + cell * 2 || z >= half - cell * 2) continue;
      const gxf = (x + half) / cell,
        gzf = (z + half) / cell;
      const gi = Math.round(gzf) * res + Math.round(gxf);
      if (biomeMap[gi] !== biomeIndex + 1) continue;
      let p = density;
      // exclusions
      if (paint.exclude && paint.exclude[gi] > 127) continue;
      const clr = masks.clear[gi];
      if (clr > 0 && !layer.ignoreClearing) {
        p *= 1 - clr / 255;
        if (p <= 0.002) continue;
      }
      if (masks.pad[gi]) continue;
      if (densPaint) {
        const dp = densPaint[gi];
        if (dp !== 128) p *= dp < 128 ? dp / 128 : 1 + ((dp - 128) / 127) * 3;
      }
      if (clusterAmt > 0) {
        const c = noise.fbm(x / clusterScale, z / clusterScale, 2) * 0.5 + 0.5;
        p *= 1 - clusterAmt + clusterAmt * smoothstep(0.32, 0.62, c) * 1.6;
      }
      const r1 = hashFloat(i, j, lseed ^ 0x5bd1e995);
      if (r1 >= p) continue;
      // terrain queries
      const y = hf.sample(x, z);
      const e = cell;
      const sx = (hf.sample(x + e, z) - hf.sample(x - e, z)) / (2 * e);
      const sz = (hf.sample(x, z + e) - hf.sample(x, z - e)) / (2 * e);
      const slope = Math.hypot(sx, sz);
      // suitability of the ground itself (slope, altitude) sets the plant's vigour; moisture and
      // distance to water only decide presence, so editing a water level does not resize the forest
      const fTerrain = band(slope, sl[0], sl[1], sl[2]) * band(y, al[0], al[1], al[2]);
      let f = fTerrain * band(moisture[gi] / 255, mo[0], mo[1], mo[2]);
      if (f <= 0) continue;
      const surf = wf.surf[gi];
      const hasW = surf > NO_WATER * 0.5;
      const depth = hasW ? surf - y : -1e9;
      if (depth > maxDepth) continue;
      if (depth < minDepth) continue;
      const shoreD = -wf.shore[gi];
      if (!(layer.inChannel && masks.channel[gi] > 0)) f *= band(depth > 0 ? 0 : shoreD, wd[0], wd[1], wd[2]);
      if (layer.onlyChannel && masks.bank[gi] === 0) continue;
      if (layer.onMaterial !== undefined) {
        const mw = layer.onMaterial === 8 ? 1 - sumWeights(ctx.weights, gi) : ctx.weights[gi * 8 + layer.onMaterial] / 255;
        f *= smoothstep(0.15, 0.5, mw);
      }
      if (layer.avoidMaterial !== undefined) {
        const mw = layer.avoidMaterial === 8 ? 1 - sumWeights(ctx.weights, gi) : ctx.weights[gi * 8 + layer.avoidMaterial] / 255;
        f *= 1 - smoothstep(0.25, 0.6, mw);
      }
      if (r1 >= p * f) continue;
      const key = i * 73856093 + j * 19349663;
      if (suppressed && suppressed.size && suppressed.has(layer.id + ':' + i + ':' + j)) continue;
      // variant
      const r2 = hashFloat(i, j, lseed ^ 0x27d4eb2f);
      let acc = 0,
        variant = 0;
      for (let m = 0; m < models.length; m++) {
        acc += (models[m].weight ?? 1) / wsum;
        if (r2 <= acc) {
          variant = m;
          break;
        }
      }
      const r3 = hashFloat(i, j, lseed ^ 0x165667b1);
      const r4 = hashFloat(i, j, lseed ^ 0x9e3779b9);
      const sc = layer.scale || [0.8, 1.2];
      // marginal sites grow smaller individuals
      const vigor = 0.55 + 0.45 * Math.min(1, fTerrain * 1.3);
      const scale = (sc[0] + (sc[1] - sc[0]) * r3 * r3 * (3 - 2 * r3)) * (layer.vigorScale === false ? 1 : vigor) * (models[variant].scale ?? 1);
      const align = layer.align ?? 0; // 0 upright .. 1 follows the ground normal
      const o = n * INSTANCE_STRIDE;
      out[o] = x;
      out[o + 1] = y - (layer.sink ?? 0) * scale - (layer.sinkSlope ?? 0) * slope * scale;
      out[o + 2] = z;
      out[o + 3] = scale;
      out[o + 4] = r4 * Math.PI * 2;
      out[o + 5] = -sx * align + (r3 - 0.5) * (layer.tilt ?? 0.04);
      out[o + 6] = -sz * align + (r4 - 0.5) * (layer.tilt ?? 0.04);
      out[o + 7] = variant + r2 * 0.999 * 0 + (hashFloat(i, j, lseed ^ 0x1234567) * 0.99);
      if (keysOut) {
        keysOut[n * 2] = i;
        keysOut[n * 2 + 1] = j;
      }
      void key;
      n++;
      if ((n + 1) * INSTANCE_STRIDE > out.length) return n;
    }
  }
  return n;
}

function sumWeights(weights, gi) {
  let s = 0;
  for (let k = 0; k < 8; k++) s += weights[gi * 8 + k];
  return s / 255;
}

export function stringHash(s) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}
