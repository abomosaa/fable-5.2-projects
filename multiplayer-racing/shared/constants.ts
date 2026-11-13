/**
 * Constants shared by the simulation, the protocol, the server and the client.
 * Nothing in here may depend on DOM or Node APIs.
 */

/** Simulation steps per simulated second. The step size never changes. */
export const SIM_HZ = 60;
/** Fixed simulation timestep in seconds. */
export const DT = 1 / SIM_HZ;
/** Simulated milliseconds per tick. */
export const TICK_MS = 1000 / SIM_HZ;

/** Maximum number of cars (humans + bots) on a grid. */
export const MAX_RACERS = 8;
/** Maximum number of spectators in a room. */
export const MAX_SPECTATORS = 16;
export const MIN_LAPS = 1;
export const MAX_LAPS = 12;

/** Default wall-clock tick rate. Servers may override it (announced in `welcome`). */
export const DEFAULT_TICK_RATE = 60;
/** A snapshot is sent every N simulation ticks. */
export const DEFAULT_SNAPSHOT_EVERY = 2;

/** Countdown length in ticks between race creation and the green light. */
export const COUNTDOWN_TICKS = 4 * SIM_HZ;
/** Once the first car finishes, everybody else has this long to finish. */
export const FINISH_TIMEOUT_TICKS = 60 * SIM_HZ;
/** Results screen duration before the room returns to the lobby on its own. */
export const RESULTS_HOLD_TICKS = 40 * SIM_HZ;
/** Hard cap on a race's duration (safety net against abandoned races). */
export const MAX_RACE_TICKS = 30 * 60 * SIM_HZ;

/** Input redundancy: number of inputs carried by a single input message. */
export const MAX_INPUTS_PER_MESSAGE = 8;
/** Server-side cap on buffered, not yet simulated inputs per player. */
export const INPUT_QUEUE_MAX = 10;
/** Queue depth the server trims back to after an overflow. */
export const INPUT_QUEUE_TARGET = 2;
/** How long the server keeps applying the last input when starved. */
export const INPUT_HOLD_TICKS = 12;
/** Inputs with a sequence number this far ahead of the newest are rejected. */
export const INPUT_SEQ_WINDOW = 2048;

/** Snapshot baselines kept by the server for delta encoding. */
export const SNAPSHOT_HISTORY = 64;
/** Decoded snapshots kept by a client to resolve delta baselines. */
export const CLIENT_SNAPSHOT_HISTORY = 128;

/** Text limits (in code points) enforced by the protocol on both sides. */
export const NAME_MAX = 16;
export const ROOM_NAME_MAX = 28;
export const CHAT_MAX = 140;
export const ROOM_CODE_LENGTH = 5;
/** Alphabet without look-alike characters (no 0/O, 1/I/L). */
export const ROOM_CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

/** Largest client->server frame the server accepts (bytes). */
export const MAX_CLIENT_MESSAGE_BYTES = 2048;
/** Largest server->client frame a client accepts (bytes). */
export const MAX_SERVER_MESSAGE_BYTES = 256 * 1024;

/** Colour-blind-safe car paint palette (Okabe-Ito inspired), indexed by slot. */
export const CAR_COLORS = [
  0xe69f00, // orange
  0x56b4e9, // sky blue
  0x009e73, // bluish green
  0xf0e442, // yellow
  0x0072b2, // blue
  0xd55e00, // vermillion
  0xcc79a7, // reddish purple
  0xdddddd, // white
] as const;

export const BOT_NAMES = [
  'Turbo Tessa',
  'Slipstream Sam',
  'Apex Ada',
  'Drift Dmitri',
  'Nitro Noor',
  'Gearbox Gus',
  'Hairpin Hana',
  'Redline Rio',
] as const;
