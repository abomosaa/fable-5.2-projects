import { describe, expect, it } from 'vitest';
import { adapterContractSuite, runAdapterOnFixtures } from '../testing.ts';
import adapter, { BOUNDARIES_URL, PLATE_NAMES } from './adapter.ts';

adapterContractSuite(adapter, { minRecords: 241 });

describe('tectonic-plates specifics', () => {
  it('records the verified licence and the scientific citation', () => {
    const m = adapter.manifest;
    expect(m.license.name).toMatch(/Open Data Commons Attribution License/);
    expect(m.license.redistribution).toBe('allowed-with-attribution');
    expect(m.attribution).toMatch(/Bird, P\. \(2003\).*doi:10\.1029\/2001GC000252.*Hugo Ahlenius/);
    const layer = m.layers[0]!;
    expect([layer.id, layer.render.type, layer.render.color, layer.timeModel, layer.retentionDays, layer.geometry]).toEqual(['plate-boundaries', 'line', 'brown', 'reference', null, 'line']);
    expect(Object.keys(PLATE_NAMES)).toHaveLength(52);
  });

  it('emits one line record per boundary segment with a stable composite id', async () => {
    const run = await runAdapterOnFixtures(adapter);
    expect(run.requests).toEqual([BOUNDARIES_URL]);
    expect(run.rejected).toHaveLength(0);
    expect(run.records).toHaveLength(241);
    expect(new Set(run.records.map((r) => r.upstreamId)).size).toBe(241);
    expect(run.records.every((r) => r.geometryKind === 'line' && r.tStart === null && r.countries.length === 0)).toBe(true);

    // "EU-AF" occurs four times in the file; the first is the western part digitised by Bird in 1999.
    const euAf = run.records.filter((r) => r.attributes.boundaryName === 'EU-AF');
    expect(euAf.map((r) => r.upstreamId)).toEqual(['PB2002:EU-AF:1', 'PB2002:EU-AF:2', 'PB2002:EU-AF:3', 'PB2002:EU-AF:4']);
    const r = euAf[0]!;
    expect(r.title).toBe('Eurasia – Africa plate boundary');
    expect(r.subcategory).toBeNull();
    expect(r.geometry!.type).toBe('LineString');
    const coords = (r.geometry as { coordinates: number[][] }).coordinates;
    expect(coords).toHaveLength(141);
    expect(coords[0]).toEqual([-29.7698, 39.3996]);
    expect(coords[140]).toEqual([6.78405, 37.3219]);
    expect(r.attributes).toEqual({
      boundaryName: 'EU-AF', plateA: 'EU', plateB: 'AF', plateAName: 'Eurasia', plateBName: 'Africa', source: 'W part, by Peter Bird, 1999', segment: 1,
    });
    expect(r.url).toBe('https://doi.org/10.1029/2001GC000252');
    expect(r.bbox![0]).toBeCloseTo(-29.7698, 4);
    expect(r.confidence).toBeNull();
  });

  it('marks subduction zones and keeps segments that end on the antimeridian intact', async () => {
    const run = await runAdapterOnFixtures(adapter);
    const subduction = run.records.filter((r) => r.subcategory === 'subduction');
    expect(subduction).toHaveLength(65);
    const kermadec = run.records.find((r) => r.upstreamId === 'PB2002:KE/PA:1')!;
    expect(kermadec.title).toBe('Kermadec – Pacific plate boundary (subduction zone)');
    expect(kermadec.attributes.boundaryType).toBe('subduction');
    expect(kermadec.id).toMatch(/^tectonic-plates:PB2002_KE_PA_1~[0-9a-f]{16}$/); // "/" is not id-safe → hashed suffix keeps it unique
    expect((kermadec.geometry as { coordinates: number[][] }).coordinates[0]).toEqual([-180, -37.160662]);
    // No segment may span more than half the globe (i.e. be drawn across the map).
    for (const r of run.records) {
      const parts = r.geometry!.type === 'LineString' ? [(r.geometry as { coordinates: number[][] }).coordinates] : (r.geometry as { coordinates: number[][][] }).coordinates;
      for (const part of parts) for (let i = 1; i < part.length; i++) expect(Math.abs(part[i]![0]! - part[i - 1]![0]!)).toBeLessThanOrEqual(180);
    }
  });

  it('rejects malformed segments individually, splits at the antimeridian and keeps ordinals stable', async () => {
    const run = await runAdapterOnFixtures(adapter, { scenario: [{ source: adapter.manifest.id, fromRun: 1, effect: { variant: 'malformed' } }] });
    // PA-NA #2..#5 are broken; the last valid PA-NA segment keeps ordinal 6 regardless.
    expect(run.records.map((r) => r.upstreamId)).toEqual(['PB2002:PA-NA:1', 'PB2002:TO/PA:1', 'PB2002:PA-NA:6']);
    expect(run.rejected.map((r) => r.reason).sort()).toEqual([
      'geometry: latitude 135 out of range', // found by the normaliser
      'line has fewer than two positions',
      'missing boundary name or plate codes', // no Name / PlateA / PlateB
      'missing boundary name or plate codes', // not a feature object
      'missing or non-line geometry', // null
      'missing or non-line geometry', // strings as coordinates
      'missing or non-line geometry', // Polygon
    ]);
    const tonga = run.records.find((r) => r.upstreamId === 'PB2002:TO/PA:1')!;
    expect(tonga.title).toBe('Tonga – Pacific plate boundary (subduction zone)');
    expect(tonga.geometry).toEqual({ type: 'MultiLineString', coordinates: [[[178, -10], [179.5, -10.5]], [[-179.5, -11], [-178, -11.5]]] });
    expect(tonga.attributes.source).toBe('Hostile source');
    const unknownPlate = run.rejected.find((r) => r.sample?.startsWith('XX-PA'));
    expect(unknownPlate?.reason).toBe('missing or non-line geometry');
  });
});
