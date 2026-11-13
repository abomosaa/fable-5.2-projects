/**
 * Change a dimension and a load, observe the behaviour change, undo/redo the
 * authoring changes, save and reopen; then create an impossible assembly and
 * check the diagnosis leaves the project intact.
 * Builds on the project saved by 01-build-linkage (re-creates it through the
 * same public operations if run standalone).
 */
import { launch, fresh, setField, shot, Log, simInfo, localXY, URL } from './lib.mjs';
const log = new Log('02-edit-undo-save');
const { browser, page, errors } = await launch();
await fresh(page);
await page.click('[data-testid="welcome-fourbar"]');
await page.waitForTimeout(1200);
const sel = (name) => page.evaluate((n) => { const s = window.__mw.getState(); const p = s.project.parts.find((x) => x.name === n); window.__mw.select({ parts: [p.id] }); }, name);
const part = (name) => page.evaluate((n) => { const p = window.__mw.getState().project.parts.find((x) => x.name === n); return { ...p.pose, params: p.params }; }, name);
const torqueStats = () => page.evaluate(() => { const m = window.__mw; const r = m.simCtl.runner; const pr = m.getState().project.probes.find((p) => p.name === 'Crank motor'); const s = r.series({ probe: pr.id, quantity: 'torque' }); let mx = 0, sum = 0, n = 0; for (let i = Math.floor(s.y.length / 3); i < s.y.length; i++) { mx = Math.max(mx, Math.abs(s.y[i])); sum += s.y[i]; n++; } return { peakNmm: mx / 1000, meanNmm: sum / n / 1000, provenance: s.provenance, available: s.available }; });
const rockerSwing = () => page.evaluate(() => { const m = window.__mw; const r = m.simCtl.runner; const pr = m.getState().project.probes.find((p) => p.name === 'Rocker pivot'); const s = r.series({ probe: pr.id, quantity: 'coord' }); let lo = 1e9, hi = -1e9; for (const v of s.y) { lo = Math.min(lo, v); hi = Math.max(hi, v); } return ((hi - lo) * 180) / Math.PI; });

// --- baseline run
await page.click('[data-testid="play"]');
await page.waitForTimeout(3600);
await page.keyboard.press(' ');
const base = { swing: await rockerSwing(), torque: await torqueStats(), info: await simInfo(page) };
log.note('baseline: rocker swing [deg], motor torque [N·mm]', base);
log.check('baseline run ok', base.info.t > 2 && base.info.maxPosError < 1e-6 && base.torque.available);

// --- change a dimension: rocker 70 → 55 mm (through the inspector field, with units)
await sel('Rocker');
const before = await part('Coupler');
await setField(page, 'param-length', '55 mm');
const afterDim = await part('Coupler');
const st1 = await page.evaluate(() => ({ status: window.__mw.getState().simStatus, issues: window.__mw.getState().assemblyIssues.length, len: window.__mw.getState().project.parts.find((p) => p.name === 'Rocker').params.length }));
log.check('dimension edit applied and assembly re-solved (coupler pose moved, no issues)', st1.len === 55 && st1.issues === 0 && Math.abs(afterDim.angle - before.angle) > 1e-3, { couplerAngleBefore: before.angle, after: afterDim.angle });
log.check('editing reset the transient simulation, not the design', st1.status === 'idle');
// --- add a load on the rocker tip with the Load tool, then set it to 3 N downward
await page.click('[data-testid="tab-library"]');
await page.click('[data-testid="tool-load"]');
const tip = await localXY(page, 'Rocker', 16, 0);
await page.mouse.click(tip.x, tip.y);
await page.waitForTimeout(200);
await setField(page, 'load-fy', '-3 N');
const load = await page.evaluate(() => window.__mw.getState().project.loads.map((l) => ({ part: window.__mw.getState().project.parts.find((p) => p.id === l.part).name, fy: l.fy })));
log.check('load of 3 N (stored as −3000 mN) placed on the rocker', load.length === 1 && load[0].part === 'Rocker' && Math.abs(load[0].fy + 3000) < 1e-9, load);
await page.keyboard.press('Escape');
await page.click('[data-testid="play"]');
await page.waitForTimeout(3600);
await page.keyboard.press(' ');
await page.click('[data-testid="btab-plots"]');
await page.waitForTimeout(400);
const mod = { swing: await rockerSwing(), torque: await torqueStats(), info: await simInfo(page) };
log.note('after edits: rocker swing [deg], motor torque [N·mm]', mod);
log.check('shorter rocker swings through a larger angle', mod.swing > base.swing + 3, { base: base.swing, now: mod.swing });
log.check('added load raises the peak motor torque', mod.torque.peakNmm > base.torque.peakNmm * 1.5, { base: base.torque.peakNmm, now: mod.torque.peakNmm });
log.check('previous run kept for comparison (dashed overlay)', await page.evaluate(() => !!window.__mw.getState().previousRun && Object.keys(window.__mw.getState().previousRun.series).length > 0));
await shot(page, '02a-compare-runs');

// --- undo / redo the authoring changes
await page.keyboard.press('r');
const snap = () => page.evaluate(() => { const s = window.__mw.getState(); return { rocker: s.project.parts.find((p) => p.name === 'Rocker').params.length, loads: s.project.loads.length, fy: s.project.loads[0]?.fy ?? null, past: s.past.length, future: s.future.length }; });
const s0 = await snap();
await page.keyboard.press('Control+z'); const s1 = await snap();
await page.keyboard.press('Control+z'); const s2 = await snap();
await page.keyboard.press('Control+z'); const s3 = await snap();
log.check('undo ×3 walks back: load value → load removed → rocker 70 mm', s1.fy === -1000 && s2.loads === 0 && s3.rocker === 70, { s0, s1, s2, s3 });
const closedAfterUndo = await page.evaluate(() => window.__mw.getState().assemblyIssues.length === 0 && window.__mw.simCtl.ensure().staticDiagnostics.every((d) => d.severity !== 'error'));
log.check('assembly is consistent after undo', closedAfterUndo);
await page.keyboard.press('Control+Shift+z'); await page.keyboard.press('Control+Shift+z'); await page.keyboard.press('Control+Shift+z');
const s4 = await snap();
log.check('redo ×3 restores rocker 55 mm and the 3 N load', s4.rocker === 55 && s4.loads === 1 && s4.fy === -3000 && s4.future === 0, s4);

// --- save, rename, reopen after a full page reload
await page.click('[data-testid="project-name"]');
await page.fill('[data-testid="project-name-input"]', 'My four-bar study');
await page.keyboard.press('Enter');
await page.keyboard.press('Control+s');
await page.waitForTimeout(200);
const saved = await page.evaluate(() => ({ state: document.querySelector('[data-testid="save-state"]').textContent, json: JSON.stringify(window.__mw.getState().project) }));
await page.goto(URL);
await page.waitForSelector('.app[data-ready="true"]');
await page.waitForTimeout(600);
const re = await page.evaluate(() => ({ name: window.__mw.getState().project.name, json: JSON.stringify(window.__mw.getState().project), dialog: window.__mw.getState().dialog }));
log.check('project reopened after reload with identical content', re.name === 'My four-bar study' && re.json === saved.json && saved.state === 'saved', { name: re.name, saveState: saved.state });
// autosave recovery: edit without saving, reload
await sel('Crank');
await setField(page, 'param-width', 14);
await page.waitForTimeout(1600);
const autos = await page.evaluate(() => document.querySelector('[data-testid="save-state"]').textContent);
await page.goto(URL);
await page.waitForSelector('.app[data-ready="true"]');
await page.waitForTimeout(600);
const rec = await page.evaluate(() => ({ width: window.__mw.getState().project.parts.find((p) => p.name === 'Crank').params.width, toast: window.__mw.getState().toast?.text ?? '' }));
log.check('unsaved edit recovered from autosave after reload', autos === 'autosaved' && rec.width === 14, rec);
// duplicate project + open dialog lists both
await page.click('[data-testid="menu-file"]'); await page.click('[data-testid="file-duplicate"]');
await page.waitForTimeout(300);
await page.click('[data-testid="menu-file"]'); await page.click('[data-testid="file-open"]');
await page.waitForSelector('[data-testid="dialog-open"]');
const names = await page.$$eval('[data-testid="dialog-open"] .proj-open .pn', (els) => els.map((e) => e.textContent));
log.check('duplicate created and listed in the Open dialog', names.includes('My four-bar study') && names.includes('My four-bar study copy'), names.slice(0, 6));
await shot(page, '02b-open-dialog');
await page.keyboard.press('Escape');

// --- impossible assembly: coupler far too short to close the loop
await sel('Coupler');
const goodJson = await page.evaluate(() => JSON.stringify(window.__mw.getState().project));
await setField(page, 'param-length', 5);
await page.waitForTimeout(400);
const bad = await page.evaluate(() => { const s = window.__mw.getState(); return { issues: s.assemblyIssues.map((i) => ({ code: i.code, title: i.title, detail: i.detail, joints: i.joints.length, parts: i.parts.length })), toast: s.toast?.text, tab: s.bottomTab, parts: s.project.parts.length, joints: s.project.joints.length, len: s.project.parts.find((p) => p.name === 'Coupler').params.length, nan: JSON.stringify(s.project).includes('null,null') }; });
log.check('impossible assembly is diagnosed (cannot close) with the joints involved', bad.issues.length === 1 && bad.issues[0].code === 'assembly.cannot-close' && bad.issues[0].joints > 0, bad.issues[0]);
log.check('project not corrupted: all parts/joints present, edit kept, no invalid numbers', bad.parts === 5 && bad.joints === 5 && bad.len === 5 && !bad.nan);
await page.click('[data-testid="play"]');
await page.waitForTimeout(500);
const refused = await page.evaluate(() => ({ status: window.__mw.getState().simStatus, toast: window.__mw.getState().toast?.text }));
log.check('simulation refuses to start from the open assembly and says why', refused.status === 'idle' && /Cannot start/.test(refused.toast ?? ''), refused);
await shot(page, '02c-impossible-assembly');
await page.keyboard.press('Control+z');
await page.waitForTimeout(300);
const restored = await page.evaluate(() => ({ same: JSON.stringify(window.__mw.getState().project.parts) , issues: window.__mw.getState().assemblyIssues.length }));
log.check('undo restores the previous valid assembly exactly', restored.issues === 0 && restored.same === JSON.stringify(JSON.parse(goodJson).parts));
log.check('no console/page errors', errors.length === 0, errors.join(' | '));
log.save();
await browser.close();
process.exit(log.fail ? 1 : 0);
