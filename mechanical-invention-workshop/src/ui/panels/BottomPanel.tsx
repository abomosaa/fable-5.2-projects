import { useMemo, useState } from 'react';
import { AlertTriangle, CheckCircle2, ChevronDown, ChevronUp, CircleAlert, Download, FileText, Gauge, Info, Layers, LineChart, PackageCheck, Stethoscope, Wrench, Pencil } from 'lucide-react';
import type { Diagnostic } from '../../core/assembly/compile';
import { PART_DEFS } from '../../core/parts/catalog';
import { formatQuantity, toDisplay, unitFor } from '../../core/units';
import { serializeProject } from '../../core/model/project';
import * as ex from '../../core/export';
import { commit, getState, select, setState, simCtl, toast, useApp } from '../store';
import { download, slug } from '../persist';
import { viewRef } from '../viewport/Viewport';
import { PlotsPanel } from './Plots';
import { TextField } from '../widgets';
import { SimRunner } from '../../core/sim/runner';
import { autoLayer } from '../../core/assembly/autolayer';

const SEV_ICON = { error: CircleAlert, warning: AlertTriangle, info: Info } as const;
const SEV_LABEL = { error: 'Error', warning: 'Warning', info: 'Note' } as const;

export function useDiagnostics(): Diagnostic[] {
  const tick = useApp((s) => s.simTick);
  const project = useApp((s) => s.project);
  const asm = useApp((s) => s.assemblyIssues);
  return useMemo(() => {
    const r = simCtl.runner && simCtl.runner.project === project ? simCtl.runner : null;
    const list = [...asm, ...(r ? r.allDiagnostics() : [])];
    const seen = new Set<string>();
    const out: Diagnostic[] = [];
    for (const d of list) { const k = `${d.code}|${d.title}`; if (seen.has(k)) continue; seen.add(k); out.push(d); }
    const rank = { error: 0, warning: 1, info: 2 };
    return out.sort((a, b) => rank[a.severity] - rank[b.severity]);
  }, [tick, project, asm]);
}

function DiagnosticsPanel() {
  const diags = useDiagnostics();
  const project = useApp((s) => s.project);
  const tick = useApp((s) => s.simTick);
  const status = useApp((s) => s.simStatus);
  const r = simCtl.runner && simCtl.runner.project === project ? simCtl.runner : null;
  void tick;
  const errs = diags.filter((d) => d.severity === 'error').length, warns = diags.filter((d) => d.severity === 'warning').length;
  const show = (d: Diagnostic) => { setState({ focus: { parts: d.parts, joints: d.joints } }); if (d.parts.length || d.joints.length) select({ parts: d.parts, joints: d.parts.length ? [] : d.joints.slice(0, 1) }); setState({ focus: { parts: d.parts, joints: d.joints } }); };
  return (
    <div className="diag">
      <div className="diag-summary">
        <div className={`pill ${errs ? 'error' : warns ? 'warning' : 'ok'}`}>{errs ? <CircleAlert size={13} /> : warns ? <AlertTriangle size={13} /> : <CheckCircle2 size={13} />}{errs ? `${errs} error${errs > 1 ? 's' : ''}` : warns ? `${warns} warning${warns > 1 ? 's' : ''}` : 'No problems found'}</div>
        {r && (
          <>
            <div className="kv" title="Degrees of freedom of the assembly with motors released, from the rank of the constraint Jacobian"><span>Mobility</span><b data-testid="dof">{r.dof} DOF</b></div>
            <div className="kv" title="Degrees of freedom left after ideal (kinematic) motors are applied"><span>Undriven</span><b>{r.dofDriven}</b></div>
            <div className="kv" title="Moving rigid bodies (rigidly attached parts are merged) / scalar joint constraint equations"><span>Bodies / constraints</span><b>{r.model.bodies.length} / {r.sim.mB}</b></div>
            <div className="kv" title="Largest positional joint constraint residual after the last step"><span>Joint error</span><b data-testid="joint-error">{toDisplay(r.sim.stats.posError, 'length', project.units).toExponential(1)} {unitFor('length', project.units)}</b></div>
            <div className="kv" title="Largest residual over the whole run"><span>Max over run</span><b>{toDisplay(r.sim.stats.maxPosError, 'length', project.units).toExponential(1)} {unitFor('length', project.units)}</b></div>
            <div className="kv"><span>Mode</span><b>{r.model.mode}</b></div>
          </>
        )}
        <span className="spacer" />
        <button className="btn small" data-testid="auto-layer" disabled={status === 'running'} title="Resolve part-to-part interference by raising parts along Z: sweeps the mechanism kinematically and moves a part up only when it would otherwise overlap another" onClick={() => {
          let n = 0;
          const ok = commit('Auto-stack layers', (p) => { const r = autoLayer(p); n = r.moved.length; return r.project; }, { solve: false });
          toast(ok ? `Moved ${n} part${n === 1 ? '' : 's'} to a higher layer to clear interference. (Ctrl+Z to undo)` : 'No overlapping parts found over the motion: layers left unchanged.', ok ? 'ok' : 'info');
        }}><Layers size={12} /> Auto-stack layers</button>
        <button className="btn small" data-testid="solve-assembly" disabled={status === 'running'} onClick={() => { const ok = commit('Solve assembly', (p) => ({ ...p }), { quiet: true }); const bad = getState().assemblyIssues.length > 0; toast(bad ? 'The assembly cannot be closed — see the diagnosis below.' : ok ? 'Assembly solved: parts were moved so that all joints are closed.' : 'All joints are already closed; nothing had to move.', bad ? 'error' : 'ok'); }}><Wrench size={12} /> Solve assembly</button>
      </div>
      <div className="diag-list" data-testid="diagnostics">
        {diags.length === 0 && <div className="empty-list wide"><CheckCircle2 size={20} /><p>No problems found in the current design{r && r.sim.stepCount > 0 ? ' or run' : ''}.</p><p className="dim">Interference, impossible assemblies, dead-centres, stalls and contact loss appear here with an explanation.</p></div>}
        {diags.map((d, i) => { const Icon = SEV_ICON[d.severity]; return (
          <button key={i} className={`diag-item ${d.severity}`} data-testid={`diag-${d.code}`} onClick={() => show(d)} title="Click to highlight the parts and joints involved">
            <span className="diag-sev"><Icon size={14} /> {SEV_LABEL[d.severity]}</span>
            <span className="diag-body"><b>{d.title}</b>{d.time !== undefined && d.time > 0 && <span className="diag-time">t = {d.time.toFixed(3)} s</span>}<span className="diag-detail">{d.detail}</span></span>
          </button>
        ); })}
      </div>
    </div>
  );
}

function NotesPanel() {
  const project = useApp((s) => s.project);
  const [edit, setEdit] = useState(false);
  return (
    <div className="notes">
      <div className="notes-main">
        <header><h3>{project.name}</h3><button className="btn small" onClick={() => setEdit(!edit)}><Pencil size={12} /> {edit ? 'Done' : 'Edit notes'}</button></header>
        {edit ? <TextField multiline value={project.description} label="Project notes" onCommit={(description) => commit('Edit notes', (p) => ({ ...p, description }), { solve: false })} />
          : project.description ? project.description.split(/\n\s*\n/).map((para, i) => <p key={i}>{para}</p>) : <p className="dim">No notes for this project. Use “Edit notes” to describe what it is and what to try.</p>}
      </div>
      <aside className="notes-side">
        <h4>What the simulation is — and is not</h4>
        <ul>
          <li><b>Planar rigid bodies.</b> Motion happens in the XY plane; Z only stacks parts into layers.</li>
          <li><b>Joints are ideal constraints</b> solved exactly each step; gear, rack and belt couplings are ideal rolling relations, not tooth or belt contact.</li>
          <li><b>Contact forces</b> exist for the floor (with Coulomb friction) and cam–roller pairs. Other part overlaps are detected and reported, not resolved.</li>
          <li><b>Not</b> structural analysis, fatigue, tolerance or safety verification. Loads, materials and processes need human validation before anything is built or relied on.</li>
        </ul>
      </aside>
    </div>
  );
}

function ExportPanel() {
  const project = useApp((s) => s.project);
  const sel = useApp((s) => s.selection.parts);
  const custom = project.parts.filter((p) => !p.suppressed && !PART_DEFS[p.kind].purchased);
  const chosen = sel.length ? project.parts.filter((p) => sel.includes(p.id)) : custom;
  const reports = useMemo(() => chosen.slice(0, 60).map((p) => { try { return ex.checkPrintable(project, p); } catch (e) { return { partId: p.id, name: p.name, exportable: false, mesh: null, kernelStatus: String(e), size: [0, 0, 0] as [number, number, number], volume: 0, issues: [{ severity: 'error' as const, message: `Geometry kernel failed: ${(e as Error).message}` }] }; } }), [project, sel.join()]);
  const bom = useMemo(() => ex.buildBOM(project), [project]);
  const base = slug(project.name);
  const one = chosen.length === 1 ? chosen[0] : null;
  const doStl = () => {
    let n = 0;
    const skipped: { name: string; why: string }[] = [];
    for (const p of chosen) {
      const r = ex.exportPartSTL(project, p.id);
      if (r.ok && r.bytes) { download(r.filename, r.bytes, 'model/stl'); n++; } else skipped.push({ name: p.name, why: r.report.issues.find((i) => i.severity === 'error')?.message ?? 'not a closed solid' });
    }
    if (skipped.length === 1 && n === 0) toast(`${skipped[0].name} was NOT exported: ${skipped[0].why}`, 'error');
    else if (skipped.length) toast(`Exported ${n} STL file${n === 1 ? '' : 's'} (millimetres). NOT exported (see Export check): ${skipped.map((x) => x.name).join(', ')}.`, 'error');
    else if (n) toast(`Exported ${n} STL file${n > 1 ? 's' : ''} (millimetres).`, 'ok');
  };
  const do3mf = () => {
    const r = ex.exportParts3MF(project, chosen.map((p) => p.id));
    const skipped = r.reports.filter((x) => !x.exportable).map((x) => x.name);
    if (r.ok && r.bytes) {
      download(r.filename, r.bytes, 'model/3mf');
      const n = r.reports.filter((x) => x.exportable).length;
      if (skipped.length) toast(`3MF written with ${n} of ${r.reports.length} parts. NOT included (see Export check): ${skipped.join(', ')}.`, 'error');
      else toast(`3MF written with ${n} object(s).`, 'ok');
    } else toast('Nothing exportable in the selection (see the check results).', 'error');
  };
  /** 2D outputs of a part whose geometry could not be built as specified are refused like its solid */
  const export2d = (kind: 'drawing' | 'dxf' | 'svg') => {
    if (!one) return;
    const rep = reports.find((x) => x.partId === one.id);
    if (rep && !rep.exportable) { toast(`${one.name} was NOT exported: ${rep.issues.find((i) => i.severity === 'error')?.message ?? 'the part is invalid'}`, 'error'); return; }
    if (kind === 'drawing') download(`${ex.partFileBase(project, one)}_drawing.svg`, ex.partDrawingSVG(project, one.id), 'image/svg+xml');
    else if (kind === 'dxf') download(`${ex.partFileBase(project, one)}_profile.dxf`, ex.partProfileDXF(project, one.id), 'image/vnd.dxf');
    else download(`${ex.partFileBase(project, one)}_profile.svg`, ex.partProfileSVG(project, one.id), 'image/svg+xml');
  };
  const u = project.units;
  return (
    <div className="export">
      <div className="export-actions">
        <h4>{sel.length ? `${chosen.length} selected part${chosen.length > 1 ? 's' : ''}` : `All ${custom.length} custom parts`}</h4>
        <p className="hint">Select parts in the viewport or tree to export only those. Purchased components are listed in the BOM instead.</p>
        <div className="btn-grid">
          <button className="btn" data-testid="export-stl" disabled={!chosen.length} onClick={doStl}><Download size={13} /> STL (per part)</button>
          <button className="btn" data-testid="export-3mf" disabled={!chosen.length} onClick={do3mf}><Download size={13} /> 3MF (one file)</button>
          <button className="btn" data-testid="export-drawing" disabled={!one} title={one ? '' : 'Select exactly one part'} onClick={() => export2d('drawing')}><FileText size={13} /> Drawing (SVG)</button>
          <button className="btn" data-testid="export-dxf" disabled={!one} title={one ? '' : 'Select exactly one part'} onClick={() => export2d('dxf')}><FileText size={13} /> Cut profile (DXF)</button>
          <button className="btn" data-testid="export-profile-svg" disabled={!one} title={one ? '' : 'Select exactly one part'} onClick={() => export2d('svg')}><FileText size={13} /> Cut profile (SVG)</button>
          <button className="btn" data-testid="export-bom" onClick={() => download(`${base}_bom.csv`, ex.bomCSV(bom), 'text/csv')}><Download size={13} /> BOM (CSV)</button>
          <button className="btn" data-testid="export-guide" onClick={() => download(`${base}_assembly-guide.html`, ex.assemblyGuideHTML(project), 'text/html')}><Download size={13} /> Assembly guide (HTML)</button>
          <button className="btn" data-testid="export-project" onClick={() => download(`${base}.mechanism.json`, serializeProject(project), 'application/json')}><Download size={13} /> Project file (JSON)</button>
        </div>
        <p className="hint">{ex.HUMAN_VALIDATION_NOTE}</p>
      </div>
      <div className="export-checks">
        <h4>Export check</h4>
        <div className="check-list">
          {reports.length === 0 && <p className="dim">No custom parts to check.</p>}
          {reports.map((r) => {
            const part = project.parts.find((p) => p.id === r.partId)!;
            const worst = r.issues.some((i) => i.severity === 'error') ? 'error' : r.issues.some((i) => i.severity === 'warning') ? 'warning' : 'ok';
            return (
              <details key={r.partId} className={`check-item ${worst}`} data-testid={`check-${r.partId}`}>
                <summary>
                  {worst === 'error' ? <CircleAlert size={13} /> : worst === 'warning' ? <AlertTriangle size={13} /> : <CheckCircle2 size={13} />}
                  <b>{ex.partNumber(project, r.partId)} {r.name}</b>
                  <span className="dim mono">{r.size.map((v) => formatQuantity(v, 'length', u, 4).split(' ')[0]).join(' × ')} {unitFor('length', u)} · {formatQuantity(r.volume, 'volume', u)}{r.mesh ? ` · ${r.mesh.triangles} tris · ${r.mesh.closed ? 'closed manifold' : 'NOT CLOSED'}` : ''}</span>
                  {PART_DEFS[part.kind].purchased && <span className="badge buy">purchased</span>}
                </summary>
                <ul>{r.issues.map((i, k) => <li key={k} className={i.severity}>{i.severity === 'error' ? 'Error: ' : i.severity === 'warning' ? 'Warning: ' : ''}{i.message}</li>)}</ul>
              </details>
            );
          })}
        </div>
      </div>
      <div className="export-bom">
        <h4>Bill of materials</h4>
        <table className="data-table bom" data-testid="bom-table">
          <thead><tr><th>#</th><th>Part no.</th><th>Qty</th><th>Item</th><th>Type</th><th>Specification</th><th>Material / process</th></tr></thead>
          <tbody>
            {bom.map((row) => (
              <tr key={row.item}><td>{row.item}</td><td className="mono">{row.partNumbers.slice(0, 4).join(', ')}{row.partNumbers.length > 4 ? '…' : ''}</td><td>{row.qty}</td><td>{row.name}</td><td><span className={`badge ${row.category === 'custom' ? 'make' : 'buy'}`}>{row.category}</span></td><td>{row.spec}{/NOT BUILDABLE/.test(row.note) && <span className="bom-bad" title={row.note}> — not buildable as specified (see Export check)</span>}</td><td>{[row.material, row.process].filter(Boolean).join(' · ')}</td></tr>
            ))}
            {bom.length === 0 && <tr><td colSpan={7} className="dim">Nothing to build yet.</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function PerformancePanel() {
  useApp((s) => s.simTick);
  const project = useApp((s) => s.project);
  const [bench, setBench] = useState<string | null>(null);
  const r = simCtl.runner && simCtl.runner.project === project ? simCtl.runner : null;
  const sv = viewRef.current;
  const st = sv?.stats();
  const gl = useMemo(() => {
    try {
      const g = sv?.renderer.getContext();
      if (!g) return 'n/a';
      const ext = g.getExtension('WEBGL_debug_renderer_info');
      return ext ? String(g.getParameter(ext.UNMASKED_RENDERER_WEBGL)) : String(g.getParameter(g.RENDERER));
    } catch { return 'n/a'; }
  }, [sv]);
  const runBench = () => {
    const rr = new SimRunner(project, { interference: false });
    const n = Math.min(4000, Math.round(2 / rr.dt));
    const t0 = performance.now();
    const done = rr.advance(n);
    const ms = performance.now() - t0;
    const rr2 = new SimRunner(project);
    const t1 = performance.now();
    const done2 = rr2.advance(n);
    const ms2 = performance.now() - t1;
    setBench(`${done} steps of ${(rr.dt * 1000).toFixed(3)} ms in ${ms.toFixed(1)} ms → ${(ms / Math.max(done, 1)).toFixed(4)} ms/step solver only (${((done * rr.dt * 1000) / ms).toFixed(1)}× real time); with interference checks ${(ms2 / Math.max(done2, 1)).toFixed(4)} ms/step. Max joint error ${rr.sim.stats.maxPosError.toExponential(2)} mm. Status: ${rr.sim.status}.`);
  };
  const row = (k: string, v: string, title?: string) => <tr title={title}><td>{k}</td><td className="mono">{v}</td></tr>;
  return (
    <div className="perf">
      <table className="data-table">
        <thead><tr><th colSpan={2}>Live measurements (this session)</th></tr></thead>
        <tbody>
          {row('Viewport frame rate', `${simCtl.fps.toFixed(0)} fps`)}
          {row('Frame time (sim + render), avg / recent max', `${simCtl.frameMs.toFixed(2)} / ${simCtl.frameMsMax.toFixed(2)} ms`)}
          {row('Solver step, avg / max', r ? `${r.stepTimeAvgMs.toFixed(4)} / ${r.stepTimeMaxMs.toFixed(3)} ms` : '—', 'Wall-clock time of one fixed physical step')}
          {row('Physical timestep', r ? `${(r.dt * 1000).toFixed(3)} ms (${(1 / r.dt).toFixed(0)} Hz), render-independent` : '—')}
          {row('Steps in last frame', `${simCtl.stepsLastFrame}`)}
          {row('Real-time factor', `${simCtl.realtimeFactor.toFixed(2)}×`, 'Simulated time advanced per wall-clock second (target = playback speed)')}
          {row('Bodies / joint equations / bounded rows', r ? `${r.model.bodies.length} / ${r.sim.mB} / ${r.sim.stats.boundedRows}` : '—')}
          {row('Projection iterations / contact solver iterations', r ? `${r.sim.stats.projIterations} / ${r.sim.stats.pgsIterations}` : '—')}
          {row('Joint error now / max over run', r ? `${r.sim.stats.posError.toExponential(2)} / ${r.sim.stats.maxPosError.toExponential(2)} mm` : '—')}
          {row('Drift removed by projection (last step)', r ? `${r.sim.stats.driftBefore.toExponential(2)} mm` : '—')}
          {row('Interference candidate pairs', r?.checker ? `${r.checker.candidatePairs}` : '—')}
          {row('Scene', st ? `${st.parts} parts, ${st.triangles.toLocaleString()} triangles, ${st.calls} draw calls` : '—')}
        </tbody>
      </table>
      <div className="perf-side">
        <table className="data-table">
          <thead><tr><th colSpan={2}>Hardware & settings</th></tr></thead>
          <tbody>
            {row('GPU / renderer', gl)}
            {row('Logical CPU cores', String(navigator.hardwareConcurrency ?? 'n/a'))}
            {row('Device pixel ratio / canvas', `${window.devicePixelRatio} / ${sv?.renderer.domElement.width ?? 0} × ${sv?.renderer.domElement.height ?? 0}`)}
            {row('Browser', navigator.userAgent.replace(/^Mozilla\/5.0 /, '').slice(0, 90))}
          </tbody>
        </table>
        <button className="btn" data-testid="run-benchmark" onClick={runBench}><Gauge size={13} /> Benchmark this project (2 s of simulated time)</button>
        {bench && <p className="bench-result" data-testid="bench-result">{bench}</p>}
        <p className="hint">Numbers are measured live on this machine; nothing here is pre-recorded.</p>
      </div>
    </div>
  );
}

export function BottomPanel() {
  const tab = useApp((s) => s.bottomTab);
  const open = useApp((s) => s.bottomOpen);
  const diags = useDiagnostics();
  const errs = diags.filter((d) => d.severity === 'error').length, warns = diags.filter((d) => d.severity === 'warning').length;
  const T = (id: typeof tab, label: string, Icon: any, extra?: React.ReactNode) => (
    <button role="tab" aria-selected={tab === id && open} className={tab === id && open ? 'on' : ''} data-testid={`btab-${id}`} onClick={() => setState({ bottomTab: id, bottomOpen: tab === id ? !open : true })}><Icon size={14} /> {label}{extra}</button>
  );
  return (
    <section className={`bottom-panel ${open ? '' : 'closed'}`} aria-label="Plots, diagnostics and export">
      <div className="tabs" role="tablist">
        {T('notes', 'Notes', FileText)}
        {T('plots', 'Plots', LineChart)}
        {T('diagnostics', 'Diagnostics', Stethoscope, errs ? <span className="tab-count error">{errs}</span> : warns ? <span className="tab-count warning">{warns}</span> : null)}
        {T('export', 'Manufacture', PackageCheck)}
        {T('performance', 'Performance', Gauge)}
        <span className="spacer" />
        <button className="icon-btn" title={open ? 'Collapse panel' : 'Expand panel'} aria-label="Toggle bottom panel" onClick={() => setState({ bottomOpen: !open })}>{open ? <ChevronDown size={14} /> : <ChevronUp size={14} />}</button>
      </div>
      {open && (
        <div className="bottom-body" role="tabpanel">
          {tab === 'plots' && <PlotsPanel />}
          {tab === 'diagnostics' && <DiagnosticsPanel />}
          {tab === 'notes' && <NotesPanel />}
          {tab === 'export' && <ExportPanel />}
          {tab === 'performance' && <PerformancePanel />}
        </div>
      )}
    </section>
  );
}
