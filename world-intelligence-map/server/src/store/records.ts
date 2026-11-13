/**
 * Write side of the record store: idempotent upserts keyed by stable id, full-snapshot bookkeeping,
 * track accumulation for moving objects, retention, plus the small tables used by the pipeline
 * (source state, ingest runs, cursors, HTTP body cache).
 */
import type { Catalog } from '../core/catalog.ts';
import { countryByIso3 } from '../core/countries.ts';
import type { IntelRecord, RejectedItem } from '../core/types.ts';
import type { CachedBody, HttpCacheStore } from '../http/client.ts';
import type { Db } from './db.ts';

export interface UpsertCounts {
  inserted: number;
  updated: number;
  unchanged: number;
}

const TRACK_MAX_POINTS = 240;
const TRACK_MAX_AGE_MS = 6 * 3_600_000;

interface ExistingRow {
  rowid: number;
  content_hash: string;
  revision: number;
  track: string | null;
  t_end: number | null;
  ended_at: number | null;
  minx: number | null;
}

function ftsExtra(r: IntelRecord, layerName: string): string {
  const parts: string[] = [layerName, r.category, r.subcategory ?? '', r.sourceId];
  for (const iso of r.countries) {
    parts.push(iso);
    const c = countryByIso3(iso);
    if (c) parts.push(c.name);
  }
  let budget = 600;
  for (const v of Object.values(r.attributes)) {
    if (typeof v === 'string' && v.length < 120 && budget > 0) {
      parts.push(v);
      budget -= v.length;
    }
  }
  return parts.join(' ');
}

export class RecordStore {
  constructor(readonly db: Db, readonly catalog: Catalog) {}

  /**
   * Insert or update records. Idempotent: re-ingesting identical content only refreshes fetch bookkeeping.
   * `runId` marks every record listed by this run (used to end records that vanished from full snapshots).
   */
  upsertMany(records: IntelRecord[], runId: number): UpsertCounts & { changedLayers: Set<string> } {
    const counts = { inserted: 0, updated: 0, unchanged: 0, changedLayers: new Set<string>() };
    if (!records.length) return counts;
    const db = this.db;
    const selectExisting = db.prepare('SELECT rowid, content_hash, revision, track, t_end, ended_at, minx FROM records WHERE id = ?');
    const insert = db.prepare(`INSERT INTO records (
        id, upstream_id, source_id, layer_id, domain, category, subcategory, geom_kind, geometry, lon, lat, minx, miny, maxx, maxy,
        countries, country, occurred_at, published_at, updated_at, fetched_at, first_seen_at, expires_at, t_start, t_end, ongoing, ended_at,
        severity, severity_label, confidence, confidence_basis, uncertainty, title, description, attributes,
        metric_name, metric_value, metric_unit, metric_period, url, provenance, content_hash, revision, seen_run, track, is_fixture
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,NULL,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,1,?,?,?) RETURNING rowid`);
    const update = db.writer(`UPDATE records SET
        layer_id=?, domain=?, category=?, subcategory=?, geom_kind=?, geometry=?, lon=?, lat=?, minx=?, miny=?, maxx=?, maxy=?,
        countries=?, country=?, occurred_at=?, published_at=?, updated_at=?, fetched_at=?, expires_at=?, t_start=?, t_end=?, ongoing=?, ended_at=NULL,
        severity=?, severity_label=?, confidence=?, confidence_basis=?, uncertainty=?, title=?, description=?, attributes=?,
        metric_name=?, metric_value=?, metric_unit=?, metric_period=?, url=?, provenance=?, content_hash=?, revision=?, seen_run=?, track=?
      WHERE rowid=?`);
    const touch = db.writer('UPDATE records SET fetched_at = MAX(fetched_at, ?), t_end = ?, ended_at = NULL, seen_run = ? WHERE rowid = ?');
    const rtreeInsert = db.writer('INSERT INTO records_rtree(rowid, minx, maxx, miny, maxy) VALUES (?,?,?,?,?)');
    const rtreeDelete = db.writer('DELETE FROM records_rtree WHERE rowid = ?');
    const ftsInsert = db.writer('INSERT INTO records_fts(rowid, title, description, extra) VALUES (?,?,?,?)');
    const ftsDelete = db.writer('DELETE FROM records_fts WHERE rowid = ?');

    db.transaction(() => {
      for (const r of records) {
        const layer = this.catalog.layer(r.layerId);
        const existing = selectExisting.get(r.id) as ExistingRow | undefined;
        const bbox = r.bbox;
        const prov = JSON.stringify({
          provider: r.provenance.provider,
          dataset: r.provenance.dataset,
          adapterVersion: r.provenance.adapterVersion,
          fetchUrls: r.provenance.fetchUrls,
          derived: r.provenance.derived,
          normalisation: r.provenance.normalisation,
        });

        // Moving objects: accumulate the recent path.
        let track: string | null = existing?.track ?? null;
        if (layer?.render.type === 'track' && r.geometry?.type === 'Point' && r.point && r.tStart != null) {
          let pts: [number, number, number][] = [];
          if (track) {
            try {
              pts = JSON.parse(track) as [number, number, number][];
            } catch {
              pts = [];
            }
          }
          const last = pts[pts.length - 1];
          if (!last || (r.tStart > last[2] && (last[0] !== r.point[0] || last[1] !== r.point[1]))) {
            pts.push([r.point[0], r.point[1], r.tStart]);
          }
          const cutoff = r.tStart - TRACK_MAX_AGE_MS;
          pts = pts.filter((p) => p[2] >= cutoff).slice(-TRACK_MAX_POINTS);
          track = JSON.stringify(pts);
        }

        if (!existing) {
          const res = insert.get(
            r.id, r.upstreamId, r.sourceId, r.layerId, r.domain, r.category, r.subcategory, r.geometryKind,
            r.geometry ? JSON.stringify(r.geometry) : null, r.point?.[0] ?? null, r.point?.[1] ?? null,
            bbox?.[0] ?? null, bbox?.[1] ?? null, bbox?.[2] ?? null, bbox?.[3] ?? null,
            r.countries.join(','), r.countries[0] ?? null, r.occurredAt, r.publishedAt, r.updatedAt, r.fetchedAt, r.fetchedAt, r.expiresAt,
            r.tStart, r.tEnd, r.ongoing ? 1 : 0,
            r.severity, r.severityLabel, r.confidence, r.confidenceBasis, r.uncertainty ? JSON.stringify(r.uncertainty) : null,
            r.title, r.description, JSON.stringify(r.attributes),
            r.metric?.name ?? null, r.metric?.value ?? null, r.metric?.unit ?? null, r.metric?.period ?? null,
            r.url, prov, r.provenance.contentHash, runId, track, r.provenance.fixture ? 1 : 0,
          );
          const rowid = Number((res as { rowid: number }).rowid);
          if (bbox) rtreeInsert(rowid, bbox[0], bbox[2], bbox[1], bbox[3]);
          ftsInsert(rowid, r.title, r.description ?? '', ftsExtra(r, layer?.name ?? ''));
          counts.inserted++;
          counts.changedLayers.add(r.layerId);
        } else if (existing.content_hash === r.provenance.contentHash) {
          // Unchanged content: refresh "last confirmed" bookkeeping only. Ongoing intervals extend to this fetch.
          const tEnd = r.ongoing ? Math.max(existing.t_end ?? 0, r.tEnd ?? 0) : r.tEnd;
          touch(r.fetchedAt, tEnd, runId, existing.rowid);
          counts.unchanged++;
          if (existing.ended_at != null) counts.changedLayers.add(r.layerId);
        } else {
          update(
            r.layerId, r.domain, r.category, r.subcategory, r.geometryKind,
            r.geometry ? JSON.stringify(r.geometry) : null, r.point?.[0] ?? null, r.point?.[1] ?? null,
            bbox?.[0] ?? null, bbox?.[1] ?? null, bbox?.[2] ?? null, bbox?.[3] ?? null,
            r.countries.join(','), r.countries[0] ?? null, r.occurredAt, r.publishedAt, r.updatedAt, r.fetchedAt, r.expiresAt,
            r.tStart, r.tEnd, r.ongoing ? 1 : 0,
            r.severity, r.severityLabel, r.confidence, r.confidenceBasis, r.uncertainty ? JSON.stringify(r.uncertainty) : null,
            r.title, r.description, JSON.stringify(r.attributes),
            r.metric?.name ?? null, r.metric?.value ?? null, r.metric?.unit ?? null, r.metric?.period ?? null,
            r.url, prov, r.provenance.contentHash, existing.revision + 1, runId, track, existing.rowid,
          );
          if (existing.minx != null) rtreeDelete(existing.rowid);
          if (bbox) rtreeInsert(existing.rowid, bbox[0], bbox[2], bbox[1], bbox[3]);
          ftsDelete(existing.rowid);
          ftsInsert(existing.rowid, r.title, r.description ?? '', ftsExtra(r, layer?.name ?? ''));
          counts.updated++;
          counts.changedLayers.add(r.layerId);
        }
      }
    });
    return counts;
  }

  /**
   * Full-snapshot sources: records of this source that the latest complete run no longer listed.
   *  - reference layers: deleted (the reference set is replaced)
   *  - everything else: marked ended (kept for history until retention removes them)
   */
  endMissing(sourceId: string, runId: number, now: number): { ended: number; layers: Set<string> } {
    const layers = new Set<string>();
    let ended = 0;
    this.db.transaction(() => {
      for (const layer of this.catalog.layersOfSource(sourceId)) {
        if (layer.timeModel === 'reference') {
          const n = this.deleteWhere('layer_id = ? AND seen_run < ?', layer.id, runId);
          if (n) layers.add(layer.id);
          ended += n;
        } else {
          const res = this.db.run(
            'UPDATE records SET ended_at = ?, ongoing = 0, t_end = MIN(COALESCE(t_end, ?), ?) WHERE layer_id = ? AND seen_run < ? AND ended_at IS NULL',
            now, now, now, layer.id, runId,
          );
          if (res.changes) layers.add(layer.id);
          ended += res.changes;
        }
      }
    });
    return { ended, layers };
  }

  private deleteWhere(where: string, ...params: (string | number)[]): number {
    const rows = this.db.all<{ rowid: number }>(`SELECT rowid FROM records WHERE ${where}`, ...params);
    if (!rows.length) return 0;
    const delR = this.db.writer('DELETE FROM records WHERE rowid = ?');
    const delT = this.db.writer('DELETE FROM records_rtree WHERE rowid = ?');
    const delF = this.db.writer('DELETE FROM records_fts WHERE rowid = ?');
    const delM = this.db.writer('DELETE FROM incident_members WHERE record_id = (SELECT id FROM records WHERE rowid = ?)');
    for (const { rowid } of rows) {
      delM(rowid);
      delF(rowid);
      delT(rowid);
      delR(rowid);
    }
    return rows.length;
  }

  /**
   * Explicit retention rules. Per layer: records whose end time (or start time) is older than `retentionDays`
   * are purged; `null` means reference data kept while upstream lists it. Also trims operational tables.
   */
  applyRetention(now: number): { deleted: number; byLayer: Record<string, number> } {
    const byLayer: Record<string, number> = {};
    let deleted = 0;
    this.db.transaction(() => {
      for (const layer of this.catalog.layers.values()) {
        if (layer.retentionDays == null) continue;
        const cutoff = now - layer.retentionDays * 86_400_000;
        const n = this.deleteWhere(
          't_start IS NOT NULL AND layer_id = ? AND MAX(COALESCE(t_end, t_start), COALESCE(ended_at, 0), CASE WHEN ongoing = 1 AND ended_at IS NULL THEN fetched_at ELSE 0 END) < ?',
          layer.id, cutoff,
        );
        if (n) byLayer[layer.id] = n;
        deleted += n;
      }
      // Records of layers that no longer exist in the catalog (adapter removed).
      const known = [...this.catalog.layers.keys()];
      if (known.length) {
        const orphan = this.deleteWhere(`layer_id NOT IN (${known.map(() => '?').join(',')})`, ...known);
        if (orphan) byLayer['(orphaned)'] = orphan;
        deleted += orphan;
      }
      this.db.run('DELETE FROM ingest_runs WHERE started_at < ?', now - 14 * 86_400_000);
      this.db.run('DELETE FROM http_cache WHERE validated_at < ?', now - 30 * 86_400_000);
      this.db.run('DELETE FROM incidents WHERE incident_id NOT IN (SELECT DISTINCT incident_id FROM incident_members)');
    });
    return { deleted, byLayer };
  }

  count(where = '1=1', ...params: (string | number)[]): number {
    return this.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM records WHERE ${where}`, ...params)!.n;
  }

  // ── cursors ──
  cursor(sourceId: string): { get(key: string): string | null; set(key: string, value: string): void } {
    return {
      get: (key) => this.db.get<{ value: string }>('SELECT value FROM source_cursor WHERE source_id = ? AND key = ?', sourceId, key)?.value ?? null,
      set: (key, value) => void this.db.run('INSERT INTO source_cursor(source_id, key, value) VALUES (?,?,?) ON CONFLICT(source_id, key) DO UPDATE SET value = excluded.value', sourceId, key, value),
    };
  }

  // ── ingest run log ──
  startRun(sourceId: string, startedAt: number): number {
    return this.db.get<{ run_id: number }>("INSERT INTO ingest_runs(source_id, started_at, outcome) VALUES (?, ?, 'running') RETURNING run_id", sourceId, startedAt)!.run_id;
  }
  finishRun(runId: number, f: { finishedAt: number; outcome: string; inserted?: number; updated?: number; unchanged?: number; ended?: number; rejected?: RejectedItem[]; error?: string | null; httpEvents?: string[] }): void {
    this.db.run(
      'UPDATE ingest_runs SET finished_at=?, outcome=?, inserted=?, updated=?, unchanged=?, ended=?, rejected=?, reject_samples=?, error=?, http_events=? WHERE run_id=?',
      f.finishedAt, f.outcome, f.inserted ?? 0, f.updated ?? 0, f.unchanged ?? 0, f.ended ?? 0, f.rejected?.length ?? 0,
      f.rejected?.length ? JSON.stringify(f.rejected.slice(0, 8)) : null, f.error ?? null, f.httpEvents?.length ? JSON.stringify(f.httpEvents.slice(-12)) : null, runId,
    );
  }
  recentRuns(sourceId: string, limit = 10): Record<string, unknown>[] {
    return this.db.all('SELECT * FROM ingest_runs WHERE source_id = ? ORDER BY run_id DESC LIMIT ?', sourceId, limit);
  }

  getMeta(key: string): string | null {
    return this.db.get<{ value: string }>('SELECT value FROM meta WHERE key = ?', key)?.value ?? null;
  }
  setMeta(key: string, value: string): void {
    this.db.run('INSERT INTO meta(key, value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', key, value);
  }
}

/** HTTP body cache persisted in SQLite so conditional requests and stale-if-error survive restarts. */
export class SqliteHttpCache implements HttpCacheStore {
  constructor(private readonly db: Db) {}
  get(key: string): CachedBody | null {
    const r = this.db.get<{ url: string; status: number; content_type: string | null; etag: string | null; last_modified: string | null; fetched_at: number; validated_at: number; body: Uint8Array }>(
      'SELECT url, status, content_type, etag, last_modified, fetched_at, validated_at, body FROM http_cache WHERE cache_key = ?', key,
    );
    if (!r) return null;
    return { url: r.url, status: r.status, contentType: r.content_type, etag: r.etag, lastModified: r.last_modified, fetchedAt: r.fetched_at, validatedAt: r.validated_at, body: Buffer.from(r.body) };
  }
  set(key: string, v: CachedBody): void {
    this.db.run(
      `INSERT INTO http_cache(cache_key, url, status, content_type, etag, last_modified, fetched_at, validated_at, body) VALUES (?,?,?,?,?,?,?,?,?)
       ON CONFLICT(cache_key) DO UPDATE SET url=excluded.url, status=excluded.status, content_type=excluded.content_type, etag=excluded.etag,
         last_modified=excluded.last_modified, fetched_at=excluded.fetched_at, validated_at=excluded.validated_at, body=excluded.body`,
      key, v.url, v.status, v.contentType, v.etag, v.lastModified, v.fetchedAt, v.validatedAt, v.body,
    );
  }
}
