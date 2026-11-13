import { describe, expect, it } from 'vitest';
import { ManualClock } from '../core/clock.ts';
import { ok, ScriptedTransport, status, T0 } from '../test/helpers.ts';
import { AuthError, CircuitBreaker, CircuitOpenError, DisallowedHostError, HttpError, MemoryHttpCache, parseRetryAfter, RateLimitedError, redactUrl, ResilientHttp, TimeoutError, type HttpEvent } from './client.ts';

const SRC = { id: 'src', allowedHosts: ['api.example.org'], http: {} };
const URL_ = 'https://api.example.org/data';

function setup(policy: Record<string, number> = {}, manifestHttp: Record<string, number> = {}) {
  const net = new ScriptedTransport();
  const clock = new ManualClock(T0);
  const sleeps: number[] = [];
  const events: HttpEvent[] = [];
  const cache = new MemoryHttpCache();
  const http = new ResilientHttp({
    transport: net.transport, clock, cache, random: () => 0.5, onEvent: (e) => events.push(e),
    sleep: async (ms) => void sleeps.push(ms),
    policy: { minIntervalMs: 0, timeoutMs: 100, maxRetries: 2, backoffBaseMs: 400, backoffCapMs: 8000, ...policy },
  });
  const client = http.forSource({ ...SRC, http: manifestHttp });
  return { net, clock, sleeps, events, http, client, cache };
}

describe('host allowlist', () => {
  it('refuses hosts that are not on the source allowlist, before any network activity', async () => {
    const { client, net } = setup();
    await expect(client.get('https://evil.example.com/x')).rejects.toBeInstanceOf(DisallowedHostError);
    await expect(client.get('https://api.example.org.evil.com/x')).rejects.toBeInstanceOf(DisallowedHostError);
    await expect(client.get('file:///etc/passwd')).rejects.toBeInstanceOf(DisallowedHostError);
    await expect(client.get('not a url')).rejects.toThrow('invalid URL');
    expect(net.calls).toHaveLength(0);
  });
});

describe('retries', () => {
  it('retries 5xx with exponential backoff and jitter, then succeeds', async () => {
    const { client, net, sleeps } = setup();
    net.on('api.example.org', (_r, n) => (n < 3 ? status(503) : ok({ fine: true })));
    const res = await client.get(URL_);
    expect(res.json()).toEqual({ fine: true });
    expect(net.count('api.example.org')).toBe(3);
    // full jitter with random()=0.5: half of base·2^attempt
    expect(sleeps).toEqual([200, 400]);
  });

  it('retries network errors and gives up after maxRetries', async () => {
    const { client, net, sleeps } = setup();
    net.on('api.example.org', () => 'network');
    await expect(client.get(URL_)).rejects.toThrow(/network error/);
    expect(net.count('api.example.org')).toBe(3);
    expect(sleeps).toHaveLength(2);
  });

  it('does not retry client errors', async () => {
    const { client, net } = setup();
    net.on('api.example.org', () => status(404));
    await expect(client.get(URL_)).rejects.toBeInstanceOf(HttpError);
    expect(net.count('api.example.org')).toBe(1);
  });

  it('treats 401/403 as a credential problem: no retry, no stale fallback', async () => {
    const { client, net, clock } = setup();
    net.on('api.example.org', (_r, n) => (n === 1 ? ok({ v: 1 }) : status(403)));
    await client.get(URL_);
    clock.advance(1000);
    await expect(client.get(URL_)).rejects.toBeInstanceOf(AuthError);
    expect(net.count('api.example.org')).toBe(2);
  });
});

describe('timeouts', () => {
  it('aborts a hanging request after the timeout and reports a TimeoutError', async () => {
    const { client, net } = setup({ maxRetries: 0, timeoutMs: 40 });
    net.on('api.example.org', () => 'hang');
    const t0 = Date.now();
    await expect(client.get(URL_)).rejects.toBeInstanceOf(TimeoutError);
    expect(Date.now() - t0).toBeLessThan(1000);
    expect(net.calls[0]!.signal.aborted).toBe(true);
  });
});

describe('rate limiting', () => {
  it('honours a short Retry-After in-line', async () => {
    const { client, net, sleeps } = setup();
    net.on('api.example.org', (_r, n) => (n === 1 ? status(429, { 'retry-after': '2' }) : ok({ v: 2 })));
    const res = await client.get(URL_);
    expect(res.json()).toEqual({ v: 2 });
    expect(sleeps).toEqual([2000]);
  });

  it('surfaces a long Retry-After as RateLimitedError with the time to come back, without hammering', async () => {
    const { client, net, sleeps, clock } = setup();
    net.on('api.example.org', () => status(429, { 'retry-after': '120' }));
    const err = await client.get(URL_).catch((e) => e);
    expect(err).toBeInstanceOf(RateLimitedError);
    expect((err as RateLimitedError).retryAt).toBe(clock.now() + 120_000);
    expect(net.count('api.example.org')).toBe(1);
    expect(sleeps).toHaveLength(0);
  });

  it('handles 503 with Retry-After like a rate limit', async () => {
    const { client, net } = setup();
    net.on('api.example.org', () => status(503, { 'retry-after': '600' }));
    await expect(client.get(URL_)).rejects.toBeInstanceOf(RateLimitedError);
    expect(net.count('api.example.org')).toBe(1);
  });

  it('parses Retry-After as seconds or HTTP date', () => {
    expect(parseRetryAfter('30', 0)).toBe(30_000);
    expect(parseRetryAfter('Wed, 11 Nov 2026 00:01:00 GMT', T0)).toBe(60_000);
    expect(parseRetryAfter('Wed, 11 Nov 2020 00:00:00 GMT', T0)).toBe(0);
    expect(parseRetryAfter('soon', 0)).toBeNull();
    expect(parseRetryAfter(undefined, 0)).toBeNull();
  });

  it('spaces requests to one host by the manifest minimum interval', async () => {
    const { client, net, sleeps } = setup({}, { minIntervalMs: 300 });
    net.on('api.example.org', () => ok({}));
    await Promise.all([client.get(`${URL_}?a`), client.get(`${URL_}?b`), client.get(`${URL_}?c`)]);
    expect(sleeps.length).toBe(2);
    for (const s of sleeps) {
      expect(s).toBeGreaterThan(200);
      expect(s).toBeLessThanOrEqual(300);
    }
  });
});

describe('conditional requests and caching', () => {
  it('revalidates with If-None-Match and reuses the cached body on 304', async () => {
    const { client, net, clock } = setup();
    net.on('api.example.org', (req) => (req.headers['if-none-match'] === '"v1"' ? { status: 304, headers: { etag: '"v1"' }, body: Buffer.alloc(0) } : ok({ v: 1 }, { etag: '"v1"' })));
    const a = await client.get(URL_);
    clock.advance(60_000);
    const b = await client.get(URL_);
    expect(a.notModified).toBe(false);
    expect(b.notModified).toBe(true);
    expect(b.json()).toEqual({ v: 1 });
    expect(b.fetchedAt).toBe(T0 + 60_000); // upstream confirmed the copy just now
    expect(net.calls[1]!.headers['if-none-match']).toBe('"v1"');
  });

  it('uses If-Modified-Since when only Last-Modified is available', async () => {
    const { client, net } = setup();
    const lm = 'Tue, 10 Nov 2026 17:43:37 GMT';
    net.on('api.example.org', (req) => (req.headers['if-modified-since'] === lm ? { status: 304, headers: {}, body: Buffer.alloc(0) } : ok({ v: 1 }, { 'last-modified': lm })));
    await client.get(URL_);
    expect((await client.get(URL_)).notModified).toBe(true);
  });

  it('serves from cache within the TTL without contacting upstream, then refetches', async () => {
    const { client, net, clock } = setup({}, { cacheTtlSec: 600 });
    net.on('api.example.org', (_r, n) => ok({ n }));
    expect((await client.get(URL_)).json()).toEqual({ n: 1 });
    clock.advance(599_000);
    const hit = await client.get(URL_);
    expect(hit.fromCache).toBe(true);
    expect(hit.stale).toBe(false);
    expect(hit.fetchedAt).toBe(T0);
    expect(net.count('api.example.org')).toBe(1);
    clock.advance(2_000);
    expect((await client.get(URL_)).json()).toEqual({ n: 2 });
  });

  it('falls back to the stale cached copy when upstream fails, and says so', async () => {
    const { client, net, clock } = setup();
    net.on('api.example.org', (_r, n) => (n === 1 ? ok({ v: 1 }) : status(500)));
    await client.get(URL_);
    clock.advance(3_600_000);
    const stale = await client.get(URL_);
    expect(stale.stale).toBe(true);
    expect(stale.fromCache).toBe(true);
    expect(stale.json()).toEqual({ v: 1 });
    expect(stale.fetchedAt).toBe(T0); // the age of the copy is preserved – never re-stamped as fresh
    expect(stale.error).toBeInstanceOf(HttpError);
  });

  it('does not serve a cached copy older than the stale-if-error limit', async () => {
    const { client, net, clock } = setup({ staleIfErrorMs: 3_600_000 });
    net.on('api.example.org', (_r, n) => (n === 1 ? ok({ v: 1 }) : status(500)));
    await client.get(URL_);
    clock.advance(3_600_001);
    await expect(client.get(URL_)).rejects.toBeInstanceOf(HttpError);
  });

  it('never stores responses requested with noStore', async () => {
    const { client, net, clock } = setup();
    net.on('api.example.org', (_r, n) => (n === 1 ? ok({ access_token: 'secret' }) : status(500)));
    await client.get(URL_, { noStore: true });
    clock.advance(1000);
    await expect(client.get(URL_, { noStore: true })).rejects.toBeInstanceOf(HttpError);
  });
});

describe('circuit breaker', () => {
  it('opens after repeated failures, short-circuits calls, probes after the cool-down and closes on success', async () => {
    const { client, net, clock, http } = setup({ maxRetries: 0 });
    let healthy = false;
    net.on('api.example.org', () => (healthy ? ok({ up: true }) : status(500)));
    for (let i = 0; i < 5; i++) await expect(client.get(URL_)).rejects.toBeInstanceOf(HttpError);
    expect(http.breaker('src').state).toBe('open');
    const before = net.count('api.example.org');
    await expect(client.get(URL_)).rejects.toBeInstanceOf(CircuitOpenError);
    expect(net.count('api.example.org')).toBe(before); // no request while open

    clock.advance(60_001);
    await expect(client.get(URL_)).rejects.toBeInstanceOf(HttpError); // half-open probe fails → open again, longer cool-down
    expect(http.breaker('src').state).toBe('open');
    clock.advance(60_001);
    await expect(client.get(URL_)).rejects.toBeInstanceOf(CircuitOpenError);
    clock.advance(60_001);
    healthy = true;
    expect((await client.get(URL_)).json()).toEqual({ up: true });
    expect(http.breaker('src').state).toBe('closed');
  });

  it('serves stale data while the breaker is open', async () => {
    const { client, net, http } = setup({ maxRetries: 0 });
    net.on('api.example.org', (_r, n) => (n === 1 ? ok({ v: 1 }) : 'network'));
    await client.get(URL_);
    for (let i = 0; i < 5; i++) expect((await client.get(URL_)).stale).toBe(true);
    expect(http.breaker('src').state).toBe('open');
    const res = await client.get(URL_);
    expect(res.stale).toBe(true);
    expect(res.error).toBeInstanceOf(CircuitOpenError);
  });

  it('does not count rate limits or credential errors as breaker failures', async () => {
    const { client, net, http } = setup({ maxRetries: 0 });
    net.on('api.example.org', (_r, n) => (n % 2 ? status(429, { 'retry-after': '300' }) : status(401)));
    for (let i = 0; i < 12; i++) await client.get(URL_).catch(() => {});
    expect(http.breaker('src').state).toBe('closed');
  });

  it('isolates sources: one open breaker does not affect another source', async () => {
    const { net, http } = setup({ maxRetries: 0 });
    net.on('api.example.org', () => status(500));
    net.on('other.example.org', () => ok({ fine: true }));
    const bad = http.forSource(SRC);
    const good = http.forSource({ id: 'other', allowedHosts: ['other.example.org'], http: {} });
    for (let i = 0; i < 6; i++) await bad.get(URL_).catch(() => {});
    expect(http.breaker('src').state).toBe('open');
    expect((await good.get('https://other.example.org/x')).json()).toEqual({ fine: true });
  });

  it('grows the cool-down exponentially up to its cap', () => {
    const clock = new ManualClock(0);
    const b = new CircuitBreaker(clock, 1, 1000, 8000);
    const cools: number[] = [];
    for (let i = 0; i < 6; i++) {
      b.failure();
      cools.push(b.cooldownMs);
      clock.advance(b.cooldownMs + 1);
      expect(b.allow()).toBe(true); // half-open probe
    }
    expect(cools).toEqual([1000, 2000, 4000, 8000, 8000, 8000]);
  });
});

describe('secrets', () => {
  it('redacts secrets and credential-looking query parameters from URLs', async () => {
    expect(redactUrl('https://x.org/api/KEY12345/data?api_key=abc&q=1&token=zzz', ['KEY12345'])).toBe('https://x.org/api/REDACTED/data?api_key=REDACTED&q=1&token=REDACTED');
    const { client, net } = setup();
    net.on('api.example.org', () => ok({}));
    const res = await client.get('https://api.example.org/k/SUPERSECRET/x', { redact: ['SUPERSECRET'] });
    expect(res.url).toBe('https://api.example.org/k/REDACTED/x');
    expect(client.requestLog).toEqual(['https://api.example.org/k/REDACTED/x']);
  });
});
