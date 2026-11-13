// Canvas renderer for the timeline: ruler, lanes, clips (thumbnails, waveforms,
// labels, fades, badges), transitions, markers and drag previews.
// Pure drawing — all state comes in through `scene`.
import { clipEnd, fpsValue, frameTicks, sourceOut, syncAnchor, ticksToFrameRound, timecode, TPS } from '../lib/time.js';
import { clipLabel, clipsByTrack, clipsInRange, linkGroups, trackActive } from '../state/store.js';
import { getPoster, getThumbs, getWaveform, peakBetween } from './media-cache.js';
import { RULER_H, lanes, xOf, tOf } from './geometry.js';

let theme = null;
function readTheme() {
  const cs = getComputedStyle(document.documentElement);
  const v = (n) => cs.getPropertyValue(n).trim();
  theme = {
    bg0: v('--bg-0'), bg1: v('--bg-1'), bg2: v('--bg-2'), bg3: v('--bg-3'), line: v('--line'), lineStrong: v('--line-strong'),
    text: v('--text'), text2: v('--text-2'), text3: v('--text-3'), accent: v('--accent'), playhead: v('--playhead'), danger: v('--danger'), warning: v('--warning'),
    kinds: {
      video: [v('--clip-video'), v('--clip-video-hi')],
      audio: [v('--clip-audio'), v('--clip-audio-hi')],
      image: [v('--clip-image'), v('--clip-image-hi')],
      text: [v('--clip-text'), v('--clip-text-hi')],
      caption: [v('--clip-caption'), v('--clip-caption-hi')],
    },
  };
}

function roundRect(ctx, x, y, w, h, r) {
  const rr = Math.max(0, Math.min(r, w / 2, h / 2));
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

// ---- ruler ------------------------------------------------------------------
function rulerSteps(fps, pxPerSec) {
  const ft = frameTicks(fps);
  const f = Math.round(fpsValue(fps));
  const s = TPS;
  const candidates = [ft, 2 * ft, 5 * ft, 10 * ft, s, 2 * s, 5 * s, 10 * s, 15 * s, 30 * s, 60 * s, 120 * s, 300 * s, 600 * s, 900 * s, 1800 * s, 3600 * s, 7200 * s].filter((c, i) => i > 3 || c < s);
  const major = candidates.find((c) => (c / TPS) * pxPerSec >= 84) || candidates[candidates.length - 1];
  let div = 5;
  if (major < s) div = Math.max(1, Math.round(major / ft));
  else if (major === s) div = f % 5 === 0 || f > 30 ? 5 : 4;
  else if (major === 2 * s || major === 120 * s) div = 4;
  else if (major === 15 * s || major === 900 * s) div = 3;
  else if (major === 30 * s || major === 1800 * s || major === 60 * s || major === 3600 * s) div = 6;
  while (div > 1 && ((major / div) / TPS) * pxPerSec < 6) div = div % 2 === 0 ? div / 2 : 1;
  return { major, minor: major / div };
}

function rulerLabel(t, fps, major) {
  const tc = timecode(t, fps); // HH:MM:SS:FF
  if (major < TPS) return tc.startsWith('00:') ? tc.slice(3) : tc;
  const [h, m, s] = tc.split(':');
  return h === '00' ? `${m}:${s}` : `${h}:${m}:${s}`;
}

function drawRuler(ctx, scene, W) {
  const { view, doc } = scene;
  const fps = doc.settings.fps;
  ctx.fillStyle = theme.bg1;
  ctx.fillRect(0, 0, W, RULER_H);
  ctx.fillStyle = theme.line;
  ctx.fillRect(0, RULER_H - 1, W, 1);
  const { major, minor } = rulerSteps(fps, view.pxPerSec);
  const t0 = Math.max(0, tOf(0, view));
  const t1 = tOf(W, view);
  ctx.font = '500 10.5px Inter, system-ui, sans-serif';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = theme.lineStrong;
  for (let t = Math.floor(t0 / minor) * minor; t <= t1; t += minor) {
    const x = Math.round(xOf(t, view)) + 0.5;
    const isMajor = Math.abs(t / major - Math.round(t / major)) < 1e-6;
    ctx.fillRect(x - 0.5, isMajor ? RULER_H - 11 : RULER_H - 5, 1, isMajor ? 10 : 4);
  }
  ctx.fillStyle = theme.text3;
  for (let t = Math.floor(t0 / major) * major; t <= t1; t += major) {
    const x = xOf(t, view);
    ctx.fillText(rulerLabel(Math.round(t), fps, major), x + 5, 9);
  }
  // end-of-timeline shading
  const endX = xOf(scene.duration, view);
  if (endX < W) {
    ctx.fillStyle = 'rgba(0,0,0,0.22)';
    ctx.fillRect(Math.max(0, endX), RULER_H, W - Math.max(0, endX), scene.H - RULER_H);
  }
}

// ---- clips ------------------------------------------------------------------
function drawWaveform(ctx, clip, wave, x, y, w, h, color, visX0, visX1, pxPerSec) {
  const speed = clip.speed.num / clip.speed.den;
  const srcIn = clip.source_in / TPS;
  const secPerPx = speed / pxPerSec;
  const mid = y + h / 2;
  const amp = h / 2 - 2;
  ctx.beginPath();
  const from = Math.max(Math.floor(visX0), Math.floor(x));
  const to = Math.min(Math.ceil(visX1), Math.ceil(x + w));
  for (let px = from; px < to; px++) {
    const s0 = srcIn + (px - x) * secPerPx;
    const p = peakBetween(wave, s0, s0 + secPerPx);
    // square-root scale keeps quiet speech visible without clipping loud parts
    const a = Math.max(0.5, Math.sqrt(p) * amp);
    ctx.rect(px, mid - a, 1, a * 2);
  }
  ctx.fillStyle = color;
  ctx.fill();
}

function drawThumbs(ctx, clip, record, x, y, w, h, visX0, visX1, pxPerSec) {
  const thumbs = getThumbs(record);
  const speed = clip.speed.num / clip.speed.den;
  if (thumbs) {
    const { img, sprite } = thumbs;
    const tw = Math.max(8, Math.round((h * sprite.tile_w) / sprite.tile_h));
    const first = Math.max(0, Math.floor((visX0 - x) / tw));
    const last = Math.min(Math.ceil(w / tw), Math.ceil((visX1 - x) / tw));
    const interval = sprite.interval / TPS;
    for (let k = first; k < last; k++) {
      const dx = x + k * tw;
      const src = clip.source_in / TPS + ((k + 0.5) * tw * speed) / pxPerSec;
      const idx = Math.max(0, Math.min(sprite.count - 1, Math.floor(src / interval)));
      const sx = (idx % sprite.cols) * sprite.tile_w;
      const sy = Math.floor(idx / sprite.cols) * sprite.tile_h;
      ctx.drawImage(img, sx, sy, sprite.tile_w, sprite.tile_h, dx, y, tw, h);
    }
    return true;
  }
  const poster = getPoster(record);
  if (poster && poster.naturalHeight) {
    const tw = Math.max(8, Math.round((h * poster.naturalWidth) / poster.naturalHeight));
    const first = Math.max(0, Math.floor((visX0 - x) / tw));
    const last = Math.min(Math.ceil(w / tw), Math.ceil((visX1 - x) / tw));
    for (let k = first; k < last; k++) ctx.drawImage(poster, x + k * tw, y, tw, h);
    return true;
  }
  return false;
}

function fitText(ctx, text, max) {
  if (max <= 8) return '';
  if (ctx.measureText(text).width <= max) return text;
  let lo = 0;
  let hi = text.length;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (ctx.measureText(text.slice(0, mid) + '…').width <= max) lo = mid;
    else hi = mid - 1;
  }
  return lo > 0 ? text.slice(0, lo) + '…' : '';
}

function badge(ctx, text, x, y, bg, fg) {
  ctx.font = '650 9.5px Inter, system-ui, sans-serif';
  const w = Math.ceil(ctx.measureText(text).width) + 8;
  roundRect(ctx, x, y, w, 14, 4);
  ctx.fillStyle = bg;
  ctx.fill();
  ctx.fillStyle = fg;
  ctx.textBaseline = 'middle';
  ctx.fillText(text, x + 4, y + 7.5);
  return w;
}

/**
 * Draw one clip rectangle.
 * @param {object} g  geometry {x,y,w,h} in canvas px
 * @param {object} o  flags {selected, dimmed, ghost, locked, inactive, offsetFrames}
 */
function drawClip(ctx, scene, clip, g, o, W) {
  const { doc, view } = scene;
  const kind = clip.content.kind;
  const [base, hi] = theme.kinds[kind] || theme.kinds.video;
  const { x, y, w, h } = g;
  const visX0 = Math.max(0, x);
  const visX1 = Math.min(W, x + w);
  if (visX1 <= visX0) return;
  ctx.save();
  if (o.dimmed) ctx.globalAlpha = 0.28;
  else if (!clip.enabled || o.inactive) ctx.globalAlpha = 0.45;
  if (o.ghost) ctx.globalAlpha = 0.85;
  roundRect(ctx, x + 0.5, y + 1, Math.max(1, w - 1), h - 2, 4);
  ctx.fillStyle = base;
  ctx.fill();
  if (w > 3) {
    ctx.save();
    ctx.clip();
    const record = clip.content.asset_id ? scene.assets.get(clip.content.asset_id) : null;
    const labelH = kind === 'caption' ? 0 : 15;
    if ((kind === 'video' || kind === 'image') && w > 10) {
      drawThumbs(ctx, clip, record, x, y + 1 + labelH, w, h - 2 - labelH, visX0, visX1, view.pxPerSec);
    } else if (kind === 'audio') {
      const wave = getWaveform(record);
      if (wave) drawWaveform(ctx, clip, wave, x, y + labelH, w, h - labelH - 1, hi, visX0, visX1, view.pxPerSec);
      else {
        ctx.fillStyle = 'rgba(255,255,255,0.12)';
        ctx.fillRect(visX0, y + labelH + (h - labelH) / 2 - 0.5, visX1 - visX0, 1);
      }
    }
    // label strip
    if (labelH) {
      ctx.fillStyle = kind === 'video' || kind === 'image' ? 'rgba(8,10,14,0.72)' : 'rgba(0,0,0,0.25)';
      ctx.fillRect(visX0, y + 1, visX1 - visX0, labelH);
    }
    // fades
    const fin = (clip.fade_in / TPS) * view.pxPerSec;
    const fout = (clip.fade_out / TPS) * view.pxPerSec;
    ctx.fillStyle = 'rgba(0,0,0,0.5)';
    if (fin > 2) {
      ctx.beginPath();
      ctx.moveTo(x, y + 1);
      ctx.lineTo(x + fin, y + 1);
      ctx.lineTo(x, y + h - 1);
      ctx.closePath();
      ctx.fill();
    }
    if (fout > 2) {
      ctx.beginPath();
      ctx.moveTo(x + w, y + 1);
      ctx.lineTo(x + w - fout, y + 1);
      ctx.lineTo(x + w, y + h - 1);
      ctx.closePath();
      ctx.fill();
    }
    // label + badges (kept inside the visible part so long clips stay identifiable)
    const tx = Math.max(x, 0) + 6;
    let bx = tx;
    if (o.offsetFrames) bx += badge(ctx, `${o.offsetFrames > 0 ? '+' : ''}${o.offsetFrames}f`, bx, y + 2, theme.danger, '#fff') + 4;
    const speed = clip.speed.num / clip.speed.den;
    if (speed !== 1 && w > 46) bx += badge(ctx, `${Number(speed.toFixed(2))}×`, bx, y + 2, 'rgba(0,0,0,0.55)', theme.warning) + 4;
    ctx.font = `${kind === 'caption' ? 500 : 600} 11px Inter, system-ui, sans-serif`;
    ctx.textBaseline = 'middle';
    ctx.fillStyle = clip.enabled ? '#f3f5fa' : theme.text2;
    const text = fitText(ctx, clipLabel(doc, clip), x + w - bx - 6);
    if (clip.link_id && text) {
      // small link glyph
      ctx.strokeStyle = 'rgba(255,255,255,0.7)';
      ctx.lineWidth = 1.2;
      const ly = kind === 'caption' ? y + h / 2 : y + 8.5;
      ctx.beginPath();
      ctx.arc(bx + 3, ly, 2.4, Math.PI * 0.5, Math.PI * 1.5);
      ctx.moveTo(bx + 3, ly - 2.4);
      ctx.lineTo(bx + 6, ly - 2.4);
      ctx.moveTo(bx + 3, ly + 2.4);
      ctx.lineTo(bx + 6, ly + 2.4);
      ctx.arc(bx + 8, ly, 2.4, Math.PI * 1.5, Math.PI * 0.5);
      ctx.moveTo(bx + 4.5, ly);
      ctx.lineTo(bx + 6.5, ly);
      ctx.stroke();
      bx += 14;
    }
    if (text) ctx.fillText(fitText(ctx, clipLabel(doc, clip), x + w - bx - 6), bx, kind === 'caption' ? y + h / 2 + 0.5 : y + 9);
    // disabled hatch
    if (!clip.enabled) {
      ctx.strokeStyle = 'rgba(255,255,255,0.18)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (let d = Math.floor(visX0 - h); d < visX1; d += 8) {
        ctx.moveTo(d, y + h);
        ctx.lineTo(d + h, y);
      }
      ctx.stroke();
    }
    ctx.restore();
  }
  // outline
  roundRect(ctx, x + 0.5, y + 1.5, Math.max(1, w - 1), h - 3, 4);
  if (o.selected) {
    ctx.lineWidth = 2;
    ctx.strokeStyle = '#ffffff';
    ctx.stroke();
    roundRect(ctx, x - 0.5, y + 0.5, w + 1, h - 1, 5);
    ctx.lineWidth = 1;
    ctx.strokeStyle = theme.accent;
    ctx.stroke();
  } else {
    ctx.lineWidth = 1;
    ctx.strokeStyle = o.ghost ? theme.accent : hi + '88';
    ctx.stroke();
  }
  ctx.restore();
}

/** Transitions occupy the lower part of the lane so the clip edges above stay grabbable for trimming. */
export function transitionBand(y, h) {
  const top = Math.round(h * 0.42);
  return { y: y + top, h: h - top - 3 };
}

function drawTransition(ctx, x0, x1, laneY, laneH, selected) {
  const { y, h } = transitionBand(laneY, laneH);
  const w = Math.max(10, x1 - x0);
  const cx = (x0 + x1) / 2;
  const bx = cx - w / 2;
  ctx.save();
  roundRect(ctx, bx, y, w, h, 3);
  ctx.fillStyle = selected ? 'rgba(124,156,255,0.45)' : 'rgba(255,255,255,0.16)';
  ctx.fill();
  ctx.lineWidth = selected ? 1.5 : 1;
  ctx.strokeStyle = selected ? theme.accent : 'rgba(255,255,255,0.55)';
  ctx.stroke();
  // bow-tie glyph
  const g = Math.min(6, w / 2 - 2, h / 2 - 3);
  if (g >= 3) {
    ctx.beginPath();
    ctx.moveTo(cx - g, y + h / 2 - g);
    ctx.lineTo(cx + g, y + h / 2 + g);
    ctx.lineTo(cx + g, y + h / 2 - g);
    ctx.lineTo(cx - g, y + h / 2 + g);
    ctx.closePath();
    ctx.fillStyle = 'rgba(255,255,255,0.85)';
    ctx.fill();
  }
  ctx.restore();
}

/** Frames by which a linked clip is out of sync with its link partners (0 = in sync). */
export function linkOffsetFrames(doc, clip) {
  if (!clip.link_id || !clip.content.asset_id) return 0;
  const group = linkGroups(doc).links.get(clip.link_id);
  if (!group || group.length < 2) return 0;
  const sameAsset = group.filter((c) => c.content.asset_id === clip.content.asset_id);
  if (sameAsset.length < 2) return 0;
  // reference: the picture if there is one, else the first clip of the set
  const ref = sameAsset.find((c) => c.content.kind === 'video') || sameAsset[0];
  if (ref.id === clip.id) {
    const other = sameAsset.find((c) => c.id !== clip.id);
    const d = syncAnchor(clip) - syncAnchor(other);
    return ticksToFrameRound(Math.abs(d), doc.settings.fps) * Math.sign(d);
  }
  const d = syncAnchor(clip) - syncAnchor(ref);
  return ticksToFrameRound(Math.abs(d), doc.settings.fps) * Math.sign(d);
}

/** "+00:01:12" — a signed MM:SS:FF offset (hours only when there are any). */
function signedTimecode(delta, fps) {
  const tc = timecode(Math.abs(delta), fps);
  return `${delta < 0 ? '−' : '+'}${tc.startsWith('00:') ? tc.slice(3) : tc}`;
}

/** Small two-part label next to a drag: `main` is the offset, `detail` the result. */
function readout(ctx, main, detail, x, laneY, laneH, W, H, centred) {
  const font = (weight) => `${weight} 11px Inter, system-ui, sans-serif`;
  ctx.save();
  ctx.font = font(650);
  const wMain = Math.ceil(ctx.measureText(main).width);
  ctx.font = font(500);
  const wDetail = Math.ceil(ctx.measureText(detail).width);
  const w = wMain + wDetail + 22;
  const h = 20;
  const bx = Math.round(Math.max(4, Math.min(W - w - 4, centred ? x - w / 2 : x)));
  // above the lane when there is room under the ruler, otherwise below it
  let by = laneY - h - 3;
  if (by < RULER_H + 2) by = Math.min(H - h - 2, laneY + laneH + 3);
  roundRect(ctx, bx + 0.5, by + 0.5, w, h, 5);
  ctx.fillStyle = 'rgba(5, 7, 10, 0.94)';
  ctx.fill();
  ctx.strokeStyle = theme.lineStrong;
  ctx.lineWidth = 1;
  ctx.stroke();
  ctx.textBaseline = 'middle';
  ctx.font = font(650);
  ctx.fillStyle = theme.text;
  ctx.fillText(main, bx + 7, by + h / 2 + 1);
  ctx.font = font(500);
  ctx.fillStyle = theme.text2;
  ctx.fillText(detail, bx + 7 + wMain + 8, by + h / 2 + 1);
  ctx.restore();
}

/**
 * Render the whole timeline.
 * scene: { doc, layers, assets, sel, view, duration, W, H, drag, hoverLaneId, dropGhosts, snapX, marquee, focusId }
 */
export function drawTimeline(ctx, scene) {
  if (!theme) readTheme();
  const { doc, view, W, H, drag } = scene;
  ctx.clearRect(0, 0, W, H);
  ctx.fillStyle = theme.bg0;
  ctx.fillRect(0, 0, W, H);
  const ls = lanes(doc);
  const byTrack = clipsByTrack(doc);
  const t0 = tOf(-40, view);
  const t1 = tOf(W + 40, view);
  const visible = []; // {clip, lane} for DOM sync

  // lanes
  for (const lane of ls) {
    const y = RULER_H + lane.y - view.scrollY;
    if (y > H || y + lane.h < RULER_H) continue;
    ctx.fillStyle = lane.track.kind === 'audio' ? '#10141a' : lane.track.kind === 'caption' ? '#131118' : '#11141b';
    ctx.fillRect(0, y, W, lane.h);
    ctx.fillStyle = theme.line;
    ctx.fillRect(0, y + lane.h, W, 1);
    if (scene.hoverLaneId === lane.track.id) {
      ctx.fillStyle = 'rgba(124,156,255,0.07)';
      ctx.fillRect(0, y, W, lane.h);
    }
  }
  // divider between picture and sound
  const firstAudio = ls.find((l) => l.track.kind === 'audio');
  if (firstAudio) {
    ctx.fillStyle = theme.lineStrong;
    ctx.fillRect(0, RULER_H + firstAudio.y - view.scrollY - 1, W, 1);
  }

  const moving = drag?.kind === 'move' ? drag.preview : null; // Map<id,{start,trackId}>
  const trimming = drag?.kind === 'trim' ? drag : null;

  for (const lane of ls) {
    const y = RULER_H + lane.y - view.scrollY;
    if (y > H || y + lane.h < RULER_H) continue;
    const active = trackActive(doc, lane.track);
    const clips = clipsInRange(doc, lane.track.id, t0, t1);
    for (const clip of clips) {
      visible.push({ clip, lane });
      let c = clip;
      if (trimming && trimming.ids.has(clip.id)) {
        const d = trimming.delta;
        c = trimming.edge === 'start' ? { ...clip, start: clip.start + d, duration: clip.duration - d, source_in: clip.content.kind === 'video' || clip.content.kind === 'audio' ? clip.source_in + (d * clip.speed.num) / clip.speed.den : clip.source_in } : { ...clip, duration: clip.duration + d };
      }
      const x = xOf(c.start, view);
      const w = (c.duration / TPS) * view.pxPerSec;
      drawClip(ctx, scene, c, { x, y, w, h: lane.h }, { selected: scene.sel.clips.has(clip.id), dimmed: !!moving?.has(clip.id), locked: lane.track.locked, inactive: !active, offsetFrames: linkOffsetFrames(doc, clip) }, W);
    }
    // cut markers + transitions
    const arr = byTrack.get(lane.track.id) || [];
    for (let i = 0; i < clips.length; i++) {
      const clip = clips[i];
      const idx = arr.indexOf(clip);
      const next = arr[idx + 1];
      if (!next || next.start !== clipEnd(clip)) continue;
      const cutX = xOf(next.start, view);
      // "through edit" / removed-source indicator between clips of the same asset
      if (clip.content.asset_id && clip.content.asset_id === next.content.asset_id && clip.content.kind === next.content.kind) {
        const jump = next.source_in - sourceOut(clip);
        ctx.fillStyle = Math.abs(jump) < 2 ? 'rgba(255,255,255,0.5)' : theme.warning;
        ctx.beginPath();
        ctx.moveTo(cutX - 3.5, y + lane.h - 1);
        ctx.lineTo(cutX + 3.5, y + lane.h - 1);
        ctx.lineTo(cutX, y + lane.h - 6);
        ctx.closePath();
        ctx.fill();
      }
    }
    if (lane.track.locked) {
      ctx.save();
      ctx.beginPath();
      ctx.rect(0, y, W, lane.h);
      ctx.clip();
      ctx.strokeStyle = 'rgba(255,255,255,0.06)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (let d = -lane.h; d < W; d += 10) {
        ctx.moveTo(d, y + lane.h);
        ctx.lineTo(d + lane.h, y);
      }
      ctx.stroke();
      ctx.restore();
    }
  }

  // transitions (drawn across the cut)
  const laneOf = new Map(ls.map((l) => [l.track.id, l]));
  const transitionRects = [];
  for (const tr of doc.transitions.values()) {
    const left = doc.clips.get(tr.left);
    if (!left) continue;
    const lane = laneOf.get(left.track_id);
    if (!lane) continue;
    const cut = clipEnd(left);
    const x0 = xOf(cut - tr.duration / 2, view);
    const x1 = xOf(cut + tr.duration / 2, view);
    if (x1 < 0 || x0 > W) continue;
    const y = RULER_H + lane.y - view.scrollY;
    drawTransition(ctx, x0, x1, y, lane.h, scene.sel.transition === tr.id);
    const band = transitionBand(y, lane.h);
    transitionRects.push({ id: tr.id, x: Math.min(x0, (x0 + x1) / 2 - 7), w: Math.max(14, x1 - x0), y: band.y, h: band.h, tr, left });
  }

  // drop ghosts (dragging from the bin) and move previews
  ctx.save();
  if (moving) {
    for (const [id, pos] of moving) {
      const clip = doc.clips.get(id);
      const lane = laneOf.get(pos.trackId);
      if (!clip || !lane) continue;
      const x = xOf(pos.start, view);
      const w = (clip.duration / TPS) * view.pxPerSec;
      drawClip(ctx, scene, { ...clip, start: pos.start }, { x, y: RULER_H + lane.y - view.scrollY, w, h: lane.h }, { selected: true, ghost: true }, W);
    }
  }
  for (const g of scene.dropGhosts || []) {
    const lane = laneOf.get(g.trackId);
    if (!lane) continue;
    const x = xOf(g.start, view);
    const w = Math.max(4, (g.duration / TPS) * view.pxPerSec);
    const y = RULER_H + lane.y - view.scrollY;
    const [base, hi] = theme.kinds[g.kind] || theme.kinds.video;
    roundRect(ctx, x + 0.5, y + 1.5, w - 1, lane.h - 3, 4);
    ctx.fillStyle = base + 'cc';
    ctx.fill();
    ctx.setLineDash([5, 3]);
    ctx.strokeStyle = hi;
    ctx.lineWidth = 1.5;
    ctx.stroke();
    ctx.setLineDash([]);
  }
  ctx.restore();

  // clip to keep everything below the ruler, then draw the ruler on top
  drawRuler(ctx, scene, W);

  // markers
  for (const m of doc.markers) {
    const x = Math.round(xOf(m.time, view));
    if (x < -8 || x > W + 8) continue;
    ctx.fillStyle = m.color;
    ctx.globalAlpha = scene.sel.marker === m.id ? 1 : 0.85;
    ctx.fillRect(x, RULER_H - 1, 1, H - RULER_H);
    ctx.beginPath();
    ctx.moveTo(x - 4.5, RULER_H - 13);
    ctx.lineTo(x + 4.5, RULER_H - 13);
    ctx.lineTo(x + 4.5, RULER_H - 6);
    ctx.lineTo(x, RULER_H - 1);
    ctx.lineTo(x - 4.5, RULER_H - 6);
    ctx.closePath();
    ctx.fill();
    if (scene.sel.marker === m.id) {
      ctx.strokeStyle = '#fff';
      ctx.lineWidth = 1.5;
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }

  // snap guide
  if (scene.snapX != null) {
    ctx.fillStyle = theme.warning;
    ctx.fillRect(Math.round(scene.snapX), RULER_H, 1, H - RULER_H);
  }
  // drag readout: how far the edit has moved and where it lands
  if (moving && moving.size) {
    const id = moving.has(drag.clipId) ? drag.clipId : moving.keys().next().value;
    const clip = doc.clips.get(id);
    const pos = moving.get(id);
    const lane = clip && laneOf.get(pos.trackId);
    if (lane) {
      const delta = pos.start - clip.start;
      const moved = pos.trackId !== clip.track_id;
      if (delta || moved) readout(ctx, signedTimecode(delta, doc.settings.fps), `${moved ? `${lane.track.name} · ` : ''}starts ${timecode(pos.start, doc.settings.fps)}`, xOf(pos.start, view), RULER_H + lane.y - view.scrollY, lane.h, W, H, false);
    }
  } else if (trimming && trimming.delta && trimming.clip) {
    const lane = laneOf.get(trimming.clip.track_id);
    if (lane) {
      const length = trimming.clip.duration + (trimming.edge === 'end' ? trimming.delta : -trimming.delta);
      readout(ctx, signedTimecode(trimming.delta, doc.settings.fps), `length ${timecode(Math.max(0, length), doc.settings.fps)}`, xOf(trimming.edgeTime + trimming.delta, view), RULER_H + lane.y - view.scrollY, lane.h, W, H, true);
    }
  }
  // marquee
  if (scene.marquee) {
    const m = scene.marquee;
    ctx.fillStyle = 'rgba(124,156,255,0.14)';
    ctx.strokeStyle = theme.accent;
    ctx.lineWidth = 1;
    ctx.fillRect(m.x, m.y, m.w, m.h);
    ctx.strokeRect(m.x + 0.5, m.y + 0.5, m.w, m.h);
  }
  return { visible, transitionRects, lanes: ls };
}

export function invalidateTheme() {
  theme = null;
}
