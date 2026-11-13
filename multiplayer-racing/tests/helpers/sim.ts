/** Helpers for driving the deterministic simulation in tests. */
import { BotDriver, botProfileFor } from '../../shared/sim/bot';
import { RaceSim, type RaceEvent } from '../../shared/sim/race';
import { buildTrack, pointAt, type Track, type TrackDef } from '../../shared/sim/track';
import { HARBOR } from '../../shared/sim/tracks/harbor';
import { makeCarState, makeTelemetry, stepCar, type CarInput, type CarState, type CarTelemetry } from '../../shared/sim/vehicle';

export function input(overrides: Partial<CarInput> = {}): CarInput {
  return { steer: 0, throttle: 0, brake: 0, handbrake: false, reset: false, ...overrides };
}

const pads = new Map<string, Track>();

/**
 * A huge open area with the given surface: a 6 km straight, 800 m wide, with
 * nothing to hit. Used for pure vehicle-dynamics tests.
 */
export function skidpad(surface: TrackDef['surface'] = HARBOR.surface): Track {
  const cached = pads.get(surface.name);
  if (cached) return cached;
  const points: Array<[number, number]> = [];
  const length = 6000;
  const radius = 600;
  for (let x = 0; x <= length; x += 500) points.push([x, 0]);
  for (let a = 30; a < 180; a += 30) points.push([length + Math.sin((a * Math.PI) / 180) * radius, radius - Math.cos((a * Math.PI) / 180) * radius]);
  for (let x = length; x >= 0; x -= 500) points.push([x, radius * 2]);
  for (let a = 30; a < 180; a += 30) points.push([-Math.sin((a * Math.PI) / 180) * radius, radius + Math.cos((a * Math.PI) / 180) * radius]);
  const track = buildTrack({ ...HARBOR, id: 'skidpad', points, halfWidth: 400, runoff: 5, surface });
  pads.set(surface.name, track);
  return track;
}

export interface Rig {
  track: Track;
  car: CarState;
  tel: CarTelemetry;
  step(input: CarInput, ticks?: number): void;
  /** Speed along the heading. */
  forward(): number;
  /** Speed to the left of the heading. */
  lateral(): number;
}

/** A single car on the centre line at arc length `s`, pointing along the track, optionally moving. */
export function rig(track: Track, speed = 0, s = 0): Rig {
  const spot = pointAt(track, s, 0, { x: 0, z: 0, yaw: 0 });
  const yaw = spot.yaw;
  const car = makeCarState(spot.x, spot.z, yaw);
  car.vx = Math.sin(yaw) * speed;
  car.vz = Math.cos(yaw) * speed;
  const tel = makeTelemetry();
  return {
    track,
    car,
    tel,
    step(i, ticks = 1) {
      for (let k = 0; k < ticks; k++) stepCar(car, i, track, tel);
    },
    forward: () => car.vx * Math.sin(car.yaw) + car.vz * Math.cos(car.yaw),
    lateral: () => car.vx * Math.cos(car.yaw) - car.vz * Math.sin(car.yaw),
  };
}

/** A car in the middle of the skidpad's long straight. */
export function padRig(speed = 0, surface: TrackDef['surface'] = HARBOR.surface): Rig {
  return rig(skidpad(surface), speed, 700);
}

export interface BotRun {
  sim: RaceSim;
  events: RaceEvent[];
  ticks: number;
}

/** Runs a race driven entirely by bots until it ends (or `maxTicks`). */
export function runBotRace(track: Track, laps: number, skills: number[], options: { maxTicks?: number; countdownTicks?: number; finishTimeoutTicks?: number; onTick?: (sim: RaceSim) => void } = {}): BotRun {
  const sim = new RaceSim(
    track,
    laps,
    skills.map(() => ({ isBot: true })),
    { countdownTicks: options.countdownTicks ?? 30, finishTimeoutTicks: options.finishTimeoutTicks },
  );
  const drivers = skills.map((skill, slot) => new BotDriver(track, botProfileFor(slot, skill), 1000 + slot));
  const events: RaceEvent[] = [];
  const maxTicks = options.maxTicks ?? 60 * 60 * 10;
  while (sim.phase !== 'finished' && sim.tick < maxTicks) {
    const traffic = sim.cars.filter((c) => c.active && !c.finished).map((c) => ({ slot: c.slot, s: c.tel.s, lat: c.tel.lat, speed: c.tel.speed }));
    const inputs = sim.cars.map((car, slot) => ({ ...drivers[slot]!.compute({ slot, state: car.state, s: car.tel.s, lat: car.tel.lat }, car.finished ? [] : traffic, car.finished ? 0.55 : 1) }));
    events.push(...sim.step(inputs));
    options.onTick?.(sim);
  }
  return { sim, events, ticks: sim.tick };
}

/** Places a car on the track at arc length `s`, lateral offset `lat`, moving along the track. */
export function placeCar(sim: RaceSim, slot: number, s: number, lat: number, speed: number, reverse = false): void {
  const track = sim.track;
  const car = sim.cars[slot]!;
  const n = track.n;
  let i = Math.floor((((s % track.length) + track.length) % track.length) / (track.length / n));
  i = Math.min(n - 1, Math.max(0, i));
  while (i > 0 && track.s[i]! > s) i--;
  while (i < n - 1 && track.s[i + 1]! <= s) i++;
  const tx = track.tx[i]!;
  const tz = track.tz[i]!;
  const along = s - track.s[i]!;
  const st = car.state;
  st.x = track.px[i]! + tx * along + tz * lat;
  st.z = track.pz[i]! + tz * along - tx * lat;
  st.yaw = Math.atan2(tx, tz);
  const dir = reverse ? -1 : 1;
  st.vx = tx * speed * dir;
  st.vz = tz * speed * dir;
  st.yawRate = 0;
  st.steer = 0;
  st.frozen = 0;
  // Tell the rules this is where the car "was", so the placement itself is not a movement.
  car.lastX = st.x;
  car.lastZ = st.z;
}
