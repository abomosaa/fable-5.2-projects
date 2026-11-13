import { Check as CheckIcon, Plus, Trash2 } from 'lucide-react';
import * as ops from '../../core/model/ops';
import { UNIT_PRESETS, UNIT_TABLE, type QuantityKind } from '../../core/units';
import { commit, renameProject, useApp } from '../store';
import { Check, NumField, Row, Section, SelectField, Seg, TextField } from '../widgets';

export function ProjectSettings() {
  const project = useApp((s) => s.project);
  const sim = project.sim;
  const setSim = (label: string, patch: Partial<typeof sim>) => commit(label, (p) => ({ ...p, sim: { ...p.sim, ...patch } }), { solve: false });
  const setCl = (key: keyof typeof project.clearances, v: number) => commit('Edit clearance', (p) => ({ ...p, clearances: { ...p.clearances, [key]: v } }));
  const presetId = Object.entries(UNIT_PRESETS).find(([, v]) => Object.entries(v.prefs).every(([k, u]) => project.units[k as QuantityKind] === u))?.[0] ?? 'custom';
  const unitRow = (kind: QuantityKind, label: string) => (
    <Row label={label}>
      <SelectField value={project.units[kind] ?? ''} label={`${label} unit`} options={Object.keys(UNIT_TABLE[kind]).map((u) => ({ value: u, label: u }))} onChange={(u) => commit('Change units', (p) => ({ ...p, units: { ...p.units, [kind]: u } }), { solve: false })} />
    </Row>
  );
  return (
    <>
      <div className="insp-head">
        <div className="kind">Project</div>
        <TextField value={project.name} label="Project name" testId="project-name-field" onCommit={renameProject} />
        <p className="desc">Nothing selected. Click a part or joint to edit it; these are the project-wide settings.</p>
      </div>
      <Section title="Simulation">
        <Row label="Mode" help="Kinematic: motors prescribe motion and geometry is solved, no forces. Dynamic: masses, gravity, springs, friction, contact and motor limits decide the motion.">
          <Seg value={sim.mode} testId="sim-mode" onChange={(mode) => setSim('Change simulation mode', { mode })} options={[{ value: 'kinematic', label: 'Kinematic' }, { value: 'dynamic', label: 'Dynamic' }]} />
        </Row>
        <Row label="Timestep" help="Fixed physical timestep of the solver. Rendering is independent of it."><NumField value={sim.dt} kind="time" min={1e-5} max={0.02} label="Timestep" testId="sim-dt" onCommit={(dt) => setSim('Edit timestep', { dt })} /></Row>
        <Row label="Sample rate" help="Recording rate of probes and plots."><NumField value={sim.sampleRate} kind="frequency" min={10} max={5000} label="Sample rate" onCommit={(sampleRate) => setSim('Edit sample rate', { sampleRate })} /></Row>
        <div className="row-btns"><Check checked={sim.gravityEnabled} label="Gravity" testId="gravity-enabled" onChange={(gravityEnabled) => setSim('Toggle gravity', { gravityEnabled })} /></div>
        {sim.gravityEnabled && (
          <Row label="Gravity X, Y">
            <span className="pair">
              <NumField compact value={sim.gravity.x} kind="acceleration" label="Gravity X" onCommit={(x) => setSim('Edit gravity', { gravity: { ...sim.gravity, x } })} />
              <NumField compact value={sim.gravity.y} kind="acceleration" label="Gravity Y" onCommit={(y) => setSim('Edit gravity', { gravity: { ...sim.gravity, y } })} />
            </span>
          </Row>
        )}
        <div className="row-btns"><Check checked={sim.floor.enabled} label="Floor (free-body contact)" testId="floor-enabled" onChange={(enabled) => setSim('Toggle floor', { floor: { ...sim.floor, enabled } })} /></div>
        {sim.floor.enabled && (
          <>
            <Row label="Floor height (Y)"><NumField value={sim.floor.y} kind="length" label="Floor height" testId="floor-y" onCommit={(y) => setSim('Edit floor height', { floor: { ...sim.floor, y } })} /></Row>
            <Row label="Friction μ" help="Coulomb friction coefficient between parts and the floor (static = kinetic)."><NumField value={sim.floor.friction} kind="ratio" min={0} max={3} label="Floor friction" testId="floor-friction" onCommit={(friction) => setSim('Edit floor friction', { floor: { ...sim.floor, friction } })} /></Row>
          </>
        )}
        <div className="row-btns"><Check checked={sim.stopOnInterference} label="Pause when parts interfere" onChange={(stopOnInterference) => setSim('Toggle stop on interference', { stopOnInterference })} /></div>
      </Section>

      <Section title={`Variants (${project.variants.length})`}>
        <p className="hint">Named parameter sets. Applying one edits the design (undoable) and re-solves the assembly.</p>
        {project.variants.map((v) => (
          <div key={v.id} className={`variant ${project.activeVariant === v.id ? 'on' : ''}`}>
            <button className="variant-main" data-testid={`variant-${v.id}`} title={v.note} onClick={() => commit(`Apply variant "${v.name}"`, (p) => ops.applyVariant(p, v.id))}>
              <span className="v-name">{project.activeVariant === v.id && <CheckIcon size={12} />} {v.name}</span>
              {v.note && <span className="v-note">{v.note}</span>}
            </button>
            <button className="icon-btn" title="Delete variant" aria-label="Delete variant" onClick={() => commit('Delete variant', (p) => ({ ...p, variants: p.variants.filter((x) => x.id !== v.id), activeVariant: p.activeVariant === v.id ? undefined : p.activeVariant }), { solve: false })}><Trash2 size={12} /></button>
          </div>
        ))}
        <button className="btn small" data-testid="capture-variant" onClick={() => commit('Save variant', (p) => ops.captureVariant(p, `Variant ${p.variants.length + 1}`, p.variants.length ? undefined : ops.allParameterKeys(p), undefined, 'Captured from the current parameters.').project, { solve: false })}><Plus size={12} /> Save current parameters as variant</button>
      </Section>

      <Section title="Manufacturing clearances">
        <p className="hint">These are built into the generated geometry (and therefore into exports), not just noted.</p>
        <Row label="Hole clearance" help="Added to the diameter of every pin hole and bore."><NumField value={project.clearances.hole} kind="length" min={0} max={2} label="Hole clearance" testId="cl-hole" onCommit={(v) => setCl('hole', v)} /></Row>
        <Row label="Slide clearance" help="Gap per side between sliders/stems and their guides."><NumField value={project.clearances.slide} kind="length" min={0} max={2} label="Slide clearance" onCommit={(v) => setCl('slide', v)} /></Row>
        <Row label="Gear backlash" help="Circular backlash per mesh: each tooth is thinned by half of this at the pitch circle."><NumField value={project.clearances.backlash} kind="length" min={0} max={1} label="Gear backlash" testId="cl-backlash" onCommit={(v) => setCl('backlash', v)} /></Row>
        <Row label="Min. feature" help="Smallest wall/feature your process can make; used by the export checker and geometry warnings."><NumField value={project.clearances.minFeature} kind="length" min={0.05} max={5} label="Minimum feature size" onCommit={(v) => setCl('minFeature', v)} /></Row>
      </Section>

      <Section title="Units" defaultOpen={false}>
        <Row label="Preset">
          <SelectField value={presetId} label="Unit preset" testId="unit-preset" options={[...Object.entries(UNIT_PRESETS).map(([id, v]) => ({ value: id, label: v.label })), ...(presetId === 'custom' ? [{ value: 'custom', label: 'Custom' }] : [])]}
            onChange={(id) => id !== 'custom' && commit('Change units', (p) => ({ ...p, units: { ...UNIT_PRESETS[id].prefs } }), { solve: false })} />
        </Row>
        {unitRow('length', 'Length')}{unitRow('angle', 'Angle')}{unitRow('mass', 'Mass')}{unitRow('force', 'Force')}{unitRow('torque', 'Torque')}
        {unitRow('angularSpeed', 'Angular speed')}{unitRow('speed', 'Speed')}{unitRow('acceleration', 'Acceleration')}{unitRow('stiffness', 'Stiffness')}{unitRow('power', 'Power')}
        <p className="hint">Display only. Files and the solver always use mm · kg · s · rad (forces in mN).</p>
      </Section>
    </>
  );
}
