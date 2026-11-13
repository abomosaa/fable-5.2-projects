// Pieces shared by the timeline and source transcript modes: search, the inline
// correction editor and small command helpers.

import { html, useEffect, useLayoutEffect, useMemo, useRef, useState, Icon, IconButton, MOD, cx } from '../lib/ui.js';
import { exec } from '../state/actions.js';
import { transport } from '../player/transport.js';
import { searchModel } from './transcript-model.js';

/** Search state bound to a model + word list. Jumping seeks to the exact start of the match. */
export function useSearch(model, listApi, announce) {
  const [query, setQueryRaw] = useState('');
  const [applied, setApplied] = useState('');
  const [active, setActive] = useState(-1);
  const timer = useRef(0);
  const setQuery = (q) => {
    setQueryRaw(q);
    clearTimeout(timer.current);
    // tiny debounce keeps typing fluid on very long transcripts
    timer.current = setTimeout(() => {
      setApplied(q);
      setActive(-1);
    }, 90);
  };
  useEffect(() => () => clearTimeout(timer.current), []);
  const hits = useMemo(() => (applied.trim() ? searchModel(model, applied) : []), [model, applied]);
  const go = (index) => {
    if (!hits.length) return;
    const i = ((index % hits.length) + hits.length) % hits.length;
    setActive(i);
    const e = model.flat[hits[i][0]];
    if (e.tl != null) transport.seek(e.tl, { snap: false });
    // after the highlight has been painted
    requestAnimationFrame(() => listApi.current?.reveal(e.i, { center: true }));
    announce?.(`Match ${i + 1} of ${hits.length}: “${model.flat.slice(hits[i][0], hits[i][1] + 1).map((x) => x.text).join(' ')}”.`);
  };
  // first match nearest to the playhead, so Enter continues from where you are
  const start = () => {
    if (active >= 0) return active;
    const t = transport.time;
    const i = hits.findIndex(([lo]) => (model.flat[lo].tl ?? Infinity) >= t - 1);
    return (i < 0 ? 0 : i) - 1;
  };
  return {
    query,
    setQuery,
    hits,
    active,
    pending: query !== applied,
    next: () => go(start() + 1),
    prev: () => go(active < 0 ? start() : active - 1),
    clear: () => {
      clearTimeout(timer.current);
      setQueryRaw('');
      setApplied('');
      setActive(-1);
    },
  };
}

export function SearchBar({ search, inputRef, placeholder = 'Search the transcript' }) {
  const { query, hits, active, pending } = search;
  const has = query.trim().length > 0;
  return html`<div class="tr-search" role="search">
    <${Icon} name="search" size=${14} />
    <input
      ref=${inputRef}
      class="tr-search-input"
      type="text"
      data-testid="transcript-search"
      aria-label="Search the transcript"
      placeholder=${placeholder}
      title=${`Search (${MOD}+F while the transcript is focused) · Enter: next · Shift+Enter: previous`}
      value=${query}
      spellcheck=${false}
      autocomplete="off"
      onInput=${(e) => search.setQuery(e.currentTarget.value)}
      onKeyDown=${(e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          e.shiftKey ? search.prev() : search.next();
        } else if (e.key === 'Escape') {
          if (has) {
            e.preventDefault();
            search.clear();
          } else e.currentTarget.blur();
        }
        e.stopPropagation();
      }}
    />
    ${has &&
    html`<span class=${cx('tr-search-count tnum', !pending && !hits.length && 'none')} role="status" aria-live="polite" data-testid="search-count">
        ${pending ? '…' : hits.length ? (active >= 0 ? `${active + 1} of ${hits.length}` : `${hits.length} match${hits.length === 1 ? '' : 'es'}`) : 'No matches'}
      </span>
      <${IconButton} icon="chevron-up" label="Previous match" kbd="Shift+Enter" small disabled=${!hits.length} onClick=${search.prev} tipPos="left" />
      <${IconButton} icon="chevron-down" label="Next match" kbd="Enter" small disabled=${!hits.length} onClick=${search.next} tipPos="left" />
      <${IconButton} icon="x" label="Clear search" small onClick=${search.clear} tipPos="left" />`}
  </div>`;
}

export function correctWord(entry, text) {
  const t = text == null ? null : text.trim();
  if (t != null && (t === '' || t === entry.text)) return Promise.resolve(null);
  // typing the original text back is a revert
  const revert = t == null || t === entry.original;
  if (revert && entry.original == null) return Promise.resolve(null);
  return exec({ type: 'correct_word', asset_id: entry.assetId, word_index: entry.wordIndex, text: revert ? null : t }, { errorTitle: 'Could not correct the word' });
}

/** Inline editor placed over a word. The provider's tokens and timing are untouched. */
export function CorrectionEditor({ entry, listApi, wrapRef, onClose }) {
  const [pos, setPos] = useState(null);
  const ref = useRef(null);
  const done = useRef(false);
  useLayoutEffect(() => {
    const node = listApi.current?.nodeAt(entry.i);
    const wrap = wrapRef.current;
    if (!node || !wrap) return onClose();
    listApi.current.reveal(entry.i);
    const r = node.getBoundingClientRect();
    const w = wrap.getBoundingClientRect();
    const width = Math.max(96, Math.min(r.width + 36, w.width - 16));
    setPos({ left: Math.max(4, Math.min(r.left - w.left - 7, w.width - width - 4)), top: r.top - w.top - 4, width, height: r.height + 8, max: w.width - 8 });
  }, [entry.i]);
  // grow with the text so long corrections stay readable
  const fit = (el) => {
    if (!pos) return;
    const want = Math.min(pos.max, Math.max(pos.width, el.value.length * 8.4 + 30));
    const box = el.parentElement;
    box.style.width = `${want}px`;
    box.style.left = `${Math.max(4, Math.min(pos.left, pos.max + 4 - want))}px`;
  };
  useEffect(() => {
    if (pos) {
      ref.current?.focus();
      ref.current?.select();
    }
  }, [!!pos]);
  const finish = async (commit) => {
    if (done.current) return;
    done.current = true;
    const value = ref.current?.value ?? '';
    onClose();
    if (commit) await correctWord(entry, value);
  };
  if (!pos) return null;
  return html`<div class="tr-correct" style=${{ left: pos.left, top: pos.top, width: pos.width, height: pos.height }}>
    <input
      ref=${ref}
      class="input"
      data-testid="correct-input"
      aria-label=${`Correct “${entry.text}”${entry.original != null ? ` (original: ${entry.original})` : ''}. Enter to save, Escape to cancel.`}
      maxlength="120"
      defaultValue=${entry.text}
      spellcheck=${false}
      onBlur=${() => finish(true)}
      onInput=${(e) => fit(e.currentTarget)}
      onKeyDown=${(e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          finish(true);
        } else if (e.key === 'Escape') {
          e.preventDefault();
          finish(false);
        }
        e.stopPropagation();
      }}
    />
  </div>`;
}
