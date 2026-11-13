import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'unit',
          include: ['tests/sim/**/*.test.ts', 'tests/protocol/**/*.test.ts', 'tests/server/**/*.test.ts', 'tests/net/**/*.test.ts'],
          environment: 'node',
          testTimeout: 30_000,
        },
      },
      {
        test: {
          name: 'integration',
          include: ['tests/integration/**/*.test.ts'],
          environment: 'node',
          testTimeout: 90_000,
          hookTimeout: 30_000,
        },
      },
    ],
  },
});
