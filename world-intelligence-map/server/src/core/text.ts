/** Text, URL and tabular helpers used by adapters and the normaliser. */
import { createHash } from 'node:crypto';

const ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—', hellip: '…', deg: '°',
  rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“',
};

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, ent: string) => {
    if (ent[0] === '#') {
      const code = ent[1]!.toLowerCase() === 'x' ? parseInt(ent.slice(2), 16) : parseInt(ent.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code < 0x10ffff ? String.fromCodePoint(code) : '';
    }
    return ENTITIES[ent.toLowerCase()] ?? whole;
  });
}

/**
 * Reduce arbitrary upstream text/HTML to plain text. Removes script/style content and all tags,
 * decodes entities, strips control characters and collapses whitespace. The result is always
 * rendered as text by the client (never as HTML).
 */
export function plainText(input: unknown, maxLen = 2000): string {
  if (input == null) return '';
  let s = typeof input === 'string' ? input : String(input);
  s = s
    .replace(/<(script|style|iframe|object|embed)\b[\s\S]*?<\/\1\s*>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<br\s*\/?>|<\/p>|<\/div>|<\/li>|<\/tr>/gi, ' ')
    .replace(/<[^>]{0,2000}>/g, '');
  s = decodeEntities(s);
  // A second pass: entities may have decoded into tags.
  s = s.replace(/<[^>]{0,2000}>/g, '');
  // eslint-disable-next-line no-control-regex
  s = s.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u200b-\u200f\u202a-\u202e\u2066-\u2069]/g, '');
  s = s.replace(/\s+/g, ' ').trim();
  if (s.length > maxLen) s = s.slice(0, maxLen - 1).trimEnd() + '…';
  return s;
}

/** Only http(s) URLs survive; everything else (javascript:, data:, relative) becomes null. */
export function safeUrl(input: unknown): string | null {
  if (typeof input !== 'string') return null;
  const s = input.trim();
  if (!s || s.length > 2000) return null;
  try {
    const u = new URL(s);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    if (u.username || u.password) return null;
    return u.toString();
  } catch {
    return null;
  }
}

export function sha256(input: string | Uint8Array): string {
  return createHash('sha256').update(input).digest('hex');
}

/** Deterministic JSON with sorted keys, for content hashing. */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const obj = value as Record<string, unknown>;
  return `{${Object.keys(obj)
    .filter((k) => obj[k] !== undefined)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`)
    .join(',')}}`;
}

/** Finite number or null. Accepts numeric strings; rejects '', NaN, Infinity. */
export function num(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string') {
    const t = value.trim();
    if (!t) return null;
    const n = Number(t);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/** Non-empty trimmed string or null. */
export function str(value: unknown, maxLen = 500): string | null {
  if (value == null) return null;
  const s = (typeof value === 'string' ? value : String(value)).trim();
  if (!s) return null;
  return s.length > maxLen ? s.slice(0, maxLen) : s;
}

/**
 * RFC 4180 CSV parser (quoted fields, escaped quotes, CRLF, embedded newlines).
 * Returns rows of string cells. `delimiter` may be ',' or '\t' etc.
 */
export function parseCsv(text: string, delimiter = ','): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let inQuotes = false;
  let i = 0;
  if (text.charCodeAt(0) === 0xfeff) i = 1;
  const n = text.length;
  for (; i < n; i++) {
    const c = text[i]!;
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i++;
        } else inQuotes = false;
      } else cell += c;
    } else if (c === '"' && cell === '') {
      inQuotes = true;
    } else if (c === delimiter) {
      row.push(cell);
      cell = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(cell);
      cell = '';
      if (row.length > 1 || row[0] !== '') rows.push(row);
      row = [];
    } else cell += c;
  }
  if (cell !== '' || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}

/** CSV with a header row → array of objects keyed by header name. Short rows are padded with ''. */
export function parseCsvObjects(text: string, delimiter = ','): Record<string, string>[] {
  const rows = parseCsv(text, delimiter);
  const header = rows.shift();
  if (!header) return [];
  const names = header.map((h) => h.trim());
  return rows.map((r) => {
    const o: Record<string, string> = {};
    for (let i = 0; i < names.length; i++) o[names[i]!] = r[i] ?? '';
    return o;
  });
}

/** Mulberry32 – small deterministic PRNG for fixtures and jitter in tests. */
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
