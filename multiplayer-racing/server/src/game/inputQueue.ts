/**
 * Per-player buffer of received, not yet simulated inputs.
 *
 * The server consumes exactly one input per simulation tick, so a client can
 * never make its car act faster by sending inputs faster: extra inputs just
 * queue up, and a queue that grows too long is trimmed (never fast-forwarded).
 * Inputs carry client-chosen sequence numbers; duplicated, reordered and
 * stale ones are recognised and ignored, and each snapshot tells the client
 * which sequence number has been simulated so it can reconcile.
 */
import { INPUT_HOLD_TICKS, INPUT_QUEUE_MAX, INPUT_QUEUE_TARGET, INPUT_SEQ_WINDOW } from '../../../shared/constants';
import type { CarInput } from '../../../shared/sim/vehicle';

export interface InputQueueStats {
  accepted: number;
  duplicate: number;
  stale: number;
  /** Sequence numbers implausibly far in the future. */
  rejected: number;
  /** Inputs discarded because the queue overflowed. */
  trimmed: number;
  /** Ticks simulated without a fresh input. */
  starved: number;
}

interface Queued {
  seq: number;
  input: CarInput;
}

const COAST: Readonly<CarInput> = Object.freeze({ steer: 0, throttle: 0, brake: 0, handbrake: false, reset: false });

export class InputQueue {
  /** Sequence number of the newest input handed to the simulation. */
  lastConsumedSeq = 0;
  readonly stats: InputQueueStats = { accepted: 0, duplicate: 0, stale: 0, rejected: 0, trimmed: 0, starved: 0 };

  private readonly items: Queued[] = [];
  private highestSeq = 0;
  private held: CarInput = { ...COAST };
  private starvedTicks = 0;

  get depth(): number {
    return this.items.length;
  }

  /** Buffers a batch of consecutive inputs starting at `firstSeq`. */
  push(firstSeq: number, inputs: readonly CarInput[]): void {
    for (let i = 0; i < inputs.length; i++) {
      const seq = firstSeq + i;
      if (seq <= this.lastConsumedSeq) {
        this.stats.stale++;
        continue;
      }
      if (seq > Math.max(this.highestSeq, this.lastConsumedSeq) + INPUT_SEQ_WINDOW) {
        this.stats.rejected++;
        continue;
      }
      // Insert in order; batches overlap heavily, so scan from the back.
      let at = this.items.length;
      while (at > 0 && this.items[at - 1]!.seq > seq) at--;
      if (at > 0 && this.items[at - 1]!.seq === seq) {
        this.stats.duplicate++;
        continue;
      }
      this.items.splice(at, 0, { seq, input: { ...inputs[i]! } });
      if (seq > this.highestSeq) this.highestSeq = seq;
      this.stats.accepted++;
    }
    if (this.items.length > INPUT_QUEUE_MAX) {
      // The client fell behind real time (a stall or a burst). Skip the oldest
      // inputs instead of simulating them late; skipping can never be an
      // advantage and the client is told through the acknowledged sequence.
      const drop = this.items.length - INPUT_QUEUE_TARGET;
      const removed = this.items.splice(0, drop);
      this.lastConsumedSeq = removed[removed.length - 1]!.seq;
      this.stats.trimmed += drop;
    }
  }

  /** Returns the input to simulate this tick. Call exactly once per tick. */
  next(): Readonly<CarInput> {
    const head = this.items.shift();
    if (head) {
      this.lastConsumedSeq = head.seq;
      this.held = head.input;
      this.starvedTicks = 0;
      return head.input;
    }
    // Starved: briefly keep the last controls (hides jitter), then coast so a
    // stalled or vanished client cannot leave its car at full throttle.
    this.starvedTicks++;
    this.stats.starved++;
    if (this.starvedTicks <= INPUT_HOLD_TICKS) {
      if (this.held.reset) this.held = { ...this.held, reset: false };
      return this.held;
    }
    return COAST;
  }

  /** Forgets buffered inputs (player disconnected). Sequence state is kept. */
  clear(): void {
    this.items.length = 0;
    this.held = { ...COAST };
    this.starvedTicks = INPUT_HOLD_TICKS;
  }
}
