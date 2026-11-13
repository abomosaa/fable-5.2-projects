/** Helpers shared by source adapters. */
import { SourceManifestSchema, type FetchContext, type FetchedPayload, type HttpGetOptions, type ParseOutput, type RejectedItem, type Severity, type SourceAdapter, type SourceManifest } from '../core/types.ts';

/** Validate a manifest.json at module load so that a bad manifest fails fast and loudly. */
export function loadManifest(json: unknown): SourceManifest {
  const res = SourceManifestSchema.safeParse(json);
  if (!res.success) {
    const id = (json as { id?: string })?.id ?? '?';
    throw new Error(`invalid source manifest "${id}": ${res.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
  }
  const m = res.data;
  const seen = new Set<string>();
  for (const l of m.layers) {
    if (seen.has(l.id)) throw new Error(`manifest ${m.id}: duplicate layer id ${l.id}`);
    seen.add(l.id);
    if (l.render.type === 'choropleth' && !l.metric) throw new Error(`manifest ${m.id}: choropleth layer ${l.id} needs a metric`);
  }
  for (const u of m.sourceUrls) {
    const host = /^https?:\/\/([^/:?#]+)/.exec(u)?.[1];
    if (host && !m.allowedHosts.includes(host)) throw new Error(`manifest ${m.id}: sourceUrl host ${host} missing from allowedHosts`);
  }
  return m;
}

export function defineAdapter(a: SourceAdapter): SourceAdapter {
  return a;
}

/** Missing required credentials for this adapter (empty array = configured). */
export function missingEnv(manifest: SourceManifest, env: Record<string, string | undefined>): string[] {
  return manifest.auth.envVars.filter((v) => v.required && !env[v.name]?.trim()).map((v) => v.name);
}

/** Collects records and rejects while parsing; wraps per-item work so one bad item never aborts the batch. */
export class ParseCollector {
  readonly records: ParseOutput['records'] = [];
  readonly rejected: RejectedItem[] = [];
  upstreamTime: number | null = null;

  /** Run `fn` for one upstream item. Exceptions and `null` results become rejects. */
  item<T>(raw: T, sample: (raw: T) => string, fn: (raw: T) => ParseOutput['records'][number] | ParseOutput['records'] | string | null): void {
    try {
      const out = fn(raw);
      if (out == null) this.reject('item could not be interpreted', safeSample(raw, sample));
      else if (typeof out === 'string') this.reject(out, safeSample(raw, sample));
      else if (Array.isArray(out)) this.records.push(...out);
      else this.records.push(out);
    } catch (err) {
      this.reject(`exception: ${(err as Error).message}`, safeSample(raw, sample));
    }
  }
  reject(reason: string, sample?: string): void {
    if (this.rejected.length < 500) this.rejected.push({ reason, sample: sample?.slice(0, 160) });
    else if (this.rejected.length === 500) this.rejected.push({ reason: 'further rejects omitted' });
  }
  noteUpstreamTime(ms: number | null | undefined): void {
    if (ms != null && Number.isFinite(ms) && (this.upstreamTime == null || ms > this.upstreamTime)) this.upstreamTime = ms;
  }
  done(): ParseOutput {
    return { records: this.records, rejected: this.rejected, upstreamTime: this.upstreamTime };
  }
}

function safeSample<T>(raw: T, sample: (raw: T) => string): string {
  try {
    return String(sample(raw));
  } catch {
    return '?';
  }
}

/** Parse a payload as JSON and assert a basic shape; throws a descriptive error for a wholly malformed payload. */
export function jsonPayload<T = unknown>(p: FetchedPayload, expect?: (v: unknown) => boolean, what = 'payload'): T {
  let v: unknown;
  try {
    v = p.json();
  } catch {
    throw new Error(`malformed ${what}: not valid JSON (${p.key})`);
  }
  if (expect && !expect(v)) throw new Error(`malformed ${what}: unexpected structure (${p.key})`);
  return v as T;
}

export function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Map a numeric value onto the 0–4 severity scale using ascending thresholds for levels 1..4. */
export function severityFromThresholds(value: number | null, thresholds: [number, number, number, number]): Severity | null {
  if (value == null || !Number.isFinite(value)) return null;
  let s = 0;
  for (let i = 0; i < 4; i++) if (value >= thresholds[i]!) s = i + 1;
  return s as Severity;
}

/**
 * Run several INDEPENDENT requests one after another (one per country, per indicator, …). A request that fails does not
 * discard the others: the failure is reported through ctx.partialFailure and the successful payloads are returned.
 * Credential, rate-limit and circuit-breaker errors stop the loop immediately; if nothing succeeded the first error is thrown.
 * Use only when each payload is meaningful on its own.
 */
export async function getEach(ctx: FetchContext, requests: { url: string; opts?: HttpGetOptions }[]): Promise<FetchedPayload[]> {
  const payloads: FetchedPayload[] = [];
  let firstError: unknown = null;
  for (const r of requests) {
    try {
      payloads.push(await ctx.http.get(r.url, r.opts));
    } catch (err) {
      const name = (err as Error)?.name;
      if (name === 'AuthError' || name === 'RateLimitedError' || name === 'CircuitOpenError' || name === 'DisallowedHostError' || ctx.signal.aborted) throw err;
      firstError ??= err;
      ctx.partialFailure?.(r.opts?.key ?? r.url, err);
    }
  }
  if (!payloads.length && firstError) throw firstError;
  return payloads;
}
