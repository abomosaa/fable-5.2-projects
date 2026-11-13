import { describe, expect, it } from 'vitest';
import { adapterContractSuite, runAdapterOnFixtures } from '../testing.ts';
import adapter from './adapter.ts';

adapterContractSuite(adapter, { minRecords: 27 });

describe('gvp-weekly-report specifics', () => {
  it('maps a weekly report item to the report week with a short excerpt and link', async () => {
    const run = await runAdapterOnFixtures(adapter);
    expect(run.rejected).toHaveLength(0);
    expect(run.records).toHaveLength(27);
    const r = run.records.find((x) => x.upstreamId === 'vn_262000:2026-10-08')!;
    expect(r).toBeTruthy();
    expect(r.title).toBe('Krakatau (Indonesia) - Report for 8 October-14 October 2026 - New Eruptive Activity');
    expect(r.layerId).toBe('volcanic-activity');
    expect(r.subcategory).toBe('New Eruptive Activity');
    expect(r.point).toEqual([105.4233, -6.1009]); // georss:point is "lat lon"
    expect(r.countries).toEqual(['IDN']);
    expect(r.provenance.derived).toEqual([]);
    expect(r.occurredAt).toBe(Date.parse('2026-10-08T00:00:00Z'));
    expect(r.tEnd).toBe(Date.parse('2026-10-15T00:00:00Z')); // through 14 October
    expect(r.publishedAt).toBe(Date.parse('2026-10-15T07:11:08Z')); // 03:11:08 -0400
    expect(r.ongoing).toBe(false);
    expect(r.severity).toBeNull();
    expect(r.confidence).toBeNull();
    expect(r.description).toBe(
      'The Pusat Vulkanologi dan Mitigasi Bencana Geologi (PVMBG) reported an increase in low-level eruptive activity at Krakatau starting in early October. ' +
        'During 21 September-9 October seismicity indicating both shallow and deep magmatic processes did not significantly increase. ' +
        'Minor white-to-black ash plumes were occasionally visible in webcam images rising as high as 50 m above the crater, though weather conditions sometimes prevented views.',
    );
    expect(r.attributes).toMatchObject({
      volcanoName: 'Krakatau',
      volcanoNumber: 262000,
      country: 'Indonesia',
      activityStatus: 'New Eruptive Activity',
      reportPeriod: '2026-10-08/2026-10-14',
      reportSources: 'Pusat Vulkanologi dan Mitigasi Bencana Geologi (PVMBG, also known as CVGHM)',
      volcanoUrl: 'https://volcano.si.edu/volcano.cfm?vn=262000',
    });
    expect(r.url).toBe('https://volcano.si.edu/reports_weekly.cfm#vn_262000');
    expect(run.output.upstreamTime).toBe(Date.parse('2026-10-15T08:11:08Z')); // channel pubDate, -0500
  });

  it('never stores more than a 500-character excerpt and keeps short reports whole', async () => {
    const run = await runAdapterOnFixtures(adapter);
    for (const r of run.records) {
      expect(r.description!.length).toBeLessThanOrEqual(500);
      expect(r.description).not.toMatch(/Sources?:/);
      expect(r.attributes.reportSources).toBeTruthy();
    }
    const manam = run.records.find((x) => x.upstreamId === 'vn_251020:2026-10-08')!;
    expect(manam.description).toBe('The Darwin Volcanic Ash Advisory Centre (VAAC) reported that ash plumes from Manam rose to 2.1 km (7,000 ft) a.s.l. and drifted E, NE, N, and NW during 8-9 and 11-13 October.');
    expect(new Set(run.records.map((r) => r.subcategory))).toEqual(new Set(['New Eruptive Activity', 'Continuing Eruptive Activity']));
  });

  it('decodes the ISO-8859-1 feed correctly', async () => {
    const run = await runAdapterOnFixtures(adapter);
    const chillan = run.records.find((x) => x.upstreamId === 'vn_357070:2026-10-08')!;
    expect(chillan.title).toBe('Nevados de Chillan (Chile) - Report for 8 October-14 October 2026 - New Eruptive Activity');
    expect(chillan.description!.startsWith('The Servicio Nacional de Geología y Minería (SERNAGEOMIN) and the Servicio Geológico Minero Argentino (SEGEMAR) reported')).toBe(true);
    expect(chillan.attributes.reportSources).toBe(
      'Servicio Geológico Minero Argentino (SEGEMAR), Servicio Nacional de Geología y Minería (SERNAGEOMIN), Sistema y Servicio Nacional de Prevención y Repuesta Ante Desastres (SENAPRED)',
    );
    expect(chillan.point).toEqual([-71.378, -36.868]);
  });

  it('rejects malformed items individually, de-duplicates and handles unusual titles', async () => {
    const run = await runAdapterOnFixtures(adapter, { scenario: [{ source: 'gvp-weekly-report', fromRun: 1, effect: { variant: 'malformed' } }] });
    expect(run.records.map((r) => r.upstreamId)).toEqual(['vn_341090:2026-10-28', 'yearturn:2026-12-30', 'vn_300270:2026-11-05']);

    const popo = run.records[0]!;
    expect(popo.title).toBe('Popocatépetl (Mexico) - Report for 28 October-3 November 2026 - Continuing Eruptive Activity'); // UTF-8 variant
    expect(popo.description).toBe(
      'The Centro Nacional de Prevención de Desastres (CENAPRED) reported that eruptive activity continued at Popocatépetl during 28 October-3 November. ' +
        'The seismic network recorded 12-55 long-period events per day that were accompanied by steam-and-gas emissions.',
    );
    expect(popo.tStart).toBe(Date.parse('2026-10-28T00:00:00Z'));
    expect(popo.tEnd).toBe(Date.parse('2026-11-04T00:00:00Z'));
    expect(popo.countries).toEqual(['MEX']);

    const yearTurn = run.records[1]!;
    expect(yearTurn.occurredAt).toBe(Date.parse('2026-12-30T00:00:00Z'));
    expect(yearTurn.tEnd).toBe(Date.parse('2027-01-06T00:00:00Z'));
    expect(yearTurn.url).toBe('https://volcano.si.edu/reports_weekly.cfm'); // javascript: links ignored
    expect(yearTurn.attributes.country).toBe('Testland');

    const fallback = run.records[2]!;
    expect(fallback.title).toBe('Unusual title without a report period');
    expect(fallback.occurredAt).toBe(Date.parse('2026-11-05T08:11:08Z')); // publication time
    expect(fallback.subcategory).toBeNull();

    const reasons = run.rejected.map((r) => r.reason);
    expect(reasons.filter((r) => r === 'missing or invalid georss:point')).toHaveLength(2);
    expect(reasons).toContain('no report period in the title and no publication date');
    expect(reasons).toContain('missing title');
    expect(run.rejected).toHaveLength(4);
  });
});
