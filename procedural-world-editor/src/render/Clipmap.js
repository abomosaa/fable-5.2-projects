// Geometry clipmap: nested camera-centred grids whose spacing doubles per level, with geomorphing
// towards the next coarser level near each ring's outer edge so levels join without cracks.
// Used by both the terrain and the water surface.

import * as THREE from 'three';

/** GLSL for the vertex stage. Requires attribute `position.xy` = integer grid coordinate. */
export const CLIPMAP_VERT_GLSL = /* glsl */ `
uniform vec4 uRing;     // x = cell size, y = origin x, z = origin z, w = level index
uniform vec3 uClipCam;  // xz = camera position, z = half grid size in cells (M/2)
// returns world xz; outputs morph factor and the coarse-grid xz
vec2 clipmapPos(vec2 grid, out float morph, out vec2 coarse){
  vec2 wp = uRing.yz + grid * uRing.x;
  vec2 d = abs(wp - uClipCam.xy) / uRing.x;
  float md = max(d.x, d.y);
  float M2 = uClipCam.z;
  morph = smoothstep(M2 * 0.62, M2 * 0.80, md);
  vec2 odd = fract(grid * 0.5) * 2.0;
  coarse = wp - odd * uRing.x;
  return mix(wp, coarse, morph);
}
`;

function buildGrid(M, hole) {
  // vertices on integer coordinates [-M/2, M/2]; quads fully inside the hole are skipped
  const n = M + 1;
  const pos = new Float32Array(n * n * 3);
  let p = 0;
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      pos[p++] = i - M / 2;
      pos[p++] = j - M / 2;
      pos[p++] = 0;
    }
  }
  const idx = [];
  for (let j = 0; j < M; j++) {
    for (let i = 0; i < M; i++) {
      if (hole > 0) {
        const x0 = i - M / 2,
          z0 = j - M / 2;
        if (x0 >= -hole && x0 + 1 <= hole && z0 >= -hole && z0 + 1 <= hole) continue;
      }
      const a = j * n + i,
        b = a + 1,
        c = a + n,
        d = c + 1;
      // alternate the diagonal so morphing collapses cleanly onto the coarse grid
      if ((i + j) & 1) idx.push(a, c, b, b, c, d);
      else idx.push(a, c, d, a, d, b);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setIndex(new THREE.BufferAttribute(new Uint32Array(idx), 1));
  g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e9);
  return g;
}

export class Clipmap {
  /**
   * @param {object} o {M: grid size (even, multiple of 4), levels, baseCell, makeMaterial(level) -> ShaderMaterial}
   */
  constructor(o) {
    this.M = o.M;
    this.levels = o.levels;
    this.baseCell = o.baseCell;
    this.group = new THREE.Group();
    this.meshes = [];
    const full = buildGrid(this.M, 0);
    const ring = buildGrid(this.M, this.M / 4 - 6);
    for (let l = 0; l < this.levels; l++) {
      const mat = o.makeMaterial(l);
      mat.uniforms.uRing = { value: new THREE.Vector4(this.baseCell * (1 << l), 0, 0, l) };
      mat.uniforms.uClipCam = { value: new THREE.Vector3(0, 0, this.M / 2) };
      const mesh = new THREE.Mesh(l === 0 ? full : ring, mat);
      mesh.frustumCulled = false;
      mesh.matrixAutoUpdate = false;
      mesh.userData.level = l;
      this.group.add(mesh);
      this.meshes.push(mesh);
    }
  }

  /** Snap rings to the camera. `anchor` = lattice origin so vertices coincide with data texels. */
  update(camX, camZ, anchorX = 0, anchorZ = 0) {
    for (let l = 0; l < this.levels; l++) {
      const mesh = this.meshes[l];
      const cell = this.baseCell * (1 << l);
      const snap = cell * 2;
      const ox = Math.round((camX - anchorX) / snap) * snap + anchorX;
      const oz = Math.round((camZ - anchorZ) / snap) * snap + anchorZ;
      const u = mesh.material.uniforms;
      u.uRing.value.set(cell, ox, oz, l);
      u.uClipCam.value.set(camX, camZ, this.M / 2);
      const dm = mesh.userData.depthMaterial;
      if (dm) {
        dm.uniforms.uRing.value.copy(u.uRing.value);
        dm.uniforms.uClipCam.value.copy(u.uClipCam.value);
      }
    }
  }

  dispose() {
    this.meshes[0].geometry.dispose();
    if (this.meshes[1]) this.meshes[1].geometry.dispose();
    for (const m of this.meshes) m.material.dispose();
  }
}
