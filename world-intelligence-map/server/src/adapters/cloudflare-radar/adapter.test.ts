import { describe, expect, it } from 'vitest';
import { FIXTURE_EPOCH } from '../../core/fixtureEpoch.ts';
import type { FetchedPayload, HttpGetOptions } from '../../core/types.ts';
import { adapterContractSuite, runAdapterOnFixtures } from '../testing.ts';
import adapter, { PAGE_LIMIT } from './adapter.ts';

adapterContractSuite(adapter, { minRecords: 25 });

const MALFORMED = [{ source: adapter.manifest.id, fromRun: 1, effect: { variant: 'malformed' } }];
const byId = (records: Awaited<ReturnType<typeof runAdapterOnFixtures>>['records'], id: string) => records.find((r) => r.upstreamId === id)!;

describe('cloudflare-radar specifics', () => {
  it('sends the token only as a Bearer Authorization header on the documented endpoint', async () => {
    const calls: { url: string; opts?: HttpGetOptions }[] = [];
    const secret = 'cf-secret-token-123';
    await adapter.fetch({
      http: {
        get: async (url, opts) => {
          calls.push({ url, opts });
          return { key: opts?.key ?? url, url } as FetchedPayload;
        },
      },
      env: { CLOUDFLARE_API_TOKEN: ` ${secret}\n` },
      now: FIXTURE_EPOCH,
      cursor: { get: () => null, set: () => {} },
      signal: new AbortController().signal,
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(`https://api.cloudflare.com/client/v4/radar/annotations/outages?dateRange=7d&format=json&limit=${PAGE_LIMIT}`);
    expect(calls[0]!.url).not.toContain(secret);
    expect(calls[0]!.opts?.headers).toEqual({ Authorization: `Bearer ${secret}` });
    expect(calls[0]!.opts?.redact).toEqual([secret]);
    expect(calls[0]!.opts?.method ?? 'GET').toBe('GET');

    // Through the real client: nothing derived from the credential ends up in payload URLs or records.
    const run = await runAdapterOnFixtures(adapter);
    expect(run.requests).toEqual([calls[0]!.url]);
    expect(JSON.stringify(run.records)).not.toContain('fixture-cloudflare_api_token');
    expect(adapter.manifest.auth.envVars).toEqual([expect.objectContaining({ name: 'CLOUDFLARE_API_TOKEN', required: true })]);
    expect(adapter.manifest.license.nonCommercialOnly).toBe(true);
  });

  it('maps a closed annotation to an interval record with exact values (UTC)', async () => {
    const run = await runAdapterOnFixtures(adapter);
    expect(run.rejected).toHaveLength(0);
    expect(run.records).toHaveLength(27); // 26 annotations, one of them covering two countries
    const r = byId(run.records, '9007');
    expect(r.id).toBe('cloudflare-radar:9007');
    expect(r.layerId).toBe('cloudflare-outages');
    expect(r.geometryKind).toBe('country');
    expect(r.geometry).toBeNull();
    expect(r.countries).toEqual(['UKR']);
    expect(r.point).not.toBeNull();
    expect(r.title).toBe('Internet outage (Cloudflare Radar) – Ukraine: regional, likely cause: power outage');
    expect(r.description).toBe('Scope: Kharkiv, Sumy. [Illustrative fixture entry – not a real event] Power infrastructure damaged.');
    expect(r.subcategory).toBe('regional');
    expect(r.occurredAt).toBe(Date.UTC(2026, 10, 6, 4, 30, 0));
    expect(r.tStart).toBe(Date.UTC(2026, 10, 6, 4, 30, 0));
    expect(r.tEnd).toBe(Date.UTC(2026, 10, 6, 19, 0, 0));
    expect(r.ongoing).toBe(false);
    expect(r.severity).toBe(2);
    expect(r.severityLabel).toBe('REGIONAL · POWER_OUTAGE');
    expect(r.confidence).toBe(0.85);
    expect(r.confidenceBasis).toContain('Curated annotation in the Cloudflare Radar Outage Center with a linked public reference');
    expect(r.attributes).toEqual({
      annotationId: '9007',
      eventType: 'OUTAGE',
      outageType: 'REGIONAL',
      outageCause: 'POWER_OUTAGE',
      scope: 'Kharkiv, Sumy',
      locations: 'UA',
      linkedUrl: 'https://example.org/fixture/outage-9007',
      dataSource: 'ALL',
      startDate: '2026-11-06T04:30:00Z',
      endDate: '2026-11-06T19:00:00Z',
    });
    expect(r.url).toBe('https://radar.cloudflare.com/outage-center');
    expect(r.provenance.derived).toEqual(['confidence', 'severity']);
  });

  it('keeps annotations without an end date ongoing and derives severity from type and duration', async () => {
    const run = await runAdapterOnFixtures(adapter);
    const sev = (id: string) => byId(run.records, id).severity;
    // NATIONWIDE → 3, REGIONAL / PLATFORM → 2, NETWORK → 1; one level higher from 24 h duration.
    expect(sev('9014')).toBe(3); // nationwide, 2 h
    expect(sev('9006')).toBe(4); // nationwide, 35.5 h
    expect(sev('9003')).toBe(4); // nationwide, 42 h
    expect(sev('9021')).toBe(2); // regional, 9 h
    expect(sev('9020')).toBe(1); // single network
    expect(sev('9023')).toBe(2); // platform

    const open = run.records.filter((r) => r.ongoing).map((r) => r.upstreamId).sort();
    expect(open).toEqual(['9004', '9013', '9019', '9022', '9025', '9026']);
    const afg = byId(run.records, '9025');
    expect(afg.countries).toEqual(['AFG']);
    expect(afg.tStart).toBe(Date.UTC(2026, 10, 10, 13, 30));
    expect(afg.tEnd).toBe(FIXTURE_EPOCH); // extends to the fetch that still listed it
    expect(afg.severity).toBe(3); // nationwide, open for 10.5 h at the fixture epoch
    expect(byId(run.records, '9013').severity).toBe(3); // regional, open for more than 24 h
    // The same open annotation is rated one level lower before it has lasted 24 hours.
    const early = await runAdapterOnFixtures(adapter, { now: Date.UTC(2026, 10, 7, 20, 0) });
    expect(byId(early.records, '9013').severity).toBe(2);

    // No linked reference → lower confidence, and the basis says so.
    const zaf = byId(run.records, '9022');
    expect(zaf.confidence).toBe(0.75);
    expect(zaf.confidenceBasis).toContain('without a linked reference');
    expect(zaf.attributes.linkedUrl).toBeUndefined();
    expect(zaf.attributes.asns).toBe('AS64503, AS64504');
    expect(zaf.attributes.asnNames).toBe('AS64503 EXAMPLE-NET-8, AS64504 EXAMPLE-NET-9');
    expect(zaf.title).toBe('Internet outage (Cloudflare Radar) – South Africa: network, likely cause: cable cut');
    // Unknown cause is not presented as a cause.
    expect(byId(run.records, '9024').title).toBe('Internet outage (Cloudflare Radar) – Nigeria: regional');
    expect(byId(run.records, '9024').description).toBeNull();
  });

  it('splits multi-country annotations, derives a country from the network when none is given and keeps platform outages global', async () => {
    const run = await runAdapterOnFixtures(adapter);
    const cable = run.records.filter((r) => r.attributes.annotationId === '9015');
    expect(cable.map((r) => [r.upstreamId, r.countries])).toEqual([
      ['9015.TZA', ['TZA']],
      ['9015.KEN', ['KEN']],
    ]);
    expect(cable[0]!.attributes.locations).toBe('TZ, KE');

    const leak = byId(run.records, '9017');
    expect(leak.countries).toEqual(['KAZ']);
    expect(leak.provenance.derived).toEqual(['confidence', 'country', 'severity']);

    const platform = byId(run.records, '9023');
    expect(platform.geometryKind).toBe('global');
    expect(platform.countries).toEqual([]);
    expect(platform.point).toBeNull();
    expect(platform.title).toBe('Internet outage (Cloudflare Radar) – amazon-us-east-1: platform, likely cause: technical problem');
    expect(platform.attributes.origins).toBe('amazon-us-east-1');
    expect(platform.occurredAt).toBe(Date.UTC(2026, 10, 10, 7, 15)); // millisecond-precision timestamps parse too

    // Location-less annotations stay on the layer but are marked 'global' explicitly by the adapter (never inferred):
    // every draft is either a country-level record or an explicit global bulletin, and none carries a geometry.
    const globalDrafts = run.output.records.filter((d) => d.country == null);
    expect(globalDrafts.map((d) => d.upstreamId)).toEqual(['9023']);
    for (const d of run.output.records) {
      expect(d.geometry ?? null).toBeNull();
      if (d.country == null) expect(d.geometryKind).toBe('global');
      else expect(d.geometryKind).toBeUndefined();
    }
    expect(run.records.filter((r) => r.geometryKind === 'global').map((r) => r.upstreamId)).toEqual(['9023']);
    expect(run.records.filter((r) => r.geometryKind !== 'global').every((r) => r.geometryKind === 'country' && r.countries.length === 1 && r.point != null)).toBe(true);
  });

  it('rejects broken annotations individually and sanitises hostile content', async () => {
    const run = await runAdapterOnFixtures(adapter, { scenario: MALFORMED });
    expect(run.records.map((r) => r.upstreamId)).toEqual(['m-ok-1', 'm-ok-2']);
    expect(run.rejected.map((r) => r.reason).sort()).toEqual([
      'annotation is not an object',
      'annotation is not an object',
      'duplicate annotation id',
      'endDate is earlier than startDate',
      'locations is not an array',
      'missing or unparseable startDate',
      'missing or unparseable startDate',
      'startDate is in the future',
      'unparseable endDate',
      'unrecognised location "ZZ"',
    ]);

    const hostile = byId(run.records, 'm-ok-2');
    expect(hostile.countries).toEqual(['KOS']); // provider code "xk"
    expect(hostile.occurredAt).toBe(Date.UTC(2026, 10, 10, 18, 0)); // 20:00+02:00
    expect(hostile.ongoing).toBe(true);
    expect(hostile.title).toBe('Internet outage (Cloudflare Radar) – Kosovo');
    expect(hostile.description).toBe('Scope: Pristina. Hostile markup & entities');
    // Enum-like fields that do not look like upstream codes are dropped, not copied or mapped.
    expect(hostile.severity).toBeNull();
    expect(hostile.severityLabel).toBeNull();
    expect(hostile.subcategory).toBeNull();
    expect(hostile.attributes.outageType).toBeUndefined();
    expect(hostile.attributes.dataSource).toBeUndefined();
    expect(hostile.attributes.linkedUrl).toBeUndefined(); // javascript: link dropped
    expect(hostile.confidence).toBe(0.75);
    expect(hostile.attributes.asns).toBe('AS64496');
    expect(hostile.attributes.asnNames).toBe('AS64496 EXAMPLE-NET-1');
    expect(hostile.attributes.scope).toBe('Pristina');
    expect(JSON.stringify(hostile)).not.toMatch(/<[a-z]|javascript:|alert\(/i);
  });

  it('treats an API error envelope as a failed payload', async () => {
    const run = await runAdapterOnFixtures(adapter);
    const text = JSON.stringify({ success: false, errors: [{ code: 10000, message: 'Authentication error' }], messages: [], result: null });
    const payloads = [{ ...run.payloads[0]!, body: Buffer.from(text), text: () => text, json: <T>() => JSON.parse(text) as T }];
    expect(() => adapter.parse(payloads, { now: FIXTURE_EPOCH, env: {} })).toThrow(/malformed Cloudflare Radar outage annotations/);
    // A rejected token (HTTP 403) fails the fetch instead of yielding an empty result.
    await expect(runAdapterOnFixtures(adapter, { scenario: [{ source: adapter.manifest.id, fromRun: 1, effect: { status: 403 } }] })).rejects.toThrow(/credentials/);
  });
});
