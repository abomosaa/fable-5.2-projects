/**
 * A connected client as seen by the game logic. The actual socket hides
 * behind `Transport`, so the lobby and race code can be driven by real
 * WebSockets or by in-memory fakes in tests.
 */
import type { ErrorCode, ServerMessage } from '../../../shared/protocol';
import { StrikeCounter, TokenBucket } from '../security/rateLimit';
import { newId } from '../util/ids';

export interface Transport {
  send(data: string | Uint8Array): void;
  close(code: number, reason: string): void;
  /** Bytes queued for this client that the network has not accepted yet. */
  bufferedAmount(): number;
}

/** Opaque handle to the room membership of a connection (set by the lobby). */
export interface Seat {
  readonly roomCode: string;
  readonly memberId: string;
}

export class Connection {
  readonly id = newId(6);
  readonly connectedAt: number;
  lastSeenAt: number;
  /** True once a valid `hello` with a matching protocol version was received. */
  greeted = false;
  listSubscribed = false;
  closed = false;
  seat: Seat | null = null;
  /** Round trip time measured by the server (WebSocket ping/pong). */
  pingMs = 0;

  readonly limits: {
    message: TokenBucket;
    input: TokenBucket;
    list: TokenBucket;
    chat: TokenBucket;
    rename: TokenBucket;
    settings: TokenBucket;
    ping: TokenBucket;
  };
  /** Malformed / invalid messages. */
  readonly violations: StrikeCounter;
  /** Messages over the rate limits. */
  readonly flood: StrikeCounter;
  private lastRateNoticeAt = -Infinity;

  constructor(
    readonly transport: Transport,
    readonly ip: string,
    now: number,
    tickRate: number,
  ) {
    this.connectedAt = now;
    this.lastSeenAt = now;
    this.limits = {
      message: new TokenBucket(60, 30, now),
      // One input message per tick is normal. Allow bursts (a stalled TCP
      // connection delivers its backlog at once) without counting them as abuse.
      input: new TokenBucket(tickRate * 4, tickRate * 2, now),
      list: new TokenBucket(5, 2, now),
      chat: new TokenBucket(4, 0.7, now),
      rename: new TokenBucket(3, 0.2, now),
      settings: new TokenBucket(12, 5, now),
      ping: new TokenBucket(10, 4, now),
    };
    this.violations = new StrikeCounter(12, 0.2, now);
    this.flood = new StrikeCounter(tickRate * 25, tickRate * 2, now);
  }

  send(message: ServerMessage): void {
    if (this.closed) return;
    try {
      this.transport.send(JSON.stringify(message));
    } catch {
      // The socket died underneath us; the close handler will clean up.
    }
  }

  sendBinary(bytes: Uint8Array): void {
    if (this.closed) return;
    try {
      this.transport.send(bytes);
    } catch {
      // See send().
    }
  }

  error(code: ErrorCode, message: string, fatal = false, retryAfterMs?: number): void {
    this.send(retryAfterMs === undefined ? { t: 'error', code, message, fatal } : { t: 'error', code, message, fatal, retryAfterMs });
  }

  /** Sends a rate-limit error, itself rate limited so it cannot be used to amplify traffic. */
  rateLimited(now: number, what: string, retryAfterMs: number): void {
    if (now - this.lastRateNoticeAt < 1000) return;
    this.lastRateNoticeAt = now;
    this.error('rate_limited', `Slow down: too many ${what}.`, false, Math.max(250, retryAfterMs));
  }

  close(code: number, reason: string): void {
    if (this.closed) return;
    this.closed = true;
    try {
      this.transport.close(code, reason);
    } catch {
      // Already gone.
    }
  }
}
