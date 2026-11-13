/**
 * GDELT 2.0 Event Database – 15-minute export.
 *
 * lastupdate.txt names the newest `<YYYYMMDDHHMMSS>.export.CSV.zip`; the zip holds one tab-separated file with
 * 61 columns and no header (column order from the GDELT 2.0 Event Codebook). Everything in it is produced by
 * automated machine coding of news reports, so records are worded and scored as media-reported claims.
 */
import { unzipSync } from 'fflate';
import { defineAdapter, loadManifest, ParseCollector } from '../base.ts';
import { pointGeometry } from '../../core/geo.ts';
import { parseTime } from '../../core/time.ts';
import type { FetchedPayload, RecordDraft } from '../../core/types.ts';
import manifestJson from './manifest.json' with { type: 'json' };

const manifest = loadManifest(manifestJson);

export const LASTUPDATE_URL = 'https://data.gdeltproject.org/gdeltv2/lastupdate.txt';
export const CURSOR_KEY = 'lastExportFile';
const EXPORT_RE = /https?:\/\/data\.gdeltproject\.org\/gdeltv2\/(\d{14}\.export\.CSV\.zip)(?=\s|$)/;

/** Column indexes of the GDELT 2.0 event table (61 columns, no header row). */
const COLUMNS = 61;
const C = {
  GLOBALEVENTID: 0,
  SQLDATE: 1,
  Actor1CountryCode: 7,
  Actor1Type1Code: 12,
  Actor2CountryCode: 17,
  Actor2Type1Code: 22,
  IsRootEvent: 25,
  EventCode: 26,
  EventBaseCode: 27,
  EventRootCode: 28,
  QuadClass: 29,
  GoldsteinScale: 30,
  NumMentions: 31,
  NumSources: 32,
  NumArticles: 33,
  AvgTone: 34,
  ActionGeo_Type: 51,
  ActionGeo_FullName: 52,
  ActionGeo_CountryCode: 53,
  ActionGeo_ADM1Code: 54,
  ActionGeo_Lat: 56,
  ActionGeo_Long: 57,
  ActionGeo_FeatureID: 58,
  DATEADDED: 59,
  SOURCEURL: 60,
} as const;

/** Cooperation events below this many mentions (first 15 minutes) are dropped as noise. */
export const MIN_COOPERATION_MENTIONS = 3;
/** Rows whose coded event day is older than this relative to DATEADDED are retrospective mentions, not news. */
export const MAX_EVENT_AGE_DAYS = 2;
/** Refuse absurdly large archive members (a real 15-minute export is 0.3–3 MB uncompressed). */
const MAX_CSV_BYTES = 96 * 1024 * 1024;

const QUAD_CLASS: Record<string, string> = { '1': 'Verbal cooperation', '2': 'Material cooperation', '3': 'Verbal conflict', '4': 'Material conflict' };

/** CAMEO root code → neutral label (CAMEO 1.1b3 event taxonomy). */
export const CAMEO_ROOT: Record<string, string> = {
  '01': 'Public statement',
  '02': 'Appeal',
  '03': 'Expressed intent to cooperate',
  '04': 'Consultation',
  '05': 'Diplomatic cooperation',
  '06': 'Material cooperation',
  '07': 'Provision of aid',
  '08': 'Concession / yielding',
  '09': 'Investigation',
  '10': 'Demand',
  '11': 'Disapproval',
  '12': 'Rejection',
  '13': 'Threat',
  '14': 'Protest',
  '15': 'Show of military or police force',
  '16': 'Reduction of relations',
  '17': 'Coercion',
  '18': 'Assault',
  '19': 'Armed clash / use of military force',
  '20': 'Unconventional mass violence',
};

/**
 * CAMEO base (three-digit) code → label for the roots this adapter maps, from the official lookup
 * (gdeltproject.org/data/lookups/CAMEO.eventcodes.txt), lightly normalised. Root 20 intentionally has no
 * base-level labels: its sub-types are grave legal characterisations that machine coding cannot support.
 */
const CAMEO_BASE: Record<string, string> = {
  '031': 'Expressed intent to engage in material cooperation', '032': 'Expressed intent to provide diplomatic support', '033': 'Expressed intent to provide material aid',
  '034': 'Expressed intent to institute political reform', '035': 'Expressed intent to yield', '036': 'Expressed intent to meet or negotiate',
  '037': 'Expressed intent to settle a dispute', '038': 'Expressed intent to accept mediation', '039': 'Expressed intent to mediate',
  '041': 'Discussion by telephone', '042': 'Visit made', '043': 'Visit hosted', '044': 'Meeting at a third location', '045': 'Mediation', '046': 'Negotiation',
  '051': 'Praise or endorsement', '052': 'Verbal defence', '053': 'Rallying of support', '054': 'Diplomatic recognition granted', '055': 'Apology', '056': 'Forgiveness', '057': 'Formal agreement signed',
  '061': 'Economic cooperation', '062': 'Military cooperation', '063': 'Judicial cooperation', '064': 'Sharing of intelligence or information',
  '071': 'Economic aid provided', '072': 'Military aid provided', '073': 'Humanitarian aid provided', '074': 'Military protection or peacekeeping provided', '075': 'Asylum granted',
  '081': 'Easing of administrative sanctions', '082': 'Easing of restrictions on political dissent', '083': 'Acceding to demands for political reform', '084': 'Return or release',
  '085': 'Easing of economic sanctions, boycott or embargo', '086': 'International involvement allowed', '087': 'De-escalation of military engagement',
  '141': 'Demonstration or rally', '142': 'Hunger strike', '143': 'Strike or boycott', '144': 'Obstruction of passage / blockade', '145': 'Violent protest or riot',
  '151': 'Increased police alert status', '152': 'Increased military alert status', '153': 'Mobilisation or increase of police power', '154': 'Mobilisation or increase of armed forces',
  '161': 'Reduction or break of diplomatic relations', '162': 'Reduction or stop of aid', '163': 'Embargo, boycott or sanctions imposed', '164': 'Negotiations halted', '165': 'Mediation halted', '166': 'Expulsion or withdrawal',
  '171': 'Seizure of or damage to property', '172': 'Administrative sanctions imposed', '173': 'Arrest, detention or legal charge', '174': 'Expulsion or deportation', '175': 'Violent repression',
  '181': 'Abduction, hijacking or hostage-taking', '182': 'Physical assault', '183': 'Non-military bombing', '184': 'Use of human shields', '185': 'Assassination attempt', '186': 'Assassination',
  '191': 'Blockade or restriction of movement', '192': 'Occupation of territory', '193': 'Fighting with small arms and light weapons', '194': 'Fighting with artillery and tanks', '195': 'Use of aerial weapons', '196': 'Ceasefire violation',
};

function layerFor(root: string, quad: string, mentions: number): string | null {
  if (root === '14') return 'gdelt-protests';
  if (quad === '4') return 'gdelt-conflict';
  if ((quad === '1' || quad === '2') && root >= '03' && root <= '08' && root.length === 2) return mentions >= MIN_COOPERATION_MENTIONS ? 'gdelt-cooperation' : null;
  return null;
}

/** "YYYYMMDD" → UTC day number, or NaN. */
function dayNumber(s: string): number {
  if (s.length < 8) return NaN;
  const y = +s.slice(0, 4);
  const m = +s.slice(4, 6);
  const d = +s.slice(6, 8);
  if (!(y > 1900 && m >= 1 && m <= 12 && d >= 1 && d <= 31)) return NaN;
  return Date.UTC(y, m - 1, d) / 86_400_000;
}

function finite(s: string | undefined): number | null {
  if (s == null || s === '') return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

/** 0.20 for one source, +0.05 per additional source in the first 15 minutes, capped at 0.50. */
export function gdeltConfidence(numSources: number | null): number {
  const extra = Math.max(0, Math.min(6, Math.floor(numSources ?? 1) - 1));
  return Math.round((0.2 + 0.05 * extra) * 100) / 100;
}

export function findExportUrl(lastupdate: string): { url: string; file: string } | null {
  const m = EXPORT_RE.exec(lastupdate);
  // The list still advertises http:// URLs, which now redirect to https on the same host.
  return m ? { url: `https://data.gdeltproject.org/gdeltv2/${m[1]!}`, file: m[1]! } : null;
}

function exportCsv(payload: FetchedPayload): string {
  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(payload.body, { filter: (f) => /\.csv$/i.test(f.name) && f.originalSize <= MAX_CSV_BYTES });
  } catch (err) {
    throw new Error(`malformed GDELT export: not a readable zip archive (${(err as Error).message})`);
  }
  const data = Object.values(files)[0];
  if (!data) throw new Error('malformed GDELT export: archive contains no CSV member');
  return Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString('utf8');
}

export default defineAdapter({
  manifest,
  version: '1.0.0',

  async fetch(ctx) {
    const last = await ctx.http.get(LASTUPDATE_URL, { key: 'lastupdate' });
    const latest = findExportUrl(last.text());
    if (!latest) throw new Error('malformed GDELT lastupdate.txt: no export file listed');
    // Export files are immutable: once a file has been processed there is nothing new until the next 15-minute slot.
    if (ctx.cursor.get(CURSOR_KEY) === latest.file) return [last];
    const zip = await ctx.http.get(latest.url, { key: 'export', cacheTtlSec: 86_400 });
    if (!zip.stale) ctx.cursor.set(CURSOR_KEY, latest.file);
    return [last, zip];
  },

  parse(payloads) {
    const out = new ParseCollector();
    /** article + root code + place → draft, to collapse the several codings GDELT emits for one sentence. */
    const byArticle = new Map<string, RecordDraft>();
    const seenIds = new Set<string>();

    for (const payload of payloads) {
      if (payload.key === 'lastupdate') {
        const latest = findExportUrl(payload.text());
        if (!latest) throw new Error('malformed GDELT lastupdate.txt: no export file listed');
        out.noteUpstreamTime(parseTime(latest.file.slice(0, 14)));
        continue;
      }

      const text = exportCsv(payload);
      let sawRow = false;
      let start = 0;
      const n = text.length;
      while (start < n) {
        let end = text.indexOf('\n', start);
        if (end < 0) end = n;
        const line = text.charCodeAt(end - 1) === 13 ? text.slice(start, end - 1) : text.slice(start, end);
        start = end + 1;
        if (!line) continue;
        const f = line.split('\t');
        if (f.length !== COLUMNS) {
          out.reject(`unexpected column count ${f.length} (expected ${COLUMNS})`, line.slice(0, 80));
          continue;
        }
        sawRow = true;

        // Cheap filters first: most rows are verbal events or coarse geocodes and never become records.
        const root = f[C.EventRootCode]!;
        const mentions = finite(f[C.NumMentions]) ?? 0;
        const layerId = layerFor(root, f[C.QuadClass]!, mentions);
        if (!layerId) continue;
        const geoType = f[C.ActionGeo_Type]!;
        if (geoType !== '3' && geoType !== '4') continue; // country / state centroids mislead on a map

        out.item(f, (r) => `${r[C.GLOBALEVENTID]} ${r[C.EventCode]} ${r[C.ActionGeo_FullName]}`, (r): RecordDraft | RecordDraft[] | string => {
          const id = r[C.GLOBALEVENTID]!.trim();
          if (!/^\d+$/.test(id)) return 'missing or non-numeric GLOBALEVENTID';
          if (seenIds.has(id)) return [];
          const geometry = pointGeometry(r[C.ActionGeo_Long], r[C.ActionGeo_Lat]);
          if (!geometry) return 'missing or invalid ActionGeo coordinates';
          const added = r[C.DATEADDED]!;
          const occurredAt = /^\d{14}$/.test(added) ? parseTime(added) : null;
          if (occurredAt == null) return `unparseable DATEADDED "${added.slice(0, 20)}"`;
          const eventDay = dayNumber(r[C.SQLDATE]!);
          if (Number.isNaN(eventDay)) return `unparseable SQLDATE "${r[C.SQLDATE]!.slice(0, 20)}"`;
          const ageDays = Math.floor(occurredAt / 86_400_000) - eventDay;
          if (ageDays > MAX_EVENT_AGE_DAYS || ageDays < -1) return []; // retrospective or forward-looking mention, not a current event
          seenIds.add(id);

          const place = r[C.ActionGeo_FullName]!.trim();
          const url = r[C.SOURCEURL]!.trim();
          const dupKey = `${url}\u0001${root}\u0001${r[C.ActionGeo_FeatureID] || `${r[C.ActionGeo_Lat]},${r[C.ActionGeo_Long]}`}`;
          const earlier = url ? byArticle.get(dupKey) : undefined;
          if (earlier) {
            earlier.attributes!.codingsCollapsed = ((earlier.attributes!.codingsCollapsed as number | undefined) ?? 1) + 1;
            return [];
          }

          const code = r[C.EventCode]!;
          const base = r[C.EventBaseCode]!;
          const label = (root === '20' ? undefined : CAMEO_BASE[base]) ?? CAMEO_ROOT[root] ?? `CAMEO event ${code}`;
          const numSources = finite(r[C.NumSources]);
          const sqlDate = r[C.SQLDATE]!;
          const draft: RecordDraft = {
            upstreamId: id,
            layerId,
            subcategory: CAMEO_ROOT[root] ?? null,
            geometry,
            occurredAt,
            severity: null,
            confidence: gdeltConfidence(numSources),
            confidenceBasis: `Automated machine coding of news reports; location is machine-geocoded from the text; ${numSources ?? 1} source(s) in the first 15 minutes. Not verified.`,
            title: `Media-reported: ${label}${place ? ` – ${place}` : ''}`,
            description: `GDELT's automated coding read a news report as describing "${label.toLowerCase()}" (CAMEO ${code})${place ? ` at or near ${place}` : ''}. Unverified machine-coded claim; see the linked report.`,
            attributes: {
              cameoEventCode: code,
              cameoRootCode: root,
              cameoRootLabel: CAMEO_ROOT[root],
              quadClass: QUAD_CLASS[r[C.QuadClass]!] ?? r[C.QuadClass],
              goldsteinScale: finite(r[C.GoldsteinScale]),
              numMentions: finite(r[C.NumMentions]),
              numSources,
              numArticles: finite(r[C.NumArticles]),
              avgTone: roundTone(finite(r[C.AvgTone])),
              eventDate: `${sqlDate.slice(0, 4)}-${sqlDate.slice(4, 6)}-${sqlDate.slice(6, 8)}`,
              actor1CountryCode: r[C.Actor1CountryCode] || null,
              actor1TypeCode: r[C.Actor1Type1Code] || null,
              actor2CountryCode: r[C.Actor2CountryCode] || null,
              actor2TypeCode: r[C.Actor2Type1Code] || null,
              isRootEvent: r[C.IsRootEvent] === '1',
              actionGeoName: place || null,
              actionGeoPrecision: geoType === '3' ? 'US city or landmark' : 'city or landmark',
              actionGeoCountryFips: r[C.ActionGeo_CountryCode] || null,
              actionGeoAdm1Code: r[C.ActionGeo_ADM1Code] || null,
            },
            url: url || null,
            derived: ['confidence'],
          };
          if (url) byArticle.set(dupKey, draft);
          return draft;
        });
      }
      if (!sawRow) throw new Error('malformed GDELT export: no 61-column event rows found');
    }
    return out.done();
  },
});

function roundTone(v: number | null): number | null {
  return v == null ? null : Math.round(v * 100) / 100;
}
