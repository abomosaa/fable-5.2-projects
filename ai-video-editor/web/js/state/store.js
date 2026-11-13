// Central application store.
//
// A tiny immutable store: `store.set(patch)` shallow-merges into `store.state` and
// notifies subscribers. Components read slices with `useStore(selector)` (lib/ui.js).
//
// The project document (`state.doc`) is a read-only mirror of the server's document.
// It only changes by applying server-produced `Change`s (state/actions.js) — the UI
// never edits it directly, so there is exactly one timeline representation.
//
// State shape
// -----------
//   route        { name: 'home' } | { name: 'editor', projectId }
//   health       /api/health payload or null         (health.fixture → show FIXTURE badge)
//   online       false while the event stream is disconnected
//   projects     { list: ProjectMeta[], broken: [], loading, error }
//   loading      true while a project is being opened;   loadError: string|null
//   doc          null | {
//                  id, name, revision, settings{width,height,fps{num,den},sample_rate,background,caption_style},
//                  tracks: Track[]            (display order, top → bottom)
//                  clips: Map<id, Clip>       (replaced on every change — safe to memo on identity)
//                  assets: Map<id, AssetInfo> (immutable media facts: kind,duration,width,height,…)
//                  transitions: Map<id, Transition>, markers: Marker[],
//                  transcript: { enabled, corrections{asset→{wordIndex→text}}, speaker_names{asset→{speaker→name}}, removals[] }
//                }
//   layers       Map<clipId, Layer>   resolved playback behaviour (extent incl. transition handles,
//                                     fade/slide ramps, gain, active) — the preview renders from these
//   duration     timeline length in ticks
//   history      { can_undo, can_redo, undo_label, redo_label }
//   assets       Map<assetId, AssetRecord>  processing/transcription status records (state, progress,
//                                     proxy/audio/thumbs/waveform flags, transcription{state,…}, error)
//   uploads      [{ id, name, size, progress, error, abort }]   in-flight browser uploads
//   exports      RenderJob[] (newest first)
//   sel          { clips: Set<clipId>, transition: id|null, marker: id|null }
//   live         null | { ids: Set<clipId>, patch: ClipPatch }   un-committed property preview (slider drag)
//   view         { pxPerSec, scrollX, scrollY, snapping, linked }   timeline viewport + edit toggles
//   ui           { leftTab, rightTab, leftW, rightW, timelineH, dialog: null|'export'|'shortcuts'|'settings', … }
//   transcript   { view: TranscriptView|null, revision, loading, error }
//   save         { state: 'saved'|'saving'|'error', at }
//   toasts       []
//
// Time: every time value is integer ticks (see lib/time.js). The playhead is NOT in
// the store (it changes every frame); use `transport` from player/transport.js.

import { clipEnd } from '../lib/time.js';

const listeners = new Set();
let notifying = false;
let dirty = false;

const UI_KEY = 'cutline:ui';
function loadUi() {
  try {
    return JSON.parse(localStorage.getItem(UI_KEY) || '{}');
  } catch {
    return {};
  }
}

export const initialEditorState = () => ({
  loading: false,
  loadError: null,
  doc: null,
  layers: new Map(),
  duration: 0,
  history: { can_undo: false, can_redo: false },
  assets: new Map(),
  uploads: [],
  exports: [],
  sel: { clips: new Set(), transition: null, marker: null },
  live: null,
  view: { pxPerSec: 80, scrollX: 0, scrollY: 0, snapping: true, linked: true },
  transcript: { view: null, revision: -1, loading: false, error: null },
  save: { state: 'saved', at: 0 },
});

export const store = {
  state: {
    route: { name: 'home' },
    health: null,
    online: true,
    projects: { list: [], broken: [], loading: true, error: null },
    ui: { leftTab: 'media', rightTab: 'inspector', leftW: 300, rightW: 340, timelineH: 320, dialog: null, ...loadUi() },
    toasts: [],
    ...initialEditorState(),
  },
  /** Shallow-merge a patch (object or updater function) and notify. */
  set(patch) {
    const p = typeof patch === 'function' ? patch(store.state) : patch;
    if (!p) return;
    store.state = { ...store.state, ...p };
    if (notifying) {
      dirty = true;
      return;
    }
    notifying = true;
    try {
      do {
        dirty = false;
        for (const fn of [...listeners]) fn(store.state);
      } while (dirty);
    } finally {
      notifying = false;
    }
  },
  subscribe(fn) {
    listeners.add(fn);
    return () => listeners.delete(fn);
  },
  get: () => store.state,
};

/** Merge into state.ui and persist layout preferences. */
export function setUi(patch) {
  const ui = { ...store.state.ui, ...patch };
  store.set({ ui });
  const { leftTab, rightTab, leftW, rightW, timelineH } = ui;
  try {
    localStorage.setItem(UI_KEY, JSON.stringify({ leftTab, rightTab, leftW, rightW, timelineH }));
  } catch {
    /* storage unavailable: preferences just don't persist */
  }
}

export function setView(patch) {
  store.set((s) => ({ view: { ...s.view, ...patch } }));
}

// ---------------------------------------------------------------------------------
// Derived data (memoised on the identity of the clips Map / tracks array)
// ---------------------------------------------------------------------------------
const byTrackCache = new WeakMap();
/** Map<trackId, Clip[]> sorted by start. */
export function clipsByTrack(doc) {
  if (!doc) return new Map();
  let hit = byTrackCache.get(doc.clips);
  if (hit) return hit;
  hit = new Map();
  for (const t of doc.tracks) hit.set(t.id, []);
  for (const c of doc.clips.values()) {
    let arr = hit.get(c.track_id);
    if (!arr) hit.set(c.track_id, (arr = []));
    arr.push(c);
  }
  for (const arr of hit.values()) arr.sort((a, b) => a.start - b.start || (a.id < b.id ? -1 : 1));
  byTrackCache.set(doc.clips, hit);
  return hit;
}

/** Clips of a track intersecting [t0, t1) (binary search on the sorted list). */
export function clipsInRange(doc, trackId, t0, t1) {
  const arr = clipsByTrack(doc).get(trackId) || [];
  let lo = 0;
  let hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (clipEnd(arr[mid]) <= t0) lo = mid + 1;
    else hi = mid;
  }
  const out = [];
  for (let i = lo; i < arr.length && arr[i].start < t1; i++) out.push(arr[i]);
  return out;
}

const linkCache = new WeakMap();
/** Map<linkId, Clip[]> and Map<groupId, Clip[]>. */
export function linkGroups(doc) {
  let hit = linkCache.get(doc.clips);
  if (hit) return hit;
  const links = new Map();
  const groups = new Map();
  for (const c of doc.clips.values()) {
    if (c.link_id) (links.get(c.link_id) || links.set(c.link_id, []).get(c.link_id)).push(c);
    if (c.group_id) (groups.get(c.group_id) || groups.set(c.group_id, []).get(c.group_id)).push(c);
  }
  hit = { links, groups };
  linkCache.set(doc.clips, hit);
  return hit;
}

export const trackById = (doc, id) => doc.tracks.find((t) => t.id === id);
/** Tracks of a kind ordered from the V/A divider outwards (V1, V2… / A1, A2…). */
export function tracksOfKind(doc, kind) {
  const v = doc.tracks.filter((t) => t.kind === kind);
  return kind === 'audio' ? v : v.reverse();
}
export const trackKindOfClip = (clip) => (clip.content.kind === 'audio' ? 'audio' : clip.content.kind === 'caption' ? 'caption' : 'video');

/** Display name of a clip. */
export function clipLabel(doc, clip) {
  const c = clip.content;
  if (c.kind === 'text' || c.kind === 'caption') return c.text.replace(/\s+/g, ' ').trim() || (c.kind === 'text' ? 'Text' : 'Caption');
  return doc.assets.get(c.asset_id)?.name || 'Missing media';
}

/** Is the audio of this track part of the output (mute / solo)? */
export function trackActive(doc, track) {
  if (track.kind === 'audio') {
    const anySolo = doc.tracks.some((t) => t.kind === 'audio' && t.solo);
    return !track.muted && (!anySolo || track.solo);
  }
  return !track.hidden;
}

// ---------------------------------------------------------------------------------
// Live (un-committed) property preview
// ---------------------------------------------------------------------------------
const TRANSFORM = { x: 'x', y: 'y', scale: 'scale', rotation: 'rotation', opacity: 'opacity', flip_h: 'flip_h', flip_v: 'flip_v' };
const CROP = { crop_left: 'left', crop_top: 'top', crop_right: 'right', crop_bottom: 'bottom' };
const COLOR = ['brightness', 'contrast', 'saturation', 'temperature'];
const STYLE = { font_size: 'font_size', text_color: 'color', bold: 'bold', align: 'align', background: 'background', outline_color: 'outline_color', outline_width: 'outline_width', shadow: 'shadow' };

/** Apply a ClipPatch (same flat fields as the UpdateClips command) to a clip copy. */
export function applyClipPatch(clip, patch) {
  const out = { ...clip, transform: { ...clip.transform, crop: { ...clip.transform.crop } }, color: { ...clip.color }, content: { ...clip.content } };
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) continue;
    if (k in TRANSFORM) out.transform[TRANSFORM[k]] = v;
    else if (k in CROP) out.transform.crop[CROP[k]] = v;
    else if (COLOR.includes(k)) out.color[k] = v;
    else if (k === 'gain_db' || k === 'fade_in' || k === 'fade_out' || k === 'enabled') out[k] = v;
    else if (k === 'text') out.content.text = v;
    else if (k in STYLE && out.content.kind === 'text') out.content.style = { ...out.content.style, [STYLE[k]]: v };
  }
  return out;
}

/** The clip as it should currently be *shown* (with any live preview applied). */
export function liveClip(state, clip) {
  const live = state.live;
  return live && live.ids.has(clip.id) ? applyClipPatch(clip, live.patch) : clip;
}

/** Start/extend/clear a live preview. Pass null to clear. */
export function setLive(ids, patch) {
  if (!ids) return store.set({ live: null });
  const prev = store.state.live;
  store.set({ live: { ids: ids instanceof Set ? ids : new Set(ids), patch: { ...(prev?.patch || {}), ...patch } } });
}
