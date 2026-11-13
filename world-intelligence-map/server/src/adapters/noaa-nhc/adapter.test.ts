import { describe, expect, it } from 'vitest';
import { adapterContractSuite, runAdapterOnFixtures } from '../testing.ts';
import adapter from './adapter.ts';

// The live file listed exactly one active storm when the fixture was captured.
adapterContractSuite(adapter, { minRecords: 1 });

const variant = (name: string) => ({ scenario: [{ source: 'noaa-nhc', fromRun: 1, effect: { variant: name } }] });

describe('noaa-nhc specifics', () => {
  it('maps the active storm from the captured file', async () => {
    const run = await runAdapterOnFixtures(adapter);
    expect(run.requests).toEqual(['https://www.nhc.noaa.gov/CurrentStorms.json']);
    expect(run.rejected).toHaveLength(0);
    expect(run.records).toHaveLength(1);
    const r = run.records[0]!;
    expect(r.upstreamId).toBe('cp042026');
    expect(r.layerId).toBe('nhc-active-storms');
    expect(r.title).toBe('Tropical Storm Pena');
    expect(r.subcategory).toBe('tropical storm');
    expect(r.point).toEqual([-164.7, 11.1]);
    expect(r.occurredAt).toBe(Date.parse('2026-11-10T15:00:00Z'));
    expect(r.publishedAt).toBe(Date.parse('2026-11-10T15:00:00Z'));
    expect(r.ongoing).toBe(true);
    expect(r.tEnd).toBe(r.fetchedAt);
    expect(r.severity).toBe(2);
    expect(r.severityLabel).toBe('Tropical Storm (TS), 35 kt');
    expect(r.confidence).toBeNull();
    expect(r.description).toBe('Tropical Storm Pena, maximum sustained winds 35 kt, central pressure 1004 mb, moving toward 260° at 12 mph.');
    expect(r.attributes).toMatchObject({
      stormId: 'cp042026',
      name: 'Pena',
      basin: 'Central Pacific',
      binNumber: 'CP4',
      classification: 'TS',
      intensityKt: 35,
      pressureMb: 1004,
      movementDirDeg: 260,
      movementSpeedMph: 12,
      publicAdvisoryNumber: '016',
      publicAdvisoryUrl: 'https://www.nhc.noaa.gov/text/HFOTCPCP4.shtml',
      forecastDiscussionUrl: 'https://www.nhc.noaa.gov/text/HFOTCDCP4.shtml',
      trackConeKmzUrl: 'https://www.nhc.noaa.gov/storm_graphics/api/CP042026_016adv_CONE.kmz',
    });
    expect(r.attributes.windWatchesWarningsKmzUrl).toBeUndefined(); // null upstream: no watches or warnings in effect
    expect(r.url).toBe('https://www.nhc.noaa.gov/text/HFOTCPCP4.shtml');
    expect(r.provenance.derived).toEqual(['severity']);
    expect(run.output.upstreamTime).toBe(Date.parse('2026-11-10T15:00:00Z'));
  });

  it('yields zero records, without error, when no storm is active', async () => {
    const run = await runAdapterOnFixtures(adapter, variant('empty'));
    expect(run.payloads).toHaveLength(1);
    expect(run.records).toHaveLength(0);
    expect(run.rejected).toHaveLength(0);
  });

  it("parses NHC's published multi-storm example file", async () => {
    const run = await runAdapterOnFixtures(adapter, variant('nhc-sample-2023'));
    expect(run.rejected).toHaveLength(0);
    expect(run.records.map((r) => [r.upstreamId, r.title, r.severity, r.attributes.basin])).toEqual([
      ['al062023', 'Tropical Depression Gert', 1, 'Atlantic'],
      ['al082023', 'Tropical Storm Franklin', 2, 'Atlantic'],
      ['al092023', 'Tropical Depression Nine', 1, 'Atlantic'],
      ['ep092023', 'Post-Tropical Cyclone Hilary', 1, 'Eastern Pacific'],
    ]);
    const hilary = run.records[3]!;
    expect(hilary.point).toEqual([-115.5, 44.6]);
    expect(hilary.occurredAt).toBe(Date.parse('2023-08-21T21:00:00Z'));
    expect(hilary.attributes.forecastTrackKmzUrl).toBeUndefined(); // product objects are null for remnants
  });

  it('derives severity from intensity or classification, rejects broken storms and sanitises hostile text', async () => {
    const run = await runAdapterOnFixtures(adapter, variant('malformed'));
    expect(run.records.map((r) => r.upstreamId)).toEqual(['al112026', 'ep052026']);
    const major = run.records[0]!;
    expect(major.title).toBe('Hurricane Testa');
    expect(major.severity).toBe(4); // 125 kt
    expect(major.severityLabel).toBe('Hurricane (HU), 125 kt');
    expect(major.attributes).toMatchObject({ publicAdvisoryNumber: '042A', windWatchesWarningsKmzUrl: 'https://www.nhc.noaa.gov/storm_graphics/api/AL112026_042Aadv_WW.kmz' });

    const hostile = run.records[1]!;
    expect(hostile.title).toBe('Subtropical Storm Hostile');
    expect(hostile.point).toEqual([-110.25, 15.5]); // parsed from "15.5N" / "110.25W"
    expect(hostile.severity).toBe(2); // no intensity → from the classification
    expect(hostile.severityLabel).toBe('Subtropical Storm (STS)');
    expect(hostile.url).toBe('https://www.nhc.noaa.gov/'); // javascript: advisory link ignored
    expect(hostile.attributes.publicAdvisoryUrl).toBeUndefined();

    const reasons = run.rejected.map((r) => r.reason);
    expect(reasons.filter((r) => r === 'missing or invalid coordinates')).toHaveLength(2);
    expect(reasons).toContain('missing or unparseable lastUpdate');
    expect(reasons).toContain('missing or invalid storm id');
    expect(reasons.filter((r) => r === 'storm is not an object')).toHaveLength(2);
    expect(run.rejected).toHaveLength(6);
  });
});
