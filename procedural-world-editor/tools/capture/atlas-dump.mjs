// Dev: dump impostor atlases of given models to PNG files.
import { chromium } from 'playwright';
import { writeFileSync } from 'node:fs';
const [project, ...ids] = process.argv.slice(2);
const browser = await chromium.launch({ headless: true, channel: 'chromium', args: ['--use-angle=vulkan', '--enable-features=Vulkan', '--enable-gpu', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
await page.goto(`http://127.0.0.1:5173/?project=${project}&capture`);
await page.waitForFunction(() => window.__app && window.__app.ready && window.__app.world && !document.getElementById('progress'), null, { timeout: 240000 });
for (const id of ids) {
  const url = await page.evaluate(async (id) => {
    const app = window.__app; const lib = app.engine.library;
    const rec = await lib.load(id); const imp = lib.bakeImpostor(rec); const rt = imp.rt;
    const out = [];
    for (let t = 0; t < 2; t++) {
      const buf = new Uint8Array(rt.width * rt.height * 4);
      app.engine.renderer.readRenderTargetPixels(rt, 0, 0, rt.width, rt.height, buf, undefined, t);
      const c = document.createElement('canvas'); c.width = rt.width; c.height = rt.height;
      const ctx = c.getContext('2d'); const im = ctx.createImageData(rt.width, rt.height);
      for (let y = 0; y < rt.height; y++) for (let x = 0; x < rt.width; x++) { const s = ((rt.height - 1 - y) * rt.width + x) * 4, d = (y * rt.width + x) * 4; const a = buf[s + 3] / 255; im.data[d] = buf[s] * (t ? 1 : 1) + (1 - a) * 255 * (t ? 0 : 1) * 0 + (t ? 0 : (1 - a) * 200); im.data[d + 1] = buf[s + 1] + (t ? 0 : (1 - a) * 60); im.data[d + 2] = buf[s + 2] + (t ? 0 : (1 - a) * 200); im.data[d + 3] = 255; }
      ctx.putImageData(im, 0, 0); out.push(c.toDataURL('image/png'));
    }
    return out;
  }, id);
  url.forEach((u, t) => writeFileSync(`.cache/dev/atlas-${id}-${t}.png`, Buffer.from(u.split(',')[1], 'base64')));
  console.log('dumped', id);
}
await browser.close();
