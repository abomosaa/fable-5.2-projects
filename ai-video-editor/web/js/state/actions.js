// Actions: everything that talks to the server or changes editor state.
//
// Every edit is a typed command sent to the server together with the revision it
// was made against (`exec`). The server validates and applies it atomically and
// answers with a `Change` (document patch + re-resolved layers + history state)
// which is merged into the store. Commands are queued so they are applied strictly
// in order.

import { api, ApiError, CLIENT_ID, connectEvents, uploadFile } from '../lib/api.js';
import { toast } from '../lib/ui.js';
import { clipEnd, frameTicks, secondsToTicks, snapToFrame } from '../lib/time.js';
import { clipsByTrack, initialEditorState, linkGroups, setView, store, trackKindOfClip } from './store.js';
import { transport } from '../player/transport.js';

// ---------------------------------------------------------------------------------
// routing & project list
// ---------------------------------------------------------------------------------
export function navigate(route) {
  const hash = route.name === 'editor' ? `#/p/${route.projectId}` : '#/';
  if (location.hash !== hash) location.hash = hash;
  else applyRoute();
}

let routed = false;
export function applyRoute() {
  const m = location.hash.match(/^#\/p\/([\w-]+)/);
  const route = m ? { name: 'editor', projectId: m[1] } : { name: 'home' };
  const prev = store.state.route;
  if (routed && prev.name === route.name && prev.projectId === route.projectId && (route.name === 'home' || store.state.doc || store.state.loading)) return;
  routed = true;
  store.set({ route });
  if (route.name === 'editor') openProject(route.projectId);
  else {
    closeProject();
    refreshProjects();
  }
}

export async function loadHealth() {
  try {
    store.set({ health: await api.health() });
  } catch (e) {
    store.set({ online: false });
  }
}

export async function refreshProjects() {
  store.set((s) => ({ projects: { ...s.projects, loading: true, error: null } }));
  try {
    const { projects, broken } = await api.listProjects();
    store.set({ projects: { list: projects, broken: broken || [], loading: false, error: null } });
  } catch (e) {
    store.set((s) => ({ projects: { ...s.projects, loading: false, error: e.message } }));
  }
}

export async function createProject(name) {
  const { project } = await api.createProject(name);
  navigate({ name: 'editor', projectId: project.id });
  return project;
}

export async function duplicateProject(id) {
  const { project } = await api.duplicateProject(id);
  await refreshProjects();
  toast({ kind: 'success', title: `Created “${project.name}”` });
  return project;
}

export async function deleteProject(id) {
  await api.deleteProject(id);
  await refreshProjects();
}

export async function renameProject(id, name) {
  const { project } = await api.renameProject(id, name);
  if (store.state.doc?.id === id) store.set((s) => ({ doc: { ...s.doc, name: project.name } }));
  else await refreshProjects();
}

// ---------------------------------------------------------------------------------
// opening / closing a project
// ---------------------------------------------------------------------------------
let disconnect = null;
let openSeq = 0;

function toDoc(project) {
  return {
    ...project,
    clips: new Map(Object.entries(project.clips)),
    assets: new Map(Object.entries(project.assets)),
    transitions: new Map(Object.entries(project.transitions || {})),
  };
}

function viewKey(id) {
  return `cutline:view:${id}`;
}

function loadPayload(payload, { keepView = false } = {}) {
  const doc = toDoc(payload.project);
  const prev = store.state;
  const stillThere = (id) => doc.clips.has(id);
  store.set({
    loading: false,
    loadError: null,
    doc,
    layers: new Map(payload.layers.map((l) => [l.clip_id, l])),
    duration: payload.duration,
    history: payload.history,
    assets: new Map(payload.assets.map((a) => [a.id, a])),
    exports: payload.exports || [],
    sel: keepView ? { clips: new Set([...prev.sel.clips].filter(stillThere)), transition: null, marker: null } : { clips: new Set(), transition: null, marker: null },
    live: null,
    save: { state: 'saved', at: Date.now() },
  });
}

export async function openProject(id) {
  const seq = ++openSeq;
  closeProject({ keepRoute: true });
  store.set({ loading: true, loadError: null });
  try {
    const payload = await api.getProject(id);
    if (seq !== openSeq) return;
    loadPayload(payload);
    // restore the per-project viewport
    let saved = {};
    try {
      saved = JSON.parse(localStorage.getItem(viewKey(id)) || '{}');
    } catch {
      /* ignore */
    }
    setView({ pxPerSec: saved.pxPerSec || 0, scrollX: saved.scrollX || 0, scrollY: 0, snapping: saved.snapping ?? true, linked: saved.linked ?? true });
    transport.reset(Math.min(saved.playhead || 0, payload.duration));
    document.title = `${payload.project.name} — Cutline`;
    disconnect = connectEvents(id, onServerEvent, (online) => store.set({ online }));
    if (payload.project.transcript.enabled) refreshTranscript();
  } catch (e) {
    if (seq !== openSeq) return;
    store.set({ loading: false, loadError: e.status === 404 ? 'This project does not exist any more. It may have been deleted.' : e.message });
  }
}

export function closeProject({ keepRoute = false } = {}) {
  persistView();
  disconnect?.();
  disconnect = null;
  transport.reset(0);
  for (const u of store.state.uploads) u.abort?.();
  store.set({ ...initialEditorState() });
  if (!keepRoute) document.title = 'Cutline';
}

let viewTimer = 0;
/** Remember playhead / zoom / toggles per project (restored on reopen). */
export function persistView() {
  const { doc, view } = store.state;
  if (!doc) return;
  try {
    localStorage.setItem(viewKey(doc.id), JSON.stringify({ playhead: transport.frameTime, pxPerSec: view.pxPerSec, scrollX: view.scrollX, snapping: view.snapping, linked: view.linked }));
  } catch {
    /* ignore */
  }
}
export function persistViewSoon() {
  clearTimeout(viewTimer);
  viewTimer = setTimeout(persistView, 400);
}
window.addEventListener('pagehide', persistView);

async function resync() {
  const id = store.state.doc?.id;
  if (!id) return;
  try {
    const payload = await api.getProject(id);
    if (store.state.doc?.id !== id) return;
    loadPayload(payload, { keepView: true });
    refreshTranscript();
  } catch (e) {
    if (e.status === 404) {
      toast({ kind: 'error', title: 'This project was deleted' });
      navigate({ name: 'home' });
    }
  }
}

// ---------------------------------------------------------------------------------
// applying server changes
// ---------------------------------------------------------------------------------
function applyDocPatch(doc, patch) {
  const next = { ...doc };
  if (patch.name != null) next.name = patch.name;
  if (patch.settings) next.settings = patch.settings;
  if (patch.tracks) next.tracks = patch.tracks;
  if (patch.assets_upsert?.length || patch.assets_remove?.length) {
    next.assets = new Map(doc.assets);
    for (const id of patch.assets_remove || []) next.assets.delete(id);
    for (const a of patch.assets_upsert || []) next.assets.set(a.id, a);
  }
  if (patch.clips_upsert?.length || patch.clips_remove?.length) {
    next.clips = new Map(doc.clips);
    for (const id of patch.clips_remove || []) next.clips.delete(id);
    for (const c of patch.clips_upsert || []) next.clips.set(c.id, c);
  }
  if (patch.transitions) next.transitions = new Map(Object.entries(patch.transitions));
  if (patch.markers) next.markers = patch.markers;
  if (patch.transcript) next.transcript = patch.transcript;
  return next;
}

/** Merge a server `Change` into the store. Returns false when it could not be applied in order. */
function applyChange(change) {
  const s = store.state;
  if (!s.doc) return false;
  if (change.revision <= s.doc.revision) return true; // already have it
  if (change.revision !== s.doc.revision + 1) return false; // missed something
  const doc = applyDocPatch(s.doc, change.patch);
  doc.revision = change.revision;
  const layers = new Map(s.layers);
  for (const id of change.patch.clips_remove || []) layers.delete(id);
  for (const l of change.layers_upsert || []) layers.set(l.clip_id, l);
  const clips = new Set([...s.sel.clips].filter((id) => doc.clips.has(id)));
  const sel = {
    clips,
    transition: s.sel.transition && doc.transitions.has(s.sel.transition) ? s.sel.transition : null,
    marker: s.sel.marker && doc.markers.some((m) => m.id === s.sel.marker) ? s.sel.marker : null,
  };
  store.set({ doc, layers, duration: change.duration, history: change.history, sel, live: null });
  if (transport.time > change.duration) transport.seek(change.duration);
  refreshTranscriptSoon();
  return true;
}

function onServerEvent(kind, data) {
  const s = store.state;
  if (!s.doc) return;
  switch (kind) {
    case 'change':
      if (data.origin === CLIENT_ID) return; // our own edit, already applied from the HTTP response
      if (!applyChange(data.change)) resync();
      break;
    case 'asset_added':
      store.set((st) => (st.doc ? { doc: applyDocPatch(st.doc, data.patch) } : null));
      break;
    case 'asset': {
      if (!data.projects?.includes(s.doc.id)) return;
      const before = s.assets.get(data.id);
      const assets = new Map(s.assets);
      assets.set(data.id, data);
      store.set({ assets });
      const was = before?.transcription?.state;
      const now = data.transcription?.state;
      if (now !== was && now === 'completed') refreshTranscript();
      if (data.state === 'failed' && before && before.state !== 'failed') toast({ kind: 'error', title: `“${data.name}” could not be imported`, detail: data.error });
      break;
    }
    case 'render': {
      if (data.deleted) {
        store.set((st) => ({ exports: st.exports.filter((j) => j.id !== data.id) }));
        return;
      }
      if (data.project_id !== s.doc.id) return;
      store.set((st) => {
        const i = st.exports.findIndex((j) => j.id === data.id);
        const exports = i >= 0 ? st.exports.map((j) => (j.id === data.id ? data : j)) : [data, ...st.exports];
        return { exports };
      });
      break;
    }
    case 'project':
      if (data.deleted === s.doc.id) {
        toast({ kind: 'warning', title: 'This project was deleted in another window' });
        navigate({ name: 'home' });
      } else if (data.renamed?.id === s.doc.id) {
        store.set((st) => ({ doc: { ...st.doc, name: data.renamed.name } }));
        document.title = `${data.renamed.name} — Cutline`;
      }
      break;
    case 'resync':
      resync();
      break;
  }
}

// ---------------------------------------------------------------------------------
// command execution
// ---------------------------------------------------------------------------------
let chain = Promise.resolve();
const setSave = (state) => store.set({ save: { state, at: Date.now() } });

async function runOnServer(call, { silent, errorTitle = 'That edit could not be applied' } = {}) {
  const doc = store.state.doc;
  if (!doc) return null;
  setSave('saving');
  try {
    const { change } = await call(doc.id, doc.revision);
    if (store.state.doc?.id !== doc.id) return null;
    if (!applyChange(change)) await resync();
    setSave('saved');
    store.set({ announce: change.label });
    for (const n of change.notices || []) toast({ kind: 'warning', title: n });
    return change;
  } catch (e) {
    if (!(e instanceof ApiError)) {
      console.error(e);
      setSave('saved');
      return null;
    }
    if (e.code === 'stale_revision') {
      await resync();
      setSave('saved');
      toast({ kind: 'warning', title: 'The project changed elsewhere', detail: 'It was reloaded to the latest version. Please repeat your last edit.' });
      return null;
    }
    if (e.code === 'nothing_to_do') {
      setSave('saved');
      return null;
    }
    const serverSide = e.status === 0 || e.status >= 500;
    setSave(serverSide ? 'error' : 'saved');
    if (!silent) toast({ kind: 'error', title: serverSide ? 'Could not save your edit' : errorTitle, detail: e.message });
    if (serverSide && e.status !== 0) resync();
    return null;
  }
}

/**
 * Execute an editing command. Resolves with the applied `Change`, or null when it
 * was rejected (an explanatory toast is shown unless `silent`).
 * @param {object} command  a core Command, e.g. { type: 'split_clips', at: 123 }
 * @param {{silent?: boolean, errorTitle?: string, select?: 'created'}} [opts]
 */
export function exec(command, opts = {}) {
  const run = async () => {
    const change = await runOnServer((id, rev) => api.command(id, rev, command), opts);
    if (change && opts.select === 'created' && change.created?.length) selectClips(change.created, { mode: 'replace', linked: false });
    return change;
  };
  chain = chain.then(run, run);
  return chain;
}

export function undo() {
  if (!store.state.history.can_undo) return Promise.resolve(null);
  const run = () => runOnServer((id, rev) => api.undo(id, rev), { errorTitle: 'Could not undo' });
  chain = chain.then(run, run);
  return chain;
}

export function redo() {
  if (!store.state.history.can_redo) return Promise.resolve(null);
  const run = () => runOnServer((id, rev) => api.redo(id, rev), { errorTitle: 'Could not redo' });
  chain = chain.then(run, run);
  return chain;
}

// ---------------------------------------------------------------------------------
// selection
// ---------------------------------------------------------------------------------
/**
 * Expand clip ids with their group members (always) and A/V-linked partners
 * (when linked selection is on, like the chain button in DaVinci Resolve).
 */
export function expandSelection(ids, { linked = store.state.view.linked } = {}) {
  const doc = store.state.doc;
  const out = new Set();
  if (!doc) return out;
  const { links, groups } = linkGroups(doc);
  const visit = (id) => {
    if (out.has(id)) return;
    const c = doc.clips.get(id);
    if (!c) return;
    out.add(id);
    if (c.group_id) for (const o of groups.get(c.group_id) || []) visit(o.id);
    if (linked && c.link_id) for (const o of links.get(c.link_id) || []) visit(o.id);
  };
  for (const id of ids) visit(id);
  return out;
}

/** @param {{mode?: 'replace'|'add'|'toggle', linked?: boolean}} [opts] */
export function selectClips(ids, { mode = 'replace', linked } = {}) {
  const expanded = expandSelection(ids, { linked });
  const cur = store.state.sel.clips;
  let next;
  if (mode === 'replace') next = expanded;
  else if (mode === 'add') next = new Set([...cur, ...expanded]);
  else {
    next = new Set(cur);
    const allIn = [...expanded].every((id) => cur.has(id));
    for (const id of expanded) allIn ? next.delete(id) : next.add(id);
  }
  store.set({ sel: { clips: next, transition: null, marker: null } });
}

export function clearSelection() {
  const s = store.state.sel;
  if (s.clips.size || s.transition || s.marker) store.set({ sel: { clips: new Set(), transition: null, marker: null } });
}

export function selectTransition(id) {
  store.set({ sel: { clips: new Set(), transition: id, marker: null } });
}

export function selectMarker(id) {
  store.set({ sel: { clips: new Set(), transition: null, marker: id } });
}

export function selectAll() {
  const doc = store.state.doc;
  if (doc) store.set({ sel: { clips: new Set(doc.clips.keys()), transition: null, marker: null } });
}

export const selectedClips = () => {
  const { doc, sel } = store.state;
  return doc ? [...sel.clips].map((id) => doc.clips.get(id)).filter(Boolean) : [];
};

// ---------------------------------------------------------------------------------
// editing shortcuts (thin wrappers that build commands)
// ---------------------------------------------------------------------------------
const fps = () => store.state.doc.settings.fps;
const ids = () => [...store.state.sel.clips];

export function splitAtPlayhead() {
  const doc = store.state.doc;
  if (!doc) return;
  const t = transport.frameTime;
  const under = selectedClips().filter((c) => c.start < t && clipEnd(c) > t);
  // With a selection under the playhead only those clips are cut; otherwise every track is.
  return exec({ type: 'split_clips', at: t, clip_ids: under.length ? under.map((c) => c.id) : null }, { errorTitle: 'Nothing to split here' });
}

export function deleteSelection({ ripple = false } = {}) {
  const { sel } = store.state;
  if (sel.transition) return exec({ type: 'remove_transitions', transition_ids: [sel.transition] });
  if (sel.marker) return exec({ type: 'remove_marker', marker_id: sel.marker });
  if (!sel.clips.size) return;
  return exec({ type: 'delete_clips', clip_ids: ids(), ripple });
}

export function duplicateSelection() {
  if (!store.state.sel.clips.size) return;
  return exec({ type: 'duplicate_clips', clip_ids: ids() }, { select: 'created' });
}

/** Move the selection by whole frames. */
export function nudgeSelection(frames) {
  const clips = selectedClips();
  if (!clips.length) return;
  const d = frames * frameTicks(fps());
  const min = Math.min(...clips.map((c) => c.start));
  const delta = Math.max(d, -min);
  if (!delta) return;
  return exec({ type: 'move_clips', moves: clips.map((c) => ({ clip_id: c.id, start: c.start + delta, track_id: c.track_id })) }, { silent: true });
}

/** Trim the start or end of the selected clips (or the clips under the playhead) to the playhead. */
export function trimToPlayhead(edge, { ripple = false } = {}) {
  const doc = store.state.doc;
  if (!doc) return;
  const t = transport.frameTime;
  let clips = selectedClips().filter((c) => c.start < t && clipEnd(c) > t);
  if (!clips.length) clips = [...doc.clips.values()].filter((c) => c.start < t && clipEnd(c) > t && !doc.tracks.find((tr) => tr.id === c.track_id)?.locked);
  if (!clips.length) return toast({ title: 'Move the playhead inside a clip to trim it' });
  const ref = clips[0];
  const delta = edge === 'start' ? t - ref.start : t - clipEnd(ref);
  const same = clips.filter((c) => (edge === 'start' ? c.start === ref.start : clipEnd(c) === clipEnd(ref)));
  return exec({ type: 'trim_clips', clip_ids: same.map((c) => c.id), edge, delta, ripple });
}

export function setSpeed(speed, { ripple = true } = {}) {
  const clips = selectedClips().filter((c) => c.content.kind === 'video' || c.content.kind === 'audio');
  if (!clips.length) return;
  return exec({ type: 'set_speed', clip_ids: clips.map((c) => c.id), speed, ripple });
}

/** Add a transition on the cut next to each selected clip (after it, or before it when it is the last one). */
export function addTransition(kind = 'cross_dissolve', seconds = 1) {
  const doc = store.state.doc;
  const byTrack = clipsByTrack(doc);
  const lefts = new Set();
  for (const c of selectedClips()) {
    if (c.content.kind === 'caption') continue;
    const arr = byTrack.get(c.track_id) || [];
    const i = arr.indexOf(c);
    const next = arr[i + 1];
    const prev = arr[i - 1];
    if (next && next.start === clipEnd(c)) lefts.add(c.id);
    else if (prev && clipEnd(prev) === c.start) lefts.add(prev.id);
  }
  if (!lefts.size) return toast({ title: 'Select a clip that touches another clip', detail: 'Transitions sit on the cut between two adjacent clips.' });
  return exec({ type: 'add_transitions', left_clip_ids: [...lefts], kind, duration: secondsToTicks(seconds) }, { errorTitle: 'Could not add the transition' });
}

export function linkSelection() {
  return exec({ type: 'link_clips', clip_ids: ids() });
}
export function unlinkSelection() {
  return exec({ type: 'unlink_clips', clip_ids: ids() });
}
export function groupSelection() {
  return exec({ type: 'group_clips', clip_ids: ids() });
}
export function ungroupSelection() {
  return exec({ type: 'ungroup_clips', clip_ids: ids() });
}
export function toggleEnabled() {
  const clips = selectedClips();
  if (!clips.length) return;
  return exec({ type: 'update_clips', clip_ids: clips.map((c) => c.id), patch: { enabled: !clips.every((c) => c.enabled) } });
}

export function addTextAtPlayhead(text = 'Your text') {
  return exec({ type: 'add_text', text, start: transport.frameTime }, { select: 'created' });
}

export function addMarkerAtPlayhead() {
  return exec({ type: 'add_marker', time: transport.frameTime, label: '' });
}

/** Place an asset on the timeline. Without `start` it is appended after the last clip. */
export function addAssetToTimeline(assetId, { start = null, trackId = null, mode = 'overwrite' } = {}) {
  return exec({ type: 'add_asset_clips', asset_id: assetId, start, track_id: trackId, mode }, { select: 'created', errorTitle: 'Could not add the clip' });
}

// ---- clipboard (per tab) --------------------------------------------------------
let clipboard = null;

function draftsOf(clips) {
  const min = Math.min(...clips.map((c) => c.start));
  return clips.map((c) => ({
    track_id: c.track_id,
    offset: c.start - min,
    duration: c.duration,
    source_in: c.source_in,
    speed: c.speed,
    content: c.content,
    enabled: c.enabled,
    transform: c.transform,
    color: c.color,
    gain_db: c.gain_db,
    fade_in: c.fade_in,
    fade_out: c.fade_out,
    link_key: c.link_id,
    group_key: c.group_id,
  }));
}

export function copySelection() {
  const clips = selectedClips();
  if (!clips.length) return false;
  clipboard = { projectId: store.state.doc.id, drafts: draftsOf(clips) };
  toast({ title: clips.length === 1 ? 'Clip copied' : `${clips.length} clips copied`, timeout: 1800 });
  return true;
}

export async function cutSelection() {
  if (copySelection()) await deleteSelection({ ripple: false });
}

export function canPaste() {
  return !!clipboard && clipboard.projectId === store.state.doc?.id;
}

export function paste({ at = transport.frameTime, mode = 'overwrite' } = {}) {
  if (!canPaste()) return toast({ title: 'Nothing to paste', detail: 'Copy a clip in this project first.' });
  const doc = store.state.doc;
  const usable = clipboard.drafts.filter((d) => doc.tracks.some((t) => t.id === d.track_id) && (!d.content.asset_id || doc.assets.has(d.content.asset_id)));
  if (!usable.length) return toast({ kind: 'warning', title: 'The copied clips can no longer be pasted', detail: 'Their tracks or media were removed.' });
  return exec({ type: 'insert_clips', clips: usable, at: snapToFrame(at, fps()), mode }, { select: 'created', errorTitle: 'Could not paste' });
}

// ---- playhead navigation ----------------------------------------------------------
/** All edit points (clip starts/ends, markers), sorted and unique. */
export function editPoints() {
  const doc = store.state.doc;
  if (!doc) return [];
  const pts = new Set([0]);
  for (const c of doc.clips.values()) {
    pts.add(c.start);
    pts.add(clipEnd(c));
  }
  for (const m of doc.markers) pts.add(m.time);
  return [...pts].sort((a, b) => a - b);
}

export function jumpToEdit(dir) {
  const t = transport.frameTime;
  const pts = editPoints();
  const target = dir > 0 ? pts.find((p) => p > t) : [...pts].reverse().find((p) => p < t);
  if (target != null) transport.seek(target);
}

// ---------------------------------------------------------------------------------
// media import
// ---------------------------------------------------------------------------------
let uploadSeq = 1;
const MAX_PARALLEL_UPLOADS = 2;
let activeUploads = 0;
const pending = [];

function patchUpload(id, patch) {
  store.set((s) => ({ uploads: s.uploads.map((u) => (u.id === id ? { ...u, ...patch } : u)) }));
}

function pump() {
  while (activeUploads < MAX_PARALLEL_UPLOADS && pending.length) {
    const { id, file, projectId } = pending.shift();
    if (!store.state.uploads.some((u) => u.id === id)) continue; // dismissed while waiting
    activeUploads++;
    const { promise, abort } = uploadFile(projectId, file, (p) => patchUpload(id, { progress: p }));
    patchUpload(id, { abort, started: true });
    promise
      .then((res) => {
        if (store.state.doc?.id !== projectId) return;
        const assets = new Map(store.state.assets);
        for (const a of res.assets || []) if (!assets.has(a.id)) assets.set(a.id, a);
        store.set((s) => ({ assets, uploads: s.uploads.filter((u) => u.id !== id) }));
      })
      .catch((e) => {
        if (e.code === 'aborted') store.set((s) => ({ uploads: s.uploads.filter((u) => u.id !== id) }));
        else patchUpload(id, { error: e.message, abort: null });
      })
      .finally(() => {
        activeUploads--;
        pump();
      });
  }
}

/** Upload files into the open project's media bin. */
export function importFiles(fileList) {
  const doc = store.state.doc;
  if (!doc) return;
  const files = [...fileList].filter((f) => f && f.size >= 0);
  if (!files.length) return;
  const entries = files.map((file) => ({ id: `u${uploadSeq++}`, name: file.name, size: file.size, progress: 0, error: null, abort: null, started: false }));
  store.set((s) => ({ uploads: [...s.uploads, ...entries] }));
  entries.forEach((e, i) => pending.push({ id: e.id, file: files[i], projectId: doc.id }));
  pump();
}

export function dismissUpload(id) {
  const u = store.state.uploads.find((x) => x.id === id);
  if (u?.abort) u.abort();
  else store.set((s) => ({ uploads: s.uploads.filter((x) => x.id !== id) }));
}

export async function addSampleMedia() {
  const doc = store.state.doc;
  if (!doc) return;
  try {
    const { assets } = await api.addSample(doc.id);
    const map = new Map(store.state.assets);
    for (const a of assets || []) if (a) map.set(a.id, a);
    store.set({ assets: map });
  } catch (e) {
    toast({ kind: 'error', title: 'Could not create sample media', detail: e.message });
  }
}

/** Remove a failed / unregistered upload record from the bin. */
export async function dismissAsset(assetId) {
  const doc = store.state.doc;
  try {
    await api.dismissAsset(assetId, doc.id);
    const assets = new Map(store.state.assets);
    assets.delete(assetId);
    store.set({ assets });
  } catch (e) {
    toast({ kind: 'error', title: 'Could not remove the item', detail: e.message });
  }
}

// ---------------------------------------------------------------------------------
// transcript view (derived on the server from the same document)
// ---------------------------------------------------------------------------------
let transcriptTimer = 0;
let transcriptSeq = 0;

export async function refreshTranscript() {
  const doc = store.state.doc;
  if (!doc) return;
  const seq = ++transcriptSeq;
  store.set((s) => ({ transcript: { ...s.transcript, loading: true, error: null } }));
  try {
    const { view } = await api.transcriptView(doc.id);
    if (seq !== transcriptSeq || store.state.doc?.id !== doc.id) return;
    store.set({ transcript: { view, revision: view.revision, loading: false, error: null } });
  } catch (e) {
    if (seq !== transcriptSeq) return;
    store.set((s) => ({ transcript: { ...s.transcript, loading: false, error: e.message } }));
  }
}

function refreshTranscriptSoon() {
  const doc = store.state.doc;
  // only worth fetching when some asset actually has a transcript
  if (!doc || ![...store.state.assets.values()].some((a) => a.has_transcript)) return;
  clearTimeout(transcriptTimer);
  transcriptTimer = setTimeout(refreshTranscript, 120);
}

/** Switch transcript-based editing on: the server starts transcribing the project's media. */
export function enableTranscriptEditing() {
  return exec({ type: 'set_transcript_editing', enabled: true }, { errorTitle: 'Could not enable transcript editing' });
}

export async function transcriptionAction(assetId, action) {
  try {
    await api.transcription(assetId, action);
  } catch (e) {
    toast({ kind: 'error', title: action === 'cancel' ? 'Could not cancel the transcription' : 'Could not start the transcription', detail: e.message });
  }
}

// convenience for panels
export { trackKindOfClip };
