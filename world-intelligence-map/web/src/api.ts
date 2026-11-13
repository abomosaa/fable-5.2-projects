import type { ChoroplethLayer, FeaturesResponse, Filters, ListItem, Meta, RecordDetail, SourceEntry, TimeState } from './types';

let clockOffset = 0;
/** Current time on the server's clock (the simulated clock in fixture mode). */
export function serverNow(): number {
  return Date.now() + clockOffset;
}
export function syncClock(serverTime: number): void {
  if (Number.isFinite(serverTime)) clockOffset = serverTime - Date.now();
}

export class ApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

async function get<T>(path: string, signal?: AbortSignal): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, { signal, headers: { accept: 'application/json' } });
  } catch (err) {
    if ((err as Error).name === 'AbortError') throw err;
    throw new ApiError('The server could not be reached.', 0);
  }
  if (!res.ok) {
    let message = `Request failed (${res.status})`;
    try {
      const body = (await res.json()) as { message?: string };
      if (body.message) message = body.message;
    } catch {
      /* ignore */
    }
    throw new ApiError(message, res.status);
  }
  const data = (await res.json()) as T & { now?: number };
  if (typeof data.now === 'number') syncClock(data.now);
  return data;
}

/** The time window actually queried for a given timeline state. */
export function effectiveRange(t: TimeState): { from: number; to: number } | null {
  if (t.mode === 'live') return null;
  const to = Math.min(t.to, Math.max(t.from, t.cursor));
  const from = t.windowSec > 0 ? Math.max(t.from, to - t.windowSec * 1000) : t.from;
  return { from, to };
}

export function filterParams(layers: string[], filters: Filters, time: TimeState): URLSearchParams {
  const p = new URLSearchParams();
  p.set('layers', layers.join(','));
  const r = effectiveRange(time);
  if (r) {
    p.set('from', String(Math.round(r.from)));
    p.set('to', String(Math.round(r.to)));
  } else if (time.mode === 'live') p.set('window', String(time.windowSec));
  if (filters.sources.length) p.set('sources', filters.sources.join(','));
  if (filters.categories.length) p.set('categories', filters.categories.join(','));
  if (filters.countries.length) p.set('countries', filters.countries.join(','));
  if (filters.sevMin > 0 || filters.sevMax < 4) p.set('sev', `${filters.sevMin}-${filters.sevMax}`);
  if (!filters.sevUnknown) p.set('sevU', '0');
  if (filters.confMin > 0) p.set('conf', String(filters.confMin));
  if (!filters.confUnknown) p.set('confU', '0');
  if (filters.fresh.length) p.set('fresh', filters.fresh.join(','));
  if (filters.q.trim()) p.set('q', filters.q.trim());
  return p;
}

export const api = {
  meta: (signal?: AbortSignal) => get<Meta>('/api/meta', signal),
  sources: (signal?: AbortSignal) => get<{ now: number; totalRecords: number; sources: SourceEntry[] }>('/api/sources', signal),
  source: (id: string, signal?: AbortSignal) => get<SourceEntry & { runs: Record<string, unknown>[] }>(`/api/sources/${encodeURIComponent(id)}`, signal),
  refreshSource: async (id: string) => {
    const res = await fetch(`/api/sources/${encodeURIComponent(id)}/refresh`, { method: 'POST' });
    if (!res.ok && res.status !== 429) throw new ApiError('Refresh failed', res.status);
    return res.status;
  },
  features: (p: URLSearchParams, bbox: [number, number, number, number], zoom: number, signal?: AbortSignal) => {
    const q = new URLSearchParams(p);
    q.set('bbox', bbox.map((n) => n.toFixed(4)).join(','));
    q.set('z', zoom.toFixed(2));
    return get<FeaturesResponse>(`/api/features?${q}`, signal);
  },
  choropleth: (p: URLSearchParams, signal?: AbortSignal) => get<{ now: number; layers: Record<string, ChoroplethLayer> }>(`/api/choropleth?${p}`, signal),
  list: (p: URLSearchParams, opts: { bbox?: [number, number, number, number] | null; sort?: 'time' | 'severity'; limit?: number; global?: boolean }, signal?: AbortSignal) => {
    const q = new URLSearchParams(p);
    if (opts.bbox) q.set('bbox', opts.bbox.map((n) => n.toFixed(4)).join(','));
    if (opts.sort) q.set('sort', opts.sort);
    if (opts.limit) q.set('limit', String(opts.limit));
    if (opts.global === false) q.set('global', '0');
    return get<{ now: number; items: ListItem[]; total: number }>(`/api/list?${q}`, signal);
  },
  histogram: (p: URLSearchParams, hfrom: number, hto: number, buckets: number, bbox: [number, number, number, number] | null, signal?: AbortSignal) => {
    const q = new URLSearchParams(p);
    q.set('hfrom', String(Math.round(hfrom)));
    q.set('hto', String(Math.round(hto)));
    q.set('buckets', String(buckets));
    if (bbox) q.set('bbox', bbox.map((n) => n.toFixed(4)).join(','));
    return get<{ now: number; from: number; to: number; bucketMs: number; counts: number[]; total: number }>(`/api/histogram?${q}`, signal);
  },
  record: (id: string, signal?: AbortSignal) => get<RecordDetail>(`/api/records/${encodeURIComponent(id)}`, signal),
};
