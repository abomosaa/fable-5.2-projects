import { defineAdapter, loadManifest, ParseCollector } from '../base.ts';
import type { RecordDraft } from '../../core/types.ts';
import manifestJson from './manifest.json' with { type: 'json' };

const manifest = loadManifest(manifestJson);

export const SOURCE = 'VIIRS_NOAA20_NRT';
export const MAX_DETECTIONS = 100_000;
const REQUIRED = ['latitude', 'longitude', 'acq_date', 'acq_time', 'satellite', 'confidence', 'frp'];
const CONFIDENCE: Record<string, [number, string]> = { l: [0.3, 'low'], n: [0.6, 'nominal'], h: [0.9, 'high'] };
const SATELLITE: Record<string, string> = { N: 'Suomi NPP', N20: 'NOAA-20', N21: 'NOAA-21', '1': 'NOAA-20', '2': 'NOAA-21' };

export default defineAdapter({
  manifest,
  version: '1.0.0',

  async fetch(ctx) {
    const key = ctx.env.FIRMS_MAP_KEY!.trim();
    // The key is part of the URL path (documented API design) – it is redacted from logs and provenance.
    return [await ctx.http.get(`https://firms.modaps.eosdis.nasa.gov/api/area/csv/${encodeURIComponent(key)}/${SOURCE}/world/2`, { key: SOURCE, redact: [key] })];
  },

  /**
   * Single pass over the CSV without building intermediate row objects: the live file can hold well over 100,000 rows.
   * FIRMS CSV has no quoted fields.
   */
  parse(payloads) {
    const out = new ParseCollector();
    for (const payload of payloads) {
      const text = payload.text();
      const firstNl = text.indexOf('\n');
      const header = (firstNl < 0 ? text : text.slice(0, firstNl)).trim();
      // Errors are returned as plain text with HTTP 200/400, e.g. "Invalid MAP_KEY." or "Exceeding allowed transaction limit."
      if (!header.includes(',') || !header.toLowerCase().startsWith('latitude,longitude')) {
        throw new Error(`malformed FIRMS response: ${header.slice(0, 80) || 'empty body'}`);
      }
      const cols = header.split(',').map((c) => c.trim().toLowerCase());
      const idx = (name: string) => cols.indexOf(name);
      for (const name of REQUIRED) if (idx(name) < 0) throw new Error(`malformed FIRMS response: column "${name}" missing`);
      const iLat = idx('latitude'), iLon = idx('longitude'), iDate = idx('acq_date'), iTime = idx('acq_time'), iSat = idx('satellite');
      const iConf = idx('confidence'), iFrp = idx('frp'), iT4 = idx('bright_ti4'), iDn = idx('daynight'), iVer = idx('version'), iInst = idx('instrument');

      interface Row { lat: number; lon: number; t: number; frp: number | null; f: string[] }
      const rows: Row[] = [];
      const seen = new Set<string>();
      let pos = firstNl + 1;
      const n = text.length;
      while (firstNl >= 0 && pos < n) {
        let end = text.indexOf('\n', pos);
        if (end < 0) end = n;
        const line = text.charCodeAt(end - 1) === 13 ? text.slice(pos, end - 1) : text.slice(pos, end);
        pos = end + 1;
        if (!line) continue;
        const f = line.split(',');
        if (f.length < cols.length) {
          out.reject('row has too few columns', line);
          continue;
        }
        const lat = Number(f[iLat]);
        const lon = Number(f[iLon]);
        if (f[iLat] === '' || f[iLon] === '' || !Number.isFinite(lat) || !Number.isFinite(lon) || lat < -90 || lat > 90 || lon < -180 || lon > 180) {
          out.reject('missing or invalid coordinates', line);
          continue;
        }
        const d = f[iDate]!;
        const hm = f[iTime]!.padStart(4, '0');
        const hh = Number(hm.slice(0, 2));
        const mm = Number(hm.slice(2, 4));
        const t = /^\d{4}-\d{2}-\d{2}$/.test(d) && /^\d{4}$/.test(hm) && hh < 24 && mm < 60 ? Date.parse(`${d}T${hm.slice(0, 2)}:${hm.slice(2)}:00Z`) : NaN;
        if (!Number.isFinite(t)) {
          out.reject('unparseable acquisition date/time', line);
          continue;
        }
        const id = `${f[iSat]}_${d}_${hm}_${f[iLat]}_${f[iLon]}`;
        if (seen.has(id)) continue; // identical pixel reported twice
        seen.add(id);
        const frp = f[iFrp] === '' ? null : Number(f[iFrp]);
        rows.push({ lat, lon, t, frp: frp != null && Number.isFinite(frp) ? frp : null, f });
      }

      let kept = rows;
      if (rows.length > MAX_DETECTIONS) {
        kept = rows.sort((a, b) => (b.frp ?? 0) - (a.frp ?? 0)).slice(0, MAX_DETECTIONS);
        out.reject(`${rows.length - MAX_DETECTIONS} weaker detections omitted (limit ${MAX_DETECTIONS} per fetch)`);
      }
      for (const r of kept) {
        const f = r.f;
        const d = f[iDate]!;
        const hm = f[iTime]!.padStart(4, '0');
        const conf = CONFIDENCE[f[iConf]!.toLowerCase()];
        const sat = SATELLITE[f[iSat]!] ?? f[iSat]!;
        const draft: RecordDraft = {
          upstreamId: `${f[iSat]}_${d}_${hm}_${f[iLat]}_${f[iLon]}`,
          layerId: 'active-fires',
          geometry: { type: 'Point', coordinates: [r.lon, r.lat] },
          occurredAt: r.t,
          confidence: conf ? conf[0] : null,
          confidenceBasis: conf ? `FIRMS detection confidence class: ${conf[1]}` : null,
          uncertainty: { pixelSizeM: 375 },
          title: `Thermal anomaly (VIIRS ${sat}) ${d} ${hm.slice(0, 2)}:${hm.slice(2)} UTC`,
          attributes: {
            fireRadiativePowerMw: r.frp,
            brightnessTi4K: iT4 >= 0 && f[iT4] !== '' && Number.isFinite(Number(f[iT4])) ? Number(f[iT4]) : null,
            confidenceClass: conf ? conf[1] : f[iConf]!,
            satellite: sat,
            instrument: iInst >= 0 ? f[iInst]! : null,
            dayNight: iDn >= 0 ? (f[iDn] === 'D' ? 'day' : f[iDn] === 'N' ? 'night' : f[iDn]!) : null,
            productVersion: iVer >= 0 ? f[iVer]! : null,
          },
          url: `https://firms.modaps.eosdis.nasa.gov/map/#d:24hrs;@${r.lon.toFixed(2)},${r.lat.toFixed(2)},9.0z`,
          derived: conf ? ['confidence'] : [],
        };
        out.records.push(draft);
        if (out.upstreamTime == null || r.t > out.upstreamTime) out.upstreamTime = r.t;
      }
    }
    return out.done();
  },
});
