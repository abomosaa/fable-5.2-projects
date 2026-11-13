import { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { Box, Crosshair, Eye, Grid3x3, Layers, Maximize, Scissors, Activity, Sun, Waypoints } from 'lucide-react';
import { SceneView, type PickResult } from './SceneView';
import {
  beginTxn, clearSelection, commit, dragSolve, endTxn, getState, previewTxn, select, setState, toast, useApp, type Tool,
} from '../store';
import * as ops from '../../core/model/ops';
import { GROUND, type Anchor, type Project } from '../../core/model/types';
import { geometryOf, localToWorld, worldToLocal } from '../../core/model/project';
import { formatQuantity } from '../../core/units';
import { IconButton, Seg } from '../widgets';

export const viewRef: { current: SceneView | null } = { current: null };

const MATE_HINT: Record<string, [string, string]> = {
  revolute: ['Pivot: click a hole/point on the first part (it stays put), or empty space to pin the next part to ground where it is', 'Now click the hole/point on the part that turns about it (it moves to meet the first) — or empty space to pin the first hole to ground in place'],
  prismatic: ['Slide: click the guide part (its axis is used) or empty space for a ground axis', 'Now click the part that slides'],
  rigid: ['Fix: click the first part (or empty space to fix to ground)', 'Now click the part to attach rigidly'],
  spring: ['Spring: click the first end (part point or empty space = ground)', 'Now click the other end'],
  gear: ['Gear mesh: click the driving gear', 'Now click the driven gear'],
  belt: ['Belt: click the first pulley', 'Now click the second pulley'],
  rackPinion: ['Rack & pinion: click the pinion gear', 'Now click the rack'],
  cam: ['Cam contact: click the cam', 'Now click the follower roller'],
};

interface MateFirst { partId: string; anchor: Anchor; world: { x: number; y: number } }

function hasJoints(project: Project, partId: string): boolean {
  return project.joints.some((j) => !j.suppressed && (j.a === partId || j.b === partId));
}

export function Viewport() {
  const hostRef = useRef<HTMLDivElement>(null);
  const triadRef = useRef<SVGSVGElement>(null);
  const scaleRef = useRef<HTMLDivElement>(null);
  const scaleLabelRef = useRef<HTMLSpanElement>(null);
  const measureRef = useRef<HTMLDivElement>(null);
  const tool = useApp((s) => s.tool);
  const view = useApp((s) => s.view);
  const units = useApp((s) => s.project.units);
  const views = useApp((s) => s.project.views);
  const partCount = useApp((s) => s.project.parts.length);
  const [mateFirst, setMateFirst] = useState<MateFirst | null>(null);
  const mateRef = useRef<MateFirst | null>(null);
  mateRef.current = mateFirst;
  const [measureText, setMeasureText] = useState<string | null>(null);

  useEffect(() => { setMateFirst(null); }, [tool]);

  useEffect(() => {
    const host = hostRef.current!;
    const sv = new SceneView(host);
    viewRef.current = sv;
    (window as any).__mwView = sv;

    sv.onFrame = (info) => {
      // scale bar: choose a round length close to 110 px
      const target = info.mmPerPx * 110;
      const steps = [0.5, 1, 2, 5, 10, 20, 50, 100, 200, 500, 1000, 2000, 5000];
      let len = steps[0];
      for (const st of steps) if (st <= target) len = st;
      if (scaleRef.current && scaleLabelRef.current) {
        scaleRef.current.style.width = `${len / info.mmPerPx}px`;
        scaleLabelRef.current.textContent = formatQuantity(len, 'length', getState().project.units, 4);
      }
      // orientation triad
      const svg = triadRef.current;
      if (svg) {
        const inv = info.camQuat.clone().invert();
        const axes: [string, THREE.Vector3, string][] = [['X', new THREE.Vector3(1, 0, 0), '#f2695c'], ['Y', new THREE.Vector3(0, 1, 0), '#6fd67a'], ['Z', new THREE.Vector3(0, 0, 1), '#5aa9ff']];
        const items = axes.map(([n, v, c]) => { const p = v.clone().applyQuaternion(inv); return { n, c, x: p.x, y: -p.y, z: p.z }; }).sort((a, b) => a.z - b.z);
        svg.innerHTML = items.map((a) => `<line x1="30" y1="30" x2="${30 + a.x * 20}" y2="${30 + a.y * 20}" stroke="${a.c}" stroke-width="2" stroke-linecap="round" opacity="${a.z < -0.2 ? 0.45 : 1}"/><text x="${30 + a.x * 27}" y="${30 + a.y * 27 + 3.5}" fill="${a.c}" font-size="10" font-weight="700" text-anchor="middle" opacity="${a.z < -0.2 ? 0.5 : 1}">${a.n}</text>`).join('');
      }
      // measurement label
      const m = sv.measure;
      if (measureRef.current) {
        if (m.a && m.b) {
          const mid = m.a.clone().add(m.b).multiplyScalar(0.5);
          const sc = sv.toScreen(mid);
          measureRef.current.style.display = 'block';
          measureRef.current.style.transform = `translate(${sc.x + 10}px, ${sc.y - 30}px)`;
        } else measureRef.current.style.display = 'none';
      }
    };

    // ---------------------------------------------------------------- interaction
    type Drag =
      | { kind: 'move'; ids: string[]; start: Map<string, { x: number; y: number }>; grab: { x: number; y: number }; z: number; moved: boolean; main: string; snap: null | { partId: string; port: string; myPort: string; world: { x: number; y: number } } }
      | { kind: 'articulate'; partId: string; local: { x: number; y: number }; z: number; moved: boolean }
      | { kind: 'probe'; probeId: string; partId: string; z: number; moved: boolean };
    let drag: Drag | null = null;
    let down: { x: number; y: number; pick: PickResult; shift: boolean } | null = null;
    let hoverT = 0;

    const anchorOf = (pick: PickResult): Anchor => (pick.port ? { port: pick.port.id } : { x: round(pick.local!.x), y: round(pick.local!.y) });
    const round = (v: number) => Math.round(v * 100) / 100;

    /** can this part take the given role in a coupling? returns a reason when it cannot */
    const couplingProblem = (type: string, aId: string, bId: string | null): string | null => {
      const p = getState().project;
      const part = (id: string | null) => (id ? p.parts.find((x) => x.id === id) : undefined);
      const A = part(aId), B = part(bId);
      const hasPitch = (q: typeof A) => !!q && (geometryOf(p, q).pitchRadius ?? 0) > 0;
      if (type === 'gear') {
        if (A && A.kind !== 'gear') return `Gear mesh needs two spur gears; "${A.name}" is a ${A.kind}.`;
        if (B && B.kind !== 'gear') return `Gear mesh needs two spur gears; "${B.name}" is a ${B.kind}.`;
        if (A && B && Math.abs(A.params.module - B.params.module) > 1e-9) return `Gears only mesh with equal modules: "${A.name}" has m = ${A.params.module} mm, "${B.name}" has m = ${B.params.module} mm.`;
      } else if (type === 'belt') {
        if (A && !hasPitch(A)) return `A belt runs on pulleys (or gears); "${A.name}" has no pitch circle.`;
        if (B && !hasPitch(B)) return `A belt runs on pulleys (or gears); "${B.name}" has no pitch circle.`;
      } else if (type === 'rackPinion') {
        const kinds = [A?.kind, B?.kind].filter(Boolean);
        if (kinds.some((k) => k !== 'gear' && k !== 'rack')) return 'Rack & pinion needs one spur gear and one rack.';
        if (A && B && A.kind === B.kind) return 'Rack & pinion needs one spur gear and one rack (not two of the same).';
        const g = A?.kind === 'gear' ? A : B, r = A?.kind === 'rack' ? A : B;
        if (g && r && g.kind === 'gear' && r.kind === 'rack' && Math.abs(g.params.module - r.params.module) > 1e-9) return `Pinion module ${g.params.module} mm ≠ rack module ${r.params.module} mm.`;
      } else if (type === 'cam') {
        const roller = (q: typeof A) => !!q && geometryOf(p, q).ports.some((pt) => pt.r !== undefined && pt.kind !== 'center');
        const kinds = [A, B].filter(Boolean) as NonNullable<typeof A>[];
        if (kinds.length === 1 && kinds[0].kind !== 'cam' && !roller(kinds[0])) return `Cam contact needs a plate cam and a part with a roller or rounded end; "${kinds[0].name}" is neither.`;
        if (A && B) {
          if ((A.kind === 'cam') === (B.kind === 'cam')) return 'Cam contact needs exactly one plate cam and one follower.';
          const f = A.kind === 'cam' ? B : A;
          if (!roller(f)) return `"${f.name}" has no roller or rounded end to ride on the cam.`;
        }
      }
      return null;
    };

    const finishMate = (first: MateFirst, pick: PickResult, type: string): void => {
      const s = getState();
      const second = pick.partId
        ? { partId: pick.partId, anchor: anchorOf(pick), world: pick.world }
        : { partId: GROUND, anchor: { x: round(pick.world.x), y: round(pick.world.y) } as Anchor, world: pick.world };
      if (first.partId === second.partId) { toast(first.partId === GROUND ? 'Pick at least one part: a joint cannot connect ground to ground.' : 'Pick a different part for the second anchor.', 'error'); return; }
      const name = (id: string) => (id === GROUND ? 'ground' : s.project.parts.find((p) => p.id === id)?.name ?? id);
      let a = first, b = second;
      // the second pick is the part that moves to meet the first; ground can only be "A"
      if (b.partId === GROUND) { a = second; b = first; }
      const coupling = type === 'gear' || type === 'belt' || type === 'rackPinion' || type === 'cam';
      if (coupling) {
        const why = couplingProblem(type, first.partId, second.partId);
        if (why) { toast(`${why} No joint was created.`, 'error'); return; }
      }
      let newId = '';
      const ok = commit(`Add ${type} joint`, (p) => {
        let r: { project: Project; id: string };
        if (type === 'revolute') {
          if (a.partId === GROUND) {
            // ground pivot: pin the picked hole where it IS (the part does not jump to the clicked spot)
            const pb = p.parts.find((x) => x.id === b.partId)!;
            const lb = b.anchor.port ? geometryOf(p, pb).ports.find((q) => q.id === b.anchor.port)! : { x: b.anchor.x!, y: b.anchor.y! };
            const wb = localToWorld(pb.pose, lb.x, lb.y);
            r = ops.mateRevolute(p, GROUND, { x: round(wb.x), y: round(wb.y) }, b.partId, b.anchor);
          } else r = ops.mateRevolute(p, a.partId, a.anchor, b.partId, b.anchor);
        }
        else if (type === 'prismatic') {
          // ground axis: direction from first to second pick
          const opts = a.partId === GROUND ? { axisAngle: Math.abs(b.world.x - a.world.x) >= Math.abs(b.world.y - a.world.y) ? 0 : Math.PI / 2 } : {};
          // a click anywhere on a guide means "slide along this guide": use its own axis (the slot centre line), not the clicked point
          let anchorA = a.anchor;
          if (a.partId !== GROUND && anchorA.port === undefined) {
            const axisPorts = geometryOf(p, p.parts.find((x) => x.id === a.partId)!).ports.filter((q) => q.axis !== undefined);
            if (axisPorts.length) anchorA = { port: axisPorts.slice().sort((u, v) => Math.hypot(u.x - (a.anchor.x ?? 0), u.y - (a.anchor.y ?? 0)) - Math.hypot(v.x - (a.anchor.x ?? 0), v.y - (a.anchor.y ?? 0)))[0].id };
          }
          r = ops.matePrismatic(p, a.partId, anchorA, b.partId, b.anchor, opts);
        } else if (type === 'rigid') {
          // keep the parts where they are: anchor B at its own picked point, anchor A = same world point in A's frame
          const pb = p.parts.find((x) => x.id === b.partId)!;
          const lb = b.anchor.port ? geometryOf(p, pb).ports.find((q) => q.id === b.anchor.port)! : { x: b.anchor.x!, y: b.anchor.y! };
          const wb = localToWorld(pb.pose, lb.x, lb.y);
          if (a.anchor.port !== undefined) r = ops.mateRigid(p, a.partId, a.anchor, b.partId, b.anchor);
          else {
            const pa = a.partId === GROUND ? null : p.parts.find((x) => x.id === a.partId)!;
            const la = pa ? worldToLocal(pa.pose, wb.x, wb.y) : wb;
            r = ops.mateRigid(p, a.partId, { x: round(la.x), y: round(la.y) }, b.partId, b.anchor, { move: false });
          }
        } else if (type === 'spring') r = ops.addSpring(p, a.partId, a.anchor, b.partId, b.anchor);
        else {
          // order the two parts by role: pinion → rack, cam → follower
          const P = (id: string) => p.parts.find((x) => x.id === id)!;
          let A = first, B = second;
          if (type === 'rackPinion' && P(first.partId).kind === 'rack') { A = second; B = first; }
          if (type === 'cam' && P(first.partId).kind !== 'cam') { A = second; B = first; }
          let anchorB: Anchor | undefined;
          if (type === 'cam') {
            const g = geometryOf(p, P(B.partId));
            const picked = B.anchor.port ? g.ports.find((q) => q.id === B.anchor.port) : undefined;
            const port = picked && picked.r !== undefined ? picked : g.ports.find((q) => q.kind === 'roller') ?? g.ports.find((q) => q.r !== undefined && q.kind !== 'center');
            anchorB = { port: port!.id };
          }
          r = ops.mateCoupling(p, type as any, A.partId, B.partId, anchorB ? { anchorB } : {});
        }
        newId = r.id;
        return r.project;
      });
      if (ok) {
        select({ joints: [newId] });
        toast(`${type === 'spring' ? 'Spring' : 'Joint'} added between ${name(a.partId)} and ${name(b.partId)}.`, 'ok');
      }
    };

    const onDown = (e: PointerEvent) => {
      if (e.button !== 0) return;
      (e.target as HTMLElement).focus?.();
      const s = getState();
      const pick = sv.pick(e.clientX, e.clientY, { ports: s.tool.kind !== 'select' });
      down = { x: e.clientX, y: e.clientY, pick, shift: e.shiftKey || e.ctrlKey || e.metaKey };
      // left-drag on empty space orbits
      const empty = !pick.partId && !pick.probeId && !pick.jointId;
      sv.controls.mouseButtons.LEFT = empty && s.tool.kind === 'select' ? THREE.MOUSE.ROTATE : (-1 as any);
      if (s.tool.kind !== 'select') return;
      if (pick.probeId) {
        const pr = s.project.probes.find((p) => p.id === pick.probeId);
        if (pr && pr.target.kind === 'point') {
          select({ probes: [pr.id] });
          drag = { kind: 'probe', probeId: pr.id, partId: pr.target.part, z: sv.topZ(pr.target.part), moved: false };
        }
        return;
      }
      if (pick.partId) {
        const already = s.selection.parts.includes(pick.partId);
        if (down.shift) select({ parts: [pick.partId] }, true);
        else if (!already) select({ parts: [pick.partId] });
        const part = s.project.parts.find((p) => p.id === pick.partId)!;
        const z = part.pose.z;
        const pp = sv.planePoint(e.clientX, e.clientY, sv.topZ(part.id));
        if (!pp) return;
        if (s.simStatus === 'running') return; // no dragging while the simulation runs
        if (hasJoints(s.project, part.id) && !part.grounded) {
          const local = worldToLocal(part.pose, pp.x, pp.y);
          drag = { kind: 'articulate', partId: part.id, local, z: sv.topZ(part.id), moved: false };
        } else {
          const sel = getState().selection.parts;
          const ids = (sel.includes(part.id) ? sel : [part.id]).filter((id) => { const q = s.project.parts.find((x) => x.id === id); return q && (!hasJoints(s.project, id) || q.grounded || id === part.id); });
          const start = new Map(ids.map((id) => { const q = s.project.parts.find((x) => x.id === id)!; return [id, { x: q.pose.x, y: q.pose.y }] as const; }));
          drag = { kind: 'move', ids, start, grab: { x: pp.x, y: pp.y }, z: sv.topZ(part.id), moved: false, main: part.id, snap: null };
        }
        void z;
      }
    };

    const onMove = (e: PointerEvent) => {
      const s = getState();
      if (drag && down) {
        const dist = Math.hypot(e.clientX - down.x, e.clientY - down.y);
        if (!drag.moved && dist < 4) return;
        const pp = sv.planePoint(e.clientX, e.clientY, drag.z);
        if (!pp) return;
        if (!drag.moved) {
          drag.moved = true;
          sv.dragging = true;
          beginTxn(drag.kind === 'move' ? 'Move part' : drag.kind === 'articulate' ? 'Pose mechanism' : 'Move probe');
        }
        if (drag.kind === 'move') {
          const d = drag;
          let dx = pp.x - d.grab.x, dy = pp.y - d.grab.y;
          // snap ports of the dragged part to ports of other parts
          d.snap = null;
          const main = s.project.parts.find((p) => p.id === d.main)!;
          const st = d.start.get(d.main)!;
          const g = geometryOf(s.project, main);
          const tolMm = sv.mmPerPx() * 11;
          let best = tolMm;
          for (const port of g.ports) {
            const w = localToWorld({ x: st.x + dx, y: st.y + dy, angle: main.pose.angle }, port.x, port.y);
            for (const other of s.project.parts) {
              if (other.suppressed || d.ids.includes(other.id)) continue;
              const og = geometryOf(s.project, other);
              if (Math.hypot(other.pose.x - w.x, other.pose.y - w.y) > og.boundR + tolMm) continue;
              for (const op of og.ports) {
                const ow = localToWorld(other.pose, op.x, op.y);
                const dd = Math.hypot(ow.x - w.x, ow.y - w.y);
                if (dd < best) { best = dd; d.snap = { partId: other.id, port: op.id, myPort: port.id, world: ow }; dx += ow.x - w.x; dy += ow.y - w.y; }
              }
            }
          }
          if (!d.snap && !e.altKey) {
            // grid snap of the part origin
            const step = sv.mmPerPx() < 0.12 ? 0.5 : sv.mmPerPx() < 0.6 ? 1 : 5;
            dx = Math.round((st.x + dx) / step) * step - st.x;
            dy = Math.round((st.y + dy) / step) * step - st.y;
          }
          sv.showSnap(d.snap ? d.snap.world : null, d.z + 0.5);
          previewTxn((p) => ({ ...p, parts: p.parts.map((q) => (d.start.has(q.id) ? { ...q, pose: { ...q.pose, x: d.start.get(q.id)!.x + dx, y: d.start.get(q.id)!.y + dy } } : q)) }));
        } else if (drag.kind === 'articulate') {
          dragSolve({ partId: drag.partId, lx: drag.local.x, ly: drag.local.y, tx: pp.x, ty: pp.y });
        } else {
          const d = drag;
          const part = s.project.parts.find((p) => p.id === d.partId);
          if (part) {
            let local = worldToLocal(part.pose, pp.x, pp.y);
            // snap to this part's ports
            const g = geometryOf(s.project, part);
            const tol = sv.mmPerPx() * 9;
            for (const port of g.ports) if (Math.hypot(port.x - local.x, port.y - local.y) < tol) local = { x: port.x, y: port.y };
            previewTxn((p) => ({ ...p, probes: p.probes.map((pr) => (pr.id === d.probeId && pr.target.kind === 'point' ? { ...pr, target: { ...pr.target, anchor: { x: Math.round(local.x * 10) / 10, y: Math.round(local.y * 10) / 10 } } } : pr)) }));
          }
        }
        return;
      }
      if (e.buttons !== 0) return;
      const now = performance.now();
      if (now - hoverT < 40) return;
      hoverT = now;
      const pick = sv.pick(e.clientX, e.clientY, { ports: s.tool.kind !== 'select' });
      const h = pick.partId ? { part: pick.partId } : pick.jointId ? { joint: pick.jointId } : null;
      if ((h?.part ?? null) !== (s.hover?.part ?? null) || (h?.joint ?? null) !== (s.hover?.joint ?? null)) setState({ hover: h });
      if (s.tool.kind !== 'select' && pick.port && pick.partId) sv.showSnap(pick.world, sv.topZ(pick.partId) + 0.5); else sv.showSnap(null);
      host.style.cursor = s.tool.kind !== 'select' ? 'crosshair' : pick.partId || pick.probeId ? 'grab' : pick.jointId ? 'pointer' : 'default';
    };

    const onUp = (e: PointerEvent) => {
      if (e.button !== 0) return;
      const s = getState();
      const d = drag, dn = down;
      drag = null; down = null;
      sv.dragging = false;
      sv.showSnap(null);
      if (d && d.moved) {
        if (d.kind === 'move') {
          const snap = d.snap;
          const free = !hasJoints(s.project, d.main);
          endTxn((p) => {
            if (!snap || !free || d.ids.length > 1) return p;
            const me = p.parts.find((x) => x.id === d.main)!, other = p.parts.find((x) => x.id === snap.partId)!;
            const shafty = (k: string) => k === 'shaft' || k === 'motor';
            // mount on a shaft = rigid; otherwise a pivot
            if (shafty(me.kind) !== shafty(other.kind) && (snap.port === 'center' || snap.port === 'shaft') && (snap.myPort === 'center' || snap.myPort === 'shaft')) {
              const r = ops.mateRigid(p, snap.partId, { port: snap.port }, d.main, { port: snap.myPort });
              toast(`Mounted ${me.name} rigidly on ${other.name}. (Ctrl+Z to undo)`, 'ok');
              return r.project;
            }
            const r = ops.mateRevolute(p, snap.partId, { port: snap.port }, d.main, { port: snap.myPort });
            toast(`Pivot created between ${other.name} and ${me.name}. (Ctrl+Z to undo)`, 'ok');
            return r.project;
          }, true);
        } else endTxn();
        return;
      }
      if (!dn) return;
      if (Math.hypot(e.clientX - dn.x, e.clientY - dn.y) > 5) return; // it was an orbit
      const pick = dn.pick;
      const t = s.tool;
      if (t.kind === 'select') {
        if (pick.probeId) return;
        if (pick.partId) { if (!dn.shift && s.selection.parts.length > 1) select({ parts: [pick.partId] }); return; }
        if (pick.jointId) { select({ joints: [pick.jointId] }, dn.shift); return; }
        clearSelection();
        return;
      }
      if (t.kind === 'measure') {
        const z = pick.partId ? sv.topZ(pick.partId) : 0;
        const pt = new THREE.Vector3(pick.world.x, pick.world.y, z);
        if (!sv.measure.a || sv.measure.b) { sv.measure = { a: pt, b: null }; setMeasureText(null); }
        else {
          sv.measure.b = pt;
          const a = sv.measure.a;
          const u = s.project.units;
          const dx = pt.x - a.x, dy = pt.y - a.y, dz = pt.z - a.z;
          setMeasureText(`${formatQuantity(Math.hypot(dx, dy), 'length', u, 6)}   ΔX ${formatQuantity(dx, 'length', u, 6)}   ΔY ${formatQuantity(dy, 'length', u, 6)}   ΔZ ${formatQuantity(dz, 'length', u, 5)}   ∠ ${formatQuantity(Math.atan2(dy, dx), 'angle', u, 5)}`);
        }
        return;
      }
      if (t.kind === 'probe') {
        if (!pick.partId) { toast('Click a point on a part to place a probe.', 'info'); return; }
        let id = '';
        commit('Add probe', (p) => { const r = ops.addProbe(p, { target: { kind: 'point', part: pick.partId!, anchor: anchorOf(pick) }, name: `${p.parts.find((x) => x.id === pick.partId)!.name} point` }); id = r.id; return { ...r.project, plots: [...r.project.plots, { id: `plot_${id}`, title: `${r.project.probes[r.project.probes.length - 1].name}`, channels: [{ probe: id, quantity: 'x' }, { probe: id, quantity: 'y' }] }] }; }, { solve: false });
        select({ probes: [id] });
        setState({ tool: { kind: 'select' }, bottomTab: 'plots', bottomOpen: true });
        return;
      }
      if (t.kind === 'load') {
        if (!pick.partId) { toast('Click a point on a part to apply a load.', 'info'); return; }
        let id = '';
        commit('Add load', (p) => { const r = ops.addLoad(p, { type: 'force', part: pick.partId!, anchor: anchorOf(pick), fx: 0, fy: -1000, torque: 0, frame: 'world', enabled: true }); id = r.id; return r.project; }, { solve: false });
        select({ loads: [id] });
        setState({ tool: { kind: 'select' } });
        return;
      }
      if (t.kind === 'mate') {
        const needsParts = t.type === 'gear' || t.type === 'belt' || t.type === 'rackPinion' || t.type === 'cam';
        if (needsParts && !pick.partId) { toast('Click a part.', 'info'); return; }
        const first = mateRef.current;
        if (!first) {
          if (needsParts) { const why = couplingProblem(t.type, pick.partId!, null); if (why) { toast(why, 'error'); return; } }
          setMateFirst(pick.partId ? { partId: pick.partId, anchor: anchorOf(pick), world: pick.world } : { partId: GROUND, anchor: { x: round(pick.world.x), y: round(pick.world.y) }, world: pick.world });
          if (pick.partId) select({ parts: [pick.partId] });
          return;
        }
        finishMate(first, pick, t.type);
        setMateFirst(null);
        if (!e.shiftKey) setState({ tool: { kind: 'select' } });
      }
    };

    const onLeave = () => { if (getState().hover) setState({ hover: null }); sv.showSnap(null); };
    const onDbl = (e: MouseEvent) => {
      const pick = sv.pick(e.clientX, e.clientY, { ports: false });
      if (pick.partId) {
        const s = getState();
        const part = s.project.parts.find((p) => p.id === pick.partId);
        if (part?.kind === 'plate' && part.params.sketchId) setState({ mode: 'sketch', activeSketch: part.params.sketchId });
      }
    };
    host.addEventListener('pointerdown', onDown, true);
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    host.addEventListener('pointerleave', onLeave);
    host.addEventListener('dblclick', onDbl);
    host.addEventListener('contextmenu', (e) => e.preventDefault());
    return () => {
      host.removeEventListener('pointerdown', onDown, true);
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      host.removeEventListener('pointerleave', onLeave);
      host.removeEventListener('dblclick', onDbl);
      sv.dispose();
      viewRef.current = null;
    };
  }, []);

  const setView = (patch: Partial<typeof view>) => setState((s) => ({ view: { ...s.view, ...patch } }));
  const cam = (name: string) => setState((s) => ({ cameraRequest: { name, n: (s.cameraRequest?.n ?? 0) + 1 } }));
  const hint = tool.kind === 'mate' ? MATE_HINT[tool.type][mateFirst ? 1 : 0]
    : tool.kind === 'measure' ? 'Measure: click two points (they snap to holes, centres and ports). Esc to finish.'
    : tool.kind === 'probe' ? 'Probe: click a point on a part to record its motion. Esc to cancel.'
    : tool.kind === 'load' ? 'Load: click the point on a part where the force acts. Esc to cancel.' : null;

  return (
    <div className="viewport">
      <div ref={hostRef} className="viewport-canvas" data-testid="viewport" />
      {partCount === 0 && (
        <div className="empty-state">
          <Box size={30} strokeWidth={1.4} />
          <h3>Empty workshop</h3>
          <p>Add components from the <b>Library</b> on the left, drag them so their holes snap together, ground one part (<kbd>G</kbd>), give a pivot a motor, then press <kbd>Space</kbd>.</p>
          <p className="dim">Or open one of the five showcase projects from <b>Examples</b> in the top bar.</p>
        </div>
      )}
      <div className="view-toolbar" role="toolbar" aria-label="View controls">
        <Seg value={view.ortho ? 'o' : 'p'} onChange={(v) => setView({ ortho: v === 'o' })} options={[{ value: 'p', label: 'Persp', title: 'Perspective camera (O)' }, { value: 'o', label: 'Ortho', title: 'Orthographic camera (O)' }]} />
        <div className="btn-row">
          {(['front', 'back', 'top', 'bottom', 'right', 'left', 'iso'] as const).map((n, i) => (
            <button key={n} className="chip" title={`${n[0].toUpperCase() + n.slice(1)} view (${i + 1})`} onClick={() => cam(n)}>{n === 'iso' ? 'Iso' : n[0].toUpperCase() + n.slice(1)}</button>
          ))}
          <IconButton title="Zoom to fit (F)" onClick={() => cam('fit')}><Maximize size={15} /></IconButton>
        </div>
        {views.length > 0 && (
          <div className="btn-row">
            {views.map((v, i) => <button key={i} className="chip accent" title={`Saved inspection camera: ${v.name}`} onClick={() => { setView({ ortho: v.ortho }); cam(`view:${i}`); }}>{v.name}</button>)}
          </div>
        )}
      </div>
      <div className="view-toolbar right" role="toolbar" aria-label="Display options">
        <IconButton title="Joint and constraint overlays" active={view.showJoints} onClick={() => setView({ showJoints: !view.showJoints })}><Waypoints size={15} /></IconButton>
        <IconButton title="Motion traces" active={view.showTraces} onClick={() => setView({ showTraces: !view.showTraces })}><Activity size={15} /></IconButton>
        <IconButton title="Force arrows (loads, floor contact)" active={view.showForces} onClick={() => setView({ showForces: !view.showForces })}><Crosshair size={15} /></IconButton>
        <IconButton title="Camera follows a free-body machine while it runs" active={view.follow} onClick={() => setView({ follow: !view.follow })}><Box size={15} /></IconButton>
        <IconButton title="Grid" active={view.showGrid} onClick={() => setView({ showGrid: !view.showGrid })}><Grid3x3 size={15} /></IconButton>
        <IconButton title="Shadows" active={view.shadows} onClick={() => setView({ shadows: !view.shadows })}><Sun size={15} /></IconButton>
        <IconButton title="Transparent parts (X)" active={view.transparent} onClick={() => setView({ transparent: !view.transparent })}><Eye size={15} /></IconButton>
        <IconButton title="Section view" active={view.section.enabled} onClick={() => setView({ section: { ...view.section, enabled: !view.section.enabled } })}><Scissors size={15} /></IconButton>
        <div className="explode" title="Exploded view: separates parts along the stacking (Z) axis">
          <Layers size={14} />
          <input type="range" min={0} max={1} step={0.01} value={view.explode} aria-label="Explode" onChange={(e) => setView({ explode: parseFloat(e.target.value) })} />
        </div>
      </div>
      {view.section.enabled && (
        <div className="section-panel">
          <span className="lbl">Section normal</span>
          <Seg value={view.section.axis} onChange={(v) => setView({ section: { ...view.section, axis: v as 'x' | 'y' | 'z' } })} options={[{ value: 'x', label: 'X' }, { value: 'y', label: 'Y' }, { value: 'z', label: 'Z' }]} />
          <input type="range" min={-1} max={1} step={0.005} value={view.section.offset} aria-label="Section position" onChange={(e) => setView({ section: { ...view.section, offset: parseFloat(e.target.value) } })} />
          <button className="chip" onClick={() => setView({ section: { ...view.section, flip: !view.section.flip } })}>Flip</button>
        </div>
      )}
      {hint && <div className="tool-hint" role="status">{hint}</div>}
      <svg ref={triadRef} className="triad" width="60" height="60" aria-hidden="true" />
      <div className="scalebar" aria-label="Scale bar"><div ref={scaleRef} className="bar" /><span ref={scaleLabelRef} /></div>
      <div ref={measureRef} className="measure-label" style={{ display: 'none' }}>{measureText ?? 'click second point'}</div>
      <span style={{ display: 'none' }}>{units.length}</span>
    </div>
  );
}

export type { Tool };
