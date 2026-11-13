import { describe, expect, it } from 'vitest';
import { FIXTURE_EPOCH } from '../../core/fixtureEpoch.ts';
import type { FetchedPayload } from '../../core/types.ts';
import { adapterContractSuite, runAdapterOnFixtures } from '../testing.ts';
import adapter, { AIRPORTS_URL } from './adapter.ts';

adapterContractSuite(adapter, { minRecords: 1500 });

function csvPayload(text: string): FetchedPayload {
  return {
    key: 'airports', url: AIRPORTS_URL, status: 200, body: Buffer.from(text), contentType: 'text/csv', fetchedAt: FIXTURE_EPOCH, etag: null, lastModified: null,
    notModified: false, fromCache: false, stale: false, text: () => text, json: <T>() => JSON.parse(text) as T,
  };
}

describe('ourairports specifics', () => {
  it('emits large airports and scheduled medium airports only', async () => {
    const run = await runAdapterOnFixtures(adapter);
    expect(run.rejected).toHaveLength(0);
    expect(run.requests).toEqual([AIRPORTS_URL]);
    const large = run.records.filter((r) => r.layerId === 'airports-large');
    const medium = run.records.filter((r) => r.layerId === 'airports-medium');
    expect(large).toHaveLength(1175); // every large airport of the live file, with or without scheduled service
    expect(medium).toHaveLength(360); // the 40 unscheduled medium airports and 20 rows of other types are skipped
    expect(run.records).toHaveLength(1535);
    expect(medium.every((r) => r.attributes.scheduledService === true && r.subcategory === 'medium_airport')).toBe(true);
    expect(run.records.some((r) => /heliport|closed|small_airport|seaplane|balloon/.test(r.subcategory ?? ''))).toBe(false);
    expect(run.output.upstreamTime).toBe(Date.parse('2026-11-10T02:54:14Z')); // Last-Modified header
  });

  it('maps a known row exactly (London Heathrow)', async () => {
    const run = await runAdapterOnFixtures(adapter);
    const r = run.records.find((x) => x.attributes.ident === 'EGLL')!;
    expect(r.upstreamId).toBe('2434');
    expect(r.id).toBe('ourairports:2434');
    expect(r.title).toBe('London Heathrow Airport (LHR)');
    expect(r.layerId).toBe('airports-large');
    expect(r.geometry).toEqual({ type: 'Point', coordinates: [-0.459909, 51.470748] }); // CSV order is latitude, longitude
    expect(r.countries).toEqual(['GBR']);
    expect(r.provenance.derived).toEqual([]); // country comes from iso_country, not from a lookup
    expect(r.attributes).toEqual({
      ident: 'EGLL', iataCode: 'LHR', icaoCode: 'EGLL', gpsCode: 'EGLL', elevationFt: 83, municipality: 'London', isoRegion: 'GB-ENG', scheduledService: true,
    });
    expect(r.url).toBe('https://ourairports.com/airports/EGLL/');
    expect(r.occurredAt).toBeNull();
    expect(r.tStart).toBeNull(); // timeless reference data

    const unscheduled = run.records.find((x) => x.attributes.ident === 'DIYO')!; // large airport without scheduled service
    expect(unscheduled.layerId).toBe('airports-large');
    expect(unscheduled.attributes.scheduledService).toBe(false);
    expect(unscheduled.countries).toEqual(['CIV']);
    const quoted = run.records.find((x) => x.attributes.ident === 'ENBR')!; // name contains a comma
    expect(quoted.title).toBe('Bergen Airport, Flesland (BGO)');
  });

  it('rejects malformed rows individually and sanitises hostile text', async () => {
    const run = await runAdapterOnFixtures(adapter, { scenario: [{ source: 'ourairports', fromRun: 1, effect: { variant: 'malformed' } }] });
    expect(run.records.map((r) => r.attributes.ident).sort()).toEqual(['ZZHT', 'ZZOK']);
    const reasons = run.rejected.map((r) => r.reason).sort();
    expect(reasons).toEqual([
      'duplicate airport id',
      'missing id or ident',
      'missing or invalid coordinates', // latitude 95.1
      'missing or invalid coordinates', // text
      'missing or invalid coordinates', // empty longitude
      'missing or invalid coordinates', // longitude 200
      'truncated row',
    ]);
    const hostile = run.records.find((r) => r.attributes.ident === 'ZZHT')!;
    expect(hostile.title).toBe('Sanitised "Regional" Airport, North');
    expect(hostile.layerId).toBe('airports-medium');
    expect(hostile.point).toEqual([151.2, -33.9]);
    expect(hostile.attributes.elevationFt).toBeUndefined();
    expect(hostile.countries).toEqual(['AUS']);
    expect(run.records.find((r) => r.attributes.ident === 'ZZOK')!.title).toBe('Valid Test International Airport (ZOK)');
  });

  it('refuses a file whose header is not the documented one', () => {
    expect(() => adapter.parse([csvPayload('a,b,c\n1,2,3\n')], { now: FIXTURE_EPOCH, env: {} })).toThrow(/header lacks id, ident, type/);
    expect(() => adapter.parse([csvPayload('')], { now: FIXTURE_EPOCH, env: {} })).toThrow(/malformed OurAirports/);
  });

  it('parses a full-size file (90,000 rows) in a single fast pass', () => {
    const types = ['small_airport', 'heliport', 'closed', 'small_airport', 'medium_airport', 'small_airport', 'seaplane_base', 'large_airport'];
    const lines = ['"id","ident","type","name","latitude_deg","longitude_deg","elevation_ft","continent","iso_country","iso_region","municipality","scheduled_service","icao_code","iata_code","gps_code","local_code","home_link","wikipedia_link","keywords"'];
    for (let i = 0; i < 90_000; i++) {
      const type = types[i % types.length]!;
      lines.push(`${i + 1},"T${i}","${type}","Generated ""Airport"" ${i}, Test",${((i * 13) % 1700) / 10 - 85},${((i * 29) % 3600) / 10 - 180},${i % 9000},"EU","FR","FR-IDF","Ville ${i}","${i % 3 ? 'yes' : 'no'}","T${i}",,"T${i}",,"https://example.org/${i}","https://en.wikipedia.org/wiki/${i}","keyword one, keyword two"`);
    }
    const text = lines.join('\n') + '\n';
    expect(text.length).toBeGreaterThan(15_000_000);
    const started = performance.now();
    const out = adapter.parse([csvPayload(text)], { now: FIXTURE_EPOCH, env: {} });
    const ms = performance.now() - started;
    expect(out.rejected).toHaveLength(0);
    const large = 90_000 / 8;
    expect(out.records.filter((r) => r.layerId === 'airports-large')).toHaveLength(large);
    expect(out.records.filter((r) => r.layerId === 'airports-medium')).toHaveLength(7500); // i ≡ 4 (mod 8) and i not divisible by 3
    expect(ms).toBeLessThan(3000);
  });
});
