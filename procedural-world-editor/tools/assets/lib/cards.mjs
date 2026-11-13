// Cluster cards: impostor-card LODs for dense foliage.
//
// Poly Haven conifers model every needle as its own strip (10^5..10^6 connected components per tree) and broadleaf
// trees carry tens of thousands of leaf cards. Edge collapse shreds such geometry, and culling + scaling components
// only works down to a point (a needle scaled 7x is a palm leaf). Below that point the fine foliage (cards, needles
// and thin twigs) is clustered into compact groups of a given physical size (a "sprig" for lod0, a "bough" for the
// lower LODs); representative clusters are rasterised orthographically into a texture atlas (albedo + alpha,
// tangent-space normal, ORM) - along the cluster's thinnest PCA axis and, for thick clusters, also from the side -
// and every cluster is replaced by one or two quads showing the atlas tile whose size / aspect / colour matches best.
// Each card therefore shows the foliage at its true scale, so the crown keeps its silhouette and density.
import sharp from 'sharp';
import { bleedColor } from './modeltex.mjs';

// ------------------------------------------------------------------ small linear algebra
function eigenSym3(m) {
  // Jacobi eigen-decomposition of a symmetric 3x3 (a = [xx,xy,xz,yy,yz,zz]); returns axes sorted by descending eigenvalue
  const a = [[m[0], m[1], m[2]], [m[1], m[3], m[4]], [m[2], m[4], m[5]]];
  const v = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
  for (let sweep = 0; sweep < 24; sweep++) {
    let off = Math.abs(a[0][1]) + Math.abs(a[0][2]) + Math.abs(a[1][2]);
    if (off < 1e-18) break;
    for (const [p, q] of [[0, 1], [0, 2], [1, 2]]) {
      if (Math.abs(a[p][q]) < 1e-300) continue;
      const theta = (a[q][q] - a[p][p]) / (2 * a[p][q]);
      const t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
      const c = 1 / Math.sqrt(t * t + 1), s = t * c;
      for (let k = 0; k < 3; k++) { const akp = a[k][p], akq = a[k][q]; a[k][p] = c * akp - s * akq; a[k][q] = s * akp + c * akq; }
      for (let k = 0; k < 3; k++) { const apk = a[p][k], aqk = a[q][k]; a[p][k] = c * apk - s * aqk; a[q][k] = s * apk + c * aqk; }
      for (let k = 0; k < 3; k++) { const vkp = v[k][p], vkq = v[k][q]; v[k][p] = c * vkp - s * vkq; v[k][q] = s * vkp + c * vkq; }
    }
  }
  const order = [0, 1, 2].sort((i, j) => a[j][j] - a[i][i]);
  return { values: order.map((i) => Math.max(0, a[i][i])), axes: order.map((i) => [v[0][i], v[1][i], v[2][i]]) };
}
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a) => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };

// ------------------------------------------------------------------ clustering

/**
 * Split items (centroid + weight) into `count` spatial clusters: repeatedly bisect the cluster with the largest spread
 * along its principal axis, at the weighted median. Deterministic. Returns arrays of item indices.
 * @param cen Float64Array(3n) @param w Float64Array(n)
 */
export function clusterItems(cen, w, count) {
  const n = w.length;
  const stat = (ids) => {
    let sw = 0, mx = 0, my = 0, mz = 0;
    for (const i of ids) { const ww = w[i]; sw += ww; mx += cen[i * 3] * ww; my += cen[i * 3 + 1] * ww; mz += cen[i * 3 + 2] * ww; }
    mx /= sw; my /= sw; mz /= sw;
    const c = [0, 0, 0, 0, 0, 0];
    for (const i of ids) {
      const ww = w[i], x = cen[i * 3] - mx, y = cen[i * 3 + 1] - my, z = cen[i * 3 + 2] - mz;
      c[0] += ww * x * x; c[1] += ww * x * y; c[2] += ww * x * z; c[3] += ww * y * y; c[4] += ww * y * z; c[5] += ww * z * z;
    }
    const e = eigenSym3(c.map((v) => v / sw));
    return { ids, sw, mean: [mx, my, mz], axis: e.axes[0], spread: Math.sqrt(e.values[0]), prio: ids.length > 1 ? Math.sqrt(e.values[0]) * Math.pow(sw, 1 / 6) : 0 };
  };
  const split = (cl) => {
    const { ids, axis, mean } = cl;
    const proj = new Float64Array(n > 0 ? ids.length : 0);
    for (let k = 0; k < ids.length; k++) { const i = ids[k]; proj[k] = (cen[i * 3] - mean[0]) * axis[0] + (cen[i * 3 + 1] - mean[1]) * axis[1] + (cen[i * 3 + 2] - mean[2]) * axis[2]; }
    const ord = Uint32Array.from(ids.keys()).sort((a, b) => proj[a] - proj[b] || a - b);
    let acc = 0, cut = 1;
    for (let k = 0; k < ord.length; k++) { acc += w[ids[ord[k]]]; if (acc >= cl.sw / 2) { cut = Math.min(ord.length - 1, Math.max(1, k + 1)); break; } }
    const a = new Uint32Array(cut), b = new Uint32Array(ord.length - cut);
    for (let k = 0; k < cut; k++) a[k] = ids[ord[k]];
    for (let k = cut; k < ord.length; k++) b[k - cut] = ids[ord[k]];
    return [stat(a), stat(b)];
  };
  let clusters = [stat(Uint32Array.from({ length: n }, (_, i) => i))];
  count = Math.min(count, n);
  while (clusters.length < count) {
    clusters.sort((a, b) => b.prio - a.prio);
    if (clusters[0].prio <= 0) break;
    // split the upper part of the queue in one round (keeps the result independent of heap details and fast)
    const need = count - clusters.length;
    let m = 0;
    while (m < clusters.length && m < need && clusters[m].prio > clusters[0].prio * 0.6) m++;
    const next = clusters.slice(m);
    for (let k = 0; k < m; k++) next.push(...split(clusters[k]));
    clusters = next;
  }
  return clusters.map((c) => c.ids);
}

// ------------------------------------------------------------------ source textures for the rasteriser

const texCache = new Map();
/** Load a material's maps as a mip pyramid: rgba (albedo + alpha) and orm. */
export function loadSourceTexture(mat, size = 1024) {
  const key = `${mat.base?.file}|${mat.alphaFile}|${mat.mr?.file}|${size}`;
  if (!texCache.has(key)) texCache.set(key, (async () => {
    const raw = async (file, ch) => {
      const img = sharp(file).removeAlpha();
      const { data, info } = await (ch === 1 ? img.toColourspace('b-w') : img.toColourspace('srgb')).resize(size, size, { fit: 'fill', kernel: 'lanczos3' }).raw({ depth: 'uchar' }).toBuffer({ resolveWithObject: true });
      return { data, ch: info.channels };
    };
    const rgb = mat.base ? await raw(mat.base.file, 3) : null;
    const al = mat.alphaFile ? await raw(mat.alphaFile, 1) : null;
    const orm = mat.mr ? await raw(mat.mr.file, 3) : null;
    const px = new Float32Array(size * size * 7); // r g b a | ao rough metal
    for (let i = 0; i < size * size; i++) {
      for (let c = 0; c < 3; c++) px[i * 7 + c] = rgb ? rgb.data[i * rgb.ch + Math.min(c, rgb.ch - 1)] : 128;
      px[i * 7 + 3] = al ? al.data[i * al.ch] : 255;
      if (orm) {
        const g = orm.ch === 1 || mat.mrKind === 'rough';
        px[i * 7 + 4] = mat.mrKind === 'arm' ? orm.data[i * orm.ch] : 255;
        px[i * 7 + 5] = g ? orm.data[i * orm.ch] : orm.data[i * orm.ch + 1];
        px[i * 7 + 6] = g ? 0 : orm.data[i * orm.ch + 2] * (mat.metallicFactor ?? 1);
      } else { px[i * 7 + 4] = 255; px[i * 7 + 5] = 255 * (mat.roughnessFactor ?? 1); px[i * 7 + 6] = 0; }
    }
    if (al) {
      // bleed albedo into transparent texels so bilinear taps near cut-out edges stay clean
      const c3 = new Float32Array(size * size * 3), valid = new Uint8Array(size * size);
      for (let i = 0; i < size * size; i++) { c3[i * 3] = px[i * 7]; c3[i * 3 + 1] = px[i * 7 + 1]; c3[i * 3 + 2] = px[i * 7 + 2]; valid[i] = px[i * 7 + 3] >= 160 ? 1 : 0; }
      bleedColor(c3, valid, size, size);
      for (let i = 0; i < size * size; i++) { px[i * 7] = c3[i * 3]; px[i * 7 + 1] = c3[i * 3 + 1]; px[i * 7 + 2] = c3[i * 3 + 2]; }
    }
    const mips = [{ size, px }];
    while (mips.at(-1).size > 8) {
      const s = mips.at(-1), ns = s.size >> 1, np = new Float32Array(ns * ns * 7);
      for (let y = 0; y < ns; y++) for (let x = 0; x < ns; x++) for (let c = 0; c < 7; c++) {
        np[(y * ns + x) * 7 + c] = (s.px[((2 * y) * s.size + 2 * x) * 7 + c] + s.px[((2 * y) * s.size + 2 * x + 1) * 7 + c] + s.px[((2 * y + 1) * s.size + 2 * x) * 7 + c] + s.px[((2 * y + 1) * s.size + 2 * x + 1) * 7 + c]) / 4;
      }
      mips.push({ size: ns, px: np });
    }
    let cov = 1;
    if (al) { let c = 0; for (let i = 0; i < size * size; i++) if (px[i * 7 + 3] >= 128) c++; cov = Math.max(0.05, c / (size * size)); }
    return { mips, hasAlpha: !!al, coverage: cov };
  })());
  return texCache.get(key);
}

function sample(tex, level, u, v, out) {
  const m = tex.mips[Math.max(0, Math.min(tex.mips.length - 1, level))];
  const s = m.size;
  let fx = (u - Math.floor(u)) * s - 0.5, fy = (v - Math.floor(v)) * s - 0.5;
  const x0 = Math.floor(fx), y0 = Math.floor(fy), tx = fx - x0, ty = fy - y0;
  const xa = ((x0 % s) + s) % s, xb = (xa + 1) % s, ya = ((y0 % s) + s) % s, yb = (ya + 1) % s;
  const p = m.px, i00 = (ya * s + xa) * 7, i10 = (ya * s + xb) * 7, i01 = (yb * s + xa) * 7, i11 = (yb * s + xb) * 7;
  const w00 = (1 - tx) * (1 - ty), w10 = tx * (1 - ty), w01 = (1 - tx) * ty, w11 = tx * ty;
  for (let c = 0; c < 7; c++) out[c] = p[i00 + c] * w00 + p[i10 + c] * w10 + p[i01 + c] * w01 + p[i11 + c] * w11;
}

// ------------------------------------------------------------------ card frames

/** PCA frame + extents of a set of components (over their triangle corners). parts: [{prim, comps, ids}] */
export function clusterFrame(parts) {
  let n = 0, mx = 0, my = 0, mz = 0;
  const each = (fn) => {
    for (const { prim, comps, ids } of parts) for (const c of ids) for (let k = comps.start[c]; k < comps.start[c + 1]; k++) {
      const t = comps.triList[k];
      for (let j = 0; j < 3; j++) { const v = prim.idx[t * 3 + j]; fn(prim.pos[v * 3], prim.pos[v * 3 + 1], prim.pos[v * 3 + 2]); }
    }
  };
  each((x, y, z) => { n++; mx += x; my += y; mz += z; });
  mx /= n; my /= n; mz /= n;
  const cov = [0, 0, 0, 0, 0, 0];
  each((x, y, z) => { x -= mx; y -= my; z -= mz; cov[0] += x * x; cov[1] += x * y; cov[2] += x * z; cov[3] += y * y; cov[4] += y * z; cov[5] += z * z; });
  const e = eigenSym3(cov.map((v) => v / n));
  let e1 = norm(e.axes[0]), e3 = norm(e.axes[2]);
  let e2 = norm(cross(e3, e1)); e3 = norm(cross(e1, e2));
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  each((x, y, z) => {
    const d = [x - mx, y - my, z - mz];
    const q = [dot(d, e1), dot(d, e2), dot(d, e3)];
    for (let k = 0; k < 3; k++) { if (q[k] < lo[k]) lo[k] = q[k]; if (q[k] > hi[k]) hi[k] = q[k]; }
  });
  return { c: [mx, my, mz], e1, e2, e3, lo, hi, n };
}

/** Like clusterFrame, but with a prescribed card normal e3 (the card faces that way; e1 is horizontal). */
export function clusterFrameFacing(parts, e3) {
  let n = 0, mx = 0, my = 0, mz = 0;
  const each = (fn) => {
    for (const { prim, comps, ids } of parts) for (const c of ids) for (let k = comps.start[c]; k < comps.start[c + 1]; k++) {
      const t = comps.triList[k];
      for (let j = 0; j < 3; j++) { const v = prim.idx[t * 3 + j]; fn(prim.pos[v * 3], prim.pos[v * 3 + 1], prim.pos[v * 3 + 2]); }
    }
  };
  each((x, y, z) => { n++; mx += x; my += y; mz += z; });
  mx /= n; my /= n; mz /= n;
  e3 = norm(e3);
  let e1 = cross([0, 1, 0], e3);
  e1 = Math.hypot(...e1) < 1e-4 ? [1, 0, 0] : norm(e1);
  const e2 = norm(cross(e3, e1));
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  each((x, y, z) => {
    const d = [x - mx, y - my, z - mz];
    const q = [dot(d, e1), dot(d, e2), dot(d, e3)];
    for (let k = 0; k < 3; k++) { if (q[k] < lo[k]) lo[k] = q[k]; if (q[k] > hi[k]) hi[k] = q[k]; }
  });
  return { c: [mx, my, mz], e1, e2, e3, lo, hi, n };
}

// ------------------------------------------------------------------ rasteriser

/**
 * Rasterise the triangles of a cluster into a square tile, looking down -e3 (front = +e3 side).
 * Returns Float32 layers at tile resolution: rgb, alpha(0..1), normal (tangent space), orm.
 */
function rasterTile(frame, parts, textures, T, ss = 2, margin = 0.04) {
  const W = T * ss;
  const zbuf = new Float32Array(W * W).fill(-Infinity);
  const lay = new Float32Array(W * W * 9); // r g b | nx ny nz | ao rough metal
  const hit = new Uint8Array(W * W);
  const { c, e1, e2, e3, lo, hi } = frame;
  // uniform scale (texels stay square in world space, so mip selection on the card is isotropic); the cluster is
  // anchored at the top-left corner of the tile and the card's UVs address only the used rectangle
  const sx = (W * (1 - 2 * margin)) / Math.max(1e-9, hi[0] - lo[0], hi[1] - lo[1]), sy = sx;
  const ox = W * margin, oy = W * margin;
  const smp = new Float32Array(7);
  parts.forEach(({ prim, comps, ids }, pi) => {
    const tex = textures[pi];
    const { pos, uv, nrm, idx } = prim;
    const P = [[0, 0, 0], [0, 0, 0], [0, 0, 0]], UV = [[0, 0], [0, 0], [0, 0]], N = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
    for (const cid of ids) for (let k = comps.start[cid]; k < comps.start[cid + 1]; k++) {
      const t = comps.triList[k];
      for (let j = 0; j < 3; j++) {
        const v = idx[t * 3 + j];
        const d = [pos[v * 3] - c[0], pos[v * 3 + 1] - c[1], pos[v * 3 + 2] - c[2]];
        P[j][0] = ox + (dot(d, e1) - lo[0]) * sx; P[j][1] = oy + (hi[1] - dot(d, e2)) * sy; P[j][2] = dot(d, e3);
        UV[j][0] = uv[v * 2]; UV[j][1] = uv[v * 2 + 1];
        const nn = [nrm[v * 3], nrm[v * 3 + 1], nrm[v * 3 + 2]];
        N[j][0] = dot(nn, e1); N[j][1] = dot(nn, e2); N[j][2] = dot(nn, e3);
      }
      const area = (P[1][0] - P[0][0]) * (P[2][1] - P[0][1]) - (P[2][0] - P[0][0]) * (P[1][1] - P[0][1]);
      if (Math.abs(area) < 1e-9) continue;
      // mip level from the texel/pixel area ratio
      const uvArea = Math.abs((UV[1][0] - UV[0][0]) * (UV[2][1] - UV[0][1]) - (UV[2][0] - UV[0][0]) * (UV[1][1] - UV[0][1]));
      const s0 = tex.mips[0].size;
      const level = Math.max(0, Math.round(0.5 * Math.log2(Math.max(1e-12, (uvArea * s0 * s0) / Math.abs(area))) - 0.5));
      const x0 = Math.max(0, Math.floor(Math.min(P[0][0], P[1][0], P[2][0]))), x1 = Math.min(W - 1, Math.ceil(Math.max(P[0][0], P[1][0], P[2][0])));
      const y0 = Math.max(0, Math.floor(Math.min(P[0][1], P[1][1], P[2][1]))), y1 = Math.min(W - 1, Math.ceil(Math.max(P[0][1], P[1][1], P[2][1])));
      const inv = 1 / area;
      for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
        const qx = x + 0.5, qy = y + 0.5;
        const w0 = ((P[1][0] - qx) * (P[2][1] - qy) - (P[2][0] - qx) * (P[1][1] - qy)) * inv;
        const w1 = ((P[2][0] - qx) * (P[0][1] - qy) - (P[0][0] - qx) * (P[2][1] - qy)) * inv;
        const w2 = 1 - w0 - w1;
        if (w0 < 0 || w1 < 0 || w2 < 0) continue;
        const z = w0 * P[0][2] + w1 * P[1][2] + w2 * P[2][2];
        const o = y * W + x;
        if (z <= zbuf[o]) continue;
        sample(tex, level, w0 * UV[0][0] + w1 * UV[1][0] + w2 * UV[2][0], w0 * UV[0][1] + w1 * UV[1][1] + w2 * UV[2][1], smp);
        if (tex.hasAlpha && smp[3] < 96) continue;
        zbuf[o] = z; hit[o] = 1;
        let nx = w0 * N[0][0] + w1 * N[1][0] + w2 * N[2][0], ny = w0 * N[0][1] + w1 * N[1][1] + w2 * N[2][1], nz = w0 * N[0][2] + w1 * N[1][2] + w2 * N[2][2];
        if (nz < 0) { nx = -nx; ny = -ny; nz = -nz; }
        const l = Math.hypot(nx, ny, nz) || 1;
        const b = o * 9;
        lay[b] = smp[0]; lay[b + 1] = smp[1]; lay[b + 2] = smp[2];
        lay[b + 3] = nx / l; lay[b + 4] = ny / l; lay[b + 5] = nz / l;
        lay[b + 6] = smp[4]; lay[b + 7] = smp[5]; lay[b + 8] = smp[6];
      }
    }
  });
  // depth-based occlusion: fragments deep inside the cluster are darker
  const thick = Math.max(1e-6, hi[2] - lo[2]);
  const out = { rgb: new Float32Array(T * T * 3), alpha: new Float32Array(T * T), nrm: new Float32Array(T * T * 3), orm: new Float32Array(T * T * 3) };
  for (let y = 0; y < T; y++) for (let x = 0; x < T; x++) {
    let n = 0; const acc = new Float64Array(9);
    for (let dy = 0; dy < ss; dy++) for (let dx = 0; dx < ss; dx++) {
      const o = (y * ss + dy) * W + x * ss + dx;
      if (!hit[o]) continue;
      n++;
      const depth = Math.min(1, Math.max(0, (hi[2] - zbuf[o]) / thick));
      // fragments deep inside the cluster are self-shadowed: darken albedo a little and occlusion more
      const shade = 1 - 0.12 * depth;
      for (let k = 0; k < 3; k++) acc[k] += lay[o * 9 + k] * shade;
      for (let k = 3; k < 9; k++) acc[k] += lay[o * 9 + k];
      acc[6] += -lay[o * 9 + 6] * 0.3 * depth; // AO *= (1 - 0.3 depth)
    }
    const i = y * T + x;
    out.alpha[i] = n / (ss * ss);
    if (!n) continue;
    for (let k = 0; k < 3; k++) { out.rgb[i * 3 + k] = acc[k] / n; out.orm[i * 3 + k] = acc[6 + k] / n; }
    const l = Math.hypot(acc[3], acc[4], acc[5]) || 1;
    out.nrm[i * 3] = acc[3] / l; out.nrm[i * 3 + 1] = acc[4] / l; out.nrm[i * 3 + 2] = acc[5] / l;
  }
  return out;
}

// ------------------------------------------------------------------ public: build card LOD

/**
 * @param parts   [{ prim, comps, ids:number[] , mat }]  fine geometry to represent (ids = component ids per part)
 * @param opts    { maxCards, cardSize (m, target longest extent of a cluster), atlas (px), tiles (per side),
 *                  treeAxis:[x,z], planes (1|2), alphaCutoff,
 *                  facing: 'pca' (card in the cluster's own best-fit plane, plus a side-on plane for thick clusters)
 *                        | 'out' (one card per cluster facing away from the trunk axis and upwards: seen from outside or
 *                          above it is always front-facing, which keeps far LODs free of dark back-faces) }
 * @returns {{ prim, textures:{baseColor,normal,orm,sizes}, clusters, cards, cardSize }}
 */
export async function buildCardLod(parts, { maxCards, cardSize, atlas = 2048, tiles = 4, treeAxis = [0, 0], planes = 2, facing = 'pca', thickRatio = 0.3, alphaCutoff = 0.4, floorTight = 0.86, floorWide = 0.6, coverageBoost = 1, shade = 1, crown = 0.7, roughen = 0.6 }) {
  const textures = await Promise.all(parts.map((p) => loadSourceTexture(p.mat)));
  // ---- items = components
  let n = 0;
  for (const p of parts) n += p.ids.length;
  const cen = new Float64Array(n * 3), w = new Float64Array(n), ref = new Uint32Array(n * 2);
  let k = 0;
  parts.forEach((p, pi) => {
    // opaque fraction of the cut-out texture inside the triangles that actually use it (sampled)
    let cov = 1;
    if (textures[pi].hasAlpha) {
      const smp = new Float32Array(7); let hit = 0, tot = 0;
      const nt = p.prim.idx.length / 3, stride = Math.max(1, Math.floor(nt / 40000));
      const B = [[1 / 3, 1 / 3, 1 / 3], [0.6, 0.2, 0.2], [0.2, 0.6, 0.2], [0.2, 0.2, 0.6]];
      for (let t = 0; t < nt; t += stride) {
        const a = p.prim.idx[t * 3], b = p.prim.idx[t * 3 + 1], c = p.prim.idx[t * 3 + 2];
        for (const bw of B) {
          sample(textures[pi], 1, bw[0] * p.prim.uv[a * 2] + bw[1] * p.prim.uv[b * 2] + bw[2] * p.prim.uv[c * 2], bw[0] * p.prim.uv[a * 2 + 1] + bw[1] * p.prim.uv[b * 2 + 1] + bw[2] * p.prim.uv[c * 2 + 1], smp);
          tot++; if (smp[3] >= 128) hit++;
        }
      }
      cov = Math.max(0.05, hit / Math.max(1, tot));
    }
    for (const c of p.ids) { cen[k * 3] = p.comps.cen[c * 3]; cen[k * 3 + 1] = p.comps.cen[c * 3 + 1]; cen[k * 3 + 2] = p.comps.cen[c * 3 + 2]; w[k] = p.comps.area[c] * cov + 1e-9; ref[k * 2] = pi; ref[k * 2 + 1] = c; k++; }
  });
  // mean albedo per item (one mip-mapped tap at the first triangle's centroid) - used to match clusters with atlas tiles
  const itemCol = new Float32Array(n * 3);
  {
    const smp = new Float32Array(7);
    for (let i = 0; i < n; i++) {
      const p = parts[ref[i * 2]], t = p.comps.triList[p.comps.start[ref[i * 2 + 1]]];
      const a = p.prim.idx[t * 3], b = p.prim.idx[t * 3 + 1], c = p.prim.idx[t * 3 + 2];
      sample(textures[ref[i * 2]], 3, (p.prim.uv[a * 2] + p.prim.uv[b * 2] + p.prim.uv[c * 2]) / 3, (p.prim.uv[a * 2 + 1] + p.prim.uv[b * 2 + 1] + p.prim.uv[c * 2 + 1]) / 3, smp);
      itemCol[i * 3] = smp[0]; itemCol[i * 3 + 1] = smp[1]; itemCol[i * 3 + 2] = smp[2];
    }
  }
  // "crown" direction at a point: away from the trunk axis and upwards
  const outDir = (c) => norm([c[0] - treeAxis[0], 0.6 * Math.hypot(c[0] - treeAxis[0], c[2] - treeAxis[1]) + 0.25, c[2] - treeAxis[1]]);
  const mk = (count) => clusterItems(cen, w, count).map((ids) => {
    const cp = parts.map((p) => ({ prim: p.prim, comps: p.comps, ids: [] }));
    for (const i of ids) cp[ref[i * 2]].ids.push(ref[i * 2 + 1]);
    const used = cp.filter((p) => p.ids.length);
    let area = 0; const col = [0, 0, 0];
    for (const i of ids) { area += w[i]; col[0] += itemCol[i * 3] * w[i]; col[1] += itemCol[i * 3 + 1] * w[i]; col[2] += itemCol[i * 3 + 2] * w[i]; }
    let frame = clusterFrame(used);
    if (facing === 'out') frame = clusterFrameFacing(used, outDir(frame.c));
    return { parts: cp, frame, area, items: ids.length, color: col.map((v) => v / area) };
  });
  const isThick = (c) => (c.frame.hi[2] - c.frame.lo[2]) > thickRatio * (c.frame.hi[1] - c.frame.lo[1]) && (c.frame.hi[2] - c.frame.lo[2]) > 0.15 * cardSize && c.items > 1;
  // area-weighted mean of the longest cluster extent
  const sizeOf = (cl) => { let sa = 0, ss = 0; for (const c of cl) { sa += c.area; ss += c.area * Math.max(c.frame.hi[0] - c.frame.lo[0], c.frame.hi[1] - c.frame.lo[1]); } return ss / sa; };

  // ---- cluster count: as many clusters as needed for the target card size, never more than the budget allows
  let count = Math.max(1, Math.min(maxCards, n));
  let clusters = mk(count);
  let size = sizeOf(clusters);
  let prev = null, exp = 2.4;
  for (let it = 0; it < 6 && size < cardSize * 0.9 && count > 1; it++) {
    if (prev && prev.count !== count && Math.abs(Math.log(size / prev.size)) > 1e-3) exp = Math.min(4, Math.max(1.2, Math.log(prev.count / count) / Math.log(size / prev.size)));
    const next = Math.max(1, Math.min(count - 1, Math.round(count * Math.pow(size / cardSize, exp))));
    prev = { count, size };
    count = next; clusters = mk(count); size = sizeOf(clusters);
  }

  // ---- views: primary plane per cluster + a side-on plane for thick clusters (as far as the budget allows)
  const view = (c, primary) => {
    const f = c.frame;
    const frame = primary ? f : { c: f.c, e1: f.e1, e2: f.e3, e3: f.e2.map((x) => -x), lo: [f.lo[0], f.lo[2], -f.hi[1]], hi: [f.hi[0], f.hi[2], -f.lo[1]] };
    return { frame, cluster: c, primary };
  };
  const cardList = clusters.map((c) => view(c, true));
  if (planes > 1 && facing !== 'out') {
    const thick = clusters.filter(isThick).sort((a, b) => (b.frame.hi[2] - b.frame.lo[2]) * b.area - (a.frame.hi[2] - a.frame.lo[2]) * a.area);
    for (const c of thick.slice(0, Math.max(0, maxCards - clusters.length))) cardList.push(view(c, false));
  }
  const ext = (cd) => [cd.frame.hi[0] - cd.frame.lo[0], cd.frame.hi[1] - cd.frame.lo[1]];
  const sizeKey = (cd) => Math.max(...ext(cd));

  // ---- representatives. Few views: every view gets its own tile (exact bake). Otherwise: `tiles` size bands,
  // and inside each band k-means over (aspect ratio, mean colour) so that e.g. flowers and leaves get separate tiles.
  const feat = (cd) => { const e = ext(cd); const c = cd.cluster.color; return [Math.log((e[1] + 1e-6) / (e[0] + 1e-6)) * 1.2, c[0] / 45, c[1] / 45, c[2] / 45, cd.primary ? 0 : 0.6]; };
  const fdist = (x, y) => (x[0] - y[0]) ** 2 + (x[1] - y[1]) ** 2 + (x[2] - y[2]) ** 2 + (x[3] - y[3]) ** 2 + (x[4] - y[4]) ** 2;
  const density = (cd) => cd.cluster.area / (ext(cd)[0] * ext(cd)[1] + 1e-9);
  let reps = [], repBand = [], sizeEdges = [];
  if (cardList.length <= tiles * tiles) { reps = cardList; repBand = cardList.map(() => 0); }
  else {
    // size bands hold equal shares of foliage area (not equal card counts), so tiles go where the foliage is
    const bySize = [...cardList].sort((a, b) => sizeKey(a) - sizeKey(b) || a.cluster.items - b.cluster.items);
    const cum = new Float64Array(bySize.length + 1);
    bySize.forEach((cd, i) => { cum[i + 1] = cum[i] + cd.cluster.area * (cd.primary ? 1 : 0.5); });
    const cut = [0];
    for (let b = 1; b < tiles; b++) { let i = cut[b - 1] + 1; while (i < bySize.length - (tiles - b) && cum[i] < (cum[bySize.length] * b) / tiles) i++; cut.push(Math.min(i, bySize.length - 1)); }
    cut.push(bySize.length);
    for (let b = 1; b < tiles; b++) sizeEdges.push(sizeKey(bySize[cut[b]]));
    for (let b = 0; b < tiles; b++) {
      const band = bySize.slice(cut[b], Math.max(cut[b + 1], cut[b] + 1));
      const F = band.map(feat);
      // deterministic farthest-point initialisation + Lloyd iterations
      const mean = [0, 1, 2, 3, 4].map((q) => F.reduce((s, f) => s + f[q], 0) / F.length);
      let cents = [F.reduce((best, f) => (fdist(f, mean) < fdist(best, mean) ? f : best), F[0])];
      while (cents.length < Math.min(tiles, F.length)) {
        let far = F[0], fd = -1;
        for (const f of F) { let d = Infinity; for (const c of cents) d = Math.min(d, fdist(f, c)); if (d > fd) { fd = d; far = f; } }
        cents.push(far);
      }
      const assign = new Int32Array(F.length);
      for (let it = 0; it < 8; it++) {
        F.forEach((f, i) => { let bi = 0, bd = Infinity; cents.forEach((c, q) => { const d = fdist(f, c); if (d < bd) { bd = d; bi = q; } }); assign[i] = bi; });
        cents = cents.map((c, q) => { const m = [0, 0, 0, 0, 0]; let cnt = 0; F.forEach((f, i) => { if (assign[i] === q) { cnt++; for (let j = 0; j < 5; j++) m[j] += f[j]; } }); return cnt ? m.map((v) => v / cnt) : c; });
      }
      cents.forEach((c, q) => {
        // representative = a well-filled member among those closest to the centroid
        const members = band.map((cd, i) => ({ cd, d: fdist(F[i], c), q: assign[i] })).filter((m) => m.q === q).sort((x, y) => x.d - y.d);
        const pool = (members.length ? members : band.map((cd, i) => ({ cd, d: fdist(F[i], c) })).sort((x, y) => x.d - y.d)).slice(0, Math.max(1, Math.ceil(members.length * 0.25)));
        reps.push(pool.sort((x, y) => density(y.cd) - density(x.cd))[Math.floor(pool.length * 0.25)].cd); repBand.push(b);
      });
    }
  }
  const repFeat = reps.map(feat);

  // ---- bake atlas
  const T = atlas / tiles;
  const margin = 0.04;
  const A = { cover: new Uint8Array(atlas * atlas), rgb: new Float32Array(atlas * atlas * 3), alpha: new Float32Array(atlas * atlas), nrm: new Float32Array(atlas * atlas * 3), orm: new Float32Array(atlas * atlas * 3) };
  reps.forEach((rep, ti) => {
    const used = [], tex = [];
    rep.cluster.parts.forEach((p, pi) => { if (p.ids.length) { used.push(p); tex.push(textures[pi]); } });
    const tile = rasterTile(rep.frame, used, tex, T, T >= 256 ? 2 : 3, margin);
    // Coverage-preserving alpha: pick the per-tile coverage threshold `th` such that the share of texels passing
    // the alpha test equals the true projected coverage of the cluster (x coverageBoost). Where needles/leaves are
    // resolved th ~ 0.5; on coarse tiles (lower LODs) sub-texel foliage would otherwise fail the test and vanish.
    let C = 0;
    for (let i = 0; i < T * T; i++) C += tile.alpha[i];
    C /= T * T;
    const sorted = Float32Array.from(tile.alpha).sort();
    const th = Math.min(0.5, Math.max(0.1, sorted[Math.max(0, Math.min(T * T - 1, Math.round(T * T * (1 - Math.min(0.98, C * coverageBoost)))))]));
    const g = alphaCutoff / th;
    // "Alpha floor": gaps inside locally dense foliage keep a sub-cutoff alpha, in two tiers. Up close every gap is
    // still cut out. As the card is minified the averaged alpha first stays above the cut-off along each spray (tight
    // tier: the gaps between the needles of one spray), then over the whole bough (wide tier), so the card degrades
    // needles -> fronds -> bough silhouette instead of dissolving (the alpha-test + mip-mapping failure of thin needles).
    const pass = new Float32Array(T * T);
    for (let i = 0; i < T * T; i++) pass[i] = tile.alpha[i] >= th ? 1 : 0;
    const blur = (src, r) => {
      let cur = src;
      for (let p = 0; p < 2; p++) for (const horizontal of [true, false]) {
        const dst = new Float32Array(T * T);
        for (let y = 0; y < T; y++) for (let x = 0; x < T; x++) {
          let sum = 0;
          for (let d = -r; d <= r; d++) { const xx = horizontal ? Math.min(T - 1, Math.max(0, x + d)) : x, yy = horizontal ? y : Math.min(T - 1, Math.max(0, y + d)); sum += cur[yy * T + xx]; }
          dst[y * T + x] = sum / (2 * r + 1);
        }
        cur = dst;
      }
      return cur;
    };
    const tight = blur(pass, Math.max(2, Math.round(T / 40))), wide = blur(pass, Math.max(3, Math.round(T / 12)));
    const step = (v, a, b) => { const t = Math.min(1, Math.max(0, (v - a) / (b - a))); return t * t * (3 - 2 * t); };
    const m0 = Math.ceil(T * margin * 0.5);
    const tx = (ti % tiles) * T, ty = Math.floor(ti / tiles) * T;
    for (let y = 0; y < T; y++) for (let x = 0; x < T; x++) {
      const s = y * T + x, d = (ty + y) * atlas + tx + x;
      const inside = x >= m0 && y >= m0 && x < T - m0 && y < T - m0;
      const fl = Math.max(step(tight[s], 0.12, 0.32) * floorTight, step(wide[s], 0.08, 0.25) * floorWide) * alphaCutoff;
      A.alpha[d] = inside ? Math.min(1, Math.max(tile.alpha[s] * g, fl)) : 0;
      A.cover[d] = tile.alpha[s] > 0 ? 1 : 0;
      for (let c = 0; c < 3; c++) { A.rgb[d * 3 + c] = tile.rgb[s * 3 + c] * shade; A.nrm[d * 3 + c] = tile.nrm[s * 3 + c]; A.orm[d * 3 + c] = tile.orm[s * 3 + c]; }
      // a card stands in for many differently oriented leaves: as a macro surface it is much rougher than one leaf
      A.orm[d * 3 + 1] = 255 - (255 - A.orm[d * 3 + 1]) * (1 - roughen);
    }
  });
  // fill uncovered texels (colour, normal and orm) from their neighbourhood, then encode
  const nrm8 = new Float32Array(atlas * atlas * 3);
  for (let i = 0; i < atlas * atlas; i++) { nrm8[i * 3] = (A.nrm[i * 3] * 0.5 + 0.5) * 255; nrm8[i * 3 + 1] = (A.nrm[i * 3 + 1] * 0.5 + 0.5) * 255; nrm8[i * 3 + 2] = (A.nrm[i * 3 + 2] * 0.5 + 0.5) * 255; }
  // partially covered texels keep their own (already clean) colour
  bleedColor(A.rgb, A.cover, atlas, atlas); bleedColor(nrm8, A.cover, atlas, atlas); bleedColor(A.orm, A.cover, atlas, atlas);
  const rgba = Buffer.alloc(atlas * atlas * 4), nb = Buffer.alloc(atlas * atlas * 3), ob = Buffer.alloc(atlas * atlas * 3);
  const clamp = (v) => Math.max(0, Math.min(255, Math.round(v)));
  for (let i = 0; i < atlas * atlas; i++) {
    rgba[i * 4] = clamp(A.rgb[i * 3]); rgba[i * 4 + 1] = clamp(A.rgb[i * 3 + 1]); rgba[i * 4 + 2] = clamp(A.rgb[i * 3 + 2]); rgba[i * 4 + 3] = clamp(A.alpha[i] * 255);
    for (let c = 0; c < 3; c++) { nb[i * 3 + c] = clamp(nrm8[i * 3 + c]); ob[i * 3 + c] = clamp(A.orm[i * 3 + c]); }
  }
  const half = Math.max(128, atlas >> 1);
  const tex = {
    baseColor: { data: await sharp(rgba, { raw: { width: atlas, height: atlas, channels: 4 } }).webp({ quality: 84, alphaQuality: 96, effort: 5, smartSubsample: true }).toBuffer(), mime: 'image/webp' },
    normal: { data: await sharp(nb, { raw: { width: atlas, height: atlas, channels: 3 } }).resize(half, half, { kernel: 'cubic' }).jpeg({ quality: 82, mozjpeg: true, chromaSubsampling: '4:4:4' }).toBuffer(), mime: 'image/jpeg' },
    orm: { data: await sharp(ob, { raw: { width: atlas, height: atlas, channels: 3 } }).resize(half, half, { kernel: 'cubic' }).jpeg({ quality: 80, mozjpeg: true, chromaSubsampling: '4:4:4' }).toBuffer(), mime: 'image/jpeg' },
    sizes: [atlas, half, half],
  };

  // ---- geometry: one quad per view, UVs into the best-matching tile
  const bandOf = (e0) => { let b = 0; while (b < sizeEdges.length && e0 > sizeEdges[b]) b++; return b; };
  const repIndex = new Map(reps.map((r, i) => [r, i]));
  const N = cardList.length;
  const pos = new Float32Array(N * 12), nrmO = new Float32Array(N * 12), uvO = new Float32Array(N * 8), idx = new Uint32Array(N * 6);
  cardList.forEach((cd, i) => {
    const e = ext(cd), f = cd.frame;
    // tile choice: own tile if this view was baked, else the closest representative (aspect + colour) of its size band
    let best = repIndex.get(cd);
    if (best === undefined) {
      const ft = feat(cd), band = sizeEdges.length ? bandOf(sizeKey(cd)) : 0;
      let bd = Infinity;
      reps.forEach((r, ri) => { if (repBand[ri] !== band) return; const dd = fdist(ft, repFeat[ri]); if (dd < bd) { bd = dd; best = ri; } });
      if (best === undefined) best = 0;
    }
    const tx = best % tiles, ty = Math.floor(best / tiles);
    const flip = best !== repIndex.get(cd) && (((i * 2654435761) >>> 0) & 0x10000) ? 1 : 0;
    const re = ext(reps[best]), rm = Math.max(1e-9, re[0], re[1]);
    const u0 = (tx + margin) / tiles, u1 = (tx + margin + (1 - 2 * margin) * (re[0] / rm)) / tiles, v0 = (ty + margin) / tiles, v1 = (ty + margin + (1 - 2 * margin) * (re[1] / rm)) / tiles;
    // shading normal: mostly the smooth "crown" direction (away from the trunk axis and upwards) so that light falls off
    // smoothly over the crown instead of flickering from card to card; the plane normal only adds a little variation
    const out = outDir(f.c);
    let nn = f.e3, flipU = false;
    if (dot(nn, out) < 0) { nn = nn.map((x) => -x); flipU = true; } // keep the quad front-facing along nn
    // (three.js negates the normal on back faces, so the shading normal has to stay close to the plane normal)
    const sn = norm([nn[0] * (1 - crown) + out[0] * crown, nn[1] * (1 - crown) + out[1] * crown, nn[2] * (1 - crown) + out[2] * crown]);
    const corners = [[0, 0], [1, 0], [1, 1], [0, 1]]; // (u, v) in card space, v up
    corners.forEach(([cu, cv], j) => {
      const a = f.lo[0] + (f.hi[0] - f.lo[0]) * cu, b = f.lo[1] + (f.hi[1] - f.lo[1]) * cv;
      for (let q = 0; q < 3; q++) { pos[(i * 4 + j) * 3 + q] = f.c[q] + f.e1[q] * a + f.e2[q] * b; nrmO[(i * 4 + j) * 3 + q] = sn[q]; }
      const uu = flip ? 1 - cu : cu;
      uvO[(i * 4 + j) * 2] = u0 + (u1 - u0) * uu; uvO[(i * 4 + j) * 2 + 1] = v1 - (v1 - v0) * cv;
    });
    const o = i * 4;
    // winding so that the geometric front face looks along +nn
    if (flipU) idx.set([o, o + 2, o + 1, o, o + 3, o + 2], i * 6); else idx.set([o, o + 1, o + 2, o, o + 2, o + 3], i * 6);
  });
  return { prim: { pos, nrm: nrmO, uv: uvO, idx }, textures: tex, clusters: clusters.length, cards: N, cardSize: size };
}
