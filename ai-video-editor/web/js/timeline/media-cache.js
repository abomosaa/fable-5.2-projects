// Lazy caches for the media drawn inside timeline clips: audio waveform peaks and
// video thumbnail sprites. Both come from files the server generated from the real
// media at import time.
import { mediaUrl } from '../lib/api.js';

const listeners = new Set();
/** Called whenever something finished loading (the timeline redraws). */
export function onMediaLoaded(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
const notify = () => listeners.forEach((fn) => fn());

// ---- waveforms ------------------------------------------------------------------
// File format "CWF1": u32 peaks-per-second, u32 count, then count × u16 LE peaks.
const waves = new Map(); // assetId → { state: 'loading'|'ready'|'error', pps, levels: Uint16Array[] }

function buildLevels(base) {
  // mip pyramid: level k holds the max over 2^k base peaks
  const levels = [base];
  let cur = base;
  while (cur.length > 64) {
    const next = new Uint16Array(Math.ceil(cur.length / 2));
    for (let i = 0; i < next.length; i++) {
      const a = cur[i * 2];
      const b = cur[i * 2 + 1] || 0;
      next[i] = a > b ? a : b;
    }
    levels.push(next);
    cur = next;
  }
  return levels;
}

/** Waveform data for an asset record, or null while it is loading / unavailable. */
export function getWaveform(record) {
  if (!record?.waveform) return null;
  let w = waves.get(record.id);
  if (!w) {
    w = { state: 'loading', pps: 100, levels: [] };
    waves.set(record.id, w);
    fetch(mediaUrl(record.id, 'waveform.bin'))
      .then((r) => (r.ok ? r.arrayBuffer() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((buf) => {
        const dv = new DataView(buf);
        if (buf.byteLength < 12 || dv.getUint32(0, false) !== 0x43574631) throw new Error('bad waveform file');
        const pps = dv.getUint32(4, true);
        const n = Math.min(dv.getUint32(8, true), (buf.byteLength - 12) >> 1);
        const base = new Uint16Array(n);
        for (let i = 0; i < n; i++) base[i] = dv.getUint16(12 + i * 2, true);
        w.pps = pps;
        w.levels = buildLevels(base);
        w.state = 'ready';
        notify();
      })
      .catch(() => {
        w.state = 'error';
      });
  }
  return w.state === 'ready' ? w : null;
}

/** Peak (0..1) of the source range [s0, s1) seconds. */
export function peakBetween(w, s0, s1) {
  const base = w.levels[0];
  let i0 = Math.floor(s0 * w.pps);
  let i1 = Math.ceil(s1 * w.pps);
  if (i1 <= i0) i1 = i0 + 1;
  if (i1 <= 0 || i0 >= base.length) return 0;
  i0 = Math.max(0, i0);
  i1 = Math.min(base.length, i1);
  // pick the mip level where the range covers ~1–2 entries
  let level = 0;
  const span = i1 - i0;
  while (level < w.levels.length - 1 && span >> (level + 1) >= 1) level++;
  const arr = w.levels[level];
  const a = i0 >> level;
  const b = Math.min(arr.length, Math.max(a + 1, Math.ceil(i1 / (1 << level))));
  let m = 0;
  for (let i = a; i < b; i++) if (arr[i] > m) m = arr[i];
  return m / 65535;
}

// ---- thumbnail sprites ----------------------------------------------------------
const images = new Map(); // url → { img, state }

function getImage(url) {
  let e = images.get(url);
  if (!e) {
    const img = new Image();
    e = { img, state: 'loading' };
    images.set(url, e);
    img.decoding = 'async';
    img.onload = () => {
      e.state = 'ready';
      notify();
    };
    img.onerror = () => {
      e.state = 'error';
    };
    img.src = url;
  }
  return e.state === 'ready' ? e.img : null;
}

/** Filmstrip sprite for a video asset record ({img, sprite}) or null. */
export function getThumbs(record) {
  if (!record?.thumbs) return null;
  const img = getImage(mediaUrl(record.id, 'thumbs.jpg'));
  return img ? { img, sprite: record.thumbs } : null;
}

/** Poster image (stills, or videos whose filmstrip is not ready yet). */
export function getPoster(record) {
  if (!record?.poster) return null;
  return getImage(mediaUrl(record.id, 'poster.jpg'));
}
