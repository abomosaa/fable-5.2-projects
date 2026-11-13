/**
 * Headless clients for integration tests: the real client networking stack
 * (GameClient -> GameConnection -> RaceClient) over real WebSockets to a real
 * server process-local instance. No rendering, no DOM.
 */
import { WebSocket } from 'ws';
import type { SocketLike } from '../../client/src/net/connection';
import { GameClient, memorySessionStore, type SessionStore } from '../../client/src/net/gameClient';
import type { RaceClient } from '../../client/src/net/raceClient';
import { BotDriver, botProfileFor } from '../../shared/sim/bot';
import { makeQuery, queryTrack } from '../../shared/sim/track';
import { NEUTRAL_INPUT, type CarInput } from '../../shared/sim/vehicle';

export interface HeadlessClient {
  name: string;
  game: GameClient;
  store: SessionStore;
  errors: Array<{ code: string; message: string }>;
  notices: Array<{ code: string; message: string }>;
  lefts: Array<{ reason: string; message: string }>;
  shutdowns: string[];
  /** Start steering the local car round the track like a practice bot. */
  autopilot(skill?: number): void;
  /** Stops timers and closes the socket. */
  stop(): void;
}

export interface HeadlessOptions {
  origin?: string;
  store?: SessionStore;
  protocolVersion?: number;
}

export function headlessClient(port: number, name: string, options: HeadlessOptions = {}): HeadlessClient {
  const store = options.store ?? memorySessionStore();
  const game = new GameClient({
    url: `ws://127.0.0.1:${port}/ws`,
    store,
    protocolVersion: options.protocolVersion,
    createSocket: (url) => new WebSocket(url, options.origin ? { origin: options.origin } : {}) as unknown as SocketLike,
  });
  const client: HeadlessClient = {
    name,
    game,
    store,
    errors: [],
    notices: [],
    lefts: [],
    shutdowns: [],
    autopilot(skill = 0.7) {
      let driver: BotDriver | null = null;
      let driverRace: RaceClient | null = null;
      const query = makeQuery();
      input = (race) => {
        if (driverRace !== race) {
          driverRace = race;
          driver = new BotDriver(race.track, botProfileFor(Math.max(0, race.slot), skill), 99);
        }
        const state = race.predictor.state;
        const q = queryTrack(race.track, state.x, state.z, query);
        return driver!.compute({ slot: race.slot, state, s: q.s, lat: q.lat }, []);
      };
    },
    stop() {
      clearInterval(timer);
      game.disconnect();
    },
  };
  let input: (race: RaceClient) => Readonly<CarInput> = () => NEUTRAL_INPUT;
  game.on('error', (code, message) => client.errors.push({ code, message }));
  game.on('notice', (code, message) => client.notices.push({ code, message }));
  game.on('left', (reason, message) => client.lefts.push({ reason, message }));
  game.on('shutdown', (message) => client.shutdowns.push(message));
  // The "frame loop": advance prediction and send inputs.
  const timer = setInterval(() => {
    const race = game.race;
    if (race) race.update(performance.now(), () => input(race));
  }, 2);
  game.connect();
  return client;
}

export async function waitFor(predicate: () => boolean, timeoutMs: number, label: string): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error(`Timed out after ${timeoutMs} ms waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface RawSocketResult {
  opened: boolean;
  /** HTTP status when the handshake was refused. */
  status: number | null;
  closeCode: number | null;
  messages: string[];
  socket: WebSocket;
}

/** Opens a bare WebSocket and records what happens to it. */
export function rawSocket(url: string, options: { origin?: string; headers?: Record<string, string> } = {}): Promise<RawSocketResult> {
  return new Promise((resolve) => {
    const socket = new WebSocket(url, { origin: options.origin, headers: options.headers });
    const result: RawSocketResult = { opened: false, status: null, closeCode: null, messages: [], socket };
    let settled = false;
    const settle = (): void => {
      if (!settled) {
        settled = true;
        resolve(result);
      }
    };
    socket.on('open', () => {
      result.opened = true;
      settle();
    });
    socket.on('unexpected-response', (_req, res) => {
      result.status = res.statusCode ?? null;
      res.resume();
      settle();
    });
    socket.on('message', (data, isBinary) => {
      if (!isBinary) result.messages.push(data.toString());
    });
    socket.on('close', (code) => {
      result.closeCode = code;
      settle();
    });
    socket.on('error', () => settle());
  });
}
