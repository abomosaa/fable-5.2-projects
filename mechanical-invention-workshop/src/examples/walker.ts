/**
 * Showcase 5 — a six-legged walking machine built from Jansen ("Strandbeest")
 * linkages. Three crank throws 120° apart each drive a front and a rear leg.
 * It is an ordinary project assembled with the public authoring operations.
 */
import { Builder } from '../core/model/builder';
import type { Project } from '../core/model/types';
import { RPM } from '../core/units';

export interface JansenDims { a: number; b: number; c: number; d: number; e: number; f: number; g: number; h: number; i: number; j: number; k: number; l: number; m: number }

/** Theo Jansen's published proportions ("holy numbers"), used here in millimetres. */
export const JANSEN: JansenDims = { a: 38, b: 41.5, c: 39.3, d: 40.1, e: 55.8, f: 39.4, g: 36.7, h: 65.7, i: 49, j: 50, k: 61.9, l: 7.8, m: 15 };

type P2 = [number, number];

/** intersection of two circles; `left` picks the solution on the left of the directed line p0→p1 */
function circ(p0: P2, r0: number, p1: P2, r1: number, left: boolean): P2 {
  const dx = p1[0] - p0[0], dy = p1[1] - p0[1];
  const d = Math.hypot(dx, dy);
  const a = (r0 * r0 - r1 * r1 + d * d) / (2 * d);
  const h2 = r0 * r0 - a * a;
  if (h2 < 0) throw new Error('Jansen linkage cannot be assembled with these dimensions');
  const h = Math.sqrt(h2);
  const mx = p0[0] + (a * dx) / d, my = p0[1] + (a * dy) / d;
  const s = left ? 1 : -1;
  return [mx - (s * h * dy) / d, my + (s * h * dx) / d];
}

/** joint positions of one (front, i.e. −X side) leg for crank angle theta */
export function jansenPoints(D: JansenDims, theta: number): Record<'O' | 'A' | 'B' | 'C' | 'D' | 'E' | 'F' | 'G', P2> {
  const O: P2 = [0, 0];
  const A: P2 = [D.m * Math.cos(theta), D.m * Math.sin(theta)];
  const B: P2 = [-D.a, -D.l];
  const C = circ(A, D.j, B, D.b, false);       // above the A→B line
  const Dp = circ(B, D.d, C, D.e, true);       // outboard of the fixed pivot
  const E = circ(A, D.k, B, D.c, true);        // below
  // B–D–F–E is close to a parallelogram: take the solution nearest D + (E − B)
  const guess: P2 = [Dp[0] + E[0] - B[0], Dp[1] + E[1] - B[1]];
  const f1 = circ(Dp, D.f, E, D.g, true), f2 = circ(Dp, D.f, E, D.g, false);
  const F = Math.hypot(f1[0] - guess[0], f1[1] - guess[1]) < Math.hypot(f2[0] - guess[0], f2[1] - guess[1]) ? f1 : f2;
  const g1 = circ(E, D.i, F, D.h, true), g2 = circ(E, D.i, F, D.h, false);
  const G = g1[1] < g2[1] ? g1 : g2;            // the foot is the lower solution
  return { O, A, B, C, D: Dp, E, F, G };
}

const mirror = (p: P2): P2 => [-p[0], p[1]];
const ang = (p: P2, q: P2) => Math.atan2(q[1] - p[1], q[0] - p[0]);
const cross = (o: P2, a: P2, b: P2) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);

export interface WalkerOptions {
  dims?: Partial<JansenDims>;
  /** crank speed, rad/s */
  speed?: number;
  /** motor torque limit, mN·mm (null = ideal) */
  maxTorque?: number | null;
  friction?: number;
  phases?: number;
  /** horizontal force on the chassis, mN (negative = pulls back against +X travel) */
  tow?: number;
}

export function buildWalker(opts: WalkerOptions = {}): Project {
  const D: JansenDims = { ...JANSEN, ...(opts.dims ?? {}) };
  const b = new Builder('Walking linkage robot', 'example-walker');
  const T = 3;            // link thickness
  const P = 3.5;          // layer pitch (0.5 mm running gap)
  const W = 8;            // link width
  const PIN = 3;
  const phases = opts.phases ?? 3;
  const link = { width: W, thickness: T, holeDiameter: PIN };
  const colors = ['#e8a33d', '#4c9fd8', '#62c370'];

  // ---- z layout: plate | web | 5 link layers | web | 5 link layers | web | 5 link layers | web | plate
  const LAYERS = 5;
  const blockZ = (ph: number) => P * (2 + ph * (LAYERS + 1));   // first link layer of a phase block
  const webZ = (k: number) => P * (1 + k * (LAYERS + 1));       // web k sits before block k
  const zTop = P * (1 + phases * (LAYERS + 1) + 1);

  // ---- chassis: two side plates with the crank bearing and the two fixed leg pivots
  const plateW = 2 * D.a + 26, plateH = 30;
  const holes = [{ x: 0, y: D.l - 1, d: 5 }, { x: -D.a, y: -1, d: PIN }, { x: D.a, y: -1, d: PIN }];
  const plateY = -D.l + 1;
  const plateA = b.part('baseplate', 'Side plate A', { width: plateW, height: plateH, thickness: T, cornerRadius: 6, holes }, { x: 0, y: plateY, z: 0 }, { color: '#7d8796', materialId: 'aluminum' });
  const plateB = b.part('baseplate', 'Side plate B', { width: plateW, height: plateH, thickness: T, cornerRadius: 6, holes }, { x: 0, y: plateY, z: zTop }, { color: '#7d8796', materialId: 'aluminum' });
  const rodLen = zTop + T;
  const rodF = b.part('shaft', 'Pivot rod (front)', { diameter: PIN, length: rodLen }, { x: -D.a, y: -D.l, z: 0 });
  const rodR = b.part('shaft', 'Pivot rod (rear)', { diameter: PIN, length: rodLen }, { x: D.a, y: -D.l, z: 0 });
  b.rigid(plateA, 'H2', rodF, 'center', 'Front rod in plate A');
  b.rigid(plateA, 'H3', rodR, 'center', 'Rear rod in plate A');
  b.rigid(rodF, 'center', plateB, 'H2', 'Plate B on front rod');
  const motorBody = b.part('motor', 'Gear motor', { shape: 'round', size: 12, bodyLength: 24, shaftDiameter: 3, shaftLength: 4, mass: 0.012 }, { x: 0, y: 0, z: -2 });
  b.rigid(plateA, 'H1', motorBody, 'shaft', 'Motor mount');
  const chassis = b.group('Chassis', [plateA, plateB, rodF, rodR, motorBody]);
  void chassis;

  // ---- crankshaft: webs joined rigidly at the crank pins
  const pinPos = (ph: number): P2 => [D.m * Math.cos((ph * 2 * Math.PI) / phases + Math.PI / 2), D.m * Math.sin((ph * 2 * Math.PI) / phases + Math.PI / 2)];
  const crankParts: string[] = [];
  const web0 = b.part('link', 'Crank web 1', { ...link, length: D.m, holeDiameter: PIN }, { x: 0, y: 0, angle: ang([0, 0], pinPos(0)), z: webZ(0) }, { color: '#c9ced6', materialId: 'aluminum' });
  crankParts.push(web0);
  const drive = b.revolute(plateA, 'H1', web0, 'A', 'Crank bearing', { pinDiameter: 3 });
  b.motor(drive, { speed: opts.speed ?? -50 * RPM, maxTorque: opts.maxTorque === undefined ? 120000 : opts.maxTorque, rampTime: 0.4, type: 'servo' });
  let prevWeb = web0;
  const pinParts: string[] = [];
  for (let ph = 0; ph < phases; ph++) {
    const here = pinPos(ph);
    // crank pin: a short shaft through this phase's link block, rigid with the crankshaft
    const pin = b.part('shaft', `Crank pin ${ph + 1}`, { diameter: PIN, length: P * (LAYERS + 2) - 0.5 }, { x: here[0], y: here[1], z: webZ(ph) }, { materialId: 'steel' });
    b.rigid(prevWeb, 'B', pin, 'center', `Pin ${ph + 1} in web`);
    pinParts.push(pin);
    const last = ph === phases - 1;
    const next: P2 = last ? [0, 0] : pinPos(ph + 1);
    const web = b.part('link', `Crank web ${ph + 2}`, { ...link, length: Math.hypot(next[0] - here[0], next[1] - here[1]) }, { x: here[0], y: here[1], angle: ang(here, next), z: webZ(ph + 1) }, { color: '#c9ced6', materialId: 'aluminum' });
    b.rigid(pin, 'center', web, 'A', `Web ${ph + 2} on pin ${ph + 1}`);
    crankParts.push(web);
    prevWeb = web;
  }
  b.group('Crankshaft', [...crankParts, ...pinParts]);

  // ---- legs
  const footProbes: string[] = [];
  for (let ph = 0; ph < phases; ph++) {
    const theta = (ph * 2 * Math.PI) / phases + Math.PI / 2;
    const z0 = blockZ(ph);
    for (const side of ['F', 'R'] as const) {
      const rear = side === 'R';
      // the rear leg is the mirror image; its crank angle mirrors too
      const raw = jansenPoints(D, rear ? Math.PI - theta : theta);
      const pts = Object.fromEntries(Object.entries(raw).map(([k, v]) => [k, rear ? mirror(v as P2) : (v as P2)])) as typeof raw;
      const nm = `${side}${ph + 1}`;
      const col = colors[ph % colors.length];
      // Layers inside a block (found with the interference checker over a full crank revolution):
      //   0: front j, c, f   1: front k   2: front triangles + rear j, c, f   3: rear k   4: rear triangles
      const zj = z0 + (rear ? 2 : 0) * P, zk = z0 + (rear ? 3 : 1) * P;
      const zTri = z0 + (rear ? 4 : 2) * P;
      const zC = zj, zF = zj, zFoot = zTri;
      const pin = pinParts[ph];
      const rod = rear ? rodR : rodF;

      const lj = b.part('link', `Link j ${nm}`, { ...link, length: D.j }, { x: pts.A[0], y: pts.A[1], angle: ang(pts.A, pts.C), z: zj }, { color: col });
      const lk = b.part('link', `Link k ${nm}`, { ...link, length: D.k }, { x: pts.A[0], y: pts.A[1], angle: ang(pts.A, pts.E), z: zk }, { color: col });
      const tri = b.part('link', `Upper triangle ${nm}`, { ...link, shape: 'ternary', length: D.b, sideAC: D.d, sideBC: D.e, flip: cross(pts.B, pts.C, pts.D) < 0 }, { x: pts.B[0], y: pts.B[1], angle: ang(pts.B, pts.C), z: zTri }, { color: col });
      const lc = b.part('link', `Link c ${nm}`, { ...link, length: D.c }, { x: pts.B[0], y: pts.B[1], angle: ang(pts.B, pts.E), z: zC }, { color: col });
      const lf = b.part('link', `Link f ${nm}`, { ...link, length: D.f }, { x: pts.D[0], y: pts.D[1], angle: ang(pts.D, pts.F), z: zF }, { color: col });
      const foot = b.part('link', `Foot ${nm}`, { ...link, shape: 'ternary', length: D.g, sideAC: D.i, sideBC: D.h, flip: cross(pts.E, pts.F, pts.G) < 0 }, { x: pts.E[0], y: pts.E[1], angle: ang(pts.E, pts.F), z: zFoot }, { color: col });

      b.revolute(pin, 'center', lj, 'A', `A–j ${nm}`);
      b.revolute(pin, 'center', lk, 'A', `A–k ${nm}`);
      b.revolute(rod, 'center', tri, 'A', `B–triangle ${nm}`);
      b.revolute(rod, 'center', lc, 'A', `B–c ${nm}`);
      b.revolute(lj, 'B', tri, 'B', `C ${nm}`);
      b.revolute(lk, 'B', lc, 'B', `E k–c ${nm}`);
      b.revolute(lc, 'B', foot, 'A', `E c–foot ${nm}`);
      b.revolute(tri, 'C', lf, 'A', `D ${nm}`);
      b.revolute(lf, 'B', foot, 'B', `F ${nm}`);
      b.group(`Leg ${nm}`, [lj, lk, tri, lc, lf, foot]);
      if (ph === 0) footProbes.push(b.probePoint(`Foot ${nm}`, foot, 'C', true, rear ? '#4cc2ff' : '#f2b44a'));
    }
  }

  // a towed load: constant drag on the chassis, opposing forward (+X) travel
  const tow = b.forceLoad(plateA, 'center', opts.tow === undefined ? -150 : opts.tow, 0, 'Tow load');

  // ---- probes & plots
  const body = b.probePoint('Chassis', plateA, 'center', false, '#7ee081');
  const drv = b.probeJoint('Crank motor', drive);
  const sys = b.probeSystem('Solver');
  b.plot('Chassis travel', [{ probe: body, quantity: 'x' }]);
  b.plot('Foot height', footProbes.map((p) => ({ probe: p, quantity: 'y' })));
  b.plot('Motor torque', [{ probe: drv, quantity: 'torque' }]);
  b.plot('Loaded feet', [{ probe: sys, quantity: 'contacts' }]);

  const p = b.project;
  p.sim.mode = 'dynamic';
  p.sim.dt = 0.001;
  p.sim.floor = { enabled: true, y: 0, friction: opts.friction ?? 0.8 };
  // put the floor just under the lowest foot
  let minY = Infinity;
  for (let ph = 0; ph < phases; ph++) {
    const theta = (ph * 2 * Math.PI) / phases + Math.PI / 2;
    for (const th of [theta, Math.PI - theta]) minY = Math.min(minY, jansenPoints(D, th).G[1]);
  }
  p.sim.floor.y = Math.round((minY - W / 2 - 0.05) * 100) / 100;
  p.description = [
    'A six-legged walker built from three pairs of Jansen linkages on a three-throw crankshaft (throws 120° apart). One gear motor turns the crank; nothing else is driven.',
    'This runs in free-body mode: the chassis is not grounded. The machine moves only because the feet push on the floor through unilateral contact with Coulomb friction. Watch "Loaded feet" and the locomotion summary in Diagnostics.',
    'Try it: the variants lower the floor friction to 0.08 ("Icy floor": the feet slide and the tow load wins), cut the motor torque limit ("Weak motor": it stalls) or raise the tow load; change a link length (for example the crank radius m) and see whether the linkage still assembles and walks. Nothing guarantees that an edited leg walks — diagnosing why not is the point.',
    'Idealisations: planar rigid bodies; pins are ideal revolute joints; part-to-part collisions are detected and reported but only floor contact produces forces.',
  ].join('\n\n');
  const base = { [`joint:${drive}:motor.maxTorque`]: 120000, [`joint:${drive}:motor.speed`]: -50 * RPM, [`load:${tow}:fx`]: -150 };
  b.variant('Default (μ = 0.8, 0.15 N tow load)', 'Feet grip; the machine walks toward +X pulling its load.', { ...base, 'sim:floor.friction': 0.8 });
  b.variant('Icy floor (μ = 0.08)', 'Traction (μ × weight ≈ 0.12 N) is less than the tow load: the feet slide and the machine is dragged backwards.', { ...base, 'sim:floor.friction': 0.08 });
  b.variant('Weak motor (2 N·mm limit)', 'The motor cannot hold the crank against the tow load: it saturates and the legs are driven backwards.', { ...base, 'sim:floor.friction': 0.8, [`joint:${drive}:motor.maxTorque`]: 2000 });
  b.project.activeVariant = b.project.variants[0].id;
  b.project.views = [
    { name: 'Side', position: [0, -30, 420], target: [0, -40, 30], ortho: true, zoom: 3.2 },
    { name: 'Three-quarter', position: [230, 90, 330], target: [0, -40, 30], ortho: false },
  ];
  b.solve();
  return b.build();
}
