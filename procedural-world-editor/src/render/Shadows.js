// Cascaded shadow maps rendered into one depth atlas (2x2 tiles). Cascades are fitted to
// bounding spheres of the view-frustum slices and snapped to texel increments so shadows do not
// shimmer when the camera moves. Each caster supplies its own depth material (wind, alpha test,
// clipmap displacement) via mesh.userData.depthMaterial.

import * as THREE from 'three';

export class Shadows {
  constructor(engine) {
    this.engine = engine;
    this.size = engine.quality.shadowSize || 2048;
    const S = this.size * 2;
    this.rt = new THREE.WebGLRenderTarget(S, S, { depthBuffer: true, type: THREE.UnsignedByteType, format: THREE.RGBAFormat, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter });
    this.rt.depthTexture = new THREE.DepthTexture(S, S, THREE.FloatType);
    this.rt.depthTexture.format = THREE.DepthFormat;
    this.rt.depthTexture.minFilter = THREE.LinearFilter;
    this.rt.depthTexture.magFilter = THREE.LinearFilter;
    this.reversed = engine.renderer.capabilities.reversedDepthBuffer === true;
    this.rt.depthTexture.compareFunction = this.reversed ? THREE.GreaterEqualCompare : THREE.LessEqualCompare;
    this.splits = [22, 85, 340, 1700];
    this.cams = [];
    for (let i = 0; i < 4; i++) {
      const c = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 100);
      c.layers.set(2);
      if (this.reversed) c._reversedDepth = true;
      this.cams.push(c);
    }
    this.mats = engine.G.uShadowMat.value;
    this.frame = 0;
    this._corners = Array.from({ length: 8 }, () => new THREE.Vector3());
    this._center = new THREE.Vector3();
    this._lightView = new THREE.Matrix4();
    this._tmp = new THREE.Vector3();
    this.enabled = true;
    engine.G.uShadowMap.value = this.rt.depthTexture;
  }

  /** Fit cascade i to the camera frustum slice [n, f]. */
  _fit(i, camera, n, f, sunDir) {
    const cam = this.cams[i];
    const tanY = Math.tan(THREE.MathUtils.degToRad(camera.fov * 0.5));
    const tanX = tanY * camera.aspect;
    // bounding sphere of the slice (analytic)
    const k = tanX * tanX + tanY * tanY;
    let cz = ((f + n) * 0.5) * (1 + k);
    let radius;
    if (cz > f) {
      cz = f;
      radius = f * Math.sqrt(k);
    } else radius = Math.sqrt((f - cz) * (f - cz) + f * f * k);
    radius = Math.ceil(radius * 1.02);
    const fwd = this._tmp.set(0, 0, -1).applyQuaternion(camera.quaternion);
    const center = this._center.copy(camera.position).addScaledVector(fwd, cz);
    // light basis
    const up = Math.abs(sunDir.y) > 0.99 ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 1, 0);
    const lz = sunDir.clone().normalize(); // camera looks along -lz
    const lx = new THREE.Vector3().crossVectors(up, lz).normalize();
    const ly = new THREE.Vector3().crossVectors(lz, lx);
    // snap the centre to shadow texels in light space
    const texel = (2 * radius) / this.size;
    let cx = center.dot(lx),
      cy = center.dot(ly);
    const cd = center.dot(lz);
    cx = Math.round(cx / texel) * texel;
    cy = Math.round(cy / texel) * texel;
    const back = 2600; // casters towards the sun (mountains) must be inside the volume
    const pos = new THREE.Vector3().addScaledVector(lx, cx).addScaledVector(ly, cy).addScaledVector(lz, cd + back);
    cam.position.copy(pos);
    cam.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(lx, ly, lz));
    cam.left = -radius;
    cam.right = radius;
    cam.top = radius;
    cam.bottom = -radius;
    cam.near = 1;
    cam.far = back + radius * 2 + 600;
    cam.updateProjectionMatrix();
    cam.updateMatrixWorld(true);
    cam.matrixWorldInverse.copy(cam.matrixWorld).invert();
    // world -> (uv in 0..1, depth)
    const m = this.mats[i];
    m.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);
    const bias = new THREE.Matrix4();
    if (this.reversed) bias.set(0.5, 0, 0, 0.5, 0, 0.5, 0, 0.5, 0, 0, 1, 0, 0, 0, 0, 1);
    else bias.set(0.5, 0, 0, 0.5, 0, 0.5, 0, 0.5, 0, 0, 0.5, 0.5, 0, 0, 0, 1);
    m.premultiply(bias);
    return texel;
  }

  render(scene, camera, sunDir, casters) {
    const G = this.engine.G;
    this.frame++;
    if (!this.enabled || sunDir.y < -0.02) {
      G.uShadowTexel.value.w = sunDir.y < -0.02 ? 0 : 0;
      if (!this.enabled) return;
    }
    const r = this.engine.renderer;
    const splits = this.splits;
    // far cascades change slowly: refresh them on alternating frames
    const update = [true, true, this.frame % 2 === 0 || this._force, this.frame % 4 === 1 || this._force];
    this._force = false;
    let texel0 = 0;
    const prevRT = r.getRenderTarget();
    const prevAuto = r.autoClear;
    r.autoClear = false;
    // swap in depth materials
    const swapped = [];
    for (const m of casters) {
      const dm = m.userData.depthMaterial;
      if (!dm) continue;
      swapped.push(m, m.material);
      m.material = dm;
    }
    const S = this.size;
    r.setRenderTarget(this.rt);
    for (let i = 0; i < 4; i++) {
      if (!update[i] && this._fitted) continue;
      const n = i === 0 ? camera.near : splits[i - 1] * 0.82;
      const tx = this._fit(i, camera, n, splits[i], sunDir);
      if (i === 0) texel0 = tx;
      G.uShadowTexW.value[i] = tx;
      const vx = (i & 1) * S,
        vy = (i >> 1) * S;
      this.rt.viewport.set(vx, vy, S, S);
      this.rt.scissor.set(vx, vy, S, S);
      this.rt.scissorTest = true;
      r.setRenderTarget(this.rt);
      r.clear(false, true, false);
      this.currentCascade = i;
      const hidden = [];
      for (const m of casters) {
        const mask = m.userData.cascadeMask;
        if (mask !== undefined && !(mask & (1 << i)) && m.visible) {
          m.visible = false;
          hidden.push(m);
        }
      }
      r.render(scene, this.cams[i]);
      for (const m of hidden) m.visible = true;
    }
    this._fitted = true;
    for (let i = 0; i < swapped.length; i += 2) swapped[i].material = swapped[i + 1];
    r.setRenderTarget(prevRT);
    r.autoClear = prevAuto;
    G.uShadowSplits.value.set(splits[0], splits[1], splits[2], splits[3]);
    if (texel0) this.texel0 = texel0;
    G.uShadowTexel.value.set(1 / (S * 2), this.texel0 || 0.02, 0, sunDir.y > -0.02 ? 1 : 0);
  }

  forceUpdate() {
    this._force = true;
  }

  dispose() {
    this.rt.dispose();
  }
}
