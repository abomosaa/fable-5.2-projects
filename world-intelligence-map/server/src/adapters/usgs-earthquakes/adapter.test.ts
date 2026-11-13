import { describe, expect, it } from 'vitest';
import { adapterContractSuite, runAdapterOnFixtures } from '../testing.ts';
import adapter from './adapter.ts';

adapterContractSuite(adapter, { minRecords: 80 });

describe('usgs-earthquakes specifics', () => {
  it('normalises magnitude, depth, status and times from the captured feed', async () => {
    const run = await runAdapterOnFixtures(adapter);
    expect(run.rejected).toHaveLength(0);
    const r = run.records.find((x) => x.upstreamId === 'aka2026whmgzn')!;
    expect(r).toBeTruthy();
    expect(r.title).toBe('M 3.0 - 74 km WNW of Petersville, Alaska');
    expect(r.point).toEqual([-152.168, 62.68]);
    expect(r.occurredAt).toBe(1794332547863);
    expect(r.updatedAt).toBe(1794332626680);
    expect(r.tStart).toBe(r.occurredAt);
    expect(r.attributes.depthKm).toBe(0.3);
    expect(r.confidence).toBe(0.7);
    expect(r.confidenceBasis).toContain('automatic');
    expect(r.severity).toBe(0);
    expect(r.countries).toEqual(['USA']);
    expect(r.provenance.derived).toEqual(['confidence', 'country', 'severity']);
    expect(r.url).toBe('https://earthquake.usgs.gov/earthquakes/eventpage/aka2026whmgzn');
  });

  it('de-duplicates events that appear in both feeds', async () => {
    const run = await runAdapterOnFixtures(adapter);
    const ids = run.records.map((r) => r.upstreamId);
    expect(new Set(ids).size).toBe(ids.length);
    const week = (run.payloads[0]!.json() as { features: { id: string }[] }).features.map((f) => f.id);
    const month = (run.payloads[1]!.json() as { features: { id: string }[] }).features.map((f) => f.id);
    expect(week.filter((id) => month.includes(id)).length).toBeGreaterThan(0);
    expect(ids.length).toBe(new Set([...week, ...month]).size);
  });

  it('maps magnitude and PAGER alert onto the severity scale', async () => {
    const run = await runAdapterOnFixtures(adapter);
    for (const r of run.records) {
      const mag = r.attributes.magnitude as number;
      if (mag >= 7) expect(r.severity).toBe(4);
      else if (mag >= 6) expect(r.severity).toBeGreaterThanOrEqual(3);
      else if (mag < 4 && !r.attributes.pagerAlert) expect(r.severity).toBe(0);
    }
  });

  it('rejects malformed features individually and sanitises hostile text', async () => {
    const run = await runAdapterOnFixtures(adapter, { scenario: [{ source: 'usgs-earthquakes', fromRun: 1, effect: { variant: 'malformed' } }] });
    const fromMalformed = run.records.filter((r) => r.upstreamId.startsWith('ok000'));
    expect(fromMalformed.map((r) => r.upstreamId).sort()).toEqual(['ok0001', 'ok0002']);
    const reasons = run.rejected.map((r) => r.reason).join('|');
    expect(reasons).toContain('missing or invalid coordinates');
    expect(reasons).toContain('missing origin time');
    expect(reasons).toContain('missing id or properties');
    expect(reasons).toContain('deleted');
    expect(run.rejected.length).toBe(6);
    const hostile = fromMalformed.find((r) => r.upstreamId === 'ok0002')!;
    expect(hostile.title).toBe('M 2.7 - 5 km NE of Sanitised');
    expect(hostile.description).not.toContain('script');
    expect(hostile.url).toBeNull();
    expect(hostile.point).toEqual([-169.5, -15.2]); // 190.5°E wrapped
    expect(hostile.provenance.normalisation).toContain('dropped non-http(s) source link');
  });
});
