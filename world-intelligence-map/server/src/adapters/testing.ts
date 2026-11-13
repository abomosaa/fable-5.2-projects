/**
 * Test harness for source adapters. Runs the adapter's real fetch() against its bundled fixtures through the
 * real resilient HTTP client, then its real parse(), then the real normaliser – exactly the path used in fixture mode.
 */
import { describe, expect, it } from 'vitest';
import { ManualClock } from '../core/clock.ts';
import { FIXTURE_EPOCH } from '../core/fixtureEpoch.ts';
import { adaptersPath } from '../core/paths.ts';
import { SourceManifestSchema, type FetchedPayload, type IntelRecord, type ParseOutput, type RejectedItem, type SourceAdapter } from '../core/types.ts';
import { ResilientHttp } from '../http/client.ts';
import { FixtureTransport, type FixtureGenerator, type ScenarioStep } from '../http/fixtureTransport.ts';
import { normaliseDraft } from '../ingest/normalize.ts';

export interface AdapterRun {
  payloads: FetchedPayload[];
  output: ParseOutput;
  records: IntelRecord[];
  /** Rejects from parse() and from normalisation. */
  rejected: RejectedItem[];
  requests: string[];
  /** Independent requests that failed while others succeeded (ctx.partialFailure). */
  partialFailures: { key: string; error: unknown }[];
}

export interface RunOptions {
  now?: number;
  env?: Record<string, string | undefined>;
  scenario?: ScenarioStep[];
  generators?: Record<string, FixtureGenerator>;
  cursor?: Map<string, string>;
}

/** Dummy credentials for every env var the manifest declares, so credential-backed adapters can run on fixtures. */
export function fixtureEnv(adapter: SourceAdapter): Record<string, string> {
  const env: Record<string, string> = {};
  for (const v of adapter.manifest.auth.envVars) env[v.name] = `fixture-${v.name.toLowerCase()}`;
  return env;
}

export async function runAdapterOnFixtures(adapter: SourceAdapter, opts: RunOptions = {}): Promise<AdapterRun> {
  const now = opts.now ?? FIXTURE_EPOCH;
  const clock = new ManualClock(now);
  const ft = new FixtureTransport({ adaptersDir: adaptersPath(), scenario: opts.scenario, generators: opts.generators });
  ft.beginRun(adapter.manifest.id);
  const http = new ResilientHttp({ transport: ft.transport, clock, sleep: async () => {}, random: () => 0.5, policy: { minIntervalMs: 0 } });
  const env = { ...fixtureEnv(adapter), ...opts.env };
  const cursor = opts.cursor ?? new Map<string, string>();
  const sourceHttp = http.forSource(adapter.manifest);
  const partialFailures: { key: string; error: unknown }[] = [];
  const payloads = await adapter.fetch({
    partialFailure: (key, error) => void partialFailures.push({ key, error }),
    http: sourceHttp,
    env,
    now,
    cursor: { get: (k) => cursor.get(k) ?? null, set: (k, v) => void cursor.set(k, v) },
    signal: new AbortController().signal,
  });
  const output = adapter.parse(payloads, { now, env });
  const records: IntelRecord[] = [];
  const rejected: RejectedItem[] = [...output.rejected];
  const fetchedAt = payloads.length ? Math.min(...payloads.map((p) => p.fetchedAt)) : now;
  for (const draft of output.records) {
    const res = normaliseDraft(draft, { manifest: adapter.manifest, adapterVersion: adapter.version, now, fetchedAt, fetchUrls: payloads.map((p) => p.url), fixture: true });
    if (res.ok) records.push(res.record);
    else rejected.push(res.rejected);
  }
  return { payloads, output, records, rejected, requests: ft.requests.map((r) => r.url), partialFailures };
}

export interface ContractOptions extends RunOptions {
  /** Minimum number of valid records the canonical fixtures must yield. */
  minRecords?: number;
  /** Layers that the canonical fixtures are allowed to leave empty (document why in the test). */
  allowEmptyLayers?: string[];
}

/**
 * Contract every adapter must satisfy. Call inside the adapter's own test file and add source-specific
 * assertions (exact values from the fixture) next to it.
 */
export function adapterContractSuite(adapter: SourceAdapter, opts: ContractOptions = {}): void {
  const m = adapter.manifest;
  describe(`${m.id} adapter contract`, () => {
    it('has a valid machine-readable manifest', () => {
      expect(() => SourceManifestSchema.parse(m)).not.toThrow();
      expect(m.sourceUrls.every((u) => !/(api[-_]?key|token|password)=[^{&]+/i.test(u))).toBe(true);
      for (const v of m.auth.envVars) if (v.required) expect(m.auth.setup, 'credential-backed sources need setup instructions').toBeTruthy();
      if (m.auth.type === 'none') expect(m.auth.envVars.filter((v) => v.required)).toHaveLength(0);
    });

    it('fetches only allowlisted hosts and parses its fixtures into valid records', async () => {
      const run = await runAdapterOnFixtures(adapter, opts);
      expect(run.payloads.length).toBeGreaterThan(0);
      for (const url of run.requests) expect(m.allowedHosts).toContain(new URL(url).hostname);
      expect(run.records.length).toBeGreaterThanOrEqual(opts.minRecords ?? 1);

      const ids = new Set<string>();
      const layerIds = new Set(m.layers.map((l) => l.id));
      const seenLayers = new Set<string>();
      for (const r of run.records) {
        expect(ids.has(r.id), `duplicate record id ${r.id}`).toBe(false);
        ids.add(r.id);
        expect(layerIds.has(r.layerId)).toBe(true);
        seenLayers.add(r.layerId);
        expect(r.sourceId).toBe(m.id);
        expect(r.title.length).toBeGreaterThan(0);
        expect(r.title).not.toMatch(/<[a-z][^>]*>/i);
        if (r.url) expect(r.url).toMatch(/^https?:\/\//);
        if (r.geometryKind !== 'global') expect(r.point ?? r.countries[0], `record ${r.id} has no location`).toBeTruthy();
        if (r.point) {
          expect(Math.abs(r.point[0])).toBeLessThanOrEqual(180);
          expect(Math.abs(r.point[1])).toBeLessThanOrEqual(90);
        }
        const layer = m.layers.find((l) => l.id === r.layerId)!;
        if (layer.timeModel !== 'reference') expect(r.tStart, `record ${r.id} needs a time`).not.toBeNull();
        if (layer.render.type === 'choropleth') {
          expect(r.metric, `choropleth record ${r.id} needs a metric`).not.toBeNull();
          expect(r.countries.length).toBeGreaterThan(0);
        }
        if (r.confidence != null) expect(r.confidenceBasis, `record ${r.id}: confidence needs a stated basis`).toBeTruthy();
        expect(r.provenance.fixture).toBe(true);
        expect(r.attribution).toBe(m.attribution);
      }
      for (const l of m.layers) {
        if (opts.allowEmptyLayers?.includes(l.id)) continue;
        expect(seenLayers.has(l.id), `fixtures produce no records for layer ${l.id}`).toBe(true);
      }
    });

    it('is deterministic and idempotent (same fixtures → identical ids and content hashes)', async () => {
      const a = await runAdapterOnFixtures(adapter, opts);
      const b = await runAdapterOnFixtures(adapter, opts);
      expect(b.records.map((r) => [r.id, r.provenance.contentHash])).toEqual(a.records.map((r) => [r.id, r.provenance.contentHash]));
    });

    it('never emits records from a wholly malformed payload', async () => {
      const run = await runAdapterOnFixtures(adapter, opts);
      for (const garbage of ['', '<<<not the expected format>>>', '{"unexpected": true}', '[]', 'null']) {
        const payloads = run.payloads.map((p) => ({ ...p, body: Buffer.from(garbage), text: () => garbage, json: () => JSON.parse(garbage) }));
        let out: ParseOutput | null = null;
        try {
          out = adapter.parse(payloads, { now: opts.now ?? FIXTURE_EPOCH, env: { ...fixtureEnv(adapter), ...opts.env } });
        } catch (err) {
          expect((err as Error).message.length).toBeGreaterThan(0);
        }
        if (out) expect(out.records).toHaveLength(0);
      }
    });

    it('does not leak credentials into payload URLs', async () => {
      const run = await runAdapterOnFixtures(adapter, opts);
      const secrets = Object.values(fixtureEnv(adapter));
      for (const p of run.payloads) for (const s of secrets) expect(p.url).not.toContain(s);
    });
  });
}
