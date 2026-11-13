// The world: a procedurally generated island (about 80 km across) with plains, hills, a
// mountain range and several airports. Pure functions of (x, z) so that terrain workers and
// the physics agree exactly. World frame: +X north, +Y up, +Z east. Sea level is y = 0.

import { noised, N, fbm, erodedFbm, ridged, hash2 } from './noise.js';

export const WORLD_HALF = 65536;         // half-size of the terrain quadtree root (m)
export const FINE_CELL = 8;              // grid spacing of the finest terrain mesh (m)
export const PAVEMENT_OFFSET = 0.06;     // runway slabs sit this far above the graded ground

const DEG = Math.PI / 180;
const sstep = (a, b, x) => { let t = (x - a) / (b - a); t = t < 0 ? 0 : t > 1 ? 1 : t; return t * t * (3 - 2 * t); };

// ----------------------------------------------------------------------------- airports
// heading: true heading (deg) of the primary runway direction. Runway numbers derive from it.
export const AIRPORTS = [
  {
    id: 'KSKY', name: 'Skyward International', x: -29500, z: 9000, heading: 20, length: 3400, width: 50,
    elevation: null, size: 'large', ils: true, tower: true,
    description: 'Long runway on the southern coastal plain, ILS on both ends. Suitable for every aircraft.',
  },
  {
    id: 'KVAL', name: 'Greenfield Regional', x: 2000, z: 2000, heading: 130, length: 1500, width: 30,
    elevation: null, size: 'medium', ils: true, tower: true,
    description: 'Regional field in the farmland at the foot of the Spine mountains.',
  },
  {
    id: 'KNOR', name: 'North Shore', x: 34000, z: 8000, heading: 90, length: 1200, width: 25,
    elevation: null, size: 'medium', ils: false, tower: false,
    description: 'Quiet airfield on the north coast between the sea and the north-eastern massif.',
  },
  {
    id: 'KISL', name: 'Coral Bay Airfield', x: 1500, z: -50000, heading: 70, length: 1050, width: 23,
    elevation: null, size: 'small', ils: false, tower: false,
    description: 'Seaside strip on the western peninsula: water on one end, hills on the other.',
  },
  {
    id: 'KMTN', name: 'Eagle Pass Altiport', x: 4500, z: -22500, heading: 60, length: 760, width: 20,
    elevation: null, size: 'small', ils: false, tower: false,
    description: 'Short strip 3,100 ft up in a mountain valley. Land toward the mountain, depart down the valley.',
  },
];

// ----------------------------------------------------------------------------- settlements
// Towns and villages: scenery, landmarks by day and islands of light by night.
export const SETTLEMENTS = [
  { name: 'Skyward City', x: -33200, z: 15800, radius: 1500, tall: true },
  { name: 'Greenfield', x: 4900, z: 5600, radius: 800 },
  { name: 'North Shore', x: 35600, z: 11300, radius: 520 },
  { name: 'Coral Bay', x: 3300, z: -47300, radius: 460 },
  { name: 'Eagle Pass', x: 2500, z: -24300, radius: 260 },
  { name: 'Millbrook', x: -15000, z: 5200, radius: 380 },
  { name: 'Ashford', x: 12500, z: 17500, radius: 420 },
  { name: 'Hartwell', x: 20500, z: -2500, radius: 360 },
  { name: 'Redcliff', x: -21500, z: -11500, radius: 340 },
  { name: 'Lowmoor', x: -8500, z: 22500, radius: 400 },
  { name: 'Stonebridge', x: 26000, z: 31000, radius: 330 },
  { name: 'Westhaven', x: -6000, z: -38000, radius: 380 },
];

/** 1 in the middle of a settlement, 0 outside. */
export function settlementFactor(x, z) {
  for (let i = 0; i < SETTLEMENTS.length; i++) {
    const s = SETTLEMENTS[i];
    const dx = x - s.x, dz = z - s.z, r = s.radius * 1.2;
    if (dx > r || dx < -r || dz > r || dz < -r) continue;
    const d = Math.sqrt(dx * dx + dz * dz) / r;
    if (d < 1) return 1 - d * d;
  }
  return 0;
}

// ----------------------------------------------------------------------------- raw terrain
const OUT = { land: 0, mountain: 0 };

/** Natural terrain height before airports are graded in. Also fills OUT.land / OUT.mountain. */
function rawHeight(x, z) {
  // organic coastline: warp the domain, then a noisy radial falloff
  const wx = x + 2600 * noised(x * 0.00006 + 3.1, z * 0.00006 - 1.7);
  const wz = z + 2600 * noised(x * 0.00006 - 8.4, z * 0.00006 + 5.2);
  const r = Math.hypot(wx * 1.05, wz * 0.92) / 41000;
  const coast = fbm(wx * 0.000031 + 0.5, wz * 0.000031 + 1.5, 4);
  const land = 1 - r + coast * 0.62;
  OUT.land = land;
  if (land < -0.02) {
    OUT.mountain = 0;
    return -260 * (1 - Math.exp(land * 5)) - 1.5;
  }
  const seabed = land < 0 ? -260 * (1 - Math.exp(land * 5)) - 1.5 * sstep(0, -0.004, land) : 0;
  const l = Math.max(land, 0);
  // lowlands
  let h = 3.2 * sstep(0, 0.006, l) + 38 * sstep(0.004, 0.22, l);
  // rolling hills
  const hillMask = sstep(0.012, 0.2, l);
  const hills = fbm(wx * 0.00016, wz * 0.00016, 5);
  h += (hills * 0.5 + 0.5) * 230 * hillMask * (0.35 + 0.65 * sstep(-0.3, 0.5, noised(wx * 0.00004 + 9, wz * 0.00004 - 3)));
  // mountain range: a broad band across the west of the island plus isolated massifs
  const g = (cx, cz, rx, rz) => Math.exp(-(((wx - cx) / rx) ** 2 + ((wz - cz) / rz) ** 2));
  const band = 0.5 * noised(wx * 0.000028 + 11.3, wz * 0.000028 - 4.1) - 0.12
    + 1.0 * g(1000, -19500, 24000, 10500)       // the Spine: main range across the west
    + 0.9 * g(22500, 22000, 8500, 10500)        // north-eastern massif
    + 0.75 * g(-15500, 31000, 5200, 5200);      // lone peak near the south-east coast
  const mm = sstep(0.0, 0.5, band) * sstep(0.1, 0.42, l);
  OUT.mountain = mm;
  if (mm > 0.001) {
    const e = erodedFbm(wx * 0.00007, wz * 0.00007, 9, 0.75);
    const rd = ridged(wx * 0.00016 + 2.2, wz * 0.00016 + 7.7, 5);
    h += mm * (Math.pow(e, 1.3) * 3900 + rd * 600 * mm + 140);
  }
  // small-scale relief, stronger on slopes and in the mountains
  const d = fbm(x * 0.0021, z * 0.0021, 4);
  h += d * (2.5 + 9 * hillMask + 26 * mm) * sstep(0.002, 0.03, l);
  return h + seabed;
}

// ----------------------------------------------------------------------------- airports (graded)
function prepareAirport(a) {
  const hd = a.heading * DEG;
  a.dirX = Math.cos(hd); a.dirZ = Math.sin(hd);       // unit vector along the runway (primary heading)
  a.sideX = -a.dirZ; a.sideZ = a.dirX;                // unit vector to the right of the heading
  const half = a.length / 2;
  // graded pad half extents (along, across) — room for apron and taxiway on the apron side
  a.padL = half + 420;
  a.padW = a.size === 'large' ? 620 : a.size === 'medium' ? 380 : 240;
  a.blend = a.size === 'large' ? 2600 : a.size === 'medium' ? 1500 : 650;
  if (a.elevation == null) {
    // average natural height along the runway, never below a safe margin above the sea
    let sum = 0, n = 0;
    for (let t = -1; t <= 1.001; t += 0.125) { sum += Math.max(rawHeight(a.x + a.dirX * half * t, a.z + a.dirZ * half * t), 0); n++; }
    a.elevation = Math.max(4, Math.round(sum / n));
  }
  // runway identifiers
  const n1 = ((Math.round(a.heading / 10) + 35) % 36) + 1;
  const n2 = ((n1 + 17) % 36) + 1;
  a.runways = [
    { id: String(n1).padStart(2, '0'), heading: a.heading },
    { id: String(n2).padStart(2, '0'), heading: (a.heading + 180) % 360 },
  ];
  return a;
}
for (const a of AIRPORTS) prepareAirport(a);

/** Local airport coordinates: u along the runway (primary heading), v to the right. */
export function airportLocal(a, x, z, out) {
  const dx = x - a.x, dz = z - a.z;
  out.u = dx * a.dirX + dz * a.dirZ;
  out.v = dx * a.sideX + dz * a.sideZ;
  return out;
}
export function airportWorld(a, u, v, out) {
  out.x = a.x + a.dirX * u + a.sideX * v;
  out.z = a.z + a.dirZ * u + a.sideZ * v;
  return out;
}

const _l = { u: 0, v: 0 };

/** Terrain height (m) at world position. */
export function terrainHeight(x, z) {
  let h = rawHeight(x, z);
  for (let i = 0; i < AIRPORTS.length; i++) {
    const a = AIRPORTS[i];
    const dx = x - a.x, dz = z - a.z;
    const reach = a.padL + a.blend;
    if (dx > reach || dx < -reach || dz > reach || dz < -reach) continue;
    const u = Math.abs(dx * a.dirX + dz * a.dirZ) - a.padL;
    const v = Math.abs(dx * a.sideX + dz * a.sideZ) - a.padW;
    const d = u > 0 ? (v > 0 ? Math.hypot(u, v) : u) : (v > 0 ? v : 0);
    if (d >= a.blend) continue;
    const w = 1 - sstep(0, a.blend, d);
    // keep the surroundings above the water when the pad is graded into the coast
    const target = a.elevation;
    h = h + (target - h) * w * w * (3 - 2 * w) * (h < target ? 1 : 1);
    if (d === 0) h = target;
  }
  return h;
}

/** Terrain classification inputs for texturing / biomes. */
export function terrainInfo(x, z, out) {
  out.h = terrainHeight(x, z);       // note: also evaluates rawHeight -> OUT
  rawHeight(x, z);
  out.land = OUT.land; out.mountain = OUT.mountain;
  return out;
}

// ----------------------------------------------------------------------------- paved surfaces
// Each airport exposes rectangles (in local u/v) that are paved: runway, taxiway, apron.
export function airportPavement(a) {
  if (a._pave) return a._pave;
  const half = a.length / 2, hw = a.width / 2;
  const side = 1;                              // apron on the +v (right of primary heading) side
  const rects = [];
  const over = a.size === 'large' ? 90 : 40;   // paved overrun / blast pad
  rects.push({ kind: 'runway', u0: -half - over, u1: half + over, v0: -hw, v1: hw });
  const txOff = a.size === 'large' ? 190 : a.size === 'medium' ? 110 : 62;   // taxiway centreline offset
  const txW = a.size === 'large' ? 25 : a.size === 'medium' ? 16 : 11;
  a.taxiOffset = txOff * side; a.taxiWidth = txW;
  if (a.size !== 'small') {
    rects.push({ kind: 'taxiway', u0: -half, u1: half, v0: txOff - txW / 2, v1: txOff + txW / 2 });
    // connectors
    const n = a.size === 'large' ? 5 : 3;
    for (let i = 0; i < n; i++) {
      const u = -half + txW / 2 + (a.length - txW) * i / (n - 1);
      rects.push({ kind: 'taxiway', u0: u - txW / 2, u1: u + txW / 2, v0: hw, v1: txOff - txW / 2 });
    }
    const apL = a.size === 'large' ? 620 : 300, apW = a.size === 'large' ? 230 : 130;
    rects.push({ kind: 'apron', u0: -apL / 2, u1: apL / 2, v0: txOff + txW / 2, v1: txOff + txW / 2 + apW });
    a.apronRect = rects[rects.length - 1];
  } else {
    // small strips: a turn-off and a parking pad at mid field
    rects.push({ kind: 'taxiway', u0: -6, u1: 6, v0: hw, v1: txOff - 30 });
    rects.push({ kind: 'apron', u0: -70, u1: 70, v0: txOff - 30, v1: txOff + 40 });
    a.apronRect = rects[rects.length - 1];
  }
  a._pave = rects;
  return rects;
}
for (const a of AIRPORTS) airportPavement(a);

/** 1 on an airport's graded pad, fading to 0 over the surrounding 250 m. */
export function airfieldFactor(x, z) {
  for (let i = 0; i < AIRPORTS.length; i++) {
    const a = AIRPORTS[i];
    const dx = x - a.x, dz = z - a.z;
    if (Math.abs(dx) > a.padL + 300 || Math.abs(dz) > a.padL + 300) continue;
    const u = Math.abs(dx * a.dirX + dz * a.dirZ) - a.padL, v = Math.abs(dx * a.sideX + dz * a.sideZ) - a.padW;
    const d = Math.max(u, v);
    if (d < 250) return 1 - sstep(-40, 250, d);
  }
  return 0;
}

/** Ground surface type at a point: 0 runway/paved, 1 grass, 2 rough, 3 water. */
export function surfaceAt(x, z, h) {
  if (h < 0.0) return 3;
  for (let i = 0; i < AIRPORTS.length; i++) {
    const a = AIRPORTS[i];
    const dx = x - a.x, dz = z - a.z;
    if (Math.abs(dx) > a.padL + 50 || Math.abs(dz) > a.padL + 50) continue;
    const u = dx * a.dirX + dz * a.dirZ, v = dx * a.sideX + dz * a.sideZ;
    const rects = a._pave;
    for (let k = 0; k < rects.length; k++) {
      const r = rects[k];
      if (u >= r.u0 && u <= r.u1 && v >= r.v0 && v <= r.v1) return 0;
    }
    if (Math.abs(u) < a.padL && Math.abs(v) < a.padW) return 1;
  }
  return 1;
}

/** Nearest airport and distance. */
export function nearestAirport(x, z) {
  let best = null, bd = Infinity;
  for (const a of AIRPORTS) { const d = Math.hypot(x - a.x, z - a.z); if (d < bd) { bd = d; best = a; } }
  return { airport: best, distance: bd };
}

// ----------------------------------------------------------------------------- biomes
/**
 * Vegetation / land-use masks at a point (all 0..1). Used for colouring and tree placement.
 */
export function biomeAt(x, z, h, slope, land, mountain, out) {
  const f = noised(x * 0.00042 + 40.5, z * 0.00042 - 17.2) * 0.6 + noised(x * 0.0019 - 3.3, z * 0.0019 + 8.8) * 0.4;
  // forest: mid elevations, not too steep; conifers higher up
  let forest = sstep(-0.12, 0.22, f + mountain * 0.35 - 0.05) * sstep(4, 14, h) * (1 - sstep(1500, 1900, h)) * (1 - sstep(0.5, 0.72, slope));
  // farmland: flat lowlands
  const farm = sstep(0.05, -0.2, f) * sstep(5, 12, h) * (1 - sstep(260, 420, h)) * (1 - sstep(0.06, 0.16, slope)) * (1 - sstep(0.02, 0.2, mountain));
  forest *= 1 - farm;
  out.forest = forest;
  out.farm = farm;
  out.conifer = sstep(500, 1000, h + f * 250);
  out.snow = sstep(1750, 2150, h + f * 180 - slope * 500);
  out.rock = Math.max(sstep(0.45, 0.8, slope), sstep(1500, 1900, h) * 0.6);
  out.sand = (1 - sstep(1.5, 5.5, h)) * (1 - sstep(0.2, 0.5, slope));
  return out;
}

export { hash2, rawHeight };
