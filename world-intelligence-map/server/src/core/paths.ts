import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

function findUp(start: string, marker: string): string {
  let dir = start;
  for (let i = 0; i < 6; i++) {
    if (existsSync(path.join(dir, marker))) return dir;
    dir = path.dirname(dir);
  }
  throw new Error(`cannot locate ${marker} from ${start}`);
}

/** server/ package root – works from src/ (tsx, vitest) and from dist/ (bundled build). */
export function serverRoot(): string {
  return process.env.WIM_SERVER_ROOT ?? findUp(here, 'assets');
}
export function assetPath(): string {
  return path.join(serverRoot(), 'assets');
}
/** Directory that contains one sub-directory per adapter (manifest.json + fixtures/). */
export function adaptersPath(): string {
  return path.join(serverRoot(), 'src', 'adapters');
}
export function repoRoot(): string {
  return path.dirname(serverRoot());
}
