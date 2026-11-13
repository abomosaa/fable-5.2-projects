// Ground queries for the physics: height, normal and surface type under a point.
// Heights are interpolated on the same 8 m triangle grid as the finest terrain mesh, so wheels
// touch exactly what is drawn. Runways, taxiways and aprons are flat paved slabs.

import { terrainHeight, surfaceAt, FINE_CELL, PAVEMENT_OFFSET } from './heightfield.js';
import { noised } from './noise.js';

const cache = new Map();
const C = FINE_CELL;

function nodeHeight(i, j) {
  const key = (i + 32768) * 65536 + (j + 32768);
  let h = cache.get(key);
  if (h === undefined) {
    if (cache.size > 30000) cache.clear();
    h = terrainHeight(i * C, j * C);
    cache.set(key, h);
  }
  return h;
}

/** Height of the rendered terrain surface (no pavement / roughness). */
export function meshHeight(x, z) {
  const gx = x / C, gz = z / C;
  const i = Math.floor(gx), j = Math.floor(gz);
  const fx = gx - i, fz = gz - j;
  const h00 = nodeHeight(i, j), h11 = nodeHeight(i + 1, j + 1);
  if (fz >= fx) { const h01 = nodeHeight(i, j + 1); return h00 + (h01 - h00) * fz + (h11 - h01) * fx; }
  const h10 = nodeHeight(i + 1, j);
  return h00 + (h10 - h00) * fx + (h11 - h10) * fz;
}

/**
 * Fill `out` with {h, nx, ny, nz, type, mu, rr}.
 * type: 0 paved, 1 grass, 2 rough, 3 water.
 */
export function groundQuery(x, z, out) {
  const gx = x / C, gz = z / C;
  const i = Math.floor(gx), j = Math.floor(gz);
  const fx = gx - i, fz = gz - j;
  const h00 = nodeHeight(i, j), h11 = nodeHeight(i + 1, j + 1);
  let h, dhx, dhz;
  if (fz >= fx) {
    const h01 = nodeHeight(i, j + 1);
    dhz = (h01 - h00) / C; dhx = (h11 - h01) / C;
    h = h00 + (h01 - h00) * fz + (h11 - h01) * fx;
  } else {
    const h10 = nodeHeight(i + 1, j);
    dhx = (h10 - h00) / C; dhz = (h11 - h10) / C;
    h = h00 + (h10 - h00) * fx + (h11 - h10) * fz;
  }
  if (h < 0) {
    // open water: the surface is the sea
    out.h = 0; out.nx = 0; out.ny = 1; out.nz = 0; out.type = 3; out.mu = 0.3; out.rr = 0.5;
    return out;
  }
  const type = surfaceAt(x, z, h);
  if (type === 0) {
    out.h = h + PAVEMENT_OFFSET; out.nx = 0; out.ny = 1; out.nz = 0; out.type = 0; out.mu = 0.8; out.rr = 0.016;
    return out;
  }
  const slope = Math.sqrt(dhx * dhx + dhz * dhz);
  const inv = 1 / Math.sqrt(1 + slope * slope);
  out.nx = -dhx * inv; out.ny = inv; out.nz = -dhz * inv;
  if (slope > 0.45 || h > 1500) {
    out.type = 2; out.mu = 0.65; out.rr = 0.14;
    out.h = h + 0.1 * noised(x * 0.6, z * 0.6);
  } else {
    out.type = 1; out.mu = 0.58; out.rr = 0.055;
    // turf is never perfectly smooth
    out.h = h + 0.035 * noised(x * 0.45, z * 0.45) + 0.02 * noised(x * 1.7, z * 1.7);
  }
  return out;
}
