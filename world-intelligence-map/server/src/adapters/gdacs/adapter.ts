import { XMLParser } from 'fast-xml-parser';
import { defineAdapter, isObject, jsonPayload, loadManifest, ParseCollector } from '../base.ts';
import { pointGeometry } from '../../core/geo.ts';
import { num, str } from '../../core/text.ts';
import { DAY, parseTime } from '../../core/time.ts';
import type { FetchedPayload, RecordDraft, Severity } from '../../core/types.ts';
import manifestJson from './manifest.json' with { type: 'json' };

const manifest = loadManifest(manifestJson);
const RSS_URL = 'https://www.gdacs.org/xml/rss.xml';
const SEARCH_URL = 'https://www.gdacs.org/gdacsapi/api/events/geteventlist/SEARCH';
const SEARCH_WINDOW_DAYS = 14;

/** GDACS event type → layer. */
const TYPE_LAYER: Record<string, string> = {
  TC: 'gdacs-cyclones',
  FL: 'gdacs-floods',
  DR: 'gdacs-droughts',
  EQ: 'gdacs-earthquakes',
  VO: 'gdacs-volcanoes',
  WF: 'gdacs-wildfires',
};

/**
 * GDACS alert colour → severity (derived). Green = low expected humanitarian impact (still a notified event),
 * Orange = medium impact / international assistance may be needed, Red = high impact.
 */
const ALERT_SEVERITY: Record<string, Severity> = { green: 1, orange: 3, red: 4 };

/** Common shape of one GDACS event, whichever feed it came from. */
interface GdacsEvent {
  type: string | null;
  eventId: string | null;
  episodeId: string | null;
  title: string | null;
  description: string | null;
  eventName: string | null;
  alertLevel: string | null;
  alertScore: number | null;
  episodeAlertLevel: string | null;
  episodeAlertScore: number | null;
  isCurrent: boolean;
  isTemporary: boolean;
  from: unknown;
  to: unknown;
  modified: unknown;
  published: unknown;
  lon: unknown;
  lat: unknown;
  countries: string[];
  countryText: string | null;
  severityValue: number | null;
  severityUnit: string | null;
  severityText: string | null;
  populationValue: number | null;
  populationUnit: string | null;
  populationText: string | null;
  vulnerability: number | null;
  glide: string | null;
  dataSource: string | null;
  capUrl: string | null;
  feed: 'rss' | 'api';
}

const xml = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  textNodeName: '#text',
  parseTagValue: false,
  parseAttributeValue: false,
  trimValues: true,
  isArray: (name) => name === 'item',
});

/** Text content of an XML node that may be a plain string or an object with attributes. */
function text(node: unknown, maxLen = 500): string | null {
  if (isObject(node)) return str(node['#text'], maxLen);
  return typeof node === 'string' || typeof node === 'number' ? str(node, maxLen) : null;
}
function attr(node: unknown, name: string): string | null {
  return isObject(node) ? str(node[`@_${name}`]) : null;
}
const httpLink = (s: string | null): string | null => (s && /^https?:\/\//i.test(s) ? s : null);
const flag = (v: unknown): boolean => String(v ?? '').trim().toLowerCase() === 'true';
const splitCountries = (s: string | null): string[] => (s ? s.split(',').map((c) => c.trim()).filter(Boolean) : []);

function fromRssItem(item: Record<string, unknown>): GdacsEvent {
  const point = isObject(item['geo:Point']) ? item['geo:Point'] : {};
  let lat: unknown = text(point['geo:lat']);
  let lon: unknown = text(point['geo:long']);
  if (lat == null || lon == null) {
    const pair = text(item['georss:point'])?.split(/\s+/) ?? []; // "lat lon"
    lat = pair[0];
    lon = pair[1];
  }
  const countryText = text(item['gdacs:country']);
  const iso3 = text(item['gdacs:iso3']);
  return {
    type: text(item['gdacs:eventtype'])?.toUpperCase() ?? null,
    eventId: text(item['gdacs:eventid']),
    episodeId: text(item['gdacs:episodeid']),
    title: text(item.title, 400),
    description: text(item.description, 500),
    eventName: text(item['gdacs:eventname']),
    alertLevel: text(item['gdacs:alertlevel']),
    alertScore: num(text(item['gdacs:alertscore'])),
    episodeAlertLevel: text(item['gdacs:episodealertlevel']),
    episodeAlertScore: num(text(item['gdacs:episodealertscore'])),
    isCurrent: flag(text(item['gdacs:iscurrent'])),
    isTemporary: flag(text(item['gdacs:temporary'])),
    from: text(item['gdacs:fromdate']),
    to: text(item['gdacs:todate']),
    modified: text(item['gdacs:datemodified']),
    published: text(item.pubDate) ?? text(item['gdacs:dateadded']),
    lon,
    lat,
    countries: [...(iso3 ? [iso3] : []), ...splitCountries(countryText)],
    countryText,
    severityValue: num(attr(item['gdacs:severity'], 'value')),
    severityUnit: attr(item['gdacs:severity'], 'unit'),
    severityText: text(item['gdacs:severity']),
    populationValue: num(attr(item['gdacs:population'], 'value')),
    populationUnit: attr(item['gdacs:population'], 'unit'),
    populationText: text(item['gdacs:population']),
    vulnerability: num(attr(item['gdacs:vulnerability'], 'value')),
    glide: text(item['gdacs:glide']),
    dataSource: null,
    capUrl: httpLink(text(item['gdacs:cap'])),
    feed: 'rss',
  };
}

function fromApiFeature(feature: Record<string, unknown>): GdacsEvent {
  const p = isObject(feature.properties) ? feature.properties : {};
  const geom = isObject(feature.geometry) ? feature.geometry : {};
  const coords = geom.type === 'Point' && Array.isArray(geom.coordinates) ? geom.coordinates : [];
  const sev = isObject(p.severitydata) ? p.severitydata : {};
  const affected = Array.isArray(p.affectedcountries) ? p.affectedcountries : [];
  const iso3 = str(p.iso3);
  const countryText = str(p.country);
  return {
    type: str(p.eventtype)?.toUpperCase() ?? null,
    eventId: str(p.eventid),
    episodeId: str(p.episodeid),
    title: str(p.name, 400)?.replace(/\s+/g, ' ') ?? null,
    description: str(p.htmldescription, 500),
    eventName: str(p.eventname),
    alertLevel: str(p.alertlevel),
    alertScore: num(p.alertscore),
    episodeAlertLevel: str(p.episodealertlevel),
    episodeAlertScore: num(p.episodealertscore),
    isCurrent: flag(p.iscurrent),
    isTemporary: flag(p.istemporary),
    from: p.fromdate,
    to: p.todate,
    modified: p.datemodified,
    published: null,
    lon: coords[0],
    lat: coords[1],
    countries: [...affected.map((c) => (isObject(c) ? str(c.iso3) : null)).filter((c): c is string => !!c), ...(iso3 ? [iso3] : []), ...splitCountries(countryText)],
    countryText,
    severityValue: num(sev.severity),
    severityUnit: str(sev.severityunit),
    severityText: str(sev.severitytext),
    populationValue: null,
    populationUnit: null,
    populationText: null,
    vulnerability: null,
    glide: str(p.glide),
    dataSource: str(p.source),
    capUrl: null,
    feed: 'api',
  };
}

function toDraft(e: GdacsEvent, seen: Set<string>): RecordDraft | RecordDraft[] | string {
  if (!e.type || !e.eventId) return 'missing event type or id';
  const layerId = TYPE_LAYER[e.type];
  if (!layerId) return []; // event types this application has no layer for
  if (!/^\d+$/.test(e.eventId)) return `invalid event id "${e.eventId.slice(0, 30)}"`;
  const upstreamId = `${e.type}${e.eventId}`;
  if (seen.has(upstreamId)) return []; // already taken from the richer RSS item
  if (!e.title) return 'missing title';
  const geometry = pointGeometry(e.lon, e.lat);
  if (!geometry) return 'missing or invalid coordinates';
  const from = parseTime(e.from);
  if (from == null) return `missing or unparseable start date "${String(e.from ?? '').slice(0, 40)}"`;
  const to = parseTime(e.to);
  const level = e.alertLevel?.toLowerCase() ?? '';
  const severity = ALERT_SEVERITY[level] ?? null;
  if (e.alertLevel && severity == null) return `unknown alert level "${e.alertLevel.slice(0, 30)}"`;
  seen.add(upstreamId);

  return {
    upstreamId,
    layerId,
    geometry,
    country: e.countries.length ? e.countries : null,
    occurredAt: from,
    publishedAt: parseTime(e.published),
    updatedAt: parseTime(e.modified),
    // GDACS still lists the event as current → ongoing; otherwise it ended at the last reported date.
    ongoing: e.isCurrent,
    endedAt: e.isCurrent ? null : (to ?? from),
    severity,
    severityLabel: e.alertLevel,
    confidence: null,
    title: e.title,
    description: e.description,
    attributes: {
      eventType: e.type,
      eventId: Number(e.eventId),
      episodeId: num(e.episodeId),
      eventName: e.eventName,
      alertLevel: e.alertLevel,
      alertScore: e.alertScore,
      episodeAlertLevel: e.episodeAlertLevel,
      episodeAlertScore: e.episodeAlertScore,
      severityValue: e.severityValue,
      severityUnit: e.severityUnit,
      severityText: e.severityText,
      populationExposed: e.populationValue,
      populationExposureBasis: e.populationUnit,
      populationText: e.populationText,
      vulnerabilityScore: e.vulnerability,
      affectedCountries: e.countryText,
      lastReportedDate: to != null ? new Date(to).toISOString() : null,
      isCurrent: e.isCurrent,
      isTemporary: e.isTemporary,
      glide: e.glide,
      dataSource: e.dataSource,
      capUrl: e.capUrl,
      gdacsFeed: e.feed,
    },
    url: `https://www.gdacs.org/report.aspx?eventtype=${e.type}&eventid=${e.eventId}`,
    derived: severity != null ? ['severity'] : [],
  };
}

function parseRss(payload: FetchedPayload, out: ParseCollector, seen: Set<string>): void {
  let doc: unknown;
  try {
    doc = xml.parse(payload.text());
  } catch {
    throw new Error(`malformed GDACS RSS feed: not valid XML (${payload.key})`);
  }
  const channel = isObject(doc) && isObject(doc.rss) ? doc.rss.channel : null;
  if (!isObject(channel)) throw new Error(`malformed GDACS RSS feed: unexpected structure (${payload.key})`);
  out.noteUpstreamTime(parseTime(text(channel.pubDate)));
  const items = Array.isArray(channel.item) ? channel.item : [];
  for (const item of items) {
    out.item(item, (x) => (isObject(x) ? `${text(x.guid) ?? '?'} ${text(x.title, 100) ?? ''}` : String(x)), (x) => (isObject(x) ? toDraft(fromRssItem(x), seen) : 'item is not an element'));
  }
}

function parseApi(payload: FetchedPayload, out: ParseCollector, seen: Set<string>): void {
  const fc = jsonPayload<{ features: unknown[] }>(payload, (v) => isObject(v) && v.type === 'FeatureCollection' && Array.isArray(v.features), 'GDACS event list');
  for (const f of fc.features) {
    out.item(
      f,
      (x) => (isObject(x) && isObject(x.properties) ? `${String(x.properties.eventtype)}${String(x.properties.eventid)} ${String(x.properties.name ?? '')}` : String(x)),
      (x) => (isObject(x) ? toDraft(fromApiFeature(x), seen) : 'feature is not an object'),
    );
  }
}

export default defineAdapter({
  manifest,
  version: '1.0.0',

  async fetch(ctx) {
    const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);
    return [
      // Main feed: everything GDACS currently notifies, with population exposure and alert scores.
      await ctx.http.get(RSS_URL, { key: 'rss' }),
      // Event-list API for the slow, low-volume hazard types, so that cyclones, floods, eruptions and droughts that
      // ended in the past two weeks (and are therefore no longer in the main feed) stay on the timeline.
      await ctx.http.get(
        `${SEARCH_URL}?eventlist=TC;FL;VO;DR&fromDate=${day(ctx.now - SEARCH_WINDOW_DAYS * DAY)}&toDate=${day(ctx.now)}&alertlevel=Green;Orange;Red&pageSize=100&pageNumber=1`,
        { key: 'search' },
      ),
    ];
  },

  parse(payloads) {
    const out = new ParseCollector();
    const seen = new Set<string>();
    // RSS first: its items are richer, so they win when an event is present in both feeds.
    for (const p of payloads) if (p.key === 'rss') parseRss(p, out, seen);
    for (const p of payloads) if (p.key !== 'rss') parseApi(p, out, seen);
    return out.done();
  },
});
