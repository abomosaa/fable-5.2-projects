import { describe, expect, it } from 'vitest';
import { adapterContractSuite, runAdapterOnFixtures } from '../testing.ts';
import adapter from './adapter.ts';

adapterContractSuite(adapter, { minRecords: 150 });

describe('gvp-holocene-volcanoes specifics', () => {
  it('requests the Holocene volcano feature type as GeoJSON with facts-only properties', async () => {
    const run = await runAdapterOnFixtures(adapter);
    expect(run.requests).toHaveLength(1);
    const url = new URL(run.requests[0]!);
    expect(url.hostname).toBe('webservices.volcano.si.edu');
    expect(url.searchParams.get('typeName')).toBe('GVP-VOTW:Smithsonian_VOTW_Holocene_Volcanoes');
    expect(url.searchParams.get('outputFormat')).toBe('application/json');
    const props = url.searchParams.get('propertyName')!.split(',');
    expect(props).toContain('Volcano_Number');
    expect(props).not.toContain('Geological_Summary');
    expect(props).not.toContain('Primary_Photo_Link');
  });

  it('maps a known volcano as timeless reference data', async () => {
    const run = await runAdapterOnFixtures(adapter);
    expect(run.rejected).toHaveLength(0);
    expect(run.records).toHaveLength(155);
    const r = run.records.find((x) => x.upstreamId === '211060')!;
    expect(r.title).toBe('Etna');
    expect(r.layerId).toBe('volcanoes-holocene');
    expect(r.subcategory).toBe('Stratovolcano(es)');
    expect(r.point).toEqual([14.999, 37.748]);
    expect(r.countries).toEqual(['ITA']);
    expect(r.occurredAt).toBeNull();
    expect(r.tStart).toBeNull();
    expect(r.tEnd).toBeNull();
    expect(r.severity).toBeNull();
    expect(r.confidence).toBeNull();
    expect(r.description).toBe('Stratovolcano(es) – Italy (Sicily Volcanic Province), summit elevation 3357 m; last known eruption 2026 CE (evidence: Eruption Observed).');
    expect(r.attributes).toMatchObject({
      volcanoNumber: 211060,
      volcanoType: 'Stratovolcano(es)',
      landform: 'Composite',
      lastEruptionYear: 2026,
      country: 'Italy',
      region: 'European Volcanic Regions',
      subregion: 'Sicily Volcanic Province',
      elevationM: 3357,
      evidenceCategory: 'Eruption Observed',
      majorRockType: 'Trachybasalt / Tephrite Basanite',
    });
    expect(r.url).toBe('https://volcano.si.edu/volcano.cfm?vn=211060');
    expect(r.provenance.derived).toEqual([]);
    expect(run.output.upstreamTime).toBe(Date.parse('2026-11-10T18:08:38.651Z'));
  });

  it('handles border volcanoes, qualified country strings, BCE years and undated volcanoes', async () => {
    const run = await runAdapterOnFixtures(adapter);
    const socompa = run.records.find((x) => x.upstreamId === '355109')!;
    expect(socompa.countries).toEqual(['CHL', 'ARG']); // "Chile-Argentina" as stated by GVP
    expect(socompa.provenance.derived).not.toContain('country');
    expect(socompa.attributes.lastEruptionYear).toBe(-5250);
    expect(socompa.description).toContain('last known eruption 5250 BCE');

    const kuril = run.records.find((x) => x.upstreamId === '290030')!; // "Japan - administered by Russia"
    expect(kuril.attributes.country).toBe('Japan - administered by Russia');
    expect(kuril.provenance.derived.includes('country')).toBe(kuril.countries.length > 0); // only ever position-derived

    const undated = run.records.find((x) => x.upstreamId === '355112')!;
    expect(undated.attributes.lastEruptionYear).toBeUndefined();
    expect(undated.description).toContain('no dated Holocene eruption');

    const spread = new Set(run.records.map((r) => r.attributes.region));
    expect(spread.size).toBeGreaterThanOrEqual(18);
  });

  it('rejects malformed features individually, de-duplicates and sanitises hostile text', async () => {
    const run = await runAdapterOnFixtures(adapter, { scenario: [{ source: 'gvp-holocene-volcanoes', fromRun: 1, effect: { variant: 'malformed' } }] });
    expect(run.records.map((r) => r.upstreamId)).toEqual(['211020', '999001']);
    expect(run.records[0]!.title).toBe('Vesuvius');
    const hostile = run.records[1]!;
    expect(hostile.title).toBe('Hostile Seamount');
    expect(hostile.point).toEqual([-174.75, -20.5]); // from Latitude/Longitude properties, 185.25°E wrapped
    expect(hostile.attributes).toMatchObject({ elevationM: -650, lastEruptionYear: -1050, country: 'Undersea Features' });
    const reasons = run.rejected.map((r) => r.reason);
    expect(reasons.filter((r) => r === 'missing or invalid volcano number')).toHaveLength(2);
    expect(reasons).toContain('missing volcano name');
    expect(reasons.filter((r) => r === 'missing or invalid coordinates')).toHaveLength(2);
    expect(reasons.filter((r) => r === 'missing properties')).toHaveLength(2);
    expect(run.rejected).toHaveLength(7);
  });
});
