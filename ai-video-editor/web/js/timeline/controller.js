// Timeline controller: owns the canvas, the (virtualised) accessible clip elements
// and all pointer / wheel / drag-and-drop interaction.
//
// Rendering is imperative and demand driven: state changes mark the view dirty and
// one requestAnimationFrame redraws it. Only the clips intersecting the viewport
// are drawn and mirrored into the DOM, so cost is independent of project size.

import { clamp, openMenu, prefersReducedMotion, toast, MOD } from '../lib/ui.js';
import { clipEnd, frameTicks, humanDuration, snapToFrame, sourceOut, syncAnchor, timecode, TPS } from '../lib/time.js';
import { clipLabel, clipsByTrack, clipsInRange, linkGroups, setUi, setView, store, tracksOfKind, trackKindOfClip } from '../state/store.js';
import * as A from '../state/actions.js';
import { transport } from '../player/transport.js';
import { drawTimeline, linkOffsetFrames } from './draw.js';
import { HANDLE_W, RULER_H, SNAP_PX, laneAt, lanes, lanesHeight, tOf, xOf } from './geometry.js';
import { onMediaLoaded } from './media-cache.js';
import { DRAG_MIME, dragPayload } from './dnd.js';
import { clampScrollX, contentWidth, pxToTicks, revealTime, viewport, zoomBy, zoomToFit } from './view.js';

const KIND_NAME = { video: 'Video', audio: 'Audio', image: 'Image', text: 'Text', caption: 'Caption' };
const TRANSITION_NAME = { cross_dissolve: 'Cross dissolve', dip_to_black: 'Dip to black', slide: 'Slide', push: 'Push' };
const SCROLL_PROXY_MAX = 4_000_000; // keep native scrollbars within browser layout limits

export class TimelineController {
  /** @param {{view: HTMLElement, canvas: HTMLCanvasElement, clips: HTMLElement, playhead: HTMLElement, hscroll: HTMLElement, vscroll: HTMLElement, empty: HTMLElement}} els */
  constructor(els) {
    this.els = els;
    this.ctx = els.canvas.getContext('2d', { alpha: false });
    this.drag = null;
    this.dropGhosts = null;
    this.snapX = null;
    this.marquee = null;
    this.hoverLaneId = null;
    this.raf = 0;
    this.clipEls = new Map();
    this.trEls = new Map();
    this.markerEls = new Map();
    this.result = null;
    this.W = 0;
    this.H = 0;
    this.lastTime = transport.time;
    this.pointer = null;
    this.autoRaf = 0;
    this.syncingScroll = false;

    this.unsubs = [store.subscribe(() => this.invalidate()), transport.subscribe(() => this.onTransport()), onMediaLoaded(() => this.invalidate())];
    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(els.view);

    const v = els.view;
    this.listen(v, 'pointerdown', (e) => this.onPointerDown(e));
    this.listen(v, 'pointermove', (e) => this.onPointerMove(e));
    this.listen(v, 'pointerup', (e) => this.onPointerUp(e));
    this.listen(v, 'pointercancel', () => this.cancelDrag());
    this.listen(v, 'wheel', (e) => this.onWheel(e), { passive: false });
    this.listen(v, 'contextmenu', (e) => this.onContextMenu(e));
    this.listen(v, 'dblclick', (e) => this.onDoubleClick(e));
    this.listen(v, 'keydown', (e) => this.onKeyDown(e));
    this.listen(v, 'dragenter', (e) => this.onDragOver(e));
    this.listen(v, 'dragover', (e) => this.onDragOver(e));
    this.listen(v, 'dragleave', (e) => this.onDragLeave(e));
    this.listen(v, 'drop', (e) => this.onDrop(e));
    this.listen(els.hscroll, 'scroll', () => this.onProxyScroll('x'));
    this.listen(els.vscroll, 'scroll', () => this.onProxyScroll('y'));
    this.listen(window, 'keydown', (e) => e.key === 'Escape' && this.drag && this.cancelDrag());
    this.resize();
  }

  listen(target, type, fn, opts) {
    target.addEventListener(type, fn, opts);
    this.unsubs.push(() => target.removeEventListener(type, fn, opts));
  }

  destroy() {
    cancelAnimationFrame(this.raf);
    cancelAnimationFrame(this.autoRaf);
    this.ro.disconnect();
    for (const u of this.unsubs) u();
  }

  // -------------------------------------------------------------------------
  // sizing & rendering
  // -------------------------------------------------------------------------
  resize() {
    const r = this.els.view.getBoundingClientRect();
    const W = Math.max(50, Math.floor(r.width));
    const H = Math.max(40, Math.floor(r.height));
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    if (W !== this.W || H !== this.H || dpr !== this.dpr) {
      this.W = W;
      this.H = H;
      this.dpr = dpr;
      this.els.canvas.width = Math.round(W * dpr);
      this.els.canvas.height = Math.round(H * dpr);
      this.els.canvas.style.width = `${W}px`;
      this.els.canvas.style.height = `${H}px`;
      viewport.width = W;
      viewport.height = H;
    }
    this.invalidate();
  }

  invalidate() {
    if (!this.raf) this.raf = requestAnimationFrame(() => this.render());
  }

  maxScrollY(doc) {
    return Math.max(0, lanesHeight(lanes(doc)) + RULER_H + 12 - this.H);
  }

  render() {
    this.raf = 0;
    const state = store.state;
    const doc = state.doc;
    if (!doc) return;
    // first render of a project: pick a zoom that shows the whole edit
    if (!state.view.pxPerSec) {
      if (state.duration > 0) zoomToFit();
      else setView({ pxPerSec: 80, scrollX: 0 });
      return;
    }
    const sx = clampScrollX(state.view.scrollX);
    const sy = clamp(state.view.scrollY, 0, this.maxScrollY(doc));
    if (sx !== state.view.scrollX || sy !== state.view.scrollY) {
      setView({ scrollX: sx, scrollY: sy });
      return;
    }
    const ctx = this.ctx;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    this.result = drawTimeline(ctx, {
      doc,
      layers: state.layers,
      assets: state.assets,
      sel: state.sel,
      view: state.view,
      duration: state.duration,
      W: this.W,
      H: this.H,
      drag: this.drag,
      hoverLaneId: this.hoverLaneId,
      dropGhosts: this.dropGhosts,
      snapX: this.snapX,
      marquee: this.marquee,
    });
    this.syncDom(state, this.result);
    this.syncScrollProxies(state);
    this.positionPlayhead();
    this.els.empty.hidden = doc.clips.size > 0 || !!this.dropGhosts;
  }

  /** Mirror the visible clips / transitions / markers into focusable, labelled DOM elements. */
  syncDom(state, result) {
    const { doc, view, sel } = state;
    const fps = doc.settings.fps;
    const seen = new Set();
    // Zoomed far out on a huge project, sub-3px slivers get no element of their own
    // (they are still drawn, and marquee / keyboard selection work from the data).
    const dense = result.visible.length > 1200;
    for (const { clip, lane } of result.visible) {
      if (dense && (clip.duration / TPS) * view.pxPerSec < 3 && !sel.clips.has(clip.id)) continue;
      seen.add(clip.id);
      let el = this.clipEls.get(clip.id);
      if (!el) {
        el = document.createElement('div');
        el.className = 'tl-clip';
        el.setAttribute('role', 'button');
        el.tabIndex = -1;
        el.dataset.clipId = clip.id;
        el.innerHTML = '<span class="tl-h l" data-handle="start"></span><span class="tl-h r" data-handle="end"></span>';
        this.els.clips.appendChild(el);
        this.clipEls.set(clip.id, el);
      }
      const x = xOf(clip.start, view);
      const w = (clip.duration / TPS) * view.pxPerSec;
      const left = Math.max(x, -30);
      const right = Math.min(x + w, this.W + 30);
      const y = RULER_H + lane.y - view.scrollY;
      el.style.transform = `translate(${left}px, ${y}px)`;
      el.style.width = `${Math.max(2, right - left)}px`;
      el.style.height = `${lane.h}px`;
      // hide the part of a lane that scrolled under the ruler
      el.style.clipPath = y < RULER_H ? `inset(${RULER_H - y}px 0 0 0)` : '';
      const selected = sel.clips.has(clip.id);
      const narrow = w < HANDLE_W * 3;
      if (el._clip !== clip || el._selected !== selected || el._track !== lane.track || el._narrow !== narrow) {
        el._clip = clip;
        el._selected = selected;
        el._track = lane.track;
        el._narrow = narrow;
        el.dataset.kind = clip.content.kind;
        el.dataset.trackId = clip.track_id;
        el.dataset.start = clip.start;
        el.dataset.duration = clip.duration;
        el.classList.toggle('selected', selected);
        el.classList.toggle('locked', !!lane.track.locked);
        el.classList.toggle('narrow', narrow);
        el.classList.toggle('left-cut', x < -30);
        el.setAttribute('aria-pressed', String(selected));
        const off = linkOffsetFrames(doc, clip);
        el.setAttribute(
          'aria-label',
          `${KIND_NAME[clip.content.kind]} clip “${clipLabel(doc, clip)}” on track ${lane.track.name}, starts at ${timecode(clip.start, fps)}, ${humanDuration(clip.duration)} long` +
            (clip.link_id ? `, linked${off ? `, out of sync by ${off} frames` : ''}` : '') +
            (clip.enabled ? '' : ', disabled') +
            (lane.track.locked ? ', track locked' : ''),
        );
      }
    }
    for (const [id, el] of this.clipEls) {
      if (!seen.has(id)) {
        // keep focus inside the timeline when the focused clip scrolls away or is deleted
        if (document.activeElement === el) this.els.view.focus({ preventScroll: true });
        el.remove();
        this.clipEls.delete(id);
      }
    }
    // transitions
    const seenTr = new Set();
    for (const r of result.transitionRects) {
      seenTr.add(r.id);
      let el = this.trEls.get(r.id);
      if (!el) {
        el = document.createElement('button');
        el.type = 'button';
        el.className = 'tl-tr';
        el.tabIndex = -1;
        el.dataset.transitionId = r.id;
        this.els.clips.appendChild(el);
        this.trEls.set(r.id, el);
      }
      el.style.transform = `translate(${r.x}px, ${r.y}px)`;
      el.style.width = `${r.w}px`;
      el.style.height = `${r.h}px`;
      el.style.display = r.y < RULER_H - 4 ? 'none' : '';
      el.setAttribute('aria-pressed', String(sel.transition === r.id));
      el.setAttribute('aria-label', `${TRANSITION_NAME[r.tr.kind] || 'Transition'}, ${humanDuration(r.tr.duration)}`);
      el.dataset.tip = `${TRANSITION_NAME[r.tr.kind] || 'Transition'} · ${humanDuration(r.tr.duration)}`;
      el.dataset.tipPos = 'top';
    }
    for (const [id, el] of this.trEls) {
      if (!seenTr.has(id)) {
        el.remove();
        this.trEls.delete(id);
      }
    }
    // markers (hit targets in the ruler)
    const seenM = new Set();
    for (const m of doc.markers) {
      const x = xOf(m.time, view);
      if (x < -10 || x > this.W + 10) continue;
      seenM.add(m.id);
      let el = this.markerEls.get(m.id);
      if (!el) {
        el = document.createElement('button');
        el.type = 'button';
        el.className = 'tl-marker';
        el.tabIndex = -1;
        el.dataset.markerId = m.id;
        this.els.clips.appendChild(el);
        this.markerEls.set(m.id, el);
      }
      el.style.transform = `translate(${x - 7}px, ${RULER_H - 16}px)`;
      el.setAttribute('aria-label', `Marker ${m.label ? `“${m.label}” ` : ''}at ${timecode(m.time, fps)}`);
      el.dataset.tip = `${m.label || 'Marker'} · ${timecode(m.time, fps)}`;
      el.dataset.tipPos = 'top';
      el.setAttribute('aria-pressed', String(sel.marker === m.id));
    }
    for (const [id, el] of this.markerEls) {
      if (!seenM.has(id)) {
        el.remove();
        this.markerEls.delete(id);
      }
    }
  }

  syncScrollProxies(state) {
    const { hscroll, vscroll } = this.els;
    const content = contentWidth(state);
    const maxX = Math.max(0, content - this.W);
    const innerW = Math.min(content, SCROLL_PROXY_MAX);
    const h = hscroll.firstElementChild;
    if (h._w !== innerW) {
      h._w = innerW;
      h.style.width = `${innerW}px`;
    }
    const proxyMaxX = Math.max(0, innerW - hscroll.clientWidth);
    const wantX = maxX > 0 ? (state.view.scrollX / maxX) * proxyMaxX : 0;
    const maxY = this.maxScrollY(state.doc);
    const v = vscroll.firstElementChild;
    const innerH = maxY + vscroll.clientHeight;
    if (v._h !== innerH) {
      v._h = innerH;
      v.style.height = `${innerH}px`;
    }
    this.syncingScroll = true;
    if (Math.abs(hscroll.scrollLeft - wantX) > 1) hscroll.scrollLeft = wantX;
    if (Math.abs(vscroll.scrollTop - state.view.scrollY) > 1) vscroll.scrollTop = state.view.scrollY;
    this.proxy = { maxX, proxyMaxX };
    // scroll events fire asynchronously; ignore the echo of our own assignment
    requestAnimationFrame(() => (this.syncingScroll = false));
  }

  onProxyScroll(axis) {
    if (this.syncingScroll) return;
    if (axis === 'x') {
      const { maxX, proxyMaxX } = this.proxy || { maxX: 0, proxyMaxX: 0 };
      setView({ scrollX: proxyMaxX > 0 ? (this.els.hscroll.scrollLeft / proxyMaxX) * maxX : 0 });
    } else setView({ scrollY: this.els.vscroll.scrollTop });
    A.persistViewSoon();
  }

  positionPlayhead() {
    const view = store.state.view;
    const x = xOf(transport.time, view);
    const el = this.els.playhead;
    const visible = x >= -1 && x <= this.W + 1;
    el.style.display = visible ? '' : 'none';
    if (visible) el.style.transform = `translateX(${Math.round(x * this.dpr) / this.dpr}px)`;
  }

  onTransport() {
    const t = transport.time;
    const moved = t !== this.lastTime;
    this.lastTime = t;
    if (!store.state.doc) return;
    if (moved && this.drag?.kind !== 'scrub') {
      const view = store.state.view;
      const x = xOf(t, view);
      if (transport.playing) {
        // page the view when the playhead runs off the right edge
        if (x > this.W - 24 || x < 0) setView({ scrollX: clampScrollX(x + view.scrollX - Math.min(120, this.W * 0.15)) });
      } else if (x < 0 || x > this.W) revealTime(t);
    }
    this.positionPlayhead();
    if (moved) A.persistViewSoon();
  }

  // -------------------------------------------------------------------------
  // helpers
  // -------------------------------------------------------------------------
  local(e) {
    const r = this.els.view.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  laneAtY(y) {
    const doc = store.state.doc;
    return laneAt(lanes(doc), y - RULER_H + store.state.view.scrollY);
  }

  /** Sorted timeline positions clips can snap to (edges of clips not being dragged, playhead, markers, 0). */
  snapPoints(excludeIds) {
    const doc = store.state.doc;
    const pts = [0, transport.frameTime];
    for (const c of doc.clips.values()) {
      if (excludeIds?.has(c.id)) continue;
      pts.push(c.start, clipEnd(c));
    }
    for (const m of doc.markers) pts.push(m.time);
    pts.sort((a, b) => a - b);
    return pts;
  }

  /** Nearest snap point to t within the snap radius, or null. */
  nearestSnap(points, t) {
    if (!store.state.view.snapping || !points.length) return null;
    const radius = pxToTicks(SNAP_PX);
    let lo = 0;
    let hi = points.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (points[mid] < t) lo = mid + 1;
      else hi = mid;
    }
    let best = null;
    for (const i of [lo - 1, lo]) {
      const p = points[i];
      if (p == null) continue;
      if (Math.abs(p - t) <= radius && (best == null || Math.abs(p - t) < Math.abs(best - t))) best = p;
    }
    return best;
  }

  // -------------------------------------------------------------------------
  // pointer interaction
  // -------------------------------------------------------------------------
  onPointerDown(e) {
    const state = store.state;
    const doc = state.doc;
    if (!doc || e.button === 2) return;
    const { x, y } = this.local(e);
    const view = state.view;
    this.els.view.focus({ preventScroll: true });
    const capture = () => {
      try {
        this.els.view.setPointerCapture(e.pointerId);
      } catch {
        /* pointer already gone */
      }
    };

    if (e.button === 1) {
      e.preventDefault();
      this.drag = { kind: 'pan', x0: e.clientX, y0: e.clientY, sx: view.scrollX, sy: view.scrollY };
      return capture();
    }

    const markerEl = e.target.closest?.('.tl-marker');
    if (markerEl) {
      const m = doc.markers.find((mm) => mm.id === markerEl.dataset.markerId);
      if (m) {
        A.selectMarker(m.id);
        transport.seek(m.time);
        this.drag = { kind: 'marker', id: m.id, x0: e.clientX, t0: m.time, time: m.time, moved: false };
        capture();
      }
      return;
    }
    const trEl = e.target.closest?.('.tl-tr');
    if (trEl) {
      A.selectTransition(trEl.dataset.transitionId);
      setUi({ rightTab: 'inspector' });
      return;
    }
    if (y < RULER_H) {
      e.preventDefault();
      this.drag = { kind: 'scrub', wasPlaying: transport.playing };
      if (transport.playing) transport.pause();
      this.scrubTo(x);
      return capture();
    }
    const clipEl = e.target.closest?.('.tl-clip');
    if (clipEl) {
      const clip = doc.clips.get(clipEl.dataset.clipId);
      if (!clip) return;
      const handle = e.target.dataset?.handle || null;
      const selected = state.sel.clips.has(clip.id);
      const toggle = e.shiftKey || (!handle && (e.metaKey || e.ctrlKey));
      // Alt bypasses the A/V link for this click (select / move / trim one side only)
      const linked = e.altKey ? false : undefined;
      let collapse = false;
      if (toggle && !handle) {
        A.selectClips([clip.id], { mode: 'toggle', linked });
        return;
      }
      if (!selected || e.altKey) A.selectClips([clip.id], { linked });
      else collapse = true;
      this.drag = { kind: handle ? 'trim-pending' : 'move-pending', clipId: clip.id, handle, x0: e.clientX, y0: e.clientY, sx: view.scrollX, alt: e.altKey, collapse };
      return capture();
    }
    // empty lane
    if (!e.shiftKey) A.clearSelection();
    this.drag = { kind: 'marquee-pending', x0: x, y0: y, cx0: x + view.scrollX, cy0: y + view.scrollY, base: e.shiftKey ? new Set(state.sel.clips) : new Set() };
    capture();
  }

  onPointerMove(e) {
    this.pointer = { clientX: e.clientX, clientY: e.clientY, ctrl: e.ctrlKey || e.metaKey, shift: e.shiftKey };
    const d = this.drag;
    if (!d || d.settling) return;
    const { x, y } = this.local(e);
    const moved = Math.hypot(e.clientX - (d.x0 ?? 0), e.clientY - (d.y0 ?? 0)) > 4;
    switch (d.kind) {
      case 'pan':
        setView({ scrollX: clampScrollX(d.sx - (e.clientX - d.x0)), scrollY: clamp(d.sy - (e.clientY - d.y0), 0, this.maxScrollY(store.state.doc)) });
        break;
      case 'scrub':
        this.scrubTo(x);
        this.autoScroll(x);
        break;
      case 'marker': {
        const fps = store.state.doc.settings.fps;
        const t = Math.max(0, snapToFrame(d.t0 + pxToTicks(e.clientX - d.x0), fps));
        if (t !== d.time) {
          d.time = t;
          d.moved = true;
          transport.seek(t);
        }
        break;
      }
      case 'move-pending':
        if (moved) this.beginMove(d, e);
        break;
      case 'move':
        this.updateMove(d, e.clientX, y);
        this.autoScroll(x);
        break;
      case 'trim-pending':
        if (Math.abs(e.clientX - d.x0) > 2) this.beginTrim(d);
        break;
      case 'trim':
        this.updateTrim(d, e.clientX);
        this.autoScroll(x);
        break;
      case 'marquee-pending':
        if (Math.hypot(x - d.x0, y - d.y0) > 4) d.kind = 'marquee';
        break;
      case 'marquee':
        this.updateMarquee(d, x, y);
        this.autoScroll(x);
        break;
    }
  }

  onPointerUp(e) {
    const d = this.drag;
    cancelAnimationFrame(this.autoRaf);
    this.autoRaf = 0;
    if (!d || d.settling) return;
    const ctrl = e.ctrlKey || e.metaKey;
    const done = () => {
      this.drag = null;
      this.snapX = null;
      this.marquee = null;
      this.invalidate();
    };
    switch (d.kind) {
      case 'scrub':
        A.persistViewSoon();
        return done();
      case 'marker':
        if (d.moved) A.exec({ type: 'update_marker', marker_id: d.id, time: d.time });
        return done();
      case 'move-pending':
        // plain click on an already selected clip narrows the selection to it
        if (d.collapse) A.selectClips([d.clipId], { linked: d.alt ? false : undefined });
        return done();
      case 'trim-pending':
      case 'pan':
        return done();
      case 'marquee-pending': {
        // click on an empty lane: move the playhead there
        const fps = store.state.doc.settings.fps;
        transport.seek(Math.max(0, snapToFrame(tOf(d.x0, store.state.view), fps)));
        return done();
      }
      case 'marquee':
        return done();
      case 'move': {
        const doc = store.state.doc;
        const moves = [...d.preview].map(([clip_id, p]) => ({ clip_id, start: p.start, track_id: p.trackId }));
        const changed = moves.some((m) => {
          const c = doc.clips.get(m.clip_id);
          return c && (c.start !== m.start || c.track_id !== m.track_id);
        });
        if (!changed) return done();
        // keep showing the preview until the server has applied the move (no flicker)
        d.settling = true;
        this.snapX = null;
        this.invalidate();
        return A.exec({ type: 'move_clips', moves, mode: ctrl ? 'insert' : 'overwrite' }, { errorTitle: 'Could not move the clip' }).finally(done);
      }
      case 'trim': {
        if (!d.delta) return done();
        d.settling = true;
        this.snapX = null;
        this.invalidate();
        return A.exec({ type: 'trim_clips', clip_ids: [...d.ids], edge: d.edge, delta: d.delta, ripple: ctrl }, { errorTitle: 'Could not trim the clip' }).finally(done);
      }
      default:
        return done();
    }
  }

  cancelDrag() {
    cancelAnimationFrame(this.autoRaf);
    this.autoRaf = 0;
    if (this.drag?.settling) return;
    this.drag = null;
    this.snapX = null;
    this.marquee = null;
    this.invalidate();
  }

  scrubTo(x) {
    const { doc, view } = store.state;
    let t = Math.max(0, tOf(x, view));
    // snap the playhead to edit points while scrubbing (when snapping is on)
    const pts = (this._scrubPts ||= { rev: -1, pts: [] });
    if (pts.rev !== doc.revision) {
      pts.rev = doc.revision;
      pts.pts = A.editPoints();
    }
    const snap = this.nearestSnap(pts.pts, t);
    if (snap != null) t = snap;
    transport.seek(snapToFrame(t, doc.settings.fps));
  }

  /** Keep scrolling while a drag is held near the left / right edge. */
  autoScroll(x) {
    const edge = 36;
    const dir = x < edge ? -1 : x > this.W - edge ? 1 : 0;
    cancelAnimationFrame(this.autoRaf);
    this.autoRaf = 0;
    if (!dir || !this.drag) return;
    const step = () => {
      this.autoRaf = 0;
      const d = this.drag;
      if (!d || d.settling || !this.pointer) return;
      const view = store.state.view;
      const next = clampScrollX(view.scrollX + dir * 14);
      if (next === view.scrollX) return;
      setView({ scrollX: next });
      const p = this.pointer;
      const { x: lx, y: ly } = this.local(p);
      if (d.kind === 'move') this.updateMove(d, p.clientX, ly);
      else if (d.kind === 'trim') this.updateTrim(d, p.clientX);
      else if (d.kind === 'scrub') this.scrubTo(lx);
      else if (d.kind === 'marquee') this.updateMarquee(d, lx, ly);
      this.autoRaf = requestAnimationFrame(step);
    };
    this.autoRaf = requestAnimationFrame(step);
  }

  // ---- move ---------------------------------------------------------------
  beginMove(d) {
    const { doc, sel } = store.state;
    const grabbed = doc.clips.get(d.clipId);
    if (!grabbed) return this.cancelDrag();
    const locked = (c) => doc.tracks.find((t) => t.id === c.track_id)?.locked;
    if (locked(grabbed)) {
      toast({ title: 'This track is locked', detail: 'Unlock it in the track header to move its clips.' });
      return this.cancelDrag();
    }
    const clips = [...sel.clips].map((id) => doc.clips.get(id)).filter((c) => c && !locked(c));
    if (!clips.some((c) => c.id === grabbed.id)) clips.push(grabbed);
    const ids = new Set(clips.map((c) => c.id));
    d.kind = 'move';
    d.clips = clips;
    d.grabbed = grabbed;
    d.points = this.snapPoints(ids);
    d.minStart = Math.min(...clips.map((c) => c.start));
    d.maxEnd = Math.max(...clips.map((c) => clipEnd(c)));
    d.ordinals = {};
    for (const kind of ['video', 'audio', 'caption']) d.ordinals[kind] = tracksOfKind(doc, kind);
    d.dOrd = 0;
    d.preview = new Map(clips.map((c) => [c.id, { start: c.start, trackId: c.track_id }]));
  }

  updateMove(d, clientX, y) {
    const { doc, view } = store.state;
    const fps = doc.settings.fps;
    let delta = pxToTicks(clientX - d.x0 + (view.scrollX - d.sx));
    // snap any of: selection start/end, grabbed clip start/end
    let snapAt = null;
    let best = Infinity;
    for (const probe of [d.minStart, d.maxEnd, d.grabbed.start, clipEnd(d.grabbed)]) {
      const s = this.nearestSnap(d.points, probe + delta);
      if (s != null && Math.abs(s - (probe + delta)) < best) {
        best = Math.abs(s - (probe + delta));
        snapAt = { s, probe };
      }
    }
    if (snapAt) delta = snapAt.s - snapAt.probe;
    delta = snapToFrame(d.minStart + delta, fps) - d.minStart;
    if (d.minStart + delta < 0) delta = -d.minStart;
    this.snapX = snapAt && snapAt.s - snapAt.probe === delta ? xOf(snapAt.s, view) : null;

    // vertical: move by whole tracks of the same kind; linked audio mirrors video (V2 ⇄ A2)
    const lane = this.laneAtY(y);
    const gKind = trackKindOfClip(d.grabbed);
    if (lane && gKind !== 'caption') {
      const list = d.ordinals[gKind];
      const from = list.findIndex((t) => t.id === d.grabbed.track_id);
      let want = d.dOrd;
      if (lane.track.kind === gKind) want = list.findIndex((t) => t.id === lane.track.id) - from;
      let lo = -Infinity;
      let hi = Infinity;
      for (const c of d.clips) {
        const k = trackKindOfClip(c);
        if (k === 'caption') continue;
        const l = d.ordinals[k];
        const o = l.findIndex((t) => t.id === c.track_id);
        lo = Math.max(lo, -o);
        hi = Math.min(hi, l.length - 1 - o);
      }
      want = clamp(want, lo, hi);
      // never land on a locked track
      const lands = (dOrd) =>
        d.clips.every((c) => {
          const k = trackKindOfClip(c);
          if (k === 'caption') return true;
          const l = d.ordinals[k];
          return !l[l.findIndex((t) => t.id === c.track_id) + dOrd]?.locked;
        });
      d.dOrd = lands(want) ? want : lands(d.dOrd) ? d.dOrd : 0;
    }
    for (const c of d.clips) {
      const k = trackKindOfClip(c);
      let trackId = c.track_id;
      if (k !== 'caption' && d.dOrd) {
        const l = d.ordinals[k];
        trackId = l[l.findIndex((t) => t.id === c.track_id) + d.dOrd]?.id || c.track_id;
      }
      d.preview.set(c.id, { start: c.start + delta, trackId });
    }
    this.invalidate();
  }

  // ---- trim ---------------------------------------------------------------
  beginTrim(d) {
    const { doc, view } = store.state;
    const clip = doc.clips.get(d.clipId);
    if (!clip) return this.cancelDrag();
    const locked = (c) => doc.tracks.find((t) => t.id === c.track_id)?.locked;
    if (locked(clip)) {
      toast({ title: 'This track is locked', detail: 'Unlock it in the track header to trim its clips.' });
      return this.cancelDrag();
    }
    const edge = d.handle;
    const edgeOf = (c) => (edge === 'start' ? c.start : clipEnd(c));
    const ids = new Set([clip.id]);
    // linked partners that share this edit point trim together (Alt = this clip only)
    if (view.linked && !d.alt && clip.link_id) {
      for (const o of linkGroups(doc).links.get(clip.link_id) || []) if (edgeOf(o) === edgeOf(clip) && !locked(o)) ids.add(o.id);
    }
    d.kind = 'trim';
    d.edge = edge;
    d.ids = ids;
    d.clip = clip;
    d.edgeTime = edgeOf(clip);
    d.points = this.snapPoints(ids);
    d.delta = 0;
    // static limits (source media and neighbours); the server re-validates on commit
    const frame = frameTicks(doc.settings.fps);
    const byTrack = clipsByTrack(doc);
    let lo = -Infinity;
    let hi = Infinity;
    let loRipple = -Infinity;
    let hiRipple = Infinity;
    for (const id of ids) {
      const c = doc.clips.get(id);
      const arr = byTrack.get(c.track_id) || [];
      const i = arr.indexOf(c);
      const timed = c.content.kind === 'video' || c.content.kind === 'audio';
      const asset = timed ? doc.assets.get(c.content.asset_id) : null;
      const ratio = c.speed.den / c.speed.num;
      if (edge === 'end') {
        lo = Math.max(lo, -(c.duration - frame));
        loRipple = Math.max(loRipple, -(c.duration - frame));
        if (asset) {
          const room = Math.max(0, Math.floor(((asset.duration - sourceOut(c)) * ratio) / frame) * frame);
          hi = Math.min(hi, room);
          hiRipple = Math.min(hiRipple, room);
        }
        const next = arr[i + 1];
        if (next && !ids.has(next.id)) hi = Math.min(hi, next.start - clipEnd(c));
      } else {
        hi = Math.min(hi, c.duration - frame);
        hiRipple = Math.min(hiRipple, c.duration - frame);
        if (asset) {
          const room = Math.max(0, Math.floor((c.source_in * ratio) / frame) * frame);
          lo = Math.max(lo, -room);
          loRipple = Math.max(loRipple, -room);
        }
        const prev = arr[i - 1];
        lo = Math.max(lo, (prev && !ids.has(prev.id) ? clipEnd(prev) : 0) - c.start);
      }
    }
    d.limits = { lo, hi, loRipple, hiRipple };
  }

  updateTrim(d, clientX) {
    const { doc, view } = store.state;
    const ripple = !!this.pointer?.ctrl;
    let delta = pxToTicks(clientX - d.x0 + (view.scrollX - d.sx));
    const snap = this.nearestSnap(d.points, d.edgeTime + delta);
    if (snap != null) delta = snap - d.edgeTime;
    delta = snapToFrame(Math.max(0, d.edgeTime + delta), doc.settings.fps) - d.edgeTime;
    const lo = ripple ? d.limits.loRipple : d.limits.lo;
    const hi = ripple ? d.limits.hiRipple : d.limits.hi;
    const clamped = lo > hi ? 0 : clamp(delta, lo, hi);
    this.snapX = snap != null && clamped === delta ? xOf(snap, view) : null;
    d.delta = clamped;
    this.invalidate();
  }

  // ---- marquee ------------------------------------------------------------
  updateMarquee(d, x, y) {
    const { doc, view } = store.state;
    const cx = x + view.scrollX;
    const cy = y + view.scrollY;
    const x0 = Math.min(d.cx0, cx);
    const x1 = Math.max(d.cx0, cx);
    const y0 = Math.min(d.cy0, cy) - RULER_H;
    const y1 = Math.max(d.cy0, cy) - RULER_H;
    this.marquee = { x: x0 - view.scrollX, y: Math.max(RULER_H, y0 + RULER_H - view.scrollY), w: x1 - x0, h: Math.max(0, y1 + RULER_H - view.scrollY - Math.max(RULER_H, y0 + RULER_H - view.scrollY)) };
    const hit = [];
    const t0 = (x0 / view.pxPerSec) * TPS;
    const t1 = (x1 / view.pxPerSec) * TPS;
    for (const lane of lanes(doc)) {
      if (lane.y + lane.h < y0 || lane.y > y1 || lane.track.locked) continue;
      for (const c of clipsInRange(doc, lane.track.id, t0, t1)) hit.push(c.id);
    }
    const next = new Set([...d.base, ...A.expandSelection(hit)]);
    const cur = store.state.sel.clips;
    if (next.size !== cur.size || [...next].some((id) => !cur.has(id))) store.set({ sel: { clips: next, transition: null, marker: null } });
    this.invalidate();
  }

  // -------------------------------------------------------------------------
  // wheel / keyboard
  // -------------------------------------------------------------------------
  onWheel(e) {
    const { doc, view } = store.state;
    if (!doc) return;
    e.preventDefault();
    const { x } = this.local(e);
    const unit = e.deltaMode === 1 ? 32 : 1;
    if (e.ctrlKey || e.metaKey) {
      zoomBy(Math.exp(-e.deltaY * unit * 0.0022), x);
    } else {
      const maxY = this.maxScrollY(doc);
      const horizontal = e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY) || maxY === 0;
      if (horizontal) {
        const d = (Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY) * unit;
        setView({ scrollX: clampScrollX(view.scrollX + d) });
      } else setView({ scrollY: clamp(view.scrollY + e.deltaY * unit, 0, maxY) });
    }
    A.persistViewSoon();
  }

  /** Clip-to-clip keyboard navigation (Ctrl/⌘+arrows) and activation keys on focused items. */
  onKeyDown(e) {
    const { doc, sel } = store.state;
    if (!doc) return;
    const mod = e.metaKey || e.ctrlKey;
    const focusedClip = e.target.closest?.('.tl-clip');
    if ((e.key === 'Enter' || e.key === ' ') && focusedClip && !mod) {
      e.preventDefault();
      A.selectClips([focusedClip.dataset.clipId], { mode: e.shiftKey ? 'toggle' : 'replace' });
      return;
    }
    if (!mod || e.altKey || !['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) return;
    e.preventDefault();
    const byTrack = clipsByTrack(doc);
    const current = doc.clips.get(focusedClip?.dataset.clipId) || doc.clips.get([...sel.clips][0]);
    let target = null;
    const t = current ? current.start : transport.frameTime;
    if (!current) {
      // start from the clip under / after the playhead on the first track that has clips
      for (const tr of doc.tracks) {
        const arr = byTrack.get(tr.id) || [];
        target = arr.find((c) => clipEnd(c) > t) || arr[arr.length - 1];
        if (target) break;
      }
    } else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      const arr = byTrack.get(current.track_id) || [];
      target = arr[arr.indexOf(current) + (e.key === 'ArrowRight' ? 1 : -1)];
    } else {
      const order = doc.tracks.map((tr) => tr.id);
      let i = order.indexOf(current.track_id);
      const step = e.key === 'ArrowDown' ? 1 : -1;
      for (i += step; i >= 0 && i < order.length && !target; i += step) {
        const arr = byTrack.get(order[i]) || [];
        target = arr.find((c) => c.start <= t && clipEnd(c) > t) || arr.find((c) => clipEnd(c) > t) || arr[arr.length - 1];
      }
    }
    if (!target) return;
    A.selectClips([target.id], { linked: false, mode: e.shiftKey ? 'add' : 'replace' });
    transport.seek(target.start);
    revealTime(target.start);
    // focus the element once it has been rendered so assistive tech announces it
    requestAnimationFrame(() => requestAnimationFrame(() => this.clipEls.get(target.id)?.focus({ preventScroll: true })));
  }

  onDoubleClick(e) {
    if (e.target.closest?.('.tl-clip, .tl-tr')) setUi({ rightTab: 'inspector' });
  }

  // -------------------------------------------------------------------------
  // context menus
  // -------------------------------------------------------------------------
  onContextMenu(e) {
    const { doc, sel } = store.state;
    if (!doc) return;
    e.preventDefault();
    const { x, y } = this.local(e);
    const keyboard = e.clientX === 0 && e.clientY === 0;
    const fps = doc.settings.fps;
    const at = Math.max(0, snapToFrame(tOf(x, store.state.view), fps));

    const trEl = e.target.closest?.('.tl-tr');
    if (trEl) {
      const id = trEl.dataset.transitionId;
      const tr = doc.transitions.get(id);
      A.selectTransition(id);
      const isAudio = doc.tracks.find((t) => t.id === doc.clips.get(tr.left)?.track_id)?.kind === 'audio';
      return openMenu(e, [
        { heading: isAudio ? 'Crossfade' : 'Transition' },
        ...(isAudio ? [] : Object.entries(TRANSITION_NAME).map(([kind, label]) => ({ label, checked: tr.kind === kind, onSelect: () => A.exec({ type: 'update_transition', transition_id: id, kind }) }))),
        !isAudio && { separator: true },
        { label: 'Edit in inspector', icon: 'sliders', onSelect: () => setUi({ rightTab: 'inspector' }) },
        { label: 'Remove transition', icon: 'trash', danger: true, hint: 'Del', onSelect: () => A.exec({ type: 'remove_transitions', transition_ids: [id] }) },
      ]);
    }
    const markerEl = e.target.closest?.('.tl-marker');
    if (markerEl) {
      const id = markerEl.dataset.markerId;
      A.selectMarker(id);
      return openMenu(e, [
        { label: 'Edit in inspector', icon: 'sliders', onSelect: () => setUi({ rightTab: 'inspector' }) },
        { label: 'Remove marker', icon: 'trash', danger: true, onSelect: () => A.exec({ type: 'remove_marker', marker_id: id }) },
      ]);
    }
    const clipEl = e.target.closest?.('.tl-clip');
    if (clipEl) {
      const clip = doc.clips.get(clipEl.dataset.clipId);
      if (!clip) return;
      if (!sel.clips.has(clip.id)) A.selectClips([clip.id]);
      const clips = A.selectedClips();
      const ids = clips.map((c) => c.id);
      const anyLinked = clips.some((c) => c.link_id);
      const anyGrouped = clips.some((c) => c.group_id);
      const audioOnly = clips.every((c) => c.content.kind === 'audio');
      const media = clips.some((c) => c.content.kind === 'video' || c.content.kind === 'audio');
      const canTransition = clips.some((c) => c.content.kind !== 'caption');
      const off = clips.map((c) => ({ c, f: linkOffsetFrames(doc, c) })).filter((o) => o.f && o.c.content.kind !== 'video');
      const t = transport.frameTime;
      const underPlayhead = clips.some((c) => c.start < t && clipEnd(c) > t);
      return openMenu(e, [
        { label: 'Split at playhead', icon: 'scissors', hint: 'S', disabled: !underPlayhead, onSelect: () => A.splitAtPlayhead() },
        { separator: true },
        { label: 'Cut', hint: `${MOD}+X`, onSelect: () => A.cutSelection() },
        { label: 'Copy', icon: 'copy', hint: `${MOD}+C`, onSelect: () => A.copySelection() },
        { label: 'Duplicate', hint: `${MOD}+D`, onSelect: () => A.duplicateSelection() },
        { label: 'Delete', icon: 'trash', hint: 'Del', onSelect: () => A.deleteSelection() },
        { label: 'Ripple delete', icon: 'ripple', hint: 'Shift+Del', onSelect: () => A.deleteSelection({ ripple: true }) },
        { separator: true },
        anyLinked ? { label: 'Unlink clips', icon: 'unlink', hint: `${MOD}+Alt+L`, onSelect: () => A.unlinkSelection() } : { label: 'Link clips', icon: 'link', hint: `${MOD}+Alt+L`, disabled: ids.length < 2, onSelect: () => A.linkSelection() },
        off.length > 0 && {
          label: 'Move into sync',
          icon: 'refresh',
          onSelect: () => {
            // restore the shared sync anchor of each out-of-sync clip (relative to its picture / partner)
            const frame = frameTicks(fps);
            A.exec({ type: 'move_clips', moves: off.map(({ c, f }) => ({ clip_id: c.id, start: Math.max(0, c.start - f * frame), track_id: c.track_id })) }, { errorTitle: 'Could not move the clip into sync' });
          },
        },
        anyGrouped ? { label: 'Ungroup', icon: 'group', hint: `${MOD}+Shift+G`, onSelect: () => A.ungroupSelection() } : { label: 'Group', icon: 'group', hint: `${MOD}+G`, disabled: ids.length < 2, onSelect: () => A.groupSelection() },
        { label: clips.every((c) => c.enabled) ? 'Disable' : 'Enable', icon: clips.every((c) => c.enabled) ? 'eye-off' : 'eye', hint: 'D', onSelect: () => A.toggleEnabled() },
        canTransition && { separator: true },
        canTransition && { heading: audioOnly ? 'Add crossfade at cut' : 'Add transition at cut' },
        ...(canTransition ? (audioOnly ? [['cross_dissolve', 'Crossfade']] : Object.entries(TRANSITION_NAME)).map(([kind, label]) => ({ label, icon: 'transition', hint: kind === 'cross_dissolve' ? `${MOD}+T` : undefined, onSelect: () => A.addTransition(kind) })) : []),
        media && { separator: true },
        media && { heading: 'Speed' },
        ...(media ? [0.5, 1, 1.5, 2].map((s) => ({ label: `${s}×`, icon: 'gauge', checked: clips.every((c) => c.speed.num / c.speed.den === s) || undefined, onSelect: () => A.setSpeed(s) })) : []),
        { separator: true },
        { label: 'Show in inspector', icon: 'sliders', onSelect: () => setUi({ rightTab: 'inspector' }) },
      ]);
    }
    if (!keyboard && y < RULER_H) {
      return openMenu(e, [
        { label: 'Add marker here', icon: 'flag', onSelect: () => A.exec({ type: 'add_marker', time: at, label: '' }) },
        { label: 'Move playhead here', onSelect: () => transport.seek(at) },
      ]);
    }
    // empty lane
    const lane = keyboard ? null : this.laneAtY(y);
    const atTime = keyboard ? transport.frameTime : at;
    openMenu(e, [
      { label: 'Paste', hint: `${MOD}+V`, disabled: !A.canPaste(), onSelect: () => A.paste({ at: atTime }) },
      { label: 'Paste insert', hint: `${MOD}+Shift+V`, disabled: !A.canPaste(), onSelect: () => A.paste({ at: atTime, mode: 'insert' }) },
      { separator: true },
      lane && { label: 'Close gap', icon: 'ripple', disabled: lane.track.locked, onSelect: () => A.exec({ type: 'close_gap', track_id: lane.track.id, at: atTime }, { errorTitle: 'Could not close the gap' }) },
      { label: 'Add text here', icon: 'type', onSelect: () => A.exec({ type: 'add_text', text: 'Your text', start: atTime, track_id: lane?.track.kind === 'video' && !lane.track.locked ? lane.track.id : null }, { select: 'created' }) },
      { label: 'Add marker here', icon: 'flag', hint: 'M', onSelect: () => A.exec({ type: 'add_marker', time: atTime, label: '' }) },
      { separator: true },
      lane && {
        label: `Select all on ${lane.track.name}`,
        onSelect: () => store.set({ sel: { clips: new Set((clipsByTrack(doc).get(lane.track.id) || []).map((c) => c.id)), transition: null, marker: null } }),
      },
      { label: 'Select all', hint: `${MOD}+A`, onSelect: () => A.selectAll() },
    ]);
  }

  // -------------------------------------------------------------------------
  // drag & drop from the media bin / the desktop
  // -------------------------------------------------------------------------
  dropPlan(e) {
    const payload = dragPayload.asset;
    const { doc, view } = store.state;
    if (!payload || !doc) return null;
    const asset = doc.assets.get(payload.assetId);
    if (!asset) return null;
    const { x, y } = this.local(e);
    const fps = doc.settings.fps;
    const frame = frameTicks(fps);
    const duration = asset.kind === 'image' ? 5 * TPS : Math.max(frame, Math.floor(asset.duration / frame) * frame);
    let start = Math.max(0, tOf(x, view));
    const pts = (this._dropPts ||= this.snapPoints(null));
    const s0 = this.nearestSnap(pts, start);
    const s1 = this.nearestSnap(pts, start + duration);
    let snapAt = null;
    if (s0 != null) {
      start = s0;
      snapAt = s0;
    } else if (s1 != null) {
      start = s1 - duration;
      snapAt = s1;
    }
    start = Math.max(0, snapToFrame(start, fps));
    const lane = this.laneAtY(Math.max(RULER_H, y));
    const vTracks = tracksOfKind(doc, 'video');
    const aTracks = tracksOfKind(doc, 'audio');
    const ghosts = [];
    let trackId = null;
    if (asset.kind === 'subtitle') {
      const cap = doc.tracks.find((t) => t.kind === 'caption');
      if (cap) ghosts.push({ trackId: cap.id, start, duration: Math.max(asset.duration, TPS), kind: 'caption' });
      trackId = cap?.id || null;
    } else {
      const wantVideo = asset.kind === 'image' || (asset.kind === 'video' && asset.has_video);
      const wantAudio = asset.kind !== 'image' && asset.has_audio;
      let ord = 0;
      if (lane?.track.kind === 'video' && wantVideo) ord = vTracks.findIndex((t) => t.id === lane.track.id);
      else if (lane?.track.kind === 'audio' && wantAudio) ord = aTracks.findIndex((t) => t.id === lane.track.id);
      ord = Math.max(0, ord);
      const v = wantVideo ? vTracks[Math.min(ord, vTracks.length - 1)] : null;
      const a = wantAudio ? aTracks[ord] : null;
      if (v) ghosts.push({ trackId: v.id, start, duration, kind: asset.kind === 'image' ? 'image' : 'video' });
      if (a) ghosts.push({ trackId: a.id, start, duration, kind: 'audio' });
      trackId = (wantVideo ? v?.id : a?.id) || null;
      if ((v && v.locked) || (a && a.locked)) return { blocked: true };
    }
    return { assetId: asset.id, start, trackId, ghosts, snapAt, laneId: lane?.track.id };
  }

  onDragOver(e) {
    const types = e.dataTransfer?.types || [];
    const isFiles = [...types].includes('Files');
    if (!dragPayload.asset && !isFiles && ![...types].includes(DRAG_MIME)) return;
    e.preventDefault();
    if (isFiles && !dragPayload.asset) {
      e.dataTransfer.dropEffect = 'copy';
      this.els.view.classList.add('file-drop');
      return;
    }
    const plan = this.dropPlan(e);
    if (!plan || plan.blocked) {
      e.dataTransfer.dropEffect = 'none';
      this.dropGhosts = null;
      this.snapX = null;
    } else {
      e.dataTransfer.dropEffect = 'copy';
      this.dropGhosts = plan.ghosts;
      this.snapX = plan.snapAt != null ? xOf(plan.snapAt, store.state.view) : null;
    }
    this.invalidate();
  }

  onDragLeave(e) {
    if (e.relatedTarget && this.els.view.contains(e.relatedTarget)) return;
    this.endDrop();
  }

  endDrop() {
    this.dropGhosts = null;
    this.snapX = null;
    this._dropPts = null;
    this.els.view.classList.remove('file-drop');
    this.invalidate();
  }

  onDrop(e) {
    e.preventDefault();
    const files = e.dataTransfer?.files;
    if (!dragPayload.asset && files?.length) {
      this.endDrop();
      A.importFiles(files);
      toast({ title: files.length === 1 ? 'Importing 1 file' : `Importing ${files.length} files`, detail: 'Drag it from the media bin onto the timeline once it has been analysed.', timeout: 3500 });
      return;
    }
    const plan = this.dropPlan(e);
    this.endDrop();
    if (!plan || plan.blocked) {
      if (plan?.blocked) toast({ title: 'That track is locked', detail: 'Unlock it or drop the clip on another track.' });
      return;
    }
    A.addAssetToTimeline(plan.assetId, { start: plan.start, trackId: plan.trackId, mode: e.ctrlKey || e.metaKey ? 'insert' : 'overwrite' });
    this.els.view.focus({ preventScroll: true });
  }
}

export const reducedMotion = prefersReducedMotion;
export { syncAnchor };
