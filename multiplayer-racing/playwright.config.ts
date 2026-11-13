import { defineConfig } from '@playwright/test';

const PORT = Number(process.env.E2E_PORT ?? 8123);

/**
 * Browser tests run against the production build served by the real game
 * server (`npm run test:e2e` builds first). Headless Chromium renders WebGL in
 * software, hence the SwiftShader flags and generous timeouts.
 */
export default defineConfig({
  testDir: 'e2e',
  timeout: 150_000,
  expect: { timeout: 20_000 },
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: [['list']],
  outputDir: 'test-results/e2e',
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    viewport: { width: 960, height: 600 },
    trace: 'retain-on-failure',
    launchOptions: {
      args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--mute-audio'],
    },
  },
  webServer: {
    command: 'node dist/server/main.js',
    url: `http://127.0.0.1:${PORT}/readyz`,
    reuseExistingServer: false,
    timeout: 30_000,
    env: {
      NODE_ENV: 'production',
      HOST: '127.0.0.1',
      PORT: String(PORT),
      LOG_LEVEL: 'warn',
      DATA_DIR: 'test-results/data',
      REGION: 'e2e-local',
    },
  },
});
