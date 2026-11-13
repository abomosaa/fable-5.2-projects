import { defineAdapter, loadManifest, ParseCollector } from '../base.ts';
import { pointGeometry } from '../../core/geo.ts';
import { num, parseCsv, str } from '../../core/text.ts';
import { parseTime } from '../../core/time.ts';
import type { RecordDraft } from '../../core/types.ts';
import manifestJson from './manifest.json' with { type: 'json' };

const manifest = loadManifest(manifestJson);
export const AIRPORTS_URL = 'https://davidmegginson.github.io/ourairports-data/airports.csv';

/** Columns this adapter cannot work without (see the OurAirports data dictionary). */
const REQUIRED = ['id', 'ident', 'type', 'name', 'latitude_deg', 'longitude_deg', 'iso_country', 'scheduled_service'] as const;

export default defineAdapter({
  manifest,
  version: '1.0.0',

  async fetch(ctx) {
    // ~12 MB, regenerated nightly; manifest.http.cacheTtlSec keeps us to at most one download per day.
    return [await ctx.http.get(AIRPORTS_URL, { key: 'airports' })];
  },

  parse(payloads) {
    const out = new ParseCollector();
    const seen = new Set<string>();
    for (const payload of payloads) {
      // Single pass over the file; rows are addressed by column index (no per-row objects for the ~85,000 rows we skip).
      const rows = parseCsv(payload.text());
      const header = rows[0]?.map((h) => h.trim()) ?? [];
      const col = (name: string) => header.indexOf(name);
      const missing = REQUIRED.filter((c) => col(c) < 0);
      if (missing.length) throw new Error(`malformed OurAirports airports.csv: header lacks ${missing.join(', ')} (${payload.key})`);
      out.noteUpstreamTime(parseTime(payload.lastModified));

      const c = {
        id: col('id'), ident: col('ident'), type: col('type'), name: col('name'), lat: col('latitude_deg'), lon: col('longitude_deg'),
        elev: col('elevation_ft'), country: col('iso_country'), region: col('iso_region'), municipality: col('municipality'),
        scheduled: col('scheduled_service'), icao: col('icao_code'), iata: col('iata_code'), gps: col('gps_code'),
      };
      const at = (row: string[], i: number): string | null => (i >= 0 ? str(row[i]) : null);

      for (let i = 1; i < rows.length; i++) {
        const row = rows[i]!;
        const type = row[c.type];
        const scheduled = row[c.scheduled] === 'yes';
        let layerId: string;
        if (type === 'large_airport') layerId = 'airports-large';
        else if (type === 'medium_airport' && scheduled) layerId = 'airports-medium';
        else if (row.length < header.length && !/^(small_airport|heliport|closed|closed_airport|seaplane_base|balloonport|medium_airport)$/.test(type ?? '')) {
          out.reject('truncated row', row.slice(0, 4).join(','));
          continue;
        } else continue; // small airfields, heliports, closed airports, unscheduled medium airports: not shown

        out.item(row, (r) => `${r[c.ident] ?? ''} ${r[c.name] ?? ''}`, (r): RecordDraft | string => {
          const id = at(r, c.id);
          const ident = at(r, c.ident);
          if (!id || !ident) return 'missing id or ident';
          const lon = num(r[c.lon]);
          const lat = num(r[c.lat]);
          const geometry = lon != null && lat != null && Math.abs(lon) <= 180 ? pointGeometry(lon, lat) : null;
          if (!geometry) return 'missing or invalid coordinates';
          if (seen.has(id)) return 'duplicate airport id';
          seen.add(id);
          const iata = at(r, c.iata);
          const name = at(r, c.name) ?? ident;
          return {
            // The internal id stays persistent even when an airport's code (ident) changes.
            upstreamId: id,
            layerId,
            subcategory: type!,
            geometry,
            country: at(r, c.country),
            title: iata ? `${name} (${iata})` : name,
            attributes: {
              ident,
              iataCode: iata,
              icaoCode: at(r, c.icao),
              gpsCode: at(r, c.gps),
              elevationFt: num(r[c.elev]),
              municipality: at(r, c.municipality),
              isoRegion: at(r, c.region),
              scheduledService: scheduled,
            },
            url: `https://ourairports.com/airports/${encodeURIComponent(ident)}/`,
          };
        });
      }
    }
    return out.done();
  },
});
