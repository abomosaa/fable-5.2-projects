import { defineAdapter, isObject, jsonPayload, loadManifest, ParseCollector } from '../base.ts';
import { countryByIso3, toIso3 } from '../../core/countries.ts';
import { parseTime, DAY } from '../../core/time.ts';
import type { AttrValue, FetchedPayload, RecordDraft } from '../../core/types.ts';
import manifestJson from './manifest.json' with { type: 'json' };

const manifest = loadManifest(manifestJson);
const BASE = 'https://api.ooni.io/api/v1/aggregation';

/** Number of complete UTC days requested on every poll. */
export const WINDOW_DAYS = 7;
/**
 * Country-days with fewer measurements than this (summed over the tests of a layer) are not emitted:
 * a percentage of a handful of measurements is noise. Application choice, documented in the manifest.
 */
export const MIN_MEASUREMENTS = 50;

/** OONI test name → attribute prefix and display label. One aggregation request per test. */
export const TESTS = {
  web_connectivity: { prefix: 'webConnectivity', label: 'Web Connectivity' },
  whatsapp: { prefix: 'whatsapp', label: 'WhatsApp' },
  telegram: { prefix: 'telegram', label: 'Telegram' },
  signal: { prefix: 'signal', label: 'Signal' },
  facebook_messenger: { prefix: 'facebookMessenger', label: 'Facebook Messenger' },
  tor: { prefix: 'tor', label: 'Tor' },
  psiphon: { prefix: 'psiphon', label: 'Psiphon' },
} as const;
export type TestName = keyof typeof TESTS;

interface LayerSpec {
  layerId: string;
  /** Short key used in the record id. */
  key: string;
  tests: TestName[];
  /** Which upstream counter is the numerator. */
  numerator: 'anomaly' | 'confirmed';
  title: string;
  /** "N of M <subject> from <country> on <day> (UTC) <verdict> (x %)." */
  subject: string;
  verdict: string;
  caveat: string;
}

const ANOMALY_CAVEAT =
  'An anomaly is a measurement that deviates from the control; OONI notes that anomalies are often false positives and are not confirmed blocking.';

export const LAYERS: LayerSpec[] = [
  {
    layerId: 'ooni-web-anomalies',
    key: 'web-anomalies',
    tests: ['web_connectivity'],
    numerator: 'anomaly',
    title: 'Anomalous web measurements',
    subject: 'OONI Web Connectivity measurements',
    verdict: 'were flagged as anomalies',
    caveat: ANOMALY_CAVEAT,
  },
  {
    layerId: 'ooni-web-confirmed',
    key: 'web-confirmed',
    tests: ['web_connectivity'],
    numerator: 'confirmed',
    title: 'Web measurements labelled "confirmed" by OONI',
    subject: 'OONI Web Connectivity measurements',
    verdict: 'matched a block-page or DNS fingerprint known to OONI (upstream label: confirmed)',
    caveat: 'Fingerprints exist only for some countries and networks, and the share depends on which sites volunteers tested that day.',
  },
  {
    layerId: 'ooni-messaging-anomalies',
    key: 'messaging-anomalies',
    tests: ['whatsapp', 'telegram', 'signal', 'facebook_messenger'],
    numerator: 'anomaly',
    title: 'Anomalous messaging-app measurements',
    subject: 'OONI instant-messaging test measurements (WhatsApp, Telegram, Signal, Facebook Messenger)',
    verdict: 'were flagged as anomalies',
    caveat: ANOMALY_CAVEAT,
  },
  {
    layerId: 'ooni-circumvention-anomalies',
    key: 'circumvention-anomalies',
    tests: ['tor', 'psiphon'],
    numerator: 'anomaly',
    title: 'Anomalous circumvention-tool measurements',
    subject: 'OONI circumvention-tool test measurements (Tor, Psiphon)',
    verdict: 'were flagged as anomalies',
    caveat: ANOMALY_CAVEAT,
  },
];

interface Counts {
  anomaly: number;
  confirmed: number;
  failure: number;
  ok: number;
  total: number;
}
const COUNT_FIELDS: [keyof Counts, string][] = [
  ['anomaly', 'anomaly_count'],
  ['confirmed', 'confirmed_count'],
  ['failure', 'failure_count'],
  ['ok', 'ok_count'],
  ['total', 'measurement_count'],
];

/** `cc|dayMs` → counts, per test. */
type Table = Map<string, Counts>;

function ymd(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}
function pct(part: number, total: number): number {
  return Math.round((part / total) * 10000) / 100;
}
function count(v: unknown): number | null {
  return typeof v === 'number' && Number.isInteger(v) && v >= 0 ? v : null;
}

/** Validate one aggregation row and add it to the table. Returns a reject reason, or null when accepted / legitimately skipped. */
function addRow(table: Table, row: unknown, now: number): string | null {
  if (!isObject(row)) return 'row is not an object';
  const cc = row.probe_cc;
  if (typeof cc !== 'string' || !/^[A-Z]{2}$/.test(cc)) return 'missing or invalid probe_cc';
  const dayRaw = row.measurement_start_day;
  const t = parseTime(dayRaw);
  if (t == null) return `unparseable measurement_start_day "${String(dayRaw).slice(0, 40)}"`;
  // time_grain=day yields "YYYY-MM-DD"; finer buckets (the API's "auto" grain is hourly for short ranges) are folded into their UTC day.
  const day = Math.floor(t / DAY) * DAY;
  if (day > now) return 'measurement day is in the future';
  const c = {} as Counts;
  for (const [k, field] of COUNT_FIELDS) {
    const n = count(row[field]);
    if (n == null) return `${field} is not a non-negative integer`;
    c[k] = n;
  }
  if (c.anomaly + c.confirmed + c.failure + c.ok > c.total) return 'inconsistent counts (parts exceed measurement_count)';
  if (c.total === 0) return null; // nothing measured – not a record
  const key = `${cc}|${day}`;
  const prev = table.get(key);
  if (prev) for (const [k] of COUNT_FIELDS) prev[k] += c[k];
  else table.set(key, c);
  return null;
}

function parseTable(payload: FetchedPayload, out: ParseCollector, now: number): Table {
  // Response shape: { v, dimension_count, db_stats, result: [ rows ] }. Errors come back as { error: "..." }.
  const body = jsonPayload<{ result: unknown[] }>(payload, (v) => isObject(v) && Array.isArray(v.result), 'OONI aggregation response');
  const table: Table = new Map();
  for (const row of body.result) {
    out.item(
      row,
      (r) => `${payload.key} ${JSON.stringify(r)}`,
      (r) => addRow(table, r, now) ?? [],
    );
  }
  return table;
}

export default defineAdapter({
  manifest,
  version: '1.0.0',

  async fetch(ctx) {
    // The last WINDOW_DAYS complete UTC days: `until` is exclusive and is the start of the current day.
    const until = Math.floor(ctx.now / DAY) * DAY;
    const since = until - WINDOW_DAYS * DAY;
    const payloads = [];
    for (const test of Object.keys(TESTS)) {
      payloads.push(
        await ctx.http.get(`${BASE}?test_name=${test}&since=${ymd(since)}&until=${ymd(until)}&time_grain=day&axis_x=probe_cc&axis_y=measurement_start_day`, { key: test }),
      );
    }
    return payloads;
  },

  parse(payloads, ctx) {
    const out = new ParseCollector();
    const tables = new Map<TestName, Table>();
    for (const payload of payloads) {
      if (!(payload.key in TESTS)) throw new Error(`malformed OONI aggregation response: unexpected request key (${payload.key})`);
      tables.set(payload.key as TestName, parseTable(payload, out, ctx.now));
    }

    for (const layer of LAYERS) {
      const keys = new Set<string>();
      for (const test of layer.tests) for (const k of tables.get(test)?.keys() ?? []) keys.add(k);
      for (const key of [...keys].sort()) {
        out.item(key, (k) => `${layer.key} ${k}`, (k): RecordDraft | RecordDraft[] => {
          const [cc, dayStr] = k.split('|') as [string, string];
          const day = Number(dayStr);
          const sum: Counts = { anomaly: 0, confirmed: 0, failure: 0, ok: 0, total: 0 };
          const perTest: Record<string, AttrValue> = {};
          const included: TestName[] = [];
          for (const test of layer.tests) {
            const c = tables.get(test)?.get(k);
            if (!c) continue;
            included.push(test);
            for (const [f] of COUNT_FIELDS) sum[f] += c[f];
            if (layer.tests.length > 1) {
              perTest[`${TESTS[test].prefix}AnomalyPct`] = pct(c.anomaly, c.total);
              perTest[`${TESTS[test].prefix}AnomalyCount`] = c.anomaly;
              perTest[`${TESTS[test].prefix}MeasurementCount`] = c.total;
            }
          }
          if (sum.total < MIN_MEASUREMENTS) return []; // too few measurements to be meaningful – skipped, not broken
          const iso3 = toIso3(cc);
          if (!iso3) return []; // unknown location (ZZ) or a territory absent from the gazetteer
          const countryName = countryByIso3(iso3)?.name ?? cc;
          const period = ymd(day);
          const numerator = sum[layer.numerator];
          const value = pct(numerator, sum.total);
          const def = manifest.layers.find((l) => l.id === layer.layerId)!;
          return {
            upstreamId: `${layer.key}.${cc}.${period}`,
            layerId: layer.layerId,
            country: iso3,
            occurredAt: day,
            title: `${layer.title} – ${countryName} (${period})`,
            description: `${numerator} of ${sum.total} ${layer.subject} from ${countryName} on ${period} (UTC) ${layer.verdict} (${value} %). ${layer.caveat}`,
            metric: { name: def.metric!.name, value, unit: def.metric!.unit, period },
            attributes: {
              probeCc: cc,
              testNames: included.join(', '),
              measurementCount: sum.total,
              anomalyCount: sum.anomaly,
              confirmedCount: sum.confirmed,
              failureCount: sum.failure,
              okCount: sum.ok,
              ...perTest,
            },
            url:
              layer.tests.length === 1
                ? `https://explorer.ooni.org/chart/mat?probe_cc=${cc}&test_name=${layer.tests[0]}&since=${period}&until=${ymd(day + DAY)}&time_grain=day&axis_x=measurement_start_day`
                : `https://explorer.ooni.org/country/${cc}`,
            // The percentage is computed here from OONI's counts; OONI publishes no per-value confidence.
            confidence: null,
            derived: ['metric'],
          };
        });
      }
    }
    return out.done();
  },
});
