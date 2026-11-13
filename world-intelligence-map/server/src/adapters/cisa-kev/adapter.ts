import { defineAdapter, isObject, jsonPayload, loadManifest, ParseCollector } from '../base.ts';
import { plainText, str } from '../../core/text.ts';
import { DAY, parseTime } from '../../core/time.ts';
import type { RecordDraft, Severity } from '../../core/types.ts';
import manifestJson from './manifest.json' with { type: 'json' };

const manifest = loadManifest(manifestJson);

export const FEED_URL = 'https://www.cisa.gov/sites/default/files/feeds/known_exploited_vulnerabilities.json';
/** Only entries whose dateAdded is at most this old are turned into records. */
export const WINDOW_DAYS = 90;

/** Pattern from CISA's published JSON schema (known_exploited_vulnerabilities_schema.json). */
const CVE_ID = /^CVE-[0-9]{4}-[0-9]{4,19}$/;
const CWE_ID = /^CWE-[0-9]+$/;
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

interface KevEntry {
  cveID?: unknown;
  vendorProject?: unknown;
  product?: unknown;
  vulnerabilityName?: unknown;
  dateAdded?: unknown;
  shortDescription?: unknown;
  requiredAction?: unknown;
  dueDate?: unknown;
  knownRansomwareCampaignUse?: unknown;
  forensicTriage?: unknown;
  notes?: unknown;
  cwes?: unknown;
}

interface KevCatalog {
  title?: unknown;
  catalogVersion?: unknown;
  dateReleased?: unknown;
  count?: unknown;
  vulnerabilities: KevEntry[];
}

/** Upstream text field → sanitised plain text; anything that is not a string counts as absent. */
function text(value: unknown, maxLen: number): string {
  return typeof value === 'string' ? plainText(value, maxLen) : '';
}

/** A calendar date ("YYYY-MM-DD") → 00:00 UTC of that day, or null. */
function dateOnly(value: unknown): number | null {
  return typeof value === 'string' && DATE_ONLY.test(value.trim()) ? parseTime(value) : null;
}

export default defineAdapter({
  manifest,
  version: '1.0.0',

  async fetch(ctx) {
    // One file holds the whole catalog (~1.8 MB). The HTTP client revalidates with the ETag CISA sends.
    return [await ctx.http.get(FEED_URL, { key: 'kev' })];
  },

  parse(payloads, ctx) {
    const out = new ParseCollector();
    const seen = new Set<string>();
    const cutoff = ctx.now - WINDOW_DAYS * DAY;
    for (const payload of payloads) {
      const catalog = jsonPayload<KevCatalog>(payload, (v) => isObject(v) && Array.isArray(v.vulnerabilities), 'CISA KEV catalog');
      out.noteUpstreamTime(parseTime(str(catalog.dateReleased)));
      for (const entry of catalog.vulnerabilities) {
        out.item(entry, (e) => `${String(e?.cveID)} ${String(e?.dateAdded)}`, (e): RecordDraft | RecordDraft[] | string => {
          if (!isObject(e)) return 'entry is not an object';
          const cveId = typeof e.cveID === 'string' ? e.cveID.trim().toUpperCase() : null;
          if (!cveId || !CVE_ID.test(cveId)) return 'missing or invalid cveID';
          const occurredAt = dateOnly(e.dateAdded);
          if (occurredAt == null) return `unparseable dateAdded "${String(e.dateAdded).slice(0, 40)}"`;
          if (occurredAt > ctx.now) return 'dateAdded is in the future';
          if (occurredAt < cutoff) return []; // older than the 90-day window – not an error
          if (seen.has(cveId)) return 'duplicate cveID';
          const name = text(e.vulnerabilityName, 200);
          if (!name) return 'missing vulnerabilityName';
          seen.add(cveId);

          const vendor = text(e.vendorProject, 80);
          const product = text(e.product, 80);
          const subject = vendor && product && vendor.toLowerCase() !== product.toLowerCase() ? `${vendor} ${product}` : vendor || product;
          const ransomware = text(e.knownRansomwareCampaignUse, 40) || null;
          const knownRansomware = ransomware?.toLowerCase() === 'known';
          // Every catalog entry is actively exploited (severe); confirmed ransomware use raises it to extreme.
          const severity: Severity = knownRansomware ? 4 : 3;
          const dueDate = dateOnly(e.dueDate) != null ? String(e.dueDate).trim() : null; // dropped when it is not a calendar date
          const cwes = Array.isArray(e.cwes) ? e.cwes.filter((c): c is string => typeof c === 'string' && CWE_ID.test(c)) : [];

          return {
            upstreamId: cveId,
            layerId: 'cisa-kev',
            subcategory: knownRansomware ? 'ransomware-linked' : 'exploited',
            geometryKind: 'global',
            occurredAt,
            severity,
            severityLabel: `Known exploited · ransomware campaign use: ${ransomware ?? 'not stated'}`,
            confidence: null,
            title: `${cveId} — ${subject ? `${subject}: ` : ''}${name}`,
            description: text(e.shortDescription, 500) || null,
            attributes: {
              cveID: cveId,
              vendorProject: vendor || null,
              product: product || null,
              vulnerabilityName: name,
              dateAdded: String(e.dateAdded).trim(),
              dueDate,
              knownRansomwareCampaignUse: ransomware,
              forensicTriage: text(e.forensicTriage, 20) || null,
              cwes: cwes.length ? cwes.join(', ') : null,
              requiredAction: text(e.requiredAction, 600) || null,
            },
            url: `https://nvd.nist.gov/vuln/detail/${cveId}`,
            derived: ['severity'],
          };
        });
      }
    }
    return out.done();
  },
});
