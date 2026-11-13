// Particle-based hydraulic erosion and thermal (talus) erosion on a square heightfield.
// Both operate in place on a Float32Array and are deterministic for a given seed.
// Hydraulic: each droplet follows the gradient with inertia, picks up sediment proportional to
// (speed x slope x water), deposits when over capacity or in pits. Erodes with a soft circular
// brush to avoid single-cell trenches. A sediment map accumulates deposited material so the
// material system can show alluvium.

import { mulberry32 } from './noise.js';

export const HYDRAULIC_DEFAULTS = {
  droplets: 400000,
  seed: 1,
  inertia: 0.06,
  capacity: 5.0,
  minSlope: 0.01,
  erodeRate: 0.3,
  depositRate: 0.3,
  evaporation: 0.012,
  gravity: 4.0,
  maxSteps: 96,
  radius: 3, // cells
  strength: 1.0, // global multiplier on height change
  edgeFade: 24, // cells over which erosion fades to zero at the map border
};

function buildBrush(radius) {
  const offs = [];
  const wts = [];
  let sum = 0;
  for (let dz = -radius; dz <= radius; dz++) {
    for (let dx = -radius; dx <= radius; dx++) {
      const d = Math.hypot(dx, dz);
      if (d <= radius) {
        const w = 1 - d / radius;
        offs.push(dx, dz);
        wts.push(w);
        sum += w;
      }
    }
  }
  for (let i = 0; i < wts.length; i++) wts[i] /= sum;
  return { offs: Int32Array.from(offs), wts: Float32Array.from(wts) };
}

/**
 * @param {Float32Array} h heights (res*res), cell size `cell` (m)
 * @param {object} opts see HYDRAULIC_DEFAULTS; opts.rect limits droplet spawning to a grid rect;
 *   opts.mask (Float32Array res*res, 0..1) scales erosion strength; opts.sediment (Float32Array) accumulates deposits;
 *   opts.start / opts.count allow running in batches (droplet index range) with identical results.
 */
export function hydraulicErosion(h, res, cell, opts = {}) {
  const p = { ...HYDRAULIC_DEFAULTS, ...opts };
  const { offs, wts } = buildBrush(Math.max(1, p.radius | 0));
  const nb = wts.length;
  const sedMap = opts.sediment || null;
  const mask = opts.mask || null;
  const rect = opts.rect || { x0: 0, z0: 0, x1: res - 1, z1: res - 1 };
  const rw = rect.x1 - rect.x0;
  const rh = rect.z1 - rect.z0;
  const start = opts.start || 0;
  const count = opts.count ?? p.droplets;
  const m = res - 1;
  const fade = p.edgeFade;
  // heights are metres on a `cell` metre grid; work in cell units for gradients
  const inv = 1 / cell;
  for (let d = start; d < start + count; d++) {
    const rnd = mulberry32((p.seed * 0x9e3779b1 + d * 0x85ebca6b) >>> 0);
    let px = rect.x0 + rnd() * rw;
    let pz = rect.z0 + rnd() * rh;
    let dirx = 0,
      dirz = 0;
    let speed = 1,
      water = 1,
      sed = 0;
    for (let step = 0; step < p.maxSteps; step++) {
      const ix = px | 0;
      const iz = pz | 0;
      if (ix < 1 || iz < 1 || ix >= m - 1 || iz >= m - 1) break;
      const fx = px - ix;
      const fz = pz - iz;
      const i = iz * res + ix;
      const h00 = h[i],
        h10 = h[i + 1],
        h01 = h[i + res],
        h11 = h[i + res + 1];
      const gx = ((h10 - h00) * (1 - fz) + (h11 - h01) * fz) * inv;
      const gz = ((h01 - h00) * (1 - fx) + (h11 - h10) * fx) * inv;
      const hOld = h00 * (1 - fx) * (1 - fz) + h10 * fx * (1 - fz) + h01 * (1 - fx) * fz + h11 * fx * fz;
      dirx = dirx * p.inertia - gx * (1 - p.inertia);
      dirz = dirz * p.inertia - gz * (1 - p.inertia);
      const len = Math.hypot(dirx, dirz);
      if (len < 1e-9) {
        const a = rnd() * 6.2831853;
        dirx = Math.cos(a);
        dirz = Math.sin(a);
      } else {
        dirx /= len;
        dirz /= len;
      }
      const nx = px + dirx;
      const nz = pz + dirz;
      const jx = nx | 0;
      const jz = nz | 0;
      if (jx < 1 || jz < 1 || jx >= m - 1 || jz >= m - 1) break;
      const ux = nx - jx;
      const uz = nz - jz;
      const j = jz * res + jx;
      const hNew = h[j] * (1 - ux) * (1 - uz) + h[j + 1] * ux * (1 - uz) + h[j + res] * (1 - ux) * uz + h[j + res + 1] * ux * uz;
      const dh = (hNew - hOld) * inv; // slope in cell units (dimensionless gradient)
      const cap = Math.max(-dh, p.minSlope) * speed * water * p.capacity;
      let k = p.strength;
      if (fade > 0) {
        const e = Math.min(ix, iz, m - ix, m - iz) / fade;
        if (e < 1) k *= e * e * (3 - 2 * e);
      }
      if (mask) k *= mask[i];
      if (sed > cap || dh > 0) {
        // deposit: fill the pit if moving uphill, otherwise drop a fraction of the surplus
        let amt = dh > 0 ? Math.min(dh * cell, sed) : (sed - cap) * p.depositRate;
        sed -= amt;
        amt *= k;
        h[i] += amt * (1 - fx) * (1 - fz);
        h[i + 1] += amt * fx * (1 - fz);
        h[i + res] += amt * (1 - fx) * fz;
        h[i + res + 1] += amt * fx * fz;
        if (sedMap) sedMap[i] += amt;
      } else {
        const amt = Math.min((cap - sed) * p.erodeRate, -dh * cell);
        if (amt > 0) {
          for (let b = 0; b < nb; b++) {
            const bx = ix + offs[b * 2];
            const bz = iz + offs[b * 2 + 1];
            if (bx < 0 || bz < 0 || bx > m || bz > m) continue;
            const bi = bz * res + bx;
            const e = amt * wts[b] * k;
            h[bi] -= e;
            if (sedMap) sedMap[bi] -= e * 0.5;
          }
          sed += amt;
        }
      }
      speed = Math.sqrt(Math.max(0, speed * speed - dh * p.gravity));
      water *= 1 - p.evaporation;
      px = nx;
      pz = nz;
      if (water < 0.01) break;
    }
  }
}

export const THERMAL_DEFAULTS = {
  iterations: 30,
  talus: 0.7, // tan(angle of repose) ~35 degrees
  rate: 0.4,
  edgeFade: 8,
};

/**
 * Thermal erosion: material above the angle of repose slides to lower neighbours.
 * opts.talusMap (Float32Array) may supply a per-cell repose gradient (hard rock holds steeper faces).
 * opts.iterStart/iterCount allow batching.
 */
export function thermalErosion(h, res, cell, opts = {}) {
  const p = { ...THERMAL_DEFAULTS, ...opts };
  const rect = opts.rect || { x0: 1, z0: 1, x1: res - 2, z1: res - 2 };
  const x0 = Math.max(1, rect.x0),
    z0 = Math.max(1, rect.z0),
    x1 = Math.min(res - 2, rect.x1),
    z1 = Math.min(res - 2, rect.z1);
  const talusMap = opts.talusMap || null;
  const mask = opts.mask || null;
  const sedMap = opts.sediment || null;
  const delta = new Float32Array(res * res);
  const offs = [-1, 1, -res, res, -res - 1, -res + 1, res - 1, res + 1];
  const dist = [cell, cell, cell, cell, cell * Math.SQRT2, cell * Math.SQRT2, cell * Math.SQRT2, cell * Math.SQRT2];
  const iters = opts.iterCount ?? p.iterations;
  for (let it = 0; it < iters; it++) {
    for (let z = z0; z <= z1; z++) {
      for (let x = x0; x <= x1; x++) {
        const i = z * res + x;
        const hc = h[i];
        const tal = talusMap ? talusMap[i] : p.talus;
        let maxD = 0;
        let total = 0;
        for (let k = 0; k < 8; k++) {
          const d = hc - h[i + offs[k]] - tal * dist[k];
          if (d > 0) {
            total += d;
            if (d > maxD) maxD = d;
          }
        }
        if (total <= 0) continue;
        let rate = p.rate;
        if (mask) rate *= mask[i];
        const move = maxD * 0.5 * rate;
        delta[i] -= move;
        for (let k = 0; k < 8; k++) {
          const d = hc - h[i + offs[k]] - tal * dist[k];
          if (d > 0) delta[i + offs[k]] += (move * d) / total;
        }
      }
    }
    for (let z = z0 - 1; z <= z1 + 1; z++) {
      for (let x = x0 - 1; x <= x1 + 1; x++) {
        const i = z * res + x;
        const d = delta[i];
        if (d !== 0) {
          h[i] += d;
          if (sedMap && d > 0) sedMap[i] += d;
          delta[i] = 0;
        }
      }
    }
  }
}
