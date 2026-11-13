/** Small allocation-free math helpers used by the deterministic simulation. */

export const TAU = Math.PI * 2;

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/** Wraps an angle into (-PI, PI]. */
export function wrapAngle(a: number): number {
  if (a > Math.PI || a <= -Math.PI) {
    a = a % TAU;
    if (a > Math.PI) a -= TAU;
    else if (a <= -Math.PI) a += TAU;
  }
  return a;
}

/** Shortest signed difference `to - from`, in (-PI, PI]. */
export function angleDiff(to: number, from: number): number {
  return wrapAngle(to - from);
}

export function lerpAngle(a: number, b: number, t: number): number {
  return a + angleDiff(b, a) * t;
}

/** Moves `value` towards `target` by at most `maxDelta`. */
export function approach(value: number, target: number, maxDelta: number): number {
  if (value < target) return Math.min(target, value + maxDelta);
  return Math.max(target, value - maxDelta);
}

export function len(x: number, z: number): number {
  return Math.sqrt(x * x + z * z);
}

/** Positive modulo. */
export function mod(a: number, n: number): number {
  const r = a % n;
  return r < 0 ? r + n : r;
}

export function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}
