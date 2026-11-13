import { describe, expect, it } from 'vitest';
import { adapterContractSuite, runAdapterOnFixtures } from '../testing.ts';
import adapter, { DISPUTED_URL, PLACES_URL } from './adapter.ts';

adapterContractSuite(adapter, { minRecords: 470 });

describe('natural-earth specifics', () => {
  it('states that disputed boundaries are depictions, not endorsements', () => {
    const m = adapter.manifest;
    expect(m.limitations[0]).toMatch(/depictions.*de-facto control.*NOT an endorsement/);
    expect(m.license.redistribution).toBe('allowed');
    const disputed = m.layers.find((l) => l.id === 'disputed-areas')!;
    expect([disputed.render.type, disputed.render.color, disputed.timeModel, disputed.retentionDays]).toEqual(['polygon', 'pink', 'reference', null]);
    expect(disputed.description).toMatch(/not an endorsement/);
    const places = m.layers.find((l) => l.id === 'populated-places')!;
    expect([places.render.type, places.render.shape, places.render.color, places.render.minZoom]).toEqual(['point', 'circle', 'gray', 2]);
  });

  it('emits populated places with capital flag, population and Natural Earth country', async () => {
    const run = await runAdapterOnFixtures(adapter);
    expect(run.requests).toEqual([PLACES_URL, DISPUTED_URL]);
    expect(run.rejected).toHaveLength(0);
    const places = run.records.filter((r) => r.layerId === 'populated-places');
    expect(places).toHaveLength(450);
    expect(places.filter((r) => r.attributes.isCapital === true)).toHaveLength(200);

    const tokyo = places.find((r) => r.upstreamId === 'ne:1159151609')!;
    expect(tokyo.title).toBe('Tokyo');
    expect(tokyo.subcategory).toBe('Admin-0 capital');
    expect(tokyo.geometry).toEqual({ type: 'Point', coordinates: [139.749462, 35.686963] });
    expect(tokyo.countries).toEqual(['JPN']);
    expect(tokyo.provenance.derived).toEqual([]);
    expect(tokyo.attributes).toEqual({
      countryName: 'Japan', admin1Name: 'Tokyo', populationMax: 35676000, featureClass: 'Admin-0 capital', isCapital: true, scaleRank: 0,
    });
    expect(tokyo.tStart).toBeNull();
    expect(tokyo.url).toBeNull();

    const vatican = places.find((r) => r.title === 'Vatican City')!;
    expect(vatican.attributes.populationMax).toBe(832);
    expect(vatican.point).toEqual([12.453387, 41.903282]);
    const station = places.find((r) => r.subcategory === 'Scientific station')!;
    expect(station.attributes.isCapital).toBe(false);
    expect(station.point![1]).toBeLessThan(-60);
  });

  it('emits disputed areas as polygons without assigning them to a country', async () => {
    const run = await runAdapterOnFixtures(adapter);
    const areas = run.records.filter((r) => r.layerId === 'disputed-areas');
    expect(areas).toHaveLength(28);
    expect(areas.every((r) => r.geometryKind === 'polygon' && r.countries.length === 0 && r.point != null)).toBe(true);
    expect(new Set(areas.map((r) => r.subcategory))).toEqual(new Set(['Disputed', 'Breakaway', 'Indeterminate']));

    const abyei = areas.find((r) => r.upstreamId === 'ne:1159321231')!;
    expect(abyei.title).toBe('Abyei');
    expect(abyei.subcategory).toBe('Disputed');
    expect(abyei.geometry!.type).toBe('Polygon');
    const ring = (abyei.geometry as { coordinates: number[][][] }).coordinates[0]!;
    expect(ring).toHaveLength(11);
    expect(ring[0]).toEqual([27.885829, 9.599642]);
    expect(abyei.description).toBe('Disputed area as depicted by Natural Earth. Admin. by Sudan; Claimed by South Sudan.');
    expect(abyei.attributes).toEqual({
      disputeType: 'Disputed', note: 'Admin. by Sudan; Claimed by South Sudan', depictedUnderAdmin: 'Sudan', depictedSovereignty: 'Sudan', featureClass: 'Admin-0 claim area',
    });
    expect(abyei.bbox![0]).toBeGreaterThan(27);
    expect(abyei.bbox![2]).toBeLessThan(30);

    const kurils = areas.find((r) => r.title === 'Kuril Is.')!;
    expect(kurils.geometry!.type).toBe('MultiPolygon');
    expect(areas.find((r) => r.title === 'Arunachal Pradesh')!.attributes.alternateName).toBe('South Tibet');
  });

  it('rejects malformed features of both files individually', async () => {
    const run = await runAdapterOnFixtures(adapter, { scenario: [{ source: adapter.manifest.id, fromRun: 1, effect: { variant: 'malformed' } }] });
    expect(run.records.map((r) => [r.layerId, r.title]).sort()).toEqual([
      ['disputed-areas', 'Valid Valley'],
      ['populated-places', 'Sanitised Town'],
      ['populated-places', 'Valid Capital'],
    ]);
    expect(run.rejected.map((r) => r.reason).sort()).toEqual([
      'area without a name',
      'duplicate ne_id',
      'feature without properties',
      'geometry: latitude 99 out of range', // found by the normaliser
      'geometry: too few positions (need 3)', // two-point ring
      'invalid coordinates',
      'missing ne_id', // place
      'missing ne_id', // area
      'missing or non-point geometry',
      'missing or non-polygon geometry',
      'place without a name',
    ]);
    const hostile = run.records.find((r) => r.title === 'Sanitised Town')!;
    expect(hostile.attributes.countryName).toBe('Atlantis');
    expect(hostile.attributes.populationMax).toBeUndefined(); // -99 is Natural Earth's "no data"
    expect(hostile.countries).toEqual(['FRA']); // unknown admin code "ATL" → derived from the coordinates instead
    expect(hostile.provenance.derived).toEqual(['country']);
    const valley = run.records.find((r) => r.title === 'Valid Valley')!;
    expect(valley.provenance.normalisation).toContain('closed open polygon ring');
    expect(valley.countries).toEqual([]);
  });
});
