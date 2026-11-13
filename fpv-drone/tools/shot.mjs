// Drives the built app in headless Chrome and saves screenshots (developer tool).
//   node tools/shot.mjs [url]
import puppeteer from 'puppeteer-core';
import { mkdirSync } from 'node:fs';

const url = process.argv[2] ?? 'http://localhost:4173/';
const out = new URL('./out/', import.meta.url).pathname;
mkdirSync(out, { recursive: true });
const exe = process.env.CHROME ?? '/home/h4ni0/.local/bin/google-chrome';
const gl = process.env.GL ?? 'swiftshader';
const args = ['--no-sandbox', '--window-size=1600,900', '--ignore-gpu-blocklist', '--enable-webgl', '--mute-audio', '--autoplay-policy=no-user-gesture-required'];
if (gl === 'swiftshader') args.push('--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader');
else args.push('--use-gl=angle', `--use-angle=${gl}`, '--enable-gpu');

const vw = parseInt(process.env.VW ?? '1600', 10), vh = parseInt(process.env.VH ?? '900', 10);
const browser = await puppeteer.launch({ executablePath: exe, headless: 'new', args, defaultViewport: { width: vw, height: vh } });
const page = await browser.newPage();
const logs = [];
page.on('console', (m) => logs.push(`[${m.type()}] ${m.text()}`));
page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}\n${e.stack ?? ''}`));
await page.goto(url, { waitUntil: 'load' });
await page.waitForFunction(() => window.__fpv !== undefined, { timeout: 120000 });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
await wait(1500);
const shot = async (name) => { await page.screenshot({ path: `${out}${name}.png` }); console.log('saved', name); };

const scenario = process.argv[3] ?? 'all';
const info = await page.evaluate(() => {
  const gl = document.createElement('canvas').getContext('webgl2');
  const ext = gl?.getExtension('WEBGL_debug_renderer_info');
  return { renderer: ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : 'n/a' };
});
console.log('GL renderer:', info.renderer);

await shot('01-menu');
// Close the menu and look around.
await page.evaluate(() => window.__fpv.setPaused(false));
await wait(1200);
await shot('02-fpv-pad');

const place = async (x, y, z, headingDeg, pitchDeg = 0, rollDeg = 0, view = 'fpv') => {
  await page.evaluate((x, y, z, h, p, r, view) => {
    const f = window.__fpv;
    f.settings.view = view;
    const d = f.sim.drone;
    f.sim.timeScale = 0; // freeze
    d.pos.x = x; d.pos.y = y; d.pos.z = z;
    d.vel.x = d.vel.y = d.vel.z = 0;
    const D = Math.PI / 180;
    const qa = (ax, ay, az, a) => ({ w: Math.cos(a / 2), x: ax * Math.sin(a / 2), y: ay * Math.sin(a / 2), z: az * Math.sin(a / 2) });
    const mul = (a, b) => ({ w: a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z, x: a.w * b.x + a.x * b.w + a.y * b.z - a.z * b.y, y: a.w * b.y - a.x * b.z + a.y * b.w + a.z * b.x, z: a.w * b.z + a.x * b.y - a.y * b.x + a.z * b.w });
    const q = mul(mul(qa(0, 1, 0, -h * D), qa(1, 0, 0, p * D)), qa(0, 0, 1, -r * D));
    Object.assign(d.q, q);
  }, x, y, z, headingDeg, pitchDeg, rollDeg, view);
  await wait(500);
};

if (scenario === 'all' || scenario === 'tour') {
  await place(0, 1.6, 8, 0, 0); await shot('03-fpv-behind-pad');
  await place(0, 1.4, -14, 0, -20); await shot('04-fpv-gate');
  await place(100, 6, -20, 70, -15); await shot('05-fpv-bando');
  await place(105, 2.0, -3.2, 90, -10); await shot('06-fpv-containers');
  await place(-40, 12, -20, 300, -20); await shot('07-fpv-pitch');
  await place(-20, 3, 44, 270, -5); await shot('08-fpv-barn');
  await place(0, 60, 60, 0, -35); await shot('09-fpv-high');
  await place(6, 3, -8, 200, 0, 0, 'los'); await shot('10-los');
  await place(20, 4, -40, 45, -10, 15, 'chase'); await shot('11-chase');
  await place(-22, 2.5, -30, 0, 0, 0); await shot('12-fpv-tree');
  await place(30, 25, -60, 60, -25, 30); await shot('13-fpv-banked');
}
if (scenario === 'all' || scenario === 'fly') {
  // Real flight inside the page, paced by simulation time so it does not depend on frame rate.
  await page.evaluate(() => { const f = window.__fpv; f.reset(); f.settings.view = 'fpv'; f.settings.mode = 'angle'; f.settings.osd.telemetry = true; f.apply('graphics'); f.apply('fc'); f.apply('sim'); f.sim.timeScale = 1; f.rcOverride = { roll: 0, pitch: 0, yaw: 0, throttle: 0 }; });
  const state = () => page.evaluate(() => { const s = window.__fpv.sim; const d = s.drone; return { armed: s.fc.armed, x: +d.pos.x.toFixed(1), y: +d.pos.y.toFixed(2), z: +d.pos.z.toFixed(1), thr: +s.fc.throttle.toFixed(2), kmh: +(Math.hypot(d.vel.x, d.vel.y, d.vel.z) * 3.6).toFixed(0), rpm: Math.round(d.rotors[0].rpm), amps: +d.packCurrent.toFixed(1), vbus: +d.vbus.toFixed(2), crashed: s.crashed, t: +s.time.toFixed(2), gate: s.lap.nextGate }; });
  const rc = (o) => page.evaluate((o) => Object.assign(window.__fpv.rcOverride, o), o);
  const until = async (dtSim) => {
    const t0 = (await state()).t;
    for (let i = 0; i < 2000; i++) { if ((await state()).t >= t0 + dtSim) return; await wait(30); }
  };
  await page.evaluate(() => window.__fpv.sim.arm());
  await until(0.5);
  console.log('armed idle ', JSON.stringify(await state()));
  await rc({ throttle: 0.26 }); await until(1.6);
  await rc({ throttle: 0.165 }); await until(0.6);
  console.log('hover      ', JSON.stringify(await state()));
  await shot('21-hover');
  await rc({ pitch: 0.45, throttle: 0.2 }); await until(1.6);
  console.log('forward    ', JSON.stringify(await state()));
  await shot('22-forward');
  await until(1.0);
  await rc({ pitch: 0.2, roll: 0.5, yaw: 0.35, throttle: 0.24 }); await until(1.4);
  console.log('turning    ', JSON.stringify(await state()));
  await shot('23-turn');
  await rc({ pitch: 0, roll: 0, yaw: 0, throttle: 0.17 });
  await page.evaluate(() => { window.__fpv.settings.view = 'los'; });
  await until(1.2);
  await shot('24-los-flying');
  await page.evaluate(() => { window.__fpv.settings.view = 'chase'; });
  await until(0.6);
  await shot('25-chase-flying');
  console.log('end        ', JSON.stringify(await state()));
  await page.evaluate(() => { window.__fpv.rcOverride = null; });
}
if (scenario === 'all' || scenario === 'crash') {
  // Fly into the stair core of the concrete frame at speed.
  await page.evaluate(() => {
    const f = window.__fpv;
    f.settings.view = 'fpv'; f.settings.mode = 'angle'; f.settings.osd.telemetry = false;
    f.apply('graphics'); f.apply('fc');
    f.reset(); f.apply('sim'); f.sim.timeScale = 1;
    f.rcOverride = { roll: 0, pitch: 0, yaw: 0, throttle: 0 };
    f.sim.rc.throttle = 0; // the frame loop has not copied the override yet
    f.sim.arm();
    const d = f.sim.drone;
    d.pos.x = 100; d.pos.y = 5; d.pos.z = -40;
    // face east (+X): heading 90 deg => rotation about Y by -90 deg
    const a = -Math.PI / 2;
    d.q.w = Math.cos(a / 2); d.q.x = 0; d.q.y = Math.sin(a / 2); d.q.z = 0;
    d.vel.x = 22; d.vel.y = 0; d.vel.z = 0;
    f.rcOverride.throttle = 0.17; f.rcOverride.pitch = 0.4;
  });
  await wait(700);
  await shot('26-before-impact');
  await wait(2500);
  const st = await page.evaluate(() => { const s = window.__fpv.sim; return { crashed: s.crashed, kmh: Math.round(s.crashSpeed * 3.6), armed: s.fc.armed, x: +s.drone.pos.x.toFixed(1), y: +s.drone.pos.y.toFixed(2) }; });
  console.log('crash       ', JSON.stringify(st));
  await shot('27-crashed');
  await page.evaluate(() => { window.__fpv.settings.view = 'chase'; });
  await wait(600);
  await shot('28-crashed-chase');
  await page.evaluate(() => { const f = window.__fpv; f.rcOverride = null; f.reset(); f.settings.view = 'fpv'; });
}
if (scenario === 'all' || scenario === 'menu') {
  await page.evaluate(() => window.__fpv.setPaused(true));
  await wait(300);
  const tabs = await page.$$('#menu .tab');
  const names = ['fly', 'rates', 'weather', 'controller', 'display', 'help'];
  for (let i = 0; i < tabs.length; i++) {
    await tabs[i].click();
    await wait(250);
    await shot('30-menu-' + names[i]);
  }
  await page.evaluate(() => window.__fpv.setPaused(false));
}
if (logs.length) console.log(logs.slice(0, 40).join('\n'));
else console.log('no console output');
await browser.close();
