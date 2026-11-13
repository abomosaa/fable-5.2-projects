// Transcript view models.
//
// Both transcript modes (the *timeline* transcript derived by the server and the
// *source* transcript of one asset) are flattened into the same structure so the
// word list, selection, search and playback highlight share one implementation:
//
//   flat[]        every word in reading order; `i` is its position in this array
//   paragraphs[]  runs of words (same clip / speaker, no long pause); the body of a
//                 paragraph is pre-rendered HTML so unchanged paragraphs are never
//                 touched in the DOM after an edit
//   blocks[]      render list: paragraphs interleaved with "removed" chips
//   timeIdx/timeStarts  words sorted by timeline start, for O(log n) playhead lookup

import { TPS, sourceOut, timelineTimeOf, clipEnd } from '../lib/time.js';

const PAUSE_BREAK = 1.2 * TPS;
const HIGHLIGHT_TAIL = 0.35 * TPS;
const SOFT_PARA_WORDS = 60;
const HARD_PARA_WORDS = 140;
const SENTENCE_END = /[.!?…。！？]["'”’)\]]*$/;
export const LOW_CONFIDENCE = 0.6;

// Mirrors FILLERS in crates/core/src/analysis.rs (only used for the source view;
// the timeline view gets the flag from the server).
const FILLERS = new Set(['um', 'umm', 'ummm', 'uh', 'uhh', 'uhm', 'uhhh', 'er', 'err', 'erm', 'ah', 'ahh', 'eh', 'hm', 'hmm', 'hmmm', 'mm', 'mmm', 'mhm', 'em', 'ehm', 'äh', 'ähm', 'öh', 'euh', 'eeh', 'este', 'ehh']);

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' };
export const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ESC[c]);

/** Case/diacritic-insensitive form of a word with surrounding punctuation removed. */
export function normWord(s) {
  return String(s)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '');
}

const isFillerText = (text) => FILLERS.has(text.trim().toLowerCase().replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, ''));

const SPEAKER_COLORS = ['#7c9cff', '#47d6a2', '#ffc266', '#ff8fcb', '#a98bff', '#5cc8ff', '#f2b84b', '#ff8f6b'];
export function speakerColor(speaker) {
  if (speaker == null) return 'var(--text-3)';
  const n = parseInt(speaker, 10);
  let h = Number.isFinite(n) ? n - 1 : [...String(speaker)].reduce((a, c) => a + c.charCodeAt(0), 0);
  h = ((h % SPEAKER_COLORS.length) + SPEAKER_COLORS.length) % SPEAKER_COLORS.length;
  return SPEAKER_COLORS[h];
}

export function speakerName(doc, assetId, speaker) {
  if (speaker == null) return 'Speaker';
  return doc.transcript.speaker_names?.[assetId]?.[speaker] || `Speaker ${speaker}`;
}

/** "1.2 s", "12 s", "1 min 4 s" */
export function fmtSeconds(ticks) {
  const s = Math.max(0, ticks) / TPS;
  if (s < 10) return `${s.toFixed(s < 1 ? 2 : 1)} s`;
  if (s < 60) return `${Math.round(s)} s`;
  return `${Math.floor(s / 60)} min ${Math.round(s % 60)} s`;
}

function wordHtml(e, mainLang) {
  let cls = 'w';
  const tip = [];
  if (e.original != null) {
    cls += ' cor';
    tip.push(`Corrected · original: “${e.original}”`);
  }
  if (e.filler) {
    cls += ' f';
    tip.push('Filler word');
  }
  if (e.conf != null && e.conf < LOW_CONFIDENCE) {
    cls += ' lc';
    tip.push(`Low confidence (${Math.round(e.conf * 100)}%)`);
  }
  if (e.used === true) cls += ' on';
  else if (e.used === false) cls += ' un';
  const lang = e.lang && mainLang && e.lang !== mainLang ? e.lang : null;
  if (lang) tip.push(`Language: ${lang}`);
  return `<span class="${cls}" data-testid="word" data-word="${e.wordIndex}" data-k="${e.k}"${tip.length ? ` title="${esc(tip.join(' · '))}"` : ''}${lang ? ` data-lang="${esc(lang)}"` : ''}>${esc(e.text)}</span>`;
}

function finalize(model, doc) {
  const { flat, paragraphs } = model;
  const keys = new Map();
  for (const p of paragraphs) {
    // main language of the paragraph (words in another language get a tag)
    const langs = new Map();
    for (let i = p.from; i <= p.to; i++) if (flat[i].lang) langs.set(flat[i].lang, (langs.get(flat[i].lang) || 0) + 1);
    let main = null;
    let best = 0;
    for (const [l, n] of langs) if (n > best) [main, best] = [l, n];
    p.lang = main;
    let html = '';
    for (let i = p.from; i <= p.to; i++) html += (i > p.from ? ' ' : '') + wordHtml(flat[i], main);
    p.html = html;
    p.name = speakerName(doc, p.assetId, p.speaker);
    p.color = speakerColor(p.speaker);
    // stable across edits: asset word indices do not change when the timeline does
    const base = `${p.assetId}:${flat[p.from].wordIndex}`;
    const n = keys.get(base) || 0;
    keys.set(base, n + 1);
    p.key = n ? `${base}#${n}` : base;
  }
  // playhead lookup index
  const idx = [];
  for (const e of flat) if (e.tl != null) idx.push(e.i);
  idx.sort((a, b) => flat[a].tl - flat[b].tl || a - b);
  model.timeIdx = idx;
  model.timeStarts = Float64Array.from(idx, (i) => flat[i].tl);
  return model;
}

function pushWord(model, state, base, breakBefore) {
  const { flat, paragraphs, blocks } = model;
  const prev = state.prev;
  let para = state.para;
  const brk =
    !para ||
    breakBefore ||
    base.speaker !== para.speaker ||
    base.start - prev.end > PAUSE_BREAK ||
    (para.count >= SOFT_PARA_WORDS && SENTENCE_END.test(prev.text)) ||
    para.count >= HARD_PARA_WORDS;
  if (brk) {
    para = { index: paragraphs.length, assetId: base.assetId, clipId: base.clipId, speaker: base.speaker, start: base.start, tl: base.tl, from: flat.length, to: flat.length, count: 0, html: '', name: '', color: '', key: '', lang: null };
    paragraphs.push(para);
    blocks.push({ type: 'para', para });
    state.para = para;
  }
  base.i = flat.length;
  base.p = para.index;
  base.k = para.count;
  base.norm = normWord(base.text);
  flat.push(base);
  para.count++;
  para.to = base.i;
  state.prev = base;
}

/** Model of the server-derived timeline transcript. */
export function buildTimelineModel(view, doc) {
  const model = { mode: 'timeline', flat: [], paragraphs: [], blocks: [], fixture: false, corrected: 0, fillers: 0, removedWords: 0, skippedWords: 0 };
  if (!view) return finalize(model, doc);
  for (const seg of view.segments) {
    if (seg.fixture) model.fixture = true;
    if (seg.removed_before) {
      // with a reason: cut by a transcript edit; without: source the edit simply skips
      if (seg.removed_before.reason) model.removedWords += seg.removed_before.word_count;
      else model.skippedWords += seg.removed_before.word_count;
      model.blocks.push({ type: 'removed', key: `r:${seg.clip_id}:${seg.removed_before.source_start}`, seg, gap: seg.removed_before });
    }
    const state = { para: null, prev: null };
    for (const w of seg.words) {
      if (w.original != null) model.corrected++;
      if (w.filler) model.fillers++;
      pushWord(
        model,
        state,
        {
          text: w.text,
          original: w.original ?? null,
          speaker: w.speaker ?? null,
          conf: w.confidence ?? null,
          filler: !!w.filler,
          lang: w.language || null,
          assetId: seg.asset_id,
          clipId: seg.clip_id,
          wordIndex: w.index,
          start: w.start,
          end: w.end,
          tl: w.start,
          tlEnd: w.end,
          srcStart: w.source_start,
          srcEnd: w.source_end,
          used: null,
        },
        false,
      );
    }
  }
  return finalize(model, doc);
}

/** Audio clips of an asset as sorted source ranges. */
export function assetRanges(doc, assetId) {
  const out = [];
  for (const c of doc.clips.values()) {
    if (c.content.kind === 'audio' && c.content.asset_id === assetId) out.push({ clip: c, lo: c.source_in, hi: sourceOut(c) });
  }
  out.sort((a, b) => a.lo - b.lo || a.clip.start - b.clip.start);
  return out;
}

/** Model of one asset's full source transcript (times are source time). */
export function buildSourceModel(transcript, doc, assetId) {
  const model = { mode: 'source', flat: [], paragraphs: [], blocks: [], fixture: !!transcript?.fixture, corrected: 0, fillers: 0, usedCount: 0 };
  if (!transcript) return finalize(model, doc);
  const ranges = assetRanges(doc, assetId);
  const corrections = doc.transcript.corrections?.[assetId] || {};
  const state = { para: null, prev: null };
  let r = 0;
  for (const w of transcript.words) {
    const mid = (w.start + w.end) / 2;
    // first range containing the midpoint; words are time-ordered, so ranges that
    // ended before this word can be skipped for good
    while (r < ranges.length && ranges[r].hi <= mid) r++;
    let hit = null;
    for (let j = r; j < ranges.length && ranges[j].lo <= mid; j++) {
      if (mid < ranges[j].hi) {
        hit = ranges[j];
        break;
      }
    }
    const fixed = corrections[w.index];
    const corrected = fixed != null && fixed !== w.text;
    if (corrected) model.corrected++;
    const filler = isFillerText(w.text);
    if (filler) model.fillers++;
    if (hit) model.usedCount++;
    const clip = hit?.clip;
    const tl = clip ? Math.min(Math.max(timelineTimeOf(clip, w.start), clip.start), clipEnd(clip)) : null;
    pushWord(
      model,
      state,
      {
        text: corrected ? fixed : w.text,
        original: corrected ? w.text : null,
        speaker: w.speaker ?? null,
        conf: w.confidence ?? null,
        filler,
        lang: w.language || null,
        assetId,
        clipId: clip?.id || null,
        wordIndex: w.index,
        start: w.start,
        end: w.end,
        tl,
        tlEnd: clip ? Math.min(Math.max(timelineTimeOf(clip, w.end), tl), clipEnd(clip)) : null,
        srcStart: w.start,
        srcEnd: w.end,
        used: !!hit,
      },
      false,
    );
  }
  return finalize(model, doc);
}

/** Flat index of the word under timeline time `t`, or -1. */
export function findAtTime(model, t) {
  const starts = model.timeStarts;
  let lo = 0;
  let hi = starts.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (starts[mid] <= t) lo = mid + 1;
    else hi = mid;
  }
  if (lo === 0) return -1;
  const e = model.flat[model.timeIdx[lo - 1]];
  // keep the word lit through short gaps so the highlight does not flicker between words
  return t < e.tlEnd + HIGHLIGHT_TAIL ? e.i : -1;
}

/**
 * Find a phrase. Single terms match anywhere inside a word; multi-word phrases match
 * across adjacent words (the last term may be a prefix, so matches appear as you type).
 * @returns {Array<[number, number]>} inclusive flat ranges
 */
export function searchModel(model, query) {
  const toks = String(query).trim().split(/\s+/).map(normWord).filter(Boolean);
  const flat = model.flat;
  const hits = [];
  if (!toks.length) return hits;
  if (toks.length === 1) {
    const q = toks[0];
    for (let i = 0; i < flat.length; i++) if (flat[i].norm.includes(q)) hits.push([i, i]);
    return hits;
  }
  const last = toks.length - 1;
  for (let i = 0; i + last < flat.length; i++) {
    if (!flat[i].norm.endsWith(toks[0])) continue;
    let ok = true;
    for (let j = 1; j < last && ok; j++) ok = flat[i + j].norm === toks[j];
    if (ok && flat[i + last].norm.startsWith(toks[last])) hits.push([i, i + last]);
  }
  return hits;
}

/**
 * Turn a flat word range into source cuts: one cut per run of consecutive words of
 * the same clip (so pauses *between* the selected words go too).
 */
export function cutsForRange(model, lo, hi) {
  const cuts = [];
  let cur = null;
  for (let i = lo; i <= hi; i++) {
    const e = model.flat[i];
    if (!e.clipId) continue;
    if (cur && cur.clip_id === e.clipId && e.wordIndex === cur._last + 1) {
      cur.source_end = Math.max(cur.source_end, e.srcEnd);
      cur.text += ` ${e.original ?? e.text}`;
      cur._last = e.wordIndex;
      cur._tlEnd = e.tlEnd;
    } else {
      cur = { clip_id: e.clipId, source_start: e.srcStart, source_end: e.srcEnd, text: e.original ?? e.text, _last: e.wordIndex, _tlStart: e.tl, _tlEnd: e.tlEnd };
      cuts.push(cur);
    }
  }
  return cuts;
}

/** Timeline duration covered by cuts built with `cutsForRange`. */
export const cutsDuration = (cuts) => cuts.reduce((a, c) => a + Math.max(0, (c._tlEnd ?? 0) - (c._tlStart ?? 0)), 0);

/** Strip the private bookkeeping fields before sending cuts to the server. */
export const wireCuts = (cuts) => cuts.filter((c) => c.source_end > c.source_start).map(({ clip_id, source_start, source_end, text }) => ({ clip_id, source_start, source_end, text: (text || '').slice(0, 380) }));

/** A few words of context around flat index i: { before, word, after }. */
export function contextOf(model, i, n = 4) {
  const flat = model.flat;
  const p = flat[i].p;
  const before = [];
  const after = [];
  for (let j = i - 1; j >= 0 && before.length < n && flat[j].p === p; j--) before.unshift(flat[j].text);
  for (let j = i + 1; j < flat.length && after.length < n && flat[j].p === p; j++) after.push(flat[j].text);
  return { before: before.join(' '), word: flat[i].text, after: after.join(' ') };
}
