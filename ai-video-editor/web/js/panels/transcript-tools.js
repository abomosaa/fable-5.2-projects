// Transcript clean-up tools: filler review, silence review, tighten, captions.
// Every tool ends in ONE undoable command.

import { html, useEffect, useMemo, useRef, useState, useStore, Dialog, Icon, IconButton, Notice, NumberField, Slider, Spinner, Switch, EmptyState, cx } from '../lib/ui.js';
import { api } from '../lib/api.js';
import { clock, TPS } from '../lib/time.js';
import { exec } from '../state/actions.js';
import { store } from '../state/store.js';
import { transport } from '../player/transport.js';
import { contextOf, fmtSeconds, wireCuts } from './transcript-model.js';

// ---------------------------------------------------------------------------------
// Play a stretch of the timeline and stop at its end (used for previews).
// ---------------------------------------------------------------------------------
let stopRange = null;
export function playRange(start, end) {
  stopRange?.();
  transport.pause();
  transport.seek(Math.max(0, start), { snap: false });
  transport.play();
  const off = transport.subscribe(() => {
    if (!transport.playing) {
      off();
      if (stopRange === off) stopRange = null;
    } else if (transport.time >= end) {
      off();
      if (stopRange === off) stopRange = null;
      transport.pause();
    }
  });
  stopRange = off;
}

const DEFAULT_SILENCE = { threshold_db: -38, min_duration_ms: 700, padding_ms: 120 };
const silenceKey = (s) => `${s.clip_id}:${s.source_start}`;
const silenceCuts = (list) => list.map((s) => ({ clip_id: s.clip_id, source_start: s.source_start, source_end: s.source_end, text: '' }));
const fillerCuts = (entries) => wireCuts(entries.map((e) => ({ clip_id: e.clipId, source_start: e.srcStart, source_end: e.srcEnd, text: e.original ?? e.text })));

function ReviewRow({ checked, onToggle, time, onSeek, onPlay, children, label }) {
  return html`<li class=${cx('tr-review-row', !checked && 'off')}>
    <input type="checkbox" checked=${checked} aria-label=${label} onChange=${onToggle} />
    <button type="button" class="tr-review-main" title="Jump to this moment" onClick=${onSeek}>
      <span class="tr-review-time tnum">${time}</span>
      <span class="tr-review-text">${children}</span>
    </button>
    <${IconButton} icon="play" label="Preview" small tipPos="left" onClick=${onPlay} />
  </li>`;
}

// ---------------------------------------------------------------------------------
// Filler words
// ---------------------------------------------------------------------------------
export function FillersDialog({ model, onClose, announce }) {
  const items = useMemo(() => model.flat.filter((e) => e.filler && e.clipId), [model]);
  const [off, setOff] = useState(() => new Set());
  const [busy, setBusy] = useState(false);
  const chosen = items.filter((e) => !off.has(e.i));
  const saved = chosen.reduce((a, e) => a + (e.tlEnd - e.tl), 0);
  const toggle = (i) => {
    const next = new Set(off);
    next.has(i) ? next.delete(i) : next.add(i);
    setOff(next);
  };
  const go = async () => {
    setBusy(true);
    const change = await exec({ type: 'ripple_delete_source', cuts: fillerCuts(chosen), reason: 'filler' }, { errorTitle: 'Could not remove the filler words' });
    setBusy(false);
    if (change) {
      announce?.(`Removed ${chosen.length} filler word${chosen.length === 1 ? '' : 's'}.`);
      onClose();
    }
  };
  return html`<${Dialog}
    title="Remove filler words"
    onClose=${onClose}
    busy=${busy}
    footer=${html`<span class="grow muted tr-foot-note">${chosen.length ? `Shortens the edit by ${fmtSeconds(saved)} · one undo step` : ''}</span>
      <button type="button" class="btn" onClick=${onClose} disabled=${busy}>Cancel</button>
      <button type="button" class="btn primary" data-testid="remove-fillers" disabled=${busy || !chosen.length} onClick=${go}>
        ${busy && html`<${Spinner} />`}Remove ${chosen.length} filler${chosen.length === 1 ? '' : 's'}
      </button>`}
  >
    ${items.length === 0
      ? html`<${EmptyState} icon="check" title="No filler words found">Hesitation sounds such as “um” and “uh” are detected automatically. There are none in what is currently on the timeline.<//>`
      : html`<p class="muted tr-dialog-intro">
            Hesitation sounds found in the audible transcript. Untick any you want to keep. Each one is cut out of the video and audio and the gap is closed; the removed words stay visible in the transcript and can be restored.
          </p>
          <div class="row" style="justify-content:space-between">
            <span class="label">${items.length} found</span>
            <button type="button" class="tr-link" onClick=${() => setOff(off.size ? new Set() : new Set(items.map((e) => e.i)))}>${off.size ? 'Select all' : 'Select none'}</button>
          </div>
          <ul class="tr-review" data-testid="filler-list">
            ${items.map((e) => {
              const c = contextOf(model, e.i);
              return html`<${ReviewRow}
                key=${e.i}
                checked=${!off.has(e.i)}
                onToggle=${() => toggle(e.i)}
                label=${`Remove “${e.text}” at ${clock(e.tl, { tenths: true })}`}
                time=${clock(e.tl, { tenths: true })}
                onSeek=${() => transport.seek(e.tl)}
                onPlay=${() => playRange(e.tl - 1.2 * TPS, e.tlEnd + 1.2 * TPS)}
              >
                <span class="faint">${c.before ? `… ${c.before} ` : ''}</span><mark>${c.word}</mark><span class="faint">${c.after ? ` ${c.after} …` : ''}</span>
              <//>`;
            })}
          </ul>`}
  <//>`;
}

// ---------------------------------------------------------------------------------
// Silences
// ---------------------------------------------------------------------------------
function useSilences(opts) {
  const projectId = useStore((s) => s.doc?.id);
  const revision = useStore((s) => s.doc?.revision);
  const [state, setState] = useState({ list: null, loading: true, error: null });
  const seq = useRef(0);
  useEffect(() => {
    const mine = ++seq.current;
    setState((s) => ({ ...s, loading: true, error: null }));
    const timer = setTimeout(async () => {
      try {
        const res = await api.silences(projectId, opts);
        if (mine === seq.current) setState({ list: res.silences, loading: false, error: null });
      } catch (e) {
        if (mine === seq.current) setState({ list: null, loading: false, error: e.message });
      }
    }, 220);
    return () => clearTimeout(timer);
  }, [projectId, revision, opts.threshold_db, opts.min_duration_ms, opts.padding_ms]);
  return state;
}

function OptionRow({ label, hint, children }) {
  return html`<div class="tr-opt">
    <div>
      <div class="tr-opt-label">${label}</div>
      ${hint && html`<div class="tr-opt-hint">${hint}</div>`}
    </div>
    <div class="tr-opt-control">${children}</div>
  </div>`;
}

export function SilencesDialog({ onClose, announce }) {
  const [opts, setOpts] = useState(DEFAULT_SILENCE);
  const { list, loading, error } = useSilences(opts);
  const [off, setOff] = useState(() => new Set());
  const [busy, setBusy] = useState(false);
  const items = list || [];
  const chosen = items.filter((s) => !off.has(silenceKey(s)));
  const saved = chosen.reduce((a, s) => a + (s.end - s.start), 0);
  const set = (patch) => setOpts((o) => ({ ...o, ...patch }));
  const toggle = (k) => {
    const next = new Set(off);
    next.has(k) ? next.delete(k) : next.add(k);
    setOff(next);
  };
  const go = async () => {
    setBusy(true);
    const change = await exec({ type: 'ripple_delete_source', cuts: silenceCuts(chosen), reason: 'silence' }, { errorTitle: 'Could not remove the silences' });
    setBusy(false);
    if (change) {
      announce?.(`Removed ${chosen.length} silence${chosen.length === 1 ? '' : 's'}.`);
      onClose();
    }
  };
  return html`<${Dialog}
    title="Remove silences"
    onClose=${onClose}
    busy=${busy}
    wide
    footer=${html`<span class="grow muted tr-foot-note" role="status">${loading ? 'Analysing audio…' : chosen.length ? `Shortens the edit by ${fmtSeconds(saved)} · one undo step` : ''}</span>
      <button type="button" class="btn" onClick=${onClose} disabled=${busy}>Cancel</button>
      <button type="button" class="btn primary" data-testid="remove-silences" disabled=${busy || loading || !chosen.length} onClick=${go}>
        ${busy && html`<${Spinner} />`}Remove ${chosen.length} silence${chosen.length === 1 ? '' : 's'}
      </button>`}
  >
    <p class="muted tr-dialog-intro">Pauses are detected from the actual audio waveform of the clips on the timeline. Spoken words are protected, so a quietly spoken word is never cut.</p>
    <div class="tr-opts">
      <${OptionRow} label="Quieter than" hint="Audio below this level counts as silence">
        <${Slider} label="Silence threshold" min=${-60} max=${-12} step=${1} value=${opts.threshold_db} onInput=${(v) => set({ threshold_db: v })} resetTo=${DEFAULT_SILENCE.threshold_db} onCommit=${(v) => set({ threshold_db: v })} />
        <${NumberField} label="Silence threshold in decibels" value=${opts.threshold_db} min=${-80} max=${-6} step=${1} unit="dB" onCommit=${(v) => set({ threshold_db: v })} />
      <//>
      <${OptionRow} label="Longer than" hint="Shorter pauses are left alone">
        <${Slider} label="Minimum pause" min=${200} max=${3000} step=${50} value=${opts.min_duration_ms} onInput=${(v) => set({ min_duration_ms: v })} resetTo=${DEFAULT_SILENCE.min_duration_ms} onCommit=${(v) => set({ min_duration_ms: v })} />
        <${NumberField} label="Minimum pause in milliseconds" value=${opts.min_duration_ms} min=${100} max=${60000} step=${50} unit="ms" onCommit=${(v) => set({ min_duration_ms: v })} />
      <//>
      <${OptionRow} label="Keep around speech" hint="Breathing room left on each side">
        <${Slider} label="Padding" min=${0} max=${500} step=${10} value=${opts.padding_ms} onInput=${(v) => set({ padding_ms: v })} resetTo=${DEFAULT_SILENCE.padding_ms} onCommit=${(v) => set({ padding_ms: v })} />
        <${NumberField} label="Padding in milliseconds" value=${opts.padding_ms} min=${0} max=${2000} step=${10} unit="ms" onCommit=${(v) => set({ padding_ms: v })} />
      <//>
    </div>
    ${error && html`<${Notice} kind="error">${error}<//>`}
    ${!error &&
    html`<div class="row" style="justify-content:space-between">
        <span class="label" data-testid="silence-count">${loading && !list ? 'Analysing…' : `${items.length} silence${items.length === 1 ? '' : 's'} found`}</span>
        ${items.length > 0 && html`<button type="button" class="tr-link" onClick=${() => setOff(off.size ? new Set() : new Set(items.map(silenceKey)))}>${off.size ? 'Select all' : 'Select none'}</button>`}
      </div>
      ${list && items.length === 0
        ? html`<${EmptyState} icon="silence" title="No silences match">Try a higher “Quieter than” level or a shorter minimum length.<//>`
        : html`<ul class=${cx('tr-review', loading && 'stale')} data-testid="silence-list">
            ${items.map(
              (s) => html`<${ReviewRow}
                key=${silenceKey(s)}
                checked=${!off.has(silenceKey(s))}
                onToggle=${() => toggle(silenceKey(s))}
                label=${`Remove ${fmtSeconds(s.end - s.start)} of silence at ${clock(s.start, { tenths: true })}`}
                time=${clock(s.start, { tenths: true })}
                onSeek=${() => transport.seek(s.start)}
                onPlay=${() => playRange(s.start - 0.8 * TPS, s.end + 0.8 * TPS)}
              >
                <span class="tr-bar" style=${{ width: `${Math.min(100, ((s.end - s.start) / TPS / 4) * 100)}%` }} aria-hidden="true"></span>
                <span>${fmtSeconds(s.end - s.start)} of silence</span>
              <//>`,
            )}
          </ul>`}`}
  <//>`;
}

// ---------------------------------------------------------------------------------
// Tighten: fillers + silences in one edit
// ---------------------------------------------------------------------------------
export function TightenDialog({ model, onClose, announce }) {
  const { list, loading, error } = useSilences(DEFAULT_SILENCE);
  const [busy, setBusy] = useState(false);
  const [useFillers, setUseFillers] = useState(true);
  const [useSilence, setUseSilence] = useState(true);
  const fillers = useMemo(() => model.flat.filter((e) => e.filler && e.clipId), [model]);
  const silences = list || [];
  const cuts = [...(useFillers ? fillerCuts(fillers) : []), ...(useSilence ? silenceCuts(silences) : [])];
  const saved = (useFillers ? fillers.reduce((a, e) => a + (e.tlEnd - e.tl), 0) : 0) + (useSilence ? silences.reduce((a, s) => a + (s.end - s.start), 0) : 0);
  const go = async () => {
    setBusy(true);
    const change = await exec({ type: 'ripple_delete_source', cuts, reason: 'rough_cut' }, { errorTitle: 'Could not tighten the edit' });
    setBusy(false);
    if (change) {
      announce?.(`Tightened the edit: ${cuts.length} cuts.`);
      onClose();
    }
  };
  return html`<${Dialog}
    title="Tighten the edit"
    onClose=${onClose}
    busy=${busy}
    footer=${html`<span class="grow muted tr-foot-note">${cuts.length ? `Saves about ${fmtSeconds(saved)} · one undo step` : ''}</span>
      <button type="button" class="btn" onClick=${onClose} disabled=${busy}>Cancel</button>
      <button type="button" class="btn primary" data-testid="tighten-go" disabled=${busy || loading || !cuts.length} onClick=${go}>${busy && html`<${Spinner} />`}Tighten</button>`}
  >
    <p class="muted tr-dialog-intro">A quick rough cut: removes hesitation sounds and long pauses in a single edit. Everything removed stays listed in the transcript and can be restored piece by piece.</p>
    ${error && html`<${Notice} kind="error">${error}<//>`}
    <div class="tr-tighten">
      <${Switch} checked=${useFillers} onChange=${setUseFillers} label=${`${fillers.length} filler word${fillers.length === 1 ? '' : 's'}`} />
      <${Switch} checked=${useSilence} onChange=${setUseSilence} label=${loading ? 'Finding pauses…' : `${silences.length} pause${silences.length === 1 ? '' : 's'} longer than ${DEFAULT_SILENCE.min_duration_ms / 1000} s`} />
    </div>
  <//>`;
}

// ---------------------------------------------------------------------------------
// Captions
// ---------------------------------------------------------------------------------
const CAPTION_DEFAULTS = { max_chars_per_line: 36, max_lines: 2, max_duration_ms: 5000, pause_break_ms: 800, speaker_labels: false, skip_fillers: true };

export function CaptionLinks({ projectId }) {
  return html`<span class="row" style="gap:6px">
    <a class="btn small" href=${`/api/projects/${projectId}/captions.srt`} download data-testid="download-srt"><${Icon} name="download" size=${13} /> .srt</a>
    <a class="btn small" href=${`/api/projects/${projectId}/captions.vtt`} download data-testid="download-vtt"><${Icon} name="download" size=${13} /> .vtt</a>
  </span>`;
}

export function CaptionsDialog({ onClose, announce }) {
  const [o, setO] = useState(CAPTION_DEFAULTS);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(null);
  const projectId = useStore((s) => s.doc?.id);
  const existing = useStore((s) => {
    let generated = 0;
    let edited = 0;
    for (const c of s.doc.clips.values()) if (c.content.kind === 'caption') c.content.generated ? generated++ : edited++;
    return { generated, edited };
  });
  const set = (patch) => setO((x) => ({ ...x, ...patch }));
  const go = async () => {
    setBusy(true);
    const change = await exec({ type: 'generate_captions', options: o }, { errorTitle: 'Could not generate captions' });
    setBusy(false);
    if (change) {
      const doc = store.state.doc;
      let n = 0;
      for (const c of doc.clips.values()) if (c.content.kind === 'caption' && c.content.generated) n++;
      const track = doc.tracks.find((t) => t.kind === 'caption');
      setDone({ n, track: track?.name || 'the caption track' });
      announce?.(`Generated ${n} captions.`);
    }
  };
  if (done)
    // keyed so the dialog remounts: the "Generate" button that had focus is gone, and
    // without a new focus target Escape / Enter would no longer reach the dialog
    return html`<${Dialog} key="done" title="Captions generated" onClose=${onClose} initialFocus=".dialog-foot .btn.primary" footer=${html`<button type="button" class="btn primary" onClick=${onClose}>Done</button>`}>
      <${Notice} kind="info" icon="captions"><strong>${done.n} caption${done.n === 1 ? '' : 's'}</strong> were placed on track ${done.track} at the top of the timeline. Select a caption there to edit its text or timing; the look of all captions is set in the Inspector when nothing is selected.<//>
      <div class="row" style="justify-content:space-between">
        <span class="muted">Download as a subtitle file</span>
        <${CaptionLinks} projectId=${projectId} />
      </div>
      <p class="faint tr-dialog-intro">Captions are burned into the exported video when “Burn captions into the video” is on in the Export dialog.</p>
    <//>`;
  return html`<${Dialog}
    key="form"
    title="Generate captions"
    onClose=${onClose}
    busy=${busy}
    footer=${html`<button type="button" class="btn" onClick=${onClose} disabled=${busy}>Cancel</button>
      <button type="button" class="btn primary" data-testid="generate-captions-go" disabled=${busy} onClick=${go}>${busy && html`<${Spinner} />`}Generate captions</button>`}
  >
    <p class="muted tr-dialog-intro">Builds captions from the words that are audible in the current edit, using your corrections and speaker names. Timing follows the timeline, including cuts and speed changes.</p>
    <div class="tr-opts">
      <${OptionRow} label="Characters per line">
        <${Slider} label="Characters per line" min=${16} max=${60} step=${1} value=${o.max_chars_per_line} onInput=${(v) => set({ max_chars_per_line: v })} onCommit=${(v) => set({ max_chars_per_line: v })} resetTo=${36} />
        <${NumberField} label="Characters per line" value=${o.max_chars_per_line} min=${8} max=${80} onCommit=${(v) => set({ max_chars_per_line: Math.round(v) })} />
      <//>
      <${OptionRow} label="Lines per caption">
        <div class="seg" role="radiogroup" aria-label="Lines per caption">
          ${[1, 2, 3].map((n) => html`<button type="button" role="radio" aria-checked=${String(o.max_lines === n)} onClick=${() => set({ max_lines: n })}>${n}</button>`)}
        </div>
      <//>
      <${OptionRow} label="Longest caption" hint="Maximum time on screen">
        <${Slider} label="Longest caption" min=${1000} max=${10000} step=${250} value=${o.max_duration_ms} onInput=${(v) => set({ max_duration_ms: v })} onCommit=${(v) => set({ max_duration_ms: v })} resetTo=${5000} />
        <${NumberField} label="Longest caption in seconds" value=${o.max_duration_ms / 1000} min=${0.5} max=${20} step=${0.25} precision=${2} unit="s" onCommit=${(v) => set({ max_duration_ms: Math.round(v * 1000) })} />
      <//>
    </div>
    <div class="tr-tighten">
      <${Switch} checked=${o.speaker_labels} onChange=${(v) => set({ speaker_labels: v })} label="Start each speaker turn with the speaker name" />
      <${Switch} checked=${o.skip_fillers} onChange=${(v) => set({ skip_fillers: v })} label="Leave filler words (um, uh…) out" />
    </div>
    ${(existing.generated > 0 || existing.edited > 0) &&
    html`<${Notice} kind="warning">
      ${existing.generated > 0 && html`The ${existing.generated} previously generated caption${existing.generated === 1 ? '' : 's'} will be replaced. `}
      ${existing.edited > 0 && html`Your ${existing.edited} hand-edited caption${existing.edited === 1 ? ' is' : 's are'} kept (new captions overwrite them only where they overlap).`}
    <//>`}
  <//>`;
}
