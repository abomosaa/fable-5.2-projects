import { useEffect, useRef, useState, type ReactNode } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { formatNumber, fromDisplay, parseQuantity, toDisplay, unitFor, type QuantityKind, type UnitPrefs } from '../core/units';
import { coalesceNext, redo, undo, useApp } from './store';

/**
 * Shared key handling for editable fields. Ctrl+Z / Ctrl+Y never run the browser's native text undo
 * (which would rewrite a committed field behind the model's back): with an uncommitted draft they
 * discard the draft, otherwise they undo / redo the last project edit. Other Ctrl/Cmd shortcuts
 * (save, open) are left to the application. Returns true when the event was consumed.
 */
function fieldShortcut(e: React.KeyboardEvent, dirty: boolean, revert: () => void): boolean {
  const mod = e.ctrlKey || e.metaKey;
  if (!mod) { e.stopPropagation(); return false; }
  const k = e.key.toLowerCase();
  if (k === 'z' || k === 'y') {
    e.preventDefault(); e.stopPropagation();
    if (dirty) revert();
    else if (k === 'y' || e.shiftKey) redo();
    else undo();
    return true;
  }
  return false; // let Ctrl+S, Ctrl+O … reach the application handler
}

export function IconButton(props: { title: string; onClick?: (e: React.MouseEvent) => void; active?: boolean; disabled?: boolean; children: ReactNode; className?: string; testId?: string }) {
  return (
    <button type="button" className={`icon-btn ${props.active ? 'active' : ''} ${props.className ?? ''}`} title={props.title} aria-label={props.title} aria-pressed={props.active} disabled={props.disabled} onClick={props.onClick} data-testid={props.testId}>
      {props.children}
    </button>
  );
}

export function Seg<T extends string>(props: { value: T; onChange: (v: T) => void; options: { value: T; label: string; title?: string }[]; testId?: string }) {
  return (
    <div className="seg" role="radiogroup" data-testid={props.testId}>
      {props.options.map((o) => (
        <button key={o.value} type="button" role="radio" aria-checked={props.value === o.value} title={o.title} className={props.value === o.value ? 'on' : ''} onClick={() => props.onChange(o.value)}>{o.label}</button>
      ))}
    </div>
  );
}

export function Section(props: { title: string; children: ReactNode; defaultOpen?: boolean; right?: ReactNode }) {
  const [open, setOpen] = useState(props.defaultOpen ?? true);
  return (
    <section className="section">
      <header className="section-h">
        <button type="button" className="section-toggle" onClick={() => setOpen(!open)} aria-expanded={open}>
          {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
          <span>{props.title}</span>
        </button>
        {props.right}
      </header>
      {open && <div className="section-b">{props.children}</div>}
    </section>
  );
}

export function Row(props: { label: string; children: ReactNode; help?: string; htmlFor?: string }) {
  return (
    <div className="row" title={props.help}>
      <label className="row-l" htmlFor={props.htmlFor}>{props.label}{props.help && <span className="help-dot" aria-hidden="true">?</span>}</label>
      <div className="row-c">{props.children}</div>
    </div>
  );
}

let fieldSeq = 0;

/**
 * Numeric field bound to an INTERNAL-unit value. Shows the value in the
 * project's display unit with the unit visible; accepts arithmetic and
 * explicit units ("25.4", "1 in", "2*pi rad", "0.4 N*m").
 */
export function NumField(props: {
  value: number | null | undefined; kind: QuantityKind; onCommit: (v: number) => void; label?: string;
  min?: number; max?: number; disabled?: boolean; sig?: number; allowInf?: boolean; id?: string; testId?: string; placeholder?: string; compact?: boolean;
}) {
  const prefs = useApp((s) => s.project.units) as UnitPrefs;
  const { value, kind } = props;
  const unit = unitFor(kind, prefs);
  // values that are zero up to solver tolerance (1e-9 display units) are shown as 0, not as 3.9e-15
  const disp = value === null || value === undefined ? 0 : toDisplay(value, kind, prefs);
  const shown = value === null || value === undefined ? '' : !Number.isFinite(value) ? (value > 0 ? '∞' : '−∞') : formatNumber(Math.abs(disp) < 1e-9 ? 0 : disp, props.sig ?? 6);
  const [text, setText] = useState(shown);
  const [err, setErr] = useState<string | null>(null);
  const shownRef = useRef(shown); shownRef.current = shown;
  const textRef = useRef(text); textRef.current = text;
  const focused = useRef(false);
  /** text of the last successful commit, so Enter followed by blur does not commit twice */
  const committed = useRef<string | null>(null);
  const idRef = useRef(props.id ?? `nf${++fieldSeq}`);
  // follow the model: always when not focused, and also while focused as long as nothing was typed
  // (otherwise an undo that changes this very field would leave stale text that the next blur re-commits)
  const prevShown = useRef(shown);
  useEffect(() => {
    if (!focused.current || text.trim() === prevShown.current) { setText(shown); setErr(null); }
    prevShown.current = shown;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shown]);

  const commit = (t: string): boolean => {
    if (t.trim() === shown) { setErr(null); return true; }
    if (t.trim() === '' && props.allowInf) { props.onCommit(Infinity); return true; }
    const r = parseQuantity(t, kind, prefs);
    if (!r.ok) { setErr(r.error ?? 'Invalid value'); return false; }
    let v = r.value;
    if (!Number.isFinite(v) && !props.allowInf) { setErr('Must be a finite number'); return false; }
    if (props.min !== undefined && v < props.min - 1e-12) { setErr(`Minimum is ${formatNumber(toDisplay(props.min, kind, prefs))} ${unit}`); return false; }
    const max = props.max ?? (kind === 'length' ? 1e4 : undefined);   // 10 m cap: beyond a desktop mechanism, and it keeps typos (1e9) out of the model
    if (max !== undefined && Number.isFinite(v) && v > max + 1e-12) { setErr(`Maximum is ${formatNumber(toDisplay(max, kind, prefs))} ${unit}`); return false; }
    if (kind === 'count') v = Math.round(v);
    setErr(null);
    committed.current = t;
    if (v !== value) {
      props.onCommit(v);
      // If the edit was refused or adjusted (e.g. a pose the joints do not allow), the bound value did
      // not become what was typed: show the model value again instead of leaving the typed text.
      setTimeout(() => { if (textRef.current === t) setText(shownRef.current); }, 0);
    }
    return true;
  };
  const cancelled = useRef(false);
  const nudge = (dir: number, e: React.KeyboardEvent) => {
    // nudge from what is typed (if it parses), otherwise from the stored value
    let from = value;
    if (text.trim() !== shown) { const r = parseQuantity(text, kind, prefs); if (r.ok && Number.isFinite(r.value)) from = r.value; }
    if (from === null || from === undefined || !Number.isFinite(from)) return;
    const stepDisp = e.shiftKey ? 10 : e.altKey ? 0.1 : 1;
    let v = fromDisplay(toDisplay(from, kind, prefs) + dir * stepDisp, kind, prefs);
    if (props.min !== undefined) v = Math.max(props.min, v);
    if (props.max !== undefined) v = Math.min(props.max, v);
    coalesceNext();     // a burst of nudges is one undo step
    props.onCommit(v);
    const t = formatNumber(toDisplay(v, kind, prefs), props.sig ?? 6);
    setText(t);
    // a refused or adjusted nudge: show what the model actually holds
    setTimeout(() => { if (textRef.current === t) setText(shownRef.current); }, 0);
  };
  return (
    <span className={`num ${err ? 'err' : ''} ${props.compact ? 'compact' : ''} ${props.disabled ? 'dis' : ''}`} title={err ?? undefined}>
      <input
        id={idRef.current} type="text" inputMode="decimal" spellCheck={false} autoComplete="off" aria-label={props.label} aria-invalid={!!err} disabled={props.disabled}
        value={text} placeholder={props.placeholder} data-testid={props.testId}
        onFocus={(e) => { focused.current = true; e.currentTarget.select(); }}
        onChange={(e) => { setText(e.target.value); committed.current = null; if (err) setErr(null); }}
        onBlur={() => {
          focused.current = false;
          if (cancelled.current) { cancelled.current = false; committed.current = null; setText(shown); setErr(null); return; }
          if (committed.current === text) { committed.current = null; return; }
          if (!commit(text)) { /* keep text so the user can fix it */ } else setText((t) => (t.trim() === '' ? shown : t));
          committed.current = null;
        }}
        onKeyDown={(e) => {
          if (fieldShortcut(e, text.trim() !== shown, () => { setText(shown); setErr(null); })) return;
          if (e.ctrlKey || e.metaKey) return;
          if (e.key === 'Enter') { if (commit(text)) (e.target as HTMLInputElement).blur(); }
          else if (e.key === 'Escape') { cancelled.current = true; setText(shown); setErr(null); (e.target as HTMLInputElement).blur(); }
          else if (e.key === 'ArrowUp') { e.preventDefault(); nudge(1, e); }
          else if (e.key === 'ArrowDown') { e.preventDefault(); nudge(-1, e); }
        }}
      />
      {unit && <span className="unit">{unit}</span>}
      {err && <span className="err-msg" role="alert">{err}</span>}
    </span>
  );
}

export function TextField(props: { value: string; onCommit: (v: string) => void; label?: string; testId?: string; placeholder?: string; multiline?: boolean }) {
  const [text, setText] = useState(props.value);
  const focused = useRef(false);
  const cancelled = useRef(false);
  const prevValue = useRef(props.value);
  useEffect(() => { if (!focused.current || text === prevValue.current) setText(props.value); prevValue.current = props.value; /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [props.value]);
  const common = {
    value: text, 'aria-label': props.label, placeholder: props.placeholder, 'data-testid': props.testId, spellCheck: false,
    onFocus: () => { focused.current = true; },
    onChange: (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => setText(e.target.value),
    onBlur: () => { focused.current = false; if (cancelled.current) { cancelled.current = false; setText(props.value); return; } if (text !== props.value) props.onCommit(text); },
  };
  const keys = (e: React.KeyboardEvent, multiline: boolean) => {
    if (fieldShortcut(e, text !== props.value, () => setText(props.value))) return;
    if (e.ctrlKey || e.metaKey) return;
    if (e.key === 'Enter' && !multiline) (e.target as HTMLElement).blur();
    if (e.key === 'Escape') { cancelled.current = true; setText(props.value); (e.target as HTMLElement).blur(); }
  };
  if (props.multiline) return <textarea className="text" rows={6} {...common} onKeyDown={(e) => keys(e, true)} />;
  return <input className="text" type="text" {...common} onKeyDown={(e) => keys(e, false)} />;
}

export function SelectField<T extends string>(props: { value: T; onChange: (v: T) => void; options: { value: T; label: string }[]; label?: string; testId?: string; disabled?: boolean }) {
  return (
    <select className="select" value={props.value} aria-label={props.label} data-testid={props.testId} disabled={props.disabled} onChange={(e) => props.onChange(e.target.value as T)} onKeyDown={(e) => { fieldShortcut(e, false, () => {}); }}>
      {props.options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
    </select>
  );
}

export function Check(props: { checked: boolean; onChange: (v: boolean) => void; label: string; testId?: string; disabled?: boolean }) {
  return (
    <label className="check">
      <input type="checkbox" checked={props.checked} disabled={props.disabled} data-testid={props.testId} onChange={(e) => props.onChange(e.target.checked)} />
      <span>{props.label}</span>
    </label>
  );
}

export function Readout(props: { label: string; value: string; title?: string }) {
  return (
    <div className="row readout" title={props.title}>
      <span className="row-l">{props.label}</span>
      <span className="row-c mono">{props.value}</span>
    </div>
  );
}

export function Menu(props: { label: ReactNode; children: (close: () => void) => ReactNode; testId?: string; title?: string; align?: 'left' | 'right' }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const h = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    const k = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    window.addEventListener('mousedown', h); window.addEventListener('keydown', k);
    return () => { window.removeEventListener('mousedown', h); window.removeEventListener('keydown', k); };
  }, [open]);
  return (
    <div className="menu" ref={ref}>
      <button type="button" className={`menu-btn ${open ? 'open' : ''}`} aria-haspopup="menu" aria-expanded={open} title={props.title} data-testid={props.testId} onClick={() => setOpen(!open)}>{props.label}</button>
      {open && <div className={`menu-pop ${props.align === 'right' ? 'right' : ''}`} role="menu">{props.children(() => setOpen(false))}</div>}
    </div>
  );
}

export function MenuItem(props: { onClick: () => void; children: ReactNode; shortcut?: string; disabled?: boolean; testId?: string; sub?: string }) {
  return (
    <button type="button" role="menuitem" className="menu-item" disabled={props.disabled} data-testid={props.testId} onClick={props.onClick}>
      <span className="mi-main">{props.children}{props.sub && <span className="mi-sub">{props.sub}</span>}</span>
      {props.shortcut && <kbd>{props.shortcut}</kbd>}
    </button>
  );
}
