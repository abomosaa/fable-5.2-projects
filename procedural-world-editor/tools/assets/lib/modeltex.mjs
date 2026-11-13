// Model texture baking: Poly Haven per-material maps -> compact embedded glTF textures.
//   baseColor : JPEG (opaque) or WebP RGBA (alpha baked from the separate alpha/opacity map, colour bled into
//               transparent texels so mip-mapping does not produce dark halos, alpha-test coverage preserved)
//   normal    : JPEG 4:4:4 (OpenGL convention, as glTF requires)
//   orm       : JPEG, R = occlusion, G = roughness, B = metalness (glTF packing; Poly Haven "arm" has the same order)
import sharp from 'sharp';

const cache = new Map();
const memo = (key, fn) => { if (!cache.has(key)) cache.set(key, fn()); return cache.get(key); };

async function loadRaw(file, size, channels) {
  let img = sharp(file, { limitInputPixels: 1 << 28 });
  img = channels === 1 ? img.removeAlpha().toColourspace('b-w') : img.removeAlpha().toColourspace('srgb');
  const { data, info } = await img.resize(size, size, { fit: 'fill', kernel: 'lanczos3' }).raw({ depth: 'uchar' }).toBuffer({ resolveWithObject: true });
  if (info.channels !== channels) {
    // greyscale source asked as rgb (or vice versa): expand/collapse manually
    const out = Buffer.alloc(size * size * channels);
    for (let i = 0; i < size * size; i++) for (let c = 0; c < channels; c++) out[i * channels + c] = data[i * info.channels + Math.min(c, info.channels - 1)];
    return out;
  }
  return data;
}

/** Push-pull fill: texels with valid==0 receive colour from the nearest valid texels (via an image pyramid). In place. */
export function bleedColor(rgb, valid, w, h) {
  const levels = [];
  let cw = w, ch = h;
  let col = new Float32Array(w * h * 3), wt = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) if (valid[i]) { wt[i] = 1; col[i * 3] = rgb[i * 3]; col[i * 3 + 1] = rgb[i * 3 + 1]; col[i * 3 + 2] = rgb[i * 3 + 2]; }
  levels.push({ col, wt, w: cw, h: ch });
  while (cw > 1 || ch > 1) {
    const nw = Math.max(1, cw >> 1), nh = Math.max(1, ch >> 1);
    const nc = new Float32Array(nw * nh * 3), nwt = new Float32Array(nw * nh);
    for (let y = 0; y < nh; y++) for (let x = 0; x < nw; x++) {
      let s = 0, r = 0, g = 0, b = 0;
      for (let dy = 0; dy < 2; dy++) for (let dx = 0; dx < 2; dx++) {
        const sx = Math.min(cw - 1, x * 2 + dx), sy = Math.min(ch - 1, y * 2 + dy), si = sy * cw + sx;
        const ww = wt[si];
        if (ww > 0) { s += ww; r += col[si * 3] * ww; g += col[si * 3 + 1] * ww; b += col[si * 3 + 2] * ww; }
      }
      const di = y * nw + x;
      if (s > 0) { nwt[di] = 1; nc[di * 3] = r / s; nc[di * 3 + 1] = g / s; nc[di * 3 + 2] = b / s; }
    }
    col = nc; wt = nwt; cw = nw; ch = nh;
    levels.push({ col, wt, w: cw, h: ch });
  }
  for (let l = levels.length - 2; l >= 0; l--) {
    const fine = levels[l], coarse = levels[l + 1];
    for (let y = 0; y < fine.h; y++) for (let x = 0; x < fine.w; x++) {
      const i = y * fine.w + x;
      if (fine.wt[i] > 0) continue;
      // bilinear sample of the coarse level
      const fx = Math.min(coarse.w - 1, Math.max(0, (x + 0.5) / 2 - 0.5)), fy = Math.min(coarse.h - 1, Math.max(0, (y + 0.5) / 2 - 0.5));
      const x0 = Math.floor(fx), y0 = Math.floor(fy), x1 = Math.min(coarse.w - 1, x0 + 1), y1 = Math.min(coarse.h - 1, y0 + 1);
      const tx = fx - x0, ty = fy - y0;
      for (let c = 0; c < 3; c++) {
        const a = coarse.col[(y0 * coarse.w + x0) * 3 + c], b = coarse.col[(y0 * coarse.w + x1) * 3 + c];
        const d = coarse.col[(y1 * coarse.w + x0) * 3 + c], e = coarse.col[(y1 * coarse.w + x1) * 3 + c];
        fine.col[i * 3 + c] = (a * (1 - tx) + b * tx) * (1 - ty) + (d * (1 - tx) + e * tx) * ty;
      }
      fine.wt[i] = 1;
    }
  }
  const out = levels[0].col;
  for (let i = 0; i < w * h; i++) if (!valid[i]) { rgb[i * 3] = Math.round(out[i * 3]); rgb[i * 3 + 1] = Math.round(out[i * 3 + 1]); rgb[i * 3 + 2] = Math.round(out[i * 3 + 2]); }
}

const coverageOf = (a, cut) => { let n = 0; for (let i = 0; i < a.length; i++) if (a[i] >= cut) n++; return n / a.length; };

/**
 * RGBA base colour for alpha-tested / blended materials.
 * @returns {{data:Buffer,mime:string,coverage:number}}
 */
export function alphaBaseColor(diffPath, alphaPath, size, { mode = 'MASK', srcSize = 2048, cutoff = 0.5 } = {}) {
  return memo(`abc|${diffPath}|${alphaPath}|${size}|${mode}|${cutoff}`, async () => {
    const full = await memo(`abcfull|${diffPath}|${alphaPath}|${srcSize}`, async () => {
      const rgb = Buffer.from(await loadRaw(diffPath, srcSize, 3));
      const alpha = await loadRaw(alphaPath, srcSize, 1);
      const valid = new Uint8Array(srcSize * srcSize);
      // only texels that are clearly inside the cut-out contribute colour (edge texels are contaminated by the matte)
      for (let i = 0; i < valid.length; i++) valid[i] = alpha[i] >= 160 ? 1 : 0;
      bleedColor(rgb, valid, srcSize, srcSize);
      return { rgb, alpha, coverage: coverageOf(alpha, 128) };
    });
    let rgb = full.rgb, alpha = full.alpha;
    if (size !== srcSize) {
      rgb = await sharp(full.rgb, { raw: { width: srcSize, height: srcSize, channels: 3 } }).resize(size, size, { kernel: 'lanczos3' }).raw().toBuffer();
      // NB: sharp expands 1-channel raw input to 3 channels on output unless the colourspace is pinned
      alpha = Buffer.from(await sharp(full.alpha, { raw: { width: srcSize, height: srcSize, channels: 1 } }).resize(size, size, { kernel: 'cubic' }).toColourspace('b-w').raw().toBuffer());
      if (alpha.length !== size * size) throw new Error('unexpected alpha channel layout from sharp');
    } else alpha = Buffer.from(alpha);
    if (mode === 'MASK') {
      // Re-scale alpha so that testing against `cutoff` reproduces the coverage of the full-resolution map at 0.5
      // (thin needles / blades otherwise fade away when the map is minified).
      const cut = cutoff * 255;
      let lo = 0.25, hi = 4;
      for (let it = 0; it < 18; it++) {
        const k = (lo + hi) / 2; let n = 0;
        for (let i = 0; i < alpha.length; i++) if (alpha[i] * k >= cut) n++;
        if (n / alpha.length < full.coverage) lo = k; else hi = k;
      }
      const k = (lo + hi) / 2;
      for (let i = 0; i < alpha.length; i++) alpha[i] = Math.min(255, Math.round(alpha[i] * k));
      // "Alpha floor": texels near the cut-out shapes keep a sub-cutoff alpha. Nothing changes up close, but once the
      // leaf cards are minified the mip-averaged alpha stays above the cut-off, so thin blades / small leaves turn into
      // solid cards at a distance instead of dissolving (alpha test + mip-mapping).
      const r = Math.max(2, Math.round(size / 48));
      let cur = new Float32Array(size * size);
      for (let i = 0; i < cur.length; i++) cur[i] = alpha[i] >= cut ? 1 : 0;
      for (let p = 0; p < 2; p++) for (const horizontal of [true, false]) {
        const dst = new Float32Array(size * size);
        for (let y = 0; y < size; y++) {
          // sliding box filter
          let sum = 0;
          const at = (q) => (horizontal ? cur[y * size + Math.min(size - 1, Math.max(0, q))] : cur[Math.min(size - 1, Math.max(0, q)) * size + y]);
          for (let d = -r; d <= r; d++) sum += at(d);
          for (let x = 0; x < size; x++) {
            if (horizontal) dst[y * size + x] = sum / (2 * r + 1); else dst[x * size + y] = sum / (2 * r + 1);
            sum += at(x + r + 1) - at(x - r);
          }
        }
        cur = dst;
      }
      const floorMax = 0.85 * cut;
      for (let i = 0; i < alpha.length; i++) { const t = Math.min(1, Math.max(0, (cur[i] - 0.04) / 0.14)); alpha[i] = Math.max(alpha[i], Math.round(t * t * (3 - 2 * t) * floorMax)); }
    }
    const rgba = Buffer.alloc(size * size * 4);
    for (let i = 0; i < size * size; i++) { rgba[i * 4] = rgb[i * 3]; rgba[i * 4 + 1] = rgb[i * 3 + 1]; rgba[i * 4 + 2] = rgb[i * 3 + 2]; rgba[i * 4 + 3] = alpha[i]; }
    const data = await sharp(rgba, { raw: { width: size, height: size, channels: 4 } }).webp({ quality: 86, alphaQuality: 100, effort: 5, smartSubsample: true }).toBuffer();
    return { data, mime: 'image/webp', coverage: full.coverage };
  });
}

export function opaqueBaseColor(diffPath, size) {
  return memo(`obc|${diffPath}|${size}`, async () => ({
    data: await sharp(diffPath).removeAlpha().toColourspace('srgb').resize(size, size, { fit: 'fill', kernel: 'lanczos3' }).jpeg({ quality: 83, mozjpeg: true, chromaSubsampling: '4:2:0' }).toBuffer(),
    mime: 'image/jpeg',
  }));
}

export function normalMap(norPath, size) {
  return memo(`nor|${norPath}|${size}`, async () => ({
    data: await sharp(norPath).removeAlpha().toColourspace('srgb').resize(size, size, { fit: 'fill', kernel: 'lanczos3' }).jpeg({ quality: 78, mozjpeg: true, chromaSubsampling: '4:4:4' }).toBuffer(),
    mime: 'image/jpeg',
  }));
}

/** @param kind 'arm' (R=AO,G=rough,B=metal already) | 'rough' (greyscale roughness only) | 'mr' (glTF metallicRoughness without AO) */
export function ormMap(mrPath, size, kind) {
  return memo(`orm|${mrPath}|${size}|${kind}`, async () => {
    let img;
    if (kind === 'arm') img = sharp(mrPath).removeAlpha().toColourspace('srgb').resize(size, size, { fit: 'fill', kernel: 'lanczos3' });
    else {
      const src = await loadRaw(mrPath, size, kind === 'rough' ? 1 : 3);
      const out = Buffer.alloc(size * size * 3);
      for (let i = 0; i < size * size; i++) {
        out[i * 3] = 255;
        out[i * 3 + 1] = kind === 'rough' ? src[i] : src[i * 3 + 1];
        out[i * 3 + 2] = kind === 'rough' ? 0 : src[i * 3 + 2];
      }
      img = sharp(out, { raw: { width: size, height: size, channels: 3 } });
    }
    return { data: await img.jpeg({ quality: 80, mozjpeg: true, chromaSubsampling: '4:4:4' }).toBuffer(), mime: 'image/jpeg' };
  });
}
