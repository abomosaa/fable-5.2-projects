// Playwright configuration for the Cutline browser tests.
//
// The tests start their own server in deterministic fixture mode on a private port
// with a throw-away data directory, so they never touch real projects, external
// services or secrets.
import { defineConfig } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const PORT = Number(process.env.CUTLINE_E2E_PORT || 4399);
const dataDir = path.join(here, '.tmp', 'data');

/** Prefer an explicitly given Chrome, else a Chromium that Playwright already downloaded. */
function findChrome() {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  const cache = process.env.PLAYWRIGHT_BROWSERS_PATH || path.join(os.homedir(), '.cache', 'ms-playwright');
  try {
    const builds = fs
      .readdirSync(cache)
      .filter((d) => /^chromium-\d+$/.test(d))
      .sort((a, b) => Number(b.split('-')[1]) - Number(a.split('-')[1]));
    for (const b of builds) {
      for (const rel of ['chrome-linux64/chrome', 'chrome-linux/chrome', 'chrome-mac/Chromium.app/Contents/MacOS/Chromium', 'chrome-win/chrome.exe']) {
        const p = path.join(cache, b, rel);
        if (fs.existsSync(p)) return p;
      }
    }
  } catch {
    /* no cache: fall through to Playwright's default (run `npx playwright install chromium`) */
  }
  return undefined;
}

export default defineConfig({
  testDir: './tests',
  timeout: 180_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  globalSetup: './global-setup.mjs',
  outputDir: './test-results',
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    viewport: { width: 1440, height: 900 },
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    launchOptions: {
      executablePath: findChrome(),
      args: ['--autoplay-policy=no-user-gesture-required'],
    },
  },
  webServer: {
    // `cargo run` builds on first use; the debug binary serves the embedded UI.
    // Start from an empty data directory every run (done here, before the server
    // starts, because Playwright launches the web server ahead of globalSetup).
    command: `node -e "require('fs').rmSync(process.argv[1],{recursive:true,force:true})" "${dataDir}" && cargo run --quiet -p cutline-server -- --fixture --port ${PORT} --data-dir "${dataDir}"`,
    cwd: root,
    url: `http://127.0.0.1:${PORT}/api/health`,
    timeout: 900_000,
    reuseExistingServer: false,
    env: { CUTLINE_FIXTURE_STEP_MS: '150' },
    stdout: 'pipe',
    stderr: 'pipe',
  },
});
