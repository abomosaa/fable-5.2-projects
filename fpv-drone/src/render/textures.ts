/**
 * Procedural textures. Everything is generated at start-up on 2D canvases so
 * the simulator ships no binary assets and works offline.
 */
import * as THREE from 'three';

function makeRng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Tileable value noise on a lattice of `period` cells. */
function tileNoise(seed: number, period: number): (x: number, y: number) => number {
  const rnd = makeRng(seed);
  const g = new Float32Array(period * period);
  for (let i = 0; i < g.length; i++) g[i] = rnd();
  return (x: number, y: number) => {
    const xi = Math.floor(x), yi = Math.floor(y);
    const fx = x - xi, fy = y - yi;
    const ux = fx * fx * (3 - 2 * fx), uy = fy * fy * (3 - 2 * fy);
    const x0 = ((xi % period) + period) % period, x1 = (x0 + 1) % period;
    const y0 = ((yi % period) + period) % period, y1 = (y0 + 1) % period;
    const a = g[y0 * period + x0], b = g[y0 * period + x1], c = g[y1 * period + x0], d = g[y1 * period + x1];
    return a + (b - a) * ux + (c - a) * uy + (a - b - c + d) * ux * uy;
  };
}

/** Tileable fBm in [0,1]; u,v in [0,1). */
function tileFbm(seed: number, base: number, octaves: number): (u: number, v: number) => number {
  const layers: ((x: number, y: number) => number)[] = [];
  for (let o = 0; o < octaves; o++) layers.push(tileNoise(seed + o * 101, base << o));
  return (u: number, v: number) => {
    let sum = 0, amp = 0.5, norm = 0;
    for (let o = 0; o < octaves; o++) {
      const p = base << o;
      sum += amp * layers[o](u * p, v * p);
      norm += amp;
      amp *= 0.5;
    }
    return sum / norm;
  };
}

function canvas(size: number, h = size): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const c = document.createElement('canvas');
  c.width = size;
  c.height = h;
  return [c, c.getContext('2d', { willReadFrequently: true })!];
}

function finish(c: HTMLCanvasElement, srgb: boolean, repeat = true): THREE.CanvasTexture {
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  if (repeat) t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = 8;
  t.generateMipmaps = true;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.needsUpdate = true;
  return t;
}

/** Fill a canvas per pixel from a function returning [r,g,b] in 0..255. */
function fillPixels(ctx: CanvasRenderingContext2D, size: number, fn: (u: number, v: number, out: number[]) => void): void {
  const img = ctx.createImageData(size, size);
  const d = img.data;
  const px = [0, 0, 0, 255];
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      px[3] = 255;
      fn(x / size, y / size, px);
      const i = (y * size + x) * 4;
      d[i] = px[0]; d[i + 1] = px[1]; d[i + 2] = px[2]; d[i + 3] = px[3];
    }
  }
  ctx.putImageData(img, 0, 0);
}

/** Tangent-space normal map from a tileable height function. */
function normalMap(size: number, height: (u: number, v: number) => number, strength: number): THREE.CanvasTexture {
  const [c, ctx] = canvas(size);
  const h = new Float32Array(size * size);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) h[y * size + x] = height(x / size, y / size);
  const img = ctx.createImageData(size, size);
  const d = img.data;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const xl = h[y * size + ((x + size - 1) % size)], xr = h[y * size + ((x + 1) % size)];
      const yu = h[((y + size - 1) % size) * size + x], yd = h[((y + 1) % size) * size + x];
      let nx = (xl - xr) * strength, ny = (yd - yu) * strength;
      const inv = 1 / Math.sqrt(nx * nx + ny * ny + 1);
      nx *= inv; ny *= inv;
      const i = (y * size + x) * 4;
      d[i] = (nx * 0.5 + 0.5) * 255;
      d[i + 1] = (ny * 0.5 + 0.5) * 255;
      d[i + 2] = inv * 0.5 * 255 + 127.5;
      d[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  return finish(c, false);
}

export interface PbrMaps {
  map: THREE.Texture;
  normalMap?: THREE.Texture;
  roughnessMap?: THREE.Texture;
  /** Edge length in metres that one repeat of the texture covers. */
  tile: number;
  /** Mean linear colour of `map`, where needed. */
  mean?: number[];
}

/** Three independent channels of tileable low-frequency noise for macro variation. */
export function macroNoiseTexture(): THREE.CanvasTexture {
  const size = 256;
  const [c, ctx] = canvas(size);
  const a = tileFbm(901, 4, 5), b = tileFbm(902, 4, 5), d = tileFbm(903, 8, 4);
  fillPixels(ctx, size, (u, v, o) => {
    o[0] = a(u, v) * 255; o[1] = b(u, v) * 255; o[2] = d(u, v) * 255;
  });
  const t = finish(c, false);
  t.anisotropy = 2;
  return t;
}

/* -------------------------------------------------------------------------- grass */

export function grassTexture(): PbrMaps {
  const size = 1024;
  const [c, ctx] = canvas(size);
  const n1 = tileFbm(11, 4, 5), n2 = tileFbm(29, 16, 3);
  fillPixels(ctx, size, (u, v, o) => {
    const a = n1(u, v), b = n2(u, v);
    // Mix of fresh green, darker green and dry straw.
    const dry = Math.max(0, a - 0.55) * 1.6;
    o[0] = 66 + 40 * b + 60 * dry + 16 * a;
    o[1] = 84 + 40 * b + 30 * dry + 16 * a;
    o[2] = 36 + 20 * b + 6 * dry;
  });
  // Individual blades: short strokes, wrapped at the borders so the texture tiles.
  const rnd = makeRng(77);
  ctx.lineCap = 'round';
  for (let i = 0; i < 42000; i++) {
    const x = rnd() * size, y = rnd() * size;
    const len = 4 + rnd() * 9;
    const ang = -Math.PI / 2 + (rnd() - 0.5) * 1.5;
    const k = rnd();
    const straw = rnd() < 0.16 ? 55 : 0;
    const r = 50 + k * 78 + straw, g = 74 + k * 78 + straw * 0.5, b = 28 + k * 34;
    ctx.strokeStyle = `rgba(${r | 0},${g | 0},${b | 0},${0.35 + rnd() * 0.5})`;
    ctx.lineWidth = 0.7 + rnd() * 1.1;
    const dx = Math.cos(ang) * len, dy = Math.sin(ang) * len;
    for (const ox of [0, -size, size]) {
      for (const oy of [0, -size, size]) {
        if (x + ox < -16 || x + ox > size + 16 || y + oy < -16 || y + oy > size + 16) continue;
        ctx.beginPath();
        ctx.moveTo(x + ox, y + oy);
        ctx.lineTo(x + ox + dx, y + oy + dy);
        ctx.stroke();
      }
    }
  }
  const bump = tileFbm(301, 32, 4);
  // Mean colour (linear), used to fade the tiling detail out with distance.
  const px = ctx.getImageData(0, 0, size, size).data;
  const mean = [0, 0, 0];
  const lin = (v: number) => Math.pow(v / 255, 2.2);
  for (let i = 0; i < px.length; i += 16) { mean[0] += lin(px[i]); mean[1] += lin(px[i + 1]); mean[2] += lin(px[i + 2]); }
  const n = px.length / 16;
  return { map: finish(c, true), normalMap: normalMap(512, bump, 5), tile: 3.2, mean: [mean[0] / n, mean[1] / n, mean[2] / n] };
}

/* ----------------------------------------------------------------------- concrete */

export function concreteTexture(dark: boolean): PbrMaps {
  const size = 512;
  const [c, ctx] = canvas(size);
  const n1 = tileFbm(dark ? 5 : 3, 3, 6), n2 = tileFbm(41, 64, 2), n3 = tileFbm(17, 2, 4);
  const base = dark ? 82 : 124;
  fillPixels(ctx, size, (u, v, o) => {
    const stain = n1(u, v), grit = n2(u, v), big = n3(u, v);
    const l = base + (stain - 0.5) * 70 + (grit - 0.5) * 34 - Math.max(0, big - 0.58) * 150;
    o[0] = l * 1.02; o[1] = l * 0.99; o[2] = l * 0.93;
  });
  const rnd = makeRng(9);
  // Water streaks running down.
  for (let i = 0; i < 26; i++) {
    const x = rnd() * size, w = 3 + rnd() * 14, len = size * (0.2 + rnd() * 0.6);
    const g = ctx.createLinearGradient(0, 0, 0, len);
    g.addColorStop(0, `rgba(30,28,24,${0.10 + rnd() * 0.16})`);
    g.addColorStop(1, 'rgba(30,28,24,0)');
    ctx.fillStyle = g;
    ctx.fillRect(x, 0, w, len);
  }
  // Formwork joints and hairline cracks.
  ctx.strokeStyle = 'rgba(25,25,25,0.35)';
  ctx.lineWidth = 1.2;
  for (const y of [0.5, size / 2 + 0.5]) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(size, y); ctx.stroke(); }
  ctx.strokeStyle = 'rgba(20,20,20,0.45)';
  ctx.lineWidth = 0.8;
  for (let i = 0; i < 7; i++) {
    let x = rnd() * size, y = rnd() * size;
    ctx.beginPath();
    ctx.moveTo(x, y);
    for (let k = 0; k < 14; k++) {
      x += (rnd() - 0.5) * 30; y += rnd() * 22;
      ctx.lineTo(x, y);
    }
    ctx.stroke();
  }
  const bump = tileFbm(88, 24, 4);
  return { map: finish(c, true), normalMap: normalMap(256, bump, 2.2), tile: 3.0 };
}

/* ------------------------------------------------------------------------ asphalt */

export function asphaltTexture(): PbrMaps {
  const size = 512;
  const [c, ctx] = canvas(size);
  const n1 = tileFbm(7, 4, 5);
  const rnd = makeRng(123);
  fillPixels(ctx, size, (u, v, o) => {
    const l = 52 + (n1(u, v) - 0.5) * 30 + (rnd() - 0.5) * 34;
    o[0] = l; o[1] = l; o[2] = l * 1.04;
  });
  for (let i = 0; i < 3500; i++) {
    const l = 90 + rnd() * 80;
    ctx.fillStyle = `rgba(${l | 0},${l | 0},${(l * 0.97) | 0},0.5)`;
    ctx.fillRect(rnd() * size, rnd() * size, 1 + rnd() * 1.6, 1 + rnd() * 1.6);
  }
  const bump = tileFbm(64, 64, 3);
  return { map: finish(c, true), normalMap: normalMap(256, bump, 3), tile: 2.5 };
}

/* ------------------------------------------------------- corrugated painted steel */

export function corrugatedTexture(r: number, g: number, b: number, rust: number, seed: number): PbrMaps {
  const size = 512;
  const [c, ctx] = canvas(size);
  const n1 = tileFbm(seed, 4, 5), n2 = tileFbm(seed + 9, 32, 3);
  const ribs = 8; // ribs per tile
  fillPixels(ctx, size, (u, v, o) => {
    const dirt = n1(u, v), fine = n2(u, v);
    // Painted-in shading of the ribs helps at distances where the normal map mips out.
    const rib = 0.5 + 0.5 * Math.cos(u * ribs * Math.PI * 2);
    let k = 0.93 + 0.07 * rib + (fine - 0.5) * 0.12;
    // Grime gathers towards the bottom of each panel.
    k *= 1 - 0.25 * Math.max(0, dirt - 0.45) - 0.18 * v * v;
    let rr = r * k, gg = g * k, bb = b * k;
    const ru = Math.max(0, n1(u * 1.0 + 0.37, v) * 1.6 - (1.25 - rust)) * (0.6 + 0.4 * fine);
    if (ru > 0) {
      const t = Math.min(1, ru * 2.2);
      rr = rr * (1 - t) + 118 * t; gg = gg * (1 - t) + 62 * t; bb = bb * (1 - t) + 30 * t;
    }
    o[0] = rr; o[1] = gg; o[2] = bb;
  });
  const nrm = normalMap(256, (u) => 0.5 + 0.5 * Math.cos(u * ribs * Math.PI * 2), 3.2);
  return { map: finish(c, true), normalMap: nrm, tile: 2.0 };
}

/* --------------------------------------------------------------------------- wood */

export function woodTexture(dark: boolean): PbrMaps {
  const size = 256;
  const [c, ctx] = canvas(size);
  const n1 = tileFbm(dark ? 51 : 50, 2, 5);
  fillPixels(ctx, size, (u, v, o) => {
    // Grain: noise stretched along v.
    const g = n1(u * 6, v * 0.35);
    const l = (dark ? 0.55 : 1) * (0.75 + 0.5 * g);
    o[0] = 150 * l; o[1] = 112 * l; o[2] = 74 * l;
  });
  return { map: finish(c, true), tile: 1.2 };
}

/* ------------------------------------------------------------------- plain metals */

export function speckleTexture(r: number, g: number, b: number, contrast: number, seed: number): PbrMaps {
  const size = 256;
  const [c, ctx] = canvas(size);
  const n1 = tileFbm(seed, 8, 5), n2 = tileFbm(seed + 5, 64, 2);
  fillPixels(ctx, size, (u, v, o) => {
    const k = 1 + ((n1(u, v) - 0.5) * 1.4 + (n2(u, v) - 0.5) * 0.6) * contrast;
    o[0] = r * k; o[1] = g * k; o[2] = b * k;
  });
  return { map: finish(c, true), tile: 1.5 };
}

/** Two-colour checker (padded race-gate sleeves), slightly weathered. */
export function checkerTexture(a: [number, number, number], b: [number, number, number], seed: number): PbrMaps {
  const size = 256;
  const [c, ctx] = canvas(size);
  const n1 = tileFbm(seed, 8, 4);
  fillPixels(ctx, size, (u, v, o) => {
    const k = (Math.floor(u * 2) + Math.floor(v * 2)) % 2 === 0 ? a : b;
    const d = 0.88 + 0.24 * n1(u, v);
    o[0] = k[0] * d; o[1] = k[1] * d; o[2] = k[2] * d;
  });
  return { map: finish(c, true), tile: 0.7 };
}

/* --------------------------------------------------------------------------- bark */

export function barkTexture(): PbrMaps {
  const size = 256;
  const [c, ctx] = canvas(size);
  const n1 = tileFbm(71, 4, 5);
  fillPixels(ctx, size, (u, v, o) => {
    const ridges = n1(u * 5, v * 0.6);
    const l = 0.55 + 0.9 * Math.abs(ridges - 0.5);
    o[0] = 92 * l; o[1] = 76 * l; o[2] = 60 * l;
  });
  const h = tileFbm(72, 4, 4);
  return { map: finish(c, true), normalMap: normalMap(256, (u, v) => Math.abs(h(u * 5, v * 0.6) - 0.5) * 2, 6), tile: 1.6 };
}

/* ---------------------------------------------------------------------- foliage */

/** 2 x 2 atlas of alpha-tested leaf clusters. */
export function leafAtlas(pine: boolean): THREE.CanvasTexture {
  const size = 512;
  const [c, ctx] = canvas(size);
  const rnd = makeRng(pine ? 404 : 303);
  const cell = size / 2;
  for (let cy = 0; cy < 2; cy++) {
    for (let cx = 0; cx < 2; cx++) {
      const ox = cx * cell + cell / 2, oy = cy * cell + cell / 2;
      ctx.save();
      // Keep a margin so mipmaps do not bleed across cells.
      ctx.beginPath();
      ctx.rect(cx * cell + 6, cy * cell + 6, cell - 12, cell - 12);
      ctx.clip();
      if (pine) {
        // Sprays of needles along a few twigs.
        for (let t = 0; t < 7; t++) {
          const a0 = rnd() * Math.PI * 2;
          const len = cell * (0.28 + rnd() * 0.16);
          for (let s = 0; s < 26; s++) {
            const f = s / 26;
            const px = ox + Math.cos(a0) * len * f, py = oy + Math.sin(a0) * len * f;
            for (const side of [-1, 1]) {
              const a = a0 + side * (0.6 + rnd() * 0.5);
              const nl = cell * (0.07 + rnd() * 0.05) * (1 - f * 0.5);
              const k = rnd();
              ctx.strokeStyle = `rgb(${(26 + k * 34) | 0},${(58 + k * 50) | 0},${(30 + k * 26) | 0})`;
              ctx.lineWidth = 2.2;
              ctx.beginPath();
              ctx.moveTo(px, py);
              ctx.lineTo(px + Math.cos(a) * nl, py + Math.sin(a) * nl);
              ctx.stroke();
            }
          }
        }
      } else {
        for (let i = 0; i < 95; i++) {
          const a = rnd() * Math.PI * 2;
          const rr = Math.sqrt(rnd()) * cell * 0.4;
          const px = ox + Math.cos(a) * rr, py = oy + Math.sin(a) * rr;
          const k = rnd();
          const light = i > 60 ? 1.25 : 0.85; // later leaves sit on top and catch more light
          ctx.fillStyle = `rgb(${((40 + k * 38) * light) | 0},${((66 + k * 44) * light) | 0},${((24 + k * 22) * light) | 0})`;
          ctx.save();
          ctx.translate(px, py);
          ctx.rotate(rnd() * Math.PI * 2);
          const l = cell * (0.055 + rnd() * 0.035), w = l * 0.52;
          ctx.beginPath();
          ctx.moveTo(-l, 0);
          ctx.quadraticCurveTo(0, -w, l, 0);
          ctx.quadraticCurveTo(0, w, -l, 0);
          ctx.fill();
          ctx.restore();
        }
      }
      ctx.restore();
    }
  }
  const t = finish(c, true, false);
  t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
  t.anisotropy = 4;
  return t;
}

/* ------------------------------------------------------------------------- decals */

export function padDecal(): THREE.CanvasTexture {
  const size = 512;
  const [c, ctx] = canvas(size);
  const n1 = tileFbm(3, 3, 6), n2 = tileFbm(41, 64, 2);
  fillPixels(ctx, size, (u, v, o) => {
    const l = 150 + (n1(u, v) - 0.5) * 60 + (n2(u, v) - 0.5) * 30;
    o[0] = l; o[1] = l * 0.985; o[2] = l * 0.95;
  });
  ctx.strokeStyle = 'rgba(235,190,40,0.85)';
  ctx.lineWidth = 16;
  ctx.strokeRect(22, 22, size - 44, size - 44);
  ctx.beginPath();
  ctx.arc(size / 2, size / 2, 130, 0, Math.PI * 2);
  ctx.stroke();
  // "H" with the bar; the open side of the pad faces north.
  ctx.fillStyle = 'rgba(235,190,40,0.85)';
  ctx.fillRect(size / 2 - 70, size / 2 - 80, 22, 160);
  ctx.fillRect(size / 2 + 48, size / 2 - 80, 22, 160);
  ctx.fillRect(size / 2 - 70, size / 2 - 11, 140, 22);
  return finish(c, true, false);
}

export function roadDecal(): THREE.CanvasTexture {
  // One 8 m segment of two-lane road, repeated along its length.
  const w = 256, h = 256;
  const [c, ctx] = canvas(w, h);
  const rnd = makeRng(5);
  const img = ctx.createImageData(w, h);
  for (let i = 0; i < w * h; i++) {
    const l = 50 + (rnd() - 0.5) * 30;
    img.data[i * 4] = l; img.data[i * 4 + 1] = l; img.data[i * 4 + 2] = l * 1.04; img.data[i * 4 + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  ctx.fillStyle = 'rgba(232,232,225,0.85)';
  ctx.fillRect(0, 8, w, 6); // edge lines
  ctx.fillRect(0, h - 14, w, 6);
  ctx.fillRect(40, h / 2 - 3, 110, 6); // centre dash
  const t = finish(c, true);
  return t;
}

export function lotDecal(): THREE.CanvasTexture {
  const w = 1024, h = 512;
  const [c, ctx] = canvas(w, h);
  const rnd = makeRng(6);
  const img = ctx.createImageData(w, h);
  for (let i = 0; i < w * h; i++) {
    const l = 58 + (rnd() - 0.5) * 30;
    img.data[i * 4] = l; img.data[i * 4 + 1] = l; img.data[i * 4 + 2] = l * 1.03; img.data[i * 4 + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  ctx.fillStyle = 'rgba(232,232,225,0.8)';
  for (let x = 40; x < w; x += 86) ctx.fillRect(x, 0, 5, 200); // bays
  ctx.fillRect(0, 196, w, 5);
  return finish(c, true, false);
}

export function pitchDecal(): THREE.CanvasTexture {
  // 64 x 100 m pitch at 16 px / m; transparent except for mowing stripes and lines.
  const w = 1024, h = 1600;
  const [c, ctx] = canvas(w, h);
  const s = 16;
  for (let i = 0; i < 10; i++) {
    if (i % 2 === 0) continue;
    ctx.fillStyle = 'rgba(8,30,4,0.16)';
    ctx.fillRect(0, i * (h / 10), w, h / 10);
  }
  ctx.strokeStyle = 'rgba(240,240,232,0.9)';
  ctx.lineWidth = 2.2;
  const m = 8;
  ctx.strokeRect(m, m, w - 2 * m, h - 2 * m);
  ctx.beginPath(); ctx.moveTo(m, h / 2); ctx.lineTo(w - m, h / 2); ctx.stroke();
  ctx.beginPath(); ctx.arc(w / 2, h / 2, 9.15 * s, 0, Math.PI * 2); ctx.stroke();
  for (const e of [0, 1]) {
    const y0 = e === 0 ? m : h - m;
    const d = e === 0 ? 1 : -1;
    ctx.strokeRect(w / 2 - 20.16 * s, Math.min(y0, y0 + d * 16.5 * s), 40.32 * s, 16.5 * s);
    ctx.strokeRect(w / 2 - 9.16 * s, Math.min(y0, y0 + d * 5.5 * s), 18.32 * s, 5.5 * s);
    ctx.beginPath(); ctx.arc(w / 2, y0 + d * 11 * s, 2, 0, Math.PI * 2); ctx.stroke();
  }
  const t = finish(c, true, false);
  return t;
}

/** Soft round blob used for the drone's contact shadow. */
export function blobTexture(): THREE.CanvasTexture {
  const [c, ctx] = canvas(128);
  const g = ctx.createRadialGradient(64, 64, 4, 64, 64, 62);
  g.addColorStop(0, 'rgba(0,0,0,0.75)');
  g.addColorStop(0.5, 'rgba(0,0,0,0.42)');
  g.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 128, 128);
  return finish(c, true, false);
}

/** Windsock stripes. */
export function sockTexture(): THREE.CanvasTexture {
  const [c, ctx] = canvas(64, 256);
  for (let i = 0; i < 5; i++) {
    ctx.fillStyle = i % 2 === 0 ? '#e8591c' : '#f1f1ee';
    ctx.fillRect(0, i * 51.2, 64, 52);
  }
  return finish(c, true, false);
}
