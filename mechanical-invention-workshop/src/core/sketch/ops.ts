/**
 * Pure editing helpers for sketches. Nothing here mutates its input: every
 * function returns a new Sketch (structurally sharing untouched items).
 */
import type { Sketch, SkConstraint, SkEntity } from './types';

/** Omit that distributes over a union (keeps each variant's own fields). */
export type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

export function newSketch(id: string, name: string): Sketch {
  return { id, name, points: [], entities: [], constraints: [] };
}

/**
 * Next free id with the given prefix: prefix + (largest existing numeric suffix
 * among ALL ids of the sketch with that prefix, plus one). Deterministic, and
 * never reuses the number of an item that still exists.
 */
function nextId(s: Sketch, prefix: string): string {
  const used = new Set<string>();
  let max = 0;
  const visit = (id: string): void => {
    used.add(id);
    if (id.length > prefix.length && id.startsWith(prefix)) {
      const tail = id.slice(prefix.length);
      if (/^\d+$/.test(tail)) max = Math.max(max, parseInt(tail, 10));
    }
  };
  for (const p of s.points) visit(p.id);
  for (const e of s.entities) visit(e.id);
  for (const c of s.constraints) visit(c.id);
  let k = max + 1;
  while (used.has(prefix + k)) k++;
  return prefix + k;
}

export function addPoint(s: Sketch, x: number, y: number): { sketch: Sketch; id: string } {
  const id = nextId(s, 'p');
  return { sketch: { ...s, points: [...s.points, { id, x, y }] }, id };
}

function addEntity(s: Sketch, e: SkEntity): Sketch {
  return { ...s, entities: [...s.entities, e] };
}

export function addLine(s: Sketch, p1: string, p2: string): { sketch: Sketch; id: string } {
  const id = nextId(s, 'l');
  return { sketch: addEntity(s, { id, type: 'line', p1, p2 }), id };
}

export function addCircle(s: Sketch, center: string, r: number): { sketch: Sketch; id: string } {
  const id = nextId(s, 'c');
  return { sketch: addEntity(s, { id, type: 'circle', center, r }), id };
}

/** Arc runs counter-clockwise from `start` to `end` about `center`. */
export function addArc(s: Sketch, center: string, start: string, end: string): { sketch: Sketch; id: string } {
  const id = nextId(s, 'a');
  return { sketch: addEntity(s, { id, type: 'arc', center, start, end }), id };
}

export function addConstraint(s: Sketch, c: DistributiveOmit<SkConstraint, 'id'>): { sketch: Sketch; id: string } {
  const id = nextId(s, 'k');
  const full = { ...c, id } as SkConstraint;
  return { sketch: { ...s, constraints: [...s.constraints, full] }, id };
}

function entityPoints(e: SkEntity): string[] {
  switch (e.type) {
    case 'line': return [e.p1, e.p2];
    case 'circle': return [e.center];
    case 'arc': return [e.center, e.start, e.end];
  }
}

/** ids (points and entities) a constraint refers to */
function constraintRefs(c: SkConstraint): string[] {
  switch (c.type) {
    case 'coincident': return [c.a, c.b];
    case 'fixed': return [c.point];
    case 'horizontal':
    case 'vertical': return [c.line];
    case 'distance': return [c.a, c.b];
    case 'angle':
    case 'parallel':
    case 'perpendicular': return [c.l1, c.l2];
    case 'radius': return [c.entity];
    case 'equal': return [c.e1, c.e2];
    case 'pointOn': return [c.point, c.entity];
    case 'tangent': return [c.line, c.circle];
  }
}

/**
 * Remove points / entities / constraints by id, cascading:
 *  - entities that use a removed point are removed;
 *  - points that were used by a removed entity and are no longer used by any
 *    remaining entity are removed (stand-alone points the caller did not name
 *    and that never belonged to a removed entity are kept);
 *  - constraints referencing any removed point or entity are removed.
 */
export function removeItems(s: Sketch, ids: string[]): Sketch {
  const kill = new Set(ids);
  const gonePoints = new Set<string>();
  for (const p of s.points) if (kill.has(p.id)) gonePoints.add(p.id);
  const goneEntities = new Set<string>();
  const candidates = new Set<string>();
  for (const e of s.entities) {
    const pts = entityPoints(e);
    if (kill.has(e.id) || pts.some(p => gonePoints.has(p))) {
      goneEntities.add(e.id);
      for (const p of pts) candidates.add(p);
    }
  }
  const stillUsed = new Set<string>();
  for (const e of s.entities) {
    if (goneEntities.has(e.id)) continue;
    for (const p of entityPoints(e)) stillUsed.add(p);
  }
  for (const p of candidates) if (!stillUsed.has(p)) gonePoints.add(p);

  const points = s.points.filter(p => !gonePoints.has(p.id));
  const entities = s.entities.filter(e => !goneEntities.has(e.id));
  const constraints = s.constraints.filter(c =>
    !kill.has(c.id) && !constraintRefs(c).some(r => gonePoints.has(r) || goneEntities.has(r)));
  return { ...s, points, entities, constraints };
}

/**
 * Axis-aligned rectangle: 4 corner points (x0,y0) → (x1,y0) → (x1,y1) → (x0,y1),
 * 4 lines sharing them (bottom, right, top, left for x0<x1, y0<y1) and
 * horizontal / vertical constraints on the lines.
 */
export function rectangle(
  s: Sketch, x0: number, y0: number, x1: number, y1: number,
): { sketch: Sketch; pointIds: string[]; lineIds: string[]; constraintIds: string[] } {
  let sk = s;
  const pointIds: string[] = [];
  for (const [x, y] of [[x0, y0], [x1, y0], [x1, y1], [x0, y1]]) {
    const r = addPoint(sk, x, y);
    sk = r.sketch;
    pointIds.push(r.id);
  }
  const lineIds: string[] = [];
  for (let i = 0; i < 4; i++) {
    const r = addLine(sk, pointIds[i], pointIds[(i + 1) % 4]);
    sk = r.sketch;
    lineIds.push(r.id);
  }
  const constraintIds: string[] = [];
  for (let i = 0; i < 4; i++) {
    const r = addConstraint(sk, { type: i % 2 === 0 ? 'horizontal' : 'vertical', line: lineIds[i] });
    sk = r.sketch;
    constraintIds.push(r.id);
  }
  return { sketch: sk, pointIds, lineIds, constraintIds };
}
