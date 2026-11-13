// Assistant conversations (one per project, kept for the browser session).
//
// The assistant never edits the document from here: its tool calls are validated
// and executed on the server, and the resulting changes reach the editor through
// the normal change stream. This module only tracks the conversation and the
// streamed events of the running turn.
import { ApiError, postStream } from '../lib/api.js';
import { store } from '../state/store.js';
import { transport } from '../player/transport.js';
import { TPS } from '../lib/time.js';

export const MAX_MESSAGE_CHARS = 4000;
const HISTORY_TURNS = 12;

const sessions = new Map();
let seq = 1;

/** @returns {{messages: any[], running: boolean, controller: AbortController|null, listeners: Set<Function>, announce: string, version: number}} */
export function getSession(projectId) {
  let s = sessions.get(projectId);
  if (!s) {
    s = { messages: [], running: false, controller: null, listeners: new Set(), announce: '', version: 0, stopping: false };
    sessions.set(projectId, s);
  }
  return s;
}

function emit(s) {
  s.version++;
  for (const fn of [...s.listeners]) fn();
}

export function subscribe(projectId, fn) {
  const s = getSession(projectId);
  s.listeners.add(fn);
  return () => s.listeners.delete(fn);
}

/** Plain text of an assistant message (what the model said). */
export const replyText = (m) =>
  m.parts
    .filter((p) => p.type === 'text')
    .map((p) => p.text)
    .join('')
    .trim();

function historyOf(messages) {
  const out = [];
  for (const m of messages) {
    if (m.role === 'user') out.push({ role: 'user', text: m.text });
    else {
      const steps = m.parts.filter((p) => p.type === 'step' && p.summary).map((p) => `- ${p.name}: ${p.summary}`);
      let text = replyText(m);
      if (steps.length) text = `${text}${text ? '\n\n' : ''}[Tools used this turn]\n${steps.join('\n')}`;
      out.push({ role: 'assistant', text: text || '(The assistant did not finish this turn.)' });
    }
  }
  return out.slice(-HISTORY_TURNS * 2);
}

function handle(s, reply, ev) {
  switch (ev.type) {
    case 'started':
      reply.mode = ev.mode;
      reply.provider = ev.provider;
      reply.model = ev.model;
      reply.fixture = !!ev.fixture;
      break;
    case 'text_delta': {
      const last = reply.parts[reply.parts.length - 1];
      if (last && last.type === 'text') last.text += ev.text;
      else reply.parts.push({ type: 'text', text: ev.text });
      break;
    }
    case 'tool_call':
      reply.parts.push({ type: 'step', id: ev.id, name: ev.name, arguments: ev.arguments, state: 'running', summary: '', revision: null });
      break;
    case 'tool_result': {
      const step = reply.parts.find((p) => p.type === 'step' && p.id === ev.id);
      if (step) {
        step.state = ev.ok ? 'ok' : 'error';
        step.summary = ev.summary || '';
        step.revision = ev.revision ?? null;
      }
      if (ev.revision != null) reply.revision = Math.max(reply.revision || 0, ev.revision);
      break;
    }
    case 'done':
      if (!replyText(reply) && ev.text) reply.parts.push({ type: 'text', text: ev.text });
      reply.status = 'done';
      reply.toolCalls = ev.tool_calls || 0;
      reply.edits = ev.edits || 0;
      s.announce = reply.edits ? `The assistant finished and made ${reply.edits} edit${reply.edits === 1 ? '' : 's'}.` : 'The assistant finished.';
      break;
    case 'error':
      if (ev.code === 'aborted') reply.status = 'stopped';
      else {
        reply.status = 'error';
        reply.error = { code: ev.code || 'error', message: ev.message || 'The assistant failed.' };
        s.announce = `The assistant could not finish: ${reply.error.message}`;
      }
      break;
    default:
      return;
  }
  emit(s);
}

/** Send a user message and stream the assistant's turn. */
export async function send(projectId, rawText) {
  const s = getSession(projectId);
  const text = String(rawText || '').trim().slice(0, MAX_MESSAGE_CHARS);
  if (s.running || !text) return;
  const history = historyOf(s.messages);
  const user = { id: `m${seq++}`, role: 'user', text };
  const reply = { id: `m${seq++}`, role: 'assistant', parts: [], status: 'streaming', mode: null, provider: null, model: null, fixture: false, edits: 0, toolCalls: 0, error: null, revision: null, undone: false, undoing: false };
  s.messages = [...s.messages, user, reply];
  s.running = true;
  s.stopping = false;
  s.controller = new AbortController();
  s.announce = '';
  emit(s);
  try {
    await postStream(
      `/api/projects/${projectId}/assistant`,
      { message: text, history, playhead_seconds: transport.frameTime / TPS, selected_clip_ids: [...store.state.sel.clips] },
      (ev) => handle(s, reply, ev),
      s.controller.signal,
    );
    if (reply.status === 'streaming') {
      // the stream ended without a final event
      if (s.stopping) reply.status = 'stopped';
      else {
        reply.status = 'error';
        reply.error = { code: 'disconnected', message: 'The connection to the assistant was lost before it finished. Edits it already made are in the project; check the timeline, then try again.' };
      }
    }
  } catch (e) {
    if (e?.name === 'AbortError' || s.stopping) reply.status = 'stopped';
    else {
      reply.status = 'error';
      reply.error = e instanceof ApiError ? { code: e.code, message: e.message } : { code: 'error', message: 'Could not reach the assistant. Check that the Cutline server is running, then try again.' };
      s.announce = `The assistant could not finish: ${reply.error.message}`;
    }
  } finally {
    for (const p of reply.parts) if (p.type === 'step' && p.state === 'running') p.state = 'stopped';
    // edits made before a stop / failure still count (each is one undo step)
    if (reply.status !== 'done') reply.edits = reply.parts.filter((p) => p.type === 'step' && p.state === 'ok' && p.revision != null).length;
    if (reply.status === 'stopped') s.announce = 'The assistant was stopped.';
    s.running = false;
    s.stopping = false;
    s.controller = null;
    emit(s);
  }
}

/** Cancel the running turn (the server aborts it when the stream closes). */
export function stop(projectId) {
  const s = getSession(projectId);
  if (!s.running) return;
  s.stopping = true;
  s.controller?.abort();
}

export function clear(projectId) {
  const s = getSession(projectId);
  if (s.running) stop(projectId);
  s.messages = [];
  s.announce = 'Conversation cleared.';
  emit(s);
}

/** Text of the most recent user message (for Retry). */
export function lastUserText(projectId) {
  const msgs = getSession(projectId).messages;
  for (let i = msgs.length - 1; i >= 0; i--) if (msgs[i].role === 'user') return msgs[i].text;
  return '';
}

/** Flag helpers used by the panel for the "undo assistant edits" action. */
export function markUndo(projectId, reply, patch) {
  Object.assign(reply, patch);
  emit(getSession(projectId));
}
