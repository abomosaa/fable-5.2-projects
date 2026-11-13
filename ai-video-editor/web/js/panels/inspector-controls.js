// Small building blocks shared by the inspector views.
import { html, useState, useRef, useEffect, useContext, createContext, cx, clamp, Icon, IconButton, NumberField, Slider } from '../lib/ui.js';
import { frameTicks, frameToTicks, secondsToTicks, snapToFrame, timecode, TPS } from '../lib/time.js';

/** True while the inspected clips sit on a locked track: every control is disabled. */
export const Locked = createContext(false);

let idSeq = 1;
/** Stable DOM id for label ↔ input association. */
export function useId(prefix = 'insp') {
  const ref = useRef(null);
  if (!ref.current) ref.current = `${prefix}-${idSeq++}`;
  return ref.current;
}

export const round = (v, digits = 4) => {
  const f = 10 ** digits;
  return Math.round(v * f) / f;
};

/** Value shared by all items (or `mixed`). */
export function shared(items, get) {
  if (!items.length) return { value: undefined, mixed: false };
  const first = get(items[0]);
  const same = (a, b) => (typeof a === 'number' && typeof b === 'number' ? Math.abs(a - b) < 1e-9 : a === b);
  return { value: first, mixed: items.some((it) => !same(get(it), first)) };
}

// Sections remember whether they are open across selections (module level, per title).
const openState = new Map();

/** Collapsible section with an optional reset action in its header. */
export function ISection({ title, children, defaultOpen = true, onReset, canReset, id, actions }) {
  const key = title;
  const [open, setOpenRaw] = useState(openState.has(key) ? openState.get(key) : defaultOpen);
  const locked = useContext(Locked);
  const setOpen = (v) => {
    openState.set(key, v);
    setOpenRaw(v);
  };
  return html`<section class="section insp-section" id=${id} data-section=${title}>
    <div class="insp-section-head">
      <button type="button" class="section-head" aria-expanded=${String(open)} onClick=${() => setOpen(!open)}>
        <${Icon} name="chevron-down" class="chev" size=${12} />
        <span class="grow truncate">${title}</span>
      </button>
      <div class="insp-section-actions">
        ${actions}
        ${onReset && html`<${IconButton} icon="restore" label=${`Reset ${title.toLowerCase()}`} small disabled=${!canReset || locked} onClick=${onReset} tipPos="left" />`}
      </div>
    </div>
    ${open && html`<div class="section-body">${children}</div>`}
  </section>`;
}

/** One labelled property row. `name` becomes data-testid="prop-<name>". */
export function Row({ label, name, htmlFor, children, hint, top }) {
  return html`<div class=${cx('prop', top && 'top')} data-testid=${name ? `prop-${name}` : undefined}>
    ${htmlFor ? html`<label for=${htmlFor}>${label}</label>` : html`<span class="label">${label}</span>`}
    <div class="prop-control">
      ${children}
      ${hint && html`<div class="prop-hint">${hint}</div>`}
    </div>
  </div>`;
}

/**
 * Slider + number pair for one numeric property.
 * `onInput` previews live, `onCommit` fires once per gesture.
 */
export function SliderNum({ name, label, value, mixed, min, max, step = 1, precision = 0, unit, sliderMin, sliderMax, sliderStep, resetTo, onInput, onCommit, hint, disabled }) {
  const id = useId();
  const locked = useContext(Locked) || disabled;
  const v = Number.isFinite(value) ? value : (resetTo ?? min);
  const lo = sliderMin ?? min;
  const hi = sliderMax ?? max;
  return html`<${Row} label=${label} name=${name} htmlFor=${id} hint=${hint}>
    <div class="with-slider">
      <${Slider} value=${clamp(v, lo, hi)} min=${lo} max=${hi} step=${sliderStep ?? step} label=${label} disabled=${locked} resetTo=${resetTo} onInput=${onInput} onCommit=${onCommit} />
      <${NumberField} id=${id} value=${v} mixed=${mixed} min=${min} max=${max} step=${step} precision=${precision} unit=${unit} label=${label} disabled=${locked} onInput=${onInput} onCommit=${onCommit} />
    </div>
  <//>`;
}

/** A single number with a drag-to-scrub prefix (used in pairs: X / Y, W / H …). */
export function Num({ value, mixed, min, max, step = 1, precision = 0, unit, scrub, label, onInput, onCommit, id, disabled }) {
  const locked = useContext(Locked) || disabled;
  return html`<${NumberField} id=${id} value=${value} mixed=${mixed} min=${min} max=${max} step=${step} precision=${precision} unit=${unit} scrubLabel=${scrub} label=${label} disabled=${locked} onInput=${onInput} onCommit=${onCommit} />`;
}

/**
 * Parse a time typed by the user: `HH:MM:SS:FF`, `MM:SS:FF`, `SS:FF`, or plain
 * (decimal) seconds such as `12.5`. Returns ticks or null.
 */
export function parseTime(text, fps) {
  const s = String(text).trim().replace(',', '.').replace(/s$/i, '');
  if (!s) return null;
  if (!s.includes(':')) {
    const v = parseFloat(s);
    return Number.isFinite(v) && v >= 0 ? secondsToTicks(v) : null;
  }
  const parts = s.split(':').map((p) => (p === '' ? 0 : Number(p)));
  if (parts.length > 4 || parts.some((p) => !Number.isFinite(p) || p < 0)) return null;
  while (parts.length < 4) parts.unshift(0);
  const [h, m, sec, f] = parts;
  const base = Math.max(1, Math.round(fps.num / fps.den));
  const frames = Math.round(((h * 60 + m) * 60 + sec) * base + f);
  return frameToTicks(frames, fps);
}

/** Editable timecode. Commits on Enter / blur; Escape reverts; ↑/↓ step one frame. */
export function TimeField({ value, fps, onCommit, label, id, mixed, readOnly, min = 0, max = Infinity, disabled }) {
  const [text, setText] = useState(null);
  const locked = useContext(Locked) || disabled;
  const shown = mixed ? '' : timecode(value, fps);
  const cancelled = useRef(false);
  const commit = () => {
    if (text == null) return;
    setText(null);
    if (cancelled.current) {
      cancelled.current = false;
      return;
    }
    const t = parseTime(text, fps);
    if (t == null) return;
    const v = clamp(snapToFrame(t, fps), min, max);
    if (v !== value) onCommit?.(v);
  };
  const onKey = (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      e.currentTarget.blur(); // blur commits (exactly once)
    } else if (e.key === 'Escape') {
      cancelled.current = text != null;
      e.currentTarget.blur();
    } else if ((e.key === 'ArrowUp' || e.key === 'ArrowDown') && !readOnly && !mixed) {
      e.preventDefault();
      const d = (e.key === 'ArrowUp' ? 1 : -1) * (e.shiftKey ? 10 : 1) * frameTicks(fps);
      const v = clamp(value + d, min, max);
      setText(null);
      if (v !== value) onCommit?.(v);
    }
    e.stopPropagation();
  };
  return html`<input
    id=${id}
    class=${cx('input tnum time-field', readOnly && 'read-only')}
    type="text"
    inputmode="numeric"
    aria-label=${label}
    title=${readOnly ? undefined : 'Timecode HH:MM:SS:FF, or seconds (for example 12.5)'}
    readonly=${readOnly}
    disabled=${locked && !readOnly}
    placeholder=${mixed ? 'Mixed' : undefined}
    value=${text ?? shown}
    onInput=${(e) => !readOnly && setText(e.currentTarget.value)}
    onFocus=${(e) => !readOnly && e.currentTarget.select()}
    onBlur=${commit}
    onKeyDown=${onKey}
  />`;
}

const HEX = /^#[0-9a-f]{6}$/i;

/**
 * Colour swatch + hex field. `onInput` fires while the picker is open (live
 * preview), `onCommit` once when a colour is chosen / typed.
 */
export function ColorField({ value, mixed, onInput, onCommit, label, id, disabled }) {
  const [text, setText] = useState(null);
  const locked = useContext(Locked) || disabled;
  const color = HEX.test(value || '') ? value.toLowerCase() : '#ffffff';
  const cancelled = useRef(false);
  const commitText = () => {
    if (text == null) return;
    setText(null);
    if (cancelled.current) {
      cancelled.current = false;
      return;
    }
    let t = text.trim();
    if (t && !t.startsWith('#')) t = `#${t}`;
    if (HEX.test(t) && t.toLowerCase() !== color) onCommit?.(t.toLowerCase());
  };
  return html`<div class="color-field">
    <input type="color" class="swatch" aria-label=${`${label} picker`} value=${color} disabled=${locked} onInput=${(e) => onInput?.(e.currentTarget.value)} onChange=${(e) => onCommit?.(e.currentTarget.value)} />
    <input
      id=${id}
      class="input tnum"
      type="text"
      aria-label=${label}
      spellcheck="false"
      maxlength="7"
      disabled=${locked}
      placeholder=${mixed ? 'Mixed' : undefined}
      value=${text ?? (mixed ? '' : color)}
      onInput=${(e) => setText(e.currentTarget.value)}
      onFocus=${(e) => e.currentTarget.select()}
      onBlur=${commitText}
      onKeyDown=${(e) => {
        if (e.key === 'Enter') e.currentTarget.blur();
        else if (e.key === 'Escape') {
          cancelled.current = text != null;
          e.currentTarget.blur();
        }
        e.stopPropagation();
      }}
    />
  </div>`;
}

/** Toggle rendered as a compact switch inside a property row. */
export function Toggle({ checked, mixed, onChange, label, disabled }) {
  const locked = useContext(Locked) || disabled;
  const ref = useRef(null);
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = !!mixed;
  }, [mixed]);
  return html`<label class="switch insp-toggle">
    <input ref=${ref} type="checkbox" role="switch" checked=${!!checked && !mixed} disabled=${locked} aria-label=${label} onChange=${(e) => onChange(e.currentTarget.checked)} />
    <span class="track" aria-hidden="true"></span>
    ${mixed && html`<span class="faint">Mixed</span>`}
  </label>`;
}

/** Row of small preset buttons. options: [{value, label}] */
export function Chips({ options, value, onPick, label, disabled }) {
  const locked = useContext(Locked) || disabled;
  return html`<div class="chips" role="group" aria-label=${label}>
    ${options.map(
      (o) => html`<button type="button" class=${cx('chip', o.value === value && 'on')} aria-pressed=${String(o.value === value)} disabled=${locked} onClick=${() => onPick(o.value)}>${o.label}</button>`,
    )}
  </div>`;
}

/** Header shown at the top of every inspector view. */
export function Head({ icon, kind, title, subtitle, children }) {
  return html`<header class="insp-head">
    <span class=${cx('insp-kind', kind)} aria-hidden="true"><${Icon} name=${icon} /></span>
    <div class="grow">
      <h3 class="truncate" title=${title}>${title}</h3>
      ${subtitle && html`<p class="truncate" title=${typeof subtitle === 'string' ? subtitle : undefined}>${subtitle}</p>`}
    </div>
    ${children}
  </header>`;
}

export const ticksToSec = (t) => t / TPS;
/** "#rrggbb" + opacity 0..1 → "#rrggbbaa" */
export const withAlpha = (hex, alpha) => `${hex.slice(0, 7)}${Math.round(clamp(alpha, 0, 1) * 255).toString(16).padStart(2, '0')}`.toLowerCase();
/** "#rrggbb[aa]" → opacity 0..1 */
export const alphaOf = (hex) => (hex && hex.length === 9 ? parseInt(hex.slice(7, 9), 16) / 255 : 1);
