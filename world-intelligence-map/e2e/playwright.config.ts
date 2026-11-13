import { defineConfig, devices } from '@playwright/test';

const PORT = Number(process.env.WIM_E2E_PORT ?? 8791);

/**
 * End-to-end tests run against the production build in fixture mode: no internet, no secrets.
 * `--scenario=static` keeps the time-independent demo conditions (one stale source, one source without credentials)
 * and leaves out the scripted failures that change over time, so assertions are deterministic.
 */
export default defineConfig({
  testDir: '.',
  testMatch: /.*\.spec\.ts/,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 2,
  retries: 0,
  reporter: [['list']],
  outputDir: '../test-results',
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    trace: 'retain-on-failure',
    // Headless Chromium needs software WebGL for MapLibre.
    launchOptions: { args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] },
  },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } }, testIgnore: /mobile\.spec\.ts/ },
    { name: 'mobile', use: { ...devices['Pixel 7'] }, testMatch: /mobile\.spec\.ts/ },
  ],
  webServer: {
    command: `node server/dist/index.js --mode=fixture --port=${PORT} --scenario=static --stale-hold=86400 --volume=50000 --quiet`,
    cwd: '..',
    url: `http://127.0.0.1:${PORT}/healthz`,
    reuseExistingServer: false,
    timeout: 60_000,
  },
});
