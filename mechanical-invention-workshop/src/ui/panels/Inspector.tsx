import { Anchor as AnchorIcon, Copy, EyeOff, Lock, Plus, Trash2, PencilRuler, LineChart } from 'lucide-react';
import type { Anchor, CamSegment, Joint, Load, Part, PlateHole, Probe, Project } from '../../core/model/types';
import { GROUND } from '../../core/model/types';
import { PART_DEFS, type ParamDef } from '../../core/parts/catalog';
import { allMaterials, anchorWorld, geometryOf, jointLabel, massProps } from '../../core/model/project';
import * as ops from '../../core/model/ops';
import { applyPoseEdit } from '../../core/assembly/solve';
import { formatQuantity, DEG, type QuantityKind } from '../../core/units';
import { camSegmentSummary } from '../../core/parts/profiles';
import { quantitiesFor, PROVENANCE_LABEL } from '../../core/sim/runner';
import { commit, getState, heldMessage, poseHeld, poseMissed, reposedMessage, select, setState, simCtl, toast, useApp } from '../store';
import { Check, IconButton, NumField, Readout, Row, Section, SelectField, TextField } from '../widgets';
import { ProjectSettings } from './ProjectSettings';

function ParamEditor({ part, def, project }: { part: Part; def: ParamDef; project: Project }) {
  const v = part.params[def.key];
  const set = (val: any) => commit(`Edit ${part.name} · ${def.label}`, (p) => ops.setPartParam(p, part.id, def.key, val));
  const tid = `param-${def.key}`;
  switch (def.type) {
    case 'int':
      return <Row label={def.label} help={def.help}><NumField value={v} kind="count" min={def.min} max={def.max} onCommit={(x) => set(Math.round(x))} label={def.label} testId={tid} /></Row>;
    case 'bool':
      return <Row label={def.label} help={def.help}><Check checked={!!v} onChange={set} label="" testId={tid} /></Row>;
    case 'enum':
      return <Row label={def.label} help={def.help}><SelectField value={v} options={def.options!} onChange={set} label={def.label} testId={tid} /></Row>;
    case 'camSegments':
      return <CamSegments part={part} segments={v as CamSegment[]} />;
    case 'holes':
      return <Holes part={part} holes={v as PlateHole[]} />;
    case 'sketch': {
      const sk = project.sketches.find((s) => s.id === v);
      return (
        <Row label="Sketch">
          <button className="btn" data-testid="edit-sketch" onClick={() => setState({ mode: 'sketch', activeSketch: v })} disabled={!sk}><PencilRuler size={13} /> {sk ? `Edit "${sk.name}"` : 'Missing'}</button>
        </Row>
      );
    }
    default:
      return <Row label={def.label} help={def.help}><NumField value={v} kind={def.type as QuantityKind} min={def.min} max={def.max} onCommit={set} label={def.label} testId={tid} /></Row>;
  }
}

function CamSegments({ part, segments }: { part: Part; segments: CamSegment[] }) {
  const update = (next: CamSegment[], label = 'Edit cam program') => commit(label, (p) => ops.setPartParam(p, part.id, 'segments', next));
  const sum = camSegmentSummary(segments);
  const total = (sum.total / DEG);
  return (
    <div className="table-editor" data-testid="cam-segments">
      <div className="te-head"><span>Motion law</span><span>Duration</span><span>End lift</span><span /></div>
      {segments.map((s, i) => (
        <div className="te-row" key={i}>
          <SelectField value={s.law} label={`Segment ${i + 1} law`} options={[{ value: 'cycloidal', label: 'Cycloidal' }, { value: 'harmonic', label: 'Harmonic' }, { value: 'poly345', label: '3-4-5 poly' }, { value: 'linear', label: 'Constant vel.' }, { value: 'dwell', label: 'Dwell' }]} onChange={(law) => update(segments.map((x, k) => (k === i ? { ...x, law } : x)))} />
          <NumField compact value={s.duration} kind="angle" min={0.001} max={2 * Math.PI} label={`Segment ${i + 1} duration`} testId={`cam-dur-${i}`} onCommit={(d) => update(segments.map((x, k) => (k === i ? { ...x, duration: d } : x)))} />
          <NumField compact value={s.law === 'dwell' ? (i > 0 ? prevLift(segments, i) : 0) : s.lift} kind="length" disabled={s.law === 'dwell'} label={`Segment ${i + 1} end lift`} testId={`cam-lift-${i}`} onCommit={(l) => update(segments.map((x, k) => (k === i ? { ...x, lift: l } : x)))} />
          <IconButton title="Remove segment" onClick={() => update(segments.filter((_, k) => k !== i), 'Remove cam segment')} disabled={segments.length <= 1}><Trash2 size={12} /></IconButton>
        </div>
      ))}
      <div className="te-foot">
        <button className="btn small" onClick={() => update([...segments, { duration: 30 * DEG, lift: sum.endLift, law: 'dwell' }], 'Add cam segment')}><Plus size={12} /> Segment</button>
        <span className={`badge ${Math.abs(total - 360) < 0.01 && Math.abs(sum.endLift) < 1e-6 ? 'ok' : 'warn'}`}>Σ {total.toFixed(1)}° · end lift {sum.endLift.toFixed(2)} mm</span>
      </div>
      <p className="hint">Lift is measured above the base circle, in the order the follower meets it for counter-clockwise cam rotation. The program should total 360° and return to 0.</p>
    </div>
  );
}
function prevLift(segs: CamSegment[], i: number): number {
  let h = 0;
  for (let k = 0; k < i; k++) if (segs[k].law !== 'dwell') h = segs[k].lift;
  return h;
}

function Holes({ part, holes }: { part: Part; holes: PlateHole[] }) {
  const update = (next: PlateHole[], label = 'Edit plate holes') => commit(label, (p) => ops.setPartParam(p, part.id, 'holes', next));
  return (
    <div className="table-editor" data-testid="plate-holes">
      <div className="te-head four"><span>#</span><span>X</span><span>Y</span><span>⌀</span><span /></div>
      {holes.map((h, i) => (
        <div className="te-row four" key={i}>
          <span className="mono dim">H{i + 1}</span>
          <NumField compact value={h.x} kind="length" label={`Hole ${i + 1} X`} onCommit={(x) => update(holes.map((q, k) => (k === i ? { ...q, x } : q)))} />
          <NumField compact value={h.y} kind="length" label={`Hole ${i + 1} Y`} onCommit={(y) => update(holes.map((q, k) => (k === i ? { ...q, y } : q)))} />
          <NumField compact value={h.d} kind="length" min={0} label={`Hole ${i + 1} diameter`} onCommit={(d) => update(holes.map((q, k) => (k === i ? { ...q, d } : q)))} />
          <IconButton title="Remove hole (joints using it will report a missing anchor)" onClick={() => update(holes.filter((_, k) => k !== i), 'Remove plate hole')}><Trash2 size={12} /></IconButton>
        </div>
      ))}
      <div className="te-foot"><button className="btn small" onClick={() => update([...holes, { x: 0, y: 0, d: 4 }], 'Add plate hole')}><Plus size={12} /> Hole</button><span className="hint">from plate centre</span></div>
    </div>
  );
}

/**
 * Apply a typed pose ("this part goes there", see applyPoseEdit): the mechanism follows through its joints
 * when it can, and the value is then met exactly. When it cannot, a dry run of the assembly solve decides:
 * nothing can move (the edit is refused without touching the undo history, and explained), or the solver
 * re-poses the mechanism to a configuration that keeps every joint closed (one undoable step, explained
 * with where the part ended up). "Kept" is judged at the precision the field displays.
 */
function poseEdit(part: Part, label: string, patch: Partial<Part['pose']>): void {
  const before = getState().project;
  const edit = applyPoseEdit(before, part.id, patch);
  if (poseMissed(before, part.id, patch) && edit.how === 'plain' && poseHeld(before, edit.project)) { toast(heldMessage([part.name]), 'info'); return; }
  if (!commit(label, (p) => (p === before ? edit.project : applyPoseEdit(p, part.id, patch).project))) return;
  const after = getState().project;
  if (!getState().assemblyIssues.length && poseMissed(after, part.id, patch)) toast(reposedMessage(after, part.id, patch), 'info');
}

function PartInspector({ part, project }: { part: Part; project: Project }) {
  const def = PART_DEFS[part.kind];
  const g = geometryOf(project, part);
  const mp = massProps(project, part);
  const u = project.units;
  const full = { ...part.params };
  const upd = (label: string, patch: Partial<Part>, solve = true) => commit(label, (p) => ops.updatePart(p, part.id, patch), { solve });
  const joints = project.joints.filter((j) => j.a === part.id || j.b === part.id);
  return (
    <>
      <div className="insp-head">
        <div className="kind">{def.label}<span className={`badge ${def.purchased ? 'buy' : 'make'}`}>{def.purchased ? 'purchased' : 'custom part'}</span></div>
        <TextField value={part.name} label="Part name" testId="part-name" onCommit={(name) => name.trim() && upd('Rename part', { name: name.trim() }, false)} />
        <p className="desc">{def.description}</p>
      </div>
      {g.errors.length > 0 && <div className="callout err" role="alert" data-testid="part-errors">{g.errors.map((w, i) => <p key={i}><b>Error:</b> {w}</p>)}</div>}
      {g.warnings.length > 0 && <div className="callout warn" data-testid="part-warnings">{g.warnings.map((w, i) => <p key={i}><b>Warning:</b> {w}</p>)}</div>}
      <Section title="Dimensions">
        {def.params.filter((d) => !d.when || d.when(full)).map((d) => <ParamEditor key={d.key} part={part} def={d} project={project} />)}
      </Section>
      <Section title="Placement">
        <Row label="X"><NumField value={part.pose.x} kind="length" label="X position" testId="pose-x" onCommit={(x) => poseEdit(part, 'Move part', { x })} /></Row>
        <Row label="Y"><NumField value={part.pose.y} kind="length" label="Y position" testId="pose-y" onCommit={(y) => poseEdit(part, 'Move part', { y })} /></Row>
        <Row label="Rotation"><NumField value={part.pose.angle} kind="angle" label="Rotation" testId="pose-angle" onCommit={(angle) => poseEdit(part, 'Rotate part', { angle })} /></Row>
        <Row label="Z (layer)" help="Offset along the stacking axis. Parts whose Z ranges overlap can interfere."><NumField value={part.pose.z} kind="length" label="Z offset" testId="pose-z" onCommit={(z) => commit('Change layer', (p) => ops.setPartPose(p, part.id, { z }), { solve: false })} /></Row>
        <Readout label="Z extent" value={`${formatQuantity(part.pose.z + g.zMin, 'length', u)} … ${formatQuantity(part.pose.z + g.zMax, 'length', u)}`} />
        <div className="row-btns">
          <Check checked={part.grounded} label="Grounded (fixed to world)" testId="grounded" onChange={(v) => upd(v ? 'Ground part' : 'Unground part', { grounded: v })} />
          <Check checked={!!part.suppressed} label="Suppressed" testId="suppressed" onChange={(v) => upd(v ? 'Suppress part' : 'Unsuppress part', { suppressed: v }, false)} />
        </div>
      </Section>
      <Section title="Material & mass">
        <Row label="Material"><SelectField value={part.materialId} label="Material" options={allMaterials(project).map((m) => ({ value: m.id, label: m.name }))} onChange={(materialId) => upd('Change material', { materialId }, false)} /></Row>
        <Row label="Colour">
          <span className="color-row">
            <input type="color" aria-label="Part colour" value={part.color ?? allMaterials(project).find((m) => m.id === part.materialId)?.color ?? '#cccccc'} onChange={(e) => upd('Change colour', { color: e.target.value }, false)} />
            {part.color && <button className="btn small" onClick={() => upd('Reset colour', { color: undefined }, false)}>Material default</button>}
          </span>
        </Row>
        <Readout label="Volume" value={formatQuantity(mp.volume, 'volume', u)} />
        <Readout label="Mass" value={formatQuantity(mp.mass, 'mass', u)} title="density × volume unless overridden" />
        <Readout label="Inertia (about COM, Z)" value={formatQuantity(mp.inertia, 'inertia', u)} />
        <Row label="Mass override" help="Leave empty to use density × volume. Inertia scales with the mass unless overridden too.">
          <NumField value={part.massOverride?.mass ?? null} kind="mass" min={0} placeholder="auto" label="Mass override" testId="mass-override" allowInf
            onCommit={(m) => upd('Override mass', { massOverride: Number.isFinite(m) && m > 0 ? { ...part.massOverride, mass: m } : part.massOverride?.inertia ? { inertia: part.massOverride.inertia } : undefined }, false)} />
        </Row>
        <Row label="Inertia override">
          <NumField value={part.massOverride?.inertia ?? null} kind="inertia" min={0} placeholder="auto" label="Inertia override" allowInf
            onCommit={(m) => upd('Override inertia', { massOverride: Number.isFinite(m) && m > 0 ? { ...part.massOverride, inertia: m } : part.massOverride?.mass ? { mass: part.massOverride.mass } : undefined }, false)} />
        </Row>
      </Section>
      <Section title={`Connections (${joints.length})`} defaultOpen={joints.length > 0}>
        {joints.length === 0 && <p className="hint">Not connected. Drag a hole onto another part's hole to make a pivot, or use the joint tools in the Library.</p>}
        {joints.map((j) => (
          <button key={j.id} className="link-row" onClick={() => select({ joints: [j.id] })}>
            <span className="tag">{jointLabel(j)}</span>{j.name}
            <span className="dim"> ↔ {(j.a === part.id ? j.b : j.a) === GROUND ? 'ground' : project.parts.find((p) => p.id === (j.a === part.id ? j.b : j.a))?.name}</span>
          </button>
        ))}
      </Section>
      <Section title={`Anchor features (${g.ports.length})`} defaultOpen={false}>
        {g.ports.map((pt) => <Readout key={pt.id} label={pt.label} value={`${formatQuantity(pt.x, 'length', u)}, ${formatQuantity(pt.y, 'length', u)}${pt.d ? `  ⌀${formatQuantity(pt.d, 'length', u)}` : ''}`} />)}
      </Section>
      <div className="insp-actions">
        <button className="btn" onClick={() => { let ids: string[] = []; commit('Duplicate part', (p) => { const r = ops.duplicateParts(p, [part.id], { dx: 15, dy: -15 }); ids = r.ids; return r.project; }, { solve: false }); if (ids.length) select({ parts: ids }); }}><Copy size={13} /> Duplicate</button>
        <button className="btn" onClick={() => { let id = ''; commit('Add probe', (p) => { const r = ops.addProbe(p, { target: { kind: 'part', part: part.id }, name: part.name }); id = r.id; return { ...r.project, plots: [...r.project.plots, { id: `plot_${id}`, title: `${part.name} angle`, channels: [{ probe: id, quantity: 'angle' }] }] }; }, { solve: false }); setState({ bottomTab: 'plots', bottomOpen: true }); }}><LineChart size={13} /> Probe</button>
        <button className="btn danger" data-testid="delete-part" onClick={() => commit('Delete part', (p) => ops.removeItems(p, { parts: [part.id] }), { selection: { parts: [], joints: [], loads: [], probes: [] } })}><Trash2 size={13} /> Delete</button>
      </div>
    </>
  );
}

function AnchorEditor({ project, partId, anchor, onChange, label }: { project: Project; partId: string; anchor: Anchor; onChange: (a: Anchor) => void; label: string }) {
  if (partId === GROUND) {
    return (
      <Row label={label}>
        <span className="pair">
          <NumField compact value={anchor.x ?? 0} kind="length" label={`${label} X`} onCommit={(x) => onChange({ x, y: anchor.y ?? 0 })} />
          <NumField compact value={anchor.y ?? 0} kind="length" label={`${label} Y`} onCommit={(y) => onChange({ x: anchor.x ?? 0, y })} />
        </span>
      </Row>
    );
  }
  const part = project.parts.find((p) => p.id === partId);
  if (!part) return <Row label={label}><span className="dim">missing part</span></Row>;
  const g = geometryOf(project, part);
  const opts = [...g.ports.map((p) => ({ value: `port:${p.id}`, label: p.label })), { value: 'custom', label: 'Custom point…' }];
  const cur = anchor.port !== undefined ? `port:${anchor.port}` : 'custom';
  if (anchor.port !== undefined && !g.ports.some((p) => p.id === anchor.port)) opts.unshift({ value: cur, label: `⚠ missing: ${anchor.port}` });
  return (
    <>
      <Row label={label}>
        <SelectField value={cur} options={opts} label={label} onChange={(v) => {
          if (v === 'custom') { const w = g.ports.find((p) => p.id === anchor.port); onChange({ x: w?.x ?? 0, y: w?.y ?? 0 }); }
          else onChange({ port: v.slice(5) });
        }} />
      </Row>
      {anchor.port === undefined && (
        <Row label="  local X, Y">
          <span className="pair">
            <NumField compact value={anchor.x ?? 0} kind="length" label={`${label} local X`} onCommit={(x) => onChange({ x, y: anchor.y ?? 0 })} />
            <NumField compact value={anchor.y ?? 0} kind="length" label={`${label} local Y`} onCommit={(y) => onChange({ x: anchor.x ?? 0, y })} />
          </span>
        </Row>
      )}
    </>
  );
}

function JointInspector({ joint, project }: { joint: Joint; project: Project }) {
  const u = project.units;
  const upd = (label: string, patch: Partial<Joint>, solve = true) => commit(label, (p) => ops.updateJoint(p, joint.id, patch), { solve });
  const nameOf = (id: string) => (id === GROUND ? 'Ground' : project.parts.find((p) => p.id === id)?.name ?? '⚠ missing');
  const isRev = joint.type === 'revolute', isPris = joint.type === 'prismatic';
  const A = project.parts.find((p) => p.id === joint.a), B = project.parts.find((p) => p.id === joint.b);
  const info: [string, string][] = [];
  if ((joint.type === 'gear' || joint.type === 'belt') && A && B) {
    const ga = geometryOf(project, A), gb = geometryOf(project, B);
    if (ga.pitchRadius && gb.pitchRadius) {
      const dist = Math.hypot(A.pose.x - B.pose.x, A.pose.y - B.pose.y);
      info.push(['Ratio ω_A : ω_B', `${(gb.pitchRadius / ga.pitchRadius).toFixed(4)} : 1  (${joint.type === 'gear' ? `${B.params.teeth}/${A.params.teeth} teeth, reverses` : joint.crossed ? 'crossed, reverses' : 'same direction'})`]);
      info.push(['Centre distance', formatQuantity(dist, 'length', u, 6)]);
      if (joint.type === 'gear') info.push(['Required (pitch radii)', formatQuantity(ga.pitchRadius + gb.pitchRadius, 'length', u, 6)]);
      else {
        const ra = ga.pitchRadius, rb = gb.pitchRadius;
        const L = joint.crossed
          ? 2 * Math.sqrt(Math.max(dist * dist - (ra + rb) ** 2, 0)) + (ra + rb) * (Math.PI + 2 * Math.asin(Math.min(1, (ra + rb) / dist)))
          : 2 * Math.sqrt(Math.max(dist * dist - (ra - rb) ** 2, 0)) + ra * (Math.PI + 2 * Math.asin((ra - rb) / dist)) + rb * (Math.PI - 2 * Math.asin((ra - rb) / dist));
        info.push(['Belt pitch length', formatQuantity(L, 'length', u, 6)]);
      }
    }
  }
  if (joint.type === 'spring') {
    const wa = anchorWorld(project, joint.a, joint.anchorA), wb = anchorWorld(project, joint.b, joint.anchorB);
    const L = Math.hypot(wa.x - wb.x, wa.y - wb.y);
    const F = (joint.stiffness ?? 0) * (L - (joint.freeLength ?? L));
    info.push(['Length at design pose', formatQuantity(L, 'length', u, 5)]);
    info.push(['Force at design pose', `${formatQuantity(Math.abs(F), 'force', u, 4)} ${F > 0 ? '(stretched, pulls together)' : F < 0 ? '(compressed, pushes apart)' : ''}`]);
  }
  const motor = joint.motor;
  const kindSpeed: QuantityKind = isPris ? 'speed' : 'angularSpeed';
  const kindEffort: QuantityKind = isPris ? 'force' : 'torque';
  return (
    <>
      <div className="insp-head">
        <div className="kind">{jointLabel(joint)} joint</div>
        <TextField value={joint.name} label="Joint name" testId="joint-name" onCommit={(name) => name.trim() && upd('Rename joint', { name: name.trim() }, false)} />
        <p className="desc">{JOINT_DESC[joint.type]}</p>
      </div>
      <Section title="Connects">
        <Readout label="Part A" value={nameOf(joint.a)} />
        {(isRev || isPris || joint.type === 'rigid' || joint.type === 'spring') && <AnchorEditor project={project} partId={joint.a} anchor={joint.anchorA} label="Anchor on A" onChange={(a) => upd('Edit joint anchor', { anchorA: a })} />}
        <Readout label="Part B" value={nameOf(joint.b)} />
        {(isRev || isPris || joint.type === 'rigid' || joint.type === 'spring' || joint.type === 'cam') && <AnchorEditor project={project} partId={joint.b} anchor={joint.anchorB} label="Anchor on B" onChange={(a) => upd('Edit joint anchor', { anchorB: a })} />}
        {isPris && <Row label="Axis (in A's frame)"><NumField value={joint.axisAngle ?? 0} kind="angle" label="Axis angle" onCommit={(axisAngle) => upd('Edit slide axis', { axisAngle })} /></Row>}
        {joint.type === 'rigid' && <Row label="Angle of B rel. A"><NumField value={joint.angle ?? 0} kind="angle" label="Relative angle" onCommit={(angle) => upd('Edit fixed angle', { angle })} /></Row>}
        {isRev && <Row label="Pin diameter" help="Hardware for the BOM and the drawn pin."><NumField value={joint.pinDiameter ?? 3} kind="length" min={0.5} label="Pin diameter" onCommit={(pinDiameter) => upd('Edit pin', { pinDiameter }, false)} /></Row>}
        {joint.type === 'belt' && <Row label="Crossed belt"><Check checked={!!joint.crossed} label="" onChange={(crossed) => upd('Edit belt', { crossed })} /></Row>}
        {info.map(([k, v]) => <Readout key={k} label={k} value={v} />)}
        <div className="row-btns"><Check checked={!!joint.suppressed} label="Suppressed" onChange={(v) => upd(v ? 'Suppress joint' : 'Unsuppress joint', { suppressed: v }, false)} /></div>
      </Section>

      {(isRev || isPris) && (
        <Section title="Motor" right={<Check checked={!!motor?.enabled} label="" testId="motor-enabled" onChange={(v) => upd(v ? 'Add motor' : 'Remove motor', { motor: v ? { ...(motor ?? ops.DEFAULT_MOTOR), enabled: true, ...(isPris && !motor ? { speed: 20 } : {}) } : motor ? { ...motor, enabled: false } : undefined }, false)} />}>
          {!motor?.enabled && <p className="hint">Enable to drive this joint. The first part (A) carries the motor.</p>}
          {motor?.enabled && (
            <>
              <Row label="Type" help="Servo: holds the target speed up to the torque limit. DC: torque falls linearly from stall torque at 0 to zero at the no-load speed.">
                <SelectField value={motor.type} label="Motor type" options={[{ value: 'servo', label: 'Speed-regulated (servo)' }, { value: 'dc', label: 'DC motor curve' }]} onChange={(type) => upd('Edit motor', { motor: { ...motor, type, maxTorque: type === 'dc' && motor.maxTorque === null ? 100000 : motor.maxTorque } }, false)} />
              </Row>
              <Row label={motor.type === 'dc' ? 'No-load speed' : 'Target speed'}><NumField value={motor.speed} kind={kindSpeed} label="Motor speed" testId="motor-speed" onCommit={(speed) => upd('Edit motor speed', { motor: { ...motor, speed } }, false)} /></Row>
              {motor.type === 'dc' ? (
                <Row label={isPris ? 'Stall force' : 'Stall torque'} help="Torque at zero speed. A DC curve needs a finite stall torque; torque falls linearly to zero at the no-load speed and is capped at ± this value when the motor is driven backwards.">
                  <NumField value={motor.maxTorque ?? null} kind={kindEffort} min={1e-6} placeholder="required" label="Motor stall torque" testId="motor-torque" onCommit={(t) => upd('Edit motor stall torque', { motor: { ...motor, maxTorque: t } }, false)} />
                </Row>
              ) : (
                <Row label={isPris ? 'Force limit' : 'Torque limit'} help="Leave empty (∞) for an ideal motor that always reaches the commanded motion.">
                  <NumField value={motor.maxTorque ?? Infinity} kind={kindEffort} min={0} allowInf label="Motor torque limit" testId="motor-torque" onCommit={(t) => upd('Edit motor torque limit', { motor: { ...motor, maxTorque: Number.isFinite(t) ? t : null } }, false)} />
                </Row>
              )}
              <Row label="Ramp-up time"><NumField value={motor.rampTime} kind="time" min={0} label="Ramp time" onCommit={(rampTime) => upd('Edit motor', { motor: { ...motor, rampTime } }, false)} /></Row>
              <Row label="Profile">
                <SelectField value={motor.profile} label="Motor profile" options={[{ value: 'constant', label: 'Constant' }, { value: 'reversing', label: 'Reversing' }]} onChange={(profile) => upd('Edit motor', { motor: { ...motor, profile, period: motor.period ?? 1 } }, false)} />
              </Row>
              {motor.profile === 'reversing' && <Row label="Reverse every"><NumField value={motor.period ?? 1} kind="time" min={0.01} label="Reversal period" onCommit={(period) => upd('Edit motor', { motor: { ...motor, period } }, false)} /></Row>}
              {(motor.maxTorque === null || motor.maxTorque === undefined) && motor.type === 'servo' && <p className="hint">Ideal motor: a kinematic driver (prescribed joint motion). Its torque is the constraint force needed to do so.</p>}
            </>
          )}
        </Section>
      )}
      {(isRev || isPris) && (
        <Section title="Limits, friction, damping" defaultOpen={!!joint.limits?.enabled || !!joint.friction || !!joint.damping}>
          <div className="row-btns"><Check checked={!!joint.limits?.enabled} label="Travel limits (from the design pose)" testId="limits-enabled" onChange={(v) => upd('Edit limits', { limits: { lower: joint.limits?.lower ?? (isPris ? -10 : -30 * DEG), upper: joint.limits?.upper ?? (isPris ? 10 : 30 * DEG), enabled: v } }, false)} /></div>
          {joint.limits?.enabled && (
            <>
              <Row label="Lower"><NumField value={joint.limits.lower} kind={isPris ? 'length' : 'angle'} label="Lower limit" testId="limit-lower" onCommit={(lower) => upd('Edit limits', { limits: { ...joint.limits!, lower } }, false)} /></Row>
              <Row label="Upper"><NumField value={joint.limits.upper} kind={isPris ? 'length' : 'angle'} label="Upper limit" testId="limit-upper" onCommit={(upper) => upd('Edit limits', { limits: { ...joint.limits!, upper } }, false)} /></Row>
            </>
          )}
          <Row label={isPris ? 'Friction force' : 'Friction torque'} help="Coulomb (dry) friction magnitude."><NumField value={joint.friction ?? 0} kind={kindEffort} min={0} label="Joint friction" onCommit={(friction) => upd('Edit joint friction', { friction }, false)} /></Row>
          <Row label="Viscous damping"><NumField value={joint.damping ?? 0} kind={isPris ? 'damping' : 'rotDamping'} min={0} label="Joint damping" onCommit={(damping) => upd('Edit joint damping', { damping }, false)} /></Row>
        </Section>
      )}
      {joint.type === 'spring' && (
        <Section title="Spring">
          <Row label="Stiffness"><NumField value={joint.stiffness ?? 0} kind="stiffness" min={0} label="Spring stiffness" testId="spring-k" onCommit={(stiffness) => upd('Edit spring stiffness', { stiffness }, false)} /></Row>
          <Row label="Free length"><NumField value={joint.freeLength ?? 0} kind="length" min={0} label="Spring free length" testId="spring-l0" onCommit={(freeLength) => upd('Edit spring free length', { freeLength }, false)} /></Row>
          <Row label="Preload (compression +)" help="Force at the design pose. Editing it changes the free length: L₀ = L + F/k.">
            <NumField value={(() => { const wa = anchorWorld(project, joint.a, joint.anchorA), wb = anchorWorld(project, joint.b, joint.anchorB); return (joint.stiffness ?? 0) * ((joint.freeLength ?? 0) - Math.hypot(wa.x - wb.x, wa.y - wb.y)); })()} kind="force" label="Spring preload"
              onCommit={(F) => { const wa = anchorWorld(project, joint.a, joint.anchorA), wb = anchorWorld(project, joint.b, joint.anchorB); const L = Math.hypot(wa.x - wb.x, wa.y - wb.y); if (!joint.stiffness) { toast('Set a stiffness first.', 'error'); return; } upd('Edit spring preload', { freeLength: Math.max(0, L + F / joint.stiffness) }, false); }} />
          </Row>
          <Row label="Damping"><NumField value={joint.springDamping ?? 0} kind="damping" min={0} label="Spring damping" onCommit={(springDamping) => upd('Edit spring damping', { springDamping }, false)} /></Row>
          <Row label="Coil diameter"><NumField value={joint.coilDiameter ?? 8} kind="length" min={1} label="Coil diameter" onCommit={(coilDiameter) => upd('Edit spring', { coilDiameter }, false)} /></Row>
        </Section>
      )}
      <ProbeChannels project={project} probeTarget={{ kind: 'joint', joint: joint.id }} name={joint.name} />
      <div className="insp-actions">
        <button className="btn danger" data-testid="delete-joint" onClick={() => commit('Delete joint', (p) => ops.removeItems(p, { joints: [joint.id] }), { selection: { parts: [], joints: [], loads: [], probes: [] } })}><Trash2 size={13} /> Delete</button>
      </div>
    </>
  );
}

const JOINT_DESC: Record<string, string> = {
  revolute: 'Pin joint: the two anchors stay coincident; the parts rotate freely about the Z axis through them (1 rotational freedom).',
  prismatic: 'Sliding joint: part B translates along the axis fixed in part A and cannot rotate relative to it (1 translational freedom).',
  rigid: 'Rigid attachment: no relative motion. Rigidly attached parts are simulated as one body.',
  gear: 'Ideal gear mesh: pure rolling of the two pitch circles (kinematic coupling, ratio = tooth counts). Not tooth-by-tooth contact.',
  rackPinion: 'Ideal rack & pinion: the pinion pitch circle rolls on the rack pitch line (kinematic coupling).',
  belt: 'Ideal belt: inextensible and non-slipping on both pitch circles (kinematic coupling, ratio = pitch diameters).',
  cam: 'Cam contact: the follower roller is kept outside the cam profile by a one-sided contact force. It can lift off.',
  spring: 'Linear spring-damper between two anchor points: F = k·(L − L₀) + c·dL/dt.',
};

/** quick add/remove of plotted quantities for a probe target */
function ProbeChannels({ project, probeTarget, name }: { project: Project; probeTarget: Probe['target']; name: string }) {
  useApp((s) => s.simTick);
  const probe = project.probes.find((p) => JSON.stringify(p.target) === JSON.stringify(probeTarget));
  const fake: Probe = probe ?? { id: '', name, target: probeTarget, trace: false, color: '#fff' };
  const model = simCtl.runner?.project === project ? simCtl.runner.model : undefined;
  const qs = quantitiesFor(project, fake, model);
  if (!qs.length) return null;
  const plotted = (q: string) => !!probe && project.plots.some((pl) => pl.channels.some((c) => c.probe === probe.id && c.quantity === q));
  const toggle = (q: string, label: string) => {
    commit(plotted(q) ? 'Remove plot' : 'Add plot', (p) => {
      let pr = p.probes.find((x) => JSON.stringify(x.target) === JSON.stringify(probeTarget));
      let proj = p;
      if (!pr) { const r = ops.addProbe(p, { target: probeTarget, name }); proj = r.project; pr = proj.probes[proj.probes.length - 1]; }
      const id = pr.id;
      if (proj.plots.some((pl) => pl.channels.some((c) => c.probe === id && c.quantity === q))) {
        return { ...proj, plots: proj.plots.map((pl) => ({ ...pl, channels: pl.channels.filter((c) => !(c.probe === id && c.quantity === q)) })).filter((pl) => pl.channels.length > 0) };
      }
      return { ...proj, plots: [...proj.plots, { id: `plot_${Date.now().toString(36)}`, title: `${name} · ${label}`, channels: [{ probe: id, quantity: q }] }] };
    }, { solve: false });
    setState({ bottomTab: 'plots', bottomOpen: true });
  };
  return (
    <Section title="Measurements" defaultOpen={false}>
      <p className="hint">Tick a quantity to plot it over simulation time.</p>
      {qs.map((q) => (
        <label key={q.id} className={`measure-row ${q.available ? '' : 'na'}`} title={q.available ? q.note : q.reason}>
          <input type="checkbox" checked={plotted(q.id)} onChange={() => toggle(q.id, q.label)} />
          <span>{q.label}</span>
          <span className={`prov ${q.available ? q.provenance : 'na'}`}>{q.available ? PROVENANCE_LABEL[q.provenance] : 'unavailable'}</span>
        </label>
      ))}
    </Section>
  );
}

function LoadInspector({ load, project }: { load: Load; project: Project }) {
  const upd = (label: string, patch: Partial<Load>) => commit(label, (p) => ({ ...p, loads: p.loads.map((l) => (l.id === load.id ? { ...l, ...patch } : l)) }), { solve: false });
  return (
    <>
      <div className="insp-head">
        <div className="kind">External load</div>
        <TextField value={load.name} label="Load name" onCommit={(name) => name.trim() && upd('Rename load', { name: name.trim() })} />
        <p className="desc">A force at a point of a part, or a pure torque on a part. Active in dynamic mode.</p>
      </div>
      <Section title="Load">
        <Row label="Type"><SelectField value={load.type} label="Load type" options={[{ value: 'force', label: 'Force' }, { value: 'torque', label: 'Torque' }]} onChange={(type) => upd('Edit load', { type })} /></Row>
        <Readout label="Acts on" value={project.parts.find((p) => p.id === load.part)?.name ?? '⚠ missing'} />
        {load.type === 'force' && (
          <>
            <AnchorEditor project={project} partId={load.part} anchor={load.anchor} label="Point" onChange={(anchor) => upd('Edit load point', { anchor })} />
            <Row label="Force X"><NumField value={load.fx} kind="force" label="Force X" testId="load-fx" onCommit={(fx) => upd('Edit load', { fx })} /></Row>
            <Row label="Force Y"><NumField value={load.fy} kind="force" label="Force Y" testId="load-fy" onCommit={(fy) => upd('Edit load', { fy })} /></Row>
            <Row label="Direction"><SelectField value={load.frame} label="Load frame" options={[{ value: 'world', label: 'Fixed in the world' }, { value: 'part', label: 'Rotates with the part' }]} onChange={(frame) => upd('Edit load', { frame })} /></Row>
          </>
        )}
        {load.type === 'torque' && <Row label="Torque (+ = CCW)"><NumField value={load.torque} kind="torque" label="Load torque" testId="load-torque" onCommit={(torque) => upd('Edit load', { torque })} /></Row>}
        <Row label="Starts at" help="Leave empty for 'from the start'."><NumField value={load.tStart ?? null} kind="time" min={0} placeholder="0" allowInf label="Load start time" onCommit={(t) => upd('Edit load', { tStart: Number.isFinite(t) ? t : undefined })} /></Row>
        <Row label="Ends at" help="Leave empty for 'never'."><NumField value={load.tEnd ?? null} kind="time" min={0} placeholder="never" allowInf label="Load end time" onCommit={(t) => upd('Edit load', { tEnd: Number.isFinite(t) ? t : undefined })} /></Row>
        <div className="row-btns"><Check checked={load.enabled} label="Enabled" onChange={(enabled) => upd('Toggle load', { enabled })} /></div>
      </Section>
      <div className="insp-actions"><button className="btn danger" onClick={() => commit('Delete load', (p) => ops.removeItems(p, { loads: [load.id] }), { solve: false, selection: { parts: [], joints: [], loads: [], probes: [] } })}><Trash2 size={13} /> Delete</button></div>
    </>
  );
}

function ProbeInspector({ probe, project }: { probe: Probe; project: Project }) {
  const upd = (label: string, patch: Partial<Probe>) => commit(label, (p) => ({ ...p, probes: p.probes.map((x) => (x.id === probe.id ? { ...x, ...patch } : x)) }), { solve: false });
  const tg = probe.target;
  return (
    <>
      <div className="insp-head">
        <div className="kind">Probe</div>
        <TextField value={probe.name} label="Probe name" onCommit={(name) => name.trim() && upd('Rename probe', { name: name.trim() })} />
        <p className="desc">{tg.kind === 'point' ? 'Follows a point fixed to a part. Drag the marker in the viewport to move it; the trace is re-evaluated from the recorded motion.' : tg.kind === 'joint' ? 'Measures a joint.' : tg.kind === 'part' ? 'Measures the rotation and position of a part.' : 'Solver quantities for the whole model.'}</p>
      </div>
      <Section title="Target">
        {tg.kind === 'point' && (
          <>
            <Readout label="Part" value={project.parts.find((p) => p.id === tg.part)?.name ?? '⚠ missing'} />
            <AnchorEditor project={project} partId={tg.part} anchor={tg.anchor} label="Point" onChange={(anchor) => upd('Move probe', { target: { ...tg, anchor } })} />
            <div className="row-btns"><Check checked={probe.trace} label="Draw motion trace" onChange={(trace) => upd('Toggle trace', { trace })} /></div>
            <Row label="Colour"><input type="color" aria-label="Trace colour" value={probe.color} onChange={(e) => upd('Change trace colour', { color: e.target.value })} /></Row>
          </>
        )}
        {tg.kind === 'joint' && <Readout label="Joint" value={project.joints.find((j) => j.id === tg.joint)?.name ?? '⚠ missing'} />}
        {tg.kind === 'part' && <Readout label="Part" value={project.parts.find((p) => p.id === tg.part)?.name ?? '⚠ missing'} />}
      </Section>
      <ProbeChannels project={project} probeTarget={probe.target} name={probe.name} />
      <div className="insp-actions"><button className="btn danger" onClick={() => commit('Delete probe', (p) => ops.removeItems(p, { probes: [probe.id] }), { solve: false, selection: { parts: [], joints: [], loads: [], probes: [] } })}><Trash2 size={13} /> Delete</button></div>
    </>
  );
}

function MultiInspector({ ids, project }: { ids: string[]; project: Project }) {
  const parts = project.parts.filter((p) => ids.includes(p.id));
  return (
    <>
      <div className="insp-head"><div className="kind">{parts.length} parts selected</div><p className="desc">{parts.map((p) => p.name).join(', ')}</p></div>
      <Section title="Arrange">
        <div className="insp-actions wrap">
          <button className="btn" data-testid="group-parts" onClick={() => commit('Group parts', (p) => ops.groupParts(p, ids, 'Group').project, { solve: false })}><Copy size={13} /> Group</button>
          <button className="btn" onClick={() => { let n: string[] = []; commit('Duplicate parts', (p) => { const r = ops.duplicateParts(p, ids, { dx: 20, dy: -20 }); n = r.ids; return r.project; }, { solve: false }); if (n.length) select({ parts: n }); }}><Copy size={13} /> Duplicate</button>
          <button className="btn" onClick={() => setState({ dialog: 'pattern' })}><Copy size={13} /> Pattern…</button>
          <button className="btn" onClick={() => commit('Ground parts', (p) => ({ ...p, parts: p.parts.map((x) => (ids.includes(x.id) ? { ...x, grounded: true } : x)) }))}><AnchorIcon size={13} /> Ground</button>
          <button className="btn" onClick={() => commit('Suppress parts', (p) => ({ ...p, parts: p.parts.map((x) => (ids.includes(x.id) ? { ...x, suppressed: !x.suppressed } : x)) }), { solve: false })}><EyeOff size={13} /> Suppress</button>
          {parts.length === 2 && <button className="btn" onClick={() => commit('Fix parts together', (p) => { const [a, b] = parts; const pa = p.parts.find((x) => x.id === a.id)!, pb = p.parts.find((x) => x.id === b.id)!; const c = Math.cos(pa.pose.angle), s = Math.sin(pa.pose.angle); const dx = pb.pose.x - pa.pose.x, dy = pb.pose.y - pa.pose.y; return ops.mateRigid(p, a.id, { x: c * dx + s * dy, y: -s * dx + c * dy }, b.id, { x: 0, y: 0 }, { move: false }).project; })}><Lock size={13} /> Fix together</button>}
          <button className="btn danger" onClick={() => commit('Delete parts', (p) => ops.removeItems(p, { parts: ids }), { selection: { parts: [], joints: [], loads: [], probes: [] } })}><Trash2 size={13} /> Delete</button>
        </div>
      </Section>
    </>
  );
}

export function Inspector() {
  const project = useApp((s) => s.project);
  const sel = useApp((s) => s.selection);
  let body;
  if (sel.parts.length > 1) body = <MultiInspector ids={sel.parts} project={project} />;
  else if (sel.parts.length === 1) { const p = project.parts.find((x) => x.id === sel.parts[0]); body = p ? <PartInspector key={p.id} part={p} project={project} /> : null; }
  else if (sel.joints.length >= 1) { const j = project.joints.find((x) => x.id === sel.joints[0]); body = j ? <JointInspector key={j.id} joint={j} project={project} /> : null; }
  else if (sel.loads.length >= 1) { const l = project.loads.find((x) => x.id === sel.loads[0]); body = l ? <LoadInspector key={l.id} load={l} project={project} /> : null; }
  else if (sel.probes.length >= 1) { const pr = project.probes.find((x) => x.id === sel.probes[0]); body = pr ? <ProbeInspector key={pr.id} probe={pr} project={project} /> : null; }
  return <div className="inspector" data-testid="inspector">{body ?? <ProjectSettings />}</div>;
}
