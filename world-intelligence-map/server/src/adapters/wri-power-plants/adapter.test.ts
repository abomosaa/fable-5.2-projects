import { describe, expect, it } from 'vitest';
import { FIXTURE_EPOCH } from '../../core/fixtureEpoch.ts';
import type { FetchedPayload } from '../../core/types.ts';
import { adapterContractSuite, runAdapterOnFixtures } from '../testing.ts';
import adapter, { FUEL_LAYER, GPPD_URL, MIN_CAPACITY_MW } from './adapter.ts';

adapterContractSuite(adapter, { minRecords: 1100 });

function csvPayload(text: string): FetchedPayload {
  return {
    key: 'gppd', url: GPPD_URL, status: 200, body: Buffer.from(text), contentType: 'text/csv', fetchedAt: FIXTURE_EPOCH, etag: null, lastModified: null,
    notModified: false, fromCache: false, stale: false, text: () => text, json: <T>() => JSON.parse(text) as T,
  };
}

describe('wri-power-plants specifics', () => {
  it('says clearly that the dataset is static and ageing', () => {
    const m = adapter.manifest;
    expect(m.limitations[0]).toMatch(/STATIC AND AGEING.*2021.*no longer maintained/);
    expect(m.license.name).toContain('CC BY 4.0');
    expect(m.license.redistribution).toBe('allowed-with-attribution');
    expect(m.layers.map((l) => [l.id, l.render.color, l.render.minZoom ?? null, l.defaultOn])).toEqual([
      ['power-nuclear', 'purple', null, false],
      ['power-fossil', 'brown', 3, false],
      ['power-hydro', 'blue', 3, false],
      ['power-renewable', 'green', 4, false],
    ]);
    expect(m.layers.every((l) => l.timeModel === 'reference' && l.retentionDays === null)).toBe(true);
  });

  it('splits plants into layers by primary fuel and applies the 50 MW display threshold (nuclear exempt)', async () => {
    const run = await runAdapterOnFixtures(adapter);
    expect(run.rejected).toHaveLength(0);
    const count = (layer: string) => run.records.filter((r) => r.layerId === layer).length;
    expect(count('power-nuclear')).toBe(195); // every nuclear plant of the database
    expect(count('power-fossil')).toBe(462);
    expect(count('power-hydro')).toBe(215);
    expect(count('power-renewable')).toBe(315);
    expect(run.records).toHaveLength(1187); // 56 fixture plants below 50 MW are skipped
    for (const r of run.records) {
      expect(FUEL_LAYER[r.subcategory!]).toBe(r.layerId);
      if (r.layerId !== 'power-nuclear') expect(r.attributes.capacityMw as number).toBeGreaterThanOrEqual(MIN_CAPACITY_MW);
      expect(r.countries).toHaveLength(1);
      expect(r.tStart).toBeNull();
    }
    const smallNuclear = run.records.find((r) => r.upstreamId === 'WRI1061016')!; // 20 MW experimental reactor
    expect(smallNuclear.layerId).toBe('power-nuclear');
    expect(smallNuclear.attributes.capacityMw).toBe(20);
    expect(run.records.some((r) => r.upstreamId === 'CAN0007618')).toBe(false); // 20 MW tidal plant
  });

  it('maps known rows exactly', async () => {
    const run = await runAdapterOnFixtures(adapter);
    const kk = run.records.find((r) => r.upstreamId === 'WRI1000679')!;
    expect(kk.title).toBe('Kashiwazaki Kariwa');
    expect(kk.layerId).toBe('power-nuclear');
    expect(kk.subcategory).toBe('Nuclear');
    expect(kk.geometry).toEqual({ type: 'Point', coordinates: [138.5941, 37.4259] }); // CSV order is latitude, longitude
    expect(kk.countries).toEqual(['JPN']);
    expect(kk.provenance.derived).toEqual([]);
    expect(kk.attributes).toEqual({
      capacityMw: 8212, primaryFuel: 'Nuclear', estimatedGenerationGwh: 65600.32, estimatedGenerationYear: 2017,
      owner: 'Tokyo', sourceName: 'Japanese Electric Power Information Center',
    });
    expect(kk.description).toBe('Nuclear power plant, 8,212 MW, Japan (WRI Global Power Plant Database, 2021 snapshot).');
    expect(kk.url).toBe('https://www.jepic.or.jp/en/');
    expect(kk.occurredAt).toBeNull();
    expect(kk.severity).toBeNull();
    expect(kk.confidence).toBeNull();

    const ano = run.records.find((r) => r.upstreamId === 'USA0008055')!;
    expect(ano.title).toBe('Arkansas Nuclear One');
    expect(ano.attributes).toMatchObject({
      capacityMw: 1845, commissioningYear: 1978, // 1977.55 upstream (capacity-weighted over units)
      reportedGenerationGwh: 13574.95, reportedGenerationYear: 2019, // most recent reported year wins
      estimatedGenerationGwh: 14636.91, estimatedGenerationYear: 2017,
      owner: 'Entergy Arkansas LLC', generationDataSource: 'U.S. Energy Information Administration', capacityDataYear: 2019,
    });

    const gas = run.records.find((r) => r.upstreamId === 'ARG0000043')!;
    expect(gas.layerId).toBe('power-fossil');
    expect(gas.attributes).toMatchObject({ capacityMw: 868.2, primaryFuel: 'Gas', otherFuels: 'Other', commissioningYear: 2009 });

    const hydro = run.records.find((r) => r.upstreamId === 'CAN0007783')!; // 51 MW, just above the threshold; ftp:// source link
    expect(hydro.layerId).toBe('power-hydro');
    expect(hydro.url).toBeNull();
    expect(hydro.provenance.normalisation).toContain('dropped non-http(s) source link');
    expect(hydro.attributes.estimatedGenerationGwh).toBe(260.6);
  });

  it('rejects malformed rows individually and sanitises hostile text', async () => {
    const run = await runAdapterOnFixtures(adapter, { scenario: [{ source: adapter.manifest.id, fromRun: 1, effect: { variant: 'malformed' } }] });
    expect(run.records.map((r) => r.upstreamId).sort()).toEqual(['TST0000001', 'TST0000002']);
    expect(run.rejected.map((r) => r.reason).sort()).toEqual([
      'duplicate gppd_idnr',
      'missing gppd_idnr',
      'missing or invalid capacity_mw', // "lots"
      'missing or invalid capacity_mw', // -10
      'missing or invalid coordinates', // latitude 95
      'missing or invalid coordinates', // text
      'unknown primary_fuel ""', // truncated row
      'unknown primary_fuel "Antimatter"',
    ]);
    const hostile = run.records.find((r) => r.upstreamId === 'TST0000002')!;
    expect(hostile.title).toBe('Sanitised "Hydro" Plant, Unit 1');
    expect(hostile.attributes.owner).toBe('Owner Ltda');
    expect(hostile.url).toBeNull();
    expect(hostile.attributes).toMatchObject({ otherFuels: 'Oil', estimatedGenerationGwh: 410, estimatedGenerationYear: 2014 });
    const valid = run.records.find((r) => r.upstreamId === 'TST0000001')!;
    expect(valid.attributes).toMatchObject({ commissioningYear: 1986, reportedGenerationGwh: 15000.5, reportedGenerationYear: 2019 });
  });

  it('refuses a file whose header is not the documented one', () => {
    expect(() => adapter.parse([csvPayload('name,capacity\nX,1\n')], { now: FIXTURE_EPOCH, env: {} })).toThrow(/header lacks country, gppd_idnr/);
    expect(() => adapter.parse([csvPayload('')], { now: FIXTURE_EPOCH, env: {} })).toThrow(/malformed Global Power Plant Database/);
  });

  it('parses a full-size file (40,000 plants) in a single fast pass', () => {
    const fuels = Object.keys(FUEL_LAYER);
    const header = 'country,country_long,name,gppd_idnr,capacity_mw,latitude,longitude,primary_fuel,other_fuel1,other_fuel2,other_fuel3,commissioning_year,owner,source,url,geolocation_source,wepp_id,year_of_capacity_data,generation_gwh_2013,generation_gwh_2014,generation_gwh_2015,generation_gwh_2016,generation_gwh_2017,generation_gwh_2018,generation_gwh_2019,generation_data_source,estimated_generation_gwh_2013,estimated_generation_gwh_2014,estimated_generation_gwh_2015,estimated_generation_gwh_2016,estimated_generation_gwh_2017,estimated_generation_note_2013,estimated_generation_note_2014,estimated_generation_note_2015,estimated_generation_note_2016,estimated_generation_note_2017';
    const lines = [header];
    let expected = 0;
    for (let i = 0; i < 40_000; i++) {
      const fuel = fuels[i % fuels.length]!;
      const capacity = (i % 400) + 1;
      if (fuel === 'Nuclear' || capacity >= 50) expected++;
      lines.push(`USA,United States of America,"Generated Plant ${i}, ""Unit"" A",GEN${String(i).padStart(7, '0')},${capacity}.0,${((i * 13) % 1200) / 10 - 60},${((i * 29) % 3400) / 10 - 170},${fuel},,,,${1950 + (i % 70)}.0,Owner ${i % 500} LLC,Generated Source,https://example.org/plant/${i},Generated Source,${i},2019,,,,,,,${i}.5,Generated Source,1.0,2.0,3.0,4.0,5.0,NO-ESTIMATION,NO-ESTIMATION,NO-ESTIMATION,NO-ESTIMATION,CAPACITY-FACTOR-V1`);
    }
    const text = lines.join('\r\n') + '\r\n';
    expect(text.length).toBeGreaterThan(10_000_000);
    const started = performance.now();
    const out = adapter.parse([csvPayload(text)], { now: FIXTURE_EPOCH, env: {} });
    const ms = performance.now() - started;
    expect(out.rejected).toHaveLength(0);
    expect(out.records).toHaveLength(expected);
    expect(ms).toBeLessThan(3000);
  });
});
