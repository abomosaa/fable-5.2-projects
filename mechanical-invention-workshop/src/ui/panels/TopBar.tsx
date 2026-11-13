import { useEffect, useRef, useState } from 'react';
import { BookOpen, Box, FolderOpen, HelpCircle, MousePointer2, Pause, PencilRuler, Play, Redo2, RotateCcw, Save, StepForward, Undo2, ChevronDown, FilePlus2, Copy, Upload, Download } from 'lucide-react';
import { serializeProject } from '../../core/model/project';
import { toDisplay, unitFor } from '../../core/units';
import {
  commit, duplicateProject, getState, newProject, openExample, openFromJSON, redo, renameProject, saveCurrent, setState, simCtl, undo, useApp,
} from '../store';
import { download, slug } from '../persist';
import { IconButton, Menu, MenuItem, Seg } from '../widgets';

export function TopBar() {
  const name = useApp((s) => s.project.name);
  const dirty = useApp((s) => s.dirty);
  const canUndo = useApp((s) => s.past.length > 0);
  const canRedo = useApp((s) => s.future.length > 0);
  const undoLabel = useApp((s) => s.past[s.past.length - 1]?.label);
  const redoLabel = useApp((s) => s.future[s.future.length - 1]?.label);
  const status = useApp((s) => s.simStatus);
  const speed = useApp((s) => s.simSpeed);
  const mode = useApp((s) => s.mode);
  const tool = useApp((s) => s.tool);
  const simMode = useApp((s) => s.project.sim.mode);
  const examples = useApp((s) => s.examples);
  const autosavedAt = useApp((s) => s.autosavedAt);
  const tick = useApp((s) => s.simTick);
  const [editing, setEditing] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const timeRef = useRef<HTMLSpanElement>(null);
  void tick;
  useEffect(() => {
    let raf = 0;
    const loop = () => {
      if (timeRef.current) timeRef.current.textContent = (simCtl.runner?.time ?? 0).toFixed(3);
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, []);
  const onFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    if (f) openFromJSON(await f.text(), true);
    e.target.value = '';
  };
  return (
    <header className="topbar" role="banner">
      <div className="brand" title="Mechanism Workshop"><Box size={18} strokeWidth={2.2} /><span>Mechanism Workshop</span></div>
      <Menu label={<>File <ChevronDown size={12} /></>} testId="menu-file">
        {(close) => (
          <>
            <MenuItem testId="file-new" onClick={() => { close(); newProject(); }}><FilePlus2 size={14} /> New project</MenuItem>
            <MenuItem testId="file-open" onClick={() => { close(); setState({ dialog: 'open' }); }} shortcut="Ctrl O"><FolderOpen size={14} /> Open…</MenuItem>
            <MenuItem testId="file-save" onClick={() => { close(); saveCurrent(); }} shortcut="Ctrl S"><Save size={14} /> Save</MenuItem>
            <MenuItem testId="file-duplicate" onClick={() => { close(); duplicateProject(); }}><Copy size={14} /> Duplicate project</MenuItem>
            <MenuItem testId="file-rename" onClick={() => { close(); setEditing(true); }}><PencilRuler size={14} /> Rename…</MenuItem>
            <hr />
            <MenuItem testId="file-import" onClick={() => { close(); fileRef.current?.click(); }}><Upload size={14} /> Import project file…</MenuItem>
            <MenuItem testId="file-export" onClick={() => { close(); const p = getState().project; download(`${slug(p.name)}.mechanism.json`, serializeProject(p), 'application/json'); }}><Download size={14} /> Export project file</MenuItem>
          </>
        )}
      </Menu>
      <Menu label={<>Examples <ChevronDown size={12} /></>} testId="menu-examples">
        {(close) => (
          <>
            {examples.length === 0 && <div className="menu-empty">Example projects were not found next to the app.</div>}
            {examples.map((ex) => <MenuItem key={ex.id} testId={`example-${ex.id}`} sub={ex.blurb} onClick={() => { close(); void openExample(ex.file); }}>{ex.title}</MenuItem>)}
            <hr />
            <div className="menu-empty">Examples open as editable copies; they are ordinary project files.</div>
          </>
        )}
      </Menu>
      <input ref={fileRef} type="file" accept=".json,application/json" hidden onChange={onFile} data-testid="file-input" />
      <div className="proj-name">
        {editing ? (
          <input autoFocus defaultValue={name} aria-label="Project name" data-testid="project-name-input"
            onBlur={(e) => { setEditing(false); renameProject(e.target.value); }}
            onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); if (e.key === 'Escape') setEditing(false); e.stopPropagation(); }} />
        ) : (
          <button className="proj-btn" title="Click to rename" data-testid="project-name" onClick={() => setEditing(true)}>{name}</button>
        )}
        <span className={`save-state ${dirty ? 'dirty' : ''}`} data-testid="save-state" title={dirty ? (autosavedAt ? `Unsaved changes — autosaved ${new Date(autosavedAt).toLocaleTimeString()}` : 'Unsaved changes') : 'All changes saved'}>{dirty ? (autosavedAt ? 'autosaved' : 'edited') : 'saved'}</span>
      </div>
      <div className="tb-group">
        <IconButton title={canUndo ? `Undo ${undoLabel} (Ctrl+Z)` : 'Nothing to undo'} disabled={!canUndo} onClick={undo} testId="undo"><Undo2 size={16} /></IconButton>
        <IconButton title={canRedo ? `Redo ${redoLabel} (Ctrl+Shift+Z)` : 'Nothing to redo'} disabled={!canRedo} onClick={redo} testId="redo"><Redo2 size={16} /></IconButton>
        <IconButton title="Save (Ctrl+S)" onClick={saveCurrent} testId="save"><Save size={16} /></IconButton>
      </div>
      <div className="tb-group">
        <Seg value={mode} testId="mode" onChange={(m) => setState((s) => ({ mode: m, activeSketch: m === 'sketch' ? s.activeSketch ?? s.project.sketches[0]?.id ?? null : s.activeSketch }))} options={[{ value: 'assemble', label: 'Assemble', title: 'Place, mate and simulate parts in 3D' }, { value: 'sketch', label: 'Sketch', title: 'Draw constrained 2D profiles to extrude' }]} />
        <IconButton title="Select / move (Esc)" active={tool.kind === 'select'} onClick={() => setState({ tool: { kind: 'select' } })}><MousePointer2 size={16} /></IconButton>
      </div>
      <span className="spacer" />
      <div className="tb-group sim" role="group" aria-label="Simulation controls">
        <Seg value={simMode} testId="top-sim-mode" onChange={(m) => commit('Change simulation mode', (p) => ({ ...p, sim: { ...p.sim, mode: m } }), { solve: false })} options={[{ value: 'kinematic', label: 'Kinematic', title: 'Geometry only: motors prescribe motion, no forces' }, { value: 'dynamic', label: 'Dynamic', title: 'Forces, gravity, friction, contact, motor limits' }]} />
        <button className={`play ${status === 'running' ? 'running' : ''}`} data-testid="play" disabled={status === 'ended' || mode === 'sketch'} title={status === 'running' ? 'Pause (Space)' : status === 'ended' ? 'Run ended — Reset to run again' : 'Play (Space)'} onClick={() => simCtl.toggle()}>
          {status === 'running' ? <Pause size={16} /> : <Play size={16} />}<span>{status === 'running' ? 'Pause' : 'Play'}</span>
        </button>
        <IconButton title="Single step: advance one fixed timestep (.)" disabled={status === 'ended' || status === 'running' || mode === 'sketch'} onClick={() => simCtl.step(1)} testId="step"><StepForward size={16} /></IconButton>
        <IconButton title="Reset simulation to the designed assembly (R)" disabled={status === 'idle'} onClick={() => simCtl.reset()} testId="reset"><RotateCcw size={16} /></IconButton>
        <label className="speed" title="Playback speed (simulated seconds per wall-clock second)">
          <select value={String(speed)} aria-label="Playback speed" data-testid="speed" onChange={(e) => setState({ simSpeed: parseFloat(e.target.value) })}>
            {[0.05, 0.1, 0.25, 0.5, 1, 2, 4].map((v) => <option key={v} value={v}>{v}×</option>)}
          </select>
        </label>
        <div className={`sim-time ${status}`} title="Simulated time" data-testid="sim-time"><span ref={timeRef}>0.000</span> s<em>{status === 'idle' ? 'design' : status}</em></div>
      </div>
      <IconButton title="Keyboard shortcuts and controls (?)" onClick={() => setState({ dialog: 'shortcuts' })}><HelpCircle size={16} /></IconButton>
      <IconButton title="About, licences and simulation limits" onClick={() => setState({ dialog: 'about' })}><BookOpen size={16} /></IconButton>
    </header>
  );
}

export function StatusBar() {
  const tick = useApp((s) => s.simTick);
  const project = useApp((s) => s.project);
  const sel = useApp((s) => s.selection);
  const status = useApp((s) => s.simStatus);
  const tool = useApp((s) => s.tool);
  void tick;
  const r = simCtl.runner && simCtl.runner.project === project ? simCtl.runner : null;
  const nSel = sel.parts.length + sel.joints.length + sel.loads.length + sel.probes.length;
  const selText = sel.parts.length === 1 ? project.parts.find((p) => p.id === sel.parts[0])?.name : sel.joints.length === 1 && !sel.parts.length ? project.joints.find((j) => j.id === sel.joints[0])?.name : nSel ? `${nSel} items` : 'nothing';
  return (
    <footer className="statusbar" role="contentinfo">
      <span title="Current selection">Selected: <b>{selText}</b></span>
      <span>{project.parts.filter((p) => !p.suppressed).length} parts · {project.joints.filter((j) => !j.suppressed).length} joints</span>
      {r && <span title="Degrees of freedom from the rank of the constraint Jacobian (with motors released)">Mobility: <b>{r.dof} DOF</b></span>}
      {r && <span title="Largest joint position residual after the last solver step">Joint error: <b className="mono">{toDisplay(r.sim.stats.posError, 'length', project.units).toExponential(1)} {unitFor('length', project.units)}</b></span>}
      {r && status !== 'idle' && <span title="Wall-clock time per fixed step / achieved real-time factor">Step: <b className="mono">{r.stepTimeAvgMs.toFixed(3)} ms</b> · <b className="mono">{simCtl.realtimeFactor.toFixed(2)}×</b> real time</span>}
      <span className="spacer" />
      <span className="dim">{tool.kind === 'select' ? 'Left-drag part: move / pose · Left-drag empty or right-drag: orbit · Middle-drag: pan · Wheel: zoom' : 'Esc: cancel tool'}</span>
      <span className="dim mono" title="Display units (files and the solver always use mm · kg · s · rad)">{unitFor('length', project.units)} · {unitFor('mass', project.units)} · {unitFor('force', project.units)} · {unitFor('torque', project.units)}</span>
    </footer>
  );
}
