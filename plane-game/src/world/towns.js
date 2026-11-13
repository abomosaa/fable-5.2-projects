// Towns and villages: instanced houses with pitched roofs (and a few taller blocks in the
// city), street and window lights at night, and a spatial hash for collision tests.

import * as THREE from 'three';
import { SETTLEMENTS, terrainHeight, airfieldFactor } from './heightfield.js';
import { withAtmosphere } from '../gfx/atmosphere.js';
import { LightBuilder } from './airportScenery.js';

const CELL = 64;
const WORLD = { dirX: 1, dirZ: 0, sideX: 0, sideZ: 1 };     // identity frame for the light builder

function roofGeometry() {
  // gabled roof: unit footprint, unit height, ridge along X
  const p = [-0.5, 0, -0.5, 0.5, 0, -0.5, 0.5, 0, 0.5, -0.5, 0, 0.5, -0.5, 1, 0, 0.5, 1, 0];
  const idx = [0, 4, 5, 0, 5, 1, 3, 2, 5, 3, 5, 4, 0, 3, 4, 1, 5, 2];
  const g = new THREE.BufferGeometry();
  // un-indexed for flat shading
  const pos = [];
  for (const i of idx) pos.push(p[i * 3], p[i * 3 + 1], p[i * 3 + 2]);
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.computeVertexNormals();
  return g;
}

export class Towns {
  constructor(scene) {
    this.hash = new Map();
    const list = [];
    const L = new LightBuilder();
    let seed = 20240611;
    const rnd = () => { seed = (Math.imul(seed, 1664525) + 1013904223) | 0; return (seed >>> 8) / 16777216; };
    const wallCols = [[0.78, 0.74, 0.66], [0.82, 0.8, 0.76], [0.62, 0.36, 0.28], [0.7, 0.66, 0.56], [0.55, 0.56, 0.58], [0.84, 0.78, 0.6]];
    const roofCols = [[0.42, 0.16, 0.11], [0.3, 0.2, 0.16], [0.2, 0.21, 0.23], [0.5, 0.24, 0.14], [0.26, 0.25, 0.24]];
    for (const s of SETTLEMENTS) {
      const rot = rnd() * Math.PI, cr = Math.cos(rot), sr = Math.sin(rot);
      const sp = 27, n = Math.ceil(s.radius / sp);
      for (let i = -n; i <= n; i++) for (let j = -n; j <= n; j++) {
        if (((i % 5) + 5) % 5 === 2 || ((j % 4) + 4) % 4 === 1) continue;        // streets
        const lx = (i + (rnd() - 0.5) * 0.35) * sp, lz = (j + (rnd() - 0.5) * 0.35) * sp;
        const rr = Math.hypot(lx, lz) / s.radius;
        const keep = rnd();
        if (rr > 1 || keep > (1 - rr * rr) * 0.92 + 0.06) continue;
        const x = s.x + lx * cr - lz * sr, z = s.z + lx * sr + lz * cr;
        const h = terrainHeight(x, z);
        if (h < 2.2 || airfieldFactor(x, z) > 0.01) continue;
        const slope = Math.hypot(terrainHeight(x + 8, z) - h, terrainHeight(x, z + 8) - h) / 8;
        if (slope > 0.22) continue;
        const tall = s.tall && rr < 0.42 && rnd() < 0.34;
        const w = tall ? 15 + rnd() * 9 : 8 + rnd() * 8, d = tall ? 14 + rnd() * 8 : 7 + rnd() * 5;
        const ht = tall ? 12 + rnd() * rnd() * 34 : 3.6 + rnd() * 4.5;
        const yaw = rot + (rnd() < 0.5 ? 0 : Math.PI / 2) + (rnd() - 0.5) * 0.12;
        const b = { x, z, h, w, d, ht, yaw, tall, wall: wallCols[Math.floor(rnd() * wallCols.length)], roof: roofCols[Math.floor(rnd() * roofCols.length)], roofH: tall ? 0.5 : 1.6 + rnd() * 1.8 };
        list.push(b);
        // lights: a street lamp for some houses, lit windows on the taller blocks
        if (rnd() < 0.55) L.add(WORLD, x + Math.cos(yaw) * (w / 2 + 3), z + Math.sin(yaw) * (w / 2 + 3), h + 5.5, [1, 0.72, 0.38], 26, { day: 0 });
        if (rnd() < 0.5) L.add(WORLD, x + (rnd() - 0.5) * w, z + (rnd() - 0.5) * d, h + ht * 0.6, [1, 0.86, 0.6], 9, { day: 0 });
        if (tall) for (let k = 0; k < 5; k++) L.add(WORLD, x + (rnd() - 0.5) * w * 1.05, z + (rnd() - 0.5) * d * 1.05, h + 3 + rnd() * (ht - 4), [1, 0.88, 0.66], 12, { day: 0 });
        if (tall && ht > 30) L.add(WORLD, x, z, h + ht + 2, [1, 0.08, 0.05], 60, { day: 0.3, kind: 4, phase: rnd() });
        // collision hash
        const reach = Math.hypot(w, d) / 2;
        for (let cx = Math.floor((x - reach) / CELL); cx <= Math.floor((x + reach) / CELL); cx++) for (let cz = Math.floor((z - reach) / CELL); cz <= Math.floor((z + reach) / CELL); cz++) {
          const key = cx * 100003 + cz;
          let arr = this.hash.get(key); if (!arr) this.hash.set(key, arr = []);
          arr.push(b);
        }
      }
    }
    this.count = list.length;
    const wallMat = withAtmosphere(new THREE.MeshLambertMaterial({ color: 0xffffff }));
    const roofMat = withAtmosphere(new THREE.MeshLambertMaterial({ color: 0xffffff }));
    const box = new THREE.BoxGeometry(1, 1, 1); box.translate(0, 0.5, 0);
    const walls = new THREE.InstancedMesh(box, wallMat, list.length);
    const roofs = new THREE.InstancedMesh(roofGeometry(), roofMat, list.length);
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), p = new THREE.Vector3(), sc = new THREE.Vector3(), up = new THREE.Vector3(0, 1, 0), c = new THREE.Color();
    list.forEach((b, i) => {
      q.setFromAxisAngle(up, -b.yaw);
      m.compose(p.set(b.x, b.h - 1.2, b.z), q, sc.set(b.w, b.ht + 1.2, b.d)); walls.setMatrixAt(i, m);
      walls.setColorAt(i, c.setRGB(b.wall[0], b.wall[1], b.wall[2]).multiplyScalar(0.55));
      m.compose(p.set(b.x, b.h + b.ht, b.z), q, sc.set(b.w * 1.06, b.roofH, b.d * 1.08)); roofs.setMatrixAt(i, m);
      roofs.setColorAt(i, c.setRGB(b.roof[0], b.roof[1], b.roof[2]).multiplyScalar(0.7));
    });
    for (const im of [walls, roofs]) { im.instanceMatrix.needsUpdate = true; im.instanceColor.needsUpdate = true; im.frustumCulled = false; im.receiveShadow = true; scene.add(im); }
    const pts = L.build();
    scene.add(pts);
    this.walls = walls; this.roofs = roofs; this.lights = pts;
  }

  /** point inside a building? */
  hits(x, y, z) {
    const arr = this.hash.get(Math.floor(x / CELL) * 100003 + Math.floor(z / CELL));
    if (!arr) return false;
    for (const b of arr) {
      if (y > b.h + b.ht + b.roofH) continue;
      const dx = x - b.x, dz = z - b.z, c = Math.cos(b.yaw), s = Math.sin(b.yaw);
      const u = dx * c + dz * s, v = -dx * s + dz * c;
      if (Math.abs(u) < b.w / 2 && Math.abs(v) < b.d / 2) return true;
    }
    return false;
  }
}
