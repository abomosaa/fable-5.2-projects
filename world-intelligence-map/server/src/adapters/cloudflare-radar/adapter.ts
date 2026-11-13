import { defineAdapter, isObject, jsonPayload, loadManifest, ParseCollector } from '../base.ts';
import { countryByIso3, toIso3 } from '../../core/countries.ts';
import { num, plainText, safeUrl, str } from '../../core/text.ts';
import { DAY, parseTime } from '../../core/time.ts';
import type { RecordDraft, Severity } from '../../core/types.ts';
import manifestJson from './manifest.json' with { type: 'json' };

const manifest = loadManifest(manifestJson);
const LAYER_ID = 'cloudflare-outages';
/** Far more than the Outage Center publishes in a week, so one page always suffices. */
export const PAGE_LIMIT = 200;
const URL_OUTAGES = `https://api.cloudflare.com/client/v4/radar/annotations/outages?dateRange=7d&format=json&limit=${PAGE_LIMIT}`;
const OUTAGE_CENTER = 'https://radar.cloudflare.com/outage-center';

/**
 * Severity derived by this application from the documented `outage.outageType` values:
 * NATIONWIDE → severe, REGIONAL / PLATFORM → moderate, NETWORK (a single network) → minor.
 * An outage that lasted (or, while ongoing, has lasted) 24 hours or longer is raised one level.
 */
const TYPE_SEVERITY: Record<string, Severity> = { NATIONWIDE: 3, REGIONAL: 2, PLATFORM: 2, NETWORK: 1 };
const LONG_OUTAGE_MS = DAY;

/** Curated annotation: fixed confidence, slightly higher when Cloudflare links a public reference. */
const CONFIDENCE_WITH_REFERENCE = 0.85;
const CONFIDENCE_WITHOUT_REFERENCE = 0.75;

interface Annotation {
  id?: unknown;
  asns?: unknown;
  asnsDetails?: unknown;
  dataSource?: unknown;
  description?: unknown;
  startDate?: unknown;
  endDate?: unknown;
  eventType?: unknown;
  linkedUrl?: unknown;
  locations?: unknown;
  locationsDetails?: unknown;
  origins?: unknown;
  originsDetails?: unknown;
  outage?: unknown;
  scope?: unknown;
  tags?: unknown;
}

/** "GOVERNMENT_DIRECTED" → "government directed". */
function words(code: string | null): string | null {
  return code ? code.toLowerCase().replace(/_+/g, ' ') : null;
}

/** Upstream enum value (e.g. POWER_OUTAGE); anything that does not look like one is ignored rather than copied. */
function code(v: unknown): string | null {
  const s = typeof v === 'string' ? v.trim().toUpperCase() : '';
  return /^[A-Z][A-Z0-9_]{1,39}$/.test(s) ? s : null;
}

function list(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

function joined(values: (string | null)[], max = 20): string | null {
  const clean = [...new Set(values.filter((v): v is string => !!v))];
  if (!clean.length) return null;
  return clean.slice(0, max).join(', ') + (clean.length > max ? ` … (+${clean.length - max})` : '');
}

export default defineAdapter({
  manifest,
  version: '1.0.0',

  async fetch(ctx) {
    const token = ctx.env.CLOUDFLARE_API_TOKEN?.trim() ?? '';
    // The token travels only in the Authorization header, as documented; `redact` is belt and braces.
    return [await ctx.http.get(URL_OUTAGES, { key: 'outages', headers: { Authorization: `Bearer ${token}` }, redact: token ? [token] : undefined })];
  },

  parse(payloads, ctx) {
    const out = new ParseCollector();
    const seen = new Set<string>();
    for (const payload of payloads) {
      // Documented envelope: { success: true, result: { annotations: [...] } }; failures are { success: false, errors: [...] }.
      const body = jsonPayload<{ success?: unknown; result: { annotations: unknown[] } }>(
        payload,
        (v) => isObject(v) && v.success === true && isObject(v.result) && Array.isArray(v.result.annotations),
        'Cloudflare Radar outage annotations',
      );
      for (const raw of body.result.annotations) {
        out.item(raw as Annotation | null, (a) => `${String(a?.id)} ${JSON.stringify(a?.locations ?? null)} ${String(a?.startDate)}`, (a): RecordDraft[] | string => {
          if (!isObject(a)) return 'annotation is not an object';
          const startText = str(a.startDate);
          const occurredAt = parseTime(startText);
          if (occurredAt == null) return 'missing or unparseable startDate';
          if (occurredAt > ctx.now + DAY) return 'startDate is in the future';
          const endText = str(a.endDate);
          const endedAt = endText ? parseTime(endText) : null;
          if (endText && endedAt == null) return 'unparseable endDate';
          if (endedAt != null && endedAt < occurredAt) return 'endDate is earlier than startDate';

          const outage = isObject(a.outage) ? a.outage : {};
          const outageType = code(outage.outageType);
          const outageCause = code(outage.outageCause);
          const eventType = code(a.eventType) ?? 'OUTAGE';

          // Affected networks: `asns` (numbers) with optional names and registration country in `asnsDetails`.
          const details = list(a.asnsDetails).filter(isObject);
          const asnNumbers = [...new Set([...list(a.asns), ...details.map((d) => d.asn)].map(num).filter((n): n is number => n != null && Number.isInteger(n) && n > 0))];
          const asnNames = joined(details.map((d) => (num(d.asn) != null && str(d.name) ? `AS${num(d.asn)} ${plainText(d.name, 60)}` : null)));
          const origins = joined(list(a.origins).map((o) => (typeof o === 'string' ? str(o, 80) : null)));

          // Location: the documented alpha-2 `locations`; if an annotation only names networks, fall back to the
          // country those networks are registered in (flagged as derived); otherwise it is a non-geographic bulletin.
          if (a.locations != null && !Array.isArray(a.locations)) return 'locations is not an array';
          const codes = list(a.locations).filter((c): c is string => typeof c === 'string' && c.trim() !== '');
          let countries = [...new Set(codes.map((c) => toIso3(c)).filter((c): c is string => !!c))];
          if (codes.length && !countries.length) return `unrecognised location "${codes.join(',').slice(0, 30)}"`;
          const derived = ['severity', 'confidence'];
          if (!countries.length) {
            countries = [...new Set(details.map((d) => (isObject(d.location) ? toIso3(d.location.code) : null)).filter((c): c is string => !!c))];
            if (countries.length) derived.push('country');
          }

          // Upstream id; older documentation examples carry none, so fall back to a deterministic composite.
          const id = str(a.id, 80) ?? `${startText}|${codes.join('+')}|${outageType ?? ''}|${outageCause ?? ''}|${asnNumbers.join('+')}`;
          if (seen.has(id)) return 'duplicate annotation id';
          seen.add(id);

          const ongoing = endedAt == null;
          const durationMs = (endedAt ?? Math.max(ctx.now, occurredAt)) - occurredAt;
          const base = outageType ? (TYPE_SEVERITY[outageType] ?? null) : null;
          const severity = base == null ? null : (Math.min(4, base + (durationMs >= LONG_OUTAGE_MS ? 1 : 0)) as Severity);
          const linkedUrl = safeUrl(a.linkedUrl);
          const scope = plainText(a.scope, 200) || null;
          const note = plainText(a.description, 420) || null;
          const kind = eventType === 'OUTAGE' ? 'Internet outage' : `Internet ${words(eventType)}`;
          const qualifier = [words(outageType), outageCause && outageCause !== 'UNKNOWN' ? `likely cause: ${words(outageCause)}` : null].filter(Boolean).join(', ');

          const common = {
            layerId: LAYER_ID,
            subcategory: outageType ? outageType.toLowerCase() : null,
            occurredAt,
            endedAt,
            ongoing,
            severity,
            severityLabel: [outageType, outageCause].filter(Boolean).join(' · ') || null,
            confidence: linkedUrl ? CONFIDENCE_WITH_REFERENCE : CONFIDENCE_WITHOUT_REFERENCE,
            confidenceBasis: linkedUrl
              ? 'Curated annotation in the Cloudflare Radar Outage Center with a linked public reference; the cause is Cloudflare’s assessment.'
              : 'Curated annotation in the Cloudflare Radar Outage Center without a linked reference; the cause is Cloudflare’s assessment.',
            description: [scope ? `Scope: ${scope}.` : null, note].filter(Boolean).join(' ') || null,
            url: OUTAGE_CENTER,
            derived,
          } satisfies Partial<RecordDraft>;
          const attributes = {
            annotationId: str(a.id, 80),
            eventType,
            outageType,
            outageCause,
            scope,
            asns: joined(asnNumbers.map((n) => `AS${n}`)),
            asnNames,
            origins,
            locations: joined(codes.map((c) => c.trim().toUpperCase().slice(0, 3))),
            linkedUrl,
            dataSource: code(a.dataSource),
            tags: joined(list(a.tags).map((t) => (typeof t === 'string' ? str(t, 40) : null))),
            startDate: startText,
            endDate: endText,
          };

          if (!countries.length) {
            // e.g. a cloud-platform outage: no country to draw it at.
            const subject = origins ?? asnNames ?? scope ?? 'location not specified';
            return [{ ...common, upstreamId: id, geometryKind: 'global', title: `${kind} (Cloudflare Radar) – ${subject}${qualifier ? `: ${qualifier}` : ''}`, attributes }];
          }
          // One record per affected country so that each is drawn at its own label point.
          return countries.map((iso3) => ({
            ...common,
            upstreamId: countries.length === 1 ? id : `${id}.${iso3}`,
            country: iso3,
            title: `${kind} (Cloudflare Radar) – ${countryByIso3(iso3)?.name ?? iso3}${qualifier ? `: ${qualifier}` : ''}`,
            attributes,
          }));
        });
      }
    }
    return out.done();
  },
});
