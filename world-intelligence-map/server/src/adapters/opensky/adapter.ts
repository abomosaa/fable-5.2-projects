import { defineAdapter, isObject, jsonPayload, loadManifest, ParseCollector } from '../base.ts';
import { pointGeometry } from '../../core/geo.ts';
import { num, str } from '../../core/text.ts';
import { fromEpochSeconds } from '../../core/time.ts';
import type { FetchContext, RecordDraft } from '../../core/types.ts';
import manifestJson from './manifest.json' with { type: 'json' };

const manifest = loadManifest(manifestJson);

export const STATES_URL = 'https://opensky-network.org/api/states/all';
export const TOKEN_URL = 'https://auth.opensky-network.org/auth/realms/opensky-network/protocol/openid-connect/token';

/** Tokens are valid for 30 minutes; reuse one for 25 so that two consecutive polls share a token. */
const TOKEN_CACHE_SEC = 1500;
const TOKEN_SAFETY_MS = 60_000;

/** Emergency transponder codes (ICAO Annex 10). The meaning is the standard one; the code itself is as broadcast. */
const EMERGENCY_SQUAWKS: Record<string, string> = {
  '7500': 'unlawful interference',
  '7600': 'radio communication failure',
  '7700': 'general emergency',
};

/** `position_source` values documented by OpenSky. */
const POSITION_SOURCES = ['ADS-B', 'ASTERIX', 'MLAT', 'FLARM'];

/**
 * OAuth2 client-credentials flow as documented by OpenSky. Returns null when no credentials are configured
 * (anonymous access). The secret travels only in the POST body and the token only in a request header;
 * neither ever appears in a URL, a payload returned to the pipeline, or a record.
 */
async function bearerToken(ctx: FetchContext): Promise<string | null> {
  const id = ctx.env.OPENSKY_CLIENT_ID?.trim();
  const secret = ctx.env.OPENSKY_CLIENT_SECRET?.trim();
  if (!id || !secret) return null;
  const res = await ctx.http.get(TOKEN_URL, {
    key: 'token',
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body: `grant_type=client_credentials&client_id=${encodeURIComponent(id)}&client_secret=${encodeURIComponent(secret)}`,
    redact: [id, secret],
    cacheTtlSec: TOKEN_CACHE_SEC,
  });
  let body: unknown;
  try {
    body = res.json();
  } catch {
    throw new Error('malformed OpenSky token response: not valid JSON');
  }
  const token = isObject(body) ? str(body.access_token, 8192) : null;
  if (!token) throw new Error('malformed OpenSky token response: no access_token');
  const lifetimeMs = ((isObject(body) ? num(body.expires_in) : null) ?? 1800) * 1000;
  // A cached copy served because the token endpoint failed may already have expired – never send a dead token.
  if (res.fetchedAt + lifetimeMs - TOKEN_SAFETY_MS <= ctx.now) throw new Error('OpenSky access token expired and could not be renewed');
  return token;
}

export default defineAdapter({
  manifest,
  version: '1.0.0',

  async fetch(ctx) {
    const token = await bearerToken(ctx);
    // One global query (4 credits). Only the state-vector payload is handed to the pipeline – never the token response.
    return [await ctx.http.get(STATES_URL, { key: 'states', headers: token ? { authorization: `Bearer ${token}` } : undefined })];
  },

  parse(payloads) {
    const out = new ParseCollector();
    const seen = new Set<string>();
    for (const payload of payloads) {
      // { "time": <unix s>, "states": [[...17 fields...], ...] | null }. "states" is null when nothing is in view.
      const body = jsonPayload<{ time: number; states: unknown[] | null }>(
        payload,
        (v) => isObject(v) && typeof v.time === 'number' && (v.states === null || Array.isArray(v.states)),
        'OpenSky state-vector response',
      );
      out.noteUpstreamTime(fromEpochSeconds(body.time));
      for (const state of body.states ?? []) {
        // Legitimate non-records are skipped before any per-item work: surface reports and vectors without a position.
        if (Array.isArray(state) && state.length >= 17 && (state[8] === true || state[5] == null || state[6] == null)) continue;
        out.item(state, (s) => (Array.isArray(s) ? `${String(s[0])} ${String(s[1] ?? '').trim()}` : String(s)), (s): RecordDraft | RecordDraft[] | string => {
          if (!Array.isArray(s) || s.length < 17) return 'state vector is not an array of 17 fields';
          const icao24 = typeof s[0] === 'string' ? s[0].trim().toLowerCase() : '';
          if (!/^[0-9a-f]{6}$/.test(icao24)) return 'missing or invalid icao24 address';
          if (typeof s[5] !== 'number' || typeof s[6] !== 'number') return 'invalid coordinates';
          const geometry = pointGeometry(s[5], s[6]);
          if (!geometry || Math.abs(s[5]) > 180) return 'invalid coordinates';
          // time_position is null when the position was not refreshed recently; last_contact is the documented fallback.
          const occurredAt = fromEpochSeconds(typeof s[3] === 'number' ? s[3] : null) ?? fromEpochSeconds(typeof s[4] === 'number' ? s[4] : null);
          if (occurredAt == null) return 'missing position and contact time';
          if (seen.has(icao24)) return []; // one state per transponder
          seen.add(icao24);

          const callsign = str(s[1], 16);
          const squawk = str(s[14], 8);
          const emergency = squawk ? EMERGENCY_SQUAWKS[squawk] : undefined;
          const positionSource = typeof s[16] === 'number' ? (POSITION_SOURCES[s[16]] ?? `code ${s[16]}`) : null;
          return {
            upstreamId: icao24,
            layerId: 'aircraft',
            geometry,
            // No `country`: origin_country is the registry of the address block, not where the aircraft is.
            occurredAt,
            updatedAt: fromEpochSeconds(typeof s[4] === 'number' ? s[4] : null),
            severity: emergency ? 3 : null,
            severityLabel: emergency ? `Squawk ${squawk} – ${emergency}` : null,
            title: callsign ?? `ICAO24 ${icao24}`,
            attributes: {
              icao24,
              callsign,
              originCountry: str(s[2], 80),
              baroAltitudeM: num(s[7]),
              geoAltitudeM: num(s[13]),
              velocityMs: num(s[9]),
              headingDeg: num(s[10]),
              verticalRateMs: num(s[11]),
              squawk,
              positionSource,
            },
            derived: emergency ? ['severity'] : [],
          };
        });
      }
    }
    return out.done();
  },
});
