// Parametric structures (cabins, sheds) built as plain vertex arrays so they can be rendered,
// exported and tested without a DOM. Dimensions are metres; origin = centre of the footprint at
// finished ground (pad) level. The stone plinth extends below ground so buildings stay grounded
// on sloping sites.

import { hashFloat } from './noise.js';

export const STRUCTURE_TYPES = {
  cabin: { label: 'Timber cabin', icon: 'cabin' },
  shed: { label: 'Boat shed', icon: 'shed' },
  model: { label: 'Model prop', icon: 'model' },
};

export function cabinParams(s) {
  const v = (s.variant ?? 0) | 0;
  const r = (k) => hashFloat(v, k, 977);
  if (s.type === 'shed') {
    return {
      w: s.w ?? 3.6 + r(1) * 1.2,
      d: s.d ?? 2.8 + r(2) * 0.8,
      wall: s.wall ?? 2.1 + r(3) * 0.2,
      pitch: s.pitch ?? 0.38 + r(4) * 0.12,
      overhang: 0.28,
      plinth: 0.22,
      chimney: false,
      porch: false,
      windows: 1,
    };
  }
  return {
    w: s.w ?? 6.2 + r(1) * 2.4,
    d: s.d ?? 4.8 + r(2) * 1.4,
    wall: s.wall ?? 2.5 + r(3) * 0.35,
    pitch: s.pitch ?? 0.62 + r(4) * 0.22, // rise/run
    overhang: 0.45,
    plinth: 0.38,
    chimney: s.chimney ?? r(5) > 0.25,
    porch: s.porch ?? r(6) > 0.45,
    windows: 2,
  };
}

export function structureFootprint(s, assets) {
  if (s.type === 'cabin' || s.type === 'shed') {
    const p = cabinParams(s);
    return { halfX: p.w / 2 + (p.porch ? 0 : 0), halfZ: p.d / 2 + (p.porch ? 0.9 : 0), margin: 4.5, levelBias: 0.0 };
  }
  if (s.type === 'model') {
    const m = assets?.models?.[s.model];
    const sc = s.scale || 1;
    if (!m) return { halfX: 1, halfZ: 1, margin: 2, pad: false };
    const hx = ((m.bounds.max[0] - m.bounds.min[0]) / 2) * sc,
      hz = ((m.bounds.max[2] - m.bounds.min[2]) / 2) * sc;
    return { halfX: hx, halfZ: hz, margin: 2.5, pad: s.pad === true, overWater: !!s.overWater };
  }
  return null;
}

class MeshBuilder {
  constructor() {
    this.parts = new Map();
  }
  part(name) {
    let p = this.parts.get(name);
    if (!p) {
      p = { positions: [], normals: [], uvs: [], indices: [] };
      this.parts.set(name, p);
    }
    return p;
  }
  /** Quad with corners in counter-clockwise order seen from outside. uv scale in tiles per metre. */
  quad(name, a, b, c, d, uvScale = 1, uvOff = [0, 0]) {
    const p = this.part(name);
    const base = p.positions.length / 3;
    const ux = b[0] - a[0],
      uy = b[1] - a[1],
      uz = b[2] - a[2];
    const vx = d[0] - a[0],
      vy = d[1] - a[1],
      vz = d[2] - a[2];
    let nx = uy * vz - uz * vy,
      ny = uz * vx - ux * vz,
      nz = ux * vy - uy * vx;
    const nl = Math.hypot(nx, ny, nz) || 1;
    nx /= nl;
    ny /= nl;
    nz /= nl;
    const ul = Math.hypot(ux, uy, uz) || 1;
    const vl = Math.hypot(vx, vy, vz) || 1;
    // texture v runs along the quad's a->d edge; pick so that v is "up" for walls
    const pts = [a, b, c, d];
    const uvs = [
      [0, 0],
      [ul, 0],
      [ul, vl],
      [0, vl],
    ];
    for (let i = 0; i < 4; i++) {
      p.positions.push(pts[i][0], pts[i][1], pts[i][2]);
      p.normals.push(nx, ny, nz);
      p.uvs.push(uvs[i][0] * uvScale + uvOff[0], uvs[i][1] * uvScale + uvOff[1]);
    }
    p.indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }
  tri(name, a, b, c, uvScale = 1) {
    const p = this.part(name);
    const base = p.positions.length / 3;
    const ux = b[0] - a[0],
      uy = b[1] - a[1],
      uz = b[2] - a[2];
    const vx = c[0] - a[0],
      vy = c[1] - a[1],
      vz = c[2] - a[2];
    let nx = uy * vz - uz * vy,
      ny = uz * vx - ux * vz,
      nz = ux * vy - uy * vx;
    const nl = Math.hypot(nx, ny, nz) || 1;
    nx /= nl;
    ny /= nl;
    nz /= nl;
    // planar uv: horizontal distance along the dominant horizontal axis, height
    const horiz = Math.abs(nx) > Math.abs(nz) ? 2 : 0;
    for (const q of [a, b, c]) {
      p.positions.push(q[0], q[1], q[2]);
      p.normals.push(nx, ny, nz);
      p.uvs.push(q[horiz] * uvScale, q[1] * uvScale);
    }
    p.indices.push(base, base + 1, base + 2);
  }
  /** Axis-aligned box from min/max corners. */
  box(name, x0, y0, z0, x1, y1, z1, uvScale = 1, faces = 'xXyYzZ') {
    if (faces.includes('Z')) this.quad(name, [x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1], uvScale);
    if (faces.includes('z')) this.quad(name, [x1, y0, z0], [x0, y0, z0], [x0, y1, z0], [x1, y1, z0], uvScale);
    if (faces.includes('X')) this.quad(name, [x1, y0, z1], [x1, y0, z0], [x1, y1, z0], [x1, y1, z1], uvScale);
    if (faces.includes('x')) this.quad(name, [x0, y0, z0], [x0, y0, z1], [x0, y1, z1], [x0, y1, z0], uvScale);
    if (faces.includes('Y')) this.quad(name, [x0, y1, z1], [x1, y1, z1], [x1, y1, z0], [x0, y1, z0], uvScale);
    if (faces.includes('y')) this.quad(name, [x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1], uvScale);
  }
  finish() {
    const out = [];
    for (const [material, p] of this.parts) {
      out.push({
        material,
        positions: new Float32Array(p.positions),
        normals: new Float32Array(p.normals),
        uvs: new Float32Array(p.uvs),
        indices: new Uint32Array(p.indices),
      });
    }
    return out;
  }
}

/**
 * Build structure geometry. Material slots: wall, roof, stone, door, glass, trim.
 * @returns {{parts:Array, height:number, params:object}}
 */
export function buildStructureGeometry(s) {
  const P = cabinParams(s);
  const mb = new MeshBuilder();
  const hw = P.w / 2,
    hd = P.d / 2;
  const y0 = P.plinth; // floor level
  const y1 = y0 + P.wall; // eaves
  const ridge = y1 + hd * P.pitch;
  const single = s.type === 'shed';
  const T = 0.5; // uv tiles per metre for 2 m textures
  // --- stone plinth, extends 3 m below ground for sloping sites ---
  mb.box('stone', -hw - 0.08, -3.0, -hd - 0.08, hw + 0.08, y0, hd + 0.08, T, 'xXzZY');
  // --- walls (front = +Z) with door and window openings cut as separate quads ---
  const wallQuad = (ax, az, bx, bz, yb, yt) => mb.quad('wall', [ax, yb, az], [bx, yb, bz], [bx, yt, bz], [ax, yt, az], T, [0, 0]);
  const openings = [];
  // door on front wall
  const doorW = single ? 1.5 : 0.95,
    doorH = single ? 1.95 : 2.02;
  const doorX = single ? 0 : -hw * 0.38;
  openings.push({ wall: 'front', x: doorX, w: doorW, yb: y0, yt: y0 + doorH, kind: 'door' });
  if (!single) {
    openings.push({ wall: 'front', x: hw * 0.42, w: 1.25, yb: y0 + 0.95, yt: y0 + 2.0, kind: 'window' });
    openings.push({ wall: 'back', x: -hw * 0.4, w: 1.1, yb: y0 + 1.0, yt: y0 + 2.0, kind: 'window' });
    openings.push({ wall: 'back', x: hw * 0.4, w: 1.1, yb: y0 + 1.0, yt: y0 + 2.0, kind: 'window' });
    openings.push({ wall: 'left', x: 0, w: 1.0, yb: y0 + 1.0, yt: y0 + 2.0, kind: 'window' });
  } else {
    openings.push({ wall: 'left', x: 0, w: 0.7, yb: y0 + 1.1, yt: y0 + 1.75, kind: 'window' });
  }
  // generic wall with openings: wall runs from (ax,az) to (bx,bz); local coordinate t in metres from centre
  const buildWall = (name, ax, az, bx, bz, len) => {
    const dirx = (bx - ax) / len,
      dirz = (bz - az) / len;
    const nx = dirz,
      nz = -dirx; // outward normal for CCW footprint order
    const at = (t, y, inset = 0) => [ax + dirx * (t + len / 2) - nx * inset, y, az + dirz * (t + len / 2) - nz * inset];
    const ops = openings.filter((o) => o.wall === name).sort((p, q) => p.x - q.x);
    let cursor = -len / 2;
    for (const o of ops) {
      const l = o.x - o.w / 2,
        r = o.x + o.w / 2;
      if (l > cursor) mb.quad('wall', at(cursor, y0), at(l, y0), at(l, y1), at(cursor, y1), T, [cursor * T, 0]);
      if (o.yb > y0) mb.quad('wall', at(l, y0), at(r, y0), at(r, o.yb), at(l, o.yb), T, [l * T, 0]);
      if (o.yt < y1) mb.quad('wall', at(l, o.yt), at(r, o.yt), at(r, y1), at(l, y1), T, [l * T, (o.yt - y0) * T]);
      // reveal + infill
      const inset = 0.09;
      const mat = o.kind === 'door' ? 'door' : 'glass';
      mb.quad(mat, at(l, o.yb, inset), at(r, o.yb, inset), at(r, o.yt, inset), at(l, o.yt, inset), o.kind === 'door' ? 0.5 : 1);
      mb.quad('trim', at(l, o.yb), at(l, o.yb, inset), at(l, o.yt, inset), at(l, o.yt), 1);
      mb.quad('trim', at(r, o.yb, inset), at(r, o.yb), at(r, o.yt), at(r, o.yt, inset), 1);
      mb.quad('trim', at(l, o.yt, inset), at(r, o.yt, inset), at(r, o.yt), at(l, o.yt), 1);
      mb.quad('trim', at(l, o.yb), at(r, o.yb), at(r, o.yb, inset), at(l, o.yb, inset), 1);
      // frame boards standing proud of the wall
      const fw = 0.085,
        fo = -0.025;
      const frame = (l0, r0, b0, t0) => mb.quad('trim', at(l0, b0, fo), at(r0, b0, fo), at(r0, t0, fo), at(l0, t0, fo), 1);
      frame(l - fw, l, o.yb - (o.kind === 'door' ? 0 : fw), o.yt + fw);
      frame(r, r + fw, o.yb - (o.kind === 'door' ? 0 : fw), o.yt + fw);
      frame(l, r, o.yt, o.yt + fw);
      if (o.kind === 'window') {
        frame(l, r, o.yb - fw, o.yb);
        // glazing bars
        const mx = (l + r) / 2,
          my = (o.yb + o.yt) / 2;
        const bar = 0.03;
        mb.quad('trim', at(mx - bar, o.yb, inset - 0.012), at(mx + bar, o.yb, inset - 0.012), at(mx + bar, o.yt, inset - 0.012), at(mx - bar, o.yt, inset - 0.012), 1);
        mb.quad('trim', at(l, my - bar, inset - 0.012), at(r, my - bar, inset - 0.012), at(r, my + bar, inset - 0.012), at(l, my + bar, inset - 0.012), 1);
      }
      cursor = r;
    }
    if (cursor < len / 2) mb.quad('wall', at(cursor, y0), at(len / 2, y0), at(len / 2, y1), at(cursor, y1), T, [cursor * T, 0]);
  };
  buildWall('front', -hw, hd, hw, hd, P.w);
  buildWall('right', hw, hd, hw, -hd, P.d);
  buildWall('back', hw, -hd, -hw, -hd, P.w);
  buildWall('left', -hw, -hd, -hw, hd, P.d);
  void wallQuad;
  // corner posts
  const cp = 0.07;
  for (const [cx, cz] of [
    [-hw, -hd],
    [hw, -hd],
    [hw, hd],
    [-hw, hd],
  ]) {
    mb.box('trim', cx - cp, y0, cz - cp, cx + cp, y1, cz + cp, 1, 'xXzZ');
  }
  // --- roof ---
  const oh = P.overhang;
  const th = 0.09; // roof thickness
  if (single) {
    const rise = P.d * P.pitch * 0.55;
    const yb = y1,
      yf = y1 + rise;
    // side walls triangular infill
    mb.tri('wall', [hw, y1, hd], [hw, y1, -hd], [hw, yf, hd], T);
    mb.tri('wall', [-hw, y1, -hd], [-hw, y1, hd], [-hw, yf, hd], T);
    mb.quad('wall', [-hw, y1, hd], [hw, y1, hd], [hw, yf, hd], [-hw, yf, hd], T);
    const sl = (yf - yb) / P.d;
    const zb = -hd - oh,
      zf = hd + oh;
    const ybo = yb - oh * sl + 0.02,
      yfo = yf + oh * sl + 0.02;
    mb.quad('roof', [-hw - oh, yfo + th, zf], [hw + oh, yfo + th, zf], [hw + oh, ybo + th, zb], [-hw - oh, ybo + th, zb], T);
    mb.quad('trim', [hw + oh, yfo, zf], [-hw - oh, yfo, zf], [-hw - oh, ybo, zb], [hw + oh, ybo, zb], 1);
    mb.quad('trim', [-hw - oh, yfo, zf], [hw + oh, yfo, zf], [hw + oh, yfo + th, zf], [-hw - oh, yfo + th, zf], 1);
    mb.quad('trim', [hw + oh, ybo, zb], [-hw - oh, ybo, zb], [-hw - oh, ybo + th, zb], [hw + oh, ybo + th, zb], 1);
    mb.quad('trim', [hw + oh, yfo, zf], [hw + oh, ybo, zb], [hw + oh, ybo + th, zb], [hw + oh, yfo + th, zf], 1);
    mb.quad('trim', [-hw - oh, ybo, zb], [-hw - oh, yfo, zf], [-hw - oh, yfo + th, zf], [-hw - oh, ybo + th, zb], 1);
  } else {
    // gable ends on the left/right (x) walls, ridge along x
    mb.tri('wall', [hw, y1, hd], [hw, y1, -hd], [hw, ridge, 0], T);
    mb.tri('wall', [-hw, y1, -hd], [-hw, y1, hd], [-hw, ridge, 0], T);
    const ey = y1 - oh * P.pitch; // eave height at the overhang edge
    const ez = hd + oh;
    const ex = hw + oh;
    const up = th / Math.cos(Math.atan(P.pitch));
    for (const sgn of [1, -1]) {
      const A = [-ex, ey, sgn * ez],
        B = [ex, ey, sgn * ez],
        C = [ex, ridge, 0],
        D = [-ex, ridge, 0];
      const lift = (p) => [p[0], p[1] + up, p[2]];
      if (sgn > 0) {
        mb.quad('roof', lift(A), lift(B), lift(C), lift(D), T);
        mb.quad('trim', B, A, D, C, 1); // soffit
        mb.quad('trim', A, B, lift(B), lift(A), 1); // eave fascia
      } else {
        mb.quad('roof', lift(B), lift(A), lift(D), lift(C), T);
        mb.quad('trim', A, B, C, D, 1);
        mb.quad('trim', B, A, lift(A), lift(B), 1);
      }
      // barge boards on both gables
      mb.quad('trim', [ex, ey, sgn * ez], [ex, ridge, 0], [ex, ridge + up, 0], [ex, ey + up, sgn * ez], 1);
      mb.quad('trim', [-ex, ridge, 0], [-ex, ey, sgn * ez], [-ex, ey + up, sgn * ez], [-ex, ridge + up, 0], 1);
    }
    // ridge cap
    mb.box('trim', -ex, ridge + up - 0.02, -0.09, ex, ridge + up + 0.05, 0.09, 1, 'xXzZY');
  }
  // --- chimney ---
  let top = single ? y1 + P.d * P.pitch * 0.55 + 0.2 : ridge + 0.2;
  if (P.chimney) {
    const cx = hw * 0.45,
      cz = -hd * 0.35;
    const ch = ridge + 0.75;
    mb.box('stone', cx - 0.36, y0, cz - 0.36, cx + 0.36, ch, cz + 0.36, T, 'xXzZY');
    mb.box('stone', cx - 0.42, ch, cz - 0.42, cx + 0.42, ch + 0.1, cz + 0.42, T, 'xXzZYy');
    top = ch + 0.1;
  }
  // --- porch: deck + posts + lean-to roof on the front ---
  if (P.porch) {
    const pd = 1.6;
    mb.box('trim', -hw, y0 - 0.12, hd, hw, y0, hd + pd, 0.5, 'xXZYy');
    mb.box('stone', -hw + 0.1, -3.0, hd + pd - 0.35, -hw + 0.45, y0 - 0.12, hd + pd - 0.05, T, 'xXzZ');
    mb.box('stone', hw - 0.45, -3.0, hd + pd - 0.35, hw - 0.1, y0 - 0.12, hd + pd - 0.05, T, 'xXzZ');
    mb.box('stone', -0.18, -3.0, hd + pd - 0.35, 0.18, y0 - 0.12, hd + pd - 0.05, T, 'xXzZ');
    for (const px of [-hw + 0.12, 0, hw - 0.12]) mb.box('trim', px - 0.06, y0, hd + pd - 0.18, px + 0.06, y1 - 0.25, hd + pd - 0.06, 1, 'xXzZ');
    const ya = y1 - 0.05,
      yb = y1 - 0.42;
    mb.quad('roof', [-hw - 0.2, yb + 0.07, hd + pd + 0.2], [hw + 0.2, yb + 0.07, hd + pd + 0.2], [hw + 0.2, ya + 0.07, hd], [-hw - 0.2, ya + 0.07, hd], T);
    mb.quad('trim', [hw + 0.2, yb, hd + pd + 0.2], [-hw - 0.2, yb, hd + pd + 0.2], [-hw - 0.2, ya, hd], [hw + 0.2, ya, hd], 1);
    mb.quad('trim', [-hw - 0.2, yb, hd + pd + 0.2], [hw + 0.2, yb, hd + pd + 0.2], [hw + 0.2, yb + 0.07, hd + pd + 0.2], [-hw - 0.2, yb + 0.07, hd + pd + 0.2], 1);
    // steps
    mb.box('trim', doorX - 0.7, y0 - 0.3, hd + pd, doorX + 0.7, y0 - 0.14, hd + pd + 0.32, 0.5, 'xXZY');
  } else {
    mb.box('stone', doorX - 0.65, -1.0, hd + 0.08, doorX + 0.65, y0 - 0.16, hd + 0.5, T, 'xXZY');
  }
  return { parts: mb.finish(), height: top, params: P };
}

/** Height of the walking deck in model space for over-water models (measured from the mesh: largest horizontal area). */
export const MODEL_DECK_Y = { modular_wooden_pier: 3.6 };
