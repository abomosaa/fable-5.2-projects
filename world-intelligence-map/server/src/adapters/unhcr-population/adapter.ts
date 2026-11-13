/**
 * UNHCR Refugee Data Finder – population figures.
 *
 * Two aggregated views of the same table are requested: `coo_all=true` (one row per year and country of ORIGIN,
 * summed over all countries of asylum) and `coa_all=true` (one row per year and country of ASYLUM). The IDP figure
 * (people displaced inside their own country) is identical in both views and is read from the origin view.
 * Counts arrive as numbers, as the string "0", or as "-" (not reported).
 */
import { defineAdapter, isObject, jsonPayload, loadManifest, ParseCollector } from '../base.ts';
import { toIso3 } from '../../core/countries.ts';
import { str } from '../../core/text.ts';
import { yearStart } from '../../core/time.ts';
import type { FetchContext, FetchedPayload, RecordDraft } from '../../core/types.ts';
import manifestJson from './manifest.json' with { type: 'json' };

const manifest = loadManifest(manifestJson);
const BASE = 'https://api.unhcr.org/population/v1/population/';
const PAGE_SIZE = 1000;
const MAX_PAGES = 10;
/** Reporting years requested: the current year and the three before it (the current year is usually not published yet). */
const YEARS_BACK = 3;

type Side = 'coo' | 'coa';

/**
 * UNHCR "ISO" codes that are not countries. They must be filtered explicitly: "UNK" (origin unknown) is also
 * a widely used code for Kosovo and would otherwise be resolved to it by the gazetteer.
 */
const NOT_A_COUNTRY = new Set(['UNK', 'UKN', 'XXA', 'STA', 'TIB', 'VAR']);

interface UnhcrRow {
  year?: unknown;
  coo?: unknown;
  coo_iso?: unknown;
  coo_name?: unknown;
  coa?: unknown;
  coa_iso?: unknown;
  coa_name?: unknown;
  refugees?: unknown;
  asylum_seekers?: unknown;
  idps?: unknown;
  oip?: unknown;
  stateless?: unknown;
  returned_refugees?: unknown;
  returned_idps?: unknown;
}

interface UnhcrPage {
  page?: unknown;
  maxPages?: unknown;
  items: UnhcrRow[];
}

/** number → itself; "0"/"123" → number; "-", "" or null → null (not reported); anything else → undefined (broken). */
export function unhcrCount(v: unknown): number | null | undefined {
  if (v == null) return null;
  if (typeof v === 'number') return Number.isFinite(v) && v >= 0 ? v : undefined;
  if (typeof v !== 'string') return undefined;
  const t = v.trim();
  if (t === '' || t === '-') return null;
  return /^\d+(\.\d+)?$/.test(t) ? Number(t) : undefined;
}

export function populationUrl(side: Side, page: number, now: number): string {
  const year = new Date(now).getUTCFullYear();
  return `${BASE}?limit=${PAGE_SIZE}&page=${page}&yearFrom=${year - YEARS_BACK}&yearTo=${year}&${side}_all=true`;
}

async function fetchSide(ctx: FetchContext, side: Side): Promise<FetchedPayload[]> {
  const pages: FetchedPayload[] = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const payload = await ctx.http.get(populationUrl(side, page, ctx.now), { key: `${side}:${page}` });
    pages.push(payload);
    let maxPages = 1;
    try {
      maxPages = Number((payload.json() as { maxPages?: unknown })?.maxPages) || 1;
    } catch {
      break; // parse() reports the malformed page
    }
    if (page >= maxPages) break;
  }
  return pages;
}

const fmt = (n: number) => n.toLocaleString('en-US');

export default defineAdapter({
  manifest,
  version: '1.0.0',

  async fetch(ctx) {
    return [...(await fetchSide(ctx, 'coo')), ...(await fetchSide(ctx, 'coa'))];
  },

  parse(payloads) {
    const out = new ParseCollector();
    const seen = new Set<string>();
    for (const payload of payloads) {
      const side: Side = payload.key.startsWith('coa') ? 'coa' : 'coo';
      const body = jsonPayload<UnhcrPage>(payload, (v) => isObject(v) && Array.isArray(v.items) && 'maxPages' in v, 'UNHCR population response');
      for (const row of body.items) {
        out.item(row, (r) => `${side} ${String(r?.[`${side}_iso`])} ${String(r?.year)}`, (r): RecordDraft[] | string => {
          if (!isObject(r)) return 'row is not an object';
          const code = str(r[`${side}_iso`]);
          if (!code || code === '-') return `missing ${side === 'coo' ? 'origin' : 'asylum'} country code`;
          if (NOT_A_COUNTRY.has(code.toUpperCase()) || NOT_A_COUNTRY.has(String(r[side] ?? '').toUpperCase())) return []; // unknown / stateless / various
          const iso3 = toIso3(code);
          if (!iso3) return []; // territory outside the gazetteer (e.g. French Guiana) – not an error
          const year = typeof r.year === 'number' ? r.year : Number(str(r.year) ?? NaN);
          const occurredAt = yearStart(year);
          if (occurredAt == null) return `unparseable year "${String(r.year)}"`;

          const refugees = unhcrCount(r.refugees);
          const asylumSeekers = unhcrCount(r.asylum_seekers);
          const idps = unhcrCount(r.idps);
          const oip = unhcrCount(r.oip);
          if (refugees === undefined) return 'non-numeric refugees value';
          if (asylumSeekers === undefined) return 'non-numeric asylum_seekers value';
          if (idps === undefined) return 'non-numeric idps value';

          const name = str(r[`${side}_name`], 120) ?? iso3;
          const period = String(year);
          const common = { country: iso3, occurredAt, url: `${BASE}?yearFrom=${year}&yearTo=${year}&${side}=${iso3}&cf_type=ISO` };
          const baseAttrs = { year, asOf: `${year}-12-31`, unhcrCountryCode: str(r[side]), unhcrCountryName: name };
          const drafts: RecordDraft[] = [];
          const push = (d: RecordDraft) => {
            if (seen.has(d.upstreamId)) return;
            seen.add(d.upstreamId);
            drafts.push(d);
          };

          const displaced = (refugees ?? 0) + (asylumSeekers ?? 0);
          if (displaced > 0) {
            const origin = side === 'coo';
            const layerId = origin ? 'unhcr-refugees-origin' : 'unhcr-refugees-asylum';
            const metricName = manifest.layers.find((l) => l.id === layerId)!.metric!.name;
            push({
              ...common,
              upstreamId: `${origin ? 'origin' : 'asylum'}-${iso3}-${year}`,
              layerId,
              title: origin ? `Refugees and asylum-seekers from ${name} (end of ${year})` : `Refugees and asylum-seekers hosted in ${name} (end of ${year})`,
              description: `${fmt(refugees ?? 0)} refugees and ${fmt(asylumSeekers ?? 0)} asylum-seekers ${origin ? 'originating from' : 'hosted in'} ${name} at the end of ${year} (UNHCR).`,
              metric: { name: metricName, value: displaced, unit: 'people', period },
              attributes: {
                ...baseAttrs,
                refugees: refugees ?? 0,
                asylumSeekers: asylumSeekers ?? 0,
                otherInNeedOfInternationalProtection: oip ?? null,
                returnedRefugees: unhcrCount(r.returned_refugees) ?? null,
                stateless: origin ? null : (unhcrCount(r.stateless) ?? null),
              },
            });
          }
          if (side === 'coo' && idps != null && idps > 0) {
            push({
              ...common,
              upstreamId: `idps-${iso3}-${year}`,
              layerId: 'unhcr-idps',
              title: `Internally displaced persons of concern to UNHCR in ${name} (end of ${year})`,
              description: `${fmt(idps)} internally displaced persons protected or assisted by UNHCR in ${name} at the end of ${year}.`,
              metric: { name: 'IDPs of concern to UNHCR', value: idps, unit: 'people', period },
              attributes: { ...baseAttrs, idps, returnedIdps: unhcrCount(r.returned_idps) ?? null },
            });
          }
          return drafts;
        });
      }
    }
    return out.done();
  },
});
