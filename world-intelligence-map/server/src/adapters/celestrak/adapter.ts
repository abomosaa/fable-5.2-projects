import { degreesLat, degreesLong, eciToGeodetic, gstime, propagate, twoline2satrec, type SatRec } from 'satellite.js';
import { defineAdapter, isObject, jsonPayload, loadManifest, ParseCollector } from '../base.ts';
import { pointGeometry } from '../../core/geo.ts';
import { num, plainText, str } from '../../core/text.ts';
import { DAY, HOUR, iso } from '../../core/time.ts';
import type { FetchContext, FetchedPayload, RecordDraft } from '../../core/types.ts';
import manifestJson from './manifest.json' with { type: 'json' };

const manifest = loadManifest(manifestJson);

/** CelesTrak GROUP → layer. */
export const GROUPS: Record<string, string> = {
  stations: 'sat-stations',
  gnss: 'sat-navigation',
  weather: 'sat-weather',
  resource: 'sat-earth-observation',
};
export const MAX_ELEMENT_AGE_DAYS = 30;
/** After any upstream error nothing is requested from CelesTrak for this long (its temporary blocks last 2 hours). */
export const BACKOFF_MS = 2 * HOUR;
/** TTL used while backing off: serve whatever element sets are cached without contacting CelesTrak. */
const CACHE_ONLY_TTL_SEC = 7 * 86_400;

export const groupUrl = (group: string) => `https://celestrak.org/NORAD/elements/gp.php?GROUP=${group}&FORMAT=json`;

export interface Omm {
  [key: string]: unknown;
}

/** Calendar parts of an OMM EPOCH ("2026-11-10T04:12:02.822688", UTC, microsecond precision). */
function epochParts(epoch: unknown): { ms: number; year: number; dayOfYear: number } | null {
  const m = typeof epoch === 'string' ? /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2}(?:\.\d+)?)Z?$/.exec(epoch.trim()) : null;
  if (!m) return null;
  const [year, month, day, hour, minute] = [+m[1]!, +m[2]!, +m[3]!, +m[4]!, +m[5]!];
  const second = Number(m[6]);
  const midnight = Date.UTC(year, month - 1, day);
  const check = new Date(midnight);
  if (check.getUTCMonth() !== month - 1 || check.getUTCDate() !== day || hour > 23 || minute > 59 || second >= 61) return null;
  const secOfDay = hour * 3600 + minute * 60 + second;
  return { ms: midnight + Math.round(secOfDay * 1000), year, dayOfYear: (midnight - Date.UTC(year, 0, 1)) / DAY + 1 + secOfDay / 86400 };
}

/** TLE "assumed decimal point" exponent notation, e.g. 0.00017575 → " 17575-3". */
function tleExp(value: number): string {
  if (value === 0 || Math.abs(value) < 1e-10) return ' 00000-0';
  let exp = Math.floor(Math.log10(Math.abs(value))) + 1;
  let mantissa = Math.round((Math.abs(value) / 10 ** exp) * 1e5);
  if (mantissa >= 100000) {
    mantissa = 10000;
    exp += 1;
  }
  if (exp > 9) throw new Error('drag term too large for a TLE');
  return `${value < 0 ? '-' : ' '}${String(mantissa).padStart(5, '0')}${exp < 0 ? '-' : '+'}${Math.abs(exp)}`;
}

/**
 * Initialise an SGP4 satellite record from OMM mean elements.
 * satellite.js 5 only accepts two-line element sets, so the OMM values are written into TLE columns (the precision
 * of both formats is the same for angles and mean motion). The catalogue number is cosmetic for SGP4, which lets
 * 6-digit numbers (≥ 100000, which no longer fit a TLE) pass through.
 * Returns a reason string when the elements are unusable.
 */
export function ommToSatrec(omm: Omm): SatRec | string {
  const epoch = epochParts(omm.EPOCH);
  if (!epoch) return 'missing or unparseable EPOCH';
  const n = num(omm.MEAN_MOTION);
  const ecc = num(omm.ECCENTRICITY);
  const incl = num(omm.INCLINATION);
  const raan = num(omm.RA_OF_ASC_NODE);
  const argp = num(omm.ARG_OF_PERICENTER);
  const ma = num(omm.MEAN_ANOMALY);
  if (n == null || ecc == null || incl == null || raan == null || argp == null || ma == null) return 'missing orbital elements';
  if (n <= 0 || n >= 100 || ecc < 0 || ecc >= 1 || incl < 0 || incl > 180) return 'orbital elements out of range';
  const angle = (deg: number) => ((((deg % 360) + 360) % 360).toFixed(4)).padStart(8, ' ');
  const bstar = num(omm.BSTAR) ?? 0;
  const ndot = num(omm.MEAN_MOTION_DOT) ?? 0;
  const ndotText = `${ndot < 0 ? '-' : ' '}${Math.min(Math.abs(ndot), 0.99999999).toFixed(8).slice(1)}`;
  const sat = String(Math.abs(Math.trunc(num(omm.NORAD_CAT_ID) ?? 0)) % 100000).padStart(5, '0');
  const yy = String(epoch.year % 100).padStart(2, '0');
  const day = epoch.dayOfYear.toFixed(8).padStart(12, '0');
  const eccText = String(Math.min(9999999, Math.round(ecc * 1e7))).padStart(7, '0');
  const line1 = `1 ${sat}U 00000A   ${yy}${day} ${ndotText}  00000-0 ${tleExp(bstar)} 0  9990`;
  const line2 = `2 ${sat} ${incl.toFixed(4).padStart(8, ' ')} ${angle(raan)} ${eccText} ${angle(argp)} ${angle(ma)} ${n.toFixed(8).padStart(11, ' ')}    00`;
  const satrec = twoline2satrec(line1, line2);
  return satrec.error ? `SGP4 initialisation error ${satrec.error}` : satrec;
}

export interface SatPosition {
  lon: number;
  lat: number;
  altitudeKm: number;
  speedKmS: number;
}

/** Sub-satellite point (WGS84 geodetic), altitude and inertial speed at `whenMs`; a reason string when SGP4 fails. */
export function propagateTo(satrec: SatRec, whenMs: number): SatPosition | string {
  const when = new Date(whenMs);
  const pv = propagate(satrec, when);
  const pos = pv?.position;
  const vel = pv?.velocity;
  if (satrec.error || !pos || typeof pos === 'boolean' || !vel || typeof vel === 'boolean') return `SGP4 propagation error ${satrec.error || 'unknown'}`;
  const geo = eciToGeodetic(pos, gstime(when));
  const out = { lon: degreesLong(geo.longitude), lat: degreesLat(geo.latitude), altitudeKm: geo.height, speedKmS: Math.hypot(vel.x, vel.y, vel.z) };
  if (![out.lon, out.lat, out.altitudeKm, out.speedKmS].every(Number.isFinite)) return 'SGP4 produced a non-finite position';
  return out;
}

function orbitClass(periodMin: number, ecc: number): string {
  if (ecc >= 0.25) return 'HEO';
  if (periodMin < 128) return 'LEO';
  if (periodMin > 1400 && periodMin < 1470) return 'GEO';
  return periodMin < 1400 ? 'MEO' : 'high';
}

/** Confidence from element age (days). Derived by this application; see manifest.confidenceNotes. */
export function ageConfidence(ageDays: number): number {
  const a = Math.abs(ageDays);
  return a <= 2 ? 0.9 : a <= 7 ? 0.7 : a <= 14 ? 0.5 : 0.3;
}

/**
 * One group, honouring CelesTrak's usage policy: at most one download per 2 hours (manifest cacheTtlSec), no retries,
 * and after any upstream error no further requests for BACKOFF_MS – the cached element sets keep being propagated.
 */
async function getGroup(ctx: FetchContext, group: string, backingOff: boolean): Promise<FetchedPayload> {
  const url = groupUrl(group);
  const haveKey = `have:${group}`;
  const armBackoff = () => ctx.cursor.set('blockedUntil', String(ctx.now + BACKOFF_MS));
  const cachedOnly = async (cause?: unknown): Promise<FetchedPayload> => {
    if (ctx.cursor.get(haveKey) !== '1') {
      throw cause ?? new Error(`CelesTrak back-off after an upstream error: not requesting GROUP=${group} until ${iso(Number(ctx.cursor.get('blockedUntil')))} (usage policy)`);
    }
    try {
      return await ctx.http.get(url, { key: group, cacheTtlSec: CACHE_ONLY_TTL_SEC });
    } catch (err) {
      // The cache did not hold the group after all and upstream failed again: stay silent until the back-off ends.
      ctx.cursor.set(haveKey, '');
      armBackoff();
      throw err;
    }
  };
  if (backingOff) return cachedOnly();
  let payload: FetchedPayload;
  try {
    payload = await ctx.http.get(url, { key: group });
  } catch (err) {
    armBackoff();
    return cachedOnly(err);
  }
  if (payload.stale) armBackoff(); // upstream failed, the client fell back to its cached copy
  ctx.cursor.set(haveKey, '1');
  return payload;
}

export default defineAdapter({
  manifest,
  version: '1.0.0',

  async fetch(ctx) {
    const backingOff = ctx.now < Number(ctx.cursor.get('blockedUntil') ?? 0);
    const payloads = [];
    for (const group of Object.keys(GROUPS)) payloads.push(await getGroup(ctx, group, backingOff));
    return payloads;
  },

  parse(payloads, ctx) {
    const out = new ParseCollector();
    for (const payload of payloads) {
      const layerId = GROUPS[payload.key];
      if (!layerId) throw new Error(`malformed CelesTrak payload: unknown group "${payload.key}"`);
      // Errors come back as plain text ("Invalid query: …", "No GP data found"), which fails the JSON check.
      const list = jsonPayload<Omm[]>(payload, (v) => Array.isArray(v), 'CelesTrak OMM JSON');
      const seen = new Set<number>();
      let newestEpoch: number | null = null;
      for (const omm of list) {
        out.item(omm, (o) => `${String(o?.NORAD_CAT_ID)} ${String(o?.OBJECT_NAME)}`, (o): RecordDraft | RecordDraft[] | string => {
          if (!isObject(o)) return 'element set is not an object';
          const norad = num(o.NORAD_CAT_ID);
          if (norad == null || !Number.isInteger(norad) || norad < 1) return 'missing NORAD_CAT_ID';
          if (seen.has(norad)) return [];
          const epoch = epochParts(o.EPOCH);
          if (!epoch) return 'missing or unparseable EPOCH';
          const ageDays = (ctx.now - epoch.ms) / DAY;
          if (Math.abs(ageDays) > MAX_ELEMENT_AGE_DAYS) return `element set older than ${MAX_ELEMENT_AGE_DAYS} days (${ageDays.toFixed(1)} days)`;
          const satrec = ommToSatrec(o);
          if (typeof satrec === 'string') return satrec;
          const p = propagateTo(satrec, ctx.now);
          if (typeof p === 'string') return p;
          if (p.altitudeKm < 80) return `propagated altitude ${p.altitudeKm.toFixed(0)} km is not an orbit (decayed or bad elements)`;
          const geometry = pointGeometry(Math.round(p.lon * 1e4) / 1e4, Math.round(p.lat * 1e4) / 1e4);
          if (!geometry) return 'SGP4 produced an invalid position';
          seen.add(norad);
          if (newestEpoch == null || epoch.ms > newestEpoch) newestEpoch = epoch.ms;

          const name = plainText(o.OBJECT_NAME, 80) || `NORAD ${norad}`;
          const meanMotion = num(o.MEAN_MOTION)!;
          const periodMin = 1440 / meanMotion;
          const ecc = num(o.ECCENTRICITY)!;
          const cls = orbitClass(periodMin, ecc);
          const ageHours = Math.round(((ctx.now - epoch.ms) / HOUR) * 10) / 10;
          return {
            upstreamId: `${payload.key}:${norad}`,
            layerId,
            subcategory: cls,
            geometry,
            occurredAt: ctx.now,
            updatedAt: epoch.ms,
            confidence: ageConfidence(ageDays),
            confidenceBasis: `Position computed with SGP4 from an element set ${ageHours} h old; accuracy degrades with element age`,
            title: name,
            description: `Computed sub-satellite point of ${name}, ${Math.round(p.altitudeKm)} km above the surface (${cls} orbit).`,
            attributes: {
              noradCatId: norad,
              internationalDesignator: str(o.OBJECT_ID, 20),
              altitudeKm: Math.round(p.altitudeKm * 10) / 10,
              speedKmS: Math.round(p.speedKmS * 1000) / 1000,
              orbitClass: cls,
              periodMin: Math.round(periodMin * 100) / 100,
              inclinationDeg: num(o.INCLINATION),
              eccentricity: ecc,
              elementEpochUtc: iso(epoch.ms),
              elementAgeHours: ageHours,
              positionComputed: true,
            },
            url: `https://celestrak.org/NORAD/elements/gp.php?CATNR=${norad}&FORMAT=json`,
            derived: ['geometry', 'confidence'],
          };
        });
      }
      out.noteUpstreamTime(newestEpoch);
    }
    return out.done();
  },
});
