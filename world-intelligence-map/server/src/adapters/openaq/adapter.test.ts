import { describe, expect, it } from 'vitest';
import { FIXTURE_EPOCH } from '../../core/fixtureEpoch.ts';
import type { FetchedPayload, HttpGetOptions } from '../../core/types.ts';
import { adapterContractSuite, fixtureEnv, runAdapterOnFixtures } from '../testing.ts';
import adapter, { MAX_PAGES, pageUrl, PM25_SEVERITY } from './adapter.ts';

adapterContractSuite(adapter, { minRecords: 75 });

/** Minimal payload for exercising fetch() pagination without the fixture transport. */
function fakePayload(key: string, url: string, results: number): FetchedPayload {
  const text = JSON.stringify({ meta: { page: 1, limit: 1000, found: results }, results: Array.from({ length: results }, () => ({})) });
  return { key, url, status: 200, body: Buffer.from(text), contentType: 'application/json', fetchedAt: FIXTURE_EPOCH, etag: null, lastModified: null, notModified: false, fromCache: false, stale: false, text: () => text, json: () => JSON.parse(text) };
}

async function fetchWith(pageSizes: number[], apiKey = 'super-secret-key-123') {
  const calls: { url: string; opts: HttpGetOptions }[] = [];
  const payloads = await adapter.fetch({
    http: {
      get: async (url, opts = {}) => {
        calls.push({ url, opts });
        return fakePayload(opts.key ?? url, url, pageSizes[calls.length - 1] ?? 0);
      },
    },
    env: { OPENAQ_API_KEY: apiKey },
    now: FIXTURE_EPOCH,
    cursor: { get: () => null, set: () => {} },
    signal: new AbortController().signal,
  });
  return { calls, payloads };
}

describe('openaq specifics', () => {
  it('declares the API key requirement with setup instructions', () => {
    const m = adapter.manifest;
    expect(m.auth.type).toBe('api_key');
    expect(m.auth.envVars).toEqual([expect.objectContaining({ name: 'OPENAQ_API_KEY', required: true })]);
    expect(m.auth.obtainUrl).toBe('https://explore.openaq.org/register');
    expect(m.auth.setup).toMatch(/X-API-Key/);
  });

  it('sends the key only in the X-API-Key header, never in the URL', async () => {
    const { calls } = await fetchWith([80]);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.opts.headers).toEqual({ 'X-API-Key': 'super-secret-key-123' });
    expect(calls[0]!.opts.redact).toEqual(['super-secret-key-123']);
    expect(calls[0]!.url).not.toContain('super-secret-key-123');
    expect(calls[0]!.url).toBe('https://api.openaq.org/v3/parameters/2/latest?limit=1000&page=1&datetime_min=2026-11-10T18%3A00%3A00Z');

    const run = await runAdapterOnFixtures(adapter);
    const secret = fixtureEnv(adapter).OPENAQ_API_KEY!;
    expect(secret.length).toBeGreaterThan(4);
    for (const url of [...run.requests, ...run.payloads.map((p) => p.url)]) {
      expect(url).not.toContain(secret);
      expect(url).not.toMatch(/api[-_]?key/i);
    }
    for (const r of run.records) expect(JSON.stringify(r)).not.toContain(secret);
  });

  it('pages through full pages and stops at the first short page or the page cap', async () => {
    expect((await fetchWith([1000, 1000, 1000, 1000])).calls.map((c) => new URL(c.url).searchParams.get('page'))).toEqual(['1', '2', '3']);
    expect(MAX_PAGES).toBe(3);
    const two = await fetchWith([1000, 12]);
    expect(two.calls.map((c) => c.url)).toEqual([pageUrl(1, FIXTURE_EPOCH), pageUrl(2, FIXTURE_EPOCH)]);
    expect(two.payloads.map((p) => p.key)).toEqual(['page-1', 'page-2']);
    expect((await fetchWith([0])).calls).toHaveLength(1);
  });

  it('maps a known station measurement exactly', async () => {
    const run = await runAdapterOnFixtures(adapter);
    expect(run.rejected).toHaveLength(0);
    expect(run.records).toHaveLength(80);
    const r = run.records.find((x) => x.upstreamId === 'sensor-486234')!;
    expect(r.title).toBe('PM2.5 19.3 µg/m³ – OpenAQ location 1105186');
    expect(r.point).toEqual([69.19824, 34.53551]);
    expect(r.countries).toEqual(['AFG']);
    expect(r.occurredAt).toBe(Date.UTC(2026, 10, 10, 23, 58));
    expect(r.metric).toEqual({ name: 'PM2.5', value: 19.3, unit: 'µg/m³' });
    expect(r.attributes).toEqual({ sensorId: 486234, locationId: 1105186, stationMeasurement: true, measuredAtLocal: '2026-11-11T04:28:00+04:30', measuredAtUtc: '2026-11-10T23:58:00.000Z' });
    expect(r.severity).toBe(1);
    expect(r.confidence).toBeNull();
    expect(r.url).toBe('https://explore.openaq.org/locations/1105186');
    expect(r.provenance.derived).toEqual(['country', 'severity']);
    for (const x of run.records) expect(FIXTURE_EPOCH - x.occurredAt!).toBeLessThanOrEqual(600_000);
  });

  it('derives severity from the EPA PM2.5 breakpoints', async () => {
    expect(PM25_SEVERITY).toEqual([9.05, 35.45, 55.45, 125.45]);
    const run = await runAdapterOnFixtures(adapter);
    for (const r of run.records) {
      const v = r.metric!.value;
      expect(r.severity).toBe(v <= 9 ? 0 : v <= 35.4 ? 1 : v <= 55.4 ? 2 : v <= 125.4 ? 3 : 4);
    }
    expect(run.records.find((r) => r.upstreamId === 'sensor-6766109')!.severity).toBe(4); // 222.6 µg/m³
    expect([0, 1, 2, 3, 4].map((s) => run.records.filter((r) => r.severity === s).length)).toEqual([33, 31, 8, 5, 3]);
  });

  it('rejects malformed results individually and converts local times with their UTC offset', async () => {
    const run = await runAdapterOnFixtures(adapter, { scenario: [{ source: adapter.manifest.id, fromRun: 1, effect: { variant: 'malformed' } }] });
    expect(run.records.map((r) => r.upstreamId).sort()).toEqual(['sensor-9001', 'sensor-9002', 'sensor-9003']);
    expect(run.rejected.map((r) => r.reason).sort()).toEqual([
      'implausible PM2.5 value 99999',
      'measurement time is in the future',
      'missing or invalid coordinates',
      'missing or invalid coordinates',
      'missing or unparseable measurement time',
      'missing sensor id',
      'negative or sentinel value -999',
      'non-numeric value',
      'result is not an object',
    ]);
    // Only `local` given: 05:21 at +05:30 is 23:51 UTC on the previous day.
    const localOnly = run.records.find((r) => r.upstreamId === 'sensor-9002')!;
    expect(localOnly.occurredAt).toBe(Date.UTC(2026, 10, 10, 23, 51));
    expect(localOnly.attributes.measuredAtUtc).toBe('2026-11-10T23:51:00.000Z');
    expect(localOnly.severity).toBe(4);
    // The duplicated sensor keeps its first reading; hostile text in `local` never reaches the record.
    expect(run.records.find((r) => r.upstreamId === 'sensor-9001')!.metric!.value).toBe(12.5);
    const hostile = run.records.find((r) => r.upstreamId === 'sensor-9003')!;
    expect(hostile.attributes.measuredAtLocal).toBeUndefined();
    expect(hostile.title).toBe('PM2.5 7 µg/m³ – OpenAQ sensor 9003');
    expect(hostile.url).toBeNull();
    expect(JSON.stringify(hostile)).not.toContain('alert(');
  });
});
