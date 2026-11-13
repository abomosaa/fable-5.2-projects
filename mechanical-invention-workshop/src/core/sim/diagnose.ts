/**
 * Turning solver states into explanations a designer can act on.
 */
import type { Diagnostic, MechModel } from '../assembly/compile';
import type { Project } from '../model/types';
import { GROUND } from '../model/types';
import type { Simulation } from './solver';

export interface FourBarInfo {
  crankJoint: string;
  /** joint ids: ground–crank, crank–coupler, coupler–rocker, rocker–ground */
  joints: [string, string, string, string];
  /** part ids of crank, coupler, rocker (first part of each body) */
  parts: [string, string, string];
  ground: number; crank: number; coupler: number; rocker: number;
  grashof: boolean;
  /** s + l and p + q */
  sl: number; pq: number;
  type: 'crank-rocker' | 'double-crank' | 'double-rocker (Grashof)' | 'triple-rocker (non-Grashof)' | 'change-point';
  crankCanRotate: boolean;
}

/**
 * Find four-bar loops ground → crank → coupler → rocker → ground made of
 * revolute joints, where `crank` is the body turned by a joint to ground
 * (preferably the motorised one), and classify them with the Grashof condition.
 */
export function findFourBars(model: MechModel): FourBarInfo[] {
  const revs = model.cons.filter((c) => c.kind === 'rev');
  const out: FourBarInfo[] = [];
  const motorJoints = new Set(model.motors.map((m) => m.jointId));
  const wpt = (b: number, r: [number, number]): [number, number] => (b < 0 ? [r[0], r[1]] : [model.bodies[b].x0 + r[0], model.bodies[b].y0 + r[1]]);
  type End = { other: number; here: [number, number]; id: string };
  const ends = (b: number): End[] => {
    const l: End[] = [];
    for (const c of revs) {
      if (c.bi === b) l.push({ other: c.bj, here: wpt(c.bi, c.ri), id: c.jointId });
      else if (c.bj === b) l.push({ other: c.bi, here: wpt(c.bj, c.rj), id: c.jointId });
    }
    return l;
  };
  const dist = (a: [number, number], b: [number, number]) => Math.hypot(a[0] - b[0], a[1] - b[1]);
  const seen = new Set<string>();
  for (let crank = 0; crank < model.bodies.length; crank++) {
    const ce = ends(crank);
    for (const g1 of ce) {
      if (g1.other !== -1) continue;
      for (const c1 of ce) {
        if (c1.other < 0 || c1.other === crank) continue;
        const coupler = c1.other;
        const coe = ends(coupler);
        const cHere = coe.find((e) => e.id === c1.id)!;
        for (const c2 of coe) {
          if (c2.other < 0 || c2.other === crank || c2.id === c1.id) continue;
          const rocker = c2.other;
          const re = ends(rocker);
          const rHere = re.find((e) => e.id === c2.id)!;
          for (const g2 of re) {
            if (g2.other !== -1) continue;
            const key = [g1.id, c1.id, c2.id, g2.id].join('|');
            const keyRev = [g2.id, c2.id, c1.id, g1.id].join('|');
            const driven = motorJoints.has(g1.id);
            if (seen.has(key) || (seen.has(keyRev) && !driven)) continue;
            if (motorJoints.has(g2.id) && !driven) continue; // will be found from the other side
            seen.add(key);
            const Lg = dist(g1.here, g2.here), Lc = dist(g1.here, c1.here), Lk = dist(cHere.here, c2.here), Lr = dist(rHere.here, g2.here);
            const L = [Lg, Lc, Lk, Lr].slice().sort((a, b) => a - b);
            const sl = L[0] + L[3], pq = L[1] + L[2];
            const grashof = sl < pq - 1e-9;
            const change = Math.abs(sl - pq) <= 1e-9;
            const s = L[0];
            let type: FourBarInfo['type'];
            if (change) type = 'change-point';
            else if (!grashof) type = 'triple-rocker (non-Grashof)';
            else if (Math.abs(Lg - s) < 1e-9) type = 'double-crank';
            else if (Math.abs(Lc - s) < 1e-9 || Math.abs(Lr - s) < 1e-9) type = 'crank-rocker';
            else type = 'double-rocker (Grashof)';
            const crankCanRotate = (grashof || change) && (Math.abs(Lc - s) < 1e-9 || Math.abs(Lg - s) < 1e-9);
            out.push({
              crankJoint: g1.id, joints: [g1.id, c1.id, c2.id, g2.id],
              parts: [model.bodies[crank].partIds[0], model.bodies[coupler].partIds[0], model.bodies[rocker].partIds[0]],
              ground: Lg, crank: Lc, coupler: Lk, rocker: Lr, grashof, sl, pq, type, crankCanRotate,
            });
          }
        }
      }
    }
  }
  // prefer loops whose crank joint is motorised
  out.sort((a, b) => Number(motorJoints.has(b.crankJoint)) - Number(motorJoints.has(a.crankJoint)));
  return out;
}

const f1 = (x: number) => (Math.round(x * 100) / 100).toString();

export function jointName(project: Project, id: string): string {
  return project.joints.find((j) => j.id === id)?.name ?? id;
}
export function partName(project: Project, id: string): string {
  return id === GROUND ? 'ground' : project.parts.find((p) => p.id === id)?.name ?? id;
}

function partsOfJoints(project: Project, jointIds: string[]): string[] {
  const s = new Set<string>();
  for (const id of jointIds) {
    const j = project.joints.find((x) => x.id === id);
    if (!j) continue;
    if (j.a !== GROUND) s.add(j.a);
    if (j.b !== GROUND) s.add(j.b);
  }
  return [...s];
}

/** Explain a failed step (status 'locked' or 'diverged'). */
export function explainFailure(sim: Simulation): Diagnostic {
  const { model } = sim;
  const project = model.project;
  const f = sim.failure!;
  const joints = f.worst.map((w) => w.jointId);
  const t = f.time;
  if (f.status === 'diverged') {
    return {
      severity: 'error', code: 'sim.diverged', time: t,
      title: 'Simulation diverged',
      detail: `${f.reason} The run was stopped at t = ${t.toFixed(3)} s and the last valid state is shown. Typical causes: timestep too large for a stiff spring or light part, or an ideal (unlimited-torque) motor forcing parts through a contact. Reduce the timestep or give the motor a torque limit.`,
      parts: partsOfJoints(project, joints), joints,
    };
  }
  const motorTxt = model.motors.map((m) => {
    const j = project.joints.find((x) => x.id === m.jointId);
    const v = sim.coordValue(m.coord, sim.q);
    return `${j?.name ?? m.jointId} at ${m.coord.kind === 'rev' ? `${f1((v * 180) / Math.PI)}°` : `${f1(v)} mm`} from its design position`;
  }).join('; ');
  let detail = `${f.reason} Stopped at t = ${t.toFixed(3)} s${motorTxt ? ` with ${motorTxt}` : ''}. `;
  detail += `The joints that could not be closed: ${f.worst.map((w) => `${jointName(project, w.jointId)} (${Math.abs(w.value).toExponential(1)} ${w.unit})`).join(', ')}. `;
  const fbs = findFourBars(model);
  const fb = fbs.find((x) => x.joints.some((id) => joints.includes(id))) ?? fbs[0];
  const L4 = fb ? [fb.ground, fb.crank, fb.coupler, fb.rocker].sort((a, b) => a - b) : [];
  if (fb && L4[3] > L4[0] + L4[1] + L4[2] + 1e-9) {
    detail += `This is a four-bar loop with ground ${f1(fb.ground)}, crank ${f1(fb.crank)}, coupler ${f1(fb.coupler)}, rocker ${f1(fb.rocker)} mm: the longest link (${f1(L4[3])} mm) is longer than the other three together (${f1(L4[0] + L4[1] + L4[2])} mm), so the loop cannot be assembled in any position. Lengthen the short links or shorten the long one.`;
  } else if (fb && !fb.crankCanRotate) {
    detail += `This is a four-bar loop with ground ${f1(fb.ground)}, crank ${f1(fb.crank)}, coupler ${f1(fb.coupler)}, rocker ${f1(fb.rocker)} mm: `;
    if (!fb.grashof) detail += `shortest + longest = ${f1(fb.sl)} mm exceeds the sum of the other two = ${f1(fb.pq)} mm (Grashof condition violated), so no link can rotate fully. The crank reached a dead-centre where coupler and rocker are stretched in line. Shorten the crank or ground link, or lengthen the coupler/rocker.`;
    else detail += `the loop is Grashof (${fb.type}) but the driven link is not the shortest link, so it can only rock between two dead-centre positions. Drive the shortest link, or use a reversing motor.`;
  } else {
    detail += 'The mechanism reached a position beyond which the loop cannot stay closed (a dead-centre / limit position), or two constraints contradict each other. The motor demands motion that the geometry does not allow. Check link lengths around the highlighted joints, or use a torque-limited or reversing motor.';
  }
  return { severity: 'error', code: 'sim.locked', time: t, title: 'Mechanism locked: constraints cannot be satisfied', detail, parts: partsOfJoints(project, joints), joints };
}

/** Static mobility report (degrees of freedom, redundancy) for the diagnostics panel. */
export function mobilityDiagnostics(sim: Simulation): { dof: number; dofDriven: number; redundantJoints: string[]; diagnostics: Diagnostic[] } {
  const { model } = sim;
  const project = model.project;
  const out: Diagnostic[] = [];
  if (sim.nb === 0) return { dof: 0, dofDriven: 0, redundantJoints: [], diagnostics: out };
  const mob = sim.mobility();
  const redundantJoints = [...new Set(mob.redundantRows.map((r) => sim.rowJoint(r).jointId))];
  if (mob.redundantRows.length) {
    out.push({
      severity: 'warning', code: 'model.redundant',
      title: `${mob.redundantRows.length} redundant constraint${mob.redundantRows.length > 1 ? 's' : ''}`,
      detail: `The joints ${redundantJoints.map((id) => `"${jointName(project, id)}"`).join(', ')} repeat restrictions that other joints already impose (over-constrained). The assembly can still move if the duplicated constraints agree exactly, but the reaction forces shared between them are not unique, and any dimension change may make it impossible to assemble.`,
      parts: partsOfJoints(project, redundantJoints), joints: redundantJoints,
    });
  }
  if (model.mode === 'kinematic' && mob.dofDriven > 0) {
    out.push({
      severity: 'warning', code: 'model.underdriven',
      title: `${mob.dofDriven} degree${mob.dofDriven > 1 ? 's' : ''} of freedom not driven`,
      detail: 'Kinematic mode moves only what the motors prescribe. Parts that are still free keep the smallest possible motion, which is not a physical prediction. Add motors/joints, or switch to dynamic mode to let gravity, springs and contact decide.',
      parts: [], joints: [],
    });
  }
  if (model.mode === 'kinematic' && mob.dofDriven === 0 && mob.dof === 0 && model.motors.length > 0 && mob.redundantRows.length === 0) {
    out.push({
      severity: 'error', code: 'model.locked-structure',
      title: 'Mechanism has no freedom to move',
      detail: 'With the motors released the assembly has zero degrees of freedom: it is a structure, and a motor cannot move it. Remove or change a joint (for example a rigid joint that should be a pivot).',
      parts: [], joints: model.motors.map((m) => m.jointId),
    });
  }
  return { dof: mob.dof, dofDriven: mob.dofDriven, redundantJoints, diagnostics: out };
}
