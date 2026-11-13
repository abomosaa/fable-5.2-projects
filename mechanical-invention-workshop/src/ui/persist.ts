/**
 * Project persistence in browser storage (works offline, no account):
 *   mw:index            list of stored projects
 *   mw:project:<id>     explicitly saved project
 *   mw:autosave:<id>    newest autosaved state (recovery copy)
 *   mw:last             id of the project open last
 * Projects can additionally be exported/imported as .json files.
 */
import type { Project } from '../core/model/types';
import { normalizeProject, serializeProject } from '../core/model/project';

export interface IndexEntry { id: string; name: string; modifiedAt: string; parts: number; autosaveAt?: string }

const K_INDEX = 'mw:index', K_LAST = 'mw:last';
const kProject = (id: string) => `mw:project:${id}`;
const kAuto = (id: string) => `mw:autosave:${id}`;

function ls(): Storage | null {
  try { return typeof localStorage !== 'undefined' ? localStorage : null; } catch { return null; }
}

export function listProjects(): IndexEntry[] {
  const s = ls();
  if (!s) return [];
  try {
    const raw = JSON.parse(s.getItem(K_INDEX) ?? '[]');
    return Array.isArray(raw) ? raw : [];
  } catch { return []; }
}

function writeIndex(list: IndexEntry[]): void {
  ls()?.setItem(K_INDEX, JSON.stringify(list));
}

export function uniqueProjectName(base: string): string {
  const names = new Set(listProjects().map((e) => e.name));
  if (!names.has(base)) return base;
  let n = 2;
  while (names.has(`${base} ${n}`)) n++;
  return `${base} ${n}`;
}

export function saveProject(p: Project): boolean {
  const s = ls();
  if (!s) return false;
  try {
    s.setItem(kProject(p.id), serializeProject(p));
    s.removeItem(kAuto(p.id));
    const list = listProjects().filter((e) => e.id !== p.id);
    list.unshift({ id: p.id, name: p.name, modifiedAt: p.modifiedAt, parts: p.parts.length });
    writeIndex(list);
    return true;
  } catch { return false; }
}

export function autosaveNow(p: Project): string | null {
  const s = ls();
  if (!s) return null;
  try {
    const at = new Date().toISOString();
    s.setItem(kAuto(p.id), serializeProject({ ...p, modifiedAt: at }));
    const list = listProjects();
    const e = list.find((x) => x.id === p.id);
    if (e) { e.autosaveAt = at; e.name = p.name; } else list.unshift({ id: p.id, name: p.name, modifiedAt: at, parts: p.parts.length, autosaveAt: at });
    writeIndex(list);
    return at;
  } catch { return null; }
}

let timer: ReturnType<typeof setTimeout> | null = null;
export function scheduleAutosave(get: () => Project, done: (at: string | null) => void, delay = 1200): void {
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => { timer = null; done(autosaveNow(get())); }, delay);
}

export function loadStored(id: string): { project: Project; fromAutosave: boolean } | null {
  const s = ls();
  if (!s) return null;
  const tryParse = (key: string): Project | null => {
    const raw = s.getItem(key);
    if (!raw) return null;
    try { return normalizeProject(JSON.parse(raw)); } catch { return null; }
  };
  const auto = tryParse(kAuto(id)), saved = tryParse(kProject(id));
  if (auto && (!saved || auto.modifiedAt > saved.modifiedAt)) return { project: auto, fromAutosave: true };
  if (saved) return { project: saved, fromAutosave: false };
  return null;
}

export function deleteProject(id: string): void {
  const s = ls();
  if (!s) return;
  s.removeItem(kProject(id)); s.removeItem(kAuto(id));
  writeIndex(listProjects().filter((e) => e.id !== id));
  if (s.getItem(K_LAST) === id) s.removeItem(K_LAST);
}

export function setLastProject(id: string): void { ls()?.setItem(K_LAST, id); }
export function getLastProject(): string | null { return ls()?.getItem(K_LAST) ?? null; }
export function clearLastProject(): void { ls()?.removeItem(K_LAST); }

export function download(filename: string, data: string | Uint8Array, mime = 'application/octet-stream'): void {
  const blob = new Blob([data as BlobPart], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
  // automation hook: remember what was exported last
  (window as any).__mwDownloads = [...((window as any).__mwDownloads ?? []), { filename, size: typeof data === 'string' ? data.length : data.byteLength, mime, data }].slice(-20);
}

export function slug(name: string): string {
  return name.trim().replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-+|-+$/g, '').toLowerCase() || 'project';
}
