import { describe, expect, it } from 'vitest';
import { adapterContractSuite, runAdapterOnFixtures } from '../testing.ts';
import adapter, { LAYERS, MIN_MEASUREMENTS, TESTS } from './adapter.ts';

adapterContractSuite(adapter, { minRecords: 1000 });

const DAY = 86_400_000;

describe('ooni specifics', () => {
  it('requests each test once for the last 7 complete UTC days with daily granularity', async () => {
    const run = await runAdapterOnFixtures(adapter);
    expect(run.payloads.map((p) => p.key)).toEqual(Object.keys(TESTS));
    expect(run.requests).toHaveLength(7);
    for (const url of run.requests) {
      expect(url).toContain('since=2026-11-04&until=2026-11-11&time_grain=day&axis_x=probe_cc&axis_y=measurement_start_day');
    }
    expect(run.requests[0]).toBe(
      'https://api.ooni.io/api/v1/aggregation?test_name=web_connectivity&since=2026-11-04&until=2026-11-11&time_grain=day&axis_x=probe_cc&axis_y=measurement_start_day',
    );
    // Mid-day clock: the current (incomplete) day is excluded because `until` is exclusive.
    const midDay = await runAdapterOnFixtures(adapter, { now: Date.UTC(2026, 10, 8, 15, 30) });
    expect(midDay.requests[0]).toContain('since=2026-11-01&until=2026-11-08&');
  });

  it('emits one country-level indicator record per country, UTC day and layer', async () => {
    const run = await runAdapterOnFixtures(adapter);
    expect(run.rejected).toHaveLength(0);
    for (const layer of LAYERS) {
      const recs = run.records.filter((r) => r.layerId === layer.layerId);
      expect(recs.length, layer.layerId).toBeGreaterThan(100);
      const days = [...new Set(recs.map((r) => r.occurredAt!))].sort();
      expect(days).toEqual([4, 5, 6, 7, 8, 9, 10].map((d) => Date.UTC(2026, 10, d)));
      expect(new Set(recs.map((r) => `${r.countries[0]}|${r.occurredAt}`)).size).toBe(recs.length);
    }
    for (const r of run.records) {
      expect(r.geometryKind).toBe('country');
      expect(r.geometry).toBeNull();
      expect(r.countries).toHaveLength(1);
      expect(r.occurredAt! % DAY).toBe(0);
      expect(r.tStart).toBe(r.occurredAt);
      expect(r.metric!.unit).toBe('% of measurements');
      expect(r.metric!.value).toBeGreaterThanOrEqual(0);
      expect(r.metric!.value).toBeLessThanOrEqual(100);
      expect(r.metric!.period).toBe(new Date(r.occurredAt!).toISOString().slice(0, 10));
      expect(r.attributes.measurementCount as number).toBeGreaterThanOrEqual(MIN_MEASUREMENTS);
      // Measurement-derived signal: no severity, no invented confidence, percentage flagged as derived.
      expect(r.severity).toBeNull();
      expect(r.confidence).toBeNull();
      expect(r.provenance.derived).toEqual(['metric']);
    }
  });

  it('computes the web anomaly and confirmed shares from the raw counts (Iran, 2026-11-09)', async () => {
    const run = await runAdapterOnFixtures(adapter);
    const anomalies = run.records.find((r) => r.upstreamId === 'web-anomalies.IR.2026-11-09')!;
    expect(anomalies).toBeTruthy();
    expect(anomalies.layerId).toBe('ooni-web-anomalies');
    expect(anomalies.countries).toEqual(['IRN']);
    expect(anomalies.occurredAt).toBe(Date.UTC(2026, 10, 9, 0, 0, 0));
    expect(anomalies.title).toBe('Anomalous web measurements – Iran (2026-11-09)');
    expect(anomalies.metric).toEqual({ name: 'Anomalous web measurements', value: 15.98, unit: '% of measurements', period: '2026-11-09' });
    expect(anomalies.attributes).toEqual({
      probeCc: 'IR',
      testNames: 'web_connectivity',
      measurementCount: 18571,
      anomalyCount: 2967,
      confirmedCount: 4124,
      failureCount: 912,
      okCount: 10568,
    });
    expect(anomalies.description).toContain('2967 of 18571 OONI Web Connectivity measurements from Iran on 2026-11-09 (UTC) were flagged as anomalies (15.98 %)');
    expect(anomalies.description).toContain('often false positives');
    expect(anomalies.url).toBe(
      'https://explorer.ooni.org/chart/mat?probe_cc=IR&test_name=web_connectivity&since=2026-11-09&until=2026-11-10&time_grain=day&axis_x=measurement_start_day',
    );

    const confirmed = run.records.find((r) => r.upstreamId === 'web-confirmed.IR.2026-11-09')!;
    expect(confirmed.layerId).toBe('ooni-web-confirmed');
    expect(confirmed.title).toBe('Web measurements labelled "confirmed" by OONI – Iran (2026-11-09)');
    expect(confirmed.metric!.value).toBe(22.21); // 4124 / 18571
    expect(confirmed.attributes.confirmedCount).toBe(4124);
  });

  it('pools the messaging and circumvention tests and keeps per-test shares', async () => {
    const run = await runAdapterOnFixtures(adapter);
    const msg = run.records.find((r) => r.upstreamId === 'messaging-anomalies.IR.2026-11-09')!;
    expect(msg.layerId).toBe('ooni-messaging-anomalies');
    expect(msg.title).toBe('Anomalous messaging-app measurements – Iran (2026-11-09)');
    expect(msg.metric!.value).toBe(85.79); // (167 + 185 + 176 + 148) / (197 + 201 + 194 + 196)
    expect(msg.attributes).toMatchObject({
      testNames: 'whatsapp, telegram, signal, facebook_messenger',
      measurementCount: 788,
      anomalyCount: 676,
      whatsappAnomalyPct: 84.77,
      whatsappMeasurementCount: 197,
      telegramAnomalyPct: 92.04,
      signalAnomalyPct: 90.72,
      facebookMessengerAnomalyPct: 75.51,
      facebookMessengerAnomalyCount: 148,
    });
    expect(msg.url).toBe('https://explorer.ooni.org/country/IR');

    const circ = run.records.find((r) => r.upstreamId === 'circumvention-anomalies.IR.2026-11-09')!;
    expect(circ.layerId).toBe('ooni-circumvention-anomalies');
    expect(circ.metric!.value).toBe(41.29); // (36 + 92) / (190 + 120)
    expect(circ.attributes).toMatchObject({ testNames: 'tor, psiphon', torAnomalyPct: 18.95, torMeasurementCount: 190, psiphonAnomalyPct: 76.67, psiphonMeasurementCount: 120 });
  });

  it('skips country-days below the measurement threshold and territories unknown to the gazetteer without rejecting them', async () => {
    const run = await runAdapterOnFixtures(adapter);
    const web = run.payloads[0]!.json() as { result: { probe_cc: string; measurement_count: number; measurement_start_day: string }[] };
    const small = web.result.filter((r) => r.measurement_count < MIN_MEASUREMENTS);
    expect(small.length).toBeGreaterThan(0);
    for (const row of small) expect(run.records.some((r) => r.upstreamId === `web-anomalies.${row.probe_cc}.${row.measurement_start_day}`)).toBe(false);
    // Cuba, 2026-11-09: five messaging measurements in total – far too few for a percentage.
    expect(run.records.some((r) => r.upstreamId === 'messaging-anomalies.CU.2026-11-09')).toBe(false);
    // Guadeloupe (GP) is present upstream but is not a country in the gazetteer.
    expect(web.result.some((r) => r.probe_cc === 'GP' && r.measurement_count >= MIN_MEASUREMENTS)).toBe(true);
    expect(run.records.some((r) => r.attributes.probeCc === 'GP')).toBe(false);
    expect(run.rejected).toHaveLength(0);
  });

  it('rejects malformed rows individually, folds sub-daily buckets into their UTC day and ignores hostile text', async () => {
    const run = await runAdapterOnFixtures(adapter, { scenario: [{ source: adapter.manifest.id, fromRun: 1, effect: { variant: 'malformed' } }] });
    const web = run.records.filter((r) => r.layerId.startsWith('ooni-web-'));
    expect(web.map((r) => r.upstreamId).sort()).toEqual([
      'web-anomalies.IR.2026-11-09',
      'web-anomalies.KE.2026-11-08',
      'web-confirmed.IR.2026-11-09',
      'web-confirmed.KE.2026-11-08',
    ]);
    const kenya = web.find((r) => r.upstreamId === 'web-anomalies.KE.2026-11-08')!;
    expect(kenya.occurredAt).toBe(Date.UTC(2026, 10, 8));
    expect(kenya.attributes.measurementCount).toBe(200); // two hourly rows summed
    expect(kenya.metric!.value).toBe(7.5);
    expect(web.find((r) => r.upstreamId === 'web-confirmed.KE.2026-11-08')!.metric!.value).toBe(0.5);

    const reasons = run.rejected.map((r) => r.reason).sort();
    expect(reasons).toEqual([
      'anomaly_count is not a non-negative integer',
      'anomaly_count is not a non-negative integer',
      'inconsistent counts (parts exceed measurement_count)',
      'measurement day is in the future',
      'measurement_count is not a non-negative integer',
      'missing or invalid probe_cc',
      'missing or invalid probe_cc',
      'row is not an object',
      'row is not an object',
      'unparseable measurement_start_day "2026-13-45"',
      'unparseable measurement_start_day "yesterday"',
    ]);
    for (const r of run.records) expect(JSON.stringify([r.title, r.description, r.attributes])).not.toContain('script');
    // The other six requests were answered normally, so the app layers are unaffected.
    expect(run.records.some((r) => r.layerId === 'ooni-messaging-anomalies')).toBe(true);
  });

  it('treats an API error envelope as a failed run instead of an empty result', async () => {
    await expect(
      runAdapterOnFixtures(adapter, { scenario: [{ source: adapter.manifest.id, fromRun: 1, effect: { status: 200, body: '{"error":"Invalid test_name","v":0}' } }] }),
    ).rejects.toThrow(/malformed OONI aggregation response/);
  });
});
