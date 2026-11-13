import { describe, expect, it } from 'vitest';
import { CHAT_MAX, MAX_INPUTS_PER_MESSAGE, MAX_RACERS, NAME_MAX } from '../../shared/constants';
import {
  BIN_INPUT,
  BIN_SNAPSHOT,
  CarFlag,
  MAX_INPUT_MESSAGE_BYTES,
  MAX_SNAPSHOT_BYTES,
  PROTOCOL_VERSION,
  applyQCar,
  decodeInput,
  decodeSnapshot,
  defaultRoomSettings,
  encodeInput,
  encodeSnapshot,
  normalizeRoomCode,
  parseClientMessage,
  parseServerMessage,
  peekSnapshot,
  quantizeCar,
  quantizeInput,
  sanitizeText,
  type ClientMessage,
  type QCar,
  type RoomState,
  type ServerMessage,
  type SnapshotBody,
} from '../../shared/protocol';
import { Rng } from '../../shared/sim/rng';
import { makeCarState } from '../../shared/sim/vehicle';

const settings = defaultRoomSettings('Ada');

function client(message: unknown): ReturnType<typeof parseClientMessage> {
  return parseClientMessage(JSON.stringify(message));
}

describe('protocol version', () => {
  it('is a single shared integer', () => {
    expect(Number.isInteger(PROTOCOL_VERSION)).toBe(true);
    expect(PROTOCOL_VERSION).toBeGreaterThan(0);
  });
});

describe('client -> server messages', () => {
  const valid: ClientMessage[] = [
    { t: 'hello', protocol: PROTOCOL_VERSION },
    { t: 'hello', protocol: PROTOCOL_VERSION, build: 'web' },
    { t: 'ping', id: 7, clientTime: 1234.5 },
    { t: 'list', subscribe: true },
    { t: 'create', name: 'Ada', settings },
    { t: 'join', code: 'ABCDE', name: 'Ada', spectate: false },
    { t: 'quick', name: 'Ada' },
    { t: 'resume', code: 'ABCDE', token: 'x'.repeat(32) },
    { t: 'leave' },
    { t: 'ready', ready: true },
    { t: 'role', role: 'spectator' },
    { t: 'rename', name: 'Grace' },
    { t: 'settings', patch: { laps: 5, trackId: 'glacier' } },
    { t: 'settings', patch: {} },
    { t: 'start' },
    { t: 'abort' },
    { t: 'lobby' },
    { t: 'kick', id: 'abcd1234' },
    { t: 'chat', text: 'good luck!' },
  ];

  it('accepts every well-formed message and returns it unchanged', () => {
    for (const message of valid) {
      const parsed = client(message);
      expect(parsed, JSON.stringify(message)).toEqual({ ok: true, value: message });
    }
  });

  it('rejects malformed frames', () => {
    for (const text of ['', 'not json', '[]', 'null', '42', '"hello"', '{}', '{"t":5}', '{"t":"nope"}', '{"t":"constructor"}', '{"t":"__proto__"}']) {
      expect(parseClientMessage(text).ok, text).toBe(false);
    }
  });

  it('rejects unknown fields, so clients cannot report positions, laps or times', () => {
    const forged: unknown[] = [
      { t: 'ready', ready: true, lapTimeMs: 1 },
      { t: 'ready', ready: true, position: { x: 0, z: 0 } },
      { t: 'start', finishMs: 1000 },
      { t: 'leave', cp: 99 },
      { t: 'chat', text: 'hi', fromId: 'someoneelse' },
      { t: 'settings', patch: { laps: 3, results: [] } },
      { t: 'create', name: 'Ada', settings: { ...settings, hostId: 'me' } },
      { t: 'finish', totalMs: 1 },
      { t: 'result', place: 1 },
      { t: 'position', x: 1, z: 2 },
      { t: 'ready', ready: true, __proto__x: 1 },
    ];
    for (const message of forged) {
      const parsed = client(message);
      expect(parsed.ok, JSON.stringify(message)).toBe(false);
    }
    const polluted = parseClientMessage('{"t":"ready","ready":true,"__proto__":{"admin":true}}');
    expect(polluted.ok).toBe(false);
  });

  it('enforces types and numeric bounds', () => {
    const bad: unknown[] = [
      { t: 'hello', protocol: '4' },
      { t: 'hello', protocol: -1 },
      { t: 'hello', protocol: 1.5 },
      { t: 'ping', id: -1, clientTime: 0 },
      { t: 'ping', id: 1, clientTime: Infinity },
      { t: 'ping', id: 1, clientTime: null },
      { t: 'list', subscribe: 'yes' },
      { t: 'ready', ready: 1 },
      { t: 'role', role: 'admin' },
      { t: 'join', code: 'abcde', name: 'Ada', spectate: false },
      { t: 'join', code: 'ABCD', name: 'Ada', spectate: false },
      { t: 'join', code: 'ABCDEF', name: 'Ada', spectate: false },
      { t: 'join', code: 'AB-DE', name: 'Ada', spectate: false },
      { t: 'join', code: 'ABCDE', name: '', spectate: false },
      { t: 'join', code: 'ABCDE', name: 'Ada' },
      { t: 'resume', code: 'ABCDE', token: 'short' },
      { t: 'resume', code: 'ABCDE', token: 'bad token with spaces!!' },
      { t: 'kick', id: '<script>' },
      { t: 'chat', text: '' },
      { t: 'chat', text: 42 },
      { t: 'create', name: 'Ada', settings: { ...settings, laps: 0 } },
      { t: 'create', name: 'Ada', settings: { ...settings, laps: 13 } },
      { t: 'create', name: 'Ada', settings: { ...settings, laps: 2.5 } },
      { t: 'create', name: 'Ada', settings: { ...settings, maxPlayers: 9 } },
      { t: 'create', name: 'Ada', settings: { ...settings, bots: 8 } },
      { t: 'create', name: 'Ada', settings: { ...settings, bots: -1 } },
      { t: 'create', name: 'Ada', settings: { ...settings, trackId: 'moon' } },
      { t: 'create', name: 'Ada', settings: { ...settings, botSkill: 'godlike' } },
      { t: 'create', name: 'Ada', settings: { ...settings, isPublic: 'true' } },
      { t: 'create', name: 'Ada', settings: { name: 'x' } },
      { t: 'create', name: 'Ada', settings: [] },
      { t: 'settings', patch: { laps: 99 } },
      { t: 'settings', patch: null },
    ];
    for (const message of bad) expect(client(message).ok, JSON.stringify(message)).toBe(false);
  });

  it('rejects oversized frames before parsing them', () => {
    const huge = JSON.stringify({ t: 'chat', text: 'a'.repeat(10_000) });
    const parsed = parseClientMessage(huge);
    expect(parsed).toEqual({ ok: false, error: 'message: too large' });
  });

  it('never lets a string field exceed its limit', () => {
    // Within the frame limit but beyond the field limit: cut down to size, never passed through.
    const chat = client({ t: 'chat', text: 'a'.repeat(CHAT_MAX + 50) });
    expect(chat.ok && chat.value.t === 'chat' && chat.value.text).toBe('a'.repeat(CHAT_MAX));
    const name = client({ t: 'rename', name: 'n'.repeat(NAME_MAX + 5) });
    expect(name.ok && name.value.t === 'rename' && name.value.name).toBe('n'.repeat(NAME_MAX));
    // Fields with a fixed format are rejected outright instead.
    expect(client({ t: 'join', code: 'ABCDEFGH', name: 'Ada', spectate: false }).ok).toBe(false);
    expect(client({ t: 'resume', code: 'ABCDE', token: 'x'.repeat(500) }).ok).toBe(false);
  });

  it('sanitises user-controlled strings', () => {
    const parsed = client({ t: 'rename', name: '  <b>Ad\u0000a</b>\u200b\u202e  ' });
    expect(parsed).toEqual({ ok: true, value: { t: 'rename', name: 'bAd a/b' } });
    const chat = client({ t: 'chat', text: 'hello\n\n\tworld  <img src=x onerror=alert(1)>' });
    expect(chat.ok && chat.value.t === 'chat' && chat.value.text).toBe('hello world img src=x onerror=alert(1)');
    // A name that is nothing but junk is rejected rather than left empty.
    expect(client({ t: 'rename', name: '\u200b\u200b <> ' }).ok).toBe(false);
  });
});

describe('sanitizeText', () => {
  it('strips control, invisible and markup characters and collapses whitespace', () => {
    expect(sanitizeText('a\u0007b', 20)).toBe('a b');
    expect(sanitizeText('\u202eevil\u202c', 20)).toBe('evil');
    expect(sanitizeText('zero\u200bwidth\ufeff', 20)).toBe('zerowidth');
    expect(sanitizeText('<script>alert(1)</script>', 40)).toBe('scriptalert(1)/script');
    expect(sanitizeText('  many   spaces\t\nhere ', 40)).toBe('many spaces here');
  });

  it('normalises compatibility forms and limits length by code points', () => {
    expect(sanitizeText('\uff21\uff22\uff23', 10)).toBe('ABC');
    expect(sanitizeText('abcdefghij', 4)).toBe('abcd');
    // Emoji are single code points and must not be cut in half.
    const flags = sanitizeText('\u{1f3c1}\u{1f3c1}\u{1f3c1}', 2);
    expect([...flags]).toHaveLength(2);
    expect(flags).toBe('\u{1f3c1}\u{1f3c1}');
  });

  it('tames stacked combining marks and survives hostile input', () => {
    const zalgo = 'a' + '\u0301'.repeat(50);
    expect([...sanitizeText(zalgo, 80)].length).toBeLessThanOrEqual(4);
    expect(sanitizeText('\ud800lone', 20)).toBe('lone');
    expect(sanitizeText('x'.repeat(1_000_000), 16)).toBe('x'.repeat(16));
  });

  it('normalises room codes typed by users', () => {
    expect(normalizeRoomCode(' ab-c 2e ')).toBe('ABC2E');
    expect(normalizeRoomCode('!!!')).toBe('');
  });
});

describe('server -> client messages', () => {
  const room: RoomState = {
    code: 'ABCDE',
    phase: 'lobby',
    hostId: 'host1234',
    settings,
    members: [{ id: 'host1234', name: 'Ada', role: 'racer', ready: false, connected: true, pingMs: 12, slot: -1, colour: 0 }],
    race: null,
    results: null,
    lastRaceNote: '',
    phaseEndsInMs: 0,
  };
  const valid: ServerMessage[] = [
    { t: 'welcome', protocol: PROTOCOL_VERSION, serverVersion: '1.0.0', tickRate: 60, snapshotEvery: 2, region: 'eu', reconnectGraceMs: 30000, serverTime: 1 },
    { t: 'error', code: 'room_full', message: 'Full', fatal: false },
    { t: 'error', code: 'rate_limited', message: 'Slow down', fatal: false, retryAfterMs: 500 },
    { t: 'pong', id: 1, clientTime: 5, serverTime: 6 },
    { t: 'rooms', rooms: [{ code: 'ABCDE', name: 'Race', hostName: 'Ada', trackId: 'harbor', laps: 3, players: 1, maxPlayers: 8, bots: 2, spectators: 0, phase: 'lobby', region: '' }], total: 1, online: 1 },
    { t: 'records', records: [{ trackId: 'harbor', name: 'Ada', ms: 60000 }] },
    { t: 'joined', room, youId: 'host1234', token: 't'.repeat(32), resumed: false },
    { t: 'room', room },
    {
      t: 'room',
      room: {
        ...room,
        phase: 'results',
        race: { raceId: 1, trackId: 'harbor', laps: 3, goTick: 240, cars: [{ slot: 0, memberId: 'host1234', name: 'Ada', isBot: false, colour: 0 }] },
        results: [{ slot: 0, place: 1, memberId: 'host1234', name: 'Ada', isBot: false, finished: true, totalMs: 1, bestLapMs: 1, lapsCompleted: 3, penalties: 0, colour: 0 }],
        phaseEndsInMs: 4000,
      },
    },
    { t: 'left', reason: 'kicked', message: 'Bye' },
    { t: 'notice', code: 'host_changed', message: 'New host' },
    { t: 'chat', fromId: 'host1234', name: 'Ada', text: 'hi' },
    { t: 'shutdown', message: 'Restarting' },
  ];

  it('accepts every well-formed message', () => {
    for (const message of valid) {
      const parsed = parseServerMessage(JSON.stringify(message));
      expect(parsed, JSON.stringify(message)).toEqual({ ok: true, value: message });
    }
  });

  it('rejects messages a compromised or buggy server might send', () => {
    const bad: unknown[] = [
      { t: 'welcome', protocol: PROTOCOL_VERSION },
      { t: 'error', code: 'made_up', message: 'x', fatal: false },
      { t: 'rooms', rooms: 'none', total: 0, online: 0 },
      { t: 'room', room: { ...room, phase: 'exploded' } },
      { t: 'room', room: { ...room, members: [{ ...room.members[0], slot: 99 }] } },
      { t: 'joined', room, youId: 'host1234' },
      { t: 'eval', code: 'alert(1)' },
    ];
    for (const message of bad) expect(parseServerMessage(JSON.stringify(message)).ok, JSON.stringify(message)).toBe(false);
  });

  it('sanitises strings coming from the server as well', () => {
    const parsed = parseServerMessage(JSON.stringify({ t: 'chat', fromId: 'host1234', name: 'A<i>da', text: '<b>hi</b>' }));
    expect(parsed).toEqual({ ok: true, value: { t: 'chat', fromId: 'host1234', name: 'Aida', text: 'bhi/b' } });
  });
});

describe('binary input frames', () => {
  const sample = {
    raceId: 3,
    ackSnapTick: 1234,
    clientTime: 99999,
    firstSeq: 500,
    inputs: [quantizeInput(-1, 1, 0, true, false), quantizeInput(0.5, 0.25, 1, false, true), quantizeInput(0, 0, 0, false, false)],
  };

  it('round-trips', () => {
    const bytes = encodeInput(sample);
    expect(bytes[0]).toBe(BIN_INPUT);
    expect(bytes.byteLength).toBeLessThanOrEqual(MAX_INPUT_MESSAGE_BYTES);
    expect(decodeInput(bytes)).toEqual({ ok: true, value: sample });
    const ack = { raceId: 0, ackSnapTick: 7, clientTime: 0, firstSeq: 0, inputs: [] };
    expect(decodeInput(encodeInput(ack))).toEqual({ ok: true, value: ack });
  });

  it('quantises and clamps raw input values', () => {
    expect(quantizeInput(5, 7, -3, false, false)).toEqual({ steer: 127, throttle: 255, brake: 0, handbrake: false, reset: false });
    expect(quantizeInput(NaN, Infinity, NaN, true, true)).toEqual({ steer: 0, throttle: 0, brake: 0, handbrake: true, reset: true });
    expect(quantizeInput(-0.5, 0.5, 0.5, false, false)).toEqual({ steer: -63, throttle: 128, brake: 128, handbrake: false, reset: false });
  });

  it('never carries more than the bounded number of inputs', () => {
    const many = { ...sample, inputs: Array.from({ length: 40 }, () => quantizeInput(0, 1, 0, false, false)) };
    const decoded = decodeInput(encodeInput(many));
    expect(decoded.ok && decoded.value.inputs.length).toBe(MAX_INPUTS_PER_MESSAGE);
  });

  it('rejects malformed frames', () => {
    const good = encodeInput(sample);
    const mutate = (fn: (b: Uint8Array) => Uint8Array | void): Uint8Array => {
      const copy = new Uint8Array(good);
      return fn(copy) ?? copy;
    };
    const cases: Array<[string, Uint8Array]> = [
      ['empty', new Uint8Array(0)],
      ['truncated header', good.subarray(0, 10)],
      ['truncated body', good.subarray(0, good.byteLength - 1)],
      ['trailing byte', mutate((b) => new Uint8Array([...b, 0]))],
      ['wrong type', mutate((b) => void (b[0] = BIN_SNAPSHOT))],
      ['count too large', mutate((b) => void (b[14] = MAX_INPUTS_PER_MESSAGE + 1))],
      ['count mismatch', mutate((b) => void (b[14] = 1))],
      ['unknown flag bits', mutate((b) => void (b[18] = 0xff))],
      ['steer out of range', mutate((b) => void (b[15] = 0x80))],
      ['oversized', new Uint8Array(MAX_INPUT_MESSAGE_BYTES + 1)],
      ['sequence zero', encodeInput({ ...sample, firstSeq: 0 })],
    ];
    for (const [label, bytes] of cases) expect(decodeInput(bytes).ok, label).toBe(false);
  });

  it('never throws on arbitrary bytes', () => {
    const rng = new Rng(1);
    for (let i = 0; i < 3000; i++) {
      const bytes = new Uint8Array(rng.int(0, 80));
      for (let k = 0; k < bytes.length; k++) bytes[k] = rng.int(0, 255);
      if (rng.next() < 0.5 && bytes.length > 0) bytes[0] = BIN_INPUT;
      expect(() => decodeInput(bytes)).not.toThrow();
    }
  });
});

function randomCar(rng: Rng, slot: number): QCar {
  const state = makeCarState(rng.range(-400, 400), rng.range(-400, 400), rng.range(-3.1, 3.1));
  state.vx = rng.range(-80, 80);
  state.vz = rng.range(-80, 80);
  state.yawRate = rng.range(-3, 3);
  state.steer = rng.range(-1, 1);
  state.frozen = rng.int(0, 200);
  state.penalty = rng.int(0, 200);
  return quantizeCar(slot, state, quantizeInput(rng.range(-1, 1), rng.next(), rng.next(), rng.next() < 0.5, false), rng.int(0, 4095), {
    cp: rng.int(0, 100),
    rank: slot + 1,
    cpMs: rng.int(0, 500000),
    lapStartMs: rng.int(0, 500000),
    lastLapMs: rng.int(0, 90000),
    bestLapMs: rng.int(0, 90000),
    finishMs: 0,
  });
}

function body(tick: number, cars: QCar[], extra: Partial<SnapshotBody> = {}): SnapshotBody {
  return { raceId: 1, tick, phase: 1, goTick: 240, endsAtTick: 0, cars, ...extra };
}

describe('binary snapshots', () => {
  const rng = new Rng(42);
  const base = body(100, Array.from({ length: MAX_RACERS }, (_, slot) => randomCar(rng, slot)));

  it('round-trips a full snapshot exactly', () => {
    const bytes = encodeSnapshot(base, null, 55, 3);
    expect(bytes[0]).toBe(BIN_SNAPSHOT);
    expect(bytes.byteLength).toBeLessThanOrEqual(MAX_SNAPSHOT_BYTES);
    expect(peekSnapshot(bytes)).toEqual({ raceId: 1, tick: 100 });
    const decoded = decodeSnapshot(bytes, () => undefined);
    expect(decoded).toEqual({ ok: true, value: { ...base, baseTick: 0, ackSeq: 55, queueDepth: 3 } });
  });

  it('reconstructs the exact state from a delta against an acknowledged baseline', () => {
    let previous = base;
    const local = new Rng(9);
    for (let step = 1; step <= 60; step++) {
      // Each step changes some groups of some cars, as a real race would.
      const cars = previous.cars.map((car) => {
        const next = { ...car };
        if (local.next() < 0.8) {
          next.x = Math.fround(next.x + local.range(-1, 1));
          next.z = Math.fround(next.z + local.range(-1, 1));
        }
        if (local.next() < 0.6) next.vx = Math.round(local.range(-8000, 8000));
        if (local.next() < 0.2) next.flags ^= CarFlag.DRIFT;
        if (local.next() < 0.1) next.cp++;
        if (local.next() < 0.05) next.lastLapMs = local.int(1, 90000);
        return next;
      });
      const current = body(100 + step * 2, cars);
      const delta = encodeSnapshot(current, previous, step, 1);
      const decoded = decodeSnapshot(delta, (tick) => (tick === previous.tick ? previous : undefined));
      expect(decoded.ok && decoded.value.cars).toEqual(current.cars);
      expect(decoded.ok && decoded.value.baseTick).toBe(previous.tick);
      previous = current;
    }
  });

  it('sends only what changed', () => {
    const full = encodeSnapshot(base, null, 0, 0);
    const still = encodeSnapshot(body(102, base.cars), base, 0, 0);
    // Nothing changed: header plus an empty entry list.
    expect(still.byteLength).toBe(26);
    const moved = body(104, base.cars.map((car, i) => (i === 2 ? { ...car, x: Math.fround(car.x + 1) } : car)));
    const delta = encodeSnapshot(moved, base, 0, 0);
    expect(delta.byteLength).toBe(26 + 2 + 10);
    expect(delta.byteLength).toBeLessThan(full.byteLength / 8);
    const decoded = decodeSnapshot(delta, () => base);
    expect(decoded.ok && decoded.value.cars).toEqual(moved.cars);
  });

  it('encodes cars that left and cars that appeared', () => {
    const fewer = body(110, base.cars.filter((car) => car.slot !== 3));
    const gone = decodeSnapshot(encodeSnapshot(fewer, base, 0, 0), () => base);
    expect(gone.ok && gone.value.cars.map((c) => c.slot)).toEqual([0, 1, 2, 4, 5, 6, 7]);
    const back = decodeSnapshot(encodeSnapshot(body(120, base.cars), fewer, 0, 0), () => fewer);
    expect(back.ok && back.value.cars).toEqual(base.cars);
  });

  it('reports a missing baseline instead of guessing', () => {
    const delta = encodeSnapshot(body(102, base.cars), base, 0, 0);
    const decoded = decodeSnapshot(delta, () => undefined);
    expect(decoded).toMatchObject({ ok: false, missingBase: 100 });
    // A baseline from another race is not acceptable either.
    const other = decodeSnapshot(delta, () => ({ ...base, raceId: 2 }));
    expect(other.ok).toBe(false);
  });

  it('applies wire cars to simulation state within quantisation error', () => {
    const state = makeCarState(123.456, -78.9, 1.2345);
    state.vx = 33.333;
    state.vz = -12.345;
    state.yawRate = 0.4567;
    state.steer = -0.37;
    state.frozen = 12;
    state.penalty = 34;
    const q = quantizeCar(0, state, quantizeInput(0, 0, 0, false, false), 0, { cp: 0, rank: 1, cpMs: 0, lapStartMs: 0, lastLapMs: 0, bestLapMs: 0, finishMs: 0 });
    const out = applyQCar(q, makeCarState());
    expect(out.x).toBeCloseTo(state.x, 3);
    expect(out.z).toBeCloseTo(state.z, 3);
    expect(Math.abs(out.yaw - state.yaw)).toBeLessThan(1e-4);
    expect(Math.abs(out.vx - state.vx)).toBeLessThan(0.006);
    expect(Math.abs(out.vz - state.vz)).toBeLessThan(0.006);
    expect(Math.abs(out.yawRate - state.yawRate)).toBeLessThan(0.0006);
    expect(Math.abs(out.steer - state.steer)).toBeLessThan(0.005);
    expect(out.frozen).toBe(12);
    expect(out.penalty).toBe(34);
  });

  it('rejects corrupt frames', () => {
    const good = encodeSnapshot(base, null, 1, 1);
    const mutate = (fn: (b: Uint8Array, v: DataView) => void): Uint8Array => {
      const copy = new Uint8Array(good);
      fn(copy, new DataView(copy.buffer));
      return copy;
    };
    const cases: Array<[string, Uint8Array]> = [
      ['empty', new Uint8Array(0)],
      ['truncated', good.subarray(0, good.byteLength - 3)],
      ['trailing', new Uint8Array([...good, 1, 2, 3])],
      ['wrong type', mutate((b) => void (b[0] = BIN_INPUT))],
      ['tick zero', mutate((_, v) => v.setUint32(2, 0, true))],
      ['base not before tick', mutate((b, v) => { b[1] = 0; v.setUint32(6, 100, true); })],
      ['full flag with base', mutate((_, v) => v.setUint32(6, 50, true))],
      ['bad phase', mutate((b) => void (b[15] = 9))],
      ['too many cars', mutate((b) => void (b[25] = 200))],
      ['slot out of range', mutate((b) => void (b[26] = 40))],
      ['duplicate slot', mutate((b) => void (b[26 + 50] = b[26]!))],
      ['empty mask', mutate((b) => void (b[27] = 0))],
      ['unknown mask bits', mutate((b) => void (b[27] = 0x7f))],
      ['NaN position', mutate((_, v) => v.setFloat32(28, NaN, true))],
      ['absurd position', mutate((_, v) => v.setFloat32(28, 1e9, true))],
      ['oversized', new Uint8Array(MAX_SNAPSHOT_BYTES + 1)],
    ];
    for (const [label, bytes] of cases) expect(decodeSnapshot(bytes, () => undefined).ok, label).toBe(false);
    // A partial update for a car the baseline does not have is invalid.
    const partial = encodeSnapshot(body(102, base.cars.map((c, i) => (i === 0 ? { ...c, x: 1 } : c))), base, 0, 0);
    expect(decodeSnapshot(partial, () => ({ ...base, cars: base.cars.slice(1) })).ok).toBe(false);
  });

  it('never throws on arbitrary bytes', () => {
    const local = new Rng(77);
    const good = encodeSnapshot(base, null, 1, 1);
    for (let i = 0; i < 4000; i++) {
      let bytes: Uint8Array;
      if (local.next() < 0.5) {
        // Bit-flip a valid frame.
        bytes = new Uint8Array(good);
        for (let k = 0; k < 4; k++) bytes[local.int(0, bytes.length - 1)] = local.int(0, 255);
      } else {
        bytes = new Uint8Array(local.int(0, 300));
        for (let k = 0; k < bytes.length; k++) bytes[k] = local.int(0, 255);
        if (bytes.length > 0) bytes[0] = BIN_SNAPSHOT;
      }
      let result: ReturnType<typeof decodeSnapshot> | undefined;
      expect(() => (result = decodeSnapshot(bytes, () => base))).not.toThrow();
      if (result?.ok) {
        for (const car of result.value.cars) expect(Number.isFinite(car.x) && Number.isFinite(car.z)).toBe(true);
      }
    }
  });
});
