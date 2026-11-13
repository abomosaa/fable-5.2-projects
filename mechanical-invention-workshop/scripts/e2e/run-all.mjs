#!/usr/bin/env node
/**
 * Runs every end-to-end UI workflow against a running app.
 *   npm start            (in another terminal; note the printed URL)
 *   MW_URL=http://127.0.0.1:4173/ npm run e2e
 */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
const scripts = ['01-build-linkage', '02-edit-undo-save', '03-showcases', '04-sketch-export-offline', '06-review-regressions', '07-review-round2'];
let fail = 0, pass = 0;
for (const s of scripts) {
  console.log(`\n=== ${s}`);
  const r = spawnSync(process.execPath, [`scripts/e2e/${s}.mjs`], { stdio: 'inherit', env: process.env });
  try { const j = JSON.parse(readFileSync(`${process.env.MW_OUT ?? 'docs/verification/e2e'}/${s}.json`, 'utf8')); pass += j.steps.filter((x) => x.ok === true).length; fail += j.failures; } catch { fail++; }
  if (r.status !== 0) fail = Math.max(fail, 1);
}
console.log(`\nEnd-to-end: ${pass} checks passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
