/**
 * Resilient upstream HTTP client.
 *
 * Every adapter talks to the outside world through a SourceHttp obtained from `ResilientHttp.forSource()`:
 *   - host allowlist per source (no arbitrary URL fetching, https only unless the manifest URL is http)
 *   - per-request timeout
 *   - retries with exponential backoff + full jitter on network errors, 408, 429 and 5xx
 *   - Retry-After handling (short waits are honoured in-line, long waits surface as RateLimitedError)
 *   - per-host request spacing (rate limiting)
 *   - per-source circuit breaker
 *   - conditional requests (ETag / Last-Modified) and a body cache with TTL + stale-if-error
 *
 * The transport is injectable: live mode uses fetch(), fixture mode and tests use deterministic transports.
 */
import type { Clock } from '../core/clock.ts';
import type { FetchedPayload, HttpGetOptions, SourceHttp, SourceManifest } from '../core/types.ts';
import { sha256 } from '../core/text.ts';

export interface TransportRequest {
  url: string;
  method: 'GET' | 'POST';
  headers: Record<string, string>;
  body?: string;
  signal: AbortSignal;
  /** Source making the request (fixture transport uses it for scenarios). */
  sourceId: string;
}
export interface TransportResponse {
  status: number;
  headers: Record<string, string>;
  body: Buffer;
}
export type Transport = (req: TransportRequest) => Promise<TransportResponse>;

export class HttpError extends Error {
  constructor(message: string, readonly status: number, readonly url: string) {
    super(message);
    this.name = 'HttpError';
  }
}
export class TimeoutError extends Error {
  constructor(readonly url: string, readonly timeoutMs: number) {
    super(`timeout after ${timeoutMs} ms`);
    this.name = 'TimeoutError';
  }
}
export class RateLimitedError extends Error {
  constructor(readonly url: string, readonly retryAt: number, readonly status = 429) {
    super(`rate limited by upstream (HTTP ${status})`);
    this.name = 'RateLimitedError';
  }
}
export class CircuitOpenError extends Error {
  constructor(readonly sourceId: string, readonly retryAt: number) {
    super('circuit breaker open – upstream calls suspended');
    this.name = 'CircuitOpenError';
  }
}
export class AuthError extends Error {
  constructor(readonly url: string, readonly status: number) {
    super(`upstream rejected credentials (HTTP ${status})`);
    this.name = 'AuthError';
  }
}
export class DisallowedHostError extends Error {
  constructor(readonly host: string, readonly sourceId: string) {
    super(`host "${host}" is not on the allowlist of source "${sourceId}"`);
    this.name = 'DisallowedHostError';
  }
}

export interface CachedBody {
  url: string;
  status: number;
  body: Buffer;
  contentType: string | null;
  etag: string | null;
  lastModified: string | null;
  fetchedAt: number;
  /** Last time upstream confirmed this body (200 or 304). */
  validatedAt: number;
}
export interface HttpCacheStore {
  get(key: string): CachedBody | null;
  set(key: string, value: CachedBody): void;
}
export class MemoryHttpCache implements HttpCacheStore {
  private readonly map = new Map<string, CachedBody>();
  get(key: string): CachedBody | null {
    return this.map.get(key) ?? null;
  }
  set(key: string, value: CachedBody): void {
    this.map.set(key, value);
  }
}

export type BreakerState = 'closed' | 'open' | 'half_open';

/** Classic three-state circuit breaker with exponentially growing cool-down. */
export class CircuitBreaker {
  private failures = 0;
  private openedAt = 0;
  private trips = 0;
  private probing = false;
  state: BreakerState = 'closed';
  constructor(
    private readonly clock: Clock,
    readonly threshold = 5,
    readonly baseCooldownMs = 60_000,
    readonly maxCooldownMs = 30 * 60_000,
  ) {}
  get cooldownMs(): number {
    return Math.min(this.maxCooldownMs, this.baseCooldownMs * 2 ** Math.max(0, this.trips - 1));
  }
  get retryAt(): number {
    return this.openedAt + this.cooldownMs;
  }
  /** Throws nothing; returns false when calls must not be attempted. */
  allow(): boolean {
    if (this.state === 'closed') return true;
    if (this.state === 'open') {
      if (this.clock.now() >= this.retryAt) {
        this.state = 'half_open';
        this.probing = true;
        return true;
      }
      return false;
    }
    // half-open: a single probe at a time
    if (this.probing) return false;
    this.probing = true;
    return true;
  }
  success(): void {
    this.failures = 0;
    this.trips = 0;
    this.probing = false;
    this.state = 'closed';
  }
  failure(): void {
    this.probing = false;
    if (this.state === 'half_open') {
      this.trip();
      return;
    }
    this.failures++;
    if (this.failures >= this.threshold) this.trip();
  }
  private trip(): void {
    this.trips++;
    this.failures = 0;
    this.openedAt = this.clock.now();
    this.state = 'open';
  }
}

export interface HttpPolicy {
  timeoutMs: number;
  maxRetries: number;
  backoffBaseMs: number;
  backoffCapMs: number;
  /** Retry-After values up to this are waited for in-line; longer ones surface as RateLimitedError. */
  maxInlineRetryAfterMs: number;
  minIntervalMs: number;
  /** Serve a cached body when upstream fails, if the copy is younger than this. */
  staleIfErrorMs: number;
  userAgent: string;
  maxBodyBytes: number;
}

export const DEFAULT_POLICY: HttpPolicy = {
  timeoutMs: 25_000,
  maxRetries: 2,
  backoffBaseMs: 500,
  backoffCapMs: 8_000,
  maxInlineRetryAfterMs: 5_000,
  minIntervalMs: 250,
  staleIfErrorMs: 7 * 86_400_000,
  userAgent: 'world-intelligence-map/1.0 (+https://github.com/; public-source situational awareness; contact via repository)',
  maxBodyBytes: 80 * 1024 * 1024,
};

export interface ResilientHttpOptions {
  transport: Transport;
  clock: Clock;
  cache?: HttpCacheStore;
  policy?: Partial<HttpPolicy>;
  /** Injectable for tests. Must resolve after `ms` (or immediately in tests). */
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
  /** Observability hook. */
  onEvent?: (e: HttpEvent) => void;
  /**
   * Ignore per-source pacing from manifests (request spacing, TTL caching, long timeouts). Used with the fixture
   * transport, where there is no upstream to protect and every run must reach the scripted scenario.
   */
  ignoreManifestHttp?: boolean;
}

export type HttpEvent =
  | { type: 'request'; sourceId: string; url: string; attempt: number }
  | { type: 'response'; sourceId: string; url: string; status: number; ms: number; bytes: number }
  | { type: 'retry'; sourceId: string; url: string; attempt: number; delayMs: number; reason: string }
  | { type: 'cache'; sourceId: string; url: string; kind: 'ttl-hit' | 'not-modified' | 'stale-if-error' }
  | { type: 'breaker'; sourceId: string; state: BreakerState };

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Parse a Retry-After header (delta-seconds or HTTP-date) into a delay in ms. */
export function parseRetryAfter(value: string | undefined, now: number): number | null {
  if (!value) return null;
  const v = value.trim();
  if (/^\d+(\.\d+)?$/.test(v)) return Math.round(Number(v) * 1000);
  const t = Date.parse(v);
  return Number.isFinite(t) ? Math.max(0, t - now) : null;
}

export function redactUrl(url: string, secrets: string[] = []): string {
  let out = url;
  for (const s of secrets) if (s && s.length >= 4) out = out.split(s).join('REDACTED').split(encodeURIComponent(s)).join('REDACTED');
  try {
    const u = new URL(out);
    for (const k of [...u.searchParams.keys()]) {
      if (/^(api[-_]?key|key|token|access[-_]?token|map[-_]?key|password|secret|app_identifier|client_secret)$/i.test(k)) u.searchParams.set(k, 'REDACTED');
    }
    return u.toString();
  } catch {
    return out;
  }
}

function makePayload(c: CachedBody, key: string, url: string, flags: { notModified: boolean; fromCache: boolean; stale: boolean }): FetchedPayload {
  let text: string | undefined;
  return {
    key,
    url,
    status: c.status,
    body: c.body,
    contentType: c.contentType,
    fetchedAt: c.validatedAt,
    etag: c.etag,
    lastModified: c.lastModified,
    ...flags,
    text() {
      return (text ??= c.body.toString('utf8'));
    },
    json<T>() {
      return JSON.parse(this.text()) as T;
    },
  };
}

export class ResilientHttp {
  private readonly transport: Transport;
  private readonly clock: Clock;
  private readonly cache: HttpCacheStore;
  private readonly policy: HttpPolicy;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly random: () => number;
  private readonly onEvent: (e: HttpEvent) => void;
  private readonly breakers = new Map<string, CircuitBreaker>();
  private readonly hostNextAt = new Map<string, number>();
  private readonly hostChain = new Map<string, Promise<void>>();
  private readonly ignoreManifestHttp: boolean;

  constructor(opts: ResilientHttpOptions) {
    this.transport = opts.transport;
    this.clock = opts.clock;
    this.cache = opts.cache ?? new MemoryHttpCache();
    this.policy = { ...DEFAULT_POLICY, ...opts.policy };
    this.sleep = opts.sleep ?? defaultSleep;
    this.random = opts.random ?? Math.random;
    this.onEvent = opts.onEvent ?? (() => {});
    this.ignoreManifestHttp = opts.ignoreManifestHttp ?? false;
  }

  breaker(sourceId: string): CircuitBreaker {
    let b = this.breakers.get(sourceId);
    if (!b) this.breakers.set(sourceId, (b = new CircuitBreaker(this.clock)));
    return b;
  }

  /** Space requests to one host at least `minIntervalMs` apart (FIFO). */
  private async throttle(host: string, minIntervalMs: number): Promise<void> {
    if (minIntervalMs <= 0) return;
    const prev = this.hostChain.get(host) ?? Promise.resolve();
    const next = prev.then(async () => {
      const wait = (this.hostNextAt.get(host) ?? 0) - Date.now();
      if (wait > 0) await this.sleep(wait);
      this.hostNextAt.set(host, Date.now() + minIntervalMs);
    });
    this.hostChain.set(host, next.catch(() => {}));
    await next;
  }

  forSource(manifest: Pick<SourceManifest, 'id' | 'allowedHosts' | 'http'>, signal?: AbortSignal): SourceHttp & { requestLog: string[] } {
    const sourceId = manifest.id;
    const mh = this.ignoreManifestHttp ? {} : (manifest.http ?? {});
    const policy: HttpPolicy = {
      ...this.policy,
      ...(mh.timeoutMs != null ? { timeoutMs: mh.timeoutMs } : {}),
      ...(mh.maxRetries != null ? { maxRetries: mh.maxRetries } : {}),
      ...(mh.minIntervalMs != null ? { minIntervalMs: mh.minIntervalMs } : {}),
    };
    const defaultTtlMs = (mh.cacheTtlSec ?? 0) * 1000;
    const noTtl = this.ignoreManifestHttp;
    const breaker = this.breaker(sourceId);
    const requestLog: string[] = [];

    const get = async (rawUrl: string, opts: HttpGetOptions = {}): Promise<FetchedPayload> => {
      let u: URL;
      try {
        u = new URL(rawUrl);
      } catch {
        throw new Error(`invalid URL requested by adapter ${sourceId}`);
      }
      if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new DisallowedHostError(u.protocol, sourceId);
      if (!manifest.allowedHosts.includes(u.hostname)) throw new DisallowedHostError(u.hostname, sourceId);

      const method = opts.method ?? 'GET';
      const displayUrl = redactUrl(rawUrl, opts.redact);
      const key = opts.key ?? displayUrl;
      const cacheKey = sha256(`${sourceId}\n${method}\n${rawUrl}\n${opts.body ?? ''}`);
      const cached = opts.noStore ? null : this.cache.get(cacheKey);
      const ttlMs = noTtl ? 0 : opts.cacheTtlSec != null ? opts.cacheTtlSec * 1000 : defaultTtlMs;
      requestLog.push(displayUrl);

      if (cached && ttlMs > 0 && this.clock.now() - cached.validatedAt < ttlMs) {
        this.onEvent({ type: 'cache', sourceId, url: displayUrl, kind: 'ttl-hit' });
        return makePayload(cached, key, displayUrl, { notModified: false, fromCache: true, stale: false });
      }

      const serveStale = (err: unknown): FetchedPayload => {
        if (cached && this.clock.now() - cached.validatedAt <= policy.staleIfErrorMs && !(err instanceof AuthError)) {
          this.onEvent({ type: 'cache', sourceId, url: displayUrl, kind: 'stale-if-error' });
          const p = makePayload(cached, key, displayUrl, { notModified: false, fromCache: true, stale: true });
          p.error = err;
          return p;
        }
        throw err;
      };

      if (!breaker.allow()) return serveStale(new CircuitOpenError(sourceId, breaker.retryAt));

      const headers: Record<string, string> = { 'user-agent': policy.userAgent, accept: '*/*', ...lower(opts.headers) };
      if (cached?.etag) headers['if-none-match'] = cached.etag;
      else if (cached?.lastModified) headers['if-modified-since'] = cached.lastModified;

      const timeoutMs = this.ignoreManifestHttp ? policy.timeoutMs : (opts.timeoutMs ?? policy.timeoutMs);
      let lastError: unknown = new Error('request not attempted');

      for (let attempt = 0; attempt <= policy.maxRetries; attempt++) {
        if (signal?.aborted) throw new Error('aborted');
        await this.throttle(u.host, policy.minIntervalMs);
        const ac = new AbortController();
        const onAbort = () => ac.abort();
        signal?.addEventListener('abort', onAbort, { once: true });
        let timedOut = false;
        const timer = setTimeout(() => {
          timedOut = true;
          ac.abort();
        }, timeoutMs);
        const started = Date.now();
        let retryDelay: number | null = null;
        let reason = '';
        try {
          this.onEvent({ type: 'request', sourceId, url: displayUrl, attempt });
          const res = await this.transport({ url: rawUrl, method, headers, body: opts.body, signal: ac.signal, sourceId });
          this.onEvent({ type: 'response', sourceId, url: displayUrl, status: res.status, ms: Date.now() - started, bytes: res.body.length });
          const h = lower(res.headers);

          if (res.status === 304 && cached) {
            breaker.success();
            const fresh: CachedBody = { ...cached, validatedAt: this.clock.now() };
            this.cache.set(cacheKey, fresh);
            this.onEvent({ type: 'cache', sourceId, url: displayUrl, kind: 'not-modified' });
            return makePayload(fresh, key, displayUrl, { notModified: true, fromCache: false, stale: false });
          }
          if (res.status >= 200 && res.status < 300) {
            if (res.body.length > policy.maxBodyBytes) throw new HttpError('response body too large', res.status, displayUrl);
            breaker.success();
            const now = this.clock.now();
            const entry: CachedBody = {
              url: displayUrl,
              status: res.status,
              body: res.body,
              contentType: h['content-type'] ?? null,
              etag: h['etag'] ?? null,
              lastModified: h['last-modified'] ?? null,
              fetchedAt: now,
              validatedAt: now,
            };
            if (!opts.noStore) this.cache.set(cacheKey, entry);
            return makePayload(entry, key, displayUrl, { notModified: false, fromCache: false, stale: false });
          }
          if (res.status === 401 || res.status === 403) {
            // Not retryable and not a breaker failure: the upstream is up, our credentials are not accepted.
            throw new AuthError(displayUrl, res.status);
          }
          if (res.status === 429 || (res.status === 503 && h['retry-after'])) {
            const ra = parseRetryAfter(h['retry-after'], Date.now());
            if (ra != null && ra > policy.maxInlineRetryAfterMs) {
              throw new RateLimitedError(displayUrl, this.clock.now() + ra, res.status);
            }
            if (res.status === 429 && attempt >= policy.maxRetries) {
              throw new RateLimitedError(displayUrl, this.clock.now() + (ra ?? 60_000), res.status);
            }
            retryDelay = ra ?? this.backoff(attempt, policy);
            reason = `HTTP ${res.status}`;
            lastError = res.status === 429 ? new RateLimitedError(displayUrl, this.clock.now() + retryDelay, 429) : new HttpError(`HTTP ${res.status}`, res.status, displayUrl);
          } else if (res.status === 408 || res.status >= 500) {
            retryDelay = this.backoff(attempt, policy);
            reason = `HTTP ${res.status}`;
            lastError = new HttpError(`upstream HTTP ${res.status}`, res.status, displayUrl);
          } else {
            // Other 4xx: our request is wrong; retrying will not help.
            throw new HttpError(`upstream HTTP ${res.status}`, res.status, displayUrl);
          }
        } catch (err) {
          if (err instanceof AuthError) throw err;
          if (err instanceof RateLimitedError) {
            // Upstream is alive and asking us to slow down – not a breaker failure.
            return serveStale(err);
          }
          if (err instanceof HttpError && err.status >= 400 && err.status < 500 && err.status !== 408) {
            breaker.failure();
            return serveStale(err);
          }
          if (signal?.aborted) throw new Error('aborted');
          lastError = timedOut ? new TimeoutError(displayUrl, timeoutMs) : err instanceof HttpError ? err : new Error(`network error: ${(err as Error)?.message ?? String(err)}`);
          retryDelay = this.backoff(attempt, policy);
          reason = timedOut ? 'timeout' : ((err as Error)?.name ?? 'error');
        } finally {
          clearTimeout(timer);
          signal?.removeEventListener('abort', onAbort);
        }

        if (attempt < policy.maxRetries && retryDelay != null) {
          this.onEvent({ type: 'retry', sourceId, url: displayUrl, attempt: attempt + 1, delayMs: retryDelay, reason });
          await this.sleep(retryDelay);
          continue;
        }
        break;
      }

      const before = breaker.state;
      breaker.failure();
      if (breaker.state !== before) this.onEvent({ type: 'breaker', sourceId, state: breaker.state });
      return serveStale(lastError);
    };

    return { get, requestLog };
  }

  /** Exponential backoff with full jitter. */
  private backoff(attempt: number, policy: HttpPolicy): number {
    const ceiling = Math.min(policy.backoffCapMs, policy.backoffBaseMs * 2 ** attempt);
    return Math.round(this.random() * ceiling);
  }
}

function lower(h: Record<string, string> | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (h) for (const [k, v] of Object.entries(h)) out[k.toLowerCase()] = v;
  return out;
}

/** Live transport backed by the platform fetch(). Redirects are followed only within the same allowlist by the caller's manifest. */
export function fetchTransport(allowedRedirectHosts?: (sourceId: string) => string[]): Transport {
  return async (req) => {
    let url = req.url;
    for (let hop = 0; hop < 5; hop++) {
      const res = await fetch(url, { method: req.method, headers: req.headers, body: req.body, signal: req.signal, redirect: 'manual' });
      if (res.status >= 300 && res.status < 400 && res.status !== 304) {
        const loc = res.headers.get('location');
        if (!loc) return { status: res.status, headers: Object.fromEntries(res.headers), body: Buffer.alloc(0) };
        const next = new URL(loc, url);
        const allowed = allowedRedirectHosts?.(req.sourceId);
        if (allowed && !allowed.includes(next.hostname)) throw new DisallowedHostError(next.hostname, req.sourceId);
        url = next.toString();
        continue;
      }
      const body = Buffer.from(await res.arrayBuffer());
      return { status: res.status, headers: Object.fromEntries(res.headers), body };
    }
    throw new Error('too many redirects');
  };
}
