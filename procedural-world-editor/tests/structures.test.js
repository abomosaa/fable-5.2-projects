// Structures: foundation pads (terrain modifier), site validation, settlements and the
// parametric building geometry that the renderer and the exporter share.
import { describe, it, expect, beforeAll } from 'vitest';
import { createProjectDoc } from '../src/core/project.js';
import { World } from '../src/core/world.js';
import { Noise2D } from '../src/core/noise.js';
import { buildStructureGeometry, cabinParams, structureFootprint } from '../src/core/structures.js';
import { padLevel } from '../src/core/carve.js';
import { hashBytes } from './helpers/world.js';

const EMPTY = { models: {}, textures: {} };
const RES = 257,
  SIZE = 512; // 2 m cells

/** Hillside falling towards +x (15 %) with a little relief; flat-ish everywhere, no water. */
function hillside() {
  const n = new Noise2D(17);
  const h = new Float32Array(RES * RES);
  for (let iz = 0; iz < RES; iz++) for (let ix = 0; ix < RES; ix++) h[iz * RES + ix] = 200 - 0.15 * (ix * 2 - 256) + n.fbm(ix / 20, iz / 20, 2) * 1.5;
  return h;
}
function makeWorld(edit) {
  const { doc } = createProjectDoc({ name: 'structures', preset: 'hills', seed: 4, manifest: EMPTY, terrain: { res: RES, size: SIZE } });
  doc.id = 'structures-test';
  if (edit) edit(doc);
  const w = new World(doc, { heights: hillside() }, EMPTY);
  w.deriveAll();
  return w;
}
const CABIN = { id: 'c1', type: 'cabin', x: 20, z: -30, rot: 0.7, variant: 3 };

/** Largest |hFinal - level| over grid cells inside the structure footprint. */
function floorError(w, s) {
  const fp = structureFootprint(s, EMPTY);
  const level = w.structureLevel(s);
  const c = Math.cos(s.rot || 0),
    sn = Math.sin(s.rot || 0);
  let max = 0,
    n = 0;
  const r = Math.hypot(fp.halfX, fp.halfZ);
  const rect = w.hFinal.rectFromWorld(s.x - r, s.z - r, s.x + r, s.z + r);
  for (let iz = rect.z0; iz <= rect.z1; iz++) {
    for (let ix = rect.x0; ix <= rect.x1; ix++) {
      const wx = w.hFinal.toWorldX(ix) - s.x,
        wz = w.hFinal.toWorldZ(iz) - s.z;
      const lx = wx * c - wz * sn,
        lz = wx * sn + wz * c;
      if (Math.abs(lx) > fp.halfX || Math.abs(lz) > fp.halfZ) continue;
      max = Math.max(max, Math.abs(w.hFinal.data[iz * RES + ix] - level));
      n++;
    }
  }
  return { max, n, level };
}

describe('structure foundation pads', () => {
  it('flattens the footprint to the mean ground level and blends into the slope', () => {
    const w = makeWorld((doc) => doc.structures.push({ ...CABIN }));
    const fp = structureFootprint(CABIN, EMPTY);
    const lv = padLevel(w.hUser, CABIN.x, CABIN.z, CABIN.rot, fp.halfX, fp.halfZ);
    expect(w.structureLevel(CABIN)).toBeCloseTo(lv.level, 10);
    expect(lv.max - lv.min).toBeGreaterThan(0.5); // the site really slopes
    const e = floorError(w, CABIN);
    expect(e.n).toBeGreaterThan(8);
    expect(e.max).toBeLessThan(0.01);
    // cut on the uphill side, fill on the downhill side
    const gi = (x, z) => Math.round(w.hFinal.toGridZ(z)) * RES + Math.round(w.hFinal.toGridX(x));
    expect(w.hFinal.data[gi(CABIN.x - 3, CABIN.z)]).toBeLessThan(w.hUser.data[gi(CABIN.x - 3, CABIN.z)]);
    expect(w.hFinal.data[gi(CABIN.x + 3, CABIN.z)]).toBeGreaterThan(w.hUser.data[gi(CABIN.x + 3, CABIN.z)]);
    expect(w.masks.pad[gi(CABIN.x, CABIN.z)]).toBe(255);
    expect(w.masks.clear[gi(CABIN.x, CABIN.z)]).toBe(255);
    // untouched beyond the margin
    let changed = 0;
    for (let i = 0; i < RES * RES; i++) {
      if (w.hFinal.data[i] === w.hUser.data[i]) continue;
      changed++;
      const d = Math.hypot(w.hFinal.toWorldX(i % RES) - CABIN.x, w.hFinal.toWorldZ((i / RES) | 0) - CABIN.z);
      if (d > Math.hypot(fp.halfX + 0.6, fp.halfZ + 0.6) + fp.margin + 0.01) throw new Error(`terrain changed ${d.toFixed(1)} m from the building`);
    }
    expect(changed).toBeGreaterThan(20);
    // an explicit level overrides the automatic one
    const w2 = makeWorld((doc) => doc.structures.push({ ...CABIN, level: lv.level + 1.5 }));
    expect(w2.structureLevel(CABIN)).toBe(lv.level + 1.5);
    expect(floorError(w2, CABIN).max).toBeLessThan(0.01);
  });

  it('removing or moving a structure restores the ground exactly', () => {
    const w = makeWorld((doc) => doc.structures.push({ ...CABIN }));
    const user = hashBytes(w.hUser.data);
    w.project.structures[0].x += 60;
    w.deriveRect({ x0: 0, z0: 0, x1: 0, z1: 0 }, { forceWater: true });
    const moved = { ...CABIN, x: CABIN.x + 60 };
    expect(floorError(w, moved).max).toBeLessThan(0.01);
    const gi = Math.round(w.hFinal.toGridZ(CABIN.z)) * RES + Math.round(w.hFinal.toGridX(CABIN.x));
    expect(w.hFinal.data[gi]).toBe(w.hUser.data[gi]);
    expect(w.masks.pad[gi]).toBe(0);
    const fresh = makeWorld((doc) => doc.structures.push(moved));
    expect(hashBytes(w.hFinal.data)).toBe(hashBytes(fresh.hFinal.data));
    w.project.structures.length = 0;
    w.deriveRect({ x0: 0, z0: 0, x1: 0, z1: 0 }, { forceWater: true });
    expect(hashBytes(w.hFinal.data)).toBe(user);
    expect(hashBytes(w.hUser.data)).toBe(user);
    expect(w.masks.pad.every((v) => v === 0)).toBe(true);
  });

  it('keeps the floor at structureLevel when a road ends at or passes the building', () => {
    // roads follow a smoothed, grade-limited profile, so on a hillside their cut / fill differs
    // from the ground by metres; the foundation must not inherit that offset
    const roads = [
      // ends 10 m from the building centre, coming up the slope
      { id: 'end', kind: 'road', nodes: [{ x: CABIN.x + 10 * Math.sin(CABIN.rot), z: CABIN.z + 10 * Math.cos(CABIN.rot) }, { x: 80, z: 20 }, { x: 150, z: 40 }, { x: 220, z: 30 }] },
      // passes 9 m beside it, across the slope
      { id: 'pass', kind: 'road', nodes: [{ x: CABIN.x - 9, z: -200 }, { x: CABIN.x - 9, z: -100 }, { x: CABIN.x - 9, z: 0 }, { x: CABIN.x - 9, z: 120 }] },
      { id: 'trail', kind: 'trail', nodes: [{ x: CABIN.x, z: CABIN.z - 9 }, { x: -60, z: -90 }, { x: -150, z: -80 }] },
    ];
    for (const set of [[roads[0]], [roads[1]], [roads[2]], roads]) {
      const w = makeWorld((doc) => {
        doc.structures.push({ ...CABIN });
        doc.roads.push(...set.map((r) => JSON.parse(JSON.stringify(r))));
      });
      const e = floorError(w, CABIN);
      if (e.max > 0.02) throw new Error(`roads [${set.map((r) => r.id).join(', ')}]: terrain is up to ${e.max.toFixed(2)} m off the floor level ${e.level.toFixed(2)}`);
      // the level itself is defined by the user terrain, not by the roads
      const bare = makeWorld((doc) => doc.structures.push({ ...CABIN }));
      expect(w.structureLevel(CABIN)).toBe(bare.structureLevel(CABIN));
      // the road is still built away from the building
      const c = w.compiled.roads[0];
      const k = c.sp.n >> 1;
      const gi = Math.round(w.hFinal.toGridZ(c.sp.z[k])) * RES + Math.round(w.hFinal.toGridX(c.sp.x[k]));
      expect(w.masks.road[gi]).toBeGreaterThan(200);
      expect(Math.abs(w.hFinal.data[gi] - c.prof[k])).toBeLessThan(0.12);
    }
  });

  it('validates building sites (water, slope, bounds, roads)', () => {
    const w = makeWorld((doc) => {
      doc.water.lakes.push({ id: 'l', x: 200, z: 0, level: 172 });
      doc.roads.push({ id: 'r', kind: 'road', nodes: [{ x: -200, z: 100 }, { x: -100, z: 100 }, { x: 0, z: 100 }] });
    });
    expect(w.water.stats.lakeCells[0]).toBeGreaterThan(100);
    expect(w.checkStructureSite({ type: 'cabin', x: 0, z: -60, rot: 0 })).toBeNull();
    expect(w.checkStructureSite({ type: 'cabin', x: 230, z: 0, rot: 0 })).toMatch(/under water/);
    expect(w.checkStructureSite({ type: 'cabin', x: 0, z: -60, rot: 0 }, { maxSlope: 0.05 })).toMatch(/slope too steep/);
    expect(w.checkStructureSite({ type: 'cabin', x: 254, z: 250, rot: 0 })).toMatch(/outside the terrain|under water/);
    expect(w.checkStructureSite({ type: 'cabin', x: -100, z: 100, rot: 0 })).toMatch(/overlaps a road/);
    // shoreline: dry but too close to the water
    let near = null;
    for (let x = 100; x < 230 && !near; x += 1) if (w.waterDepthAt(x + 6, 0) > 0.02 && w.waterDepthAt(x + 4.5, 0) <= 0.02) near = x;
    expect(near).not.toBeNull();
    expect(w.checkStructureSite({ type: 'shed', x: near, z: 0, rot: 0 }, { minWaterDist: 12 })).toMatch(/too close to water|under water/);
  });

  it('generates settlements deterministically and within their rules', () => {
    const mk = () =>
      makeWorld((doc) => {
        doc.roads.push({ id: 'r', kind: 'road', nodes: [{ x: -200, z: 60 }, { x: -80, z: 50 }, { x: 40, z: 70 }, { x: 180, z: 60 }] });
      });
    const st = { id: 'village', x: 0, z: 40, radius: 150, count: 6, seed: 3, types: ['cabin', 'shed'], rules: { minSpacing: 18, maxRoadDist: 45, minRoadDist: 9 } };
    const w = mk();
    const a = w.generateSettlement(st);
    const b = mk().generateSettlement(st);
    expect(a).toEqual(b);
    expect(a.length).toBe(6);
    expect(new Set(a.map((s) => s.id)).size).toBe(6);
    for (const s of a) {
      expect(Math.hypot(s.x - st.x, s.z - st.z)).toBeLessThanOrEqual(st.radius);
      expect(['cabin', 'shed']).toContain(s.type);
      expect(s.settlement).toBe('village');
      expect(w.checkStructureSite(s, st.rules)).toBeNull();
      for (const o of a) if (o !== s) expect(Math.hypot(o.x - s.x, o.z - s.z)).toBeGreaterThanOrEqual(18);
      // faces the road: the front (+Z local) points towards the nearest road point
      let best = Infinity,
        px = 0,
        pz = 0;
      const c = w.compiled.roads[0];
      for (let k = 0; k < c.sp.n; k++) {
        const d = Math.hypot(c.sp.x[k] - s.x, c.sp.z[k] - s.z);
        if (d < best) {
          best = d;
          px = c.sp.x[k];
          pz = c.sp.z[k];
        }
      }
      expect(best).toBeLessThanOrEqual(45 + 3);
      expect(best).toBeGreaterThanOrEqual(9 - 3);
      const dot = (Math.sin(s.rot) * (px - s.x) + Math.cos(s.rot) * (pz - s.z)) / best;
      expect(dot).toBeGreaterThan(0.8);
    }
    expect(w.generateSettlement({ ...st, seed: 4 })).not.toEqual(a);
    // built settlements keep every floor on the ground although they stand along the road
    w.project.structures.push(...a);
    w.deriveAll();
    for (const s of a) expect(floorError(w, s).max).toBeLessThan(0.02);
  });
});

describe('parametric building geometry', () => {
  it.each([
    ['cabin', 3],
    ['cabin', 11],
    ['shed', 7],
  ])('%s (variant %i) is a well-formed mesh with the expected dimensions', (type, variant) => {
    const s = { id: 'x', type, variant };
    const built = buildStructureGeometry(s);
    const P = cabinParams(s);
    expect(built.params).toEqual(P);
    const slots = built.parts.map((p) => p.material);
    expect(new Set(slots).size).toBe(slots.length);
    for (const need of ['wall', 'roof', 'stone', 'door', 'glass', 'trim']) expect(slots).toContain(need);
    const min = [Infinity, Infinity, Infinity],
      max = [-Infinity, -Infinity, -Infinity];
    for (const part of built.parts) {
      const nv = part.positions.length / 3;
      expect(part.normals.length).toBe(nv * 3);
      expect(part.uvs.length).toBe(nv * 2);
      expect(part.indices.length % 3).toBe(0);
      expect(part.indices.length).toBeGreaterThan(0);
      for (const i of part.indices) if (i >= nv) throw new Error(`${part.material}: index out of range`);
      for (let v = 0; v < nv; v++) {
        const l = Math.hypot(part.normals[v * 3], part.normals[v * 3 + 1], part.normals[v * 3 + 2]);
        if (Math.abs(l - 1) > 1e-4) throw new Error(`${part.material}: normal length ${l}`);
        for (let c = 0; c < 3; c++) {
          const q = part.positions[v * 3 + c];
          if (!Number.isFinite(q)) throw new Error('non-finite position');
          if (q < min[c]) min[c] = q;
          if (q > max[c]) max[c] = q;
        }
      }
      // every triangle faces along its vertex normal (consistent winding) and has area
      for (let t = 0; t < part.indices.length; t += 3) {
        const [a, b, c] = [part.indices[t] * 3, part.indices[t + 1] * 3, part.indices[t + 2] * 3];
        const p = part.positions;
        const u = [p[b] - p[a], p[b + 1] - p[a + 1], p[b + 2] - p[a + 2]];
        const v = [p[c] - p[a], p[c + 1] - p[a + 1], p[c + 2] - p[a + 2]];
        const n = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
        const area = Math.hypot(...n) / 2;
        if (!(area > 1e-7)) throw new Error(`${part.material}: degenerate triangle`);
        const dot = (n[0] * part.normals[a] + n[1] * part.normals[a + 1] + n[2] * part.normals[a + 2]) / (2 * area);
        if (dot < 0.99) throw new Error(`${part.material}: triangle winding disagrees with its normal (${dot})`);
      }
    }
    // footprint: walls at +-w/2, +-d/2 plus roof overhang; plinth 3 m into the ground; top = height
    expect(min[1]).toBe(-3);
    expect(max[1]).toBeCloseTo(built.height, 1);
    expect(built.height).toBeGreaterThan(P.plinth + P.wall);
    expect(max[0]).toBeGreaterThanOrEqual(P.w / 2);
    expect(max[0]).toBeLessThanOrEqual(P.w / 2 + P.overhang + 0.3);
    expect(-min[0]).toBeCloseTo(max[0], 5); // symmetric in x
    expect(max[2]).toBeGreaterThanOrEqual(P.d / 2);
    // the door is on the front (+Z) wall and starts at floor level
    const door = built.parts.find((p) => p.material === 'door');
    let dz = Infinity,
      dy = Infinity;
    for (let v = 0; v < door.positions.length / 3; v++) {
      dz = Math.min(dz, door.positions[v * 3 + 2]);
      dy = Math.min(dy, door.positions[v * 3 + 1]);
      expect(door.normals[v * 3 + 2]).toBeCloseTo(1, 5);
    }
    expect(dz).toBeGreaterThan(P.d / 2 - 0.2);
    expect(dy).toBeCloseTo(P.plinth, 5);
    // the roof faces upwards
    const roof = built.parts.find((p) => p.material === 'roof');
    for (let v = 0; v < roof.normals.length / 3; v++) expect(roof.normals[v * 3 + 1]).toBeGreaterThan(0.3);
    // deterministic, and variants differ
    expect(hashBytes(buildStructureGeometry(s).parts[0].positions)).toBe(hashBytes(built.parts[0].positions));
    expect(cabinParams({ type, variant: variant + 1 })).not.toEqual(P);
    const fp = structureFootprint(s, EMPTY);
    expect(fp.halfX).toBeCloseTo(P.w / 2, 10);
    expect(fp.halfZ).toBeGreaterThanOrEqual(P.d / 2);
  });

  it('explicit dimensions override the variant', () => {
    const P = cabinParams({ type: 'cabin', variant: 5, w: 9, d: 6, wall: 3, pitch: 0.5, chimney: false, porch: true });
    expect(P).toMatchObject({ w: 9, d: 6, wall: 3, pitch: 0.5, chimney: false, porch: true });
    const built = buildStructureGeometry({ type: 'cabin', variant: 5, w: 9, d: 6, wall: 3, pitch: 0.5, chimney: false, porch: true });
    // ridge height = plinth + wall + (d/2) * pitch
    expect(built.height).toBeCloseTo(P.plinth + 3 + 3 * 0.5 + 0.2, 5);
    expect(structureFootprint({ type: 'cabin', variant: 5, w: 9, d: 6, porch: true }, EMPTY).halfZ).toBeCloseTo(3.9, 10);
    expect(structureFootprint({ type: 'unknown' }, EMPTY)).toBeNull();
    const m = structureFootprint({ type: 'model', model: 'm', scale: 2 }, { models: { m: { bounds: { min: [-1, 0, -2], max: [1, 3, 2] } } } });
    expect(m).toMatchObject({ halfX: 2, halfZ: 4, pad: false });
  });
});
