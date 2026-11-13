import { useMemo, useState } from 'react';
import {
  Anchor, Box, Cable, ChevronDown, ChevronRight, CircleDot, Cog, Eye, EyeOff, FolderTree, Gauge, Library, Link2, Lock,
  MoveHorizontal, PencilRuler, Plus, RotateCw, Search, Spline, Target, Zap, ArrowDownToLine, Ruler, Waves,
} from 'lucide-react';
import { PART_DEFS, type PartDef } from '../../core/parts/catalog';
import type { PartKind, Project } from '../../core/model/types';
import { GROUND } from '../../core/model/types';
import { geometryOf, jointLabel } from '../../core/model/project';
import * as ops from '../../core/model/ops';
import { newSketch } from '../../core/sketch/ops';
import { commit, select, setState, toast, useApp, getState, type Tool } from '../store';
import { viewRef } from '../viewport/Viewport';

const KIND_ICON: Record<string, any> = {
  link: Link2, gear: Cog, rack: MoveHorizontal, shaft: CircleDot, bearing: CircleDot, cam: Spline, follower: ArrowDownToLine, pulley: CircleDot,
  crank: RotateCw, rail: MoveHorizontal, slider: Box, baseplate: Box, plate: PencilRuler, fastener: CircleDot, motor: Zap,
};

function addPartAtView(kind: PartKind): void {
  const sv = viewRef.current;
  const s = getState();
  let x = 0, y = 0;
  if (sv) { x = Math.round(sv.controls.target.x); y = Math.round(sv.controls.target.y); }
  // avoid stacking new parts exactly on top of each other
  const n = s.project.parts.filter((p) => Math.hypot(p.pose.x - x, p.pose.y - y) < 1).length;
  x += n * 12; y -= n * 12;
  let id = '';
  commit(`Add ${PART_DEFS[kind].label}`, (p) => {
    // distinct default colours keep neighbouring custom parts legible
    const palette = ['#e8a33d', '#4c9fd8', '#62c370', '#d08770', '#b48ead', '#5eb5b0', '#d6b25a', '#8fa1c7'];
    const nCustom = p.parts.filter((q) => !PART_DEFS[q.kind].purchased && q.kind !== 'baseplate').length;
    const color = PART_DEFS[kind].purchased || kind === 'baseplate' ? undefined : palette[nCustom % palette.length];
    const r = ops.addPart(p, kind, { pose: { x, y, z: 0 }, color, materialId: kind === 'baseplate' ? 'aluminum' : undefined });
    id = r.id;
    // drop the new part on top of whatever already occupies that spot, so it never starts inside another part
    const me = r.project.parts.find((q) => q.id === id)!;
    const g = geometryOf(r.project, me);
    let top = -Infinity;
    for (const o of p.parts) {
      if (o.suppressed) continue;
      const og = geometryOf(p, o);
      if (Math.hypot(o.pose.x - x, o.pose.y - y) < og.boundR + g.boundR) top = Math.max(top, o.pose.z + og.zMax);
    }
    return top > -Infinity ? ops.setPartPose(r.project, id, { z: Math.round((top - g.zMin + 0.5) * 100) / 100 }) : r.project;
  }, { solve: false });
  if (id) { select({ parts: [id] }); setState({ tool: { kind: 'select' } }); }
}

function createSketchPart(): void {
  const s = getState();
  const sid = `sk_${Date.now().toString(36)}`;
  let pid = '';
  commit('New sketch', (p) => {
    const sk = newSketch(sid, ops.uniqueName(p.sketches.map((x) => x.name), 'Sketch 1'));
    const sv = viewRef.current;
    const r = ops.addPart({ ...p, sketches: [...p.sketches, sk] }, 'plate', { name: 'Sketched part', params: { sketchId: sid, thickness: 4 }, pose: { x: sv ? Math.round(sv.controls.target.x) : 0, y: sv ? Math.round(sv.controls.target.y) : 0, z: 0 } });
    pid = r.id;
    return r.project;
  }, { solve: false });
  if (pid) { select({ parts: [pid] }); setState({ mode: 'sketch', activeSketch: sid }); }
  void s;
}

const CONNECT: { tool: Tool; label: string; desc: string; icon: any; keys: string }[] = [
  { tool: { kind: 'mate', type: 'revolute' }, label: 'Pivot (revolute)', desc: 'Pin two parts together at a hole or point; 1 rotational freedom.', icon: RotateCw, keys: 'pivot pin hinge revolute rotate joint' },
  { tool: { kind: 'mate', type: 'prismatic' }, label: 'Slide (prismatic)', desc: 'Let a part slide along an axis of another; 1 translational freedom.', icon: MoveHorizontal, keys: 'slide prismatic linear guide joint' },
  { tool: { kind: 'mate', type: 'rigid' }, label: 'Fix (rigid)', desc: 'Attach two parts rigidly, e.g. a gear to its shaft.', icon: Lock, keys: 'rigid fix weld attach mount joint' },
  { tool: { kind: 'mate', type: 'gear' }, label: 'Gear mesh', desc: 'Couple two spur gears by their tooth counts.', icon: Cog, keys: 'gear mesh ratio coupling' },
  { tool: { kind: 'mate', type: 'rackPinion' }, label: 'Rack & pinion', desc: 'Couple a gear to a rack.', icon: Cog, keys: 'rack pinion coupling' },
  { tool: { kind: 'mate', type: 'belt' }, label: 'Belt', desc: 'Couple two pulleys with an ideal belt.', icon: Cable, keys: 'belt pulley drive coupling' },
  { tool: { kind: 'mate', type: 'cam' }, label: 'Cam contact', desc: 'One-sided contact between a cam and a follower roller.', icon: Spline, keys: 'cam contact follower' },
  { tool: { kind: 'mate', type: 'spring' }, label: 'Spring', desc: 'Linear spring-damper between two points (purchased part).', icon: Waves, keys: 'spring damper elastic preload stiffness' },
  { tool: { kind: 'load' }, label: 'External load', desc: 'Force or torque acting on a part.', icon: ArrowDownToLine, keys: 'load force torque weight' },
  { tool: { kind: 'probe' }, label: 'Probe', desc: 'Record and trace the motion of a point.', icon: Target, keys: 'probe measure trace sensor plot' },
  { tool: { kind: 'measure' }, label: 'Measure', desc: 'Distance and offsets between two snapped points.', icon: Ruler, keys: 'measure distance dimension ruler' },
];

function LibraryPanel() {
  const [q, setQ] = useState('');
  const tool = useApp((s) => s.tool);
  const sel = useApp((s) => s.selection);
  const project = useApp((s) => s.project);
  const query = q.trim().toLowerCase();
  const match = (text: string) => query.split(/\s+/).every((w) => text.toLowerCase().includes(w));
  const defs = Object.values(PART_DEFS).filter((d) => d.kind !== 'plate' && (!query || match(`${d.label} ${d.keywords} ${d.category} ${d.description}`)));
  const cats = useMemo(() => { const m = new Map<string, PartDef[]>(); for (const d of defs) { if (!m.has(d.category)) m.set(d.category, []); m.get(d.category)!.push(d); } return [...m.entries()]; }, [defs.map((d) => d.kind).join()]);
  const conns = CONNECT.filter((c) => !query || match(`${c.label} ${c.keys} ${c.desc}`));
  const showSketch = !query || match('sketch extrude custom profile plate cut hole draw');
  const showMotor = !query || match('motor drive actuator servo speed torque');
  const addMotor = () => {
    const j = project.joints.find((x) => x.id === sel.joints[0]);
    if (!j || (j.type !== 'revolute' && j.type !== 'prismatic')) { toast('Select a pivot or slide joint first (click its symbol in the viewport or pick it in the Assembly tree), then add the motor.', 'info'); return; }
    if (j.motor?.enabled) { toast(`"${j.name}" already has a motor. Edit its speed and torque limit in the inspector.`, 'info'); return; }
    commit('Add motor', (p) => ops.updateJoint(p, j.id, { motor: { ...(j.motor ?? ops.DEFAULT_MOTOR), enabled: true, ...(j.type === 'prismatic' && !j.motor ? { speed: 20 } : {}) } }), { solve: false });
    toast(`Motor added to "${j.name}". Set its speed and torque limit in the inspector.`, 'ok');
  };
  const empty = defs.length === 0 && conns.length === 0 && !showSketch && !showMotor;
  return (
    <div className="library" data-testid="library">
      <div className="search">
        <Search size={14} />
        <input type="search" placeholder="Search components and joints…" aria-label="Search library" value={q} data-testid="library-search" onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => e.stopPropagation()} />
      </div>
      <div className="lib-scroll">
        {empty && <div className="empty-list">No component matches “{q}”. Try “gear”, “link”, “spring” or “motor”.</div>}
        {cats.map(([cat, list]) => (
          <div key={cat} className="lib-cat">
            <h4>{cat}</h4>
            {list.map((d) => { const Icon = KIND_ICON[d.kind] ?? Box; return (
              <button key={d.kind} className="lib-item" data-testid={`lib-${d.kind}`} title={d.description} onClick={() => addPartAtView(d.kind)}>
                <span className="lib-ico"><Icon size={16} /></span>
                <span className="lib-txt"><b>{d.label}</b><small>{d.description}</small></span>
                <span className={`badge ${d.purchased ? 'buy' : 'make'}`}>{d.purchased ? 'buy' : 'make'}</span>
              </button>
            ); })}
          </div>
        ))}
        {showSketch && (
          <div className="lib-cat">
            <h4>Sketch</h4>
            <button className="lib-item" data-testid="lib-sketch" onClick={createSketchPart}>
              <span className="lib-ico"><PencilRuler size={16} /></span>
              <span className="lib-txt"><b>New sketched part</b><small>Draw a dimensioned profile and extrude it; circles become holes you can pin.</small></span>
              <span className="badge make">make</span>
            </button>
          </div>
        )}
        {(conns.length > 0 || showMotor) && (
          <div className="lib-cat">
            <h4>Joints, drives & measurement</h4>
            {conns.map((c) => { const on = JSON.stringify(tool) === JSON.stringify(c.tool); return (
              <button key={c.label} className={`lib-item ${on ? 'on' : ''}`} data-testid={`tool-${c.tool.kind === 'mate' ? c.tool.type : c.tool.kind}`} title={c.desc} onClick={() => setState({ tool: on ? { kind: 'select' } : c.tool })}>
                <span className="lib-ico"><c.icon size={16} /></span>
                <span className="lib-txt"><b>{c.label}</b><small>{c.desc}</small></span>
              </button>
            ); })}
            {showMotor && (
              <button className="lib-item" data-testid="tool-motor" onClick={addMotor}>
                <span className="lib-ico"><Gauge size={16} /></span>
                <span className="lib-txt"><b>Motor on selected joint</b><small>Drive the selected pivot or slide with a speed and torque limit.</small></span>
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function TreeRow(props: { depth: number; icon: any; label: string; selected: boolean; onClick: (e: React.MouseEvent) => void; onRename?: (name: string) => void; badges?: React.ReactNode; dim?: boolean; right?: React.ReactNode; testId?: string; focus?: boolean }) {
  const [editing, setEditing] = useState(false);
  const Icon = props.icon;
  return (
    <div className={`tree-row ${props.selected ? 'sel' : ''} ${props.dim ? 'dim' : ''} ${props.focus ? 'focus' : ''}`} style={{ paddingLeft: 8 + props.depth * 14 }} role="treeitem" aria-selected={props.selected} data-testid={props.testId}
      onClick={props.onClick} onDoubleClick={() => props.onRename && setEditing(true)}>
      <Icon size={13} className="tree-ico" />
      {editing ? (
        <input autoFocus defaultValue={props.label} className="tree-edit" aria-label="Rename" onClick={(e) => e.stopPropagation()}
          onBlur={(e) => { setEditing(false); const v = e.target.value.trim(); if (v && v !== props.label) props.onRename!(v); }}
          onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); if (e.key === 'Escape') setEditing(false); e.stopPropagation(); }} />
      ) : <span className="tree-label" title={props.onRename ? 'Double-click to rename' : undefined}>{props.label}</span>}
      <span className="tree-badges">{props.badges}</span>
      {props.right}
    </div>
  );
}

function TreePanel() {
  const project = useApp((s) => s.project);
  const sel = useApp((s) => s.selection);
  const focus = useApp((s) => s.focus);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const toggle = (k: string) => setCollapsed((c) => ({ ...c, [k]: !c[k] }));
  const header = (key: string, label: string, count: number, extra?: React.ReactNode) => (
    <div className="tree-head" onClick={() => toggle(key)} role="button" aria-expanded={!collapsed[key]}>
      {collapsed[key] ? <ChevronRight size={12} /> : <ChevronDown size={12} />}<span>{label}</span><span className="count">{count}</span>{extra}
    </div>
  );
  const partRow = (p: Project['parts'][number], depth: number) => {
    const Icon = KIND_ICON[p.kind] ?? Box;
    return (
      <TreeRow key={p.id} depth={depth} icon={Icon} label={p.name} selected={sel.parts.includes(p.id)} dim={p.suppressed} focus={focus?.parts.includes(p.id)} testId={`tree-part-${p.id}`}
        onClick={(e) => select({ parts: [p.id] }, e.shiftKey || e.ctrlKey || e.metaKey)}
        onRename={(name) => commit('Rename part', (pr) => ops.updatePart(pr, p.id, { name }), { solve: false })}
        badges={<>{p.grounded && <span className="badge gnd" title="Grounded"><Anchor size={10} /></span>}</>}
        right={<button className="tree-eye" title={p.suppressed ? 'Unsuppress' : 'Suppress (exclude from assembly and simulation)'} aria-label="Toggle suppression" onClick={(e) => { e.stopPropagation(); commit(p.suppressed ? 'Unsuppress part' : 'Suppress part', (pr) => ops.updatePart(pr, p.id, { suppressed: !p.suppressed }), { solve: false }); }}>{p.suppressed ? <EyeOff size={12} /> : <Eye size={12} />}</button>} />
    );
  };
  const ungrouped = project.parts.filter((p) => !p.groupId || !project.groups.some((g) => g.id === p.groupId));
  const nameOf = (id: string) => (id === GROUND ? 'ground' : project.parts.find((p) => p.id === id)?.name ?? '?');
  if (project.parts.length === 0 && project.joints.length === 0) {
    return <div className="tree"><div className="empty-list"><FolderTree size={22} /><p>The assembly is empty.</p><p className="dim">Switch to the Library tab and click a component to add it.</p><button className="btn" onClick={() => setState({ leftTab: 'library' })}><Plus size={13} /> Open library</button></div></div>;
  }
  return (
    <div className="tree" role="tree" data-testid="tree">
      {header('parts', 'Parts', project.parts.length)}
      {!collapsed.parts && (
        <>
          {project.groups.map((g) => {
            const members = project.parts.filter((p) => p.groupId === g.id);
            const all = members.every((p) => sel.parts.includes(p.id)) && members.length > 0;
            return (
              <div key={g.id}>
                <TreeRow depth={0} icon={collapsed[g.id] ? ChevronRight : ChevronDown} label={`${g.name}`} selected={all} testId={`tree-group-${g.id}`}
                  onClick={(e) => { if ((e.target as HTMLElement).closest('.tree-ico')) toggle(g.id); else select({ parts: members.map((m) => m.id) }, e.shiftKey); }}
                  onRename={(name) => commit('Rename group', (pr) => ({ ...pr, groups: pr.groups.map((x) => (x.id === g.id ? { ...x, name } : x)) }), { solve: false })}
                  badges={<span className="count">{members.length}</span>}
                  right={<button className="tree-eye" title="Ungroup" aria-label="Ungroup" onClick={(e) => { e.stopPropagation(); commit('Ungroup', (pr) => ops.ungroup(pr, g.id), { solve: false }); }}>×</button>} />
                {!collapsed[g.id] && members.map((p) => partRow(p, 1))}
              </div>
            );
          })}
          {ungrouped.map((p) => partRow(p, 0))}
        </>
      )}
      {header('joints', 'Joints & couplings', project.joints.length)}
      {!collapsed.joints && project.joints.map((j) => (
        <TreeRow key={j.id} depth={0} icon={j.type === 'revolute' ? RotateCw : j.type === 'prismatic' ? MoveHorizontal : j.type === 'rigid' ? Lock : j.type === 'spring' ? Waves : j.type === 'belt' ? Cable : j.type === 'cam' ? Spline : Cog}
          label={j.name} selected={sel.joints.includes(j.id)} dim={j.suppressed} focus={focus?.joints.includes(j.id)} testId={`tree-joint-${j.id}`}
          onClick={(e) => select({ joints: [j.id] }, e.shiftKey || e.ctrlKey || e.metaKey)}
          onRename={(name) => commit('Rename joint', (pr) => ops.updateJoint(pr, j.id, { name }), { solve: false })}
          badges={<>{j.motor?.enabled && <span className="badge motor" title="Motor"><Zap size={10} /></span>}<span className="tree-sub" title={`${jointLabel(j)}: ${nameOf(j.a)} ↔ ${nameOf(j.b)}`}>{nameOf(j.a)} ↔ {nameOf(j.b)}</span></>} />
      ))}
      {project.loads.length > 0 && header('loads', 'Loads', project.loads.length)}
      {!collapsed.loads && project.loads.map((l) => (
        <TreeRow key={l.id} depth={0} icon={ArrowDownToLine} label={l.name} selected={sel.loads.includes(l.id)} dim={!l.enabled} onClick={() => select({ loads: [l.id] })}
          onRename={(name) => commit('Rename load', (pr) => ({ ...pr, loads: pr.loads.map((x) => (x.id === l.id ? { ...x, name } : x)) }), { solve: false })} badges={<span className="tree-sub">{nameOf(l.part)}</span>} />
      ))}
      {project.probes.length > 0 && header('probes', 'Probes', project.probes.length)}
      {!collapsed.probes && project.probes.map((pr) => (
        <TreeRow key={pr.id} depth={0} icon={Target} label={pr.name} selected={sel.probes.includes(pr.id)} onClick={() => select({ probes: [pr.id] })}
          onRename={(name) => commit('Rename probe', (p) => ({ ...p, probes: p.probes.map((x) => (x.id === pr.id ? { ...x, name } : x)) }), { solve: false })}
          badges={<span className="swatch" style={{ background: pr.target.kind === 'point' ? pr.color : 'transparent' }} />} />
      ))}
      {project.sketches.length > 0 && header('sketches', 'Sketches', project.sketches.length)}
      {!collapsed.sketches && project.sketches.map((sk) => (
        <TreeRow key={sk.id} depth={0} icon={PencilRuler} label={sk.name} selected={false} onClick={() => setState({ mode: 'sketch', activeSketch: sk.id })}
          onRename={(name) => commit('Rename sketch', (p) => ({ ...p, sketches: p.sketches.map((x) => (x.id === sk.id ? { ...x, name } : x)) }), { solve: false })} badges={<span className="tree-sub">click to edit</span>} />
      ))}
    </div>
  );
}

export function LeftPanel() {
  const tab = useApp((s) => s.leftTab);
  return (
    <aside className="left-panel" aria-label="Assembly and library">
      <div className="tabs" role="tablist">
        <button role="tab" aria-selected={tab === 'tree'} className={tab === 'tree' ? 'on' : ''} data-testid="tab-tree" onClick={() => setState({ leftTab: 'tree' })}><FolderTree size={14} /> Assembly</button>
        <button role="tab" aria-selected={tab === 'library'} className={tab === 'library' ? 'on' : ''} data-testid="tab-library" onClick={() => setState({ leftTab: 'library' })}><Library size={14} /> Library</button>
      </div>
      {tab === 'tree' ? <TreePanel /> : <LibraryPanel />}
    </aside>
  );
}
