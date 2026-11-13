import { describe, expect, it } from 'vitest';
import { FIXTURE_EPOCH } from '../../core/fixtureEpoch.ts';
import type { FetchedPayload, HttpGetOptions } from '../../core/types.ts';
import { adapterContractSuite, runAdapterOnFixtures } from '../testing.ts';
import adapter, { FACILITIES_URL, FIELDS } from './adapter.ts';

adapterContractSuite(adapter, { minRecords: 380 });

/** Run the adapter's fetch() against a recording stub to inspect the exact request (URL + headers). */
async function recordFetch(env: Record<string, string | undefined>): Promise<{ url: string; opts: HttpGetOptions | undefined }[]> {
  const calls: { url: string; opts: HttpGetOptions | undefined }[] = [];
  await adapter.fetch({
    http: {
      get: async (url, opts) => {
        calls.push({ url, opts });
        return { key: opts?.key ?? url, url } as FetchedPayload;
      },
    },
    env,
    now: FIXTURE_EPOCH,
    cursor: { get: () => null, set: () => {} },
    signal: new AbortController().signal,
  });
  return calls;
}

describe('peeringdb specifics', () => {
  // The bundled fixture is synthetic (fictitious facilities, see fixtures/index.json): PeeringDB's AUP does not allow redistributing captured data.
  it('normalises a known facility exactly (coordinates, UTC update time, counts, deep link)', async () => {
    const run = await runAdapterOnFixtures(adapter);
    expect(run.rejected).toHaveLength(0);
    const r = run.records.find((x) => x.upstreamId === '9000001')!;
    expect(r).toBeTruthy();
    expect(r.id).toBe('peeringdb:9000001');
    expect(r.layerId).toBe('data-centers');
    expect(r.domain).toBe('infrastructure');
    expect(r.title).toBe('Fictional Data Centre Frankfurt 1');
    expect(r.description).toBe('Interconnection facility of Example Org 29 in Frankfurt, DE. Registered in PeeringDB as present: 217 networks, 7 internet exchanges, 9 carriers.');
    expect(r.geometryKind).toBe('point');
    expect(r.point).toEqual([8.686047, 50.075503]);
    expect(r.countries).toEqual(['DEU']);
    expect(r.updatedAt).toBe(Date.UTC(2026, 10, 8, 12, 0, 0));
    expect(r.occurredAt).toBeNull();
    expect(r.tStart).toBeNull(); // reference layer: timeless
    expect(r.severity).toBeNull();
    expect(r.confidence).toBeNull();
    expect(r.attributes).toEqual({
      orgName: 'Example Org 29',
      orgId: 990029,
      city: 'Frankfurt',
      state: 'HE',
      countryCode: 'DE',
      regionContinent: 'Europe',
      netCount: 217,
      ixCount: 7,
      carrierCount: 9,
      clli: 'EXMP43',
      registeredAt: '2019-08-11T19:55:57Z',
    });
    expect(r.url).toBe('https://www.peeringdb.com/fac/9000001');
    // Optional fields (aka, campus) are carried when present and omitted when empty.
    const ams = run.records.find((x) => x.upstreamId === '9000011')!;
    expect(ams.title).toBe('Demo Interconnect Amsterdam 4');
    expect(ams.attributes).toMatchObject({ alsoKnownAs: 'EX-A4', campusId: 99028, clli: 'EXMP68', netCount: 11, ixCount: 0, carrierCount: 2 });
    expect(ams.description).toBe('Interconnection facility of Example Org 55 in Amsterdam, NL. Registered in PeeringDB as present: 11 networks, 0 internet exchanges, 2 carriers.');
    expect(r.attributes.alsoKnownAs).toBeUndefined();
    expect(r.attributes.campusId).toBeUndefined();
    expect(r.provenance.derived).toEqual([]); // the country is stated by PeeringDB, not inferred
    expect(run.output.upstreamTime).toBe(Date.UTC(2026, 10, 8, 12, 0, 0)); // newest `updated` in the fixture
  });

  it('covers every continent and silently skips facilities without coordinates', async () => {
    const run = await runAdapterOnFixtures(adapter);
    const rows = (run.payloads[0]!.json() as { data: { id: number; latitude: number | null; longitude: number | null }[] }).data;
    const withCoords = rows.filter((f) => f.latitude != null && f.longitude != null);
    expect(rows.length).toBe(413);
    expect(withCoords.length).toBe(405);
    expect(run.records.length).toBe(405);
    expect(new Set(run.records.map((r) => r.upstreamId))).toEqual(new Set(withCoords.map((f) => String(f.id))));
    const continents = new Set(run.records.map((r) => r.attributes.regionContinent));
    for (const c of ['Europe', 'North America', 'South America', 'Asia Pacific', 'Africa', 'Middle East', 'Australia']) expect(continents).toContain(c);
    expect(new Set(run.records.flatMap((r) => r.countries)).size).toBeGreaterThan(120);
  });

  it('never carries contact or address fields into records', async () => {
    for (const forbidden of ['sales_email', 'sales_phone', 'tech_email', 'tech_phone', 'address1', 'address2', 'zipcode', 'website', 'notes']) {
      expect(FIELDS as readonly string[]).not.toContain(forbidden);
    }
    const run = await runAdapterOnFixtures(adapter);
    expect(run.payloads[0]!.text()).not.toMatch(/_email|_phone|address1|website|https?:|@/);
    // Synthetic fixture: every facility and organisation is visibly fictitious and uses the synthetic id range.
    const rows = (run.payloads[0]!.json() as { data: { id: number; name: string; org_name: string; org_id: number }[] }).data;
    for (const f of rows) {
      expect(f.name).toMatch(/^(Example Colocation|Sample Carrier Hotel|Fictional Data Centre|Demo Interconnect) /);
      expect(f.org_name).toMatch(/^Example Org \d+$/);
      expect(f.id).toBeGreaterThan(9_000_000);
      expect(f.org_id).toBeGreaterThan(990_000);
    }
    for (const r of run.records) {
      const blob = JSON.stringify([r.attributes, r.description, r.title]);
      expect(blob).not.toMatch(/@|mailto:|website|phone"/i);
    }
  });

  it('issues one field-limited request and sends the optional API key only in the Authorization header', async () => {
    const run = await runAdapterOnFixtures(adapter);
    expect(run.requests).toEqual([FACILITIES_URL]);
    expect(FACILITIES_URL).toContain('status=ok&depth=0&fields=id,name,');

    const withKey = await recordFetch({ PEERINGDB_API_KEY: ' s3cret-key ' });
    expect(withKey).toHaveLength(1);
    expect(withKey[0]!.opts?.headers?.authorization).toBe('Api-Key s3cret-key');
    expect(withKey[0]!.url).toBe(FACILITIES_URL);
    expect(withKey[0]!.url).not.toContain('s3cret-key');

    for (const env of [{}, { PEERINGDB_API_KEY: '' }, { PEERINGDB_API_KEY: '   ' }]) {
      const anon = await recordFetch(env);
      expect(anon[0]!.url).toBe(FACILITIES_URL);
      expect(Object.keys(anon[0]!.opts?.headers ?? {})).not.toContain('authorization');
    }
    // The key is optional, so the pipeline must not treat the source as misconfigured without it.
    expect(adapter.manifest.auth.envVars.every((v) => !v.required)).toBe(true);
    const guest = await runAdapterOnFixtures(adapter, { env: { PEERINGDB_API_KEY: undefined } });
    expect(guest.records.length).toBe(405);
  });

  it('rejects malformed facilities individually, skips non-records silently and sanitises hostile text', async () => {
    const run = await runAdapterOnFixtures(adapter, { scenario: [{ source: 'peeringdb', fromRun: 1, effect: { variant: 'malformed' } }] });
    expect(run.records.map((r) => r.upstreamId).sort()).toEqual(['900001', '900002', '900015']);
    const reasons = run.rejected.map((r) => r.reason).sort();
    expect(reasons).toEqual([
      'coordinates out of range', // latitude 123.4
      'coordinates out of range', // longitude 250 (must not be wrapped to -110)
      'facility is not an object', // "not a facility"
      'facility is not an object', // null
      'missing facility name',
      'missing or invalid facility id', // no id
      'missing or invalid facility id', // id "abc"
      'non-numeric coordinates',
      'placeholder coordinates (0, 0)',
    ]);
    // Silently skipped, not rejected: no coordinates (900012), status "deleted" (900013), duplicate row of 900001.
    expect(run.rejected.some((r) => /90001[23]/.test(r.sample ?? ''))).toBe(false);
    expect(run.records.find((r) => r.upstreamId === '900001')!.title).toBe('Example Colo AMS1');

    const hostile = run.records.find((r) => r.upstreamId === '900002')!;
    expect(hostile.title).toBe('Sanitised Carrier Hotel');
    expect(hostile.attributes.orgName).toBe('Hostile Org');
    expect(hostile.description).not.toMatch(/[<>]|onerror|script/);
    expect(hostile.point).toEqual([103.852, 1.2903]); // numeric strings are accepted
    expect(hostile.url).toBe('https://www.peeringdb.com/fac/900002');

    // Unparseable dates and counts are dropped; an unknown country code falls back to a (derived) point-in-polygon lookup.
    const odd = run.records.find((r) => r.upstreamId === '900015')!;
    expect(odd.updatedAt).toBeNull();
    expect(odd.attributes.registeredAt).toBeUndefined();
    expect(odd.attributes.carrierCount).toBeUndefined();
    expect(odd.attributes.netCount).toBe(12);
    expect(odd.countries).toEqual(['KEN']);
    expect(odd.provenance.derived).toEqual(['country']);
  });
});
