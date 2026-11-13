import { describe, expect, it } from 'vitest';
import { SIM_HZ, TICK_MS } from '../../shared/constants';
import {
  MAX_STEP_DISTANCE,
  OFFTRACK_PENALTY_AFTER,
  PENALTY_TICKS,
  RESET_COOLDOWN_TICKS,
  RESET_FREEZE_TICKS,
  RaceSim,
  checkpointOf,
  crossGate,
  lapOf,
  lapsCompleted,
  type RaceEvent,
} from '../../shared/sim/race';
import { Rng } from '../../shared/sim/rng';
import { makeQuery, queryTrack } from '../../shared/sim/track';
import { TRACK_DEFS, getTrack } from '../../shared/sim/tracks';
import type { CarInput } from '../../shared/sim/vehicle';
import { input, placeCar, runBotRace } from '../helpers/sim';

const harbor = getTrack('harbor');
const FULL = 255;

function newRace(cars = 1, laps = 2, options: ConstructorParameters<typeof RaceSim>[3] = { countdownTicks: 20 }): RaceSim {
  return new RaceSim(
    harbor,
    laps,
    Array.from({ length: cars }, () => ({ isBot: false })),
    options,
  );
}

function stepAll(sim: RaceSim, inputs: Array<CarInput | null>, ticks = 1): RaceEvent[] {
  const events: RaceEvent[] = [];
  for (let i = 0; i < ticks; i++) events.push(...sim.step(inputs));
  return events;
}

/** Drives a car (by direct placement) forward through the next gate it is due at. */
function passGate(sim: RaceSim, slot: number, gateIndex: number): RaceEvent[] {
  const gate = sim.track.gates[gateIndex]!;
  placeCar(sim, slot, gate.s - 3 + (gateIndex === 0 ? sim.track.length : 0), 0, 30);
  return stepAll(sim, [], 14);
}

describe('grid and countdown', () => {
  it('lines the cars up on fixed grid slots behind the line', () => {
    const sim = newRace(8);
    sim.cars.forEach((car, slot) => {
      const grid = harbor.grid[slot]!;
      expect(car.state.x).toBe(grid.x);
      expect(car.state.z).toBe(grid.z);
      expect(car.state.yaw).toBe(grid.yaw);
      expect(car.cp).toBe(0);
    });
    expect(sim.phase).toBe('countdown');
  });

  it('refuses more cars than the grid holds', () => {
    expect(() => newRace(9)).toThrow();
    expect(() => newRace(0)).toThrow();
  });

  it('holds every car still until the green light, whatever the inputs', () => {
    const sim = newRace(3, 1, { countdownTicks: 60 });
    const start = sim.cars.map((c) => [c.state.x, c.state.z]);
    const pedal = [input({ throttle: FULL }), input({ throttle: FULL, steer: 100 }), input({ brake: FULL })];
    const events = stepAll(sim, pedal, 60);
    sim.cars.forEach((car, i) => {
      expect([car.state.x, car.state.z]).toEqual(start[i]);
      expect(car.tel.speed).toBe(0);
    });
    expect(events.filter((e) => e.type === 'go')).toHaveLength(1);
    expect(sim.phase).toBe('racing');
    expect(sim.tick).toBe(sim.goTick);
    // Everybody is released on the same tick.
    stepAll(sim, pedal, 30);
    expect(sim.cars[0]!.tel.speed).toBeGreaterThan(2);
    expect(sim.cars[1]!.tel.speed).toBeGreaterThan(2);
  });

  it('measures race time from the green light', () => {
    const sim = newRace(1, 1, { countdownTicks: 30 });
    stepAll(sim, [], 30);
    expect(sim.raceMs).toBe(0);
    stepAll(sim, [], 60);
    expect(sim.raceMs).toBeCloseTo(1000, 6);
  });
});

describe('checkpoints and laps', () => {
  it('credits gates only in order', () => {
    const sim = newRace(1, 2);
    stepAll(sim, [], 20);
    const car = sim.cars[0]!;
    const n = harbor.gates.length;
    for (let g = 0; g < n; g++) {
      const events = passGate(sim, 0, g);
      expect(car.cp).toBe(g + 1);
      expect(events.filter((e) => e.type === 'checkpoint')).toHaveLength(1);
    }
    expect(lapsCompleted(car.cp, n)).toBe(0);
    const events = passGate(sim, 0, 0);
    expect(car.cp).toBe(n + 1);
    expect(lapsCompleted(car.cp, n)).toBe(1);
    const lap = events.find((e) => e.type === 'lap');
    expect(lap).toMatchObject({ type: 'lap', slot: 0, lap: 1, best: true });
    expect(car.lastLapMs).toBeGreaterThan(0);
    expect(car.bestLapMs).toBe(car.lastLapMs);
  });

  it('rejects a shortcut that skips a checkpoint', () => {
    const sim = newRace(1, 1);
    stepAll(sim, [], 20);
    const car = sim.cars[0]!;
    passGate(sim, 0, 0);
    passGate(sim, 0, 1);
    expect(car.cp).toBe(2);
    // Jump ahead: drive through gate 3 and 4 without gate 2.
    const events = [...passGate(sim, 0, 3), ...passGate(sim, 0, 4)];
    expect(car.cp).toBe(2);
    expect(car.missedGate).toBe(true);
    expect(events.some((e) => e.type === 'missed_gate')).toBe(true);
    expect(events.some((e) => e.type === 'checkpoint')).toBe(false);
    // Even driving the rest of the lap cannot complete it.
    for (let g = 5; g < harbor.gates.length; g++) passGate(sim, 0, g);
    passGate(sim, 0, 0);
    expect(car.cp).toBe(2);
    expect(car.finished).toBe(false);
    // Going back for the missed gate puts things right.
    passGate(sim, 0, 2);
    expect(car.cp).toBe(3);
    expect(car.missedGate).toBe(false);
  });

  it('ignores gates crossed in reverse', () => {
    const sim = newRace(1, 1);
    stepAll(sim, [], 20);
    const car = sim.cars[0]!;
    passGate(sim, 0, 0);
    // Reverse across gate 1 from the far side.
    const gate = harbor.gates[1]!;
    placeCar(sim, 0, gate.s + 3, 0, 30, true);
    const events = stepAll(sim, [], 14);
    expect(car.cp).toBe(1);
    expect(events.some((e) => e.type === 'checkpoint')).toBe(false);
  });

  it('does not count a lap for crossing the finish line back and forth', () => {
    const sim = newRace(1, 1);
    stepAll(sim, [], 20);
    const car = sim.cars[0]!;
    passGate(sim, 0, 0);
    expect(car.cp).toBe(1);
    for (let i = 0; i < 4; i++) {
      // Back over the line...
      placeCar(sim, 0, 3, 0, 30, true);
      stepAll(sim, [], 14);
      // ...and forwards again.
      placeCar(sim, 0, harbor.length - 3, 0, 30);
      stepAll(sim, [], 14);
    }
    expect(car.cp).toBe(1);
    expect(lapsCompleted(car.cp, harbor.gates.length)).toBe(0);
    expect(car.finished).toBe(false);
    expect(sim.finishOrder).toHaveLength(0);
  });

  it('never credits a gate for an impossible (teleport) move', () => {
    const sim = newRace(1, 1);
    stepAll(sim, [], 20);
    const car = sim.cars[0]!;
    passGate(sim, 0, 0);
    // The car "appears" on the far side of gate 1 without having driven there:
    // the simulation is told where it was last tick, 40 m before the gate.
    const gate = harbor.gates[1]!;
    placeCar(sim, 0, gate.s - 40, 0, 0);
    stepAll(sim, [], 1);
    const before = { x: car.state.x, z: car.state.z };
    car.state.x += gate.tx * 45;
    car.state.z += gate.tz * 45;
    expect(crossGate(gate, before.x, before.z, car.state.x, car.state.z)).toBeGreaterThanOrEqual(0);
    expect(Math.hypot(car.state.x - before.x, car.state.z - before.z)).toBeGreaterThan(MAX_STEP_DISTANCE);
    const events = stepAll(sim, [], 1);
    expect(car.cp).toBe(1);
    expect(events.some((e) => e.type === 'teleport_rejected')).toBe(true);
    expect(events.some((e) => e.type === 'checkpoint')).toBe(false);
  });

  it('times laps from line to line with sub-tick precision', () => {
    const sim = newRace(1, 3);
    stepAll(sim, [], 20);
    const car = sim.cars[0]!;
    const n = harbor.gates.length;
    for (let g = 0; g < n; g++) passGate(sim, 0, g);
    const startMs = car.lapStartMs;
    passGate(sim, 0, 0);
    expect(car.lastLapMs).toBe(car.cpMs - startMs);
    // Not quantised to whole ticks.
    const ticks = car.cpMs / TICK_MS;
    expect(Math.abs(ticks - Math.round(ticks))).toBeGreaterThan(1e-3);
    // A slower second lap does not replace the best.
    const best = car.bestLapMs;
    for (let g = 1; g < n; g++) passGate(sim, 0, g);
    stepAll(sim, [], 400);
    passGate(sim, 0, 0);
    expect(car.lastLapMs).toBeGreaterThan(best);
    expect(car.bestLapMs).toBe(best);
  });

  it('exposes consistent lap/checkpoint numbering helpers', () => {
    expect(lapOf(0, 10, 3)).toBe(1);
    expect(lapOf(1, 10, 3)).toBe(1);
    expect(lapOf(10, 10, 3)).toBe(1);
    expect(lapOf(11, 10, 3)).toBe(2);
    expect(lapOf(31, 10, 3)).toBe(3);
    expect(checkpointOf(1, 10)).toBe(0);
    expect(checkpointOf(10, 10)).toBe(9);
    expect(checkpointOf(11, 10)).toBe(0);
    expect(lapsCompleted(0, 10)).toBe(0);
    expect(lapsCompleted(11, 10)).toBe(1);
  });
});

describe('finish and standings', () => {
  it('finishes a car after the configured number of laps', () => {
    const sim = newRace(1, 2);
    stepAll(sim, [], 20);
    const car = sim.cars[0]!;
    const n = harbor.gates.length;
    const events: RaceEvent[] = [];
    for (let lap = 0; lap < 2; lap++) for (let g = 0; g < n; g++) events.push(...passGate(sim, 0, g));
    expect(car.finished).toBe(false);
    events.push(...passGate(sim, 0, 0));
    expect(car.finished).toBe(true);
    expect(car.finishMs).toBe(car.cpMs);
    expect(events.find((e) => e.type === 'finish')).toMatchObject({ slot: 0, place: 1 });
    expect(sim.phase).toBe('finished');
    expect(sim.endReason).toBe('all_finished');
    // Crossing again changes nothing.
    passGate(sim, 0, 0);
    expect(sim.finishOrder).toEqual([0]);
  });

  it('orders two cars that finish in the same tick by who crossed first', () => {
    const sim = newRace(2, 1);
    stepAll(sim, [], 20);
    const n = harbor.gates.length;
    for (const car of sim.cars) {
      car.cp = n; // Due at the line to finish.
      car.lapStartMs = 1;
    }
    // Slot 1 is closer to the line than slot 0; both cross on the next tick.
    placeCar(sim, 0, harbor.length - 0.4, 2.5, 30);
    placeCar(sim, 1, harbor.length - 0.1, -2.5, 30);
    const events = stepAll(sim, [], 1);
    expect(sim.cars[0]!.finished && sim.cars[1]!.finished).toBe(true);
    expect(sim.cars[1]!.finishMs).toBeLessThan(sim.cars[0]!.finishMs);
    expect(sim.finishOrder).toEqual([1, 0]);
    expect(events.filter((e) => e.type === 'finish').map((e) => (e as { slot: number }).slot)).toEqual([1, 0]);
    const standings = sim.standings();
    expect(standings.map((s) => s.slot)).toEqual([1, 0]);
    expect(standings.map((s) => s.place)).toEqual([1, 2]);
  });

  it('ranks running cars by checkpoints, then by distance', () => {
    const sim = newRace(3, 2);
    stepAll(sim, [], 20);
    passGate(sim, 0, 0);
    passGate(sim, 1, 0);
    passGate(sim, 1, 1);
    // Slot 2 never left the grid, slot 1 passed two gates, slot 0 one.
    stepAll(sim, [], 1);
    expect(sim.cars[1]!.rank).toBe(1);
    expect(sim.cars[0]!.rank).toBe(2);
    expect(sim.cars[2]!.rank).toBe(3);
    // Same gate count: the one further along the road is ahead.
    passGate(sim, 0, 1);
    placeCar(sim, 0, harbor.gates[1]!.s + 40, 0, 0);
    placeCar(sim, 1, harbor.gates[1]!.s + 20, 0, 0);
    stepAll(sim, [], 1);
    expect(sim.cars[0]!.rank).toBe(1);
    expect(sim.cars[1]!.rank).toBe(2);
    expect(sim.cars[0]!.distance).toBeGreaterThan(sim.cars[1]!.distance);
  });

  it('classifies cars that do not finish in time behind the finishers', () => {
    const sim = new RaceSim(harbor, 1, [{ isBot: false }, { isBot: false }, { isBot: false }], { countdownTicks: 20, finishTimeoutTicks: 120 });
    stepAll(sim, [], 20);
    const n = harbor.gates.length;
    for (let g = 0; g < n; g++) passGate(sim, 0, g);
    passGate(sim, 1, 0);
    passGate(sim, 1, 1);
    passGate(sim, 0, 0);
    expect(sim.cars[0]!.finished).toBe(true);
    expect(sim.phase).toBe('racing');
    const events = stepAll(sim, [], 130);
    expect(sim.phase).toBe('finished');
    expect(sim.endReason).toBe('timeout');
    expect(events.find((e) => e.type === 'end')).toEqual({ type: 'end', reason: 'timeout' });
    const standings = sim.standings();
    expect(standings.map((s) => s.slot)).toEqual([0, 1, 2]);
    expect(standings.map((s) => s.finished)).toEqual([true, false, false]);
    expect(standings[0]!.totalMs).toBeGreaterThan(0);
    expect(standings[1]!.totalMs).toBe(0);
  });

  it('ends the race once every human has finished, without waiting for bots', () => {
    const sim = new RaceSim(harbor, 1, [{ isBot: false }, { isBot: true }], { countdownTicks: 20 });
    stepAll(sim, [], 20);
    for (let g = 0; g < harbor.gates.length; g++) passGate(sim, 0, g);
    passGate(sim, 0, 0);
    expect(sim.phase).toBe('finished');
    expect(sim.standings().map((s) => [s.slot, s.finished])).toEqual([
      [0, true],
      [1, false],
    ]);
  });

  it('keeps removed cars out of the running order', () => {
    const sim = newRace(3, 1);
    stepAll(sim, [], 20);
    passGate(sim, 2, 0);
    sim.removeCar(2);
    stepAll(sim, [], 5);
    expect(sim.cars[2]!.active).toBe(false);
    expect(sim.cars[2]!.rank).toBe(3);
    const before = [sim.cars[2]!.state.x, sim.cars[2]!.state.z];
    stepAll(sim, [null, null, input({ throttle: FULL })], 30);
    expect([sim.cars[2]!.state.x, sim.cars[2]!.state.z]).toEqual(before);
    expect(sim.standings()[2]).toMatchObject({ slot: 2, active: false, finished: false });
  });
});

describe('penalties and resets', () => {
  it('issues a power-cut penalty for lingering off the track', () => {
    const sim = newRace(1, 1);
    stepAll(sim, [], 20);
    const car = sim.cars[0]!;
    placeCar(sim, 0, 40, harbor.halfWidth + 3, 0);
    const events = stepAll(sim, [], OFFTRACK_PENALTY_AFTER - 2);
    expect(events.some((e) => e.type === 'penalty')).toBe(false);
    expect(car.state.penalty).toBe(0);
    const more = stepAll(sim, [], 5);
    expect(more.filter((e) => e.type === 'penalty')).toHaveLength(1);
    expect(car.penalties).toBe(1);
    expect(car.state.penalty).toBeGreaterThan(PENALTY_TICKS - 10);
    // The penalty expires by itself.
    placeCar(sim, 0, 40, 0, 0);
    stepAll(sim, [], PENALTY_TICKS + 5);
    expect(car.state.penalty).toBe(0);
  });

  it('does not penalise brief excursions or kerb riding', () => {
    const sim = newRace(1, 1);
    stepAll(sim, [], 20);
    const car = sim.cars[0]!;
    // Half a car over the edge is not "off track".
    placeCar(sim, 0, 40, harbor.halfWidth + 0.5, 0);
    stepAll(sim, [], OFFTRACK_PENALTY_AFTER * 2);
    expect(car.penalties).toBe(0);
    // A short trip across the grass is forgiven.
    placeCar(sim, 0, 40, harbor.halfWidth + 3, 0);
    stepAll(sim, [], SIM_HZ);
    placeCar(sim, 0, 40, 0, 0);
    stepAll(sim, [], SIM_HZ * 3);
    expect(car.penalties).toBe(0);
    expect(car.offTicks).toBe(0);
  });

  it('resets a car to its last checkpoint, at a standstill, with a cooldown', () => {
    const sim = newRace(1, 2);
    stepAll(sim, [], 20);
    const car = sim.cars[0]!;
    passGate(sim, 0, 0);
    passGate(sim, 0, 1);
    passGate(sim, 0, 2);
    const cp = car.cp;
    // Drive on, away from the gate, then ask for a reset.
    placeCar(sim, 0, harbor.gates[2]!.s + 80, 6, 25);
    const events = stepAll(sim, [input({ reset: true })], 1);
    expect(events.some((e) => e.type === 'reset')).toBe(true);
    const q = queryTrack(harbor, car.state.x, car.state.z, makeQuery());
    expect(q.s).toBeGreaterThan(harbor.gates[2]!.s);
    expect(q.s).toBeLessThan(harbor.gates[2]!.s + 30);
    expect(Math.abs(q.lat)).toBeLessThan(harbor.halfWidth);
    expect(car.tel.speed).toBe(0);
    expect(car.state.frozen).toBe(RESET_FREEZE_TICKS - 1);
    expect(car.cp).toBe(cp);
    expect(car.resets).toBe(1);
    // Held still for the freeze, and holding the button does not reset again.
    const held = stepAll(sim, [input({ reset: true, throttle: FULL })], RESET_FREEZE_TICKS + 30);
    expect(held.some((e) => e.type === 'reset')).toBe(false);
    // A fresh press during the cooldown is ignored too.
    stepAll(sim, [input()], 2);
    stepAll(sim, [input({ reset: true })], 2);
    expect(car.resets).toBe(1);
    stepAll(sim, [input()], RESET_COOLDOWN_TICKS);
    stepAll(sim, [input({ reset: true })], 1);
    expect(car.resets).toBe(2);
    // The reset itself is never credited as a gate.
    expect(car.cp).toBe(cp);
  });

  it('puts a reset car back on its grid slot before it has crossed the line', () => {
    const sim = newRace(2, 1);
    stepAll(sim, [], 20);
    const car = sim.cars[1]!;
    placeCar(sim, 1, harbor.length - 120, 0, 0);
    stepAll(sim, [null, input({ reset: true })], 1);
    const grid = harbor.grid[1]!;
    expect(Math.hypot(car.state.x - grid.x, car.state.z - grid.z)).toBeLessThan(8);
    expect(car.cp).toBe(0);
  });

  it('ignores reset requests during the countdown', () => {
    const sim = newRace(1, 1, { countdownTicks: 60 });
    const events = stepAll(sim, [input({ reset: true })], 30);
    expect(events.some((e) => e.type === 'reset')).toBe(false);
    expect(sim.cars[0]!.resets).toBe(0);
  });

  it('flags driving the wrong way', () => {
    const sim = newRace(1, 1);
    stepAll(sim, [], 20);
    passGate(sim, 0, 0);
    placeCar(sim, 0, 200, 0, 20, true);
    stepAll(sim, [], 1);
    sim.cars[0]!.state.yaw += Math.PI;
    stepAll(sim, [input({ throttle: FULL })], SIM_HZ * 2);
    expect(sim.cars[0]!.wrongWayTicks).toBeGreaterThan(SIM_HZ);
  });
});

describe('determinism', () => {
  it('replays a race with collisions bit for bit', () => {
    const run = (): number[][] => {
      const sim = new RaceSim(
        getTrack('glacier'),
        2,
        Array.from({ length: 8 }, () => ({ isBot: false })),
        { countdownTicks: 30 },
      );
      const rng = new Rng(2024);
      const trace: number[][] = [];
      for (let tick = 0; tick < SIM_HZ * 60; tick++) {
        const inputs = sim.cars.map(() =>
          input({
            steer: Math.round(rng.range(-90, 90)),
            throttle: rng.next() < 0.85 ? FULL : 0,
            brake: rng.next() < 0.05 ? FULL : 0,
            handbrake: rng.next() < 0.02,
            reset: rng.next() < 0.001,
          }),
        );
        sim.step(inputs);
        if (tick % 300 === 0) trace.push(sim.serialize());
      }
      trace.push(sim.serialize());
      return trace;
    };
    const a = run();
    const b = run();
    expect(a).toEqual(b);
    // The scenario really exercised the simulation.
    const last = a[a.length - 1]!;
    expect(last.every((v) => Number.isFinite(v))).toBe(true);
  });

  it('keeps every car inside the barriers through chaotic pile-ups', () => {
    const track = getTrack('harbor');
    const sim = new RaceSim(
      track,
      1,
      Array.from({ length: 8 }, () => ({ isBot: false })),
      { countdownTicks: 10 },
    );
    const rng = new Rng(5);
    const q = makeQuery();
    let collisions = 0;
    for (let tick = 0; tick < SIM_HZ * 40; tick++) {
      const events = sim.step(sim.cars.map(() => input({ steer: Math.round(rng.range(-127, 127)), throttle: FULL, handbrake: rng.next() < 0.05 })));
      collisions += events.filter((e) => e.type === 'collision').length;
      for (const car of sim.cars) {
        expect(queryTrack(track, car.state.x, car.state.z, q).dist).toBeLessThanOrEqual(track.wallDist + 1e-6);
        expect(Math.hypot(car.state.vx, car.state.vz)).toBeLessThan(97);
      }
    }
    expect(collisions).toBeGreaterThan(3);
  });
});

describe('practice bots', () => {
  for (const def of TRACK_DEFS) {
    it(`complete a clean race on ${def.name}`, () => {
      const track = getTrack(def.id);
      let wallHits = 0;
      const { sim, events } = runBotRace(track, 2, [0.95], { onTick: (s) => (wallHits += s.cars[0]!.tel.wallHit > 1 ? 1 : 0) });
      expect(sim.phase).toBe('finished');
      const car = sim.cars[0]!;
      expect(car.finished).toBe(true);
      expect(car.cp).toBe(track.gates.length * 2 + 1);
      // Every gate was credited exactly once, in order.
      const cps = events.filter((e) => e.type === 'checkpoint').map((e) => (e as { cp: number }).cp);
      expect(cps).toEqual(Array.from({ length: track.gates.length * 2 + 1 }, (_, i) => i + 1));
      expect(events.filter((e) => e.type === 'lap')).toHaveLength(2);
      expect(wallHits).toBe(0);
      expect(car.penalties).toBe(0);
      expect(car.resets).toBe(0);
      // A plausible pace: neither crawling nor impossibly fast.
      const average = track.length / (car.bestLapMs / 1000);
      expect(average).toBeGreaterThan(def.id === 'harbor' ? 26 : 16);
      expect(average).toBeLessThan(60);
    });
  }

  it('are faster at higher skill', () => {
    const easy = runBotRace(harbor, 1, [0.15]).sim.cars[0]!.finishMs;
    const hard = runBotRace(harbor, 1, [0.95]).sim.cars[0]!.finishMs;
    expect(hard).toBeLessThan(easy * 0.93);
  });

  it('race each other in a full field and all reach the finish', () => {
    for (const def of TRACK_DEFS) {
      const { sim, events } = runBotRace(getTrack(def.id), 1, [0.9, 0.8, 0.7, 0.6, 0.5, 0.4, 0.3, 0.2]);
      expect(sim.phase).toBe('finished');
      expect(sim.endReason).toBe('all_finished');
      expect(sim.finishOrder).toHaveLength(8);
      const standings = sim.standings();
      expect(standings.every((s) => s.finished)).toBe(true);
      // Finish times are ordered and places are 1..8.
      for (let i = 1; i < standings.length; i++) expect(standings[i]!.totalMs).toBeGreaterThanOrEqual(standings[i - 1]!.totalMs);
      expect(standings.map((s) => s.place)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
      const finishes = events.filter((e) => e.type === 'finish') as Array<{ place: number; slot: number }>;
      expect(finishes.map((e) => e.place)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
      expect(finishes.map((e) => e.slot)).toEqual(standings.map((s) => s.slot));
    }
  });

  it('recover when stuck against a barrier', () => {
    const track = getTrack('glacier');
    const { sim } = runBotRace(track, 1, [0.6], {
      onTick: (s) => {
        // Half way round, shove the bot nose-first into the wall.
        if (s.tick === 600) {
          const car = s.cars[0]!;
          car.state.yaw += Math.PI / 2;
          car.state.vx = 0;
          car.state.vz = 0;
        }
      },
    });
    expect(sim.cars[0]!.finished).toBe(true);
  });

  it('are deterministic', () => {
    const a = runBotRace(harbor, 1, [0.8, 0.6, 0.4]).sim.serialize();
    const b = runBotRace(harbor, 1, [0.8, 0.6, 0.4]).sim.serialize();
    expect(a).toEqual(b);
  });
});
