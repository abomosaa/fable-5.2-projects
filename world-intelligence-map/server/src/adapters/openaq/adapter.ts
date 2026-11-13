import { defineAdapter, isObject, jsonPayload, loadManifest, ParseCollector, severityFromThresholds } from '../base.ts';
import { pointGeometry } from '../../core/geo.ts';
import { num, str } from '../../core/text.ts';
import { HOUR, iso, parseTime } from '../../core/time.ts';
import type { RecordDraft } from '../../core/types.ts';
import manifestJson from './manifest.json' with { type: 'json' };

const manifest = loadManifest(manifestJson);

/** OpenAQ parameter 2 = pm25, mass concentration in µg/m³. */
const BASE = 'https://api.openaq.org/v3/parameters/2/latest';
export const PAGE_LIMIT = 1000;
export const MAX_PAGES = 3;
/** Only sensors that reported within this window are requested (datetime_min). */
export const WINDOW_HOURS = 6;
/**
 * PM2.5 concentration (µg/m³) → severity 1..4: the upper bounds of the US EPA AQI categories Good (9.0),
 * Moderate (35.4), Unhealthy for Sensitive Groups (55.4) and Unhealthy (125.4). Derived by this application.
 */
export const PM25_SEVERITY: [number, number, number, number] = [9.05, 35.45, 55.45, 125.45];

interface Latest {
  datetime?: { utc?: unknown; local?: unknown } | null;
  value?: unknown;
  coordinates?: { latitude?: unknown; longitude?: unknown } | null;
  sensorsId?: unknown;
  locationsId?: unknown;
}

export function pageUrl(page: number, now: number): string {
  // Floor to the hour so that repeated polls within an hour ask for the same resource.
  const since = new Date(Math.floor((now - WINDOW_HOURS * HOUR) / HOUR) * HOUR).toISOString().slice(0, 19) + 'Z';
  return `${BASE}?limit=${PAGE_LIMIT}&page=${page}&datetime_min=${encodeURIComponent(since)}`;
}

export default defineAdapter({
  manifest,
  version: '1.0.0',

  async fetch(ctx) {
    const apiKey = ctx.env.OPENAQ_API_KEY ?? '';
    const payloads = [];
    for (let page = 1; page <= MAX_PAGES; page++) {
      // The key travels only in the X-API-Key header, as documented; it is never part of the URL.
      const payload = await ctx.http.get(pageUrl(page, ctx.now), { key: `page-${page}`, headers: { 'X-API-Key': apiKey }, redact: [apiKey] });
      payloads.push(payload);
      let count = 0;
      try {
        const body = payload.json<{ results?: unknown }>();
        count = Array.isArray(body?.results) ? body.results.length : 0;
      } catch {
        // parse() reports the malformed page
      }
      if (count < PAGE_LIMIT) break;
    }
    return payloads;
  },

  parse(payloads, ctx) {
    const out = new ParseCollector();
    const seen = new Set<string>();
    for (const payload of payloads) {
      const body = jsonPayload<{ results: Latest[] }>(payload, (v) => isObject(v) && Array.isArray(v.results), 'OpenAQ latest response');
      for (const row of body.results) {
        out.item(row, (r) => `sensor ${String(r?.sensorsId)} location ${String(r?.locationsId)} value ${String(r?.value)}`, (r): RecordDraft | RecordDraft[] | string => {
          if (!isObject(r)) return 'result is not an object';
          const sensorId = num(r.sensorsId);
          if (sensorId == null || !Number.isInteger(sensorId)) return 'missing sensor id';
          if (seen.has(String(sensorId))) return []; // the same sensor can appear on two pages while the list shifts
          const coords: Record<string, unknown> = isObject(r.coordinates) ? r.coordinates : {};
          const datetime: Record<string, unknown> = isObject(r.datetime) ? r.datetime : {};
          // null coordinates are allowed by the schema (pointGeometry returns null for them)
          const geometry = pointGeometry(coords.longitude, coords.latitude);
          if (!geometry) return 'missing or invalid coordinates';
          if (typeof r.value !== 'number' || !Number.isFinite(r.value)) return 'non-numeric value';
          const value = r.value;
          if (value < 0) return `negative or sentinel value ${value}`;
          if (value > 5000) return `implausible PM2.5 value ${value}`;
          // `utc` is authoritative; `local` carries the station's UTC offset and is used only when `utc` is absent.
          const local = parseTime(datetime.local);
          const occurredAt = parseTime(datetime.utc) ?? local;
          if (occurredAt == null) return 'missing or unparseable measurement time';
          if (occurredAt > ctx.now + HOUR) return 'measurement time is in the future';
          seen.add(String(sensorId));

          const locationId = num(r.locationsId);
          const rounded = Math.round(value * 10) / 10;
          return {
            upstreamId: `sensor-${sensorId}`,
            layerId: 'openaq-pm25',
            geometry,
            occurredAt,
            severity: severityFromThresholds(value, PM25_SEVERITY),
            severityLabel: `PM2.5 ${rounded} µg/m³`,
            confidence: null,
            title: `PM2.5 ${rounded} µg/m³ – OpenAQ ${locationId != null ? `location ${locationId}` : `sensor ${sensorId}`}`,
            description: 'Latest PM2.5 reading reported by this monitoring sensor (station measurement, not validated by OpenAQ).',
            metric: { name: 'PM2.5', value, unit: 'µg/m³' },
            attributes: {
              sensorId,
              locationId,
              stationMeasurement: true,
              measuredAtLocal: local != null ? str(datetime.local, 40) : null,
              measuredAtUtc: iso(occurredAt),
            },
            url: locationId != null ? `https://explore.openaq.org/locations/${locationId}` : null,
            derived: ['severity'],
          };
        });
      }
    }
    return out.done();
  },
});
