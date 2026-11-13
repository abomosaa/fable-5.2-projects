import { useMemo, useState } from 'react';
import { SEVERITY_NAMES } from '../lib/format';
import { useStore } from '../state/store';
import { FRESHNESS, FRESH_HELP, FRESH_LABEL, type Freshness } from '../types';
import { activeFilterCount } from './TopBar';

function CheckList({ label, options, selected, onChange, searchable }: { label: string; options: { id: string; label: string }[]; selected: string[]; onChange: (v: string[]) => void; searchable?: boolean }) {
  const [q, setQ] = useState('');
  const shown = q ? options.filter((o) => o.label.toLowerCase().includes(q.toLowerCase())) : options;
  const sel = new Set(selected);
  return (
    <fieldset className="field">
      <legend>
        {label} {selected.length > 0 && <span className="badge">{selected.length}</span>}
        {selected.length > 0 && <button type="button" className="link" onClick={() => onChange([])}>clear</button>}
      </legend>
      {searchable && <input type="search" placeholder={`Find ${label.toLowerCase()}…`} value={q} onChange={(e) => setQ(e.target.value)} aria-label={`Find ${label}`} />}
      <div className="checklist">
        {shown.length === 0 && <span className="muted">Nothing matches.</span>}
        {shown.map((o) => (
          <label key={o.id} className="check">
            <input type="checkbox" checked={sel.has(o.id)} onChange={() => onChange(sel.has(o.id) ? selected.filter((x) => x !== o.id) : [...selected, o.id])} />
            <span>{o.label}</span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}

export function FilterPanel() {
  const meta = useStore((s) => s.meta)!;
  const f = useStore((s) => s.filters);
  const set = useStore((s) => s.setFilters);
  const reset = useStore((s) => s.resetFilters);
  const sources = useStore((s) => s.sources);
  const enabled = useStore((s) => s.enabled) ?? [];
  const n = activeFilterCount(f);

  const enabledLayers = useMemo(() => meta.layers.filter((l) => enabled.includes(l.id)), [meta, enabled]);
  // Options come from the enabled layers only – disabled layers contribute nothing, here as everywhere.
  const sourceOptions = useMemo(() => {
    const ids = new Set([...enabledLayers.map((l) => l.sourceId), ...f.sources]);
    return [...ids].map((id) => ({ id, label: sources.find((s) => s.manifest.id === id)?.manifest.provider ?? id })).sort((a, b) => a.label.localeCompare(b.label));
  }, [enabledLayers, sources, f.sources]);
  const categoryOptions = useMemo(() => {
    const ids = new Set([...enabledLayers.map((l) => l.category), ...f.categories]);
    return [...ids].sort().map((id) => ({ id, label: id.replace(/[-_]/g, ' ') }));
  }, [enabledLayers, f.categories]);
  const countryOptions = useMemo(() => meta.countries.map((c) => ({ id: c.iso3, label: c.name })).sort((a, b) => a.label.localeCompare(b.label)), [meta]);

  return (
    <section className="panel" aria-label="Filters">
      <div className="panel-head">
        <div className="row between">
          <span className="muted">{n === 0 ? 'No filters active' : `${n} filter${n > 1 ? 's' : ''} active`}</span>
          <button type="button" className="btn small" onClick={reset} disabled={n === 0} data-testid="reset-filters">Reset</button>
        </div>
        <p className="hint">Filters apply to the map, counts, legend, results and search alike. Time is set on the timeline.</p>
      </div>
      <div className="panel-body form">
        <fieldset className="field">
          <legend>Severity</legend>
          <div className="row">
            <label>
              <span className="sr-only">Minimum severity</span>
              <select value={f.sevMin} onChange={(e) => set({ sevMin: Number(e.target.value), sevMax: Math.max(f.sevMax, Number(e.target.value)) })} data-testid="sev-min">
                {SEVERITY_NAMES.map((name, i) => <option key={i} value={i}>{i} · {name}</option>)}
              </select>
            </label>
            <span className="muted">to</span>
            <label>
              <span className="sr-only">Maximum severity</span>
              <select value={f.sevMax} onChange={(e) => set({ sevMax: Number(e.target.value), sevMin: Math.min(f.sevMin, Number(e.target.value)) })}>
                {SEVERITY_NAMES.map((name, i) => <option key={i} value={i}>{i} · {name}</option>)}
              </select>
            </label>
          </div>
          <label className="check">
            <input type="checkbox" checked={f.sevUnknown} onChange={(e) => set({ sevUnknown: e.target.checked })} data-testid="sev-unknown" />
            <span>Include records without a severity</span>
          </label>
          <p className="hint">Normalised 0–4 scale. Where a source publishes only a number or colour, the mapping is this application’s and is marked “derived” on the record.</p>
        </fieldset>

        <fieldset className="field">
          <legend>Confidence</legend>
          <div className="row">
            <input type="range" min={0} max={1} step={0.05} value={f.confMin} onChange={(e) => set({ confMin: Number(e.target.value) })} aria-label="Minimum confidence" aria-valuetext={`${Math.round(f.confMin * 100)} percent`} data-testid="conf-min" />
            <output className="mono">≥ {Math.round(f.confMin * 100)}%</output>
          </div>
          <label className="check">
            <input type="checkbox" checked={f.confUnknown} onChange={(e) => set({ confUnknown: e.target.checked })} />
            <span>Include records without a confidence value</span>
          </label>
        </fieldset>

        <fieldset className="field">
          <legend>
            Freshness {f.fresh.length > 0 && <button type="button" className="link" onClick={() => set({ fresh: [] })}>clear</button>}
          </legend>
          <div className="checklist two">
            {FRESHNESS.map((fr) => (
              <label key={fr} className="check" title={FRESH_HELP[fr]}>
                <input
                  type="checkbox"
                  checked={f.fresh.includes(fr)}
                  data-testid={`fresh-${fr}`}
                  onChange={() => set({ fresh: f.fresh.includes(fr) ? f.fresh.filter((x) => x !== fr) : ([...f.fresh, fr] as Freshness[]) })}
                />
                <span>{FRESH_LABEL[fr]}</span>
              </label>
            ))}
          </div>
          <p className="hint">Nothing ticked = all. Freshness uses the upstream event/update time and whether the source is still being fetched.</p>
        </fieldset>

        <CheckList label="Source" options={sourceOptions} selected={f.sources} onChange={(v) => set({ sources: v })} searchable={sourceOptions.length > 8} />
        <CheckList label="Category" options={categoryOptions} selected={f.categories} onChange={(v) => set({ categories: v })} searchable={categoryOptions.length > 8} />
        <CheckList label="Country" options={countryOptions} selected={f.countries} onChange={(v) => set({ countries: v })} searchable />
      </div>
    </section>
  );
}
