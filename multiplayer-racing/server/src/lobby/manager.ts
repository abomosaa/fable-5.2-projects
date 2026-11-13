/**
 * The lobby: owns every room and every connection, validates and rate-limits
 * all client traffic, and routes it to the right room. Transport-agnostic:
 * the WebSocket layer (and tests) call `connect`, `handleText`,
 * `handleBinary` and `disconnect`.
 */
import { ROOM_NAME_MAX } from '../../../shared/constants';
import {
  CLOSE,
  PROTOCOL_VERSION,
  decodeInput,
  defaultRoomSettings,
  parseClientMessage,
  type ClientMessage,
  type RoomSettings,
  type RoomSummary,
} from '../../../shared/protocol';
import type { ServerConfig } from '../config';
import type { RecordsStore } from '../persistence/recordsStore';
import { KeyedRateLimiter } from '../security/rateLimit';
import { Connection, type Transport } from '../transport/connection';
import { newRoomCode } from '../util/ids';
import type { Logger } from '../util/logger';
import { Room, type Member, type RoomServices } from './room';

const DIRECTORY_MIN_INTERVAL_MS = 400;
const MAX_LISTED_ROOMS = 200;

export interface LobbyStats {
  connections: number;
  rooms: number;
  publicRooms: number;
  racing: number;
  players: number;
}

export class LobbyManager {
  readonly rooms = new Map<string, Room>();
  readonly connections = new Set<Connection>();
  shuttingDown = false;

  private readonly services: RoomServices;
  private readonly createLimiter: KeyedRateLimiter;
  private readonly joinLimiter: KeyedRateLimiter;
  private readonly listLimiter: KeyedRateLimiter;
  private readonly connectLimiter: KeyedRateLimiter;
  private readonly ipConnections = new Map<string, number>();
  private directoryDirty = false;
  private recordsDirty = false;
  private lastDirectoryAt = -Infinity;
  private lastSweepAt = 0;
  private seedCounter = 0;

  constructor(
    readonly config: ServerConfig,
    readonly logger: Logger,
    readonly records: RecordsStore,
    readonly now: () => number = Date.now,
    private readonly random: () => number = () => (Math.random() * 0x100000000) >>> 0,
  ) {
    this.createLimiter = new KeyedRateLimiter(config.createBurst, config.createPerMinute / 60);
    this.joinLimiter = new KeyedRateLimiter(config.joinBurst, config.joinPerMinute / 60);
    this.listLimiter = new KeyedRateLimiter(30, 6);
    this.connectLimiter = new KeyedRateLimiter(config.connectBurst, config.connectPerMinute / 60);
    this.services = {
      config,
      logger,
      records,
      now: this.now,
      randomSeed: () => (this.random() ^ (++this.seedCounter * 0x9e3779b1)) >>> 0,
      directoryChanged: () => {
        this.directoryDirty = true;
      },
      recordsChanged: () => {
        this.recordsDirty = true;
      },
    };
  }

  // ------------------------------------------------------------ connections

  /**
   * Admission control for a new socket. Returns a reason to refuse it, or
   * null to accept. Called by the transport before the WebSocket handshake.
   */
  admit(ip: string): 'shutting_down' | 'server_full' | 'ip_limit' | 'rate_limited' | null {
    if (this.shuttingDown) return 'shutting_down';
    if (this.connections.size >= this.config.maxConnections) return 'server_full';
    if ((this.ipConnections.get(ip) ?? 0) >= this.config.maxConnectionsPerIp) return 'ip_limit';
    if (!this.connectLimiter.take(ip, this.now())) return 'rate_limited';
    return null;
  }

  connect(transport: Transport, ip: string): Connection {
    const conn = new Connection(transport, ip, this.now(), this.config.tickRate);
    this.connections.add(conn);
    this.ipConnections.set(ip, (this.ipConnections.get(ip) ?? 0) + 1);
    return conn;
  }

  /** The socket closed (for whatever reason). */
  disconnect(conn: Connection): void {
    if (!this.connections.delete(conn)) return;
    conn.closed = true;
    const left = (this.ipConnections.get(conn.ip) ?? 1) - 1;
    if (left <= 0) this.ipConnections.delete(conn.ip);
    else this.ipConnections.set(conn.ip, left);
    const seated = this.seatOf(conn);
    if (seated) {
      seated.room.disconnect(seated.member, conn);
      conn.seat = null;
    }
  }

  // --------------------------------------------------------------- messages

  handleText(conn: Connection, text: string): void {
    if (conn.closed) return;
    const now = this.now();
    conn.lastSeenAt = now;
    if (!conn.limits.message.take(now)) {
      if (conn.flood.add(now)) return this.drop(conn, CLOSE.FLOOD, 'rate_limited', 'Disconnected for sending too many messages.');
      conn.rateLimited(now, 'messages', conn.limits.message.retryAfterMs(now));
      return;
    }
    const parsed = parseClientMessage(text, this.maxTextLength());
    if (!parsed.ok) {
      // No patience for strangers: a connection must open with a valid hello.
      if (!conn.greeted) this.drop(conn, CLOSE.BAD_MESSAGE, 'bad_message', 'Expected a hello message first.');
      else this.violation(conn, now, parsed.error);
      return;
    }
    const message = parsed.value;

    if (!conn.greeted) {
      if (message.t !== 'hello') {
        this.drop(conn, CLOSE.BAD_MESSAGE, 'bad_message', 'Expected a hello message first.');
        return;
      }
      if (message.protocol !== PROTOCOL_VERSION) {
        this.drop(
          conn,
          CLOSE.VERSION_MISMATCH,
          'version_mismatch',
          `This server speaks protocol ${PROTOCOL_VERSION}, your client speaks ${message.protocol}. Reload the page to update.`,
        );
        return;
      }
      conn.greeted = true;
      conn.send({
        t: 'welcome',
        protocol: PROTOCOL_VERSION,
        serverVersion: this.config.serverVersion,
        tickRate: this.config.tickRate,
        snapshotEvery: this.config.snapshotEvery,
        region: this.config.region,
        reconnectGraceMs: this.config.reconnectGraceMs,
        serverTime: now,
      });
      conn.send({ t: 'records', records: this.records.all() });
      return;
    }
    this.dispatch(conn, message, now);
  }

  handleBinary(conn: Connection, bytes: Uint8Array): void {
    if (conn.closed) return;
    const now = this.now();
    conn.lastSeenAt = now;
    if (!conn.limits.input.take(now)) {
      // Over the input budget: drop silently (inputs are redundant), and
      // disconnect only for a sustained flood, never for a latency burst.
      if (conn.flood.add(now)) this.drop(conn, CLOSE.FLOOD, 'rate_limited', 'Disconnected for flooding inputs.');
      return;
    }
    if (!conn.greeted) {
      this.drop(conn, CLOSE.BAD_MESSAGE, 'bad_message', 'Expected a hello message first.');
      return;
    }
    const decoded = decodeInput(bytes);
    if (!decoded.ok) {
      this.violation(conn, now, decoded.error);
      return;
    }
    const seated = this.seatOf(conn);
    if (!seated) return; // Late frame after leaving a room: ignore.
    seated.room.handleInput(seated.member, decoded.value);
  }

  private dispatch(conn: Connection, message: ClientMessage, now: number): void {
    switch (message.t) {
      case 'hello':
        return; // Already greeted; harmless.
      case 'ping':
        if (!conn.limits.ping.take(now)) return;
        conn.send({ t: 'pong', id: message.id, clientTime: message.clientTime, serverTime: now });
        return;
      case 'list':
        if (!conn.limits.list.take(now) || !this.listLimiter.take(conn.ip, now)) {
          conn.rateLimited(now, 'room list requests', conn.limits.list.retryAfterMs(now));
          return;
        }
        conn.listSubscribed = message.subscribe;
        this.sendDirectory(conn);
        return;
      case 'create':
        return this.create(conn, message.name, message.settings, now);
      case 'join':
        return this.join(conn, message.code, message.name, message.spectate, now);
      case 'quick':
        return this.quickJoin(conn, message.name, now);
      case 'resume':
        return this.resume(conn, message.code, message.token, now);
      default:
        break;
    }

    const seated = this.seatOf(conn);
    if (!seated) {
      conn.error('not_in_room', 'You are not in a room.');
      return;
    }
    const { room, member } = seated;
    let result: ReturnType<Room['setReady']> | null = null;
    switch (message.t) {
      case 'leave':
        room.leave(member);
        this.reap(room);
        return;
      case 'ready':
        result = room.setReady(member, message.ready);
        break;
      case 'role':
        result = room.setRole(member, message.role);
        break;
      case 'rename':
        if (!conn.limits.rename.take(now)) return conn.rateLimited(now, 'name changes', conn.limits.rename.retryAfterMs(now));
        result = room.rename(member, message.name);
        break;
      case 'settings':
        if (!conn.limits.settings.take(now)) return conn.rateLimited(now, 'settings changes', conn.limits.settings.retryAfterMs(now));
        result = room.updateSettings(member, message.patch);
        break;
      case 'start':
        result = room.start(member);
        break;
      case 'abort':
        result = room.abort(member);
        break;
      case 'lobby':
        result = room.returnToLobby(member);
        break;
      case 'kick':
        result = room.kick(member, message.id);
        break;
      case 'chat':
        if (!conn.limits.chat.take(now)) return conn.rateLimited(now, 'chat messages', conn.limits.chat.retryAfterMs(now));
        result = room.chat(member, message.text);
        break;
      default:
        break;
    }
    if (result && !result.ok) conn.error(result.code, result.message);
    this.reap(room);
  }

  // ------------------------------------------------------------------ rooms

  private create(conn: Connection, name: string, settings: RoomSettings, now: number): void {
    if (conn.seat) return conn.error('already_in_room', 'Leave your current room first.');
    if (!this.createLimiter.take(conn.ip, now)) {
      return conn.error('rate_limited', 'You are creating rooms too quickly.', false, this.createLimiter.retryAfterMs(conn.ip, now));
    }
    const room = this.newRoom(conn, settings);
    if (!room) return;
    room.join(conn, name, false);
    conn.listSubscribed = false;
  }

  private newRoom(conn: Connection, settings: RoomSettings): Room | null {
    if (this.shuttingDown) {
      conn.error('server_full', 'The server is restarting.');
      return null;
    }
    if (this.rooms.size >= this.config.maxRooms) {
      conn.error('server_full', 'The server has reached its room limit. Join an existing room instead.');
      return null;
    }
    let owned = 0;
    for (const room of this.rooms.values()) if (room.creatorIp === conn.ip) owned++;
    if (owned >= this.config.maxRoomsPerIp) {
      conn.error('rate_limited', 'You have too many open rooms. Close one first.');
      return null;
    }
    let code = newRoomCode();
    for (let i = 0; i < 20 && this.rooms.has(code); i++) code = newRoomCode();
    if (this.rooms.has(code)) {
      conn.error('internal', 'Could not allocate a room code. Try again.');
      return null;
    }
    const room = new Room(code, settings, conn.ip, this.services);
    this.rooms.set(code, room);
    this.directoryDirty = true;
    this.logger.info('room created', { room: code, public: settings.isPublic, track: settings.trackId });
    return room;
  }

  private join(conn: Connection, code: string, name: string, spectate: boolean, now: number): void {
    if (conn.seat) return conn.error('already_in_room', 'You are already in a room.');
    if (!this.joinLimiter.take(conn.ip, now)) {
      return conn.error('rate_limited', 'You are joining rooms too quickly.', false, this.joinLimiter.retryAfterMs(conn.ip, now));
    }
    const room = this.rooms.get(code);
    if (!room || room.closed) return conn.error('room_not_found', 'That room does not exist or has closed.');
    const result = room.join(conn, name, spectate);
    if (!result.ok) return conn.error(result.code, result.message);
    conn.listSubscribed = false;
  }

  private quickJoin(conn: Connection, name: string, now: number): void {
    if (conn.seat) return conn.error('already_in_room', 'You are already in a room.');
    if (!this.joinLimiter.take(conn.ip, now)) {
      return conn.error('rate_limited', 'You are joining rooms too quickly.', false, this.joinLimiter.retryAfterMs(conn.ip, now));
    }
    // Prefer the fullest public lobby that is still waiting to start.
    let best: Room | null = null;
    for (const room of this.rooms.values()) {
      if (room.closed || !room.settings.isPublic || room.phase !== 'lobby') continue;
      if (!room.hasRacerSpace() || room.isBanned(conn.ip) || room.connectedCount === 0) continue;
      if (!best || room.racerCount > best.racerCount || (room.racerCount === best.racerCount && room.createdAt < best.createdAt)) {
        best = room;
      }
    }
    if (!best) {
      // Nothing to join: open a public room with bots so the player can race
      // right away, and others can find them.
      if (!this.createLimiter.take(conn.ip, now)) {
        return conn.error('rate_limited', 'No open race found, and you are creating rooms too quickly.', false, this.createLimiter.retryAfterMs(conn.ip, now));
      }
      const settings = defaultRoomSettings(name);
      settings.name = `${name}'s quick race`.slice(0, ROOM_NAME_MAX);
      best = this.newRoom(conn, settings);
      if (!best) return;
    }
    const result = best.join(conn, name, false);
    if (!result.ok) return conn.error(result.code, result.message);
    conn.listSubscribed = false;
  }

  private resume(conn: Connection, code: string, token: string, now: number): void {
    if (conn.seat) return conn.error('already_in_room', 'You are already in a room.');
    if (!this.joinLimiter.take(conn.ip, now)) {
      return conn.error('rate_limited', 'Too many reconnect attempts.', false, this.joinLimiter.retryAfterMs(conn.ip, now));
    }
    const room = this.rooms.get(code);
    if (!room || room.closed) return conn.error('resume_failed', 'That room no longer exists.');
    const result = room.resume(conn, token);
    if (!result.ok) return conn.error(result.code, result.message);
    conn.listSubscribed = false;
  }

  private seatOf(conn: Connection): { room: Room; member: Member } | null {
    const seat = conn.seat;
    if (!seat) return null;
    const room = this.rooms.get(seat.roomCode);
    const member = room?.members.get(seat.memberId);
    if (!room || !member || member.conn !== conn) {
      conn.seat = null;
      return null;
    }
    return { room, member };
  }

  private reap(room: Room): void {
    if (room.closed || room.members.size === 0) {
      room.closed = true;
      room.session = null;
      if (this.rooms.delete(room.code)) {
        this.directoryDirty = true;
        this.logger.info('room removed', { room: room.code });
      }
    }
  }

  // -------------------------------------------------------------- directory

  publicRooms(): RoomSummary[] {
    const list: RoomSummary[] = [];
    for (const room of this.rooms.values()) {
      // Rooms whose members are all disconnected are not advertised: there is nobody to race.
      if (room.closed || !room.settings.isPublic || room.connectedCount === 0) continue;
      list.push(room.summary());
      if (list.length >= MAX_LISTED_ROOMS) break;
    }
    return list;
  }

  private sendDirectory(conn: Connection): void {
    conn.send({ t: 'rooms', rooms: this.publicRooms(), total: this.rooms.size, online: this.connections.size });
  }

  // ------------------------------------------------------------------ loops

  hasActiveRaces(): boolean {
    for (const room of this.rooms.values()) if (room.session) return true;
    return false;
  }

  /** Runs one simulation tick for every room that is racing. */
  tick(): void {
    for (const room of this.rooms.values()) {
      if (!room.session) continue;
      try {
        room.tick();
      } catch (error) {
        // A bug in one race must not take the whole server down.
        this.logger.error('race tick failed, closing room', { room: room.code, error: String(error) });
        room.close('The race was stopped because of a server error.');
      }
    }
  }

  /** Periodic maintenance: expiries, cleanup, directory pushes. */
  housekeeping(): void {
    const now = this.now();
    for (const room of [...this.rooms.values()]) {
      if (!room.housekeeping(now)) this.reap(room);
    }
    if (this.recordsDirty) {
      this.recordsDirty = false;
      const message = { t: 'records' as const, records: this.records.all() };
      for (const conn of this.connections) if (conn.greeted) conn.send(message);
    }
    if (this.directoryDirty && now - this.lastDirectoryAt >= DIRECTORY_MIN_INTERVAL_MS) {
      this.directoryDirty = false;
      this.lastDirectoryAt = now;
      const rooms = this.publicRooms();
      const message = { t: 'rooms' as const, rooms, total: this.rooms.size, online: this.connections.size };
      for (const conn of this.connections) if (conn.listSubscribed && !conn.seat) conn.send(message);
    }
    if (now - this.lastSweepAt > 30_000) {
      this.lastSweepAt = now;
      this.createLimiter.sweep(now);
      this.joinLimiter.sweep(now);
      this.listLimiter.sweep(now);
      this.connectLimiter.sweep(now);
    }
  }

  /** Closes connections that have gone silent or never said hello. */
  reapConnections(): Connection[] {
    const now = this.now();
    const stale: Connection[] = [];
    for (const conn of this.connections) {
      const idle = now - conn.lastSeenAt;
      if (idle > this.config.connectionTimeoutMs || (!conn.greeted && now - conn.connectedAt > this.config.helloTimeoutMs)) {
        stale.push(conn);
      }
    }
    for (const conn of stale) conn.close(CLOSE.IDLE, 'timeout');
    return stale;
  }

  /** Tells every client the server is going away. */
  beginShutdown(message: string): void {
    this.shuttingDown = true;
    for (const conn of this.connections) conn.send({ t: 'shutdown', message });
  }

  closeAll(): void {
    for (const conn of [...this.connections]) conn.close(CLOSE.SHUTDOWN, 'server shutting down');
  }

  stats(): LobbyStats {
    let publicRooms = 0;
    let racing = 0;
    let players = 0;
    for (const room of this.rooms.values()) {
      if (room.settings.isPublic) publicRooms++;
      if (room.phase === 'racing') racing++;
      players += room.members.size;
    }
    return { connections: this.connections.size, rooms: this.rooms.size, publicRooms, racing, players };
  }

  rateLimitStateSize(): number {
    return this.createLimiter.size + this.joinLimiter.size + this.listLimiter.size + this.connectLimiter.size;
  }

  // ---------------------------------------------------------------- private

  private maxTextLength(): number {
    return 2048;
  }

  private violation(conn: Connection, now: number, detail: string): void {
    if (conn.violations.add(now)) {
      this.drop(conn, CLOSE.BAD_MESSAGE, 'bad_message', 'Disconnected for sending invalid messages.');
      return;
    }
    conn.error('bad_message', `Invalid message (${detail}).`);
  }

  private drop(conn: Connection, closeCode: number, code: 'bad_message' | 'version_mismatch' | 'rate_limited', message: string): void {
    this.logger.debug('dropping connection', { conn: conn.id, ip: conn.ip, code, message });
    conn.error(code, message, true);
    conn.close(closeCode, code);
  }
}
