/**
 * Authoritative race rules on top of the vehicle model: grid, countdown,
 * ordered checkpoints, laps, timing, penalties, resets, ranking and results.
 *
 * `RaceSim.step` is deterministic: the same sequence of inputs always yields
 * the same race. Only the server runs it; clients merely display its output.
 */
import { COUNTDOWN_TICKS, FINISH_TIMEOUT_TICKS, MAX_RACE_TICKS, SIM_HZ, TICK_MS } from '../constants';
import { collideCars } from './collision';
import { clamp, mod } from './math';
import { arcDelta, pointAt, type Gate, type Track } from './track';
import {
  NEUTRAL_INPUT,
  VEHICLE,
  collideWalls,
  makeCarState,
  makeTelemetry,
  stepCar,
  type CarInput,
  type CarState,
  type CarTelemetry,
} from './vehicle';
import { makeQuery, queryTrack } from './track';

export type RacePhase = 'countdown' | 'racing' | 'finished';
export type RaceEndReason = 'all_finished' | 'timeout' | 'max_duration';

/** A car must be this far beyond the road edge to count as off track. */
export const OFFTRACK_MARGIN = 1.2;
/** Continuous off-track time before a penalty is issued. */
export const OFFTRACK_PENALTY_AFTER = Math.round(2.5 * SIM_HZ);
/** Length of the reduced-power penalty. */
export const PENALTY_TICKS = 2 * SIM_HZ;
export const PENALTY_MAX_TICKS = 6 * SIM_HZ;
/** Time a car is held still after a reset-to-track. */
export const RESET_FREEZE_TICKS = Math.round(1.5 * SIM_HZ);
export const RESET_COOLDOWN_TICKS = 3 * SIM_HZ;
export const WRONG_WAY_AFTER = Math.round(0.75 * SIM_HZ);
/**
 * Largest plausible displacement of a car in one tick. Anything beyond this is
 * a teleport and can never be credited with a checkpoint.
 */
export const MAX_STEP_DISTANCE = (VEHICLE.maxSpeed / SIM_HZ) * 1.5 + 0.5;

export interface RaceEntry {
  isBot: boolean;
}

export interface RaceCar {
  slot: number;
  /** False once the car has been removed from the race. */
  active: boolean;
  isBot: boolean;
  state: CarState;
  tel: CarTelemetry;
  /** Number of gates passed in order (monotonic). Gate expected next: cp % gateCount. */
  cp: number;
  /** Race time (ms since green) of the last gate passage. */
  cpMs: number;
  lapStartMs: number;
  lastLapMs: number;
  bestLapMs: number;
  finished: boolean;
  finishMs: number;
  /** 1-based race position. */
  rank: number;
  /** Monotonic race distance (m) used for ranking and gaps. */
  distance: number;
  offTicks: number;
  wrongWayTicks: number;
  /** Set when the car drove through a gate it was not due at. */
  missedGate: boolean;
  resetCooldown: number;
  resetHeld: boolean;
  lastX: number;
  lastZ: number;
  /** Closing speed of the hardest car contact in the last step. */
  contact: number;
  penalties: number;
  resets: number;
}

export type RaceEvent =
  | { type: 'go' }
  | { type: 'checkpoint'; slot: number; cp: number; ms: number }
  | { type: 'lap'; slot: number; lap: number; ms: number; best: boolean }
  | { type: 'finish'; slot: number; place: number; ms: number }
  | { type: 'penalty'; slot: number; reason: 'off_track' }
  | { type: 'reset'; slot: number }
  | { type: 'missed_gate'; slot: number }
  | { type: 'teleport_rejected'; slot: number }
  | { type: 'collision'; a: number; b: number; speed: number }
  | { type: 'end'; reason: RaceEndReason };

export interface Standing {
  slot: number;
  place: number;
  finished: boolean;
  /** Total race time in ms (0 when not finished). */
  totalMs: number;
  bestLapMs: number;
  lapsCompleted: number;
  distance: number;
  penalties: number;
  active: boolean;
}

export interface RaceOptions {
  countdownTicks?: number;
  finishTimeoutTicks?: number;
  maxRaceTicks?: number;
}

/**
 * Parametric position (0..1) along the move p0->p1 at which it crosses the
 * gate in the driving direction, or -1 if it does not.
 */
export function crossGate(g: Gate, x0: number, z0: number, x1: number, z1: number): number {
  const mx = x1 - x0;
  const mz = z1 - z0;
  // Must be moving forwards through the gate.
  if (mx * g.tx + mz * g.tz <= 0) return -1;
  const gx = g.bx - g.ax;
  const gz = g.bz - g.az;
  const denom = mx * gz - mz * gx;
  if (Math.abs(denom) < 1e-12) return -1;
  const t = ((g.ax - x0) * gz - (g.az - z0) * gx) / denom;
  if (t < 0 || t > 1) return -1;
  const u = ((g.ax - x0) * mz - (g.az - z0) * mx) / denom;
  if (u < 0 || u > 1) return -1;
  return t;
}

/** 1-based lap number shown to players for a gate counter. */
export function lapOf(cp: number, gateCount: number, laps: number): number {
  return clamp(Math.floor((Math.max(cp, 1) - 1) / gateCount) + 1, 1, laps);
}

/** Completed laps for a gate counter. */
export function lapsCompleted(cp: number, gateCount: number): number {
  return cp <= 0 ? 0 : Math.floor((cp - 1) / gateCount);
}

/** Index of the last gate passed within the current lap (0 = start line). */
export function checkpointOf(cp: number, gateCount: number): number {
  return (Math.max(cp, 1) - 1) % gateCount;
}

const respawnQuery = makeQuery();

export class RaceSim {
  readonly track: Track;
  readonly laps: number;
  readonly gateCount: number;
  readonly goTick: number;
  readonly cars: RaceCar[];
  /** Arc length from gate k to gate k+1. */
  readonly gateGap: number[];
  readonly finishOrder: number[] = [];
  /** Events produced by the most recent step. */
  readonly events: RaceEvent[] = [];
  tick = 0;
  phase: RacePhase = 'countdown';
  firstFinishTick = -1;
  endTick = -1;
  endReason: RaceEndReason | null = null;

  private readonly finishTimeoutTicks: number;
  private readonly maxRaceTicks: number;
  private readonly order: number[];
  private readonly finishedNow: RaceCar[] = [];

  constructor(track: Track, laps: number, entries: readonly RaceEntry[], options: RaceOptions = {}) {
    if (entries.length < 1 || entries.length > track.grid.length) {
      throw new Error(`A race needs between 1 and ${track.grid.length} cars`);
    }
    this.track = track;
    this.laps = laps;
    this.gateCount = track.gates.length;
    this.goTick = options.countdownTicks ?? COUNTDOWN_TICKS;
    this.finishTimeoutTicks = options.finishTimeoutTicks ?? FINISH_TIMEOUT_TICKS;
    this.maxRaceTicks = options.maxRaceTicks ?? MAX_RACE_TICKS;
    this.gateGap = track.gates.map((g, i) => {
      const next = track.gates[(i + 1) % track.gates.length]!;
      return mod(next.s - g.s, track.length) || track.length;
    });
    this.cars = entries.map((entry, slot) => {
      const grid = track.grid[slot]!;
      const state = makeCarState(grid.x, grid.z, grid.yaw);
      state.frozen = this.goTick;
      const car: RaceCar = {
        slot,
        active: true,
        isBot: entry.isBot,
        state,
        tel: makeTelemetry(),
        cp: 0,
        cpMs: 0,
        lapStartMs: 0,
        lastLapMs: 0,
        bestLapMs: 0,
        finished: false,
        finishMs: 0,
        rank: slot + 1,
        distance: 0,
        offTicks: 0,
        wrongWayTicks: 0,
        missedGate: false,
        resetCooldown: 0,
        resetHeld: false,
        lastX: grid.x,
        lastZ: grid.z,
        contact: 0,
        penalties: 0,
        resets: 0,
      };
      return car;
    });
    this.order = this.cars.map((c) => c.slot);
    // Prime telemetry so the first snapshot is meaningful.
    for (const car of this.cars) stepCarTelemetryOnly(car, track);
    this.updateRanks();
  }

  /** Race time in ms since the green light (0 during the countdown). */
  get raceMs(): number {
    return Math.max(0, (this.tick - this.goTick) * TICK_MS);
  }

  /** Advances the race by one tick. `inputs[slot]` may be null/undefined for "no input". */
  step(inputs: ReadonlyArray<Readonly<CarInput> | null | undefined>): readonly RaceEvent[] {
    const { track, cars, events } = this;
    events.length = 0;
    this.tick++;
    if (this.phase === 'countdown' && this.tick >= this.goTick) {
      this.phase = 'racing';
      events.push({ type: 'go' });
    }

    for (const car of cars) {
      if (!car.active) continue;
      const input = inputs[car.slot] ?? NEUTRAL_INPUT;
      car.contact = 0;
      if (car.resetCooldown > 0) car.resetCooldown--;
      if (
        this.phase === 'racing' &&
        input.reset &&
        !car.resetHeld &&
        !car.finished &&
        car.resetCooldown === 0 &&
        car.state.frozen === 0
      ) {
        this.respawn(car);
      }
      car.resetHeld = input.reset;
      stepCar(car.state, input, track, car.tel);
    }

    // Car-to-car contact, in a fixed pair order. Finished cars are ghosts.
    for (let i = 0; i < cars.length; i++) {
      const a = cars[i]!;
      if (!a.active || a.finished) continue;
      for (let j = i + 1; j < cars.length; j++) {
        const b = cars[j]!;
        if (!b.active || b.finished) continue;
        const moveA = a.state.frozen === 0;
        const moveB = b.state.frozen === 0;
        if (!moveA && !moveB) continue;
        const impact = collideCars(a.state, b.state, moveA, moveB);
        if (impact < 0) continue;
        if (impact > a.contact) a.contact = impact;
        if (impact > b.contact) b.contact = impact;
        if (impact > 1.5) events.push({ type: 'collision', a: a.slot, b: b.slot, speed: impact });
        // A shove may have pushed a car into the barrier: re-apply the walls.
        collideWalls(a.state, track);
        collideWalls(b.state, track);
        stepCarTelemetryOnly(a, track);
        stepCarTelemetryOnly(b, track);
      }
    }

    this.finishedNow.length = 0;
    for (const car of cars) {
      if (!car.active) continue;
      this.applyRules(car);
    }
    if (this.finishedNow.length > 0) {
      this.finishedNow.sort((p, q) => p.finishMs - q.finishMs || p.slot - q.slot);
      for (const car of this.finishedNow) {
        this.finishOrder.push(car.slot);
        events.push({ type: 'finish', slot: car.slot, place: this.finishOrder.length, ms: car.finishMs });
      }
      if (this.firstFinishTick < 0) this.firstFinishTick = this.tick;
    }

    this.updateRanks();
    if (this.phase === 'racing') this.checkEnd();
    return events;
  }

  /** Removes a car from the race for good (player left, reconnect expired). */
  removeCar(slot: number): void {
    const car = this.cars[slot];
    if (!car || !car.active) return;
    car.active = false;
    car.state.vx = 0;
    car.state.vz = 0;
    car.state.yawRate = 0;
    this.updateRanks();
    if (this.phase === 'racing') this.checkEnd();
  }

  /** Final classification: finishers in order, then everyone else by distance. */
  standings(): Standing[] {
    const rows: Standing[] = [];
    const placed = new Set<number>();
    const add = (car: RaceCar): void => {
      placed.add(car.slot);
      rows.push({
        slot: car.slot,
        place: rows.length + 1,
        finished: car.finished,
        totalMs: car.finished ? car.finishMs : 0,
        bestLapMs: car.bestLapMs,
        lapsCompleted: Math.min(this.laps, lapsCompleted(car.cp, this.gateCount)),
        distance: car.distance,
        penalties: car.penalties,
        active: car.active,
      });
    };
    for (const slot of this.finishOrder) add(this.cars[slot]!);
    const rest = this.cars
      .filter((c) => !placed.has(c.slot))
      .sort((p, q) => Number(q.active) - Number(p.active) || q.distance - p.distance || p.slot - q.slot);
    for (const car of rest) add(car);
    return rows;
  }

  /** Flat numeric dump of the whole race state, used to assert determinism. */
  serialize(): number[] {
    const out: number[] = [this.tick, this.phase === 'countdown' ? 0 : this.phase === 'racing' ? 1 : 2, this.finishOrder.length];
    for (const c of this.cars) {
      const s = c.state;
      out.push(
        c.active ? 1 : 0,
        s.x,
        s.z,
        s.yaw,
        s.vx,
        s.vz,
        s.yawRate,
        s.steer,
        s.frozen,
        s.penalty,
        c.cp,
        c.cpMs,
        c.lapStartMs,
        c.lastLapMs,
        c.bestLapMs,
        c.finished ? 1 : 0,
        c.finishMs,
        c.rank,
        c.offTicks,
        c.penalties,
        c.resets,
      );
    }
    return out;
  }

  private applyRules(car: RaceCar): void {
    const { track, events } = this;
    const st = car.state;
    if (this.phase === 'racing' && !car.finished) {
      const dx = st.x - car.lastX;
      const dz = st.z - car.lastZ;
      if (dx * dx + dz * dz > MAX_STEP_DISTANCE * MAX_STEP_DISTANCE) {
        // Impossible movement: never credit a gate for it.
        events.push({ type: 'teleport_rejected', slot: car.slot });
      } else {
        const expected = track.gates[car.cp % this.gateCount]!;
        const f = crossGate(expected, car.lastX, car.lastZ, st.x, st.z);
        if (f >= 0) {
          this.creditGate(car, expected, f);
        } else if (!car.missedGate && this.gateCount > 2) {
          const after = track.gates[(car.cp + 1) % this.gateCount]!;
          if (crossGate(after, car.lastX, car.lastZ, st.x, st.z) >= 0) {
            car.missedGate = true;
            events.push({ type: 'missed_gate', slot: car.slot });
          }
        }
      }

      // Off-track penalty: lingering fully on the run-off cuts engine power.
      if (Math.abs(car.tel.lat) > track.halfWidth + OFFTRACK_MARGIN && st.frozen === 0) {
        car.offTicks++;
        if (car.offTicks >= OFFTRACK_PENALTY_AFTER) {
          car.offTicks = 0;
          st.penalty = Math.min(PENALTY_MAX_TICKS, st.penalty + PENALTY_TICKS);
          car.penalties++;
          events.push({ type: 'penalty', slot: car.slot, reason: 'off_track' });
        }
      } else if (car.offTicks > 0) {
        car.offTicks = Math.max(0, car.offTicks - 2);
      }

      const along = st.vx * car.tel.tx + st.vz * car.tel.tz;
      car.wrongWayTicks = along < -3 ? car.wrongWayTicks + 1 : 0;
    }
    car.lastX = st.x;
    car.lastZ = st.z;
  }

  private creditGate(car: RaceCar, gate: Gate, fraction: number): void {
    const ms = Math.max(0, Math.round((this.tick - 1 - this.goTick + fraction) * TICK_MS));
    car.cp++;
    car.cpMs = ms;
    car.missedGate = false;
    this.events.push({ type: 'checkpoint', slot: car.slot, cp: car.cp, ms });
    if (gate.index !== 0) return;
    if (car.cp === 1) {
      // First pass over the line: lap 1 is timed from here.
      car.lapStartMs = ms;
      return;
    }
    const lapMs = ms - car.lapStartMs;
    const best = car.bestLapMs === 0 || lapMs < car.bestLapMs;
    car.lastLapMs = lapMs;
    if (best) car.bestLapMs = lapMs;
    car.lapStartMs = ms;
    const done = lapsCompleted(car.cp, this.gateCount);
    this.events.push({ type: 'lap', slot: car.slot, lap: done, ms: lapMs, best });
    if (done >= this.laps) {
      car.finished = true;
      car.finishMs = ms;
      this.finishedNow.push(car);
    }
  }

  /** Puts a car back on the road at the last gate it passed, at a standstill. */
  private respawn(car: RaceCar): void {
    const { track } = this;
    const st = car.state;
    let s: number;
    if (car.cp === 0) {
      const grid = track.grid[car.slot]!;
      s = queryTrack(track, grid.x, grid.z, respawnQuery).s;
    } else {
      s = track.gates[(car.cp - 1) % this.gateCount]!.s + 3;
    }
    // Pick the first lateral offset that is clear of other cars.
    const offsets = [0, 3.2, -3.2, 1.6, -1.6];
    const spot = { x: 0, z: 0, yaw: 0 };
    let chosen = false;
    for (let back = 0; back < 4 && !chosen; back++) {
      for (const lat of offsets) {
        if (Math.abs(lat) > track.halfWidth - 1.2) continue;
        pointAt(track, s + back * 6, lat, spot);
        let clear = true;
        for (const other of this.cars) {
          if (other === car || !other.active || other.finished) continue;
          const ox = other.state.x - spot.x;
          const oz = other.state.z - spot.z;
          if (ox * ox + oz * oz < 5 * 5) {
            clear = false;
            break;
          }
        }
        if (clear) {
          chosen = true;
          break;
        }
      }
    }
    if (!chosen) pointAt(track, s, 0, spot);
    st.x = spot.x;
    st.z = spot.z;
    st.yaw = spot.yaw;
    st.vx = 0;
    st.vz = 0;
    st.yawRate = 0;
    st.steer = 0;
    st.frozen = RESET_FREEZE_TICKS;
    car.lastX = st.x;
    car.lastZ = st.z;
    car.offTicks = 0;
    car.wrongWayTicks = 0;
    car.resetCooldown = RESET_COOLDOWN_TICKS;
    car.resets++;
    this.events.push({ type: 'reset', slot: car.slot });
  }

  private updateRanks(): void {
    const { track, cars } = this;
    for (const car of cars) {
      if (car.finished) continue;
      if (car.cp === 0) {
        car.distance = Math.min(0, arcDelta(track, car.tel.s, 0));
      } else {
        const gi = (car.cp - 1) % this.gateCount;
        const gate = track.gates[gi]!;
        let along = mod(car.tel.s - gate.s, track.length);
        if (along > track.length / 2) along = 0;
        car.distance =
          lapsCompleted(car.cp, this.gateCount) * track.length + gate.s + Math.min(along, this.gateGap[gi]!);
      }
    }
    const finishPos = (slot: number): number => {
      const i = this.finishOrder.indexOf(slot);
      return i < 0 ? Infinity : i;
    };
    this.order.sort((p, q) => {
      const a = cars[p]!;
      const b = cars[q]!;
      if (a.active !== b.active) return a.active ? -1 : 1;
      const fa = finishPos(p);
      const fb = finishPos(q);
      if (fa !== fb) return fa - fb;
      return b.distance - a.distance || p - q;
    });
    for (let i = 0; i < this.order.length; i++) cars[this.order[i]!]!.rank = i + 1;
  }

  private checkEnd(): void {
    let running = 0;
    let humans = 0;
    let humansRunning = 0;
    for (const car of this.cars) {
      if (!car.active) continue;
      if (!car.isBot) humans++;
      if (car.finished) continue;
      running++;
      if (!car.isBot) humansRunning++;
    }
    let reason: RaceEndReason | null = null;
    if (running === 0) reason = 'all_finished';
    else if (humans > 0 && humansRunning === 0) reason = 'all_finished';
    else if (this.firstFinishTick >= 0 && this.tick - this.firstFinishTick >= this.finishTimeoutTicks) reason = 'timeout';
    else if (this.tick - this.goTick >= this.maxRaceTicks) reason = 'max_duration';
    if (reason) {
      this.phase = 'finished';
      this.endTick = this.tick;
      this.endReason = reason;
      this.events.push({ type: 'end', reason });
    }
  }
}

const telQuery = makeQuery();

/** Refreshes the track-relative telemetry of a car without moving it. */
function stepCarTelemetryOnly(car: RaceCar, track: Track): void {
  const q = queryTrack(track, car.state.x, car.state.z, telQuery);
  const st = car.state;
  car.tel.s = q.s;
  car.tel.lat = q.lat;
  car.tel.tx = q.tx;
  car.tel.tz = q.tz;
  car.tel.offroad = clamp((q.dist - track.halfWidth) / VEHICLE.offroadBlend, 0, 1);
  car.tel.forwardSpeed = st.vx * Math.sin(st.yaw) + st.vz * Math.cos(st.yaw);
  car.tel.speed = Math.sqrt(st.vx * st.vx + st.vz * st.vz);
}
