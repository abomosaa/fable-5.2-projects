/**
 * Token-bucket rate limiting. `TokenBucket` guards a single stream (one
 * connection's chat, inputs, ...); `KeyedRateLimiter` keeps one bucket per key
 * (typically an IP address) and forgets idle keys so state cannot grow
 * without bound.
 */

export class TokenBucket {
  private tokens: number;
  private last: number;

  constructor(
    readonly capacity: number,
    readonly refillPerSecond: number,
    now: number,
  ) {
    this.tokens = capacity;
    this.last = now;
  }

  private refill(now: number): void {
    if (now > this.last) {
      this.tokens = Math.min(this.capacity, this.tokens + ((now - this.last) / 1000) * this.refillPerSecond);
      this.last = now;
    }
  }

  /** Takes `cost` tokens if available. */
  take(now: number, cost = 1): boolean {
    this.refill(now);
    if (this.tokens < cost) return false;
    this.tokens -= cost;
    return true;
  }

  /** Milliseconds until `cost` tokens are available. */
  retryAfterMs(now: number, cost = 1): number {
    this.refill(now);
    if (this.tokens >= cost) return 0;
    return Math.ceil(((cost - this.tokens) / this.refillPerSecond) * 1000);
  }

  get lastUsed(): number {
    return this.last;
  }

  get isFull(): boolean {
    return this.tokens >= this.capacity;
  }
}

export class KeyedRateLimiter {
  private readonly buckets = new Map<string, TokenBucket>();

  constructor(
    private readonly capacity: number,
    private readonly refillPerSecond: number,
    private readonly idleTtlMs = 120_000,
    private readonly maxKeys = 50_000,
  ) {}

  take(key: string, now: number, cost = 1): boolean {
    let bucket = this.buckets.get(key);
    if (!bucket) {
      if (this.buckets.size >= this.maxKeys) this.sweep(now, true);
      bucket = new TokenBucket(this.capacity, this.refillPerSecond, now);
      this.buckets.set(key, bucket);
    }
    return bucket.take(now, cost);
  }

  retryAfterMs(key: string, now: number): number {
    return this.buckets.get(key)?.retryAfterMs(now) ?? 0;
  }

  /** Drops buckets that have been idle for the TTL (or are simply full again). */
  sweep(now: number, aggressive = false): void {
    for (const [key, bucket] of this.buckets) {
      if (now - bucket.lastUsed > this.idleTtlMs || (aggressive && bucket.retryAfterMs(now, this.capacity) === 0)) {
        this.buckets.delete(key);
      }
    }
    // Last resort under a key-flooding attack: start over rather than grow.
    if (aggressive && this.buckets.size >= this.maxKeys) this.buckets.clear();
  }

  get size(): number {
    return this.buckets.size;
  }
}

/** Violation counter with linear decay; trips when sustained abuse is seen. */
export class StrikeCounter {
  private strikes = 0;
  private last: number;

  constructor(
    private readonly limit: number,
    private readonly decayPerSecond: number,
    now: number,
  ) {
    this.last = now;
  }

  /** Records `count` violations; returns true once the limit is exceeded. */
  add(now: number, count = 1): boolean {
    this.strikes = Math.max(0, this.strikes - ((now - this.last) / 1000) * this.decayPerSecond) + count;
    this.last = now;
    return this.strikes > this.limit;
  }

  get value(): number {
    return this.strikes;
  }
}
