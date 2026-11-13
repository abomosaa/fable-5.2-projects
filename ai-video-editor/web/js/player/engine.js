// Preview engine: slaves media elements to the transport clock and composites the
// current frame.
//
// * Timing, opacity, gain and slides come exclusively from the server-resolved
//   `state.layers` (the same data the FFmpeg export is planned from).
// * Clip properties come from `doc.clips` through `liveClip()` so un-committed
//   inspector / gizmo edits preview instantly.
// * Video and audio elements never drive time; they follow `transport.time`:
//   small drift is corrected by nudging playbackRate, large drift by seeking.
// * Upcoming layers are pre-rolled (element created, seeked, paused) so cuts are
//   seamless; source-contiguous cuts (a split) keep playing on the same element.

import { liveClip, store } from '../state/store.js';
import { mediaUrl } from '../lib/api.js';
import { TPS, layerEnvelope, layerOffsetX, layerSourceAt } from '../lib/time.js';
import { transport } from './transport.js';
import { createCompositor } from './compositor.js';
import { loadTextFonts, onTextFontsLoaded, rasterText, setTextEvictHandler, textQuad } from './text.js';

const PREROLL_SECONDS = 1.5;
const STALL_TIMEOUT_MS = 1500;
// Drift control for playing elements (seconds). Small drift is closed by running the
// element a few percent fast/slow (a step controller with hysteresis, so the rate
// changes rarely); large drift by re-seeking. Thresholds are tighter while an element
// has only just started.
const HARD_DRIFT = { video: 0.2, audio: 0.25 };
const SETTLE_DRIFT = { video: 0.12, audio: 0.15 };
const SETTLE_MS = 1500;
const DEAD_ZONE = 0.025;
const RESYNC_COOLDOWN_MS = 700;
const MAX_LEAD = 0.12;
const SEEK_EPS = 0.002;
/** Lands safely inside the frame that contains a source instant. */
const FRAME_EPS = 0.0005;
const MAX_PREROLL = 3; // upcoming, non-contiguous layers pre-rolled per pool
const MAX_IDLE_VIDEO = 3;
const MAX_IDLE_AUDIO = 4;
const IDLE_UNLOAD_MS = 8000;
const MAX_BACKING_WIDTH = 1920;
const VOLUME_KEY = 'cutline:volume';

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const now = () => performance.now();

// ---------------------------------------------------------------------------------
// state
// ---------------------------------------------------------------------------------
let canvas = null;
let comp = null;
let resizeObs = null;
let unsubStore = null;
let unsubTransport = null;
let unsubFonts = null;
let rafPending = 0;
let attached = false;

let seenLayers = null;
let seenDoc = null;
let seenLive = null;
let seenAssets = null;
let index = { bucket: TPS, buckets: new Map(), count: 0 };

const listeners = new Set();
const frameListeners = new Set();
let status = { state: 'empty', message: '', progress: null, assetId: null };

const counters = { frames: 0, late: 0, lastRenderMs: 0, maxRenderMs: 0, sumRenderMs: 0, updates: 0, sumUpdateMs: 0, maxUpdateMs: 0, indexBuilds: 0, lastIndexMs: 0, stalls: 0, lastStallMs: 0, maxStallMs: 0, hardSeeks: 0, lastTickAt: 0 };
let stallStartedAt = 0;
let stalledByEngine = false;
/** Geometry of what was drawn last frame, for hit testing and the gizmo. */
let drawn = [];
let lastW = 1920;
let lastH = 1080;

// audio graph
let audioCtx = null;
let masterGain = null;
let volume = { v: 1, muted: false };
try {
  const saved = JSON.parse(localStorage.getItem(VOLUME_KEY) || 'null');
  if (saved && Number.isFinite(saved.v)) volume = { v: clamp(saved.v, 0, 1.5), muted: !!saved.muted };
} catch {
  /* defaults */
}

// ---------------------------------------------------------------------------------
// layer index: time buckets so per-frame work is O(active layers)
// ---------------------------------------------------------------------------------
function buildIndex(layers, doc) {
  const buckets = new Map();
  let maxEnd = 0;
  let count = 0;
  for (const l of layers.values()) if (l.active && l.end > maxEnd) maxEnd = l.end;
  const bucket = Math.max(TPS, Math.ceil(maxEnd / 8192));
  for (const l of layers.values()) {
    if (!l.active || !doc.clips.has(l.clip_id) || l.end <= l.start) continue;
    count++;
    const b0 = Math.floor(Math.max(0, l.start) / bucket);
    const b1 = Math.floor(Math.max(0, l.end - 1) / bucket);
    for (let b = b0; b <= b1; b++) {
      let arr = buckets.get(b);
      if (!arr) buckets.set(b, (arr = []));
      arr.push(l);
    }
  }
  return { bucket, buckets, count };
}

/** Layers overlapping [t0, t1] (inclusive start, exclusive end). */
function queryLayers(t0, t1) {
  const b0 = Math.floor(Math.max(0, t0) / index.bucket);
  const b1 = Math.floor(Math.max(0, t1) / index.bucket);
  if (b0 === b1) {
    const arr = index.buckets.get(b0);
    return arr ? arr.filter((l) => l.start <= t1 && l.end > t0) : [];
  }
  const seen = new Set();
  const out = [];
  for (let b = b0; b <= b1; b++) {
    const arr = index.buckets.get(b);
    if (!arr) continue;
    for (const l of arr) {
      if (l.start <= t1 && l.end > t0 && !seen.has(l.clip_id)) {
        seen.add(l.clip_id);
        out.push(l);
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------
// media sources
// ---------------------------------------------------------------------------------
function videoUrl(rec) {
  if (!rec) return null;
  if (rec.proxy) return mediaUrl(rec.id, 'proxy.mp4');
  if (rec.playable_original) return mediaUrl(rec.id, 'original');
  return null;
}
function audioUrl(rec) {
  if (!rec) return null;
  if (rec.audio) return mediaUrl(rec.id, 'audio.m4a');
  if (rec.playable_original) return mediaUrl(rec.id, 'original');
  if (rec.proxy && rec.info?.has_audio) return mediaUrl(rec.id, 'proxy.mp4');
  return null;
}

/** @type {Map<string, {img: HTMLImageElement, ready: boolean, error: boolean, url: string}>} */
const images = new Map();
function imageFor(rec) {
  if (!rec || !rec.preview_image) return null;
  let e = images.get(rec.id);
  if (!e) {
    const img = new Image();
    e = { img, ready: false, error: false, url: mediaUrl(rec.id, 'preview.png') };
    img.decoding = 'async';
    img.onload = () => {
      e.ready = true;
      requestUpdate();
    };
    img.onerror = () => {
      e.error = true;
      requestUpdate();
    };
    img.src = e.url;
    images.set(rec.id, e);
  }
  return e;
}

// ---------------------------------------------------------------------------------
// media element pools
// ---------------------------------------------------------------------------------
function ensureAudioGraph() {
  if (audioCtx || audioCtx === false) return;
  const Ctx = window.AudioContext || window.webkitAudioContext;
  if (!Ctx) {
    audioCtx = false; // WebAudio unavailable: fall back to element.volume
    return;
  }
  try {
    audioCtx = new Ctx({ latencyHint: 'interactive' });
    masterGain = audioCtx.createGain();
    masterGain.gain.value = volume.muted ? 0 : volume.v;
    masterGain.connect(audioCtx.destination);
    const resume = () => {
      if (audioCtx && audioCtx.state === 'suspended') audioCtx.resume().catch(() => {});
    };
    window.addEventListener('pointerdown', resume, true);
    window.addEventListener('keydown', resume, true);
  } catch {
    audioCtx = false;
  }
}

function makeEntry(kind) {
  const el = document.createElement(kind === 'video' ? 'video' : 'audio');
  el.preload = 'auto';
  el.crossOrigin = 'anonymous';
  if (kind === 'video') {
    el.muted = true;
    el.playsInline = true;
    el.disablePictureInPicture = true;
  }
  if ('preservesPitch' in el) el.preservesPitch = true;
  const e = {
    kind,
    el,
    url: null,
    assetId: null,
    owner: null, // clip id
    last: null, // { end, srcEnd, num, den } of the owning layer (for contiguous hand-off)
    seeking: false,
    pendingSeek: null,
    error: null,
    version: 0, // bumped whenever the displayed frame may have changed
    texTime: -1,
    idleSince: 0,
    activeSince: 0,
    wasActive: false,
    gainNode: null,
    srcNode: null,
    targetGain: 0,
  };
  el.addEventListener('seeked', () => {
    e.seeking = false;
    e.version++;
    if (e.pendingSeek != null) {
      const t = e.pendingSeek;
      e.pendingSeek = null;
      if (Math.abs(el.currentTime - t) > SEEK_EPS) seekEntry(e, t);
    }
    requestUpdate();
  });
  el.addEventListener('loadedmetadata', () => {
    if (e.pendingSeek != null) {
      const t = e.pendingSeek;
      e.pendingSeek = null;
      seekEntry(e, t);
    }
  });
  for (const ev of ['loadeddata', 'canplay', 'playing']) {
    el.addEventListener(ev, () => {
      e.version++;
      requestUpdate();
    });
  }
  el.addEventListener('error', () => {
    if (!e.url) return; // we unloaded it on purpose
    e.error = 'This media could not be loaded for preview. Check that the server is running, then reload the page.';
    e.seeking = false;
    requestUpdate();
  });
  if (kind === 'audio') connectAudio(e);
  return e;
}

/** Route an audio element through the WebAudio graph (once; no-op until the graph exists). */
function connectAudio(e) {
  if (!audioCtx || e.srcNode) return;
  try {
    e.srcNode = audioCtx.createMediaElementSource(e.el);
    e.gainNode = audioCtx.createGain();
    e.gainNode.gain.value = 0;
    e.srcNode.connect(e.gainNode).connect(masterGain);
    e.el.volume = 1;
  } catch {
    e.srcNode = null;
    e.gainNode = null;
  }
}

function setSource(e, url, assetId) {
  if (e.url === url) return;
  e.url = url;
  e.assetId = assetId;
  e.error = null;
  e.seeking = false;
  e.pendingSeek = null;
  e.texTime = -1;
  e.version++;
  e.el.src = url;
  e.el.load();
}

function unload(e) {
  e.url = null;
  e.assetId = null;
  e.owner = null;
  e.last = null;
  e.seeking = false;
  e.pendingSeek = null;
  try {
    e.el.pause();
    e.el.removeAttribute('src');
    e.el.load(); // frees the decoder
  } catch {
    /* ignore */
  }
  if (e.kind === 'video') comp?.release(e.el);
}

function seekEntry(e, target) {
  const el = e.el;
  if (el.readyState < 1) {
    e.pendingSeek = target;
    return;
  }
  if (e.seeking || el.seeking) {
    e.pendingSeek = target; // coalesce: the latest target wins when the current seek lands
    return;
  }
  if (Math.abs(el.currentTime - target) <= SEEK_EPS) return;
  e.seeking = true;
  try {
    el.currentTime = target;
  } catch {
    e.seeking = false;
  }
}

function mediaDuration(e, asset) {
  const d = e.el.duration;
  if (Number.isFinite(d) && d > 0) return d;
  return asset ? asset.duration / TPS : 0;
}

// `lead`: measured start-up latency of play() (seconds, moving average) — pre-rolled
// elements are started that much early so they are already running at the cut.
// `seekLead`: how far a playing element falls behind across a re-seek.
const pools = {
  video: { entries: [], assign: new Map(), maxIdle: MAX_IDLE_VIDEO, lead: 0.03, seekLead: 0.03 },
  audio: { entries: [], assign: new Map(), maxIdle: MAX_IDLE_AUDIO, lead: 0.05, seekLead: 0.03 },
};

/** A hand-off candidate: an entry whose (previous) layer ends exactly where `layer` starts, source-contiguous. */
function contiguousEntry(pool, layer, url) {
  for (const e of pool.entries) {
    const p = e.last;
    if (!p || e.url !== url || e.error) continue;
    if (p.end === layer.start && p.num === layer.speed.num && p.den === layer.speed.den && Math.abs(p.srcEnd - layer.source_start) < TPS * 0.002) return e;
  }
  return null;
}

/**
 * Decide which element plays which layer.
 * @param wanted Map<clipId, {layer, url, assetId, active}>
 */
function assignPool(pool, kind, wanted, t) {
  const tNow = now();
  // 1. drop assignments that are no longer wanted (or whose source changed)
  for (const [clipId, e] of pool.assign) {
    const w = wanted.get(clipId);
    if (!w || w.url !== e.url) {
      pool.assign.delete(clipId);
      e.owner = null;
      e.idleSince = tNow;
      e.wasActive = false;
    }
  }
  // 2. assign wanted layers (active first so they win scarce elements)
  const order = [...wanted.entries()].sort((a, b) => Number(b[1].active) - Number(a[1].active) || a[1].layer.start - b[1].layer.start);
  // Upcoming layers that simply continue another wanted layer (a run of splits in
  // the same source) will be handed the already-playing element when their turn
  // comes, so they need no pre-roll of their own. Without this a densely cut
  // timeline would pre-roll one element per cut.
  const tails = new Map(); // `${url}|${end}` → layers ending there
  for (const [, w] of order) {
    const key = `${w.url}|${w.layer.end}`;
    (tails.get(key) || tails.set(key, []).get(key)).push(w.layer);
  }
  const continues = (w) =>
    (tails.get(`${w.url}|${w.layer.start}`) || []).some((p) => {
      const srcEnd = p.source_start + ((p.end - p.start) * p.speed.num) / p.speed.den;
      return p !== w.layer && p.speed.num === w.layer.speed.num && p.speed.den === w.layer.speed.den && Math.abs(srcEnd - w.layer.source_start) < TPS * 0.002;
    });
  let prerolled = 0;
  for (const [clipId, w] of order) {
    if (pool.assign.has(clipId)) {
      if (!w.active) prerolled++;
      continue;
    }
    if (!w.active && (continues(w) || prerolled >= MAX_PREROLL)) continue;
    if (!w.active) prerolled++;
    let e = null;
    if (w.active) {
      // contiguous cut: keep playing on the element that just finished the previous layer
      const c = contiguousEntry(pool, w.layer, w.url);
      if (c && !c.owner && t >= w.layer.start) e = c;
    } else if (contiguousEntry(pool, w.layer, w.url)?.owner) {
      continue; // the current element will carry straight on: no pre-roll needed
    }
    let handoff = !!e;
    if (!e) e = pool.entries.find((x) => !x.owner && x.url === w.url && !x.error);
    if (!e) e = pool.entries.find((x) => !x.owner && !x.url);
    if (!e) {
      // steal the longest-idle element rather than growing without bound
      const idle = pool.entries.filter((x) => !x.owner).sort((a, b) => a.idleSince - b.idleSince);
      if (idle.length >= pool.maxIdle) e = idle[0];
    }
    if (!e) {
      e = makeEntry(kind);
      pool.entries.push(e);
    }
    if (e.url !== w.url) {
      if (e.kind === 'video') comp?.release(e.el);
      setSource(e, w.url, w.assetId);
      handoff = false;
    }
    e.owner = clipId;
    e.handoff = handoff;
    e.wasActive = false;
    e.activeSince = 0;
    pool.assign.set(clipId, e);
  }
  // 3. idle housekeeping
  const idle = pool.entries.filter((x) => !x.owner);
  for (const e of idle) {
    if (!e.el.paused) e.el.pause();
    if (e.gainNode) e.gainNode.gain.value = 0;
    e.targetGain = 0;
  }
  const loadedIdle = idle.filter((x) => x.url).sort((a, b) => a.idleSince - b.idleSince);
  loadedIdle.forEach((e, i) => {
    if (loadedIdle.length - i > pool.maxIdle || tNow - e.idleSince > IDLE_UNLOAD_MS) unload(e);
  });
  // forget fully unloaded surplus elements
  if (pool.entries.length > 12) pool.entries = pool.entries.filter((x) => x.owner || x.url);
}

/**
 * Drive one element towards where the clock says it should be.
 * mode: 'play'     follow the clock (drift-corrected),
 *       'prestart' a pre-rolled element started slightly early (inaudible / invisible)
 *                  so it is already running when its layer begins,
 *       'hold'     paused on the right frame.
 * Returns { ready, outOfRange }.
 */
function drive(pool, e, layer, asset, t, mode, rate) {
  const el = e.el;
  const dur = mediaDuration(e, asset);
  const srcT = layerSourceAt(layer, Math.max(t, layer.start)) / TPS;
  const maxT = Math.max(0, dur - 0.02);
  const outOfRange = srcT < 0 || (dur > 0 && srcT > dur);
  const target = clamp(srcT + FRAME_EPS, 0, maxT);
  e.last = { end: layer.end, srcEnd: layerSourceAt(layer, layer.end), num: layer.speed.num, den: layer.speed.den };

  if (mode !== 'hold' && !outOfRange && el.readyState >= 1) {
    const base = clamp((layer.speed.num / layer.speed.den) * rate, 0.0625, 16);
    const tNow = now();
    if (el.paused) {
      // A hand-off or a pre-rolled element is already in place; otherwise line it up
      // first — ahead by the measured start-up latency, so that when it actually
      // starts producing output the clock has caught up with it.
      const lead = mode === 'play' && !e.handoff && pool.lead > 0.04 ? Math.min(MAX_LEAD, pool.lead) * base : 0;
      const startAt = clamp(target + lead, 0, maxT);
      if (Math.abs(el.currentTime - startAt) > 0.06 && !e.seeking) seekEntry(e, startAt);
      if (!e.seeking) {
        if (Math.abs(el.playbackRate - base) > 1e-4) el.playbackRate = base;
        e.playCalledAt = tNow;
        e.playFrom = el.currentTime;
        e.started = false;
        e.settleUntil = tNow + SETTLE_MS;
        e.resyncAt = 0;
        e.resyncCheckAt = 0;
        e.corr = 0;
        el.play().catch(() => {});
      }
    } else if (!el.seeking && !e.seeking) {
      if (!e.started) {
        if (el.currentTime > e.playFrom + 0.005) {
          // measure how long play() took to actually start, to start the next one on time
          e.started = true;
          const latency = (tNow - e.playCalledAt) / 1000 - (el.currentTime - e.playFrom) / base;
          if (latency >= 0 && latency < 1) pool.lead = clamp(pool.lead * 0.5 + latency * 0.5, 0, 0.3);
        } else if (tNow - e.playCalledAt > 800) {
          e.started = true; // not advancing (buffering): fall through to normal correction
        }
      }
      if (mode === 'play' && e.started) {
        let drift = el.currentTime - target;
        let dead = DEAD_ZONE;
        if (e.kind === 'video') {
          // a video reports the timestamp of the frame on screen, i.e. it reads up to one
          // frame "late" when perfectly in sync: centre the dead zone on half a frame
          const frame = asset?.fps ? asset.fps.den / asset.fps.num : 1 / 30;
          drift += frame / 2;
          dead += frame / 2;
        }
        if (e.resyncCheckAt && tNow >= e.resyncCheckAt) {
          // learn how far behind a re-seek leaves a playing element (bounded, cautious)
          e.resyncCheckAt = 0;
          if (Math.abs(drift) < 0.3) pool.seekLead = clamp(pool.seekLead - drift * 0.5, 0, MAX_LEAD);
        }
        const hard = (tNow < e.settleUntil ? SETTLE_DRIFT : HARD_DRIFT)[e.kind] * Math.max(1, base);
        if (Math.abs(drift) > hard && tNow - (e.resyncAt || 0) > RESYNC_COOLDOWN_MS) {
          counters.hardSeeks++;
          e.resyncAt = tNow;
          e.resyncCheckAt = tNow + 350;
          e.corr = 0;
          seekEntry(e, clamp(target + pool.seekLead * base, 0, maxT));
        } else {
          // step controller with hysteresis: engage outside the dead zone, release near zero
          const c = e.corr || 0;
          if (c === 0) e.corr = drift > dead ? -1 : drift < -dead ? 1 : 0;
          else if (c > 0 && drift > -dead / 3) e.corr = 0;
          else if (c < 0 && drift < dead / 3) e.corr = 0;
          const step = Math.abs(drift) > 0.09 ? 0.1 : 0.05;
          const want = clamp(base * (1 + (e.corr || 0) * step), 0.0625, 16);
          if (Math.abs(el.playbackRate - want) > 1e-4) el.playbackRate = want;
        }
      }
    }
  } else {
    if (!el.paused) el.pause();
    e.started = false;
    seekEntry(e, target);
  }
  const ready = el.readyState >= 2 && !el.seeking && !e.seeking;
  return { ready, outOfRange };
}

// ---------------------------------------------------------------------------------
// per-tick media sync
// ---------------------------------------------------------------------------------
function syncMedia(state, t) {
  const doc = state.doc;
  const playing = transport.playing;
  const rate = transport.rate;
  const forward = playing && rate > 0;
  const lookahead = forward ? PREROLL_SECONDS * TPS * rate : 0;
  const candidates = queryLayers(t, t + lookahead);

  const wantedV = new Map();
  const wantedA = new Map();
  const problems = [];
  for (const layer of candidates) {
    const clip = doc.clips.get(layer.clip_id);
    if (!clip) continue;
    const kind = clip.content.kind;
    if (kind !== 'video' && kind !== 'audio') continue;
    const active = layer.start <= t && layer.end > t;
    const rec = state.assets.get(clip.content.asset_id);
    const url = kind === 'video' ? videoUrl(rec) : audioUrl(rec);
    if (!url) {
      if (active && kind === 'video') problems.push({ rec, assetId: clip.content.asset_id, doc });
      continue;
    }
    (kind === 'video' ? wantedV : wantedA).set(layer.clip_id, { layer, url, assetId: clip.content.asset_id, active });
  }
  if (wantedA.size && forward) {
    ensureAudioGraph();
    if (audioCtx && audioCtx.state === 'suspended') audioCtx.resume().catch(() => {});
  }
  assignPool(pools.video, 'video', wantedV, t);
  assignPool(pools.audio, 'audio', wantedA, t);

  const tNow = now();
  let needStall = false;
  let mediaError = null;
  const stalled = transport.stalled;
  // A pre-rolled element is started a little before its layer begins (by the measured
  // start-up latency of play()), silent and undrawn, so it is running at the cut.
  const prestart = (pool, layer) => (forward && !stalled && layer.start - t <= Math.min(MAX_LEAD, pool.lead * 0.8) * TPS * rate ? 'prestart' : 'hold');

  for (const [clipId, e] of pools.video.assign) {
    const w = wantedV.get(clipId);
    const asset = doc.assets.get(w.assetId);
    if (e.error) {
      mediaError = { message: e.error, assetId: w.assetId };
      continue;
    }
    if (!w.active) {
      drive(pools.video, e, w.layer, asset, w.layer.start, prestart(pools.video, w.layer), Math.abs(rate)); // pre-roll
      continue;
    }
    if (!e.wasActive) {
      e.wasActive = true;
      e.activeSince = tNow;
    }
    const mode = forward && !stalled ? 'play' : 'hold';
    const r = drive(pools.video, e, w.layer, asset, t, mode, Math.abs(rate));
    e.outOfRange = r.outOfRange;
    if (forward && !r.ready && !r.outOfRange && tNow - e.activeSince < STALL_TIMEOUT_MS) needStall = true;
  }

  const audible = forward && Math.abs(rate) <= 4;
  for (const [clipId, e] of pools.audio.assign) {
    const w = wantedA.get(clipId);
    const asset = doc.assets.get(w.assetId);
    if (e.error) continue; // silent failure for sound: picture keeps playing
    if (audioCtx && !e.srcNode) connectAudio(e); // element created before the graph existed
    let gain = 0;
    if (!w.active) {
      drive(pools.audio, e, w.layer, asset, w.layer.start, prestart(pools.audio, w.layer), Math.abs(rate));
    } else {
      const mode = forward && !stalled ? 'play' : 'hold';
      const r = drive(pools.audio, e, w.layer, asset, t, mode, Math.abs(rate));
      // sound outside the media (transition handle past the end) is silence
      if (audible && !stalled && !r.outOfRange) gain = w.layer.gain * layerEnvelope(w.layer, t);
      else if (!forward || stalled) gain = 0;
    }
    e.targetGain = gain;
    if (e.gainNode) {
      const g = e.gainNode.gain;
      if (Math.abs(g.value - gain) > 1e-4) {
        // very short ramp: no zipper noise, still frame-tight
        try {
          g.setTargetAtTime(gain, audioCtx.currentTime, 0.006);
        } catch {
          g.value = gain;
        }
      }
    } else {
      e.el.volume = clamp(gain * (volume.muted ? 0 : volume.v), 0, 1);
    }
  }

  // hold the clock while a picture source at a cut is still seeking, so sound and
  // picture stay together (bounded by STALL_TIMEOUT_MS per element)
  if (needStall && !transport.stalled) {
    stalledByEngine = true;
    stallStartedAt = tNow;
    counters.stalls++;
    transport.stall(true);
  } else if (!needStall && transport.stalled && stalledByEngine) {
    stalledByEngine = false;
    counters.lastStallMs = tNow - stallStartedAt;
    counters.maxStallMs = Math.max(counters.maxStallMs, counters.lastStallMs);
    transport.stall(false);
  }
  if (!playing) stalledByEngine = false;

  return { problems, mediaError, wantedV, buffering: needStall || [...pools.video.assign.entries()].some(([id, e]) => wantedV.get(id)?.active && !e.error && !e.outOfRange && (e.el.readyState < 2 || e.seeking)) };
}

// ---------------------------------------------------------------------------------
// rendering
// ---------------------------------------------------------------------------------
function quadFor(clip, layer, t, W, H, srcW, srcH) {
  const tr = clip.transform;
  const sw = srcW > 0 && srcH > 0 ? srcW : W;
  const sh = srcW > 0 && srcH > 0 ? srcH : H;
  const cw = Math.max(1, sw * (1 - tr.crop.left - tr.crop.right));
  const ch = Math.max(1, sh * (1 - tr.crop.top - tr.crop.bottom));
  const f = Math.min(W / cw, H / ch);
  return {
    cx: W / 2 + (tr.x + layerOffsetX(layer, t)) * W,
    cy: H / 2 + tr.y * H,
    w: Math.max(1, Math.round(cw * f * tr.scale)),
    h: Math.max(1, Math.round(ch * f * tr.scale)),
    rotation: tr.rotation,
    flipH: tr.flip_h,
    flipV: tr.flip_v,
    opacity: tr.opacity * layerEnvelope(layer, t),
    crop: tr.crop,
  };
}

function render(state, t) {
  if (!comp || !canvas) return;
  const doc = state.doc;
  const t0 = now();
  const W = doc ? doc.settings.width : 1920;
  const H = doc ? doc.settings.height : 1080;
  lastW = W;
  lastH = H;
  comp.begin(W, H, doc ? doc.settings.background : '#000000');
  const list = [];
  if (doc) {
    // Paint order (same as core `resolve::paint_order` and the exporter): track rank,
    // then start time, then clip id — so within one track the incoming clip of a
    // transition paints over the outgoing one.
    const active = queryLayers(t, t).sort((a, b) => a.z - b.z || a.start - b.start || (a.clip_id < b.clip_id ? -1 : a.clip_id > b.clip_id ? 1 : 0));
    const k = canvas.width / W;
    for (const layer of active) {
      const base = doc.clips.get(layer.clip_id);
      if (!base) continue;
      const clip = liveClip(state, base);
      const kind = clip.content.kind;
      if (kind === 'audio') continue;
      if (kind === 'video') {
        const e = pools.video.assign.get(layer.clip_id);
        const asset = doc.assets.get(clip.content.asset_id);
        const q = quadFor(clip, layer, t, W, H, asset?.width || 0, asset?.height || 0);
        list.push({ id: clip.id, kind, ...q });
        if (!e || e.error) continue;
        q.color = clip.color;
        q.dynamic = true;
        // re-upload only when the element may show a different frame
        const ct = e.el.currentTime;
        if (!e.el.paused || ct !== e.texTime) {
          e.texTime = ct;
          e.version++;
        }
        q.version = e.version;
        comp.draw(e.el, q);
      } else if (kind === 'image') {
        const rec = state.assets.get(clip.content.asset_id);
        const asset = doc.assets.get(clip.content.asset_id);
        const q = quadFor(clip, layer, t, W, H, asset?.width || 0, asset?.height || 0);
        list.push({ id: clip.id, kind, ...q });
        const img = imageFor(rec);
        if (!img || !img.ready) continue;
        q.color = clip.color;
        q.version = 1;
        comp.draw(img.img, q);
      } else if (kind === 'text') {
        const tr = clip.transform;
        const raster = rasterText(clip.content.text, clip.content.style, tr.scale, H, k);
        if (!raster) continue;
        const cx = W / 2 + (tr.x + layerOffsetX(layer, t)) * W;
        const cy = H / 2 + tr.y * H;
        const q = { ...textQuad(raster, cx, cy), rotation: tr.rotation, flipH: tr.flip_h, flipV: tr.flip_v, opacity: tr.opacity * layerEnvelope(layer, t), version: raster.version };
        comp.draw(raster.canvas, q);
        // the gizmo frames the text block (plus its box), not the raster margins
        const pad = raster.metrics.boxPadding;
        list.push({ id: clip.id, kind, cx, cy: Math.round(cy - raster.blockH / 2) + raster.blockH / 2, w: raster.blockW + 2 * pad, h: raster.blockH + 2 * pad, rotation: tr.rotation, flipH: tr.flip_h, flipV: tr.flip_v });
      } else if (kind === 'caption') {
        const cs = doc.settings.caption_style;
        const raster = rasterText(clip.content.text, cs.text, 1, H, k);
        if (!raster) continue;
        const q = { ...textQuad(raster, W / 2, H / 2 + cs.y * H), rotation: 0, opacity: 1, version: raster.version };
        comp.draw(raster.canvas, q);
        list.push({ id: clip.id, kind, cx: q.cx, cy: q.cy, w: raster.blockW, h: raster.blockH, rotation: 0 });
      }
    }
  }
  comp.end();
  drawn = list;
  for (const fn of frameListeners) fn(engine);
  const ms = now() - t0;
  counters.frames++;
  counters.lastRenderMs = ms;
  counters.sumRenderMs += ms;
  if (ms > counters.maxRenderMs) counters.maxRenderMs = ms;
}

// ---------------------------------------------------------------------------------
// status
// ---------------------------------------------------------------------------------
function setStatus(next) {
  if (next.state === status.state && next.message === status.message && next.progress === status.progress && next.assetId === status.assetId) return;
  status = next;
  for (const fn of [...listeners]) fn(engine);
}

function computeStatus(state, sync) {
  const doc = state.doc;
  if (!doc || doc.clips.size === 0) return { state: 'empty', message: '', progress: null, assetId: null };
  if (sync.mediaError) return { state: 'error', message: sync.mediaError.message, progress: null, assetId: sync.mediaError.assetId };
  for (const p of sync.problems) {
    const name = p.rec?.name || doc.assets.get(p.assetId)?.name || 'this media';
    if (!p.rec) return { state: 'error', message: `The media file for “${name}” is missing. Re-import it or remove its clips.`, progress: null, assetId: p.assetId };
    if (p.rec.state === 'failed') return { state: 'error', message: p.rec.error || `“${name}” could not be prepared for preview.`, progress: null, assetId: p.assetId };
    return { state: 'preparing', message: `Preparing preview for “${name}”…`, progress: p.rec.stage === 'Preparing preview' ? p.rec.progress : null, assetId: p.assetId };
  }
  if (sync.buffering) return { state: 'buffering', message: 'Buffering…', progress: null, assetId: null };
  return { state: 'ready', message: '', progress: null, assetId: null };
}

// ---------------------------------------------------------------------------------
// update loop (event driven; no permanent rAF)
// ---------------------------------------------------------------------------------
let inUpdate = false;
let seenSettings = null;

function update() {
  rafPending = 0;
  if (!attached || inUpdate) return;
  inUpdate = true;
  const t0 = now();
  try {
    updateNow();
  } finally {
    inUpdate = false;
    const ms = now() - t0;
    counters.updates++;
    counters.sumUpdateMs += ms;
    if (ms > counters.maxUpdateMs) counters.maxUpdateMs = ms;
  }
}

function updateNow() {
  const state = store.state;
  if (state.doc?.settings !== seenSettings) {
    seenSettings = state.doc?.settings || null;
    fitBacking();
  }
  if (state.layers !== seenLayers || state.doc?.clips !== seenDoc?.clips) {
    const t0 = now();
    index = state.doc ? buildIndex(state.layers, state.doc) : { bucket: TPS, buckets: new Map(), count: 0 };
    seenLayers = state.layers;
    counters.indexBuilds++;
    counters.lastIndexMs = now() - t0;
  }
  seenDoc = state.doc;
  seenLive = state.live;
  seenAssets = state.assets;
  const t = Math.max(0, transport.time);
  if (!state.doc) {
    releaseAll();
    render(state, t);
    setStatus({ state: 'empty', message: '', progress: null, assetId: null });
    return;
  }
  const sync = syncMedia(state, t);
  render(state, t);
  setStatus(computeStatus(state, sync));
}

function requestUpdate() {
  if (!attached || rafPending || inUpdate) return;
  rafPending = requestAnimationFrame(update);
}

function onTransport() {
  if (!attached) return;
  if (transport.playing) {
    // transport ticks arrive once per display frame: render synchronously
    const t = now();
    if (counters.lastTickAt && t - counters.lastTickAt > 50) counters.late++;
    counters.lastTickAt = t;
    if (rafPending) {
      cancelAnimationFrame(rafPending);
      rafPending = 0;
    }
    update();
  } else {
    counters.lastTickAt = 0;
    requestUpdate();
  }
}

function onStore(state) {
  if (state.layers !== seenLayers || state.doc !== seenDoc || state.live !== seenLive || state.assets !== seenAssets) requestUpdate();
}

function releaseAll() {
  for (const pool of Object.values(pools)) {
    pool.assign.clear();
    for (const e of pool.entries) unload(e);
    pool.entries = [];
  }
}

function fitBacking() {
  if (!canvas || !comp) return;
  const doc = store.state.doc;
  const W = doc ? doc.settings.width : 1920;
  const H = doc ? doc.settings.height : 1080;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const cssW = canvas.clientWidth || 640;
  const bw = Math.max(16, Math.min(Math.round(cssW * dpr), W, MAX_BACKING_WIDTH));
  const bh = Math.max(16, Math.round((bw * H) / W));
  comp.resize(bw, bh);
}

// ---------------------------------------------------------------------------------
// public API
// ---------------------------------------------------------------------------------
let gestureHooked = false;
function hookFirstGesture() {
  if (gestureHooked) return;
  gestureHooked = true;
  const first = () => {
    window.removeEventListener('pointerdown', first, true);
    window.removeEventListener('keydown', first, true);
    // created inside a user gesture: allowed to run, and warm before the first play
    ensureAudioGraph();
  };
  window.addEventListener('pointerdown', first, true);
  window.addEventListener('keydown', first, true);
}

export const engine = {
  /** Start rendering into `canvasEl` (called by the Monitor). */
  attach(canvasEl, opts = {}) {
    if (attached) engine.detach();
    hookFirstGesture();
    canvas = canvasEl;
    comp = createCompositor(canvasEl, opts);
    comp.onRestore(() => requestUpdate());
    setTextEvictHandler((c) => comp?.release(c));
    attached = true;
    seenLayers = null;
    fitBacking();
    resizeObs = new ResizeObserver(() => {
      fitBacking();
      // draw immediately: resizing a canvas clears it
      update();
    });
    resizeObs.observe(canvasEl);
    unsubStore = store.subscribe(onStore);
    unsubTransport = transport.subscribe(onTransport);
    unsubFonts = onTextFontsLoaded(() => requestUpdate());
    loadTextFonts();
    requestUpdate();
  },
  detach() {
    attached = false;
    if (rafPending) cancelAnimationFrame(rafPending);
    rafPending = 0;
    unsubStore?.();
    unsubTransport?.();
    unsubFonts?.();
    resizeObs?.disconnect();
    if (transport.stalled && stalledByEngine) transport.stall(false);
    stalledByEngine = false;
    releaseAll();
    comp?.destroy();
    comp = null;
    canvas = null;
    drawn = [];
  },
  get attached() {
    return attached;
  },
  /** { state: 'empty'|'ready'|'buffering'|'preparing'|'error', message, progress, assetId } */
  get status() {
    return status;
  },
  /** fn(engine) on status / volume changes. */
  subscribe(fn) {
    listeners.add(fn);
    return () => listeners.delete(fn);
  },
  /** fn(engine) after every rendered frame (used by the transform gizmo to follow the picture). */
  onFrame(fn) {
    frameListeners.add(fn);
    return () => frameListeners.delete(fn);
  },
  get masterVolume() {
    return volume.v;
  },
  set masterVolume(v) {
    volume = { ...volume, v: clamp(Number(v) || 0, 0, 1.5) };
    applyVolume();
  },
  get muted() {
    return volume.muted;
  },
  set muted(m) {
    volume = { ...volume, muted: !!m };
    applyVolume();
  },
  /** Re-render now (e.g. after the canvas was resized by layout). */
  refresh() {
    fitBacking();
    if (attached) update();
  },
  /** Topmost visual (video / image / text) clip under a point given in 0..1 canvas coordinates. */
  hitTest(xNorm, yNorm) {
    const px = xNorm * lastW;
    const py = yNorm * lastH;
    for (let i = drawn.length - 1; i >= 0; i--) {
      const q = drawn[i];
      if (q.kind === 'caption') continue;
      const rad = (-(q.rotation || 0) * Math.PI) / 180;
      const dx = px - q.cx;
      const dy = py - q.cy;
      const lx = dx * Math.cos(rad) - dy * Math.sin(rad);
      const ly = dx * Math.sin(rad) + dy * Math.cos(rad);
      if (Math.abs(lx) <= q.w / 2 && Math.abs(ly) <= q.h / 2) return q.id;
    }
    return null;
  },
  /** On-canvas box of a clip at the current time, in project pixels: { cx, cy, w, h, rotation, W, H } or null. */
  layoutOf(clipId) {
    const q = drawn.find((d) => d.id === clipId);
    return q ? { cx: q.cx, cy: q.cy, w: q.w, h: q.h, rotation: q.rotation || 0, kind: q.kind, W: lastW, H: lastH } : null;
  },
  /** Render synchronously and read back RGBA pixels (backing-store coordinates, origin top-left). */
  readPixels(x = 0, y = 0, w, h) {
    if (!attached || !comp) return null;
    update();
    const bw = canvas.width;
    const bh = canvas.height;
    const rw = Math.min(w ?? bw, bw - x);
    const rh = Math.min(h ?? bh, bh - y);
    return { width: rw, height: rh, data: comp.readPixels(x, y, rw, rh) };
  },
  /** Average colour of a region given in 0..1 canvas coordinates: [r, g, b] (0..255). */
  sampleRegion(x0, y0, x1, y1) {
    if (!attached || !comp) return null;
    const bw = canvas.width;
    const bh = canvas.height;
    const x = Math.floor(clamp(x0, 0, 1) * bw);
    const y = Math.floor(clamp(y0, 0, 1) * bh);
    const w = Math.max(1, Math.floor(clamp(x1, 0, 1) * bw) - x);
    const h = Math.max(1, Math.floor(clamp(y1, 0, 1) * bh) - y);
    const px = engine.readPixels(x, y, w, h);
    const sum = [0, 0, 0];
    for (let i = 0; i < px.data.length; i += 4) {
      sum[0] += px.data[i];
      sum[1] += px.data[i + 1];
      sum[2] += px.data[i + 2];
    }
    const n = px.data.length / 4;
    return sum.map((v) => v / n);
  },
  /** Diagnostics for tests. */
  stats() {
    const active = (pool) =>
      [...pool.assign.entries()].map(([clipId, e]) => ({
        clipId,
        url: e.url,
        currentTime: e.el.currentTime,
        paused: e.el.paused,
        readyState: e.el.readyState,
        seeking: e.seeking || e.el.seeking,
        playbackRate: e.el.playbackRate,
        handoff: !!e.handoff,
        gain: e.gainNode ? e.gainNode.gain.value : e.el.volume,
        targetGain: e.targetGain,
      }));
    return {
      compositor: comp?.kind || null,
      backing: canvas ? [canvas.width, canvas.height] : null,
      frames: counters.frames,
      late: counters.late,
      lastRenderMs: counters.lastRenderMs,
      maxRenderMs: counters.maxRenderMs,
      avgRenderMs: counters.frames ? counters.sumRenderMs / counters.frames : 0,
      // whole engine tick (media sync + compositing), excluding the browser's video decode
      avgUpdateMs: counters.updates ? counters.sumUpdateMs / counters.updates : 0,
      maxUpdateMs: counters.maxUpdateMs,
      indexBuilds: counters.indexBuilds,
      lastIndexMs: counters.lastIndexMs,
      stalls: counters.stalls,
      lastStallMs: counters.lastStallMs,
      maxStallMs: counters.maxStallMs,
      hardSeeks: counters.hardSeeks,
      indexedLayers: index.count,
      drawn: drawn.length,
      video: active(pools.video),
      audio: active(pools.audio),
      videoElements: pools.video.entries.length,
      audioElements: pools.audio.entries.length,
      textures: comp?.textureCount?.() ?? 0,
      audioContext: audioCtx ? audioCtx.state : audioCtx === false ? 'unavailable' : 'not-created',
      masterGain: masterGain ? masterGain.gain.value : null,
      status,
    };
  },
  resetStats() {
    Object.assign(counters, { frames: 0, late: 0, lastRenderMs: 0, maxRenderMs: 0, sumRenderMs: 0, updates: 0, sumUpdateMs: 0, maxUpdateMs: 0, stalls: 0, lastStallMs: 0, maxStallMs: 0, hardSeeks: 0, lastTickAt: 0 });
  },
};

function applyVolume() {
  const g = volume.muted ? 0 : volume.v;
  if (masterGain) masterGain.gain.value = g;
  else for (const e of pools.audio.entries) e.el.volume = clamp(e.targetGain * g, 0, 1);
  try {
    localStorage.setItem(VOLUME_KEY, JSON.stringify(volume));
  } catch {
    /* ignore */
  }
  for (const fn of [...listeners]) fn(engine);
}
