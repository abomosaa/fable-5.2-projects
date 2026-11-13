import { describe, expect, it } from 'vitest';
import { adapterContractSuite, runAdapterOnFixtures } from '../testing.ts';
import adapter, { INDICATORS } from './adapter.ts';

adapterContractSuite(adapter, { minRecords: 2000 });

describe('worldbank-indicators specifics', () => {
  it('requests every indicator once and maps each to its own layer', async () => {
    const run = await runAdapterOnFixtures(adapter);
    expect(run.payloads.map((p) => p.key)).toEqual(Object.keys(INDICATORS));
    expect(run.requests[0]).toBe('https://api.worldbank.org/v2/country/all/indicator/SP.POP.TOTL?format=json&date=2020:2026&per_page=20000');
    expect(run.rejected).toHaveLength(0);
    const perLayer = new Map<string, number>();
    for (const r of run.records) perLayer.set(r.layerId, (perLayer.get(r.layerId) ?? 0) + 1);
    for (const layerId of Object.values(INDICATORS)) expect(perLayer.get(layerId)).toBeGreaterThan(150);
  });

  it('emits country-level indicator records with year-based times and skips aggregates', async () => {
    const run = await runAdapterOnFixtures(adapter);
    const ind = run.records.filter((r) => r.layerId === 'wb-population' && r.countries[0] === 'IND').sort((a, b) => a.tStart! - b.tStart!);
    expect(ind.length).toBe(3);
    const latest = ind[ind.length - 1]!;
    expect(latest.geometryKind).toBe('country');
    expect(latest.geometry).toBeNull();
    expect(latest.metric!.value).toBeGreaterThan(1.4e9);
    expect(latest.metric!.unit).toBe('people');
    expect(latest.occurredAt).toBe(Date.UTC(Number(latest.metric!.period), 0, 1));
    expect(latest.updatedAt).toBe(Date.UTC(2026, 9, 8));
    expect(latest.url).toBe('https://data.worldbank.org/indicator/SP.POP.TOTL?locations=IN');
    expect(latest.confidence).toBeNull();
    // Aggregates such as "World" (WLD) or "Africa Eastern and Southern" (AFE) must not become countries.
    expect(run.records.some((r) => /World|Africa Eastern/.test(r.title))).toBe(false);
    // Every record resolves to exactly one ISO3 country known to the gazetteer.
    expect(run.records.every((r) => r.countries.length === 1 && /^[A-Z]{3}$/.test(r.countries[0]!))).toBe(true);
  });

  it('rejects malformed rows individually and maps provider-specific country codes', async () => {
    const run = await runAdapterOnFixtures(adapter, { scenario: [{ source: adapter.manifest.id, fromRun: 1, effect: { variant: 'malformed' } }] });
    const pop = run.records.filter((r) => r.layerId === 'wb-population');
    expect(pop.map((r) => r.upstreamId).sort()).toEqual(['SP.POP.TOTL:KEN:2025', 'SP.POP.TOTL:KOS:2025']);
    const reasons = run.rejected.map((r) => r.reason);
    expect(reasons).toContain('unparseable period "next year"');
    expect(reasons).toContain('non-numeric value');
    expect(reasons).toContain('unexpected indicator XX.NOT.EXPECTED');
    expect(reasons).toHaveLength(3); // the unknown country "ATL" is skipped like an aggregate, not rejected
  });

  it('keeps the indicators that loaded when the API answers others with 502, and reports the gap', async () => {
    const run = await runAdapterOnFixtures(adapter, {
      scenario: [
        { source: adapter.manifest.id, fromRun: 1, urlIncludes: 'NY.GDP.PCAP.CD', effect: { status: 502 } },
        { source: adapter.manifest.id, fromRun: 1, urlIncludes: 'IT.NET.USER.ZS', effect: { status: 502 } },
      ],
    });
    expect(run.partialFailures.map((f) => f.key)).toEqual(['NY.GDP.PCAP.CD', 'IT.NET.USER.ZS']);
    expect(run.payloads.map((p) => p.key)).toEqual(Object.keys(INDICATORS).filter((c) => c !== 'NY.GDP.PCAP.CD' && c !== 'IT.NET.USER.ZS'));
    const layers = new Set(run.records.map((r) => r.layerId));
    expect(layers.has('wb-population')).toBe(true);
    expect(layers.has('wb-gdp-per-capita')).toBe(false);
    expect(layers.size).toBe(6);
  });

  it('fails as a whole when every indicator request fails', async () => {
    await expect(runAdapterOnFixtures(adapter, { scenario: [{ source: adapter.manifest.id, fromRun: 1, effect: { status: 502 } }] })).rejects.toThrow(/502|circuit breaker open/); // five failures open the breaker
  });
});
