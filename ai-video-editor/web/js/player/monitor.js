// Monitor: the preview viewer — composited picture, transport controls, timecode,
// volume, and direct manipulation of the selected clip (move / scale / rotate).
import { html, useEffect, useLayoutEffect, useRef, useState, useStore, useEmitter, cx, clamp, Icon, IconButton, Spinner, Progress, Slider, EmptyState } from '../lib/ui.js';
import { clipLabel, setLive, store, trackById } from '../state/store.js';
import { clearSelection, exec, selectClips } from '../state/actions.js';
import { kbd } from '../lib/shortcuts.js';
import { frameToTicks, secondsToTicks, timecode } from '../lib/time.js';
import { transport } from './transport.js';
import { engine } from './engine.js';

const STAGE_PADDING = 14;
const SNAP_PX = 6;
const DRAG_THRESHOLD = 3;
const round = (v, d) => Number(v.toFixed(d));

/** Parse "HH:MM:SS:FF", "MM:SS", "SS.s" or plain seconds into ticks. */
export function parseTimeInput(text, fps) {
  const s = String(text).trim();
  if (!s) return null;
  const parts = s.split(/[:;]/).map((p) => p.trim());
  if (parts.some((p) => p === '' || !/^\d+(\.\d+)?$/.test(p))) return null;
  const n = parts.map(Number);
  if (n.length === 1) return secondsToTicks(n[0]);
  if (n.length === 2) return secondsToTicks(n[0] * 60 + n[1]);
  if (n.length === 3) return secondsToTicks(n[0] * 3600 + n[1] * 60 + n[2]);
  if (n.length === 4) {
    const base = Math.max(1, Math.round(fps.num / fps.den));
    const frames = (n[0] * 3600 + n[1] * 60 + n[2]) * base + n[3];
    return frameToTicks(Math.round(frames), fps);
  }
  return null;
}

function Timecode({ fps }) {
  const [editing, setEditing] = useState(false);
  const [invalid, setInvalid] = useState(false);
  const label = useRef(null);
  const input = useRef(null);
  // painted straight into the DOM: the playhead moves every frame
  useLayoutEffect(() => {
    if (editing) return undefined;
    let shown = '';
    const paint = () => {
      const text = timecode(transport.time, fps);
      if (label.current && text !== shown) label.current.textContent = shown = text;
    };
    paint();
    return transport.subscribe(paint);
  }, [editing, fps.num, fps.den]);
  useEffect(() => {
    if (editing) input.current?.select();
  }, [editing]);
  if (editing) {
    const commit = (el) => {
      const t = parseTimeInput(el.value, fps);
      if (t == null) {
        setInvalid(true);
        return false;
      }
      transport.seek(t);
      setInvalid(false);
      setEditing(false);
      return true;
    };
    return html`<input
      ref=${input}
      class="input monitor-tc-input tnum"
      aria-label="Go to time (hours:minutes:seconds:frames, or seconds)"
      aria-invalid=${String(invalid)}
      defaultValue=${timecode(transport.frameTime, fps)}
      onKeyDown=${(e) => {
        e.stopPropagation();
        if (e.key === 'Enter') commit(e.currentTarget);
        else if (e.key === 'Escape') {
          setInvalid(false);
          setEditing(false);
        }
      }}
      onBlur=${() => {
        setInvalid(false);
        setEditing(false);
      }}
    />`;
  }
  return html`<button type="button" class="monitor-tc tnum" onClick=${() => setEditing(true)} data-tip="Click to jump to a time" data-tip-pos="top" aria-label="Current time. Activate to type a time to jump to">
    <span ref=${label} data-testid="timecode"></span>
  </button>`;
}

function TransportBar({ fps, duration, stageRef }) {
  const t = useEmitter(transport, () => ({ playing: transport.playing, rate: transport.rate, loop: transport.loop }));
  const vol = useEmitter(engine, () => ({ v: engine.masterVolume, muted: engine.muted }));
  const [fullscreen, setFullscreen] = useState(false);
  useEffect(() => {
    const on = () => setFullscreen(document.fullscreenElement === stageRef.current);
    document.addEventListener('fullscreenchange', on);
    return () => document.removeEventListener('fullscreenchange', on);
  }, []);
  const toggleFullscreen = () => {
    if (document.fullscreenElement) document.exitFullscreen?.();
    else stageRef.current?.requestFullscreen?.().catch(() => {});
  };
  const empty = duration <= 0;
  return html`<div class="monitor-bar" role="toolbar" aria-label="Playback">
    <div class="monitor-bar-side">
      <${Timecode} fps=${fps} />
      <span class="monitor-dur tnum faint" aria-label="Timeline duration">/ ${timecode(duration, fps)}</span>
    </div>
    <div class="monitor-bar-center">
      <${IconButton} icon="skip-start" label="Go to start" kbd=${kbd('home')} tipPos="top" disabled=${empty} onClick=${() => transport.seek(0)} />
      <${IconButton} icon="step-back" label="Previous frame" kbd=${kbd('arrowleft')} tipPos="top" disabled=${empty} onClick=${() => transport.stepFrames(-1)} />
      <button
        type="button"
        class="monitor-play"
        aria-label=${t.playing ? 'Pause' : 'Play'}
        data-tip=${`${t.playing ? 'Pause' : 'Play'}  (Space)`}
        data-tip-pos="top"
        data-testid="play-toggle"
        data-playing=${String(t.playing)}
        disabled=${empty}
        onClick=${() => transport.toggle()}
      >
        <${Icon} name=${t.playing ? 'pause' : 'play'} size=${18} />
      </button>
      <${IconButton} icon="step-forward" label="Next frame" kbd=${kbd('arrowright')} tipPos="top" disabled=${empty} onClick=${() => transport.stepFrames(1)} />
      <${IconButton} icon="skip-end" label="Go to end" kbd=${kbd('end')} tipPos="top" disabled=${empty} onClick=${() => transport.seek(duration)} />
    </div>
    <div class="monitor-bar-side end">
      ${t.playing && t.rate !== 1 && html`<span class="badge accent tnum" role="status" aria-label=${`Shuttle speed ${t.rate} times`}>${t.rate < 0 ? '−' : ''}${Math.abs(t.rate)}×</span>`}
      <${IconButton} icon="refresh" label=${t.loop ? 'Loop playback: on' : 'Loop playback: off'} pressed=${t.loop} tipPos="top" onClick=${() => (transport.loop = !t.loop)} />
      <div class="monitor-volume">
        <${IconButton} icon=${vol.muted || vol.v === 0 ? 'mute' : 'volume'} label=${vol.muted ? 'Unmute preview' : 'Mute preview'} pressed=${vol.muted} tipPos="top" onClick=${() => (engine.muted = !vol.muted)} />
        <${Slider} label="Preview volume" min=${0} max=${1} step=${0.01} value=${vol.muted ? 0 : Math.min(1, vol.v)} onInput=${(v) => {
          engine.masterVolume = v;
          if (v > 0 && engine.muted) engine.muted = false;
        }} />
      </div>
      <${IconButton} icon="fullscreen" label=${fullscreen ? 'Exit full screen' : 'Full screen preview'} pressed=${fullscreen} tipPos="left" onClick=${toggleFullscreen} />
    </div>
  </div>`;
}

/** Which clip (if any) gets the transform gizmo: exactly one selected visual clip. */
function gizmoClip(state) {
  const doc = state.doc;
  if (!doc) return null;
  let found = null;
  for (const id of state.sel.clips) {
    const c = doc.clips.get(id);
    if (!c) continue;
    const k = c.content.kind;
    if (k === 'video' || k === 'image' || k === 'text') {
      if (found) return null;
      found = c;
    }
  }
  return found;
}

function Gizmo({ frameRef }) {
  const clip = useStore(gizmoClip);
  const locked = useStore((s) => (clip && s.doc ? !!trackById(s.doc, clip.track_id)?.locked : false));
  const name = useStore((s) => (clip && s.doc ? clipLabel(s.doc, clip) : ''));
  const box = useRef(null);
  const guideV = useRef(null);
  const guideH = useRef(null);
  const drag = useRef(null);
  const keyCommit = useRef({ timer: 0, patch: null, id: null });
  const clipId = clip?.id;

  // follow the rendered picture: position the overlay after every engine frame
  useLayoutEffect(() => {
    if (!clipId) return undefined;
    const place = () => {
      const el = box.current;
      const frame = frameRef.current;
      if (!el || !frame) return;
      const q = engine.layoutOf(clipId);
      if (!q) {
        el.style.display = 'none';
        return;
      }
      const s = frame.clientWidth / q.W;
      el.style.display = '';
      el.style.width = `${q.w * s}px`;
      el.style.height = `${q.h * s}px`;
      el.style.transform = `translate(${(q.cx - q.w / 2) * s}px, ${(q.cy - q.h / 2) * s}px) rotate(${q.rotation}deg)`;
    };
    place();
    return engine.onFrame(place);
  }, [clipId]);

  // flush pending keyboard nudges when the selection changes / unmounts
  useEffect(() => () => flushKeys(), [clipId]);

  if (!clip) return null;

  const current = () => {
    const c = store.state.doc?.clips.get(clipId);
    const live = store.state.live;
    const t = { ...(c?.transform || {}) };
    if (live?.ids.has(clipId)) for (const k of ['x', 'y', 'scale', 'rotation']) if (live.patch[k] !== undefined) t[k] = live.patch[k];
    return t;
  };

  const showGuides = (v, h) => {
    if (guideV.current) guideV.current.style.display = v ? '' : 'none';
    if (guideH.current) guideH.current.style.display = h ? '' : 'none';
  };

  const commit = (patch) => {
    const clean = {};
    if (patch.x !== undefined) clean.x = round(clamp(patch.x, -4, 4), 5);
    if (patch.y !== undefined) clean.y = round(clamp(patch.y, -4, 4), 5);
    if (patch.scale !== undefined) clean.scale = round(clamp(patch.scale, 0.01, 20), 4);
    if (patch.rotation !== undefined) clean.rotation = round(patch.rotation, 2);
    // keep the live preview until the server's change lands (applyChange clears it)
    return exec({ type: 'update_clips', clip_ids: [clipId], patch: clean }, { errorTitle: 'Could not transform the clip' }).then((change) => {
      if (!change) setLive(null);
    });
  };

  function flushKeys() {
    const k = keyCommit.current;
    clearTimeout(k.timer);
    if (k.patch && k.id) {
      const patch = k.patch;
      const id = k.id;
      k.patch = null;
      k.id = null;
      if (id === clipId) commit(patch);
      else exec({ type: 'update_clips', clip_ids: [id], patch }, { silent: true });
    }
  }

  const begin = (mode) => (e) => {
    if (e.button !== 0 || locked) return;
    e.preventDefault();
    e.stopPropagation();
    flushKeys();
    const frame = frameRef.current;
    const rect = frame.getBoundingClientRect();
    const q = engine.layoutOf(clipId);
    if (!q) return;
    const s = rect.width / q.W;
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = {
      mode,
      pointerId: e.pointerId,
      sx: e.clientX,
      sy: e.clientY,
      start: current(),
      rect,
      centre: { x: rect.left + q.cx * s, y: rect.top + q.cy * s },
      moved: false,
      patch: null,
    };
    box.current?.classList.add('dragging');
    window.addEventListener('keydown', onDragKey, true);
  };

  const onMove = (e) => {
    const d = drag.current;
    if (!d || e.pointerId !== d.pointerId) return;
    const dx = e.clientX - d.sx;
    const dy = e.clientY - d.sy;
    if (!d.moved && Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
    d.moved = true;
    let patch;
    if (d.mode === 'move') {
      let x = d.start.x + dx / d.rect.width;
      let y = d.start.y + dy / d.rect.height;
      if (e.shiftKey) {
        // constrain to the dominant axis
        if (Math.abs(dx) >= Math.abs(dy)) y = d.start.y;
        else x = d.start.x;
      }
      let gv = false;
      let gh = false;
      if (!e.altKey) {
        if (Math.abs(x * d.rect.width) < SNAP_PX) {
          x = 0;
          gv = true;
        }
        if (Math.abs(y * d.rect.height) < SNAP_PX) {
          y = 0;
          gh = true;
        }
      }
      showGuides(gv, gh);
      patch = { x, y };
    } else if (d.mode === 'scale') {
      const d0 = Math.max(4, Math.hypot(d.sx - d.centre.x, d.sy - d.centre.y));
      const d1 = Math.hypot(e.clientX - d.centre.x, e.clientY - d.centre.y);
      let scale = clamp(d.start.scale * (d1 / d0), 0.01, 20);
      if (!e.altKey && Math.abs(scale - 1) < 0.015) scale = 1;
      patch = { scale };
    } else {
      const a0 = Math.atan2(d.sy - d.centre.y, d.sx - d.centre.x);
      const a1 = Math.atan2(e.clientY - d.centre.y, e.clientX - d.centre.x);
      let rot = d.start.rotation + ((a1 - a0) * 180) / Math.PI;
      if (e.shiftKey) rot = Math.round(rot / 15) * 15;
      else if (!e.altKey) {
        const near = Math.round(rot / 90) * 90;
        if (Math.abs(rot - near) < 2) rot = near;
      }
      rot = ((((rot + 180) % 360) + 360) % 360) - 180;
      patch = { rotation: rot };
    }
    d.patch = patch;
    setLive([clipId], patch);
  };

  const finish = (cancel) => {
    const d = drag.current;
    drag.current = null;
    window.removeEventListener('keydown', onDragKey, true);
    box.current?.classList.remove('dragging');
    showGuides(false, false);
    if (!d) return;
    if (cancel || !d.moved || !d.patch) {
      if (d.moved) setLive(null);
      return;
    }
    commit(d.patch);
  };

  function onDragKey(e) {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      finish(true);
    }
  }

  const onKey = (e) => {
    if (locked) return;
    const t = current();
    const q = engine.layoutOf(clipId);
    const W = q?.W || store.state.doc.settings.width;
    const H = q?.H || store.state.doc.settings.height;
    const step = e.shiftKey ? 10 : 1;
    let patch = null;
    if (e.key === 'ArrowLeft') patch = { x: t.x - step / W };
    else if (e.key === 'ArrowRight') patch = { x: t.x + step / W };
    else if (e.key === 'ArrowUp') patch = { y: t.y - step / H };
    else if (e.key === 'ArrowDown') patch = { y: t.y + step / H };
    else if (e.key === '+' || e.key === '=') patch = { scale: clamp(t.scale * (e.shiftKey && e.key === '=' ? 1.1 : 1.01), 0.01, 20) };
    else if (e.key === '-' || e.key === '_') patch = { scale: clamp(t.scale / 1.01, 0.01, 20) };
    else if (e.key === ']') patch = { rotation: t.rotation + (e.shiftKey ? 15 : 1) };
    else if (e.key === '[') patch = { rotation: t.rotation - (e.shiftKey ? 15 : 1) };
    else if (e.key === 'Escape' && keyCommit.current.patch) {
      clearTimeout(keyCommit.current.timer);
      keyCommit.current.patch = null;
      setLive(null);
      e.preventDefault();
      e.stopPropagation();
      return;
    }
    if (!patch) return;
    // these keys belong to the gizmo while it has focus (not to the transport)
    e.preventDefault();
    e.stopPropagation();
    const k = keyCommit.current;
    k.patch = { ...(k.id === clipId ? k.patch : null), ...patch };
    k.id = clipId;
    setLive([clipId], patch);
    clearTimeout(k.timer);
    k.timer = setTimeout(flushKeys, 450);
  };

  const t = clip.transform;
  const describe = `Transform ${name}. Position ${Math.round(t.x * 100)}% horizontal, ${Math.round(t.y * 100)}% vertical; scale ${Math.round(t.scale * 100)}%; rotation ${Math.round(t.rotation)} degrees. ${
    locked ? 'The track is locked.' : 'Arrow keys move (Shift for 10 pixels), plus and minus scale, square brackets rotate.'
  }`;
  const handle = (pos) => html`<span class=${cx('gz-handle', pos)} onPointerDown=${begin('scale')} onPointerMove=${onMove} onPointerUp=${() => finish(false)} onPointerCancel=${() => finish(true)} aria-hidden="true"></span>`;
  return html`
    <div class="gz-guide v" ref=${guideV} style="display:none" aria-hidden="true"></div>
    <div class="gz-guide h" ref=${guideH} style="display:none" aria-hidden="true"></div>
    <div
      ref=${box}
      class=${cx('gizmo', locked && 'locked')}
      tabindex="0"
      role="group"
      aria-label=${describe}
      aria-keyshortcuts="ArrowLeft ArrowRight ArrowUp ArrowDown + - [ ]"
      data-testid="gizmo"
      onPointerDown=${begin('move')}
      onPointerMove=${onMove}
      onPointerUp=${() => finish(false)}
      onPointerCancel=${() => finish(true)}
      onKeyDown=${onKey}
      onBlur=${() => flushKeys()}
    >
      ${!locked &&
      html`${handle('nw')}${handle('ne')}${handle('sw')}${handle('se')}
        <span class="gz-stem" aria-hidden="true"></span>
        <span class="gz-rotate" data-testid="gizmo-rotate" onPointerDown=${begin('rotate')} onPointerMove=${onMove} onPointerUp=${() => finish(false)} onPointerCancel=${() => finish(true)} aria-hidden="true"></span>`}
    </div>
  `;
}

function StatusOverlay({ hasMedia }) {
  const status = useEmitter(engine, () => engine.status);
  const [showBuffering, setShowBuffering] = useState(false);
  // a short delay keeps the spinner from flickering on quick seeks
  useEffect(() => {
    if (status.state !== 'buffering') {
      setShowBuffering(false);
      return undefined;
    }
    const id = setTimeout(() => setShowBuffering(true), 250);
    return () => clearTimeout(id);
  }, [status.state]);

  if (status.state === 'empty')
    return html`<div class="monitor-overlay" data-testid="monitor-empty">
      <${EmptyState} icon="film" title="Nothing to preview yet">
        ${hasMedia ? 'Drag a clip from the media bin onto the timeline, or double-click it to add it at the end.' : 'Import media in the panel on the left, then drag it onto the timeline.'} Press <kbd class="kbd">Space</kbd> to play.
      <//>
    </div>`;
  if (status.state === 'preparing')
    return html`<div class="monitor-overlay" data-testid="monitor-preparing">
      <div class="monitor-card" role="status" aria-live="polite">
        <div class="row"><${Spinner} label="Preparing preview" /><strong>${status.message}</strong></div>
        <${Progress} value=${status.progress} label="Preview preparation" />
        <p class="muted">You can keep editing — the picture appears as soon as the preview file is ready.</p>
      </div>
    </div>`;
  if (status.state === 'error')
    return html`<div class="monitor-overlay" data-testid="monitor-error">
      <div class="monitor-card error" role="alert">
        <div class="row"><${Icon} name="alert" /><strong>Preview unavailable</strong></div>
        <p>${status.message}</p>
      </div>
    </div>`;
  if (status.state === 'buffering' && showBuffering)
    return html`<div class="monitor-buffering" role="status" aria-live="polite" data-testid="monitor-buffering"><${Spinner} label="Buffering" /><span>Buffering…</span></div>`;
  return null;
}

export function Monitor() {
  const settings = useStore((s) => s.doc?.settings);
  const duration = useStore((s) => s.duration);
  const hasMedia = useStore((s) => (s.doc ? s.doc.assets.size > 0 : false));
  const stage = useRef(null);
  const frame = useRef(null);
  const canvas = useRef(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const W = settings?.width || 1920;
  const H = settings?.height || 1080;
  const fps = settings?.fps || { num: 30, den: 1 };

  // letterbox the project frame inside the available stage
  useLayoutEffect(() => {
    const el = stage.current;
    if (!el) return undefined;
    const fit = () => {
      const aw = Math.max(32, el.clientWidth - 2 * STAGE_PADDING);
      const ah = Math.max(32, el.clientHeight - 2 * STAGE_PADDING);
      const k = Math.min(aw / W, ah / H);
      const w = Math.max(16, Math.floor(W * k));
      const h = Math.max(16, Math.floor(H * k));
      setSize((prev) => (prev.w === w && prev.h === h ? prev : { w, h }));
    };
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(el);
    return () => ro.disconnect();
  }, [W, H]);

  useEffect(() => {
    try {
      engine.attach(canvas.current);
    } catch (e) {
      console.error('[cutline] preview could not start:', e);
    }
    return () => engine.detach();
  }, []);

  // keep the accessible description current without re-rendering at 60 fps
  useEffect(() => {
    const describe = () => {
      const el = canvas.current;
      if (!el) return;
      const label = transport.playing ? 'Preview, playing' : `Preview, paused at ${timecode(transport.time, fps)}`;
      if (el.getAttribute('aria-label') !== label) el.setAttribute('aria-label', label);
    };
    describe();
    return transport.subscribe(describe);
  }, [fps.num, fps.den]);

  // click the picture to select the clip under the pointer (and start moving it)
  const onPointerDown = (e) => {
    if (e.button !== 0 || !frame.current) return;
    const rect = frame.current.getBoundingClientRect();
    const id = engine.hitTest((e.clientX - rect.left) / rect.width, (e.clientY - rect.top) / rect.height);
    if (!id) {
      clearSelection();
      return;
    }
    const sel = store.state.sel.clips;
    if (!sel.has(id)) selectClips([id], { mode: e.shiftKey ? 'add' : 'replace' });
  };

  return html`<div class="monitor" data-testid="monitor">
    <div class="monitor-stage" ref=${stage}>
      <div class="monitor-frame" ref=${frame} style=${{ width: `${size.w}px`, height: `${size.h}px` }} onPointerDown=${onPointerDown}>
        <canvas ref=${canvas} class="monitor-canvas" role="img" aria-label="Preview" data-testid="monitor-canvas"></canvas>
        <${Gizmo} frameRef=${frame} />
      </div>
      <${StatusOverlay} hasMedia=${hasMedia} />
    </div>
    <${TransportBar} fps=${fps} duration=${duration} stageRef=${stage} />
  </div>`;
}
