import { describe, expect, it } from 'vitest';
import { FIXTURE_EPOCH } from '../../core/fixtureEpoch.ts';
import { adapterContractSuite, runAdapterOnFixtures } from '../testing.ts';
import adapter, { CAP_CERTAINTY, CAP_SEVERITY } from './adapter.ts';

adapterContractSuite(adapter, { minRecords: 100 });

describe('nws-alerts specifics', () => {
  it('maps a known tornado warning with correct UTC times, severity and confidence', async () => {
    const run = await runAdapterOnFixtures(adapter);
    expect(run.rejected).toHaveLength(0);
    const r = run.records.find((x) => x.upstreamId === 'urn:oid:2.49.0.1.840.0.b83d49349536bb677c139ef3e800fc409fe84794.001.1')!;
    expect(r).toBeTruthy();
    expect(r.layerId).toBe('nws-warnings');
    expect(r.subcategory).toBe('Tornado Warning');
    expect(r.title).toBe('Tornado Warning – Wayne, NC');
    expect(r.geometryKind).toBe('polygon');
    expect(r.bbox).toEqual([-77.97, 35.24, -77.8, 35.39]);
    // "2026-11-06T20:50:00-05:00" (EST) is 01:50 UTC on the following day.
    expect(r.occurredAt).toBe(Date.UTC(2026, 10, 7, 1, 50));
    expect(r.publishedAt).toBe(Date.UTC(2026, 10, 7, 1, 50));
    expect(r.expiresAt).toBe(Date.UTC(2026, 10, 7, 2, 0));
    expect(r.tEnd).toBe(Date.UTC(2026, 10, 7, 2, 0));
    expect(r.severity).toBe(4);
    expect(r.severityLabel).toBe('Extreme');
    expect(r.confidence).toBe(0.95);
    expect(r.confidenceBasis).toBe('CAP certainty stated by NWS: Observed');
    expect(r.countries).toEqual(['USA']);
    expect(r.attributes.senderName).toBe('NWS Raleigh NC');
    expect(r.attributes.urgency).toBe('Immediate');
    expect(r.url).toBe('https://api.weather.gov/alerts/urn:oid:2.49.0.1.840.0.b83d49349536bb677c139ef3e800fc409fe84794.001.1');
    // Severity is stated by NWS; only confidence and the country are inferred here.
    expect(r.provenance.derived).toEqual(['confidence', 'country']);
  });

  it('starts an alert at issuance and keeps a later hazard onset and end in attributes (CST → UTC)', async () => {
    const run = await runAdapterOnFixtures(adapter);
    const r = run.records.find((x) => x.upstreamId === 'urn:oid:2.49.0.1.840.0.354e7062a55e4a9c84de7b237f70dbe2c4cb041f.001.1')!;
    expect(r.title).toBe('Flood Warning – Val Verde, TX');
    expect(r.occurredAt).toBe(Date.UTC(2026, 10, 9, 23, 18)); // sent 17:18 -06:00
    expect(r.attributes.onsetUtc).toBe('2026-11-10T01:00:00.000Z'); // onset 19:00 -06:00
    expect(r.expiresAt).toBe(Date.UTC(2026, 10, 10, 22, 0)); // "ends" 16:00 -06:00 wins over "expires" 06:00 -06:00
    expect(r.attributes.expiresUtc).toBe('2026-11-10T12:00:00.000Z');
    expect(r.severity).toBe(3);
    expect(r.confidence).toBe(0.8);
  });

  it('splits warnings from other products, skips zone-based alerts and keeps some alerts active at the epoch', async () => {
    const run = await runAdapterOnFixtures(adapter);
    const upstream = (run.payloads[0]!.json() as { features: { geometry: unknown; properties: { event: string } }[] }).features;
    const withGeometry = upstream.filter((f) => f.geometry);
    expect(upstream.length - withGeometry.length).toBe(10);
    expect(run.records).toHaveLength(withGeometry.length);
    for (const r of run.records) {
      expect(r.layerId).toBe(/Warning$/.test(r.subcategory!) ? 'nws-warnings' : 'nws-watches-advisories');
      expect(['Polygon', 'MultiPolygon']).toContain(r.geometry!.type);
      expect(r.tEnd!).toBeGreaterThanOrEqual(r.tStart!);
      expect(r.occurredAt!).toBeLessThan(FIXTURE_EPOCH);
    }
    expect(run.records.filter((r) => r.layerId === 'nws-watches-advisories').length).toBeGreaterThan(30);
    expect(run.records.filter((r) => r.tEnd! > FIXTURE_EPOCH).length).toBeGreaterThanOrEqual(10);
    // Puerto Rico alerts resolve to PRI, not USA; marine-zone alerts carry no country.
    expect(run.records.some((r) => r.countries[0] === 'PRI')).toBe(true);
    expect(run.records.some((r) => r.subcategory === 'Special Marine Warning' && r.countries.length === 0)).toBe(true);
  });

  it('uses the upstream CAP severity and a documented certainty → confidence table', async () => {
    expect(CAP_SEVERITY).toEqual({ extreme: 4, severe: 3, moderate: 2, minor: 1, unknown: null });
    expect(CAP_CERTAINTY).toEqual({ observed: 0.95, likely: 0.8, possible: 0.5, unlikely: 0.2, unknown: null });
    const run = await runAdapterOnFixtures(adapter);
    for (const r of run.records) {
      expect(r.severity).toBe(CAP_SEVERITY[r.severityLabel!.toLowerCase()]);
      expect(r.confidence).toBe(CAP_CERTAINTY[String(r.attributes.certainty).toLowerCase()]);
      expect(r.provenance.derived).not.toContain('severity');
    }
    expect(new Set(run.records.map((r) => r.severity))).toEqual(new Set([1, 2, 3, 4]));
  });

  it('asks for GeoJSON from the documented endpoint', async () => {
    const calls: { url: string; headers?: Record<string, string> }[] = [];
    await adapter.fetch({
      http: { get: async (url, opts) => (calls.push({ url, headers: opts?.headers }), {} as never) },
      env: {},
      now: FIXTURE_EPOCH,
      cursor: { get: () => null, set: () => {} },
      signal: new AbortController().signal,
    });
    expect(calls).toEqual([{ url: 'https://api.weather.gov/alerts/active?status=actual&message_type=alert,update', headers: { accept: 'application/geo+json' } }]);
    expect(adapter.manifest.http.userAgentRequired).toBe(true);
  });

  it('rejects malformed alerts individually, skips non-alerts silently and sanitises hostile text', async () => {
    const run = await runAdapterOnFixtures(adapter, { scenario: [{ source: adapter.manifest.id, fromRun: 1, effect: { variant: 'malformed' } }] });
    expect(run.records.map((r) => r.upstreamId).sort()).toEqual(['urn:oid:ok-1', 'urn:oid:ok-2']);
    expect(run.rejected.map((r) => r.reason).sort()).toEqual([
      'geometry: latitude 123.4 out of range',
      'geometry: too few positions (need 3)',
      'missing event name',
      'missing or unparseable sent/effective time',
      'missing properties',
      'unparseable ends/expires time',
      'unsupported geometry type Point',
    ]);
    const ok = run.records.find((r) => r.upstreamId === 'urn:oid:ok-1')!;
    expect(ok.occurredAt).toBe(Date.UTC(2026, 10, 10, 23, 30)); // 17:30 -06:00
    expect(ok.expiresAt).toBe(Date.UTC(2026, 10, 11, 0, 15));
    const hostile = run.records.find((r) => r.upstreamId === 'urn:oid:ok-2')!;
    expect(hostile.title).toBe('Flood Advisory – San Juan, PR');
    expect(hostile.description).toBe('Urban and small stream flooding.');
    expect(hostile.attributes.headline).toBe('Flood Advisory');
    expect(hostile.url).toBeNull();
    expect(hostile.confidence).toBeNull(); // certainty "Unknown"
    expect(hostile.severity).toBe(1);
    expect(hostile.countries).toEqual(['PRI']);
    expect(hostile.expiresAt).toBe(Date.UTC(2026, 10, 11, 2, 0)); // 22:00 -04:00, "ends" is null
    expect(hostile.provenance.normalisation).toEqual(expect.arrayContaining(['closed open polygon ring', 'dropped non-http(s) source link']));
  });
});
