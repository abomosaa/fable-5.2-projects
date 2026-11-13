import { describe, expect, it } from 'vitest';
import { FIXTURE_EPOCH } from '../../core/fixtureEpoch.ts';
import { adapterContractSuite, runAdapterOnFixtures } from '../testing.ts';
import adapter, { scheduleConfidence } from './adapter.ts';

adapterContractSuite(adapter, { minRecords: 40 });

describe('launch-library specifics', () => {
  it('makes exactly one request per run (free tier: 15 calls per hour)', async () => {
    const run = await runAdapterOnFixtures(adapter);
    expect(run.requests).toEqual(['https://ll.thespacedevs.com/2.3.0/launches/upcoming/?limit=50&mode=normal']);
    expect(adapter.manifest.updateCadence.pollIntervalSec).toBeGreaterThanOrEqual(3600);
  });

  it('maps a captured launch: pad location, schedule window, status and confidence', async () => {
    const run = await runAdapterOnFixtures(adapter);
    expect(run.rejected).toHaveLength(0);
    expect(run.records).toHaveLength(45);
    const r = run.records.find((x) => x.upstreamId === 'd66590ab-b273-47ff-b85a-608b62851b4b')!;
    expect(r.title).toBe('Long March 2D | Unknown Payload — NET 2026-11-11 11:40 UTC');
    expect(r.point).toEqual([100.298059, 40.960482]);
    expect(r.countries).toEqual(['CHN']);
    // active from the last schedule update until six hours after the window closes
    expect(r.occurredAt).toBe(Date.parse('2026-11-05T06:42:19Z'));
    expect(r.updatedAt).toBe(Date.parse('2026-11-05T06:42:19Z'));
    expect(r.expiresAt).toBe(Date.parse('2026-11-11T18:05:00Z'));
    expect(r.tStart).toBeLessThanOrEqual(FIXTURE_EPOCH);
    expect(r.tEnd).toBe(r.expiresAt);
    expect(r.attributes.netUtc).toBe('2026-11-11T11:40:00.000Z');
    expect(r.attributes.status).toBe('Go for Launch');
    expect(r.attributes.provider).toBe('China Aerospace Science and Technology Corporation');
    expect(r.confidence).toBe(0.9);
    expect(r.confidenceBasis).toContain('Hour');
    expect(r.provenance.derived).toEqual(['confidence']);
    expect(r.url).toBe('https://ll.thespacedevs.com/2.3.0/launches/d66590ab-b273-47ff-b85a-608b62851b4b/');
    expect(r.severity).toBeNull();
  });

  it('never dates a schedule entry in the future', async () => {
    const run = await runAdapterOnFixtures(adapter);
    for (const r of run.records) expect(r.occurredAt!).toBeLessThanOrEqual(FIXTURE_EPOCH);
  });

  it('derives schedule confidence from status and time precision', () => {
    expect(scheduleConfidence('Go', 'MIN')).toBe(0.9);
    expect(scheduleConfidence('Go', 'DAY')).toBe(0.5);
    expect(scheduleConfidence('TBC', 'HR')).toBe(0.6);
    expect(scheduleConfidence('TBD', 'Q4')).toBe(0.2);
    expect(scheduleConfidence('TBD', 'M')).toBe(0.2);
    expect(scheduleConfidence('Mystery', 'MIN')).toBeNull();
    expect(scheduleConfidence(null, 'MIN')).toBeNull();
  });

  it('rejects malformed launches individually, converts time-zone offsets and sanitises text', async () => {
    const run = await runAdapterOnFixtures(adapter, { scenario: [{ source: 'launch-library', fromRun: 1, effect: { variant: 'malformed' } }] });
    expect(run.records.map((r) => r.upstreamId)).toEqual(['11111111-1111-4111-8111-111111111111', '55555555-5555-4555-8555-555555555555']);
    const ok = run.records[0]!;
    expect(ok.attributes.netUtc).toBe('2026-11-12T06:30:00.000Z'); // 08:30+02:00
    expect(ok.title).toBe('Example Rocket | Valid Payload — NET 2026-11-12 06:30 UTC');
    expect(ok.description).toBe('A demonstration payload.');
    expect(ok.countries).toEqual(['FRA']); // the gazetteer has no separate entry for French Guiana; resolved from the coordinates
    const placeholder = run.records[1]!;
    expect(placeholder.point).toEqual([63.342, 45.92]); // numeric strings accepted
    expect(placeholder.confidence).toBe(0.2);
    expect(placeholder.url).toBeNull(); // javascript: link dropped
    expect(placeholder.expiresAt).toBe(Date.parse('2026-12-31T06:00:00Z'));
    const reasons = run.rejected.map((r) => r.reason);
    expect(reasons.filter((r) => r === 'launch pad has no valid coordinates')).toHaveLength(2);
    expect(reasons).toContain('missing or unparseable NET');
    expect(reasons).toContain('missing id or name');
    expect(reasons).toContain('launch is not an object');
    expect(reasons).toHaveLength(5);
  });
});
