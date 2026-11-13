/**
 * Runs all five showcase projects in the real UI, including their invalid /
 * failure variants, edits key parameters through the inspector and records
 * measured behaviour.
 */
import { launch, fresh, setField, shot, Log, simInfo, drag, URL } from './lib.mjs';
const log = new Log('03-showcases');
const { browser, page, errors } = await launch();
const open = async (id) => { await fresh(page); await page.click(`[data-testid="welcome-${id}"]`); await page.waitForTimeout(1300); };
const sel = (name) => page.evaluate((n) => { const s = window.__mw.getState(); const p = s.project.parts.find((x) => x.name === n); window.__mw.select({ parts: [p.id] }); }, name);
const selJoint = (name) => page.evaluate((n) => { const s = window.__mw.getState(); const j = s.project.joints.find((x) => x.name === n); window.__mw.select({ parts: [], joints: [j.id] }); }, name);
const variant = async (text) => { await page.keyboard.press('Escape'); await page.keyboard.press('Escape'); await page.locator('.variant-main', { hasText: text }).first().click(); await page.waitForTimeout(500); };
/** run for `sec` simulated seconds as fast as the machine allows (headless software rendering is slow) */
const run = async (sec, speed = 1) => {
  await page.selectOption('[data-testid="speed"]', String(speed));
  await page.click('[data-testid="play"]');
  await page.waitForFunction((t) => { const m = window.__mw; const r = m.simCtl.runner; return !r || m.getState().simStatus !== 'running' || r.time >= t; }, sec, { timeout: 180000, polling: 100 });
  if (await page.evaluate(() => window.__mw.getState().simStatus === 'running')) await page.keyboard.press(' ');
  await page.waitForTimeout(150);
  return simInfo(page);
};
const series = (probeName, q) => page.evaluate(([n, quantity]) => { const m = window.__mw; const r = m.simCtl.runner; const pr = m.getState().project.probes.find((p) => p.name === n); const s = r.series({ probe: pr.id, quantity }); return { t: Array.from(s.t), y: Array.from(s.y), available: s.available, provenance: s.provenance, reason: s.reason }; }, [probeName, q]);
const span = (a) => Math.max(...a) - Math.min(...a);
const tail = (s, frac = 0.5) => s.y.slice(Math.floor(s.y.length * frac));
const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
const diag = (codes) => page.evaluate((cs) => { const m = window.__mw; const r = m.simCtl.runner; const all = [...m.getState().assemblyIssues, ...(r ? r.allDiagnostics() : [])]; return all.filter((d) => cs.some((c) => d.code.startsWith(c))).map((d) => ({ code: d.code, sev: d.severity, title: d.title, t: d.time, detail: d.detail })); }, codes);

// ================================================================ 1. four-bar
await open('fourbar');
let info = await run(3);
log.check('four-bar: valid variant runs, loop error < 1e-6 mm', info.status === 'paused' && info.maxPosError < 1e-6 && info.events.length === 0, { t: info.t, maxPosError: info.maxPosError });
// drag the coupler-point probe marker and check the trace is re-evaluated from recorded motion
const probeBefore = await page.evaluate(() => { const m = window.__mw; const pr = m.getState().project.probes.find((p) => p.name === 'Coupler point'); const part = m.getState().project.parts.find((p) => p.id === pr.target.part); const r = m.simCtl.runner; const pose = r.poseOf(part.id); const a = pr.target.anchor; const c = Math.cos(pose.angle), s = Math.sin(pose.angle); const w = window.__mwView.worldToClient(pose.x + c * a.x - s * a.y, pose.y + s * a.x + c * a.y, window.__mwView.topZ(part.id)); return { w, anchor: a, samples: r.n }; });
const y0 = span((await series('Coupler point', 'y')).y);
await page.keyboard.press('r');
await page.waitForTimeout(200);
const mk = await page.evaluate(() => { const m = window.__mw; const pr = m.getState().project.probes.find((p) => p.name === 'Coupler point'); const part = m.getState().project.parts.find((p) => p.id === pr.target.part); const a = pr.target.anchor; const c = Math.cos(part.pose.angle), s = Math.sin(part.pose.angle); return window.__mwView.worldToClient(part.pose.x + c * a.x - s * a.y, part.pose.y + s * a.x + c * a.y, window.__mwView.topZ(part.id)); });
await drag(page, mk, { x: mk.x + 60, y: mk.y + 45 });
const probeAfter = await page.evaluate(() => window.__mw.getState().project.probes.find((p) => p.name === 'Coupler point').target.anchor);
log.check('four-bar: coupler-point probe marker is draggable', Math.hypot(probeAfter.x - probeBefore.anchor.x, probeAfter.y - probeBefore.anchor.y) > 5, { before: probeBefore.anchor, after: probeAfter });
info = await run(3);
const y1 = span((await series('Coupler point', 'y')).y);
log.check('four-bar: trace of the moved coupler point differs', Math.abs(y1 - y0) > 1, { ySpanBefore: y0, ySpanAfter: y1 });
await shot(page, '03-fourbar-valid');
await page.keyboard.press('r');
await variant('crank too long');
info = await run(3);
let d = await diag(['sim.locked']);
log.check('four-bar invalid variant 1: locks at a dead-centre with a Grashof explanation', info.status === 'ended' && d.length === 1 && /Grashof/.test(d[0].detail), d[0]);
await shot(page, '03-fourbar-locked');
await page.keyboard.press('r');
await variant('coupler too short');
d = await diag(['assembly.cannot-close']);
log.check('four-bar invalid variant 2: cannot be assembled, diagnosed, project intact', d.length === 1 && await page.evaluate(() => window.__mw.getState().project.parts.length === 5), d[0]);
await shot(page, '03-fourbar-cannot-assemble');
await variant('Crank-rocker (valid)');
log.check('four-bar: returning to the valid variant re-closes the assembly', (await diag(['assembly.'])).length === 0);

// ================================================================ 2. gears
await open('gears');
info = await run(2);
let wIn = mean(tail(await series('Input (motor)', 'rate'))), wOut = mean(tail(await series('Output shaft', 'rate')));
let tq = mean(tail(await series('Input (motor)', 'torque')));
log.check('gears: speed ratio 12:1 and motor torque = load / 12', Math.abs(wIn / wOut - 12) < 1e-6 && Math.abs(tq / 1000 - 25) < 0.05, { ratio: wIn / wOut, motorTorqueNmm: tq / 1000, expected: 300 / 12 });
await shot(page, '03-gears-12to1');
await page.keyboard.press('r');
const cBefore = await page.evaluate(() => { const s = window.__mw.getState().project; const g = (n) => s.parts.find((p) => p.name === n).pose; return { d12: Math.hypot(g('Gear 48T').x - g('Pinion 16T').x, g('Gear 48T').y - g('Pinion 16T').y), hole: s.parts.find((p) => p.name === 'Gearbox plate').params.holes[1] }; });
await sel('Pinion 16T');
await setField(page, 'param-teeth', 24);
const cAfter = await page.evaluate(() => { const s = window.__mw.getState().project; const g = (n) => s.parts.find((p) => p.name === n).pose; const pl = s.parts.find((p) => p.name === 'Gearbox plate'); const h = pl.params.holes[1]; return { d12: Math.hypot(g('Gear 48T').x - g('Pinion 16T').x, g('Gear 48T').y - g('Pinion 16T').y), d34: Math.hypot(g('Output gear 56T').x - g('Pinion 14T').x, g('Output gear 56T').y - g('Pinion 14T').y), hole: h, holeWorld: { x: pl.pose.x + h.x, y: pl.pose.y + h.y }, lay: g('Lay shaft'), issues: window.__mw.getState().assemblyIssues.length }; });
log.check('gears: changing 16T→24T moves the lay shaft to centre distance m(z1+z2)/2 = 72 mm (was 64), plate hole follows', Math.abs(cBefore.d12 - 64) < 1e-6 && Math.abs(cAfter.d12 - 72) < 1e-6 && Math.abs(cAfter.d34 - 70) < 1e-6 && Math.hypot(cAfter.holeWorld.x - cAfter.lay.x, cAfter.holeWorld.y - cAfter.lay.y) < 1e-6, { before: cBefore.d12, after: cAfter.d12, d34: cAfter.d34 });
info = await run(2);
wIn = mean(tail(await series('Input (motor)', 'rate'))); wOut = mean(tail(await series('Output shaft', 'rate'))); tq = mean(tail(await series('Input (motor)', 'torque')));
log.check('gears: new ratio (48/24)(56/14) = 8 and torque 300/8 = 37.5 N·mm in the simulation; no interference', Math.abs(wIn / wOut - 8) < 1e-6 && Math.abs(tq / 1000 - 37.5) < 0.05 && info.events.every((e) => !e.code.startsWith('interference')), { ratio: wIn / wOut, torque: tq / 1000, events: info.events });
await shot(page, '03-gears-edited');
await page.keyboard.press('r');
await variant('triple load');
info = await run(1.5);
d = await diag(['motor.']);
log.check('gears: overloaded variant reports the motor saturating / back-driven', d.some((x) => x.code === 'motor.backdriven'), d.map((x) => x.title));
await shot(page, '03-gears-overloaded');

// ================================================================ 3. cam
await open('cam');
info = await run(1.2);
let disp = await series('Follower', 'coord'), vel = await series('Follower', 'rate'), gap = await series('Cam contact', 'gap');
log.check('cam: follower displacement spans the 12 mm lift and stays on the cam', Math.abs(span(disp.y) - 12) < 0.05 && Math.max(...gap.y.map(Math.abs)) < 0.02, { lift: span(disp.y), maxGap: Math.max(...gap.y.map(Math.abs)), provenance: [disp.provenance, vel.provenance] });
await shot(page, '03-cam-120rpm');
await page.keyboard.press('r');
await sel('Cam');
await setField(page, 'cam-lift-0', 8);
await page.waitForTimeout(200);
info = await run(1.2);
disp = await series('Follower', 'coord');
log.check('cam: editing the program (rise to 8 mm, dwell follows) changes the simulated lift', Math.abs(span(disp.y) - 8) < 0.05, { lift: span(disp.y), warnings: info.static.map((s) => s.title) });
await page.keyboard.press('Control+z');
await page.keyboard.press('r');
await variant('1200 rpm (follower floats)');
info = await run(0.6);
d = await diag(['cam.float']);
gap = await series('Cam contact', 'gap');
log.check('cam: at 1200 rpm the follower loses contact (float) and it is diagnosed', d.length === 1 && Math.max(...gap.y) > 0.05, { diag: d[0]?.title, t: d[0]?.t, maxGapMm: Math.max(...gap.y) });
await page.click('[data-testid="btab-plots"]'); await page.waitForTimeout(300);
await shot(page, '03-cam-float');
await page.keyboard.press('r');
await variant('stiffer spring');
info = await run(0.6);
gap = await series('Cam contact', 'gap');
log.check('cam: stiffer spring restores contact at 1200 rpm', (await diag(['cam.float'])).length === 0 && Math.max(...gap.y.slice(50)) < 0.02, { maxGapMm: Math.max(...gap.y.slice(50)) });

// ================================================================ 4. slider-crank
await open('slidercrank');
info = await run(2.5);
let x = await series('Slider', 'coord');
let wM = mean(tail(await series('Motor', 'rate'))), wC = mean(tail(await series('Crank shaft', 'rate')));
log.check('slider-crank: stroke = 2 × 18 mm crank radius; belt ratio 70/20 = 3.5', Math.abs(span(x.y) - 36) < 0.02 && Math.abs(wM / wC - 3.5) < 1e-6, { stroke: span(x.y), ratio: wM / wC });
await shot(page, '03-slidercrank');
await page.keyboard.press('r');
await sel('Crank pulley');
await setField(page, 'param-pinRadius', 12);
info = await run(2.5);
x = await series('Slider', 'coord');
log.check('slider-crank: editing the crank radius to 12 mm gives a 24 mm stroke', Math.abs(span(x.y) - 24) < 0.02 && info.maxPosError < 1e-6, { stroke: span(x.y) });
await page.keyboard.press('r');
await selJoint('Motor shaft');
await setField(page, 'motor-speed', '360 rpm');
info = await run(1.5);
wC = mean(tail(await series('Crank shaft', 'rate')));
log.check('slider-crank: motor speed 360 rpm propagates to the crank (360/3.5 rpm)', Math.abs((wC * 60) / (2 * Math.PI) - 360 / 3.5) < 0.05, { crankRpm: (wC * 60) / (2 * Math.PI) });
await page.keyboard.press('r');
await variant('Stroke 60 mm');
info = await run(1);
d = await diag(['interference']);
log.check('slider-crank: over-long stroke variant reports slider ↔ guide interference', d.some((q) => /Slotted guide/.test(q.title) && /Slider/.test(q.title)), d.map((q) => q.title));
await shot(page, '03-slidercrank-interference');

// ================================================================ 5. walker
await open('walker');
await page.locator('.view-toolbar button', { hasText: 'Three-quarter' }).click();
info = await run(4, 4);
log.check('walker: walks forward on its feet (free body, floor contact), joints closed', info.walk.travel > 250 && info.maxPosError < 1e-6 && /Moving \+X/.test(info.walk.summary), info.walk);
const grounded = await page.evaluate(() => window.__mw.getState().project.parts.filter((p) => p.grounded).length);
const contacts = await series('Solver', 'contacts');
log.check('walker: nothing is grounded; at least one foot (usually two) carries load throughout', grounded === 0 && Math.min(...contacts.y.slice(20)) >= 1 && Math.max(...contacts.y) <= 6, { grounded, minFeet: Math.min(...contacts.y.slice(20)), maxFeet: Math.max(...contacts.y) });
await page.click('[data-testid="btab-diagnostics"]'); await page.waitForTimeout(300);
await shot(page, '03-walker-walking');
await page.keyboard.press('r');
// adjustable friction through the inspector
await page.keyboard.press('Escape');
await setField(page, 'floor-friction', 0.08);
info = await run(4, 4);
log.check('walker: with μ = 0.08 the feet slip and the tow load drags it backwards (diagnosed)', info.walk.travel < 0 && /slipping/i.test(info.walk.summary), info.walk);
await shot(page, '03-walker-slipping');
await page.keyboard.press('r');
await variant('Weak motor');
info = await run(3, 4);
d = await diag(['motor.']);
log.check('walker: weak motor variant fails with a motor diagnosis', d.some((q) => q.code === 'motor.backdriven' || q.code === 'motor.stall'), d.map((q) => q.title));
await page.keyboard.press('r');
await variant('Default');
// unsuitable geometry: lengthen one leg link so the leg cannot close → assembly diagnosis
await sel('Link k F1');
await setField(page, 'param-length', 120);
d = await diag(['assembly.cannot-close']);
log.check('walker: an unsuitable link length is diagnosed as an impossible leg, not hidden', d.length === 1, d[0]?.detail);
await page.keyboard.press('Control+z');
await sel('Link k F1');
await setField(page, 'param-length', 66);
info = await run(3, 4);
const after = await diag(['interference', 'sim.', 'walk.']);
log.note('walker with one leg link changed 61.9 → 66 mm (no guarantee it walks)', { travel: info.walk?.travel, summary: info.walk?.summary, status: info.status, diagnostics: after.map((q) => q.title) });
await shot(page, '03-walker-modified-leg');
log.check('no console/page errors', errors.length === 0, errors.join(' | '));
log.save();
await browser.close();
process.exit(log.fail ? 1 : 0);
