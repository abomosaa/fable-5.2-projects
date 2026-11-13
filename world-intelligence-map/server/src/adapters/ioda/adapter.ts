import { defineAdapter, isObject, jsonPayload, loadManifest, ParseCollector } from '../base.ts';
import { countryByIso3, toIso3 } from '../../core/countries.ts';
import { num, str } from '../../core/text.ts';
import { fromEpochSeconds, parseTime, HOUR, MINUTE } from '../../core/time.ts';
import type { FetchedPayload, RecordDraft, Severity } from '../../core/types.ts';
import manifestJson from './manifest.json' with { type: 'json' };

const manifest = loadManifest(manifestJson);
const BASE = 'https://api.ioda.inetintel.cc.gatech.edu/v2';

export const WINDOW_DAYS = 7;
/** `limit` per request. A normal week has ~200 country events; pages are followed while a page comes back full. */
export const PAGE_LIMIT = 2000;
export const MAX_PAGES = 5;

/** IODA data source id → what the signal counts (wording follows the IODA API documentation). */
const DATASOURCES: Record<string, { label: string; signal: string }> = {
  bgp: { label: 'BGP', signal: 'BGP signal (/24 blocks visible to more than 50% of full-feed peers)' },
  'ping-slash24': { label: 'active probing', signal: 'active-probing signal (/24 blocks responding to pings)' },
  'merit-nt': { label: 'network telescope', signal: 'network-telescope signal (unique source IPs seen at the Merit telescope)' },
  'ucsd-nt': { label: 'network telescope', signal: 'network-telescope signal (unique source IPs seen at the UCSD telescope)' },
  gtr: { label: 'Google traffic', signal: 'Google Transparency Report traffic signal' },
};

/**
 * Severity thresholds on [mean relative drop in %, duration in minutes]; the highest level whose two thresholds are both
 * met wins. The mean drop is IODA's score ("alert area" = relative drop % × minutes) divided by the duration in minutes.
 */
export const SEVERITY_RULES: { severity: Severity; minDropPct: number; minMinutes: number }[] = [
  { severity: 4, minDropPct: 70, minMinutes: 180 },
  { severity: 3, minDropPct: 40, minMinutes: 60 },
  { severity: 2, minDropPct: 10, minMinutes: 30 },
  { severity: 1, minDropPct: 2, minMinutes: 0 },
];

export function severityFor(meanDropPct: number | null, minutes: number): Severity | null {
  if (meanDropPct == null) return null;
  for (const rule of SEVERITY_RULES) if (meanDropPct >= rule.minDropPct && minutes >= rule.minMinutes) return rule.severity;
  return 0;
}

/** Confidence by number of distinct IODA data sources with overlapping events for the same country. */
export function confidenceFor(agreeingSources: number): number {
  return agreeingSources >= 3 ? 0.85 : agreeingSources === 2 ? 0.65 : 0.4;
}

interface IodaEvent {
  location?: unknown;
  location_name?: unknown;
  start?: unknown;
  duration?: unknown;
  method?: unknown;
  datasource?: unknown;
  score?: unknown;
  overlaps_window?: unknown;
}
interface IodaEnvelope {
  type?: unknown;
  metadata?: { requestTime?: unknown; responseTime?: unknown };
  requestParameters?: { until?: unknown; limit?: unknown };
  error?: unknown;
  data: IodaEvent[];
}

interface Parsed {
  id: string;
  cc: string;
  iso3: string;
  name: string;
  datasource: string;
  method: string | null;
  start: number;
  end: number;
  durationSec: number;
  score: number | null;
  overlapsWindow: boolean | null;
  /** Still active when IODA answered: the API clips an open event at the query's `until`. */
  ongoing: boolean;
  queryUntil: number | null;
}

function envelope(payload: FetchedPayload): IodaEnvelope {
  // { type: "outages.events", metadata, requestParameters, error, data: [ events ] }; failures carry error + data: null.
  return jsonPayload<IodaEnvelope>(payload, (v) => isObject(v) && v.type === 'outages.events' && Array.isArray(v.data), 'IODA outage events response');
}

function duration(sec: number): string {
  const minutes = Math.round(sec / 60);
  const d = Math.floor(minutes / 1440);
  const h = Math.floor((minutes % 1440) / 60);
  const m = minutes % 60;
  return [d ? `${d} d` : '', h ? `${h} h` : '', m || (!d && !h) ? `${m} min` : ''].filter(Boolean).join(' ');
}

function utc(ms: number): string {
  return `${new Date(ms).toISOString().slice(0, 16).replace('T', ' ')} UTC`;
}

/** Validate one event. Returns the parsed event, a reject reason, or null for events that are legitimately not shown. */
function interpret(raw: IodaEvent, queryUntil: number | null, now: number): Parsed | string | null {
  if (!isObject(raw)) return 'event is not an object';
  const location = str(raw.location);
  const m = location ? /^country\/([A-Za-z]{2})$/.exec(location) : null;
  if (!m) return `unexpected location "${String(location).slice(0, 40)}"`;
  const cc = m[1]!.toUpperCase();
  const start = typeof raw.start === 'number' || typeof raw.start === 'string' ? fromEpochSeconds(raw.start) : null;
  if (start == null || start <= 0) return 'missing or invalid start time';
  if (start > now + 5 * MINUTE) return 'event start is in the future';
  const durationSec = num(raw.duration);
  if (durationSec == null || durationSec < 0) return 'missing or invalid duration';
  const datasource = str(raw.datasource, 40);
  if (!datasource || !/^[a-z0-9-]+$/i.test(datasource)) return 'missing or invalid datasource';
  const iso3 = toIso3(cc);
  if (!iso3) return null; // territory that is not a country in the gazetteer – cannot be placed
  const method = str(raw.method, 40);
  const score = num(raw.score);
  const end = start + Math.round(durationSec * 1000);
  return {
    id: `country-${cc}.${datasource}${method && /^[a-z0-9-]+$/i.test(method) ? `-${method}` : ''}.${Math.round(start / 1000)}`,
    cc,
    iso3,
    name: countryByIso3(iso3)?.name ?? str(raw.location_name, 80) ?? cc,
    datasource,
    method,
    start,
    end,
    durationSec,
    score: score != null && score >= 0 ? score : null,
    overlapsWindow: typeof raw.overlaps_window === 'boolean' ? raw.overlaps_window : null,
    ongoing: queryUntil != null && end >= queryUntil,
    queryUntil,
  };
}

export default defineAdapter({
  manifest,
  version: '1.0.0',

  async fetch(ctx) {
    const until = Math.floor(ctx.now / 1000);
    const from = until - WINDOW_DAYS * 86400;
    const payloads = [];
    for (let page = 0; page < MAX_PAGES; page++) {
      // ignoreMethods=*.sarima: skip the experimental SARIMA detections, exactly as the IODA dashboard does.
      const payload = await ctx.http.get(
        `${BASE}/outages/events?from=${from}&until=${until}&entityType=country&ignoreMethods=*.sarima&limit=${PAGE_LIMIT}&page=${page}`,
        { key: `events-page-${page}` },
      );
      payloads.push(payload);
      let count = 0;
      try {
        const body = payload.json<{ data?: unknown }>();
        count = Array.isArray(body?.data) ? body.data.length : 0;
      } catch {
        // not JSON – parse() reports the malformed payload
      }
      if (count < PAGE_LIMIT) break;
    }
    return payloads;
  },

  parse(payloads, ctx) {
    const out = new ParseCollector();
    const events = new Map<string, Parsed>();
    for (const payload of payloads) {
      const body = envelope(payload);
      out.noteUpstreamTime(parseTime(body.metadata?.responseTime));
      const queryUntil = fromEpochSeconds(body.requestParameters?.until);
      for (const raw of body.data) {
        out.item(raw, (e) => `${String(e?.location)} ${String(e?.datasource)} ${String(e?.start)}`, (e) => {
          const res = interpret(e, queryUntil, ctx.now);
          if (typeof res === 'string') return res;
          if (res && !events.has(res.id)) events.set(res.id, res); // pages can overlap when events shift between requests
          return [];
        });
      }
    }

    const byCountry = new Map<string, Parsed[]>();
    for (const e of events.values()) {
      const list = byCountry.get(e.cc);
      if (list) list.push(e);
      else byCountry.set(e.cc, [e]);
    }

    for (const e of events.values()) {
      out.item(e, (x) => x.id, (ev): RecordDraft => {
        const agreeing = [...new Set(byCountry.get(ev.cc)!.filter((o) => o.start <= ev.end && ev.start <= o.end).map((o) => o.datasource))].sort();
        const minutes = ev.durationSec / 60;
        const meanDropPct = ev.score != null && minutes > 0 ? Math.min(100, Math.round((ev.score / minutes) * 10) / 10) : null;
        const severity = severityFor(meanDropPct, minutes);
        const ds = DATASOURCES[ev.datasource] ?? { label: ev.datasource, signal: `${ev.datasource} signal` };
        const startSec = Math.round(ev.start / 1000);
        const linkUntil = Math.round(Math.min(ev.end + 6 * HOUR, ev.queryUntil ?? ev.end + 6 * HOUR) / 1000);
        const label = [
          ev.score != null ? `score ${Math.round(ev.score * 10) / 10}` : null,
          meanDropPct != null ? `mean drop ${meanDropPct}%` : null,
          `${duration(ev.durationSec)}${ev.ongoing ? ' so far' : ''}`,
        ];
        return {
          upstreamId: ev.id,
          layerId: 'ioda-outages',
          subcategory: ev.datasource,
          country: ev.iso3,
          occurredAt: ev.start,
          ...(ev.ongoing ? { ongoing: true, updatedAt: ev.queryUntil } : { endedAt: ev.end }),
          severity,
          severityLabel: label.filter(Boolean).join(' · '),
          confidence: confidenceFor(agreeing.length),
          confidenceBasis:
            agreeing.length > 1
              ? `${agreeing.length} IODA data sources (${agreeing.join(', ')}) report overlapping events for this country; automated detection, not a confirmed outage.`
              : `Only one IODA data source (${ev.datasource}) reports an event at this time; automated detection, not a confirmed outage.`,
          title: `Possible outage signal – ${ev.name} (${ds.label})`,
          description:
            `IODA detected a drop in the ${ds.signal} for ${ev.name} starting ${utc(ev.start)}, ` +
            `${ev.ongoing ? `still active after ${duration(ev.durationSec)}` : `lasting ${duration(ev.durationSec)}`}` +
            `${meanDropPct != null ? `; on average about ${meanDropPct}% below the recent baseline` : ''}. ` +
            'Automated detection on an aggregate signal – a possible outage, not a confirmed one.',
          attributes: {
            entityCode: ev.cc,
            datasource: ev.datasource,
            detectionMethod: ev.method,
            score: ev.score != null ? Math.round(ev.score * 100) / 100 : null,
            durationSec: ev.durationSec,
            meanDropPct,
            agreeingDatasourceCount: agreeing.length,
            agreeingDatasources: agreeing.join(', '),
            activeAtQueryTime: ev.ongoing,
            extendsBeyondQueryWindow: ev.overlapsWindow,
          },
          url: `https://ioda.inetintel.cc.gatech.edu/country/${ev.cc}?from=${startSec - 6 * 3600}&until=${linkUntil}`,
          derived: ['severity', 'confidence', 'attributes.meanDropPct', 'attributes.agreeingDatasourceCount'],
        };
      });
    }
    return out.done();
  },
});
