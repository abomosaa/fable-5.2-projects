import { useEffect, useRef, useState } from 'react';
import { FolderOpen, Trash2, Upload, X } from 'lucide-react';
import * as ops from '../core/model/ops';
import { DEG } from '../core/units';
import { commit, deleteStored, newProject, openExample, openFromJSON, openStored, select, setState, useApp } from './store';
import { listProjects } from './persist';
import { NumField, Row, Seg } from './widgets';

function Modal(props: { title: string; children: React.ReactNode; wide?: boolean; testId?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    ref.current?.focus();
    const k = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { setState({ dialog: null }); e.stopPropagation(); return; }
      if (e.key !== 'Tab' || !ref.current) return;
      // keep keyboard focus inside the dialog while it is open
      const items = [...ref.current.querySelectorAll<HTMLElement>('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])')].filter((el) => !el.hasAttribute('disabled') && el.offsetParent !== null);
      if (!items.length) { e.preventDefault(); return; }
      const first = items[0], last = items[items.length - 1], active = document.activeElement as HTMLElement | null;
      if (!active || !ref.current.contains(active) || active === ref.current) { e.preventDefault(); (e.shiftKey ? last : first).focus(); }
      else if (e.shiftKey && active === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && active === last) { e.preventDefault(); first.focus(); }
    };
    window.addEventListener('keydown', k, true);
    return () => { window.removeEventListener('keydown', k, true); prev?.focus?.(); };
  }, []);
  return (
    <div className="modal-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) setState({ dialog: null }); }}>
      <div className={`modal ${props.wide ? 'wide' : ''}`} role="dialog" aria-modal="true" aria-label={props.title} tabIndex={-1} ref={ref} data-testid={props.testId}>
        <header><h2>{props.title}</h2><button className="icon-btn" aria-label="Close" title="Close (Esc)" onClick={() => setState({ dialog: null })}><X size={16} /></button></header>
        <div className="modal-body">{props.children}</div>
      </div>
    </div>
  );
}

function OpenDialog() {
  const [, force] = useState(0);
  const cur = useApp((s) => s.project.id);
  const examples = useApp((s) => s.examples);
  const fileRef = useRef<HTMLInputElement>(null);
  const list = listProjects();
  return (
    <Modal title="Open project" wide testId="dialog-open">
      <div className="open-grid">
        <section>
          <h3>Saved in this browser</h3>
          {list.length === 0 && <p className="dim">No saved projects yet.</p>}
          <ul className="proj-list">
            {list.map((e) => (
              <li key={e.id} className={e.id === cur ? 'cur' : ''}>
                <button className="proj-open" data-testid={`open-${e.name}`} onClick={() => openStored(e.id)}>
                  <FolderOpen size={14} />
                  <span className="pn">{e.name}</span>
                  <span className="dim">{e.parts} parts · {new Date(e.autosaveAt && e.autosaveAt > e.modifiedAt ? e.autosaveAt : e.modifiedAt).toLocaleString()}{e.autosaveAt && e.autosaveAt > e.modifiedAt ? ' · unsaved changes recovered from autosave' : ''}{e.id === cur ? ' · open now' : ''}</span>
                </button>
                <button className="icon-btn" title="Delete this stored project" aria-label={`Delete ${e.name}`} disabled={e.id === cur} onClick={() => { if (confirm(`Delete “${e.name}” from this browser? This cannot be undone.`)) { deleteStored(e.id); force((n) => n + 1); } }}><Trash2 size={13} /></button>
              </li>
            ))}
          </ul>
          <input ref={fileRef} type="file" accept=".json,application/json" hidden onChange={async (e) => { const f = e.target.files?.[0]; if (f) openFromJSON(await f.text(), true); }} />
          <button className="btn" onClick={() => fileRef.current?.click()}><Upload size={13} /> Import a .json project file…</button>
        </section>
        <section>
          <h3>Showcase projects</h3>
          <ul className="proj-list">
            {examples.map((ex) => (
              <li key={ex.id}><button className="proj-open" onClick={() => void openExample(ex.file)}><span className="pn">{ex.title}</span><span className="dim">{ex.blurb}</span></button></li>
            ))}
          </ul>
          <p className="hint">Showcases open as editable copies. They are ordinary project files built with the same tools.</p>
        </section>
      </div>
    </Modal>
  );
}

const SHORTCUTS: [string, [string, string][]][] = [
  ['Simulation', [['Space', 'Play / pause'], ['.', 'Single step (one fixed timestep)'], ['R', 'Reset to the designed assembly']]],
  ['Editing', [['Ctrl Z / Ctrl Shift Z', 'Undo / redo'], ['Ctrl S', 'Save project'], ['Ctrl O', 'Open project'], ['Ctrl D', 'Duplicate selection'], ['Del', 'Delete selection'], ['G', 'Toggle ground on selected parts'], ['H', 'Suppress / unsuppress selection'], ['Q / E', 'Rotate selected part ±15° (Shift: ±1°)'], ['Arrow keys', 'Nudge selected part 1 mm (Shift: 10 mm)'], ['PgUp / PgDn', 'Move selected part one layer up / down (Z)'], ['Esc', 'Cancel tool / clear selection']]],
  ['Tools', [['J', 'Pivot (revolute joint) tool'], ['P', 'Slide (prismatic joint) tool'], ['K', 'Fix (rigid joint) tool'], ['M', 'Measure tool'], ['B', 'Probe tool']]],
  ['View', [['Left-drag on empty space / Right-drag', 'Orbit'], ['Middle-drag', 'Pan'], ['Wheel', 'Zoom to cursor'], ['1 … 7', 'Front, back, top, bottom, right, left, isometric'], ['O', 'Orthographic / perspective'], ['F', 'Zoom to fit'], ['X', 'Transparent parts'], ['?', 'This help']]],
  ['Sketch mode', [['V / P / L / C / A', 'Select, point, line, circle, arc'], ['Double-click a dimension', 'Edit its value'], ['Alt while dragging', 'Disable grid snap'], ['Del', 'Delete selected geometry or constraints'], ['F', 'Zoom to fit']]],
];

function ShortcutsDialog() {
  return (
    <Modal title="Controls and keyboard shortcuts" wide testId="dialog-shortcuts">
      <div className="shortcut-grid">
        {SHORTCUTS.map(([group, rows]) => (
          <section key={group}>
            <h3>{group}</h3>
            <table><tbody>{rows.map(([k, d]) => <tr key={k}><td><kbd>{k}</kbd></td><td>{d}</td></tr>)}</tbody></table>
          </section>
        ))}
      </div>
      <p className="hint">Numeric fields accept arithmetic and units: <code>25.4</code>, <code>1 in</code>, <code>2*pi rad</code>, <code>0.4 N*m</code>, <code>120 rpm</code>. ↑/↓ nudge the value (Shift ×10, Alt ×0.1). Drag a free part so one of its holes meets another part's hole to create a pivot.</p>
    </Modal>
  );
}

function AboutDialog() {
  return (
    <Modal title="About Mechanism Workshop" wide testId="dialog-about">
      <div className="about">
        <p><b>Mechanism Workshop 1.0</b> — design planar mechanisms from parametric parts and sketches, assemble them with joints, simulate them with a constraint-based multibody solver, see why they fail, and export manufacturable parts. Runs entirely in this browser; no account, no network.</p>
        <h3>Honest limits</h3>
        <ul>
          <li>Planar (2D) rigid-body mechanics with parts stacked in Z layers. No out-of-plane motion, no flexibility, no backlash dynamics.</li>
          <li>Pins, slides, gear meshes, rack-and-pinion and belts are ideal constraints. Reaction forces are constraint multipliers of that ideal model.</li>
          <li>Contact forces exist only for the floor (Coulomb friction, inelastic) and cam–roller pairs. Other overlaps are detected and reported, not resolved.</li>
          <li>Fixed-step integration (SHAKE-type projection, second order). Accuracy depends on the timestep; stiff springs need small steps (a diagnostic warns).</li>
          <li>This is a design-exploration tool. It is <b>not</b> certified engineering analysis, structural FEA, or a manufacturing-safety check. Materials, processes, fits and real loads need human validation.</li>
        </ul>
        <h3>Third-party software</h3>
        <table className="data-table"><tbody>
          <tr><td>three.js</td><td>MIT</td><td>WebGL rendering, camera controls, environment lighting</td></tr>
          <tr><td>manifold-3d</td><td>Apache-2.0</td><td>Solid/2D boolean kernel (includes Clipper2, BSL-1.0)</td></tr>
          <tr><td>React, React DOM</td><td>MIT</td><td>User interface</td></tr>
          <tr><td>fflate</td><td>MIT</td><td>ZIP container for 3MF export</td></tr>
          <tr><td>lucide</td><td>ISC</td><td>Icons</td></tr>
          <tr><td>Inter, JetBrains Mono (Fontsource)</td><td>OFL-1.1</td><td>Typefaces, bundled</td></tr>
        </tbody></table>
        <p className="hint">Full notices: THIRD_PARTY_LICENSES.md in the project folder. No downloaded 3D assets are used; all part geometry is generated procedurally from its dimensions.</p>
      </div>
    </Modal>
  );
}

function PatternDialog() {
  const sel = useApp((s) => s.selection.parts);
  const [type, setType] = useState<'linear' | 'circular'>('linear');
  const [count, setCount] = useState(3);
  const [dx, setDx] = useState(30), [dy, setDy] = useState(0), [dz, setDz] = useState(0);
  const [cx, setCx] = useState(0), [cy, setCy] = useState(0), [ang, setAng] = useState(2 * Math.PI);
  const run = () => {
    let ids: string[] = [];
    commit(`${type === 'linear' ? 'Linear' : 'Circular'} pattern`, (p) => {
      const r = type === 'linear' ? ops.patternLinear(p, sel, count, dx, dy, dz) : ops.patternCircular(p, sel, count, cx, cy, ang);
      ids = r.ids;
      return r.project;
    }, { solve: false });
    if (ids.length) select({ parts: [...sel, ...ids] });
    setState({ dialog: null });
  };
  return (
    <Modal title="Pattern selected parts" testId="dialog-pattern">
      {sel.length === 0 ? <p>Select one or more parts first.</p> : (
        <div className="form">
          <p className="hint">Copies the {sel.length} selected part{sel.length > 1 ? 's' : ''} together with the joints between them and their joints to ground.</p>
          <Row label="Pattern"><Seg value={type} onChange={setType} options={[{ value: 'linear', label: 'Linear' }, { value: 'circular', label: 'Circular' }]} /></Row>
          <Row label="Total count"><NumField value={count} kind="count" min={2} max={50} label="Pattern count" testId="pattern-count" onCommit={(v) => setCount(Math.round(v))} /></Row>
          {type === 'linear' ? (
            <>
              <Row label="Step X"><NumField value={dx} kind="length" label="Pattern step X" onCommit={setDx} /></Row>
              <Row label="Step Y"><NumField value={dy} kind="length" label="Pattern step Y" onCommit={setDy} /></Row>
              <Row label="Step Z"><NumField value={dz} kind="length" label="Pattern step Z" onCommit={setDz} /></Row>
            </>
          ) : (
            <>
              <Row label="Centre X"><NumField value={cx} kind="length" label="Pattern centre X" onCommit={setCx} /></Row>
              <Row label="Centre Y"><NumField value={cy} kind="length" label="Pattern centre Y" onCommit={setCy} /></Row>
              <Row label="Total angle"><NumField value={ang} kind="angle" min={-2 * Math.PI} max={2 * Math.PI} label="Pattern total angle" onCommit={setAng} /></Row>
            </>
          )}
          <div className="modal-actions"><button className="btn" onClick={() => setState({ dialog: null })}>Cancel</button><button className="btn primary" data-testid="pattern-apply" onClick={run}>Create {count - 1} cop{count - 1 === 1 ? 'y' : 'ies'}</button></div>
        </div>
      )}
    </Modal>
  );
}

function WelcomeDialog() {
  const examples = useApp((s) => s.examples);
  return (
    <Modal title="Welcome to Mechanism Workshop" wide testId="dialog-welcome">
      <div className="welcome">
        <p>Design a mechanism, press Play, and find out whether it walks, slips, collides or locks up — then change a dimension and watch the real assembly respond.</p>
        <div className="welcome-cards">
          {examples.map((ex) => (
            <button key={ex.id} className="welcome-card" data-testid={`welcome-${ex.id}`} onClick={() => void openExample(ex.file)}>
              <b>{ex.title}</b><span>{ex.blurb}</span>
            </button>
          ))}
          <button className="welcome-card empty" data-testid="welcome-empty" onClick={() => setState({ dialog: null, leftTab: 'library' })}><b>Start from scratch</b><span>Add links from the Library, snap their holes together, ground one, add a motor.</span></button>
        </div>
        <p className="hint">Tip: press <kbd>?</kbd> at any time for controls. Everything is stored locally in this browser and can be exported as a file.</p>
      </div>
    </Modal>
  );
}

export function Dialogs() {
  const d = useApp((s) => s.dialog);
  if (d === 'open') return <OpenDialog />;
  if (d === 'shortcuts') return <ShortcutsDialog />;
  if (d === 'about') return <AboutDialog />;
  if (d === 'pattern') return <PatternDialog />;
  if (d === 'welcome') return <WelcomeDialog />;
  return null;
}

export { DEG, newProject };
