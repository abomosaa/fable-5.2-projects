/**
 * Application state. The `project` (design) is immutable and versioned by an
 * undo stack; the simulation runner is transient and rebuilt from the design
 * whenever the design changes or the simulation is reset.
 */
import { useSyncExternalStore } from 'react';
import type { Channel, Project } from '../core/model/types';
import { createProject, normalizeProject, uid } from '../core/model/project';
import { solveAssembly, type DragSpec } from '../core/assembly/solve';
import type { Diagnostic } from '../core/assembly/compile';
import { SimRunner, type Series } from '../core/sim/runner';
import * as ops from '../core/model/ops';
import * as persist from './persist';
import { formatQuantity } from '../core/units';

export type Tool =
  | { kind: 'select' }
  | { kind: 'measure' }
  | { kind: 'mate'; type: 'revolute' | 'prismatic' | 'rigid' | 'spring' | 'gear' | 'belt' | 'rackPinion' | 'cam' }
  | { kind: 'probe' }
  | { kind: 'load' };

export interface Selection { parts: string[]; joints: string[]; loads: string[]; probes: string[] }
export const EMPTY_SEL: Selection = { parts: [], joints: [], loads: [], probes: [] };

export interface ViewSettings {
  ortho: boolean;
  explode: number;
  transparent: boolean;
  section: { enabled: boolean; axis: 'x' | 'y' | 'z'; offset: number; flip: boolean };
  showJoints: boolean;
  showGrid: boolean;
  showTraces: boolean;
  showForces: boolean;
  shadows: boolean;
  /** camera follows a free-body machine during a run */
  follow: boolean;
}

export interface RunSnapshot { label: string; series: Record<string, { t: Float64Array; y: Float64Array }>; time: number }

export interface AppState {
  project: Project;
  past: { project: Project; label: string }[];
  future: { project: Project; label: string }[];
  selection: Selection;
  hover: { part?: string; joint?: string } | null;
  mode: 'assemble' | 'sketch';
  activeSketch: string | null;
  tool: Tool;
  view: ViewSettings;
  /** design-time diagnostics (assembly solve + static checks of the idle runner) */
  assemblyIssues: Diagnostic[];
  simStatus: 'idle' | 'running' | 'paused' | 'ended';
  simSpeed: number;
  /** bumps a few times per second while running, and on every reset/step */
  simTick: number;
  dirty: boolean;
  savedAt: string | null;
  autosavedAt: string | null;
  leftTab: 'tree' | 'library';
  bottomTab: 'plots' | 'diagnostics' | 'notes' | 'export' | 'performance';
  bottomOpen: boolean;
  dialog: null | 'open' | 'shortcuts' | 'about' | 'pattern' | 'welcome';
  toast: { text: string; kind: 'info' | 'error' | 'ok'; id: number } | null;
  previousRun: RunSnapshot | null;
  /** highlighted items coming from a diagnostic the user clicked */
  focus: { parts: string[]; joints: string[] } | null;
  cameraRequest: { name: string; n: number } | null;
  examples: { id: string; file: string; title: string; blurb: string }[];
}

const DEFAULT_VIEW: ViewSettings = {
  ortho: false, explode: 0, transparent: false,
  section: { enabled: false, axis: 'z', offset: 0, flip: false },
  showJoints: true, showGrid: true, showTraces: true, showForces: true, shadows: true, follow: true,
};

let state: AppState = {
  project: createProject('Untitled mechanism'),
  past: [], future: [],
  selection: EMPTY_SEL, hover: null,
  mode: 'assemble', activeSketch: null,
  tool: { kind: 'select' },
  view: DEFAULT_VIEW,
  assemblyIssues: [],
  simStatus: 'idle', simSpeed: 1, simTick: 0,
  dirty: false, savedAt: null, autosavedAt: null,
  leftTab: 'library', bottomTab: 'notes', bottomOpen: true,
  dialog: null, toast: null, previousRun: null, focus: null, cameraRequest: null, examples: [],
};

const listeners = new Set<() => void>();
export const getState = () => state;
export function setState(patch: Partial<AppState> | ((s: AppState) => Partial<AppState>)): void {
  const p = typeof patch === 'function' ? patch(state) : patch;
  state = { ...state, ...p };
  listeners.forEach((l) => l());
}
function subscribe(l: () => void) { listeners.add(l); return () => listeners.delete(l); }
export function useApp<S>(selector: (s: AppState) => S): S {
  return useSyncExternalStore(subscribe, () => selector(state));
}

let toastId = 0;
export function toast(text: string, kind: 'info' | 'error' | 'ok' = 'info'): void {
  const id = ++toastId;
  setState({ toast: { text, kind, id } });
  setTimeout(() => { if (state.toast?.id === id) setState({ toast: null }); }, kind === 'error' ? 7000 : 3500);
}

// ---------------------------------------------------------------- simulation controller

export const simCtl = {
  runner: null as SimRunner | null,
  /** simulated seconds owed to the solver */
  debt: 0,
  lastWall: 0,
  realtimeFactor: 0,
  fps: 0,
  frameMs: 0,
  frameMsMax: 0,
  lastUiTick: 0,
  stepsLastFrame: 0,

  /** runner for the current design (created lazily; idle until played) */
  ensure(): SimRunner {
    if (!this.runner) {
      this.runner = new SimRunner(state.project);
    }
    return this.runner;
  },
  invalidate(): void {
    this.runner = null;
    this.debt = 0;
  },
  play(): void {
    const r = this.ensure();
    if (state.simStatus === 'ended') return;
    const errs = r.staticDiagnostics.filter((d) => d.severity === 'error');
    if (r.blocked || errs.length) {
      setState({ bottomTab: 'diagnostics', bottomOpen: true, focus: { parts: errs.flatMap((e) => e.parts), joints: errs.flatMap((e) => e.joints) } });
      toast(`Cannot start: fix the ${errs.length === 1 ? 'error' : `${errs.length} errors`} listed in Diagnostics first (${errs[0]?.title ?? 'design error'}).`, 'error');
      return;
    }
    r.paused = false;
    this.lastWall = performance.now();
    this.debt = 0;
    setState({ simStatus: 'running', focus: null });
  },
  pause(): void {
    if (state.simStatus === 'running') setState({ simStatus: 'paused', simTick: state.simTick + 1 });
  },
  toggle(): void {
    if (state.simStatus === 'running') this.pause(); else this.play();
  },
  step(n = 1): void {
    const r = this.ensure();
    if (state.simStatus === 'ended') return;
    r.paused = false;
    r.advance(n);
    this.afterAdvance(r, true);
    if ((getState().simStatus as string) !== 'ended') setState({ simStatus: 'paused', simTick: state.simTick + 1 });
  },
  /** discard transient state; the designed assembly is untouched */
  reset(keepPrevious = true): void {
    const r = this.runner;
    if (r && r.sim.stepCount > 0 && keepPrevious) snapshotRun(r);
    this.invalidate();
    setState({ simStatus: 'idle', simTick: state.simTick + 1, focus: null });
    scheduleDiagnostics(0);
  },
  afterAdvance(r: SimRunner, force = false): void {
    if (r.finished || r.paused) {
      const failed = r.finished;
      const last = r.events[r.events.length - 1];
      setState({
        simStatus: failed ? 'ended' : 'paused', simTick: state.simTick + 1,
        bottomTab: 'diagnostics', bottomOpen: true,
        focus: last ? { parts: last.parts, joints: last.joints } : null,
      });
      if (last) toast(last.title, last.severity === 'error' ? 'error' : 'info');
      return;
    }
    const now = performance.now();
    if (force || now - this.lastUiTick > 120) {
      this.lastUiTick = now;
      setState({ simTick: state.simTick + 1 });
    }
  },
  /** called once per rendered frame; advances the fixed-step solver by wall time × speed within a time budget */
  frame(now: number): void {
    const dtWall = Math.min((now - this.lastWall) / 1000, 0.1);
    this.lastWall = now;
    if (state.simStatus !== 'running' || !this.runner) { this.stepsLastFrame = 0; return; }
    const r = this.runner;
    this.debt += dtWall * state.simSpeed;
    const want = Math.floor(this.debt / r.dt);
    if (want <= 0) { this.stepsLastFrame = 0; return; }
    const t0 = performance.now();
    let done = 0;
    // spend at most ~60 % of the frame interval on physics so rendering stays responsive
    const budgetMs = Math.min(40, Math.max(9, dtWall * 600));
    while (done < want) {
      const chunk = Math.min(want - done, 8);
      const n = r.advance(chunk);
      done += n;
      if (n < chunk || performance.now() - t0 > budgetMs) break;
    }
    this.debt -= done * r.dt;
    // do not accumulate unbounded debt when the solver is slower than real time
    if (this.debt > 0.25) this.debt = 0;
    this.stepsLastFrame = done;
    const rf = dtWall > 0 ? (done * r.dt) / dtWall : 0;
    this.realtimeFactor += (rf - this.realtimeFactor) * 0.1;
    this.afterAdvance(r);
  },
};

function channelKey(c: Channel): string { return `${c.probe}|${c.quantity}`; }
export { channelKey };

function snapshotRun(r: SimRunner): void {
  const series: RunSnapshot['series'] = {};
  for (const pl of r.project.plots) {
    for (const c of pl.channels) {
      const s: Series = r.series(c);
      if (s.available) series[channelKey(c)] = { t: new Float64Array(s.t), y: new Float64Array(s.y) };
    }
  }
  const v = r.project.variants.find((x) => x.id === r.project.activeVariant);
  setState({ previousRun: { label: v ? v.name : `Run to t = ${r.time.toFixed(2)} s`, series, time: r.time } });
}

// ---------------------------------------------------------------- diagnostics of the idle design

let diagTimer: ReturnType<typeof setTimeout> | null = null;
export function scheduleDiagnostics(delay = 120): void {
  if (diagTimer) clearTimeout(diagTimer);
  diagTimer = setTimeout(() => {
    diagTimer = null;
    if (state.simStatus !== 'idle') return;
    try { simCtl.ensure(); } catch (e) { console.error(e); }
    setState({ simTick: state.simTick + 1 });
  }, delay);
}

// ---------------------------------------------------------------- authoring transactions

function afterDesignChange(project: Project, extra: Partial<AppState> = {}): void {
  const runningBefore = state.simStatus === 'running';
  const r = simCtl.runner;
  if (r && r.sim.stepCount > 0) snapshotRun(r);
  simCtl.invalidate();
  setState({ project, dirty: true, simStatus: 'idle', ...extra });
  persist.scheduleAutosave(() => state.project, (at) => {
    if (at) { setState({ autosavedAt: at }); storageWarned = false; }
    else if (!storageWarned) { storageWarned = true; toast('Autosave failed: browser storage is full or unavailable. Your changes are NOT stored — use File → Export project file to keep them.', 'error'); }
  });
  if (runningBefore) {
    // live response: restart the run with the edited design
    try { simCtl.ensure(); simCtl.play(); } catch (e) { console.error(e); }
  } else scheduleDiagnostics();
}

export interface CommitOpts { solve?: boolean; selection?: Selection; quiet?: boolean; /** merge with an immediately preceding identical edit (key repeats, nudges) */ coalesce?: boolean }

/**
 * Apply an authoring change as one undoable transaction. With `solve`
 * (default) the assembly is re-solved so joints stay closed; if that is
 * impossible the edit is still applied and the problem is reported.
 */
export function commit(label: string, fn: (p: Project) => Project, opts: CommitOpts = {}): boolean {
  const before = state.project;
  let next: Project;
  try { next = fn(before); } catch (e) { toast((e as Error).message, 'error'); return false; }
  if (next === before) return false;
  let issues: Diagnostic[] = [];
  if (opts.solve !== false) {
    const r = solveAssembly(next);
    next = r.project;
    issues = r.issues.filter((i) => i.code === 'assembly.cannot-close');
    if (!r.ok && !opts.quiet) toast('Assembly cannot be closed with this change — see Diagnostics. (Ctrl+Z to undo)', 'error');
  }
  next = snapRoundOff(next, before);
  // an edit that changes nothing must not create an undo step
  if (sameDesign(next, before)) {
    if (opts.selection) setState({ selection: opts.selection });
    if (issues.length !== state.assemblyIssues.length) setState({ assemblyIssues: issues });
    return false;
  }
  next = ops.touch(next);
  // rapid repeats of the same edit (holding an arrow key, nudging a field) collapse into one undo step
  const now = Date.now();
  const last = state.past[state.past.length - 1];
  const canMerge = !!opts.coalesce || now < coalesceArmedUntil;
  const merge = !!last && last.label === label && lastCommitLabel === label && lastCommitMergeable && now - lastCommitAt < 700 && canMerge;
  coalesceArmedUntil = 0; lastCommitMergeable = canMerge;
  lastCommitAt = now; lastCommitLabel = label;
  const past = merge ? state.past : [...state.past, { project: before, label }].slice(-200);
  afterDesignChange(next, { past, future: [], assemblyIssues: issues, ...(opts.selection ? { selection: opts.selection } : {}), ...(issues.length ? { bottomTab: 'diagnostics' as const, bottomOpen: true } : {}) });
  return true;
}

let storageWarned = false;
let lastCommitAt = 0;
/** label of the most recent commit; cleared by undo/redo so an older step with the same label is never merged into */
let lastCommitLabel = '';
let coalesceArmedUntil = 0;
/** the previous commit was itself a nudge / key repeat (a typed value is never merged into) */
let lastCommitMergeable = false;
/** the next commit (within 50 ms) may merge with the previous identical one — used by field nudges */
export function coalesceNext(): void { coalesceArmedUntil = Date.now() + 50; }

/**
 * A pose that the assembly solve returned to within round-off of where it was IS the old pose. Without
 * this, an edit that the joints undo completely would differ in the 17th digit and count as a change.
 */
function snapRoundOff(next: Project, before: Project): Project {
  if (next.parts === before.parts) return next;
  const old = new Map(before.parts.map((p) => [p.id, p]));
  let any = false;
  const parts = next.parts.map((p) => {
    const o = old.get(p.id);
    if (!o || o.pose === p.pose) return p;
    const dx = Math.abs(p.pose.x - o.pose.x), dy = Math.abs(p.pose.y - o.pose.y), da = Math.abs(p.pose.angle - o.pose.angle);
    if (dx + dy + da === 0 || dx > 1e-9 || dy > 1e-9 || da > 1e-9) return p;
    any = true;
    return { ...p, pose: { ...p.pose, x: o.pose.x, y: o.pose.y, angle: o.pose.angle } };
  });
  return any ? { ...next, parts } : next;
}

/**
 * Dry run of a pose edit (nothing is committed): true when the joints undo it entirely, i.e. no part of
 * the solved assembly ends up anywhere else than before.
 */
export function poseHeld(before: Project, edited: Project): boolean {
  const r = solveAssembly(edited);
  if (!r.ok) return false;
  const old = new Map(before.parts.map((p) => [p.id, p]));
  let moved = 0;
  for (const q of r.project.parts) { const o = old.get(q.id); if (o) moved = Math.max(moved, Math.hypot(q.pose.x - o.pose.x, q.pose.y - o.pose.y), Math.abs(q.pose.angle - o.pose.angle) * 20); }
  return moved < 1e-4;
}

export function heldMessage(names: string[]): string {
  const one = names.length === 1;
  return `${names.map((n) => `"${n}"`).join(', ')} ${one ? 'is' : 'are'} held by ${one ? 'its' : 'their'} joints, so that position could not be reached from this pose; nothing was changed. Drag the mechanism to pose it, move the part ${one ? 'it is' : 'they are'} attached to, or remove the joint.`;
}

const POSE_TOL = { x: 1e-3, y: 1e-3, angle: 2e-5, z: 1e-6 } as const;
/** did the part end up somewhere else than asked? (judged at the precision the fields display) */
export function poseMissed(project: Project, partId: string, asked: Partial<Project['parts'][number]['pose']>): boolean {
  const now = project.parts.find((x) => x.id === partId);
  return !!now && (Object.keys(asked) as (keyof typeof POSE_TOL)[]).some((k) => Math.abs(now.pose[k] - (asked[k] as number)) > POSE_TOL[k]);
}
/** message for a typed or keyed pose that the joints only allowed in adjusted form */
export function reposedMessage(project: Project, partId: string, asked: Partial<Project['parts'][number]['pose']>): string {
  const now = project.parts.find((x) => x.id === partId)!;
  const where = (Object.keys(asked) as (keyof typeof POSE_TOL)[]).map((k) => `${k === 'angle' ? 'rotation' : k.toUpperCase()} ${formatQuantity(now.pose[k], k === 'angle' ? 'angle' : 'length', project.units, 5)}`).join(', ');
  return `"${now.name}" is held by its joints, so the requested value could not be kept: the mechanism was re-posed to another assembly that keeps all joints closed (${where}). Ctrl+Z restores the previous pose.`;
}

/** design equality ignoring the modification timestamp */
function sameDesign(a: Project, b: Project): boolean {
  if (a === b) return true;
  const strip = (p: Project) => JSON.stringify({ ...p, modifiedAt: '' });
  return strip(a) === strip(b);
}

let txn: { base: Project; label: string } | null = null;
/** start an interactive change (drag): previews do not create undo steps until endTxn */
export function beginTxn(label: string): void { if (!txn) txn = { base: state.project, label }; }
export function previewTxn(fn: (p: Project) => Project): void {
  if (!txn) return;
  const next = fn(state.project);
  if (next === state.project) return;
  if (simCtl.runner) simCtl.invalidate();
  setState({ project: next, simStatus: 'idle' });
}
export function endTxn(finalize?: (p: Project) => Project, solve = false): void {
  if (!txn) return;
  const { base, label } = txn;
  txn = null;
  let next = finalize ? finalize(state.project) : state.project;
  if (sameDesign(next, base)) { if (state.project !== base) setState({ project: base }); scheduleDiagnostics(); return; }
  let issues: Diagnostic[] = [];
  if (solve) { const r = solveAssembly(next); next = r.project; issues = r.issues.filter((i) => i.code === 'assembly.cannot-close'); }
  next = ops.touch(next);
  afterDesignChange(next, { past: [...state.past, { project: base, label }].slice(-200), future: [], assemblyIssues: issues });
}
export function cancelTxn(): void {
  if (!txn) return;
  const base = txn.base; txn = null;
  simCtl.invalidate();
  setState({ project: base });
  scheduleDiagnostics();
}
export function inTxn(): boolean { return txn !== null; }

/** kinematic drag of an assembled part during a transaction */
export function dragSolve(drag: DragSpec): void {
  if (!txn) return;
  const r = solveAssembly(state.project, { drag, propagate: false });
  if (r.ok && r.project !== state.project) {
    if (simCtl.runner) simCtl.invalidate();
    setState({ project: r.project, simStatus: 'idle' });
  }
}

function sanitizeSelection(p: Project, sel: Selection): Selection {
  const parts = new Set(p.parts.map((x) => x.id)), joints = new Set(p.joints.map((x) => x.id)), loads = new Set(p.loads.map((x) => x.id)), probes = new Set(p.probes.map((x) => x.id));
  return { parts: sel.parts.filter((x) => parts.has(x)), joints: sel.joints.filter((x) => joints.has(x)), loads: sel.loads.filter((x) => loads.has(x)), probes: sel.probes.filter((x) => probes.has(x)) };
}

function recheck(p: Project): Diagnostic[] {
  const r = solveAssembly(p);
  return r.ok ? [] : r.issues.filter((i) => i.code === 'assembly.cannot-close');
}

export function undo(): void {
  lastCommitLabel = '';
  const last = state.past[state.past.length - 1];
  if (!last) return;
  const cur = state.project;
  afterDesignChange(last.project, {
    past: state.past.slice(0, -1), future: [...state.future, { project: cur, label: last.label }],
    selection: sanitizeSelection(last.project, state.selection), assemblyIssues: recheck(last.project),
    activeSketch: state.activeSketch && last.project.sketches.some((s) => s.id === state.activeSketch) ? state.activeSketch : null,
    mode: state.mode === 'sketch' && !(state.activeSketch && last.project.sketches.some((s) => s.id === state.activeSketch)) ? 'assemble' : state.mode,
  });
  toast(`Undo: ${last.label}`);
}

export function redo(): void {
  lastCommitLabel = '';
  const next = state.future[state.future.length - 1];
  if (!next) return;
  const cur = state.project;
  afterDesignChange(next.project, {
    future: state.future.slice(0, -1), past: [...state.past, { project: cur, label: next.label }],
    selection: sanitizeSelection(next.project, state.selection), assemblyIssues: recheck(next.project),
  });
  toast(`Redo: ${next.label}`);
}

// ---------------------------------------------------------------- selection helpers

export function select(sel: Partial<Selection>, additive = false): void {
  const base = additive ? state.selection : EMPTY_SEL;
  const merge = (a: string[], b?: string[]) => {
    if (!b) return a;
    if (!additive) return b;
    const s = new Set(a);
    for (const id of b) { if (s.has(id)) s.delete(id); else s.add(id); }
    return [...s];
  };
  setState({ selection: { parts: merge(base.parts, sel.parts), joints: merge(base.joints, sel.joints), loads: merge(base.loads, sel.loads), probes: merge(base.probes, sel.probes) }, focus: null });
}
export function clearSelection(): void { if (state.selection !== EMPTY_SEL) setState({ selection: EMPTY_SEL, focus: null }); }

// ---------------------------------------------------------------- project lifecycle

function loadProject(p: Project, extra: Partial<AppState> = {}): void {
  simCtl.invalidate();
  setState({
    project: p, past: [], future: [], selection: EMPTY_SEL, hover: null, mode: 'assemble', activeSketch: null,
    tool: { kind: 'select' }, simStatus: 'idle', dirty: false, autosavedAt: null, previousRun: null, focus: null,
    assemblyIssues: recheck(p), view: { ...state.view, ortho: p.views[0]?.ortho ?? state.view.ortho, explode: 0, transparent: false, section: { ...state.view.section, enabled: false } },
    cameraRequest: { name: 'default', n: (state.cameraRequest?.n ?? 0) + 1 },
    bottomTab: p.description ? 'notes' : state.bottomTab,
    leftTab: p.parts.length ? 'tree' : 'library',
    ...extra,
  });
  persist.setLastProject(p.id);
  scheduleDiagnostics(0);
}

export function newProject(name = 'Untitled mechanism'): void {
  const p = createProject(persist.uniqueProjectName(name));
  persist.saveProject(p);
  loadProject(p, { savedAt: p.modifiedAt, dialog: null });
}

/** load a project; if anything throws, the previously open project is restored untouched */
function tryLoad(p: Project, extra: Partial<AppState>): string | null {
  const backup = state;
  try {
    // exercise the whole pipeline (geometry, compile, solve) before committing to the new project
    new SimRunner(p, { interference: false });
    loadProject(p, extra);
    return null;
  } catch (e) {
    simCtl.invalidate();
    state = backup;
    listeners.forEach((l) => l());
    persist.setLastProject(backup.project.id);
    return (e as Error).message || String(e);
  }
}

export function openStored(id: string): boolean {
  let res: ReturnType<typeof persist.loadStored>;
  try { res = persist.loadStored(id); } catch { res = null; }
  if (!res) { toast('Could not open that project: the stored copy is missing or damaged. It can be deleted from File → Open.', 'error'); return false; }
  const err = tryLoad(res.project, { savedAt: res.project.modifiedAt, dirty: res.fromAutosave, dialog: null });
  if (err) { toast(`Could not open that project: ${err}`, 'error'); return false; }
  if (res.fromAutosave) toast('Recovered unsaved changes from autosave.', 'info');
  return true;
}

export function openFromJSON(text: string, asCopy: boolean): boolean {
  let p: Project;
  const notices: string[] = [];
  try { p = normalizeProject(JSON.parse(text), notices); } catch (e) { toast(`Cannot open file: ${(e as Error).message}`, 'error'); return false; }
  if (asCopy) p = { ...p, id: uid('proj'), name: persist.uniqueProjectName(p.name) };
  const err = tryLoad(p, { savedAt: new Date().toISOString(), dialog: null });
  if (err) { toast(`Cannot open file: ${err}. Nothing was opened or stored.`, 'error'); return false; }
  if (notices.length) toast(`Opened "${p.name}". ${notices.length} stale entr${notices.length === 1 ? 'y was' : 'ies were'} ignored: ${notices.slice(0, 2).join('; ')}${notices.length > 2 ? '; …' : ''}.`, 'info');
  // stored only after it opened successfully
  if (!persist.saveProject(p)) {
    persist.clearLastProject();      // nothing is stored under this id: do not try to reopen it at the next start
    setState({ dirty: true, savedAt: null });
    toast('The project is open but could NOT be stored in this browser (storage is full or unavailable). Use File → Export project file to keep your work.', 'error');
  }
  return true;
}

export async function openExample(file: string): Promise<void> {
  try {
    const res = await fetch(`./examples/${file}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    openFromJSON(await res.text(), true);
  } catch (e) { toast(`Could not load example: ${(e as Error).message}`, 'error'); }
}

export function saveCurrent(): void {
  const p = ops.touch(state.project);
  const ok = persist.saveProject(p);
  if (!ok) { toast('Saving failed: browser storage is full or unavailable. Use File → Export project file.', 'error'); return; }
  setState({ project: p, dirty: false, savedAt: p.modifiedAt });
  toast('Project saved.', 'ok');
}

export function renameProject(name: string): void {
  const n = name.trim();
  if (!n || n === state.project.name) return;
  commit('Rename project', (p) => ({ ...p, name: n }), { solve: false });
  persist.saveProject(state.project);
  setState({ dirty: false, savedAt: state.project.modifiedAt });
}

export function duplicateProject(): void {
  const p: Project = { ...structuredClone(state.project), id: uid('proj'), name: persist.uniqueProjectName(`${state.project.name} copy`), createdAt: new Date().toISOString(), modifiedAt: new Date().toISOString() };
  persist.saveProject(p);
  loadProject(p, { savedAt: p.modifiedAt });
  toast(`Duplicated as "${p.name}".`, 'ok');
}

export function deleteStored(id: string): void {
  persist.deleteProject(id);
  setState({});
}

export async function boot(): Promise<void> {
  try {
    const res = await fetch('./examples/index.json');
    if (res.ok) setState({ examples: await res.json() });
  } catch { /* offline file:// or missing: examples menu stays empty */ }
  const last = persist.getLastProject();
  if (last && persist.listProjects().some((e) => e.id === last) && openStored(last)) return;
  const p = createProject(persist.uniqueProjectName('Untitled mechanism'));
  persist.saveProject(p);
  loadProject(p, { savedAt: p.modifiedAt, dialog: 'welcome' });
}

if (typeof window !== 'undefined') {
  window.addEventListener('beforeunload', () => { if (state.dirty) persist.autosaveNow(state.project); });
  // test / automation hook
  (window as any).__mw = { getState, setState, simCtl, commit, undo, redo, ops, select, openFromJSON, saveCurrent, persist };
}
