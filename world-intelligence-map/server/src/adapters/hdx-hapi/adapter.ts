/**
 * HDX Humanitarian API (HDX HAPI) v2 – national-level indicators.
 *
 * Endpoint paths, parameters and response fields follow https://hapi.humdata.org/openapi.json (API 0.9.15):
 * every theme endpoint answers `{ "data": [ … ] }`, is paginated with limit/offset and requires an
 * `app_identifier` (base64 of "application:email") supplied by the user.
 */
import { defineAdapter, isObject, jsonPayload, loadManifest, ParseCollector } from '../base.ts';
import { toIso3 } from '../../core/countries.ts';
import { num, str } from '../../core/text.ts';
import { parseTime } from '../../core/time.ts';
import type { FetchedPayload, RecordDraft } from '../../core/types.ts';
import manifestJson from './manifest.json' with { type: 'json' };

const manifest = loadManifest(manifestJson);
const BASE = 'https://hapi.humdata.org/api/v2';
export const PAGE_SIZE = 1000;
const MAX_PAGES = 20;
const YEARS_BACK = 3;

type EndpointKey = 'idps' | 'humanitarian-needs' | 'food-security';

export const ENDPOINTS: { key: EndpointKey; path: string; query: string }[] = [
  { key: 'idps', path: '/affected-people/idps', query: 'admin_level=0' },
  { key: 'humanitarian-needs', path: '/affected-people/humanitarian-needs', query: 'admin_level=0&population_status=INN&sector_code=Intersectoral' },
  { key: 'food-security', path: '/food-security-nutrition-poverty/food-security', query: 'admin_level=0&ipc_phase=3%2B&ipc_type=current' },
];

/** IOM DTM assessment types that report a displacement stock (baseline and site assessments). */
const IDP_STOCK_ASSESSMENTS = new Set(['BA', 'SA']);
const DATASET_PAGE: Record<EndpointKey, string> = {
  idps: 'https://data.humdata.org/dataset/hdx-hapi-idps',
  'humanitarian-needs': 'https://data.humdata.org/dataset/hdx-hapi-humanitarian-needs',
  'food-security': 'https://data.humdata.org/dataset/hdx-hapi-food-security',
};

type Row = Record<string, unknown>;

export function endpointUrl(e: (typeof ENDPOINTS)[number], offset: number, now: number, appIdentifier: string): string {
  const startDate = `${new Date(now).getUTCFullYear() - YEARS_BACK}-01-01`;
  return `${BASE}${e.path}?${e.query}&start_date=${startDate}&output_format=json&limit=${PAGE_SIZE}&offset=${offset}&app_identifier=${encodeURIComponent(appIdentifier)}`;
}

const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const fmt = (n: number) => n.toLocaleString('en-US');

interface Common {
  iso3: string;
  name: string;
  start: number;
  end: number | null;
  startDay: string;
  endDay: string | null;
}

/** Shared row checks. Returns a reject reason, `null` to skip silently, or the interpreted fields. */
function common(r: Row, now: number): Common | string | null {
  const code = str(r.location_code);
  if (!code) return 'missing location_code';
  if (r.admin_level !== 0 && r.admin_level !== '0') return null; // sub-national rows are not used
  const iso3 = toIso3(code);
  if (!iso3) return null; // territory outside the gazetteer
  const start = parseTime(r.reference_period_start);
  if (start == null) return `unparseable reference_period_start "${String(r.reference_period_start).slice(0, 30)}"`;
  if (start > now) return null; // period has not begun
  const end = parseTime(r.reference_period_end);
  return { iso3, name: str(r.location_name, 120) ?? iso3, start, end, startDay: day(start), endDay: end != null ? day(end) : null };
}

function people(v: unknown): number | string {
  const n = typeof v === 'number' ? v : num(v);
  if (n == null) return 'non-numeric population';
  if (n < 0) return 'negative population';
  return Math.round(n);
}

function idpRecord(r: Row, now: number): RecordDraft | RecordDraft[] | string {
  const c = common(r, now);
  if (c == null) return [];
  if (typeof c === 'string') return c;
  const assessment = str(r.assessment_type) ?? '';
  if (!IDP_STOCK_ASSESSMENTS.has(assessment)) return []; // flow monitoring, emergency tracking, registration, surveys
  const population = people(r.population);
  if (typeof population === 'string') return population;
  if (population === 0) return [];
  const round = num(r.reporting_round);
  const operation = str(r.operation, 200) ?? 'unnamed operation';
  return {
    upstreamId: `idps:${c.iso3}:${assessment}:${round ?? 'x'}:${c.startDay}:${operation}`,
    layerId: 'hapi-idps',
    country: c.iso3,
    occurredAt: c.start,
    title: `Internally displaced persons – ${c.name} (${c.startDay})`,
    description: `${fmt(population)} internally displaced persons recorded by IOM DTM${round != null ? ` in reporting round ${round}` : ''} of the operation "${operation}" (${assessment === 'BA' ? 'baseline assessment' : 'site assessment'}).`,
    metric: { name: 'Internally displaced persons', value: population, unit: 'people', period: c.endDay && c.endDay !== c.startDay ? `${c.startDay}/${c.endDay}` : c.startDay },
    attributes: { operation, assessmentType: assessment, reportingRound: round, referencePeriodStart: c.startDay, referencePeriodEnd: c.endDay, resourceHdxId: str(r.resource_hdx_id), dataProvider: 'IOM DTM' },
    url: DATASET_PAGE.idps,
  };
}

function needsRecord(r: Row, now: number): RecordDraft | RecordDraft[] | string {
  const c = common(r, now);
  if (c == null) return [];
  if (typeof c === 'string') return c;
  // The API filters are wildcards – re-check that this is the national intersectoral people-in-need total.
  if (r.population_status !== 'INN') return [];
  if (String(r.sector_code ?? '').toLowerCase() !== 'intersectoral') return [];
  const category = String(r.category ?? '').trim().toLowerCase();
  if (category !== '' && category !== 'all' && category !== 'total') return []; // age / gender / group disaggregation
  const population = people(r.population);
  if (typeof population === 'string') return population;
  if (population === 0) return [];
  const fullYear = c.startDay.endsWith('-01-01') && c.endDay === `${c.startDay.slice(0, 4)}-12-31`;
  const period = fullYear ? c.startDay.slice(0, 4) : c.endDay ? `${c.startDay}/${c.endDay}` : c.startDay;
  return {
    upstreamId: `needs:${c.iso3}:${c.startDay}`,
    layerId: 'hapi-humanitarian-needs',
    country: c.iso3,
    occurredAt: c.start,
    title: `People in need – ${c.name} (${period})`,
    description: `${fmt(population)} people estimated to be in need of humanitarian assistance across all sectors (intersectoral figure, OCHA Humanitarian Programme Cycle).`,
    metric: { name: 'People in need', value: population, unit: 'people', period },
    attributes: { populationStatus: 'INN', sectorCode: str(r.sector_code), referencePeriodStart: c.startDay, referencePeriodEnd: c.endDay, resourceHdxId: str(r.resource_hdx_id), dataProvider: 'OCHA HPC Tools' },
    url: DATASET_PAGE['humanitarian-needs'],
  };
}

function foodRecord(r: Row, now: number): RecordDraft | RecordDraft[] | string {
  const c = common(r, now);
  if (c == null) return [];
  if (typeof c === 'string') return c;
  if (r.ipc_phase !== '3+' || r.ipc_type !== 'current') return [];
  const population = people(r.population_in_phase);
  if (typeof population === 'string') return population;
  const fraction = num(r.population_fraction_in_phase);
  const period = c.endDay ? `${c.startDay}/${c.endDay}` : c.startDay;
  return {
    upstreamId: `food:${c.iso3}:${c.startDay}`,
    layerId: 'hapi-food-insecurity',
    country: c.iso3,
    occurredAt: c.start,
    title: `Acute food insecurity (IPC 3+) – ${c.name} (${c.startDay}${c.endDay ? ` to ${c.endDay}` : ''})`,
    description: `${fmt(population)} people classified in IPC/CH phase 3 (crisis) or worse${fraction != null ? `, ${(fraction * 100).toFixed(0)}% of the analysed population,` : ''} in the current period of the analysis.`,
    metric: { name: 'People in IPC phase 3 or above', value: population, unit: 'people', period },
    attributes: {
      ipcPhase: '3+',
      ipcType: 'current',
      shareOfAnalysedPopulation: fraction,
      referencePeriodStart: c.startDay,
      referencePeriodEnd: c.endDay,
      resourceHdxId: str(r.resource_hdx_id),
      dataProvider: 'IPC / Cadre Harmonisé',
    },
    url: DATASET_PAGE['food-security'],
  };
}

const HANDLERS: Record<EndpointKey, (r: Row, now: number) => RecordDraft | RecordDraft[] | string> = {
  idps: idpRecord,
  'humanitarian-needs': needsRecord,
  'food-security': foodRecord,
};

export default defineAdapter({
  manifest,
  version: '1.0.0',

  async fetch(ctx) {
    const appIdentifier = (ctx.env.HDX_APP_IDENTIFIER ?? '').trim();
    if (!appIdentifier) throw new Error('HDX_APP_IDENTIFIER is not set');
    const payloads: FetchedPayload[] = [];
    for (const e of ENDPOINTS) {
      for (let page = 0; page < MAX_PAGES; page++) {
        const offset = page * PAGE_SIZE;
        const payload = await ctx.http.get(endpointUrl(e, offset, ctx.now, appIdentifier), { key: `${e.key}:${offset}`, redact: [appIdentifier] });
        payloads.push(payload);
        let rows = 0;
        try {
          const data = (payload.json() as { data?: unknown })?.data;
          rows = Array.isArray(data) ? data.length : 0;
        } catch {
          rows = 0; // parse() reports the malformed page
        }
        if (rows < PAGE_SIZE) break; // a short page is the last page
      }
    }
    return payloads;
  },

  parse(payloads, ctx) {
    const out = new ParseCollector();
    const seen = new Set<string>();
    for (const payload of payloads) {
      const key = payload.key.split(':')[0] as EndpointKey;
      const handler = HANDLERS[key];
      if (!handler) throw new Error(`malformed HDX HAPI payload set: unexpected request key "${payload.key}"`);
      const body = jsonPayload<{ data: Row[] }>(payload, (v) => isObject(v) && Array.isArray(v.data), 'HDX HAPI response');
      for (const row of body.data) {
        out.item(row, (r) => `${key} ${String(r?.location_code)} ${String(r?.reference_period_start)}`, (r) => {
          if (!isObject(r)) return 'row is not an object';
          const res = handler(r, ctx.now);
          if (typeof res === 'string' || Array.isArray(res)) return res;
          if (seen.has(res.upstreamId)) return []; // same row repeated across pages or resources
          seen.add(res.upstreamId);
          return res;
        });
      }
    }
    return out.done();
  },
});
