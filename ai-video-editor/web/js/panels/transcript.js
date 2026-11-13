// Transcript panel: transcript-based editing.
//
// The words shown in "Timeline" mode are the server-derived timeline transcript
// (crates/core/src/mapping.rs) — exactly what is audible in the current edit.
// Deleting words issues a `ripple_delete_source` command against the source ranges
// of those words; the result is an ordinary, undoable timeline edit and the removed
// words stay visible (struck through, with the reason) until restored.

import { html, useEffect, useMemo, useRef, useState, useStore, cx, Icon, IconButton, Spinner, Notice, EmptyState, Segmented, openMenu, MOD } from '../lib/ui.js';
import { exec, enableTranscriptEditing, refreshTranscript, transcriptionAction } from '../state/actions.js';
import { store } from '../state/store.js';
import { transport } from '../player/transport.js';
import { buildTimelineModel, cutsDuration, cutsForRange, fmtSeconds, wireCuts } from './transcript-model.js';
import { WordList } from './transcript-words.js';
import { CorrectionEditor, SearchBar, correctWord, useSearch } from './transcript-shared.js';
import { CaptionLinks, CaptionsDialog, FillersDialog, SilencesDialog, TightenDialog, playRange } from './transcript-tools.js';
import { SourceMode } from './transcript-source.js';

const INSTRUCTIONS_ID = 'transcript-help';

// ---------------------------------------------------------------------------------
// Gate
// ---------------------------------------------------------------------------------
function Gate() {
  const health = useStore((s) => s.health);
  const audioAssets = useStore((s) => {
    let n = 0;
    for (const a of s.doc.assets.values()) if (a.has_audio) n++;
    return n;
  });
  const [busy, setBusy] = useState(false);
  const fixture = !!health?.fixture;
  const configured = health?.speech?.configured !== false;
  const model = health?.speech?.model || 'stt-async-v5';
  const enable = async () => {
    setBusy(true);
    await enableTranscriptEditing();
    setBusy(false);
  };
  // The explanation scrolls; the call to action stays pinned so it is never below the
  // fold of a short panel.
  return html`<div class="tr-gate">
    <div class="tr-gate-scroll">
      <div class="tr-gate-head">
        <div class="tr-gate-art" aria-hidden="true"><${Icon} name="mic" /></div>
        <h3>Edit video by editing text</h3>
      </div>
      <p class="muted">
        Cutline transcribes the speech in your media. Click a word to jump to it, search for exact moments, and delete words, filler sounds or pauses — every removal becomes a normal, undoable cut on the timeline.
      </p>
      <ul class="tr-gate-list">
        <li><${Icon} name="search" /> Searchable, synchronized transcript with speaker labels</li>
        <li><${Icon} name="scissors" /> Remove words, fillers and silences as ripple edits</li>
        <li><${Icon} name="captions" /> Captions and rough cuts straight from the text</li>
      </ul>
      ${fixture
        ? html`<${Notice} kind="warning" icon="info">
            <strong>Fixture mode.</strong> Transcripts are deterministic, clearly labelled synthetic data — not real speech recognition. Nothing leaves this machine.
          <//>`
        : html`<${Notice} kind=${configured ? 'info' : 'warning'}>
            ${configured
              ? html`When you enable this, the audio of this project's media is uploaded to <strong>Soniox</strong> (model ${model}) for transcription with speaker diarization and language identification. The uploaded files are deleted from Soniox as soon as each transcript has been fetched.`
              : html`<strong>SONIOX_API_KEY is not set on the server.</strong> You can still enable transcript editing, but transcription will fail with that message until the key is added to <code>.env</code> and the server is restarted (or the server is started with <code>--fixture</code>).`}
          <//>`}
      <p id="tr-gate-foot" class="faint tr-gate-foot">${audioAssets ? `${audioAssets} media file${audioAssets === 1 ? '' : 's'} with audio will be transcribed. Media you import later is transcribed automatically.` : 'Import media with audio first, or enable now and it will be transcribed on import.'}</p>
    </div>
    <div class="tr-gate-cta">
      <button type="button" class="btn primary large" data-testid="enable-transcript" aria-describedby="tr-gate-foot" onClick=${enable} disabled=${busy}>
        ${busy ? html`<${Spinner} />` : html`<${Icon} name="mic" />`} Enable transcript editing
      </button>
    </div>
  </div>`;
}

// ---------------------------------------------------------------------------------
// Transcription jobs
// ---------------------------------------------------------------------------------
function jobOf(rec) {
  const t = rec.transcription;
  if (!t) {
    if (rec.state === 'failed') return { kind: 'failed', label: 'Audio unavailable', detail: rec.error || 'The audio of this file could not be prepared.', action: null };
    if (!rec.speech) return { kind: 'preparing', label: 'Preparing audio…', detail: 'Extracting the audio track before it can be transcribed.', active: true, action: null };
    return { kind: 'idle', label: 'Not started', detail: null, action: 'start' };
  }
  const fx = t.fixture ? ' (fixture)' : '';
  switch (t.state) {
    case 'queued':
      return { kind: 'queued', label: 'Queued', detail: t.message || 'Waiting for a free transcription slot.', active: true, action: 'cancel' };
    case 'uploading':
      return { kind: 'uploading', label: `Uploading audio${fx}…`, detail: t.message, active: true, action: 'cancel' };
    case 'processing':
      return { kind: 'processing', label: `Transcribing${fx}…`, detail: t.message, active: true, action: 'cancel' };
    case 'completed':
      return { kind: 'completed', label: t.word_count ? `${t.word_count.toLocaleString()} words${fx}` : 'No speech detected', detail: t.message && !t.word_count ? t.message : null, action: null };
    case 'failed':
      return { kind: 'failed', label: 'Failed', detail: t.message || 'The transcription failed.', retryable: !!t.retryable, action: 'retry' };
    case 'cancelled':
      return { kind: 'cancelled', label: 'Cancelled', detail: null, action: 'retry', actionLabel: 'Start again' };
    default:
      return { kind: 'idle', label: t.state, detail: t.message, action: null };
  }
}

const JOB_ICON = { completed: 'check', failed: 'alert', cancelled: 'x', idle: 'clock' };

function JobStrip() {
  const assets = useStore((s) => s.assets);
  const docAssets = useStore((s) => s.doc.assets);
  const [open, setOpen] = useState(null); // null = automatic
  const rows = useMemo(() => {
    const out = [];
    for (const rec of assets.values()) {
      const info = docAssets.get(rec.id);
      if (info?.has_audio) out.push({ rec, job: jobOf(rec) });
    }
    return out.sort((a, b) => a.rec.created_at_ms - b.rec.created_at_ms);
  }, [assets, docAssets]);
  if (!rows.length) return null;
  const done = rows.filter((r) => r.job.kind === 'completed').length;
  const active = rows.some((r) => r.job.active);
  const failed = rows.filter((r) => r.job.kind === 'failed').length;
  const allDone = done === rows.length;
  const expanded = open ?? !allDone;
  return html`<section class=${cx('tr-jobs', failed && 'has-failed')} aria-label="Transcription status">
    <button type="button" class="tr-jobs-head" aria-expanded=${String(expanded)} onClick=${() => setOpen(!expanded)} data-testid="transcription-summary">
      ${active ? html`<${Spinner} label="Transcribing" />` : html`<${Icon} name=${failed ? 'alert' : allDone ? 'check' : 'clock'} class=${failed ? 'bad' : allDone ? 'ok' : ''} />`}
      <span class="grow">${done} of ${rows.length} transcribed${failed ? ` · ${failed} failed` : ''}</span>
      <${Icon} name="chevron-down" class="chev" size=${12} />
    </button>
    ${expanded &&
    html`<ul class="tr-jobs-list">
      ${rows.map(
        ({ rec, job }) => html`<li key=${rec.id} class=${cx('tr-job', job.kind)} data-testid="transcription-job" data-state=${job.kind}>
          <span class="tr-job-icon">${job.active ? html`<${Spinner} label=${job.label} />` : html`<${Icon} name=${JOB_ICON[job.kind] || 'dot'} />`}</span>
          <div class="grow" style="min-width:0">
            <div class="tr-job-name truncate" title=${rec.name}>${rec.name}</div>
            <div class="tr-job-state">${job.label}${job.retryable ? ' · temporary problem' : ''}</div>
            ${job.detail && html`<div class="tr-job-detail" role=${job.kind === 'failed' ? 'alert' : undefined}>${job.detail}</div>`}
          </div>
          ${job.action === 'cancel' && html`<button type="button" class="btn small ghost" onClick=${() => transcriptionAction(rec.id, 'cancel')}>Cancel</button>`}
          ${job.action === 'retry' && html`<button type="button" class=${cx('btn small', job.retryable && 'primary')} onClick=${() => transcriptionAction(rec.id, 'retry')}><${Icon} name="refresh" size=${13} /> ${job.actionLabel || 'Retry'}</button>`}
          ${job.action === 'start' && html`<button type="button" class="btn small" onClick=${() => transcriptionAction(rec.id, 'start')}>Transcribe</button>`}
        </li>`,
      )}
    </ul>`}
  </section>`;
}

// ---------------------------------------------------------------------------------
// Timeline mode
// ---------------------------------------------------------------------------------
function Skeleton() {
  return html`<div class="tr-skeleton" role="status" aria-label="Loading transcript">
    ${[0, 1, 2].map(
      (p) => html`<div class="tr-skel-para">
        <i style="width:28%"></i>
        ${[96, 88, 93, 61].map((w, i) => html`<b style=${{ width: `${w - p * 4 - i}%` }}></b>`)}
      </div>`,
    )}
  </div>`;
}

function TimelineMode({ model, stale, announce, onOpenTool }) {
  const doc = useStore((s) => s.doc);
  const tr = useStore((s) => s.transcript);
  const assets = useStore((s) => s.assets);
  const listApi = useRef(null);
  const scrollRef = useRef(null);
  const wrapRef = useRef(null);
  const searchRef = useRef(null);
  const [sel, setSel] = useState(null);
  const [editing, setEditing] = useState(null);
  const [busy, setBusy] = useState(false);
  const search = useSearch(model, listApi, announce);
  const view = tr.view;

  useEffect(() => {
    setEditing(null);
  }, [model]);

  const selCuts = useMemo(() => (sel ? cutsForRange(model, sel.lo, sel.hi) : []), [sel, model]);
  const single = sel && sel.lo === sel.hi ? model.flat[sel.lo] : null;

  const deleteSel = async () => {
    const r = listApi.current?.getSelection();
    if (!r || busy) return;
    if (stale) return announce('The transcript is updating — try again in a moment.');
    const cuts = cutsForRange(model, r.lo, r.hi);
    const n = r.hi - r.lo + 1;
    const dur = cutsDuration(cuts);
    setBusy(true);
    const change = await exec({ type: 'ripple_delete_source', cuts: wireCuts(cuts), reason: 'manual' }, { errorTitle: 'Could not remove the selected words' });
    setBusy(false);
    if (change) announce(`Removed ${n} word${n === 1 ? '' : 's'} (${fmtSeconds(dur)}) from the timeline. Undo with ${MOD}+Z or use Restore in the transcript.`);
    listApi.current?.focus();
  };
  const playSel = () => {
    const r = listApi.current?.getSelection();
    if (!r) return;
    playRange(model.flat[r.lo].tl, model.flat[r.hi].tlEnd);
  };
  const startCorrect = (i) => {
    if (i >= 0 && i < model.flat.length) setEditing(model.flat[i]);
  };
  const onContext = (e, i) => {
    const entry = model.flat[i];
    const r = listApi.current.getSelection();
    const inSel = r && i >= r.lo && i <= r.hi;
    const n = inSel ? r.hi - r.lo + 1 : 1;
    openMenu(e, [
      { label: 'Play from here', icon: 'play', onSelect: () => (transport.seek(entry.tl, { snap: false }), transport.play()) },
      inSel && n > 1 && { label: 'Play selection', icon: 'play', onSelect: playSel },
      { separator: true },
      { label: 'Correct word…', icon: 'pencil', hint: 'Enter', disabled: n > 1, onSelect: () => startCorrect(i) },
      entry.original != null && { label: `Revert to “${entry.original}”`, icon: 'restore', disabled: n > 1, onSelect: () => correctWord(entry, null) },
      { separator: true },
      {
        label: n > 1 ? `Delete ${n} words` : `Delete “${entry.text}”`,
        icon: 'trash',
        danger: true,
        hint: 'Del',
        disabled: stale,
        onSelect: () => {
          if (!inSel) listApi.current.setSelection(i, i);
          deleteSel();
        },
      },
    ]);
  };

  // ---- body states ------------------------------------------------------------------
  const waiting = (view?.untranscribed_assets || []).map((id) => assets.get(id)).filter(Boolean);
  let body;
  if (!view && tr.error) {
    body = html`<div class="tr-pad"><${Notice} kind="error" action=${html`<button type="button" class="btn small" onClick=${refreshTranscript}><${Icon} name="refresh" size=${13} /> Retry</button>`}><strong>The transcript could not be loaded.</strong> ${tr.error}<//></div>`;
  } else if (!view) {
    body = html`<${Skeleton} />`;
  } else if (!model.flat.length && !model.blocks.length) {
    const hasAudioClip = [...doc.clips.values()].some((c) => c.content.kind === 'audio');
    body = waiting.length
      ? html`<${EmptyState} icon="clock" title="Waiting for the transcript">Speech from ${waiting.map((a) => `“${a.name}”`).join(', ')} is on the timeline but has not been transcribed yet. The words appear here as soon as transcription finishes.<//>`
      : doc.clips.size === 0
        ? html`<${EmptyState} icon="film" title="The timeline is empty">Add a clip with speech to the timeline and its words show up here. Or switch to <strong>Source</strong> to build a rough cut directly from a transcript.<//>`
        : !hasAudioClip
          ? html`<${EmptyState} icon="mute" title="No audio on the timeline">The transcript follows what can be heard. Add a clip that has an audio track.<//>`
          : html`<${EmptyState} icon="mute" title="No audible speech">Nothing spoken can be heard in the current edit. Check that the audio tracks are not muted and the clips are enabled — or the media may simply contain no speech.<//>`;
  } else {
    body = html`
      ${tr.error && html`<div class="tr-pad"><${Notice} kind="error" action=${html`<button type="button" class="btn small" onClick=${refreshTranscript}>Retry</button>`}>The transcript could not be refreshed: ${tr.error}<//></div>`}
      ${waiting.length > 0 &&
      html`<div class="tr-waiting" role="status"><${Spinner} label="Waiting" /> Waiting for the transcript of ${waiting.map((a) => `“${a.name}”`).join(', ')}…</div>`}
      <${WordList}
        model=${model}
        scrollRef=${scrollRef}
        api=${listApi}
        hits=${search.hits}
        activeHit=${search.active}
        label="Transcript of the timeline"
        describedBy=${INSTRUCTIONS_ID}
        announce=${announce}
        onWordClick=${(e) => transport.seek(e.tl, { snap: false })}
        onSelection=${(r) => setSel((cur) => (cur?.lo === r?.lo && cur?.hi === r?.hi ? cur : r))}
        onActivate=${startCorrect}
        onDelete=${deleteSel}
        onContext=${onContext}
        onFind=${() => searchRef.current?.focus()}
        onRename=${(para, name) => exec({ type: 'rename_speaker', asset_id: para.assetId, speaker: para.speaker, name: name || null }, { errorTitle: 'Could not rename the speaker' })}
        onRestore=${(gap) => exec({ type: 'heal_cuts', left_clip_ids: gap.heal_clip_ids }, { errorTitle: 'Could not restore the removed media' }).then((c) => c && announce('Restored the removed media.'))}
        onSeekTime=${(t) => transport.seek(t, { snap: false })}
      />
      ${!model.flat.length && html`<p class="tr-allgone muted">Every word has been removed from the edit. Use Restore above to bring passages back.</p>`}
      ${editing &&
      html`<${CorrectionEditor}
        key=${editing.i}
        entry=${editing}
        listApi=${listApi}
        wrapRef=${wrapRef}
        onClose=${() => {
          setEditing(null);
          listApi.current?.focus();
        }}
      />`}
    `;
  }

  const hasWords = model.flat.length > 0;
  return html`
    ${(hasWords || search.query) && html`<${SearchBar} search=${search} inputRef=${searchRef} />`}
    ${view &&
    (hasWords || model.blocks.length > 0) &&
    html`<div class="tr-info">
      ${model.fixture && html`<span class="badge fixture" data-testid="fixture-transcript" title="Deterministic synthetic transcript, not real speech recognition">Fixture transcript</span>`}
      <span class="tnum">${view.word_count.toLocaleString()} words</span>
      ${view.filler_count > 0 &&
      html`<button type="button" class="tr-chip f" title="Review and remove filler words" onClick=${() => onOpenTool('fillers')}>${view.filler_count} filler${view.filler_count === 1 ? '' : 's'}</button>`}
      ${model.removedWords > 0 && html`<span class="tr-chip r" data-testid="removed-count" title="Words cut out of the edit by transcript edits; shown struck through where they were removed">${model.removedWords} removed</span>`}
      ${model.skippedWords > 0 && html`<span class="tr-chip k" title="Source words between two back-to-back clips of the same media that the edit skips">${model.skippedWords} skipped</span>`}
      ${view.corrected_count > 0 &&
      html`<span class="tr-chip c" role="note" data-testid="corrected-note" title=${`Words you corrected by hand. The original ${model.fixture ? 'fixture' : 'Soniox'} tokens and timing are preserved; right-click a corrected word to revert it.`}>
        <${Icon} name="pencil" size=${10} /> ${view.corrected_count} corrected
      </span>`}
      ${stale && html`<span class="tr-updating" role="status"><${Spinner} label="Updating transcript" /></span>`}
    </div>`}
    <div class="tr-scroll" ref=${scrollRef}>
      <div class="tr-wrap" ref=${wrapRef}>${body}</div>
    </div>
    ${sel &&
    hasWords &&
    html`<div class="tr-actionbar" role="toolbar" aria-label="Selected words">
      <span class="tr-sel-info tnum" data-testid="selection-info"><strong>${sel.hi - sel.lo + 1} word${sel.hi === sel.lo ? '' : 's'}</strong> · ${fmtSeconds(cutsDuration(selCuts))}</span>
      <span class="grow"></span>
      <${IconButton} icon="play" label="Play selection" onClick=${playSel} tipPos="top" />
      ${single && html`<button type="button" class="btn small" data-testid="correct-word" onClick=${() => startCorrect(single.i)}><${Icon} name="pencil" size=${13} /> Correct</button>`}
      ${single?.original != null && html`<button type="button" class="btn small" data-testid="revert-word" title=${`Original: “${single.original}”`} onClick=${() => correctWord(single, null)}><${Icon} name="restore" size=${13} /> Revert</button>`}
      <button type="button" class="btn small danger" data-testid="delete-words" disabled=${busy || stale} onClick=${deleteSel} title="Remove from the timeline and close the gap (Delete)">
        ${busy ? html`<${Spinner} />` : html`<${Icon} name="trash" size=${13} />`} Delete
      </button>
    </div>`}
  `;
}

// ---------------------------------------------------------------------------------
// Panel
// ---------------------------------------------------------------------------------
export function TranscriptPanel() {
  const enabled = useStore((s) => !!s.doc?.transcript.enabled);
  if (!enabled) return html`<div class="tr-root"><${Gate} /></div>`;
  return html`<${Enabled} />`;
}

function Enabled() {
  const doc = useStore((s) => s.doc);
  const tr = useStore((s) => s.transcript);
  const hasTranscripts = useStore((s) => {
    for (const a of s.assets.values()) if (a.has_transcript && s.doc.assets.has(a.id)) return true;
    return false;
  });
  const hasCaptions = useStore((s) => {
    for (const c of s.doc.clips.values()) if (c.content.kind === 'caption') return true;
    return false;
  });
  const [mode, setMode] = useState('timeline');
  const [tool, setTool] = useState(null);
  const [message, setMessage] = useState('');
  const announce = useRef((m) => setMessage((cur) => (cur === m ? `${m} ` : m))).current;

  const stale = !!tr.view && tr.view.revision !== doc.revision;
  useEffect(() => {
    // The view is derived on the server from the document revision we hold. Edits
    // already trigger a refresh (state/actions.js); this is the safety net for a
    // missing or outdated view (panel opened later, refresh skipped, …).
    if (tr.view && tr.view.revision === doc.revision) return undefined;
    if (tr.loading || tr.error) return undefined;
    const timer = setTimeout(
      () => {
        const s = store.state;
        if (s.doc && !s.transcript.loading && (!s.transcript.view || s.transcript.view.revision !== s.doc.revision)) refreshTranscript();
      },
      tr.view ? 400 : 0,
    );
    return () => clearTimeout(timer);
  }, [doc.revision, tr.view, tr.loading, tr.error]);

  const model = useMemo(() => buildTimelineModel(tr.view, doc), [tr.view, doc.transcript.speaker_names]);
  const hasWords = model.flat.length > 0;

  const cleanMenu = (e) =>
    openMenu(e.currentTarget, [
      { heading: 'Clean up speech' },
      { label: 'Remove filler words…', icon: 'wand', hint: model.fillers ? String(model.fillers) : '', disabled: !hasWords, onSelect: () => setTool('fillers') },
      { label: 'Remove silences…', icon: 'silence', disabled: doc.clips.size === 0, onSelect: () => setTool('silences') },
      { label: 'Tighten (fillers + pauses)…', icon: 'bolt', disabled: doc.clips.size === 0, onSelect: () => setTool('tighten') },
    ]);
  const moreMenu = (e) =>
    openMenu(e.currentTarget, [
      { label: 'Download captions (.srt)', icon: 'download', disabled: !hasCaptions, onSelect: () => window.open(`/api/projects/${doc.id}/captions.srt`, '_self') },
      { label: 'Download captions (.vtt)', icon: 'download', disabled: !hasCaptions, onSelect: () => window.open(`/api/projects/${doc.id}/captions.vtt`, '_self') },
      { separator: true },
      { label: 'Refresh transcript', icon: 'refresh', onSelect: refreshTranscript },
      { label: 'Turn off transcript editing', icon: 'x', onSelect: () => exec({ type: 'set_transcript_editing', enabled: false }) },
    ]);

  return html`<div class="tr-root" data-testid="transcript-panel">
    <div class="tr-toolbar">
      <${Segmented}
        label="Transcript mode"
        value=${mode}
        onChange=${setMode}
        options=${[
          { value: 'timeline', label: 'Timeline', title: 'What is audible in the edit' },
          { value: 'source', label: 'Source', title: 'Full transcript of one media file, for rough cuts' },
        ]}
      />
      <span class="grow"></span>
      ${mode === 'timeline' &&
      html`<button type="button" class="btn small ghost tr-cleanup" data-testid="cleanup-menu" aria-haspopup="menu" aria-label="Clean up" title="Remove filler words and silences" onClick=${cleanMenu} disabled=${!hasTranscripts}>
          <${Icon} name="wand" size=${14} /><span class="tr-cleanup-label">Clean up</span><${Icon} name="chevron-down" size=${11} />
        </button>
        <${IconButton} icon="captions" label="Generate captions…" data-testid="captions-button" disabled=${!hasWords} onClick=${() => setTool('captions')} tipPos="left" />`}
      <${IconButton} icon="more" label="More transcript options" aria-haspopup="menu" onClick=${moreMenu} tipPos="left" />
    </div>
    <${JobStrip} />
    ${mode === 'timeline' ? html`<${TimelineMode} model=${model} stale=${stale} announce=${announce} onOpenTool=${setTool} />` : html`<${SourceMode} announce=${announce} />`}
    <p id=${INSTRUCTIONS_ID} class="sr-only">
      Click a word to move the playhead there. Drag across words or hold Shift and use the arrow keys to select a range. Press Delete to remove the selection from the timeline, Enter to correct a word, ${MOD} F to search.
    </p>
    <div class="sr-only" role="status" aria-live="polite" data-testid="transcript-live">${message}</div>
    ${tool === 'fillers' && html`<${FillersDialog} model=${model} announce=${announce} onClose=${() => setTool(null)} />`}
    ${tool === 'silences' && html`<${SilencesDialog} announce=${announce} onClose=${() => setTool(null)} />`}
    ${tool === 'tighten' && html`<${TightenDialog} model=${model} announce=${announce} onClose=${() => setTool(null)} />`}
    ${tool === 'captions' && html`<${CaptionsDialog} announce=${announce} onClose=${() => setTool(null)} />`}
  </div>`;
}

export { CaptionLinks };
