import { beforeEach, describe, expect, it } from 'vitest';
import { FIXTURE_EPOCH } from '../../core/fixtureEpoch.ts';
import type { FetchedPayload, HttpGetOptions } from '../../core/types.ts';
import { adapterContractSuite, fixtureEnv, runAdapterOnFixtures } from '../testing.ts';
import adapter, { clearTokenCache, fatalitySeverity, MAX_PAGES, PAGE_SIZE } from './adapter.ts';

beforeEach(() => clearTokenCache());

adapterContractSuite(adapter, { minRecords: 120 });

function payload(key: string, url: string, obj: unknown): FetchedPayload {
  const text = JSON.stringify(obj);
  return { key, url, status: 200, body: Buffer.from(text), contentType: 'application/json', fetchedAt: FIXTURE_EPOCH, etag: null, lastModified: null, notModified: false, fromCache: false, stale: false, text: () => text, json: <T>() => JSON.parse(text) as T };
}

describe('acled specifics', () => {
  it('is opt-in: disabled by default with a restricted, non-commercial licence', () => {
    expect(adapter.manifest.enabledByDefault).toBe(false);
    expect(adapter.manifest.license.redistribution).toBe('restricted');
    expect(adapter.manifest.license.nonCommercialOnly).toBe(true);
    expect(adapter.manifest.license.notes).toContain('dashboard');
  });

  it('authenticates with the documented OAuth password grant and sends the token as a Bearer header', async () => {
    const calls: { url: string; opts: HttpGetOptions }[] = [];
    const env = fixtureEnv(adapter);
    await adapter.fetch({
      env,
      now: FIXTURE_EPOCH,
      signal: new AbortController().signal,
      cursor: { get: () => null, set: () => {} },
      http: {
        get: async (url, opts = {}) => {
          calls.push({ url, opts });
          return url.includes('/oauth/token') ? payload('token', url, { token_type: 'Bearer', expires_in: 86400, access_token: 'TKN-123' }) : payload(opts.key!, url, { status: 200, success: true, data: [] });
        },
      },
    });
    expect(calls).toHaveLength(2);
    const [token, data] = calls as [typeof calls[0], typeof calls[0]];
    expect(token.url).toBe('https://acleddata.com/oauth/token');
    expect(token.opts.method).toBe('POST');
    expect(token.opts.noStore).toBe(true);
    expect(token.opts.headers!['content-type']).toBe('application/x-www-form-urlencoded');
    const form = new URLSearchParams(token.opts.body);
    expect(Object.fromEntries(form)).toEqual({ username: env.ACLED_EMAIL, password: env.ACLED_PASSWORD, grant_type: 'password', client_id: 'acled', scope: 'authenticated' });
    expect(data.opts.headers!.authorization).toBe('Bearer TKN-123');
    expect(data.opts.redact).toEqual(['TKN-123']);
    const u = new URL(data.url);
    expect(u.pathname).toBe('/api/acled/read');
    expect(u.searchParams.get('_format')).toBe('json');
    expect(u.searchParams.get('event_date')).toBe('2026-10-12|2026-11-11');
    expect(u.searchParams.get('event_date_where')).toBe('BETWEEN');
    expect(u.searchParams.get('limit')).toBe(String(PAGE_SIZE));
    expect(u.searchParams.get('page')).toBe('1');
    // credentials never travel in a URL
    for (const c of calls) {
      expect(c.url).not.toContain(env.ACLED_PASSWORD!);
      expect(c.url).not.toContain('TKN-123');
    }
  });

  it('reuses a valid token and pages until a short page (bounded by MAX_PAGES)', async () => {
    const full = { status: 200, success: true, data: Array.from({ length: PAGE_SIZE }, () => ({})) };
    let tokenCalls = 0;
    const pages: string[] = [];
    const ctx = (shortAt: number) => ({
      env: fixtureEnv(adapter),
      now: FIXTURE_EPOCH,
      signal: new AbortController().signal,
      cursor: { get: () => null, set: () => {} },
      http: {
        get: async (url: string, opts: HttpGetOptions = {}) => {
          if (url.includes('/oauth/token')) {
            tokenCalls++;
            return payload('token', url, { access_token: 'T', expires_in: 86400 });
          }
          const page = Number(new URL(url).searchParams.get('page'));
          pages.push(opts.key!);
          return payload(opts.key!, url, page >= shortAt ? { status: 200, success: true, data: [{}] } : full);
        },
      },
    });
    const a = await adapter.fetch(ctx(3));
    expect(a.map((p) => p.key)).toEqual(['page-1', 'page-2', 'page-3']);
    const b = await adapter.fetch(ctx(99));
    expect(b).toHaveLength(MAX_PAGES);
    expect(tokenCalls).toBe(1); // second run reused the cached token
  });

  it('maps a synthetic event: day-precision UTC date, layer, severity from fatalities, confidence from geo precision', async () => {
    const run = await runAdapterOnFixtures(adapter);
    expect(run.rejected).toHaveLength(0);
    expect(run.records).toHaveLength(126);
    expect(new Set(run.records.map((r) => r.layerId))).toEqual(new Set(['acled-violence', 'acled-protests', 'acled-strategic']));
    const worst = run.records.find((r) => r.attributes.reportedFatalities === 61)!;
    expect(worst.layerId).toBe('acled-violence');
    expect(worst.severity).toBe(4);
    expect(worst.severityLabel).toBe('61 reported fatalities (estimate)');
    for (const r of run.records) {
      expect(r.occurredAt! % 86_400_000).toBe(0); // whole UTC day
      expect(r.occurredAt!).toBeLessThan(FIXTURE_EPOCH);
      expect(r.description).toContain('SYNTHETIC FIXTURE');
      expect(r.description!.length).toBeLessThanOrEqual(330);
      expect([0.4, 0.6, 0.8]).toContain(r.confidence);
      expect(r.confidenceBasis).toContain('location precision only');
      expect(r.provenance.derived).toContain('confidence');
      expect(r.countries.length).toBe(1);
    }
  });

  it('derives severity conservatively', () => {
    expect(fatalitySeverity('acled-violence', 0)).toBe(1);
    expect(fatalitySeverity('acled-protests', 0)).toBe(0);
    expect(fatalitySeverity('acled-protests', 1)).toBe(2);
    expect(fatalitySeverity('acled-violence', 10)).toBe(3);
    expect(fatalitySeverity('acled-violence', 50)).toBe(4);
    expect(fatalitySeverity('acled-violence', null)).toBeNull();
  });

  it('rejects malformed events individually and never guesses missing facts', async () => {
    const run = await runAdapterOnFixtures(adapter, { scenario: [{ source: 'acled', fromRun: 1, effect: { variant: 'malformed' } }] });
    expect(run.records.map((r) => r.upstreamId)).toEqual(['FIX40490001', 'FIX72990006']);
    expect(run.records[0]!.description).toBe('ACLED-coded report: [SYNTHETIC FIXTURE] Valid row.');
    const odd = run.records[1]!;
    expect(odd.severity).toBeNull(); // "many" fatalities is not a number
    expect(odd.confidence).toBeNull(); // unknown precision code 7
    expect(odd.updatedAt).toBeNull();
    expect(odd.countries).toEqual(['SDN']);
    const reasons = run.rejected.map((r) => r.reason);
    expect(reasons).toContain('unparseable event_date "08/11/2026"');
    expect(reasons).toContain('unknown event_type "Interpretive dance"');
    expect(reasons.filter((r) => r === 'missing or invalid coordinates')).toHaveLength(2);
    expect(reasons).toContain('missing event_id_cnty');
    expect(reasons).toContain('event is not an object');
    expect(reasons).toHaveLength(6);
  });

  it('treats an upstream error envelope as a failed fetch, not as an empty world', () => {
    expect(() => adapter.parse([payload('page-1', 'x', { status: 403, success: false, message: 'Access denied', data: [] })], { now: FIXTURE_EPOCH, env: {} })).toThrow(/status 403/);
  });
});
