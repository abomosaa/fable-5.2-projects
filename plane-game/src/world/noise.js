// Deterministic 2D gradient noise with analytic derivatives, and fractal sums built on it.
// Shared by the main thread (physics ground queries) and the terrain workers (meshing), so the
// rendered ground and the collision ground are the same function.

const PERM = new Uint8Array(512);
const GX = new Float64Array(256), GY = new Float64Array(256);
(function init() {
  let s = 0x2f6e2b1;
  const rnd = () => { s ^= s << 13; s ^= s >>> 17; s ^= s << 5; return (s >>> 0) / 4294967296; };
  const p = new Uint8Array(256);
  for (let i = 0; i < 256; i++) p[i] = i;
  for (let i = 255; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); const t = p[i]; p[i] = p[j]; p[j] = t; }
  for (let i = 0; i < 512; i++) PERM[i] = p[i & 255];
  for (let i = 0; i < 256; i++) { const a = rnd() * Math.PI * 2; GX[i] = Math.cos(a); GY[i] = Math.sin(a); }
})();

// result of the last noised() call
export const N = { v: 0, dx: 0, dy: 0 };

/** Gradient noise in [-1, 1] with derivatives (quintic interpolation). */
export function noised(x, y) {
  const xi = Math.floor(x), yi = Math.floor(y);
  const fx = x - xi, fy = y - yi;
  const X = xi & 255, Y = yi & 255;
  const g00 = PERM[X + PERM[Y]], g10 = PERM[X + 1 + PERM[Y]];
  const g01 = PERM[X + PERM[Y + 1]], g11 = PERM[X + 1 + PERM[Y + 1]];
  const ax = GX[g00], ay = GY[g00], bx = GX[g10], by = GY[g10];
  const cx = GX[g01], cy = GY[g01], dx = GX[g11], dy = GY[g11];
  const va = ax * fx + ay * fy;
  const vb = bx * (fx - 1) + by * fy;
  const vc = cx * fx + cy * (fy - 1);
  const vd = dx * (fx - 1) + dy * (fy - 1);
  const ux = fx * fx * fx * (fx * (fx * 6 - 15) + 10), uy = fy * fy * fy * (fy * (fy * 6 - 15) + 10);
  const dux = 30 * fx * fx * (fx * (fx - 2) + 1), duy = 30 * fy * fy * (fy * (fy - 2) + 1);
  const k1 = vb - va, k2 = vc - va, k3 = va - vb - vc + vd;
  N.v = 1.6 * (va + ux * k1 + uy * k2 + ux * uy * k3);
  N.dx = 1.6 * (ax + ux * (bx - ax) + uy * (cx - ax) + ux * uy * (ax - bx - cx + dx) + dux * (k1 + uy * k3));
  N.dy = 1.6 * (ay + ux * (by - ay) + uy * (cy - ay) + ux * uy * (ay - by - cy + dy) + duy * (k2 + ux * k3));
  return N.v;
}

export function noise(x, y) { return noised(x, y); }

/** Plain fractal Brownian motion, roughly in [-1, 1]. */
export function fbm(x, y, octaves, lacunarity = 2.03, gain = 0.5) {
  let sum = 0, amp = 0.5, norm = 0;
  for (let i = 0; i < octaves; i++) {
    sum += amp * noised(x, y);
    norm += amp;
    x = x * lacunarity + 17.13; y = y * lacunarity - 9.71;
    amp *= gain;
  }
  return sum / norm;
}

/**
 * "Eroded" fBm (after I. Quilez): octaves are attenuated where the accumulated slope is
 * large, which leaves smooth valley floors and detailed ridges. Returns ~[0, 1].
 */
export function erodedFbm(x, y, octaves, erosion = 1.0) {
  let sum = 0, amp = 0.5, norm = 0, dxs = 0, dys = 0, freq = 1;
  for (let i = 0; i < octaves; i++) {
    noised(x, y);
    dxs += N.dx * amp * freq; dys += N.dy * amp * freq;
    sum += amp * (N.v * 0.5 + 0.5) / (1 + erosion * (dxs * dxs + dys * dys));
    norm += amp;
    // rotate the domain between octaves to hide the lattice
    const nx = 1.6 * x + 1.2 * y, ny = -1.2 * x + 1.6 * y;
    x = nx + 31.7; y = ny - 12.3;
    freq *= 2; amp *= 0.5;
  }
  return sum / norm;
}

/** Ridged multifractal, ~[0, 1]: sharp crests, used for mountain ranges. */
export function ridged(x, y, octaves) {
  let sum = 0, amp = 0.5, norm = 0, prev = 1;
  for (let i = 0; i < octaves; i++) {
    let n = 1 - Math.abs(noised(x, y));
    n *= n;
    sum += n * amp * prev;
    norm += amp;
    prev = Math.min(1, n * 1.6 + 0.15);
    const nx = 1.6 * x + 1.2 * y, ny = -1.2 * x + 1.6 * y;
    x = nx + 5.3; y = ny + 21.9;
    amp *= 0.5;
  }
  return sum / norm;
}

/** Integer hash -> [0, 1). */
export function hash2(ix, iy) {
  let h = Math.imul(ix | 0, 374761393) ^ Math.imul(iy | 0, 668265263);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}
