/**
 * Practice bots. A bot only produces a `CarInput`, exactly like a human, and
 * is driven through the same vehicle model on the server.
 *
 * Driving: a pre-computed racing line (shortest path inside the road) with a
 * curvature-limited speed profile and braking zones, followed with pure
 * pursuit steering, traction management, simple overtaking and recovery when
 * stuck.
 */
import { clamp, mod } from './math';
import { Rng } from './rng';
import { arcDelta, segmentAt, type Track } from './track';
import { GRAVITY, VEHICLE, maxSteerAngle, type CarInput, type CarState } from './vehicle';

export interface BotLine {
  /** Lateral offset of the racing line at each centre line sample. */
  offset: Float64Array;
  /** Target speed at each sample (m/s). */
  speed: Float64Array;
}

const lines = new WeakMap<Track, BotLine>();

export function getBotLine(track: Track): BotLine {
  let line = lines.get(track);
  if (!line) {
    line = computeLine(track);
    lines.set(track, line);
  }
  return line;
}

function computeLine(track: Track): BotLine {
  const n = track.n;
  const offset = new Float64Array(n);
  const maxOffset = Math.max(0, track.halfWidth - 2.1);
  const lx = new Float64Array(n);
  const lz = new Float64Array(n);
  const place = (i: number): void => {
    lx[i] = track.px[i]! + track.tz[i]! * offset[i]!;
    lz[i] = track.pz[i]! - track.tx[i]! * offset[i]!;
  };
  for (let i = 0; i < n; i++) place(i);

  // "Rubber band" relaxation at decreasing scales: pulls the line taut inside
  // the road, which cuts apexes and straightens esses.
  for (const k of [12, 6, 3, 1]) {
    for (let iter = 0; iter < 140; iter++) {
      for (let i = 0; i < n; i++) {
        const a = mod(i - k, n);
        const b = (i + k) % n;
        const mx = (lx[a]! + lx[b]!) * 0.5;
        const mz = (lz[a]! + lz[b]!) * 0.5;
        const want = (mx - track.px[i]!) * track.tz[i]! - (mz - track.pz[i]!) * track.tx[i]!;
        offset[i] = clamp(offset[i]! + (want - offset[i]!) * 0.5, -maxOffset, maxOffset);
        place(i);
      }
    }
  }
  // Keep a margin: a fully taut line clips the inside edge too tightly.
  for (let i = 0; i < n; i++) {
    offset[i] = offset[i]! * 0.8;
    place(i);
  }

  // Curvature of the line itself, then a speed limit and braking zones.
  const speed = new Float64Array(n);
  const span = 3;
  const mu = track.def.surface.grip;
  for (let i = 0; i < n; i++) {
    const a = mod(i - span, n);
    const b = (i + span) % n;
    const ax = lx[i]! - lx[a]!;
    const az = lz[i]! - lz[a]!;
    const bx = lx[b]! - lx[i]!;
    const bz = lz[b]! - lz[i]!;
    const la = Math.hypot(ax, az) || 1;
    const lb = Math.hypot(bx, bz) || 1;
    const cross = (az * bx - ax * bz) / (la * lb);
    const dot = (ax * bx + az * bz) / (la * lb);
    const curvature = Math.abs(Math.atan2(cross, dot)) / ((la + lb) * 0.5);
    // Downforce raises the limit a little at speed; solved approximately.
    const base = Math.sqrt((mu * GRAVITY * 0.9) / Math.max(curvature, 1e-4));
    speed[i] = Math.min(82, base * (1 + Math.min(0.12, base * 0.0016)));
  }
  const decel = mu * GRAVITY * 0.72;
  for (let pass = 0; pass < 2; pass++) {
    for (let i = n - 1; i >= 0; i--) {
      const next = (i + 1) % n;
      const reachable = Math.sqrt(speed[next]! * speed[next]! + 2 * decel * track.segLen[i]!);
      if (speed[i]! > reachable) speed[i] = reachable;
    }
  }
  return { offset, speed };
}

export interface BotProfile {
  /** 0 (cautious) .. 1 (fast). */
  skill: number;
  /** Preferred lateral bias in metres, to spread bots across the road. */
  lane: number;
}

/** What a bot needs to know about itself. */
export interface BotSelf {
  slot: number;
  state: Readonly<CarState>;
  /** Arc length and lateral offset of the car on the track. */
  s: number;
  lat: number;
}

export interface BotOther {
  slot: number;
  s: number;
  lat: number;
  speed: number;
}

export function botProfileFor(slot: number, skill: number): BotProfile {
  const rng = new Rng(0xb07 + slot * 7919);
  return {
    skill: clamp(skill + rng.range(-0.06, 0.06), 0, 1),
    lane: rng.range(-1.1, 1.1),
  };
}

export class BotDriver {
  private readonly track: Track;
  private readonly line: BotLine;
  private readonly profile: BotProfile;
  private readonly rng: Rng;
  private readonly out: CarInput = { steer: 0, throttle: 0, brake: 0, handbrake: false, reset: false };
  private reaction: number;
  private avoid = 0;
  private stuckTicks = 0;
  private reverseTicks = 0;
  private wrongWayTicks = 0;
  private recoveries = 0;
  private wobble = 0;

  constructor(track: Track, profile: BotProfile, seed: number) {
    this.track = track;
    this.line = getBotLine(track);
    this.profile = profile;
    this.rng = new Rng(seed);
    this.reaction = Math.round(this.rng.range(6, 22) * (1.4 - profile.skill * 0.6));
  }

  /**
   * Computes the input for the next tick.
   * @param pace Optional pace multiplier (used for the cool-down lap).
   */
  compute(self: BotSelf, others: readonly BotOther[], pace = 1): CarInput {
    const { track, line, out } = this;
    const st = self.state;
    out.steer = 0;
    out.throttle = 0;
    out.brake = 0;
    out.handbrake = false;
    out.reset = false;
    if (st.frozen > 0) return out;
    if (this.reaction > 0) {
      this.reaction--;
      return out;
    }

    const sinY = Math.sin(st.yaw);
    const cosY = Math.cos(st.yaw);
    const u = st.vx * sinY + st.vz * cosY;
    const w = st.vx * cosY - st.vz * sinY;
    const speed = Math.sqrt(st.vx * st.vx + st.vz * st.vz);

    // --- Traffic: pick a side to pass slower cars and avoid ramming them.
    let avoidTarget = 0;
    let lift = 0;
    for (const other of others) {
      if (other.slot === self.slot) continue;
      const ahead = arcDelta(track, other.s, self.s);
      if (ahead <= 0.5 || ahead > 14 + speed * 0.35) continue;
      const side = other.lat - self.lat;
      if (Math.abs(side) > 2.6) continue;
      const push = side >= 0 ? -2.8 : 2.8;
      if (Math.abs(push) > Math.abs(avoidTarget)) avoidTarget = push;
      if (ahead < 7 && Math.abs(side) < 1.9 && speed > other.speed + 0.5) {
        lift = Math.max(lift, clamp((speed - other.speed) / 6, 0.2, 1));
      }
    }
    this.avoid += clamp(avoidTarget - this.avoid, -0.08, 0.08);

    // --- Steering: pure pursuit towards a point on the racing line.
    const lookahead = clamp(5.5 + speed * 0.4, 7.5, 34);
    const idx = segmentAt(track, self.s + lookahead);
    const limit = track.halfWidth - 1.3;
    this.wobble += (this.rng.next() - 0.5) * 0.02 * (1.2 - this.profile.skill);
    this.wobble = clamp(this.wobble * 0.995, -0.6, 0.6);
    const lat = clamp(line.offset[idx]! + this.profile.lane * 0.6 + this.avoid + this.wobble, -limit, limit);
    const tx = track.px[idx]! + track.tz[idx]! * lat - st.x;
    const tz = track.pz[idx]! - track.tx[idx]! * lat - st.z;
    const forward = tx * sinY + tz * cosY;
    const left = tx * cosY - tz * sinY;
    const alpha = Math.atan2(left, Math.max(forward, 0.01));
    const dist = Math.sqrt(tx * tx + tz * tz) || 1;
    const wheelbase = VEHICLE.cgToFront + VEHICLE.cgToRear;
    const delta = Math.atan((2 * wheelbase * Math.sin(alpha)) / dist);
    let steer = clamp(-delta / maxSteerAngle(u, w), -1, 1);

    // --- Speed: follow the profile a little ahead of the car.
    const sIdx = segmentAt(track, self.s + 2 + speed * 0.22);
    const skillPace = 0.76 + this.profile.skill * 0.22;
    const target = line.speed[sIdx]! * skillPace * pace;
    const error = target - u;
    let throttle = 0;
    let brake = 0;
    if (error > 1.5) throttle = 1;
    else if (error > -1) throttle = clamp(0.35 + error * 0.4, 0, 1);
    else brake = clamp(-error / 7, 0.12, 1);

    // Traction management: ease off when sliding or pointing the wrong way.
    const slide = Math.abs(w);
    if (slide > 2.2 + speed * 0.04) throttle *= 0.35;
    if (Math.abs(alpha) > 0.55) throttle *= 0.5;
    if (lift > 0) {
      throttle *= 1 - lift;
      if (lift > 0.6) brake = Math.max(brake, 0.3);
    }

    // --- Recovery: reverse out when stuck, reset when hopeless.
    const headingAlong = sinY * track.tx[segmentAt(track, self.s)]! + cosY * track.tz[segmentAt(track, self.s)]!;
    this.wrongWayTicks = headingAlong < -0.2 ? this.wrongWayTicks + 1 : 0;
    if (this.reverseTicks > 0) {
      this.reverseTicks--;
      throttle = 0;
      brake = 1;
      steer = -steer;
      if (this.reverseTicks === 0) this.stuckTicks = 0;
    } else if (speed < 1.2 && pace >= 1) {
      this.stuckTicks++;
      if (this.stuckTicks > 75) {
        this.recoveries++;
        if (this.recoveries >= 3) {
          out.reset = true;
          this.recoveries = 0;
          this.stuckTicks = 0;
        } else {
          this.reverseTicks = 55;
        }
      }
    } else if (speed > 6) {
      this.stuckTicks = 0;
      if (speed > 14) this.recoveries = 0;
    }
    if (this.wrongWayTicks > 150) {
      out.reset = true;
      this.wrongWayTicks = 0;
    }

    out.steer = Math.round(steer * 127);
    out.throttle = Math.round(clamp(throttle, 0, 1) * 255);
    out.brake = Math.round(clamp(brake, 0, 1) * 255);
    return out;
  }
}
