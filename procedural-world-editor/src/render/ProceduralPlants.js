// Procedural emergent plants (common reed, cattail) built as real blade geometry.
// No redistributable scanned reed asset was available in the CC0 library, so these are generated;
// see docs/ARCHITECTURE.md ("Procedural plants").

import * as THREE from 'three';
import { mulberry32 } from '../core/noise.js';

function plantTexture() {
  // columns: 0..0.5 leaf / stem gradient (v: base -> tip), 0.5..0.75 plume, 0.75..1 cattail head
  const W = 64,
    H = 256;
  const data = new Uint8Array(W * H * 4);
  const rnd = mulberry32(99);
  for (let y = 0; y < H; y++) {
    const v = y / (H - 1);
    for (let x = 0; x < W; x++) {
      const u = x / (W - 1);
      let r, g, b;
      const streak = 0.9 + 0.2 * Math.sin(x * 2.1) * 0.5 + (rnd() - 0.5) * 0.08;
      if (u < 0.5) {
        // leaf: darker base, brighter mid, yellowing tip; a pale midrib
        const mid = 1 - Math.abs((u / 0.5) * 2 - 1);
        const k = v < 0.15 ? 0.6 + v * 2 : v > 0.82 ? 1 + (v - 0.82) * 1.6 : 1;
        r = (58 + 50 * v + (v > 0.8 ? 90 * (v - 0.8) / 0.2 : 0)) * streak * k * 0.9;
        g = (92 + 26 * v + (v > 0.8 ? 30 * (v - 0.8) / 0.2 : 0)) * streak * (0.92 + 0.12 * mid);
        b = (38 + 12 * v) * streak;
      } else if (u < 0.75) {
        // reed plume: tan / purplish brown, feathery noise
        const n = 0.75 + rnd() * 0.5;
        r = 150 * n;
        g = 118 * n;
        b = 92 * n;
      } else {
        // cattail head: dark brown velvet
        const n = 0.85 + rnd() * 0.3;
        r = 74 * n;
        g = 46 * n;
        b = 28 * n;
      }
      const o = (y * W + x) * 4;
      data[o] = Math.min(255, r);
      data[o + 1] = Math.min(255, g);
      data[o + 2] = Math.min(255, b);
      data[o + 3] = 255;
    }
  }
  const t = new THREE.DataTexture(data, W, H, THREE.RGBAFormat, THREE.UnsignedByteType);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.magFilter = THREE.LinearFilter;
  t.generateMipmaps = true;
  t.needsUpdate = true;
  return t;
}

let sharedTex = null;

function buildClump(kind, stems, leafCount, seed, segs) {
  const rnd = mulberry32(seed);
  const pos = [],
    nor = [],
    uv = [],
    idx = [];
  let maxH = 0,
    maxR = 0;
  // ribbon along a curve: points p(t), width w(t), facing normal fn
  const ribbon = (curve, widthFn, facing, u0, u1, n) => {
    const base = pos.length / 3;
    for (let i = 0; i <= n; i++) {
      const t = i / n;
      const p = curve(t);
      const p2 = curve(Math.min(1, t + 0.02));
      const tan = new THREE.Vector3(p2.x - p.x, p2.y - p.y, p2.z - p.z).normalize();
      const side = new THREE.Vector3().crossVectors(tan, facing).normalize();
      const nrm = new THREE.Vector3().crossVectors(side, tan).normalize();
      const w = widthFn(t) * 0.5;
      pos.push(p.x - side.x * w, p.y - side.y * w, p.z - side.z * w, p.x + side.x * w, p.y + side.y * w, p.z + side.z * w);
      // normals biased upward so thin blades shade like a soft volume
      const nx = nrm.x * 0.6,
        ny = nrm.y * 0.6 + 0.5,
        nz = nrm.z * 0.6;
      const l = Math.hypot(nx, ny, nz);
      nor.push(nx / l, ny / l, nz / l, nx / l, ny / l, nz / l);
      uv.push(u0, t, u1, t);
      maxH = Math.max(maxH, p.y);
      maxR = Math.max(maxR, Math.hypot(p.x, p.z));
      if (i < n) {
        const a = base + i * 2;
        idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
      }
    }
  };
  for (let s = 0; s < stems; s++) {
    const a0 = rnd() * Math.PI * 2;
    const r0 = Math.sqrt(rnd()) * 0.26;
    const bx = Math.cos(a0) * r0,
      bz = Math.sin(a0) * r0;
    const h = kind === 'cattail' ? 1.3 + rnd() * 0.6 : 1.7 + rnd() * 0.9;
    const leanA = rnd() * Math.PI * 2;
    const lean = 0.05 + rnd() * 0.16;
    const lx = Math.cos(leanA) * lean,
      lz = Math.sin(leanA) * lean;
    const stem = (t) => ({ x: bx + lx * h * t * t, y: h * t, z: bz + lz * h * t * t });
    const face = new THREE.Vector3(Math.cos(a0 + 1.3), 0, Math.sin(a0 + 1.3));
    const face2 = new THREE.Vector3(-face.z, 0, face.x);
    // stem: two crossed ribbons
    ribbon(stem, (t) => 0.014 * (1 - t * 0.55), face, 0.2, 0.3, segs);
    ribbon(stem, (t) => 0.014 * (1 - t * 0.55), face2, 0.2, 0.3, segs);
    // leaves
    const nl = leafCount + Math.floor(rnd() * 2);
    for (let l = 0; l < nl; l++) {
      const t0 = 0.12 + (l / nl) * 0.72 + rnd() * 0.06;
      const org = stem(t0);
      const la = a0 + l * 2.4 + rnd();
      const len = (kind === 'cattail' ? 0.75 : 0.5) + rnd() * 0.35;
      const droop = 0.25 + rnd() * 0.5;
      const dx = Math.cos(la),
        dz = Math.sin(la);
      const leaf = (t) => ({ x: org.x + dx * len * (0.35 * t + 0.4 * t * t), y: org.y + len * (0.95 * t - droop * t * t), z: org.z + dz * len * (0.35 * t + 0.4 * t * t) });
      const lf = new THREE.Vector3(-dz, 0.25, dx).normalize();
      ribbon(leaf, (t) => (kind === 'cattail' ? 0.022 : 0.032) * Math.sin(Math.PI * Math.min(1, t * 0.92 + 0.08)) + 0.003, lf, 0.02, 0.48, Math.max(2, segs - 1));
    }
    // seed head
    const topP = stem(1);
    if (kind === 'cattail') {
      const y0 = h * 0.8,
        y1 = h * 0.95;
      for (let k = 0; k < 3; k++) {
        const f = new THREE.Vector3(Math.cos((k * Math.PI) / 3), 0, Math.sin((k * Math.PI) / 3));
        const head = (t) => {
          const p = stem((y0 + (y1 - y0) * t) / h);
          return p;
        };
        ribbon(head, () => 0.03, f, 0.8, 0.95, 1);
      }
    } else if (rnd() > 0.3) {
      // phragmites panicle: a few thin drooping strands rather than a flat blade
      const pa = rnd() * Math.PI * 2;
      for (let q = 0; q < 3; q++) {
        const a2 = pa + (q - 1) * 0.5;
        const len = 0.16 + rnd() * 0.12;
        const plume = (t) => ({ x: topP.x + Math.cos(a2) * 0.1 * t * t * (1 + q * 0.3), y: topP.y + len * t - 0.09 * t * t, z: topP.z + Math.sin(a2) * 0.1 * t * t * (1 + q * 0.3) });
        ribbon(plume, (t) => 0.02 * Math.sin(Math.PI * Math.min(1, t * 0.9 + 0.08)) + 0.004, new THREE.Vector3(Math.cos(a2 + 1.57), 0.2, Math.sin(a2 + 1.57)).normalize(), 0.52, 0.73, 2);
      }
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(pos), 3));
  g.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(nor), 3));
  g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(uv), 2));
  g.setIndex(new THREE.BufferAttribute(new Uint16Array(idx), 1));
  g.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, maxH / 2, 0), Math.hypot(maxR, maxH / 2) + 0.05);
  return { geometry: g, triangles: idx.length / 3, height: maxH, radius: maxR };
}

export function buildReedModel(id) {
  const kind = id === 'proc_cattail' ? 'cattail' : 'reed';
  if (!sharedTex) sharedTex = plantTexture();
  const seed = kind === 'cattail' ? 4711 : 1337;
  const l0 = buildClump(kind, 7, kind === 'cattail' ? 3 : 5, seed, 5);
  const l1 = buildClump(kind, 4, kind === 'cattail' ? 2 : 3, seed, 3);
  const l2 = buildClump(kind, 3, 1, seed, 2);
  const info = {
    name: kind === 'cattail' ? 'Cattail clump (procedural)' : 'Common reed clump (procedural)',
    category: 'reed',
    procedural: true,
    lods: [
      { file: null, triangles: l0.triangles },
      { file: null, triangles: l1.triangles },
      { file: null, triangles: l2.triangles },
    ],
    bounds: { min: [-l0.radius, 0, -l0.radius], max: [l0.radius, l0.height, l0.radius] },
    height: l0.height,
    radius: Math.max(0.3, l0.radius),
    materials: [{ name: id, foliage: true }],
    source: { url: null, authors: ['generated by this application'], license: 'n/a (procedural)' },
  };
  return { info, lods: [l0, l1, l2], texture: sharedTex };
}
