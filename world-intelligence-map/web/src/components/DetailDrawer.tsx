import { useEffect, useRef, useState } from 'react';
import { api, ApiError, serverNow } from '../api';
import { fmtAgo, fmtNumber, fmtTime, humanizeKey, SEVERITY_NAMES } from '../lib/format';
import { currentShareUrl, useStore } from '../state/store';
import { FRESH_HELP, FRESH_LABEL, type RecordDetail } from '../types';
import { StatusBadge } from './Symbol';

function ExtLink({ href, children }: { href: string | null | undefined; children: React.ReactNode }) {
  if (!href || !/^https?:\/\//i.test(href)) return <span>{children}</span>;
  return <a href={href} target="_blank" rel="noopener noreferrer nofollow">{children}</a>;
}

function Derived({ on }: { on: boolean }) {
  return on ? <span className="tag derived" title="Inferred by this application, not stated by the source">derived</span> : null;
}

function selectionGeo(d: RecordDetail['record']): GeoJSON.FeatureCollection {
  const features: GeoJSON.Feature[] = [];
  if (d.geometry && d.geometry.type !== 'Point') features.push({ type: 'Feature', properties: {}, geometry: d.geometry });
  if (d.track && d.track.length > 1) {
    const parts: number[][][] = [[]];
    for (const p of d.track) {
      const cur = parts[parts.length - 1]!;
      const prev = cur[cur.length - 1];
      if (prev && Math.abs(p[0] - prev[0]!) > 180) parts.push([[p[0], p[1]]]);
      else cur.push([p[0], p[1]]);
    }
    for (const c of parts) if (c.length > 1) features.push({ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: c } });
  }
  if (d.point) features.push({ type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: d.point } });
  return { type: 'FeatureCollection', features };
}

export function DetailDrawer() {
  const selected = useStore((s) => s.selected);
  const dataVersion = useStore((s) => s.dataVersion);
  const [state, setState] = useState<{ id: string | null; data: RecordDetail | null; error: string | null; loading: boolean }>({ id: null, data: null, error: null, loading: false });
  const ref = useRef<HTMLElement>(null);
  const lastFocus = useRef<Element | null>(null);

  useEffect(() => {
    if (!selected) {
      setState({ id: null, data: null, error: null, loading: false });
      return;
    }
    const ac = new AbortController();
    setState((s) => ({ id: selected, data: s.id === selected ? s.data : null, error: null, loading: true }));
    api
      .record(selected, ac.signal)
      .then((data) => {
        setState({ id: selected, data, error: null, loading: false });
        useStore.setState({ selectionGeo: selectionGeo(data.record) });
      })
      .catch((err: unknown) => {
        if ((err as Error).name === 'AbortError') return;
        setState({ id: selected, data: null, error: err instanceof ApiError ? err.message : 'Could not load this record.', loading: false });
        useStore.setState({ selectionGeo: null });
      });
    return () => ac.abort();
  }, [selected, dataVersion]);

  // Move focus into the drawer when it opens, and back to where it came from when it closes.
  useEffect(() => {
    if (selected) {
      if (!ref.current?.contains(document.activeElement)) lastFocus.current = document.activeElement;
      ref.current?.focus({ preventScroll: true });
    } else if (lastFocus.current instanceof HTMLElement && document.contains(lastFocus.current)) {
      lastFocus.current.focus({ preventScroll: true });
    }
  }, [selected]);

  if (!selected) return null;
  const close = () => useStore.getState().select(null);
  const d = state.data?.record;
  const src = state.data?.source;
  const health = state.data?.sourceHealth;
  const now = serverNow();
  const derived = new Set(d?.provenance.derived ?? []);

  const copyLink = async () => {
    try {
      await navigator.clipboard.writeText(currentShareUrl());
      useStore.getState().toast('info', 'Link to this record copied.');
    } catch {
      useStore.getState().toast('info', 'Copy the link from the address bar.');
    }
  };

  return (
    <aside className="drawer" ref={ref} tabIndex={-1} role="dialog" aria-modal="false" aria-label="Record details" data-testid="drawer">
      <div className="drawer-head">
        <div className="drawer-kicker">
          {state.data?.layer?.name ?? 'Record'}
          {state.data?.fixture && <span className="tag fixture" data-testid="drawer-fixture">FIXTURE RECORD · not live</span>}
        </div>
        <button type="button" className="icon-btn" aria-label="Close details" onClick={close} data-testid="drawer-close">×</button>
      </div>

      {state.loading && !d && <div className="drawer-body"><p className="empty"><span className="spinner" /> Loading record…</p></div>}
      {state.error && (
        <div className="drawer-body">
          <p className="empty error" role="alert">{state.error}</p>
          <button type="button" className="btn" onClick={close}>Close</button>
        </div>
      )}

      {d && (
        <div className="drawer-body">
          <h2 data-testid="drawer-title">{d.title}</h2>
          <div className="chips">
            {d.severity != null && (
              <span className={`sev sev-${d.severity}`} title={`Normalised severity ${d.severity} of 4`}>
                {SEVERITY_NAMES[d.severity]}{d.severityLabel ? ` · ${d.severityLabel}` : ''}
              </span>
            )}
            <Derived on={d.severity != null && derived.has('severity')} />
            <span className={`tag fr-${d.freshness}`} title={FRESH_HELP[d.freshness]} data-testid="drawer-freshness">{FRESH_LABEL[d.freshness]}</span>
            {d.ongoing && <span className="tag">ongoing</span>}
          </div>

          {health && health.status !== 'healthy' && (
            <div className="callout warn" role="note">
              <StatusBadge status={health.status} /> <span>{health.message}</span>
            </div>
          )}
          {d.freshness === 'stale' && <div className="callout warn" role="note">This record could not be re-confirmed: its source has not been fetched successfully since {fmtTime(health?.lastSuccessAt)}. Treat it as old data.</div>}
          {d.freshness === 'expired' && <div className="callout" role="note">This record is past its upstream expiry or is no longer listed by the source.</div>}

          {d.description && <p className="desc">{d.description}</p>}
          {d.metric && (
            <p className="metric">
              <strong>{fmtNumber(d.metric.value, d.metric.unit)}</strong>
              <span>{d.metric.name}{d.metric.period ? ` · ${d.metric.period}` : ''}</span>
            </p>
          )}

          <h3>Source</h3>
          <dl className="kv">
            <dt>Provider</dt><dd>{d.provenance.provider}</dd>
            <dt>Dataset</dt><dd>{d.provenance.dataset}</dd>
            <dt>Original</dt>
            <dd data-testid="drawer-source-link">{d.url ? <ExtLink href={d.url}>Open at source ↗</ExtLink> : <span className="muted">The source provides no per-item link.</span>} {src && <> · <ExtLink href={src.documentationUrl}>dataset docs</ExtLink></>}</dd>
            <dt>Attribution</dt><dd>{d.attribution}</dd>
            {src && <><dt>Licence</dt><dd><ExtLink href={src.license.url}>{src.license.name}</ExtLink>{src.license.nonCommercialOnly ? ' · non-commercial only' : ''}</dd></>}
          </dl>

          <h3>Time</h3>
          <dl className="kv" data-testid="drawer-times">
            <dt>Event time</dt><dd>{d.occurredAt != null ? <>{fmtTime(d.occurredAt, { seconds: true })} <span className="muted">({fmtAgo(d.occurredAt, now)})</span></> : <span className="muted">not applicable</span>}</dd>
            {d.publishedAt != null && <><dt>Published</dt><dd>{fmtTime(d.publishedAt)}</dd></>}
            <dt>Last update (upstream)</dt><dd>{d.updatedAt != null ? <>{fmtTime(d.updatedAt)} <span className="muted">({fmtAgo(d.updatedAt, now)})</span></> : <span className="muted">not provided by source</span>}</dd>
            <dt>Fetched</dt><dd>{fmtTime(d.fetchedAt)} <span className="muted">({fmtAgo(d.fetchedAt, now)})</span></dd>
            <dt>First seen</dt><dd>{fmtTime(d.provenance.firstSeenAt)}</dd>
            {d.expiresAt != null && <><dt>Expires</dt><dd>{fmtTime(d.expiresAt)} <span className="muted">({fmtAgo(d.expiresAt, now)})</span></dd></>}
            {d.endedAt != null && <><dt>Ended / delisted</dt><dd>{fmtTime(d.endedAt)}</dd></>}
            <dt>Freshness</dt><dd>{FRESH_LABEL[d.freshness]} — {FRESH_HELP[d.freshness]}</dd>
          </dl>

          <h3>Confidence &amp; uncertainty</h3>
          <dl className="kv">
            <dt>Confidence</dt>
            <dd>
              {d.confidence != null ? <><strong>{Math.round(d.confidence * 100)}%</strong> <Derived on={derived.has('confidence')} /></> : <span className="muted">The source gives no basis for a confidence value.</span>}
              {d.confidenceBasis && <span className="block">{d.confidenceBasis}</span>}
            </dd>
            {d.uncertainty && Object.keys(d.uncertainty).length > 0 && (
              <>
                <dt>Uncertainty</dt>
                <dd>{Object.entries(d.uncertainty).map(([k, v]) => <span className="block" key={k}>{humanizeKey(k)}: {typeof v === 'number' ? fmtNumber(v) : v}</span>)}</dd>
              </>
            )}
            {src && <><dt>Source caveats</dt><dd>{src.confidenceNotes}</dd></>}
          </dl>

          <h3>Location</h3>
          <dl className="kv">
            <dt>Geometry</dt>
            <dd>
              {d.geometryKind === 'global' ? 'Not location-specific' : d.geometryKind} <Derived on={derived.has('geometry')} />
              {d.point && d.geometryKind !== 'country' && <span className="block mono">{d.point[1].toFixed(4)}, {d.point[0].toFixed(4)}</span>}
            </dd>
            {d.countries.length > 0 && <><dt>Country</dt><dd>{d.countries.join(', ')} <Derived on={derived.has('country')} /></dd></>}
          </dl>

          {Object.keys(d.attributes).length > 0 && (
            <>
              <h3>Upstream facts</h3>
              <dl className="kv" data-testid="drawer-attributes">
                {Object.entries(d.attributes).map(([k, v]) => (
                  <div key={k} className="kv-row">
                    <dt>{humanizeKey(k)}</dt>
                    <dd>{typeof v === 'boolean' ? (v ? 'yes' : 'no') : typeof v === 'number' ? (Number.isInteger(v) && Math.abs(v) > 1e11 ? String(v) : v.toLocaleString('en-US', { maximumFractionDigits: 4 })) : String(v)}</dd>
                  </div>
                ))}
              </dl>
            </>
          )}

          {d.incident && (
            <>
              <h3>Possibly related reports</h3>
              <div className="callout" data-testid="drawer-incident">
                <p>{d.incident.note}</p>
                <p className="muted">Rule: {String(d.incident.basis.rule ?? '')}</p>
                <ul className="plain">
                  {d.incident.members.map((m) => (
                    <li key={m.id}>
                      <button type="button" className="link" onClick={() => useStore.getState().select(m.id)}>{m.title}</button>
                      <span className="muted"> · {m.sourceId}{m.basis.distanceKm != null ? ` · ${String(m.basis.distanceKm)} km apart` : ''}</span>
                    </li>
                  ))}
                </ul>
              </div>
            </>
          )}

          <h3>Provenance</h3>
          <dl className="kv" data-testid="drawer-provenance">
            <dt>Record ID</dt><dd className="mono wrap">{d.id}</dd>
            <dt>Upstream ID</dt><dd className="mono wrap">{d.upstreamId}</dd>
            <dt>Fetched from</dt><dd className="mono wrap">{d.provenance.fetchUrls.join('\n') || '—'}</dd>
            <dt>Adapter</dt><dd>{d.sourceId} v{d.provenance.adapterVersion} · revision {d.provenance.revision}</dd>
            <dt>Content hash</dt><dd className="mono">{d.provenance.contentHash}</dd>
            <dt>Inferred fields</dt><dd>{d.provenance.derived.length ? d.provenance.derived.join(', ') : 'none — all shown values are as published'}</dd>
            {d.provenance.normalisation.length > 0 && <><dt>Normalisation</dt><dd>{d.provenance.normalisation.join('; ')}</dd></>}
            <dt>Data origin</dt><dd>{d.provenance.fixture ? 'Bundled fixture file (not a live request)' : 'Live upstream request'}</dd>
          </dl>

          <div className="drawer-actions">
            {d.point && <button type="button" className="btn small" onClick={() => useStore.getState().requestFly(d.bbox && d.geometryKind !== 'point' && d.geometryKind !== 'country' ? { lng: d.point![0], lat: d.point![1], bbox: d.bbox } : { lng: d.point![0], lat: d.point![1], zoom: 6 })}>Zoom to</button>}
            <button type="button" className="btn small" onClick={copyLink}>Copy link</button>
            <button type="button" className="btn small" onClick={() => useStore.getState().setPanel('sources')}>Source health</button>
          </div>
        </div>
      )}
    </aside>
  );
}
