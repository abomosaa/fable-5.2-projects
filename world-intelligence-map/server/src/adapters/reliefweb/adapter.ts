/**
 * ReliefWeb API v2 (https://apidoc.reliefweb.int/) – disasters and headline reports.
 *
 * Search endpoints accept POST with a JSON body; the pre-approved `appname` always travels as a URL query
 * parameter. Responses are `{ href, time, links, totalCount, count, data: [{ id, score, href, fields }] }`.
 * ReliefWeb content belongs to the originating organisations: only titles, a short summary excerpt and links are kept.
 */
import { defineAdapter, isObject, jsonPayload, loadManifest, ParseCollector } from '../base.ts';
import { toIso3 } from '../../core/countries.ts';
import { plainText, str } from '../../core/text.ts';
import { DAY, parseTime } from '../../core/time.ts';
import type { FetchContext, FetchedPayload, RecordDraft } from '../../core/types.ts';
import manifestJson from './manifest.json' with { type: 'json' };

const manifest = loadManifest(manifestJson);
const BASE = 'https://api.reliefweb.int/v2';
export const DISASTER_PAGE = 500;
export const REPORT_LIMIT = 150;
const MAX_PAGES = 4;
/** Past disasters are included while their event date is at most this old. */
export const PAST_WINDOW_DAYS = 180;
export const SUMMARY_MAX = 300;

/** ReliefWeb disaster type → hazard class shared with other sources (only where the mapping is unambiguous). */
export const HAZARD_CLASS: Record<string, string> = {
  flood: 'flood',
  'flash flood': 'flood',
  'tropical cyclone': 'tropical_cyclone',
  earthquake: 'earthquake',
  drought: 'drought',
  'wild fire': 'wildfire',
  volcano: 'volcano',
};

const isoOffset = (ms: number) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, '+00:00');

export function disastersBody(now: number, offset: number): Record<string, unknown> {
  // Midnight-aligned so that the request (and its cache key) changes once a day, not on every poll.
  const from = Math.floor((now - PAST_WINDOW_DAYS * DAY) / DAY) * DAY;
  return {
    preset: 'latest',
    fields: {
      include: ['name', 'glide', 'status', 'type.name', 'type.code', 'primary_type.name', 'primary_type.code', 'primary_country.iso3', 'primary_country.name', 'primary_country.shortname', 'country.iso3', 'country.name', 'date.created', 'date.changed', 'date.event', 'url', 'url_alias'],
    },
    filter: {
      operator: 'OR',
      conditions: [
        { field: 'status', value: ['alert', 'current'], operator: 'OR' },
        { field: 'date.event', value: { from: isoOffset(from) } },
      ],
    },
    sort: ['date.event:desc', 'id:desc'],
    limit: DISASTER_PAGE,
    offset,
  };
}

export function reportsBody(): Record<string, unknown> {
  return {
    preset: 'latest', // published reports, newest first
    filter: { field: 'headline' }, // only reports selected as headlines
    fields: {
      include: ['title', 'date.created', 'date.original', 'primary_country.iso3', 'primary_country.name', 'primary_country.shortname', 'source.shortname', 'source.name', 'format.name', 'headline.title', 'headline.summary', 'url', 'url_alias'],
    },
    limit: REPORT_LIMIT,
    offset: 0,
  };
}

async function post(ctx: FetchContext, resource: 'disasters' | 'reports', key: string, body: Record<string, unknown>, appname: string): Promise<FetchedPayload> {
  return ctx.http.get(`${BASE}/${resource}?appname=${encodeURIComponent(appname)}`, {
    key,
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify(body),
    redact: [appname],
  });
}

interface RwItem {
  id?: unknown;
  fields?: Record<string, unknown>;
}
interface RwCountry {
  iso3?: unknown;
  name?: unknown;
  shortname?: unknown;
  primary?: unknown;
}
interface RwEnvelope {
  totalCount?: unknown;
  count?: unknown;
  data: RwItem[];
}

const isEnvelope = (v: unknown): boolean => isObject(v) && Array.isArray(v.data) && ('totalCount' in v || 'count' in v);
const list = <T>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]) : isObject(v) ? [v as T] : []);
const rwLink = (v: unknown): string | null => (typeof v === 'string' && /^https:\/\/reliefweb\.int\//.test(v) ? v : null);

function disasterRecord(item: RwItem): RecordDraft | string {
  const f = item.fields;
  const id = str(item.id);
  if (!id || !isObject(f)) return 'missing id or fields';
  const name = plainText(f.name, 200);
  if (!name) return 'missing name';
  const status = str(f.status)?.toLowerCase() ?? null;
  if (status !== 'alert' && status !== 'current' && status !== 'past') return `unexpected status "${String(f.status).slice(0, 30)}"`;
  const date = isObject(f.date) ? f.date : {};
  const event = parseTime(date.event);
  const created = parseTime(date.created);
  const changed = parseTime(date.changed);
  const occurredAt = event ?? created;
  if (occurredAt == null) return 'missing or unparseable event and creation dates';

  const primary = isObject(f.primary_country) ? (f.primary_country as RwCountry) : null;
  const countries: string[] = [];
  const names: string[] = [];
  for (const c of [primary, ...list<RwCountry>(f.country)]) {
    const iso3 = toIso3(str(c?.iso3));
    if (!iso3 || countries.includes(iso3)) continue;
    countries.push(iso3);
    names.push(str(c?.shortname) ?? str(c?.name) ?? iso3);
  }
  if (!countries.length) return 'no recognisable country';

  const types = list<{ name?: unknown; code?: unknown; primary?: unknown }>(f.type);
  const primaryType = str((isObject(f.primary_type) ? f.primary_type : null)?.name) ?? str(types.find((t) => t?.primary === true)?.name) ?? str(types[0]?.name);
  const typeNames = [...new Set([primaryType, ...types.map((t) => str(t?.name))].filter((t): t is string => !!t))];
  const hazardClass = primaryType ? (HAZARD_CLASS[primaryType.toLowerCase()] ?? null) : null;
  const ongoing = status !== 'past';

  return {
    upstreamId: `disaster-${id}`,
    layerId: 'reliefweb-disasters',
    category: hazardClass ?? 'disaster',
    subcategory: primaryType ?? null,
    country: countries,
    occurredAt,
    publishedAt: created,
    updatedAt: changed != null && changed >= occurredAt ? changed : null,
    ongoing,
    severity: null,
    severityLabel: `ReliefWeb status: ${status}`,
    confidence: null,
    title: name,
    description: `${primaryType ?? 'Disaster'} affecting ${names.slice(0, 6).join(', ')}${names.length > 6 ? ' and others' : ''}; ReliefWeb status "${status}"${event != null ? `, event date ${new Date(event).toISOString().slice(0, 10)}` : ''}.`,
    attributes: {
      status,
      glide: str(f.glide, 40),
      primaryType: primaryType ?? null,
      types: typeNames.join(', ') || null,
      hazardClass,
      primaryCountry: countries[0],
      countries: countries.join(', '),
      countryCount: countries.length,
      eventDate: event != null ? new Date(event).toISOString().slice(0, 10) : null,
    },
    url: rwLink(f.url_alias) ?? rwLink(f.url),
    derived: event == null ? ['occurredAt'] : [],
  };
}

function reportRecord(item: RwItem): RecordDraft | string {
  const f = item.fields;
  const id = str(item.id);
  if (!id || !isObject(f)) return 'missing id or fields';
  const headline = isObject(f.headline) ? f.headline : {};
  const reportTitle = plainText(f.title, 240);
  const title = plainText(headline.title, 240) || reportTitle;
  if (!title) return 'missing title';
  const date = isObject(f.date) ? f.date : {};
  const created = parseTime(date.created);
  if (created == null) return `unparseable date.created "${String(date.created).slice(0, 30)}"`;
  const original = parseTime(date.original);
  const pc = isObject(f.primary_country) ? (f.primary_country as RwCountry) : null;
  const iso3 = toIso3(str(pc?.iso3));
  const sources = [...new Set(list<{ shortname?: unknown; name?: unknown }>(f.source).map((s) => str(s?.shortname, 60) ?? str(s?.name, 120)).filter((s): s is string => !!s))];
  const summary = plainText(headline.summary, SUMMARY_MAX);

  return {
    upstreamId: `report-${id}`,
    layerId: 'reliefweb-reports',
    subcategory: str(list<{ name?: unknown }>(f.format)[0]?.name, 60),
    // "World" and regional pseudo-countries have no ISO country: keep those as non-geographic bulletins.
    ...(iso3 ? { country: iso3 } : { geometryKind: 'global' as const }),
    occurredAt: created,
    publishedAt: created,
    severity: null,
    confidence: null,
    title,
    description: summary || null,
    attributes: {
      sources: sources.slice(0, 5).join(', ') || null,
      reportTitle: reportTitle && reportTitle !== title ? reportTitle : null,
      primaryCountryName: str(pc?.shortname) ?? str(pc?.name),
      originallyPublished: original != null ? new Date(original).toISOString().slice(0, 10) : null,
    },
    url: rwLink(f.url_alias) ?? rwLink(f.url) ?? `https://reliefweb.int/node/${encodeURIComponent(id)}`,
  };
}

export default defineAdapter({
  manifest,
  version: '1.0.0',

  async fetch(ctx) {
    const appname = (ctx.env.RELIEFWEB_APPNAME ?? '').trim();
    if (!appname) throw new Error('RELIEFWEB_APPNAME is not set');
    const payloads: FetchedPayload[] = [];
    for (let page = 0; page < MAX_PAGES; page++) {
      const offset = page * DISASTER_PAGE;
      const payload = await post(ctx, 'disasters', `disasters:${offset}`, disastersBody(ctx.now, offset), appname);
      payloads.push(payload);
      let total = 0;
      let count = 0;
      try {
        const env = payload.json() as RwEnvelope;
        total = Number(env?.totalCount) || 0;
        count = Number(env?.count) || (Array.isArray(env?.data) ? env.data.length : 0);
      } catch {
        break; // parse() reports the malformed page
      }
      if (count === 0 || offset + count >= total) break; // documented stop condition: offset + count >= totalCount
    }
    payloads.push(await post(ctx, 'reports', 'reports:0', reportsBody(), appname));
    return payloads;
  },

  parse(payloads) {
    const out = new ParseCollector();
    const seen = new Set<string>();
    for (const payload of payloads) {
      const kind = payload.key.startsWith('reports') ? 'reports' : 'disasters';
      const body = jsonPayload<RwEnvelope>(payload, isEnvelope, 'ReliefWeb API response');
      for (const raw of body.data) {
        out.item(raw, (x) => `${kind} ${String(x?.id)} ${String(x?.fields?.name ?? x?.fields?.title ?? '').slice(0, 80)}`, (item): RecordDraft | RecordDraft[] | string => {
          if (!isObject(item)) return 'item is not an object';
          const draft = kind === 'reports' ? reportRecord(item) : disasterRecord(item);
          if (typeof draft === 'string') return draft;
          if (seen.has(draft.upstreamId)) return []; // an item can shift between pages while paginating
          seen.add(draft.upstreamId);
          return draft;
        });
      }
    }
    return out.done();
  },
});
