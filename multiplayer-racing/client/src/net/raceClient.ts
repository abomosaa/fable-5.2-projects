/**
 * Client-side view of one race.
 *
 * Consumes authoritative snapshots, predicts the local car, interpolates the
 * others and produces the input stream for the server. It never decides
 * anything about the race: positions, laps, times and results all come from
 * the server; this class only makes them look smooth and feel immediate.
 *
 * Deliberately free of DOM, WebSocket and rendering dependencies: bytes go in
 * through `onSnapshot`, bytes go out through the `send` callback, and time is
 * whatever the caller says it is. That is what lets the automated tests run
 * it against a real server under simulated latency, jitter and loss.
 */
import { CLIENT_SNAPSHOT_HISTORY, MAX_INPUTS_PER_MESSAGE, MAX_RACERS, TICK_MS } from '../../../shared/constants';
import {
  CarFlag,
  RacePhaseCode,
  decodeSnapshot,
  encodeInput,
  peekSnapshot,
  type QCar,
  type RaceInfo,
  type Snapshot,
  type SnapshotBody,
} from '../../../shared/protocol';
import { clamp, lerp, lerpAngle } from '../../../shared/sim/math';
import { checkpointOf, lapsCompleted } from '../../../shared/sim/race';
import type { Track } from '../../../shared/sim/track';
import { NEUTRAL_INPUT, type CarInput } from '../../../shared/sim/vehicle';
import { ArrivalClock, CarTrack, makePose, sampleFromQCar, type CarPose } from './interpolation';
import { Predictor, type CarProxy } from './prediction';

/** No snapshot for this long: the connection is considered stalled and prediction pauses. */
export const STALL_MS = 1500;
/** No snapshot for this long: show a degraded-connection warning. */
export const DEGRADED_MS = 400;
/** Fixed steps run per update at most: enough to hold 60 Hz input down to ~5 fps. */
const MAX_STEPS_PER_UPDATE = 12;
/** If nothing was sent for this long (hidden tab), acknowledge straight from the receive path. */
const ACK_KEEPALIVE_MS = 200;
const TARGET_QUEUE_DEPTH = 2;
const MAX_TARGET_QUEUE_DEPTH = 6;
const HANDOFF_DECAY = 0.95;

export type RaceClientEvent =
  | { type: 'go' }
  | { type: 'checkpoint'; slot: number; local: boolean; cp: number; ms: number }
  | { type: 'lap'; slot: number; local: boolean; lap: number; ms: number; best: boolean }
  | { type: 'finish'; slot: number; local: boolean; ms: number; rank: number }
  | { type: 'impact'; slot: number; local: boolean; kind: 'wall' | 'car'; strength: number }
  | { type: 'penalty'; slot: number; local: boolean }
  | { type: 'reset'; slot: number; local: boolean }
  | { type: 'position'; from: number; to: number };

export interface CarView {
  slot: number;
  present: boolean;
  isLocal: boolean;
  x: number;
  z: number;
  yaw: number;
  vx: number;
  vz: number;
  yawRate: number;
  /** Steering position, -1..1 (positive = right). */
  steer: number;
  throttle: number;
  brake: number;
  flags: number;
  speed: number;
  forwardSpeed: number;
  /** 0..1 sliding intensity, for smoke, skid marks and sound. */
  slip: number;
  /** 0..1 how far onto the run-off the car is. */
  offroad: number;
  /** True when the car is held because its data is too old. */
  stale: boolean;
  // Authoritative progress, straight from the newest snapshot.
  cp: number;
  rank: number;
  frozen: number;
  penalty: number;
  cpMs: number;
  lapStartMs: number;
  lastLapMs: number;
  bestLapMs: number;
  finishMs: number;
}

export interface RaceView {
  /** Indexed by slot; check `present`. */
  cars: CarView[];
  localSlot: number;
  /** True while the local car is driven by client-side prediction. */
  predicting: boolean;
  hasData: boolean;
  /** RacePhaseCode. */
  phase: number;
  /** The viewer's position on the race timeline, in (fractional) ticks. */
  tick: number;
  goTick: number;
  /** Ticks until the green light on the viewer's timeline (0 once racing). */
  countdownTicks: number;
  /** Milliseconds of race time on the viewer's timeline. */
  raceMs: number;
  /** Tick at which the finish timeout ends the race, 0 if not running. */
  endsAtTick: number;
}

export interface RaceClientStats {
  snapshots: number;
  fullSnapshots: number;
  duplicates: number;
  outOfOrder: number;
  invalid: number;
  missingBase: number;
  wrongRace: number;
  bytesIn: number;
  bytesOut: number;
  inputsSent: number;
  droppedSteps: number;
  /** Smoothed fraction of snapshots that were late or lost. */
  loss: number;
}

export interface RaceClientOptions {
  track: Track;
  race: RaceInfo;
  /** Grid slot of the local player, or -1 when spectating. */
  slot: number;
  /** Server ticks per wall-clock second. */
  tickRate: number;
  snapshotEvery: number;
  send: (bytes: Uint8Array) => void;
}

function makeCarView(slot: number): CarView {
  return {
    slot,
    present: false,
    isLocal: false,
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
    speed: 0,
    forwardSpeed: 0,
    slip: 0,
    offroad: 0,
    stale: false,
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
}

export class RaceClient {
  readonly track: Track;
  readonly race: RaceInfo;
  readonly slot: number;
  readonly predictor: Predictor;
  readonly clock: ArrivalClock;
  readonly stats: RaceClientStats = {
    snapshots: 0,
    fullSnapshots: 0,
    duplicates: 0,
    outOfOrder: 0,
    invalid: 0,
    missingBase: 0,
    wrongRace: 0,
    bytesIn: 0,
    bytesOut: 0,
    inputsSent: 0,
    droppedSteps: 0,
    loss: 0,
  };
  /** Events since the last `drainEvents` call. */
  private readonly events: RaceClientEvent[] = [];
  /** Newest authoritative snapshot, or null before the first one. */
  latest: Snapshot | null = null;
  /** Local time (ms) the newest snapshot arrived. */
  lastSnapshotAt = -1;
  /** Client tick rate multiplier used to keep the server's input queue shallow. */
  timeScale = 1;
  /** Smoothed depth of our input queue on the server. */
  queueDepth = TARGET_QUEUE_DEPTH;

  private readonly raceTag: number;
  private readonly gateCount: number;
  private readonly tickRate: number;
  private readonly snapshotEvery: number;
  private readonly send: (bytes: Uint8Array) => void;
  private readonly history = new Map<number, SnapshotBody>();
  private readonly tracks: CarTrack[] = [];
  private readonly pose: CarPose = makePose();
  private readonly viewState: RaceView;
  private readonly prevFlags = new Int32Array(MAX_RACERS).fill(-1);
  private readonly prevCp = new Int32Array(MAX_RACERS);
  private needFull = true;
  private lastSentAt = -Infinity;
  private lastUpdateAt = -1;
  private accumulator = 0;
  private ticksSinceAck = 0;
  private wentGreen = false;
  private lastRank = 0;
  // Pose of the predicted car one client tick ago, for sub-tick rendering.
  private prevX = 0;
  private prevZ = 0;
  private prevYaw = 0;
  private hasPrev = false;
  private wasPredicting = false;
  // Blend from the predicted pose to the interpolated one after finishing.
  private handoffX = 0;
  private handoffZ = 0;
  private handoffYaw = 0;
  private lastLocalX = 0;
  private lastLocalZ = 0;
  private lastLocalYaw = 0;

  constructor(options: RaceClientOptions) {
    this.track = options.track;
    this.race = options.race;
    this.slot = options.slot;
    this.tickRate = options.tickRate;
    this.snapshotEvery = options.snapshotEvery;
    this.send = options.send;
    this.raceTag = options.race.raceId & 0xff;
    this.gateCount = options.track.gates.length;
    this.predictor = new Predictor(options.track);
    this.clock = new ArrivalClock(options.tickRate, options.snapshotEvery);
    for (let i = 0; i < MAX_RACERS; i++) this.tracks.push(new CarTrack());
    this.viewState = {
      cars: Array.from({ length: MAX_RACERS }, (_, i) => makeCarView(i)),
      localSlot: options.slot,
      predicting: false,
      hasData: false,
      phase: RacePhaseCode.countdown,
      tick: 0,
      goTick: options.race.goTick,
      countdownTicks: options.race.goTick,
      raceMs: 0,
      endsAtTick: 0,
    };
  }

  // ------------------------------------------------------------- snapshots

  /** Feeds one binary frame from the server. Safe against garbage, duplicates and reordering. */
  onSnapshot(bytes: Uint8Array, nowMs: number): void {
    const peek = peekSnapshot(bytes);
    if (!peek) {
      this.stats.invalid++;
      return;
    }
    if (peek.raceId !== this.raceTag) {
      // A straggler from the previous race in this room.
      this.stats.wrongRace++;
      return;
    }
    this.stats.bytesIn += bytes.byteLength;
    if (this.history.has(peek.tick)) {
      this.stats.duplicates++;
      return;
    }
    const decoded = decodeSnapshot(bytes, (tick) => this.history.get(tick));
    if (!decoded.ok) {
      if (decoded.missingBase !== undefined) {
        // We no longer hold the baseline: ask for a complete snapshot.
        this.stats.missingBase++;
        this.needFull = true;
      } else {
        this.stats.invalid++;
      }
      return;
    }
    const snapshot = decoded.value;
    this.stats.snapshots++;
    if (snapshot.baseTick === 0) this.stats.fullSnapshots++;
    this.remember(snapshot);
    for (const car of snapshot.cars) this.tracks[car.slot]!.push(sampleFromQCar(snapshot.tick, car));

    const previous = this.latest;
    if (previous && snapshot.tick < previous.tick) {
      // Arrived late: still useful as history and as a delta baseline.
      this.stats.outOfOrder++;
      return;
    }
    if (previous) {
      const missed = Math.round((snapshot.tick - previous.tick) / this.snapshotEvery) - 1;
      for (let i = 0; i < Math.min(missed, 20); i++) this.stats.loss = this.stats.loss * 0.97 + 0.03;
    }
    this.stats.loss *= 0.97;
    this.latest = snapshot;
    this.needFull = false;
    this.lastSnapshotAt = nowMs;
    this.clock.observe(snapshot.tick, nowMs);
    this.detectEvents(snapshot);
    this.reconcile(snapshot);
    // Browsers stop running frames for hidden tabs but still deliver messages.
    // Keep acknowledging from here so the server can go on sending deltas.
    if (nowMs - this.lastSentAt > ACK_KEEPALIVE_MS) this.sendAck(nowMs);
  }

  private remember(snapshot: Snapshot): void {
    this.history.set(snapshot.tick, snapshot);
    if (this.history.size > CLIENT_SNAPSHOT_HISTORY) {
      let oldest = Infinity;
      for (const tick of this.history.keys()) if (tick < oldest) oldest = tick;
      this.history.delete(oldest);
    }
  }

  private reconcile(snapshot: Snapshot): void {
    if (this.slot < 0) return;
    const mine = snapshot.cars.find((car) => car.slot === this.slot);
    if (!mine || mine.flags & CarFlag.FINISHED) return;
    const proxies: CarProxy[] = [];
    for (const car of snapshot.cars) {
      if (car.slot === this.slot || car.flags & CarFlag.FINISHED) continue;
      const sample = sampleFromQCar(snapshot.tick, car);
      proxies.push({
        x: sample.x,
        z: sample.z,
        yaw: sample.yaw,
        vx: sample.vx,
        vz: sample.vz,
        yawRate: sample.yawRate,
        frozen: car.frozen > 0,
      });
    }
    const before = this.prevFlags[this.slot]!;
    const teleported = before >= 0 && ((before ^ mine.flags) & CarFlag.RESET_TOGGLE) !== 0;
    if (teleported) this.hasPrev = false;
    this.predictor.reconcile(mine, snapshot.ackSeq, proxies, teleported);
    // Keep the server's input queue shallow but never empty.
    this.queueDepth += (snapshot.queueDepth - this.queueDepth) * 0.1;
    const target = clamp(TARGET_QUEUE_DEPTH + this.clock.latenessTicks * 0.5, TARGET_QUEUE_DEPTH, MAX_TARGET_QUEUE_DEPTH);
    this.timeScale = 1 + clamp((target - this.queueDepth) * 0.015, -0.05, 0.05);
  }

  private detectEvents(snapshot: Snapshot): void {
    for (const car of snapshot.cars) {
      const slot = car.slot;
      const local = slot === this.slot;
      const before = this.prevFlags[slot]!;
      const prevCp = this.prevCp[slot]!;
      if (before >= 0) {
        if (car.cp > prevCp) {
          this.events.push({ type: 'checkpoint', slot, local, cp: car.cp, ms: car.cpMs });
          if (car.cp > 1 && checkpointOf(car.cp, this.gateCount) === 0) {
            const lap = lapsCompleted(car.cp, this.gateCount);
            this.events.push({
              type: 'lap',
              slot,
              local,
              lap,
              ms: car.lastLapMs,
              best: car.lastLapMs > 0 && car.lastLapMs === car.bestLapMs,
            });
          }
        }
        if (car.flags & CarFlag.FINISHED && !(before & CarFlag.FINISHED)) {
          this.events.push({ type: 'finish', slot, local, ms: car.finishMs, rank: car.rank });
        }
        if ((before ^ car.flags) & CarFlag.RESET_TOGGLE) this.events.push({ type: 'reset', slot, local });
        // The local car reports its own impacts from prediction, which is immediate.
        if (!local || !this.wasPredicting) {
          if (car.flags & CarFlag.WALL_HIT) this.events.push({ type: 'impact', slot, local, kind: 'wall', strength: 4 });
          if (car.flags & CarFlag.CAR_HIT) this.events.push({ type: 'impact', slot, local, kind: 'car', strength: 4 });
        }
        if (car.flags & CarFlag.PENALTY_ISSUED) this.events.push({ type: 'penalty', slot, local });
      }
      if (local) {
        if (this.lastRank > 0 && car.rank !== this.lastRank && snapshot.phase === RacePhaseCode.racing) {
          this.events.push({ type: 'position', from: this.lastRank, to: car.rank });
        }
        this.lastRank = car.rank;
      }
      this.prevFlags[slot] = car.flags;
      this.prevCp[slot] = car.cp;
    }
  }

  // ------------------------------------------------------------------ ticks

  /**
   * Advances the client by the time elapsed since the last call, in fixed
   * steps. `sampleInput` is called once per step while the local car is being
   * predicted.
   */
  update(nowMs: number, sampleInput: () => Readonly<CarInput>): void {
    if (this.lastUpdateAt < 0) this.lastUpdateAt = nowMs;
    const stepMs = 1000 / (this.tickRate * this.timeScale);
    this.accumulator += Math.max(0, nowMs - this.lastUpdateAt);
    this.lastUpdateAt = nowMs;
    let steps = 0;
    while (this.accumulator >= stepMs && steps < MAX_STEPS_PER_UPDATE) {
      this.accumulator -= stepMs;
      steps++;
      this.step(nowMs, sampleInput);
    }
    if (this.accumulator >= stepMs) {
      // Hidden tab or a long frame: never try to replay the lost time.
      this.stats.droppedSteps += Math.floor(this.accumulator / stepMs);
      this.accumulator = 0;
    }
  }

  /** True while local inputs are being predicted and sent. */
  get predicting(): boolean {
    if (this.slot < 0 || !this.latest || !this.predictor.synced) return false;
    const mine = this.latest.cars.find((car) => car.slot === this.slot);
    return mine !== undefined && !(mine.flags & CarFlag.FINISHED);
  }

  /** Milliseconds since the last snapshot (0 before the first). */
  silenceMs(nowMs: number): number {
    return this.lastSnapshotAt < 0 ? 0 : Math.max(0, nowMs - this.lastSnapshotAt);
  }

  private step(nowMs: number, sampleInput: () => Readonly<CarInput>): void {
    const stalled = this.silenceMs(nowMs) > STALL_MS;
    const predicting = this.predicting && !stalled;
    if (predicting) {
      const p = this.predictor;
      this.prevX = p.renderX;
      this.prevZ = p.renderZ;
      this.prevYaw = p.renderYaw;
      this.hasPrev = true;
      const input = sampleInput();
      const wasFrozen = p.state.frozen > 0;
      p.push(input);
      if (p.wallHit > 2) {
        this.events.push({ type: 'impact', slot: this.slot, local: true, kind: 'wall', strength: p.wallHit });
      }
      if (p.carHit > 2) {
        this.events.push({ type: 'impact', slot: this.slot, local: true, kind: 'car', strength: p.carHit });
      }
      p.wallHit = 0;
      p.carHit = 0;
      if (wasFrozen && p.state.frozen === 0 && !this.wentGreen && this.latest && this.latest.phase !== RacePhaseCode.finished) {
        this.wentGreen = true;
        this.events.push({ type: 'go' });
      }
      this.sendInputs(nowMs);
    } else {
      this.hasPrev = false;
      // Spectators (and stalled or finished drivers) still acknowledge
      // snapshots so the server can keep sending small deltas.
      if (++this.ticksSinceAck >= this.snapshotEvery * 2) this.sendAck(nowMs);
      if (!this.wentGreen && this.latest && this.clock.ready && this.clock.renderTick(nowMs) >= this.latest.goTick) {
        this.wentGreen = true;
        if (this.latest.phase !== RacePhaseCode.finished) this.events.push({ type: 'go' });
      }
    }
    if (this.wasPredicting && !predicting && !stalled) this.beginHandoff(nowMs);
    this.wasPredicting = predicting;
    this.handoffX *= HANDOFF_DECAY;
    this.handoffZ *= HANDOFF_DECAY;
    this.handoffYaw *= HANDOFF_DECAY;
  }

  private beginHandoff(nowMs: number): void {
    // The server took over our car (finished). Blend from where we drew it to
    // where interpolation puts it, instead of jumping back in time.
    if (this.slot < 0 || !this.clock.ready) return;
    if (!this.tracks[this.slot]!.sample(this.clock.renderTick(nowMs), this.pose)) return;
    this.handoffX = this.lastLocalX - this.pose.x;
    this.handoffZ = this.lastLocalZ - this.pose.z;
    this.handoffYaw = Math.atan2(Math.sin(this.lastLocalYaw - this.pose.yaw), Math.cos(this.lastLocalYaw - this.pose.yaw));
    if (Math.hypot(this.handoffX, this.handoffZ) > 60) {
      this.handoffX = 0;
      this.handoffZ = 0;
      this.handoffYaw = 0;
    }
  }

  private sendInputs(nowMs: number): void {
    const pending = this.predictor.pending;
    // Each message repeats the most recent unacknowledged inputs, so a lost or
    // late message costs nothing as long as a later one arrives.
    const count = Math.min(pending.length, MAX_INPUTS_PER_MESSAGE);
    const first = pending.length - count;
    const inputs: CarInput[] = [];
    for (let i = first; i < pending.length; i++) inputs.push(pending[i]!.input);
    this.transmit({
      raceId: this.raceTag,
      ackSnapTick: this.ackTick(),
      clientTime: Math.floor(nowMs) >>> 0,
      firstSeq: count > 0 ? pending[first]!.seq : 0,
      inputs,
    });
    this.stats.inputsSent++;
    this.ticksSinceAck = 0;
    this.lastSentAt = nowMs;
  }

  private sendAck(nowMs: number): void {
    this.ticksSinceAck = 0;
    this.lastSentAt = nowMs;
    this.transmit({
      raceId: this.raceTag,
      ackSnapTick: this.ackTick(),
      clientTime: Math.floor(nowMs) >>> 0,
      firstSeq: 0,
      inputs: [],
    });
  }

  private ackTick(): number {
    return this.needFull || !this.latest ? 0 : this.latest.tick;
  }

  private transmit(message: Parameters<typeof encodeInput>[0]): void {
    const bytes = encodeInput(message);
    this.stats.bytesOut += bytes.byteLength;
    this.send(bytes);
  }

  drainEvents(): RaceClientEvent[] {
    return this.events.splice(0, this.events.length);
  }

  // ------------------------------------------------------------------- view

  /** Builds what should be drawn at local time `nowMs`. The result is reused between calls. */
  view(nowMs: number): RaceView {
    const view = this.viewState;
    const latest = this.latest;
    view.hasData = latest !== null && this.clock.ready;
    if (!latest || !this.clock.ready) {
      for (const car of view.cars) car.present = false;
      view.predicting = false;
      return view;
    }
    const stalled = this.silenceMs(nowMs) > STALL_MS;
    const predicting = this.predicting;
    const renderTick = this.clock.renderTick(nowMs);
    const stepMs = 1000 / (this.tickRate * this.timeScale);
    const alpha = clamp(this.accumulator / stepMs, 0, 1);

    for (const car of view.cars) car.present = false;
    for (const q of latest.cars) {
      const car = view.cars[q.slot]!;
      car.present = true;
      car.isLocal = q.slot === this.slot;
      copyProgress(q, car);

      if (car.isLocal && predicting) {
        const p = this.predictor;
        if (this.hasPrev && !stalled) {
          car.x = lerp(this.prevX, p.renderX, alpha);
          car.z = lerp(this.prevZ, p.renderZ, alpha);
          car.yaw = lerpAngle(this.prevYaw, p.renderYaw, alpha);
        } else {
          car.x = p.renderX;
          car.z = p.renderZ;
          car.yaw = p.renderYaw;
        }
        car.vx = p.state.vx;
        car.vz = p.state.vz;
        car.yawRate = p.state.yawRate;
        car.steer = p.state.steer;
        const input = p.pending.length > 0 ? p.pending[p.pending.length - 1]!.input : NEUTRAL_INPUT;
        car.throttle = input.throttle / 255;
        car.brake = input.brake / 255;
        car.flags = q.flags;
        car.frozen = p.state.frozen;
        car.penalty = p.state.penalty;
        car.speed = p.tel.speed;
        car.forwardSpeed = p.tel.forwardSpeed;
        car.slip = clamp((p.tel.slip - 0.55) / 1.2, 0, 1);
        car.offroad = p.tel.offroad;
        car.stale = stalled;
        this.lastLocalX = car.x;
        this.lastLocalZ = car.z;
        this.lastLocalYaw = car.yaw;
        continue;
      }

      const pose = this.pose;
      if (!this.tracks[q.slot]!.sample(renderTick, pose)) {
        car.present = false;
        continue;
      }
      car.x = pose.x;
      car.z = pose.z;
      car.yaw = pose.yaw;
      if (car.isLocal) {
        car.x += this.handoffX;
        car.z += this.handoffZ;
        car.yaw += this.handoffYaw;
      }
      car.vx = pose.vx;
      car.vz = pose.vz;
      car.yawRate = pose.yawRate;
      car.steer = pose.steer;
      car.throttle = pose.throttle;
      car.brake = pose.brake;
      car.flags = pose.flags;
      car.speed = Math.hypot(pose.vx, pose.vz);
      car.forwardSpeed = pose.vx * Math.sin(pose.yaw) + pose.vz * Math.cos(pose.yaw);
      car.slip = pose.flags & CarFlag.DRIFT ? 0.8 : 0;
      car.offroad = pose.flags & CarFlag.OFFROAD ? 1 : 0;
      car.stale = pose.stale;
    }

    view.predicting = predicting;
    view.phase = latest.phase;
    view.goTick = latest.goTick;
    view.endsAtTick = latest.endsAtTick;
    // A driver lives slightly in the server's future (by their latency), so
    // the lights they see match the moment their inputs take effect.
    view.tick = predicting ? latest.tick + this.predictor.pending.length - 1 + alpha : renderTick;
    view.countdownTicks = Math.max(0, latest.goTick - view.tick);
    view.raceMs = Math.max(0, (view.tick - latest.goTick) * TICK_MS);
    return view;
  }
}

function copyProgress(q: Readonly<QCar>, car: CarView): void {
  car.cp = q.cp;
  car.rank = q.rank;
  car.frozen = q.frozen;
  car.penalty = q.penalty;
  car.cpMs = q.cpMs;
  car.lapStartMs = q.lapStartMs;
  car.lastLapMs = q.lastLapMs;
  car.bestLapMs = q.bestLapMs;
  car.finishMs = q.finishMs;
}
