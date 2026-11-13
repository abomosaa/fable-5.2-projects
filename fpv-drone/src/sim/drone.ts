/**
 * Six-degree-of-freedom rigid-body model of the quadcopter.
 *
 * State: position, velocity (world), attitude quaternion, body angular rates,
 * four rotor speeds + induced velocities, battery charge + polarisation.
 *
 * Forces and moments every step:
 *   gravity; per-rotor thrust, H-force and shaft reaction torque; gyroscopic
 *   coupling of the spinning rotors; airframe drag (anisotropic, quadratic) and
 *   its moment; aerodynamic rate damping; ground/obstacle contact (penalty
 *   spring-damper + Coulomb friction) on a set of collision spheres.
 *
 * Newton-Euler in the body frame:
 *   m dv/dt = R F_b + F_w + m g
 *   I dw/dt = tau - w x (I w + h_rotors)
 *
 * Integrated with semi-implicit Euler at a fixed small step (see SIM_DT) with
 * an exact exponential-map update for the attitude.
 */
import {
  Vec3, Quat, vec3, quat, qRotate, qRotateInv, qIntegrate, GRAVITY, Rng, clamp,
} from './math';
import { DroneParams, DerivedParams, deriveParams } from './params';
import { Rotor } from './rotor';
import { Battery } from './battery';
import { Environment } from './environment';
import { CollisionWorld, Contact } from './world';

/**
 * Contact stiffness per kilogram of airframe [N/m per kg] and damping ratio for
 * hard surfaces. Scaling stiffness with mass gives every airframe the same
 * contact time (about 2 ms) and the same numerical margins; the damping makes
 * landings nearly dead, like a carbon frame on turf.
 */
const K_HARD = 2.7e5;
const ZETA_HARD = 1.0;
/** Foliage and other soft things. */
const K_SOFT = 2.0e4;
const ZETA_SOFT = 1.2;
const MU_FRICTION = 0.65;
const MU_SOFT = 1.2;
/** Closing speed above which a spinning prop is damaged by a strike [m/s]. */
const PROP_DAMAGE_SPEED = 3.5;

/** One sphere-vs-surface contact gathered for the current step. */
interface ActiveContact {
  sphere: number;
  nx: number; ny: number; nz: number;
  depth: number;
  soft: boolean;
  /** The sphere was not touching this kind of surface in the previous step. */
  fresh: boolean;
  /** Contact point relative to the CG, world frame. */
  rx: number; ry: number; rz: number;
}

export class Drone {
  readonly p: DroneParams;
  readonly d: DerivedParams;

  readonly pos: Vec3 = vec3();
  readonly vel: Vec3 = vec3();
  readonly q: Quat = quat();
  /** Angular velocity in the body frame [rad/s]. */
  readonly omega: Vec3 = vec3();

  readonly rotors: Rotor[];
  readonly battery: Battery;
  /** DC bus voltage at the ESCs [V]. */
  vbus: number;

  // ---- telemetry (updated every step) ----------------------------------------------
  /** Specific force in the body frame [m/s^2] - what the accelerometer reads. */
  readonly specificForce: Vec3 = vec3();
  /** Velocity relative to the air mass, body frame [m/s]. */
  readonly airVelBody: Vec3 = vec3();
  /** Wind at the vehicle, world frame [m/s]. */
  readonly wind: Vec3 = vec3();
  /** Height of the CG above the terrain [m]. */
  agl = 0;
  /** Number of collision spheres touching something. */
  contacts = 0;
  /** Largest closing speed of any contact that began during the last step [m/s]. */
  impactSpeed = 0;
  /** Whether that impact was against something soft (foliage). */
  impactSoft = false;
  /** Largest contact force in the last step [N]. */
  contactForce = 0;
  /** Props get chipped by hard strikes while spinning. */
  damageEnabled = true;
  /** Total pack current [A]. */
  packCurrent = 0;
  /** Total thrust [N]. */
  totalThrust = 0;

  private readonly rng: Rng;
  private readonly touchGround: boolean[];
  private readonly touchObject: boolean[];
  private readonly contactBuf: Contact[] = [];
  private readonly active: ActiveContact[] = [];

  // scratch
  private readonly t0 = vec3();
  private readonly t1 = vec3();
  private readonly t2 = vec3();
  private readonly fBody = vec3();
  private readonly tauBody = vec3();
  private readonly fWorld = vec3();
  private readonly tauWorld = vec3();

  constructor(p: DroneParams, seed = 42) {
    this.p = p;
    this.d = deriveParams(p);
    this.rotors = [0, 1, 2, 3].map(() => new Rotor(p, this.d));
    this.battery = new Battery(p.battery);
    this.vbus = this.battery.ocv();
    this.rng = new Rng(seed);
    this.touchGround = this.d.contactSpheres.map(() => false);
    this.touchObject = this.d.contactSpheres.map(() => false);
  }

  /** Place the drone at rest. `y` is the height of the CG. */
  reset(x: number, y: number, z: number, q?: Quat): void {
    this.pos.x = x; this.pos.y = y; this.pos.z = z;
    this.vel.x = this.vel.y = this.vel.z = 0;
    this.omega.x = this.omega.y = this.omega.z = 0;
    if (q) { this.q.w = q.w; this.q.x = q.x; this.q.y = q.y; this.q.z = q.z; }
    else { this.q.w = 1; this.q.x = this.q.y = this.q.z = 0; }
    for (const r of this.rotors) r.reset();
    this.battery.reset();
    this.vbus = this.battery.ocv();
    this.touchGround.fill(false);
    this.touchObject.fill(false);
    this.wind.x = this.wind.y = this.wind.z = 0;
    this.agl = 0;
    this.contacts = 0;
    this.impactSpeed = 0;
    this.contactForce = 0;
    this.packCurrent = 0;
    this.totalThrust = 0;
  }

  /** Height of the CG above the lowest point of the airframe when sitting level. */
  get restHeight(): number {
    let low = 0;
    for (const s of this.d.contactSpheres) low = Math.min(low, s.pos[1] - s.radius);
    return -low;
  }

  /**
   * Solve the DC bus voltage consistent with the battery's internal resistance
   * and the current all four ESCs draw at that voltage (Newton iterations on
   * V = E - R_b * I_bus(V)).
   */
  private solveBus(duty: ArrayLike<number>, driven: boolean): number {
    const bat = this.battery;
    const E = bat.emf();
    const Rb = bat.r0();
    const pav = bat.p.avionicsPower;
    let V = clamp(this.vbus, 0.3 * E, 1.3 * E);
    if (!driven) {
      // Only avionics load: V = E - Rb * pav / V  (take the high root).
      const disc = E * E - 4 * Rb * pav;
      return disc > 0 ? 0.5 * (E + Math.sqrt(disc)) : 0.5 * E;
    }
    const Imax = this.p.motor.maxCurrent;
    const kPwm = this.p.motor.pwmLoss;
    for (let it = 0; it < 4; it++) {
      let I = pav / V;
      let dI = -pav / (V * V);
      for (let i = 0; i < 4; i++) {
        const r = this.rotors[i];
        const e = r.backEmf();
        const Z = r.impedance();
        let im = (duty[i] * V - e) / Z;
        let dim = duty[i] / Z;
        // Same limiting rule as Rotor.currentFor: only driving current is limited.
        if (duty[i] >= 0) { if (im > Imax) { im = Imax; dim = 0; } }
        else if (im < -Imax) { im = -Imax; dim = 0; }
        const pw = e * im + Z * im * im;
        const ad = Math.min(Math.abs(duty[i]), 1);
        const kp = kPwm * ad * (1 - ad);
        I += pw / V + kp * V;
        dI += ((e + 2 * Z * im) * dim) / V - pw / (V * V) + kp;
      }
      const f = E - Rb * I - V;
      const df = -Rb * dI - 1;
      const step = f / df;
      V = clamp(V - step, 0.2 * E, 1.5 * E);
      if (Math.abs(step) < 1e-4) break;
    }
    return V;
  }

  /**
   * Advance the vehicle by dt.
   * @param duty   signed ESC duty per motor (-1..1), order RR, FR, RL, FL
   * @param driven ESCs active (armed). When false the motors coast.
   */
  step(dt: number, duty: ArrayLike<number>, driven: boolean, env: Environment, world: CollisionWorld | null): void {
    const d = this.d, p = this.p;
    const q = this.q, w = this.omega, v = this.vel, pos = this.pos;
    const rho = env.rho;

    // ---- air-relative velocity --------------------------------------------------
    const ground = world ? world.groundHeight(pos.x, pos.z) : -1e9;
    this.agl = pos.y - ground;
    const windRel = this.t0;
    windRel.x = v.x - this.wind.x; windRel.y = v.y - this.wind.y; windRel.z = v.z - this.wind.z;
    const airspeedPrev = Math.sqrt(windRel.x * windRel.x + windRel.y * windRel.y + windRel.z * windRel.z);
    env.step(this.wind, dt, Math.max(this.agl, 0), airspeedPrev);
    windRel.x = v.x - this.wind.x; windRel.y = v.y - this.wind.y; windRel.z = v.z - this.wind.z;
    const va = qRotateInv(this.airVelBody, q, windRel);

    // ---- electrical bus -----------------------------------------------------------
    const vbus = this.solveBus(duty, driven);
    this.vbus = vbus;

    // ---- rotors -------------------------------------------------------------------
    const fB = this.fBody, tB = this.tauBody;
    fB.x = fB.y = fB.z = 0;
    tB.x = tB.y = tB.z = 0;
    let hRot = 0;
    let busPower = p.battery.avionicsPower;
    let thrustSum = 0;

    // Body "up" axis in world (for ground-effect geometry).
    const upY = 1 - 2 * (q.x * q.x + q.z * q.z);
    const R = p.rotor.radius;
    const dAdj = 2 * p.frame.motorX;

    for (let i = 0; i < 4; i++) {
      const r = this.rotors[i];
      const rp = d.rotorPos[i];
      // Hub velocity relative to the air: v + w x r
      const hvx = va.x + (w.y * rp[2] - w.z * rp[1]);
      const hvy = va.y + (w.z * rp[0] - w.x * rp[2]);
      const hvz = va.z + (w.x * rp[1] - w.y * rp[0]);

      // Ground effect (Cheeseman-Bennett image rotor, plus the adjacent-rotor
      // image terms of Sanchez-Cuevas et al. for multirotors). Applied to the
      // induced velocity; fades with tilt and with edgewise speed.
      let ge = 1;
      if (world && upY > 0.2) {
        // Height of this hub above the ground.
        const hubY = pos.y + 2 * (q.x * q.y + q.w * q.z) * rp[0] + upY * rp[1] + 2 * (q.y * q.z - q.w * q.x) * rp[2];
        const z = Math.max(hubY - ground, 0.5 * R);
        if (z < 6 * R) {
          const z2 = 4 * z * z;
          let x = (R / (4 * z)) * (R / (4 * z));
          x += (R * R * z) / Math.pow(dAdj * dAdj + z2, 1.5);
          x += (0.5 * R * R * z) / Math.pow(2 * dAdj * dAdj + z2, 1.5);
          const vp2 = hvx * hvx + hvz * hvz;
          const vi2 = r.vi * r.vi + 0.25;
          x *= (upY * upY) / (1 + vp2 / vi2);
          ge = 1 - Math.min(x, 0.5);
        }
      }

      r.update(dt, rho, duty[i], vbus, driven, hvx, hvy, hvz, ge, this.rng);

      const fx = r.hx, fy = r.thrust, fz = r.hz;
      fB.x += fx; fB.y += fy; fB.z += fz;
      // tau += r x F
      tB.x += rp[1] * fz - rp[2] * fy;
      tB.y += rp[2] * fx - rp[0] * fz;
      tB.z += rp[0] * fy - rp[1] * fx;
      // Reaction to the torque the stator applies to the rotor.
      const spin = d.rotorSpin[i];
      tB.y -= spin * r.shaftTorque;
      hRot += spin * d.rotorInertia * r.omega;
      busPower += r.busPower;
      thrustSum += r.thrust;
    }
    this.totalThrust = thrustSum;

    // ---- battery ------------------------------------------------------------------
    const ibus = busPower / Math.max(vbus, 1);
    this.packCurrent = ibus;
    this.battery.step(ibus, vbus, dt);

    // ---- airframe drag ------------------------------------------------------------
    const speed = Math.sqrt(va.x * va.x + va.y * va.y + va.z * va.z);
    if (speed > 1e-4) {
      const k = 0.5 * rho * speed;
      const da = p.frame.dragArea;
      const dx = -k * da[0] * va.x;
      const dy = -k * da[1] * va.y;
      const dz = -k * da[2] * va.z;
      fB.x += dx; fB.y += dy; fB.z += dz;
      // Centre of pressure sits a little above the CG.
      const cy = p.frame.dragCenterY;
      tB.x += cy * dz;
      tB.z -= cy * dx;
    }
    // Aerodynamic rotational damping of the airframe itself.
    const ad = p.frame.angularDrag;
    tB.x -= ad[0] * Math.abs(w.x) * w.x * rho / 1.225;
    tB.y -= ad[1] * Math.abs(w.y) * w.y * rho / 1.225;
    tB.z -= ad[2] * Math.abs(w.z) * w.z * rho / 1.225;

    // ---- contacts -----------------------------------------------------------------
    const fW = this.fWorld, tW = this.tauWorld;
    fW.x = fW.y = fW.z = 0;
    tW.x = tW.y = tW.z = 0;
    this.contacts = 0;
    this.impactSpeed = 0;
    this.contactForce = 0;
    if (world) this.collide(world, fW, tW, dt);

    // ---- integrate ----------------------------------------------------------------
    const m = d.mass;
    // Specific force (accelerometer): all non-gravitational force per unit mass, body frame.
    const cB = qRotateInv(this.t1, q, fW);
    const sf = this.specificForce;
    sf.x = (fB.x + cB.x) / m;
    sf.y = (fB.y + cB.y) / m;
    sf.z = (fB.z + cB.z) / m;

    const fBw = qRotate(this.t1, q, fB);
    const ax = (fBw.x + fW.x) / m;
    const ay = (fBw.y + fW.y) / m - GRAVITY;
    const az = (fBw.z + fW.z) / m;

    const tC = qRotateInv(this.t2, q, tW);
    const I = d.inertia, Ii = d.invInertia;
    const Lx = I[0] * w.x, Ly = I[1] * w.y + hRot, Lz = I[2] * w.z;
    const tx = tB.x + tC.x - (w.y * Lz - w.z * Ly);
    const ty = tB.y + tC.y - (w.z * Lx - w.x * Lz);
    const tz = tB.z + tC.z - (w.x * Ly - w.y * Lx);

    w.x += tx * Ii[0] * dt;
    w.y += ty * Ii[1] * dt;
    w.z += tz * Ii[2] * dt;
    v.x += ax * dt;
    v.y += ay * dt;
    v.z += az * dt;

    qIntegrate(q, w.x, w.y, w.z, dt);
    pos.x += v.x * dt;
    pos.y += v.y * dt;
    pos.z += v.z * dt;
  }

  /**
   * Contact forces on the collision spheres (penalty method).
   *
   * Normal force: spring + damper, F = k * depth - c * v_n, never attractive.
   * The damper of each contact is sized for the effective mass the contact
   * actually sees along its normal (1/m_eff = 1/m + (r x n) . I^-1 (r x n)) and
   * shared between all contacts active in the same step; that keeps the
   * explicit integration stable whether the quad lands on one arm or sits flat
   * on all seven spheres, for every airframe size.
   *
   * Friction: Coulomb, limited so that it can stop the sliding within a step
   * but never reverse it (which is what makes things come to rest).
   */
  private collide(world: CollisionWorld, fW: Vec3, tW: Vec3, dt: number): void {
    const d = this.d, q = this.q, pos = this.pos, v = this.vel;
    const spheres = d.contactSpheres;
    // Angular velocity in world frame.
    const wW = qRotate(this.t1, q, this.omega);
    const wx = wW.x, wy = wW.y, wz = wW.z;
    const invM = 1 / d.mass;
    const Ii = d.invInertia;
    const local = this.t2;
    const buf = this.contactBuf;
    const act = this.active;
    // Body "up" axis in the world frame.
    const upX = 2 * (q.x * q.y - q.w * q.z);
    const upY = 1 - 2 * (q.x * q.x + q.z * q.z);
    const upZ = 2 * (q.y * q.z + q.w * q.x);

    // ---- pass 1: gather every contact of every sphere --------------------------------
    let n = 0;
    for (let i = 0; i < spheres.length; i++) {
      const s = spheres[i];
      local.x = s.pos[0]; local.y = s.pos[1]; local.z = s.pos[2];
      const o = qRotate(this.t0, q, local);
      const cnt = world.querySphere(pos.x + o.x, pos.y + o.y, pos.z + o.z, s.radius, buf);
      let onGround = false, onObject = false;
      for (let c = 0; c < cnt; c++) {
        const ct = buf[c];
        const a = act[n] ?? (act[n] = { sphere: 0, nx: 0, ny: 1, nz: 0, depth: 0, soft: false, fresh: false, rx: 0, ry: 0, rz: 0 });
        n++;
        a.sphere = i;
        a.nx = ct.nx; a.ny = ct.ny; a.nz = ct.nz;
        a.depth = ct.depth;
        a.soft = ct.surface === 'soft';
        // "Fresh" = this sphere was not already touching that kind of surface: a quad
        // sliding along the ground into a wall still registers the wall as an impact.
        a.fresh = ct.ground ? !this.touchGround[i] : !this.touchObject[i];
        // Contact point relative to the CG (world frame).
        a.rx = o.x - ct.nx * s.radius;
        a.ry = o.y - ct.ny * s.radius;
        a.rz = o.z - ct.nz * s.radius;
        if (ct.ground) onGround = true; else onObject = true;
      }
      this.touchGround[i] = onGround;
      this.touchObject[i] = onObject;
      if (cnt > 0) this.contacts++;
    }
    if (n === 0) return;
    const share = 1 / n;

    // ---- pass 2: forces -----------------------------------------------------------------
    for (let c = 0; c < n; c++) {
      const a = act[c];
      const rx = a.rx, ry = a.ry, rz = a.rz;
      // Velocity of the contact point.
      const vx = v.x + (wy * rz - wz * ry);
      const vy = v.y + (wz * rx - wx * rz);
      const vz = v.z + (wx * ry - wy * rx);
      const vn = vx * a.nx + vy * a.ny + vz * a.nz;
      if (a.fresh && -vn > this.impactSpeed) {
        this.impactSpeed = -vn;
        this.impactSoft = a.soft;
      }

      // Effective mass along the normal.
      local.x = ry * a.nz - rz * a.ny;
      local.y = rz * a.nx - rx * a.nz;
      local.z = rx * a.ny - ry * a.nx;
      const rb = qRotateInv(this.t0, q, local);
      const mEff = 1 / (invM + rb.x * rb.x * Ii[0] + rb.y * rb.y * Ii[1] + rb.z * rb.z * Ii[2]);

      const k = (a.soft ? K_SOFT : K_HARD) * d.mass;
      const cdamp = 2 * (a.soft ? ZETA_SOFT : ZETA_HARD) * Math.sqrt(k * mEff * share);
      const fn = k * a.depth - cdamp * vn;
      if (fn <= 0) continue;
      if (fn > this.contactForce) this.contactForce = fn;

      // Coulomb friction, capped so that it cannot reverse the slip within one step.
      const tvx = vx - vn * a.nx, tvy = vy - vn * a.ny, tvz = vz - vn * a.nz;
      const tv = Math.sqrt(tvx * tvx + tvy * tvy + tvz * tvz);
      let fx = fn * a.nx, fy = fn * a.ny, fz = fn * a.nz;
      if (tv > 1e-9) {
        const mu = a.soft ? MU_SOFT : MU_FRICTION;
        const ft = Math.min(mu * fn, (0.5 * mEff * share * tv) / dt) / tv;
        fx -= ft * tvx; fy -= ft * tvy; fz -= ft * tvz;
      }
      fW.x += fx; fW.y += fy; fW.z += fz;
      tW.x += ry * fz - rz * fy;
      tW.y += rz * fx - rx * fz;
      tW.z += rx * fy - ry * fx;

      // A spinning prop that touches something is braked hard (and, if it hits
      // fast enough, damaged). The reaction yaws the airframe - prop strikes
      // are what turn a light touch into a tumble.
      // (Contacts from below are the arm ends / landing pads, not the blades.)
      if (a.sphere < 4 && a.nx * upX + a.ny * upY + a.nz * upZ < 0.5) {
        const r = this.rotors[a.sphere];
        if (Math.abs(r.omega) > 30) {
          r.strikeTorque += 0.5 * fn * this.p.rotor.radius * 0.7;
          // Chipped / bent blades: lasting thrust loss on that corner.
          if (this.damageEnabled && a.fresh && -vn > PROP_DAMAGE_SPEED) {
            r.health = Math.max(0.35, r.health - 0.05 * (-vn - PROP_DAMAGE_SPEED));
          }
        }
      }
    }
  }

  /** Kinetic + potential energy [J] (for tests). */
  energy(): number {
    const d = this.d, v = this.vel, w = this.omega;
    return (
      0.5 * d.mass * (v.x * v.x + v.y * v.y + v.z * v.z) +
      0.5 * (d.inertia[0] * w.x * w.x + d.inertia[1] * w.y * w.y + d.inertia[2] * w.z * w.z) +
      d.mass * GRAVITY * this.pos.y
    );
  }
}
