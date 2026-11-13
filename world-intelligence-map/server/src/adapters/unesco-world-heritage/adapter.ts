import { defineAdapter, isObject, jsonPayload, loadManifest, ParseCollector } from '../base.ts';
import { pointGeometry } from '../../core/geo.ts';
import { num, plainText, str } from '../../core/text.ts';
import type { RecordDraft } from '../../core/types.ts';
import manifestJson from './manifest.json' with { type: 'json' };

const manifest = loadManifest(manifestJson);

/** Only the fields used below are requested: the full records carry six languages and are about ten times larger. */
export const FIELDS = [
  'id_no', 'name_en', 'short_description_en', 'date_inscribed', 'danger', 'danger_list', 'date_end', 'area_hectares', 'category',
  'states_names', 'iso_codes', 'region', 'transboundary', 'geo_point_2d',
];
export const EXPORT_URL = `https://data.unesco.org/api/explore/v2.1/catalog/datasets/whc001/exports/json?select=${FIELDS.join(',')}`;

const CATEGORIES = new Set(['Cultural', 'Natural', 'Mixed']);
export const DESCRIPTION_MAX = 300;

/** The Datahub publishes booleans as the strings "True" / "False". */
function flag(v: unknown): boolean | null {
  if (typeof v === 'boolean') return v;
  if (typeof v !== 'string') return null;
  const s = v.trim().toLowerCase();
  return s === 'true' ? true : s === 'false' ? false : null;
}

function stringList(v: unknown): string[] {
  if (Array.isArray(v)) return v.map((x) => plainText(x, 80)).filter(Boolean);
  const s = str(v);
  return s ? s.split(',').map((x) => plainText(x, 80)).filter(Boolean) : [];
}

export default defineAdapter({
  manifest,
  version: '1.0.0',

  async fetch(ctx) {
    // One export request for the whole List (about 1.3 MB); manifest.http.cacheTtlSec keeps it to one download per week at most.
    return [await ctx.http.get(EXPORT_URL, { key: 'whc001' })];
  },

  parse(payloads) {
    const out = new ParseCollector();
    const seen = new Set<string>();
    for (const payload of payloads) {
      const rows = jsonPayload<unknown[]>(payload, (v) => Array.isArray(v), 'UNESCO World Heritage List export');
      for (const row of rows) {
        if (isObject(row) && row.date_end != null && row.date_end !== '') continue; // delisted property: no longer on the List
        out.item(row, (r) => (isObject(r) ? `${String(r.id_no)} ${String(r.name_en ?? '')}` : String(r)), (r): RecordDraft | string => {
          if (!isObject(r)) return 'row is not an object';
          const id = str(r.id_no, 20);
          if (!id || !/^[0-9A-Za-z-]+$/.test(id)) return 'missing or invalid id_no';
          const name = plainText(r.name_en, 200);
          if (!name) return 'missing English name';
          const category = str(r.category, 20);
          if (!category || !CATEGORIES.has(category)) return `unknown category "${String(r.category).slice(0, 30)}"`;

          const isoCodes = stringList(r.iso_codes).map((c) => c.toUpperCase()).filter((c) => /^[A-Z]{2,3}$/.test(c));
          const gp = r.geo_point_2d;
          let geometry: RecordDraft['geometry'] = null;
          if (gp != null) {
            geometry = isObject(gp) && typeof gp.lon === 'number' && typeof gp.lat === 'number' && Math.abs(gp.lon) <= 180 ? pointGeometry(gp.lon, gp.lat) : null;
            if (!geometry) return 'invalid coordinates';
          } else if (!isoCodes.length) return 'neither coordinates nor a State Party';
          if (seen.has(id)) return 'duplicate id_no';
          seen.add(id);

          const inDanger = flag(r.danger) === true;
          // danger_list: "Y 2023" = on the List of World Heritage in Danger since 2023.
          const dangerSince = inDanger ? num(/Y\s*(\d{4})\s*$/.exec(str(r.danger_list) ?? '')?.[1]) : null;
          const inscribed = num(r.date_inscribed);
          const area = num(r.area_hectares);
          const states = stringList(r.states_names);
          return {
            upstreamId: id,
            layerId: 'world-heritage-sites',
            subcategory: category,
            // Without coordinates the record is attached to its State(s) Party (country-level record).
            ...(geometry ? { geometry } : {}),
            ...(isoCodes.length ? { country: isoCodes } : {}),
            severity: inDanger ? 2 : null,
            severityLabel: inDanger ? `List of World Heritage in Danger${dangerSince ? ` (since ${dangerSince})` : ''}` : null,
            title: name,
            description: plainText(r.short_description_en, DESCRIPTION_MAX) || null,
            attributes: {
              category,
              inscribedYear: inscribed != null && inscribed >= 1978 && inscribed < 2200 ? inscribed : null,
              inDanger,
              inDangerSinceYear: dangerSince,
              states: states.length ? states.join(', ') : null,
              isoCodes: isoCodes.length ? isoCodes.join(', ') : null,
              region: str(r.region, 80),
              transboundary: flag(r.transboundary),
              areaHectares: area != null && area > 0 ? area : null,
            },
            url: `https://whc.unesco.org/en/list/${encodeURIComponent(id)}`,
            derived: inDanger ? ['severity'] : [],
          };
        });
      }
    }
    return out.done();
  },
});
