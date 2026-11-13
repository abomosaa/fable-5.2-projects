// Chunked level-of-detail terrain: a quadtree over the whole island. Chunks are meshed in web
// workers from the shared height function; the tree is refined around the camera every frame.

import * as THREE from 'three';
import { WORLD_HALF } from './heightfield.js';
import { withAtmosphere, atmoUniforms } from '../gfx/atmosphere.js';

const NONE = 0, REQUESTED = 1, READY = 2;

class Node {
  constructor(x0, z0, size, level, parent) {
    this.x0 = x0; this.z0 = z0; this.size = size; this.level = level; this.parent = parent;
    this.children = null; this.mesh = null; this.state = NONE;
    this.minY = -50; this.maxY = parent ? parent.maxY : 2600;
    this.lastVisit = 0; this.lastSplit = 0; this.dist = 0;
  }
}

function makeDetailTexture() {
  // tileable three-channel value noise (each channel a different fractal)
  const S = 256;
  const data = new Uint8Array(S * S * 4);
  const lattice = (seed, n) => {
    let s = seed; const a = new Float32Array(n * n);
    for (let i = 0; i < n * n; i++) { s = (Math.imul(s, 1664525) + 1013904223) | 0; a[i] = (s >>> 8) / 16777216; }
    return a;
  };
  const sample = (lat, n, x, y) => {
    const xi = Math.floor(x), yi = Math.floor(y), fx = x - xi, fy = y - yi;
    const u = fx * fx * (3 - 2 * fx), v = fy * fy * (3 - 2 * fy);
    const i0 = ((xi % n) + n) % n, i1 = (i0 + 1) % n, j0 = ((yi % n) + n) % n, j1 = (j0 + 1) % n;
    return (lat[j0 * n + i0] * (1 - u) + lat[j0 * n + i1] * u) * (1 - v) + (lat[j1 * n + i0] * (1 - u) + lat[j1 * n + i1] * u) * v;
  };
  for (let c = 0; c < 3; c++) {
    const octs = [8, 16, 32, 64, 128].map((n, i) => ({ n, lat: lattice(1234 + c * 977 + i * 31, n), amp: [0.34, 0.26, 0.18, 0.13, 0.09][i] }));
    for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
      let v = 0;
      for (const o of octs) v += o.amp * sample(o.lat, o.n, x * o.n / S, y * o.n / S);
      data[(y * S + x) * 4 + c] = Math.max(0, Math.min(255, (v - 0.5) * 1.9 * 255 + 128));
    }
  }
  for (let i = 3; i < data.length; i += 4) data[i] = 255;
  const tex = new THREE.DataTexture(data, S, S, THREE.RGBAFormat);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.magFilter = THREE.LinearFilter; tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.generateMipmaps = true; tex.anisotropy = 8; tex.needsUpdate = true;
  return tex;
}

function makeTerrainMaterial(detail) {
  const mat = new THREE.MeshLambertMaterial({ color: 0xffffff });
  withAtmosphere(mat, (shader) => {
    shader.uniforms.uDetail = { value: detail };
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>
        attribute vec4 aColor; attribute vec2 aGrid; attribute vec4 aBio;
        varying vec3 vTerrainColor; varying vec2 vGrid; varying vec4 vBio; varying vec3 vWPos;`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>
        vTerrainColor = aColor.rgb * aColor.rgb; vGrid = aGrid; vBio = aBio;
        vWPos = (modelMatrix * vec4(transformed, 1.0)).xyz;`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
        uniform sampler2D uDetail;
        uniform sampler2D uCloudShadowMap; uniform vec4 uCloudShadowParams;
        varying vec3 vTerrainColor; varying vec2 vGrid; varying vec4 vBio; varying vec3 vWPos;
        float tHash(vec2 p) { p = fract(p * vec2(0.1031, 0.1030)); p += dot(p, p.yx + 33.33); return fract((p.x + p.y) * p.x); }
        vec3 fieldColor(float r) {
          if (r < 0.22) return vec3(0.10, 0.21, 0.045);
          if (r < 0.42) return vec3(0.17, 0.25, 0.06);
          if (r < 0.58) return vec3(0.36, 0.31, 0.10);
          if (r < 0.72) return vec3(0.25, 0.17, 0.09);
          if (r < 0.86) return vec3(0.42, 0.38, 0.15);
          return vec3(0.21, 0.29, 0.08);
        }`)
      .replace('#include <color_fragment>', `#include <color_fragment>
        {
          vec3 tc = vTerrainColor;
          float tDist = length(cameraPosition - vWPos);
          float farm = vBio.x;
          if (farm > 0.02) {
            // patchwork of fields: two differently oriented layouts picked by a coarse mask
            vec2 p = vWPos.xz;
            float sel = step(0.5, tHash(floor(p / 2300.0)));
            vec2 q = mix(mat2(0.86, -0.5, 0.5, 0.86) * p, mat2(0.5, 0.86, -0.86, 0.5) * p, sel);
            vec2 cs = mix(vec2(250.0, 160.0), vec2(180.0, 300.0), sel);
            vec2 id = floor(q / cs);
            vec2 f = fract(q / cs);
            float rnd = tHash(id + sel * 17.0);
            vec3 fc = fieldColor(rnd) * (0.85 + 0.3 * tHash(id + 5.5));
            float edge = min(min(f.x, 1.0 - f.x) * cs.x, min(f.y, 1.0 - f.y) * cs.y);
            float aa = max(fwidth(q.x), fwidth(q.y)) * 1.5;
            fc = mix(vec3(0.06, 0.1, 0.035), fc, smoothstep(2.5, 5.0 + aa, edge) * 0.999 + 0.001);
            float fur = sin((rnd > 0.5 ? q.x : q.y) * 1.6) * 0.5 + 0.5;
            fc *= mix(1.0, 0.86 + 0.28 * fur, 1.0 - smoothstep(60.0, 420.0, tDist));
            tc = mix(tc, fc, smoothstep(0.02, 0.6, farm));
          }
          float d1 = texture2D(uDetail, vGrid * 0.25).r;
          float d2 = texture2D(uDetail, vGrid * 0.03125).g;
          float d3 = texture2D(uDetail, vGrid * 0.001953125).b;
          float w1 = 1.0 - smoothstep(15.0, 200.0, tDist);
          float w2 = 1.0 - smoothstep(250.0, 2500.0, tDist);
          tc *= 1.0 + (d1 - 0.5) * 0.75 * w1 + (d2 - 0.5) * 0.7 * w2 + (d3 - 0.5) * 0.45;
          // cloud shadows drifting over the land
          vec2 cuv = (vWPos.xz + uCloudShadowParams.xy) * uCloudShadowParams.z;
          float cs2 = texture2D(uCloudShadowMap, cuv).r * uCloudShadowParams.w;
          tc *= 1.0 - 0.5 * cs2;
          diffuseColor.rgb *= tc;
        }`);
  }, 'terrain');
  return mat;
}

function makeTreeAssets() {
  // conifer: two stacked cones on a trunk
  const parts = [];
  const paint = (g, r, gr, b, shadeBottom = 0.55) => {
    const p = g.attributes.position; const c = new Float32Array(p.count * 3);
    let y0 = Infinity, y1 = -Infinity;
    for (let i = 0; i < p.count; i++) { y0 = Math.min(y0, p.getY(i)); y1 = Math.max(y1, p.getY(i)); }
    for (let i = 0; i < p.count; i++) {
      const t = (p.getY(i) - y0) / Math.max(1e-6, y1 - y0); const s = shadeBottom + (1 - shadeBottom) * t;
      c[i * 3] = r * s; c[i * 3 + 1] = gr * s; c[i * 3 + 2] = b * s;
    }
    g.setAttribute('color', new THREE.BufferAttribute(c, 3));
    return g;
  };
  const merge = (list) => {
    let nv = 0, ni = 0;
    for (const g of list) { nv += g.attributes.position.count; ni += g.index.count; }
    const pos = new Float32Array(nv * 3), nor = new Float32Array(nv * 3), col = new Float32Array(nv * 3), idx = new Uint16Array(ni);
    let vo = 0, io = 0;
    for (const g of list) {
      pos.set(g.attributes.position.array, vo * 3); nor.set(g.attributes.normal.array, vo * 3); col.set(g.attributes.color.array, vo * 3);
      for (let i = 0; i < g.index.count; i++) idx[io + i] = g.index.array[i] + vo;
      vo += g.attributes.position.count; io += g.index.count;
    }
    const out = new THREE.BufferGeometry();
    out.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    out.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
    out.setAttribute('color', new THREE.BufferAttribute(col, 3));
    out.setIndex(new THREE.BufferAttribute(idx, 1));
    return out;
  };
  const cone1 = paint(new THREE.ConeGeometry(3.4, 9, 6, 1, true).translate(0, 6.5, 0), 0.05, 0.12, 0.045);
  const cone2 = paint(new THREE.ConeGeometry(2.4, 7, 6, 1, true).translate(0, 11.5, 0), 0.06, 0.14, 0.05, 0.7);
  const trunk1 = paint(new THREE.CylinderGeometry(0.35, 0.45, 3, 5, 1, true).translate(0, 1.5, 0), 0.12, 0.085, 0.05, 0.9);
  const conifer = merge([cone1, cone2, trunk1]);
  // broadleaf: an irregular low-poly crown
  const crown = new THREE.IcosahedronGeometry(1, 0);
  {
    const p = crown.attributes.position;
    for (let i = 0; i < p.count; i++) {
      const x = p.getX(i), y = p.getY(i), z = p.getZ(i);
      const k = 0.85 + 0.3 * Math.abs((Math.sin(x * 12.9898 + y * 78.233 + z * 37.719) * 43758.5453) % 1);
      p.setXYZ(i, x * k * 4.4, y * k * 3.5 + 5.6, z * k * 4.4);
    }
  }
  const crownI = crown;
  {
    const n = crown.attributes.position.count; const a = new Uint16Array(n);
    for (let i = 0; i < n; i++) a[i] = i;
    crown.setIndex(new THREE.BufferAttribute(a, 1));
    const p = crownI.attributes.position, nrm = new Float32Array(p.count * 3);
    for (let i = 0; i < p.count; i++) {
      const nx = p.getX(i) / (4.4 * 4.4), ny = (p.getY(i) - 5.2) / (3.5 * 3.5), nz = p.getZ(i) / (4.4 * 4.4);
      const l = Math.hypot(nx, ny, nz) || 1;
      nrm[i * 3] = nx / l; nrm[i * 3 + 1] = ny / l; nrm[i * 3 + 2] = nz / l;
    }
    crownI.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
  }
  paint(crownI, 0.062, 0.125, 0.034, 0.42);
  const trunk2 = paint(new THREE.CylinderGeometry(0.32, 0.5, 3.4, 5, 1, true).translate(0, 1.7, 0), 0.11, 0.08, 0.05, 0.9);
  const broadleaf = merge([crownI, trunk2]);
  const mat = withAtmosphere(new THREE.MeshLambertMaterial({ vertexColors: true }));
  return { conifer, broadleaf, mat };
}

export class Terrain {
  /**
   * @param opts {res, maxLevel, splitK, trees, treeSpacing, workers}
   */
  constructor(scene, opts = {}) {
    this.scene = scene;
    this.res = opts.res ?? 64;
    this.maxLevel = opts.maxLevel ?? 8;
    this.splitK = opts.splitK ?? 2.3;
    this.trees = opts.trees ?? true;
    this.treeSpacing = opts.treeSpacing ?? 15;
    this.group = new THREE.Group();
    this.group.name = 'terrain';
    scene.add(this.group);
    this.root = new Node(-WORLD_HALF, -WORLD_HALF, WORLD_HALF * 2, 0, null);
    this.detail = makeDetailTexture();
    this.material = makeTerrainMaterial(this.detail);
    this.treeAssets = makeTreeAssets();
    this.index = this.makeIndex(this.res);
    this.frame = 0;
    this.nextId = 1;
    this.pending = new Map();        // id -> node
    this.queue = [];
    this.inFlight = 0;
    this.chunkCount = 0;
    this.treeCount = 0;
    const nw = opts.workers ?? Math.max(2, Math.min(6, (navigator.hardwareConcurrency || 4) - 2));
    this.workers = [];
    for (let i = 0; i < nw; i++) {
      const w = new Worker(new URL('./terrainWorker.js', import.meta.url), { type: 'module' });
      w.busy = false;
      w.onmessage = (e) => this.onChunk(w, e.data);
      w.onerror = (e) => console.error('terrain worker error', e.message);
      this.workers.push(w);
    }
    this.overviewCallbacks = new Map();
    this._cam = new THREE.Vector3();
    this._m = new THREE.Matrix4(); this._q = new THREE.Quaternion(); this._s = new THREE.Vector3(); this._p = new THREE.Vector3();
    this._c = new THREE.Color();
  }

  makeIndex(res) {
    const n = res + 1;
    const quads = res * res + 4 * res;
    const idx = new Uint32Array(quads * 6);
    let k = 0;
    for (let i = 0; i < res; i++) for (let j = 0; j < res; j++) {
      const a = i * n + j, b = a + 1, c = a + n, d = c + 1;      // a(i,j) b(i,j+1) c(i+1,j) d(i+1,j+1)
      idx[k++] = a; idx[k++] = b; idx[k++] = d;
      idx[k++] = a; idx[k++] = d; idx[k++] = c;
    }
    const s0 = n * n;
    // skirt strips; winding chosen so that the faces look outward
    for (let j = 0; j < res; j++) {           // edge i = 0 (faces -X)
      const a = j, b = j + 1, sa = s0 + j, sb = s0 + j + 1;
      idx[k++] = a; idx[k++] = sa; idx[k++] = sb; idx[k++] = a; idx[k++] = sb; idx[k++] = b;
    }
    for (let j = 0; j < res; j++) {           // edge i = n-1 (faces +X)
      const a = (n - 1) * n + j, b = a + 1, sa = s0 + n + j, sb = sa + 1;
      idx[k++] = a; idx[k++] = sb; idx[k++] = sa; idx[k++] = a; idx[k++] = b; idx[k++] = sb;
    }
    for (let i = 0; i < res; i++) {           // edge j = 0 (faces -Z)
      const a = i * n, b = a + n, sa = s0 + 2 * n + i, sb = sa + 1;
      idx[k++] = a; idx[k++] = sb; idx[k++] = sa; idx[k++] = a; idx[k++] = b; idx[k++] = sb;
    }
    for (let i = 0; i < res; i++) {           // edge j = n-1 (faces +Z)
      const a = i * n + n - 1, b = a + n, sa = s0 + 3 * n + i, sb = sa + 1;
      idx[k++] = a; idx[k++] = sa; idx[k++] = sb; idx[k++] = a; idx[k++] = sb; idx[k++] = b;
    }
    return new THREE.BufferAttribute(idx, 1);
  }

  requestOverview(size, half) {
    return new Promise((resolve) => {
      const id = this.nextId++;
      this.overviewCallbacks.set(id, resolve);
      const w = this.workers[this.workers.length - 1];
      w.postMessage({ type: 'overview', id, size, half });
    });
  }

  request(node) {
    if (node.state !== NONE) return;
    node.state = REQUESTED;
    this.queue.push(node);
  }

  pump() {
    if (!this.queue.length) return;
    // nearest first; drop requests that are no longer wanted
    this.queue.sort((a, b) => b.dist - a.dist);
    for (const w of this.workers) {
      if (w.busy) continue;
      let node = null;
      while (this.queue.length) {
        const cand = this.queue.pop();
        if (cand.lastVisit >= this.frame - 2 || cand.level <= 1) { node = cand; break; }
        cand.state = NONE;
      }
      if (!node) break;
      const id = this.nextId++;
      this.pending.set(id, node);
      w.busy = true;
      this.inFlight++;
      w.postMessage({
        id, x0: node.x0, z0: node.z0, size: node.size, res: this.res, level: node.level, maxLevel: this.maxLevel,
        trees: this.trees, treeSpacing: this.treeSpacing,
      });
    }
  }

  onChunk(worker, data) {
    if (data.overview) {
      const cb = this.overviewCallbacks.get(data.id);
      this.overviewCallbacks.delete(data.id);
      if (cb) cb(data);
      return;
    }
    worker.busy = false;
    this.inFlight--;
    const node = this.pending.get(data.id);
    this.pending.delete(data.id);
    if (!node || node.state !== REQUESTED) return;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(data.pos, 3));
    g.setAttribute('normal', new THREE.BufferAttribute(data.nor, 4, true));
    g.setAttribute('aColor', new THREE.BufferAttribute(data.col, 4, true));
    g.setAttribute('aGrid', new THREE.BufferAttribute(data.grid, 2));
    g.setAttribute('aBio', new THREE.BufferAttribute(data.bio, 4, true));
    g.setIndex(this.index);
    const half = node.size / 2;
    const cy = (data.minY + data.maxY) / 2, hy = (data.maxY - data.minY) / 2 + node.size * 0.04 + 4;
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, cy, 0), Math.hypot(half, half, hy));
    g.boundingBox = new THREE.Box3(new THREE.Vector3(-half, data.minY - 10, -half), new THREE.Vector3(half, data.maxY + 10, half));
    const mesh = new THREE.Mesh(g, this.material);
    mesh.position.set(node.x0 + half, 0, node.z0 + half);
    mesh.matrixAutoUpdate = false;
    mesh.updateMatrix();
    mesh.receiveShadow = true;
    mesh.visible = false;
    node.minY = data.minY; node.maxY = data.maxY;
    if (data.trees && data.trees.length) this.addTrees(mesh, data.trees, node);
    this.group.add(mesh);
    mesh.updateMatrixWorld(true);
    node.mesh = mesh;
    node.state = READY;
    this.chunkCount++;
  }

  addTrees(mesh, buf, node) {
    const n = buf.length / 6;
    let nc = 0;
    for (let i = 0; i < n; i++) if (buf[i * 6 + 4] > 0.5) nc++;
    const make = (geom, count) => {
      if (!count) return null;
      const im = new THREE.InstancedMesh(geom, this.treeAssets.mat, count);
      im.matrixAutoUpdate = false;
      im.frustumCulled = true;
      return im;
    };
    const con = make(this.treeAssets.conifer, nc), bro = make(this.treeAssets.broadleaf, n - nc);
    let ic = 0, ib = 0;
    const m = this._m, q = this._q, s = this._s, p = this._p, c = this._c, up = new THREE.Vector3(0, 1, 0);
    for (let i = 0; i < n; i++) {
      const o = i * 6, sc = buf[o + 3], rnd = buf[o + 5];
      p.set(buf[o], buf[o + 1], buf[o + 2]);
      q.setFromAxisAngle(up, rnd * 6.283);
      const isCon = buf[o + 4] > 0.5;
      s.set(sc * (0.85 + 0.3 * rnd), sc * (isCon ? 1.0 + 0.5 * rnd : 0.9 + 0.5 * rnd), sc * (0.85 + 0.3 * rnd));
      m.compose(p, q, s);
      const tint = 0.75 + 0.5 * ((rnd * 7.13) % 1);
      c.setRGB(tint, tint * (0.92 + 0.16 * rnd), tint * 0.9);
      if (isCon) { con.setMatrixAt(ic, m); con.setColorAt(ic++, c); }
      else { bro.setMatrixAt(ib, m); bro.setColorAt(ib++, c); }
    }
    const half = node.size / 2;
    for (const im of [con, bro]) {
      if (!im) continue;
      im.instanceMatrix.needsUpdate = true;
      if (im.instanceColor) im.instanceColor.needsUpdate = true;
      im.geometry.boundingSphere || im.geometry.computeBoundingSphere();
      im.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, (node.minY + node.maxY) / 2 + 8, 0), Math.hypot(half, half, (node.maxY - node.minY) / 2 + 30));
      mesh.add(im);
      this.treeCount += im.count;
    }
  }

  distanceTo(node, cam) {
    const dx = Math.max(node.x0 - cam.x, 0, cam.x - (node.x0 + node.size));
    const dz = Math.max(node.z0 - cam.z, 0, cam.z - (node.z0 + node.size));
    const dy = Math.max(node.minY - cam.y, 0, cam.y - node.maxY);
    return Math.sqrt(dx * dx + dy * dy + dz * dz);
  }

  hideSubtree(node) {
    if (node.mesh) node.mesh.visible = false;
    if (node.children) for (const c of node.children) this.hideSubtree(c);
  }

  disposeSubtree(node) {
    if (node.children) { for (const c of node.children) this.disposeSubtree(c); node.children = null; }
    if (node.mesh) {
      for (const ch of node.mesh.children) { this.treeCount -= ch.count; ch.dispose(); }
      this.group.remove(node.mesh);
      node.mesh.geometry.dispose();
      node.mesh = null;
      this.chunkCount--;
    }
    node.state = NONE;
  }

  visit(node) {
    const cam = this._cam;
    node.lastVisit = this.frame;
    const d = this.distanceTo(node, cam);
    node.dist = d;
    if (node.state !== READY) { this.request(node); return false; }
    const wantSplit = node.level < this.maxLevel && d < node.size * this.splitK;
    if (wantSplit) {
      node.lastSplit = this.frame;
      if (!node.children) {
        const h = node.size / 2, l = node.level + 1;
        node.children = [
          new Node(node.x0, node.z0, h, l, node), new Node(node.x0 + h, node.z0, h, l, node),
          new Node(node.x0, node.z0 + h, h, l, node), new Node(node.x0 + h, node.z0 + h, h, l, node),
        ];
      }
      let ready = true;
      for (const c of node.children) {
        if (c.state !== READY) { ready = false; c.lastVisit = this.frame; c.dist = this.distanceTo(c, cam); this.request(c); }
      }
      if (ready) {
        node.mesh.visible = false;
        for (const c of node.children) this.visit(c);
        return true;
      }
      // children still loading: keep showing this node, but hide any stale grandchildren
      for (const c of node.children) this.hideSubtree(c);
    } else if (node.children) {
      for (const c of node.children) this.hideSubtree(c);
    }
    node.mesh.visible = true;
    return true;
  }

  sweep(node) {
    if (!node.children) return;
    if (node.lastSplit < this.frame - 600) {
      for (const c of node.children) this.disposeSubtree(c);
      node.children = null;
      return;
    }
    for (const c of node.children) this.sweep(c);
  }

  update(camPos) {
    this.frame++;
    this._cam.copy(camPos);
    this.visit(this.root);
    this.pump();
    if (this.frame % 120 === 0) this.sweep(this.root);
  }

  /** True when nothing is being generated (used by the loading screen). */
  get idle() { return this.inFlight === 0 && this.queue.length === 0; }

  /** Refine around a position until the tree is stable. */
  async preload(pos, onProgress) {
    let stable = 0, guard = 0;
    while (stable < 3 && guard++ < 2000) {
      this.update(pos);
      if (this.idle) stable++; else stable = 0;
      if (onProgress) onProgress(this.chunkCount);
      await new Promise((r) => setTimeout(r, 8));
    }
  }

  dispose() {
    for (const w of this.workers) w.terminate();
    this.disposeSubtree(this.root);
    this.scene.remove(this.group);
  }
}
