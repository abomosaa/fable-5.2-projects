import { describe, expect, it } from 'vitest';
import { adapterContractSuite, runAdapterOnFixtures } from '../testing.ts';
import adapter from './adapter.ts';

adapterContractSuite(adapter, { minRecords: 120 });

describe('emsc-earthquakes specifics', () => {
  it('requests M4+ events of the past seven days, newest first', async () => {
    const run = await runAdapterOnFixtures(adapter);
    expect(run.requests).toEqual(['https://www.seismicportal.eu/fdsnws/event/1/query?format=json&minmag=4&orderby=time&limit=1000&start=2026-11-04T00:00:00']);
  });

  it('normalises magnitude, depth, region and UTC times from the captured response', async () => {
    const run = await runAdapterOnFixtures(adapter);
    expect(run.rejected).toHaveLength(0);
    expect(run.records).toHaveLength(138);
    const r = run.records.find((x) => x.upstreamId === '20261109_0000048')!;
    expect(r).toBeTruthy();
    expect(r.title).toBe('M 6.4 – SANTA CRUZ ISLANDS');
    expect(r.point).toEqual([165.5905, -10.8209]);
    expect(r.occurredAt).toBe(Date.parse('2026-11-09T03:34:59.880Z'));
    expect(r.updatedAt).toBe(Date.parse('2026-11-09T07:44:21.336Z'));
    expect(r.tStart).toBe(r.occurredAt);
    expect(r.severity).toBe(3);
    expect(r.severityLabel).toBe('M 6.4 (mw)');
    expect(r.confidence).toBeNull();
    expect(r.confidenceBasis).toBeNull();
    expect(r.subcategory).toBe('earthquake');
    expect(r.attributes).toMatchObject({ magnitude: 6.4, magnitudeType: 'mw', depthKm: 20, contributingAgency: 'EMSC', catalog: 'EMSC-RTS', eventTypeCode: 'ke' });
    expect(r.description).toBe('Earthquake in the Flinn-Engdahl region SANTA CRUZ ISLANDS, depth 20.0 km.');
    expect(r.url).toBe('https://www.seismicportal.eu/eventdetails.html?unid=20261109_0000048');
    expect(r.provenance.derived).toContain('severity');
    expect(run.output.upstreamTime).toBe(Date.parse('2026-11-10T17:55:41.489Z')); // newest lastupdate in the payload
  });

  it('uses the same magnitude thresholds as the USGS layer', async () => {
    const run = await runAdapterOnFixtures(adapter);
    for (const r of run.records) {
      const mag = r.attributes.magnitude as number;
      expect(r.severity).toBe(mag >= 7 ? 4 : mag >= 6 ? 3 : mag >= 5 ? 2 : mag >= 4 ? 1 : 0);
    }
    expect(new Set(run.records.map((r) => r.severity))).toEqual(new Set([1, 2, 3]));
  });

  it('rejects malformed features individually, de-duplicates and sanitises hostile text', async () => {
    const run = await runAdapterOnFixtures(adapter, { scenario: [{ source: 'emsc-earthquakes', fromRun: 1, effect: { variant: 'malformed' } }] });
    expect(run.records.map((r) => r.upstreamId).sort()).toEqual(['ok_0001', 'ok_0002']);
    const reasons = run.rejected.map((r) => r.reason);
    expect(reasons.filter((r) => r === 'missing or invalid coordinates')).toHaveLength(2);
    expect(reasons).toContain('missing or unparseable origin time');
    expect(reasons.filter((r) => r === 'missing id or properties')).toHaveLength(2);
    expect(reasons.some((r) => r.includes('event occurredAt is in the future'))).toBe(true);
    expect(run.rejected).toHaveLength(6);
    const hostile = run.records.find((r) => r.upstreamId === 'ok_0002')!;
    expect(hostile.title).toBe('M 6.1 – FIJI REGION');
    expect(hostile.attributes.region).toBe('FIJI REGION');
    expect(hostile.point).toEqual([-178.5, -17.9]); // 181.5°E wrapped
    expect(hostile.subcategory).toBe('suspected earthquake');
    expect(hostile.severity).toBe(3);
  });
});
