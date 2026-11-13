// HTTP client for the Cutline server.

/** One id per browser tab so a tab can ignore the SSE echo of its own edits. */
export const CLIENT_ID = (crypto.randomUUID ? crypto.randomUUID() : String(Math.random()).slice(2)).replace(/-/g, '').slice(0, 16);

export class ApiError extends Error {
  /** @param {{code:string,message:string,field?:string,[k:string]:any}} err */
  constructor(status, err) {
    super(err?.message || `Request failed (${status})`);
    this.name = 'ApiError';
    this.status = status;
    this.code = err?.code || 'error';
    this.field = err?.field;
    this.details = err || {};
  }
}

async function request(method, url, body, { signal } = {}) {
  let res;
  try {
    res = await fetch(url, {
      method,
      signal,
      headers: { 'x-client-id': CLIENT_ID, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch (e) {
    if (e.name === 'AbortError') throw e;
    throw new ApiError(0, { code: 'offline', message: 'Cannot reach the Cutline server. Check that it is still running, then try again.' });
  }
  const type = res.headers.get('content-type') || '';
  const data = type.includes('json') ? await res.json().catch(() => null) : await res.text();
  if (!res.ok) {
    const err = data && data.error ? data.error : { code: 'error', message: typeof data === 'string' && data ? data : `The server answered with status ${res.status}.` };
    throw new ApiError(res.status, err);
  }
  return data;
}

export const api = {
  get: (url, opts) => request('GET', url, undefined, opts),
  post: (url, body = {}, opts) => request('POST', url, body, opts),
  patch: (url, body, opts) => request('PATCH', url, body, opts),
  del: (url, opts) => request('DELETE', url, undefined, opts),

  health: () => api.get('/api/health'),
  listProjects: () => api.get('/api/projects'),
  createProject: (name) => api.post('/api/projects', { name }),
  getProject: (id) => api.get(`/api/projects/${id}`),
  renameProject: (id, name) => api.patch(`/api/projects/${id}`, { name }),
  duplicateProject: (id) => api.post(`/api/projects/${id}/duplicate`),
  deleteProject: (id) => api.del(`/api/projects/${id}`),

  command: (id, base_revision, command) => api.post(`/api/projects/${id}/commands`, { base_revision, command }),
  undo: (id, base_revision) => api.post(`/api/projects/${id}/undo`, { base_revision }),
  redo: (id, base_revision) => api.post(`/api/projects/${id}/redo`, { base_revision }),

  addSample: (id) => api.post(`/api/projects/${id}/assets/sample`),
  dismissAsset: (assetId, projectId) => api.del(`/api/assets/${assetId}?project=${projectId}`),
  reprocessAsset: (assetId, projectId) => api.post(`/api/assets/${assetId}/reprocess?project=${projectId}`),
  transcription: (assetId, action) => api.post(`/api/assets/${assetId}/transcription`, { action }),
  assetTranscript: (assetId) => api.get(`/api/assets/${assetId}/transcript`),
  transcriptView: (id, opts) => api.get(`/api/projects/${id}/transcript`, opts),
  silences: (id, o = {}) => api.get(`/api/projects/${id}/silences?${new URLSearchParams(Object.entries(o).map(([k, v]) => [k, String(v)]))}`),

  listExports: (id) => api.get(`/api/projects/${id}/exports`),
  startExport: (id, settings) => api.post(`/api/projects/${id}/exports`, settings),
  cancelExport: (jobId) => api.post(`/api/exports/${jobId}/cancel`),
  deleteExport: (jobId) => api.del(`/api/exports/${jobId}`),
};

/** URLs of media derived from an asset. */
export const mediaUrl = (assetId, file) => `/media/${assetId}/${file}`;
export const exportUrl = (job, download = false) => `/exports/${job.id}/${encodeURIComponent(job.file_name || 'export.mp4')}${download ? '?download=1' : ''}`;

/**
 * Upload one file with progress. Resolves with the created asset records.
 * @returns {{promise: Promise<any>, abort: () => void}}
 */
export function uploadFile(projectId, file, onProgress) {
  const xhr = new XMLHttpRequest();
  const promise = new Promise((resolve, reject) => {
    xhr.open('POST', `/api/projects/${projectId}/assets`);
    xhr.setRequestHeader('x-client-id', CLIENT_ID);
    xhr.responseType = 'json';
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress?.(e.loaded / e.total);
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) resolve(xhr.response);
      else reject(new ApiError(xhr.status, xhr.response?.error || { code: 'error', message: `Upload failed with status ${xhr.status}.` }));
    };
    xhr.onerror = () => reject(new ApiError(0, { code: 'offline', message: 'The upload was interrupted. Check your connection to the server and try again.' }));
    xhr.onabort = () => reject(new ApiError(0, { code: 'aborted', message: 'Upload cancelled.' }));
    const form = new FormData();
    form.append('file', file, file.name);
    xhr.send(form);
  });
  return { promise, abort: () => xhr.abort() };
}

/**
 * Subscribe to server events for a project. Reconnects automatically
 * (EventSource does) and reports connection state.
 * @param {(kind: string, data: any) => void} onEvent
 * @param {(online: boolean) => void} onState
 */
export function connectEvents(projectId, onEvent, onState) {
  const es = new EventSource(`/api/events?project=${encodeURIComponent(projectId)}`);
  let wasDown = false;
  es.onopen = () => {
    onState?.(true);
    if (wasDown) onEvent('resync', {});
    wasDown = false;
  };
  es.onerror = () => {
    wasDown = true;
    onState?.(false);
  };
  for (const kind of ['asset', 'asset_added', 'change', 'render', 'project', 'resync']) {
    es.addEventListener(kind, (e) => {
      let data = {};
      try {
        data = JSON.parse(e.data);
      } catch {
        /* ignore malformed event */
      }
      onEvent(kind, data);
    });
  }
  return () => es.close();
}

/**
 * POST that answers with an SSE stream (used by the assistant).
 * Calls onEvent for each event; resolves when the stream ends.
 */
export async function postStream(url, body, onEvent, signal) {
  const res = await fetch(url, { method: 'POST', signal, headers: { 'content-type': 'application/json', 'x-client-id': CLIENT_ID }, body: JSON.stringify(body) });
  if (!res.ok || !res.body) {
    const data = await res.json().catch(() => null);
    throw new ApiError(res.status, data?.error || { code: 'error', message: `The server answered with status ${res.status}.` });
  }
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf('\n\n')) >= 0) {
      const chunk = buf.slice(0, i);
      buf = buf.slice(i + 2);
      const data = chunk
        .split('\n')
        .filter((l) => l.startsWith('data:'))
        .map((l) => l.slice(5).trimStart())
        .join('\n');
      if (!data) continue;
      try {
        onEvent(JSON.parse(data));
      } catch {
        /* ignore keep-alives / malformed chunks */
      }
    }
  }
}
