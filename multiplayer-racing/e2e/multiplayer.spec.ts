import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';

interface ApexCar {
  slot: number;
  x: number;
  z: number;
  speed: number;
  rank: number;
  cp: number;
  local: boolean;
  name: string;
}

interface ApexState {
  screen: string;
  status: string;
  name: string;
  youId: string;
  isHost: boolean;
  room: { code: string; phase: string; hostId: string; members: Array<{ id: string; name: string; role: string; ready: boolean; connected: boolean; slot: number; colour: number }> } | null;
  publicRooms: string[];
  race: { raceId: number; trackId: string; slot: number; goTick: number; serverTick: number; phase: number; predicting: boolean; snapshots: number; inputsSent: number; cars: ApexCar[] } | null;
}

/** A player in their own isolated browser context (separate storage, separate socket). */
async function player(browser: Browser, name: string, path = '/'): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext();
  await context.addInitScript((driverName) => {
    // Low graphics settings keep software-rendered WebGL responsive.
    if (!localStorage.getItem('apex-drift.settings.v1')) {
      localStorage.setItem('apex-drift.settings.v1', JSON.stringify({ name: driverName, quality: 'low', muted: true, reducedMotion: true, nameTags: false }));
    }
  }, name);
  const page = await context.newPage();
  page.on('pageerror', (error) => {
    throw error;
  });
  await page.goto(path);
  await page.waitForFunction(() => (window as unknown as { __apex?: { state(): { status: string } } }).__apex?.state().status === 'open');
  return { context, page };
}

function state(page: Page): Promise<ApexState> {
  return page.evaluate(() => (window as unknown as { __apex: { state(): unknown } }).__apex.state()) as Promise<ApexState>;
}

test('two isolated browsers: create a public room, discover it, join, and race in sync', async ({ browser }) => {
  const host = await player(browser, 'Alice');
  const guest = await player(browser, 'Bruno');

  // --- Alice creates a public room through the UI.
  await expect(host.page.locator('#screen-home')).toBeVisible();
  await host.page.click('#btn-create');
  await host.page.fill('#room-name', 'Playwright Grand Prix');
  await host.page.keyboard.press('Tab');
  await host.page.click('#btn-create-confirm');
  await expect(host.page.locator('#screen-lobby')).toBeVisible();
  const code = (await host.page.locator('#room-code').textContent())?.trim() ?? '';
  expect(code).toMatch(/^[A-Z0-9]{5}$/);
  expect(host.page.url()).toContain(`room=${code}`);

  // --- Bruno, in a different browser context, finds it in the public room browser.
  await guest.page.click('#btn-browse');
  const card = guest.page.locator(`.room-card[data-code="${code}"]`);
  await expect(card).toBeVisible();
  await expect(card).toContainText('Playwright Grand Prix');
  await expect(card).toContainText('Host: Alice');
  await expect(card).toContainText('Harbor Circuit');
  await expect(card).toContainText('3 laps');
  await expect(card).toContainText('1/8');
  await expect(card).toContainText('Open lobby');
  await expect(card).toContainText('e2e-local');
  await expect(card).toContainText(/\d+ ms/);
  await card.getByRole('button', { name: 'Join', exact: true }).click();
  await expect(guest.page.locator('#screen-lobby')).toBeVisible();
  await expect(guest.page.locator('#room-code')).toHaveText(code);

  // --- Both lobbies show two distinct drivers.
  for (const page of [host.page, guest.page]) {
    await expect(page.locator('#drivers .member')).toHaveCount(2);
    await expect(page.locator('#drivers')).toContainText('Alice');
    await expect(page.locator('#drivers')).toContainText('Bruno');
  }
  await expect(guest.page.locator('#screen-browser')).toBeHidden();

  // --- Ready state gates the start.
  await expect(host.page.locator('#btn-start')).toBeDisabled();
  await expect(host.page.locator('#lobby-hint')).toContainText('Bruno');
  await guest.page.click('#btn-ready');
  await expect(host.page.locator('#btn-start')).toBeEnabled();
  await host.page.click('#btn-start');

  // --- Both enter the same race.
  await expect(host.page.locator('#hud')).toBeVisible();
  await expect(guest.page.locator('#hud')).toBeVisible();
  await host.page.waitForFunction(() => ((window as unknown as { __apex: { state(): ApexState } }).__apex.state().race?.snapshots ?? 0) > 5);
  await guest.page.waitForFunction(() => ((window as unknown as { __apex: { state(): ApexState } }).__apex.state().race?.snapshots ?? 0) > 5);
  const a0 = await state(host.page);
  const b0 = await state(guest.page);
  expect(a0.room!.code).toBe(code);
  expect(b0.room!.code).toBe(code);
  expect(a0.race!.raceId).toBe(b0.race!.raceId);
  expect(a0.race!.goTick).toBe(b0.race!.goTick); // Synchronised start: one green light for everyone.
  expect(a0.race!.trackId).toBe('harbor');
  // Distinct identities.
  expect(a0.youId).not.toBe(b0.youId);
  expect(a0.name).toBe('Alice');
  expect(b0.name).toBe('Bruno');
  expect(a0.isHost).toBe(true);
  expect(b0.isHost).toBe(false);
  expect(a0.race!.slot).toBeGreaterThanOrEqual(0);
  expect(b0.race!.slot).toBeGreaterThanOrEqual(0);
  expect(a0.race!.slot).not.toBe(b0.race!.slot);
  // Same field of cars on both screens (two humans plus the default bots).
  expect(a0.race!.cars.map((c) => c.name).sort()).toEqual(b0.race!.cars.map((c) => c.name).sort());
  expect(a0.race!.cars.length).toBeGreaterThanOrEqual(2);
  expect(a0.race!.cars.find((c) => c.local)!.name).toBe('Alice');
  expect(b0.race!.cars.find((c) => c.local)!.name).toBe('Bruno');
  await expect(host.page.locator('#hud-lights')).toBeVisible();

  // --- Green light on both, then only Alice drives.
  const racing = (): boolean => {
    const race = (window as unknown as { __apex: { state(): ApexState } }).__apex.state().race;
    return race !== null && race.phase === 1 && race.predicting;
  };
  await host.page.waitForFunction(racing, null, { timeout: 30_000 });
  await guest.page.waitForFunction(racing, null, { timeout: 30_000 });
  const gridA = a0.race!.cars.find((c) => c.slot === a0.race!.slot)!;
  await host.page.bringToFront();
  await host.page.keyboard.down('KeyW');
  await host.page.waitForFunction(
    () => {
      const race = (window as unknown as { __apex: { state(): ApexState } }).__apex.state().race;
      const mine = race?.cars.find((c) => c.local);
      return mine !== undefined && mine.speed > 12;
    },
    null,
    { timeout: 30_000 },
  );

  // --- Bruno's browser sees Alice's car move: real replication through the server.
  const aliceSlot = a0.race!.slot;
  await guest.page.waitForFunction(
    ([slot, x, z]) => {
      const race = (window as unknown as { __apex: { state(): ApexState } }).__apex.state().race;
      const car = race?.cars.find((c) => c.slot === slot);
      return car !== undefined && car.speed > 8 && Math.hypot(car.x - x!, car.z - z!) > 15;
    },
    [aliceSlot, gridA.x, gridA.z] as const,
    { timeout: 30_000 },
  );
  const [a1, b1] = await Promise.all([state(host.page), state(guest.page)]);
  const aliceOnHost = a1.race!.cars.find((c) => c.slot === aliceSlot)!;
  const aliceOnGuest = b1.race!.cars.find((c) => c.slot === aliceSlot)!;
  // Both browsers agree on where Alice is (allowing for latency and frame timing at speed).
  expect(Math.hypot(aliceOnHost.x - aliceOnGuest.x, aliceOnHost.z - aliceOnGuest.z)).toBeLessThan(45);
  // Bruno never touched the controls: his car is still on the grid in both views.
  const brunoOnGuest = b1.race!.cars.find((c) => c.local)!;
  const brunoOnHost = a1.race!.cars.find((c) => c.slot === b0.race!.slot)!;
  expect(brunoOnGuest.speed).toBeLessThan(1);
  expect(brunoOnHost.speed).toBeLessThan(1);
  expect(Math.hypot(brunoOnHost.x - brunoOnGuest.x, brunoOnHost.z - brunoOnGuest.z)).toBeLessThan(1);
  // Alice is ahead of Bruno on both screens.
  expect(aliceOnHost.rank).toBeLessThan(brunoOnHost.rank);
  expect(aliceOnGuest.rank).toBeLessThan(brunoOnGuest.rank);
  expect(a1.race!.inputsSent).toBeGreaterThan(30);

  // --- The HUD reflects the authoritative state.
  await expect(host.page.locator('#hud-lap')).toHaveText('1 / 3');
  await expect(host.page.locator('#hud-position')).toHaveText(/^\d(st|nd|rd|th)$/);
  await expect(host.page.locator('#hud-speed')).not.toHaveText('0');
  await expect(host.page.locator('#hud-net')).toContainText(/ms/);
  await expect(guest.page.locator('#hud-board .board-row')).toHaveCount(a0.race!.cars.length);
  await host.page.keyboard.up('KeyW');

  // --- The host cancels; both return to the lobby with an explanation.
  await host.page.keyboard.press('Escape');
  await host.page.click('#btn-abort');
  await host.page.getByRole('button', { name: 'Cancel race', exact: true }).click();
  for (const page of [host.page, guest.page]) {
    await expect(page.getByRole('dialog', { name: 'Race cancelled' })).toBeVisible();
    await page.getByRole('button', { name: 'OK' }).click();
    await expect(page.locator('#screen-lobby')).toBeVisible();
    await expect(page.locator('#race-note')).toContainText('cancelled');
  }

  await host.context.close();
  await guest.context.close();
});

test('invite links, private rooms, reconnecting and clear error states', async ({ browser }) => {
  const host = await player(browser, 'Carla');

  // --- An empty directory is explained, not just blank.
  await host.page.click('#btn-browse');
  await expect(host.page.locator('#rooms-empty')).toBeVisible();
  await expect(host.page.locator('#rooms-empty')).toContainText('No public rooms');

  // --- A private room is not listed, but its invite link works.
  await host.page.click('#btn-create-2');
  await host.page.uncheck('#room-public');
  await host.page.click('#btn-create-confirm');
  await expect(host.page.locator('#screen-lobby')).toBeVisible();
  const code = (await host.page.locator('#room-code').textContent())!.trim();
  const invite = await host.page.locator('#invite-url').inputValue();
  expect(invite).toContain(`?room=${code}`);

  const guest = await player(browser, 'Dmitri', `/?room=${code}`);
  await expect(guest.page.getByRole('dialog', { name: `Join room ${code}` })).toBeVisible();
  await guest.page.click('#btn-invite-join');
  await expect(guest.page.locator('#screen-lobby')).toBeVisible();
  await expect(host.page.locator('#drivers .member')).toHaveCount(2);

  const outsider = await player(browser, 'Erin');
  await outsider.page.click('#btn-browse');
  await expect(outsider.page.locator('#rooms-empty')).toBeVisible();
  expect((await state(outsider.page)).publicRooms).toEqual([]);

  // --- A code that does not exist gives a clear message.
  await outsider.page.click('#btn-back');
  await outsider.page.fill('#join-code', 'ZZZZZ');
  await outsider.page.click('#btn-join-code');
  await expect(outsider.page.getByRole('dialog', { name: 'Room unavailable' })).toBeVisible();
  await outsider.page.getByRole('button', { name: 'OK' }).click();

  // --- Chat reaches the other browser as plain text, never as markup.
  await guest.page.fill('#chat-input', '<img src=x onerror="window.pwned=1"> hello host');
  await guest.page.keyboard.press('Enter');
  await expect(host.page.locator('#chat-log')).toContainText('hello host');
  expect(await host.page.locator('#chat-log img').count()).toBe(0);
  expect(await host.page.evaluate(() => (window as unknown as { pwned?: number }).pwned)).toBeUndefined();

  // --- A dropped connection is shown, then recovered into the same seat.
  const before = await state(guest.page);
  await guest.page.evaluate(() => (window as unknown as { __apex: { dropConnection(): void } }).__apex.dropConnection());
  await expect(host.page.locator(`.member[data-member="${before.youId}"]`)).toContainText('Reconnecting');
  await guest.page.waitForFunction(() => (window as unknown as { __apex: { state(): ApexState } }).__apex.state().status === 'open', null, { timeout: 20_000 });
  await expect(guest.page.locator('#screen-lobby')).toBeVisible();
  const after = await state(guest.page);
  expect(after.youId).toBe(before.youId);
  expect(after.room!.code).toBe(code);
  await expect(host.page.locator(`.member[data-member="${before.youId}"]`)).not.toContainText('Reconnecting');

  // --- Reloading the page resumes the seat as well.
  await guest.page.reload();
  await guest.page.waitForFunction(() => (window as unknown as { __apex?: { state(): ApexState } }).__apex?.state().room !== null && (window as unknown as { __apex: { state(): ApexState } }).__apex.state().room !== undefined);
  expect((await state(guest.page)).youId).toBe(before.youId);
  await expect(guest.page.locator('#screen-lobby')).toBeVisible();

  // --- The host hands over when leaving; the guest becomes host.
  await host.page.click('#btn-leave');
  await expect(host.page.locator('#screen-lobby')).toBeHidden();
  await expect(guest.page.locator('#btn-start')).toBeVisible();
  expect((await state(guest.page)).isHost).toBe(true);

  // --- Kicking shows the kicked player why they left.
  await outsider.page.fill('#join-code', code);
  await outsider.page.click('#btn-join-code');
  await expect(outsider.page.locator('#screen-lobby')).toBeVisible();
  await guest.page.locator('#drivers .member', { hasText: 'Erin' }).getByRole('button', { name: 'Kick' }).click();
  await guest.page.getByRole('button', { name: 'Remove', exact: true }).click();
  await expect(outsider.page.getByRole('dialog', { name: 'Removed from the room' })).toBeVisible();

  await host.context.close();
  await guest.context.close();
  await outsider.context.close();
});
