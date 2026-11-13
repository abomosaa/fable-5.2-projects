/**
 * Draft → IntelRecord: schema validation, coordinate and time normalisation, text sanitisation,
 * country resolution, time-interval derivation and content hashing.
 * Pure and deterministic – the same draft always yields the same record (apart from fetch bookkeeping).
 */
import type { Geometry } from 'geojson';
import { z } from 'zod';
import { countryAt, countryByIso3, toIso3 } from '../core/countries.ts';
import { bboxOfGeometry, normaliseGeometry, representativePoint, type BBox } from '../core/geo.ts';
import { plainText, safeUrl, sha256, stableStringify } from '../core/text.ts';
import { isSaneTime } from '../core/time.ts';
import type { AttrValue, GeometryKind, IntelRecord, LayerDef, RecordDraft, RejectedItem, Severity, SourceManifest } from '../core/types.ts';

const timeField = z.number().finite().nullable().optional();

const DraftSchema = z.object({
  upstreamId: z.string().min(1).max(400),
  layerId: z.string().min(1),
  category: z.string().max(60).optional(),
  subcategory: z.string().max(80).nullable().optional(),
  geometry: z.unknown().optional(),
  geometryKind: z.enum(['point', 'line', 'polygon', 'track', 'bbox', 'country', 'global']).optional(),
  country: z.union([z.string(), z.array(z.string()), z.null()]).optional(),
  occurredAt: timeField,
  publishedAt: timeField,
  updatedAt: timeField,
  expiresAt: timeField,
  endedAt: timeField,
  ongoing: z.boolean().optional(),
  severity: z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(3), z.literal(4), z.null()]).optional(),
  severityLabel: z.string().nullable().optional(),
  confidence: z.number().min(0).max(1).nullable().optional(),
  confidenceBasis: z.string().nullable().optional(),
  uncertainty: z.record(z.union([z.number().finite(), z.string()])).nullable().optional(),
  title: z.string().min(1),
  description: z.string().nullable().optional(),
  attributes: z.record(z.union([z.string(), z.number().finite(), z.boolean(), z.null(), z.undefined()])).optional(),
  metric: z.object({ name: z.string().min(1), value: z.number().finite(), unit: z.string(), period: z.string().optional() }).nullable().optional(),
  url: z.string().nullable().optional(),
  derived: z.array(z.string()).optional(),
});

export interface NormaliseContext {
  manifest: SourceManifest;
  adapterVersion: string;
  now: number;
  fetchedAt: number;
  fetchUrls: string[];
  fixture: boolean;
}

export type NormaliseResult = { ok: true; record: IntelRecord } | { ok: false; rejected: RejectedItem };

const MAX_ATTRS = 60;
const MAX_VERTICES = 20_000;

function kindOf(geom: Geometry): GeometryKind {
  switch (geom.type) {
    case 'Point':
    case 'MultiPoint':
      return 'point';
    case 'LineString':
    case 'MultiLineString':
      return 'line';
    default:
      return 'polygon';
  }
}

function countVertices(g: Geometry): number {
  let n = 0;
  const walk = (c: unknown): void => {
    if (Array.isArray(c)) {
      if (typeof c[0] === 'number') n++;
      else c.forEach(walk);
    }
  };
  if (g.type !== 'GeometryCollection') walk(g.coordinates);
  return n;
}

/** Stable internal id: `<sourceId>:<upstreamId>` with unsafe characters replaced; long ids are hashed. */
export function makeRecordId(sourceId: string, upstreamId: string): string {
  const clean = upstreamId.trim().replace(/[^A-Za-z0-9._~-]+/g, '_');
  if (clean.length <= 96 && clean === upstreamId.trim()) return `${sourceId}:${clean}`;
  return `${sourceId}:${clean.slice(0, 48)}~${sha256(upstreamId).slice(0, 16)}`;
}

export function normaliseDraft(draft: RecordDraft, ctx: NormaliseContext): NormaliseResult {
  const sample = `${String((draft as { upstreamId?: unknown })?.upstreamId ?? '?').slice(0, 80)} ${String((draft as { title?: unknown })?.title ?? '').slice(0, 60)}`.trim();
  const reject = (reason: string): NormaliseResult => ({ ok: false, rejected: { reason, sample } });

  const parsed = DraftSchema.safeParse(draft);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return reject(`schema: ${issue?.path.join('.') || 'record'} ${issue?.message ?? 'invalid'}`);
  }
  const d = parsed.data;
  const layer: LayerDef | undefined = ctx.manifest.layers.find((l) => l.id === d.layerId);
  if (!layer) return reject(`unknown layer "${d.layerId}" for source ${ctx.manifest.id}`);

  const notes: string[] = [];
  const derived = new Set(d.derived ?? []);

  // ── times ──
  const times: Record<'occurredAt' | 'publishedAt' | 'updatedAt' | 'expiresAt' | 'endedAt', number | null> = {
    occurredAt: null, publishedAt: null, updatedAt: null, expiresAt: null, endedAt: null,
  };
  for (const k of Object.keys(times) as (keyof typeof times)[]) {
    const v = d[k];
    if (v == null) continue;
    if (!isSaneTime(v, ctx.now)) return reject(`time: ${k} out of range (${v})`);
    times[k] = Math.round(v);
  }
  // Events cannot have occurred in the future; tolerate modest clock skew.
  if (layer.timeModel === 'event' && times.occurredAt != null && times.occurredAt > ctx.now + 6 * 3_600_000) {
    return reject(`time: event occurredAt is in the future (${new Date(times.occurredAt).toISOString()})`);
  }

  // ── geometry ──
  let geometry: Geometry | null = null;
  let geometryKind: GeometryKind;
  let bbox: BBox | null = null;
  let point: [number, number] | null = null;
  let countries: string[] = [];

  if (d.country != null) {
    const raw = Array.isArray(d.country) ? d.country : [d.country];
    for (const c of raw) {
      const iso = toIso3(c);
      if (iso && !countries.includes(iso)) countries.push(iso);
    }
  }

  if (d.geometry != null) {
    const check = normaliseGeometry(d.geometry);
    if (!check.ok) return reject(`geometry: ${check.reason}`);
    geometry = check.geometry!;
    notes.push(...check.notes);
    if (countVertices(geometry) > MAX_VERTICES) return reject('geometry: too many vertices');
    geometryKind = d.geometryKind && d.geometryKind !== 'country' && d.geometryKind !== 'global' ? d.geometryKind : kindOf(geometry);
    bbox = bboxOfGeometry(geometry);
    point = representativePoint(geometry, geometryKind);
    if (!countries.length && (geometryKind === 'point' || geometryKind === 'track')) {
      const iso = countryAt(point[0], point[1]);
      if (iso) {
        countries = [iso];
        derived.add('country');
      }
    }
  } else if (d.geometryKind === 'global') {
    geometryKind = 'global';
  } else {
    // country-level record
    if (!countries.length) return reject(d.country ? `country: unrecognised country "${String(d.country).slice(0, 40)}"` : 'geometry: record has neither geometry nor country');
    geometryKind = 'country';
    const c = countryByIso3(countries[0]!);
    if (c) {
      bbox = c.bbox;
      point = c.label;
    }
  }

  // ── time interval used by timeline queries ──
  let tStart: number | null;
  let tEnd: number | null;
  const anchor = times.occurredAt ?? times.publishedAt ?? times.updatedAt;
  switch (layer.timeModel) {
    case 'reference':
      tStart = null;
      tEnd = null;
      break;
    case 'event':
    case 'snapshot':
    case 'indicator':
      if (anchor == null) return reject('time: record has no occurrence, publication or update time');
      tStart = anchor;
      tEnd = anchor;
      break;
    case 'interval': {
      if (anchor == null) return reject('time: record has no occurrence, publication or update time');
      tStart = anchor;
      const end = times.endedAt ?? times.expiresAt;
      if (end != null) tEnd = Math.max(end, tStart);
      else if (d.ongoing) tEnd = Math.max(ctx.fetchedAt, tStart);
      else tEnd = Math.max(times.updatedAt ?? tStart, tStart);
      break;
    }
  }

  // ── text ──
  const title = plainText(d.title, 240);
  if (!title) return reject('title: empty after sanitisation');
  const description = d.description ? plainText(d.description, 700) || null : null;
  const url = d.url ? safeUrl(d.url) : null;
  if (d.url && !url) notes.push('dropped non-http(s) source link');

  const attributes: Record<string, AttrValue> = {};
  let attrCount = 0;
  for (const [k, v] of Object.entries(d.attributes ?? {})) {
    if (v === undefined || v === null || v === '') continue;
    if (attrCount++ >= MAX_ATTRS) break;
    const key = plainText(k, 60);
    if (!key) continue;
    attributes[key] = typeof v === 'string' ? plainText(v, 600) : v;
  }

  const severity = (d.severity ?? null) as Severity | null;
  const confidence = d.confidence ?? null;

  const core = {
    upstreamId: d.upstreamId.trim(),
    layerId: layer.id,
    category: d.category ?? layer.category,
    subcategory: d.subcategory ?? null,
    geometryKind,
    geometry,
    countries,
    occurredAt: times.occurredAt,
    publishedAt: times.publishedAt,
    updatedAt: times.updatedAt,
    expiresAt: times.expiresAt,
    endedAt: times.endedAt,
    ongoing: !!d.ongoing,
    severity,
    severityLabel: d.severityLabel ? plainText(d.severityLabel, 80) : null,
    confidence,
    confidenceBasis: d.confidenceBasis ? plainText(d.confidenceBasis, 300) : null,
    uncertainty: d.uncertainty ?? null,
    title,
    description,
    attributes,
    metric: d.metric ?? null,
    url,
  };
  const contentHash = sha256(stableStringify(core)).slice(0, 32);

  const record: IntelRecord = {
    id: makeRecordId(ctx.manifest.id, core.upstreamId),
    upstreamId: core.upstreamId,
    sourceId: ctx.manifest.id,
    layerId: layer.id,
    domain: layer.domain,
    category: core.category,
    subcategory: core.subcategory,
    geometryKind,
    geometry,
    bbox,
    point,
    countries,
    occurredAt: times.occurredAt,
    publishedAt: times.publishedAt,
    updatedAt: times.updatedAt,
    fetchedAt: ctx.fetchedAt,
    expiresAt: times.expiresAt,
    tStart,
    tEnd,
    ongoing: core.ongoing,
    severity,
    severityLabel: core.severityLabel,
    confidence,
    confidenceBasis: core.confidenceBasis,
    uncertainty: core.uncertainty,
    title,
    description,
    attributes,
    metric: core.metric,
    url,
    attribution: ctx.manifest.attribution,
    licenseUrl: ctx.manifest.license.url,
    provenance: {
      sourceId: ctx.manifest.id,
      provider: ctx.manifest.provider,
      dataset: ctx.manifest.dataset,
      adapterVersion: ctx.adapterVersion,
      fetchUrls: ctx.fetchUrls.slice(0, 5),
      fetchedAt: ctx.fetchedAt,
      firstSeenAt: ctx.fetchedAt,
      revision: 1,
      contentHash,
      derived: [...derived].sort(),
      fixture: ctx.fixture,
      normalisation: notes,
    },
  };
  return { ok: true, record };
}
