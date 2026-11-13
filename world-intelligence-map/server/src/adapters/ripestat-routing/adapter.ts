import { defineAdapter, isObject, jsonPayload, loadManifest, ParseCollector, getEach } from '../base.ts';
import { countryByIso3, toIso3 } from '../../core/countries.ts';
import { num, str } from '../../core/text.ts';
import { DAY, HOUR, parseTime } from '../../core/time.ts';
import type { RecordDraft } from '../../core/types.ts';
import manifestJson from './manifest.json' with { type: 'json' };

const manifest = loadManifest(manifestJson);
const LAYER = manifest.layers[0]!;
const ENDPOINT = 'https://stat.ripe.net/data/country-resource-stats/data.json';
const DEFAULT_SOURCEAPP = 'world-intelligence-map';

/**
 * Curated watch-list (ISO 3166-1 alpha-2, as the endpoint expects): large economies plus countries with
 * frequent shutdowns, conflict or fragile connectivity. One small request per country and run.
 */
export const WATCHLIST = [
  // large economies
  'us', 'cn', 'in', 'jp', 'de', 'gb', 'fr', 'br', 'ru', 'kr', 'it', 'ca', 'au', 'mx', 'id', 'tr', 'sa', 'za', 'ng', 'eg',
  // frequent shutdowns / conflict / fragile connectivity
  'ir', 'iq', 'sy', 'ua', 'mm', 'et', 'sd', 've', 'cu', 'pk', 'bd', 'af', 'ye', 'ly', 'kz', 'by', 'cd', 'il', 'ps', 'lb',
] as const;

/** Hours of history requested before the comparison day, so every recent hour has a value 24 h earlier. */
const WINDOW_MS = 48 * HOUR;
/** The start time is aligned to a 6-hour grid so that the request URL (and thus the body cache) is stable between polls. */
const START_GRID_MS = 6 * HOUR;
/** Upper bound when expanding one run-length period into hourly values (the request never spans more than 54 hours). */
const MAX_PERIOD_HOURS = 24 * 8;

/** `YYYY-MM-DDTHH:mm` (UTC), the ISO 8601 form used in the endpoint documentation. */
function isoMinute(ms: number): string {
  return new Date(ms).toISOString().slice(0, 16);
}

/** The documented format of `sourceapp`: alphanumeric plus hyphens and underscores, no whitespace. */
function sourceApp(env: Record<string, string | undefined>): { value: string; fromEnv: boolean } {
  const v = env.RIPESTAT_SOURCEAPP?.trim();
  return v && /^[A-Za-z0-9_-]{1,64}$/.test(v) ? { value: v, fromEnv: true } : { value: DEFAULT_SOURCEAPP, fromEnv: false };
}

function signed(n: number, digits: number): string {
  return `${n > 0 ? '+' : ''}${n.toFixed(digits)}`;
}

function pctChange(now: number | null, before: number | null): number | null {
  if (now == null || before == null || now < 0 || before <= 0) return null;
  return Math.round(((now - before) / before) * 100_000) / 1000 + 0; // + 0 turns -0 into 0
}

/** RIPEstat uses -1 for "not available". */
function count(v: unknown): number | null {
  const n = num(v);
  return n != null && n >= 0 ? n : null;
}

interface StatsEntry {
  timeline?: unknown;
  v4_prefixes_ris?: unknown;
  v6_prefixes_ris?: unknown;
  asns_ris?: unknown;
  asns_stats?: unknown;
}

interface HourValue {
  v4: number;
  v6: number | null;
  asns: number | null;
  registeredAsns: number | null;
}

interface Body {
  status?: unknown;
  data: { stats: unknown[]; resource?: unknown; resolution?: unknown; latest_time?: unknown };
}

export default defineAdapter({
  manifest,
  version: '1.0.0',

  async fetch(ctx) {
    const start = Math.floor((ctx.now - WINDOW_MS) / START_GRID_MS) * START_GRID_MS;
    const app = sourceApp(ctx.env);
    // Sequential on purpose (RIPEstat allows at most 8 concurrent requests per IP; the client spaces requests by minIntervalMs).
    // Countries are independent of each other, so one failed country does not discard the rest.
    return getEach(
      ctx,
      WATCHLIST.map((cc) => ({
        url: `${ENDPOINT}?resource=${cc}&starttime=${isoMinute(start)}&resolution=1h&sourceapp=${encodeURIComponent(app.value)}`,
        // The identifier is not a secret, but operator-supplied env values are kept out of provenance URLs all the same.
        opts: { key: cc, redact: app.fromEnv ? [app.value] : undefined },
      })),
    );
  },

  parse(payloads, ctx) {
    const out = new ParseCollector();
    for (const payload of payloads) {
      const body = jsonPayload<Body>(
        payload,
        (v) => isObject(v) && isObject(v.data) && Array.isArray(v.data.stats),
        'RIPEstat country-resource-stats response',
      );
      if (body.status != null && body.status !== 'ok') throw new Error(`malformed RIPEstat country-resource-stats response: status "${String(body.status).slice(0, 40)}" (${payload.key})`);
      const data = body.data;
      const cc = (str(data.resource) ?? payload.key).toUpperCase();
      const iso3 = toIso3(cc);
      if (!iso3) {
        out.reject(`unrecognised country resource "${cc.slice(0, 20)}"`, payload.key);
        continue;
      }
      if (data.resolution != null && data.resolution !== '1h') {
        out.reject(`unexpected resolution "${String(data.resolution).slice(0, 20)}" (hourly values were requested)`, cc);
        continue;
      }
      out.noteUpstreamTime(parseTime(data.latest_time));

      // Pass 1 – expand the run-length encoded validity periods into one value per hour.
      const byHour = new Map<number, HourValue>();
      for (const raw of data.stats) {
        out.item(raw as StatsEntry | null, (e) => `${cc} ${JSON.stringify(e?.timeline ?? null)} v4=${String(e?.v4_prefixes_ris)}`, (e): RecordDraft[] | string => {
          if (!isObject(e)) return 'stats entry is not an object';
          if (!Array.isArray(e.timeline) || e.timeline.length === 0) return 'missing timeline';
          const rawV4 = num(e.v4_prefixes_ris);
          if (rawV4 == null) return 'non-numeric v4_prefixes_ris';
          if (rawV4 < 0) return []; // -1 = upstream has no routing data for the period – not an error
          const value: HourValue = { v4: rawV4, v6: count(e.v6_prefixes_ris), asns: count(e.asns_ris), registeredAsns: count(e.asns_stats) };
          const hours: number[] = [];
          for (const period of e.timeline as unknown[]) {
            const start = isObject(period) ? parseTime(period.starttime) : null;
            const end = isObject(period) ? parseTime(period.endtime) : null;
            if (start == null || end == null) return 'unparseable timeline period';
            if (end < start) return 'timeline period ends before it starts';
            if ((end - start) / HOUR > MAX_PERIOD_HOURS) return 'timeline period too long';
            if (start > ctx.now) return 'timeline period is in the future';
            for (let t = start; t <= end && t <= ctx.now; t += HOUR) hours.push(t);
          }
          for (const t of hours) if (byHour.has(t)) return `duplicate observation for ${isoMinute(t)}Z`;
          for (const t of hours) byHour.set(t, value);
          return [];
        });
      }

      // Pass 2 – one record per hour that has a value exactly 24 hours earlier.
      const country = countryByIso3(iso3)?.name ?? iso3;
      for (const t of [...byHour.keys()].sort((a, b) => a - b)) {
        const cur = byHour.get(t)!;
        const before = byHour.get(t - DAY);
        const change = before ? pctChange(cur.v4, before.v4) : null;
        if (!before || change == null) continue; // start of the window, or nothing routed 24 h earlier – no comparison possible
        const when = isoMinute(t);
        out.records.push({
          upstreamId: `${cc}.${when.slice(0, 13)}Z`,
          layerId: LAYER.id,
          country: iso3,
          occurredAt: t,
          title: `Routed IPv4 prefixes – ${country}: ${signed(change, 2)} % vs 24 h earlier (${when.replace('T', ' ')} UTC)`,
          description:
            `${cur.v4} IPv4 prefixes registered to ${country} were visible in BGP at RIPE RIS collectors in the hour from ${when.replace('T', ' ')} UTC, ` +
            `against ${before.v4} 24 hours earlier. A change in routed prefixes is a routing-visibility signal, not proof of an outage.`,
          metric: { name: LAYER.metric!.name, value: change, unit: LAYER.metric!.unit, period: `${when}Z` },
          attributes: {
            countryCode: cc,
            routedV4Prefixes: cur.v4,
            routedV4Prefixes24hEarlier: before.v4,
            routedV4PrefixChange: Math.round((cur.v4 - before.v4) * 10) / 10,
            routedV6Prefixes: cur.v6,
            routedV6Prefixes24hEarlier: before.v6,
            routedV6PrefixChangePct: pctChange(cur.v6, before.v6),
            routedAsns: cur.asns,
            routedAsns24hEarlier: before.asns,
            routedAsnChangePct: pctChange(cur.asns, before.asns),
            registeredAsns: cur.registeredAsns,
            resolution: '1h',
          },
          url: `https://stat.ripe.net/resource/${cc}`,
          derived: ['metric'],
        });
      }
    }
    return out.done();
  },
});
