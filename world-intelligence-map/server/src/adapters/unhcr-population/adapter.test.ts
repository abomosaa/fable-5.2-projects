import { describe, expect, it } from 'vitest';
import { FIXTURE_EPOCH } from '../../core/fixtureEpoch.ts';
import type { FetchedPayload, HttpGetOptions } from '../../core/types.ts';
import { adapterContractSuite, runAdapterOnFixtures } from '../testing.ts';
import adapter, { populationUrl, unhcrCount } from './adapter.ts';

adapterContractSuite(adapter, { minRecords: 1000 });

function fakePayload(key: string, url: string, body: unknown): FetchedPayload {
  const text = JSON.stringify(body);
  return { key, url, status: 200, body: Buffer.from(text), contentType: 'application/json', fetchedAt: FIXTURE_EPOCH, etag: null, lastModified: null, notModified: false, fromCache: false, stale: false, text: () => text, json: <T>() => JSON.parse(text) as T };
}

describe('unhcr-population specifics', () => {
  it('requests the origin and asylum views for the current and three preceding years', async () => {
    const run = await runAdapterOnFixtures(adapter);
    expect(run.requests).toEqual([
      'https://api.unhcr.org/population/v1/population/?limit=1000&page=1&yearFrom=2023&yearTo=2026&coo_all=true',
      'https://api.unhcr.org/population/v1/population/?limit=1000&page=1&yearFrom=2023&yearTo=2026&coa_all=true',
    ]);
    expect(populationUrl('coa', 2, Date.UTC(2031, 5, 1))).toBe('https://api.unhcr.org/population/v1/population/?limit=1000&page=2&yearFrom=2028&yearTo=2031&coa_all=true');
    expect(run.rejected).toHaveLength(0);
    const years = new Set(run.records.map((r) => r.metric!.period));
    expect([...years].sort()).toEqual(['2023', '2024', '2025']);
  });

  it('maps a known origin row to refugees + asylum-seekers and a separate IDP record', async () => {
    const run = await runAdapterOnFixtures(adapter);
    const origin = run.records.find((r) => r.upstreamId === 'origin-AFG-2025')!;
    expect(origin.id).toBe('unhcr-population:origin-AFG-2025');
    expect(origin.layerId).toBe('unhcr-refugees-origin');
    expect(origin.geometryKind).toBe('country');
    expect(origin.geometry).toBeNull();
    expect(origin.countries).toEqual(['AFG']);
    expect(origin.title).toBe('Refugees and asylum-seekers from Afghanistan (end of 2025)');
    expect(origin.metric).toEqual({ name: 'Refugees and asylum-seekers by origin', value: 2671560 + 270007, unit: 'people', period: '2025' });
    expect(origin.attributes.refugees).toBe(2671560);
    expect(origin.attributes.asylumSeekers).toBe(270007);
    expect(origin.attributes.otherInNeedOfInternationalProtection).toBe(1030958);
    expect(origin.attributes.asOf).toBe('2025-12-31');
    expect(origin.occurredAt).toBe(Date.UTC(2025, 0, 1));
    expect(origin.confidence).toBeNull();
    expect(origin.provenance.derived).toEqual([]);
    expect(origin.url).toBe('https://api.unhcr.org/population/v1/population/?yearFrom=2025&yearTo=2025&coo=AFG&cf_type=ISO');

    const idps = run.records.find((r) => r.upstreamId === 'idps-AFG-2025')!;
    expect(idps.layerId).toBe('unhcr-idps');
    expect(idps.metric!.value).toBe(3199023);
    expect(idps.attributes.returnedIdps).toBe(8056);

    const asylum = run.records.find((r) => r.upstreamId === 'asylum-DEU-2025')!;
    expect(asylum.layerId).toBe('unhcr-refugees-asylum');
    expect(asylum.title).toBe('Refugees and asylum-seekers hosted in Germany (end of 2025)');
    expect(asylum.metric!.value).toBe(2655191 + 297503);
    expect(asylum.attributes.unhcrCountryCode).toBe('GFR'); // UNHCR's own code differs from ISO; the ISO column is used
  });

  it('uses ISO codes (not UNHCR codes), skips zero rows and never maps "Unknown" origin to a country', async () => {
    const run = await runAdapterOnFixtures(adapter);
    // UNHCR code "ARE" is Egypt and "AUS" is Austria – the records must follow the ISO column.
    const egypt = run.records.find((r) => r.upstreamId === 'asylum-EGY-2025')!;
    expect(egypt.attributes.unhcrCountryCode).toBe('ARE');
    expect(run.records.find((r) => r.upstreamId === 'asylum-AUT-2025')!.attributes.unhcrCountryCode).toBe('AUS');
    // 1.7 million people of "Unknown" origin carry the pseudo-ISO code UNK, which the gazetteer would resolve to Kosovo.
    expect(run.records.some((r) => r.countries.includes('KOS'))).toBe(false);
    expect(run.records.some((r) => /unknown|stateless|tibetan/i.test(r.title))).toBe(false);
    expect(run.records.every((r) => r.metric!.value > 0 && Number.isInteger(r.metric!.value))).toBe(true);
    expect(run.records.every((r) => r.countries.length === 1)).toBe(true);
    // IDPs come only from the origin view, once per country and year.
    const idps = run.records.filter((r) => r.layerId === 'unhcr-idps');
    expect(idps.length).toBe(112);
    expect(idps.filter((r) => r.metric!.period === '2025').sort((a, b) => b.metric!.value - a.metric!.value)[0]!.countries).toEqual(['SDN']);
  });

  it('interprets numbers, numeric strings, "-" and garbage', () => {
    expect(unhcrCount(5661717)).toBe(5661717);
    expect(unhcrCount('0')).toBe(0);
    expect(unhcrCount('1234')).toBe(1234);
    expect(unhcrCount('-')).toBeNull();
    expect(unhcrCount('')).toBeNull();
    expect(unhcrCount(null)).toBeNull();
    expect(unhcrCount('many')).toBeUndefined();
    expect(unhcrCount(-5)).toBeUndefined();
    expect(unhcrCount({ value: 5 })).toBeUndefined();
  });

  it('follows maxPages when a view spans several pages', async () => {
    const requested: string[] = [];
    const row = (iso: string, n: number) => ({ year: 2025, coo: iso, coo_iso: iso, coo_name: iso, coa: '-', coa_iso: '-', coa_name: '-', refugees: n, asylum_seekers: '0', idps: '0', oip: '-' });
    const http = {
      async get(url: string, opts: HttpGetOptions = {}): Promise<FetchedPayload> {
        requested.push(url);
        const page = Number(new URL(url).searchParams.get('page'));
        const coo = url.includes('coo_all=true');
        const items = coo ? [row(['KEN', 'UGA', 'TZA'][page - 1]!, page * 100)] : [];
        return fakePayload(opts.key ?? url, url, { page, maxPages: coo ? 3 : 1, items });
      },
    };
    const payloads = await adapter.fetch({ http, env: {}, now: FIXTURE_EPOCH, cursor: { get: () => null, set: () => {} }, signal: new AbortController().signal });
    expect(payloads.map((p) => p.key)).toEqual(['coo:1', 'coo:2', 'coo:3', 'coa:1']);
    expect(requested.filter((u) => u.includes('coo_all')).map((u) => new URL(u).searchParams.get('page'))).toEqual(['1', '2', '3']);
    const out = adapter.parse(payloads, { now: FIXTURE_EPOCH, env: {} });
    expect(out.records.map((r) => [r.upstreamId, r.metric!.value])).toEqual([['origin-KEN-2025', 100], ['origin-UGA-2025', 200], ['origin-TZA-2025', 300]]);
  });

  it('rejects malformed rows individually and skips non-country rows silently', async () => {
    const run = await runAdapterOnFixtures(adapter, { scenario: [{ source: adapter.manifest.id, fromRun: 1, effect: { variant: 'malformed' } }] });
    const origin = run.records.filter((r) => r.layerId !== 'unhcr-refugees-asylum');
    expect(origin.map((r) => r.upstreamId).sort()).toEqual(['idps-AFG-2025', 'origin-AFG-2025', 'origin-DZA-2025', 'origin-KOS-2025']);
    expect(run.rejected.map((r) => r.reason).sort()).toEqual([
      'missing origin country code',
      'non-numeric asylum_seekers value',
      'non-numeric idps value',
      'non-numeric refugees value',
      'row is not an object',
      'unparseable year "next year"',
    ]);
    // First row wins over the duplicate; string counts and "-" are handled; hostile markup is stripped.
    expect(origin.find((r) => r.upstreamId === 'origin-AFG-2025')!.metric!.value).toBe(2941567);
    const dza = origin.find((r) => r.upstreamId === 'origin-DZA-2025')!;
    expect(dza.metric!.value).toBe(9174);
    expect(dza.attributes.asylumSeekers).toBe(0);
    expect(dza.title).toBe('Refugees and asylum-seekers from Algeria (end of 2025)');
    expect(dza.occurredAt).toBe(Date.UTC(2025, 0, 1));
    expect(origin.find((r) => r.upstreamId === 'origin-KOS-2025')!.countries).toEqual(['KOS']); // XKX is mapped by the gazetteer
    // The asylum view was served from its canonical file and is unaffected.
    expect(run.records.filter((r) => r.layerId === 'unhcr-refugees-asylum').length).toBe(509);
  });
});
