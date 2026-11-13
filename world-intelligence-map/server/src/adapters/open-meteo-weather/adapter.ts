import { defineAdapter, isObject, jsonPayload, loadManifest, ParseCollector, severityFromThresholds } from '../base.ts';
import { pointGeometry } from '../../core/geo.ts';
import { num, str } from '../../core/text.ts';
import { fromEpochSeconds, HOUR, parseTime } from '../../core/time.ts';
import type { RecordDraft } from '../../core/types.ts';
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
const VARIABLES = 'temperature_2m,apparent_temperature,precipitation,wind_speed_10m,wind_gusts_10m,weather_code';

/** Thresholds for inclusion in the wind layer (km/h). */
export const GUST_MIN_KMH = 50;
export const WIND_MIN_KMH = 40;
/** Gust speed (km/h) → severity 1..4. Roughly Beaufort 7, 9, 10 and 12. Derived by this application. */
export const GUST_SEVERITY: [number, number, number, number] = [50, 75, 90, 118];

/** WMO weather interpretation codes as documented by Open-Meteo. */
const WMO: Record<number, string> = {
  0: 'clear sky', 1: 'mainly clear', 2: 'partly cloudy', 3: 'overcast', 45: 'fog', 48: 'depositing rime fog',
  51: 'light drizzle', 53: 'moderate drizzle', 55: 'dense drizzle', 56: 'light freezing drizzle', 57: 'dense freezing drizzle',
  61: 'slight rain', 63: 'moderate rain', 65: 'heavy rain', 66: 'light freezing rain', 67: 'heavy freezing rain',
  71: 'slight snowfall', 73: 'moderate snowfall', 75: 'heavy snowfall', 77: 'snow grains',
  80: 'slight rain showers', 81: 'moderate rain showers', 82: 'violent rain showers', 85: 'slight snow showers', 86: 'heavy snow showers',
  95: 'thunderstorm', 96: 'thunderstorm with slight hail', 99: 'thunderstorm with heavy hail',
};

/** Units this adapter relies on (the API defaults; no unit parameters are sent). */
const EXPECTED_UNITS: Record<string, string> = { temperature_2m: '°C', apparent_temperature: '°C', precipitation: 'mm', wind_speed_10m: 'km/h', wind_gusts_10m: 'km/h' };

export function cityBatches(): City[][] {
  const out: City[][] = [];
  for (let i = 0; i < CITIES.length; i += BATCH_SIZE) out.push(CITIES.slice(i, i + BATCH_SIZE));
  return out;
}

export function batchUrl(batch: City[]): string {
  return `https://api.open-meteo.com/v1/forecast?latitude=${batch.map((c) => c.lat).join(',')}&longitude=${batch.map((c) => c.lon).join(',')}&current=${VARIABLES}&timeformat=unixtime`;
}

interface OmLocation {
  latitude?: unknown;
  longitude?: unknown;
  elevation?: unknown;
  location_id?: unknown;
  error?: unknown;
  reason?: unknown;
  current_units?: Record<string, unknown> | null;
  current?: Record<string, unknown> | null;
}

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
      const body = jsonPayload<OmLocation[] | OmLocation>(payload, (v) => Array.isArray(v) || (isObject(v) && isObject(v.current)), 'Open-Meteo forecast response');
      const list = Array.isArray(body) ? body : [body];
      // Results are matched to cities by position, so a response of a different length cannot be interpreted.
      if (list.length !== batch.length) throw new Error(`malformed Open-Meteo forecast response: ${list.length} locations returned for ${batch.length} requested (${payload.key})`);

      list.forEach((loc, i) => {
        const city = batch[i]!;
        out.item(loc, () => `${city.key} ${JSON.stringify(loc?.current ?? loc)}`, (l): RecordDraft[] | string => {
          if (!isObject(l)) return 'location entry is not an object';
          if (l.error) return `upstream error for location: ${str(l.reason, 120) ?? 'no reason given'}`;
          // Entries after the first carry their position; a mismatch means the order is not what we requested.
          if (l.location_id != null && l.location_id !== i) return `location_id ${String(l.location_id)} does not match request position ${i}`;
          const cur = l.current;
          if (!isObject(cur)) return 'missing current block';
          const occurredAt = typeof cur.time === 'number' ? fromEpochSeconds(cur.time) : parseTime(cur.time);
          if (occurredAt == null) return 'missing or invalid observation time';
          if (occurredAt > ctx.now + HOUR) return 'observation time is in the future';
          const units = isObject(l.current_units) ? l.current_units : {};
          for (const [field, unit] of Object.entries(EXPECTED_UNITS)) {
            if (units[field] != null && units[field] !== unit) return `unexpected unit for ${field}`;
          }
          const geometry = pointGeometry(city.lon, city.lat);
          if (!geometry) return 'invalid city coordinates';

          let temperature = num(cur.temperature_2m);
          const apparent = num(cur.apparent_temperature);
          const precipitation = num(cur.precipitation);
          const wind = num(cur.wind_speed_10m);
          const gusts = num(cur.wind_gusts_10m);
          if (temperature == null && precipitation == null && wind == null && gusts == null) return 'no usable current values';
          if (temperature != null && (temperature < -95 || temperature > 65)) {
            out.reject(`implausible temperature ${temperature} °C`, city.key);
            temperature = null;
          }
          const code = num(cur.weather_code);
          const weather = code != null ? (WMO[code] ?? null) : null;
          const intervalSec = num(cur.interval);
          const intervalText = intervalSec != null ? `preceding ${Math.round(intervalSec / 60)} min` : 'preceding interval';

          const common = {
            geometry,
            country: city.country,
            occurredAt,
            subcategory: weather,
            confidence: null,
            attributes: {
              city: city.name,
              capital: city.capital === true,
              temperatureC: temperature,
              apparentTemperatureC: apparent,
              precipitationMm: precipitation,
              windSpeedKmh: wind,
              windGustsKmh: gusts,
              weatherCode: code,
              weather,
              aggregationIntervalSec: intervalSec,
              modelGridLatitude: num(l.latitude),
              modelGridLongitude: num(l.longitude),
              modelGridElevationM: num(l.elevation),
            },
            url: `https://open-meteo.com/en/docs?latitude=${city.lat}&longitude=${city.lon}`,
          } satisfies Partial<RecordDraft>;

          const records: RecordDraft[] = [];
          if (temperature != null) {
            records.push({
              ...common,
              upstreamId: `weather-temperature:${city.key}`,
              layerId: 'weather-temperature',
              title: `${city.name}: ${fmt(temperature)} °C${weather ? `, ${weather}` : ''}`,
              description: apparent != null ? `Modelled 2 m air temperature ${fmt(temperature)} °C (feels like ${fmt(apparent)} °C).` : null,
              metric: { name: 'Air temperature (2 m)', value: temperature, unit: '°C' },
            });
          }
          if (precipitation != null && precipitation > 0) {
            records.push({
              ...common,
              upstreamId: `weather-precipitation:${city.key}`,
              layerId: 'weather-precipitation',
              title: `${city.name}: ${fmt(precipitation)} mm precipitation (${intervalText})${weather ? `, ${weather}` : ''}`,
              metric: { name: 'Precipitation', value: precipitation, unit: 'mm', period: intervalText },
            });
          }
          if ((gusts != null && gusts >= GUST_MIN_KMH) || (wind != null && wind >= WIND_MIN_KMH)) {
            const severity = severityFromThresholds(gusts, GUST_SEVERITY);
            records.push({
              ...common,
              upstreamId: `weather-wind:${city.key}`,
              layerId: 'weather-wind',
              title: `${city.name}: ${gusts != null ? `gusts ${fmt(gusts)} km/h` : ''}${gusts != null && wind != null ? ', ' : ''}${wind != null ? `wind ${fmt(wind)} km/h` : ''}`,
              severity,
              severityLabel: gusts != null ? `gusts ${fmt(gusts)} km/h` : null,
              metric: gusts != null ? { name: 'Wind gusts (10 m)', value: gusts, unit: 'km/h' } : { name: 'Wind speed (10 m)', value: wind!, unit: 'km/h' },
              derived: severity != null ? ['severity'] : [],
            });
          }
          return records;
        });
      });
    }
    return out.done();
  },
});
