/**
 * UI regression checks for the findings of review round 2
 * (docs/review/round-2/): stale field text after undo, refused 2D exports,
 * variant validation on import, storage-failure warning, slide orientation,
 * rack positioning, auto-stack, blocked runs, small windows, dialogs, sketch
 * selection and re-editing.
 */
import { launch, fresh, portXY, localXY, setField, shot, Log, drag } from './lib.mjs';
const log = new Log('07-review-round2');
const S = (page, fn, a) => page.evaluate(fn, a);

{ // ---- 1024×768
  const { browser, page } = await launch({ w: 1024, h: 768 });
  try {
    await fresh(page);
    await page.click('[data-testid="welcome-gears"]'); await page.waitForTimeout(1200);
    await S(page, () => { const s = window.__mw.getState(); window.__mw.select({ parts: [s.project.parts[2].id] }); });
    await page.waitForTimeout(300);
    const m = await S(page, () => {
      const iw = window.innerWidth;
      const els = [...document.querySelectorAll('button, input, select, [role="tab"]')].filter((e) => e.offsetParent !== null && !e.closest('.bottom-body, .menu-pop, .lib-scroll, .tree'));
      const off = els.filter((e) => { const r = e.getBoundingClientRect(); return r.width > 0 && (r.right > iw + 0.5 || r.left < -0.5); });
      const hidden = [...document.querySelectorAll('.view-toolbar button')].filter((e) => { const r = e.getBoundingClientRect(); const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2); return !(top === e || e.contains(top) || top?.closest('button') === e); }).map((e) => e.textContent || e.title);
      return { iw, scrollW: document.documentElement.scrollWidth, off: off.map((e) => e.getAttribute('title') || e.getAttribute('data-testid') || e.textContent.slice(0, 16)), hidden };
    });
    log.check('1024×768: nothing clipped at the right edge and no view-toolbar button is covered', m.scrollW <= m.iw && m.off.length === 0 && m.hidden.length === 0, m);
    await shot(page, '07a-layout-1024x768');
  } finally { await browser.close(); }
}

const { browser, page, errors } = await launch();
try {
  await fresh(page);
  await page.click('[data-testid="welcome-empty"]');
  await page.click('[data-testid="lib-link"]'); await page.waitForTimeout(300);
  const width = () => S(page, () => window.__mw.getState().project.parts[0].params.width);
  const st = () => S(page, () => ({ past: window.__mw.getState().past.length, future: window.__mw.getState().future.length }));
  const wf = page.locator('[data-testid="param-width"]');
  // undo while focus is in the very field that the undo changes
  await wf.click(); for (let i = 0; i < 3; i++) await page.keyboard.press('ArrowUp');
  await page.waitForTimeout(100);
  await page.keyboard.press('Control+z'); await page.waitForTimeout(200);
  const a1 = { width: await width(), text: await wf.inputValue(), ...(await st()) };
  await page.locator('[data-testid="param-thickness"]').click(); await page.waitForTimeout(200);
  const a2 = { width: await width(), ...(await st()) };
  log.check('undo with focus in the edited field: the field follows the model and a later blur does not re-commit', a1.width === 10 && a1.text === '10' && a2.width === 10 && a2.future === 1, { a1, a2 });
  await wf.click(); await page.keyboard.press('Control+Shift+z'); await page.waitForTimeout(200);
  log.check('redo with focus in that field works on the first press and updates the text', (await width()) === 13 && (await wf.inputValue()) === '13', { width: await width(), text: await wf.inputValue() });
  await page.keyboard.press('Escape');
  // two typed commits in quick succession stay separate undo steps
  const p0 = (await st()).past;
  await wf.click(); await wf.fill('20'); await wf.press('Enter'); await wf.click(); await wf.fill('21'); await wf.press('Enter'); await page.waitForTimeout(100);
  log.check('two typed commits are two undo steps (only nudges merge)', (await st()).past === p0 + 2, await st());

  // ---- import: variant values validated; storage failure reported
  const base = JSON.parse(await S(page, () => JSON.stringify(window.__mw.getState().project)));
  const feed = async (name, obj) => { await page.setInputFiles('[data-testid="file-input"]', { name, mimeType: 'application/json', buffer: Buffer.from(typeof obj === 'string' ? obj : JSON.stringify(obj)) }); await page.waitForTimeout(400); return S(page, () => ({ toast: window.__mw.getState().toast?.text ?? '', name: window.__mw.getState().project.name, saveState: document.querySelector('[data-testid="save-state"]').textContent })); };
  const pid = base.parts[0].id;
  const v1 = await feed('v1.json', { ...base, name: 'BadVariant', variants: [{ id: 'v', name: 'Bad', note: '', values: { [`part:${pid}:length`]: 'long' } }] });
  const v2 = await feed('v2.json', { ...base, name: 'BadVariant', variants: [{ id: 'v', name: 'Huge', note: '', values: { [`part:${pid}:length`]: 1e9, 'sim:dt': 50 } }] });
  const v3 = await feed('v3.json', { ...base, name: 'BadFlag', parts: [{ ...base.parts[0], grounded: 'yes' }] });
  log.check('files with invalid variant values or non-boolean flags are rejected with the reason', [v1, v2, v3].every((r) => /^Cannot open file: the file contains/.test(r.toast) && !/^Bad/.test(r.name)), [v1.toast.slice(0, 140), v2.toast.slice(0, 160), v3.toast.slice(0, 120)]);
  const big = { ...base, name: 'Big file', description: 'x'.repeat(6 * 1024 * 1024) };
  const b1 = await feed('big.json', big);
  log.check('a valid file too large for browser storage opens with an explicit "NOT stored" warning and is not shown as saved', b1.name.startsWith('Big file') && /could NOT be stored/.test(b1.toast) && b1.saveState !== 'saved', { toast: b1.toast.slice(0, 120), saveState: b1.saveState });
  log.check('no uncaught exceptions during imports', errors.length === 0, errors.join(' | '));

  // ---- refused part: 2D exports refused too; 3MF names what it left out; run blocked
  await fresh(page);
  await page.click('[data-testid="welcome-fourbar"]'); await page.waitForTimeout(1200);
  await S(page, () => { const s = window.__mw.getState(); window.__mw.select({ parts: [s.project.parts.find((p) => p.name === 'Crank').id] }); window.__mwDownloads = []; });
  await setField(page, 'param-holeDiameter', 12);
  await page.click('[data-testid="btab-export"]'); await page.waitForTimeout(300);
  const toasts = {};
  for (const id of ['export-dxf', 'export-profile-svg', 'export-drawing']) { await page.click(`[data-testid="${id}"]`); await page.waitForTimeout(200); toasts[id] = await S(page, () => window.__mw.getState().toast?.text ?? ''); }
  const n2d = await S(page, () => window.__mwDownloads.length);
  await S(page, () => window.__mw.select({ parts: [] })); await page.waitForTimeout(200);
  await page.click('[data-testid="export-3mf"]'); await page.waitForTimeout(400);
  const t3 = await S(page, () => window.__mw.getState().toast?.text ?? '');
  await page.click('[data-testid="export-bom"]'); await page.waitForTimeout(200);
  const bom = await S(page, () => window.__mwDownloads.find((d) => d.filename.endsWith('_bom.csv'))?.data ?? '');
  log.check('DXF, profile SVG and drawing of an unbuildable part are refused like its STL', n2d === 0 && Object.values(toasts).every((t) => /was NOT exported/.test(t)), { n2d, sample: toasts['export-dxf'].slice(0, 90) });
  log.check('assembly 3MF says which part it left out; BOM marks the part as not buildable', /3 of 4 parts\. NOT included .*Crank/.test(t3) && /NOT BUILDABLE AS SPECIFIED/.test(bom), { t3 });
  await page.click('[data-testid="play"]'); await page.waitForTimeout(400);
  const blocked = await S(page, () => ({ status: window.__mw.getState().simStatus, toast: window.__mw.getState().toast?.text }));
  log.check('Play is refused while the design has an error (unbuildable part)', blocked.status === 'idle' && /Cannot start: fix the error/.test(blocked.toast), blocked);
  await page.keyboard.press('Control+z'); await page.waitForTimeout(300);

  // ---- auto-stack on the four-bar: only the lowered coupler moves, back to its layer; the motor stays
  await S(page, () => { const s = window.__mw.getState(); window.__mw.select({ parts: [s.project.parts.find((p) => p.name === 'Coupler').id] }); });
  await setField(page, 'pose-z', 4.5);
  if (!(await page.locator('[data-testid="auto-layer"]').count())) await page.click('[data-testid="btab-diagnostics"]');
  await page.waitForSelector('[data-testid="auto-layer"]'); await page.waitForTimeout(300);
  const before = await S(page, () => window.__mw.simCtl.ensure().events.filter((e) => e.code.startsWith('interference')).length);
  await page.click('[data-testid="auto-layer"]'); await page.waitForTimeout(500);
  const z = await S(page, () => Object.fromEntries(window.__mw.getState().project.parts.map((p) => [p.name, p.pose.z])));
  const after = await S(page, () => window.__mw.simCtl.ensure().events.filter((e) => e.code.startsWith('interference')).length);
  log.check('Auto-stack layers fixes the lowered coupler only (motor, crank and rocker stay on their layers)', before === 2 && after === 0 && z.Motor === 0 && z.Crank === 4.5 && z.Rocker === 4.5 && z.Coupler === 9, { before, after, z });

  // ---- delete a part: plots that lost every channel disappear
  await page.keyboard.press('Delete'); await page.waitForTimeout(300);
  const plots = await S(page, () => window.__mw.getState().project.plots.map((p) => [p.title, p.channels.length]));
  log.check('deleting a part removes the plots that only showed its probes', plots.every((p) => p[1] > 0) && plots.length === 3, plots);

  // ---- slide follows a rotated guide; rack & pinion is positioned when coupled
  await fresh(page);
  await page.click('[data-testid="welcome-empty"]');
  await page.click('.view-toolbar button:has-text("Ortho")'); await page.click('.view-toolbar button:has-text("Front")');
  await page.click('[data-testid="lib-rail"]'); await page.keyboard.press('g');
  await page.click('[data-testid="lib-slider"]');
  await page.click('[data-testid="tool-prismatic"]');
  let a = await localXY(page, 'Slotted guide', 62, 1.5); await page.mouse.click(a.x, a.y);
  let b = await portXY(page, 'Slider block', 'pin'); await page.mouse.click(b.x, b.y); await page.waitForTimeout(250);
  await S(page, () => { const s = window.__mw.getState(); window.__mw.select({ parts: [s.project.parts[0].id] }); });
  await setField(page, 'pose-angle', '30 deg');
  const sl = await S(page, () => { const s = window.__mw.getState().project; const g = s.parts[0].pose, p = s.parts[1].pose; return { rel: (p.angle - g.angle) * 180 / Math.PI, off: -Math.sin(g.angle) * (p.x - g.x) + Math.cos(g.angle) * (p.y - g.y), issues: window.__mw.getState().assemblyIssues.length }; });
  log.check('turning the guide 30° turns the slider with it and keeps it on the axis', Math.abs(sl.rel) < 1e-6 && Math.abs(sl.off) < 1e-6 && sl.issues === 0, sl);
  await page.click('[data-testid="lib-gear"]'); await page.click('[data-testid="lib-rack"]');
  let g0 = await localXY(page, 'Rack', 30, -6);
  await drag(page, g0, { x: g0.x + 60, y: g0.y + 150 });
  await page.click('[data-testid="tool-rackPinion"]');
  a = await localXY(page, 'Rack', 30, -6); await page.mouse.click(a.x, a.y);
  b = await localXY(page, 'Spur gear', 8, 4); await page.mouse.click(b.x, b.y); await page.waitForTimeout(400);
  const rk = await S(page, () => { const s = window.__mw.getState().project; const j = s.joints.find((x) => x.type === 'rackPinion'); const G = s.parts.find((p) => p.id === j.a), R = s.parts.find((p) => p.id === j.b); const side = -Math.sin(R.pose.angle) * (G.pose.x - R.pose.x) + Math.cos(R.pose.angle) * (G.pose.y - R.pose.y); return { a: G.kind, b: R.kind, side, errors: window.__mw.simCtl.ensure().staticDiagnostics.filter((d) => d.severity === 'error').map((d) => d.title) }; });
  log.check('Rack & pinion (picked rack first): roles are ordered, the pitch line is brought tangent to the pitch circle (20 mm), no error', rk.a === 'gear' && rk.b === 'rack' && Math.abs(rk.side - 20) < 1e-4 && rk.errors.length === 0, rk);

  // ---- dialogs trap focus; viewport has an accessible name
  await page.keyboard.press('Escape'); await page.keyboard.press('Escape');
  await page.keyboard.press('?'); await page.waitForSelector('[data-testid="dialog-shortcuts"]');
  let inside = true;
  for (let i = 0; i < 6; i++) { await page.keyboard.press('Tab'); inside = inside && await S(page, () => !!document.activeElement?.closest('.modal')); }
  await page.keyboard.press('Shift+Tab'); inside = inside && await S(page, () => !!document.activeElement?.closest('.modal'));
  await page.keyboard.press('Escape');
  const label = await S(page, () => document.querySelector('[data-testid="viewport"] canvas').getAttribute('aria-label'));
  log.check('Tab / Shift+Tab stay inside an open dialog; the 3D canvas has an accessible name', inside && /3D viewport/.test(label), { inside, label: label?.slice(0, 40) });

  // ---- sketch: select a line by clicking it, constrain it; re-edit a sketched part by double-click
  await fresh(page);
  await page.click('[data-testid="welcome-empty"]');
  await page.click('[data-testid="lib-sketch"]'); await page.waitForSelector('[data-testid="sketch-svg"]');
  const box = await page.locator('[data-testid="sketch-svg"]').boundingBox();
  const at = (x, y) => ({ x: box.x + box.width / 2 + x * 5, y: box.y + box.height / 2 - y * 5 });
  await page.click('[data-testid="sk-tool-line"]');
  let q = at(-20, 10); await page.mouse.click(q.x, q.y); q = at(10, 16); await page.mouse.click(q.x, q.y);
  await page.keyboard.press('Escape'); await page.keyboard.press('Escape');
  q = at(-5, 13); await page.mouse.click(q.x, q.y); await page.waitForTimeout(150);      // middle of the line
  const hEnabled = await page.locator('[data-testid="sk-con-horizontal"]').isEnabled();
  await page.click('[data-testid="sk-con-horizontal"]'); await page.waitForTimeout(150);
  const ln = await S(page, () => { const s = window.__mw.getState(); const sk = s.project.sketches[0]; return { pts: sk.points.map((p) => [p.x, p.y]), cons: sk.constraints.map((c) => c.type) }; });
  log.check('sketch: clicking a line selects it and Horizontal applies to it', hEnabled && ln.cons.includes('horizontal') && Math.abs(ln.pts[0][1] - ln.pts[1][1]) < 1e-6, ln);
  await page.keyboard.press('Control+z');
  await page.click('[data-testid="sk-tool-rect"]');
  q = at(-30, -20); await page.mouse.click(q.x, q.y); q = at(20, 0); await page.mouse.click(q.x, q.y);
  await page.click('[data-testid="sk-finish"]'); await page.waitForTimeout(500);
  await page.click('.view-toolbar button:has-text("Ortho")'); await page.click('.view-toolbar button:has-text("Front")'); await page.waitForTimeout(300);
  const c = await S(page, () => { const s = window.__mw.getState(); const p = s.project.parts[0]; return window.__mwView.worldToClient(p.pose.x - 5, p.pose.y - 10, window.__mwView.topZ(p.id)); });
  await page.mouse.dblclick(c.x, c.y); await page.waitForTimeout(400);
  log.check('double-clicking a sketched part opens its sketch again', (await S(page, () => window.__mw.getState().mode)) === 'sketch');

  // ---- follow-ups to the final round-2 report (R2-2 … R2-8)
  await fresh(page);
  await page.click('[data-testid="welcome-fourbar"]'); await page.waitForTimeout(1200);
  // R2-3: batch STL names the part it skipped; on-screen BOM marks it
  await S(page, () => { const s = window.__mw.getState(); window.__mw.select({ parts: [s.project.parts.find((p) => p.name === 'Crank').id] }); window.__mwDownloads = []; });
  await setField(page, 'param-holeDiameter', 12);
  await S(page, () => window.__mw.select({ parts: [] }));
  await page.click('[data-testid="btab-export"]'); await page.waitForTimeout(300);
  await page.click('[data-testid="export-stl"]'); await page.waitForTimeout(500);
  const stlToast = await S(page, () => window.__mw.getState().toast?.text ?? '');
  const bomText = await page.locator('[data-testid="bom-table"]').innerText();
  log.check('batch STL export names the unbuildable part it skipped; the on-screen BOM marks it', /Exported 3 STL files.*NOT exported.*Crank/.test(stlToast) && /not buildable as specified/.test(bomText), { stlToast });
  await page.keyboard.press('Control+z'); await page.waitForTimeout(300);
  // R2-5: diagnostics header follows the display unit
  await page.click('[data-testid="btab-diagnostics"]'); await page.waitForTimeout(200);
  await page.locator('.section-toggle', { hasText: 'Units' }).click();
  await page.selectOption('[data-testid="unit-preset"]', 'inch'); await page.waitForTimeout(300);
  const je = await page.locator('[data-testid="joint-error"]').innerText();
  log.check('inch preset: the Diagnostics header shows the joint error in inches', / in$/.test(je), je);
  await page.selectOption('[data-testid="unit-preset"]', 'mmN'); await page.waitForTimeout(200);
  // R2-2: a nudge right after a typed commit is its own undo step
  await S(page, () => { const s = window.__mw.getState(); window.__mw.select({ parts: [s.project.parts.find((p) => p.name === 'Rocker').id] }); });
  const wf2 = page.locator('[data-testid="param-width"]');
  const steps0 = await S(page, () => window.__mw.getState().past.length);
  await wf2.click(); await wf2.fill('20'); await wf2.press('Enter'); await wf2.click(); await page.keyboard.press('ArrowUp'); await page.keyboard.press('ArrowUp'); await page.keyboard.press('Escape'); await page.waitForTimeout(150);
  const steps1 = await S(page, () => window.__mw.getState().past.length);
  await page.keyboard.press('Control+z'); await page.waitForTimeout(200);
  log.check('typed value then nudges: two undo steps, and undo returns to the typed value', steps1 === steps0 + 2 && (await S(page, () => window.__mw.getState().project.parts.find((p) => p.name === 'Rocker').params.width)) === 20, { steps: steps1 - steps0 });
  // R2-4: typing a pose that the joints do not allow explains why it was not kept
  await setField(page, 'pose-x', 250); await page.waitForTimeout(250);
  const held = await S(page, () => ({ toast: window.__mw.getState().toast?.text ?? '', x: window.__mw.getState().project.parts.find((p) => p.name === 'Rocker').pose.x }));
  const heldField = await page.locator('[data-testid="pose-x"]').inputValue();
  const heldSteps = await S(page, () => window.__mw.getState().past.length);
  log.check('a typed position that the joints do not allow is explained, the field returns to the model value and no undo step is left', /held by its joints.*nothing was changed/.test(held.toast) && Math.abs(held.x - 100) < 1e-6 && heldField === '100', { ...held, heldField });
  // a typed rotation that selects another closure of the loop is kept as one step and described as a re-pose
  await setField(page, 'pose-angle', '10 deg'); await page.waitForTimeout(300);
  const flip = await S(page, () => ({ toast: window.__mw.getState().toast?.text ?? '', steps: window.__mw.getState().past.length, angle: window.__mw.getState().project.parts.find((p) => p.name === 'Rocker').pose.angle * 180 / Math.PI, issues: window.__mw.getState().assemblyIssues.length }));
  const flipField = await page.locator('[data-testid="pose-angle"]').inputValue();
  log.check('a typed rotation that re-poses the linkage says so, shows the resulting angle in the field, and is one undo step', /re-posed to another assembly that keeps all joints closed/.test(flip.toast) && flip.steps === heldSteps + 1 && flip.issues === 0 && Math.abs(parseFloat(flipField) - flip.angle) < 1e-2, { ...flip, flipField });
  await page.keyboard.press('Escape'); await page.keyboard.press('Control+z'); await page.waitForTimeout(250);
  // R2-12: retyping the displayed rotation is not reported as "could not be kept"; a refused nudge leaves the model value in the field
  await S(page, () => { const s = window.__mw.getState(); window.__mw.select({ parts: [s.project.parts.find((p) => p.name === 'Rocker').id] }); }); await page.waitForTimeout(200);
  const shownAngle = await page.locator('[data-testid="pose-angle"]').inputValue();
  await S(page, () => window.__mw.setState({ toast: null }));
  await setField(page, 'pose-angle', '10 deg'); await page.waitForTimeout(250);
  await S(page, () => window.__mw.setState({ toast: null }));
  await setField(page, 'pose-angle', shownAngle); await page.waitForTimeout(300);
  const back = await S(page, () => ({ toast: window.__mw.getState().toast?.text ?? '', angle: window.__mw.getState().project.parts.find((p) => p.name === 'Rocker').pose.angle * 180 / Math.PI }));
  log.check('retyping the displayed rotation from the other branch restores it without a "could not be kept" message', Math.abs(back.angle - parseFloat(shownAngle)) < 1e-3 && !/could not be kept/.test(back.toast), { ...back, shownAngle });
  await S(page, () => { document.activeElement?.blur?.(); window.__mw.undo(); window.__mw.undo(); }); await page.waitForTimeout(250);
  const kSteps = await S(page, () => ({ past: window.__mw.getState().past.length, future: window.__mw.getState().future.length }));
  const fx = page.locator('[data-testid="pose-x"]'); await fx.click(); await page.keyboard.press('ArrowUp'); await page.waitForTimeout(250);
  const nudged = { field: await fx.inputValue(), ...(await S(page, () => ({ past: window.__mw.getState().past.length, future: window.__mw.getState().future.length, toast: window.__mw.getState().toast?.text ?? '' }))) };
  log.check('a refused nudge in a pose field shows the model value again and adds no undo step', nudged.field === '100' && nudged.past === kSteps.past && nudged.future === kSteps.future && /held by its joints/.test(nudged.toast), nudged);
  // R2-11: an arrow key in the viewport on a part its joints hold: explained, no undo step, redo stack kept
  await S(page, () => { document.activeElement?.blur?.(); window.__mw.setState({ toast: null }); });
  await page.keyboard.press('ArrowUp'); await page.waitForTimeout(200);
  const ka = await S(page, () => ({ past: window.__mw.getState().past.length, future: window.__mw.getState().future.length, toast: window.__mw.getState().toast?.text ?? '', dirty: window.__mw.getState().dirty }));
  log.check('arrow key on a part held by its joints: explained, no undo step, redo stack untouched', ka.past === kSteps.past && ka.future === kSteps.future && /held by its joints.*nothing was changed/.test(ka.toast), { kSteps, ka });
  // Q on the rocker asks for +15 deg, which the linkage can reach: the mechanism is posed, the angle is met exactly, one undo step
  const rk0 = await S(page, () => { window.__mw.setState({ toast: null }); const g = window.__mw.getState().project; return { rocker: g.parts.find((p) => p.name === 'Rocker').pose.angle, crank: g.parts.find((p) => p.name === 'Crank').pose.angle }; });
  await page.keyboard.press('q'); await page.waitForTimeout(250);
  const kq = await S(page, () => { const st = window.__mw.getState(); const g = st.project; return { past: st.past.length, toast: st.toast?.text ?? '', issues: st.assemblyIssues.length, rocker: g.parts.find((p) => p.name === 'Rocker').pose.angle, crank: g.parts.find((p) => p.name === 'Crank').pose.angle }; });
  log.check('Q on the four-bar rocker poses the mechanism: +15 deg met exactly, the crank follows, one undo step, no message', Math.abs(kq.rocker - rk0.rocker - 15 * Math.PI / 180) < 1e-12 && Math.abs(kq.crank - rk0.crank) > 0.05 && kq.past === kSteps.past + 1 && kq.toast === '' && kq.issues === 0, { rk0, kq });
  await S(page, () => window.__mw.undo()); await page.waitForTimeout(200);
  // R2-13: a typed position on a part of an ungrounded jointed pair moves the pair rigidly and is met exactly
  const pair = await page.evaluate(() => {
    const m = window.__mw; let ids = [];
    m.commit('setup: two pinned links', (p) => { const a = m.ops.addPart(p, 'link', { name: 'Free A', pose: { x: 300, y: 200 } }); const b = m.ops.addPart(a.project, 'link', { name: 'Free B', pose: { x: 340, y: 240 } }); ids = [a.id, b.id]; return m.ops.mateRevolute(b.project, a.id, { port: 'B' }, b.id, { port: 'A' }).project; });
    m.select({ parts: [ids[0]] }); m.setState({ toast: null });
    const g = m.getState().project;
    return { ids, ax: g.parts.find((q) => q.id === ids[0]).pose.x, bx: g.parts.find((q) => q.id === ids[1]).pose.x, past: m.getState().past.length };
  });
  await page.waitForTimeout(200);
  await setField(page, 'pose-x', 310); await page.waitForTimeout(300);
  const pairAfter = await page.evaluate((ids) => { const st = window.__mw.getState(); const g = st.project; return { ax: g.parts.find((q) => q.id === ids[0]).pose.x, bx: g.parts.find((q) => q.id === ids[1]).pose.x, past: st.past.length, toast: st.toast?.text ?? '', issues: st.assemblyIssues.length }; }, pair.ids);
  const pairField = await page.locator('[data-testid="pose-x"]').inputValue();
  log.check('typed X on a part of a free jointed pair: value met exactly, the pair moves together, one undo step, no message', Math.abs(pairAfter.ax - 310) < 1e-9 && Math.abs((pairAfter.bx - pair.bx) - (310 - pair.ax)) < 1e-9 && pairAfter.past === pair.past + 1 && pairAfter.toast === '' && pairAfter.issues === 0 && pairField === '310', { pair, pairAfter, pairField });
  // R2-14: the same pair held by a ground pivot (no motor): a typed rotation is met exactly and the hanging link follows
  const arm = await page.evaluate((ids) => {
    const m = window.__mw;
    m.commit('setup: ground pivot', (p) => { const a = p.parts.find((q) => q.id === ids[0]); return m.ops.mateRevolute(p, 'ground', { x: a.pose.x, y: a.pose.y }, ids[0], { port: 'A' }, { move: false }).project; });
    m.setState({ toast: null });
    const st = m.getState();
    return { past: st.past.length, issues: st.assemblyIssues.length, joints: st.project.joints.length };
  }, pair.ids);
  await page.waitForTimeout(200);
  await setField(page, 'pose-angle', '40 deg'); await page.waitForTimeout(300);
  const armAfter = await page.evaluate((ids) => {
    const st = window.__mw.getState(); const g = st.project; const a = g.parts.find((q) => q.id === ids[0]), b = g.parts.find((q) => q.id === ids[1]);
    const L = a.params.length; const tip = { x: a.pose.x + L * Math.cos(a.pose.angle), y: a.pose.y + L * Math.sin(a.pose.angle) };
    return { angle: a.pose.angle * 180 / Math.PI, ax: a.pose.x, pinGap: Math.hypot(b.pose.x - tip.x, b.pose.y - tip.y), past: st.past.length, toast: st.toast?.text ?? '', issues: st.assemblyIssues.length };
  }, pair.ids);
  const armField = await page.locator('[data-testid="pose-angle"]').inputValue();
  log.check('typed rotation on a ground-pivoted link with a link hanging from it: 40 deg met exactly, the hanging link follows, one undo step, no message', Math.abs(armAfter.angle - 40) < 1e-9 && armAfter.pinGap < 1e-6 && armAfter.past === arm.past + 1 && armAfter.toast === '' && armAfter.issues === 0 && armField === '40', { arm, armAfter, armField });
  await page.evaluate(() => { document.activeElement?.blur?.(); for (let i = 0; i < 4; i++) window.__mw.undo(); }); await page.waitForTimeout(250);
  // R2-7: after a project that could not be stored, a reload starts cleanly (no "damaged" message)
  const baseP = JSON.parse(await S(page, () => JSON.stringify(window.__mw.getState().project)));
  await page.setInputFiles('[data-testid="file-input"]', { name: 'big.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify({ ...baseP, name: 'Big file', description: 'x'.repeat(6 * 1024 * 1024) })) });
  await page.waitForTimeout(600);
  await page.reload(); await page.waitForSelector('.app[data-ready="true"]'); await page.waitForTimeout(600);
  const re = await S(page, () => ({ toast: window.__mw.getState().toast?.text ?? '', name: window.__mw.getState().project.name }));
  log.check('reload after an unstorable project: no misleading "missing or damaged" message', !/damaged/.test(re.toast), re);
  // R2-16: a keyboard move that the joints only allow in adjusted form is explained like the typed one
  await page.click('[data-testid="welcome-gears"]'); await page.waitForTimeout(1300);
  const gk0 = await S(page, () => { const m = window.__mw; const g = m.getState().project; const w = g.parts.find((p) => p.name === 'Gear 48T'); m.select({ parts: [w.id] }); m.setState({ toast: null }); document.activeElement?.blur?.(); return { x: w.pose.x, y: w.pose.y, past: m.getState().past.length }; });
  await page.waitForTimeout(200);
  await page.keyboard.press('Shift+ArrowRight'); await page.waitForTimeout(300);
  const gk1 = await S(page, () => { const st = window.__mw.getState(); const w = st.project.parts.find((p) => p.name === 'Gear 48T'); return { x: w.pose.x, y: w.pose.y, past: st.past.length, toast: st.toast?.text ?? '' }; });
  const gearMoved = Math.hypot(gk1.x - gk0.x, gk1.y - gk0.y);
  log.check('arrow key on a meshed gear: either met exactly, or refused / re-posed WITH a message (never a silent adjusted move)', (Math.abs(gk1.x - gk0.x - 10) < 1e-3 && Math.abs(gk1.y - gk0.y) < 1e-3) || (gearMoved < 1e-6 && gk1.past === gk0.past && /nothing was changed/.test(gk1.toast)) || (gk1.past === gk0.past + 1 && /re-posed to another assembly that keeps all joints closed \(X .*, Y .*\)/.test(gk1.toast)), { gk0, gk1 });
  await fresh(page);
  // R2-15: on the free-standing walker, a typed Rotation on a crank web sets the crank phase; the chassis does not move
  await page.click('[data-testid="welcome-walker"]'); await page.waitForTimeout(1500);
  const wk0 = await S(page, () => { const m = window.__mw; const g = m.getState().project; const c = g.parts.find((p) => p.name === 'Crank web 1'), sp = g.parts.find((p) => p.name === 'Side plate A'); m.select({ parts: [c.id] }); m.setState({ toast: null }); return { crank: c.pose.angle * 180 / Math.PI, plate: { ...sp.pose }, past: m.getState().past.length, grounded: g.parts.filter((p) => p.grounded).length }; });
  await page.waitForTimeout(250);
  await setField(page, 'pose-angle', `${wk0.crank + 30} deg`); await page.waitForTimeout(500);
  const wk1 = await S(page, () => { const st = window.__mw.getState(); const g = st.project; const c = g.parts.find((p) => p.name === 'Crank web 1'), sp = g.parts.find((p) => p.name === 'Side plate A'); return { crank: c.pose.angle * 180 / Math.PI, plate: { ...sp.pose }, past: st.past.length, toast: st.toast?.text ?? '', issues: st.assemblyIssues.length, grounded: g.parts.filter((p) => p.grounded).length }; });
  log.check('walker: typed Rotation on a crank web turns the crank by exactly that much, the chassis stays where it is, one undo step, no message', Math.abs(wk1.crank - wk0.crank - 30) < 1e-9 && wk1.plate.x === wk0.plate.x && wk1.plate.y === wk0.plate.y && wk1.plate.angle === wk0.plate.angle && wk1.past === wk0.past + 1 && wk1.toast === '' && wk1.issues === 0 && wk1.grounded === wk0.grounded, { wk0, wk1 });
  await S(page, () => document.activeElement?.blur?.());
  await page.click('[data-testid="play"]');
  await page.waitForFunction(() => (window.__mw.simCtl.runner?.time ?? 0) > 1.2, null, { timeout: 60000 }).catch(() => {});
  await page.click('[data-testid="play"]'); await page.waitForTimeout(200);
  const wkRun = await S(page, () => { const r = window.__mw.simCtl.runner; const g = window.__mw.getState().project; const sp = g.parts.find((p) => p.name === 'Side plate A'); const pose = r.poseOf(sp.id); return { t: r.time, maxPosError: r.sim.stats.maxPosError ?? null, status: window.__mw.getState().simStatus, errors: (r.events ?? []).filter((e) => e.severity === 'error').map((e) => e.code), x: pose?.x ?? null }; });
  log.check('walker with the re-phased crank still runs: no error events, joints closed', wkRun.t > 1.2 && wkRun.errors.length === 0 && (wkRun.maxPosError === null || wkRun.maxPosError < 1e-6), wkRun);
  log.check('no console/page errors in the whole session', errors.length === 0, errors.join(' | '));
} finally {
  log.save();
  await browser.close();
}
process.exit(log.fail ? 1 : 0);
