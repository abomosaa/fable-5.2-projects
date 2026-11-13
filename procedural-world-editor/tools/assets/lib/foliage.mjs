// Foliage LOD: alpha-card aware decimation. Edge-collapsing a soup of thousands of small alpha cards shreds it,
// so instead we (1) keep an area-weighted, spatially stratified subset of card clusters (connected components),
// (2) simplify each kept cluster on its own (a card collapses to its corner quad), and (3) scale kept clusters
// about their centroids so the crown keeps its apparent density.
import { extractComponents, simplifyPrim, concatPrims, triCount } from './mesh.mjs';

/**
 * @param p        foliage prim
 * @param comps    analyseComponents(p)
 * @param opts     { budget, maxScale, minTris=2, coverage=1 }
 * @returns {{prim, kept:number, scale:number}}
 */
export function buildFoliageLod(p, comps, { budget, maxScale = 2.2, minTris = 2, coverage = 1 }) {
  const N = comps.count;
  const total = triCount(p);
  if (total <= budget) return { prim: p, kept: N, scale: 1, fraction: 1 };
  // a card can collapse to its quad, but a larger component (a sprig: stem + leaves) falls apart below ~1/12 of its triangles
  const minOf = (c) => Math.min(comps.tris[c], Math.max(minTris, Math.ceil(comps.tris[c] / 12)));
  let minSum = 0;
  for (let c = 0; c < N; c++) minSum += minOf(c);

  let targetCount = minSum <= budget ? N : Math.max(1, Math.floor((budget / minSum) * N));
  for (let attempt = 0; attempt < 5; attempt++) {
    // --- choose components: systematic sampling along the Morton order, proportional to area
    let ids;
    if (targetCount >= N) ids = Array.from(comps.order);
    else {
      ids = [];
      const step = comps.totalArea / targetCount;
      let acc = 0, next = step * 0.5;
      for (const c of comps.order) {
        acc += comps.area[c];
        if (acc >= next) { ids.push(c); while (next <= acc) next += step; }
      }
    }
    let keptArea = 0, keptTris = 0, keptMin = 0;
    for (const c of ids) { keptArea += comps.area[c]; keptTris += comps.tris[c]; keptMin += minOf(c); }
    const scale = Math.min(maxScale, Math.sqrt((comps.totalArea * coverage) / keptArea));

    // --- per-component triangle targets: min + proportional share of what is left
    const spare = Math.max(0, budget - keptMin);
    const reducible = Math.max(1, keptTris - keptMin);
    const ratio = Math.min(1, spare / reducible);
    const parts = [];
    let outTris = 0;
    // batch untouched components together, simplify the rest individually
    const untouched = [];
    for (const c of ids) {
      const t = comps.tris[c];
      const target = Math.max(minOf(c), Math.floor(minOf(c) + (t - minOf(c)) * ratio));
      if (target >= t) { untouched.push(c); outTris += t; continue; }
      const one = extractComponents(p, comps, [c], () => scale);
      const s = simplifyPrim(one, target, { maxError: 1, nrmWeight: 0.3, uvWeight: 1.5 });
      const r = triCount(s) > 0 ? s : one;
      parts.push(r); outTris += triCount(r);
    }
    if (untouched.length) parts.push(extractComponents(p, comps, untouched, () => scale));
    if (outTris <= budget * 1.02 || attempt === 4 || ids.length <= 1) {
      return { prim: concatPrims(parts), kept: ids.length, scale, fraction: ids.length / N };
    }
    targetCount = Math.max(1, Math.floor(ids.length * (budget / outTris) * 0.97));
  }
}
