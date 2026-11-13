// Shared UI primitives. Everything is Preact + htm (vendored, no build step).
import { h, html, render, Component, createContext, useState, useReducer, useEffect, useLayoutEffect, useRef, useImperativeHandle, useMemo, useCallback, useContext, useErrorBoundary } from '../../vendor/preact-htm.js';
import { ICONS } from './icons.js';
import { store } from '../state/store.js';

export { h, html, render, Component, createContext, useState, useReducer, useEffect, useLayoutEffect, useRef, useImperativeHandle, useMemo, useCallback, useContext, useErrorBoundary };

export const cx = (...parts) => parts.filter(Boolean).join(' ');
export const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
export const isMac = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
/** Label for the platform's primary modifier. */
export const MOD = isMac ? '⌘' : 'Ctrl';
export const prefersReducedMotion = () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;

const shallowEqual = (a, b) => {
  if (Object.is(a, b)) return true;
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  // Only plain objects / arrays are compared structurally. Maps, Sets and other
  // instances have no enumerable keys and must be compared by identity.
  const plain = (o) => Array.isArray(o) || Object.getPrototypeOf(o) === Object.prototype || Object.getPrototypeOf(o) === null;
  if (!plain(a) || !plain(b)) return false;
  const ka = Object.keys(a);
  if (ka.length !== Object.keys(b).length) return false;
  for (const k of ka) if (!Object.is(a[k], b[k])) return false;
  return true;
};

/**
 * Subscribe a component to a slice of the store.
 * The selector may return a primitive, a stable reference, or a small object/array
 * of such (compared shallowly).
 */
export function useStore(selector) {
  const sel = useRef(selector);
  sel.current = selector;
  const [value, setValue] = useState(() => selector(store.state));
  const last = useRef(value);
  useEffect(() => {
    const check = () => {
      const next = sel.current(store.state);
      if (!shallowEqual(next, last.current)) {
        last.current = next;
        setValue(next);
      }
    };
    check();
    return store.subscribe(check);
  }, []);
  return value;
}

/** Subscribe to any emitter exposing subscribe(fn) → unsubscribe, re-rendering on change. */
export function useEmitter(emitter, read) {
  const [, force] = useReducer((x) => x + 1, 0);
  const last = useRef(read());
  useEffect(
    () =>
      emitter.subscribe(() => {
        const next = read();
        if (!shallowEqual(next, last.current)) {
          last.current = next;
          force();
        }
      }),
    [emitter],
  );
  last.current = read();
  return last.current;
}

export function Icon({ name, size, class: cls, title }) {
  const body = ICONS[name] || ICONS.dot;
  const s = size ? { width: size, height: size } : undefined;
  return html`<svg class=${cx('icon', cls)} style=${s} viewBox="0 0 16 16" aria-hidden=${title ? undefined : 'true'} role=${title ? 'img' : undefined} aria-label=${title} dangerouslySetInnerHTML=${{ __html: body }}></svg>`;
}

/**
 * Icon-only button. `label` is required (accessible name + tooltip);
 * `kbd` is appended to the tooltip, `pressed` makes it a toggle.
 */
export function IconButton({ icon, label, kbd, pressed, onClick, disabled, small, tipPos, class: cls, ...rest }) {
  return html`<button
    type="button"
    class=${cx('icon-btn', small && 'small', cls)}
    aria-label=${label}
    aria-pressed=${pressed === undefined ? undefined : String(!!pressed)}
    data-tip=${kbd ? `${label}  (${kbd})` : label}
    data-tip-pos=${tipPos}
    disabled=${disabled}
    onClick=${onClick}
    ...${rest}
  >
    <${Icon} name=${icon} />
  </button>`;
}

export function Spinner({ large, label = 'Loading' }) {
  return html`<span class=${cx('spinner', large && 'large')} role="status" aria-label=${label}></span>`;
}

export function Progress({ value, label }) {
  const indeterminate = value == null;
  return html`<div class=${cx('progress', indeterminate && 'indeterminate')} role="progressbar" aria-label=${label} aria-valuemin="0" aria-valuemax="100" aria-valuenow=${indeterminate ? undefined : Math.round(value * 100)}>
    <i style=${indeterminate ? undefined : { width: `${clamp(value, 0, 1) * 100}%` }}></i>
  </div>`;
}

export function EmptyState({ icon, title, children, action }) {
  return html`<div class="empty">
    ${icon && html`<${Icon} name=${icon} />`}
    <h3>${title}</h3>
    ${children && html`<p>${children}</p>`} ${action}
  </div>`;
}

export function Notice({ kind = 'info', icon, children, action }) {
  const ic = icon || (kind === 'error' ? 'alert' : kind === 'warning' ? 'alert' : 'info');
  return html`<div class=${cx('notice', kind)} role=${kind === 'error' ? 'alert' : 'status'}>
    <${Icon} name=${ic} />
    <div class="grow">${children}</div>
    ${action}
  </div>`;
}

/** Tab strip. tabs: [{id, label, icon?, count?}] */
export function Tabs({ tabs, value, onChange, label }) {
  const onKey = (e) => {
    const i = tabs.findIndex((t) => t.id === value);
    if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
      e.preventDefault();
      const n = tabs[(i + (e.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length];
      onChange(n.id);
      requestAnimationFrame(() => e.currentTarget.querySelector('[aria-selected="true"]')?.focus());
    }
  };
  return html`<div class="tabs" role="tablist" aria-label=${label} onKeyDown=${onKey}>
    ${tabs.map(
      (t) => html`<button type="button" class="tab" role="tab" id=${`tab-${t.id}`} aria-selected=${String(t.id === value)} tabindex=${t.id === value ? 0 : -1} onClick=${() => onChange(t.id)}>
        ${t.icon && html`<${Icon} name=${t.icon} />`}${t.label}${t.count != null && html`<span class="count">${t.count}</span>`}
      </button>`,
    )}
  </div>`;
}

/** Collapsible inspector section. */
export function Section({ title, children, defaultOpen = true, actions }) {
  const [open, setOpen] = useState(defaultOpen);
  return html`<section class="section">
    <div class="row" style="gap:0">
      <button type="button" class="section-head" aria-expanded=${String(open)} onClick=${() => setOpen(!open)}>
        <${Icon} name="chevron-down" class="chev" size=${12} />
        <span class="grow">${title}</span>
      </button>
      ${actions && html`<div class="row" style="padding-right:8px;gap:2px">${actions}</div>`}
    </div>
    ${open && html`<div class="section-body">${children}</div>`}
  </section>`;
}

/**
 * Numeric field with drag-to-scrub on its label, arrow-key stepping and
 * commit-on-blur/Enter. `onInput` fires continuously (live preview), `onCommit`
 * once per gesture (the undoable change).
 */
export function NumberField({ value, onInput, onCommit, min = -Infinity, max = Infinity, step = 1, precision = 0, unit, label, scrubLabel, disabled, id, mixed }) {
  const [text, setText] = useState(null); // non-null while the user is typing
  const drag = useRef(null);
  const fmt = (v) => (Number.isFinite(v) ? v.toFixed(precision) : '');
  const parse = (s) => {
    const v = parseFloat(String(s).replace(',', '.'));
    return Number.isFinite(v) ? clamp(v, min, max) : null;
  };
  const cancelled = useRef(false);
  const commitText = () => {
    if (text == null) return;
    setText(null);
    if (cancelled.current) {
      cancelled.current = false;
      return;
    }
    const v = parse(text);
    if (v != null && v !== value) onCommit?.(v);
  };
  const onKey = (e) => {
    if (e.key === 'Enter') {
      // blur commits (exactly once)
      e.preventDefault();
      e.currentTarget.blur();
    } else if (e.key === 'Escape') {
      cancelled.current = text != null;
      e.currentTarget.blur();
    } else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      e.preventDefault();
      const base = parse(text ?? value) ?? 0;
      const v = clamp(base + (e.key === 'ArrowUp' ? 1 : -1) * step * (e.shiftKey ? 10 : 1), min, max);
      setText(null);
      onCommit?.(Number(v.toFixed(Math.max(precision, 4))));
    }
  };
  const down = (e) => {
    if (disabled) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { x: e.clientX, start: Number.isFinite(value) ? value : 0, last: value, moved: false };
  };
  const move = (e) => {
    const d = drag.current;
    if (!d) return;
    const dx = e.clientX - d.x;
    if (Math.abs(dx) > 2) d.moved = true;
    const v = clamp(d.start + Math.round(dx / 2) * step * (e.shiftKey ? 10 : 1), min, max);
    if (v !== d.last) {
      d.last = v;
      onInput?.(v);
    }
  };
  const up = () => {
    const d = drag.current;
    drag.current = null;
    if (d && d.moved && d.last !== d.start) onCommit?.(d.last);
  };
  return html`<div class="num">
    ${scrubLabel && html`<span class="scrub" onPointerDown=${down} onPointerMove=${move} onPointerUp=${up} onPointerCancel=${up} aria-hidden="true">${scrubLabel}</span>`}
    <input
      id=${id}
      type="text"
      inputmode="decimal"
      aria-label=${label}
      disabled=${disabled}
      placeholder=${mixed ? 'Mixed' : undefined}
      value=${text ?? (mixed ? '' : fmt(value))}
      onInput=${(e) => setText(e.currentTarget.value)}
      onFocus=${(e) => e.currentTarget.select()}
      onBlur=${commitText}
      onKeyDown=${onKey}
    />
    ${unit && html`<span class="unit">${unit}</span>`}
  </div>`;
}

/** Range slider with live preview (`onInput`) and a single undoable `onCommit`. */
export function Slider({ value, min, max, step = 0.01, onInput, onCommit, label, disabled, id, resetTo }) {
  const fill = `${((clamp(value, min, max) - min) / (max - min)) * 100}%`;
  return html`<input
    id=${id}
    class="slider"
    type="range"
    aria-label=${label}
    min=${min}
    max=${max}
    step=${step}
    value=${value}
    disabled=${disabled}
    style=${{ '--fill': fill }}
    onInput=${(e) => onInput?.(parseFloat(e.currentTarget.value))}
    onChange=${(e) => onCommit?.(parseFloat(e.currentTarget.value))}
    onDblClick=${() => resetTo !== undefined && onCommit?.(resetTo)}
    title=${resetTo !== undefined ? 'Double-click to reset' : undefined}
  />`;
}

export function Switch({ checked, onChange, label, disabled }) {
  return html`<label class="switch">
    <input type="checkbox" role="switch" checked=${checked} disabled=${disabled} onChange=${(e) => onChange(e.currentTarget.checked)} />
    <span class="track" aria-hidden="true"></span>
    <span>${label}</span>
  </label>`;
}

/** Segmented control. options: [{value, label, icon?}] */
export function Segmented({ options, value, onChange, label }) {
  return html`<div class="seg" role="radiogroup" aria-label=${label}>
    ${options.map(
      (o) => html`<button type="button" role="radio" aria-checked=${String(o.value === value)} aria-label=${o.title || undefined} onClick=${() => onChange(o.value)}>
        ${o.icon && html`<${Icon} name=${o.icon} size=${13} />`}${o.label}
      </button>`,
    )}
  </div>`;
}

// ---------------------------------------------------------------------------------
// Dialog with focus trap, Escape to close and focus restoration.
// ---------------------------------------------------------------------------------
const FOCUSABLE = 'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function Dialog({ title, onClose, children, footer, wide, initialFocus, busy }) {
  const ref = useRef(null);
  useEffect(() => {
    const prev = document.activeElement;
    const el = ref.current;
    const target = (initialFocus && el.querySelector(initialFocus)) || el.querySelector('.dialog-body ' + FOCUSABLE.split(', ').join(', .dialog-body ')) || el.querySelector(FOCUSABLE);
    target?.focus();
    return () => prev?.focus?.();
  }, []);
  const onKey = (e) => {
    if (e.key === 'Escape' && !busy) {
      e.stopPropagation();
      onClose();
    } else if (e.key === 'Tab') {
      const items = [...ref.current.querySelectorAll(FOCUSABLE)].filter((n) => n.offsetParent !== null);
      if (!items.length) return;
      const first = items[0];
      const last = items[items.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    }
    // keep editor shortcuts from firing behind the dialog
    e.stopPropagation();
  };
  const id = useMemo(() => `dlg-${Math.random().toString(36).slice(2, 8)}`, []);
  return html`<div class="scrim" onMouseDown=${(e) => e.target === e.currentTarget && !busy && onClose()}>
    <div class=${cx('dialog', wide && 'wide')} role="dialog" aria-modal="true" aria-labelledby=${id} ref=${ref} onKeyDown=${onKey}>
      <header class="dialog-head">
        <h2 id=${id}>${title}</h2>
        <${IconButton} icon="x" label="Close" onClick=${onClose} disabled=${busy} tipPos="left" />
      </header>
      <div class="dialog-body">${children}</div>
      ${footer && html`<footer class="dialog-foot">${footer}</footer>`}
    </div>
  </div>`;
}

/** Simple confirmation dialog. */
export function ConfirmDialog({ title, message, confirmLabel = 'Confirm', danger, onConfirm, onClose }) {
  const [busy, setBusy] = useState(false);
  const go = async () => {
    setBusy(true);
    try {
      await onConfirm();
    } finally {
      setBusy(false);
      onClose();
    }
  };
  return html`<${Dialog}
    title=${title}
    onClose=${onClose}
    busy=${busy}
    initialFocus=".confirm-go"
    footer=${html`<button type="button" class="btn" onClick=${onClose} disabled=${busy}>Cancel</button>
      <button type="button" class=${cx('btn confirm-go', danger ? 'danger' : 'primary')} onClick=${go} disabled=${busy}>${busy ? html`<${Spinner} />` : null}${confirmLabel}</button>`}
  >
    <p class="muted" style="line-height:1.55">${message}</p>
  <//>`;
}

// ---------------------------------------------------------------------------------
// Context / popover menus (imperative: openMenu(event or {x,y}, items))
// items: [{label, icon?, hint?, onSelect, disabled?, danger?, checked?} | {separator:true} | {heading:'…'}]
// ---------------------------------------------------------------------------------
let menuHost = null;
export function closeMenu() {
  if (menuHost) {
    render(null, menuHost);
    menuHost.remove();
    menuHost = null;
  }
}

function MenuView({ x, y, items, returnFocus }) {
  const ref = useRef(null);
  const [pos, setPos] = useState({ left: x, top: y, visibility: 'hidden' });
  useLayoutEffect(() => {
    const r = ref.current.getBoundingClientRect();
    const left = clamp(x, 6, window.innerWidth - r.width - 6);
    const top = y + r.height + 6 > window.innerHeight ? Math.max(6, y - r.height) : y;
    setPos({ left, top });
  }, []);
  // Focus the first item once the menu is actually visible: an element inside a
  // `visibility: hidden` box cannot take focus, and without focus the arrow keys
  // and Escape never reach the menu.
  useLayoutEffect(() => {
    if (!pos.visibility) ref.current?.querySelector('.menu-item:not([disabled])')?.focus({ preventScroll: true });
  }, [pos.visibility]);
  const close = (refocus = true) => {
    closeMenu();
    if (refocus) returnFocus?.focus?.();
  };
  useEffect(() => {
    const away = (e) => !ref.current?.contains(e.target) && close(false);
    const blur = () => close(false);
    window.addEventListener('pointerdown', away, true);
    window.addEventListener('blur', blur);
    window.addEventListener('resize', blur);
    return () => {
      window.removeEventListener('pointerdown', away, true);
      window.removeEventListener('blur', blur);
      window.removeEventListener('resize', blur);
    };
  }, []);
  const onKey = (e) => {
    const enabled = [...ref.current.querySelectorAll('.menu-item:not([disabled])')];
    const i = enabled.indexOf(document.activeElement);
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      enabled[(i + (e.key === 'ArrowDown' ? 1 : enabled.length - 1)) % enabled.length]?.focus();
    } else if (e.key === 'Home' || e.key === 'End') {
      e.preventDefault();
      enabled[e.key === 'Home' ? 0 : enabled.length - 1]?.focus();
    } else if (e.key === 'Escape' || e.key === 'Tab') {
      e.preventDefault();
      close();
    }
    e.stopPropagation();
  };
  return html`<div class="menu" role="menu" ref=${ref} style=${pos} onKeyDown=${onKey} onContextMenu=${(e) => e.preventDefault()}>
    ${items.filter(Boolean).map((it) =>
      it.separator
        ? html`<div class="menu-sep" role="separator"></div>`
        : it.heading
          ? html`<div class="menu-label">${it.heading}</div>`
          : html`<button
              type="button"
              class=${cx('menu-item', it.danger && 'danger')}
              role=${it.checked !== undefined ? 'menuitemcheckbox' : 'menuitem'}
              aria-checked=${it.checked !== undefined ? String(!!it.checked) : undefined}
              disabled=${it.disabled}
              onClick=${() => {
                close();
                it.onSelect?.();
              }}
            >
              ${it.icon ? html`<${Icon} name=${it.icon} />` : html`<span style="width:15px"></span>`}
              <span>${it.label}</span>
              ${it.checked ? html`<${Icon} name="check" class="check" />` : it.hint && html`<span class="hint">${it.hint}</span>`}
            </button>`,
    )}
  </div>`;
}

/** Open a menu at a pointer event (context menu) or below an element (dropdown). */
export function openMenu(at, items) {
  closeMenu();
  let x;
  let y;
  if (at instanceof Element) {
    const r = at.getBoundingClientRect();
    x = r.left;
    y = r.bottom + 4;
  } else if (at && 'clientX' in at) {
    at.preventDefault?.();
    x = at.clientX;
    y = at.clientY;
    // keyboard-invoked context menu (Shift+F10 / menu key) has no pointer position
    if (x === 0 && y === 0 && at.target?.getBoundingClientRect) {
      const r = at.target.getBoundingClientRect();
      x = r.left + Math.min(24, r.width / 2);
      y = r.top + Math.min(24, r.height / 2);
    }
  } else {
    x = at.x;
    y = at.y;
  }
  menuHost = document.createElement('div');
  document.body.appendChild(menuHost);
  render(html`<${MenuView} x=${x} y=${y} items=${items} returnFocus=${document.activeElement} />`, menuHost);
}

// ---------------------------------------------------------------------------------
// Toasts (store-backed so any module can raise one)
// ---------------------------------------------------------------------------------
let toastSeq = 1;
/**
 * @param {{title: string, detail?: string, kind?: 'info'|'success'|'warning'|'error', timeout?: number, action?: {label: string, onClick: () => void}}} t
 */
export function toast(t) {
  const id = toastSeq++;
  const entry = { id, kind: 'info', timeout: t.kind === 'error' ? 9000 : 4500, ...t };
  // identical toasts collapse instead of stacking
  const existing = store.state.toasts.filter((x) => !(x.title === entry.title && x.detail === entry.detail));
  store.set({ toasts: [...existing.slice(-3), entry] });
  if (entry.timeout > 0) setTimeout(() => dismissToast(id), entry.timeout);
  return id;
}
export function dismissToast(id) {
  store.set({ toasts: store.state.toasts.filter((t) => t.id !== id) });
}

export function Toasts() {
  const toasts = useStore((s) => s.toasts);
  return html`<div class="toasts" aria-live="polite" aria-relevant="additions">
    ${toasts.map(
      (t) => html`<div key=${t.id} class=${cx('toast', t.kind)} role=${t.kind === 'error' ? 'alert' : 'status'}>
        <div class="body">
          <div class="title">${t.title}</div>
          ${t.detail && html`<div class="detail">${t.detail}</div>`}
        </div>
        ${t.action &&
        html`<button
          type="button"
          class="btn small"
          onClick=${() => {
            t.action.onClick();
            dismissToast(t.id);
          }}
        >
          ${t.action.label}
        </button>`}
        <${IconButton} icon="x" label="Dismiss" small onClick=${() => dismissToast(t.id)} tipPos="left" />
      </div>`,
    )}
  </div>`;
}

/** Error boundary so one broken panel never takes the editor down. */
export class Boundary extends Component {
  constructor() {
    super();
    this.state = { error: null };
  }
  static getDerivedStateFromError(error) {
    return { error };
  }
  componentDidCatch(error) {
    console.error('[cutline] panel crashed:', error);
  }
  render({ children, name = 'This panel' }, { error }) {
    if (!error) return children;
    return html`<div class="empty" role="alert">
      <${Icon} name="alert" />
      <h3>${name} hit a problem</h3>
      <p>${String(error.message || error)}</p>
      <button type="button" class="btn" onClick=${() => this.setState({ error: null })}>Try again</button>
    </div>`;
  }
}

/** Bytes → "12.3 MB". */
export function formatBytes(n) {
  if (!Number.isFinite(n) || n <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(units.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
  return `${(n / 1024 ** i).toFixed(i === 0 ? 0 : n / 1024 ** i < 10 ? 1 : 0)} ${units[i]}`;
}

/** "3 minutes ago" style relative time. */
export function timeAgo(ms) {
  const s = Math.max(0, (Date.now() - ms) / 1000);
  if (s < 45) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  if (s < 86400 * 7) return `${Math.round(s / 86400)} d ago`;
  return new Date(ms).toLocaleDateString();
}
