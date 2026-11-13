import path from 'node:path';
export const TOOLS = path.resolve(import.meta.dirname, '..');
export const ROOT = path.resolve(TOOLS, '../..');
/** untrusted raw downloads: one directory per asset id (never executed, never used as cwd) */
export const SRC = path.join(ROOT, '.cache', 'assets-src');
/** per-asset build cache (results of the last processing run) */
export const BUILD = path.join(ROOT, '.cache', 'assets-build');
/** the shipped, processed library */
export const OUT = path.join(ROOT, 'public', 'assets');
export const PREVIEWS = path.join(ROOT, '.cache', 'asset-previews');
export const LOCK = path.join(TOOLS, 'sources.lock.json');
export const USER_AGENT = 'terraforge-asset-pipeline/1.0 (procedural-world-editor; asset fetch script)';
