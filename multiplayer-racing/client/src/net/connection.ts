/**
 * WebSocket connection to the game server: handshake and version check,
 * validation of everything received, latency measurement, automatic
 * reconnection with backoff, and an optional network-condition simulator.
 *
 * Works in browsers and in Node (tests pass their own WebSocket class).
 */
import { MAX_SERVER_MESSAGE_BYTES } from '../../../shared/constants';
import { ImpairedChannel, PERFECT_NETWORK, isPerfect, type NetConditions } from '../../../shared/net/netsim';
import {
  CLOSE,
  PROTOCOL_VERSION,
  parseServerMessage,
  type ClientMessage,
  type ServerMessage,
  type ServerMessageMap,
} from '../../../shared/protocol';

export type ConnectionStatus =
  /** Not started, or closed on purpose. */
  | 'idle'
  /** First connection attempt in progress. */
  | 'connecting'
  /** Handshake complete; messages flow. */
  | 'open'
  /** Lost the connection; retrying automatically. */
  | 'reconnecting'
  /** Gave up for a reason retrying cannot fix (see `failure`). */
  | 'failed';

export type FailureKind = 'version_mismatch' | 'replaced' | 'kicked' | 'rejected';

export interface ConnectionFailure {
  kind: FailureKind;
  message: string;
}

/** The subset of the WebSocket API this module relies on. */
export interface SocketLike {
  binaryType: string;
  readonly readyState: number;
  onopen: ((event: unknown) => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose: ((event: { code: number; reason: string }) => void) | null;
  onerror: ((event: unknown) => void) | null;
  send(data: string | ArrayBufferLike | ArrayBufferView): void;
  close(code?: number, reason?: string): void;
}

export type SocketFactory = (url: string) => SocketLike;

export interface ConnectionHandlers {
  onStatus?(status: ConnectionStatus, failure: ConnectionFailure | null): void;
  /** Handshake finished (also after every reconnect). */
  onWelcome?(welcome: ServerMessageMap['welcome'], reconnected: boolean): void;
  onMessage?(message: ServerMessage): void;
  onBinary?(bytes: Uint8Array): void;
}

export interface ConnectionOptions {
  url: string;
  handlers: ConnectionHandlers;
  createSocket?: SocketFactory;
  now?: () => number;
  /** Overrides the protocol version sent in `hello` (used by tests). */
  protocolVersion?: number;
  build?: string;
}

const PING_INTERVAL_MS = 2000;
const BACKOFF_MS = [400, 800, 1500, 3000, 5000, 8000];
const OPEN = 1;

type Outgoing = { reliable: boolean; data: string | Uint8Array };
type Incoming = { text: string | null; bytes: Uint8Array | null };

export class GameConnection {
  status: ConnectionStatus = 'idle';
  failure: ConnectionFailure | null = null;
  /** Smoothed round trip time in ms (0 until measured). */
  rttMs = 0;
  /** Number of consecutive failed connection attempts. */
  attempts = 0;
  welcome: ServerMessageMap['welcome'] | null = null;
  /** Human readable reason for the most recent disconnect, if the server gave one. */
  lastServerNotice = '';
  readonly counters = { invalidMessages: 0, oversized: 0, reconnects: 0 };

  private socket: SocketLike | null = null;
  private readonly handlers: ConnectionHandlers;
  private readonly createSocket: SocketFactory;
  private readonly now: () => number;
  private readonly url: string;
  private readonly protocolVersion: number;
  private readonly build: string;
  private everOpened = false;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private pumpTimer: ReturnType<typeof setInterval> | null = null;
  private pingId = 0;
  private readonly pingSent = new Map<number, number>();
  private conditions: NetConditions = { ...PERFECT_NETWORK };
  private readonly outbound = new ImpairedChannel<Outgoing>(PERFECT_NETWORK);
  private readonly inbound = new ImpairedChannel<Incoming>(PERFECT_NETWORK);

  constructor(options: ConnectionOptions) {
    this.url = options.url;
    this.handlers = options.handlers;
    this.now = options.now ?? (() => performance.now());
    this.protocolVersion = options.protocolVersion ?? PROTOCOL_VERSION;
    this.build = options.build ?? 'web';
    this.createSocket =
      options.createSocket ?? ((url) => new WebSocket(url) as unknown as SocketLike);
  }

  get isOpen(): boolean {
    return this.status === 'open';
  }

  /** Simulated network conditions applied to all traffic (debug/testing aid). */
  get netConditions(): Readonly<NetConditions> {
    return this.conditions;
  }

  setNetConditions(conditions: NetConditions): void {
    this.conditions = { ...conditions };
    this.outbound.conditions = { ...conditions };
    this.inbound.conditions = { ...conditions };
    this.syncPump();
  }

  private syncPump(): void {
    const wanted = !isPerfect(this.conditions) && this.status !== 'idle' && this.status !== 'failed';
    if (wanted && !this.pumpTimer) {
      this.pumpTimer = setInterval(() => this.pump(this.now()), 4);
    } else if (!wanted && this.pumpTimer) {
      // Flush anything still in flight, then stop pumping.
      this.pump(Infinity);
      clearInterval(this.pumpTimer);
      this.pumpTimer = null;
    }
  }

  connect(): void {
    if (this.status === 'connecting' || this.status === 'open' || this.status === 'reconnecting') return;
    this.failure = null;
    this.attempts = 0;
    this.setStatus('connecting');
    this.open();
  }

  /** Closes the connection for good (no reconnect). */
  close(): void {
    this.clearTimers();
    const socket = this.socket;
    this.socket = null;
    if (socket) {
      socket.onclose = null;
      socket.onmessage = null;
      socket.onerror = null;
      socket.onopen = null;
      try {
        socket.close(1000, 'bye');
      } catch {
        // Already closed.
      }
    }
    this.outbound.clear();
    this.inbound.clear();
    this.setStatus('idle');
  }

  /** Drops the socket without telling anyone, as a network failure would (testing aid). */
  simulateDrop(): void {
    try {
      this.socket?.close(4999, 'simulated drop');
    } catch {
      // Ignore.
    }
  }

  send(message: ClientMessage): void {
    this.transmit(JSON.stringify(message), true);
  }

  sendBinary(bytes: Uint8Array): void {
    this.transmit(bytes, false);
  }

  private transmit(data: string | Uint8Array, reliable: boolean): void {
    if (this.status !== 'open') return;
    if (this.pumpTimer) this.outbound.send({ reliable, data }, this.now(), reliable);
    else this.rawSend(data);
  }

  private rawSend(data: string | Uint8Array): void {
    const socket = this.socket;
    if (!socket || socket.readyState !== OPEN) return;
    try {
      socket.send(data);
    } catch {
      // The close handler deals with dead sockets.
    }
  }

  private pump(now: number): void {
    for (const out of this.outbound.poll(now)) this.rawSend(out.data);
    for (const item of this.inbound.poll(now)) {
      if (item.text !== null) this.handleText(item.text);
      else if (item.bytes) this.handlers.onBinary?.(item.bytes);
    }
  }

  private open(): void {
    let socket: SocketLike;
    try {
      socket = this.createSocket(this.url);
    } catch {
      this.scheduleRetry();
      return;
    }
    socket.binaryType = 'arraybuffer';
    this.socket = socket;
    this.welcome = null;

    socket.onopen = () => {
      if (this.socket !== socket) return;
      this.rawSend(JSON.stringify({ t: 'hello', protocol: this.protocolVersion, build: this.build } satisfies ClientMessage));
    };
    socket.onmessage = (event) => {
      if (this.socket !== socket) return;
      const data = event.data;
      if (typeof data === 'string') {
        if (data.length > MAX_SERVER_MESSAGE_BYTES) {
          this.counters.oversized++;
          return;
        }
        if (this.pumpTimer) this.inbound.send({ text: data, bytes: null }, this.now(), true);
        else this.handleText(data);
        return;
      }
      let bytes: Uint8Array | null = null;
      if (data instanceof ArrayBuffer) bytes = new Uint8Array(data);
      else if (ArrayBuffer.isView(data)) bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
      if (!bytes) return;
      if (bytes.byteLength > MAX_SERVER_MESSAGE_BYTES) {
        this.counters.oversized++;
        return;
      }
      if (this.pumpTimer) this.inbound.send({ text: null, bytes }, this.now(), false);
      else this.handlers.onBinary?.(bytes);
    };
    socket.onerror = () => {
      // Always followed by onclose; nothing to do here.
    };
    socket.onclose = (event) => {
      if (this.socket !== socket) return;
      this.socket = null;
      this.stopPinging();
      this.outbound.clear();
      this.inbound.clear();
      this.onClosed(event.code);
    };
  }

  private handleText(text: string): void {
    // Never trust the wire, not even the server's side of it.
    const parsed = parseServerMessage(text);
    if (!parsed.ok) {
      this.counters.invalidMessages++;
      return;
    }
    const message = parsed.value;
    switch (message.t) {
      case 'welcome': {
        if (message.protocol !== this.protocolVersion) {
          this.fail('version_mismatch', 'The server runs a different version of the game. Reload the page to update.');
          return;
        }
        const reconnected = this.everOpened;
        this.everOpened = true;
        this.welcome = message;
        this.attempts = 0;
        this.lastServerNotice = '';
        if (reconnected) this.counters.reconnects++;
        this.setStatus('open');
        this.startPinging();
        this.handlers.onWelcome?.(message, reconnected);
        return;
      }
      case 'pong': {
        const sentAt = this.pingSent.get(message.id);
        if (sentAt === undefined) return; // Duplicate or unsolicited.
        this.pingSent.delete(message.id);
        const sample = Math.max(0, this.now() - sentAt);
        this.rttMs = this.rttMs === 0 ? sample : this.rttMs * 0.7 + sample * 0.3;
        return;
      }
      case 'error':
        if (message.fatal) {
          this.lastServerNotice = message.message;
          if (message.code === 'version_mismatch') this.fail('version_mismatch', message.message);
          else if (message.code === 'rate_limited' || message.code === 'bad_message') this.fail('kicked', message.message);
        }
        this.handlers.onMessage?.(message);
        return;
      case 'shutdown':
        this.lastServerNotice = message.message;
        this.handlers.onMessage?.(message);
        return;
      default:
        this.handlers.onMessage?.(message);
    }
  }

  private onClosed(code: number): void {
    if (this.status === 'failed' || this.status === 'idle') return;
    switch (code) {
      case CLOSE.VERSION_MISMATCH:
        this.fail('version_mismatch', this.lastServerNotice || 'The server runs a different version of the game. Reload the page to update.');
        return;
      case CLOSE.REPLACED:
        this.fail('replaced', 'This session was opened in another tab or device.');
        return;
      case CLOSE.FLOOD:
      case CLOSE.BAD_MESSAGE:
        this.fail('kicked', this.lastServerNotice || 'The server closed the connection.');
        return;
      default:
        this.scheduleRetry();
    }
  }

  private scheduleRetry(): void {
    this.clearTimers();
    const delay = BACKOFF_MS[Math.min(this.attempts, BACKOFF_MS.length - 1)]!;
    this.attempts++;
    this.setStatus(this.everOpened ? 'reconnecting' : 'connecting');
    // Jitter so a restarted server is not hit by every client at once.
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.open();
    }, delay * (0.75 + Math.random() * 0.5));
  }

  private fail(kind: FailureKind, message: string): void {
    if (this.status === 'failed') return;
    this.failure = { kind, message };
    this.clearTimers();
    const socket = this.socket;
    this.socket = null;
    if (socket) {
      socket.onclose = null;
      socket.onmessage = null;
      try {
        socket.close(1000, 'bye');
      } catch {
        // Already closed.
      }
    }
    this.setStatus('failed');
  }

  private startPinging(): void {
    this.stopPinging();
    const ping = (): void => {
      if (this.status !== 'open') return;
      const id = (this.pingId = (this.pingId + 1) >>> 0);
      const now = this.now();
      this.pingSent.set(id, now);
      // Forget pings that were never answered.
      if (this.pingSent.size > 8) this.pingSent.delete(this.pingSent.keys().next().value!);
      this.send({ t: 'ping', id, clientTime: Math.max(0, Math.floor(now)) });
    };
    ping();
    this.pingTimer = setInterval(ping, PING_INTERVAL_MS);
  }

  private stopPinging(): void {
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = null;
    this.pingSent.clear();
  }

  private clearTimers(): void {
    this.stopPinging();
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
  }

  private setStatus(status: ConnectionStatus): void {
    if (this.status === status && status !== 'connecting' && status !== 'reconnecting') return;
    this.status = status;
    this.syncPump();
    this.handlers.onStatus?.(status, this.failure);
  }
}
