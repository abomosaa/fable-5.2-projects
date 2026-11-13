// Source mode: the full transcript of one media file, for transcript-based rough
// cuts. Select passages, collect them in order, and add them to the timeline as
// linked video + audio clips (`append_source_ranges`).

import { html, useEffect, useMemo, useRef, useState, useStore, cx, Icon, IconButton, Spinner, Notice, EmptyState, openMenu } from '../lib/ui.js';
import { api } from '../lib/api.js';
import { clock, TPS } from '../lib/time.js';
import { exec } from '../state/actions.js';
import { transport } from '../player/transport.js';
import { buildSourceModel, fmtSeconds } from './transcript-model.js';
import { WordList } from './transcript-words.js';
import { CorrectionEditor, SearchBar, correctWord, useSearch } from './transcript-shared.js';
import { playRange } from './transcript-tools.js';

// transcripts are immutable per asset: fetch once per session
const cache = new Map();
function loadTranscript(assetId) {
  let hit = cache.get(assetId);
  if (!hit) {
    hit = api.assetTranscript(assetId);
    cache.set(assetId, hit);
    hit.catch(() => cache.delete(assetId));
  }
  return hit;
}

const LEAD_IN = 0.08 * TPS;
const TAIL = 0.2 * TPS;

/** Source range for words lo..hi with a little breathing room that never reaches the neighbouring words. */
function rangeOf(model, lo, hi, assetDuration) {
  const flat = model.flat;
  const prevEnd = lo > 0 ? flat[lo - 1].srcEnd : 0;
  const nextStart = hi + 1 < flat.length ? flat[hi + 1].srcStart : assetDuration;
  const start = Math.max(0, Math.max(prevEnd, flat[lo].srcStart - LEAD_IN), 0);
  const end = Math.min(assetDuration, Math.max(flat[hi].srcEnd, Math.min(nextStart, flat[hi].srcEnd + TAIL)));
  return { start: Math.round(Math.min(start, flat[lo].srcStart)), end: Math.round(end) };
}

const preview = (model, lo, hi) => {
  const words = model.flat.slice(lo, hi + 1).map((e) => e.text);
  return words.length > 12 ? `${words.slice(0, 6).join(' ')} … ${words.slice(-5).join(' ')}` : words.join(' ');
};

export function SourceMode({ announce }) {
  const doc = useStore((s) => s.doc);
  const assets = useStore((s) => s.assets);
  const options = useMemo(() => [...assets.values()].filter((a) => a.has_transcript && doc.assets.has(a.id)).sort((a, b) => a.created_at_ms - b.created_at_ms), [assets, doc.assets]);
  const [assetId, setAssetId] = useState(null);
  const current = options.find((a) => a.id === assetId) || options[0] || null;
  const id = current?.id || null;
  const [load, setLoad] = useState({ id: null, data: null, error: null });
  const [basket, setBasket] = useState([]);
  const [sel, setSel] = useState(null);
  const [editing, setEditing] = useState(null);
  const [busy, setBusy] = useState(false);
  const listApi = useRef(null);
  const scrollRef = useRef(null);
  const wrapRef = useRef(null);
  const searchRef = useRef(null);
  const seq = useRef(1);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    setBasket([]);
    if (!id) return;
    let alive = true;
    setLoad({ id, data: null, error: null });
    loadTranscript(id).then(
      (data) => alive && setLoad({ id, data, error: null }),
      (e) => alive && setLoad({ id, data: null, error: e.message }),
    );
    return () => {
      alive = false;
    };
  }, [id, attempt]);

  const data = load.id === id ? load.data : null;
  const model = useMemo(() => buildSourceModel(data, doc, id), [data, doc.clips, doc.transcript, id]);
  const search = useSearch(model, listApi, announce);
  const duration = doc.assets.get(id)?.duration || 0;

  useEffect(() => setEditing(null), [model]);

  const selRange = sel ? rangeOf(model, sel.lo, sel.hi, duration) : null;
  const addToBasket = () => {
    const r = listApi.current?.getSelection();
    if (!r) return;
    const range = rangeOf(model, r.lo, r.hi, duration);
    setBasket((b) => [...b, { key: seq.current++, ...range, text: preview(model, r.lo, r.hi), words: r.hi - r.lo + 1 }]);
    listApi.current.clearSelection();
    announce(`Added ${r.hi - r.lo + 1} words to the rough cut list.`);
  };
  const move = (i, d) =>
    setBasket((b) => {
      const j = i + d;
      if (j < 0 || j >= b.length) return b;
      const n = [...b];
      [n[i], n[j]] = [n[j], n[i]];
      return n;
    });
  /** Send the basket (or, when it is empty, the current selection) to the timeline. */
  const send = async (atPlayhead) => {
    let ranges = basket.map(({ start, end }) => ({ start, end }));
    if (!ranges.length && selRange) ranges = [selRange];
    if (!ranges.length || busy) return;
    setBusy(true);
    const change = await exec({ type: 'append_source_ranges', asset_id: id, ranges, at: atPlayhead ? transport.frameTime : null }, { errorTitle: 'Could not add the passages to the timeline' });
    setBusy(false);
    if (change) {
      setBasket([]);
      listApi.current?.clearSelection();
      announce(`Added ${ranges.length} passage${ranges.length === 1 ? '' : 's'} to the timeline.`);
    }
  };

  const onContext = (e, i) => {
    const entry = model.flat[i];
    const r = listApi.current.getSelection();
    const inSel = r && i >= r.lo && i <= r.hi;
    openMenu(e, [
      { label: 'Jump to it on the timeline', icon: 'play', disabled: entry.tl == null, onSelect: () => transport.seek(entry.tl, { snap: false }) },
      { separator: true },
      { label: 'Add selection to rough cut list', icon: 'plus', disabled: !inSel, onSelect: addToBasket },
      { label: 'Add selection to timeline', icon: 'film', disabled: !inSel, onSelect: () => send(false) },
      { separator: true },
      { label: 'Correct word…', icon: 'pencil', hint: 'Enter', disabled: inSel && r.hi > r.lo, onSelect: () => setEditing(entry) },
      entry.original != null && { label: `Revert to “${entry.original}”`, icon: 'restore', onSelect: () => correctWord(entry, null) },
    ]);
  };

  if (!options.length)
    return html`<div class="tr-scroll">
      <${EmptyState} icon="mic" title="No transcripts yet">Source mode shows the complete transcript of one media file so you can pick the passages you want. It becomes available as soon as a transcription has finished.<//>
    </div>`;

  const total = basket.reduce((a, b) => a + (b.end - b.start), 0);
  return html`
    <div class="tr-source-head">
      <label class="sr-only" for="tr-source-asset">Media file</label>
      <select id="tr-source-asset" class="select" data-testid="source-asset" value=${id} onChange=${(e) => setAssetId(e.currentTarget.value)}>
        ${options.map((a) => html`<option value=${a.id}>${a.name}</option>`)}
      </select>
    </div>
    ${model.flat.length > 0 && html`<${SearchBar} search=${search} inputRef=${searchRef} placeholder="Search this media's transcript" />`}
    ${data &&
    html`<div class="tr-info">
      ${model.fixture && html`<span class="badge fixture" title="Deterministic synthetic transcript, not real speech recognition">Fixture transcript</span>`}
      <span class="tnum">${model.flat.length.toLocaleString()} words</span>
      <span class="tr-legend"><i class="on"></i>${model.usedCount.toLocaleString()} on the timeline</span>
      <span class="tr-legend"><i class="un"></i>${(model.flat.length - model.usedCount).toLocaleString()} unused</span>
    </div>`}
    <div class="tr-scroll" ref=${scrollRef}>
      <div class="tr-wrap" ref=${wrapRef}>
        ${load.error && load.id === id
          ? html`<div class="tr-pad"><${Notice} kind="error" action=${html`<button type="button" class="btn small" onClick=${() => setAttempt((n) => n + 1)}>Retry</button>`}><strong>The source transcript could not be loaded.</strong> ${load.error}<//></div>`
          : !data
            ? html`<div class="tr-skeleton" role="status" aria-label="Loading transcript">
                <div class="tr-skel-para"><i style="width:30%"></i><b style="width:94%"></b><b style="width:88%"></b><b style="width:57%"></b></div>
              </div>`
            : !model.flat.length
              ? html`<${EmptyState} icon="silence" title="No speech in this media">The transcription finished but found no words.<//>`
              : html`<${WordList}
                  model=${model}
                  scrollRef=${scrollRef}
                  api=${listApi}
                  hits=${search.hits}
                  activeHit=${search.active}
                  label=${`Source transcript of ${current.name}`}
                  describedBy="transcript-source-help"
                  announce=${announce}
                  onWordClick=${(e) => (e.tl != null ? transport.seek(e.tl, { snap: false }) : announce('This word is not on the timeline. Select a passage and add it to the timeline.'))}
                  onSelection=${(r) => setSel((cur) => (cur?.lo === r?.lo && cur?.hi === r?.hi ? cur : r))}
                  onActivate=${(i) => setEditing(model.flat[i])}
                  onDelete=${() => announce('Words are removed from the edit in Timeline mode. Here you choose passages to add.')}
                  onContext=${onContext}
                  onFind=${() => searchRef.current?.focus()}
                  onRename=${(para, name) => exec({ type: 'rename_speaker', asset_id: para.assetId, speaker: para.speaker, name: name || null }, { errorTitle: 'Could not rename the speaker' })}
                  onRestore=${() => {}}
                  onSeekTime=${(t) => transport.seek(t, { snap: false })}
                />`}
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
      </div>
    </div>
    <p id="transcript-source-help" class="sr-only">Select a passage by dragging across words or with Shift and the arrow keys, then add it to the rough cut list or straight to the timeline.</p>
    ${basket.length > 0 &&
    html`<section class="tr-basket" aria-label="Rough cut list">
      <header class="row">
        <span class="label grow">Rough cut · ${basket.length} passage${basket.length === 1 ? '' : 's'} · ${fmtSeconds(total)}</span>
        <button type="button" class="tr-link" onClick=${() => setBasket([])}>Clear</button>
      </header>
      <ol class="tr-basket-list" data-testid="basket">
        ${basket.map(
          (b, i) => html`<li key=${b.key}>
            <span class="tr-basket-n tnum">${i + 1}</span>
            <span class="grow truncate" title=${b.text}>${b.text}</span>
            <span class="faint tnum">${clock(b.start, { tenths: true })}</span>
            <${IconButton} icon="chevron-up" label="Move up" small disabled=${i === 0} onClick=${() => move(i, -1)} tipPos="left" />
            <${IconButton} icon="chevron-down" label="Move down" small disabled=${i === basket.length - 1} onClick=${() => move(i, 1)} tipPos="left" />
            <${IconButton} icon="x" label="Remove passage" small onClick=${() => setBasket((x) => x.filter((y) => y.key !== b.key))} tipPos="left" />
          </li>`,
        )}
      </ol>
    </section>`}
    ${(sel || basket.length > 0) &&
    html`<div class=${cx('tr-actionbar', 'source')} role="toolbar" aria-label="Rough cut actions">
      ${sel
        ? html`<span class="tr-sel-info tnum" data-testid="selection-info"><strong>${sel.hi - sel.lo + 1} word${sel.hi === sel.lo ? '' : 's'}</strong> · ${fmtSeconds(selRange.end - selRange.start)}</span>`
        : html`<span class="tr-sel-info">Ready to add</span>`}
      <span class="grow"></span>
      ${sel &&
      model.flat[sel.lo].tl != null &&
      model.flat[sel.hi].tlEnd != null &&
      html`<${IconButton} icon="play" label="Play selection on the timeline" onClick=${() => playRange(model.flat[sel.lo].tl, model.flat[sel.hi].tlEnd)} tipPos="top" />`}
      ${sel && html`<button type="button" class="btn small" data-testid="basket-add" onClick=${addToBasket} title="Collect several passages, then add them in order"><${Icon} name="plus" size=${13} /> List</button>`}
      <button type="button" class="btn small" data-testid="insert-at-playhead" disabled=${busy} onClick=${() => send(true)} title="Insert at the playhead and push later clips to the right">At playhead</button>
      <button type="button" class="btn small primary" data-testid="add-to-timeline" disabled=${busy} onClick=${() => send(false)} title="Append after the last clip">
        ${busy ? html`<${Spinner} />` : html`<${Icon} name="film" size=${13} />`} Add to timeline
      </button>
    </div>`}
  `;
}
