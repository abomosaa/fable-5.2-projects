import { defineAdapter, getEach, isObject, jsonPayload, loadManifest, ParseCollector } from '../base.ts';
import { toIso3 } from '../../core/countries.ts';
import { num, str } from '../../core/text.ts';
import { parseTime, yearStart } from '../../core/time.ts';
import type { RecordDraft } from '../../core/types.ts';
import manifestJson from './manifest.json' with { type: 'json' };

const manifest = loadManifest(manifestJson);

/** World Bank indicator code → layer id. */
export const INDICATORS: Record<string, string> = {
  'SP.POP.TOTL': 'wb-population',
  'NY.GDP.PCAP.CD': 'wb-gdp-per-capita',
  'SP.DYN.LE00.IN': 'wb-life-expectancy',
  'SH.DYN.MORT': 'wb-under5-mortality',
  'IT.NET.USER.ZS': 'wb-internet-users',
  'EG.ELC.ACCS.ZS': 'wb-electricity-access',
  'FP.CPI.TOTL.ZG': 'wb-inflation',
  'SL.UEM.TOTL.ZS': 'wb-unemployment',
};

/** Number of past years requested (values are published with a lag, so recent years are often empty). */
export const YEARS_BACK = 6;

interface WbRow {
  indicator?: { id?: unknown; value?: unknown };
  country?: { id?: unknown; value?: unknown };
  countryiso3code?: unknown;
  date?: unknown;
  value?: unknown;
  obs_status?: unknown;
}

export default defineAdapter({
  manifest,
  version: '1.0.0',

  async fetch(ctx) {
    // One request per indicator, for an explicit year range. The API intermittently answers individual requests with
    // HTTP 502 or stalls (observed 2026-11-10, independent of the query style), so a failed indicator must not discard
    // the others: it is retried on the next run while the successful ones are served from the TTL cache.
    const year = new Date(ctx.now).getUTCFullYear();
    return getEach(
      ctx,
      Object.keys(INDICATORS).map((code) => ({
        url: `https://api.worldbank.org/v2/country/all/indicator/${code}?format=json&date=${year - YEARS_BACK}:${year}&per_page=20000`,
        opts: { key: code },
      })),
    );
  },

  parse(payloads) {
    const out = new ParseCollector();
    for (const payload of payloads) {
      // Response shape: [ { page, pages, lastupdated, ... }, [ rows ] ]. Errors come back as [ { message: [...] } ].
      const body = jsonPayload<[Record<string, unknown>, WbRow[] | null]>(
        payload,
        (v) => Array.isArray(v) && v.length === 2 && isObject(v[0]) && (Array.isArray(v[1]) || v[1] === null),
        'World Bank API response',
      );
      const meta = body[0];
      const lastUpdated = parseTime(str(meta.lastupdated));
      out.noteUpstreamTime(lastUpdated);
      for (const row of body[1] ?? []) {
        if (row?.value == null) continue; // no observation for that year – not an error
        const code3 = str(row.countryiso3code);
        const iso3 = toIso3(code3) ?? toIso3(str(row.country?.id));
        if (!iso3) continue; // regional / income aggregates (WLD, AFE, …) are not countries
        out.item(row, (r) => `${String(r.indicator?.id)} ${String(r.countryiso3code)} ${String(r.date)}`, (r): RecordDraft | string => {
          const code = str(r.indicator?.id);
          const layerId = code ? INDICATORS[code] : undefined;
          if (!code || !layerId) return `unexpected indicator ${String(code)}`;
          const value = num(r.value);
          const occurredAt = yearStart(String(r.date));
          if (value == null) return 'non-numeric value';
          if (occurredAt == null) return `unparseable period "${String(r.date)}"`;
          const layer = manifest.layers.find((l) => l.id === layerId)!;
          const name = str(r.indicator?.value) ?? layer.metric!.name;
          const countryName = str(r.country?.value) ?? iso3;
          return {
            upstreamId: `${code}:${iso3}:${String(r.date)}`,
            layerId,
            country: iso3,
            occurredAt,
            updatedAt: lastUpdated,
            title: `${name} – ${countryName} (${String(r.date)})`,
            metric: { name, value, unit: layer.metric!.unit, period: String(r.date) },
            attributes: { indicatorCode: code, year: Number(r.date), observationStatus: str(r.obs_status), worldBankCountryCode: str(row.country?.id) },
            url: `https://data.worldbank.org/indicator/${code}?locations=${encodeURIComponent(String(row.country?.id ?? ''))}`,
          };
        });
      }
    }
    return out.done();
  },
});
