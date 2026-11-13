/**
 * The JSON half of the protocol: every control message in both directions,
 * defined once as runtime schemas from which the static types are inferred.
 *
 * Realtime traffic (inputs and snapshots) uses the binary codecs in
 * `binary.ts`. Both halves share PROTOCOL_VERSION.
 */
import {
  CHAT_MAX,
  MAX_LAPS,
  MAX_RACERS,
  MAX_SPECTATORS,
  MIN_LAPS,
  NAME_MAX,
  ROOM_CODE_LENGTH,
  ROOM_NAME_MAX,
} from '../constants';
import { TRACK_IDS } from '../sim/tracks';
import { sanitizer } from './sanitize';
import { s, type Infer, type Result, type Schema } from './schema';

/**
 * Bump on any incompatible change to the JSON messages or binary layouts.
 * Clients and servers with different versions refuse to talk to each other.
 */
export const PROTOCOL_VERSION = 4;

export const BOT_SKILLS = ['easy', 'medium', 'hard'] as const;
export type BotSkill = (typeof BOT_SKILLS)[number];
export const ROOM_PHASES = ['lobby', 'racing', 'results'] as const;
export type RoomPhase = (typeof ROOM_PHASES)[number];
export const ROLES = ['racer', 'spectator'] as const;
export type Role = (typeof ROLES)[number];

export const ERROR_CODES = [
  'version_mismatch',
  'bad_message',
  'rate_limited',
  'room_not_found',
  'room_full',
  'not_host',
  'not_in_room',
  'already_in_room',
  'invalid_state',
  'not_ready',
  'banned',
  'server_full',
  'resume_failed',
  'internal',
] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];

export const LEFT_REASONS = ['left', 'kicked', 'room_closed', 'expired', 'replaced'] as const;
export type LeftReason = (typeof LEFT_REASONS)[number];

export const NOTICE_CODES = [
  'host_changed',
  'race_cancelled',
  'player_joined',
  'player_left',
  'player_disconnected',
  'player_reconnected',
  'player_kicked',
  'race_finished',
] as const;
export type NoticeCode = (typeof NOTICE_CODES)[number];

/** WebSocket close codes used by the server. */
export const CLOSE = {
  BAD_MESSAGE: 4000,
  REPLACED: 4001,
  VERSION_MISMATCH: 4002,
  FLOOD: 4008,
  IDLE: 4009,
  SERVER_FULL: 4010,
  ORIGIN: 4011,
  SHUTDOWN: 1001,
  TOO_BIG: 1009,
} as const;

// ---------------------------------------------------------------- primitives

const playerName = s.string({ min: 1, max: NAME_MAX, sanitize: sanitizer(NAME_MAX) });
const roomName = s.string({ min: 1, max: ROOM_NAME_MAX, sanitize: sanitizer(ROOM_NAME_MAX) });
const chatText = s.string({ min: 1, max: CHAT_MAX, sanitize: sanitizer(CHAT_MAX) });
const roomCode = s.string({ min: ROOM_CODE_LENGTH, max: ROOM_CODE_LENGTH, pattern: /^[A-Z0-9]+$/ });
const memberId = s.string({ min: 4, max: 24, pattern: /^[A-Za-z0-9_-]+$/ });
const token = s.string({ min: 16, max: 128, pattern: /^[A-Za-z0-9_-]+$/ });
const trackId = s.enumOf(TRACK_IDS as readonly string[]);
const u32 = s.int(0, 0xffffffff);
const shortText = s.string({ max: 200, sanitize: sanitizer(200) });

export const roomSettingsSchema = s.object({
  name: roomName,
  trackId,
  laps: s.int(MIN_LAPS, MAX_LAPS),
  maxPlayers: s.int(1, MAX_RACERS),
  bots: s.int(0, MAX_RACERS - 1),
  botSkill: s.enumOf(BOT_SKILLS),
  isPublic: s.boolean(),
});
export type RoomSettings = Infer<typeof roomSettingsSchema>;

const roomSettingsPatchSchema = s.object({
  name: s.optional(roomName),
  trackId: s.optional(trackId),
  laps: s.optional(s.int(MIN_LAPS, MAX_LAPS)),
  maxPlayers: s.optional(s.int(1, MAX_RACERS)),
  bots: s.optional(s.int(0, MAX_RACERS - 1)),
  botSkill: s.optional(s.enumOf(BOT_SKILLS)),
  isPublic: s.optional(s.boolean()),
});
export type RoomSettingsPatch = Infer<typeof roomSettingsPatchSchema>;

// ------------------------------------------------------------ client -> server

const clientSchemas = {
  hello: s.object({
    t: s.literal('hello'),
    protocol: s.int(0, 0xffff),
    /** Free-form client build label, for logs only. */
    build: s.optional(s.string({ max: 32, sanitize: sanitizer(32) })),
  }),
  ping: s.object({
    t: s.literal('ping'),
    id: u32,
    /** Client clock, echoed back verbatim. Never interpreted by the server. */
    clientTime: s.number(0, Number.MAX_SAFE_INTEGER),
  }),
  list: s.object({ t: s.literal('list'), subscribe: s.boolean() }),
  create: s.object({ t: s.literal('create'), name: playerName, settings: roomSettingsSchema }),
  join: s.object({ t: s.literal('join'), code: roomCode, name: playerName, spectate: s.boolean() }),
  quick: s.object({ t: s.literal('quick'), name: playerName }),
  resume: s.object({ t: s.literal('resume'), code: roomCode, token }),
  leave: s.object({ t: s.literal('leave') }),
  ready: s.object({ t: s.literal('ready'), ready: s.boolean() }),
  role: s.object({ t: s.literal('role'), role: s.enumOf(ROLES) }),
  rename: s.object({ t: s.literal('rename'), name: playerName }),
  settings: s.object({ t: s.literal('settings'), patch: roomSettingsPatchSchema }),
  start: s.object({ t: s.literal('start') }),
  abort: s.object({ t: s.literal('abort') }),
  lobby: s.object({ t: s.literal('lobby') }),
  kick: s.object({ t: s.literal('kick'), id: memberId }),
  chat: s.object({ t: s.literal('chat'), text: chatText }),
} as const;

export type ClientMessageType = keyof typeof clientSchemas;
export type ClientMessageMap = { [K in ClientMessageType]: Infer<(typeof clientSchemas)[K]> };
export type ClientMessage = ClientMessageMap[ClientMessageType];

// ------------------------------------------------------------ server -> client

const memberSchema = s.object({
  id: memberId,
  name: playerName,
  role: s.enumOf(ROLES),
  ready: s.boolean(),
  connected: s.boolean(),
  pingMs: s.int(0, 60_000),
  /** Grid slot while a race is running, otherwise -1. */
  slot: s.int(-1, MAX_RACERS - 1),
  /** Index into CAR_COLORS; unique among the drivers of a room. */
  colour: s.int(0, MAX_RACERS - 1),
});
export type MemberInfo = Infer<typeof memberSchema>;

const raceCarSchema = s.object({
  slot: s.int(0, MAX_RACERS - 1),
  memberId: s.nullable(memberId),
  name: playerName,
  isBot: s.boolean(),
  colour: s.int(0, MAX_RACERS - 1),
});
export type RaceCarInfo = Infer<typeof raceCarSchema>;

const raceInfoSchema = s.object({
  /** Increments with every race held in the room. */
  raceId: u32,
  trackId,
  laps: s.int(MIN_LAPS, MAX_LAPS),
  /** Race tick of the green light. */
  goTick: u32,
  cars: s.array(raceCarSchema, MAX_RACERS),
});
export type RaceInfo = Infer<typeof raceInfoSchema>;

const resultRowSchema = s.object({
  slot: s.int(0, MAX_RACERS - 1),
  place: s.int(1, MAX_RACERS),
  memberId: s.nullable(memberId),
  name: playerName,
  isBot: s.boolean(),
  finished: s.boolean(),
  totalMs: u32,
  bestLapMs: u32,
  lapsCompleted: s.int(0, MAX_LAPS),
  penalties: s.int(0, 0xffff),
  colour: s.int(0, MAX_RACERS - 1),
});
export type ResultRow = Infer<typeof resultRowSchema>;

const roomStateSchema = s.object({
  code: roomCode,
  phase: s.enumOf(ROOM_PHASES),
  hostId: memberId,
  settings: roomSettingsSchema,
  members: s.array(memberSchema, MAX_RACERS + MAX_SPECTATORS),
  race: s.nullable(raceInfoSchema),
  results: s.nullable(s.array(resultRowSchema, MAX_RACERS)),
  /** Why the last race ended early, if it did. */
  lastRaceNote: s.string({ max: 120, sanitize: sanitizer(120) }),
  /** Milliseconds until the results screen closes by itself (0 otherwise). */
  phaseEndsInMs: s.int(0, 3_600_000),
});
export type RoomState = Infer<typeof roomStateSchema>;

const roomSummarySchema = s.object({
  code: roomCode,
  name: roomName,
  hostName: playerName,
  trackId,
  laps: s.int(MIN_LAPS, MAX_LAPS),
  players: s.int(0, MAX_RACERS),
  maxPlayers: s.int(1, MAX_RACERS),
  bots: s.int(0, MAX_RACERS),
  spectators: s.int(0, MAX_SPECTATORS),
  phase: s.enumOf(ROOM_PHASES),
  region: s.string({ max: 32, sanitize: sanitizer(32) }),
});
export type RoomSummary = Infer<typeof roomSummarySchema>;

const trackRecordSchema = s.object({
  trackId,
  name: playerName,
  ms: u32,
});
export type TrackRecord = Infer<typeof trackRecordSchema>;

const serverSchemas = {
  welcome: s.object({
    t: s.literal('welcome'),
    protocol: s.int(0, 0xffff),
    serverVersion: s.string({ max: 32, sanitize: sanitizer(32) }),
    /** Wall-clock ticks per second the server simulates at. */
    tickRate: s.int(10, 1000),
    /** A snapshot is sent every this many ticks. */
    snapshotEvery: s.int(1, 10),
    region: s.string({ max: 32, sanitize: sanitizer(32) }),
    reconnectGraceMs: s.int(0, 3_600_000),
    serverTime: s.number(0, Number.MAX_SAFE_INTEGER),
  }),
  error: s.object({
    t: s.literal('error'),
    code: s.enumOf(ERROR_CODES),
    message: shortText,
    /** True when the server is about to close the connection. */
    fatal: s.boolean(),
    retryAfterMs: s.optional(s.int(0, 3_600_000)),
  }),
  pong: s.object({
    t: s.literal('pong'),
    id: u32,
    clientTime: s.number(0, Number.MAX_SAFE_INTEGER),
    serverTime: s.number(0, Number.MAX_SAFE_INTEGER),
  }),
  rooms: s.object({
    t: s.literal('rooms'),
    rooms: s.array(roomSummarySchema, 200),
    /** Total rooms on the server, including private ones. */
    total: s.int(0, 100_000),
    online: s.int(0, 1_000_000),
  }),
  records: s.object({ t: s.literal('records'), records: s.array(trackRecordSchema, 32) }),
  joined: s.object({
    t: s.literal('joined'),
    room: roomStateSchema,
    youId: memberId,
    /** Secret reconnect credential; rotated on every successful resume. */
    token,
    resumed: s.boolean(),
  }),
  room: s.object({ t: s.literal('room'), room: roomStateSchema }),
  left: s.object({ t: s.literal('left'), reason: s.enumOf(LEFT_REASONS), message: shortText }),
  notice: s.object({ t: s.literal('notice'), code: s.enumOf(NOTICE_CODES), message: shortText }),
  chat: s.object({
    t: s.literal('chat'),
    fromId: memberId,
    name: playerName,
    text: chatText,
  }),
  shutdown: s.object({ t: s.literal('shutdown'), message: shortText }),
} as const;

export type ServerMessageType = keyof typeof serverSchemas;
export type ServerMessageMap = { [K in ServerMessageType]: Infer<(typeof serverSchemas)[K]> };
export type ServerMessage = ServerMessageMap[ServerMessageType];

// -------------------------------------------------------------------- parsing

function parseWith<T>(schemas: Record<string, Schema<unknown>>, text: string, maxLength: number): Result<T> {
  if (typeof text !== 'string') return { ok: false, error: 'message: expected text' };
  if (text.length > maxLength) return { ok: false, error: 'message: too large' };
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false, error: 'message: invalid JSON' };
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { ok: false, error: 'message: expected an object' };
  }
  const type = (raw as { t?: unknown }).t;
  if (typeof type !== 'string' || !Object.prototype.hasOwnProperty.call(schemas, type)) {
    return { ok: false, error: 'message: unknown type' };
  }
  return schemas[type]!.parse(raw, '') as Result<T>;
}

/** Validates a JSON frame sent by a client. */
export function parseClientMessage(text: string, maxLength = 4096): Result<ClientMessage> {
  return parseWith<ClientMessage>(clientSchemas, text, maxLength);
}

/** Validates a JSON frame sent by the server. */
export function parseServerMessage(text: string, maxLength = 512 * 1024): Result<ServerMessage> {
  return parseWith<ServerMessage>(serverSchemas, text, maxLength);
}

export function encodeMessage(message: ClientMessage | ServerMessage): string {
  return JSON.stringify(message);
}

/** Default settings for a freshly created room. */
export function defaultRoomSettings(hostName: string): RoomSettings {
  return {
    name: `${hostName}'s race`.slice(0, ROOM_NAME_MAX),
    trackId: TRACK_IDS[0]!,
    laps: 3,
    maxPlayers: MAX_RACERS,
    bots: 3,
    botSkill: 'medium',
    isPublic: true,
  };
}
