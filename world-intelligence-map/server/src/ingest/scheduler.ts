/**
 * Scheduler: polls every source on its own interval with bounded global concurrency.
 *  - first runs are staggered so start-up does not stampede upstreams
 *  - each run is isolated (Pipeline.runSource never throws)
 *  - failures back off exponentially (with jitter) up to the source's normal interval
 *  - rate limits and open circuit breakers defer the next attempt to the time upstream / the breaker allows
 *  - retention runs periodically
 */
import type { Catalog } from '../core/catalog.ts';
import type { Clock } from '../core/clock.ts';
import type { RecordStore } from '../store/records.ts';
import type { Pipeline, RunResult } from './pipeline.ts';

export interface SchedulerOptions {
  catalog: Catalog;
  pipeline: Pipeline;
  store: RecordStore;
  clock: Clock;
  concurrency?: number;
  /** Override the poll interval (seconds) – used by fixture mode to cycle quickly. */
  intervalSec?: (sourceId: string, manifestIntervalSec: number) => number;
  /** Delay the first run of a source in this process (fixture stale-data demonstration). */
  firstRunDelayMs?: (sourceId: string) => number | undefined;
  random?: () => number;
  retentionEveryMs?: number;
  log?: (msg: string) => void;
}

export class Scheduler {
  private timer: NodeJS.Timeout | null = null;
  private retentionTimer: NodeJS.Timeout | null = null;
  private readonly nextAt = new Map<string, number>();
  private readonly inFlight = new Map<string, Promise<RunResult>>();
  private readonly abort = new AbortController();
  private stopped = false;
  private readonly o: Required<Pick<SchedulerOptions, 'concurrency' | 'random' | 'retentionEveryMs'>> & SchedulerOptions;

  constructor(opts: SchedulerOptions) {
    this.o = { concurrency: 4, random: Math.random, retentionEveryMs: 3_600_000, ...opts };
  }

  intervalMs(sourceId: string): number {
    const m = this.o.catalog.sources.get(sourceId)!;
    const sec = this.o.intervalSec ? this.o.intervalSec(sourceId, m.updateCadence.pollIntervalSec) : m.updateCadence.pollIntervalSec;
    return Math.max(1, sec) * 1000;
  }

  /** Decide when a source should run next, given how its last run went. Exposed for tests. */
  planNext(sourceId: string, result: RunResult | null, now: number, consecutiveFailures: number): number {
    const interval = this.intervalMs(sourceId);
    const jitter = (ms: number) => Math.round(ms * (0.9 + this.o.random() * 0.2));
    // "partial" with an error means some requests failed: retry sooner, like a failure.
    if (!result || result.outcome === 'ok' || (result.outcome === 'partial' && !result.error)) return now + jitter(interval);
    if (result.outcome === 'misconfigured' || result.outcome === 'disabled') return now + Math.max(interval, 300_000);
    if (result.retryAt != null) return Math.max(result.retryAt, now + 1000) + Math.round(this.o.random() * 1000);
    // failed: exponential backoff starting at 15 s, capped at the regular interval
    const backoff = Math.min(interval, 15_000 * 2 ** Math.min(10, Math.max(0, consecutiveFailures - 1)));
    return now + jitter(backoff);
  }

  start(): void {
    const now = this.o.clock.now();
    let i = 0;
    for (const sourceId of this.o.catalog.sources.keys()) {
      const st = this.o.pipeline.states.get(sourceId);
      const interval = this.intervalMs(sourceId);
      // Resume the cadence across restarts; never-fetched sources start immediately, staggered.
      const hold = this.o.firstRunDelayMs?.(sourceId);
      const due = hold != null ? now + hold : st.lastSuccessAt != null && st.lastSuccessAt + interval > now ? st.lastSuccessAt + interval : now + i++ * 150;
      this.schedule(sourceId, due);
    }
    this.timer = setInterval(() => this.tick(), 500);
    this.timer.unref?.();
    this.retentionTimer = setInterval(() => this.runRetention(), this.o.retentionEveryMs);
    this.retentionTimer.unref?.();
    this.runRetention();
    this.tick();
  }

  private schedule(sourceId: string, at: number): void {
    this.nextAt.set(sourceId, at);
    const st = this.o.pipeline.states.get(sourceId);
    if (st.nextRunAt !== at) this.o.pipeline.states.save({ ...st, nextRunAt: at });
  }

  private runRetention(): void {
    try {
      const res = this.o.store.applyRetention(this.o.clock.now());
      if (res.deleted) this.o.log?.(`[retention] purged ${res.deleted} records ${JSON.stringify(res.byLayer)}`);
    } catch (err) {
      this.o.log?.(`[retention] failed: ${(err as Error).message}`);
    }
  }

  /** Run every due source, respecting the concurrency bound. */
  tick(): void {
    if (this.stopped) return;
    const now = this.o.clock.now();
    const due = [...this.nextAt.entries()].filter(([id, at]) => at <= now && !this.inFlight.has(id)).sort((a, b) => a[1] - b[1]);
    for (const [sourceId] of due) {
      if (this.inFlight.size >= this.o.concurrency) break;
      this.launch(sourceId);
    }
  }

  private launch(sourceId: string): Promise<RunResult> {
    const p = this.o.pipeline
      .runSource(sourceId, this.abort.signal)
      .catch((err): RunResult => {
        // Defensive: runSource is designed not to throw, but one source must never take the scheduler down.
        this.o.log?.(`[scheduler] ${sourceId} crashed: ${(err as Error).message}`);
        return { sourceId, outcome: 'failed', inserted: 0, updated: 0, unchanged: 0, ended: 0, rejected: [], error: String(err), errorKind: 'error', durationMs: 0, changedLayers: [], retryAt: null };
      })
      .then((result) => {
        this.inFlight.delete(sourceId);
        if (!this.stopped) {
          const st = this.o.pipeline.states.get(sourceId);
          this.schedule(sourceId, this.planNext(sourceId, result, this.o.clock.now(), st.consecutiveFailures));
          setImmediate(() => this.tick());
        }
        return result;
      });
    this.inFlight.set(sourceId, p);
    return p;
  }

  /** Run a source right now (manual refresh), ignoring its schedule but not its rate limit. */
  runNow(sourceId: string): Promise<RunResult> {
    return this.inFlight.get(sourceId) ?? this.launch(sourceId);
  }

  /** Run every enabled source once and wait for all of them (initial load in tests and benchmarks). */
  async runAllOnce(): Promise<RunResult[]> {
    const ids = [...this.o.catalog.sources.keys()];
    const results: RunResult[] = [];
    let idx = 0;
    const worker = async () => {
      while (idx < ids.length) {
        const id = ids[idx++]!;
        results.push(await this.o.pipeline.runSource(id, this.abort.signal));
      }
    };
    await Promise.all(Array.from({ length: Math.min(this.o.concurrency, ids.length) }, worker));
    return results;
  }

  nextRunAt(sourceId: string): number | null {
    return this.nextAt.get(sourceId) ?? null;
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    if (this.retentionTimer) clearInterval(this.retentionTimer);
    this.abort.abort();
    await Promise.allSettled([...this.inFlight.values()]);
  }
}
