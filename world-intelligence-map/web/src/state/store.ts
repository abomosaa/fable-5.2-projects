import { create } from 'zustand';
import { subscribeWithSelector } from 'zustand/middleware';
import { serverNow } from '../api';
import type { PaletteMode, Theme } from '../palette';
import { DEFAULT_FILTERS, type ChoroplethLayer, type Filters, type LayerInfo, type Meta, type SourceEntry, type TimeState, type ViewState } from '../types';
import { decodeState, encodeState } from './url';

export type Panel = 'layers' | 'filters' | 'feed' | 'sources';
type BBox = [number, number, number, number];

export interface MapStatus {
  loading: boolean;
  error: string | null;
  counts: Record<string, number>;
  total: number;
  hiddenByZoom: string[];
  truncated: boolean;
  lastUpdated: number | null;
  queryMs: number | null;
}

export interface Toast {
  id: number;
  kind: 'info' | 'warn' | 'error';
  text: string;
}

export interface AppState {
  meta: Meta | null;
  metaError: string | null;
  /** Enabled layer ids in the order they were switched on. null until initial state is resolved. */
  enabled: string[] | null;
  filters: Filters;
  time: TimeState;
  playing: boolean;
  speed: number;
  view: ViewState;
  viewBbox: BBox | null;
  selected: string | null;
  theme: Theme;
  palette: PaletteMode;
  panel: Panel | null;
  legendOpen: boolean;
  timelineOpen: boolean;
  mapStatus: MapStatus;
  choropleth: Record<string, ChoroplethLayer>;
  sources: SourceEntry[];
  sourcesError: string | null;
  /** Bumped when server-side data changed (SSE) or a manual refresh is requested. */
  dataVersion: number;
  /** When set, the results panel lists the contents of this cluster. */
  clusterFocus: { bbox: BBox; count: number } | null;
  /** One-shot camera request consumed by the map. */
  flyTo: { lng: number; lat: number; zoom?: number; bbox?: BBox; nonce: number } | null;
  toasts: Toast[];
  liveConnected: boolean;
  /** Geometry of the selected record, drawn as a highlight on the map. */
  selectionGeo: GeoJSON.FeatureCollection | null;

  setMeta(meta: Meta): void;
  toggleLayer(id: string, on?: boolean): void;
  setLayers(ids: string[], on: boolean): void;
  allLayersOff(): void;
  resetLayers(): void;
  setFilters(patch: Partial<Filters>): void;
  resetFilters(): void;
  setTime(time: TimeState): void;
  setPlaying(playing: boolean): void;
  setSpeed(speed: number): void;
  setView(view: ViewState, bbox: BBox): void;
  select(id: string | null): void;
  setTheme(theme: Theme): void;
  setPalette(palette: PaletteMode): void;
  setPanel(panel: Panel | null): void;
  setLegendOpen(open: boolean): void;
  setTimelineOpen(open: boolean): void;
  setMapStatus(patch: Partial<MapStatus>): void;
  setChoropleth(c: Record<string, ChoroplethLayer>): void;
  setSources(s: SourceEntry[], error?: string | null): void;
  bumpData(): void;
  setClusterFocus(focus: AppState['clusterFocus']): void;
  requestFly(target: Omit<NonNullable<AppState['flyTo']>, 'nonce'>): void;
  toast(kind: Toast['kind'], text: string): void;
  dismissToast(id: number): void;
  setLiveConnected(v: boolean): void;
}

const STORAGE_KEY = 'wim.prefs.v1';

interface Persisted {
  enabled?: string[];
  theme?: Theme;
  palette?: PaletteMode;
  legendOpen?: boolean;
  liveWindowSec?: number;
}

function loadPersisted(): Persisted {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const p = JSON.parse(raw) as Persisted;
    return {
      enabled: Array.isArray(p.enabled) ? p.enabled.filter((x) => typeof x === 'string') : undefined,
      theme: p.theme === 'light' || p.theme === 'dark' ? p.theme : undefined,
      palette: p.palette === 'cvd' || p.palette === 'standard' ? p.palette : undefined,
      legendOpen: typeof p.legendOpen === 'boolean' ? p.legendOpen : undefined,
      liveWindowSec: typeof p.liveWindowSec === 'number' && p.liveWindowSec >= 60 ? p.liveWindowSec : undefined,
    };
  } catch {
    return {};
  }
}

function savePersisted(s: AppState): void {
  if (s.enabled == null) return;
  try {
    const p: Persisted = { enabled: s.enabled, theme: s.theme, palette: s.palette, legendOpen: s.legendOpen, liveWindowSec: s.time.mode === 'live' ? s.time.windowSec : undefined };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(p));
  } catch {
    /* storage unavailable (private mode) – toggles still work for the session */
  }
}

const persisted = typeof localStorage !== 'undefined' ? loadPersisted() : {};
const fromUrl = typeof location !== 'undefined' ? decodeState(location.hash) : {};
const prefersLight = typeof matchMedia !== 'undefined' && matchMedia('(prefers-color-scheme: light)').matches;
const wide = typeof innerWidth !== 'undefined' ? innerWidth >= 900 : true;

let toastSeq = 1;
let flySeq = 1;

export const useStore = create<AppState>()(
  subscribeWithSelector((set, get) => ({
    meta: null,
    metaError: null,
    enabled: fromUrl.layers ?? persisted.enabled ?? null,
    filters: fromUrl.filters ?? { ...DEFAULT_FILTERS },
    time: fromUrl.time ?? { mode: 'live', windowSec: persisted.liveWindowSec ?? 7 * 86400 },
    playing: false,
    speed: 1,
    view: fromUrl.view ?? { lng: 12, lat: 22, zoom: wide ? 1.7 : 0.8 },
    viewBbox: null,
    selected: fromUrl.selected ?? null,
    theme: fromUrl.theme ?? persisted.theme ?? (prefersLight ? 'light' : 'dark'),
    palette: fromUrl.palette ?? persisted.palette ?? 'standard',
    panel: wide ? 'layers' : null,
    legendOpen: persisted.legendOpen ?? wide,
    timelineOpen: wide,
    mapStatus: { loading: false, error: null, counts: {}, total: 0, hiddenByZoom: [], truncated: false, lastUpdated: null, queryMs: null },
    choropleth: {},
    sources: [],
    sourcesError: null,
    dataVersion: 0,
    clusterFocus: null,
    flyTo: null,
    toasts: [],
    liveConnected: false,
    selectionGeo: null,

    setMeta(meta) {
      const known = new Set(meta.layers.map((l) => l.id));
      const cur = get().enabled;
      // First visit: the catalog's default layers. Otherwise keep the user's set, dropping ids that no longer exist.
      const enabled = cur == null ? meta.layers.filter((l) => l.defaultOn).map((l) => l.id) : cur.filter((id) => known.has(id));
      set({ meta, metaError: null, enabled });
    },
    toggleLayer(id, on) {
      const cur = get().enabled ?? [];
      const has = cur.includes(id);
      const want = on ?? !has;
      if (want === has) return;
      set({ enabled: want ? [...cur, id] : cur.filter((x) => x !== id), clusterFocus: null });
    },
    setLayers(ids, on) {
      const cur = get().enabled ?? [];
      if (on) {
        const add = ids.filter((id) => !cur.includes(id));
        if (add.length) set({ enabled: [...cur, ...add], clusterFocus: null });
      } else {
        const drop = new Set(ids);
        if (cur.some((id) => drop.has(id))) set({ enabled: cur.filter((id) => !drop.has(id)), clusterFocus: null });
      }
    },
    allLayersOff() {
      set({ enabled: [], clusterFocus: null, choropleth: {} });
    },
    resetLayers() {
      const meta = get().meta;
      if (meta) set({ enabled: meta.layers.filter((l) => l.defaultOn).map((l) => l.id), clusterFocus: null });
    },
    setFilters(patch) {
      set({ filters: { ...get().filters, ...patch }, clusterFocus: null });
    },
    resetFilters() {
      set({ filters: { ...DEFAULT_FILTERS }, clusterFocus: null });
    },
    setTime(time) {
      set({ time, clusterFocus: null, ...(time.mode === 'live' ? { playing: false } : {}) });
    },
    setPlaying(playing) {
      const t = get().time;
      if (t.mode !== 'range') return;
      // Starting playback at the end rewinds to the beginning.
      if (playing && t.cursor >= t.to - 1) set({ time: { ...t, cursor: t.from + (t.to - t.from) / 120 }, playing: true });
      else set({ playing });
    },
    setSpeed(speed) {
      set({ speed });
    },
    setView(view, bbox) {
      set({ view, viewBbox: bbox });
    },
    select(id) {
      set(id ? { selected: id } : { selected: null, selectionGeo: null });
    },
    setTheme(theme) {
      set({ theme });
    },
    setPalette(palette) {
      set({ palette });
    },
    setPanel(panel) {
      set({ panel });
    },
    setLegendOpen(legendOpen) {
      set({ legendOpen });
    },
    setTimelineOpen(timelineOpen) {
      set({ timelineOpen });
    },
    setMapStatus(patch) {
      set({ mapStatus: { ...get().mapStatus, ...patch } });
    },
    setChoropleth(choropleth) {
      set({ choropleth });
    },
    setSources(sources, error = null) {
      set({ sources, sourcesError: error });
    },
    bumpData() {
      set({ dataVersion: get().dataVersion + 1 });
    },
    setClusterFocus(clusterFocus) {
      set({ clusterFocus, ...(clusterFocus ? { panel: 'feed' as const } : {}) });
    },
    requestFly(target) {
      set({ flyTo: { ...target, nonce: flySeq++ } });
    },
    toast(kind, text) {
      const id = toastSeq++;
      set({ toasts: [...get().toasts.slice(-3), { id, kind, text }] });
      setTimeout(() => get().dismissToast(id), kind === 'error' ? 9000 : 6000);
    },
    dismissToast(id) {
      set({ toasts: get().toasts.filter((t) => t.id !== id) });
    },
    setLiveConnected(liveConnected) {
      set({ liveConnected });
    },
  })),
);

// ── persistence and URL synchronisation ──
let urlTimer: ReturnType<typeof setTimeout> | undefined;
let lastHash = typeof location !== 'undefined' ? location.hash : '';

export function currentShareUrl(): string {
  const s = useStore.getState();
  const hash = encodeState({ view: s.view, time: s.time, layers: s.enabled ?? [], filters: s.filters, selected: s.selected, theme: s.theme, palette: s.palette });
  return `${location.origin}${location.pathname}${hash}`;
}

function writeUrl(): void {
  const s = useStore.getState();
  if (s.enabled == null) return;
  const hash = encodeState({ view: s.view, time: s.time, layers: s.enabled, filters: s.filters, selected: s.selected, theme: s.theme, palette: s.palette });
  if (hash !== location.hash) {
    lastHash = hash;
    history.replaceState(null, '', hash);
  }
}

if (typeof window !== 'undefined') {
  useStore.subscribe(
    (s) => [s.enabled, s.theme, s.palette, s.legendOpen, s.time] as const,
    () => savePersisted(useStore.getState()),
    { equalityFn: (a, b) => a.every((v, i) => v === b[i]) },
  );
  useStore.subscribe(
    (s) => [s.view, s.time, s.enabled, s.filters, s.selected, s.theme, s.palette] as const,
    () => {
      clearTimeout(urlTimer);
      // During playback the cursor changes several times a second; keep the URL quiet until it settles.
      urlTimer = setTimeout(writeUrl, useStore.getState().playing ? 1200 : 250);
    },
    { equalityFn: (a, b) => a.every((v, i) => v === b[i]) },
  );
  // Back/forward navigation or a pasted hash: adopt the state from the URL.
  window.addEventListener('hashchange', () => {
    if (location.hash === lastHash) return;
    lastHash = location.hash;
    const u = decodeState(location.hash);
    const s = useStore.getState();
    const known = new Set(s.meta?.layers.map((l) => l.id) ?? []);
    useStore.setState({
      ...(u.layers ? { enabled: s.meta ? u.layers.filter((id) => known.has(id)) : u.layers } : {}),
      ...(u.time ? { time: u.time, playing: false } : {}),
      filters: u.filters ?? { ...DEFAULT_FILTERS },
      ...(u.theme ? { theme: u.theme } : {}),
      ...(u.palette ? { palette: u.palette } : {}),
      selected: u.selected ?? null,
    });
    if (u.view) s.requestFly({ lng: u.view.lng, lat: u.view.lat, zoom: u.view.zoom });
  });
}

// ── selectors / helpers ──
export function layerMap(meta: Meta | null): Map<string, LayerInfo> {
  return new Map((meta?.layers ?? []).map((l) => [l.id, l]));
}

/** The fill choropleth is the most recently enabled choropleth layer; the others are drawn as bubbles. */
export function choroplethRoles(enabled: string[], layers: Map<string, LayerInfo>): { fill: string | null; bubbles: string[] } {
  const ch = enabled.filter((id) => layers.get(id)?.render.type === 'choropleth');
  return { fill: ch.length ? ch[ch.length - 1]! : null, bubbles: ch.slice(0, -1) };
}

export function isLive(t: TimeState): boolean {
  return t.mode === 'live';
}

export function nowMs(): number {
  return serverNow();
}
