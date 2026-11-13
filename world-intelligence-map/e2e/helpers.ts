import { expect, type Page } from '@playwright/test';

export interface WimState {
  enabled: string[] | null;
  counts: Record<string, number>;
  total: number;
  loading: boolean;
  error: string | null;
  time: { mode: string; windowSec?: number; from?: number; to?: number; cursor?: number };
  playing: boolean;
  selected: string | null;
  view: { lng: number; lat: number; zoom: number };
  theme: string;
}

export async function state(page: Page): Promise<WimState> {
  return page.evaluate(() => {
    const s = window.__wim!.store.getState();
    return { enabled: s.enabled, counts: s.mapStatus.counts, total: s.mapStatus.total, loading: s.mapStatus.loading, error: s.mapStatus.error, time: s.time as never, playing: s.playing, selected: s.selected, view: s.view, theme: s.theme };
  });
}

/** Layers present in what the map currently renders from (points, clusters, shapes, density). */
export async function renderedLayers(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const f = window.__wim!.lastFeatures;
    const out = new Set<string>();
    if (!f) return [];
    for (const fc of [f.points, f.areas, f.lines, f.density]) {
      for (const feat of fc.features) {
        const p = feat.properties as { l: string; ls?: string };
        if (p.ls) for (const part of p.ls.split(',')) out.add(part.split(':')[0]!);
        else out.add(p.l);
      }
    }
    return [...out].sort();
  });
}

/** Wait until the map has loaded and no data request is in flight for the current state. */
export async function settled(page: Page): Promise<void> {
  await page.waitForFunction(() => {
    const w = window.__wim;
    if (!w?.ready) return false;
    const s = w.store.getState();
    return s.enabled != null && !s.mapStatus.loading && s.mapStatus.lastUpdated != null;
  });
  // one debounce interval, then confirm it is still idle
  await page.waitForTimeout(350);
  await page.waitForFunction(() => !window.__wim!.store.getState().mapStatus.loading);
}

export async function open(page: Page, hash = ''): Promise<void> {
  await page.goto(`/${hash}`);
  await settled(page);
}

export async function toggleLayer(page: Page, id: string): Promise<void> {
  // the visible switch is a styled track; the real checkbox sits underneath it
  await page.getByTestId(`layer-${id}`).evaluate((el) => (el as HTMLInputElement).click());
}

export async function openPanel(page: Page, panel: 'layers' | 'filters' | 'feed' | 'sources'): Promise<void> {
  const tab = page.getByTestId(`tab-${panel}`);
  if ((await tab.getAttribute('aria-pressed')) !== 'true') await tab.click();
  await expect(tab).toHaveAttribute('aria-pressed', 'true');
}

export const LIVE_7D = '#t=live:604800';

/** Number of records the API reports for the given query within the map's current viewport. */
export async function totalInView(page: Page, query: string): Promise<number> {
  return page.evaluate(async (q) => {
    const st = window.__wim!.store.getState();
    const res = await fetch(`/api/features?${q}&bbox=${(st.viewBbox as number[]).map((n) => n.toFixed(4)).join(',')}&z=${st.view.zoom.toFixed(2)}`);
    return ((await res.json()) as { total: number }).total;
  }, query);
}
