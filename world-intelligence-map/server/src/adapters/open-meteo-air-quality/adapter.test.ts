import { describe, expect, it } from 'vitest';
import { toIso3 } from '../../core/countries.ts';
import { FIXTURE_EPOCH } from '../../core/fixtureEpoch.ts';
import { adapterContractSuite, runAdapterOnFixtures } from '../testing.ts';
import adapter, { batchUrl, CITIES, cityBatches, usAqiBand } from './adapter.ts';

adapterContractSuite(adapter, { minRecords: 150 });

const MODEL_TIME = Date.UTC(2026, 10, 10, 23, 50);

describe('open-meteo-air-quality specifics', () => {
  it('ships the city list and requests it in batches of at most 100 locations', async () => {
    expect(new Set(CITIES.map((c) => c.key)).size).toBe(CITIES.length);
    for (const c of CITIES) expect(toIso3(c.country), `${c.key} country`).toBeTruthy();
    const run = await runAdapterOnFixtures(adapter);
    expect(run.requests).toEqual(cityBatches().map(batchUrl));
    const first = new URL(run.requests[0]!);
    expect(first.hostname).toBe('air-quality-api.open-meteo.com');
    expect(first.searchParams.get('latitude')!.split(',')).toHaveLength(100);
    expect(first.searchParams.get('current')).toBe('pm2_5,pm10,nitrogen_dioxide,ozone,us_aqi,european_aqi');
    expect(first.searchParams.get('timeformat')).toBe('unixtime');
    expect((86400 / adapter.manifest.updateCadence.pollIntervalSec) * CITIES.length).toBeLessThan(2000);
  });

  it('emits one modelled record per city with exact fixture values', async () => {
    const run = await runAdapterOnFixtures(adapter);
    expect(run.rejected).toHaveLength(0);
    expect(run.records).toHaveLength(CITIES.length);
    const kabul = run.records.find((r) => r.upstreamId === 'air-quality:afg-kabul')!;
    expect(kabul.title).toBe('Kabul: PM2.5 18.6 µg/m³ · US AQI 65 (Moderate) – modelled');
    expect(kabul.point).toEqual([69.1813, 34.5186]);
    expect(kabul.countries).toEqual(['AFG']);
    expect(kabul.occurredAt).toBe(MODEL_TIME);
    expect(kabul.metric).toEqual({ name: 'PM2.5', value: 18.6, unit: 'µg/m³' });
    expect(kabul.attributes).toMatchObject({ modelled: true, pm10UgM3: 34.1, nitrogenDioxideUgM3: 12.2, ozoneUgM3: 90, usAqi: 65, usAqiCategory: 'Moderate', europeanAqi: 42, modelGridLatitude: 34.5, modelGridLongitude: 69.2, modelTimeStepSec: 3600 });
    expect(kabul.severity).toBe(1);
    expect(kabul.severityLabel).toBe('US AQI 65 (Moderate)');
    expect(kabul.confidence).toBeNull();
    expect(kabul.provenance.derived).toEqual(['severity']);
    expect(kabul.description).toContain('not a station measurement');
    for (const r of run.records) expect(FIXTURE_EPOCH - r.occurredAt!).toBe(600_000);
  });

  it('derives severity from the US AQI bands and tolerates missing secondary pollutants', async () => {
    expect([0, 50, 51, 100, 101, 150, 151, 200, 201, 300, 301, 495].map((v) => usAqiBand(v)!.severity)).toEqual([0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 4, 4]);
    expect(usAqiBand(null)).toBeNull();
    expect(usAqiBand(301)!.category).toBe('Hazardous');
    const run = await runAdapterOnFixtures(adapter);
    const by = (key: string) => run.records.find((r) => r.upstreamId === `air-quality:${key}`)!;
    expect(by('isl-reykjavik').severity).toBe(0); // AQI 36
    expect(by('ind-delhi').severity).toBe(4); // AQI 202
    expect(by('ind-delhi').severityLabel).toBe('US AQI 202 (Very Unhealthy)');
    // Second batch, and a null PM10 in the captured response (attribute simply absent).
    const riyadh = by('sau-riyadh');
    expect(riyadh.metric!.value).toBe(612.8);
    expect(riyadh.severityLabel).toBe('US AQI 495 (Hazardous)');
    expect(riyadh.attributes.pm10UgM3).toBeUndefined();
    const counts = [0, 1, 2, 3, 4].map((s) => run.records.filter((r) => r.severity === s).length);
    expect(counts).toEqual([56, 75, 13, 8, 5]);
  });

  it('states clearly that values are modelled and attributes CAMS', () => {
    const m = adapter.manifest;
    expect(m.confidenceNotes).toMatch(/MODELLED/);
    expect(m.confidenceNotes).toMatch(/not station measurements/);
    expect(m.attribution).toMatch(/CAMS/);
    expect(m.attribution).toMatch(/Copernicus/);
    expect(m.attribution).toMatch(/Open-Meteo/);
    expect(m.license.nonCommercialOnly).toBe(true);
  });

  it('rejects broken locations individually in the malformed variant', async () => {
    const run = await runAdapterOnFixtures(adapter, { scenario: [{ source: adapter.manifest.id, fromRun: 1, effect: { variant: 'malformed' } }] });
    expect(run.rejected.map((r) => r.reason).sort()).toEqual([
      'implausible PM2.5 value -999',
      'location entry is not an object',
      'missing PM2.5 value',
      'missing current block',
      'missing or invalid model time',
      'model time is in the future',
      'unexpected unit for pm2_5',
      'upstream error for location: Latitude must be in range of -90 to 90°. Given: 123.4.',
    ]);
    expect(run.records).toHaveLength(CITIES.length - 8);
    expect(run.records.some((r) => r.upstreamId === 'air-quality:afg-kabul')).toBe(true);
    // A location without any AQI still yields its PM2.5 value, with no severity.
    const noAqi = run.records.find((r) => r.upstreamId === `air-quality:${CITIES[9]!.key}`)!;
    expect(noAqi.severity).toBeNull();
    expect(noAqi.severityLabel).toBeNull();
    expect(noAqi.provenance.derived).toEqual([]);
    expect(noAqi.title).toMatch(/^Vienna: PM2\.5 [\d.]+ µg\/m³ – modelled$/);
  });

  it('refuses a response whose location count does not match the request', async () => {
    const run = await runAdapterOnFixtures(adapter);
    const short = JSON.stringify((run.payloads[1]!.json() as unknown[]).slice(1));
    const payloads = [run.payloads[0]!, { ...run.payloads[1]!, text: () => short, json: () => JSON.parse(short) }];
    expect(() => adapter.parse(payloads, { now: FIXTURE_EPOCH, env: {} })).toThrow(/56 locations returned for 57 requested/);
  });
});
