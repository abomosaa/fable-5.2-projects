/** Source state persistence and the health model shown in the source-health UI. */
import type { SourceManifest, SourceStatus } from '../core/types.ts';
import type { Db } from '../store/db.ts';
import { missingEnv } from '../adapters/base.ts';

export interface SourceState {
  sourceId: string;
  lastAttemptAt: number | null;
  lastSuccessAt: number | null;
  lastErrorAt: number | null;
  lastError: string | null;
  lastErrorKind: string | null;
  consecutiveFailures: number;
  rateLimitedUntil: number | null;
  nextRunAt: number | null;
  lastDurationMs: number | null;
  lastUpstreamTime: number | null;
  lastCounts: { inserted: number; updated: number; unchanged: number; ended: number; rejected: number } | null;
  servingStaleCache: boolean;
  totalRuns: number;
  totalFailures: number;
}

const EMPTY = (sourceId: string): SourceState => ({
  sourceId, lastAttemptAt: null, lastSuccessAt: null, lastErrorAt: null, lastError: null, lastErrorKind: null, consecutiveFailures: 0,
  rateLimitedUntil: null, nextRunAt: null, lastDurationMs: null, lastUpstreamTime: null, lastCounts: null, servingStaleCache: false, totalRuns: 0, totalFailures: 0,
});

export class SourceStateStore {
  constructor(private readonly db: Db) {}

  get(sourceId: string): SourceState {
    const r = this.db.get<Record<string, unknown>>('SELECT * FROM source_state WHERE source_id = ?', sourceId);
    if (!r) return EMPTY(sourceId);
    return {
      sourceId,
      lastAttemptAt: r.last_attempt_at as number | null,
      lastSuccessAt: r.last_success_at as number | null,
      lastErrorAt: r.last_error_at as number | null,
      lastError: r.last_error as string | null,
      lastErrorKind: r.last_error_kind as string | null,
      consecutiveFailures: r.consecutive_failures as number,
      rateLimitedUntil: r.rate_limited_until as number | null,
      nextRunAt: r.next_run_at as number | null,
      lastDurationMs: r.last_duration_ms as number | null,
      lastUpstreamTime: r.last_upstream_time as number | null,
      lastCounts: r.last_counts ? (JSON.parse(r.last_counts as string) as SourceState['lastCounts']) : null,
      servingStaleCache: !!r.serving_stale_cache,
      totalRuns: r.total_runs as number,
      totalFailures: r.total_failures as number,
    };
  }

  save(s: SourceState): void {
    this.db.run(
      `INSERT INTO source_state(source_id, last_attempt_at, last_success_at, last_error_at, last_error, last_error_kind, consecutive_failures,
         rate_limited_until, next_run_at, last_duration_ms, last_upstream_time, last_counts, serving_stale_cache, total_runs, total_failures)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(source_id) DO UPDATE SET last_attempt_at=excluded.last_attempt_at, last_success_at=excluded.last_success_at,
         last_error_at=excluded.last_error_at, last_error=excluded.last_error, last_error_kind=excluded.last_error_kind,
         consecutive_failures=excluded.consecutive_failures, rate_limited_until=excluded.rate_limited_until, next_run_at=excluded.next_run_at,
         last_duration_ms=excluded.last_duration_ms, last_upstream_time=excluded.last_upstream_time, last_counts=excluded.last_counts,
         serving_stale_cache=excluded.serving_stale_cache, total_runs=excluded.total_runs, total_failures=excluded.total_failures`,
      s.sourceId, s.lastAttemptAt, s.lastSuccessAt, s.lastErrorAt, s.lastError, s.lastErrorKind, s.consecutiveFailures, s.rateLimitedUntil, s.nextRunAt,
      s.lastDurationMs, s.lastUpstreamTime, s.lastCounts ? JSON.stringify(s.lastCounts) : null, s.servingStaleCache ? 1 : 0, s.totalRuns, s.totalFailures,
    );
  }
}

export interface SourceHealth {
  sourceId: string;
  status: SourceStatus;
  /** One plain sentence explaining the status. */
  message: string;
  /** Credentials that are missing (misconfigured sources). */
  missingEnv: string[];
  lastAttemptAt: number | null;
  lastSuccessAt: number | null;
  lastError: string | null;
  lastErrorAt: number | null;
  nextRunAt: number | null;
  rateLimitedUntil: number | null;
  consecutiveFailures: number;
  lastDurationMs: number | null;
  /** Newest generation/update time declared by upstream itself. */
  lastUpstreamTime: number | null;
  lastCounts: SourceState['lastCounts'];
  pollIntervalSec: number;
  staleAfterSec: number;
  /** true when records of this source must be presented as stale (not re-confirmed within staleAfterSec). */
  dataIsStale: boolean;
  breaker: 'closed' | 'open' | 'half_open';
}

/**
 * Health model:
 *  disabled       – switched off by configuration
 *  misconfigured  – required credentials missing or rejected by upstream
 *  pending        – enabled but never attempted yet
 *  rate_limited   – upstream asked us to back off (429 / Retry-After); retrying at rateLimitedUntil
 *  unavailable    – repeatedly failing (circuit open or ≥3 consecutive failures) or never succeeded
 *  stale          – no successful fetch within staleAfterSec: shown data is old and flagged as such
 *  delayed        – last attempt failed, served a cached copy or refreshed only partially, but data is still within its staleness budget
 *  healthy        – last attempt succeeded
 */
export function computeHealth(
  manifest: SourceManifest,
  state: SourceState,
  now: number,
  env: Record<string, string | undefined>,
  opts: { enabled: boolean; breaker?: 'closed' | 'open' | 'half_open' } = { enabled: true },
): SourceHealth {
  const missing = missingEnv(manifest, env);
  const staleAfterMs = manifest.updateCadence.staleAfterSec * 1000;
  const sinceSuccess = state.lastSuccessAt != null ? now - state.lastSuccessAt : Infinity;
  const dataIsStale = state.lastSuccessAt != null && sinceSuccess > staleAfterMs;
  const breaker = opts.breaker ?? 'closed';
  const lastFailed = state.lastErrorAt != null && (state.lastSuccessAt == null || state.lastErrorAt >= state.lastSuccessAt);

  let status: SourceStatus;
  let message: string;
  if (!opts.enabled) {
    status = 'disabled';
    message = manifest.enabledByDefault
      ? 'Disabled by configuration (WIM_DISABLED_SOURCES).'
      : `Opt-in source: off until its id is added to WIM_ENABLED_SOURCES. Read its licence terms first. ${manifest.auth.setup ?? ''}`.trim();
  } else if (missing.length) {
    status = 'misconfigured';
    message = `Missing credential${missing.length > 1 ? 's' : ''}: ${missing.join(', ')}. ${manifest.auth.setup ?? ''}`.trim();
  } else if (state.lastErrorKind === 'auth' && lastFailed) {
    status = 'misconfigured';
    message = `Upstream rejected the configured credentials. ${manifest.auth.setup ?? ''}`.trim();
  } else if (state.lastAttemptAt == null) {
    status = 'pending';
    message = 'Waiting for the first fetch.';
  } else if (state.rateLimitedUntil != null && state.rateLimitedUntil > now) {
    status = 'rate_limited';
    message = `Upstream rate limit – next attempt after ${new Date(state.rateLimitedUntil).toISOString()}.${state.lastSuccessAt ? ' Showing previously fetched data.' : ''}`;
  } else if (lastFailed && state.lastErrorKind === 'partial' && !dataIsStale) {
    status = 'delayed';
    message = `Partially refreshed: ${state.lastError ?? 'some requests failed'}. The failed requests are retried; their records keep the time of their last successful fetch.`;
  } else if (lastFailed && (breaker === 'open' || state.consecutiveFailures >= 3 || state.lastSuccessAt == null)) {
    status = 'unavailable';
    message = `Upstream unavailable (${state.consecutiveFailures} consecutive failure${state.consecutiveFailures === 1 ? '' : 's'}${breaker === 'open' ? ', circuit breaker open' : ''}): ${state.lastError ?? 'unknown error'}.${state.lastSuccessAt ? ' Showing data from the last successful fetch, flagged by age.' : ' No data has been fetched yet.'}`;
  } else if (dataIsStale) {
    status = 'stale';
    message = `No successful refresh for ${formatDuration(sinceSuccess)} (expected at least every ${formatDuration(staleAfterMs)}). Displayed data is stale.`;
  } else if (lastFailed || state.servingStaleCache) {
    status = 'delayed';
    message = state.servingStaleCache
      ? `Upstream failed; serving the cached copy from the last good fetch. ${state.lastError ?? ''}`.trim()
      : `Last attempt failed (${state.lastError ?? 'unknown error'}); retrying. Data from the previous fetch is still within its freshness budget.`;
  } else {
    status = 'healthy';
    message = 'Fetching normally.';
  }

  return {
    sourceId: manifest.id,
    status,
    message,
    missingEnv: missing,
    lastAttemptAt: state.lastAttemptAt,
    lastSuccessAt: state.lastSuccessAt,
    lastError: lastFailed || state.servingStaleCache ? state.lastError : null,
    lastErrorAt: state.lastErrorAt,
    nextRunAt: state.nextRunAt,
    rateLimitedUntil: state.rateLimitedUntil != null && state.rateLimitedUntil > now ? state.rateLimitedUntil : null,
    consecutiveFailures: state.consecutiveFailures,
    lastDurationMs: state.lastDurationMs,
    lastUpstreamTime: state.lastUpstreamTime,
    lastCounts: state.lastCounts,
    pollIntervalSec: manifest.updateCadence.pollIntervalSec,
    staleAfterSec: manifest.updateCadence.staleAfterSec,
    dataIsStale: dataIsStale || (status === 'unavailable' && state.lastSuccessAt != null && sinceSuccess > staleAfterMs),
    breaker,
  };
}

export function formatDuration(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 90) return `${s} s`;
  const m = Math.round(s / 60);
  if (m < 90) return `${m} min`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h} h`;
  return `${Math.round(h / 24)} d`;
}
