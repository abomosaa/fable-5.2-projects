/**
 * Scripted project construction on top of the same authoring operations the
 * editor uses (core/model/ops.ts). Used to generate the showcase projects and
 * by tests. Ids are deterministic.
 */
import type { Anchor, Channel, Joint, MotorSpec, Part, PartKind, Pose, Project, Variant } from './types';
import { GROUND } from './types';
import { createProject, makeIdGen } from './project';
import * as ops from './ops';
import { solveAssembly } from '../assembly/solve';

export type AnchorLike = Anchor | string;
const toAnchor = (a: AnchorLike): Anchor => (typeof a === 'string' ? { port: a } : a);

export class Builder {
  project: Project;
  private gen = makeIdGen();

  constructor(name: string, id: string) {
    this.project = createProject(name, id);
    this.project.createdAt = this.project.modifiedAt = '2026-01-01T00:00:00.000Z';
  }

  part(kind: PartKind, name: string, params: Record<string, any> = {}, pose: Partial<Pose> = {}, extra: Partial<Part> = {}): string {
    const r = ops.addPart(this.project, kind, { id: this.gen('p'), name, params, pose });
    this.project = Object.keys(extra).length ? ops.updatePart(r.project, r.id, extra) : r.project;
    return r.id;
  }

  ground(id: string): this { this.project = ops.updatePart(this.project, id, { grounded: true }); return this; }

  revolute(a: string, anchorA: AnchorLike, b: string, anchorB: AnchorLike, name?: string, extra: Partial<Joint> = {}, move = false): string {
    const r = ops.mateRevolute(this.project, a, toAnchor(anchorA), b, toAnchor(anchorB), { id: this.gen('j'), name, move, extra });
    this.project = r.project; return r.id;
  }

  prismatic(a: string, anchorA: AnchorLike, b: string, anchorB: AnchorLike, name?: string, axisAngle?: number, extra: Partial<Joint> = {}, move = false): string {
    const r = ops.matePrismatic(this.project, a, toAnchor(anchorA), b, toAnchor(anchorB), { id: this.gen('j'), name, move, axisAngle, extra });
    this.project = r.project; return r.id;
  }

  rigid(a: string, anchorA: AnchorLike, b: string, anchorB: AnchorLike, name?: string, extra: Partial<Joint> = {}, move = false): string {
    const r = ops.mateRigid(this.project, a, toAnchor(anchorA), b, toAnchor(anchorB), { id: this.gen('j'), name, move, extra });
    this.project = r.project; return r.id;
  }

  gear(a: string, b: string, name?: string): string { return this.coupling('gear', a, b, name); }
  belt(a: string, b: string, name?: string, extra: Partial<Joint> = {}): string { return this.coupling('belt', a, b, name, extra); }
  rack(pinion: string, rack: string, name?: string): string { return this.coupling('rackPinion', pinion, rack, name); }
  cam(cam: string, follower: string, port = 'roller', name?: string): string { return this.coupling('cam', cam, follower, name, {}, { port }); }

  private coupling(type: 'gear' | 'belt' | 'rackPinion' | 'cam', a: string, b: string, name?: string, extra: Partial<Joint> = {}, anchorB?: Anchor): string {
    const r = ops.mateCoupling(this.project, type, a, b, { id: this.gen('j'), name, extra, anchorB });
    this.project = r.project; return r.id;
  }

  spring(a: string, anchorA: AnchorLike, b: string, anchorB: AnchorLike, name: string, stiffness: number, freeLength: number, damping = 0.5, extra: Partial<Joint> = {}): string {
    const r = ops.addSpring(this.project, a, toAnchor(anchorA), b, toAnchor(anchorB), { id: this.gen('j'), name, stiffness, freeLength, damping, extra });
    this.project = r.project; return r.id;
  }

  motor(jointId: string, spec: Partial<MotorSpec>): this {
    this.project = ops.updateJoint(this.project, jointId, { motor: { ...ops.DEFAULT_MOTOR, ...spec } });
    return this;
  }

  joint(jointId: string, patch: Partial<Joint>): this { this.project = ops.updateJoint(this.project, jointId, patch); return this; }

  torqueLoad(part: string, torque: number, name: string, extra: Partial<Project['loads'][number]> = {}): string {
    const r = ops.addLoad(this.project, { id: this.gen('l'), name, type: 'torque', part, anchor: { x: 0, y: 0 }, fx: 0, fy: 0, torque, frame: 'world', enabled: true, ...extra });
    this.project = r.project; return r.id;
  }

  forceLoad(part: string, anchor: AnchorLike, fx: number, fy: number, name: string, extra: Partial<Project['loads'][number]> = {}): string {
    const r = ops.addLoad(this.project, { id: this.gen('l'), name, type: 'force', part, anchor: toAnchor(anchor), fx, fy, torque: 0, frame: 'world', enabled: true, ...extra });
    this.project = r.project; return r.id;
  }

  probePoint(name: string, part: string, anchor: AnchorLike, trace = true, color?: string): string {
    const r = ops.addProbe(this.project, { id: this.gen('pr'), name, target: { kind: 'point', part, anchor: toAnchor(anchor) }, trace, color });
    this.project = r.project; return r.id;
  }
  probeJoint(name: string, joint: string): string {
    const r = ops.addProbe(this.project, { id: this.gen('pr'), name, target: { kind: 'joint', joint }, trace: false });
    this.project = r.project; return r.id;
  }
  probePart(name: string, part: string): string {
    const r = ops.addProbe(this.project, { id: this.gen('pr'), name, target: { kind: 'part', part }, trace: false });
    this.project = r.project; return r.id;
  }
  probeSystem(name = 'Solver'): string {
    const r = ops.addProbe(this.project, { id: this.gen('pr'), name, target: { kind: 'system' }, trace: false });
    this.project = r.project; return r.id;
  }

  plot(title: string, channels: Channel[]): this {
    this.project = { ...this.project, plots: [...this.project.plots, { id: this.gen('plot'), title, channels }] };
    return this;
  }

  variant(name: string, note: string, values: Record<string, any>): string {
    const v: Variant = { id: this.gen('v'), name, note, values };
    this.project = { ...this.project, variants: [...this.project.variants, v] };
    return v.id;
  }

  group(name: string, ids: string[]): string {
    const r = ops.groupParts(this.project, ids, name, this.gen('g'));
    this.project = r.project; return r.id;
  }

  duplicate(ids: string[], xf: Parameters<typeof ops.duplicateParts>[2]): { ids: string[]; map: Map<string, string> } {
    const r = ops.duplicateParts(this.project, ids, xf, this.gen);
    this.project = r.project; return { ids: r.ids, map: r.map };
  }

  /** run the design-time assembly solver; throws if the assembly cannot be closed */
  solve(strict = true): this {
    const r = solveAssembly(this.project);
    if (!r.ok && strict) throw new Error(`Assembly "${this.project.name}" cannot be closed: ${r.issues.filter((i) => i.severity === 'error').map((i) => i.detail).join(' | ')}`);
    if (r.ok) this.project = r.project;
    return this;
  }

  build(): Project { return this.project; }
}

export { GROUND };
