import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import { open, settled, state, toggleLayer } from './helpers';

test('mobile layout: bottom sheets, reachable controls, no horizontal overflow', async ({ page }) => {
  await open(page, '#l=earthquakes&t=live:604800');
  const vw = page.viewportSize()!.width;
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(vw);
  await expect(page.getByTestId('fixture-banner')).toBeVisible();
  await expect(page.locator('.banner-short')).toBeVisible(); // the warning itself must fit on a phone, not be clipped
  await expect(page.locator('.banner-short')).toContainText('Not live intelligence');
  await expect(page.getByTestId('mode-chip')).toBeVisible();
  // the map is visible and has data before any panel is opened
  expect((await state(page)).total).toBeGreaterThan(0);
  const mapBox = (await page.getByTestId('map').boundingBox())!;
  expect(mapBox.height).toBeGreaterThan(250);

  // layers open as a bottom sheet that leaves part of the map visible
  await page.getByTestId('tab-layers').tap();
  const sheet = (await page.locator('#sidebar').boundingBox())!;
  expect(sheet.width).toBeGreaterThan(vw - 2);
  expect(sheet.y).toBeGreaterThan(mapBox.y + 60);
  await toggleLayer(page, 'emsc-earthquakes');
  await settled(page);
  expect((await state(page)).enabled).toEqual(['earthquakes', 'emsc-earthquakes']);
  // touch targets are comfortably large
  const row = (await page.locator('.layer-main').first().boundingBox())!;
  expect(row.height).toBeGreaterThanOrEqual(40);

  // results → record sheet
  await page.getByTestId('tab-feed').tap();
  await page.getByTestId('feed').locator('.feed-item').first().tap();
  const drawer = page.getByTestId('drawer');
  await expect(drawer).toBeVisible();
  const d = (await drawer.boundingBox())!;
  expect(d.width).toBeGreaterThan(vw - 2);
  await expect(page.getByTestId('drawer-title')).toBeVisible();
  await page.getByTestId('drawer-close').tap();
  await expect(drawer).toHaveCount(0);

  // timeline stays usable
  await page.locator('#sidebar .icon-btn[aria-label="Close panel"]').tap();
  await page.getByTestId('mode-history').tap();
  await expect(page.getByTestId('play')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(vw);

  const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).exclude('.maplibregl-canvas-container').analyze();
  expect(results.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical').map((v) => `${v.id}: ${v.nodes[0]?.target.join(' ')}`)).toEqual([]);
});
