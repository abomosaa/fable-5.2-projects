// Fluvial landscape evolution: detachment-limited stream-power incision with tectonic uplift and
// threshold hillslopes (after Braun & Willett 2013 / Cordonnier et al. 2016).
//   dh/dt = U - K * A^m * S          (n = 1, solved implicitly in downstream-first order)
// Drainage is routed over a depression-filled surface (priority-flood + epsilon), so every cell
// drains to a fixed base-level ("outlet") cell. This produces dendritic valley networks, concave
// river long-profiles and ridge lines - the large-scale structure real mountains have and
// fractal noise lacks.

const NX = [1, 1, 0, -1, -1, -1, 0, 1];
const NZ = [0, 1, 1, 1, 0, -1, -1, -1];
const ND = [1, Math.SQRT2, 1, Math.SQRT2, 1, Math.SQRT2, 1, Math.SQRT2];

class MinHeap {
  constructor(cap) {
    this.keys = new Float32Array(cap);
    this.vals = new Int32Array(cap);
    this.n = 0;
  }
  push(k, v) {
    const keys = this.keys,
      vals = this.vals;
    let i = this.n++;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (keys[p] <= k) break;
      keys[i] = keys[p];
      vals[i] = vals[p];
      i = p;
    }
    keys[i] = k;
    vals[i] = v;
  }
  pop() {
    const keys = this.keys,
      vals = this.vals;
    const top = vals[0];
    this.topKey = keys[0];
    const n = --this.n;
    if (n > 0) {
      const k = keys[n],
        v = vals[n];
      let i = 0;
      for (;;) {
        let c = 2 * i + 1;
        if (c >= n) break;
        if (c + 1 < n && keys[c + 1] < keys[c]) c++;
        if (keys[c] >= k) break;
        keys[i] = keys[c];
        vals[i] = vals[c];
        i = c;
      }
      keys[i] = k;
      vals[i] = v;
    }
    return top;
  }
}

/**
 * Priority-flood depression filling with epsilon gradient.
 * @returns {{filled: Float32Array, order: Int32Array}} order = cells in ascending filled elevation.
 */
export function priorityFlood(h, n, outlet, eps = 1e-3, filled, order) {
  const N = n * n;
  filled = filled || new Float32Array(N);
  order = order || new Int32Array(N);
  const visited = new Uint8Array(N);
  const heap = new MinHeap(N);
  for (let i = 0; i < N; i++) {
    if (outlet[i]) {
      visited[i] = 1;
      filled[i] = h[i];
      heap.push(h[i], i);
    }
  }
  let count = 0;
  while (heap.n > 0) {
    const c = heap.pop();
    order[count++] = c;
    const cx = c % n;
    const cz = (c / n) | 0;
    const fc = filled[c];
    for (let k = 0; k < 8; k++) {
      const x = cx + NX[k];
      const z = cz + NZ[k];
      if (x < 0 || z < 0 || x >= n || z >= n) continue;
      const i = z * n + x;
      if (visited[i]) continue;
      visited[i] = 1;
      const f = h[i] > fc + eps ? h[i] : fc + eps;
      filled[i] = f;
      heap.push(f, i);
    }
  }
  return { filled, order, count };
}

/** Steepest-descent receivers on a filled surface. Outlets (and unreachable cells) receive themselves. */
export function computeReceivers(filled, n, outlet, recv, rdist, dx) {
  const N = n * n;
  recv = recv || new Int32Array(N);
  rdist = rdist || new Float32Array(N);
  for (let z = 0; z < n; z++) {
    for (let x = 0; x < n; x++) {
      const c = z * n + x;
      if (outlet[c]) {
        recv[c] = c;
        rdist[c] = dx;
        continue;
      }
      let best = c;
      let bestS = 0;
      let bestD = dx;
      const fc = filled[c];
      for (let k = 0; k < 8; k++) {
        const xx = x + NX[k];
        const zz = z + NZ[k];
        if (xx < 0 || zz < 0 || xx >= n || zz >= n) continue;
        const i = zz * n + xx;
        const s = (fc - filled[i]) / ND[k];
        if (s > bestS) {
          bestS = s;
          best = i;
          bestD = ND[k] * dx;
        }
      }
      recv[c] = best;
      rdist[c] = bestD;
    }
  }
  return { recv, rdist };
}

/** Drainage area accumulation. order ascending in filled elevation. */
export function accumulateArea(order, count, recv, n, dx, area, rain) {
  const N = n * n;
  area = area || new Float32Array(N);
  const a0 = dx * dx;
  if (rain) for (let i = 0; i < N; i++) area[i] = a0 * rain[i];
  else area.fill(a0);
  for (let j = count - 1; j >= 0; j--) {
    const c = order[j];
    const r = recv[c];
    if (r !== c) area[r] += area[c];
  }
  return area;
}

/**
 * Run the landscape evolution model in place on `h`.
 * @param {object} o
 * @param {Float32Array} o.h        elevations (n*n), modified in place
 * @param {number} o.n              grid resolution
 * @param {number} o.dx             cell size (m)
 * @param {Uint8Array} o.outlet     1 = fixed base-level cell
 * @param {Float32Array} o.uplift   uplift rate per cell (m / time unit)
 * @param {Float32Array} o.K        erodibility per cell
 * @param {Float32Array} o.crit     critical (threshold) hillslope gradient per cell (tan angle)
 * @param {number} o.iters
 * @param {number} o.dt
 * @param {number} [o.m=0.45]
 * @param {number} [o.diffusion=0]  0..1 hillslope creep per iteration (laplacian relaxation)
 * @param {Float32Array} [o.inflow] extra drainage area injected per cell (m^2)
 * @param {(i:number,n:number)=>boolean} [o.onProgress] return false to cancel
 */
export function evolveLandscape(o) {
  const { h, n, dx, outlet, uplift, K, crit, iters, dt } = o;
  const m = o.m ?? 0.45;
  const diffusion = o.diffusion ?? 0;
  const N = n * n;
  const filled = new Float32Array(N);
  const order = new Int32Array(N);
  const recv = new Int32Array(N);
  const rdist = new Float32Array(N);
  const area = new Float32Array(N);
  const tmp = diffusion > 0 ? new Float32Array(N) : null;
  let count = 0;
  for (let it = 0; it < iters; it++) {
    count = priorityFlood(h, n, outlet, 1e-3 * dx, filled, order).count;
    computeReceivers(filled, n, outlet, recv, rdist, dx);
    accumulateArea(order, count, recv, n, dx, area);
    if (o.inflow) {
      // inject upstream area entering the domain, then re-accumulate it downstream
      const inflow = o.inflow;
      for (let j = count - 1; j >= 0; j--) {
        const c = order[j];
        if (inflow[c] > 0) {
          let k = c;
          let guard = 0;
          const add = inflow[c];
          while (guard++ < N) {
            area[k] += add;
            const r = recv[k];
            if (r === k) break;
            k = r;
          }
        }
      }
    }
    // implicit stream-power update, downstream cells first
    for (let j = 0; j < count; j++) {
      const c = order[j];
      if (outlet[c]) continue;
      const r = recv[c];
      const L = rdist[c];
      if (r === c) {
        h[c] += dt * uplift[c];
        continue;
      }
      const F = (K[c] * dt * Math.pow(area[c], m)) / L;
      let hn = (h[c] + dt * uplift[c] + F * h[r]) / (1 + F);
      // threshold hillslope: gradient to receiver cannot exceed the critical slope
      const lim = h[r] + crit[c] * L;
      if (hn > lim) hn = lim;
      h[c] = hn;
    }
    if (diffusion > 0) {
      tmp.set(h);
      for (let z = 1; z < n - 1; z++) {
        for (let x = 1; x < n - 1; x++) {
          const c = z * n + x;
          if (outlet[c]) continue;
          const lap = (tmp[c - 1] + tmp[c + 1] + tmp[c - n] + tmp[c + n]) * 0.25 - tmp[c];
          h[c] += lap * diffusion;
        }
      }
    }
    if (o.onProgress && o.onProgress(it + 1, iters) === false) break;
  }
  // final routing products for consumers (moisture, river tracing)
  count = priorityFlood(h, n, outlet, 1e-3 * dx, filled, order).count;
  computeReceivers(filled, n, outlet, recv, rdist, dx);
  accumulateArea(order, count, recv, n, dx, area);
  return { area, recv, filled, order, count };
}

/**
 * Trace the main stream through a window of the grid: starts from the cell with the largest
 * drainage area on the window boundary that flows inward, and follows receivers until leaving.
 * Returns grid-space points [[gx,gz,area],...] inside the window.
 */
export function traceTrunkStream(area, recv, n, win, minArea = 0) {
  const { x0, z0, x1, z1 } = win;
  let best = -1;
  let bestA = minArea;
  // the trunk stream is where drainage area is largest when *leaving* the window; walk upstream from there.
  for (let z = z0; z <= z1; z++) {
    for (let x = x0; x <= x1; x++) {
      if (x !== x0 && x !== x1 && z !== z0 && z !== z1) continue;
      const c = z * n + x;
      const r = recv[c];
      const rx = r % n;
      const rz = (r / n) | 0;
      const leaving = rx < x0 || rx > x1 || rz < z0 || rz > z1 || r === c;
      if (leaving && area[c] > bestA) {
        bestA = area[c];
        best = c;
      }
    }
  }
  if (best < 0) return [];
  // build donors lazily: walk upstream choosing the donor with the largest area
  const pts = [];
  let c = best;
  const inWin = (i) => {
    const x = i % n;
    const z = (i / n) | 0;
    return x >= x0 && x <= x1 && z >= z0 && z <= z1;
  };
  let guard = 0;
  while (c >= 0 && guard++ < 4 * n) {
    pts.push([c % n, (c / n) | 0, area[c]]);
    const cx = c % n;
    const cz = (c / n) | 0;
    let up = -1;
    let upA = 0;
    for (let k = 0; k < 8; k++) {
      const x = cx + NX[k];
      const z = cz + NZ[k];
      if (x < 0 || z < 0 || x >= n || z >= n) continue;
      const i = z * n + x;
      if (recv[i] === c && i !== c && area[i] > upA) {
        upA = area[i];
        up = i;
      }
    }
    if (up < 0 || !inWin(up)) break;
    c = up;
  }
  pts.reverse(); // upstream -> downstream
  return pts;
}
