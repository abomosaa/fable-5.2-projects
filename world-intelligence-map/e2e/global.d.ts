/** The debugging hook the web client exposes on window (see web/src/map/MapView.tsx), loosely typed for the tests. */
interface WimFeature {
  type: 'Feature';
  geometry: { type: string; coordinates: unknown };
  properties: Record<string, any> | null;
}
interface WimFeatureCollection {
  type: 'FeatureCollection';
  features: WimFeature[];
}
interface WimHook {
  map: any;
  store: { getState(): any };
  ready: boolean;
  lastFeatures: { points: WimFeatureCollection; areas: WimFeatureCollection; lines: WimFeatureCollection; density: WimFeatureCollection; total: number; counts: Record<string, number> } | null;
  fetchCount: number;
  applied: number;
}
interface Window {
  __wim?: WimHook;
}
