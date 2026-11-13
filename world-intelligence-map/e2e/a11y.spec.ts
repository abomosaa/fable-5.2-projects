import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { open, openPanel, settled, state } from './helpers';

async function audit(page: Page, label: string) {
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .exclude('.maplibregl-canvas-container') // the WebGL canvas itself; its accessible alternative is the Results panel
    .analyze();
  const serious = results.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
  expect(serious.map((v) => `${label}: ${v.id} – ${v.help} (${v.nodes.length} nodes, e.g. ${v.nodes[0]?.target.join(' ')})`)).toEqual([]);
}

for (const theme of ['dark', 'light'] as const) {
  test(`no serious accessibility violations in the main views (${theme} theme)`, async ({ page }) => {
    await open(page, `#th=${theme}&t=live:604800`);
    await audit(page, 'layers');
    await openPanel(page, 'filters');
    await audit(page, 'filters');
    await openPanel(page, 'feed');
    await expect(page.getByTestId('feed').locator('.feed-item').first()).toBeVisible();
    await audit(page, 'results');
    await openPanel(page, 'sources');
    await expect(page.locator('.source').first()).toBeVisible();
    await page.locator('.source[data-source="usgs-earthquakes"] .source-head').click();
    await audit(page, 'sources');
    await page.evaluate(() => window.__wim!.store.getState().select('usgs-earthquakes:aka2026whmgzn'));
    await expect(page.getByTestId('drawer-title')).toBeVisible();
    await audit(page, 'drawer');
    await page.getByTestId('mode-history').click();
    await audit(page, 'timeline history');
  });
}

test('main controls are reachable and operable by keyboard', async ({ page }) => {
  await open(page, '#l=earthquakes&t=live:604800');
  // first Tab stop is the skip link
  await page.keyboard.press('Tab');
  await expect(page.locator('.skip-link')).toBeFocused();
  // a layer switch is a real checkbox with role=switch and an accessible name; Space toggles it
  const sw = page.getByRole('switch', { name: 'Earthquakes (EMSC)' });
  await sw.focus();
  await expect(sw).toBeFocused();
  await page.keyboard.press('Space');
  await settled(page);
  expect((await state(page)).enabled).toContain('emsc-earthquakes');
  await page.keyboard.press('Space');
  await settled(page);
  expect((await state(page)).enabled).not.toContain('emsc-earthquakes');
  // group switches are named
  await expect(page.getByRole('switch', { name: 'All Natural hazards layers' })).toBeVisible();
  // panels are buttons with pressed state
  const filters = page.getByRole('button', { name: /^Filters/ });
  await filters.focus();
  await page.keyboard.press('Enter');
  await expect(filters).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByRole('region', { name: 'Filters' }).or(page.getByLabel('Filters', { exact: true })).first()).toBeVisible();
  // results are buttons; Enter opens the drawer, focus moves into it, Escape returns focus
  await page.getByRole('button', { name: /^Results/ }).click();
  const first = page.getByTestId('feed').locator('.feed-item').first();
  await first.focus();
  await page.keyboard.press('Enter');
  const drawer = page.getByRole('dialog', { name: 'Record details' });
  await expect(drawer).toBeVisible();
  await expect(drawer).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(drawer).toHaveCount(0);
  await expect(first).toBeFocused();
  // the map canvas is focusable and pans with the arrow keys
  const canvas = page.locator('.maplibregl-canvas');
  await expect(canvas).toHaveAttribute('aria-label', /World map/);
  const before = (await state(page)).view.lng;
  await canvas.focus();
  await page.keyboard.press('ArrowRight');
  await expect.poll(async () => (await state(page)).view.lng).toBeGreaterThan(before);
  // timeline controls are labelled
  await expect(page.getByRole('button', { name: 'Live' })).toHaveAttribute('aria-pressed', 'true');
  await page.getByRole('button', { name: 'History' }).click();
  await expect(page.getByRole('button', { name: 'Play' })).toBeVisible();
  await expect(page.getByRole('slider', { name: 'Timeline cursor' })).toBeVisible();
});

test('themes and the colour-blind-safe palette switch without reloading and persist', async ({ page }) => {
  await open(page, '#l=earthquakes,nws-warnings&t=live:604800');
  const colors = () => page.evaluate(() => ({
    theme: document.documentElement.dataset.theme,
    bg: getComputedStyle(document.body).backgroundColor,
    water: window.__wim!.map.getPaintProperty('bg', 'background-color'),
    quake: JSON.stringify(window.__wim!.map.getPaintProperty('clusters', 'circle-color')),
  }));
  const a = await colors();
  await page.getByTestId('theme-toggle').click();
  const b = await colors();
  expect(b.theme).not.toBe(a.theme);
  expect(b.bg).not.toBe(a.bg);
  expect(b.water).not.toBe(a.water);
  await page.getByTestId('palette-toggle').click();
  await expect(page.getByTestId('palette-toggle')).toHaveAttribute('aria-pressed', 'true');
  const c = await colors();
  expect(c.quake).not.toBe(b.quake); // layer colours come from the alternative palette
  expect(c.quake).toContain('#E69F00'); // Okabe–Ito orange for the earthquake layer
  await page.goto('/');
  await settled(page);
  const d = await colors();
  expect(d.theme).toBe(b.theme);
  await expect(page.getByTestId('palette-toggle')).toHaveAttribute('aria-pressed', 'true');
  // status is never conveyed by colour alone: every badge carries an icon and a text label
  await openPanel(page, 'sources');
  const badge = page.locator('.source[data-source="noaa-nhc"] .status');
  await expect(badge.locator('.status-icon')).toHaveText('!');
  await expect(badge).toContainText('Stale');
});
