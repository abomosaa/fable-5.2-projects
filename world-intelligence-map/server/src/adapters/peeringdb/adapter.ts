import { defineAdapter, isObject, jsonPayload, loadManifest, ParseCollector } from '../base.ts';
import { pointGeometry } from '../../core/geo.ts';
import { num, str } from '../../core/text.ts';
import { parseTime } from '../../core/time.ts';
import type { RecordDraft } from '../../core/types.ts';
import manifestJson from './manifest.json' with { type: 'json' };

const manifest = loadManifest(manifestJson);

/**
 * Only the fields needed to place and describe a facility. Contact fields (sales/tech e-mail and phone) and the
 * street address are deliberately never requested – see the Acceptable Use Policy notes in the manifest.
 */
export const FIELDS = [
  'id', 'name', 'aka', 'org_id', 'org_name', 'campus_id', 'city', 'state', 'country', 'region_continent',
  'latitude', 'longitude', 'net_count', 'ix_count', 'carrier_count', 'clli', 'status', 'created', 'updated',
] as const;

/**
 * One request for the whole facility table (≈ 5,900 rows, ≈ 2.7 MB). PeeringDB asks for "fewer, larger queries",
 * limits identical anonymous requests above 100 kB to one per hour and wants ≥ 2 s between queries – hence a single
 * un-paged request, a weekly poll and a cache TTL of six days (manifest.http).
 */
export const FACILITIES_URL = `https://www.peeringdb.com/api/fac?status=ok&depth=0&fields=${FIELDS.join(',')}`;

interface PdbFacility {
  id?: unknown;
  name?: unknown;
  aka?: unknown;
  org_id?: unknown;
  org_name?: unknown;
  campus_id?: unknown;
  city?: unknown;
  state?: unknown;
  country?: unknown;
  region_continent?: unknown;
  latitude?: unknown;
  longitude?: unknown;
  net_count?: unknown;
  ix_count?: unknown;
  carrier_count?: unknown;
  clli?: unknown;
  status?: unknown;
  created?: unknown;
  updated?: unknown;
}

const blank = (v: unknown): boolean => v == null || (typeof v === 'string' && v.trim() === '');
const count = (v: unknown): number | null => {
  const n = num(v);
  return n != null && n >= 0 ? n : null;
};
const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

export default defineAdapter({
  manifest,
  version: '1.0.0',

  async fetch(ctx) {
    // The key is optional: guests may query the API. It only ever travels in the Authorization header, never in the URL.
    const apiKey = ctx.env.PEERINGDB_API_KEY?.trim();
    return [
      await ctx.http.get(FACILITIES_URL, {
        key: 'fac',
        headers: { accept: 'application/json', ...(apiKey ? { authorization: `Api-Key ${apiKey}` } : {}) },
      }),
    ];
  },

  parse(payloads) {
    const out = new ParseCollector();
    const seen = new Set<string>();
    for (const payload of payloads) {
      // Envelope: { "data": [ {facility}, … ], "meta": {} }. Errors come back as { "meta": { "error": "…" } } without data.
      const body = jsonPayload<{ data: unknown[] }>(payload, (v) => isObject(v) && Array.isArray(v.data), 'PeeringDB API response');
      for (const row of body.data) {
        if (isObject(row)) {
          const f = row as PdbFacility;
          // Not records: anything PeeringDB does not list as live, and the ~10 % of facilities registered without coordinates.
          if (str(f.status) != null && str(f.status) !== 'ok') continue;
          if (blank(f.latitude) || blank(f.longitude)) continue;
        }
        out.item(row, (r) => (isObject(r) ? `fac ${String(r.id)} ${String(r.name ?? '')}` : JSON.stringify(r) ?? typeof r), (r): RecordDraft | RecordDraft[] | string => {
          if (!isObject(r)) return 'facility is not an object';
          const f = r as PdbFacility;
          const id = num(f.id);
          if (id == null || !Number.isInteger(id) || id <= 0) return 'missing or invalid facility id';
          const name = str(f.name, 200);
          if (!name) return 'missing facility name';
          const lat = num(f.latitude);
          const lon = num(f.longitude);
          if (lat == null || lon == null) return 'non-numeric coordinates';
          if (lat === 0 && lon === 0) return 'placeholder coordinates (0, 0)';
          // PeeringDB documents longitudes within ±180; do not let pointGeometry wrap an out-of-range value into a plausible place.
          const geometry = Math.abs(lon) <= 180 ? pointGeometry(lon, lat) : null;
          if (!geometry) return 'coordinates out of range';
          if (seen.has(String(id))) return []; // repeated row (overlapping pages / upstream duplicate)
          seen.add(String(id));

          const updatedAt = parseTime(str(f.updated));
          out.noteUpstreamTime(updatedAt);
          const org = str(f.org_name, 200);
          const city = str(f.city, 120);
          const countryCode = str(f.country, 8)?.toUpperCase() ?? null;
          const netCount = count(f.net_count);
          const ixCount = count(f.ix_count);
          const carrierCount = count(f.carrier_count);
          const place = [city, countryCode].filter(Boolean).join(', ');
          const presence = [
            netCount != null ? plural(netCount, 'network', 'networks') : null,
            ixCount != null ? plural(ixCount, 'internet exchange', 'internet exchanges') : null,
            carrierCount != null ? plural(carrierCount, 'carrier', 'carriers') : null,
          ].filter(Boolean);

          return {
            upstreamId: String(id),
            layerId: 'data-centers',
            geometry,
            country: countryCode,
            updatedAt,
            title: name,
            description:
              `Interconnection facility${org && org !== name ? ` of ${org}` : ''}${place ? ` in ${place}` : ''}.` +
              (presence.length ? ` Registered in PeeringDB as present: ${presence.join(', ')}.` : ''),
            attributes: {
              orgName: org,
              orgId: num(f.org_id),
              alsoKnownAs: str(f.aka, 200),
              city,
              state: str(f.state, 120),
              countryCode,
              regionContinent: str(f.region_continent, 60),
              netCount,
              ixCount,
              carrierCount,
              clli: str(f.clli, 40),
              campusId: num(f.campus_id),
              registeredAt: parseTime(str(f.created)) != null ? str(f.created, 40) : null,
            },
            url: `https://www.peeringdb.com/fac/${id}`,
          };
        });
      }
    }
    return out.done();
  },
});
