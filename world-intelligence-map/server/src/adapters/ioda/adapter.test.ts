import { describe, expect, it } from 'vitest';
import { FIXTURE_EPOCH } from '../../core/fixtureEpoch.ts';
import { adapterContractSuite, runAdapterOnFixtures } from '../testing.ts';
import adapter, { confidenceFor, MAX_PAGES, PAGE_LIMIT, severityFor } from './adapter.ts';

adapterContractSuite(adapter, { minRecords: 150 });

/** `until` of the captured request: events whose end equals it were still active when IODA answered. */
const QUERY_UNTIL = 1794333379_000;

describe('ioda specifics', () => {
  it('requests country events of the last 7 days without SARIMA detections', async () => {
    const run = await runAdapterOnFixtures(adapter);
    const until = FIXTURE_EPOCH / 1000;
    expect(run.requests).toEqual([
      `https://api.ioda.inetintel.cc.gatech.edu/v2/outages/events?from=${until - 7 * 86400}&until=${until}&entityType=country&ignoreMethods=*.sarima&limit=2000&page=0`,
    ]);
    expect(run.output.upstreamTime).toBe(Date.UTC(2026, 10, 10, 17, 56, 21));
  });

  it('maps a still-active BGP event to an ongoing country-level interval (Venezuela)', async () => {
    const run = await runAdapterOnFixtures(adapter);
    expect(run.rejected).toHaveLength(0);
    const r = run.records.find((x) => x.upstreamId === 'country-VE.bgp-median.1794318900')!;
    expect(r).toBeTruthy();
    expect(r.id).toBe('ioda:country-VE.bgp-median.1794318900');
    expect(r.layerId).toBe('ioda-outages');
    expect(r.title).toBe('Possible outage signal – Venezuela (BGP)');
    expect(r.geometryKind).toBe('country');
    expect(r.geometry).toBeNull();
    expect(r.countries).toEqual(['VEN']);
    expect(r.point).toBeTruthy(); // drawn at the country label point
    expect(r.occurredAt).toBe(Date.UTC(2026, 10, 10, 13, 55, 0));
    expect(r.tStart).toBe(r.occurredAt);
    expect(r.ongoing).toBe(true);
    expect(r.updatedAt).toBe(QUERY_UNTIL);
    expect(r.tEnd).toBeGreaterThanOrEqual(QUERY_UNTIL);
    expect(r.subcategory).toBe('bgp');
    // score 3305.92 over 241.3 minutes → mean drop 13.7 % → moderate (≥ 10 % for ≥ 30 min)
    expect(r.severity).toBe(2);
    expect(r.severityLabel).toBe('score 3305.9 · mean drop 13.7% · 4 h 1 min so far');
    expect(r.confidence).toBe(0.4);
    expect(r.confidenceBasis).toContain('Only one IODA data source (bgp)');
    expect(r.attributes).toEqual({
      entityCode: 'VE',
      datasource: 'bgp',
      detectionMethod: 'median',
      score: 3305.92,
      durationSec: 14479,
      meanDropPct: 13.7,
      agreeingDatasourceCount: 1,
      agreeingDatasources: 'bgp',
      activeAtQueryTime: true,
      extendsBeyondQueryWindow: true,
    });
    expect(r.description).toContain('starting 2026-11-10 13:55 UTC, still active after 4 h 1 min');
    expect(r.description).toContain('not a confirmed one');
    expect(r.url).toBe('https://ioda.inetintel.cc.gatech.edu/country/VE?from=1794297300&until=1794333379');
    expect(r.provenance.derived).toEqual(['attributes.agreeingDatasourceCount', 'attributes.meanDropPct', 'confidence', 'severity']);
  });

  it('closes finished events at start + duration (Aruba, active probing)', async () => {
    const run = await runAdapterOnFixtures(adapter);
    const r = run.records.find((x) => x.upstreamId === 'country-AW.ping-slash24-median.1793901600')!;
    expect(r.title).toBe('Possible outage signal – Aruba (active probing)');
    expect(r.occurredAt).toBe(Date.UTC(2026, 10, 5, 18, 0, 0));
    expect(r.ongoing).toBe(false);
    expect(r.tEnd).toBe(Date.UTC(2026, 10, 5, 20, 0, 0));
    expect(r.updatedAt).toBeNull();
    expect(r.severity).toBe(3); // 67.7 % mean drop for 2 h
    expect(r.attributes.meanDropPct).toBe(67.7);
    expect(r.attributes.activeAtQueryTime).toBe(false);
    expect(r.url).toBe('https://ioda.inetintel.cc.gatech.edu/country/AW?from=1793880000&until=1793930400');

    const ongoing = run.records.filter((x) => x.ongoing);
    expect(ongoing.map((x) => x.countries[0]).sort()).toEqual(['LAO', 'NAM', 'VEN']); // Gibraltar's is not in the gazetteer
    for (const x of run.records) {
      expect(x.tStart!).toBeLessThan(FIXTURE_EPOCH);
      expect(x.tEnd!).toBeGreaterThanOrEqual(x.tStart!);
      expect(x.title.startsWith('Possible outage signal – ')).toBe(true);
      expect(x.severity).not.toBeNull();
      expect([0.4, 0.65, 0.85]).toContain(x.confidence);
    }
    const sources = new Set(run.records.map((x) => x.attributes.datasource));
    expect([...sources].sort()).toEqual(['bgp', 'merit-nt', 'ping-slash24']);
  });

  it('skips territories that are not in the gazetteer without rejecting them', async () => {
    const run = await runAdapterOnFixtures(adapter);
    const upstream = (run.payloads[0]!.json() as { data: { location: string }[] }).data;
    const unplaced = upstream.filter((e) => ['country/GI', 'country/GP', 'country/RE', 'country/TK'].includes(e.location));
    expect(unplaced.length).toBeGreaterThan(0);
    expect(run.records.length).toBe(upstream.length - unplaced.length);
    expect(run.rejected).toHaveLength(0);
  });

  it('documents its severity and confidence mappings', () => {
    expect(severityFor(null, 600)).toBeNull();
    expect(severityFor(1.9, 600)).toBe(0);
    expect(severityFor(2, 5)).toBe(1);
    expect(severityFor(90, 8)).toBe(1); // large but very short drop (typical telescope blip)
    expect(severityFor(10, 30)).toBe(2);
    expect(severityFor(39.9, 600)).toBe(2);
    expect(severityFor(40, 60)).toBe(3);
    expect(severityFor(95, 179)).toBe(3);
    expect(severityFor(70, 180)).toBe(4);
    expect(confidenceFor(1)).toBe(0.4);
    expect(confidenceFor(2)).toBe(0.65);
    expect(confidenceFor(3)).toBe(0.85);
    expect(confidenceFor(4)).toBe(0.85);
  });

  it('rejects malformed events individually, de-duplicates and raises confidence when data sources agree', async () => {
    const run = await runAdapterOnFixtures(adapter, { scenario: [{ source: 'ioda', fromRun: 1, effect: { variant: 'malformed' } }] });
    expect(run.records.map((r) => r.upstreamId).sort()).toEqual([
      'country-KE.merit-nt-median.1794301200',
      'country-ML.bgp-median.1794252000',
      'country-VE.bgp-median.1793910900',
      'country-VE.ping-slash24-median.1793914500',
    ]);
    const reasons = run.rejected.map((r) => r.reason).sort();
    expect(reasons).toEqual([
      'event is not an object',
      'event is not an object',
      'event start is in the future',
      'missing or invalid datasource',
      'missing or invalid duration',
      'missing or invalid duration',
      'missing or invalid start time',
      'unexpected location "null"',
      'unexpected location "region/4416"',
    ]);

    // Two data sources overlap for Venezuela → both events carry the higher, derived confidence.
    const bgp = run.records.find((r) => r.upstreamId === 'country-VE.bgp-median.1793910900')!;
    const ping = run.records.find((r) => r.upstreamId === 'country-VE.ping-slash24-median.1793914500')!;
    for (const r of [bgp, ping]) {
      expect(r.confidence).toBe(0.65);
      expect(r.confidenceBasis).toContain('2 IODA data sources (bgp, ping-slash24) report overlapping events');
      expect(r.attributes.agreeingDatasources).toBe('bgp, ping-slash24');
    }
    expect(bgp.severity).toBe(0); // 1.0 % mean drop
    expect(bgp.tEnd).toBe((1793910900 + 53400) * 1000);
    expect(ping.severity).toBe(3);

    // Hostile upstream name is never used: the country name comes from the gazetteer.
    const mali = run.records.find((r) => r.upstreamId === 'country-ML.bgp-median.1794252000')!;
    expect(mali.title).toBe('Possible outage signal – Mali (BGP)');
    expect(JSON.stringify(mali)).not.toMatch(/onerror|<script|alert\(/);
    expect(mali.confidence).toBe(0.4);

    // Numeric-string start, no score: still a record, but without a derived severity.
    const kenya = run.records.find((r) => r.upstreamId === 'country-KE.merit-nt-median.1794301200')!;
    expect(kenya.title).toBe('Possible outage signal – Kenya (network telescope)');
    expect(kenya.occurredAt).toBe(1794301200_000);
    expect(kenya.ongoing).toBe(true);
    expect(kenya.severity).toBeNull();
    expect(kenya.severityLabel).toBe('8 h 56 min so far');
    expect(kenya.attributes.meanDropPct).toBeUndefined();
  });

  it('follows pages while they come back full, stops at the page cap and de-duplicates repeated events', async () => {
    const data = Array.from({ length: PAGE_LIMIT }, (_, i) => ({
      location: `country/${['KE', 'NG', 'BR', 'ID'][i % 4]}`,
      start: 1794000000 + i * 60,
      duration: 600,
      method: 'median',
      datasource: 'bgp',
      status: 0,
      score: 50,
      location_name: 'x',
      overlaps_window: false,
    }));
    const body = JSON.stringify({ type: 'outages.events', metadata: {}, requestParameters: { until: '1794333379', limit: PAGE_LIMIT }, error: null, data });
    const run = await runAdapterOnFixtures(adapter, { scenario: [{ source: 'ioda', fromRun: 1, effect: { status: 200, body } }] });
    expect(run.requests).toHaveLength(MAX_PAGES);
    expect(run.requests.map((u) => new URL(u).searchParams.get('page'))).toEqual(['0', '1', '2', '3', '4']);
    expect(run.records).toHaveLength(PAGE_LIMIT);
    expect(run.rejected).toHaveLength(0);
  });

  it('treats an API error envelope as a failed run', async () => {
    const body = JSON.stringify({ type: 'outages.events', error: 'Invalid parameter', data: null });
    await expect(runAdapterOnFixtures(adapter, { scenario: [{ source: 'ioda', fromRun: 1, effect: { status: 200, body } }] })).rejects.toThrow(
      /malformed IODA outage events response/,
    );
  });
});
