// Procedural modelling kit for the aircraft visuals: lofted fuselages, aerofoil wings with
// hinged control surfaces, lathes, struts, wheels, propellers, canvas liveries.
// Body frame everywhere: +X forward, +Y up, +Z right. Units: metres.

import * as THREE from 'three';

export const DEG = Math.PI / 180;
export const v3 = (x = 0, y = 0, z = 0) => new THREE.Vector3(x, y, z);
const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);
const lerp = (a, b, t) => a + (b - a) * t;

// --------------------------------------------------------------------------- geometry assembly

export function makeGeo(pos, nor, uv, idx) {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  return g;
}

export function mergeGeos(list) {
  list = list.filter(Boolean);
  let nv = 0, ni = 0;
  for (const g of list) { nv += g.attributes.position.count; ni += g.index ? g.index.count : g.attributes.position.count; }
  const pos = new Float32Array(nv * 3), nor = new Float32Array(nv * 3), uv = new Float32Array(nv * 2);
  const idx = new (nv > 65535 ? Uint32Array : Uint16Array)(ni);
  let vo = 0, io = 0;
  for (const g of list) {
    const p = g.attributes.position, n = g.attributes.normal, u = g.attributes.uv, c = p.count;
    for (let i = 0; i < c; i++) {
      const k = (vo + i) * 3;
      pos[k] = p.getX(i); pos[k + 1] = p.getY(i); pos[k + 2] = p.getZ(i);
      if (n) { nor[k] = n.getX(i); nor[k + 1] = n.getY(i); nor[k + 2] = n.getZ(i); }
      if (u) { uv[(vo + i) * 2] = u.getX(i); uv[(vo + i) * 2 + 1] = u.getY(i); }
    }
    if (g.index) { const a = g.index.array; for (let i = 0; i < a.length; i++) idx[io++] = a[i] + vo; }
    else for (let i = 0; i < c; i++) idx[io++] = vo + i;
    vo += c;
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  out.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  out.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  out.setIndex(new THREE.BufferAttribute(idx, 1));
  return out;
}

const _e = new THREE.Euler(), _q = new THREE.Quaternion(), _s = new THREE.Vector3(), _p = new THREE.Vector3(), _m = new THREE.Matrix4();

/** Transform a geometry in place: scale, then rotate (XYZ euler, rad), then translate. */
export function tx(geo, { p = [0, 0, 0], r = [0, 0, 0], s = 1 } = {}) {
  _q.setFromEuler(_e.set(r[0], r[1], r[2]));
  if (typeof s === 'number') _s.set(s, s, s); else _s.set(s[0], s[1], s[2]);
  geo.applyMatrix4(_m.compose(_p.set(p[0], p[1], p[2]), _q, _s));
  return geo;
}

export function flipWinding(g) {
  if (!g.index) g.setIndex([...Array(g.attributes.position.count).keys()]);
  const a = g.index.array;
  for (let i = 0; i < a.length; i += 3) { const t = a[i]; a[i] = a[i + 2]; a[i + 2] = t; }
  return g;
}

/** Mirrored copy across the XY plane (left <-> right). */
export function mirrorZ(geo) {
  const g = geo.clone();
  g.applyMatrix4(new THREE.Matrix4().makeScale(1, 1, -1));
  return flipWinding(g);
}

/** Give every vertex of a geometry the same texture coordinate (to pick a flat colour from an atlas). */
export function setUV(geo, u, v) {
  const a = geo.attributes.uv;
  if (!a) {
    geo.setAttribute('uv', new THREE.Float32BufferAttribute(new Float32Array(geo.attributes.position.count * 2), 2));
  }
  const uv = geo.attributes.uv;
  for (let i = 0; i < uv.count; i++) uv.setXY(i, u, v);
  return geo;
}

/** Collects static geometry per material and emits one merged mesh per material. */
export class Parts {
  constructor() { this.bins = new Map(); }
  add(key, geo, opts = {}) {
    if (!geo) return this;
    const k = key + (opts.hide ? '#h' : '') + (opts.noShadow ? '#n' : '');
    if (!this.bins.has(k)) this.bins.set(k, { key, list: [], hide: !!opts.hide, noShadow: !!opts.noShadow });
    this.bins.get(k).list.push(geo);
    return this;
  }
  build(materials, parent) {
    const out = [];
    for (const b of this.bins.values()) {
      const m = materials[b.key];
      if (!m) throw new Error('model material missing: ' + b.key);
      const mesh = new THREE.Mesh(mergeGeos(b.list), m);
      mesh.castShadow = !b.noShadow && !m.transparent;
      mesh.receiveShadow = !m.transparent;
      if (b.hide) mesh.userData.hideInCockpit = true;
      mesh.name = b.key;
      parent.add(mesh);
      out.push(mesh);
    }
    return out;
  }
}

// --------------------------------------------------------------------------- interpolation

function pchip(x, y) {
  const n = x.length;
  if (n === 1) return () => y[0];
  const h = [], d = [], m = new Array(n);
  for (let i = 0; i < n - 1; i++) { h[i] = x[i + 1] - x[i]; d[i] = (y[i + 1] - y[i]) / h[i]; }
  m[0] = d[0]; m[n - 1] = d[n - 2];
  for (let i = 1; i < n - 1; i++) {
    if (d[i - 1] * d[i] <= 0) m[i] = 0;
    else { const w1 = 2 * h[i] + h[i - 1], w2 = h[i] + 2 * h[i - 1]; m[i] = (w1 + w2) / (w1 / d[i - 1] + w2 / d[i]); }
  }
  return (xq) => {
    let i = 0;
    if (xq <= x[0]) i = 0; else if (xq >= x[n - 1]) i = n - 2; else while (i < n - 2 && xq > x[i + 1]) i++;
    const t = clamp((xq - x[i]) / h[i], 0, 1), t2 = t * t, t3 = t2 * t;
    return (2 * t3 - 3 * t2 + 1) * y[i] + (t3 - 2 * t2 + t) * h[i] * m[i] + (-2 * t3 + 3 * t2) * y[i + 1] + (t3 - t2) * h[i] * m[i + 1];
  };
}

const ST_FIELDS = ['top', 'bot', 'w', 'mid', 'n', 'nTop', 'nBot', 'zc'];

/**
 * Smooth a list of key cross-sections {x, top, bot, w, [mid], [n], [nTop], [nBot], [zc]} (x descending,
 * nose first) into a dense station list using monotone cubic interpolation.
 * `breaks` lists x positions that must appear exactly (to split a fuselage into several meshes).
 */
export function smoothStations(keys, maxStep, breaks = []) {
  const t = keys.map((k) => -k.x);
  const f = {};
  for (const name of ST_FIELDS) {
    if (keys.some((k) => k[name] !== undefined)) {
      const def = name === 'mid' ? null : name === 'zc' ? 0 : 2.4;
      const ys = keys.map((k) => k[name] !== undefined ? k[name] : name === 'mid' ? (k.top + k.bot) / 2
        : (name === 'nTop' || name === 'nBot') ? (k.n ?? 2.4) : def);
      f[name] = pchip(t, ys);
    }
  }
  const xs = new Set();
  for (let i = 0; i < keys.length - 1; i++) {
    const a = keys[i].x, b = keys[i + 1].x;
    const n = Math.max(1, Math.ceil((a - b) / maxStep));
    for (let k = 0; k < n; k++) xs.add(+(a + (b - a) * k / n).toFixed(5));
  }
  xs.add(keys[keys.length - 1].x);
  for (const b of breaks) xs.add(b);
  const list = [...xs].sort((a, b) => b - a);
  return list.map((x) => {
    const s = { x };
    for (const name in f) s[name] = f[name](-x);
    return s;
  });
}

/** Interpolate a (dense) station list at x. */
export function stationAt(st, x) {
  const n = st.length;
  if (x >= st[0].x) return st[0];
  if (x <= st[n - 1].x) return st[n - 1];
  let i = 0;
  while (i < n - 2 && x < st[i + 1].x) i++;
  const a = st[i], b = st[i + 1], t = (a.x - x) / (a.x - b.x);
  const o = { x };
  for (const name of ST_FIELDS) if (a[name] !== undefined) o[name] = lerp(a[name], b[name], t);
  return o;
}

// --------------------------------------------------------------------------- lofting

/**
 * Skin a sequence of rings (arrays of Vector3, all the same length).
 * opts.seam: the last point of each ring duplicates the first (texture seam).
 * opts.closed (default true): rings are closed loops.
 * opts.uv(i, j): texture coordinates. opts.capStart / capEnd: close the ends with flat fans.
 */
export function ringLoft(rings, o = {}) {
  const R = rings.length, N = rings[0].length;
  const seam = !!o.seam, closed = o.closed !== false;
  const pos = [], nor = [], uv = [], idx = [];
  const cen = rings.map((r) => {
    const c = v3(); const n = seam ? N - 1 : N;
    for (let j = 0; j < n; j++) c.add(r[j]);
    return c.multiplyScalar(1 / n);
  });
  const tv = v3(), tu = v3(), nn = v3(), rad = v3();
  const next = (j) => (seam ? (j >= N - 1 ? 1 : j + 1) : closed ? (j + 1) % N : Math.min(j + 1, N - 1));
  const prev = (j) => (seam ? (j <= 0 ? N - 2 : j - 1) : closed ? (j - 1 + N) % N : Math.max(j - 1, 0));
  // raw normals (ring tangent x axial tangent); the sign is decided once for the whole surface
  let vote = 0;
  const degenerate = [];
  for (let i = 0; i < R; i++) {
    const ia = Math.max(i - 1, 0), ib = Math.min(i + 1, R - 1);
    for (let j = 0; j < N; j++) {
      const p = rings[i][j];
      tv.subVectors(rings[i][next(j)], rings[i][prev(j)]);
      tu.subVectors(rings[ib][j], rings[ia][j]);
      nn.crossVectors(tv, tu);
      rad.subVectors(p, cen[i]);
      const deg = nn.lengthSq() < 1e-16;
      degenerate.push(deg);
      if (deg) {
        // collapsed ring (a pointed tip): the normal points along the axis, away from the body
        nn.subVectors(cen[i], cen[i === 0 ? 1 : i === R - 1 ? R - 2 : (i < R / 2 ? i + 1 : i - 1)]).normalize();
      } else { nn.normalize(); vote += nn.dot(rad); }
      pos.push(p.x, p.y, p.z); nor.push(nn.x, nn.y, nn.z);
      const t = o.uv ? o.uv(i, j) : [j / (N - 1), i / (R - 1)];
      uv.push(t[0], t[1]);
    }
  }
  if (vote < 0) for (let k = 0; k < degenerate.length; k++) if (!degenerate[k]) { nor[k * 3] *= -1; nor[k * 3 + 1] *= -1; nor[k * 3 + 2] *= -1; }
  // winding: make the first non-degenerate face agree with its vertex normals
  const cols = seam || !closed ? N - 1 : N;
  let flip = false;
  const a = v3(), b = v3(), c = v3();
  search: for (let i = 0; i < R - 1; i++) {
    for (let j = 0; j < cols; j++) {
      const j2 = (j + 1) % N;
      a.subVectors(rings[i][j2], rings[i][j]); b.subVectors(rings[i + 1][j2], rings[i][j]);
      c.crossVectors(a, b);
      if (c.lengthSq() > 1e-12) {
        const k = (i * N + j) * 3;
        flip = c.x * nor[k] + c.y * nor[k + 1] + c.z * nor[k + 2] < 0;
        break search;
      }
    }
  }
  for (let i = 0; i < R - 1; i++) {
    for (let j = 0; j < cols; j++) {
      const j2 = (j + 1) % N;
      const p0 = i * N + j, p1 = i * N + j2, p2 = (i + 1) * N + j2, p3 = (i + 1) * N + j;
      if (flip) idx.push(p0, p2, p1, p0, p3, p2); else idx.push(p0, p1, p2, p0, p2, p3);
    }
  }
  const cap = (ri, other, capUV) => {
    const base = pos.length / 3;
    nn.subVectors(cen[ri], cen[other]).normalize();
    const cu = capUV || [uv[(ri * N) * 2], uv[(ri * N) * 2 + 1]];
    pos.push(cen[ri].x, cen[ri].y, cen[ri].z); nor.push(nn.x, nn.y, nn.z); uv.push(cu[0], cu[1]);
    const n = seam ? N - 1 : N;
    for (let j = 0; j < n; j++) {
      const p = rings[ri][j];
      pos.push(p.x, p.y, p.z); nor.push(nn.x, nn.y, nn.z);
      if (capUV) uv.push(cu[0], cu[1]); else uv.push(uv[(ri * N + j) * 2], uv[(ri * N + j) * 2 + 1]);
    }
    a.subVectors(rings[ri][0], cen[ri]); b.subVectors(rings[ri][1], cen[ri]); c.crossVectors(a, b);
    const f = c.dot(nn) < 0;
    for (let j = 0; j < n; j++) {
      const j2 = (j + 1) % n;
      if (f) idx.push(base, base + 1 + j2, base + 1 + j); else idx.push(base, base + 1 + j, base + 1 + j2);
    }
  };
  if (o.capStart) cap(0, 1, o.capStartUV);
  if (o.capEnd) cap(R - 1, R - 2, o.capEndUV);
  return makeGeo(pos, nor, uv, idx);
}

function superRing(s, seg) {
  const mid = s.mid ?? (s.top + s.bot) / 2, ht = s.top - mid, hb = mid - s.bot, zc = s.zc ?? 0;
  const eT = 2 / (s.nTop ?? s.n ?? 2.4), eB = 2 / (s.nBot ?? s.n ?? 2.4);
  const ring = [];
  for (let j = 0; j <= seg; j++) {
    const phi = -Math.PI / 2 + 2 * Math.PI * (j % seg) / seg;
    const c = Math.cos(phi), sn = Math.sin(phi);
    const e = sn >= 0 ? eT : eB;
    const z = zc + s.w * Math.sign(c) * Math.pow(Math.abs(c), e);
    const y = mid + (sn >= 0 ? ht : hb) * Math.sign(sn) * Math.pow(Math.abs(sn), e);
    ring.push(v3(s.x, y, z));
  }
  return ring;
}

/**
 * Fuselage-like loft through stations {x, top, bot, w, [mid], [n | nTop,nBot], [zc]} (superellipse sections).
 * UV: u runs nose -> tail ((uOrigin - x) / uLength), v runs belly -> right side -> top -> left side -> belly.
 */
export function loft(st, o = {}) {
  const seg = o.seg ?? 28;
  const rings = st.map((s) => superRing(s, seg));
  const x0 = o.uOrigin ?? st[0].x, L = o.uLength ?? Math.abs(st[0].x - st[st.length - 1].x);
  return ringLoft(rings, {
    seam: true,
    uv: (i, j) => [(x0 - st[i].x) / L, j / seg],
    capStart: o.capStart, capEnd: o.capEnd, capStartUV: o.capStartUV, capEndUV: o.capEndUV,
  });
}

/**
 * Surface of revolution about the X axis through profile points [[x, r], ...].
 * A profile running toward -X faces outward, one running toward +X faces the axis (so a lip
 * profile that curls from the inside to the outside is shaded correctly). Repeat a point to
 * get a crisp edge. o.inside flips the surface.
 */
export function lathe(profile, seg = 24, o = {}) {
  const R = profile.length, N = seg + 1;
  const pos = [], nor = [], uv = [], idx = [];
  const sgn = o.inside ? -1 : 1;
  for (let i = 0; i < R; i++) {
    const [x, r] = profile[i];
    let a = profile[Math.max(i - 1, 0)], b = profile[Math.min(i + 1, R - 1)];
    if (a[0] === x && a[1] === r) a = profile[i]; 
    if (b[0] === x && b[1] === r && i + 1 < R) b = profile[i];
    if (a === b) { a = profile[Math.max(i - 1, 0)]; b = profile[Math.min(i + 1, R - 1)]; }
    const dx = b[0] - a[0], dr = b[1] - a[1], l = Math.hypot(dx, dr) || 1;
    const nx = sgn * dr / l, nr = -sgn * dx / l;
    for (let j = 0; j <= seg; j++) {
      const ang = -Math.PI / 2 + 2 * Math.PI * (j % seg) / seg, sn = Math.sin(ang), cs = Math.cos(ang);
      pos.push(x, r * sn, r * cs); nor.push(nx, nr * sn, nr * cs);
      const t = o.uv ? o.uv(i, j) : [j / seg, i / (R - 1)];
      uv.push(t[0], t[1]);
    }
  }
  const e1 = v3(), e2 = v3(), fn = v3();
  for (let i = 0; i < R - 1; i++) {
    for (let j = 0; j < seg; j++) {
      const p0 = i * N + j, p1 = p0 + 1, p2 = p1 + N, p3 = p0 + N;
      e1.set(pos[p1 * 3] - pos[p0 * 3], pos[p1 * 3 + 1] - pos[p0 * 3 + 1], pos[p1 * 3 + 2] - pos[p0 * 3 + 2]);
      e2.set(pos[p3 * 3] - pos[p0 * 3], pos[p3 * 3 + 1] - pos[p0 * 3 + 1], pos[p3 * 3 + 2] - pos[p0 * 3 + 2]);
      fn.crossVectors(e1, e2);
      if (fn.lengthSq() < 1e-16) {
        e1.set(pos[p2 * 3] - pos[p3 * 3], pos[p2 * 3 + 1] - pos[p3 * 3 + 1], pos[p2 * 3 + 2] - pos[p3 * 3 + 2]);
        fn.crossVectors(e1, e2);
        if (fn.lengthSq() < 1e-16) continue;
      }
      const d = fn.x * (nor[p0 * 3] + nor[p3 * 3]) + fn.y * (nor[p0 * 3 + 1] + nor[p3 * 3 + 1]) + fn.z * (nor[p0 * 3 + 2] + nor[p3 * 3 + 2]);
      if (d >= 0) idx.push(p0, p1, p2, p0, p2, p3); else idx.push(p0, p2, p1, p0, p3, p2);
    }
  }
  const cap = (i, other) => {
    const [x, r] = profile[i];
    if (r < 1e-4) return;
    const dir = Math.sign(x - profile[other][0]) || 1;
    const base = pos.length / 3;
    const cu = o.capUV || [uv[i * N * 2], uv[i * N * 2 + 1]];
    pos.push(x, 0, 0); nor.push(dir, 0, 0); uv.push(cu[0], cu[1]);
    for (let j = 0; j <= seg; j++) {
      const ang = -Math.PI / 2 + 2 * Math.PI * (j % seg) / seg;
      pos.push(x, r * Math.sin(ang), r * Math.cos(ang)); nor.push(dir, 0, 0); uv.push(cu[0], cu[1]);
    }
    // (0, sin, cos) advancing with j turns from -Y toward +Z: counter-clockwise seen from -X
    for (let j = 0; j < seg; j++) { if (dir < 0) idx.push(base, base + 1 + j, base + 2 + j); else idx.push(base, base + 2 + j, base + 1 + j); }
  };
  if (o.capStart) cap(0, 1);
  if (o.capEnd) cap(R - 1, R - 2);
  return makeGeo(pos, nor, uv, idx);
}

// --------------------------------------------------------------------------- simple solids

const _up = v3(0, 1, 0);

/** Tapered tube from a to b. o.flat = [sx, sz] makes the section elliptical (streamlined struts). */
export function tube(a, b, r0, r1 = r0, seg = 10, o = {}) {
  const dir = b.clone().sub(a), len = dir.length();
  const g = new THREE.CylinderGeometry(r1, r0, len, seg, 1, !!o.open);
  if (o.flat) g.scale(o.flat[0], 1, o.flat[1]);
  g.translate(0, len / 2, 0);
  g.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(_up, dir.normalize()));
  g.translate(a.x, a.y, a.z);
  return g;
}

/** Unit tube along -Y from the origin (length 1), for struts that are re-aimed at run time. */
export function unitStrut(r0, r1 = r0, seg = 10, flat = null) {
  const g = new THREE.CylinderGeometry(r0, r1, 1, seg, 1, false);
  if (flat) g.scale(flat[0], 1, flat[1]);
  g.translate(0, -0.5, 0);
  return g;
}

export function ellipsoid(rx, ry, rz, ws = 16, hs = 12) {
  const g = new THREE.SphereGeometry(1, ws, hs);
  g.scale(rx, ry, rz);
  return g;
}

export function box(sx, sy, sz) { return new THREE.BoxGeometry(sx, sy, sz); }

/** Flat plate: outline [[x, y], ...] in the XY plane, extruded symmetrically along Z. */
export function plateXY(points, thickness, bevel = 0) {
  const sh = new THREE.Shape(points.map(([x, y]) => new THREE.Vector2(x, y)));
  const g = new THREE.ExtrudeGeometry(sh, {
    depth: thickness - 2 * bevel, bevelEnabled: bevel > 0, bevelThickness: bevel, bevelSize: bevel, bevelSegments: 2, steps: 1, curveSegments: 8,
  });
  g.translate(0, 0, -(thickness - 2 * bevel) / 2);
  return g;
}

/** Flat plate: outline [[x, z], ...] in the XZ plane, extruded symmetrically along Y. */
export function plateXZ(points, thickness, bevel = 0) {
  const g = plateXY(points.map(([x, z]) => [x, z]), thickness, bevel);
  g.rotateX(Math.PI / 2);   // shape y -> +z, extrusion z -> -y
  return g;
}

/** Tyre (lathe about Z) and hub disc for a wheel centred on the origin. */
export function wheelGeos(r, w) {
  const ri = r * 0.52, h = w / 2;
  const pts = [[ri, -h * 0.82], [r * 0.84, -h], [r * 0.96, -h * 0.72], [r, -h * 0.3], [r, h * 0.3], [r * 0.96, h * 0.72], [r * 0.84, h], [ri, h * 0.82]]
    .map(([x, y]) => new THREE.Vector2(x, y));
  const tire = new THREE.LatheGeometry(pts, 22);
  tire.rotateX(Math.PI / 2);
  const hub = new THREE.CylinderGeometry(ri * 1.04, ri * 1.04, w * 0.74, 18);
  hub.rotateX(Math.PI / 2);
  return { tire, hub };
}

// --------------------------------------------------------------------------- aerofoils and wings

/** NACA 4-digit camber line and half thickness at chord fraction s. */
export function naca4(s, tc, m = 0, p = 0.4) {
  const yt = 5 * tc * (0.2969 * Math.sqrt(s) - 0.1260 * s - 0.3516 * s * s + 0.2843 * s * s * s - 0.1015 * s * s * s * s);
  let yc = 0;
  if (m !== 0) yc = s < p ? (m / (p * p)) * (2 * p * s - s * s) : (m / ((1 - p) * (1 - p))) * (1 - 2 * p + 2 * p * s - s * s);
  return [yc, yt];
}

/**
 * Build one wing half (or a fin) as closed solids with separate hinged devices.
 *
 * spec: { rootLE:[x,y,z], semiSpan, rootChord, tipChord, sweepLE, dihedral, incidence, twist (deg),
 *         tcRoot, tcTip, camber, camberPos, side (+1 right / -1 left), vertical (fin, span along +Y),
 *         frame (optional Matrix4 overriding the placement), chordSegs,
 *         panels: [{from, to, cut (chord fraction of the hinge) , type, name, skip}], tip: 'round'|'flat' }
 *
 * Returns { fixed: BufferGeometry (body frame), devices: [{type, name, side, geo, position, quaternion, sign,
 *           eta0, eta1, cut}], pt(eta, s, surf) -> Vector3 (body frame), tipLE, tipTE }.
 * Device geometry lives in its hinge frame (origin on the hinge line, Z along the hinge);
 * rotating it by `sign * delta` about Z moves the trailing edge "down" (toward -normal).
 * UV: u = span fraction, v = 0.5 (leading edge) -> 0 (upper TE) / 1 (lower TE).
 */
export function buildWing(spec) {
  const side = spec.vertical ? 1 : (spec.side ?? 1);
  const b = spec.semiSpan, cr = spec.rootChord, ct = spec.tipChord;
  const tanS = Math.tan((spec.sweepLE || 0) * DEG), tanD = Math.tan((spec.dihedral || 0) * DEG);
  const K = spec.chordSegs ?? 12;
  const tcR = spec.tcRoot ?? 0.12, tcT = spec.tcTip ?? tcR;
  const cam = spec.camber ?? 0, camP = spec.camberPos ?? 0.4;
  const frame = spec.frame ? spec.frame.clone() : new THREE.Matrix4().makeTranslation(spec.rootLE[0], spec.rootLE[1], spec.rootLE[2]);
  if (spec.vertical && !spec.frame) frame.multiply(new THREE.Matrix4().makeRotationX(-Math.PI / 2));
  const rot = new THREE.Matrix3().setFromMatrix4(frame);

  /** point in wing-local coordinates; surf: +1 upper, -1 lower, 0 camber line */
  function P(eta, s, surf, mod) {
    const e = Math.min(eta, 1);
    const c = cr + (ct - cr) * e;
    const tc = (tcR + (tcT - tcR) * e) * (mod ? mod.t : 1);
    const inc = ((spec.incidence || 0) + (spec.twist || 0) * e) * DEG;
    const se = mod ? 0.5 + (s - 0.5) * mod.c + mod.shift : s;       // tip sections shrink about mid chord
    const [yc, yt] = naca4(clamp(s, 0, 1), tc, cam, camP);
    const xs = -se * c, ys = (yc + surf * yt) * c;
    const dx = xs + 0.25 * c, ci = Math.cos(inc), si = Math.sin(inc);
    return v3(-e * b * tanS - 0.25 * c + dx * ci - ys * si, e * b * tanD + dx * si + ys * ci, side * eta * b);
  }

  const baseS = [];
  for (let k = 0; k <= K; k++) baseS.push(0.5 * (1 - Math.cos(Math.PI * k / K)));

  /** closed section loop: upper (aft -> fore), mid point, lower (fore -> aft) */
  function loop(eta, sA, sB, nose, mod) {
    const ss = [sA, ...baseS.filter((s) => s > sA + 0.012 && s < sB - 0.012), sB];
    const pts = [], uvs = [], kind = [];
    const up = sA <= 0 ? ss.slice(1) : ss;
    for (let i = up.length - 1; i >= 0; i--) { pts.push(P(eta, up[i], 1, mod)); uvs.push([eta, 0.5 * (1 - up[i])]); kind.push(1); }
    if (sA <= 0) { pts.push(P(eta, 0, 0, mod)); }
    else {
      const mid = P(eta, sA, 0, mod);
      if (nose) { const u = P(eta, sA, 1, mod), l = P(eta, sA, -1, mod); const t = u.distanceTo(l) * 0.5; const f = P(eta, sA - 0.01, 0, mod).sub(mid).normalize(); mid.addScaledVector(f, t); }
      pts.push(mid);
    }
    uvs.push([eta, 0.5 * (1 - sA)]); kind.push(0);
    for (let i = 0; i < up.length; i++) { pts.push(P(eta, up[i], -1, mod)); uvs.push([eta, 0.5 * (1 + up[i])]); kind.push(-1); }
    return { pts, uvs, kind };
  }

  /** closed solid through several section loops; capSide: +1 when loops advance along +Z */
  function solid(loops, capA, capB, capSide = side) {
    const M = loops.length, N = loops[0].pts.length, n = (N - 1) / 2;
    const pos = [], nor = [], uv = [], idx = [];
    const t1 = v3(), t2 = v3(), nn = v3(), ref = v3();
    for (let m = 0; m < M; m++) {
      const L = loops[m].pts, La = loops[Math.max(m - 1, 0)].pts, Lb = loops[Math.min(m + 1, M - 1)].pts;
      for (let i = 0; i < N; i++) {
        t1.subVectors(L[Math.min(i + 1, N - 1)], L[Math.max(i - 1, 0)]);
        t2.subVectors(Lb[i], La[i]);
        nn.crossVectors(t1, t2);
        const k = loops[m].kind[i];
        if (nn.lengthSq() < 1e-18) nn.set(k === 0 ? 1 : 0, k, 0);
        nn.normalize();
        if ((k > 0 && nn.y < 0) || (k < 0 && nn.y > 0) || (k === 0 && nn.x < 0)) nn.negate();
        pos.push(L[i].x, L[i].y, L[i].z); nor.push(nn.x, nn.y, nn.z); uv.push(loops[m].uvs[i][0], loops[m].uvs[i][1]);
      }
    }
    // emit a quad whose geometric normal agrees with `want`
    const quad = (a, b2, c, d, want) => {
      t1.set(pos[b2 * 3] - pos[a * 3], pos[b2 * 3 + 1] - pos[a * 3 + 1], pos[b2 * 3 + 2] - pos[a * 3 + 2]);
      t2.set(pos[d * 3] - pos[a * 3], pos[d * 3 + 1] - pos[a * 3 + 1], pos[d * 3 + 2] - pos[a * 3 + 2]);
      nn.crossVectors(t1, t2);
      if (nn.lengthSq() < 1e-20) {
        t1.set(pos[c * 3] - pos[a * 3], pos[c * 3 + 1] - pos[a * 3 + 1], pos[c * 3 + 2] - pos[a * 3 + 2]);
        nn.crossVectors(t1, t2);
      }
      if (nn.dot(want) >= 0) idx.push(a, b2, c, a, c, d); else idx.push(a, c, b2, a, d, c);
    };
    for (let m = 0; m < M - 1; m++) {
      for (let i = 0; i < N - 1; i++) {
        const a = m * N + i;
        ref.set(nor[a * 3] + nor[(a + 1) * 3], nor[a * 3 + 1] + nor[(a + 1) * 3 + 1], nor[a * 3 + 2] + nor[(a + 1) * 3 + 2]);
        quad(a, a + 1, a + N + 1, a + N, ref);
      }
    }
    // flat faces get their own vertices
    const face = (pts, uvs, normal) => {
      const base = pos.length / 3;
      for (let i = 0; i < pts.length; i++) { pos.push(pts[i].x, pts[i].y, pts[i].z); nor.push(normal.x, normal.y, normal.z); uv.push(uvs[i][0], uvs[i][1]); }
      return base;
    };
    // closing face between the last lower and the first upper point (blunt trailing edge / cove wall)
    for (let m = 0; m < M - 1; m++) {
      const A = loops[m], B = loops[m + 1];
      if (A.pts[0].distanceTo(A.pts[N - 1]) < 1e-5 && B.pts[0].distanceTo(B.pts[N - 1]) < 1e-5) continue;
      t1.subVectors(A.pts[0], A.pts[N - 1]); t2.subVectors(B.pts[N - 1], A.pts[N - 1]);
      const fn = v3().crossVectors(t1, t2).normalize();
      if (fn.x > 0) fn.negate();                                    // faces aft
      const base = face([A.pts[N - 1], A.pts[0], B.pts[0], B.pts[N - 1]], [A.uvs[0], A.uvs[0], B.uvs[0], B.uvs[0]], fn);
      quad(base, base + 1, base + 2, base + 3, fn);
    }
    const capFace = (Lp, dirSign) => {
      const fn = v3(0, 0, dirSign * capSide);
      const base = face(Lp.pts, Lp.uvs, fn);
      for (let i = 0; i < n; i++) quad(base + i, base + i + 1, base + N - 2 - i, base + N - 1 - i, fn);
    };
    if (capA) capFace(loops[0], -1);
    if (capB) capFace(loops[M - 1], 1);
    return makeGeo(pos, nor, uv, idx);
  }

  /** solid whose loops are expressed in a hinge frame; ySign < 0 when that frame's Y is the wing's -normal */
  function solidInFrame(loops, ySign) {
    if (ySign > 0) return solid(loops, true, true, 1);
    for (const L of loops) for (const q of L.pts) q.y = -q.y;
    const g = solid(loops, true, true, 1);
    g.applyMatrix4(new THREE.Matrix4().makeScale(1, -1, 1));
    return flipWinding(g);
  }

  const fixed = [], devices = [];
  const panels = spec.panels || [{ from: 0, to: 1 }];
  const tipRound = spec.tip !== 'flat';
  const tipMods = [];
  if (tipRound) {
    const tcTip = tcT * ct;                                          // tip thickness (m)
    for (const th of [35, 62, 82]) {
      const a = th * DEG;
      tipMods.push({
        eta: 1 + (spec.tipLength ?? 0.6) * tcTip * Math.sin(a) / b,
        mod: { t: Math.cos(a) * 0.97 + 0.03, c: 1 - 0.3 * (1 - Math.cos(a)), shift: 0.06 * (1 - Math.cos(a)) },
      });
    }
  }
  panels.forEach((p, pi) => {
    if (p.skip) return;
    const last = pi === panels.length - 1;
    const prev = panels[pi - 1], nextP = panels[pi + 1];
    const cut = p.cut ?? 1;
    const loops = [loop(p.from, 0, cut, false), loop(p.to, 0, cut, false)];
    if (last && tipRound && cut >= 1) for (const tm of tipMods) loops.push(loop(tm.eta, 0, 1, false, tm.mod));
    const capA = !prev || prev.skip || (prev.cut ?? 1) < cut;
    const capB = last || !nextP || nextP.skip || (nextP.cut ?? 1) < cut;
    fixed.push(solid(loops, capA, capB));
    if (cut < 1) {
      // movable surface, expressed in its hinge frame
      const dl = [loop(p.from, cut, 1, true), loop(p.to, cut, 1, true)];
      const H0 = P(p.from, cut, 0), H1 = P(p.to, cut, 0);
      const zA = H1.clone().sub(H0).normalize();
      const inc = ((spec.incidence || 0) + (spec.twist || 0) * 0.5 * (p.from + p.to)) * DEG;
      const f = v3(Math.cos(inc), Math.sin(inc), 0);
      const xA = f.addScaledVector(zA, -f.dot(zA)).normalize();
      const yA = v3().crossVectors(zA, xA);
      for (const L of dl) for (const q of L.pts) { q.sub(H0); q.set(q.dot(xA), q.dot(yA), q.dot(zA)); }
      const sgn = yA.y >= 0 ? 1 : -1;
      const g = solidInFrame(dl, sgn);
      const basis = new THREE.Matrix4().makeBasis(xA.clone().applyMatrix3(rot), yA.clone().applyMatrix3(rot), zA.clone().applyMatrix3(rot));
      devices.push({
        type: p.type, name: p.name || p.type, side: spec.vertical ? 0 : side, geo: g,
        position: H0.clone().applyMatrix4(frame), quaternion: new THREE.Quaternion().setFromRotationMatrix(basis),
        sign: sgn, eta0: p.from, eta1: p.to, cut, length: H1.distanceTo(H0),
        chord: (cr + (ct - cr) * 0.5 * (p.from + p.to)) * (1 - cut),
      });
    }
  });

  const geo = mergeGeos(fixed);
  geo.applyMatrix4(frame);
  const pt = (eta, s, surf = 0) => P(eta, s, surf).applyMatrix4(frame);
  return { fixed: geo, devices, pt, tipLE: pt(1, 0, 0), tipTE: pt(1, 1, 0), frame, side };
}

// --------------------------------------------------------------------------- textures and materials

export function canvasTexture(w, h, draw, o = {}) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const ctx = c.getContext('2d');
  draw(ctx, w, h);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = o.aniso ?? 8;
  t.wrapS = o.wrapS ?? THREE.ClampToEdgeWrapping;
  t.wrapT = o.wrapT ?? THREE.RepeatWrapping;
  t.generateMipmaps = true;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  return t;
}

export function paint(color, o = {}) {
  return new THREE.MeshStandardMaterial({
    color, roughness: o.rough ?? 0.42, metalness: o.metal ?? 0.12, map: o.map ?? null,
    side: o.side ?? THREE.FrontSide, envMapIntensity: o.env ?? 1,
    emissive: o.emissive ?? 0x000000, emissiveIntensity: o.emissiveIntensity ?? 1,
    transparent: !!o.transparent, opacity: o.opacity ?? 1, depthWrite: o.depthWrite ?? true,
  });
}

export function glass(color = 0x1a2a36, opacity = 0.42) {
  return new THREE.MeshStandardMaterial({
    color, roughness: 0.06, metalness: 0.85, transparent: true, opacity, depthWrite: false, envMapIntensity: 1.4,
  });
}

let _glowTex = null;
export function glowTexture() {
  if (_glowTex) return _glowTex;
  _glowTex = canvasTexture(64, 64, (ctx) => {
    const g = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
    g.addColorStop(0, 'rgba(255,255,255,1)'); g.addColorStop(0.18, 'rgba(255,255,255,0.75)');
    g.addColorStop(0.45, 'rgba(255,255,255,0.18)'); g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = g; ctx.fillRect(0, 0, 64, 64);
  }, { wrapT: THREE.ClampToEdgeWrapping });
  return _glowTex;
}

/**
 * Maps body coordinates on a lofted fuselage to canvas pixels, so liveries can be painted in metres.
 * side: +1 right (starboard), -1 left (port).
 */
export class FusePainter {
  constructor(stations, W, H, uOrigin, uLength) {
    this.st = stations; this.W = W; this.H = H; this.x0 = uOrigin; this.L = uLength;
  }
  X(x) { return (this.x0 - x) / this.L * this.W; }
  /** texture v of the point at height y on the given side at station x */
  v(x, y, side) {
    const s = stationAt(this.st, x);
    const mid = s.mid ?? (s.top + s.bot) / 2;
    const up = y >= mid;
    const h = Math.max(1e-6, up ? s.top - mid : mid - s.bot);
    const e = 2 / ((up ? s.nTop : s.nBot) ?? s.n ?? 2.4);
    const sn = Math.pow(clamp(Math.abs(y - mid) / h, 0, 1), 1 / e) * (up ? 1 : -1);
    const vr = (Math.asin(sn) + Math.PI / 2) / (2 * Math.PI);
    return side > 0 ? vr : 1 - vr;
  }
  Y(x, y, side) { return (1 - this.v(x, y, side)) * this.H; }
  girth(x) {
    const s = stationAt(this.st, x), a = s.w, b = (s.top - s.bot) / 2;
    return Math.PI * (3 * (a + b) - Math.sqrt((3 * a + b) * (a + 3 * b)));
  }
  /** closed polygon [[x, y], ...] on one side */
  poly(ctx, pts, side) {
    ctx.beginPath();
    pts.forEach(([x, y], i) => { const px = this.X(x), py = this.Y(x, y, side); if (i) ctx.lineTo(px, py); else ctx.moveTo(px, py); });
    ctx.closePath();
  }
  /** region between two height functions over x in [xa, xb] on one side */
  band(ctx, side, xa, xb, yLo, yHi, steps = 40) {
    ctx.beginPath();
    for (let i = 0; i <= steps; i++) { const x = lerp(xa, xb, i / steps); const px = this.X(x), py = this.Y(x, yHi(x), side); if (i) ctx.lineTo(px, py); else ctx.moveTo(px, py); }
    for (let i = steps; i >= 0; i--) { const x = lerp(xa, xb, i / steps); ctx.lineTo(this.X(x), this.Y(x, yLo(x), side)); }
    ctx.closePath();
  }
  /** region wrapping over the top of the fuselage above height yLo(x) */
  overTop(ctx, xa, xb, yLo, steps = 30) {
    ctx.beginPath();
    for (let i = 0; i <= steps; i++) { const x = lerp(xa, xb, i / steps); const px = this.X(x), py = this.Y(x, yLo(x), 1); if (i) ctx.lineTo(px, py); else ctx.moveTo(px, py); }
    for (let i = steps; i >= 0; i--) { const x = lerp(xa, xb, i / steps); ctx.lineTo(this.X(x), this.Y(x, yLo(x), -1)); }
    ctx.closePath();
  }
  /** region wrapping under the belly below height yHi(x) (drawn twice because of the seam) */
  underBelly(ctx, xa, xb, yHi, steps = 30) {
    ctx.beginPath();
    for (let i = 0; i <= steps; i++) { const x = lerp(xa, xb, i / steps); const px = this.X(x), py = this.Y(x, yHi(x), 1); if (i) ctx.lineTo(px, py); else ctx.moveTo(px, py); }
    ctx.lineTo(this.X(xb), this.H + 2); ctx.lineTo(this.X(xa), this.H + 2); ctx.closePath();
    for (let i = 0; i <= steps; i++) { const x = lerp(xa, xb, i / steps); const px = this.X(x), py = this.Y(x, yHi(x), -1); if (i) ctx.lineTo(px, py); else ctx.moveTo(px, py); }
    ctx.lineTo(this.X(xb), -2); ctx.lineTo(this.X(xa), -2); ctx.closePath();
  }
  /** upright, readable text centred at (x, y) on one side; height in metres */
  text(ctx, str, x, y, side, height, font = 'bold 100px Arial, Helvetica, sans-serif', color = '#111', slant = 0) {
    const sx = this.W / this.L / 100 * height, sy = this.H / this.girth(x) / 100 * height;
    ctx.save();
    ctx.translate(this.X(x), this.Y(x, y, side));
    ctx.scale(side > 0 ? -sx : sx, side > 0 ? sy : -sy);
    if (slant) ctx.transform(1, 0, -slant, 1, 0, 0);
    ctx.font = font; ctx.fillStyle = color; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(str, 0, 0);
    ctx.restore();
  }
}

/** Maps (span fraction, chord fraction, surface) on a wing built by buildWing to canvas pixels. */
export class WingPainter {
  constructor(W, H) { this.W = W; this.H = H; }
  X(eta) { return eta * this.W; }
  Y(s, upper) { return upper ? this.H * (0.5 + 0.5 * s) : this.H * (0.5 - 0.5 * s); }
  rect(ctx, e0, e1, s0, s1, upper) {
    const y0 = this.Y(s0, upper), y1 = this.Y(s1, upper);
    ctx.fillRect(this.X(e0), Math.min(y0, y1), this.X(e1) - this.X(e0), Math.abs(y1 - y0));
  }
  poly(ctx, pts, upper) {
    ctx.beginPath();
    pts.forEach(([e, s], i) => { if (i) ctx.lineTo(this.X(e), this.Y(s, upper)); else ctx.moveTo(this.X(e), this.Y(s, upper)); });
    ctx.closePath();
  }
}
