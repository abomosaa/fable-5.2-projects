/**
 * 2D sketch mode: constrained planar geometry that is extruded into a part.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, Check, CheckCircle2, Circle, CircleAlert, Maximize, MousePointer2, Slash, Square, Trash2, Dot, Spline } from 'lucide-react';
import type { SkConstraint, Sketch, SketchSolveResult } from '../../core/sketch/types';
import { applySolve, solveSketch } from '../../core/sketch/solver';
import { extractProfiles } from '../../core/sketch/profiles';
import * as sk from '../../core/sketch/ops';
import type { Project } from '../../core/model/types';
import { geometryOf, worldToLocal } from '../../core/model/project';
import { transformPoly } from '../../core/math/poly';
import { formatNumber, formatQuantity, toDisplay, unitFor } from '../../core/units';
import * as ops from '../../core/model/ops';
import { beginTxn, commit, endTxn, previewTxn, setState, toast, useApp } from '../store';
import { IconButton, NumField, Row } from '../widgets';

type STool = 'select' | 'point' | 'line' | 'rect' | 'circle' | 'arc';

function replaceSketch(p: Project, s: Sketch): Project {
  return { ...p, sketches: p.sketches.map((x) => (x.id === s.id ? s : x)) };
}

/** add/modify, then solve: coordinates follow the constraints unless they conflict */
function settle(s: Sketch): { sketch: Sketch; result: SketchSolveResult } {
  const result = solveSketch(s);
  return { sketch: applySolve(s, result), result };
}

const CON_LABEL: Record<SkConstraint['type'], string> = {
  coincident: 'Coincident', fixed: 'Fixed', horizontal: 'Horizontal', vertical: 'Vertical', distance: 'Distance', angle: 'Angle', radius: 'Radius',
  parallel: 'Parallel', perpendicular: 'Perpendicular', equal: 'Equal', pointOn: 'Point on', tangent: 'Tangent',
};

export function SketchEditor() {
  const project = useApp((s) => s.project);
  const activeId = useApp((s) => s.activeSketch);
  const sketch = project.sketches.find((s) => s.id === activeId) ?? null;
  const part = sketch ? project.parts.find((p) => p.kind === 'plate' && p.params.sketchId === sketch.id) ?? null : null;
  const units = project.units;
  const [tool, setTool] = useState<STool>('select');
  const [sel, setSel] = useState<string[]>([]);
  const [pending, setPending] = useState<string[]>([]);
  const [cursor, setCursor] = useState<{ x: number; y: number } | null>(null);
  const [view, setView] = useState({ cx: 0, cy: 0, zoom: 4 });
  const [size, setSize] = useState({ w: 800, h: 500 });
  const [editDim, setEditDim] = useState<string | null>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{ id: string; moved: boolean } | { pan: true; x: number; y: number; cx: number; cy: number } | null>(null);

  useEffect(() => {
    const ro = new ResizeObserver((e) => setSize({ w: Math.max(200, e[0].contentRect.width), h: Math.max(200, e[0].contentRect.height) }));
    if (wrapRef.current) ro.observe(wrapRef.current);
    return () => ro.disconnect();
  }, []);

  const result = useMemo(() => (sketch ? solveSketch(sketch) : null), [sketch]);
  const profiles = useMemo(() => (sketch ? extractProfiles(sketch) : null), [sketch]);

  const fit = () => {
    if (!sketch || sketch.points.length === 0) { setView({ cx: 0, cy: 0, zoom: 5 }); return; }
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    for (const p of sketch.points) { x0 = Math.min(x0, p.x); x1 = Math.max(x1, p.x); y0 = Math.min(y0, p.y); y1 = Math.max(y1, p.y); }
    for (const e of sketch.entities) if (e.type === 'circle') { const c = sketch.points.find((p) => p.id === e.center)!; x0 = Math.min(x0, c.x - e.r); x1 = Math.max(x1, c.x + e.r); y0 = Math.min(y0, c.y - e.r); y1 = Math.max(y1, c.y + e.r); }
    const zoom = Math.min(40, Math.max(0.3, Math.min(size.w / Math.max(x1 - x0, 10), size.h / Math.max(y1 - y0, 10)) * 0.7));
    setView({ cx: (x0 + x1) / 2, cy: (y0 + y1) / 2, zoom });
  };
  useEffect(() => { fit(); setSel([]); setPending([]); /* eslint-disable-next-line */ }, [activeId]);

  // keyboard
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT')) return;
      if (e.key === 'Escape') { if (pending.length || tool !== 'select') { setPending([]); setTool('select'); } else setSel([]); e.stopPropagation(); }
      else if ((e.key === 'Delete' || e.key === 'Backspace') && sel.length && sketch) { apply('Sketch: delete', sk.removeItems(sketch, sel)); setSel([]); e.preventDefault(); e.stopPropagation(); }
      else if (!e.ctrlKey && !e.metaKey) {
        const map: Record<string, STool> = { l: 'line', c: 'circle', a: 'arc', p: 'point', v: 'select' };
        const tt = map[e.key.toLowerCase()];
        if (tt) { setTool(tt); setPending([]); e.stopPropagation(); }
        if (e.key.toLowerCase() === 'f') { fit(); e.stopPropagation(); }
      }
    };
    window.addEventListener('keydown', h, true);
    return () => window.removeEventListener('keydown', h, true);
  });

  if (!sketch) {
    return (
      <div className="sketch-empty">
        <div className="empty-state static">
          <Spline size={30} strokeWidth={1.4} />
          <h3>No sketch open</h3>
          <p>Create a sketched part from <b>Library → New sketched part</b>, or pick a sketch in the Assembly tree.</p>
          {project.sketches.length > 0 && <div className="btn-row">{project.sketches.map((s) => <button key={s.id} className="btn" onClick={() => setState({ activeSketch: s.id })}>{s.name}</button>)}</div>}
          <button className="btn" onClick={() => setState({ mode: 'assemble' })}>Back to assembly</button>
        </div>
      </div>
    );
  }

  const X = (x: number) => size.w / 2 + (x - view.cx) * view.zoom;
  const Y = (y: number) => size.h / 2 - (y - view.cy) * view.zoom;
  const toWorld = (clientX: number, clientY: number) => {
    const r = svgRef.current!.getBoundingClientRect();
    return { x: view.cx + (clientX - r.left - size.w / 2) / view.zoom, y: view.cy - (clientY - r.top - size.h / 2) / view.zoom };
  };
  const pt = (id: string) => sketch.points.find((p) => p.id === id);
  const grid = view.zoom > 12 ? 0.5 : view.zoom > 2.5 ? 1 : 5;
  const snapGrid = (v: number) => Math.round(v / grid) * grid;
  const nearPoint = (w: { x: number; y: number }, exclude: string[] = []): string | null => {
    let best = 9 / view.zoom, id: string | null = null;
    for (const p of sketch.points) { if (exclude.includes(p.id)) continue; const d = Math.hypot(p.x - w.x, p.y - w.y); if (d < best) { best = d; id = p.id; } }
    return id;
  };
  const apply = (label: string, next: Sketch, doSettle = true) => {
    const s = doSettle ? settle(next).sketch : next;
    commit(label, (p) => replaceSketch(p, s), { solve: false });
    return s;
  };
  /** get an existing point near the cursor or create one (snapped to the grid) */
  const pointAt = (s: Sketch, w: { x: number; y: number }): { sketch: Sketch; id: string } => {
    const near = nearPoint(w);
    if (near) return { sketch: s, id: near };
    return sk.addPoint(s, snapGrid(w.x), snapGrid(w.y));
  };

  const onDown = (e: React.PointerEvent) => {
    if (e.button === 1 || e.button === 2) { dragRef.current = { pan: true, x: e.clientX, y: e.clientY, cx: view.cx, cy: view.cy }; (e.target as Element).setPointerCapture?.(e.pointerId); return; }
    if (e.button !== 0) return;
    const w = toWorld(e.clientX, e.clientY);
    if (tool === 'select') {
      const near = nearPoint(w);
      const target = (e.target as SVGElement).closest('[data-id]') as SVGElement | null;
      const id = near ?? target?.getAttribute('data-id') ?? null;
      if (!id) { if (!e.shiftKey) setSel([]); dragRef.current = { pan: true, x: e.clientX, y: e.clientY, cx: view.cx, cy: view.cy }; return; }
      setSel((cur) => (e.shiftKey ? (cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id]) : cur.includes(id) ? cur : [id]));
      if (near) dragRef.current = { id: near, moved: false };
      return;
    }
    let s = sketch;
    if (tool === 'point') { const r = pointAt(s, w); apply('Sketch: point', r.sketch, false); setSel([r.id]); return; }
    if (tool === 'line') {
      const r = pointAt(s, w); s = r.sketch;
      if (pending.length === 0) { apply('Sketch: point', s, false); setPending([r.id]); return; }
      if (pending[0] === r.id) { setPending([]); return; }
      const a = s.points.find((p) => p.id === pending[0])!, b = s.points.find((p) => p.id === r.id)!;
      const ln = sk.addLine(s, pending[0], r.id); s = ln.sketch;
      // inferred horizontal / vertical
      const tol = 4 / view.zoom;
      if (Math.abs(a.y - b.y) < tol && Math.abs(a.x - b.x) > tol) s = sk.addConstraint(s, { type: 'horizontal', line: ln.id }).sketch;
      else if (Math.abs(a.x - b.x) < tol && Math.abs(a.y - b.y) > tol) s = sk.addConstraint(s, { type: 'vertical', line: ln.id }).sketch;
      apply('Sketch: line', s);
      setPending([r.id]);
      return;
    }
    if (tool === 'rect') {
      if (pending.length === 0) { const r = sk.addPoint(s, snapGrid(w.x), snapGrid(w.y)); apply('Sketch: point', r.sketch, false); setPending([r.id]); return; }
      const a = pt(pending[0])!;
      const base = sk.removeItems(s, [pending[0]]);
      const withA = base.points.some((p) => p.id === pending[0]) ? { ...base, points: base.points.filter((p) => p.id !== pending[0]) } : base;
      const r = sk.rectangle(withA, a.x, a.y, snapGrid(w.x), snapGrid(w.y));
      apply('Sketch: rectangle', r.sketch);
      setPending([]); setTool('select'); setSel(r.lineIds);
      return;
    }
    if (tool === 'circle') {
      if (pending.length === 0) { const r = pointAt(s, w); apply('Sketch: point', r.sketch, false); setPending([r.id]); return; }
      const c = pt(pending[0])!;
      const rad = Math.max(snapGrid(Math.hypot(w.x - c.x, w.y - c.y)), grid);
      const r = sk.addCircle(s, pending[0], rad);
      apply('Sketch: circle', r.sketch);
      setPending([]); setSel([r.id]);
      return;
    }
    if (tool === 'arc') {
      const r = pointAt(s, w); s = r.sketch;
      if (pending.length < 2) { apply('Sketch: point', s, false); setPending([...pending, r.id]); return; }
      const a = sk.addArc(s, pending[0], pending[1], r.id);
      apply('Sketch: arc', a.sketch);
      setPending([]); setSel([a.id]);
    }
  };

  const onMove = (e: React.PointerEvent) => {
    const w = toWorld(e.clientX, e.clientY);
    setCursor(w);
    const d = dragRef.current;
    if (!d) return;
    if ('pan' in d) { setView((v) => ({ ...v, cx: d.cx - (e.clientX - d.x) / v.zoom, cy: d.cy + (e.clientY - d.y) / v.zoom })); return; }
    if (!d.moved) { d.moved = true; beginTxn('Sketch: drag point'); }
    const target = { x: e.altKey ? w.x : snapGrid(w.x), y: e.altKey ? w.y : snapGrid(w.y) };
    previewTxn((p) => {
      const cur = p.sketches.find((x) => x.id === sketch.id)!;
      const res = solveSketch(cur, { dragged: { [d.id]: target } });
      if (res.status === 'conflicting' && res.conflicting.length) return p; // never deform a conflicting sketch by dragging
      return replaceSketch(p, applySolve(cur, res));
    });
  };
  const onUp = () => {
    const d = dragRef.current;
    dragRef.current = null;
    if (d && 'id' in d && d.moved) endTxn();
  };
  const onWheel = (e: React.WheelEvent) => {
    const w = toWorld(e.clientX, e.clientY);
    const f = Math.exp(-e.deltaY * 0.0015);
    setView((v) => { const zoom = Math.min(80, Math.max(0.2, v.zoom * f)); const k = v.zoom / zoom; return { zoom, cx: w.x - (w.x - v.cx) * k, cy: w.y - (w.y - v.cy) * k }; });
  };

  // ------------------------------------------------------------ constraints from selection
  const selPts = sel.filter((id) => sketch.points.some((p) => p.id === id));
  const selEnts = sel.map((id) => sketch.entities.find((e) => e.id === id)).filter(Boolean) as Sketch['entities'];
  const selLines = selEnts.filter((e) => e.type === 'line') as Extract<Sketch['entities'][number], { type: 'line' }>[];
  const selRound = selEnts.filter((e) => e.type !== 'line');
  const addCon = (c: any, label: string) => {
    const next = sk.addConstraint(sketch, c);
    const st = settle(next.sketch);
    commit(`Sketch: ${label}`, (p) => replaceSketch(p, st.sketch), { solve: false });
    if (st.result.conflicting.includes(next.id)) toast(`That ${label} conflicts with existing constraints — it was kept but NOT applied. ${st.result.message}`, 'error');
    else if (st.result.redundant.includes(next.id)) toast(`That ${label} is redundant: the sketch already implies it.`, 'info');
  };
  const dist = (a: string, b: string) => { const p = pt(a)!, q = pt(b)!; return Math.hypot(p.x - q.x, p.y - q.y); };
  const lineAngle = (l1: typeof selLines[number], l2: typeof selLines[number]) => {
    const a1 = pt(l1.p1)!, a2 = pt(l1.p2)!, b1 = pt(l2.p1)!, b2 = pt(l2.p2)!;
    const ux = a2.x - a1.x, uy = a2.y - a1.y, vx = b2.x - b1.x, vy = b2.y - b1.y;
    return Math.atan2(ux * vy - uy * vx, ux * vx + uy * vy);
  };
  const r2 = (v: number) => Math.round(v * 100) / 100;
  const actions: { label: string; title: string; enabled: boolean; run: () => void }[] = [
    { label: 'Fix', title: 'Lock the selected point(s) in place', enabled: selPts.length >= 1, run: () => { let s = sketch; for (const id of selPts) { const p = pt(id)!; s = sk.addConstraint(s, { type: 'fixed', point: id, x: p.x, y: p.y }).sketch; } apply('Sketch: fix', s); } },
    { label: 'Coincident', title: 'Make two points share a location', enabled: selPts.length === 2 && selEnts.length === 0, run: () => addCon({ type: 'coincident', a: selPts[0], b: selPts[1] }, 'coincident') },
    { label: 'Horizontal', title: 'Make the selected line(s) horizontal', enabled: selLines.length >= 1, run: () => { if (selLines.length === 1) addCon({ type: 'horizontal', line: selLines[0].id }, 'horizontal'); else { let s = sketch; for (const l of selLines) s = sk.addConstraint(s, { type: 'horizontal', line: l.id }).sketch; apply('Sketch: horizontal', s); } } },
    { label: 'Vertical', title: 'Make the selected line(s) vertical', enabled: selLines.length >= 1, run: () => { if (selLines.length === 1) addCon({ type: 'vertical', line: selLines[0].id }, 'vertical'); else { let s = sketch; for (const l of selLines) s = sk.addConstraint(s, { type: 'vertical', line: l.id }).sketch; apply('Sketch: vertical', s); } } },
    { label: 'Distance', title: 'Dimension the distance between two points, or the length of a line', enabled: (selPts.length === 2 && selEnts.length === 0) || (selLines.length === 1 && selPts.length === 0 && selEnts.length === 1), run: () => { const [a, b] = selLines.length === 1 ? [selLines[0].p1, selLines[0].p2] : selPts; addCon({ type: 'distance', a, b, value: r2(dist(a, b)) }, 'distance'); } },
    { label: 'Angle', title: 'Dimension the angle from the first to the second selected line', enabled: selLines.length === 2, run: () => addCon({ type: 'angle', l1: selLines[0].id, l2: selLines[1].id, value: Math.round(lineAngle(selLines[0], selLines[1]) * 1800 / Math.PI) * Math.PI / 1800 }, 'angle') },
    { label: 'Radius', title: 'Dimension the radius of a circle or arc', enabled: selRound.length === 1 && selEnts.length === 1, run: () => { const e = selRound[0]; const r = e.type === 'circle' ? e.r : Math.hypot(pt((e as any).start)!.x - pt(e.center)!.x, pt((e as any).start)!.y - pt(e.center)!.y); addCon({ type: 'radius', entity: e.id, value: r2(r) }, 'radius'); } },
    { label: 'Parallel', title: 'Make two lines parallel', enabled: selLines.length === 2, run: () => addCon({ type: 'parallel', l1: selLines[0].id, l2: selLines[1].id }, 'parallel') },
    { label: 'Perpendicular', title: 'Make two lines perpendicular', enabled: selLines.length === 2, run: () => addCon({ type: 'perpendicular', l1: selLines[0].id, l2: selLines[1].id }, 'perpendicular') },
    { label: 'Equal', title: 'Equal length (two lines) or equal radius (two circles/arcs)', enabled: selLines.length === 2 || (selRound.length === 2 && selLines.length === 0), run: () => addCon({ type: 'equal', e1: selEnts[0].id, e2: selEnts[1].id }, 'equal') },
    { label: 'Point on', title: 'Put a point on a line or circle', enabled: selPts.length === 1 && selEnts.length === 1, run: () => addCon({ type: 'pointOn', point: selPts[0], entity: selEnts[0].id }, 'point-on') },
    { label: 'Tangent', title: 'Make a line tangent to a circle or arc', enabled: selLines.length === 1 && selRound.length === 1, run: () => addCon({ type: 'tangent', line: selLines[0].id, circle: selRound[0].id }, 'tangent') },
  ];

  const free = new Set(result?.freePoints ?? []);
  const conflicting = new Set(result?.conflicting ?? []), redundant = new Set(result?.redundant ?? []);
  const entColor = (e: Sketch['entities'][number]) => {
    if (sel.includes(e.id)) return '#ffd479';
    const ps = e.type === 'line' ? [e.p1, e.p2] : e.type === 'circle' ? [e.center] : [e.center, e.start, e.end];
    const anyFree = ps.some((id) => free.has(id)) || (result?.freeRadii ?? []).includes(e.id);
    return anyFree ? '#58a6ff' : '#e6e8ec';
  };
  const setConValue = (c: SkConstraint, value: number) => {
    if ((c.type === 'distance' || c.type === 'radius') && !(value > 1e-6)) { toast(`A ${c.type} must be greater than zero${c.type === 'distance' ? ' (use Coincident to join two points)' : ''}. Nothing was changed.`, 'error'); setEditDim(null); return; }
    const next = { ...sketch, constraints: sketch.constraints.map((x) => (x.id === c.id ? ({ ...x, value } as SkConstraint) : x)) };
    const st = settle(next);
    commit('Sketch: edit dimension', (p) => replaceSketch(p, st.sketch), { solve: false });
    if (st.result.conflicting.includes(c.id)) toast(`${CON_LABEL[c.type]} = ${formatNumber(toDisplay(value, c.type === 'angle' ? 'angle' : 'length', units))} cannot be satisfied — the geometry was left at its last valid shape. ${st.result.message}`, 'error');
    setEditDim(null);
  };

  // underlay: other parts in this sketch's (part-local) frame
  const underlay: string[] = [];
  if (part) {
    for (const o of project.parts) {
      if (o.id === part.id || o.suppressed) continue;
      const g = geometryOf(project, o);
      for (const l of g.layers) for (const c of l.contours) {
        const wpts = transformPoly(c, o.pose.x, o.pose.y, o.pose.angle);
        const step = Math.max(1, Math.floor(wpts.length / 120));
        let d = '';
        for (let i = 0; i < wpts.length; i += step) { const q = worldToLocal(part.pose, wpts[i][0], wpts[i][1]); d += `${i === 0 ? 'M' : 'L'}${X(q.x).toFixed(1)},${Y(q.y).toFixed(1)}`; }
        underlay.push(d + 'Z');
      }
    }
  }
  const gridLines: React.ReactNode[] = [];
  const gstep = view.zoom > 6 ? 5 : view.zoom > 1.5 ? 10 : 50;
  const x0 = view.cx - size.w / 2 / view.zoom, x1 = view.cx + size.w / 2 / view.zoom, y0 = view.cy - size.h / 2 / view.zoom, y1 = view.cy + size.h / 2 / view.zoom;
  for (let gx = Math.ceil(x0 / gstep) * gstep; gx <= x1; gx += gstep) gridLines.push(<line key={`x${gx}`} x1={X(gx)} x2={X(gx)} y1={0} y2={size.h} className={gx === 0 ? 'axis-y' : Math.round(gx / gstep) % 5 === 0 ? 'major' : ''} />);
  for (let gy = Math.ceil(y0 / gstep) * gstep; gy <= y1; gy += gstep) gridLines.push(<line key={`y${gy}`} y1={Y(gy)} y2={Y(gy)} x1={0} x2={size.w} className={gy === 0 ? 'axis-x' : Math.round(gy / gstep) % 5 === 0 ? 'major' : ''} />);

  const status = result?.status ?? 'empty';
  const statusInfo = {
    empty: { cls: 'info', icon: <Dot size={14} />, text: 'Empty sketch — draw a closed outline with the Line, Rectangle or Circle tool.' },
    'fully-constrained': { cls: 'ok', icon: <CheckCircle2 size={14} />, text: 'Fully constrained: every point is determined by the dimensions.' },
    'under-constrained': { cls: 'warn', icon: <AlertTriangle size={14} />, text: `Under-constrained: ${result?.dof} degree${result?.dof === 1 ? '' : 's'} of freedom remain (blue geometry can still move). ${sketch.constraints.some((c) => c.type === 'fixed') ? 'Add dimensions.' : 'Fix a point and add dimensions.'}` },
    redundant: { cls: 'warn', icon: <AlertTriangle size={14} />, text: `Redundant constraints: ${result?.redundant.length} constraint(s) repeat what others already impose (orange in the list).` },
    conflicting: { cls: 'error', icon: <CircleAlert size={14} />, text: `Conflicting constraints — ${result?.message} The geometry keeps its last valid shape; delete or change the red constraint.` },
  }[status];

  const dimNodes: React.ReactNode[] = [];
  for (const c of sketch.constraints) {
    const cls = conflicting.has(c.id) ? 'conflict' : redundant.has(c.id) ? 'redundant' : '';
    if (c.type === 'distance') {
      const a = pt(c.a), b = pt(c.b);
      if (!a || !b) continue;
      const mx = (X(a.x) + X(b.x)) / 2, my = (Y(a.y) + Y(b.y)) / 2;
      const dx = X(b.x) - X(a.x), dy = Y(b.y) - Y(a.y), L = Math.hypot(dx, dy) || 1;
      const nx = -dy / L, ny = dx / L, off = 18;
      dimNodes.push(
        <g key={c.id} className={`dim ${cls} ${sel.includes(c.id) ? 'sel' : ''}`} data-id={c.id}>
          <line x1={X(a.x) + nx * off} y1={Y(a.y) + ny * off} x2={X(b.x) + nx * off} y2={Y(b.y) + ny * off} />
          <line x1={X(a.x)} y1={Y(a.y)} x2={X(a.x) + nx * (off + 4)} y2={Y(a.y) + ny * (off + 4)} className="ext" />
          <line x1={X(b.x)} y1={Y(b.y)} x2={X(b.x) + nx * (off + 4)} y2={Y(b.y) + ny * (off + 4)} className="ext" />
          <text x={mx + nx * (off + 11)} y={my + ny * (off + 11) + 4} textAnchor="middle" onDoubleClick={() => setEditDim(c.id)}>{formatNumber(toDisplay(c.value, 'length', units), 5)}</text>
        </g>,
      );
    } else if (c.type === 'radius') {
      const e = sketch.entities.find((x) => x.id === c.entity);
      const ctr = e && e.type !== 'line' ? pt(e.center) : null;
      if (!ctr) continue;
      dimNodes.push(<g key={c.id} className={`dim ${cls} ${sel.includes(c.id) ? 'sel' : ''}`} data-id={c.id}><text x={X(ctr.x + c.value * 0.7) + 6} y={Y(ctr.y + c.value * 0.7) - 6} onDoubleClick={() => setEditDim(c.id)}>R{formatNumber(toDisplay(c.value, 'length', units), 5)}</text></g>);
    } else if (c.type === 'angle') {
      const l1 = sketch.entities.find((x) => x.id === c.l1), l2 = sketch.entities.find((x) => x.id === c.l2);
      if (!l1 || !l2 || l1.type !== 'line' || l2.type !== 'line') continue;
      const p = pt(l2.p1);
      if (!p) continue;
      dimNodes.push(<g key={c.id} className={`dim ${cls} ${sel.includes(c.id) ? 'sel' : ''}`} data-id={c.id}><text x={X(p.x) + 14} y={Y(p.y) - 12} onDoubleClick={() => setEditDim(c.id)}>∠{formatNumber(toDisplay(c.value, 'angle', units), 4)}{unitFor('angle', units) === 'deg' ? '°' : ' rad'}</text></g>);
    } else if (c.type === 'horizontal' || c.type === 'vertical') {
      const l = sketch.entities.find((x) => x.id === c.line);
      if (!l || l.type !== 'line') continue;
      const a = pt(l.p1), b = pt(l.p2);
      if (!a || !b) continue;
      dimNodes.push(<text key={c.id} className={`glyph ${cls}`} data-id={c.id} x={(X(a.x) + X(b.x)) / 2 + 6} y={(Y(a.y) + Y(b.y)) / 2 - 6}>{c.type === 'horizontal' ? 'H' : 'V'}</text>);
    } else if (c.type === 'fixed') {
      const p = pt(c.point);
      if (p) dimNodes.push(<path key={c.id} className={`fixglyph ${cls}`} data-id={c.id} d={`M${X(p.x) - 6},${Y(p.y) + 10}h12M${X(p.x) - 4},${Y(p.y) + 10}l-3,4M${X(p.x)},${Y(p.y) + 10}l-3,4M${X(p.x) + 4},${Y(p.y) + 10}l-3,4M${X(p.x)},${Y(p.y)}v10`} />);
    }
  }
  const editCon = editDim ? sketch.constraints.find((c) => c.id === editDim) : null;
  const pendingPt = pending.length ? pt(pending[pending.length - 1]) : null;
  const TB = (t: STool, title: string, icon: React.ReactNode) => <IconButton title={title} active={tool === t} testId={`sk-tool-${t}`} onClick={() => { setTool(t); setPending([]); }}>{icon}</IconButton>;

  return (
    <div className="sketch">
      <div className="sketch-toolbar" role="toolbar" aria-label="Sketch tools">
        {TB('select', 'Select / drag points (V)', <MousePointer2 size={15} />)}
        {TB('point', 'Point (P)', <Dot size={18} />)}
        {TB('line', 'Line chain (L) — click points, Esc to stop', <Slash size={15} />)}
        {TB('rect', 'Rectangle — two corners', <Square size={15} />)}
        {TB('circle', 'Circle (C) — centre, then radius', <Circle size={15} />)}
        {TB('arc', 'Arc (A) — centre, start, end (counter-clockwise)', <Spline size={15} />)}
        <span className="sep" />
        {actions.map((a) => <button key={a.label} className="chip" disabled={!a.enabled} title={a.title} data-testid={`sk-con-${a.label.toLowerCase().replace(' ', '-')}`} onClick={a.run}>{a.label}</button>)}
        <span className="sep" />
        <IconButton title="Delete selection (Del)" disabled={!sel.length} onClick={() => { apply('Sketch: delete', sk.removeItems(sketch, sel)); setSel([]); }}><Trash2 size={14} /></IconButton>
        <IconButton title="Zoom to fit (F)" onClick={fit}><Maximize size={14} /></IconButton>
        <span className="spacer" />
        <button className="btn primary" data-testid="sk-finish" onClick={() => setState({ mode: 'assemble' })}><Check size={14} /> Finish sketch</button>
      </div>
      <div className={`sketch-status ${statusInfo.cls}`} role="status" data-testid="sketch-status" data-status={status}>{statusInfo.icon}<span>{statusInfo.text}</span></div>
      <div className="sketch-main">
        <div className="sketch-canvas" ref={wrapRef}>
          <svg ref={svgRef} width={size.w} height={size.h} data-testid="sketch-svg" onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerLeave={() => setCursor(null)} onWheel={onWheel} onContextMenu={(e) => e.preventDefault()} style={{ cursor: tool === 'select' ? 'default' : 'crosshair' }}>
            <g className="sk-grid">{gridLines}</g>
            <g className="sk-underlay">{underlay.map((d, i) => <path key={i} d={d} />)}</g>
            <g className="sk-regions">
              {profiles?.regions.map((r, i) => <path key={i} fillRule="evenodd" d={[r.outer, ...r.holes].map((l) => l.points.map((p, k) => `${k === 0 ? 'M' : 'L'}${X(p[0]).toFixed(1)},${Y(p[1]).toFixed(1)}`).join('') + 'Z').join('')} />)}
            </g>
            <g className="sk-ents">
              {sketch.entities.map((e) => {
                const color = entColor(e);
                const open = profiles?.openEntities.includes(e.id);
                const common = { 'data-id': e.id, stroke: color, className: `${e.construction ? 'construction' : ''} ${open ? 'open' : ''}` };
                if (e.type === 'line') { const a = pt(e.p1), b = pt(e.p2); if (!a || !b) return null; return <g key={e.id}><line x1={X(a.x)} y1={Y(a.y)} x2={X(b.x)} y2={Y(b.y)} className="hit" data-id={e.id} /><line x1={X(a.x)} y1={Y(a.y)} x2={X(b.x)} y2={Y(b.y)} {...common} /></g>; }
                if (e.type === 'circle') { const c = pt(e.center); if (!c) return null; return <g key={e.id}><circle cx={X(c.x)} cy={Y(c.y)} r={e.r * view.zoom} className="hit" data-id={e.id} /><circle cx={X(c.x)} cy={Y(c.y)} r={e.r * view.zoom} {...common} /></g>; }
                const c = pt(e.center), s = pt(e.start), en = pt(e.end);
                if (!c || !s || !en) return null;
                const r = Math.hypot(s.x - c.x, s.y - c.y) * view.zoom;
                let sweep = Math.atan2(en.y - c.y, en.x - c.x) - Math.atan2(s.y - c.y, s.x - c.x);
                if (sweep <= 0) sweep += 2 * Math.PI;
                const d = `M${X(s.x)},${Y(s.y)}A${r},${r} 0 ${sweep > Math.PI ? 1 : 0} 0 ${X(en.x)},${Y(en.y)}`;
                return <g key={e.id}><path d={d} className="hit" data-id={e.id} /><path d={d} {...common} /></g>;
              })}
            </g>
            <g className="sk-dims">{dimNodes}</g>
            {pendingPt && cursor && tool !== 'select' && (tool === 'circle'
              ? <circle className="rubber" cx={X(pendingPt.x)} cy={Y(pendingPt.y)} r={Math.hypot(cursor.x - pendingPt.x, cursor.y - pendingPt.y) * view.zoom} />
              : tool === 'rect' ? <rect className="rubber" x={Math.min(X(pendingPt.x), X(cursor.x))} y={Math.min(Y(pendingPt.y), Y(cursor.y))} width={Math.abs(X(cursor.x) - X(pendingPt.x))} height={Math.abs(Y(cursor.y) - Y(pendingPt.y))} />
              : <line className="rubber" x1={X(pendingPt.x)} y1={Y(pendingPt.y)} x2={X(cursor.x)} y2={Y(cursor.y)} />)}
            <g className="sk-points">
              {sketch.points.map((p) => <circle key={p.id} data-id={p.id} data-testid={`sk-pt-${p.id}`} cx={X(p.x)} cy={Y(p.y)} r={sel.includes(p.id) ? 5 : 3.6} className={`${sel.includes(p.id) ? 'sel' : ''} ${free.has(p.id) ? 'free' : 'fixed'} ${pending.includes(p.id) ? 'pending' : ''}`} />)}
            </g>
          </svg>
          {editCon && 'value' in editCon && (
            <div className="dim-edit">
              <span>{CON_LABEL[editCon.type]}</span>
              <NumField value={(editCon as any).value} kind={editCon.type === 'angle' ? 'angle' : 'length'} label="Dimension value" testId="dim-edit" onCommit={(v) => setConValue(editCon, v)} />
              <button className="btn small" onClick={() => setEditDim(null)}>Close</button>
            </div>
          )}
          <div className="sketch-coords mono">{cursor ? `${formatQuantity(cursor.x, 'length', units, 5)}, ${formatQuantity(cursor.y, 'length', units, 5)}` : ''}  ·  grid {gstep} mm  ·  snap {grid} mm (Alt: free)</div>
        </div>
        <aside className="sketch-side">
          <h4>{sketch.name}</h4>
          {part ? (
            <>
              <Row label="Extrusion depth"><NumField value={part.params.thickness} kind="length" min={0.2} label="Extrusion depth" testId="sk-thickness" onCommit={(t) => commit('Edit extrusion depth', (p) => ops.setPartParam(p, part.id, 'thickness', t), { solve: false })} /></Row>
              <p className="hint">Part “{part.name}”. Closed loops become the solid; loops and circles inside it are cut out. Circle centres become anchors for joints. Sketched holes are cut exactly as dimensioned — add any pin clearance to the radius yourself (library parts add it automatically).</p>
            </>
          ) : <p className="hint">This sketch is not linked to a part.</p>}
          <div className={`profile-status ${profiles && profiles.regions.length && !profiles.problems.length ? 'ok' : 'warn'}`} data-testid="profile-status">
            {profiles && profiles.regions.length > 0 ? `${profiles.regions.length} closed region${profiles.regions.length > 1 ? 's' : ''}, ${profiles.regions.reduce((n, r) => n + r.holes.length, 0)} cut-out(s), area ${formatQuantity(profiles.regions.reduce((a, r) => a + r.outer.area - r.holes.reduce((h, l) => h + l.area, 0), 0), 'area', units)}` : 'No closed profile yet — nothing to extrude.'}
            {profiles && profiles.openEntities.length > 0 && <div>{profiles.openEntities.length} open entit{profiles.openEntities.length > 1 ? 'ies' : 'y'} (dashed) ignored.</div>}
            {profiles?.problems.map((m, i) => <div key={i}>⚠ {m}</div>)}
          </div>
          <h5>Constraints ({sketch.constraints.length})</h5>
          <ul className="con-list" data-testid="sk-constraints">
            {sketch.constraints.length === 0 && <li className="dim">None yet. Select geometry and use the buttons above.</li>}
            {sketch.constraints.map((c) => (
              <li key={c.id} className={`${conflicting.has(c.id) ? 'conflict' : redundant.has(c.id) ? 'redundant' : ''} ${sel.includes(c.id) ? 'sel' : ''}`} onClick={() => setSel([c.id])} data-testid={`sk-con-item-${c.id}`}>
                <span className="con-name">{CON_LABEL[c.type]}{conflicting.has(c.id) ? ' — conflicting' : redundant.has(c.id) ? ' — redundant' : ''}</span>
                {'value' in c && <NumField compact value={c.value} kind={c.type === 'angle' ? 'angle' : 'length'} label={`${CON_LABEL[c.type]} value`} testId={`sk-val-${c.id}`} onCommit={(v) => setConValue(c, v)} />}
                <IconButton title="Delete constraint" onClick={() => apply('Sketch: delete constraint', sk.removeItems(sketch, [c.id]))}><Trash2 size={11} /></IconButton>
              </li>
            ))}
          </ul>
          <p className="hint">Blue = can still move · white = determined · red = conflicting · orange = redundant. Double-click a dimension to edit it.</p>
        </aside>
      </div>
    </div>
  );
}
