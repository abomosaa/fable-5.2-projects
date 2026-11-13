import type { Geometry, Position } from 'geojson';
import { defineAdapter, loadManifest, ParseCollector, severityFromThresholds } from '../base.ts';
import { lineGeometry, pointGeometry } from '../../core/geo.ts';
import { num, parseCsv, str } from '../../core/text.ts';
import { parseTime } from '../../core/time.ts';
import type { RecordDraft } from '../../core/types.ts';
import manifestJson from './manifest.json' with { type: 'json' };

const manifest = loadManifest(manifestJson);
const CSV_URL = 'https://www.ncei.noaa.gov/data/international-best-track-archive-for-climate-stewardship-ibtracs/v04r01/access/csv/ibtracs.ACTIVE.list.v04r01.csv';

const REQUIRED_COLUMNS = ['SID', 'SEASON', 'BASIN', 'NAME', 'ISO_TIME', 'LAT', 'LON'] as const;

const BASINS: Record<string, string> = {
  NA: 'North Atlantic',
  EP: 'Eastern North Pacific',
  WP: 'Western North Pacific',
  NI: 'North Indian Ocean',
  SI: 'South Indian Ocean',
  SP: 'South Pacific',
  SA: 'South Atlantic',
};

interface Fix {
  at: number;
  position: Position;
  windKt: number | null;
  pressureMb: number | null;
}
interface Storm {
  sid: string;
  first: string[]; // first row seen for the storm (static columns)
  last: string[];
  fixes: Fix[];
  agencies: Set<string>;
  trackTypes: Set<string>;
  basins: string[];
  atcfId: string | null;
}

export default defineAdapter({
  manifest,
  version: '1.0.0',

  async fetch(ctx) {
    return [await ctx.http.get(CSV_URL, { key: 'active' })];
  },

  parse(payloads) {
    const out = new ParseCollector();
    for (const payload of payloads) {
      const rows = parseCsv(payload.text());
      const header = rows[0]?.map((h) => h.trim()) ?? [];
      const col = new Map(header.map((name, i) => [name, i] as const));
      const missing = REQUIRED_COLUMNS.filter((c) => !col.has(c));
      if (missing.length) throw new Error(`malformed IBTrACS CSV: missing column(s) ${missing.join(', ')} (${payload.key})`);
      out.noteUpstreamTime(parseTime(payload.lastModified));
      const cell = (row: string[], name: string): string => {
        const i = col.get(name);
        return i == null ? '' : (row[i] ?? '').trim();
      };

      // Group the fixes by storm id (SID). Individually broken fixes are rejected; the storm keeps its other fixes.
      const storms = new Map<string, Storm>();
      for (let r = 1; r < rows.length; r++) {
        const row = rows[r]!;
        const sid = cell(row, 'SID');
        const isoTime = cell(row, 'ISO_TIME');
        if (!sid && !isoTime) continue; // the second header row (units) and blank lines
        if (!sid) {
          out.reject('fix without storm id (SID)', `line ${r + 1} ${cell(row, 'NAME')} ${isoTime}`);
          continue;
        }
        const sample = `${sid} ${cell(row, 'NAME')} ${isoTime}`;
        const at = parseTime(isoTime); // "YYYY-MM-DD HH:mm:ss", UTC
        if (at == null) {
          out.reject('fix with missing or unparseable ISO_TIME', sample);
          continue;
        }
        const pt = pointGeometry(cell(row, 'LON'), cell(row, 'LAT'));
        if (pt?.type !== 'Point') {
          out.reject('fix with missing or invalid coordinates', sample);
          continue;
        }
        let storm = storms.get(sid);
        if (!storm) {
          storm = { sid, first: row, last: row, fixes: [], agencies: new Set(), trackTypes: new Set(), basins: [], atcfId: null };
          storms.set(sid, storm);
        }
        storm.last = row;
        storm.fixes.push({
          at,
          position: pt.coordinates,
          // WMO-sanctioned value when present, otherwise the U.S. agency value (provisional tracks only have the latter).
          windKt: num(cell(row, 'WMO_WIND')) ?? num(cell(row, 'USA_WIND')),
          pressureMb: num(cell(row, 'WMO_PRES')) ?? num(cell(row, 'USA_PRES')),
        });
        for (const a of [cell(row, 'WMO_AGENCY'), cell(row, 'USA_AGENCY')]) if (a) storm.agencies.add(a);
        const trackType = cell(row, 'TRACK_TYPE');
        if (trackType) storm.trackTypes.add(trackType);
        storm.atcfId = cell(row, 'USA_ATCF_ID') || storm.atcfId;
        const basin = cell(row, 'BASIN');
        if (basin && !storm.basins.includes(basin)) storm.basins.push(basin);
      }

      for (const storm of storms.values()) {
        out.item(storm, (s) => `${s.sid} ${cell(s.first, 'NAME')}`, (s): RecordDraft | string => {
          const fixes = s.fixes.slice().sort((a, b) => a.at - b.at);
          const first = fixes[0]!;
          const last = fixes[fixes.length - 1]!;
          const positions: Position[] = [];
          for (const f of fixes) {
            const prev = positions[positions.length - 1];
            if (!prev || prev[0] !== f.position[0] || prev[1] !== f.position[1]) positions.push(f.position);
          }
          let geometry: Geometry | null;
          if (positions.length === 1) geometry = { type: 'Point', coordinates: positions[0]! };
          else geometry = lineGeometry(positions); // split where the track crosses the antimeridian
          if (!geometry) return 'track has no usable positions';

          let maxWindKt: number | null = null;
          let minPressureMb: number | null = null;
          for (const f of fixes) {
            if (f.windKt != null && f.windKt > 0 && (maxWindKt == null || f.windKt > maxWindKt)) maxWindKt = f.windKt;
            if (f.pressureMb != null && f.pressureMb > 0 && (minPressureMb == null || f.pressureMb < minPressureMb)) minPressureMb = f.pressureMb;
          }
          const rawName = str(cell(s.first, 'NAME'), 80);
          const named = rawName != null && !/^(UNNAMED|NOT_NAMED)$/i.test(rawName);
          const season = num(cell(s.first, 'SEASON'));
          const basin = s.basins[0] ?? null;
          const basinName = basin ? (BASINS[basin] ?? basin) : null;
          const severity = severityFromThresholds(maxWindKt, [0, 34, 64, 96]);

          return {
            upstreamId: s.sid,
            layerId: 'cyclone-tracks',
            geometry,
            geometryKind: positions.length === 1 ? 'point' : 'track',
            occurredAt: first.at,
            updatedAt: last.at,
            endedAt: last.at,
            severity,
            severityLabel: maxWindKt != null ? `max wind ${maxWindKt} kt` : null,
            confidence: null,
            title: `Tropical cyclone ${named ? rawName : `(unnamed) ${s.sid}`}${season != null || basinName ? ` (${[season, basinName].filter((x) => x != null).join(', ')})` : ''}`,
            description:
              `Track of ${fixes.length} fixes from ${new Date(first.at).toISOString().slice(0, 16).replace('T', ' ')} to ${new Date(last.at).toISOString().slice(0, 16).replace('T', ' ')} UTC` +
              `${maxWindKt != null ? `; peak sustained wind ${maxWindKt} kt` : ''}${minPressureMb != null ? `; minimum pressure ${minPressureMb} mb` : ''}.`,
            attributes: {
              sid: s.sid,
              name: rawName,
              basin,
              basinName,
              basinsCrossed: s.basins.length > 1 ? s.basins.join(', ') : null,
              season,
              maxWindKt,
              minPressureMb,
              fixes: fixes.length,
              agency: [...s.agencies].join(', ') || null,
              trackType: [...s.trackTypes].join(', ') || null,
              atcfId: s.atcfId,
              latestNature: str(cell(s.last, 'NATURE')),
              latestLongitude: last.position[0],
              latestLatitude: last.position[1],
              latestWindKt: last.windKt,
              latestDistanceToLandKm: num(cell(s.last, 'DIST2LAND')),
            },
            url: `https://ncics.org/ibtracs/index.php?name=v04r01-${encodeURIComponent(s.sid)}`,
            derived: severity != null ? ['severity'] : [],
          };
        });
      }
    }
    return out.done();
  },
});
