/**
 * Shareable URL state. Everything needed to reproduce a view lives in the location hash:
 *   #m=<zoom>/<lat>/<lng>&t=live:<seconds> | t=<fromISO>~<toISO>[~<cursorISO>][:<windowSeconds>]
 *   &l=<layer,layer>&src=…&cat=…&cc=…&sev=2-4&sevu=0&conf=0.5&confu=0&fr=fresh,recent&q=…&sel=<record id>&th=dark&pal=cvd
 * `l=` present but empty means "all layers off" (distinct from "not specified").
 */
import { DEFAULT_FILTERS, FRESHNESS, type Filters, type Freshness, type TimeState, type ViewState } from '../types';

export interface UrlState {
  view?: ViewState;
  time?: TimeState;
  layers?: string[];
  filters?: Filters;
  selected?: string | null;
  theme?: 'dark' | 'light';
  palette?: 'standard' | 'cvd';
}

const isoCompact = (ms: number) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');

export function encodeState(s: Required<Pick<UrlState, 'view' | 'time' | 'layers' | 'filters'>> & UrlState): string {
  const p: string[] = [];
  const v = s.view;
  p.push(`m=${v.zoom.toFixed(2)}/${v.lat.toFixed(4)}/${v.lng.toFixed(4)}`);
  if (s.time.mode === 'live') p.push(`t=live:${s.time.windowSec}`);
  else {
    const t = s.time;
    let seg = `${isoCompact(t.from)}~${isoCompact(t.to)}`;
    if (Math.abs(t.cursor - t.to) > 999) seg += `~${isoCompact(t.cursor)}`;
    if (t.windowSec > 0) seg += `:${t.windowSec}`;
    p.push(`t=${encodeURIComponent(seg).replace(/%3A/g, ':').replace(/%7E/g, '~')}`);
  }
  p.push(`l=${s.layers.map(encodeURIComponent).join(',')}`);
  const f = s.filters;
  if (f.sources.length) p.push(`src=${f.sources.map(encodeURIComponent).join(',')}`);
  if (f.categories.length) p.push(`cat=${f.categories.map(encodeURIComponent).join(',')}`);
  if (f.countries.length) p.push(`cc=${f.countries.join(',')}`);
  if (f.sevMin > 0 || f.sevMax < 4) p.push(`sev=${f.sevMin}-${f.sevMax}`);
  if (!f.sevUnknown) p.push('sevu=0');
  if (f.confMin > 0) p.push(`conf=${f.confMin}`);
  if (!f.confUnknown) p.push('confu=0');
  if (f.fresh.length) p.push(`fr=${f.fresh.join(',')}`);
  if (f.q.trim()) p.push(`q=${encodeURIComponent(f.q.trim())}`);
  if (s.selected) p.push(`sel=${encodeURIComponent(s.selected)}`);
  if (s.theme) p.push(`th=${s.theme}`);
  if (s.palette && s.palette !== 'standard') p.push(`pal=${s.palette}`);
  return `#${p.join('&')}`;
}

function csv(v: string | undefined): string[] {
  if (!v) return [];
  return v.split(',').map((x) => {
    try {
      return decodeURIComponent(x);
    } catch {
      return x;
    }
  }).filter(Boolean);
}

/** Parse a location hash. Unknown or malformed parts are ignored (never throw on a hand-edited URL). */
export function decodeState(hash: string): UrlState {
  const out: UrlState = {};
  const raw = hash.replace(/^#/, '');
  if (!raw) return out;
  const kv = new Map<string, string>();
  for (const part of raw.split('&')) {
    const i = part.indexOf('=');
    if (i > 0) kv.set(part.slice(0, i), part.slice(i + 1));
  }

  const m = kv.get('m');
  if (m) {
    const [z, lat, lng] = m.split('/').map(Number);
    if ([z, lat, lng].every((n) => Number.isFinite(n)) && z! >= 0 && z! <= 22 && Math.abs(lat!) <= 90 && Math.abs(lng!) <= 540) {
      out.view = { zoom: z!, lat: lat!, lng: lng! };
    }
  }

  const t = kv.get('t');
  if (t) {
    let dec = t;
    try {
      dec = decodeURIComponent(t);
    } catch {
      /* keep raw */
    }
    const live = /^live:(\d{2,9})$/.exec(dec);
    if (live) out.time = { mode: 'live', windowSec: Math.max(60, Number(live[1])) };
    else {
      const mm = /^([^~]+)~([^~]+?)(?:~([^~]+?))?(?::(\d{1,9}))?$/.exec(dec.replace(/:(\d{1,9})$/, (s) => s));
      // The ISO strings themselves contain ':' – split the optional trailing ":<seconds>" only after a 'Z'.
      const win = /Z:(\d{1,9})$/.exec(dec);
      const body = win ? dec.slice(0, dec.length - win[1]!.length - 1) : dec;
      const parts = body.split('~');
      const from = Date.parse(parts[0] ?? '');
      const to = Date.parse(parts[1] ?? '');
      const cursor = parts[2] ? Date.parse(parts[2]) : to;
      if (mm && Number.isFinite(from) && Number.isFinite(to) && from < to) {
        out.time = { mode: 'range', from, to, cursor: Number.isFinite(cursor) ? Math.min(to, Math.max(from, cursor)) : to, windowSec: win ? Number(win[1]) : 0 };
      }
    }
  }

  if (kv.has('l')) out.layers = csv(kv.get('l')).filter((id) => /^[a-z0-9][a-z0-9-]{0,60}$/.test(id));

  const f: Filters = { ...DEFAULT_FILTERS };
  let anyFilter = false;
  const set = <K extends keyof Filters>(k: K, v: Filters[K]) => {
    f[k] = v;
    anyFilter = true;
  };
  if (kv.has('src')) set('sources', csv(kv.get('src')));
  if (kv.has('cat')) set('categories', csv(kv.get('cat')));
  if (kv.has('cc')) set('countries', csv(kv.get('cc')).map((c) => c.toUpperCase()).filter((c) => /^[A-Z]{3}$/.test(c)));
  const sev = /^([0-4])-([0-4])$/.exec(kv.get('sev') ?? '');
  if (sev && Number(sev[1]) <= Number(sev[2])) {
    set('sevMin', Number(sev[1]));
    set('sevMax', Number(sev[2]));
  }
  if (kv.get('sevu') === '0') set('sevUnknown', false);
  const conf = Number(kv.get('conf'));
  if (kv.has('conf') && Number.isFinite(conf) && conf >= 0 && conf <= 1) set('confMin', conf);
  if (kv.get('confu') === '0') set('confUnknown', false);
  if (kv.has('fr')) set('fresh', csv(kv.get('fr')).filter((x): x is Freshness => (FRESHNESS as string[]).includes(x)));
  if (kv.has('q')) {
    try {
      set('q', decodeURIComponent(kv.get('q')!).slice(0, 120));
    } catch {
      /* ignore */
    }
  }
  if (anyFilter) out.filters = f;

  if (kv.has('sel')) {
    try {
      out.selected = decodeURIComponent(kv.get('sel')!);
    } catch {
      /* ignore */
    }
  }
  const th = kv.get('th');
  if (th === 'dark' || th === 'light') out.theme = th;
  const pal = kv.get('pal');
  if (pal === 'cvd' || pal === 'standard') out.palette = pal;
  return out;
}
