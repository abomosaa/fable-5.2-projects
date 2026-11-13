// Editor overlays drawn on top of the scene: path centre-lines and editable nodes, lake /
// settlement markers, the path being drawn, and painted-mask previews.
// Everything is rendered as round screen-space points (constant pixel size).

import * as THREE from 'three';
import { samplePath } from '../core/paths.js';

const VERT = /* glsl */ `
in vec4 aColor; in float aSize;
out vec4 vColor;
void main(){
  vColor = aColor;
  vec4 p = projectionMatrix * viewMatrix * vec4(position, 1.0);
  gl_Position = p;
  gl_PointSize = aSize;
}`;
const FRAG = /* glsl */ `
precision highp float;
in vec4 vColor; out vec4 outColor;
uniform float uGain;
void main(){
  vec2 q = gl_PointCoord * 2.0 - 1.0;
  float r = dot(q, q);
  if (r > 1.0) discard;
  float rim = smoothstep(0.55, 0.8, r);
  vec3 c = mix(vColor.rgb, vec3(0.02), rim * 0.85);
  outColor = vec4(c * uGain, 1.0);
}`;

const COLORS = {
  river: [0.25, 0.7, 1.0],
  road: [1.0, 0.75, 0.3],
  trail: [1.0, 0.55, 0.25],
  node: [1.0, 1.0, 1.0],
  nodeSel: [1.0, 0.35, 0.2],
  lake: [0.3, 0.85, 1.0],
  settlement: [1.0, 0.5, 0.9],
  draft: [0.5, 1.0, 0.5],
};

export class Overlays {
  constructor(app) {
    this.app = app;
    this.max = 60000;
    this.pos = new Float32Array(this.max * 3);
    this.col = new Float32Array(this.max * 4);
    this.size = new Float32Array(this.max);
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(this.pos, 3));
    g.setAttribute('aColor', new THREE.BufferAttribute(this.col, 4));
    g.setAttribute('aSize', new THREE.BufferAttribute(this.size, 1));
    g.setDrawRange(0, 0);
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e9);
    this.mat = new THREE.ShaderMaterial({ glslVersion: THREE.GLSL3, vertexShader: VERT, fragmentShader: FRAG, uniforms: { uGain: { value: 4 } }, depthTest: false, depthWrite: false, transparent: false });
    this.points = new THREE.Points(g, this.mat);
    this.points.frustumCulled = false;
    this.points.layers.set(5);
    app.engine.overlayScene.add(this.points);
    this.handles = []; // {x,y,z,sel,size}
    this.count = 0;
    this.maskTex = null;
  }

  _add(x, y, z, c, size) {
    if (this.count >= this.max) return;
    const i = this.count++;
    this.pos[i * 3] = x;
    this.pos[i * 3 + 1] = y;
    this.pos[i * 3 + 2] = z;
    this.col[i * 4] = c[0];
    this.col[i * 4 + 1] = c[1];
    this.col[i * 4 + 2] = c[2];
    this.col[i * 4 + 3] = 1;
    this.size[i] = size;
  }

  _path(nodes, color, emphasise, sel, pathKind, id) {
    const w = this.app.world;
    if (nodes.length >= 2) {
      const sp = samplePath(nodes, emphasise ? 3 : 7);
      if (sp) for (let k = 0; k < sp.n; k++) this._add(sp.x[k], w.heightAt(sp.x[k], sp.z[k]) + 0.4, sp.z[k], color, emphasise ? 4.5 : 3);
    }
    if (emphasise) {
      nodes.forEach((n, i) => {
        const y = w.heightAt(n.x, n.z) + 0.6;
        const isSel = sel && sel.type === 'node' && sel.id === id && sel.index === i;
        this._add(n.x, y, n.z, isSel ? COLORS.nodeSel : COLORS.node, isSel ? 17 : 13);
        if (id) this.handles.push({ x: n.x, y, z: n.z, sel: { type: 'node', path: pathKind, id, index: i }, size: 16 });
      });
    }
  }

  rebuild() {
    const app = this.app;
    const w = app.world;
    this.count = 0;
    this.handles = [];
    if (!w) return this._commit();
    const tool = app.tools ? app.tools.active : 'select';
    const sel = app.selection;
    const selId = sel && (sel.type === 'node' ? sel.id : sel.id);
    const pathTools = tool === 'river' || tool === 'road' || tool === 'trail';
    const d = w.project;
    for (const r of d.water.rivers) {
      const on = selId === r.id && (sel.type === 'river' || (sel.type === 'node' && sel.path === 'river'));
      if (on || pathTools) this._path(r.nodes, COLORS.river, on, sel, 'river', r.id);
    }
    for (const r of d.roads) {
      const on = selId === r.id && (sel.type === 'road' || (sel.type === 'node' && sel.path === 'road'));
      if (on || pathTools) this._path(r.nodes, r.kind === 'trail' ? COLORS.trail : COLORS.road, on, sel, 'road', r.id);
    }
    if (tool === 'lake' || (sel && (sel.type === 'lake' || sel.type === 'settlement'))) {
      for (const l of d.water.lakes) {
        const on = sel && sel.type === 'lake' && sel.id === l.id;
        this._add(l.x, l.level + 0.3, l.z, on ? COLORS.nodeSel : COLORS.lake, on ? 18 : 12);
        this.handles.push({ x: l.x, y: l.level + 0.3, z: l.z, sel: { type: 'lake', id: l.id }, size: 16 });
      }
      for (const s of d.settlements || []) {
        const on = sel && sel.type === 'settlement' && sel.id === s.id;
        const y = w.heightAt(s.x, s.z) + 2;
        this._add(s.x, y, s.z, on ? COLORS.nodeSel : COLORS.settlement, on ? 18 : 12);
        this.handles.push({ x: s.x, y, z: s.z, sel: { type: 'settlement', id: s.id }, size: 16 });
        if (on) {
          for (let k = 0; k < 96; k++) {
            const a = (k / 96) * Math.PI * 2;
            const x = s.x + Math.cos(a) * s.radius,
              z = s.z + Math.sin(a) * s.radius;
            if (w.hFinal.inBounds(x, z)) this._add(x, w.heightAt(x, z) + 0.5, z, COLORS.settlement, 3.5);
          }
        }
      }
    }
    const draft = app.tools && app.tools.pathDraft;
    if (draft) this._path(draft.nodes, COLORS.draft, true, null, draft.kind, null);
    this._commit();
  }

  /** Live preview while dragging a handle (document is committed on release). */
  previewHandle(sel, hit) {
    const w = this.app.world;
    this._add(hit.x, w.heightAt(hit.x, hit.z) + 0.8, hit.z, COLORS.nodeSel, 18);
    // keep only one preview point
    if (this._previewIndex !== undefined && this._previewIndex < this.count - 1) {
      const i = this._previewIndex;
      this.pos[i * 3] = hit.x;
      this.pos[i * 3 + 1] = w.heightAt(hit.x, hit.z) + 0.8;
      this.pos[i * 3 + 2] = hit.z;
      this.count--;
    } else this._previewIndex = this.count - 1;
    this._commit(true);
    void sel;
  }

  _commit(keepPreview) {
    if (!keepPreview) this._previewIndex = undefined;
    const g = this.points.geometry;
    g.attributes.position.needsUpdate = true;
    g.attributes.aColor.needsUpdate = true;
    g.attributes.aSize.needsUpdate = true;
    g.setDrawRange(0, this.count);
    this.points.visible = this.count > 0;
  }

  update() {
    // points are written into the HDR buffer before tone mapping: compensate for exposure
    const eng = this.app.engine;
    const expo = (eng._expo || eng.baseExposure) * Math.pow(2, eng.exposureEV);
    this.mat.uniforms.uGain.value = 0.85 / Math.max(1e-3, expo);
  }

  /** Screen-space pick of a handle near the pointer. */
  pickHandle(e) {
    const cam = this.app.engine.camera;
    const r = this.app.ui.canvas.getBoundingClientRect();
    const v = new THREE.Vector3();
    let best = null;
    for (const hnd of this.handles) {
      v.set(hnd.x, hnd.y, hnd.z).project(cam);
      if (v.z < -1 || v.z > 1) continue;
      const sx = r.left + (v.x * 0.5 + 0.5) * r.width,
        sy = r.top + (-v.y * 0.5 + 0.5) * r.height;
      const d = Math.hypot(sx - e.clientX, sy - e.clientY);
      if (d < hnd.size * 0.75 && (!best || d < best.d)) best = { d, sel: hnd.sel };
    }
    return best ? best.sel : null;
  }

  /** Show an 8-bit mask as a tinted overlay on the terrain (used for exclusion zones / biome view). */
  showMask(grid, rgb, amount = 0.55) {
    const w = this.app.world;
    const terr = this.app.engine.terrain;
    const res = w.res;
    if (!this.maskTex || this.maskTex.image.width !== res) {
      this.maskData = new Uint8Array(res * res * 4);
      this.maskTex = new THREE.DataTexture(this.maskData, res, res, THREE.RGBAFormat, THREE.UnsignedByteType);
      this.maskTex.minFilter = this.maskTex.magFilter = THREE.LinearFilter;
    }
    const d = this.maskData;
    const palette = Array.isArray(rgb[0]) ? rgb : null;
    for (let i = 0; i < res * res; i++) {
      const v = grid[i];
      const o = i * 4;
      if (palette) {
        const c = palette[v] || [0, 0, 0];
        d[o] = c[0] * 255;
        d[o + 1] = c[1] * 255;
        d[o + 2] = c[2] * 255;
        d[o + 3] = v ? 255 : 0;
      } else {
        d[o] = rgb[0] * 255;
        d[o + 1] = rgb[1] * 255;
        d[o + 2] = rgb[2] * 255;
        d[o + 3] = v;
      }
    }
    this.maskTex.needsUpdate = true;
    terr.matUniforms.uOverlay.value = this.maskTex;
    terr.matUniforms.uOverlayAmt.value = amount;
  }
  hideMask() {
    this.app.engine.terrain.matUniforms.uOverlayAmt.value = 0;
  }
}
