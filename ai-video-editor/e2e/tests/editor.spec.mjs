// End-to-end browser test of the whole editing loop, against a real server in
// fixture mode (deterministic fixture transcripts; no external services, no secrets):
//
//   create project → import generated media → add to timeline → split → trim →
//   transcript-linked ripple edit → captions → autosave + reload → export →
//   the export is a real, playable, composited video of the expected duration.
import { test, expect } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { CLIP, CLIP_SECONDS, TMP } from '../global-setup.mjs';

const TPS = 705_600_000;
const FRAME = TPS / 30;

/** Snapshot of the client's mirror of the project document. */
const snapshot = (page) =>
  page.evaluate(() => {
    const s = window.__cutline.store.state;
    const clips = [...s.doc.clips.values()];
    return {
      revision: s.doc.revision,
      duration: s.duration,
      clips: clips.map((c) => ({ id: c.id, kind: c.content.kind, start: c.start, duration: c.duration, source_in: c.source_in, link: c.link_id, track: c.track_id })).sort((a, b) => a.start - b.start || a.kind.localeCompare(b.kind)),
      removals: s.doc.transcript.removals.length,
      canUndo: s.history.can_undo,
      pxPerSec: s.view.pxPerSec,
      scrollX: s.view.scrollX,
    };
  });

const seek = (page, seconds) => page.evaluate((t) => window.__cutline.transport.seek(t), Math.round(seconds * TPS));
const saved = (page) => expect(page.getByTestId('save-status')).toContainText('Saved');

function ffprobe(file) {
  const out = execFileSync(process.env.FFPROBE_PATH || 'ffprobe', ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file], { encoding: 'utf8' });
  return JSON.parse(out);
}

test('import, split, trim, transcript edit, captions, reload and export', async ({ page }) => {
  const problems = [];
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
  page.on('console', (m) => m.type() === 'error' && problems.push(`console: ${m.text()}`));

  // ---- create a project --------------------------------------------------------
  await page.goto('/');
  await expect(page.getByTestId('fixture-badge')).toBeVisible(); // fixture mode is labelled
  await page.getByTestId('new-project').first().click();
  await page.getByTestId('project-name-field').fill('E2E round trip');
  await page.getByTestId('project-name-field').press('Enter');
  await expect(page).toHaveURL(/#\/p\/\w+/);
  await expect(page.getByTestId('timeline-view')).toBeVisible();

  // ---- import generated media --------------------------------------------------
  await page.getByTestId('import-input').setInputFiles(CLIP);
  const asset = page.locator('[data-testid="asset-item"][data-state="ready"]');
  await expect(asset).toHaveCount(1, { timeout: 60_000 });

  // ---- put it on the timeline: a linked video + audio pair ---------------------
  await asset.dblclick();
  await expect(page.locator('.tl-clip')).toHaveCount(2);
  let s = await snapshot(page);
  expect(s.clips.map((c) => c.kind)).toEqual(['audio', 'video']);
  expect(s.clips[0].link).toBeTruthy();
  expect(s.clips[0].link).toBe(s.clips[1].link);
  expect(Math.abs(s.duration - CLIP_SECONDS * TPS)).toBeLessThanOrEqual(2 * FRAME);
  const fullDuration = s.duration;

  // ---- split at 4 s --------------------------------------------------------------
  await seek(page, 4);
  await page.getByTestId('timeline-view').focus();
  await page.keyboard.press('Escape'); // nothing selected → split every track
  await page.keyboard.press('s');
  await expect(page.locator('.tl-clip')).toHaveCount(4);
  s = await snapshot(page);
  const firstVideo = s.clips.find((c) => c.kind === 'video' && c.start === 0);
  const secondVideo = s.clips.find((c) => c.kind === 'video' && c.start === 4 * TPS);
  expect(firstVideo.duration).toBe(4 * TPS);
  expect(secondVideo.source_in).toBe(4 * TPS); // the right half continues exactly where the left stops
  expect(secondVideo.link).not.toBe(firstVideo.link); // each side keeps its own A/V link

  // ---- trim the tail of the last clip by one second (dragging its edge) --------
  const box = await page.locator(`.tl-clip[data-clip-id="${secondVideo.id}"]`).boundingBox();
  const px = s.pxPerSec; // px per second at the current zoom
  await page.mouse.move(box.x + box.width - 3, box.y + 8);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width - 3 - px / 2, box.y + 8, { steps: 5 });
  await page.mouse.move(box.x + box.width - 3 - px, box.y + 8, { steps: 5 });
  await page.mouse.up();
  await expect.poll(async () => (await snapshot(page)).duration).toBeLessThan(fullDuration);
  s = await snapshot(page);
  const trimmed = fullDuration - s.duration;
  expect(Math.abs(trimmed - TPS)).toBeLessThanOrEqual(3 * FRAME); // ≈ one second, on the frame grid
  expect(s.duration % FRAME).toBe(0);
  // the linked audio clip was trimmed together with the picture
  const tail = s.clips.filter((c) => c.start === 4 * TPS);
  expect(tail).toHaveLength(2);
  expect(tail[0].duration).toBe(tail[1].duration);
  const afterTrim = s.duration;

  // ---- preview: the playhead and the monitor stay in step ----------------------
  await seek(page, 1);
  await expect(page.getByTestId('timecode')).toContainText('00:00:01:00');
  await page.getByTestId('play-toggle').click();
  await expect.poll(() => page.evaluate(() => window.__cutline.transport.time / 705_600_000), { timeout: 10_000 }).toBeGreaterThan(1.5);
  await page.getByTestId('play-toggle').click();
  expect(await page.evaluate(() => window.__cutline.transport.playing)).toBe(false);

  // ---- transcript-based editing (fixture transcript, labelled as such) ---------
  await page.locator('#tab-transcript').click();
  await page.getByTestId('enable-transcript').click();
  const words = page.getByTestId('word');
  await expect(words.first()).toBeVisible({ timeout: 60_000 });
  await expect(page.getByTestId('fixture-transcript')).toBeVisible();
  const wordCount = await words.count();
  expect(wordCount).toBeGreaterThan(8);

  // clicking a word moves the playhead to exactly that word
  await words.nth(2).click();
  const view = await page.evaluate(() => window.__cutline.store.state.transcript.view);
  const flat = view.segments.flatMap((seg) => seg.words.map((w) => ({ ...w, clip_id: seg.clip_id })));
  const clicked = flat[2];
  // (word-accurate: the playhead lands on the word's own start, not just the nearest frame)
  await expect.poll(() => page.evaluate(() => window.__cutline.transport.time)).toBe(clicked.start);

  // select words 2..3 and delete them → one ripple edit against their source range
  await words.nth(3).click({ modifiers: ['Shift'] });
  await expect(page.getByTestId('delete-words')).toBeVisible();
  const removedText = `${flat[2].text} ${flat[3].text}`;
  const removedSpan = flat[3].end - flat[2].start;
  await page.getByTestId('delete-words').click();
  await expect(page.getByTestId('removed-chip')).toHaveCount(1);
  await expect(page.getByTestId('removed-chip')).toContainText(flat[2].text);
  s = await snapshot(page);
  expect(s.removals).toBe(1);
  // the timeline got shorter by (about) the removed words…
  expect(afterTrim - s.duration).toBeGreaterThan(0);
  expect(Math.abs(afterTrim - s.duration - removedSpan)).toBeLessThanOrEqual(2 * FRAME);
  // …and the cut is traceable to the source range it removed
  const trace = await page.evaluate(() => window.__cutline.store.state.doc.transcript.removals[0]);
  expect(trace.reason).toBe('manual');
  expect(trace.source_start).toBe(flat[2].source_start);
  expect(trace.source_end).toBeGreaterThanOrEqual(flat[3].source_start);
  expect(trace.text).toContain(flat[2].text.replace(/[.,!?]$/, ''));
  // picture and sound were cut together and stay linked and in sync
  for (const v of s.clips.filter((c) => c.kind === 'video')) {
    const a = s.clips.find((c) => c.kind === 'audio' && c.start === v.start);
    expect(a, `audio partner of ${v.id}`).toBeTruthy();
    expect(a.duration).toBe(v.duration);
    expect(a.source_in).toBe(v.source_in);
    expect(a.link).toBe(v.link);
  }
  // the removed words are gone from the readable transcript
  await expect(words).toHaveCount(wordCount - 2);
  expect(removedText.length).toBeGreaterThan(0);
  const afterWords = s.duration;

  // ---- captions from the transcript --------------------------------------------
  await page.getByTestId('captions-button').click();
  await page.getByTestId('generate-captions-go').click();
  await expect.poll(async () => (await snapshot(page)).clips.filter((c) => c.kind === 'caption').length).toBeGreaterThan(1);
  await expect(page.locator('.tl-clip[data-kind="caption"]').first()).toBeVisible();
  // close whatever follow-up the captions flow shows
  await page.keyboard.press('Escape');

  // ---- autosave + reload ---------------------------------------------------------
  await saved(page);
  const before = await snapshot(page);
  const url = page.url();
  await page.reload();
  await expect(page.locator('.tl-clip').first()).toBeVisible();
  const after = await snapshot(page);
  expect(after.revision).toBe(before.revision);
  expect(after.duration).toBe(afterWords);
  expect(after.clips).toEqual(before.clips);
  expect(after.removals).toBe(1);
  expect(after.canUndo).toBe(true); // undo history survives a reload
  // the project is listed on the home screen and reopens to the same state
  await page.goto('/');
  await expect(page.locator('[data-testid="project-card"]').filter({ hasText: 'E2E round trip' })).toBeVisible();
  await page.goto(url);
  await expect(page.locator('.tl-clip').first()).toBeVisible();
  expect((await snapshot(page)).revision).toBe(before.revision);

  // ---- export ---------------------------------------------------------------------
  await page.getByTestId('open-export').click();
  await expect(page.getByTestId('export-dialog')).toBeVisible();
  await page.getByTestId('export-quality-draft').click();
  await page.getByTestId('export-start').click();
  const video = page.getByTestId('export-video');
  await expect(video).toBeVisible({ timeout: 150_000 });
  const expectedSeconds = afterWords / TPS;
  // playable in the browser, with the right duration and size
  await expect.poll(() => video.evaluate((v) => v.readyState), { timeout: 20_000 }).toBeGreaterThanOrEqual(2);
  const meta = await video.evaluate((v) => ({ w: v.videoWidth, h: v.videoHeight, d: v.duration }));
  expect(meta.w).toBe(1920);
  expect(meta.h).toBe(1080);
  expect(Math.abs(meta.d - expectedSeconds)).toBeLessThan(0.2);
  await video.evaluate((v) => {
    v.muted = true;
    return v.play();
  });
  await expect.poll(() => video.evaluate((v) => v.currentTime), { timeout: 15_000 }).toBeGreaterThan(0.2);

  // the downloadable file is a real render: non-empty, video + audio, expected length
  const href = await page.getByTestId('export-download').getAttribute('href');
  const res = await page.request.get(href);
  expect(res.status()).toBe(200);
  expect(res.headers()['content-disposition']).toContain('attachment');
  const bytes = await res.body();
  expect(bytes.length).toBeGreaterThan(50_000);
  const out = path.join(TMP, 'export.mp4');
  fs.writeFileSync(out, bytes);
  const probe = ffprobe(out);
  const v = probe.streams.find((st) => st.codec_type === 'video');
  const a = probe.streams.find((st) => st.codec_type === 'audio');
  expect(v, 'video stream').toBeTruthy();
  expect(a, 'audio stream').toBeTruthy();
  expect(v.codec_name).toBe('h264');
  expect([v.width, v.height]).toEqual([1920, 1080]); // composited at project size, not the 640×360 source
  expect(Math.abs(Number(probe.format.duration) - expectedSeconds)).toBeLessThan(0.2);
  expect(bytes.length).not.toBe(fs.statSync(CLIP).size); // not the unchanged source file
  // exact frame count: the render used the same timeline as the editor
  const frames = execFileSync(process.env.FFPROBE_PATH || 'ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-count_packets', '-show_entries', 'stream=nb_read_packets', '-of', 'csv=p=0', out], { encoding: 'utf8' }).trim();
  expect(Number(frames)).toBe(Math.round(afterWords / FRAME));

  expect(problems, 'no console errors during the session').toEqual([]);
});

test('undo and redo restore the timeline exactly', async ({ page }) => {
  await page.goto('/');
  await page.getByTestId('new-project').first().click();
  await page.getByTestId('project-name-field').fill('E2E undo');
  await page.getByTestId('project-name-field').press('Enter');
  await expect(page.getByTestId('timeline-view')).toBeVisible();
  await page.getByTestId('import-input').setInputFiles(CLIP);
  const asset = page.locator('[data-testid="asset-item"][data-state="ready"]');
  await expect(asset).toHaveCount(1, { timeout: 60_000 });
  await asset.dblclick();
  await expect(page.locator('.tl-clip')).toHaveCount(2);
  const base = await snapshot(page);

  await seek(page, 3);
  await page.getByTestId('timeline-view').focus();
  await page.keyboard.press('Escape');
  await page.keyboard.press('s');
  await expect(page.locator('.tl-clip')).toHaveCount(4);
  // select the first pair (click selects the linked partner too) and ripple delete it
  const first = (await snapshot(page)).clips.find((c) => c.kind === 'video' && c.start === 0);
  await page.locator(`.tl-clip[data-clip-id="${first.id}"]`).click({ position: { x: 30, y: 30 } });
  expect(await page.evaluate(() => window.__cutline.store.state.sel.clips.size)).toBe(2);
  await page.keyboard.press('Shift+Delete');
  await expect(page.locator('.tl-clip')).toHaveCount(2);
  const edited = await snapshot(page);
  expect(edited.duration).toBe(base.duration - 3 * TPS);
  expect(edited.clips.every((c) => c.start === 0)).toBe(true); // the gap was closed

  await page.getByTestId('undo').click();
  await page.getByTestId('undo').click();
  await expect(page.locator('.tl-clip')).toHaveCount(2);
  const undone = await snapshot(page);
  expect(undone.duration).toBe(base.duration);
  expect(undone.clips).toEqual(base.clips);
  await page.getByTestId('redo').click();
  await page.getByTestId('redo').click();
  await expect.poll(async () => (await snapshot(page)).duration).toBe(edited.duration);
  expect((await snapshot(page)).clips).toEqual(edited.clips);
});
