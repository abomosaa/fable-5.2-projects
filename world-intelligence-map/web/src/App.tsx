import { useCallback, useEffect, useRef, useState } from 'react';
import { api, ApiError, serverNow } from './api';
import { DetailDrawer } from './components/DetailDrawer';
import { Legend } from './components/Legend';
import { Sidebar } from './components/Sidebar';
import { Timeline } from './components/Timeline';
import { TopBar } from './components/TopBar';
import { fmtTime } from './lib/format';
import { MapView } from './map/MapView';
import { useStore } from './state/store';
import type { SourceStatus } from './types';

const STATUS_WORD: Record<SourceStatus, string> = {
  healthy: 'healthy', delayed: 'delayed', rate_limited: 'rate limited', stale: 'stale', unavailable: 'unavailable', misconfigured: 'not configured', pending: 'pending', disabled: 'disabled',
};

/** Loads the catalog; shows a retryable error instead of a blank page when the API is down. */
function useMeta() {
  const setMeta = useStore((s) => s.setMeta);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const ac = new AbortController();
    setError(null);
    api.meta(ac.signal).then(setMeta).catch((err: unknown) => {
      if ((err as Error).name !== 'AbortError') setError(err instanceof ApiError ? err.message : 'Could not load the layer catalog.');
    });
    return () => ac.abort();
  }, [attempt, setMeta]);
  return { error, retry: () => setAttempt((a) => a + 1) };
}

/** Source health: initial load, periodic refresh, and refresh after every ingest event. Announces status changes. */
function useSources() {
  const meta = useStore((s) => s.meta);
  const prev = useRef(new Map<string, SourceStatus>());
  const load = useCallback(() => {
    api.sources().then((res) => {
      const st = useStore.getState();
      st.setSources(res.sources, null);
      // announce status changes of sources that feed enabled layers
      const enabled = new Set(st.enabled ?? []);
      for (const s of res.sources) {
        const before = prev.current.get(s.manifest.id);
        const now = s.health.status;
        if (before && before !== now && before !== 'pending' && s.manifest.layers.some((l) => enabled.has(l.id))) {
          st.toast(now === 'healthy' ? 'info' : 'warn', `${s.manifest.provider}: ${STATUS_WORD[before]} → ${STATUS_WORD[now]}`);
        }
        prev.current.set(s.manifest.id, now);
      }
    }).catch((err: unknown) => useStore.getState().setSources(useStore.getState().sources, err instanceof ApiError ? err.message : 'Source health unavailable'));
  }, []);
  useEffect(() => {
    if (!meta) return;
    load();
    const t = setInterval(load, 20_000);
    return () => clearInterval(t);
  }, [meta, load]);
  return load;
}

/** Server-sent events: when a source that feeds an enabled layer ingests changes, the map refreshes. */
function useLiveStream(reloadSources: () => void) {
  const meta = useStore((s) => s.meta);
  useEffect(() => {
    if (!meta || typeof EventSource === 'undefined') return;
    const es = new EventSource('/api/stream');
    let bump: ReturnType<typeof setTimeout> | undefined;
    let src: ReturnType<typeof setTimeout> | undefined;
    es.addEventListener('hello', () => useStore.getState().setLiveConnected(true));
    es.addEventListener('ingest', (ev) => {
      try {
        const e = JSON.parse((ev as MessageEvent<string>).data) as { layers: string[]; sourceId: string };
        const st = useStore.getState();
        const enabled = new Set(st.enabled ?? []);
        if (e.layers.some((l) => enabled.has(l))) {
          clearTimeout(bump);
          bump = setTimeout(() => useStore.getState().bumpData(), 600);
        }
        clearTimeout(src);
        src = setTimeout(reloadSources, 500);
      } catch {
        /* ignore malformed event */
      }
    });
    es.onerror = () => useStore.getState().setLiveConnected(false);
    es.onopen = () => useStore.getState().setLiveConnected(true);
    return () => {
      clearTimeout(bump);
      clearTimeout(src);
      es.close();
    };
  }, [meta, reloadSources]);
}

/** Timeline playback: advances the cursor through the selected range. */
function usePlayback() {
  const playing = useStore((s) => s.playing);
  const speed = useStore((s) => s.speed);
  useEffect(() => {
    if (!playing) return;
    const t = setInterval(() => {
      const st = useStore.getState();
      if (st.time.mode !== 'range') return st.setPlaying(false);
      const step = (st.time.to - st.time.from) / 120;
      const next = st.time.cursor + step;
      if (next >= st.time.to) {
        useStore.setState({ time: { ...st.time, cursor: st.time.to }, playing: false });
      } else {
        useStore.setState({ time: { ...st.time, cursor: next } });
      }
    }, 650 / speed);
    return () => clearInterval(t);
  }, [playing, speed]);
}

function FixtureBanner() {
  const meta = useStore((s) => s.meta)!;
  const [, tick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 15_000);
    return () => clearInterval(t);
  }, []);
  return (
    <div className="fixture-banner" role="status" data-testid="fixture-banner">
      <strong>FIXTURE DATA</strong>
      <span className="banner-long">
        Bundled sample payloads replayed on a simulated clock ({fmtTime(serverNow())}). <b>Not live intelligence.</b>
        {meta.demoScenario.length > 0 && ' Some sources are scripted to fail and recover — see Sources.'}
      </span>
      <span className="banner-short" aria-hidden="true">
        Sample data · <b>Not live intelligence</b>
      </span>
    </div>
  );
}

function MapStatus() {
  const status = useStore((s) => s.mapStatus);
  const enabled = useStore((s) => s.enabled);
  const bump = useStore((s) => s.bumpData);
  if (status.error) {
    return (
      <div className="map-chip error" role="alert">
        <span>Map data could not be refreshed: {status.error}</span>
        <button type="button" onClick={bump}>Retry</button>
      </div>
    );
  }
  if (enabled && enabled.length === 0) {
    return <div className="map-chip" data-testid="all-off-chip">All layers are off — basemap only. Enable layers in the catalog.</div>;
  }
  if (status.loading) return <div className="map-chip subtle" aria-hidden="true"><span className="spinner" /> Loading…</div>;
  if (enabled && enabled.length > 0 && status.lastUpdated && status.total === 0) {
    return <div className="map-chip">No records match the enabled layers, filters and time range in this view.</div>;
  }
  return null;
}

function Toasts() {
  const toasts = useStore((s) => s.toasts);
  const dismiss = useStore((s) => s.dismissToast);
  return (
    <div className="toasts" role="status" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} className={`toast ${t.kind}`}>
          <span>{t.text}</span>
          <button type="button" aria-label="Dismiss notification" onClick={() => dismiss(t.id)}>×</button>
        </div>
      ))}
    </div>
  );
}

export function App() {
  const meta = useStore((s) => s.meta);
  const theme = useStore((s) => s.theme);
  const { error, retry } = useMeta();
  const reloadSources = useSources();
  useLiveStream(reloadSources);
  usePlayback();

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    document.querySelector('meta[name="color-scheme"]')?.setAttribute('content', theme);
  }, [theme]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        const st = useStore.getState();
        if (st.selected) st.select(null);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  if (error) {
    return (
      <div className="boot" role="alert">
        <h1>World Intelligence Map</h1>
        <p>{error}</p>
        <p className="muted">The API server may still be starting.</p>
        <button type="button" className="btn primary" onClick={retry}>Try again</button>
      </div>
    );
  }
  if (!meta) {
    return (
      <div className="boot" aria-busy="true">
        <span className="spinner large" />
        <p>Loading layer catalog…</p>
      </div>
    );
  }

  return (
    <div className={`app ${meta.fixture ? 'is-fixture' : 'is-live'}`}>
      <a className="skip-link" href="#sidebar">Skip to layer catalog and results</a>
      {meta.fixture && <FixtureBanner />}
      <TopBar />
      <main className="stage">
        <MapView meta={meta} />
        {meta.fixture && <div className="watermark" aria-hidden="true">FIXTURE DATA</div>}
        <MapStatus />
        <Sidebar onReloadSources={reloadSources} />
        <DetailDrawer />
        <Legend />
      </main>
      <Timeline />
      <Toasts />
    </div>
  );
}
