import { describe, expect, it } from 'vitest';
import type { MultiPolygon, Polygon } from 'geojson';
import { FIXTURE_EPOCH } from '../../core/fixtureEpoch.ts';
import { adapterContractSuite, runAdapterOnFixtures } from '../testing.ts';
import adapter, { ringsFromCoords, sigmetSeverity } from './adapter.ts';

adapterContractSuite(adapter, { minRecords: 120 });

describe('aviation-sigmet specifics', () => {
  it('uses the non-deprecated SIGMET endpoint', async () => {
    const run = await runAdapterOnFixtures(adapter);
    expect(run.requests).toEqual(['https://aviationweather.gov/api/data/sigmet?format=json']);
  });

  it('maps a known oceanic thunderstorm SIGMET exactly (polygon, validity in UTC, severity, confidence)', async () => {
    const run = await runAdapterOnFixtures(adapter);
    expect(run.rejected).toHaveLength(0);
    expect(run.records).toHaveLength(134);
    const r = run.records.find((x) => x.upstreamId === 'KKCI:KZWY:TS:HOTEL_7:1794342000')!;
    expect(r).toBeTruthy();
    expect(r.title).toBe('SIGMET HOTEL 7 – Thunderstorms (FRQ) – NEW YORK OCEANIC');
    expect(r.subcategory).toBe('TS');
    expect(r.geometry).toEqual({
      type: 'Polygon',
      coordinates: [[[-52.15, 45.1], [-47.817, 44.833], [-47.717, 36.417], [-55.033, 35.767], [-56.367, 39.417], [-55.833, 44.117], [-52.15, 45.1]]],
    });
    expect(r.occurredAt).toBe(Date.UTC(2026, 10, 10, 20, 20));
    expect(r.expiresAt).toBe(Date.UTC(2026, 10, 11, 0, 20));
    expect(r.tStart).toBe(r.occurredAt);
    expect(r.tEnd).toBe(r.expiresAt);
    expect(r.publishedAt).toBe(Date.parse('2026-11-10T20:13:44.630Z'));
    expect(r.severity).toBe(3);
    expect(r.severityLabel).toBe('FRQ TS');
    expect(r.confidence).toBe(0.9);
    expect(r.confidenceBasis).toBe('SIGMET phenomenon reported as observed (OBS)');
    expect(r.attributes).toMatchObject({ issuingOffice: 'KKCI', firId: 'KZWY', seriesId: 'HOTEL 7', hazard: 'TS', qualifier: 'FRQ', topFt: 42000, movementDirection: 'E', movementSpeedKt: 25, intensityChange: 'NC', validFromUtc: '2026-11-10T20:20:00.000Z', validToUtc: '2026-11-11T00:20:00.000Z' });
    expect(r.attributes.baseFt).toBeUndefined();
    expect(r.description).toMatch(/^WSNT08 KKCI 101420 KZWY SIGMET HOTEL 7 VALID/);
    expect(r.provenance.derived).toEqual(['confidence', 'severity']);
  });

  it('names volcanic ash and tropical cyclone SIGMETs and keeps most of them valid at the epoch', async () => {
    const run = await runAdapterOnFixtures(adapter);
    const va = run.records.find((x) => x.upstreamId === 'SEQU:SEFG:VA:3:1794333480')!;
    expect(va.title).toBe('SIGMET 3 – Volcanic ash (ERUPTION MT REVENTADOR) – SEFG GUAYAQUIL');
    expect(va.severityLabel).toBe('VA ERUPTION MT REVENTADOR');
    expect(va.severity).toBe(3);
    expect(va.attributes).toMatchObject({ baseFt: 0, topFt: 14000, movementDirection: 'W', movementSpeedKt: 15 });
    const tc = run.records.filter((x) => x.subcategory === 'TC');
    expect(tc).toHaveLength(4);
    expect(tc.every((x) => x.severity === 4)).toBe(true);
    expect(new Set(run.records.map((x) => x.subcategory))).toEqual(new Set(['TS', 'CONV', 'TURB', 'ICE', 'MTW', 'VA', 'TC']));
    expect(run.records.filter((x) => x.tStart! <= FIXTURE_EPOCH && x.tEnd! > FIXTURE_EPOCH)).toHaveLength(113);
    expect(run.records.every((x) => x.occurredAt! < FIXTURE_EPOCH)).toBe(true);
    // 12 captured rings are not closed by upstream; the adapter closes them itself, so the normaliser has nothing to repair.
    expect(run.records.filter((x) => x.provenance.normalisation.includes('closed open polygon ring'))).toHaveLength(0);
  });

  it('derives severity from hazard and qualifier as documented', () => {
    expect(sigmetSeverity('TC', 'PENA')).toBe(4);
    expect(sigmetSeverity('VA', 'FUEGO')).toBe(3);
    expect(sigmetSeverity('TURB', 'SEV')).toBe(3);
    expect(sigmetSeverity('ICE', 'SEV')).toBe(3);
    expect(sigmetSeverity('MTW', null)).toBe(2);
    expect(sigmetSeverity('TS', 'FRQ')).toBe(3);
    expect(sigmetSeverity('TS', 'SQL')).toBe(3);
    expect(sigmetSeverity('TS', 'EMBD')).toBe(2);
    expect(sigmetSeverity('TS', '')).toBe(2);
    expect(sigmetSeverity('CONV', '')).toBe(2);
    expect(sigmetSeverity('SS', 'HVY')).toBe(3);
    expect(sigmetSeverity('RDOACT', null)).toBeNull();
    expect(sigmetSeverity(null, 'SEV')).toBeNull();
  });

  it('keeps areas at the antimeridian on the correct side instead of wrapping around the globe', async () => {
    const run = await runAdapterOnFixtures(adapter);
    // Captured "AREAS" SIGMET of the Oakland Oceanic FIR: one part west of 180°, one part east of it (upstream longitudes 180…193.5).
    const kzak = run.records.find((x) => x.upstreamId === 'PHFO:KZAK:TS:NOVEMBER_3:1794348300')!;
    expect(kzak.geometry!.type).toBe('MultiPolygon');
    const parts = (kzak.geometry as MultiPolygon).coordinates.map((poly) => poly[0]!.map((p) => p[0]!));
    expect(parts).toHaveLength(2);
    expect(Math.min(...parts[0]!)).toBe(178.75);
    expect(Math.max(...parts[0]!)).toBe(180);
    expect(Math.min(...parts[1]!)).toBe(-180);
    expect(Math.max(...parts[1]!)).toBe(-166.5);
    for (const r of run.records) {
      const polys = r.geometry!.type === 'Polygon' ? [(r.geometry as Polygon).coordinates] : (r.geometry as MultiPolygon).coordinates;
      for (const poly of polys) {
        const lons = poly[0]!.map((p) => p[0]!);
        expect(Math.max(...lons) - Math.min(...lons), r.upstreamId).toBeLessThan(180);
      }
    }
    // An unsplit ring written as 178 … -178 is split at 180°.
    expect(ringsFromCoords([{ lon: 178, lat: -10 }, { lon: -178, lat: -10 }, { lon: -178, lat: -12 }, { lon: 178, lat: -12 }])).toEqual([
      [[178, -10], [180, -10], [180, -12], [178, -12], [178, -10]],
      [[-180, -10], [-178, -10], [-178, -12], [-180, -12], [-180, -10]],
    ]);
    expect(ringsFromCoords([{ lon: 10, lat: 1 }, { lon: 11, lat: 1 }])).toBe('no usable geometry (fewer than 3 distinct positions)');
  });

  it('rejects malformed SIGMETs individually with a reason and sanitises hostile text', async () => {
    const run = await runAdapterOnFixtures(adapter, { scenario: [{ source: adapter.manifest.id, fromRun: 1, effect: { variant: 'malformed' } }] });
    expect(run.records.map((r) => r.upstreamId).sort()).toEqual(['EGRR:EGTT:TURB:01:1794348000', 'NFFN:NFFF:TS:A_2:1794346200', 'SBAZ:SBAZ:TS:9:1794347100']);
    expect(run.rejected.map((r) => r.reason).sort()).toEqual([
      'coordinate out of range (140, -123.4)',
      'invalid validity period (end not after start)',
      'item is not an object',
      'item is not an object',
      'missing validity period',
      'no usable geometry (coords missing)',
      'no usable geometry (coords missing)',
      'no usable geometry (fewer than 3 distinct positions)',
      'no usable geometry (non-numeric coordinate)',
    ]);
    const ok = run.records.find((r) => r.upstreamId === 'EGRR:EGTT:TURB:01:1794348000')!;
    expect(ok.occurredAt).toBe(Date.UTC(2026, 10, 10, 22, 0));
    expect(ok.expiresAt).toBe(Date.UTC(2026, 10, 11, 2, 0));
    expect(ok.severityLabel).toBe('SEV TURB');
    expect(ok.confidence).toBe(0.7);
    const fiji = run.records.find((r) => r.upstreamId === 'NFFN:NFFF:TS:A_2:1794346200')!;
    expect(fiji.geometry!.type).toBe('MultiPolygon');
    expect(fiji.title).toBe('SIGMET A 2 – Thunderstorms (EMBD) – NADI');
    expect(fiji.description).not.toMatch(/<|onerror/);
    expect(fiji.attributes.movementDirection).toBeUndefined();
    expect(fiji.attributes.movementSpeedKt).toBeUndefined();
    const line = run.records.find((r) => r.upstreamId === 'SBAZ:SBAZ:TS:9:1794347100')!;
    expect(line.geometry).toEqual({ type: 'LineString', coordinates: [[-60, -3], [-58, -5], [-55, -6]] });
    expect(line.confidence).toBeNull(); // no OBS/FCST flag
    expect(line.provenance.derived).toEqual(['severity']);
  });
});
