/**
 * Minimal allocation-free vector / quaternion math for the physics core.
 *
 * Conventions used by the whole simulator
 * ---------------------------------------
 * World frame : right-handed, +X east, +Y up, +Z south (so "north"/forward is -Z).
 * Body frame  : +X right, +Y up (thrust axis), +Z back (so the nose points along -Z).
 * Quaternion  : q rotates body-frame vectors into the world frame.
 * Body rates  : angular velocity expressed in the body frame [rad/s].
 *
 * These match three.js object/camera conventions, so the physics attitude can be
 * copied straight onto the rendered model.
 */

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export interface Quat {
  w: number;
  x: number;
  y: number;
  z: number;
}

export const DEG2RAD = Math.PI / 180;
export const RAD2DEG = 180 / Math.PI;
export const GRAVITY = 9.80665;

export const vec3 = (x = 0, y = 0, z = 0): Vec3 => ({ x, y, z });
export const quat = (w = 1, x = 0, y = 0, z = 0): Quat => ({ w, x, y, z });

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

export function smoothstep(e0: number, e1: number, x: number): number {
  const t = clamp((x - e0) / (e1 - e0), 0, 1);
  return t * t * (3 - 2 * t);
}

export function vSet(out: Vec3, x: number, y: number, z: number): Vec3 {
  out.x = x;
  out.y = y;
  out.z = z;
  return out;
}

export function vCopy(out: Vec3, a: Vec3): Vec3 {
  out.x = a.x;
  out.y = a.y;
  out.z = a.z;
  return out;
}

export function vLen(a: Vec3): number {
  return Math.sqrt(a.x * a.x + a.y * a.y + a.z * a.z);
}

export function vDot(a: Vec3, b: Vec3): number {
  return a.x * b.x + a.y * b.y + a.z * b.z;
}

export function vCross(out: Vec3, a: Vec3, b: Vec3): Vec3 {
  const x = a.y * b.z - a.z * b.y;
  const y = a.z * b.x - a.x * b.z;
  const z = a.x * b.y - a.y * b.x;
  out.x = x;
  out.y = y;
  out.z = z;
  return out;
}

/** Rotate a body-frame vector into the world frame: out = q * v * q^-1. */
export function qRotate(out: Vec3, q: Quat, v: Vec3): Vec3 {
  const { w, x, y, z } = q;
  const vx = v.x, vy = v.y, vz = v.z;
  // t = 2 * cross(q.xyz, v)
  const tx = 2 * (y * vz - z * vy);
  const ty = 2 * (z * vx - x * vz);
  const tz = 2 * (x * vy - y * vx);
  out.x = vx + w * tx + (y * tz - z * ty);
  out.y = vy + w * ty + (z * tx - x * tz);
  out.z = vz + w * tz + (x * ty - y * tx);
  return out;
}

/** Rotate a world-frame vector into the body frame: out = q^-1 * v * q. */
export function qRotateInv(out: Vec3, q: Quat, v: Vec3): Vec3 {
  const w = q.w, x = -q.x, y = -q.y, z = -q.z;
  const vx = v.x, vy = v.y, vz = v.z;
  const tx = 2 * (y * vz - z * vy);
  const ty = 2 * (z * vx - x * vz);
  const tz = 2 * (x * vy - y * vx);
  out.x = vx + w * tx + (y * tz - z * ty);
  out.y = vy + w * ty + (z * tx - x * tz);
  out.z = vz + w * tz + (x * ty - y * tx);
  return out;
}

export function qMul(out: Quat, a: Quat, b: Quat): Quat {
  const w = a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z;
  const x = a.w * b.x + a.x * b.w + a.y * b.z - a.z * b.y;
  const y = a.w * b.y - a.x * b.z + a.y * b.w + a.z * b.x;
  const z = a.w * b.z + a.x * b.y - a.y * b.x + a.z * b.w;
  out.w = w;
  out.x = x;
  out.y = y;
  out.z = z;
  return out;
}

export function qNormalize(q: Quat): Quat {
  const n = Math.sqrt(q.w * q.w + q.x * q.x + q.y * q.y + q.z * q.z);
  if (n > 0) {
    const s = 1 / n;
    q.w *= s;
    q.x *= s;
    q.y *= s;
    q.z *= s;
  } else {
    q.w = 1;
    q.x = q.y = q.z = 0;
  }
  return q;
}

/**
 * Integrate attitude with body-frame angular velocity over dt using the exact
 * exponential map for a constant rate: q <- q * exp(0.5 * w * dt).
 */
export function qIntegrate(q: Quat, wx: number, wy: number, wz: number, dt: number): Quat {
  const mag = Math.sqrt(wx * wx + wy * wy + wz * wz);
  const half = 0.5 * mag * dt;
  let s: number;
  if (half < 1e-6) {
    s = 0.5 * dt; // sin(half)/mag -> 0.5*dt
  } else {
    s = Math.sin(half) / mag;
  }
  const c = Math.cos(half);
  const dx = wx * s, dy = wy * s, dz = wz * s;
  const w = q.w * c - q.x * dx - q.y * dy - q.z * dz;
  const x = q.w * dx + q.x * c + q.y * dz - q.z * dy;
  const y = q.w * dy - q.x * dz + q.y * c + q.z * dx;
  const z = q.w * dz + q.x * dy - q.y * dx + q.z * c;
  q.w = w;
  q.x = x;
  q.y = y;
  q.z = z;
  return qNormalize(q);
}

/** Quaternion from axis (unit) and angle [rad]. */
export function qFromAxisAngle(out: Quat, ax: number, ay: number, az: number, angle: number): Quat {
  const s = Math.sin(angle / 2);
  out.w = Math.cos(angle / 2);
  out.x = ax * s;
  out.y = ay * s;
  out.z = az * s;
  return out;
}

/**
 * Build an attitude from heading / pitch / roll.
 * heading: compass heading in radians, 0 = facing -Z (north), positive clockwise seen from above.
 * pitch  : nose-up positive [rad].
 * roll   : right-wing-down positive [rad].
 */
export function qFromHeadingPitchRoll(out: Quat, heading: number, pitch: number, roll: number): Quat {
  const qy = quat(), qx = quat(), qz = quat();
  qFromAxisAngle(qy, 0, 1, 0, -heading);
  qFromAxisAngle(qx, 1, 0, 0, pitch);
  qFromAxisAngle(qz, 0, 0, 1, -roll);
  qMul(out, qy, qx);
  qMul(out, out, qz);
  return qNormalize(out);
}

export interface Attitude {
  /** compass heading [rad], 0 = -Z, clockwise positive, range (-pi, pi] */
  heading: number;
  /** nose-up positive [rad], range [-pi/2, pi/2] */
  pitch: number;
  /** right-wing-down positive [rad], range (-pi, pi] */
  roll: number;
}

/** Extract heading / pitch / roll (same convention as qFromHeadingPitchRoll). */
export function attitudeFromQuat(q: Quat, out: Attitude): Attitude {
  // Body forward (-Z) and right (+X) axes expressed in world.
  const { w, x, y, z } = q;
  // forward = q * (0,0,-1)
  const fx = -(2 * (x * z + w * y));
  const fy = -(2 * (y * z - w * x));
  const fz = -(1 - 2 * (x * x + y * y));
  // right = q * (1,0,0)
  const rx = 1 - 2 * (y * y + z * z);
  const ry = 2 * (x * y + w * z);
  const rz = 2 * (x * z - w * y);
  // up = q * (0,1,0)
  const uy = 1 - 2 * (x * x + z * z);

  out.pitch = Math.asin(clamp(fy, -1, 1));
  const horiz = Math.hypot(fx, fz);
  if (horiz > 1e-6) {
    out.heading = Math.atan2(fx, -fz);
    // Roll: angle of the right vector below the horizon about the forward axis.
    out.roll = Math.atan2(-ry, uy);
  } else {
    // Looking straight up/down: heading from the right vector.
    out.heading = Math.atan2(rz, rx);
    out.roll = 0;
  }
  return out;
}

/** Deterministic PRNG (mulberry32) with Gaussian helper. */
export class Rng {
  private s: number;
  private spare: number | null = null;

  constructor(seed = 0x9e3779b9) {
    this.s = seed >>> 0;
  }

  next(): number {
    this.s = (this.s + 0x6d2b79f5) >>> 0;
    let t = this.s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  range(lo: number, hi: number): number {
    return lo + (hi - lo) * this.next();
  }

  /** Standard normal sample (Box-Muller, cached pair). */
  gauss(): number {
    if (this.spare !== null) {
      const v = this.spare;
      this.spare = null;
      return v;
    }
    let u = 0;
    while (u < 1e-12) u = this.next();
    const v = this.next();
    const r = Math.sqrt(-2 * Math.log(u));
    const a = 2 * Math.PI * v;
    this.spare = r * Math.sin(a);
    return r * Math.cos(a);
  }
}
