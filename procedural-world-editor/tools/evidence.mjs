// Captures unretouched review evidence from the running editor (real GPU, headless Chromium):
// stills, fixed-time-step frame sequences (+ contact sheets and mp4), interaction sequences and
// before/after edits for the three showcase projects.
//   node tools/evidence.mjs <outDir> [--only valley,lake,coast] [--quality high] [--size 1920x1080]
// The dev or production server must be running (URL env, default http://127.0.0.1:5173).
// Edits made here are never saved; the showcase projects on disk are untouched.

import { chromium } from 'playwright';
import { mkdirSync, writeFileSync, readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import sharp from 'sharp';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const outDir = resolve(args[0] || '.cache/evidence');
const opt = (n, d) => (args.includes('--' + n) ? args[args.indexOf('--' + n) + 1] : d);
const only = opt('only', 'valley,lake,coast').split(',');
const quality = opt('quality', 'high');
const [W, H] = opt('size', '1920x1080').split('x').map(Number);
const base = process.env.URL || 'http://127.0.0.1:5173';
mkdirSync(outDir, { recursive: true });

export function buildId() {
  const h = createHash('sha256');
  const walk = (d) => {
    for (const f of readdirSync(d).sort()) {
      const p = join(d, f);
      const st = statSync(p);
      if (st.isDirectory()) walk(p);
      else if (/\.(js|mjs|css|html|json)$/.test(f)) h.update(f).update(readFileSync(p));
    }
  };
  for (const d of ['src', 'server']) walk(join(ROOT, d));
  for (const s of ['showcase-valley', 'showcase-lake', 'showcase-coast']) {
    const p = join(ROOT, 'showcases', s, 'project.json');
    if (existsSync(p)) h.update(readFileSync(p));
  }
  return h.digest('hex').slice(0, 12);
}

const index = [];
const note = (section, file, text) => index.push({ section, file, text });

// helpers evaluated inside the page
const PAGE_HELPERS = () => {
  const app = window.__app;
  const ev = (window.__ev = {});
  ev.settle = (n = 120) => app.stepManual(1 / 60, n);
  ev.pose = (p, n = 120) => {
    app.cam.setPose(p);
    app.engine.atmosphere.resetTemporal();
    ev.settle(n);
  };
  ev.river = () => app.world.compiled.rivers.find(Boolean);
  // render one frame and keep a copy of the canvas (used to show what the viewport looks like in the middle of an edit)
  ev.grab = () => {
    app.stepManual(1 / 60, 1);
    (window.__liveFrames = window.__liveFrames || []).push(app.engine.renderer.domElement.toDataURL('image/jpeg', 0.9));
  };
  // pose on the bank next to river sample k, looking up- or downstream
  ev.bankPose = (k, opts = {}) => {
    const w = app.world;
    const c = ev.river();
    const side = opts.side ?? 1;
    const off = opts.off ?? 2.0;
    const x = c.sp.x[k] - c.sp.tz[k] * side * (c.hw[k] + off),
      z = c.sp.z[k] + c.sp.tx[k] * side * (c.hw[k] + off);
    const k2 = Math.max(0, Math.min(c.sp.n - 1, k + Math.round((opts.ahead ?? -30) / c.sp.ds)));
    return { mode: 'fly', position: [x, Math.max(w.heightAt(x, z), c.surf[k]) + (opts.h ?? 1.7), z], lookAt: [c.sp.x[k2], c.surf[k2] + (opts.lookH ?? 0.3), c.sp.z[k2]], fov: opts.fov ?? 55 };
  };
  // river sample with the strongest foam (rapids), searched in the middle 70 %
  ev.rapidsIndex = () => {
    const w = app.world;
    const c = ev.river();
    let best = 0,
      bk = Math.floor(c.sp.n / 2);
    for (let k = Math.floor(c.sp.n * 0.15); k < c.sp.n * 0.85; k += 3) {
      const gi = Math.round(w.hFinal.toGridZ(c.sp.z[k])) * w.res + Math.round(w.hFinal.toGridX(c.sp.x[k]));
      let f = 0;
      for (const o of [0, 1, -1, w.res, -w.res, 2, -2]) f += w.water.foam[gi + o] || 0;
      if (f > best) {
        best = f;
        bk = k;
      }
    }
    return bk;
  };
  // nearest position with no tree / shrub / sizeable rock within `clear` metres
  ev.clearSpot = (x, z, clear = 3, accept = () => true) => {
    const w = app.world;
    const layers = new Map(w.layerList().map((L) => [L.key, L]));
    const blocked = (px, pz) => {
      const cs = 64, half = w.size / 2;
      const cx = Math.floor((px + half) / cs), cz = Math.floor((pz + half) / cs);
      for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) {
        const cell = w.scatterCells.get(cx + dx + ',' + (cz + dz));
        if (!cell) continue;
        for (const [key, inst] of cell.layers) {
          const L = layers.get(key);
          if (!L) continue;
          for (let i = 0; i < inst.count; i++) {
            const o = i * 8;
            const m = app.manifest.models[L.layer.models[inst.data[o + 7] | 0].id];
            if (!m) continue;
            const sc = inst.data[o + 3];
            const big = m.category.startsWith('tree') || m.category === 'shrub' || m.category === 'deadwood' || (m.category === 'rock' && m.height * sc > 0.3);
            if (big && Math.hypot(inst.data[o] - px, inst.data[o + 2] - pz) < clear + m.radius * sc * 0.8) return true;
          }
        }
      }
      return false;
    };
    for (let r = 0; r <= 30; r += 1) {
      const n = r === 0 ? 1 : Math.ceil((2 * Math.PI * r) / 1.2);
      for (let k = 0; k < n; k++) {
        const a = (k / n) * Math.PI * 2;
        const px = x + Math.cos(a) * r, pz = z + Math.sin(a) * r;
        if (accept(px, pz) && !blocked(px, pz)) return { x: px, z: pz };
      }
    }
    return { x, z };
  };
  ev.info = () => ({ fps: app.engine.frameStats(), stats: app.engine.stats, gpu: app.engine.gpuName, quality: app.engine.qualityName, size: [app.engine.sceneRT.width, app.engine.sceneRT.height], msaa: app.engine.quality.msaa, veg: app.engine.vegetation.stats });
  ev.env = (patch) => {
    Object.assign(app.world.project.env, patch);
    app.applyDoc('env');
  };
  // programmatic brush stroke through the same code path as the sculpt tool
  ev.sculpt = (kind, pts, radius, strength, seconds, extra = {}) => {
    const t = app.tools;
    Object.assign(t.brush, { kind, radius, strength, ...extra });
    t.active = 'sculpt';
    t.beginStroke({ x: pts[0][0], z: pts[0][1], y: 0 }, { ctrlKey: false, shiftKey: false });
    const steps = Math.round(seconds * 30);
    for (let i = 0; i <= steps; i++) {
      const f = (i / steps) * (pts.length - 1);
      const a = pts[Math.min(pts.length - 1, Math.floor(f))],
        b = pts[Math.min(pts.length - 1, Math.floor(f) + 1)];
      const u = f - Math.floor(f);
      t.stroke.pos = { x: a[0] + (b[0] - a[0]) * u, z: a[1] + (b[1] - a[1]) * u, y: 0 };
      t.applyStroke(1 / 30);
      // live-edit evidence: render and grab the viewport while the stroke is in progress
      if (window.__liveShots && i % Math.max(1, Math.round(steps / 4)) === 0) ev.grab();
    }
    t.endStroke();
    if (window.__liveShots) { ev.grab(); app.stepManual(1 / 60, 2); ev.grab(); }
    t.active = 'select';
  };
  return true;
};

async function open(browser, project) {
  const page = await browser.newPage({ viewport: { width: W + 636, height: H + 64 } }); // viewport panel = W x H next to the editor chrome
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`${base}/?project=${project}&capture&quality=${quality}`);
  await page.waitForFunction(() => window.__app && ((window.__app.ready && window.__app.world && !document.getElementById('progress')) || window.__app.errors.length), null, { timeout: 300000 });
  const errs = await page.evaluate(() => window.__app.errors);
  if (errs.length) throw new Error('editor failed to open ' + project + ': ' + errs.join(' | '));
  await page.evaluate(PAGE_HELPERS);
  await page.evaluate(() => {
    window.__app.manual = true;
    document.body.classList.add('clean'); // no HUD text over the captured image
  });
  const box = await page.evaluate(() => {
    const r = document.querySelector('#viewport canvas').getBoundingClientRect();
    return { x: Math.round(r.left), y: Math.round(r.top), width: Math.round(r.width), height: Math.round(r.height) };
  });
  return { page, errors, size: [box.width, box.height], clip: box };
}

// camera state recorded next to every capture (the HUD is hidden so nothing is drawn over the image)
const camState = (page) =>
  page.evaluate(() => {
    const a = window.__app;
    const p = a.cam.getPose();
    const w = a.world;
    const g = w.heightAt(p.position[0], p.position[2]);
    const ws = w.waterSurfaceAt(p.position[0], p.position[2]);
    const overWater = ws > -5e4 && ws > g;
    return `camera ${a.engine.cameraSubmerged ? 'UNDER WATER' : 'above water'}, ${overWater ? (p.position[1] - ws).toFixed(2) + ' m relative to the still water level' : (p.position[1] - g).toFixed(2) + ' m above ground'}`;
  });

async function still(ctx, dir, name, text, section) {
  const f = join(dir, name + '.png');
  await ctx.page.screenshot({ path: f, clip: ctx.clip, animations: 'disabled' });
  note(section, f, `${text} [${await camState(ctx.page)}]`);
  return f;
}

// consecutive frames at the real frame interval (1/60 s) while the camera walks: for judging
// shimmer, crawl and popping that coarser sampling hides. Frames + a 60 fps mp4.
async function realtime(ctx, dir, name, text, section, { from, to, look, frames = 120 }) {
  const sub = join(dir, name);
  mkdirSync(sub, { recursive: true });
  await ctx.page.evaluate(([f, l]) => window.__ev.pose({ mode: 'fly', position: f, lookAt: l }, 120), [from, look || to]);
  const files = [];
  for (let i = 0; i < frames; i++) {
    await ctx.page.evaluate(([f, t, l, u]) => {
      const p = [0, 1, 2].map((k) => f[k] + (t[k] - f[k]) * u);
      window.__app.cam.setPose({ mode: 'fly', position: p, lookAt: l });
      window.__app.stepManual(1 / 60, 1);
    }, [from, to, look || to, (i + 1) / frames]);
    const f = join(sub, `f${String(i).padStart(3, '0')}.jpg`);
    await ctx.page.screenshot({ path: f, type: 'jpeg', quality: 90, clip: ctx.clip, animations: 'disabled' });
    files.push(f);
  }
  const pick = [0, 1, 2, 3, 60, 61, 62, 63].map((k) => files[Math.min(files.length - 1, k)]);
  const tw = 960, th = Math.round((tw * ctx.size[1]) / ctx.size[0]);
  const tiles = await Promise.all(pick.map((f) => sharp(f).resize(tw, th).toBuffer()));
  const sheet = join(dir, name + '.sheet.jpg');
  await sharp({ create: { width: 4 * tw, height: 2 * th, channels: 3, background: '#000' } }).composite(tiles.map((b, i) => ({ input: b, left: (i % 4) * tw, top: Math.floor(i / 4) * th }))).jpeg({ quality: 90 }).toFile(sheet);
  try {
    execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-framerate', '60', '-i', join(sub, 'f%03d.jpg'), '-pix_fmt', 'yuv420p', '-crf', '16', join(dir, name + '.mp4')]);
  } catch (e) {
    console.warn('ffmpeg failed for', name, e.message.split('\n')[0]);
  }
  const dist = Math.hypot(to[0] - from[0], to[1] - from[1], to[2] - from[2]);
  note(section, sheet, `${text} — ${frames} CONSECUTIVE frames at 1/60 s (real frame interval), camera moving ${(dist / (frames / 60)).toFixed(1)} m/s; the sheet shows consecutive frames 0-3 (top row) and 60-63 (bottom row) at half size, all frames are in ${name}/ (f000…), 60 fps video ${name}.mp4`);
}

// camera travelling along a straight line (navigation stability: LOD, impostor and shadow transitions)
async function travel(ctx, dir, name, text, section, { from, to, look, frames = 16, stepFrames = 9 }) {
  const dist = Math.hypot(to[0] - from[0], to[1] - from[1], to[2] - from[2]);
  const secs = frames * stepFrames / 60;
  await ctx.page.evaluate(([f, l]) => window.__ev.pose({ mode: 'fly', position: f, lookAt: l }, 120), [from, look || to]);
  return sequence(ctx, dir, name, `${text} — the camera travels ${dist.toFixed(0)} m in ${secs.toFixed(1)} s (${(dist / secs).toFixed(1)} m/s)`, section, {
    frames,
    stepFrames,
    before: `window.__trv = ${JSON.stringify({ from, to, look: look || null, frames })}`,
    each: (i) => {
      const t = window.__trv;
      const u = (i + 1) / t.frames;
      const p = [0, 1, 2].map((k) => t.from[k] + (t.to[k] - t.from[k]) * u);
      const d = [0, 1, 2].map((k) => t.to[k] - t.from[k]);
      const l = t.look || [p[0] + d[0], p[1] + d[1] * 0.2 - 0.02 * Math.hypot(d[0], d[2]), p[2] + d[2]];
      window.__app.cam.setPose({ mode: 'fly', position: p, lookAt: l });
    },
  });
}

async function sequence(ctx, dir, name, text, section, { frames = 12, stepFrames = 12, dt = 1 / 60, before, each } = {}) {
  const sub = join(dir, name);
  mkdirSync(sub, { recursive: true });
  const files = [];
  if (before) await ctx.page.evaluate(before);
  for (let i = 0; i < frames; i++) {
    if (each) await ctx.page.evaluate(each, i);
    await ctx.page.evaluate(([n, d]) => window.__app.stepManual(d, n), [stepFrames, dt]);
    const f = join(sub, `f${String(i).padStart(2, '0')}.jpg`);
    await ctx.page.screenshot({ path: f, type: 'jpeg', quality: 90, clip: ctx.clip, animations: 'disabled' });
    files.push(f);
  }
  // contact sheet: 4 columns
  const cols = 4,
    rows = Math.ceil(frames / cols);
  const tw = 640,
    th = Math.round((tw * ctx.size[1]) / ctx.size[0]);
  const tiles = await Promise.all(files.map((f) => sharp(f).resize(tw, th).toBuffer()));
  const sheet = join(dir, name + '.sheet.jpg');
  await sharp({ create: { width: cols * tw, height: rows * th, channels: 3, background: '#000' } })
    .composite(tiles.map((b, i) => ({ input: b, left: (i % cols) * tw, top: Math.floor(i / cols) * th })))
    .jpeg({ quality: 88 })
    .toFile(sheet);
  try {
    execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-framerate', String(Math.round(1 / (stepFrames * dt))), '-i', join(sub, 'f%02d.jpg'), '-vf', 'scale=1280:-2', '-pix_fmt', 'yuv420p', join(dir, name + '.mp4')]);
  } catch (e) {
    console.warn('ffmpeg failed for', name, e.message.split('\n')[0]);
  }
  note(section, sheet, `${text} — ${frames} frames, ${(stepFrames * dt).toFixed(2)} s apart (read left→right, top→bottom); full frames in ${name}/, video ${name}.mp4`);
  return sheet;
}

const P = (fn, ...a) => [fn, ...a];
void P;

// ---------------------------------------------------------------------------------------------
async function valley(browser) {
  const sec = '1-valley (Mountain Valley)';
  const dir = join(outDir, '1-valley');
  mkdirSync(dir, { recursive: true });
  const ctx = await open(browser, 'showcase-valley');
  const { page } = ctx;
  await page.evaluate(() => window.__ev.settle(150));
  await still(ctx, dir, 'day-opening-bank', 'Opening view of the project as it loads: eye level (1.7 m) on the gravel bank, looking upstream. Mid-morning sun.', sec);
  await sequence(ctx, dir, 'motion-opening', 'River motion from the opening view', sec, { frames: 12, stepFrames: 10 });
  await page.evaluate(() => window.__ev.pose(window.__app.world.project.cameras[1], 150));
  await still(ctx, dir, 'day-aerial', 'Aerial view of the valley (~430 m above the river): drainage, forest, river course, trail.', sec);
  const rk = await page.evaluate(() => window.__ev.rapidsIndex());
  await page.evaluate((k) => {
    // stand on a spot of the bank that is clear of trees and shrubs (no branch in front of the lens)
    const p = window.__ev.bankPose(k + 14, { h: 1.5, ahead: -22, off: 1.2 });
    const w = window.__app.world;
    const sp = window.__ev.clearSpot(p.position[0], p.position[2], 5, (x, z) => w.waterDepthAt(x, z) <= 0);
    p.position = [sp.x, w.heightAt(sp.x, sp.z) + 1.5, sp.z];
    window.__rapPose = p;
    window.__ev.pose(p);
  }, rk);
  await still(ctx, dir, 'day-rapids', 'Rapids / riffle reach (highest foam in the flow solve) from the bank, looking upstream.', sec);
  await sequence(ctx, dir, 'motion-rapids', 'Rapids in motion', sec, { frames: 12, stepFrames: 8 });
  await page.evaluate((k) => window.__ev.pose(window.__ev.bankPose(k + 4, { h: 0.75, ahead: -7, off: 0.6, lookH: -0.2 })), rk);
  await still(ctx, dir, 'day-water-closeup', 'Water close-up 0.75 m above the surface: bed visibility, refraction, caustics, foam detail, wet stones.', sec);
  await sequence(ctx, dir, 'motion-closeup', 'Close-up in motion', sec, { frames: 8, stepFrames: 6 });
  // calm pool / shallows: lowest-foam sample with decent depth
  const pk = await page.evaluate(() => {
    const c = window.__ev.river();
    let best = 1e9,
      bk = 0;
    for (let k = Math.floor(c.sp.n * 0.3); k < c.sp.n * 0.7; k += 5) {
      const s = c.slope[k] - c.depth[k] * 0.01;
      if (s < best) {
        best = s;
        bk = k;
      }
    }
    return bk;
  });
  await page.evaluate((k) => window.__ev.pose(window.__ev.bankPose(k, { h: 1.6, ahead: -35, off: 2.2 })), pk);
  await still(ctx, dir, 'day-pool', 'Calm pool reach: reflections of forest and sky at grazing angles, bed visible near the bank.', sec);
  await page.evaluate((k) => window.__ev.pose(window.__ev.bankPose(k, { h: 1.2, ahead: 3, off: 0.4, lookH: -1.2 })), pk);
  await still(ctx, dir, 'day-shallows-down', 'Looking steeply down into the shallows at the bank: bed, depth tint, waterline, wet bank.', sec);
  // trail and hut
  await page.evaluate(() => {
    const w = window.__app.world;
    const tr = w.project.roads[0].nodes;
    const a = tr[Math.floor(tr.length * 0.5)],
      b = tr[Math.floor(tr.length * 0.5) + 1];
    window.__ev.pose({ mode: 'fly', position: [a.x, w.heightAt(a.x, a.z) + 1.7, a.z], lookAt: [b.x, w.heightAt(b.x, b.z) + 1.2, b.z] });
  });
  await still(ctx, dir, 'day-trail', 'On the foot trail at eye level (trail conforms to terrain, vegetation cleared, trail huts ahead if in view).', sec);
  // underwater + waterline
  await page.evaluate((k) => {
    const c = window.__ev.river();
    const w = window.__app.world;
    const x = c.sp.x[k],
      z = c.sp.z[k];
    const k2 = Math.max(0, k - 20);
    window.__ev.pose({ mode: 'fly', position: [x, c.surf[k] - Math.min(0.35, c.depth[k] * 0.5), z], lookAt: [c.sp.x[k2], c.surf[k2] - 0.3, c.sp.z[k2]] });
    void w;
  }, pk);
  await still(ctx, dir, 'day-underwater', 'Camera fully under the river surface in the pool, looking upstream: attenuation, bed, caustics, underside of the surface.', sec);
  await sequence(ctx, dir, 'transition-surface', 'Camera crossing the river surface: lens height +0.4, +0.2, +0.1, +0.05, +0.02, 0, −0.02, −0.05, −0.1, −0.2, −0.3, −0.4 m relative to the local surface', sec, {
    frames: 12,
    stepFrames: 4,
    each: (i) => {
      const c = window.__ev.river();
      const k = window.__pk;
      // fine steps around the surface so the waterline is in frame for several images
      const offs = [0.4, 0.2, 0.1, 0.05, 0.02, 0.0, -0.02, -0.05, -0.1, -0.2, -0.3, -0.4];
      const gi0 = Math.round(window.__app.world.hFinal.toGridZ(window.__app.cam.getPose().position[2])) * window.__app.world.res + Math.round(window.__app.world.hFinal.toGridX(window.__app.cam.getPose().position[0]));
      const y = c.surf[k] + (window.__app.world.water.relief[gi0] || 0) + offs[i];
      const p = window.__app.cam.getPose();
      window.__app.cam.setPose({ mode: 'fly', position: [p.position[0], y, p.position[2]], yaw: p.yaw, pitch: -0.12 });
    },
    before: `window.__pk = ${pk}`,
  });
  // navigation: walk along the bank, then a low flight up the valley
  {
    const pts = await page.evaluate((k) => {
      const c = window.__ev.river();
      const w = window.__app.world;
      const at = (kk, off, h) => {
        kk = Math.max(0, Math.min(c.sp.n - 1, kk));
        const x = c.sp.x[kk] - c.sp.tz[kk] * (c.hw[kk] + off), z = c.sp.z[kk] + c.sp.tx[kk] * (c.hw[kk] + off);
        return [x, Math.max(w.heightAt(x, z), c.surf[kk]) + h, z];
      };
      const n = (m) => Math.round(m / c.sp.ds);
      return { w0: at(k + n(12), 2.2, 1.7), w1: at(k - n(12), 2.2, 1.7), f0: at(k + n(110), 0, 9), f1: at(k - n(110), 0, 9) };
    }, pk);
    await travel(ctx, dir, 'nav-walk-bank', 'Navigation: walking along the river bank at eye level', sec, { from: pts.w0, to: pts.w1, frames: 16, stepFrames: 12 });
    await realtime(ctx, dir, 'realtime-walk-bank', 'Real-time stability: walking along the bank past trees, ground cover and water', sec, { from: pts.w0, to: [pts.w0[0] + (pts.w1[0] - pts.w0[0]) * 0.13, pts.w0[1] + (pts.w1[1] - pts.w0[1]) * 0.13, pts.w0[2] + (pts.w1[2] - pts.w0[2]) * 0.13], look: pts.w1 });
    await travel(ctx, dir, 'nav-fly-valley', 'Navigation: low flight (9 m above the water) up the river', sec, { from: pts.f0, to: [pts.f0[0] + (pts.f1[0] - pts.f0[0]) * 0.22, pts.f0[1] + (pts.f1[1] - pts.f0[1]) * 0.22, pts.f0[2] + (pts.f1[2] - pts.f0[2]) * 0.22], frames: 32, stepFrames: 6 });
  }
  // second lighting condition
  await page.evaluate(() => window.__ev.env({ timeOfDay: 19.1, cloudCover: 0.5 }));
  await page.evaluate(() => window.__ev.pose(window.__app.world.project.cameras[0], 200));
  await still(ctx, dir, 'evening-opening-bank', 'Second lighting condition: low evening sun (19:06), same opening view.', sec);
  await page.evaluate(() => window.__ev.pose(window.__rapPose));
  await still(ctx, dir, 'evening-rapids', 'Rapids in evening light.', sec);
  await page.evaluate(() => window.__ev.pose(window.__app.world.project.cameras[1], 150));
  await still(ctx, dir, 'evening-aerial', 'Aerial view in evening light (long shadows across the valley).', sec);
  await page.evaluate(() => window.__ev.env({ timeOfDay: 13.0, cloudCover: 0.95, fogDensity: 0.55 }));
  await page.evaluate(() => window.__ev.pose(window.__app.world.project.cameras[0], 200));
  await still(ctx, dir, 'overcast-opening-bank', 'Third lighting condition: overcast with valley haze.', sec);
  await page.evaluate(() => window.__ev.env({ timeOfDay: 10.4, cloudCover: 0.42, fogDensity: 0.22 }));

  // ---- edit: terrain sculpt (before / after) ----
  const sc = await page.evaluate(() => {
    const c = window.__ev.river();
    const k = Math.floor(c.sp.n * 0.42);
    const w = window.__app.world;
    const off = c.hw[k] + 34;
    const x = c.sp.x[k] + c.sp.tz[k] * off,
      z = c.sp.z[k] - c.sp.tx[k] * off;
    // camera on the opposite side of the river, 28 m up, looking across at the edit site
    // camera 55 m above the river, 60 m upstream of the site, looking down on the bank
    const cx = c.sp.x[k] - c.sp.tx[k] * 60 + c.sp.tz[k] * 10,
      cz = c.sp.z[k] - c.sp.tz[k] * 60 - c.sp.tx[k] * 10;
    window.__ev.pose({ mode: 'fly', position: [cx, c.surf[k] + 55, cz], lookAt: [x * 0.7 + c.sp.x[k] * 0.3, c.surf[k], z * 0.7 + c.sp.z[k] * 0.3], fov: 58 });
    return { x, z, tx: c.sp.tx[k], tz: c.sp.tz[k], rx: c.sp.x[k], rz: c.sp.z[k] };
  });
  await still(ctx, dir, 'edit-sculpt-0-before', 'Terrain edit, BEFORE: looking down the valley from 55 m above the river at the bank that is about to be sculpted.', sec);
  await page.evaluate((s) => {
    window.__liveShots = true;
    window.__ev.sculpt('raise', [[s.x, s.z]], 24, 0.9, 4.0);
    window.__ev.sculpt('smooth', [[s.x, s.z]], 34, 0.9, 2.5);
    window.__ev.sculpt('carve', [[s.x - s.tx * 55, s.z - s.tz * 55], [s.x - s.tx * 42 + (s.rx - s.x) * 0.5, s.z - s.tz * 42 + (s.rz - s.z) * 0.5], [s.rx - s.tx * 30, s.rz - s.tz * 30]], 9, 1.0, 5.0, { depth: 4 });
    window.__liveShots = false;
    window.__ev.settle(150);
  }, sc);
  {
    // write the frames grabbed during the strokes
    const shots = await page.evaluate(() => window.__liveFrames || []);
    const sub = join(dir, 'edit-sculpt-live');
    mkdirSync(sub, { recursive: true });
    const files = [];
    for (let i = 0; i < shots.length; i++) {
      const f = join(sub, `f${String(i).padStart(2, '0')}.jpg`);
      writeFileSync(f, Buffer.from(shots[i].split(',')[1], 'base64'));
      files.push(f);
    }
    if (files.length) {
      const cols = 4, rows = Math.ceil(files.length / cols), tw = 640, th = Math.round((tw * ctx.size[1]) / ctx.size[0]);
      const tiles = await Promise.all(files.map((f) => sharp(f).resize(tw, th).toBuffer()));
      await sharp({ create: { width: cols * tw, height: rows * th, channels: 3, background: '#000' } }).composite(tiles.map((b, i) => ({ input: b, left: (i % cols) * tw, top: Math.floor(i / cols) * th }))).jpeg({ quality: 88 }).toFile(join(dir, 'edit-sculpt-live.sheet.jpg'));
    }
  }
  note(sec, join(dir, 'edit-sculpt-live.sheet.jpg'), 'LIVE EDIT: frames taken while the three strokes above were being applied (one rendered frame after every few brush dabs, then the frames right after each stroke is committed and the water / materials / scatter re-derive) — read left→right, top→bottom; full frames in edit-sculpt-live/');
  await still(ctx, dir, 'edit-sculpt-1-after', 'Terrain edit, AFTER three brush strokes made through the sculpt tool code path: a raised knoll (raise + smooth; right/far side of the bank) and, nearer the camera, a side channel carved 4 m deep from the valley side down to the river. Ground materials and scatter have re-derived (trees removed from steep new faces, rock exposed).', sec);
  await page.evaluate(() => {
    window.__app.undo();
    window.__app.undo();
    window.__app.undo();
    window.__ev.settle(120);
  });
  await still(ctx, dir, 'edit-sculpt-2-undone', 'Same view after three undo steps (should match BEFORE).', sec);

  // ---- edit: reroute the river and constrict it (before / after + motion) ----
  const rr = await page.evaluate(() => {
    const w = window.__app.world;
    const r = w.project.water.rivers[0];
    const i = Math.floor(r.nodes.length * 0.5);
    const n = r.nodes[i];
    const c = window.__ev.river();
    window.__ev.pose({ mode: 'fly', position: [n.x + 150, w.heightAt(n.x, n.z) + 170, n.z + 170], lookAt: [n.x, w.heightAt(n.x, n.z), n.z] });
    void c;
    return { i, x: n.x, z: n.z };
  });
  await still(ctx, dir, 'edit-river-0-before', 'River edit, BEFORE: oblique aerial of the middle reach.', sec);
  await page.evaluate((q) => {
    const app = window.__app;
    app.edit(
      'Move river points',
      (d) => {
        const n = d.water.rivers[0].nodes;
        // push three consecutive points sideways into a new bend
        const dir = { x: n[q.i + 1].z - n[q.i - 1].z, z: -(n[q.i + 1].x - n[q.i - 1].x) };
        const l = Math.hypot(dir.x, dir.z) || 1;
        for (const [k, a] of [[q.i - 1, 30], [q.i, 70], [q.i + 1, 35]]) {
          n[k].x += (dir.x / l) * a;
          n[k].z += (dir.z / l) * a;
        }
      },
      'modifiers',
    );
    window.__ev.settle(150);
  }, rr);
  await still(ctx, dir, 'edit-river-1-rerouted', 'River edit, AFTER moving three path points ~70 m sideways: the old channel has healed back to the sculpted terrain and a new channel is carved; banks, pebbles, vegetation clearing and flow follow the new course.', sec);
  await page.evaluate((q) => {
    const w = window.__app.world;
    const n = w.project.water.rivers[0].nodes[q.i];
    const c = window.__ev.river();
    // nearest sample to the moved node
    let bk = 0,
      bd = 1e9;
    for (let k = 0; k < c.sp.n; k += 2) {
      const d = Math.hypot(c.sp.x[k] - n.x, c.sp.z[k] - n.z);
      if (d < bd) {
        bd = d;
        bk = k;
      }
    }
    window.__rk2 = bk;
    window.__ev.pose(window.__ev.bankPose(bk + 10, { h: 1.6, ahead: -30, off: 1.5 }));
  }, rr);
  await still(ctx, dir, 'edit-river-2-newchannel-eye', 'Eye-level view on the bank of the newly carved channel (same project, a few seconds after the edit).', sec);
  await sequence(ctx, dir, 'motion-newchannel', 'Flow in the new channel', sec, { frames: 8, stepFrames: 8 });
  await page.evaluate((q) => {
    const app = window.__app;
    app.edit('Constrict river', (d) => {
      const n = d.water.rivers[0].nodes;
      n[q.i].width = 4.5;
      n[q.i].depth = 0.9;
    }, 'modifiers');
    window.__app.stepManual(1 / 60, 30);
    // recompute the sample nearest to the moved node (the path was recompiled)
    const c = window.__ev.river();
    const nd = window.__app.world.project.water.rivers[0].nodes[q.i];
    let bk = 0, bd = 1e9;
    for (let k = 0; k < c.sp.n; k++) { const d = Math.hypot(c.sp.x[k] - nd.x, c.sp.z[k] - nd.z); if (d < bd) { bd = d; bk = k; } }
    window.__rk2 = bk;
    window.__ev.pose(window.__ev.bankPose(bk + 10, { h: 1.6, ahead: -30, off: 1.5 }));
  }, rr);
  await still(ctx, dir, 'edit-river-3-constricted', 'Same view after narrowing the channel at the moved point from 11 m to 4.5 m: the solver speeds the flow through the constriction (continuity), which raises the Froude number and foam there.', sec);
  await sequence(ctx, dir, 'motion-constricted', 'Flow through the constriction', sec, { frames: 8, stepFrames: 8 });
  await page.evaluate(() => {
    const c = window.__ev.river();
    const k = window.__rk2;
    const w = window.__app.world;
    const k1 = Math.max(0, k - Math.round(9 / c.sp.ds)), k2 = Math.min(c.sp.n - 1, k + Math.round(8 / c.sp.ds));
    const x = c.sp.x[k1] - c.sp.tz[k1] * (c.hw[k1] + 0.8), z = c.sp.z[k1] + c.sp.tx[k1] * (c.hw[k1] + 0.8);
    window.__ev.pose({ mode: 'fly', position: [x, Math.max(w.heightAt(x, z), c.surf[k1]) + 1.3, z], lookAt: [c.sp.x[k2], c.surf[k2], c.sp.z[k2]], fov: 60 });
  });
  await page.evaluate(() => {
    const c = window.__ev.river();
    const k = window.__rk2;
    window.__app.engine.water.U.uFlowViz.value = 1;
    window.__ev.pose({ mode: 'fly', position: [c.sp.x[k] + 4, c.surf[k] + 75, c.sp.z[k] + 4], lookAt: [c.sp.x[k], c.surf[k], c.sp.z[k]], fov: 50 });
  });
  await still(ctx, dir, 'edit-river-5-flowviz-constricted', 'Editor flow overlay (Water tab ▸ Show flow speed) looking straight down on the constricted reach from 75 m: colour = solved current speed (blue 0, green 1, yellow 2, red ≥ 3 m/s), streaks move with the flow. The narrowed section is at the centre of the image.', sec);
  await page.evaluate((q) => {
    window.__app.undo();
    window.__app.stepManual(1 / 60, 90);
  }, rr);
  await still(ctx, dir, 'edit-river-6-flowviz-unconstricted', 'Same camera and overlay after undoing the constriction (channel back to its 11 m width): compare the colour at the centre with the previous image.', sec);
  await page.evaluate(() => {
    window.__app.redo();
    window.__app.engine.water.U.uFlowViz.value = 0;
    window.__app.stepManual(1 / 60, 30);
    const c = window.__ev.river();
    const k = window.__rk2;
    const w = window.__app.world;
    const k1 = Math.max(0, k - Math.round(9 / c.sp.ds)), k2 = Math.min(c.sp.n - 1, k + Math.round(8 / c.sp.ds));
    const x = c.sp.x[k1] - c.sp.tz[k1] * (c.hw[k1] + 0.8), z = c.sp.z[k1] + c.sp.tx[k1] * (c.hw[k1] + 0.8);
    window.__ev.pose({ mode: 'fly', position: [x, Math.max(w.heightAt(x, z), c.surf[k1]) + 1.3, z], lookAt: [c.sp.x[k2], c.surf[k2], c.sp.z[k2]], fov: 60 });
  });
  await still(ctx, dir, 'edit-river-4-narrows-closeup', 'Close view down through the narrowed section (camera on the bank 9 m upstream of the narrowest point, 1.3 m up): surface drawdown and standing waves where the flow accelerates, foam downstream.', sec);
  await sequence(ctx, dir, 'motion-narrows', 'Flow through the narrows, close', sec, { frames: 8, stepFrames: 6 });
  const flowStats = await page.evaluate(() => {
    const w = window.__app.world;
    const c = window.__ev.river();
    const k = window.__rk2;
    const sample = (kk) => {
      const gi = Math.round(w.hFinal.toGridZ(c.sp.z[kk])) * w.res + Math.round(w.hFinal.toGridX(c.sp.x[kk]));
      return { v: Math.hypot(w.water.vx[gi], w.water.vz[gi]), depth: w.water.surf[gi] - w.hFinal.data[gi], foam: w.water.foam[gi], halfWidth: c.hw[kk] };
    };
    return { atConstriction: sample(k), upstream: sample(Math.max(0, k - Math.round(60 / c.sp.ds))) };
  });
  writeFileSync(join(dir, 'edit-river-flow-stats.json'), JSON.stringify(flowStats, null, 1));
  note(sec, join(dir, 'edit-river-flow-stats.json'), 'Solver values sampled at the constriction and 60 m upstream after the edit (centre-line speed m/s, depth m, foam 0..1).');
  const info = await page.evaluate(() => window.__ev.info());
  await page.close();
  return { info, errors: ctx.errors };
}

async function lake(browser) {
  const sec = '2-lake (Sheltered Lake)';
  const dir = join(outDir, '2-lake');
  mkdirSync(dir, { recursive: true });
  const ctx = await open(browser, 'showcase-lake');
  const { page } = ctx;
  await page.evaluate(() => window.__ev.settle(150));
  await still(ctx, dir, 'day-opening-shore', 'Opening view: eye level on the lake shore by the jetty, morning light. Reflected scenery, reeds, floating objects.', sec);
  await sequence(ctx, dir, 'motion-opening', 'Lake surface in motion (wind ripples, gusts, floating objects)', sec, { frames: 12, stepFrames: 12 });
  await page.evaluate(() => window.__ev.pose(window.__app.world.project.cameras[1], 150));
  await still(ctx, dir, 'day-aerial', 'Aerial view of the lake and its drowned-valley shoreline.', sec);
  const si = await page.evaluate(() => window.__app.world.project.showcaseInfo);
  // reeds: along the shore from the view spot
  await page.evaluate((s) => {
    const w = window.__app.world;
    const p = window.__app.world.project.cameras[0].position;
    const l = window.__app.world.project.cameras[0].lookAt;
    const dx = l[0] - p[0],
      dz = l[2] - p[2];
    const d = Math.hypot(dx, dz);
    const sx = -dz / d,
      sz = dx / d;
    const x = p[0] - sx * 16,
      z = p[2] - sz * 16;
    window.__ev.pose({ mode: 'fly', position: [x, w.heightAt(x, z) + 1.5, z], lookAt: [x - sx * 30 + (dx / d) * 14, w.project.water.lakes[0].level + 0.6, z - sz * 30 + (dz / d) * 14] });
    void s;
  }, si);
  await still(ctx, dir, 'day-reeds-shoreline', 'Natural shoreline with reed beds and shore vegetation, eye level.', sec);
  await sequence(ctx, dir, 'motion-reeds', 'Reeds and ripples in the wind', sec, { frames: 8, stepFrames: 10 });
  // floating objects close-up from the jetty side
  await page.evaluate((s) => {
    const w = window.__app.world;
    const L = w.project.water.lakes[0].level;
    const b = window.__app.engine.objects.objects.get('float-barrel').body.pos;
    window.__ev.pose({ mode: 'fly', position: [b.x + 3.2, L + 1.25, b.z + 2.6], lookAt: [b.x, L + 0.15, b.z] });
    void s;
  }, si);
  await still(ctx, dir, 'day-floating-closeup', 'Close-up of floating objects at rest by the jetty (waterline on the hull, reflection, refraction of the submerged part).', sec);
  // interaction 1: lift & drop the barrel
  await sequence(ctx, dir, 'interact-drop', 'Buoyancy: the barrel is lifted 1.2 m and released — entry, splash ring, bobbing and damping until it is at rest again (6 s)', sec, {
    frames: 24,
    stepFrames: 15,
    before: () => {
      const b = window.__app.engine.objects.objects.get('float-barrel').body;
      b.pos.y += 1.2;
      b.vel.set(0, 0, 0);
    },
  });
  // interaction 2: push the crate so it travels and leaves a wake
  await page.evaluate(() => {
    const w = window.__app.world;
    const L = w.project.water.lakes[0].level;
    const b = window.__app.engine.objects.objects.get('float-crate2').body;
    window.__ev.pose({ mode: 'fly', position: [b.pos.x + 5, L + 2.6, b.pos.z + 5], lookAt: [b.pos.x - 3, L, b.pos.z - 3] }, 60);
  });
  await sequence(ctx, dir, 'interact-push', 'A floating crate is shoved across the water (2.5 m/s initial): wake, drag deceleration', sec, {
    frames: 16,
    stepFrames: 8,
    before: () => {
      const b = window.__app.engine.objects.objects.get('float-crate2').body;
      b.vel.x = -1.8;
      b.vel.z = -1.8;
    },
  });
  // interaction 3: stone drop ripples on open water
  await page.evaluate(() => {
    const w = window.__app.world;
    const L = w.project.water.lakes[0].level;
    const c = window.__app.world.project.cameras[0];
    const dx = c.lookAt[0] - c.position[0],
      dz = c.lookAt[2] - c.position[2];
    const d = Math.hypot(dx, dz);
    // open water at least 0.8 m deep in front of the view point
    window.__drop = { x: c.position[0] + (dx / d) * 14, z: c.position[2] + (dz / d) * 14 };
    for (let t = 8; t < 60; t += 2) { const x = c.position[0] + (dx / d) * t, z = c.position[2] + (dz / d) * t; if (w.waterDepthAt(x, z) > 0.8) { window.__drop = { x: x + (dx / d) * 3, z: z + (dz / d) * 3 }; break; } }
    window.__app.tools.active = 'interact';
    window.__app.tools.cursor = { x: window.__drop.x, z: window.__drop.z, y: L, water: true };
    window.__ev.pose({ mode: 'fly', position: [window.__drop.x - (dx / d) * 7.5, L + 2.0, window.__drop.z - (dz / d) * 7.5], lookAt: [window.__drop.x, L, window.__drop.z] }, 90);
  });
  await sequence(ctx, dir, 'interact-ripples', 'A stone is dropped on calm water (Touch-water tool): ring ripples spread, disperse and decay', sec, {
    frames: 16,
    stepFrames: 6,
    before: () => {
      for (let i = 0; i < 3; i++) window.__app.engine.waterSim.addSource(window.__drop.x, window.__drop.z, 0.4, -0.05);
    },
  });
  await page.evaluate(() => (window.__app.tools.active = 'select'));
  // underwater in the shallows
  await page.evaluate(() => {
    const w = window.__app.world;
    const L = w.project.water.lakes[0].level;
    const c = window.__app.world.project.cameras[0];
    const dx = c.lookAt[0] - c.position[0], dz = c.lookAt[2] - c.position[2];
    const dl = Math.hypot(dx, dz);
    let d = window.__drop;
    for (let t = 10; t < 120; t += 3) {
      const x = c.position[0] + (dx / dl) * t, z = c.position[2] + (dz / dl) * t;
      if (w.waterDepthAt(x, z) > 1.7) { d = { x, z }; break; }
    }
    window.__uw = d;
    window.__ev.pose({ mode: 'fly', position: [d.x, L - 0.55, d.z], lookAt: [c.position[0], L - 0.9, c.position[2]] });
  });
  await still(ctx, dir, 'day-underwater', 'Camera 0.55 m under the lake surface (water ≥ 1.7 m deep) looking back towards the shore: attenuation, bed, underside of the surface (Snell window / total internal reflection).', sec);
  await sequence(ctx, dir, 'transition-surface', 'Camera crossing the lake surface: lens height −0.4, −0.2, −0.1, −0.05, −0.02, 0, +0.02, +0.05, +0.1, +0.2, +0.3, +0.4 m relative to the lake level', sec, {
    frames: 12,
    stepFrames: 4,
    each: (i) => {
      const L = window.__app.world.project.water.lakes[0].level;
      const p = window.__app.cam.getPose();
      const offs = [-0.4, -0.2, -0.1, -0.05, -0.02, 0.0, 0.02, 0.05, 0.1, 0.2, 0.3, 0.4];
      window.__app.cam.setPose({ mode: 'fly', position: [p.position[0], L + offs[i], p.position[2]], yaw: p.yaw, pitch: 0.0 });
    },
  });
  // navigation: walk along the shore, then fly low across the lake
  {
    const pts = await page.evaluate(() => {
      const w = window.__app.world;
      const c = w.project.cameras[0];
      const L = w.project.water.lakes[0].level;
      const dx = c.lookAt[0] - c.position[0], dz = c.lookAt[2] - c.position[2];
      const d = Math.hypot(dx, dz);
      const ux = dx / d, uz = dz / d, sx = -uz, sz = ux;
      const gp = (x, z, h) => [x, Math.max(w.heightAt(x, z), L) + h, z];
      return {
        w0: gp(c.position[0] - sx * 12 - ux * 3, c.position[2] - sz * 12 - uz * 3, 1.7), w1: gp(c.position[0] + sx * 12 - ux * 3, c.position[2] + sz * 12 - uz * 3, 1.7),
        wl: [c.position[0] + ux * 40, L, c.position[2] + uz * 40],
        f0: [c.position[0] - ux * 20, L + 7, c.position[2] - uz * 20], f1: [c.position[0] + ux * 220, L + 7, c.position[2] + uz * 220],
      };
    });
    await realtime(ctx, dir, 'realtime-walk-shore', 'Real-time stability: walking along the lake shore (reflections, reeds, tree crowns)', sec, { from: pts.w0, to: [pts.w0[0] + (pts.w1[0] - pts.w0[0]) * 0.13, pts.w0[1], pts.w0[2] + (pts.w1[2] - pts.w0[2]) * 0.13], look: pts.wl });
    await travel(ctx, dir, 'nav-walk-shore', 'Navigation: walking along the lake shore at eye level, looking over the water', sec, { from: pts.w0, to: pts.w1, look: pts.wl, frames: 16, stepFrames: 12 });
    await travel(ctx, dir, 'nav-fly-lake', 'Navigation: low flight (7 m) from the shore out over the lake', sec, { from: pts.f0, to: [pts.f0[0] + (pts.f1[0] - pts.f0[0]) * 0.2, pts.f0[1], pts.f0[2] + (pts.f1[2] - pts.f0[2]) * 0.2], frames: 32, stepFrames: 6 });
  }
  // lighting
  await page.evaluate(() => window.__ev.env({ timeOfDay: 19.6, cloudCover: 0.45, windSpeed: 1.2 }));
  await page.evaluate(() => window.__ev.pose(window.__app.world.project.cameras[0], 220));
  await still(ctx, dir, 'evening-opening-shore', 'Second lighting condition: evening, light wind (1.2 m/s) — calmer surface, longer reflections.', sec);
  await page.evaluate(() => window.__ev.pose(window.__app.world.project.cameras[1], 150));
  await still(ctx, dir, 'evening-aerial', 'Aerial view in evening light.', sec);
  await page.evaluate(() => window.__ev.env({ timeOfDay: 11.5, cloudCover: 0.4, windSpeed: 8.5 }));
  await page.evaluate(() => window.__ev.pose(window.__app.world.project.cameras[0], 220));
  await still(ctx, dir, 'windy-opening-shore', 'Wind raised to 8.5 m/s: stronger fetch-limited ripples, fewer mirror reflections, reeds and trees swaying (same lake).', sec);
  await sequence(ctx, dir, 'motion-windy', 'Windy lake in motion', sec, { frames: 8, stepFrames: 10 });
  await page.evaluate(() => window.__ev.env({ timeOfDay: 9.2, cloudCover: 0.38, windSpeed: 2.6 }));
  // ---- edit: water level ----
  await page.evaluate(() => {
    const c = window.__app.world.project.cameras[0];
    const w = window.__app.world;
    const dx = c.lookAt[0] - c.position[0],
      dz = c.lookAt[2] - c.position[2];
    const d = Math.hypot(dx, dz);
    const L0 = w.project.water.lakes[0].level;
    window.__ev.pose({ mode: 'fly', position: [c.position[0] + (dx / d) * 42 - (dz / d) * 16, L0 + 13, c.position[2] + (dz / d) * 42 + (dx / d) * 16], lookAt: [c.position[0] - (dx / d) * 4, L0 + 0.5, c.position[2] - (dz / d) * 4] }, 150);
  });
  await still(ctx, dir, 'edit-level-0-before', 'Water-level edit, BEFORE: the shore, jetty and reed beds seen from 13 m above the lake, looking back at the land.', sec);
  await sequence(ctx, dir, 'edit-level-live', 'LIVE EDIT: the lake level is lowered by 1.3 m just before frame 2 — consecutive rendered frames (1/60 s apart) around the moment of the change: frames 0-1 before, frame 2 is the first frame after the edit, then the following frames', sec, {
    frames: 8,
    stepFrames: 1,
    each: (i) => {
      if (i === 2) window.__app.edit('Lake level', (d) => (d.water.lakes[0].level -= 1.3), 'water');
    },
  });
  await page.evaluate(() => window.__ev.settle(150));
  await still(ctx, dir, 'edit-level-1-lowered', 'Lake level lowered by 1.3 m: exposed bed (wet mud / pebbles), shoreline moves out, reed beds re-grow at the new waterline, the jetty stands higher above the water.', sec);
  await page.evaluate(() => {
    window.__app.edit('Lake level', (d) => (d.water.lakes[0].level += 2.4), 'water');
    window.__ev.settle(150);
  });
  await still(ctx, dir, 'edit-level-2-raised', 'Lake level raised to 1.1 m above the original: shore flooded, vegetation that would stand in water is removed by the biome rules.', sec);
  const info = await page.evaluate(() => window.__ev.info());
  await page.close();
  return { info, errors: ctx.errors };
}

async function coast(browser) {
  const sec = '3-coast (Rugged Coast)';
  const dir = join(outDir, '3-coast');
  mkdirSync(dir, { recursive: true });
  const ctx = await open(browser, 'showcase-coast');
  const { page } = ctx;
  await page.evaluate(() => window.__ev.settle(200));
  await still(ctx, dir, 'day-opening-beach', 'Opening view: eye level on the beach, afternoon sun, swell breaking in the bay.', sec);
  await sequence(ctx, dir, 'motion-opening', 'Surf from the beach over 12 s (more than one swell period): waves approach, break, run up and drain', sec, { frames: 24, stepFrames: 30 });
  await page.evaluate(() => window.__ev.pose(window.__app.world.project.cameras[1], 150));
  await still(ctx, dir, 'day-aerial', 'Aerial view of the bay: refracted swell lines, breaker zone, deep-to-shallow colour transition, headland.', sec);
  await sequence(ctx, dir, 'motion-aerial', 'Surf zone from the air', sec, { frames: 12, stepFrames: 15 });
  const si = await page.evaluate(() => window.__app.world.project.showcaseInfo);
  // swash close-up: standing at the waterline looking along the shore
  await page.evaluate((s) => {
    const w = window.__app.world;
    const sea = w.project.water.sea.level;
    const x = s.beach.x + s.seaDir.x * 7,
      z = s.beach.z + s.seaDir.z * 7;
    window.__ev.pose({ mode: 'fly', position: [x, Math.max(sea, w.heightAt(x, z)) + 1.45, z], lookAt: [x + s.along.x * 14 + s.seaDir.x * 6, sea + 0.1, z + s.along.z * 14 + s.seaDir.z * 6] }, 150);
  }, si);
  await still(ctx, dir, 'day-swash-closeup', 'At the waterline: swash sheet, foam lace, wet sand, shallow-water optics.', sec);
  await sequence(ctx, dir, 'motion-swash', 'Swash close-up: run-up and backwash', sec, { frames: 16, stepFrames: 12 });
  // breaker close-up: standing in the shallows looking seaward at the breaking waves, fast sampling
  await page.evaluate((s) => {
    const w = window.__app.world;
    const sea = w.project.water.sea.level;
    const x = s.beach.x + s.seaDir.x * 3, z = s.beach.z + s.seaDir.z * 3;
    window.__ev.pose({ mode: 'fly', position: [x, Math.max(sea, w.heightAt(x, z)) + 1.6, z], lookAt: [x + s.seaDir.x * 30 + s.along.x * 8, sea + 0.5, z + s.seaDir.z * 30 + s.along.z * 8] }, 150);
  }, si);
  await still(ctx, dir, 'day-breakers-closeup', 'Looking seaward from the edge of the swash at the breaker line (1.6 m eye height): steepening crests, breaking roller, spray, foam left behind.', sec);
  await sequence(ctx, dir, 'motion-breakers', 'Waves breaking, close (fast sampling, 1/12 s apart)', sec, { frames: 16, stepFrames: 5 });
  await sequence(ctx, dir, 'motion-breakers-cycle', 'The same view over 10 s: one full cycle of a wave approaching, steepening, breaking and the bore running in', sec, { frames: 20, stepFrames: 30 });
  // rocky shore: find a steep rock cell near the water
  const rock = await page.evaluate(() => {
    const w = window.__app.world;
    const res = w.res;
    let best = null;
    for (let iz = 80; iz < res - 80; iz += 5) {
      for (let ix = 80; ix < res - 80; ix += 5) {
        const i = iz * res + ix;
        if (w.water.type[i] !== 0 || w.water.shore[i] < -14 || w.water.shore[i] > -6) continue;
        let s = 0;
        for (let k = 0; k < 8; k++) s += w.weights[i * 8 + k];
        const rockW = 255 - s;
        const hgt = w.hFinal.data[i] - w.project.water.sea.level;
        if (rockW < 120 || hgt < 2 || hgt > 14) continue;
        const sc = rockW - Math.abs(hgt - 6) * 6;
        if (!best || sc > best.sc) best = { sc, x: w.hFinal.toWorldX(ix), z: w.hFinal.toWorldZ(iz), hgt };
      }
    }
    if (!best) return null;
    // look seaward
    const sh = (x, z) => w.water.shore[Math.round(w.hFinal.toGridZ(z)) * res + Math.round(w.hFinal.toGridX(x))];
    let gx = sh(best.x + 12, best.z) - sh(best.x - 12, best.z),
      gz = sh(best.x, best.z + 12) - sh(best.x, best.z - 12);
    const l = Math.hypot(gx, gz) || 1;
    gx /= l;
    gz /= l;
    const sp = window.__ev.clearSpot(best.x, best.z, 4.5, (x, z) => w.waterDepthAt(x, z) <= 0 && w.heightAt(x, z) - w.project.water.sea.level > 1.5);
    window.__ev.pose({ mode: 'fly', position: [sp.x, w.heightAt(sp.x, sp.z) + 1.9, sp.z], lookAt: [sp.x + gx * 30 - gz * 25, w.project.water.sea.level + 1, sp.z + gz * 30 + gx * 25] }, 150);
    return best;
  });
  if (rock) {
    await still(ctx, dir, 'day-rocky-shore', 'Rocky shore below the headland: swell meeting rock, surge foam, wet rock, sea stacks.', sec);
    await sequence(ctx, dir, 'motion-rocky-shore', 'Swell against the rocks', sec, { frames: 12, stepFrames: 12 });
  } else note(sec, '(none)', 'No rocky-shore viewpoint was found by the automatic search.');
  // floating buoy
  await page.evaluate(() => {
    const w = window.__app.world;
    const sea = w.project.water.sea.level;
    const b = window.__app.engine.objects.objects.get('buoy').body.pos;
    window.__ev.pose({ mode: 'fly', position: [b.x + 9, sea + 2.4, b.z + 7], lookAt: [b.x, sea + 1.0, b.z] }, 120);
  });
  await sequence(ctx, dir, 'interact-buoy', 'Buoy riding the swell beyond the breakers (rigid-body buoyancy against the simulated surface)', sec, { frames: 12, stepFrames: 15 });
  // underwater near shore + crossing
  await page.evaluate((s) => {
    const w = window.__app.world;
    const sea = w.project.water.sea.level;
    // first place off the beach where the still water is about 1.8 m deep
    let x = s.beach.x + s.seaDir.x * 60, z = s.beach.z + s.seaDir.z * 60;
    for (let t = 8; t < 120; t += 2) {
      const px = s.beach.x + s.seaDir.x * t, pz = s.beach.z + s.seaDir.z * t;
      if (sea - w.heightAt(px, pz) > 1.8) { x = px; z = pz; break; }
    }
    window.__uw = { x, z };
    window.__ev.pose({ mode: 'fly', position: [x, sea - 0.95, z], lookAt: [x + s.along.x * 12 - s.seaDir.x * 6, sea - 1.25, z + s.along.z * 12 - s.seaDir.z * 6] }, 120);
  }, si);
  await still(ctx, dir, 'day-underwater', 'Camera 0.95 m under the sea surface where the water is about 1.8 m deep, looking along the shore over the sand bed (caustics, underside of the surface, attenuation).', sec);
  await sequence(ctx, dir, 'motion-underwater', 'Under the surface while waves pass overhead', sec, { frames: 8, stepFrames: 10 });
  await sequence(ctx, dir, 'transition-surface', 'Camera crossing the sea surface while waves pass: lens height −0.8, −0.5, −0.3, −0.15, −0.05, 0, +0.05, +0.15, +0.3, +0.5, +0.7, +0.9 m relative to the still sea level', sec, {
    frames: 12,
    stepFrames: 3,
    each: (i) => {
      const sea = window.__app.world.project.water.sea.level;
      const p = window.__app.cam.getPose();
      const offs = [-0.8, -0.5, -0.3, -0.15, -0.05, 0.0, 0.05, 0.15, 0.3, 0.5, 0.7, 0.9];
      window.__app.cam.setPose({ mode: 'fly', position: [p.position[0], sea + offs[i], p.position[2]], yaw: p.yaw, pitch: 0.0 });
    },
  });
  // navigation: walk along the waterline, then fly along the coast
  {
    const pts = await page.evaluate((s) => {
      const w = window.__app.world;
      const sea = w.project.water.sea.level;
      const gp = (x, z, h) => [x, Math.max(w.heightAt(x, z), sea) + h, z];
      const bx = s.beach.x - s.seaDir.x * 4, bz = s.beach.z - s.seaDir.z * 4;
      return {
        w0: gp(bx - s.along.x * 14, bz - s.along.z * 14, 1.7), w1: gp(bx + s.along.x * 14, bz + s.along.z * 14, 1.7),
        wl: [bx + s.along.x * 60 + s.seaDir.x * 30, sea + 0.5, bz + s.along.z * 60 + s.seaDir.z * 30],
        f0: [s.beach.x + s.seaDir.x * 40 - s.along.x * 130, sea + 14, s.beach.z + s.seaDir.z * 40 - s.along.z * 130], f1: [s.beach.x + s.seaDir.x * 40 + s.along.x * 130, sea + 14, s.beach.z + s.seaDir.z * 40 + s.along.z * 130],
      };
    }, si);
    await realtime(ctx, dir, 'realtime-walk-beach', 'Real-time stability: walking along the beach (swash, foam, breakers)', sec, { from: pts.w0, to: [pts.w0[0] + (pts.w1[0] - pts.w0[0]) * 0.115, pts.w0[1], pts.w0[2] + (pts.w1[2] - pts.w0[2]) * 0.115], look: pts.wl });
    await travel(ctx, dir, 'nav-walk-beach', 'Navigation: walking along the beach just above the swash, looking along the shore', sec, { from: pts.w0, to: pts.w1, look: pts.wl, frames: 16, stepFrames: 12 });
    await travel(ctx, dir, 'nav-fly-coast', 'Navigation: flight along the surf zone 14 m above the sea', sec, { from: pts.f0, to: [pts.f0[0] + (pts.f1[0] - pts.f0[0]) * 0.2, pts.f0[1], pts.f0[2] + (pts.f1[2] - pts.f0[2]) * 0.2], frames: 32, stepFrames: 6 });
  }
  // lighting
  await page.evaluate(() => window.__ev.env({ timeOfDay: 19.4, cloudCover: 0.55 }));
  await page.evaluate(() => window.__ev.pose(window.__app.world.project.cameras[0], 220));
  await still(ctx, dir, 'evening-opening-beach', 'Second lighting condition: low sun over the sea (glitter path, warm light on the surf).', sec);
  await page.evaluate(() => window.__ev.pose(window.__app.world.project.cameras[1], 150));
  await still(ctx, dir, 'evening-aerial', 'Aerial view, evening.', sec);
  await page.evaluate(() => window.__ev.env({ timeOfDay: 12.5, cloudCover: 0.95, windSpeed: 11 }));
  await page.evaluate(() => window.__ev.pose(window.__app.world.project.cameras[0], 220));
  await still(ctx, dir, 'storm-opening-beach', 'Third condition: overcast, wind 11 m/s (rougher wind sea, whitecaps).', sec);
  await page.evaluate(() => window.__ev.env({ timeOfDay: 15.2, cloudCover: 0.42, windSpeed: 6.5 }));
  // ---- edit: sea level and swell ----
  await page.evaluate(() => window.__ev.pose(window.__app.world.project.cameras[1], 150));
  await still(ctx, dir, 'edit-sea-0-before', 'Sea edit, BEFORE (aerial).', sec);
  await page.evaluate(() => {
    window.__app.edit('Sea level', (d) => (d.water.sea.level -= 1.0), 'water');
    window.__ev.settle(200);
  });
  await still(ctx, dir, 'edit-sea-1-lowered', 'Sea level lowered by 1.0 m: wider beach, exposed wet sand and rocks, the breaker line moves seaward (swell re-solved over the new depths).', sec);
  await page.evaluate(() => {
    window.__app.edit('Sea level', (d) => (d.water.sea.level += 1.0), 'water');
    window.__app.edit('Swell', (d) => {
      d.water.swell.height = 1.9;
      d.water.swell.period = 12;
    }, 'water');
    window.__ev.settle(200);
  });
  await still(ctx, dir, 'edit-sea-2-big-swell', 'Original level, swell raised to 1.9 m / 12 s: waves break further out (deeper water), wider surf zone and run-up.', sec);
  await sequence(ctx, dir, 'motion-big-swell', 'Big swell from the air', sec, { frames: 8, stepFrames: 15 });
  const info = await page.evaluate(() => window.__ev.info());
  await page.close();
  return { info, errors: ctx.errors };
}

const browser = await chromium.launch({ headless: true, channel: 'chromium', args: ['--use-angle=vulkan', '--enable-features=Vulkan', '--enable-gpu', '--ignore-gpu-blocklist'] });
const results = {};
const t0 = Date.now();
try {
  if (only.includes('valley')) results.valley = await valley(browser);
  if (only.includes('lake')) results.lake = await lake(browser);
  if (only.includes('coast')) results.coast = await coast(browser);
} finally {
  await browser.close();
}
const build = process.env.BUILD_ID || buildId();
const meta = { build, gitHead: execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: ROOT }).toString().trim() + ' (+ uncommitted working tree; `build` is a hash of src/, server/ and the showcase documents)', captured: new Date().toISOString(), viewport: `${W}x${H}`, quality, browser: 'Chromium (Playwright), ANGLE/Vulkan, headless', results };
writeFileSync(join(outDir, 'index.json'), JSON.stringify({ meta, index }, null, 1));
let md = `# Review evidence\n\n- build: \`${build}\`\n- captured: ${meta.captured}\n- viewport: ${W}×${H}, quality preset: ${quality}\n- GPU: ${Object.values(results)[0]?.info?.gpu || 'n/a'}\n- All images are direct captures of the editor viewport canvas (no retouching, no compositing other than tiling frames into contact sheets). Sequences advance the simulation with a fixed time step between frames.\n- Edits are made through the editor's own code paths (document edits with undo, sculpt tool strokes) and are not saved.\n\n`;
let cur = '';
for (const e of index) {
  if (e.section !== cur) {
    cur = e.section;
    md += `\n## ${cur}\n\n`;
  }
  md += `- \`${e.file.replace(outDir + '/', '')}\` — ${e.text}\n`;
}
writeFileSync(join(outDir, 'INDEX.md'), md);
console.log(`evidence written to ${outDir} in ${((Date.now() - t0) / 1000).toFixed(0)} s; build ${build}`);
for (const [k, r] of Object.entries(results)) console.log(k, 'fps', r.info.fps.fps?.toFixed(1), 'page errors', r.errors.length, r.errors.slice(0, 2));
