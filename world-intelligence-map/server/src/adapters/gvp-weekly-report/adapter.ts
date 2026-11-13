import { XMLParser } from 'fast-xml-parser';
import { defineAdapter, isObject, loadManifest, ParseCollector } from '../base.ts';
import { toIso3 } from '../../core/countries.ts';
import { pointGeometry } from '../../core/geo.ts';
import { plainText, str } from '../../core/text.ts';
import { DAY, parseTime } from '../../core/time.ts';
import type { FetchedPayload, RecordDraft } from '../../core/types.ts';
import manifestJson from './manifest.json' with { type: 'json' };

const manifest = loadManifest(manifestJson);
const FEED_URL = 'https://volcano.si.edu/news/WeeklyVolcanoRSS.xml';
const EXCERPT_MAX = 500;

const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];

const xml = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  textNodeName: '#text',
  parseTagValue: false,
  parseAttributeValue: false,
  trimValues: true,
  isArray: (name) => name === 'item',
});

function text(node: unknown, maxLen = 500): string | null {
  if (isObject(node)) return str(node['#text'], maxLen);
  return typeof node === 'string' || typeof node === 'number' ? str(node, maxLen) : null;
}

/** The feed is served as ISO-8859-1; honour the encoding named in the XML declaration. */
function decode(payload: FetchedPayload): string {
  const head = payload.body.subarray(0, 200).toString('latin1');
  const encoding = /<\?xml[^>]*encoding=["']([^"']+)["']/i.exec(head)?.[1]?.toLowerCase() ?? 'utf-8';
  return /^(iso-8859-1|latin-?1|windows-1252|us-ascii)$/.test(encoding) ? payload.body.toString('latin1') : payload.body.toString('utf8');
}

interface ReportTitle {
  volcano: string;
  country: string | null;
  weekStart: number | null;
  /** Exclusive end: 00:00 UTC of the day after the last report day. */
  weekEnd: number | null;
  period: string | null;
  status: string | null;
}

/** "Krakatau (Indonesia) - Report for 8 October-14 October 2026 - New Eruptive Activity" */
function parseTitle(title: string): ReportTitle {
  const m = /^(.*?)\s+-\s+Report for\s+(\d{1,2})\s+([A-Za-z]+)(?:\s+(\d{4}))?\s*-\s*(\d{1,2})\s+([A-Za-z]+)\s+(\d{4})(?:\s+-\s+(.*))?$/.exec(title);
  const head = (m ? m[1]! : title.split(/\s+-\s+/)[0]!).trim();
  const nc = /^(.*?)\s*\(([^()]*)\)\s*$/.exec(head);
  const base = { volcano: (nc ? nc[1]! : head).trim(), country: nc ? nc[2]!.trim() || null : null };
  if (!m) return { ...base, weekStart: null, weekEnd: null, period: null, status: null };
  const startMonth = MONTHS.indexOf(m[3]!.toLowerCase());
  const endMonth = MONTHS.indexOf(m[6]!.toLowerCase());
  const endYear = Number(m[7]);
  const startYear = m[4] ? Number(m[4]) : startMonth > endMonth ? endYear - 1 : endYear; // "30 December-5 January 2027"
  const start = startMonth >= 0 ? Date.UTC(startYear, startMonth, Number(m[2])) : NaN;
  const end = endMonth >= 0 ? Date.UTC(endYear, endMonth, Number(m[5])) + DAY : NaN;
  const ok = Number.isFinite(start) && Number.isFinite(end) && end > start && end - start <= 15 * DAY && Number(m[2]) <= 31 && Number(m[5]) <= 31;
  return {
    ...base,
    weekStart: ok ? start : null,
    weekEnd: ok ? end : null,
    period: ok ? `${new Date(start).toISOString().slice(0, 10)}/${new Date(end - DAY).toISOString().slice(0, 10)}` : null,
    status: m[8]?.trim() || null,
  };
}

/** Short lawful excerpt: whole sentences up to the limit, otherwise cut at a word boundary. */
function excerpt(body: string): string | null {
  if (!body) return null;
  if (body.length <= EXCERPT_MAX) return body;
  const window = body.slice(0, EXCERPT_MAX);
  const sentenceEnd = Math.max(window.lastIndexOf('. '), window.lastIndexOf('.) '));
  if (sentenceEnd >= 200) return window.slice(0, window.indexOf(' ', sentenceEnd)).trimEnd();
  return `${window.slice(0, window.lastIndexOf(' ')).trimEnd()} …`.slice(0, EXCERPT_MAX);
}

export default defineAdapter({
  manifest,
  version: '1.0.0',

  async fetch(ctx) {
    return [await ctx.http.get(FEED_URL, { key: 'weekly-report' })];
  },

  parse(payloads) {
    const out = new ParseCollector();
    const seen = new Set<string>();
    for (const payload of payloads) {
      let doc: unknown;
      try {
        doc = xml.parse(decode(payload));
      } catch {
        throw new Error(`malformed GVP weekly report feed: not valid XML (${payload.key})`);
      }
      const channel = isObject(doc) && isObject(doc.rss) ? doc.rss.channel : null;
      if (!isObject(channel)) throw new Error(`malformed GVP weekly report feed: unexpected structure (${payload.key})`);
      out.noteUpstreamTime(parseTime(text(channel.pubDate)));

      for (const raw of Array.isArray(channel.item) ? channel.item : []) {
        out.item(raw, (x) => (isObject(x) ? (text(x.title, 150) ?? '?') : String(x)), (item): RecordDraft | RecordDraft[] | string => {
          if (!isObject(item)) return 'item is not an element';
          const title = text(item.title, 300);
          if (!title) return 'missing title';
          const info = parseTitle(plainText(title, 300));
          const [lat, lon] = (text(item['georss:point']) ?? '').split(/[\s,]+/); // georss order: "lat lon"
          const geometry = pointGeometry(lon, lat);
          if (!geometry) return 'missing or invalid georss:point';
          const publishedAt = parseTime(text(item.pubDate));
          // The report covers a week named in the title; without it fall back to the publication time.
          const occurredAt = info.weekStart ?? publishedAt;
          if (occurredAt == null) return 'no report period in the title and no publication date';

          const guid = text(item.guid, 300);
          const volcanoNumber = /[#&?]vn[_=](\d{4,7})\b/.exec(guid ?? '')?.[1] ?? null;
          const key = volcanoNumber ? `vn_${volcanoNumber}` : info.volcano.toLowerCase().replace(/[^a-z0-9]+/g, '-');
          const upstreamId = `${key}:${new Date(occurredAt).toISOString().slice(0, 10)}`;
          if (seen.has(upstreamId)) return [];
          seen.add(upstreamId);

          // Description is escaped HTML: report paragraphs followed by a "Source(s): …" paragraph.
          const paragraphs = (text(item.description, 20_000) ?? '')
            .split(/<\/p\s*>/i)
            .map((p) => plainText(p, 6000))
            .filter(Boolean);
          const sourceLine = paragraphs.find((p) => /^Sources?:/i.test(p)) ?? null;
          const body = paragraphs.filter((p) => p !== sourceLine).join(' ');
          const link = [guid, text(item.link, 300)].find((u) => u && /^https?:\/\//i.test(u)) ?? 'https://volcano.si.edu/reports_weekly.cfm';

          return {
            upstreamId,
            layerId: 'volcanic-activity',
            subcategory: info.status,
            geometry,
            country: info.country && toIso3(info.country) ? info.country : null,
            occurredAt,
            publishedAt,
            endedAt: info.weekEnd,
            severity: null,
            confidence: null,
            title,
            description: excerpt(body),
            attributes: {
              volcanoName: info.volcano,
              volcanoNumber: volcanoNumber ? Number(volcanoNumber) : null,
              country: info.country,
              activityStatus: info.status,
              reportPeriod: info.period,
              reportSources: sourceLine ? sourceLine.replace(/^Sources?:\s*/i, '').replace(/,(?=\S)/g, ', ').slice(0, 400) : null,
              volcanoUrl: volcanoNumber ? `https://volcano.si.edu/volcano.cfm?vn=${volcanoNumber}` : null,
            },
            url: link,
            derived: [],
          };
        });
      }
    }
    return out.done();
  },
});
