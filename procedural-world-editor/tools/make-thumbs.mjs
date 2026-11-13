// Renders asset-browser thumbnails (public/assets/thumbs/<id>.jpg) for every model in the manifest
// with the editor's own model library and lighting. Requires the server to be running.
//   node tools/make-thumbs.mjs
import { chromium } from 'playwright';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import sharp from 'sharp';
const base = process.env.URL || 'http://127.0.0.1:5173';
const manifest = JSON.parse(readFileSync('public/assets/manifest.json', 'utf8'));
mkdirSync('public/assets/thumbs', { recursive: true });
const browser = await chromium.launch({ headless: true, channel: 'chromium', args: ['--use-angle=vulkan', '--enable-features=Vulkan', '--enable-gpu', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 520 + 636, height: 520 + 160 } }); // roomy window: the canvas must be fully visible to be captured whole
await page.goto(`${base}/?project=showcase-lake&capture&quality=medium`);
await page.waitForFunction(() => window.__app && window.__app.ready && window.__app.world && !document.getElementById('progress'), null, { timeout: 300000 });
const box = await page.evaluate(() => { const r = document.querySelector('#viewport canvas').getBoundingClientRect(); document.body.classList.add('clean'); window.__app.manual = true; return { x: r.left, y: r.top, width: r.width, height: r.height }; });
// a flat meadow spot far from trees, objects placed one at a time
const site = await page.evaluate(() => {
  const a = window.__app; const w = a.world;
  a.edit('thumb env', (d) => { d.env.timeOfDay = 11; d.env.cloudCover = 0.15; d.env.fogDensity = 0; }, 'env');
  w.paint.exclude.fill(255); w.deriveGround();
  let best = { s: 1e9 };
  for (let i = 0; i < 4000; i++) { const x = ((i * 7919) % 1500) - 750, z = ((i * 104729) % 1500) - 750; if (w.waterDepthAt(x, z) > -0.5) continue; const gi = Math.round(w.hFinal.toGridZ(z)) * w.res + Math.round(w.hFinal.toGridX(x)); if (w.water.shore[gi] > -40) continue; const s = w.hFinal.slope(x, z); if (s < best.s) best = { s, x, z }; }
  return best;
});
let n = 0;
for (const [id, m] of Object.entries(manifest.models)) {
  await page.evaluate(async ([id, site]) => {
    const a = window.__app; const w = a.world;
    w.project.objects = [{ id: 'thumb', model: id, x: site.x, z: site.z, rot: 0.6, scale: 1 }];
    await a.engine.objects.sync(w);
    const m = a.manifest.models[id];
    const h = m.height, r = Math.max(m.radius, h * 0.5, 0.12);
    const y = w.heightAt(site.x, site.z);
    const d = r * 3.1 + 0.25;
    a.cam.setPose({ mode: 'fly', position: [site.x + d * 0.72, y + h * 0.55 + d * 0.34, site.z + d * 0.72], lookAt: [site.x, y + h * 0.48, site.z], fov: 38 });
    a.engine.camera.near = Math.min(0.05, d * 0.1); a.engine.camera.updateProjectionMatrix();
    a.stepManual(1 / 60, 20);
  }, [id, site]);
  const png = await page.screenshot({ clip: box });
  writeFileSync(`public/assets/thumbs/${id}.jpg`, await sharp(png).resize(160, 160, { fit: 'cover' }).jpeg({ quality: 82 }).toBuffer());
  n++;
}
// procedural plants
for (const id of ['proc_reed', 'proc_cattail']) {
  try {
    await page.evaluate(async ([id, site]) => { const a = window.__app; const w = a.world; w.project.objects = [{ id: 'thumb', model: id, x: site.x, z: site.z, rot: 0.6, scale: 1 }]; await a.engine.objects.sync(w); const y = w.heightAt(site.x, site.z); a.cam.setPose({ mode: 'fly', position: [site.x + 2.6, y + 2.0, site.z + 2.6], lookAt: [site.x, y + 1.1, site.z], fov: 38 }); a.stepManual(1 / 60, 20); }, [id, site]);
    writeFileSync(`public/assets/thumbs/${id}.jpg`, await sharp(await page.screenshot({ clip: box })).resize(160, 160, { fit: 'cover' }).jpeg({ quality: 82 }).toBuffer());
    n++;
  } catch (e) { console.warn('skip', id, e.message.split('\n')[0]); }
}
await browser.close();
console.log('wrote', n, 'thumbnails');
