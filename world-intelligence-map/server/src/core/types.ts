/**
 * Core contracts shared by every adapter, the ingestion pipeline, the store and the API.
 *
 * Three shapes matter:
 *   SourceManifest – machine-readable description of an upstream source (manifest.json per adapter)
 *   RecordDraft    – what an adapter's pure `parse` emits
 *   IntelRecord    – the validated, normalised common geospatial intelligence record
 */
import { z } from 'zod';
import type { Geometry } from 'geojson';

// ───────────────────────────── domains ─────────────────────────────

export const DOMAINS = [
  { id: 'hazards', name: 'Natural hazards', description: 'Earthquakes, volcanoes, fires, floods, storms, droughts and tsunamis.' },
  { id: 'weather', name: 'Weather & environment', description: 'Severe weather alerts, current conditions, air quality and aviation weather.' },
  { id: 'humanitarian', name: 'Humanitarian conditions', description: 'Active disasters, displacement, food security and aid reporting.' },
  { id: 'geopolitics', name: 'Geopolitical events', description: 'Machine-coded and curated public reporting of conflict, protest and diplomacy.' },
  { id: 'transport', name: 'Transportation', description: 'Public aviation and maritime positions, airports and ports.' },
  { id: 'cyber', name: 'Connectivity & cyber', description: 'Censorship measurements, internet outages, routing conditions and security advisories.' },
  { id: 'infrastructure', name: 'Energy & infrastructure', description: 'Power plants, cables, data centres and other critical public infrastructure datasets.' },
  { id: 'society', name: 'Population, economy & health', description: 'Population, economic, health and development indicators and outbreak reporting.' },
  { id: 'space', name: 'Space', description: 'Satellites, launches, space weather and near-Earth events.' },
  { id: 'reference', name: 'Geographic context', description: 'Settlements, tectonic boundaries, heritage sites and other reference layers.' },
] as const;

export type DomainId = (typeof DOMAINS)[number]['id'];
const domainIds = DOMAINS.map((d) => d.id) as [DomainId, ...DomainId[]];

// ───────────────────────────── manifest ─────────────────────────────

/** Named colour slots – the client maps them to concrete colours per theme / palette. */
export const COLOR_SLOTS = ['red', 'orange', 'yellow', 'green', 'teal', 'blue', 'purple', 'pink', 'brown', 'gray'] as const;
export const SHAPES = ['circle', 'triangle', 'square', 'diamond', 'star', 'cross', 'hexagon', 'pentagon', 'plane', 'ship', 'satellite'] as const;

/**
 * How a layer behaves on the time axis.
 *  event     – instantaneous occurrence (earthquake). Visible when occurredAt is inside the time window.
 *  interval  – active from occurredAt until expiresAt/endedAt; `ongoing` records extend to the last fetch that still listed them.
 *  snapshot  – current-state observation (aircraft position). In live mode only observations younger than liveMaxAgeSec are shown.
 *  reference – timeless reference data (airports). Always visible.
 *  indicator – periodic country statistic. The latest value at or before the end of the time window is shown.
 */
export const TIME_MODELS = ['event', 'interval', 'snapshot', 'reference', 'indicator'] as const;
export type TimeModel = (typeof TIME_MODELS)[number];

export const GEOMETRY_KINDS = ['point', 'line', 'polygon', 'track', 'bbox', 'country', 'global'] as const;
export type GeometryKind = (typeof GEOMETRY_KINDS)[number];

export const LayerDefSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]{1,48}$/),
  name: z.string().min(2).max(60),
  description: z.string().min(5).max(400),
  domain: z.enum(domainIds),
  category: z.string().min(2).max(40),
  /** Dominant geometry kind of this layer's records. */
  geometry: z.enum(GEOMETRY_KINDS),
  timeModel: z.enum(TIME_MODELS),
  render: z.object({
    /** point: clustered symbols · heatmap: density below `heatmapBelowZoom`, points above · line/polygon · choropleth (country fill) · track: head point + path */
    type: z.enum(['point', 'heatmap', 'line', 'polygon', 'choropleth', 'track']),
    color: z.enum(COLOR_SLOTS),
    shape: z.enum(SHAPES).default('circle'),
    heatmapBelowZoom: z.number().min(0).max(22).optional(),
    /** Hide below this zoom (dense reference layers). */
    minZoom: z.number().min(0).max(22).optional(),
  }),
  /** For indicator / choropleth layers. */
  metric: z
    .object({
      name: z.string(),
      unit: z.string(),
      scale: z.enum(['sequential', 'diverging']).default('sequential'),
      higherIs: z.enum(['worse', 'better', 'neutral']).default('neutral'),
      /** 'log' for heavy-tailed values such as population. */
      transform: z.enum(['linear', 'log']).default('linear'),
    })
    .optional(),
  /** Record considered "fresh" while its upstream event/update time is younger than this. */
  freshForSec: z.number().positive().optional(),
  /** snapshot layers: maximum observation age shown in live mode. */
  liveMaxAgeSec: z.number().positive().optional(),
  /** Explicit retention rule. Records whose end time is older than this are purged. null = keep while upstream lists it (reference data). */
  retentionDays: z.number().positive().nullable(),
  defaultOn: z.boolean().default(false),
  /** Records in the same class from different sources may be linked as one possible incident. */
  correlationClass: z.enum(['earthquake', 'tropical_cyclone', 'wildfire', 'volcano', 'flood', 'drought', 'outage']).optional(),
});
export type LayerDef = z.infer<typeof LayerDefSchema>;

export const SourceManifestSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]{1,40}$/),
  provider: z.string().min(2),
  dataset: z.string().min(2),
  description: z.string().min(10),
  homepageUrl: z.string().url(),
  documentationUrl: z.string().url(),
  /** Concrete endpoints / downloads used (templates allowed, never containing secrets). */
  sourceUrls: z.array(z.string()).min(1),
  /** Upstream allowlist. The HTTP client refuses any other host for this source. */
  allowedHosts: z.array(z.string().regex(/^[a-z0-9.-]+$/)).min(1),
  coverage: z.object({ geographic: z.string(), temporal: z.string() }),
  updateCadence: z.object({
    /** Human description of how often upstream publishes. */
    upstream: z.string(),
    /** How often we poll. */
    pollIntervalSec: z.number().min(30),
    /** After this long without a successful fetch the source (and its records) are flagged stale. */
    staleAfterSec: z.number().min(60),
  }),
  auth: z.object({
    type: z.enum(['none', 'api_key', 'oauth', 'app_identifier']),
    envVars: z
      .array(z.object({ name: z.string().regex(/^[A-Z][A-Z0-9_]+$/), required: z.boolean(), description: z.string() }))
      .default([]),
    /** Where and how to obtain credentials; shown in the UI when the source is misconfigured. */
    setup: z.string().optional(),
    obtainUrl: z.string().url().optional(),
  }),
  attribution: z.string().min(2),
  license: z.object({
    name: z.string(),
    url: z.string().url(),
    redistribution: z.enum(['allowed', 'allowed-with-attribution', 'restricted', 'unknown']),
    nonCommercialOnly: z.boolean(),
    notes: z.string().optional(),
  }),
  limitations: z.array(z.string()).min(1),
  confidenceNotes: z.string().min(5),
  retention: z.object({ note: z.string() }),
  /** full: each successful fetch is the complete current set (records no longer listed are ended). incremental: fetches add/update only. */
  snapshot: z.enum(['full', 'incremental']),
  http: z
    .object({
      timeoutMs: z.number().positive().optional(),
      maxRetries: z.number().min(0).max(5).optional(),
      /** Minimum spacing between requests to one host. */
      minIntervalMs: z.number().min(0).optional(),
      /** Do not re-download a URL more often than this (provider fair-use policies). */
      cacheTtlSec: z.number().min(0).optional(),
      userAgentRequired: z.boolean().optional(),
    })
    .default({}),
  enabledByDefault: z.boolean().default(true),
  layers: z.array(LayerDefSchema).min(1),
});
export type SourceManifest = z.infer<typeof SourceManifestSchema>;

// ───────────────────────────── records ─────────────────────────────

export const SEVERITY_LABELS = ['info', 'minor', 'moderate', 'severe', 'extreme'] as const;
/** 0 info · 1 minor · 2 moderate · 3 severe · 4 extreme. null = not applicable / unknown. */
export type Severity = 0 | 1 | 2 | 3 | 4;

export type AttrValue = string | number | boolean | null;

/** What an adapter's `parse` emits. Times are epoch milliseconds (use core/time helpers). */
export interface RecordDraft {
  /** Stable upstream identifier (or a deterministic composite when upstream has none). */
  upstreamId: string;
  layerId: string;
  /** Defaults to the layer's category. */
  category?: string;
  subcategory?: string | null;
  /** GeoJSON geometry in WGS84 lon/lat. null for country / global records. */
  geometry?: Geometry | null;
  /** Inferred from the geometry when omitted. Use 'track' for a LineString of observed positions, 'country' for country-level facts, 'global' for non-geographic bulletins. */
  geometryKind?: GeometryKind;
  /** ISO 3166-1 alpha-2 / alpha-3 code(s) or common English name; normalised to alpha-3. */
  country?: string | string[] | null;
  occurredAt?: number | null;
  publishedAt?: number | null;
  updatedAt?: number | null;
  expiresAt?: number | null;
  /** interval layers: upstream explicitly reports the event as closed at this time. */
  endedAt?: number | null;
  /** interval layers: upstream still lists the event as active as of this fetch. */
  ongoing?: boolean;
  severity?: Severity | null;
  /** Upstream wording of the severity (e.g. "M 6.1", "Red", "Extreme"). */
  severityLabel?: string | null;
  /** 0..1 or null when the source gives no basis for one. */
  confidence?: number | null;
  /** One sentence: where the confidence value comes from. */
  confidenceBasis?: string | null;
  uncertainty?: Record<string, number | string> | null;
  title: string;
  description?: string | null;
  /** Flat upstream facts needed to interpret the record. */
  attributes?: Record<string, AttrValue | undefined>;
  /** indicator / measurement value. */
  metric?: { name: string; value: number; unit: string; period?: string } | null;
  /** Deep link to the original item at the source. */
  url?: string | null;
  /** Names of fields that this application inferred rather than copied from upstream (e.g. 'severity', 'country', 'geometry', 'confidence'). */
  derived?: string[];
}

export interface RejectedItem {
  reason: string;
  /** Short identifying sample of the offending upstream item (never the whole payload). */
  sample?: string;
}

export interface ParseOutput {
  records: RecordDraft[];
  rejected: RejectedItem[];
  /** Newest upstream-declared generation/update time of the payload, when the source provides one. */
  upstreamTime?: number | null;
}

export const FRESHNESS = ['fresh', 'recent', 'aging', 'stale', 'expired', 'reference'] as const;
export type Freshness = (typeof FRESHNESS)[number];

export interface Provenance {
  sourceId: string;
  provider: string;
  dataset: string;
  adapterVersion: string;
  /** Request URLs used for the fetch that produced this record (secrets redacted). */
  fetchUrls: string[];
  fetchedAt: number;
  firstSeenAt: number;
  /** Number of times the upstream content of this record changed since first seen. */
  revision: number;
  contentHash: string;
  /** Fields inferred by this application rather than stated by upstream. */
  derived: string[];
  /** true when the record came from bundled fixture data rather than a live upstream request. */
  fixture: boolean;
  normalisation: string[];
}

/** The common geospatial intelligence record. */
export interface IntelRecord {
  id: string;
  upstreamId: string;
  sourceId: string;
  layerId: string;
  domain: DomainId;
  category: string;
  subcategory: string | null;
  geometryKind: GeometryKind;
  geometry: Geometry | null;
  /** [west, south, east, north] */
  bbox: [number, number, number, number] | null;
  /** Representative point (lon, lat) used for clustering. */
  point: [number, number] | null;
  /** ISO 3166-1 alpha-3 codes. */
  countries: string[];
  occurredAt: number | null;
  publishedAt: number | null;
  updatedAt: number | null;
  fetchedAt: number;
  expiresAt: number | null;
  /** Derived time interval used by timeline queries. */
  tStart: number | null;
  tEnd: number | null;
  ongoing: boolean;
  severity: Severity | null;
  severityLabel: string | null;
  confidence: number | null;
  confidenceBasis: string | null;
  uncertainty: Record<string, number | string> | null;
  title: string;
  description: string | null;
  attributes: Record<string, AttrValue>;
  metric: { name: string; value: number; unit: string; period?: string } | null;
  url: string | null;
  attribution: string;
  licenseUrl: string;
  provenance: Provenance;
}

// ───────────────────────────── adapters ─────────────────────────────

export interface FetchedPayload {
  /** Adapter-chosen label for this request (e.g. indicator code). */
  key: string;
  /** Request URL with secrets redacted. */
  url: string;
  status: number;
  body: Buffer;
  contentType: string | null;
  /** When the body was obtained from upstream (original time for cache hits). */
  fetchedAt: number;
  etag: string | null;
  lastModified: string | null;
  /** Upstream answered 304; body is the cached copy and is confirmed current. */
  notModified: boolean;
  /** Served from the local cache without contacting upstream (within TTL). */
  fromCache: boolean;
  /** Upstream failed; this is an older cached copy. */
  stale: boolean;
  /** Set together with `stale`: the failure that caused the fallback to the cached copy. */
  error?: unknown;
  text(): string;
  json<T = unknown>(): T;
}

export interface HttpGetOptions {
  /** Label carried onto the payload. Defaults to the URL. */
  key?: string;
  headers?: Record<string, string>;
  method?: 'GET' | 'POST';
  body?: string;
  /** Override manifest.http.cacheTtlSec for this request. */
  cacheTtlSec?: number;
  /** Never write the response body to the persistent cache (token responses). Implies no conditional requests and no stale fallback. */
  noStore?: boolean;
  /** Strings that must never appear in logs / provenance (API keys embedded in URLs). */
  redact?: string[];
  timeoutMs?: number;
}

export interface SourceHttp {
  get(url: string, opts?: HttpGetOptions): Promise<FetchedPayload>;
}

export interface FetchContext {
  http: SourceHttp;
  /** Server-side environment (credentials). Never sent to the browser. */
  env: Record<string, string | undefined>;
  /** Current time from the application clock (fixture clock in demo mode). */
  now: number;
  /** Small persistent key/value store scoped to this source (cursors, last file names). */
  cursor: { get(key: string): string | null; set(key: string, value: string): void };
  signal: AbortSignal;
  /**
   * Report that one of several independent requests failed while others succeeded. The run is then recorded as
   * partial (data from the successful requests is ingested, the source is shown as delayed and retried sooner).
   */
  partialFailure?(key: string, error: unknown): void;
}

export interface ParseContext {
  now: number;
  env: Record<string, string | undefined>;
}

export interface SourceAdapter {
  manifest: SourceManifest;
  /** Bumped when parse semantics change. */
  version: string;
  /** Perform upstream requests. Must only use ctx.http. */
  fetch(ctx: FetchContext): Promise<FetchedPayload[]>;
  /** Pure: payloads → drafts. No I/O. Malformed items go to `rejected`, never throw for a single bad item. */
  parse(payloads: FetchedPayload[], ctx: ParseContext): ParseOutput;
}

export const SOURCE_STATUSES = ['healthy', 'delayed', 'rate_limited', 'stale', 'unavailable', 'misconfigured', 'pending', 'disabled'] as const;
export type SourceStatus = (typeof SOURCE_STATUSES)[number];
