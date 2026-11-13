// Spline paths (rivers, roads, trails): centripetal Catmull-Rom through editable nodes,
// resampled at uniform arc length with interpolated per-node attributes.

function crPoint(p0, p1, p2, p3, t, out) {
  // centripetal Catmull-Rom (alpha = 0.5), Barry-Goldman formulation
  const d01 = Math.pow(Math.hypot(p1.x - p0.x, p1.z - p0.z), 0.5) || 1e-3;
  const d12 = Math.pow(Math.hypot(p2.x - p1.x, p2.z - p1.z), 0.5) || 1e-3;
  const d23 = Math.pow(Math.hypot(p3.x - p2.x, p3.z - p2.z), 0.5) || 1e-3;
  const t0 = 0,
    t1 = d01,
    t2 = t1 + d12,
    t3 = t2 + d23;
  const tt = t1 + (t2 - t1) * t;
  const l = (a, b, ta, tb) => {
    const w = (tt - ta) / (tb - ta);
    return [a[0] + (b[0] - a[0]) * w, a[1] + (b[1] - a[1]) * w];
  };
  const P0 = [p0.x, p0.z],
    P1 = [p1.x, p1.z],
    P2 = [p2.x, p2.z],
    P3 = [p3.x, p3.z];
  const A1 = l(P0, P1, t0, t1),
    A2 = l(P1, P2, t1, t2),
    A3 = l(P2, P3, t2, t3);
  const B1 = l(A1, A2, t0, t2),
    B2 = l(A2, A3, t1, t3);
  const C = l(B1, B2, t1, t2);
  out[0] = C[0];
  out[1] = C[1];
}

/**
 * @param {Array<{x:number,z:number}>} nodes
 * @param {number} spacing metres between output samples
 * @param {string[]} attrs per-node numeric attributes to interpolate (missing values use defaults)
 * @param {object} defaults
 */
export function samplePath(nodes, spacing, attrs = [], defaults = {}) {
  const nn = nodes.length;
  if (nn < 2) return null;
  // dense polyline first
  const dense = [];
  const tmp = [0, 0];
  const SUB = 24;
  for (let i = 0; i < nn - 1; i++) {
    const p1 = nodes[i],
      p2 = nodes[i + 1];
    const p0 = i > 0 ? nodes[i - 1] : { x: 2 * p1.x - p2.x, z: 2 * p1.z - p2.z };
    const p3 = i < nn - 2 ? nodes[i + 2] : { x: 2 * p2.x - p1.x, z: 2 * p2.z - p1.z };
    for (let k = 0; k < SUB; k++) {
      crPoint(p0, p1, p2, p3, k / SUB, tmp);
      dense.push(tmp[0], tmp[1], i + k / SUB);
    }
  }
  dense.push(nodes[nn - 1].x, nodes[nn - 1].z, nn - 1);
  const dn = dense.length / 3;
  const cum = new Float32Array(dn);
  for (let i = 1; i < dn; i++) cum[i] = cum[i - 1] + Math.hypot(dense[i * 3] - dense[i * 3 - 3], dense[i * 3 + 1] - dense[i * 3 - 2]);
  const total = cum[dn - 1];
  const n = Math.max(2, Math.ceil(total / spacing) + 1);
  const ds = total / (n - 1);
  const out = {
    n,
    ds,
    length: total,
    x: new Float32Array(n),
    z: new Float32Array(n),
    tx: new Float32Array(n),
    tz: new Float32Array(n),
    s: new Float32Array(n),
    u: new Float32Array(n), // node-space parameter
    curv: new Float32Array(n),
    attr: {},
  };
  let j = 0;
  for (let i = 0; i < n; i++) {
    const s = Math.min(total, i * ds);
    while (j < dn - 2 && cum[j + 1] < s) j++;
    const seg = cum[j + 1] - cum[j] || 1;
    const t = (s - cum[j]) / seg;
    out.x[i] = dense[j * 3] + (dense[j * 3 + 3] - dense[j * 3]) * t;
    out.z[i] = dense[j * 3 + 1] + (dense[j * 3 + 4] - dense[j * 3 + 1]) * t;
    out.u[i] = dense[j * 3 + 2] + (dense[j * 3 + 5] - dense[j * 3 + 2]) * t;
    out.s[i] = s;
  }
  for (let i = 0; i < n; i++) {
    const a = Math.max(0, i - 1),
      b = Math.min(n - 1, i + 1);
    let tx = out.x[b] - out.x[a],
      tz = out.z[b] - out.z[a];
    const l = Math.hypot(tx, tz) || 1;
    out.tx[i] = tx / l;
    out.tz[i] = tz / l;
  }
  // signed curvature (1/m), smoothed; positive = turning towards the +normal side n = (-tz, tx)
  const w = Math.max(1, Math.round(6 / ds));
  for (let i = 0; i < n; i++) {
    const a = Math.max(0, i - w),
      b = Math.min(n - 1, i + w);
    const cross = out.tx[a] * out.tz[b] - out.tz[a] * out.tx[b];
    const dot = out.tx[a] * out.tx[b] + out.tz[a] * out.tz[b];
    const ang = Math.atan2(cross, dot);
    out.curv[i] = ang / Math.max(1e-3, (b - a) * ds);
  }
  for (const key of attrs) {
    const arr = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const u = out.u[i];
      const i0 = Math.min(nn - 2, Math.floor(u));
      let t = u - i0;
      t = t * t * (3 - 2 * t);
      const a = nodes[i0][key] ?? defaults[key];
      const b = nodes[i0 + 1][key] ?? defaults[key];
      arr[i] = a + (b - a) * t;
    }
    out.attr[key] = arr;
  }
  return out;
}

/**
 * Rasterise the neighbourhood of a sampled path: for every grid cell within `reach(k)` metres of
 * the centreline record the nearest sample index and the signed cross-track distance
 * (positive on the left of the travel direction).
 * Returns a compact list restricted to the path bounding rect.
 */
export function rasterizePath(sp, hf, reachFn) {
  const res = hf.res;
  let maxReach = 0;
  for (let k = 0; k < sp.n; k++) maxReach = Math.max(maxReach, reachFn(k));
  let xmin = Infinity,
    zmin = Infinity,
    xmax = -Infinity,
    zmax = -Infinity;
  for (let k = 0; k < sp.n; k++) {
    if (sp.x[k] < xmin) xmin = sp.x[k];
    if (sp.x[k] > xmax) xmax = sp.x[k];
    if (sp.z[k] < zmin) zmin = sp.z[k];
    if (sp.z[k] > zmax) zmax = sp.z[k];
  }
  const rect = hf.rectFromWorld(xmin - maxReach, zmin - maxReach, xmax + maxReach, zmax + maxReach, 1);
  const w = rect.x1 - rect.x0 + 1;
  const h = rect.z1 - rect.z0 + 1;
  if (w <= 0 || h <= 0) return { rect, w: 0, h: 0, idx: new Int32Array(0), dist2: new Float32Array(0) };
  const idx = new Int32Array(w * h).fill(-1);
  const dist2 = new Float32Array(w * h).fill(1e30);
  const cell = hf.cell;
  for (let k = 0; k < sp.n; k++) {
    const R = reachFn(k);
    const gx = hf.toGridX(sp.x[k]);
    const gz = hf.toGridZ(sp.z[k]);
    const rc = R / cell;
    const ix0 = Math.max(rect.x0, Math.floor(gx - rc)),
      ix1 = Math.min(rect.x1, Math.ceil(gx + rc));
    const iz0 = Math.max(rect.z0, Math.floor(gz - rc)),
      iz1 = Math.min(rect.z1, Math.ceil(gz + rc));
    const R2 = R * R;
    for (let iz = iz0; iz <= iz1; iz++) {
      const dz = (iz - gz) * cell;
      for (let ix = ix0; ix <= ix1; ix++) {
        const dx = (ix - gx) * cell;
        const d2 = dx * dx + dz * dz;
        if (d2 > R2) continue;
        const o = (iz - rect.z0) * w + (ix - rect.x0);
        if (d2 < dist2[o]) {
          dist2[o] = d2;
          idx[o] = k;
        }
      }
    }
  }
  return { rect, w, h, idx, dist2, res };
}

/** Signed cross-track distance of world point (x,z) relative to sample k (+ = left of travel). */
export function crossTrack(sp, k, x, z) {
  return (x - sp.x[k]) * -sp.tz[k] + (z - sp.z[k]) * sp.tx[k];
}

/**
 * Distance from the centre-line used for cross-sections: the signed cross-track distance, except
 * beyond either end of the path where it becomes the radial distance to the end point, so paths
 * finish in a rounded cap instead of extending their profile past the last node.
 */
export function profileDistance(sp, k, x, z) {
  const dx = x - sp.x[k],
    dz = z - sp.z[k];
  const cross = dx * -sp.tz[k] + dz * sp.tx[k];
  if (k === 0 || k === sp.n - 1) {
    const along = dx * sp.tx[k] + dz * sp.tz[k];
    if ((k === 0 && along < 0) || (k === sp.n - 1 && along > 0)) return (cross < 0 ? -1 : 1) * Math.hypot(cross, along);
  }
  return cross;
}

/** Nearest point on a node polyline; returns {seg, t, dist}. Used for picking / node insertion. */
export function nearestOnPolyline(nodes, x, z) {
  let best = { seg: -1, t: 0, dist: Infinity };
  for (let i = 0; i < nodes.length - 1; i++) {
    const ax = nodes[i].x,
      az = nodes[i].z;
    const bx = nodes[i + 1].x,
      bz = nodes[i + 1].z;
    const vx = bx - ax,
      vz = bz - az;
    const l2 = vx * vx + vz * vz || 1e-9;
    let t = ((x - ax) * vx + (z - az) * vz) / l2;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const d = Math.hypot(ax + vx * t - x, az + vz * t - z);
    if (d < best.dist) best = { seg: i, t, dist: d };
  }
  return best;
}
