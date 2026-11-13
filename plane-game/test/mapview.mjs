// Render a top-down preview of the terrain to PNG (dev tool).
import zlib from 'node:zlib';
import fs from 'node:fs';
import { terrainHeight, AIRPORTS, WORLD_HALF, rawHeight } from '../src/world/heightfield.js';
const size = +(process.argv[2] || 768), half = +(process.argv[3] || WORLD_HALF), cx = +(process.argv[4] || 0), cz = +(process.argv[5] || 0);
const out = process.argv[6] || '/tmp/fs-shots/map.png';
const px = new Uint8Array(size * size * 3);
const H = new Float32Array(size * size);
const t0 = performance.now();
let maxH = -1e9, landCount = 0;
for (let j = 0; j < size; j++) for (let i = 0; i < size; i++) {
  // image: up = north (+X), right = east (+Z)
  const x = cx + half - (j + 0.5) * 2 * half / size, z = cz - half + (i + 0.5) * 2 * half / size;
  const h = terrainHeight(x, z); H[j * size + i] = h; if (h > maxH) maxH = h; if (h > 0) landCount++;
}
const ramp = [[-300, [10, 30, 70]], [-30, [20, 70, 130]], [-1, [60, 130, 170]], [0, [210, 200, 150]], [4, [120, 160, 80]], [150, [80, 130, 60]], [500, [100, 120, 70]], [1100, [120, 110, 90]], [1800, [150, 145, 140]], [2300, [245, 245, 250]], [4000, [255, 255, 255]]];
const col = (h) => { for (let k = 1; k < ramp.length; k++) if (h <= ramp[k][0]) { const a = ramp[k - 1], b = ramp[k], t = (h - a[0]) / (b[0] - a[0]); return a[1].map((c, n) => c + (b[1][n] - c) * Math.max(0, Math.min(1, t))); } return [255, 255, 255]; };
const cell = 2 * half / size;
for (let j = 0; j < size; j++) for (let i = 0; i < size; i++) {
  const h = H[j * size + i];
  const hx = H[j * size + Math.min(size - 1, i + 1)] - H[j * size + Math.max(0, i - 1)];
  const hy = H[Math.min(size - 1, j + 1) * size + i] - H[Math.max(0, j - 1) * size + i];
  let shade = 1;
  if (h > 0) { const nx = -hx / (2 * cell), ny = -hy / (2 * cell); shade = Math.max(0.35, Math.min(1.5, 1 + 2.2 * (nx * -0.7 + ny * -0.7))); }
  const c = col(h);
  px[(j * size + i) * 3] = Math.min(255, c[0] * shade); px[(j * size + i) * 3 + 1] = Math.min(255, c[1] * shade); px[(j * size + i) * 3 + 2] = Math.min(255, c[2] * shade);
}
for (const a of AIRPORTS) {
  for (let t = -1; t <= 1; t += 0.01) {
    const x = a.x + a.dirX * a.length / 2 * t, z = a.z + a.dirZ * a.length / 2 * t;
    const i = Math.round((z - cz + half) / (2 * half) * size), j = Math.round((cx + half - x) / (2 * half) * size);
    for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) { const ii = i + di, jj = j + dj; if (ii >= 0 && jj >= 0 && ii < size && jj < size) { px[(jj * size + ii) * 3] = 255; px[(jj * size + ii) * 3 + 1] = 0; px[(jj * size + ii) * 3 + 2] = 255; } }
  }
  console.log(a.id, 'elev', a.elevation, 'raw@center', rawHeight(a.x, a.z).toFixed(0), 'ends', terrainHeight(a.x + a.dirX * 6000, a.z + a.dirZ * 6000).toFixed(0), terrainHeight(a.x - a.dirX * 6000, a.z - a.dirZ * 6000).toFixed(0));
}
// PNG encode
const crcT = new Uint32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc = (b) => { let c = 0xffffffff; for (const v of b) c = crcT[(c ^ v) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]); const cr = Buffer.alloc(4); cr.writeUInt32BE(crc(td)); return Buffer.concat([len, td, cr]); };
const raw = Buffer.alloc(size * (size * 3 + 1));
for (let j = 0; j < size; j++) { raw[j * (size * 3 + 1)] = 0; Buffer.from(px.buffer, j * size * 3, size * 3).copy(raw, j * (size * 3 + 1) + 1); }
const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4); ihdr[8] = 8; ihdr[9] = 2;
fs.writeFileSync(out, Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]));
console.log('maxH', maxH.toFixed(0), 'land %', (100 * landCount / size / size).toFixed(1), 'ms', (performance.now() - t0).toFixed(0), 'per eval us', ((performance.now() - t0) * 1000 / size / size).toFixed(2));
