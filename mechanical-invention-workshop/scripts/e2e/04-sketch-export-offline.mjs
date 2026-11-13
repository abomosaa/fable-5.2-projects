/**
 * Sketch → constrained profile → extruded part → joint; then export a custom
 * part (STL, 3MF, drawing, DXF, BOM, guide) from the UI, write the files to
 * disk for independent verification, and prove the built app launches and
 * works with the network disabled.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { launch, fresh, setField, shot, Log, simInfo, OUT, URL } from './lib.mjs';
const log = new Log('04-sketch-export-offline');
const { browser, ctx, page, errors } = await launch();
const requests = [];
page.on('request', (r) => requests.push(r.url()));
await fresh(page);
await page.click('[data-testid="welcome-empty"]');

// ------------------------------------------------------------------ sketch
await page.click('[data-testid="lib-sketch"]');
await page.waitForSelector('[data-testid="sketch-svg"]');
const box = await page.locator('[data-testid="sketch-svg"]').boundingBox();
const Z = 5; // default zoom px/mm for an empty sketch, centred on the origin
const at = (x, y) => ({ x: box.x + box.width / 2 + x * Z, y: box.y + box.height / 2 - y * Z });
const click = async (x, y, opts) => { const p = at(x, y); await page.mouse.click(p.x, p.y, opts); await page.waitForTimeout(60); };
const status = () => page.evaluate(() => { const el = document.querySelector('[data-testid="sketch-status"]'); return { status: el.dataset.status, text: el.textContent }; });
const sk = () => page.evaluate(() => { const s = window.__mw.getState(); return s.project.sketches.find((x) => x.id === s.activeSketch); });
log.check('sketch mode opens with an empty-state message', (await status()).status === 'empty');
// rectangle 60 × 20 (drawn roughly, then dimensioned exactly)
await page.click('[data-testid="sk-tool-rect"]');
await click(-31, -9); await click(28, 12);
// two circles: one hole at each end
await page.click('[data-testid="sk-tool-circle"]');
await click(-20, 0); await click(-17, 0);
await click(20, 1); await click(22, 1);
await page.keyboard.press('Escape');
let s = await sk();
log.check('rectangle + 2 circles drawn: 6 points, 4 lines, 2 circles, H/V constraints inferred', s.points.length === 6 && s.entities.filter((e) => e.type === 'line').length === 4 && s.entities.filter((e) => e.type === 'circle').length === 2 && s.constraints.length === 4, { points: s.points.length, constraints: s.constraints.map((c) => c.type) });
let st = await status();
log.check('status reports under-constrained with the remaining degrees of freedom', st.status === 'under-constrained', st.text);
await shot(page, '04a-sketch-underconstrained');
const ptXY = async (id) => { const b = await page.locator(`[data-testid="sk-pt-${id}"]`).boundingBox(); return { x: b.x + b.width / 2, y: b.y + b.height / 2 }; };
const selectPts = async (ids) => { await page.keyboard.press('Escape'); for (let i = 0; i < ids.length; i++) { const p = await ptXY(ids[i]); if (i) await page.keyboard.down('Shift'); await page.mouse.click(p.x, p.y); if (i) await page.keyboard.up('Shift'); } };
const con = async (name) => { await page.click(`[data-testid="sk-con-${name}"]`); await page.waitForTimeout(100); };
const lastCon = async () => (await sk()).constraints.at(-1);
const setCon = async (value) => { const c = await lastCon(); await setField(page, `sk-val-${c.id}`, value); };
// identify corners and circle centres by position
s = await sk();
const corners = s.points.filter((p) => s.entities.some((e) => e.type === 'line' && (e.p1 === p.id || e.p2 === p.id)));
const by = (fx, fy) => corners.slice().sort((a, b) => fx * (a.x - b.x) + fy * (a.y - b.y))[0].id;
const bl = by(1, 1), br = by(-1, 1), tl = by(1, -1);
const centres = s.entities.filter((e) => e.type === 'circle').map((e) => e.center);
const circles = s.entities.filter((e) => e.type === 'circle');
// fix the bottom-left corner, dimension width 60 and height 20
await selectPts([bl]); await con('fix');
await selectPts([bl, br]); await con('distance'); await setCon(60);
await selectPts([bl, tl]); await con('distance'); await setCon(20);
// hole positions: 10 mm from the left / right edges, centred vertically (dimension to corners)
await selectPts([bl, centres[0]]); await con('distance'); await setCon('sqrt(200)'.replace('sqrt(200)', '14.142135623731'));
await selectPts([tl, centres[0]]); await con('distance'); await setCon(14.142135623731);
await selectPts([br, centres[1]]); await con('distance'); await setCon(14.142135623731);
const tr = corners.find((p) => ![bl, br, tl].includes(p.id)).id;
await selectPts([tr, centres[1]]); await con('distance'); await setCon(14.142135623731);
// radii: select each circle by clicking its rim (centre + r, 0)
for (const c of circles) {
  const cur = (await sk());
  const ctr = cur.points.find((p) => p.id === c.center); const cc = cur.entities.find((e) => e.id === c.id);
  await page.keyboard.press('Escape');
  const p0 = await ptXY(c.center);
  await page.mouse.click(p0.x + cc.r * Z * (await page.evaluate(() => 1)), p0.y); // rim along +x at the current zoom (5 px/mm)
  await con('radius'); await setCon(2.1);
  void ctr;
}
st = await status();
s = await sk();
const pos = Object.fromEntries(s.points.map((p) => [p.id, p]));
log.check('fully constrained after dimensions: exact 60 × 20 with holes 40 mm apart', st.status === 'fully-constrained' && Math.abs(pos[br].x - pos[bl].x - 60) < 1e-6 && Math.abs(pos[tl].y - pos[bl].y - 20) < 1e-6 && Math.abs(Math.hypot(pos[centres[1]].x - pos[centres[0]].x, pos[centres[1]].y - pos[centres[0]].y) - 40) < 1e-5, st);
await shot(page, '04b-sketch-fully-constrained');
// redundant constraint: the top edge length is already implied
await selectPts([tl, tr]); await con('distance');
st = await status();
log.check('adding an implied dimension is reported as redundant', st.status === 'redundant', st.text);
// make it conflicting: demand 75 mm for the top edge while the bottom is 60
const before = JSON.stringify((await sk()).points);
await setCon(75);
st = await status();
const after = JSON.stringify((await sk()).points);
log.check('a contradictory dimension is reported as conflicting and the geometry is NOT deformed', st.status === 'conflicting' && before === after, st.text);
await shot(page, '04c-sketch-conflict');
// delete the offending constraint
const bad = await lastCon();
await page.click(`[data-testid="sk-con-item-${bad.id}"] .icon-btn`);
st = await status();
log.check('deleting the conflicting constraint returns to fully constrained', st.status === 'fully-constrained', st.status);
const prof = await page.locator('[data-testid="profile-status"]').textContent();
log.check('closed profile with two cut-outs detected for extrusion', /1 closed region, 2 cut-out/.test(prof), prof);
await setField(page, 'sk-thickness', 5);
await page.click('[data-testid="sk-finish"]');
await page.waitForTimeout(600);
const partInfo = await page.evaluate(() => { const st = window.__mw.getState(); const p = st.project.parts[0]; const r = window.__mw.simCtl.ensure(); const g = r.model.geom.get(p.id); return { kind: p.kind, name: p.name, ports: g.ports.filter((q) => q.kind === 'hole').length, layers: g.layers.length, thickness: g.zMax - g.zMin, warnings: g.warnings }; });
log.check('sketch extruded into a 5 mm solid part with two hole anchors', partInfo.kind === 'plate' && partInfo.ports === 2 && partInfo.thickness === 5 && partInfo.warnings.length === 0, partInfo);
// use it in an assembly: pin a hole to ground and let it swing as a pendulum
await page.click('.view-toolbar button:has-text("Ortho")'); await page.click('.view-toolbar button:has-text("Front")');
await page.click('[data-testid="tab-library"]');
await page.click('[data-testid="tool-revolute"]');
const holeId = await page.evaluate(() => { const st = window.__mw.getState(); const p = st.project.parts[0]; return window.__mw.simCtl.ensure().model.geom.get(p.id).ports.find((q) => q.kind === 'hole').id; });
const hp = await page.evaluate((h) => window.__mwView.portToClient(window.__mw.getState().project.parts[0].id, h), holeId);
await page.mouse.click(hp.x - 220, hp.y - 120);   // empty space → ground pivot
await page.mouse.click(hp.x, hp.y);
await page.waitForTimeout(300);
await page.click('[data-testid="play"]'); await page.waitForTimeout(1500); await page.keyboard.press(' ');
const pend = await simInfo(page);
log.check('sketched part works in the simulation (pinned at its hole, swings under gravity)', pend.t > 0.5 && pend.dof === 1 && pend.maxPosError < 1e-6, { t: pend.t, dof: pend.dof, err: pend.maxPosError });
await shot(page, '04d-sketched-part-in-assembly');
await page.keyboard.press('r');

// ------------------------------------------------------------------ exports from the UI
const expDir = `${OUT}/ui-exports`;
mkdirSync(expDir, { recursive: true });
await page.evaluate(() => { const st = window.__mw.getState(); window.__mw.select({ parts: [st.project.parts[0].id] }); window.__mwDownloads = []; });
await page.click('[data-testid="btab-export"]');
await page.waitForTimeout(400);
for (const id of ['export-stl', 'export-3mf', 'export-drawing', 'export-dxf', 'export-profile-svg', 'export-bom', 'export-guide', 'export-project']) { await page.click(`[data-testid="${id}"]`); await page.waitForTimeout(250); }
const files = await page.evaluate(() => window.__mwDownloads.map((d) => ({ filename: d.filename, size: d.size, text: typeof d.data === 'string' ? d.data : null, bytes: typeof d.data === 'string' ? null : Array.from(d.data) })));
for (const f of files) writeFileSync(`${expDir}/${f.filename}`, f.text !== null ? f.text : Buffer.from(f.bytes));
log.check('eight export files produced by the UI', files.length === 8 && files.every((f) => f.size > 100), files.map((f) => `${f.filename} (${f.size})`));
writeFileSync(`${expDir}/expected.json`, JSON.stringify({
  note: 'Expected values come from the sketch dimensions typed in the UI, not from the exported files.',
  bbox: [60, 20, 5], volume: (60 * 20 - 2 * Math.PI * 2.1 * 2.1) * 5, holes: [{ x: 10, y: 10, d: 4.2 }, { x: 50, y: 10, d: 4.2 }], holeSpacing: 40, genus: 2,
  files: Object.fromEntries(files.map((f) => [f.filename.split('.').pop() + (f.filename.includes('drawing') ? ':drawing' : f.filename.includes('profile') ? ':profile' : ''), f.filename])),
}, null, 1));
await shot(page, '04e-manufacture-panel');

// ------------------------------------------------------------------ offline launch
await ctx.setOffline(true);
const offline = await ctx.newPage();
const offReq = [];
offline.on('request', (r) => offReq.push(r.url()));
let offlineOk = false, offInfo = null;
try {
  // "offline" in Chromium blocks every non-loopback host; the app itself is served from this machine
  await ctx.setOffline(false);
  await offline.route('**/*', (route) => { const u = new globalThis.URL(route.request().url()); return ['127.0.0.1', 'localhost'].includes(u.hostname) || u.protocol === 'data:' || u.protocol === 'blob:' ? route.continue() : route.abort(); });
  await offline.goto(URL);
  await offline.waitForSelector('.app[data-ready="true"]', { timeout: 30000 });
  await offline.click('[data-testid="menu-examples"]'); await offline.click('[data-testid="example-gears"]');
  await offline.waitForTimeout(1500);
  await offline.click('[data-testid="play"]');
  // wait for simulated time to pass 0.5 s (software rendering makes the wall-clock time for this vary)
  await offline.waitForFunction(() => (window.__mw.simCtl.runner?.time ?? 0) > 0.5, null, { timeout: 20000 }).catch(() => {});
  offInfo = await offline.evaluate(() => ({ t: window.__mw.simCtl.runner.time, parts: window.__mw.getState().project.parts.length }));
  offlineOk = offInfo.t > 0.5 && offInfo.parts === 9;
} catch (e) { offInfo = String(e); }
const external = [...requests, ...offReq].filter((u) => !/^(http:\/\/(127\.0\.0\.1|localhost)|data:|blob:)/.test(u));
log.check('app loads, opens an example and simulates with every non-local request blocked', offlineOk, offInfo);
log.check('no request to any external host during the whole session', external.length === 0, { total: requests.length + offReq.length, external });
log.check('no console/page errors', errors.length === 0, errors.join(' | '));
log.save();
await browser.close();
process.exit(log.fail ? 1 : 0);
