import { defineAdapter, isObject, jsonPayload, loadManifest, ParseCollector, severityFromThresholds } from '../base.ts';
import { pointGeometry } from '../../core/geo.ts';
import { num, str } from '../../core/text.ts';
import { fromEpochMillis } from '../../core/time.ts';
import type { RecordDraft, Severity } from '../../core/types.ts';
import manifestJson from './manifest.json' with { type: 'json' };

const manifest = loadManifest(manifestJson);
const BASE = 'https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary';

const ALERT_SEVERITY: Record<string, Severity> = { green: 1, yellow: 2, orange: 3, red: 4 };

interface UsgsFeature {
  id?: unknown;
  properties?: Record<string, unknown>;
  geometry?: { type?: string; coordinates?: unknown[] } | null;
}

export default defineAdapter({
  manifest,
  version: '1.0.0',

  async fetch(ctx) {
    return [
      await ctx.http.get(`${BASE}/2.5_week.geojson`, { key: '2.5_week' }),
      // The 30-day M4.5+ file changes slowly; revalidate at most every 15 minutes.
      await ctx.http.get(`${BASE}/4.5_month.geojson`, { key: '4.5_month', cacheTtlSec: 900 }),
    ];
  },

  parse(payloads) {
    const out = new ParseCollector();
    const seen = new Set<string>();
    for (const payload of payloads) {
      const fc = jsonPayload<{ metadata?: { generated?: unknown }; features: UsgsFeature[] }>(
        payload,
        (v) => isObject(v) && v.type === 'FeatureCollection' && Array.isArray(v.features),
        'USGS GeoJSON feed',
      );
      out.noteUpstreamTime(fromEpochMillis(fc.metadata?.generated));
      for (const f of fc.features) {
        out.item(f, (x) => `${String(x?.id)} ${String(x?.properties?.title ?? '')}`, (feature): RecordDraft | RecordDraft[] | string => {
          const p = feature.properties;
          const id = str(feature.id);
          if (!id || !isObject(p)) return 'missing id or properties';
          if (seen.has(id)) return []; // same event present in both feeds
          const coords = feature.geometry?.coordinates;
          const geometry = Array.isArray(coords) ? pointGeometry(coords[0], coords[1]) : null;
          if (!geometry) return 'missing or invalid coordinates';
          const occurredAt = fromEpochMillis(p.time);
          if (occurredAt == null) return 'missing origin time';
          if (p.status === 'deleted') return 'event deleted by USGS';
          seen.add(id);

          const mag = num(p.mag);
          const depthKm = num(coords?.[2]);
          const alert = str(p.alert)?.toLowerCase() ?? null;
          const magSeverity = severityFromThresholds(mag, [4, 5, 6, 7]);
          const alertSeverity = alert ? (ALERT_SEVERITY[alert] ?? null) : null;
          const severity = magSeverity == null && alertSeverity == null ? null : (Math.max(magSeverity ?? 0, alertSeverity ?? 0) as Severity);
          const status = str(p.status);
          const type = str(p.type) ?? 'earthquake';

          return {
            upstreamId: id,
            layerId: 'earthquakes',
            subcategory: type,
            geometry,
            occurredAt,
            updatedAt: fromEpochMillis(p.updated),
            severity,
            severityLabel: mag != null ? `M ${mag.toFixed(1)}${alert ? ` · PAGER ${alert}` : ''}` : alert ? `PAGER ${alert}` : null,
            confidence: status === 'reviewed' ? 0.95 : status === 'automatic' ? 0.7 : null,
            confidenceBasis: status ? `USGS review status: ${status}` : null,
            uncertainty: {
              ...(num(p.rms) != null ? { travelTimeRmsSec: num(p.rms)! } : {}),
              ...(num(p.gap) != null ? { azimuthalGapDeg: num(p.gap)! } : {}),
              ...(num(p.dmin) != null ? { nearestStationDeg: num(p.dmin)! } : {}),
            },
            title: str(p.title) ?? `M ${mag ?? '?'} ${type}${p.place ? ` – ${String(p.place)}` : ''}`,
            description: str(p.place) ? `${type === 'earthquake' ? 'Earthquake' : type} ${String(p.place)}${depthKm != null ? `, depth ${depthKm.toFixed(1)} km` : ''}.` : null,
            attributes: {
              magnitude: mag,
              magnitudeType: str(p.magType),
              depthKm,
              place: str(p.place),
              reviewStatus: status,
              pagerAlert: alert,
              tsunamiFlag: p.tsunami === 1,
              feltReports: num(p.felt),
              maxReportedIntensityCdi: num(p.cdi),
              maxInstrumentalIntensityMmi: num(p.mmi),
              significance: num(p.sig),
              network: str(p.net),
              stationsUsed: num(p.nst),
              eventType: type,
            },
            url: str(p.url, 300),
            derived: ['severity', 'confidence'],
          };
        });
      }
    }
    return out.done();
  },
});
