/**
 * A simulation run: owns the transient state (never the design), records
 * uniformly sampled history, evaluates probes and raises runtime diagnostics.
 */
import type { Channel, Joint, Probe, Project } from '../model/types';
import { GROUND } from '../model/types';
import { compile, partPointRef, partPose, type CoordDef, type Diagnostic, type MechModel, type PointRef } from '../assembly/compile';
import { InterferenceChecker, type Interference } from '../assembly/interference';
import { anchorLocal } from '../model/project';
import type { QuantityKind } from '../units';
import { Simulation, motorSpeed } from './solver';
import { explainFailure, jointName, mobilityDiagnostics, partName } from './diagnose';

export type Provenance = 'state' | 'multiplier' | 'difference' | 'derived' | 'input';

export interface QuantityDef {
  id: string;
  label: string;
  kind: QuantityKind;
  provenance: Provenance;
  /** how the number is obtained */
  note: string;
  /** false → shown as "unavailable" with `reason` */
  available: boolean;
  reason?: string;
}

export interface Series {
  t: Float64Array;
  y: Float64Array;
  kind: QuantityKind;
  label: string;
  provenance: Provenance;
  note: string;
  available: boolean;
  reason?: string;
}

export const PROVENANCE_LABEL: Record<Provenance, string> = {
  state: 'solver state',
  multiplier: 'constraint multiplier',
  difference: 'finite difference',
  derived: 'derived',
  input: 'input',
};

const NOTE_STATE = 'Read directly from the solver state at each sample.';
const NOTE_DIFF = 'Central finite difference of the sampled solver velocity on the fixed sample grid (one-sided at the ends); no smoothing.';
const NOTE_MULT = 'Lagrange multiplier of the joint constraint: impulse over one fixed step divided by the step.';
const KIN_FORCE = 'Forces are not computed in kinematic mode (geometry only). Switch to dynamic mode.';

export interface WalkMetrics {
  /** x displacement of the reference (heaviest) body, mm */
  travel: number;
  /** integral of |sliding speed| over all loaded floor contacts, divided by the number of contacts ever loaded, mm */
  slide: number;
  /** distance swept by loaded contact points relative to the reference body (what a non-slipping gait would move), mm */
  stanceSweep: number;
  contactsNow: number;
  loadedTime: number;
  airborneTime: number;
  refPart: string | null;
  tilt: number;
}

export class SimRunner {
  readonly project: Project;
  readonly model: MechModel;
  readonly sim: Simulation;
  readonly dt: number;
  sampleEvery: number;
  readonly dof: number;
  readonly dofDriven: number;
  /** compile-time + start-up diagnostics */
  readonly staticDiagnostics: Diagnostic[];
  /** runtime diagnostics, in order of occurrence */
  events: Diagnostic[] = [];
  private eventKeys = new Set<string>();
  paused = false;
  finished = false;

  // recording
  n = 0;
  private cap = 0;
  T = new Float64Array(0);
  private Q = new Float64Array(0);
  private V = new Float64Array(0);
  private L = new Float64Array(0);
  private EFF = new Float64Array(0);
  private SPR = new Float64Array(0);
  private CAM = new Float64Array(0);
  private SYS = new Float64Array(0);
  static readonly SYS_STRIDE = 7;
  maxSamples = 40000;
  version = 0;

  readonly checker: InterferenceChecker | null;
  interferenceNow: Interference[] = [];
  private interferenceSeen = new Map<string, { first: number; maxArea: number }>();
  walk: WalkMetrics = { travel: 0, slide: 0, stanceSweep: 0, contactsNow: 0, loadedTime: 0, airborneTime: 0, refPart: null, tilt: 0 };
  private refBody = -1;
  private stallTime = new Map<string, number>();
  private satTime = new Map<string, number>();
  private backTime = new Map<string, number>();
  private camWasInContact = new Map<string, boolean>();
  private camFloat = new Map<string, { since: number; maxGap: number }>();
  private camMaxPA = new Map<string, number>();
  private dragTime = 0;
  private fnSum = 0;
  private fnCount = 0;
  private everLoaded = new Set<string>();
  stepTimeAvgMs = 0;
  stepTimeMaxMs = 0;

  constructor(project: Project, opts: { interference?: boolean } = {}) {
    this.project = project;
    this.dt = Math.max(project.sim.dt, 1e-6);
    this.model = compile(project, project.sim.mode);
    this.sim = new Simulation(this.model, this.dt);
    this.sampleEvery = Math.max(1, Math.round(1 / (Math.max(project.sim.sampleRate, 1) * this.dt)));
    const mob = mobilityDiagnostics(this.sim);
    this.dof = mob.dof; this.dofDriven = mob.dofDriven;
    this.staticDiagnostics = [...this.model.issues, ...mob.diagnostics, ...this.startupChecks()];
    const m = this.model;
    this.checker = opts.interference === false ? null : new InterferenceChecker(project, (a, b) => {
      const ra = m.partRef.get(a), rb = m.partRef.get(b);
      return !!ra && !!rb && ra.body === rb.body;
    });
    // reference body for locomotion metrics: heaviest moving body
    let best = -1;
    m.bodies.forEach((b, i) => { if (best < 0 || b.mass > m.bodies[best].mass) best = i; });
    this.refBody = best;
    this.walk.refPart = best >= 0 ? m.bodies[best].partIds[0] : null;
    this.record();
    if (this.checker) this.checkInterference(false);
    // never integrate from an inconsistent start: the diagnosis above already says what is wrong
    this.blocked = this.staticDiagnostics.some((d) => d.severity === 'error');
  }

  /** true when the designed assembly is inconsistent (open joints, roller inside the cam): stepping is refused */
  blocked = false;

  get time(): number { return this.sim.t; }
  get hasErrors(): boolean { return this.staticDiagnostics.some((d) => d.severity === 'error'); }

  private startupChecks(): Diagnostic[] {
    const out: Diagnostic[] = [];
    const { model, sim } = this;
    const project = this.project;
    // open joints at the design pose
    const rows = sim.rowResiduals();
    const bad = new Map<string, { value: number; unit: string }>();
    rows.forEach((r) => {
      const tol = r.unit === 'rad' ? 1e-5 : 1e-3;
      if (Math.abs(r.value) > tol) { const e = bad.get(r.jointId); if (!e || Math.abs(r.value) > Math.abs(e.value)) bad.set(r.jointId, { value: r.value, unit: r.unit }); }
    });
    if (bad.size) {
      const ids = [...bad.keys()];
      const parts = new Set<string>();
      for (const id of ids) { const j = project.joints.find((x) => x.id === id); if (j) { if (j.a !== GROUND) parts.add(j.a); if (j.b !== GROUND) parts.add(j.b); } }
      out.push({
        severity: 'error', code: 'assembly.open-joint',
        title: `Assembly is not closed (${ids.length} joint${ids.length > 1 ? 's' : ''})`,
        detail: `At the designed pose these joints are not satisfied: ${ids.map((id) => `${jointName(project, id)} (off by ${Math.abs(bad.get(id)!.value).toFixed(3)} ${bad.get(id)!.unit})`).join(', ')}. The simulation will not start from an inconsistent assembly. Use "Solve assembly" to pull the parts together; if that fails, the dimensions make the assembly impossible.`,
        parts: [...parts], joints: ids,
      });
    }
    if (model.mode === 'dynamic') {
      const h = this.dt;
      for (const s of model.springs) {
        const ma = s.pa.body >= 0 ? model.bodies[s.pa.body].mass : Infinity, mb = s.pb.body >= 0 ? model.bodies[s.pb.body].mass : Infinity;
        const meff = 1 / (1 / ma + 1 / mb);
        const w = Math.sqrt(s.k / meff);
        if (w * h > 1.0) {
          out.push({
            severity: 'warning', code: 'sim.stiff-spring',
            title: `${jointName(project, s.jointId)}: timestep is coarse for this spring`,
            detail: `Spring rate ${(s.k / 1000).toFixed(3)} N/mm on an effective mass of ${(meff * 1000).toFixed(2)} g oscillates at ${(w / (2 * Math.PI)).toFixed(0)} Hz; with a ${(h * 1000).toFixed(2)} ms step that is ω·h = ${(w * h).toFixed(2)} (stability limit 2, accuracy needs < 0.5). Use a timestep of ${(0.3 / w * 1000).toFixed(3)} ms or smaller, or a softer spring / heavier part.`,
            parts: [], joints: [s.jointId],
          });
        }
      }
      for (const cam of model.cams) {
        const g = sim.camRow(cam, sim.q, null);
        if (g.gap < -0.02) {
          out.push({ severity: 'error', code: 'cam.penetration', title: `${jointName(project, cam.jointId)}: roller starts inside the cam`, detail: `At the design pose the follower roller penetrates the cam surface by ${(-g.gap).toFixed(2)} mm. Use "Solve assembly" to seat the follower on the cam.`, parts: [cam.camPart, cam.followerPart], joints: [cam.jointId] });
        } else if (g.gap > 0.05) {
          out.push({ severity: 'info', code: 'cam.gap', title: `${jointName(project, cam.jointId)}: roller starts ${g.gap.toFixed(2)} mm above the cam`, detail: 'The follower is not touching the cam at the design pose; it will drop onto the cam under spring force or gravity.', parts: [cam.camPart, cam.followerPart], joints: [cam.jointId] });
        }
      }
      if (model.floorEnabled) {
        let minGap = Infinity;
        for (const fc of model.floorContacts) {
          const p = sim.pt(sim.q, fc.body, fc.x, fc.y);
          minGap = Math.min(minGap, p[1] - fc.r - model.floorY);
        }
        if (minGap < -0.05) {
          out.push({ severity: 'warning', code: 'floor.penetration', title: 'Parts start below the floor', detail: `Some geometry is ${(-minGap).toFixed(2)} mm under the floor at the design pose. It will be pushed out during the first steps. Raise the assembly or lower the floor (Simulation settings → Floor height).`, parts: [], joints: [] });
        }
      }
    }
    return out;
  }

  /** current world pose of a part (simulated state) */
  poseOf = (partId: string): { x: number; y: number; angle: number } | null => partPose(this.model, this.sim.q, partId);

  // ---------------------------------------------------------------- stepping

  /** Advance up to `steps` fixed steps. Returns the number actually taken. */
  advance(steps: number): number {
    let done = 0;
    const sim = this.sim;
    if (this.blocked) return 0;
    for (; done < steps; done++) {
      if (this.finished || this.paused) break;
      const ok = sim.step();
      if (!ok) {
        this.finished = true;
        this.raise(explainFailure(sim), 'failure');
        break;
      }
      const ms = sim.stats.stepMs;
      this.stepTimeAvgMs += (ms - this.stepTimeAvgMs) * 0.02;
      if (ms > this.stepTimeMaxMs) this.stepTimeMaxMs = ms;
      this.afterStep();
      if (sim.stepCount % this.sampleEvery === 0) {
        this.record();
        if (this.checker && (this.n % 2 === 0)) this.checkInterference(true);
      }
    }
    return done;
  }

  private raise(d: Diagnostic, key: string): void {
    if (this.eventKeys.has(key)) return;
    this.eventKeys.add(key);
    this.events.push(d);
    this.version++;
  }

  private afterStep(): void {
    const { sim, model } = this;
    const project = this.project;
    const h = this.dt, t = sim.t;
    if (model.floorEnabled) { let f = 0; for (const c of sim.contacts) if (c.fn > 0) f += c.fn; this.fnSum += f; this.fnCount++; }
    // near-singular configuration
    if (sim.stats.minPivot < 1e-7 && sim.stats.minPivotRow >= 0 && !sim.structuralDeficient.has(sim.stats.minPivotRow) && sim.mB > 0) {
      const info = sim.rowJoint(sim.stats.minPivotRow);
      const j = project.joints.find((x) => x.id === info.jointId);
      this.raise({
        severity: 'warning', code: 'sim.singular', time: t,
        title: 'Near a singular (dead-centre) configuration',
        detail: `At t = ${t.toFixed(3)} s the constraint "${j?.name ?? info.jointId}" became almost dependent on the others (conditioning ${sim.stats.minPivot.toExponential(1)}). Links are lining up: small input motion produces very large forces or indeterminate motion here. Joint forces and motor torque near this instant are unreliable.`,
        parts: j ? [j.a, j.b].filter((x) => x !== GROUND) : [], joints: [info.jointId],
      }, `singular:${info.jointId}`);
    }
    // extra rows that became dependent at run time
    for (const r of sim.deficientNow) {
      if (sim.structuralDeficient.has(r)) continue;
      const info = sim.rowJoint(r);
      const j = project.joints.find((x) => x.id === info.jointId);
      this.raise({
        severity: 'warning', code: 'sim.singular', time: t,
        title: 'Singular configuration reached',
        detail: `At t = ${t.toFixed(3)} s the constraint "${j?.name ?? info.jointId}" became dependent on the other joints (the mechanism passed through a dead-centre / change-point). Its force was set to zero for that step; the motion beyond this point may branch.`,
        parts: j ? [j.a, j.b].filter((x) => x !== GROUND) : [], joints: [info.jointId],
      }, `singular:${info.jointId}`);
    }
    if (model.mode !== 'dynamic') {
      // kinematic: limits are checks only
      for (const l of model.limits) {
        const v = sim.coordValue(l.coord, sim.q);
        if (v < l.lower - 1e-6 || v > l.upper + 1e-6) {
          this.finished = true;
          this.raise({
            severity: 'error', code: 'joint.limit-violated', time: t,
            title: `${jointName(project, l.jointId)}: travel limit exceeded`,
            detail: `In kinematic mode the motor prescribes the motion, and at t = ${t.toFixed(3)} s it pushed this joint past its ${v < l.lower ? 'lower' : 'upper'} limit. The run was stopped. Use dynamic mode to see the joint stop against its limit, or change the motor/limit.`,
            parts: [], joints: [l.jointId],
          }, `limit:${l.jointId}`);
        }
      }
      return;
    }
    // motors
    for (const m of sim.limitedMotors) {
      const sat = sim.motorSaturated.get(m.jointId);
      const target = motorSpeed(m.spec, t);
      const rate = sim.coordRate(m.coord, sim.q, sim.v);
      const stalled = sat && Math.abs(target) > 1e-9 && Math.abs(rate) < 0.05 * Math.abs(target);
      this.stallTime.set(m.jointId, stalled ? (this.stallTime.get(m.jointId) ?? 0) + h : 0);
      if (sat) this.satTime.set(m.jointId, (this.satTime.get(m.jointId) ?? 0) + h);
      const unit = m.coord.kind === 'rev' ? 'N·mm' : 'N';
      const backdriven = sat && Math.abs(target) > 1e-9 && rate * target < 0 && Math.abs(rate) > 0.05 * Math.abs(target);
      this.backTime.set(m.jointId, backdriven ? (this.backTime.get(m.jointId) ?? 0) + h : 0);
      if ((this.backTime.get(m.jointId) ?? 0) > 0.3) {
        this.raise({
          severity: 'error', code: 'motor.backdriven', time: t,
          title: `${jointName(project, m.jointId)}: load is driving the motor backwards`,
          detail: `Since t ≈ ${(t - 0.3).toFixed(2)} s the motor has been at its limit of ${((m.spec.maxTorque ?? 0) / 1000).toFixed(2)} ${unit} while turning AGAINST its commanded direction: the load overpowers it (an overhauling load). Raise the torque limit, increase the reduction ratio, or reduce the load.`,
          parts: [], joints: [m.jointId],
        }, `back:${m.jointId}`);
      }
      if ((this.stallTime.get(m.jointId) ?? 0) > 0.3) {
        this.raise({
          severity: 'error', code: 'motor.stall', time: t,
          title: `${jointName(project, m.jointId)}: motor stalled`,
          detail: `Since t ≈ ${(t - 0.3).toFixed(2)} s the motor has been at its limit of ${((m.spec.maxTorque ?? 0) / 1000).toFixed(2)} ${unit} without turning (speed ${(Math.abs(rate / target) * 100).toFixed(0)} % of target). The load needs more than the motor can give at this position — raise the limit, reduce the load, change the ratio, or check for a dead-centre/locked linkage.`,
          parts: [], joints: [m.jointId],
        }, `stall:${m.jointId}`);
      } else if ((this.satTime.get(m.jointId) ?? 0) > 0.5) {
        this.raise({
          severity: 'warning', code: 'motor.saturated', time: t,
          title: `${jointName(project, m.jointId)}: motor at its torque limit`,
          detail: `The motor has spent more than 0.5 s at its limit of ${((m.spec.maxTorque ?? 0) / 1000).toFixed(2)} ${unit}; it cannot hold the commanded speed.`,
          parts: [], joints: [m.jointId],
        }, `sat:${m.jointId}`);
      }
    }
    // limits
    for (const [id, force] of sim.limitActive) {
      this.raise({
        severity: 'info', code: 'joint.limit-hit', time: t,
        title: `${jointName(project, id)}: reached its travel limit`,
        detail: `The joint hit its ${force < 0 ? 'lower' : 'upper'} limit at t = ${t.toFixed(3)} s and is held there by the stop (inelastic).`,
        parts: [], joints: [id],
      }, `limit:${id}:${force < 0 ? 'lo' : 'hi'}`);
    }
    // cams
    for (const cs of sim.camStates) {
      const was = this.camWasInContact.get(cs.jointId) ?? false;
      if (cs.inContact) {
        this.camWasInContact.set(cs.jointId, true);
        this.camFloat.delete(cs.jointId);
        if (Number.isFinite(cs.pressureAngle)) {
          const mx = Math.max(this.camMaxPA.get(cs.jointId) ?? 0, cs.pressureAngle);
          this.camMaxPA.set(cs.jointId, mx);
          if (mx > (35 * Math.PI) / 180) {
            const cam = model.cams.find((c) => c.jointId === cs.jointId)!;
            this.raise({
              severity: 'warning', code: 'cam.pressure-angle', time: t,
              title: `${jointName(project, cs.jointId)}: high pressure angle`,
              detail: `The contact normal is more than 35° away from the follower's direction of travel (first exceeded at t = ${t.toFixed(3)} s). Side load on the guide becomes large and real followers tend to jam. Use a larger base circle or a longer rise.`,
              parts: [cam.camPart, cam.followerPart], joints: [cs.jointId],
            }, `campa:${cs.jointId}`);
          }
        }
      } else if (was && cs.gap > 0.02) {
        const f = this.camFloat.get(cs.jointId) ?? { since: t, maxGap: 0 };
        f.maxGap = Math.max(f.maxGap, cs.gap);
        this.camFloat.set(cs.jointId, f);
        if (f.maxGap > 0.05) {
          const cam = model.cams.find((c) => c.jointId === cs.jointId)!;
          this.raise({
            severity: 'warning', code: 'cam.float', time: f.since,
            title: `${jointName(project, cs.jointId)}: follower lost contact with the cam`,
            detail: `At t = ${f.since.toFixed(3)} s the roller lifted off the cam (follower "float"). The spring/gravity force is too small to give the follower the deceleration the profile demands at this speed. Increase spring preload or stiffness, lower the speed, reduce follower mass, or use a gentler profile.`,
            parts: [cam.camPart, cam.followerPart], joints: [cs.jointId],
          }, `camfloat:${cs.jointId}`);
        }
      }
    }
    // locomotion metrics
    if (model.floorEnabled && this.refBody >= 0) {
      const b = this.refBody;
      const w = this.walk;
      w.travel = sim.q[3 * b] - model.bodies[b].x0;
      w.tilt = sim.q[3 * b + 2];
      let loaded = 0, refTouch = false;
      for (const c of sim.contacts) {
        if (c.fn <= 0) continue;
        loaded++;
        this.everLoaded.add(c.key);
        w.slide += Math.abs(c.slipSpeed) * h;
        // speed of the contact point relative to the reference body (what the leg sweeps)
        const rel = c.slipSpeed - (sim.v[3 * b] - sim.v[3 * b + 2] * (c.y - sim.q[3 * b + 1]));
        w.stanceSweep += Math.abs(rel) * h;
        const ref = model.partRef.get(c.partId);
        if (ref && ref.body === b) refTouch = true;
      }
      w.contactsNow = loaded;
      if (loaded > 0) w.loadedTime += h; else w.airborneTime += h;
      this.dragTime = refTouch ? this.dragTime + h : 0;
      if (this.dragTime > 0.4 && model.motors.length > 0 && sim.contacts.some((c) => { const r = model.partRef.get(c.partId); return r && r.body !== b && c.fn > 0; }) === false) {
        this.raise({
          severity: 'warning', code: 'walk.dragging', time: t,
          title: `${partName(project, model.bodies[b].partIds[0])} is resting on the floor`,
          detail: 'The main body is lying on the floor and no leg is carrying load, so the legs cannot propel it. The legs are too short, mounted too high, or the machine has fallen over.',
          parts: [model.bodies[b].partIds[0]], joints: [],
        }, 'walk:drag');
      }
      if (Math.abs(w.tilt) > 1.0) {
        this.raise({
          severity: 'warning', code: 'walk.tipped', time: t,
          title: 'The machine tipped over',
          detail: `The main body has rotated ${(Math.abs(w.tilt) * 180 / Math.PI).toFixed(0)}° from its starting attitude at t = ${t.toFixed(2)} s. Its centre of mass left the support of the feet: widen the stance, lower the body, slow down, or re-phase the legs so that feet at both ends are down together.`,
          parts: [model.bodies[b].partIds[0]], joints: [],
        }, 'walk:tipped');
      }
    }
  }

  /** summary diagnostic of locomotion so far (null when not applicable) */
  walkSummary(): Diagnostic | null {
    const { model, sim } = this;
    if (!model.floorEnabled || this.refBody < 0 || sim.t < 0.5) return null;
    const w = this.walk;
    const nC = Math.max(this.everLoaded.size, 1);
    const slidePer = w.slide / nC;
    const sweepPer = w.stanceSweep / nC;
    const slip = sweepPer > 1e-6 ? Math.min(1, slidePer / sweepPer) : 0;
    const speed = w.travel / sim.t;
    const driven = model.motors.length > 0;
    let severity: Diagnostic['severity'] = 'info';
    const vNow = this.refBody >= 0 ? sim.v[3 * this.refBody] : 0;
    let verdict = Math.abs(speed) < 0.5 && Math.abs(vNow) < 0.5 ? 'At rest on the floor'
      : `Moving ${speed >= 0 ? '+X' : '−X'} at ${Math.abs(speed).toFixed(1)} mm/s`;
    if (!driven && Math.abs(speed) >= 0.5) verdict += ' — no motor is driving it (moved by loads, gravity or initial conditions)';
    if (driven && sim.t > 1.5) {
      if (slip > 0.5) { severity = 'warning'; verdict = `Mostly slipping (${(slip * 100).toFixed(0)} % of foot motion is sliding)`; }
      else if (Math.abs(w.travel) < 0.1 * w.stanceSweep / nC && sweepPer > 5) { severity = 'warning'; verdict = 'Feet are moving but the body is not advancing'; }
      else if (slip > 0.2) verdict += ` with noticeable slip (${(slip * 100).toFixed(0)} %)`;
    }
    return {
      severity, code: 'walk.summary', time: sim.t,
      title: `Locomotion: ${verdict}`,
      detail: `Body travel ${w.travel.toFixed(1)} mm in ${sim.t.toFixed(2)} s (${speed.toFixed(1)} mm/s). Loaded feet slid ${slidePer.toFixed(1)} mm on average while sweeping ${sweepPer.toFixed(1)} mm relative to the body → slip ratio ${(slip * 100).toFixed(0)} %. ${w.contactsNow} contact(s) loaded now; airborne ${(100 * w.airborneTime / Math.max(sim.t, 1e-9)).toFixed(0)} % of the time; body tilt ${(w.tilt * 180 / Math.PI).toFixed(1)}°. Floor friction μ = ${this.project.sim.floor.friction}.`,
      parts: w.refPart ? [w.refPart] : [], joints: [],
    };
  }

  private checkInterference(movingOnly: boolean): void {
    if (!this.checker) return;
    const list = this.checker.check(this.poseOf, movingOnly);
    this.interferenceNow = movingOnly ? [...list, ...this.interferenceNow.filter((i) => this.sameBody(i.a, i.b))] : list;
    const project = this.project;
    for (const i of list) {
      const key = i.a < i.b ? `${i.a}|${i.b}` : `${i.b}|${i.a}`;
      const seen = this.interferenceSeen.get(key);
      if (seen) { if (i.area > seen.maxArea) seen.maxArea = i.area; continue; }
      this.interferenceSeen.set(key, { first: this.sim.t, maxArea: i.area });
      const atStart = this.sim.stepCount === 0;
      this.raise({
        severity: 'error', code: atStart ? 'interference.static' : 'interference.motion', time: this.sim.t,
        title: `Interference: ${partName(project, i.a)} ↔ ${partName(project, i.b)}`,
        detail: `${atStart ? 'At the designed pose' : `At t = ${this.sim.t.toFixed(3)} s`} these parts occupy the same space: their profiles overlap by ${Number.isFinite(i.area) ? `${i.area.toFixed(2)} mm²` : 'a non-zero area'} near (${i.x.toFixed(1)}, ${i.y.toFixed(1)}) mm over ${i.zOverlap.toFixed(2)} mm of thickness. Parts are not stopped by each other in this simulation — interference is reported so you can fix it: move one part to another Z layer, shorten it, or change the geometry.`,
        parts: [i.a, i.b], joints: [],
      }, `interf:${key}`);
      if (project.sim.stopOnInterference && !atStart) this.paused = true;
    }
  }

  private sameBody(a: string, b: string): boolean {
    const ra = this.model.partRef.get(a), rb = this.model.partRef.get(b);
    return !!ra && !!rb && ra.body === rb.body;
  }

  /** all diagnostics for display: static, runtime events, live locomotion summary */
  allDiagnostics(): Diagnostic[] {
    const w = this.walkSummary();
    return [...this.staticDiagnostics, ...this.events, ...(w ? [w] : [])];
  }

  // ---------------------------------------------------------------- recording

  private grow(): void {
    const cap = this.cap === 0 ? 512 : this.cap * 2;
    const g = (a: Float64Array, stride: number) => { const b = new Float64Array(cap * stride); b.set(a.subarray(0, this.n * stride)); return b; };
    const { sim, model } = this;
    this.T = g(this.T, 1);
    this.Q = g(this.Q, sim.n); this.V = g(this.V, sim.n);
    this.L = g(this.L, sim.mB);
    this.EFF = g(this.EFF, model.motors.length);
    this.SPR = g(this.SPR, 2 * model.springs.length);
    this.CAM = g(this.CAM, 3 * model.cams.length);
    this.SYS = g(this.SYS, SimRunner.SYS_STRIDE);
    this.cap = cap;
  }

  private decimate(): void {
    const { sim, model } = this;
    const half = Math.floor(this.n / 2);
    const d = (a: Float64Array, stride: number) => { for (let i = 0; i < half; i++) a.copyWithin(i * stride, 2 * i * stride, 2 * i * stride + stride); };
    d(this.T, 1); d(this.Q, sim.n); d(this.V, sim.n); d(this.L, sim.mB); d(this.EFF, model.motors.length);
    d(this.SPR, 2 * model.springs.length); d(this.CAM, 3 * model.cams.length); d(this.SYS, SimRunner.SYS_STRIDE);
    this.n = half;
    this.sampleEvery *= 2;
  }

  private record(): void {
    const { sim, model } = this;
    if (this.n >= this.maxSamples) this.decimate();
    if (this.n >= this.cap) this.grow();
    const i = this.n;
    this.T[i] = sim.t;
    this.Q.set(sim.q, i * sim.n);
    this.V.set(sim.v, i * sim.n);
    this.L.set(sim.lambda, i * sim.mB);
    model.motors.forEach((m, k) => { this.EFF[i * model.motors.length + k] = sim.motorEffort.get(m.jointId) ?? 0; });
    model.springs.forEach((s, k) => {
      const f = sim.springForce(s.jointId)!;
      this.SPR[i * 2 * model.springs.length + 2 * k] = f.tension;
      this.SPR[i * 2 * model.springs.length + 2 * k + 1] = f.length;
    });
    model.cams.forEach((c, k) => {
      const st = sim.camStates.find((x) => x.jointId === c.jointId);
      const o = i * 3 * model.cams.length + 3 * k;
      if (st) { this.CAM[o] = st.gap; this.CAM[o + 1] = st.force; this.CAM[o + 2] = st.pressureAngle; }
      else { this.CAM[o] = sim.camRow(c, sim.q, null).gap; this.CAM[o + 1] = 0; this.CAM[o + 2] = NaN; }
    });
    const o = i * SimRunner.SYS_STRIDE;
    this.SYS[o] = sim.kineticEnergy();
    this.SYS[o + 1] = sim.potentialEnergy();
    this.SYS[o + 2] = sim.stats.posError;
    let fn = 0, loaded = 0;
    for (const c of sim.contacts) { if (c.fn > 0) { fn += c.fn; loaded++; } }
    this.SYS[o + 3] = loaded;
    // contact forces are impulsive at foot strikes: record the mean over the sample interval, not one step
    this.SYS[o + 4] = this.fnCount > 0 ? this.fnSum / this.fnCount : fn;
    this.fnSum = 0; this.fnCount = 0;
    this.SYS[o + 5] = sim.stats.driftBefore;
    this.SYS[o + 6] = sim.stats.angError;
    this.n++;
    this.version++;
  }

  /** recorded body state at sample i as a view (x, y, θ per body) */
  qAt(i: number): Float64Array { return this.Q.subarray(i * this.sim.n, (i + 1) * this.sim.n); }
  vAt(i: number): Float64Array { return this.V.subarray(i * this.sim.n, (i + 1) * this.sim.n); }

  /** world path of a part-local point over the recorded history (for traces) */
  tracePoint(partId: string, lx: number, ly: number, from = 0): Float64Array {
    const ref = partPointRef(this.model, partId, lx, ly);
    const out = new Float64Array(Math.max(0, this.n - from) * 2);
    if (!ref) return out;
    for (let i = from; i < this.n; i++) {
      const p = this.sim.pt(this.qAt(i), ref.body, ref.x, ref.y);
      out[2 * (i - from)] = p[0]; out[2 * (i - from) + 1] = p[1];
    }
    return out;
  }

  // ---------------------------------------------------------------- probes

  quantities(probe: Probe): QuantityDef[] {
    return quantitiesFor(this.project, probe, this.model);
  }

  private differentiate(y: Float64Array): Float64Array {
    const n = this.n, T = this.T;
    const d = new Float64Array(n);
    if (n < 2) return d;
    for (let i = 1; i < n - 1; i++) d[i] = (y[i + 1] - y[i - 1]) / (T[i + 1] - T[i - 1]);
    d[0] = (y[1] - y[0]) / (T[1] - T[0]);
    d[n - 1] = (y[n - 1] - y[n - 2]) / (T[n - 1] - T[n - 2]);
    return d;
  }

  series(channel: Channel): Series {
    const probe = this.project.probes.find((p) => p.id === channel.probe);
    const n = this.n;
    const t = this.T.subarray(0, n);
    const empty = (reason: string, label = channel.quantity, kind: QuantityKind = 'ratio'): Series => ({ t, y: new Float64Array(n).fill(NaN), kind, label, provenance: 'derived', note: '', available: false, reason });
    if (!probe) return empty('Probe not found');
    const def = this.quantities(probe).find((q) => q.id === channel.quantity);
    if (!def) return empty('Quantity not offered by this probe');
    const base = { t, kind: def.kind, label: `${probe.name} · ${def.label}`, provenance: def.provenance, note: def.note };
    if (!def.available) return { ...base, y: new Float64Array(n).fill(NaN), available: false, reason: def.reason };
    const y = new Float64Array(n);
    const { sim, model } = this;
    const q = channel.quantity;
    const tg = probe.target;
    if (tg.kind === 'point' || tg.kind === 'part') {
      let ref: PointRef | null;
      let la = 0;
      if (tg.kind === 'point') {
        const l = anchorLocal(this.project, tg.part, tg.anchor);
        ref = partPointRef(model, tg.part, l.x, l.y);
      } else ref = partPointRef(model, tg.part, 0, 0);
      const pr = model.partRef.get(tg.part);
      if (!ref || !pr) return { ...base, y: y.fill(NaN), available: false, reason: 'Part is missing or suppressed' };
      la = pr.la;
      const b = ref.body;
      const vel = (comp: 0 | 1) => { for (let i = 0; i < n; i++) y[i] = sim.ptVel(this.qAt(i), this.vAt(i), b, ref!.x, ref!.y)[comp]; return y; };
      switch (q) {
        case 'x': case 'y': { const c = q === 'x' ? 0 : 1; for (let i = 0; i < n; i++) y[i] = sim.pt(this.qAt(i), b, ref.x, ref.y)[c]; break; }
        case 'vx': vel(0); break;
        case 'vy': vel(1); break;
        case 'speed': for (let i = 0; i < n; i++) { const v = sim.ptVel(this.qAt(i), this.vAt(i), b, ref.x, ref.y); y[i] = Math.hypot(v[0], v[1]); } break;
        case 'ax': return { ...base, y: this.differentiate(vel(0)), available: true };
        case 'ay': return { ...base, y: this.differentiate(vel(1)), available: true };
        case 'accel': {
          const ax = this.differentiate(vel(0).slice()), ay = this.differentiate(vel(1).slice());
          for (let i = 0; i < n; i++) y[i] = Math.hypot(ax[i], ay[i]);
          break;
        }
        case 'angle': for (let i = 0; i < n; i++) y[i] = (b >= 0 ? this.Q[i * sim.n + 3 * b + 2] : 0) + la; break;
        case 'omega': for (let i = 0; i < n; i++) y[i] = b >= 0 ? this.V[i * sim.n + 3 * b + 2] : 0; break;
        case 'alpha': { for (let i = 0; i < n; i++) y[i] = b >= 0 ? this.V[i * sim.n + 3 * b + 2] : 0; return { ...base, y: this.differentiate(y), available: true }; }
      }
      return { ...base, y, available: true };
    }
    if (tg.kind === 'system') {
      const S = this.SYS, st = SimRunner.SYS_STRIDE;
      const col: Record<string, number> = { kinetic: 0, potential: 1, posError: 2, contacts: 3, normalForce: 4, drift: 5, angError: 6 };
      if (q === 'energy') for (let i = 0; i < n; i++) y[i] = S[i * st] + S[i * st + 1];
      else for (let i = 0; i < n; i++) y[i] = S[i * st + col[q]];
      return { ...base, y, available: true };
    }
    // joint probes
    const j = this.project.joints.find((x) => x.id === tg.joint)!;
    const coord = model.coords.get(j.id);
    const coordSeries = (c: CoordDef) => { for (let i = 0; i < n; i++) y[i] = sim.coordValue(c, this.qAt(i)); return y; };
    const rateSeries = (c: CoordDef, out: Float64Array) => { for (let i = 0; i < n; i++) out[i] = sim.coordRate(c, this.qAt(i), this.vAt(i)); return out; };
    const mIdx = model.motors.findIndex((m) => m.jointId === j.id);
    const nM = model.motors.length;
    const con = model.cons.find((c) => c.jointId === j.id);
    switch (q) {
      case 'coord': coordSeries(coord!); break;
      case 'rate': rateSeries(coord!, y); break;
      case 'accel': rateSeries(coord!, y); return { ...base, y: this.differentiate(y), available: true };
      case 'torque': for (let i = 0; i < n; i++) y[i] = this.EFF[i * nM + mIdx]; break;
      case 'power': { const r = rateSeries(coord!, new Float64Array(n)); for (let i = 0; i < n; i++) y[i] = this.EFF[i * nM + mIdx] * r[i]; break; }
      case 'reaction': for (let i = 0; i < n; i++) y[i] = con!.kind === 'rev' ? Math.hypot(this.L[i * sim.mB + con!.row], this.L[i * sim.mB + con!.row + 1]) : Math.abs(this.L[i * sim.mB + con!.row]); break;
      case 'reactionX': for (let i = 0; i < n; i++) y[i] = this.L[i * sim.mB + con!.row]; break;
      case 'reactionY': for (let i = 0; i < n; i++) y[i] = this.L[i * sim.mB + con!.row + 1]; break;
      case 'reactionMoment': for (let i = 0; i < n; i++) y[i] = this.L[i * sim.mB + con!.row + 1]; break;
      case 'toothForce': for (let i = 0; i < n; i++) y[i] = this.L[i * sim.mB + con!.row]; break;
      case 'ratio': {
        // measured speed ratio ω_B / ω_A of the two coupled parts
        const ra = model.partRef.get(j.a), rb = model.partRef.get(j.b);
        for (let i = 0; i < n; i++) {
          const wa = ra && ra.body >= 0 ? this.V[i * sim.n + 3 * ra.body + 2] : 0, wb = rb && rb.body >= 0 ? this.V[i * sim.n + 3 * rb.body + 2] : 0;
          y[i] = Math.abs(wa) > 1e-9 ? wb / wa : NaN;
        }
        break;
      }
      case 'length': case 'force': {
        const k = model.springs.findIndex((s) => s.jointId === j.id), nS = model.springs.length;
        for (let i = 0; i < n; i++) y[i] = this.SPR[i * 2 * nS + 2 * k + (q === 'length' ? 1 : 0)];
        break;
      }
      case 'gap': case 'contactForce': case 'pressureAngle': {
        const k = model.cams.findIndex((c) => c.jointId === j.id), nC = model.cams.length;
        const off = q === 'gap' ? 0 : q === 'contactForce' ? 1 : 2;
        for (let i = 0; i < n; i++) y[i] = this.CAM[i * 3 * nC + 3 * k + off];
        break;
      }
    }
    return { ...base, y, available: true };
  }

  /** CSV of the given channels on the common sample grid (display units given by `conv`). */
  csv(channels: Channel[], conv: (value: number, kind: QuantityKind) => { v: number; unit: string }): string {
    const ss = channels.map((c) => this.series(c));
    const lines: string[] = [];
    lines.push(`# Mechanism Workshop measurement export`);
    lines.push(`# project: ${this.project.name}`);
    lines.push(`# mode: ${this.model.mode}; fixed timestep: ${this.dt} s; sample interval: ${(this.sampleEvery * this.dt).toPrecision(6)} s; samples: ${this.n}`);
    ss.forEach((s, i) => lines.push(`# column ${i + 2}: ${s.label} — ${s.available ? `${PROVENANCE_LABEL[s.provenance]}. ${s.note}` : `UNAVAILABLE: ${s.reason}`}`));
    const q = (x: string) => (/[",\n]/.test(x) ? `"${x.replace(/"/g, '""')}"` : x);
    lines.push(['time [s]', ...ss.map((s) => q(`${s.label} [${conv(1, s.kind).unit || '-'}]`))].join(','));
    for (let i = 0; i < this.n; i++) {
      const row = [this.T[i].toFixed(6)];
      for (const s of ss) row.push(s.available && Number.isFinite(s.y[i]) ? conv(s.y[i], s.kind).v.toPrecision(8) : '');
      lines.push(row.join(','));
    }
    return lines.join('\n') + '\n';
  }
}

/** Quantities a probe can report, with provenance and availability in the current mode. */
export function quantitiesFor(project: Project, probe: Probe, model?: MechModel): QuantityDef[] {
  const dyn = (model?.mode ?? project.sim.mode) === 'dynamic';
  const st = (id: string, label: string, kind: QuantityKind): QuantityDef => ({ id, label, kind, provenance: 'state', note: NOTE_STATE, available: true });
  const df = (id: string, label: string, kind: QuantityKind): QuantityDef => ({ id, label, kind, provenance: 'difference', note: NOTE_DIFF, available: true });
  const force = (id: string, label: string, kind: QuantityKind, note = NOTE_MULT, prov: Provenance = 'multiplier'): QuantityDef =>
    dyn ? { id, label, kind, provenance: prov, note, available: true } : { id, label, kind, provenance: prov, note, available: false, reason: KIN_FORCE };
  const tg = probe.target;
  if (tg.kind === 'point') {
    return [st('x', 'X position', 'length'), st('y', 'Y position', 'length'), st('speed', 'Speed', 'speed'), st('vx', 'X velocity', 'speed'), st('vy', 'Y velocity', 'speed'),
      df('accel', 'Acceleration magnitude', 'acceleration'), df('ax', 'X acceleration', 'acceleration'), df('ay', 'Y acceleration', 'acceleration')];
  }
  if (tg.kind === 'part') {
    return [st('angle', 'Angle', 'angle'), st('omega', 'Angular velocity', 'angularSpeed'), df('alpha', 'Angular acceleration', 'angularAcceleration'), st('x', 'Origin X', 'length'), st('y', 'Origin Y', 'length')];
  }
  if (tg.kind === 'system') {
    const e = (id: string, label: string): QuantityDef => dyn ? { id, label, kind: 'energy', provenance: 'derived', note: 'Computed from the solver state (masses, velocities, heights, spring lengths).', available: true } : { id, label, kind: 'energy', provenance: 'derived', note: '', available: false, reason: 'Energies are meaningful only in dynamic mode.' };
    return [
      e('kinetic', 'Kinetic energy'), e('potential', 'Potential energy'), e('energy', 'Total mechanical energy'),
      { id: 'posError', label: 'Joint position error (after projection)', kind: 'length', provenance: 'state', note: 'Largest residual of any positional joint constraint after each step.', available: true },
      { id: 'drift', label: 'Joint drift before projection', kind: 'length', provenance: 'state', note: 'Largest positional constraint residual produced by one step before the projection removes it.', available: true },
      { id: 'angError', label: 'Joint angular error', kind: 'angle', provenance: 'state', note: 'Largest residual of any angular joint constraint after each step.', available: true },
      force('contacts', 'Loaded floor contacts', 'count', 'Number of floor contact points carrying load.', 'state'),
      force('normalForce', 'Total floor normal force', 'force', 'Sum of the floor contact multipliers, averaged over each sample interval (contact is impulsive at foot strikes).'),
    ];
  }
  const j: Joint | undefined = project.joints.find((x) => x.id === tg.joint);
  if (!j) return [];
  const merged = (id: string, label: string, kind: QuantityKind): QuantityDef => ({ id, label, kind, provenance: 'multiplier', note: NOTE_MULT, available: false, reason: 'Rigidly attached parts are merged into one body; the internal force of a rigid joint is not computed.' });
  const hasCoord = model ? model.coords.has(j.id) : true;
  const noCoord = (qd: QuantityDef): QuantityDef => (hasCoord ? qd : { ...qd, available: false, reason: 'This joint is inactive in the compiled model (see diagnostics).' });
  switch (j.type) {
    case 'revolute': {
      const out = [noCoord(st('coord', 'Angle (from design pose)', 'angle')), noCoord(st('rate', 'Angular velocity', 'angularSpeed')), noCoord(df('accel', 'Angular acceleration', 'angularAcceleration')),
        noCoord(force('reaction', 'Reaction force magnitude', 'force')), noCoord(force('reactionX', 'Reaction X (on part B)', 'force')), noCoord(force('reactionY', 'Reaction Y (on part B)', 'force'))];
      if (j.motor?.enabled) {
        const hasMotor = model ? model.motors.some((m) => m.jointId === j.id) : true;
        const mk = (qd: QuantityDef): QuantityDef => (hasMotor ? qd : { ...qd, available: false, reason: 'Motor is inactive in the compiled model.' });
        out.push(mk(force('torque', 'Motor torque', 'torque', 'Multiplier of the motor row (ideal motor: constraint torque; limited motor: bounded row).')),
          mk(force('power', 'Motor power', 'power', 'Motor torque × joint angular velocity.', 'derived')));
      }
      return out;
    }
    case 'prismatic': {
      const out = [noCoord(st('coord', 'Displacement (from design pose)', 'length')), noCoord(st('rate', 'Velocity', 'speed')), noCoord(df('accel', 'Acceleration', 'acceleration')),
        noCoord(force('reaction', 'Guide normal force', 'force')), noCoord(force('reactionMoment', 'Guide moment', 'torque'))];
      if (j.motor?.enabled) out.push(force('torque', 'Actuator force', 'force'), force('power', 'Actuator power', 'power', 'Actuator force × sliding velocity.', 'derived'));
      return out;
    }
    case 'rigid': return [merged('reaction', 'Reaction force', 'force')];
    case 'gear': case 'rackPinion':
      return [force('toothForce', 'Tangential tooth force (ideal mesh)', 'force', 'Multiplier of the ideal rolling constraint at the pitch point; not a tooth-contact stress.'), { id: 'ratio', label: 'Speed ratio ω_B / ω_A', kind: 'ratio', provenance: 'state', note: 'Ratio of the two parts\' absolute angular velocities from the solver state.', available: j.type === 'gear' }];
    case 'belt':
      return [force('toothForce', 'Effective belt pull (T₁ − T₂, ideal belt)', 'force', 'Multiplier of the ideal inextensible, non-slipping belt constraint.'), { id: 'ratio', label: 'Speed ratio ω_B / ω_A', kind: 'ratio', provenance: 'state', note: 'Ratio of the two pulleys\' absolute angular velocities from the solver state.', available: true }];
    case 'cam':
      return [{ id: 'gap', label: 'Roller–cam gap', kind: 'length', provenance: 'state', note: 'Normal distance between roller surface and cam surface from the solver state and the cam profile.', available: true },
        force('contactForce', 'Contact normal force', 'force', 'Multiplier of the unilateral cam contact row.'),
        { id: 'pressureAngle', label: 'Pressure angle', kind: 'angle', provenance: 'derived', note: 'Angle between the contact normal and the follower\'s direction of travel.', available: true }];
    case 'spring':
      return [dyn ? st('length', 'Length', 'length') : { ...st('length', 'Length', 'length'), available: false, reason: 'Springs are not evaluated in kinematic mode.' },
        force('force', 'Spring force (tension +)', 'force', 'k·(L − L₀) + c·dL/dt from the solver state.', 'derived')];
  }
  return [];
}

/** default quantity to plot for a new probe */
export function defaultQuantity(project: Project, probe: Probe): string {
  const tg = probe.target;
  if (tg.kind === 'point') return 'y';
  if (tg.kind === 'part') return 'angle';
  if (tg.kind === 'system') return 'posError';
  const j = project.joints.find((x) => x.id === tg.joint);
  if (!j) return 'coord';
  if (j.motor?.enabled) return 'torque';
  return ({ revolute: 'coord', prismatic: 'coord', rigid: 'reaction', gear: 'toothForce', rackPinion: 'toothForce', belt: 'toothForce', cam: 'contactForce', spring: 'force' } as Record<string, string>)[j.type];
}
