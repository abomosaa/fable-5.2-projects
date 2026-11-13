// Deterministic terrain generation.
// Pipeline: preset boundary conditions -> multigrid fluvial landscape evolution over a domain twice
// the editable size (so the surrounding "ring" terrain is the same landscape, not a backdrop) ->
// alluvial valley floors -> preset macro features (moraine dam, coastal profile, sea stacks) ->
// crop + bicubic upsample to the editable resolution -> slope-dependent detail noise ->
// particle hydraulic erosion + thermal erosion.
// Everything is a pure function of the parameter object; the same params give bit-identical output
// on the same JS engine.

import { Noise2D, smoothstep, clamp, lerp, hash32, hashFloat } from './noise.js';
import { upsampleBicubic, sampleGrid } from './heightfield.js';
import { evolveLandscape, traceTrunkStream, priorityFlood, computeReceivers, accumulateArea } from './fluvial.js';
import { hydraulicErosion, thermalErosion } from './erosion.js';

export const TERRAIN_PRESETS = {
  alpine: { label: 'Alpine valley', size: 3072, relief: 1.0, baseAltitude: 1180 },
  lake: { label: 'Lake basin', size: 2048, relief: 1.0, baseAltitude: 420 },
  coast: { label: 'Rugged coast', size: 3072, relief: 1.0, baseAltitude: 0 },
  hills: { label: 'Rolling hills', size: 2048, relief: 1.0, baseAltitude: 300 },
};

export function defaultTerrainParams(preset = 'alpine', seed = 1) {
  const p = TERRAIN_PRESETS[preset] || TERRAIN_PRESETS.alpine;
  return {
    preset,
    seed,
    size: p.size,
    res: 2049,
    relief: p.relief,
    baseAltitude: p.baseAltitude,
    detail: 1.0, // small-scale noise amplitude multiplier
    coarseRes: 1025, // final fluvial grid over the 2x domain
    erosionDroplets: 0.3, // droplets per cell for the built-in erosion pass
    thermalIterations: 12,
  };
}

function makeFields(n) {
  const N = n * n;
  return { n, h: new Float32Array(N), uplift: new Float32Array(N), K: new Float32Array(N), crit: new Float32Array(N), outlet: new Uint8Array(N) };
}

/** Preset description: fills boundary-condition fields at resolution n over the 2x domain. */
function presetFields(P, n, noise) {
  const f = makeFields(n);
  const D = P.size * 2;
  const dx = D / (n - 1);
  const { nA, nB, nC, nD } = noise;
  const relief = P.relief;
  const meta = {};
  for (let j = 0; j < n; j++) {
    const z = -D / 2 + j * dx;
    for (let i = 0; i < n; i++) {
      const x = -D / 2 + i * dx;
      const c = j * n + i;
      const hard = nB.fbm(x / 900, z / 900, 3) * 0.5 + 0.5; // rock resistance 0..1
      const strata = nC.fbm(x / 260, z / 260, 2) * 0.5 + 0.5;
      const rough = nA.fbm(x / 420, z / 420, 4);
      const white = hashFloat(i * 7 + n, j * 13 + n, P.seed);
      if (P.preset === 'alpine') {
        const axis = axisX(P, nD, z);
        const dAxis = Math.abs(x - axis);
        const trough = smoothstep(0, 900, dAxis);
        f.h[c] = 20 + rough * 30 + trough * 160 + (D / 2 - z) * 0.004 + white * 6;
        f.uplift[c] = (0.4 + 0.6 * smoothstep(0, 520, dAxis)) * (0.75 + 0.5 * hard) * relief * 1.35;
        f.K[c] = 0.021 * (1.45 - 0.9 * hard) * (0.7 + 0.6 * white);
        f.crit[c] = 0.5 + 0.8 * Math.pow(strata, 3.0) + 0.22 * hard;
        if (j === n - 1 && Math.abs(x - axisX(P, nD, D / 2)) < D * 0.012) {
          f.outlet[c] = 1;
          f.h[c] = 0;
        }
      } else if (P.preset === 'coast') {
        const land = landness(P, noise, x, z); // metres inland (+) / offshore (-), approximate
        const head = headland(P, noise, z); // 0 bay .. 1 headland
        if (land <= 0) {
          f.outlet[c] = 1;
          f.h[c] = seabed(land, head, nA, x, z);
        } else {
          f.h[c] = 1 + rough * 6 + land * 0.01 + white * 3;
          const ramp = smoothstep(0, lerp(520, 90, head), land);
          f.uplift[c] = (0.05 + 0.55 * ramp * (0.6 + 0.6 * hard) + 0.35 * head * smoothstep(0, 60, land) * smoothstep(900, 200, land)) * relief;
          f.K[c] = 0.05 * (1.5 - 0.9 * hard) * (1.25 - 0.7 * head) * (0.7 + 0.6 * white);
          const cliffy = head * smoothstep(260, 20, land);
          f.crit[c] = 0.42 + 0.4 * Math.pow(strata, 2) + 2.6 * cliffy;
        }
      } else {
        // lake / hills: gentle forested hills with a higher massif on the north side
        const massif = P.preset === 'lake' ? smoothstep(P.size * 0.2, P.size * 0.95, -z + nA.fbm(x / 1500, 3.1, 2) * 500) : 0.25 * (hard - 0.3);
        const ax = axisX(P, nD, z) * 0.8;
        const dAxis = Math.abs(x - ax);
        const trough = smoothstep(0, 420, dAxis);
        f.h[c] = 10 + rough * 20 + trough * 60 + (D / 2 - z) * 0.003 + white * 4;
        f.uplift[c] = (0.16 + 0.2 * trough * (0.5 + hard) + 1.5 * Math.max(0, massif)) * relief;
        f.K[c] = 0.03 * (1.4 - 0.8 * hard) * (0.7 + 0.6 * white);
        f.crit[c] = 0.32 + 0.22 * strata + 0.7 * Math.max(0, massif) * (0.5 + 0.5 * strata);
        if (j === n - 1 && Math.abs(x - axisX(P, nD, D / 2) * 0.8) < D * 0.015) {
          f.outlet[c] = 1;
          f.h[c] = 0;
        }
      }
    }
  }
  return { f, dx, meta };
}

function axisX(P, nD, z) {
  return P.size * 0.2 * nD.fbm(z / (P.size * 0.85) + 3.7, 0.5, 2) + P.size * 0.03 * nD.noise(z / 330, 9.1);
}
function headland(P, noise, z) {
  const v = noise.nD.fbm(z / (P.size * 0.36) + 11.3, 2.2, 2);
  return smoothstep(0.0, 0.26, v);
}
function coastX(P, noise, z) {
  const v = noise.nD.fbm(z / (P.size * 0.36) + 11.3, 2.2, 2);
  return -P.size * 0.04 - v * P.size * 0.3 + noise.nA.fbm(z / 240, 5.5, 3) * 38;
}
function landness(P, noise, x, z) {
  // sea lies to the west (-x). Warp so the coastline is not a function graph everywhere.
  const wx = noise.nC.fbm(x / 500, z / 500, 3) * 60;
  return x - coastX(P, noise, z + wx) + noise.nB.fbm(x / 130, z / 130, 3) * 16;
}
function seabed(land, head, nA, x, z) {
  const d = -land;
  // shoreface: gentle off beaches, steep off headlands
  let depth = (d < 260 ? d * 0.027 : 7.0 + (d - 260) * 0.016) + head * 8 * smoothstep(0, 50, d) * Math.exp(-d / 350);
  depth = Math.min(depth, 46) + nA.fbm(x / 160, z / 160, 3) * Math.min(depth * 0.35, 2.5);
  return -Math.max(0.02, depth);
}

/**
 * @param {object} params see defaultTerrainParams
 * @param {(phase:string, frac:number)=>boolean|void} [onProgress] return false to cancel
 * @returns {{heights:Float32Array, ring:{res:number,size:number,data:Float32Array}, sediment:Float32Array, suggested:object}|null}
 */
export function generateTerrain(params, onProgress) {
  const P = { ...defaultTerrainParams(params.preset, params.seed), ...params };
  const seed = P.seed >>> 0;
  const noise = {
    nA: new Noise2D(hash32(seed, 1)),
    nB: new Noise2D(hash32(seed, 2)),
    nC: new Noise2D(hash32(seed, 3)),
    nD: new Noise2D(hash32(seed, 4)),
    nE: new Noise2D(hash32(seed, 5)),
  };
  const D = P.size * 2;
  const prog = (phase, f) => (onProgress ? onProgress(phase, f) !== false : true);

  // ---- multigrid landscape evolution ----
  const levels = [];
  for (let n = 129; n <= P.coarseRes; n = (n - 1) * 2 + 1) levels.push(n);
  const itersFor = (n) => (n <= 129 ? 70 : n <= 257 ? 44 : n <= 513 ? 24 : 9);
  const totalWork = levels.reduce((s, n) => s + itersFor(n) * n * n, 0);
  let doneWork = 0;
  let h = null;
  let last = null;
  let lastN = 0;
  let lastDx = 0;
  for (const n of levels) {
    const { f, dx } = presetFields(P, n, noise);
    if (h) {
      const up = upsampleBicubic(h, lastN, n);
      for (let i = 0; i < n * n; i++) if (!f.outlet[i]) f.h[i] = up[i];
    }
    const iters = itersFor(n);
    const dt = P.preset === 'alpine' ? 13 : P.preset === 'coast' ? 9 : 10;
    let ok = true;
    last = evolveLandscape({
      h: f.h,
      n,
      dx,
      outlet: f.outlet,
      uplift: f.uplift,
      K: f.K,
      crit: f.crit,
      iters,
      dt,
      m: 0.45,
      diffusion: P.preset === 'alpine' ? 0.02 : 0.08,
      onProgress: (i) => {
        ok = prog('Landscape evolution', (doneWork + i * n * n) / totalWork * 0.55);
        return ok;
      },
    });
    if (!ok) return null;
    doneWork += iters * n * n;
    h = f.h;
    last.outlet = f.outlet;
    lastN = n;
    lastDx = dx;
  }
  const n = lastN;
  const dx = lastDx;
  const N = n * n;
  const sedC = new Float32Array(N);

  // ---- domain warp: removes the 8-direction bias of grid flow routing. All analytic preset
  // functions used below are evaluated at the warped coordinate so they stay registered. ----
  const warpX = new Float32Array(N);
  const warpZ = new Float32Array(N);
  {
    const src = new Float32Array(h);
    const srcA = new Float32Array(last.area);
    const wa = P.size * 0.03;
    for (let j = 0; j < n; j++) {
      const z = -D / 2 + j * dx;
      for (let i = 0; i < n; i++) {
        const x = -D / 2 + i * dx;
        const edge = smoothstep(0, 0.08, Math.min(i, j, n - 1 - i, n - 1 - j) / n);
        const ox = (noise.nE.fbm(x / (P.size * 0.23) + 9.2, z / (P.size * 0.23), 2) * wa + noise.nD.fbm(x / 170, z / 170 + 4.4, 2) * 26) * edge;
        const oz = (noise.nE.fbm(x / (P.size * 0.23) - 3.1, z / (P.size * 0.23) + 7.7, 2) * wa + noise.nD.fbm(x / 170 + 8.8, z / 170, 2) * 26) * edge;
        const c = j * n + i;
        warpX[c] = ox;
        warpZ[c] = oz;
        h[c] = sampleGrid(src, n, i + ox / dx, j + oz / dx);
        last.area[c] = sampleGrid(srcA, n, i + ox / dx, j + oz / dx);
      }
    }
  }

  // ---- alluvial valley floors: streams with large drainage area build floodplains ----
  {
    const pf0 = priorityFlood(h, n, new Uint8Array(N).fill(0).map((_, i) => (last.outlet[i] ? 1 : 0)), 1e-3 * dx);
    let count = pf0.count;
    let order = pf0.order;
    if (count < N * 0.5) {
      // outlets moved by the warp: fall back to the lowest border cell as base level
      const o2 = new Uint8Array(N);
      let lo = 0;
      for (let i = 0; i < n; i++) for (const c of [i, (n - 1) * n + i, i * n, i * n + n - 1]) if (h[c] < h[lo]) lo = c;
      o2[lo] = 1;
      last.outlet = o2;
      const pf1 = priorityFlood(h, n, o2, 1e-3 * dx);
      count = pf1.count;
      order = pf1.order;
    }
    const rr0 = computeReceivers(priorityFlood(h, n, last.outlet, 1e-3 * dx).filled, n, last.outlet, null, null, dx);
    const area = accumulateArea(order, count, rr0.recv, n, dx);
    last.area = area;
    last.recv = rr0.recv;
    const aThr = P.preset === 'alpine' ? 2.5e5 : 1.2e5;
    const cW = P.preset === 'alpine' ? 0.19 : 0.13;
    for (let j = 0; j < count; j++) {
      const c = order[j];
      const a = area[c];
      if (a < aThr || last.outlet[c]) continue;
      const w = Math.min(cW * Math.pow(a, 0.4), 190);
      const r = Math.ceil(w / dx);
      const cx = c % n;
      const cz = (c / n) | 0;
      const hs = h[c];
      for (let dz = -r; dz <= r; dz++) {
        const z = cz + dz;
        if (z < 0 || z >= n) continue;
        for (let ddx = -r; ddx <= r; ddx++) {
          const x = cx + ddx;
          if (x < 0 || x >= n) continue;
          const d = Math.hypot(ddx, dz) * dx;
          if (d > w) continue;
          const t = d / w;
          const tgt = hs + 0.018 * d + t * t * t * t * w * 0.5;
          const i = z * n + x;
          if (h[i] > tgt) {
            sedC[i] = Math.max(sedC[i], (1 - t * t) * Math.min(1, (h[i] - tgt) * 0.5 + 0.3));
            h[i] = tgt;
          }
        }
      }
    }
  }
  if (!prog('Macro landforms', 0.57)) return null;

  const suggested = { rivers: [], lakes: [], seaLevel: null };
  const wx = (i) => -D / 2 + i * dx;
  const win = { x0: Math.round((n - 1) / 4), z0: Math.round((n - 1) / 4), x1: Math.round(((n - 1) * 3) / 4), z1: Math.round(((n - 1) * 3) / 4) };
  let trunk = traceTrunkStream(last.area, last.recv, n, win, 1e5);
  const warp = { x: warpX, z: warpZ };

  // ---- preset macro features ----
  if (P.preset === 'lake' && trunk.length > 20) {
    // Moraine dam across the trunk valley: the lake is a drowned valley with natural bays.
    const k = Math.floor(trunk.length * 0.7);
    const [dxg, dzg] = trunk[k];
    const [px, pz] = trunk[Math.max(0, k - 6)];
    let tx = dxg - px,
      tz = dzg - pz;
    const tl = Math.hypot(tx, tz) || 1;
    tx /= tl;
    tz /= tl;
    const crest = h[dzg * n + dxg] + 17;
    const half = 70; // along-valley half thickness (m)
    const reach = Math.ceil(520 / dx);
    for (let dz = -reach; dz <= reach; dz++) {
      for (let ddx = -reach; ddx <= reach; ddx++) {
        const x = dxg + ddx,
          z = dzg + dz;
        if (x < 0 || z < 0 || x >= n || z >= n) continue;
        const along = (ddx * tx + dz * tz) * dx;
        const across = (-ddx * tz + dz * tx) * dx;
        const hum = noise.nE.fbm(wx(x) / 60, wx(z) / 60, 3) * 2.2;
        const prof = Math.exp(-(along * along) / (2 * half * half)) * smoothstep(520, 300, Math.abs(across));
        const tgt = crest + hum - (1 - prof) * 40;
        const i = z * n + x;
        if (prof > 0.02 && h[i] < tgt) {
          h[i] = lerp(h[i], tgt, smoothstep(0.02, 0.5, prof));
          sedC[i] = Math.max(sedC[i], 0.6 * prof);
        }
      }
    }
    const level = crest - 3.2;
    // littoral shelf: flatten slopes within a band around the future lake level
    for (let i = 0; i < N; i++) {
      const dz = h[i] - level;
      if (dz > -7 && dz < 3.5) {
        const s = dz < 0 ? -Math.pow(-dz / 7, 1.55) * 7 : Math.pow(dz / 3.5, 1.35) * 3.5;
        h[i] = level + s;
      }
    }
    const mid = trunk[Math.floor(trunk.length * 0.45)];
    suggested.lakes.push({ x: wx(mid[0]), z: wx(mid[1]), level: level + P.baseAltitude });
    suggested.dam = { x: wx(dxg), z: wx(dzg) };
  }
  if (P.preset === 'coast') {
    suggested.seaLevel = 0;
    for (let j = 0; j < n; j++) {
      for (let i = 0; i < n; i++) {
        const c = j * n + i;
        const x = wx(i) + warpX[c];
        const z = wx(j) + warpZ[c];
        const head = headland(P, noise, z);
        const land = landness(P, noise, x, z);
        if (land > 0 && land < 240) {
          // beaches in bays: foreshore ~4 degrees up to a berm, then a gentle backshore
          const beach = (1 - head) * smoothstep(240, 120, land);
          if (beach > 0.01) {
            const prof = land < 34 ? land * 0.068 : 2.3 + (land - 34) * 0.03 + noise.nE.fbm(x / 40, z / 40, 2) * 0.5 * smoothstep(34, 80, land);
            // cut dunes down to the profile; near the waterline also build the beach face up to it
            // (a berm), so low coastal flats do not turn into endless tidal flats
            if (h[c] > prof || land < 46) {
              const k = h[c] > prof ? beach : beach * smoothstep(46, 26, land);
              h[c] = lerp(h[c], prof, k);
              sedC[c] = Math.max(sedC[c], beach);
            }
          }
        }
        if (land <= 0 && land > -260) {
          // skerries, reefs and sea stacks off the headlands
          const s = noise.nE.fbm(x / 70 + 40, z / 70, 4) * 0.5 + 0.5;
          const t = noise.nB.noise(x / 23, z / 23) * 0.5 + 0.5;
          const amt = head * smoothstep(-260, -30, land) * smoothstep(0.56, 0.74, s);
          if (amt > 0) {
            const peak = -3 + amt * (9 + 16 * t) + noise.nA.fbm(x / 9, z / 9, 2) * 1.2;
            if (peak > h[c]) h[c] = peak;
          }
        }
      }
    }
  }
  if (P.preset === 'alpine' || P.preset === 'hills') {
    // nothing extra: the trunk valley and its tributaries come from the evolution model.
  }

  // re-route after macro edits for moisture/river suggestions
  {
    const pf = priorityFlood(h, n, last.outlet, 1e-3 * dx);
    const rr = computeReceivers(pf.filled, n, last.outlet, null, null, dx);
    const area = accumulateArea(pf.order, pf.count, rr.recv, n, dx);
    trunk = traceTrunkStream(area, rr.recv, n, win, 1e5);
    last.area = area;
  }
  if (trunk.length > 8) {
    const pts = [];
    const step = Math.max(2, Math.round(70 / dx));
    for (let k = 0; k < trunk.length; k += step) pts.push({ x: wx(trunk[k][0]), z: wx(trunk[k][1]), area: trunk[k][2] });
    const lastPt = trunk[trunk.length - 1];
    if (pts[pts.length - 1].x !== wx(lastPt[0])) pts.push({ x: wx(lastPt[0]), z: wx(lastPt[1]), area: lastPt[2] });
    suggested.rivers.push(pts);
  }

  // datum
  for (let i = 0; i < N; i++) h[i] += P.baseAltitude;
  if (suggested.seaLevel !== null) suggested.seaLevel += P.baseAltitude;
  if (!prog('Refining', 0.6)) return null;

  // ---- crop the editable window and upsample ----
  const res = P.res;
  const cn = win.x1 - win.x0 + 1;
  const crop = new Float32Array(cn * cn);
  const cropSed = new Float32Array(cn * cn);
  const cropArea = new Float32Array(cn * cn);
  for (let j = 0; j < cn; j++) {
    for (let i = 0; i < cn; i++) {
      const s = (win.z0 + j) * n + win.x0 + i;
      crop[j * cn + i] = h[s];
      cropSed[j * cn + i] = sedC[s];
      cropArea[j * cn + i] = Math.log10(Math.max(1, last.area[s]));
    }
  }
  const heights = upsampleBicubic(crop, cn, res);
  const smooth0 = new Float32Array(heights); // pre-detail surface, used to blend back at the borders
  const sediment = new Float32Array(res * res);
  const cell = P.size / (res - 1);
  const sc = (cn - 1) / (res - 1);
  const detail = P.detail;
  for (let j = 0; j < res; j++) {
    const z = -P.size / 2 + j * cell;
    for (let i = 0; i < res; i++) {
      const x = -P.size / 2 + i * cell;
      const c = j * res + i;
      const sed = sampleGrid(cropSed, cn, i * sc, j * sc);
      sediment[c] = sed;
      // slope of the macro surface drives roughness: bedrock slopes are craggy, alluvium is smooth
      const gx = (heights[c + (i < res - 1 ? 1 : 0)] - heights[c - (i > 0 ? 1 : 0)]) / (2 * cell);
      const gz = (heights[c + (j < res - 1 ? res : 0)] - heights[c - (j > 0 ? res : 0)]) / (2 * cell);
      const sl = Math.hypot(gx, gz);
      const rock = smoothstep(0.35, 1.0, sl);
      const soft = 1 - 0.85 * smoothstep(0.05, 0.6, sed);
      let dsum = 0;
      dsum += noise.nA.erodedFbm(x / 95, z / 95, 5, 2.07, 0.5, 0.8) * (1.6 + 7.0 * rock);
      dsum += noise.nB.ridged(x / 31, z / 31, 3, 2.1, 0.5) * (0.25 + 2.8 * rock) - (0.12 + 1.4 * rock);
      dsum += noise.nC.fbm(x / 6.5, z / 6.5, 3) * (0.07 + 0.22 * rock);
      heights[c] += dsum * detail * soft;
    }
    if ((j & 127) === 0 && !prog('Refining', 0.6 + 0.1 * (j / res))) return null;
  }
  if (P.preset === 'coast') {
    // keep the beach face and nearshore bed smooth (sand), noise was already damped by sediment
    for (let i = 0; i < res * res; i++) if (sediment[i] > 0.5 && heights[i] < P.baseAltitude + 3) heights[i] = lerp(heights[i], smooth0[i], 0.8);
  }

  // ---- fine-scale erosion ----
  const talusMap = new Float32Array(res * res);
  for (let j = 0; j < res; j++) {
    const z = -P.size / 2 + j * cell;
    for (let i = 0; i < res; i++) {
      const x = -P.size / 2 + i * cell;
      const strata = noise.nC.fbm(x / 260, z / 260, 2) * 0.5 + 0.5;
      const hard = noise.nB.fbm(x / 900, z / 900, 3) * 0.5 + 0.5;
      let t = 0.72 + 0.9 * Math.pow(strata, 2.5) + 0.3 * hard;
      if (P.preset === 'coast') {
        const head = headland(P, noise, z);
        const land = landness(P, noise, x, z);
        t += 2.6 * head * smoothstep(300, 20, Math.abs(land));
      } else if (P.preset !== 'alpine') t *= 0.85;
      talusMap[j * res + i] = t;
    }
  }
  const total = Math.round(P.erosionDroplets * res * res);
  const batch = 60000;
  const sedEro = new Float32Array(res * res);
  for (let s = 0; s < total; s += batch) {
    hydraulicErosion(heights, res, cell, {
      seed: hash32(seed, 77),
      start: s,
      count: Math.min(batch, total - s),
      sediment: sedEro,
      radius: 3,
      erodeRate: 0.28,
      depositRate: 0.3,
      capacity: 4.5,
      edgeFade: 40,
      strength: P.preset === 'alpine' ? 1.0 : 0.6,
    });
    if (!prog('Hydraulic erosion', 0.7 + 0.22 * (s / total))) return null;
  }
  for (let it = 0; it < P.thermalIterations; it += 4) {
    thermalErosion(heights, res, cell, { iterCount: Math.min(4, P.thermalIterations - it), talusMap, rate: 0.35, sediment: sedEro });
    if (!prog('Thermal erosion', 0.92 + 0.06 * (it / P.thermalIterations))) return null;
  }
  if (P.preset === 'lake' && suggested.lakes.length) {
    // Lake margin: waves and ice rework the shore, so the ground within a couple of metres of the
    // lake level is an even, gently sloping bank / shelf rather than hummocky, rilled hillside.
    const L = suggested.lakes[0].level;
    const tmpL = new Float32Array(res * res);
    const RL = Math.max(2, Math.round(7 / cell));
    for (let pass = 0; pass < 3; pass++) {
      for (let j = 0; j < res; j++) {
        let acc = 0;
        const row = j * res;
        for (let i = -RL; i < res; i++) {
          if (i + RL < res) acc += heights[row + i + RL];
          if (i - RL - 1 >= 0) acc -= heights[row + i - RL - 1];
          if (i >= 0) tmpL[row + i] = acc / (Math.min(res - 1, i + RL) - Math.max(0, i - RL) + 1);
        }
      }
      for (let i = 0; i < res; i++) {
        let acc = 0;
        for (let j = -RL; j < res; j++) {
          if (j + RL < res) acc += tmpL[(j + RL) * res + i];
          if (j - RL - 1 >= 0) acc -= tmpL[(j - RL - 1) * res + i];
          if (j >= 0) {
            const c = j * res + i;
            const a = heights[c] - L;
            const m = smoothstep(-5.5, -2.0, a) * smoothstep(7.5, 2.5, a);
            if (m > 0) heights[c] += (acc / (Math.min(res - 1, j + RL) - Math.max(0, j - RL) + 1) - heights[c]) * m * 0.9;
          }
        }
      }
    }
  }
  if (P.preset === 'coast') {
    // Swash-zone finish: waves rework the beach face continuously, so sand between the low-water
    // step and the berm is smooth at the scale of metres (the droplet pass leaves cell-sized rills
    // that would show as islands in the thin swash sheet). A faint long-shore undulation (beach
    // cusps) remains.
    const base = P.baseAltitude;
    const mask = new Float32Array(res * res);
    for (let i = 0; i < res * res; i++) {
      const a = heights[i] - base;
      mask[i] = smoothstep(0.3, 0.6, sediment[i]) * smoothstep(-3.2, -1.6, a) * smoothstep(3.6, 2.2, a);
    }
    const tmp = new Float32Array(res * res);
    const R = Math.max(2, Math.round(4 / cell));
    for (let pass = 0; pass < 3; pass++) {
      // separable box blur (running sums)
      for (let j = 0; j < res; j++) {
        let acc = 0;
        const row = j * res;
        for (let i = -R; i < res; i++) {
          if (i + R < res) acc += heights[row + i + R];
          if (i - R - 1 >= 0) acc -= heights[row + i - R - 1];
          if (i >= 0) tmp[row + i] = acc / (Math.min(res - 1, i + R) - Math.max(0, i - R) + 1);
        }
      }
      for (let i = 0; i < res; i++) {
        let acc = 0;
        for (let j = -R; j < res; j++) {
          if (j + R < res) acc += tmp[(j + R) * res + i];
          if (j - R - 1 >= 0) acc -= tmp[(j - R - 1) * res + i];
          if (j >= 0) {
            const c = j * res + i;
            const m = mask[c];
            if (m > 0) heights[c] += (acc / (Math.min(res - 1, j + R) - Math.max(0, j - R) + 1) - heights[c]) * m;
          }
        }
      }
    }
    for (let j = 0; j < res; j++) {
      const z = -P.size / 2 + j * cell;
      for (let i = 0; i < res; i++) {
        const c = j * res + i;
        if (mask[c] > 0) heights[c] += noise.nC.fbm((-P.size / 2 + i * cell) / 26, z / 26, 2) * 0.07 * mask[c];
      }
    }
  }
  // blend detail/erosion out at the border so the surrounding ring meets the editable terrain exactly
  const fadeCells = 28;
  for (let j = 0; j < res; j++) {
    for (let i = 0; i < res; i++) {
      const e = Math.min(i, j, res - 1 - i, res - 1 - j);
      const c = j * res + i;
      if (e < fadeCells) {
        const t = smoothstep(0, fadeCells, e);
        heights[c] = lerp(smooth0[c], heights[c], t);
      }
      const s = sedEro[c];
      if (s > 0.02) sediment[c] = Math.max(sediment[c], Math.min(1, s * 1.4));
    }
  }
  prog('Done', 1);
  return {
    heights,
    sediment,
    ring: { res: n, size: D, data: h },
    drainage: { res: cn, data: cropArea },
    suggested,
    params: P,
  };
}
