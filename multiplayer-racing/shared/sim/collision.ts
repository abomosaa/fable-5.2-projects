/**
 * Car-to-car collisions. Each car is two circles along its heading; overlapping
 * circles are separated and exchange an impulse (with a damped angular part so
 * taps nudge rather than spin).
 */
import { VEHICLE, type CarState } from './vehicle';

const RESTITUTION = 0.25;
const ANGULAR_SCALE = 0.45;

/**
 * Resolves contact between two cars.
 *
 * `moveA`/`moveB` select which bodies respond. The server passes `true` for
 * both; a predicting client resolves its own car against a remote one with
 * `moveB = false`, which yields the same response for the local car.
 *
 * Returns -1 when the cars do not touch, otherwise the closing speed of the
 * hardest contact (0 for a resting/separating contact).
 */
export function collideCars(a: CarState, b: CarState, moveA: boolean, moveB: boolean): number {
  const P = VEHICLE;
  const reach = P.circleOffset * 2 + P.circleRadius * 2;
  const ddx = a.x - b.x;
  const ddz = a.z - b.z;
  if (ddx * ddx + ddz * ddz > reach * reach) return -1;

  const minDist = P.circleRadius * 2;
  let impact = -1;
  for (let i = 0; i < 2; i++) {
    for (let j = 0; j < 2; j++) {
      const oa = i === 0 ? P.circleOffset : -P.circleOffset;
      const ob = j === 0 ? P.circleOffset : -P.circleOffset;
      const rax = Math.sin(a.yaw) * oa;
      const raz = Math.cos(a.yaw) * oa;
      const rbx = Math.sin(b.yaw) * ob;
      const rbz = Math.cos(b.yaw) * ob;
      let dx = a.x + rax - (b.x + rbx);
      let dz = a.z + raz - (b.z + rbz);
      const distSq = dx * dx + dz * dz;
      if (distSq >= minDist * minDist) continue;
      let dist = Math.sqrt(distSq);
      if (dist < 1e-6) {
        // Perfectly coincident circles: separate along a fixed axis.
        dx = 1;
        dz = 0;
        dist = 1;
      }
      const nx = dx / dist;
      const nz = dz / dist;
      const pen = minDist - (distSq < 1e-12 ? 0 : dist);
      if (impact < 0) impact = 0;

      // Positional correction, split evenly.
      if (moveA) {
        a.x += nx * pen * 0.5;
        a.z += nz * pen * 0.5;
      }
      if (moveB) {
        b.x -= nx * pen * 0.5;
        b.z -= nz * pen * 0.5;
      }

      // Relative velocity of the contact points along the normal.
      const vax = a.vx + a.yawRate * raz;
      const vaz = a.vz - a.yawRate * rax;
      const vbx = b.vx + b.yawRate * rbz;
      const vbz = b.vz - b.yawRate * rbx;
      const vn = (vax - vbx) * nx + (vaz - vbz) * nz;
      if (vn >= 0) continue;
      if (-vn > impact) impact = -vn;

      const ran = raz * nx - rax * nz;
      const rbn = rbz * nx - rbx * nz;
      const inv =
        2 / P.mass + (ran * ran * ANGULAR_SCALE) / P.inertia + (rbn * rbn * ANGULAR_SCALE) / P.inertia;
      const jn = (-(1 + RESTITUTION) * vn) / inv;
      if (moveA) {
        a.vx += (jn * nx) / P.mass;
        a.vz += (jn * nz) / P.mass;
        a.yawRate += (ran * jn * ANGULAR_SCALE) / P.inertia;
      }
      if (moveB) {
        b.vx -= (jn * nx) / P.mass;
        b.vz -= (jn * nz) / P.mass;
        b.yawRate -= (rbn * jn * ANGULAR_SCALE) / P.inertia;
      }
    }
  }
  return impact;
}
