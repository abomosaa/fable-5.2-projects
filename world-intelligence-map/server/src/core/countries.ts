/**
 * Country gazetteer backed by the bundled Natural Earth 1:50m admin-0 dataset (public domain).
 * Provides code normalisation (alpha-2 / alpha-3 / name → alpha-3), label points, bounding boxes
 * and a point-in-polygon lookup used when an upstream record carries coordinates but no country.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { Feature, FeatureCollection, MultiPolygon, Polygon } from 'geojson';
import { pointInPolygonGeometry, type BBox } from './geo.ts';
import { assetPath } from './paths.ts';

export interface Country {
  iso3: string;
  iso2: string | null;
  name: string;
  nameLong: string;
  continent: string;
  region: string;
  pop: number | null;
  label: [number, number];
  bbox: BBox;
}

interface Loaded {
  list: Country[];
  byIso3: Map<string, Country>;
  byIso2: Map<string, Country>;
  byName: Map<string, Country>;
  features: { country: Country; geometry: Polygon | MultiPolygon; bbox: BBox }[];
  grid: Map<number, number[]>;
}

/** Codes used by major providers that differ from Natural Earth's. */
const ALIASES: Record<string, string> = {
  XKX: 'KOS', XK: 'KOS', KSV: 'KOS', UNK: 'KOS',
  ROM: 'ROU', ZAR: 'COD', TMP: 'TLS', WBG: 'PSE', UK: 'GBR', EL: 'GRC',
  PSX: 'PSE', SDS: 'SSD', SAH: 'ESH',
};

const NAME_ALIASES: Record<string, string> = {
  'united states': 'USA', 'united states of america': 'USA', usa: 'USA', 'u.s.': 'USA', us: 'USA',
  'united kingdom': 'GBR', uk: 'GBR', britain: 'GBR', 'great britain': 'GBR',
  russia: 'RUS', 'russian federation': 'RUS',
  'south korea': 'KOR', 'korea, rep.': 'KOR', 'republic of korea': 'KOR', "korea, republic of": 'KOR',
  'north korea': 'PRK', "korea, dem. people's rep.": 'PRK', "democratic people's republic of korea": 'PRK', 'dprk': 'PRK',
  iran: 'IRN', 'iran, islamic rep.': 'IRN', 'iran (islamic republic of)': 'IRN', 'islamic republic of iran': 'IRN',
  syria: 'SYR', 'syrian arab republic': 'SYR',
  'dr congo': 'COD', 'democratic republic of the congo': 'COD', 'congo, dem. rep.': 'COD', 'drc': 'COD', 'congo (kinshasa)': 'COD', 'dem. rep. congo': 'COD',
  congo: 'COG', 'republic of the congo': 'COG', 'congo, rep.': 'COG', 'congo (brazzaville)': 'COG',
  tanzania: 'TZA', 'united republic of tanzania': 'TZA',
  venezuela: 'VEN', 'venezuela (bolivarian republic of)': 'VEN', 'venezuela, rb': 'VEN',
  bolivia: 'BOL', 'bolivia (plurinational state of)': 'BOL',
  vietnam: 'VNM', 'viet nam': 'VNM',
  laos: 'LAO', "lao people's democratic republic": 'LAO', 'lao pdr': 'LAO',
  moldova: 'MDA', 'republic of moldova': 'MDA',
  'czech republic': 'CZE', czechia: 'CZE',
  turkey: 'TUR', 'türkiye': 'TUR', turkiye: 'TUR',
  'ivory coast': 'CIV', "côte d'ivoire": 'CIV', "cote d'ivoire": 'CIV',
  'cape verde': 'CPV', 'cabo verde': 'CPV',
  palestine: 'PSE', 'state of palestine': 'PSE', 'occupied palestinian territory': 'PSE', 'west bank and gaza': 'PSE', 'palestinian territories': 'PSE',
  myanmar: 'MMR', burma: 'MMR',
  'south sudan': 'SSD', 'timor-leste': 'TLS', 'east timor': 'TLS',
  eswatini: 'SWZ', swaziland: 'SWZ', 'north macedonia': 'MKD', macedonia: 'MKD',
  'bosnia and herzegovina': 'BIH', 'the gambia': 'GMB', gambia: 'GMB', 'gambia, the': 'GMB',
  bahamas: 'BHS', 'bahamas, the': 'BHS', 'egypt, arab rep.': 'EGY', 'yemen, rep.': 'YEM',
  micronesia: 'FSM', 'micronesia (federated states of)': 'FSM', brunei: 'BRN', 'brunei darussalam': 'BRN',
  kosovo: 'KOS', taiwan: 'TWN', 'hong kong': 'HKG', macau: 'MAC', macao: 'MAC',
  'united arab emirates': 'ARE', uae: 'ARE', 'kyrgyz republic': 'KGZ', 'slovak republic': 'SVK',
  'st. lucia': 'LCA', 'saint lucia': 'LCA', 'st. kitts and nevis': 'KNA', 'st. vincent and the grenadines': 'VCT',
  'sao tome and principe': 'STP', 'são tomé and príncipe': 'STP', 'central african republic': 'CAF',
  'dominican republic': 'DOM', 'equatorial guinea': 'GNQ', 'solomon islands': 'SLB', 'western sahara': 'ESH',
};

let loaded: Loaded | null = null;

function key(s: string): string {
  return s.trim().toLowerCase().replace(/\s+/g, ' ');
}

const GRID_DEG = 10;
function cell(lon: number, lat: number): number {
  const cx = Math.min(35, Math.max(0, Math.floor((lon + 180) / GRID_DEG)));
  const cy = Math.min(17, Math.max(0, Math.floor((lat + 90) / GRID_DEG)));
  return cy * 36 + cx;
}

function load(): Loaded {
  if (loaded) return loaded;
  const fc = JSON.parse(readFileSync(path.join(assetPath(), 'ne', 'countries.geojson'), 'utf8')) as FeatureCollection;
  const out: Loaded = { list: [], byIso3: new Map(), byIso2: new Map(), byName: new Map(), features: [], grid: new Map() };
  for (const f of fc.features as Feature<Polygon | MultiPolygon>[]) {
    const p = f.properties as Record<string, unknown>;
    const iso3 = String(p.iso3);
    const c: Country = {
      iso3,
      iso2: (p.iso2 as string) ?? null,
      name: String(p.name),
      nameLong: String(p.nameLong),
      continent: String(p.continent),
      region: String(p.region),
      pop: typeof p.pop === 'number' ? p.pop : null,
      label: [Number(p.labelLon), Number(p.labelLat)],
      bbox: p.bbox as BBox,
    };
    out.list.push(c);
    out.byIso3.set(iso3, c);
    if (c.iso2) out.byIso2.set(c.iso2, c);
    for (const n of [p.name, p.nameLong, p.formal]) if (typeof n === 'string' && n) if (!out.byName.has(key(n))) out.byName.set(key(n), c);
    const idx = out.features.length;
    out.features.push({ country: c, geometry: f.geometry, bbox: c.bbox });
    const [w, s, e, n] = c.bbox;
    for (let x = Math.floor((w + 180) / GRID_DEG); x <= Math.min(35, Math.floor((e + 180) / GRID_DEG)); x++) {
      for (let y = Math.floor((s + 90) / GRID_DEG); y <= Math.min(17, Math.floor((n + 90) / GRID_DEG)); y++) {
        const k = y * 36 + x;
        let arr = out.grid.get(k);
        if (!arr) out.grid.set(k, (arr = []));
        arr.push(idx);
      }
    }
  }
  loaded = out;
  return out;
}

export function allCountries(): Country[] {
  return load().list;
}

export function countryByIso3(code: string): Country | null {
  return load().byIso3.get(code) ?? null;
}

/** Normalise an ISO alpha-2 / alpha-3 code or an English country name to the alpha-3 code used internally. null if unknown. */
export function toIso3(input: unknown): string | null {
  if (typeof input !== 'string') return null;
  const raw = input.trim();
  if (!raw) return null;
  const db = load();
  const up = raw.toUpperCase();
  if (ALIASES[up]) return ALIASES[up]!;
  if (up.length === 3 && db.byIso3.has(up)) return up;
  if (up.length === 2 && db.byIso2.has(up)) return db.byIso2.get(up)!.iso3;
  const k = key(raw);
  if (NAME_ALIASES[k]) return NAME_ALIASES[k]!;
  return db.byName.get(k)?.iso3 ?? null;
}

function containing(db: Loaded, lon: number, lat: number): string | null {
  const candidates = db.grid.get(cell(lon, lat));
  if (!candidates) return null;
  for (const i of candidates) {
    const f = db.features[i]!;
    const [w, s, e, n] = f.bbox;
    if (lon < w || lon > e || lat < s || lat > n) continue;
    if (pointInPolygonGeometry(lon, lat, f.geometry)) return f.country.iso3;
  }
  return null;
}

/** Offsets (degrees) probed when a point falls just outside every polygon: harbours, coastal airports, small islands. */
const NEAR_SHORE: [number, number][] = [];
for (const d of [0.08, 0.2]) for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1], [0.7, 0.7], [-0.7, 0.7], [0.7, -0.7], [-0.7, -0.7]] as const) NEAR_SHORE.push([dx * d, dy * d]);

/**
 * Which country contains this point? null over open ocean. The 1:50m coastline is generalised, so a point that misses
 * every polygon is retried within roughly 20 km before giving up. Near borders and coasts the answer is approximate –
 * callers record the result as derived.
 */
export function countryAt(lon: number, lat: number): string | null {
  const db = load();
  const hit = containing(db, lon, lat);
  if (hit) return hit;
  for (const [dx, dy] of NEAR_SHORE) {
    const near = containing(db, Math.max(-180, Math.min(180, lon + dx)), Math.max(-90, Math.min(90, lat + dy)));
    if (near) return near;
  }
  return null;
}

/** Find a country mentioned by name in free text (longest name wins). Used only where a source gives no structured location; callers must mark the result as derived. */
export function findCountryInText(text: string): string | null {
  const db = load();
  const hay = ` ${key(text).replace(/[^\p{L}\p{N}' ()-]+/gu, ' ')} `;
  let best: { iso3: string; len: number } | null = null;
  const consider = (name: string, iso3: string) => {
    if (name.length < 4) return;
    if (best && name.length <= best.len) return;
    const idx = hay.indexOf(name);
    if (idx < 0) return;
    const before = hay[idx - 1] ?? ' ';
    const after = hay[idx + name.length] ?? ' ';
    if (/[\p{L}\p{N}]/u.test(before) || /[\p{L}\p{N}]/u.test(after)) return;
    best = { iso3, len: name.length };
  };
  for (const [name, c] of db.byName) consider(name, c.iso3);
  for (const [name, iso3] of Object.entries(NAME_ALIASES)) consider(name, iso3);
  return (best as { iso3: string; len: number } | null)?.iso3 ?? null;
}
