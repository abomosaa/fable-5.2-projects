import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { FIXTURE_EPOCH } from '../../core/fixtureEpoch.ts';
import type { FetchedPayload, HttpGetOptions } from '../../core/types.ts';
import { adapterContractSuite, runAdapterOnFixtures } from '../testing.ts';
import adapter, { STATES_URL, TOKEN_URL } from './adapter.ts';

adapterContractSuite(adapter, { minRecords: 1400 });

function payload(key: string, url: string, text: string, fetchedAt = FIXTURE_EPOCH): FetchedPayload {
  return {
    key, url, status: 200, body: Buffer.from(text), contentType: 'application/json', fetchedAt, etag: null, lastModified: null,
    notModified: false, fromCache: false, stale: false, text: () => text, json: <T>() => JSON.parse(text) as T,
  };
}

/** Records every request the adapter makes, so header / body handling of credentials can be asserted. */
function recordingHttp(opts: { tokenBody?: string; tokenFetchedAt?: number } = {}) {
  const calls: { url: string; opts: HttpGetOptions }[] = [];
  const states = readFileSync(new URL('./fixtures/states_all.json', import.meta.url), 'utf8');
  return {
    calls,
    http: {
      async get(url: string, o: HttpGetOptions = {}): Promise<FetchedPayload> {
        calls.push({ url, opts: o });
        if (url === TOKEN_URL) return payload(o.key ?? url, url, opts.tokenBody ?? '{"access_token":"tok-123","expires_in":1800}', opts.tokenFetchedAt);
        return payload(o.key ?? url, url, states);
      },
    },
  };
}
const ctxBase = { now: FIXTURE_EPOCH, cursor: { get: () => null, set: () => {} }, signal: new AbortController().signal };

describe('opensky specifics', () => {
  it('is disabled by default and declares the restrictive licence honestly', () => {
    const m = adapter.manifest;
    expect(m.enabledByDefault).toBe(false);
    expect(m.license.nonCommercialOnly).toBe(true);
    expect(m.license.redistribution).toBe('restricted');
    expect(m.license.notes).toMatch(/written agreement/);
    expect(m.snapshot).toBe('full');
    expect(m.updateCadence.pollIntervalSec).toBeGreaterThanOrEqual(900); // 96 global queries × 4 credits ≤ 400 anonymous credits/day
    expect(m.auth.envVars.every((v) => !v.required)).toBe(true);
  });

  it('emits one record per airborne aircraft with identifiers as broadcast and SI units untouched', async () => {
    const run = await runAdapterOnFixtures(adapter);
    expect(run.rejected).toHaveLength(0);
    expect(run.records).toHaveLength(1500); // 120 on-ground and 12 position-less vectors are skipped silently
    expect(run.output.upstreamTime).toBe(Date.parse('2026-11-10T23:59:30Z'));

    const r = run.records.find((x) => x.upstreamId === 'f10007')!;
    expect(r.title).toBe('SIM0001'); // callsign is space-padded to 8 characters upstream
    expect(r.layerId).toBe('aircraft');
    expect(r.geometry).toEqual({ type: 'Point', coordinates: [79.1303, 17.0426] });
    expect(r.point).toEqual([79.1303, 17.0426]);
    expect(r.occurredAt).toBe(1794355170_000); // time_position, seconds → milliseconds
    expect(new Date(r.occurredAt!).toISOString()).toBe('2026-11-10T23:59:30.000Z');
    expect(r.tStart).toBe(r.occurredAt);
    expect(r.attributes).toEqual({
      icao24: 'f10007', callsign: 'SIM0001', originCountry: 'Chile', baroAltitudeM: 11400, geoAltitudeM: 11615.81,
      velocityMs: 223.94, headingDeg: 115.56, verticalRateMs: 0, positionSource: 'ADS-B',
    });
    expect(r.severity).toBeNull();
    expect(r.confidence).toBeNull();
    expect(r.url).toBeNull();
    // The overflown country is derived from the position; the address-block registry (Chile) is an attribute only.
    expect(r.countries).toEqual(['IND']);
    expect(r.provenance.derived).toEqual(['country']);

    for (const rec of run.records) {
      expect(rec.occurredAt!).toBeLessThan(FIXTURE_EPOCH);
      expect(rec.occurredAt!).toBeGreaterThanOrEqual(FIXTURE_EPOCH - 600_000);
      expect(Object.keys(rec.attributes).every((k) => !/owner|operator|registration|crew|passenger/i.test(k))).toBe(true);
    }
  });

  it('falls back to last_contact, titles callsign-less aircraft by address and flags emergency squawks', async () => {
    const run = await runAdapterOnFixtures(adapter);
    const noTimePosition = run.records.find((x) => x.upstreamId === 'f1011f')!;
    expect(noTimePosition.occurredAt).toBe(1794355170_000);
    const noCallsign = run.records.find((x) => x.upstreamId === 'f100d9')!;
    expect(noCallsign.title).toBe('ICAO24 f100d9');
    expect(noCallsign.attributes.callsign).toBeUndefined();

    const emergencies = run.records.filter((x) => x.severity != null);
    expect(emergencies.map((x) => [x.upstreamId, x.severity, x.severityLabel]).sort()).toEqual([
      ['f1004d', 3, 'Squawk 7700 – general emergency'],
      ['f10093', 3, 'Squawk 7600 – radio communication failure'],
    ]);
    expect(emergencies[0]!.provenance.derived).toContain('severity');
  });

  it('rejects malformed state vectors individually and skips ground / position-less / duplicate vectors', async () => {
    const run = await runAdapterOnFixtures(adapter, { scenario: [{ source: 'opensky', fromRun: 1, effect: { variant: 'malformed' } }] });
    expect(run.records.map((r) => r.upstreamId).sort()).toEqual(['f1aa01', 'f1aa02', 'f1aa13']);
    const reasons = run.rejected.map((r) => r.reason);
    expect(reasons.filter((r) => r === 'invalid coordinates')).toHaveLength(2); // latitude 95.5; coordinates as strings
    expect(reasons.filter((r) => r === 'missing or invalid icao24 address')).toHaveLength(2);
    expect(reasons.filter((r) => r === 'missing position and contact time')).toHaveLength(1);
    expect(reasons.filter((r) => r === 'state vector is not an array of 17 fields')).toHaveLength(3);
    expect(run.rejected).toHaveLength(8);

    const hostile = run.records.find((r) => r.upstreamId === 'f1aa02')!;
    expect(hostile.title).toBe('X');
    expect(hostile.attributes.callsign).toBe('X');
    const upper = run.records.find((r) => r.upstreamId === 'f1aa13')!;
    expect(upper.title).toBe('ICAO24 f1aa13');
    expect(upper.occurredAt).toBe(1794355163_000);
    expect(upper.severity).toBe(3);
    expect(upper.attributes.positionSource).toBe('code 7');
    expect(run.records.find((r) => r.upstreamId === 'f1aa01')!.title).toBe('SIMOK01'); // first occurrence wins
  });

  it('treats "states": null (nothing in view) as an empty snapshot, not as an error', () => {
    const out = adapter.parse([payload('states', STATES_URL, '{"time":1794355170,"states":null}')], { now: FIXTURE_EPOCH, env: {} });
    expect(out.records).toHaveLength(0);
    expect(out.rejected).toHaveLength(0);
    expect(() => adapter.parse([payload('states', STATES_URL, '{"states":[]}')], { now: FIXTURE_EPOCH, env: {} })).toThrow(/malformed/);
  });

  it('parses 12,000 state vectors quickly', () => {
    const states: unknown[] = [];
    for (let i = 0; i < 12_000; i++) {
      const onGround = i % 11 === 0;
      states.push([(0xf20000 + i).toString(16), `SIM${i}`.padEnd(8), 'Germany', 1794355160 + (i % 10), 1794355170, ((i * 37) % 3600) / 10 - 180, ((i * 17) % 1700) / 10 - 85,
        10000, onGround, 230.5, (i * 7) % 360, 0, null, 10100, i % 2 ? '1000' : null, false, 0]);
    }
    const body = JSON.stringify({ time: 1794355170, states });
    const started = performance.now();
    const out = adapter.parse([payload('states', STATES_URL, body)], { now: FIXTURE_EPOCH, env: {} });
    const ms = performance.now() - started;
    expect(out.rejected).toHaveLength(0);
    expect(out.records).toHaveLength(12_000 - Math.ceil(12_000 / 11));
    expect(ms).toBeLessThan(1000);
  });

  it('makes exactly one anonymous request when no credentials are configured', async () => {
    const run = await runAdapterOnFixtures(adapter, { env: { OPENSKY_CLIENT_ID: undefined, OPENSKY_CLIENT_SECRET: undefined } });
    expect(run.requests).toEqual([STATES_URL]);
    const rec = recordingHttp();
    await adapter.fetch({ ...ctxBase, http: rec.http, env: { OPENSKY_CLIENT_ID: 'only-the-id' } }); // one half of the pair is not enough
    expect(rec.calls).toHaveLength(1);
    expect(rec.calls[0]!.opts.headers).toBeUndefined();
  });

  it('exchanges client credentials for a Bearer token as documented and never exposes them', async () => {
    const rec = recordingHttp();
    const payloads = await adapter.fetch({ ...ctxBase, http: rec.http, env: { OPENSKY_CLIENT_ID: 'my client', OPENSKY_CLIENT_SECRET: 's3cr&t=' } });
    expect(rec.calls.map((c) => c.url)).toEqual([TOKEN_URL, STATES_URL]);
    const token = rec.calls[0]!.opts;
    expect(token.method).toBe('POST');
    expect(token.headers!['content-type']).toBe('application/x-www-form-urlencoded');
    expect(token.body).toBe('grant_type=client_credentials&client_id=my%20client&client_secret=s3cr%26t%3D');
    expect(token.redact).toEqual(['my client', 's3cr&t=']);
    expect(token.cacheTtlSec).toBeLessThan(1800); // tokens expire after 30 minutes
    expect(rec.calls[1]!.opts.headers).toEqual({ authorization: 'Bearer tok-123' });
    // Only the state vectors are handed to the pipeline; URLs carry neither secret nor token.
    expect(payloads.map((p) => p.key)).toEqual(['states']);
    expect(JSON.stringify(payloads.map((p) => p.url))).not.toMatch(/s3cr|tok-123|my client/);
    expect(payloads[0]!.text()).not.toContain('tok-123');

    // Through the real HTTP client and fixtures: token endpoint first, then the states query.
    const run = await runAdapterOnFixtures(adapter);
    expect(run.requests).toEqual([TOKEN_URL, STATES_URL]);
    expect(run.payloads).toHaveLength(1);
  });

  it('fails loudly on an unusable token instead of silently downgrading', async () => {
    const env = { OPENSKY_CLIENT_ID: 'id', OPENSKY_CLIENT_SECRET: 'secret' };
    await expect(adapter.fetch({ ...ctxBase, http: recordingHttp({ tokenBody: '{"error":"invalid_client"}' }).http, env })).rejects.toThrow(/no access_token/);
    await expect(adapter.fetch({ ...ctxBase, http: recordingHttp({ tokenBody: '<html>' }).http, env })).rejects.toThrow(/not valid JSON/);
    // A stale cached token response older than its lifetime must not be sent.
    await expect(adapter.fetch({ ...ctxBase, http: recordingHttp({ tokenFetchedAt: FIXTURE_EPOCH - 1800_000 }).http, env })).rejects.toThrow(/expired/);
  });
});
