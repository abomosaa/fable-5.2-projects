import { defineAdapter, isObject, jsonPayload, loadManifest, ParseCollector } from '../base.ts';
import { pointGeometry } from '../../core/geo.ts';
import { num, str } from '../../core/text.ts';
import { fromEpochSeconds, HOUR, parseTime } from '../../core/time.ts';
import type { RecordDraft, Severity } from '../../core/types.ts';
import citiesJson from './cities.json' with { type: 'json' };
import manifestJson from './manifest.json' with { type: 'json' };

const manifest = loadManifest(manifestJson);

export interface City {
  /** Stable key, `<iso3>-<name-slug>`. */
  key: string;
  name: string;
  /** ISO 3166-1 alpha-3 (Natural Earth ADM0_A3). */
  country: string;
  lat: number;
  lon: number;
  capital?: boolean;
}
export const CITIES: City[] = citiesJson;
/** Locations per request. Every location counts as one API call against the free tier's limits. */
export const BATCH_SIZE = 100;
const VARIABLES = 'pm2_5,pm10,nitrogen_dioxide,ozone,us_aqi,european_aqi';

/** US AQI bands (upper bound, EPA category name, severity derived by this application). */
export const US_AQI_BANDS: { max: number; category: string; severity: Severity }[] = [
  { max: 50, category: 'Good', severity: 0 },
  { max: 100, category: 'Moderate', severity: 1 },
  { max: 150, category: 'Unhealthy for Sensitive Groups', severity: 2 },
  { max: 200, category: 'Unhealthy', severity: 3 },
  { max: 300, category: 'Very Unhealthy', severity: 4 },
  { max: Infinity, category: 'Hazardous', severity: 4 },
];

export function usAqiBand(aqi: number | null): { category: string; severity: Severity } | null {
  if (aqi == null || aqi < 0) return null;
  return US_AQI_BANDS.find((b) => aqi <= b.max) ?? null;
}

export function cityBatches(): City[][] {
  const out: City[][] = [];
  for (let i = 0; i < CITIES.length; i += BATCH_SIZE) out.push(CITIES.slice(i, i + BATCH_SIZE));
  return out;
}

export function batchUrl(batch: City[]): string {
  return `https://air-quality-api.open-meteo.com/v1/air-quality?latitude=${batch.map((c) => c.lat).join(',')}&longitude=${batch.map((c) => c.lon).join(',')}&current=${VARIABLES}&timeformat=unixtime`;
}

interface OmLocation {
  latitude?: unknown;
  longitude?: unknown;
  location_id?: unknown;
  error?: unknown;
  reason?: unknown;
  current_units?: Record<string, unknown> | null;
  current?: Record<string, unknown> | null;
}

/** Open-Meteo writes "μg/m³" with a Greek mu; accept the micro sign as well. */
const isMicrogramPerM3 = (u: unknown) => typeof u === 'string' && /^[μµ]g\/m³$/.test(u);
const fmt = (n: number) => String(Math.round(n * 10) / 10);

export default defineAdapter({
  manifest,
  version: '1.0.0',

  async fetch(ctx) {
    const payloads = [];
    const batches = cityBatches();
    for (let i = 0; i < batches.length; i++) payloads.push(await ctx.http.get(batchUrl(batches[i]!), { key: `batch-${i}` }));
    return payloads;
  },

  parse(payloads, ctx) {
    const out = new ParseCollector();
    const batches = cityBatches();
    for (const payload of payloads) {
      const batch = batches[Number(/^batch-(\d+)$/.exec(payload.key)?.[1] ?? NaN)];
      if (!batch) throw new Error(`malformed Open-Meteo payload: unknown batch key "${payload.key}"`);
      // Several locations → a list of structures; a single location → one structure. Errors → { error: true, reason }.
      const body = jsonPayload<OmLocation[] | OmLocation>(payload, (v) => Array.isArray(v) || (isObject(v) && isObject(v.current)), 'Open-Meteo air quality response');
      const list = Array.isArray(body) ? body : [body];
      // Results are matched to cities by position, so a response of a different length cannot be interpreted.
      if (list.length !== batch.length) throw new Error(`malformed Open-Meteo air quality response: ${list.length} locations returned for ${batch.length} requested (${payload.key})`);

      list.forEach((loc, i) => {
        const city = batch[i]!;
        out.item(loc, () => `${city.key} ${JSON.stringify(loc?.current ?? loc)}`, (l): RecordDraft | string => {
          if (!isObject(l)) return 'location entry is not an object';
          if (l.error) return `upstream error for location: ${str(l.reason, 120) ?? 'no reason given'}`;
          if (l.location_id != null && l.location_id !== i) return `location_id ${String(l.location_id)} does not match request position ${i}`;
          const cur = l.current;
          if (!isObject(cur)) return 'missing current block';
          const occurredAt = typeof cur.time === 'number' ? fromEpochSeconds(cur.time) : parseTime(cur.time);
          if (occurredAt == null) return 'missing or invalid model time';
          if (occurredAt > ctx.now + HOUR) return 'model time is in the future';
          const units = isObject(l.current_units) ? l.current_units : {};
          for (const field of ['pm2_5', 'pm10', 'nitrogen_dioxide', 'ozone']) {
            if (units[field] != null && !isMicrogramPerM3(units[field])) return `unexpected unit for ${field}`;
          }
          const geometry = pointGeometry(city.lon, city.lat);
          if (!geometry) return 'invalid city coordinates';

          const pm25 = num(cur.pm2_5);
          if (pm25 == null) return 'missing PM2.5 value';
          if (pm25 < 0 || pm25 > 5000) return `implausible PM2.5 value ${pm25}`;
          const usAqi = num(cur.us_aqi);
          const euAqi = num(cur.european_aqi);
          const band = usAqiBand(usAqi);

          return {
            upstreamId: `air-quality:${city.key}`,
            layerId: 'air-quality',
            geometry,
            country: city.country,
            occurredAt,
            severity: band?.severity ?? null,
            severityLabel: band ? `US AQI ${Math.round(usAqi!)} (${band.category})` : null,
            confidence: null,
            title: `${city.name}: PM2.5 ${fmt(pm25)} µg/m³${band ? ` · US AQI ${Math.round(usAqi!)} (${band.category})` : ''} – modelled`,
            description: 'Modelled value from the CAMS atmospheric composition forecast for the grid cell containing the city; not a station measurement.',
            metric: { name: 'PM2.5', value: pm25, unit: 'µg/m³' },
            attributes: {
              city: city.name,
              capital: city.capital === true,
              modelled: true,
              pm10UgM3: num(cur.pm10),
              nitrogenDioxideUgM3: num(cur.nitrogen_dioxide),
              ozoneUgM3: num(cur.ozone),
              usAqi,
              usAqiCategory: band?.category ?? null,
              europeanAqi: euAqi,
              modelGridLatitude: num(l.latitude),
              modelGridLongitude: num(l.longitude),
              modelTimeStepSec: num(cur.interval),
            },
            url: `https://open-meteo.com/en/docs/air-quality-api?latitude=${city.lat}&longitude=${city.lon}`,
            derived: band ? ['severity'] : [],
          };
        });
      });
    }
    return out.done();
  },
});
