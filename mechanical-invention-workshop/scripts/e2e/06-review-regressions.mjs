/**
 * Regression checks, in the real UI, for the findings of the independent
 * review (docs/review/round-1/REVIEW.md): layout at small windows, undo from
 * fields and checkboxes, rejected imports, tool picking, coupling validation,
 * refused exports, unit consistency.
 */
import { writeFileSync } from 'node:fs';
import { launch, fresh, portXY, localXY, setField, shot, Log, URL, OUT } from './lib.mjs';
const log = new Log('06-review-regressions');
const S = (page, fn, a) => page.evaluate(fn, a);

// ---------------------------------------------------------------- F-1 layout at small windows
for (const [w, h] of [[1280, 800], [1366, 768], [1100, 700]]) {
  const { browser, page } = await launch({ w, h });
  try {
    await fresh(page);
    await page.click('[data-testid="welcome-gears"]'); await page.waitForTimeout(1200);
    await S(page, () => { const s = window.__mw.getState(); window.__mw.select({ parts: [s.project.parts[2].id] }); });
    await page.waitForTimeout(300);
    const m = await S(page, () => {
      const iw = window.innerWidth, ih = window.innerHeight;
      const els = [...document.querySelectorAll('button, input, select, [role="tab"]')].filter((e) => e.offsetParent !== null);
      const off = els.filter((e) => { const r = e.getBoundingClientRect(); return r.width > 0 && (r.right > iw + 1 || r.left < -1) && !e.closest('.right-panel, .left-panel, .bottom-body, .menu-pop'); });
      const rp = document.querySelector('.right-panel').getBoundingClientRect(), tb = document.querySelector('.topbar').getBoundingClientRect();
      return { iw, ih, scrollW: document.documentElement.scrollWidth, offscreen: off.map((e) => e.getAttribute('title') || e.textContent.slice(0, 20)), rightPanel: [Math.round(rp.left), Math.round(rp.right)], topbarRight: Math.round(tb.right), help: document.querySelector('button[title^="Keyboard shortcuts"]').getBoundingClientRect().right };
    });
    log.check(`layout fits ${w}×${h}: no horizontal overflow, inspector and all top-bar controls on screen`, m.scrollW <= m.iw && m.offscreen.length === 0 && m.rightPanel[1] <= m.iw + 1 && m.help <= m.iw, m);
    if (w === 1280) await shot(page, '06a-layout-1280x800');
  } finally { await browser.close(); }
}

const { browser, page, errors } = await launch();
try {
  // ---------------------------------------------------------------- F-2 undo from fields / checkboxes, Esc
  await fresh(page);
  await page.click('[data-testid="welcome-empty"]');
  await page.click('[data-testid="lib-link"]'); await page.waitForTimeout(300);
  const width = () => S(page, () => window.__mw.getState().project.parts[0].params.width);
  const past = () => S(page, () => window.__mw.getState().past.map((h) => h.label));
  const shown = () => page.locator('[data-testid="param-width"]').inputValue();
  const wf = page.locator('[data-testid="param-width"]');
  await wf.click(); await wf.fill('14'); await wf.press('Tab'); await page.waitForTimeout(150);
  const afterTab = { width: await width(), past: await past() };
  await page.keyboard.press('Control+z'); await page.waitForTimeout(200);
  log.check('Tab commits a field; Ctrl+Z with focus in the next field undoes it and the field shows the model value', afterTab.width === 14 && (await width()) === 10 && (await shown()) === '10', { afterTab, width: await width(), shown: await shown(), past: await past() });
  await page.keyboard.press('Control+Shift+z'); await page.waitForTimeout(150);
  log.check('redo from a focused field', (await width()) === 14 && (await shown()) === '14');
  await wf.click(); await wf.fill('99'); await wf.press('Escape'); await page.waitForTimeout(150);
  log.check('Esc discards the typed draft: no commit, no undo step', (await width()) === 14 && (await shown()) === '14' && (await past()).length === afterTab.past.length, { width: await width(), past: await past() });
  await wf.click(); await wf.fill('77'); await page.keyboard.press('Control+z'); await page.waitForTimeout(150);
  log.check('Ctrl+Z with an uncommitted draft only discards the draft', (await width()) === 14 && (await shown()) === '14');
  await page.keyboard.press('Escape');
  await page.locator('[data-testid="grounded"]').click(); await page.waitForTimeout(150);
  const g1 = await S(page, () => window.__mw.getState().project.parts[0].grounded);
  await page.keyboard.press('Control+z'); await page.waitForTimeout(150);
  log.check('Ctrl+Z right after ticking a checkbox undoes it', g1 === true && (await S(page, () => window.__mw.getState().project.parts[0].grounded)) === false);
  // nudges coalesce
  const n0 = (await past()).length;
  await wf.click(); for (let i = 0; i < 5; i++) await page.keyboard.press('ArrowUp');
  await page.keyboard.press('Escape'); await page.waitForTimeout(150);
  log.check('five ↑ nudges are one undo step', (await width()) === 19 && (await past()).length === n0 + 1, { width: await width(), steps: (await past()).length - n0 });
  // typed draft + ↑ nudges from the typed value
  await wf.click(); await wf.fill('30'); await page.keyboard.press('ArrowUp'); await page.keyboard.press('Escape'); await page.waitForTimeout(150);
  log.check('↑ after typing nudges from the typed value', (await width()) === 31, { width: await width() });
  // numeric input
  await setField(page, 'param-length', '6e1'); const sci = await S(page, () => window.__mw.getState().project.parts[0].params.length);
  await setField(page, 'param-length', '60 mm + 1 in'); const sum = await S(page, () => window.__mw.getState().project.parts[0].params.length);
  log.check('scientific notation and mixed-unit sums are accepted', sci === 60 && Math.abs(sum - 85.4) < 1e-9, { sci, sum });
  // Space activates a keyboard-focused button but not after a mouse click
  await page.locator('.view-toolbar button:has-text("Front")').click(); await page.keyboard.press(' '); await page.waitForTimeout(300);
  const playing = await S(page, () => window.__mw.getState().simStatus);
  await page.keyboard.press(' ');
  log.check('after clicking a toolbar button with the mouse, Space still means Play/Pause', playing === 'running', playing);
  await page.keyboard.press('r');

  // ---------------------------------------------------------------- F-3 corrupted imports
  const good = await S(page, () => JSON.stringify(window.__mw.getState().project));
  const listBefore = await S(page, () => JSON.parse(localStorage.getItem('mw:index')).length);
  const feed = async (name, content) => {
    await page.setInputFiles('[data-testid="file-input"]', { name, mimeType: 'application/json', buffer: Buffer.from(content) });
    await page.waitForTimeout(350);
    return S(page, () => ({ toast: window.__mw.getState().toast?.text ?? '', name: window.__mw.getState().project.name, n: JSON.parse(localStorage.getItem('mw:index')).length }));
  };
  const base = JSON.parse(good);
  const mk = (fn) => { const c = structuredClone(base); c.name = 'Corrupt'; fn(c); return JSON.stringify(c); };
  const cases = {
    'string length': mk((p) => { p.parts[0].params.length = 'abc'; }),
    'negative length': mk((p) => { p.parts[0].params.length = -30; }),
    'string pose': mk((p) => { p.parts[0].pose.x = 'left'; }),
    'garbage joints': mk((p) => { p.joints = [null, 7, { type: 'revolute' }]; }),
    'holes not a list': mk((p) => { p.parts.push({ id: 'pl', name: 'Plate', kind: 'baseplate', params: { holes: 'x' } }); }),
    'garbage sim': mk((p) => { p.sim = { dt: 'fast', gravity: null, floor: 3 }; }),
    'dt zero': mk((p) => { p.sim.dt = 0; }),
  };
  const results = {};
  let allRejected = true;
  for (const [k, v] of Object.entries(cases)) { const r = await feed(`${k}.json`, v); results[k] = r.toast.slice(0, 150); if (!/^Cannot open file: the file contains/.test(r.toast) || r.name === 'Corrupt' || r.n !== listBefore) allRejected = false; }
  log.check('7 files with invalid values are rejected with a specific message; open project untouched; nothing stored', allRejected && (await S(page, () => JSON.stringify(window.__mw.getState().project))) === good, results);
  log.check('no uncaught exceptions while feeding corrupted files', errors.length === 0, errors.join(' | '));
  await shot(page, '06b-import-rejected');

  // ---------------------------------------------------------------- F-10 slide tool: click inside the slot picks the guide; F-23 ground pivot in place
  await fresh(page);
  await page.click('[data-testid="welcome-empty"]');
  await page.click('.view-toolbar button:has-text("Ortho")'); await page.click('.view-toolbar button:has-text("Front")');
  await page.click('[data-testid="lib-rail"]'); await page.keyboard.press('g');
  await page.click('[data-testid="lib-slider"]');
  await page.click('[data-testid="tool-prismatic"]');
  const inSlot = await localXY(page, 'Slotted guide', 62, 1.5);      // empty space inside the slot, away from any port
  await page.mouse.click(inSlot.x, inSlot.y);
  const sl = await portXY(page, 'Slider block', 'pin');
  await page.mouse.click(sl.x, sl.y); await page.waitForTimeout(250);
  const pj = await S(page, () => { const s = window.__mw.getState().project; const j = s.joints[0]; const A = s.parts.find((p) => p.id === j.a), B = s.parts.find((p) => p.id === j.b); return { a: A?.name ?? j.a, b: B?.name, type: j.type, sameLayer: A && B ? A.pose.z === B.pose.z : null, events: window.__mw.simCtl.ensure().events.map((e) => e.title) }; });
  log.check('Slide tool: a click inside the guide\'s slot attaches the slider to the guide (same layer, no interference)', pj.a === 'Slotted guide' && pj.b === 'Slider block' && pj.type === 'prismatic' && pj.sameLayer === true && pj.events.length === 0, pj);
  await page.click('[data-testid="lib-link"]');
  const poseBefore = await S(page, () => window.__mw.getState().project.parts[2].pose);
  await page.click('[data-testid="tool-revolute"]');
  const hA = await portXY(page, 'Link', 'A');
  await page.mouse.click(hA.x, hA.y);
  await page.mouse.click(hA.x - 260, hA.y - 170); await page.waitForTimeout(250);
  const gp = await S(page, () => { const s = window.__mw.getState().project; const j = s.joints.find((x) => x.type === 'revolute'); return { pose: s.parts[2].pose, a: j?.a, anchorA: j?.anchorA }; });
  log.check('ground pivot pins the hole where it is (the part does not jump)', gp.a === 'ground' && Math.abs(gp.pose.x - poseBefore.x) < 1e-9 && Math.abs(gp.pose.y - poseBefore.y) < 1e-9 && Math.abs(gp.anchorA.x - poseBefore.x) < 0.01, gp);

  // ---------------------------------------------------------------- F-11 coupling tools refuse incompatible parts
  await page.click('[data-testid="lib-gear"]');
  const nJ = await S(page, () => window.__mw.getState().project.joints.length);
  await page.click('[data-testid="tool-gear"]');
  let a = await localXY(page, 'Spur gear', 8, 4); await page.mouse.click(a.x, a.y);
  let b = await localXY(page, 'Link', 30, 0); await page.mouse.click(b.x, b.y); await page.waitForTimeout(250);
  const r1 = await S(page, () => ({ toast: window.__mw.getState().toast?.text, joints: window.__mw.getState().project.joints.length }));
  await page.keyboard.press('Escape');
  await page.click('[data-testid="tool-cam"]');
  b = await localXY(page, 'Link', 30, 0); await page.mouse.click(b.x, b.y); await page.waitForTimeout(150);
  a = await localXY(page, 'Spur gear', 8, 4); await page.mouse.click(a.x, a.y); await page.waitForTimeout(250);
  const r2 = await S(page, () => ({ toast: window.__mw.getState().toast?.text, joints: window.__mw.getState().project.joints.length }));
  await page.keyboard.press('Escape');
  log.check('Gear mesh gear→link and Cam contact link→gear are refused at pick time with the reason; no joint is created', r1.joints === nJ && /Gear mesh needs two spur gears/.test(r1.toast) && r2.joints === nJ && /Cam contact needs exactly one plate cam/.test(r2.toast), { r1, r2 });

  // ---------------------------------------------------------------- F-6 / F-22 a part that cannot be built is an error and its export is refused
  await S(page, () => { const s = window.__mw.getState(); window.__mw.select({ parts: [s.project.parts.find((p) => p.name === 'Link').id] }); window.__mwDownloads = []; });
  await setField(page, 'param-holeDiameter', 12);
  await setField(page, 'param-width', 12);
  const errText = await page.locator('[data-testid="part-errors"]').innerText().catch(() => '');
  await page.click('[data-testid="btab-export"]'); await page.waitForTimeout(300);
  await page.click('[data-testid="export-stl"]'); await page.waitForTimeout(300);
  const ex = await S(page, () => ({ toast: window.__mw.getState().toast?.text, downloads: window.__mwDownloads.length, checkClass: document.querySelector('.check-item')?.className, diag: window.__mw.simCtl.ensure().staticDiagnostics.filter((d) => d.code === 'geometry.invalid').map((d) => d.title) }));
  log.check('link whose holes are as wide as the link: error in the inspector and diagnostics; STL export refused, nothing downloaded', /were NOT cut/.test(errText) && ex.downloads === 0 && /was NOT exported/.test(ex.toast) && /error/.test(ex.checkClass) && ex.diag.length === 1, { errText: errText.slice(0, 120), ...ex });
  await shot(page, '06c-export-refused');
  await page.keyboard.press('Control+z'); await page.keyboard.press('Control+z');

  // ---------------------------------------------------------------- F-17 units in inch mode
  await page.keyboard.press('Escape'); await page.keyboard.press('Escape');
  await S(page, () => window.__mw.select({ parts: [], joints: [] }));
  await page.locator('.section-toggle', { hasText: 'Units' }).click();
  await page.selectOption('[data-testid="unit-preset"]', 'inch'); await page.waitForTimeout(300);
  const status = await page.locator('.statusbar').innerText();
  const line = await page.locator('.check-item summary').first().innerText();
  await S(page, () => { const s = window.__mw.getState(); window.__mw.select({ parts: [s.project.parts.find((p) => p.name === 'Link').id] }); });
  await page.waitForTimeout(200);
  const insp = await page.locator('[data-testid="inspector"]').innerText();
  log.check('inch preset: status bar, inspector read-outs and the export check line all use inch / lb / lbf units', /in · lb · lbf · lbf·in/.test(status) && / in · /.test(line) && !/ mm · /.test(line) && /lb·in²/.test(insp) && !/g·mm²/.test(insp), { status: status.slice(-40), line, inertia: (insp.match(/Inertia[^\n]*\n[^\n]*/) ?? [''])[0] });

  // ---------------------------------------------------------------- F-4 DC motor needs a stall torque
  await S(page, () => { const s = window.__mw.getState(); window.__mw.select({ parts: [], joints: [s.project.joints.find((j) => j.type === 'revolute').id] }); });
  await page.click('[data-testid="tab-library"]'); await page.click('[data-testid="tool-motor"]');
  await page.selectOption('select[aria-label="Motor type"]', 'dc'); await page.waitForTimeout(200);
  const tf = page.locator('[data-testid="motor-torque"]');
  await tf.click(); await tf.fill(''); await tf.press('Enter'); await page.waitForTimeout(200);
  const dc = await S(page, () => { const j = window.__mw.getState().project.joints.find((x) => x.motor?.enabled); return { maxTorque: j.motor.maxTorque, type: j.motor.type }; });
  log.check('DC motor: an empty stall torque is rejected in the inspector (a default was set on switching type)', dc.type === 'dc' && dc.maxTorque > 0, dc);
  log.check('no console/page errors in the whole session', errors.length === 0, errors.join(' | '));
} finally {
  log.save();
  await browser.close();
}
process.exit(log.fail ? 1 : 0);
