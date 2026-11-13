import { defineAdapter, isObject, jsonPayload, loadManifest, ParseCollector } from '../base.ts';
import { pointGeometry } from '../../core/geo.ts';
import { plainText, str } from '../../core/text.ts';
import { DAY, iso, parseTime } from '../../core/time.ts';
import type { FetchedPayload, RecordDraft, Severity } from '../../core/types.ts';
import manifestJson from './manifest.json' with { type: 'json' };

const manifest = loadManifest(manifestJson);
const URL_AURORA = 'https://services.swpc.noaa.gov/json/ovation_aurora_latest.json';
const URL_ALERTS = 'https://services.swpc.noaa.gov/products/alerts.json';
const ALERTS_PAGE = 'https://www.spaceweather.gov/products/alerts-watches-and-warnings';

/** Aurora cells below this probability (%) are not emitted. */
export const AURORA_MIN_PROBABILITY = 10;
/** Keep every n-th degree of longitude and latitude. */
export const AURORA_THIN = 2;
/** Alerts older than this are not emitted. */
export const ALERT_MAX_AGE_DAYS = 7;
/** NOAA Space Weather Scale level 1–5 (Minor, Moderate, Strong, Severe, Extreme) → severity. Derived by this application. */
export const NOAA_SCALE_SEVERITY: Record<number, Severity> = { 1: 1, 2: 2, 3: 3, 4: 3, 5: 4 };

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
/** "2026 Nov 09 0556 UTC" (the time format used inside SWPC messages) → epoch ms. */
export function parseSwpcTime(text: string | null | undefined): number | null {
  const m = /(\d{4}) ([A-Za-z]{3}) (\d{1,2}) (\d{2})(\d{2}) UTC/.exec(text ?? '');
  if (!m) return null;
  const month = MONTHS.indexOf(m[2]!.toLowerCase());
  if (month < 0 || +m[3]! < 1 || +m[3]! > 31 || +m[4]! > 23 || +m[5]! > 59) return null;
  return Date.UTC(+m[1]!, month, +m[3]!, +m[4]!, +m[5]!);
}

/** NOAA scale stated in a message: "NOAA Scale: G1 - Minor", or "Geomagnetic Storm Category G2 Predicted" in watches. */
export function noaaScale(message: string): { code: string; level: number; label: string } | null {
  const m = /NOAA Scale:\s*([GSR])([1-5])(?:\s*(?:or greater))?(?:\s*-\s*([A-Za-z]+))?/i.exec(message) ?? /\b(?:Storm )?Category\s+([GSR])([1-5])\b()/i.exec(message);
  if (!m) return null;
  const code = `${m[1]!.toUpperCase()}${m[2]}`;
  return { code, level: Number(m[2]), label: m[3] ? `${code} - ${m[3]}` : code };
}

const HEADER = /^(Space Weather Message Code|Serial Number|Issue Time)\s*:/i;
const BOILERPLATE = /^(NOAA Space Weather Scale descriptions can be found at|www\.swpc\.noaa\.gov\/noaa-scales-explanation|Comment:\s*$)/i;

function parseAurora(payload: FetchedPayload, out: ParseCollector): void {
  const body = jsonPayload<Record<string, unknown> & { coordinates: unknown[] }>(payload, (v) => isObject(v) && Array.isArray(v.coordinates), 'SWPC OVATION aurora grid');
  const observed = parseTime(body['Observation Time']);
  const forecast = parseTime(body['Forecast Time']);
  // Without either time not a single cell can be placed on the time axis.
  if (observed == null && forecast == null) throw new Error(`malformed SWPC OVATION aurora grid: no Observation Time / Forecast Time (${payload.key})`);
  const occurredAt = (observed ?? forecast)!;
  out.noteUpstreamTime(observed ?? forecast);
  const seen = new Set<string>();
  for (const cell of body.coordinates) {
    // Hot loop over ~65,000 cells: validate inline and only build records for the cells that are kept.
    if (!Array.isArray(cell) || cell.length < 3) {
      out.reject('aurora cell is not [longitude, latitude, probability]', JSON.stringify(cell)?.slice(0, 60));
      continue;
    }
    const [lon, lat, value] = cell as unknown[];
    if (typeof lon !== 'number' || typeof lat !== 'number' || typeof value !== 'number' || !Number.isFinite(lon + lat + value)) {
      out.reject('aurora cell has a non-numeric value', JSON.stringify(cell).slice(0, 60));
      continue;
    }
    if (lat < -90 || lat > 90 || lon < 0 || lon > 360) {
      out.reject('aurora cell coordinates out of range', JSON.stringify(cell).slice(0, 60));
      continue;
    }
    if (value < 0 || value > 100) {
      out.reject('aurora probability outside 0–100', JSON.stringify(cell).slice(0, 60));
      continue;
    }
    if (value < AURORA_MIN_PROBABILITY || lon % AURORA_THIN !== 0 || lat % AURORA_THIN !== 0) continue;
    const upstreamId = `aurora:${lon}_${lat}`;
    if (seen.has(upstreamId)) continue;
    seen.add(upstreamId);
    const geometry = pointGeometry(lon, lat)!;
    const [x, y] = (geometry as { coordinates: number[] }).coordinates as [number, number];
    out.records.push({
      upstreamId,
      layerId: 'aurora-forecast',
      subcategory: lat >= 0 ? 'aurora borealis' : 'aurora australis',
      geometry,
      occurredAt,
      confidence: null,
      title: `Aurora probability ${value} % at ${Math.abs(y)}°${y >= 0 ? 'N' : 'S'} ${Math.abs(x)}°${x >= 0 ? 'E' : 'W'}`,
      metric: { name: 'Aurora probability', value, unit: '%' },
      attributes: { observationTimeUtc: iso(observed), forecastTimeUtc: iso(forecast), gridLongitude: lon, gridLatitude: lat },
      url: 'https://www.spaceweather.gov/products/aurora-30-minute-forecast',
    });
  }
}

function parseAlerts(payload: FetchedPayload, out: ParseCollector, now: number): void {
  const list = jsonPayload<unknown[]>(payload, (v) => Array.isArray(v), 'SWPC alerts list');
  const seen = new Set<string>();
  for (const raw of list) {
    out.item(raw, (a) => (isObject(a) ? `${String(a.product_id)} ${String(a.issue_datetime)}` : String(a)), (a): RecordDraft | RecordDraft[] | string => {
      if (!isObject(a)) return 'alert is not an object';
      const productId = str(a.product_id, 20);
      // "2026-11-10 05:01:21.150" – UTC without a zone designator.
      const issued = parseTime(a.issue_datetime);
      if (issued == null) return 'missing or unparseable issue_datetime';
      if (typeof a.message !== 'string' || !a.message.trim()) return 'missing message text';
      if (issued < now - ALERT_MAX_AGE_DAYS * DAY) return []; // older than the window – not an error
      const message = a.message;
      const lines = message.split(/\r?\n/).map((l) => plainText(l, 300)).filter(Boolean);
      const body = lines.filter((l) => !HEADER.test(l));
      const title = body[0];
      if (!title) return 'message has no content after its header';
      const code = /Space Weather Message Code:\s*([A-Z0-9]+)/i.exec(message)?.[1] ?? null;
      const serial = /Serial Number:\s*(\d+)/i.exec(message)?.[1] ?? null;
      const upstreamId = code && serial ? `${code}:${serial}` : `${productId ?? 'msg'}:${iso(issued)}`;
      if (seen.has(upstreamId)) return [];
      seen.add(upstreamId);

      const scale = noaaScale(message);
      const kind = /^(?:CONTINUED |EXTENDED |CANCEL(?:LED)? )?(ALERT|WARNING|WATCH|SUMMARY)\b/i.exec(title)?.[1]?.toLowerCase() ?? null;
      const field = (name: RegExp) => body.find((l) => name.test(l))?.replace(name, '').trim() ?? null;
      const validFrom = parseSwpcTime(field(/^(Valid From|Begin Time|Threshold Reached)\s*:/i));
      const validTo = parseSwpcTime(field(/^(Now Valid Until|Valid To|End Time)\s*:/i));
      // Body without boilerplate; some messages repeat a line ("Noaa Scale: …" / "NOAA Scale: …").
      const said = new Set<string>();
      const excerpt = body
        .slice(1)
        .filter((l) => !BOILERPLATE.test(l) && !said.has(l.toLowerCase()) && said.add(l.toLowerCase()))
        .join('; ');

      return {
        upstreamId,
        layerId: 'space-weather-alerts',
        subcategory: kind,
        geometryKind: 'global',
        occurredAt: issued,
        publishedAt: issued,
        severity: scale ? (NOAA_SCALE_SEVERITY[scale.level] ?? null) : null,
        severityLabel: scale ? `NOAA scale ${scale.label}` : null,
        confidence: null,
        title: plainText(title, 200),
        description: plainText(excerpt, 500) || null,
        attributes: {
          productId,
          messageCode: code,
          serialNumber: serial != null ? Number(serial) : null,
          bulletinType: kind,
          noaaScale: scale?.code ?? null,
          validFromUtc: iso(validFrom),
          validUntilUtc: iso(validTo),
        },
        url: ALERTS_PAGE,
        derived: scale ? ['severity'] : [],
      };
    });
  }
}

export default defineAdapter({
  manifest,
  version: '1.0.0',

  async fetch(ctx) {
    return [await ctx.http.get(URL_AURORA, { key: 'aurora' }), await ctx.http.get(URL_ALERTS, { key: 'alerts' })];
  },

  parse(payloads, ctx) {
    const out = new ParseCollector();
    for (const payload of payloads) {
      if (payload.key === 'aurora') parseAurora(payload, out);
      else if (payload.key === 'alerts') parseAlerts(payload, out, ctx.now);
      else throw new Error(`malformed SWPC payload: unknown key "${payload.key}"`);
    }
    return out.done();
  },
});
