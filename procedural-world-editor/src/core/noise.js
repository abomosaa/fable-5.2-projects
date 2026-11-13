// Deterministic seeded RNG + gradient noise utilities (DOM-free, used in workers, main thread and Node tests).

export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function hash32(a, b = 0, c = 0) {
  let h = (a | 0) ^ 0x9e3779b9;
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b);
  h = (h + Math.imul(b | 0, 0xc2b2ae35)) | 0;
  h = Math.imul(h ^ (h >>> 13), 0x27d4eb2f);
  h = (h + Math.imul(c | 0, 0x165667b1)) | 0;
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  return (h ^ (h >>> 16)) >>> 0;
}

export function hashFloat(a, b = 0, c = 0) {
  return hash32(a, b, c) / 4294967296;
}

export function stringSeed(str) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

const GX = new Float64Array(256);
const GY = new Float64Array(256);
for (let i = 0; i < 256; i++) {
  const a = (i / 256) * Math.PI * 2;
  GX[i] = Math.cos(a);
  GY[i] = Math.sin(a);
}

/** 2D gradient noise with analytic derivatives. */
export class Noise2D {
  constructor(seed) {
    const rnd = mulberry32(seed);
    const p = new Uint8Array(256);
    for (let i = 0; i < 256; i++) p[i] = i;
    for (let i = 255; i > 0; i--) {
      const j = (rnd() * (i + 1)) | 0;
      const t = p[i];
      p[i] = p[j];
      p[j] = t;
    }
    this.perm = new Uint8Array(512);
    for (let i = 0; i < 512; i++) this.perm[i] = p[i & 255];
    this.dx = 0;
    this.dy = 0;
  }

  /** Returns value in ~[-1,1]. Sets this.dx/this.dy to the gradient. */
  noise(x, y) {
    const perm = this.perm;
    const xf = Math.floor(x);
    const yf = Math.floor(y);
    const xi = xf & 255;
    const yi = yf & 255;
    const fx = x - xf;
    const fy = y - yf;
    const u = fx * fx * fx * (fx * (fx * 6 - 15) + 10);
    const v = fy * fy * fy * (fy * (fy * 6 - 15) + 10);
    const du = 30 * fx * fx * (fx * (fx - 2) + 1);
    const dv = 30 * fy * fy * (fy * (fy - 2) + 1);
    const g00 = perm[xi + perm[yi]];
    const g10 = perm[xi + 1 + perm[yi]];
    const g01 = perm[xi + perm[yi + 1]];
    const g11 = perm[xi + 1 + perm[yi + 1]];
    const a = GX[g00] * fx + GY[g00] * fy;
    const b = GX[g10] * (fx - 1) + GY[g10] * fy;
    const c = GX[g01] * fx + GY[g01] * (fy - 1);
    const d = GX[g11] * (fx - 1) + GY[g11] * (fy - 1);
    const k1 = b - a;
    const k2 = c - a;
    const k3 = a - b - c + d;
    this.dx = (GX[g00] + u * (GX[g10] - GX[g00]) + v * (GX[g01] - GX[g00]) + u * v * (GX[g00] - GX[g10] - GX[g01] + GX[g11]) + du * (k1 + k3 * v)) * 1.4142;
    this.dy = (GY[g00] + u * (GY[g10] - GY[g00]) + v * (GY[g01] - GY[g00]) + u * v * (GY[g00] - GY[g10] - GY[g01] + GY[g11]) + dv * (k2 + k3 * u)) * 1.4142;
    return (a + k1 * u + k2 * v + k3 * u * v) * 1.4142;
  }

  /** Plain fBm in ~[-1,1]. */
  fbm(x, y, octaves, lacunarity = 2.0, gain = 0.5) {
    let amp = 1;
    let sum = 0;
    let norm = 0;
    for (let o = 0; o < octaves; o++) {
      sum += amp * this.noise(x + o * 17.13, y - o * 9.71);
      norm += amp;
      amp *= gain;
      x *= lacunarity;
      y *= lacunarity;
    }
    return sum / norm;
  }

  /** Ridged multifractal in [0,1]: sharp ridges, used for mountain crests. */
  ridged(x, y, octaves, lacunarity = 2.0, gain = 0.5, offset = 1.0) {
    let amp = 1;
    let sum = 0;
    let norm = 0;
    let weight = 1;
    for (let o = 0; o < octaves; o++) {
      let n = offset - Math.abs(this.noise(x + o * 31.7, y + o * 11.3));
      n *= n;
      n *= weight;
      weight = Math.min(1, Math.max(0, n * 2.0));
      sum += n * amp;
      norm += amp;
      amp *= gain;
      x *= lacunarity;
      y *= lacunarity;
    }
    return sum / norm;
  }

  /**
   * Derivative-damped fBm (after I. Quilez): high octaves are suppressed on steep slopes,
   * which mimics eroded terrain (smooth valley floors, detailed ridges). Returns ~[-1,1].
   */
  erodedFbm(x, y, octaves, lacunarity = 2.0, gain = 0.5, damp = 1.0) {
    let amp = 1;
    let sum = 0;
    let norm = 0;
    let dxs = 0;
    let dys = 0;
    for (let o = 0; o < octaves; o++) {
      const n = this.noise(x + o * 13.7, y + o * 7.9);
      dxs += this.dx;
      dys += this.dy;
      sum += (amp * n) / (1 + damp * (dxs * dxs + dys * dys));
      norm += amp;
      amp *= gain;
      x *= lacunarity;
      y *= lacunarity;
    }
    return sum / norm;
  }
}

export function smoothstep(a, b, x) {
  let t = (x - a) / (b - a);
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  return t * t * (3 - 2 * t);
}
export function clamp(x, a, b) {
  return x < a ? a : x > b ? b : x;
}
export function lerp(a, b, t) {
  return a + (b - a) * t;
}
