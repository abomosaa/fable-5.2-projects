import { useEffect, useRef, useState } from 'react';
import { currentShareUrl, useStore, type Panel } from '../state/store';
import { DEFAULT_FILTERS, type Filters } from '../types';

export function activeFilterCount(f: Filters): number {
  let n = 0;
  if (f.sources.length) n++;
  if (f.categories.length) n++;
  if (f.countries.length) n++;
  if (f.sevMin !== DEFAULT_FILTERS.sevMin || f.sevMax !== DEFAULT_FILTERS.sevMax || !f.sevUnknown) n++;
  if (f.confMin > 0 || !f.confUnknown) n++;
  if (f.fresh.length) n++;
  if (f.q.trim()) n++;
  return n;
}

export function TopBar() {
  const meta = useStore((s) => s.meta)!;
  const panel = useStore((s) => s.panel);
  const setPanel = useStore((s) => s.setPanel);
  const theme = useStore((s) => s.theme);
  const palette = useStore((s) => s.palette);
  const filters = useStore((s) => s.filters);
  const sources = useStore((s) => s.sources);
  const enabledCount = useStore((s) => s.enabled?.length ?? 0);
  const toast = useStore((s) => s.toast);
  const [q, setQ] = useState(filters.q);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);

  useEffect(() => setQ(filters.q), [filters.q]);

  const onSearch = (v: string) => {
    setQ(v);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      const st = useStore.getState();
      st.setFilters({ q: v });
      if (v.trim()) st.setPanel('feed');
    }, 280);
  };

  const share = async () => {
    const url = currentShareUrl();
    try {
      await navigator.clipboard.writeText(url);
      toast('info', 'Link copied. It restores this map position, time range, filters and layers.');
    } catch {
      history.replaceState(null, '', url);
      toast('info', 'Link is in the address bar — copy it from there.');
    }
  };

  const problems = sources.filter((s) => !['healthy', 'pending', 'disabled'].includes(s.health.status)).length;
  const nFilters = activeFilterCount(filters);
  const tab = (id: Panel, label: string, badge?: string | number, warn?: boolean) => (
    <button
      type="button"
      className={`tab ${panel === id ? 'active' : ''}`}
      aria-pressed={panel === id}
      aria-controls="sidebar"
      data-testid={`tab-${id}`}
      onClick={() => setPanel(panel === id ? null : id)}
    >
      {label}
      {badge != null && badge !== 0 && <span className={`badge ${warn ? 'warn' : ''}`}>{badge}</span>}
    </button>
  );

  return (
    <header className="topbar">
      <div className="brand">
        <svg viewBox="0 0 32 32" width="22" height="22" aria-hidden="true">
          <circle cx="16" cy="16" r="11" fill="none" stroke="currentColor" strokeWidth="2" />
          <path d="M5 16h22M16 5c-5 3.5-5 18.5 0 22M16 5c5 3.5 5 18.5 0 22" fill="none" stroke="currentColor" strokeWidth="1.5" />
        </svg>
        <h1>World Intelligence Map</h1>
        <span className={`mode-chip ${meta.fixture ? 'fixture' : 'live'}`} data-testid="mode-chip" title={meta.fixture ? meta.fixtureNotice ?? '' : 'Real upstream sources, fetched by the server'}>
          {meta.fixture ? 'FIXTURE' : 'LIVE'}
        </span>
      </div>
      <div className="search">
        <label className="sr-only" htmlFor="global-search">Search records in enabled layers</label>
        <input
          id="global-search"
          type="search"
          placeholder="Search enabled layers…"
          value={q}
          onChange={(e) => onSearch(e.target.value)}
          autoComplete="off"
          spellCheck={false}
          data-testid="search"
        />
      </div>
      <nav className="tabs" aria-label="Panels">
        {tab('layers', 'Layers', enabledCount)}
        {tab('filters', 'Filters', nFilters)}
        {tab('feed', 'Results')}
        {tab('sources', 'Sources', problems || undefined, true)}
      </nav>
      <div className="actions">
        <button type="button" className="icon-btn" onClick={share} title="Copy shareable link" aria-label="Copy shareable link" data-testid="share">
          <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" /></svg>
        </button>
        <button
          type="button"
          className={`icon-btn ${palette === 'cvd' ? 'on' : ''}`}
          onClick={() => useStore.getState().setPalette(palette === 'cvd' ? 'standard' : 'cvd')}
          aria-pressed={palette === 'cvd'}
          title="Colour-blind-safe palette"
          aria-label="Colour-blind-safe palette"
          data-testid="palette-toggle"
        >
          <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><circle cx="12" cy="12" r="8.5" fill="none" stroke="currentColor" strokeWidth="2" /><path d="M12 3.5v17a8.5 8.5 0 0 0 0-17z" fill="currentColor" /></svg>
        </button>
        <button
          type="button"
          className="icon-btn"
          onClick={() => useStore.getState().setTheme(theme === 'dark' ? 'light' : 'dark')}
          title={theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}
          aria-label={theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}
          data-testid="theme-toggle"
        >
          {theme === 'dark' ? (
            <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><circle cx="12" cy="12" r="4.5" fill="currentColor" /><path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M4.9 19.1L7 17M17 7l2.1-2.1" stroke="currentColor" strokeWidth="2" strokeLinecap="round" /></svg>
          ) : (
            <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d="M20 14.5A8.5 8.5 0 0 1 9.5 4 8.5 8.5 0 1 0 20 14.5z" fill="currentColor" /></svg>
          )}
        </button>
      </div>
    </header>
  );
}
