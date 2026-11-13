import { strToU8, zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { adapterContractSuite, runAdapterOnFixtures } from '../testing.ts';
import adapter, { CAMEO_ROOT, CURSOR_KEY, findExportUrl, gdeltConfidence, MIN_COOPERATION_MENTIONS } from './adapter.ts';

adapterContractSuite(adapter, { minRecords: 300 });

const malformed = { scenario: [{ source: adapter.manifest.id, fromRun: 1, effect: { variant: 'malformed' } }] };

describe('gdelt-events specifics', () => {
  it('finds the export file in lastupdate.txt and upgrades the advertised http URL to https', () => {
    const txt = '99115 c4733b2a955ad85d14582e9895c6f27e http://data.gdeltproject.org/gdeltv2/20261110174500.export.CSV.zip\n149313 153d http://data.gdeltproject.org/gdeltv2/20261110174500.mentions.CSV.zip\n';
    expect(findExportUrl(txt)).toEqual({ url: 'https://data.gdeltproject.org/gdeltv2/20261110174500.export.CSV.zip', file: '20261110174500.export.CSV.zip' });
    expect(findExportUrl('1 abc http://evil.example.com/gdeltv2/20261110174500.export.CSV.zip')).toBeNull();
    expect(findExportUrl('1 abc http://data.gdeltproject.org/gdeltv2/20261110174500.export.CSV.zip.exe')).toBeNull();
    expect(findExportUrl('')).toBeNull();
  });

  it('unzips the captured export and maps a known protest row exactly', async () => {
    const run = await runAdapterOnFixtures(adapter);
    expect(run.rejected).toHaveLength(0);
    expect(run.requests).toEqual([
      'https://data.gdeltproject.org/gdeltv2/lastupdate.txt',
      'https://data.gdeltproject.org/gdeltv2/20261110174500.export.CSV.zip',
    ]);
    expect(run.output.upstreamTime).toBe(Date.UTC(2026, 10, 10, 17, 45, 0));

    const r = run.records.find((x) => x.upstreamId === '1332087863')!;
    expect(r).toBeTruthy();
    expect(r.layerId).toBe('gdelt-protests');
    expect(r.title).toBe('Media-reported: Demonstration or rally – Isfahan, Esfahan, Iran');
    expect(r.point).toEqual([51.6714, 32.6597]);
    // DATEADDED 20261108160000 is UTC; SQLDATE is only a day and stays an attribute.
    expect(r.occurredAt).toBe(Date.UTC(2026, 10, 8, 16, 0, 0));
    expect(r.attributes.eventDate).toBe('2026-11-08');
    expect(r.attributes.cameoEventCode).toBe('141');
    expect(r.attributes.goldsteinScale).toBe(-6.5);
    expect(r.attributes.numMentions).toBe(2);
    expect(r.attributes.numSources).toBe(1);
    expect(r.attributes.numArticles).toBe(2);
    expect(r.attributes.avgTone).toBe(-9.92);
    expect(r.attributes.actor2CountryCode).toBe('IRN');
    expect(r.attributes.actionGeoCountryFips).toBe('IR');
    expect(r.severity).toBeNull();
    expect(r.confidence).toBe(0.2);
    expect(r.confidenceBasis).toMatch(/machine coding of news reports; location is machine-geocoded/);
    // The country is resolved from the point by the normaliser (FIPS codes are not ISO codes).
    expect(r.countries).toEqual(['IRN']);
    expect(r.provenance.derived).toEqual(['confidence', 'country']);
    expect(r.url).toBe('https://www.rferl.org/#gdelt-fixture-fae6c38819');
  });

  it('assigns layers by CAMEO class, keeps only city-level geocodes and never copies actor names', async () => {
    const run = await runAdapterOnFixtures(adapter);
    const count = (layer: string) => run.records.filter((r) => r.layerId === layer).length;
    expect(count('gdelt-conflict')).toBeGreaterThan(150);
    expect(count('gdelt-cooperation')).toBeGreaterThan(100);
    expect(count('gdelt-protests')).toBeGreaterThanOrEqual(20);
    for (const r of run.records) {
      const root = r.attributes.cameoRootCode as string;
      if (r.layerId === 'gdelt-protests') expect(root).toBe('14');
      if (r.layerId === 'gdelt-conflict') {
        expect(r.attributes.quadClass).toBe('Material conflict');
        expect(root).not.toBe('14');
      }
      if (r.layerId === 'gdelt-cooperation') {
        expect(['03', '04', '05', '06', '07', '08']).toContain(root);
        expect(r.attributes.numMentions as number).toBeGreaterThanOrEqual(MIN_COOPERATION_MENTIONS);
      }
      expect(r.subcategory).toBe(CAMEO_ROOT[root]);
      expect(r.title.startsWith('Media-reported: ')).toBe(true);
      expect(r.confidence).toBeGreaterThanOrEqual(0.2);
      expect(r.confidence).toBeLessThanOrEqual(0.5);
      expect(r.provenance.derived).toContain('confidence');
      expect(String(r.attributes.actionGeoPrecision)).toMatch(/city or landmark/);
      expect(Object.keys(r.attributes).some((k) => /name/i.test(k) && k !== 'actionGeoName')).toBe(false);
      expect(r.occurredAt! % (15 * 60_000)).toBe(0);
    }
    // The fixture holds 460 rows; country-level geocodes, verbal events, low-mention cooperation,
    // retrospective SQLDATEs and same-article duplicate codings do not become records.
    expect(run.records.length).toBe(377);
    expect(run.records.filter((r) => (r.attributes.codingsCollapsed as number) > 1).length).toBeGreaterThan(5);
    expect(new Set(run.records.map((r) => r.occurredAt)).size).toBe(7);
  });

  it('derives a deliberately low confidence from the number of sources', () => {
    expect(gdeltConfidence(null)).toBe(0.2);
    expect(gdeltConfidence(1)).toBe(0.2);
    expect(gdeltConfidence(2)).toBe(0.25);
    expect(gdeltConfidence(4)).toBe(0.35);
    expect(gdeltConfidence(7)).toBe(0.5);
    expect(gdeltConfidence(250)).toBe(0.5);
  });

  it('skips the download when the cursor says the newest export was already processed', async () => {
    const cursor = new Map<string, string>();
    const first = await runAdapterOnFixtures(adapter, { cursor });
    expect(first.records.length).toBeGreaterThan(300);
    expect(cursor.get(CURSOR_KEY)).toBe('20261110174500.export.CSV.zip');

    const second = await runAdapterOnFixtures(adapter, { cursor });
    expect(second.requests).toEqual(['https://data.gdeltproject.org/gdeltv2/lastupdate.txt']);
    expect(second.payloads.map((p) => p.key)).toEqual(['lastupdate']);
    expect(second.records).toHaveLength(0);
    expect(second.rejected).toHaveLength(0);
    expect(second.output.upstreamTime).toBe(Date.UTC(2026, 10, 10, 17, 45, 0));
  });

  it('rejects broken rows individually, skips non-records silently and sanitises hostile text', async () => {
    const run = await runAdapterOnFixtures(adapter, malformed);
    expect(run.records.map((r) => r.upstreamId).sort()).toEqual(['900000001', '900000003', '900000004']);
    const reasons = run.rejected.map((r) => r.reason);
    expect(reasons).toEqual([
      'unexpected column count 40 (expected 61)',
      'missing or invalid ActionGeo coordinates',
      'missing or invalid ActionGeo coordinates',
      'missing or non-numeric GLOBALEVENTID',
      'unparseable DATEADDED "not-a-date"',
      'unparseable SQLDATE "2026ABCD"',
      'time: event occurredAt is in the future (2027-03-01T12:00:00.000Z)',
    ]);

    const conflict = run.records.find((r) => r.upstreamId === '900000001')!;
    expect(conflict.layerId).toBe('gdelt-conflict');
    expect(conflict.title).toBe('Media-reported: Armed clash / use of military force – Nairobi, Nairobi Area, Kenya');
    expect(conflict.confidence).toBe(0.3); // three sources
    expect(conflict.attributes.codingsCollapsed).toBe(2); // 900000002: same article, root code and place
    expect(conflict.attributes.actor1CountryCode).toBe('KEN');
    expect(conflict.attributes.actor2TypeCode).toBe('REB');
    expect(conflict.countries).toEqual(['KEN']);

    const hostile = run.records.find((r) => r.upstreamId === '900000003')!;
    expect(hostile.layerId).toBe('gdelt-protests');
    expect(hostile.title).toBe('Media-reported: Demonstration or rally – Paris, Ile-de-France, France');
    expect(hostile.description).not.toMatch(/script|onmouseover/);
    expect(hostile.url).toBeNull();
    expect(hostile.provenance.normalisation).toContain('dropped non-http(s) source link');

    const coop = run.records.find((r) => r.upstreamId === '900000004')!;
    expect(coop.layerId).toBe('gdelt-cooperation');
    expect(coop.title).toBe('Media-reported: Visit made – Brasilia, Distrito Federal, Brazil');
    expect(coop.confidence).toBe(0.5); // capped
  });

  it('fails the run for an archive without event rows instead of silently returning nothing', async () => {
    const run = await runAdapterOnFixtures(adapter);
    const withBody = (body: Uint8Array) => run.payloads.map((p) => (p.key === 'export' ? { ...p, body: Buffer.from(body) } : p));
    expect(() => adapter.parse(withBody(zipSync({ 'readme.txt': strToU8('nothing here') })), { now: 0, env: {} })).toThrow(/malformed GDELT export: archive contains no CSV member/);
    expect(() => adapter.parse(withBody(zipSync({ 'x.export.CSV': strToU8('<html>error page</html>\n') })), { now: 0, env: {} })).toThrow(/malformed GDELT export: no 61-column event rows/);
    expect(() => adapter.parse(withBody(strToU8('PK not really a zip')), { now: 0, env: {} })).toThrow(/malformed GDELT export: not a readable zip/);
  });
});
