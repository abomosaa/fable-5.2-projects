import { defineAdapter, isObject, jsonPayload, loadManifest, ParseCollector, severityFromThresholds } from '../base.ts';
import { pointGeometry } from '../../core/geo.ts';
import { num, str } from '../../core/text.ts';
import { parseTime } from '../../core/time.ts';
import type { RecordDraft, Severity } from '../../core/types.ts';
import manifestJson from './manifest.json' with { type: 'json' };

const manifest = loadManifest(manifestJson);

/** Classification codes from the NHC JSON file reference. */
const CLASSIFICATIONS: Record<string, { name: string; severity: Severity }> = {
  TD: { name: 'Tropical Depression', severity: 1 },
  STD: { name: 'Subtropical Depression', severity: 1 },
  TS: { name: 'Tropical Storm', severity: 2 },
  STS: { name: 'Subtropical Storm', severity: 2 },
  HU: { name: 'Hurricane', severity: 3 },
  TY: { name: 'Typhoon', severity: 3 },
  PTC: { name: 'Post-Tropical Cyclone', severity: 1 },
  PC: { name: 'Potential Tropical Cyclone', severity: 1 },
};

const BASINS: Record<string, string> = { al: 'Atlantic', ep: 'Eastern Pacific', cp: 'Central Pacific' };

/** "22.9N" / "79.9W" → signed decimal degrees. */
function hemisphereCoordinate(value: unknown, positive: string, negative: string): number | null {
  const m = typeof value === 'string' ? /^\s*(\d+(?:\.\d+)?)\s*([A-Za-z])\s*$/.exec(value) : null;
  if (!m) return null;
  const h = m[2]!.toUpperCase();
  if (h !== positive && h !== negative) return null;
  return Number(m[1]) * (h === negative ? -1 : 1);
}

/** Only http(s) links are kept (as attributes and as the record link). */
function link(value: unknown): string | null {
  const s = str(value, 300);
  return s && /^https?:\/\//i.test(s) ? s : null;
}

/** Advisory product objects ({ advNum, issuance, url | kmzFile … }) are optional and may be null. */
function product(storm: Record<string, unknown>, key: string): Record<string, unknown> {
  const v = storm[key];
  return isObject(v) ? v : {};
}

export default defineAdapter({
  manifest,
  version: '1.0.0',

  async fetch(ctx) {
    return [await ctx.http.get('https://www.nhc.noaa.gov/CurrentStorms.json', { key: 'current-storms' })];
  },

  parse(payloads) {
    const out = new ParseCollector();
    for (const payload of payloads) {
      // { "activeStorms": [] } is a valid document: no active storms.
      const body = jsonPayload<{ activeStorms: unknown[] }>(payload, (v) => isObject(v) && Array.isArray(v.activeStorms), 'NHC CurrentStorms.json');
      for (const raw of body.activeStorms) {
        out.item(raw, (x) => (isObject(x) ? `${String(x.id)} ${String(x.name ?? '')}` : String(x)), (s): RecordDraft | string => {
          if (!isObject(s)) return 'storm is not an object';
          const id = str(s.id)?.toLowerCase() ?? null;
          if (!id || !/^[a-z]{2}\d{6}$/.test(id)) return 'missing or invalid storm id';
          const lat = num(s.latitudeNumeric) ?? num(s.latitude_numeric) ?? hemisphereCoordinate(s.latitude, 'N', 'S');
          const lon = num(s.longitudeNumeric) ?? num(s.longitude_numeric) ?? hemisphereCoordinate(s.longitude, 'E', 'W');
          const geometry = pointGeometry(lon, lat);
          if (!geometry) return 'missing or invalid coordinates';
          const lastUpdate = parseTime(s.lastUpdate);
          if (lastUpdate == null) return 'missing or unparseable lastUpdate';
          out.noteUpstreamTime(lastUpdate);

          const code = str(s.classification)?.toUpperCase() ?? null;
          const cls = code ? CLASSIFICATIONS[code] : undefined;
          const intensityKt = num(s.intensity);
          const pressureMb = num(s.pressure);
          const name = str(s.name, 80) ?? id.toUpperCase();
          const publicAdvisory = product(s, 'publicAdvisory');
          const severity = intensityKt != null ? severityFromThresholds(intensityKt, [0, 34, 64, 96]) : (cls?.severity ?? null);
          const label = [cls ? `${cls.name} (${code})` : code, intensityKt != null ? `${intensityKt} kt` : null].filter(Boolean).join(', ');
          const movementDir = num(s.movementDir);
          const movementSpeed = num(s.movementSpeed);

          return {
            upstreamId: id,
            layerId: 'nhc-active-storms',
            subcategory: cls?.name.toLowerCase() ?? code?.toLowerCase() ?? null,
            geometry,
            // The file states only the current status; the valid time of that status is the best available start.
            occurredAt: lastUpdate,
            updatedAt: lastUpdate,
            publishedAt: parseTime(publicAdvisory.issuance),
            ongoing: true,
            severity,
            severityLabel: label || null,
            confidence: null,
            title: `${cls?.name ?? code ?? 'Tropical cyclone'} ${name}`,
            description:
              `${cls?.name ?? 'Tropical cyclone'} ${name}` +
              `${intensityKt != null ? `, maximum sustained winds ${intensityKt} kt` : ''}` +
              `${pressureMb != null ? `, central pressure ${pressureMb} mb` : ''}` +
              `${movementDir != null && movementSpeed != null ? `, moving toward ${movementDir}° at ${movementSpeed} mph` : ''}.`,
            attributes: {
              stormId: id,
              name,
              basin: BASINS[id.slice(0, 2)] ?? null,
              binNumber: str(s.binNumber),
              classification: code,
              classificationName: cls?.name ?? null,
              intensityKt,
              pressureMb,
              movementDirDeg: movementDir,
              movementSpeedMph: movementSpeed,
              publicAdvisoryNumber: str(publicAdvisory.advNum),
              publicAdvisoryUrl: link(publicAdvisory.url),
              forecastAdvisoryNumber: str(product(s, 'forecastAdvisory').advNum),
              forecastAdvisoryUrl: link(product(s, 'forecastAdvisory').url),
              forecastDiscussionUrl: link(product(s, 'forecastDiscussion').url),
              forecastGraphicsUrl: link(product(s, 'forecastGraphics').url),
              forecastTrackKmzUrl: link(product(s, 'forecastTrack').kmzFile),
              trackConeKmzUrl: link(product(s, 'trackCone').kmzFile),
              bestTrackKmzUrl: link(product(s, 'bestTrackGIS').kmzFile),
              windWatchesWarningsKmzUrl: link(product(s, 'windWatchesWarnings').kmzFile),
              stormSurgeWatchWarningKmzUrl: link(product(s, 'stormSurgeWatchWarningGIS').kmzFile),
            },
            url: link(publicAdvisory.url) ?? link(product(s, 'forecastGraphics').url) ?? 'https://www.nhc.noaa.gov/',
            derived: severity != null ? ['severity'] : [],
          };
        });
      }
    }
    return out.done();
  },
});
