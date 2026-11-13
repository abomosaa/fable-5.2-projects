/**
 * Network condition simulator: delays, jitters, drops, duplicates and
 * reorders messages. Used by the automated netcode tests (with a virtual
 * clock) and by the client's built-in debug "network simulator".
 *
 * Reliable messages (JSON control traffic, which a real WebSocket never loses
 * or reorders) are only delayed and stay in order. Loss, duplication and
 * reordering apply to unreliable realtime messages (inputs and snapshots),
 * which the protocol is designed to survive.
 */

export interface NetConditions {
  /** One-way base latency in ms. */
  latencyMs: number;
  /** Maximum extra random delay in ms. */
  jitterMs: number;
  /** Probability (0..1) of dropping an unreliable message. */
  loss: number;
  /** Probability (0..1) of delivering an unreliable message twice. */
  duplicate: number;
  /** Probability (0..1) of holding an unreliable message back so it arrives late. */
  reorder: number;
}

export const PERFECT_NETWORK: Readonly<NetConditions> = Object.freeze({
  latencyMs: 0,
  jitterMs: 0,
  loss: 0,
  duplicate: 0,
  reorder: 0,
});

export function isPerfect(c: Readonly<NetConditions>): boolean {
  return c.latencyMs <= 0 && c.jitterMs <= 0 && c.loss <= 0 && c.duplicate <= 0 && c.reorder <= 0;
}

interface Pending<T> {
  at: number;
  order: number;
  item: T;
}

export class ImpairedChannel<T> {
  conditions: NetConditions;
  delivered = 0;
  dropped = 0;
  duplicated = 0;
  private readonly random: () => number;
  private readonly queue: Pending<T>[] = [];
  private order = 0;
  private lastReliableAt = 0;

  constructor(conditions: NetConditions, random: () => number = Math.random) {
    this.conditions = { ...conditions };
    this.random = random;
  }

  get pending(): number {
    return this.queue.length;
  }

  /** Queues a message sent at `now` (ms). */
  send(item: T, now: number, reliable: boolean): void {
    const c = this.conditions;
    const delay = Math.max(0, c.latencyMs) + this.random() * Math.max(0, c.jitterMs);
    if (reliable) {
      const at = Math.max(now + delay, this.lastReliableAt);
      this.lastReliableAt = at;
      this.push(at, item);
      return;
    }
    if (c.loss > 0 && this.random() < c.loss) {
      this.dropped++;
      return;
    }
    let at = now + delay;
    if (c.reorder > 0 && this.random() < c.reorder) at += 20 + this.random() * 60;
    this.push(at, item);
    if (c.duplicate > 0 && this.random() < c.duplicate) {
      this.duplicated++;
      this.push(at + this.random() * 30, item);
    }
  }

  /** Returns every message due at `now`, in delivery order. */
  poll(now: number): T[] {
    if (this.queue.length === 0) return [];
    const due: Pending<T>[] = [];
    let w = 0;
    for (let i = 0; i < this.queue.length; i++) {
      const p = this.queue[i]!;
      if (p.at <= now) due.push(p);
      else this.queue[w++] = p;
    }
    this.queue.length = w;
    due.sort((a, b) => a.at - b.at || a.order - b.order);
    this.delivered += due.length;
    return due.map((p) => p.item);
  }

  /** Time (ms) of the next pending delivery, or Infinity. */
  nextAt(): number {
    let t = Infinity;
    for (const p of this.queue) if (p.at < t) t = p.at;
    return t;
  }

  clear(): void {
    this.queue.length = 0;
  }

  private push(at: number, item: T): void {
    this.queue.push({ at, order: this.order++, item });
  }
}

/** Parses "latency=120,jitter=40,loss=5,dup=2,reorder=3" (percentages for the last three). */
export function parseNetConditions(text: string): NetConditions {
  const out: NetConditions = { ...PERFECT_NETWORK };
  for (const part of text.split(/[,;&]/)) {
    const [rawKey, rawValue] = part.split(/[=:]/);
    const value = Number(rawValue);
    if (!rawKey || !Number.isFinite(value) || value < 0) continue;
    switch (rawKey.trim().toLowerCase()) {
      case 'latency':
      case 'lag':
        out.latencyMs = Math.min(value, 2000);
        break;
      case 'jitter':
        out.jitterMs = Math.min(value, 1000);
        break;
      case 'loss':
        out.loss = Math.min(value, 90) / 100;
        break;
      case 'dup':
      case 'duplicate':
        out.duplicate = Math.min(value, 90) / 100;
        break;
      case 'reorder':
        out.reorder = Math.min(value, 90) / 100;
        break;
      default:
        break;
    }
  }
  return out;
}
