/** Process entry point: configuration, startup and signal handling. */
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createGameServer } from './app';
import { ConfigError, loadConfig } from './config';

async function main(): Promise<void> {
  const config = loadConfig();

  // Serve the built client when it sits next to the server bundle
  // (dist/server/main.js -> dist/client), unless STATIC_DIR says otherwise.
  if (config.staticDir === null) {
    const here = dirname(fileURLToPath(import.meta.url));
    for (const candidate of [resolve(here, '../client'), resolve(here, '../../dist/client')]) {
      if (existsSync(resolve(candidate, 'index.html'))) {
        config.staticDir = candidate;
        break;
      }
    }
  }
  if (config.dataDir === null && config.env !== 'test') config.dataDir = resolve(process.cwd(), 'data');

  const server = await createGameServer(config);
  const shown = config.host === '0.0.0.0' || config.host === '::' ? 'localhost' : config.host;
  if (config.staticDir) console.log(`\n  Apex Drift is running at ${config.publicUrl ?? `http://${shown}:${server.port}`}\n`);
  else console.log(`\n  Apex Drift game server on ${shown}:${server.port} (no client build found; use "npm run dev" or "npm run build")\n`);

  let exiting = false;
  const shutdown = (signal: string): void => {
    if (exiting) return;
    exiting = true;
    console.log(`\n  ${signal} received, shutting down...`);
    // Never hang on shutdown.
    setTimeout(() => process.exit(1), 10_000).unref();
    server.stop().then(
      () => process.exit(0),
      () => process.exit(1),
    );
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((error: unknown) => {
  if (error instanceof ConfigError) console.error(`Configuration error: ${error.message}`);
  else console.error(error);
  process.exit(1);
});
