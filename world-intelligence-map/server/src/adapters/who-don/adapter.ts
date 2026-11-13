/**
 * WHO Disease Outbreak News (OData service of who.int).
 *
 * The feed has no coordinates or country codes, so the location is inferred from the title, which follows
 * the pattern "Disease - Country" (also "Disease – Country", "Disease- Country", "Disease, Country A & Country B").
 * Only the location part of the title is searched: disease names such as "Sudan virus disease" or
 * "Crimean-Congo haemorrhagic fever" contain country names themselves.
 */
import { defineAdapter, isObject, jsonPayload, loadManifest, ParseCollector } from '../base.ts';
import { findCountryInText, toIso3 } from '../../core/countries.ts';
import { plainText, str } from '../../core/text.ts';
import { parseTime } from '../../core/time.ts';
import type { RecordDraft } from '../../core/types.ts';
import manifestJson from './manifest.json' with { type: 'json' };

const manifest = loadManifest(manifestJson);

const FIELDS = ['Id', 'DonId', 'Title', 'OverrideTitle', 'UseOverrideTitle', 'PublicationDate', 'PublicationDateAndTime', 'LastModified', 'UrlName', 'ItemDefaultUrl', 'Summary'];
export const FEED_URL = `https://www.who.int/api/news/diseaseoutbreaknews?$orderby=PublicationDateAndTime%20desc&$top=60&$select=${FIELDS.join(',')}`;
const ITEM_BASE = 'https://www.who.int/emergencies/disease-outbreak-news/item/';
export const EXCERPT_MAX = 400;

/** Location wording that denotes a region or the whole world rather than specific countries. */
const NON_COUNTRY_SCOPE = /\b(global(ly)?|worldwide|international|multi[- ]?(country|countries|regions?|regional|locations?)|regions?|regional|continent)\b/i;
/** A dash with whitespace on at least one side separates disease and location; hyphens inside words do not. */
const DASH_SEPARATOR = /\s+[-–—]+\s*|[-–—]+\s+/;
const LIST_SEPARATOR = /(\s*[,;&]\s*|\s+and\s+)/i;

export type LocationScope = 'country' | 'multi-country' | 'global-or-regional' | 'unresolved';

export interface TitleLocation {
  /** Part of the title before the location (the disease / event). */
  topic: string;
  /** Raw location wording from the title, if any. */
  locationText: string | null;
  scope: LocationScope;
  countries: string[];
  /** Number of names in the location wording that could not be resolved to a country. */
  unresolvedParts: number;
}

/** Resolve "A, B and C" into ISO3 codes; names that themselves contain "and" (Bosnia and Herzegovina) are tried first. */
function resolveCountryList(text: string): { countries: string[]; unresolved: number } {
  const tokens = text.split(LIST_SEPARATOR); // even indexes: names, odd indexes: separators
  const countries: string[] = [];
  let unresolved = 0;
  let i = 0;
  while (i < tokens.length) {
    let matched = false;
    for (let j = Math.min(tokens.length - 1, i + 4); j >= i; j -= 2) {
      const name = tokens.slice(i, j + 1).join('').trim().replace(/^the\s+/i, '');
      if (!name) continue;
      const iso3 = toIso3(name) ?? (j === i ? findCountryInText(name) : null);
      if (iso3) {
        if (!countries.includes(iso3)) countries.push(iso3);
        i = j + 2;
        matched = true;
        break;
      }
    }
    if (!matched) {
      if (tokens[i]!.trim()) unresolved++;
      i += 2;
    }
  }
  return { countries, unresolved };
}

/** Infer the location of a notice from its title. Pure text heuristics – callers must mark the result as derived. */
export function locationFromTitle(title: string): TitleLocation {
  const segments = title.split(DASH_SEPARATOR).map((s) => s.trim()).filter(Boolean);
  let candidates: string[];
  let topic: string;
  if (segments.length > 1) {
    topic = segments[0]!;
    candidates = segments.slice(1).reverse(); // the location is normally the last segment
  } else {
    const comma = title.indexOf(',');
    topic = (comma >= 0 ? title.slice(0, comma) : title).trim();
    candidates = comma >= 0 && title.slice(comma + 1).trim() ? [title.slice(comma + 1).trim()] : [];
  }
  for (const text of candidates) {
    if (NON_COUNTRY_SCOPE.test(text)) return { topic, locationText: text, scope: 'global-or-regional', countries: [], unresolvedParts: 0 };
    const { countries, unresolved } = resolveCountryList(text);
    if (countries.length) return { topic, locationText: text, scope: countries.length > 1 ? 'multi-country' : 'country', countries, unresolvedParts: unresolved };
  }
  return { topic, locationText: candidates[0] ?? null, scope: 'unresolved', countries: [], unresolvedParts: candidates.length ? 1 : 0 };
}

interface DonItem {
  Id?: unknown;
  DonId?: unknown;
  Title?: unknown;
  OverrideTitle?: unknown;
  UseOverrideTitle?: unknown;
  PublicationDate?: unknown;
  PublicationDateAndTime?: unknown;
  LastModified?: unknown;
  UrlName?: unknown;
  ItemDefaultUrl?: unknown;
  Summary?: unknown;
}

const text = (v: unknown, max: number): string => (typeof v === 'string' ? plainText(v, max) : '');
const SLUG = /^[A-Za-z0-9][A-Za-z0-9._~-]*$/;

function itemUrl(item: DonItem): string | null {
  const fromDefault = typeof item.ItemDefaultUrl === 'string' ? item.ItemDefaultUrl.replace(/^\/+/, '') : '';
  const slug = SLUG.test(fromDefault) ? fromDefault : typeof item.UrlName === 'string' && SLUG.test(item.UrlName) ? item.UrlName : null;
  return slug ? ITEM_BASE + slug : null;
}

export default defineAdapter({
  manifest,
  version: '1.0.0',

  async fetch(ctx) {
    return [await ctx.http.get(FEED_URL, { key: 'diseaseoutbreaknews' })];
  },

  parse(payloads) {
    const out = new ParseCollector();
    const seen = new Set<string>();
    for (const payload of payloads) {
      const body = jsonPayload<{ value: DonItem[] }>(payload, (v) => isObject(v) && Array.isArray(v.value), 'WHO Disease Outbreak News response');
      for (const raw of body.value) {
        out.item(raw, (x) => `${String(x?.DonId ?? x?.Id)} ${String(x?.Title ?? '').slice(0, 80)}`, (item): RecordDraft | RecordDraft[] | string => {
          if (!isObject(item)) return 'item is not an object';
          const id = str(item.DonId, 80) ?? str(item.Id, 80);
          if (!id) return 'missing DonId and Id';
          const override = item.UseOverrideTitle === true ? text(item.OverrideTitle, 240) : '';
          const title = override || text(item.Title, 240);
          if (!title) return 'missing title';
          const publishedAt = parseTime(item.PublicationDateAndTime) ?? parseTime(item.PublicationDate);
          if (publishedAt == null) return `unparseable publication time "${String(item.PublicationDateAndTime).slice(0, 30)}"`;
          if (seen.has(id)) return [];
          seen.add(id);

          let loc = locationFromTitle(title);
          // The editorial override title sometimes drops the separator; the original title may still carry it.
          if (loc.scope === 'unresolved' && override) {
            const alt = locationFromTitle(text(item.Title, 240));
            if (alt.scope !== 'unresolved') loc = alt;
          }
          const located = loc.countries.length > 0;
          const lastModified = parseTime(item.LastModified);
          const excerpt = text(item.Summary, EXCERPT_MAX);

          return {
            upstreamId: id,
            layerId: 'disease-outbreaks',
            subcategory: loc.topic.slice(0, 80) || null,
            ...(located ? { country: loc.countries } : { geometryKind: 'global' as const }),
            occurredAt: publishedAt,
            publishedAt,
            updatedAt: lastModified != null && lastModified > publishedAt ? lastModified : null,
            severity: null,
            confidence: null,
            title,
            description: excerpt || null,
            attributes: {
              donId: str(item.DonId, 80),
              topic: loc.topic || null,
              locationText: loc.locationText,
              locationScope: loc.scope,
              countriesNamed: located ? loc.countries.join(', ') : null,
              unresolvedLocationParts: located && loc.unresolvedParts > 0 ? loc.unresolvedParts : null,
            },
            url: itemUrl(item),
            derived: located ? ['geometry', 'country', 'subcategory'] : ['subcategory'],
          };
        });
      }
    }
    return out.done();
  },
});
