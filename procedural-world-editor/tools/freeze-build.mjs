// Freeze the current working tree into a self-contained review build:
//   node tools/freeze-build.mjs <dir>
// writes <dir>/dist (production build), <dir>/showcases (copy), <dir>/projects (empty working
// copies are created by the server), <dir>/BUILD_ID, and prints the command that serves it.
// A review is run against this frozen copy so later source edits cannot change what is reviewed.
import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, writeFileSync, rmSync, readdirSync, statSync, readFileSync, existsSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dir = resolve(process.argv[2] || '.cache/frozen');
const h = createHash('sha256');
const walk = (d) => {
  for (const f of readdirSync(d).sort()) {
    const p = join(d, f);
    if (statSync(p).isDirectory()) walk(p);
    else if (/\.(js|mjs|css|html|json)$/.test(f)) h.update(f).update(readFileSync(p));
  }
};
for (const d of ['src', 'server']) walk(join(ROOT, d));
for (const s of ['showcase-valley', 'showcase-lake', 'showcase-coast']) { const p = join(ROOT, 'showcases', s, 'project.json'); if (existsSync(p)) h.update(readFileSync(p)); }
const id = h.digest('hex').slice(0, 12);
rmSync(dir, { recursive: true, force: true });
mkdirSync(dir, { recursive: true });
execFileSync('npx', ['vite', 'build', '--outDir', join(dir, 'dist'), '--emptyOutDir'], { cwd: ROOT, stdio: 'inherit' });
cpSync(join(ROOT, 'showcases'), join(dir, 'showcases'), { recursive: true });
mkdirSync(join(dir, 'projects'));
mkdirSync(join(dir, 'exports'));
writeFileSync(join(dir, 'BUILD_ID'), id + '\n');
console.log(`frozen build ${id} in ${dir}`);
console.log(`serve: TERRAFORGE_DIST=${join(dir, 'dist')} TERRAFORGE_SHOWCASES=${join(dir, 'showcases')} TERRAFORGE_PROJECTS=${join(dir, 'projects')} TERRAFORGE_EXPORTS=${join(dir, 'exports')} node server/server.mjs --port 5180`);
