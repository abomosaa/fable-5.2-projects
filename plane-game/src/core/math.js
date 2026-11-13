// Minimal allocation-free vector / quaternion math used by the physics core.
// Conventions (right handed):
//   World: +X north, +Y up, +Z east
//   Body : +X forward (nose), +Y up, +Z right (starboard wing)

export const DEG = Math.PI / 180;
export const RAD = 180 / Math.PI;
export const G0 = 9.80665;

export const KT = 0.514444;      // m/s per knot
export const FT = 0.3048;        // m per foot
export const NM = 1852;          // m per nautical mile
export const FPM = 0.00508;      // m/s per ft/min
export const HP = 745.7;         // W per horsepower
export const LBF = 4.44822;      // N per lbf

export const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);
export const lerp = (a, b, t) => a + (b - a) * t;
export const sign = (x) => (x < 0 ? -1 : 1);
export const smoothstep = (a, b, x) => {
  const t = clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
};
export const wrapPi = (a) => {
  a = (a + Math.PI) % (2 * Math.PI);
  if (a < 0) a += 2 * Math.PI;
  return a - Math.PI;
};
export const wrap2Pi = (a) => {
  a = a % (2 * Math.PI);
  return a < 0 ? a + 2 * Math.PI : a;
};
/** Move `cur` toward `target` by at most `maxDelta`. */
export const approach = (cur, target, maxDelta) =>
  cur < target ? Math.min(cur + maxDelta, target) : Math.max(cur - maxDelta, target);

/** Piecewise linear interpolation in a table of [x, y] pairs sorted by x. */
export function interp1(table, x) {
  const n = table.length;
  if (x <= table[0][0]) return table[0][1];
  if (x >= table[n - 1][0]) return table[n - 1][1];
  for (let i = 1; i < n; i++) {
    if (x <= table[i][0]) {
      const a = table[i - 1], b = table[i];
      return a[1] + ((b[1] - a[1]) * (x - a[0])) / (b[0] - a[0]);
    }
  }
  return table[n - 1][1];
}

export class Vec3 {
  constructor(x = 0, y = 0, z = 0) { this.x = x; this.y = y; this.z = z; }
  set(x, y, z) { this.x = x; this.y = y; this.z = z; return this; }
  copy(v) { this.x = v.x; this.y = v.y; this.z = v.z; return this; }
  clone() { return new Vec3(this.x, this.y, this.z); }
  add(v) { this.x += v.x; this.y += v.y; this.z += v.z; return this; }
  sub(v) { this.x -= v.x; this.y -= v.y; this.z -= v.z; return this; }
  addScaled(v, s) { this.x += v.x * s; this.y += v.y * s; this.z += v.z * s; return this; }
  scale(s) { this.x *= s; this.y *= s; this.z *= s; return this; }
  dot(v) { return this.x * v.x + this.y * v.y + this.z * v.z; }
  lengthSq() { return this.x * this.x + this.y * this.y + this.z * this.z; }
  length() { return Math.sqrt(this.x * this.x + this.y * this.y + this.z * this.z); }
  normalize() {
    const l = this.length();
    if (l > 1e-12) { this.x /= l; this.y /= l; this.z /= l; }
    return this;
  }
  /** this = a x b */
  crossVectors(a, b) {
    const x = a.y * b.z - a.z * b.y, y = a.z * b.x - a.x * b.z, z = a.x * b.y - a.y * b.x;
    this.x = x; this.y = y; this.z = z; return this;
  }
  /** rotate this vector by quaternion q (body -> world when q is the attitude) */
  applyQuat(q) {
    const x = this.x, y = this.y, z = this.z;
    const qx = q.x, qy = q.y, qz = q.z, qw = q.w;
    const tx = 2 * (qy * z - qz * y), ty = 2 * (qz * x - qx * z), tz = 2 * (qx * y - qy * x);
    this.x = x + qw * tx + (qy * tz - qz * ty);
    this.y = y + qw * ty + (qz * tx - qx * tz);
    this.z = z + qw * tz + (qx * ty - qy * tx);
    return this;
  }
  /** rotate this vector by the inverse of q (world -> body) */
  applyQuatInv(q) {
    const x = this.x, y = this.y, z = this.z;
    const qx = -q.x, qy = -q.y, qz = -q.z, qw = q.w;
    const tx = 2 * (qy * z - qz * y), ty = 2 * (qz * x - qx * z), tz = 2 * (qx * y - qy * x);
    this.x = x + qw * tx + (qy * tz - qz * ty);
    this.y = y + qw * ty + (qz * tx - qx * tz);
    this.z = z + qw * tz + (qx * ty - qy * tx);
    return this;
  }
}

export class Quat {
  constructor(x = 0, y = 0, z = 0, w = 1) { this.x = x; this.y = y; this.z = z; this.w = w; }
  set(x, y, z, w) { this.x = x; this.y = y; this.z = z; this.w = w; return this; }
  copy(q) { this.x = q.x; this.y = q.y; this.z = q.z; this.w = q.w; return this; }
  clone() { return new Quat(this.x, this.y, this.z, this.w); }
  normalize() {
    const l = Math.hypot(this.x, this.y, this.z, this.w) || 1;
    this.x /= l; this.y /= l; this.z /= l; this.w /= l; return this;
  }
  /** this = this * q */
  multiply(q) {
    const ax = this.x, ay = this.y, az = this.z, aw = this.w;
    const bx = q.x, by = q.y, bz = q.z, bw = q.w;
    this.x = aw * bx + ax * bw + ay * bz - az * by;
    this.y = aw * by - ax * bz + ay * bw + az * bx;
    this.z = aw * bz + ax * by - ay * bx + az * bw;
    this.w = aw * bw - ax * bx - ay * by - az * bz;
    return this;
  }
  setFromAxisAngle(ax, ay, az, angle) {
    const s = Math.sin(angle / 2);
    this.x = ax * s; this.y = ay * s; this.z = az * s; this.w = Math.cos(angle / 2);
    return this;
  }
  /**
   * Attitude from aviation Euler angles (radians).
   * heading: 0 = north (+X), 90deg = east (+Z); pitch: nose up +; roll: right wing down +.
   * R = Ry(-heading) * Rz(pitch) * Rx(roll)
   */
  setFromEuler(heading, pitch, roll) {
    const a = new Quat().setFromAxisAngle(0, 1, 0, -heading);
    const b = _qa.setFromAxisAngle(0, 0, 1, pitch);
    const c = _qb.setFromAxisAngle(1, 0, 0, roll);
    a.multiply(b).multiply(c);
    return this.copy(a).normalize();
  }
  /** Integrate body-frame angular velocity over dt. */
  integrateBodyRate(wx, wy, wz, dt) {
    const mag = Math.sqrt(wx * wx + wy * wy + wz * wz);
    const ang = mag * dt;
    if (ang < 1e-12) return this;
    const s = Math.sin(ang / 2) / mag;
    _qa.set(wx * s, wy * s, wz * s, Math.cos(ang / 2));
    return this.multiply(_qa).normalize();
  }
  slerp(qb, t) {
    let cos = this.x * qb.x + this.y * qb.y + this.z * qb.z + this.w * qb.w;
    let bx = qb.x, by = qb.y, bz = qb.z, bw = qb.w;
    if (cos < 0) { cos = -cos; bx = -bx; by = -by; bz = -bz; bw = -bw; }
    let k0, k1;
    if (cos > 0.9995) { k0 = 1 - t; k1 = t; }
    else {
      const th = Math.acos(cos), s = Math.sin(th);
      k0 = Math.sin((1 - t) * th) / s; k1 = Math.sin(t * th) / s;
    }
    this.x = this.x * k0 + bx * k1; this.y = this.y * k0 + by * k1;
    this.z = this.z * k0 + bz * k1; this.w = this.w * k0 + bw * k1;
    return this.normalize();
  }
}

const _qa = new Quat(), _qb = new Quat();
const _f = new Vec3(), _u = new Vec3(), _r = new Vec3();

/** Extract heading / pitch / roll (radians) from an attitude quaternion. */
export function eulerFromQuat(q, out) {
  _f.set(1, 0, 0).applyQuat(q);
  _u.set(0, 1, 0).applyQuat(q);
  _r.set(0, 0, 1).applyQuat(q);
  out.heading = wrap2Pi(Math.atan2(_f.z, _f.x));
  out.pitch = Math.asin(clamp(_f.y, -1, 1));
  out.roll = Math.atan2(-_r.y, _u.y);
  return out;
}

/** Deterministic PRNG (mulberry32). */
export function makeRng(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Standard normal sample (Box-Muller) from a uniform rng. */
export function gauss(rng) {
  let u = 0;
  while (u < 1e-12) u = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rng());
}
