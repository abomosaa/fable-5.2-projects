import type { Geometry, Position } from 'geojson';
import { defineAdapter, isObject, jsonPayload, loadManifest, ParseCollector, severityFromThresholds } from '../base.ts';
import { lineGeometry, pointGeometry, wrapLon } from '../../core/geo.ts';
import { num, str } from '../../core/text.ts';
import { parseTime } from '../../core/time.ts';
import type { RecordDraft } from '../../core/types.ts';
import manifestJson from './manifest.json' with { type: 'json' };

const manifest = loadManifest(manifestJson);
const BASE = 'https://eonet.gsfc.nasa.gov/api/v3/events';

/** EONET category id → layer. Every other category goes to `eonet-other` with the category as sub-category. */
const CATEGORY_LAYER: Record<string, string> = {
  wildfires: 'eonet-wildfires',
  volcanoes: 'eonet-volcanoes',
  severeStorms: 'eonet-severe-storms',
  seaLakeIce: 'eonet-sea-ice',
};

/** EONET magnitude units → attribute name carrying the unit. */
const MAGNITUDE_ATTR: Record<string, string> = {
  acres: 'areaAcres',
  hectare: 'areaHectares',
  'NM^2': 'areaSqNauticalMiles',
  kts: 'latestWindKt',
};

interface EonetGeometry {
  date?: unknown;
  type?: unknown;
  coordinates?: unknown;
  magnitudeValue?: unknown;
  magnitudeUnit?: unknown;
}
interface EonetEvent {
  id?: unknown;
  title?: unknown;
  description?: unknown;
  link?: unknown;
  closed?: unknown;
  categories?: { id?: unknown; title?: unknown }[];
  sources?: { id?: unknown; url?: unknown }[];
  geometry?: EonetGeometry[];
}
interface DatedGeometry {
  at: number;
  raw: EonetGeometry;
}

export default defineAdapter({
  manifest,
  version: '1.0.0',

  async fetch(ctx) {
    return [
      // Everything with a dated position in the past 30 days, including events that were closed in the meantime.
      await ctx.http.get(`${BASE}?status=all&days=30`, { key: 'recent' }),
      // Long-lived open events (eruptions, icebergs, storms) whose last dated position can be much older.
      // Deliberately not requested for wildfires: upstream keeps thousands of stale fire events open for years.
      await ctx.http.get(`${BASE}?status=open&category=volcanoes,seaLakeIce,severeStorms`, { key: 'open-longlived' }),
    ];
  },

  parse(payloads) {
    const out = new ParseCollector();
    const seen = new Set<string>();
    for (const payload of payloads) {
      const body = jsonPayload<{ events: EonetEvent[] }>(payload, (v) => isObject(v) && Array.isArray(v.events), 'EONET events response');
      for (const ev of body.events) {
        out.item(ev, (x) => `${String(x?.id)} ${String(x?.title ?? '')}`, (e): RecordDraft | RecordDraft[] | string => {
          const id = isObject(e) ? str(e.id) : null;
          const title = isObject(e) ? str(e.title, 300) : null;
          if (!id || !title) return 'missing id or title';
          if (seen.has(id)) return []; // open storms / icebergs appear in both requests

          const categories = Array.isArray(e.categories) ? e.categories : [];
          const categoryId = str(categories[0]?.id);
          if (!categoryId) return 'missing category';
          const layerId = CATEGORY_LAYER[categoryId] ?? 'eonet-other';

          // Dated geometries, oldest first. Entries without a parseable date cannot be placed in time.
          const dated: DatedGeometry[] = [];
          for (const g of Array.isArray(e.geometry) ? e.geometry : []) {
            const at = isObject(g) ? parseTime(g.date) : null;
            if (at != null) dated.push({ at, raw: g });
          }
          if (!dated.length) return 'no dated geometry';
          dated.sort((a, b) => a.at - b.at);
          const first = dated[0]!;
          const last = dated[dated.length - 1]!;

          let closedAt: number | null = null;
          if (e.closed != null) {
            closedAt = parseTime(e.closed);
            if (closedAt == null) return `unparseable closed date "${String(e.closed).slice(0, 40)}"`;
          }

          let geometry: Geometry | null;
          let geometryKind: RecordDraft['geometryKind'];
          const attributes: NonNullable<RecordDraft['attributes']> = {};
          let severity: RecordDraft['severity'] = null;
          let severityLabel: string | null = null;
          const derived: string[] = [];

          if (layerId === 'eonet-severe-storms') {
            // A storm is a sequence of dated positions → track whose last vertex is the latest position.
            const positions: Position[] = [];
            let peakWindKt: number | null = null;
            for (const d of dated) {
              const c = d.raw.type === 'Point' && Array.isArray(d.raw.coordinates) ? d.raw.coordinates : null;
              const pt = c ? pointGeometry(c[0], c[1]) : null;
              if (pt?.type !== 'Point') continue;
              const prev = positions[positions.length - 1];
              if (!prev || prev[0] !== pt.coordinates[0] || prev[1] !== pt.coordinates[1]) positions.push(pt.coordinates);
              const wind = d.raw.magnitudeUnit === 'kts' ? num(d.raw.magnitudeValue) : null;
              if (wind != null && (peakWindKt == null || wind > peakWindKt)) peakWindKt = wind;
            }
            if (!positions.length) return 'missing or invalid coordinates';
            if (positions.length === 1) {
              geometry = { type: 'Point', coordinates: positions[0]! };
              geometryKind = 'point';
            } else {
              geometry = lineGeometry(positions);
              geometryKind = 'track';
              derived.push('geometry'); // the line between reported fixes is drawn by this application
            }
            attributes.positionsReported = dated.length;
            attributes.peakWindKt = peakWindKt;
            const latest = positions[positions.length - 1]!;
            attributes.latestLongitude = latest[0];
            attributes.latestLatitude = latest[1];
            if (peakWindKt != null) {
              severity = severityFromThresholds(peakWindKt, [0, 34, 64, 96]);
              severityLabel = `peak wind ${peakWindKt} kt`;
              derived.push('severity');
            }
          } else {
            // Everything else is shown at its latest reported geometry (icebergs drift; fires and floods are updated in place).
            const g = last.raw;
            if (g.type === 'Point' && Array.isArray(g.coordinates)) {
              geometry = pointGeometry(g.coordinates[0], g.coordinates[1]);
            } else if (g.type === 'Polygon' && Array.isArray(g.coordinates)) {
              geometry = { type: 'Polygon', coordinates: wrapRings(g.coordinates) };
            } else {
              geometry = null;
            }
            if (!geometry) return 'missing or invalid coordinates';
            geometryKind = geometry.type === 'Point' ? 'point' : 'polygon';
            if (dated.length > 1) attributes.positionsReported = dated.length;
          }

          // Latest reported magnitude (burned area, iceberg size, wind speed …).
          for (let i = dated.length - 1; i >= 0; i--) {
            const value = num(dated[i]!.raw.magnitudeValue);
            const unit = str(dated[i]!.raw.magnitudeUnit);
            if (value == null || !unit) continue;
            attributes.magnitudeValue = value;
            attributes.magnitudeUnit = unit;
            const named = MAGNITUDE_ATTR[unit];
            if (named) attributes[named] = value;
            break;
          }

          const sources = (Array.isArray(e.sources) ? e.sources : []).filter(isObject);
          const sourceUrl = sources.map((s) => str(s.url, 500)).find((u) => u && /^https?:\/\//i.test(u)) ?? null;
          attributes.eonetCategory = str(categories[0]?.title) ?? categoryId;
          attributes.sources = sources.map((s) => str(s.id)).filter(Boolean).join(', ') || null;
          const apiUrl = str(e.link, 300);
          attributes.eonetApiUrl = apiUrl && /^https?:\/\//i.test(apiUrl) ? apiUrl : null;
          attributes.status = closedAt == null ? 'open' : 'closed';
          seen.add(id);

          return {
            upstreamId: id,
            layerId,
            subcategory: layerId === 'eonet-other' ? categoryId : null,
            geometry,
            geometryKind,
            occurredAt: first.at,
            updatedAt: last.at,
            endedAt: closedAt,
            ongoing: closedAt == null,
            severity,
            severityLabel,
            confidence: null,
            title,
            description: str(e.description, 500),
            attributes,
            url: sourceUrl ?? attributes.eonetApiUrl,
            derived,
          };
        });
      }
    }
    return out.done();
  },
});

/** Wrap polygon longitudes into [-180, 180]; structural validation is left to the normaliser. */
function wrapRings(coordinates: unknown[]): Position[][] {
  return coordinates.map((ring) =>
    Array.isArray(ring) ? ring.map((p) => (Array.isArray(p) && typeof p[0] === 'number' && typeof p[1] === 'number' ? [wrapLon(p[0]), p[1]] : (p as Position))) : (ring as Position[]),
  );
}
