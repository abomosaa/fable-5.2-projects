// One command for local development: starts the authoritative game server
// (restarting on changes) and the Vite dev server for the client, and stops
// both together.
import { spawn } from 'node:child_process';

const serverPort = process.env.PORT ?? '8089';
const clientPort = process.env.CLIENT_PORT ?? '5173';
const env = { ...process.env, PORT: serverPort, CLIENT_PORT: clientPort, NODE_ENV: process.env.NODE_ENV ?? 'development' };
const bin = (name) => `node_modules/.bin/${name}${process.platform === 'win32' ? '.cmd' : ''}`;

const children = [
  ['server', bin('tsx'), ['watch', '--clear-screen=false', 'server/src/main.ts']],
  ['client', bin('vite'), ['--config', 'client/vite.config.ts']],
].map(([label, command, args]) => {
  const child = spawn(command, args, { env, stdio: ['ignore', 'pipe', 'pipe'], shell: process.platform === 'win32' });
  const prefix = `[${label}] `;
  for (const stream of [child.stdout, child.stderr]) {
    let pending = '';
    stream.on('data', (chunk) => {
      pending += chunk.toString();
      const lines = pending.split('\n');
      pending = lines.pop() ?? '';
      for (const line of lines) if (line.trim() !== '') console.log(prefix + line);
    });
  }
  child.on('exit', (code) => {
    if (!stopping) {
      console.log(`${prefix}exited with code ${code}; stopping.`);
      stop(code ?? 1);
    }
  });
  return child;
});

let stopping = false;
function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  for (const child of children) child.kill('SIGTERM');
  setTimeout(() => process.exit(code), 500);
}
process.on('SIGINT', () => stop(0));
process.on('SIGTERM', () => stop(0));

console.log(`\n  Apex Drift (development)\n  Open http://localhost:${clientPort} in one or more browser windows.\n  Game server: http://localhost:${serverPort} (health: /healthz)\n`);
