// Measures frame times and editing latency on this machine and writes docs/PERFORMANCE.md.
//   node tools/perf.mjs [--quality high] [--size 1920x1080]
// Requires the server to be running (URL env, default http://127.0.0.1:5173).
// Frame pacing is uncapped (vsync off) so numbers above 60 fps are visible; frame time is the
// requestAnimationFrame interval while the camera moves, i.e. it includes CPU + GPU + compositor.

import { chromium } from 'playwright';
import { writeFileSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import os from 'node:os';

const args = process.argv.slice(2);
const opt = (n, d) => (args.includes('--' + n) ? args[args.indexOf('--' + n) + 1] : d);
const qualities = opt('quality', 'high,medium').split(',');
const [W, H] = opt('size', '1920x1080').split('x').map(Number);
const base = process.env.URL || 'http://127.0.0.1:5173';

const browser = await chromium.launch({ headless: true, channel: 'chromium', args: ['--use-angle=vulkan', '--enable-features=Vulkan', '--enable-gpu', '--ignore-gpu-blocklist', '--disable-frame-rate-limit', '--disable-gpu-vsync'] });
const rows = [];
const edits = [];
let gpu = '';
let ua = '';

async function open(project, quality) {
  const page = await browser.newPage({ viewport: { width: W + 636, height: H + 64 } });
  const t0 = Date.now();
  await page.goto(`${base}/?project=${project}&quality=${quality}`);
  await page.waitForFunction(() => window.__app && window.__app.ready && window.__app.world && !document.getElementById('progress'), null, { timeout: 300000 });
  const load = (Date.now() - t0) / 1000;
  const info = await page.evaluate(() => ({ gpu: window.__app.engine.gpuName, ua: navigator.userAgent, size: [window.__app.engine.sceneRT.width, window.__app.engine.sceneRT.height], timings: window.__app.loadTimings }));
  gpu = info.gpu;
  ua = info.ua;
  return { page, load, info };
}

// camera moves along a path while frame intervals are recorded
async function measure(page, label, setup, seconds = 6) {
  return page.evaluate(
    async ([setupSrc, secs]) => {
      const app = window.__app;
      const move = new Function('app', 't', setupSrc);
      move(app, 0);
      await new Promise((r) => setTimeout(r, 1500));
      const times = [];
      let last = performance.now();
      const t0 = last;
      await new Promise((resolve) => {
        const tick = () => {
          const now = performance.now();
          times.push(now - last);
          last = now;
          move(app, (now - t0) / 1000);
          if (now - t0 < secs * 1000) requestAnimationFrame(tick);
          else resolve();
        };
        requestAnimationFrame(tick);
      });
      times.shift();
      times.sort((a, b) => a - b);
      const avg = times.reduce((s, v) => s + v, 0) / times.length;
      const st = app.engine.stats;
      return { frames: times.length, avg, p50: times[times.length >> 1], p95: times[Math.floor(times.length * 0.95)], p99: times[Math.floor(times.length * 0.99)], max: times[times.length - 1], fps: 1000 / avg, draws: st.calls, tris: st.triangles, veg: app.engine.vegetation.stats };
    },
    [setup, seconds],
  );
}

const WALK = `
  const c = app.world.project.cameras[0];
  const dx = c.lookAt[0] - c.position[0], dz = c.lookAt[2] - c.position[2];
  const d = Math.hypot(dx, dz);
  const x = c.position[0] + (dx / d) * 1.6 * t, z = c.position[2] + (dz / d) * 1.6 * t;   // walking pace
  app.cam.setPose({ mode: 'fly', position: [x, Math.max(app.world.heightAt(x, z), app.world.waterSurfaceAt(x, z) > -5e4 ? app.world.waterSurfaceAt(x, z) : -1e9) + 1.7, z], yaw: Math.atan2(-dx, -dz) + Math.sin(t * 0.9) * 0.5, pitch: -0.05 + Math.sin(t * 0.6) * 0.1 });
`;
const FLY = `
  const c = app.world.project.cameras[1];
  const a = t * 0.25;
  const tx = c.lookAt[0], tz = c.lookAt[2];
  const r = Math.hypot(c.position[0] - tx, c.position[2] - tz);
  const a0 = Math.atan2(c.position[2] - tz, c.position[0] - tx);
  app.cam.setPose({ mode: 'fly', position: [tx + Math.cos(a0 + a) * r, c.position[1], tz + Math.sin(a0 + a) * r], lookAt: c.lookAt });
`;

for (const quality of qualities) {
  for (const project of ['showcase-valley', 'showcase-lake', 'showcase-coast']) {
    const { page, load, info } = await open(project, quality);
    const walk = await measure(page, 'walk', WALK);
    const fly = await measure(page, 'fly', FLY);
    rows.push({ project, quality, size: info.size, load, timings: info.timings, walk, fly });
    console.log(project, quality, 'load', load.toFixed(1), 's | eye-level', walk.fps.toFixed(1), 'fps (p95', walk.p95.toFixed(1), 'ms) | aerial', fly.fps.toFixed(1), 'fps (p95', fly.p95.toFixed(1), 'ms)');
    if (quality === qualities[0]) {
      // editing latency (same code paths as the tools)
      const e = await page.evaluate(async (proj) => {
        const app = window.__app;
        const w = app.world;
        const out = { project: proj };
        const time = (fn) => {
          const t = performance.now();
          fn();
          return performance.now() - t;
        };
        const c = app.world.project.cameras[0].position;
        const t = app.tools;
        Object.assign(t.brush, { kind: 'raise', radius: 20, strength: 0.6 });
        t.active = 'sculpt';
        t.beginStroke({ x: c[0] + 30, z: c[2] + 30, y: 0 }, {});
        const dabs = [];
        for (let i = 0; i < 30; i++) {
          t.stroke.pos = { x: c[0] + 30 + i, z: c[2] + 30, y: 0 };
          dabs.push(time(() => t.applyStroke(1 / 60)));
        }
        dabs.sort((a, b) => a - b);
        out.sculptDabMedian = dabs[15];
        out.sculptDabMax = dabs[29];
        out.sculptCommit = time(() => t.endStroke());
        out.sculptUndo = time(() => app.undo());
        t.active = 'select';
        if (w.project.water.rivers[0]) {
          out.riverMove = time(() => app.edit('perf', (d) => { const n = d.water.rivers[0].nodes; n[n.length >> 1].x += 12; }, 'modifiers'));
          out.riverUndo = time(() => app.undo());
        }
        if (w.project.water.lakes[0]) {
          out.lakeLevel = time(() => app.edit('perf', (d) => (d.water.lakes[0].level += 0.5), 'water'));
          app.undo();
          out.lakeLevelLive = time(() => app.edit('perf', (d) => (d.water.lakes[0].level += 0.5), 'water', { live: true }));
          app.edit('perf', (d) => (d.water.lakes[0].level -= 0.5), 'water');
        }
        if (w.project.water.sea.enabled) {
          out.seaLevel = time(() => app.edit('perf', (d) => (d.water.sea.level += 0.5), 'water'));
          app.undo();
        }
        out.timeOfDay = time(() => app.edit('perf', (d) => (d.env.timeOfDay += 1), 'env'));
        app.undo();
        out.biomeRule = time(() => app.edit('perf', (d) => (d.biomes[0].layers[0].density *= 0.9), 'ground'));
        app.undo();
        out.deriveAll = time(() => w.deriveAll());
        return out;
      }, project);
      edits.push(e);
      console.log('  edit latency ms', JSON.stringify(Object.fromEntries(Object.entries(e).filter(([k]) => k !== 'project').map(([k, v]) => [k, +v.toFixed(1)]))));
    }
    await page.close();
  }
}
await browser.close();

let cpu = os.cpus()[0].model;
let mesa = '';
try {
  mesa = execFileSync('sh', ['-c', "glxinfo -B 2>/dev/null | grep -E 'Version:|Device:' | head -2 | tr '\\n' ' '"]).toString().trim();
} catch {
  /* optional */
}
const f1 = (v) => (v === undefined ? '—' : v.toFixed(1));
let md = `# Measured performance\n\nAll numbers below were **measured** by \`tools/perf.mjs\` on ${new Date().toISOString().slice(0, 10)}; nothing is estimated.\n\n## Machine\n\n- CPU: ${cpu} (${os.cpus().length} threads), RAM ${(os.totalmem() / 2 ** 30).toFixed(0)} GiB, ${os.type()} ${os.release()}\n- GPU / driver as reported by WebGL: ${gpu}\n- ${mesa}\n- Browser: ${ua.replace(/Mozilla\/5.0 /, '')} (Playwright Chromium, headless, ANGLE → Vulkan, vsync disabled for the measurement)\n- Viewport (render target): ${W}×${H}, MSAA as per quality preset\n\n## Frame time while navigating\n\n"eye level" walks forward at 1.6 m/s from the project's opening view while looking around; "aerial" orbits the project's aerial camera. 6 s each after 1.5 s warm-up. Frame time = interval between animation frames (CPU + GPU + compositor).\n\n| project | quality | view | avg fps | avg ms | p50 ms | p95 ms | p99 ms | max ms | draw calls | triangles / frame (all passes) | scatter instances | impostors |\n|---|---|---|---|---|---|---|---|---|---|---|---|---|\n`;
for (const r of rows) {
  for (const [name, m] of [['eye level', r.walk], ['aerial', r.fly]]) {
    md += `| ${r.project} | ${r.quality} | ${name} | ${f1(m.fps)} | ${f1(m.avg)} | ${f1(m.p50)} | ${f1(m.p95)} | ${f1(m.p99)} | ${f1(m.max)} | ${m.draws} | ${(m.tris / 1e6).toFixed(1)} M | ${m.veg.instances} | ${m.veg.impostors} |\n`;
  }
}
md += `\n## Load time\n\nTime from navigation to the first interactive frame of a showcase (2049² terrain), including deriving water, materials and scatter, baking normals / AO, decoding models and textures.\n\n| project | quality | total s | derive ms | terrain upload + bake ms | ground textures ms | models ms |\n|---|---|---|---|---|---|---|\n`;
for (const r of rows) md += `| ${r.project} | ${r.quality} | ${f1(r.load)} | ${r.timings.derive} | ${r.timings.terrain} | ${r.timings.materials} | ${r.timings.vegetation} |\n`;
md += `\n## Editing latency (${qualities[0]} quality)\n\nWall-clock time of the synchronous update triggered by an edit, on the main thread (ms).\n\n| project | sculpt dab (median / max) | stroke commit | undo stroke | move river point | undo | lake level (commit / live) | sea level | time of day | biome rule | regenerate all |\n|---|---|---|---|---|---|---|---|---|---|---|\n`;
for (const e of edits) md += `| ${e.project} | ${f1(e.sculptDabMedian)} / ${f1(e.sculptDabMax)} | ${f1(e.sculptCommit)} | ${f1(e.sculptUndo)} | ${f1(e.riverMove)} | ${f1(e.riverUndo)} | ${f1(e.lakeLevel)} / ${f1(e.lakeLevelLive)} | ${f1(e.seaLevel)} | ${f1(e.timeOfDay)} | ${f1(e.biomeRule)} | ${f1(e.deriveAll)} |\n`;
md += `\nNotes\n\n- Brush dabs run every frame while the mouse is down (fast path: re-carve + ground weights + texture upload for the touched rectangle); the commit on mouse-up re-solves water if the stroke can affect it and regenerates scatter in the region.\n- Whole-map operations (lake / sea level, biome rules, regenerate all) are synchronous and block the UI for the time shown; terrain generation and erosion run in a worker with progress and cancel.\n- Known weak spots visible in these numbers: (1) walking at eye level through dense vegetation (the valley) has frame-time spikes (see p95 / max) when near-camera ground-cover cells are generated and uploaded on the main thread; the medium preset does not help there because the stall is CPU-side. (2) Committing a stroke or a path edit that can affect water re-solves the whole water field (flood fill, river flow solve, exact distance transforms, swell) and regenerates scatter, which takes seconds on a 2049² terrain; only the per-dab brush feedback is interactive. Neither has been optimised further.\n- Headless Chromium was used so the measurement is reproducible from the command line; a visible browser window on the same machine may differ slightly.\n`;
mkdirSync('docs', { recursive: true });
writeFileSync('docs/PERFORMANCE.md', md);
writeFileSync('docs/performance.json', JSON.stringify({ date: new Date().toISOString(), gpu, cpu, ua, viewport: [W, H], rows, edits }, null, 1));
console.log('wrote docs/PERFORMANCE.md');
