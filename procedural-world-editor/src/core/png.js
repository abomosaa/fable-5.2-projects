// Minimal PNG encoder/decoder (8/16-bit gray, RGB, RGBA) built on the platform's zlib streams
// (CompressionStream is available in browsers and Node >= 18). Used for heightmap / mask export.

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf, start, end) {
  let c = 0xffffffff;
  for (let i = start; i < end; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

async function pipe(data, stream) {
  const w = stream.writable.getWriter();
  w.write(data);
  w.close();
  const chunks = [];
  const r = stream.readable.getReader();
  let total = 0;
  for (;;) {
    const { done, value } = await r.read();
    if (done) break;
    chunks.push(value);
    total += value.length;
  }
  const out = new Uint8Array(total);
  let o = 0;
  for (const c of chunks) {
    out.set(c, o);
    o += c.length;
  }
  return out;
}

export const deflate = (d) => pipe(d, new CompressionStream('deflate'));
export const inflate = (d) => pipe(d, new DecompressionStream('deflate'));
export const gzip = (d) => pipe(d, new CompressionStream('gzip'));
export const gunzip = (d) => pipe(d, new DecompressionStream('gzip'));

/**
 * @param {Uint8Array|Uint16Array} pixels row-major, top row first
 * @param {number} width
 * @param {number} height
 * @param {number} channels 1 (gray), 3 (rgb) or 4 (rgba)
 * @param {number} bitDepth 8 or 16
 * @returns {Promise<Uint8Array>}
 */
export async function encodePNG(pixels, width, height, channels = 1, bitDepth = 8) {
  const bpp = channels * (bitDepth / 8);
  const stride = width * bpp;
  const raw = new Uint8Array((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    const o = y * (stride + 1);
    raw[o] = 0;
    if (bitDepth === 8) {
      raw.set(pixels.subarray(y * stride, (y + 1) * stride), o + 1);
    } else {
      const n = width * channels;
      for (let i = 0; i < n; i++) {
        const v = pixels[y * n + i];
        raw[o + 1 + i * 2] = v >>> 8;
        raw[o + 2 + i * 2] = v & 255;
      }
    }
  }
  const z = await deflate(raw);
  const colorType = channels === 1 ? 0 : channels === 3 ? 2 : 6;
  const out = new Uint8Array(8 + 25 + 12 + z.length + 12);
  const dv = new DataView(out.buffer);
  out.set([137, 80, 78, 71, 13, 10, 26, 10], 0);
  let p = 8;
  const chunk = (type, data) => {
    dv.setUint32(p, data.length);
    for (let i = 0; i < 4; i++) out[p + 4 + i] = type.charCodeAt(i);
    out.set(data, p + 8);
    dv.setUint32(p + 8 + data.length, crc32(out, p + 4, p + 8 + data.length));
    p += 12 + data.length;
  };
  const ihdr = new Uint8Array(13);
  const idv = new DataView(ihdr.buffer);
  idv.setUint32(0, width);
  idv.setUint32(4, height);
  ihdr[8] = bitDepth;
  ihdr[9] = colorType;
  chunk('IHDR', ihdr);
  chunk('IDAT', z);
  chunk('IEND', new Uint8Array(0));
  return out;
}

/** Decode PNGs written by encodePNG (and other non-interlaced 8/16-bit PNGs). */
export async function decodePNG(bytes) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let p = 8;
  let width = 0,
    height = 0,
    bitDepth = 8,
    colorType = 0;
  const idat = [];
  while (p < bytes.length) {
    const len = dv.getUint32(p);
    const type = String.fromCharCode(bytes[p + 4], bytes[p + 5], bytes[p + 6], bytes[p + 7]);
    if (type === 'IHDR') {
      width = dv.getUint32(p + 8);
      height = dv.getUint32(p + 12);
      bitDepth = bytes[p + 16];
      colorType = bytes[p + 17];
    } else if (type === 'IDAT') idat.push(bytes.subarray(p + 8, p + 8 + len));
    else if (type === 'IEND') break;
    p += 12 + len;
  }
  let total = 0;
  for (const c of idat) total += c.length;
  const zdata = new Uint8Array(total);
  let o = 0;
  for (const c of idat) {
    zdata.set(c, o);
    o += c.length;
  }
  const raw = await inflate(zdata);
  const channels = colorType === 0 ? 1 : colorType === 2 ? 3 : colorType === 4 ? 2 : 4;
  const bps = bitDepth / 8;
  const bpp = channels * bps;
  const stride = width * bpp;
  const data = new Uint8Array(stride * height);
  for (let y = 0; y < height; y++) {
    const f = raw[y * (stride + 1)];
    const src = y * (stride + 1) + 1;
    const dst = y * stride;
    for (let i = 0; i < stride; i++) {
      const a = i >= bpp ? data[dst + i - bpp] : 0;
      const b = y > 0 ? data[dst - stride + i] : 0;
      const c = i >= bpp && y > 0 ? data[dst - stride + i - bpp] : 0;
      let v = raw[src + i];
      if (f === 1) v += a;
      else if (f === 2) v += b;
      else if (f === 3) v += (a + b) >> 1;
      else if (f === 4) {
        const pp = a + b - c;
        const pa = Math.abs(pp - a),
          pb = Math.abs(pp - b),
          pc = Math.abs(pp - c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      data[dst + i] = v & 255;
    }
  }
  let pixels;
  if (bitDepth === 16) {
    pixels = new Uint16Array(width * height * channels);
    for (let i = 0; i < pixels.length; i++) pixels[i] = (data[i * 2] << 8) | data[i * 2 + 1];
  } else pixels = data;
  return { width, height, channels, bitDepth, pixels };
}
