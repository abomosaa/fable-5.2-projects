/**
 * "Auto-stack layers": resolve part–part interference by raising parts along
 * Z. Parts keep their layer whenever that is collision-free over the motion;
 * otherwise they move up by the smallest amount that clears every part they
 * overlap in XY at any sampled pose of a kinematic sweep.
 */
import type { Project } from '../model/types';
import { geometryOf } from '../model/project';
import { contoursOverlap, transformPoly, type Poly } from '../math/poly';
import { SimRunner } from '../sim/runner';

export interface AutoLayerResult { project: Project; moved: { id: string; from: number; to: number }[]; samples: number }

export function autoLayer(project: Project, gap = 0.5): AutoLayerResult {
  const parts = project.parts.filter((p) => !p.suppressed);
  const geo = parts.map((p) => geometryOf(project, p));
  // --- sample poses over the motion (kinematic sweep of the motors; design pose if nothing is driven)
  const poseSets: ({ x: number; y: number; angle: number } | null)[][] = [parts.map((p) => p.pose)];
  const speeds = project.joints.filter((j) => !j.suppressed && j.motor?.enabled).map((j) => Math.abs(j.motor!.speed)).filter((s) => s > 1e-9);
  if (speeds.length) {
    try {
      const period = Math.min(6, (2 * Math.PI) / Math.min(...speeds) + 0.5);
      const dt = 0.002;
      const run = new SimRunner({ ...project, sim: { ...project.sim, mode: 'kinematic', dt, floor: { ...project.sim.floor, enabled: false } } }, { interference: false });
      const every = Math.max(1, Math.round(period / dt / 120));
      for (let i = 0; i < 120 && !run.finished; i++) {
        if (run.advance(every) === 0) break;
        poseSets.push(parts.map((p) => run.poseOf(p.id)));
      }
    } catch { /* fall back to the design pose */ }
  }
  // --- which layer pairs ever overlap in XY
  const conflicts = new Map<string, [number, number][]>();   // "i|j" → list of [layer of i, layer of j]
  const world = (pi: number, li: number, pose: { x: number; y: number; angle: number }): Poly[] => geo[pi].layers[li].contours.map((c) => transformPoly(c, pose.x, pose.y, pose.angle));
  for (const poses of poseSets) {
    const cache = new Map<string, Poly[]>();
    const get = (pi: number, li: number) => { const k = `${pi}:${li}`; let w = cache.get(k); if (!w) { w = world(pi, li, poses[pi]!); cache.set(k, w); } return w; };
    for (let i = 0; i < parts.length; i++) {
      for (let j = i + 1; j < parts.length; j++) {
        const a = poses[i], b = poses[j];
        if (!a || !b || Math.hypot(a.x - b.x, a.y - b.y) > geo[i].boundR + geo[j].boundR) continue;
        const key = `${i}|${j}`;
        const list = conflicts.get(key) ?? [];
        for (let la = 0; la < geo[i].layers.length; la++) {
          for (let lb = 0; lb < geo[j].layers.length; lb++) {
            if (list.some(([x, y]) => x === la && y === lb)) continue;
            if (contoursOverlap(get(i, la), get(j, lb))) list.push([la, lb]);
          }
        }
        if (list.length) conflicts.set(key, list);
      }
    }
  }
  // --- place parts bottom-up, keeping the current layer when it is free
  const order = parts.map((_, i) => i).sort((a, b) => parts[a].pose.z - parts[b].pose.z || a - b);
  const z = parts.map((p) => p.pose.z);
  const placed: number[] = [];
  const clash = (i: number, zi: number): number | null => {
    // returns the lowest z that clears the first clashing neighbour, or null if free
    let need: number | null = null;
    for (const j of placed) {
      const list = conflicts.get(i < j ? `${i}|${j}` : `${j}|${i}`);
      if (!list) continue;
      for (const pair of list) {
        const li = i < j ? pair[0] : pair[1], lj = i < j ? pair[1] : pair[0];
        const A = geo[i].layers[li], B = geo[j].layers[lj];
        const a0 = zi + A.z0, a1 = zi + A.z1, b0 = z[j] + B.z0, b1 = z[j] + B.z1;
        // a clash is a real overlap along Z (parts that merely touch, e.g. a motor flange under a plate, are fine);
        // when one is found the part is lifted clear of the other by the running gap
        if (Math.min(a1, b1) - Math.max(a0, b0) > 0.02) need = Math.max(need ?? -Infinity, b1 + gap - A.z0);
      }
    }
    return need;
  };
  for (const i of order) {
    let zi = z[i];
    for (let guard = 0; guard < 200; guard++) {
      const need = clash(i, zi);
      if (need === null) break;
      zi = Math.round(Math.max(need, zi + 0.01) * 100) / 100;
    }
    z[i] = zi;
    placed.push(i);
  }
  const moved = parts.map((p, i) => ({ id: p.id, from: p.pose.z, to: z[i] })).filter((m) => Math.abs(m.to - m.from) > 1e-9);
  if (!moved.length) return { project, moved, samples: poseSets.length };
  const zOf = new Map(parts.map((p, i) => [p.id, z[i]] as const));
  return { project: { ...project, parts: project.parts.map((p) => (zOf.has(p.id) && zOf.get(p.id) !== p.pose.z ? { ...p, pose: { ...p.pose, z: zOf.get(p.id)! } } : p)) }, moved, samples: poseSets.length };
}
