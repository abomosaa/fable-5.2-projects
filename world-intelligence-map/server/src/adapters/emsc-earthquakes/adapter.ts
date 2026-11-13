import { defineAdapter, isObject, jsonPayload, loadManifest, ParseCollector, severityFromThresholds } from '../base.ts';
import { pointGeometry } from '../../core/geo.ts';
import { num, str } from '../../core/text.ts';
import { DAY, parseTime } from '../../core/time.ts';
import type { RecordDraft } from '../../core/types.ts';
import manifestJson from './manifest.json' with { type: 'json' };

const manifest = loadManifest(manifestJson);
const ENDPOINT = 'https://www.seismicportal.eu/fdsnws/event/1/query';
const WINDOW_DAYS = 7;

/** EMSC event type codes (QuakeML-style two-letter codes used by the SeismicPortal). */
const EVENT_TYPES: Record<string, string> = {
  ke: 'earthquake',
  se: 'suspected earthquake',
  kr: 'rockburst',
  sr: 'suspected rockburst',
  ki: 'induced event',
  si: 'suspected induced event',
  km: 'mine explosion',
  sm: 'suspected mine explosion',
  kh: 'chemical explosion',
  sh: 'suspected chemical explosion',
  kx: 'experimental explosion',
  sx: 'suspected experimental explosion',
  kn: 'nuclear explosion',
  sn: 'suspected nuclear explosion',
  ls: 'landslide',
  uk: 'unknown',
};

interface EmscFeature {
  id?: unknown;
  properties?: Record<string, unknown>;
  geometry?: { type?: string; coordinates?: unknown[] } | null;
}

export default defineAdapter({
  manifest,
  version: '1.0.0',

  async fetch(ctx) {
    // Start of the UTC day seven days ago: the URL stays stable for a day, so revalidation and caching work.
    const start = new Date(Math.floor((ctx.now - WINDOW_DAYS * DAY) / DAY) * DAY).toISOString().slice(0, 10);
    return [await ctx.http.get(`${ENDPOINT}?format=json&minmag=4&orderby=time&limit=1000&start=${start}T00:00:00`, { key: 'm4-week' })];
  },

  parse(payloads) {
    const out = new ParseCollector();
    const seen = new Set<string>();
    for (const payload of payloads) {
      const fc = jsonPayload<{ features: EmscFeature[] }>(
        payload,
        (v) => isObject(v) && v.type === 'FeatureCollection' && Array.isArray(v.features),
        'EMSC FDSN event response',
      );
      for (const f of fc.features) {
        out.item(f, (x) => `${String(x?.id)} ${String(x?.properties?.flynn_region ?? '')}`, (feature): RecordDraft | RecordDraft[] | string => {
          const p = feature?.properties;
          if (!isObject(p)) return 'missing id or properties';
          const id = str(p.unid) ?? str(feature.id);
          if (!id) return 'missing id or properties';
          if (seen.has(id)) return [];
          // properties.lat/lon are authoritative; the GeoJSON geometry carries the same position plus negative depth.
          const coords = Array.isArray(feature.geometry?.coordinates) ? feature.geometry.coordinates : [];
          const geometry = pointGeometry(p.lon ?? coords[0], p.lat ?? coords[1]);
          if (!geometry) return 'missing or invalid coordinates';
          const occurredAt = parseTime(p.time);
          if (occurredAt == null) return 'missing or unparseable origin time';
          seen.add(id);

          const updatedAt = parseTime(p.lastupdate);
          out.noteUpstreamTime(updatedAt);
          const mag = num(p.mag);
          const magType = str(p.magtype);
          const depthKm = num(p.depth);
          const region = str(p.flynn_region);
          const typeCode = str(p.evtype)?.toLowerCase() ?? null;
          const type = typeCode ? (EVENT_TYPES[typeCode] ?? typeCode) : 'earthquake';

          return {
            upstreamId: id,
            layerId: 'emsc-earthquakes',
            subcategory: type,
            geometry,
            occurredAt,
            updatedAt,
            severity: severityFromThresholds(mag, [4, 5, 6, 7]),
            severityLabel: mag != null ? `M ${mag.toFixed(1)}${magType ? ` (${magType})` : ''}` : null,
            confidence: null,
            title: `M ${mag != null ? mag.toFixed(1) : '?'} – ${region ?? 'unknown region'}`,
            description: region ? `${type === 'earthquake' ? 'Earthquake' : type} in the Flinn-Engdahl region ${region}${depthKm != null ? `, depth ${depthKm.toFixed(1)} km` : ''}.` : null,
            attributes: {
              magnitude: mag,
              magnitudeType: magType,
              depthKm,
              region,
              eventType: type,
              eventTypeCode: typeCode,
              contributingAgency: str(p.auth),
              catalog: str(p.source_catalog),
              emscSourceId: str(p.source_id),
            },
            url: `https://www.seismicportal.eu/eventdetails.html?unid=${encodeURIComponent(id)}`,
            derived: mag != null ? ['severity'] : [],
          };
        });
      }
    }
    return out.done();
  },
});
