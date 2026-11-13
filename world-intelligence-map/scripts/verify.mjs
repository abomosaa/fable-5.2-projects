#!/usr/bin/env node
/**
 * The one verification command:  npm run verify
 *
 *   1. type-check server, web client and end-to-end tests
 *   2. server tests  (adapters on fixtures, normalisation, pipeline, resilience, queries, API + DB integration, 50k volume)
 *   3. web unit tests
 *   4. production build (web bundle + server bundle)
 *   5. end-to-end browser tests against the production build in fixture mode (Playwright + axe)
 *
 * Needs no internet access and no secrets. Step 5 needs a Chromium for Playwright (`npx playwright install chromium`);
 * pass --skip-e2e to leave it out.
 */
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const skipE2e = process.argv.includes('--skip-e2e');
const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx';
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';

const steps = [
  ['Type-check server', npx, ['tsc', '--noEmit', '-p', 'server/tsconfig.json']],
  ['Type-check web client', npx, ['tsc', '--noEmit', '-p', 'web/tsconfig.json']],
  ['Type-check end-to-end tests', npx, ['tsc', '--noEmit', '-p', 'e2e/tsconfig.json']],
  ['Server tests', npm, ['run', 'test', '-w', 'server', '--silent']],
  ['Web unit tests', npm, ['run', 'test', '-w', 'web', '--silent']],
  ['Production build', npm, ['run', 'build', '--silent']],
  ...(skipE2e ? [] : [['End-to-end tests (fixture mode)', npx, ['playwright', 'test', '-c', 'e2e/playwright.config.ts']]]),
];

const results = [];
for (const [name, cmd, args] of steps) {
  console.log(`\n── ${name} ──`);
  const t0 = Date.now();
  // The network is not needed; make accidental use visible by pointing proxies nowhere.
  const res = spawnSync(cmd, args, { cwd: root, stdio: 'inherit', env: { ...process.env, WIM_MODE: 'fixture', NO_UPDATE_NOTIFIER: '1', npm_config_update_notifier: 'false' } });
  const ok = res.status === 0;
  results.push({ name, ok, sec: ((Date.now() - t0) / 1000).toFixed(1) });
  if (!ok) break;
}

console.log('\n── Summary ──');
for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name} (${r.sec} s)`);
if (skipE2e) console.log('SKIP  End-to-end tests (--skip-e2e)');
const failed = results.some((r) => !r.ok) || results.length < steps.length;
console.log(failed ? '\nVerification FAILED.' : '\nVerification passed.');
process.exit(failed ? 1 : 0);
