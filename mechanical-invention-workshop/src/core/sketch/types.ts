/**
 * Planar sketch data model (stored inside a project). Lengths in mm, angles in rad.
 * A sketch lives in the XY plane of the part it defines (part-local coordinates).
 */

export interface SkPoint {
  id: string;
  x: number;
  y: number;
}

export type SkEntity =
  | { id: string; type: 'line'; p1: string; p2: string; construction?: boolean }
  /** full circle: centre point id + radius (a solver variable) */
  | { id: string; type: 'circle'; center: string; r: number; construction?: boolean }
  /** arc, counter-clockwise from `start` to `end` about `center` (all point ids) */
  | { id: string; type: 'arc'; center: string; start: string; end: string; construction?: boolean };

export type SkConstraint =
  /** two points share a location */
  | { id: string; type: 'coincident'; a: string; b: string }
  /** point is locked at its current coordinates */
  | { id: string; type: 'fixed'; point: string; x: number; y: number }
  /** line (entity id) is horizontal / vertical */
  | { id: string; type: 'horizontal'; line: string }
  | { id: string; type: 'vertical'; line: string }
  /** distance between two points (value ≥ 0, mm) */
  | { id: string; type: 'distance'; a: string; b: string; value: number }
  /** signed angle from line l1 direction (p1→p2) to line l2 direction (rad, CCW positive) */
  | { id: string; type: 'angle'; l1: string; l2: string; value: number }
  /** radius of a circle or arc entity (mm) */
  | { id: string; type: 'radius'; entity: string; value: number }
  | { id: string; type: 'parallel'; l1: string; l2: string }
  | { id: string; type: 'perpendicular'; l1: string; l2: string }
  /** two lines have equal length, or two circles/arcs equal radius */
  | { id: string; type: 'equal'; e1: string; e2: string }
  /** point lies on a line (infinite extension) or on a circle/arc */
  | { id: string; type: 'pointOn'; point: string; entity: string }
  /** line tangent to circle/arc */
  | { id: string; type: 'tangent'; line: string; circle: string };

export interface Sketch {
  id: string;
  name: string;
  points: SkPoint[];
  entities: SkEntity[];
  constraints: SkConstraint[];
}

export type SketchStatus =
  | 'empty'
  /** all constraints satisfied, zero remaining freedoms */
  | 'fully-constrained'
  /** all constraints satisfied, some freedoms remain */
  | 'under-constrained'
  /** constraints are consistent but at least one is redundant (adds no information) */
  | 'redundant'
  /** no geometry satisfies all constraints simultaneously */
  | 'conflicting';

export interface SketchSolveResult {
  status: SketchStatus;
  /** true when the returned coordinates satisfy every non-conflicting constraint within tolerance */
  converged: boolean;
  /** remaining degrees of freedom of the sketch geometry (0 = fully constrained) */
  dof: number;
  /** solved coordinates: point id → position. When status is 'conflicting' these are
   *  the LAST VALID coordinates (input positions), never a silently deformed compromise. */
  points: Record<string, { x: number; y: number }>;
  /** solved circle radii: entity id → r */
  radii: Record<string, number>;
  /** constraint ids that are redundant (consistent but dependent) */
  redundant: string[];
  /** constraint ids that cannot be satisfied together with the others */
  conflicting: string[];
  /** point ids that can still move (under-constrained) */
  freePoints: string[];
  /** circle/arc entity ids whose radius is still free */
  freeRadii: string[];
  /** max absolute residual of satisfied constraints (mm or rad) */
  residual: number;
  /** human-readable one-line explanation */
  message: string;
}

/** A closed profile extracted from sketch geometry, ready for extrusion. */
export interface SketchLoop {
  /** discretised polygon, counter-clockwise, no repeated last point */
  points: [number, number][];
  /** signed area (positive, since CCW) */
  area: number;
  /** when the loop is a single full circle: its centre and radius (kept exact for drawings/DXF) */
  circle?: { cx: number; cy: number; r: number; entityId: string };
  /** entity ids forming the loop */
  entityIds: string[];
}

export interface SketchRegion {
  outer: SketchLoop;
  holes: SketchLoop[];
}

export interface SketchProfileResult {
  regions: SketchRegion[];
  /** entity ids that are not part of any closed loop (open chains, dangling lines) */
  openEntities: string[];
  /** problems such as self-intersection or overlapping loops, human readable */
  problems: string[];
}
