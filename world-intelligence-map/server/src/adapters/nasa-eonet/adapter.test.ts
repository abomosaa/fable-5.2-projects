import { describe, expect, it } from 'vitest';
import { adapterContractSuite, runAdapterOnFixtures } from '../testing.ts';
import adapter from './adapter.ts';

adapterContractSuite(adapter, { minRecords: 190 });

const malformed = { scenario: [{ source: 'nasa-eonet', fromRun: 1, effect: { variant: 'malformed' } }] };

describe('nasa-eonet specifics', () => {
  it('requests recent events of every status plus long-lived open events, and de-duplicates the overlap', async () => {
    const run = await runAdapterOnFixtures(adapter);
    expect(run.requests).toEqual([
      'https://eonet.gsfc.nasa.gov/api/v3/events?status=all&days=30',
      'https://eonet.gsfc.nasa.gov/api/v3/events?status=open&category=volcanoes,seaLakeIce,severeStorms',
    ]);
    expect(run.rejected).toHaveLength(0);
    const recent = (run.payloads[0]!.json() as { events: { id: string }[] }).events.map((e) => e.id);
    const open = (run.payloads[1]!.json() as { events: { id: string }[] }).events.map((e) => e.id);
    expect(recent.filter((id) => open.includes(id)).length).toBeGreaterThan(0);
    expect(run.records).toHaveLength(new Set([...recent, ...open]).size);
    const perLayer = (layer: string) => run.records.filter((r) => r.layerId === layer).length;
    expect(perLayer('eonet-wildfires')).toBe(127);
    expect(perLayer('eonet-volcanoes')).toBe(32);
    expect(perLayer('eonet-severe-storms')).toBe(16);
    expect(perLayer('eonet-other')).toBe(10);
  });

  it('maps an open wildfire with its reported size and source link', async () => {
    const run = await runAdapterOnFixtures(adapter);
    const r = run.records.find((x) => x.upstreamId === 'EONET_26258')!;
    expect(r.layerId).toBe('eonet-wildfires');
    expect(r.title).toBe('Wildfire FOOT CREEK, Johnson, Wyoming');
    expect(r.description).toBe('10 Miles W from Bufffalo, WY');
    expect(r.point).toEqual([-106.93255, 44.318717]);
    expect(r.occurredAt).toBe(Date.parse('2026-11-05T16:11:00Z'));
    expect(r.ongoing).toBe(true);
    expect(r.tEnd).toBe(r.fetchedAt);
    expect(r.severity).toBeNull();
    expect(r.confidence).toBeNull();
    expect(r.attributes).toMatchObject({ areaAcres: 683, magnitudeValue: 683, magnitudeUnit: 'acres', sources: 'IRWIN', status: 'open', eonetCategory: 'Wildfires' });
    expect(r.url).toBe('https://irwin.doi.gov/observer/incidents/2026-WYBHF-000401');
    expect(r.countries).toEqual(['USA']);
  });

  it('turns the dated positions of a storm into a track ending at the latest position', async () => {
    const run = await runAdapterOnFixtures(adapter);
    const r = run.records.find((x) => x.upstreamId === 'EONET_26157')!;
    expect(r.title).toBe('Typhoon Cempaka');
    expect(r.layerId).toBe('eonet-severe-storms');
    expect(r.geometryKind).toBe('track');
    expect(r.geometry?.type).toBe('LineString');
    const coords = (r.geometry as { coordinates: number[][] }).coordinates;
    expect(coords).toHaveLength(15);
    expect(coords[0]).toEqual([144.2, 19.1]);
    expect(coords[14]).toEqual([142.1, 26.1]);
    expect(r.point).toEqual([142.1, 26.1]); // representative point of a track = latest position
    expect(r.occurredAt).toBe(Date.parse('2026-11-07T00:00:00Z'));
    expect(r.updatedAt).toBe(Date.parse('2026-11-10T12:00:00Z'));
    expect(r.ongoing).toBe(true);
    expect(r.severity).toBe(3); // peak 95 kt
    expect(r.severityLabel).toBe('peak wind 95 kt');
    expect(r.attributes).toMatchObject({ peakWindKt: 95, latestWindKt: 85, positionsReported: 15, sources: 'JTWC' });
    expect(r.provenance.derived).toEqual(expect.arrayContaining(['geometry', 'severity']));

    const closed = run.records.find((x) => x.upstreamId === 'EONET_25730')!; // Tropical Storm Olana
    expect(closed.ongoing).toBe(false);
    expect(closed.tEnd).toBe(Date.parse('2026-11-01T00:00:00Z'));
    expect(closed.severity).toBe(2); // peak 40 kt
    expect(closed.attributes.status).toBe('closed');
  });

  it('shows icebergs and volcanoes at their latest position and keeps the first report as the start', async () => {
    const run = await runAdapterOnFixtures(adapter);
    const berg = run.records.find((x) => x.upstreamId === 'EONET_2736')!;
    expect(berg.layerId).toBe('eonet-sea-ice');
    expect(berg.geometry).toEqual({ type: 'Point', coordinates: [163.59, -69.59] });
    expect(berg.occurredAt).toBe(Date.parse('2011-08-30T00:00:00Z'));
    expect(berg.updatedAt).toBe(Date.parse('2026-11-06T00:00:00Z'));
    expect(berg.attributes).toMatchObject({ areaSqNauticalMiles: 725, positionsReported: 49, sources: 'BYU_ICE, NATICE' });
    const volcano = run.records.find((x) => x.upstreamId === 'EONET_4156')!;
    expect(volcano.layerId).toBe('eonet-volcanoes');
    expect(volcano.title).toBe('Sangay Volcano, Ecuador');
    expect(volcano.point).toEqual([-78.341, -2.005]);
    expect(volcano.occurredAt).toBe(Date.parse('2019-03-26T09:19:10Z'));
    expect(volcano.ongoing).toBe(true);
    expect(volcano.url).toBe('http://volcano.si.edu/volcano.cfm?vn=352090');
  });

  it('puts other categories on the catch-all layer with the EONET category as sub-category', async () => {
    const run = await runAdapterOnFixtures(adapter);
    const flood = run.records.find((x) => x.upstreamId === 'EONET_26160')!;
    expect(flood.layerId).toBe('eonet-other');
    expect(flood.subcategory).toBe('floods');
    expect(flood.geometryKind).toBe('polygon');
    expect(flood.ongoing).toBe(false);
    expect(flood.tStart).toBe(Date.parse('2026-11-06T20:00:00Z'));
    expect(flood.tEnd).toBe(Date.parse('2026-11-08T00:00:00Z'));
    expect(flood.url).toBe('https://www.gdacs.org/report.aspx?eventtype=FL&eventid=1104272');
  });

  it('rejects malformed events individually and sanitises hostile text', async () => {
    const run = await runAdapterOnFixtures(adapter, malformed);
    const ok = run.records.filter((r) => r.upstreamId.startsWith('OK_'));
    expect(ok.map((r) => r.upstreamId).sort()).toEqual(['OK_1', 'OK_2', 'OK_3', 'OK_4']);
    expect(run.records.some((r) => r.upstreamId.startsWith('BAD_'))).toBe(false);
    const reasons = run.rejected.map((r) => r.reason);
    expect(reasons).toContain('no dated geometry');
    expect(reasons.filter((r) => r === 'no dated geometry')).toHaveLength(2); // empty geometry list, unparseable date
    expect(reasons).toContain('missing or invalid coordinates');
    expect(reasons).toContain('unparseable closed date "soon"');
    expect(reasons).toContain('missing category');
    expect(reasons.filter((r) => r === 'missing id or title')).toHaveLength(2);
    expect(reasons.some((r) => r.startsWith('geometry:'))).toBe(true); // degenerate polygon, caught by the normaliser
    expect(run.rejected).toHaveLength(8);

    const hostile = ok.find((r) => r.upstreamId === 'OK_1')!;
    expect(hostile.title).toBe('Wildfire Test Ridge, Somewhere');
    expect(hostile.description).toBe('5 Miles N from Testville');
    expect(hostile.url).toBe('https://eonet.gsfc.nasa.gov/api/v3/events/OK_1'); // javascript: source link ignored

    const dust = ok.find((r) => r.upstreamId === 'OK_3')!;
    expect(dust.layerId).toBe('eonet-other');
    expect(dust.subcategory).toBe('dustHaze');
  });

  it('orders storm fixes by date, splits tracks at the antimeridian and keeps single-fix storms as points', async () => {
    const run = await runAdapterOnFixtures(adapter, malformed);
    const storm = run.records.find((r) => r.upstreamId === 'OK_2')!;
    expect(storm.geometryKind).toBe('track');
    expect(storm.geometry).toEqual({
      type: 'MultiLineString',
      coordinates: [
        [[177.5, -16], [178.4, -16.4], [179.2, -17]],
        [[-179.9, -17.8], [-178.8, -18.9]],
      ],
    });
    expect(storm.attributes).toMatchObject({ peakWindKt: 100, latestWindKt: 90, positionsReported: 5, latestLongitude: -178.8, latestLatitude: -18.9 });
    expect(storm.severity).toBe(4);
    expect(storm.occurredAt).toBe(Date.parse('2026-11-08T18:00:00Z'));
    const single = run.records.find((r) => r.upstreamId === 'OK_4')!;
    expect(single.geometry).toEqual({ type: 'Point', coordinates: [130, 12.5] });
    expect(single.geometryKind).toBe('point');
    expect(single.severity).toBe(1);
    expect(single.provenance.derived).not.toContain('geometry');
  });
});
