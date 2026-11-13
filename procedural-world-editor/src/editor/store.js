// Client side of the project storage API: load / save / autosave / duplicate / export.
import { serializeWorld, deserializeProject } from '../core/projectIO.js';

async function req(method, url, body, type) {
  const res = await fetch(url, { method, body, headers: body ? { 'Content-Type': type || 'application/octet-stream' } : undefined });
  if (!res.ok) {
    let msg = `${method} ${url} failed (${res.status})`;
    try {
      const j = await res.json();
      if (j.error) msg = j.error;
    } catch {
      /* ignore */
    }
    throw new Error(msg);
  }
  return res;
}

export const store = {
  async list() {
    return (await req('GET', '/api/projects')).json();
  },

  async load(id, opts = {}) {
    const q = opts.autosave ? '?autosave=1' : '';
    const read = async (name, optional) => {
      try {
        return new Uint8Array(await (await req('GET', `/api/projects/${id}/file/${name}${q}`)).arrayBuffer());
      } catch (e) {
        if (optional) return null;
        throw new Error(`Project "${id}" is incomplete: ${e.message}`);
      }
    };
    return deserializeProject(read);
  },

  /** Save every layer of a world. opts.autosave writes to the autosave slot instead. */
  async save(world, manifest, opts = {}) {
    const id = world.project.id;
    const q = opts.autosave ? '?autosave=1' : '';
    const files = await serializeWorld(world, manifest, {});
    const puts = [];
    for (const [name, data] of Object.entries(files)) {
      if (name === 'project.json') continue;
      puts.push(req('PUT', `/api/projects/${id}/file/${name}${q}`, data, name.endsWith('.json') ? 'application/json' : undefined));
    }
    await Promise.all(puts);
    // the document goes last: a project.json on disk always refers to complete layers
    await req('PUT', `/api/projects/${id}/file/project.json${q}`, files['project.json'], 'application/json');
    if (!opts.autosave) await req('DELETE', `/api/projects/${id}/autosave`).catch(() => {});
    return { id };
  },

  async saveThumb(id, blob) {
    await req('PUT', `/api/projects/${id}/file/thumb.jpg`, blob, 'image/jpeg');
  },
  async duplicate(id, newId, name) {
    return (await req('POST', `/api/projects/${id}/duplicate`, JSON.stringify({ id: newId, name }), 'application/json')).json();
  },
  async remove(id) {
    return (await req('DELETE', `/api/projects/${id}`)).json();
  },
  async discardAutosave(id) {
    return (await req('DELETE', `/api/projects/${id}/autosave`)).json();
  },
  async restoreShowcase(id) {
    return (await req('POST', `/api/showcases/restore/${id}`)).json();
  },
  async exportFile(id, stamp, name, data) {
    return (await req('PUT', `/api/projects/${id}/export/${stamp}/${name}`, data)).json();
  },
  packageUrl(id) {
    return `/api/projects/${id}/package`;
  },
};
