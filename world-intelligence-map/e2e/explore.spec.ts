import { expect, test } from '@playwright/test';
import { open, openPanel, renderedLayers, settled, state, toggleLayer, totalInView } from './helpers';

test.describe('search and results', () => {
  test('search finds records in enabled layers only and opens their details', async ({ page }) => {
    await open(page, '#l=earthquakes&t=live:2592000');
    await page.getByTestId('search').fill('alaska');
    await expect(page.getByTestId('tab-feed')).toHaveAttribute('aria-pressed', 'true'); // results open automatically
    const items = page.getByTestId('feed').locator('.feed-item');
    await expect(items.first()).toBeVisible();
    const onlyQuakes = await items.count();
    expect(onlyQuakes).toBeGreaterThan(0);
    for (const t of await items.locator('.feed-title').allTextContents()) expect(t.toLowerCase()).toContain('alaska');
    for (const t of await items.locator('.feed-sub').allTextContents()) expect(t).toContain('Earthquakes (USGS)');
    await expect(page.getByTestId('result-count')).toContainText(`${onlyQuakes} record`);
    // the map is filtered by the same search (the list searches the whole world, the map shows its viewport)
    await settled(page);
    expect((await state(page)).total).toBe(await totalInView(page, 'layers=earthquakes&window=2592000&q=alaska'));
    await items.first().click(); // flies to the record
    await expect(page.getByTestId('drawer-title')).toContainText(/alaska/i);
    await expect.poll(async () => (await state(page)).view.lng).toBeLessThan(-130);
    await settled(page);
    expect((await state(page)).total).toBeGreaterThan(0);
    expect((await state(page)).total).toBeLessThanOrEqual(onlyQuakes);
    await page.getByTestId('drawer-close').click();

    // enabling other layers that also mention Alaska widens the results; disabling it narrows them again
    await openPanel(page, 'layers');
    await toggleLayer(page, 'emsc-earthquakes');
    await toggleLayer(page, 'volcanoes-holocene');
    await openPanel(page, 'feed');
    await expect.poll(async () => items.count()).toBe(onlyQuakes + 5); // 2 EMSC events and 3 volcanoes also mention Alaska
    await page.evaluate(() => window.__wim!.store.getState().setLayers(['emsc-earthquakes', 'volcanoes-holocene'], false));
    await expect.poll(async () => items.count()).toBe(onlyQuakes);

    // clearing the search restores the unfiltered layer
    await expect(page.getByTestId('result-count')).toContainText('matching “alaska”');
    await page.getByTestId('search').fill('');
    await expect(page.getByTestId('result-count')).not.toContainText('matching');
    await settled(page);
    expect((await state(page)).total).toBe(await totalInView(page, 'layers=earthquakes&window=2592000'));
    await expect.poll(() => page.url()).not.toContain('q=');
  });

  test('priority alerts list the most severe records of enabled layers', async ({ page }) => {
    await open(page, '#l=earthquakes,nws-warnings&t=live:2592000');
    await openPanel(page, 'feed');
    await page.getByTestId('tab-priority').click();
    const pills = page.getByTestId('feed').locator('.sev');
    await expect(pills.first()).toBeVisible();
    const labels = await pills.allTextContents();
    expect(labels.length).toBeGreaterThan(3);
    for (const l of labels) expect(['Severe', 'Extreme']).toContain(l);
    const subs = await page.getByTestId('feed').locator('.feed-sub').allTextContents();
    for (const s of subs) expect(s).toMatch(/Earthquakes \(USGS\)|NWS warnings/);
  });
});

test.describe('detail drawer', () => {
  test('shows source, link, times, freshness, confidence, attribution, raw facts and provenance', async ({ page }) => {
    await open(page, '#l=earthquakes&t=live:2592000&sel=usgs-earthquakes%3Aaka2026whmgzn');
    const drawer = page.getByTestId('drawer');
    await expect(page.getByTestId('drawer-title')).toHaveText('M 3.0 - 74 km WNW of Petersville, Alaska');
    await expect(drawer).toContainText('U.S. Geological Survey (USGS)');
    const link = page.getByTestId('drawer-source-link').getByRole('link', { name: /Open at source/ });
    await expect(link).toHaveAttribute('href', 'https://earthquake.usgs.gov/earthquakes/eventpage/aka2026whmgzn');
    await expect(link).toHaveAttribute('rel', /noopener/);
    const times = page.getByTestId('drawer-times');
    await expect(times).toContainText('Event time');
    await expect(times).toContainText('2026-11-10 17:42:27 UTC');
    await expect(times).toContainText('Last update (upstream)');
    await expect(times).toContainText('2026-11-10 17:43 UTC');
    await expect(times).toContainText('Fetched');
    await expect(times).toContainText('Freshness');
    await expect(page.getByTestId('drawer-freshness')).toHaveText('Fresh');
    await expect(drawer).toContainText('70%'); // confidence …
    await expect(drawer).toContainText('USGS review status: automatic'); // … and where it comes from
    await expect(drawer.locator('.tag.derived').first()).toBeVisible(); // inferred values are marked
    await expect(drawer).toContainText('U.S. Geological Survey, Earthquake Hazards Program'); // attribution
    await expect(drawer.getByRole('link', { name: /public domain/ })).toHaveAttribute('href', /usgs\.gov/);
    const facts = page.getByTestId('drawer-attributes');
    await expect(facts).toContainText('Magnitude');
    await expect(facts).toContainText('Depth km');
    await expect(facts).toContainText('0.3');
    const prov = page.getByTestId('drawer-provenance');
    await expect(prov).toContainText('usgs-earthquakes:aka2026whmgzn');
    await expect(prov).toContainText('https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/2.5_week.geojson');
    await expect(prov).toContainText('confidence, country, severity'); // exactly which fields were inferred

    // Escape closes the drawer and clears the selection from the URL
    await page.keyboard.press('Escape');
    await expect(drawer).toHaveCount(0);
    await expect.poll(() => page.url()).not.toContain('sel=');
  });

  test('clicking a point on the map opens its record; correlated reports are offered as possibly related', async ({ page }) => {
    await open(page, '#m=6.00/62.6800/-152.1680&l=earthquakes&t=live:604800');
    const pos = await page.evaluate(() => {
      const map = window.__wim!.map;
      const p = map.project([-152.168, 62.68]);
      const r = map.getCanvas().getBoundingClientRect();
      return { x: r.left + p.x, y: r.top + p.y };
    });
    await page.mouse.move(pos.x, pos.y);
    await expect(page.locator('.wim-tip')).toContainText('Petersville');
    await page.mouse.click(pos.x, pos.y);
    await expect(page.getByTestId('drawer-title')).toContainText('Petersville, Alaska');

    // a record that another source also reported
    const linked = await page.evaluate(async () => {
      const list = await (await fetch('/api/list?layers=earthquakes&window=2592000&sort=severity&limit=40')).json();
      for (const it of list.items) {
        const rec = await (await fetch(`/api/records/${encodeURIComponent(it.id)}`)).json();
        if (rec.record.incident) return it.id as string;
      }
      return null;
    });
    expect(linked).not.toBeNull();
    await page.evaluate((id) => window.__wim!.store.getState().select(id), linked);
    const incident = page.getByTestId('drawer-incident');
    await expect(incident).toContainText('possibly describe the same incident');
    await expect(incident).toContainText('inference by this application');
    const other = incident.getByRole('button').first();
    const title = await other.textContent();
    await other.click();
    await expect(page.getByTestId('drawer-title')).toHaveText(title!);
  });

  test('a record that was purged or never existed shows an error, not a blank drawer', async ({ page }) => {
    await open(page, '#l=earthquakes&sel=usgs-earthquakes%3Adoes-not-exist');
    await expect(page.getByTestId('drawer')).toContainText('No such record');
  });
});

test.describe('filters', () => {
  test('severity, freshness and country filters narrow map, counts and results together', async ({ page }) => {
    await open(page, '#l=earthquakes,emsc-earthquakes&t=live:2592000');
    const all = (await state(page)).total;
    await openPanel(page, 'filters');
    await page.getByTestId('sev-min').selectOption('2');
    await page.getByTestId('sev-unknown').uncheck();
    await settled(page);
    const severe = (await state(page)).total;
    expect(severe).toBeGreaterThan(0);
    expect(severe).toBeLessThan(all);
    await expect(page.getByTestId('tab-filters').locator('.badge')).toHaveText('1');
    expect(severe).toBe(await totalInView(page, 'layers=earthquakes,emsc-earthquakes&window=2592000&sev=2-4&sevU=0'));
    const listed = await (await page.request.get('/api/list?layers=earthquakes,emsc-earthquakes&window=2592000&sev=2-4&sevU=0&limit=500')).json();
    expect(listed.total).toBeGreaterThanOrEqual(severe);
    expect(listed.items.every((i: { severity: number }) => i.severity >= 2)).toBe(true);

    await page.getByTestId('fresh-fresh').check();
    await settled(page);
    const fresh = (await state(page)).total;
    expect(fresh).toBeLessThanOrEqual(severe);

    await page.getByTestId('reset-filters').click();
    await settled(page);
    expect((await state(page)).total).toBe(all);

    // country filter through the URL (the same state the panel edits)
    await open(page, '#l=earthquakes,emsc-earthquakes&t=live:2592000&cc=JPN');
    const japan = await state(page);
    expect(japan.total).toBeGreaterThan(0);
    expect(japan.total).toBeLessThan(all);
    await openPanel(page, 'feed');
    await expect(page.getByTestId('feed').locator('.feed-item').first()).toBeVisible();
  });

  test('source and category options come from enabled layers only', async ({ page }) => {
    await open(page, '#l=earthquakes,nws-warnings');
    await openPanel(page, 'filters');
    const fieldset = (name: string) => page.locator('fieldset.field').filter({ has: page.locator('legend', { hasText: name }) });
    await expect(fieldset('Source').locator('.check')).toHaveCount(2);
    await expect(fieldset('Category').locator('.check')).toHaveCount(2);
    await fieldset('Source').locator('.check', { hasText: 'Geological Survey' }).click();
    await settled(page);
    expect(Object.keys((await state(page)).counts)).toEqual(['earthquakes']);
    expect(await renderedLayers(page)).toEqual(['earthquakes']);
  });
});

test.describe('timeline', () => {
  test('live mode, look-back window and history mode with custom range', async ({ page }) => {
    await open(page, '#m=0.80/20.0000/0.0000&l=earthquakes&t=live:604800');
    await expect(page.getByTestId('mode-live')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByTestId('time-summary')).toHaveText('Live · last 7 d');
    const week = (await state(page)).total;
    await page.getByTestId('live-window').selectOption('86400');
    await settled(page);
    const day = (await state(page)).total;
    expect(day).toBeLessThan(week);
    expect(day).toBeGreaterThan(0);
    await expect(page.getByTestId('time-summary')).toHaveText('Live · last 24 h');

    await page.getByTestId('mode-history').click();
    await expect(page.getByTestId('mode-history')).toHaveAttribute('aria-pressed', 'true');
    // custom range: 20–27 October 2026 (the fixture holds M4.5+ events for the past 30 days)
    await page.getByTestId('range-from').fill('2026-10-20T00:00');
    await page.getByTestId('range-to').fill('2026-10-27T00:00');
    await settled(page);
    const s = await state(page);
    expect(s.time).toMatchObject({ mode: 'range', from: Date.UTC(2026, 9, 20), to: Date.UTC(2026, 9, 27) });
    await expect(page.getByTestId('time-summary')).toHaveText('2026-10-20 00:00 UTC → 2026-10-27 00:00 UTC');
    expect(s.total).toBeGreaterThan(0);
    const expected = await (await page.request.get(`/api/list?layers=earthquakes&from=${Date.UTC(2026, 9, 20)}&to=${Date.UTC(2026, 9, 27)}&limit=500`)).json();
    expect(s.total).toBe(expected.total);
    for (const it of expected.items) {
      expect(it.time).toBeGreaterThanOrEqual(Date.UTC(2026, 9, 20));
      expect(it.time).toBeLessThanOrEqual(Date.UTC(2026, 9, 27));
    }
    // back to live
    await page.getByTestId('mode-live').click();
    await settled(page);
    expect((await state(page)).time.mode).toBe('live');
  });

  test('playback advances the cursor, can be paused, and the map follows', async ({ page }) => {
    await open(page, '#m=0.80/20.0000/0.0000&l=earthquakes,emsc-earthquakes&t=2026-10-12T00:00:00Z~2026-11-11T00:00:00Z');
    const full = (await state(page)).total;
    const play = page.getByTestId('play');
    await expect(play).toHaveAccessibleName('Play');
    await play.click(); // starting at the end rewinds to the beginning
    await expect(play).toHaveAccessibleName('Pause playback');
    await expect.poll(async () => (await state(page)).playing).toBe(true);
    const c1 = (await state(page)).time.cursor!;
    expect(c1).toBeLessThan(Date.UTC(2026, 9, 14));
    await expect.poll(async () => (await state(page)).time.cursor!, { timeout: 15_000 }).toBeGreaterThan(c1 + 2 * 86_400_000);
    await play.click(); // pause
    await expect(play).toHaveAccessibleName('Play');
    await settled(page);
    const paused = await state(page);
    expect(paused.playing).toBe(false);
    expect(paused.total).toBeGreaterThan(0);
    expect(paused.total).toBeLessThan(full); // only what had happened up to the cursor
    const frozen = paused.time.cursor!;
    await page.waitForTimeout(1500);
    expect((await state(page)).time.cursor).toBe(frozen);
    // the map shows exactly the cumulative state at the cursor
    const upTo = await (await page.request.get(`/api/features?layers=earthquakes,emsc-earthquakes&from=${Date.UTC(2026, 9, 12)}&to=${Math.round(frozen)}&z=1&bbox=-180,-85,180,85`)).json();
    expect(paused.total).toBe(upTo.total);

    // scrubbing with the keyboard moves the cursor
    await page.getByTestId('scrubber').focus();
    await page.keyboard.press('End');
    await settled(page);
    expect((await state(page)).total).toBe(full);
    // sliding window: only the day before the cursor
    await page.getByTestId('play-window').selectOption('86400');
    await settled(page);
    expect((await state(page)).total).toBeLessThan(full);
  });
});

test.describe('shareable URLs', () => {
  test('the URL captures map position, time range, filters and layers, and restores them in a new session', async ({ page, browser }) => {
    await open(page, '#l=earthquakes&t=live:604800');
    await page.evaluate(() => {
      const st = window.__wim!.store.getState();
      st.setLayers(['emsc-earthquakes', 'wb-population'], true);
      st.setFilters({ sevMin: 1, sevMax: 4, sevUnknown: false, countries: ['JPN', 'USA'], q: 'km' });
      st.setTime({ mode: 'range', from: Date.UTC(2026, 9, 20), to: Date.UTC(2026, 10, 10, 12), cursor: Date.UTC(2026, 10, 5), windowSec: 0 });
      window.__wim!.map.jumpTo({ center: [141.25, 37.5], zoom: 4.5 });
    });
    await settled(page);
    await expect.poll(() => page.url()).toContain('m=4.50/37.5000/141.2500');
    const url = page.url();
    expect(url).toContain('l=earthquakes,emsc-earthquakes,wb-population');
    expect(url).toContain('t=2026-10-20T00:00:00Z~2026-11-10T12:00:00Z~2026-11-05T00:00:00Z');
    expect(url).toContain('cc=JPN,USA');
    expect(url).toContain('sev=1-4');
    expect(url).toContain('sevu=0');
    expect(url).toContain('q=km');
    const before = await state(page);

    // a completely fresh browser context: no storage, only the link
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const other = await ctx.newPage();
    await other.goto(url);
    await settled(other);
    const after = await state(other);
    expect(after.enabled).toEqual(['earthquakes', 'emsc-earthquakes', 'wb-population']);
    expect(after.time).toEqual(before.time);
    expect(after.view.zoom).toBeCloseTo(4.5, 1);
    expect(after.view.lng).toBeCloseTo(141.25, 2);
    expect(after.view.lat).toBeCloseTo(37.5, 2);
    expect(after.total).toBe(before.total);
    expect(after.counts).toEqual(before.counts);
    await expect(other.getByTestId('search')).toHaveValue('km');
    await ctx.close();

    // the share button copies the same link
    await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
    await page.getByTestId('share').click();
    await expect(page.locator('.toast')).toContainText('Link copied');
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(page.url());
  });

  test('an explicit empty layer list in the URL means all layers off', async ({ page }) => {
    await open(page, '#l=');
    expect((await state(page)).enabled).toEqual([]);
    await expect(page.getByTestId('all-off-chip')).toBeVisible();
  });
});

test.describe('source health', () => {
  test('stale, unconfigured and healthy sources are distinguishable, with reasons and setup instructions', async ({ page }) => {
    await open(page);
    await openPanel(page, 'sources');
    await expect(page.getByTestId('source-summary')).toContainText('40 sources');
    await expect(page.getByTestId('source-summary')).toContainText('fixture data');
    await expect(page.locator('.source')).toHaveCount(40);

    const nhc = page.locator('.source[data-source="noaa-nhc"]');
    await expect(nhc).toHaveAttribute('data-status', 'stale');
    await expect(nhc.locator('.status')).toContainText('Stale');
    await expect(page.getByTestId('source-msg-noaa-nhc')).toContainText('No successful refresh for 6 h');
    await expect(page.getByTestId('source-msg-noaa-nhc')).toContainText('Displayed data is stale');

    const cf = page.locator('.source[data-source="cloudflare-radar"]');
    await expect(cf).toHaveAttribute('data-status', 'misconfigured');
    await expect(page.getByTestId('source-msg-cloudflare-radar')).toContainText('Missing credential: CLOUDFLARE_API_TOKEN');
    await expect(page.getByTestId('source-msg-cloudflare-radar')).toContainText('API Tokens'); // how to fix it

    await expect(page.locator('.source[data-status="healthy"]')).toHaveCount(38);
    await expect(page.getByTestId('status-chip-stale')).toContainText('1');
    await page.getByTestId('status-chip-stale').click();
    await expect(page.locator('.source')).toHaveCount(1);

    // full manifest details for any source
    await page.getByTestId('status-chip-stale').click();
    const usgs = page.locator('.source[data-source="usgs-earthquakes"]');
    await usgs.locator('.source-head').click();
    for (const label of ['Last success', 'Polling', 'Coverage', 'Access', 'Attribution', 'Licence / terms', 'Confidence', 'Limitations', 'Retention', 'Endpoints']) await expect(usgs.locator('dt', { hasText: label }).first()).toBeVisible();
    await expect(usgs).toContainText('No credentials required');
    await expect(usgs).toContainText('public domain');
  });

  test('stale data is flagged on the map, in the legend and on the record itself', async ({ page }) => {
    await open(page, '#m=3.00/11.1000/-164.7000&l=nhc-active-storms,earthquakes&t=live:604800');
    // the storm is still shown (it is the last known state) but marked stale: f = 3 → drawn dimmed
    const storm = await page.evaluate(() => window.__wim!.lastFeatures!.points.features.find((f) => f.properties!.l === 'nhc-active-storms')!.properties);
    expect(storm).toMatchObject({ f: 3 });
    await expect(page.getByTestId('legend-issues')).toContainText('Stale');
    await expect(page.getByTestId('legend-issues')).toContainText('National Hurricane Center');
    await expect(page.getByTestId('layer-nhc-active-storms').locator('xpath=ancestor::li').locator('.status')).toHaveAttribute('data-status', 'stale');
    await page.evaluate((id) => window.__wim!.store.getState().select(id as string), storm!.id);
    await expect(page.getByTestId('drawer-freshness')).toHaveText('Stale source');
    await expect(page.getByTestId('drawer')).toContainText('could not be re-confirmed');
    await expect(page.getByTestId('drawer')).toContainText('Treat it as old data');
    // the freshness filter can isolate or exclude it
    await page.evaluate(() => window.__wim!.store.getState().setFilters({ fresh: ['stale'] }));
    await settled(page);
    expect(Object.keys((await state(page)).counts)).toEqual(['nhc-active-storms']);
  });

  test('a failing API shows an error with retry and keeps the last map state', async ({ page }) => {
    await open(page, '#l=earthquakes&t=live:604800');
    const before = (await state(page)).total;
    await page.route('**/api/features*', (route) => route.fulfill({ status: 500, contentType: 'application/json', body: '{"error":"internal_error","message":"The server could not complete this request."}' }));
    await page.evaluate(() => window.__wim!.map.jumpTo({ center: [30, 20], zoom: 2.2 }));
    await expect(page.locator('.map-chip.error')).toContainText('could not be refreshed');
    expect((await state(page)).total).toBe(before); // previous data stays on the map
    expect((await renderedLayers(page)).length).toBe(1);
    await page.unroute('**/api/features*');
    await page.locator('.map-chip.error button').click();
    await expect(page.locator('.map-chip.error')).toHaveCount(0);
  });
});
