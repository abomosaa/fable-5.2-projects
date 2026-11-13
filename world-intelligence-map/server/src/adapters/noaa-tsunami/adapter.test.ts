import { describe, expect, it } from 'vitest';
import { adapterContractSuite, runAdapterOnFixtures } from '../testing.ts';
import adapter from './adapter.ts';

// Each live feed carries only its centre's latest message.
adapterContractSuite(adapter, { minRecords: 2 });

const variant = (name: string) => ({ scenario: [{ source: 'noaa-tsunami', fromRun: 1, effect: { variant: name } }] });

describe('noaa-tsunami specifics', () => {
  it('reads both warning-centre feeds and maps the captured information statements', async () => {
    const run = await runAdapterOnFixtures(adapter);
    expect(run.requests).toEqual(['https://www.tsunami.gov/events/xml/PAAQAtom.xml', 'https://www.tsunami.gov/events/xml/PHEBAtom.xml']);
    expect(run.rejected).toHaveLength(0);
    expect(run.records.map((r) => r.upstreamId)).toEqual(['PAAQ/to0j1g/WEAK53', 'PHEB/26312050/WECA42']);

    const ntwc = run.records[0]!;
    expect(ntwc.title).toBe('Tsunami Information Statement: 75 miles SW of Eureka, California');
    expect(ntwc.layerId).toBe('tsunami-bulletins');
    expect(ntwc.point).toEqual([-125.484, 40.396]);
    expect(ntwc.occurredAt).toBe(Date.parse('2026-11-05T05:01:47Z'));
    expect(ntwc.updatedAt).toBe(Date.parse('2026-11-05T05:01:47Z'));
    expect(ntwc.tStart).toBe(ntwc.occurredAt);
    expect(ntwc.subcategory).toBe('information');
    expect(ntwc.severity).toBe(0);
    expect(ntwc.severityLabel).toBe('Information');
    expect(ntwc.confidence).toBeNull();
    expect(ntwc.description).toBe(
      'Category: Information. Preliminary magnitude 4.5(Ml). Affected region: 75 miles SW of Eureka, California. Note: There is NO tsunami danger from this earthquake.',
    );
    expect(ntwc.attributes).toMatchObject({
      category: 'Information',
      bulletinType: 'Tsunami Information Statement',
      bulletinNumber: 1,
      warningCentre: 'NWS National Tsunami Warning Center Palmer AK',
      centreCode: 'PAAQ',
      eventCode: 'to0j1g',
      productCode: 'WEAK53',
      preliminaryMagnitude: 4.5,
      magnitudeType: 'Ml',
      affectedRegion: '75 miles SW of Eureka, California',
      bulletinUrl: 'https://www.tsunami.gov/events/PAAQ/2026/11/05/to0j1g/1/WEAK53/WEAK53.txt',
      capUrl: 'https://www.tsunami.gov/events/PAAQ/2026/11/05/to0j1g/1/WEAK53/PAAQCAP.xml',
      entryId: '6d7fa756-1e86-4fe3-841a-e10e7ebb7430',
    });
    expect(ntwc.url).toBe('https://www.tsunami.gov/events/PAAQ/2026/11/05/to0j1g/1/WEAK53/WEAK53.txt');
    expect(ntwc.provenance.derived).toContain('severity');

    const ptwc = run.records[1]!;
    expect(ptwc.title).toBe('TSUNAMI INFORMATION STATEMENT: ABOUT 72 MILES NORTHWEST OF PUERTO RICO');
    expect(ptwc.point).toEqual([-67.794, 19.344]);
    expect(ptwc.occurredAt).toBe(Date.parse('2026-11-08T06:34:57Z'));
    expect(ptwc.attributes).toMatchObject({ centreCode: 'PHEB', warningCentre: 'NWS PACIFIC TSUNAMI WARNING CENTER HONOLULU HI', preliminaryMagnitude: 4.6, bulletinNumber: 1 });
    expect(ptwc.attributes.note).toBeUndefined(); // empty note upstream
    expect(run.output.upstreamTime).toBe(Date.parse('2026-11-08T06:34:57Z'));
  });

  it('maps message categories onto severity, keeps only the latest message per event and de-duplicates across feeds (authored variant)', async () => {
    const run = await runAdapterOnFixtures(adapter, variant('escalated'));
    expect(run.rejected).toHaveLength(0);
    const byId = new Map(run.records.map((r) => [r.upstreamId, r]));
    expect([...byId.keys()].sort()).toEqual(['PAAQ/tst001/WEAK51', 'PAAQ/tst002/WEAK53', 'PAAQ/tst003/WEAK51', 'PHEB/26312999/WEHW40', 'PHEB/26312999/WEPA40']);
    expect(run.records).toHaveLength(5); // 7 entries: one superseded message, one repeated in the second feed

    const warning = byId.get('PAAQ/tst001/WEAK51')!;
    expect(warning.title).toBe('Tsunami Warning: 55 miles SE of Test Bay, Alaska');
    expect(warning.severity).toBe(4);
    expect(warning.severityLabel).toBe('Warning');
    expect(warning.attributes.bulletinNumber).toBe(3); // message 1 (a Watch) of the same event was replaced
    expect(warning.occurredAt).toBe(Date.parse('2026-11-09T10:42:00Z'));
    expect(warning.attributes.preliminaryMagnitude).toBe(8.1);

    expect(byId.get('PAAQ/tst002/WEAK53')!.severity).toBe(3); // Advisory
    expect(byId.get('PAAQ/tst003/WEAK51')!.severity).toBe(2); // Watch
    const threat = byId.get('PHEB/26312999/WEPA40')!;
    expect(threat.severity).toBe(3); // PTWC "Threat"
    expect(threat.title).toBe('TSUNAMI THREAT MESSAGE: NEAR THE COAST OF TESTLAND');
    const cancelled = byId.get('PHEB/26312999/WEHW40')!;
    expect(cancelled.severity).toBe(0);
    expect(cancelled.severityLabel).toBe('Cancellation');
  });

  it('yields zero records without error when neither centre has a current message', async () => {
    const run = await runAdapterOnFixtures(adapter, variant('empty'));
    expect(run.payloads).toHaveLength(2);
    expect(run.records).toHaveLength(0);
    expect(run.rejected).toHaveLength(0);
  });

  it('rejects malformed entries individually and sanitises hostile text', async () => {
    const run = await runAdapterOnFixtures(adapter, variant('malformed'));
    const fromMalformed = run.records.filter((r) => r.upstreamId !== 'PHEB/26312050/WECA42'); // second feed has no malformed variant
    expect(fromMalformed.map((r) => r.upstreamId)).toEqual(['PAAQ/bad001/WEAK53', 'f0000000-0000-4000-8000-000000000007']);

    const hostile = fromMalformed[0]!;
    expect(hostile.title).toBe('Tsunami Advisory: 10 miles N of Hostile Harbor');
    expect(hostile.point).toEqual([-178.75, 51.5]); // 181.25°E wrapped
    expect(hostile.severity).toBe(3);
    expect(JSON.stringify(hostile)).not.toMatch(/onerror|<script|<img/);

    const unknown = fromMalformed[1]!;
    expect(unknown.severity).toBeNull(); // unknown category → no severity, label kept
    expect(unknown.severityLabel).toBe('Seismic Bulletin');
    expect(unknown.provenance.derived).not.toContain('severity');
    expect(unknown.occurredAt).toBe(Date.parse('2026-11-09T11:00:00Z')); // falls back to the entry's updated time
    expect(unknown.url).toBe('https://www.tsunami.gov/'); // javascript: link ignored
    expect(unknown.attributes.preliminaryMagnitude).toBe(6.6);

    const reasons = run.rejected.map((r) => r.reason);
    expect(reasons.filter((r) => r === 'missing or invalid geo:lat / geo:long')).toHaveLength(2);
    expect(reasons).toContain('missing or unparseable bulletin time');
    expect(reasons).toContain('missing entry id');
    expect(reasons).toContain('missing entry title');
    expect(run.rejected).toHaveLength(5);
  });
});
