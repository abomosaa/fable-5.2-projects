import { defineAdapter, isObject, jsonPayload, loadManifest, ParseCollector } from '../base.ts';
import { pointGeometry } from '../../core/geo.ts';
import { num, str } from '../../core/text.ts';
import { HOUR, iso, parseTime } from '../../core/time.ts';
import type { RecordDraft } from '../../core/types.ts';
import manifestJson from './manifest.json' with { type: 'json' };

const manifest = loadManifest(manifestJson);

/** Launch Library status abbreviation → schedule confidence. */
const STATUS_CONFIDENCE: Record<string, number> = { Go: 0.9, TBC: 0.6, TBD: 0.35, Hold: 0.3, 'In Flight': 0.95, Success: 0.95, Failure: 0.95, 'Partial Failure': 0.95 };
/** Coarse time precision (the T-0 is only known to the day or worse) caps the confidence. */
const COARSE_PRECISION = new Set(['DAY', 'M', 'Q1', 'Q2', 'Q3', 'Q4', 'H1', 'H2', 'Y', 'FY', 'DEC', 'WK']);

export function scheduleConfidence(statusAbbrev: string | null, precisionAbbrev: string | null): number | null {
  if (!statusAbbrev) return null;
  const base = STATUS_CONFIDENCE[statusAbbrev];
  if (base == null) return null;
  if (precisionAbbrev && COARSE_PRECISION.has(precisionAbbrev) && precisionAbbrev !== 'DAY') return Math.min(base, 0.2);
  if (precisionAbbrev === 'DAY') return Math.min(base, 0.5);
  return base;
}

interface Launch {
  id?: unknown; url?: unknown; name?: unknown; last_updated?: unknown; net?: unknown; window_start?: unknown; window_end?: unknown;
  status?: { name?: unknown; abbrev?: unknown }; net_precision?: { name?: unknown; abbrev?: unknown } | null;
  launch_service_provider?: { name?: unknown; type?: { name?: unknown } };
  rocket?: { configuration?: { full_name?: unknown; name?: unknown } };
  mission?: { name?: unknown; type?: unknown; description?: unknown; orbit?: { name?: unknown } } | null;
  pad?: { name?: unknown; latitude?: unknown; longitude?: unknown; country?: { alpha_3_code?: unknown }; location?: { name?: unknown } };
  probability?: unknown; weather_concerns?: unknown; webcast_live?: unknown;
}

export default defineAdapter({
  manifest,
  version: '1.0.0',

  async fetch(ctx) {
    return [await ctx.http.get('https://ll.thespacedevs.com/2.3.0/launches/upcoming/?limit=50&mode=normal', { key: 'upcoming' })];
  },

  parse(payloads, ctx) {
    const out = new ParseCollector();
    for (const payload of payloads) {
      const body = jsonPayload<{ results: Launch[] }>(payload, (v) => isObject(v) && Array.isArray(v.results), 'Launch Library response');
      for (const launch of body.results) {
        out.item(launch, (l) => `${String(l?.id)} ${String(l?.name)}`, (l): RecordDraft | string => {
          if (typeof l !== 'object' || l === null) return 'launch is not an object';
          const id = str(l.id);
          const name = str(l.name, 200);
          if (!id || !name) return 'missing id or name';
          const lat = num(l.pad?.latitude);
          const lon = num(l.pad?.longitude);
          const point = lat == null || lon == null ? null : pointGeometry(lon, lat);
          if (!point) return 'launch pad has no valid coordinates';
          const net = parseTime(str(l.net));
          if (net == null) return 'missing or unparseable NET';
          const windowStart = parseTime(str(l.window_start));
          const windowEnd = parseTime(str(l.window_end)) ?? net;
          const lastUpdated = parseTime(str(l.last_updated));
          const status = str(l.status?.abbrev);
          const precision = str(l.net_precision?.abbrev);
          const confidence = scheduleConfidence(status, precision);
          // The record is "active" from when the schedule entry was last touched until shortly after the window closes.
          const start = Math.min(lastUpdated ?? ctx.now, ctx.now, net);
          const pad = str(l.pad?.name);
          const site = str(l.pad?.location?.name);
          const missionText = str(l.mission?.description, 2000);
          return {
            upstreamId: id,
            layerId: 'rocket-launches',
            subcategory: str(l.mission?.type) ?? null,
            geometry: point,
            country: str(l.pad?.country?.alpha_3_code),
            occurredAt: start,
            updatedAt: lastUpdated,
            expiresAt: Math.max(windowEnd, net) + 6 * HOUR,
            confidence,
            confidenceBasis: confidence != null ? `Launch Library status "${String(l.status?.name ?? status)}"; launch time precision: ${String(l.net_precision?.name ?? 'not stated')}` : null,
            title: `${name} — NET ${iso(net)!.slice(0, 16).replace('T', ' ')} UTC`,
            description: missionText && missionText !== 'Details TBD.' ? missionText.slice(0, 500) : `Scheduled launch from ${[pad, site].filter(Boolean).join(', ') || 'an unnamed pad'}.`,
            attributes: {
              netUtc: iso(net),
              windowStartUtc: iso(windowStart),
              windowEndUtc: iso(windowEnd),
              netPrecision: str(l.net_precision?.name),
              status: str(l.status?.name),
              provider: str(l.launch_service_provider?.name),
              providerType: str(l.launch_service_provider?.type?.name),
              vehicle: str(l.rocket?.configuration?.full_name) ?? str(l.rocket?.configuration?.name),
              mission: str(l.mission?.name),
              missionType: str(l.mission?.type),
              targetOrbit: str(l.mission?.orbit?.name),
              pad,
              launchSite: site,
              launchProbabilityPct: num(l.probability),
              weatherConcerns: str(l.weather_concerns, 200),
            },
            url: str(l.url, 300),
            derived: confidence != null ? ['confidence'] : [],
          };
        });
      }
    }
    return out.done();
  },
});
