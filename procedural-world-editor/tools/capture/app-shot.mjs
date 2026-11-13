// Drive the real editor headless (hardware GPU) and take screenshots.
// usage: node tools/capture/app-shot.mjs <outPrefix> <projectId> [step ...]
//   steps: "shot" | "wait:<ms>" | "ui" (full-page shot incl. panels) | any JS expression evaluated in the page
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
const JPG = process.env.JPG;
const out = process.argv[2];
const project = process.argv[3];
const steps = process.argv.slice(4);
mkdirSync(dirname(out), { recursive: true });
const browser = await chromium.launch({ headless: true, channel: 'chromium', args: ['--use-angle=vulkan', '--enable-features=Vulkan', '--enable-gpu', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: +(process.env.W || 1920), height: +(process.env.H || 1080) } });
const logs = [];
page.on('console', (m) => { const t = m.text(); if (m.type() === 'error' || /SHADER|THREE\./.test(t)) logs.push(`[${m.type()}] ${t.slice(0, 1500)}`); });
page.on('pageerror', (e) => logs.push('[pageerror] ' + e.message + '\n' + (e.stack || '').slice(0, 600)));
const base = process.env.URL || 'http://127.0.0.1:5173';
const t0 = Date.now();
await page.goto(`${base}/?project=${project}&capture${process.env.QUALITY ? '&quality=' + process.env.QUALITY : ''}`);
try {
  await page.waitForFunction(() => window.__app && ((window.__app.ready && window.__app.world && !document.getElementById('progress')) || window.__app.errors.length), null, { timeout: 240000 });
} catch (e) { logs.push('timeout waiting for the editor'); }
console.log('loaded in', ((Date.now() - t0) / 1000).toFixed(1), 's');
await page.waitForTimeout(+(process.env.SETTLE || 3000));
await page.addScriptTag({ path: new URL('../dev/views.js', import.meta.url).pathname }).catch(() => {});
await page.evaluate(() => document.body.classList.add('clean'));
let i = 0;
const canvas = page.locator('#viewport canvas');
for (const s of steps.length ? steps : ['shot']) {
  if (s === 'shot') { const f = `${out}-${i++}.png`; await canvas.screenshot({ path: f }); console.log('wrote', f); continue; }
  if (s === 'ui') { const f = `${out}-${i++}.png`; await page.screenshot({ path: f }); console.log('wrote', f); continue; }
  if (s.startsWith('wait:')) { await page.waitForTimeout(+s.slice(5)); continue; }
  try { const r = await page.evaluate(s); if (r !== undefined) console.log('eval ->', JSON.stringify(r)?.slice(0, 3000)); } catch (e) { console.log('eval error:', e.message.slice(0, 500)); }
}
const errs = await page.evaluate(() => (window.__app ? window.__app.errors : ['no __app']));
if (errs.length) console.log('APP ERRORS:\n' + [...new Set(errs)].slice(0, 8).join('\n').slice(0, 5000));
if (logs.length) console.log('CONSOLE:\n' + [...new Set(logs)].slice(0, 10).join('\n').slice(0, 7000));
await browser.close();
