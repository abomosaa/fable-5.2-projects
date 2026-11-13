import type { FeatureCollection, Geometry } from 'geojson';

export type Freshness = 'fresh' | 'recent' | 'aging' | 'stale' | 'expired' | 'reference';
export const FRESHNESS: Freshness[] = ['fresh', 'recent', 'aging', 'stale', 'expired', 'reference'];
export const FRESH_BY_CODE: Freshness[] = ['fresh', 'recent', 'aging', 'stale', 'expired', 'reference'];
export const FRESH_LABEL: Record<Freshness, string> = {
  fresh: 'Fresh', recent: 'Recent', aging: 'Aging', stale: 'Stale source', expired: 'Expired / ended', reference: 'Reference data',
};
export const FRESH_HELP: Record<Freshness, string> = {
  fresh: 'Upstream event/update time is within the layer’s freshness window and the source is being fetched normally.',
  recent: 'Upstream event/update time is up to four times older than the layer’s freshness window.',
  aging: 'Upstream event/update time is older than four freshness windows.',
  stale: 'The source has not been fetched successfully within its staleness budget; this record could not be re-confirmed.',
  expired: 'Past its upstream expiry, closed upstream, or no longer listed in the source’s current snapshot.',
  reference: 'Timeless reference dataset; see the source’s version and update cadence.',
};

export type SlotColor = 'red' | 'orange' | 'yellow' | 'green' | 'teal' | 'blue' | 'purple' | 'pink' | 'brown' | 'gray';
export type Shape = 'circle' | 'triangle' | 'square' | 'diamond' | 'star' | 'cross' | 'hexagon' | 'pentagon' | 'plane' | 'ship' | 'satellite';

export interface LayerInfo {
  id: string;
  name: string;
  description: string;
  domain: string;
  category: string;
  sourceId: string;
  geometry: string;
  timeModel: 'event' | 'interval' | 'snapshot' | 'reference' | 'indicator';
  render: { type: 'point' | 'heatmap' | 'line' | 'polygon' | 'choropleth' | 'track'; color: SlotColor; shape: Shape; heatmapBelowZoom?: number; minZoom?: number };
  metric: { name: string; unit: string; scale: 'sequential' | 'diverging'; higherIs: 'worse' | 'better' | 'neutral'; transform: 'linear' | 'log' } | null;
  freshForSec: number | null;
  liveMaxAgeSec: number | null;
  retentionDays: number | null;
  defaultOn: boolean;
  correlationClass: string | null;
}

export interface DomainInfo {
  id: string;
  name: string;
  description: string;
}

export interface Meta {
  app: string;
  version: string;
  mode: 'live' | 'fixture';
  fixture: boolean;
  fixtureNotice: string | null;
  fixtureEpoch: number | null;
  now: number;
  domains: DomainInfo[];
  severityLabels: string[];
  layers: LayerInfo[];
  sourceCount: number;
  timeExtent: { min: number | null; max: number | null };
  demoScenario: { source: string; fromRun: number; toRun: number | null; label: string }[];
  countries: { iso3: string; name: string; label: [number, number]; bbox: [number, number, number, number] }[];
}

export type SourceStatus = 'healthy' | 'delayed' | 'rate_limited' | 'stale' | 'unavailable' | 'misconfigured' | 'pending' | 'disabled';

export interface SourceHealth {
  sourceId: string;
  status: SourceStatus;
  message: string;
  missingEnv: string[];
  lastAttemptAt: number | null;
  lastSuccessAt: number | null;
  lastError: string | null;
  lastErrorAt: number | null;
  nextRunAt: number | null;
  rateLimitedUntil: number | null;
  consecutiveFailures: number;
  lastDurationMs: number | null;
  lastUpstreamTime: number | null;
  lastCounts: { inserted: number; updated: number; unchanged: number; ended: number; rejected: number } | null;
  pollIntervalSec: number;
  staleAfterSec: number;
  dataIsStale: boolean;
  breaker: string;
}

export interface SourceManifest {
  id: string;
  provider: string;
  dataset: string;
  description: string;
  homepageUrl: string;
  documentationUrl: string;
  sourceUrls: string[];
  allowedHosts: string[];
  coverage: { geographic: string; temporal: string };
  updateCadence: { upstream: string; pollIntervalSec: number; staleAfterSec: number };
  auth: { type: string; envVars: { name: string; required: boolean; description: string }[]; setup?: string; obtainUrl?: string };
  attribution: string;
  license: { name: string; url: string; redistribution: string; nonCommercialOnly: boolean; notes?: string };
  limitations: string[];
  confidenceNotes: string;
  retention: { note: string };
  snapshot: string;
  layers: { id: string; name: string; retentionDays: number | null }[];
}

export interface SourceEntry {
  manifest: SourceManifest;
  health: SourceHealth;
  records: number;
  layerRecords: Record<string, number>;
  running: boolean;
  demoScenario: string | null;
}

export interface FeaturesResponse {
  generatedAt: number;
  now: number;
  zoom: number;
  points: FeatureCollection;
  areas: FeatureCollection;
  lines: FeatureCollection;
  density: FeatureCollection;
  counts: Record<string, number>;
  total: number;
  clustered: boolean;
  truncated: { areas: boolean; lines: boolean };
  hiddenByZoom: string[];
  ms: number;
}

export interface ChoroplethLayer {
  name: string;
  unit: string;
  scale: 'sequential' | 'diverging';
  higherIs: string;
  transform: string;
  values: Record<string, { v: number; id: string; p: string | null; t: number | null; f: number }>;
  min: number | null;
  max: number | null;
  breaks: number[];
}

export interface ListItem {
  id: string;
  title: string;
  layerId: string;
  sourceId: string;
  severity: number | null;
  confidence: number | null;
  freshness: Freshness;
  time: number | null;
  country: string | null;
  kind: string;
  point: [number, number] | null;
}

export interface RecordDetail {
  now: number;
  fixture: boolean;
  record: {
    id: string; upstreamId: string; sourceId: string; layerId: string; domain: string; category: string; subcategory: string | null;
    geometryKind: string; geometry: Geometry | null; bbox: [number, number, number, number] | null; point: [number, number] | null; countries: string[];
    occurredAt: number | null; publishedAt: number | null; updatedAt: number | null; fetchedAt: number; expiresAt: number | null; endedAt: number | null;
    tStart: number | null; tEnd: number | null; ongoing: boolean;
    severity: number | null; severityLabel: string | null; confidence: number | null; confidenceBasis: string | null;
    uncertainty: Record<string, number | string> | null;
    title: string; description: string | null; attributes: Record<string, string | number | boolean | null>;
    metric: { name: string; value: number; unit: string; period?: string } | null;
    url: string | null; attribution: string; licenseUrl: string;
    provenance: { sourceId: string; provider: string; dataset: string; adapterVersion: string; fetchUrls: string[]; fetchedAt: number; firstSeenAt: number; revision: number; contentHash: string; derived: string[]; fixture: boolean; normalisation: string[] };
    freshness: Freshness;
    track: [number, number, number][] | null;
    incident: null | { id: string; class: string; sourceCount: number; memberCount: number; note: string; basis: Record<string, unknown>; members: { id: string; title: string; sourceId: string; layerId: string; time: number | null; basis: Record<string, unknown> }[] };
  };
  layer: { id: string; name: string; domain: string; timeModel: string } | null;
  source: null | { id: string; provider: string; dataset: string; homepageUrl: string; documentationUrl: string; attribution: string; license: SourceManifest['license']; confidenceNotes: string; limitations: string[]; updateCadence: SourceManifest['updateCadence'] };
  sourceHealth: SourceHealth | null;
}

export interface Filters {
  sources: string[];
  categories: string[];
  countries: string[];
  sevMin: number;
  sevMax: number;
  sevUnknown: boolean;
  confMin: number;
  confUnknown: boolean;
  fresh: Freshness[];
  q: string;
}

export const DEFAULT_FILTERS: Filters = { sources: [], categories: [], countries: [], sevMin: 0, sevMax: 4, sevUnknown: true, confMin: 0, confUnknown: true, fresh: [], q: '' };

export type TimeState =
  | { mode: 'live'; windowSec: number }
  | { mode: 'range'; from: number; to: number; cursor: number; windowSec: number /* 0 = cumulative from start */ };

export interface ViewState {
  lng: number;
  lat: number;
  zoom: number;
}
