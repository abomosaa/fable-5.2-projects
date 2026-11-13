import { useEffect, useMemo, useState } from 'react';
import { api, ApiError, filterParams, serverNow } from '../api';
import { fmtAgo, SEVERITY_NAMES } from '../lib/format';
import { layerMap, useStore } from '../state/store';
import { FRESH_LABEL, type ListItem } from '../types';
import { LayerSymbol } from './Symbol';

type Tab = 'latest' | 'priority';

export function SeverityPill({ severity }: { severity: number | null }) {
  if (severity == null) return null;
  return <span className={`sev sev-${severity}`}>{SEVERITY_NAMES[severity]}</span>;
}

export function FeedPanel() {
  const meta = useStore((s) => s.meta)!;
  const enabled = useStore((s) => s.enabled);
  const filters = useStore((s) => s.filters);
  const time = useStore((s) => s.time);
  const bbox = useStore((s) => s.viewBbox);
  const dataVersion = useStore((s) => s.dataVersion);
  const focus = useStore((s) => s.clusterFocus);
  const selected = useStore((s) => s.selected);
  const [tab, setTab] = useState<Tab>('latest');
  const [inView, setInView] = useState(true);
  const [state, setState] = useState<{ items: ListItem[]; total: number; loading: boolean; error: string | null }>({ items: [], total: 0, loading: false, error: null });
  const layers = useMemo(() => layerMap(meta), [meta]);

  const searching = filters.q.trim().length > 0;
  const useBox = focus ? focus.bbox : inView && !searching ? bbox : null;
  const boxKey = useBox ? useBox.map((n) => n.toFixed(3)).join(',') : '';

  useEffect(() => {
    if (!enabled) return;
    if (enabled.length === 0) {
      setState({ items: [], total: 0, loading: false, error: null });
      return;
    }
    const ac = new AbortController();
    setState((s) => ({ ...s, loading: true, error: null }));
    const f = tab === 'priority' && !focus ? { ...filters, sevMin: Math.max(filters.sevMin, 3), sevUnknown: false } : filters;
    const t = setTimeout(() => {
      api
        .list(filterParams(enabled, f, time), { bbox: useBox, sort: tab === 'priority' ? 'severity' : 'time', limit: 150, global: !focus }, ac.signal)
        .then((res) => setState({ items: res.items, total: res.total, loading: false, error: null }))
        .catch((err: unknown) => {
          if ((err as Error).name === 'AbortError') return;
          setState((s) => ({ ...s, loading: false, error: err instanceof ApiError ? err.message : 'Could not load results.' }));
        });
    }, 150);
    return () => {
      clearTimeout(t);
      ac.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, filters, time, boxKey, dataVersion, tab, focus]);

  const open = (it: ListItem) => {
    const st = useStore.getState();
    st.select(it.id);
    if (it.point) st.requestFly({ lng: it.point[0], lat: it.point[1] });
  };

  const now = serverNow();
  return (
    <section className="panel" aria-label="Results" id="results">
      <div className="panel-head">
        {focus ? (
          <div className="row between">
            <strong>{focus.count} records at this location</strong>
            <button type="button" className="btn small" onClick={() => useStore.getState().setClusterFocus(null)}>Back to all results</button>
          </div>
        ) : (
          <>
            <div className="seg" role="tablist" aria-label="Result ordering">
              <button type="button" role="tab" aria-selected={tab === 'latest'} className={tab === 'latest' ? 'active' : ''} onClick={() => setTab('latest')}>Latest</button>
              <button type="button" role="tab" aria-selected={tab === 'priority'} className={tab === 'priority' ? 'active' : ''} onClick={() => setTab('priority')} data-testid="tab-priority">Priority alerts</button>
            </div>
            <label className="check">
              <input type="checkbox" checked={inView && !searching} disabled={searching} onChange={(e) => setInView(e.target.checked)} />
              <span>Only what is in the map view{searching ? ' (search covers the whole world)' : ''}</span>
            </label>
          </>
        )}
        <p className="muted" data-testid="result-count" aria-live="polite">
          {state.loading ? 'Loading…' : state.error ? '' : `${state.total.toLocaleString('en-US')} record${state.total === 1 ? '' : 's'}${state.total > state.items.length ? ` · showing ${state.items.length}` : ''}${searching ? ` matching “${filters.q.trim()}”` : ''}`}
        </p>
      </div>
      <div className="panel-body">
        {state.error && <p className="empty error" role="alert">{state.error}</p>}
        {!state.error && enabled && enabled.length === 0 && <p className="empty">No layers are enabled, so there is nothing to list. Turn layers on in the Layers panel.</p>}
        {!state.error && !state.loading && enabled && enabled.length > 0 && state.items.length === 0 && (
          <p className="empty">
            {tab === 'priority' ? 'No severe or extreme records match the current layers, filters and time range.' : 'No records match the current layers, filters and time range.'}
          </p>
        )}
        <ul className="feed" data-testid="feed">
          {state.items.map((it) => {
            const layer = layers.get(it.layerId);
            return (
              <li key={it.id}>
                <button type="button" className={`feed-item ${selected === it.id ? 'selected' : ''}`} onClick={() => open(it)} data-record-id={it.id}>
                  <span className="feed-sym">{layer && <LayerSymbol layer={layer} size={18} />}</span>
                  <span className="feed-text">
                    <span className="feed-title">{it.title}</span>
                    <span className="feed-sub">
                      {layer?.name ?? it.layerId}
                      {it.time != null && <> · {fmtAgo(it.time, now)}</>}
                      {it.kind === 'global' && <> · <span className="tag">not location-specific</span></>}
                    </span>
                  </span>
                  <span className="feed-tags">
                    <SeverityPill severity={it.severity} />
                    {(it.freshness === 'stale' || it.freshness === 'expired') && <span className={`tag fr-${it.freshness}`}>{FRESH_LABEL[it.freshness]}</span>}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      </div>
    </section>
  );
}
