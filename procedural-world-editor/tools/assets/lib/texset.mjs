// Tileable PBR texture sets: raw 2K PNG maps -> public/assets/textures/<id>/{diff,nor,arm,disp}.jpg
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import sharp from 'sharp';

export const TEX_SIZE = 2048;
export const DISP_SIZE = 1024;
// mozjpeg; normals/ARM keep full chroma so the channels do not bleed into each other
const Q = { diff: { quality: 90, mozjpeg: true, chromaSubsampling: '4:2:0' }, nor: { quality: 84, mozjpeg: true, chromaSubsampling: '4:4:4' }, arm: { quality: 80, mozjpeg: true, chromaSubsampling: '4:4:4' }, disp: { quality: 90, mozjpeg: true } };

/**
 * Tileability check: mean abs difference across the wrap seam relative to the 95th percentile of the differences
 * between adjacent interior rows/columns (structured materials such as planks or slates have strong interior edges).
 * <= ~1 means the seam is no worse than ordinary texture detail.
 */
function seamScore(raw, w, h, ch) {
  const c3 = Math.min(ch, 3);
  const rowDiff = (y0, y1) => { let s = 0; for (let x = 0; x < w; x++) for (let c = 0; c < c3; c++) s += Math.abs(raw[(y0 * w + x) * ch + c] - raw[(y1 * w + x) * ch + c]); return s / (w * c3); };
  const colDiff = (x0, x1) => { let s = 0; for (let y = 0; y < h; y++) for (let c = 0; c < c3; c++) s += Math.abs(raw[(y * w + x0) * ch + c] - raw[(y * w + x1) * ch + c]); return s / (h * c3); };
  const rows = [], cols = [];
  for (let y = 1; y < h; y++) rows.push(rowDiff(y - 1, y));
  for (let x = 1; x < w; x++) cols.push(colDiff(x - 1, x));
  rows.sort((a, b) => a - b); cols.sort((a, b) => a - b);
  const p95 = (a) => a[Math.floor(a.length * 0.95)] + 1e-6;
  return Math.max(rowDiff(h - 1, 0) / p95(rows), colDiff(w - 1, 0) / p95(cols));
}

/**
 * Read the pinned members of a (stored/deflated) zip archive without unpacking anything to disk.
 * Only names listed in `wanted` are ever decompressed.
 */
function readZipMembers(zip, wanted) {
  let eocd = zip.length - 22;
  while (eocd >= 0 && zip.readUInt32LE(eocd) !== 0x06054b50) eocd--;
  if (eocd < 0) throw new Error('not a zip archive');
  const count = zip.readUInt16LE(eocd + 10);
  let p = zip.readUInt32LE(eocd + 16);
  const out = {};
  for (let i = 0; i < count; i++) {
    if (zip.readUInt32LE(p) !== 0x02014b50) throw new Error('corrupt zip central directory');
    const method = zip.readUInt16LE(p + 10), csize = zip.readUInt32LE(p + 20), usize = zip.readUInt32LE(p + 24);
    const nameLen = zip.readUInt16LE(p + 28), extraLen = zip.readUInt16LE(p + 30), commentLen = zip.readUInt16LE(p + 32), local = zip.readUInt32LE(p + 42);
    const name = zip.toString('utf8', p + 46, p + 46 + nameLen);
    if (wanted.includes(name)) {
      if (usize > 256 * 1024 * 1024) throw new Error(`zip member ${name} is implausibly large`);
      const dataStart = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28);
      const data = zip.subarray(dataStart, dataStart + csize);
      out[name] = method === 0 ? Buffer.from(data) : method === 8 ? zlib.inflateRawSync(data, { maxOutputLength: usize + 1 }) : (() => { throw new Error(`zip method ${method} unsupported`); })();
    }
    p += 46 + nameLen + extraLen + commentLen;
  }
  for (const n of wanted) if (!out[n]) throw new Error(`zip member ${n} missing`);
  return out;
}

/** Resolve the source maps as sharp inputs (file paths, or buffers read from a pinned zip for ambientCG). */
function sourceMaps(srcDir, src) {
  if (src.provider === 'ambientcg') {
    const got = readZipMembers(fs.readFileSync(path.join(srcDir, src.files[0].path)), Object.values(src.zipMembers));
    return Object.fromEntries(Object.entries(src.zipMembers).map(([role, name]) => [role, got[name]]));
  }
  return Object.fromEntries(src.files.map((f) => [f.role, path.join(srcDir, f.path)]));
}

const srgbToLinear = (v) => (v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4));

export async function processTextureSet(id, srcDir, outDir, src) {
  fs.mkdirSync(outDir, { recursive: true });
  const maps = sourceMaps(srcDir, src);
  const resize = (img, s = TEX_SIZE) => img.resize(s, s, { fit: 'fill', kernel: 'lanczos3' });
  const info = {};

  // diffuse / albedo (sRGB)
  const { data: diffRaw, info: di } = await resize(sharp(maps.diff).removeAlpha().toColourspace('srgb')).raw({ depth: 'uchar' }).toBuffer({ resolveWithObject: true });
  if (di.channels !== 3) throw new Error(`${id}: diffuse map has ${di.channels} channels`);
  info.seam = +seamScore(diffRaw, di.width, di.height, di.channels).toFixed(2);
  {
    const lut = Float64Array.from({ length: 256 }, (_, i) => srgbToLinear(i / 255));
    let r = 0, g = 0, b = 0;
    for (let i = 0; i < diffRaw.length; i += 3) { r += lut[diffRaw[i]]; g += lut[diffRaw[i + 1]]; b += lut[diffRaw[i + 2]]; }
    const n = diffRaw.length / 3;
    info.avgColor = [r / n, g / n, b / n].map((v) => +v.toFixed(4)); // linear (sRGB-decoded) mean, 0..1
  }
  await sharp(diffRaw, { raw: { width: di.width, height: di.height, channels: 3 } }).jpeg(Q.diff).toFile(path.join(outDir, 'diff.jpg'));

  // normal (OpenGL convention, +Y up)
  await resize(sharp(maps.nor).removeAlpha()).toColourspace('srgb').jpeg(Q.nor).toFile(path.join(outDir, 'nor.jpg'));
  {
    const st = await sharp(path.join(outDir, 'nor.jpg')).stats();
    info.normalMean = st.channels.slice(0, 3).map((c) => +(c.mean / 255).toFixed(3));
    if (info.normalMean[2] < 0.6) throw new Error(`${id}: normal map blue mean ${info.normalMean[2]} - not a tangent-space normal map?`);
  }

  // arm: R = ambient occlusion, G = roughness, B = metalness
  if (maps.arm) await resize(sharp(maps.arm).removeAlpha()).toColourspace('srgb').jpeg(Q.arm).toFile(path.join(outDir, 'arm.jpg'));
  else {
    // pack separate AO + roughness maps (no metalness for natural ground)
    const one = async (role) => resize(sharp(maps[role]).removeAlpha()).toColourspace('b-w').raw({ depth: 'uchar' }).toBuffer({ resolveWithObject: true });
    const ao = await one('ao'), ro = await one('rough');
    const n = TEX_SIZE * TEX_SIZE, out = Buffer.alloc(n * 3);
    for (let i = 0; i < n; i++) { out[i * 3] = ao.data[i * ao.info.channels]; out[i * 3 + 1] = ro.data[i * ro.info.channels]; out[i * 3 + 2] = 0; }
    await sharp(out, { raw: { width: TEX_SIZE, height: TEX_SIZE, channels: 3 } }).jpeg(Q.arm).toFile(path.join(outDir, 'arm.jpg'));
  }
  {
    const st = await sharp(path.join(outDir, 'arm.jpg')).stats();
    info.armMean = st.channels.slice(0, 3).map((c) => +(c.mean / 255).toFixed(3));
  }

  // displacement: 16-bit source -> robustly normalised 8-bit greyscale at 1024^2 (0 = lowest, 255 = highest)
  {
    const { data, info: hi } = await resize(sharp(maps.disp).removeAlpha().toColourspace('grey16'), DISP_SIZE).raw({ depth: 'ushort' }).toBuffer({ resolveWithObject: true });
    const px = new Uint16Array(data.buffer, data.byteOffset, data.length / 2);
    const ch = hi.channels;
    const hist = new Uint32Array(65536);
    for (let i = 0; i < px.length; i += ch) hist[px[i]]++;
    const total = px.length / ch;
    const pct = (p) => { let acc = 0; for (let v = 0; v < 65536; v++) { acc += hist[v]; if (acc >= total * p) return v; } return 65535; };
    const lo = pct(0.001), hi2 = Math.max(pct(0.999), lo + 1);
    const out = Buffer.alloc(total);
    for (let i = 0, j = 0; i < px.length; i += ch, j++) out[j] = Math.max(0, Math.min(255, Math.round(((px[i] - lo) / (hi2 - lo)) * 255)));
    info.dispSourceRange = [+(lo / 65535).toFixed(4), +(hi2 / 65535).toFixed(4)]; // part of the source range that was stretched to 0..1
    await sharp(out, { raw: { width: hi.width, height: hi.height, channels: 1 } }).toColourspace('b-w').jpeg(Q.disp).toFile(path.join(outDir, 'disp.jpg'));
  }
  return info;
}
