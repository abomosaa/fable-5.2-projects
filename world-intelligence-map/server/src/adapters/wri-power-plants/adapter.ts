import { defineAdapter, loadManifest, ParseCollector } from '../base.ts';
import { pointGeometry } from '../../core/geo.ts';
import { num, parseCsv, str } from '../../core/text.ts';
import type { AttrValue, RecordDraft } from '../../core/types.ts';
import manifestJson from './manifest.json' with { type: 'json' };

const manifest = loadManifest(manifestJson);
export const GPPD_URL = 'https://raw.githubusercontent.com/wri/global-power-plant-database/master/output_database/global_power_plant_database.csv';

/** Plants below this capacity are not shown, except nuclear plants (all sizes). */
export const MIN_CAPACITY_MW = 50;

/** primary_fuel (the 15 values used by the database) → layer. */
export const FUEL_LAYER: Record<string, string> = {
  Nuclear: 'power-nuclear',
  Coal: 'power-fossil',
  Gas: 'power-fossil',
  Oil: 'power-fossil',
  Petcoke: 'power-fossil',
  Cogeneration: 'power-fossil',
  Hydro: 'power-hydro',
  Solar: 'power-renewable',
  Wind: 'power-renewable',
  Geothermal: 'power-renewable',
  Biomass: 'power-renewable',
  Waste: 'power-renewable',
  'Wave and Tidal': 'power-renewable',
  Storage: 'power-renewable',
  Other: 'power-renewable',
};

const REQUIRED = ['country', 'name', 'gppd_idnr', 'capacity_mw', 'latitude', 'longitude', 'primary_fuel'] as const;
const REPORTED_YEARS = [2019, 2018, 2017, 2016, 2015, 2014, 2013];
const ESTIMATED_YEARS = [2017, 2016, 2015, 2014, 2013];

export default defineAdapter({
  manifest,
  version: '1.0.0',

  async fetch(ctx) {
    // ~12 MB static file (no release since 2021); manifest.http.cacheTtlSec limits us to one download per week.
    return [await ctx.http.get(GPPD_URL, { key: 'gppd' })];
  },

  parse(payloads) {
    const out = new ParseCollector();
    const seen = new Set<string>();
    for (const payload of payloads) {
      // Single pass; rows are addressed by column index so the ~24,000 plants below the display threshold cost almost nothing.
      const rows = parseCsv(payload.text());
      const header = rows[0]?.map((h) => h.trim()) ?? [];
      const col = (name: string) => header.indexOf(name);
      const missing = REQUIRED.filter((c) => col(c) < 0);
      if (missing.length) throw new Error(`malformed Global Power Plant Database CSV: header lacks ${missing.join(', ')} (${payload.key})`);

      const c = {
        country: col('country'), countryLong: col('country_long'), name: col('name'), id: col('gppd_idnr'), capacity: col('capacity_mw'),
        lat: col('latitude'), lon: col('longitude'), fuel: col('primary_fuel'), other: [col('other_fuel1'), col('other_fuel2'), col('other_fuel3')],
        year: col('commissioning_year'), owner: col('owner'), source: col('source'), url: col('url'), capacityYear: col('year_of_capacity_data'),
        generationSource: col('generation_data_source'),
        reported: REPORTED_YEARS.map((y) => [y, col(`generation_gwh_${y}`)] as const),
        estimated: ESTIMATED_YEARS.map((y) => [y, col(`estimated_generation_gwh_${y}`)] as const),
      };
      const at = (row: string[], i: number): string | null => (i >= 0 ? str(row[i]) : null);
      /** Most recent year with a value. */
      const latest = (row: string[], cols: readonly (readonly [number, number])[]): { year: number; gwh: number } | null => {
        for (const [year, i] of cols) {
          const v = i >= 0 ? num(row[i]) : null;
          if (v != null) return { year, gwh: Math.round(v * 100) / 100 };
        }
        return null;
      };

      for (let i = 1; i < rows.length; i++) {
        const row = rows[i]!;
        const fuel = (row[c.fuel] ?? '').trim();
        const capacityMw = num(row[c.capacity]);
        // Display filter (documented in the manifest): everything nuclear, other fuels from 50 MW.
        if (fuel !== 'Nuclear' && capacityMw != null && capacityMw > 0 && capacityMw < MIN_CAPACITY_MW) continue;

        out.item(row, (r) => `${r[c.id] ?? ''} ${r[c.name] ?? ''}`, (r): RecordDraft | string => {
          const id = at(r, c.id);
          if (!id) return 'missing gppd_idnr';
          const layerId = FUEL_LAYER[fuel];
          if (!layerId) return `unknown primary_fuel "${fuel.slice(0, 30)}"`;
          if (capacityMw == null || capacityMw <= 0) return 'missing or invalid capacity_mw';
          const lon = num(r[c.lon]);
          const lat = num(r[c.lat]);
          const geometry = lon != null && lat != null && Math.abs(lon) <= 180 ? pointGeometry(lon, lat) : null;
          if (!geometry) return 'missing or invalid coordinates';
          if (seen.has(id)) return 'duplicate gppd_idnr';
          seen.add(id);

          const name = at(r, c.name) ?? id;
          const year = num(r[c.year]);
          const reported = latest(r, c.reported);
          const estimated = latest(r, c.estimated);
          const otherFuels = c.other.map((j) => at(r, j)).filter((v): v is string => !!v);
          const countryName = at(r, c.countryLong);
          const attributes: Record<string, AttrValue> = {
            capacityMw,
            primaryFuel: fuel,
            otherFuels: otherFuels.length ? otherFuels.join(', ') : null,
            // Capacity-weighted average over units where they differ, hence fractional upstream; shown as a whole year.
            commissioningYear: year != null && year > 1800 && year < 2100 ? Math.round(year) : null,
            reportedGenerationGwh: reported?.gwh ?? null,
            reportedGenerationYear: reported?.year ?? null,
            estimatedGenerationGwh: estimated?.gwh ?? null,
            estimatedGenerationYear: estimated?.year ?? null,
            owner: at(r, c.owner),
            sourceName: at(r, c.source),
            generationDataSource: at(r, c.generationSource),
            capacityDataYear: num(r[c.capacityYear]),
          };
          return {
            upstreamId: id,
            layerId,
            subcategory: fuel,
            geometry,
            country: at(r, c.country),
            title: name,
            description: `${fuel} power plant, ${capacityMw.toLocaleString('en-US', { maximumFractionDigits: 1 })} MW${countryName ? `, ${countryName}` : ''} (WRI Global Power Plant Database, 2021 snapshot).`,
            attributes,
            url: at(r, c.url),
          };
        });
      }
    }
    return out.done();
  },
});
