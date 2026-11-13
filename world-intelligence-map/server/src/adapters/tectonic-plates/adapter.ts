import type { Position } from 'geojson';
import { defineAdapter, isObject, jsonPayload, loadManifest, ParseCollector } from '../base.ts';
import { lineGeometry } from '../../core/geo.ts';
import { str } from '../../core/text.ts';
import type { RecordDraft } from '../../core/types.ts';
import manifestJson from './manifest.json' with { type: 'json' };

const manifest = loadManifest(manifestJson);
export const BOUNDARIES_URL = 'https://raw.githubusercontent.com/fraxen/tectonicplates/master/GeoJSON/PB2002_boundaries.json';

/** The 52 plates of PB2002 (Bird 2003, table 1; identical to the Code/PlateName pairs of PB2002_plates.json in the same repository). */
export const PLATE_NAMES: Record<string, string> = {
  AF: 'Africa', AM: 'Amur', AN: 'Antarctica', AP: 'Altiplano', AR: 'Arabia', AS: 'Aegean Sea', AT: 'Anatolia', AU: 'Australia',
  BH: 'Birds Head', BR: 'Balmoral Reef', BS: 'Banda Sea', BU: 'Burma', CA: 'Caribbean', CL: 'Caroline', CO: 'Cocos', CR: 'Conway Reef',
  EA: 'Easter', EU: 'Eurasia', FT: 'Futuna', GP: 'Galapagos', IN: 'India', JF: 'Juan de Fuca', JZ: 'Juan Fernandez', KE: 'Kermadec',
  MA: 'Mariana', MN: 'Manus', MO: 'Maoke', MS: 'Molucca Sea', NA: 'North America', NB: 'North Bismarck', ND: 'North Andes',
  NH: 'New Hebrides', NI: "Niuafo'ou", NZ: 'Nazca', OK: 'Okhotsk', ON: 'Okinawa', PA: 'Pacific', PM: 'Panama', PS: 'Philippine Sea',
  RI: 'Rivera', SA: 'South America', SB: 'South Bismarck', SC: 'Scotia', SL: 'Shetland', SO: 'Somalia', SS: 'Solomon Sea', SU: 'Sunda',
  SW: 'Sandwich', TI: 'Timor', TO: 'Tonga', WL: 'Woodlark', YA: 'Yangtze',
};

interface BoundaryFeature {
  properties?: Record<string, unknown> | null;
  geometry?: { type?: unknown; coordinates?: unknown } | null;
}

/** Positions of a LineString / MultiLineString as one list per line; null when the structure is not numeric [lon, lat] pairs. */
function lines(geometry: BoundaryFeature['geometry']): Position[][] | null {
  const c = geometry?.coordinates;
  if (!Array.isArray(c)) return null;
  const parts: unknown[] = geometry?.type === 'LineString' ? [c] : geometry?.type === 'MultiLineString' ? c : [];
  if (!parts.length) return null;
  const out: Position[][] = [];
  for (const part of parts) {
    if (!Array.isArray(part)) return null;
    const line: Position[] = [];
    for (const p of part) {
      if (!Array.isArray(p) || typeof p[0] !== 'number' || typeof p[1] !== 'number' || !Number.isFinite(p[0]) || !Number.isFinite(p[1])) return null;
      line.push([p[0], p[1]]);
    }
    out.push(line);
  }
  return out;
}

export default defineAdapter({
  manifest,
  version: '1.0.0',

  async fetch(ctx) {
    return [await ctx.http.get(BOUNDARIES_URL, { key: 'boundaries' })];
  },

  parse(payloads) {
    const out = new ParseCollector();
    for (const payload of payloads) {
      const fc = jsonPayload<{ features: BoundaryFeature[] }>(
        payload,
        (v) => isObject(v) && v.type === 'FeatureCollection' && Array.isArray(v.features),
        'PB2002 plate boundaries GeoJSON',
      );
      // The file has no feature ids. A boundary name such as "EU-AF" occurs once per digitised segment, so the id is the
      // name plus the segment's ordinal among the features of that name (stable for as long as the static file is unchanged).
      const ordinal = new Map<string, number>();
      for (const feature of fc.features) {
        const props = isObject(feature) && isObject(feature.properties) ? feature.properties : null;
        const plateA = str(props?.PlateA, 8);
        const plateB = str(props?.PlateB, 8);
        const name = str(props?.Name, 20) ?? (plateA && plateB ? `${plateA}-${plateB}` : null);
        const n = name ? (ordinal.get(name) ?? 0) + 1 : 0;
        if (name) ordinal.set(name, n); // counted even if the segment is rejected below, so later ids do not shift

        out.item(feature, () => `${name ?? '?'} #${n}`, (f): RecordDraft | string => {
          if (!props || !name || !plateA || !plateB) return 'missing boundary name or plate codes';
          const parts = lines(f.geometry);
          if (!parts) return 'missing or non-line geometry';
          // lineGeometry splits at the antimeridian so that no segment is drawn across the whole map.
          const pieces: Position[][] = [];
          for (const part of parts) {
            const g = lineGeometry(part);
            if (g?.type === 'LineString') pieces.push(g.coordinates);
            else if (g?.type === 'MultiLineString') pieces.push(...g.coordinates);
          }
          if (!pieces.length) return 'line has fewer than two positions';
          const type = str(props.Type, 40);
          const nameA = PLATE_NAMES[plateA] ?? plateA;
          const nameB = PLATE_NAMES[plateB] ?? plateB;
          return {
            upstreamId: `PB2002:${name}:${n}`,
            layerId: 'plate-boundaries',
            subcategory: type,
            geometry: pieces.length === 1 ? { type: 'LineString', coordinates: pieces[0]! } : { type: 'MultiLineString', coordinates: pieces },
            title: `${nameA} – ${nameB} plate boundary${type === 'subduction' ? ' (subduction zone)' : ''}`,
            attributes: {
              boundaryName: name,
              plateA,
              plateB,
              plateAName: PLATE_NAMES[plateA] ?? null,
              plateBName: PLATE_NAMES[plateB] ?? null,
              boundaryType: type,
              source: str(props.Source, 120),
              segment: n,
            },
            url: 'https://doi.org/10.1029/2001GC000252',
          };
        });
      }
    }
    return out.done();
  },
});
