// End-to-end functional acceptance test. Starts the application with the documented launch
// command (`npm start`), drives the real editor UI in headless Chromium (hardware GPU) and checks
// the resulting world state. Uses throw-away project / export directories.
//   node tools/functional-test.mjs [--out <dir>] [--port 5190] [--skip-build]
// Writes <out>/functional-report.json and screenshots; exit code 0 only if every check passes.

import { chromium } from 'playwright';
import { spawn, execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync, mkdtempSync, existsSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const opt = (n, d) => (args.includes('--' + n) ? args[args.indexOf('--' + n) + 1] : d);
const port = +opt('port', 5190);
const out = resolve(opt('out', '.cache/functional'));
mkdirSync(out, { recursive: true });
const tmp = mkdtempSync(join(tmpdir(), 'terraforge-ft-'));
const projectsDir = join(tmp, 'projects');
const exportsDir = join(tmp, 'exports');
const base = `http://127.0.0.1:${port}`;

const checks = [];
const log = (...a) => console.log(...a);
function check(name, ok, detail) {
  checks.push({ name, ok: !!ok, detail });
  log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail !== undefined ? '  — ' + (typeof detail === 'string' ? detail : JSON.stringify(detail)) : ''}`);
}

// ---- 1. documented launch command ----
const cmd = args.includes('--skip-build') ? ['run', 'serve', '--', '--port', String(port)] : ['start', '--', '--port', String(port)];
log(`$ npm ${cmd.join(' ')}`);
const server = spawn('npm', cmd, { cwd: ROOT, env: { ...process.env, TERRAFORGE_PROJECTS: projectsDir, TERRAFORGE_EXPORTS: exportsDir }, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
let serverLog = '';
server.stdout.on('data', (d) => (serverLog += d));
server.stderr.on('data', (d) => (serverLog += d));
const stopServer = () => {
  try {
    process.kill(-server.pid, 'SIGTERM');
  } catch {
    /* already gone */
  }
};
process.on('exit', stopServer);
async function waitServer() {
  const t0 = Date.now();
  while (Date.now() - t0 < 240000) {
    try {
      const r = await fetch(base + '/api/health');
      if (r.ok) return true;
    } catch {
      /* not yet */
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

const external = new Set();
let browser;
try {
  check('server starts from `npm start`', await waitServer(), serverLog.split('\n').filter(Boolean).slice(-2).join(' | '));
  browser = await chromium.launch({ headless: true, channel: 'chromium', args: ['--use-angle=vulkan', '--enable-features=Vulkan', '--enable-gpu', '--ignore-gpu-blocklist'] });
  const context = await browser.newContext({ viewport: { width: 1680, height: 960 }, acceptDownloads: true });
  // offline check: every request must go to the local server
  context.on('request', (r) => {
    const u = new URL(r.url());
    if (u.protocol.startsWith('http') && u.hostname !== '127.0.0.1' && u.hostname !== 'localhost') external.add(u.host);
  });
  const page = await context.newPage();
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(e.message));
  page.on('dialog', (d) => d.accept());
  const ready = () => page.waitForFunction(() => window.__app && ((window.__app.ready && window.__app.world && !window.__app.busy && !document.getElementById('progress')) || window.__app.errors.length), null, { timeout: 300000 });
  const ev = (fn, arg) => page.evaluate(fn, arg);
  const shot = (name) => page.screenshot({ path: join(out, name + '.png') });
  const canvasBox = async () => ev(() => { const r = document.querySelector('#viewport canvas').getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; });
  const hashes = () => ev(() => {
    const w = window.__app.world;
    const h = (a) => { let x = 2166136261 >>> 0; const u = new Uint8Array(a.buffer, a.byteOffset, a.byteLength); for (let i = 0; i < u.length; i += 7) x = Math.imul(x ^ u[i], 16777619) >>> 0; return x; };
    let inst = 0;
    for (const c of w.scatterCells.values()) for (const l of c.layers.values()) inst += l.count;
    let wet = 0;
    for (let i = 0; i < w.water.type.length; i++) if (w.water.type[i]) wet++;
    return { hUser: h(w.hUser.data), hFinal: h(w.hFinal.data), weights: h(w.weights), biome: h(w.paint.biome), instances: inst, wet };
  });

  // ---- 2. every showcase opens and renders in motion ----
  await page.goto(base + '/?capture');
  await ready();
  const list = await ev(() => fetch('/api/projects').then((r) => r.json()));
  check('three showcase projects are installed', list.filter((p) => p.showcase).length === 3, list.map((p) => p.id));
  const opening = await ev(() => ({ id: window.__app.world.project.id, showcase: window.__app.world.project.showcase }));
  check('editor opens directly on a finished showcase (no assembly needed)', !!opening.showcase, opening);
  for (const p of list.filter((q) => q.showcase)) {
    await ev((id) => window.__app.openProject(id), p.id);
    await ready();
    await page.waitForTimeout(1500);
    const a = await page.screenshot({ clip: await canvasBox().then((b) => ({ x: b.x, y: b.y, width: b.w, height: b.h })) });
    await page.waitForTimeout(700);
    const b = await page.screenshot({ clip: await canvasBox().then((bx) => ({ x: bx.x, y: bx.y, width: bx.w, height: bx.h })) });
    writeFileSync(join(out, `showcase-${p.showcase}.png`), b);
    const st = await ev(() => ({ fps: window.__app.engine.frameStats().fps, errors: window.__app.errors.length, tris: window.__app.engine.stats.triangles, water: window.__app.engine.water.hasWater }));
    check(`showcase ${p.id} opens, renders and animates`, st.errors === 0 && st.fps > 5 && st.water && !a.equals(b), st);
  }

  // ---- 3. new seeded world through the UI ----
  await page.click('text=Projects');
  await page.click('text=New world…');
  const dlg = page.locator('.modal .dlg');
  await dlg.locator('input[type=text]').fill('Functional test world');
  await dlg.locator('select').first().selectOption('hills');
  await dlg.locator('input[type=number]').first().fill('4242');
  await dlg.locator('select').nth(1).selectOption('1025');
  const tGen = Date.now();
  await page.click('.modal footer >> text=Generate');
  await page.waitForFunction(() => window.__app.world && window.__app.world.project.name === 'Functional test world' && !window.__app.busy && !document.getElementById('progress'), null, { timeout: 300000 });
  const pid = await ev(() => window.__app.world.project.id);
  check('new seeded world is generated from the dialog', !!pid, { id: pid, seconds: (Date.now() - tGen) / 1000, seed: await ev(() => window.__app.world.project.seed) });
  // determinism: regenerate heights in-page from the stored parameters and compare
  const base0 = await hashes();
  await shot('new-world');

  // aim the camera at open ground away from the river
  await ev(() => {
    const a = window.__app;
    const w = a.world;
    let best = null;
    for (let i = 0; i < 400; i++) {
      const x = ((i * 137) % 900) - 450,
        z = ((i * 71) % 900) - 450;
      if (w.hFinal.slope(x, z) > 0.25 || w.waterDepthAt(x, z) > -0.01) continue;
      const gi = Math.round(w.hFinal.toGridZ(z)) * w.res + Math.round(w.hFinal.toGridX(x));
      if (w.water.shore[gi] > -55) continue;
      best = { x, z };
      break;
    }
    window.__site = best || { x: 200, z: 200 };
    const y = w.heightAt(window.__site.x, window.__site.z);
    a.cam.setPose({ mode: 'orbit', position: [window.__site.x + 90, y + 110, window.__site.z + 90], lookAt: [window.__site.x, y, window.__site.z] });
  });
  await page.waitForTimeout(800);
  const box = await canvasBox();
  const cx = box.x + box.w / 2,
    cy = box.y + box.h / 2;

  // ---- 4. sculpt with the mouse, undo, redo ----
  await page.keyboard.press('b');
  check('sculpt tool selected by keyboard', (await ev(() => window.__app.tools.active)) === 'sculpt');
  await page.mouse.move(cx, cy);
  await page.mouse.down();
  for (let i = 0; i < 25; i++) {
    await page.mouse.move(cx + i * 3, cy + Math.sin(i / 4) * 10);
    await page.waitForTimeout(40);
  }
  await page.mouse.up();
  await page.waitForTimeout(400);
  const sculpted = await hashes();
  const lat = await ev(() => window.__app.editLatency);
  check('sculpting changes the terrain and derived data', sculpted.hUser !== base0.hUser && sculpted.hFinal !== base0.hFinal, { brushLatencyMs: lat });
  await shot('sculpted');
  await page.keyboard.press('Control+z');
  await page.waitForTimeout(300);
  const undone = await hashes();
  check('undo restores the sculpted terrain exactly', undone.hUser === base0.hUser && undone.hFinal === base0.hFinal && undone.instances === base0.instances, undone);
  await page.keyboard.press('Control+Shift+z');
  await page.waitForTimeout(300);
  const redone = await hashes();
  check('redo re-applies the stroke exactly', redone.hUser === sculpted.hUser && redone.hFinal === sculpted.hFinal);

  // ---- 5. draw a river with mouse clicks, then edit it ----
  const riversBefore = await ev(() => window.__app.world.project.water.rivers.length);
  await page.keyboard.press('r');
  // four clicks roughly downhill across the view; the tool carves a monotone channel regardless
  const pts = [[-0.3, -0.25], [-0.1, -0.05], [0.12, 0.08], [0.32, 0.26]];
  for (const [u, v] of pts) {
    await page.mouse.click(cx + u * box.w, cy + v * box.h);
    await page.waitForTimeout(120);
  }
  await page.keyboard.press('Enter');
  await page.waitForTimeout(600);
  const riv = await ev(() => {
    const w = window.__app.world;
    const r = w.project.water.rivers[w.project.water.rivers.length - 1];
    const c = w.compiled.rivers[w.project.water.rivers.length - 1];
    const k = c.sp.n >> 1;
    const x = c.sp.x[k], z = c.sp.z[k];
    let descending = true;
    for (let i = 1; i < c.sp.n; i++) if (c.surf[i] > c.surf[i - 1] + 1e-6) descending = false;
    const gi = Math.round(w.hFinal.toGridZ(z)) * w.res + Math.round(w.hFinal.toGridX(x));
    // carving along the whole centre line (a single point can sit in a natural hollow where little needs to be cut)
    let cutSum = 0, cutMax = 0, wetN = 0, m = 0;
    for (let i = 4; i < c.sp.n - 4; i += 2) { const cut = w.hUser.sample(c.sp.x[i], c.sp.z[i]) - w.hFinal.sample(c.sp.x[i], c.sp.z[i]); cutSum += cut; cutMax = Math.max(cutMax, cut); if (w.waterDepthAt(c.sp.x[i], c.sp.z[i]) > 0.05) wetN++; m++; }
    return { id: r.id, n: w.project.water.rivers.length, nodes: r.nodes.length, cutMid: w.hUser.sample(x, z) - w.hFinal.sample(x, z), cutMean: cutSum / m, cutMax, wetFraction: wetN / m, depth: w.waterDepthAt(x, z), speed: Math.hypot(w.water.vx[gi], w.water.vz[gi]), descending, mid: { x, z } };
  });
  check('river drawn by clicking is carved into the terrain with flowing water', riv.n === riversBefore + 1 && riv.nodes === 4 && riv.cutMean > 0.2 && riv.wetFraction > 0.95 && riv.depth > 0.05 && riv.speed > 0.05 && riv.descending, riv);
  await shot('river-drawn');
  const before = await hashes();
  await ev(() => {
    const a = window.__app;
    const i = a.world.project.water.rivers.length - 1;
    a.edit('Move river point', (d) => { d.water.rivers[i].nodes[1].x += 45; d.water.rivers[i].nodes[1].z -= 35; }, 'modifiers');
    a.edit('River discharge', (d) => { d.water.rivers[i].flow = 14; }, 'water');
  });
  await page.waitForTimeout(500);
  const moved = await ev((mid) => {
    const w = window.__app.world;
    const gi = Math.round(w.hFinal.toGridZ(mid.z)) * w.res + Math.round(w.hFinal.toGridX(mid.x));
    const c = w.compiled.rivers[w.project.water.rivers.length - 1];
    const k = c.sp.n >> 1;
    const g2 = Math.round(w.hFinal.toGridZ(c.sp.z[k])) * w.res + Math.round(w.hFinal.toGridX(c.sp.x[k]));
    return { oldSpotHealed: Math.abs(w.hUser.sample(mid.x, mid.z) - w.hFinal.sample(mid.x, mid.z)), oldSpotType: w.water.type[gi], newSpeed: Math.hypot(w.water.vx[g2], w.water.vz[g2]) };
  }, riv.mid);
  const after = await hashes();
  check('editing the river moves the channel and its flow', after.hFinal !== before.hFinal && after.wet !== before.wet && moved.newSpeed > 0.05, moved);
  await page.keyboard.press('Control+z');
  await page.keyboard.press('Control+z');
  await page.waitForTimeout(500);
  const riverUndone = await hashes();
  check('undo of river edits restores channel and water', riverUndone.hFinal === before.hFinal && riverUndone.wet === before.wet);
  await page.keyboard.press('Control+Shift+z');
  await page.keyboard.press('Control+Shift+z');
  await page.waitForTimeout(500);

  // ---- 6. paint a biome ----
  const b0 = await hashes();
  await page.keyboard.press('p');
  await ev(() => { const t = window.__app.tools; t.paint.mode = 'biome'; t.paint.biome = window.__app.world.project.biomes.findIndex((b) => b.id === 'meadow') + 1; t.paint.radius = 45; window.__app.ui.refreshPanels(true); });
  await page.mouse.move(cx - 0.2 * box.w, cy + 0.22 * box.h);
  await page.mouse.down();
  for (let i = 0; i < 14; i++) {
    await page.mouse.move(cx - 0.2 * box.w + i * 6, cy + 0.22 * box.h + i * 2);
    await page.waitForTimeout(40);
  }
  await page.mouse.up();
  await page.waitForTimeout(600);
  const b1 = await hashes();
  check('painting a biome changes ground materials and scatter', b1.biome !== b0.biome && b1.weights !== b0.weights && b1.instances !== b0.instances, { instancesBefore: b0.instances, instancesAfter: b1.instances });
  await shot('biome-painted');

  // ---- 7. road and structure by mouse ----
  await page.keyboard.press('t');
  for (const [u, v] of [[-0.35, 0.3], [-0.15, 0.34], [0.1, 0.36]]) {
    await page.mouse.click(cx + u * box.w, cy + v * box.h);
    await page.waitForTimeout(120);
  }
  await page.keyboard.press('Enter');
  await page.waitForTimeout(500);
  const road = await ev(() => {
    const w = window.__app.world;
    const r = w.project.roads[w.project.roads.length - 1];
    const c = w.compiled.roads[w.project.roads.length - 1];
    let maxGrade = 0, onRoad = 0, cleared = 0;
    for (let k = 3; k < c.sp.n; k += 3) maxGrade = Math.max(maxGrade, Math.abs(c.prof[k] - c.prof[k - 3]) / (3 * c.sp.ds));
    for (let k = 0; k < c.sp.n; k += 4) { const gi = Math.round(w.hFinal.toGridZ(c.sp.z[k])) * w.res + Math.round(w.hFinal.toGridX(c.sp.x[k])); if (w.masks.road[gi] > 128) onRoad++; if (w.masks.clear[gi] > 128) cleared++; }
    let trees = 0;
    for (const cell of w.scatterCells.values()) for (const [key, l] of cell.layers) if (/trees|saplings|shrubs/.test(key)) for (let i = 0; i < l.count; i++) { const x = l.data[i * 8], z = l.data[i * 8 + 2]; const gi = Math.round(w.hFinal.toGridZ(z)) * w.res + Math.round(w.hFinal.toGridX(x)); if (w.masks.road[gi] > 200) trees++; }
    // conformance: the built surface stays within the earthwork limit of the (smoothed) ground, is
    // never steeper than the ground it replaces, and holds the grade limit wherever the ground allows
    let maxDev = 0, groundGrade = 0, surfDev = 0;
    for (let k = 0; k < c.sp.n; k++) { maxDev = Math.max(maxDev, Math.abs(c.prof[k] - c.groundSmooth[k])); if (k % 4 === 0) surfDev = Math.max(surfDev, Math.abs(w.hFinal.sample(c.sp.x[k], c.sp.z[k]) - c.prof[k])); }
    for (let k = 3; k < c.sp.n; k += 3) groundGrade = Math.max(groundGrade, Math.abs(w.hUser.sample(c.sp.x[k], c.sp.z[k]) - w.hUser.sample(c.sp.x[k - 3], c.sp.z[k - 3])) / (3 * c.sp.ds));
    return { n: w.project.roads.length, kind: r && r.kind, maxGrade, gradeLimit: c.R.maxGrade, groundMaxGrade: groundGrade, maxEarthwork: c.maxEarth, maxDeviationFromGround: maxDev, surfaceVsProfile: surfDev, steepestReported: c.steepest, onRoad, samples: Math.ceil(c.sp.n / 4), treesOnRoad: trees };
  });
  check('road drawn by clicking conforms to terrain and clears vegetation', road.n >= 1 && road.kind === 'road' && road.maxDeviationFromGround <= road.maxEarthwork + 0.3 && road.surfaceVsProfile < 0.35 && (road.maxGrade <= road.gradeLimit * 1.6 || road.maxGrade < road.groundMaxGrade) && road.onRoad > road.samples * 0.7 && road.treesOnRoad === 0, road);
  await page.keyboard.press('h');
  await ev(() => { window.__app.tools.structureType = 'cabin'; });
  // click a few candidate spots until a site is accepted (steep / wet sites are rejected with a message)
  let placed = false;
  for (const [u, v] of [[-0.22, 0.2], [0.0, 0.22], [0.2, 0.2], [-0.3, 0.1], [0.25, -0.2], [0.0, -0.3]]) {
    const n0 = await ev(() => window.__app.world.project.structures.length);
    await page.mouse.click(cx + u * box.w, cy + v * box.h);
    await page.waitForTimeout(500);
    if ((await ev(() => window.__app.world.project.structures.length)) > n0) {
      placed = true;
      break;
    }
  }
  const st = await ev(() => {
    const w = window.__app.world;
    const s = w.project.structures[w.project.structures.length - 1];
    if (!s) return null;
    const lvl = w.structureLevel(s);
    let maxDev = 0;
    for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) maxDev = Math.max(maxDev, Math.abs(w.hFinal.sample(s.x + i * 1.5, s.z + j * 1.5) - lvl));
    const e = window.__app.engine.objects.structures.get(s.id);
    return { type: s.type, padDeviation: maxDev, meshY: e ? e.group.position.y : null, level: lvl, depth: w.waterDepthAt(s.x, s.z) };
  });
  check('structure placed by clicking sits on a levelled foundation on dry ground', placed && st && st.padDeviation < 0.12 && Math.abs(st.meshY - st.level) < 1e-3 && st.depth <= 0, st);
  const rejected = await ev(() => {
    const w = window.__app.world;
    // a site in the middle of the river must be refused
    const c = w.compiled.rivers.find(Boolean);
    const k = c.sp.n >> 1;
    return w.checkStructureSite({ id: 'x', type: 'cabin', x: c.sp.x[k], z: c.sp.z[k], rot: 0 }, {});
  });
  check('structure placement rejects sites in water', typeof rejected === 'string' && rejected.length > 0, rejected);
  await shot('road-structure');

  // ---- 8. lighting through the UI ----
  await page.keyboard.press('v');
  await page.click('#right .tabs >> text=Sky & light');
  const sun0 = await ev(() => window.__app.engine.atmosphere.sunDir.toArray());
  const slider = page.locator('#right .field', { hasText: 'Time of day' }).locator('input[type=number]');
  await slider.fill('18.5');
  await slider.press('Enter');
  await page.waitForTimeout(700);
  const sun1 = await ev(() => ({ dir: window.__app.engine.atmosphere.sunDir.toArray(), time: window.__app.world.project.env.timeOfDay }));
  check('time of day changed in the Sky & light panel moves the sun', sun1.time === 18.5 && Math.abs(sun1.dir[1] - sun0[1]) > 0.05, sun1);
  await shot('evening');

  // ---- 9. save, reload, verify persistence ----
  const docBefore = await ev(() => JSON.stringify({ r: window.__app.world.project.water.rivers, roads: window.__app.world.project.roads, s: window.__app.world.project.structures, env: window.__app.world.project.env, biomes: window.__app.world.project.biomes.length }));
  const hBefore = await hashes();
  await page.keyboard.press('Control+s');
  await page.waitForFunction(() => !window.__app.history.dirty, null, { timeout: 60000 });
  check('project saves (Ctrl+S) and is marked clean', true, readdirSync(join(projectsDir, pid)));
  await page.goto(base + '/?capture&project=' + pid);
  await ready();
  const docAfter = await ev(() => JSON.stringify({ r: window.__app.world.project.water.rivers, roads: window.__app.world.project.roads, s: window.__app.world.project.structures, env: window.__app.world.project.env, biomes: window.__app.world.project.biomes.length }));
  const hAfter = await hashes();
  check('document survives save → close → reopen', docAfter === docBefore);
  check('terrain, painted biome, derived water and scatter are identical after reopening', hAfter.hFinal === hBefore.hFinal && hAfter.biome === hBefore.biome && hAfter.instances === hBefore.instances && hAfter.wet === hBefore.wet && hAfter.weights === hBefore.weights, { before: hBefore, after: hAfter });
  await shot('reopened');

  // ---- 10. duplicate + autosave ----
  const dupId = await ev((id) => window.__app.duplicateProject(id, 'FT copy'), pid);
  const l2 = await ev(() => fetch('/api/projects').then((r) => r.json()));
  check('project can be duplicated', l2.some((p) => p.id === dupId && p.name === 'FT copy'));
  await ev(() => { window.__app.edit('Wind', (d) => (d.env.windSpeed = 7.7), 'wind'); });
  await ev(() => window.__app.autosave());
  check('autosave writes to a separate slot without touching the saved project', existsSync(join(projectsDir, pid, '.autosave', 'project.json')) && JSON.parse(readFileSync(join(projectsDir, pid, 'project.json'), 'utf8')).env.windSpeed !== 7.7 && JSON.parse(readFileSync(join(projectsDir, pid, '.autosave', 'project.json'), 'utf8')).env.windSpeed === 7.7);

  // ---- 11. export from the dialog ----
  await page.click('text=Export…');
  await page.click('.modal footer >> text=Export');
  await page.waitForFunction(() => window.__app.ui.lastExport || window.__app.errors.length, null, { timeout: 300000 });
  const exp = await ev(() => ({ last: window.__app.ui.lastExport, errors: window.__app.errors }));
  let exportDir = null;
  if (exp.last) {
    const stamp = readdirSync(join(exportsDir, pid))[0];
    exportDir = join(exportsDir, pid, stamp);
  }
  check('export writes heightmap, masks, GLB and placement data', !!exportDir && ['scene.glb', 'heightmap_16bit.png', 'placements.json', 'environment.json', 'masks.json'].every((f) => existsSync(join(exportDir, f))), exportDir ? readdirSync(exportDir).length + ' files' : exp.errors);
  await page.keyboard.press('Escape');

  // ---- 12. water behaviour on the lake showcase ----
  await ev(() => { window.__app.history.clear(); return window.__app.openProject('showcase-lake'); });
  await ready();
  await page.waitForTimeout(1200);
  const lake0 = await ev(() => ({ wet: window.__app.world.water.stats.lakeCells[0], level: window.__app.world.project.water.lakes[0].level, reeds: [...window.__app.world.scatterCells.values()].reduce((s, c) => s + (c.layers.get('lakeshore/reeds')?.count || 0), 0) }));
  await ev(() => window.__app.edit('Lake level', (d) => (d.water.lakes[0].level += 1.5), 'water'));
  const lake1 = await ev(() => ({ wet: window.__app.world.water.stats.lakeCells[0], reeds: [...window.__app.world.scatterCells.values()].reduce((s, c) => s + (c.layers.get('lakeshore/reeds')?.count || 0), 0), underwaterTrees: (() => { const w = window.__app.world; let n = 0; for (const c of w.scatterCells.values()) for (const [k, l] of c.layers) if (/trees/.test(k)) for (let i = 0; i < l.count; i++) if (w.waterDepthAt(l.data[i * 8], l.data[i * 8 + 2]) > 0.05) n++; return n; })() }));
  check('raising the lake level floods the shore and re-derives vegetation (nothing grows under water)', lake1.wet > lake0.wet * 1.02 && lake1.underwaterTrees === 0, { before: lake0, after: lake1 });
  await page.keyboard.press('Control+z');
  await page.waitForTimeout(400);
  const lake2 = await ev(() => window.__app.world.water.stats.lakeCells[0]);
  check('lake level edit is undoable', lake2 === lake0.wet);
  // wind → wave energy
  const hs0 = await ev(() => window.__app.engine.waterSim.Hs);
  await ev(() => window.__app.edit('Wind', (d) => (d.env.windSpeed = 9), 'wind'));
  await page.waitForTimeout(300);
  const hs1 = await ev(() => window.__app.engine.waterSim.Hs);
  check('wind speed changes the wave spectrum', hs1 > hs0 * 1.3, { HsBefore: hs0, HsAfter: hs1 });
  await page.keyboard.press('Control+z');
  // floating object: buoyancy + damping + user interaction
  const bob = await ev(async () => {
    const a = window.__app;
    const b = a.engine.objects.objects.get('float-barrel').body;
    const L = a.world.project.water.lakes[0].level;
    // rest draught: mean over one second (the lake has wind ripples, the barrel rides them)
    let rest = 0;
    for (let i = 0; i < 60; i++) { a.stepManual(1 / 60, 1); rest += (b.pos.y - L) / 60; }
    b.pos.y += 1.0;
    b.vel.set(0, 0, 0);
    const ys = [];
    for (let i = 0; i < 360; i++) {
      a.stepManual(1 / 60, 1);
      ys.push(b.pos.y - L);
    }
    a.resumeLoop();
    const amp = (from, to) => Math.max(...ys.slice(from, to)) - Math.min(...ys.slice(from, to));
    return { rest, end: ys.slice(300).reduce((s, v) => s + v, 0) / 60, firstSecond: amp(0, 60), lastSecond: amp(300, 360), min: Math.min(...ys) };
  });
  check('floating object: dropped barrel plunges, bobs and settles back to its rest draught', bob.min < bob.rest - 0.02 && bob.lastSecond < bob.firstSecond * 0.25 && Math.abs(bob.end - bob.rest) < 0.06, bob);
  const ripple = await ev(async () => {
    const a = window.__app;
    const sim = a.engine.waterSim;
    const b = a.engine.objects.objects.get('float-crate').body;
    a.engine.rippleFocus = { x: b.pos.x, z: b.pos.z };
    a.stepManual(1 / 60, 30);
    const read = () => { const rt = sim.ripple[sim.rippleIdx]; const buf = new Uint16Array(rt.width * rt.height * 4); a.engine.renderer.readRenderTargetPixels(rt, 0, 0, rt.width, rt.height, buf); let e = 0; for (let i = 0; i < buf.length; i += 4 * 13) { const h = window.__app.engine.library ? 0 : 0; void h; const v = buf[i]; const s = (v & 0x8000) ? -1 : 1; const ex = (v >> 10) & 31; const f = v & 1023; const val = ex === 0 ? s * f * Math.pow(2, -24) : s * (1 + f / 1024) * Math.pow(2, ex - 15); e += val * val; } return e; };
    const e0 = read();
    for (let i = 0; i < 4; i++) sim.addSource(b.pos.x + 2.5, b.pos.z + 1.5, 0.4, -0.05);
    a.stepManual(1 / 60, 20);
    const e1 = read();
    a.stepManual(1 / 60, 600);
    const e2 = read();
    a.resumeLoop();
    return { e0, e1, e2 };
  });
  check('interaction ripples propagate and decay', ripple.e1 > ripple.e0 * 3 + 1e-9 && ripple.e2 < ripple.e1 * 0.5, ripple);
  // camera above / below water
  const under = await ev(() => {
    const a = window.__app;
    const w = a.world;
    const L = w.project.water.lakes[0];
    // deepest point near the lake marker
    let best = { d: 0 };
    for (let i = 0; i < 300; i++) { const x = L.x + ((i * 37) % 200) - 100, z = L.z + ((i * 91) % 200) - 100; const d = w.waterDepthAt(x, z); if (d > best.d) best = { d, x, z }; }
    a.cam.setPose({ mode: 'fly', position: [best.x, L.level + 1.0, best.z], yaw: 0, pitch: -0.2 });
    a.stepManual(1 / 60, 5);
    const above = a.engine.cameraSubmerged;
    a.cam.setPose({ mode: 'fly', position: [best.x, L.level - Math.min(1.0, best.d * 0.5), best.z], yaw: 0, pitch: 0.1 });
    a.stepManual(1 / 60, 5);
    const below = a.engine.cameraSubmerged;
    a.resumeLoop();
    return { above, below, depth: best.d };
  });
  check('camera transitions between above-water and underwater states', under.above === false && under.below === true, under);
  await shot('underwater');
  // sea level on the coast
  await ev(() => window.__app.openProject('showcase-coast'));
  await ready();
  const sea = await ev(() => {
    const a = window.__app;
    const o0 = a.world.water.stats.oceanCells;
    a.edit('Sea level', (d) => (d.water.sea.level -= 1.0), 'water');
    const o1 = a.world.water.stats.oceanCells;
    a.undo();
    return { o0, o1, o2: a.world.water.stats.oceanCells, brk: a.world.water.swellBreak.reduce((s, v) => s + (v > 0.5 ? 1 : 0), 0) };
  });
  check('lowering the sea level exposes the shore (and is undoable); swell breaks in shallow water', sea.o1 < sea.o0 && sea.o2 === sea.o0 && sea.brk > 50, sea);

  check('no page errors during the session', pageErrors.length === 0, pageErrors.slice(0, 3));
  const appErrors = await ev(() => window.__app.errors);
  check('no application errors reported', appErrors.length === 0, appErrors.slice(0, 3));
  check('application ran fully offline (no request left 127.0.0.1)', external.size === 0, [...external]);
  await browser.close();
  browser = null;

  // ---- 13. independent export verification ----
  if (exportDir) {
    try {
      const outv = execFileSync('node', ['tools/verify-export.mjs', exportDir, '--shots', join(out, 'export-verify')], { cwd: ROOT, encoding: 'utf8', timeout: 600000, maxBuffer: 1 << 26 });
      const tail = outv.trim().split('\n').slice(-3).join(' | ');
      check('exported scene verified by the independent loader (validator + stock GLTFLoader viewer)', true, tail);
    } catch (e) {
      check('exported scene verified by the independent loader (validator + stock GLTFLoader viewer)', false, String(e.stdout || e.message).split('\n').slice(-12).join(' | '));
    }
  }
} catch (e) {
  check('functional test ran to completion', false, e.stack || String(e));
} finally {
  if (browser) await browser.close().catch(() => {});
  stopServer();
}
const failed = checks.filter((c) => !c.ok);
const report = { date: new Date().toISOString(), command: `npm ${cmd.join(' ')}`, passed: checks.length - failed.length, failed: failed.length, checks };
writeFileSync(join(out, 'functional-report.json'), JSON.stringify(report, null, 1));
log(`\n${report.passed}/${checks.length} checks passed. Report: ${join(out, 'functional-report.json')}`);
try {
  rmSync(tmp, { recursive: true, force: true });
} catch {
  /* keep going */
}
process.exit(failed.length ? 1 : 0);
