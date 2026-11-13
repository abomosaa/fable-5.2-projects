// Export dialog: settings → real server-side render with progress → playable result.
import { html, useEffect, useLayoutEffect, useMemo, useRef, useState, useStore, cx, Icon, IconButton, Spinner, Progress, Dialog, Notice, Switch, toast, formatBytes, timeAgo } from '../lib/ui.js';
import { api, exportUrl } from '../lib/api.js';
import { FPS_PRESETS, TPS, fpsLabel, fpsValue, humanDuration } from '../lib/time.js';
import { store } from '../state/store.js';

const CODECS = [
  { id: 'h264', label: 'H.264', container: 'MP4', encoder: 'libx264', note: 'Plays everywhere' },
  { id: 'hevc', label: 'H.265 / HEVC', container: 'MP4', encoder: 'libx265', note: 'Smaller files, slower to encode' },
  { id: 'vp9', label: 'VP9', container: 'WebM', encoder: 'libvpx-vp9', note: 'Open format for the web' },
];
const QUALITIES = [
  { id: 'draft', label: 'Draft', note: 'Fastest render, smaller file — for review copies.', bpp: 0.045 },
  { id: 'standard', label: 'Standard', note: 'Balanced quality and size — good for sharing.', bpp: 0.085 },
  { id: 'high', label: 'High', note: 'Visually lossless master — slower, larger file.', bpp: 0.16 },
];
const CODEC_FACTOR = { h264: 1, hevc: 0.62, vp9: 0.68 };
const AUDIO_BITRATES = [96, 128, 192, 256, 320];
const ACTIVE = ['queued', 'rendering', 'finalizing'];
const isActive = (j) => ACTIVE.includes(j.state);
const even = (n) => Math.max(2, Math.round(n / 2) * 2);

/** Resolution choices for a project of the given size. */
function resolutionPresets(w, h, max) {
  const aspect = w / h;
  const landscape = aspect >= 1;
  const short = (s) => {
    let pw = landscape ? even(s * aspect) : s;
    let ph = landscape ? s : even(s / aspect);
    const over = Math.max(pw, ph) / max;
    if (over > 1) {
      pw = even(pw / over - 1);
      ph = even(ph / over - 1);
    }
    return [pw, ph];
  };
  const list = [{ id: 'project', label: 'Project size', w, h }];
  for (const [id, label, s] of [
    ['720p', '720p HD', 720],
    ['1080p', '1080p Full HD', 1080],
    ['1440p', '1440p QHD', 1440],
    ['2160p', '4K UHD', 2160],
  ]) {
    const [pw, ph] = short(s);
    list.push({ id, label, w: pw, h: ph });
  }
  const dci = landscape ? [4096, 2160] : [2160, 4096];
  list.push({ id: 'dci', label: '4K DCI', w: dci[0], h: dci[1] });
  return list;
}

function formatEta(s) {
  if (s == null || !Number.isFinite(s)) return null;
  if (s < 1) return 'almost done';
  if (s < 60) return `${Math.ceil(s)} s left`;
  return `${Math.floor(s / 60)} min ${Math.round(s % 60)} s left`;
}

/** Arrow keys move through a radiogroup of buttons and select, as the role promises. */
function radioKeys(e) {
  const dir = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[e.key];
  if (!dir) return;
  const items = [...e.currentTarget.querySelectorAll('[role="radio"]:not([disabled])')];
  const i = items.indexOf(document.activeElement);
  if (i < 0 || items.length < 2) return;
  e.preventDefault();
  const next = items[(i + dir + items.length) % items.length];
  next.focus();
  next.click();
}

const codecOf = (job) => CODECS.find((c) => c.id === job.settings?.video_codec) || CODECS[0];
const describeJob = (job) => `${job.settings.width}×${job.settings.height} · ${fpsLabel(job.settings.fps)} fps · ${codecOf(job).label}`;

const STATE_BADGE = {
  queued: ['Queued', ''],
  rendering: ['Rendering', 'accent'],
  finalizing: ['Finalizing', 'accent'],
  completed: ['Done', 'success'],
  failed: ['Failed', 'danger'],
  cancelled: ['Cancelled', 'warning'],
};

function CaptionLinks({ projectId }) {
  return html`<div class="export-captions">
    <${Icon} name="captions" />
    <span class="grow">Captions as a separate file</span>
    <a class="btn small" href=${`/api/projects/${projectId}/captions.srt`} download data-testid="captions-srt"><${Icon} name="download" /> .srt</a>
    <a class="btn small" href=${`/api/projects/${projectId}/captions.vtt`} download data-testid="captions-vtt"><${Icon} name="download" /> .vtt</a>
  </div>`;
}

function Running({ job, onCancel, cancelling }) {
  const pct = Math.round((job.progress || 0) * 100);
  const eta = formatEta(job.eta_seconds);
  const stage = job.state === 'queued' ? 'Waiting to start…' : job.stage || (job.state === 'finalizing' ? 'Finalizing…' : 'Rendering…');
  return html`<div class="export-run" data-testid="export-progress" data-state=${job.state}>
    <div class="row">
      <${Spinner} label="Rendering" />
      <strong class="grow truncate">${stage}</strong>
      <span class="export-pct tnum" aria-hidden="true">${pct}%</span>
    </div>
    <${Progress} value=${job.state === 'queued' ? null : job.progress} label="Export progress" />
    <div class="export-stats tnum" aria-live="off">
      <span>${job.frames_done.toLocaleString()} / ${job.total_frames.toLocaleString()} frames</span>
      ${job.fps_speed > 0 && html`<span>${job.fps_speed.toFixed(job.fps_speed < 10 ? 1 : 0)} fps</span>`} ${eta && html`<span>${eta}</span>`}
    </div>
    <div class="sr-only" role="status" aria-live="polite">${stage} ${Math.round(pct / 10) * 10} percent</div>
    <p class="faint export-hint">${describeJob(job)} · You can close this window — the export keeps running on the server.</p>
    <div class="row" style="justify-content:flex-end">
      <button type="button" class="btn" onClick=${onCancel} disabled=${cancelling} data-testid="export-cancel">${cancelling ? html`<${Spinner} label="Cancelling" />` : html`<${Icon} name="stop" />`} Cancel export</button>
    </div>
  </div>`;
}

function Failed({ job }) {
  const err = job.error || {};
  return html`<div class="export-failed" data-testid="export-error" role="alert">
    <${Notice} kind="error">
      <strong>The export failed.</strong> ${err.message || 'FFmpeg stopped unexpectedly.'}
      ${err.hint && html`<div class="export-hint-line">${err.hint}</div>`}
    <//>
    ${err.log_tail &&
    html`<details class="export-log">
      <summary>Technical details${err.code ? ` (${err.code})` : ''}</summary>
      <pre tabindex="0">${err.log_tail}</pre>
    </details>`}
  </div>`;
}

function Completed({ job }) {
  const [broken, setBroken] = useState(false);
  const url = exportUrl(job);
  return html`<div class="export-done" data-testid="export-result">
    <div class="export-video-wrap" style=${{ aspectRatio: `${job.settings.width} / ${job.settings.height}` }}>
      <video
        class="export-video"
        src=${url}
        controls
        playsinline
        preload="metadata"
        data-testid="export-video"
        aria-label=${`Exported video: ${job.project_name}`}
        onLoadedMetadata=${() => setBroken(false)}
        onError=${() => setBroken(true)}
      ></video>
    </div>
    ${broken &&
    html`<${Notice} kind="warning">Your browser cannot play this file inline${job.settings.video_codec === 'hevc' ? ' (H.265 is not supported by every browser)' : ''}. The file itself is fine — download it to watch in a media player.<//>`}
    <div class="export-result-row">
      <div class="grow" style="min-width:0">
        <div class="row" style="gap:6px"><${Icon} name="check" class="ok" /><strong class="truncate">${job.file_name || 'Export'}</strong></div>
        <div class="faint tnum export-result-meta">
          ${[formatBytes(job.file_size || 0), job.output_duration_ms != null ? humanDuration((job.output_duration_ms / 1000) * TPS) : null, describeJob(job)].filter(Boolean).join(' · ')}
        </div>
      </div>
      <a class="btn primary" href=${exportUrl(job, true)} download=${job.file_name || true} data-testid="export-download"><${Icon} name="download" /> Download</a>
    </div>
  </div>`;
}

function HistoryRow({ job, current, onShow }) {
  const [label, cls] = STATE_BADGE[job.state] || [job.state, ''];
  const [busy, setBusy] = useState(false);
  const del = async () => {
    setBusy(true);
    try {
      await api.deleteExport(job.id);
      store.set((s) => ({ exports: s.exports.filter((j) => j.id !== job.id) }));
    } catch (e) {
      toast({ kind: 'error', title: 'Could not delete the export', detail: e.message });
      setBusy(false);
    }
  };
  return html`<li class=${cx('export-row', current && 'current')} data-testid="export-row" data-state=${job.state}>
    <span class=${cx('badge', cls)}>${label}${isActive(job) ? ` ${Math.round((job.progress || 0) * 100)}%` : ''}</span>
    <div class="grow" style="min-width:0">
      <div class="truncate">${describeJob(job)}</div>
      <div class="faint tnum truncate">
        ${[timeAgo(job.finished_at_ms || job.created_at_ms), job.state === 'completed' ? formatBytes(job.file_size || 0) : null, job.state === 'failed' ? job.error?.message : null].filter(Boolean).join(' · ')}
      </div>
    </div>
    ${(job.state === 'completed' || job.state === 'failed' || isActive(job)) && !current && html`<${IconButton} icon=${job.state === 'completed' ? 'play' : 'info'} small label=${job.state === 'completed' ? 'Play this export' : 'Show details'} tipPos="left" onClick=${() => onShow(job.id)} />`}
    ${job.state === 'completed' && html`<a class="icon-btn small" href=${exportUrl(job, true)} download=${job.file_name || true} aria-label="Download this export" data-tip="Download" data-tip-pos="left"><${Icon} name="download" /></a>`}
    ${busy ? html`<${Spinner} label="Deleting" />` : html`<${IconButton} icon="trash" small label=${isActive(job) ? 'Cancel and delete' : 'Delete this export'} tipPos="left" onClick=${del} />`}
  </li>`;
}

export function ExportDialog({ onClose }) {
  const doc = useStore((s) => s.doc);
  const duration = useStore((s) => s.duration);
  const health = useStore((s) => s.health);
  const exports = useStore((s) => s.exports);
  const maxDim = health?.limits?.max_dimension || 4096;
  const maxFps = health?.limits?.max_fps || 60;
  const encoders = health?.ffmpeg?.encoders || [];
  const ffmpegOk = health?.ffmpeg?.ok !== false;
  const project = doc.settings;

  const captionCount = useMemo(() => {
    let n = 0;
    for (const c of doc.clips.values()) if (c.content.kind === 'caption') n++;
    return n;
  }, [doc.clips]);

  const presets = useMemo(() => resolutionPresets(project.width, project.height, maxDim), [project.width, project.height, maxDim]);
  const available = (c) => encoders.includes(c.encoder);
  const [res, setRes] = useState('project');
  const [custom, setCustom] = useState({ w: String(project.width), h: String(project.height) });
  const [fps, setFps] = useState('project');
  const [codec, setCodec] = useState(() => (CODECS.find(available) || CODECS[0]).id);
  const [quality, setQuality] = useState('standard');
  const [burn, setBurn] = useState(true);
  const [audio, setAudio] = useState(192);
  const [starting, setStarting] = useState(false);
  const [startError, setStartError] = useState(null);
  const [cancelling, setCancelling] = useState(false);
  // which job the top of the dialog shows; null = the settings form
  const [focusId, setFocusId] = useState(() => exports.find(isActive)?.id || null);
  const topRef = useRef(null);

  const job = focusId ? exports.find((j) => j.id === focusId) : null;
  useEffect(() => {
    if (focusId && !job) setFocusId(null); // deleted elsewhere
  }, [focusId, job]);
  useEffect(() => {
    if (job && !isActive(job)) setCancelling(false);
  }, [job?.state]);
  // When the dialog switches between settings / progress / result the previously
  // focused control disappears; keep focus inside the dialog so Escape and Tab work.
  useLayoutEffect(() => {
    const dlg = topRef.current?.closest('.dialog');
    const active = document.activeElement;
    if (dlg && (!active || active === document.body)) (dlg.querySelector('.dialog-foot .btn:not([disabled])') || dlg.querySelector('button'))?.focus({ preventScroll: true });
  });
  // Fallback polling while a job is active: progress normally arrives over SSE, but
  // keep the dialog honest if the event stream is interrupted.
  useEffect(() => {
    if (!job || !isActive(job)) return undefined;
    const t = setInterval(async () => {
      try {
        const { exports: list } = await api.listExports(doc.id);
        if (store.state.doc?.id === doc.id) store.set({ exports: list });
      } catch {
        /* next tick */
      }
    }, 2500);
    return () => clearInterval(t);
  }, [job?.id, job && isActive(job)]);

  // ---- resolve the form into settings + validation ----
  const size = useMemo(() => {
    if (res !== 'custom') {
      const p = presets.find((x) => x.id === res) || presets[0];
      return { w: p.w, h: p.h, error: null };
    }
    const w = Number(custom.w);
    const h = Number(custom.h);
    // say exactly which field is wrong and why, and mark only that field
    const problem = (v, name) => {
      if (!Number.isInteger(v) || v < 16 || v > maxDim) return `${name} must be a whole number between 16 and ${maxDim}.`;
      if (v % 2 !== 0) return `${name} must be an even number — try ${v - 1} or ${v + 1}.`;
      return null;
    };
    const wError = problem(w, 'Width');
    const hError = problem(h, 'Height');
    return { w, h, wError, hError, error: wError && hError ? `Width and height must be even whole numbers between 16 and ${maxDim}.` : wError || hError };
  }, [res, custom, presets, maxDim]);
  const fpsObj = fps === 'project' ? project.fps : FPS_PRESETS.find((p) => p.label === fps) || project.fps;
  const aspectDiffers = !size.error && Math.abs(size.w / size.h - project.width / project.height) > 0.01;
  const sizeBytes = useMemo(() => {
    if (size.error || !duration) return 0;
    const secs = duration / TPS;
    const q = QUALITIES.find((x) => x.id === quality);
    const video = size.w * size.h * fpsValue(fpsObj) * q.bpp * (CODEC_FACTOR[codec] || 1);
    return ((video + audio * 1000) * secs) / 8;
  }, [size, duration, quality, codec, audio, fpsObj]);
  const codecInfo = CODECS.find((c) => c.id === codec);
  const blocked = !ffmpegOk
    ? health?.ffmpeg?.message || 'FFmpeg is not installed on the server, so nothing can be rendered.'
    : duration <= 0
      ? 'The timeline is empty. Add a clip before exporting.'
      : !available(codecInfo)
        ? `This FFmpeg build has no ${codecInfo.label} encoder (${codecInfo.encoder}). Choose another codec.`
        : size.error;

  const start = async () => {
    if (blocked || starting) return;
    setStarting(true);
    setStartError(null);
    try {
      const { export: created } = await api.startExport(doc.id, {
        width: size.w,
        height: size.h,
        fps: { num: fpsObj.num, den: fpsObj.den },
        video_codec: codec,
        quality,
        audio_bitrate_kbps: audio,
        burn_captions: burn && captionCount > 0,
      });
      store.set((s) => (s.exports.some((j) => j.id === created.id) ? null : { exports: [created, ...s.exports] }));
      setFocusId(created.id);
      topRef.current?.scrollIntoView?.({ block: 'start' });
    } catch (e) {
      setStartError(e.message);
    } finally {
      setStarting(false);
    }
  };
  const cancel = async () => {
    if (!job) return;
    setCancelling(true);
    try {
      const { export: updated } = await api.cancelExport(job.id);
      if (updated) store.set((s) => ({ exports: s.exports.map((j) => (j.id === updated.id ? updated : j)) }));
    } catch (e) {
      setCancelling(false);
      toast({ kind: 'error', title: 'Could not cancel the export', detail: e.message });
    }
  };

  const others = exports.filter((j) => j.id !== focusId);
  const showForm = !job;
  const footer = showForm
    ? html`<button type="button" class="btn" onClick=${onClose}>Close</button>
        <button type="button" class="btn primary" onClick=${start} disabled=${!!blocked || starting} aria-describedby=${blocked ? 'export-blocked' : undefined} data-testid="export-start">
          ${starting ? html`<${Spinner} label="Starting" />` : html`<${Icon} name="export" />`} Export video
        </button>`
    : html`<button type="button" class="btn" onClick=${onClose}>Close</button>
        ${!isActive(job) &&
        html`<button type="button" class=${cx('btn', job.state !== 'completed' && 'primary')} onClick=${() => setFocusId(null)} data-testid="export-again">
          <${Icon} name=${job.state === 'completed' ? 'sliders' : 'refresh'} /> ${job.state === 'completed' ? 'Export again…' : 'Try again'}
        </button>`}`;

  return html`<${Dialog} title="Export video" onClose=${onClose} wide footer=${footer} initialFocus=${showForm ? '#export-res' : '.dialog-foot .btn'}>
    <div class="export" ref=${topRef} data-testid="export-dialog" data-view=${showForm ? 'settings' : job.state}>
      ${showForm &&
      html`<div class="export-form">
        <div class="export-summary">
          <div>
            <span class="label">Timeline</span>
            <strong class="tnum">${duration > 0 ? humanDuration(duration) : 'Empty'}</strong>
          </div>
          <div>
            <span class="label">Project format</span>
            <strong class="tnum">${project.width}×${project.height} · ${fpsLabel(project.fps)} fps</strong>
          </div>
          <div>
            <span class="label">Output</span>
            <strong class="tnum">${size.error ? '—' : `${size.w}×${size.h}`} · ${fpsLabel(fpsObj)} fps · ${codecInfo.container}</strong>
          </div>
          <div>
            <span class="label">Estimated size</span>
            <strong class="tnum" data-testid="export-estimate">${sizeBytes ? `≈ ${formatBytes(sizeBytes)}` : '—'}</strong>
          </div>
        </div>

        ${blocked && html`<div id="export-blocked"><${Notice} kind=${size.error && blocked === size.error ? 'warning' : 'error'}>${blocked}<//></div>`}
        ${startError && html`<${Notice} kind="error"><strong>The export could not start.</strong> ${startError}<//>`}

        <div class="export-grid">
          <div class="field">
            <label for="export-res">Resolution</label>
            <select id="export-res" class="select" value=${res} onChange=${(e) => setRes(e.currentTarget.value)} data-testid="export-resolution">
              ${presets.map((p) => html`<option value=${p.id}>${p.label} — ${p.w}×${p.h}</option>`)}
              <option value="custom">Custom…</option>
            </select>
          </div>
          <div class="field">
            <label for="export-fps">Frame rate</label>
            <select id="export-fps" class="select" value=${fps} onChange=${(e) => setFps(e.currentTarget.value)} data-testid="export-fps">
              <option value="project">Project — ${fpsLabel(project.fps)} fps</option>
              ${FPS_PRESETS.filter((p) => p.num / p.den <= maxFps + 0.001).map((p) => html`<option value=${p.label}>${p.label} fps</option>`)}
            </select>
          </div>
          ${res === 'custom' &&
          html`<div class="field export-custom">
            <span class="label" id="export-custom-l">Custom size (pixels)</span>
            <div class="row" role="group" aria-labelledby="export-custom-l">
              <input class="input tnum" inputmode="numeric" aria-label="Width in pixels" aria-invalid=${size.wError ? 'true' : undefined} value=${custom.w} onInput=${(e) => setCustom({ ...custom, w: e.currentTarget.value.trim() })} data-testid="export-width" />
              <span class="faint" aria-hidden="true">×</span>
              <input class="input tnum" inputmode="numeric" aria-label="Height in pixels" aria-invalid=${size.hError ? 'true' : undefined} value=${custom.h} onInput=${(e) => setCustom({ ...custom, h: e.currentTarget.value.trim() })} data-testid="export-height" />
            </div>
          </div>`}
          ${aspectDiffers && html`<p class="faint export-note"><${Icon} name="info" size=${13} /> This size has a different shape than the project (${project.width}×${project.height}); the picture is fitted inside it with bars.</p>`}

          <div class="field export-wide">
            <span class="label" id="export-codec-l">Format</span>
            <div class="choice-row" role="radiogroup" aria-labelledby="export-codec-l" onKeyDown=${radioKeys}>
              ${CODECS.map((c) => {
                const ok = available(c);
                return html`<button type="button" class="choice" role="radio" aria-checked=${String(codec === c.id)} disabled=${!ok && ffmpegOk} onClick=${() => setCodec(c.id)} title=${ok || !ffmpegOk ? undefined : `Not available: this FFmpeg build has no ${c.encoder} encoder`} data-testid=${`export-codec-${c.id}`}>
                  <span class="choice-title">${c.label} <span class="badge">${c.container}</span></span>
                  <span class="choice-note">${ok || !ffmpegOk ? c.note : `Needs ${c.encoder} in FFmpeg`}</span>
                </button>`;
              })}
            </div>
          </div>

          <div class="field export-wide">
            <span class="label" id="export-quality-l">Quality</span>
            <div class="choice-row" role="radiogroup" aria-labelledby="export-quality-l" onKeyDown=${radioKeys}>
              ${QUALITIES.map(
                (q) => html`<button type="button" class="choice" role="radio" aria-checked=${String(quality === q.id)} onClick=${() => setQuality(q.id)} data-testid=${`export-quality-${q.id}`}>
                  <span class="choice-title">${q.label}</span>
                  <span class="choice-note">${q.note}</span>
                </button>`,
              )}
            </div>
          </div>

          <div class="field">
            <label for="export-audio">Audio bitrate</label>
            <select id="export-audio" class="select" value=${String(audio)} onChange=${(e) => setAudio(Number(e.currentTarget.value))}>
              ${AUDIO_BITRATES.map((b) => html`<option value=${String(b)}>${b} kbps ${codec === 'vp9' ? 'Opus' : 'AAC'}${b === 192 ? ' (recommended)' : ''}</option>`)}
            </select>
          </div>
          <div class="field">
            <span class="label">Captions</span>
            <div class="export-switch">
              <${Switch} checked=${burn && captionCount > 0} disabled=${captionCount === 0} onChange=${setBurn} label="Burn captions into the video" />
              <span class="faint">${captionCount === 0 ? 'This project has no captions yet.' : `${captionCount} caption${captionCount === 1 ? '' : 's'} on the timeline.`}</span>
            </div>
          </div>
        </div>
      </div>`}

      ${job && isActive(job) && html`<${Running} job=${job} onCancel=${cancel} cancelling=${cancelling} />`}
      ${job && job.state === 'completed' && html`<${Completed} key=${job.id} job=${job} />`}
      ${job && job.state === 'failed' && html`<${Failed} job=${job} />`}
      ${job &&
      job.state === 'cancelled' &&
      html`<div data-testid="export-cancelled"><${Notice} kind="warning"><strong>Export cancelled.</strong> No file was created.<div class="export-cancel-meta tnum">${describeJob(job)}</div><//></div>`}

      ${captionCount > 0 && html`<${CaptionLinks} projectId=${doc.id} />`}

      ${others.length > 0 &&
      html`<section class="export-history" aria-labelledby="export-history-h">
        <h3 id="export-history-h">${showForm ? 'Exports of this project' : 'Other exports'}</h3>
        <ul>
          ${others.map((j) => html`<${HistoryRow} key=${j.id} job=${j} onShow=${setFocusId} />`)}
        </ul>
      </section>`}
    </div>
  <//>`;
}
