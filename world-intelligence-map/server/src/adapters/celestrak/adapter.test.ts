import { describe, expect, it } from 'vitest';
import { FIXTURE_EPOCH } from '../../core/fixtureEpoch.ts';
import { adapterContractSuite, runAdapterOnFixtures } from '../testing.ts';
import adapter, { ageConfidence, BACKOFF_MS, GROUPS } from './adapter.ts';

adapterContractSuite(adapter, { minRecords: 100 });

describe('celestrak specifics', () => {
  it('requests each group once and maps it to its own layer', async () => {
    const run = await runAdapterOnFixtures(adapter);
    expect(run.payloads.map((p) => p.key)).toEqual(Object.keys(GROUPS));
    expect(run.rejected).toHaveLength(0);
    for (const layerId of Object.values(GROUPS)) expect(run.records.filter((r) => r.layerId === layerId).length).toBeGreaterThan(10);
  });

  it('computes a plausible ISS position at the pinned clock and labels it as computed', async () => {
    const run = await runAdapterOnFixtures(adapter);
    const iss = run.records.find((r) => r.title === 'ISS (ZARYA)')!;
    expect(iss).toBeTruthy();
    expect(iss.layerId).toBe('sat-stations');
    expect(iss.geometry?.type).toBe('Point');
    expect(Math.abs(iss.point![1])).toBeLessThanOrEqual(51.7); // ISS inclination 51.6°
    expect(iss.attributes.altitudeKm as number).toBeGreaterThan(395);
    expect(iss.attributes.altitudeKm as number).toBeLessThan(440); // geodetic height peaks at high latitudes
    expect(iss.attributes.speedKmS as number).toBeGreaterThan(7.5);
    expect(iss.attributes.speedKmS as number).toBeLessThan(7.8);
    expect(iss.attributes.orbitClass).toBe('LEO');
    expect(iss.occurredAt).toBe(FIXTURE_EPOCH);
    expect(iss.updatedAt).toBe(Date.parse('2026-11-10T04:12:02.823Z')); // element epoch 04:12:02.822688 UTC, rounded to ms
    expect(iss.provenance.derived).toContain('geometry');
    expect(iss.confidence).toBe(0.9);
    expect(iss.confidenceBasis).toContain('SGP4');
    // deterministic for a pinned clock
    const again = await runAdapterOnFixtures(adapter);
    expect(again.records.find((r) => r.title === 'ISS (ZARYA)')!.point).toEqual(iss.point);
  });

  it('moves the satellite when the clock advances', async () => {
    const a = (await runAdapterOnFixtures(adapter)).records.find((r) => r.title === 'ISS (ZARYA)')!;
    const b = (await runAdapterOnFixtures(adapter, { now: FIXTURE_EPOCH + 120_000 })).records.find((r) => r.title === 'ISS (ZARYA)')!;
    expect(b.id).toBe(a.id);
    expect(b.point).not.toEqual(a.point);
    // two minutes at ~7.66 km/s ≈ 900 km of ground track ≈ under 10° of longitude at these latitudes
    expect(Math.abs(b.point![1] - a.point![1])).toBeLessThan(8);
  });

  it('places geostationary weather satellites near the equator at GEO altitude', async () => {
    const run = await runAdapterOnFixtures(adapter);
    // (the GNSS group also holds inclined geosynchronous satellites, so only the weather layer is checked)
    const geo = run.records.filter((r) => r.layerId === 'sat-weather' && r.attributes.orbitClass === 'GEO');
    expect(geo.length).toBeGreaterThan(0);
    for (const r of geo) {
      expect(Math.abs(r.point![1])).toBeLessThan(16);
      expect(r.attributes.altitudeKm as number).toBeGreaterThan(35_000);
      expect(r.attributes.altitudeKm as number).toBeLessThan(36_600);
    }
  });

  it('lowers confidence as element sets age', () => {
    expect([1, 5, 10, 20].map(ageConfidence)).toEqual([0.9, 0.7, 0.5, 0.3]);
  });

  it('rejects malformed element sets individually', async () => {
    const run = await runAdapterOnFixtures(adapter, { scenario: [{ source: 'celestrak', fromRun: 1, effect: { variant: 'malformed' } }] });
    const stations = run.records.filter((r) => r.layerId === 'sat-stations');
    expect(stations.map((r) => r.title).sort()).toEqual(['HOSTILE SAT', 'ISS (ZARYA)']);
    const reasons = run.rejected.map((r) => r.reason).join('|');
    expect(reasons).toContain('missing or unparseable EPOCH');
    expect(reasons).toContain('older than 30 days');
    expect(reasons).toContain('orbital elements out of range');
    expect(reasons).toContain('missing orbital elements');
    expect(reasons).toContain('missing NORAD_CAT_ID');
    expect(reasons).toContain('element set is not an object');
    expect(run.rejected).toHaveLength(6);
  });

  it('honours the usage policy: after an upstream error it stops requesting and works from cached elements', async () => {
    const cursor = new Map<string, string>();
    await expect(runAdapterOnFixtures(adapter, { cursor, scenario: [{ source: 'celestrak', fromRun: 1, effect: { status: 403 } }] })).rejects.toThrow();
    expect(Number(cursor.get('blockedUntil'))).toBe(FIXTURE_EPOCH + BACKOFF_MS);
    // while backing off with nothing cached, no request is attempted at all
    await expect(runAdapterOnFixtures(adapter, { cursor, now: FIXTURE_EPOCH + 60_000 })).rejects.toThrow(/back-off/);
  });
});
