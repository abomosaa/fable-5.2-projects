/**
 * End-to-end over real sockets: a real server on an ephemeral port and several
 * independent headless clients that create, discover, join, ready, start,
 * race, disconnect, reconnect and finish.
 */
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createGameServer, type GameServer } from '../../server/src/app';
import { testConfig, type ServerConfig } from '../../server/src/config';
import { MAX_CLIENT_MESSAGE_BYTES } from '../../shared/constants';
import { CLOSE, CarFlag, PROTOCOL_VERSION, RacePhaseCode, parseServerMessage, type RoomSettings } from '../../shared/protocol';
import { headlessClient, rawSocket, sleep, waitFor, type HeadlessClient } from '../helpers/realClient';

/** Simulated seconds per wall-clock second: the race runs 8x faster than real time. */
const TICK_RATE = 480;

let server: GameServer | null = null;
const clients: HeadlessClient[] = [];
const cleanups: Array<() => Promise<void>> = [];

async function start(overrides: Partial<ServerConfig> = {}): Promise<GameServer> {
  server = await createGameServer(
    testConfig({ tickRate: TICK_RATE, countdownTicks: 240, cooldownTicks: 60, host: '127.0.0.1', shutdownGraceMs: 50, ...overrides }),
  );
  return server;
}

function client(name: string, options: Parameters<typeof headlessClient>[2] = {}): HeadlessClient {
  const c = headlessClient(server!.port, name, options);
  clients.push(c);
  return c;
}

afterEach(async () => {
  for (const c of clients.splice(0)) c.stop();
  await server?.stop();
  server = null;
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

const settings: RoomSettings = { name: 'Integration GP', trackId: 'harbor', laps: 1, maxPlayers: 4, bots: 1, botSkill: 'easy', isPublic: true };

describe('multiplayer over real sockets', () => {
  it('runs a complete public race with independent clients, a disconnect and a reconnect', async () => {
    const srv = await start();
    const ada = client('Ada');
    const bob = client('Bob');
    const eve = client('Eve');
    await waitFor(() => [ada, bob, eve].every((c) => c.game.connection.isOpen), 5000, 'connections');
    expect(ada.game.connection.welcome).toMatchObject({ protocol: PROTOCOL_VERSION, tickRate: TICK_RATE });

    // --- Ada creates a public room.
    ada.game.createRoom('Ada', settings);
    await waitFor(() => ada.game.room !== null, 5000, 'room creation');
    const code = ada.game.room!.code;
    expect(ada.game.isHost).toBe(true);

    // --- Bob and Eve discover it on their own connections; it is also visible over HTTP.
    bob.game.listRooms(true);
    eve.game.listRooms(false);
    await waitFor(() => bob.game.directory.rooms.length === 1 && eve.game.directory.rooms.length === 1, 5000, 'discovery');
    expect(bob.game.directory.rooms[0]).toMatchObject({ code, name: 'Integration GP', hostName: 'Ada', trackId: 'harbor', laps: 1, players: 1, maxPlayers: 4, bots: 1, phase: 'lobby' });
    const status = (await (await fetch(`http://127.0.0.1:${srv.port}/api/status`)).json()) as Record<string, unknown>;
    expect(status).toMatchObject({ rooms: 1, publicRooms: 1, connections: 3, protocol: PROTOCOL_VERSION, ready: true });

    // --- They join: Bob drives, Eve watches.
    bob.game.joinRoom(code, 'Bob');
    eve.game.joinRoom(code, 'Eve', true);
    await waitFor(() => ada.game.room!.members.length === 3 && bob.game.room !== null && eve.game.room !== null, 5000, 'joins');
    const members = ada.game.room!.members;
    expect(members.map((m) => [m.name, m.role])).toEqual([
      ['Ada', 'racer'],
      ['Bob', 'racer'],
      ['Eve', 'spectator'],
    ]);
    expect(new Set([ada.game.youId, bob.game.youId, eve.game.youId]).size).toBe(3);
    expect(new Set(members.filter((m) => m.role === 'racer').map((m) => m.colour)).size).toBe(2);

    // --- Lobby: the host cannot start until Bob is ready.
    ada.game.startRace();
    await waitFor(() => ada.errors.some((e) => e.code === 'not_ready'), 5000, 'not ready error');
    expect(ada.game.room!.phase).toBe('lobby');
    bob.game.setReady(true);
    await waitFor(() => ada.game.room!.members[1]!.ready, 5000, 'ready state');
    bob.game.chat('good luck');
    ada.autopilot(0.8);
    bob.autopilot(0.6);
    ada.game.startRace();

    // --- Everyone enters the same race.
    await waitFor(() => [ada, bob, eve].every((c) => c.game.race !== null), 5000, 'race start');
    const info = ada.game.room!.race!;
    expect(info.cars).toHaveLength(3);
    expect(info.cars.filter((c) => c.isBot)).toHaveLength(1);
    for (const c of [bob, eve]) expect(c.game.room!.race).toEqual(info);
    expect(ada.game.raceSlot).toBeGreaterThanOrEqual(0);
    expect(bob.game.raceSlot).toBeGreaterThanOrEqual(0);
    expect(ada.game.raceSlot).not.toBe(bob.game.raceSlot);
    expect(eve.game.raceSlot).toBe(-1);

    // --- Synchronised start: all see the same green-light tick, and cars only move after it.
    await waitFor(() => [ada, bob, eve].every((c) => c.game.race!.latest !== null), 5000, 'first snapshots');
    expect(new Set([ada, bob, eve].map((c) => c.game.race!.latest!.goTick))).toEqual(new Set([info.goTick]));
    const grid = ada.game.race!.latest!.cars.map((c) => [c.slot, c.x, c.z]);
    await waitFor(() => ada.game.race!.latest!.tick > info.goTick - 60, 5000, 'late countdown');
    expect(ada.game.race!.latest!.phase).toBe(RacePhaseCode.countdown);
    expect(ada.game.race!.latest!.cars.map((c) => [c.slot, c.x, c.z])).toEqual(grid);
    await waitFor(() => [ada, bob, eve].every((c) => c.game.race!.latest!.phase === RacePhaseCode.racing), 5000, 'green light');

    // --- Racing: both drivers predict locally, the spectator sees everyone move.
    await waitFor(() => eve.game.race!.latest!.cars.every((c) => Math.hypot(c.vx, c.vz) > 500), 20_000, 'all cars moving');
    expect(ada.game.race!.predicting).toBe(true);
    expect(bob.game.race!.predicting).toBe(true);
    expect(eve.game.race!.predicting).toBe(false);
    const seenByEve = eve.game.race!.view(performance.now());
    expect(seenByEve.cars.filter((c) => c.present)).toHaveLength(3);

    // --- Bob's connection drops mid-race.
    const bobSlot = bob.game.raceSlot;
    const bobToken = bob.store.load()!.token;
    const bobRace = bob.game.race!;
    await sleep(300);
    bob.game.connection.simulateDrop();
    await waitFor(() => ada.game.room!.members.find((m) => m.name === 'Bob')?.connected === false, 5000, 'disconnect noticed');
    await waitFor(() => (ada.game.race!.latest!.cars.find((c) => c.slot === bobSlot)!.flags & CarFlag.DISCONNECTED) !== 0, 5000, 'car flagged');
    expect(ada.notices.some((n) => n.code === 'player_disconnected')).toBe(true);

    // --- ...and comes back by itself, into the same seat and car.
    await waitFor(() => bob.game.connection.isOpen && bob.game.race !== null && bob.game.race !== bobRace, 10_000, 'automatic resume');
    expect(bob.game.raceSlot).toBe(bobSlot);
    expect(bob.game.race!.race.raceId).toBe(info.raceId);
    expect(bob.store.load()!.token).not.toBe(bobToken);
    await waitFor(() => ada.game.room!.members.find((m) => m.name === 'Bob')?.connected === true, 5000, 'reconnect noticed');
    await waitFor(() => bob.game.race!.predicting, 5000, 'prediction resumed');
    expect(bob.game.connection.counters.reconnects).toBe(1);

    // --- Finish.
    await waitFor(() => [ada, bob, eve].every((c) => c.game.room?.phase === 'results'), 60_000, 'results');
    const results = ada.game.room!.results!;
    expect(bob.game.room!.results).toEqual(results);
    expect(eve.game.room!.results).toEqual(results);
    expect(results).toHaveLength(3);
    expect(results.map((r) => r.place)).toEqual([1, 2, 3]);
    const human = (name: string) => results.find((r) => r.name === name)!;
    expect(human('Ada')).toMatchObject({ finished: true, isBot: false, memberId: ada.game.youId, lapsCompleted: 1 });
    expect(human('Bob')).toMatchObject({ finished: true, isBot: false, memberId: bob.game.youId, lapsCompleted: 1 });
    expect(human('Ada').totalMs).toBeGreaterThan(50_000);
    expect(human('Ada').totalMs).toBeLessThan(110_000);
    const finishers = results.filter((r) => r.finished);
    for (let i = 1; i < finishers.length; i++) expect(finishers[i]!.totalMs).toBeGreaterThanOrEqual(finishers[i - 1]!.totalMs);
    // The lap record comes from the server's own timing.
    await waitFor(() => eve.game.records.length === 1, 5000, 'record broadcast');
    expect(eve.game.records[0]!.ms).toBe(Math.min(human('Ada').bestLapMs, human('Bob').bestLapMs));

    // --- Back to the lobby for the next race.
    ada.game.returnToLobby();
    await waitFor(() => [ada, bob, eve].every((c) => c.game.room?.phase === 'lobby'), 5000, 'lobby');
    expect(ada.game.race).toBeNull();

    // --- Nothing malformed crossed the wire in either direction.
    for (const c of [ada, bob, eve]) expect(c.game.connection.counters.invalidMessages).toBe(0);
    expect(ada.errors.map((e) => e.code)).toEqual(['not_ready']);
    expect(bob.errors).toEqual([]);
    expect(srv.loopStats.ticks).toBeGreaterThan(3000);
  }, 120_000);

  it('expires a seat when the player stays away past the grace period', async () => {
    await start({ reconnectGraceMs: 600 });
    const ada = client('Ada');
    const bob = client('Bob');
    await waitFor(() => ada.game.connection.isOpen && bob.game.connection.isOpen, 5000, 'connections');
    ada.game.createRoom('Ada', { ...settings, bots: 0 });
    await waitFor(() => ada.game.room !== null, 5000, 'room');
    bob.game.joinRoom(ada.game.room!.code, 'Bob');
    await waitFor(() => ada.game.room!.members.length === 2, 5000, 'join');
    const stale = bob.store.load()!;
    // Bob vanishes for good (no automatic reconnect).
    bob.stop();
    await waitFor(() => ada.game.room!.members.length === 1, 5000, 'seat expiry');
    // A later attempt with the old credential is refused cleanly.
    const late = client('Bob again', { store: { load: () => stale, save: () => undefined, clear: () => undefined } });
    await waitFor(() => late.errors.length > 0, 5000, 'resume refusal');
    expect(late.errors[0]!.code).toBe('resume_failed');
    expect(late.game.room).toBeNull();
    expect(late.lefts[0]?.reason).toBe('expired');
    expect(late.game.connection.isOpen).toBe(true);
  }, 30_000);

  it('tells clients about a shutdown and closes cleanly', async () => {
    const srv = await start();
    const ada = client('Ada');
    await waitFor(() => ada.game.connection.isOpen, 5000, 'connection');
    ada.game.createRoom('Ada', settings);
    await waitFor(() => ada.game.room !== null, 5000, 'room');
    const ready = await fetch(`http://127.0.0.1:${srv.port}/readyz`);
    expect(ready.status).toBe(200);
    const stopping = srv.stop('Restarting for maintenance.');
    await waitFor(() => ada.shutdowns.length === 1, 5000, 'shutdown notice');
    expect(ada.shutdowns[0]).toBe('Restarting for maintenance.');
    await stopping;
    await waitFor(() => ada.game.connection.status === 'reconnecting', 5000, 'client notices the close');
    // The port is really closed.
    await expect(fetch(`http://127.0.0.1:${srv.port}/healthz`)).rejects.toThrow();
    server = null;
  }, 30_000);

  it('refuses clients built for another protocol version', async () => {
    await start();
    const old = client('Old', { protocolVersion: PROTOCOL_VERSION + 1 });
    await waitFor(() => old.game.connection.status === 'failed', 5000, 'version rejection');
    expect(old.game.connection.failure).toMatchObject({ kind: 'version_mismatch' });
    expect(old.game.connection.failure!.message).toMatch(/reload/i);
    // It does not hammer the server with retries.
    await sleep(600);
    expect(old.game.connection.status).toBe('failed');
  }, 30_000);
});

describe('transport security over real sockets', () => {
  it('checks the Origin header during the WebSocket handshake', async () => {
    const srv = await start({ env: 'production', allowMissingOrigin: false, allowedOrigins: ['https://race.example.com'] });
    const url = `ws://127.0.0.1:${srv.port}/ws`;
    const evil = await rawSocket(url, { origin: 'https://evil.example' });
    expect(evil).toMatchObject({ opened: false, status: 403 });
    const missing = await rawSocket(url);
    expect(missing).toMatchObject({ opened: false, status: 403 });
    const allowed = await rawSocket(url, { origin: 'https://race.example.com' });
    expect(allowed.opened).toBe(true);
    allowed.socket.close();
    // Same-origin (Origin host equals the Host header) is the default-safe case.
    const same = await rawSocket(url, { origin: `http://127.0.0.1:${srv.port}` });
    expect(same.opened).toBe(true);
    same.socket.close();
    const wrongPath = await rawSocket(`ws://127.0.0.1:${srv.port}/admin`, { origin: 'https://race.example.com' });
    expect(wrongPath).toMatchObject({ opened: false, status: 404 });
  }, 30_000);

  it('closes sockets that send oversized frames or garbage', async () => {
    const srv = await start();
    const url = `ws://127.0.0.1:${srv.port}/ws`;
    const big = await rawSocket(url);
    expect(big.opened).toBe(true);
    big.socket.send(JSON.stringify({ t: 'hello', protocol: PROTOCOL_VERSION }));
    big.socket.send('x'.repeat(MAX_CLIENT_MESSAGE_BYTES + 1));
    await waitFor(() => big.closeCode !== null, 5000, 'oversize close');
    expect(big.closeCode).toBe(CLOSE.TOO_BIG);

    const binary = await rawSocket(url);
    binary.socket.send(JSON.stringify({ t: 'hello', protocol: PROTOCOL_VERSION }));
    binary.socket.send(new Uint8Array(MAX_CLIENT_MESSAGE_BYTES + 1));
    await waitFor(() => binary.closeCode !== null, 5000, 'oversize binary close');
    expect(binary.closeCode).toBe(CLOSE.TOO_BIG);

    const junk = await rawSocket(url);
    junk.socket.send('definitely not a hello');
    await waitFor(() => junk.closeCode !== null, 5000, 'garbage close');
    expect(junk.closeCode).toBe(CLOSE.BAD_MESSAGE);
    const error = parseServerMessage(junk.messages[junk.messages.length - 1]!);
    expect(error.ok && error.value).toMatchObject({ t: 'error', code: 'bad_message', fatal: true });

    const old = await rawSocket(url);
    old.socket.send(JSON.stringify({ t: 'hello', protocol: 1 }));
    await waitFor(() => old.closeCode !== null, 5000, 'version close');
    expect(old.closeCode).toBe(CLOSE.VERSION_MISMATCH);
    await waitFor(() => srv.manager.connections.size === 0, 5000, 'cleanup');
  }, 30_000);

  it('limits connections per address and terminates silent sockets', async () => {
    const srv = await start({ maxConnectionsPerIp: 3, helloTimeoutMs: 300, heartbeatIntervalMs: 100, connectionTimeoutMs: 100_000 });
    const url = `ws://127.0.0.1:${srv.port}/ws`;
    const open = await Promise.all([rawSocket(url), rawSocket(url), rawSocket(url)]);
    expect(open.every((s) => s.opened)).toBe(true);
    const extra = await rawSocket(url);
    expect(extra).toMatchObject({ opened: false, status: 429 });
    // None of them says hello: the server hangs up on all three.
    await waitFor(() => open.every((s) => s.closeCode !== null), 5000, 'hello timeout');
    expect(open.map((s) => s.closeCode)).toEqual([CLOSE.IDLE, CLOSE.IDLE, CLOSE.IDLE]);
    await waitFor(() => srv.manager.connections.size === 0, 5000, 'cleanup');
    const again = await rawSocket(url);
    expect(again.opened).toBe(true);
    again.socket.close();
  }, 30_000);
});

describe('http endpoints', () => {
  it('serves health, readiness, status and runtime configuration', async () => {
    const srv = await start({ region: 'test-region', wsPublicUrl: 'wss://ws.example.com/ws', publicUrl: 'https://race.example.com' });
    const base = `http://127.0.0.1:${srv.port}`;
    const health = await fetch(`${base}/healthz`);
    expect(health.status).toBe(200);
    expect(await health.json()).toEqual({ status: 'ok' });
    expect(health.headers.get('cache-control')).toBe('no-store');
    expect((await fetch(`${base}/readyz`)).status).toBe(200);
    expect(await (await fetch(`${base}/config.json`)).json()).toEqual({
      wsUrl: 'wss://ws.example.com/ws',
      publicUrl: 'https://race.example.com',
      region: 'test-region',
      protocol: PROTOCOL_VERSION,
      version: '1.0.0',
    });
    const head = await fetch(`${base}/healthz`, { method: 'HEAD' });
    expect(head.status).toBe(200);
    expect(await head.text()).toBe('');
    const post = await fetch(`${base}/api/status`, { method: 'POST', body: '{}' });
    expect(post.status).toBe(405);
    expect(post.headers.get('allow')).toBe('GET, HEAD');
    // Security headers on every response.
    expect(health.headers.get('x-content-type-options')).toBe('nosniff');
    expect(health.headers.get('x-frame-options')).toBe('DENY');
    const csp = health.headers.get('content-security-policy') ?? '';
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain('wss://ws.example.com');
    // Without a client build there is a helpful message rather than a blank 404.
    const root = await fetch(`${base}/`);
    expect(root.status).toBe(404);
    expect(await root.text()).toContain('npm run');
    expect((await fetch(`${base}/ws`)).status).toBe(426);
  }, 30_000);

  it('serves the built client safely: fallback for app routes, no path traversal', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'apex-static-'));
    cleanups.push(() => rm(dir, { recursive: true, force: true }));
    await mkdir(join(dir, 'public', 'assets'), { recursive: true });
    await writeFile(join(dir, 'public', 'index.html'), '<!doctype html><title>app shell</title>');
    await writeFile(join(dir, 'public', 'assets', 'app-abc123.js'), `console.log("${'x'.repeat(4000)}")`);
    await writeFile(join(dir, 'secret.txt'), 'top secret');
    const srv = await start({ staticDir: join(dir, 'public') });
    const base = `http://127.0.0.1:${srv.port}`;

    const index = await fetch(`${base}/`);
    expect(index.status).toBe(200);
    expect(index.headers.get('content-type')).toContain('text/html');
    expect(index.headers.get('cache-control')).toBe('no-cache');
    expect(await index.text()).toContain('app shell');

    const asset = await fetch(`${base}/assets/app-abc123.js`);
    expect(asset.status).toBe(200);
    expect(asset.headers.get('content-type')).toContain('javascript');
    expect(asset.headers.get('cache-control')).toContain('immutable');
    expect(asset.headers.get('content-encoding')).toBe('gzip');
    expect((await asset.text()).length).toBeGreaterThan(4000);

    // Invite links such as /?room=ABCDE and unknown app routes get the shell.
    expect(await (await fetch(`${base}/?room=ABCDE`)).text()).toContain('app shell');
    expect(await (await fetch(`${base}/some/route`)).text()).toContain('app shell');
    expect((await fetch(`${base}/assets/missing.js`)).status).toBe(404);

    // Traversal attempts never escape the static root.
    for (const path of ['/../secret.txt', '/%2e%2e/secret.txt', '/..%2fsecret.txt', '/assets/../../secret.txt', '/%2e%2e%5csecret.txt']) {
      const response = await fetch(`${base}${path}`);
      const body = await response.text();
      expect(body, path).not.toContain('top secret');
      expect([200, 400, 403, 404], path).toContain(response.status);
    }
    const raw = await new Promise<string>((resolve, reject) => {
      // fetch normalises "..", so send the raw request line by hand.
      void import('node:net').then(({ connect }) => {
        const socket = connect(srv.port, '127.0.0.1', () => socket.write('GET /../secret.txt HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n'));
        let data = '';
        socket.on('data', (chunk) => (data += chunk.toString()));
        socket.on('end', () => resolve(data));
        socket.on('error', reject);
      });
    });
    expect(raw).not.toContain('top secret');
  }, 30_000);
});
