/** Parsing and validation of public API query parameters. Anything malformed is a 400, never a 500. */
import { FRESHNESS, type Freshness } from '../core/types.ts';
import type { BBox } from '../core/geo.ts';
import type { QueryFilters, TimeSpec } from '../store/queries.ts';

export class BadRequest extends Error {
  readonly statusCode = 400;
}

type Q = Record<string, unknown>;

function one(q: Q, name: string): string | undefined {
  const v = q[name];
  if (v == null) return undefined;
  if (Array.isArray(v)) return typeof v[0] === 'string' ? v[0] : undefined;
  return typeof v === 'string' ? v : undefined;
}

function list(q: Q, name: string, max: number, pattern: RegExp): string[] | undefined {
  const raw = one(q, name);
  if (raw == null || raw === '') return undefined;
  const parts = raw.split(',').map((s) => s.trim()).filter(Boolean);
  if (parts.length > max) throw new BadRequest(`${name}: too many values (max ${max})`);
  for (const p of parts) if (!pattern.test(p)) throw new BadRequest(`${name}: invalid value "${p.slice(0, 40)}"`);
  return parts;
}

function number(q: Q, name: string, min: number, max: number): number | undefined {
  const raw = one(q, name);
  if (raw == null || raw === '') return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < min || n > max) throw new BadRequest(`${name}: expected a number between ${min} and ${max}`);
  return n;
}

function bool(q: Q, name: string): boolean | undefined {
  const raw = one(q, name);
  if (raw == null || raw === '') return undefined;
  if (raw === '1' || raw === 'true') return true;
  if (raw === '0' || raw === 'false') return false;
  throw new BadRequest(`${name}: expected 0 or 1`);
}

export function parseTimeValue(raw: string, name: string): number {
  const n = /^\d{9,14}$/.test(raw) ? Number(raw) : Date.parse(raw);
  if (!Number.isFinite(n)) throw new BadRequest(`${name}: expected ISO 8601 time or epoch milliseconds`);
  return n;
}

export function parseBbox(q: Q): BBox | null {
  const raw = one(q, 'bbox');
  if (!raw) return null;
  const p = raw.split(',').map(Number);
  if (p.length !== 4 || p.some((n) => !Number.isFinite(n))) throw new BadRequest('bbox: expected west,south,east,north');
  const [w, s, e, n] = p as [number, number, number, number];
  if (s > n) throw new BadRequest('bbox: south must not exceed north');
  if (Math.abs(w) > 1080 || Math.abs(e) > 1080) throw new BadRequest('bbox: longitude out of range');
  return [w, Math.max(-90, s), e, Math.min(90, n)];
}

export function parseTime(q: Q): TimeSpec {
  const from = one(q, 'from');
  const to = one(q, 'to');
  if (from || to) {
    if (!from || !to) throw new BadRequest('from and to must be given together');
    const f = parseTimeValue(from, 'from');
    const t = parseTimeValue(to, 'to');
    if (f > t) throw new BadRequest('from must not be after to');
    return { mode: 'range', from: f, to: t };
  }
  const windowSec = number(q, 'window', 60, 3650 * 86400) ?? 86400;
  return { mode: 'live', windowMs: windowSec * 1000 };
}

const ID = /^[a-z0-9][a-z0-9-]{0,60}$/;

export function parseFilters(q: Q): QueryFilters {
  const layers = list(q, 'layers', 300, ID) ?? [];
  const sev = one(q, 'sev');
  let severityMin: number | undefined;
  let severityMax: number | undefined;
  if (sev) {
    const m = /^([0-4])-([0-4])$/.exec(sev);
    if (!m) throw new BadRequest('sev: expected "min-max" with values 0..4');
    severityMin = Number(m[1]);
    severityMax = Number(m[2]);
    if (severityMin > severityMax) throw new BadRequest('sev: min must not exceed max');
  }
  const fresh = list(q, 'fresh', 6, /^[a-z]+$/);
  if (fresh) for (const f of fresh) if (!(FRESHNESS as readonly string[]).includes(f)) throw new BadRequest(`fresh: unknown value "${f}"`);
  const text = one(q, 'q');
  if (text && text.length > 120) throw new BadRequest('q: too long');
  return {
    layers,
    bbox: parseBbox(q),
    time: parseTime(q),
    sources: list(q, 'sources', 100, ID),
    categories: list(q, 'categories', 60, /^[A-Za-z0-9 _&/.-]{1,60}$/),
    countries: list(q, 'countries', 60, /^[A-Za-z]{3}$/)?.map((c) => c.toUpperCase()),
    severityMin,
    severityMax,
    severityUnknown: bool(q, 'sevU'),
    confidenceMin: number(q, 'conf', 0, 1),
    confidenceUnknown: bool(q, 'confU'),
    freshness: fresh as Freshness[] | undefined,
    q: text?.trim() || undefined,
  };
}

export const num = number;
export const str = one;
