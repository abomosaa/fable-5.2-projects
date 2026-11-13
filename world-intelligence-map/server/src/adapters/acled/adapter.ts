import { defineAdapter, isObject, jsonPayload, loadManifest, ParseCollector } from '../base.ts';
import { pointGeometry } from '../../core/geo.ts';
import { num, plainText, str } from '../../core/text.ts';
import { DAY, fromEpochSeconds, parseTime } from '../../core/time.ts';
import type { FetchContext, RecordDraft, Severity } from '../../core/types.ts';
import manifestJson from './manifest.json' with { type: 'json' };

const manifest = loadManifest(manifestJson);

export const PAGE_SIZE = 5000;
export const MAX_PAGES = 8;
export const LOOKBACK_DAYS = 30;
const FIELDS = [
  'event_id_cnty', 'event_date', 'time_precision', 'disorder_type', 'event_type', 'sub_event_type', 'actor1', 'actor2', 'interaction', 'civilian_targeting',
  'iso', 'country', 'admin1', 'location', 'latitude', 'longitude', 'geo_precision', 'source_scale', 'notes', 'fatalities', 'timestamp',
].join('|');

const LAYER_BY_TYPE: Record<string, string> = {
  battles: 'acled-violence',
  'explosions/remote violence': 'acled-violence',
  'violence against civilians': 'acled-violence',
  protests: 'acled-protests',
  riots: 'acled-protests',
  'strategic developments': 'acled-strategic',
};
const GEO_PRECISION: Record<number, [number, string]> = { 1: [0.8, 'exact location'], 2: [0.6, 'near or within the named area'], 3: [0.4, 'wider region'] };

export function fatalitySeverity(layerId: string, fatalities: number | null): Severity | null {
  if (fatalities == null) return null;
  if (fatalities >= 50) return 4;
  if (fatalities >= 10) return 3;
  if (fatalities >= 1) return 2;
  return layerId === 'acled-violence' ? 1 : 0;
}

/** In-memory token cache (never persisted): account → { token, expiresAt }. */
const tokens = new Map<string, { token: string; expiresAt: number }>();
export function clearTokenCache(): void {
  tokens.clear();
}

async function accessToken(ctx: FetchContext): Promise<string> {
  const username = ctx.env.ACLED_EMAIL!.trim();
  const password = ctx.env.ACLED_PASSWORD!;
  const cached = tokens.get(username);
  if (cached && cached.expiresAt > ctx.now + 5 * 60_000) return cached.token;
  // Documented OAuth password grant; the body is form-encoded and is never logged or cached.
  const body = new URLSearchParams({ username, password, grant_type: 'password', client_id: 'acled', scope: 'authenticated' }).toString();
  const res = await ctx.http.get('https://acleddata.com/oauth/token', {
    key: 'token', method: 'POST', body, headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' }, noStore: true, cacheTtlSec: 0,
  });
  const json = jsonPayload<{ access_token?: unknown; expires_in?: unknown }>(res, isObject, 'ACLED token response');
  const token = str(json.access_token, 4000);
  if (!token) throw new Error('malformed ACLED token response: no access_token');
  tokens.set(username, { token, expiresAt: ctx.now + Math.max(60, num(json.expires_in) ?? 3600) * 1000 });
  return token;
}

export default defineAdapter({
  manifest,
  version: '1.0.0',

  async fetch(ctx) {
    const token = await accessToken(ctx);
    const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);
    const range = `${day(ctx.now - LOOKBACK_DAYS * DAY)}|${day(ctx.now)}`;
    const payloads = [];
    for (let page = 1; page <= MAX_PAGES; page++) {
      const url = `https://acleddata.com/api/acled/read?_format=json&event_date=${encodeURIComponent(range)}&event_date_where=BETWEEN&fields=${encodeURIComponent(FIELDS)}&limit=${PAGE_SIZE}&page=${page}`;
      const p = await ctx.http.get(url, { key: `page-${page}`, headers: { authorization: `Bearer ${token}`, accept: 'application/json' }, redact: [token] });
      payloads.push(p);
      let rows = 0;
      try {
        const body = p.json<{ data?: unknown }>();
        rows = Array.isArray(body?.data) ? body.data.length : 0;
      } catch {
        rows = 0; // parse() reports the malformed page
      }
      if (rows < PAGE_SIZE) break;
    }
    return payloads;
  },

  parse(payloads) {
    const out = new ParseCollector();
    const seen = new Set<string>();
    for (const payload of payloads) {
      // { status: 200, success: true, count: n, data: [ { event_id_cnty, event_date, ... } ] } – all values are strings.
      const body = jsonPayload<{ status?: unknown; success?: unknown; data: Record<string, unknown>[]; error?: unknown; message?: unknown }>(
        payload,
        (v) => isObject(v) && Array.isArray(v.data),
        'ACLED API response',
      );
      if (body.success === false || (num(body.status) != null && num(body.status) !== 200)) {
        throw new Error(`malformed ACLED API response: upstream reported status ${String(body.status)} ${plainText(body.message ?? body.error ?? '', 120)}`);
      }
      for (const row of body.data) {
        out.item(row, (r) => `${String(r?.event_id_cnty)} ${String(r?.event_date)} ${String(r?.event_type)}`, (r): RecordDraft | RecordDraft[] | string => {
          if (!isObject(r)) return 'event is not an object';
          const id = str(r.event_id_cnty, 40);
          if (!id) return 'missing event_id_cnty';
          if (seen.has(id)) return [];
          const type = str(r.event_type);
          const layerId = type ? LAYER_BY_TYPE[type.toLowerCase()] : undefined;
          if (!layerId) return `unknown event_type "${String(type)}"`;
          const dateStr = str(r.event_date);
          const occurredAt = dateStr && /^\d{4}-\d{2}-\d{2}$/.test(dateStr) ? parseTime(dateStr) : null;
          if (occurredAt == null) return `unparseable event_date "${String(dateStr)}"`;
          const lat = num(r.latitude);
          const lon = num(r.longitude);
          const geometry = lat == null || lon == null || Math.abs(lon) > 180 ? null : pointGeometry(lon, lat);
          if (!geometry) return 'missing or invalid coordinates';
          seen.add(id);

          const fatalities = num(r.fatalities);
          const geoPrecision = num(r.geo_precision);
          const gp = geoPrecision != null ? GEO_PRECISION[geoPrecision] : undefined;
          const severity = fatalitySeverity(layerId, fatalities != null && fatalities >= 0 ? fatalities : null);
          const sub = str(r.sub_event_type);
          const place = [str(r.location), str(r.admin1), str(r.country)].filter(Boolean).join(', ');
          const notes = plainText(r.notes, 300);
          return {
            upstreamId: id,
            layerId,
            subcategory: sub ?? type,
            geometry,
            country: str(r.country),
            occurredAt,
            updatedAt: fromEpochSeconds(r.timestamp),
            severity,
            severityLabel: fatalities != null ? `${fatalities} reported fatalit${fatalities === 1 ? 'y' : 'ies'} (estimate)` : null,
            confidence: gp ? gp[0] : null,
            confidenceBasis: gp ? `ACLED geo-precision code ${geoPrecision}: ${gp[1]}. Describes location precision only.` : null,
            title: `${sub ?? type}${place ? ` – ${place}` : ''}`,
            description: notes ? `ACLED-coded report: ${notes}` : null,
            attributes: {
              eventType: type,
              subEventType: sub,
              disorderType: str(r.disorder_type),
              eventDate: dateStr,
              timePrecision: num(r.time_precision),
              actor1: str(r.actor1, 160),
              actor2: str(r.actor2, 160),
              interaction: str(r.interaction, 80),
              civilianTargeting: str(r.civilian_targeting),
              admin1: str(r.admin1),
              location: str(r.location),
              geoPrecision,
              reportedFatalities: fatalities,
              sourceScale: str(r.source_scale),
            },
            url: 'https://acleddata.com/conflict-data/data-export-tool',
            derived: [...(severity != null ? ['severity'] : []), ...(gp ? ['confidence'] : [])],
          };
        });
      }
    }
    return out.done();
  },
});
