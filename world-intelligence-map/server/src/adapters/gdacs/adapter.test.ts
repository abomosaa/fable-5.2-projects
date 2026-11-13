import { describe, expect, it } from 'vitest';
import { adapterContractSuite, runAdapterOnFixtures } from '../testing.ts';
import adapter from './adapter.ts';

adapterContractSuite(adapter, { minRecords: 85 });

const malformed = { scenario: [{ source: 'gdacs', fromRun: 1, effect: { variant: 'malformed' } }] };

describe('gdacs specifics', () => {
  it('reads the main RSS feed and the event-list API for the past 14 days, and merges them without duplicates', async () => {
    const run = await runAdapterOnFixtures(adapter);
    expect(run.requests).toEqual([
      'https://www.gdacs.org/xml/rss.xml',
      'https://www.gdacs.org/gdacsapi/api/events/geteventlist/SEARCH?eventlist=TC;FL;VO;DR&fromDate=2026-10-28&toDate=2026-11-11&alertlevel=Green;Orange;Red&pageSize=100&pageNumber=1',
    ]);
    expect(run.rejected).toHaveLength(0);
    expect(run.records).toHaveLength(91); // 69 RSS items + 22 API events that the RSS feed no longer lists
    const byFeed = (feed: string) => run.records.filter((r) => r.attributes.gdacsFeed === feed).length;
    expect(byFeed('rss')).toBe(69);
    expect(byFeed('api')).toBe(22);
    const perLayer = (layer: string) => run.records.filter((r) => r.layerId === layer).length;
    expect(perLayer('gdacs-earthquakes')).toBe(7);
    expect(perLayer('gdacs-wildfires')).toBe(34);
    expect(perLayer('gdacs-cyclones')).toBe(8);
    expect(perLayer('gdacs-volcanoes')).toBe(1);
    expect(run.output.upstreamTime).toBe(Date.parse('2026-11-10T17:55:01Z'));
  });

  it('keeps alert level, alert score and population exposure of an earthquake from the RSS feed', async () => {
    const run = await runAdapterOnFixtures(adapter);
    const r = run.records.find((x) => x.upstreamId === 'EQ1576618')!;
    expect(r.layerId).toBe('gdacs-earthquakes');
    expect(r.title).toBe('Green earthquake (Magnitude 5.6M, Depth:35km) in Guatemala 10/11/2026 14:54 UTC, 570 thousand in MMI IV.');
    expect(r.point).toEqual([-90.8798, 13.5381]);
    expect(r.occurredAt).toBe(Date.parse('2026-11-10T14:54:17Z'));
    expect(r.publishedAt).toBe(Date.parse('2026-11-10T15:15:15Z'));
    expect(r.updatedAt).toBe(Date.parse('2026-11-10T16:59:43Z'));
    expect(r.ongoing).toBe(true);
    expect(r.severity).toBe(1);
    expect(r.severityLabel).toBe('Green');
    expect(r.confidence).toBeNull();
    expect(r.countries).toEqual(['GTM']);
    expect(r.attributes).toMatchObject({
      eventType: 'EQ',
      eventId: 1576618,
      episodeId: 1745789,
      alertLevel: 'Green',
      alertScore: 0,
      episodeAlertScore: 1,
      severityValue: 5.6,
      severityUnit: 'M',
      severityText: 'Magnitude 5.6M, Depth:35km',
      populationExposed: 569238,
      populationExposureBasis: 'in MMI IV',
      populationText: '570 thousand in MMI IV',
      isCurrent: true,
      isTemporary: false,
      capUrl: 'https://www.gdacs.org/contentdata/resources/EQ/1576618/cap_1576618.xml',
    });
    expect(r.attributes.vulnerabilityScore).toBeCloseTo(1.8925, 4);
    expect(r.url).toBe('https://www.gdacs.org/report.aspx?eventtype=EQ&eventid=1576618');
    expect(r.provenance.derived).toEqual(['severity']);
  });

  it('maps Red cyclones from the event-list API to extreme severity and ends events that are no longer current', async () => {
    const run = await runAdapterOnFixtures(adapter);
    const r = run.records.find((x) => x.upstreamId === 'TC1001346')!; // MURASU-26, no longer in the RSS feed
    expect(r.title).toBe('Tropical Cyclone MURASU-26');
    expect(r.attributes.gdacsFeed).toBe('api');
    expect(r.severity).toBe(4);
    expect(r.severityLabel).toBe('Red');
    expect(r.point).toEqual([80.2, 15.8]);
    expect(r.occurredAt).toBe(Date.parse('2026-11-01T00:00:00Z')); // zone-less API timestamps are UTC
    expect(r.ongoing).toBe(false);
    expect(r.tEnd).toBe(Date.parse('2026-11-03T06:00:00Z'));
    expect(r.countries).toEqual(['IND']);
    expect(r.attributes).toMatchObject({ alertScore: 3, severityUnit: 'km/h', severityText: 'Hurricane/Typhoon > 74 mph (maximum wind speed of 157 km/h)', dataSource: 'JTWC', eventName: 'MURASU-26' });
    expect(r.attributes.populationExposed).toBeUndefined(); // the list API has no exposure figures

    const current = run.records.find((x) => x.upstreamId === 'TC1001347')!; // CEMPAKA-26, present in both feeds → RSS wins
    expect(current.attributes.gdacsFeed).toBe('rss');
    expect(current.ongoing).toBe(true);
    expect(current.attributes).toMatchObject({ populationExposed: 613, populationExposureBasis: 'Pop74', vulnerabilityScore: 1 });
    expect(current.point).toEqual([142.1, 26.1]);
  });

  it('uses Green/Orange/Red → 1/3/4 for every record and resolves multi-country droughts', async () => {
    const run = await runAdapterOnFixtures(adapter);
    const expected: Record<string, number> = { Green: 1, Orange: 3, Red: 4 };
    for (const r of run.records) expect(r.severity).toBe(expected[r.severityLabel!]);
    expect(new Set(run.records.map((r) => r.severityLabel))).toEqual(new Set(['Green', 'Orange', 'Red']));
    const drought = run.records.find((x) => x.upstreamId === 'DR1023877')!;
    expect(drought.layerId).toBe('gdacs-droughts');
    expect(drought.occurredAt).toBe(Date.parse('2022-09-21T00:00:00Z'));
    expect(drought.countries).toEqual(expect.arrayContaining(['ABW', 'BRA', 'COL', 'CRI', 'GUY', 'PAN', 'SUR', 'VEN']));
    expect(drought.attributes).toMatchObject({ severityValue: 1552123, severityUnit: 'km2' });
  });

  it('rejects malformed items of both feeds individually and sanitises hostile text', async () => {
    const run = await runAdapterOnFixtures(adapter, malformed);
    expect(run.records.map((r) => r.upstreamId).sort()).toEqual(['EQ9000001', 'FL9000002', 'VO9000010']);
    const reasons = run.rejected.map((r) => r.reason);
    expect(reasons.filter((r) => r === 'missing or invalid coordinates')).toHaveLength(3); // 2 RSS items, 1 API feature
    expect(reasons).toContain('missing or unparseable start date "the day before yesterday"');
    expect(reasons).toContain('unknown alert level "Purple"');
    expect(reasons.filter((r) => r === 'missing event type or id')).toHaveLength(2);
    expect(reasons).toContain('invalid event id "12; DROP TABLE"');
    expect(reasons).toContain('missing title');
    expect(reasons).toContain('feature is not an object');
    expect(run.rejected).toHaveLength(10); // the unsupported "TS" item and the duplicate earthquake are skipped silently

    const quake = run.records.find((r) => r.upstreamId === 'EQ9000001')!;
    expect(quake.severity).toBe(4);
    expect(quake.attributes).toMatchObject({ gdacsFeed: 'rss', isTemporary: true, populationExposed: 2100000 });
    expect(quake.countries).toEqual(['SYR', 'TUR']);

    const flood = run.records.find((r) => r.upstreamId === 'FL9000002')!;
    expect(flood.title).toBe('Orange flood alert in Floodland');
    expect(flood.description).toBe('On 08/11/2026, a flood started in Floodland.');
    expect(flood.point).toEqual([28.3, -15.5]); // georss:point is "lat lon"
    expect(flood.severity).toBe(3);
    expect(flood.url).toBe('https://www.gdacs.org/report.aspx?eventtype=FL&eventid=9000002'); // built from type and id, not from the hostile link
    expect(flood.ongoing).toBe(false);
    expect(flood.tEnd).toBe(Date.parse('2026-11-09T01:00:00Z'));

    const volcano = run.records.find((r) => r.upstreamId === 'VO9000010')!;
    expect(volcano.title).toBe('Eruption Testcano');
    expect(volcano.layerId).toBe('gdacs-volcanoes');
  });
});
