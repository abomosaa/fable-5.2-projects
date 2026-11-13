/**
 * Measures viewport frame time, solver step time and real-time factor for each
 * showcase in the running app. Results depend on the machine and on whether
 * the browser has hardware WebGL (set MW_GPU=1) or software rendering.
 */
import { writeFileSync } from 'node:fs';
import { launch, fresh, OUT } from './lib.mjs';
const { browser, page, errors } = await launch();
const rows = [];
let hw = null;
for (const ex of ['fourbar', 'gears', 'cam', 'slidercrank', 'walker']) {
  await fresh(page);
  await page.click(`[data-testid="welcome-${ex}"]`);
  await page.waitForTimeout(1200);
  await page.click('.view-toolbar button:has-text("Three-quarter")');
  // manipulation responsiveness while idle: orbit with the mouse and sample the frame time
  const box = await page.locator('[data-testid="viewport"]').boundingBox();
  await page.mouse.move(box.x + 80, box.y + box.height - 80);
  await page.mouse.down({ button: 'right' });
  for (let i = 0; i < 30; i++) { await page.mouse.move(box.x + 80 + i * 6, box.y + box.height - 80 - i * 2); await page.waitForTimeout(16); }
  await page.mouse.up({ button: 'right' });
  const idle = await page.evaluate(() => ({ fps: window.__mw.simCtl.fps, frameMs: window.__mw.simCtl.frameMs }));
  await page.click('[data-testid="play"]');
  await page.waitForTimeout(5000);
  const r = await page.evaluate(() => {
    const m = window.__mw, r = m.simCtl.runner, v = window.__mwView, st = v.stats();
    const gl = v.renderer.getContext(); const ext = gl.getExtension('WEBGL_debug_renderer_info');
    return {
      simTime: +r.time.toFixed(3), fps: +m.simCtl.fps.toFixed(1), frameMsAvg: +m.simCtl.frameMs.toFixed(2), frameMsRecentMax: +m.simCtl.frameMsMax.toFixed(2),
      stepMsAvg: +r.stepTimeAvgMs.toFixed(4), stepMsMax: +r.stepTimeMaxMs.toFixed(3), realtimeFactor: +m.simCtl.realtimeFactor.toFixed(2), dtMs: r.dt * 1000,
      bodies: r.model.bodies.length, jointEquations: r.sim.mB, maxJointErrorMm: r.sim.stats.maxPosError, triangles: st.triangles, drawCalls: st.calls, parts: st.parts,
      renderer: ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER), canvas: `${v.renderer.domElement.width}x${v.renderer.domElement.height}`, cores: navigator.hardwareConcurrency, ua: navigator.userAgent,
    };
  });
  hw = { renderer: r.renderer, canvas: r.canvas, cores: r.cores, userAgent: r.ua };
  delete r.renderer; delete r.canvas; delete r.cores; delete r.ua;
  rows.push({ project: ex, idleOrbitFps: +idle.fps.toFixed(1), idleFrameMs: +idle.frameMs.toFixed(2), ...r });
  console.log(ex, JSON.stringify(rows.at(-1)));
}
console.log(JSON.stringify(hw));
writeFileSync(`${OUT}/05-performance${process.env.MW_GPU === '1' ? '-gpu' : '-software'}.json`, JSON.stringify({ hardware: hw, rows, errors }, null, 1));
await browser.close();
