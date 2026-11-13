// Water field: a single-valued water-surface elevation over the terrain grid plus the quantities
// the renderer and the scatter rules need (type, depth-averaged velocity, steady-state foam,
// signed shore distance, wind exposure, swell phase/height).
//
// Physical approximations (documented in docs/ARCHITECTURE.md):
//  * Ocean: still-water level flood-filled from the map border (inland hollows stay dry).
//  * Lakes: still-water level flood-filled from the lake seed point.
//  * Rivers: 1-D gradually varied surface profile from the carved channel (Manning normal depth),
//    2-D depth-averaged steady flow from a stream-function solve  div((1/d) grad psi) = 0  with
//    psi = 0 / Q on the banks, so velocity = curl(psi)/d satisfies continuity exactly: it speeds
//    up through constrictions and shallows, slows in pools and splits around emergent rocks.
//  * Foam: steady advection-decay of a source driven by Froude number, shear and surface drops.
//  * Swell: eikonal (ray-theory) phase with depth-dependent wavenumber from the linear dispersion
//    relation, shoaling by conservation of energy flux and depth-limited breaking (H <= 0.78 d).

import { crossTrack } from './paths.js';
import { smoothstep, clamp } from './noise.js';

export const NO_WATER = -1e5;
export const WATER_DRY = 0,
  WATER_RIVER = 1,
  WATER_LAKE = 2,
  WATER_OCEAN = 3;
const G = 9.81;

export class WaterField {
  constructor(res, size) {
    this.res = res;
    this.size = size;
    this.cell = size / (res - 1);
    const N = res * res;
    this.surf = new Float32Array(N).fill(NO_WATER); // extended water surface elevation
    this.type = new Uint8Array(N); // wet-cell classification (0 for dry cells, even if surf is extended)
    this.vx = new Float32Array(N);
    this.vz = new Float32Array(N);
    this.foam = new Float32Array(N);
    // Flow-induced surface relief (m), added to `surf` for display and floating bodies only: it
    // depends on the boulders, so nothing that decides where boulders go may depend on it.
    this.relief = new Float32Array(N);
    this.shore = new Float32Array(N); // signed distance to the waterline (m), + inside water
    this.exposure = new Uint8Array(N); // 0..255 wind exposure (fetch-limited)
    this.typeExt = new Uint8Array(N); // type of the nearest water body, extended into the dry margin
    this.sres = ((res - 1) >> 1) + 1; // swell grid (half resolution)
    this.swellPhase = new Float32Array(this.sres * this.sres);
    this.swellH = new Float32Array(this.sres * this.sres); // local swell height factor (x offshore height)
    this.swellBreak = new Float32Array(this.sres * this.sres); // 0..1 breaking intensity
    this.stats = {};
  }

  depthAt(hFinal, x, z) {
    const s = sampleNearestValid(this, hFinal, x, z);
    return s <= NO_WATER * 0.5 ? -1 : s - hFinal.sample(x, z);
  }

  /** Water surface elevation at world position, or NO_WATER. */
  surfaceAt(hFinal, x, z) {
    return sampleNearestValid(this, hFinal, x, z);
  }

  velocityAt(x, z, out = [0, 0]) {
    const gx = clamp((x + this.size / 2) / this.cell, 0, this.res - 1.001);
    const gz = clamp((z + this.size / 2) / this.cell, 0, this.res - 1.001);
    const ix = gx | 0,
      iz = gz | 0;
    const fx = gx - ix,
      fz = gz - iz;
    const i = iz * this.res + ix;
    const r = this.res;
    const b = (a) => a[i] * (1 - fx) * (1 - fz) + a[i + 1] * fx * (1 - fz) + a[i + r] * (1 - fx) * fz + a[i + r + 1] * fx * fz;
    out[0] = b(this.vx);
    out[1] = b(this.vz);
    return out;
  }
}

function sampleNearestValid(wf, hFinal, x, z) {
  const res = wf.res;
  const gx = clamp((x + wf.size / 2) / wf.cell, 0, res - 1.001);
  const gz = clamp((z + wf.size / 2) / wf.cell, 0, res - 1.001);
  const ix = gx | 0,
    iz = gz | 0;
  const fx = gx - ix,
    fz = gz - iz;
  const i = iz * res + ix;
  const s = wf.surf;
  const a = s[i],
    b = s[i + 1],
    c = s[i + res],
    d = s[i + res + 1];
  const lim = NO_WATER * 0.5;
  if (a > lim && b > lim && c > lim && d > lim) return a * (1 - fx) * (1 - fz) + b * fx * (1 - fz) + c * (1 - fx) * fz + d * fx * fz;
  let best = NO_WATER;
  if (a > best) best = a;
  if (b > best) best = b;
  if (c > best) best = c;
  if (d > best) best = d;
  return best;
}

function floodFill(hData, res, level, seeds, type, surf, tval, queue) {
  let qh = 0,
    qt = 0;
  for (const s of seeds) {
    if (hData[s] < level && type[s] !== tval) {
      type[s] = tval;
      surf[s] = level;
      queue[qt++] = s;
    }
  }
  while (qh < qt) {
    const c = queue[qh++];
    const cx = c % res;
    const cz = (c / res) | 0;
    if (cx > 0) {
      const i = c - 1;
      if (type[i] !== tval && hData[i] < level) {
        type[i] = tval;
        surf[i] = Math.max(surf[i], level);
        queue[qt++] = i;
      }
    }
    if (cx < res - 1) {
      const i = c + 1;
      if (type[i] !== tval && hData[i] < level) {
        type[i] = tval;
        surf[i] = Math.max(surf[i], level);
        queue[qt++] = i;
      }
    }
    if (cz > 0) {
      const i = c - res;
      if (type[i] !== tval && hData[i] < level) {
        type[i] = tval;
        surf[i] = Math.max(surf[i], level);
        queue[qt++] = i;
      }
    }
    if (cz < res - 1) {
      const i = c + res;
      if (type[i] !== tval && hData[i] < level) {
        type[i] = tval;
        surf[i] = Math.max(surf[i], level);
        queue[qt++] = i;
      }
    }
  }
  return qt;
}

/**
 * Recompute the whole water field.
 * @param {WaterField} wf
 * @param {import('./heightfield.js').Heightfield} hFinal
 * @param {object} water  project.water  {sea:{enabled,level,...}, lakes:[{x,z,level}], wind:{dir,speed}}
 * @param {Array} rivers  compiled rivers (see carve.compileRiver)
 * @param {object} [extra] {obstacles:[{x,z,r,top}]}  rocks that block flow
 */
export function computeWaterField(wf, hFinal, water, rivers, extra = {}) {
  const res = wf.res;
  const N = res * res;
  const h = hFinal.data;
  const cell = wf.cell;
  wf.surf.fill(NO_WATER);
  wf.type.fill(0);
  wf.vx.fill(0);
  wf.vz.fill(0);
  wf.foam.fill(0);
  wf.relief.fill(0);
  const queue = new Int32Array(N);
  const stats = { oceanCells: 0, lakeCells: [], riverCells: 0 };

  // ---- ocean ----
  const sea = water.sea;
  if (sea && sea.enabled) {
    const seeds = [];
    for (let i = 0; i < res; i++) seeds.push(i, (res - 1) * res + i, i * res, i * res + res - 1);
    stats.oceanCells = floodFill(h, res, sea.level, seeds, wf.type, wf.surf, WATER_OCEAN, queue);
  }
  // ---- lakes ----
  for (const lake of water.lakes || []) {
    const ix = Math.round(hFinal.toGridX(lake.x));
    const iz = Math.round(hFinal.toGridZ(lake.z));
    if (ix < 0 || iz < 0 || ix >= res || iz >= res) {
      stats.lakeCells.push(0);
      continue;
    }
    // temporarily use a unique marker so overlapping lakes at different levels each fill
    const n = floodFill(h, res, lake.level, [iz * res + ix], wf.type, wf.surf, 200, queue);
    for (let q = 0; q < n; q++) wf.type[queue[q]] = WATER_LAKE;
    stats.lakeCells.push(n);
  }
  // ---- rivers ----
  const obstacleDepth = extra.obstacles ? rasterObstacles(extra.obstacles, hFinal) : null;
  for (const c of rivers || []) {
    if (!c) continue;
    stats.riverCells += solveRiver(wf, hFinal, c, obstacleDepth);
  }
  // ---- extend the surface a few cells into dry land (smooth mesh edges, wet-bank shading) ----
  extendAndMeasure(wf, h);
  computeExposure(wf, water.wind || { dir: 0, speed: 4 });
  if (sea && sea.enabled) computeSwell(wf, hFinal, sea, water.swell || {});
  else {
    wf.swellH.fill(0);
    wf.swellBreak.fill(0);
  }
  wf.stats = stats;
  return stats;
}

function rasterObstacles(obstacles, hf) {
  // returns a sparse Map: cell index -> obstacle top elevation
  const map = new Map();
  const res = hf.res;
  for (const o of obstacles) {
    const r = Math.max(o.r, hf.cell * 0.55);
    const rc = hf.rectFromWorld(o.x - r, o.z - r, o.x + r, o.z + r);
    for (let iz = rc.z0; iz <= rc.z1; iz++) {
      for (let ix = rc.x0; ix <= rc.x1; ix++) {
        const dx = hf.toWorldX(ix) - o.x,
          dz = hf.toWorldZ(iz) - o.z;
        if (dx * dx + dz * dz <= r * r) {
          const i = iz * res + ix;
          const prev = map.get(i);
          if (prev === undefined || o.top > prev) map.set(i, o.top);
        }
      }
    }
  }
  return map;
}

function solveRiver(wf, hFinal, c, obstacleTop) {
  const { sp, raster, surf, hw, R } = c;
  const { rect, w, idx } = raster;
  const hh = rect.z1 - rect.z0 + 1;
  if (w <= 0 || hh <= 0) return 0;
  const res = wf.res;
  const cell = wf.cell;
  const h = hFinal.data;
  const Q = Math.max(0.05, R.flow);
  const n = w * hh;
  // local arrays over the raster rect
  const d = new Float32Array(n); // flow depth (m); 0 = bank (Dirichlet)
  const psi = new Float32Array(n);
  const fixed = new Uint8Array(n);
  const inDom = new Uint8Array(n);
  const EPS = 0.03;
  let wet = 0;
  for (let j = 0; j < hh; j++) {
    const iz = rect.z0 + j;
    const z = hFinal.toWorldZ(iz);
    for (let i = 0; i < w; i++) {
      const o = j * w + i;
      const k = idx[o];
      if (k < 0) continue;
      const ix = rect.x0 + i;
      const gi = iz * res + ix;
      const x = hFinal.toWorldX(ix);
      const r = crossTrack(sp, k, x, z);
      const half = hw[k];
      const au = Math.abs(r) / half;
      if (au > 1.6) continue;
      inDom[o] = 1;
      const ws = surf[k];
      // Obstacles (boulders) only influence the flow solve. Which cells are wet, the surface
      // elevation and the shoreline depend on the terrain alone, so ground materials and scatter
      // (which decide where the boulders are) do not depend on their own result.
      const bedz = h[gi];
      const depth = ws - bedz;
      let flowDepth = depth;
      if (obstacleTop) {
        const t = obstacleTop.get(gi);
        if (t !== undefined && t > bedz) flowDepth = ws - t;
      }
      const frac = clamp(0.5 - (0.5 * r) / half, 0, 1); // 0 on +n bank .. 1 on -n bank
      psi[o] = Q * frac;
      if (k <= 1 || k >= sp.n - 2) {
        fixed[o] = 1; // inflow / outflow sections: prescribed distribution
        d[o] = Math.max(EPS, flowDepth);
      } else if (depth <= 0.01) {
        if (au < 0.8) d[o] = EPS; // emergent bar inside the channel: flow must go around
        else {
          fixed[o] = 1;
          psi[o] = r > 0 ? 0 : Q;
          d[o] = EPS;
        }
      } else d[o] = Math.max(EPS, flowDepth); // an emergent boulder leaves only a thin film: flow goes around
      // a river may raise/define the water surface here
      const existing = wf.surf[gi];
      if (depth > 0.01 && au <= 1.3) {
        if (ws > existing + 0.02) {
          wf.surf[gi] = ws;
          wf.type[gi] = WATER_RIVER;
          wet++;
        } else if (existing > NO_WATER * 0.5) {
          // drowned reach inside a lake / the sea: flow spreads through the standing water depth
          d[o] = Math.max(d[o], existing - bedz);
        }
      } else if (existing <= NO_WATER * 0.5 && au <= 1.6 && h[gi] >= ws - 0.01) {
        wf.surf[gi] = Math.max(existing, ws); // extended (dry) surface for smooth waterlines
      }
    }
  }
  // cells of the rect outside the domain act as banks
  for (let o = 0; o < n; o++) {
    if (!inDom[o]) {
      fixed[o] = 1;
      const k = idx[o];
      if (k >= 0) {
        const ix = rect.x0 + (o % w),
          iz = rect.z0 + ((o / w) | 0);
        const r = crossTrack(sp, k, hFinal.toWorldX(ix), hFinal.toWorldZ(iz));
        psi[o] = r > 0 ? 0 : Q;
      }
      d[o] = EPS;
    }
  }
  // SOR on  sum_nb (psi_nb - psi) / d_face = 0
  const omega = 1.82;
  const sweeps = Math.min(900, 140 + Math.round(4 * Math.max(...sampleMax(hw, 64)) / cell) * 12);
  for (let it = 0; it < sweeps; it++) {
    let maxDelta = 0;
    for (let pass = 0; pass < 2; pass++) {
      for (let j = 1; j < hh - 1; j++) {
        for (let i = 1 + ((j + pass) & 1); i < w - 1; i += 2) {
          const o = j * w + i;
          if (fixed[o] || !inDom[o]) continue;
          const dc = d[o];
          const cE = 2 / (dc + d[o + 1]),
            cW = 2 / (dc + d[o - 1]),
            cS = 2 / (dc + d[o + w]),
            cN = 2 / (dc + d[o - w]);
          const tgt = (cE * psi[o + 1] + cW * psi[o - 1] + cS * psi[o + w] + cN * psi[o - w]) / (cE + cW + cS + cN);
          const dl = (tgt - psi[o]) * omega;
          psi[o] += dl;
          const a = dl < 0 ? -dl : dl;
          if (a > maxDelta) maxDelta = a;
        }
      }
    }
    if (maxDelta < Q * 2e-5) break;
  }
  // velocity = curl(psi) / depth ; orient downstream
  let dotSum = 0;
  const vxl = new Float32Array(n),
    vzl = new Float32Array(n);
  for (let j = 1; j < hh - 1; j++) {
    for (let i = 1; i < w - 1; i++) {
      const o = j * w + i;
      if (!inDom[o] || d[o] <= EPS * 1.01) continue;
      const k = idx[o];
      const dpx = (psi[o + 1] - psi[o - 1]) / (2 * cell);
      const dpz = (psi[o + w] - psi[o - w]) / (2 * cell);
      const dd = Math.max(d[o], 0.06);
      const vx = dpz / dd,
        vz = -dpx / dd;
      vxl[o] = vx;
      vzl[o] = vz;
      dotSum += vx * sp.tx[k] + vz * sp.tz[k];
    }
  }
  const sgn = dotSum < 0 ? -1 : 1;
  const VMAX = 6.5;
  for (let j = 1; j < hh - 1; j++) {
    for (let i = 1; i < w - 1; i++) {
      const o = j * w + i;
      if (!inDom[o]) continue;
      let vx = vxl[o] * sgn,
        vz = vzl[o] * sgn;
      let sp2 = Math.hypot(vx, vz);
      // a thin film (water over a nearly emergent stone, the very edge of the channel) cannot run
      // at many metres per second: limit the speed to a Froude number of about 2 for the local depth
      const vcap = Math.min(VMAX, 0.25 + 2.0 * Math.sqrt(G * Math.max(d[o], 0.01)));
      if (sp2 > vcap) {
        vx *= vcap / sp2;
        vz *= vcap / sp2;
        sp2 = vcap;
      }
      const gi = (rect.z0 + j) * res + rect.x0 + i;
      if (sp2 > Math.hypot(wf.vx[gi], wf.vz[gi])) {
        wf.vx[gi] = vx;
        wf.vz[gi] = vz;
      }
    }
  }
  // ---- surface relief from the flow (Bernoulli along the free surface): where the current stalls
  // (upstream face of a boulder, eddies) the surface stands higher by v^2 / 2g than where it races
  // past (chutes, constrictions), giving pillows and drawdowns tied to the solved flow ----
  {
    const W1 = w + 1;
    const sum = new Float64Array(W1 * (hh + 1));
    const cnt = new Float64Array(W1 * (hh + 1));
    const v2 = new Float32Array(n);
    for (let j = 0; j < hh; j++) {
      let rs = 0,
        rc = 0;
      for (let i = 0; i < w; i++) {
        const o = j * w + i;
        const gi = (rect.z0 + j) * res + rect.x0 + i;
        if (inDom[o] && wf.type[gi] === WATER_RIVER) {
          const vx = wf.vx[gi],
            vz = wf.vz[gi];
          v2[o] = vx * vx + vz * vz;
          rs += v2[o];
          rc++;
        }
        sum[(j + 1) * W1 + i + 1] = sum[j * W1 + i + 1] + rs;
        cnt[(j + 1) * W1 + i + 1] = cnt[j * W1 + i + 1] + rc;
      }
    }
    const rad = Math.max(2, Math.round(4.5 / cell));
    for (let j = 1; j < hh - 1; j++) {
      for (let i = 1; i < w - 1; i++) {
        const o = j * w + i;
        const gi = (rect.z0 + j) * res + rect.x0 + i;
        if (!inDom[o] || wf.type[gi] !== WATER_RIVER || wf.surf[gi] !== surf[idx[o]]) continue;
        const x0 = Math.max(0, i - rad),
          x1 = Math.min(w, i + rad + 1),
          z0 = Math.max(0, j - rad),
          z1 = Math.min(hh, j + rad + 1);
        const c0 = cnt[z1 * W1 + x1] - cnt[z0 * W1 + x1] - cnt[z1 * W1 + x0] + cnt[z0 * W1 + x0];
        if (c0 < 3) continue;
        const mean = (sum[z1 * W1 + x1] - sum[z0 * W1 + x1] - sum[z1 * W1 + x0] + sum[z0 * W1 + x0]) / c0;
        const depth = wf.surf[gi] - h[gi];
        const eta = clamp((mean - v2[o]) / (2 * G), -0.2, 0.28) * smoothstep(0.06, 0.4, depth);
        wf.relief[gi] = eta;
      }
    }
  }
  // ---- steady-state foam: source from Froude number, shear and surface drop; advect + decay ----
  const src = new Float32Array(n);
  for (let j = 2; j < hh - 2; j++) {
    for (let i = 2; i < w - 2; i++) {
      const o = j * w + i;
      if (!inDom[o] || d[o] <= EPS * 1.01) continue;
      const gi = (rect.z0 + j) * res + rect.x0 + i;
      const v = Math.hypot(wf.vx[gi], wf.vz[gi]);
      const fr = v / Math.sqrt(G * Math.max(0.12, d[o]));
      // banks: thin slow margins do not aerate; require some depth and distance from the bank cells
      let bankK = smoothstep(0.06, 0.22, d[o]);
      if (fixed[o - 1] || fixed[o + 1] || fixed[o - w] || fixed[o + w]) bankK *= 0.15;
      const k = idx[o];
      // speed gradient relative to speed (obstacle wakes, chutes)
      const vE = Math.hypot(wf.vx[gi + 1], wf.vz[gi + 1]),
        vW = Math.hypot(wf.vx[gi - 1], wf.vz[gi - 1]);
      const vS = Math.hypot(wf.vx[gi + res], wf.vz[gi + res]),
        vN = Math.hypot(wf.vx[gi - res], wf.vz[gi - res]);
      const shear = Math.hypot(vE - vW, vS - vN) / (2 * cell);
      // bed drop along the flow (steps, ledges)
      const kk = Math.min(sp.n - 1, k + 3);
      const drop = c.slope[k];
      let s = smoothstep(0.7, 1.25, fr) * 1.0 + smoothstep(0.5, 1.8, shear) * smoothstep(0.6, 1.6, v) * 0.6 + smoothstep(0.04, 0.12, drop) * smoothstep(0.8, 2.0, v) * 0.5;
      void kk;
      src[o] = Math.min(1.5, s) * bankK;
    }
  }
  const foam = new Float32Array(n);
  const foam2 = new Float32Array(n);
  const decay = 0.42; // 1/s
  let fa = foam,
    fb = foam2;
  for (let it = 0; it < 70; it++) {
    for (let j = 2; j < hh - 2; j++) {
      for (let i = 2; i < w - 2; i++) {
        const o = j * w + i;
        if (!inDom[o]) continue;
        const gi = (rect.z0 + j) * res + rect.x0 + i;
        const vx = wf.vx[gi],
          vz = wf.vz[gi];
        const v = Math.hypot(vx, vz);
        if (v < 0.03) {
          fb[o] = Math.min(1, src[o]);
          continue;
        }
        // upstream sample one cell back along the flow
        const ux = i - vx / v,
          uz = j - vz / v;
        const i0 = ux | 0,
          j0 = uz | 0;
        const fx = ux - i0,
          fz = uz - j0;
        const p = j0 * w + i0;
        const up = fa[p] * (1 - fx) * (1 - fz) + fa[p + 1] * fx * (1 - fz) + fa[p + w] * (1 - fx) * fz + fa[p + w + 1] * fx * fz;
        const dtTravel = cell / v;
        fb[o] = Math.min(1, up * Math.exp(-decay * dtTravel) + src[o] * Math.min(1, dtTravel * 1.6));
      }
    }
    const t = fa;
    fa = fb;
    fb = t;
  }
  for (let j = 0; j < hh; j++) {
    for (let i = 0; i < w; i++) {
      const o = j * w + i;
      if (!inDom[o]) continue;
      const gi = (rect.z0 + j) * res + rect.x0 + i;
      if (fa[o] > wf.foam[gi]) wf.foam[gi] = fa[o];
    }
  }
  return wet;
}

function sampleMax(arr, n) {
  const out = [];
  const step = Math.max(1, Math.floor(arr.length / n));
  for (let i = 0; i < arr.length; i += step) out.push(arr[i]);
  return out;
}

// ---- exact Euclidean distance transform (Felzenszwalb & Huttenlocher) with nearest-feature carry ----
// feature[i] != 0 marks sources. Returns {d2: squared distance in cells, nearest: index of nearest source}
function edt(feature, res, maxCells) {
  const N = res * res;
  const INF = 1e12;
  const g = new Float32Array(N); // squared vertical distance
  const nz = new Int32Array(N); // row of the nearest source in this column
  // columns
  for (let x = 0; x < res; x++) {
    let last = -1e9;
    for (let z = 0; z < res; z++) {
      const i = z * res + x;
      if (feature[i]) last = z;
      const d = z - last;
      g[i] = d > maxCells ? INF : d * d;
      nz[i] = last;
    }
    last = 1e9;
    for (let z = res - 1; z >= 0; z--) {
      const i = z * res + x;
      if (feature[i]) last = z;
      const d = last - z;
      if (d <= maxCells && d * d < g[i]) {
        g[i] = d * d;
        nz[i] = last;
      }
    }
  }
  // rows: lower envelope of parabolas
  const d2 = new Float32Array(N);
  const nearest = new Int32Array(N).fill(-1);
  const v = new Int32Array(res);
  const zq = new Float64Array(res + 1);
  for (let z = 0; z < res; z++) {
    const row = z * res;
    let k = -1;
    for (let q = 0; q < res; q++) {
      const fq = g[row + q];
      if (fq >= INF) continue;
      let sI;
      while (k >= 0) {
        const p = v[k];
        sI = (fq + q * q - (g[row + p] + p * p)) / (2 * q - 2 * p);
        if (sI <= zq[k]) k--;
        else break;
      }
      if (k < 0) {
        k = 0;
        v[0] = q;
        zq[0] = -INF;
        zq[1] = INF;
      } else {
        k++;
        v[k] = q;
        zq[k] = sI;
        zq[k + 1] = INF;
      }
    }
    if (k < 0) {
      for (let x = 0; x < res; x++) d2[row + x] = INF;
      continue;
    }
    let j = 0;
    for (let x = 0; x < res; x++) {
      while (zq[j + 1] < x) j++;
      const p = v[j];
      const dd = (x - p) * (x - p) + g[row + p];
      d2[row + x] = dd;
      nearest[row + x] = nz[row + p] * res + p;
    }
  }
  return { d2, nearest };
}

/**
 * Signed shore distance (exact Euclidean, + inside water) and extension of the water surface into
 * the dry margin (nearest wet cell's level), so the water mesh and the wet-bank shading have smooth
 * round limits instead of following the grid.
 */
function extendAndMeasure(wf, h) {
  const res = wf.res;
  const N = res * res;
  const cell = wf.cell;
  const CAP = 64;
  const capCells = Math.ceil(CAP / cell) + 1;
  const wet = wf.type;
  const dry = new Uint8Array(N);
  for (let i = 0; i < N; i++) dry[i] = wet[i] ? 0 : 1;
  const out = edt(wet, res, capCells); // for dry cells: distance to water
  const inn = edt(dry, res, capCells); // for wet cells: distance to land
  const surf = wf.surf;
  const ext = wf.typeExt;
  const lim = NO_WATER * 0.5;
  const rO = 28,
    rL = 7.5;
  for (let i = 0; i < N; i++) {
    if (wet[i]) {
      ext[i] = wet[i];
      wf.shore[i] = Math.min(CAP, Math.sqrt(inn.d2[i]) * cell - cell * 0.5);
      continue;
    }
    const d = Math.sqrt(out.d2[i]) * cell;
    wf.shore[i] = -Math.min(CAP, d - cell * 0.5);
    ext[i] = 0;
    const n = out.nearest[i];
    if (n < 0 || d > rO) continue;
    const t = wet[n];
    if (d > (t === WATER_OCEAN ? rO : rL)) continue;
    const s = surf[n];
    // Never extend a lake or river surface over ground that lies below it (an unconnected hollow).
    // On the open coast the margin is the swash zone: small hollows of the beach face next to the
    // sea are covered by the run-up, so the sea surface does extend over them.
    if (surf[i] <= lim) {
      if (t !== WATER_OCEAN && h[i] < s + 0.02) continue;
      surf[i] = s;
    }
    ext[i] = t;
  }
}

function computeExposure(wf, wind) {
  // fetch: distance to the upwind shore, marched on the grid; exposure ~ sqrt(fetch / refFetch)
  const res = wf.res;
  const N = res * res;
  const out = wf.exposure;
  const ang = wind.dir || 0;
  // wind.dir = direction the wind blows TOWARDS (radians, 0 = +x)
  const wx = Math.cos(ang),
    wz = Math.sin(ang);
  const fetch = new Float32Array(N);
  const cell = wf.cell;
  const xs = wx >= 0 ? 0 : res - 1,
    xe = wx >= 0 ? res : -1,
    xd = wx >= 0 ? 1 : -1;
  const zs = wz >= 0 ? 0 : res - 1,
    ze = wz >= 0 ? res : -1,
    zd = wz >= 0 ? 1 : -1;
  const ax = Math.abs(wx),
    az = Math.abs(wz);
  const s = ax + az;
  const px = ax / s,
    pz = az / s;
  const stepLen = cell / Math.max(ax, az, 1e-3) * Math.max(px, pz);
  for (let z = zs; z !== ze; z += zd) {
    for (let x = xs; x !== xe; x += xd) {
      const i = z * res + x;
      if (wf.type[i] === 0) {
        fetch[i] = 0;
        continue;
      }
      const ux = x - xd,
        uz = z - zd;
      // open boundary: the ocean has unlimited fetch at the map edge
      const fxp = ux < 0 || ux >= res ? (wf.type[i] === WATER_OCEAN ? 1e4 : 0) : fetch[z * res + ux];
      const fzp = uz < 0 || uz >= res ? (wf.type[i] === WATER_OCEAN ? 1e4 : 0) : fetch[uz * res + x];
      fetch[i] = Math.min(1e4, px * fxp + pz * fzp + stepLen);
    }
  }
  for (let i = 0; i < N; i++) {
    const t = wf.type[i];
    if (t === 0) {
      out[i] = 0;
      continue;
    }
    const ref = t === WATER_OCEAN ? 900 : 420;
    const e = Math.sqrt(Math.min(1, fetch[i] / ref));
    out[i] = Math.round(255 * (t === WATER_RIVER ? Math.min(e, 0.35) : 0.12 + 0.88 * e));
  }
}

/** Wavenumber from the linear dispersion relation (Eckart's approximation, <5% error). */
export function waveNumber(omega, depth) {
  const k0 = (omega * omega) / G;
  return k0 / Math.sqrt(Math.tanh(k0 * Math.max(0.05, depth)));
}

/** Shoaling coefficient Ks = sqrt(cg0 / cg). */
export function shoalingCoefficient(omega, depth) {
  const k = waveNumber(omega, depth);
  const kd = k * Math.max(0.05, depth);
  const c = omega / k;
  const nn = 0.5 * (1 + (2 * kd) / Math.sinh(Math.min(40, 2 * kd)));
  const cg = c * nn;
  const cg0 = (0.5 * G) / omega;
  return Math.sqrt(cg0 / cg);
}

function computeSwell(wf, hFinal, sea, swell) {
  const sres = wf.sres;
  const res = wf.res;
  const N = sres * sres;
  const cell = wf.cell * 2;
  const period = swell.period || 9;
  const omega = (2 * Math.PI) / period;
  const dirAng = swell.dir ?? 0; // direction of travel (radians, 0 = +x)
  const dx = Math.cos(dirAng),
    dz = Math.sin(dirAng);
  const H0 = swell.height ?? 1.0;
  const kArr = new Float32Array(N);
  const depthArr = new Float32Array(N);
  const phi = wf.swellPhase;
  const INF = 1e12;
  const k0 = (omega * omega) / G;
  for (let j = 0; j < sres; j++) {
    for (let i = 0; i < sres; i++) {
      const gi = j * 2 * res + i * 2;
      const o = j * sres + i;
      const wet = wf.type[gi] === WATER_OCEAN;
      const depth = sea.level - hFinal.data[gi];
      depthArr[o] = wet ? depth : -1;
      kArr[o] = wet ? waveNumber(omega, Math.max(0.25, depth)) : 0;
      phi[o] = INF;
      // incoming plane wave on the upwave open boundaries
      const onEdge = i === 0 || j === 0 || i === sres - 1 || j === sres - 1;
      if (wet && onEdge) {
        const nx = i === 0 ? -1 : i === sres - 1 ? 1 : 0;
        const nz = j === 0 ? -1 : j === sres - 1 ? 1 : 0;
        if (nx * dx + nz * dz < -0.05) {
          const x = i * cell - wf.size / 2,
            z = j * cell - wf.size / 2;
          phi[o] = k0 * (x * dx + z * dz) + k0 * wf.size; // offset keeps phases positive
        }
      }
    }
  }
  // fast sweeping for |grad phi| = k
  const upd = (i, j) => {
    const o = j * sres + i;
    const k = kArr[o];
    if (k <= 0) return;
    const a = Math.min(i > 0 ? phi[o - 1] : INF, i < sres - 1 ? phi[o + 1] : INF);
    const b = Math.min(j > 0 ? phi[o - sres] : INF, j < sres - 1 ? phi[o + sres] : INF);
    if (a >= INF && b >= INF) return;
    const f = k * cell;
    let t;
    if (Math.abs(a - b) >= f) t = Math.min(a, b) + f;
    else t = 0.5 * (a + b + Math.sqrt(2 * f * f - (a - b) * (a - b)));
    if (t < phi[o]) phi[o] = t;
  };
  for (let round = 0; round < 3; round++) {
    for (let j = 0; j < sres; j++) for (let i = 0; i < sres; i++) upd(i, j);
    for (let j = 0; j < sres; j++) for (let i = sres - 1; i >= 0; i--) upd(i, j);
    for (let j = sres - 1; j >= 0; j--) for (let i = 0; i < sres; i++) upd(i, j);
    for (let j = sres - 1; j >= 0; j--) for (let i = sres - 1; i >= 0; i--) upd(i, j);
  }
  // heights: shoaling, refraction spreading (turning away from the incident direction), breaking
  for (let j = 0; j < sres; j++) {
    for (let i = 0; i < sres; i++) {
      const o = j * sres + i;
      const depth = depthArr[o];
      if (depth <= 0 || phi[o] >= INF) {
        wf.swellH[o] = 0;
        wf.swellBreak[o] = 0;
        continue;
      }
      const pe = i < sres - 1 && phi[o + 1] < INF ? phi[o + 1] : phi[o];
      const pw = i > 0 && phi[o - 1] < INF ? phi[o - 1] : phi[o];
      const ps = j < sres - 1 && phi[o + sres] < INF ? phi[o + sres] : phi[o];
      const pn = j > 0 && phi[o - sres] < INF ? phi[o - sres] : phi[o];
      let gx = pe - pw,
        gz = ps - pn;
      const gl = Math.hypot(gx, gz) || 1;
      gx /= gl;
      gz /= gl;
      const turn = Math.max(0, gx * dx + gz * dz); // cos of turning angle
      const shelter = 0.2 + 0.8 * Math.pow(turn, 1.5);
      const Ks = Math.min(1.9, shoalingCoefficient(omega, depth));
      const Hs = H0 * Ks * shelter;
      const Hb = 0.78 * depth;
      // store the un-broken (shoaled, sheltered) height ratio; depth-limited breaking H <= 0.78 d is
      // applied per wave in the shader so that individual waves and sets break at different places
      wf.swellH[o] = Hs / Math.max(1e-3, H0);
      wf.swellBreak[o] = smoothstep(0.72, 1.0, Hs / Math.max(0.05, Hb));
    }
  }
  // fill dry cells with neighbouring phase so bilinear sampling near the shore is clean
  for (let pass = 0; pass < 6; pass++) {
    for (let j = 1; j < sres - 1; j++) {
      for (let i = 1; i < sres - 1; i++) {
        const o = j * sres + i;
        if (phi[o] < INF * 0.5) continue;
        let best = INF;
        for (const q of [o - 1, o + 1, o - sres, o + sres]) {
          const v = phi[q];
          if (v >= 0 && v < best) best = v;
        }
        if (best < INF) phi[o] = -best - 1; // mark, resolve after pass
      }
    }
    for (let o = 0; o < N; o++) if (phi[o] < 0) phi[o] = -phi[o] - 1 + 0.5;
  }
  for (let o = 0; o < N; o++) if (phi[o] >= INF) phi[o] = 0;
}
