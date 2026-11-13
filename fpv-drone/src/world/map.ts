/**
 * The flying site. One description drives both the collision world (physics)
 * and the scenery (rendering), so what you see is exactly what you can hit.
 *
 * Layout (metres; north = -Z, east = +X):
 *   - launch pad at the origin, pilot standing 4 m behind it, access road to the south
 *   - race circuit of nine timing gates north-east of the pad
 *   - football pitch with two goals to the north-west
 *   - derelict three-storey concrete frame ("bando") to the east
 *   - container yard, open barn, silos, radio mast, scattered big trees
 *   - tree line and hills around the field
 */
import { CollisionWorld, GateDef, Heightfield } from '../sim/world';
import { Rng, DEG2RAD } from '../sim/math';

export type MatId =
  | 'concrete' | 'concreteDark' | 'asphalt' | 'containerRed' | 'containerBlue' | 'containerGreen'
  | 'containerRust' | 'steel' | 'galvanized' | 'wood' | 'woodDark' | 'gateOrange' | 'gateBlue'
  | 'white' | 'roofMetal' | 'mastRed' | 'mastWhite' | 'rubber';

export interface BoxPrim {
  x: number; y: number; z: number;
  sx: number; sy: number; sz: number;
  yaw: number;
  mat: MatId;
}

export interface CylPrim {
  /** Base centre. */
  x: number; y: number; z: number;
  r: number;
  h: number;
  mat: MatId;
}

export interface TreeDef {
  x: number; y: number; z: number;
  height: number;
  canopyR: number;
  trunkR: number;
  kind: 'broadleaf' | 'pine';
  seed: number;
}

export interface GateVisual extends GateDef {
  index: number;
  /** Height of the bottom of the opening above ground. */
  base: number;
}

export interface FlagDef {
  x: number; z: number;
  height: number;
  color: number;
}

export interface Decal {
  kind: 'pad' | 'road' | 'pitch' | 'lot';
  x: number; z: number;
  sx: number; sz: number;
  yaw: number;
}

export interface MapData {
  terrain: Heightfield;
  collision: CollisionWorld;
  boxes: BoxPrim[];
  cyls: CylPrim[];
  trees: TreeDef[];
  gates: GateVisual[];
  flags: FlagDef[];
  decals: Decal[];
  spawn: { x: number; z: number; heading: number };
  /** Alternative starting spots (the first is the launch pad). */
  spawns: { id: string; name: string; x: number; z: number; heading: number }[];
  pilot: { x: number; y: number; z: number };
  windsock: { x: number; z: number; height: number };
}

export const GATE_WIDTH = 2.4;
export const GATE_HEIGHT = 1.8;
export const GATE_TUBE = 0.14;

/* ------------------------------------------------------------------ noise */

function hash2(ix: number, iz: number): number {
  let h = Math.imul(ix, 374761393) ^ Math.imul(iz, 668265263);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

function valueNoise(x: number, z: number): number {
  const ix = Math.floor(x), iz = Math.floor(z);
  const fx = x - ix, fz = z - iz;
  const ux = fx * fx * (3 - 2 * fx), uz = fz * fz * (3 - 2 * fz);
  const a = hash2(ix, iz), b = hash2(ix + 1, iz), c = hash2(ix, iz + 1), d = hash2(ix + 1, iz + 1);
  return a + (b - a) * ux + (c - a) * uz + (a - b - c + d) * ux * uz;
}

function fbm(x: number, z: number, oct: number): number {
  let v = 0, amp = 0.5, f = 1;
  for (let i = 0; i < oct; i++) {
    v += amp * valueNoise(x * f, z * f);
    f *= 2.03;
    amp *= 0.5;
  }
  return v;
}

function sstep(a: number, b: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

/** The flying field is dead flat; rolling hills start beyond the tree line. */
export function terrainHeight(x: number, z: number): number {
  const r = Math.hypot(x, z);
  if (r < 250) return 0;
  const near = sstep(250, 520, r);
  const far = sstep(650, 1350, r);
  const hills = fbm(x / 180 + 11.3, z / 180 - 4.7, 4);
  const ridge = 1 - Math.abs(2 * fbm(x / 520 - 3.1, z / 520 + 8.2, 4) - 1);
  return near * (hills * 34) + far * (ridge * ridge * 190 + hills * 40);
}

/* ---------------------------------------------------------------- builder */

export function buildMap(): MapData {
  const terrain = new Heightfield(3600, 360, terrainHeight);
  const collision = new CollisionWorld(terrain);
  const boxes: BoxPrim[] = [];
  const cyls: CylPrim[] = [];
  const trees: TreeDef[] = [];
  const gates: GateVisual[] = [];
  const flags: FlagDef[] = [];
  const decals: Decal[] = [];
  const rng = new Rng(20240611);

  const box = (x: number, y: number, z: number, sx: number, sy: number, sz: number, mat: MatId, yaw = 0, collide = true) => {
    boxes.push({ x, y, z, sx, sy, sz, yaw, mat });
    if (collide) collision.addBox(x, y, z, sx, sy, sz, yaw);
  };
  const cyl = (x: number, y: number, z: number, r: number, h: number, mat: MatId, collide = true) => {
    cyls.push({ x, y, z, r, h, mat });
    if (collide) collision.addCylinder(x, y, z, r, h);
  };
  /** Box given in a local frame rotated by `yaw` about the point (ox, oz). */
  const boxAt = (ox: number, oz: number, yaw: number, lx: number, y: number, lz: number, sx: number, sy: number, sz: number, mat: MatId) => {
    const c = Math.cos(yaw), s = Math.sin(yaw);
    box(ox + lx * c + lz * s, y, oz - lx * s + lz * c, sx, sy, sz, mat, yaw);
  };

  /* ---- launch area ---------------------------------------------------------- */
  decals.push({ kind: 'pad', x: 0, z: 0, sx: 3, sz: 3, yaw: 0 });
  decals.push({ kind: 'road', x: 0, z: 22, sx: 420, sz: 6.5, yaw: 0 });
  decals.push({ kind: 'lot', x: -4, z: 12.5, sx: 30, sz: 12.5, yaw: 0 });
  // Low kerbs around the car park.
  box(-4, 0.07, 6.2, 30, 0.14, 0.18, 'concrete');
  // Light poles along the road.
  for (let x = -180; x <= 180; x += 45) {
    cyl(x, 0, 26.6, 0.09, 8, 'galvanized');
    box(x, 7.95, 25.7, 0.12, 0.1, 1.9, 'galvanized', 0, false);
    box(x, 7.9, 24.7, 0.3, 0.08, 0.6, 'steel', 0, false);
  }
  // Post-and-rail fence between the field and the road.
  for (let x = -200; x <= 200; x += 2.5) {
    if (x > -20 && x < 12) continue; // gap at the car park
    box(x, 0.55, 17.6, 0.1, 1.1, 0.1, 'wood');
  }
  for (const [x0, x1] of [[-200, -20], [12, 200]] as const) {
    const len = x1 - x0;
    box((x0 + x1) / 2, 0.95, 17.6, len, 0.09, 0.04, 'wood');
    box((x0 + x1) / 2, 0.5, 17.6, len, 0.09, 0.04, 'wood');
  }
  // Pilot's bench and a folding table.
  box(1.6, 0.22, 4.9, 1.5, 0.05, 0.4, 'wood');
  box(0.95, 0.11, 4.9, 0.06, 0.22, 0.36, 'woodDark');
  box(2.25, 0.11, 4.9, 0.06, 0.22, 0.36, 'woodDark');
  box(-1.7, 0.72, 4.6, 1.2, 0.04, 0.7, 'white');
  for (const [dx, dz] of [[-0.55, -0.3], [0.55, -0.3], [-0.55, 0.3], [0.55, 0.3]]) {
    box(-1.7 + dx, 0.35, 4.6 + dz, 0.035, 0.7, 0.035, 'galvanized', 0, false);
  }

  /* ---- race circuit --------------------------------------------------------- */
  const course: [number, number, number, number][] = [
    // x, z, heading (deg), base height of the opening
    [0, -26, 0, 0],
    [0, -66, 0, 0],
    [22, -100, 62, 0],
    [60, -104, 108, 2.6],
    [84, -78, 178, 0],
    [78, -44, 192, 0],
    [62, -12, 245, 0],
    [28, -3, 278, 0],
    [4, -8, 318, 0],
  ];
  course.forEach(([x, z, hdg, base], index) => {
    const heading = hdg * DEG2RAD;
    const g: GateVisual = {
      index, x, z, y: base + GATE_TUBE + GATE_HEIGHT / 2, heading,
      width: GATE_WIDTH, height: GATE_HEIGHT, base,
    };
    gates.push(g);
    // three.js yaw that turns local -Z onto the gate's travel direction.
    const yaw = -heading;
    const t = GATE_TUBE;
    const halfW = GATE_WIDTH / 2 + t / 2;
    const mat: MatId = index === 0 ? 'gateBlue' : 'gateOrange';
    const add = (lx: number, y: number, sx: number, sy: number) => {
      const c = Math.cos(yaw), s = Math.sin(yaw);
      boxes.push({ x: x + lx * c, y, z: z - lx * s, sx, sy, sz: t, yaw, mat });
      collision.addBox(x + lx * c, y, z - lx * s, sx, sy, t, yaw);
    };
    const top = base + t + GATE_HEIGHT;
    add(-halfW, (top + t) / 2, t, top + t); // left upright (down to the ground)
    add(halfW, (top + t) / 2, t, top + t); // right upright
    add(0, top + t / 2, GATE_WIDTH + 2 * t, t); // top bar
    add(0, base + t / 2, GATE_WIDTH + 2 * t, t); // bottom bar
    if (base > 0) {
      // Raised gate: cross-brace below the opening.
      add(0, base * 0.45, GATE_WIDTH + 2 * t, t * 0.6);
    }
  });
  // Feather flags marking the corners.
  const flagSpots: [number, number, number][] = [
    [8, -106, 0xd32f2f], [70, -112, 0xd32f2f], [93, -84, 0xfbc02d], [88, -40, 0xd32f2f],
    [70, -4, 0xfbc02d], [30, 4, 0xd32f2f], [-5, -2, 0x1976d2], [-6, -70, 0xfbc02d],
  ];
  for (const [x, z, color] of flagSpots) {
    flags.push({ x, z, height: 3.6, color });
    collision.addCylinder(x, 0, z, 0.03, 3.6);
  }

  /* ---- football pitch ------------------------------------------------------- */
  const pitchX = -75, pitchZ = -60, pitchYaw = 0;
  decals.push({ kind: 'pitch', x: pitchX, z: pitchZ, sx: 64, sz: 100, yaw: pitchYaw });
  for (const end of [-1, 1]) {
    const gz = pitchZ + end * 50;
    const postR = 0.06, gw = 7.32, gh = 2.44;
    cyl(pitchX - gw / 2, 0, gz, postR, gh, 'white');
    cyl(pitchX + gw / 2, 0, gz, postR, gh, 'white');
    box(pitchX, gh + postR, gz, gw + 2 * postR, 2 * postR, 2 * postR, 'white');
    // Back stanchions.
    box(pitchX - gw / 2, gh / 2, gz + end * 1.6, 0.04, gh, 0.04, 'galvanized');
    box(pitchX + gw / 2, gh / 2, gz + end * 1.6, 0.04, gh, 0.04, 'galvanized');
    box(pitchX - gw / 2, gh, gz + end * 0.8, 0.04, 0.04, 1.6, 'galvanized');
    box(pitchX + gw / 2, gh, gz + end * 0.8, 0.04, 0.04, 1.6, 'galvanized');
    box(pitchX, gh, gz + end * 1.6, gw, 0.04, 0.04, 'galvanized');
  }

  /* ---- the bando: three-storey concrete frame -------------------------------- */
  {
    const ox = 150, oz = -52, yaw = 12 * DEG2RAD;
    const L = 36, W = 16, floorH = 3.6, slab = 0.28;
    // Slabs (ground slab barely proud of the grass).
    boxAt(ox, oz, yaw, 0, 0.05, 0, L + 1, 0.1, W + 1, 'concreteDark');
    for (let f = 1; f <= 3; f++) {
      const y = f * floorH - slab / 2;
      if (f === 2) {
        // Second floor has a collapsed bay: leave a 6 x 8 m hole to dive through.
        boxAt(ox, oz, yaw, -9, y, 0, 18, slab, W, 'concrete');
        boxAt(ox, oz, yaw, 12, y, 0, 12, slab, W, 'concrete');
        boxAt(ox, oz, yaw, 3, y, -4, 6, slab, 8, 'concrete');
      } else {
        boxAt(ox, oz, yaw, 0, y, 0, L, slab, W, 'concrete');
      }
    }
    // Columns on a 6 x 8 m grid.
    for (let i = 0; i <= 6; i++) {
      for (let j = 0; j <= 2; j++) {
        const lx = -L / 2 + i * 6, lz = -W / 2 + j * 8;
        boxAt(ox, oz, yaw, lx, (3 * floorH) / 2, lz, 0.5, 3 * floorH, 0.5, 'concrete');
      }
    }
    // Edge beams.
    for (let f = 1; f <= 3; f++) {
      const y = f * floorH - slab - 0.2;
      boxAt(ox, oz, yaw, 0, y, -W / 2, L, 0.4, 0.3, 'concrete');
      boxAt(ox, oz, yaw, 0, y, W / 2, L, 0.4, 0.3, 'concrete');
    }
    // North wall: infill panels with window openings on the upper floors.
    for (let f = 0; f < 3; f++) {
      const y0 = f * floorH;
      for (let i = 0; i < 6; i++) {
        const lx = -L / 2 + 3 + i * 6;
        if (f === 0 && (i === 1 || i === 4)) continue; // open bays at ground level
        if ((i + f) % 3 === 2) continue; // missing panels
        // Sill, lintel and two piers leave a 2.6 x 1.5 m window.
        boxAt(ox, oz, yaw, lx, y0 + 0.45, -W / 2, 5.5, 0.9, 0.2, 'concreteDark');
        boxAt(ox, oz, yaw, lx, y0 + 2.86, -W / 2, 5.5, 0.92, 0.2, 'concreteDark');
        boxAt(ox, oz, yaw, lx - 2.05, y0 + 1.65, -W / 2, 1.4, 1.5, 0.2, 'concreteDark');
        boxAt(ox, oz, yaw, lx + 2.05, y0 + 1.65, -W / 2, 1.4, 1.5, 0.2, 'concreteDark');
      }
    }
    // Stair core at the west end.
    boxAt(ox, oz, yaw, -L / 2 + 1.6, (3 * floorH + 2.4) / 2, 4.6, 3.0, 3 * floorH + 2.4, 0.22, 'concreteDark');
    boxAt(ox, oz, yaw, -L / 2 + 0.11, (3 * floorH + 2.4) / 2, 6.2, 0.22, 3 * floorH + 2.4, 3.2, 'concreteDark');
    boxAt(ox, oz, yaw, -L / 2 + 1.6, 3 * floorH + 2.5, 6.2, 3.2, 0.2, 3.4, 'concrete');
    // Parapet stubs on the roof.
    boxAt(ox, oz, yaw, 0, 3 * floorH + 0.35, -W / 2 + 0.1, L, 0.7, 0.2, 'concreteDark');
    boxAt(ox, oz, yaw, L / 2 - 0.1, 3 * floorH + 0.35, 0, 0.2, 0.7, W, 'concreteDark');
  }

  /* ---- container yard ---------------------------------------------------------- */
  {
    const CL = 6.06, CW = 2.44, CH = 2.59;
    const ox = 118, oz = -6;
    const c = (lx: number, level: number, lz: number, yawDeg: number, mat: MatId) => {
      box(ox + lx, CH / 2 + level * CH, oz + lz, CL, CH, CW, mat, yawDeg * DEG2RAD);
    };
    c(0, 0, 0, 0, 'containerRed');
    c(0, 0, 5.6, 0, 'containerBlue'); // 3.2 m lane between them
    c(0, 1, 2.8, 90, 'containerGreen'); // bridge across the lane: a tunnel
    c(9.5, 0, 1, 14, 'containerRust');
    c(9.5, 1, 1, 14, 'containerBlue');
    c(-9, 0, 4, -8, 'containerGreen');
    c(18, 0, 8, 90, 'containerRed');
    c(18, 0, -4, 90, 'containerRust');
  }

  /* ---- open barn (fly through both ends) ------------------------------------------ */
  {
    const ox = -62, oz = 44, yaw = 0;
    const L = 22, W = 12, H = 5.2, t = 0.2;
    boxAt(ox, oz, yaw, 0, 0.04, 0, L + 0.6, 0.08, W + 0.6, 'concreteDark');
    boxAt(ox, oz, yaw, 0, H / 2, -W / 2, L, H, t, 'roofMetal');
    boxAt(ox, oz, yaw, 0, H / 2, W / 2, L, H, t, 'roofMetal');
    // Gable ends: posts and a header leave a 7 x 4 m door.
    for (const e of [-1, 1]) {
      boxAt(ox, oz, yaw, e * (L / 2), H / 2, -W / 2 + 1.25, t, H, 2.5, 'roofMetal');
      boxAt(ox, oz, yaw, e * (L / 2), H / 2, W / 2 - 1.25, t, H, 2.5, 'roofMetal');
      boxAt(ox, oz, yaw, e * (L / 2), H - 0.6, 0, t, 1.2, 7, 'roofMetal');
    }
    // Flat-ish roof and three portal frames inside.
    boxAt(ox, oz, yaw, 0, H + 0.1, 0, L + 0.8, 0.2, W + 0.8, 'roofMetal');
    for (const lx of [-L / 4, 0, L / 4]) {
      boxAt(ox, oz, yaw, lx, H - 0.25, 0, 0.2, 0.3, W - 0.4, 'steel');
    }
  }

  /* ---- silos and mast --------------------------------------------------------------- */
  cyl(-128, 0, 8, 3.2, 15, 'galvanized');
  cyl(-136, 0, 8, 3.2, 15, 'galvanized');
  cyl(-132, 0, 1.2, 2.2, 11, 'galvanized');
  box(-132, 15.3, 8, 10, 0.12, 1.0, 'steel');
  // Radio mast with alternating bands.
  for (let i = 0; i < 10; i++) {
    cyls.push({ x: -40, y: i * 3.4, z: -150, r: 0.16, h: 3.4, mat: i % 2 === 0 ? 'mastRed' : 'mastWhite' });
  }
  collision.addCylinder(-40, 0, -150, 0.18, 34);
  box(-40, 0.3, -150, 1.2, 0.6, 1.2, 'concrete');

  /* ---- trees ------------------------------------------------------------------------- */
  const addTree = (x: number, z: number, height: number, kind: TreeDef['kind']) => {
    const y = terrain.heightAt(x, z);
    const canopyR = kind === 'pine' ? height * 0.2 : height * (0.3 + 0.08 * rng.next());
    const trunkR = Math.max(0.12, height * 0.022);
    trees.push({ x, y, z, height, canopyR, trunkR, kind, seed: Math.floor(rng.next() * 1e9) });
    if (kind === 'pine') {
      collision.addCylinder(x, y, z, trunkR, height * 0.9);
      // Cone approximated by three stacked soft spheres.
      collision.addSphere(x, y + height * 0.38, z, canopyR * 0.95, 'soft');
      collision.addSphere(x, y + height * 0.6, z, canopyR * 0.65, 'soft');
      collision.addSphere(x, y + height * 0.8, z, canopyR * 0.35, 'soft');
    } else {
      const trunkH = height - canopyR * 1.5;
      collision.addCylinder(x, y, z, trunkR, trunkH);
      collision.addSphere(x, y + height - canopyR, z, canopyR * 0.9, 'soft');
    }
  };
  // Specimen trees on the field: things to orbit and fly under.
  addTree(-22, -44, 13, 'broadleaf');
  addTree(38, -58, 15, 'broadleaf');
  addTree(46, -66, 11, 'broadleaf');
  addTree(104, -112, 14, 'broadleaf');
  addTree(-118, -128, 16, 'broadleaf');
  addTree(-30, 36, 12, 'broadleaf');
  addTree(60, 40, 13, 'broadleaf');
  addTree(128, 44, 15, 'broadleaf');
  addTree(-150, -30, 14, 'pine');
  addTree(-156, -36, 17, 'pine');
  addTree(-147, -40, 12, 'pine');
  // Tree line around the field and woods on the hills.
  for (let i = 0; i < 520; i++) {
    const a = rng.next() * Math.PI * 2;
    const band = rng.next();
    const r = band < 0.55 ? 205 + rng.next() * 55 : 260 + rng.next() * rng.next() * 420;
    const x = Math.cos(a) * r, z = Math.sin(a) * r;
    // Keep the road corridor clear.
    if (Math.abs(z - 22) < 9) continue;
    // Clumping: skip where the low-frequency mask is small.
    if (band >= 0.55 && fbm(x / 90, z / 90, 2) < 0.48) continue;
    const pine = fbm(x / 140 + 7, z / 140, 2) > 0.52;
    addTree(x, z, pine ? 13 + rng.next() * 9 : 10 + rng.next() * 8, pine ? 'pine' : 'broadleaf');
  }

  // Windsock pole.
  collision.addCylinder(-9, 0, -6, 0.04, 5);

  return {
    terrain, collision, boxes, cyls, trees, gates, flags, decals,
    spawn: { x: 0, z: 0, heading: 0 },
    spawns: [
      { id: 'pad', name: 'Launch pad', x: 0, z: 0, heading: 0 },
      { id: 'race', name: 'Race start (10 m before gate 1)', x: 0, z: -15, heading: 0 },
      { id: 'pitch', name: 'Football pitch, centre spot', x: -75, z: -60, heading: 0 },
      { id: 'bando', name: 'In front of the concrete frame', x: 122, z: -30, heading: 70 * DEG2RAD },
      { id: 'containers', name: 'Container yard', x: 100, z: -3, heading: 90 * DEG2RAD },
      { id: 'barn', name: 'Barn, west door', x: -86, z: 44, heading: 90 * DEG2RAD },
    ],
    pilot: { x: 0.6, y: 1.68, z: 4.2 },
    windsock: { x: -9, z: -6, height: 5 },
  };
}
