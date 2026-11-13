/**
 * Deterministic vehicle dynamics.
 *
 * A single-track ("bicycle") model with saturating tyres:
 *  - front and rear axle slip angles produce lateral forces that peak and then
 *    fall off, so the car under/oversteers and drifts when pushed too hard;
 *  - traction and braking share the tyres' grip with cornering;
 *  - the handbrake cuts rear grip to start a slide;
 *  - power-limited engine, aerodynamic drag and a little downforce;
 *  - barriers are rigid-body impulses on two bumper circles, so a glancing
 *    hit rotates the car along the wall instead of stopping it dead.
 *
 * `stepCar` is a pure function of (state, input, track). The server runs it
 * for every car and clients run exactly the same code to predict their own
 * car, so it must never read anything else (no clocks, no randomness).
 */
import { DT } from '../constants';
import { approach, clamp, wrapAngle } from './math';
import { makeQuery, queryTrack, type Track } from './track';

export interface CarState {
  x: number;
  z: number;
  yaw: number;
  vx: number;
  vz: number;
  yawRate: number;
  /** Steering position in [-1, 1]; positive steers right. */
  steer: number;
  /** Ticks left during which the car is held still (grid, respawn). */
  frozen: number;
  /** Ticks left of the reduced-power penalty. */
  penalty: number;
}

export interface CarInput {
  /** Integer in [-127, 127]; positive steers right. */
  steer: number;
  /** Integer in [0, 255]. */
  throttle: number;
  /** Integer in [0, 255]. Brakes, then reverses once stopped. */
  brake: number;
  handbrake: boolean;
  /** Request a reset to the last checkpoint (handled by the race rules). */
  reset: boolean;
}

/** Per-step outputs used for race rules, effects and audio. Not part of the state. */
export interface CarTelemetry {
  /** Arc length of the projection on the centre line. */
  s: number;
  /** Signed lateral offset from the centre line (positive = left). */
  lat: number;
  /** Track direction at the projection. */
  tx: number;
  tz: number;
  /** Signed speed along the car's heading (m/s). */
  forwardSpeed: number;
  /** Speed magnitude (m/s). */
  speed: number;
  /** 0..1 how far the car is onto the run-off. */
  offroad: number;
  /** Rear axle slip, 0 = gripping, >= 1 = sliding. */
  slip: number;
  /** Fraction of drive force lost to wheelspin, 0..1. */
  wheelspin: number;
  /** Speed (m/s) into the barrier for a wall impact this step, else 0. */
  wallHit: number;
}

export const VEHICLE = {
  mass: 1200,
  inertia: 1450,
  cgToFront: 1.25,
  cgToRear: 1.35,
  /** Two collision circles at +/- offset along the heading. */
  circleOffset: 1.2,
  circleRadius: 0.95,
  bodyLength: 4.3,
  bodyWidth: 1.9,

  enginePower: 215_000,
  engineForceMax: 9_600,
  reverseForce: 5_200,
  reverseMaxSpeed: 15,
  dragCoeff: 0.55,
  rollingResistance: 200,
  engineBrake: 650,
  downforce: 1.1,
  /** Share of the weight usable for traction (all-wheel drive, rear biased). */
  tractionShare: 0.82,
  brakeFactor: 1.0,

  tireB: 8.5,
  tireC: 1.42,
  rearGripBias: 1.14,
  handbrakeRearGrip: 0.38,
  handbrakeDrag: 0.45,
  throttleGripLoss: 0.34,
  brakeGripLoss: 0.5,
  /** Below this speed the tyre model blends into a kinematic one. */
  lowSpeed: 5,
  yawDamping: 1400,

  steerMaxLow: 0.56,
  steerBase: 0.085,
  steerSpeedGain: 34,
  steerCounterGain: 0.9,
  steerCounterMax: 0.4,
  steerRate: 4.2,
  steerReturnRate: 7.5,

  offroadDragBase: 2.6,
  offroadDragPerSpeed: 0.13,
  /** Width of the band over which road grip blends into run-off grip. */
  offroadBlend: 1.0,

  penaltyPower: 0.4,
  wallAngularScale: 0.55,
  /** Absolute speed clamp; nothing in the simulation may move faster. */
  maxSpeed: 96,
} as const;

export const GRAVITY = 9.81;
const WHEELBASE = VEHICLE.cgToFront + VEHICLE.cgToRear;
const SUBSTEPS = 2;
const H = DT / SUBSTEPS;

export const NEUTRAL_INPUT: Readonly<CarInput> = Object.freeze({
  steer: 0,
  throttle: 0,
  brake: 0,
  handbrake: false,
  reset: false,
});

export function makeCarState(x = 0, z = 0, yaw = 0): CarState {
  return { x, z, yaw, vx: 0, vz: 0, yawRate: 0, steer: 0, frozen: 0, penalty: 0 };
}

export function copyCarState(from: Readonly<CarState>, to: CarState): CarState {
  to.x = from.x;
  to.z = from.z;
  to.yaw = from.yaw;
  to.vx = from.vx;
  to.vz = from.vz;
  to.yawRate = from.yawRate;
  to.steer = from.steer;
  to.frozen = from.frozen;
  to.penalty = from.penalty;
  return to;
}

export function makeTelemetry(): CarTelemetry {
  return { s: 0, lat: 0, tx: 0, tz: 1, forwardSpeed: 0, speed: 0, offroad: 0, slip: 0, wheelspin: 0, wallHit: 0 };
}

/** Largest front wheel angle (rad) available at a forward speed and body slip. */
export function maxSteerAngle(forwardSpeed: number, lateralSpeed: number): number {
  const absU = Math.abs(forwardSpeed);
  const fade = clamp((absU - 3) / 5, 0, 1);
  const beta = fade * Math.atan2(Math.abs(lateralSpeed), absU + 2);
  const base = VEHICLE.steerBase + VEHICLE.steerSpeedGain / Math.max(forwardSpeed * forwardSpeed, 1);
  return Math.min(VEHICLE.steerMaxLow, base + Math.min(VEHICLE.steerCounterMax, beta * VEHICLE.steerCounterGain));
}

const surfaceQuery = makeQuery();
const wallQuery = makeQuery();
const telemetryQuery = makeQuery();

/** Advances one car by one fixed timestep. */
export function stepCar(c: CarState, input: Readonly<CarInput>, track: Track, tel: CarTelemetry): void {
  const P = VEHICLE;
  const steerIn = clamp(input.steer / 127, -1, 1);
  tel.wallHit = 0;
  tel.wheelspin = 0;
  tel.slip = 0;

  if (c.frozen > 0) {
    c.frozen--;
    c.vx = 0;
    c.vz = 0;
    c.yawRate = 0;
    c.steer = approach(c.steer, steerIn, P.steerRate * DT);
    if (c.penalty > 0) c.penalty--;
    fillTelemetry(c, track, tel);
    return;
  }

  const surface = track.def.surface;
  queryTrack(track, c.x, c.z, surfaceQuery);
  const off = clamp((surfaceQuery.dist - track.halfWidth) / P.offroadBlend, 0, 1);
  const mu = surface.grip + (surface.offroadGrip - surface.grip) * off;
  const throttle = clamp(input.throttle / 255, 0, 1);
  const brake = clamp(input.brake / 255, 0, 1);
  const power = c.penalty > 0 ? P.penaltyPower : 1;

  for (let sub = 0; sub < SUBSTEPS; sub++) {
    const sinY = Math.sin(c.yaw);
    const cosY = Math.cos(c.yaw);
    // Body frame: u along the heading, w to the left.
    const u = c.vx * sinY + c.vz * cosY;
    const w = c.vx * cosY - c.vz * sinY;
    const absU = Math.abs(u);

    // Steering: rate limited, speed sensitive, with extra lock to catch slides.
    const returning = Math.abs(steerIn) < Math.abs(c.steer) || steerIn * c.steer < 0;
    c.steer = approach(c.steer, steerIn, (returning ? P.steerReturnRate : P.steerRate) * H);
    const delta = -c.steer * maxSteerAngle(u, w);

    const weight = P.mass * GRAVITY + P.downforce * u * u;
    const loadFront = weight * (P.cgToRear / WHEELBASE);
    const loadRear = weight * (P.cgToFront / WHEELBASE);
    const maxBrake = mu * weight * P.brakeFactor;
    const tractionCap = mu * weight * P.tractionShare;

    // Longitudinal demand. Brake doubles as reverse once the car has stopped.
    let drive = 0;
    let braking = 0;
    if (throttle > 0) {
      if (u > -0.5) drive += throttle * power * Math.min(P.engineForceMax, P.enginePower / Math.max(absU, 1));
      else braking += throttle * maxBrake;
    }
    if (brake > 0) {
      if (u > 0.5) braking += brake * maxBrake;
      else drive -= brake * power * P.reverseForce * clamp(1 - Math.max(0, -u) / P.reverseMaxSpeed, 0, 1);
    }
    if (braking > maxBrake) braking = maxBrake;
    if (Math.abs(drive) > tractionCap) {
      tel.wheelspin = Math.max(tel.wheelspin, 1 - tractionCap / Math.abs(drive));
      drive = drive > 0 ? tractionCap : -tractionCap;
    }

    // Friction circle: accelerating and braking eat into cornering grip.
    const brakeUse = braking / maxBrake;
    const driveUse = Math.abs(drive) / tractionCap;
    const brakeScale = Math.sqrt(1 - P.brakeGripLoss * brakeUse * brakeUse);
    const capFront = mu * loadFront * brakeScale;
    let capRear = mu * loadRear * P.rearGripBias * brakeScale * Math.sqrt(1 - P.throttleGripLoss * driveUse * driveUse);
    if (input.handbrake) {
      capRear *= P.handbrakeRearGrip;
      braking += P.handbrakeDrag * mu * loadRear;
    }

    // Tyre slip angles and lateral forces.
    const ud = absU > P.lowSpeed ? absU : P.lowSpeed;
    const dir = clamp(u / P.lowSpeed, -1, 1);
    const alphaFront = Math.atan((w + P.cgToFront * c.yawRate) / ud) - delta * dir;
    const alphaRear = Math.atan((w - P.cgToRear * c.yawRate) / ud);
    const fyFront = -capFront * Math.sin(P.tireC * Math.atan(P.tireB * alphaFront));
    const fyRear = -capRear * Math.sin(P.tireC * Math.atan(P.tireB * alphaRear));
    const rearSlip = Math.abs(alphaRear) * P.tireB * 0.5 * clamp(absU / 6, 0, 1);
    if (rearSlip > tel.slip) tel.slip = rearSlip;

    const cosD = Math.cos(delta);
    const sinD = Math.sin(delta);

    // Resistive forces never reverse the direction of travel within a step.
    let resist = braking + P.rollingResistance + (throttle > 0 ? 0 : P.engineBrake);
    resist += off * surface.offroadDrag * P.mass * (P.offroadDragBase + P.offroadDragPerSpeed * absU);
    const stopForce = (P.mass * absU) / H;
    if (resist > stopForce) resist = stopForce;

    const fx = drive - P.dragCoeff * u * absU - fyFront * sinD - (u > 0 ? resist : u < 0 ? -resist : 0);
    const fy = fyFront * cosD + fyRear;
    const mz = P.cgToFront * fyFront * cosD - P.cgToRear * fyRear - P.yawDamping * c.yawRate;

    const ax = fx / P.mass;
    const ay = fy / P.mass;
    c.vx += (ax * sinY + ay * cosY) * H;
    c.vz += (ax * cosY - ay * sinY) * H;
    c.yawRate += (mz / P.inertia) * H;
    c.x += c.vx * H;
    c.z += c.vz * H;
    c.yaw += c.yawRate * H;
  }

  // Clamp and settle.
  const speedSq = c.vx * c.vx + c.vz * c.vz;
  if (speedSq > P.maxSpeed * P.maxSpeed) {
    const k = P.maxSpeed / Math.sqrt(speedSq);
    c.vx *= k;
    c.vz *= k;
  } else if (speedSq < 0.03 && input.throttle === 0 && input.brake === 0 && Math.abs(c.yawRate) < 0.08) {
    c.vx = 0;
    c.vz = 0;
    c.yawRate = 0;
  }
  c.yawRate = clamp(c.yawRate, -7, 7);
  c.yaw = wrapAngle(c.yaw);
  if (c.penalty > 0) c.penalty--;

  const hit = collideWalls(c, track);
  if (hit > 0) tel.wallHit = hit;
  fillTelemetry(c, track, tel);
}

function fillTelemetry(c: CarState, track: Track, tel: CarTelemetry): void {
  const q = queryTrack(track, c.x, c.z, telemetryQuery);
  tel.s = q.s;
  tel.lat = q.lat;
  tel.tx = q.tx;
  tel.tz = q.tz;
  tel.offroad = clamp((q.dist - track.halfWidth) / VEHICLE.offroadBlend, 0, 1);
  tel.forwardSpeed = c.vx * Math.sin(c.yaw) + c.vz * Math.cos(c.yaw);
  tel.speed = Math.sqrt(c.vx * c.vx + c.vz * c.vz);
}

/**
 * Keeps both bumper circles inside the barriers and applies the collision
 * impulse. Returns the largest speed into a wall (0 when there was no impact).
 */
export function collideWalls(c: CarState, track: Track): number {
  const P = VEHICLE;
  const surface = track.def.surface;
  const limit = track.wallDist - P.circleRadius;
  let impact = 0;
  for (let k = 0; k < 2; k++) {
    const offset = k === 0 ? P.circleOffset : -P.circleOffset;
    const rx = Math.sin(c.yaw) * offset;
    const rz = Math.cos(c.yaw) * offset;
    const q = queryTrack(track, c.x + rx, c.z + rz, wallQuery);
    if (q.dist <= limit || q.dist < 1e-6) continue;
    // Outward normal from the centre line through the circle.
    const nx = (c.x + rx - q.cx) / q.dist;
    const nz = (c.z + rz - q.cz) / q.dist;
    const pen = q.dist - limit;
    c.x -= nx * pen;
    c.z -= nz * pen;

    const vpx = c.vx + c.yawRate * rz;
    const vpz = c.vz - c.yawRate * rx;
    const vn = vpx * nx + vpz * nz;
    if (vn <= 0) continue;
    if (vn > impact) impact = vn;

    const rn = rz * nx - rx * nz;
    const invN = 1 / P.mass + (rn * rn * P.wallAngularScale) / P.inertia;
    const j = ((1 + surface.wallRestitution) * vn) / invN;
    c.vx -= (j * nx) / P.mass;
    c.vz -= (j * nz) / P.mass;
    c.yawRate -= (rn * j * P.wallAngularScale) / P.inertia;

    // Scraping friction along the wall, bounded by the normal impulse.
    const tx = -nz;
    const tz = nx;
    const vt = (c.vx + c.yawRate * rz) * tx + (c.vz - c.yawRate * rx) * tz;
    const rt = rz * tx - rx * tz;
    const invT = 1 / P.mass + (rt * rt * P.wallAngularScale) / P.inertia;
    const jt = clamp(-vt / invT, -surface.wallFriction * j, surface.wallFriction * j);
    c.vx += (jt * tx) / P.mass;
    c.vz += (jt * tz) / P.mass;
    c.yawRate += (rt * jt * P.wallAngularScale) / P.inertia;
  }
  return impact;
}

/** Cosmetic gearbox shared by the HUD and the engine sound. */
export const GEAR_TOP_SPEEDS = [0, 16, 28, 40, 52, 63, 80] as const;

export function gearForSpeed(forwardSpeed: number, previousGear: number): number {
  if (forwardSpeed < -0.5) return -1;
  if (forwardSpeed < 0.5) return previousGear > 1 ? 1 : previousGear === -1 ? 0 : Math.max(0, previousGear);
  let gear = clamp(previousGear, 1, GEAR_TOP_SPEEDS.length - 1);
  while (gear < GEAR_TOP_SPEEDS.length - 1 && forwardSpeed > GEAR_TOP_SPEEDS[gear]! * 0.97) gear++;
  while (gear > 1 && forwardSpeed < GEAR_TOP_SPEEDS[gear - 1]! * 0.82) gear--;
  return gear;
}

/** Engine speed as 0..1 within the current gear. */
export function rpmForSpeed(forwardSpeed: number, gear: number): number {
  if (gear <= 0) return clamp(Math.abs(forwardSpeed) / VEHICLE.reverseMaxSpeed, 0, 1) * 0.7 + 0.12;
  const top = GEAR_TOP_SPEEDS[gear]!;
  const low = gear > 1 ? GEAR_TOP_SPEEDS[gear - 1]! * 0.72 : 0;
  return clamp(0.18 + 0.82 * ((forwardSpeed - low) / (top - low)), 0.12, 1);
}
