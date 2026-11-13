import { describe, expect, it } from 'vitest';
import { FIXTURE_EPOCH } from '../../core/fixtureEpoch.ts';
import type { FetchedPayload, HttpGetOptions } from '../../core/types.ts';
import { adapterContractSuite, runAdapterOnFixtures } from '../testing.ts';
import adapter, { ENDPOINTS, endpointUrl, PAGE_SIZE } from './adapter.ts';

adapterContractSuite(adapter, { minRecords: 200 });

function fakePayload(key: string, url: string, body: unknown): FetchedPayload {
  const text = JSON.stringify(body);
  return { key, url, status: 200, body: Buffer.from(text), contentType: 'application/json', fetchedAt: FIXTURE_EPOCH, etag: null, lastModified: null, notModified: false, fromCache: false, stale: false, text: () => text, json: <T>() => JSON.parse(text) as T };
}

describe('hdx-hapi specifics', () => {
  it('sends the documented v2 queries with the app identifier as a query parameter and redacts it', async () => {
    const secret = 'bXktbWFwOm1lQGV4YW1wbGUub3Jn+/=';
    const run = await runAdapterOnFixtures(adapter, { env: { HDX_APP_IDENTIFIER: secret } });
    expect(run.requests).toHaveLength(3);
    const urls = run.requests.map((u) => new URL(u));
    expect(urls.map((u) => u.pathname)).toEqual([
      '/api/v2/affected-people/idps',
      '/api/v2/affected-people/humanitarian-needs',
      '/api/v2/food-security-nutrition-poverty/food-security',
    ]);
    for (const u of urls) {
      expect(u.searchParams.get('app_identifier')).toBe(secret); // sent exactly as generated, URL-encoded on the wire
      expect(u.searchParams.get('admin_level')).toBe('0');
      expect(u.searchParams.get('output_format')).toBe('json');
      expect(u.searchParams.get('limit')).toBe(String(PAGE_SIZE));
      expect(u.searchParams.get('offset')).toBe('0');
      expect(u.searchParams.get('start_date')).toBe('2023-01-01');
    }
    expect(urls[1]!.searchParams.get('population_status')).toBe('INN');
    expect(urls[1]!.searchParams.get('sector_code')).toBe('Intersectoral');
    expect(urls[2]!.searchParams.get('ipc_phase')).toBe('3+');
    expect(run.requests[2]).toContain('ipc_phase=3%2B');
    expect(urls[2]!.searchParams.get('ipc_type')).toBe('current');
    for (const p of run.payloads) {
      expect(p.url).not.toContain(secret);
      expect(p.url).not.toContain(encodeURIComponent(secret));
      expect(p.url).toContain('app_identifier=REDACTED');
    }
    for (const r of run.records) for (const u of r.provenance.fetchUrls) expect(u).not.toContain('bXktbWFw');
  });

  it('refuses to fetch without an app identifier', async () => {
    await expect(runAdapterOnFixtures(adapter, { env: { HDX_APP_IDENTIFIER: '  ' } })).rejects.toThrow(/HDX_APP_IDENTIFIER/);
  });

  it('maps national rows of each endpoint to country-level indicator records', async () => {
    const run = await runAdapterOnFixtures(adapter);
    expect(run.rejected).toHaveLength(0);

    const need = run.records.find((r) => r.upstreamId === 'needs:SDN:2026-01-01')!;
    expect(need.layerId).toBe('hapi-humanitarian-needs');
    expect(need.title).toBe('People in need – Sudan (2026)');
    expect(need.geometryKind).toBe('country');
    expect(need.countries).toEqual(['SDN']);
    expect(need.metric).toEqual({ name: 'People in need', value: 33_700_000, unit: 'people', period: '2026' });
    expect(need.occurredAt).toBe(Date.UTC(2026, 0, 1)); // zone-less API timestamps are UTC
    expect(need.attributes.referencePeriodEnd).toBe('2026-12-31');
    expect(need.confidence).toBeNull();
    expect(need.provenance.derived).toEqual([]);
    expect(need.url).toBe('https://data.humdata.org/dataset/hdx-hapi-humanitarian-needs');

    const idp = run.records.find((r) => r.upstreamId === 'idps:SDN:SA:13:2026-08-31:Displacement tracking in Sudan')!;
    expect(idp.layerId).toBe('hapi-idps');
    expect(idp.title).toBe('Internally displaced persons – Sudan (2026-08-31)');
    expect(idp.metric!.value).toBe(9_880_000);
    expect(idp.occurredAt).toBe(Date.UTC(2026, 7, 31));
    expect(idp.attributes.assessmentType).toBe('SA');
    expect(idp.attributes.reportingRound).toBe(13);

    const food = run.records.find((r) => r.upstreamId === 'food:AFG:2026-09-01')!;
    expect(food.layerId).toBe('hapi-food-insecurity');
    expect(food.title).toBe('Acute food insecurity (IPC 3+) – Afghanistan (2026-09-01 to 2026-10-31)');
    expect(food.metric).toEqual({ name: 'People in IPC phase 3 or above', value: 15_900_000, unit: 'people', period: '2026-09-01/2026-10-31' });
    expect(food.attributes.shareOfAnalysedPopulation).toBe(0.32);
    expect(food.occurredAt).toBe(Date.UTC(2026, 8, 1));

    // UN M49 names resolve through ISO3 codes.
    expect(run.records.find((r) => r.upstreamId === 'needs:VEN:2026-01-01')!.title).toBe('People in need – Venezuela (Bolivarian Republic of) (2026)');
    expect(run.records.every((r) => r.countries.length === 1 && r.metric != null && r.metric.unit === 'people')).toBe(true);
  });

  it('keeps several reference periods per country and only displacement stock assessments', async () => {
    const run = await runAdapterOnFixtures(adapter);
    const sdnNeeds = run.records.filter((r) => r.layerId === 'hapi-humanitarian-needs' && r.countries[0] === 'SDN').map((r) => r.metric!.period);
    expect(sdnNeeds.sort()).toEqual(['2024', '2025', '2026']);
    const idps = run.records.filter((r) => r.layerId === 'hapi-idps');
    expect(new Set(idps.map((r) => r.attributes.assessmentType))).toEqual(new Set(['BA', 'SA']));
    // The fixture holds 97 IDP rows; the emergency-tracking (ETT) and flow-monitoring (FMC) rows are not stocks.
    expect(idps).toHaveLength(95);
    // Two operations in Haiti stay separate records; the choropleth shows the most recent one.
    const haiti = idps.filter((r) => r.countries[0] === 'HTI').sort((a, b) => b.tStart! - a.tStart!);
    expect(haiti).toHaveLength(5);
    expect(haiti[0]!.attributes.operation).toBe('Displacement in the metropolitan area of Port-au-Prince');
    expect(new Set(run.records.filter((r) => r.layerId === 'hapi-food-insecurity').map((r) => r.countries[0])).size).toBeGreaterThanOrEqual(24);
  });

  it('paginates with limit/offset until a short page', async () => {
    const requested: string[] = [];
    const row = (i: number) => ({ location_code: 'KEN', location_name: 'Kenya', admin_level: 0, sector_code: 'Intersectoral', category: '', population_status: 'INN', population: 1000 + i, reference_period_start: `${2000 + (i % 20)}-01-01T00:00:00`, reference_period_end: null });
    const http = {
      async get(url: string, opts: HttpGetOptions = {}): Promise<FetchedPayload> {
        requested.push(url);
        const u = new URL(url);
        const offset = Number(u.searchParams.get('offset'));
        const total = u.pathname.endsWith('/humanitarian-needs') ? 2 * PAGE_SIZE + 7 : 0;
        const data = Array.from({ length: Math.max(0, Math.min(PAGE_SIZE, total - offset)) }, (_, i) => row(offset + i));
        return fakePayload(opts.key ?? url, url, { data });
      },
    };
    const payloads = await adapter.fetch({ http, env: { HDX_APP_IDENTIFIER: 'abc123==' }, now: FIXTURE_EPOCH, cursor: { get: () => null, set: () => {} }, signal: new AbortController().signal });
    expect(payloads.map((p) => p.key)).toEqual(['idps:0', 'humanitarian-needs:0', `humanitarian-needs:${PAGE_SIZE}`, `humanitarian-needs:${2 * PAGE_SIZE}`, 'food-security:0']);
    expect(requested[3]).toBe(endpointUrl(ENDPOINTS[1]!, 2 * PAGE_SIZE, FIXTURE_EPOCH, 'abc123=='));
    expect(requested[3]).toContain(`limit=${PAGE_SIZE}&offset=${2 * PAGE_SIZE}&app_identifier=abc123%3D%3D`);
    // Rows repeated across pages collapse to one record per country and reference period.
    const out = adapter.parse(payloads, { now: FIXTURE_EPOCH, env: {} });
    expect(out.records).toHaveLength(20);
    expect(out.rejected).toHaveLength(0);
  });

  it('rejects malformed rows individually and silently skips rows that are not national totals', async () => {
    const run = await runAdapterOnFixtures(adapter, { scenario: [{ source: adapter.manifest.id, fromRun: 1, effect: { variant: 'malformed' } }] });
    expect(run.records.map((r) => r.upstreamId).sort()).toEqual([
      'food:YEM:2026-09-01',
      'food:ZMB:2026-09-01',
      'idps:ETH:SA:20:2026-06-30:<img src=x onerror=alert(1)>Baseline assessment <b>Ethiopia</b>',
      'idps:UKR:BA:20:2026-07-31:Displacement tracking in Ukraine',
      'needs:SDN:2026-01-01',
      'needs:SOM:2025-07-01',
    ]);
    expect(run.rejected.map((r) => r.reason)).toEqual([
      'non-numeric population',
      'negative population',
      'unparseable reference_period_start "31/12/2026"',
      'missing location_code',
      'row is not an object',
      'non-numeric population',
      'unparseable reference_period_start "FY2026"',
      'non-numeric population',
      'unparseable reference_period_start "null"',
    ]);
    const ukr = run.records.find((r) => r.upstreamId.startsWith('idps:UKR'))!;
    expect(ukr.metric!.value).toBe(3_669_000); // the admin-1 row and the later duplicate are ignored

    const hostile = run.records.find((r) => r.upstreamId.startsWith('idps:ETH'))!;
    expect(hostile.id).toMatch(/^hdx-hapi:[A-Za-z0-9._~-]+$/);
    expect(hostile.title).toBe('Internally displaced persons – Ethiopia (2026-06-30)');
    expect(hostile.metric!.value).toBe(1_200_000); // numeric string
    expect(hostile.attributes.operation).toBe('Baseline assessment Ethiopia');
    expect(hostile.description).not.toMatch(/<|onerror/);

    // Only the INN / Intersectoral / undisaggregated row of Sudan survives; a non-calendar plan period keeps its range.
    expect(run.records.find((r) => r.upstreamId === 'needs:SDN:2026-01-01')!.metric!.value).toBe(33_700_000);
    expect(run.records.find((r) => r.upstreamId === 'needs:SOM:2025-07-01')!.metric!.period).toBe('2025-07-01/2026-06-30');
    // Only the phase 3+ "current" row of Yemen survives; a genuine zero is kept.
    expect(run.records.find((r) => r.upstreamId === 'food:YEM:2026-09-01')!.metric!.value).toBe(17_100_000);
    expect(run.records.find((r) => r.upstreamId === 'food:ZMB:2026-09-01')!.metric!.value).toBe(0);
  });
});
