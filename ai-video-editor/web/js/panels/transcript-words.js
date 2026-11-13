// The word list: renders a transcript model and owns everything that must stay
// fast with ~10 000 words.
//
// * paragraphs are memoised and their bodies are pre-rendered HTML, so an edit only
//   touches the paragraphs whose text actually changed
// * one set of delegated listeners on the container (no per-word handlers)
// * selection, search hits, the keyboard cursor and the playback highlight are
//   painted by toggling data-attributes directly on the word nodes — the list is
//   never re-rendered for them (in particular not once per frame during playback)

import { html, Component, useEffect, useLayoutEffect, useRef, Icon, prefersReducedMotion, isMac, closeMenu } from '../lib/ui.js';
import { clock } from '../lib/time.js';
import { transport } from '../player/transport.js';
import { findAtTime, fmtSeconds } from './transcript-model.js';

// A gap that carries a reason was cut out by a transcript edit. A gap without one is
// just source the edit skips (e.g. two rough-cut passages placed back to back).
const REASONS = { filler: 'Filler word removed', silence: 'Silence removed', manual: 'Removed in the transcript', rough_cut: 'Removed by Tighten', assistant: 'Removed by the assistant' };

class Paragraph extends Component {
  constructor() {
    super();
    this.state = { editing: false };
  }
  shouldComponentUpdate(n, ns) {
    const a = this.props.para;
    const b = n.para;
    return ns.editing !== this.state.editing || a.html !== b.html || a.name !== b.name || a.start !== b.start || a.index !== b.index || a.color !== b.color || a.tl !== b.tl || a.clipId !== b.clipId || n.source !== this.props.source;
  }
  render({ para, source, onRename, onSeekTime }, { editing }) {
    const commit = (e) => {
      const v = e.currentTarget.value.trim();
      this.setState({ editing: false });
      if (v !== para.name) onRename(para, v);
    };
    return html`<div class="tp" data-p=${para.index} data-clip=${para.clipId || undefined} data-asset=${para.assetId}>
      <div class="tp-head">
        <span class="tp-dot" style=${{ background: para.color }} aria-hidden="true"></span>
        ${editing
          ? html`<input
              class="input tp-rename"
              aria-label="Speaker name"
              maxlength="60"
              defaultValue=${para.name}
              ref=${(el) => el && !el.dataset.sel && ((el.dataset.sel = '1'), el.focus(), el.select())}
              onBlur=${commit}
              onKeyDown=${(e) => {
                if (e.key === 'Enter') e.currentTarget.blur();
                else if (e.key === 'Escape') {
                  e.currentTarget.value = para.name;
                  e.currentTarget.blur();
                }
                e.stopPropagation();
              }}
            />`
          : para.speaker == null
            ? html`<span class="tp-speaker static">Speaker</span>`
            : html`<button type="button" class="tp-speaker" data-testid="speaker" title="Rename speaker" onClick=${() => this.setState({ editing: true })}>
                <span class="truncate">${para.name}</span><${Icon} name="pencil" size=${11} />
              </button>`}
        <button
          type="button"
          class="tp-time tnum"
          disabled=${para.tl == null}
          title=${para.tl == null ? 'Not on the timeline' : source ? `Source ${clock(para.start, { tenths: true })} · jump to it on the timeline` : 'Jump to this moment'}
          onClick=${() => para.tl != null && onSeekTime(para.tl)}
        >
          ${clock(para.start, { tenths: true })}
        </button>
      </div>
      <p class="tp-words" dangerouslySetInnerHTML=${{ __html: para.html }}></p>
    </div>`;
  }
}

class RemovedChip extends Component {
  constructor() {
    super();
    this.state = { open: false, busy: false };
  }
  render({ gap, seg, onRestore }, { open, busy }) {
    const removed = !!gap.reason;
    const reason = removed ? REASONS[gap.reason] || `Removed (${gap.reason})` : 'Skipped source';
    const dur = ((gap.source_end - gap.source_start) * seg.speed.den) / seg.speed.num;
    const text = gap.text || '';
    const long = text.length > 90;
    const shown = long && !open ? `${text.slice(0, 84).trimEnd()}…` : text;
    const more = long && html` <button type="button" class="tr-link" aria-expanded=${String(open)} onClick=${() => this.setState({ open: !open })}>${open ? 'Show less' : 'Show all'}</button>`;
    return html`<div class=${removed ? 'tr-removed' : 'tr-removed skipped'} data-testid="removed-chip" data-reason=${gap.reason || 'skipped'} role="group" aria-label=${`${reason}: ${text || 'no words'}`}>
      <${Icon} name=${removed ? 'scissors' : 'more'} size=${13} />
      <div class="tr-removed-body">
        <span class="tr-removed-meta"><span class="tr-reason">${reason}</span><span class="tr-removed-stats tnum">${fmtSeconds(dur)}${gap.word_count ? ` · ${gap.word_count} word${gap.word_count === 1 ? '' : 's'}` : ''}</span></span>
        ${text
          ? removed
            ? html`<span><s class="tr-removed-text">${shown}</s>${more}</span>`
            : html`<span><span class="tr-removed-text">${shown}</span>${more}</span>`
          : html`<span class="tr-removed-text none">${removed ? 'No words — pause only' : 'No words in between'}</span>`}
      </div>
      <button
        type="button"
        class="btn small"
        data-testid="restore-cut"
        disabled=${busy}
        title=${removed ? 'Put this media back on the timeline' : 'Insert the skipped media between these two clips'}
        onClick=${async () => {
          this.setState({ busy: true });
          await onRestore(gap);
          this.setState({ busy: false });
        }}
      >
        <${Icon} name=${removed ? 'restore' : 'plus'} size=${13} /> ${removed ? 'Restore' : 'Include'}
      </button>
    </div>`;
  }
}

/**
 * @param {object} props
 * @param {object} props.model            transcript model (transcript-model.js)
 * @param {{current: HTMLElement}} props.scrollRef   the scrolling ancestor
 * @param {{current: any}} props.api      receives the imperative API
 * @param {(entry) => void} props.onWordClick
 * @param {(sel: null|{lo:number,hi:number}, final: boolean) => void} props.onSelection
 * @param {(i: number) => void} props.onActivate   Enter / F2 on a word
 * @param {() => void} props.onDelete     Delete / Backspace with a selection
 * @param {(e: Event, i: number) => void} props.onContext
 * @param {() => void} props.onFind       Ctrl/⌘+F
 * @param {(msg: string) => void} props.announce
 */
export function WordList({ model, scrollRef, api, hits, activeHit, onWordClick, onSelection, onActivate, onDelete, onContext, onFind, onRename, onRestore, onSeekTime, announce, describedBy, label }) {
  const root = useRef(null);
  const st = useRef({ paraEls: [], sel: null, cursor: -1, cur: -1, down: null, hitNodes: [], lastUserScroll: 0, model: null }).current;
  const cb = useRef({});
  cb.current = { onWordClick, onSelection, onActivate, onDelete, onContext, onFind, announce };

  const nodeAt = (i) => {
    const e = st.model?.flat[i];
    return e ? st.paraEls[e.p]?.children[e.k] || null : null;
  };
  const indexOf = (target) => {
    const w = target?.closest?.('.w');
    if (!w || !root.current?.contains(w)) return -1;
    const p = w.closest('.tp');
    const para = st.model.paragraphs[+p.dataset.p];
    return para ? para.from + +w.dataset.k : -1;
  };
  const range = (sel) => (sel ? { lo: Math.min(sel.a, sel.f), hi: Math.max(sel.a, sel.f) } : null);

  const paintSel = (next) => {
    const a = range(st.sel);
    const b = range(next);
    if (a) for (let i = a.lo; i <= a.hi; i++) if (!b || i < b.lo || i > b.hi) nodeAt(i)?.removeAttribute('data-sel');
    if (b) for (let i = b.lo; i <= b.hi; i++) if (!a || i < a.lo || i > a.hi) nodeAt(i)?.setAttribute('data-sel', '');
    st.sel = next;
  };
  const setCursor = (i) => {
    if (st.cursor === i) return;
    nodeAt(st.cursor)?.removeAttribute('data-cursor');
    st.cursor = i;
    nodeAt(i)?.setAttribute('data-cursor', '');
  };
  const setSel = (next, final = true) => {
    paintSel(next);
    cb.current.onSelection(range(next), final);
  };
  const reveal = (i, { center = false, smooth = false } = {}) => {
    const node = nodeAt(i);
    const sc = scrollRef.current;
    if (!node || !sc) return;
    const r = node.getBoundingClientRect();
    const s = sc.getBoundingClientRect();
    const pad = Math.min(72, s.height / 4);
    if (!center && r.top >= s.top + pad && r.bottom <= s.bottom - pad) return;
    const top = sc.scrollTop + (r.top - s.top) - s.height * (center ? 0.4 : 0.3);
    sc.scrollTo({ top: Math.max(0, top), behavior: smooth && !prefersReducedMotion() ? 'smooth' : 'auto' });
  };

  api.current = {
    nodeAt,
    reveal,
    focus: () => root.current?.focus({ preventScroll: true }),
    getSelection: () => range(st.sel),
    getCursor: () => st.cursor,
    setSelection: (lo, hi) => setSel({ a: lo, f: hi }),
    clearSelection: () => setSel(null),
    setCursor,
  };

  // (re)index DOM nodes and repaint decorations whenever the model changes
  useLayoutEffect(() => {
    const el = root.current;
    for (const n of el.querySelectorAll('[data-sel],[data-cursor],[data-cur],[data-hit]')) {
      n.removeAttribute('data-sel');
      n.removeAttribute('data-cursor');
      n.removeAttribute('data-cur');
      n.removeAttribute('data-hit');
    }
    st.model = model;
    st.paraEls = [...el.querySelectorAll('.tp-words')];
    st.sel = null;
    st.cursor = -1;
    st.cur = -1;
    st.hitNodes = [];
    cb.current.onSelection(null, true);
    syncCurrent(false);
  }, [model]);

  // search hits
  useLayoutEffect(() => {
    for (const n of st.hitNodes) n.removeAttribute('data-hit');
    const nodes = [];
    (hits || []).forEach(([lo, hi], h) => {
      for (let i = lo; i <= hi; i++) {
        const n = nodeAt(i);
        if (n) {
          n.setAttribute('data-hit', h === activeHit ? 'cur' : '');
          nodes.push(n);
        }
      }
    });
    st.hitNodes = nodes;
  }, [hits, activeHit, model]);

  // playback highlight: follows the transport without re-rendering
  function syncCurrent(mayScroll) {
    if (!st.model) return;
    const i = findAtTime(st.model, transport.time);
    if (i === st.cur) return;
    nodeAt(st.cur)?.removeAttribute('data-cur');
    st.cur = i;
    if (i < 0) return;
    nodeAt(i)?.setAttribute('data-cur', '');
    if (mayScroll && performance.now() - st.lastUserScroll > 4000 && !st.down) reveal(i, { smooth: transport.playing });
  }
  useEffect(() => transport.subscribe(() => syncCurrent(true)), []);

  // manual scrolling pauses auto-follow for a few seconds
  useEffect(() => {
    const sc = scrollRef.current;
    if (!sc) return undefined;
    const mark = () => (st.lastUserScroll = performance.now());
    const key = (e) => ['PageUp', 'PageDown', 'Home', 'End'].includes(e.key) && mark();
    sc.addEventListener('wheel', mark, { passive: true });
    sc.addEventListener('touchmove', mark, { passive: true });
    sc.addEventListener('pointerdown', mark, { passive: true });
    sc.addEventListener('keydown', key);
    return () => {
      sc.removeEventListener('wheel', mark);
      sc.removeEventListener('touchmove', mark);
      sc.removeEventListener('pointerdown', mark);
      sc.removeEventListener('keydown', key);
    };
  }, []);

  const describe = (r) => {
    if (!r) return;
    const flat = st.model.flat;
    const n = r.hi - r.lo + 1;
    cb.current.announce(`${n} word${n === 1 ? '' : 's'} selected, from “${flat[r.lo].text}” to “${flat[r.hi].text}”.`);
  };

  // ---- pointer: click seeks, drag selects a range, shift-click extends --------------
  const onPointerDown = (e) => {
    if (e.button !== 0) return;
    if (e.target.closest('button, input, a')) return;
    const i = indexOf(e.target);
    if (i < 0) {
      if (st.sel) setSel(null);
      return;
    }
    root.current.focus({ preventScroll: true });
    if (e.shiftKey && (st.sel || st.cursor >= 0)) {
      const a = st.sel ? st.sel.a : st.cursor;
      setSel({ a, f: i });
      describe(range(st.sel));
      e.preventDefault();
      return;
    }
    st.down = { i, x: e.clientX, y: e.clientY, moved: false, last: i };
    const up = () => {
      window.removeEventListener('pointerup', up, true);
      window.removeEventListener('pointercancel', up, true);
      clearInterval(st.down?.timer);
      const d = st.down;
      st.down = null;
      if (!d) return;
      if (!d.moved) {
        if (st.sel) setSel(null);
        setCursor(d.i);
        cb.current.onWordClick(st.model.flat[d.i]);
      } else {
        setCursor(-1);
        cb.current.onSelection(range(st.sel), true);
        describe(range(st.sel));
      }
    };
    window.addEventListener('pointerup', up, true);
    window.addEventListener('pointercancel', up, true);
  };
  const onPointerMove = (e) => {
    const d = st.down;
    if (!d) return;
    const j = indexOf(e.target);
    if (!d.moved && (j === d.i || j < 0) && Math.hypot(e.clientX - d.x, e.clientY - d.y) < 5) return;
    d.moved = true;
    if (j >= 0) d.last = j;
    if (!st.sel || st.sel.f !== d.last || st.sel.a !== d.i) setSel({ a: d.i, f: d.last }, false);
    // auto-scroll near the edges while dragging
    const sc = scrollRef.current;
    if (sc) {
      const s = sc.getBoundingClientRect();
      const dy = e.clientY < s.top + 28 ? -14 : e.clientY > s.bottom - 28 ? 14 : 0;
      clearInterval(d.timer);
      if (dy) d.timer = setInterval(() => sc.scrollBy(0, dy), 16);
    }
  };
  const onDblClick = (e) => {
    const i = indexOf(e.target);
    if (i < 0) return;
    setCursor(-1);
    setSel({ a: i, f: i });
    describe({ lo: i, hi: i });
  };
  const onContextMenu = (e) => {
    let i = indexOf(e.target);
    if (i < 0) i = st.sel ? range(st.sel).lo : st.cursor;
    if (i < 0) return;
    const r = range(st.sel);
    if (!r || i < r.lo || i > r.hi) {
      // right-click outside the selection targets just that word
      if (st.sel) setSel(null);
      setCursor(i);
    }
    // Open on the next tick: on Linux `contextmenu` fires during mousedown, and the
    // browser focuses this (focusable) container right afterwards — which would
    // steal focus from the freshly opened menu and break its keyboard handling.
    e.preventDefault();
    let at = { x: e.clientX, y: e.clientY };
    if (!at.x && !at.y) {
      const r = (nodeAt(i) || root.current).getBoundingClientRect();
      at = { x: r.left + Math.min(16, r.width / 2), y: r.bottom + 2 };
    }
    setTimeout(() => cb.current.onContext(at, i), 0);
  };

  // ---- keyboard ---------------------------------------------------------------------
  const onKeyDown = (e) => {
    if (e.target !== root.current && e.target.closest('input, textarea, select, button')) return;
    const mod = isMac ? e.metaKey : e.ctrlKey;
    const flat = st.model.flat;
    const n = flat.length;
    const key = e.key;
    const done = () => {
      e.preventDefault();
      e.stopPropagation();
    };
    if (key === 'Escape' && document.querySelector('.menu')) {
      // a context menu opened from here may not hold focus: Escape still closes it
      closeMenu();
      return done();
    }
    if (mod && key.toLowerCase() === 'f') {
      cb.current.onFind();
      return done();
    }
    if (!n) return;
    if ((key === 'ArrowLeft' || key === 'ArrowRight') && !mod && !e.altKey) {
      const dir = key === 'ArrowRight' ? 1 : -1;
      const base = st.sel ? st.sel.f : st.cursor >= 0 ? st.cursor : st.cur >= 0 ? st.cur : dir > 0 ? -1 : n;
      const next = Math.min(n - 1, Math.max(0, base + dir));
      if (e.shiftKey) {
        const a = st.sel ? st.sel.a : Math.min(n - 1, Math.max(0, base));
        setCursor(-1);
        setSel({ a, f: st.sel ? next : a });
        describe(range(st.sel));
        reveal(st.sel.f);
      } else {
        if (st.sel) setSel(null);
        setCursor(next);
        reveal(next);
        cb.current.onWordClick(flat[next]);
      }
      return done();
    }
    if (mod && key.toLowerCase() === 'a') {
      setCursor(-1);
      setSel({ a: 0, f: n - 1 });
      describe({ lo: 0, hi: n - 1 });
      return done();
    }
    if (mod && key.toLowerCase() === 'c' && st.sel) {
      const r = range(st.sel);
      const text = flat
        .slice(r.lo, r.hi + 1)
        .map((x) => x.text)
        .join(' ');
      navigator.clipboard?.writeText(text).then(
        () => cb.current.announce('Copied the selected text.'),
        () => {},
      );
      return done();
    }
    if (key === 'Escape' && (st.sel || st.cursor >= 0)) {
      if (st.sel) setSel(null);
      setCursor(-1);
      return done();
    }
    if (key === 'Delete' || key === 'Backspace') {
      // never let Delete fall through to the timeline while the transcript has focus
      if (st.sel) cb.current.onDelete();
      else cb.current.announce('Select one or more words first, then press Delete to remove them.');
      return done();
    }
    if (key === 'Enter' || key === 'F2') {
      const r = range(st.sel);
      const i = r ? (r.lo === r.hi ? r.lo : -1) : st.cursor;
      if (i >= 0) cb.current.onActivate(i);
      return done();
    }
  };

  return html`<div
    class="tr-words"
    ref=${root}
    tabindex="0"
    role="group"
    aria-label=${label}
    aria-describedby=${describedBy}
    data-testid="transcript"
    data-mode=${model.mode}
    onPointerDown=${onPointerDown}
    onPointerMove=${onPointerMove}
    onDblClick=${onDblClick}
    onContextMenu=${onContextMenu}
    onKeyDown=${onKeyDown}
  >
    ${model.blocks.map((b) =>
      b.type === 'para'
        ? html`<${Paragraph} key=${b.para.key} para=${b.para} source=${model.mode === 'source'} onRename=${onRename} onSeekTime=${onSeekTime} />`
        : html`<${RemovedChip} key=${b.key} gap=${b.gap} seg=${b.seg} onRestore=${onRestore} />`,
    )}
  </div>`;
}
