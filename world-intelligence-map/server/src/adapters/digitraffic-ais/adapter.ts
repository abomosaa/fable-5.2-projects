import { defineAdapter, isObject, jsonPayload, loadManifest, ParseCollector } from '../base.ts';
import { pointGeometry } from '../../core/geo.ts';
import { num, plainText } from '../../core/text.ts';
import { fromEpochMillis, parseTime } from '../../core/time.ts';
import type { RecordDraft } from '../../core/types.ts';
import manifestJson from './manifest.json' with { type: 'json' };

const manifest = loadManifest(manifestJson);
const BASE = 'https://meri.digitraffic.fi/api/ais/v1';
export const DEFAULT_DIGITRAFFIC_USER = 'world-intelligence-map/1.0';

/** Only positions reported within this window before `ctx.now` are emitted. */
export const MAX_POSITION_AGE_MS = 60 * 60_000;
const MAX_CLOCK_SKEW_MS = 5 * 60_000;

/** AIS navigational status (ITU-R M.1371), wording from the Digitraffic API description. */
const NAV_STATUS: Record<number, string> = {
  0: 'under way using engine',
  1: 'at anchor',
  2: 'not under command',
  3: 'restricted manoeuvrability',
  4: 'constrained by her draught',
  5: 'moored',
  6: 'aground',
  7: 'engaged in fishing',
  8: 'under way sailing',
  11: 'towing astern',
  12: 'pushing ahead or towing alongside',
  14: 'AIS-SART / MOB / EPIRB active',
};

/** Broad class for an AIS ship-type code (ITU-R M.1371 table 53, as passed through / collapsed by Digitraffic). */
export function shipClass(code: number | null): string | null {
  if (code == null || !Number.isInteger(code) || code < 0 || code > 255) return null;
  if (code === 0) return null; // "not available"
  switch (code) {
    case 30: return 'fishing';
    case 31: case 32: case 52: return 'tug';
    case 33: return 'dredging or underwater operations';
    case 34: return 'diving operations';
    case 35: return 'military operations';
    case 36: return 'sailing';
    case 37: return 'pleasure craft';
    case 50: return 'pilot vessel';
    case 51: return 'search and rescue';
    case 53: return 'port tender';
    case 54: return 'anti-pollution';
    case 55: return 'law enforcement';
    case 58: return 'medical transport';
  }
  if (code >= 20 && code <= 29) return 'wing in ground';
  if (code >= 40 && code <= 49) return 'high-speed craft';
  if (code >= 60 && code <= 69) return 'passenger';
  if (code >= 70 && code <= 79) return 'cargo';
  if (code >= 80 && code <= 89) return 'tanker';
  if (code >= 90 && code <= 99) return 'other';
  return 'reserved or special';
}

interface VesselMeta {
  name: string | null;
  shipType: number | null;
  destination: string | null;
  draughtM: number | null;
}
interface LocationFeature {
  mmsi?: unknown;
  geometry?: { type?: unknown; coordinates?: unknown } | null;
  properties?: Record<string, unknown> | null;
}

function mmsiOf(v: unknown): number | null {
  return typeof v === 'number' && Number.isInteger(v) && v > 0 && v <= 999_999_999 ? v : null;
}

export default defineAdapter({
  manifest,
  version: '1.0.0',

  async fetch(ctx) {
    // Digitraffic asks clients to identify the application and makes compression mandatory.
    const headers = { 'Digitraffic-User': ctx.env.DIGITRAFFIC_USER?.trim() || DEFAULT_DIGITRAFFIC_USER, 'Accept-Encoding': 'gzip' };
    return [
      await ctx.http.get(`${BASE}/locations`, { key: 'locations', headers }),
      // Static voyage data (name, type, destination, draught) changes slowly: at most one download per hour.
      await ctx.http.get(`${BASE}/vessels`, { key: 'vessels', headers, cacheTtlSec: 3600 }),
    ];
  },

  parse(payloads, ctx) {
    const out = new ParseCollector();
    const locationsPayload = payloads.find((p) => p.key === 'locations');
    const vesselsPayload = payloads.find((p) => p.key === 'vessels');
    if (!locationsPayload || !vesselsPayload) throw new Error('malformed Digitraffic AIS fetch: locations or vessels payload missing');

    const fc = jsonPayload<{ dataUpdatedTime?: unknown; features: LocationFeature[] }>(
      locationsPayload,
      (v) => isObject(v) && v.type === 'FeatureCollection' && Array.isArray(v.features),
      'Digitraffic AIS locations',
    );
    const vessels = jsonPayload<unknown[]>(vesselsPayload, (v) => Array.isArray(v), 'Digitraffic AIS vessel metadata');
    out.noteUpstreamTime(parseTime(fc.dataUpdatedTime));

    // One pass over the metadata → lookup by MMSI.
    const meta = new Map<number, VesselMeta>();
    for (const v of vessels) {
      const mmsi = isObject(v) ? mmsiOf(v.mmsi) : null;
      if (!isObject(v) || mmsi == null) {
        out.reject('vessel metadata without a valid mmsi', isObject(v) ? String(v.name ?? '') : String(v));
        continue;
      }
      const shipType = num(v.shipType);
      const draught = num(v.draught);
      meta.set(mmsi, {
        name: plainText(v.name, 40) || null,
        shipType: shipType != null && Number.isInteger(shipType) && shipType >= 0 && shipType <= 255 ? shipType : null,
        destination: plainText(v.destination, 40) || null,
        // 1/10 m; 0 = not available; 255 = 25.5 m or more.
        draughtM: draught != null && draught > 0 && draught <= 255 ? draught / 10 : null,
      });
    }

    const seen = new Set<number>();
    for (const feature of fc.features) {
      out.item(feature, (f) => `mmsi ${String(f?.mmsi ?? f?.properties?.mmsi)}`, (f): RecordDraft | RecordDraft[] | string => {
        const p = f?.properties;
        if (f == null || typeof f !== 'object' || !isObject(p)) return 'feature without properties';
        const mmsi = mmsiOf(f.mmsi ?? p.mmsi);
        if (mmsi == null) return 'missing or invalid mmsi';
        const coords = f.geometry?.coordinates;
        if (!Array.isArray(coords)) return 'missing geometry';
        if (coords[0] === 181 && coords[1] === 91) return []; // AIS "position not available" default
        const geometry = typeof coords[0] === 'number' && typeof coords[1] === 'number' && Math.abs(coords[0]) <= 180 ? pointGeometry(coords[0], coords[1]) : null;
        if (!geometry) return 'invalid coordinates';
        const occurredAt = typeof p.timestampExternal === 'number' ? fromEpochMillis(p.timestampExternal) : null;
        if (occurredAt == null) return 'missing position time';
        if (occurredAt > ctx.now + MAX_CLOCK_SKEW_MS) return 'position time is in the future';
        if (ctx.now - occurredAt > MAX_POSITION_AGE_MS) return []; // not a current position any more
        if (seen.has(mmsi)) return [];
        seen.add(mmsi);

        const m = meta.get(mmsi);
        const sog = num(p.sog);
        const cog = num(p.cog);
        const heading = num(p.heading);
        const navStat = num(p.navStat);
        const cls = shipClass(m?.shipType ?? null);
        return {
          upstreamId: String(mmsi),
          layerId: 'vessels-baltic',
          subcategory: cls,
          geometry,
          occurredAt,
          title: m?.name ?? `MMSI ${mmsi}`,
          attributes: {
            mmsi,
            name: m?.name ?? null,
            shipTypeCode: m?.shipType ?? null,
            shipClass: cls,
            speedKn: sog != null && sog >= 0 && sog < 102.3 ? sog : null, // 102.3 = not available
            courseDeg: cog != null && cog >= 0 && cog < 360 ? cog : null, // 360 = not available
            headingDeg: heading != null && heading >= 0 && heading <= 359 ? heading : null, // 511 = not available
            navStatusCode: navStat,
            navStatus: navStat != null ? (NAV_STATUS[navStat] ?? (navStat === 15 ? null : 'reserved')) : null,
            destination: m?.destination ?? null,
            draughtM: m?.draughtM ?? null,
            positionAccuracyHigh: typeof p.posAcc === 'boolean' ? p.posAcc : null,
          },
        };
      });
    }
    return out.done();
  },
});
