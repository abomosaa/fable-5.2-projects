/**
 * Time-series plots of probe channels. One y-axis per chart: channels with
 * different units are split into stacked small multiples that share the time
 * axis. Series colours follow the channel's slot in the plot (validated dark
 * categorical palette); text never wears a series colour.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { Download, History, Table2, Trash2, X } from 'lucide-react';
import type { PlotSpec } from '../../core/model/types';
import { formatNumber, toDisplay, unitFor, type QuantityKind } from '../../core/units';
import { PROVENANCE_LABEL, type Series } from '../../core/sim/runner';
import { channelKey, commit, simCtl, useApp, getState } from '../store';
import { download, slug } from '../persist';
import { IconButton, Seg } from '../widgets';

/** dark-surface categorical palette (validated: lightness band, chroma, CVD ΔE, contrast ≥ 3:1 on #181a1e) */
export const SERIES = ['#3987e5', '#d95926', '#199e70', '#c98500', '#d55181', '#008300', '#9085e9', '#e66767'];
const SURFACE = '#181a1e', GRID = '#2a2d34', AXIS = '#3a3e47', TEXT = '#c3c6cd', MUTED = '#8b909a';

interface Drawn { label: string; color: string; t: Float64Array; y: Float64Array; prev?: { t: Float64Array; y: Float64Array }; series: Series }

function niceTicks(lo: number, hi: number, n: number): number[] {
  if (!(hi > lo)) { const d = Math.abs(lo) > 0 ? Math.abs(lo) * 0.1 : 1; lo -= d; hi += d; }
  const span = hi - lo;
  const raw = span / n;
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const norm = raw / mag;
  const step = (norm < 1.5 ? 1 : norm < 3.5 ? 2 : norm < 7.5 ? 5 : 10) * mag;
  const out: number[] = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi + step * 1e-9; v += step) out.push(Math.abs(v) < step * 1e-9 ? 0 : v);
  return out;
}

function Chart({ items, kind, tMin, tMax, hoverT, onHover, height }: { items: Drawn[]; kind: QuantityKind; tMin: number; tMax: number; hoverT: number | null; onHover: (t: number | null) => void; height: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const wrap = useRef<HTMLDivElement>(null);
  const [w, setW] = useState(300);
  const units = useApp((s) => s.project.units);
  const unit = unitFor(kind, units);
  useEffect(() => {
    const ro = new ResizeObserver((e) => setW(Math.max(120, Math.floor(e[0].contentRect.width))));
    if (wrap.current) ro.observe(wrap.current);
    return () => ro.disconnect();
  }, []);
  const padL = 54, padR = 10, padT = 8, padB = 20;
  const conv = (v: number) => toDisplay(v, kind, units);
  // y range over the visible window
  const range = useMemo(() => {
    let lo = Infinity, hi = -Infinity;
    const scan = (t: Float64Array, y: Float64Array) => {
      for (let i = 0; i < t.length; i++) { if (t[i] < tMin || t[i] > tMax) continue; const v = y[i]; if (!Number.isFinite(v)) continue; if (v < lo) lo = v; if (v > hi) hi = v; }
    };
    for (const it of items) { scan(it.t, it.y); if (it.prev) scan(it.prev.t, it.prev.y); }
    if (lo === Infinity) { lo = 0; hi = 1; }
    lo = conv(lo); hi = conv(hi);
    if (lo > hi) [lo, hi] = [hi, lo];
    const pad = (hi - lo) * 0.08 || Math.max(Math.abs(hi) * 0.05, 1e-6);
    return { lo: lo - pad, hi: hi + pad };
  }, [items, tMin, tMax, units]);

  useEffect(() => {
    const c = ref.current;
    if (!c) return;
    const dpr = window.devicePixelRatio || 1;
    c.width = Math.round(w * dpr); c.height = Math.round(height * dpr);
    const ctx = c.getContext('2d')!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = SURFACE; ctx.fillRect(0, 0, w, height);
    const pw = w - padL - padR, ph = height - padT - padB;
    const X = (t: number) => padL + ((t - tMin) / Math.max(tMax - tMin, 1e-9)) * pw;
    const Y = (v: number) => padT + (1 - (v - range.lo) / Math.max(range.hi - range.lo, 1e-12)) * ph;
    ctx.font = '10.5px "JetBrains Mono Variable", ui-monospace, monospace';
    ctx.lineWidth = 1;
    // grid + y ticks
    const yt = niceTicks(range.lo, range.hi, Math.max(2, Math.floor(ph / 26)));
    ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
    for (const v of yt) {
      const y = Math.round(Y(v)) + 0.5;
      ctx.strokeStyle = v === 0 ? AXIS : GRID; ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(w - padR, y); ctx.stroke();
      ctx.fillStyle = MUTED; ctx.fillText(formatNumber(v, 4), padL - 6, y);
    }
    const xt = niceTicks(tMin, tMax, Math.max(2, Math.floor(pw / 70)));
    ctx.textAlign = 'center'; ctx.textBaseline = 'top';
    for (const v of xt) {
      const x = Math.round(X(v)) + 0.5;
      ctx.strokeStyle = GRID; ctx.beginPath(); ctx.moveTo(x, padT); ctx.lineTo(x, padT + ph); ctx.stroke();
      ctx.fillStyle = MUTED; ctx.fillText(`${formatNumber(v, 4)} s`, x, padT + ph + 5);
    }
    ctx.strokeStyle = AXIS; ctx.strokeRect(padL + 0.5, padT + 0.5, pw, ph);
    ctx.save();
    ctx.beginPath(); ctx.rect(padL, padT, pw, ph); ctx.clip();
    const line = (t: Float64Array, y: Float64Array, color: string, dashed: boolean) => {
      ctx.strokeStyle = color; ctx.lineWidth = dashed ? 1.5 : 2; ctx.lineJoin = 'round';
      ctx.setLineDash(dashed ? [5, 4] : []);
      ctx.globalAlpha = dashed ? 0.6 : 1;
      ctx.beginPath();
      let pen = false;
      // decimate to ~2 points per pixel using min/max per column
      const n = t.length;
      const stride = Math.max(1, Math.floor(n / (pw * 2)));
      for (let i = 0; i < n; i += stride) {
        if (t[i] < tMin - 1e-9 || t[i] > tMax + 1e-9) continue;
        let v = y[i];
        if (stride > 1) { let mn = Infinity, mx = -Infinity; for (let k = i; k < Math.min(n, i + stride); k++) { const q = y[k]; if (q < mn) mn = q; if (q > mx) mx = q; } if (Number.isFinite(mn)) { const px = X(t[i]); if (!pen) { ctx.moveTo(px, Y(conv(mn))); pen = true; } else ctx.lineTo(px, Y(conv(mn))); ctx.lineTo(px, Y(conv(mx))); continue; } v = NaN; }
        if (!Number.isFinite(v)) { pen = false; continue; }
        const px = X(t[i]), py = Y(conv(v));
        if (!pen) { ctx.moveTo(px, py); pen = true; } else ctx.lineTo(px, py);
      }
      ctx.stroke();
      ctx.setLineDash([]); ctx.globalAlpha = 1;
    };
    for (const it of items) if (it.prev) line(it.prev.t, it.prev.y, it.color, true);
    for (const it of items) line(it.t, it.y, it.color, false);
    if (hoverT !== null && hoverT >= tMin && hoverT <= tMax) {
      const x = Math.round(X(hoverT)) + 0.5;
      ctx.strokeStyle = '#6b7280'; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(x, padT); ctx.lineTo(x, padT + ph); ctx.stroke();
      for (const it of items) {
        const i = nearest(it.t, hoverT);
        if (i < 0 || !Number.isFinite(it.y[i])) continue;
        ctx.fillStyle = SURFACE; ctx.beginPath(); ctx.arc(X(it.t[i]), Y(conv(it.y[i])), 5.5, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = it.color; ctx.beginPath(); ctx.arc(X(it.t[i]), Y(conv(it.y[i])), 3.5, 0, Math.PI * 2); ctx.fill();
      }
    }
    ctx.restore();
    // unit label
    ctx.fillStyle = TEXT; ctx.textAlign = 'left'; ctx.textBaseline = 'top';
    ctx.fillText(unit || '–', 4, 2);
  }, [items, w, height, tMin, tMax, range, hoverT, units]);

  const move = (e: React.MouseEvent) => {
    const r = ref.current!.getBoundingClientRect();
    const x = e.clientX - r.left;
    const pw = w - padL - padR;
    if (x < padL || x > w - padR) { onHover(null); return; }
    onHover(tMin + ((x - padL) / pw) * (tMax - tMin));
  };
  return (
    <div ref={wrap} className="chart-wrap">
      <canvas ref={ref} style={{ width: w, height }} onMouseMove={move} onMouseLeave={() => onHover(null)} role="img" aria-label={`Plot of ${items.map((i) => i.label).join(', ')} in ${unit}`} />
    </div>
  );
}

function nearest(t: Float64Array, x: number): number {
  const n = t.length;
  if (n === 0) return -1;
  let lo = 0, hi = n - 1;
  while (hi - lo > 1) { const m = (lo + hi) >> 1; if (t[m] < x) lo = m; else hi = m; }
  return Math.abs(t[lo] - x) <= Math.abs(t[hi] - x) ? lo : hi;
}

function PlotCard({ plot, windowS, showPrev, hoverT, onHover }: { plot: PlotSpec; windowS: number; showPrev: boolean; hoverT: number | null; onHover: (t: number | null) => void }) {
  const tick = useApp((s) => s.simTick);
  const project = useApp((s) => s.project);
  const prev = useApp((s) => s.previousRun);
  const units = project.units;
  const runner = simCtl.runner && simCtl.runner.project === project ? simCtl.runner : null;
  const data = useMemo(() => plot.channels.map((c, i) => {
    const probe = project.probes.find((p) => p.id === c.probe);
    const s: Series | null = runner ? runner.series(c) : null;
    return { c, i, probe, s };
  }), [plot, runner, tick, project]);
  const tEnd = runner ? runner.time : 0;
  const tMax = Math.max(tEnd, 0.5);
  const tMin = windowS > 0 ? Math.max(0, tMax - windowS) : 0;
  // group by unit kind → one chart (one y-axis) per kind
  const groups = new Map<QuantityKind, Drawn[]>();
  const legend: { label: string; color: string; note: string; prov: string; na?: string; value: string }[] = [];
  for (const d of data) {
    const color = SERIES[d.i % SERIES.length];
    if (!d.s) { legend.push({ label: `${d.probe?.name ?? 'missing probe'} · ${d.c.quantity}`, color, note: '', prov: '', value: '—' }); continue; }
    const s = d.s;
    if (!s.available) { legend.push({ label: s.label, color, note: s.note, prov: 'unavailable', na: s.reason, value: 'unavailable' }); continue; }
    const pr = showPrev && prev ? prev.series[channelKey(d.c)] : undefined;
    if (!groups.has(s.kind)) groups.set(s.kind, []);
    groups.get(s.kind)!.push({ label: s.label, color, t: s.t, y: s.y, prev: pr, series: s });
    const idx = hoverT !== null ? nearest(s.t, hoverT) : s.t.length - 1;
    const v = idx >= 0 ? s.y[idx] : NaN;
    legend.push({ label: s.label, color, note: s.note, prov: PROVENANCE_LABEL[s.provenance], value: Number.isFinite(v) ? `${formatNumber(toDisplay(v, s.kind, units), 5)} ${unitFor(s.kind, units)}` : '—' });
  }
  const nCharts = Math.max(groups.size, 1);
  const h = nCharts === 1 ? 150 : 112;
  return (
    <article className="plot-card" data-testid={`plot-${plot.id}`}>
      <header>
        <h4 title={plot.title}>{plot.title}</h4>
        <IconButton title="Remove this plot" onClick={() => commit('Remove plot', (p) => ({ ...p, plots: p.plots.filter((x) => x.id !== plot.id) }), { solve: false })}><X size={12} /></IconButton>
      </header>
      {[...groups.entries()].map(([kind, items]) => <Chart key={kind} kind={kind} items={items} tMin={tMin} tMax={tMax} hoverT={hoverT} onHover={onHover} height={h} />)}
      {groups.size === 0 && <div className="plot-empty">{runner ? 'No plottable data for these channels.' : 'Press Play to record data.'}</div>}
      <ul className="legend">
        {legend.map((l, i) => (
          <li key={i} title={l.na ?? l.note}>
            <span className="swatch" style={{ background: l.color }} />
            <span className="lg-label">{l.label}</span>
            <span className="lg-val mono">{l.value}</span>
            {l.prov && <span className={`prov ${l.na ? 'na' : ''}`}>{l.prov}</span>}
            {l.na && <span className="lg-na">{l.na}</span>}
          </li>
        ))}
      </ul>
    </article>
  );
}

export function PlotsPanel() {
  const plots = useApp((s) => s.project.plots);
  const prev = useApp((s) => s.previousRun);
  const tick = useApp((s) => s.simTick);
  const [windowS, setWindowS] = useState('0');
  const [showPrev, setShowPrev] = useState(true);
  const [table, setTable] = useState(false);
  const [hoverT, setHoverT] = useState<number | null>(null);
  const exportCsv = () => {
    const s = getState();
    const r = simCtl.runner;
    if (!r || r.n < 2) return;
    const channels = s.project.plots.flatMap((p) => p.channels);
    const uniq = channels.filter((c, i) => channels.findIndex((x) => x.probe === c.probe && x.quantity === c.quantity) === i);
    const csv = r.csv(uniq, (v, kind) => ({ v: toDisplay(v, kind, s.project.units), unit: unitFor(kind, s.project.units) }));
    download(`${slug(s.project.name)}_measurements.csv`, csv, 'text/csv');
  };
  const r = simCtl.runner;
  void tick;
  if (plots.length === 0) {
    return <div className="empty-list wide"><p>No plots yet.</p><p className="dim">Select a joint or part and tick a quantity under <b>Measurements</b>, or use the <b>Probe</b> tool in the Library to trace a point.</p></div>;
  }
  return (
    <div className="plots">
      <div className="plots-bar">
        <span className="lbl">Time window</span>
        <Seg value={windowS} onChange={setWindowS} options={[{ value: '0', label: 'All' }, { value: '5', label: '5 s' }, { value: '2', label: '2 s' }, { value: '0.5', label: '0.5 s' }]} />
        <button className={`chip ${showPrev && prev ? 'on' : ''}`} disabled={!prev} title={prev ? `Overlay the previous run (dashed): ${prev.label}` : 'Run, change a parameter and run again to compare'} onClick={() => setShowPrev(!showPrev)} data-testid="toggle-prev"><History size={12} /> {prev ? `Compare: ${prev.label}` : 'Compare runs'}</button>
        <button className={`chip ${table ? 'on' : ''}`} onClick={() => setTable(!table)} title="Show the plotted data as a table"><Table2 size={12} /> Table</button>
        <span className="spacer" />
        <span className="dim mono">{r ? `${r.n} samples @ ${(1 / (r.sampleEvery * r.dt)).toFixed(0)} Hz` : ''}</span>
        <button className="btn small" onClick={exportCsv} disabled={!r || r.n < 2} data-testid="export-csv"><Download size={12} /> CSV</button>
        <IconButton title="Remove all plots" onClick={() => commit('Remove all plots', (p) => ({ ...p, plots: [] }), { solve: false })}><Trash2 size={12} /></IconButton>
      </div>
      {table ? <DataTable /> : (
        <div className="plot-grid">
          {plots.map((p) => <PlotCard key={p.id} plot={p} windowS={parseFloat(windowS)} showPrev={showPrev} hoverT={hoverT} onHover={setHoverT} />)}
        </div>
      )}
    </div>
  );
}

function DataTable() {
  useApp((s) => s.simTick);
  const project = useApp((s) => s.project);
  const r = simCtl.runner && simCtl.runner.project === project ? simCtl.runner : null;
  if (!r) return <div className="plot-empty">Press Play to record data.</div>;
  const channels = project.plots.flatMap((p) => p.channels);
  const uniq = channels.filter((c, i) => channels.findIndex((x) => x.probe === c.probe && x.quantity === c.quantity) === i);
  const ss = uniq.map((c) => r.series(c));
  const rows: number[] = [];
  const step = Math.max(1, Math.floor(r.n / 60));
  for (let i = 0; i < r.n; i += step) rows.push(i);
  if (rows[rows.length - 1] !== r.n - 1) rows.push(r.n - 1);
  return (
    <div className="data-table-wrap">
      <table className="data-table">
        <thead><tr><th>t [s]</th>{ss.map((s, i) => <th key={i} title={s.available ? `${PROVENANCE_LABEL[s.provenance]} — ${s.note}` : s.reason}>{s.label} [{unitFor(s.kind, project.units) || '–'}]<br /><span className={`prov ${s.available ? '' : 'na'}`}>{s.available ? PROVENANCE_LABEL[s.provenance] : 'unavailable'}</span></th>)}</tr></thead>
        <tbody>
          {rows.map((i) => <tr key={i}><td>{r.T[i].toFixed(4)}</td>{ss.map((s, k) => <td key={k}>{s.available && Number.isFinite(s.y[i]) ? formatNumber(toDisplay(s.y[i], s.kind, project.units), 6) : '—'}</td>)}</tr>)}
        </tbody>
      </table>
      <p className="hint">Showing every {step > 1 ? `${step}th` : ''} sample; the CSV export contains all {r.n}.</p>
    </div>
  );
}
