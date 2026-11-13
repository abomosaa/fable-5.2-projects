import { defineAdapter, isObject, jsonPayload, loadManifest, ParseCollector } from '../base.ts';
import { plainText, str } from '../../core/text.ts';
import { iso, parseTime } from '../../core/time.ts';
import type { RecordDraft, Severity } from '../../core/types.ts';
import manifestJson from './manifest.json' with { type: 'json' };

const manifest = loadManifest(manifestJson);
const URL_ACTIVE = 'https://api.weather.gov/alerts/active?status=actual&message_type=alert,update';

/** CAP severity as stated by NWS → 0–4 scale (a one-to-one relabelling, not a derivation). */
export const CAP_SEVERITY: Record<string, Severity | null> = { extreme: 4, severe: 3, moderate: 2, minor: 1, unknown: null };
/** CAP certainty → confidence (derived by this application). */
export const CAP_CERTAINTY: Record<string, number | null> = { observed: 0.95, likely: 0.8, possible: 0.5, unlikely: 0.2, unknown: null };

/** UGC prefixes of U.S. territories that have their own ISO 3166-1 code. */
const TERRITORY: Record<string, string> = { PR: 'PRI', VI: 'VIR', GU: 'GUM', AS: 'ASM', MP: 'MNP' };
/** UGC prefixes of marine zones (coastal waters, offshore, high seas, Great Lakes) – not attributed to a country. */
const MARINE = new Set(['AM', 'AN', 'GM', 'PZ', 'PK', 'PH', 'PM', 'PS', 'LM', 'LS', 'LH', 'LE', 'LO', 'LC', 'SL']);

interface NwsFeature {
  id?: unknown;
  geometry?: { type?: unknown; coordinates?: unknown } | null;
  properties?: Record<string, unknown> | null;
}

/** Countries of the alert's UGC zones (USA for states, the territory's own code for PR/VI/GU/AS/MP, nothing for marine zones). */
function countriesFromUgc(geocode: unknown): string[] {
  const ugc = isObject(geocode) && Array.isArray(geocode.UGC) ? geocode.UGC : [];
  const out = new Set<string>();
  for (const code of ugc) {
    const prefix = typeof code === 'string' ? code.slice(0, 2).toUpperCase() : '';
    if (!/^[A-Z]{2}$/.test(prefix) || MARINE.has(prefix)) continue;
    out.add(TERRITORY[prefix] ?? 'USA');
  }
  return [...out];
}

export default defineAdapter({
  manifest,
  version: '1.0.0',

  async fetch(ctx) {
    // The User-Agent demanded by api.weather.gov is set by the shared HTTP client.
    return [await ctx.http.get(URL_ACTIVE, { key: 'active', headers: { accept: 'application/geo+json' } })];
  },

  parse(payloads) {
    const out = new ParseCollector();
    const seen = new Set<string>();
    for (const payload of payloads) {
      const fc = jsonPayload<{ updated?: unknown; features: NwsFeature[] }>(
        payload,
        (v) => isObject(v) && v.type === 'FeatureCollection' && Array.isArray(v.features),
        'NWS alerts GeoJSON',
      );
      out.noteUpstreamTime(parseTime(fc.updated));
      for (const f of fc.features) {
        out.item(f, (x) => `${String(x?.properties?.id ?? x?.id)} ${String(x?.properties?.event ?? '')}`, (feature): RecordDraft | RecordDraft[] | string => {
          const p = feature?.properties;
          if (!isObject(p)) return 'missing properties';
          const id = str(p.id) ?? str(feature.id);
          if (!id) return 'missing alert identifier';
          const event = str(p.event, 120);
          if (!event) return 'missing event name';
          if (seen.has(id)) return []; // the API occasionally lists one alert twice
          // Exercises, tests and cancellations are not alerts in force.
          if (str(p.status)?.toLowerCase() !== 'actual' || str(p.messageType)?.toLowerCase() === 'cancel') return [];
          // Zone-based alerts carry no shape of their own (see manifest limitations) – not an error.
          if (feature.geometry == null) return [];
          const gtype = feature.geometry.type;
          if (gtype !== 'Polygon' && gtype !== 'MultiPolygon') return `unsupported geometry type ${String(gtype)}`;

          const sent = parseTime(p.sent);
          const effective = parseTime(p.effective) ?? sent;
          if (effective == null) return 'missing or unparseable sent/effective time';
          const onset = parseTime(p.onset);
          if (p.onset != null && onset == null) return 'unparseable onset time';
          const ends = parseTime(p.ends);
          const expires = parseTime(p.expires);
          if ((p.ends != null && ends == null) || (p.expires != null && expires == null)) return 'unparseable ends/expires time';
          const until = ends ?? expires;
          seen.add(id);

          const severityLabel = str(p.severity);
          const certainty = str(p.certainty);
          const confidence = certainty ? (CAP_CERTAINTY[certainty.toLowerCase()] ?? null) : null;
          const area = plainText(p.areaDesc, 400);
          const countries = countriesFromUgc(p.geocode);
          const derived = [...(confidence != null ? ['confidence'] : []), ...(countries.length ? ['country'] : [])];

          return {
            upstreamId: id,
            layerId: /warning$/i.test(event) ? 'nws-warnings' : 'nws-watches-advisories',
            subcategory: event,
            geometry: feature.geometry as RecordDraft['geometry'],
            country: countries.length ? countries : null,
            // An alert is in force from the moment it is issued, even when the hazard itself starts later (onset is kept in attributes).
            occurredAt: onset != null ? Math.min(onset, effective) : effective,
            publishedAt: sent ?? effective,
            expiresAt: until,
            ongoing: until == null,
            severity: severityLabel ? (CAP_SEVERITY[severityLabel.toLowerCase()] ?? null) : null,
            severityLabel,
            confidence,
            confidenceBasis: confidence != null ? `CAP certainty stated by NWS: ${certainty}` : null,
            title: area ? `${event} – ${plainText(area, 170)}` : event,
            description: plainText(p.description, 500) || null,
            attributes: {
              event,
              headline: str(p.headline, 300),
              areaDesc: area || null,
              senderName: str(p.senderName),
              urgency: str(p.urgency),
              certainty,
              messageType: str(p.messageType),
              response: str(p.response),
              capCategory: str(p.category),
              onsetUtc: iso(onset),
              endsUtc: iso(ends),
              expiresUtc: iso(expires),
              instruction: plainText(p.instruction, 300) || null,
            },
            url: str(p['@id'], 400) ?? str(feature.id, 400),
            derived,
          };
        });
      }
    }
    return out.done();
  },
});
