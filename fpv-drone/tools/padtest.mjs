// Developer tool: exercises the controller code path with an emulated RC radio
// (the Gamepad API is replaced by a fake device inside headless Chrome).
//   node tools/padtest.mjs [url]
import puppeteer from 'puppeteer-core';
import { mkdirSync } from 'node:fs';

const url = process.argv[2] ?? 'http://localhost:4173/';
const out = new URL('./out/', import.meta.url).pathname;
mkdirSync(out, { recursive: true });
const exe = process.env.CHROME ?? '/home/h4ni0/.local/bin/google-chrome';
const gl = process.env.GL ?? 'swiftshader';
const args = ['--no-sandbox', '--window-size=1600,900', '--ignore-gpu-blocklist', '--mute-audio'];
if (gl === 'swiftshader') args.push('--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader');
else args.push('--use-gl=angle', '--use-angle=' + gl, '--enable-gpu');

const browser = await puppeteer.launch({ executablePath: exe, headless: 'new', args, defaultViewport: { width: 1600, height: 900 } });
const page = await browser.newPage();
const logs = [];
page.on('console', (m) => logs.push('[' + m.type() + '] ' + m.text()));
page.on('pageerror', (e) => logs.push('[pageerror] ' + e.message + '\n' + (e.stack ?? '')));

await page.evaluateOnNewDocument(() => {
  // An EdgeTX-style radio: 8 axes (A E T R + 4 switches), 0 pressed buttons.
  const pad = {
    id: 'Fake Radio TX16S Joystick (Vendor: 1209 Product: 4f54)', index: 0, connected: true, mapping: '', timestamp: 0,
    axes: [0, 0, -1, 0, -1, -1, 0, 0],
    buttons: Array.from({ length: 8 }, () => ({ pressed: false, touched: false, value: 0 })),
  };
  window.__pad = pad;
  navigator.getGamepads = () => [pad, null, null, null];
  localStorage.clear();
});
await page.goto(url, { waitUntil: 'load' });
await page.waitForFunction(() => window.__fpv !== undefined, { timeout: 120000 });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const shot = async (name) => { await page.screenshot({ path: out + name + '.png' }); console.log('saved', name); };
const axes = (a) => page.evaluate((a) => { a.forEach((v, i) => { if (v !== null) window.__pad.axes[i] = v; }); }, a);
const rc = () => page.evaluate(() => { const f = window.__fpv; const r = f.input.rc; return { src: f.input.source, roll: +r.roll.toFixed(2), pitch: +r.pitch.toFixed(2), yaw: +r.yaw.toFixed(2), thr: +r.throttle.toFixed(2), armed: f.sim.fc.armed, block: f.sim.armBlock }; });
const check = (label, cond) => { console.log((cond ? 'ok   ' : 'FAIL ') + label); if (!cond) process.exitCode = 1; };

await wait(800);
// Controller tab with the device present.
const tabs = await page.$$('#menu .tab');
await tabs[3].click();
await wait(400);
await axes([0.5, -0.25, 0.2, -0.6]);
await wait(300);
await shot('40-controller-radio');
let s = await rc();
console.log(JSON.stringify(s));
check('radio is picked up as the stick source', s.src === 'gamepad');
check('AETR default mapping', s.roll === 0.5 && s.pitch === -0.25 && s.yaw === -0.6 && Math.abs(s.thr - 0.6) < 0.011);

// "Detect": reassign pitch to axis 6 by moving it, inverted direction.
const detect = await page.$$('#menu table.map .btn');
await axes([0, 0, -1, 0]);
await wait(200);
await detect[2].click(); // rows: throttle, yaw, pitch, roll
await wait(200);
await axes([null, null, null, null, null, null, -0.9]);
await wait(400);
await axes([null, null, null, null, null, null, -0.5]);
await wait(300);
s = await rc();
console.log(JSON.stringify(s));
check('detect assigns the moved axis with the right sign', s.pitch === 0.5);
await shot('41-controller-detected');

// Reset mapping, close the menu, arm with the switch on axis 4.
await page.evaluate(() => { const f = window.__fpv; f.input.resetConfig(f.input.pad()); f.setPaused(false); });
await axes([0, 0, -1, 0, -1, -1, 0, 0]);
await wait(400);
await axes([null, null, 0.2, null, 1]); // throttle raised + arm switch -> must refuse
await wait(400);
s = await rc();
console.log(JSON.stringify(s));
check('arming refused with throttle raised', s.armed === false && s.block === 'THROTTLE');
await axes([null, null, -1, null, -1]);
await wait(300);
await axes([null, null, -1, null, 1]);
await wait(400);
s = await rc();
check('arm switch arms at zero throttle', s.armed === true);
await axes([null, null, -0.4, null, 1]); // 30 % throttle
await wait(1500);
const y = await page.evaluate(() => window.__fpv.sim.drone.pos.y);
check('throttle from the radio lifts the quad (y = ' + y.toFixed(1) + ' m)', y > 1);
await shot('42-radio-flying');
await axes([null, null, null, null, -1]);
await wait(300);
s = await rc();
check('arm switch off disarms', s.armed === false);

if (logs.length) console.log(logs.slice(0, 30).join('\n'));
else console.log('no console output');
await browser.close();
