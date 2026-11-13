#!/usr/bin/env node
/**
 * Rebuilds the bundled static assets (committed to the repo so that the app, tests and CI work offline):
 *   server/assets/ne/countries.geojson – Natural Earth 1:50m admin-0 countries, trimmed (public domain)
 *   server/assets/glyphs/Noto Sans Regular/*.pbf – SDF glyph ranges for map labels (SIL OFL 1.1)
 *
 * Usage: node scripts/build-assets.mjs        (requires internet; only needed to refresh assets)
 */
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const NE = 'https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson';
const GLYPHS = 'https://protomaps.github.io/basemaps-assets/fonts/Noto%20Sans%20Regular';
const RANGES = ['0-255', '256-511', '512-767', '768-1023', '1024-1279', '7680-7935', '8192-8447'];

const round = (n, d = 3) => Math.round(n * 10 ** d) / 10 ** d;
function roundCoords(c) {
  if (typeof c[0] === 'number') return [round(c[0]), round(c[1])];
  const out = c.map(roundCoords);
  // drop consecutive duplicates produced by rounding
  if (typeof out[0]?.[0] === 'number') return out.filter((p, i) => i === 0 || p[0] !== out[i - 1][0] || p[1] !== out[i - 1][1]);
  return out;
}
function bboxOf(geom) {
  let w = 180, s = 90, e = -180, n = -90;
  const walk = (c) => {
    if (typeof c[0] === 'number') { w = Math.min(w, c[0]); e = Math.max(e, c[0]); s = Math.min(s, c[1]); n = Math.max(n, c[1]); }
    else c.forEach(walk);
  };
  walk(geom.coordinates);
  return [round(w), round(s), round(e), round(n)];
}
const code = (...vals) => vals.find((v) => typeof v === 'string' && v !== '-99' && v.trim() !== '') ?? null;

async function countries() {
  const res = await fetch(`${NE}/ne_50m_admin_0_countries.geojson`);
  if (!res.ok) throw new Error(`natural earth: ${res.status}`);
  const fc = await res.json();
  const features = fc.features.map((f) => {
    const p = f.properties;
    const geometry = { type: f.geometry.type, coordinates: roundCoords(f.geometry.coordinates) };
    // drop degenerate rings
    if (geometry.type === 'Polygon') geometry.coordinates = geometry.coordinates.filter((r) => r.length >= 4);
    else geometry.coordinates = geometry.coordinates.map((poly) => poly.filter((r) => r.length >= 4)).filter((poly) => poly.length);
    return {
      type: 'Feature',
      id: p.NE_ID,
      properties: {
        iso3: code(p.ISO_A3_EH, p.ISO_A3, p.ADM0_A3),
        iso2: code(p.ISO_A2_EH, p.ISO_A2),
        adm0: p.ADM0_A3,
        name: p.NAME,
        nameLong: p.NAME_LONG,
        formal: p.FORMAL_EN || null,
        continent: p.CONTINENT,
        region: p.SUBREGION,
        type: p.TYPE,
        pop: p.POP_EST ?? null,
        labelLon: round(p.LABEL_X ?? 0, 2),
        labelLat: round(p.LABEL_Y ?? 0, 2),
        labelRank: p.LABELRANK ?? 5,
        bbox: bboxOf(geometry),
      },
      geometry,
    };
  });
  // Dependencies that share their sovereign's ISO code (e.g. Ashmore & Cartier Is. → AUS) keep their own ADM0 code
  // so that ISO alpha-3 stays a unique key for choropleth joins.
  const seen = new Map();
  for (const f of features) seen.set(f.properties.iso3, (seen.get(f.properties.iso3) ?? 0) + 1);
  for (const f of features) {
    if (seen.get(f.properties.iso3) > 1 && f.properties.adm0 !== f.properties.iso3) {
      f.properties.iso3 = f.properties.adm0;
      f.properties.iso2 = null;
    }
  }
  features.sort((a, b) => String(a.properties.iso3).localeCompare(String(b.properties.iso3)));
  const out = {
    type: 'FeatureCollection',
    attribution: 'Made with Natural Earth. Free vector and raster map data @ naturalearthdata.com (public domain).',
    features,
  };
  const dir = path.join(root, 'server/assets/ne');
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, 'countries.geojson'), JSON.stringify(out));
  console.log(`countries: ${features.length} features`);
}

async function glyphs() {
  const dir = path.join(root, 'server/assets/glyphs/Noto Sans Regular');
  await mkdir(dir, { recursive: true });
  for (const r of RANGES) {
    const res = await fetch(`${GLYPHS}/${r}.pbf`);
    if (!res.ok) throw new Error(`glyphs ${r}: ${res.status}`);
    await writeFile(path.join(dir, `${r}.pbf`), Buffer.from(await res.arrayBuffer()));
  }
  console.log(`glyphs: ${RANGES.length} ranges`);
}

await countries();
await glyphs();
