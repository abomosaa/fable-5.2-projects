#!/usr/bin/env node
/**
 * Development mode: API server with reload (tsx watch, fixture mode by default) + Vite dev server with HMR.
 *   npm run dev            → http://localhost:5173  (API on :8787, fixture data)
 *   npm run dev -- --live  → same, against real upstream sources
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const mode = process.argv.includes('--live') ? 'live' : 'fixture';
const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx';
const children = [
  spawn(npx, ['tsx', 'watch', 'src/index.ts', `--mode=${mode}`, '--port=8787'], { cwd: path.join(root, 'server'), stdio: 'inherit' }),
  spawn(npx, ['vite', '--port', '5173'], { cwd: path.join(root, 'web'), stdio: 'inherit', env: { ...process.env, WIM_API: 'http://127.0.0.1:8787' } }),
];
const stop = () => children.forEach((c) => c.kill('SIGTERM'));
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
children.forEach((c) => c.on('exit', (code) => { stop(); process.exitCode = code ?? 0; }));
