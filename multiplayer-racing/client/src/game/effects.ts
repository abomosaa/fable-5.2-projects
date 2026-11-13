/**
 * Visual effects: tyre smoke / snow spray, impact sparks and skid marks.
 * Fixed-size pools, no allocation while racing.
 */
import * as THREE from 'three';

const MAX_PARTICLES = 420;
const MAX_SKID_QUADS = 1400;

function softDot(): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = 64;
  canvas.height = 64;
  const ctx = canvas.getContext('2d')!;
  const gradient = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
  gradient.addColorStop(0, 'rgba(255,255,255,1)');
  gradient.addColorStop(0.4, 'rgba(255,255,255,0.55)');
  gradient.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, 64, 64);
  return new THREE.CanvasTexture(canvas);
}

const PARTICLE_VERTEX = /* glsl */ `
  attribute float size;
  attribute vec4 tint;
  varying vec4 vTint;
  void main() {
    vTint = tint;
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    gl_PointSize = size * (300.0 / max(1.0, -mv.z));
    gl_Position = projectionMatrix * mv;
  }
`;
const PARTICLE_FRAGMENT = /* glsl */ `
  uniform sampler2D map;
  varying vec4 vTint;
  void main() {
    vec4 texel = texture2D(map, gl_PointCoord);
    gl_FragColor = vec4(vTint.rgb, vTint.a * texel.a);
  }
`;

export class Effects {
  readonly group = new THREE.Group();
  /** Scales particle counts (reduced motion / low quality). */
  intensity = 1;

  private readonly positions = new Float32Array(MAX_PARTICLES * 3);
  private readonly tints = new Float32Array(MAX_PARTICLES * 4);
  private readonly sizes = new Float32Array(MAX_PARTICLES);
  private readonly velocities = new Float32Array(MAX_PARTICLES * 3);
  private readonly life = new Float32Array(MAX_PARTICLES);
  private readonly maxLife = new Float32Array(MAX_PARTICLES);
  private readonly growth = new Float32Array(MAX_PARTICLES);
  private readonly gravity = new Float32Array(MAX_PARTICLES);
  private readonly baseAlpha = new Float32Array(MAX_PARTICLES);
  private cursor = 0;
  private readonly particleGeometry = new THREE.BufferGeometry();
  private readonly particleMaterial: THREE.ShaderMaterial;
  private readonly dot = softDot();

  private readonly skidPositions = new Float32Array(MAX_SKID_QUADS * 4 * 3);
  private readonly skidAlpha = new Float32Array(MAX_SKID_QUADS * 4);
  private readonly skidGeometry = new THREE.BufferGeometry();
  private readonly skidMaterial: THREE.ShaderMaterial;
  private skidCursor = 0;
  private skidFade = 0;

  constructor() {
    this.particleGeometry.setAttribute('position', new THREE.BufferAttribute(this.positions, 3).setUsage(THREE.DynamicDrawUsage));
    this.particleGeometry.setAttribute('tint', new THREE.BufferAttribute(this.tints, 4).setUsage(THREE.DynamicDrawUsage));
    this.particleGeometry.setAttribute('size', new THREE.BufferAttribute(this.sizes, 1).setUsage(THREE.DynamicDrawUsage));
    this.particleMaterial = new THREE.ShaderMaterial({
      uniforms: { map: { value: this.dot } },
      vertexShader: PARTICLE_VERTEX,
      fragmentShader: PARTICLE_FRAGMENT,
      transparent: true,
      depthWrite: false,
    });
    const points = new THREE.Points(this.particleGeometry, this.particleMaterial);
    points.frustumCulled = false;
    points.renderOrder = 10;
    this.group.add(points);

    const index: number[] = [];
    for (let q = 0; q < MAX_SKID_QUADS; q++) {
      const a = q * 4;
      index.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
    }
    this.skidGeometry.setAttribute('position', new THREE.BufferAttribute(this.skidPositions, 3).setUsage(THREE.DynamicDrawUsage));
    this.skidGeometry.setAttribute('alpha', new THREE.BufferAttribute(this.skidAlpha, 1).setUsage(THREE.DynamicDrawUsage));
    this.skidGeometry.setIndex(index);
    this.skidMaterial = new THREE.ShaderMaterial({
      uniforms: { tint: { value: new THREE.Color(0x0a0a0c) } },
      vertexShader: /* glsl */ `
        attribute float alpha;
        varying float vAlpha;
        void main() {
          vAlpha = alpha;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: /* glsl */ `
        uniform vec3 tint;
        varying float vAlpha;
        void main() {
          gl_FragColor = vec4(tint, vAlpha);
        }
      `,
      transparent: true,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -8,
      polygonOffsetUnits: -8,
      side: THREE.DoubleSide,
    });
    const skids = new THREE.Mesh(this.skidGeometry, this.skidMaterial);
    skids.frustumCulled = false;
    skids.renderOrder = 2;
    this.group.add(skids);
  }

  /** Skid marks are dark rubber on asphalt and pale scrapes on ice. */
  setSurface(ice: boolean): void {
    (this.skidMaterial.uniforms.tint!.value as THREE.Color).setHex(ice ? 0x5f7d99 : 0x0a0a0c);
  }

  private spawn(x: number, y: number, z: number, vx: number, vy: number, vz: number, life: number, size: number, grow: number, gravity: number, r: number, g: number, b: number, alpha: number): void {
    const i = this.cursor;
    this.cursor = (this.cursor + 1) % MAX_PARTICLES;
    this.positions[i * 3] = x;
    this.positions[i * 3 + 1] = y;
    this.positions[i * 3 + 2] = z;
    this.velocities[i * 3] = vx;
    this.velocities[i * 3 + 1] = vy;
    this.velocities[i * 3 + 2] = vz;
    this.life[i] = life;
    this.maxLife[i] = life;
    this.sizes[i] = size;
    this.growth[i] = grow;
    this.gravity[i] = gravity;
    this.tints[i * 4] = r;
    this.tints[i * 4 + 1] = g;
    this.tints[i * 4 + 2] = b;
    this.baseAlpha[i] = alpha;
  }

  /** A puff of tyre smoke (or snow spray) at a wheel. */
  smoke(x: number, z: number, vx: number, vz: number, amount: number, snow: boolean): void {
    if (Math.random() > amount * this.intensity) return;
    const jitter = (): number => (Math.random() - 0.5) * 1.2;
    if (snow) {
      this.spawn(x, 0.25, z, vx * 0.25 + jitter(), 1.2 + Math.random() * 1.6, vz * 0.25 + jitter(), 0.7, 1.0, 2.2, 3.5, 0.95, 0.97, 1, 0.75);
    } else {
      this.spawn(x, 0.25, z, vx * 0.12 + jitter(), 0.7 + Math.random(), vz * 0.12 + jitter(), 1.0, 1.1, 3.2, -0.2, 0.86, 0.86, 0.88, 0.42);
    }
  }

  /** Dust / grass kicked up while off the road. */
  dust(x: number, z: number, vx: number, vz: number, snow: boolean): void {
    if (Math.random() > 0.5 * this.intensity) return;
    const j = (): number => (Math.random() - 0.5) * 1.6;
    if (snow) this.spawn(x, 0.2, z, vx * 0.2 + j(), 1.5 + Math.random(), vz * 0.2 + j(), 0.6, 0.8, 1.8, 4, 1, 1, 1, 0.7);
    else this.spawn(x, 0.2, z, vx * 0.2 + j(), 1.0 + Math.random(), vz * 0.2 + j(), 0.8, 0.9, 2.4, 2, 0.5, 0.42, 0.28, 0.5);
  }

  /** A burst of sparks (or snow) at an impact point. */
  sparks(x: number, z: number, strength: number, snow: boolean): void {
    const count = Math.round(Math.min(26, 6 + strength * 2.2) * this.intensity);
    for (let i = 0; i < count; i++) {
      const angle = Math.random() * Math.PI * 2;
      const speed = 2 + Math.random() * (4 + strength * 0.6);
      if (snow) {
        this.spawn(x, 0.5, z, Math.cos(angle) * speed, 2 + Math.random() * 4, Math.sin(angle) * speed, 0.7, 0.7, 0.8, 9, 1, 1, 1, 0.9);
      } else {
        this.spawn(x, 0.5, z, Math.cos(angle) * speed, 2 + Math.random() * 5, Math.sin(angle) * speed, 0.45, 0.3, 0, 12, 1, 0.75 + Math.random() * 0.2, 0.3, 1);
      }
    }
  }

  /** A ring of light when a checkpoint is taken. */
  flash(x: number, z: number): void {
    const count = Math.round(18 * this.intensity);
    for (let i = 0; i < count; i++) {
      const angle = (i / count) * Math.PI * 2;
      this.spawn(x, 1.2, z, Math.cos(angle) * 7, 1.5, Math.sin(angle) * 7, 0.5, 0.7, 0.5, 0, 0.35, 0.9, 1, 0.9);
    }
  }

  /** Lays a segment of skid mark between two wheel positions. */
  skid(x0: number, z0: number, x1: number, z1: number, strength: number): void {
    const dx = x1 - x0;
    const dz = z1 - z0;
    const length = Math.hypot(dx, dz);
    if (length < 0.05 || length > 4) return;
    const nx = (-dz / length) * 0.13;
    const nz = (dx / length) * 0.13;
    const q = this.skidCursor;
    this.skidCursor = (this.skidCursor + 1) % MAX_SKID_QUADS;
    const p = this.skidPositions;
    const o = q * 12;
    p[o] = x0 + nx;
    p[o + 1] = 0.045;
    p[o + 2] = z0 + nz;
    p[o + 3] = x0 - nx;
    p[o + 4] = 0.045;
    p[o + 5] = z0 - nz;
    p[o + 6] = x1 + nx;
    p[o + 7] = 0.045;
    p[o + 8] = z1 + nz;
    p[o + 9] = x1 - nx;
    p[o + 10] = 0.045;
    p[o + 11] = z1 - nz;
    const alpha = Math.min(0.55, 0.18 + strength * 0.4);
    this.skidAlpha.fill(alpha, q * 4, q * 4 + 4);
    this.skidGeometry.getAttribute('position').needsUpdate = true;
    this.skidGeometry.getAttribute('alpha').needsUpdate = true;
  }

  update(dt: number): void {
    for (let i = 0; i < MAX_PARTICLES; i++) {
      if (this.life[i]! <= 0) continue;
      this.life[i] = this.life[i]! - dt;
      if (this.life[i]! <= 0) {
        this.tints[i * 4 + 3] = 0;
        this.sizes[i] = 0;
        continue;
      }
      this.velocities[i * 3 + 1] = this.velocities[i * 3 + 1]! - this.gravity[i]! * dt;
      this.positions[i * 3] = this.positions[i * 3]! + this.velocities[i * 3]! * dt;
      this.positions[i * 3 + 1] = Math.max(0.05, this.positions[i * 3 + 1]! + this.velocities[i * 3 + 1]! * dt);
      this.positions[i * 3 + 2] = this.positions[i * 3 + 2]! + this.velocities[i * 3 + 2]! * dt;
      this.sizes[i] = this.sizes[i]! + this.growth[i]! * dt;
      this.tints[i * 4 + 3] = this.baseAlpha[i]! * (this.life[i]! / this.maxLife[i]!);
    }
    this.particleGeometry.getAttribute('position').needsUpdate = true;
    this.particleGeometry.getAttribute('tint').needsUpdate = true;
    this.particleGeometry.getAttribute('size').needsUpdate = true;

    // Old skid marks fade slowly, a slice of the buffer per frame.
    const slice = 80;
    for (let k = 0; k < slice; k++) {
      const i = (this.skidFade + k) % (MAX_SKID_QUADS * 4);
      if (this.skidAlpha[i]! > 0) this.skidAlpha[i] = Math.max(0, this.skidAlpha[i]! - 0.012);
    }
    this.skidFade = (this.skidFade + slice) % (MAX_SKID_QUADS * 4);
    this.skidGeometry.getAttribute('alpha').needsUpdate = true;
  }

  clear(): void {
    this.life.fill(0);
    this.sizes.fill(0);
    this.tints.fill(0);
    this.skidAlpha.fill(0);
    this.skidPositions.fill(0);
    this.particleGeometry.getAttribute('tint').needsUpdate = true;
    this.particleGeometry.getAttribute('size').needsUpdate = true;
    this.skidGeometry.getAttribute('alpha').needsUpdate = true;
    this.skidGeometry.getAttribute('position').needsUpdate = true;
  }

  dispose(): void {
    this.particleGeometry.dispose();
    this.particleMaterial.dispose();
    this.skidGeometry.dispose();
    this.skidMaterial.dispose();
    this.dot.dispose();
  }
}
