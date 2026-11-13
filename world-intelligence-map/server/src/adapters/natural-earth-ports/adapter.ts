import { defineAdapter, isObject, jsonPayload, loadManifest, ParseCollector } from '../base.ts';
import { pointGeometry } from '../../core/geo.ts';
import { num, str } from '../../core/text.ts';
import type { RecordDraft } from '../../core/types.ts';
import manifestJson from './manifest.json' with { type: 'json' };

const manifest = loadManifest(manifestJson);
export const PORTS_URL = 'https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_10m_ports.geojson';

const WEBSITE = /^(https?:\/\/)?[a-z0-9][a-z0-9.-]*\.[a-z]{2,}(:\d+)?(\/\S*)?$/i;

interface PortFeature {
  properties?: Record<string, unknown> | null;
  geometry?: { type?: unknown; coordinates?: unknown } | null;
}

export default defineAdapter({
  manifest,
  version: '1.0.0',

  async fetch(ctx) {
    return [await ctx.http.get(PORTS_URL, { key: 'ports' })];
  },

  parse(payloads) {
    const out = new ParseCollector();
    const seen = new Set<string>();
    for (const payload of payloads) {
      const fc = jsonPayload<{ features: PortFeature[] }>(
        payload,
        (v) => isObject(v) && v.type === 'FeatureCollection' && Array.isArray(v.features),
        'Natural Earth ports GeoJSON',
      );
      for (const feature of fc.features) {
        out.item(feature, (f) => `${String(f?.properties?.ne_id)} ${String(f?.properties?.name ?? '')}`, (f): RecordDraft | string => {
          const p = f?.properties;
          if (!isObject(p)) return 'feature without properties';
          const name = str(p.name, 120);
          if (!name) return 'port without a name';
          const coords = f.geometry?.coordinates;
          if (f.geometry?.type !== 'Point' || !Array.isArray(coords)) return 'missing or non-point geometry';
          const lon = typeof coords[0] === 'number' ? coords[0] : null;
          const lat = typeof coords[1] === 'number' ? coords[1] : null;
          const geometry = lon != null && lat != null && Math.abs(lon) <= 180 ? pointGeometry(lon, lat) : null;
          if (!geometry) return 'invalid coordinates';
          // ne_id is Natural Earth's persistent feature id; fall back to name + position for features that lack one.
          const neId = num(p.ne_id);
          const upstreamId = neId != null ? `ne:${neId}` : `port:${name}@${lon!.toFixed(3)},${lat!.toFixed(3)}`;
          if (seen.has(upstreamId)) return 'duplicate port id';
          seen.add(upstreamId);
          const website = str(p.website, 200);
          return {
            upstreamId,
            layerId: 'seaports',
            geometry,
            title: name,
            attributes: {
              // Natural Earth cartographic rank: lower scalerank values appear at smaller map scales (more prominent ports).
              scaleRank: num(p.scalerank),
              nationalScaleRank: num(p.natlscale),
              // Published mostly without a scheme ("www.portofrotterdam.com"); kept as plain text, anything that is not a web address is dropped.
              website: website && WEBSITE.test(website) ? website : null,
              featureClass: str(p.featurecla, 40),
            },
          };
        });
      }
    }
    return out.done();
  },
});
