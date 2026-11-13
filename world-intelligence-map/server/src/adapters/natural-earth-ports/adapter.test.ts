import { describe, expect, it } from 'vitest';
import { adapterContractSuite, runAdapterOnFixtures } from '../testing.ts';
import adapter, { PORTS_URL } from './adapter.ts';

adapterContractSuite(adapter, { minRecords: 1000 });

describe('natural-earth-ports specifics', () => {
  it('declares itself as a public-domain substitute for the NGA World Port Index', () => {
    const m = adapter.manifest;
    expect(m.license.redistribution).toBe('allowed');
    expect(m.license.nonCommercialOnly).toBe(false);
    expect(m.description).toMatch(/NGA World Port Index/);
    expect(m.limitations.join(' ')).toMatch(/harbour size .* NOT available/);
    const layer = m.layers[0]!;
    expect([layer.id, layer.timeModel, layer.render.shape, layer.render.color, layer.render.minZoom, layer.retentionDays]).toEqual(['seaports', 'reference', 'pentagon', 'blue', 2, null]);
  });

  it('emits every port of the captured file as a reference point', async () => {
    const run = await runAdapterOnFixtures(adapter);
    expect(run.requests).toEqual([PORTS_URL]);
    expect(run.rejected).toHaveLength(0);
    expect(run.records).toHaveLength(1081);

    const r = run.records.find((x) => x.upstreamId === 'ne:1730089247')!;
    expect(r.title).toBe('Rotterdam');
    expect(r.layerId).toBe('seaports');
    expect(r.geometry).toEqual({ type: 'Point', coordinates: [4.292874, 51.927222] });
    expect(r.attributes).toEqual({ scaleRank: 5, nationalScaleRank: 30, website: 'www.portofrotterdam.com', featureClass: 'Port' });
    expect(r.occurredAt).toBeNull();
    expect(r.tStart).toBeNull();
    expect(r.url).toBeNull();
    expect(r.confidence).toBeNull();
    expect(r.countries).toEqual(['NLD']);
    expect(r.provenance.derived).toEqual(['country']); // Natural Earth publishes no country for ports

    const suva = run.records.find((x) => x.title === 'Suva')!;
    expect(suva.point).toEqual([178.421084, -18.1325]);
    const chicago = run.records.find((x) => x.upstreamId === 'ne:1730089677')!;
    expect(chicago.attributes.website).toBeUndefined(); // null upstream
  });

  it('rejects malformed features individually and sanitises hostile text', async () => {
    const run = await runAdapterOnFixtures(adapter, { scenario: [{ source: adapter.manifest.id, fromRun: 1, effect: { variant: 'malformed' } }] });
    expect(run.records.map((r) => r.title).sort()).toEqual(['Sanitised Port', 'Valid Harbour']);
    expect(run.rejected.map((r) => r.reason).sort()).toEqual([
      'duplicate port id',
      'feature without properties',
      'invalid coordinates', // latitude 123.4
      'invalid coordinates', // strings
      'missing or non-point geometry', // null
      'missing or non-point geometry', // LineString
      'port without a name',
    ]);
    const hostile = run.records.find((r) => r.title === 'Sanitised Port')!;
    expect(hostile.upstreamId).toBe('port:<img src=x onerror=alert(1)>Sanitised Port@103.800,1.260'); // no ne_id → name + position
    expect(hostile.id).toMatch(/^natural-earth-ports:[A-Za-z0-9._~-]+$/);
    expect(hostile.attributes.website).toBeUndefined(); // "javascript:alert(1)" is not a web address
    expect(hostile.countries).toEqual(['SGP']); // just off the coast: resolved by the gazetteer's near-shore tolerance (derived)
    expect(hostile.provenance.derived).toContain('country');
  });
});
