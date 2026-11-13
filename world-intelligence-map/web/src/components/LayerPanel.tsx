import { useMemo, useState } from 'react';
import { fmtCount } from '../lib/format';
import { useStore } from '../state/store';
import type { LayerInfo } from '../types';
import { LayerSymbol, StatusBadge } from './Symbol';

const TIME_MODEL: Record<string, string> = {
  event: 'Events (shown when they occurred inside the time window)',
  interval: 'Active periods (shown while they overlap the time window)',
  snapshot: 'Current state (latest observation)',
  reference: 'Reference data (always shown)',
  indicator: 'Country statistic (latest value at the end of the time window)',
};

export function LayerPanel() {
  const meta = useStore((s) => s.meta)!;
  const enabled = useStore((s) => s.enabled) ?? [];
  const counts = useStore((s) => s.mapStatus.counts);
  const hidden = useStore((s) => s.mapStatus.hiddenByZoom);
  const sources = useStore((s) => s.sources);
  const toggle = useStore((s) => s.toggleLayer);
  const setLayers = useStore((s) => s.setLayers);
  const allOff = useStore((s) => s.allLayersOff);
  const reset = useStore((s) => s.resetLayers);
  const [q, setQ] = useState('');
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [open, setOpen] = useState<string | null>(null);

  const srcById = useMemo(() => new Map(sources.map((s) => [s.manifest.id, s])), [sources]);
  const on = useMemo(() => new Set(enabled), [enabled]);
  const needle = q.trim().toLowerCase();

  const groups = useMemo(() => {
    const match = (l: LayerInfo) => {
      if (!needle) return true;
      const src = srcById.get(l.sourceId)?.manifest;
      return [l.name, l.description, l.category, l.id, src?.provider, src?.dataset, meta.domains.find((d) => d.id === l.domain)?.name]
        .some((t) => t?.toLowerCase().includes(needle));
    };
    return meta.domains
      .map((d) => ({ domain: d, all: meta.layers.filter((l) => l.domain === d.id), layers: meta.layers.filter((l) => l.domain === d.id && match(l)) }))
      .filter((g) => g.layers.length > 0);
  }, [meta, needle, srcById]);

  return (
    <section className="panel" aria-label="Layer catalog">
      <div className="panel-head">
        <div className="row">
          <label className="sr-only" htmlFor="layer-search">Search layer catalog</label>
          <input id="layer-search" type="search" placeholder={`Search ${meta.layers.length} layers…`} value={q} onChange={(e) => setQ(e.target.value)} data-testid="layer-search" />
        </div>
        <div className="row between">
          <span className="muted" data-testid="enabled-count">{enabled.length} of {meta.layers.length} layers on</span>
          <span className="btn-group">
            <button type="button" className="btn small" onClick={reset}>Defaults</button>
            <button type="button" className="btn small" onClick={allOff} disabled={enabled.length === 0} data-testid="all-off">All off</button>
          </span>
        </div>
      </div>
      <div className="panel-body">
        {groups.length === 0 && <p className="empty">No layers match “{q}”.</p>}
        {groups.map(({ domain, all, layers }) => {
          const nOn = all.filter((l) => on.has(l.id)).length;
          const state = nOn === 0 ? 'none' : nOn === all.length ? 'all' : 'some';
          const isCollapsed = !needle && collapsed[domain.id];
          return (
            <div className="group" key={domain.id} data-domain={domain.id}>
              <div className="group-head">
                <button
                  type="button"
                  className="group-toggle"
                  aria-expanded={!isCollapsed}
                  onClick={() => setCollapsed((c) => ({ ...c, [domain.id]: !c[domain.id] }))}
                  title={domain.description}
                >
                  <span className={`chev ${isCollapsed ? '' : 'open'}`} aria-hidden="true">▸</span>
                  <span className="group-name">{domain.name}</span>
                  <span className="muted count">{nOn}/{all.length}</span>
                </button>
                <label className="group-switch" title={state === 'all' ? `Turn off all ${domain.name} layers` : `Turn on all ${domain.name} layers`}>
                  <input
                    type="checkbox"
                    role="switch"
                    checked={state === 'all'}
                    ref={(el) => {
                      if (el) el.indeterminate = state === 'some';
                    }}
                    aria-checked={state === 'some' ? 'mixed' : state === 'all'}
                    aria-label={`All ${domain.name} layers`}
                    data-testid={`group-${domain.id}`}
                    onChange={() => setLayers(all.map((l) => l.id), state !== 'all')}
                  />
                  <span className="switch-track" aria-hidden="true" />
                </label>
              </div>
              {!isCollapsed && (
                <ul className="layer-list">
                  {layers.map((l) => {
                    const src = srcById.get(l.sourceId);
                    const status = src?.health.status;
                    const isOn = on.has(l.id);
                    return (
                      <li key={l.id} className={`layer ${isOn ? 'on' : ''}`}>
                        <label className="layer-main">
                          <input type="checkbox" role="switch" checked={isOn} onChange={() => toggle(l.id)} data-testid={`layer-${l.id}`} aria-describedby={`ld-${l.id}`} />
                          <span className="switch-track" aria-hidden="true" />
                          <LayerSymbol layer={l} />
                          <span className="layer-name">{l.name}</span>
                        </label>
                        <span className="layer-meta">
                          {isOn && hidden.includes(l.id) && <span className="tag" title={`Shown from zoom ${l.render.minZoom}`}>zoom in</span>}
                          {isOn && !hidden.includes(l.id) && counts[l.id] != null && <span className="muted count" title="Matching records in the current view">{fmtCount(counts[l.id]!)}</span>}
                          {status && status !== 'healthy' && <StatusBadge status={status} compact />}
                          <button type="button" className="info-btn" aria-expanded={open === l.id} aria-label={`About ${l.name}`} onClick={() => setOpen(open === l.id ? null : l.id)}>i</button>
                        </span>
                        <div id={`ld-${l.id}`} className="layer-desc" hidden={open !== l.id}>
                          <p>{l.description}</p>
                          <p className="muted">
                            Source: {src ? `${src.manifest.provider} — ${src.manifest.dataset}` : l.sourceId}
                            <br />
                            {TIME_MODEL[l.timeModel]}
                            {l.retentionDays != null ? ` · kept ${l.retentionDays} days` : ' · kept while upstream lists it'}
                          </p>
                          {src && src.health.status !== 'healthy' && <p className="muted">{src.health.message}</p>}
                        </div>
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
}
