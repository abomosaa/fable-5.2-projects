import { describe, expect, it } from 'vitest';
import { FIXTURE_EPOCH } from '../../core/fixtureEpoch.ts';
import { DAY } from '../../core/time.ts';
import { adapterContractSuite, runAdapterOnFixtures } from '../testing.ts';
import adapter, { FEED_URL, WINDOW_DAYS } from './adapter.ts';

adapterContractSuite(adapter, { minRecords: 100 });

const malformed = { scenario: [{ source: adapter.manifest.id, fromRun: 1, effect: { variant: 'malformed' } }] };

describe('cisa-kev specifics', () => {
  it('requests the catalog once, without credentials', async () => {
    const run = await runAdapterOnFixtures(adapter);
    expect(run.requests).toEqual([FEED_URL]);
    expect(adapter.manifest.auth.type).toBe('none');
  });

  it('turns a catalog entry into a global bulletin with the exact upstream values', async () => {
    const run = await runAdapterOnFixtures(adapter);
    expect(run.rejected).toHaveLength(0);
    const r = run.records.find((x) => x.upstreamId === 'CVE-2026-102895')!;
    expect(r).toBeTruthy();
    expect(r.id).toBe('cisa-kev:CVE-2026-102895');
    // vendorProject and product are both "GPUStack": the subject is not repeated.
    expect(r.title).toBe('CVE-2026-102895 — GPUStack: GPUStack Improper Authentication Vulnerability');
    expect(r.description).toMatch(/^GPUStack contains an improper authentication vulnerability/);
    expect(r.description!.length).toBeLessThanOrEqual(500);
    expect(r.domain).toBe('cyber');
    expect(r.category).toBe('vulnerability');
    expect(r.subcategory).toBe('exploited');
    expect(r.geometryKind).toBe('global');
    expect(r.geometry).toBeNull();
    expect(r.point).toBeNull();
    expect(r.countries).toEqual([]);
    // dateAdded "2026-11-09" is a calendar date → 00:00 UTC of that day.
    expect(r.occurredAt).toBe(Date.UTC(2026, 10, 9));
    expect(r.tStart).toBe(r.occurredAt);
    expect(r.tEnd).toBe(r.occurredAt);
    expect(r.updatedAt).toBeNull();
    expect(r.severity).toBe(3);
    expect(r.severityLabel).toBe('Known exploited · ransomware campaign use: Unknown');
    expect(r.confidence).toBeNull();
    expect(r.confidenceBasis).toBeNull();
    expect(r.provenance.derived).toEqual(['severity']);
    expect(r.url).toBe('https://nvd.nist.gov/vuln/detail/CVE-2026-102895');
    expect(r.attributes).toMatchObject({
      cveID: 'CVE-2026-102895',
      vendorProject: 'GPUStack',
      product: 'GPUStack',
      vulnerabilityName: 'GPUStack Improper Authentication Vulnerability',
      dateAdded: '2026-11-09',
      dueDate: '2026-11-12',
      knownRansomwareCampaignUse: 'Unknown',
      forensicTriage: 'Yes',
      cwes: 'CWE-287, CWE-290, CWE-346',
    });
    expect(String(r.attributes.requiredAction)).toMatch(/^Apply mitigations in accordance with vendor instructions/);
    // The catalog's own release time is reported as the upstream time (2026-11-09T19:54:37.4945Z).
    expect(Math.abs(run.output.upstreamTime! - Date.UTC(2026, 10, 9, 19, 54, 37, 494))).toBeLessThanOrEqual(1);
  });

  it('derives severity 4 only for known ransomware campaign use, otherwise 3', async () => {
    const run = await runAdapterOnFixtures(adapter);
    const known = run.records.filter((r) => r.attributes.knownRansomwareCampaignUse === 'Known');
    expect(known.map((r) => r.upstreamId)).toEqual(['CVE-2026-59310']);
    const vcenter = known[0]!;
    expect(vcenter.title).toBe('CVE-2026-59310 — Broadcom VMware vCenter: Broadcom VMware vCenter Path Traversal Vulnerability');
    expect(vcenter.severity).toBe(4);
    expect(vcenter.severityLabel).toBe('Known exploited · ransomware campaign use: Known');
    expect(vcenter.subcategory).toBe('ransomware-linked');
    expect(vcenter.occurredAt).toBe(Date.UTC(2026, 7, 18));
    for (const r of run.records) {
      expect(r.severity).toBe(r.attributes.knownRansomwareCampaignUse === 'Known' ? 4 : 3);
      expect(r.provenance.derived).toContain('severity');
    }
  });

  it('keeps only entries added in the last 90 days and skips older ones silently', async () => {
    const run = await runAdapterOnFixtures(adapter);
    const listed = (run.payloads[0]!.json() as { vulnerabilities: { cveID: string; dateAdded: string }[] }).vulnerabilities;
    const cutoff = FIXTURE_EPOCH - WINDOW_DAYS * DAY;
    const expected = listed.filter((v) => Date.parse(`${v.dateAdded}T00:00:00Z`) >= cutoff).map((v) => v.cveID);
    expect(listed.length).toBe(155);
    expect(expected.length).toBe(108);
    expect(run.records.map((r) => r.upstreamId)).toEqual(expected);
    expect(run.rejected).toHaveLength(0);
    expect(Math.min(...run.records.map((r) => r.occurredAt!))).toBeGreaterThanOrEqual(cutoff);
    expect(run.records.some((r) => r.attributes.dateAdded === '2021-11-03')).toBe(false);

    // The window follows the application clock: 80 days later only the November additions are still inside it.
    const later = await runAdapterOnFixtures(adapter, { now: FIXTURE_EPOCH + 80 * DAY });
    expect(later.records).toHaveLength(7);
    expect(later.records.every((r) => String(r.attributes.dateAdded) >= '2026-11-01')).toBe(true);
    expect(later.rejected).toHaveLength(0);
  });

  it('rejects malformed entries individually, tolerates wrong-typed optional fields and sanitises hostile text', async () => {
    const run = await runAdapterOnFixtures(adapter, malformed);
    expect(run.records.map((r) => r.upstreamId)).toEqual(['CVE-2026-90001', 'CVE-2026-90002', 'CVE-2026-90011']);
    expect(run.rejected.map((r) => r.reason)).toEqual([
      'missing or invalid cveID',
      'missing or invalid cveID',
      'unparseable dateAdded "last Tuesday"',
      'unparseable dateAdded "2026-13-45"',
      'dateAdded is in the future',
      'duplicate cveID',
      'missing vulnerabilityName',
      'entry is not an object',
    ]); // the valid 2021 entry is outside the window: skipped, not rejected

    const ok = run.records[0]!;
    expect(ok.title).toBe('CVE-2026-90001 — Example Vendor Example Gateway: Example Vendor Example Gateway Command Injection Vulnerability');
    expect(ok.severity).toBe(4);
    expect(ok.attributes.cwes).toBe('CWE-77, CWE-78');

    const hostile = run.records[1]!;
    expect(hostile.title).toBe('CVE-2026-90002 — Hostile: Hostile Markup Vulnerability');
    expect(hostile.description).toBe('Description with a link and encoded() markup.');
    expect(JSON.stringify(hostile)).not.toMatch(/<script|javascript:|onerror/i);
    expect(hostile.severity).toBe(3);
    expect(hostile.severityLabel).toBe('Known exploited · ransomware campaign use: not stated');
    expect(hostile.attributes.dueDate).toBeUndefined(); // "as soon as possible" is not a date
    expect(hostile.attributes.cwes).toBe('CWE-79'); // non-string / non-CWE entries are dropped
    expect(hostile.url).toBe('https://nvd.nist.gov/vuln/detail/CVE-2026-90002');

    const wrongTypes = run.records[2]!;
    expect(wrongTypes.title).toBe('CVE-2026-90011 — Wrong Types Widget Vulnerability');
    expect(wrongTypes.severity).toBe(3);
    expect(wrongTypes.description).toBeNull();
    expect(wrongTypes.attributes.vendorProject).toBeUndefined();
    expect(wrongTypes.attributes.cwes).toBeUndefined();
    expect(Math.abs(run.output.upstreamTime! - Date.UTC(2026, 10, 10, 15, 2, 11, 123))).toBeLessThanOrEqual(1);
  });

  it('fails the whole run when the catalog envelope is wrong', () => {
    const body = JSON.stringify({ title: 'CISA Catalog of Known Exploited Vulnerabilities', vulnerabilities: 'none' });
    const payload = { key: 'kev', url: FEED_URL, status: 200, body: Buffer.from(body), contentType: 'application/json', fetchedAt: FIXTURE_EPOCH, etag: null, lastModified: null, notModified: false, fromCache: false, stale: false, text: () => body, json: () => JSON.parse(body) };
    expect(() => adapter.parse([payload], { now: FIXTURE_EPOCH, env: {} })).toThrow(/malformed CISA KEV catalog/);
  });
});
