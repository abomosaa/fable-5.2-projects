/**
 * Ingestion pipeline: runs one source end-to-end (fetch → parse → normalise → upsert → snapshot bookkeeping →
 * correlation) with complete failure isolation. A failing source never throws out of runSource(); the failure
 * is recorded in its state and all previously ingested data stays available (flagged by age).
 */
import { EventEmitter } from 'node:events';
import { missingEnv } from '../adapters/base.ts';
import type { Catalog } from '../core/catalog.ts';
import type { Clock } from '../core/clock.ts';
import type { FetchedPayload, IntelRecord, RejectedItem } from '../core/types.ts';
import { AuthError, CircuitOpenError, RateLimitedError, TimeoutError, type ResilientHttp } from '../http/client.ts';
import type { FixtureTransport } from '../http/fixtureTransport.ts';
import type { RecordStore } from '../store/records.ts';
import { correlateClass, type CorrelationClass } from './correlate.ts';
import { SourceStateStore, type SourceState } from './health.ts';
import { normaliseDraft } from './normalize.ts';

export type RunOutcome = 'ok' | 'partial' | 'failed' | 'rate_limited' | 'circuit_open' | 'misconfigured' | 'disabled';

export interface RunResult {
  sourceId: string;
  outcome: RunOutcome;
  inserted: number;
  updated: number;
  unchanged: number;
  ended: number;
  rejected: RejectedItem[];
  error: string | null;
  errorKind: string | null;
  durationMs: number;
  changedLayers: string[];
  /** When the scheduler may try again (rate limit / breaker), if constrained. */
  retryAt: number | null;
}

export interface IngestEvent {
  type: 'ingest';
  sourceId: string;
  outcome: RunOutcome;
  layers: string[];
  inserted: number;
  updated: number;
  ended: number;
  rejected: number;
  at: number;
}

export interface PipelineOptions {
  catalog: Catalog;
  store: RecordStore;
  http: ResilientHttp;
  clock: Clock;
  env: Record<string, string | undefined>;
  /** true in fixture/demo mode: records are stamped as fixture data. */
  fixture: boolean;
  fixtureTransport?: FixtureTransport;
  /** Source ids switched off by configuration. */
  disabled?: Set<string>;
  log?: (msg: string) => void;
}

function describeError(err: unknown): { message: string; kind: string } {
  if (err instanceof RateLimitedError) return { message: err.message, kind: 'rate_limit' };
  if (err instanceof AuthError) return { message: err.message, kind: 'auth' };
  if (err instanceof CircuitOpenError) return { message: err.message, kind: 'circuit' };
  if (err instanceof TimeoutError) return { message: err.message, kind: 'timeout' };
  const e = err as Error;
  const msg = (e?.message ?? String(err)).replace(/\s+/g, ' ').slice(0, 300);
  return { message: msg, kind: /^malformed/i.test(msg) ? 'parse' : (e?.name === 'HttpError' ? 'http' : 'error') };
}

export class Pipeline extends EventEmitter<{ ingest: [IngestEvent]; health: [{ type: 'health'; sourceId: string; at: number }] }> {
  readonly states: SourceStateStore;
  private readonly running = new Set<string>();
  private readonly o: PipelineOptions;

  constructor(opts: PipelineOptions) {
    super();
    this.o = opts;
    this.states = new SourceStateStore(opts.store.db);
  }

  isEnabled(sourceId: string): boolean {
    return !this.o.disabled?.has(sourceId);
  }
  isRunning(sourceId: string): boolean {
    return this.running.has(sourceId);
  }

  async runSource(sourceId: string, signal?: AbortSignal): Promise<RunResult> {
    const { catalog, store, clock, env } = this.o;
    const adapter = catalog.adapters.get(sourceId);
    if (!adapter) throw new Error(`unknown source ${sourceId}`);
    const manifest = adapter.manifest;
    const started = clock.now();
    const wallStart = Date.now();
    const base: RunResult = { sourceId, outcome: 'ok', inserted: 0, updated: 0, unchanged: 0, ended: 0, rejected: [], error: null, errorKind: null, durationMs: 0, changedLayers: [], retryAt: null };

    if (!this.isEnabled(sourceId)) return { ...base, outcome: 'disabled' };
    const missing = missingEnv(manifest, env);
    if (missing.length) {
      // Never attempt a request without the documented credentials.
      return { ...base, outcome: 'misconfigured', error: `missing ${missing.join(', ')}`, errorKind: 'config' };
    }
    const state = this.states.get(sourceId);
    if (state.rateLimitedUntil != null && state.rateLimitedUntil > started) {
      return { ...base, outcome: 'rate_limited', retryAt: state.rateLimitedUntil, error: 'waiting for upstream rate limit to clear', errorKind: 'rate_limit' };
    }
    if (this.running.has(sourceId)) return { ...base, outcome: 'ok' };

    this.running.add(sourceId);
    const runId = store.startRun(sourceId, started);
    this.o.fixtureTransport?.beginRun(sourceId);
    const http = this.o.http.forSource(manifest, signal);
    const ac = new AbortController();
    const onAbort = () => ac.abort();
    signal?.addEventListener('abort', onAbort, { once: true });

    let result: RunResult = base;
    let payloads: FetchedPayload[] = [];
    let staleError: unknown = null;
    let upstreamTime: number | null = null;
    let failedRequests = 0;
    try {
      const partial: { key: string; error: unknown }[] = [];
      payloads = await adapter.fetch({
        http, env, now: started, cursor: store.cursor(sourceId), signal: ac.signal,
        partialFailure: (key, error) => void partial.push({ key, error }),
      });
      const stale = payloads.filter((p) => p.stale);
      if (stale.length) staleError = stale[0]!.error ?? new Error('upstream failed; cached copy served');
      failedRequests = partial.length;
      if (partial.length && !staleError) staleError = partial[0]!.error;

      if (payloads.length && stale.length === payloads.length) {
        // Everything came from the stale cache: its records are already in the store. Do not re-stamp them as fresh.
        throw staleError;
      }

      const now = clock.now();
      const parsed = adapter.parse(payloads, { now, env });
      upstreamTime = parsed.upstreamTime ?? null;
      const live = payloads.filter((p) => !p.stale);
      const fetchedAt = live.length ? Math.min(...live.map((p) => p.fetchedAt)) : now;
      const fetchUrls = payloads.map((p) => p.url);
      const rejected: RejectedItem[] = [...parsed.rejected];
      const records: IntelRecord[] = [];
      for (const draft of parsed.records) {
        const res = normaliseDraft(draft, { manifest, adapterVersion: adapter.version, now, fetchedAt, fetchUrls, fixture: this.o.fixture });
        if (res.ok) records.push(res.record);
        else if (rejected.length < 500) rejected.push(res.rejected);
      }
      // De-duplicate within the batch by stable id (last one wins).
      const byId = new Map<string, IntelRecord>();
      for (const r of records) byId.set(r.id, r);
      const unique = [...byId.values()];

      const counts = store.upsertMany(unique, runId);
      const changed = new Set(counts.changedLayers);
      let ended = 0;
      if (manifest.snapshot === 'full' && !stale.length && !failedRequests) {
        // Guard: an unexpectedly empty "complete" snapshot is more likely an upstream fault than the world going quiet.
        const previously = store.count('source_id = ? AND ended_at IS NULL', sourceId);
        const suspicious = unique.length === 0 && previously > 25 && rejected.length > 0;
        if (!suspicious) {
          const res = store.endMissing(sourceId, runId, now);
          ended = res.ended;
          for (const l of res.layers) changed.add(l);
        }
      }

      // Re-correlate the classes touched by this run.
      const classes = new Set<CorrelationClass>();
      for (const l of changed) {
        const c = catalog.layer(l)?.correlationClass;
        if (c) classes.add(c);
      }
      for (const c of classes) correlateClass(store.db, catalog, c, now);

      const se = staleError ? describeError(staleError) : null;
      result = {
        ...base,
        outcome: stale.length || failedRequests || rejected.length ? 'partial' : 'ok',
        inserted: counts.inserted,
        updated: counts.updated,
        unchanged: counts.unchanged,
        ended,
        rejected,
        changedLayers: [...changed],
        error: se
          ? `${stale.length + failedRequests} of ${payloads.length + failedRequests} requests failed (${se.message})${stale.length ? '; cached copies used where available' : ''}`
          : null,
        errorKind: se ? (se.kind === 'rate_limit' ? 'rate_limit' : 'partial') : null,
        retryAt: staleError instanceof RateLimitedError ? staleError.retryAt : null,
      };
    } catch (err) {
      const d = describeError(err);
      result = {
        ...base,
        outcome: err instanceof RateLimitedError ? 'rate_limited' : err instanceof CircuitOpenError ? 'circuit_open' : err instanceof AuthError ? 'misconfigured' : 'failed',
        error: d.message,
        errorKind: d.kind,
        retryAt: err instanceof RateLimitedError ? err.retryAt : err instanceof CircuitOpenError ? err.retryAt : null,
      };
    } finally {
      signal?.removeEventListener('abort', onAbort);
      this.running.delete(sourceId);
    }

    const finished = clock.now();
    result.durationMs = Date.now() - wallStart;
    const allStale = payloads.length > 0 && payloads.every((p) => p.stale);
    const succeeded = result.outcome === 'ok' || (result.outcome === 'partial' && !staleError);
    const next: SourceState = {
      ...state,
      lastAttemptAt: finished,
      lastDurationMs: result.durationMs,
      totalRuns: state.totalRuns + 1,
      lastUpstreamTime: upstreamTime ?? state.lastUpstreamTime,
      lastCounts: succeeded || result.outcome === 'partial'
        ? { inserted: result.inserted, updated: result.updated, unchanged: result.unchanged, ended: result.ended, rejected: result.rejected.length }
        : state.lastCounts,
    };
    if (succeeded) {
      next.lastSuccessAt = finished;
      next.consecutiveFailures = 0;
      next.rateLimitedUntil = null;
      next.servingStaleCache = false;
      next.lastError = null;
      next.lastErrorKind = null;
    } else {
      // Some requests succeeded and their data was ingested: the source did refresh, but not completely.
      if (result.outcome === 'partial') next.lastSuccessAt = finished;
      next.lastErrorAt = finished;
      next.lastError = result.error;
      next.lastErrorKind = result.errorKind;
      next.totalFailures = state.totalFailures + 1;
      next.servingStaleCache = allStale || (result.outcome === 'partial' && payloads.some((p) => p.stale));
      if (result.outcome === 'rate_limited' || result.errorKind === 'rate_limit') {
        next.rateLimitedUntil = result.retryAt ?? finished + 60_000;
      } else {
        next.consecutiveFailures = state.consecutiveFailures + 1;
      }
    }
    this.states.save(next);
    store.finishRun(runId, {
      finishedAt: finished, outcome: result.outcome, inserted: result.inserted, updated: result.updated, unchanged: result.unchanged, ended: result.ended,
      rejected: result.rejected, error: result.error, httpEvents: http.requestLog,
    });
    this.o.log?.(
      `[ingest] ${sourceId}: ${result.outcome} +${result.inserted} ~${result.updated} =${result.unchanged} ended ${result.ended} rejected ${result.rejected.length}${result.error ? ` (${result.error})` : ''} ${result.durationMs} ms`,
    );
    this.emit('ingest', {
      type: 'ingest', sourceId, outcome: result.outcome, layers: result.changedLayers, inserted: result.inserted, updated: result.updated,
      ended: result.ended, rejected: result.rejected.length, at: finished,
    });
    return result;
  }
}
