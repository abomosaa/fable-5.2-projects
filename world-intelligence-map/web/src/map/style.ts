/** MapLibre style: a self-hosted Natural Earth basemap (works offline) plus the overlay layers fed by the API. */
import type { ExpressionSpecification, StyleSpecification } from 'maplibre-gl';
import { hexToRgba, slotColor, surface, type PaletteMode, type Theme } from '../palette';
import type { LayerInfo, Meta } from '../types';

export const FONT = ['Noto Sans Regular'];
const EMPTY = { type: 'FeatureCollection' as const, features: [] };

export const SRC = { points: 'wim-points', areas: 'wim-areas', lines: 'wim-lines', density: 'wim-density', bubbles: 'wim-bubbles', selection: 'wim-selection' } as const;

/** Layers that respond to pointer interaction, top-most first. */
export const INTERACTIVE = ['clusters', 'points', 'bubbles', 'paths', 'lines', 'areas-fill'];

function graticule(): GeoJSON.FeatureCollection {
  const features: GeoJSON.Feature[] = [];
  for (let lon = -180; lon <= 180; lon += 30) features.push({ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: Array.from({ length: 35 }, (_, i) => [lon, -85 + i * 5]) } });
  for (let lat = -60; lat <= 60; lat += 30) features.push({ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: [[-180, lat], [180, lat]] } });
  return { type: 'FeatureCollection', features };
}

function countryLabels(meta: Meta): GeoJSON.FeatureCollection {
  return {
    type: 'FeatureCollection',
    features: meta.countries
      .filter((c) => Number.isFinite(c.label[0]) && Number.isFinite(c.label[1]))
      .map((c) => {
        const area = Math.max(0.01, (c.bbox[2] - c.bbox[0]) * (c.bbox[3] - c.bbox[1]));
        return { type: 'Feature' as const, properties: { name: c.name, iso3: c.iso3, rank: area > 400 ? 1 : area > 60 ? 2 : area > 8 ? 3 : 4 }, geometry: { type: 'Point' as const, coordinates: c.label } };
      }),
  };
}

export function buildStyle(meta: Meta, theme: Theme): StyleSpecification {
  const s = surface(theme);
  return {
    version: 8,
    name: 'wim-offline',
    glyphs: `${location.origin}/glyphs/{fontstack}/{range}.pbf`,
    sources: {
      countries: { type: 'geojson', data: '/basemap/countries.geojson', promoteId: 'iso3', attribution: 'Basemap: Natural Earth' },
      graticule: { type: 'geojson', data: graticule() },
      'country-labels': { type: 'geojson', data: countryLabels(meta) },
      [SRC.points]: { type: 'geojson', data: EMPTY },
      [SRC.areas]: { type: 'geojson', data: EMPTY },
      [SRC.lines]: { type: 'geojson', data: EMPTY },
      [SRC.density]: { type: 'geojson', data: EMPTY },
      [SRC.bubbles]: { type: 'geojson', data: EMPTY },
      [SRC.selection]: { type: 'geojson', data: EMPTY },
    },
    layers: [
      { id: 'bg', type: 'background', paint: { 'background-color': s.water } },
      { id: 'graticule', type: 'line', source: 'graticule', paint: { 'line-color': s.graticule, 'line-width': 0.6 } },
      { id: 'land', type: 'fill', source: 'countries', paint: { 'fill-color': s.land } },
      { id: 'choro', type: 'fill', source: 'countries', paint: { 'fill-color': 'rgba(0,0,0,0)', 'fill-opacity': 0.88 } },
      { id: 'borders', type: 'line', source: 'countries', paint: { 'line-color': s.border, 'line-width': ['interpolate', ['linear'], ['zoom'], 1, 0.4, 5, 1, 9, 1.6] } },
      { id: 'areas-fill', type: 'fill', source: SRC.areas, paint: { 'fill-color': '#888', 'fill-opacity': 0.22 } },
      { id: 'areas-line', type: 'line', source: SRC.areas, paint: { 'line-color': '#888', 'line-width': 1.4 } },
      { id: 'lines', type: 'line', source: SRC.lines, filter: ['!=', ['get', 'path'], 1], layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': '#888', 'line-width': ['interpolate', ['linear'], ['zoom'], 1, 1.1, 6, 2.2] } },
      { id: 'paths', type: 'line', source: SRC.lines, filter: ['==', ['get', 'path'], 1], layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': '#888', 'line-width': 1.4, 'line-dasharray': [2, 1.5], 'line-opacity': 0.85 } },
      { id: 'bubbles', type: 'circle', source: SRC.bubbles, paint: { 'circle-radius': ['get', 'r'], 'circle-color': '#888', 'circle-opacity': 0.5, 'circle-stroke-width': 1.5, 'circle-stroke-color': '#888' } },
      { id: 'sel-fill', type: 'fill', source: SRC.selection, filter: ['==', ['geometry-type'], 'Polygon'], paint: { 'fill-color': s.ink, 'fill-opacity': 0.12 } },
      { id: 'sel-line', type: 'line', source: SRC.selection, filter: ['!=', ['geometry-type'], 'Point'], paint: { 'line-color': s.ink, 'line-width': 3 } },
      { id: 'sel-ring', type: 'circle', source: SRC.selection, filter: ['==', ['geometry-type'], 'Point'], paint: { 'circle-radius': 17, 'circle-color': 'rgba(0,0,0,0)', 'circle-stroke-width': 3, 'circle-stroke-color': s.ink } },
      {
        id: 'points', type: 'symbol', source: SRC.points, filter: ['==', ['get', 'k'], 'p'],
        layout: {
          'icon-image': ['concat', 'ic-', ['get', 'l']],
          'icon-size': ['interpolate', ['linear'], ['get', 's'], -1, 0.62, 0, 0.58, 1, 0.68, 2, 0.8, 3, 0.95, 4, 1.12],
          'icon-allow-overlap': true,
          'icon-ignore-placement': true,
          'icon-rotate': ['coalesce', ['get', 'h'], 0],
          'icon-rotation-alignment': 'map',
          'symbol-sort-key': ['get', 's'],
        },
        // stale and expired records are visibly dimmed, never silently shown as live
        paint: { 'icon-opacity': ['match', ['get', 'f'], 3, 0.55, 4, 0.5, 1] },
      },
      {
        id: 'clusters', type: 'circle', source: SRC.points, filter: ['==', ['get', 'k'], 'c'],
        paint: {
          'circle-radius': ['step', ['get', 'n'], 11, 10, 14, 50, 17, 250, 21, 1000, 25, 5000, 30],
          'circle-color': '#888',
          'circle-opacity': 0.88,
          'circle-stroke-width': 2,
          'circle-stroke-color': s.land,
        },
      },
      {
        id: 'cluster-count', type: 'symbol', source: SRC.points, filter: ['==', ['get', 'k'], 'c'],
        layout: { 'text-field': ['get', 'nl'], 'text-font': FONT, 'text-size': 11.5, 'text-allow-overlap': true, 'text-ignore-placement': true },
        paint: { 'text-color': '#ffffff', 'text-halo-color': 'rgba(0,0,0,0.55)', 'text-halo-width': 1.1 },
      },
      {
        id: 'country-labels', type: 'symbol', source: 'country-labels',
        filter: ['<=', ['get', 'rank'], ['step', ['zoom'], 1, 2, 2, 3.2, 3, 4.5, 4]],
        layout: { 'text-field': ['get', 'name'], 'text-font': FONT, 'text-size': ['interpolate', ['linear'], ['zoom'], 1, 10, 6, 14], 'text-max-width': 7, 'text-padding': 6 },
        paint: { 'text-color': s.label, 'text-halo-color': s.halo, 'text-halo-width': 1.3, 'text-opacity': 0.9 },
      },
    ],
  };
}

export function layerColorExpr(layers: LayerInfo[], theme: Theme, palette: PaletteMode, alpha?: number): ExpressionSpecification | string {
  if (!layers.length) return '#888888';
  const e: unknown[] = ['match', ['get', 'l']];
  for (const l of layers) {
    const c = slotColor(l.render.color, theme, palette);
    e.push(l.id, alpha == null ? c : hexToRgba(c, alpha));
  }
  e.push('#888888');
  return e as ExpressionSpecification;
}

export function heatColorExpr(color: string): ExpressionSpecification {
  return ['interpolate', ['linear'], ['heatmap-density'], 0, 'rgba(0,0,0,0)', 0.15, hexToRgba(color, 0.35), 0.45, hexToRgba(color, 0.7), 0.8, hexToRgba(color, 0.92), 1, '#ffffff'] as ExpressionSpecification;
}
