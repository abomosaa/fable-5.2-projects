import maplibregl, { type GeoJSONSource, type Map as MlMap, type MapGeoJSONFeature } from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import { useEffect, useRef } from 'react';
import { api, ApiError, filterParams } from '../api';
import { choroClasses, classIndex } from '../lib/choropleth';
import { fmtCount, fmtNumber } from '../lib/format';
import { slotColor, surface } from '../palette';
import { choroplethRoles, layerMap, useStore } from '../state/store';
import type { ChoroplethLayer, FeaturesResponse, LayerInfo, Meta } from '../types';
import { drawIcon } from './icons';
import { buildStyle, heatColorExpr, INTERACTIVE, layerColorExpr, SRC } from './style';

const EMPTY: GeoJSON.FeatureCollection = { type: 'FeatureCollection', features: [] };
type BBox = [number, number, number, number];

declare global {
  interface Window {
    /** Test and debugging hook. */
    __wim?: { map: MlMap; store: typeof useStore; ready: boolean; lastFeatures: FeaturesResponse | null; fetchCount: number; applied: number };
  }
}

function boundsOf(map: MlMap): BBox {
  const b = map.getBounds();
  return [b.getWest(), Math.max(-90, b.getSouth()), b.getEast(), Math.min(90, b.getNorth())];
}

export function MapView({ meta }: { meta: Meta }) {
  const container = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MlMap | null>(null);

  useEffect(() => {
    if (!container.current) return;
    const store = useStore;
    const initial = store.getState();
    const layers = layerMap(meta);
    let disposed = false;

    const map = new maplibregl.Map({
      container: container.current,
      style: buildStyle(meta, initial.theme),
      center: [initial.view.lng, initial.view.lat],
      zoom: initial.view.zoom,
      minZoom: 0.6,
      maxZoom: 16,
      attributionControl: false,
      dragRotate: false,
      pitchWithRotate: false,
      touchPitch: false,
      renderWorldCopies: true,
      fadeDuration: 0,
    });
    mapRef.current = map;
    map.touchZoomRotate.disableRotation();
    map.keyboard.enable();
    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');
    map.addControl(new maplibregl.ScaleControl({ maxWidth: 110 }), 'bottom-right');
    map.addControl(new maplibregl.AttributionControl({ compact: true, customAttribution: 'Data: see Sources panel for attribution & licences' }), 'bottom-right');
    const canvas = map.getCanvas();
    canvas.setAttribute('aria-label', 'World map. Use arrow keys to pan and plus or minus to zoom. Records are also listed in the Results panel.');
    canvas.setAttribute('role', 'application');

    const hook = { map, store, ready: false, lastFeatures: null as FeaturesResponse | null, fetchCount: 0, applied: 0 };
    window.__wim = hook;

    const popup = new maplibregl.Popup({ closeButton: false, closeOnClick: false, offset: 12, className: 'wim-tip', maxWidth: '280px' });

    // ───────────────────────── appearance (theme / palette / enabled layers) ─────────────────────────
    const heatLayers = new Set<string>();

    const applyAppearance = () => {
      if (disposed || !hook.ready) return;
      const s = store.getState();
      const sf = surface(s.theme);
      const all = meta.layers;
      const enabled = (s.enabled ?? []).map((id) => layers.get(id)).filter((l): l is LayerInfo => !!l);

      map.setPaintProperty('bg', 'background-color', sf.water);
      map.setPaintProperty('graticule', 'line-color', sf.graticule);
      map.setPaintProperty('land', 'fill-color', sf.land);
      map.setPaintProperty('borders', 'line-color', sf.border);
      map.setPaintProperty('country-labels', 'text-color', sf.label);
      map.setPaintProperty('country-labels', 'text-halo-color', sf.halo);
      map.setPaintProperty('clusters', 'circle-stroke-color', sf.land);
      map.setPaintProperty('sel-fill', 'fill-color', sf.ink);
      map.setPaintProperty('sel-line', 'line-color', sf.ink);
      map.setPaintProperty('sel-ring', 'circle-stroke-color', sf.ink);

      const color = layerColorExpr(all, s.theme, s.palette);
      map.setPaintProperty('areas-fill', 'fill-color', color);
      map.setPaintProperty('areas-line', 'line-color', color);
      map.setPaintProperty('lines', 'line-color', color);
      map.setPaintProperty('paths', 'line-color', color);
      map.setPaintProperty('clusters', 'circle-color', color);
      map.setPaintProperty('bubbles', 'circle-color', color);
      map.setPaintProperty('bubbles', 'circle-stroke-color', color);

      // one icon per layer: shape + colour
      for (const l of all) {
        const name = `ic-${l.id}`;
        const img = drawIcon(l.render.shape ?? 'circle', slotColor(l.render.color, s.theme, s.palette), s.theme === 'dark' ? '#0c1117' : '#ffffff');
        if (!img) continue;
        if (map.hasImage(name)) map.updateImage(name, img);
        else map.addImage(name, img, { pixelRatio: 2 });
      }

      // Only enabled layers may render. The layer filter makes this immediate, independent of the next server response.
      const ids = enabled.map((l) => l.id);
      const on: maplibregl.ExpressionSpecification = ['in', ['get', 'l'], ['literal', ids]];
      map.setFilter('points', ['all', ['==', ['get', 'k'], 'p'], on]);
      map.setFilter('areas-fill', on);
      map.setFilter('areas-line', on);
      map.setFilter('lines', ['all', ['!=', ['get', 'path'], 1], on]);
      map.setFilter('paths', ['all', ['==', ['get', 'path'], 1], on]);
      map.setFilter('bubbles', on);

      // one heat-map layer per enabled density layer (each with its own single-hue ramp)
      const wanted = new Set(enabled.filter((l) => l.render.type === 'heatmap').map((l) => l.id));
      for (const id of [...heatLayers]) {
        if (!wanted.has(id) && map.getLayer(`heat-${id}`)) {
          map.removeLayer(`heat-${id}`);
          heatLayers.delete(id);
        }
      }
      for (const id of wanted) {
        const l = layers.get(id)!;
        const lid = `heat-${id}`;
        const ramp = heatColorExpr(slotColor(l.render.color, s.theme, s.palette));
        if (!map.getLayer(lid)) {
          map.addLayer(
            {
              id: lid, type: 'heatmap', source: SRC.density, filter: ['==', ['get', 'l'], id],
              paint: {
                'heatmap-weight': ['interpolate', ['linear'], ['get', 'w'], 1, 0.25, 8, 0.7, 40, 1],
                'heatmap-intensity': ['interpolate', ['linear'], ['zoom'], 0, 0.7, 6, 1.6],
                'heatmap-radius': ['interpolate', ['linear'], ['zoom'], 0, 7, 4, 12, 8, 22],
                'heatmap-opacity': 0.85,
                'heatmap-color': ramp,
              },
            },
            'bubbles',
          );
          heatLayers.add(id);
        } else map.setPaintProperty(lid, 'heatmap-color', ramp);
      }
      applyChoropleth();
    };

    // ───────────────────────── choropleth fill + bubbles ─────────────────────────
    const applyChoropleth = () => {
      if (disposed || !hook.ready) return;
      const s = store.getState();
      const roles = choroplethRoles(s.enabled ?? [], layers);
      const data = s.choropleth;
      let expr: unknown = 'rgba(0,0,0,0)';
      const fill = roles.fill ? data[roles.fill] : undefined;
      if (fill) {
        const cls = choroClasses(fill, s.theme);
        if (cls) {
          const groups: string[][] = cls.colors.map(() => []);
          for (const [iso, v] of Object.entries(fill.values)) groups[classIndex(v.v, cls.thresholds)]!.push(iso);
          const e: unknown[] = ['match', ['get', 'iso3']];
          groups.forEach((g, i) => {
            if (g.length) e.push(g, cls.colors[i]);
          });
          e.push('rgba(0,0,0,0)');
          if (e.length > 3) expr = e;
        }
      }
      map.setPaintProperty('choro', 'fill-color', expr as maplibregl.ExpressionSpecification);

      const features: GeoJSON.Feature[] = [];
      const byIso = new Map(meta.countries.map((c) => [c.iso3, c]));
      for (const id of roles.bubbles) {
        const d: ChoroplethLayer | undefined = data[id];
        if (!d || d.max == null || d.min == null) continue;
        const log = d.transform === 'log';
        const tf = (v: number) => (log ? Math.log10(Math.max(v, 1e-9)) : v);
        const lo = tf(d.scale === 'diverging' ? 0 : d.min);
        const hi = tf(d.scale === 'diverging' ? Math.max(Math.abs(d.min), Math.abs(d.max)) : d.max);
        for (const [iso, v] of Object.entries(d.values)) {
          const c = byIso.get(iso);
          if (!c) continue;
          const t = hi > lo ? (tf(d.scale === 'diverging' ? Math.abs(v.v) : v.v) - lo) / (hi - lo) : 0.5;
          features.push({
            type: 'Feature',
            geometry: { type: 'Point', coordinates: c.label },
            properties: { id: v.id, l: id, r: 4 + Math.sqrt(Math.max(0, Math.min(1, t))) * 16, t: `${c.name}: ${fmtNumber(v.v, d.unit)}${v.p ? ` (${v.p})` : ''}` },
          });
        }
      }
      (map.getSource(SRC.bubbles) as GeoJSONSource | undefined)?.setData({ type: 'FeatureCollection', features });
    };

    // ───────────────────────── data ─────────────────────────
    let seq = 0;
    let inflight: AbortController | null = null;
    let busy = false;
    let queued = false;
    let debounce: ReturnType<typeof setTimeout> | undefined;

    const setData = (id: string, data: GeoJSON.FeatureCollection) => (map.getSource(id) as GeoJSONSource | undefined)?.setData(data);

    const clearAll = () => {
      for (const id of [SRC.points, SRC.areas, SRC.lines, SRC.density, SRC.bubbles]) setData(id, EMPTY);
      map.setPaintProperty('choro', 'fill-color', 'rgba(0,0,0,0)');
      hook.lastFeatures = null;
    };

    /** Drop already-rendered features of layers that were just disabled, without waiting for the server. */
    const pruneDisabled = (enabledIds: string[]) => {
      const last = hook.lastFeatures;
      if (!last) return;
      const on = new Set(enabledIds);
      const points = last.points.features.filter((f) => {
        const p = f.properties as { k: string; l: string; ls?: string };
        if (p.k === 'p') return on.has(p.l);
        // a cluster that contains any disabled layer is removed; the refetch brings back an exact one
        return (p.ls ?? '').split(',').every((part) => on.has(part.split(':')[0]!));
      });
      const keep = (fc: GeoJSON.FeatureCollection) => ({ ...fc, features: fc.features.filter((f) => on.has((f.properties as { l: string }).l)) });
      const next = { ...last, points: { ...last.points, features: points }, areas: keep(last.areas), lines: keep(last.lines), density: keep(last.density) };
      hook.lastFeatures = next;
      setData(SRC.points, next.points);
      setData(SRC.areas, next.areas);
      setData(SRC.lines, next.lines);
      setData(SRC.density, next.density);
    };

    const refresh = (opts: { preferQueue?: boolean } = {}) => {
      if (disposed || !hook.ready) return;
      const s = store.getState();
      const enabled = s.enabled;
      if (enabled == null) return;
      if (enabled.length === 0) {
        // All layers off: nothing is requested and nothing but the basemap stays on the map.
        seq++;
        inflight?.abort();
        inflight = null;
        busy = false;
        queued = false;
        clearAll();
        s.setChoropleth({});
        s.setMapStatus({ loading: false, error: null, counts: {}, total: 0, hiddenByZoom: [], truncated: false, lastUpdated: Date.now(), queryMs: null });
        return;
      }
      // During playback, let the frame in flight finish and then render the newest state (frame dropping, no request pile-up).
      if (opts.preferQueue && busy) {
        queued = true;
        return;
      }
      const mySeq = ++seq;
      inflight?.abort(); // an obsolete request must never overwrite newer state
      const ac = new AbortController();
      inflight = ac;
      busy = true;
      queued = false;
      hook.fetchCount++;
      s.setMapStatus({ loading: true });
      const params = filterParams(enabled, s.filters, s.time);
      const needChoro = enabled.some((id) => layers.get(id)?.render.type === 'choropleth');
      const needFeatures = enabled.some((id) => layers.get(id)?.render.type !== 'choropleth');
      Promise.all([
        needFeatures ? api.features(params, boundsOf(map), map.getZoom(), ac.signal) : Promise.resolve(null),
        needChoro ? api.choropleth(params, ac.signal) : Promise.resolve(null),
      ])
        .then(([f, c]) => {
          if (disposed || mySeq !== seq) return; // superseded
          if (f) {
            for (const feat of f.points.features) {
              const p = feat.properties as { k: string; n?: number; nl?: string };
              if (p.k === 'c') p.nl = fmtCount(p.n ?? 0);
            }
            setData(SRC.points, f.points);
            setData(SRC.areas, f.areas);
            setData(SRC.lines, f.lines);
            setData(SRC.density, f.density);
            hook.lastFeatures = f;
          } else {
            for (const id of [SRC.points, SRC.areas, SRC.lines, SRC.density]) setData(id, EMPTY);
            hook.lastFeatures = null;
          }
          const counts: Record<string, number> = { ...(f?.counts ?? {}) };
          if (c) for (const [id, d] of Object.entries(c.layers)) counts[id] = Object.keys(d.values).length;
          store.getState().setChoropleth(c?.layers ?? {});
          applyChoropleth();
          hook.applied++;
          store.getState().setMapStatus({
            loading: false, error: null, counts, total: Object.values(counts).reduce((a, b) => a + b, 0), hiddenByZoom: f?.hiddenByZoom ?? [],
            truncated: !!(f?.truncated.areas || f?.truncated.lines), lastUpdated: Date.now(), queryMs: f?.ms ?? null,
          });
        })
        .catch((err: unknown) => {
          if ((err as Error).name === 'AbortError' || disposed || mySeq !== seq) return;
          // Keep whatever is on the map (partial results beat a blank screen) and say what went wrong.
          store.getState().setMapStatus({ loading: false, error: err instanceof ApiError ? err.message : 'Could not load map data.' });
        })
        .finally(() => {
          if (mySeq === seq) {
            busy = false;
            inflight = null;
            if (queued) refresh();
          }
        });
    };

    const scheduleRefresh = (ms = 120) => {
      clearTimeout(debounce);
      debounce = setTimeout(() => refresh(), ms);
    };

    // ───────────────────────── wiring ─────────────────────────
    const unsub: (() => void)[] = [];

    map.on('load', () => {
      hook.ready = true;
      applyAppearance();
      store.getState().setView({ lng: map.getCenter().lng, lat: map.getCenter().lat, zoom: map.getZoom() }, boundsOf(map));
      refresh();

      unsub.push(
        store.subscribe((s) => s.enabled, (enabled, prev) => {
          applyAppearance();
          if (enabled && prev && prev.some((id) => !enabled.includes(id))) pruneDisabled(enabled);
          refresh(); // immediately: toggles should feel instant
        }),
        store.subscribe((s) => s.filters, () => scheduleRefresh(180)),
        store.subscribe((s) => s.time, () => (store.getState().playing ? refresh({ preferQueue: true }) : scheduleRefresh(60))),
        store.subscribe((s) => s.dataVersion, () => scheduleRefresh(300)),
        store.subscribe((s) => [s.theme, s.palette] as const, applyAppearance, { equalityFn: (a, b) => a[0] === b[0] && a[1] === b[1] }),
        store.subscribe((s) => s.selectionGeo, (geo) => setData(SRC.selection, geo ?? EMPTY)),
        store.subscribe((s) => s.flyTo, (t) => {
          if (!t) return;
          if (t.bbox) map.fitBounds([[t.bbox[0], t.bbox[1]], [t.bbox[2], t.bbox[3]]], { padding: 80, maxZoom: 9, duration: 700 });
          else map.flyTo({ center: [t.lng, t.lat], zoom: t.zoom ?? Math.max(map.getZoom(), 4), duration: 700 });
        }),
      );
      const geo = store.getState().selectionGeo;
      if (geo) setData(SRC.selection, geo);
    });

    map.on('moveend', () => {
      const c = map.getCenter();
      store.getState().setView({ lng: Number(c.lng.toFixed(5)), lat: Number(c.lat.toFixed(5)), zoom: Number(map.getZoom().toFixed(2)) }, boundsOf(map));
      scheduleRefresh(140);
    });

    // In live mode the time window slides forward: refresh periodically even without server events.
    const liveTimer = setInterval(() => {
      if (store.getState().time.mode === 'live' && document.visibilityState === 'visible') refresh({ preferQueue: true });
    }, 60_000);

    // pointer interaction
    const hit = (point: maplibregl.Point): MapGeoJSONFeature | undefined => {
      const box: [maplibregl.PointLike, maplibregl.PointLike] = [[point.x - 4, point.y - 4], [point.x + 4, point.y + 4]];
      const existing = INTERACTIVE.filter((id) => map.getLayer(id));
      const feats = map.queryRenderedFeatures(box, { layers: existing });
      if (!feats.length) return undefined;
      // prefer the top-most interactive layer; within it the most severe item
      feats.sort((a, b) => INTERACTIVE.indexOf(a.layer.id) - INTERACTIVE.indexOf(b.layer.id) || Number(b.properties?.s ?? -1) - Number(a.properties?.s ?? -1));
      return feats[0];
    };

    const describe = (f: MapGeoJSONFeature): string => {
      const p = f.properties as Record<string, unknown>;
      if (p.k === 'c') {
        const parts = String(p.ls ?? '').split(',').filter(Boolean).map((x) => {
          const [id, n] = x.split(':');
          return `${layers.get(id!)?.name ?? id}: ${n}`;
        });
        return `${p.n} records\n${parts.join('\n')}`;
      }
      const layer = layers.get(String(p.l));
      return `${String(p.t ?? '')}${layer ? `\n${layer.name}` : ''}`;
    };

    map.on('mousemove', (e) => {
      const f = hit(e.point);
      if (f) {
        canvas.style.cursor = 'pointer';
        popup.setLngLat(e.lngLat).setText(describe(f)).addTo(map);
        return;
      }
      // country fill
      const s = store.getState();
      const roles = choroplethRoles(s.enabled ?? [], layers);
      if (roles.fill && s.choropleth[roles.fill]) {
        const cf = map.queryRenderedFeatures(e.point, { layers: ['choro'] })[0];
        const iso = cf?.properties?.iso3 as string | undefined;
        const d = s.choropleth[roles.fill]!;
        const v = iso ? d.values[iso] : undefined;
        if (cf && v) {
          canvas.style.cursor = 'pointer';
          popup.setLngLat(e.lngLat).setText(`${String(cf.properties?.name)}\n${d.name}: ${fmtNumber(v.v, d.unit)}${v.p ? ` (${v.p})` : ''}`).addTo(map);
          return;
        }
      }
      canvas.style.cursor = '';
      popup.remove();
    });
    map.on('mouseout', () => popup.remove());

    map.on('click', (e) => {
      const s = store.getState();
      const f = hit(e.point);
      if (f) {
        const p = f.properties as Record<string, unknown>;
        if (p.k === 'c') {
          const bb = String(p.bb).split(',').map(Number) as BBox;
          const tiny = Math.abs(bb[2] - bb[0]) < 0.02 && Math.abs(bb[3] - bb[1]) < 0.02;
          if (tiny || map.getZoom() >= 10) {
            // members share (almost) one location: list them instead of zooming forever
            const pad = 0.01;
            s.setClusterFocus({ bbox: [bb[0] - pad, bb[1] - pad, bb[2] + pad, bb[3] + pad], count: Number(p.n) });
          } else {
            map.fitBounds([[bb[0], bb[1]], [bb[2], bb[3]]], { padding: 90, maxZoom: Math.min(14, map.getZoom() + 4), duration: 600 });
          }
          return;
        }
        if (typeof p.id === 'string') s.select(p.id);
        return;
      }
      const roles = choroplethRoles(s.enabled ?? [], layers);
      if (roles.fill && s.choropleth[roles.fill]) {
        const cf = map.queryRenderedFeatures(e.point, { layers: ['choro'] })[0];
        const v = cf ? s.choropleth[roles.fill]!.values[String(cf.properties?.iso3)] : undefined;
        if (v) s.select(v.id);
      }
    });

    const ro = new ResizeObserver(() => map.resize());
    ro.observe(container.current);

    return () => {
      disposed = true;
      clearTimeout(debounce);
      clearInterval(liveTimer);
      inflight?.abort();
      unsub.forEach((u) => u());
      ro.disconnect();
      popup.remove();
      map.remove();
      mapRef.current = null;
    };
  }, [meta]);

  return <div ref={container} className="map" data-testid="map" />;
}
