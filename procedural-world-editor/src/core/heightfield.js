// Heightfield: square grid of elevations in metres. World origin is the terrain centre, +Y up.
// Grid index (ix, iz) maps to world x = -size/2 + ix*cell, z = -size/2 + iz*cell.

export class Heightfield {
  /**
   * @param {number} res  samples per side (e.g. 2049)
   * @param {number} size world extent in metres
   * @param {Float32Array} [data]
   */
  constructor(res, size, data) {
    this.res = res;
    this.size = size;
    this.cell = size / (res - 1);
    this.half = size / 2;
    this.data = data || new Float32Array(res * res);
  }

  clone() {
    return new Heightfield(this.res, this.size, new Float32Array(this.data));
  }

  /** world -> fractional grid coordinate */
  toGridX(x) {
    return (x + this.half) / this.cell;
  }
  toGridZ(z) {
    return (z + this.half) / this.cell;
  }
  toWorldX(ix) {
    return ix * this.cell - this.half;
  }
  toWorldZ(iz) {
    return iz * this.cell - this.half;
  }
  inBounds(x, z) {
    return x >= -this.half && x <= this.half && z >= -this.half && z <= this.half;
  }

  get(ix, iz) {
    const r = this.res;
    ix = ix < 0 ? 0 : ix >= r ? r - 1 : ix;
    iz = iz < 0 ? 0 : iz >= r ? r - 1 : iz;
    return this.data[iz * r + ix];
  }

  /** Bilinear sample at world position (clamped to the edge). */
  sample(x, z) {
    return sampleGrid(this.data, this.res, (x + this.half) / this.cell, (z + this.half) / this.cell);
  }

  /** Central-difference gradient (dh/dx, dh/dz) at world position; returns [gx, gz]. */
  gradient(x, z, out = [0, 0]) {
    const e = this.cell;
    out[0] = (this.sample(x + e, z) - this.sample(x - e, z)) / (2 * e);
    out[1] = (this.sample(x, z + e) - this.sample(x, z - e)) / (2 * e);
    return out;
  }

  /** Slope as tan(angle) at world position. */
  slope(x, z) {
    const g = this.gradient(x, z);
    return Math.hypot(g[0], g[1]);
  }

  normal(x, z, out = [0, 1, 0]) {
    const g = this.gradient(x, z);
    const l = 1 / Math.hypot(g[0], 1, g[1]);
    out[0] = -g[0] * l;
    out[1] = l;
    out[2] = -g[1] * l;
    return out;
  }

  minMax(rect) {
    const r = this.res;
    let x0 = 0,
      z0 = 0,
      x1 = r - 1,
      z1 = r - 1;
    if (rect) ({ x0, z0, x1, z1 } = rect);
    let mn = Infinity,
      mx = -Infinity;
    for (let iz = z0; iz <= z1; iz++) {
      const row = iz * r;
      for (let ix = x0; ix <= x1; ix++) {
        const v = this.data[row + ix];
        if (v < mn) mn = v;
        if (v > mx) mx = v;
      }
    }
    return [mn, mx];
  }

  /** Clamp a world-space circle/box to a grid rect {x0,z0,x1,z1} (inclusive). */
  rectFromWorld(xmin, zmin, xmax, zmax, pad = 0) {
    const r = this.res;
    return {
      x0: Math.max(0, Math.floor(this.toGridX(xmin)) - pad),
      z0: Math.max(0, Math.floor(this.toGridZ(zmin)) - pad),
      x1: Math.min(r - 1, Math.ceil(this.toGridX(xmax)) + pad),
      z1: Math.min(r - 1, Math.ceil(this.toGridZ(zmax)) + pad),
    };
  }

  /** Copy a rect out as a snapshot (for undo). */
  extract(rect) {
    const w = rect.x1 - rect.x0 + 1;
    const h = rect.z1 - rect.z0 + 1;
    const out = new Float32Array(w * h);
    for (let j = 0; j < h; j++) {
      const src = (rect.z0 + j) * this.res + rect.x0;
      out.set(this.data.subarray(src, src + w), j * w);
    }
    return out;
  }

  inject(rect, buf) {
    const w = rect.x1 - rect.x0 + 1;
    const h = rect.z1 - rect.z0 + 1;
    for (let j = 0; j < h; j++) {
      this.data.set(buf.subarray(j * w, j * w + w), (rect.z0 + j) * this.res + rect.x0);
    }
  }
}

export function sampleGrid(data, res, gx, gz) {
  const m = res - 1;
  gx = gx < 0 ? 0 : gx > m ? m : gx;
  gz = gz < 0 ? 0 : gz > m ? m : gz;
  let ix = gx | 0;
  let iz = gz | 0;
  if (ix >= m) ix = m - 1;
  if (iz >= m) iz = m - 1;
  const fx = gx - ix;
  const fz = gz - iz;
  const i = iz * res + ix;
  const a = data[i];
  const b = data[i + 1];
  const c = data[i + res];
  const d = data[i + res + 1];
  return a + (b - a) * fx + (c - a) * fz + (a - b - c + d) * fx * fz;
}

export function unionRect(a, b) {
  if (!a) return b ? { ...b } : null;
  if (!b) return { ...a };
  return { x0: Math.min(a.x0, b.x0), z0: Math.min(a.z0, b.z0), x1: Math.max(a.x1, b.x1), z1: Math.max(a.z1, b.z1) };
}

export function padRect(r, pad, res) {
  return { x0: Math.max(0, r.x0 - pad), z0: Math.max(0, r.z0 - pad), x1: Math.min(res - 1, r.x1 + pad), z1: Math.min(res - 1, r.z1 + pad) };
}

/** Catmull-Rom (bicubic) upsample of a square grid to a new resolution covering the same extent. */
export function upsampleBicubic(src, sres, dres, out) {
  out = out || new Float32Array(dres * dres);
  const scale = (sres - 1) / (dres - 1);
  const w = (t, k) => {
    // Catmull-Rom weights
    const t2 = t * t;
    const t3 = t2 * t;
    switch (k) {
      case 0:
        return -0.5 * t3 + t2 - 0.5 * t;
      case 1:
        return 1.5 * t3 - 2.5 * t2 + 1;
      case 2:
        return -1.5 * t3 + 2 * t2 + 0.5 * t;
      default:
        return 0.5 * t3 - 0.5 * t2;
    }
  };
  const cl = (i) => (i < 0 ? 0 : i >= sres ? sres - 1 : i);
  const wx = new Float32Array(4);
  const ixs = new Int32Array(4);
  for (let z = 0; z < dres; z++) {
    const gz = z * scale;
    const iz = Math.min(sres - 2, Math.floor(gz));
    const fz = gz - iz;
    const wz0 = w(fz, 0),
      wz1 = w(fz, 1),
      wz2 = w(fz, 2),
      wz3 = w(fz, 3);
    const r0 = cl(iz - 1) * sres,
      r1 = iz * sres,
      r2 = cl(iz + 1) * sres,
      r3 = cl(iz + 2) * sres;
    for (let x = 0; x < dres; x++) {
      const gx = x * scale;
      const ix = Math.min(sres - 2, Math.floor(gx));
      const fx = gx - ix;
      for (let k = 0; k < 4; k++) {
        wx[k] = w(fx, k);
        ixs[k] = cl(ix - 1 + k);
      }
      let s = 0;
      for (let k = 0; k < 4; k++) {
        const c = ixs[k];
        s += wx[k] * (wz0 * src[r0 + c] + wz1 * src[r1 + c] + wz2 * src[r2 + c] + wz3 * src[r3 + c]);
      }
      out[z * dres + x] = s;
    }
  }
  return out;
}

/** Bilinear resample of an arbitrary sub-window of a grid. */
export function resampleWindow(src, sres, gx0, gz0, gx1, gz1, dres, out) {
  out = out || new Float32Array(dres * dres);
  for (let z = 0; z < dres; z++) {
    const gz = gz0 + ((gz1 - gz0) * z) / (dres - 1);
    for (let x = 0; x < dres; x++) {
      const gx = gx0 + ((gx1 - gx0) * x) / (dres - 1);
      out[z * dres + x] = sampleGrid(src, sres, gx, gz);
    }
  }
  return out;
}
