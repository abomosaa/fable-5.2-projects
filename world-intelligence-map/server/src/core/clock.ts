/** Clock abstraction so fixture mode and tests are deterministic. */
export interface Clock {
  now(): number;
  /** 'system' for live mode; 'fixture' when time is simulated. */
  readonly kind: 'system' | 'fixture' | 'manual';
}

export const systemClock: Clock = { kind: 'system', now: () => Date.now() };

/**
 * Fixture clock: the demo world starts at a fixed instant (the fixture epoch) and then advances in real time.
 * Every run of the demo therefore begins from exactly the same state.
 */
export class FixtureClock implements Clock {
  readonly kind = 'fixture' as const;
  private readonly startedAt = Date.now();
  private offset = 0;
  constructor(readonly epoch: number, private readonly speed = 1) {}
  now(): number {
    return this.epoch + this.offset + (Date.now() - this.startedAt) * this.speed;
  }
  /** Temporarily shift the clock (used once at start-up to simulate an earlier session for the stale-data demo). */
  withOffset<T>(offsetMs: number, fn: () => Promise<T>): Promise<T> {
    this.offset = offsetMs;
    return fn().finally(() => {
      this.offset = 0;
    });
  }
}

export class ManualClock implements Clock {
  readonly kind = 'manual' as const;
  private offset = 0;
  constructor(private t: number) {}
  now(): number {
    return this.t + this.offset;
  }
  withOffset<T>(offsetMs: number, fn: () => Promise<T>): Promise<T> {
    this.offset = offsetMs;
    return fn().finally(() => {
      this.offset = 0;
    });
  }
  set(t: number): void {
    this.t = t;
  }
  advance(ms: number): void {
    this.t += ms;
  }
}
