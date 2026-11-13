/** CLI entry point: `node dist/index.js --mode=live|fixture [--port=8787] [--host=127.0.0.1]`. */
import { createApp } from './app.ts';
import { buildServer } from './api/server.ts';
import { loadConfig, loadDotEnv } from './config.ts';
import { FIXTURE_EPOCH_ISO } from './core/fixtureEpoch.ts';

async function main(): Promise<void> {
  loadDotEnv();
  const config = loadConfig();
  const app = createApp(config);
  const server = await buildServer(app);

  const shutdown = async (signal: string) => {
    console.log(`\n[server] ${signal} – shutting down`);
    try {
      await server.close();
      await app.close();
    } finally {
      process.exit(0);
    }
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  await server.listen({ host: config.host, port: config.port });
  const address = server.server.address();
  const port = typeof address === 'object' && address ? address.port : config.port;
  const banner = config.mode === 'fixture'
    ? `FIXTURE MODE – bundled sample data on a simulated clock starting ${FIXTURE_EPOCH_ISO}. Not live intelligence.`
    : 'LIVE MODE – fetching real public sources. Optional sources without credentials are reported as misconfigured.';
  console.log(`[server] World Intelligence Map → http://${config.host === '0.0.0.0' ? 'localhost' : config.host}:${port}`);
  console.log(`[server] ${banner}`);
  console.log(`[server] ${app.catalog.sources.size} sources, ${app.catalog.layers.size} layers`);

  // Ingestion starts after the API is up: the map is usable (with per-source "pending" states) immediately.
  if (config.mode === 'fixture') await app.prepareDemo();
  app.scheduler.start();
}

main().catch((err) => {
  console.error('[server] fatal:', err);
  process.exit(1);
});
