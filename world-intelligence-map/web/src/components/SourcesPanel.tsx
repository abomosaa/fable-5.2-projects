import { useMemo, useState } from 'react';
import { api, serverNow } from '../api';
import { fmtAgo, fmtDuration, fmtTime } from '../lib/format';
import { useStore } from '../state/store';
import type { SourceEntry, SourceStatus } from '../types';
import { StatusBadge, statusLabel } from './Symbol';

const ORDER: SourceStatus[] = ['unavailable', 'stale', 'rate_limited', 'delayed', 'misconfigured', 'pending', 'disabled', 'healthy'];

function ExtLink({ href, children }: { href: string; children: React.ReactNode }) {
  // Upstream-provided links are validated server-side; still open them isolated.
  if (!/^https?:\/\//i.test(href)) return <span>{children}</span>;
  return <a href={href} target="_blank" rel="noopener noreferrer nofollow">{children}</a>;
}

function SourceCard({ s, onReload }: { s: SourceEntry; onReload: () => void }) {
  const [open, setOpen] = useState(false);
  const toast = useStore((st) => st.toast);
  const m = s.manifest;
  const h = s.health;
  const now = serverNow();
  const refresh = async () => {
    try {
      const status = await api.refreshSource(m.id);
      toast('info', status === 429 ? `${m.provider} was refreshed very recently.` : `Refresh requested for ${m.provider}.`);
      setTimeout(onReload, 1500);
    } catch {
      toast('error', `Could not request a refresh for ${m.provider}.`);
    }
  };
  return (
    <li className="source" data-source={m.id} data-status={h.status}>
      <button type="button" className="source-head" aria-expanded={open} onClick={() => setOpen(!open)}>
        <StatusBadge status={h.status} />
        <span className="source-title">
          <strong>{m.provider}</strong>
          <span className="muted">{m.dataset}</span>
        </span>
        <span className="muted count">{s.records.toLocaleString('en-US')}</span>
      </button>
      {(h.status !== 'healthy' || open) && <p className="source-msg" data-testid={`source-msg-${m.id}`}>{h.message}</p>}
      {s.demoScenario && <p className="source-msg demo">Fixture scenario: {s.demoScenario}</p>}
      {h.dataIsStale && h.status !== 'stale' && <p className="source-msg"><span className="tag fr-stale">Stale data</span> Records from this source are flagged as stale on the map.</p>}
      {open && (
        <div className="source-body">
          <p>{m.description}</p>
          <dl className="kv">
            <dt>Last success</dt><dd>{h.lastSuccessAt ? `${fmtTime(h.lastSuccessAt)} (${fmtAgo(h.lastSuccessAt, now)})` : 'never'}</dd>
            <dt>Last attempt</dt><dd>{h.lastAttemptAt ? fmtAgo(h.lastAttemptAt, now) : '—'}{h.lastDurationMs != null ? ` · ${h.lastDurationMs} ms` : ''}</dd>
            <dt>Next attempt</dt><dd>{h.nextRunAt ? fmtAgo(h.nextRunAt, now) : '—'}</dd>
            {h.lastUpstreamTime != null && <><dt>Upstream timestamp</dt><dd>{fmtTime(h.lastUpstreamTime)}</dd></>}
            {h.lastError && <><dt>Last error</dt><dd>{h.lastError}</dd></>}
            {h.lastCounts && <><dt>Last run</dt><dd>{h.lastCounts.inserted} new · {h.lastCounts.updated} changed · {h.lastCounts.unchanged} unchanged · {h.lastCounts.ended} ended · {h.lastCounts.rejected} rejected</dd></>}
            <dt>Polling</dt><dd>every {fmtDuration(h.pollIntervalSec)} · stale after {fmtDuration(h.staleAfterSec)} · upstream: {m.updateCadence.upstream}</dd>
            <dt>Coverage</dt><dd>{m.coverage.geographic} · {m.coverage.temporal}</dd>
            <dt>Access</dt>
            <dd>
              {m.auth.type === 'none' ? 'No credentials required' : `${m.auth.type.replace('_', ' ')}: ${m.auth.envVars.map((v) => `${v.name}${v.required ? '' : ' (optional)'}`).join(', ')}`}
              {m.auth.setup && <span className="block">{m.auth.setup}</span>}
              {m.auth.obtainUrl && <span className="block"><ExtLink href={m.auth.obtainUrl}>Where to get access</ExtLink></span>}
            </dd>
            <dt>Attribution</dt><dd>{m.attribution}</dd>
            <dt>Licence / terms</dt>
            <dd>
              <ExtLink href={m.license.url}>{m.license.name}</ExtLink>
              <span className="block">
                Redistribution: {m.license.redistribution.replace(/-/g, ' ')}{m.license.nonCommercialOnly ? ' · non-commercial use only' : ''}
              </span>
              {m.license.notes && <span className="block">{m.license.notes}</span>}
            </dd>
            <dt>Confidence</dt><dd>{m.confidenceNotes}</dd>
            <dt>Limitations</dt><dd><ul className="plain">{m.limitations.map((l, i) => <li key={i}>{l}</li>)}</ul></dd>
            <dt>Retention</dt><dd>{m.retention.note}</dd>
            <dt>Layers</dt><dd>{m.layers.map((l) => `${l.name} (${(s.layerRecords[l.id] ?? 0).toLocaleString('en-US')})`).join(' · ')}</dd>
            <dt>Endpoints</dt><dd className="mono wrap">{m.sourceUrls.join('\n')}</dd>
            <dt>Links</dt><dd><ExtLink href={m.documentationUrl}>Documentation</ExtLink> · <ExtLink href={m.homepageUrl}>Provider</ExtLink></dd>
          </dl>
          <button type="button" className="btn small" onClick={refresh} disabled={h.status === 'misconfigured' || h.status === 'disabled'}>Fetch now</button>
        </div>
      )}
    </li>
  );
}

export function SourcesPanel({ onReload }: { onReload: () => void }) {
  const sources = useStore((s) => s.sources);
  const error = useStore((s) => s.sourcesError);
  const meta = useStore((s) => s.meta)!;
  const [only, setOnly] = useState<SourceStatus | 'all' | 'issues'>('all');
  const [q, setQ] = useState('');

  const byStatus = useMemo(() => {
    const m = new Map<SourceStatus, number>();
    for (const s of sources) m.set(s.health.status, (m.get(s.health.status) ?? 0) + 1);
    return m;
  }, [sources]);

  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return sources
      .filter((s) => (only === 'all' ? true : only === 'issues' ? !['healthy', 'pending', 'disabled'].includes(s.health.status) : s.health.status === only))
      .filter((s) => !needle || `${s.manifest.provider} ${s.manifest.dataset} ${s.manifest.id}`.toLowerCase().includes(needle))
      .sort((a, b) => ORDER.indexOf(a.health.status) - ORDER.indexOf(b.health.status) || a.manifest.provider.localeCompare(b.manifest.provider));
  }, [sources, only, q]);

  const total = sources.reduce((a, s) => a + s.records, 0);
  return (
    <section className="panel" aria-label="Sources and source health">
      <div className="panel-head">
        <p className="muted" data-testid="source-summary">
          {sources.length} sources · {total.toLocaleString('en-US')} records in store{meta.fixture ? ' · fixture data' : ''}
        </p>
        <div className="status-row" role="group" aria-label="Filter sources by status">
          <button type="button" className={`chip ${only === 'all' ? 'active' : ''}`} aria-pressed={only === 'all'} onClick={() => setOnly('all')}>All</button>
          {ORDER.filter((st) => byStatus.get(st)).map((st) => (
            <button type="button" key={st} className={`chip ${only === st ? 'active' : ''}`} aria-pressed={only === st} onClick={() => setOnly(only === st ? 'all' : st)} data-testid={`status-chip-${st}`}>
              <StatusBadge status={st} compact /> {statusLabel(st)} {byStatus.get(st)}
            </button>
          ))}
        </div>
        <label className="sr-only" htmlFor="source-search">Search sources</label>
        <input id="source-search" type="search" placeholder="Search sources…" value={q} onChange={(e) => setQ(e.target.value)} />
        {error && <p className="empty error" role="alert">Source health could not be refreshed: {error}</p>}
      </div>
      <div className="panel-body">
        {sources.length === 0 && !error && <p className="empty">Loading source inventory…</p>}
        <ul className="sources" data-testid="sources">
          {shown.map((s) => <SourceCard key={s.manifest.id} s={s} onReload={onReload} />)}
        </ul>
        {sources.length > 0 && shown.length === 0 && <p className="empty">No sources match.</p>}
      </div>
    </section>
  );
}
