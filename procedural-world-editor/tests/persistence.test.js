// Persistence: binary layer codecs, PNG codec, the project storage API (server/api.mjs) and a
// full save -> load round trip through the editor's store client.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import { mkdtempSync, rmSync, existsSync, readFileSync, readdirSync, utimesSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync, deflateSync, inflateSync } from 'node:zlib';
import { quantizeHeights, dequantizeHeights, packHeights, unpackHeights, snapHeights, packPaint, unpackPaint, packU16, unpackU16, packU8, unpackU8, sedimentToU8, sedimentFromU8, referencedAssets, createProjectDoc, PROJECT_VERSION } from '../src/core/project.js';
import { encodePNG, decodePNG, gzip, gunzip, deflate, inflate } from '../src/core/png.js';
import { mulberry32, Noise2D } from '../src/core/noise.js';
import { World } from '../src/core/world.js';
import { serializeWorld, deserializeProject } from '../src/core/projectIO.js';
import { buildTestWorld, loadManifest, hashBytes, syntheticHeights, scatterTotals, RES, SIZE } from './helpers/world.js';

// ---------------------------------------------------------------------------------------------
// codecs
// ---------------------------------------------------------------------------------------------
describe('binary layer codecs', () => {
  it('quantizeHeights / dequantizeHeights round-trips within half a quantisation step', () => {
    const rnd = mulberry32(5);
    const data = new Float32Array(50000);
    for (let i = 0; i < data.length; i++) data[i] = 800 + Math.sin(i * 0.01) * 300 + rnd() * 40;
    data[17] = -123.25; // extremes are represented exactly
    data[4711] = 2999.5;
    const q = quantizeHeights(data);
    expect(q.hMin).toBe(-123.25);
    expect(q.hMax).toBe(2999.5);
    expect(q.u16).toBeInstanceOf(Uint16Array);
    expect(q.u16[17]).toBe(0);
    expect(q.u16[4711]).toBe(65535);
    const back = dequantizeHeights(q.u16, q.hMin, q.hMax);
    const step = (q.hMax - q.hMin) / 65535;
    let maxErr = 0;
    for (let i = 0; i < data.length; i++) maxErr = Math.max(maxErr, Math.abs(back[i] - data[i]));
    expect(maxErr).toBeLessThanOrEqual(step / 2 + 2e-4); // + float32 rounding of the stored value
    expect(maxErr).toBeGreaterThan(step / 4); // genuinely quantised
    expect(back[17]).toBe(-123.25);
    expect(back[4711]).toBeCloseTo(2999.5, 3);
    // re-quantising a decoded layer is stable: same codes, and after one more pass the same floats
    const q2 = quantizeHeights(back);
    expect(hashBytes(q2.u16)).toBe(hashBytes(q.u16));
    const back2 = dequantizeHeights(q2.u16, q2.hMin, q2.hMax);
    const q3 = quantizeHeights(back2);
    expect(hashBytes(dequantizeHeights(q3.u16, q3.hMin, q3.hMax))).toBe(hashBytes(back2));
    // a perfectly flat layer does not divide by zero
    const flat = quantizeHeights(new Float32Array(100).fill(42));
    expect(flat.hMin).toBe(42);
    expect(flat.hMax).toBe(43);
    expect(Array.from(dequantizeHeights(flat.u16, flat.hMin, flat.hMax))).toEqual(new Array(100).fill(42));
  });

  it('packHeights / unpackHeights are lossless for heights on the 1/1024 m grid', async () => {
    const n = new Noise2D(5);
    const data = new Float32Array(129 * 129);
    for (let i = 0; i < data.length; i++) data[i] = -300 + n.fbm((i % 129) / 17, ((i / 129) | 0) / 17, 4) * 2400 + (i % 7) * 0.001;
    const raw = new Float32Array(data);
    snapHeights(data);
    let maxErr = 0;
    for (let i = 0; i < data.length; i++) maxErr = Math.max(maxErr, Math.abs(data[i] - raw[i]));
    expect(maxErr).toBeLessThanOrEqual(0.5 / 1024 + 1e-4);
    const back = await unpackHeights(await packHeights(data));
    expect(back.length).toBe(data.length);
    expect(hashBytes(back)).toBe(hashBytes(data));
    // snapping is idempotent and packing un-snapped data stores the snapped value
    const again = new Float32Array(data);
    snapHeights(again);
    expect(hashBytes(again)).toBe(hashBytes(data));
    expect(hashBytes(await unpackHeights(await packHeights(raw)))).toBe(hashBytes(data));
  });

  it('packU16 / packU8 / sediment conversions round-trip', async () => {
    const rnd = mulberry32(9);
    const u16 = new Uint16Array(30001);
    for (let i = 0; i < u16.length; i++) u16[i] = (rnd() * 65536) | 0;
    u16[0] = 0;
    u16[1] = 65535;
    const packed = await packU16(u16);
    expect(packed[0]).toBe(0x1f); // gzip magic
    expect(packed[1]).toBe(0x8b);
    const back = await unpackU16(packed);
    expect(back).toBeInstanceOf(Uint16Array);
    expect(hashBytes(back)).toBe(hashBytes(u16));
    // a view into a larger buffer is packed correctly (byteOffset honoured)
    const big = new Uint16Array(64);
    for (let i = 0; i < 64; i++) big[i] = i * 3;
    const view = big.subarray(10, 20);
    expect(Array.from(await unpackU16(await packU16(view)))).toEqual(Array.from(view));
    const u8 = new Uint8Array(12345);
    for (let i = 0; i < u8.length; i++) u8[i] = (rnd() * 256) | 0;
    expect(hashBytes(await unpackU8(await packU8(u8)))).toBe(hashBytes(u8));
    expect((await unpackU8(await packU8(new Uint8Array(0)))).length).toBe(0);
    // sediment: [0,1] floats <-> bytes
    const sed = new Float32Array([0, 0.001, 0.25, 0.5, 0.999, 1, 1.7, -0.3]);
    const s8 = sedimentToU8(sed);
    expect(Array.from(s8)).toEqual([0, 0, 64, 128, 255, 255, 255, 0]);
    const sb = sedimentFromU8(s8);
    for (let i = 0; i < 6; i++) expect(Math.abs(sb[i] - sed[i])).toBeLessThanOrEqual(0.5 / 255 + 1e-7);
    expect(Array.from(sedimentToU8(sb))).toEqual(Array.from(s8)); // stable
    // generic stream helpers
    const text = new TextEncoder().encode('terraforge '.repeat(500));
    expect(new TextDecoder().decode(await gunzip(await gzip(text)))).toBe('terraforge '.repeat(500));
    expect((await gzip(text)).length).toBeLessThan(text.length / 10);
    expect(hashBytes(await inflate(await deflate(text)))).toBe(hashBytes(text));
    expect(hashBytes(new Uint8Array(gunzipSync(await gzip(text))))).toBe(hashBytes(text)); // interoperates with zlib
  });

  it('packPaint / unpackPaint stores only the layers in use and restores them exactly', async () => {
    const res = 33,
      N = res * res;
    const rnd = mulberry32(3);
    const fill = (neutral, p) => {
      const a = new Uint8Array(N).fill(neutral);
      for (let i = 0; i < N; i++) if (rnd() < p) a[i] = (rnd() * 256) | 0;
      return a;
    };
    const paint = { biome: fill(0, 0.3), exclude: new Uint8Array(N), mat: new Array(9).fill(null), density: { trees: fill(128, 0.2), rocks: new Uint8Array(N).fill(128) } };
    paint.mat[2] = fill(0, 0.5);
    paint.mat[8] = fill(0, 0.1);
    paint.mat[5] = new Uint8Array(N); // allocated but empty: not stored
    const packed = await packPaint(paint, res);
    const raw = await gunzip(packed);
    const hl = new DataView(raw.buffer, raw.byteOffset).getUint32(0, true);
    const header = JSON.parse(new TextDecoder().decode(raw.subarray(4, 4 + hl)));
    expect(header).toEqual({ res, layers: ['biome', 'mat:2', 'mat:8', 'density:trees'] });
    expect(raw.length).toBe(4 + hl + 4 * N);
    const back = await unpackPaint(packed, res);
    expect(hashBytes(back.biome)).toBe(hashBytes(paint.biome));
    expect(hashBytes(back.exclude)).toBe(hashBytes(paint.exclude));
    expect(hashBytes(back.mat[2])).toBe(hashBytes(paint.mat[2]));
    expect(hashBytes(back.mat[8])).toBe(hashBytes(paint.mat[8]));
    expect(back.mat.map((m) => m !== null)).toEqual([false, false, true, false, false, false, false, false, true]);
    expect(Object.keys(back.density)).toEqual(['trees']);
    expect(hashBytes(back.density.trees)).toBe(hashBytes(paint.density.trees));
    // exclusion layer on its own
    const p2 = { biome: new Uint8Array(N), exclude: fill(0, 0.4), mat: new Array(9).fill(null), density: {} };
    const b2 = await unpackPaint(await packPaint(p2, res), res);
    expect(hashBytes(b2.exclude)).toBe(hashBytes(p2.exclude));
    expect(b2.biome.every((v) => v === 0)).toBe(true);
    // nothing painted / no file: neutral defaults of the right size
    for (const bytes of [await packPaint({ biome: new Uint8Array(N), exclude: new Uint8Array(N), mat: [], density: {} }, res), null, new Uint8Array(0)]) {
      const empty = await unpackPaint(bytes, res);
      expect(empty.biome.length).toBe(N);
      expect(empty.exclude.length).toBe(N);
      expect(empty.mat).toEqual(new Array(9).fill(null));
      expect(empty.density).toEqual({});
    }
    await expect(unpackPaint(packed, 65)).rejects.toThrow(/resolution 33 does not match terrain 65/);
  });
});

describe('PNG codec', () => {
  const rnd = mulberry32(77);
  const random = (n, max) => {
    const a = max > 255 ? new Uint16Array(n) : new Uint8Array(n);
    for (let i = 0; i < n; i++) a[i] = (rnd() * (max + 1)) | 0;
    return a;
  };

  it('round-trips 8-bit gray / RGB / RGBA', async () => {
    for (const [w, h, ch] of [
      [37, 19, 1],
      [64, 64, 3],
      [5, 111, 4],
      [1, 1, 1],
    ]) {
      const px = random(w * h * ch, 255);
      const png = await encodePNG(px, w, h, ch, 8);
      expect(Array.from(png.subarray(0, 8))).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
      const d = await decodePNG(png);
      expect(d).toMatchObject({ width: w, height: h, channels: ch, bitDepth: 8 });
      expect(hashBytes(d.pixels)).toBe(hashBytes(px));
    }
  });

  it('round-trips 16-bit gray (heightmaps) and 16-bit RGB with big-endian samples', async () => {
    const w = 129,
      h = 65;
    const px = random(w * h, 65535);
    px[0] = 0;
    px[1] = 65535;
    px[2] = 0x1234;
    const png = await encodePNG(px, w, h, 1, 16);
    const d = await decodePNG(png);
    expect(d).toMatchObject({ width: w, height: h, channels: 1, bitDepth: 16 });
    expect(d.pixels).toBeInstanceOf(Uint16Array);
    expect(hashBytes(d.pixels)).toBe(hashBytes(px));
    // IHDR: bit depth 16, colour type 0 (gray)
    expect(png[24]).toBe(16);
    expect(png[25]).toBe(0);
    // PNG stores samples big-endian: 0x1234 appears as 12 34 in the raw scanline
    const idatLen = new DataView(png.buffer).getUint32(33);
    const rawScan = inflateSync(png.subarray(41, 41 + idatLen)); // the IDAT payload is a zlib stream
    expect([rawScan[1 + 4], rawScan[1 + 5]]).toEqual([0x12, 0x34]);
    const rgb = random(20 * 10 * 3, 65535);
    const d2 = await decodePNG(await encodePNG(rgb, 20, 10, 3, 16));
    expect(d2).toMatchObject({ channels: 3, bitDepth: 16 });
    expect(hashBytes(d2.pixels)).toBe(hashBytes(rgb));
  });

  it('writes valid chunk CRCs and decodes PNGs that use the Sub / Up / Average / Paeth filters', async () => {
    const w = 31,
      h = 23,
      ch = 3;
    const px = new Uint8Array(w * h * ch);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) for (let c = 0; c < ch; c++) px[(y * w + x) * ch + c] = (x * 7 + y * 13 + c * 50 + ((rnd() * 9) | 0)) & 255;
    // CRC of our own encoder, checked with an independent implementation
    const ours = await encodePNG(px, w, h, ch, 8);
    let p = 8;
    const types = [];
    while (p < ours.length) {
      const len = new DataView(ours.buffer, ours.byteOffset).getUint32(p);
      types.push(String.fromCharCode(...ours.subarray(p + 4, p + 8)));
      expect(new DataView(ours.buffer, ours.byteOffset).getUint32(p + 8 + len)).toBe(crc32(ours.subarray(p + 4, p + 8 + len)));
      p += 12 + len;
    }
    expect(types).toEqual(['IHDR', 'IDAT', 'IEND']);
    expect(p).toBe(ours.length);
    // a PNG written by an independent encoder using every filter type, split into several IDAT chunks
    const stride = w * ch;
    const raw = new Uint8Array((stride + 1) * h);
    for (let y = 0; y < h; y++) {
      const f = y % 5; // 0 none, 1 sub, 2 up, 3 average, 4 paeth
      raw[y * (stride + 1)] = f;
      for (let i = 0; i < stride; i++) {
        const cur = px[y * stride + i];
        const a = i >= ch ? px[y * stride + i - ch] : 0;
        const b = y > 0 ? px[(y - 1) * stride + i] : 0;
        const c = i >= ch && y > 0 ? px[(y - 1) * stride + i - ch] : 0;
        let pred = 0;
        if (f === 1) pred = a;
        else if (f === 2) pred = b;
        else if (f === 3) pred = (a + b) >> 1;
        else if (f === 4) {
          const pp = a + b - c;
          const pa = Math.abs(pp - a),
            pb = Math.abs(pp - b),
            pc = Math.abs(pp - c);
          pred = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
        }
        raw[y * (stride + 1) + 1 + i] = (cur - pred) & 255;
      }
    }
    const z = deflateSync(raw);
    const chunk = (type, data) => {
      const out = Buffer.alloc(12 + data.length);
      out.writeUInt32BE(data.length, 0);
      out.write(type, 4, 'latin1');
      Buffer.from(data).copy(out, 8);
      out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
      return out;
    };
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(w, 0);
    ihdr.writeUInt32BE(h, 4);
    ihdr[8] = 8;
    ihdr[9] = 2;
    const cut = z.length >> 1;
    const foreign = new Uint8Array(Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('tEXt', Buffer.from('Comment\0other encoder')), chunk('IDAT', z.subarray(0, cut)), chunk('IDAT', z.subarray(cut)), chunk('IEND', Buffer.alloc(0))]));
    const d = await decodePNG(foreign);
    expect(d).toMatchObject({ width: w, height: h, channels: 3, bitDepth: 8 });
    expect(hashBytes(d.pixels)).toBe(hashBytes(px));
  });
});

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  }
  return (c ^ 0xffffffff) >>> 0;
}

// ---------------------------------------------------------------------------------------------
// project storage API
// ---------------------------------------------------------------------------------------------
let tmp, server, base, api, realFetch;

/** Raw HTTP request (no URL normalisation, so encoded "../" segments reach the server untouched). */
function rawRequest(method, path, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(base);
    const req = http.request({ host: u.hostname, port: u.port, method, path, headers: body ? { 'Content-Length': Buffer.byteLength(body) } : {} }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}
const jsonOf = (r) => JSON.parse(r.body.toString('utf8'));

/** Minimal ustar reader: [{name, data}] */
function readTar(buf) {
  const out = [];
  let p = 0;
  while (p + 512 <= buf.length) {
    const header = buf.subarray(p, p + 512);
    if (header.every((b) => b === 0)) break;
    let name = header.toString('utf8', 0, 100).replace(/\0.*$/, '');
    const prefix = header.toString('utf8', 345, 500).replace(/\0.*$/, '');
    if (prefix) name = prefix + '/' + name;
    const size = parseInt(header.toString('utf8', 124, 136).replace(/\0.*$/, '').trim(), 8);
    expect(header.toString('utf8', 257, 262)).toBe('ustar');
    // header checksum: sum of all bytes with the checksum field as spaces
    let sum = 0;
    for (let i = 0; i < 512; i++) sum += i >= 148 && i < 156 ? 32 : header[i];
    expect(parseInt(header.toString('utf8', 148, 154), 8)).toBe(sum);
    out.push({ name, data: buf.subarray(p + 512, p + 512 + size) });
    p += 512 + Math.ceil(size / 512) * 512;
  }
  return out;
}

beforeAll(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'terraforge-test-'));
  // the storage module reads these once at import time
  process.env.TERRAFORGE_PROJECTS = join(tmp, 'projects');
  process.env.TERRAFORGE_EXPORTS = join(tmp, 'exports');
  api = await import('../server/api.mjs');
  server = http.createServer((req, res) => {
    api.handleApi(req, res, new URL(req.url, 'http://localhost'));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
  // src/editor/store.js talks to same-origin "/api/..." URLs through the global fetch
  realFetch = globalThis.fetch;
  globalThis.fetch = (url, init) => realFetch(typeof url === 'string' && url.startsWith('/') ? base + url : url, init);
});

afterAll(async () => {
  globalThis.fetch = realFetch;
  await new Promise((r) => server.close(r));
  rmSync(tmp, { recursive: true, force: true });
});

describe('project storage API (server/api.mjs)', () => {
  const doc = { version: 3, id: 'alpha', name: 'Alpha project', seed: 42, terrain: { preset: 'alpine', size: 512, res: 65 } };
  const bin = new Uint8Array(5000).map((_, i) => (i * 31 + 7) & 255);

  it('uses the directories from the environment', async () => {
    expect(api.PROJECTS_DIR).toBe(join(tmp, 'projects'));
    expect(api.EXPORTS_DIR).toBe(join(tmp, 'exports'));
    const r = await rawRequest('GET', '/api/health');
    expect(r.status).toBe(200);
    expect(jsonOf(r)).toEqual({ ok: true, projectsDir: join(tmp, 'projects') });
  });

  it('stores and returns project files byte for byte', async () => {
    const put = await rawRequest('PUT', '/api/projects/alpha/file/project.json', JSON.stringify(doc));
    expect(put.status).toBe(200);
    expect(jsonOf(put)).toMatchObject({ ok: true, bytes: JSON.stringify(doc).length });
    expect(jsonOf(put).sha256).toMatch(/^[0-9a-f]{64}$/);
    const putBin = await rawRequest('PUT', '/api/projects/alpha/file/heights.u16.gz', Buffer.from(bin));
    expect(jsonOf(putBin).bytes).toBe(bin.length);
    const get = await rawRequest('GET', '/api/projects/alpha/file/project.json');
    expect(get.status).toBe(200);
    expect(get.headers['content-type']).toBe('application/json');
    expect(get.headers['cache-control']).toBe('no-store');
    expect(JSON.parse(get.body.toString())).toEqual(doc);
    const getBin = await rawRequest('GET', '/api/projects/alpha/file/heights.u16.gz');
    expect(getBin.headers['content-type']).toBe('application/octet-stream');
    expect(+getBin.headers['content-length']).toBe(bin.length);
    expect(hashBytes(new Uint8Array(getBin.body))).toBe(hashBytes(bin));
    // on disk exactly where expected, no temp files left behind
    expect(readdirSync(join(tmp, 'projects', 'alpha')).sort()).toEqual(['heights.u16.gz', 'project.json']);
    // overwrite replaces atomically
    await rawRequest('PUT', '/api/projects/alpha/file/heights.u16.gz', Buffer.from([1, 2, 3]));
    expect(Array.from((await rawRequest('GET', '/api/projects/alpha/file/heights.u16.gz')).body)).toEqual([1, 2, 3]);
    await rawRequest('PUT', '/api/projects/alpha/file/heights.u16.gz', Buffer.from(bin));
    const missing = await rawRequest('GET', '/api/projects/alpha/file/nope.bin');
    expect(missing.status).toBe(404);
    expect(jsonOf(missing).error).toMatch(/file not found: alpha\/nope\.bin/);
    expect((await rawRequest('GET', '/api/projects/ghost/file/project.json')).status).toBe(404);
  });

  it('lists projects with their metadata', async () => {
    const list = jsonOf(await rawRequest('GET', '/api/projects'));
    const e = list.find((p) => p.id === 'alpha');
    expect(e).toMatchObject({ id: 'alpha', name: 'Alpha project', seed: 42, preset: 'alpine', size: 512, autosave: null, hasThumb: false, showcase: null });
    expect(Number.isNaN(Date.parse(e.modified))).toBe(false);
    // an unreadable project is reported, not fatal
    await rawRequest('PUT', '/api/projects/broken/file/project.json', '{not json');
    const list2 = jsonOf(await rawRequest('GET', '/api/projects'));
    expect(list2.find((p) => p.id === 'broken').error).toMatch(/unreadable project\.json/);
    expect(list2.find((p) => p.id === 'alpha')).toBeTruthy();
    await rawRequest('DELETE', '/api/projects/broken');
  });

  it('keeps the autosave slot separate from the saved project', async () => {
    const auto = { ...doc, name: 'Alpha (unsaved edits)' };
    expect((await rawRequest('PUT', '/api/projects/alpha/file/project.json?autosave=1', JSON.stringify(auto))).status).toBe(200);
    await rawRequest('PUT', '/api/projects/alpha/file/heights.u16.gz?autosave=1', Buffer.from([9, 9]));
    // the saved slot is untouched
    expect(JSON.parse((await rawRequest('GET', '/api/projects/alpha/file/project.json')).body.toString()).name).toBe('Alpha project');
    expect((await rawRequest('GET', '/api/projects/alpha/file/heights.u16.gz')).body.length).toBe(bin.length);
    // the autosave slot has its own files
    expect(JSON.parse((await rawRequest('GET', '/api/projects/alpha/file/project.json?autosave=1')).body.toString()).name).toBe('Alpha (unsaved edits)');
    expect(Array.from((await rawRequest('GET', '/api/projects/alpha/file/heights.u16.gz?autosave=1')).body)).toEqual([9, 9]);
    expect(readdirSync(join(tmp, 'projects', 'alpha', '.autosave')).sort()).toEqual(['heights.u16.gz', 'project.json']);
    // the list flags an autosave that is newer than the saved document
    const ap = join(tmp, 'projects', 'alpha', '.autosave', 'project.json');
    const t = new Date(statSync(join(tmp, 'projects', 'alpha', 'project.json')).mtimeMs + 5000);
    utimesSync(ap, t, t);
    const e = jsonOf(await rawRequest('GET', '/api/projects')).find((p) => p.id === 'alpha');
    expect(e.name).toBe('Alpha project');
    expect(Date.parse(e.autosave)).toBe(t.getTime());
    // discarding the autosave leaves the project intact
    expect(jsonOf(await rawRequest('DELETE', '/api/projects/alpha/autosave'))).toEqual({ ok: true });
    expect((await rawRequest('GET', '/api/projects/alpha/file/project.json?autosave=1')).status).toBe(404);
    expect((await rawRequest('GET', '/api/projects/alpha/file/project.json')).status).toBe(200);
    expect(jsonOf(await rawRequest('GET', '/api/projects')).find((p) => p.id === 'alpha').autosave).toBeNull();
  });

  it('duplicates a project under a new id without its autosave', async () => {
    await rawRequest('PUT', '/api/projects/alpha/file/project.json?autosave=1', JSON.stringify({ ...doc, name: 'temp' }));
    const r = await rawRequest('POST', '/api/projects/alpha/duplicate', JSON.stringify({ id: 'beta', name: 'Beta copy' }));
    expect(r.status).toBe(200);
    expect(jsonOf(r)).toEqual({ ok: true, id: 'beta' });
    const copy = JSON.parse((await rawRequest('GET', '/api/projects/beta/file/project.json')).body.toString());
    expect(copy).toMatchObject({ id: 'beta', name: 'Beta copy', seed: 42, terrain: doc.terrain });
    expect(copy.created).toBe(copy.modified);
    expect(hashBytes(new Uint8Array((await rawRequest('GET', '/api/projects/beta/file/heights.u16.gz')).body))).toBe(hashBytes(bin));
    expect(existsSync(join(tmp, 'projects', 'beta', '.autosave'))).toBe(false);
    // the source is unchanged
    expect(JSON.parse((await rawRequest('GET', '/api/projects/alpha/file/project.json')).body.toString())).toEqual(doc);
    // default name, conflicts and invalid targets
    const r2 = await rawRequest('POST', '/api/projects/alpha/duplicate', JSON.stringify({ id: 'gamma' }));
    expect(r2.status).toBe(200);
    expect(JSON.parse((await rawRequest('GET', '/api/projects/gamma/file/project.json')).body.toString()).name).toBe('Alpha project copy');
    expect((await rawRequest('POST', '/api/projects/alpha/duplicate', JSON.stringify({ id: 'beta' }))).status).toBe(409);
    expect((await rawRequest('POST', '/api/projects/alpha/duplicate', JSON.stringify({ id: '../evil' }))).status).toBe(400);
    expect((await rawRequest('POST', '/api/projects/alpha/duplicate', JSON.stringify({}))).status).toBe(400);
    expect(existsSync(join(tmp, 'evil'))).toBe(false);
    await rawRequest('DELETE', '/api/projects/alpha/autosave');
  });

  it('deletes a project', async () => {
    expect(jsonOf(await rawRequest('DELETE', '/api/projects/gamma'))).toEqual({ ok: true });
    expect(existsSync(join(tmp, 'projects', 'gamma'))).toBe(false);
    expect((await rawRequest('GET', '/api/projects/gamma/file/project.json')).status).toBe(404);
    const ids = jsonOf(await rawRequest('GET', '/api/projects')).map((p) => p.id);
    expect(ids).toContain('alpha');
    expect(ids).toContain('beta');
    expect(ids).not.toContain('gamma');
    // deleting something that does not exist is not an error and touches nothing else
    expect((await rawRequest('DELETE', '/api/projects/gamma')).status).toBe(200);
    expect(existsSync(join(tmp, 'projects', 'alpha', 'project.json'))).toBe(true);
  });

  it('rejects path traversal, absolute paths and malformed ids with 400', async () => {
    const outside = join(tmp, 'secret.txt');
    const cases = [
      ['GET', '/api/projects/..%2Falpha/file/project.json'],
      ['GET', '/api/projects/alpha%2F..%2F..%2Fsecret/file/x'],
      ['PUT', '/api/projects/%2Fetc/file/passwd'],
      ['PUT', '/api/projects/.hidden/file/project.json'],
      ['PUT', '/api/projects/has%20space/file/project.json'],
      ['PUT', '/api/projects/' + 'x'.repeat(100) + '/file/project.json'],
      ['DELETE', '/api/projects/..%2F..%2Fprojects'],
      ['GET', '/api/projects/..%5Calpha/package'],
      ['GET', '/api/projects/alpha/file/..%2F..%2Fsecret.txt'],
      ['PUT', '/api/projects/alpha/file/..%2F..%2Fsecret.txt'],
      ['PUT', '/api/projects/alpha/file/%2Ftmp%2Fabs.txt'],
      ['GET', '/api/projects/alpha/file/.autosave'],
      ['PUT', '/api/projects/alpha/file/sub%5Cdir.bin'],
      ['PUT', '/api/projects/alpha/file/..'.replace('..', '%252e%252e')],
      ['PUT', '/api/projects/alpha/export/..%2F..%2Fx/scene.glb'],
      ['PUT', '/api/projects/alpha/export/20260101/..%2Fscene.glb'],
      ['PUT', '/api/projects/alpha/export/%2Ftmp/scene.glb'],
    ];
    for (const [method, path] of cases) {
      const r = await rawRequest(method, path, method === 'PUT' ? 'malicious' : undefined);
      if (r.status !== 400) throw new Error(`${method} ${path} returned ${r.status}, expected 400`);
      expect(typeof jsonOf(r).error).toBe('string');
    }
    // literal / percent-encoded dot segments are resolved by the URL parser before routing, so they
    // can only ever address another (unknown) endpoint: a client error, and nothing is touched
    for (const [method, path] of [
      ['GET', '/api/projects/%2e%2e/file/project.json'],
      ['GET', '/api/projects/../file/project.json'],
      ['PUT', '/api/projects/alpha/file/%2e%2e/%2e%2e/secret.txt'],
      ['DELETE', '/api/projects/%2e%2e'],
      ['DELETE', '/api/projects/alpha/..'],
      ['GET', '/api/projects/%2e%2e/package'],
      ['PUT', '/api/projects/alpha/export/../../../x/scene.glb'],
    ]) {
      const r = await rawRequest(method, path, method === 'PUT' ? 'malicious' : undefined);
      if (!(r.status >= 400 && r.status < 500)) throw new Error(`${method} ${path} returned ${r.status}, expected a 4xx`);
    }
    expect(existsSync(outside)).toBe(false);
    expect(existsSync(join(tmp, 'x'))).toBe(false);
    expect(readdirSync(tmp).sort()).toEqual(['exports', 'projects'].filter((d) => existsSync(join(tmp, d))));
    // the projects are still there (a traversal DELETE did not wipe the store)
    expect(existsSync(join(tmp, 'projects', 'alpha', 'project.json'))).toBe(true);
    // unknown endpoints are 404, not 500
    expect((await rawRequest('GET', '/api/nothing')).status).toBe(404);
    expect((await rawRequest('POST', '/api/projects/alpha/file/project.json', 'x')).status).toBe(404);
  });

  it('stores export files under the exports directory', async () => {
    const r = await rawRequest('PUT', '/api/projects/alpha/export/20261111-120000/scene.glb', Buffer.from([0x67, 0x6c, 0x54, 0x46, 1, 2, 3]));
    expect(r.status).toBe(200);
    expect(jsonOf(r)).toMatchObject({ ok: true, bytes: 7, path: join('exports', 'alpha', '20261111-120000', 'scene.glb') });
    expect(Array.from(readFileSync(join(tmp, 'exports', 'alpha', '20261111-120000', 'scene.glb')))).toEqual([0x67, 0x6c, 0x54, 0x46, 1, 2, 3]);
    // exports never land in the project folder
    expect(readdirSync(join(tmp, 'projects', 'alpha')).sort()).toEqual(['heights.u16.gz', 'project.json']);
  });

  it('downloads a package that is a valid gzip tarball containing the project', async () => {
    // reference one small texture so the package also carries assets
    const manifest = loadManifest();
    const texId = Object.keys(manifest.textures)[0];
    await rawRequest('PUT', '/api/projects/alpha/file/assets.lock.json', JSON.stringify({ models: [{ id: 'proc_reed', files: [] }, { id: 'no_such_model', files: [] }], textures: [{ id: texId }] }));
    await rawRequest('PUT', '/api/projects/alpha/file/project.json?autosave=1', '{"autosave":true}');
    const r = await rawRequest('GET', '/api/projects/alpha/package');
    expect(r.status).toBe(200);
    expect(r.headers['content-type']).toBe('application/gzip');
    expect(r.headers['content-disposition']).toBe('attachment; filename="alpha.terraforge.tar.gz"');
    expect(r.body[0]).toBe(0x1f);
    expect(r.body[1]).toBe(0x8b);
    const tar = gunzipSync(r.body);
    expect(tar.length % 512).toBe(0);
    const entries = readTar(tar);
    const names = entries.map((e) => e.name);
    expect(names).toContain('alpha/project/project.json');
    expect(names).toContain('alpha/project/heights.u16.gz');
    expect(names).toContain('alpha/project/assets.lock.json');
    expect(names).toContain('alpha/assets/manifest.json');
    expect(names).toContain('alpha/README.txt');
    expect(names.some((n) => n.includes('.autosave'))).toBe(false);
    expect(JSON.parse(entries.find((e) => e.name === 'alpha/project/project.json').data.toString())).toEqual(doc);
    expect(hashBytes(new Uint8Array(entries.find((e) => e.name === 'alpha/project/heights.u16.gz').data))).toBe(hashBytes(bin));
    // referenced texture files are included and listed in the packaged manifest subset
    const sub = JSON.parse(entries.find((e) => e.name === 'alpha/assets/manifest.json').data.toString());
    expect(Object.keys(sub.textures)).toEqual([texId]);
    for (const f of Object.values(manifest.textures[texId].files)) {
      const e = entries.find((q) => q.name === `alpha/assets/${f}`);
      expect(e).toBeDefined();
      expect(e.data.length).toBe(statSync(join(api.ASSETS_DIR, f)).size);
    }
    const readme = entries.find((e) => e.name === 'alpha/README.txt').data.toString();
    expect(readme).toMatch(/Terraforge project package: Alpha project/);
    expect(readme).toMatch(/WARNING: assets missing at packaging time: no_such_model/); // procedural models are not "missing"
    expect((await rawRequest('GET', '/api/projects/ghost/package')).status).toBe(404);
    await rawRequest('DELETE', '/api/projects/alpha/autosave');
  });
});

// ---------------------------------------------------------------------------------------------
// save -> load equivalence through the editor's store client
// ---------------------------------------------------------------------------------------------
describe('save -> load round trip (src/editor/store.js)', () => {
  let store, manifest, world, loaded, world2;

  /** Heights / sediment that are fixed points of the on-disk quantisation, so a reload is bit-identical. */
  const stableInputs = () => {
    let h = syntheticHeights();
    for (let pass = 0; pass < 2; pass++) {
      const q = quantizeHeights(h);
      h = dequantizeHeights(q.u16, q.hMin, q.hMax);
    }
    const n = new Noise2D(8);
    const sed = new Float32Array(RES * RES);
    for (let iz = 0; iz < RES; iz++) for (let ix = 0; ix < RES; ix++) sed[iz * RES + ix] = Math.max(0, n.fbm(ix / 30, iz / 30, 2));
    return { heights: h, sediment: sedimentFromU8(sedimentToU8(sed)) };
  };
  const paintSomething = (w) => {
    const blk = (arr, x0, z0, x1, z1, v) => {
      for (let iz = z0; iz <= z1; iz++) for (let ix = x0; ix <= x1; ix++) arr[iz * RES + ix] = v;
    };
    blk(w.paint.biome, 20, 20, 70, 60, 4); // force "meadow" over a block of forest
    blk(w.paint.exclude, 180, 30, 215, 60, 255);
    w.paint.mat[2] = new Uint8Array(RES * RES);
    blk(w.paint.mat[2], 30, 180, 60, 215, 220); // painted scree
    w.paint.density.trees = new Uint8Array(RES * RES).fill(128);
    blk(w.paint.density.trees, 190, 150, 240, 200, 20); // thinned trees
  };

  beforeAll(async () => {
    ({ store } = await import('../src/editor/store.js'));
    manifest = loadManifest();
    const inputs = stableInputs();
    world = buildTestWorld(manifest, { id: 'roundtrip', heights: inputs.heights, sediment: inputs.sediment, derive: false });
    paintSomething(world);
    const ringN = new Noise2D(4);
    const ring = new Float32Array(33 * 33);
    for (let i = 0; i < ring.length; i++) ring[i] = 100 + ringN.noise((i % 33) / 5, ((i / 33) | 0) / 5) * 30;
    world.ring = { res: 33, size: SIZE * 2, data: ring };
    world.deriveAll();
    // suppress one tree instance and one whole lattice key that does not exist
    const cell = [...world.scatterCells.values()].find((c) => (c.layers.get('mixed_forest/trees')?.count || 0) > 3);
    const l = cell.layers.get('mixed_forest/trees');
    world.suppressed.add(`trees:${l.keys[0]}:${l.keys[1]}`);
    world.generateScatterCell(cell.cx, cell.cz);
    await store.save(world, manifest);
    loaded = await store.load('roundtrip');
    world2 = new World(loaded.doc, loaded.data, manifest);
    world2.deriveAll();
  });

  it('writes the documented project folder', () => {
    const dir = join(tmp, 'projects', 'roundtrip');
    expect(readdirSync(dir).sort()).toEqual(['assets.lock.json', 'heights.q.gz', 'paint.bin.gz', 'project.json', 'ring.u16.gz', 'sediment.u8.gz']);
    const onDisk = JSON.parse(readFileSync(join(dir, 'project.json'), 'utf8'));
    expect(onDisk.version).toBe(PROJECT_VERSION);
    expect(onDisk.id).toBe('roundtrip');
    expect(onDisk.terrain.heightFormat).toBe('q1024-delta-i32');
    expect(onDisk.terrain.hMin).toBeUndefined();
    expect(onDisk.terrain.ring).toMatchObject({ res: 33, size: SIZE * 2 });
    expect(onDisk.scatter.suppressed).toEqual([...world.suppressed]);
    expect(onDisk.scatter.suppressed.length).toBe(1);
    // the asset lock lists every referenced model / texture with its files
    const lock = JSON.parse(readFileSync(join(dir, 'assets.lock.json'), 'utf8'));
    const refs = referencedAssets(onDisk);
    expect(lock.models.map((m) => m.id).sort()).toEqual([...refs.models].sort());
    expect(lock.textures.map((t) => t.id).sort()).toEqual([...refs.textures].sort());
    expect(refs.models).toContain('wine_barrel_01');
    expect(lock.models.find((m) => m.id === 'wine_barrel_01').files).toEqual(manifest.models.wine_barrel_01.lods.map((q) => q.file));
    expect(lock.models.find((m) => m.id === 'proc_reed').files).toEqual([]);
    expect(lock.textures.every((t) => t.files.length >= 3)).toBe(true);
    // heights are stored losslessly: gzip'd byte planes of delta-coded int32 (1/1024 m fixed point)
    const raw = gunzipSync(readFileSync(join(dir, 'heights.q.gz')));
    expect(raw.length).toBe(RES * RES * 4);
    // every in-memory height is on the storage grid, so the reload below is bit-identical
    for (let i = 0; i < world.hUser.data.length; i += 97) expect(world.hUser.data[i] * 1024).toBe(Math.round(world.hUser.data[i] * 1024));
    // the project appears in the list
    expect(existsSync(join(dir, '.autosave'))).toBe(false);
  });

  it('reloads the authoritative layers bit for bit', () => {
    expect(loaded.doc).toEqual(JSON.parse(JSON.stringify(world.project)));
    expect(hashBytes(loaded.data.heights)).toBe(hashBytes(world.hUser.data));
    expect(hashBytes(loaded.data.sediment)).toBe(hashBytes(world.sediment));
    expect(hashBytes(loaded.data.paint.biome)).toBe(hashBytes(world.paint.biome));
    expect(hashBytes(loaded.data.paint.exclude)).toBe(hashBytes(world.paint.exclude));
    expect(hashBytes(loaded.data.paint.mat[2])).toBe(hashBytes(world.paint.mat[2]));
    expect(loaded.data.paint.mat.filter(Boolean).length).toBe(1);
    expect(hashBytes(loaded.data.paint.density.trees)).toBe(hashBytes(world.paint.density.trees));
    expect(loaded.data.ring).toMatchObject({ res: 33, size: SIZE * 2 });
    const step = (loaded.doc.terrain.ring.hMax - loaded.doc.terrain.ring.hMin) / 65535;
    for (let i = 0; i < world.ring.data.length; i++) expect(Math.abs(loaded.data.ring.data[i] - world.ring.data[i])).toBeLessThanOrEqual(step / 2 + 1e-4);
    expect([...world2.suppressed]).toEqual([...world.suppressed]);
  });

  it('derives an identical world after reload (terrain, water, materials, scatter)', () => {
    // the fixture exercises every derived system
    expect(world.water.stats.riverCells).toBeGreaterThan(500);
    expect(world.water.stats.lakeCells[0]).toBeGreaterThan(100);
    expect(world.water.stats.oceanCells).toBeGreaterThan(20);
    expect(scatterTotals(world).total).toBeGreaterThan(3000);
    let carved = 0;
    for (let i = 0; i < RES * RES; i++) if (world.hFinal.data[i] !== world.hUser.data[i]) carved++;
    expect(carved).toBeGreaterThan(2000);
    for (const [name, a, b] of [
      ['hUser', world.hUser.data, world2.hUser.data],
      ['hFinal', world.hFinal.data, world2.hFinal.data],
      ['water.surf', world.water.surf, world2.water.surf],
      ['water.type', world.water.type, world2.water.type],
      ['water.vx', world.water.vx, world2.water.vx],
      ['water.vz', world.water.vz, world2.water.vz],
      ['water.foam', world.water.foam, world2.water.foam],
      ['water.shore', world.water.shore, world2.water.shore],
      ['weights', world.weights, world2.weights],
      ['biomeMap', world.biomeMap, world2.biomeMap],
      ['moisture', world.moisture, world2.moisture],
      ['masks.road', world.masks.road, world2.masks.road],
      ['masks.channel', world.masks.channel, world2.masks.channel],
      ['masks.pad', world.masks.pad, world2.masks.pad],
    ]) {
      if (hashBytes(a) !== hashBytes(b)) throw new Error(`${name} differs after save -> load`);
    }
    expect(world2.scatterCells.size).toBe(world.scatterCells.size);
    let instances = 0;
    for (const [key, cell] of world.scatterCells) {
      const other = world2.scatterCells.get(key);
      expect([...other.layers.keys()]).toEqual([...cell.layers.keys()]);
      for (const [lk, l] of cell.layers) {
        const o = other.layers.get(lk);
        if (o.count !== l.count || hashBytes(o.data) !== hashBytes(l.data)) throw new Error(`scatter cell ${key} layer ${lk} differs after save -> load`);
        instances += l.count;
      }
    }
    expect(instances).toBeGreaterThan(3000);
    for (const s of world.project.structures) expect(world2.structureLevel(s)).toBe(world.structureLevel(s));
    // the paint layers had an effect, so their persistence matters
    expect(world2.biomeMap[40 * RES + 40]).toBe(4);
    let inExcluded = 0;
    for (const cell of world2.scatterCells.values()) {
      for (const l of cell.layers.values()) {
        for (let i = 0; i < l.count; i++) {
          const ix = Math.round(world2.hFinal.toGridX(l.data[i * 8])),
            iz = Math.round(world2.hFinal.toGridZ(l.data[i * 8 + 2]));
          if (ix >= 180 && ix <= 215 && iz >= 30 && iz <= 60) inExcluded++;
        }
      }
    }
    expect(inExcluded).toBe(0);
  });

  it('saving the reloaded world again is idempotent', async () => {
    const dir = join(tmp, 'projects', 'roundtrip');
    const before = Object.fromEntries(['heights.q.gz', 'sediment.u8.gz', 'paint.bin.gz', 'ring.u16.gz'].map((f) => [f, hashBytes(new Uint8Array(gunzipSync(readFileSync(join(dir, f)))))]));
    await store.save(world2, manifest);
    const after = Object.fromEntries(Object.keys(before).map((f) => [f, hashBytes(new Uint8Array(gunzipSync(readFileSync(join(dir, f)))))]));
    expect(after).toEqual(before);
    const again = await store.load('roundtrip');
    expect(hashBytes(again.data.heights)).toBe(hashBytes(world.hUser.data));
    expect({ ...again.doc, modified: null }).toEqual({ ...JSON.parse(JSON.stringify(world.project)), modified: null });
  });

  it('autosaves into a separate slot and reports incomplete or too-new projects', async () => {
    const dir = join(tmp, 'projects', 'roundtrip');
    const savedHeights = hashBytes(new Uint8Array(readFileSync(join(dir, 'heights.q.gz'))));
    // edit: raise a hill, autosave
    const i = 128 * RES + 200;
    const old = world2.hUser.data[i];
    world2.hUser.data[i] = old + 4;
    await store.save(world2, manifest, { autosave: true });
    expect(readdirSync(join(dir, '.autosave')).sort()).toEqual(['assets.lock.json', 'heights.q.gz', 'paint.bin.gz', 'project.json', 'ring.u16.gz', 'sediment.u8.gz']);
    expect(hashBytes(new Uint8Array(readFileSync(join(dir, 'heights.q.gz'))))).toBe(savedHeights);
    const main = await store.load('roundtrip');
    expect(main.data.heights[i]).toBe(old);
    const auto = await store.load('roundtrip', { autosave: true });
    expect(auto.data.heights[i]).toBeGreaterThan(old + 3.9);
    expect(auto.data.ring.res).toBe(33);
    world2.hUser.data[i] = old;
    // a regular save clears the autosave slot
    await store.save(world2, manifest);
    expect(existsSync(join(dir, '.autosave'))).toBe(false);
    await expect(store.load('roundtrip', { autosave: true })).rejects.toThrow(/incomplete/);
    // store helpers
    const list = await store.list();
    expect(list.find((p) => p.id === 'roundtrip')).toMatchObject({ name: 'Test world', preset: 'lake', size: SIZE });
    await store.duplicate('roundtrip', 'roundtrip-copy', 'Copy');
    const copy = await store.load('roundtrip-copy');
    expect(copy.doc.name).toBe('Copy');
    expect(hashBytes(copy.data.heights)).toBe(hashBytes(main.data.heights));
    await expect(store.duplicate('roundtrip', 'roundtrip-copy')).rejects.toThrow(/target exists/);
    const exp = await store.exportFile('roundtrip', 'stamp1', 'placements.json', new TextEncoder().encode('{}'));
    expect(exp.bytes).toBe(2);
    // missing / mismatching layers are reported clearly
    await rawRequest('PUT', '/api/projects/newer/file/project.json', JSON.stringify({ ...main.doc, id: 'newer', name: 'Future', version: PROJECT_VERSION + 1 }));
    await expect(store.load('newer')).rejects.toThrow(/newer version/);
    await rawRequest('PUT', '/api/projects/partial/file/project.json', JSON.stringify({ ...main.doc, id: 'partial' }));
    await expect(store.load('partial')).rejects.toThrow(/incomplete/);
    await rawRequest('PUT', '/api/projects/partial/file/heights.q.gz', Buffer.from(await packHeights(new Float32Array(100))));
    await expect(store.load('partial')).rejects.toThrow(/height layer has 100 samples, expected/);
    await expect(store.load('does-not-exist')).rejects.toThrow(/incomplete/);
    await store.remove('roundtrip-copy');
    await expect(store.load('roundtrip-copy')).rejects.toThrow();
  });

  it('serializeWorld / deserializeProject round-trip in memory (no server)', async () => {
    const files = await serializeWorld(world2, manifest, { timestamp: '2026-01-02T03:04:05.000Z' });
    expect(Object.keys(files).sort()).toEqual(['assets.lock.json', 'heights.q.gz', 'paint.bin.gz', 'project.json', 'ring.u16.gz', 'sediment.u8.gz']);
    for (const f of Object.values(files)) expect(f).toBeInstanceOf(Uint8Array);
    const reads = [];
    const back = await deserializeProject(async (name, optional) => {
      reads.push([name, !!optional]);
      return files[name] ?? null;
    });
    expect(reads[0]).toEqual(['project.json', false]);
    expect(reads.filter((r) => !r[1]).map((r) => r[0]).sort()).toEqual(['heights.q.gz', 'project.json']); // only these two are mandatory
    expect(back.doc.modified).toBe('2026-01-02T03:04:05.000Z');
    expect(hashBytes(back.data.heights)).toBe(hashBytes(world2.hUser.data));
    expect(hashBytes(back.data.sediment)).toBe(hashBytes(world2.sediment));
    expect(hashBytes(back.data.paint.biome)).toBe(hashBytes(world2.paint.biome));
    // optional layers may be absent: neutral defaults
    const minimal = await deserializeProject(async (name) => (name === 'project.json' || name === 'heights.q.gz' ? files[name] : null));
    expect(minimal.data.ring).toBeNull();
    expect(minimal.data.sediment.every((v) => v === 0)).toBe(true);
    expect(minimal.data.paint.biome.every((v) => v === 0)).toBe(true);
    expect(hashBytes(minimal.data.heights)).toBe(hashBytes(world2.hUser.data));
    // ring: false omits the surrounding terrain
    const noRing = await serializeWorld(world2, manifest, { ring: false });
    expect(Object.keys(noRing)).not.toContain('ring.u16.gz');
  });

  it('createProjectDoc + referencedAssets describe a self-contained document', () => {
    const { doc, missing } = createProjectDoc({ name: 'doc', preset: 'coast', seed: 9, manifest });
    expect(missing).toEqual([]);
    expect(doc.version).toBe(PROJECT_VERSION);
    expect(doc.water.sea.enabled).toBe(true);
    expect(JSON.parse(JSON.stringify(doc))).toEqual(doc); // plain JSON, no class instances or undefined
    const refs = referencedAssets(doc);
    expect(refs.models.length).toBeGreaterThan(10);
    for (const m of refs.models) expect(m.startsWith('proc_') || !!manifest.models[m]).toBe(true);
    for (const t of refs.textures) expect(manifest.textures[t]).toBeDefined();
    expect(refs.textures.length).toBe(9);
  });
});
