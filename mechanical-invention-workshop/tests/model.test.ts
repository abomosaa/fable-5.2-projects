import { beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { EXAMPLES } from '../src/examples';
import { normalizeProject, serializeProject, createProject } from '../src/core/model/project';
import * as ops from '../src/core/model/ops';
import { Builder, GROUND } from '../src/core/model/builder';
import { SimRunner } from '../src/core/sim/runner';
import { applyPoseEdit, jointGaps, solveAssembly } from '../src/core/assembly/solve';
import { initKernel } from '../src/core/geom/kernel';
import { makeIdGen } from '../src/core/model/project';
import { RPM } from '../src/core/units';
import type { Project } from '../src/core/model/types';

beforeAll(async () => { await initKernel(); });

// in-memory localStorage so the real persistence module and store can be exercised in Node
const mem = new Map<string, string>();
(globalThis as any).localStorage = { getItem: (k: string) => (mem.has(k) ? mem.get(k)! : null), setItem: (k: string, v: string) => { mem.set(k, String(v)); }, removeItem: (k: string) => { mem.delete(k); }, clear: () => mem.clear(), key: (i: number) => [...mem.keys()][i] ?? null, get length() { return mem.size; } };

function fourBar() {
  const b = new Builder('Four-bar', 'p1');
  const c = b.part('link', 'Crank', { length: 30 }, { angle: Math.PI / 2 });
  const k = b.part('link', 'Coupler', { length: 90 }, { x: 0, y: 30, angle: 0.3, z: 5 });
  const r = b.part('link', 'Rocker', { length: 70 }, { x: 100, y: 0, angle: Math.PI / 2 });
  const j = b.revolute(GROUND, { x: 0, y: 0 }, c, 'A', 'O2');
  b.revolute(c, 'B', k, 'A', 'A'); b.revolute(k, 'B', r, 'B', 'B'); b.revolute(GROUND, { x: 100, y: 0 }, r, 'A', 'O4');
  b.motor(j, { speed: 60 * RPM, maxTorque: null });
  b.probePoint('Tip', k, 'B');
  return { p: b.solve().build(), c, k, r, j };
}

describe('persistence', () => {
  it('serialise → parse → normalise is lossless, including unlimited motor torque (null) and nested params', () => {
    for (const ex of EXAMPLES) {
      const p = ex.build();
      const back = normalizeProject(JSON.parse(serializeProject(p)));
      expect(back).toEqual(p);
      expect(serializeProject(back)).toBe(serializeProject(p));
    }
  });
  it('the shipped example files are what the builders produce (ordinary project files, no hidden state)', () => {
    // Same structure, keys, order and text; numbers equal to 1e-9. Byte equality is not asserted because
    // different builds of the JavaScript runtime round sin/cos/atan2 differently in the last digit
    // (observed: a rebuilt nodejs package changed solved gear angles by ~1e-17 rad).
    const same = (a: unknown, b: unknown, path: string): void => {
      if (typeof a === 'number' && typeof b === 'number') { expect(Math.abs(a - b), path).toBeLessThanOrEqual(1e-9 * Math.max(1, Math.abs(a), Math.abs(b))); return; }
      if (a && b && typeof a === 'object' && typeof b === 'object') {
        expect(Array.isArray(a), path).toBe(Array.isArray(b));
        const ka = Object.keys(a), kb = Object.keys(b);
        expect(ka, path).toEqual(kb);
        for (const k of ka) same((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k], `${path}.${k}`);
        return;
      }
      expect(a, path).toBe(b);
    };
    for (const ex of EXAMPLES) {
      const onDisk = readFileSync(new URL(`../public/examples/${ex.file}`, import.meta.url), 'utf8');
      const built = serializeProject(ex.build());
      same(JSON.parse(onDisk), JSON.parse(built), ex.file);
      // and the builder is deterministic within one runtime
      expect(serializeProject(ex.build()), ex.file).toBe(built);
    }
  });
  it('rejects foreign or future files with a clear message and fills defaults for old ones', () => {
    expect(() => normalizeProject({ foo: 1 })).toThrow(/Not a Mechanism Workshop project/);
    expect(() => normalizeProject({ format: 'mechanism-workshop', version: 9 })).toThrow(/Unsupported project version 9/);
    expect(() => normalizeProject(null)).toThrow();
    const p = normalizeProject({ format: 'mechanism-workshop', version: 1, name: 'Old', parts: [{ id: 'a', name: 'A', kind: 'link', params: { length: 33 } }] });
    expect(p.parts.length).toBe(1);
    expect(p.parts[0].params.width).toBe(10);              // default filled in
    expect(p.parts[0].pose).toEqual({ x: 0, y: 0, angle: 0, z: 0 });
    expect(p.sim.dt).toBe(0.001);
    expect(p.clearances.hole).toBe(0.2);
  });
  it('files with invalid values are rejected with a message naming the problem — never opened half-broken', () => {
    const good = JSON.parse(serializeProject(fourBar().p));
    const mutate = (fn: (p: any) => void) => { const c = structuredClone(good); fn(c); return c; };
    const cases: [string, any, RegExp][] = [
      ['string in a numeric parameter', mutate((p) => { p.parts[0].params.length = 'abc'; }), /part #1 "Crank": Length A–B must be a finite number \(found "abc"\)/],
      ['negative length', mutate((p) => { p.parts[0].params.length = -30; }), /Length A–B = -30 is outside the allowed range/],
      ['null parameter', mutate((p) => { p.parts[0].params.thickness = null; }), /Thickness must be a finite number/],
      ['zero thickness', mutate((p) => { p.parts[0].params.thickness = 0; }), /Thickness = 0 is outside the allowed range 0.2/],
      ['string pose', mutate((p) => { p.parts[1].pose.x = 'left'; }), /pose x must be a finite number/],
      ['unknown part kind', mutate((p) => { p.parts[2].kind = 'nonsense'; }), /unknown part kind "nonsense"/],
      ['garbage joints', mutate((p) => { p.joints = [null, 7, { type: 'revolute' }]; }), /joint #1 is not an object; joint #2 is not an object; joint #3: id must be a non-empty text/],
      ['parts not a list', mutate((p) => { p.parts = 'nope'; }), /"parts" must be a list/],
      ['plate holes not a list', (() => { const c = structuredClone(good); c.parts.push({ id: 'pl', name: 'Plate', kind: 'baseplate', params: { holes: 'x' } }); return c; })(), /Holes must be a list/],
      ['bad timestep', mutate((p) => { p.sim.dt = 0; }), /sim.dt \(timestep\) = 0 is outside the allowed range 0.00001/],
      ['garbage sim', mutate((p) => { p.sim = { dt: 'fast', gravity: null, floor: 3 }; }), /sim.gravity must be an object/],
      ['bad motor', mutate((p) => { p.joints[0].motor.speed = 'quick'; }), /motor speed must be a finite number/],
      ['NaN-producing clearance', mutate((p) => { p.clearances.hole = -1; }), /clearances.hole = -1 is outside/],
      ['variant with a string value', mutate((p) => { p.variants = [{ id: 'v', name: 'Bad', note: '', values: { [`part:${p.parts[0].id}:length`]: 'long' } }]; }), /variant "Bad": part:p1:length must be a finite number/],
      ['variant with absurd values', mutate((p) => { p.variants = [{ id: 'v', name: 'Huge', note: '', values: { [`part:${p.parts[0].id}:length`]: 1e9, 'sim:dt': 50 } }]; }), /part:p1:length = 1000000000 is outside.*sim:dt = 50 is outside/],
      ['variant with an unknown key', mutate((p) => { p.variants = [{ id: 'v', name: 'Odd', note: '', values: { 'sim:evil': 1 } }]; }), /not a simulation setting a variant may change/],
      ['non-boolean flag', mutate((p) => { p.parts[0].grounded = 'yes'; }), /grounded must be true or false/],
      ['reserved part id', mutate((p) => { p.parts[0].id = 'ground'; }), /the id "ground" is reserved/],
      ['duplicate probe id', mutate((p) => { p.probes.push({ ...p.probes[0] }); }), /"probes" contains the id "pr1" twice/],
      ['numeric project name', mutate((p) => { p.name = 42; }), /project name must be text/],
      ['non-boolean sim flag', mutate((p) => { p.sim.gravityEnabled = 'on'; }), /sim.gravityEnabled must be true or false/],
      ['numeric floor flag', mutate((p) => { p.sim.floor.enabled = 1; }), /sim.floor.enabled must be true or false/],
      ['non-boolean probe trace', mutate((p) => { p.probes[0].trace = 'yes'; }), /trace must be true or false/],
      ['units not an object', mutate((p) => { p.units = 7; }), /"units" must be an object/],
      ['garbage groups', mutate((p) => { p.groups = [{ members: 'all' }, 5]; }), /group #1 is invalid/],
      ['variant name not text', mutate((p) => { p.variants = [{ id: 'v', name: { a: 1 }, note: '', values: {} }]; }), /variant #1: name must be text/],
      ['probe on a missing part', mutate((p) => { p.probes[0].target.part = 'nope'; }), /refers to a part that is not in the file/],
      ['plot channel on a missing probe', mutate((p) => { p.plots = [{ id: 'pl', title: 't', channels: [{ probe: 'nope', quantity: 'x' }] }]; }), /refers to a probe that is not in the file/],
      ['unknown plot quantity', mutate((p) => { p.plots = [{ id: 'pl', title: 't', channels: [{ probe: p.probes[0].id, quantity: 'vibes' }] }]; }), /unknown quantity "vibes"/],
      ['plot title not text', mutate((p) => { p.plots = [{ id: 'pl', title: 7, channels: [{ probe: p.probes[0].id, quantity: 'x' }] }]; }), /plot #1: title must be text/],
      ['variant note not text', mutate((p) => { p.variants = [{ id: 'v', name: 'N', note: 5, values: {} }]; }), /variant #1: note must be text/],
      ['load flag not boolean', mutate((p) => { p.loads = [{ id: 'l', name: 'L', type: 'force', part: p.parts[0].id, anchor: {}, fx: 1, fy: 0, torque: 0, frame: 'world', enabled: 'yes' }]; }), /enabled must be true or false/],
      ['load on a missing part', mutate((p) => { p.loads = [{ id: 'l', name: 'L', type: 'force', part: 'nope', anchor: {}, fx: 1, fy: 0, torque: 0, frame: 'world', enabled: true }]; }), /acts on a part that is not in the file/],
      ['unknown material', mutate((p) => { p.parts[0].materialId = 'unobtainium'; }), /unknown material "unobtainium"/],
      ['activeVariant naming no variant', mutate((p) => { p.activeVariant = 'ghost'; }), /activeVariant names a variant that is not in the file/],
    ];
    for (const [name, file, re] of cases) {
      let msg = '';
      try { normalizeProject(file); } catch (e) { msg = (e as Error).message; }
      expect(msg, name).toMatch(re);
      expect(msg, name).toMatch(/Nothing was opened/);
    }
    // harmless leftovers are dropped, and the caller is told so it can inform the user
    const notices: string[] = [];
    const opened = normalizeProject(mutate((p) => { p.units.length = 'furlong'; p.variants = [{ id: 'v', name: 'Old', note: '', values: { 'part:deleted:length': 12, [`part:${p.parts[0].id}:length`]: 33 } }]; }), notices);
    expect(opened.units.length).toBe('mm');
    expect(opened.variants[0].values).toEqual({ [`part:${good.parts[0].id}:length`]: 33 });
    expect(notices.length).toBe(2);
    expect(notices.join(' ')).toMatch(/furlong.*not known/);
    expect(notices.join(' ')).toMatch(/refers to a part that no longer exists and was dropped/);
  });

  it('browser storage: save, list, autosave recovery, rename, delete', async () => {
    const persist = await import('../src/ui/persist');
    mem.clear();
    const { p } = fourBar();
    expect(persist.saveProject(p)).toBe(true);
    expect(persist.listProjects().map((e) => e.name)).toEqual(['Four-bar']);
    expect(persist.loadStored(p.id)).toEqual({ project: p, fromAutosave: false });
    const edited = ops.touch(ops.setPartParam(p, p.parts[0].id, 'length', 35));
    const at = persist.autosaveNow(edited)!;
    const rec = persist.loadStored(p.id)!;
    expect(rec.fromAutosave).toBe(true);
    expect(rec.project.parts[0].params.length).toBe(35);
    expect(rec.project.modifiedAt).toBe(at);
    // an explicit save clears the recovery copy
    persist.saveProject({ ...edited, modifiedAt: new Date(Date.now() + 1000).toISOString() });
    expect(persist.loadStored(p.id)!.fromAutosave).toBe(false);
    expect(persist.uniqueProjectName('Four-bar')).toBe('Four-bar 2');
    // corrupted entry does not crash loading
    mem.set(`mw:project:${p.id}`, '{not json');
    expect(persist.loadStored(p.id)).toBeNull();
    persist.deleteProject(p.id);
    expect(persist.listProjects()).toEqual([]);
  });
});

describe('authoring operations', () => {
  it('delete cascades to joints, loads, probes and plots; nothing dangling is left', () => {
    const { p, k } = fourBar();
    const withLoad = ops.addLoad(p, { type: 'force', part: k, anchor: { port: 'B' }, fx: 0, fy: -1000, torque: 0, frame: 'world', enabled: true }).project;
    const withPlot = { ...withLoad, plots: [{ id: 'pl', title: 'x', channels: [{ probe: withLoad.probes[0].id, quantity: 'x' }] }] };
    const after = ops.removeItems(withPlot, { parts: [k] });
    expect(after.parts.map((x) => x.name)).toEqual(['Crank', 'Rocker']);
    expect(after.joints.map((j) => j.name)).toEqual(['O2', 'O4']);
    expect(after.loads).toEqual([]);
    expect(after.probes).toEqual([]);
    expect(after.plots).toEqual([]);                        // a plot that lost all its channels is removed with them
    expect(p.parts.length).toBe(3);                         // input untouched (immutable operations)
  });
  it('duplicate copies internal joints and ground joints with fresh ids; patterns repeat it', () => {
    const { p, c, k, r } = fourBar();
    const gen = makeIdGen('d');
    const dup = ops.duplicateParts(p, [c, k, r], { dx: 0, dy: -120 }, gen);
    expect(dup.project.parts.length).toBe(6);
    expect(dup.project.joints.length).toBe(8);
    expect(new Set(dup.project.parts.map((x) => x.id)).size).toBe(6);
    expect(new Set(dup.project.joints.map((x) => x.id)).size).toBe(8);
    const copy = new SimRunner(dup.project, { interference: false });
    expect(copy.dof).toBe(2);                               // two independent 1-DOF linkages
    expect(copy.staticDiagnostics.filter((d) => d.severity === 'error')).toEqual([]);
    const lin = ops.patternLinear(p, [c, k, r], 3, 0, -120, 0, makeIdGen('l'));
    expect(lin.project.parts.length).toBe(9);
    const circ = ops.patternCircular(p, [c], 4, 0, 0, 2 * Math.PI, makeIdGen('c'));
    const a0 = p.parts.find((x) => x.id === c)!.pose.angle;
    const angles = circ.project.parts.filter((x) => x.name.startsWith('Crank')).map((x) => x.pose.angle - a0).sort((a, b) => a - b);
    expect(angles.map((a) => +(a / (Math.PI / 2)).toFixed(6))).toEqual([0, 1, 2, 3]);
  });
  it('mates move part B onto part A, stack it in Z, and align sliders with the axis', () => {
    let p = createProject('m');
    const a = ops.addPart(p, 'link', { id: 'a', pose: { x: 10, y: 20, angle: 0.4 } }); p = a.project;
    const b = ops.addPart(p, 'link', { id: 'b', pose: { x: 80, y: -30 } }); p = b.project;
    p = ops.mateRevolute(p, 'a', { port: 'B' }, 'b', { port: 'A' }).project;
    const A = p.parts[0], B = p.parts[1];
    expect(B.pose.x).toBeCloseTo(A.pose.x + 60 * Math.cos(0.4), 9);
    expect(B.pose.y).toBeCloseTo(A.pose.y + 60 * Math.sin(0.4), 9);
    expect(B.pose.z).toBe(4);                               // stacked on top of A (thickness 4)
    const rail = ops.addPart(p, 'rail', { id: 'r', pose: { x: 0, y: -80, angle: 0.3 } }); p = rail.project;
    const sl = ops.addPart(p, 'slider', { id: 's', pose: { x: 40, y: -40, angle: 1 } }); p = sl.project;
    p = ops.matePrismatic(p, 'r', { port: 'start' }, 's', { port: 'pin' }).project;
    const S = p.parts.find((x) => x.id === 's')!;
    expect(Math.abs(Math.sin(S.pose.angle - 0.3))).toBeLessThan(1e-12);      // aligned with the rail axis
    const nx = -Math.sin(0.3), ny = Math.cos(0.3);
    expect(nx * (S.pose.x - 0) + ny * (S.pose.y + 80)).toBeCloseTo(0, 9);      // on the rail's centre line
    expect(S.pose.z).toBe(p.parts.find((x) => x.id === 'r')!.pose.z);          // inside the slot: same layer as the guide
    expect(solveAssembly(p).ok).toBe(true);
  });
  it('a typed pose on a part of a freely floating jointed group moves the group rigidly; grounded mechanisms are left to the solver', () => {
    let p = createProject('t');
    p = ops.addPart(p, 'link', { id: 'a', pose: { x: 10, y: 20, angle: 0.4 } }).project;
    p = ops.addPart(p, 'link', { id: 'b', pose: { x: 80, y: -30 } }).project;
    p = ops.addPart(p, 'link', { id: 'c', pose: { x: 300, y: 0 } }).project;
    p = solveAssembly(ops.mateRevolute(p, 'a', { port: 'B' }, 'b', { port: 'A' }).project).project;
    const gap = (q: typeof p) => Math.max(0, ...jointGaps(q).map((g) => g.gap));
    const pose = (q: typeof p, id: string) => q.parts.find((x) => x.id === id)!.pose;
    expect(ops.freeGroupOf(p, 'a')!.sort()).toEqual(['a', 'b']);
    // translation: exactly the typed value, the mate follows, the unrelated part stays
    const t = solveAssembly(ops.setPartPoseDriving(p, 'a', { x: 25 })).project;
    expect(pose(t, 'a').x).toBeCloseTo(25, 12);
    expect(pose(t, 'b').x - pose(p, 'b').x).toBeCloseTo(15, 12);
    expect(pose(t, 'c')).toEqual(pose(p, 'c'));
    expect(gap(t)).toBeLessThan(1e-9);
    // rotation about the edited part's origin: rigid, joint stays closed, relative angle kept
    const r = solveAssembly(ops.setPartPoseDriving(p, 'a', { angle: 1.4 })).project;
    expect(pose(r, 'a').angle).toBeCloseTo(1.4, 12);
    expect(pose(r, 'a').x).toBeCloseTo(pose(p, 'a').x, 12);
    expect(pose(r, 'b').angle - pose(p, 'b').angle).toBeCloseTo(1.0, 12);
    expect(gap(r)).toBeLessThan(1e-9);
    // keyboard nudge of one part of the group moves both by the same amount
    const n = ops.nudgeParts(p, ['a'], 0, 3);
    expect(pose(n, 'a').y - pose(p, 'a').y).toBeCloseTo(3, 12);
    expect(pose(n, 'b').y - pose(p, 'b').y).toBeCloseTo(3, 12);
    // once anything in the group is grounded it is no longer free: only the part is posed (the solver decides the rest)
    const g = { ...p, parts: p.parts.map((x) => (x.id === 'b' ? { ...x, grounded: true } : x)) };
    expect(ops.freeGroupOf(g, 'a')).toBeNull();
    expect(pose(ops.setPartPoseDriving(g, 'a', { x: 25 }), 'b')).toEqual(pose(g, 'b'));
    // same for a joint to ground
    const gj = ops.mateRevolute(p, GROUND, { x: 0, y: 0 }, 'b', { port: 'B' }, { move: false }).project;
    expect(ops.freeGroupOf(gj, 'a')).toBeNull();
  });
  it('a typed pose is met exactly when the mechanism can follow (applyPoseEdit); otherwise the part alone is posed and the solve decides', () => {
    const D = Math.PI / 180;
    const pose = (q: Project, n: string) => q.parts.find((x) => x.name === n)!.pose;
    const id = (q: Project, n: string) => q.parts.find((x) => x.name === n)!.id;
    const gap = (q: Project) => Math.max(0, ...jointGaps(q).map((g) => g.gap));
    const closedAfter = (q: Project) => { const r = solveAssembly(q); expect(r.ok).toBe(true); expect(r.moved).toBeLessThan(1e-6); expect(gap(r.project)).toBeLessThan(1e-6); };
    // four-bar: a reachable rocker angle is met exactly, the (motorised) crank turns to allow it, the frame stays
    const fb = EXAMPLES.find((e) => e.id === 'fourbar')!.build();
    const r100 = applyPoseEdit(fb, id(fb, 'Rocker'), { angle: 100 * D });
    expect(r100.how).toBe('pinned');
    expect(pose(r100.project, 'Rocker').angle).toBe(100 * D);
    expect(Math.abs(pose(r100.project, 'Crank').angle - pose(fb, 'Crank').angle)).toBeGreaterThan(0.05);
    expect(pose(r100.project, 'Frame plate')).toEqual(pose(fb, 'Frame plate'));
    expect(r100.project.parts.find((x) => x.name === 'Rocker')!.grounded).toBe(false);
    closedAfter(r100.project);
    // an unreachable angle and a position its ground pivot forbids are NOT forced: the part alone is posed and the ordinary solve undoes it
    for (const patch of [{ angle: 60 * D }, { x: 250 }]) {
      const e = applyPoseEdit(fb, id(fb, 'Rocker'), patch);
      expect(e.how).toBe('plain');
      const r = solveAssembly(e.project);
      expect(r.ok).toBe(true);
      expect(pose(r.project, 'Rocker').angle).toBeCloseTo(pose(fb, 'Rocker').angle, 9);
      expect(pose(r.project, 'Rocker').x).toBeCloseTo(pose(fb, 'Rocker').x, 9);
    }
    // motor-driven crank: its angle is set, the rocker follows on the same closure (closed form of this four-bar is checked in solver tests)
    const c120 = applyPoseEdit(fb, id(fb, 'Crank'), { angle: 120 * D });
    expect(pose(c120.project, 'Crank').angle).toBe(120 * D);
    closedAfter(c120.project);
    // two-link arm on a ground pivot (no motor): the typed angle is met and the hanging link follows — also when the pivot is not at the part's origin
    for (const pivotAtOrigin of [true, false]) {
      let p = createProject('arm');
      p = ops.addPart(p, 'link', { id: 'a', name: 'L1', pose: { x: 0, y: 0 } }).project;
      p = ops.addPart(p, 'link', { id: 'b', name: 'L2', pose: { x: pivotAtOrigin ? 60 : -60, y: 0 } }).project;
      p = ops.mateRevolute(p, 'a', { port: pivotAtOrigin ? 'B' : 'A' }, 'b', { port: pivotAtOrigin ? 'A' : 'B' }).project;
      const len = p.parts[0].params.length as number;
      p = solveAssembly(ops.mateRevolute(p, GROUND, { x: pivotAtOrigin ? 0 : len, y: 0 }, 'a', { port: pivotAtOrigin ? 'A' : 'B' }, { move: false }).project).project;
      const e = applyPoseEdit(p, 'a', { angle: 40 * D });
      expect(e.how).toBe('pinned');
      expect(pose(e.project, 'L1').angle).toBe(40 * D);
      closedAfter(e.project);
      // a position the ground pivot forbids stays refused
      expect(applyPoseEdit(p, 'a', { x: pose(p, 'L1').x + 20 }).how).toBe('plain');
    }
    // free-standing walker: turning a crank web sets the crank phase and does not move the chassis; moving the chassis moves the machine
    const wk = EXAMPLES.find((e) => e.id === 'walker')!.build();
    const a0 = pose(wk, 'Crank web 1').angle;
    const w = applyPoseEdit(wk, id(wk, 'Crank web 1'), { angle: a0 + 30 * D });
    expect(w.how).toBe('pinned');
    expect(pose(w.project, 'Crank web 1').angle).toBe(a0 + 30 * D);
    expect(pose(w.project, 'Side plate A')).toEqual(pose(wk, 'Side plate A'));
    expect(pose(w.project, 'Crank web 3').angle - pose(wk, 'Crank web 3').angle).toBeCloseTo(30 * D, 9);   // the crankshaft is one rigid body
    expect(w.project.parts.some((x) => x.grounded)).toBe(false);
    closedAfter(w.project);
    const m = applyPoseEdit(wk, id(wk, 'Side plate A'), { x: pose(wk, 'Side plate A').x + 50 });
    expect(m.how).toBe('rigid-group');
    for (const q of m.project.parts) expect(q.pose.x - wk.parts.find((x) => x.id === q.id)!.pose.x).toBeCloseTo(50, 9);
    // gear train: turning the motor pinion turns the next gear by the tooth ratio (16 : 48), continuously
    const gr = EXAMPLES.find((e) => e.id === 'gears')!.build();
    const g = applyPoseEdit(gr, id(gr, 'Pinion 16T'), { angle: pose(gr, 'Pinion 16T').angle + 20 * D });
    expect(pose(g.project, 'Gear 48T').angle - pose(gr, 'Gear 48T').angle).toBeCloseTo(-20 * D * 16 / 48, 9);
    closedAfter(g.project);
  });
  it('groups, suppression and variants', () => {
    const { p, c, k, r, j } = fourBar();
    const g = ops.groupParts(p, [c, k], 'Input side', 'g1');
    expect(g.project.parts.filter((x) => x.groupId === 'g1').length).toBe(2);
    expect(ops.ungroup(g.project, 'g1').groups).toEqual([]);
    // suppressing the rocker removes its joints from the model: the remaining chain gains a freedom
    const sup = ops.updatePart(p, r, { suppressed: true });
    const run = new SimRunner(sup, { interference: false });
    expect(run.model.bodies.length).toBe(2);
    expect(run.dof).toBe(2);
    expect(run.staticDiagnostics.some((d) => d.code === 'joint.suppressed-part')).toBe(true);
    // variants: capture, modify, apply back
    const v1 = ops.captureVariant(p, 'Base', [`part:${c}:length`, `joint:${j}:motor.speed`, 'sim:floor.friction'], 'v1');
    let q = ops.setPartParam(v1.project, c, 'length', 44);
    q = ops.writeKey(q, `joint:${j}:motor.speed`, 99);
    q = ops.writeKey(q, 'sim:floor.friction', 0.1);
    const v2 = ops.captureVariant(q, 'Mod', undefined, 'v2');
    const back = ops.applyVariant(v2.project, 'v1');
    expect(back.parts.find((x) => x.id === c)!.params.length).toBe(30);
    expect(back.joints.find((x) => x.id === j)!.motor!.speed).toBeCloseTo(60 * RPM, 12);
    expect(back.sim.floor.friction).toBe(0.8);
    expect(ops.applyVariant(back, 'v2').parts.find((x) => x.id === c)!.params.length).toBe(44);
  });
});

describe('transactional undo / redo (application store)', () => {
  it('commit, undo, redo keep design and history consistent; simulation state is separate', async () => {
    mem.clear();
    const store = await import('../src/ui/store');
    const { p, c, k } = fourBar();
    store.openFromJSON(serializeProject(p), false);
    const s0 = store.getState().project;
    expect(s0.parts.length).toBe(3);
    // 1. edit a dimension (assembly is re-solved inside the same transaction)
    store.commit('Edit crank', (q) => ops.setPartParam(q, c, 'length', 40));
    const s1 = store.getState().project;
    expect(s1.parts.find((x) => x.id === c)!.params.length).toBe(40);
    expect(s1.parts.find((x) => x.id === k)!.pose).not.toEqual(s0.parts.find((x) => x.id === k)!.pose);
    expect(store.getState().assemblyIssues).toEqual([]);
    // 2. add a part, 3. delete it
    let id = '';
    store.commit('Add gear', (q) => { const r = ops.addPart(q, 'gear', { pose: { x: 200, y: 0 } }); id = r.id; return r.project; }, { solve: false });
    store.commit('Delete gear', (q) => ops.removeItems(q, { parts: [id] }));
    expect(store.getState().past.map((h) => h.label)).toEqual(['Edit crank', 'Add gear', 'Delete gear']);
    // run the simulation: transient state must not leak into the design
    const before = JSON.stringify(store.getState().project);
    store.simCtl.ensure().advance(500);
    expect(store.simCtl.runner!.time).toBeCloseTo(0.5, 9);
    expect(JSON.stringify(store.getState().project)).toBe(before);
    store.simCtl.reset();
    expect(store.getState().simStatus).toBe('idle');
    expect(JSON.stringify(store.getState().project)).toBe(before);
    // undo back to the start: exact previous objects are restored
    store.undo(); expect(store.getState().project.parts.length).toBe(4);
    store.undo(); expect(store.getState().project.parts.length).toBe(3);
    store.undo();
    expect(store.getState().project).toBe(s0);
    expect(store.getState().past.length).toBe(0);
    expect(store.getState().future.length).toBe(3);
    // redo everything
    store.redo(); expect(store.getState().project).toBe(s1);
    store.redo(); store.redo();
    expect(store.getState().project.parts.length).toBe(3);
    expect(store.getState().future.length).toBe(0);
    // a new edit after undo discards the redo branch
    store.undo();
    store.commit('Rename', (q) => ops.updatePart(q, c, { name: 'Input crank' }), { solve: false });
    expect(store.getState().future).toEqual([]);
    // interactive transaction: many previews, one undo step; cancel restores
    store.beginTxn('Drag');
    for (let i = 1; i <= 10; i++) store.previewTxn((q) => ops.setPartPose(q, id, { x: 200 + i }));
    store.endTxn();
    expect(store.getState().past.at(-1)!.label).toBe('Drag');
    const n = store.getState().past.length;
    store.beginTxn('Drag 2');
    store.previewTxn((q) => ops.setPartPose(q, id, { x: 999 }));
    store.cancelTxn();
    expect(store.getState().past.length).toBe(n);
    expect(store.getState().project.parts.find((x) => x.id === id)!.pose.x).toBe(210);
    // an edit that makes the assembly impossible is still one undoable step and is reported
    store.commit('Break', (q) => ops.setPartParam(ops.setPartParam(q, k, 'length', 3), c, 'length', 10), { quiet: true });   // 10 + 3 + 70 < 100: cannot span the fixed pivots
    expect(store.getState().assemblyIssues.map((i) => i.code)).toEqual(['assembly.cannot-close']);
    store.undo();
    expect(store.getState().assemblyIssues).toEqual([]);
  });
});

describe('robust opening and no-op edits (application store)', () => {
  it('a rejected file changes nothing: current project stays open and nothing is stored', async () => {
    mem.clear();
    const store = await import('../src/ui/store');
    const persist = await import('../src/ui/persist');
    const { p } = fourBar();
    store.openFromJSON(serializeProject(p), false);
    const before = store.getState().project;
    const stored = persist.listProjects().length;
    const bad = JSON.parse(serializeProject(p)); bad.id = 'evil'; bad.name = 'Garbage joints'; bad.joints = [null, 7, { type: 'revolute' }];
    expect(store.openFromJSON(JSON.stringify(bad), true)).toBe(false);
    expect(store.getState().project).toBe(before);
    expect(store.getState().toast!.text).toMatch(/Cannot open file: the file contains 3 invalid values/);
    expect(persist.listProjects().length).toBe(stored);
    expect(persist.listProjects().some((e) => e.name === 'Garbage joints')).toBe(false);
    expect(store.openFromJSON('{not json', true)).toBe(false);
    expect(store.getState().project).toBe(before);
  });
  it('edits that change nothing create no undo step; rapid nudges of one field collapse into one', async () => {
    const store = await import('../src/ui/store');
    const { p, c, j } = fourBar();
    store.openFromJSON(serializeProject(p), false);
    const n0 = store.getState().past.length;
    expect(store.commit('Edit crank', (q) => ops.setPartParam(q, c, 'length', 30))).toBe(false);           // same value
    expect(store.commit('Add motor', (q) => ops.updateJoint(q, j, { motor: { ...q.joints.find((x) => x.id === j)!.motor! } }), { solve: false })).toBe(false);
    store.beginTxn('Move part'); store.previewTxn((q) => ops.setPartPose(q, c, { x: 5 })); store.previewTxn((q) => ops.setPartPose(q, c, { x: q.parts.find((x) => x.id === c)!.pose.x - 5 })); store.endTxn();
    expect(store.getState().past.length).toBe(n0);
    for (const w of [11, 12, 13, 14]) store.commit('Edit Crank · Width', (q) => ops.setPartParam(q, c, 'width', w), { solve: false, coalesce: true });
    expect(store.getState().past.length).toBe(n0 + 1);
    store.undo();
    expect(store.getState().project.parts.find((x) => x.id === c)!.params.width).toBe(10);
    // two deliberately typed values in quick succession stay two steps (only nudges / key repeats merge)
    store.commit('Edit Crank · Width', (q) => ops.setPartParam(q, c, 'width', 20), { solve: false });
    store.commit('Edit Crank · Width', (q) => ops.setPartParam(q, c, 'width', 21), { solve: false });
    expect(store.getState().past.length).toBe(n0 + 2);
  });
});

describe('showcase projects', () => {
  it('all five build, assemble without errors, have notes, cameras, probes and plots', () => {
    expect(EXAMPLES.map((e) => e.id)).toEqual(['fourbar', 'gears', 'cam', 'slidercrank', 'walker']);
    for (const ex of EXAMPLES) {
      const p = ex.build();
      expect(p.description.length, ex.id).toBeGreaterThan(200);
      expect(p.views.length, ex.id).toBeGreaterThanOrEqual(2);
      expect(p.probes.length, ex.id).toBeGreaterThanOrEqual(3);
      expect(p.plots.length, ex.id).toBeGreaterThanOrEqual(3);
      expect(p.variants.length, ex.id).toBeGreaterThanOrEqual(3);
      const r = new SimRunner(p);
      expect(r.staticDiagnostics.filter((d) => d.severity === 'error'), ex.id).toEqual([]);
      expect(r.events.filter((d) => d.severity === 'error'), ex.id).toEqual([]);       // no interference at the design pose
      for (const pl of p.plots) for (const ch of pl.channels) expect(r.series(ch).available, `${ex.id} ${pl.title}`).toBe(true);
    }
  });
  it('walker: free body walks on floor contact; chassis travel comes from foot forces, joints stay closed, no interference', () => {
    const p = EXAMPLES.find((e) => e.id === 'walker')!.build();
    expect(p.parts.every((x) => !x.grounded)).toBe(true);
    const r = new SimRunner(p);
    expect(r.dof).toBe(4);                                 // crank + 3 free-body freedoms of the whole machine
    r.advance(4000);
    expect(r.sim.status).toBe('ok');
    expect(r.walk.travel).toBeGreaterThan(300);
    expect(r.sim.stats.maxPosError).toBeLessThan(1e-6);
    expect(r.events.filter((e) => e.code.startsWith('interference'))).toEqual([]);
    // vertical force balance on average: floor normal force ≈ weight (2 %)
    const total = r.model.bodies.reduce((s, b) => s + b.mass, 0) * 9806.65;
    const sys = p.probes.find((x) => x.target.kind === 'system')!;
    const fn = r.series({ probe: sys.id, quantity: 'normalForce' });
    const tail = Array.from(fn.y).slice(Math.floor(fn.y.length / 4));
    expect(Math.abs(tail.reduce((a, b) => a + b, 0) / tail.length - total) / total).toBeLessThan(0.02);
    // with the floor removed and the motor running, nothing pushes it forward: it just falls
    const noFloor = new SimRunner({ ...p, sim: { ...p.sim, floor: { ...p.sim.floor, enabled: false } }, loads: [] }, { interference: false });
    noFloor.advance(500);
    expect(Math.abs(noFloor.sim.q[3 * (noFloor as any).refBody] - noFloor.model.bodies[(noFloor as any).refBody].x0)).toBeLessThan(1);
    expect(noFloor.sim.q[3 * (noFloor as any).refBody + 1]).toBeLessThan(noFloor.model.bodies[(noFloor as any).refBody].y0 - 1000);
    // low friction + tow load: fails to advance and says so
    const icy = new SimRunner(ops.applyVariant(p, p.variants[1].id), { interference: false });
    icy.advance(4000);
    expect(icy.walk.travel).toBeLessThan(0);
    expect(icy.walkSummary()!.title).toMatch(/slipping/i);
  });
  it('unavailable quantities are marked, not invented (kinematic mode has no forces)', () => {
    const p0 = EXAMPLES.find((e) => e.id === 'fourbar')!.build();
    const p = { ...p0, sim: { ...p0.sim, mode: 'kinematic' as const } };
    const r = new SimRunner(p, { interference: false });
    r.advance(300);
    const motor = p.probes.find((x) => x.name === 'Crank motor')!;
    const tq = r.series({ probe: motor.id, quantity: 'torque' });
    expect(tq.available).toBe(false);
    expect(tq.reason).toMatch(/kinematic/i);
    expect(Array.from(tq.y).every(Number.isNaN)).toBe(true);
    const ang = r.series({ probe: motor.id, quantity: 'coord' });
    expect(ang.available).toBe(true);
    expect(ang.provenance).toBe('state');
    const csv = r.csv([{ probe: motor.id, quantity: 'torque' }, { probe: motor.id, quantity: 'coord' }], (v, kind) => ({ v, unit: kind }));
    expect(csv).toMatch(/UNAVAILABLE/);
    expect(csv.split('\n').filter((l) => !l.startsWith('#')).length).toBe(r.n + 2);
  });
});
