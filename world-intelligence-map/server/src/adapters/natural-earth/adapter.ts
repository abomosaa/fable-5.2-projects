import { defineAdapter, isObject, jsonPayload, loadManifest, ParseCollector } from '../base.ts';
import { toIso3 } from '../../core/countries.ts';
import { pointGeometry } from '../../core/geo.ts';
import { num, str } from '../../core/text.ts';
import type { FetchedPayload, RecordDraft } from '../../core/types.ts';
import manifestJson from './manifest.json' with { type: 'json' };

const manifest = loadManifest(manifestJson);
const BASE = 'https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson';
export const PLACES_URL = `${BASE}/ne_50m_populated_places_simple.geojson`;
export const DISPUTED_URL = `${BASE}/ne_50m_admin_0_breakaway_disputed_areas.geojson`;

interface NeFeature {
  properties?: Record<string, unknown> | null;
  geometry?: { type?: unknown; coordinates?: unknown } | null;
}

function features(payload: FetchedPayload, what: string): NeFeature[] {
  return jsonPayload<{ features: NeFeature[] }>(payload, (v) => isObject(v) && v.type === 'FeatureCollection' && Array.isArray(v.features), what).features;
}

/** Natural Earth writes property names in lower case in some files and upper case in others. */
function prop(p: Record<string, unknown>, name: string): unknown {
  return p[name] ?? p[name.toUpperCase()] ?? p[name.toLowerCase()];
}

/** ne_id is Natural Earth's persistent feature id. */
function neId(p: Record<string, unknown>): string | null {
  const id = num(prop(p, 'ne_id'));
  return id != null && id > 0 ? `ne:${id}` : null;
}

function place(f: NeFeature, seen: Set<string>): RecordDraft | string {
  const p = f?.properties;
  if (!isObject(p)) return 'feature without properties';
  const upstreamId = neId(p);
  if (!upstreamId) return 'missing ne_id';
  const name = str(p.name, 120);
  if (!name) return 'place without a name';
  const coords = f.geometry?.coordinates;
  if (f.geometry?.type !== 'Point' || !Array.isArray(coords)) return 'missing or non-point geometry';
  const geometry = typeof coords[0] === 'number' && typeof coords[1] === 'number' && Math.abs(coords[0]) <= 180 ? pointGeometry(coords[0], coords[1]) : null;
  if (!geometry) return 'invalid coordinates';
  if (seen.has(upstreamId)) return 'duplicate ne_id';
  seen.add(upstreamId);
  const featureClass = str(p.featurecla, 60);
  const population = num(p.pop_max);
  // Natural Earth's own admin-0 code; when the gazetteer does not know it the pipeline falls back to the coordinates.
  const iso3 = toIso3(str(p.adm0_a3));
  return {
    upstreamId,
    layerId: 'populated-places',
    subcategory: featureClass,
    geometry,
    ...(iso3 ? { country: iso3 } : {}),
    title: name,
    attributes: {
      countryName: str(p.adm0name, 80),
      admin1Name: str(p.adm1name, 80),
      populationMax: population != null && population > 0 ? population : null,
      featureClass,
      isCapital: p.adm0cap === 1,
      scaleRank: num(p.scalerank),
    },
  };
}

function disputedArea(f: NeFeature, seen: Set<string>): RecordDraft | string {
  const p = f?.properties;
  if (!isObject(p)) return 'feature without properties';
  const upstreamId = neId(p);
  if (!upstreamId) return 'missing ne_id';
  const name = str(prop(p, 'brk_name'), 120) ?? str(prop(p, 'name'), 120);
  if (!name) return 'area without a name';
  const type = f.geometry?.type;
  if ((type !== 'Polygon' && type !== 'MultiPolygon') || !Array.isArray(f.geometry?.coordinates)) return 'missing or non-polygon geometry';
  if (seen.has(upstreamId)) return 'duplicate ne_id';
  seen.add(upstreamId);
  const disputeType = str(prop(p, 'type'), 40);
  const note = str(prop(p, 'note_brk'), 200);
  return {
    upstreamId,
    layerId: 'disputed-areas',
    subcategory: disputeType,
    // Ring validity, coordinate ranges and vertex limits are checked by the normaliser, which rejects the single feature if broken.
    geometry: f.geometry as RecordDraft['geometry'],
    // Deliberately no `country`: assigning a disputed area to one state would be a claim this application does not make.
    title: name,
    description: note ? `${disputeType ?? 'Disputed'} area as depicted by Natural Earth. ${note}.` : `${disputeType ?? 'Disputed'} area as depicted by Natural Earth.`,
    attributes: {
      disputeType,
      // "Admin. by India; Claimed by China" – who administers and who claims, in Natural Earth's words.
      note,
      alternateName: str(prop(p, 'name_alt'), 120),
      depictedUnderAdmin: str(prop(p, 'admin'), 80),
      depictedSovereignty: str(prop(p, 'sovereignt'), 80),
      featureClass: str(p.featurecla, 60),
    },
  };
}

export default defineAdapter({
  manifest,
  version: '1.0.0',

  async fetch(ctx) {
    return [await ctx.http.get(PLACES_URL, { key: 'populated-places' }), await ctx.http.get(DISPUTED_URL, { key: 'disputed-areas' })];
  },

  parse(payloads) {
    const out = new ParseCollector();
    const seen = new Set<string>();
    for (const payload of payloads) {
      const disputed = payload.key === 'disputed-areas';
      const list = features(payload, `Natural Earth ${payload.key} GeoJSON`);
      for (const feature of list) {
        out.item(
          feature,
          (f) => `${String(f?.properties?.ne_id ?? f?.properties?.NE_ID)} ${String(f?.properties?.BRK_NAME ?? f?.properties?.name ?? '')}`,
          (f) => (disputed ? disputedArea(f, seen) : place(f, seen)),
        );
      }
    }
    return out.done();
  },
});
