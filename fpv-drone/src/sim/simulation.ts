/**
 * Ties the vehicle, flight controller, environment and world together and
 * advances them on a fixed time step.
 */
import { Drone } from './drone';
import { FlightController, FcConfig, RcInput, defaultFcConfig, ArmBlock } from './fc';
import { Environment, EnvSettings, DEFAULT_ENV } from './environment';
import { CollisionWorld, GateDef, crossedGate } from './world';
import { DroneParams } from './params';
import { quat, vec3, qRotate, qFromHeadingPitchRoll, GRAVITY } from './math';

/** Physics and PID-loop rate. 4 kHz matches a typical Betaflight PID loop. */
export const SIM_HZ = 4000;
export const SIM_DT = 1 / SIM_HZ;

/** Closing speed against a hard surface that breaks the quad [m/s]. */
export const CRASH_SPEED_HARD = 9;

export interface Spawn {
  x: number;
  z: number;
  /** Compass heading [rad], 0 = -Z. */
  heading: number;
}

export interface FlightStats {
  maxSpeed: number;
  maxAltitude: number;
  maxG: number;
  distance: number;
  airTime: number;
}

export interface LapState {
  nextGate: number;
  running: boolean;
  lapStart: number;
  lastLap: number;
  bestLap: number;
  laps: number;
  /** Simulation time the last gate was passed (for HUD flash). */
  lastGateTime: number;
}

export class Simulation {
  drone: Drone;
  fc: FlightController;
  env: Environment;
  world: CollisionWorld | null;
  readonly rc: RcInput = { roll: 0, pitch: 0, yaw: 0, throttle: 0 };

  time = 0;
  /** Time spent armed since reset [s]. */
  armedTime = 0;
  crashed = false;
  crashSpeed = 0;
  /** Damage model on/off. */
  damage = true;
  /** 1 = real time. */
  timeScale = 1;
  spawn: Spawn = { x: 0, z: 0, heading: 0 };
  gates: GateDef[] = [];
  readonly lap: LapState = {
    nextGate: 0, running: false, lapStart: 0, lastLap: 0, bestLap: 0, laps: 0, lastGateTime: -10,
  };
  readonly stats: FlightStats = { maxSpeed: 0, maxAltitude: 0, maxG: 0, distance: 0, airTime: 0 };
  /** Smoothed load factor [g]. */
  gLoad = 1;
  /** Last reason arming was refused. */
  armBlock: ArmBlock = '';
  /** Called when something notable happens (for audio / HUD). */
  onEvent: (e: 'crash' | 'gate' | 'lap' | 'arm' | 'disarm' | 'impact', value: number) => void = () => {};

  private acc = 0;
  private prevX = 0;
  private prevY = 0;
  private prevZ = 0;

  constructor(preset: DroneParams, env: EnvSettings = DEFAULT_ENV, world: CollisionWorld | null = null, fcCfg?: FcConfig) {
    this.drone = new Drone(preset);
    this.fc = new FlightController(fcCfg ?? defaultFcConfig(preset.tune), SIM_DT);
    this.env = new Environment(env);
    this.world = world;
    this.reset();
  }

  /** Swap the airframe (keeps rates / mode, takes the airframe's PID tune). */
  setDrone(preset: DroneParams): void {
    this.drone = new Drone(preset);
    const cfg = this.fc.cfg;
    cfg.pid = JSON.parse(JSON.stringify(preset.tune));
    this.fc = new FlightController(cfg, SIM_DT);
    this.reset();
  }

  reset(): void {
    const s = this.spawn;
    const q = qFromHeadingPitchRoll(quat(), s.heading, 0, 0);
    // Height at which the lowest collision sphere just clears the terrain (the
    // ground under the airframe need not be level).
    let y = 0;
    if (this.world) {
      y = -Infinity;
      const p = vec3(), o = vec3();
      for (const sp of this.drone.d.contactSpheres) {
        p.x = sp.pos[0]; p.y = sp.pos[1]; p.z = sp.pos[2];
        qRotate(o, q, p);
        const x = s.x + o.x, z = s.z + o.z;
        const gy = this.world.groundHeight(x, z);
        // slope makes the sphere touch before its lowest point does
        const gx = (this.world.groundHeight(x + 0.05, z) - gy) / 0.05, gz = (this.world.groundHeight(x, z + 0.05) - gy) / 0.05;
        y = Math.max(y, gy + sp.radius * Math.sqrt(1 + gx * gx + gz * gz) - o.y);
      }
    } else {
      y = this.drone.restHeight;
    }
    this.drone.reset(s.x, y + 0.002, s.z, q);
    this.drone.damageEnabled = this.damage;
    this.fc.reset();
    this.env.resetGusts();
    this.crashed = false;
    this.crashSpeed = 0;
    this.armedTime = 0;
    this.armBlock = '';
    this.gLoad = 1;
    this.acc = 0;
    this.prevX = this.drone.pos.x;
    this.prevY = this.drone.pos.y;
    this.prevZ = this.drone.pos.z;
    const l = this.lap;
    l.nextGate = 0; l.running = false; l.lapStart = 0; l.lastLap = 0; l.laps = 0; l.lastGateTime = -10;
    const st = this.stats;
    st.maxSpeed = st.maxAltitude = st.maxG = st.distance = st.airTime = 0;
  }

  arm(): boolean {
    if (this.fc.armed) return true;
    if (this.crashed) {
      this.armBlock = 'CRASHED';
      return false;
    }
    this.armBlock = this.fc.arm(this.rc, this.drone.q);
    if (this.fc.armed) this.onEvent('arm', 0);
    return this.fc.armed;
  }

  disarm(): void {
    if (!this.fc.armed) return;
    this.fc.disarm();
    this.onEvent('disarm', 0);
  }

  /** Advance by real elapsed seconds (scaled by timeScale). Returns the number of steps taken. */
  advance(realDt: number): number {
    this.acc += Math.min(realDt, 0.1) * this.timeScale;
    let n = 0;
    while (this.acc >= SIM_DT && n < 600) {
      this.stepOnce();
      this.acc -= SIM_DT;
      n++;
    }
    if (n === 600) this.acc = 0; // can't keep up: drop time rather than spiral
    return n;
  }

  /** Run exactly n fixed steps (deterministic; used by tests and tools). */
  run(n: number): void {
    for (let i = 0; i < n; i++) this.stepOnce();
  }

  stepOnce(): void {
    const dr = this.drone, fc = this.fc;
    const w = dr.omega;

    let vib = 0;
    for (let i = 0; i < 4; i++) vib += Math.abs(dr.rotors[i].omega);
    // Vibration reaching the gyro grows with rotor speed (and with damaged props).
    const wMax = (dr.p.motor.kv * 2 * Math.PI / 60) * dr.vbus * 0.7;
    let unhealth = 0;
    for (let i = 0; i < 4; i++) unhealth += 1 - dr.rotors[i].health;
    fc.vibration = Math.min(1.5, vib / (4 * wMax) + 2 * unhealth);

    fc.update(w.x, w.y, w.z, dr.q, this.rc);
    dr.damageEnabled = this.damage;
    dr.step(SIM_DT, fc.motors, fc.armed, this.env, this.world);
    this.time += SIM_DT;

    if (dr.impactSpeed > 1.0) {
      this.onEvent('impact', dr.impactSpeed);
      if (this.damage && !this.crashed && dr.impactSpeed > CRASH_SPEED_HARD && !dr.impactSoft) {
        this.crashed = true;
        this.crashSpeed = dr.impactSpeed;
        fc.disarm();
        this.onEvent('crash', dr.impactSpeed);
      }
    }

    // ---- bookkeeping --------------------------------------------------------------
    const p = dr.pos;
    const sf = dr.specificForce;
    const g = Math.sqrt(sf.x * sf.x + sf.y * sf.y + sf.z * sf.z) / GRAVITY;
    this.gLoad += (g - this.gLoad) * Math.min(1, SIM_DT / 0.05);
    if (fc.armed) {
      this.armedTime += SIM_DT;
      const st = this.stats;
      const v = dr.vel;
      const sp = Math.sqrt(v.x * v.x + v.y * v.y + v.z * v.z);
      if (sp > st.maxSpeed) st.maxSpeed = sp;
      if (dr.agl > st.maxAltitude) st.maxAltitude = dr.agl;
      if (dr.contacts === 0) {
        st.airTime += SIM_DT;
        st.distance += sp * SIM_DT;
        if (this.gLoad > st.maxG) st.maxG = this.gLoad;
      }
    }

    if (this.gates.length > 0) {
      const l = this.lap;
      const gate = this.gates[l.nextGate];
      if (crossedGate(gate, this.prevX, this.prevY, this.prevZ, p.x, p.y, p.z)) {
        l.lastGateTime = this.time;
        if (l.nextGate === 0) {
          if (l.running) {
            l.lastLap = this.time - l.lapStart;
            if (l.bestLap === 0 || l.lastLap < l.bestLap) l.bestLap = l.lastLap;
            l.laps++;
            this.onEvent('lap', l.lastLap);
          } else {
            this.onEvent('gate', 0);
          }
          l.running = true;
          l.lapStart = this.time;
        } else {
          this.onEvent('gate', l.nextGate);
        }
        l.nextGate = (l.nextGate + 1) % this.gates.length;
      }
    }
    this.prevX = p.x; this.prevY = p.y; this.prevZ = p.z;
  }
}
