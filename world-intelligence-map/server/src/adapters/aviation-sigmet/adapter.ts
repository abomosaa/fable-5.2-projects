import type { Geometry, Position } from 'geojson';
import { defineAdapter, isObject, jsonPayload, loadManifest, ParseCollector } from '../base.ts';
import { lineGeometry } from '../../core/geo.ts';
import { num, plainText, str } from '../../core/text.ts';
import { fromEpochSeconds, iso, parseTime } from '../../core/time.ts';
import type { RecordDraft, Severity } from '../../core/types.ts';
import manifestJson from './manifest.json' with { type: 'json' };

const manifest = loadManifest(manifestJson);
/** Successor of the deprecated /api/data/isigmet endpoint; returns international and U.S. domestic SIGMETs. */
const URL_SIGMET = 'https://aviationweather.gov/api/data/sigmet?format=json';

export const HAZARDS: Record<string, string> = {
  TS: 'Thunderstorms',
  CONV: 'Convective activity',
  TURB: 'Turbulence',
  ICE: 'Icing',
  MTW: 'Mountain wave',
  VA: 'Volcanic ash',
  TC: 'Tropical cyclone',
  DS: 'Dust storm',
  SS: 'Sandstorm',
  IFR: 'Instrument flight conditions',
};

/** Hazard + qualifier → severity (danger to aircraft). Derived by this application; documented in the manifest. */
export function sigmetSeverity(hazard: string | null, qualifier: string | null): Severity | null {
  const q = (qualifier ?? '').toUpperCase();
  switch (hazard) {
    case 'TC':
      return 4;
    case 'VA':
      return 3;
    case 'TURB':
    case 'ICE':
    case 'MTW':
      return /\bSEV\b/.test(q) ? 3 : 2;
    case 'TS':
    case 'CONV':
      return /\b(FRQ|SQL)\b/.test(q) ? 3 : 2;
    case 'DS':
    case 'SS':
      return /\bHVY\b/.test(q) ? 3 : 2;
    default:
      return null;
  }
}

/** Keep the part of a ring on one side of the 180° meridian (Sutherland–Hodgman against a vertical line). */
function clipRingAt180(ring: Position[], keepWest: boolean): Position[] {
  const inside = (p: Position) => (keepWest ? p[0]! <= 180 : p[0]! >= 180);
  const out: Position[] = [];
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i]!;
    const b = ring[(i + 1) % ring.length]!;
    if (inside(a)) out.push(a);
    if (inside(a) !== inside(b)) {
      const t = (180 - a[0]!) / (b[0]! - a[0]!);
      out.push([180, a[1]! + t * (b[1]! - a[1]!)]);
    }
  }
  return out;
}

const round = (p: Position): Position => [Math.round(p[0]! * 1e6) / 1e6, Math.round(p[1]! * 1e6) / 1e6];
const closed = (ring: Position[]): Position[] => {
  const a = ring[0]!;
  const b = ring[ring.length - 1]!;
  return a[0] === b[0] && a[1] === b[1] ? ring : [...ring, a];
};

/**
 * One decoded SIGMET area → polygon rings in [-180, 180].
 * AWC writes areas east of the antimeridian with longitudes above 180 (already split at 180); areas that are
 * given unsplit across the antimeridian are split here so that they do not wrap around the globe.
 * Returns a reason string when the coordinates are unusable.
 */
export function ringsFromCoords(coords: unknown): Position[][] | string {
  if (!Array.isArray(coords)) return 'no usable geometry (coords missing)';
  let ring: Position[] = [];
  for (const c of coords) {
    const lon = isObject(c) ? num(c.lon) : null;
    const lat = isObject(c) ? num(c.lat) : null;
    if (lon == null || lat == null) return 'no usable geometry (non-numeric coordinate)';
    if (lat < -90 || lat > 90 || lon < -360 || lon > 360) return `coordinate out of range (${lon}, ${lat})`;
    const prev = ring[ring.length - 1];
    if (!prev || prev[0] !== lon || prev[1] !== lat) ring.push([lon, lat]);
  }
  if (ring.length > 1 && ring[0]![0] === ring[ring.length - 1]![0] && ring[0]![1] === ring[ring.length - 1]![1]) ring.pop();
  if (ring.length < 3) return 'no usable geometry (fewer than 3 distinct positions)';
  let lons = ring.map((p) => p[0]!);
  // Unsplit crossing written as 179 … -179: unwrap into 0–360 first.
  if (Math.max(...lons) - Math.min(...lons) > 180) {
    ring = ring.map((p) => [p[0]! < 0 ? p[0]! + 360 : p[0]!, p[1]!]);
    lons = ring.map((p) => p[0]!);
  }
  const min = Math.min(...lons);
  const max = Math.max(...lons);
  if (max <= 180) return [closed(ring)];
  if (min >= 180) return [closed(ring.map((p) => [p[0]! - 360, p[1]!]))];
  const west = clipRingAt180(ring, true).map(round);
  const east = clipRingAt180(ring, false).map((p) => round([p[0]! - 360, p[1]!]));
  const parts = [west, east].filter((r) => r.length >= 3).map(closed);
  return parts.length ? parts : 'no usable geometry (degenerate area at the antimeridian)';
}

function sigmetGeometry(geom: string | null, coords: unknown): Geometry | string {
  if (!Array.isArray(coords) || coords.length === 0) return 'no usable geometry (coords missing)';
  if (geom === 'LINE') {
    const pts: Position[] = [];
    for (const c of coords) {
      const lon = isObject(c) ? num(c.lon) : null;
      const lat = isObject(c) ? num(c.lat) : null;
      if (lon == null || lat == null || lat < -90 || lat > 90 || lon < -180 || lon > 180) return 'no usable geometry (invalid line coordinate)';
      pts.push([lon, lat]);
    }
    return lineGeometry(pts) ?? 'no usable geometry (line with fewer than 2 positions)';
  }
  // "AREAS": a list of areas, each a list of positions. "AREA": one list of positions.
  const areas = Array.isArray(coords[0]) ? coords : [coords];
  const polygons: Position[][][] = [];
  for (const area of areas) {
    const rings = ringsFromCoords(area);
    if (typeof rings === 'string') return rings;
    for (const r of rings) polygons.push([r]);
  }
  return polygons.length === 1 ? { type: 'Polygon', coordinates: polygons[0]! } : { type: 'MultiPolygon', coordinates: polygons };
}

interface Sigmet {
  [key: string]: unknown;
}

export default defineAdapter({
  manifest,
  version: '1.0.0',

  async fetch(ctx) {
    return [await ctx.http.get(URL_SIGMET, { key: 'sigmet', headers: { accept: 'application/json' } })];
  },

  parse(payloads) {
    const out = new ParseCollector();
    const seen = new Set<string>();
    for (const payload of payloads) {
      const list = jsonPayload<Sigmet[]>(payload, (v) => Array.isArray(v), 'AWC SIGMET list');
      for (const item of list) {
        out.item(item, (s) => `${String(s?.icaoId)} ${String(s?.firId)} SIGMET ${String(s?.seriesId)} ${String(s?.hazard)}`, (s): RecordDraft | RecordDraft[] | string => {
          if (!isObject(s)) return 'item is not an object';
          const icaoId = str(s.icaoId, 8);
          const firId = str(s.firId, 8);
          const seriesId = str(s.seriesId, 30);
          const validFrom = fromEpochSeconds(s.validTimeFrom);
          const validTo = fromEpochSeconds(s.validTimeTo);
          if (validFrom == null || validTo == null) return 'missing validity period';
          if (validTo <= validFrom) return 'invalid validity period (end not after start)';
          if (!icaoId && !firId) return 'missing issuing office and FIR';
          const hazard = str(s.hazard, 12)?.toUpperCase() ?? null;
          const upstreamId = [icaoId ?? '-', firId ?? '-', hazard ?? '-', (seriesId ?? '-').replace(/\s+/g, '_'), Math.round(validFrom / 1000)].join(':');
          if (seen.has(upstreamId)) return [];
          const geometry = sigmetGeometry(str(s.geom)?.toUpperCase() ?? null, s.coords);
          if (typeof geometry === 'string') return geometry;
          seen.add(upstreamId);

          const qualifier = str(s.qualifier, 80);
          const hazardName = hazard ? (HAZARDS[hazard] ?? hazard) : 'hazard not decoded';
          // For VA / TC the qualifier is the volcano / cyclone name; otherwise it is an intensity or coverage code.
          const named = hazard === 'VA' || hazard === 'TC';
          const severity = sigmetSeverity(hazard, qualifier);
          const kind = str(s.sigmetType, 8)?.toUpperCase() ?? null;
          const confidence = kind === 'OBS' ? 0.9 : kind === 'FCST' ? 0.7 : null;
          const firName = plainText(s.firName, 80) || firId || icaoId!;
          const speed = num(s.spd);

          return {
            upstreamId,
            layerId: 'sigmets',
            subcategory: hazard,
            geometry,
            occurredAt: validFrom,
            publishedAt: parseTime(s.receiptTime) ?? parseTime(s.issueTime),
            expiresAt: validTo,
            severity,
            severityLabel: hazard ? (named ? [hazard, qualifier] : [qualifier, hazard]).filter(Boolean).join(' ') : null,
            confidence,
            confidenceBasis: confidence != null ? `SIGMET phenomenon reported as ${kind === 'OBS' ? 'observed (OBS)' : 'forecast (FCST)'}` : null,
            title: `SIGMET ${seriesId ?? ''} – ${hazardName}${qualifier ? ` (${plainText(qualifier, 60)})` : ''} – ${firName}`.replace(/\s+/g, ' '),
            description: plainText(s.rawSigmet, 500) || null,
            attributes: {
              issuingOffice: icaoId,
              firId,
              firName,
              seriesId,
              hazard,
              hazardName,
              qualifier,
              baseFt: num(s.base),
              topFt: num(s.top),
              movementDirection: str(s.dir, 12) === '-' ? null : str(s.dir, 12),
              movementSpeedKt: speed != null && speed > 0 ? speed : null,
              intensityChange: str(s.chng, 12),
              observedOrForecast: kind,
              validFromUtc: iso(validFrom),
              validToUtc: iso(validTo),
            },
            derived: [...(severity != null ? ['severity'] : []), ...(confidence != null ? ['confidence'] : [])],
          };
        });
      }
    }
    return out.done();
  },
});
