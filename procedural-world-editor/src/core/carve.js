// Non-destructive terrain modifiers: rivers, roads/trails and structure pads are applied on top of
// the user heightfield (generated + eroded + sculpted) to produce the final heightfield.
// Moving a river node therefore removes the old channel and carves the new one.

import { samplePath, rasterizePath, profileDistance } from './paths.js';
import { Noise2D, smoothstep, clamp, lerp, hash32 } from './noise.js';

export const RIVER_DEFAULTS = {
  width: 9, // m, wetted width
  depth: 0.7, // m, max water depth at design flow
  flow: 6, // m^3/s discharge
  bankWidth: 7, // m, bank transition beyond the waterline
  bankSlope: 0.55, // rise per metre near the waterline
  freeboard: 0.35, // m, bank top above water where terrain allows
  bedRoughness: 0.35, // 0..1 boulder-bed relief relative to depth
  meanderDepth: 0.6, // 0..1 thalweg asymmetry in bends
  poolRiffle: 0.45, // 0..1 pool/riffle depth variation
  minGrade: 0.0015, // minimum downstream bed gradient
};

export const ROAD_DEFAULTS = {
  road: { width: 5.5, maxGrade: 0.1, shoulder: 1.2, cutSlope: 0.75, surface: 'gravel' },
  trail: { width: 1.6, maxGrade: 0.22, shoulder: 0.6, cutSlope: 1.0, surface: 'dirt' },
};

function smoothArray(a, w) {
  const n = a.length;
  const out = new Float32Array(n);
  // box filter via prefix sums, applied twice (~triangle kernel)
  const pre = new Float64Array(n + 1);
  for (let pass = 0; pass < 2; pass++) {
    const src = pass === 0 ? a : out.slice();
    for (let i = 0; i < n; i++) pre[i + 1] = pre[i] + src[i];
    for (let i = 0; i < n; i++) {
      const lo = Math.max(0, i - w),
        hi = Math.min(n - 1, i + w);
      out[i] = (pre[hi + 1] - pre[lo]) / (hi - lo + 1);
    }
  }
  return out;
}

/** Build the longitudinal profile and raster for a river. */
export function compileRiver(river, hUser, seed = 1) {
  const R = { ...RIVER_DEFAULTS, ...river };
  if (!river.nodes || river.nodes.length < 2) return null;
  const spacing = Math.min(1.0, hUser.cell * 0.6);
  const sp = samplePath(river.nodes, spacing, ['width', 'depth'], { width: R.width, depth: R.depth });
  if (!sp) return null;
  const n = sp.n;
  const noise = new Noise2D(hash32(seed, river.id ? stringHash(river.id) : 7, 91));
  const ground = new Float32Array(n);
  for (let k = 0; k < n; k++) ground[k] = hUser.sample(sp.x[k], sp.z[k]);
  const wAvg = R.width;
  const sm = smoothArray(ground, Math.max(2, Math.round((wAvg * 2.5) / sp.ds)));
  const bed = new Float32Array(n);
  const width = sp.attr.width;
  const depth0 = sp.attr.depth;
  // taper at the source so a river does not begin as a full-width trench
  const taper = (k) => (river.sourceTaper === false ? 1 : 0.45 + 0.55 * smoothstep(0, 45, sp.s[k]));
  for (let k = 0; k < n; k++) {
    const raw = sm[k] - (depth0[k] * taper(k) + R.freeboard);
    bed[k] = k === 0 ? raw : Math.min(raw, bed[k - 1] - R.minGrade * sp.ds);
  }
  // local slope (smoothed) -> normal depth via Manning for a wide channel: d ~ S^-0.3
  const bedS = smoothArray(bed, Math.max(2, Math.round((wAvg * 1.5) / sp.ds)));
  const slope = new Float32Array(n);
  let sMean = 0;
  for (let k = 0; k < n; k++) {
    const a = Math.max(0, k - 3),
      b = Math.min(n - 1, k + 3);
    slope[k] = Math.max(R.minGrade, (bedS[a] - bedS[b]) / Math.max(1e-3, (b - a) * sp.ds));
    sMean += slope[k];
  }
  sMean /= n;
  const depth = new Float32Array(n);
  const hw = new Float32Array(n);
  const surf = new Float32Array(n);
  const bedK = new Float32Array(n);
  for (let k = 0; k < n; k++) {
    const t = taper(k);
    const man = clamp(Math.pow(sMean / slope[k], 0.3), 0.45, 1.7);
    // pool-riffle sequence (spacing ~6 channel widths)
    const pr = noise.noise(sp.s[k] / (6 * wAvg), 3.3) * R.poolRiffle;
    depth[k] = Math.max(0.12, depth0[k] * t * man);
    // width varies along the reach at two scales (riffles spread out, pools and bends narrow)
    const wv = 1 + 0.2 * noise.noise(sp.s[k] / (2.6 * wAvg), 8.1) + 0.17 * noise.noise(sp.s[k] / (9 * wAvg), 2.7) - 0.1 * pr;
    hw[k] = 0.5 * width[k] * (0.6 + 0.4 * t) * clamp(wv, 0.62, 1.45);
    surf[k] = bedS[k] + depth[k];
    bedK[k] = bedS[k] - depth[k] * 0.5 * pr; // pools dig below, riffles rise above the mean bed
  }
  // water surface must fall monotonically downstream
  for (let k = 1; k < n; k++) if (surf[k] > surf[k - 1] - 1e-4) surf[k] = surf[k - 1] - 1e-4;
  const surfS = smoothArray(surf, Math.max(1, Math.round(wAvg / sp.ds)));
  for (let k = 1; k < n; k++) surf[k] = Math.min(surfS[k], surf[k - 1] - 1e-4);
  surf[0] = surfS[0];
  for (let k = 0; k < n; k++) depth[k] = Math.max(0.1, surf[k] - bedK[k]);
  const reach = (k) => hw[k] + R.bankWidth * 1.5 + 3 * hUser.cell;
  const raster = rasterizePath(sp, hUser, reach);
  return { kind: 'river', id: river.id, R, sp, raster, bed: bedK, surf, depth, hw, slope, noise };
}

function stringHash(s) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/**
 * Apply a compiled river to the final heightfield. Writes derived masks:
 *   masks.channel (0..255 wetted bed), masks.bank (0..255 bank / gravel-bar zone).
 */
export function applyRiver(c, hUser, hFinal, masks, clip) {
  const { sp, raster, R, bed, surf, depth, hw, noise } = c;
  const { rect, w, idx } = raster;
  const res = hUser.res;
  const x0 = clip ? Math.max(rect.x0, clip.x0) : rect.x0;
  const x1 = clip ? Math.min(rect.x1, clip.x1) : rect.x1;
  const z0 = clip ? Math.max(rect.z0, clip.z0) : rect.z0;
  const z1 = clip ? Math.min(rect.z1, clip.z1) : rect.z1;
  for (let iz = z0; iz <= z1; iz++) {
    const z = hUser.toWorldZ(iz);
    for (let ix = x0; ix <= x1; ix++) {
      const k = idx[(iz - rect.z0) * w + (ix - rect.x0)];
      if (k < 0) continue;
      const x = hUser.toWorldX(ix);
      const r = profileDistance(sp, k, x, z);
      const half = hw[k];
      // thalweg shifts towards the outside of bends, point bar grows on the inside
      const off = clamp(-sp.curv[k] * half * half * 2.2 * R.meanderDepth, -0.45 * half, 0.45 * half);
      const side = r - off >= 0 ? half - off : half + off;
      const u = (r - off) / Math.max(0.3, side);
      const au = Math.abs(u);
      const gi = iz * res + ix;
      const hu = hUser.data[gi];
      const e = Math.abs(r) - half; // metres beyond the waterline (approx.)
      let target;
      let blend;
      if (au <= 1) {
        // boulder / cobble bed relief (kept below the surface except for occasional emergent stones)
        const rough = (noise.fbm(x / 2.3, z / 2.3, 2) * 0.6 + noise.noise(x / 6.1, z / 6.1) * 0.4) * R.bedRoughness * depth[k] * (1 - au * au * 0.5);
        target = bed[k] + depth[k] * Math.pow(au, 2.3) + rough;
        blend = 1;
        if (masks) {
          masks.channel[gi] = Math.max(masks.channel[gi], 255);
          masks.bank[gi] = Math.max(masks.bank[gi], 255);
        }
      } else {
        const ee = Math.max(0, e);
        // bank and gravel-bar width varies from place to place (wide bars, tight vegetated banks)
        const bw = R.bankWidth * (0.5 + 0.95 * (0.5 + 0.5 * noise.noise(x / 27, z / 27 + 5.3)));
        const t = smoothstep(0, bw, ee);
        const bankProfile = surf[k] + Math.min(ee * R.bankSlope, R.freeboard + ee * 0.12) + noise.noise(x / 4.0, z / 4.0) * 0.08;
        target = bankProfile;
        blend = 1 - t;
        // keep the channel contained: low ground beside the river is raised to a subtle levee
        const levee = surf[k] + R.freeboard * smoothstep(0, 1.6, ee) * smoothstep(bw, bw * 0.55, ee);
        let hNew = hu + (target - hu) * blend;
        if (hu < target) hNew = Math.max(hu, Math.min(target, levee));
        else if (hNew < levee && ee < bw * 0.55) hNew = levee;
        if (masks) masks.bank[gi] = Math.max(masks.bank[gi], Math.round(255 * (1 - smoothstep(0, bw * 0.7, ee))));
        if (hNew < hFinal.data[gi] || hu < target) hFinal.data[gi] = hu < target ? Math.max(hFinal.data[gi], hNew) : hNew;
        continue;
      }
      const hNew = hu + (target - hu) * blend;
      hFinal.data[gi] = Math.min(hFinal.data[gi], hNew);
    }
  }
}

/** Road / trail profile: follows smoothed ground with a grade limit, flat cross-section, cut/fill banks. */
export function compileRoad(road, hUser) {
  const base = ROAD_DEFAULTS[road.kind === 'trail' ? 'trail' : 'road'];
  const R = { ...base, ...road };
  if (!road.nodes || road.nodes.length < 2) return null;
  const spacing = Math.min(1.0, hUser.cell * 0.6);
  const sp = samplePath(road.nodes, spacing, ['width'], { width: R.width });
  if (!sp) return null;
  const n = sp.n;
  const ground = new Float32Array(n);
  for (let k = 0; k < n; k++) ground[k] = hUser.sample(sp.x[k], sp.z[k]);
  const sm = smoothArray(ground, Math.max(2, Math.round((R.kind === 'trail' ? 6 : 18) / sp.ds)));
  // grade limiting: clamp slope in both directions
  const z = new Float32Array(sm);
  const g = R.maxGrade * sp.ds;
  for (let pass = 0; pass < 6; pass++) {
    for (let k = 1; k < n; k++) z[k] = clamp(z[k], z[k - 1] - g, z[k - 1] + g);
    for (let k = n - 2; k >= 0; k--) z[k] = clamp(z[k], z[k + 1] - g, z[k + 1] + g);
  }
  // limit earthworks: a trail follows the ground closely, a road may cut / fill a few metres.
  // Where the terrain is steeper than the grade limit the path simply becomes steep (as real
  // trails do) instead of turning into a causeway.
  const maxEarth = R.maxEarthwork ?? (R.kind === 'trail' ? 0.45 : 4.0);
  for (let k = 0; k < n; k++) z[k] = clamp(z[k], sm[k] - maxEarth, sm[k] + maxEarth);
  const prof = smoothArray(z, Math.max(1, Math.round(4 / sp.ds)));
  // steepest grade actually built (over ~3 m), reported to the author when it exceeds the limit
  let steepest = 0;
  const kk = Math.max(1, Math.round(3 / sp.ds));
  for (let k = kk; k < n; k++) steepest = Math.max(steepest, Math.abs(prof[k] - prof[k - kk]) / (kk * sp.ds));
  const hw = new Float32Array(n);
  for (let k = 0; k < n; k++) hw[k] = sp.attr.width[k] * 0.5;
  const reach = (k) => hw[k] + R.shoulder + 16;
  const raster = rasterizePath(sp, hUser, reach);
  return { kind: 'road', id: road.id, R, sp, raster, prof, hw, steepest, maxEarth, groundSmooth: sm };
}

export function applyRoad(c, hUser, hFinal, masks, clip) {
  const { sp, raster, R, prof, hw } = c;
  const { rect, w, idx } = raster;
  const res = hUser.res;
  const x0 = clip ? Math.max(rect.x0, clip.x0) : rect.x0;
  const x1 = clip ? Math.min(rect.x1, clip.x1) : rect.x1;
  const z0 = clip ? Math.max(rect.z0, clip.z0) : rect.z0;
  const z1 = clip ? Math.min(rect.z1, clip.z1) : rect.z1;
  const isTrail = R.kind === 'trail';
  for (let iz = z0; iz <= z1; iz++) {
    const z = hUser.toWorldZ(iz);
    for (let ix = x0; ix <= x1; ix++) {
      const k = idx[(iz - rect.z0) * w + (ix - rect.x0)];
      if (k < 0) continue;
      const x = hUser.toWorldX(ix);
      const r = Math.abs(profileDistance(sp, k, x, z));
      const gi = iz * res + ix;
      const hu = hUser.data[gi];
      const half = hw[k];
      // slight crown on roads, slight trough on trails (worn tread)
      const crown = isTrail ? -0.06 * (1 - Math.min(1, r / half)) : 0.05 * (1 - Math.pow(Math.min(1, r / half), 2));
      const target = prof[k] + crown;
      const diff = Math.abs(hu - target);
      const bankW = clamp(diff / R.cutSlope + R.shoulder, R.shoulder, 15);
      const t = smoothstep(half, half + bankW, r);
      const hNew = target + (hu - target) * t;
      // compose with whatever an earlier modifier produced, relative to the user surface
      hFinal.data[gi] += hNew - hu;
      if (masks) {
        const m = Math.round(255 * (1 - smoothstep(half * 0.75, half + 0.9, r)));
        if (m > masks.road[gi]) {
          masks.road[gi] = m;
          masks.roadKind[gi] = isTrail ? 1 : 2;
        }
        const cl = Math.round(255 * (1 - smoothstep(half + R.shoulder * 0.5, half + R.shoulder + 1.5, r)));
        if (cl > masks.clear[gi]) masks.clear[gi] = cl;
      }
    }
  }
}

/** Flatten a rotated rectangular pad for a structure foundation. */
export function applyPad(pad, hUser, hFinal, masks, clip) {
  const { x, z, rot, halfX, halfZ, level, margin } = pad;
  const reach = Math.hypot(halfX, halfZ) + margin;
  let rect = hUser.rectFromWorld(x - reach, z - reach, x + reach, z + reach, 1);
  if (clip) rect = { x0: Math.max(rect.x0, clip.x0), z0: Math.max(rect.z0, clip.z0), x1: Math.min(rect.x1, clip.x1), z1: Math.min(rect.z1, clip.z1) };
  const c = Math.cos(rot),
    s = Math.sin(rot);
  const res = hUser.res;
  for (let iz = rect.z0; iz <= rect.z1; iz++) {
    const wz = hUser.toWorldZ(iz) - z;
    for (let ix = rect.x0; ix <= rect.x1; ix++) {
      const wx = hUser.toWorldX(ix) - x;
      const lx = wx * c - wz * s;
      const lz = wx * s + wz * c;
      const dx = Math.max(0, Math.abs(lx) - halfX);
      const dz = Math.max(0, Math.abs(lz) - halfZ);
      const d = Math.hypot(dx, dz);
      if (d > margin) continue;
      const gi = iz * res + ix;
      const t = smoothstep(0, margin, d);
      // blend whatever earlier modifiers (roads) left here towards the pad level, so the footprint
      // (t = 0) ends up exactly at `level` even where a road's cut / fill bank overlaps it
      hFinal.data[gi] += (level - hFinal.data[gi]) * (1 - t);
      if (masks) {
        const m = Math.round(255 * (1 - smoothstep(0, margin * 0.8, d)));
        if (m > masks.clear[gi]) masks.clear[gi] = m;
        if (d < 0.01) masks.pad[gi] = 255;
      }
    }
  }
  return rect;
}

/** Foundation level for a pad: mean of the user terrain under the footprint. */
export function padLevel(hUser, x, z, rot, halfX, halfZ) {
  const c = Math.cos(rot),
    s = Math.sin(rot);
  let sum = 0,
    n = 0,
    mn = Infinity,
    mx = -Infinity;
  for (let j = -2; j <= 2; j++) {
    for (let i = -2; i <= 2; i++) {
      const lx = (i / 2) * halfX,
        lz = (j / 2) * halfZ;
      const h = hUser.sample(x + lx * c + lz * s, z - lx * s + lz * c);
      sum += h;
      n++;
      if (h < mn) mn = h;
      if (h > mx) mx = h;
    }
  }
  return { level: sum / n, min: mn, max: mx };
}
