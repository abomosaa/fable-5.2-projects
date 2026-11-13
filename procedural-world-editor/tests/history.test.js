// Undo / redo: transactions, grid edits, document edits, coalescing, memory bound.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { History, gridsCommand, extractRect, docCommand } from '../src/editor/history.js';
import { generateTerrain, defaultTerrainParams } from '../src/core/terrainGen.js';
import { createProjectDoc } from '../src/core/project.js';
import { World } from '../src/core/world.js';
import { applySculpt } from '../src/core/brushes.js';

const manifest = JSON.parse(readFileSync(new URL('../public/assets/manifest.json', import.meta.url), 'utf8'));

function hash(arr) {
  let h = 2166136261 >>> 0;
  const u8 = new Uint8Array(arr.buffer, arr.byteOffset, arr.byteLength);
  for (let i = 0; i < u8.length; i += 1) h = Math.imul(h ^ u8[i], 16777619) >>> 0;
  return h;
}
function scatterHash(world) {
  let h = 0;
  for (const [k, c] of [...world.scatterCells].sort((a, b) => (a[0] < b[0] ? -1 : 1))) for (const [lk, l] of [...c.layers].sort((a, b) => (a[0] < b[0] ? -1 : 1))) h = (Math.imul(h, 31) + hash(l.data) + lk.length + k.length) >>> 0;
  return h;
}

function makeWorld() {
  const res = 257;
  const gen = generateTerrain({ ...defaultTerrainParams('alpine', 11), res, coarseRes: 257 });
  const { doc } = createProjectDoc({ name: 't', preset: 'alpine', seed: 11, manifest, terrain: { res } });
  doc.water.rivers.push({ id: 'r1', name: 'R', nodes: gen.suggested.rivers[0].map((p) => ({ x: p.x, z: p.z })), width: 24, depth: 1.2, flow: 9 });
  const world = new World(doc, gen, manifest);
  world.deriveAll();
  return world;
}

describe('History', () => {
  it('undoes and redoes simple commands in order', () => {
    const h = new History();
    const log = [];
    let v = 0;
    const set = (to) => {
      const from = v;
      v = to;
      h.push({ label: 'set ' + to, undo: () => { v = from; log.push('u' + to); }, redo: () => { v = to; log.push('r' + to); } });
    };
    set(1);
    set(2);
    set(3);
    expect(h.dirty).toBe(true);
    expect(h.undo()).toBe('set 3');
    expect(v).toBe(2);
    h.undo();
    expect(v).toBe(1);
    h.redo();
    expect(v).toBe(2);
    set(9); // new edit clears the redo stack
    expect(h.canRedo).toBe(false);
    h.undo();
    expect(v).toBe(2);
    expect(log).toEqual(['u3', 'u2', 'r2', 'u9']);
  });

  it('groups a transaction into one step and rolls back', () => {
    const h = new History();
    const a = [];
    h.begin('tx');
    for (let i = 0; i < 3; i++) {
      a.push(i);
      h.push({ label: 'p', undo: () => a.pop(), redo: () => a.push(i) });
    }
    h.commit();
    expect(h.undoStack.length).toBe(1);
    h.undo();
    expect(a).toEqual([]);
    h.redo();
    expect(a).toEqual([0, 1, 2]);
    h.begin('tx2');
    a.push(7);
    h.push({ label: 'p', undo: () => a.pop(), redo: () => a.push(7) });
    h.rollback();
    expect(a).toEqual([0, 1, 2]);
    expect(h.undoStack.length).toBe(1);
  });

  it('coalesces rapid edits with the same merge key', () => {
    const h = new History();
    const doc = { v: 0 };
    let t = 0;
    for (let i = 1; i <= 5; i++) {
      const before = JSON.stringify(doc);
      doc.v = i;
      const c = docCommand('slide', doc, before, JSON.stringify(doc), () => {}, 'k');
      c.time = t += 100;
      h.push(c);
    }
    expect(h.undoStack.length).toBe(1);
    h.undo();
    expect(doc.v).toBe(0);
    h.redo();
    expect(doc.v).toBe(5);
  });

  it('bounds memory by dropping the oldest entries', () => {
    const h = new History(1000);
    for (let i = 0; i < 20; i++) h.push({ label: 'x' + i, bytes: 200, undo() {}, redo() {} });
    expect(h.undoStack.length).toBeLessThanOrEqual(5);
    expect(h.undoStack[h.undoStack.length - 1].label).toBe('x19');
  });

  it('tracks saved state', () => {
    const h = new History();
    h.push({ label: 'a', undo() {}, redo() {} });
    h.markSaved();
    expect(h.dirty).toBe(false);
    h.undo();
    expect(h.dirty).toBe(true);
  });
});

describe('World edits through history', () => {
  const world = makeWorld();
  const h = new History();
  const base = { hUser: hash(world.hUser.data), hFinal: hash(world.hFinal.data), surf: hash(world.water.surf), weights: hash(world.weights), scatter: scatterHash(world), doc: JSON.stringify(world.project) };
  const state = () => ({ hUser: hash(world.hUser.data), hFinal: hash(world.hFinal.data), surf: hash(world.water.surf), weights: hash(world.weights), scatter: scatterHash(world), doc: JSON.stringify(world.project) });

  it('a sculpt stroke is undoable and redoable bit-exactly, including derived data', () => {
    const before = new Float32Array(world.hUser.data);
    let rect = null;
    for (let i = 0; i < 20; i++) {
      const r = applySculpt(world.hUser, 'raise', 300 + i * 6, -200, { radius: 60, strength: 0.8, dt: 1 / 30, state: {} });
      rect = rect ? { x0: Math.min(rect.x0, r.x0), z0: Math.min(rect.z0, r.z0), x1: Math.max(rect.x1, r.x1), z1: Math.max(rect.z1, r.z1) } : r;
    }
    const apply = (rc) => world.deriveRect(rc);
    h.push(gridsCommand('Raise', world.res, rect, [{ grid: world.hUser.data, before: extractRect(before, world.res, rect), after: extractRect(world.hUser.data, world.res, rect) }], apply));
    apply(rect);
    const after = state();
    expect(after.hUser).not.toBe(base.hUser);
    expect(after.hFinal).not.toBe(base.hFinal);
    h.undo();
    const u = state();
    for (const k of Object.keys(base)) expect([k, u[k]]).toEqual([k, base[k]]);
    h.redo();
    expect(state()).toEqual(after);
    h.undo();
    expect(state()).toEqual(base);
  });

  it('moving a river node is undoable: channel, water and scatter return exactly', () => {
    const doc = world.project;
    const beforeJ = JSON.stringify(doc);
    const mid = Math.floor(doc.water.rivers[0].nodes.length / 2);
    doc.water.rivers[0].nodes[mid].x += 120;
    doc.water.rivers[0].nodes[mid].z += 60;
    const apply = () => world.deriveRect({ x0: 0, z0: 0, x1: 0, z1: 0 }, { forceWater: true });
    apply();
    h.push(docCommand('Move river point', doc, beforeJ, JSON.stringify(doc), apply));
    const after = state();
    expect(after.hFinal).not.toBe(base.hFinal);
    expect(after.surf).not.toBe(base.surf);
    expect(after.hUser).toBe(base.hUser); // modifiers never touch the user surface
    h.undo();
    expect(state()).toEqual(base);
    h.redo();
    expect(state()).toEqual(after);
    h.undo();
  });

  it('a biome rule change regenerates scatter and is undoable', () => {
    const doc = world.project;
    const beforeJ = JSON.stringify(doc);
    const layer = doc.biomes.find((b) => b.id === 'conifer_forest').layers.find((l) => l.id === 'trees');
    layer.density = 0.2;
    const apply = () => {
      world.invalidateLayerList();
      world.deriveGround();
    };
    apply();
    h.push(docCommand('Tree density', doc, beforeJ, JSON.stringify(doc), apply));
    const after = state();
    expect(after.scatter).not.toBe(base.scatter);
    expect(after.hFinal).toBe(base.hFinal);
    h.undo();
    expect(state()).toEqual(base);
    h.redo();
    expect(state().scatter).toBe(after.scatter);
    h.undo();
  });

  it('painted exclusion zones survive regeneration and remove scatter inside them', () => {
    const N = world.res * world.res;
    const count = (pred) => {
      let n = 0;
      for (const c of world.scatterCells.values()) for (const l of c.layers.values()) for (let i = 0; i < l.count; i++) if (pred(l.data[i * 8], l.data[i * 8 + 2])) n++;
      return n;
    };
    // find a populated disc
    let cx = 0, cz = 0, best = 0;
    for (const c of world.scatterCells.values()) {
      let n = 0;
      for (const l of c.layers.values()) n += l.count;
      if (n > best) { best = n; const b = world.cellBounds(c.cx, c.cz); cx = (b[0] + b[2]) / 2; cz = (b[1] + b[3]) / 2; }
    }
    const inside = (x, z) => Math.hypot(x - cx, z - cz) < 20;
    expect(count(inside)).toBeGreaterThan(0);
    const rc = world.hUser.rectFromWorld(cx - 50, cz - 50, cx + 50, cz + 50);
    for (let iz = rc.z0; iz <= rc.z1; iz++) for (let ix = rc.x0; ix <= rc.x1; ix++) if (Math.hypot(world.hUser.toWorldX(ix) - cx, world.hUser.toWorldZ(iz) - cz) < 30) world.paint.exclude[iz * world.res + ix] = 255;
    world.deriveGround(rc);
    expect(count(inside)).toBe(0);
    world.deriveAll(); // full regeneration keeps the manual exclusion
    expect(count(inside)).toBe(0);
    world.paint.exclude.fill(0);
    world.deriveAll();
    expect(count(inside)).toBeGreaterThan(0);
    void N;
  });
});
