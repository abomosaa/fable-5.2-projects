import { describe, expect, it } from 'vitest';
import { adapterContractSuite, runAdapterOnFixtures } from '../testing.ts';
import adapter, { DESCRIPTION_MAX, EXPORT_URL } from './adapter.ts';

adapterContractSuite(adapter, { minRecords: 340 });

describe('unesco-world-heritage specifics', () => {
  it('records the share-alike licence found on the dataset page', () => {
    const m = adapter.manifest;
    expect(m.license.name).toContain('CC BY-SA 4.0');
    expect(m.license.url).toBe('https://creativecommons.org/licenses/by-sa/4.0/');
    expect(m.license.redistribution).toBe('allowed-with-attribution');
    const layer = m.layers[0]!;
    expect([layer.id, layer.render.shape, layer.render.color, layer.render.minZoom, layer.timeModel, layer.retentionDays]).toEqual(['world-heritage-sites', 'star', 'yellow', 2, 'reference', null]);
    expect(m.updateCadence.pollIntervalSec).toBe(30 * 86400);
  });

  it('requests only the needed fields in one export call and maps a known site exactly', async () => {
    const run = await runAdapterOnFixtures(adapter);
    expect(run.requests).toEqual([EXPORT_URL]);
    expect(EXPORT_URL).toContain('select=id_no,name_en,short_description_en,date_inscribed,danger,');
    expect(run.rejected).toHaveLength(0);
    expect(run.records).toHaveLength(359);

    const taj = run.records.find((r) => r.upstreamId === '252')!;
    expect(taj.title).toBe('Taj Mahal');
    expect(taj.subcategory).toBe('Cultural');
    expect(taj.geometry).toEqual({ type: 'Point', coordinates: [78.04222, 27.17417] });
    expect(taj.countries).toEqual(['IND']);
    expect(taj.provenance.derived).toEqual([]);
    expect(taj.severity).toBeNull();
    expect(taj.severityLabel).toBeNull();
    expect(taj.attributes).toEqual({
      category: 'Cultural', inscribedYear: 1983, inDanger: false, states: 'India', isoCodes: 'IN', region: 'Asia and the Pacific', transboundary: false,
    }); // area_hectares 0.0 upstream means "not recorded"
    expect(taj.description).toBe(
      "An immense mausoleum of white marble, built in Agra between 1631 and 1648 by order of the Mughal emperor Shah Jahan in memory of his favourite wife, the Taj Mahal is the jewel of Muslim art in India and one of the universally admired masterpieces of the world's heritage.",
    );
    expect(taj.url).toBe('https://whc.unesco.org/en/list/252');
    expect(taj.occurredAt).toBeNull();
    expect(taj.tStart).toBeNull();
    expect(taj.confidence).toBeNull();
  });

  it('flags every property on the List of World Heritage in Danger with severity 2 and the upstream wording', async () => {
    const run = await runAdapterOnFixtures(adapter);
    const danger = run.records.filter((r) => r.severity != null);
    expect(danger).toHaveLength(58);
    expect(danger.every((r) => r.severity === 2 && r.attributes.inDanger === true && r.provenance.derived.includes('severity'))).toBe(true);
    expect(run.records.filter((r) => r.attributes.inDanger === false).every((r) => r.severity === null)).toBe(true);
    const odesa = run.records.find((r) => r.upstreamId === '1703')!;
    expect(odesa.title).toBe('The Historic Centre of Odesa');
    expect(odesa.severityLabel).toBe('List of World Heritage in Danger (since 2023)');
    expect(odesa.attributes.inDangerSinceYear).toBe(2023);
    expect(odesa.attributes.inscribedYear).toBe(2023);
    expect(odesa.point).toEqual([30.741614, 46.48645]);
    expect(odesa.countries).toEqual(['UKR']);
  });

  it('keeps descriptions to a short excerpt and handles transboundary and coordinate-less properties', async () => {
    const run = await runAdapterOnFixtures(adapter);
    for (const r of run.records) expect((r.description ?? '').length).toBeLessThanOrEqual(DESCRIPTION_MAX);
    const dday = run.records.find((r) => r.upstreamId === '1581')!;
    expect(dday.description!.length).toBe(DESCRIPTION_MAX);
    expect(dday.description!.endsWith('…')).toBe(true);
    expect(dday.attributes.areaHectares).toBe(4228.68);

    // Serial property published without a point → attached to its States Parties, in upstream order.
    const front = run.records.find((r) => r.upstreamId === '1567')!;
    expect(front.geometry).toBeNull();
    expect(front.geometryKind).toBe('country');
    expect(front.countries).toEqual(['FRA', 'BEL']);
    expect(front.attributes.states).toBe('France, Belgium');

    // UNESCO publishes the Old City of Jerusalem without a State Party; the adapter passes on exactly that.
    const jerusalem = run.records.find((r) => r.upstreamId === '148')!;
    expect(jerusalem.attributes.isoCodes).toBeUndefined();
    expect(jerusalem.attributes.states).toBe('Jerusalem (Site proposed by Jordan)');
    expect(jerusalem.severity).toBe(2);

    const multi = run.records.filter((r) => r.attributes.transboundary === true);
    expect(multi.length).toBeGreaterThan(5);
    expect(multi.every((r) => r.countries.length >= 2 || /,/.test(String(r.attributes.states)))).toBe(true);
  });

  it('rejects malformed rows individually, skips delisted properties and sanitises hostile text', async () => {
    const run = await runAdapterOnFixtures(adapter, { scenario: [{ source: adapter.manifest.id, fromRun: 1, effect: { variant: 'malformed' } }] });
    expect(run.records.map((r) => r.upstreamId).sort()).toEqual(['90001', '90002', '90012']);
    expect(run.rejected.map((r) => r.reason).sort()).toEqual([
      'duplicate id_no',
      'invalid coordinates', // latitude 148
      'invalid coordinates', // a string instead of {lon, lat}
      'missing English name',
      'missing or invalid id_no',
      'neither coordinates nor a State Party',
      'row is not an object',
      'unknown category "Intangible"',
    ]);
    const hostile = run.records.find((r) => r.upstreamId === '90002')!;
    expect(hostile.title).toBe('Sanitised Rainforest');
    expect(hostile.description).toBe('Short text with markup & entities.');
    expect(hostile.severity).toBe(2);
    expect(hostile.severityLabel).toBe('List of World Heritage in Danger (since 2011)');
    expect(hostile.countries).toEqual(['BRA', 'PER']);
    expect(hostile.attributes.areaHectares).toBeUndefined();
    const route = run.records.find((r) => r.upstreamId === '90012')!;
    expect(route.geometryKind).toBe('country');
    expect(route.countries).toEqual(['ESP']);
    expect(route.attributes.inscribedYear).toBeUndefined(); // "bad year"
    expect(route.severity).toBeNull(); // "yes" is not the documented flag value
  });
});
