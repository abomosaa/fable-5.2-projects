/**
 * Prediction, reconciliation and interpolation under simulated network
 * conditions. The real server logic and the real client netcode are connected
 * through a deterministic virtual network (see tests/helpers/virtualNet.ts).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Predictor, SNAP_DISTANCE } from '../../client/src/net/prediction';
import type { RaceClient } from '../../client/src/net/raceClient';
import { PERFECT_NETWORK, type NetConditions } from '../../shared/net/netsim';
import { SIM_HZ } from '../../shared/constants';
import { RacePhaseCode, quantizeCar, quantizeInput, type RoomSettings } from '../../shared/protocol';
import { Rng } from '../../shared/sim/rng';
import { getTrack } from '../../shared/sim/tracks';
import { makeCarState, makeTelemetry, stepCar, type CarInput, type CarState } from '../../shared/sim/vehicle';
import { VirtualWorld, type VirtualClient } from '../helpers/virtualNet';

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

const NO_PROGRESS = { cp: 0, rank: 1, cpMs: 0, lapStartMs: 0, lastLapMs: 0, bestLapMs: 0, finishMs: 0 };
const settings: RoomSettings = { name: 'Netcode', trackId: 'harbor', laps: 1, maxPlayers: 4, bots: 0, botSkill: 'medium', isPublic: true };

const LINKS: Record<string, NetConditions> = {
  clean: { latencyMs: 15, jitterMs: 0, loss: 0, duplicate: 0, reorder: 0 },
  laggy: { latencyMs: 120, jitterMs: 15, loss: 0, duplicate: 0, reorder: 0 },
  jittery: { latencyMs: 60, jitterMs: 90, loss: 0, duplicate: 0, reorder: 0 },
  lossy: { latencyMs: 50, jitterMs: 20, loss: 0.15, duplicate: 0, reorder: 0 },
  messy: { latencyMs: 80, jitterMs: 50, loss: 0.08, duplicate: 0.12, reorder: 0.12 },
};

describe('client-side prediction', () => {
  const track = getTrack('harbor');

  /** A scripted drive: accelerate, weave, brake. */
  function script(tick: number): CarInput {
    const steer = Math.sin(tick / 25) * 0.7;
    return quantizeInput(steer, tick % 400 < 300 ? 1 : 0, tick % 400 >= 340 ? 0.8 : 0, tick % 500 === 499, false);
  }

  function startState(): CarState {
    const grid = track.grid[0]!;
    return makeCarState(grid.x, grid.z, grid.yaw);
  }

  it('matches the server exactly when acknowledgements arrive after a delay', () => {
    const server = startState();
    const tel = makeTelemetry();
    const predictor = new Predictor(track);
    predictor.reconcile(quantizeCar(0, server, script(0), 0, NO_PROGRESS), 0, [], false);
    const inFlight: Array<{ seq: number; input: CarInput }> = [];
    const delay = 9; // Ticks between sending an input and seeing it acknowledged.
    let worst = 0;
    for (let tick = 1; tick <= SIM_HZ * 40; tick++) {
      const input = script(tick);
      inFlight.push({ seq: predictor.push(input), input });
      if (inFlight.length > delay) {
        const next = inFlight.shift()!;
        stepCar(server, next.input, track, tel);
        if (tick % 2 === 0) {
          const correction = predictor.reconcile(quantizeCar(0, server, next.input, 0, NO_PROGRESS), next.seq, [], false);
          worst = Math.max(worst, correction);
        }
      }
      expect(predictor.pending.length).toBeLessThanOrEqual(delay + 2);
    }
    // Only quantisation separates prediction from the authoritative result.
    expect(worst).toBeLessThan(0.02);
    expect(predictor.stats.snaps).toBe(0);
    // And the predicted car is ahead of the server by exactly the unacknowledged inputs.
    const ahead = { ...server };
    for (const item of inFlight) stepCar(ahead, item.input, track, tel);
    expect(Math.hypot(ahead.x - predictor.state.x, ahead.z - predictor.state.z)).toBeLessThan(0.05);
  });

  it('converges after the server applies something the client did not predict', () => {
    const server = startState();
    const tel = makeTelemetry();
    const predictor = new Predictor(track);
    predictor.reconcile(quantizeCar(0, server, script(0), 0, NO_PROGRESS), 0, [], false);
    const gas = quantizeInput(0, 1, 0, false, false);
    for (let tick = 1; tick <= 120; tick++) {
      const seq = predictor.push(gas);
      stepCar(server, gas, track, tel);
      predictor.reconcile(quantizeCar(0, server, gas, 0, NO_PROGRESS), seq, [], false);
    }
    // The server shoves the car sideways (say, a collision the client never saw).
    server.x += 1.5;
    server.vx += 2;
    const seq = predictor.push(gas);
    stepCar(server, gas, track, tel);
    const before = { x: predictor.renderX, z: predictor.renderZ };
    const correction = predictor.reconcile(quantizeCar(0, server, gas, 0, NO_PROGRESS), seq, [], false);
    expect(correction).toBeGreaterThan(1);
    expect(correction).toBeLessThan(SNAP_DISTANCE);
    // The simulation state is corrected at once...
    expect(Math.hypot(predictor.state.x - server.x, predictor.state.z - server.z)).toBeLessThan(0.01);
    // ...but what is drawn does not jump: it blends over the following ticks.
    expect(Math.hypot(predictor.renderX - before.x, predictor.renderZ - before.z)).toBeLessThan(0.01);
    let previous = Math.hypot(predictor.offsetX, predictor.offsetZ);
    for (let tick = 0; tick < 60; tick++) {
      const s = predictor.push(gas);
      stepCar(server, gas, track, tel);
      predictor.reconcile(quantizeCar(0, server, gas, 0, NO_PROGRESS), s, [], false);
      const offset = Math.hypot(predictor.offsetX, predictor.offsetZ);
      expect(offset).toBeLessThanOrEqual(previous + 0.02);
      previous = offset;
    }
    expect(previous).toBeLessThan(0.03);
  });

  it('snaps without smoothing when the server teleports the car', () => {
    const server = startState();
    const predictor = new Predictor(track);
    predictor.reconcile(quantizeCar(0, server, script(0), 0, NO_PROGRESS), 0, [], false);
    for (let i = 0; i < 30; i++) predictor.push(quantizeInput(0, 1, 0, false, false));
    server.x += 120;
    server.z += 40;
    predictor.reconcile(quantizeCar(0, server, script(0), 0, NO_PROGRESS), 30, [], true);
    expect(predictor.offsetX).toBe(0);
    expect(predictor.offsetZ).toBe(0);
    expect(predictor.renderX).toBeCloseTo(server.x, 2);
    // An unflagged but huge error is not smoothed either.
    server.x -= 80;
    predictor.reconcile(quantizeCar(0, server, script(0), 0, NO_PROGRESS), 30, [], false);
    expect(predictor.offsetX).toBe(0);
    expect(predictor.stats.snaps).toBe(1);
  });

  it('adopts the server sequence when (re)joining so fresh inputs are never stale', () => {
    const predictor = new Predictor(track);
    expect(predictor.synced).toBe(false);
    predictor.reconcile(quantizeCar(0, startState(), script(0), 0, NO_PROGRESS), 5000, [], false);
    expect(predictor.synced).toBe(true);
    expect(predictor.push(quantizeInput(0, 1, 0, false, false))).toBe(5001);
  });

  it('bounds the memory used for unacknowledged inputs', () => {
    const predictor = new Predictor(track);
    predictor.reconcile(quantizeCar(0, startState(), script(0), 0, NO_PROGRESS), 0, [], false);
    for (let i = 0; i < 5000; i++) predictor.push(script(i));
    expect(predictor.pending.length).toBeLessThanOrEqual(120);
    expect(predictor.stats.overflow).toBeGreaterThan(4000);
  });

  it('predicts contact with another car the same way the server resolves it', () => {
    const predictor = new Predictor(track);
    const me = startState();
    me.vx = Math.sin(me.yaw) * 20;
    me.vz = Math.cos(me.yaw) * 20;
    // A stationary car directly ahead.
    const proxy = { x: me.x + Math.sin(me.yaw) * 8, z: me.z + Math.cos(me.yaw) * 8, yaw: me.yaw, vx: 0, vz: 0, yawRate: 0, frozen: false };
    predictor.reconcile(quantizeCar(0, me, script(0), 0, NO_PROGRESS), 0, [proxy], false);
    let hit = 0;
    for (let i = 0; i < 40; i++) {
      predictor.push(quantizeInput(0, 0, 0, false, false));
      hit = Math.max(hit, predictor.carHit);
    }
    expect(hit).toBeGreaterThan(5);
    // The car was stopped by the obstacle instead of driving through it.
    const travelled = Math.hypot(predictor.state.x - me.x, predictor.state.z - me.z);
    expect(travelled).toBeLessThan(8);
    expect(Math.hypot(predictor.state.vx, predictor.state.vz)).toBeLessThan(15);
  });
});

interface RaceRun {
  world: VirtualWorld;
  driver: VirtualClient;
  watcher: VirtualClient;
  race: RaceClient;
  watch: RaceClient;
  slot: number;
}

/** A driver and a spectator in one room, the race started, both on the given link. */
function startRace(conditions: NetConditions, overrides: Partial<RoomSettings> = {}): RaceRun {
  const world = new VirtualWorld();
  const driver = world.addClient('Ada', { conditions });
  const watcher = world.addClient('Eve', { conditions, frameMs: 1000 / 75 });
  world.advanceUntil(() => driver.game.connection.isOpen && watcher.game.connection.isOpen, 5000, 'connections');
  driver.game.createRoom('Ada', { ...settings, ...overrides });
  world.advanceUntil(() => driver.game.room !== null, 5000, 'room');
  watcher.game.joinRoom(driver.game.room!.code, 'Eve', true);
  world.advanceUntil(() => watcher.game.room !== null, 5000, 'join');
  driver.driveLikeABot(0.75);
  driver.game.startRace();
  world.advanceUntil(() => driver.game.race !== null && watcher.game.race !== null, 5000, 'race start');
  return { world, driver, watcher, race: driver.game.race!, watch: watcher.game.race!, slot: driver.game.raceSlot };
}

function serverCarOrNull(run: RaceRun): { x: number; z: number; speed: number; tick: number } | null {
  const session = [...run.world.manager.rooms.values()][0]?.session;
  if (!session) return null;
  const car = session.sim.cars[run.slot]!;
  return { x: car.state.x, z: car.state.z, speed: car.tel.speed, tick: session.sim.tick };
}

function serverCar(run: RaceRun): { x: number; z: number; speed: number; tick: number } {
  const car = serverCarOrNull(run);
  if (!car) throw new Error('The race is not running on the server');
  return car;
}

describe('netcode over a simulated network', () => {
  for (const [name, conditions] of Object.entries(LINKS)) {
    it(`completes a full race on a ${name} link with smooth, bounded corrections`, () => {
      const run = startRace(conditions);
      const { world, race, watch, slot } = run;
      let frames = 0;
      let worstJump = 0;
      let worstRemoteStep = 0;
      let worstRemoteError = 0;
      let lastLocal: { x: number; z: number } | null = null;
      let lastRemote: { x: number; z: number } | null = null;
      const history: Array<{ tick: number; x: number; z: number }> = [];
      const start = world.now;

      while (run.driver.game.room?.phase === 'racing' && world.now - start < 150_000) {
        world.advance(1000 / 60);
        frames++;
        const truth = serverCarOrNull(run);
        if (!truth) break; // The server has moved on to the results.
        history.push({ tick: truth.tick, x: truth.x, z: truth.z });
        if (history.length > 240) history.shift();

        // --- The driver's own (predicted) car must move smoothly.
        const view = race.view(world.now);
        const mine = view.cars[slot]!;
        if (view.hasData && mine.present && view.phase === RacePhaseCode.racing && race.predicting) {
          if (lastLocal) {
            const step = Math.hypot(mine.x - lastLocal.x, mine.z - lastLocal.z);
            // Never more than about two frames of top-speed travel in one frame.
            worstJump = Math.max(worstJump, step - (mine.speed / 60) * 2.2);
          }
          lastLocal = { x: mine.x, z: mine.z };
        } else {
          lastLocal = null;
        }

        // --- The spectator's interpolated view of that car.
        const seen = watch.view(world.now).cars[slot]!;
        if (seen.present && watch.latest && watch.latest.phase === RacePhaseCode.racing) {
          expect(Number.isFinite(seen.x + seen.z + seen.yaw)).toBe(true);
          if (lastRemote) worstRemoteStep = Math.max(worstRemoteStep, Math.hypot(seen.x - lastRemote.x, seen.z - lastRemote.z) - (seen.speed / 60) * 3);
          lastRemote = { x: seen.x, z: seen.z };
          // It shows where the car really was a moment ago: distance to the authoritative path.
          let best = Infinity;
          for (let i = 1; i < history.length; i++) best = Math.min(best, distanceToSegment(seen.x, seen.z, history[i - 1]!, history[i]!));
          worstRemoteError = Math.max(worstRemoteError, best);
        } else {
          lastRemote = null;
        }
      }

      world.advanceUntil(() => run.driver.game.room?.phase === 'results' && run.watcher.game.room?.phase === 'results', 5000, 'results');
      const room = run.driver.game.room!;
      const result = room.results![0]!;
      expect(result.finished).toBe(true);
      // Driving from the predicted state gets round the lap in a normal time on any link.
      expect(result.totalMs).toBeGreaterThan(55_000);
      expect(result.totalMs).toBeLessThan(80_000);
      expect(run.watcher.game.room!.results).toEqual(room.results);

      // Prediction: corrections stay small and are never hard snaps.
      expect(race.predictor.stats.snaps).toBe(0);
      expect(race.predictor.stats.maxCorrection).toBeLessThan(name === 'clean' || name === 'laggy' ? 0.05 : 2.5);
      expect(race.predictor.stats.sumCorrection / race.predictor.stats.reconciles).toBeLessThan(0.05);
      expect(worstJump).toBeLessThan(1.0);
      // Interpolation: continuous motion that tracks the authoritative path.
      expect(worstRemoteStep).toBeLessThan(1.5);
      expect(worstRemoteError).toBeLessThan(name === 'clean' || name === 'laggy' ? 0.3 : 3.5);
      expect(frames).toBeGreaterThan(3000);

      // Nothing invalid ever reached either client, and impairments were really exercised.
      expect(race.stats.invalid + watch.stats.invalid).toBe(0);
      if (conditions.duplicate > 0) expect(race.stats.duplicates).toBeGreaterThan(20);
      if (conditions.reorder > 0 || conditions.jitterMs > 40) expect(race.stats.outOfOrder).toBeGreaterThan(10);
      if (conditions.loss > 0) expect(race.stats.snapshots).toBeLessThan(frames * 0.5);
    });
  }

  it('gives every link the same authoritative race, whatever its quality', () => {
    const times = Object.values(LINKS).map((conditions) => {
      const run = startRace(conditions);
      run.world.advanceUntil(() => run.driver.game.room?.phase === 'results', 150_000, 'results');
      return run.driver.game.room!.results![0]!.totalMs;
    });
    // The same driver logic produces nearly the same race time on every connection.
    expect(Math.max(...times) - Math.min(...times)).toBeLessThan(2500);
  });

  it('uses delta snapshots and keeps bandwidth bounded with a full grid', () => {
    const run = startRace(LINKS.clean!, { bots: 7, botSkill: 'hard' });
    const { world, driver, race } = run;
    world.advance(30_000);
    const seconds = 30;
    const down = driver.socket!.bytesDown / seconds;
    const up = driver.socket!.bytesUp / seconds;
    // 8 cars at 30 snapshots/s: comfortably under 10 kB/s down and 3 kB/s up.
    expect(down).toBeLessThan(10_000);
    expect(up).toBeLessThan(3_000);
    // Nearly everything is a delta; full snapshots only at the start.
    expect(race.stats.fullSnapshots).toBeLessThan(10);
    expect(race.stats.snapshots).toBeGreaterThan(800);
    expect(race.latest!.cars).toHaveLength(8);
  });

  it('never needs a lost snapshot: deltas are only made against acknowledged baselines', () => {
    const run = startRace({ latencyMs: 40, jitterMs: 10, loss: 0.4, duplicate: 0, reorder: 0 });
    const { world, race } = run;
    world.advance(20_000);
    // 40% loss in both directions, yet no delta ever referred to a snapshot the client lacked.
    expect(race.stats.missingBase).toBe(0);
    expect(race.stats.fullSnapshots).toBeLessThan(6);
    expect(race.stats.snapshots).toBeGreaterThan(250);
    // The client's picture of the race stays the server's.
    const session = [...world.manager.rooms.values()][0]!.session!;
    const latest = race.latest!;
    expect(session.tick - latest.tick).toBeLessThan(SIM_HZ);
    expect(race.stats.invalid).toBe(0);
    expect(race.predictor.stats.snaps).toBe(0);
    const truth = serverCar(run);
    const mine = race.view(world.now).cars[run.slot]!;
    expect(Math.hypot(mine.x - truth.x, mine.z - truth.z)).toBeLessThan(25);
  });

  it('asks for a full snapshot when it no longer holds the delta baseline', () => {
    const run = startRace(LINKS.clean!);
    const { world, race } = run;
    world.advanceUntil(() => race.latest?.phase === RacePhaseCode.racing, 10_000, 'green');
    world.advance(3000);
    const fullsBefore = race.stats.fullSnapshots;
    // The client loses its snapshot history (as if its state had been wiped).
    (race as unknown as { history: Map<number, unknown> }).history.clear();
    const tickBefore = race.latest!.tick;
    world.advance(1500);
    expect(race.stats.missingBase).toBeGreaterThan(0);
    expect(race.stats.fullSnapshots).toBe(fullsBefore + 1);
    expect(race.stats.invalid).toBe(0);
    // Back on deltas, and fully up to date.
    expect(race.latest!.tick).toBeGreaterThan(tickBefore + 60);
    expect(race.latest!.baseTick).toBeGreaterThan(0);
    const truth = serverCar(run);
    const mine = race.view(world.now).cars[run.slot]!;
    expect(Math.hypot(mine.x - truth.x, mine.z - truth.z)).toBeLessThan(6);
  });

  it('survives a stalled connection: no runaway car, quick convergence afterwards', () => {
    const run = startRace(LINKS.clean!);
    const { world, driver, watcher, race, watch, slot } = run;
    world.advanceUntil(() => race.latest?.phase === RacePhaseCode.racing, 10_000, 'green');
    world.advance(6000);
    const atStall = serverCar(run);
    expect(atStall.speed).toBeGreaterThan(20);

    // Three seconds during which nothing gets through in either direction.
    driver.socket!.frozen = true;
    watcher.socket!.frozen = true;
    let worstRemote = 0;
    const frozenView = { ...watch.view(world.now).cars[slot]! };
    for (let i = 0; i < 180; i++) {
      world.advance(1000 / 60);
      const seen = watch.view(world.now).cars[slot]!;
      worstRemote = Math.max(worstRemote, Math.hypot(seen.x - frozenView.x, seen.z - frozenView.z));
    }
    // The spectator's copy extrapolated a little, then stopped and was marked stale.
    expect(worstRemote).toBeLessThan(20);
    expect(watch.view(world.now).cars[slot]!.stale).toBe(true);
    // The driver stopped predicting instead of driving blind for three seconds.
    expect(race.predictor.pending.length).toBeLessThanOrEqual(120);
    expect(race.silenceMs(world.now)).toBeGreaterThan(2500);
    // The server did not keep the throttle pinned: the car coasted.
    const during = serverCar(run);
    expect(during.speed).toBeLessThan(atStall.speed);

    driver.socket!.frozen = false;
    watcher.socket!.frozen = false;
    world.advance(2500);
    const truth = serverCar(run);
    const mine = race.view(world.now).cars[slot]!;
    const seen = watch.view(world.now).cars[slot]!;
    expect(seen.stale).toBe(false);
    // Back to the normal interpolation lag (a fraction of a second of travel).
    expect(Math.hypot(seen.x - truth.x, seen.z - truth.z)).toBeLessThan(8);
    expect(watch.clock.delayTicks).toBeLessThan(8);
    expect(Math.hypot(mine.x - truth.x, mine.z - truth.z)).toBeLessThan(12);
    // And the race can still be finished normally.
    world.advanceUntil(() => driver.game.room?.phase === 'results', 150_000, 'results');
    expect(driver.game.room!.results![0]!.finished).toBe(true);
  });

  it('survives a stalled server and a frozen client', () => {
    const run = startRace(LINKS.laggy!);
    const { world, driver, race } = run;
    world.advanceUntil(() => race.latest?.phase === RacePhaseCode.racing, 10_000, 'green');
    world.advance(4000);
    // The server process hangs for a second.
    world.serverPaused = true;
    world.advance(1000);
    world.serverPaused = false;
    world.advance(1500);
    // Then the client's tab freezes for two seconds.
    driver.paused = true;
    world.advance(2000);
    driver.paused = false;
    world.advance(3000);
    expect(race.stats.droppedSteps).toBeGreaterThan(60); // Lost time is dropped, not replayed.
    const truth = serverCar(run);
    const mine = race.view(world.now).cars[run.slot]!;
    expect(Math.hypot(mine.x - truth.x, mine.z - truth.z)).toBeLessThan(15);
    expect(race.stats.invalid).toBe(0);
    world.advanceUntil(() => driver.game.room?.phase === 'results', 180_000, 'results');
    expect(driver.game.room!.results![0]!.finished).toBe(true);
  });

  it('keeps the server input queue shallow so latency is not added needlessly', () => {
    const run = startRace(LINKS.jittery!);
    const { world, race } = run;
    world.advanceUntil(() => race.latest?.phase === RacePhaseCode.racing, 10_000, 'green');
    world.advance(5000);
    const queue = [...world.manager.rooms.values()][0]!.session!.cars[run.slot]!.queue!;
    const starvedBefore = queue.stats.starved;
    let depth = 0;
    let samples = 0;
    for (let i = 0; i < 600; i++) {
      world.advance(1000 / 60);
      depth += queue.depth;
      samples++;
    }
    // A few ticks of buffer to absorb jitter: neither empty nor piling up.
    expect(depth / samples).toBeGreaterThan(0.8);
    expect(depth / samples).toBeLessThan(7);
    expect(queue.stats.starved - starvedBefore).toBeLessThan(120);
    expect(race.timeScale).toBeGreaterThan(0.94);
    expect(race.timeScale).toBeLessThan(1.06);
  });

  it('shows each driver the green light when their own inputs take effect', () => {
    const fast = startRace(LINKS.clean!);
    const slow = startRace({ latencyMs: 150, jitterMs: 0, loss: 0, duplicate: 0, reorder: 0 });
    const greenAt = (run: RaceRun): { client: number; server: number } => {
      let client = -1;
      let server = -1;
      const session = [...run.world.manager.rooms.values()][0]!.session!;
      for (let i = 0; i < 6000 && (client < 0 || server < 0); i++) {
        run.world.advance(1);
        if (client < 0 && run.race.drainEvents().some((e) => e.type === 'go')) client = run.world.now;
        if (server < 0 && session.sim.phase === 'racing') server = run.world.now;
      }
      return { client, server };
    };
    const a = greenAt(fast);
    const b = greenAt(slow);
    expect(a.client).toBeGreaterThan(0);
    expect(b.client).toBeGreaterThan(0);
    // A laggy driver sees green earlier by roughly their latency, so their first
    // input reaches the server as the race starts: nobody is handicapped by ping.
    expect(a.server - a.client).toBeGreaterThanOrEqual(0);
    expect(a.server - a.client).toBeLessThan(120);
    expect(b.server - b.client).toBeGreaterThan(120);
    expect(b.server - b.client).toBeLessThan(330);
    // Both cars get away from the line, however laggy the driver.
    for (const run of [fast, slow]) {
      run.world.advance(1500);
      expect(serverCar(run).speed).toBeGreaterThan(8);
    }
  });

  it('reconnects a driver mid-race over the same virtual network', () => {
    const run = startRace(LINKS.messy!);
    const { world, driver } = run;
    world.advanceUntil(() => run.race.latest?.phase === RacePhaseCode.racing, 10_000, 'green');
    world.advance(8000);
    const raceId = run.race.race.raceId;
    const tokenBefore = driver.store.load()!.token;
    driver.socket!.drop();
    world.advance(200);
    expect(driver.game.connection.status).toBe('reconnecting');
    world.advanceUntil(() => driver.game.connection.isOpen && driver.game.race !== null && driver.game.race !== run.race, 15_000, 'resume');
    const resumed = driver.game.race!;
    expect(resumed.race.raceId).toBe(raceId);
    expect(resumed.slot).toBe(run.slot);
    expect(driver.store.load()!.token).not.toBe(tokenBefore);
    world.advanceUntil(() => resumed.predicting, 5000, 'prediction resumes');
    world.advanceUntil(() => driver.game.room?.phase === 'results', 200_000, 'results');
    expect(driver.game.room!.results![0]).toMatchObject({ finished: true, name: 'Ada' });
    expect(driver.sockets.length).toBe(2);
  });

  it('never applies snapshots from a previous race to a new one', () => {
    const run = startRace(PERFECT_NETWORK);
    const { world, driver } = run;
    world.advance(3000);
    const stale = encodeFrames(run);
    driver.game.abortRace();
    world.advanceUntil(() => driver.game.room?.phase === 'lobby', 5000, 'lobby');
    driver.game.startRace();
    world.advanceUntil(() => driver.game.race !== null && driver.game.race !== run.race, 5000, 'second race');
    const second = driver.game.race!;
    world.advance(500);
    const before = second.latest!.tick;
    for (const frame of stale) second.onSnapshot(frame, world.now);
    expect(second.stats.wrongRace).toBe(stale.length);
    expect(second.latest!.tick).toBe(before);
    expect(second.stats.invalid).toBe(0);
  });
});

function distanceToSegment(x: number, z: number, a: { x: number; z: number }, b: { x: number; z: number }): number {
  const dx = b.x - a.x;
  const dz = b.z - a.z;
  const l2 = dx * dx + dz * dz;
  const t = l2 > 0 ? Math.min(1, Math.max(0, ((x - a.x) * dx + (z - a.z) * dz) / l2)) : 0;
  return Math.hypot(x - (a.x + dx * t), z - (a.z + dz * t));
}

/** Captures a few genuine snapshot frames from the running race. */
function encodeFrames(run: RaceRun): Uint8Array[] {
  const session = [...run.world.manager.rooms.values()][0]!.session!;
  const frames: Uint8Array[] = [];
  const rng = new Rng(3);
  for (let i = 0; i < 5; i++) {
    run.world.advance(40 + rng.int(0, 20));
    session.snapshot();
    const bytes = session.encodeFor(0, run.slot);
    if (bytes) frames.push(bytes);
  }
  return frames;
}
