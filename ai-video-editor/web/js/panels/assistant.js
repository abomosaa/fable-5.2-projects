// Assistant panel: a chat that edits the project through typed, undoable tools.
import { html, useEffect, useLayoutEffect, useReducer, useRef, useState, useStore, cx, Icon, IconButton, Spinner } from '../lib/ui.js';
import * as A from '../state/actions.js';
import { clear, getSession, lastUserText, markUndo, MAX_MESSAGE_CHARS, replyText, send, stop, subscribe } from './assistant-session.js';

const TOOLS = {
  get_timeline: { label: 'Read the timeline', icon: 'layers' },
  get_transcript: { label: 'Read the transcript', icon: 'mic' },
  get_project_info: { label: 'Read project info', icon: 'info' },
  split_clips: { label: 'Split', icon: 'scissors' },
  trim_clip: { label: 'Trim', icon: 'trim-end' },
  move_clip: { label: 'Move clip', icon: 'move' },
  delete_clips: { label: 'Delete clips', icon: 'trash' },
  delete_time_range: { label: 'Cut time range', icon: 'ripple' },
  set_clip_speed: { label: 'Change speed', icon: 'gauge' },
  update_clips: { label: 'Edit clip properties', icon: 'sliders' },
  add_text: { label: 'Add text', icon: 'type' },
  add_transition: { label: 'Add transition', icon: 'transition' },
  set_track: { label: 'Change track', icon: 'layers' },
  remove_filler_words: { label: 'Remove filler words', icon: 'wand' },
  remove_silences: { label: 'Remove silences', icon: 'silence' },
  remove_spoken_range: { label: 'Remove spoken range', icon: 'scissors' },
  generate_captions: { label: 'Generate captions', icon: 'captions' },
  add_marker: { label: 'Add marker', icon: 'flag' },
};
const toolMeta = (name) => TOOLS[name] || { label: name.replace(/_/g, ' '), icon: 'bolt' };

const ERROR_TITLES = {
  not_configured: 'The live assistant is not configured',
  sidecar_missing: 'The Pi SDK sidecar is not installed',
  node_missing: 'Node.js was not found',
  model_not_found: 'The configured model does not exist',
  timeout: 'The assistant took too long',
  provider_error: 'The model provider reported a problem',
  sidecar_failed: 'The assistant process stopped unexpectedly',
  invalid_request: 'That message could not be sent',
  not_found: 'This project no longer exists',
  offline: 'The server cannot be reached',
  disconnected: 'Connection lost',
};

function useSession(projectId) {
  const [, force] = useReducer((x) => x + 1, 0);
  useEffect(() => subscribe(projectId, force), [projectId]);
  return getSession(projectId);
}

function Step({ step }) {
  const meta = toolMeta(step.name);
  const hasArgs = step.arguments && typeof step.arguments === 'object' && Object.keys(step.arguments).length > 0;
  const stateLabel = { running: 'running', ok: 'done', error: 'failed', stopped: 'stopped' }[step.state];
  return html`<details class=${cx('asst-step', step.state)} data-testid="assistant-step" data-state=${step.state} data-tool=${step.name}>
    <summary>
      <span class="asst-step-state" aria-hidden="true">
        ${step.state === 'running' ? html`<${Spinner} label="Running" />` : html`<${Icon} name=${step.state === 'ok' ? 'check' : step.state === 'error' ? 'x' : 'stop'} size=${13} />`}
      </span>
      <${Icon} name=${meta.icon} size=${14} class="asst-step-icon" />
      <span class="asst-step-text">
        <span class="asst-step-name">${meta.label}<span class="sr-only"> — ${stateLabel}</span></span>
        ${step.summary && step.summary.trim().toLowerCase() !== meta.label.toLowerCase() && html`<span class="asst-step-summary">${step.summary}</span>`}
      </span>
      <${Icon} name="chevron-down" size=${12} class="chev" />
    </summary>
    <div class="asst-step-body">
      <div class="faint">Tool <code>${step.name}</code>${hasArgs ? ' was called with:' : ' was called without arguments.'}</div>
      ${hasArgs && html`<pre tabindex="0">${JSON.stringify(step.arguments, null, 2)}</pre>`}
    </div>
  </details>`;
}

function Reply({ msg, projectId, isLast, running, revision, canUndo }) {
  const text = replyText(msg);
  const streaming = msg.status === 'streaming';
  const undoable = msg.edits > 0 && !msg.undone && !streaming && isLast && !running && revision === msg.revision && canUndo;
  const undoEdits = async () => {
    markUndo(projectId, msg, { undoing: true });
    let done = 0;
    for (let i = 0; i < msg.edits; i++) {
      const ch = await A.undo();
      if (!ch) break;
      done++;
    }
    markUndo(projectId, msg, { undoing: false, undone: done > 0, undoneCount: done });
  };
  return html`<div class=${cx('asst-msg assistant', msg.status)} data-testid="assistant-message" data-role="assistant" data-status=${msg.status}>
    <div class="asst-avatar" aria-hidden="true"><${Icon} name="sparkles" size=${13} /></div>
    <div class="asst-body">
      <span class="sr-only">Assistant:</span>
      ${msg.parts.map((p, i) =>
        p.type === 'step'
          ? html`<${Step} key=${p.id} step=${p} />`
          : p.text.trim() && html`<div class="asst-text" key=${i}>${p.text.replace(/^\n+/, '')}${streaming && i === msg.parts.length - 1 && html`<span class="asst-caret" aria-hidden="true"></span>`}</div>`,
      )}
      ${streaming && !msg.parts.length && html`<div class="asst-thinking" role="status"><${Spinner} label="Working" /><span>Working…</span></div>`}
      ${streaming && msg.parts.length > 0 && msg.parts[msg.parts.length - 1].type === 'step' && msg.parts[msg.parts.length - 1].state !== 'running' && html`<div class="asst-thinking" role="status"><${Spinner} label="Working" /><span>Working…</span></div>`}
      ${msg.status === 'stopped' && html`<div class="asst-meta"><${Icon} name="stop" size=${12} /> Stopped${msg.edits ? ` after ${msg.edits} edit${msg.edits === 1 ? '' : 's'}` : ''}.</div>`}
      ${msg.status === 'done' && !text && !msg.parts.length && html`<div class="asst-meta">Finished without a reply.</div>`}
      ${msg.status === 'error' &&
      html`<div class="notice error asst-error" role="alert" data-testid="assistant-error" data-code=${msg.error.code}>
        <${Icon} name="alert" />
        <div class="grow">
          <strong>${ERROR_TITLES[msg.error.code] || 'The assistant could not finish'}</strong>
          <div class="asst-error-detail">${msg.error.message}</div>
          ${isLast && !running && html`<button type="button" class="btn small" data-testid="assistant-retry" onClick=${() => send(projectId, lastUserText(projectId))}><${Icon} name="refresh" size=${13} /> Retry</button>`}
        </div>
      </div>`}
      ${msg.edits > 0 &&
      !streaming &&
      html`<div class="asst-meta">
        ${msg.undone
          ? html`<${Icon} name="undo" size=${12} /> ${msg.undoneCount === msg.edits ? 'Edits undone.' : `${msg.undoneCount} of ${msg.edits} edits undone.`}`
          : html`<${Icon} name="check" size=${12} /> ${msg.edits} edit${msg.edits === 1 ? '' : 's'} applied — each is one undo step.`}
        ${(undoable || msg.undoing) &&
        html`<button type="button" class="btn small ghost asst-undo" disabled=${msg.undoing} data-testid="assistant-undo" onClick=${undoEdits}>
          ${msg.undoing ? html`<${Spinner} label="Undoing" />` : html`<${Icon} name="undo" size=${13} />`} Undo ${msg.edits === 1 ? 'this edit' : `these ${msg.edits} edits`}
        </button>`}
      </div>`}
    </div>
  </div>`;
}

function ModeBar({ info, lastReply, onClear, canClear }) {
  const fixture = info ? info.fixture : false;
  const provider = lastReply?.provider || info?.provider;
  const model = lastReply?.model || info?.model;
  return html`<div class=${cx('asst-mode', fixture && 'fixture')} data-testid="assistant-mode" data-mode=${fixture ? 'fixture' : 'live'}>
    ${fixture
      ? html`<span class="badge fixture">Fixture</span>
          <span class="grow asst-mode-text truncate" title="Fixture assistant: requests are matched with simple rules, not sent to an AI model"><strong>Rule-based</strong>, not an AI model</span>`
      : html`<${Icon} name="sparkles" size=${14} />
          <span class="grow asst-mode-text truncate" title=${info?.sdk}><strong>Pi SDK</strong> · ${provider || model ? `${provider || 'default'}/${model || 'default model'}` : 'default model'}</span>`}
    <${IconButton} icon="trash" label="Clear conversation" small disabled=${!canClear} onClick=${onClear} tipPos="left" />
  </div>`;
}

function Suggestions({ examples, onPick, disabled }) {
  if (!examples?.length) return null;
  return html`<div class="asst-suggestions" role="group" aria-label="Example requests">
    ${examples.map((ex) => html`<button type="button" class="chip asst-chip" disabled=${disabled} onClick=${() => onPick(ex)} data-testid="assistant-example">${ex}</button>`)}
  </div>`;
}

export function AssistantPanel() {
  const { projectId, info, revision, canUndo } = useStore((s) => ({ projectId: s.doc?.id, info: s.health?.assistant || null, revision: s.doc?.revision, canUndo: s.history.can_undo }));
  const session = useSession(projectId);
  const [draft, setDraft] = useState('');
  const logRef = useRef(null);
  const inputRef = useRef(null);
  const stick = useRef(true);

  // follow new content unless the user scrolled up to read
  useLayoutEffect(() => {
    const el = logRef.current;
    if (!el) return;
    if (!getSession(projectId).messages.length) el.scrollTop = 0;
    else if (stick.current) el.scrollTop = el.scrollHeight;
  });
  const onScroll = () => {
    const el = logRef.current;
    stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
  };
  // grow the input with its content (up to a few lines)
  useLayoutEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight + 2, 132)}px`;
  }, [draft]);

  if (!projectId) return null;
  const { messages, running } = session;
  const fixture = !!info?.fixture;
  const unavailable = info && info.available === false;
  const submit = (text) => {
    const t = (text ?? draft).trim();
    if (!t || running) return;
    stick.current = true;
    if (text == null) setDraft('');
    send(projectId, t);
  };
  const onKey = (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      submit();
    } else if (e.key === 'Escape' && running) {
      e.preventDefault();
      stop(projectId);
    }
  };
  const lastReply = [...messages].reverse().find((m) => m.role === 'assistant');
  const nearLimit = draft.length > MAX_MESSAGE_CHARS - 400;

  return html`<div class="assistant" data-testid="assistant">
    <${ModeBar} info=${info} lastReply=${lastReply} canClear=${messages.length > 0} onClear=${() => clear(projectId)} />
    ${unavailable &&
    html`<div class="asst-pad">
      <div class="notice warning" role="status" data-testid="assistant-unavailable">
        <${Icon} name="alert" />
        <div class="grow"><strong>The live assistant is not available yet.</strong> ${info.hint || 'Check the server configuration.'}</div>
      </div>
    </div>`}
    <div class="asst-log" ref=${logRef} onScroll=${onScroll} role="log" aria-label="Conversation with the assistant" tabindex=${messages.length ? 0 : -1}>
      ${messages.length === 0
        ? html`<div class="asst-empty">
            <div class="asst-empty-head">
              <span class="asst-empty-icon" aria-hidden="true"><${Icon} name="sparkles" /></span>
              <h3>Edit by asking</h3>
            </div>
            <p>Describe an edit in plain words. The assistant reads the timeline and transcript, then edits with the same undoable commands you use by hand.</p>
            <div class="asst-empty-label">${fixture ? 'The fixture assistant understands' : 'Try asking'}</div>
            <${Suggestions} examples=${info?.examples} onPick=${submit} disabled=${running} />
            ${fixture && html`<p class="asst-empty-fixture">Fixture mode matches requests with simple rules, so phrase them like these examples.</p>`}
          </div>`
        : messages.map((m, i) =>
            m.role === 'user'
              ? html`<div class="asst-msg user" key=${m.id} data-testid="assistant-message" data-role="user"><span class="sr-only">You:</span>${m.text}</div>`
              : html`<${Reply} key=${m.id} msg=${m} projectId=${projectId} isLast=${i === messages.length - 1} running=${running} revision=${revision} canUndo=${canUndo} />`,
          )}
    </div>
    <div class="sr-only" role="status" aria-live="polite">${session.announce}</div>
    <form
      class="asst-composer"
      onSubmit=${(e) => {
        e.preventDefault();
        submit();
      }}
    >
      ${messages.length > 0 && !running && fixture && html`<${Suggestions} examples=${info?.examples?.slice(0, 4)} onPick=${submit} />`}
      <div class="asst-input-wrap">
        <textarea
          ref=${inputRef}
          class="textarea asst-input"
          rows="1"
          data-testid="assistant-input"
          aria-label="Message to the assistant"
          placeholder=${fixture ? 'Try “Split at 5s”…' : 'Describe the edit you want…'}
          maxlength=${MAX_MESSAGE_CHARS}
          value=${draft}
          onInput=${(e) => setDraft(e.currentTarget.value)}
          onKeyDown=${onKey}
        ></textarea>
        ${running
          ? html`<button type="button" class="btn asst-send stop" data-testid="assistant-stop" aria-label="Stop the assistant" data-tip="Stop  (Esc)" data-tip-pos="left" onClick=${() => stop(projectId)}><${Icon} name="stop" /></button>`
          : html`<button type="submit" class="btn primary asst-send" data-testid="assistant-send" aria-label="Send message" data-tip="Send  (Enter)" data-tip-pos="left" disabled=${!draft.trim()}><${Icon} name="send" /></button>`}
      </div>
      <div class="asst-foot">
        <span class=${cx(!running && 'asst-foot-hint')}>${running ? 'Working… edits appear on the timeline as they are made.' : 'Enter to send · Shift+Enter for a new line'}</span>
        ${nearLimit && html`<span class=${cx('tnum', draft.length >= MAX_MESSAGE_CHARS && 'limit')} role="status">${draft.length} / ${MAX_MESSAGE_CHARS}</span>`}
      </div>
    </form>
  </div>`;
}
