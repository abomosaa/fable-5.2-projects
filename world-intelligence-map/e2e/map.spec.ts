import { expect, test } from '@playwright/test';
import { open, openPanel, renderedLayers, settled, state, toggleLayer } from './helpers';

test.describe('fixture labelling', () => {
  test('fixture data can never be mistaken for live intelligence', async ({ page }) => {
    await open(page);
    await expect(page.getByTestId('fixture-banner')).toContainText('FIXTURE DATA');
    await expect(page.getByTestId('fixture-banner')).toContainText('Not live intelligence');
    await expect(page.getByTestId('mode-chip')).toHaveText('FIXTURE');
    await expect(page.locator('.watermark')).toHaveText('FIXTURE DATA');
    const meta = await (await page.request.get('/api/meta')).json();
    expect(meta).toMatchObject({ mode: 'fixture', fixture: true });
    // every record says so again in its detail view
    await page.evaluate(() => window.__wim!.store.getState().select('usgs-earthquakes:aka2026whmgzn'));
    await expect(page.getByTestId('drawer-fixture')).toContainText('FIXTURE RECORD');
    await expect(page.getByTestId('drawer-provenance')).toContainText('Bundled fixture file (not a live request)');
  });
});

test.describe('layers', () => {
  test('catalog lists every layer grouped by domain and is searchable', async ({ page }) => {
    await open(page);
    await expect(page.locator('.group')).toHaveCount(10);
    await expect(page.locator('.layer')).toHaveCount(80);
    await page.getByTestId('layer-search').fill('earthquake');
    await expect(page.getByTestId('layer-earthquakes')).toBeVisible();
    await expect(page.getByTestId('layer-emsc-earthquakes')).toBeVisible();
    await expect(page.getByTestId('layer-airports-large')).toHaveCount(0);
    await page.getByTestId('layer-search').fill('World Bank'); // provider names are searched too
    await expect(page.locator('.layer')).toHaveCount(8);
    await page.getByTestId('layer-search').fill('zzzz');
    await expect(page.getByText('No layers match')).toBeVisible();
  });

  test('toggling a layer adds and removes its data, counts and legend entry', async ({ page }) => {
    await open(page, '#l=earthquakes&t=live:604800');
    expect(await renderedLayers(page)).toEqual(['earthquakes']);
    await expect(page.locator('[data-legend-layer]')).toHaveCount(1);

    await toggleLayer(page, 'emsc-earthquakes');
    await settled(page);
    let s = await state(page);
    expect(s.enabled).toEqual(['earthquakes', 'emsc-earthquakes']);
    expect(s.counts['emsc-earthquakes']).toBeGreaterThan(0);
    expect(await renderedLayers(page)).toEqual(['earthquakes', 'emsc-earthquakes']);
    await expect(page.locator('[data-legend-layer="emsc-earthquakes"]')).toBeVisible();
    const withBoth = s.total;

    await toggleLayer(page, 'emsc-earthquakes');
    await settled(page);
    s = await state(page);
    expect(s.enabled).toEqual(['earthquakes']);
    expect(s.counts['emsc-earthquakes']).toBeUndefined();
    expect(s.total).toBeLessThan(withBoth);
    expect(await renderedLayers(page)).toEqual(['earthquakes']); // not left behind invisibly
    await expect(page.locator('[data-legend-layer="emsc-earthquakes"]')).toHaveCount(0);
    // the map itself draws nothing of the disabled layer
    const drawn = await page.evaluate(() => window.__wim!.map.queryRenderedFeatures(undefined, { layers: ['points', 'clusters'] }).map((f: WimFeature) => String(f.properties!.l)));
    expect(drawn.length).toBeGreaterThan(0);
    expect(new Set(drawn)).toEqual(new Set(['earthquakes']));
  });

  test('group switch enables and disables a whole domain without losing individual control', async ({ page }) => {
    await open(page, '#l=earthquakes&t=live:604800');
    const group = page.getByTestId('group-space');
    await group.evaluate((el) => (el as HTMLInputElement).click());
    await settled(page);
    let s = await state(page);
    const space = s.enabled!.filter((id) => id !== 'earthquakes');
    expect(space.length).toBe(8);
    await expect(group).toBeChecked();
    // individual control remains: switch one off → the group shows a mixed state
    await toggleLayer(page, 'fireballs');
    await settled(page);
    expect(await group.evaluate((el) => (el as HTMLInputElement).indeterminate)).toBe(true);
    await expect(group).toHaveAttribute('aria-checked', 'mixed');
    expect((await state(page)).enabled).not.toContain('fireballs');
    // group off
    await group.evaluate((el) => (el as HTMLInputElement).click()); // mixed → all on
    await group.evaluate((el) => (el as HTMLInputElement).click()); // all on → all off
    await settled(page);
    s = await state(page);
    expect(s.enabled).toEqual(['earthquakes']);
  });

  test('all layers off leaves only the basemap', async ({ page }) => {
    await open(page);
    expect((await state(page)).total).toBeGreaterThan(0);
    const requests: string[] = [];
    await page.getByTestId('all-off').click();
    await settled(page);
    page.on('request', (r) => {
      if (/\/api\/(features|choropleth|list|histogram)/.test(r.url())) requests.push(r.url());
    });
    const s = await state(page);
    expect(s.enabled).toEqual([]);
    expect(s.total).toBe(0);
    expect(s.counts).toEqual({});
    expect(await renderedLayers(page)).toEqual([]);
    await expect(page.getByTestId('enabled-count')).toHaveText('0 of 80 layers on');
    await expect(page.getByTestId('all-off-chip')).toBeVisible();
    await expect(page.locator('[data-legend-layer]')).toHaveCount(0);
    await expect(page.getByTestId('legend')).toContainText('only the basemap is shown');
    // nothing but basemap layers has anything to draw
    const overlay = await page.evaluate(() => {
      const map = window.__wim!.map;
      const ids = ['points', 'clusters', 'cluster-count', 'areas-fill', 'areas-line', 'lines', 'paths', 'bubbles'].filter((id) => map.getLayer(id));
      const heat = map.getStyle().layers.filter((l: { id: string }) => l.id.startsWith('heat-')).length;
      const choro = JSON.stringify(map.getPaintProperty('choro', 'fill-color'));
      return { features: map.queryRenderedFeatures(undefined, { layers: ids }).length, heat, choro, basemap: map.queryRenderedFeatures(undefined, { layers: ['land'] }).length };
    });
    expect(overlay).toMatchObject({ features: 0, heat: 0, choro: '"rgba(0,0,0,0)"' });
    expect(overlay.basemap).toBeGreaterThan(50);
    // panning with everything off does not query data, and the results panel is empty
    await page.evaluate(() => window.__wim!.map.jumpTo({ center: [60, 30], zoom: 3 }));
    await page.waitForTimeout(700);
    await openPanel(page, 'feed');
    await expect(page.getByTestId('feed').locator('li')).toHaveCount(0);
    await expect(page.getByText('No layers are enabled')).toBeVisible();
    expect(requests).toEqual([]);
  });

  test('toggle state persists across reloads', async ({ page }) => {
    await open(page); // no layers in the URL → defaults
    const defaults = (await state(page)).enabled!;
    expect(defaults.length).toBeGreaterThan(5);
    await page.getByTestId('all-off').click();
    await toggleLayer(page, 'airports-large');
    await toggleLayer(page, 'wb-population');
    await settled(page);
    await page.goto('/'); // a clean URL: state must come from storage, not from the hash
    await settled(page);
    expect((await state(page)).enabled).toEqual(['airports-large', 'wb-population']);
    await expect(page.getByTestId('layer-airports-large')).toBeChecked();
    await expect(page.getByTestId('layer-earthquakes')).not.toBeChecked();
    // "all off" persists too
    await page.getByTestId('all-off').click();
    await settled(page);
    await page.goto('/');
    await settled(page);
    expect((await state(page)).enabled).toEqual([]);
  });

  test('rapid toggling ends in a consistent state: stale responses never overwrite newer state', async ({ page }) => {
    await open(page, '#l=&t=live:31536000');
    // slow down every other features response so that older requests would finish after newer ones
    let n = 0;
    await page.route('**/api/features*', async (route) => {
      const delay = n++ % 2 === 0 ? 450 : 0;
      await new Promise((r) => setTimeout(r, delay));
      await route.continue().catch(() => {});
    });
    const ids = ['earthquakes', 'emsc-earthquakes', 'nws-warnings', 'active-fires', 'fireballs', 'gdelt-conflict', 'aircraft', 'sigmets'];
    await page.evaluate(async (layerIds) => {
      const st = window.__wim!.store.getState();
      for (let round = 0; round < 3; round++) {
        for (const id of layerIds) {
          st.toggleLayer(id);
          await new Promise((r) => setTimeout(r, 15));
        }
      }
      // final: three rounds = on, off, on → all on; then switch half of them off quickly
      for (const id of layerIds.slice(0, 4)) st.toggleLayer(id, false);
    }, ids);
    await page.waitForTimeout(1200);
    await settled(page);
    const s = await state(page);
    expect(s.enabled!.sort()).toEqual(['aircraft', 'fireballs', 'gdelt-conflict', 'sigmets']);
    expect(Object.keys(s.counts).sort()).toEqual(['aircraft', 'fireballs', 'gdelt-conflict', 'sigmets']);
    expect(await renderedLayers(page)).toEqual(['aircraft', 'fireballs', 'gdelt-conflict', 'sigmets']);
    const legend = await page.locator('[data-legend-layer]').evaluateAll((els) => els.map((e) => e.getAttribute('data-legend-layer')).sort());
    expect(legend).toEqual(['aircraft', 'fireballs', 'gdelt-conflict', 'sigmets']);
    // obsolete requests were cancelled rather than left to finish
    const hook = await page.evaluate(() => ({ fetches: window.__wim!.fetchCount, applied: window.__wim!.applied }));
    expect(hook.applied).toBeLessThan(hook.fetches);
  });
});

test.describe('rendering by zoom', () => {
  test('clusters at world scale, individual points when zoomed in, heat map for dense layers, choropleth for indicators', async ({ page }) => {
    await open(page, '#m=1.50/10.0000/20.0000&l=earthquakes,emsc-earthquakes,active-fires,wb-life-expectancy,nws-warnings,cyclone-tracks&t=live:604800');
    const world = await page.evaluate(() => {
      const f = window.__wim!.lastFeatures!;
      const map = window.__wim!.map;
      return {
        clusters: f.points.features.filter((x) => x.properties!.k === 'c').length,
        firePoints: f.points.features.filter((x) => x.properties!.l === 'active-fires').length,
        density: f.density.features.length,
        domMarkers: document.querySelectorAll('.maplibregl-marker').length,
        heatLayer: !!map.getLayer('heat-active-fires'),
        choro: Array.isArray(map.getPaintProperty('choro', 'fill-color')),
        areas: f.areas.features.length,
        lines: f.lines.features.length,
      };
    });
    expect(world.clusters).toBeGreaterThan(3);
    expect(world.firePoints).toBe(0); // 50,000 detections are a density surface here, not points
    expect(world.density).toBeGreaterThan(100);
    expect(world.domMarkers).toBe(0); // everything is drawn by the map renderer – no DOM markers at all
    expect(world.heatLayer).toBe(true);
    expect(world.choro).toBe(true);
    expect(world.lines).toBeGreaterThan(0); // storm tracks
    expect((await state(page)).counts['active-fires']).toBe(50_000);
    await expect(page.locator('[data-legend-layer="wb-life-expectancy"] .class')).toHaveCount(5);

    // zoom into the fire region: individual detections replace the heat map
    await page.evaluate(() => window.__wim!.map.jumpTo({ center: [22.0, -8.0], zoom: 9 }));
    await page.waitForTimeout(400);
    await settled(page);
    const near = await page.evaluate(() => {
      const f = window.__wim!.lastFeatures!;
      return { firePoints: f.points.features.filter((x) => x.properties!.l === 'active-fires' && x.properties!.k === 'p').length, density: f.density.features.length, total: (Object.values(window.__wim!.store.getState().mapStatus.counts) as number[]).reduce((a, b) => a + b, 0) };
    });
    expect(near.density).toBe(0);
    expect(near.firePoints).toBeGreaterThan(0);
    expect(near.total).toBeLessThan(5000); // only the viewport is downloaded
  });

  test('the client asks the server for its viewport only', async ({ page }) => {
    const urls: URL[] = [];
    page.on('request', (r) => {
      if (r.url().includes('/api/features')) urls.push(new URL(r.url()));
    });
    await open(page, '#m=5.00/35.0000/138.0000&l=earthquakes,emsc-earthquakes&t=live:2592000');
    const last = urls[urls.length - 1]!;
    const [w, s, e, n] = last.searchParams.get('bbox')!.split(',').map(Number) as [number, number, number, number];
    expect(w).toBeGreaterThan(100);
    expect(e).toBeLessThan(180);
    expect(n - s).toBeLessThan(40);
    expect(last.searchParams.get('z')).toBe('5.00');
    expect(last.searchParams.get('layers')).toBe('earthquakes,emsc-earthquakes');
    const body = await page.evaluate(() => window.__wim!.lastFeatures!.total);
    const all = await (await page.request.get('/api/features?layers=earthquakes,emsc-earthquakes&window=2592000&z=1')).json();
    expect(body).toBeLessThan(all.total / 2);
  });
});
