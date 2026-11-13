/**
 * Client-side prediction and server reconciliation for the local car.
 *
 * The client applies each input immediately using the same deterministic
 * `stepCar` the server runs, and remembers every input the server has not yet
 * acknowledged. When an authoritative snapshot arrives, the predicted state is
 * replaced by the server's and the unacknowledged inputs are replayed on top.
 * Whatever difference remains (quantisation, collisions with other cars that
 * moved unexpectedly, dropped inputs) is hidden by a decaying visual offset
 * instead of a visible snap.
 *
 * Free of DOM and network dependencies so it can be tested headlessly.
 */
import { SIM_HZ } from '../../../shared/constants';
import { applyQCar, type QCar } from '../../../shared/protocol/binary';
import { collideCars } from '../../../shared/sim/collision';
import { angleDiff } from '../../../shared/sim/math';
import type { Track } from '../../../shared/sim/track';
import {
  collideWalls,
  makeCarState,
  makeTelemetry,
  stepCar,
  type CarInput,
  type CarState,
  type CarTelemetry,
} from '../../../shared/sim/vehicle';

export interface PendingInput {
  seq: number;
  input: CarInput;
}

/** Authoritative state of another car at the newest snapshot, used for contact prediction. */
export interface CarProxy {
  x: number;
  z: number;
  yaw: number;
  vx: number;
  vz: number;
  yawRate: number;
  frozen: boolean;
}

/** Unacknowledged inputs kept for replay; older ones are dropped. */
export const MAX_PENDING_INPUTS = 120;
/** Remote cars are dead-reckoned at most this far when predicting contact. */
export const MAX_PROXY_EXTRAPOLATION_TICKS = 15;
/** Corrections larger than this are shown immediately instead of smoothed. */
export const SNAP_DISTANCE = 6;
/** Per-tick decay of the visual correction offset. */
const OFFSET_DECAY = 0.86;

export class Predictor {
  /** Predicted state of the local car (authoritative state + unacknowledged inputs). */
  readonly state: CarState = makeCarState();
  readonly tel: CarTelemetry = makeTelemetry();
  readonly pending: PendingInput[] = [];
  nextSeq = 1;
  /** True once the first snapshot has told us where the server's sequence stands. */
  synced = false;
  /** Visual offset added to the predicted pose while a correction blends out. */
  offsetX = 0;
  offsetZ = 0;
  offsetYaw = 0;
  /** Size of the most recent correction in metres. */
  lastCorrection = 0;
  /** Largest wall impact predicted since it was last read. */
  wallHit = 0;
  /** Largest predicted car contact since it was last read. */
  carHit = 0;
  readonly stats = { reconciles: 0, snaps: 0, overflow: 0, maxCorrection: 0, sumCorrection: 0 };

  private readonly scratch: CarState = makeCarState();
  private proxies: readonly CarProxy[] = [];

  constructor(private readonly track: Track) {}

  /** Applies a fresh local input and returns its sequence number. */
  push(input: Readonly<CarInput>): number {
    const seq = this.nextSeq++;
    this.pending.push({ seq, input: { ...input } });
    if (this.pending.length > MAX_PENDING_INPUTS) {
      this.pending.shift();
      this.stats.overflow++;
    }
    this.step(input, this.pending.length);
    this.decayOffset();
    return seq;
  }

  /**
   * Rebuilds the prediction from an authoritative snapshot.
   * @param server   The local car in the snapshot.
   * @param ackSeq   Last input sequence number the server has simulated.
   * @param proxies  The other solid cars in the same snapshot.
   * @param teleported True when the server moved the car discontinuously (reset).
   * @returns the correction distance in metres.
   */
  reconcile(server: Readonly<QCar>, ackSeq: number, proxies: readonly CarProxy[], teleported: boolean): number {
    const { state, pending } = this;
    if (!this.synced) {
      // (Re)joining: adopt the server's sequence so new inputs are not stale.
      this.synced = true;
      this.nextSeq = Math.max(this.nextSeq, ackSeq + 1);
      pending.length = 0;
      teleported = true;
    }
    let drop = 0;
    while (drop < pending.length && pending[drop]!.seq <= ackSeq) drop++;
    if (drop > 0) pending.splice(0, drop);

    const beforeX = state.x + this.offsetX;
    const beforeZ = state.z + this.offsetZ;
    const beforeYaw = state.yaw + this.offsetYaw;

    applyQCar(server, state);
    this.proxies = proxies;
    for (let i = 0; i < pending.length; i++) this.step(pending[i]!.input, i + 1);

    const errX = beforeX - state.x;
    const errZ = beforeZ - state.z;
    const distance = Math.sqrt(errX * errX + errZ * errZ);
    this.stats.reconciles++;
    if (teleported || distance > SNAP_DISTANCE) {
      this.offsetX = 0;
      this.offsetZ = 0;
      this.offsetYaw = 0;
      if (!teleported) this.stats.snaps++;
    } else {
      // Keep rendering where we were and let the offset decay to zero.
      this.offsetX = errX;
      this.offsetZ = errZ;
      this.offsetYaw = angleDiff(beforeYaw, state.yaw);
      this.stats.sumCorrection += distance;
      if (distance > this.stats.maxCorrection) this.stats.maxCorrection = distance;
    }
    this.lastCorrection = teleported ? 0 : distance;
    return this.lastCorrection;
  }

  /** Forgets everything (new race, reconnect). */
  reset(): void {
    this.pending.length = 0;
    this.synced = false;
    this.offsetX = 0;
    this.offsetZ = 0;
    this.offsetYaw = 0;
    this.proxies = [];
    this.lastCorrection = 0;
    this.wallHit = 0;
    this.carHit = 0;
  }

  /** Rendered pose: prediction plus the remaining correction offset. */
  get renderX(): number {
    return this.state.x + this.offsetX;
  }

  get renderZ(): number {
    return this.state.z + this.offsetZ;
  }

  get renderYaw(): number {
    return this.state.yaw + this.offsetYaw;
  }

  private decayOffset(): void {
    this.offsetX *= OFFSET_DECAY;
    this.offsetZ *= OFFSET_DECAY;
    this.offsetYaw *= OFFSET_DECAY;
    if (Math.abs(this.offsetX) < 1e-4) this.offsetX = 0;
    if (Math.abs(this.offsetZ) < 1e-4) this.offsetZ = 0;
    if (Math.abs(this.offsetYaw) < 1e-5) this.offsetYaw = 0;
  }

  /** One predicted tick, `ticksAhead` ticks after the newest snapshot. */
  private step(input: Readonly<CarInput>, ticksAhead: number): void {
    const { state, tel, track, scratch } = this;
    stepCar(state, input, track, tel);
    if (tel.wallHit > this.wallHit) this.wallHit = tel.wallHit;
    if (state.frozen > 0) return;
    const ahead = Math.min(ticksAhead, MAX_PROXY_EXTRAPOLATION_TICKS) / SIM_HZ;
    for (const proxy of this.proxies) {
      const dt = proxy.frozen ? 0 : ahead;
      scratch.x = proxy.x + proxy.vx * dt;
      scratch.z = proxy.z + proxy.vz * dt;
      scratch.yaw = proxy.yaw + proxy.yawRate * dt;
      scratch.vx = proxy.vx;
      scratch.vz = proxy.vz;
      scratch.yawRate = proxy.yawRate;
      // Same response as on the server, applied to the local car only.
      const impact = collideCars(state, scratch, true, false);
      if (impact < 0) continue;
      if (impact > this.carHit) this.carHit = impact;
      collideWalls(state, track);
    }
  }
}
