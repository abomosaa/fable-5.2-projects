import { describe, expect, it } from 'vitest';
import { FIXTURE_EPOCH } from '../../core/fixtureEpoch.ts';
import { adapterContractSuite, runAdapterOnFixtures } from '../testing.ts';
import adapter, { noaaScale, NOAA_SCALE_SEVERITY, parseSwpcTime } from './adapter.ts';

adapterContractSuite(adapter, { minRecords: 500 });

const malformed = { scenario: [{ source: adapter.manifest.id, fromRun: 1, effect: { variant: 'malformed' } }] };

describe('noaa-swpc aurora forecast', () => {
  it('keeps cells ≥ 10 %, thinned to every second degree, as snapshot points with a probability metric', async () => {
    const run = await runAdapterOnFixtures(adapter);
    expect(run.rejected).toHaveLength(0);
    expect(run.requests).toEqual(['https://services.swpc.noaa.gov/json/ovation_aurora_latest.json', 'https://services.swpc.noaa.gov/products/alerts.json']);
    const cells = run.records.filter((r) => r.layerId === 'aurora-forecast');
    expect(cells).toHaveLength(582);
    expect(cells.filter((r) => r.point![1] > 0)).toHaveLength(307);
    for (const r of cells) {
      expect(r.metric!.value).toBeGreaterThanOrEqual(10);
      expect(r.metric!.unit).toBe('%');
      expect(Math.abs((r.attributes.gridLongitude as number) % 2)).toBe(0);
      expect(Math.abs((r.attributes.gridLatitude as number) % 2)).toBe(0);
      expect(r.occurredAt).toBe(Date.UTC(2026, 10, 10, 23, 52));
      expect(r.severity).toBeNull();
      expect(r.confidence).toBeNull();
    }
    const cell = cells.find((r) => r.upstreamId === 'aurora:58_70')!;
    expect(cell.title).toBe('Aurora probability 21 % at 70°N 58°E');
    expect(cell.point).toEqual([58, 70]);
    expect(cell.metric).toEqual({ name: 'Aurora probability', value: 21, unit: '%' });
    expect(cell.attributes).toMatchObject({ observationTimeUtc: '2026-11-10T23:52:00.000Z', forecastTimeUtc: '2026-11-11T00:35:00.000Z', gridLongitude: 58, gridLatitude: 70 });
    expect(cell.subcategory).toBe('aurora borealis');
    // Upstream longitudes run 0–359: 352°E is 8°W.
    const west = cells.find((r) => r.upstreamId === 'aurora:352_70')!;
    expect(west.point).toEqual([-8, 70]);
    expect(west.title).toBe('Aurora probability 10 % at 70°N 8°W');
    expect(cells.some((r) => r.subcategory === 'aurora australis' && r.point![1] < -50)).toBe(true);
    expect(run.output.upstreamTime).toBe(Date.UTC(2026, 10, 10, 23, 52));
    const layer = adapter.manifest.layers.find((l) => l.id === 'aurora-forecast')!;
    expect(layer.render).toMatchObject({ type: 'heatmap', heatmapBelowZoom: 7 });
    expect(layer.liveMaxAgeSec).toBe(10800);
  });

  it('rejects broken grid cells individually and skips weak or thinned-out cells', async () => {
    const run = await runAdapterOnFixtures(adapter, malformed);
    const cells = run.records.filter((r) => r.layerId === 'aurora-forecast');
    expect(cells.map((r) => [r.upstreamId, r.point, r.metric!.value])).toEqual([
      ['aurora:0_66', [0, 66], 45], // the repeated cell [0, 66, 99] is ignored
      ['aurora:200_68', [-160, 68], 12],
    ]);
    const reasons = run.rejected.map((r) => r.reason);
    expect(reasons.filter((r) => r.startsWith('aurora'))).toEqual([
      'aurora cell has a non-numeric value',
      'aurora cell coordinates out of range',
      'aurora probability outside 0–100',
      'aurora cell is not [longitude, latitude, probability]',
      'aurora cell is not [longitude, latitude, probability]',
      'aurora cell has a non-numeric value',
      'aurora cell coordinates out of range',
    ]);
  });

  it('fails the whole payload when the grid carries no time at all', async () => {
    const run = await runAdapterOnFixtures(adapter);
    const body = JSON.stringify({ coordinates: [[0, 66, 45]], type: 'MultiPoint' });
    expect(() => adapter.parse([{ ...run.payloads[0]!, text: () => body, json: () => JSON.parse(body) }], { now: FIXTURE_EPOCH, env: {} })).toThrow(/no Observation Time/);
  });
});

describe('noaa-swpc space weather alerts', () => {
  it('emits the last 7 days of bulletins as global events with exact fixture values', async () => {
    const run = await runAdapterOnFixtures(adapter);
    const alerts = run.records.filter((r) => r.layerId === 'space-weather-alerts');
    expect(alerts).toHaveLength(21); // 69 messages in the file, 21 issued within 7 days of the epoch
    expect(Math.min(...alerts.map((r) => r.occurredAt!))).toBeGreaterThanOrEqual(FIXTURE_EPOCH - 7 * 86_400_000);
    const k5 = alerts.find((r) => r.upstreamId === 'ALTK05:2062')!;
    expect(k5.title).toBe('ALERT: Geomagnetic K-index of 5');
    expect(k5.geometryKind).toBe('global');
    expect(k5.geometry).toBeNull();
    expect(k5.point).toBeNull();
    expect(k5.countries).toEqual([]);
    // "2026-11-08 02:03:49.380" carries no zone and is UTC.
    expect(k5.occurredAt).toBe(Date.UTC(2026, 10, 8, 2, 3, 49, 380));
    expect(k5.tStart).toBe(k5.occurredAt);
    expect(k5.subcategory).toBe('alert');
    expect(k5.severity).toBe(1);
    expect(k5.severityLabel).toBe('NOAA scale G1 - Minor');
    expect(k5.confidence).toBeNull();
    expect(k5.attributes).toEqual({ productId: 'K05A', messageCode: 'ALTK05', serialNumber: 2062, bulletinType: 'alert', noaaScale: 'G1', validFromUtc: '2026-11-08T02:03:00.000Z' });
    expect(k5.description).toMatch(/^Threshold Reached: 2026 Nov 08 0203 UTC; Synoptic Period: 0000-0300; Active Warning: YES; Noaa Scale: G1 - Minor; Potential Impacts:/);
    expect(k5.description!.length).toBeLessThanOrEqual(500);
    expect(k5.description).not.toMatch(/noaa-scales-explanation/);
    expect(k5.provenance.derived).toEqual(['severity']);
    expect(k5.url).toBe('https://www.spaceweather.gov/products/alerts-watches-and-warnings');

    const warning = alerts.find((r) => r.upstreamId === 'WARK04:5453')!;
    expect(warning.title).toBe('EXTENDED WARNING: Geomagnetic K-index of 4 expected');
    expect(warning.subcategory).toBe('warning');
    expect(warning.severity).toBeNull(); // no NOAA scale level stated
    expect(warning.severityLabel).toBeNull();
    expect(warning.provenance.derived).toEqual([]);
    expect(warning.attributes).toMatchObject({ validFromUtc: '2026-11-09T05:56:00.000Z', validUntilUtc: '2026-11-10T12:00:00.000Z' });

    const watch = alerts.find((r) => r.upstreamId === 'WATA20:1137')!;
    expect(watch.title).toBe('WATCH: Geomagnetic Storm Category G1 Predicted');
    expect(watch.subcategory).toBe('watch');
    expect(watch.severity).toBe(1);
    expect(watch.severityLabel).toBe('NOAA scale G1');
  });

  it('reads NOAA scale levels and message times', () => {
    expect(NOAA_SCALE_SEVERITY).toEqual({ 1: 1, 2: 2, 3: 3, 4: 3, 5: 4 });
    expect(noaaScale('NOAA Scale: G2 - Moderate')).toEqual({ code: 'G2', level: 2, label: 'G2 - Moderate' });
    expect(noaaScale('ALERT: Proton Event\nNOAA Scale: S1 - Minor')).toEqual({ code: 'S1', level: 1, label: 'S1 - Minor' });
    expect(noaaScale('NOAA Scale: R3 - Strong')!.level).toBe(3);
    expect(noaaScale('WATCH: Geomagnetic Storm Category G4 Predicted')).toEqual({ code: 'G4', level: 4, label: 'G4' });
    expect(noaaScale('ALERT: Type II Radio Emission')).toBeNull();
    expect(parseSwpcTime('2026 Nov 09 0556 UTC')).toBe(Date.UTC(2026, 10, 9, 5, 56));
    expect(parseSwpcTime('2026 Foo 09 0556 UTC')).toBeNull();
    expect(parseSwpcTime(null)).toBeNull();
  });

  it('rejects malformed bulletins individually, skips old ones and sanitises hostile text', async () => {
    const run = await runAdapterOnFixtures(adapter, malformed);
    const alerts = run.records.filter((r) => r.layerId === 'space-weather-alerts');
    expect(alerts.map((r) => r.upstreamId).sort()).toEqual(['ALTK07:204', 'ALTXMF:411']);
    const reasons = run.rejected.map((r) => r.reason).filter((r) => !r.startsWith('aurora'));
    expect(reasons.sort()).toEqual([
      'alert is not an object',
      'message has no content after its header',
      'missing message text',
      'missing or unparseable issue_datetime',
      'missing or unparseable issue_datetime',
      'time: event occurredAt is in the future (2026-11-12T09:00:00.000Z)',
    ]);
    const g3 = alerts.find((r) => r.upstreamId === 'ALTK07:204')!;
    expect(g3.severity).toBe(3);
    expect(g3.severityLabel).toBe('NOAA scale G3 - Strong');
    expect(g3.occurredAt).toBe(Date.UTC(2026, 10, 10, 21, 14, 22, 467));
    const hostile = alerts.find((r) => r.upstreamId === 'ALTXMF:411')!;
    expect(hostile.title).toBe('ALERT: X-Ray Flux exceeded M5');
    expect(hostile.severity).toBe(2);
    expect(`${hostile.title} ${hostile.description}`).not.toMatch(/<|onerror|alert\(/);
  });
});
