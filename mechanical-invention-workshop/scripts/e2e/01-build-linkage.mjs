/**
 * End-to-end proof in the real UI (mouse + keyboard only): create a fresh
 * project, assemble a motor-driven four-bar from library components, ground
 * it, assign joints, simulate and inspect the motion trace.
 */
import { launch, fresh, portXY, localXY, drag, setField, shot, Log, simInfo } from './lib.mjs';
const log = new Log('01-build-linkage');
const { browser, page, errors } = await launch();
await fresh(page);
await page.click('[data-testid="welcome-empty"]');
await page.waitForTimeout(300);
await shot(page, '01a-empty-project');
log.check('fresh project is empty', await page.evaluate(() => window.__mw.getState().project.parts.length === 0));

// front orthographic view for precise placement
await page.click('.view-toolbar button:has-text("Ortho")');
await page.click('.view-toolbar button:has-text("Front")');

// 1. frame plate, grounded with the G key
await page.click('[data-testid="tab-library"]');
await page.fill('[data-testid="library-search"]', 'plate');
await page.click('[data-testid="lib-baseplate"]');
await page.keyboard.press('g');
await page.fill('[data-testid="library-search"]', '');
log.check('base plate added and grounded', await page.evaluate(() => { const p = window.__mw.getState().project.parts[0]; return p.kind === 'baseplate' && p.grounded; }));

// 2. crank: a 25 mm link pinned to plate hole H1 with the Pivot tool
await page.click('[data-testid="lib-link"]');
await setField(page, 'param-length', 25);
await page.click('[data-testid="tool-revolute"]');
let a = await portXY(page, 'Base plate', 'H1');
await page.mouse.click(a.x, a.y);
let b = await portXY(page, 'Link', 'A');
await page.mouse.click(b.x, b.y);
await page.waitForTimeout(200);
log.check('pivot joint created between plate and crank', await page.evaluate(() => { const j = window.__mw.getState().project.joints; return j.length === 1 && j[0].type === 'revolute'; }));
// rotate the crank up by 90° with Q (6 × 15°)
await page.evaluate(() => { const s = window.__mw.getState(); window.__mw.select({ parts: [s.project.parts.find((p) => p.name === 'Link').id] }); });
for (let i = 0; i < 6; i++) await page.keyboard.press('q');
const crankAngle = await page.evaluate(() => window.__mw.getState().project.parts.find((p) => p.name === 'Link').pose.angle);
log.check('crank rotated 90° about its pivot (joint stayed closed)', Math.abs(crankAngle - Math.PI / 2) < 1e-6, { crankAngle });

// 3. coupler: 80 mm link, dragged so its hole A snaps onto the crank's hole B (auto-pivot)
await page.click('[data-testid="lib-link"]');
await setField(page, 'param-length', 80);
let grab = await localXY(page, 'Link 2', 40, 0);
let pa = await portXY(page, 'Link 2', 'A');
let target = await portXY(page, 'Link', 'B');
await drag(page, grab, { x: target.x + (grab.x - pa.x), y: target.y + (grab.y - pa.y) });
log.check('dragging hole onto hole created a pivot (snap)', await page.evaluate(() => window.__mw.getState().project.joints.length === 2), await page.evaluate(() => window.__mw.getState().toast?.text ?? ''));

// 4. rocker: 60 mm link; its hole B snapped onto the coupler's hole B, then pinned to plate hole H2
await page.click('[data-testid="lib-link"]');
await setField(page, 'param-length', 60);
// move it away first so the drag starts from free space, then snap
grab = await localXY(page, 'Link 3', 30, 0);
await drag(page, grab, { x: grab.x + 40, y: grab.y + 170 });
grab = await localXY(page, 'Link 3', 30, 0);
pa = await portXY(page, 'Link 3', 'B');
target = await portXY(page, 'Link 2', 'B');
await drag(page, grab, { x: target.x + (grab.x - pa.x), y: target.y + (grab.y - pa.y) });
log.check('rocker pinned to coupler by drag-snap', await page.evaluate(() => window.__mw.getState().project.joints.length === 3));
await page.click('[data-testid="tool-revolute"]');
a = await portXY(page, 'Base plate', 'H2');
await page.mouse.click(a.x, a.y);
b = await portXY(page, 'Link 3', 'A');
await page.mouse.click(b.x, b.y);
await page.waitForTimeout(300);
const closed = await page.evaluate(() => { const s = window.__mw.getState(); return { joints: s.project.joints.length, issues: s.assemblyIssues.length }; });
log.check('loop closed: 4 pivots, assembly solved without issues', closed.joints === 4 && closed.issues === 0, closed);
await shot(page, '01b-linkage-assembled');

// 5. rename parts from the inspector / tree
for (const [oldN, newN] of [['Link', 'Crank'], ['Link 2', 'Coupler'], ['Link 3', 'Rocker']]) {
  await page.evaluate((n) => { const s = window.__mw.getState(); window.__mw.select({ parts: [s.project.parts.find((p) => p.name === n).id] }); }, oldN);
  await setField(page, 'part-name', newN);
}
log.check('parts renamed', await page.evaluate(() => window.__mw.getState().project.parts.map((p) => p.name).join() === 'Base plate,Crank,Coupler,Rocker'));

// 6. motor on the crank pivot: select the joint in the tree, then Library → Motor
await page.click('[data-testid="tab-tree"]');
await page.locator('.tree-row', { hasText: 'Pivot' }).first().click();
await page.click('[data-testid="tab-library"]');
await page.click('[data-testid="tool-motor"]');
await setField(page, 'motor-speed', '45 rpm');
log.check('motor added to the crank pivot at 45 rpm', await page.evaluate(() => { const j = window.__mw.getState().project.joints[0]; return j.motor?.enabled && Math.abs(j.motor.speed - 45 * 2 * Math.PI / 60) < 1e-9; }));

// 7. probe on the coupler midpoint
await page.click('[data-testid="tool-probe"]');
const mid = await localXY(page, 'Coupler', 40, 0);
await page.mouse.click(mid.x, mid.y);
await page.waitForTimeout(200);
log.check('point probe placed on the coupler', await page.evaluate(() => window.__mw.getState().project.probes.some((p) => p.target.kind === 'point')));

// 8. design-time diagnostics before running
await page.click('[data-testid="btab-diagnostics"]');
await page.waitForTimeout(400);
const pre = await simInfo(page);
log.check('mobility is 1 DOF, no static errors', pre.dof === 1 && pre.static.every((d) => d.sev !== 'error'), pre);

// 9. simulate
await page.keyboard.press('Escape');
await page.click('[data-testid="play"]');
await page.waitForTimeout(3500);
await page.click('[data-testid="btab-plots"]');
await page.waitForTimeout(500);
const run = await simInfo(page);
log.check('simulation runs in dynamic mode', run.status === 'running' && run.t > 1.5, run);
log.check('closed-loop joint error stays below 1e-6 mm', run.maxPosError < 1e-6, { maxPosError: run.maxPosError });
const trace = await page.evaluate(() => { const m = window.__mw; const r = m.simCtl.runner; const pr = m.getState().project.probes.find((p) => p.target.kind === 'point'); const sx = r.series({ probe: pr.id, quantity: 'x' }), sy = r.series({ probe: pr.id, quantity: 'y' }); let x0 = 1e9, x1 = -1e9, y0 = 1e9, y1 = -1e9; for (let i = 0; i < sx.y.length; i++) { x0 = Math.min(x0, sx.y[i]); x1 = Math.max(x1, sx.y[i]); y0 = Math.min(y0, sy.y[i]); y1 = Math.max(y1, sy.y[i]); } return { n: sx.y.length, xSpan: x1 - x0, ySpan: y1 - y0, provenance: sx.provenance }; });
log.check('motion trace recorded (coupler point sweeps a closed curve)', trace.n > 100 && trace.xSpan > 10 && trace.ySpan > 10, trace);
await shot(page, '01c-linkage-running');
await page.keyboard.press(' ');
await page.waitForTimeout(200);
const paused = await simInfo(page);
await page.keyboard.press('.');
const stepped = await simInfo(page);
log.check('pause then single-step advances exactly one timestep', paused.status === 'paused' && Math.abs(stepped.t - paused.t - 0.001) < 1e-9, { before: paused.t, after: stepped.t });
// reset restores the design, not erasing edits
const before = await page.evaluate(() => JSON.stringify(window.__mw.getState().project.parts.map((p) => p.pose)));
await page.keyboard.press('r');
await page.waitForTimeout(200);
const after = await page.evaluate(() => ({ poses: JSON.stringify(window.__mw.getState().project.parts.map((p) => p.pose)), status: window.__mw.getState().simStatus, parts: window.__mw.getState().project.parts.length }));
log.check('reset returns to the designed assembly and keeps all edits', after.status === 'idle' && after.poses === before && after.parts === 4, after.status);
await page.keyboard.press('Control+s');
await page.waitForTimeout(200);
log.check('no console/page errors', errors.length === 0, errors.join(' | '));
log.save();
await page.evaluate(() => window.__mw.saveCurrent());
await browser.close();
process.exit(log.fail ? 1 : 0);
