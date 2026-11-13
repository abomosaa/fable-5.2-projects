import { defineAdapter, isObject, jsonPayload, loadManifest, ParseCollector } from '../base.ts';
import { toIso3 } from '../../core/countries.ts';
import { pointGeometry } from '../../core/geo.ts';
import { num, str } from '../../core/text.ts';
import { parseTime } from '../../core/time.ts';
import type { RecordDraft } from '../../core/types.ts';
import manifestJson from './manifest.json' with { type: 'json' };

const manifest = loadManifest(manifestJson);

/**
 * Facts only. The feature type also offers a geological summary and a photo with caption and credit; they are
 * deliberately not requested (smaller download, and no Smithsonian prose or imagery is copied).
 */
const PROPERTIES = [
  'Volcano_Number', 'Volcano_Name', 'Volcanic_Landform', 'Primary_Volcano_Type', 'Last_Eruption_Year', 'Country', 'Region', 'Subregion',
  'Latitude', 'Longitude', 'Elevation', 'Tectonic_Setting', 'Geologic_Epoch', 'Evidence_Category', 'Major_Rock_Type', 'GeoLocation',
];
const WFS_URL =
  'https://webservices.volcano.si.edu/geoserver/GVP-VOTW/ows?service=WFS&version=1.0.0&request=GetFeature' +
  '&typeName=GVP-VOTW:Smithsonian_VOTW_Holocene_Volcanoes&outputFormat=application/json' +
  `&propertyName=${PROPERTIES.join(',')}`;

/**
 * GVP country strings: "Italy", "Chile-Argentina" (border volcano), "Japan - administered by Russia", "Undersea Features".
 * Returns the countries GVP names without qualification; anything else is left to the position-based lookup.
 */
function countriesOf(country: string | null): string[] | null {
  if (!country) return null;
  if (toIso3(country)) return [country];
  if (/\s-\s/.test(country)) return null; // qualified statements (administered by / claimed by) are kept as text only
  const parts = country.split('-').map((c) => c.trim());
  return parts.length > 1 && parts.every((c) => toIso3(c)) ? parts : null;
}

function eruptionYearText(year: number | null): string {
  if (year == null) return 'no dated Holocene eruption';
  return `last known eruption ${year < 0 ? `${-year} BCE` : `${year} CE`}`;
}

interface VolcanoFeature {
  id?: unknown;
  properties?: Record<string, unknown> | null;
  geometry?: { type?: string; coordinates?: unknown[] } | null;
}

export default defineAdapter({
  manifest,
  version: '1.0.0',

  async fetch(ctx) {
    return [await ctx.http.get(WFS_URL, { key: 'holocene-volcanoes' })];
  },

  parse(payloads) {
    const out = new ParseCollector();
    const seen = new Set<string>();
    for (const payload of payloads) {
      const fc = jsonPayload<{ timeStamp?: unknown; features: VolcanoFeature[] }>(
        payload,
        (v) => isObject(v) && v.type === 'FeatureCollection' && Array.isArray(v.features),
        'GVP WFS response',
      );
      out.noteUpstreamTime(parseTime(fc.timeStamp));
      for (const f of fc.features) {
        out.item(f, (x) => `${String(x?.properties?.Volcano_Number)} ${String(x?.properties?.Volcano_Name ?? '')}`, (feature): RecordDraft | RecordDraft[] | string => {
          const p = feature?.properties;
          if (!isObject(p)) return 'missing properties';
          const number = num(p.Volcano_Number);
          const name = str(p.Volcano_Name, 200);
          if (number == null || !Number.isInteger(number) || number <= 0) return 'missing or invalid volcano number';
          if (!name) return 'missing volcano name';
          const id = String(number);
          if (seen.has(id)) return [];
          const coords = feature.geometry?.type === 'Point' && Array.isArray(feature.geometry.coordinates) ? feature.geometry.coordinates : [];
          const geometry = pointGeometry(coords[0] ?? p.Longitude, coords[1] ?? p.Latitude);
          if (!geometry) return 'missing or invalid coordinates';
          seen.add(id);

          const type = str(p.Primary_Volcano_Type, 80);
          const country = str(p.Country, 120);
          const subregion = str(p.Subregion, 120);
          const elevationM = num(p.Elevation);
          const rawYear = num(p.Last_Eruption_Year);
          const lastEruptionYear = rawYear != null && Number.isInteger(rawYear) ? rawYear : null;
          const evidence = str(p.Evidence_Category, 80);
          const countries = countriesOf(country);

          return {
            upstreamId: id,
            layerId: 'volcanoes-holocene',
            subcategory: type,
            geometry,
            country: countries,
            severity: null,
            confidence: null,
            title: name,
            description:
              `${type ?? 'Volcano'}${country ? ` – ${country}` : ''}${subregion ? ` (${subregion})` : ''}` +
              `${elevationM != null ? `, summit elevation ${elevationM} m` : ''}; ${eruptionYearText(lastEruptionYear)}` +
              `${evidence ? ` (evidence: ${evidence})` : ''}.`,
            attributes: {
              volcanoNumber: number,
              volcanoType: type,
              landform: str(p.Volcanic_Landform, 80),
              lastEruptionYear,
              country,
              region: str(p.Region, 120),
              subregion,
              elevationM,
              tectonicSetting: str(p.Tectonic_Setting, 160),
              evidenceCategory: evidence,
              majorRockType: str(p.Major_Rock_Type, 120),
              geologicEpoch: str(p.Geologic_Epoch, 40),
            },
            url: `https://volcano.si.edu/volcano.cfm?vn=${id}`,
            derived: [],
          };
        });
      }
    }
    return out.done();
  },
});
