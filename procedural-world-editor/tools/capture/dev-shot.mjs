// Launch the dev render harness headless (hardware GPU) and take screenshots.
// usage: node tools/capture/dev-shot.mjs <outPrefix> [query] [evalJS ...]
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
const out = process.argv[2] || '.cache/dev/shot';
const query = process.argv[3] || '';
const steps = process.argv.slice(4);
mkdirSync(dirname(out), { recursive: true });
const browser = await chromium.launch({ headless: true, channel: 'chromium', args: ['--use-angle=vulkan', '--enable-features=Vulkan', '--enable-gpu', '--ignore-gpu-blocklist', '--enable-unsafe-webgpu'] });
const page = await browser.newPage({ viewport: { width: +(process.env.W || 1600), height: +(process.env.H || 900) } });
const logs = [];
page.on('console', (m) => { const t = m.text(); if (m.type() === 'error' || /SHADER|WebGL|THREE/.test(t)) logs.push(`[${m.type()}] ${t.slice(0, 1800)}`); });
page.on('pageerror', (e) => logs.push('[pageerror] ' + e.message));
const base = process.env.URL || 'http://127.0.0.1:5173';
await page.goto(`${base}/dev.html?${query}`);
try {
  await page.waitForFunction(() => window.__dbg && (window.__dbg.ready || window.__dbg.errors.length), null, { timeout: 180000 });
} catch (e) { logs.push('timeout waiting for ready'); }
await page.waitForTimeout(+(process.env.SETTLE || 2500));
let i = 0;
const shot = async () => { const f = `${out}-${i++}.png`; await page.screenshot({ path: f }); console.log('wrote', f); };
if (!steps.length) await shot();
for (const s of steps) {
  if (s === 'shot') { await shot(); continue; }
  if (s.startsWith('wait:')) { await page.waitForTimeout(+s.slice(5)); continue; }
  const r = await page.evaluate(s);
  if (r !== undefined) console.log('eval ->', JSON.stringify(r));
}
const errs = await page.evaluate(() => window.__dbg ? window.__dbg.errors : ['no __dbg']);
console.log('log text:', await page.evaluate(() => document.getElementById('log').textContent));
if (errs.length) console.log('ERRORS:\n' + errs.slice(0, 8).join('\n').slice(0, 6000));
if (logs.length) console.log('CONSOLE:\n' + [...new Set(logs)].slice(0, 12).join('\n').slice(0, 9000));
await browser.close();
