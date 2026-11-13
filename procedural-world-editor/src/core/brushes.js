// Terrain and mask brushes. DOM-free; operate in place and return the touched grid rect.

import { hydraulicErosion } from './erosion.js';
import { smoothstep } from './noise.js';

export const SCULPT_KINDS = {
  raise: 'Raise',
  lower: 'Lower',
  flatten: 'Flatten',
  smooth: 'Smooth',
  terrace: 'Terrace',
  carve: 'Carve channel',
  erode: 'Erode (hydraulic)',
};

function falloff(d, r, hardness) {
  const t = d / r;
  if (t >= 1) return 0;
  if (t <= hardness) return 1;
  const u = (t - hardness) / (1 - hardness);
  return (1 - u * u) * (1 - u * u);
}

/**
 * @param {import('./heightfield.js').Heightfield} hf
 * @param {string} kind
 * @param {number} x world x, z world z of the brush centre
 * @param {object} o {radius, strength (0..1), dt (s), hardness, target (flatten), step (terrace), depth (carve), state (stroke state object), seed}
 */
export function applySculpt(hf, kind, x, z, o) {
  const { radius, strength, dt } = o;
  const hardness = o.hardness ?? 0.3;
  const rect = hf.rectFromWorld(x - radius, z - radius, x + radius, z + radius, kind === 'smooth' ? 2 : 0);
  const res = hf.res;
  const d = hf.data;
  const state = o.state || {};
  if (kind === 'erode') {
    const cells = (rect.x1 - rect.x0 + 1) * (rect.z1 - rect.z0 + 1);
    state.dab = (state.dab || 0) + 1;
    hydraulicErosion(d, res, hf.cell, { rect, droplets: Math.round(cells * 0.35 * strength + 40), seed: (o.seed || 1) + state.dab * 7919, maxSteps: 48, radius: 2, edgeFade: 0, strength: 0.9, erodeRate: 0.35 });
    return rect;
  }
  let src = null;
  if (kind === 'smooth') src = hf.extract(rect);
  const w = rect.x1 - rect.x0 + 1;
  const hh = rect.z1 - rect.z0 + 1;
  const rate = strength * Math.max(1.5, radius * 0.4); // m/s at the centre
  if (kind === 'carve') {
    // the channel bed may only stay level or descend along the stroke, so water can follow it
    const here = hf.sample(x, z) - (o.depth ?? 2) * 0.15;
    state.bed = state.bed === undefined ? hf.sample(x, z) - (o.depth ?? 2) : Math.min(state.bed, here);
  }
  for (let iz = rect.z0; iz <= rect.z1; iz++) {
    const wz = hf.toWorldZ(iz) - z;
    for (let ix = rect.x0; ix <= rect.x1; ix++) {
      const wx = hf.toWorldX(ix) - x;
      const dist = Math.hypot(wx, wz);
      if (dist >= radius) continue;
      const f = falloff(dist, radius, hardness);
      const i = iz * res + ix;
      const hcur = d[i];
      switch (kind) {
        case 'raise':
          d[i] = hcur + rate * f * dt;
          break;
        case 'lower':
          d[i] = hcur - rate * f * dt;
          break;
        case 'flatten':
          d[i] = hcur + (o.target - hcur) * Math.min(1, f * strength * dt * 7);
          break;
        case 'smooth': {
          const lx = ix - rect.x0,
            lz = iz - rect.z0;
          let s = 0,
            n = 0;
          for (let b = -2; b <= 2; b++) {
            const zz = lz + b;
            if (zz < 0 || zz >= hh) continue;
            for (let a = -2; a <= 2; a++) {
              const xx = lx + a;
              if (xx < 0 || xx >= w) continue;
              s += src[zz * w + xx];
              n++;
            }
          }
          d[i] = hcur + (s / n - hcur) * Math.min(1, f * strength * dt * 9);
          break;
        }
        case 'terrace': {
          const st = o.step || 4;
          const t = hcur / st;
          const fl = Math.floor(t);
          const fr = t - fl;
          const shaped = (fl + smoothstep(0.62, 0.92, fr)) * st;
          d[i] = hcur + (shaped - hcur) * Math.min(1, f * strength * dt * 6);
          break;
        }
        case 'carve': {
          const u = dist / radius;
          const target = state.bed + (o.depth ?? 2) * u * u * 1.15;
          if (target < hcur) d[i] = hcur + (target - hcur) * Math.min(1, (0.35 + 0.65 * f) * strength * dt * 8);
          break;
        }
        default:
          break;
      }
    }
  }
  return rect;
}

/** Move an 8-bit mask towards `target` (0..255) under the brush. */
export function paintMask(arr, hf, x, z, radius, target, strength, dt, hardness = 0.4) {
  const rect = hf.rectFromWorld(x - radius, z - radius, x + radius, z + radius);
  const res = hf.res;
  for (let iz = rect.z0; iz <= rect.z1; iz++) {
    const wz = hf.toWorldZ(iz) - z;
    for (let ix = rect.x0; ix <= rect.x1; ix++) {
      const wx = hf.toWorldX(ix) - x;
      const dist = Math.hypot(wx, wz);
      if (dist >= radius) continue;
      const f = falloff(dist, radius, hardness);
      const i = iz * res + ix;
      const v = arr[i];
      const k = Math.min(1, f * strength * dt * 10);
      let nv = v + (target - v) * k;
      // guarantee progress despite 8-bit rounding
      if (Math.round(nv) === v && k > 0.02 && v !== target) nv = v + Math.sign(target - v);
      arr[i] = Math.round(nv);
    }
  }
  return rect;
}

/** Stamp an index (biome id) with a slightly ragged edge. */
export function paintIndex(arr, hf, x, z, radius, value) {
  const rect = hf.rectFromWorld(x - radius, z - radius, x + radius, z + radius);
  const res = hf.res;
  for (let iz = rect.z0; iz <= rect.z1; iz++) {
    const wz = hf.toWorldZ(iz) - z;
    for (let ix = rect.x0; ix <= rect.x1; ix++) {
      const wx = hf.toWorldX(ix) - x;
      if (wx * wx + wz * wz < radius * radius) arr[iz * res + ix] = value;
    }
  }
  return rect;
}
