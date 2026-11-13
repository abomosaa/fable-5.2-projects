// Generates the media used by the browser tests with FFmpeg (no binary fixtures in
// the repository). The throw-away data directory is reset by the web server command.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const TMP = path.join(here, '.tmp');
export const MEDIA = path.join(TMP, 'media');
export const CLIP = path.join(MEDIA, 'talk.mp4');
export const CLIP_SECONDS = 10;

export default function globalSetup() {
  fs.mkdirSync(MEDIA, { recursive: true });
  const ffmpeg = process.env.FFMPEG_PATH || 'ffmpeg';
  try {
    execFileSync(ffmpeg, ['-version'], { stdio: 'ignore' });
  } catch {
    throw new Error('FFmpeg is required for the browser tests (set FFMPEG_PATH if it is not on PATH).');
  }
  // 10 s of moving test pattern with a burnt-in frame counter and a tone that
  // pauses, so cuts, waveforms and silence detection have something real to show.
  execFileSync(
    ffmpeg,
    [
      '-v', 'error', '-y',
      '-f', 'lavfi', '-i', `testsrc2=size=640x360:rate=30:duration=${CLIP_SECONDS}`,
      '-f', 'lavfi', '-i', `aevalsrc=exprs='0.4*sin(2*PI*220*t)*gt(sin(2*PI*0.4*t)\\,-0.3)':s=48000:d=${CLIP_SECONDS}`,
      '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-g', '30',
      '-c:a', 'aac', '-b:a', '128k', '-shortest', CLIP,
    ],
    { stdio: 'inherit' },
  );
}
