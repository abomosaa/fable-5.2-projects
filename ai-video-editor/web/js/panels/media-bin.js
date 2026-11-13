// Media bin: import, browse and place media.
import { html, useEffect, useMemo, useRef, useState, useStore, cx, Icon, IconButton, Spinner, Progress, ConfirmDialog, openMenu, toast, formatBytes } from '../lib/ui.js';
import { api, mediaUrl } from '../lib/api.js';
import { clock } from '../lib/time.js';
import { store } from '../state/store.js';
import * as A from '../state/actions.js';
import { transport } from '../player/transport.js';
import { dragPayload, DRAG_MIME } from '../timeline/dnd.js';

const ACCEPT = 'video/*,audio/*,image/*,.srt,.vtt,.mkv,.mov,.mxf,.webm,.flac,.m4a';
const VIEW_KEY = 'cutline:bin-view';
const KIND_ICON = { video: 'film', audio: 'music', image: 'image', subtitle: 'captions' };
const VIDEO_EXT = ['mp4', 'm4v', 'mov', 'mkv', 'webm', 'avi', 'mxf', 'mpg', 'mpeg', 'mts', 'm2ts', 'ts', 'wmv', 'flv', '3gp', 'ogv'];
const KIND_LABEL = { video: 'Video', audio: 'Audio', image: 'Image', subtitle: 'Subtitles' };
const FILTERS = [
  { id: 'all', label: 'All' },
  { id: 'video', label: 'Video' },
  { id: 'audio', label: 'Audio' },
  { id: 'image', label: 'Image' },
  { id: 'subtitle', label: 'Subtitles' },
];

const usageCache = new WeakMap();
/** Map<assetId, number of clips using it> (memoised on the clips Map identity). */
function usageOf(doc) {
  let hit = usageCache.get(doc.clips);
  if (hit) return hit;
  hit = new Map();
  for (const c of doc.clips.values()) {
    const id = c.content.asset_id;
    if (id) hit.set(id, (hit.get(id) || 0) + 1);
  }
  usageCache.set(doc.clips, hit);
  return hit;
}

/** Best guess of the kind before probing has finished (from the extension). */
function kindOf(rec) {
  if (rec.info) return rec.info.kind;
  const e = (rec.ext || '').toLowerCase();
  if (['srt', 'vtt'].includes(e)) return 'subtitle';
  if (['mp3', 'wav', 'flac', 'm4a', 'aac', 'ogg', 'opus', 'aiff'].includes(e)) return 'audio';
  if (['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp', 'tif', 'tiff', 'avif', 'heic'].includes(e)) return 'image';
  if (VIDEO_EXT.includes(e) || rec.state !== 'failed') return 'video';
  return 'file'; // a rejected file of an unknown type: do not call it a video
}

/**
 * Import errors arrive as a plain sentence followed by FFmpeg's own wording in
 * parentheses. Show the sentence; keep the technical tail for the tooltip.
 */
function splitError(message) {
  const text = (message || '').trim();
  const m = /^(.+?[.!?])\s*\(([\s\S]+)\)\s*$/.exec(text);
  return m ? { text: m[1], detail: m[2].replace(/\s+/g, ' ').trim() } : { text, detail: '' };
}

const TRANSCRIPTION = {
  queued: { label: 'Transcript queued', cls: '', busy: true },
  uploading: { label: 'Uploading audio', cls: 'accent', busy: true },
  processing: { label: 'Transcribing', cls: 'accent', busy: true },
  completed: { label: 'Transcribed', cls: 'success' },
  failed: { label: 'Transcript failed', cls: 'danger' },
  cancelled: { label: 'Transcript cancelled', cls: 'warning' },
};

function TranscriptionChip({ t }) {
  const m = TRANSCRIPTION[t.state] || { label: t.state, cls: '' };
  const tip = [m.label, t.fixture ? 'fixture data, not real speech recognition' : null, t.state === 'completed' && t.word_count != null ? `${t.word_count} words` : null, t.message].filter(Boolean).join(' · ');
  return html`<span class=${cx('badge', 'tx-chip', m.cls)} title=${tip} data-testid="transcription-chip" data-state=${t.state}>
    ${m.busy ? html`<span class="spinner tiny" aria-hidden="true"></span>` : html`<${Icon} name="mic" size=${11} />`}
    <span class="sr-only">${tip}</span>
    ${t.fixture && t.state === 'completed' && html`<span aria-hidden="true">FIXTURE</span>`}
  </span>`;
}

function Thumb({ rec, kind }) {
  const [failed, setFailed] = useState(false);
  const src = kind === 'video' && rec.poster ? mediaUrl(rec.id, 'poster.jpg') : kind === 'image' && (rec.poster || rec.preview_image) ? mediaUrl(rec.id, rec.poster ? 'poster.jpg' : 'preview.png') : null;
  useEffect(() => setFailed(false), [src]);
  return html`<span class=${cx('asset-thumb', kind)} aria-hidden="true">
    ${src && !failed
      ? html`<img src=${src} alt="" loading="lazy" decoding="async" draggable=${false} onError=${() => setFailed(true)} />`
      : kind === 'audio'
        ? html`<span class="wave-glyph"><i></i><i></i><i></i><i></i><i></i><i></i><i></i></span>`
        : html`<${Icon} name=${KIND_ICON[kind] || 'file'} />`}
  </span>`;
}

function describe(rec, kind) {
  const info = rec.info;
  if (!info) return formatBytes(rec.size_bytes);
  if (kind === 'subtitle') return `${rec.cue_count ?? 0} cue${rec.cue_count === 1 ? '' : 's'}`;
  if (kind === 'image') return `${info.width}×${info.height}`;
  if (kind === 'audio') return [info.channels === 1 ? 'Mono' : info.channels === 2 ? 'Stereo' : null, info.sample_rate ? `${Math.round(info.sample_rate / 100) / 10} kHz` : null].filter(Boolean).join(' · ') || 'Audio';
  return `${info.width}×${info.height}${info.has_audio ? '' : ' · no audio'}`;
}

function AssetItem({ rec, used, tabbable, onMenu, onAdd, onRemove, onFocus }) {
  const kind = kindOf(rec);
  const info = rec.info;
  const placeable = !!info;
  const busy = rec.state === 'uploading' || rec.state === 'probing' || rec.state === 'processing';
  const failed = rec.state === 'failed';
  const dur = info && info.duration > 0 && kind !== 'image' ? clock(info.duration) : null;
  const err = failed ? splitError(rec.error) : null;
  const stage = rec.state === 'probing' ? 'Analysing…' : rec.state === 'uploading' ? 'Uploading…' : rec.stage || 'Processing…';

  const onDragStart = (e) => {
    if (!placeable) return e.preventDefault();
    dragPayload.asset = { assetId: rec.id };
    e.dataTransfer.setData(DRAG_MIME, rec.id);
    e.dataTransfer.setData('text/plain', rec.name);
    e.dataTransfer.effectAllowed = 'copy';
    const ghost = document.createElement('div');
    ghost.className = `drag-ghost ${kind}`;
    ghost.textContent = rec.name;
    document.body.appendChild(ghost);
    e.dataTransfer.setDragImage(ghost, 14, 14);
    setTimeout(() => ghost.remove(), 0);
  };
  const onKey = (e) => {
    if (e.target !== e.currentTarget) return;
    if (e.key === 'Enter') {
      e.preventDefault();
      if (placeable) onAdd(rec);
    } else if (e.key === 'Delete' || e.key === 'Backspace') {
      e.preventDefault();
      onRemove(rec);
    } else if (e.key === 'ContextMenu' || (e.key === 'F10' && e.shiftKey)) {
      e.preventDefault();
      onMenu(e.currentTarget, rec);
    }
  };
  const label = [rec.name, KIND_LABEL[kind], dur, failed ? `could not be imported: ${err.text}` : busy ? stage : null, used ? `used ${used} time${used === 1 ? '' : 's'} on the timeline` : null].filter(Boolean).join(', ');
  return html`<li
    class=${cx('asset-item', kind, failed && 'failed', busy && 'busy', !placeable && 'pending')}
    role="option"
    aria-selected="false"
    aria-label=${label}
    tabindex=${tabbable ? 0 : -1}
    draggable=${placeable}
    data-testid="asset-item"
    data-asset-id=${rec.id}
    data-state=${rec.state}
    data-kind=${kind}
    onFocus=${(e) => e.target === e.currentTarget && onFocus(rec.id)}
    onDragStart=${onDragStart}
    onDragEnd=${() => (dragPayload.asset = null)}
    onDblClick=${() => placeable && onAdd(rec)}
    onContextMenu=${(e) => onMenu(e, rec)}
    onKeyDown=${onKey}
  >
    <div class="asset-media">
      <${Thumb} rec=${rec} kind=${kind} />
      ${dur && html`<span class="asset-dur tnum">${dur}</span>`}
      ${used > 0 && html`<span class="asset-used" title=${`Used by ${used} clip${used === 1 ? '' : 's'} on the timeline`}><${Icon} name="check" size=${10} />${used}</span>`}
      ${rec.fixture && html`<span class="asset-sample" title="Generated sample media, not a user file">Sample</span>`}
      ${busy &&
      html`<div class="asset-busy">
        ${rec.state === 'processing' && rec.progress > 0 ? html`<${Progress} value=${rec.progress} label=${`${stage} ${rec.name}`} />` : html`<${Progress} label=${`${stage} ${rec.name}`} />`}
      </div>`}
      ${placeable &&
      html`<button type="button" class="asset-add" tabindex="-1" aria-label=${`Add ${rec.name} to the end of the timeline`} title="Add to timeline" onClick=${(e) => (e.stopPropagation(), onAdd(rec))} onDblClick=${(e) => e.stopPropagation()} data-testid="asset-add">
        <${Icon} name="plus" />
      </button>`}
    </div>
    <div class="asset-text">
      <div class="asset-name-row">
        <${Icon} name=${failed ? 'alert' : KIND_ICON[kind] || 'file'} size=${13} class="asset-kind" />
        <span class="asset-name truncate" title=${rec.name}>${rec.name}</span>
        ${!failed && !busy && rec.error && html`<span class="asset-warn" title=${rec.error} role="img" aria-label=${`Warning: ${rec.error}`}><${Icon} name="alert" size=${13} /></span>`}
      </div>
      ${failed
        ? html`<div class="asset-error" role="alert" title=${err.detail ? `Technical details: ${err.detail}` : undefined}>${err.text || 'This file could not be imported.'}</div>
            <div class="asset-actions">
              ${info && html`<button type="button" class="btn small" tabindex="-1" onClick=${() => retry(rec)}><${Icon} name="refresh" /> Retry</button>`}
              <button type="button" class="btn small" tabindex="-1" onClick=${() => onRemove(rec)}><${Icon} name="x" /> Remove</button>
            </div>`
        : html`<div class="asset-sub">
            <span class="truncate">${busy ? `${stage}${rec.state === 'processing' && rec.progress > 0 ? ` ${Math.round(rec.progress * 100)}%` : ''}` : html`${dur && html`<span class="asset-dur-inline">${dur} · </span>`}${describe(rec, kind)}`}</span>
            ${rec.transcription && html`<${TranscriptionChip} t=${rec.transcription} />`}
          </div>`}
    </div>
    <button type="button" class="icon-btn small asset-more" tabindex="-1" aria-label=${`More actions for ${rec.name}`} onClick=${(e) => (e.stopPropagation(), onMenu(e.currentTarget, rec))} onDblClick=${(e) => e.stopPropagation()}>
      <${Icon} name="more" />
    </button>
  </li>`;
}

/** Arrow keys move through a radiogroup of buttons and select, as the role promises. */
function radioKeys(e) {
  const dir = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[e.key];
  if (!dir) return;
  const items = [...e.currentTarget.querySelectorAll('[role="radio"]:not([disabled])')];
  const i = items.indexOf(document.activeElement);
  if (i < 0 || items.length < 2) return;
  e.preventDefault();
  e.stopPropagation();
  const next = items[(i + dir + items.length) % items.length];
  next.focus();
  next.click();
}

async function retry(rec) {
  try {
    await api.reprocessAsset(rec.id, store.state.doc.id);
  } catch (e) {
    toast({ kind: 'error', title: 'Could not retry', detail: e.message });
  }
}

function UploadRow({ u }) {
  return html`<li class=${cx('upload-row', u.error && 'failed')} data-testid="upload-row">
    <${Icon} name=${u.error ? 'alert' : 'upload'} />
    <div class="grow">
      <div class="row" style="gap:6px">
        <span class="truncate grow" title=${u.name}>${u.name}</span>
        <span class="faint tnum">${u.error ? '' : u.started ? `${Math.round(u.progress * 100)}%` : 'Waiting…'}</span>
      </div>
      ${u.error ? html`<div class="asset-error" role="alert">${u.error}</div>` : html`<${Progress} value=${u.started ? u.progress : 0} label=${`Uploading ${u.name}`} />`}
      ${!u.error && html`<div class="faint" style="font-size:var(--fs-xs)">${formatBytes(u.size)}</div>`}
    </div>
    <${IconButton} icon="x" small label=${u.error ? 'Dismiss' : 'Cancel upload'} tipPos="left" onClick=${() => A.dismissUpload(u.id)} />
  </li>`;
}

export function MediaBin() {
  const assets = useStore((s) => s.assets);
  const uploads = useStore((s) => s.uploads);
  const docAssets = useStore((s) => s.doc?.assets);
  const clips = useStore((s) => s.doc?.clips);
  const fixture = useStore((s) => !!s.health?.fixture);
  const ffmpegOk = useStore((s) => s.health?.ffmpeg?.ok !== false);
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState('all');
  const [view, setViewMode] = useState(() => {
    try {
      return localStorage.getItem(VIEW_KEY) === 'list' ? 'list' : 'grid';
    } catch {
      return 'grid';
    }
  });
  const [dropping, setDropping] = useState(false);
  const [confirm, setConfirm] = useState(null);
  const [sampleBusy, setSampleBusy] = useState(false);
  const [focusId, setFocusId] = useState(null);
  const inputRef = useRef(null);
  const listRef = useRef(null);
  const dragDepth = useRef(0);

  // Records shown in the bin: registered in the document, or not registered yet
  // (still probing / failed) — the same rule the server uses.
  const records = useMemo(() => {
    const out = [];
    for (const r of assets.values()) if (!r.info || docAssets?.has(r.id)) out.push(r);
    out.sort((a, b) => a.created_at_ms - b.created_at_ms || (a.id < b.id ? -1 : 1));
    return out;
  }, [assets, docAssets]);
  const counts = useMemo(() => {
    const c = { all: records.length, video: 0, audio: 0, image: 0, subtitle: 0 };
    for (const r of records) {
      const k = kindOf(r);
      if (k in c) c[k]++;
    }
    return c;
  }, [records]);
  const q = query.trim().toLowerCase();
  const shown = useMemo(() => records.filter((r) => (filter === 'all' || kindOf(r) === filter) && (!q || r.name.toLowerCase().includes(q))), [records, filter, q]);
  const usage = useMemo(() => (store.state.doc ? usageOf(store.state.doc) : new Map()), [clips]);
  const tabbableId = shown.some((r) => r.id === focusId) ? focusId : shown[0]?.id;

  const setView = (v) => {
    setViewMode(v);
    try {
      localStorage.setItem(VIEW_KEY, v);
    } catch {
      /* not persisted */
    }
  };

  const add = (rec, opts) => A.addAssetToTimeline(rec.id, opts);
  const remove = (rec) => {
    if (!rec.info || !store.state.doc.assets.has(rec.id)) return A.dismissAsset(rec.id);
    const n = usageOf(store.state.doc).get(rec.id) || 0;
    const run = () => A.exec({ type: 'remove_asset', asset_id: rec.id }, { errorTitle: 'Could not remove the media' });
    if (n === 0) return run();
    setConfirm({
      title: `Remove “${rec.name}”?`,
      message: html`This media is used by <strong>${n} clip${n === 1 ? '' : 's'}</strong> on the timeline. Removing it from the project also removes ${n === 1 ? 'that clip' : 'those clips'}. You can bring everything back with Undo.`,
      confirmLabel: n === 1 ? 'Remove media and 1 clip' : `Remove media and ${n} clips`,
      onConfirm: run,
    });
  };
  const menu = (at, rec) => {
    const placeable = !!rec.info;
    const t = rec.transcription;
    const canTranscribe = placeable && rec.info.has_audio;
    const active = t && ['queued', 'uploading', 'processing'].includes(t.state);
    const inDoc = placeable && store.state.doc.assets.has(rec.id);
    openMenu(at, [
      { label: 'Add to end of timeline', icon: 'plus', hint: 'Enter', disabled: !placeable, onSelect: () => add(rec) },
      { label: 'Insert at playhead', icon: 'ripple', disabled: !placeable, onSelect: () => add(rec, { start: transport.frameTime, mode: 'insert' }) },
      { label: 'Overwrite at playhead', icon: 'layers', disabled: !placeable, onSelect: () => add(rec, { start: transport.frameTime, mode: 'overwrite' }) },
      canTranscribe && { separator: true },
      canTranscribe && !t && { label: 'Transcribe', icon: 'mic', disabled: !rec.speech, onSelect: () => A.transcriptionAction(rec.id, 'start') },
      canTranscribe && active && { label: 'Cancel transcription', icon: 'x', onSelect: () => A.transcriptionAction(rec.id, 'cancel') },
      canTranscribe && t && !active && { label: t.state === 'completed' ? 'Transcribe again' : 'Retry transcription', icon: 'refresh', onSelect: () => A.transcriptionAction(rec.id, 'retry') },
      { separator: true },
      (rec.state === 'failed' || (rec.state === 'ready' && rec.error)) && placeable && { label: 'Retry processing', icon: 'refresh', onSelect: () => retry(rec) },
      { label: inDoc ? 'Remove from project' : 'Remove', icon: 'trash', hint: 'Del', danger: true, onSelect: () => remove(rec) },
    ]);
  };

  // roving focus with the arrow keys (grid aware)
  const onListKey = (e) => {
    if (!['ArrowDown', 'ArrowUp', 'ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) return;
    const items = [...listRef.current.querySelectorAll('.asset-item')];
    const cur = items.indexOf(document.activeElement.closest?.('.asset-item'));
    if (cur < 0 || document.activeElement !== items[cur]) return;
    e.preventDefault();
    e.stopPropagation();
    let next = cur;
    if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = items.length - 1;
    else if (e.key === 'ArrowLeft') next = cur - 1;
    else if (e.key === 'ArrowRight') next = cur + 1;
    else {
      const top = items[cur].offsetTop;
      const cols = Math.max(1, items.filter((el) => el.offsetTop === top).length);
      // number of columns in this row == columns of the grid (1 in list view)
      const perRow = view === 'list' ? 1 : Math.max(cols, items.filter((el) => el.offsetTop === items[0].offsetTop).length);
      next = cur + (e.key === 'ArrowDown' ? perRow : -perRow);
      if (next >= items.length && e.key === 'ArrowDown' && cur !== items.length - 1) next = items.length - 1;
    }
    const el = items[next];
    if (el) {
      setFocusId(el.dataset.assetId);
      el.focus();
      el.scrollIntoView({ block: 'nearest' });
    }
  };

  // ---- file drop (ignore drags that are not files, e.g. bin items) ----
  const isFiles = (e) => [...(e.dataTransfer?.types || [])].includes('Files');
  const onDragEnter = (e) => {
    if (!isFiles(e)) return;
    e.preventDefault();
    dragDepth.current++;
    setDropping(true);
  };
  const onDragOver = (e) => {
    if (!isFiles(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
  };
  const onDragLeave = (e) => {
    if (!isFiles(e)) return;
    dragDepth.current = Math.max(0, dragDepth.current - 1);
    if (dragDepth.current === 0) setDropping(false);
  };
  const onDrop = (e) => {
    if (!isFiles(e)) return;
    e.preventDefault();
    dragDepth.current = 0;
    setDropping(false);
    if (e.dataTransfer.files?.length) A.importFiles(e.dataTransfer.files);
  };

  const pick = () => inputRef.current?.click();
  const addSample = async () => {
    setSampleBusy(true);
    try {
      await A.addSampleMedia();
    } finally {
      setSampleBusy(false);
    }
  };
  const isEmpty = records.length === 0 && uploads.length === 0;
  const showSample = fixture || isEmpty;

  return html`<div class=${cx('bin', dropping && 'dropping')} onDragEnter=${onDragEnter} onDragOver=${onDragOver} onDragLeave=${onDragLeave} onDrop=${onDrop} data-testid="media-bin">
    <input
      ref=${inputRef}
      id="import-input"
      class="sr-only"
      type="file"
      multiple
      accept=${ACCEPT}
      tabindex="-1"
      aria-hidden="true"
      data-testid="import-input"
      onChange=${(e) => {
        A.importFiles(e.currentTarget.files);
        e.currentTarget.value = '';
      }}
    />
    <div class="bin-toolbar">
      <div class="row" style="gap:6px">
        <button type="button" class="btn primary grow" onClick=${pick} data-testid="import-button"><${Icon} name="upload" /> Import</button>
        ${showSample &&
        html`<button type="button" class="btn" onClick=${addSample} disabled=${sampleBusy || !ffmpegOk} data-tip="Add a generated sample clip (test pattern + tone)" data-tip-pos="left" data-testid="add-sample">
          ${sampleBusy ? html`<${Spinner} label="Generating sample" />` : html`<${Icon} name="wand" />`} Sample
        </button>`}
      </div>
      ${!isEmpty &&
      html`<div class="row" style="gap:6px">
          <div class="search-field grow">
            <${Icon} name="search" />
            <input class="input" type="search" placeholder="Search media" aria-label="Search media" value=${query} onInput=${(e) => setQuery(e.currentTarget.value)} onKeyDown=${(e) => e.key === 'Escape' && query && (e.stopPropagation(), setQuery(''))} />
          </div>
          <div class="seg" role="radiogroup" aria-label="Media view" onKeyDown=${radioKeys}>
            <button type="button" role="radio" aria-checked=${String(view === 'grid')} aria-label="Grid view" title="Grid view" onClick=${() => setView('grid')}><${Icon} name="grid" size=${13} /></button>
            <button type="button" role="radio" aria-checked=${String(view === 'list')} aria-label="List view" title="List view" onClick=${() => setView('list')}><${Icon} name="list" size=${13} /></button>
          </div>
        </div>
        <div class="bin-filters" role="radiogroup" aria-label="Filter media by type" onKeyDown=${radioKeys}>
          ${FILTERS.filter((f) => f.id === 'all' || counts[f.id] > 0 || filter === f.id).map(
            (f) => html`<button type="button" class="chip" role="radio" aria-checked=${String(filter === f.id)} onClick=${() => setFilter(f.id)}>${f.label}<span class="n tnum">${counts[f.id]}</span></button>`,
          )}
        </div>`}
    </div>

    <div class="bin-scroll">
      ${uploads.length > 0 && html`<ul class="upload-list" aria-label="Uploads in progress">${uploads.map((u) => html`<${UploadRow} key=${u.id} u=${u} />`)}</ul>`}
      ${isEmpty
        ? html`<div class="empty bin-empty">
            <${Icon} name="upload" />
            <h3>Add your media</h3>
            <p>Drop video, audio, image or subtitle files here, or use Import. Then drag clips onto the timeline.</p>
            <div class="row" style="flex-wrap:wrap;justify-content:center">
              <button type="button" class="btn" onClick=${pick}><${Icon} name="folder" /> Choose files…</button>
              <button type="button" class="btn ghost" onClick=${addSample} disabled=${sampleBusy || !ffmpegOk}>${sampleBusy ? html`<${Spinner} label="Generating sample" />` : html`<${Icon} name="wand" />`} Use a generated sample clip</button>
            </div>
          </div>`
        : shown.length === 0 && records.length > 0
          ? html`<div class="empty" role="status">
              <${Icon} name="search" />
              <h3>No media matches</h3>
              <p>${q ? `Nothing named “${query.trim()}”${filter !== 'all' ? ` in ${KIND_LABEL[filter].toLowerCase()}` : ''}.` : `There is no ${KIND_LABEL[filter]?.toLowerCase()} in this project.`}</p>
              <button
                type="button"
                class="btn"
                onClick=${() => {
                  setQuery('');
                  setFilter('all');
                }}
              >
                Show all media
              </button>
            </div>`
          : html`<ul ref=${listRef} class=${cx('asset-list', view)} role="listbox" aria-label="Project media" aria-orientation=${view === 'list' ? 'vertical' : undefined} onKeyDown=${onListKey}>
              ${shown.map((r) => html`<${AssetItem} key=${r.id} rec=${r} used=${usage.get(r.id) || 0} tabbable=${r.id === tabbableId} onMenu=${menu} onAdd=${add} onRemove=${remove} onFocus=${setFocusId} />`)}
            </ul>`}
    </div>
    ${!isEmpty && html`<div class="bin-foot faint">Drag onto the timeline, or double-click to add</div>`}
    <div class="bin-drop" aria-hidden="true"><div><${Icon} name="upload" /><span>Drop files to import</span></div></div>
    ${confirm && html`<${ConfirmDialog} title=${confirm.title} message=${confirm.message} confirmLabel=${confirm.confirmLabel} danger onConfirm=${confirm.onConfirm} onClose=${() => setConfirm(null)} />`}
  </div>`;
}
