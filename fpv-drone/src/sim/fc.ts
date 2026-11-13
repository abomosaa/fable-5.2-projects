/**
 * Flight controller - a faithful, compact re-implementation of the parts of
 * Betaflight that shape how a quad feels:
 *
 *   sticks -> RC smoothing -> "Actual" rates -> rate setpoint
 *   gyro (noise + low-pass) -> PID with feed-forward, I-term relax, D on measurement,
 *   TPA -> Quad-X mixer with air mode -> ESC duty.
 *
 * PID gains use Betaflight's numeric scaling, so numbers from a real tune mean
 * the same thing here. ACRO (rate) is the real FPV mode; ANGLE and HORIZON
 * self-level like the real firmware and are there as training wheels.
 *
 * Axis conventions inside the controller (pilot view):
 *   roll  + = right wing down,  pitch + = nose down (stick forward),  yaw + = nose right.
 * In body rates (x right, y up, z back) that is roll = -wz, pitch = -wx, yaw = -wy.
 */
import { Quat, RAD2DEG, clamp, Rng, attitudeFromQuat, Attitude } from './math';
import { DroneTune, PidGains } from './params';

export type FlightMode = 'acro' | 'angle' | 'horizon';

export interface AxisRates {
  /** Centre sensitivity [deg/s] at full stick if the response were linear. */
  center: number;
  /** Rate at full stick deflection [deg/s]. */
  max: number;
  /** 0..1 */
  expo: number;
}

export interface FcConfig {
  rates: { roll: AxisRates; pitch: AxisRates; yaw: AxisRates };
  pid: DroneTune;
  mode: FlightMode;
  /** Maximum bank angle in ANGLE mode [deg]. */
  angleLimit: number;
  /** Self-level strength (Betaflight "angle P" / 10): deg/s of correction per deg of error. */
  levelGain: number;
  airmode: boolean;
  /** Motor idle as a fraction of full scale (DShot idle). */
  idle: number;
  /** Throttle curve: stick position that gives hover-ish mid point and expo 0..1. */
  throttleMid: number;
  throttleExpo: number;
  /** Scales the top of the throttle range (0..1), like Betaflight's throttle limit (scale). */
  throttleLimit: number;
  /** RC smoothing cutoff [Hz] for setpoints. */
  rcSmoothingHz: number;
  /** Power used in crash-flip ("turtle") mode, 0..1. */
  turtlePower: number;
}

export const DEFAULT_RATES: FcConfig['rates'] = {
  roll: { center: 180, max: 720, expo: 0.45 },
  pitch: { center: 180, max: 720, expo: 0.45 },
  yaw: { center: 160, max: 600, expo: 0.35 },
};

export function defaultFcConfig(pid: DroneTune): FcConfig {
  return {
    rates: JSON.parse(JSON.stringify(DEFAULT_RATES)),
    pid: JSON.parse(JSON.stringify(pid)),
    mode: 'acro',
    angleLimit: 55,
    levelGain: 5,
    airmode: true,
    idle: 0.055,
    throttleMid: 0.5,
    throttleExpo: 0,
    throttleLimit: 1,
    rcSmoothingHz: 30,
    turtlePower: 0.45,
  };
}

/** Betaflight "Actual" rates: deg/s for a stick position x in [-1, 1]. */
export function actualRate(x: number, r: AxisRates): number {
  const ax = Math.abs(x);
  const expof = ax * (Math.pow(x, 5) * r.expo + x * (1 - r.expo));
  const stickMovement = Math.max(0, r.max - r.center);
  return x * r.center + stickMovement * expof;
}

/** Betaflight throttle curve (mid/expo). */
export function throttleCurve(t: number, mid: number, expo: number): number {
  if (expo <= 0) return t;
  const tmp = t - mid;
  let y = 1;
  if (tmp > 0) y = 1 - mid;
  else if (tmp < 0) y = mid;
  if (y <= 0) return t;
  return clamp(mid + tmp * (1 - expo + (expo * (tmp * tmp)) / (y * y)), 0, 1);
}

// Betaflight PID scaling constants.
const PTERM_SCALE = 0.032029;
const ITERM_SCALE = 0.244381;
const DTERM_SCALE = 0.000529;
const FF_SCALE = 0.013754 / 100;
const PID_MIXER_SCALING = 1000;
const PIDSUM_LIMIT = 500;
const PIDSUM_LIMIT_YAW = 400;
const ITERM_LIMIT = 400;
const ITERM_RELAX_CUTOFF = 15; // Hz
const ITERM_RELAX_THRESHOLD = 40; // deg/s
const TPA_RATE = 0.65;
const TPA_BREAKPOINT = 0.35;

// Quad-X mixer, motor order RR, FR, RL, FL (Betaflight motors 1..4, props-in).
const MIX_ROLL = [-1, -1, 1, 1];
const MIX_PITCH = [1, -1, 1, -1];
const MIX_YAW = [-1, 1, 1, -1];

class Pt1 {
  y = 0;
  private k = 1;
  constructor(cutHz: number, dt: number) {
    this.set(cutHz, dt);
  }
  set(cutHz: number, dt: number): void {
    const rc = 1 / (2 * Math.PI * cutHz);
    this.k = dt / (rc + dt);
  }
  apply(x: number): number {
    this.y += this.k * (x - this.y);
    return this.y;
  }
  reset(v = 0): void {
    this.y = v;
  }
}

/** Third-order low-pass (three cascaded PT1 with corrected cutoff) as in Betaflight's PT3. */
class Pt3 {
  private a = new Pt1(1, 1);
  private b = new Pt1(1, 1);
  private c = new Pt1(1, 1);
  constructor(cutHz: number, dt: number) {
    this.set(cutHz, dt);
  }
  set(cutHz: number, dt: number): void {
    const f = cutHz * 1.961459177; // 1 / sqrt(2^(1/3) - 1)
    this.a.set(f, dt);
    this.b.set(f, dt);
    this.c.set(f, dt);
  }
  apply(x: number): number {
    return this.c.apply(this.b.apply(this.a.apply(x)));
  }
  reset(v = 0): void {
    this.a.reset(v);
    this.b.reset(v);
    this.c.reset(v);
  }
}

export interface RcInput {
  /** -1..1, + = right */
  roll: number;
  /** -1..1, + = stick forward (nose down) */
  pitch: number;
  /** -1..1, + = right */
  yaw: number;
  /** 0..1 */
  throttle: number;
}

export type ArmBlock = '' | 'THROTTLE' | 'ANGLE' | 'CRASHED';

export class FlightController {
  cfg: FcConfig;
  armed = false;
  /** Crash-flip mode: sticks spin selected motors in reverse to turn the quad over. */
  turtle = false;
  /** Signed ESC duty per motor, order RR, FR, RL, FL. */
  readonly motors = [0, 0, 0, 0];
  /** Rate setpoint [deg/s]: roll, pitch, yaw. */
  readonly setpoint = [0, 0, 0];
  /** Filtered gyro [deg/s]: roll, pitch, yaw. */
  readonly gyro = [0, 0, 0];
  readonly pTerm = [0, 0, 0];
  readonly iTerm = [0, 0, 0];
  readonly dTerm = [0, 0, 0];
  readonly fTerm = [0, 0, 0];
  /** Throttle after curve/limit, 0..1. */
  throttle = 0;
  /** Roll / pitch estimates [deg] (for OSD). */
  readonly attitude: Attitude = { heading: 0, pitch: 0, roll: 0 };

  private readonly dt: number;
  private readonly rng = new Rng(987654321);
  private readonly gyroLpf: Pt1[];
  private readonly dLpf1: Pt1[];
  private readonly dLpf2: Pt1[];
  private readonly spLpf: Pt3[];
  private readonly thrLpf: Pt3;
  private readonly relaxLpf: Pt1[];
  private readonly prevGyro = [0, 0, 0];
  private readonly prevSp = [0, 0, 0];
  private readonly ffLpf: Pt1[];
  private readonly mix = [0, 0, 0, 0];

  /** Gyro white-noise density [deg/s per sqrt(Hz)] and vibration coupling. */
  gyroNoise = 0.012;
  /** Mean rotor speed fraction 0..1, set by the simulation, scales vibration noise. */
  vibration = 0;

  constructor(cfg: FcConfig, dt: number) {
    this.cfg = cfg;
    this.dt = dt;
    this.gyroLpf = [0, 1, 2].map(() => new Pt1(300, dt));
    this.dLpf1 = [0, 1, 2].map(() => new Pt1(110, dt));
    this.dLpf2 = [0, 1, 2].map(() => new Pt1(160, dt));
    this.spLpf = [0, 1, 2].map(() => new Pt3(cfg.rcSmoothingHz, dt));
    this.thrLpf = new Pt3(cfg.rcSmoothingHz, dt);
    this.relaxLpf = [0, 1, 2].map(() => new Pt1(ITERM_RELAX_CUTOFF, dt));
    this.ffLpf = [0, 1, 2].map(() => new Pt1(60, dt));
  }

  setRcSmoothing(hz: number): void {
    this.cfg.rcSmoothingHz = hz;
    for (const f of this.spLpf) f.set(hz, this.dt);
    this.thrLpf.set(hz, this.dt);
  }

  reset(): void {
    this.armed = false;
    this.turtle = false;
    for (let i = 0; i < 3; i++) {
      this.gyroLpf[i].reset();
      this.dLpf1[i].reset();
      this.dLpf2[i].reset();
      this.spLpf[i].reset();
      this.relaxLpf[i].reset();
      this.ffLpf[i].reset();
      this.prevGyro[i] = 0;
      this.prevSp[i] = 0;
      this.setpoint[i] = 0;
      this.pTerm[i] = this.iTerm[i] = this.dTerm[i] = this.fTerm[i] = 0;
    }
    this.thrLpf.reset();
    this.motors.fill(0);
    this.throttle = 0;
  }

  /** Why arming is currently refused ('' = OK to arm). */
  armBlock(rc: RcInput, q: Quat): ArmBlock {
    if (rc.throttle > 0.05) return 'THROTTLE';
    if (!this.turtle) {
      const upY = 1 - 2 * (q.x * q.x + q.z * q.z);
      if (upY < Math.cos((25 * Math.PI) / 180)) return 'ANGLE';
    }
    return '';
  }

  arm(rc: RcInput, q: Quat): ArmBlock {
    const b = this.armBlock(rc, q);
    if (b === '') {
      this.armed = true;
      for (let i = 0; i < 3; i++) this.iTerm[i] = 0;
    }
    return b;
  }

  disarm(): void {
    this.armed = false;
    this.motors.fill(0);
    for (let i = 0; i < 3; i++) this.iTerm[i] = 0;
  }

  /**
   * One PID-loop iteration.
   * @param wx,wy,wz true body rates [rad/s]
   * @param q        true attitude (an ideal attitude estimate is assumed)
   */
  update(wx: number, wy: number, wz: number, q: Quat, rc: RcInput): void {
    const cfg = this.cfg, dt = this.dt;

    // ---- gyro: sensor noise + vibration, then low-pass ---------------------------
    const sigma = (this.gyroNoise + 0.05 * this.vibration * this.vibration) * Math.sqrt(0.5 / dt);
    const raw0 = -wz * RAD2DEG + sigma * this.rng.gauss();
    const raw1 = -wx * RAD2DEG + sigma * this.rng.gauss();
    const raw2 = -wy * RAD2DEG + sigma * this.rng.gauss();
    const g = this.gyro;
    g[0] = this.gyroLpf[0].apply(raw0);
    g[1] = this.gyroLpf[1].apply(raw1);
    g[2] = this.gyroLpf[2].apply(raw2);

    attitudeFromQuat(q, this.attitude);

    // ---- setpoints ----------------------------------------------------------------
    const sp = this.setpoint;
    let spRoll = actualRate(rc.roll, cfg.rates.roll);
    let spPitch = actualRate(rc.pitch, cfg.rates.pitch);
    const spYaw = actualRate(rc.yaw, cfg.rates.yaw);

    if (cfg.mode !== 'acro') {
      const rollDeg = this.attitude.roll * RAD2DEG;
      const pitchDownDeg = -this.attitude.pitch * RAD2DEG;
      const lvlRoll = (rc.roll * cfg.angleLimit - rollDeg) * cfg.levelGain;
      const lvlPitch = (rc.pitch * cfg.angleLimit - pitchDownDeg) * cfg.levelGain;
      if (cfg.mode === 'angle') {
        spRoll = lvlRoll;
        spPitch = lvlPitch;
      } else {
        // Horizon: self-level near centre stick, pure rate at full deflection.
        const s = Math.max(Math.abs(rc.roll), Math.abs(rc.pitch));
        const lvl = clamp(1 - s * 1.3, 0, 1);
        // Inverted: let the pilot finish the flip rather than fight it.
        const upY = 1 - 2 * (q.x * q.x + q.z * q.z);
        const k = lvl * (upY > 0 ? 1 : 0);
        spRoll += lvlRoll * k;
        spPitch += lvlPitch * k;
      }
    }
    sp[0] = this.spLpf[0].apply(spRoll);
    sp[1] = this.spLpf[1].apply(spPitch);
    sp[2] = this.spLpf[2].apply(spYaw);

    let thr = throttleCurve(clamp(rc.throttle, 0, 1), cfg.throttleMid, cfg.throttleExpo) * cfg.throttleLimit;
    thr = clamp(this.thrLpf.apply(thr), 0, 1);
    this.throttle = thr;

    if (!this.armed) {
      this.motors.fill(0);
      for (let i = 0; i < 3; i++) {
        this.prevGyro[i] = g[i];
        this.prevSp[i] = sp[i];
        this.iTerm[i] = 0;
      }
      return;
    }

    if (this.turtle) {
      this.crashFlip(rc);
      return;
    }

    // ---- PID ---------------------------------------------------------------------
    const tpa = 1 - TPA_RATE * clamp((thr - TPA_BREAKPOINT) / (1 - TPA_BREAKPOINT), 0, 1);
    const gains: PidGains[] = [cfg.pid.roll, cfg.pid.pitch, cfg.pid.yaw];
    const pidSum = [0, 0, 0];
    for (let a = 0; a < 3; a++) {
      const k = gains[a];
      const err = sp[a] - g[a];
      this.pTerm[a] = k.p * PTERM_SCALE * err;

      // I-term relax: stop accumulating while the setpoint is moving quickly.
      const spLp = this.relaxLpf[a].apply(sp[a]);
      const spHp = Math.abs(sp[a] - spLp);
      const relax = a < 2 ? Math.max(0, 1 - spHp / ITERM_RELAX_THRESHOLD) : 1;
      this.iTerm[a] = clamp(this.iTerm[a] + k.i * ITERM_SCALE * err * relax * dt, -ITERM_LIMIT, ITERM_LIMIT);

      // D on measurement, two cascaded low-pass filters.
      const dGyro = (g[a] - this.prevGyro[a]) / dt;
      this.prevGyro[a] = g[a];
      const dF = this.dLpf2[a].apply(this.dLpf1[a].apply(dGyro));
      this.dTerm[a] = -k.d * DTERM_SCALE * dF * tpa;

      // Feed-forward from setpoint rate of change.
      const dSp = this.ffLpf[a].apply((sp[a] - this.prevSp[a]) / dt);
      this.prevSp[a] = sp[a];
      this.fTerm[a] = k.f * FF_SCALE * dSp;

      const lim = a === 2 ? PIDSUM_LIMIT_YAW : PIDSUM_LIMIT;
      pidSum[a] = clamp(this.pTerm[a] + this.iTerm[a] + this.dTerm[a] + this.fTerm[a], -lim, lim) / PID_MIXER_SCALING;
    }

    // ---- mixer (Betaflight "legacy" air-mode mixer) --------------------------------
    const mix = this.mix;
    let mn = Infinity, mx = -Infinity;
    for (let i = 0; i < 4; i++) {
      const v = pidSum[0] * MIX_ROLL[i] + pidSum[1] * MIX_PITCH[i] + pidSum[2] * MIX_YAW[i];
      mix[i] = v;
      if (v < mn) mn = v;
      if (v > mx) mx = v;
    }
    const range = mx - mn;
    let throttle = thr;
    if (!cfg.airmode && thr < 0.02) {
      // No air mode: at zero throttle the motors just idle and the I-term is held at zero.
      for (let i = 0; i < 4; i++) this.motors[i] = cfg.idle;
      for (let a = 0; a < 3; a++) this.iTerm[a] = 0;
      return;
    }
    if (range > 1) {
      for (let i = 0; i < 4; i++) mix[i] /= range;
      mn /= range;
      mx /= range;
      throttle = clamp(throttle, -mn, 1 - mx);
    } else if (cfg.airmode || throttle > 0.5) {
      throttle = clamp(throttle, -mn, 1 - mx);
    }
    for (let i = 0; i < 4; i++) {
      const m = clamp(throttle + mix[i], 0, 1);
      this.motors[i] = cfg.idle + (1 - cfg.idle) * m;
    }
  }

  /** Betaflight crash-flip: the stick picks the side whose motors spin in reverse. */
  private crashFlip(rc: RcInput): void {
    const defl = Math.max(Math.abs(rc.roll), Math.abs(rc.pitch));
    const dead = 0.2;
    if (defl < dead) {
      this.motors.fill(0);
      return;
    }
    const power = this.cfg.turtlePower * clamp((defl - dead) / (1 - dead), 0, 1);
    const sr = Math.abs(rc.roll) > dead ? (rc.roll < 0 ? 1 : -1) : 0;
    const sp = Math.abs(rc.pitch) > dead ? (rc.pitch < 0 ? 1 : -1) : 0;
    for (let i = 0; i < 4; i++) {
      const sel = MIX_ROLL[i] * sr + MIX_PITCH[i] * sp;
      this.motors[i] = sel > 0 ? -power : 0;
    }
  }
}
