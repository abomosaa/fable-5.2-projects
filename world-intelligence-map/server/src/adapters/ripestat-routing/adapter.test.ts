import { describe, expect, it } from 'vitest';
import { adapterContractSuite, runAdapterOnFixtures } from '../testing.ts';
import adapter, { WATCHLIST } from './adapter.ts';

adapterContractSuite(adapter, { minRecords: 600 });

const MALFORMED = [{ source: adapter.manifest.id, fromRun: 1, effect: { variant: 'malformed' } }];

describe('ripestat-routing specifics', () => {
  it('requests each watch-list country once, sequentially, with the documented parameters', async () => {
    const run = await runAdapterOnFixtures(adapter);
    expect(WATCHLIST).toHaveLength(40);
    expect(new Set(WATCHLIST).size).toBe(40);
    expect(run.payloads.map((p) => p.key)).toEqual([...WATCHLIST]);
    expect(run.requests).toHaveLength(40);
    // 48 hours before the fixture epoch (2026-11-11T00:00Z), aligned to the 6-hour grid, hourly resolution.
    expect(run.requests[0]).toBe('https://stat.ripe.net/data/country-resource-stats/data.json?resource=us&starttime=2026-11-09T00:00&resolution=1h&sourceapp=fixture-ripestat_sourceapp');
    for (const url of run.requests) expect(url).toMatch(/[?&]sourceapp=[A-Za-z0-9_-]+$/);
    expect(run.rejected).toHaveLength(0);
  });

  it('keeps the request URL stable inside a 6-hour slot and falls back to the default sourceapp', async () => {
    const at = (iso: string) => runAdapterOnFixtures(adapter, { now: Date.parse(iso), env: { RIPESTAT_SOURCEAPP: undefined } });
    const a = await at('2026-11-10T18:05:00Z');
    const b = await at('2026-11-10T23:59:00Z');
    expect(a.requests[0]).toBe('https://stat.ripe.net/data/country-resource-stats/data.json?resource=us&starttime=2026-11-08T18:00&resolution=1h&sourceapp=world-intelligence-map');
    expect(b.requests).toEqual(a.requests);
    // An identifier that does not match the documented format is never sent.
    const c = await runAdapterOnFixtures(adapter, { env: { RIPESTAT_SOURCEAPP: 'bad value&resource=zz' } });
    expect(c.requests[0]).toContain('sourceapp=world-intelligence-map');
    expect(c.requests.join(' ')).not.toContain('zz');
  });

  it('expands run-length periods and computes the 24 h change with exact values (Ethiopia)', async () => {
    const run = await runAdapterOnFixtures(adapter);
    const eth = run.records.filter((r) => r.countries[0] === 'ETH').sort((a, b) => a.tStart! - b.tStart!);
    // Synthetic fixture (see fixtures/index.json): hours 00:00–15:00 UTC on 2026-11-10 each have a value 24 h earlier,
    // encoded upstream-style in only 5 run-length periods (580, 453, 604, 574, 605 prefixes against 600/604 the day before).
    expect(eth.map((r) => r.upstreamId)).toEqual(Array.from({ length: 16 }, (_, h) => `ET.2026-11-10T${String(h).padStart(2, '0')}Z`));
    expect(eth.map((r) => r.metric!.value)).toEqual([-3.333, -3.333, -24.5, -24.5, -25, 0, 0, 0, -4.967, -4.967, -4.967, -4.967, 0.166, 0.166, 0.166, 0.166]);

    const r = eth[2]!;
    expect(r.id).toBe('ripestat-routing:ET.2026-11-10T02Z');
    expect(r.layerId).toBe('bgp-routed-prefixes');
    expect(r.domain).toBe('cyber');
    expect(r.geometryKind).toBe('country');
    expect(r.geometry).toBeNull();
    expect(r.occurredAt).toBe(Date.UTC(2026, 10, 10, 2, 0, 0)); // zone-less upstream times are UTC
    expect(r.tStart).toBe(r.occurredAt);
    expect(r.title).toBe('Routed IPv4 prefixes – Ethiopia: -24.50 % vs 24 h earlier (2026-11-10 02:00 UTC)');
    expect(r.description).toContain('453 IPv4 prefixes');
    expect(r.description).toContain('against 600 24 hours earlier');
    expect(r.description).toContain('not proof of an outage');
    expect(r.metric).toEqual({ name: 'Routed IPv4 prefixes, change vs 24 h earlier', value: -24.5, unit: '%', period: '2026-11-10T02:00Z' });
    expect(r.attributes).toEqual({
      countryCode: 'ET',
      routedV4Prefixes: 453,
      routedV4Prefixes24hEarlier: 600,
      routedV4PrefixChange: -147,
      routedV6Prefixes: 12,
      routedV6Prefixes24hEarlier: 12,
      routedV6PrefixChangePct: 0,
      routedAsns: 9,
      routedAsns24hEarlier: 9,
      routedAsnChangePct: 0,
      registeredAsns: 14,
      resolution: '1h',
    });
    expect(r.url).toBe('https://stat.ripe.net/resource/ET');
    // The source publishes no severity or confidence; the percentage is computed here and flagged as derived.
    expect(r.severity).toBeNull();
    expect(r.confidence).toBeNull();
    expect(r.provenance.derived).toEqual(['metric']);
    expect(run.output.upstreamTime).toBe(Date.UTC(2026, 10, 10, 15, 59, 59));
  });

  it('covers every watch-list country for the same 16 hours and keeps fractional hourly aggregates', async () => {
    const run = await runAdapterOnFixtures(adapter);
    expect(run.records).toHaveLength(40 * 16);
    const perCountry = new Map<string, number>();
    for (const r of run.records) {
      perCountry.set(r.countries[0]!, (perCountry.get(r.countries[0]!) ?? 0) + 1);
      expect(r.countries).toHaveLength(1);
      expect(r.occurredAt! % 3_600_000).toBe(0);
      expect(r.occurredAt!).toBeGreaterThanOrEqual(Date.UTC(2026, 10, 10, 0));
      expect(r.occurredAt!).toBeLessThanOrEqual(Date.UTC(2026, 10, 10, 15));
      expect(Math.abs(r.metric!.value)).toBeLessThan(100);
    }
    expect(perCountry.size).toBe(40);
    expect([...perCountry.values()].every((n) => n === 16)).toBe(true);

    const us = run.records.find((r) => r.upstreamId === 'US.2026-11-10T15Z')!;
    expect(us.metric!.value).toBe(0.26);
    expect(us.attributes.routedV4Prefixes).toBe(120119.5); // hourly aggregates can be fractional
    expect(us.attributes.routedV4Prefixes24hEarlier).toBe(119808);
    expect(us.attributes.routedV4PrefixChange).toBe(311.5);
    expect(us.attributes.routedV6Prefixes).toBe(21575);
    expect(us.attributes.routedAsns).toBe(8571);
    expect(us.attributes.registeredAsns).toBe(13714);
    expect(us.title).toBe('Routed IPv4 prefixes – United States of America: +0.26 % vs 24 h earlier (2026-11-10 15:00 UTC)');
  });

  it('shows the invented drops and rise of the synthetic fixture on the diverging scale, without severity or confidence', async () => {
    const run = await runAdapterOnFixtures(adapter);
    const at = (id: string) => run.records.find((r) => r.upstreamId === id)!;
    // A period list with a gap (12:00 and 14:00–15:00 share one stats entry) is expanded hour by hour.
    const sd = at('SD.2026-11-10T14Z');
    expect(sd.metric!.value).toBe(-68.958);
    expect(sd.attributes).toMatchObject({ routedV4Prefixes: 2120, routedV4Prefixes24hEarlier: 6829.5, routedV4PrefixChange: -4709.5, routedAsns: 287, routedAsns24hEarlier: 489, routedAsnChangePct: -41.309 });
    expect(sd.title).toBe('Routed IPv4 prefixes – Sudan: -68.96 % vs 24 h earlier (2026-11-10 14:00 UTC)');
    expect(at('SD.2026-11-10T07Z').metric!.value).toBe(0.161); // the hour before the invented drop
    expect(at('IR.2026-11-10T05Z').metric!.value).toBe(-41.991);
    expect(at('IR.2026-11-10T11Z').metric!.value).toBe(-0.031); // back to normal
    expect(at('CU.2026-11-10T11Z').metric!.value).toBe(-88.018);
    expect(at('KZ.2026-11-10T09Z').metric!.value).toBe(14.158); // 3588 against 3143
    const big = run.records.filter((r) => Math.abs(r.metric!.value) >= 10);
    expect(new Set(big.map((r) => r.countries[0]))).toEqual(new Set(['IRN', 'SDN', 'MMR', 'CUB', 'KAZ', 'ETH']));
    for (const r of big) {
      expect(r.severity).toBeNull(); // a drop is a signal, not a rated incident
      expect(r.confidence).toBeNull();
      expect(r.title).not.toMatch(/outage|shutdown/i);
    }
  });

  it('rejects broken stats entries individually and skips "no data" sentinels', async () => {
    const run = await runAdapterOnFixtures(adapter, { scenario: MALFORMED });
    const ukr = run.records.filter((r) => r.countries[0] === 'UKR').sort((a, b) => a.tStart! - b.tStart!);
    expect(ukr.map((r) => r.upstreamId)).toEqual(['UA.2026-11-10T00Z', 'UA.2026-11-10T01Z', 'UA.2026-11-10T02Z']);
    expect(ukr.map((r) => r.metric!.value)).toEqual([-0.2, -0.2, -50]);
    // Numeric strings are accepted; hostile / missing optional counts are dropped instead of being copied.
    expect(ukr[2]!.attributes).toEqual({ countryCode: 'UA', routedV4Prefixes: 5750, routedV4Prefixes24hEarlier: 11500, routedV4PrefixChange: -5750, routedV6Prefixes24hEarlier: 968, routedAsns24hEarlier: 1400, resolution: '1h' });
    expect(JSON.stringify(ukr)).not.toContain('alert(1)');

    expect(run.rejected.map((r) => r.reason).sort()).toEqual([
      'duplicate observation for 2026-11-10T01:00Z',
      'missing timeline',
      'non-numeric v4_prefixes_ris',
      'stats entry is not an object',
      'timeline period ends before it starts',
      'timeline period is in the future',
      'timeline period too long',
      'unparseable timeline period',
    ]);
    // The other 39 countries are unaffected by one bad payload.
    expect(run.records).toHaveLength(39 * 16 + 3);
  });

  it('refuses error envelopes and unexpected resolutions', async () => {
    const run = await runAdapterOnFixtures(adapter);
    const withBody = (obj: unknown) => {
      const text = JSON.stringify(obj);
      return [{ ...run.payloads[0]!, body: Buffer.from(text), text: () => text, json: <T>() => JSON.parse(text) as T }];
    };
    const ok = run.payloads[0]!.json<{ data: Record<string, unknown> }>();
    expect(() => adapter.parse(withBody({ ...ok, status: 'maintenance' }), { now: run.payloads[0]!.fetchedAt, env: {} })).toThrow(/status "maintenance"/);
    const daily = adapter.parse(withBody({ ...ok, data: { ...ok.data, resolution: '1d' } }), { now: run.payloads[0]!.fetchedAt, env: {} });
    expect(daily.records).toHaveLength(0);
    expect(daily.rejected[0]!.reason).toContain('unexpected resolution "1d"');
    const unknown = adapter.parse(withBody({ ...ok, data: { ...ok.data, resource: 'zz' } }), { now: run.payloads[0]!.fetchedAt, env: {} });
    expect(unknown.records).toHaveLength(0);
    expect(unknown.rejected[0]!.reason).toBe('unrecognised country resource "ZZ"');
  });
});
