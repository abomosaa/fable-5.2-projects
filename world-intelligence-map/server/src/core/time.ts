/** Time parsing helpers. Everything is normalised to epoch milliseconds (UTC). */

const MIN_MS = Date.UTC(1800, 0, 1);
const MAX_FUTURE_MS = 50 * 365.25 * 86400_000;

/** true when `ms` is a finite epoch-ms within a sane range. */
export function isSaneTime(ms: unknown, now = Date.now()): ms is number {
  return typeof ms === 'number' && Number.isFinite(ms) && ms >= MIN_MS && ms <= now + MAX_FUTURE_MS;
}

/**
 * Parse an upstream timestamp to epoch ms.
 *  - ISO 8601 with offset or Z                       → exact instant
 *  - ISO 8601 without zone ("2026-11-10T12:00:00")   → interpreted as UTC (most public feeds), unless `assumeOffsetMinutes` is given
 *  - "YYYY-MM-DD HH:mm:ss[.sss]"                     → UTC
 *  - RFC 822 / RFC 1123 ("Tue, 10 Nov 2026 12:00:00 GMT")
 *  - "YYYYMMDDHHmmss" / "YYYYMMDD" compact forms     → UTC
 * Returns null for anything unparseable. Numbers are NOT accepted here — use fromEpochSeconds / fromEpochMillis
 * so the unit is always explicit.
 */
export function parseTime(value: unknown, opts: { assumeOffsetMinutes?: number } = {}): number | null {
  if (value == null) return null;
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value.getTime() : null;
  if (typeof value !== 'string') return null;
  const s = value.trim();
  if (!s) return null;

  let m = /^(\d{4})(\d{2})(\d{2})(?:T?(\d{2})(\d{2})(\d{2})?)?Z?$/.exec(s);
  if (m) {
    return checked(Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!, +(m[4] ?? 0), +(m[5] ?? 0), +(m[6] ?? 0)), m);
  }

  m = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:[.,](\d{1,9}))?)?)?\s*(Z|UTC|GMT|[+-]\d{2}:?\d{2}|[+-]\d{2})?$/i.exec(s);
  if (m) {
    const frac = m[7] ? Math.round(Number(`0.${m[7]}`) * 1000) : 0;
    let ms = Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!, +(m[4] ?? 0), +(m[5] ?? 0), +(m[6] ?? 0), frac);
    if (checked(ms, m) == null) return null;
    const zone = m[8];
    if (zone && !/^(Z|UTC|GMT)$/i.test(zone)) {
      const zm = /^([+-])(\d{2}):?(\d{2})?$/.exec(zone)!;
      const off = (+zm[2]! * 60 + +(zm[3] ?? 0)) * (zm[1] === '-' ? -1 : 1);
      ms -= off * 60_000;
    } else if (!zone && opts.assumeOffsetMinutes) {
      ms -= opts.assumeOffsetMinutes * 60_000;
    }
    return ms;
  }

  // RFC 822 and friends – let the platform parse, but only for strings that carry a month name.
  if (/[A-Za-z]{3}/.test(s)) {
    const ms = Date.parse(s);
    return Number.isFinite(ms) ? ms : null;
  }
  return null;
}

function checked(ms: number, m: RegExpExecArray): number | null {
  if (!Number.isFinite(ms)) return null;
  // Reject overflowed dates such as month 13 or day 32 (Date.UTC silently rolls over).
  const d = new Date(ms);
  if (d.getUTCFullYear() !== +m[1]! || d.getUTCMonth() !== +m[2]! - 1 || d.getUTCDate() !== +m[3]!) return null;
  return ms;
}

export function fromEpochSeconds(value: unknown): number | null {
  const n = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
  return typeof n === 'number' && Number.isFinite(n) ? Math.round(n * 1000) : null;
}

export function fromEpochMillis(value: unknown): number | null {
  const n = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
  return typeof n === 'number' && Number.isFinite(n) ? Math.round(n) : null;
}

/** Start of a calendar year (UTC) for annual indicators. */
export function yearStart(year: number | string): number | null {
  const y = typeof year === 'string' ? Number(year) : year;
  return Number.isInteger(y) && y > 1800 && y < 2200 ? Date.UTC(y, 0, 1) : null;
}

export function iso(ms: number | null | undefined): string | null {
  return ms == null ? null : new Date(ms).toISOString();
}

export const SECOND = 1000;
export const MINUTE = 60_000;
export const HOUR = 3_600_000;
export const DAY = 86_400_000;
