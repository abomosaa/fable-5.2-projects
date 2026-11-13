/**
 * One running race on the server: the authoritative simulation plus the
 * pieces that connect it to players - input queues, bot drivers and snapshot
 * production with per-recipient delta encoding.
 */
import { SNAPSHOT_HISTORY } from '../../../shared/constants';
import {
  CarFlag,
  RacePhaseCode,
  encodeSnapshotBody,
  packSnapshot,
  quantizeCar,
  type InputMessage,
  type RaceCarInfo,
  type RaceInfo,
  type SnapshotBody,
} from '../../../shared/protocol';
import { BotDriver, botProfileFor, type BotOther } from '../../../shared/sim/bot';
import { RaceSim, WRONG_WAY_AFTER, type RaceEvent } from '../../../shared/sim/race';
import { getTrack } from '../../../shared/sim/tracks';
import type { Track } from '../../../shared/sim/track';
import { NEUTRAL_INPUT, type CarInput } from '../../../shared/sim/vehicle';
import { InputQueue } from './inputQueue';

export interface SessionEntry {
  /** Room member driving the car, or null for a bot. */
  memberId: string | null;
  name: string;
  isBot: boolean;
  /** Index into CAR_COLORS. */
  colour: number;
}

export interface SessionCar {
  slot: number;
  memberId: string | null;
  name: string;
  isBot: boolean;
  colour: number;
  connected: boolean;
  queue: InputQueue | null;
  driver: BotDriver | null;
  /** Input applied on the most recent tick. */
  input: Readonly<CarInput>;
  /** Event flags accumulated since the last snapshot. */
  stickyFlags: number;
  resetToggle: boolean;
}

export interface RaceSessionOptions {
  raceId: number;
  trackId: string;
  laps: number;
  entries: readonly SessionEntry[];
  /** 0..1 */
  botSkill: number;
  seed: number;
  countdownTicks: number;
  finishTimeoutTicks: number;
}

/** A parked car: handbrake on, so it stays put without rolling backwards. */
const PARKED: Readonly<CarInput> = Object.freeze({ steer: 0, throttle: 0, brake: 0, handbrake: true, reset: false });
/** Bringing an abandoned car to a halt (the brake pedal would reverse once stopped). */
const STOPPING: Readonly<CarInput> = Object.freeze({ steer: 0, throttle: 0, brake: 255, handbrake: true, reset: false });
const COOLDOWN_PACE = 0.55;

export class RaceSession {
  readonly raceId: number;
  readonly trackId: string;
  readonly track: Track;
  readonly sim: RaceSim;
  readonly cars: SessionCar[];

  private readonly finishTimeoutTicks: number;
  private readonly seed: number;
  private readonly inputs: Array<Readonly<CarInput> | null>;
  private readonly traffic: BotOther[] = [];
  private readonly history = new Map<number, SnapshotBody>();
  private readonly historyOrder: number[] = [];
  private current: SnapshotBody | null = null;
  private readonly bodyCache = new Map<number, Uint8Array>();

  constructor(options: RaceSessionOptions) {
    this.raceId = options.raceId;
    this.trackId = options.trackId;
    this.track = getTrack(options.trackId);
    this.finishTimeoutTicks = options.finishTimeoutTicks;
    this.seed = options.seed >>> 0;
    this.sim = new RaceSim(
      this.track,
      options.laps,
      options.entries.map((e) => ({ isBot: e.isBot })),
      { countdownTicks: options.countdownTicks, finishTimeoutTicks: options.finishTimeoutTicks },
    );
    this.cars = options.entries.map((entry, slot) => ({
      slot,
      memberId: entry.memberId,
      name: entry.name,
      isBot: entry.isBot,
      colour: entry.colour,
      connected: true,
      queue: entry.isBot ? null : new InputQueue(),
      driver: entry.isBot
        ? new BotDriver(this.track, botProfileFor(slot, options.botSkill), (this.seed ^ (slot * 0x9e3779b1)) >>> 0)
        : null,
      input: NEUTRAL_INPUT,
      stickyFlags: 0,
      resetToggle: false,
    }));
    this.inputs = this.cars.map(() => null);
  }

  get tick(): number {
    return this.sim.tick;
  }

  slotOf(memberId: string): number {
    for (const car of this.cars) if (car.memberId === memberId) return car.slot;
    return -1;
  }

  /** True while at least one human-driven car is still part of the race. */
  hasHumanCars(): boolean {
    for (const car of this.cars) {
      if (!car.isBot && this.sim.cars[car.slot]!.active) return true;
    }
    return false;
  }

  /** Buffers inputs received from the player driving `slot`. */
  pushInput(slot: number, message: Readonly<InputMessage>): void {
    const car = this.cars[slot];
    if (!car || !car.queue || !car.connected) return;
    if (message.inputs.length > 0) car.queue.push(message.firstSeq, message.inputs);
  }

  setConnected(slot: number, connected: boolean): void {
    const car = this.cars[slot];
    if (!car || car.isBot) return;
    car.connected = connected;
    car.queue?.clear();
  }

  removeCar(slot: number): void {
    const car = this.cars[slot];
    if (!car) return;
    car.connected = false;
    this.sim.removeCar(slot);
  }

  /** Advances the race by one tick. */
  step(): readonly RaceEvent[] {
    const { sim, cars, traffic } = this;

    traffic.length = 0;
    for (const simCar of sim.cars) {
      if (!simCar.active || simCar.finished) continue;
      traffic.push({ slot: simCar.slot, s: simCar.tel.s, lat: simCar.tel.lat, speed: simCar.tel.speed });
    }

    for (const car of cars) {
      const simCar = sim.cars[car.slot]!;
      let input: Readonly<CarInput> | null = null;
      if (simCar.active) {
        const self = { slot: car.slot, state: simCar.state, s: simCar.tel.s, lat: simCar.tel.lat };
        if (simCar.finished) {
          // Cool-down lap: an autopilot drives every finished car at a
          // relaxed pace so it does not block the finish line.
          car.driver ??= new BotDriver(this.track, botProfileFor(car.slot, 0.6), (this.seed + car.slot) >>> 0);
          input = car.driver.compute(self, [], COOLDOWN_PACE);
          // Keep consuming the player's inputs so acknowledgements advance.
          if (car.queue && car.connected) car.queue.next();
        } else if (car.isBot) {
          input = car.driver!.compute(self, traffic);
        } else if (!car.connected) {
          input = simCar.tel.forwardSpeed > 1.5 ? STOPPING : PARKED;
        } else {
          input = car.queue!.next();
        }
      }
      car.input = input ?? NEUTRAL_INPUT;
      this.inputs[car.slot] = input;
    }

    const events = sim.step(this.inputs);

    for (const car of cars) {
      const simCar = sim.cars[car.slot]!;
      if (!simCar.active) continue;
      if (simCar.tel.wallHit > 1.2) car.stickyFlags |= CarFlag.WALL_HIT;
      if (simCar.contact > 1.2) car.stickyFlags |= CarFlag.CAR_HIT;
    }
    for (const event of events) {
      if (event.type === 'reset') {
        const car = cars[event.slot]!;
        car.resetToggle = !car.resetToggle;
      } else if (event.type === 'penalty') {
        cars[event.slot]!.stickyFlags |= CarFlag.PENALTY_ISSUED;
      }
    }
    return events;
  }

  /** Captures the current tick as a snapshot and makes it the newest baseline. */
  snapshot(): SnapshotBody {
    const { sim } = this;
    const body: SnapshotBody = {
      raceId: this.raceId & 0xff,
      tick: sim.tick,
      phase: RacePhaseCode[sim.phase],
      goTick: sim.goTick,
      endsAtTick: sim.phase === 'racing' && sim.firstFinishTick >= 0 ? sim.firstFinishTick + this.finishTimeoutTicks : 0,
      cars: [],
    };
    for (const car of this.cars) {
      const simCar = sim.cars[car.slot]!;
      if (!simCar.active) continue;
      let flags = car.stickyFlags;
      car.stickyFlags = 0;
      if (simCar.finished) flags |= CarFlag.FINISHED;
      if (simCar.tel.offroad > 0.5) flags |= CarFlag.OFFROAD;
      if (simCar.wrongWayTicks > WRONG_WAY_AFTER) flags |= CarFlag.WRONG_WAY;
      if (simCar.missedGate) flags |= CarFlag.MISSED_GATE;
      if (car.input.handbrake) flags |= CarFlag.HANDBRAKE;
      if (simCar.tel.slip > 1 && simCar.tel.speed > 8) flags |= CarFlag.DRIFT;
      if (simCar.tel.wheelspin > 0.15) flags |= CarFlag.WHEELSPIN;
      if (!car.isBot && !car.connected) flags |= CarFlag.DISCONNECTED;
      if (car.resetToggle) flags |= CarFlag.RESET_TOGGLE;
      body.cars.push(quantizeCar(car.slot, simCar.state, car.input, flags, simCar));
    }
    this.history.set(body.tick, body);
    this.historyOrder.push(body.tick);
    while (this.historyOrder.length > SNAPSHOT_HISTORY) {
      this.history.delete(this.historyOrder.shift()!);
    }
    this.current = body;
    this.bodyCache.clear();
    return body;
  }

  /** Whether a delta can be encoded against the snapshot a recipient acknowledged. */
  hasBaseline(ackSnapTick: number): boolean {
    return this.current !== null && ackSnapTick > 0 && ackSnapTick < this.current.tick && this.history.has(ackSnapTick);
  }

  /**
   * Encodes the newest snapshot for one recipient: a delta against the
   * snapshot it acknowledged if the server still has it, else a full one.
   */
  encodeFor(ackSnapTick: number, slot: number): Uint8Array | null {
    const current = this.current;
    if (!current) return null;
    let base: SnapshotBody | null = null;
    if (ackSnapTick > 0 && ackSnapTick < current.tick) base = this.history.get(ackSnapTick) ?? null;
    const baseTick = base ? base.tick : 0;
    let body = this.bodyCache.get(baseTick);
    if (!body) {
      body = encodeSnapshotBody(current, base);
      this.bodyCache.set(baseTick, body);
    }
    const queue = slot >= 0 ? (this.cars[slot]?.queue ?? null) : null;
    return packSnapshot(current, baseTick, queue ? queue.lastConsumedSeq : 0, queue ? queue.depth : 0, body);
  }

  info(): RaceInfo {
    const cars: RaceCarInfo[] = this.cars
      .filter((car) => this.sim.cars[car.slot]!.active)
      .map((car) => ({ slot: car.slot, memberId: car.memberId, name: car.name, isBot: car.isBot, colour: car.colour }));
    return { raceId: this.raceId, trackId: this.trackId, laps: this.sim.laps, goTick: this.sim.goTick, cars };
  }
}
