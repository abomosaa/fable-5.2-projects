import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig, testConfig } from '../../server/src/config';
import { InputQueue } from '../../server/src/game/inputQueue';
import { FileRecordsStore, MemoryRecordsStore } from '../../server/src/persistence/recordsStore';
import { isOriginAllowed } from '../../server/src/security/origin';
import { KeyedRateLimiter, StrikeCounter, TokenBucket } from '../../server/src/security/rateLimit';
import { newRoomCode, newToken, safeEqual } from '../../server/src/util/ids';
import { silentLogger } from '../../server/src/util/logger';
import { INPUT_HOLD_TICKS, INPUT_QUEUE_MAX, INPUT_QUEUE_TARGET, INPUT_SEQ_WINDOW, ROOM_CODE_ALPHABET, ROOM_CODE_LENGTH } from '../../shared/constants';
import { CLOSE, encodeInput, encodeSnapshot } from '../../shared/protocol';
import type { CarInput } from '../../shared/sim/vehicle';
import { TestServer, hostRoom, joinRoom, roomSettings } from '../helpers/fakes';

const gas: CarInput = { steer: 0, throttle: 255, brake: 0, handbrake: false, reset: false };
const steer = (value: number): CarInput => ({ ...gas, steer: value });

describe('input queue', () => {
  it('hands out one input per tick, in sequence order', () => {
    const queue = new InputQueue();
    queue.push(1, [steer(1), steer(2), steer(3)]);
    expect(queue.depth).toBe(3);
    expect([queue.next().steer, queue.next().steer, queue.next().steer]).toEqual([1, 2, 3]);
    expect(queue.lastConsumedSeq).toBe(3);
    expect(queue.depth).toBe(0);
  });

  it('ignores duplicates and stale sequence numbers', () => {
    const queue = new InputQueue();
    queue.push(1, [steer(1), steer(2)]);
    queue.push(1, [steer(9), steer(9), steer(3)]); // Redundant resend: only seq 3 is new.
    expect(queue.depth).toBe(3);
    expect(queue.stats.duplicate).toBe(2);
    expect([queue.next().steer, queue.next().steer, queue.next().steer]).toEqual([1, 2, 3]);
    queue.push(1, [steer(7), steer(7), steer(7)]); // Entirely in the past.
    expect(queue.depth).toBe(0);
    expect(queue.stats.stale).toBe(3);
    expect(queue.lastConsumedSeq).toBe(3);
  });

  it('reorders late arrivals and skips over lost inputs', () => {
    const queue = new InputQueue();
    queue.push(3, [steer(3)]);
    queue.push(1, [steer(1)]);
    queue.push(2, [steer(2)]);
    expect([queue.next().steer, queue.next().steer, queue.next().steer]).toEqual([1, 2, 3]);
    // Seq 4 and 5 never arrive; 6 is used when its turn comes and 4/5 become stale.
    queue.push(6, [steer(6)]);
    expect(queue.next().steer).toBe(6);
    queue.push(4, [steer(4), steer(5)]);
    expect(queue.depth).toBe(0);
    expect(queue.stats.stale).toBe(2);
  });

  it('rejects sequence numbers implausibly far in the future', () => {
    const queue = new InputQueue();
    queue.push(1, [steer(1)]);
    queue.push(1 + INPUT_SEQ_WINDOW + 5, [steer(99)]);
    queue.push(0xfffffff0, [steer(99)]);
    expect(queue.depth).toBe(1);
    expect(queue.stats.rejected).toBe(2);
    // The real stream is unaffected.
    queue.push(2, [steer(2)]);
    expect([queue.next().steer, queue.next().steer]).toEqual([1, 2]);
  });

  it('cannot be made to simulate faster by sending inputs faster', () => {
    const queue = new InputQueue();
    let consumed = 0;
    // 10x the legitimate rate for 600 ticks.
    for (let tick = 0; tick < 600; tick++) {
      const first = tick * 10 + 1;
      queue.push(first, Array.from({ length: 8 }, () => gas));
      queue.push(first + 8, [gas, gas]);
      queue.next();
      consumed++;
      expect(queue.depth).toBeLessThanOrEqual(INPUT_QUEUE_MAX);
    }
    expect(consumed).toBe(600); // Exactly one input per tick, never more.
    expect(queue.stats.trimmed).toBeGreaterThan(4000);
  });

  it('trims a burst back to a small backlog instead of replaying it late', () => {
    const queue = new InputQueue();
    queue.push(1, Array.from({ length: 8 }, (_, i) => steer(i + 1)));
    queue.push(9, Array.from({ length: 8 }, (_, i) => steer(i + 9)));
    expect(queue.depth).toBe(INPUT_QUEUE_TARGET);
    expect(queue.stats.trimmed).toBe(16 - INPUT_QUEUE_TARGET);
    // The newest inputs survive; the acknowledgement skips the dropped ones.
    expect(queue.next().steer).toBe(15);
    expect(queue.lastConsumedSeq).toBe(15);
  });

  it('holds the last input briefly when starved, then coasts', () => {
    const queue = new InputQueue();
    queue.push(1, [{ steer: 50, throttle: 255, brake: 0, handbrake: false, reset: true }]);
    expect(queue.next()).toMatchObject({ throttle: 255, reset: true });
    for (let i = 0; i < INPUT_HOLD_TICKS; i++) {
      // Latency is not punished: the controls stay as they were (minus one-shot actions).
      expect(queue.next()).toMatchObject({ steer: 50, throttle: 255, reset: false });
    }
    expect(queue.next()).toEqual({ steer: 0, throttle: 0, brake: 0, handbrake: false, reset: false });
    expect(queue.stats.starved).toBe(INPUT_HOLD_TICKS + 1);
    expect(queue.lastConsumedSeq).toBe(1);
    // Fresh input is picked up immediately.
    queue.push(2, [steer(7)]);
    expect(queue.next().steer).toBe(7);
  });
});

describe('server-side validation of client traffic', () => {
  it('rejects client-reported results, positions and other forged fields', () => {
    const server = new TestServer();
    const host = hostRoom(server, { laps: 1 });
    host.send({ t: 'start' });
    const code = host.room!.code;
    server.advance(1500);
    const sim = server.room(code).session!.sim;
    const before = sim.serialize();
    host.clear();
    const forged: unknown[] = [
      { t: 'finish', totalMs: 1 },
      { t: 'result', place: 1, bestLapMs: 1000 },
      { t: 'state', x: 500, z: 500, lap: 3 },
      { t: 'ready', ready: true, finishMs: 1 },
      { t: 'lobby', results: [{ slot: 0, place: 1 }] },
      { t: 'chat', text: 'hi', cp: 31 },
    ];
    for (const message of forged) host.send(message);
    expect(host.errors()).toEqual(forged.map(() => 'bad_message'));
    expect(sim.serialize()).toEqual(before);
    expect(host.room!.phase).toBe('racing');
    expect(sim.cars[0]!.cp).toBe(0);
    expect(sim.cars[0]!.finished).toBe(false);
  });

  it('only accepts the bounded input frame as binary: no positions can be injected', () => {
    const server = new TestServer();
    const host = hostRoom(server, { laps: 1 });
    host.send({ t: 'start' });
    const code = host.room!.code;
    server.advance(1200);
    const car = server.room(code).session!.sim.cars[0]!;
    const start = [car.state.x, car.state.z];
    host.clear();
    // A snapshot frame claiming the car is at the finish, sent *to* the server.
    const fake = encodeSnapshot(
      { raceId: 1, tick: 5000, phase: 2, goTick: 60, endsAtTick: 0, cars: [{ ...host.snapshot!.cars[0]!, x: 0, z: 0, cp: 99, finishMs: 1, flags: 1 }] },
      null,
      0,
      0,
    );
    host.sendBinary(fake);
    host.sendBinary(new Uint8Array([1, 2, 3]));
    host.sendBinary(new Uint8Array(0));
    host.sendBinary(new Uint8Array(200).fill(1));
    expect(host.errors()).toEqual(['bad_message', 'bad_message', 'bad_message', 'bad_message']);
    server.advance(200);
    expect([car.state.x, car.state.z]).toEqual(start);
    expect(car.cp).toBe(0);
  });

  it('ignores inputs addressed to another race and stale or duplicated sequences', () => {
    const server = new TestServer();
    const host = hostRoom(server, { laps: 1 });
    host.send({ t: 'start' });
    const session = server.room(host.room!.code).session!;
    const queue = session.cars[0]!.queue!;
    server.advance(1200);
    const frame = (raceId: number, firstSeq: number, count: number): Uint8Array =>
      encodeInput({ raceId, ackSnapTick: 0, clientTime: 0, firstSeq, inputs: Array.from({ length: count }, () => gas) });

    host.sendBinary(frame(77, 1, 4)); // Wrong race.
    expect(queue.stats.accepted).toBe(0);
    host.sendBinary(frame(1, 1, 4));
    host.sendBinary(frame(1, 1, 4)); // Exact duplicate.
    expect(queue.stats.accepted).toBe(4);
    expect(queue.stats.duplicate).toBe(4);
    server.advance(200);
    host.sendBinary(frame(1, 2, 3)); // Already simulated.
    expect(queue.stats.stale).toBe(3);
    expect(queue.lastConsumedSeq).toBe(4);
    expect(host.closed).toBeNull();
  });

  it('simulates exactly one input per tick however many are sent', () => {
    const server = new TestServer();
    const honest = hostRoom(server, { laps: 1 });
    const cheat = joinRoom(server, honest.room!.code, 'Speedy');
    cheat.send({ t: 'ready', ready: true });
    honest.send({ t: 'start' });
    const session = server.room(honest.room!.code).session!;
    const tickMs = 1000 / server.config.tickRate;
    const a = session.sim.cars[honest.mySlot]!;
    const b = session.sim.cars[cheat.mySlot]!;
    const gridA = a.distance;
    const gridB = b.distance;
    let seq = 0;
    // Countdown plus five seconds flat out down the start straight.
    for (let tick = 0; tick < server.config.countdownTicks + 300; tick++) {
      honest.drive({ throttle: 255 });
      // Three full frames per tick: 24x the legitimate input rate.
      for (let k = 0; k < 3; k++) {
        cheat.sendBinary(encodeInput({ raceId: 1, ackSnapTick: 0, clientTime: 0, firstSeq: seq + 1, inputs: Array.from({ length: 8 }, () => gas) }));
        seq += 8;
      }
      server.advance(tickMs);
    }
    // Same throttle, same physics, same number of simulated ticks: no advantage.
    expect(a.tel.speed).toBeGreaterThan(30);
    expect(Math.abs(a.tel.speed - b.tel.speed)).toBeLessThan(0.5);
    expect(Math.abs(a.distance - gridA - (b.distance - gridB))).toBeLessThan(2);
    expect(session.cars[cheat.mySlot]!.queue!.stats.trimmed).toBeGreaterThan(5000);
  });

  it('disconnects a sustained input flood but tolerates a latency burst', () => {
    const server = new TestServer();
    const host = hostRoom(server, { laps: 1 });
    host.send({ t: 'start' });
    server.advance(1200);
    const frame = (seq: number): Uint8Array => encodeInput({ raceId: 1, ackSnapTick: 0, clientTime: 0, firstSeq: seq, inputs: [gas] });
    // Two seconds of inputs arriving at once after a network stall: fine.
    for (let i = 1; i <= 120; i++) host.sendBinary(frame(i));
    server.advance(1000);
    expect(host.closed).toBeNull();
    // A sustained flood at many times the tick rate: dropped, then disconnected.
    let seq = 200;
    for (let ms = 0; ms < 5000 && !host.closed; ms += 10) {
      for (let k = 0; k < 40; k++) host.sendBinary(frame(seq++));
      server.advance(10);
    }
    expect(host.closed?.code).toBe(CLOSE.FLOOD);
    expect(host.last('error')).toMatchObject({ code: 'rate_limited', fatal: true });
  });

  it('rejects oversized and malformed text frames, and drops repeat offenders', () => {
    const server = new TestServer();
    const client = server.client();
    client.sendRaw(JSON.stringify({ t: 'chat', text: 'x'.repeat(5000) }));
    client.sendRaw('{"t":');
    client.sendRaw('[1,2,3]');
    expect(client.errors()).toEqual(['bad_message', 'bad_message', 'bad_message']);
    expect(client.closed).toBeNull();
    for (let i = 0; i < 30 && !client.closed; i++) client.sendRaw('garbage');
    expect(client.closed?.code).toBe(CLOSE.BAD_MESSAGE);
    expect(client.last('error')).toMatchObject({ code: 'bad_message', fatal: true });
  });

  it('tolerates the occasional malformed message from a long-lived client', () => {
    const server = new TestServer();
    const client = server.client();
    for (let i = 0; i < 40; i++) {
      client.sendRaw('oops');
      server.advance(30_000);
      client.send({ t: 'ping', id: i, clientTime: 0 });
    }
    expect(client.closed).toBeNull();
  });
});

describe('rate limiting', () => {
  it('limits chat without disconnecting the sender', () => {
    const server = new TestServer();
    const host = hostRoom(server);
    const bob = joinRoom(server, host.room!.code, 'Bob');
    for (let i = 0; i < 20; i++) bob.send({ t: 'chat', text: `spam ${i}` });
    expect(host.all('chat').length).toBe(4);
    expect(bob.all('error').filter((e) => e.code === 'rate_limited').length).toBe(1);
    expect(bob.last('error')?.retryAfterMs).toBeGreaterThan(0);
    expect(bob.closed).toBeNull();
    server.advance(5000);
    bob.send({ t: 'chat', text: 'sorry' });
    expect(host.last('chat')?.text).toBe('sorry');
  });

  it('limits room creation per address', () => {
    const server = new TestServer({ createBurst: 3, createPerMinute: 6, maxRoomsPerIp: 50 });
    const ip = '203.0.113.50';
    let created = 0;
    let limited = 0;
    for (let i = 0; i < 10; i++) {
      const client = server.client(ip).send({ t: 'create', name: 'Spam', settings: roomSettings() });
      if (client.room) created++;
      else if (client.errors().includes('rate_limited')) limited++;
    }
    expect(created).toBe(3);
    expect(limited).toBe(7);
    // Other addresses are unaffected, and the budget refills.
    expect(server.client('203.0.113.51').send({ t: 'create', name: 'Ok', settings: roomSettings() }).room).not.toBeNull();
    server.advance(11_000);
    expect(server.client(ip).send({ t: 'create', name: 'Later', settings: roomSettings() }).room).not.toBeNull();
  });

  it('caps open rooms per address and on the whole server', () => {
    const perIp = new TestServer({ maxRoomsPerIp: 2, createBurst: 50 });
    const ip = '203.0.113.60';
    const results = Array.from({ length: 4 }, () => perIp.client(ip).send({ t: 'create', name: 'A', settings: roomSettings() }));
    expect(results.map((c) => c.room !== null)).toEqual([true, true, false, false]);
    expect(results[2]!.errors()).toEqual(['rate_limited']);

    const global = new TestServer({ maxRooms: 2 });
    hostRoom(global);
    hostRoom(global);
    const third = global.client().send({ t: 'create', name: 'C', settings: roomSettings() });
    expect(third.errors()).toEqual(['server_full']);
    expect(global.manager.rooms.size).toBe(2);
  });

  it('limits joins and room list requests', () => {
    const server = new TestServer({ joinBurst: 5, joinPerMinute: 10 });
    const client = server.client();
    for (let i = 0; i < 12; i++) client.send({ t: 'join', code: 'ZZZZZ', name: 'Bob', spectate: false });
    expect(client.errors().filter((c) => c === 'room_not_found')).toHaveLength(5);
    expect(client.errors().filter((c) => c === 'rate_limited')).toHaveLength(7);

    const lister = server.client();
    for (let i = 0; i < 30; i++) lister.send({ t: 'list', subscribe: false });
    expect(lister.all('rooms').length).toBe(5);
    expect(lister.closed).toBeNull();
  });

  it('limits name changes and pings', () => {
    const server = new TestServer();
    const host = hostRoom(server);
    for (let i = 0; i < 10; i++) host.send({ t: 'rename', name: `Name ${i}` });
    expect(host.me?.name).toBe('Name 2');
    host.clear();
    for (let i = 0; i < 40; i++) host.send({ t: 'ping', id: i, clientTime: 0 });
    expect(host.all('pong').length).toBe(10);
  });

  it('disconnects a client that floods text messages', () => {
    const server = new TestServer();
    const client = server.client();
    for (let i = 0; i < 5000 && !client.closed; i++) client.send({ t: 'ping', id: i, clientTime: 0 });
    expect(client.closed?.code).toBe(CLOSE.FLOOD);
    // The rate-limit notice itself is rate limited (no amplification).
    expect(client.all('error').length).toBeLessThanOrEqual(3);
  });

  it('enforces connection limits at admission', () => {
    const server = new TestServer({ maxConnections: 5, maxConnectionsPerIp: 2, connectBurst: 4, connectPerMinute: 60 });
    const ip = '203.0.113.70';
    expect(server.manager.admit(ip)).toBeNull();
    server.socket(ip);
    expect(server.manager.admit(ip)).toBeNull();
    const second = server.socket(ip);
    expect(server.manager.admit(ip)).toBe('ip_limit');
    second.drop();
    expect(server.manager.admit(ip)).toBeNull();
    expect(server.manager.admit(ip)).toBeNull();
    // Connection attempts themselves are rate limited per address.
    expect(server.manager.admit(ip)).toBe('rate_limited');
    for (let i = 0; i < 4; i++) server.socket(`203.0.113.${80 + i}`);
    expect(server.manager.admit('203.0.113.99')).toBe('server_full');
  });

  it('token buckets refill over time and report when to retry', () => {
    const bucket = new TokenBucket(3, 2, 0);
    expect([bucket.take(0), bucket.take(0), bucket.take(0), bucket.take(0)]).toEqual([true, true, true, false]);
    expect(bucket.retryAfterMs(0)).toBe(500);
    expect(bucket.take(499)).toBe(false);
    expect(bucket.take(500)).toBe(true);
    expect(bucket.take(60_000, 3)).toBe(true); // Never exceeds capacity.
    expect(bucket.take(60_000)).toBe(false);
  });

  it('keyed limiters expire idle keys and survive key flooding', () => {
    const limiter = new KeyedRateLimiter(2, 1, 1000, 100);
    expect(limiter.take('a', 0)).toBe(true);
    expect(limiter.take('a', 0)).toBe(true);
    expect(limiter.take('a', 0)).toBe(false);
    expect(limiter.take('b', 0)).toBe(true);
    expect(limiter.size).toBe(2);
    limiter.sweep(500);
    expect(limiter.size).toBe(2);
    limiter.sweep(1500);
    expect(limiter.size).toBe(0);
    for (let i = 0; i < 5000; i++) limiter.take(`k${i}`, 2000);
    expect(limiter.size).toBeLessThanOrEqual(100);
  });

  it('strike counters decay, so only sustained abuse trips them', () => {
    const strikes = new StrikeCounter(10, 1, 0);
    for (let i = 0; i < 10; i++) expect(strikes.add(0)).toBe(false);
    expect(strikes.add(0)).toBe(true);
    const slow = new StrikeCounter(10, 1, 0);
    for (let i = 0; i < 100; i++) expect(slow.add(i * 2000)).toBe(false);
  });
});

describe('origin checks', () => {
  const production = testConfig({ env: 'production', allowMissingOrigin: false, allowedOrigins: ['https://race.example.com'] });

  it('accepts configured and same-origin handshakes only', () => {
    expect(isOriginAllowed(production, { origin: 'https://race.example.com', host: 'internal:8080' })).toBe(true);
    expect(isOriginAllowed(production, { origin: 'HTTPS://RACE.EXAMPLE.COM', host: 'internal:8080' })).toBe(true);
    expect(isOriginAllowed(production, { origin: 'https://play.example.org', host: 'play.example.org' })).toBe(true);
    expect(isOriginAllowed(production, { origin: 'https://evil.example', host: 'race.example.com' })).toBe(false);
    expect(isOriginAllowed(production, { origin: 'https://race.example.com.evil.example', host: 'race.example.com' })).toBe(false);
    expect(isOriginAllowed(production, { origin: 'http://localhost:5173', host: 'race.example.com' })).toBe(false);
    expect(isOriginAllowed(production, { origin: 'null', host: 'race.example.com' })).toBe(false);
    expect(isOriginAllowed(production, { origin: 'file://', host: 'race.example.com' })).toBe(false);
    expect(isOriginAllowed(production, { origin: 'not a url', host: 'race.example.com' })).toBe(false);
  });

  it('rejects a missing Origin in production but allows it for local tools in development', () => {
    expect(isOriginAllowed(production, { origin: undefined, host: 'race.example.com' })).toBe(false);
    const dev = testConfig({ env: 'development', allowMissingOrigin: true });
    expect(isOriginAllowed(dev, { origin: undefined, host: 'localhost:8080' })).toBe(true);
    expect(isOriginAllowed(dev, { origin: 'http://localhost:5173', host: 'localhost:8080' })).toBe(true);
    expect(isOriginAllowed(dev, { origin: 'http://127.0.0.1:5173', host: 'localhost:8080' })).toBe(true);
    expect(isOriginAllowed(dev, { origin: 'https://evil.example', host: 'localhost:8080' })).toBe(false);
  });

  it('supports an explicit wildcard', () => {
    const open = testConfig({ env: 'production', allowedOrigins: ['*'], allowMissingOrigin: false });
    expect(isOriginAllowed(open, { origin: 'https://anything.example', host: 'x' })).toBe(true);
  });
});

describe('configuration', () => {
  it('has production-safe defaults', () => {
    const config = loadConfig({ NODE_ENV: 'production' });
    expect(config.host).toBe('0.0.0.0');
    expect(config.port).toBe(8080);
    expect(config.allowMissingOrigin).toBe(false);
    expect(config.allowedOrigins).toEqual([]);
    expect(config.trustProxy).toBe(false);
    expect(config.tickRate).toBe(60);
    const dev = loadConfig({});
    expect(dev.env).toBe('development');
    expect(dev.host).toBe('127.0.0.1');
    expect(dev.allowMissingOrigin).toBe(true);
  });

  it('reads deployment settings from the environment', () => {
    const config = loadConfig({
      NODE_ENV: 'production',
      HOST: '10.0.0.5',
      PORT: '9000',
      PUBLIC_URL: 'https://race.example.com/',
      WS_PUBLIC_URL: 'wss://ws.example.com/ws',
      ALLOWED_ORIGINS: 'https://race.example.com, https://www.example.com:8443',
      TRUST_PROXY: 'true',
      REGION: 'eu-west',
      RECONNECT_GRACE_S: '45',
      MAX_ROOMS: '12',
    });
    expect(config).toMatchObject({
      host: '10.0.0.5',
      port: 9000,
      publicUrl: 'https://race.example.com',
      wsPublicUrl: 'wss://ws.example.com/ws',
      trustProxy: true,
      region: 'eu-west',
      reconnectGraceMs: 45_000,
      maxRooms: 12,
    });
    expect(config.allowedOrigins).toEqual(['https://race.example.com', 'https://www.example.com:8443']);
  });

  it('adds the public URL to the allowed origins', () => {
    expect(loadConfig({ PUBLIC_URL: 'https://race.example.com/play' }).allowedOrigins).toEqual(['https://race.example.com']);
  });

  it('fails fast on invalid values', () => {
    const bad: Array<Record<string, string>> = [
      { PORT: 'eighty' },
      { PORT: '70000' },
      { NODE_ENV: 'staging' },
      { PUBLIC_URL: 'race.example.com' },
      { PUBLIC_URL: 'ftp://race.example.com' },
      { WS_PUBLIC_URL: 'https://race.example.com/ws' },
      { ALLOWED_ORIGINS: 'https://ok.example, nonsense' },
      { TRUST_PROXY: 'maybe' },
      { TICK_RATE: '0' },
      { LOG_LEVEL: 'chatty' },
      { MAX_ROOMS: '-1' },
    ];
    for (const env of bad) expect(() => loadConfig(env), JSON.stringify(env)).toThrow(ConfigError);
  });
});

describe('identifiers and credentials', () => {
  it('generates unpredictable reconnect tokens', () => {
    const tokens = new Set(Array.from({ length: 2000 }, () => newToken()));
    expect(tokens.size).toBe(2000);
    for (const token of tokens) expect(token).toMatch(/^[A-Za-z0-9_-]{32}$/);
  });

  it('generates room codes from the unambiguous alphabet', () => {
    const codes = new Set<string>();
    for (let i = 0; i < 500; i++) {
      const code = newRoomCode();
      expect(code).toHaveLength(ROOM_CODE_LENGTH);
      for (const ch of code) expect(ROOM_CODE_ALPHABET).toContain(ch);
      codes.add(code);
    }
    expect(codes.size).toBeGreaterThan(490);
  });

  it('compares secrets safely', () => {
    expect(safeEqual('abc', 'abc')).toBe(true);
    expect(safeEqual('abc', 'abd')).toBe(false);
    expect(safeEqual('abc', 'abcd')).toBe(false);
  });
});

describe('lap records store', () => {
  it('keeps only improvements and validates what it stores', () => {
    const store = new MemoryRecordsStore();
    expect(store.submit('harbor', 'Ada', 61_000)).toBe(true);
    expect(store.submit('harbor', 'Bob', 62_000)).toBe(false);
    expect(store.submit('harbor', 'Cy<b>', 60_500)).toBe(true);
    expect(store.submit('moon', 'Ada', 60_000)).toBe(false);
    expect(store.submit('harbor', 'Ada', 100)).toBe(false);
    expect(store.submit('harbor', 'Ada', 59_999.5)).toBe(false);
    expect(store.all()).toEqual([{ trackId: 'harbor', name: 'Cyb', ms: 60_500 }]);
  });

  it('persists to disk and reloads, ignoring corrupt data', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'apex-records-'));
    try {
      const file = join(dir, 'nested', 'records.json');
      const store = await FileRecordsStore.open(file, silentLogger);
      store.submit('harbor', 'Ada', 61_000);
      store.submit('glacier', 'Bob', 70_000);
      await store.close();
      expect(JSON.parse(await readFile(file, 'utf8'))).toHaveLength(2);

      const reloaded = await FileRecordsStore.open(file, silentLogger);
      expect(reloaded.all()).toEqual([
        { trackId: 'harbor', name: 'Ada', ms: 61_000 },
        { trackId: 'glacier', name: 'Bob', ms: 70_000 },
      ]);
      await reloaded.close();

      await writeFile(file, JSON.stringify([{ trackId: 'harbor', name: 'Hax', ms: -5 }, { trackId: 'nowhere', name: 'x', ms: 60_000 }, 'junk', { trackId: 'glacier', name: 'Ok', ms: 65_000 }]));
      const filtered = await FileRecordsStore.open(file, silentLogger);
      expect(filtered.all()).toEqual([{ trackId: 'glacier', name: 'Ok', ms: 65_000 }]);
      await filtered.close();

      await writeFile(file, '{not json');
      const empty = await FileRecordsStore.open(file, silentLogger);
      expect(empty.all()).toEqual([]);
      await empty.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
