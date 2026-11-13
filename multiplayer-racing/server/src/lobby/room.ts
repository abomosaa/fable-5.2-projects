/**
 * A room: membership, lobby state, host rules and the lifecycle of the races
 * held in it. The room is authoritative for everything; clients only ever
 * send requests, which are checked here against the current state.
 */
import { BOT_NAMES, MAX_RACERS, MAX_SPECTATORS, NAME_MAX, SIM_HZ } from '../../../shared/constants';
import type {
  ErrorCode,
  InputMessage,
  LeftReason,
  MemberInfo,
  NoticeCode,
  ResultRow,
  Role,
  RoomPhase,
  RoomSettings,
  RoomSettingsPatch,
  RoomState,
  RoomSummary,
  ServerMessage,
} from '../../../shared/protocol';
import { Rng } from '../../../shared/sim/rng';
import type { ServerConfig } from '../config';
import { RaceSession, type SessionEntry } from '../game/raceSession';
import type { RecordsStore } from '../persistence/recordsStore';
import type { Connection } from '../transport/connection';
import { newId, newToken, safeEqual } from '../util/ids';
import type { Logger } from '../util/logger';

export interface RoomServices {
  config: ServerConfig;
  logger: Logger;
  records: RecordsStore;
  now(): number;
  /** Seed for a new race (grid order, bot personalities). */
  randomSeed(): number;
  /** The public directory entry of this room changed. */
  directoryChanged(): void;
  /** A lap record was beaten. */
  recordsChanged(): void;
}

export interface Member {
  id: string;
  name: string;
  role: Role;
  ready: boolean;
  conn: Connection | null;
  /** Secret reconnect credential. */
  token: string;
  ip: string;
  joinOrder: number;
  /** When the connection dropped (0 while connected). */
  disconnectedAt: number;
  /** Grid slot in the running race, or -1. */
  slot: number;
  /** Index into CAR_COLORS, unique among the room's drivers. */
  colour: number;
  /** Newest snapshot tick acknowledged by the client (0 = send a full one). */
  ackSnapTick: number;
  /** When the client's send buffer first backed up (0 = healthy). */
  stalledSince: number;
  /** Race tick of the last full (non-delta) snapshot sent to this member. */
  lastFullTick: number;
}

export type RoomResult<T = void> = { ok: true; value: T } | { ok: false; code: ErrorCode; message: string };

const ok = <T>(value: T): RoomResult<T> => ({ ok: true, value });
const fail = <T = void>(code: ErrorCode, message: string): RoomResult<T> => ({ ok: false, code, message });

const BOT_SKILL_VALUE = { easy: 0.15, medium: 0.55, hard: 0.95 } as const;
/** Skip snapshots for a client whose socket has this many bytes queued. */
const BACKPRESSURE_BYTES = 128 * 1024;
/** Drop a client that stays backed up for this long. */
const BACKPRESSURE_TIMEOUT_MS = 10_000;
/** Minimum spacing of full snapshots to a client that has no usable delta baseline. */
const FULL_SNAPSHOT_INTERVAL_TICKS = 8;

export class Room {
  readonly code: string;
  readonly createdAt: number;
  readonly creatorIp: string;
  settings: RoomSettings;
  phase: RoomPhase = 'lobby';
  hostId = '';
  session: RaceSession | null = null;
  results: ResultRow[] | null = null;
  lastRaceNote = '';
  lastActivityAt: number;
  closed = false;

  readonly members = new Map<string, Member>();
  private readonly bans = new Map<string, number>();
  private joinCounter = 0;
  private raceCounter = 0;
  private raceHadHumans = false;
  private resultsAt = -1;
  private resultsUntil = 0;
  private lastPingBroadcast = 0;

  constructor(
    code: string,
    settings: RoomSettings,
    creatorIp: string,
    private readonly services: RoomServices,
  ) {
    this.code = code;
    this.settings = { ...settings };
    this.creatorIp = creatorIp;
    this.createdAt = services.now();
    this.lastActivityAt = this.createdAt;
  }

  // ------------------------------------------------------------- membership

  get racerCount(): number {
    let n = 0;
    for (const m of this.members.values()) if (m.role === 'racer') n++;
    return n;
  }

  get spectatorCount(): number {
    return this.members.size - this.racerCount;
  }

  get connectedCount(): number {
    let n = 0;
    for (const m of this.members.values()) if (m.conn) n++;
    return n;
  }

  isBanned(ip: string): boolean {
    const until = this.bans.get(ip);
    return until !== undefined && until > this.services.now();
  }

  /** Whether a new racer could join right now. */
  hasRacerSpace(): boolean {
    return this.racerCount < this.settings.maxPlayers;
  }

  join(conn: Connection, name: string, spectate: boolean): RoomResult<Member> {
    if (this.closed) return fail('room_not_found', 'That room no longer exists.');
    if (this.isBanned(conn.ip)) return fail('banned', 'You were removed from this room. Try again later.');
    const role: Role = spectate ? 'spectator' : 'racer';
    if (role === 'racer' && !this.hasRacerSpace()) {
      return fail('room_full', 'All driver seats are taken. You can still join as a spectator.');
    }
    if (role === 'spectator' && this.spectatorCount >= MAX_SPECTATORS) {
      return fail('room_full', 'The room is full.');
    }
    const member: Member = {
      id: newId(),
      name: this.uniqueName(name, null),
      role,
      ready: false,
      conn,
      token: newToken(),
      ip: conn.ip,
      joinOrder: this.joinCounter++,
      disconnectedAt: 0,
      slot: -1,
      colour: 0,
      ackSnapTick: 0,
      stalledSince: 0,
      lastFullTick: -1,
    };
    member.colour = this.freeColour(member);
    this.members.set(member.id, member);
    conn.seat = { roomCode: this.code, memberId: member.id };
    if (!this.members.has(this.hostId)) this.hostId = member.id;
    this.touch();
    conn.send({ t: 'joined', room: this.state(), youId: member.id, token: member.token, resumed: false });
    this.notice('player_joined', `${member.name} joined.`, member.id);
    this.broadcastRoom(member.id);
    this.services.directoryChanged();
    return ok(member);
  }

  /** Re-attaches a returning player using their reconnect credential. */
  resume(conn: Connection, token: string): RoomResult<Member> {
    if (this.closed) return fail('resume_failed', 'That room no longer exists.');
    let member: Member | null = null;
    for (const m of this.members.values()) {
      if (safeEqual(m.token, token)) {
        member = m;
        break;
      }
    }
    if (!member) return fail('resume_failed', 'Your seat in that room has expired.');
    if (member.conn && member.conn !== conn) {
      // The same credential on a second socket: the newer one wins.
      const old = member.conn;
      old.seat = null;
      old.send({ t: 'left', reason: 'replaced', message: 'You connected from another tab or device.' });
      old.close(4001, 'replaced');
    }
    const wasConnected = member.conn !== null;
    member.conn = conn;
    member.disconnectedAt = 0;
    member.ackSnapTick = 0;
    member.stalledSince = 0;
    member.lastFullTick = -1;
    member.ip = conn.ip;
    // Rotate the credential: a captured token is useless after it is used.
    member.token = newToken();
    conn.seat = { roomCode: this.code, memberId: member.id };
    if (this.session && member.slot >= 0) this.session.setConnected(member.slot, true);
    this.ensureHost();
    this.touch();
    conn.send({ t: 'joined', room: this.state(), youId: member.id, token: member.token, resumed: true });
    if (!wasConnected) this.notice('player_reconnected', `${member.name} reconnected.`, member.id);
    this.broadcastRoom(member.id);
    this.services.directoryChanged();
    return ok(member);
  }

  /** The member's socket closed: keep the seat for the grace period. */
  disconnect(member: Member, conn: Connection): void {
    if (member.conn !== conn) return;
    member.conn = null;
    member.disconnectedAt = this.services.now();
    member.ready = false;
    if (this.session && member.slot >= 0) this.session.setConnected(member.slot, false);
    this.ensureHost();
    this.notice('player_disconnected', `${member.name} lost connection.`);
    this.broadcastRoom();
    this.services.directoryChanged();
  }

  /** Removes a member for good. */
  remove(member: Member, reason: LeftReason, message: string): void {
    if (!this.members.delete(member.id)) return;
    if (this.session && member.slot >= 0) this.session.removeCar(member.slot);
    member.slot = -1;
    const conn = member.conn;
    member.conn = null;
    if (conn) {
      conn.seat = null;
      conn.send({ t: 'left', reason, message });
    }
    if (this.members.size > 0) {
      this.ensureHost();
      if (reason === 'kicked') this.notice('player_kicked', `${member.name} was removed by the host.`);
      else this.notice('player_left', `${member.name} left.`);
      this.broadcastRoom();
    }
    this.services.directoryChanged();
  }

  /** Closes the room and tells everyone why. */
  close(message: string): void {
    if (this.closed) return;
    this.closed = true;
    this.session = null;
    for (const member of [...this.members.values()]) {
      const conn = member.conn;
      member.conn = null;
      if (conn) {
        conn.seat = null;
        conn.send({ t: 'left', reason: 'room_closed', message });
      }
    }
    this.members.clear();
    this.services.directoryChanged();
  }

  // --------------------------------------------------------- member requests

  setReady(member: Member, ready: boolean): RoomResult {
    if (this.phase !== 'lobby') return fail('invalid_state', 'You can only ready up in the lobby.');
    if (member.role !== 'racer') return fail('invalid_state', 'Spectators do not need to ready up.');
    if (member.ready !== ready) {
      member.ready = ready;
      this.touch();
      this.broadcastRoom();
    }
    return ok(undefined);
  }

  setRole(member: Member, role: Role): RoomResult {
    if (this.phase === 'racing') return fail('invalid_state', 'You cannot change seats during a race.');
    if (member.role === role) return ok(undefined);
    if (role === 'racer' && !this.hasRacerSpace()) return fail('room_full', 'All driver seats are taken.');
    if (role === 'spectator' && this.spectatorCount >= MAX_SPECTATORS) return fail('room_full', 'The spectator area is full.');
    member.role = role;
    member.ready = false;
    member.colour = this.freeColour(member);
    this.touch();
    this.broadcastRoom();
    this.services.directoryChanged();
    return ok(undefined);
  }

  rename(member: Member, name: string): RoomResult {
    if (this.phase === 'racing') return fail('invalid_state', 'You cannot change your name during a race.');
    const unique = this.uniqueName(name, member.id);
    if (unique !== member.name) {
      member.name = unique;
      this.touch();
      this.broadcastRoom();
      this.services.directoryChanged();
    }
    return ok(undefined);
  }

  updateSettings(member: Member, patch: RoomSettingsPatch): RoomResult {
    if (member.id !== this.hostId) return fail('not_host', 'Only the host can change the room settings.');
    if (this.phase !== 'lobby') return fail('invalid_state', 'Settings can only be changed in the lobby.');
    const next: RoomSettings = { ...this.settings, ...patch };
    // Never shrink the room below the drivers already seated.
    next.maxPlayers = Math.max(next.maxPlayers, this.racerCount, 1);
    const raceChanged = next.trackId !== this.settings.trackId || next.laps !== this.settings.laps;
    this.settings = next;
    if (raceChanged) {
      // Nobody should be committed to a race they did not agree to.
      for (const m of this.members.values()) m.ready = false;
    }
    this.touch();
    this.broadcastRoom();
    this.services.directoryChanged();
    return ok(undefined);
  }

  kick(member: Member, targetId: string): RoomResult {
    if (member.id !== this.hostId) return fail('not_host', 'Only the host can remove players.');
    const target = this.members.get(targetId);
    if (!target) return fail('invalid_state', 'That player is no longer in the room.');
    if (target.id === member.id) return fail('invalid_state', 'You cannot remove yourself.');
    const banMs = this.services.config.kickBanMs;
    if (banMs > 0) this.bans.set(target.ip, this.services.now() + banMs);
    this.touch();
    this.remove(target, 'kicked', 'The host removed you from the room.');
    this.afterRosterChange();
    return ok(undefined);
  }

  chat(member: Member, text: string): RoomResult {
    this.touch();
    this.broadcast({ t: 'chat', fromId: member.id, name: member.name, text });
    return ok(undefined);
  }

  leave(member: Member): void {
    this.remove(member, 'left', 'You left the room.');
    this.afterRosterChange();
  }

  // ------------------------------------------------------------ race control

  start(member: Member): RoomResult {
    if (member.id !== this.hostId) return fail('not_host', 'Only the host can start the race.');
    if (this.phase !== 'lobby') return fail('invalid_state', 'A race is already in progress.');
    const racers = [...this.members.values()]
      .filter((m) => m.role === 'racer' && m.conn)
      .sort((a, b) => a.joinOrder - b.joinOrder);
    const waiting = racers.filter((m) => !m.ready && m.id !== this.hostId);
    if (waiting.length > 0) {
      return fail('not_ready', `Waiting for ${waiting.map((m) => m.name).join(', ')} to ready up.`);
    }
    const bots = Math.min(this.settings.bots, MAX_RACERS - racers.length);
    if (racers.length + bots < 1) return fail('not_ready', 'Add a driver or a bot before starting.');

    const seed = this.services.randomSeed();
    const rng = new Rng(seed);
    const entries: Array<SessionEntry & { member: Member | null }> = racers.map((m) => ({
      memberId: m.id,
      name: m.name,
      isBot: false,
      colour: m.colour,
      member: m,
    }));
    // Bots take the paint colours no driver is using.
    const usedColours = new Set(racers.map((m) => m.colour));
    const spareColours: number[] = [];
    for (let c = 0; c < MAX_RACERS; c++) if (!usedColours.has(c)) spareColours.push(c);
    const botNames = [...BOT_NAMES];
    for (let i = 0; i < bots; i++) {
      const pick = botNames.splice(rng.int(0, botNames.length - 1), 1)[0]!;
      entries.push({ memberId: null, name: pick.slice(0, NAME_MAX), isBot: true, colour: spareColours[i] ?? i, member: null });
    }
    // Shuffled grid (Fisher-Yates with the race seed) so nobody always starts first.
    for (let i = entries.length - 1; i > 0; i--) {
      const j = rng.int(0, i);
      [entries[i], entries[j]] = [entries[j]!, entries[i]!];
    }

    this.raceCounter++;
    this.session = new RaceSession({
      raceId: this.raceCounter,
      trackId: this.settings.trackId,
      laps: this.settings.laps,
      entries,
      botSkill: BOT_SKILL_VALUE[this.settings.botSkill],
      seed,
      countdownTicks: this.services.config.countdownTicks,
      finishTimeoutTicks: this.services.config.finishTimeoutTicks,
    });
    for (const m of this.members.values()) {
      m.slot = -1;
      m.ackSnapTick = 0;
      m.lastFullTick = -1;
      m.ready = false;
    }
    entries.forEach((entry, slot) => {
      if (entry.member) entry.member.slot = slot;
    });
    this.raceHadHumans = racers.length > 0;
    this.phase = 'racing';
    this.results = null;
    this.resultsAt = -1;
    this.lastRaceNote = '';
    this.touch();
    this.broadcastRoom();
    this.services.directoryChanged();
    this.services.logger.info('race started', {
      room: this.code,
      race: this.raceCounter,
      track: this.settings.trackId,
      humans: racers.length,
      bots,
    });
    return ok(undefined);
  }

  abort(member: Member): RoomResult {
    if (member.id !== this.hostId) return fail('not_host', 'Only the host can cancel the race.');
    if (this.phase !== 'racing') return fail('invalid_state', 'There is no race to cancel.');
    this.cancelRace('The host cancelled the race.');
    return ok(undefined);
  }

  returnToLobby(member: Member): RoomResult {
    if (member.id !== this.hostId) return fail('not_host', 'Only the host can return everyone to the lobby.');
    if (this.phase !== 'results') return fail('invalid_state', 'There are no results to dismiss.');
    this.enterLobby('');
    return ok(undefined);
  }

  /** Realtime input from the client driving (or watching) the race. */
  handleInput(member: Member, message: Readonly<InputMessage>): void {
    const session = this.session;
    if (!session || (session.raceId & 0xff) !== message.raceId) return;
    // The acknowledgement only selects a delta baseline; a bogus value can
    // at worst cost the sender itself a full snapshot.
    if (message.ackSnapTick === 0) member.ackSnapTick = 0;
    else if (message.ackSnapTick > member.ackSnapTick && message.ackSnapTick <= session.tick) {
      member.ackSnapTick = message.ackSnapTick;
    }
    if (member.slot >= 0) session.pushInput(member.slot, message);
  }

  /** Advances the running race by one simulation tick. */
  tick(): void {
    const session = this.session;
    if (!session || this.phase !== 'racing') return;
    const events = session.step();
    for (const event of events) {
      if (event.type === 'lap') {
        const car = session.cars[event.slot]!;
        if (!car.isBot && event.best && this.services.records.submit(session.trackId, car.name, event.ms)) {
          this.services.recordsChanged();
        }
      } else if (event.type === 'end') {
        this.resultsAt = session.tick + this.services.config.cooldownTicks;
      }
    }

    if (session.tick % this.services.config.snapshotEvery === 0) this.sendSnapshots(session);

    if (this.resultsAt >= 0 && session.tick >= this.resultsAt) {
      this.finishRace(session);
    } else if (this.raceHadHumans && !session.hasHumanCars()) {
      this.cancelRace('Race cancelled: every driver left.');
    }
  }

  /** Periodic maintenance. Returns false once the room should be deleted. */
  housekeeping(now: number): boolean {
    if (this.closed) return false;
    const grace = this.services.config.reconnectGraceMs;
    let expired = false;
    for (const member of [...this.members.values()]) {
      if (!member.conn && now - member.disconnectedAt >= grace) {
        this.remove(member, 'expired', 'Your seat expired.');
        expired = true;
      }
    }
    if (expired) this.afterRosterChange();
    if (this.members.size === 0) {
      this.closed = true;
      this.session = null;
      return false;
    }
    for (const [ip, until] of this.bans) if (until <= now) this.bans.delete(ip);

    if (this.phase === 'results' && now >= this.resultsUntil) this.enterLobby('');
    if (this.phase === 'lobby' && now - this.lastActivityAt >= this.services.config.roomIdleTimeoutMs) {
      this.services.logger.info('closing idle room', { room: this.code });
      this.close('The room was closed after a long time without activity.');
      return false;
    }
    // Keep the pings shown in the lobby reasonably fresh.
    if (this.phase !== 'racing' && now - this.lastPingBroadcast > 4000) {
      this.lastPingBroadcast = now;
      this.broadcastRoom();
    }
    return true;
  }

  // ------------------------------------------------------------------ views

  state(): RoomState {
    const members: MemberInfo[] = [...this.members.values()]
      .sort((a, b) => a.joinOrder - b.joinOrder)
      .map((m) => ({
        id: m.id,
        name: m.name,
        role: m.role,
        ready: m.ready,
        connected: m.conn !== null,
        pingMs: Math.min(60_000, Math.max(0, Math.round(m.conn?.pingMs ?? 0))),
        slot: m.slot,
        colour: m.colour,
      }));
    return {
      code: this.code,
      phase: this.phase,
      hostId: this.hostId,
      settings: { ...this.settings },
      members,
      race: this.session ? this.session.info() : null,
      results: this.results,
      lastRaceNote: this.lastRaceNote,
      phaseEndsInMs: this.phase === 'results' ? Math.max(0, Math.round(this.resultsUntil - this.services.now())) : 0,
    };
  }

  summary(): RoomSummary {
    const racers = this.racerCount;
    return {
      code: this.code,
      name: this.settings.name,
      hostName: this.members.get(this.hostId)?.name ?? 'Host',
      trackId: this.settings.trackId,
      laps: this.settings.laps,
      players: racers,
      maxPlayers: this.settings.maxPlayers,
      bots: Math.min(this.settings.bots, MAX_RACERS - racers),
      spectators: Math.min(MAX_SPECTATORS, this.spectatorCount),
      phase: this.phase,
      region: this.services.config.region,
    };
  }

  // ---------------------------------------------------------------- private

  private touch(): void {
    this.lastActivityAt = this.services.now();
  }

  private uniqueName(wanted: string, exceptId: string | null): string {
    const taken = new Set<string>();
    for (const m of this.members.values()) if (m.id !== exceptId) taken.add(m.name.toLowerCase());
    for (const bot of BOT_NAMES) taken.add(bot.toLowerCase());
    if (!taken.has(wanted.toLowerCase())) return wanted;
    for (let n = 2; n < 100; n++) {
      const suffix = ` ${n}`;
      const candidate = [...wanted].slice(0, NAME_MAX - suffix.length).join('').trimEnd() + suffix;
      if (!taken.has(candidate.toLowerCase())) return candidate;
    }
    return `Driver ${newId(3)}`.slice(0, NAME_MAX);
  }

  /** Lowest paint colour not used by another driver. */
  private freeColour(member: Member): number {
    const used = new Set<number>();
    for (const m of this.members.values()) if (m !== member && m.role === 'racer') used.add(m.colour);
    for (let c = 0; c < MAX_RACERS; c++) if (!used.has(c)) return c;
    return 0;
  }

  /** Makes sure the host is somebody who is actually here. */
  private ensureHost(): void {
    const current = this.members.get(this.hostId);
    if (current?.conn) return;
    let best: Member | null = null;
    for (const m of this.members.values()) {
      if (!m.conn) continue;
      if (!best || m.joinOrder < best.joinOrder) best = m;
    }
    if (!best) {
      // Nobody is connected. Keep the absent host if they still hold a seat.
      if (current) return;
      for (const m of this.members.values()) if (!best || m.joinOrder < best.joinOrder) best = m;
      if (best) this.hostId = best.id;
      return;
    }
    if (best.id !== this.hostId) {
      this.hostId = best.id;
      this.notice('host_changed', `${best.name} is now the host.`);
    }
  }

  private afterRosterChange(): void {
    if (this.phase === 'racing' && this.session && this.raceHadHumans && !this.session.hasHumanCars()) {
      this.cancelRace('Race cancelled: every driver left.');
    }
  }

  private sendSnapshots(session: RaceSession): void {
    session.snapshot();
    const now = this.services.now();
    for (const member of this.members.values()) {
      const conn = member.conn;
      if (!conn) continue;
      if (conn.transport.bufferedAmount() > BACKPRESSURE_BYTES) {
        // The client is not draining its socket. Skip (state is resent later
        // anyway) and give up on it if it stays that way.
        if (member.stalledSince === 0) member.stalledSince = now;
        else if (now - member.stalledSince > BACKPRESSURE_TIMEOUT_MS) conn.close(4009, 'stalled');
        continue;
      }
      member.stalledSince = 0;
      if (!session.hasBaseline(member.ackSnapTick)) {
        // No usable baseline (just joined, still loading, or not acknowledging):
        // full snapshots are sent at a reduced rate until an acknowledgement
        // arrives, so a silent client cannot cost unbounded bandwidth.
        if (member.lastFullTick >= 0 && session.tick - member.lastFullTick < FULL_SNAPSHOT_INTERVAL_TICKS) continue;
        member.lastFullTick = session.tick;
      }
      const bytes = session.encodeFor(member.ackSnapTick, member.slot);
      if (bytes) conn.sendBinary(bytes);
    }
  }

  private finishRace(session: RaceSession): void {
    const rows: ResultRow[] = session.sim.standings().map((row) => {
      const car = session.cars[row.slot]!;
      return {
        slot: row.slot,
        place: row.place,
        memberId: car.memberId,
        name: car.name,
        isBot: car.isBot,
        finished: row.finished,
        totalMs: Math.min(0xffffffff, Math.max(0, Math.round(row.totalMs))),
        bestLapMs: Math.min(0xffffffff, Math.max(0, Math.round(row.bestLapMs))),
        lapsCompleted: row.lapsCompleted,
        penalties: row.penalties,
        colour: car.colour,
      };
    });
    this.results = rows;
    this.session = null;
    this.phase = 'results';
    this.resultsAt = -1;
    this.resultsUntil = this.services.now() + this.services.config.resultsHoldMs;
    for (const m of this.members.values()) {
      m.slot = -1;
      m.ready = false;
    }
    this.touch();
    const winner = rows[0];
    this.notice('race_finished', winner ? `${winner.name} wins!` : 'Race finished.');
    this.broadcastRoom();
    this.services.directoryChanged();
    this.services.logger.info('race finished', {
      room: this.code,
      ticks: session.tick,
      seconds: Math.round(session.tick / SIM_HZ),
      reason: session.sim.endReason,
    });
  }

  private cancelRace(note: string): void {
    this.services.logger.info('race cancelled', { room: this.code, note });
    this.enterLobby(note);
    this.notice('race_cancelled', note);
  }

  private enterLobby(note: string): void {
    this.session = null;
    this.phase = 'lobby';
    this.results = null;
    this.resultsAt = -1;
    this.lastRaceNote = note;
    for (const m of this.members.values()) {
      m.slot = -1;
      m.ready = false;
    }
    this.touch();
    this.broadcastRoom();
    this.services.directoryChanged();
  }

  private notice(code: NoticeCode, message: string, exceptId?: string): void {
    this.broadcast({ t: 'notice', code, message }, exceptId);
  }

  private broadcastRoom(exceptId?: string): void {
    this.broadcast({ t: 'room', room: this.state() }, exceptId);
  }

  private broadcast(message: ServerMessage, exceptId?: string): void {
    for (const member of this.members.values()) {
      if (member.id !== exceptId) member.conn?.send(message);
    }
  }
}
