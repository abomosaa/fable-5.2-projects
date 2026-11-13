import { describe, expect, it } from 'vitest';
import { MAX_SPECTATORS, SIM_HZ } from '../../shared/constants';
import { CLOSE, PROTOCOL_VERSION, encodeInput } from '../../shared/protocol';
import { getTrack } from '../../shared/sim/tracks';
import { TestServer, hostRoom, joinRoom, roomSettings, type FakeClient } from '../helpers/fakes';

/** Behaves like live clients for `ms`: drivers send an input every tick, viewers acknowledge snapshots. */
function driveFor(server: TestServer, clients: FakeClient[], ms: number, throttle = 255): void {
  const tickMs = 1000 / server.config.tickRate;
  for (let t = 0; t < ms; t += tickMs) {
    for (const client of clients) {
      if (!client.room?.race) continue;
      if (client.mySlot >= 0) client.drive({ throttle });
      else client.ack();
    }
    server.advance(tickMs);
  }
}

describe('handshake', () => {
  it('welcomes a client that speaks the same protocol version', () => {
    const server = new TestServer();
    const client = server.client();
    const welcome = client.last('welcome');
    expect(welcome).toMatchObject({ protocol: PROTOCOL_VERSION, tickRate: server.config.tickRate, snapshotEvery: server.config.snapshotEvery });
    expect(client.last('records')).toEqual({ t: 'records', records: [] });
    expect(client.closed).toBeNull();
  });

  it('refuses a different protocol version with a clear, fatal error', () => {
    const server = new TestServer();
    const client = server.socket().hello(PROTOCOL_VERSION + 1);
    expect(client.last('error')).toMatchObject({ code: 'version_mismatch', fatal: true });
    expect(client.closed?.code).toBe(CLOSE.VERSION_MISMATCH);
    expect(client.all('welcome')).toHaveLength(0);
    expect(server.manager.connections.size).toBe(0);
  });

  it('drops a client that talks before saying hello', () => {
    const server = new TestServer();
    const text = server.socket().send({ t: 'list', subscribe: true });
    expect(text.closed?.code).toBe(CLOSE.BAD_MESSAGE);
    const binary = server.socket().sendBinary(encodeInput({ raceId: 0, ackSnapTick: 0, clientTime: 0, firstSeq: 0, inputs: [] }));
    expect(binary.closed?.code).toBe(CLOSE.BAD_MESSAGE);
  });

  it('times out sockets that never say hello or go silent', () => {
    const server = new TestServer({ helloTimeoutMs: 5000, connectionTimeoutMs: 20_000 });
    const mute = server.socket();
    const quiet = server.client();
    server.now += 6000;
    quiet.send({ t: 'ping', id: 1, clientTime: 0 });
    expect(server.manager.reapConnections()).toEqual([mute.conn]);
    expect(mute.closed?.code).toBe(CLOSE.IDLE);
    server.now += 21_000;
    expect(server.manager.reapConnections()).toEqual([quiet.conn]);
    expect(quiet.closed?.code).toBe(CLOSE.IDLE);
  });

  it('answers pings with the echoed client time and the server time', () => {
    const server = new TestServer();
    const client = server.client().send({ t: 'ping', id: 42, clientTime: 123.5 });
    expect(client.last('pong')).toEqual({ t: 'pong', id: 42, clientTime: 123.5, serverTime: server.now });
  });
});

describe('public room directory', () => {
  it('shows a public room to every other connected client', () => {
    const server = new TestServer({ region: 'eu-west' });
    const host = hostRoom(server, { name: 'Friday night', trackId: 'glacier', laps: 5, bots: 2 });
    const other = server.client('203.0.113.9').send({ t: 'list', subscribe: false });
    const rooms = other.last('rooms');
    expect(rooms?.rooms).toEqual([
      {
        code: host.room!.code,
        name: 'Friday night',
        hostName: 'Ada',
        trackId: 'glacier',
        laps: 5,
        players: 1,
        maxPlayers: 8,
        bots: 2,
        spectators: 0,
        phase: 'lobby',
        region: 'eu-west',
      },
    ]);
    expect(rooms?.total).toBe(1);
    expect(rooms?.online).toBe(2);
  });

  it('keeps private rooms out of the directory but joinable by code', () => {
    const server = new TestServer();
    const host = hostRoom(server, { isPublic: false });
    const other = server.client().send({ t: 'list', subscribe: false });
    expect(other.last('rooms')?.rooms).toEqual([]);
    expect(other.last('rooms')?.total).toBe(1);
    other.send({ t: 'join', code: host.room!.code, name: 'Bob', spectate: false });
    expect(other.room?.code).toBe(host.room!.code);
  });

  it('pushes live updates to subscribers and stops when they unsubscribe', () => {
    const server = new TestServer();
    const watcher = server.client().send({ t: 'list', subscribe: true });
    expect(watcher.last('rooms')?.rooms).toHaveLength(0);
    watcher.clear();
    const host = hostRoom(server);
    server.advance(500);
    expect(watcher.last('rooms')?.rooms.map((r) => r.code)).toEqual([host.room!.code]);
    watcher.clear();
    joinRoom(server, host.room!.code, 'Bob');
    server.advance(500);
    expect(watcher.last('rooms')?.rooms[0]?.players).toBe(2);
    // Race state is reflected too.
    watcher.clear();
    host.send({ t: 'settings', patch: { isPublic: false } });
    server.advance(500);
    expect(watcher.last('rooms')?.rooms).toEqual([]);
    watcher.send({ t: 'list', subscribe: false }).clear();
    host.send({ t: 'settings', patch: { isPublic: true } });
    server.advance(500);
    expect(watcher.all('rooms')).toHaveLength(0);
  });

  it('quick join puts players into the fullest open public lobby', () => {
    const server = new TestServer();
    const a = hostRoom(server, {}, 'Ada');
    const b = hostRoom(server, {}, 'Bea');
    joinRoom(server, b.room!.code, 'Cy');
    const quick = server.client().send({ t: 'quick', name: 'Dee' });
    expect(quick.room?.code).toBe(b.room!.code);
    expect(a.room?.members).toHaveLength(1);
  });

  it('quick join opens a public room with bots when there is nothing to join', () => {
    const server = new TestServer();
    const hidden = hostRoom(server, { isPublic: false });
    const quick = server.client().send({ t: 'quick', name: 'Dee' });
    expect(quick.room).not.toBeNull();
    expect(quick.room!.code).not.toBe(hidden.room!.code);
    expect(quick.room!.settings.isPublic).toBe(true);
    expect(quick.room!.settings.bots).toBeGreaterThan(0);
    expect(quick.room!.hostId).toBe(quick.youId);
    // Somebody else's quick join now finds that room.
    const second = server.client().send({ t: 'quick', name: 'Eve' });
    expect(second.room?.code).toBe(quick.room!.code);
  });
});

describe('joining', () => {
  it('reports rooms that do not exist', () => {
    const server = new TestServer();
    const client = joinRoom(server, 'ZZZZZ', 'Bob');
    expect(client.errors()).toEqual(['room_not_found']);
    expect(client.room).toBeNull();
  });

  it('gives every member a distinct identity, name and colour', () => {
    const server = new TestServer();
    const host = hostRoom(server, {}, 'Racer');
    const b = joinRoom(server, host.room!.code, 'Racer');
    const c = joinRoom(server, host.room!.code, 'racer');
    const members = c.room!.members;
    expect(new Set(members.map((m) => m.id)).size).toBe(3);
    expect(members.map((m) => m.name)).toEqual(['Racer', 'Racer 2', 'racer 3']);
    expect(new Set(members.map((m) => m.colour)).size).toBe(3);
    expect(new Set([host.token, b.token, c.token]).size).toBe(3);
    // Nobody else's secret token is ever broadcast.
    expect(JSON.stringify(host.messages)).not.toContain(b.token);
    expect(JSON.stringify(c.messages)).not.toContain(host.token);
  });

  it('refuses a second join from a connection that is already seated', () => {
    const server = new TestServer();
    const host = hostRoom(server);
    const other = hostRoom(server);
    host.clear().send({ t: 'join', code: other.room!.code, name: 'Ada', spectate: false });
    host.send({ t: 'create', name: 'Ada', settings: roomSettings() });
    host.send({ t: 'quick', name: 'Ada' });
    expect(host.errors()).toEqual(['already_in_room', 'already_in_room', 'already_in_room']);
    expect(server.room(other.room!.code).members.size).toBe(1);
    expect(server.manager.rooms.size).toBe(2);
  });

  it('enforces the driver seat limit and offers spectating instead', () => {
    const server = new TestServer();
    const host = hostRoom(server, { maxPlayers: 2 });
    joinRoom(server, host.room!.code, 'Bob');
    const late = joinRoom(server, host.room!.code, 'Cy');
    expect(late.errors()).toEqual(['room_full']);
    expect(late.room).toBeNull();
    late.send({ t: 'join', code: host.room!.code, name: 'Cy', spectate: true });
    expect(late.me?.role).toBe('spectator');
    expect(host.room!.members.map((m) => m.role)).toEqual(['racer', 'racer', 'spectator']);
  });

  it('caps the number of spectators', () => {
    const server = new TestServer({ joinBurst: 100 });
    const host = hostRoom(server);
    for (let i = 0; i < MAX_SPECTATORS; i++) expect(joinRoom(server, host.room!.code, `S${i}`, true).room).not.toBeNull();
    expect(joinRoom(server, host.room!.code, 'Late', true).errors()).toEqual(['room_full']);
  });

  it('requires being in a room for room actions', () => {
    const server = new TestServer();
    const client = server.client();
    for (const message of [{ t: 'ready', ready: true }, { t: 'start' }, { t: 'chat', text: 'hi' }, { t: 'kick', id: 'abcd1234' }, { t: 'leave' }]) client.send(message);
    expect(client.errors()).toEqual(['not_in_room', 'not_in_room', 'not_in_room', 'not_in_room', 'not_in_room']);
  });
});

describe('lobby', () => {
  it('tracks ready state and only lets the host start once everyone is ready', () => {
    const server = new TestServer();
    const host = hostRoom(server);
    const bob = joinRoom(server, host.room!.code, 'Bob');
    const cy = joinRoom(server, host.room!.code, 'Cy');

    bob.send({ t: 'start' });
    expect(bob.errors()).toEqual(['not_host']);

    host.send({ t: 'start' });
    expect(host.last('error')).toMatchObject({ code: 'not_ready' });
    expect(host.last('error')?.message).toContain('Bob');
    expect(host.room!.phase).toBe('lobby');

    bob.send({ t: 'ready', ready: true });
    expect(host.room!.members.find((m) => m.name === 'Bob')?.ready).toBe(true);
    host.clear().send({ t: 'start' });
    expect(host.errors()).toEqual(['not_ready']);

    cy.send({ t: 'ready', ready: true });
    cy.send({ t: 'ready', ready: false });
    host.clear().send({ t: 'start' });
    expect(host.errors()).toEqual(['not_ready']);

    cy.send({ t: 'ready', ready: true });
    host.clear().send({ t: 'start' });
    expect(host.errors()).toEqual([]);
    expect(host.room!.phase).toBe('racing');
    for (const client of [host, bob, cy]) {
      expect(client.room!.race?.cars).toHaveLength(3);
      expect(client.mySlot).toBeGreaterThanOrEqual(0);
    }
    expect(new Set([host.mySlot, bob.mySlot, cy.mySlot]).size).toBe(3);
  });

  it('lets only the host change settings, and re-confirms readiness when the race changes', () => {
    const server = new TestServer();
    const host = hostRoom(server);
    const bob = joinRoom(server, host.room!.code, 'Bob');
    bob.send({ t: 'ready', ready: true });
    bob.send({ t: 'settings', patch: { laps: 9 } });
    expect(bob.errors()).toEqual(['not_host']);
    expect(host.room!.settings.laps).toBe(3);

    host.send({ t: 'settings', patch: { bots: 4, botSkill: 'hard', name: 'Renamed' } });
    expect(bob.room!.settings).toMatchObject({ bots: 4, botSkill: 'hard', name: 'Renamed' });
    expect(bob.me?.ready).toBe(true);

    host.send({ t: 'settings', patch: { trackId: 'glacier', laps: 2 } });
    expect(bob.room!.settings).toMatchObject({ trackId: 'glacier', laps: 2 });
    expect(bob.me?.ready).toBe(false);

    // The room can never shrink below the drivers already seated.
    host.send({ t: 'settings', patch: { maxPlayers: 1 } });
    expect(host.room!.settings.maxPlayers).toBe(2);
  });

  it('fills the grid with bots without exceeding its size', () => {
    const server = new TestServer();
    const host = hostRoom(server, { bots: 7 });
    joinRoom(server, host.room!.code, 'Bob').send({ t: 'ready', ready: true });
    host.send({ t: 'start' });
    const cars = host.room!.race!.cars;
    expect(cars).toHaveLength(8);
    expect(cars.filter((c) => c.isBot)).toHaveLength(6);
    expect(new Set(cars.map((c) => c.name)).size).toBe(8);
    expect(new Set(cars.map((c) => c.colour)).size).toBe(8);
    expect(new Set(cars.map((c) => c.slot)).size).toBe(8);
  });

  it('supports switching between driving and spectating', () => {
    const server = new TestServer();
    const host = hostRoom(server, { maxPlayers: 2 });
    const bob = joinRoom(server, host.room!.code, 'Bob');
    const cy = joinRoom(server, host.room!.code, 'Cy', true);
    cy.send({ t: 'role', role: 'racer' });
    expect(cy.errors()).toEqual(['room_full']);
    cy.clear().send({ t: 'ready', ready: true });
    expect(cy.errors()).toEqual(['invalid_state']);
    bob.send({ t: 'role', role: 'spectator' });
    cy.clear().send({ t: 'role', role: 'racer' });
    expect(cy.me?.role).toBe('racer');
    expect(bob.me?.role).toBe('spectator');
    // Spectators do not hold up the start and do not get a car.
    cy.send({ t: 'ready', ready: true });
    host.send({ t: 'start' });
    expect(host.room!.phase).toBe('racing');
    expect(host.room!.race!.cars.map((c) => c.memberId).sort()).toEqual([host.youId, cy.youId].sort());
    expect(bob.mySlot).toBe(-1);
    expect(bob.me?.slot).toBe(-1);
  });

  it('relays sanitised chat to the room and renames players', () => {
    const server = new TestServer();
    const host = hostRoom(server);
    const bob = joinRoom(server, host.room!.code, 'Bob');
    bob.send({ t: 'chat', text: '  hello <b>there</b>\u0007 ' });
    expect(host.last('chat')).toEqual({ t: 'chat', fromId: bob.youId, name: 'Bob', text: 'hello bthere/b' });
    bob.send({ t: 'rename', name: 'Ada' });
    expect(host.room!.members.map((m) => m.name)).toEqual(['Ada', 'Ada 2']);
  });

  it('lets the host kick, bans the kicked address for a while and tells them why', () => {
    const server = new TestServer({ kickBanMs: 60_000 });
    const host = hostRoom(server);
    const bob = joinRoom(server, host.room!.code, 'Bob');
    const code = host.room!.code;
    bob.send({ t: 'kick', id: host.youId });
    expect(bob.errors()).toEqual(['not_host']);
    host.send({ t: 'kick', id: host.youId });
    expect(host.errors()).toEqual(['invalid_state']);

    host.send({ t: 'kick', id: bob.youId });
    expect(bob.last('left')).toMatchObject({ reason: 'kicked' });
    expect(bob.room).toBeNull();
    expect(host.room!.members).toHaveLength(1);
    expect(bob.closed).toBeNull();

    bob.clear().send({ t: 'join', code, name: 'Bob', spectate: false });
    expect(bob.errors()).toEqual(['banned']);
    // The old credential is useless as well.
    bob.clear().send({ t: 'resume', code, token: bob.token });
    expect(bob.errors()).toEqual(['resume_failed']);
    server.advance(61_000);
    bob.clear().send({ t: 'join', code, name: 'Bob', spectate: false });
    expect(bob.room?.code).toBe(code);
  });
});

describe('host departure', () => {
  it('hands the room to the longest-standing member when the host leaves', () => {
    const server = new TestServer();
    const host = hostRoom(server);
    const bob = joinRoom(server, host.room!.code, 'Bob');
    const cy = joinRoom(server, host.room!.code, 'Cy');
    host.send({ t: 'leave' });
    expect(host.last('left')).toMatchObject({ reason: 'left' });
    expect(bob.room!.hostId).toBe(bob.youId);
    expect(cy.room!.hostId).toBe(bob.youId);
    expect(cy.all('notice').some((n) => n.code === 'host_changed')).toBe(true);
    // The new host really has host powers.
    cy.send({ t: 'ready', ready: true });
    bob.send({ t: 'start' });
    expect(bob.room!.phase).toBe('racing');
  });

  it('migrates the host immediately when the host disconnects, and does not give it back', () => {
    const server = new TestServer();
    const host = hostRoom(server);
    const bob = joinRoom(server, host.room!.code, 'Bob');
    const code = host.room!.code;
    host.drop();
    expect(bob.room!.hostId).toBe(bob.youId);
    expect(bob.room!.members.find((m) => m.id === host.youId)?.connected).toBe(false);
    const back = server.client(host.ip).send({ t: 'resume', code, token: host.token });
    expect(back.room!.hostId).toBe(bob.youId);
    expect(back.youId).toBe(host.youId);
  });

  it('removes the room when the last member leaves', () => {
    const server = new TestServer();
    const host = hostRoom(server);
    const bob = joinRoom(server, host.room!.code, 'Bob');
    host.send({ t: 'leave' });
    expect(server.manager.rooms.size).toBe(1);
    bob.send({ t: 'leave' });
    expect(server.manager.rooms.size).toBe(0);
    expect(server.client().send({ t: 'list', subscribe: false }).last('rooms')?.rooms).toEqual([]);
  });
});

describe('reconnecting', () => {
  it('holds a disconnected player seat for the grace period and restores it', () => {
    const server = new TestServer({ reconnectGraceMs: 20_000 });
    const host = hostRoom(server);
    const bob = joinRoom(server, host.room!.code, 'Bob');
    const code = host.room!.code;
    const oldToken = bob.token;
    bob.drop();
    expect(host.room!.members.find((m) => m.id === bob.youId)).toMatchObject({ connected: false, ready: false });
    expect(host.all('notice').some((n) => n.code === 'player_disconnected')).toBe(true);

    server.advance(15_000);
    const back = server.client(bob.ip).send({ t: 'resume', code, token: oldToken });
    expect(back.last('joined')).toMatchObject({ resumed: true, youId: bob.youId });
    expect(back.room!.members.find((m) => m.id === bob.youId)?.connected).toBe(true);
    expect(host.all('notice').some((n) => n.code === 'player_reconnected')).toBe(true);
    // The credential rotates: the old one is now worthless.
    expect(back.token).not.toBe(oldToken);
    expect(back.token.length).toBeGreaterThanOrEqual(32);
    const thief = server.client().send({ t: 'resume', code, token: oldToken });
    expect(thief.errors()).toEqual(['resume_failed']);
  });

  it('expires the seat after the grace period', () => {
    const server = new TestServer({ reconnectGraceMs: 10_000 });
    const host = hostRoom(server);
    const bob = joinRoom(server, host.room!.code, 'Bob');
    const code = host.room!.code;
    bob.drop();
    server.advance(9_000);
    expect(host.room!.members).toHaveLength(2);
    server.advance(1_500);
    expect(host.room!.members).toHaveLength(1);
    const late = server.client(bob.ip).send({ t: 'resume', code, token: bob.token });
    expect(late.errors()).toEqual(['resume_failed']);
    expect(late.room).toBeNull();
  });

  it('rejects guessed credentials and unknown rooms', () => {
    const server = new TestServer();
    const host = hostRoom(server);
    const stranger = server.client();
    stranger.send({ t: 'resume', code: host.room!.code, token: 'A'.repeat(32) });
    stranger.send({ t: 'resume', code: 'QQQQQ', token: host.token });
    expect(stranger.errors()).toEqual(['resume_failed', 'resume_failed']);
    expect(host.room!.members).toHaveLength(1);
  });

  it('lets a newer connection take over a seat and closes the old one', () => {
    const server = new TestServer();
    const host = hostRoom(server);
    const code = host.room!.code;
    const second = server.client(host.ip).send({ t: 'resume', code, token: host.token });
    expect(second.youId).toBe(host.youId);
    expect(host.last('left')).toMatchObject({ reason: 'replaced' });
    expect(host.closed?.code).toBe(CLOSE.REPLACED);
    expect(server.room(code).members.size).toBe(1);
    expect(second.room!.members[0]?.connected).toBe(true);
    // The displaced socket has no powers left.
    host.clear();
    server.manager.handleText(host.conn, JSON.stringify({ t: 'start' }));
    expect(second.room!.phase).toBe('lobby');
  });

  it('restores a driver into a running race with full state', () => {
    const server = new TestServer({ reconnectGraceMs: 20_000 });
    const host = hostRoom(server, { laps: 1 });
    const bob = joinRoom(server, host.room!.code, 'Bob');
    bob.send({ t: 'ready', ready: true });
    host.send({ t: 'start' });
    const code = host.room!.code;
    const slot = bob.mySlot;
    driveFor(server, [host, bob], 3000);
    const before = server.room(code).session!.sim.cars[slot]!.state.x;
    bob.drop();
    driveFor(server, [host], 2000);
    // The abandoned car is parked, not driven and not removed.
    expect(host.snapshot!.cars.find((c) => c.slot === slot)).toBeDefined();
    expect(server.room(code).session!.sim.cars[slot]!.tel.speed).toBeLessThan(1);

    const back = server.client(bob.ip).send({ t: 'resume', code, token: bob.token });
    expect(back.room!.phase).toBe('racing');
    expect(back.mySlot).toBe(slot);
    expect(back.room!.race!.raceId).toBe(host.room!.race!.raceId);
    driveFor(server, [host, back], 500);
    // First snapshot after resuming is a complete one.
    expect(back.snapshot).not.toBeNull();
    expect(back.snapshot!.cars).toHaveLength(2);
    driveFor(server, [host, back], 2000);
    expect(server.room(code).session!.sim.cars[slot]!.tel.speed).toBeGreaterThan(5);
    expect(server.room(code).session!.sim.cars[slot]!.state.x).not.toBe(before);
  });
});

describe('cleanup', () => {
  it('removes a room once every member has been gone for the grace period', () => {
    const server = new TestServer({ reconnectGraceMs: 10_000 });
    const host = hostRoom(server);
    const bob = joinRoom(server, host.room!.code, 'Bob');
    host.drop();
    bob.drop();
    server.advance(5_000);
    expect(server.manager.rooms.size).toBe(1);
    server.advance(6_000);
    expect(server.manager.rooms.size).toBe(0);
    expect(server.manager.connections.size).toBe(0);
  });

  it('closes lobbies that sit idle for too long', () => {
    const server = new TestServer({ roomIdleTimeoutMs: 60_000 });
    const host = hostRoom(server);
    const bob = joinRoom(server, host.room!.code, 'Bob');
    server.advance(50_000);
    bob.send({ t: 'chat', text: 'still here' });
    server.advance(50_000);
    expect(server.manager.rooms.size).toBe(1);
    server.advance(15_000);
    expect(server.manager.rooms.size).toBe(0);
    expect(host.last('left')).toMatchObject({ reason: 'room_closed' });
    expect(bob.last('left')).toMatchObject({ reason: 'room_closed' });
    // They can go on to create or join other rooms.
    host.clear().send({ t: 'create', name: 'Ada', settings: roomSettings() });
    expect(host.room).not.toBeNull();
  });

  it('forgets rate-limit state for addresses that went away', () => {
    const server = new TestServer();
    for (let i = 0; i < 20; i++) {
      const ip = `198.51.100.${i}`;
      expect(server.manager.admit(ip)).toBeNull();
      server.client(ip).send({ t: 'list', subscribe: false }).send({ t: 'join', code: 'ZZZZZ', name: 'x', spectate: false });
    }
    expect(server.manager.rateLimitStateSize()).toBeGreaterThanOrEqual(60);
    server.advance(200_000);
    expect(server.manager.rateLimitStateSize()).toBe(0);
  });

  it('announces shutdown and stops admitting clients', () => {
    const server = new TestServer();
    const host = hostRoom(server);
    server.manager.beginShutdown('Restarting for an update.');
    expect(host.last('shutdown')).toEqual({ t: 'shutdown', message: 'Restarting for an update.' });
    expect(server.manager.admit('192.0.2.1')).toBe('shutting_down');
    server.manager.closeAll();
    expect(host.closed?.code).toBe(CLOSE.SHUTDOWN);
    expect(server.manager.connections.size).toBe(0);
  });
});

describe('race lifecycle', () => {
  it('runs countdown, race, results and returns to the lobby', () => {
    const server = new TestServer({ resultsHoldMs: 5000 });
    const host = hostRoom(server, { laps: 1, bots: 2, botSkill: 'hard' });
    const bob = joinRoom(server, host.room!.code, 'Bob', true);
    host.send({ t: 'start' });
    const code = host.room!.code;
    const session = server.room(code).session!;
    const grid = getTrack('harbor').grid[host.mySlot]!;

    // Countdown: inputs are accepted but the car does not move.
    driveFor(server, [host, bob], 900);
    expect(host.snapshot!.phase).toBe(0);
    const me = () => host.snapshot!.cars.find((c) => c.slot === host.mySlot)!;
    expect(me().x).toBeCloseTo(grid.x, 3);
    expect(me().z).toBeCloseTo(grid.z, 3);
    // The spectator receives the same authoritative stream.
    expect(bob.snapshot!.tick).toBe(host.snapshot!.tick);
    expect(bob.snapshot!.cars).toHaveLength(3);

    driveFor(server, [host], 1500);
    expect(host.snapshot!.phase).toBe(1);
    expect(Math.hypot(me().x - grid.x, me().z - grid.z)).toBeGreaterThan(3);
    expect(host.snapshot!.ackSeq).toBeGreaterThan(100);

    // The human parks; the bots finish, then the finish timeout classifies the human.
    const deadline = server.now + 120_000 + (server.config.finishTimeoutTicks / SIM_HZ) * 1000;
    while (host.room!.phase === 'racing' && server.now < deadline) server.advance(500);
    expect(host.room!.phase).toBe('results');
    const results = host.room!.results!;
    expect(results).toHaveLength(3);
    expect(results.map((r) => r.place)).toEqual([1, 2, 3]);
    expect(results.filter((r) => r.isBot).every((r) => r.finished && r.totalMs > 30_000 && r.bestLapMs > 30_000)).toBe(true);
    expect(results[2]).toMatchObject({ memberId: host.youId, finished: false, totalMs: 0 });
    expect(bob.room!.results).toEqual(results);
    expect(session.sim.endReason).toBe('timeout');

    server.advance(6000);
    expect(host.room!.phase).toBe('lobby');
    expect(host.room!.results).toBeNull();
    expect(host.room!.race).toBeNull();
    // And a second race can be started, with a new race id.
    host.send({ t: 'start' });
    expect(host.room!.race!.raceId).toBe(2);
  });

  it('sends deltas to clients that acknowledge and rations full snapshots to those that do not', () => {
    const server = new TestServer();
    const host = hostRoom(server, { bots: 5 });
    const active = joinRoom(server, host.room!.code, 'Active', true);
    const silent = joinRoom(server, host.room!.code, 'Silent', true);
    host.send({ t: 'start' });
    driveFor(server, [host, active], 2500);
    for (const client of [host, active, silent]) client.clear();
    driveFor(server, [host, active], 1000);
    const perSecond = server.config.tickRate / server.config.snapshotEvery;
    const bytes = (frames: Uint8Array[]): number => frames.reduce((sum, f) => sum + f.byteLength, 0);
    // Acknowledging clients get every snapshot, as small deltas.
    expect(Math.abs(active.frames.length - perSecond)).toBeLessThanOrEqual(1);
    expect(active.snapshot!.baseTick).toBeGreaterThan(0);
    expect(active.snapshot!.tick).toBe(host.snapshot!.tick);
    // A client that never acknowledges only gets occasional full snapshots.
    expect(silent.frames.length).toBeLessThanOrEqual(Math.ceil(perSecond / 4) + 1);
    expect(silent.frames.length).toBeGreaterThanOrEqual(Math.floor(perSecond / 4) - 1);
    expect(silent.snapshot!.baseTick).toBe(0);
    expect(silent.snapshot!.cars).toHaveLength(6);
    expect(bytes(silent.frames)).toBeLessThan(bytes(active.frames) * 1.5);
    // Once it starts acknowledging it is back on the full-rate delta stream.
    silent.clear();
    driveFor(server, [host, active, silent], 500);
    expect(silent.frames.length).toBeGreaterThanOrEqual(perSecond / 2 - 2);
    expect(silent.snapshot!.baseTick).toBeGreaterThan(0);
  });

  it('lets the host skip the results screen', () => {
    const server = new TestServer({ finishTimeoutTicks: 60 });
    const host = hostRoom(server, { laps: 1, bots: 1, botSkill: 'hard' });
    const bob = joinRoom(server, host.room!.code, 'Bob', true);
    host.send({ t: 'start' });
    for (let i = 0; i < 400 && host.room!.phase === 'racing'; i++) server.advance(500);
    expect(host.room!.phase).toBe('results');
    bob.send({ t: 'lobby' });
    expect(bob.errors()).toEqual(['not_host']);
    host.send({ t: 'lobby' });
    expect(host.room!.phase).toBe('lobby');
  });

  it('puts late joiners into the room as viewers of the race in progress', () => {
    const server = new TestServer();
    const host = hostRoom(server, { laps: 1 });
    host.send({ t: 'start' });
    driveFor(server, [host], 1500);
    const late = joinRoom(server, host.room!.code, 'Late');
    expect(late.room!.phase).toBe('racing');
    expect(late.me).toMatchObject({ role: 'racer', slot: -1 });
    expect(late.mySlot).toBe(-1);
    expect(late.room!.race!.cars).toHaveLength(1);
    late.send({ t: 'ready', ready: true }).send({ t: 'role', role: 'spectator' });
    expect(late.errors()).toEqual(['invalid_state', 'invalid_state']);
    driveFor(server, [host], 200);
    expect(late.snapshot!.cars).toHaveLength(1);
    // A viewer cannot drive anybody's car.
    const queue = server.room(host.room!.code).session!.cars[0]!.queue!;
    const accepted = queue.stats.accepted;
    for (let i = 0; i < 30; i++) late.drive({ throttle: 255, steer: 127 });
    server.advance(200);
    expect(late.snapshot!.ackSeq).toBe(0);
    expect(queue.stats.accepted).toBe(accepted);
  });

  it('cancels the race when the host aborts it', () => {
    const server = new TestServer();
    const host = hostRoom(server);
    const bob = joinRoom(server, host.room!.code, 'Bob');
    bob.send({ t: 'ready', ready: true });
    host.send({ t: 'start' });
    driveFor(server, [host, bob], 1000);
    bob.send({ t: 'abort' });
    expect(bob.errors()).toEqual(['not_host']);
    host.send({ t: 'abort' });
    for (const client of [host, bob]) {
      expect(client.room!.phase).toBe('lobby');
      expect(client.room!.race).toBeNull();
      expect(client.room!.lastRaceNote).toContain('cancelled');
      expect(client.all('notice').some((n) => n.code === 'race_cancelled')).toBe(true);
    }
  });

  it('cancels the race when every driver has left, keeping the room for spectators', () => {
    const server = new TestServer();
    const host = hostRoom(server, { bots: 2 });
    const watcher = joinRoom(server, host.room!.code, 'Eve', true);
    host.send({ t: 'start' });
    driveFor(server, [host], 1000);
    host.send({ t: 'leave' });
    expect(watcher.room!.phase).toBe('lobby');
    expect(watcher.room!.hostId).toBe(watcher.youId);
    expect(watcher.all('notice').some((n) => n.code === 'race_cancelled')).toBe(true);
    expect(server.manager.rooms.size).toBe(1);
  });

  it('removes the car of a driver whose reconnect window expires and carries on', () => {
    const server = new TestServer({ reconnectGraceMs: 4000 });
    const host = hostRoom(server);
    const bob = joinRoom(server, host.room!.code, 'Bob');
    bob.send({ t: 'ready', ready: true });
    host.send({ t: 'start' });
    const slot = bob.mySlot;
    driveFor(server, [host, bob], 1500);
    bob.drop();
    driveFor(server, [host], 3000);
    expect(host.snapshot!.cars.map((c) => c.slot)).toContain(slot);
    driveFor(server, [host], 2000);
    expect(host.snapshot!.cars.map((c) => c.slot)).not.toContain(slot);
    expect(host.room!.phase).toBe('racing');
    expect(host.room!.members).toHaveLength(1);
    expect(host.room!.race!.cars).toHaveLength(1);
  });

  it('survives a race tick blowing up by closing only that room', () => {
    const server = new TestServer();
    const victim = hostRoom(server);
    const bystander = hostRoom(server);
    victim.send({ t: 'start' });
    bystander.send({ t: 'start' });
    server.room(victim.room!.code).session!.sim.step = () => {
      throw new Error('boom');
    };
    server.advance(100);
    expect(victim.last('left')).toMatchObject({ reason: 'room_closed' });
    expect(server.manager.rooms.has(bystander.room!.code)).toBe(true);
    expect(bystander.room!.phase).toBe('racing');
  });

  it('records best laps set by humans only from server-validated times', () => {
    const server = new TestServer();
    const host = hostRoom(server, { laps: 1 });
    host.send({ t: 'start' });
    const room = server.room(host.room!.code);
    const sim = room.session!.sim;
    driveFor(server, [host], 1200);
    // Walk the car through every gate using the simulation's own rules.
    const track = sim.track;
    const car = sim.cars[0]!;
    const through = (gateIndex: number): void => {
      const gate = track.gates[gateIndex]!;
      car.state.x = gate.cx - gate.tx * 3;
      car.state.z = gate.cz - gate.tz * 3;
      car.state.yaw = Math.atan2(gate.tx, gate.tz);
      car.state.vx = gate.tx * 30;
      car.state.vz = gate.tz * 30;
      car.lastX = car.state.x;
      car.lastZ = car.state.z;
      server.advance(250);
    };
    for (let g = 0; g < track.gates.length; g++) through(g);
    server.advance(6000); // A lap must take a plausible amount of time to count.
    through(0);
    server.advance(1000);
    expect(server.records.all()).toHaveLength(1);
    expect(server.records.all()[0]).toMatchObject({ trackId: 'harbor', name: 'Ada' });
    expect(host.last('records')?.records[0]?.ms).toBe(car.bestLapMs);
  });
});
