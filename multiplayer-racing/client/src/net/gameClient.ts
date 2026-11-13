/**
 * Application-level client: lobby state, room membership, reconnect/resume
 * and the lifetime of the per-race `RaceClient`.
 *
 * Holds no DOM or rendering code. The browser UI subscribes to its events;
 * the automated tests drive exactly the same class over real sockets.
 */
import {
  normalizeRoomCode,
  type ErrorCode,
  type LeftReason,
  type NoticeCode,
  type Role,
  type RoomSettings,
  type RoomSettingsPatch,
  type RoomState,
  type RoomSummary,
  type ServerMessage,
  type ServerMessageMap,
  type TrackRecord,
} from '../../../shared/protocol';
import { getTrack } from '../../../shared/sim/tracks';
import {
  GameConnection,
  type ConnectionFailure,
  type ConnectionStatus,
  type SocketFactory,
} from './connection';
import { RaceClient } from './raceClient';

/** Where the reconnect credential is kept between page loads (per tab). */
export interface SessionStore {
  load(): StoredSession | null;
  save(session: StoredSession): void;
  clear(): void;
}

export interface StoredSession {
  code: string;
  token: string;
}

export function memorySessionStore(): SessionStore {
  let value: StoredSession | null = null;
  return {
    load: () => value,
    save: (session) => {
      value = session;
    },
    clear: () => {
      value = null;
    },
  };
}

export interface RoomDirectory {
  rooms: RoomSummary[];
  total: number;
  online: number;
  receivedAt: number;
}

export interface GameClientEvents {
  status(status: ConnectionStatus, failure: ConnectionFailure | null): void;
  /** Handshake complete; `reconnected` is false for the first connection. */
  ready(reconnected: boolean): void;
  directory(directory: RoomDirectory): void;
  records(records: TrackRecord[]): void;
  /** Entered a room, by joining, creating or resuming. */
  joined(room: RoomState, resumed: boolean): void;
  /** The room we are in changed. */
  room(room: RoomState, previous: RoomState): void;
  /** No longer in a room. */
  left(reason: LeftReason, message: string): void;
  notice(code: NoticeCode, message: string): void;
  chat(fromId: string, name: string, text: string): void;
  error(code: ErrorCode, message: string, retryAfterMs: number): void;
  /** A race began (or we joined/rejoined one in progress). */
  raceStart(race: RaceClient, room: RoomState): void;
  raceEnd(room: RoomState | null): void;
  shutdown(message: string): void;
}

export interface GameClientOptions {
  url: string;
  store?: SessionStore;
  createSocket?: SocketFactory;
  now?: () => number;
  protocolVersion?: number;
}

type Listener<K extends keyof GameClientEvents> = GameClientEvents[K];

export class GameClient {
  readonly connection: GameConnection;
  room: RoomState | null = null;
  youId = '';
  directory: RoomDirectory = { rooms: [], total: 0, online: 0, receivedAt: 0 };
  records: TrackRecord[] = [];
  race: RaceClient | null = null;
  /** True between asking to resume a seat and the server's answer. */
  resuming = false;

  private readonly store: SessionStore;
  private readonly now: () => number;
  private readonly listeners: { [K in keyof GameClientEvents]?: Array<Listener<K>> } = {};
  private wantDirectory = false;

  constructor(options: GameClientOptions) {
    this.store = options.store ?? memorySessionStore();
    this.now = options.now ?? (() => performance.now());
    this.connection = new GameConnection({
      url: options.url,
      createSocket: options.createSocket,
      now: this.now,
      protocolVersion: options.protocolVersion,
      handlers: {
        onStatus: (status, failure) => this.onStatus(status, failure),
        onWelcome: (welcome, reconnected) => this.onWelcome(welcome, reconnected),
        onMessage: (message) => this.onMessage(message),
        onBinary: (bytes) => this.race?.onSnapshot(bytes, this.now()),
      },
    });
  }

  // ----------------------------------------------------------------- events

  on<K extends keyof GameClientEvents>(event: K, listener: Listener<K>): () => void {
    const list = (this.listeners[event] ??= []) as Array<Listener<K>>;
    list.push(listener);
    return () => {
      const at = list.indexOf(listener);
      if (at >= 0) list.splice(at, 1);
    };
  }

  private emit<K extends keyof GameClientEvents>(event: K, ...args: Parameters<GameClientEvents[K]>): void {
    const list = this.listeners[event] as Array<(...a: Parameters<GameClientEvents[K]>) => void> | undefined;
    if (!list) return;
    for (const listener of [...list]) listener(...args);
  }

  // ---------------------------------------------------------------- getters

  get me(): RoomState['members'][number] | null {
    return this.room?.members.find((m) => m.id === this.youId) ?? null;
  }

  get isHost(): boolean {
    return this.room !== null && this.room.hostId === this.youId;
  }

  /** Our grid slot in the running race, or -1. */
  get raceSlot(): number {
    const car = this.room?.race?.cars.find((c) => c.memberId === this.youId);
    return car ? car.slot : -1;
  }

  get tickRate(): number {
    return this.connection.welcome?.tickRate ?? 60;
  }

  // ---------------------------------------------------------------- actions

  connect(): void {
    this.connection.connect();
  }

  disconnect(): void {
    this.connection.close();
  }

  /** Requests the public room list; with `subscribe` the server pushes updates. */
  listRooms(subscribe: boolean): void {
    this.wantDirectory = subscribe;
    this.connection.send({ t: 'list', subscribe });
  }

  createRoom(name: string, settings: RoomSettings): void {
    this.connection.send({ t: 'create', name, settings });
  }

  joinRoom(code: string, name: string, spectate = false): void {
    this.connection.send({ t: 'join', code: normalizeRoomCode(code), name, spectate });
  }

  quickJoin(name: string): void {
    this.connection.send({ t: 'quick', name });
  }

  leaveRoom(): void {
    if (!this.room) return;
    this.connection.send({ t: 'leave' });
  }

  setReady(ready: boolean): void {
    this.connection.send({ t: 'ready', ready });
  }

  setRole(role: Role): void {
    this.connection.send({ t: 'role', role });
  }

  rename(name: string): void {
    this.connection.send({ t: 'rename', name });
  }

  updateSettings(patch: RoomSettingsPatch): void {
    this.connection.send({ t: 'settings', patch });
  }

  startRace(): void {
    this.connection.send({ t: 'start' });
  }

  abortRace(): void {
    this.connection.send({ t: 'abort' });
  }

  returnToLobby(): void {
    this.connection.send({ t: 'lobby' });
  }

  kick(memberId: string): void {
    this.connection.send({ t: 'kick', id: memberId });
  }

  chat(text: string): void {
    this.connection.send({ t: 'chat', text });
  }

  /** Whether a seat from an earlier session could be resumed. */
  hasStoredSession(): boolean {
    return this.store.load() !== null;
  }

  forgetSession(): void {
    this.store.clear();
  }

  // --------------------------------------------------------------- handlers

  private onStatus(status: ConnectionStatus, failure: ConnectionFailure | null): void {
    if (status === 'failed' && failure?.kind !== 'version_mismatch') {
      // The seat is gone for this tab (taken over elsewhere, or we were dropped).
      if (failure?.kind === 'replaced') this.store.clear();
    }
    this.emit('status', status, failure);
  }

  private onWelcome(_welcome: ServerMessageMap['welcome'], reconnected: boolean): void {
    const stored = this.store.load();
    if (stored) {
      // Reclaim our seat: after a dropped connection or a page reload.
      this.resuming = true;
      this.connection.send({ t: 'resume', code: stored.code, token: stored.token });
    } else if (this.room) {
      this.dropRoom('expired', 'Your seat in the room was lost.');
    }
    if (this.wantDirectory && !stored) this.connection.send({ t: 'list', subscribe: true });
    this.emit('ready', reconnected);
  }

  private onMessage(message: ServerMessage): void {
    switch (message.t) {
      case 'rooms':
        this.directory = { rooms: message.rooms, total: message.total, online: message.online, receivedAt: this.now() };
        this.emit('directory', this.directory);
        return;
      case 'records':
        this.records = message.records;
        this.emit('records', this.records);
        return;
      case 'joined': {
        this.resuming = false;
        this.youId = message.youId;
        this.store.save({ code: message.room.code, token: message.token });
        const previous = this.room;
        this.room = message.room;
        // A (re)join always starts from a clean race view.
        if (this.race) this.endRace(previous);
        this.emit('joined', message.room, message.resumed);
        this.syncRace(message.room);
        return;
      }
      case 'room': {
        if (!this.room || message.room.code !== this.room.code) return;
        const previous = this.room;
        this.room = message.room;
        this.emit('room', message.room, previous);
        this.syncRace(message.room);
        return;
      }
      case 'left':
        this.dropRoom(message.reason, message.message);
        return;
      case 'notice':
        this.emit('notice', message.code, message.message);
        return;
      case 'chat':
        this.emit('chat', message.fromId, message.name, message.text);
        return;
      case 'error':
        if (message.code === 'resume_failed' || (this.resuming && message.code === 'room_not_found')) {
          this.resuming = false;
          this.dropRoom('expired', message.message);
          if (this.wantDirectory) this.connection.send({ t: 'list', subscribe: true });
        } else if (this.resuming && message.code === 'rate_limited') {
          this.resuming = false;
        }
        this.emit('error', message.code, message.message, message.retryAfterMs ?? 0);
        return;
      case 'shutdown':
        this.emit('shutdown', message.message);
        return;
      default:
        return;
    }
  }

  private dropRoom(reason: LeftReason, message: string): void {
    this.store.clear();
    const had = this.room !== null;
    this.room = null;
    this.youId = '';
    if (this.race) this.endRace(null);
    if (had || reason !== 'left') this.emit('left', reason, message);
  }

  /** Creates or discards the RaceClient so it matches the room's race. */
  private syncRace(room: RoomState): void {
    const info = room.race;
    if (!info) {
      if (this.race) this.endRace(room);
      return;
    }
    if (this.race && this.race.race.raceId === info.raceId) return;
    if (this.race) this.endRace(room);
    const welcome = this.connection.welcome;
    this.race = new RaceClient({
      track: getTrack(info.trackId),
      race: info,
      slot: this.raceSlot,
      tickRate: welcome?.tickRate ?? 60,
      snapshotEvery: welcome?.snapshotEvery ?? 2,
      send: (bytes) => this.connection.sendBinary(bytes),
    });
    this.emit('raceStart', this.race, room);
  }

  private endRace(room: RoomState | null): void {
    this.race = null;
    this.emit('raceEnd', room);
  }
}
