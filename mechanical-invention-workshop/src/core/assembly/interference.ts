/**
 * Part–part interference detection on the true part geometry: two parts
 * interfere when their Z ranges overlap and their XY profiles (with holes)
 * intersect. Detection only — interference is reported, not resolved by
 * contact forces (see docs/SIMULATION.md).
 */
import type { Project } from '../model/types';
import { geometryOf } from '../model/project';
import { contoursOverlap, transformPoly, type Poly } from '../math/poly';
import { intersectionInfo, kernelReady } from '../geom/kernel';

export interface Interference {
  a: string;
  b: string;
  /** overlapping XY area, mm² (NaN when the area kernel is unavailable) */
  area: number;
  x: number;
  y: number;
  /** overlap along Z, mm */
  zOverlap: number;
}

interface LayerRef { contours: Poly[]; z0: number; z1: number }
interface PartEntry { id: string; layers: LayerRef[]; boundR: number; z0: number; z1: number }
export type PoseFn = (partId: string) => { x: number; y: number; angle: number } | null;

export class InterferenceChecker {
  private entries: PartEntry[] = [];
  private pairs: [number, number][] = [];
  minArea = 0.05;
  minZ = 0.02;

  constructor(project: Project, private sameBody?: (a: string, b: string) => boolean) {
    for (const p of project.parts) {
      if (p.suppressed) continue;
      const g = geometryOf(project, p);
      if (!g.layers.length) continue;
      this.entries.push({
        id: p.id, boundR: g.boundR, z0: p.pose.z + g.zMin, z1: p.pose.z + g.zMax,
        layers: g.layers.map((l) => ({ contours: l.contours, z0: p.pose.z + l.z0, z1: p.pose.z + l.z1 })),
      });
    }
    for (let i = 0; i < this.entries.length; i++) {
      for (let j = i + 1; j < this.entries.length; j++) {
        const a = this.entries[i], b = this.entries[j];
        if (Math.min(a.z1, b.z1) - Math.max(a.z0, b.z0) > this.minZ) this.pairs.push([i, j]);
      }
    }
  }

  get candidatePairs(): number { return this.pairs.length; }

  /** `movingOnly`: skip pairs that belong to the same rigid body (their relative pose never changes). */
  check(poseOf: PoseFn, movingOnly = false): Interference[] {
    const out: Interference[] = [];
    const poses = this.entries.map((e) => poseOf(e.id));
    const world = new Map<string, Poly[]>();
    const wc = (ei: number, li: number): Poly[] => {
      const key = `${ei}:${li}`;
      let w = world.get(key);
      if (!w) {
        const pose = poses[ei]!;
        w = this.entries[ei].layers[li].contours.map((c) => transformPoly(c, pose.x, pose.y, pose.angle));
        world.set(key, w);
      }
      return w;
    };
    for (const [i, j] of this.pairs) {
      const a = this.entries[i], b = this.entries[j];
      const pa = poses[i], pb = poses[j];
      if (!pa || !pb) continue;
      if (movingOnly && this.sameBody && this.sameBody(a.id, b.id)) continue;
      if (Math.hypot(pa.x - pb.x, pa.y - pb.y) > a.boundR + b.boundR) continue;
      let area = 0, zo = 0, sx = 0, sy = 0, hit = false, unknown = false;
      for (let la = 0; la < a.layers.length; la++) {
        for (let lb = 0; lb < b.layers.length; lb++) {
          const A = a.layers[la], B = b.layers[lb];
          const dz = Math.min(A.z1, B.z1) - Math.max(A.z0, B.z0);
          if (dz <= this.minZ) continue;
          const ca = wc(i, la), cb = wc(j, lb);
          if (!contoursOverlap(ca, cb)) continue;
          if (kernelReady()) {
            const info = intersectionInfo(ca, cb);
            if (info.area > this.minArea) { hit = true; area += info.area; sx += info.x * info.area; sy += info.y * info.area; zo = Math.max(zo, dz); }
          } else { hit = true; unknown = true; zo = Math.max(zo, dz); }
        }
      }
      if (hit) {
        out.push({
          a: a.id, b: b.id, area: unknown ? NaN : area,
          x: unknown || area === 0 ? (pa.x + pb.x) / 2 : sx / area, y: unknown || area === 0 ? (pa.y + pb.y) / 2 : sy / area, zOverlap: zo,
        });
      }
    }
    return out;
  }
}

export function findInterference(project: Project): Interference[] {
  const checker = new InterferenceChecker(project);
  const map = new Map(project.parts.map((p) => [p.id, p.pose] as const));
  return checker.check((id) => map.get(id) ?? null);
}
