/**
 * The binary half of the protocol: the two realtime message types.
 *
 *  INPUT    (client -> server)  a batch of sequence-numbered input commands
 *                               plus the newest snapshot tick the client holds.
 *  SNAPSHOT (server -> client)  authoritative car states for one tick, either
 *                               complete or delta-encoded against a snapshot
 *                               the client has acknowledged.
 *
 * Replication design
 * ------------------
 * Every snapshot is identified by its race tick. A client acknowledges the
 * newest snapshot it decoded in each input message. The server encodes the
 * next snapshot as a delta against that acknowledged baseline: per car, only
 * the field groups whose quantised values changed are written. If the
 * baseline is unknown (first snapshot, reconnect, ack too old) the server
 * sends a full snapshot. A delta whose baseline the client no longer holds is
 * discarded and the client asks for a full snapshot by acknowledging tick 0.
 * Losing, duplicating or reordering snapshots therefore never corrupts state.
 *
 * All values are quantised before comparison so that encoder and decoder agree
 * bit for bit. All multi-byte values are little endian.
 */
import { MAX_INPUTS_PER_MESSAGE, MAX_RACERS } from '../constants';
import type { CarInput, CarState } from '../sim/vehicle';
import type { Result } from './schema';

export const BIN_INPUT = 0x01;
export const BIN_SNAPSHOT = 0x02;

// ------------------------------------------------------------------- inputs

export interface InputMessage {
  /** Race the inputs belong to (raceId & 0xff); frames for another race are ignored. */
  raceId: number;
  /** Newest snapshot tick the client has decoded; 0 requests a full snapshot. */
  ackSnapTick: number;
  /** Client clock (ms, low 32 bits). Diagnostic only, never trusted. */
  clientTime: number;
  /** Sequence number of `inputs[0]`; the rest follow consecutively. */
  firstSeq: number;
  inputs: CarInput[];
}

const INPUT_HEADER = 15;
const INPUT_SIZE = 4;
const INPUT_FLAG_HANDBRAKE = 1;
const INPUT_FLAG_RESET = 2;
const INPUT_FLAG_MASK = INPUT_FLAG_HANDBRAKE | INPUT_FLAG_RESET;

export const MAX_INPUT_MESSAGE_BYTES = INPUT_HEADER + INPUT_SIZE * MAX_INPUTS_PER_MESSAGE;

/** Clamps an arbitrary input to the wire's value ranges. */
export function quantizeInput(steer: number, throttle: number, brake: number, handbrake: boolean, reset: boolean): CarInput {
  const q = (v: number, lo: number, hi: number): number => {
    const n = Number.isFinite(v) ? Math.round(v) : 0;
    return n < lo ? lo : n > hi ? hi : n;
  };
  return {
    steer: q(steer * 127, -127, 127),
    throttle: q(throttle * 255, 0, 255),
    brake: q(brake * 255, 0, 255),
    handbrake,
    reset,
  };
}

export function encodeInput(message: InputMessage): Uint8Array {
  const count = Math.min(message.inputs.length, MAX_INPUTS_PER_MESSAGE);
  const bytes = new Uint8Array(INPUT_HEADER + INPUT_SIZE * count);
  const view = new DataView(bytes.buffer);
  view.setUint8(0, BIN_INPUT);
  view.setUint8(1, message.raceId & 0xff);
  view.setUint32(2, message.ackSnapTick >>> 0, true);
  view.setUint32(6, message.clientTime >>> 0, true);
  view.setUint32(10, message.firstSeq >>> 0, true);
  view.setUint8(14, count);
  for (let i = 0; i < count; i++) {
    const input = message.inputs[i]!;
    const o = INPUT_HEADER + i * INPUT_SIZE;
    view.setInt8(o, input.steer);
    view.setUint8(o + 1, input.throttle);
    view.setUint8(o + 2, input.brake);
    view.setUint8(o + 3, (input.handbrake ? INPUT_FLAG_HANDBRAKE : 0) | (input.reset ? INPUT_FLAG_RESET : 0));
  }
  return bytes;
}

/** Strictly validates and decodes an input frame. */
export function decodeInput(bytes: Uint8Array): Result<InputMessage> {
  if (bytes.byteLength < INPUT_HEADER) return { ok: false, error: 'input: truncated header' };
  if (bytes.byteLength > MAX_INPUT_MESSAGE_BYTES) return { ok: false, error: 'input: too large' };
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint8(0) !== BIN_INPUT) return { ok: false, error: 'input: wrong type' };
  const count = view.getUint8(14);
  if (count > MAX_INPUTS_PER_MESSAGE) return { ok: false, error: 'input: too many inputs' };
  if (bytes.byteLength !== INPUT_HEADER + INPUT_SIZE * count) return { ok: false, error: 'input: length mismatch' };
  const firstSeq = view.getUint32(10, true);
  if (count > 0 && firstSeq === 0) return { ok: false, error: 'input: sequence numbers start at 1' };
  if (firstSeq + count > 0xffffffff) return { ok: false, error: 'input: sequence overflow' };
  const inputs: CarInput[] = [];
  for (let i = 0; i < count; i++) {
    const o = INPUT_HEADER + i * INPUT_SIZE;
    const steer = view.getInt8(o);
    const flags = view.getUint8(o + 3);
    if (steer < -127) return { ok: false, error: 'input: steer out of range' };
    if ((flags & ~INPUT_FLAG_MASK) !== 0) return { ok: false, error: 'input: unknown flags' };
    inputs.push({
      steer,
      throttle: view.getUint8(o + 1),
      brake: view.getUint8(o + 2),
      handbrake: (flags & INPUT_FLAG_HANDBRAKE) !== 0,
      reset: (flags & INPUT_FLAG_RESET) !== 0,
    });
  }
  return {
    ok: true,
    value: {
      raceId: view.getUint8(1),
      ackSnapTick: view.getUint32(2, true),
      clientTime: view.getUint32(6, true),
      firstSeq,
      inputs,
    },
  };
}

// ---------------------------------------------------------------- snapshots

export const YAW_SCALE = 32767 / Math.PI;
export const VEL_SCALE = 100;
export const YAW_RATE_SCALE = 1000;

/** Car status bits carried in snapshots. */
export const CarFlag = {
  FINISHED: 1 << 0,
  OFFROAD: 1 << 1,
  WRONG_WAY: 1 << 2,
  MISSED_GATE: 1 << 3,
  HANDBRAKE: 1 << 4,
  DRIFT: 1 << 5,
  WALL_HIT: 1 << 6,
  CAR_HIT: 1 << 7,
  DISCONNECTED: 1 << 8,
  WHEELSPIN: 1 << 9,
  /** Toggles each time the car is reset to the track (teleport marker). */
  RESET_TOGGLE: 1 << 10,
  PENALTY_ISSUED: 1 << 11,
} as const;
const CAR_FLAG_MASK = (1 << 12) - 1;

export const RacePhaseCode = { countdown: 0, racing: 1, finished: 2 } as const;

/** A car as carried on the wire: every field already quantised. */
export interface QCar {
  slot: number;
  // pose
  x: number; // float32
  z: number; // float32
  yaw: number; // int16, rad * YAW_SCALE
  // motion
  vx: number; // int16, m/s * VEL_SCALE
  vz: number; // int16
  yawRate: number; // int16, rad/s * YAW_RATE_SCALE
  // controls
  steer: number; // int8, steering position * 127
  throttle: number; // uint8
  brake: number; // uint8
  flags: number; // uint16, CarFlag bits
  // progress
  cp: number; // uint16, gates passed
  rank: number; // uint8
  frozen: number; // uint16 ticks
  penalty: number; // uint16 ticks
  // timing (ms since green)
  cpMs: number; // uint32
  lapStartMs: number; // uint32
  lastLapMs: number; // uint32
  bestLapMs: number; // uint32
  finishMs: number; // uint32
}

/** The part of a snapshot that is identical for every recipient. */
export interface SnapshotBody {
  /** Race this snapshot belongs to (raceId & 0xff). */
  raceId: number;
  tick: number;
  /** RacePhaseCode. */
  phase: number;
  goTick: number;
  /** Tick at which the finish timeout expires, 0 when not running. */
  endsAtTick: number;
  /** Cars sorted by slot. */
  cars: QCar[];
}

export interface Snapshot extends SnapshotBody {
  /** 0 for a full snapshot, else the tick of the delta baseline. */
  baseTick: number;
  /** Last input sequence number of the recipient that the server simulated. */
  ackSeq: number;
  /** Recipient's buffered, not yet simulated inputs (after this tick). */
  queueDepth: number;
}

const G_POSE = 1;
const G_MOTION = 2;
const G_CONTROL = 4;
const G_PROGRESS = 8;
const G_TIMING = 16;
const G_ALL = G_POSE | G_MOTION | G_CONTROL | G_PROGRESS | G_TIMING;
const G_REMOVED = 128;

const SNAPSHOT_HEADER = 26;
const CAR_MAX_BYTES = 2 + 10 + 6 + 5 + 7 + 20;
export const MAX_SNAPSHOT_BYTES = SNAPSHOT_HEADER + CAR_MAX_BYTES * MAX_RACERS;

function toInt16(v: number): number {
  const n = Math.round(v);
  return n < -32768 ? -32768 : n > 32767 ? 32767 : n;
}

function toUint(v: number, max: number): number {
  const n = Math.round(v);
  return n < 0 ? 0 : n > max ? max : n;
}

/** Quantises a simulated car into its wire representation. */
export function quantizeCar(
  slot: number,
  state: Readonly<CarState>,
  input: Readonly<CarInput>,
  flags: number,
  progress: { cp: number; rank: number; cpMs: number; lapStartMs: number; lastLapMs: number; bestLapMs: number; finishMs: number },
): QCar {
  return {
    slot,
    x: Math.fround(state.x),
    z: Math.fround(state.z),
    yaw: toInt16(state.yaw * YAW_SCALE),
    vx: toInt16(state.vx * VEL_SCALE),
    vz: toInt16(state.vz * VEL_SCALE),
    yawRate: toInt16(state.yawRate * YAW_RATE_SCALE),
    steer: toUint(state.steer * 127 + 127, 254) - 127,
    throttle: toUint(input.throttle, 255),
    brake: toUint(input.brake, 255),
    flags: flags & CAR_FLAG_MASK,
    cp: toUint(progress.cp, 0xffff),
    rank: toUint(progress.rank, 255),
    frozen: toUint(state.frozen, 0xffff),
    penalty: toUint(state.penalty, 0xffff),
    cpMs: toUint(progress.cpMs, 0xffffffff),
    lapStartMs: toUint(progress.lapStartMs, 0xffffffff),
    lastLapMs: toUint(progress.lastLapMs, 0xffffffff),
    bestLapMs: toUint(progress.bestLapMs, 0xffffffff),
    finishMs: toUint(progress.finishMs, 0xffffffff),
  };
}

/** Writes the physical part of a wire car into a simulation state. */
export function applyQCar(q: Readonly<QCar>, out: CarState): CarState {
  out.x = q.x;
  out.z = q.z;
  out.yaw = q.yaw / YAW_SCALE;
  out.vx = q.vx / VEL_SCALE;
  out.vz = q.vz / VEL_SCALE;
  out.yawRate = q.yawRate / YAW_RATE_SCALE;
  out.steer = q.steer / 127;
  out.frozen = q.frozen;
  out.penalty = q.penalty;
  return out;
}

function groupsChanged(a: Readonly<QCar>, b: Readonly<QCar>): number {
  let mask = 0;
  if (a.x !== b.x || a.z !== b.z || a.yaw !== b.yaw) mask |= G_POSE;
  if (a.vx !== b.vx || a.vz !== b.vz || a.yawRate !== b.yawRate) mask |= G_MOTION;
  if (a.steer !== b.steer || a.throttle !== b.throttle || a.brake !== b.brake || a.flags !== b.flags) mask |= G_CONTROL;
  if (a.cp !== b.cp || a.rank !== b.rank || a.frozen !== b.frozen || a.penalty !== b.penalty) mask |= G_PROGRESS;
  if (
    a.cpMs !== b.cpMs ||
    a.lapStartMs !== b.lapStartMs ||
    a.lastLapMs !== b.lastLapMs ||
    a.bestLapMs !== b.bestLapMs ||
    a.finishMs !== b.finishMs
  ) {
    mask |= G_TIMING;
  }
  return mask;
}

/**
 * Encodes the recipient-independent part of a snapshot (everything after the
 * per-recipient header). `base` is the acknowledged baseline, or null for a
 * full snapshot.
 */
export function encodeSnapshotBody(current: Readonly<SnapshotBody>, base: Readonly<SnapshotBody> | null): Uint8Array {
  const bytes = new Uint8Array(1 + CAR_MAX_BYTES * (current.cars.length + (base ? base.cars.length : 0)));
  const view = new DataView(bytes.buffer);
  let o = 1;
  let count = 0;
  const baseBySlot = new Map<number, QCar>();
  if (base) for (const car of base.cars) baseBySlot.set(car.slot, car);

  for (const car of current.cars) {
    const prev = baseBySlot.get(car.slot);
    baseBySlot.delete(car.slot);
    const mask = prev ? groupsChanged(car, prev) : G_ALL;
    if (mask === 0) continue;
    count++;
    view.setUint8(o++, car.slot);
    view.setUint8(o++, mask);
    if (mask & G_POSE) {
      view.setFloat32(o, car.x, true);
      view.setFloat32(o + 4, car.z, true);
      view.setInt16(o + 8, car.yaw, true);
      o += 10;
    }
    if (mask & G_MOTION) {
      view.setInt16(o, car.vx, true);
      view.setInt16(o + 2, car.vz, true);
      view.setInt16(o + 4, car.yawRate, true);
      o += 6;
    }
    if (mask & G_CONTROL) {
      view.setInt8(o, car.steer);
      view.setUint8(o + 1, car.throttle);
      view.setUint8(o + 2, car.brake);
      view.setUint16(o + 3, car.flags, true);
      o += 5;
    }
    if (mask & G_PROGRESS) {
      view.setUint16(o, car.cp, true);
      view.setUint8(o + 2, car.rank);
      view.setUint16(o + 3, car.frozen, true);
      view.setUint16(o + 5, car.penalty, true);
      o += 7;
    }
    if (mask & G_TIMING) {
      view.setUint32(o, car.cpMs, true);
      view.setUint32(o + 4, car.lapStartMs, true);
      view.setUint32(o + 8, car.lastLapMs, true);
      view.setUint32(o + 12, car.bestLapMs, true);
      view.setUint32(o + 16, car.finishMs, true);
      o += 20;
    }
  }
  // Cars present in the baseline but gone now.
  for (const slot of baseBySlot.keys()) {
    count++;
    view.setUint8(o++, slot);
    view.setUint8(o++, G_REMOVED);
  }
  view.setUint8(0, count);
  return bytes.subarray(0, o);
}

/** Prepends the per-recipient header to an encoded body. */
export function packSnapshot(
  current: Readonly<SnapshotBody>,
  baseTick: number,
  ackSeq: number,
  queueDepth: number,
  body: Uint8Array,
): Uint8Array {
  const bytes = new Uint8Array(SNAPSHOT_HEADER - 1 + body.byteLength);
  const view = new DataView(bytes.buffer);
  view.setUint8(0, BIN_SNAPSHOT);
  view.setUint8(1, baseTick === 0 ? 1 : 0);
  view.setUint32(2, current.tick, true);
  view.setUint32(6, baseTick, true);
  view.setUint32(10, ackSeq >>> 0, true);
  view.setUint8(14, queueDepth > 255 ? 255 : queueDepth);
  view.setUint8(15, current.phase);
  view.setUint32(16, current.goTick, true);
  view.setUint32(20, current.endsAtTick, true);
  view.setUint8(24, current.raceId & 0xff);
  bytes.set(body, SNAPSHOT_HEADER - 1);
  return bytes;
}

/** Convenience: encode a whole snapshot in one call. */
export function encodeSnapshot(
  current: Readonly<SnapshotBody>,
  base: Readonly<SnapshotBody> | null,
  ackSeq: number,
  queueDepth: number,
): Uint8Array {
  return packSnapshot(current, base ? base.tick : 0, ackSeq, queueDepth, encodeSnapshotBody(current, base));
}

export type SnapshotDecode =
  | { ok: true; value: Snapshot }
  | { ok: false; error: string; missingBase?: number };

/** Reads only the race id and tick of a snapshot frame (or null if it is not one). */
export function peekSnapshot(bytes: Uint8Array): { raceId: number; tick: number } | null {
  if (bytes.byteLength < SNAPSHOT_HEADER || bytes[0] !== BIN_SNAPSHOT) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return { raceId: view.getUint8(24), tick: view.getUint32(2, true) };
}

/**
 * Strictly validates and decodes a snapshot frame. `getBase` resolves delta
 * baselines; when the baseline is unavailable the result carries
 * `missingBase` so the caller can request a full snapshot.
 */
export function decodeSnapshot(
  bytes: Uint8Array,
  getBase: (tick: number) => Readonly<SnapshotBody> | undefined,
): SnapshotDecode {
  if (bytes.byteLength < SNAPSHOT_HEADER) return { ok: false, error: 'snapshot: truncated header' };
  if (bytes.byteLength > MAX_SNAPSHOT_BYTES) return { ok: false, error: 'snapshot: too large' };
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint8(0) !== BIN_SNAPSHOT) return { ok: false, error: 'snapshot: wrong type' };
  const full = view.getUint8(1);
  const tick = view.getUint32(2, true);
  const baseTick = view.getUint32(6, true);
  const ackSeq = view.getUint32(10, true);
  const queueDepth = view.getUint8(14);
  const phase = view.getUint8(15);
  const goTick = view.getUint32(16, true);
  const endsAtTick = view.getUint32(20, true);
  const raceId = view.getUint8(24);
  const count = view.getUint8(25);
  if (full > 1 || (full === 1) !== (baseTick === 0)) return { ok: false, error: 'snapshot: inconsistent base' };
  if (tick === 0 || baseTick >= tick) return { ok: false, error: 'snapshot: invalid tick' };
  if (phase > 2) return { ok: false, error: 'snapshot: invalid phase' };
  if (count > MAX_RACERS) return { ok: false, error: 'snapshot: too many entries' };

  const cars = new Map<number, QCar>();
  if (baseTick !== 0) {
    const base = getBase(baseTick);
    if (base && base.raceId !== raceId) return { ok: false, error: 'snapshot: baseline from another race' };
    if (!base) return { ok: false, error: 'snapshot: missing baseline', missingBase: baseTick };
    for (const car of base.cars) cars.set(car.slot, { ...car });
  }

  let o = SNAPSHOT_HEADER;
  const seen = new Set<number>();
  for (let i = 0; i < count; i++) {
    if (o + 2 > bytes.byteLength) return { ok: false, error: 'snapshot: truncated entry' };
    const slot = view.getUint8(o++);
    const mask = view.getUint8(o++);
    if (slot >= MAX_RACERS) return { ok: false, error: 'snapshot: invalid slot' };
    if (seen.has(slot)) return { ok: false, error: 'snapshot: duplicate slot' };
    seen.add(slot);
    if (mask === G_REMOVED) {
      cars.delete(slot);
      continue;
    }
    if (mask === 0 || (mask & ~G_ALL) !== 0) return { ok: false, error: 'snapshot: invalid field mask' };
    let car = cars.get(slot);
    if (!car) {
      if (mask !== G_ALL) return { ok: false, error: 'snapshot: partial update for unknown car' };
      car = {
        slot,
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
        cp: 0,
        rank: 0,
        frozen: 0,
        penalty: 0,
        cpMs: 0,
        lapStartMs: 0,
        lastLapMs: 0,
        bestLapMs: 0,
        finishMs: 0,
      };
      cars.set(slot, car);
    }
    const need =
      (mask & G_POSE ? 10 : 0) +
      (mask & G_MOTION ? 6 : 0) +
      (mask & G_CONTROL ? 5 : 0) +
      (mask & G_PROGRESS ? 7 : 0) +
      (mask & G_TIMING ? 20 : 0);
    if (o + need > bytes.byteLength) return { ok: false, error: 'snapshot: truncated car' };
    if (mask & G_POSE) {
      car.x = view.getFloat32(o, true);
      car.z = view.getFloat32(o + 4, true);
      car.yaw = view.getInt16(o + 8, true);
      o += 10;
      if (!Number.isFinite(car.x) || !Number.isFinite(car.z) || Math.abs(car.x) > 1e5 || Math.abs(car.z) > 1e5) {
        return { ok: false, error: 'snapshot: position out of range' };
      }
    }
    if (mask & G_MOTION) {
      car.vx = view.getInt16(o, true);
      car.vz = view.getInt16(o + 2, true);
      car.yawRate = view.getInt16(o + 4, true);
      o += 6;
    }
    if (mask & G_CONTROL) {
      car.steer = view.getInt8(o);
      car.throttle = view.getUint8(o + 1);
      car.brake = view.getUint8(o + 2);
      car.flags = view.getUint16(o + 3, true);
      o += 5;
      if (car.steer < -127 || (car.flags & ~CAR_FLAG_MASK) !== 0) {
        return { ok: false, error: 'snapshot: invalid controls' };
      }
    }
    if (mask & G_PROGRESS) {
      car.cp = view.getUint16(o, true);
      car.rank = view.getUint8(o + 2);
      car.frozen = view.getUint16(o + 3, true);
      car.penalty = view.getUint16(o + 5, true);
      o += 7;
    }
    if (mask & G_TIMING) {
      car.cpMs = view.getUint32(o, true);
      car.lapStartMs = view.getUint32(o + 4, true);
      car.lastLapMs = view.getUint32(o + 8, true);
      car.bestLapMs = view.getUint32(o + 12, true);
      car.finishMs = view.getUint32(o + 16, true);
      o += 20;
    }
  }
  if (o !== bytes.byteLength) return { ok: false, error: 'snapshot: trailing bytes' };

  const list = [...cars.values()].sort((a, b) => a.slot - b.slot);
  return { ok: true, value: { raceId, tick, baseTick, ackSeq, queueDepth, phase, goTick, endsAtTick, cars: list } };
}
