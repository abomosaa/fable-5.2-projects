import { chromium } from 'playwright';
import { mkdirSync, writeFileSync } from 'node:fs';

export const URL = process.env.MW_URL ?? 'http://127.0.0.1:4173/';
export const OUT = process.env.MW_OUT ?? 'docs/verification/e2e';
mkdirSync(OUT, { recursive: true });

export async function launch(opts = {}) {
  const gpu = process.env.MW_GPU === '1';
  const browser = await chromium.launch({
    headless: !process.env.MW_HEADED,
    args: gpu ? ['--ignore-gpu-blocklist', '--enable-gpu', '--use-angle=default'] : ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
  });
  const ctx = await browser.newContext({ viewport: { width: opts.w ?? 1600, height: opts.h ?? 960 }, deviceScaleFactor: 1, acceptDownloads: true });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push('PAGEERROR ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push('CONSOLE ' + m.text()); });
  return { browser, ctx, page, errors };
}

export async function fresh(page) {
  await page.goto(URL);
  await page.waitForSelector('.app[data-ready="true"]', { timeout: 30000 });
  await page.evaluate(() => localStorage.clear());
  await page.goto(URL);
  await page.waitForSelector('[data-testid="dialog-welcome"]', { timeout: 30000 });
}

export const st = (page, fn, arg) => page.evaluate(fn, arg);

/** client coordinates of a part's port */
export async function portXY(page, partName, port) {
  const r = await page.evaluate(([n, p]) => { const s = window.__mw.getState(); const part = s.project.parts.find((x) => x.name === n); return part ? window.__mwView.portToClient(part.id, p) : null; }, [partName, port]);
  if (!r) throw new Error(`port ${partName}.${port} not found`);
  return r;
}

/** client coordinates of a part-local point on the part's top face */
export async function localXY(page, partName, lx, ly) {
  return page.evaluate(([n, x, y]) => {
    const s = window.__mw.getState(); const part = s.project.parts.find((q) => q.name === n);
    const c = Math.cos(part.pose.angle), si = Math.sin(part.pose.angle);
    return window.__mwView.worldToClient(part.pose.x + c * x - si * y, part.pose.y + si * x + c * y, window.__mwView.topZ(part.id));
  }, [partName, lx, ly]);
}

export async function drag(page, from, to, steps = 12) {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  for (let i = 1; i <= steps; i++) await page.mouse.move(from.x + ((to.x - from.x) * i) / steps, from.y + ((to.y - from.y) * i) / steps);
  await page.waitForTimeout(60);
  await page.mouse.up();
  await page.waitForTimeout(150);
}

export async function setField(page, testId, value) {
  const el = page.locator(`[data-testid="${testId}"]`).first();
  await el.click();
  await el.fill(String(value));
  await el.press('Enter');
  await page.waitForTimeout(120);
}

export async function shot(page, name) {
  const path = `${OUT}/${name}.png`;
  await page.screenshot({ path });
  return path;
}

export class Log {
  constructor(name) { this.name = name; this.steps = []; this.fail = 0; }
  check(label, cond, detail = '') {
    this.steps.push({ label, ok: !!cond, detail: typeof detail === 'string' ? detail : JSON.stringify(detail) });
    if (!cond) this.fail++;
    console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + (typeof detail === 'string' ? detail : JSON.stringify(detail)) : ''}`);
  }
  note(label, detail) { this.steps.push({ label, ok: null, detail: typeof detail === 'string' ? detail : JSON.stringify(detail) }); console.log(`INFO  ${label}  — ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`); }
  save() { writeFileSync(`${OUT}/${this.name}.json`, JSON.stringify({ name: this.name, failures: this.fail, steps: this.steps }, null, 1)); }
}

export const simInfo = (page) => page.evaluate(() => {
  const m = window.__mw; const r = m.simCtl.runner; const s = m.getState();
  if (!r) return { status: s.simStatus };
  return {
    status: s.simStatus, t: +r.time.toFixed(4), mode: r.model.mode, dof: r.dof, bodies: r.model.bodies.length, rows: r.sim.mB,
    posError: r.sim.stats.posError, maxPosError: r.sim.stats.maxPosError, samples: r.n, stepMs: +r.stepTimeAvgMs.toFixed(4), fps: +m.simCtl.fps.toFixed(1), realtime: +m.simCtl.realtimeFactor.toFixed(2),
    events: r.events.map((e) => ({ sev: e.severity, code: e.code, title: e.title, t: e.time })), static: r.staticDiagnostics.map((e) => ({ sev: e.severity, code: e.code, title: e.title })),
    walk: r.model.floorEnabled ? { travel: +r.walk.travel.toFixed(2), slide: +r.walk.slide.toFixed(2), contacts: r.walk.contactsNow, summary: r.walkSummary()?.title } : undefined,
  };
});
