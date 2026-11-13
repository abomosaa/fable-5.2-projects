import { defineAdapter, isObject, jsonPayload, loadManifest, ParseCollector, severityFromThresholds } from '../base.ts';
import { pointGeometry } from '../../core/geo.ts';
import { num, str } from '../../core/text.ts';
import { DAY, parseTime } from '../../core/time.ts';
import type { RecordDraft } from '../../core/types.ts';
import manifestJson from './manifest.json' with { type: 'json' };

const manifest = loadManifest(manifestJson);
const LOOKBACK_DAYS = 5 * 365;

/** Signed coordinate from a magnitude and its hemisphere letter ("41.8", "S" → -41.8). null when either part is unusable. */
export function signed(value: unknown, dir: unknown, positive: string, negative: string): number | null {
  const v = num(value);
  const d = str(dir)?.toUpperCase();
  if (v == null || v < 0 || (d !== positive && d !== negative)) return null;
  return d === negative ? -v : v;
}

export default defineAdapter({
  manifest,
  version: '1.0.0',

  async fetch(ctx) {
    const dateMin = new Date(ctx.now - LOOKBACK_DAYS * DAY).toISOString().slice(0, 10);
    return [await ctx.http.get(`https://ssd-api.jpl.nasa.gov/fireball.api?date-min=${dateMin}&req-loc=true`, { key: 'fireballs' })];
  },

  parse(payloads) {
    const out = new ParseCollector();
    for (const payload of payloads) {
      // { signature: {source, version}, count: "173", fields: [...], data: [[...], ...] }  – `data` is absent when count is 0.
      const body = jsonPayload<{ signature?: { version?: unknown }; count?: unknown; fields?: unknown; data?: unknown }>(
        payload,
        (v) => isObject(v) && isObject(v.signature) && v.count != null && (Array.isArray(v.fields) || num(v.count) === 0),
        'CNEOS fireball API response',
      );
      if (!Array.isArray(body.data) || !Array.isArray(body.fields)) continue;
      const col = new Map((body.fields as unknown[]).map((f, i) => [String(f), i]));
      for (const need of ['date', 'lat', 'lat-dir', 'lon', 'lon-dir']) {
        if (!col.has(need)) throw new Error(`malformed CNEOS fireball API response: field "${need}" missing`);
      }
      const get = (row: unknown[], name: string) => (col.has(name) ? row[col.get(name)!] : undefined);
      for (const row of body.data as unknown[]) {
        out.item(row, (r) => (Array.isArray(r) ? r.slice(0, 7).join(' ') : String(r)), (r): RecordDraft | string => {
          if (!Array.isArray(r)) return 'row is not an array';
          const dateStr = str(get(r, 'date'));
          const occurredAt = parseTime(dateStr); // "YYYY-MM-DD hh:mm:ss", documented as UTC
          if (occurredAt == null) return `unparseable date "${String(dateStr)}"`;
          const lat = signed(get(r, 'lat'), get(r, 'lat-dir'), 'N', 'S');
          const lon = signed(get(r, 'lon'), get(r, 'lon-dir'), 'E', 'W');
          const geometry = lat == null || lon == null ? null : pointGeometry(lon, lat);
          if (!geometry || Math.abs(lon!) > 180) return 'missing or invalid location';
          const impactKt = num(get(r, 'impact-e'));
          const radiated = num(get(r, 'energy'));
          const altKm = num(get(r, 'alt'));
          const velKmS = num(get(r, 'vel'));
          const severity = severityFromThresholds(impactKt, [0.5, 2, 10, 100]);
          return {
            upstreamId: `${dateStr!.replace(/[^0-9]/g, '')}_${lat!.toFixed(1)}_${lon!.toFixed(1)}`,
            layerId: 'fireballs',
            geometry,
            occurredAt,
            severity,
            severityLabel: impactKt != null ? `${impactKt} kt estimated impact energy` : null,
            uncertainty: { locationPrecisionDeg: 0.1 },
            title: `Fireball${impactKt != null ? ` – ${impactKt} kt` : ''} at ${Math.abs(lat!).toFixed(1)}°${lat! < 0 ? 'S' : 'N'} ${Math.abs(lon!).toFixed(1)}°${lon! < 0 ? 'W' : 'E'}`,
            description: `Bright meteor reported by U.S. Government sensors; peak brightness at ${dateStr} UTC${altKm != null ? `, ${altKm} km altitude` : ''}.`,
            attributes: {
              peakBrightnessUtc: dateStr,
              estimatedImpactEnergyKt: impactKt,
              totalRadiatedEnergyE10J: radiated,
              altitudeKm: altKm,
              velocityKmS: velKmS,
            },
            url: 'https://cneos.jpl.nasa.gov/fireballs/',
            derived: severity != null ? ['severity'] : [],
          };
        });
      }
    }
    return out.done();
  },
});
