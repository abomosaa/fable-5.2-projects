import { XMLParser } from 'fast-xml-parser';
import { defineAdapter, isObject, loadManifest, ParseCollector } from '../base.ts';
import { pointGeometry } from '../../core/geo.ts';
import { num, plainText, str } from '../../core/text.ts';
import { parseTime } from '../../core/time.ts';
import type { RecordDraft, Severity } from '../../core/types.ts';
import manifestJson from './manifest.json' with { type: 'json' };

const manifest = loadManifest(manifestJson);

/** Feed code → issuing centre. */
const FEEDS: Record<string, string> = {
  PAAQ: 'National Tsunami Warning Center (NTWC)',
  PHEB: 'Pacific Tsunami Warning Center (PTWC)',
};

/**
 * Message category → severity (derived). Order follows the official message definitions:
 * Warning (dangerous coastal flooding and powerful currents expected) > Advisory (strong currents, dangerous waves
 * near the water) > Watch (possible threat, not yet confirmed) > Information Statement (no threat / for information).
 * "Threat" is the PTWC wording for international partners and is treated like an advisory.
 */
function categorySeverity(category: string | null): Severity | null {
  const c = category?.toLowerCase() ?? '';
  if (!c) return null;
  if (c.includes('cancel')) return 0;
  if (c.includes('warning')) return 4;
  if (c.includes('advisory') || c.includes('threat')) return 3;
  if (c.includes('watch')) return 2;
  if (c.includes('information')) return 0;
  return null;
}

const xml = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  textNodeName: '#text',
  parseTagValue: false,
  parseAttributeValue: false,
  trimValues: true,
  isArray: (name) => name === 'entry' || name === 'link',
  // The summary is an XHTML fragment; keep it as raw markup and pick the labelled fields out of it.
  stopNodes: ['feed.entry.summary'],
});

function text(node: unknown, maxLen = 500): string | null {
  if (isObject(node)) return str(node['#text'], maxLen);
  return typeof node === 'string' || typeof node === 'number' ? str(node, maxLen) : null;
}

/** Value following "<strong>Label:</strong>" (or <b>) in the summary markup, as plain text. */
function field(summary: string, label: string): string | null {
  const m = new RegExp(`<(strong|b)>\\s*${label}\\s*:?\\s*</\\1>([^<]*)`, 'i').exec(summary);
  return m ? plainText(m[2], 400).replace(/^[\s*]+/, '') || null : null;
}

function linkHref(links: unknown, match: (l: Record<string, unknown>) => boolean): string | null {
  for (const l of Array.isArray(links) ? links : []) {
    if (!isObject(l) || !match(l)) continue;
    const href = str(l['@_href'], 300);
    if (href && /^https?:\/\//i.test(href)) return href;
  }
  return null;
}

/** "Tsunami Information Statement Number 1" → { kind: "Tsunami Information Statement", number: 1 } */
function bulletinTitle(raw: string | null): { kind: string | null; number: number | null } {
  const t = raw ? plainText(raw, 200) : '';
  const m = /^(.*?)\s+(?:Number|No\.?)\s+(\d+)\s*$/i.exec(t);
  return { kind: (m ? m[1]! : t) || null, number: m ? Number(m[2]) : null };
}

export default defineAdapter({
  manifest,
  version: '1.0.0',

  async fetch(ctx) {
    const payloads = [];
    for (const code of Object.keys(FEEDS)) payloads.push(await ctx.http.get(`https://www.tsunami.gov/events/xml/${code}Atom.xml`, { key: code }));
    return payloads;
  },

  parse(payloads) {
    const out = new ParseCollector();
    // Latest message per event and product; the same message can be listed in both feeds.
    const latest = new Map<string, RecordDraft>();
    const seenEntries = new Set<string>();
    for (const payload of payloads) {
      let doc: unknown;
      try {
        doc = xml.parse(payload.text());
      } catch {
        throw new Error(`malformed tsunami Atom feed: not valid XML (${payload.key})`);
      }
      const feed = isObject(doc) ? doc.feed : null;
      if (!isObject(feed)) throw new Error(`malformed tsunami Atom feed: unexpected structure (${payload.key})`);
      out.noteUpstreamTime(parseTime(text(feed.updated)));
      const feedTitle = bulletinTitle(text(feed.title));
      const author = isObject(feed.author) ? text(feed.author.name, 200) : null;

      // A feed without entries is valid: the centre has no current message.
      for (const raw of Array.isArray(feed.entry) ? feed.entry : []) {
        out.item(raw, (x) => (isObject(x) ? `${payload.key} ${text(x.id) ?? '?'} ${text(x.title, 100) ?? ''}` : String(x)), (entry): RecordDraft | RecordDraft[] | string => {
          if (!isObject(entry)) return 'entry is not an element';
          const entryId = text(entry.id, 200)?.replace(/^urn:uuid:/i, '') ?? null;
          const place = text(entry.title, 300);
          if (!entryId) return 'missing entry id';
          if (!place) return 'missing entry title';
          const geometry = pointGeometry(text(entry['geo:long']), text(entry['geo:lat']));
          if (!geometry) return 'missing or invalid geo:lat / geo:long';

          const summary = text(entry.summary, 20_000) ?? '';
          const updated = parseTime(text(entry.updated));
          const issued = parseTime(field(summary, 'Bulletin Issue Time')?.replace(/^(\d{4})\.(\d{2})\.(\d{2})/, '$1-$2-$3')) ?? updated;
          if (issued == null) return 'missing or unparseable bulletin time';

          const bulletinUrl = linkHref(entry.link, (l) => l['@_rel'] === 'alternate') ?? linkHref(entry.link, (l) => /bulletin/i.test(String(l['@_title'] ?? '')));
          const capUrl = linkHref(entry.link, (l) => /cap\+xml/i.test(String(l['@_type'] ?? '')));
          // …/events/{centre}/{yyyy}/{mm}/{dd}/{event}/{message number}/{product}/…: follow-up messages of one product
          // for one event replace each other; anything else falls back to the entry id.
          const path = /\/events\/([A-Z]{4})\/\d{4}\/\d{2}\/\d{2}\/([A-Za-z0-9]+)\/(\d+)\/([A-Z0-9]+)\//.exec(bulletinUrl ?? capUrl ?? '');
          const centreCode = path?.[1] ?? payload.key;
          const upstreamId = path ? `${path[1]}/${path[2]}/${path[4]}` : entryId;
          if (seenEntries.has(entryId)) return []; // same message in both feeds
          seenEntries.add(entryId);
          const previous = latest.get(upstreamId);
          if (previous && (previous.occurredAt ?? 0) >= issued) return []; // superseded by a later message already seen

          const category = field(summary, 'Category');
          const severity = categorySeverity(category);
          const magnitudeText = field(summary, 'Preliminary Magnitude');
          const mag = /^(\d+(?:\.\d+)?)\s*\(?\s*([A-Za-z]+)?/.exec(magnitudeText ?? '');
          const note = field(summary, 'Note');
          const region = field(summary, 'Affected Region');
          const kind = feedTitle.kind ?? (category ? `Tsunami ${category}` : 'Tsunami message');

          latest.set(upstreamId, {
            upstreamId,
            layerId: 'tsunami-bulletins',
            subcategory: category?.toLowerCase() ?? null,
            geometry,
            occurredAt: issued,
            publishedAt: issued,
            updatedAt: updated,
            severity,
            severityLabel: category,
            confidence: null,
            title: `${kind}: ${place}`,
            description: [
              category ? `Category: ${category}.` : null,
              magnitudeText ? `Preliminary magnitude ${magnitudeText}.` : null,
              region ? `Affected region: ${region}.` : null,
              note ? `Note: ${note}` : null,
            ]
              .filter(Boolean)
              .join(' ')
              .slice(0, 500) || null,
            attributes: {
              category,
              bulletinType: feedTitle.kind,
              bulletinNumber: path ? Number(path[3]) : feedTitle.number,
              warningCentre: author ?? FEEDS[centreCode] ?? null,
              centreCode,
              eventCode: path?.[2] ?? null,
              productCode: path?.[4] ?? null,
              preliminaryMagnitude: mag ? num(mag[1]) : null,
              magnitudeType: mag?.[2] ?? null,
              affectedRegion: region,
              note,
              bulletinUrl,
              capUrl,
              entryId,
            },
            url: bulletinUrl ?? capUrl ?? 'https://www.tsunami.gov/',
            derived: severity != null ? ['severity'] : [],
          });
          return [];
        });
      }
    }
    out.records.push(...latest.values());
    return out.done();
  },
});
