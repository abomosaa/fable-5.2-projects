// Water: coordinate transforms, lake / sea flood fills, river carving, the depth-averaged flow
// solve (continuity) and the linear wave theory used for swell.
import { describe, it, expect, beforeAll } from 'vitest';
import { Heightfield, sampleGrid } from '../src/core/heightfield.js';
import { WaterField, computeWaterField, waveNumber, shoalingCoefficient, NO_WATER, WATER_DRY, WATER_RIVER, WATER_LAKE, WATER_OCEAN } from '../src/core/waterField.js';
import { compileRiver, RIVER_DEFAULTS } from '../src/core/carve.js';
import { createProjectDoc, snapHeights } from '../src/core/project.js';
import { World } from '../src/core/world.js';
import { Noise2D } from '../src/core/noise.js';
import { hashBytes } from './helpers/world.js';

const G = 9.81;
const EMPTY = { models: {}, textures: {} };
const still = (extra = {}) => ({ sea: { enabled: false, level: 0 }, lakes: [], wind: { dir: 0, speed: 4 }, swell: { height: 1, period: 9, dir: 0 }, ...extra });

describe('heightfield coordinates and sampling', () => {
  const res = 65,
    size = 320; // cell 5 m
  const hf = new Heightfield(res, size);
  for (let iz = 0; iz < res; iz++) for (let ix = 0; ix < res; ix++) hf.data[iz * res + ix] = Math.sin(ix * 0.37) * 9 + Math.cos(iz * 0.21) * 7 + ix * 0.3;

  it('maps grid <-> world consistently (origin at the centre, x east, z south)', () => {
    expect(hf.cell).toBe(5);
    expect(hf.toWorldX(0)).toBe(-160);
    expect(hf.toWorldZ(0)).toBe(-160);
    expect(hf.toWorldX(res - 1)).toBe(160);
    expect(hf.toGridX(0)).toBe((res - 1) / 2);
    for (const g of [0, 1, 7.25, 31.5, 63.999, 64]) {
      expect(hf.toGridX(hf.toWorldX(g))).toBeCloseTo(g, 10);
      expect(hf.toGridZ(hf.toWorldZ(g))).toBeCloseTo(g, 10);
    }
    for (const x of [-160, -33.3, 0, 12.5, 159.9]) {
      expect(hf.toWorldX(hf.toGridX(x))).toBeCloseTo(x, 10);
      expect(hf.toWorldZ(hf.toGridZ(x))).toBeCloseTo(x, 10);
    }
    expect(hf.inBounds(160, -160)).toBe(true);
    expect(hf.inBounds(160.01, 0)).toBe(false);
    const r = hf.rectFromWorld(-12, 3, 12, 28);
    expect(r).toEqual({ x0: 29, z0: 32, x1: 35, z1: 38 });
    expect(hf.rectFromWorld(-1e6, -1e6, 1e6, 1e6, 3)).toEqual({ x0: 0, z0: 0, x1: res - 1, z1: res - 1 });
  });

  it('sample() returns grid values at vertices and bilinear interpolation in between', () => {
    for (let iz = 0; iz < res; iz += 3) for (let ix = 0; ix < res; ix += 5) expect(hf.sample(hf.toWorldX(ix), hf.toWorldZ(iz))).toBe(hf.data[iz * res + ix]);
    expect(hf.get(10, 20)).toBe(hf.data[20 * res + 10]);
    expect(hf.get(-5, 999)).toBe(hf.data[(res - 1) * res]); // clamped
    for (const [ix, iz, fx, fz] of [
      [3, 4, 0.5, 0.5],
      [10, 40, 0.25, 0.8],
      [63, 0, 0.9, 0.1],
      [0, 63, 0.01, 0.99],
    ]) {
      const a = hf.data[iz * res + ix],
        b = hf.data[iz * res + ix + 1],
        c = hf.data[(iz + 1) * res + ix],
        d = hf.data[(iz + 1) * res + ix + 1];
      const want = a * (1 - fx) * (1 - fz) + b * fx * (1 - fz) + c * (1 - fx) * fz + d * fx * fz;
      expect(hf.sample(hf.toWorldX(ix + fx), hf.toWorldZ(iz + fz))).toBeCloseTo(want, 4);
      expect(sampleGrid(hf.data, res, ix + fx, iz + fz)).toBeCloseTo(want, 4);
      // along a cell edge the interpolation is linear between the two vertices
      expect(hf.sample(hf.toWorldX(ix + fx), hf.toWorldZ(iz))).toBeCloseTo(a + (b - a) * fx, 4);
    }
    // outside the terrain the sample clamps to the border
    expect(hf.sample(-1e4, -1e4)).toBe(hf.data[0]);
    expect(hf.sample(1e4, 1e4)).toBe(hf.data[res * res - 1]);
    // gradient of a plane is exact
    const plane = new Heightfield(33, 64);
    for (let iz = 0; iz < 33; iz++) for (let ix = 0; ix < 33; ix++) plane.data[iz * 33 + ix] = 0.3 * plane.toWorldX(ix) - 0.2 * plane.toWorldZ(iz) + 5;
    const g = plane.gradient(3.3, -7.1);
    expect(g[0]).toBeCloseTo(0.3, 5);
    expect(g[1]).toBeCloseTo(-0.2, 5);
    expect(plane.slope(3.3, -7.1)).toBeCloseTo(Math.hypot(0.3, 0.2), 5);
    const nrm = plane.normal(0, 0);
    expect(Math.hypot(...nrm)).toBeCloseTo(1, 10);
    expect(nrm[1]).toBeGreaterThan(0);
    expect(nrm[0]).toBeLessThan(0); // tilts away from the uphill (+x) direction
  });

  it('extract / inject round-trips a rect', () => {
    const rect = { x0: 5, z0: 9, x1: 17, z1: 12 };
    const snap = hf.extract(rect);
    expect(snap.length).toBe(13 * 4);
    const copy = hf.clone();
    for (let iz = rect.z0; iz <= rect.z1; iz++) for (let ix = rect.x0; ix <= rect.x1; ix++) copy.data[iz * res + ix] = -1;
    copy.inject(rect, snap);
    expect(hashBytes(copy.data)).toBe(hashBytes(hf.data));
  });
});

describe('lake flood fill', () => {
  const res = 129,
    size = 512,
    cell = 4;
  // two bowls separated by a saddle at ~16 m; floors at 0 m (west, seeded) and 3 m (east)
  const hf = new Heightfield(res, size);
  const n = new Noise2D(21);
  for (let iz = 0; iz < res; iz++) {
    for (let ix = 0; ix < res; ix++) {
      const x = hf.toWorldX(ix),
        z = hf.toWorldZ(iz);
      const a = 0.001 * ((x + 120) ** 2 + z * z);
      const b = 3 + 0.001 * ((x - 120) ** 2 + z * z);
      hf.data[iz * res + ix] = Math.min(a, b, 40) + n.fbm(x / 40, z / 40, 2) * 0.6;
    }
  }
  const lake = (level) => ({ x: -120, z: 0, level });
  const fill = (level, wf = new WaterField(res, size)) => {
    const stats = computeWaterField(wf, hf, still({ lakes: [lake(level)] }), []);
    return { wf, stats };
  };
  /** Independent reference: 4-connected component of {h < level} containing the seed. */
  const reference = (level) => {
    const seed = Math.round(hf.toGridZ(0)) * res + Math.round(hf.toGridX(-120));
    const inSet = new Uint8Array(res * res);
    if (!(hf.data[seed] < level)) return inSet;
    const stack = [seed];
    inSet[seed] = 1;
    while (stack.length) {
      const c = stack.pop();
      const cx = c % res,
        cz = (c / res) | 0;
      for (const [dx, dz] of [
        [1, 0],
        [-1, 0],
        [0, 1],
        [0, -1],
      ]) {
        const x = cx + dx,
          z = cz + dz;
        if (x < 0 || z < 0 || x >= res || z >= res) continue;
        const i = z * res + x;
        if (!inSet[i] && hf.data[i] < level) {
          inSet[i] = 1;
          stack.push(i);
        }
      }
    }
    return inSet;
  };

  it('wets exactly the cells below the level that are connected to the seed', () => {
    for (const level of [2, 6, 11, 15.5, 16.5, 25]) {
      const { wf, stats } = fill(level);
      const ref = reference(level);
      let wet = 0;
      for (let i = 0; i < res * res; i++) {
        if (wf.type[i] !== (ref[i] ? WATER_LAKE : WATER_DRY)) throw new Error(`level ${level}: cell ${i} type ${wf.type[i]}, reference ${ref[i]}`);
        if (wf.type[i]) {
          wet++;
          if (!(hf.data[i] < level)) throw new Error('wet cell above the lake level');
          if (wf.surf[i] !== Math.fround(level)) throw new Error('wet cell surface is not the lake level');
        }
      }
      expect(stats.lakeCells).toEqual([wet]);
      expect(wet).toBeGreaterThan(50);
    }
    // below the saddle the eastern bowl (not connected) stays dry although it lies below the level
    const low = fill(8).wf;
    const east = Math.round(hf.toGridZ(0)) * res + Math.round(hf.toGridX(120));
    expect(hf.data[east]).toBeLessThan(8);
    expect(low.type[east]).toBe(WATER_DRY);
    // above the saddle both bowls are one lake
    expect(fill(19).wf.type[east]).toBe(WATER_LAKE);
    // a seed on dry ground (level below the floor) floods nothing
    expect(fill(-5).stats.lakeCells).toEqual([0]);
  });

  it('wet area grows monotonically with the level (nested sets)', () => {
    let prev = null,
      prevCount = -1;
    for (let level = 0.5; level <= 30; level += 1.25) {
      const { wf, stats } = fill(level);
      expect(stats.lakeCells[0]).toBeGreaterThanOrEqual(prevCount);
      if (prev) for (let i = 0; i < res * res; i++) if (prev[i] && !wf.type[i]) throw new Error(`cell ${i} dried out when the level rose to ${level}`);
      prev = new Uint8Array(wf.type);
      prevCount = stats.lakeCells[0];
    }
    expect(prevCount).toBeGreaterThan(2000);
  });

  it('raising and then lowering the level restores exactly the same cells', () => {
    const wf = new WaterField(res, size);
    fill(6, wf);
    const before = { type: hashBytes(wf.type), surf: hashBytes(wf.surf), shore: hashBytes(wf.shore), typeExt: hashBytes(wf.typeExt) };
    const count = wf.stats.lakeCells[0];
    fill(19, wf);
    expect(wf.stats.lakeCells[0]).toBeGreaterThan(count * 2);
    expect(hashBytes(wf.type)).not.toBe(before.type);
    fill(6, wf);
    expect(wf.stats.lakeCells[0]).toBe(count);
    expect({ type: hashBytes(wf.type), surf: hashBytes(wf.surf), shore: hashBytes(wf.shore), typeExt: hashBytes(wf.typeExt) }).toEqual(before);
    // and equals a fresh solve
    const fresh = fill(6).wf;
    expect(hashBytes(fresh.type)).toBe(before.type);
    expect(hashBytes(fresh.surf)).toBe(before.surf);
  });

  it('derives shore distance, depth queries and the extended surface consistently', () => {
    const { wf } = fill(10);
    let wetPos = 0,
      dryNeg = 0;
    for (let i = 0; i < res * res; i++) {
      if (wf.type[i]) {
        if (!(wf.shore[i] > 0)) throw new Error('wet cell with non-positive shore distance');
        wetPos++;
      } else {
        if (!(wf.shore[i] < 0)) throw new Error('dry cell with non-negative shore distance');
        dryNeg++;
        // the surface is only extended over ground at / above the water level (never into dry hollows)
        if (wf.surf[i] > NO_WATER * 0.5 && hf.data[i] < wf.surf[i]) throw new Error('surface extended over lower dry ground');
      }
    }
    expect(wetPos).toBeGreaterThan(100);
    expect(dryNeg).toBeGreaterThan(100);
    // centre of the bowl: deep water, far from shore; depth = level - ground
    expect(wf.depthAt(hf, -120, 0)).toBeCloseTo(10 - hf.sample(-120, 0), 3);
    const ci = Math.round(hf.toGridZ(0)) * res + Math.round(hf.toGridX(-120));
    expect(wf.shore[ci]).toBeGreaterThan(20);
    expect(wf.depthAt(hf, 250, 250)).toBe(-1); // far from any water
    expect(wf.surfaceAt(hf, 250, 250)).toBe(NO_WATER);
    void cell;
  });
});

describe('sea flood fill', () => {
  const res = 129,
    size = 512;
  // island rising from a shelf at -6 m; a crater on the island reaches -4 m, rim >= +5 m
  const hf = new Heightfield(res, size);
  for (let iz = 0; iz < res; iz++) {
    for (let ix = 0; ix < res; ix++) {
      const x = hf.toWorldX(ix),
        z = hf.toWorldZ(iz);
      const r = Math.hypot(x, z);
      let h = -6 + 26 * Math.exp(-(r * r) / (2 * 130 * 130));
      const rc = Math.hypot(x - 40, z + 10);
      h -= 24 * Math.exp(-(rc * rc) / (2 * 22 * 22));
      hf.data[iz * res + ix] = h;
    }
  }
  const crater = Math.round(hf.toGridZ(-10)) * res + Math.round(hf.toGridX(40));

  it('floods from the border only: inland hollows below sea level stay dry', () => {
    expect(hf.data[crater]).toBeLessThan(-2);
    const wf = new WaterField(res, size);
    const stats = computeWaterField(wf, hf, still({ sea: { enabled: true, level: 0 } }), []);
    let below = 0,
      ocean = 0,
      dryBelow = 0;
    for (let i = 0; i < res * res; i++) {
      if (hf.data[i] < 0) below++;
      if (wf.type[i] === WATER_OCEAN) {
        ocean++;
        if (!(hf.data[i] < 0)) throw new Error('ocean cell above sea level');
        if (wf.surf[i] !== 0) throw new Error('ocean surface is not at sea level');
      } else if (hf.data[i] < 0) {
        dryBelow++;
        // not even the extended (rendering) surface may cover the hollow
        if (wf.surf[i] > NO_WATER * 0.5) throw new Error('water surface extended into an unconnected hollow');
      } else if (wf.type[i] !== WATER_DRY) throw new Error('unexpected water type');
    }
    expect(stats.oceanCells).toBe(ocean);
    expect(wf.type[crater]).toBe(WATER_DRY);
    expect(dryBelow).toBeGreaterThan(20); // the crater floor
    expect(ocean + dryBelow).toBe(below);
    // all four borders are sea
    for (const i of [0, res - 1, (res - 1) * res, res * res - 1, res >> 1, (res >> 1) * res]) expect(wf.type[i]).toBe(WATER_OCEAN);
    // every ocean cell is 4-connected to the border through ocean cells
    const seen = new Uint8Array(res * res);
    const stack = [];
    for (let i = 0; i < res; i++) for (const c of [i, (res - 1) * res + i, i * res, i * res + res - 1]) if (wf.type[c] === WATER_OCEAN && !seen[c]) (seen[c] = 1), stack.push(c);
    let reached = 0;
    while (stack.length) {
      const c = stack.pop();
      reached++;
      const cx = c % res,
        cz = (c / res) | 0;
      for (const [dx, dz] of [
        [1, 0],
        [-1, 0],
        [0, 1],
        [0, -1],
      ]) {
        const x = cx + dx,
          z = cz + dz;
        if (x < 0 || z < 0 || x >= res || z >= res) continue;
        const i = z * res + x;
        if (!seen[i] && wf.type[i] === WATER_OCEAN) (seen[i] = 1), stack.push(i);
      }
    }
    expect(reached).toBe(ocean);
  });

  it('a sea level above the rim connects and floods the crater; disabling the sea dries everything', () => {
    const wf = new WaterField(res, size);
    computeWaterField(wf, hf, still({ sea: { enabled: true, level: 19 } }), []);
    expect(wf.type[crater]).toBe(WATER_OCEAN);
    computeWaterField(wf, hf, still({ sea: { enabled: false, level: 19 } }), []);
    let wet = 0;
    for (let i = 0; i < res * res; i++) if (wf.type[i] || wf.surf[i] > NO_WATER * 0.5) wet++;
    expect(wet).toBe(0);
    // a lake seeded in the crater fills it independently of the sea
    const stats = computeWaterField(wf, hf, still({ sea: { enabled: true, level: 0 }, lakes: [{ x: 40, z: -10, level: 1 }] }), []);
    expect(wf.type[crater]).toBe(WATER_LAKE);
    expect(stats.lakeCells[0]).toBeGreaterThan(20);
    expect(wf.surf[crater]).toBe(1);
  });
});

describe('river carving and flow', () => {
  const res = 257,
    size = 256; // 1 m cells
  const FLOW = 6;
  const WIDTHS = [12, 12, 12, 5, 5, 5, 12, 12, 12];
  const heights = () => {
    const n = new Noise2D(3);
    const h = new Float32Array(res * res);
    for (let iz = 0; iz < res; iz++) {
      for (let ix = 0; ix < res; ix++) {
        const x = -128 + ix,
          z = -128 + iz;
        h[iz * res + ix] = 60 - 0.02 * (z + 128) + 0.0015 * x * x + n.fbm(x / 25, z / 25, 2) * 0.4;
      }
    }
    return h;
  };
  const riverNodes = (shift = 0) => WIDTHS.map((w, i) => ({ x: 6 * Math.sin(i * 0.9) + (i === 4 ? shift : 0), z: -112 + i * 28, width: w }));
  const makeWorld = (river = {}) => {
    const { doc } = createProjectDoc({ name: 'river', preset: 'hills', seed: 3, manifest: EMPTY, terrain: { res, size } });
    doc.id = 'river-test';
    doc.water.rivers.push({ id: 'r1', nodes: riverNodes(), width: 12, depth: 0.8, flow: FLOW, ...river });
    const w = new World(doc, { heights: heights() }, EMPTY);
    w.deriveAll();
    return w;
  };
  let world, c, sp, wf;
  beforeAll(() => {
    world = makeWorld();
    c = world.compiled.rivers[0];
    sp = c.sp;
    wf = world.water;
  });
  const nearestK = (z) => {
    let k = 0,
      best = Infinity;
    for (let q = 0; q < sp.n; q++) {
      const d = Math.abs(sp.z[q] - z);
      if (d < best) {
        best = d;
        k = q;
      }
    }
    return k;
  };

  it('compiles a long profile that falls downstream (bed and water surface)', () => {
    expect(sp.n).toBeGreaterThan(300);
    expect(sp.length).toBeGreaterThan(224);
    for (let k = 1; k < sp.n; k++) {
      if (!(c.surf[k] < c.surf[k - 1])) throw new Error(`water surface does not fall at sample ${k}`);
      if (!(c.depth[k] > 0)) throw new Error(`non-positive depth at sample ${k}`);
      expect(c.surf[k]).toBeGreaterThan(c.bed[k]);
    }
    // overall fall follows the 2 % valley
    expect(c.surf[0] - c.surf[sp.n - 1]).toBeGreaterThan(0.012 * sp.length);
    expect(c.surf[0] - c.surf[sp.n - 1]).toBeLessThan(0.03 * sp.length);
    // without pool / riffle relief the bed itself falls strictly; pools and riffles only add
    // bounded local relief on top of that falling mean bed
    const plain = compileRiver({ ...world.project.water.rivers[0], poolRiffle: 0 }, world.hUser, world.project.seed);
    for (let k = 1; k < plain.sp.n; k++) if (!(plain.bed[k] < plain.bed[k - 1])) throw new Error(`mean bed does not fall at sample ${k}`);
    let rises = 0;
    for (let k = 0; k < sp.n; k++) {
      expect(Math.abs(c.bed[k] - plain.bed[k])).toBeLessThanOrEqual(0.5 * RIVER_DEFAULTS.poolRiffle * plain.depth[k] * 1.5 + 1e-4);
      if (k > 0 && c.bed[k] > c.bed[k - 1]) rises++;
    }
    expect(rises / sp.n).toBeLessThan(0.1);
    // the bed lies below the original ground everywhere
    for (let k = 0; k < sp.n; k += 5) expect(c.bed[k]).toBeLessThan(world.hUser.sample(sp.x[k], sp.z[k]));
    // per-node widths are interpolated: the middle reach is the constriction
    expect(c.hw[nearestK(0)]).toBeLessThan(3.2);
    expect(c.hw[nearestK(-75)]).toBeGreaterThan(4.8);
  });

  it('carves the channel: final terrain under the centreline equals the bed (within bed roughness) and is wet', () => {
    let maxErr = 0,
      checked = 0;
    for (let k = 4; k < sp.n - 4; k++) {
      const x = sp.x[k],
        z = sp.z[k];
      const ground = world.hFinal.sample(x, z);
      const tol = RIVER_DEFAULTS.bedRoughness * c.depth[k] + 0.06; // boulder-bed relief + cross-section rise within one cell
      const err = Math.abs(ground - c.bed[k]);
      if (err > tol) throw new Error(`sample ${k}: carved bed ${ground.toFixed(3)} vs profile ${c.bed[k].toFixed(3)} (tolerance ${tol.toFixed(3)})`);
      maxErr = Math.max(maxErr, err);
      expect(ground).toBeLessThan(world.hUser.sample(x, z));
      const depth = world.waterDepthAt(x, z);
      if (!(depth > 0.05)) throw new Error(`sample ${k}: water depth ${depth}`);
      expect(depth).toBeLessThan(c.depth[k] * (1 + RIVER_DEFAULTS.bedRoughness) + 0.1);
      expect(world.waterSurfaceAt(x, z)).toBeCloseTo(c.surf[k], 1);
      const gi = Math.round(world.hFinal.toGridZ(z)) * res + Math.round(world.hFinal.toGridX(x));
      expect(wf.type[gi]).toBe(WATER_RIVER);
      expect(world.masks.channel[gi]).toBe(255);
      checked++;
    }
    expect(checked).toBeGreaterThan(300);
    expect(maxErr).toBeGreaterThan(0.005); // the bed is rough, not a smooth chute
    expect(wf.stats.riverCells).toBeGreaterThan(1500);
    // nothing is carved or wet far from the river
    for (let iz = 0; iz < res; iz += 7) {
      for (const ix of [2, 30, res - 31, res - 3]) {
        const i = iz * res + ix;
        expect(world.hFinal.data[i]).toBe(world.hUser.data[i]);
        expect(wf.type[i]).toBe(WATER_DRY);
      }
    }
  });

  it('moving a node carves the new course and restores the old channel to the user surface exactly', () => {
    const w = makeWorld();
    const before = { hFinal: new Float32Array(w.hFinal.data), channel: new Uint8Array(w.masks.channel), type: new Uint8Array(w.water.type) };
    const SHIFT = 60;
    w.project.water.rivers[0].nodes = riverNodes(SHIFT);
    w.deriveRect({ x0: 0, z0: 0, x1: 0, z1: 0 }, { forceWater: true }); // the editor's path-edit update
    const moved = w.compiled.rivers[0];
    // 1. the incremental update equals a full derivation of the edited project
    const fresh = makeWorld({ nodes: riverNodes(SHIFT) });
    expect(hashBytes(w.hFinal.data)).toBe(hashBytes(fresh.hFinal.data));
    expect(hashBytes(w.masks.channel)).toBe(hashBytes(fresh.masks.channel));
    expect(hashBytes(w.masks.bank)).toBe(hashBytes(fresh.masks.bank));
    expect(hashBytes(w.water.type)).toBe(hashBytes(fresh.water.type));
    expect(hashBytes(w.water.surf)).toBe(hashBytes(fresh.water.surf));
    expect(hashBytes(w.hUser.data)).toBe(hashBytes(snapHeights(heights()))); // the user surface was never touched (it lives on the 1/1024 m storage grid)
    // 2. cells of the old channel that the new course does not influence are back on the user surface
    const { rect, w: rw, idx } = moved.raster;
    const inNewRaster = (ix, iz) => ix >= rect.x0 && ix <= rect.x1 && iz >= rect.z0 && iz <= rect.z1 && idx[(iz - rect.z0) * rw + (ix - rect.x0)] >= 0;
    let restored = 0,
      stillCarved = 0;
    for (let iz = 0; iz < res; iz++) {
      for (let ix = 0; ix < res; ix++) {
        const i = iz * res + ix;
        if (before.channel[i] !== 255) continue;
        if (inNewRaster(ix, iz)) {
          stillCarved++;
          continue;
        }
        if (w.hFinal.data[i] !== w.hUser.data[i]) throw new Error(`old channel cell ${ix},${iz} was not restored (${w.hFinal.data[i]} vs ${w.hUser.data[i]})`);
        if (w.masks.channel[i] !== 0 || w.masks.bank[i] !== 0 || w.water.type[i] !== WATER_DRY) throw new Error(`old channel cell ${ix},${iz} still has river masks / water`);
        if (!(before.hFinal[i] < w.hUser.data[i])) throw new Error('old channel cell was not carved before the move');
        restored++;
      }
    }
    expect(restored).toBeGreaterThan(80);
    expect(stillCarved).toBeGreaterThan(300); // upstream / downstream reaches did not move
    // 3. the channel now runs through the shifted node
    const node = w.project.water.rivers[0].nodes[4];
    const gi = Math.round(w.hFinal.toGridZ(node.z)) * res + Math.round(w.hFinal.toGridX(node.x));
    expect(before.channel[gi]).toBe(0);
    expect(before.type[gi]).toBe(WATER_DRY);
    expect(w.masks.channel[gi]).toBe(255);
    expect(w.water.type[gi]).toBe(WATER_RIVER);
    expect(w.hFinal.data[gi]).toBeLessThan(w.hUser.data[gi]);
    // 4. moving it back restores the original state bit for bit
    w.project.water.rivers[0].nodes = riverNodes(0);
    w.deriveRect({ x0: 0, z0: 0, x1: 0, z1: 0 }, { forceWater: true });
    expect(hashBytes(w.hFinal.data)).toBe(hashBytes(before.hFinal));
    expect(hashBytes(w.masks.channel)).toBe(hashBytes(before.channel));
    expect(hashBytes(w.water.type)).toBe(hashBytes(before.type));
    // hiding the river removes every trace of it
    w.project.water.rivers[0].hidden = true;
    w.deriveAll();
    expect(hashBytes(w.hFinal.data)).toBe(hashBytes(w.hUser.data));
    expect(w.water.stats.riverCells).toBe(0);
  });

  it('conserves discharge: integrating velocity x depth across the channel gives the river flow', () => {
    // the river runs towards +z, so a grid row is a cross-section and vz the normal velocity
    const qs = [];
    for (const z of [-90, -70, -50, -30, -10, 10, 30, 50, 70, 90]) {
      const iz = z + 128;
      let q = 0,
        wet = 0;
      for (let ix = 0; ix < res; ix++) {
        const i = iz * res + ix;
        if (wf.type[i] !== WATER_RIVER) continue;
        wet++;
        q += wf.vz[i] * (wf.surf[i] - world.hFinal.data[i]) * world.hFinal.cell;
      }
      expect(wet).toBeGreaterThanOrEqual(4);
      qs.push(q);
    }
    for (const q of qs) {
      expect(q).toBeGreaterThan(FLOW * 0.87);
      expect(q).toBeLessThan(FLOW * 1.13);
    }
    // continuity: the same discharge passes every section
    expect(Math.max(...qs) - Math.min(...qs)).toBeLessThan(FLOW * 0.12);
    // doubling the flow doubles the discharge through the same channel
    const w2 = makeWorld({ flow: FLOW * 2 });
    let q2 = 0;
    for (let ix = 0; ix < res; ix++) {
      const i = (50 + 128) * res + ix;
      if (w2.water.type[i] === WATER_RIVER) q2 += w2.water.vz[i] * (w2.water.surf[i] - w2.hFinal.data[i]);
    }
    expect(q2 / qs[7]).toBeGreaterThan(1.8);
    expect(q2 / qs[7]).toBeLessThan(2.2);
  });

  it('flows downstream, faster through the constriction than in the wide reaches', () => {
    let along = 0,
      n = 0;
    const speedAt = (z0, z1) => {
      let s = 0,
        m = 0;
      for (let k = 0; k < sp.n; k++) {
        if (sp.z[k] < z0 || sp.z[k] > z1) continue;
        const v = wf.velocityAt(sp.x[k], sp.z[k]);
        s += v[0] * sp.tx[k] + v[1] * sp.tz[k];
        m++;
      }
      return s / m;
    };
    for (let k = 8; k < sp.n - 8; k++) {
      const v = wf.velocityAt(sp.x[k], sp.z[k]);
      const d = v[0] * sp.tx[k] + v[1] * sp.tz[k];
      if (!(d > 0)) throw new Error(`centreline velocity points upstream at sample ${k} (${d})`);
      // mostly along the channel, little cross flow
      expect(Math.abs(v[0] * -sp.tz[k] + v[1] * sp.tx[k])).toBeLessThan(Math.max(0.6, d));
      along += d;
      n++;
    }
    expect(along / n).toBeGreaterThan(0.5);
    const narrow = speedAt(-25, 25);
    const wideUp = speedAt(-85, -60);
    const wideDown = speedAt(55, 90);
    expect(narrow).toBeGreaterThan(1.5 * wideUp);
    expect(narrow).toBeGreaterThan(1.5 * wideDown);
    // mean velocity is consistent with Q = v * A for the wide reach (order of magnitude check)
    const k = nearestK(70);
    const area = 2 * c.hw[k] * c.depth[k] * 0.7; // parabolic-ish section
    expect(wideDown).toBeGreaterThan((FLOW / area) * 0.5);
    expect(wideDown).toBeLessThan((FLOW / area) * 2.2);
    // no flow outside the water, speeds are bounded
    let vmax = 0;
    for (let i = 0; i < res * res; i++) {
      const v = Math.hypot(wf.vx[i], wf.vz[i]);
      vmax = Math.max(vmax, v);
    }
    expect(vmax).toBeLessThanOrEqual(6.5 + 1e-6);
    expect(Math.hypot(wf.vx[5 * res + 5], wf.vz[5 * res + 5])).toBe(0);
  });

  it('a river entering a lake keeps the lake level and marks the reach above it as river', () => {
    const { doc } = createProjectDoc({ name: 'mouth', preset: 'hills', seed: 3, manifest: EMPTY, terrain: { res, size } });
    const h = heights();
    // dam the southern end: ground rises again beyond z = 60, creating a basin
    for (let iz = 0; iz < res; iz++) for (let ix = 0; ix < res; ix++) if (iz - 128 > 60) h[iz * res + ix] += (iz - 128 - 60) * 0.25;
    doc.water.rivers.push({ id: 'r1', nodes: riverNodes().slice(0, 7), width: 10, depth: 0.8, flow: FLOW });
    const level = 57.2;
    doc.water.lakes.push({ id: 'l1', x: 0, z: 58, level });
    const w = new World(doc, { heights: h }, EMPTY);
    w.deriveAll();
    expect(w.water.stats.lakeCells[0]).toBeGreaterThan(300);
    let lakeOk = 0,
      riverAbove = 0;
    for (let i = 0; i < res * res; i++) {
      if (w.water.type[i] === WATER_LAKE) {
        if (w.water.surf[i] !== Math.fround(level)) throw new Error('lake surface changed by the river');
        lakeOk++;
      } else if (w.water.type[i] === WATER_RIVER) {
        if (!(w.water.surf[i] > level)) throw new Error('river cell at / below the lake level should be part of the lake');
        riverAbove++;
      }
    }
    expect(lakeOk).toBeGreaterThan(300);
    expect(riverAbove).toBeGreaterThan(300);
  });
});

describe('linear wave theory for swell', () => {
  /** Exact wavenumber: Newton iteration on g k tanh(k d) = omega^2. */
  const exactK = (omega, d) => {
    let k = (omega * omega) / G;
    if (k * d < 1) k = omega / Math.sqrt(G * d);
    for (let i = 0; i < 60; i++) {
      const t = Math.tanh(k * d);
      const f = G * k * t - omega * omega;
      const df = G * t + G * k * d * (1 - t * t);
      k -= f / df;
    }
    return k;
  };

  it('waveNumber satisfies the dispersion relation within the documented 5 % (Eckart)', () => {
    let worst = 0;
    for (const T of [2.5, 4, 6, 9, 12, 16]) {
      const omega = (2 * Math.PI) / T;
      for (let d = 0.1; d < 4000; d *= 1.37) {
        const k = waveNumber(omega, d);
        const ke = exactK(omega, d);
        expect(Math.abs(G * ke * Math.tanh(ke * d) - omega * omega)).toBeLessThan(1e-9); // the reference is exact
        const err = Math.abs(k - ke) / ke;
        worst = Math.max(worst, err);
        // residual of the dispersion relation itself
        expect(Math.abs(G * k * Math.tanh(k * d) - omega * omega) / (omega * omega)).toBeLessThan(0.08);
      }
    }
    expect(worst).toBeLessThan(0.05);
    expect(worst).toBeGreaterThan(0.005); // it is an approximation; the test would notice a swap to the exact solver
  });

  it('has the right deep and shallow water limits and is monotonic in depth', () => {
    const omega = (2 * Math.PI) / 9;
    const k0 = (omega * omega) / G;
    // deep water (d > half a wavelength): k = omega^2 / g, phase speed g / omega
    expect(waveNumber(omega, 500)).toBeCloseTo(k0, 8);
    expect(waveNumber(omega, 80) / k0).toBeCloseTo(1, 2);
    // shallow water (k d << 1): phase speed sqrt(g d)
    for (const d of [0.1, 0.3, 0.8]) expect(omega / waveNumber(omega, d) / Math.sqrt(G * d)).toBeCloseTo(1, 1);
    // waves shorten monotonically as the water shoals
    let prev = 0;
    for (let d = 300; d > 0.06; d *= 0.8) {
      const k = waveNumber(omega, d);
      expect(k).toBeGreaterThanOrEqual(prev);
      prev = k;
    }
    // the depth is floored at 5 cm so the swash zone stays finite
    expect(waveNumber(omega, 0)).toBe(waveNumber(omega, 0.05));
    expect(Number.isFinite(waveNumber(omega, -3))).toBe(true);
    // shorter periods give shorter waves at every depth
    expect(waveNumber((2 * Math.PI) / 5, 10)).toBeGreaterThan(waveNumber(omega, 10));
  });

  it('shoalingCoefficient conserves energy flux: 1 offshore, dips below 1, then grows like Green\'s law', () => {
    const omega = (2 * Math.PI) / 9;
    expect(shoalingCoefficient(omega, 2000)).toBeCloseTo(1, 6);
    // exact theory: Ks = sqrt(cg0 / cg) with cg = c/2 (1 + 2kd / sinh 2kd)
    let minKs = Infinity,
      minDepth = 0;
    for (let d = 0.3; d < 300; d *= 1.04) {
      const ks = shoalingCoefficient(omega, d);
      const k = exactK(omega, d);
      const cg = (omega / k) * 0.5 * (1 + (2 * k * d) / Math.sinh(2 * k * d));
      const exact = Math.sqrt((0.5 * G) / omega / cg);
      expect(Math.abs(ks - exact) / exact).toBeLessThan(0.05);
      if (ks < minKs) {
        minKs = ks;
        minDepth = d;
      }
    }
    // the classic minimum (0.913 exactly) at intermediate depth k d ~ 1.2
    expect(minKs).toBeGreaterThan(0.86);
    expect(minKs).toBeLessThan(0.93);
    const kd = exactK(omega, minDepth) * minDepth;
    expect(kd).toBeGreaterThan(0.7);
    expect(kd).toBeLessThan(1.8);
    // shallow water: Green's law Ks = sqrt(c0 / (2 sqrt(g d)))  (height grows like d^-1/4)
    for (const d of [0.2, 0.5, 1]) expect(shoalingCoefficient(omega, d) / Math.sqrt(G / omega / (2 * Math.sqrt(G * d)))).toBeCloseTo(1, 1);
    expect(shoalingCoefficient(omega, 0.25) / shoalingCoefficient(omega, 1)).toBeCloseTo(Math.pow(4, 0.25), 1);
  });

  it('swell phase solves the eikonal equation: |grad phi| = k(depth), fronts turn towards the beach', () => {
    const res = 129,
      size = 1024,
      cell = size / (res - 1);
    const hf = new Heightfield(res, size);
    // plane beach: 30 m deep at the western edge, shoreline near x = +238 m, land beyond
    for (let iz = 0; iz < res; iz++) for (let ix = 0; ix < res; ix++) hf.data[iz * res + ix] = -30 + (hf.toWorldX(ix) + 512) * 0.04;
    const period = 9,
      omega = (2 * Math.PI) / period;
    const solve = (dir) => {
      const wf = new WaterField(res, size);
      computeWaterField(wf, hf, still({ sea: { enabled: true, level: 0 }, swell: { height: 1, period, dir } }), []);
      return wf;
    };
    const wf = solve(0); // travelling towards +x, normal to the beach
    const s = wf.sres,
      c2 = cell * 2;
    expect(s).toBe(65);
    const errs = [];
    let towardsShore = 0,
      count = 0;
    for (let j = 4; j < s - 4; j++) {
      for (let i = 3; i < s - 3; i++) {
        const depth = -hf.data[j * 2 * res + i * 2];
        if (depth < 1) continue;
        const o = j * s + i;
        const gx = (wf.swellPhase[o + 1] - wf.swellPhase[o - 1]) / (2 * c2),
          gz = (wf.swellPhase[o + s] - wf.swellPhase[o - s]) / (2 * c2);
        const k = waveNumber(omega, Math.max(0.25, depth));
        errs.push(Math.abs(Math.hypot(gx, gz) - k) / k);
        if (gx > 0 && Math.abs(gz) < 0.05 * gx) towardsShore++;
        count++;
      }
    }
    errs.sort((a, b) => a - b);
    expect(count).toBeGreaterThan(1500);
    expect(errs[errs.length >> 1]).toBeLessThan(0.03); // median
    expect(errs[Math.floor(errs.length * 0.9)]).toBeLessThan(0.12);
    expect(towardsShore / count).toBeGreaterThan(0.95); // normal incidence: phase increases shoreward only
    // phase is monotonic along the direction of travel and wavelength shortens towards the beach
    const row = (s >> 1) * s;
    for (let i = 1; i < 40; i++) expect(wf.swellPhase[row + i]).toBeGreaterThan(wf.swellPhase[row + i - 1]);
    const dPhiDeep = wf.swellPhase[row + 6] - wf.swellPhase[row + 5];
    const dPhiShallow = wf.swellPhase[row + 44] - wf.swellPhase[row + 43];
    expect(dPhiShallow).toBeGreaterThan(dPhiDeep * 1.5);
    // swell height factor (un-broken, relative to the offshore height): 1 in deep water, shoaling
    // towards the beach, capped; breaking intensity flags H > 0.78 d; zero on land
    let maxRel = 0,
      breaking = 0;
    for (let i = 0; i < s; i++) {
      const o = row + i;
      const depth = -hf.data[(s >> 1) * 2 * res + i * 2];
      if (depth <= 0) {
        expect(wf.swellH[o]).toBe(0);
        expect(wf.swellBreak[o]).toBe(0);
        continue;
      }
      expect(wf.swellH[o]).toBeCloseTo(Math.min(1.9, shoalingCoefficient(omega, depth)), 2); // normal incidence: no sheltering
      const ratio = wf.swellH[o] / (0.78 * depth); // offshore height 1 m
      if (ratio >= 1) expect(wf.swellBreak[o]).toBe(1);
      if (ratio <= 0.72) expect(wf.swellBreak[o]).toBe(0);
      maxRel = Math.max(maxRel, wf.swellH[o]);
      if (wf.swellBreak[o] > 0.5) breaking++;
    }
    expect(wf.swellH[row + 2]).toBeGreaterThan(0.9);
    expect(wf.swellH[row + 2]).toBeLessThan(1.05); // ~30 m deep: barely shoaled
    expect(maxRel).toBeGreaterThan(1.2); // waves grow before they break
    expect(maxRel).toBeLessThanOrEqual(1.9 + 1e-6);
    expect(breaking).toBeGreaterThan(0);
    expect(wf.swellBreak[row + 2]).toBe(0);
    // oblique swell refracts: the crest-normal angle to the beach normal decreases as depth decreases
    const ob = solve(0.6);
    const angleAt = (i) => {
      const o = (s >> 1) * s + i;
      return Math.atan2((ob.swellPhase[o + s] - ob.swellPhase[o - s]) / 2, (ob.swellPhase[o + 1] - ob.swellPhase[o - 1]) / 2);
    };
    expect(Math.abs(angleAt(8) - 0.6)).toBeLessThan(0.15);
    expect(angleAt(42)).toBeLessThan(angleAt(8) - 0.08);
    expect(angleAt(42)).toBeGreaterThan(0);
  });
});
