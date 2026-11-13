/**
 * A deterministic, in-process network for tests.
 *
 * The real server logic (LobbyManager, Room, RaceSession) and the real client
 * networking stack (GameClient, GameConnection, RaceClient) are connected by
 * virtual sockets whose traffic passes through `ImpairedChannel`s, all driven
 * by one virtual clock. Nothing depends on wall-clock time, so a 70 second
 * race under 200 ms of jittery, lossy latency runs in a second and always
 * behaves the same way.
 *
 * Requires vitest fake timers (the client code uses timers for pings/retries).
 */
import { vi } from 'vitest';
import { GameClient, memorySessionStore, type SessionStore } from '../../client/src/net/gameClient';
import type { SocketLike } from '../../client/src/net/connection';
import type { RaceClient } from '../../client/src/net/raceClient';
import { testConfig, type ServerConfig } from '../../server/src/config';
import { LobbyManager } from '../../server/src/lobby/manager';
import { MemoryRecordsStore } from '../../server/src/persistence/recordsStore';
import type { Connection } from '../../server/src/transport/connection';
import { silentLogger } from '../../server/src/util/logger';
import { ImpairedChannel, PERFECT_NETWORK, type NetConditions } from '../../shared/net/netsim';
import { BotDriver, botProfileFor } from '../../shared/sim/bot';
import { Rng } from '../../shared/sim/rng';
import { queryTrack, makeQuery } from '../../shared/sim/track';
import { NEUTRAL_INPUT, type CarInput } from '../../shared/sim/vehicle';

type Frame = string | Uint8Array;

export type InputSource = (race: RaceClient) => Readonly<CarInput>;

export class VirtualSocket implements SocketLike {
  binaryType = 'arraybuffer';
  readyState = 0;
  onopen: ((event: unknown) => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: ((event: { code: number; reason: string }) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  /** Client -> server. */
  readonly up: ImpairedChannel<Frame>;
  /** Server -> client. */
  readonly down: ImpairedChannel<Frame>;
  server: Connection | null = null;
  /** While true, nothing is delivered in either direction (a stalled link). */
  frozen = false;
  bytesDown = 0;
  bytesUp = 0;
  private closeAt = -1;
  private closeCode = 1006;

  constructor(
    private readonly world: VirtualWorld,
    conditions: NetConditions,
    random: () => number,
    readonly ip: string,
  ) {
    this.up = new ImpairedChannel<Frame>(conditions, random);
    this.down = new ImpairedChannel<Frame>(conditions, random);
  }

  send(data: string | ArrayBufferLike | ArrayBufferView): void {
    if (this.readyState !== 1) return;
    const frame: Frame =
      typeof data === 'string'
        ? data
        : ArrayBuffer.isView(data)
          ? new Uint8Array(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer)
          : new Uint8Array(data as ArrayBuffer);
    this.bytesUp += typeof frame === 'string' ? frame.length : frame.byteLength;
    this.up.send(frame, this.world.now, typeof frame === 'string');
  }

  /** Client-initiated close. */
  close(code = 1000): void {
    if (this.readyState >= 2) return;
    this.readyState = 3;
    this.detach();
    this.onclose?.({ code, reason: '' });
  }

  /** Server-initiated close: arrives after the downstream latency. */
  serverClose(code: number): void {
    if (this.closeAt >= 0 || this.readyState >= 2) return;
    this.closeAt = this.world.now + this.down.conditions.latencyMs;
    this.closeCode = code;
    this.detach();
  }

  /** The link dies without a close handshake. */
  drop(): void {
    if (this.readyState >= 2) return;
    this.readyState = 3;
    this.detach();
    this.onclose?.({ code: 1006, reason: '' });
  }

  private detach(): void {
    const server = this.server;
    this.server = null;
    if (server) this.world.manager.disconnect(server);
  }

  /** Moves due frames across the link. */
  pump(now: number): void {
    if (this.frozen) return;
    if (this.readyState === 0 && now >= this.openAt) {
      this.readyState = 1;
      this.onopen?.({});
    }
    for (const frame of this.up.poll(now)) {
      const server = this.server;
      if (!server) break;
      if (typeof frame === 'string') this.world.manager.handleText(server, frame);
      else this.world.manager.handleBinary(server, frame);
    }
    for (const frame of this.down.poll(now)) {
      if (this.readyState !== 1) break;
      this.bytesDown += typeof frame === 'string' ? frame.length : frame.byteLength;
      this.onmessage?.({ data: typeof frame === 'string' ? frame : frame.buffer.slice(frame.byteOffset, frame.byteOffset + frame.byteLength) });
    }
    if (this.closeAt >= 0 && now >= this.closeAt && this.readyState < 2) {
      this.readyState = 3;
      this.closeAt = -1;
      this.onclose?.({ code: this.closeCode, reason: '' });
    }
  }

  openAt = 0;
}

export interface VirtualClientOptions {
  conditions?: NetConditions;
  /** Milliseconds between client frames (default 1000/60). */
  frameMs?: number;
  ip?: string;
  seed?: number;
  store?: SessionStore;
  protocolVersion?: number;
}

export class VirtualClient {
  readonly game: GameClient;
  readonly store: SessionStore;
  socket: VirtualSocket | null = null;
  input: InputSource = () => NEUTRAL_INPUT;
  frameMs: number;
  /** While true the client renders no frames (a hidden tab or a frozen machine). */
  paused = false;
  conditions: NetConditions;
  readonly errors: Array<{ code: string; message: string }> = [];
  readonly notices: string[] = [];
  readonly lefts: Array<{ reason: string; message: string }> = [];
  readonly sockets: VirtualSocket[] = [];
  private nextFrameAt: number;
  private readonly random: () => number;

  constructor(world: VirtualWorld, readonly name: string, options: VirtualClientOptions) {
    const rng = new Rng(options.seed ?? 1);
    this.random = () => rng.next();
    this.conditions = { ...(options.conditions ?? PERFECT_NETWORK) };
    this.frameMs = options.frameMs ?? 1000 / 60;
    this.nextFrameAt = world.now + this.random() * this.frameMs;
    this.store = options.store ?? memorySessionStore();
    const ip = options.ip ?? '10.0.0.1';
    this.game = new GameClient({
      url: 'virtual://server',
      store: this.store,
      now: () => world.now,
      protocolVersion: options.protocolVersion,
      createSocket: () => {
        const socket = new VirtualSocket(world, this.conditions, this.random, ip);
        socket.openAt = world.now + this.conditions.latencyMs;
        const refusal = world.manager.admit(ip);
        if (refusal) {
          // Handshake refused: the client just sees the socket fail.
          socket.serverClose(1006);
        } else {
          socket.server = world.manager.connect(
            {
              send: (data) => socket.down.send(data, world.now, typeof data === 'string'),
              close: (code) => socket.serverClose(code),
              bufferedAmount: () => 0,
            },
            ip,
          );
        }
        this.socket = socket;
        this.sockets.push(socket);
        return socket;
      },
    });
    this.game.on('error', (code, message) => this.errors.push({ code, message }));
    this.game.on('notice', (_code, message) => this.notices.push(message));
    this.game.on('left', (reason, message) => this.lefts.push({ reason, message }));
  }

  setConditions(conditions: NetConditions): void {
    this.conditions = { ...conditions };
    if (this.socket) {
      this.socket.up.conditions = { ...conditions };
      this.socket.down.conditions = { ...conditions };
    }
  }

  /** Runs client frames that are due at `now`. */
  frame(now: number): void {
    for (const socket of this.sockets) socket.pump(now);
    if (now < this.nextFrameAt) return;
    this.nextFrameAt += this.frameMs;
    if (this.nextFrameAt < now) this.nextFrameAt = now + this.frameMs;
    if (this.paused) return;
    const race = this.game.race;
    if (race) race.update(now, () => this.input(race));
  }

  /** Drives the local car around the track like a practice bot would. */
  driveLikeABot(skill = 0.7, seed = 7): void {
    let driver: BotDriver | null = null;
    let driverRace: RaceClient | null = null;
    const query = makeQuery();
    this.input = (race) => {
      if (driverRace !== race) {
        driverRace = race;
        driver = new BotDriver(race.track, botProfileFor(Math.max(0, race.slot), skill), seed);
      }
      const state = race.predictor.state;
      const q = queryTrack(race.track, state.x, state.z, query);
      return driver!.compute({ slot: race.slot, state, s: q.s, lat: q.lat }, []);
    };
  }
}

export class VirtualWorld {
  now = 1_000_000;
  readonly config: ServerConfig;
  readonly manager: LobbyManager;
  readonly records = new MemoryRecordsStore();
  readonly clients: VirtualClient[] = [];
  serverTicks = 0;
  /** While true the server simulates nothing (a stalled process). */
  serverPaused = false;
  private readonly tickMs: number;
  private nextTickAt: number;
  private nextHousekeepingAt: number;

  constructor(overrides: Partial<ServerConfig> = {}, seed = 42) {
    this.config = testConfig({ countdownTicks: 120, cooldownTicks: 30, ...overrides });
    const rng = new Rng(seed);
    this.manager = new LobbyManager(this.config, silentLogger, this.records, () => this.now, () => (rng.next() * 0x100000000) >>> 0);
    this.tickMs = 1000 / this.config.tickRate;
    this.nextTickAt = this.now + this.tickMs;
    this.nextHousekeepingAt = this.now + 250;
  }

  addClient(name: string, options: VirtualClientOptions = {}): VirtualClient {
    const client = new VirtualClient(this, name, { seed: this.clients.length + 11, ip: `10.0.0.${this.clients.length + 1}`, ...options });
    this.clients.push(client);
    client.game.connect();
    return client;
  }

  /** Advances virtual time by `ms`, one millisecond at a time. */
  advance(ms: number): void {
    const end = this.now + ms;
    while (this.now < end) {
      this.now += 1;
      vi.advanceTimersByTime(1);
      for (const client of this.clients) client.frame(this.now);
      if (this.serverPaused) {
        // A stalled process resumes from "now": it does not replay the gap.
        this.nextTickAt = this.now + this.tickMs;
      }
      while (this.now >= this.nextTickAt) {
        this.manager.tick();
        this.serverTicks++;
        this.nextTickAt += this.tickMs;
      }
      if (this.now >= this.nextHousekeepingAt) {
        this.manager.housekeeping();
        this.nextHousekeepingAt += 250;
      }
    }
  }

  /** Advances until `predicate` holds; throws if it takes longer than `timeoutMs` of virtual time. */
  advanceUntil(predicate: () => boolean, timeoutMs = 10_000, label = 'condition'): void {
    const deadline = this.now + timeoutMs;
    while (!predicate()) {
      if (this.now >= deadline) throw new Error(`Timed out after ${timeoutMs} ms of virtual time waiting for ${label}`);
      this.advance(5);
    }
  }
}
