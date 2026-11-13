// Geometry kernel for the pipeline: indexed triangle "prims" { pos, nrm, uv, idx } (Float32Array/Uint32Array).
import { MeshoptSimplifier } from 'meshoptimizer';

export const meshReady = MeshoptSimplifier.ready;

export const triCount = (p) => p.idx.length / 3;
export const vertCount = (p) => p.pos.length / 3;

export function bboxOf(pos, box = { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] }) {
  const { min, max } = box;
  for (let i = 0; i < pos.length; i += 3) {
    const x = pos[i], y = pos[i + 1], z = pos[i + 2];
    if (x < min[0]) min[0] = x; if (x > max[0]) max[0] = x;
    if (y < min[1]) min[1] = y; if (y > max[1]) max[1] = y;
    if (z < min[2]) min[2] = z; if (z > max[2]) max[2] = z;
  }
  return box;
}

/** Apply a column-major 4x4 to positions (and its inverse-transpose to normals). Returns new arrays. */
export function transformGeometry(pos, nrm, m) {
  const n = pos.length / 3;
  const op = new Float32Array(pos.length), on = nrm ? new Float32Array(nrm.length) : null;
  const a = m[0], b = m[4], c = m[8], d = m[1], e = m[5], f = m[9], g = m[2], h = m[6], k = m[10];
  // cofactor matrix (= det * inverse transpose) for normals
  const n00 = e * k - f * h, n01 = f * g - d * k, n02 = d * h - e * g;
  const n10 = c * h - b * k, n11 = a * k - c * g, n12 = b * g - a * h;
  const n20 = b * f - c * e, n21 = c * d - a * f, n22 = a * e - b * d;
  const det = a * n00 + b * n01 + c * n02;
  const sgn = det < 0 ? -1 : 1;
  for (let i = 0; i < n; i++) {
    const x = pos[i * 3], y = pos[i * 3 + 1], z = pos[i * 3 + 2];
    op[i * 3] = a * x + b * y + c * z + m[12];
    op[i * 3 + 1] = d * x + e * y + f * z + m[13];
    op[i * 3 + 2] = g * x + h * y + k * z + m[14];
    if (on) {
      const nx = nrm[i * 3], ny = nrm[i * 3 + 1], nz = nrm[i * 3 + 2];
      let rx = (n00 * nx + n10 * ny + n20 * nz) * sgn, ry = (n01 * nx + n11 * ny + n21 * nz) * sgn, rz = (n02 * nx + n12 * ny + n22 * nz) * sgn;
      const l = Math.hypot(rx, ry, rz) || 1;
      on[i * 3] = rx / l; on[i * 3 + 1] = ry / l; on[i * 3 + 2] = rz / l;
    }
  }
  return { pos: op, nrm: on, flipped: det < 0 };
}

export function concatPrims(list) {
  if (list.length === 1) return list[0];
  let nv = 0, ni = 0;
  for (const p of list) { nv += vertCount(p); ni += p.idx.length; }
  const out = { pos: new Float32Array(nv * 3), nrm: new Float32Array(nv * 3), uv: new Float32Array(nv * 2), idx: new Uint32Array(ni) };
  let vo = 0, io = 0;
  for (const p of list) {
    out.pos.set(p.pos, vo * 3); out.nrm.set(p.nrm, vo * 3); out.uv.set(p.uv, vo * 2);
    for (let i = 0; i < p.idx.length; i++) out.idx[io + i] = p.idx[i] + vo;
    vo += vertCount(p); io += p.idx.length;
  }
  return out;
}

/** Drop unreferenced vertices and degenerate triangles; vertex order follows first use (deterministic). */
export function compactPrim(p) {
  const n = vertCount(p);
  const map = new Int32Array(n).fill(-1);
  const idx = new Uint32Array(p.idx.length);
  let m = 0, w = 0;
  for (let i = 0; i < p.idx.length; i += 3) {
    const a = p.idx[i], b = p.idx[i + 1], c = p.idx[i + 2];
    if (a === b || b === c || a === c) continue;
    for (const v of [a, b, c]) { if (map[v] < 0) map[v] = m++; idx[w++] = map[v]; }
  }
  const out = { pos: new Float32Array(m * 3), nrm: new Float32Array(m * 3), uv: new Float32Array(m * 2), idx: idx.slice(0, w) };
  for (let v = 0; v < n; v++) {
    const t = map[v];
    if (t < 0) continue;
    out.pos[t * 3] = p.pos[v * 3]; out.pos[t * 3 + 1] = p.pos[v * 3 + 1]; out.pos[t * 3 + 2] = p.pos[v * 3 + 2];
    out.nrm[t * 3] = p.nrm[v * 3]; out.nrm[t * 3 + 1] = p.nrm[v * 3 + 1]; out.nrm[t * 3 + 2] = p.nrm[v * 3 + 2];
    out.uv[t * 2] = p.uv[v * 2]; out.uv[t * 2 + 1] = p.uv[v * 2 + 1];
  }
  return out;
}

/** canonical vertex id per vertex (vertices with bit-identical positions share an id) */
export function positionRemap(pos) {
  return MeshoptSimplifier.generatePositionRemap(pos, 3);
}

/**
 * Attribute-aware edge-collapse simplification (meshoptimizer). Keeps vertex positions/attributes of survivors.
 * `uvWeight` is relative to a UV extent of 1 (it is divided by the prim's UV range so tiling UVs don't dominate).
 */
export function simplifyPrim(p, targetTris, { maxError = 1, flags = [], nrmWeight = 0.6, uvWeight = 0.6, lock = null } = {}) {
  if (triCount(p) <= targetTris) return p;
  const n = vertCount(p);
  const attrs = new Float32Array(n * 5);
  let u0 = Infinity, u1 = -Infinity, v0 = Infinity, v1 = -Infinity;
  for (let i = 0; i < n; i++) {
    const u = p.uv[i * 2], v = p.uv[i * 2 + 1];
    if (u < u0) u0 = u; if (u > u1) u1 = u; if (v < v0) v0 = v; if (v > v1) v1 = v;
    attrs[i * 5] = p.nrm[i * 3]; attrs[i * 5 + 1] = p.nrm[i * 3 + 1]; attrs[i * 5 + 2] = p.nrm[i * 3 + 2];
    attrs[i * 5 + 3] = u; attrs[i * 5 + 4] = v;
  }
  const uvRange = Math.max(1, u1 - u0, v1 - v0);
  const uw = uvWeight / uvRange;
  const target = Math.max(3, Math.floor(targetTris) * 3);
  const [idx] = MeshoptSimplifier.simplifyWithAttributes(p.idx, p.pos, 3, attrs, 5, [nrmWeight, nrmWeight, nrmWeight, uw, uw], lock, target, maxError, flags);
  return compactPrim({ ...p, idx });
}

/**
 * Simplify towards a triangle budget, escalating from quality-preserving to aggressive modes until it is met.
 * Returns the prim (always <= budget unless the mesh is already tiny).
 */
export function simplifyToBudget(p, budget, { nrmWeight, uvWeight, log, sloppy = true, pick = 'first' } = {}) {
  if (triCount(p) <= budget) return p;
  const run = (flags, maxError, src = p) => simplifyPrim(src, budget, { flags, maxError, nrmWeight, uvWeight });
  // 1) quality-preserving collapse; done if it reaches the budget (the common case for scans)
  let r = run([], 0.02);
  if (triCount(r) > 0 && triCount(r) <= budget) return r;
  if (pick === 'area') {
    // multi-part props: an unbounded collapse can "reach" the budget by wrecking parts, so only accept a bounded one here
    r = run([], 0.08);
    if (triCount(r) > 0 && triCount(r) <= budget * 1.02) return r;
  }
  r = run([], 1);
  if (pick !== 'area' && triCount(r) > 0 && triCount(r) <= budget * 1.02) return r;
  if (!sloppy) {
    if (triCount(r) > budget) { const q = run(['Permissive'], 1); if (triCount(q) > 0 && triCount(q) < triCount(r)) r = q; }
    return triCount(r) > 0 ? r : p;
  }
  if (pick === 'first') {
    // scans (one skin, many UV islands): escalate gently - seam-crossing collapses first, topology-free clustering last
    let best = r;
    const steps = [['permissive', () => run(['Permissive'], 1)], ['prune5+permissive', () => run(['Permissive'], 1, simplifyPrim(p, budget, { flags: ['Prune'], maxError: 0.05, nrmWeight, uvWeight }))],
      ['sloppy', () => { const [idx] = MeshoptSimplifier.simplifySloppy(p.idx, p.pos, 3, null, Math.max(3, Math.floor(budget) * 3), 1); return compactPrim({ ...p, idx }); }]];
    for (const [name, fn] of steps) {
      const q = fn();
      if (triCount(q) > 0 && triCount(q) < triCount(best)) best = q;
      if (triCount(best) <= budget * 1.02) { if (name === 'sloppy') log?.(`sloppy simplification used (${triCount(p)} -> ${triCount(best)} tris, budget ${budget})`); return best; }
    }
    return best;
  }
  // 2) multi-part / hard-surface meshes: try several aggressive strategies and keep the one that preserves the
  //    surface area best (shredded or hollowed-out results lose area). NB: 'Prune' is only used with a bounded
  //    error - with a loose bound it deletes whole objects.
  const cands = [{ name: 'collapse', prim: r }];
  const tryAdd = (name, fn) => { try { const q = fn(); if (triCount(q) > 0) cands.push({ name, prim: q }); } catch { /* ignore */ } };
  const sloppyTo = (n, src = p) => { const [idx] = MeshoptSimplifier.simplifySloppy(src.idx, src.pos, 3, null, Math.max(3, Math.floor(n) * 3), 1); return compactPrim({ ...src, idx }); };
  tryAdd('permissive', () => run(['Permissive'], 1));
  tryAdd('prune5', () => run([], 1, simplifyPrim(p, budget, { flags: ['Prune'], maxError: 0.05, nrmWeight, uvWeight })));
  tryAdd('prune5+permissive', () => run(['Permissive'], 1, simplifyPrim(p, budget, { flags: ['Prune'], maxError: 0.05, nrmWeight, uvWeight })));
  tryAdd('sloppy', () => sloppyTo(budget));
  tryAdd('sloppy4x+permissive', () => run(['Permissive'], 1, sloppyTo(budget * 4)));
  const within = cands.filter((c) => triCount(c.prim) <= budget * 1.02);
  const pool = within.length ? within : [cands.reduce((m, c) => (triCount(c.prim) < triCount(m.prim) ? c : m))];
  const ref = depthViews(p, bboxOf(p.pos));
  // topology-free clustering smears UVs across parts, so it has to win by a clear margin
  const score = (c) => (c.score ??= depthError(ref, depthViews(c.prim, ref.box)) + (c.name === 'sloppy' ? 0.015 : c.name.startsWith('sloppy') ? 0.01 : 0));
  if (process.env.PWE_DEBUG_SIMPLIFY) log?.(`candidates for budget ${budget}: ` + cands.map((c) => `${c.name}=${triCount(c.prim)}t/${(depthError(ref, depthViews(c.prim, ref.box)) * 100).toFixed(1)}%`).join(' '));
  const best = pool.reduce((m, c) => (score(c) < score(m) ? c : m));
  if (best.name !== 'collapse') log?.(`${best.name} simplification used (${triCount(p)} -> ${triCount(best.prim)} tris, budget ${budget}, depth error ${(score(best) * 100).toFixed(1)}%)`);
  return best.prim;
}

// ---- shape comparison by orthographic depth maps (6 axis directions): catches holes / shredding / lost parts
const DV = 56;
function depthViews(p, box) {
  const { pos, idx } = p;
  const ext = [0, 1, 2].map((k) => Math.max(1e-9, box.max[k] - box.min[k]));
  const views = [];
  for (let axis = 0; axis < 3; axis++) {
    const u = (axis + 1) % 3, v = (axis + 2) % 3;
    const near = new Float32Array(DV * DV).fill(Infinity), far = new Float32Array(DV * DV).fill(-Infinity);
    for (let t = 0; t < idx.length; t += 3) {
      const P = [0, 1, 2].map((j) => { const i = idx[t + j] * 3; return [((pos[i + u] - box.min[u]) / ext[u]) * DV, ((pos[i + v] - box.min[v]) / ext[v]) * DV, (pos[i + axis] - box.min[axis]) / ext[axis]]; });
      const x0 = Math.max(0, Math.floor(Math.min(P[0][0], P[1][0], P[2][0]))), x1 = Math.min(DV - 1, Math.floor(Math.max(P[0][0], P[1][0], P[2][0])));
      const y0 = Math.max(0, Math.floor(Math.min(P[0][1], P[1][1], P[2][1]))), y1 = Math.min(DV - 1, Math.floor(Math.max(P[0][1], P[1][1], P[2][1])));
      const area = (P[1][0] - P[0][0]) * (P[2][1] - P[0][1]) - (P[2][0] - P[0][0]) * (P[1][1] - P[0][1]);
      if (Math.abs(area) < 1e-12) continue;
      for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
        const qx = x + 0.5, qy = y + 0.5;
        let w0 = ((P[1][0] - qx) * (P[2][1] - qy) - (P[2][0] - qx) * (P[1][1] - qy)) / area;
        let w1 = ((P[2][0] - qx) * (P[0][1] - qy) - (P[0][0] - qx) * (P[2][1] - qy)) / area;
        let w2 = 1 - w0 - w1;
        if (w0 < -0.02 || w1 < -0.02 || w2 < -0.02) continue;
        const z = w0 * P[0][2] + w1 * P[1][2] + w2 * P[2][2], o = y * DV + x;
        if (z < near[o]) near[o] = z; if (z > far[o]) far[o] = z;
      }
    }
    views.push(near, far);
  }
  return { views, box };
}
function depthError(a, b) {
  let err = 0, n = 0;
  for (let k = 0; k < a.views.length; k++) {
    const A = a.views[k], B = b.views[k];
    for (let i = 0; i < A.length; i++) {
      const ha = Number.isFinite(A[i]), hb = Number.isFinite(B[i]);
      if (!ha && !hb) continue;
      n++; err += ha && hb ? Math.min(1, Math.abs(A[i] - B[i])) : 1;
    }
  }
  return n ? err / n : 1;
}

/** Smooth vertex normals recomputed from geometry (angle-weighted), welded by position so UV seams don't crease. */
export function recomputeNormals(p) {
  const remap = positionRemap(p.pos);
  const n = vertCount(p);
  const acc = new Float64Array(n * 3);
  const { pos, idx } = p;
  for (let i = 0; i < idx.length; i += 3) {
    const ia = idx[i], ib = idx[i + 1], ic = idx[i + 2];
    const ax = pos[ia * 3], ay = pos[ia * 3 + 1], az = pos[ia * 3 + 2];
    const bx = pos[ib * 3], by = pos[ib * 3 + 1], bz = pos[ib * 3 + 2];
    const cx = pos[ic * 3], cy = pos[ic * 3 + 1], cz = pos[ic * 3 + 2];
    const e1x = bx - ax, e1y = by - ay, e1z = bz - az, e2x = cx - ax, e2y = cy - ay, e2z = cz - az, e3x = cx - bx, e3y = cy - by, e3z = cz - bz;
    let nx = e1y * e2z - e1z * e2y, ny = e1z * e2x - e1x * e2z, nz = e1x * e2y - e1y * e2x;
    const nl = Math.hypot(nx, ny, nz);
    if (nl < 1e-20) continue;
    nx /= nl; ny /= nl; nz /= nl;
    const l1 = Math.hypot(e1x, e1y, e1z) || 1, l2 = Math.hypot(e2x, e2y, e2z) || 1, l3 = Math.hypot(e3x, e3y, e3z) || 1;
    const angA = Math.acos(Math.max(-1, Math.min(1, (e1x * e2x + e1y * e2y + e1z * e2z) / (l1 * l2))));
    const angB = Math.acos(Math.max(-1, Math.min(1, -(e1x * e3x + e1y * e3y + e1z * e3z) / (l1 * l3))));
    const angC = Math.max(0, Math.PI - angA - angB);
    const w = [angA, angB, angC], v = [remap[ia], remap[ib], remap[ic]];
    for (let k = 0; k < 3; k++) { acc[v[k] * 3] += nx * w[k]; acc[v[k] * 3 + 1] += ny * w[k]; acc[v[k] * 3 + 2] += nz * w[k]; }
  }
  const nrm = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    const r = remap[i];
    let x = acc[r * 3], y = acc[r * 3 + 1], z = acc[r * 3 + 2];
    const l = Math.hypot(x, y, z);
    if (l < 1e-12) { x = p.nrm[i * 3]; y = p.nrm[i * 3 + 1]; z = p.nrm[i * 3 + 2]; } else { x /= l; y /= l; z /= l; }
    nrm[i * 3] = x; nrm[i * 3 + 1] = y; nrm[i * 3 + 2] = z;
  }
  return { ...p, nrm };
}

export function triangleAreaSum(p) {
  const { pos, idx } = p; let s = 0;
  for (let i = 0; i < idx.length; i += 3) s += triArea(pos, idx[i], idx[i + 1], idx[i + 2]);
  return s;
}
function triArea(pos, a, b, c) {
  const e1x = pos[b * 3] - pos[a * 3], e1y = pos[b * 3 + 1] - pos[a * 3 + 1], e1z = pos[b * 3 + 2] - pos[a * 3 + 2];
  const e2x = pos[c * 3] - pos[a * 3], e2y = pos[c * 3 + 1] - pos[a * 3 + 1], e2z = pos[c * 3 + 2] - pos[a * 3 + 2];
  return 0.5 * Math.hypot(e1y * e2z - e1z * e2y, e1z * e2x - e1x * e2z, e1x * e2y - e1y * e2x);
}

/**
 * Connected components (position-welded). Returns per-component stats and the triangles grouped by component.
 * comps are ordered along a Morton curve of their centroids so that regular sub-sampling is spatially even.
 */
export function analyseComponents(p) {
  const { pos, idx } = p;
  const nt = idx.length / 3, nv = pos.length / 3;
  const remap = positionRemap(pos);
  const parent = new Uint32Array(nv);
  for (let i = 0; i < nv; i++) parent[i] = i;
  const find = (x) => { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; };
  for (let t = 0; t < nt; t++) {
    const a = find(remap[idx[t * 3]]), b = find(remap[idx[t * 3 + 1]]), c = find(remap[idx[t * 3 + 2]]);
    const m = Math.min(a, b, c);
    parent[a] = m; parent[b] = m; parent[c] = m;
  }
  const label = new Int32Array(nv).fill(-1);
  const triComp = new Uint32Array(nt);
  let count = 0;
  for (let t = 0; t < nt; t++) {
    const r = find(remap[idx[t * 3]]);
    if (label[r] < 0) label[r] = count++;
    triComp[t] = label[r];
  }
  const tris = new Uint32Array(count), area = new Float64Array(count), cen = new Float64Array(count * 3);
  const bmin = new Float32Array(count * 3).fill(Infinity), bmax = new Float32Array(count * 3).fill(-Infinity);
  for (let t = 0; t < nt; t++) {
    const c = triComp[t], a = idx[t * 3], b = idx[t * 3 + 1], d = idx[t * 3 + 2];
    const ar = triArea(pos, a, b, d) + 1e-12;
    tris[c]++; area[c] += ar;
    for (let k = 0; k < 3; k++) {
      const pa = pos[a * 3 + k], pb = pos[b * 3 + k], pd = pos[d * 3 + k];
      cen[c * 3 + k] += (ar * (pa + pb + pd)) / 3;
      bmin[c * 3 + k] = Math.min(bmin[c * 3 + k], pa, pb, pd); bmax[c * 3 + k] = Math.max(bmax[c * 3 + k], pa, pb, pd);
    }
  }
  for (let c = 0; c < count; c++) for (let k = 0; k < 3; k++) cen[c * 3 + k] /= area[c];
  // triangles grouped by component (counting sort)
  const start = new Uint32Array(count + 1);
  for (let c = 0; c < count; c++) start[c + 1] = start[c] + tris[c];
  const fill = start.slice(0, count), triList = new Uint32Array(nt);
  for (let t = 0; t < nt; t++) triList[fill[triComp[t]]++] = t;
  // Morton order of centroids
  const box = bboxOf(pos);
  const ext = Math.max(box.max[0] - box.min[0], box.max[1] - box.min[1], box.max[2] - box.min[2], 1e-9);
  const part = (v) => { v &= 0x3ff; v = (v | (v << 16)) & 0x30000ff; v = (v | (v << 8)) & 0x300f00f; v = (v | (v << 4)) & 0x30c30c3; v = (v | (v << 2)) & 0x9249249; return v; };
  const code = new Float64Array(count);
  for (let c = 0; c < count; c++) {
    const q = [0, 1, 2].map((k) => Math.min(1023, Math.floor(((cen[c * 3 + k] - box.min[k]) / ext) * 1024)));
    code[c] = (part(q[0]) | (part(q[1]) << 1) | (part(q[2]) << 2)) >>> 0;
  }
  const order = Array.from({ length: count }, (_, i) => i).sort((a, b) => code[a] - code[b] || a - b);
  return { count, tris, area, cen, bmin, bmax, start, triList, order: Uint32Array.from(order), totalArea: area.reduce((s, v) => s + v, 0) };
}

/** Extract a set of components into a new compact prim, optionally scaling each about its centroid. */
export function extractComponents(p, comps, ids, scaleOf = null) {
  let nt = 0;
  for (const c of ids) nt += comps.tris[c];
  const idx = new Uint32Array(nt * 3);
  const map = new Map();
  const vsrc = [], vcomp = [];
  let w = 0;
  for (const c of ids) {
    for (let k = comps.start[c]; k < comps.start[c + 1]; k++) {
      const t = comps.triList[k];
      for (let j = 0; j < 3; j++) {
        const v = p.idx[t * 3 + j];
        let nv = map.get(v);
        if (nv === undefined) { nv = vsrc.length; map.set(v, nv); vsrc.push(v); vcomp.push(c); }
        idx[w++] = nv;
      }
    }
  }
  const n = vsrc.length;
  const out = { pos: new Float32Array(n * 3), nrm: new Float32Array(n * 3), uv: new Float32Array(n * 2), idx };
  for (let i = 0; i < n; i++) {
    const v = vsrc[i], c = vcomp[i], s = scaleOf ? scaleOf(c) : 1;
    for (let k = 0; k < 3; k++) {
      const cv = comps.cen[c * 3 + k];
      out.pos[i * 3 + k] = cv + (p.pos[v * 3 + k] - cv) * s;
      out.nrm[i * 3 + k] = p.nrm[v * 3 + k];
    }
    out.uv[i * 2] = p.uv[v * 2]; out.uv[i * 2 + 1] = p.uv[v * 2 + 1];
  }
  return out;
}

/**
 * Re-partition components larger than `maxSize` (bbox diagonal) into spatial chunks (grid cells of maxSize), so that
 * long thin pieces (twig stems) can be distributed over several impostor cards. Returns a comps-like object.
 */
export function chunkComponents(p, comps, maxSize) {
  const { pos, idx } = p;
  const nt = idx.length / 3;
  const key = new Float64Array(nt); // sortable chunk key per triangle
  const big = new Uint8Array(comps.count);
  let anyBig = false;
  for (let c = 0; c < comps.count; c++) {
    const d = Math.hypot(comps.bmax[c * 3] - comps.bmin[c * 3], comps.bmax[c * 3 + 1] - comps.bmin[c * 3 + 1], comps.bmax[c * 3 + 2] - comps.bmin[c * 3 + 2]);
    if (d > maxSize) { big[c] = 1; anyBig = true; }
  }
  if (!anyBig) return comps;
  const groups = new Map(); // key string -> tri list
  const order = [];
  for (let c = 0; c < comps.count; c++) {
    if (!big[c]) { order.push({ tris: comps.triList.subarray(comps.start[c], comps.start[c + 1]) }); continue; }
    const local = new Map();
    for (let k = comps.start[c]; k < comps.start[c + 1]; k++) {
      const t = comps.triList[k], a = idx[t * 3], b = idx[t * 3 + 1], d = idx[t * 3 + 2];
      const gx = Math.floor((pos[a * 3] + pos[b * 3] + pos[d * 3]) / 3 / maxSize), gy = Math.floor((pos[a * 3 + 1] + pos[b * 3 + 1] + pos[d * 3 + 1]) / 3 / maxSize), gz = Math.floor((pos[a * 3 + 2] + pos[b * 3 + 2] + pos[d * 3 + 2]) / 3 / maxSize);
      const kk = `${gx},${gy},${gz}`;
      let l = local.get(kk);
      if (!l) { l = []; local.set(kk, l); }
      l.push(t);
    }
    for (const l of local.values()) order.push({ tris: Uint32Array.from(l) });
  }
  const count = order.length;
  const out = { count, tris: new Uint32Array(count), area: new Float64Array(count), cen: new Float64Array(count * 3), bmin: new Float32Array(count * 3).fill(Infinity), bmax: new Float32Array(count * 3).fill(-Infinity), start: new Uint32Array(count + 1), triList: new Uint32Array(nt), totalArea: comps.totalArea };
  let w = 0;
  order.forEach((o, c) => {
    out.start[c] = w; out.tris[c] = o.tris.length;
    for (const t of o.tris) {
      out.triList[w++] = t;
      const a = idx[t * 3], b = idx[t * 3 + 1], d = idx[t * 3 + 2];
      const ar = triArea(pos, a, b, d) + 1e-12;
      out.area[c] += ar;
      for (let k = 0; k < 3; k++) {
        const pa = pos[a * 3 + k], pb = pos[b * 3 + k], pd = pos[d * 3 + k];
        out.cen[c * 3 + k] += (ar * (pa + pb + pd)) / 3;
        out.bmin[c * 3 + k] = Math.min(out.bmin[c * 3 + k], pa, pb, pd); out.bmax[c * 3 + k] = Math.max(out.bmax[c * 3 + k], pa, pb, pd);
      }
    }
    for (let k = 0; k < 3; k++) out.cen[c * 3 + k] /= out.area[c];
  });
  out.start[count] = w;
  return out;
}
