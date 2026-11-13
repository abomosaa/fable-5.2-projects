// Bundles the game server into a single ES module at dist/server/main.js.
import { build } from 'esbuild';

await build({
  entryPoints: ['server/src/main.ts'],
  outfile: 'dist/server/main.js',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  // Runtime dependencies stay external and are loaded from node_modules.
  packages: 'external',
  sourcemap: true,
  legalComments: 'none',
  logLevel: 'info',
});
