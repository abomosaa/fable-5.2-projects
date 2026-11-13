/**
 * The deterministic demonstration scenario for fixture mode. Effects are keyed by ingestion run number
 * (never by wall-clock time or randomness), so every demo run plays out identically:
 *
 *   outage + recovery        – a source answers HTTP 503 for a few runs, then recovers
 *   circuit breaker          – a source fails at the network level long enough to open its breaker, then recovers
 *   rate limiting            – a source answers 429 with Retry-After, is left alone until then, then recovers
 *   malformed records        – a source delivers a payload with broken items; they are rejected individually
 *   timeout                  – a source hangs until the client times out
 *   stale data               – a source last fetched in a simulated earlier session, not yet refreshed in this one
 *   missing credentials      – an optional source without credentials is reported as misconfigured
 */
import type { ScenarioStep } from '../http/fixtureTransport.ts';

export interface DemoPlan {
  steps: ScenarioStep[];
  /** Sources polled quickly so the scenario unfolds within a couple of minutes. */
  fastSources: string[];
  /** Source left without credentials (shown as misconfigured with setup instructions). */
  misconfigured: string[];
  /**
   * Stale-data demonstration: this source is fetched once in a simulated earlier session (`ageMs` before the fixture
   * epoch – longer than its staleness budget) and is then not refreshed for `holdSec` seconds after start-up, as if the
   * server had been offline. Its records are flagged stale until the first fetch of the new session succeeds.
   */
  staleSource: { id: string; ageMs: number; holdSec: number } | null;
}

export function demoPlan(available: Set<string>, staleHoldSec = 240, dynamic = true): DemoPlan {
  const steps: ScenarioStep[] = [];
  const fast: string[] = [];
  const add = (step: ScenarioStep) => {
    if (!dynamic || !available.has(step.source)) return;
    steps.push(step);
    if (!fast.includes(step.source)) fast.push(step.source);
  };
  add({ source: 'emsc-earthquakes', fromRun: 2, toRun: 3, effect: { status: 503 }, label: 'Upstream outage (HTTP 503) for two runs, then recovery' });
  add({ source: 'gdacs', fromRun: 2, toRun: 7, effect: { networkError: true }, label: 'Network failures until the circuit breaker opens, then recovery' });
  add({ source: 'nasa-eonet', fromRun: 2, toRun: 2, effect: { status: 429, headers: { 'retry-after': '45' } }, label: 'Rate limited (HTTP 429, Retry-After: 45), then recovery' });
  add({ source: 'usgs-earthquakes', fromRun: 3, toRun: 3, effect: { variant: 'malformed' }, label: 'Malformed upstream records are rejected individually' });
  add({ source: 'aviation-sigmet', fromRun: 2, toRun: 2, effect: { hang: true }, label: 'Request times out, then recovery' });
  const staleId = ['noaa-nhc'].find((s) => available.has(s)) ?? null;
  return {
    steps,
    fastSources: fast,
    misconfigured: ['cloudflare-radar'].filter((s) => available.has(s)),
    // 6 h earlier is still after the capture time of the bundled fixture, so the simulated session is self-consistent.
    staleSource: staleId ? { id: staleId, ageMs: 6 * 3_600_000, holdSec: staleHoldSec } : null,
  };
}
