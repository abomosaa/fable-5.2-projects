import { describe, expect, it } from 'vitest';
import { toIso3 } from '../../core/countries.ts';
import { FIXTURE_EPOCH } from '../../core/fixtureEpoch.ts';
import { adapterContractSuite, runAdapterOnFixtures } from '../testing.ts';
import adapter, { BATCH_SIZE, batchUrl, CITIES, cityBatches, GUST_SEVERITY } from './adapter.ts';

adapterContractSuite(adapter, { minRecords: 170 });

const OBSERVED_AT = Date.UTC(2026, 10, 10, 23, 55);

describe('open-meteo-weather specifics', () => {
  it('ships a well-formed, globally spread city list', () => {
    expect(CITIES.length).toBeGreaterThanOrEqual(140);
    expect(CITIES.length).toBeLessThanOrEqual(200);
    expect(new Set(CITIES.map((c) => c.key)).size).toBe(CITIES.length);
    for (const c of CITIES) {
      expect(c.key).toMatch(/^[a-z]{3}-[a-z0-9-]+$/);
      expect(toIso3(c.country), `${c.key} country`).toBeTruthy();
      expect(Math.abs(c.lat)).toBeLessThanOrEqual(90);
      expect(Math.abs(c.lon)).toBeLessThanOrEqual(180);
    }
    expect(new Set(CITIES.map((c) => toIso3(c.country))).size).toBeGreaterThan(80);
    expect(CITIES.filter((c) => c.lat < 0).length).toBeGreaterThan(25);
  });

  it('requests the cities in batches of at most 100 locations, in list order', async () => {
    const run = await runAdapterOnFixtures(adapter);
    const batches = cityBatches();
    expect(batches.every((b) => b.length <= BATCH_SIZE)).toBe(true);
    expect(run.requests).toEqual(batches.map(batchUrl));
    expect(run.requests).toHaveLength(Math.ceil(CITIES.length / 100));
    const first = new URL(run.requests[0]!);
    expect(first.searchParams.get('latitude')!.split(',')).toHaveLength(100);
    expect(first.searchParams.get('longitude')!.split(',')[0]).toBe('69.1813');
    expect(first.searchParams.get('current')).toBe('temperature_2m,apparent_temperature,precipitation,wind_speed_10m,wind_gusts_10m,weather_code');
    expect(first.searchParams.get('timeformat')).toBe('unixtime');
    // 8 polls a day × one call per location stays far below the free tier's 10,000 calls/day.
    expect((86400 / adapter.manifest.updateCadence.pollIntervalSec) * CITIES.length).toBeLessThan(2000);
    expect(adapter.manifest.license.nonCommercialOnly).toBe(true);
  });

  it('emits one temperature record per city with exact fixture values', async () => {
    const run = await runAdapterOnFixtures(adapter);
    expect(run.rejected).toHaveLength(0);
    const temps = run.records.filter((r) => r.layerId === 'weather-temperature');
    expect(temps).toHaveLength(CITIES.length);
    const kabul = temps.find((r) => r.upstreamId === 'weather-temperature:afg-kabul')!;
    expect(kabul.title).toBe('Kabul: 8.6 °C, mainly clear');
    expect(kabul.point).toEqual([69.1813, 34.5186]);
    expect(kabul.countries).toEqual(['AFG']);
    expect(kabul.occurredAt).toBe(OBSERVED_AT);
    expect(kabul.tStart).toBe(OBSERVED_AT);
    expect(kabul.metric).toEqual({ name: 'Air temperature (2 m)', value: 8.6, unit: '°C' });
    expect(kabul.attributes).toMatchObject({ city: 'Kabul', capital: true, apparentTemperatureC: 7.5, windSpeedKmh: 4.2, windGustsKmh: 6.8, weatherCode: 1, weather: 'mainly clear', modelGridElevationM: 1802 });
    expect(kabul.severity).toBeNull();
    expect(kabul.confidence).toBeNull();
    expect(kabul.provenance.derived).toEqual([]);
    // Second batch is mapped with its own offsets (Wellington is city #105).
    const wellington = temps.find((r) => r.upstreamId === 'weather-temperature:nzl-wellington')!;
    expect(wellington.point).toEqual([174.7833, -41.3]);
    expect(wellington.metric!.value).toBe(15.1);
    for (const r of run.records) expect(FIXTURE_EPOCH - r.occurredAt!).toBeLessThanOrEqual(600_000);
  });

  it('puts only wet and windy cities on the precipitation and wind layers and derives wind severity from gusts', async () => {
    const run = await runAdapterOnFixtures(adapter);
    const wet = run.records.filter((r) => r.layerId === 'weather-precipitation');
    expect(wet).toHaveLength(23);
    expect(wet.every((r) => r.metric!.value > 0 && r.metric!.unit === 'mm')).toBe(true);
    const paris = wet.find((r) => r.upstreamId === 'weather-precipitation:fra-paris')!;
    expect(paris.title).toBe('Paris: 0.5 mm precipitation (preceding 15 min), moderate rain');
    expect(paris.metric).toEqual({ name: 'Precipitation', value: 0.5, unit: 'mm', period: 'preceding 15 min' });

    const windy = run.records.filter((r) => r.layerId === 'weather-wind');
    expect(windy.map((r) => r.upstreamId).sort()).toEqual(['weather-wind:chl-punta-arenas', 'weather-wind:col-bogota', 'weather-wind:nzl-wellington', 'weather-wind:prt-lisbon']);
    const punta = windy.find((r) => r.upstreamId === 'weather-wind:chl-punta-arenas')!;
    expect(punta.title).toBe('Punta Arenas: gusts 100.1 km/h, wind 45.8 km/h');
    expect(punta.metric).toEqual({ name: 'Wind gusts (10 m)', value: 100.1, unit: 'km/h' });
    expect(punta.severity).toBe(3);
    expect(punta.severityLabel).toBe('gusts 100.1 km/h');
    expect(punta.provenance.derived).toEqual(['severity']);
    expect(windy.find((r) => r.upstreamId === 'weather-wind:prt-lisbon')!.severity).toBe(1); // 50.4 km/h
    expect(GUST_SEVERITY).toEqual([50, 75, 90, 118]);
    // The same city can be on all three layers with distinct ids.
    expect(run.records.filter((r) => r.attributes.city === 'Punta Arenas').map((r) => r.layerId).sort()).toEqual(['weather-precipitation', 'weather-temperature', 'weather-wind']);
  });

  it('rejects broken locations individually in the malformed variant', async () => {
    const run = await runAdapterOnFixtures(adapter, { scenario: [{ source: adapter.manifest.id, fromRun: 1, effect: { variant: 'malformed' } }] });
    const reasons = run.rejected.map((r) => r.reason);
    expect(reasons.sort()).toEqual([
      'implausible temperature 999 °C',
      'location entry is not an object',
      'missing current block',
      'missing or invalid observation time',
      'no usable current values',
      'observation time is in the future',
      'unexpected unit for temperature_2m',
      'upstream error for location: Latitude must be in range of -90 to 90°. Given: 123.4.',
    ]);
    const temps = run.records.filter((r) => r.layerId === 'weather-temperature');
    expect(temps).toHaveLength(CITIES.length - 8);
    expect(temps.some((r) => r.upstreamId === 'weather-temperature:afg-kabul')).toBe(true);
    expect(run.records.some((r) => /script/i.test(JSON.stringify([r.title, r.metric, r.attributes])))).toBe(false);
  });

  it('refuses a response whose location count does not match the request', async () => {
    const run = await runAdapterOnFixtures(adapter);
    const short = JSON.stringify((run.payloads[0]!.json() as unknown[]).slice(0, 99));
    const payloads = [{ ...run.payloads[0]!, text: () => short, json: () => JSON.parse(short) }, run.payloads[1]!];
    expect(() => adapter.parse(payloads, { now: FIXTURE_EPOCH, env: {} })).toThrow(/99 locations returned for 100 requested/);
    const err = '{"error":true,"reason":"Too many requests"}';
    expect(() => adapter.parse([{ ...run.payloads[0]!, text: () => err, json: () => JSON.parse(err) }], { now: FIXTURE_EPOCH, env: {} })).toThrow(/malformed/);
  });
});
