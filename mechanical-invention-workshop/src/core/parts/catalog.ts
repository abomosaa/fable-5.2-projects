/**
 * Parametric component library. Each part kind defines its parameter schema
 * (with quantity kinds so the UI shows units) and a pure geometry builder.
 *
 * Geometry is a stack of extruded 2D regions ("layers"): contours in local XY
 * (CCW solid / CW hole), extruded between local z0 and z1. The same layers
 * drive rendering, mass properties, interference checks and export — there are
 * no decorative stand-in meshes.
 */
import type { Clearances, Part, PlateHole, CamSegment } from '../model/types';
import type { QuantityKind } from '../units';
import type { Sketch } from '../sketch/types';
import {
  circlePoly, hullOfCircles, roundedRect, reversed, signedArea, convexHull, pointInPoly, type Poly, type Pt,
} from '../math/poly';
import { involuteGearProfile, rackProfile, camProfile, camSegmentSummary, type CamParams } from './profiles';
import { extractProfiles } from '../sketch/profiles';

export interface Layer {
  contours: Poly[];
  z0: number;
  z1: number;
  /** appearance override; default = part material */
  look?: 'steel' | 'dark' | 'rubber' | 'brass' | 'copper';
}

export interface Port {
  id: string;
  label: string;
  x: number;
  y: number;
  kind: 'hole' | 'center' | 'point' | 'roller' | 'pin';
  /** nominal diameter of the hole / pin at this port */
  d?: number;
  /** radius of the round outer surface concentric with the port (roller, link end, pitch circle …) */
  r?: number;
  /** preferred sliding axis through this port (rad, local) */
  axis?: number;
}

export interface HoleFeature { x: number; y: number; /** modelled diameter incl. clearance */ d: number; nominal: number; label: string }

export type DimSpec =
  | { kind: 'linear'; a: Pt; b: Pt; label?: string; offset?: number }
  | { kind: 'diameter'; c: Pt; d: number; label?: string; angle?: number }
  | { kind: 'note'; text: string };

export interface PartGeometry {
  layers: Layer[];
  ports: Port[];
  holes: HoleFeature[];
  dims: DimSpec[];
  /** round surfaces that can touch the floor */
  contactCircles: { x: number; y: number; r: number }[];
  /** convex-hull corner points that can touch the floor (polygonal bodies) */
  contactPoints: Pt[];
  boundR: number;
  zMin: number;
  zMax: number;
  /** gear / pulley pitch radius, rack marker */
  pitchRadius?: number;
  warnings: string[];
  /** blocking problems: the generated solid is NOT the part that was specified (a feature had to be left out).
   *  Reported as errors; export of the part is refused until they are fixed. */
  errors: string[];
  /** one-line specification for the BOM */
  spec: string;
}

export interface ParamDef {
  key: string;
  label: string;
  type: QuantityKind | 'int' | 'enum' | 'bool' | 'camSegments' | 'holes' | 'sketch';
  default: any;
  min?: number;
  max?: number;
  options?: { value: string; label: string }[];
  help?: string;
  /** only shown when predicate holds */
  when?: (p: Record<string, any>) => boolean;
}

export interface BuildContext { clearances: Clearances; sketches: Sketch[] }

export interface PartDef {
  kind: Part['kind'];
  label: string;
  category: 'Linkage' | 'Gears' | 'Cams' | 'Belts' | 'Shafts & bearings' | 'Guides' | 'Structure' | 'Hardware' | 'Actuators';
  description: string;
  keywords: string;
  /** bought-in component (true) or custom manufactured part (false) */
  purchased: boolean;
  defaultMaterial: string;
  params: ParamDef[];
  build: (p: Record<string, any>, ctx: BuildContext) => PartGeometry;
}

const mm = (n: number) => (Math.round(n * 1000) / 1000).toString();
const DEG = Math.PI / 180;

function geom(layers: Layer[], ports: Port[], extra: Partial<PartGeometry> = {}): PartGeometry {
  let boundR = 0, zMin = Infinity, zMax = -Infinity;
  for (const l of layers) {
    zMin = Math.min(zMin, l.z0); zMax = Math.max(zMax, l.z1);
    for (const c of l.contours) for (const [x, y] of c) boundR = Math.max(boundR, Math.hypot(x, y));
  }
  if (!layers.length) { zMin = 0; zMax = 0; }
  return {
    layers, ports, holes: [], dims: [], contactCircles: [], contactPoints: [],
    boundR, zMin, zMax, warnings: [], errors: [], spec: '', ...extra,
  };
}

function hole(x: number, y: number, nominal: number, cl: Clearances, label: string): { poly: Poly; feat: HoleFeature } {
  const d = nominal + cl.hole;
  return { poly: circlePoly(x, y, d / 2, true), feat: { x, y, d, nominal, label } };
}

function hullPoints(layers: Layer[]): Pt[] {
  const pts: Pt[] = [];
  for (const l of layers) for (const c of l.contours) if (signedArea(c) > 0) pts.push(...c);
  return convexHull(pts);
}

// ------------------------------------------------------------------ link

function ternaryApex(L: number, ac: number, bc: number, flip: boolean): Pt | null {
  // C such that |AC| = ac, |BC| = bc, A=(0,0), B=(L,0)
  const x = (ac * ac - bc * bc + L * L) / (2 * L);
  const h2 = ac * ac - x * x;
  if (h2 < 0) return null;
  const y = Math.sqrt(h2);
  return [x, flip ? -y : y];
}

const linkDef: PartDef = {
  kind: 'link',
  label: 'Link',
  category: 'Linkage',
  description: 'Flat bar with pin holes. Binary (2 holes) or ternary (3 holes, rigid triangle).',
  keywords: 'bar rod coupler rocker crank arm lever triangle ternary connecting conrod leg',
  purchased: false,
  defaultMaterial: 'pla',
  params: [
    { key: 'shape', label: 'Shape', type: 'enum', default: 'binary', options: [{ value: 'binary', label: 'Binary (A–B)' }, { value: 'ternary', label: 'Ternary (A–B–C)' }] },
    { key: 'length', label: 'Length A–B', type: 'length', default: 60, min: 1 },
    { key: 'sideAC', label: 'Length A–C', type: 'length', default: 40, min: 1, when: (p) => p.shape === 'ternary' },
    { key: 'sideBC', label: 'Length B–C', type: 'length', default: 40, min: 1, when: (p) => p.shape === 'ternary' },
    { key: 'flip', label: 'Apex below A–B', type: 'bool', default: false, when: (p) => p.shape === 'ternary' },
    { key: 'width', label: 'Width', type: 'length', default: 10, min: 1 },
    { key: 'thickness', label: 'Thickness', type: 'length', default: 4, min: 0.2 },
    { key: 'holeDiameter', label: 'Pin diameter', type: 'length', default: 4, min: 0, help: 'Nominal pin size; the hole is enlarged by the project hole clearance.' },
  ],
  build(p, ctx) {
    const L = Math.max(p.length, 0.1), w = p.width, t = p.thickness, r = w / 2;
    const warnings: string[] = [];
    const errors: string[] = [];
    const centers: { id: string; x: number; y: number }[] = [{ id: 'A', x: 0, y: 0 }, { id: 'B', x: L, y: 0 }];
    if (p.shape === 'ternary') {
      let c = ternaryApex(L, p.sideAC, p.sideBC, !!p.flip);
      if (!c) {
        warnings.push(`Ternary link sides ${mm(L)}, ${mm(p.sideAC)}, ${mm(p.sideBC)} mm violate the triangle inequality; hole C was placed on the A–B line.`);
        const x = Math.max(0, Math.min(L, (p.sideAC * p.sideAC - p.sideBC * p.sideBC + L * L) / (2 * L)));
        c = [x, 0];
      }
      centers.push({ id: 'C', x: c[0], y: c[1] });
    }
    const outline = hullOfCircles(centers.map((c) => ({ x: c.x, y: c.y, r })));
    const contours: Poly[] = [outline];
    const holes: HoleFeature[] = [];
    if (p.holeDiameter > 0) {
      if (p.holeDiameter + ctx.clearances.hole >= w - 2 * ctx.clearances.minFeature) {
        warnings.push(`Wall around the ${mm(p.holeDiameter)} mm holes is thinner than the minimum feature size (${mm(ctx.clearances.minFeature)} mm).`);
      }
      const dCut = p.holeDiameter + ctx.clearances.hole;
      if (dCut >= w) {
        errors.push(`Pin holes ⌀${mm(dCut)} mm (pin ${mm(p.holeDiameter)} + clearance ${mm(ctx.clearances.hole)}) are as wide as the ${mm(w)} mm link, so they were NOT cut: this link has no pivot holes. Widen the link or use a smaller pin.`);
      } else {
        for (const c of centers) {
          const h = hole(c.x, c.y, p.holeDiameter, ctx.clearances, c.id);
          contours.push(h.poly); holes.push(h.feat);
        }
        // holes that run into each other (very short links)
        for (let i = 0; i < centers.length; i++) for (let k = i + 1; k < centers.length; k++) {
          const dist = Math.hypot(centers[i].x - centers[k].x, centers[i].y - centers[k].y);
          if (dist < dCut + ctx.clearances.minFeature) warnings.push(`Holes ${centers[i].id} and ${centers[k].id} are only ${mm(dist)} mm apart: ${dist < dCut ? 'they overlap and merge into one opening' : `the web between them is thinner than the minimum feature size (${mm(ctx.clearances.minFeature)} mm)`}.`);
        }
      }
    }
    const ports: Port[] = centers.map((c) => ({ id: c.id, label: `Hole ${c.id}`, x: c.x, y: c.y, kind: 'hole', d: p.holeDiameter, r }));
    const g = geom([{ contours, z0: 0, z1: t }], ports, { holes, warnings, errors });
    g.contactCircles = centers.map((c) => ({ x: c.x, y: c.y, r }));
    g.dims = [
      { kind: 'linear', a: [0, 0], b: [L, 0], offset: -(r + 6) },
      { kind: 'note', text: `Width ${mm(w)}  ·  Thickness ${mm(t)}` },
    ];
    if (p.shape === 'ternary' && centers[2]) {
      const c = centers[2];
      g.dims.push({ kind: 'linear', a: [0, 0], b: [c.x, c.y], offset: r + 6 }, { kind: 'linear', a: [L, 0], b: [c.x, c.y], offset: -(r + 6) });
    }
    if (holes.length) g.dims.push({ kind: 'diameter', c: [holes[0].x, holes[0].y], d: holes[0].d, label: `${holes.length}× ⌀${mm(holes[0].d)}` });
    g.spec = p.shape === 'ternary'
      ? `Ternary link ${mm(L)}/${mm(p.sideAC)}/${mm(p.sideBC)} × ${mm(w)} × ${mm(t)} mm`
      : `Link ${mm(L)} × ${mm(w)} × ${mm(t)} mm, holes ⌀${mm(p.holeDiameter + ctx.clearances.hole)}`;
    return g;
  },
};

// ------------------------------------------------------------------ gear

const gearDef: PartDef = {
  kind: 'gear',
  label: 'Spur gear',
  category: 'Gears',
  description: 'External involute spur gear. Pitch diameter = module × teeth.',
  keywords: 'spur involute pinion wheel cog teeth reduction ratio',
  purchased: false,
  defaultMaterial: 'pla',
  params: [
    { key: 'module', label: 'Module', type: 'length', default: 2, min: 0.2 },
    { key: 'teeth', label: 'Teeth', type: 'int', default: 20, min: 6, max: 200 },
    { key: 'pressureAngle', label: 'Pressure angle', type: 'angle', default: 20 * DEG, min: 14 * DEG, max: 30 * DEG },
    { key: 'thickness', label: 'Face width', type: 'length', default: 6, min: 0.2 },
    { key: 'boreDiameter', label: 'Bore diameter', type: 'length', default: 5, min: 0 },
    { key: 'pinRadius', label: 'Crank pin radius', type: 'length', default: 0, min: 0, help: 'Optional eccentric pin hole so the gear can act as a crank. 0 = none.' },
    { key: 'pinDiameter', label: 'Crank pin diameter', type: 'length', default: 4, min: 0.5, when: (p) => p.pinRadius > 0 },
  ],
  build(p, ctx) {
    const teeth = Math.max(4, Math.round(p.teeth));
    const { poly, dims } = involuteGearProfile(p.module, teeth, p.pressureAngle, ctx.clearances.backlash);
    const warnings = [...dims.warnings];
    const errors: string[] = [];
    const contours: Poly[] = [poly];
    const holes: HoleFeature[] = [];
    const ports: Port[] = [{ id: 'center', label: 'Axis', x: 0, y: 0, kind: 'center', d: p.boreDiameter, r: dims.pitchR }];
    if (p.boreDiameter > 0) {
      const h = hole(0, 0, p.boreDiameter, ctx.clearances, 'bore');
      if (h.feat.d / 2 < dims.rootR - ctx.clearances.minFeature) { contours.push(h.poly); holes.push(h.feat); }
      else errors.push(`Bore ⌀${mm(p.boreDiameter + ctx.clearances.hole)} mm is too large for the root circle (⌀${mm(dims.rootR * 2)} mm); it was NOT cut.`);
    }
    if (p.pinRadius > 0) {
      const h = hole(p.pinRadius, 0, p.pinDiameter, ctx.clearances, 'pin');
      if (p.pinRadius + h.feat.d / 2 < dims.rootR - ctx.clearances.minFeature && p.pinRadius - h.feat.d / 2 > (p.boreDiameter + ctx.clearances.hole) / 2 + ctx.clearances.minFeature) {
        contours.push(h.poly); holes.push(h.feat);
        ports.push({ id: 'pin', label: 'Crank pin', x: p.pinRadius, y: 0, kind: 'hole', d: p.pinDiameter });
      } else errors.push('Crank pin hole does not fit between the bore and the root circle; it was NOT cut.');
    }
    const g = geom([{ contours, z0: 0, z1: p.thickness }], ports, { holes, warnings, errors, pitchRadius: dims.pitchR });
    g.contactCircles = [{ x: 0, y: 0, r: dims.tipR }];
    g.dims = [
      { kind: 'diameter', c: [0, 0], d: dims.tipR * 2, label: `Tip ⌀${mm(dims.tipR * 2)}`, angle: 30 * DEG },
      { kind: 'diameter', c: [0, 0], d: dims.pitchR * 2, label: `Pitch ⌀${mm(dims.pitchR * 2)}`, angle: -30 * DEG },
      { kind: 'note', text: `m = ${mm(p.module)}, z = ${teeth}, α = ${mm(p.pressureAngle / DEG)}°, backlash ${mm(ctx.clearances.backlash)}` },
      { kind: 'note', text: `Root ⌀${mm(dims.rootR * 2)}  ·  Face width ${mm(p.thickness)}` },
    ];
    if (holes.length) g.dims.push({ kind: 'diameter', c: [0, 0], d: holes[0].d, label: `Bore ⌀${mm(holes[0].d)}`, angle: 150 * DEG });
    g.spec = `Spur gear m${mm(p.module)} z${teeth} α${mm(p.pressureAngle / DEG)}°, face ${mm(p.thickness)} mm, bore ⌀${mm(p.boreDiameter + ctx.clearances.hole)}`;
    return g;
  },
};

// ------------------------------------------------------------------ rack

const rackDef: PartDef = {
  kind: 'rack',
  label: 'Rack',
  category: 'Gears',
  description: 'Straight gear rack. Pitch line is the local X axis; mesh with a spur gear of equal module.',
  keywords: 'rack pinion linear gear teeth',
  purchased: false,
  defaultMaterial: 'pla',
  params: [
    { key: 'module', label: 'Module', type: 'length', default: 2, min: 0.2 },
    { key: 'teeth', label: 'Teeth', type: 'int', default: 20, min: 2, max: 400 },
    { key: 'pressureAngle', label: 'Pressure angle', type: 'angle', default: 20 * DEG, min: 14 * DEG, max: 30 * DEG },
    { key: 'backing', label: 'Backing height', type: 'length', default: 6, min: 0.5 },
    { key: 'thickness', label: 'Face width', type: 'length', default: 6, min: 0.2 },
  ],
  build(p, ctx) {
    const teeth = Math.max(2, Math.round(p.teeth));
    const { poly, length } = rackProfile(p.module, teeth, p.pressureAngle, ctx.clearances.backlash, p.backing);
    const yMid = -(1.25 * p.module + p.backing / 2);
    const ports: Port[] = [
      { id: 'start', label: 'Pitch line start', x: 0, y: 0, kind: 'point', axis: 0 },
      { id: 'mid', label: 'Pitch line middle', x: length / 2, y: 0, kind: 'point', axis: 0 },
      { id: 'end', label: 'Pitch line end', x: length, y: 0, kind: 'point', axis: 0 },
      { id: 'back', label: 'Backing centre', x: length / 2, y: yMid, kind: 'point', axis: 0 },
    ];
    const g = geom([{ contours: [poly], z0: 0, z1: p.thickness }], ports, { pitchRadius: 0 });
    g.contactPoints = hullPoints(g.layers);
    g.dims = [
      { kind: 'linear', a: [0, -(1.25 * p.module + p.backing)], b: [length, -(1.25 * p.module + p.backing)], offset: -8 },
      { kind: 'linear', a: [0, -(1.25 * p.module + p.backing)], b: [0, p.module], offset: -8 },
      { kind: 'note', text: `m = ${mm(p.module)}, z = ${teeth}, pitch ${mm(Math.PI * p.module)} mm, α = ${mm(p.pressureAngle / DEG)}°` },
    ];
    g.spec = `Rack m${mm(p.module)} × ${teeth} teeth (${mm(length)} mm), face ${mm(p.thickness)} mm`;
    return g;
  },
};

// ------------------------------------------------------------------ shaft / bearing

const shaftDef: PartDef = {
  kind: 'shaft',
  label: 'Shaft',
  category: 'Shafts & bearings',
  description: 'Round shaft along the stacking (Z) axis. Attach gears, pulleys and cams rigidly to it.',
  keywords: 'axle rod spindle pin dowel',
  purchased: true,
  defaultMaterial: 'steel',
  params: [
    { key: 'diameter', label: 'Diameter', type: 'length', default: 5, min: 0.5 },
    { key: 'length', label: 'Length', type: 'length', default: 30, min: 1 },
  ],
  build(p) {
    const r = p.diameter / 2;
    const g = geom([{ contours: [circlePoly(0, 0, r)], z0: 0, z1: p.length }], [
      { id: 'center', label: 'Axis', x: 0, y: 0, kind: 'center', d: p.diameter, r },
    ]);
    g.contactCircles = [{ x: 0, y: 0, r }];
    g.dims = [{ kind: 'diameter', c: [0, 0], d: p.diameter }, { kind: 'note', text: `Length ${mm(p.length)}` }];
    g.spec = `Round shaft ⌀${mm(p.diameter)} × ${mm(p.length)} mm`;
    return g;
  },
};

const bearingDef: PartDef = {
  kind: 'bearing',
  label: 'Ball bearing',
  category: 'Shafts & bearings',
  description: 'Deep-groove ball bearing (envelope geometry). Fix the outer ring to a frame and run a shaft in the bore.',
  keywords: 'bearing ball 608 623 625 bushing',
  purchased: true,
  defaultMaterial: 'steel',
  params: [
    { key: 'bore', label: 'Bore', type: 'length', default: 5, min: 1 },
    { key: 'outerDiameter', label: 'Outer diameter', type: 'length', default: 16, min: 3 },
    { key: 'width', label: 'Width', type: 'length', default: 5, min: 1 },
  ],
  build(p) {
    const ro = p.outerDiameter / 2, ri = p.bore / 2;
    const wall = (ro - ri) * 0.28;
    const r1 = ro - wall, r2 = ri + wall;
    const warnings: string[] = [];
    if (ro - ri < 1) warnings.push('Bearing outer diameter must exceed the bore by at least 2 mm.');
    const layers: Layer[] = [
      { contours: [circlePoly(0, 0, ro), circlePoly(0, 0, r1, true), circlePoly(0, 0, r2), circlePoly(0, 0, ri, true)], z0: 0, z1: p.width, look: 'steel' },
      { contours: [circlePoly(0, 0, r1), circlePoly(0, 0, r2, true)], z0: p.width * 0.1, z1: p.width * 0.9, look: 'dark' },
    ];
    const g = geom(layers, [{ id: 'center', label: 'Axis', x: 0, y: 0, kind: 'center', d: p.bore, r: ro }], { warnings });
    g.contactCircles = [{ x: 0, y: 0, r: ro }];
    g.dims = [{ kind: 'diameter', c: [0, 0], d: p.outerDiameter }, { kind: 'diameter', c: [0, 0], d: p.bore, angle: 135 * DEG }];
    g.spec = `Ball bearing ${mm(p.bore)} × ${mm(p.outerDiameter)} × ${mm(p.width)} mm`;
    return g;
  },
};

// ------------------------------------------------------------------ cam / follower

export function camParamsOf(p: Record<string, any>): CamParams {
  return {
    profile: p.profile === 'eccentric' ? 'eccentric' : 'segments',
    baseRadius: p.baseRadius, rollerRadius: p.rollerRadius, segments: (p.segments ?? []) as CamSegment[],
    discRadius: p.discRadius, eccentricity: p.eccentricity,
  };
}

const camDef: PartDef = {
  kind: 'cam',
  label: 'Plate cam',
  category: 'Cams',
  description: 'Disc cam for a roller follower. Profile from rise/dwell/return segments or an eccentric circle.',
  keywords: 'cam eccentric lobe profile dwell rise cycloidal harmonic',
  purchased: false,
  defaultMaterial: 'pla',
  params: [
    { key: 'profile', label: 'Profile type', type: 'enum', default: 'segments', options: [{ value: 'segments', label: 'Motion segments' }, { value: 'eccentric', label: 'Eccentric circle' }] },
    { key: 'baseRadius', label: 'Base circle radius', type: 'length', default: 18, min: 2, when: (p) => p.profile !== 'eccentric' },
    { key: 'segments', label: 'Motion program', type: 'camSegments', default: [
      { duration: 120 * DEG, lift: 10, law: 'cycloidal' },
      { duration: 60 * DEG, lift: 10, law: 'dwell' },
      { duration: 120 * DEG, lift: 0, law: 'cycloidal' },
      { duration: 60 * DEG, lift: 0, law: 'dwell' },
    ] as CamSegment[], when: (p) => p.profile !== 'eccentric' },
    { key: 'discRadius', label: 'Disc radius', type: 'length', default: 20, min: 2, when: (p) => p.profile === 'eccentric' },
    { key: 'eccentricity', label: 'Eccentricity', type: 'length', default: 5, min: 0, when: (p) => p.profile === 'eccentric' },
    { key: 'rollerRadius', label: 'Design roller radius', type: 'length', default: 5, min: 0, help: 'The cam surface is the inner offset of the roller-centre path by this radius. Must match the follower roller.' },
    { key: 'thickness', label: 'Thickness', type: 'length', default: 6, min: 0.2 },
    { key: 'boreDiameter', label: 'Bore diameter', type: 'length', default: 5, min: 0 },
  ],
  build(p, ctx) {
    const cp = camParamsOf(p);
    const prof = camProfile(cp);
    const warnings = [...prof.warnings];
    const errors: string[] = [];
    let surface = prof.surface;
    if (signedArea(surface) < 0) surface = reversed(surface);
    const contours: Poly[] = [surface];
    const holes: HoleFeature[] = [];
    if (p.boreDiameter > 0) {
      const h = hole(0, 0, p.boreDiameter, ctx.clearances, 'bore');
      if (h.feat.d / 2 < prof.minR - ctx.clearances.minFeature) { contours.push(h.poly); holes.push(h.feat); }
      else errors.push('Bore does not fit inside the cam profile; it was NOT cut.');
    }
    const g = geom([{ contours, z0: 0, z1: p.thickness }], [
      { id: 'center', label: 'Axis', x: 0, y: 0, kind: 'center', d: p.boreDiameter, r: prof.maxR },
    ], { holes, warnings, errors });
    g.contactCircles = [{ x: 0, y: 0, r: prof.maxR }];
    const sum = camSegmentSummary(cp.segments);
    g.dims = [
      { kind: 'diameter', c: [0, 0], d: prof.minR * 2, label: `Min ⌀${mm(prof.minR * 2)}`, angle: 200 * DEG },
      { kind: 'diameter', c: [0, 0], d: prof.maxR * 2, label: `Max R${mm(prof.maxR)}`, angle: 20 * DEG },
      { kind: 'note', text: cp.profile === 'eccentric' ? `Eccentric disc R${mm(p.discRadius)}, e = ${mm(p.eccentricity)} (stroke ${mm(2 * p.eccentricity)})` : `Base R${mm(p.baseRadius)}, max lift ${mm(sum.maxLift)}, roller R${mm(p.rollerRadius)}` },
      { kind: 'note', text: `Thickness ${mm(p.thickness)}` },
    ];
    if (holes.length) g.dims.push({ kind: 'diameter', c: [0, 0], d: holes[0].d, label: `Bore ⌀${mm(holes[0].d)}`, angle: 110 * DEG });
    g.spec = cp.profile === 'eccentric'
      ? `Eccentric cam R${mm(p.discRadius)} e${mm(p.eccentricity)}, ${mm(p.thickness)} mm thick`
      : `Plate cam, base R${mm(p.baseRadius)}, lift ${mm(sum.maxLift)} mm, ${mm(p.thickness)} mm thick`;
    return g;
  },
};

const followerDef: PartDef = {
  kind: 'follower',
  label: 'Roller follower',
  category: 'Cams',
  description: 'Translating follower: a stem with a roller at its tip. Guide the stem with a prismatic joint and add a cam contact.',
  keywords: 'follower roller tappet lifter stem plunger',
  purchased: false,
  defaultMaterial: 'pla',
  params: [
    { key: 'rollerDiameter', label: 'Roller diameter', type: 'length', default: 10, min: 1 },
    { key: 'stemWidth', label: 'Stem width', type: 'length', default: 8, min: 1 },
    { key: 'stemLength', label: 'Stem length', type: 'length', default: 50, min: 2 },
    { key: 'thickness', label: 'Thickness', type: 'length', default: 6, min: 0.2 },
  ],
  build(p, ctx) {
    const rr = p.rollerDiameter / 2, L = p.stemLength;
    const errorsF: string[] = [];
    let w = p.stemWidth - 2 * ctx.clearances.slide;
    if (w < ctx.clearances.minFeature) {
      errorsF.push(`Stem width ${mm(p.stemWidth)} mm minus 2 × ${mm(ctx.clearances.slide)} mm slide clearance leaves ${mm(Math.max(w, 0))} mm, below the minimum feature size (${mm(ctx.clearances.minFeature)} mm): the stem cannot be made. It is drawn at the minimum feature size.`);
      w = ctx.clearances.minFeature;
    }
    // roller (as modelled: integral rounded tip) + stem; one outline: union of circle and rectangle
    const pts: Poly = [];
    const hw = Math.min(w / 2, rr * 0.999);
    const a0 = Math.asin(hw / rr); // angle from +y where stem meets roller
    // start at stem top-right, go CCW: top-left, down the left side, around the roller, up the right
    pts.push([w / 2, L], [-w / 2, L]);
    if (w / 2 > hw + 1e-9) pts.push([-w / 2, rr * Math.cos(a0)]);
    const start = Math.PI / 2 + a0, end = Math.PI / 2 - a0 + 2 * Math.PI;
    const n = 64;
    for (let i = 0; i <= n; i++) {
      const a = start + ((end - start) * i) / n;
      pts.push([rr * Math.cos(a), rr * Math.sin(a)]);
    }
    if (w / 2 > hw + 1e-9) pts.push([w / 2, rr * Math.cos(a0)]);
    const tabR = Math.max(w / 2, 4);
    const ports: Port[] = [
      { id: 'roller', label: 'Roller centre', x: 0, y: 0, kind: 'roller', r: rr, axis: Math.PI / 2 },
      { id: 'mid', label: 'Stem middle', x: 0, y: L / 2, kind: 'point', axis: Math.PI / 2 },
      { id: 'top', label: 'Stem top', x: 0, y: L, kind: 'point', axis: Math.PI / 2 },
    ];
    void tabR;
    const g = geom([{ contours: [pts], z0: 0, z1: p.thickness }], ports, { errors: errorsF });
    g.contactCircles = [{ x: 0, y: 0, r: rr }];
    g.contactPoints = [[w / 2, L], [-w / 2, L]];
    g.dims = [
      { kind: 'linear', a: [0, 0], b: [0, L], offset: -(Math.max(rr, w / 2) + 6) },
      { kind: 'diameter', c: [0, 0], d: p.rollerDiameter, label: `Roller ⌀${mm(p.rollerDiameter)}`, angle: -45 * DEG },
      { kind: 'linear', a: [-w / 2, L], b: [w / 2, L], offset: 6 },
      { kind: 'note', text: `Stem ${mm(w)} wide (nominal ${mm(p.stemWidth)} − 2 × ${mm(ctx.clearances.slide)} slide clearance)  ·  Thickness ${mm(p.thickness)}` },
    ];
    g.spec = `Roller follower, roller ⌀${mm(p.rollerDiameter)}, stem ${mm(w)} × ${mm(L)} × ${mm(p.thickness)} mm`;
    return g;
  },
};

// ------------------------------------------------------------------ pulley / crank disc

const pulleyDef: PartDef = {
  kind: 'pulley',
  label: 'Pulley',
  category: 'Belts',
  description: 'Flanged belt pulley. The belt centre-line runs on the pitch diameter. Optional crank pin hole.',
  keywords: 'pulley belt sheave timing drive wheel',
  purchased: false,
  defaultMaterial: 'pla',
  params: [
    { key: 'pitchDiameter', label: 'Pitch diameter', type: 'length', default: 30, min: 4 },
    { key: 'beltWidth', label: 'Belt width', type: 'length', default: 6, min: 1 },
    { key: 'beltThickness', label: 'Belt thickness', type: 'length', default: 1.5, min: 0.2 },
    { key: 'flangeHeight', label: 'Flange height', type: 'length', default: 2, min: 0 },
    { key: 'flangeThickness', label: 'Flange thickness', type: 'length', default: 1.2, min: 0.2 },
    { key: 'boreDiameter', label: 'Bore diameter', type: 'length', default: 5, min: 0 },
    { key: 'pinRadius', label: 'Crank pin radius', type: 'length', default: 0, min: 0, help: 'Optional eccentric pin hole (crank throw). Stroke of a slider-crank = 2 × this radius. 0 = none.' },
    { key: 'pinDiameter', label: 'Crank pin diameter', type: 'length', default: 4, min: 0.5, when: (p) => p.pinRadius > 0 },
  ],
  build(p, ctx) {
    const rp = p.pitchDiameter / 2;
    const rc = Math.max(rp - p.beltThickness / 2, 1); // crown (belt seat)
    const rf = rc + p.beltThickness + p.flangeHeight;
    const tf = p.flangeThickness, bw = p.beltWidth + 2 * ctx.clearances.slide;
    const warnings: string[] = [];
    const errors: string[] = [];
    const holes: HoleFeature[] = [];
    const through: Poly[] = [];
    const ports: Port[] = [{ id: 'center', label: 'Axis', x: 0, y: 0, kind: 'center', d: p.boreDiameter, r: rp }];
    if (p.boreDiameter > 0) {
      const h = hole(0, 0, p.boreDiameter, ctx.clearances, 'bore');
      if (h.feat.d / 2 < rc - ctx.clearances.minFeature) { through.push(h.poly); holes.push(h.feat); }
      else errors.push('Bore is too large for the pulley; it was NOT cut.');
    }
    if (p.pinRadius > 0) {
      const h = hole(p.pinRadius, 0, p.pinDiameter, ctx.clearances, 'pin');
      if (p.pinRadius + h.feat.d / 2 < rc - ctx.clearances.minFeature && p.pinRadius - h.feat.d / 2 > (p.boreDiameter + ctx.clearances.hole) / 2 + ctx.clearances.minFeature) {
        through.push(h.poly); holes.push(h.feat);
        ports.push({ id: 'pin', label: 'Crank pin', x: p.pinRadius, y: 0, kind: 'hole', d: p.pinDiameter });
      } else errors.push(`Crank pin radius ${mm(p.pinRadius)} mm does not fit between the bore and the belt seat (R${mm(rc)}); the pin hole was NOT cut.`);
    }
    const layers: Layer[] = [
      { contours: [circlePoly(0, 0, rf), ...through], z0: 0, z1: tf },
      { contours: [circlePoly(0, 0, rc), ...through], z0: tf, z1: tf + bw },
      { contours: [circlePoly(0, 0, rf), ...through], z0: tf + bw, z1: 2 * tf + bw },
    ];
    const g = geom(layers, ports, { holes, warnings, errors, pitchRadius: rp });
    g.contactCircles = [{ x: 0, y: 0, r: rf }];
    g.dims = [
      { kind: 'diameter', c: [0, 0], d: rf * 2, label: `Flange ⌀${mm(rf * 2)}`, angle: 35 * DEG },
      { kind: 'diameter', c: [0, 0], d: rc * 2, label: `Belt seat ⌀${mm(rc * 2)}`, angle: -35 * DEG },
      { kind: 'note', text: `Pitch ⌀${mm(p.pitchDiameter)}  ·  Belt ${mm(p.beltWidth)} × ${mm(p.beltThickness)}  ·  Overall width ${mm(2 * tf + bw)}` },
    ];
    if (ports.length > 1) g.dims.push({ kind: 'linear', a: [0, 0], b: [p.pinRadius, 0], offset: -(rf + 6), label: `Throw ${mm(p.pinRadius)}` });
    g.spec = `Pulley pitch ⌀${mm(p.pitchDiameter)}, belt ${mm(p.beltWidth)} mm, bore ⌀${mm(p.boreDiameter + ctx.clearances.hole)}${p.pinRadius > 0 ? `, crank pin @ R${mm(p.pinRadius)}` : ''}`;
    return g;
  },
};

const crankDef: PartDef = {
  kind: 'crank',
  label: 'Crank disc',
  category: 'Linkage',
  description: 'Disc with a centre bore and one or more equally spaced crank-pin holes.',
  keywords: 'crank wheel disc flywheel eccentric throw',
  purchased: false,
  defaultMaterial: 'pla',
  params: [
    { key: 'diameter', label: 'Diameter', type: 'length', default: 44, min: 4 },
    { key: 'thickness', label: 'Thickness', type: 'length', default: 4, min: 0.2 },
    { key: 'boreDiameter', label: 'Bore diameter', type: 'length', default: 5, min: 0 },
    { key: 'pinRadius', label: 'Crank radius', type: 'length', default: 15, min: 0.5 },
    { key: 'pinCount', label: 'Pin holes', type: 'int', default: 1, min: 1, max: 12 },
    { key: 'pinDiameter', label: 'Pin diameter', type: 'length', default: 4, min: 0.5 },
  ],
  build(p, ctx) {
    const R = p.diameter / 2;
    const warnings: string[] = [];
    const errors: string[] = [];
    const contours: Poly[] = [circlePoly(0, 0, R)];
    const holes: HoleFeature[] = [];
    const ports: Port[] = [{ id: 'center', label: 'Axis', x: 0, y: 0, kind: 'center', d: p.boreDiameter, r: R }];
    if (p.boreDiameter > 0) { const h = hole(0, 0, p.boreDiameter, ctx.clearances, 'bore'); contours.push(h.poly); holes.push(h.feat); }
    const n = Math.max(1, Math.round(p.pinCount));
    const dPin = p.pinDiameter + ctx.clearances.hole;
    if (p.pinRadius + dPin / 2 > R - ctx.clearances.minFeature) errors.push(`Crank radius ${mm(p.pinRadius)} mm puts the pin hole through the rim of the ⌀${mm(p.diameter)} disc; the pin holes were NOT cut.`);
    if (p.pinRadius - dPin / 2 < (p.boreDiameter + ctx.clearances.hole) / 2 + ctx.clearances.minFeature) errors.push('Crank pin hole overlaps the bore; the pin holes were NOT cut.');
    const pinsFit = errors.length === 0;
    for (let i = 0; i < n; i++) {
      const a = (i / n) * 2 * Math.PI;
      const x = p.pinRadius * Math.cos(a), y = p.pinRadius * Math.sin(a);
      const h = hole(x, y, p.pinDiameter, ctx.clearances, `P${i + 1}`);
      if (pinsFit) { contours.push(h.poly); holes.push(h.feat); }
      ports.push({ id: `P${i + 1}`, label: `Crank pin ${i + 1}`, x, y, kind: 'hole', d: p.pinDiameter });
    }
    const g = geom([{ contours, z0: 0, z1: p.thickness }], ports, { holes, warnings, errors });
    g.contactCircles = [{ x: 0, y: 0, r: R }];
    g.dims = [
      { kind: 'diameter', c: [0, 0], d: p.diameter, angle: 40 * DEG },
      { kind: 'linear', a: [0, 0], b: [p.pinRadius, 0], offset: -(R + 6), label: `Throw ${mm(p.pinRadius)}` },
      { kind: 'note', text: `${n}× pin hole ⌀${mm(dPin)}  ·  Bore ⌀${mm(p.boreDiameter + ctx.clearances.hole)}  ·  Thickness ${mm(p.thickness)}` },
    ];
    g.spec = `Crank disc ⌀${mm(p.diameter)} × ${mm(p.thickness)} mm, ${n} pin(s) @ R${mm(p.pinRadius)}`;
    return g;
  },
};

// ------------------------------------------------------------------ rail / slider

const railDef: PartDef = {
  kind: 'rail',
  label: 'Slotted guide',
  category: 'Guides',
  description: 'Bar with a straight slot. A slider block or follower stem runs inside the slot (prismatic joint).',
  keywords: 'rail guide slot track linear slide way',
  purchased: false,
  defaultMaterial: 'pla',
  params: [
    { key: 'length', label: 'Travel length', type: 'length', default: 80, min: 2 },
    { key: 'slotWidth', label: 'Slot width', type: 'length', default: 10, min: 1 },
    { key: 'width', label: 'Bar width', type: 'length', default: 22, min: 3 },
    { key: 'overtravel', label: 'Slot end allowance', type: 'length', default: 12, min: 0, help: 'Extra slot beyond each end of the travel length (≈ half the slider length).' },
    { key: 'thickness', label: 'Thickness', type: 'length', default: 5, min: 0.2 },
    { key: 'openEnds', label: 'Open-ended channel', type: 'bool', default: false, help: 'Two guide bars joined by a strap on top instead of a closed slot, so a long stem can pass through both ends.' },
  ],
  build(p, ctx) {
    const L = p.length, e = p.overtravel, sw = p.slotWidth, w = Math.max(p.width, sw + 2 * ctx.clearances.minFeature + 0.01);
    if (p.openEnds) {
      const bar = (w - sw) / 2;
      const r = Math.min(1.5, bar / 3);
      const top = roundedRect(-e, sw / 2, L + e, w / 2, r), bot = roundedRect(-e, -w / 2, L + e, -sw / 2, r);
      const portsO: Port[] = [
        { id: 'start', label: 'Travel start', x: 0, y: 0, kind: 'point', axis: 0 },
        { id: 'mid', label: 'Travel middle', x: L / 2, y: 0, kind: 'point', axis: 0 },
        { id: 'end', label: 'Travel end', x: L, y: 0, kind: 'point', axis: 0 },
      ];
      // the two bars are joined by a strap across the top so the guide is one printable body (the stem runs underneath)
      const capT = Math.max(1.5, 1.5 * ctx.clearances.minFeature);
      const cap = roundedRect(-e, -w / 2, L + e, w / 2, r);
      const go = geom([{ contours: [top, bot], z0: 0, z1: p.thickness }, { contours: [cap], z0: p.thickness, z1: p.thickness + capT }], portsO);
      go.contactPoints = hullPoints(go.layers);
      go.dims = [
        { kind: 'linear', a: [-e, -w / 2], b: [L + e, -w / 2], offset: -8 },
        { kind: 'linear', a: [-e, -w / 2], b: [-e, w / 2], offset: -8 },
        { kind: 'linear', a: [L + e, -sw / 2], b: [L + e, sw / 2], offset: 8, label: `Channel ${mm(sw)}` },
        { kind: 'note', text: `Two bars ${mm(bar)} wide × ${mm(p.thickness)} high, joined by a ${mm(capT)} mm strap on top` },
      ];
      go.spec = `Open guide channel ${mm(L + 2 * e)} × ${mm(w)} × ${mm(p.thickness)} mm, channel ${mm(sw)} mm`;
      return go;
    }
    const margin = (w - sw) / 2;
    const warnings: string[] = [];
    if (p.width < sw + 2 * ctx.clearances.minFeature) warnings.push('Bar is too narrow for the slot; width was increased to keep a printable wall.');
    const outer = roundedRect(-e - margin, -w / 2, L + e + margin, w / 2, Math.min(3, margin));
    const slot = reversed(roundedRect(-e, -sw / 2, L + e, sw / 2, Math.min(1, sw / 4)));
    const ports: Port[] = [
      { id: 'start', label: 'Travel start', x: 0, y: 0, kind: 'point', axis: 0 },
      { id: 'mid', label: 'Travel middle', x: L / 2, y: 0, kind: 'point', axis: 0 },
      { id: 'end', label: 'Travel end', x: L, y: 0, kind: 'point', axis: 0 },
    ];
    const g = geom([{ contours: [outer, slot], z0: 0, z1: p.thickness }], ports, { warnings });
    g.contactPoints = hullPoints(g.layers);
    g.dims = [
      { kind: 'linear', a: [-e - margin, -w / 2], b: [L + e + margin, -w / 2], offset: -8 },
      { kind: 'linear', a: [-e, sw / 2], b: [L + e, sw / 2], offset: (w - sw) / 2 + 8, label: `Slot ${mm(L + 2 * e)}` },
      { kind: 'linear', a: [-e - margin, -w / 2], b: [-e - margin, w / 2], offset: -8 },
      { kind: 'note', text: `Slot width ${mm(sw)}  ·  Thickness ${mm(p.thickness)}` },
    ];
    g.spec = `Slotted guide ${mm(L + 2 * e + 2 * margin)} × ${mm(w)} × ${mm(p.thickness)} mm, slot ${mm(sw)} mm`;
    return g;
  },
};

const sliderDef: PartDef = {
  kind: 'slider',
  label: 'Slider block',
  category: 'Guides',
  description: 'Block that runs in a slotted guide. The modelled width is the nominal slot width minus the slide clearance on each side.',
  keywords: 'slider block piston carriage crosshead shoe',
  purchased: false,
  defaultMaterial: 'pla',
  params: [
    { key: 'length', label: 'Length', type: 'length', default: 20, min: 2 },
    { key: 'width', label: 'Nominal width (slot)', type: 'length', default: 10, min: 1 },
    { key: 'thickness', label: 'Thickness', type: 'length', default: 5, min: 0.2 },
    { key: 'holeDiameter', label: 'Pin diameter', type: 'length', default: 4, min: 0 },
  ],
  build(p, ctx) {
    const l = p.length, w = Math.max(p.width - 2 * ctx.clearances.slide, 0.2);
    const contours: Poly[] = [roundedRect(-l / 2, -w / 2, l / 2, w / 2, Math.min(1, w / 4))];
    const holes: HoleFeature[] = [];
    const warnings: string[] = [];
    const errors: string[] = [];
    if (p.width - 2 * ctx.clearances.slide < ctx.clearances.minFeature) errors.push(`Slider width ${mm(p.width)} mm minus 2 × ${mm(ctx.clearances.slide)} mm slide clearance leaves ${mm(Math.max(p.width - 2 * ctx.clearances.slide, 0))} mm, below the minimum feature size (${mm(ctx.clearances.minFeature)} mm).`);
    if (p.holeDiameter > 0) {
      const h = hole(0, 0, p.holeDiameter, ctx.clearances, 'pin');
      if (h.feat.d < w - 2 * ctx.clearances.minFeature) { contours.push(h.poly); holes.push(h.feat); }
      else errors.push('Pin hole leaves less than the minimum wall in the slider; it was NOT cut.');
    }
    const g = geom([{ contours, z0: 0, z1: p.thickness }], [
      { id: 'pin', label: 'Pin hole', x: 0, y: 0, kind: 'hole', d: p.holeDiameter, axis: 0 },
    ], { holes, warnings, errors });
    g.contactPoints = hullPoints(g.layers);
    g.dims = [
      { kind: 'linear', a: [-l / 2, -w / 2], b: [l / 2, -w / 2], offset: -6 },
      { kind: 'linear', a: [-l / 2, -w / 2], b: [-l / 2, w / 2], offset: -6 },
      { kind: 'note', text: `Width = ${mm(p.width)} − 2 × ${mm(ctx.clearances.slide)} clearance  ·  Thickness ${mm(p.thickness)}` },
    ];
    if (holes.length) g.dims.push({ kind: 'diameter', c: [0, 0], d: holes[0].d });
    g.spec = `Slider block ${mm(l)} × ${mm(w)} × ${mm(p.thickness)} mm`;
    return g;
  },
};

// ------------------------------------------------------------------ plates

const baseplateDef: PartDef = {
  kind: 'baseplate',
  label: 'Base plate',
  category: 'Structure',
  description: 'Rectangular plate with an editable hole pattern: frames, chassis, ground links.',
  keywords: 'plate frame chassis base ground bracket panel body',
  purchased: false,
  defaultMaterial: 'pla',
  params: [
    { key: 'width', label: 'Width (X)', type: 'length', default: 120, min: 2 },
    { key: 'height', label: 'Height (Y)', type: 'length', default: 60, min: 2 },
    { key: 'thickness', label: 'Thickness', type: 'length', default: 4, min: 0.2 },
    { key: 'cornerRadius', label: 'Corner radius', type: 'length', default: 4, min: 0 },
    { key: 'holes', label: 'Holes', type: 'holes', default: [{ x: -40, y: 0, d: 4 }, { x: 40, y: 0, d: 4 }] as PlateHole[] },
  ],
  build(p, ctx) {
    const w = p.width, h = p.height;
    const contours: Poly[] = [roundedRect(-w / 2, -h / 2, w / 2, h / 2, p.cornerRadius)];
    const holes: HoleFeature[] = [];
    const ports: Port[] = [{ id: 'center', label: 'Centre', x: 0, y: 0, kind: 'point' }];
    const warnings: string[] = [];
    const errors: string[] = [];
    const outer = contours[0];
    (p.holes as PlateHole[] ?? []).forEach((hh, i) => {
      const hf = hole(hh.x, hh.y, hh.d, ctx.clearances, `H${i + 1}`);
      // the whole hole (with a minimum wall) must lie inside the outline, rounded corners included
      const rr = hf.feat.d / 2 + ctx.clearances.minFeature * 0.5;
      let inside = pointInPoly(hh.x, hh.y, outer);
      for (let k = 0; k < 24 && inside; k++) { const a = (k / 24) * 2 * Math.PI; inside = pointInPoly(hh.x + rr * Math.cos(a), hh.y + rr * Math.sin(a), outer); }
      if (inside && hh.d > 0) { contours.push(hf.poly); holes.push(hf.feat); }
      else if (hh.d > 0) errors.push(`Hole H${i + 1} (⌀${mm(hf.feat.d)} at ${mm(hh.x)}, ${mm(hh.y)}) breaks through or lies outside the plate outline, so it was NOT cut. Move it inward or enlarge the plate.`);
      ports.push({ id: `H${i + 1}`, label: `Hole H${i + 1}`, x: hh.x, y: hh.y, kind: 'hole', d: hh.d });
    });
    for (let i = 0; i < holes.length; i++) for (let k = i + 1; k < holes.length; k++) {
      const dist = Math.hypot(holes[i].x - holes[k].x, holes[i].y - holes[k].y);
      const touch = (holes[i].d + holes[k].d) / 2;
      if (dist < touch) warnings.push(`Holes ${holes[i].label} and ${holes[k].label} overlap (centres ${mm(dist)} mm apart, diameters ${mm(holes[i].d)} and ${mm(holes[k].d)} mm): they merge into one opening.`);
      else if (dist < touch + ctx.clearances.minFeature) warnings.push(`The wall between holes ${holes[i].label} and ${holes[k].label} is ${mm(dist - touch)} mm, thinner than the minimum feature size (${mm(ctx.clearances.minFeature)} mm).`);
    }
    const g = geom([{ contours, z0: 0, z1: p.thickness }], ports, { holes, warnings, errors });
    g.contactPoints = hullPoints(g.layers);
    g.dims = [
      { kind: 'linear', a: [-w / 2, -h / 2], b: [w / 2, -h / 2], offset: -8 },
      { kind: 'linear', a: [-w / 2, -h / 2], b: [-w / 2, h / 2], offset: -8 },
      { kind: 'note', text: `Thickness ${mm(p.thickness)}  ·  ${holes.length} hole(s), positions from plate centre` },
    ];
    g.spec = `Plate ${mm(w)} × ${mm(h)} × ${mm(p.thickness)} mm, ${holes.length} hole(s)`;
    return g;
  },
};

const plateDef: PartDef = {
  kind: 'plate',
  label: 'Sketched part',
  category: 'Structure',
  description: 'Extrusion of a closed sketch profile. Inner loops and circles become cuts/holes; circle centres become joint anchors.',
  keywords: 'sketch extrude custom profile cut hole plate',
  purchased: false,
  defaultMaterial: 'pla',
  params: [
    { key: 'sketchId', label: 'Sketch', type: 'sketch', default: '' },
    { key: 'thickness', label: 'Extrusion depth', type: 'length', default: 4, min: 0.2 },
  ],
  build(p, ctx) {
    const sk = ctx.sketches.find((s) => s.id === p.sketchId);
    const warnings: string[] = [];
    if (!sk) {
      const g = geom([], [], { warnings: ['No sketch is linked to this part.'] });
      g.spec = 'Sketched part (missing sketch)';
      return g;
    }
    const prof = extractProfiles(sk);
    warnings.push(...prof.problems);
    if (prof.openEntities.length) warnings.push(`${prof.openEntities.length} sketch entit${prof.openEntities.length === 1 ? 'y is' : 'ies are'} not part of a closed loop and ${prof.openEntities.length === 1 ? 'was' : 'were'} ignored.`);
    if (!prof.regions.length) warnings.push('Sketch has no closed profile to extrude.');
    const contours: Poly[] = [];
    const holes: HoleFeature[] = [];
    const ports: Port[] = [];
    let hi = 0;
    for (const r of prof.regions) {
      contours.push(r.outer.points as Poly);
      for (const h of r.holes) {
        contours.push(reversed(h.points as Poly));
        if (h.circle) {
          hi++;
          holes.push({ x: h.circle.cx, y: h.circle.cy, d: h.circle.r * 2, nominal: h.circle.r * 2, label: `H${hi}` });
          ports.push({ id: h.circle.entityId, label: `Hole H${hi} (⌀${mm(h.circle.r * 2)})`, x: h.circle.cx, y: h.circle.cy, kind: 'hole', d: h.circle.r * 2 });
        }
      }
    }
    // every sketch point is available as an anchor
    for (const pt of sk.points) {
      if (!ports.some((q) => Math.hypot(q.x - pt.x, q.y - pt.y) < 1e-6)) {
        ports.push({ id: `pt:${pt.id}`, label: `Sketch point ${pt.id}`, x: pt.x, y: pt.y, kind: 'point' });
      }
    }
    const g = geom(contours.length ? [{ contours, z0: 0, z1: p.thickness }] : [], ports, { holes, warnings });
    g.contactPoints = hullPoints(g.layers);
    if (contours.length) {
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (const c of contours) for (const [x, y] of c) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
      g.dims = [
        { kind: 'linear', a: [x0, y0], b: [x1, y0], offset: -8 },
        { kind: 'linear', a: [x0, y0], b: [x0, y1], offset: -8 },
        { kind: 'note', text: `Thickness ${mm(p.thickness)}  ·  from sketch "${sk.name}"` },
      ];
      g.spec = `Sketched part "${sk.name}" ${mm(x1 - x0)} × ${mm(y1 - y0)} × ${mm(p.thickness)} mm`;
    } else g.spec = `Sketched part "${sk.name}" (no closed profile)`;
    return g;
  },
};

// ------------------------------------------------------------------ hardware

const HEX: Record<string, { af: number; k: number }> = {
  '2': { af: 4, k: 1.4 }, '2.5': { af: 5, k: 1.7 }, '3': { af: 5.5, k: 2 }, '4': { af: 7, k: 2.8 },
  '5': { af: 8, k: 3.5 }, '6': { af: 10, k: 4 }, '8': { af: 13, k: 5.3 }, '10': { af: 16, k: 6.4 },
};

function hexPoly(af: number): Poly {
  const R = af / Math.sqrt(3);
  const out: Poly = [];
  for (let i = 0; i < 6; i++) { const a = (i / 6) * 2 * Math.PI + Math.PI / 6; out.push([R * Math.cos(a), R * Math.sin(a)]); }
  return out;
}

const fastenerDef: PartDef = {
  kind: 'fastener',
  label: 'Fastener',
  category: 'Hardware',
  description: 'Metric hex bolt, socket screw, nut, washer or dowel pin (envelope geometry, no thread).',
  keywords: 'bolt screw nut washer pin dowel M3 M4 M5 hardware',
  purchased: true,
  defaultMaterial: 'steel',
  params: [
    { key: 'type', label: 'Type', type: 'enum', default: 'hex-bolt', options: [
      { value: 'hex-bolt', label: 'Hex bolt' }, { value: 'socket-screw', label: 'Socket head screw' },
      { value: 'nut', label: 'Hex nut' }, { value: 'washer', label: 'Washer' }, { value: 'pin', label: 'Dowel pin' }] },
    { key: 'size', label: 'Thread / pin diameter', type: 'length', default: 4, min: 1 },
    { key: 'length', label: 'Length', type: 'length', default: 16, min: 1, when: (p) => p.type === 'hex-bolt' || p.type === 'socket-screw' || p.type === 'pin' },
  ],
  build(p) {
    const d = p.size, key = String(Math.round(d * 2) / 2);
    const hx = HEX[key] ?? { af: d * 1.7, k: d * 0.7 };
    const layers: Layer[] = [];
    let spec = '';
    let rOut = d / 2;
    if (p.type === 'hex-bolt') {
      layers.push({ contours: [circlePoly(0, 0, d / 2)], z0: 0, z1: p.length, look: 'steel' }, { contours: [hexPoly(hx.af)], z0: p.length, z1: p.length + hx.k, look: 'steel' });
      rOut = hx.af / Math.sqrt(3); spec = `Hex bolt M${mm(d)} × ${mm(p.length)}`;
    } else if (p.type === 'socket-screw') {
      layers.push({ contours: [circlePoly(0, 0, d / 2)], z0: 0, z1: p.length, look: 'dark' }, { contours: [circlePoly(0, 0, d * 0.75), reversed(hexPoly(d * 0.8))], z0: p.length, z1: p.length + d, look: 'dark' });
      rOut = d * 0.75; spec = `Socket head cap screw M${mm(d)} × ${mm(p.length)}`;
    } else if (p.type === 'nut') {
      layers.push({ contours: [hexPoly(hx.af), circlePoly(0, 0, d / 2, true)], z0: 0, z1: d * 0.8, look: 'steel' });
      rOut = hx.af / Math.sqrt(3); spec = `Hex nut M${mm(d)}`;
    } else if (p.type === 'washer') {
      layers.push({ contours: [circlePoly(0, 0, d * 1.1), circlePoly(0, 0, d / 2 + 0.15, true)], z0: 0, z1: Math.max(0.5, d * 0.2), look: 'steel' });
      rOut = d * 1.1; spec = `Washer M${mm(d)}`;
    } else {
      layers.push({ contours: [circlePoly(0, 0, d / 2)], z0: 0, z1: p.length, look: 'steel' });
      spec = `Dowel pin ⌀${mm(d)} × ${mm(p.length)}`;
    }
    const g = geom(layers, [{ id: 'center', label: 'Axis', x: 0, y: 0, kind: 'pin', d }]);
    g.contactCircles = [{ x: 0, y: 0, r: rOut }];
    g.spec = spec;
    return g;
  },
};

const motorDef: PartDef = {
  kind: 'motor',
  label: 'Motor body',
  category: 'Actuators',
  description: 'Motor housing with output shaft (NEMA-style square or round can). Mount it rigidly; the drive itself is the motor setting on a revolute joint.',
  keywords: 'motor stepper servo gearmotor actuator drive nema',
  purchased: true,
  defaultMaterial: 'motor',
  params: [
    { key: 'shape', label: 'Housing', type: 'enum', default: 'square', options: [{ value: 'square', label: 'Square (NEMA style)' }, { value: 'round', label: 'Round can' }] },
    { key: 'size', label: 'Frame size', type: 'length', default: 42.3, min: 5 },
    { key: 'bodyLength', label: 'Body length', type: 'length', default: 40, min: 2 },
    { key: 'shaftDiameter', label: 'Shaft diameter', type: 'length', default: 5, min: 0.5 },
    { key: 'shaftLength', label: 'Shaft length', type: 'length', default: 24, min: 1 },
    { key: 'mass', label: 'Mass', type: 'mass', default: 0.28, min: 0, help: 'Catalogue mass of the motor; used instead of density × volume.' },
  ],
  build(p) {
    const s = p.size;
    const body = p.shape === 'round' ? circlePoly(0, 0, s / 2) : roundedRect(-s / 2, -s / 2, s / 2, s / 2, s * 0.09);
    const boss = Math.min(s * 0.26, s / 2 - 1);
    // local z = 0 is the mounting face (top of the pilot boss); the shaft projects above it
    const layers: Layer[] = [
      { contours: [body], z0: -p.bodyLength - 2, z1: -2, look: 'dark' },
      { contours: [circlePoly(0, 0, boss)], z0: -2, z1: 0, look: 'steel' },
      { contours: [circlePoly(0, 0, p.shaftDiameter / 2)], z0: 0, z1: Math.max(p.shaftLength, 0.5), look: 'steel' },
    ];
    const g = geom(layers, [{ id: 'shaft', label: 'Shaft axis', x: 0, y: 0, kind: 'center', d: p.shaftDiameter }]);
    g.contactPoints = hullPoints([layers[0]]);
    g.spec = `Motor, ${p.shape === 'round' ? '⌀' : '□'}${mm(s)} × ${mm(p.bodyLength)} mm, shaft ⌀${mm(p.shaftDiameter)}`;
    return g;
  },
};

export const PART_DEFS: Record<Part['kind'], PartDef> = {
  link: linkDef, gear: gearDef, rack: rackDef, shaft: shaftDef, bearing: bearingDef, cam: camDef,
  follower: followerDef, pulley: pulleyDef, crank: crankDef, rail: railDef, slider: sliderDef,
  baseplate: baseplateDef, plate: plateDef, fastener: fastenerDef, motor: motorDef,
};

export function defaultParams(kind: Part['kind']): Record<string, any> {
  const out: Record<string, any> = {};
  for (const d of PART_DEFS[kind].params) out[d.key] = structuredClone(d.default);
  return out;
}

const cache = new WeakMap<object, Map<string, PartGeometry>>();

/** Build (memoised on params object identity + clearances) the geometry of a part. */
export function partGeometry(part: Part, ctx: BuildContext): PartGeometry {
  const def = PART_DEFS[part.kind];
  let m = cache.get(part.params);
  const sk = part.kind === 'plate' ? ctx.sketches.find((s) => s.id === part.params.sketchId) : undefined;
  if (!m) { m = new Map(); cache.set(part.params, m); }
  const key = `${ctx.clearances.hole}|${ctx.clearances.slide}|${ctx.clearances.backlash}|${ctx.clearances.minFeature}`;
  let g = m.get(key);
  if (g && part.kind === 'plate' && (g as any).__sketch !== sk) g = undefined;
  if (!g) {
    const full = { ...defaultParams(part.kind), ...part.params };
    g = def.build(full, ctx);
    (g as any).__sketch = sk;
    m.set(key, g);
  }
  return g;
}

export function findPort(g: PartGeometry, id: string | undefined): Port | undefined {
  if (!id) return undefined;
  return g.ports.find((p) => p.id === id);
}
