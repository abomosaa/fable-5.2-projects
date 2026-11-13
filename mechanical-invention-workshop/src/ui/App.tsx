import { useEffect, useState } from 'react';
import { CircleAlert, CheckCircle2, Info } from 'lucide-react';
import { Viewport } from './viewport/Viewport';
import { TopBar, StatusBar } from './panels/TopBar';
import { LeftPanel } from './panels/LeftPanel';
import { Inspector } from './panels/Inspector';
import { BottomPanel } from './panels/BottomPanel';
import { SketchEditor } from './sketch/SketchEditor';
import { Dialogs } from './Dialogs';
import * as ops from '../core/model/ops';
import { applyNudge, applyPoseEdit } from '../core/assembly/solve';
import { geometryOf } from '../core/model/project';
import { DEG } from '../core/units';
import { boot, cancelTxn, clearSelection, commit, getState, heldMessage, inTxn, poseHeld, poseMissed, redo, saveCurrent, reposedMessage, select, setState, simCtl, toast, undo, useApp } from './store';
import type { Project } from '../core/model/types';

/**
 * Keyboard move / rotate of parts: the mechanism follows where it can (see applyPoseEdit); a move that the
 * joints undo completely is explained and leaves the undo history alone.
 */
function keyPose(label: string, fn: (p: Project) => Project, ids: string[], asked?: (p: Project) => Partial<Project['parts'][number]['pose']>): void {
  const before = getState().project;
  const want = asked && ids.length === 1 ? asked(before) : null;
  const edited = fn(before);
  if (poseHeld(before, edited)) { toast(heldMessage(ids.map((id) => before.parts.find((p) => p.id === id)?.name ?? id)), 'info'); return; }
  if (!commit(label, (p) => (p === before ? edited : fn(p)), { coalesce: true })) return;
  // the joints allowed only something else than the key asked for: say so, as the typed path does
  const after = getState().project;
  if (want && !getState().assemblyIssues.length && poseMissed(after, ids[0], want)) toast(reposedMessage(after, ids[0], want), 'info');
}

const NON_TEXT_INPUTS = ['checkbox', 'radio', 'range', 'color', 'file', 'button', 'submit'];

/** focus is in a control where keys are text (undo there means "undo typing") */
function isTyping(e: KeyboardEvent): boolean {
  const t = e.target as HTMLElement | null;
  if (!t) return false;
  if (t.tagName === 'INPUT') return !NON_TEXT_INPUTS.includes((t as HTMLInputElement).type);
  return t.tagName === 'TEXTAREA' || t.isContentEditable;
}

/** focus is on a control that natively uses this key (keyboard users must keep Space/Enter/arrows on buttons, checkboxes, sliders, selects) */
function nativeKey(e: KeyboardEvent): boolean {
  const t = e.target as HTMLElement | null;
  if (!t) return false;
  const k = e.key;
  const activate = k === ' ' || k === 'Enter';
  const arrows = k.startsWith('Arrow') || k === 'PageUp' || k === 'PageDown' || k === 'Home' || k === 'End';
  if (t.tagName === 'BUTTON' || t.tagName === 'A' || t.tagName === 'SUMMARY') return activate;
  if (t.tagName === 'SELECT') return activate || arrows || k.length === 1;
  if (t.tagName === 'INPUT') { const ty = (t as HTMLInputElement).type; return ty === 'range' ? arrows : NON_TEXT_INPUTS.includes(ty) && activate; }
  return false;
}

/** a mouse click should not leave keyboard focus on a button/checkbox, otherwise Space would re-press it instead of Play */
function releaseMouseFocus(e: MouseEvent): void {
  if (e.detail === 0) return; // keyboard-initiated: keep focus for keyboard users
  const el = (e.target as HTMLElement | null)?.closest?.('button, input[type="checkbox"], input[type="range"], input[type="color"], summary') as HTMLElement | null;
  if (el && document.activeElement === el && !el.closest('.modal')) el.blur();
}

function onKey(e: KeyboardEvent): void {
  const s = getState();
  const mod = e.ctrlKey || e.metaKey;
  const k = e.key.toLowerCase();
  if (mod && k === 's') { e.preventDefault(); saveCurrent(); return; }
  if (mod && k === 'o') { e.preventDefault(); setState({ dialog: 'open' }); return; }
  if (isTyping(e)) return;
  if (mod && k === 'z') { e.preventDefault(); if (e.shiftKey) redo(); else undo(); return; }
  if (mod && k === 'y') { e.preventDefault(); redo(); return; }
  if (s.dialog) return;
  if (!mod && nativeKey(e)) return;
  if (s.mode === 'sketch') return; // the sketch editor has its own keys
  const selParts = s.selection.parts;
  if (mod && k === 'd') {
    e.preventDefault();
    if (selParts.length) { let ids: string[] = []; commit('Duplicate', (p) => { const r = ops.duplicateParts(p, selParts, { dx: 15, dy: -15 }); ids = r.ids; return r.project; }, { solve: false }); if (ids.length) select({ parts: ids }); }
    return;
  }
  if (mod) return;
  const cam = (name: string) => setState((st) => ({ cameraRequest: { name, n: (st.cameraRequest?.n ?? 0) + 1 } }));
  switch (k) {
    case ' ': e.preventDefault(); simCtl.toggle(); return;
    case '.': simCtl.step(1); return;
    case 'r': simCtl.reset(); return;
    case 'escape':
      if (inTxn()) cancelTxn();
      else if (s.tool.kind !== 'select') setState({ tool: { kind: 'select' } });
      else clearSelection();
      return;
    case 'delete': case 'backspace': {
      const sel = s.selection;
      if (sel.parts.length + sel.joints.length + sel.loads.length + sel.probes.length === 0) return;
      e.preventDefault();
      commit('Delete selection', (p) => ops.removeItems(p, sel), { selection: { parts: [], joints: [], loads: [], probes: [] } });
      return;
    }
    case 'g': if (selParts.length) { const all = selParts.every((id) => s.project.parts.find((p) => p.id === id)?.grounded); commit(all ? 'Unground' : 'Ground', (p) => ({ ...p, parts: p.parts.map((x) => (selParts.includes(x.id) ? { ...x, grounded: !all } : x)) })); } return;
    case 'h': if (selParts.length) commit('Toggle suppression', (p) => ({ ...p, parts: p.parts.map((x) => (selParts.includes(x.id) ? { ...x, suppressed: !x.suppressed } : x)) }), { solve: false }); return;
    case 'q': case 'e': if (selParts.length === 1) {
      const d = (k === 'q' ? 1 : -1) * (e.shiftKey ? 1 : 15) * DEG;
      const target = (p: Project) => ({ angle: p.parts.find((x) => x.id === selParts[0])!.pose.angle + d });
      keyPose('Rotate part', (p) => applyPoseEdit(p, selParts[0], target(p)).project, selParts, target);
    } return;
    case 'arrowleft': case 'arrowright': case 'arrowup': case 'arrowdown': {
      if (!selParts.length) return;
      e.preventDefault();
      const step = e.shiftKey ? 10 : 1;
      const dx = k === 'arrowleft' ? -step : k === 'arrowright' ? step : 0, dy = k === 'arrowup' ? step : k === 'arrowdown' ? -step : 0;
      keyPose('Nudge part', (p) => applyNudge(p, selParts, dx, dy), selParts, (p) => { const q = p.parts.find((x) => x.id === selParts[0])!; return { x: q.pose.x + dx, y: q.pose.y + dy }; });
      return;
    }
    case 'pageup': case 'pagedown': {
      if (!selParts.length) return;
      e.preventDefault();
      commit('Change layer', (p) => ({ ...p, parts: p.parts.map((x) => { if (!selParts.includes(x.id)) return x; const g = geometryOf(p, x); const t = Math.max(g.zMax - g.zMin, 1); return { ...x, pose: { ...x.pose, z: Math.round((x.pose.z + (k === 'pageup' ? t : -t)) * 100) / 100 } }; }) }), { solve: false });
      return;
    }
    case 'j': setState({ tool: { kind: 'mate', type: 'revolute' } }); return;
    case 'p': setState({ tool: { kind: 'mate', type: 'prismatic' } }); return;
    case 'k': setState({ tool: { kind: 'mate', type: 'rigid' } }); return;
    case 'm': setState({ tool: s.tool.kind === 'measure' ? { kind: 'select' } : { kind: 'measure' } }); return;
    case 'b': setState({ tool: { kind: 'probe' } }); return;
    case 'o': setState({ view: { ...s.view, ortho: !s.view.ortho } }); return;
    case 'x': setState({ view: { ...s.view, transparent: !s.view.transparent } }); return;
    case 'f': cam('fit'); return;
    case '?': setState({ dialog: 'shortcuts' }); return;
    case '1': cam('front'); return;
    case '2': cam('back'); return;
    case '3': cam('top'); return;
    case '4': cam('bottom'); return;
    case '5': cam('right'); return;
    case '6': cam('left'); return;
    case '7': cam('iso'); return;
  }
}

function Toast() {
  const t = useApp((s) => s.toast);
  if (!t) return null;
  const Icon = t.kind === 'error' ? CircleAlert : t.kind === 'ok' ? CheckCircle2 : Info;
  return <div className={`toast ${t.kind}`} role={t.kind === 'error' ? 'alert' : 'status'} data-testid="toast"><Icon size={15} /><span>{t.text}</span></div>;
}

export function App({ kernelError }: { kernelError: string | null }) {
  const mode = useApp((s) => s.mode);
  const [ready, setReady] = useState(false);
  useEffect(() => {
    void boot().then(() => setReady(true));
    window.addEventListener('keydown', onKey);
    window.addEventListener('click', releaseMouseFocus);
    return () => { window.removeEventListener('keydown', onKey); window.removeEventListener('click', releaseMouseFocus); };
  }, []);
  if (kernelError) {
    return (
      <div className="fatal">
        <h1>Mechanism Workshop could not start</h1>
        <p>The geometry kernel (WebAssembly) failed to load: {kernelError}</p>
        <p>Make sure the app is served over http:// (use <code>npm start</code>) rather than opened as a file, and that your browser supports WebAssembly and WebGL 2.</p>
      </div>
    );
  }
  return (
    <div className="app" data-ready={ready}>
      <TopBar />
      <div className="workspace">
        <LeftPanel />
        <main className="center">
          <div className="center-main">
            {mode === 'sketch' ? <SketchEditor /> : <Viewport />}
          </div>
          <BottomPanel />
        </main>
        <aside className="right-panel" aria-label="Property inspector"><Inspector /></aside>
      </div>
      <StatusBar />
      <Dialogs />
      <Toast />
    </div>
  );
}
