/** Browser entry point. */
import { App, mountFatal } from './app';
import { loadClientConfig } from './config';

async function boot(): Promise<void> {
  const root = document.getElementById('ui');
  const canvas = document.getElementById('scene');
  if (!root || !(canvas instanceof HTMLCanvasElement)) throw new Error('Page shell is missing');
  try {
    const config = await loadClientConfig();
    new App(root, canvas, config);
  } catch (error) {
    console.error(error);
    mountFatal(root, 'Apex Drift could not start', error instanceof Error ? error.message : 'Unexpected error.');
  }
}

void boot();
