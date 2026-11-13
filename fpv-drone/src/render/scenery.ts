/**
 * Turns the map description into three.js meshes. Static geometry is merged
 * into one mesh per material, with UVs laid out in metres so textures keep
 * their real-world scale on every object.
 */
import * as THREE from 'three';
import { MapData, MatId, TreeDef } from '../world/map';
import { CollisionWorld, Contact } from '../sim/world';
import { Environment } from '../sim/environment';
import {
  PbrMaps, asphaltTexture, barkTexture, checkerTexture, concreteTexture, corrugatedTexture, grassTexture, leafAtlas,
  lotDecal, macroNoiseTexture, padDecal, pitchDecal, roadDecal, sockTexture, speckleTexture, woodTexture,
} from './textures';

function rngFrom(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

class GeoBuilder {
  pos: number[] = [];
  nrm: number[] = [];
  uv: number[] = [];
  col: number[] = [];
  idx: number[] = [];
  private n = 0;

  vertex(x: number, y: number, z: number, nx: number, ny: number, nz: number, u: number, v: number, r = 1, g = 1, b = 1): number {
    this.pos.push(x, y, z);
    this.nrm.push(nx, ny, nz);
    this.uv.push(u, v);
    this.col.push(r, g, b);
    return this.n++;
  }

  tri(a: number, b: number, c: number): void {
    this.idx.push(a, b, c);
  }

  quad(a: number, b: number, c: number, d: number): void {
    this.idx.push(a, b, c, a, c, d);
  }

  build(withColor = false): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nrm, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.uv, 2));
    if (withColor) g.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3));
    g.setIndex(this.n > 65535 ? new THREE.Uint32BufferAttribute(this.idx, 1) : new THREE.Uint16BufferAttribute(this.idx, 1));
    g.computeBoundingSphere();
    g.computeBoundingBox();
    return g;
  }
}

// Face frames: normal n, tangents a and b with a x b = n; b is "up" on vertical faces.
const FACES: [number[], number[], number[]][] = [
  [[1, 0, 0], [0, 0, -1], [0, 1, 0]],
  [[-1, 0, 0], [0, 0, 1], [0, 1, 0]],
  [[0, 1, 0], [1, 0, 0], [0, 0, -1]],
  [[0, -1, 0], [1, 0, 0], [0, 0, 1]],
  [[0, 0, 1], [1, 0, 0], [0, 1, 0]],
  [[0, 0, -1], [-1, 0, 0], [0, 1, 0]],
];

/**
 * Ambient occlusion at a surface point, estimated by probing the collision world
 * along a few directions around the normal. Baked into vertex colours so that
 * interiors (the bando, the barn, the container tunnel) are darker than open faces.
 */
const AO_DIRS: number[][] = (() => {
  const out: number[][] = [[0, 0, 1, 1]];
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2;
    const tilt = i % 2 === 0 ? 0.62 : 1.05;
    out.push([Math.cos(a) * Math.sin(tilt), Math.sin(a) * Math.sin(tilt), Math.cos(tilt), Math.cos(tilt)]);
  }
  return out;
})();
const AO_DIST = [0.3, 0.8, 1.7, 3.2, 5.5];
const aoBuf: Contact[] = [];

function ambientOcclusion(world: CollisionWorld, px: number, py: number, pz: number, n: number[], a: number[], b: number[]): number {
  let occ = 0, total = 0;
  for (const d of AO_DIRS) {
    const dx = a[0] * d[0] + b[0] * d[1] + n[0] * d[2];
    const dy = a[1] * d[0] + b[1] * d[1] + n[1] * d[2];
    const dz = a[2] * d[0] + b[2] * d[1] + n[2] * d[2];
    total += d[3];
    for (let k = 0; k < AO_DIST.length; k++) {
      const t = AO_DIST[k];
      const hits = world.querySphere(px + n[0] * 0.05 + dx * t, py + n[1] * 0.05 + dy * t, pz + n[2] * 0.05 + dz * t, 0.11, aoBuf);
      if (hits > 0) {
        occ += d[3] * (1 - (k / AO_DIST.length) * 0.75);
        break;
      }
    }
  }
  return 1 - occ / total;
}

function addBox(gb: GeoBuilder, world: CollisionWorld | null, x: number, y: number, z: number, sx: number, sy: number, sz: number, yaw: number, tile: number, uo: number, vo: number): void {
  const h = [sx / 2, sy / 2, sz / 2];
  const c = Math.cos(yaw), s = Math.sin(yaw);
  const rot = (v: number[]) => [v[0] * c + v[2] * s, v[1], -v[0] * s + v[2] * c];
  for (const [n, a, b] of FACES) {
    const hn = Math.abs(n[0]) * h[0] + Math.abs(n[1]) * h[1] + Math.abs(n[2]) * h[2];
    const ha = Math.abs(a[0]) * h[0] + Math.abs(a[1]) * h[1] + Math.abs(a[2]) * h[2];
    const hb = Math.abs(b[0]) * h[0] + Math.abs(b[1]) * h[1] + Math.abs(b[2]) * h[2];
    const wn = rot(n), wa = rot(a), wb = rot(b);
    // Large faces are subdivided so the baked occlusion has somewhere to live.
    const na = Math.max(1, Math.min(24, Math.ceil((2 * ha) / 2.5)));
    const nb = Math.max(1, Math.min(24, Math.ceil((2 * hb) / 2.5)));
    const ids: number[] = [];
    for (let j = 0; j <= nb; j++) {
      for (let i = 0; i <= na; i++) {
        const ka = -ha + (2 * ha * i) / na, kb = -hb + (2 * hb * j) / nb;
        const wx = x + wn[0] * hn + wa[0] * ka + wb[0] * kb;
        const wy = y + wn[1] * hn + wa[1] * ka + wb[1] * kb;
        const wz = z + wn[2] * hn + wa[2] * ka + wb[2] * kb;
        let ao = 1;
        if (world) {
          // Probe from slightly inside the face so shared edges do not self-occlude.
          const ia = ka * 0.97, ib = kb * 0.97;
          ao = ambientOcclusion(world, x + wn[0] * hn + wa[0] * ia + wb[0] * ib, y + wn[1] * hn + wa[1] * ia + wb[1] * ib, z + wn[2] * hn + wa[2] * ia + wb[2] * ib, wn, wa, wb);
          ao = 0.3 + 0.7 * ao;
        }
        ids.push(gb.vertex(wx, wy, wz, wn[0], wn[1], wn[2], ka / tile + uo, (kb + (b[1] !== 0 ? y : 0)) / tile + vo, ao, ao, ao));
      }
    }
    const row = na + 1;
    for (let j = 0; j < nb; j++) {
      for (let i = 0; i < na; i++) {
        const v0 = ids[j * row + i];
        gb.quad(v0, v0 + 1, v0 + row + 1, v0 + row);
      }
    }
  }
}

function addCylinder(gb: GeoBuilder, x: number, y: number, z: number, r0: number, r1: number, h: number, seg: number, tile: number, cap = true, cr = 1, cg = 1, cb = 1): void {
  const base: number[] = [], top: number[] = [];
  for (let i = 0; i <= seg; i++) {
    const a = (i / seg) * Math.PI * 2;
    const ca = Math.cos(a), sa = Math.sin(a);
    const u = (a * Math.max(r0, r1)) / tile;
    base.push(gb.vertex(x + ca * r0, y, z + sa * r0, ca, 0, sa, u, y / tile, cr, cg, cb));
    top.push(gb.vertex(x + ca * r1, y + h, z + sa * r1, ca, 0, sa, u, (y + h) / tile, cr, cg, cb));
  }
  for (let i = 0; i < seg; i++) gb.quad(base[i], top[i], top[i + 1], base[i + 1]);
  if (cap && r1 > 0) {
    const cidx = gb.vertex(x, y + h, z, 0, 1, 0, 0, 0, cr, cg, cb);
    const ring: number[] = [];
    for (let i = 0; i <= seg; i++) {
      const a = (i / seg) * Math.PI * 2;
      ring.push(gb.vertex(x + Math.cos(a) * r1, y + h, z + Math.sin(a) * r1, 0, 1, 0, (Math.cos(a) * r1) / tile, (Math.sin(a) * r1) / tile, cr, cg, cb));
    }
    for (let i = 0; i < seg; i++) gb.tri(cidx, ring[i + 1], ring[i]);
  }
}

interface MatSpec {
  maps: PbrMaps;
  roughness: number;
  metalness: number;
  normalScale?: number;
}

function materialSpecs(): Record<MatId, MatSpec> {
  const concrete = concreteTexture(false), concreteDark = concreteTexture(true);
  return {
    concrete: { maps: concrete, roughness: 0.93, metalness: 0 },
    concreteDark: { maps: concreteDark, roughness: 0.95, metalness: 0 },
    asphalt: { maps: asphaltTexture(), roughness: 0.95, metalness: 0 },
    containerRed: { maps: corrugatedTexture(146, 44, 36, 0.45, 201), roughness: 0.7, metalness: 0.12, normalScale: 1.0 },
    containerBlue: { maps: corrugatedTexture(40, 74, 122, 0.4, 202), roughness: 0.7, metalness: 0.12, normalScale: 1.0 },
    containerGreen: { maps: corrugatedTexture(48, 100, 76, 0.5, 203), roughness: 0.7, metalness: 0.12, normalScale: 1.0 },
    containerRust: { maps: corrugatedTexture(132, 92, 60, 0.95, 204), roughness: 0.85, metalness: 0.08, normalScale: 1.0 },
    roofMetal: { maps: corrugatedTexture(126, 132, 128, 0.36, 205), roughness: 0.62, metalness: 0.35, normalScale: 1.0 },
    steel: { maps: speckleTexture(74, 76, 80, 0.25, 21), roughness: 0.55, metalness: 0.7 },
    galvanized: { maps: speckleTexture(168, 172, 174, 0.2, 22), roughness: 0.45, metalness: 0.8 },
    wood: { maps: woodTexture(false), roughness: 0.85, metalness: 0 },
    woodDark: { maps: woodTexture(true), roughness: 0.85, metalness: 0 },
    gateOrange: { maps: checkerTexture([236, 92, 16], [238, 236, 228], 23), roughness: 0.7, metalness: 0 },
    gateBlue: { maps: checkerTexture([22, 98, 222], [238, 236, 228], 24), roughness: 0.7, metalness: 0 },
    white: { maps: speckleTexture(232, 232, 226, 0.08, 25), roughness: 0.55, metalness: 0 },
    mastRed: { maps: speckleTexture(196, 40, 30, 0.1, 26), roughness: 0.6, metalness: 0.2 },
    mastWhite: { maps: speckleTexture(230, 230, 226, 0.1, 27), roughness: 0.6, metalness: 0.2 },
    rubber: { maps: speckleTexture(28, 28, 30, 0.1, 28), roughness: 0.9, metalness: 0 },
  };
}

function hashNoise(x: number, z: number): number {
  // Smooth-ish value noise for vertex tinting.
  const ix = Math.floor(x), iz = Math.floor(z);
  const fx = x - ix, fz = z - iz;
  const h = (a: number, b: number) => {
    let n = Math.imul(a, 374761393) ^ Math.imul(b, 668265263);
    n = Math.imul(n ^ (n >>> 13), 1274126177);
    return ((n ^ (n >>> 16)) >>> 0) / 4294967296;
  };
  const ux = fx * fx * (3 - 2 * fx), uz = fz * fz * (3 - 2 * fz);
  const a = h(ix, iz), b = h(ix + 1, iz), c = h(ix, iz + 1), d = h(ix + 1, iz + 1);
  return a + (b - a) * ux + (c - a) * uz + (a - b - c + d) * ux * uz;
}

function buildTerrain(map: MapData, maxAniso: number): THREE.Mesh {
  const hf = map.terrain;
  const n = hf.n, row = n + 1;
  const pos = new Float32Array(row * row * 3);
  const uv = new Float32Array(row * row * 2);
  const grass = grassTexture();
  const half = hf.size / 2;
  for (let j = 0; j <= n; j++) {
    for (let i = 0; i <= n; i++) {
      const k = j * row + i;
      const x = -half + i * hf.cell, z = -half + j * hf.cell;
      const y = hf.data[k];
      pos[k * 3] = x; pos[k * 3 + 1] = y; pos[k * 3 + 2] = z;
      uv[k * 2] = x / grass.tile; uv[k * 2 + 1] = -z / grass.tile;
    }
  }
  const idx = new Uint32Array(n * n * 6);
  let p = 0;
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const a = j * row + i, b = (j + 1) * row + i, c = j * row + i + 1, d = (j + 1) * row + i + 1;
      // Same diagonal as Heightfield.heightAt.
      idx[p++] = a; idx[p++] = b; idx[p++] = c;
      idx[p++] = b; idx[p++] = d; idx[p++] = c;
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  g.setIndex(new THREE.BufferAttribute(idx, 1));
  g.computeVertexNormals();
  grass.map.anisotropy = maxAniso;
  const m = new THREE.MeshStandardMaterial({
    map: grass.map, normalMap: grass.normalMap, normalScale: new THREE.Vector2(0.7, 0.7),
    roughness: 0.96, metalness: 0,
  });
  // Break up the tiling: large-scale patches of lush and dry grass, detail that
  // fades to its mean colour with distance, and darker woodland on the hills.
  const macro = macroNoiseTexture();
  const mean = grass.mean ?? [0.1, 0.16, 0.05];
  m.onBeforeCompile = (shader) => {
    shader.uniforms.uMacro = { value: macro };
    shader.uniforms.uMean = { value: new THREE.Vector3(mean[0], mean[1], mean[2]) };
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vWPos;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\n  vWPos = (modelMatrix * vec4(transformed, 1.0)).xyz;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vWPos;\nuniform sampler2D uMacro;\nuniform vec3 uMean;')
      .replace('#include <map_fragment>', `#include <map_fragment>
  {
    vec2 wp = vWPos.xz;
    float n1 = texture2D(uMacro, wp / 330.0).r;
    float n2 = texture2D(uMacro, wp / 83.0 + 0.37).g;
    float n3 = texture2D(uMacro, wp / 21.0 + 0.11).b;
    float n4 = texture2D(uMacro, wp / 5.3 + 0.53).r;
    float dist = length(vWPos - cameraPosition);
    float fade = smoothstep(20.0, 150.0, dist);
    vec3 base = mix(diffuseColor.rgb, uMean, fade * 0.9);
    float dry = smoothstep(0.40, 0.66, n1 * 0.5 + n2 * 0.5);
    vec3 c = mix(base * vec3(0.74, 0.9, 0.74), base * vec3(1.5, 1.22, 0.72), dry);
    c *= (0.72 + 0.56 * n3) * (0.88 + 0.24 * n4);
    float hill = smoothstep(3.0, 30.0, vWPos.y);
    float wood = hill * smoothstep(0.36, 0.56, n2 * 0.55 + n3 * 0.45);
    vec3 forest = vec3(0.028, 0.055, 0.02) * (0.55 + 0.9 * n3) * (0.8 + 0.4 * n4);
    c = mix(c, forest, wood * 0.9);
    float rock = smoothstep(120.0, 210.0, vWPos.y + 60.0 * n2);
    c = mix(c, vec3(0.2, 0.19, 0.17) * (0.7 + 0.6 * n4), rock * 0.75);
    diffuseColor.rgb = c;
  }`);
  };
  const mesh = new THREE.Mesh(g, m);
  mesh.receiveShadow = true;
  mesh.name = 'terrain';
  return mesh;
}

function buildTrees(trees: TreeDef[], group: THREE.Group): void {
  const trunks = new GeoBuilder();
  const cores = new GeoBuilder();
  const cards: Record<'broadleaf' | 'pine', GeoBuilder> = { broadleaf: new GeoBuilder(), pine: new GeoBuilder() };
  const bark = barkTexture();
  const ico = new THREE.IcosahedronGeometry(1, 1);
  const icoPos = ico.getAttribute('position');

  const addCard = (gb: GeoBuilder, cx: number, cy: number, cz: number, size: number, rnd: () => number, nx: number, ny: number, nz: number, r: number, g: number, b: number) => {
    // Random orientation for the quad.
    const a = rnd() * Math.PI * 2, e = (rnd() - 0.5) * 1.6;
    const ux = Math.cos(a) * Math.cos(e), uy = Math.sin(e), uz = Math.sin(a) * Math.cos(e);
    const b0 = rnd() * Math.PI * 2;
    // v = any vector perpendicular to u
    let vx = Math.cos(b0), vy = Math.sin(b0) * 0.8 + 0.2, vz = Math.sin(b0 + 1.3);
    const d = vx * ux + vy * uy + vz * uz;
    vx -= d * ux; vy -= d * uy; vz -= d * uz;
    const vl = Math.hypot(vx, vy, vz) || 1;
    vx /= vl; vy /= vl; vz /= vl;
    const cell = Math.floor(rnd() * 4);
    const u0 = (cell % 2) * 0.5, v0 = Math.floor(cell / 2) * 0.5;
    const h = size / 2;
    const i0 = gb.vertex(cx - ux * h - vx * h, cy - uy * h - vy * h, cz - uz * h - vz * h, nx, ny, nz, u0, v0, r, g, b);
    const i1 = gb.vertex(cx + ux * h - vx * h, cy + uy * h - vy * h, cz + uz * h - vz * h, nx, ny, nz, u0 + 0.5, v0, r, g, b);
    const i2 = gb.vertex(cx + ux * h + vx * h, cy + uy * h + vy * h, cz + uz * h + vz * h, nx, ny, nz, u0 + 0.5, v0 + 0.5, r, g, b);
    const i3 = gb.vertex(cx - ux * h + vx * h, cy - uy * h + vy * h, cz - uz * h + vz * h, nx, ny, nz, u0, v0 + 0.5, r, g, b);
    gb.quad(i0, i1, i2, i3);
  };

  trees.forEach((t, index) => {
    const rnd = rngFrom(t.seed);
    const near = Math.hypot(t.x, t.z) < 200;
    // Per-tree tint.
    const tr = 0.72 + rnd() * 0.4, tg = 0.74 + rnd() * 0.3, tb = 0.62 + rnd() * 0.3;
    if (t.kind === 'broadleaf') {
      const cyc = t.y + t.height - t.canopyR;
      const trunkH = t.height - t.canopyR * 1.15;
      addCylinder(trunks, t.x, t.y - 0.3, t.z, t.trunkR * 1.25, t.trunkR * 0.6, trunkH + 0.3, near ? 10 : 6, bark.tile, false);
      // A few limbs reaching into the crown.
      if (near) {
        for (let k = 0; k < 4; k++) {
          const a = rnd() * Math.PI * 2;
          const len = t.canopyR * 0.8;
          const bx = t.x + Math.cos(a) * len * 0.35, bz = t.z + Math.sin(a) * len * 0.35;
          addCylinder(trunks, bx, t.y + trunkH * (0.72 + 0.08 * k), bz, t.trunkR * 0.3, t.trunkR * 0.12, len, 5, bark.tile, false);
        }
      }
      // Dark inner mass so the crown is not see-through.
      const base = cores.pos.length / 3;
      const sxz = t.canopyR * 0.6, sy = t.canopyR * 0.55;
      for (let i = 0; i < icoPos.count; i++) {
        const px = icoPos.getX(i), py = icoPos.getY(i), pz = icoPos.getZ(i);
        const k = 0.82 + 0.3 * hashNoise(px * 2.1 + index, pz * 2.1 + py * 1.7);
        const shade = 0.4 + 0.3 * (py * 0.5 + 0.5);
        cores.vertex(t.x + px * sxz * k, cyc + py * sy * k, t.z + pz * sxz * k, px, py, pz, 0, 0, 0.05 * shade * tr, 0.09 * shade * tg, 0.035 * shade * tb);
      }
      for (let i = 0; i < icoPos.count; i += 3) cores.tri(base + i, base + i + 1, base + i + 2);

      const count = near ? 300 : 48;
      const size = t.canopyR * (near ? 0.58 : 1.05);
      for (let i = 0; i < count; i++) {
        const u = rnd() * 2 - 1, a = rnd() * Math.PI * 2;
        const s = Math.sqrt(1 - u * u);
        const dx = Math.cos(a) * s, dy = u, dz = Math.sin(a) * s;
        const rr = t.canopyR * (0.42 + 0.58 * Math.sqrt(rnd()));
        // Lower and inner leaves sit in shade.
        const light = (0.55 + 0.45 * (dy * 0.5 + 0.5)) * (0.55 + 0.45 * (rr / t.canopyR)) * 1.25;
        let nx = dx, ny = dy + 0.45, nz = dz;
        const nl = Math.hypot(nx, ny, nz);
        nx /= nl; ny /= nl; nz /= nl;
        addCard(cards.broadleaf, t.x + dx * rr, cyc + dy * rr * 0.86, t.z + dz * rr, size * (0.8 + 0.4 * rnd()), rnd, nx, ny, nz, tr * light, tg * light, tb * light);
      }
    } else {
      addCylinder(trunks, t.x, t.y - 0.3, t.z, t.trunkR, t.trunkR * 0.25, t.height * 0.95 + 0.3, near ? 8 : 5, bark.tile, false);
      const h0 = t.height * 0.22;
      // Dark cone core.
      addCylinder(cores, t.x, t.y + h0, t.z, t.canopyR * 0.72, 0, t.height * 0.8, 7, 1, false, 0.05 * tr, 0.1 * tg, 0.055 * tb);
      const count = near ? 150 : 40;
      const size = t.canopyR * (near ? 0.75 : 1.2);
      for (let i = 0; i < count; i++) {
        const f = Math.pow(rnd(), 0.75); // more boughs low down
        const hy = h0 + f * (t.height - h0);
        const rr = t.canopyR * (1 - f) * (0.55 + 0.45 * rnd()) + 0.15;
        const a = rnd() * Math.PI * 2;
        const dx = Math.cos(a), dz = Math.sin(a);
        const light = (0.6 + 0.4 * f) * 1.2;
        let nx = dx, ny = 0.7, nz = dz;
        const nl = Math.hypot(nx, ny, nz);
        nx /= nl; ny /= nl; nz /= nl;
        addCard(cards.pine, t.x + dx * rr, t.y + hy - rr * 0.25, t.z + dz * rr, size * (0.7 + 0.5 * rnd()) * (1 - 0.45 * f), rnd, nx, ny, nz, tr * light, tg * light, tb * light);
      }
    }
  });
  ico.dispose();

  const trunkMesh = new THREE.Mesh(trunks.build(), new THREE.MeshStandardMaterial({ map: bark.map, normalMap: bark.normalMap, roughness: 0.95 }));
  trunkMesh.castShadow = true;
  trunkMesh.receiveShadow = true;
  group.add(trunkMesh);

  const coreMesh = new THREE.Mesh(cores.build(true), new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1 }));
  coreMesh.castShadow = true;
  group.add(coreMesh);

  for (const kind of ['broadleaf', 'pine'] as const) {
    if (cards[kind].idx.length === 0) continue;
    const mat = new THREE.MeshStandardMaterial({
      map: leafAtlas(kind === 'pine'), alphaTest: 0.42, side: THREE.DoubleSide, vertexColors: true, roughness: 0.82, metalness: 0,
    });
    // Leaf cards carry "puffy" normals pointing away from the crown centre; do not
    // flip them on back faces or half of every crown would be lit from the wrong side.
    mat.onBeforeCompile = (shader) => {
      shader.fragmentShader = shader.fragmentShader.replace(
        '#include <normal_fragment_begin>',
        '#include <normal_fragment_begin>\n#ifdef DOUBLE_SIDED\n  normal *= faceDirection;\n#endif\n',
      );
    };
    const mesh = new THREE.Mesh(cards[kind].build(true), mat);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    group.add(mesh);
  }
}

export interface Scenery {
  group: THREE.Group;
  /** Animate wind-driven props. */
  update(time: number, env: Environment): void;
  /** Highlight frame placed on the next gate. */
  gateMarker: THREE.Object3D;
}

export function buildScenery(map: MapData, maxAniso: number): Scenery {
  const group = new THREE.Group();
  group.name = 'scenery';

  group.add(buildTerrain(map, maxAniso));

  /* ---- merged primitives per material ----------------------------------------- */
  const specs = materialSpecs();
  const builders = new Map<MatId, GeoBuilder>();
  const get = (m: MatId) => {
    let b = builders.get(m);
    if (!b) { b = new GeoBuilder(); builders.set(m, b); }
    return b;
  };
  const rnd = rngFrom(4711);
  for (const b of map.boxes) {
    addBox(get(b.mat), map.collision, b.x, b.y, b.z, b.sx, b.sy, b.sz, b.yaw, specs[b.mat].maps.tile, rnd(), 0);
  }
  for (const c of map.cyls) {
    addCylinder(get(c.mat), c.x, c.y, c.z, c.r, c.r, c.h, c.r > 1 ? 40 : 14, specs[c.mat].maps.tile);
  }
  for (const [id, gb] of builders) {
    const s = specs[id];
    s.maps.map.anisotropy = maxAniso;
    const mat = new THREE.MeshStandardMaterial({
      map: s.maps.map, normalMap: s.maps.normalMap ?? null, roughness: s.roughness, metalness: s.metalness, vertexColors: true,
    });
    if (s.maps.normalMap && s.normalScale) mat.normalScale.set(s.normalScale, s.normalScale);
    const mesh = new THREE.Mesh(gb.build(true), mat);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.name = `prims:${id}`;
    group.add(mesh);
  }

  /* ---- ground decals -------------------------------------------------------------- */
  let order = 1;
  for (const d of map.decals) {
    let tex: THREE.Texture;
    let transparent = false;
    if (d.kind === 'pad') tex = padDecal();
    else if (d.kind === 'road') { tex = roadDecal(); tex.repeat.set(d.sx / 8, 1); }
    else if (d.kind === 'lot') tex = lotDecal();
    else { tex = pitchDecal(); transparent = true; }
    tex.anisotropy = maxAniso;
    const mat = new THREE.MeshStandardMaterial({
      map: tex, roughness: 0.95, transparent, depthWrite: false,
      polygonOffset: true, polygonOffsetFactor: -2 - order, polygonOffsetUnits: -2 - order,
    });
    const geo = new THREE.PlaneGeometry(d.sx, d.sz);
    geo.rotateX(-Math.PI / 2);
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.set(d.x, 0.006 * order, d.z);
    mesh.rotation.y = d.yaw;
    mesh.receiveShadow = true;
    mesh.renderOrder = order++;
    group.add(mesh);
  }

  /* ---- trees ------------------------------------------------------------------------ */
  buildTrees(map.trees, group);

  /* ---- flags -------------------------------------------------------------------------- */
  const flagObjs: { pivot: THREE.Group; phase: number }[] = [];
  const poleMat = new THREE.MeshStandardMaterial({ color: 0xe8e8e4, roughness: 0.5, metalness: 0.3 });
  for (const f of map.flags) {
    const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.018, 0.024, f.height, 8), poleMat);
    pole.position.set(f.x, f.height / 2, f.z);
    pole.castShadow = true;
    group.add(pole);
    // Feather banner: a tapered sail hanging off the pole.
    const sail = new THREE.PlaneGeometry(0.75, f.height * 0.72, 3, 10);
    const p = sail.getAttribute('position');
    for (let i = 0; i < p.count; i++) {
      const y = p.getY(i) / (f.height * 0.72) + 0.5; // 0 bottom .. 1 top
      const w = 0.35 + 0.65 * Math.sin(Math.min(1, y * 1.15) * Math.PI * 0.5) * (1 - Math.max(0, y - 0.82) * 4.5);
      const x = (p.getX(i) + 0.375) * Math.max(0.05, w);
      p.setX(i, x);
      p.setZ(i, 0.08 * Math.sin(y * 5 + x * 4));
    }
    sail.computeVertexNormals();
    const banner = new THREE.Mesh(sail, new THREE.MeshStandardMaterial({ color: f.color, roughness: 0.75, side: THREE.DoubleSide }));
    banner.castShadow = true;
    const pivot = new THREE.Group();
    pivot.position.set(f.x, f.height * 0.62, f.z);
    pivot.add(banner);
    group.add(pivot);
    flagObjs.push({ pivot, phase: f.x * 0.37 + f.z * 0.11 });
  }

  /* ---- windsock ------------------------------------------------------------------------ */
  const ws = map.windsock;
  const wsPole = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.04, ws.height, 10), poleMat);
  wsPole.position.set(ws.x, ws.height / 2, ws.z);
  wsPole.castShadow = true;
  group.add(wsPole);
  const sockYaw = new THREE.Group();
  sockYaw.position.set(ws.x, ws.height - 0.15, ws.z);
  const sockPitch = new THREE.Group();
  const sockGeo = new THREE.CylinderGeometry(0.2, 0.09, 1.5, 16, 1, true);
  sockGeo.rotateZ(Math.PI / 2); // axis along X, wide end at -X ... flip below
  sockGeo.translate(0.78, 0, 0);
  const sock = new THREE.Mesh(sockGeo, new THREE.MeshStandardMaterial({ map: sockTexture(), side: THREE.DoubleSide, roughness: 0.8 }));
  sock.castShadow = true;
  sockPitch.add(sock);
  sockYaw.add(sockPitch);
  group.add(sockYaw);

  /* ---- next-gate marker -------------------------------------------------------------- */
  const marker = new THREE.Group();
  const glow = new THREE.MeshBasicMaterial({ color: 0x66ff88, transparent: true, opacity: 0.85, depthWrite: false, fog: false, toneMapped: false });
  const t = 0.07;
  const w = 2.4 + 2 * 0.14 + 0.16, h = 1.8 + 2 * 0.14 + 0.16;
  for (const [x, y, sx, sy] of [[0, h / 2, w + t, t], [0, -h / 2, w + t, t], [-w / 2, 0, t, h], [w / 2, 0, t, h]]) {
    const m = new THREE.Mesh(new THREE.BoxGeometry(sx, sy, 0.2), glow);
    m.position.set(x, y, 0);
    marker.add(m);
  }
  marker.visible = false;
  group.add(marker);

  const windVec = { x: 0, y: 0, z: 0 };
  return {
    group,
    gateMarker: marker,
    update(time: number, env: Environment) {
      // Use the gusty wind at the vehicle as a proxy for local gustiness, scaled to sock height.
      env.meanWindAt(windVec, ws.height);
      const lw = env.lastWind;
      const mean = Math.hypot(windVec.x, windVec.z);
      const gx = windVec.x + (lw.x - windVec.x) * 0.5, gz = windVec.z + (lw.z - windVec.z) * 0.5;
      const sp = mean < 0.05 ? 0 : Math.hypot(gx, gz);
      // Sock: points downwind; fully extended at about 15 knots.
      const yaw = Math.atan2(-gz, gx);
      sockYaw.rotation.y = sp > 0.1 ? yaw : sockYaw.rotation.y;
      const ext = Math.min(1, sp / 7.7);
      sockPitch.rotation.z = -(1 - ext) * 1.35 + Math.sin(time * 6.3) * 0.04 * ext;
      for (const f of flagObjs) {
        const flutter = Math.sin(time * (3 + sp * 0.6) + f.phase) * (0.08 + 0.04 * Math.min(sp, 8));
        f.pivot.rotation.y = (sp > 0.1 ? yaw : 0) + flutter;
      }
    },
  };
}

