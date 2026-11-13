/**
 * Conservative cross-source incident correlation.
 *
 * Records from DIFFERENT sources that share a correlation class and fall within tight, class-specific
 * space/time (and where available magnitude/name) tolerances are linked into a possible incident.
 * Original records are never merged, modified or hidden – the link is stored separately with its basis,
 * and is always presented to users as an automated, unconfirmed association.
 */
import type { Catalog } from '../core/catalog.ts';
import { haversineKm } from '../core/geo.ts';
import { sha256 } from '../core/text.ts';
import type { Db } from '../store/db.ts';

export type CorrelationClass = 'earthquake' | 'tropical_cyclone' | 'wildfire' | 'volcano' | 'flood' | 'drought' | 'outage';

interface Row {
  id: string;
  source_id: string;
  layer_id: string;
  lon: number | null;
  lat: number | null;
  country: string | null;
  t_start: number;
  t_end: number | null;
  ongoing: number;
  ended_at: number | null;
  title: string;
  attributes: string;
}

interface Candidate extends Row {
  start: number;
  end: number;
  mag: number | null;
  names: Set<string>;
}

export interface Rule {
  description: string;
  /** Maximum gap between the two records' time intervals. */
  maxGapMs: number;
  maxKm: number | null;
  match(a: Candidate, b: Candidate, distanceKm: number | null): boolean;
}

const HOUR = 3_600_000;
const DAY = 86_400_000;

const STORM_STOPWORDS = new Set([
  'TROPICAL', 'STORM', 'CYCLONE', 'HURRICANE', 'TYPHOON', 'DEPRESSION', 'SUPER', 'SEVERE', 'POST', 'POTENTIAL', 'REMNANTS', 'SUBTROPICAL', 'EXTRATROPICAL',
  'MAJOR', 'THE', 'OF', 'IN', 'TC', 'TS', 'TD', 'HU', 'STS', 'LOW', 'INVEST', 'UNNAMED', 'NOT', 'NAMED', 'CATEGORY', 'CAT', 'GDACS', 'ALERT', 'GREEN', 'ORANGE', 'RED', 'FOR', 'AND',
]);

export function stormNames(title: string, attrs: Record<string, unknown>): Set<string> {
  const out = new Set<string>();
  const add = (s: unknown) => {
    if (typeof s !== 'string') return;
    for (const tok of s.toUpperCase().split(/[^A-Z0-9]+/)) {
      if (tok.length < 3 || STORM_STOPWORDS.has(tok)) continue;
      // Drop trailing year suffixes such as PENA-26 / FENGSHEN-25 (tokenised separately as numbers).
      if (/^\d+$/.test(tok)) continue;
      out.add(tok);
    }
  };
  add(attrs.name);
  add(attrs.stormName);
  add(title);
  return out;
}

export const RULES: Record<CorrelationClass, Rule> = {
  earthquake: {
    description: 'origin times within 120 s, epicentres within 100 km, magnitudes within 0.6',
    maxGapMs: 120_000,
    maxKm: 100,
    match: (a, b) => a.mag == null || b.mag == null || Math.abs(a.mag - b.mag) <= 0.6,
  },
  tropical_cyclone: {
    description: 'same storm name or designator, active periods within 2 days, positions within 1,500 km',
    maxGapMs: 2 * DAY,
    maxKm: 1500,
    match: (a, b) => [...a.names].some((n) => b.names.has(n)),
  },
  wildfire: { description: 'active periods within 2 days, locations within 25 km', maxGapMs: 2 * DAY, maxKm: 25, match: () => true },
  volcano: { description: 'reports within 10 days, locations within 30 km', maxGapMs: 10 * DAY, maxKm: 30, match: () => true },
  flood: {
    description: 'same country, active periods within 3 days, locations within 250 km',
    maxGapMs: 3 * DAY,
    maxKm: 250,
    match: (a, b) => !!a.country && a.country === b.country,
  },
  drought: { description: 'same country, overlapping active periods', maxGapMs: 0, maxKm: null, match: (a, b) => !!a.country && a.country === b.country },
  outage: { description: 'same country, outage periods within 2 hours', maxGapMs: 2 * HOUR, maxKm: null, match: (a, b) => !!a.country && a.country === b.country },
};

function gap(a: Candidate, b: Candidate): number {
  if (a.start <= b.end && b.start <= a.end) return 0;
  return a.start > b.end ? a.start - b.end : b.start - a.end;
}

export interface CorrelationResult {
  incidents: number;
  linkedRecords: number;
}

/** Recompute all incidents of one class from scratch (idempotent). Only records from the last `lookbackDays` are considered. */
export function correlateClass(db: Db, catalog: Catalog, cls: CorrelationClass, now: number, lookbackDays = 60): CorrelationResult {
  const rule = RULES[cls];
  // Dense detection layers (heat maps of individual satellite detections) are context, not incident reports.
  const layers = [...catalog.layers.values()].filter((l) => l.correlationClass === cls && l.render.type !== 'heatmap').map((l) => l.id);
  const clear = () => {
    db.run('DELETE FROM incident_members WHERE incident_id IN (SELECT incident_id FROM incidents WHERE class = ?)', cls);
    db.run('DELETE FROM incidents WHERE class = ?', cls);
  };
  if (new Set(layers.map((l) => catalog.layer(l)!.sourceId)).size < 2) {
    db.transaction(clear);
    return { incidents: 0, linkedRecords: 0 };
  }
  const rows = db.all<Row>(
    `SELECT id, source_id, layer_id, lon, lat, country, t_start, t_end, ongoing, ended_at, title, attributes FROM records
     WHERE layer_id IN (${layers.map(() => '?').join(',')}) AND t_start IS NOT NULL AND COALESCE(t_end, t_start) >= ? ORDER BY t_start`,
    ...layers, now - lookbackDays * DAY,
  );
  const cands: Candidate[] = rows.map((r) => {
    let attrs: Record<string, unknown> = {};
    try {
      attrs = JSON.parse(r.attributes) as Record<string, unknown>;
    } catch {
      /* ignore */
    }
    const mag = typeof attrs.magnitude === 'number' ? attrs.magnitude : null;
    const end = r.ongoing && r.ended_at == null ? Math.max(now, r.t_end ?? r.t_start) : (r.t_end ?? r.t_start);
    return { ...r, start: r.t_start, end, mag, names: cls === 'tropical_cyclone' ? stormNames(r.title, attrs) : new Set<string>() };
  });

  // Union-find over candidate pairs.
  const parent = cands.map((_, i) => i);
  const find = (i: number): number => {
    while (parent[i] !== i) {
      parent[i] = parent[parent[i]!]!;
      i = parent[i]!;
    }
    return i;
  };
  const basis = new Map<number, { linkedTo: string; distanceKm: number | null; timeGapSec: number }>();

  // For short-gap classes a sliding window over start-sorted candidates keeps this near-linear.
  const sliding = cls === 'earthquake';
  for (let i = 0; i < cands.length; i++) {
    const a = cands[i]!;
    for (let j = i + 1; j < cands.length; j++) {
      const b = cands[j]!;
      if (sliding && b.start - a.end > rule.maxGapMs) break;
      if (a.source_id === b.source_id) continue;
      const g = gap(a, b);
      if (g > rule.maxGapMs) continue;
      let d: number | null = null;
      if (rule.maxKm != null) {
        if (a.lon == null || a.lat == null || b.lon == null || b.lat == null) continue;
        d = haversineKm([a.lon, a.lat], [b.lon, b.lat]);
        if (d > rule.maxKm) continue;
      }
      if (!rule.match(a, b, d)) continue;
      const ra = find(i);
      const rb = find(j);
      if (ra !== rb) parent[rb] = ra;
      const info = { distanceKm: d == null ? null : Math.round(d * 10) / 10, timeGapSec: Math.round(g / 1000) };
      if (!basis.has(i)) basis.set(i, { linkedTo: b.id, ...info });
      if (!basis.has(j)) basis.set(j, { linkedTo: a.id, ...info });
    }
  }

  const groups = new Map<number, number[]>();
  for (let i = 0; i < cands.length; i++) {
    if (!basis.has(i)) continue;
    const root = find(i);
    let g = groups.get(root);
    if (!g) groups.set(root, (g = []));
    g.push(i);
  }

  let linked = 0;
  db.transaction(() => {
    clear();
    for (const members of groups.values()) {
      const ids = members.map((i) => cands[i]!.id).sort();
      const sources = new Set(members.map((i) => cands[i]!.source_id));
      if (sources.size < 2) continue;
      const incidentId = `inc-${cls}-${sha256(ids[0]!).slice(0, 12)}`;
      const tStart = Math.min(...members.map((i) => cands[i]!.start));
      const tEnd = Math.max(...members.map((i) => cands[i]!.end));
      db.run('INSERT INTO incidents(incident_id, class, member_count, source_count, t_start, t_end, updated_at) VALUES (?,?,?,?,?,?,?)', incidentId, cls, ids.length, sources.size, tStart, tEnd, now);
      for (const i of members) {
        db.run('INSERT INTO incident_members(incident_id, record_id, basis) VALUES (?,?,?)', incidentId, cands[i]!.id, JSON.stringify({ rule: rule.description, ...basis.get(i)! }));
        linked++;
      }
    }
  });
  return { incidents: db.get<{ n: number }>('SELECT COUNT(*) AS n FROM incidents WHERE class = ?', cls)!.n, linkedRecords: linked };
}

export function correlateAll(db: Db, catalog: Catalog, now: number, classes?: Iterable<CorrelationClass>): Record<string, CorrelationResult> {
  const out: Record<string, CorrelationResult> = {};
  for (const cls of classes ?? (Object.keys(RULES) as CorrelationClass[])) out[cls] = correlateClass(db, catalog, cls, now);
  return out;
}
