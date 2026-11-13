// Render given models at a forced LOD (dev check for broken LOD meshes / materials).
//   node tools/dev/lod-check.mjs out.jpg lod id1 id2 ...
import { chromium } from 'playwright';
import sharp from 'sharp';
const [out, lodS, ...ids] = process.argv.slice(2);
const base = process.env.URL || 'http://127.0.0.1:5173';
const browser = await chromium.launch({ headless: true, channel: 'chromium', args: ['--use-angle=vulkan', '--enable-features=Vulkan', '--enable-gpu', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 400 + 636, height: 400 + 64 } });
await page.goto(`${base}/?project=showcase-lake&capture&quality=medium`);
await page.waitForFunction(() => window.__app && window.__app.ready && window.__app.world && !document.getElementById('progress'), null, { timeout: 300000 });
const box = await page.evaluate((lod) => { const r = document.querySelector('#viewport canvas').getBoundingClientRect(); document.body.classList.add('clean'); const a = window.__app; a.manual = true; const o = a.engine.objects; const orig = o._addModelMeshes.bind(o); o._addModelMeshes = (g, rec, l) => orig(g, rec, Math.min(lod, rec.lods ? rec.lods.length - 1 : lod)); return { x: r.left, y: r.top, width: r.width, height: r.height }; }, +lodS);
const site = await page.evaluate(() => { const a = window.__app; const w = a.world; w.paint.exclude.fill(255); w.deriveGround(); a.engine.vegetation.setWorld?.(w); let best = { s: 1e9 }; for (let i = 0; i < 4000; i++) { const x = ((i * 7919) % 1500) - 750, z = ((i * 104729) % 1500) - 750; if (w.waterDepthAt(x, z) > -0.5) continue; const gi = Math.round(w.hFinal.toGridZ(z)) * w.res + Math.round(w.hFinal.toGridX(x)); if (w.water.shore[gi] > -40) continue; const s = w.hFinal.slope(x, z); if (s < best.s) best = { s, x, z }; } return best; });
const tiles = [];
for (const id of ids) {
  const info = await page.evaluate(async ([id, site]) => {
    const a = window.__app; const w = a.world;
    w.project.objects = [{ id: 'thumb', model: id, x: site.x, z: site.z, rot: 0.6, scale: 1 }];
    await a.engine.objects.sync(w);
    const m = a.manifest.models[id]; const h = m.height, r = Math.max(m.radius, h * 0.5, 0.12); const y = w.heightAt(site.x, site.z); const d = r * 3.1 + 0.25;
    a.cam.setPose({ mode: 'fly', position: [site.x + d * 0.72, y + h * 0.55 + d * 0.34, site.z + d * 0.72], lookAt: [site.x, y + h * 0.48, site.z], fov: 38 });
    a.stepManual(1 / 60, 20);
    return { h, r };
  }, [id, site]);
  console.log(id, info);
  tiles.push(await sharp(await page.screenshot({ clip: box })).resize(400, 400, { fit: 'cover' }).toBuffer());
}
await browser.close();
await sharp({ create: { width: 400 * tiles.length, height: 400, channels: 3, background: '#000' } }).composite(tiles.map((t, i) => ({ input: t, left: i * 400, top: 0 }))).jpeg({ quality: 88 }).toFile(out);
