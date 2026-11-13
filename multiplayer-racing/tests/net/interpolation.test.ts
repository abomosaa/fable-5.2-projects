import { describe, expect, it } from 'vitest';
import {
  ArrivalClock,
  CarTrack,
  MAX_EXTRAPOLATION_TICKS,
  makePose,
  type CarSample,
} from '../../client/src/net/interpolation';
import { ImpairedChannel, PERFECT_NETWORK, isPerfect, parseNetConditions } from '../../shared/net/netsim';
import { SIM_HZ } from '../../shared/constants';
import { CarFlag } from '../../shared/protocol';
import { Rng } from '../../shared/sim/rng';

/** A car driving in a straight line along +x at `speed` m/s. */
function sample(tick: number, speed = 30, extra: Partial<CarSample> = {}): CarSample {
  return { tick, x: (tick / SIM_HZ) * speed, z: 0, yaw: Math.PI / 2, vx: speed, vz: 0, yawRate: 0, steer: 0, throttle: 1, brake: 0, flags: 0, ...extra };
}

describe('remote car history', () => {
  it('interpolates between the two surrounding snapshots', () => {
    const track = new CarTrack();
    track.push(sample(100));
    track.push(sample(102));
    const pose = makePose();
    expect(track.sample(101, pose)).toBe(true);
    expect(pose.x).toBeCloseTo((101 / SIM_HZ) * 30, 6);
    expect(pose.extrapolated).toBe(0);
    expect(pose.stale).toBe(false);
    track.sample(100.5, pose);
    expect(pose.x).toBeCloseTo((100.5 / SIM_HZ) * 30, 6);
  });

  it('follows curved motion smoothly using the snapshot velocities', () => {
    // A car on a circle of radius 50 at 25 m/s, sampled every 2 ticks.
    const radius = 50;
    const speed = 25;
    const omega = speed / radius;
    const at = (tick: number): CarSample => {
      const a = (tick / SIM_HZ) * omega;
      return { tick, x: Math.sin(a) * radius, z: -Math.cos(a) * radius, yaw: a + Math.PI / 2, vx: Math.cos(a) * speed, vz: Math.sin(a) * speed, yawRate: omega, steer: 0, throttle: 1, brake: 0, flags: 0 };
    };
    const track = new CarTrack();
    for (let tick = 0; tick <= 60; tick += 2) track.push(at(tick));
    const pose = makePose();
    let worst = 0;
    for (let tick = 0; tick <= 60; tick += 0.25) {
      track.sample(tick, pose);
      const truth = at(tick);
      worst = Math.max(worst, Math.hypot(pose.x - truth.x, pose.z - truth.z));
    }
    expect(worst).toBeLessThan(0.002);
  });

  it('ignores duplicates and sorts out-of-order snapshots into place', () => {
    const track = new CarTrack();
    expect(track.push(sample(10))).toBe(true);
    expect(track.push(sample(14))).toBe(true);
    expect(track.push(sample(12))).toBe(true); // Late arrival.
    expect(track.push(sample(12, 999))).toBe(false); // Duplicate: first one wins.
    expect(track.push(sample(10, 999))).toBe(false);
    expect(track.length).toBe(3);
    expect(track.newestTick).toBe(14);
    const pose = makePose();
    track.sample(11, pose);
    expect(pose.x).toBeCloseTo((11 / SIM_HZ) * 30, 6);
    track.sample(13, pose);
    expect(pose.x).toBeCloseTo((13 / SIM_HZ) * 30, 6);
  });

  it('bridges a lost snapshot by interpolating across the gap', () => {
    const track = new CarTrack();
    track.push(sample(20));
    track.push(sample(26)); // Ticks 22 and 24 were lost.
    const pose = makePose();
    track.sample(23, pose);
    expect(pose.x).toBeCloseTo((23 / SIM_HZ) * 30, 6);
    expect(pose.extrapolated).toBe(0);
  });

  it('extrapolates only briefly when data stops, then holds the car and marks it stale', () => {
    const track = new CarTrack();
    track.push(sample(98));
    track.push(sample(100));
    const pose = makePose();
    const newest = (100 / SIM_HZ) * 30;

    track.sample(100 + MAX_EXTRAPOLATION_TICKS / 2, pose);
    expect(pose.x).toBeCloseTo(newest + (MAX_EXTRAPOLATION_TICKS / 2 / SIM_HZ) * 30, 6);
    expect(pose.stale).toBe(false);
    expect(pose.extrapolated).toBe(MAX_EXTRAPOLATION_TICKS / 2);

    const limit = newest + (MAX_EXTRAPOLATION_TICKS / SIM_HZ) * 30;
    for (const ahead of [MAX_EXTRAPOLATION_TICKS + 1, 60, 600, 60_000]) {
      track.sample(100 + ahead, pose);
      expect(pose.x).toBeCloseTo(limit, 6); // Never runs away.
      expect(pose.stale).toBe(true);
    }
    // When data resumes the car is interpolated again.
    track.push(sample(160));
    track.sample(130, pose);
    expect(pose.stale).toBe(false);
    expect(pose.x).toBeCloseTo((130 / SIM_HZ) * 30, 4);
  });

  it('snaps instead of sliding across the map when a car is reset', () => {
    const track = new CarTrack();
    track.push(sample(50, 30));
    // A reset: flagged and far away.
    track.push({ ...sample(52, 0), x: 400, z: 300, flags: CarFlag.RESET_TOGGLE });
    const pose = makePose();
    track.sample(50.8, pose);
    expect(pose.x).toBeCloseTo((50 / SIM_HZ) * 30, 6);
    track.sample(51.2, pose);
    expect([pose.x, pose.z]).toEqual([400, 300]);
    // A large unflagged jump is treated the same way.
    const jump = new CarTrack();
    jump.push(sample(10));
    jump.push({ ...sample(12), x: 900 });
    jump.sample(11.4, pose);
    expect(pose.x).toBe(900);
  });

  it('keeps a bounded history', () => {
    const track = new CarTrack();
    for (let tick = 0; tick < 10_000; tick += 2) track.push(sample(tick));
    expect(track.length).toBeLessThanOrEqual(64);
    const pose = makePose();
    expect(track.sample(9_990, pose)).toBe(true);
    // Asking for the distant past yields the oldest sample kept, not garbage.
    expect(track.sample(0, pose)).toBe(true);
    expect(Number.isFinite(pose.x)).toBe(true);
  });

  it('reports no data for an empty history', () => {
    expect(new CarTrack().sample(5, makePose())).toBe(false);
  });
});

describe('snapshot arrival clock', () => {
  const tickRate = 60;
  const every = 2;
  const intervalMs = (1000 / tickRate) * every;

  it('renders a small, constant delay behind a steady stream', () => {
    const clock = new ArrivalClock(tickRate, every);
    let now = 5000;
    let tick = 300;
    for (let i = 0; i < 200; i++) {
      clock.observe(tick, now);
      now += intervalMs;
      tick += every;
    }
    const newest = tick - every;
    const render = clock.renderTick(now - intervalMs);
    // Between one and two snapshots behind: always something to interpolate towards.
    expect(newest - render).toBeGreaterThanOrEqual(every);
    expect(newest - render).toBeLessThan(every * 2 + 1.5);
    expect(clock.latenessTicks).toBeLessThan(0.1);
  });

  it('produces a monotonic render time under heavy jitter and widens the delay', () => {
    const rng = new Rng(4);
    const clock = new ArrivalClock(tickRate, every);
    const steady = new ArrivalClock(tickRate, every);
    const arrivals: Array<{ at: number; tick: number }> = [];
    for (let i = 0; i < 600; i++) {
      const sent = 1000 + i * intervalMs;
      arrivals.push({ at: sent + 60 + rng.next() * 80, tick: 100 + i * every });
      steady.observe(100 + i * every, sent + 60);
    }
    arrivals.sort((a, b) => a.at - b.at);
    let cursor = 0;
    let previous = -Infinity;
    let newest = 0;
    let starved = 0;
    let frames = 0;
    for (let now = 1100; now < 1000 + 600 * intervalMs; now += 1000 / 144) {
      while (cursor < arrivals.length && arrivals[cursor]!.at <= now) {
        const a = arrivals[cursor++]!;
        // Only the newest snapshot drives the clock, as in the client.
        if (a.tick > newest) {
          newest = a.tick;
          clock.observe(a.tick, a.at);
        }
      }
      if (!clock.ready) continue;
      const render = clock.renderTick(now);
      expect(render).toBeGreaterThanOrEqual(previous);
      previous = render;
      if (now > 4000) {
        frames++;
        if (render > newest) starved++;
      }
    }
    // The delay grew to cover the jitter, so interpolation rarely runs dry.
    expect(clock.delayTicks).toBeGreaterThan(steady.delayTicks + 2);
    expect(clock.delayTicks).toBeLessThanOrEqual(tickRate * 0.5);
    expect(starved / frames).toBeLessThan(0.05);
  });

  it('shrinks the delay again once the connection calms down', () => {
    const rng = new Rng(8);
    const clock = new ArrivalClock(tickRate, every);
    let now = 0;
    let tick = 10;
    for (let i = 0; i < 300; i++) {
      clock.observe(tick, now + rng.next() * 90);
      now += intervalMs;
      tick += every;
    }
    const jittery = clock.delayTicks;
    for (let i = 0; i < 1500; i++) {
      clock.observe(tick, now);
      now += intervalMs;
      tick += every;
    }
    expect(clock.delayTicks).toBeLessThan(jittery - 1.5);
    expect(clock.delayTicks).toBeLessThan(every * 1.5 + 1.6);
  });

  it('re-synchronises after a long stall instead of drifting', () => {
    const clock = new ArrivalClock(tickRate, every);
    let now = 0;
    let tick = 10;
    for (let i = 0; i < 100; i++) {
      clock.observe(tick, now);
      now += intervalMs;
      tick += every;
    }
    // Five seconds of nothing, while the server kept simulating.
    now += 5000;
    tick += 300;
    for (let i = 0; i < 10; i++) {
      clock.observe(tick, now);
      now += intervalMs;
      tick += every;
    }
    const behind = tick - every - clock.renderTick(now - intervalMs);
    expect(behind).toBeGreaterThan(0);
    expect(behind).toBeLessThan(tickRate * 0.5 + every);
  });
});

describe('network condition simulator', () => {
  it('delivers reliable messages in order, only delayed', () => {
    const rng = new Rng(1);
    const channel = new ImpairedChannel<number>({ latencyMs: 50, jitterMs: 80, loss: 0.5, duplicate: 0.5, reorder: 0.5 }, () => rng.next());
    for (let i = 0; i < 200; i++) channel.send(i, i, true);
    expect(channel.poll(49)).toEqual([]);
    const out: number[] = [];
    for (let now = 0; now < 1000; now += 5) out.push(...channel.poll(now));
    expect(out).toEqual(Array.from({ length: 200 }, (_, i) => i));
  });

  it('drops, duplicates and reorders unreliable messages at the configured rates', () => {
    const rng = new Rng(2);
    const channel = new ImpairedChannel<number>({ latencyMs: 20, jitterMs: 30, loss: 0.2, duplicate: 0.1, reorder: 0.1 }, () => rng.next());
    const count = 5000;
    for (let i = 0; i < count; i++) channel.send(i, i * 10, false);
    const out: number[] = [];
    for (let now = 0; now < count * 10 + 500; now += 5) out.push(...channel.poll(now));
    const unique = new Set(out);
    expect(unique.size / count).toBeGreaterThan(0.76);
    expect(unique.size / count).toBeLessThan(0.84);
    expect(out.length - unique.size).toBeGreaterThan(count * 0.05);
    let outOfOrder = 0;
    for (let i = 1; i < out.length; i++) if (out[i]! < out[i - 1]!) outOfOrder++;
    expect(outOfOrder).toBeGreaterThan(count * 0.03);
    expect(channel.dropped).toBe(count - unique.size);
    expect(channel.pending).toBe(0);
  });

  it('is transparent when conditions are perfect', () => {
    const channel = new ImpairedChannel<string>(PERFECT_NETWORK);
    channel.send('a', 10, false);
    channel.send('b', 10, true);
    expect(channel.poll(10)).toEqual(['a', 'b']);
    expect(isPerfect(PERFECT_NETWORK)).toBe(true);
  });

  it('parses condition strings and clamps silly values', () => {
    expect(parseNetConditions('latency=120,jitter=40,loss=5,dup=2,reorder=3')).toEqual({ latencyMs: 120, jitterMs: 40, loss: 0.05, duplicate: 0.02, reorder: 0.03 });
    expect(parseNetConditions('lag:80;loss:100')).toEqual({ latencyMs: 80, jitterMs: 0, loss: 0.9, duplicate: 0, reorder: 0 });
    expect(parseNetConditions('latency=-5,jitter=abc,unknown=7')).toEqual(PERFECT_NETWORK);
    expect(parseNetConditions('latency=999999').latencyMs).toBe(2000);
  });
});
