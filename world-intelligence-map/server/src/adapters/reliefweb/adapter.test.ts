import { describe, expect, it } from 'vitest';
import { FIXTURE_EPOCH } from '../../core/fixtureEpoch.ts';
import type { FetchedPayload, HttpGetOptions } from '../../core/types.ts';
import { adapterContractSuite, runAdapterOnFixtures } from '../testing.ts';
import adapter, { DISASTER_PAGE, disastersBody, HAZARD_CLASS, REPORT_LIMIT, reportsBody, SUMMARY_MAX } from './adapter.ts';

adapterContractSuite(adapter, { minRecords: 100 });

function fakePayload(key: string, url: string, body: unknown): FetchedPayload {
  const text = JSON.stringify(body);
  return { key, url, status: 200, body: Buffer.from(text), contentType: 'application/json', fetchedAt: FIXTURE_EPOCH, etag: null, lastModified: null, notModified: false, fromCache: false, stale: false, text: () => text, json: <T>() => JSON.parse(text) as T };
}

/** Runs fetch() against a stub that records every request and serves `totalDisasters` items page by page. */
async function fetchWithStub(totalDisasters: number, appname = 'acme-map-x7Qp') {
  const calls: { url: string; opts: HttpGetOptions; body: Record<string, any> }[] = [];
  const http = {
    async get(url: string, opts: HttpGetOptions = {}): Promise<FetchedPayload> {
      const body = JSON.parse(opts.body ?? '{}') as Record<string, any>;
      calls.push({ url, opts, body });
      if (!url.includes('/v2/disasters')) return fakePayload(opts.key ?? url, url, { totalCount: 0, count: 0, data: [] });
      const count = Math.max(0, Math.min(body.limit, totalDisasters - body.offset));
      const data = Array.from({ length: count }, (_, i) => ({
        id: 500000 + body.offset + i,
        fields: { name: `Kenya: Floods ${body.offset + i}`, status: 'current', primary_country: { iso3: 'ken', name: 'Kenya' }, date: { event: '2026-10-01T00:00:00+00:00' } },
      }));
      return fakePayload(opts.key ?? url, url, { totalCount: totalDisasters, count, data });
    },
  };
  const payloads = await adapter.fetch({ http, env: { RELIEFWEB_APPNAME: appname }, now: FIXTURE_EPOCH, cursor: { get: () => null, set: () => {} }, signal: new AbortController().signal });
  return { calls, payloads };
}

describe('reliefweb specifics', () => {
  it('POSTs JSON searches with the appname only in the URL query, as documented', async () => {
    const { calls } = await fetchWithStub(3);
    expect(calls.map((c) => c.url)).toEqual(['https://api.reliefweb.int/v2/disasters?appname=acme-map-x7Qp', 'https://api.reliefweb.int/v2/reports?appname=acme-map-x7Qp']);
    for (const c of calls) {
      expect(c.opts.method).toBe('POST');
      expect(c.opts.headers).toMatchObject({ 'content-type': 'application/json' });
      expect(c.opts.redact).toEqual(['acme-map-x7Qp']);
      expect(c.opts.body).not.toContain('acme-map-x7Qp'); // never in the JSON body
      expect(c.body.appname).toBeUndefined();
    }
    const d = calls[0]!.body;
    expect(d).toEqual(disastersBody(FIXTURE_EPOCH, 0));
    expect(d.preset).toBe('latest');
    expect(d.limit).toBe(DISASTER_PAGE);
    expect(d.filter).toEqual({
      operator: 'OR',
      conditions: [
        { field: 'status', value: ['alert', 'current'], operator: 'OR' },
        { field: 'date.event', value: { from: '2026-05-15T00:00:00+00:00' } }, // 180 days before the fixture epoch, ISO 8601 with offset
      ],
    });
    expect(d.fields.include).toEqual(expect.arrayContaining(['name', 'glide', 'status', 'type.name', 'primary_country.iso3', 'country.iso3', 'date.event', 'url']));
    expect(d.fields.include).not.toContain('description'); // no long-form text is requested

    const r = calls[1]!.body;
    expect(r).toEqual(reportsBody());
    expect(r.preset).toBe('latest');
    expect(r.filter).toEqual({ field: 'headline' });
    expect(r.limit).toBe(REPORT_LIMIT);
    expect(r.fields.include).toEqual(expect.arrayContaining(['title', 'date.created', 'primary_country.iso3', 'source.shortname', 'url_alias', 'headline.summary']));
    expect(r.fields.include.some((f: string) => /^body|^file/.test(f))).toBe(false); // never the report body or attachments
  });

  it('pages through disasters until offset + count >= totalCount', async () => {
    const { calls, payloads } = await fetchWithStub(2 * DISASTER_PAGE + 20);
    expect(payloads.map((p) => p.key)).toEqual(['disasters:0', `disasters:${DISASTER_PAGE}`, `disasters:${2 * DISASTER_PAGE}`, 'reports:0']);
    expect(calls.slice(0, 3).map((c) => c.body.offset)).toEqual([0, DISASTER_PAGE, 2 * DISASTER_PAGE]);
    const out = adapter.parse(payloads, { now: FIXTURE_EPOCH, env: {} });
    expect(out.records).toHaveLength(2 * DISASTER_PAGE + 20);
    expect(new Set(out.records.map((r) => r.upstreamId)).size).toBe(out.records.length);
  });

  it('redacts the appname from payload URLs and refuses to run without one', async () => {
    const run = await runAdapterOnFixtures(adapter, { env: { RELIEFWEB_APPNAME: 'acme-map-x7Qp' } });
    expect(run.requests).toEqual(['https://api.reliefweb.int/v2/disasters?appname=acme-map-x7Qp', 'https://api.reliefweb.int/v2/reports?appname=acme-map-x7Qp']);
    expect(run.payloads.map((p) => p.url)).toEqual(['https://api.reliefweb.int/v2/disasters?appname=REDACTED', 'https://api.reliefweb.int/v2/reports?appname=REDACTED']);
    await expect(runAdapterOnFixtures(adapter, { env: { RELIEFWEB_APPNAME: '' } })).rejects.toThrow(/RELIEFWEB_APPNAME/);
  });

  it('maps disasters to country-level intervals that stay ongoing while ReliefWeb lists them as alert or current', async () => {
    const run = await runAdapterOnFixtures(adapter);
    expect(run.rejected).toHaveLength(0);
    const d = run.records.find((r) => r.upstreamId === 'disaster-99006')!;
    expect(d.layerId).toBe('reliefweb-disasters');
    expect(d.title).toBe('West and Central Africa: Floods - Aug 2026');
    expect(d.geometryKind).toBe('country');
    expect(d.geometry).toBeNull();
    expect(d.countries).toEqual(['NGA', 'NER', 'TCD']); // primary country first
    expect(d.occurredAt).toBe(Date.UTC(2026, 7, 20)); // date.event
    expect(d.publishedAt).toBe(Date.parse('2026-08-24T12:35:00Z')); // date.created
    expect(d.updatedAt).toBe(Date.UTC(2026, 10, 3, 15, 20)); // date.changed
    expect(d.ongoing).toBe(true);
    expect(d.tEnd).toBe(d.fetchedAt);
    expect(d.severity).toBeNull();
    expect(d.severityLabel).toBe('ReliefWeb status: current');
    expect(d.confidence).toBeNull();
    expect(d.category).toBe('flood');
    expect(d.subcategory).toBe('Flood');
    expect(d.attributes.glide).toBe('FL-2026-009006-NGA');
    expect(d.provenance.derived).toEqual([]); // countries and type are upstream's own
    expect(d.url).toBe('https://reliefweb.int/disaster/fl-2026-009006-nga');

    const past = run.records.find((r) => r.upstreamId === 'disaster-99023')!;
    expect(past.attributes.status).toBe('past');
    expect(past.ongoing).toBe(false);
    expect(past.tEnd).toBe(past.updatedAt); // no end date upstream: the interval closes at the last modification

    const disasters = run.records.filter((r) => r.layerId === 'reliefweb-disasters');
    expect(disasters).toHaveLength(35);
    expect(disasters.filter((r) => r.ongoing).length).toBe(20);
    for (const r of disasters) {
      const cls = HAZARD_CLASS[String(r.attributes.primaryType).toLowerCase()];
      expect(r.category).toBe(cls ?? 'disaster');
      expect(r.ongoing).toBe(r.attributes.status !== 'past');
    }
    expect(new Set(disasters.map((r) => r.category))).toEqual(new Set(['flood', 'tropical_cyclone', 'earthquake', 'drought', 'wildfire', 'volcano', 'disaster']));
  });

  it('keeps only title, a short summary and a link for headline reports', async () => {
    const run = await runAdapterOnFixtures(adapter);
    const r = run.records.find((x) => x.upstreamId === 'report-9900001')!;
    expect(r.layerId).toBe('reliefweb-reports');
    expect(r.title).toBe('Sudan: humanitarian situation update published by UNHCR');
    expect(r.attributes.reportTitle).toBe('Sudan: Humanitarian Situation Update No. 3 (Nov 2026)');
    expect(r.countries).toEqual(['SDN']);
    expect(r.geometryKind).toBe('country');
    expect(r.occurredAt).toBe(Date.UTC(2026, 10, 10, 16, 20));
    expect(r.attributes.sources).toBe('UNHCR');
    expect(r.attributes.originallyPublished).toBe('2026-11-09');
    expect(r.url).toBe('https://reliefweb.int/report/sudan/sudan-humanitarian-situation-update-no-3-nov-2026');
    expect(r.confidence).toBeNull();

    const reports = run.records.filter((x) => x.layerId === 'reliefweb-reports');
    expect(reports).toHaveLength(72);
    for (const x of reports) {
      expect(x.description!.length).toBeLessThanOrEqual(SUMMARY_MAX);
      expect(Object.keys(x.attributes).sort().join()).toMatch(/^(originallyPublished,)?(primaryCountryName,)?(reportTitle,)?sources$/);
      expect(x.url).toMatch(/^https:\/\/reliefweb\.int\//);
    }
    // Reports whose primary country is "World" become non-geographic bulletins.
    const world = reports.filter((x) => x.geometryKind === 'global');
    expect(world).toHaveLength(2);
    expect(world[0]!.countries).toEqual([]);
    expect(world[0]!.title).toMatch(/^Global /);
  });

  it('rejects malformed items individually and sanitises hostile markup and links', async () => {
    const run = await runAdapterOnFixtures(adapter, { scenario: [{ source: adapter.manifest.id, fromRun: 1, effect: { variant: 'malformed' } }] });
    expect(run.records.map((r) => r.upstreamId).sort()).toEqual(['disaster-99901', 'disaster-99902', 'disaster-99910', 'report-9990001', 'report-9990004', 'report-9990006']);
    expect(run.rejected.map((r) => r.reason)).toEqual([
      'missing id or fields',
      'unexpected status "archive"',
      'missing or unparseable event and creation dates',
      'no recognisable country',
      'missing name',
      'item is not an object',
      'missing title',
      'unparseable date.created "yesterday"',
      'missing id or fields',
    ]);

    expect(run.records.find((r) => r.upstreamId === 'disaster-99901')!.title).toBe('Kenya: Floods - Nov 2026'); // duplicate id ignored

    const hostile = run.records.find((r) => r.upstreamId === 'disaster-99902')!;
    expect(hostile.title).toBe('Peru: Wild Fires - Oct 2026');
    expect(hostile.countries).toEqual(['PER', 'BOL']); // the unknown country code is dropped
    expect(hostile.category).toBe('wildfire');
    expect(hostile.attributes.types).toBe('Wild Fire, Drought');
    expect(hostile.url).toBeNull(); // javascript: and non-reliefweb links are not kept
    expect(hostile.publishedAt).toBe(Date.UTC(2026, 9, 20, 6, 0)); // 08:00+02:00

    const noEvent = run.records.find((r) => r.upstreamId === 'disaster-99910')!;
    expect(noEvent.occurredAt).toBe(Date.UTC(2026, 8, 14, 6, 0)); // falls back to date.created …
    expect(noEvent.provenance.derived).toEqual(['occurredAt']); // … and says so
    expect(noEvent.ongoing).toBe(false);
    expect(noEvent.url).toBe('https://reliefweb.int/disaster/eq-2026-009910-npl');

    const report = run.records.find((r) => r.upstreamId === 'report-9990001')!;
    expect(report.title).toBe('Kenya: situation update published by OCHA');
    expect(report.description!.length).toBeLessThanOrEqual(SUMMARY_MAX);
    expect(report.description).toMatch(/^Fictional example summary with markup\. Partners continue/);
    expect(report.description!.endsWith('…')).toBe(true);
    expect(report.url).toBe('https://reliefweb.int/node/9990001'); // javascript: alias ignored

    const world = run.records.find((r) => r.upstreamId === 'report-9990004')!;
    expect(world.geometryKind).toBe('global');
    expect(world.attributes.sources).toBe('Example Organization'); // single source object instead of an array

    const plain = run.records.find((r) => r.upstreamId === 'report-9990006')!;
    expect(plain.title).toBe('South Sudan: Flash Update No. 2 (Nov 2026)'); // no headline block: report title is used
    expect(plain.description).toBeNull();
    expect(plain.occurredAt).toBe(Date.UTC(2026, 10, 8, 4, 30)); // 23:30-05:00
    expect(plain.countries).toEqual(['SSD']);
  });
});
