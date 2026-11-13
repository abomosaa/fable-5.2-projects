/**
 * Read side: viewport / time / filter queries, server-side clustering and density grids, choropleth values,
 * lists, search, histograms and record detail.
 *
 * Every query starts from an explicit list of enabled layers. A layer that is not listed contributes nothing –
 * not to features, clusters, counts, lists, search results or alerts.
 */
import type { Feature, FeatureCollection, Geometry, Position } from 'geojson';
import type { Catalog, CatalogLayer } from '../core/catalog.ts';
import { simplifyGeometry, splitAtAntimeridian, type BBox } from '../core/geo.ts';
import type { Freshness, IntelRecord, Provenance } from '../core/types.ts';
import type { SourceHealth } from '../ingest/health.ts';
import type { Db, SqlValue } from './db.ts';

export type TimeSpec = { mode: 'live'; windowMs: number } | { mode: 'range'; from: number; to: number };

export interface QueryFilters {
  layers: string[];
  bbox?: BBox | null;
  time: TimeSpec;
  sources?: string[];
  categories?: string[];
  countries?: string[];
  /** Inclusive severity range 0..4. */
  severityMin?: number;
  severityMax?: number;
  /** Include records without a severity (default true). */
  severityUnknown?: boolean;
  confidenceMin?: number;
  /** Include records without a confidence value (default true). */
  confidenceUnknown?: boolean;
  freshness?: Freshness[];
  q?: string;
}

export interface QueryContext {
  now: number;
  health: Map<string, SourceHealth>;
}

interface SlimRow {
  rowid: number;
  id: string;
  layer_id: string;
  source_id: string;
  geom_kind: string;
  lon: number | null;
  lat: number | null;
  severity: number | null;
  confidence: number | null;
  t_start: number | null;
  t_end: number | null;
  occurred_at: number | null;
  updated_at: number | null;
  fetched_at: number;
  expires_at: number | null;
  ended_at: number | null;
  ongoing: number;
  title: string;
  country: string | null;
  category: string;
  metric_value: number | null;
}

const SLIM = `r.rowid, r.id, r.layer_id, r.source_id, r.geom_kind, r.lon, r.lat, r.severity, r.confidence, r.t_start, r.t_end, r.occurred_at,
  r.updated_at, r.fetched_at, r.expires_at, r.ended_at, r.ongoing, r.title, r.country, r.category, r.metric_value`;

const DEFAULT_FRESH_SEC: Record<string, number> = { event: 86_400, interval: 86_400, snapshot: 3_600, indicator: 400 * 86_400, reference: Infinity };
const FRESH_CODE: Record<Freshness, number> = { fresh: 0, recent: 1, aging: 2, stale: 3, expired: 4, reference: 5 };

/**
 * Freshness combines the upstream event/update time with fetch bookkeeping:
 *  reference – timeless reference dataset
 *  expired   – upstream expiry passed, upstream closed it, or it vanished from a complete snapshot
 *  stale     – its source has not been fetched successfully within the source's staleness budget
 *  fresh / recent / aging – age of the upstream event time (events) or newest upstream update (everything else)
 *                           relative to the layer's freshness window (≤1×, ≤4×, older)
 */
export function freshnessOf(
  row: Pick<SlimRow, 't_start' | 't_end' | 'updated_at' | 'occurred_at' | 'expires_at' | 'ended_at' | 'ongoing'>,
  layer: CatalogLayer,
  sourceStale: boolean,
  now: number,
): Freshness {
  if (layer.timeModel === 'reference') return 'reference';
  if (row.ended_at != null) return 'expired';
  if (row.expires_at != null && row.expires_at < now) return 'expired';
  if (layer.timeModel === 'interval' && !row.ongoing && row.t_end != null && row.t_end < now) return 'expired';
  if (sourceStale) return 'stale';
  // Events age from when they occurred (a later upstream revision does not make an old event new again);
  // everything else ages from the newest upstream statement about it.
  const ref =
    layer.timeModel === 'event'
      ? (row.occurred_at ?? row.t_start ?? 0)
      : Math.max(row.updated_at ?? 0, row.occurred_at ?? 0, layer.timeModel === 'interval' && row.ongoing ? (row.t_end ?? 0) : 0) || row.t_start || 0;
  const age = now - ref;
  const window = (layer.freshForSec ?? layer.liveMaxAgeSec ?? DEFAULT_FRESH_SEC[layer.timeModel]!) * 1000;
  if (age <= window) return 'fresh';
  if (age <= 4 * window) return 'recent';
  return 'aging';
}

export function timeBounds(time: TimeSpec, now: number): { from: number; to: number } {
  return time.mode === 'live' ? { from: now - time.windowMs, to: now } : { from: time.from, to: time.to };
}

/** Normalise a possibly world-wrapping viewport into 0–2 longitude ranges within [-180, 180]. null = whole world. */
export function lonRanges(bbox: BBox): [number, number][] | null {
  let [w, , e] = bbox;
  if (!Number.isFinite(w) || !Number.isFinite(e) || e - w >= 360) return null;
  const wrap = (x: number) => ((((x + 180) % 360) + 360) % 360) - 180;
  w = wrap(w);
  e = e === 180 ? 180 : wrap(e);
  if (w <= e) return [[w, e]];
  return [[w, 180], [-180, e]];
}

const MAX_Z = 22;
function mercY(lat: number): number {
  const s = Math.sin((Math.max(-85.0511, Math.min(85.0511, lat)) * Math.PI) / 180);
  return 0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI);
}

export interface FeaturesResult {
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

function ftsQuery(q: string): string | null {
  const tokens = q
    .normalize('NFKC')
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((t) => t.length >= 1)
    .slice(0, 8);
  if (!tokens.length) return null;
  return tokens.map((t) => `"${t}"*`).join(' ');
}

export class QueryEngine {
  private readonly geomCache = new Map<string, Geometry>();
  constructor(private readonly db: Db, private readonly catalog: Catalog) {}

  /** Enabled layers that exist in the catalog (unknown ids are ignored). */
  private resolveLayers(ids: string[]): CatalogLayer[] {
    const out: CatalogLayer[] = [];
    const seen = new Set<string>();
    for (const id of ids) {
      const l = this.catalog.layer(id);
      if (l && !seen.has(id)) {
        seen.add(id);
        out.push(l);
      }
    }
    return out;
  }

  /**
   * Fetch slim rows matching the filters, then apply the per-layer rules that are awkward in SQL
   * (live max age of snapshot layers, latest-value reduction of indicators, freshness).
   */
  private matchRows(f: QueryFilters, ctx: QueryContext, opts: { layers?: CatalogLayer[]; spatial?: boolean; includeGlobal?: boolean } = {}): { rows: SlimRow[]; fresh: Freshness[] } {
    const layers = opts.layers ?? this.resolveLayers(f.layers);
    if (!layers.length) return { rows: [], fresh: [] };
    const { from, to } = timeBounds(f.time, ctx.now);
    const where: string[] = [];
    const params: SqlValue[] = [];
    let join = '';

    where.push(`r.layer_id IN (${layers.map(() => '?').join(',')})`);
    params.push(...layers.map((l) => l.id));

    // time: timeless OR interval overlaps [from, to]; ongoing records extend to the present; indicators: any value at or before `to`
    const indicatorIds = layers.filter((l) => l.timeModel === 'indicator').map((l) => l.id);
    const timeSql = '(r.t_start IS NULL OR (r.t_start <= ? AND (COALESCE(r.t_end, r.t_start) >= ? OR (r.ongoing = 1 AND r.ended_at IS NULL))))';
    if (indicatorIds.length) {
      where.push(`(${timeSql} OR (r.t_start <= ? AND r.layer_id IN (${indicatorIds.map(() => '?').join(',')})))`);
      params.push(to, from, to, ...indicatorIds);
    } else {
      where.push(timeSql);
      params.push(to, from);
    }

    if (opts.spatial !== false && f.bbox) {
      const [, s, , n] = f.bbox;
      const ranges = lonRanges(f.bbox);
      const globalClause = opts.includeGlobal ? " OR r.geom_kind = 'global'" : '';
      // A viewport that shows (nearly) the whole world needs no spatial filter at all.
      if (ranges || s > -84 || n < 84) {
        const xs = ranges ?? [[-180, 180]];
        const conds = xs.map(() => '(t.maxx >= ? AND t.minx <= ? AND t.maxy >= ? AND t.miny <= ?)').join(' OR ');
        const sub = `r.rowid IN (SELECT t.rowid FROM records_rtree t WHERE ${conds})`;
        where.push(`(${sub}${globalClause})`);
        for (const [w, e] of xs) params.push(w, e, s, n);
      }
    } else if (!opts.includeGlobal && opts.spatial !== false) {
      /* whole world: nothing to add */
    }
    if (f.sources?.length) {
      where.push(`r.source_id IN (${f.sources.map(() => '?').join(',')})`);
      params.push(...f.sources);
    }
    if (f.categories?.length) {
      where.push(`r.category IN (${f.categories.map(() => '?').join(',')})`);
      params.push(...f.categories);
    }
    if (f.countries?.length) {
      // primary country index first; multi-country records are matched on the full list
      const cs = f.countries.map((c) => c.toUpperCase()).filter((c) => /^[A-Z]{3}$/.test(c));
      if (cs.length) {
        where.push(`(r.country IN (${cs.map(() => '?').join(',')}) OR ${cs.map(() => "(',' || r.countries || ',') LIKE ?").join(' OR ')})`);
        params.push(...cs, ...cs.map((c) => `%,${c},%`));
      } else where.push('0');
    }
    const sMin = f.severityMin ?? 0;
    const sMax = f.severityMax ?? 4;
    const sUnknown = f.severityUnknown ?? true;
    if (sMin > 0 || sMax < 4 || !sUnknown) {
      where.push(sUnknown ? '(r.severity IS NULL OR (r.severity >= ? AND r.severity <= ?))' : '(r.severity >= ? AND r.severity <= ?)');
      params.push(sMin, sMax);
    }
    const cMin = f.confidenceMin ?? 0;
    const cUnknown = f.confidenceUnknown ?? true;
    if (cMin > 0 || !cUnknown) {
      where.push(cUnknown ? '(r.confidence IS NULL OR r.confidence >= ?)' : 'r.confidence >= ?');
      params.push(cMin);
    }
    if (f.q?.trim()) {
      const fq = ftsQuery(f.q);
      if (!fq) return { rows: [], fresh: [] };
      where.push('r.rowid IN (SELECT rowid FROM records_fts WHERE records_fts MATCH ?)');
      params.push(fq);
    }

    const raw = this.db.all<SlimRow>(`SELECT ${SLIM} FROM records r ${join} WHERE ${where.join(' AND ')}`, ...params);

    const byLayer = new Map(layers.map((l) => [l.id, l]));
    const wanted = f.freshness?.length ? new Set(f.freshness) : null;
    const live = f.time.mode === 'live';
    const rows: SlimRow[] = [];
    const fresh: Freshness[] = [];
    // indicators: keep only the latest value per (layer, country) at or before `to`
    const latest = new Map<string, number>();
    for (let i = 0; i < raw.length; i++) {
      const r = raw[i]!;
      const layer = byLayer.get(r.layer_id)!;
      if (layer.timeModel === 'indicator') {
        const k = `${r.layer_id}|${r.country ?? r.id}`;
        const prev = latest.get(k);
        if (prev == null || (raw[prev]!.t_start ?? 0) < (r.t_start ?? 0)) latest.set(k, i);
        continue;
      }
      if (live && layer.timeModel === 'snapshot' && layer.liveMaxAgeSec != null && r.t_start != null && r.t_start < ctx.now - layer.liveMaxAgeSec * 1000) {
        continue; // a position that old is not "live"
      }
      const fr = freshnessOf(r, layer, ctx.health.get(r.source_id)?.dataIsStale ?? false, ctx.now);
      if (wanted && !wanted.has(fr)) continue;
      rows.push(r);
      fresh.push(fr);
    }
    for (const i of latest.values()) {
      const r = raw[i]!;
      const layer = byLayer.get(r.layer_id)!;
      const fr = freshnessOf(r, layer, ctx.health.get(r.source_id)?.dataIsStale ?? false, ctx.now);
      if (wanted && !wanted.has(fr)) continue;
      rows.push(r);
      fresh.push(fr);
    }
    return { rows, fresh };
  }

  /** Viewport query for the map: clusters / points, polygons, lines and density cells. */
  features(f: QueryFilters, zoom: number, ctx: QueryContext): FeaturesResult {
    const t0 = performance.now();
    const z = Math.max(0, Math.min(MAX_Z, zoom));
    const all = this.resolveLayers(f.layers);
    const hiddenByZoom = all.filter((l) => l.render.minZoom != null && z < l.render.minZoom).map((l) => l.id);
    // Choropleth layers are delivered by choropleth(); zoom-gated layers are not queried at all.
    const layers = all.filter((l) => l.render.type !== 'choropleth' && !hiddenByZoom.includes(l.id));
    const { rows, fresh } = this.matchRows(f, ctx, { layers });
    const byLayer = new Map(layers.map((l) => [l.id, l]));
    const counts: Record<string, number> = {};

    const pointIdx: number[] = [];
    const densityIdx: number[] = [];
    const shapeIdx: number[] = [];
    const trackIdx: number[] = [];
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i]!;
      counts[r.layer_id] = (counts[r.layer_id] ?? 0) + 1;
      const layer = byLayer.get(r.layer_id)!;
      if (r.geom_kind === 'global') continue;
      if (r.geom_kind === 'polygon' || r.geom_kind === 'bbox' || r.geom_kind === 'line') {
        shapeIdx.push(i);
        continue;
      }
      if (r.lon == null || r.lat == null) continue;
      if (layer.render.type === 'heatmap' && layer.render.heatmapBelowZoom != null && z < layer.render.heatmapBelowZoom) {
        densityIdx.push(i);
        continue;
      }
      if (r.geom_kind === 'track' || layer.render.type === 'track') trackIdx.push(i);
      pointIdx.push(i);
    }

    // ── points & clusters ──
    const pointFeatures: Feature[] = [];
    const doCluster = z < 11 || pointIdx.length > 6000;
    // Moving objects are drawn pointing along their broadcast heading / course (when few enough to look up).
    const getHeading = trackIdx.length <= 4000
      ? this.db.prepare("SELECT COALESCE(json_extract(attributes, '$.headingDeg'), json_extract(attributes, '$.courseDeg')) AS h FROM records WHERE rowid = ?")
      : null;
    const single = (i: number): Feature => {
      const r = rows[i]!;
      const props: Record<string, unknown> = { k: 'p', id: r.id, l: r.layer_id, s: r.severity ?? -1, f: FRESH_CODE[fresh[i]!], t: r.title, v: r.metric_value ?? undefined };
      if (getHeading && byLayer.get(r.layer_id)!.render.type === 'track') {
        const h = (getHeading.get(r.rowid) as { h: unknown } | undefined)?.h;
        if (typeof h === 'number' && Number.isFinite(h)) props.h = Math.round(h);
      }
      return { type: 'Feature', geometry: { type: 'Point', coordinates: [r.lon!, r.lat!] }, properties: props };
    };
    if (doCluster) {
      // Grid clustering in screen space: MapLibre draws the world 512·2^zoom CSS pixels wide.
      // Zoom is quantised to half levels so cells stay put during small zoom changes.
      const cellPx = 64;
      const world = 512 * 2 ** (Math.floor(z * 2) / 2);
      interface Cell { n: number; sx: number; sy: number; first: number; sev: number; layers: Map<string, number>; w: number; s: number; e: number; nn: number }
      const cells = new Map<number, Cell>();
      for (const i of pointIdx) {
        const r = rows[i]!;
        const cx = Math.floor((((r.lon! + 180) / 360) * world) / cellPx);
        const cy = Math.floor((mercY(r.lat!) * world) / cellPx);
        const key = cx * 8388608 + cy;
        let c = cells.get(key);
        if (!c) cells.set(key, (c = { n: 0, sx: 0, sy: 0, first: i, sev: -1, layers: new Map(), w: 180, s: 90, e: -180, nn: -90 }));
        c.n++;
        c.sx += r.lon!;
        c.sy += r.lat!;
        if ((r.severity ?? -1) > c.sev) c.sev = r.severity ?? -1;
        c.layers.set(r.layer_id, (c.layers.get(r.layer_id) ?? 0) + 1);
        if (r.lon! < c.w) c.w = r.lon!;
        if (r.lon! > c.e) c.e = r.lon!;
        if (r.lat! < c.s) c.s = r.lat!;
        if (r.lat! > c.nn) c.nn = r.lat!;
      }
      for (const c of cells.values()) {
        if (c.n === 1) {
          pointFeatures.push(single(c.first));
          continue;
        }
        const top = [...c.layers.entries()].sort((a, b) => b[1] - a[1]);
        pointFeatures.push({
          type: 'Feature',
          geometry: { type: 'Point', coordinates: [round5(c.sx / c.n), round5(c.sy / c.n)] },
          properties: {
            k: 'c', n: c.n, s: c.sev, l: top[0]![0],
            // per-layer composition (top 6) so the client can describe the cluster without another request
            ls: top.slice(0, 6).map(([id, n]) => `${id}:${n}`).join(','),
            bb: [c.w, c.s, c.e, c.nn].map(round5).join(','),
          },
        });
      }
    } else {
      for (const i of pointIdx) pointFeatures.push(single(i));
    }

    // ── density grid for heat-map layers ──
    const densityFeatures: Feature[] = [];
    if (densityIdx.length) {
      const cellPx = 14;
      const world = 512 * 2 ** (Math.floor(z * 2) / 2);
      const cells = new Map<number, { n: number; sx: number; sy: number; layers: Map<string, number> }>();
      for (const i of densityIdx) {
        const r = rows[i]!;
        const key = Math.floor((((r.lon! + 180) / 360) * world) / cellPx) * 8388608 + Math.floor((mercY(r.lat!) * world) / cellPx);
        let c = cells.get(key);
        if (!c) cells.set(key, (c = { n: 0, sx: 0, sy: 0, layers: new Map() }));
        c.n++;
        c.sx += r.lon!;
        c.sy += r.lat!;
        c.layers.set(r.layer_id, (c.layers.get(r.layer_id) ?? 0) + 1);
      }
      for (const c of cells.values()) {
        for (const [layerId, n] of c.layers) {
          densityFeatures.push({ type: 'Feature', geometry: { type: 'Point', coordinates: [round5(c.sx / c.n), round5(c.sy / c.n)] }, properties: { l: layerId, w: n } });
        }
      }
    }

    // ── polygons and lines (with geometry), simplified for the zoom level ──
    const areas: Feature[] = [];
    const lines: Feature[] = [];
    const MAX_SHAPES = 2500;
    let truncAreas = false;
    let truncLines = false;
    if (shapeIdx.length) {
      // most severe / most recent first when truncating
      shapeIdx.sort((a, b) => (rows[b]!.severity ?? -1) - (rows[a]!.severity ?? -1) || (rows[b]!.t_start ?? 0) - (rows[a]!.t_start ?? 0));
      const tolerance = z >= 9 ? 0 : (360 / (256 * 2 ** z)) * 1.2;
      const getGeom = this.db.prepare('SELECT geometry, revision FROM records WHERE rowid = ?');
      for (const i of shapeIdx) {
        const r = rows[i]!;
        const isLine = r.geom_kind === 'line';
        if (isLine ? lines.length >= MAX_SHAPES : areas.length >= MAX_SHAPES) {
          if (isLine) truncLines = true;
          else truncAreas = true;
          continue;
        }
        const g = getGeom.get(r.rowid) as { geometry: string | null; revision: number } | undefined;
        if (!g?.geometry) continue;
        const zb = tolerance === 0 ? 99 : Math.floor(z);
        const ck = `${r.rowid}:${g.revision}:${zb}`;
        let geom = this.geomCache.get(ck);
        if (!geom) {
          geom = simplifyGeometry(JSON.parse(g.geometry) as Geometry, tolerance);
          if (this.geomCache.size > 20_000) this.geomCache.clear();
          this.geomCache.set(ck, geom);
        }
        const feat: Feature = { type: 'Feature', geometry: geom, properties: { id: r.id, l: r.layer_id, s: r.severity ?? -1, f: FRESH_CODE[fresh[i]!], t: r.title } };
        (isLine ? lines : areas).push(feat);
      }
    }

    // ── paths of moving objects / storm tracks: only when few enough to be legible ──
    if (trackIdx.length && (z >= 5 || trackIdx.length <= 150)) {
      const getTrack = this.db.prepare('SELECT geometry, track FROM records WHERE rowid = ?');
      let n = 0;
      for (const i of trackIdx) {
        if (n >= 400) {
          truncLines = true;
          break;
        }
        const r = rows[i]!;
        const g = getTrack.get(r.rowid) as { geometry: string | null; track: string | null } | undefined;
        if (!g) continue;
        let geom: Geometry | null = null;
        if (g.track) {
          const pts = (JSON.parse(g.track) as [number, number, number][]).map((p): Position => [p[0], p[1]]);
          const parts = splitAtAntimeridian(pts);
          if (parts.length === 1) geom = { type: 'LineString', coordinates: parts[0]! };
          else if (parts.length > 1) geom = { type: 'MultiLineString', coordinates: parts };
        } else if (g.geometry && r.geom_kind === 'track') {
          const parsed = JSON.parse(g.geometry) as Geometry;
          if (parsed.type === 'LineString' || parsed.type === 'MultiLineString') geom = parsed;
        }
        if (!geom) continue;
        lines.push({ type: 'Feature', geometry: geom, properties: { id: r.id, l: r.layer_id, s: r.severity ?? -1, f: FRESH_CODE[fresh[i]!], t: r.title, path: 1 } });
        n++;
      }
    }

    return {
      generatedAt: Date.now(),
      now: ctx.now,
      zoom: z,
      points: { type: 'FeatureCollection', features: pointFeatures },
      areas: { type: 'FeatureCollection', features: areas },
      lines: { type: 'FeatureCollection', features: lines },
      density: { type: 'FeatureCollection', features: densityFeatures },
      counts,
      total: rows.length,
      clustered: doCluster,
      truncated: { areas: truncAreas, lines: truncLines },
      hiddenByZoom,
      ms: Math.round((performance.now() - t0) * 10) / 10,
    };
  }

  /** Country values for choropleth layers: the latest value at or before the end of the time window. */
  choropleth(f: QueryFilters, ctx: QueryContext): Record<string, { name: string; unit: string; scale: string; higherIs: string; transform: string; values: Record<string, { v: number; id: string; p: string | null; t: number | null; f: number }>; min: number | null; max: number | null; breaks: number[] }> {
    const layers = this.resolveLayers(f.layers).filter((l) => l.render.type === 'choropleth');
    const out: ReturnType<QueryEngine['choropleth']> = {};
    if (!layers.length) return out;
    const { rows, fresh } = this.matchRows({ ...f, bbox: null }, ctx, { layers, spatial: false });
    const periods = new Map<string, string | null>();
    if (rows.length) {
      const ids = rows.map((r) => r.rowid);
      for (let i = 0; i < ids.length; i += 500) {
        const chunk = ids.slice(i, i + 500);
        for (const p of this.db.all<{ rowid: number; metric_period: string | null }>(`SELECT rowid, metric_period FROM records WHERE rowid IN (${chunk.map(() => '?').join(',')})`, ...chunk)) {
          periods.set(String(p.rowid), p.metric_period);
        }
      }
    }
    for (const l of layers) {
      out[l.id] = { name: l.metric?.name ?? l.name, unit: l.metric?.unit ?? '', scale: l.metric?.scale ?? 'sequential', higherIs: l.metric?.higherIs ?? 'neutral', transform: l.metric?.transform ?? 'linear', values: {}, min: null, max: null, breaks: [] };
    }
    rows.forEach((r, i) => {
      if (r.metric_value == null || !r.country) return;
      out[r.layer_id]!.values[r.country] = { v: r.metric_value, id: r.id, p: periods.get(String(r.rowid)) ?? null, t: r.t_start, f: FRESH_CODE[fresh[i]!] };
    });
    for (const l of layers) {
      const o = out[l.id]!;
      const vals = Object.values(o.values).map((x) => x.v).sort((a, b) => a - b);
      if (!vals.length) continue;
      o.min = vals[0]!;
      o.max = vals[vals.length - 1]!;
      // quantile class breaks (5 classes) – robust for skewed indicators
      const qs = [0.2, 0.4, 0.6, 0.8].map((q) => vals[Math.min(vals.length - 1, Math.floor(q * vals.length))]!);
      o.breaks = [...new Set(qs)];
    }
    return out;
  }

  /** Sorted list of matching records (results panel, search, alerts, cluster contents). */
  list(f: QueryFilters, ctx: QueryContext, opts: { limit?: number; offset?: number; sort?: 'time' | 'severity'; includeGlobal?: boolean } = {}): { items: ListItem[]; total: number } {
    const { rows, fresh } = this.matchRows(f, ctx, { includeGlobal: opts.includeGlobal ?? true });
    const idx = rows.map((_, i) => i);
    const time = (r: SlimRow) => r.t_start ?? r.updated_at ?? 0;
    if (opts.sort === 'severity') idx.sort((a, b) => (rows[b]!.severity ?? -1) - (rows[a]!.severity ?? -1) || time(rows[b]!) - time(rows[a]!));
    else idx.sort((a, b) => time(rows[b]!) - time(rows[a]!) || (rows[b]!.severity ?? -1) - (rows[a]!.severity ?? -1));
    const limit = Math.max(1, Math.min(500, opts.limit ?? 100));
    const offset = Math.max(0, opts.offset ?? 0);
    const items = idx.slice(offset, offset + limit).map((i): ListItem => {
      const r = rows[i]!;
      return {
        id: r.id, title: r.title, layerId: r.layer_id, sourceId: r.source_id, severity: r.severity, confidence: r.confidence, freshness: fresh[i]!,
        time: r.t_start ?? r.updated_at, country: r.country, kind: r.geom_kind, point: r.lon != null && r.lat != null ? [r.lon, r.lat] : null,
      };
    });
    return { items, total: rows.length };
  }

  /** Counts per time bucket for the timeline (timeless reference data and indicators are excluded). */
  histogram(f: QueryFilters, ctx: QueryContext, from: number, to: number, buckets: number): { from: number; to: number; bucketMs: number; counts: number[]; total: number } {
    const n = Math.max(1, Math.min(240, Math.floor(buckets)));
    const size = Math.max(1, Math.ceil((to - from) / n));
    const counts = new Array<number>(n).fill(0);
    const layers = this.resolveLayers(f.layers).filter((l) => l.timeModel !== 'reference' && l.timeModel !== 'indicator');
    const { rows } = this.matchRows({ ...f, time: { mode: 'range', from, to } }, ctx, { layers });
    let total = 0;
    for (const r of rows) {
      if (r.t_start == null) continue;
      const b = Math.floor((Math.max(r.t_start, from) - from) / size);
      if (b >= 0 && b < n) {
        counts[b]!++;
        total++;
      }
    }
    return { from, to, bucketMs: size, counts, total };
  }

  /** Earliest and latest event times in the store (timeline extent). */
  timeExtent(): { min: number | null; max: number | null } {
    const r = this.db.get<{ mn: number | null; mx: number | null }>("SELECT MIN(t_start) AS mn, MAX(COALESCE(t_end, t_start)) AS mx FROM records WHERE t_start IS NOT NULL AND domain != 'society'");
    return { min: r?.mn ?? null, max: r?.mx ?? null };
  }

  /** Full record with provenance, source facts and correlation links. */
  record(id: string, ctx: QueryContext): (IntelRecord & { freshness: Freshness; track: [number, number, number][] | null; endedAt: number | null; incident: unknown }) | null {
    const r = this.db.get<Record<string, unknown>>('SELECT * FROM records WHERE id = ?', id);
    if (!r) return null;
    const layer = this.catalog.layer(r.layer_id as string);
    const manifest = this.catalog.sources.get(r.source_id as string);
    const prov = JSON.parse(r.provenance as string) as Partial<Provenance>;
    const slim = r as unknown as SlimRow;
    const rec = {
      id: r.id as string,
      upstreamId: r.upstream_id as string,
      sourceId: r.source_id as string,
      layerId: r.layer_id as string,
      domain: r.domain as IntelRecord['domain'],
      category: r.category as string,
      subcategory: r.subcategory as string | null,
      geometryKind: r.geom_kind as IntelRecord['geometryKind'],
      geometry: r.geometry ? (JSON.parse(r.geometry as string) as Geometry) : null,
      bbox: r.minx != null ? ([r.minx, r.miny, r.maxx, r.maxy] as BBox) : null,
      point: r.lon != null ? ([r.lon, r.lat] as [number, number]) : null,
      countries: (r.countries as string) ? (r.countries as string).split(',') : [],
      occurredAt: r.occurred_at as number | null,
      publishedAt: r.published_at as number | null,
      updatedAt: r.updated_at as number | null,
      fetchedAt: r.fetched_at as number,
      expiresAt: r.expires_at as number | null,
      endedAt: r.ended_at as number | null,
      tStart: r.t_start as number | null,
      tEnd: r.t_end as number | null,
      ongoing: !!r.ongoing,
      severity: r.severity as IntelRecord['severity'],
      severityLabel: r.severity_label as string | null,
      confidence: r.confidence as number | null,
      confidenceBasis: r.confidence_basis as string | null,
      uncertainty: r.uncertainty ? (JSON.parse(r.uncertainty as string) as Record<string, number | string>) : null,
      title: r.title as string,
      description: r.description as string | null,
      attributes: JSON.parse(r.attributes as string) as IntelRecord['attributes'],
      metric: r.metric_name ? { name: r.metric_name as string, value: r.metric_value as number, unit: (r.metric_unit as string) ?? '', period: (r.metric_period as string) ?? undefined } : null,
      url: r.url as string | null,
      attribution: manifest?.attribution ?? '',
      licenseUrl: manifest?.license.url ?? '',
      provenance: {
        sourceId: r.source_id as string,
        provider: prov.provider ?? manifest?.provider ?? '',
        dataset: prov.dataset ?? manifest?.dataset ?? '',
        adapterVersion: prov.adapterVersion ?? '',
        fetchUrls: prov.fetchUrls ?? [],
        fetchedAt: r.fetched_at as number,
        firstSeenAt: r.first_seen_at as number,
        revision: r.revision as number,
        contentHash: r.content_hash as string,
        derived: prov.derived ?? [],
        fixture: !!r.is_fixture,
        normalisation: prov.normalisation ?? [],
      },
      freshness: layer ? freshnessOf(slim, layer, ctx.health.get(r.source_id as string)?.dataIsStale ?? false, ctx.now) : ('aging' as Freshness),
      track: r.track ? (JSON.parse(r.track as string) as [number, number, number][]) : null,
      incident: this.incidentOf(id),
    };
    return rec;
  }

  private incidentOf(recordId: string): unknown {
    const m = this.db.get<{ incident_id: string; basis: string }>('SELECT incident_id, basis FROM incident_members WHERE record_id = ?', recordId);
    if (!m) return null;
    const inc = this.db.get<Record<string, unknown>>('SELECT * FROM incidents WHERE incident_id = ?', m.incident_id);
    const members = this.db.all<{ id: string; title: string; source_id: string; layer_id: string; t_start: number | null; basis: string }>(
      `SELECT r.id, r.title, r.source_id, r.layer_id, r.t_start, im.basis FROM incident_members im JOIN records r ON r.id = im.record_id WHERE im.incident_id = ? ORDER BY r.t_start LIMIT 40`,
      m.incident_id,
    );
    return {
      id: m.incident_id,
      class: inc?.class,
      sourceCount: inc?.source_count,
      memberCount: inc?.member_count,
      note: 'Automated correlation: these independent reports possibly describe the same incident. This association is an inference by this application, not a statement by any source.',
      basis: JSON.parse(m.basis) as unknown,
      members: members.filter((x) => x.id !== recordId).map((x) => ({ id: x.id, title: x.title, sourceId: x.source_id, layerId: x.layer_id, time: x.t_start, basis: JSON.parse(x.basis) as unknown })),
    };
  }

  /** Record counts per layer and per source, for the catalog and the source inventory. */
  inventory(): { byLayer: Record<string, number>; bySource: Record<string, number>; total: number } {
    const byLayer: Record<string, number> = {};
    const bySource: Record<string, number> = {};
    let total = 0;
    for (const r of this.db.all<{ layer_id: string; source_id: string; n: number }>('SELECT layer_id, source_id, COUNT(*) AS n FROM records GROUP BY layer_id, source_id')) {
      byLayer[r.layer_id] = (byLayer[r.layer_id] ?? 0) + r.n;
      bySource[r.source_id] = (bySource[r.source_id] ?? 0) + r.n;
      total += r.n;
    }
    return { byLayer, bySource, total };
  }
}

function round5(n: number): number {
  return Math.round(n * 1e5) / 1e5;
}
