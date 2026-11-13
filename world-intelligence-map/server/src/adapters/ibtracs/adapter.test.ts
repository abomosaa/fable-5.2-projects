import { describe, expect, it } from 'vitest';
import { adapterContractSuite, runAdapterOnFixtures } from '../testing.ts';
import adapter from './adapter.ts';

// The live ACTIVE file listed four storms when the fixture was captured.
adapterContractSuite(adapter, { minRecords: 4 });

describe('ibtracs specifics', () => {
  it('builds one track per storm from all of its fixes', async () => {
    const run = await runAdapterOnFixtures(adapter);
    expect(run.rejected).toHaveLength(0);
    expect(run.records.map((r) => [r.upstreamId, r.attributes.name, r.attributes.fixes])).toEqual([
      ['2026297N11166', 'IN-FA', 103],
      ['2026307N08230', 'PENA', 61],
      ['2026310N18149', 'CEMPAKA', 31],
      ['2026312S13053', 'UNNAMED', 19],
    ]);
    expect(run.output.upstreamTime).toBe(Date.parse('2026-11-10T10:02:28Z')); // Last-Modified of the file

    const r = run.records.find((x) => x.upstreamId === '2026307N08230')!;
    expect(r.layerId).toBe('cyclone-tracks');
    expect(r.title).toBe('Tropical cyclone PENA (2026, Eastern North Pacific)');
    expect(r.geometryKind).toBe('track');
    expect(r.geometry?.type).toBe('LineString');
    const coords = (r.geometry as { coordinates: number[][] }).coordinates;
    expect(coords[0]).toEqual([-129.8, 7.7]);
    expect(coords[coords.length - 1]).toEqual([-162.1, 11.7]);
    expect(r.point).toEqual([-162.1, 11.7]); // head of the track
    expect(r.occurredAt).toBe(Date.parse('2026-11-02T12:00:00Z'));
    expect(r.tEnd).toBe(Date.parse('2026-11-10T00:00:00Z'));
    expect(r.ongoing).toBe(false);
    expect(r.severity).toBe(2); // peak 50 kt
    expect(r.severityLabel).toBe('max wind 50 kt');
    expect(r.confidence).toBeNull();
    expect(r.attributes).toMatchObject({
      sid: '2026307N08230',
      name: 'PENA',
      basin: 'EP',
      basinName: 'Eastern North Pacific',
      season: 2026,
      maxWindKt: 50,
      minPressureMb: 996,
      fixes: 61,
      agency: 'nhc_working_bt',
      trackType: 'PROVISIONAL',
      atcfId: 'CP042026',
      latestWindKt: 35,
      latestDistanceToLandKm: 1058,
    });
    expect(r.description).toBe('Track of 61 fixes from 2026-11-02 12:00 to 2026-11-10 00:00 UTC; peak sustained wind 50 kt; minimum pressure 996 mb.');
    expect(r.url).toBe('https://ncics.org/ibtracs/index.php?name=v04r01-2026307N08230');
    expect(r.provenance.derived).toEqual(['severity']);
  });

  it('maps peak wind onto severity and labels unnamed storms by their id', async () => {
    const run = await runAdapterOnFixtures(adapter);
    const infa = run.records.find((x) => x.upstreamId === '2026297N11166')!;
    expect(infa.attributes.maxWindKt).toBe(128);
    expect(infa.attributes.minPressureMb).toBe(934);
    expect(infa.severity).toBe(4);
    expect(infa.occurredAt).toBe(Date.parse('2026-10-23T12:00:00Z'));
    expect(infa.tEnd).toBe(Date.parse('2026-11-05T06:00:00Z'));
    const unnamed = run.records.find((x) => x.upstreamId === '2026312S13053')!;
    expect(unnamed.title).toBe('Tropical cyclone (unnamed) 2026312S13053 (2027, South Indian Ocean)');
    expect(unnamed.severity).toBe(2); // 39 kt
    expect(unnamed.point).toEqual([47.8, -9.2]);
  });

  it('splits tracks at the antimeridian, keeps single-fix storms as points and rejects broken fixes individually', async () => {
    const run = await runAdapterOnFixtures(adapter, { scenario: [{ source: 'ibtracs', fromRun: 1, effect: { variant: 'malformed' } }] });
    expect(run.records.map((r) => r.upstreamId)).toEqual(['2026313S16178', '2026314N12130', '2026312N20300']);

    const dateline = run.records[0]!;
    expect(dateline.geometryKind).toBe('track');
    expect(dateline.geometry).toEqual({
      type: 'MultiLineString',
      coordinates: [
        [[177.5, -16], [178.4, -16.4], [179.2, -17]],
        [[-179.9, -17.8], [-178.8, -18.9]], // 180.1°E wrapped to -179.9
      ],
    });
    expect(dateline.attributes).toMatchObject({ maxWindKt: 100, minPressureMb: 950, fixes: 5, basinName: 'South Pacific', latestLongitude: -178.8 });
    expect(dateline.severity).toBe(4);

    const single = run.records[1]!;
    expect(single.geometry).toEqual({ type: 'Point', coordinates: [130, 12.5] });
    expect(single.geometryKind).toBe('point');
    expect(single.title).toBe('Tropical cyclone NEWBORN (2026, Western North Pacific)');
    expect(single.attributes.name).toBe('NEWBORN');
    expect(single.severity).toBe(1);

    const partial = run.records[2]!;
    expect(partial.attributes.fixes).toBe(2); // 2 of 5 fixes usable
    expect(partial.geometry).toEqual({ type: 'LineString', coordinates: [[-60, 20], [-63, 22]] });
    expect(partial.attributes.maxWindKt).toBe(35); // "n/a" wind ignored

    const reasons = run.rejected.map((r) => r.reason);
    expect(reasons.filter((r) => r === 'fix with missing or invalid coordinates')).toHaveLength(3);
    expect(reasons.filter((r) => r === 'fix with missing or unparseable ISO_TIME')).toHaveLength(2);
    expect(reasons).toContain('fix without storm id (SID)');
    expect(run.rejected).toHaveLength(6);
    expect(run.records.some((r) => r.upstreamId === '2026311N10250')).toBe(false); // every fix broken → no record
  });

  it('throws on a CSV without the expected columns', () => {
    const fake = (body: string) => [{ key: 'active', text: () => body, lastModified: null }] as never;
    expect(() => adapter.parse(fake('a,b,c\n1,2,3\n'), { now: 0, env: {} })).toThrow(/malformed IBTrACS CSV: missing column/);
    expect(() => adapter.parse(fake('<html>Service unavailable</html>'), { now: 0, env: {} })).toThrow(/malformed IBTrACS CSV/);
  });
});
