/**
 * Remote entity interpolation.
 *
 * Remote cars are rendered slightly in the past, between two authoritative
 * snapshots. `ArrivalClock` turns jittery snapshot arrival times into a smooth
 * timeline and sizes the interpolation delay from the jitter it observes.
 * `CarTrack` stores a short history per car and samples it with bounded
 * extrapolation, so a late snapshot produces a brief hold instead of a car
 * flying off into the distance.
 *
 * This module is free of DOM and network dependencies so it can be tested.
 */
import { SIM_HZ } from '../../../shared/constants';
import { CarFlag, VEL_SCALE, YAW_RATE_SCALE, YAW_SCALE, type QCar } from '../../../shared/protocol/binary';
import { clamp, lerp, lerpAngle } from '../../../shared/sim/math';

/** Longest time a remote car is extrapolated past its newest snapshot. */
export const MAX_EXTRAPOLATION_TICKS = 12;
/** Unexplained positional jumps beyond this are teleports (resets), never interpolated. */
export const TELEPORT_DISTANCE = 18;
const HISTORY_TICKS = 90;
const MAX_SAMPLES = 64;
const WINDOW = 48;
/** Consecutive far-too-late snapshots after which the timeline is rebuilt. */
const RESYNC_AFTER = 20;

export class ArrivalClock {
  /** Interpolation delay currently in use, in ticks. */
  delayTicks: number;
  /** Recent worst-case lateness of snapshots relative to the fastest path, in ticks. */
  latenessTicks = 0;
  private readonly ticksPerMs: number;
  private readonly minDelay: number;
  private readonly maxDelay: number;
  private readonly samples: number[] = [];
  private offset = 0;
  private hasOffset = false;
  private outliers = 0;

  constructor(
    tickRate: number,
    private readonly snapshotEvery: number,
  ) {
    this.ticksPerMs = tickRate / 1000;
    this.minDelay = snapshotEvery + 1;
    this.maxDelay = Math.max(this.minDelay + 1, tickRate * 0.5);
    this.delayTicks = snapshotEvery * 1.5 + 1;
  }

  get ready(): boolean {
    return this.hasOffset;
  }

  /** Feeds the arrival of the newest snapshot (tick) at local time `nowMs`. */
  observe(tick: number, nowMs: number): void {
    const sample = tick - nowMs * this.ticksPerMs;
    if (this.hasOffset && this.offset - sample > this.maxDelay) {
      // Far too late to be jitter: the backlog of a stalled connection being
      // delivered in one go. Ignore it (the tail of the burst is on time)
      // unless it persists, which means the path itself changed.
      if (++this.outliers < RESYNC_AFTER) return;
      this.reset();
    }
    this.outliers = 0;
    this.samples.push(sample);
    if (this.samples.length > WINDOW) this.samples.shift();
    // The timeline follows the fastest recent deliveries; slower ones count as lateness.
    let base = -Infinity;
    for (const s of this.samples) if (s > base) base = s;
    if (!this.hasOffset || Math.abs(base - this.offset) > this.maxDelay * 2) {
      this.offset = base;
      this.hasOffset = true;
    } else {
      // Slew instead of stepping so the render time never jumps.
      this.offset += clamp(base - this.offset, -0.25, 0.25);
    }
    const lateness = Math.max(0, base - sample);
    this.latenessTicks = Math.max(this.latenessTicks * 0.985, lateness);
    const target = clamp(this.snapshotEvery * 1.5 + 1 + this.latenessTicks, this.minDelay, this.maxDelay);
    this.delayTicks += (target - this.delayTicks) * 0.06;
  }

  /** Tick of the snapshot that would be arriving right now. */
  arrivalTick(nowMs: number): number {
    return this.offset + nowMs * this.ticksPerMs;
  }

  /** Tick at which remote entities should be rendered. */
  renderTick(nowMs: number): number {
    return this.arrivalTick(nowMs) - this.delayTicks;
  }

  reset(): void {
    this.samples.length = 0;
    this.hasOffset = false;
    this.latenessTicks = 0;
    this.outliers = 0;
  }
}

export interface CarSample {
  tick: number;
  x: number;
  z: number;
  yaw: number;
  vx: number;
  vz: number;
  yawRate: number;
  steer: number;
  throttle: number;
  brake: number;
  flags: number;
}

export interface CarPose {
  x: number;
  z: number;
  yaw: number;
  vx: number;
  vz: number;
  yawRate: number;
  steer: number;
  throttle: number;
  brake: number;
  flags: number;
  /** Ticks extrapolated beyond the newest sample (0 when interpolating). */
  extrapolated: number;
  /** True when the car is held because data is too old to extrapolate. */
  stale: boolean;
}

export function makePose(): CarPose {
  return {
    x: 0,
    z: 0,
    yaw: 0,
    vx: 0,
    vz: 0,
    yawRate: 0,
    steer: 0,
    throttle: 0,
    brake: 0,
    flags: 0,
    extrapolated: 0,
    stale: false,
  };
}

export function sampleFromQCar(tick: number, q: Readonly<QCar>): CarSample {
  return {
    tick,
    x: q.x,
    z: q.z,
    yaw: q.yaw / YAW_SCALE,
    vx: q.vx / VEL_SCALE,
    vz: q.vz / VEL_SCALE,
    yawRate: q.yawRate / YAW_RATE_SCALE,
    steer: q.steer / 127,
    throttle: q.throttle / 255,
    brake: q.brake / 255,
    flags: q.flags,
  };
}

function isTeleport(a: Readonly<CarSample>, b: Readonly<CarSample>): boolean {
  if ((a.flags ^ b.flags) & CarFlag.RESET_TOGGLE) return true;
  // How far the car is from where its own motion would have carried it. A
  // long gap between samples is not a teleport; an unexplained jump is.
  const dt = (b.tick - a.tick) / SIM_HZ;
  const dx = b.x - a.x - (a.vx + b.vx) * 0.5 * dt;
  const dz = b.z - a.z - (a.vz + b.vz) * 0.5 * dt;
  return dx * dx + dz * dz > TELEPORT_DISTANCE * TELEPORT_DISTANCE;
}

/** Snapshot history of one car, kept sorted by tick. */
export class CarTrack {
  private readonly samples: CarSample[] = [];

  get length(): number {
    return this.samples.length;
  }

  get newestTick(): number {
    return this.samples.length > 0 ? this.samples[this.samples.length - 1]!.tick : -1;
  }

  /** Inserts a sample; duplicates are ignored, out-of-order ones are sorted in. */
  push(sample: CarSample): boolean {
    const list = this.samples;
    let at = list.length;
    while (at > 0 && list[at - 1]!.tick > sample.tick) at--;
    if (at > 0 && list[at - 1]!.tick === sample.tick) return false;
    list.splice(at, 0, sample);
    const newest = list[list.length - 1]!.tick;
    while (list.length > 2 && (list[0]!.tick < newest - HISTORY_TICKS || list.length > MAX_SAMPLES)) list.shift();
    return true;
  }

  clear(): void {
    this.samples.length = 0;
  }

  /** Samples the car at `tick`. Returns false when there is no data at all. */
  sample(tick: number, out: CarPose): boolean {
    const list = this.samples;
    const n = list.length;
    if (n === 0) return false;
    out.extrapolated = 0;
    out.stale = false;

    let hi = n;
    for (let i = n - 1; i >= 0; i--) {
      if (list[i]!.tick <= tick) break;
      hi = i;
    }
    const a = hi > 0 ? list[hi - 1]! : null;
    const b = hi < n ? list[hi]! : null;

    if (a && b) {
      const span = b.tick - a.tick;
      const t = span > 0 ? (tick - a.tick) / span : 0;
      if (isTeleport(a, b)) {
        copySample(t < 0.5 ? a : b, out);
        return true;
      }
      const dt = span / SIM_HZ;
      if (span <= 24) {
        // Cubic Hermite through both samples using their velocities.
        const t2 = t * t;
        const t3 = t2 * t;
        const h00 = 2 * t3 - 3 * t2 + 1;
        const h10 = t3 - 2 * t2 + t;
        const h01 = -2 * t3 + 3 * t2;
        const h11 = t3 - t2;
        out.x = h00 * a.x + h10 * a.vx * dt + h01 * b.x + h11 * b.vx * dt;
        out.z = h00 * a.z + h10 * a.vz * dt + h01 * b.z + h11 * b.vz * dt;
      } else {
        out.x = lerp(a.x, b.x, t);
        out.z = lerp(a.z, b.z, t);
      }
      out.yaw = lerpAngle(a.yaw, b.yaw, t);
      out.vx = lerp(a.vx, b.vx, t);
      out.vz = lerp(a.vz, b.vz, t);
      out.yawRate = lerp(a.yawRate, b.yawRate, t);
      out.steer = lerp(a.steer, b.steer, t);
      out.throttle = lerp(a.throttle, b.throttle, t);
      out.brake = lerp(a.brake, b.brake, t);
      out.flags = t < 0.5 ? a.flags : b.flags;
      return true;
    }

    if (a) {
      // Newer data has not arrived: extrapolate a little, then hold.
      const ahead = tick - a.tick;
      const used = Math.min(ahead, MAX_EXTRAPOLATION_TICKS);
      const dt = used / SIM_HZ;
      copySample(a, out);
      out.x += a.vx * dt;
      out.z += a.vz * dt;
      out.yaw += a.yawRate * dt;
      out.extrapolated = ahead;
      out.stale = ahead > MAX_EXTRAPOLATION_TICKS;
      return true;
    }

    copySample(b!, out);
    return true;
  }
}

function copySample(from: Readonly<CarSample>, out: CarPose): void {
  out.x = from.x;
  out.z = from.z;
  out.yaw = from.yaw;
  out.vx = from.vx;
  out.vz = from.vz;
  out.yawRate = from.yawRate;
  out.steer = from.steer;
  out.throttle = from.throttle;
  out.brake = from.brake;
  out.flags = from.flags;
}
