// App shell: routing between the project list and the editor workspace.
import { html, useEffect, useRef, useState, useStore, cx, clamp, Icon, IconButton, Spinner, Toasts, Tabs, Boundary, Notice, MOD } from './lib/ui.js';
import { setUi, store } from './state/store.js';
import * as A from './state/actions.js';
import { installShortcuts, kbd } from './lib/shortcuts.js';
import { Home } from './panels/home.js';
import { MediaBin } from './panels/media-bin.js';
import { Inspector } from './panels/inspector.js';
import { TranscriptPanel } from './panels/transcript.js';
import { AssistantPanel } from './panels/assistant.js';
import { ExportDialog } from './panels/export.js';
import { ShortcutsDialog } from './panels/shortcuts-dialog.js';
import { Monitor } from './player/monitor.js';
import { Timeline } from './timeline/timeline.js';

// ---------------------------------------------------------------------------------
// Tooltips. `[data-tip]` used to be drawn with a CSS ::after, which every scrolling or
// clipping ancestor (timeline toolbar, track headers, inspector) cut off. One shared
// fixed-position bubble is placed against the viewport instead: it is never clipped,
// flips when it would leave the window, and shows the shortcut as a key cap.
// ---------------------------------------------------------------------------------
function installTooltips() {
  if (typeof document === 'undefined' || document.getElementById('tip-layer')) return;
  const el = document.createElement('div');
  el.id = 'tip-layer';
  el.className = 'tip-layer';
  // the same text is already the control's accessible name / description
  el.setAttribute('aria-hidden', 'true');
  document.body.appendChild(el);
  document.documentElement.classList.add('tips-js');

  const SHOW_DELAY = 450;
  const MARGIN = 6;
  const GAP = 7;
  let anchor = null;
  let timer = 0;
  let hiddenAt = 0;
  let tabbing = false;

  const place = () => {
    if (!anchor || !anchor.isConnected) return hide();
    const text = anchor.getAttribute('data-tip');
    if (!text) return hide();
    // "Label  (Ctrl+Z)" → label + key cap
    const m = /^(.*?)\s{2,}\((.+)\)$/.exec(text);
    el.textContent = m ? m[1] : text;
    if (m) {
      const k = document.createElement('span');
      k.className = 'tip-kbd';
      k.textContent = m[2];
      el.appendChild(k);
    }
    el.style.transform = 'translate(0, 0)';
    const r = anchor.getBoundingClientRect();
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    const vw = document.documentElement.clientWidth;
    const vh = document.documentElement.clientHeight;
    const pos = anchor.getAttribute('data-tip-pos');
    let x = pos === 'left' ? r.right - w : pos === 'right' ? r.left : r.left + r.width / 2 - w / 2;
    let y = pos === 'top' ? r.top - GAP - h : r.bottom + GAP;
    if (y + h > vh - MARGIN) y = r.top - GAP - h;
    if (y < MARGIN) y = Math.min(r.bottom + GAP, vh - MARGIN - h);
    x = clamp(x, MARGIN, Math.max(MARGIN, vw - MARGIN - w));
    el.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`;
    el.classList.add('show');
  };
  function hide() {
    clearTimeout(timer);
    if (el.classList.contains('show')) hiddenAt = performance.now();
    el.classList.remove('show');
    anchor = null;
  }
  const arm = (target) => {
    if (target === anchor) return;
    hide();
    anchor = target;
    // moving along a row of buttons: the next tip follows without the initial wait
    const warm = performance.now() - hiddenAt < 400;
    timer = setTimeout(place, warm ? 60 : SHOW_DELAY);
  };

  document.addEventListener('pointerover', (e) => {
    if (e.pointerType === 'touch' || e.buttons) return;
    const t = e.target instanceof Element ? e.target.closest('[data-tip]') : null;
    if (t) arm(t);
    else if (anchor && !tabbing) hide();
  });
  document.addEventListener('pointerout', (e) => {
    if (anchor && !tabbing && (!e.relatedTarget || !(e.relatedTarget instanceof Node) || !anchor.contains(e.relatedTarget))) hide();
  });
  document.addEventListener('pointerdown', () => {
    tabbing = false;
    hide();
  }, true);
  document.addEventListener('keydown', (e) => {
    tabbing = e.key === 'Tab';
    hide();
  }, true);
  // keyboard users get the same hint, but only while tabbing (not when a dialog moves focus)
  document.addEventListener('focusin', (e) => {
    const t = e.target instanceof Element && e.target.matches('[data-tip]') ? e.target : null;
    if (t && tabbing && t.matches(':focus-visible')) arm(t);
  });
  document.addEventListener('focusout', () => tabbing && hide());
  document.addEventListener('scroll', hide, true);
  document.addEventListener('wheel', hide, { capture: true, passive: true });
  window.addEventListener('blur', hide);
  window.addEventListener('resize', hide);
}
installTooltips();

export function App() {
  const route = useStore((s) => s.route);
  return html`
    ${route.name === 'editor' ? html`<${Editor} key=${route.projectId} />` : html`<${Home} />`}
    <${Toasts} />
  `;
}

/** Fixture / connection status chips shown in every top bar. */
export function ModeBadges() {
  const { health, online } = useStore((s) => ({ health: s.health, online: s.online }));
  return html`
    ${health?.fixture &&
    html`<span class="badge fixture" data-tip="Fixture mode: speech data and the assistant are deterministic test fixtures, not real AI output" data-tip-pos="left" data-testid="fixture-badge">Fixture data</span>`}
    ${!online && html`<span class="badge danger" role="status"><${Icon} name="alert" size=${12} /> Offline — reconnecting…</span>`}
    ${health && !health.ffmpeg?.ok && html`<span class="badge warning" data-tip=${health.ffmpeg?.message || 'FFmpeg not found'} data-tip-pos="left"><${Icon} name="alert" size=${12} /> FFmpeg missing</span>`}
  `;
}

function SaveStatus() {
  const save = useStore((s) => s.save);
  const label = save.state === 'saving' ? 'Saving…' : save.state === 'error' ? 'Not saved' : 'Saved';
  return html`<span class=${cx('save-status', save.state)} role="status" aria-live="polite" data-testid="save-status" data-tip=${save.state === 'error' ? 'The last edit could not be saved. Check the server.' : 'Every edit is saved automatically'}>
    ${save.state === 'saving' ? html`<${Spinner} label="Saving" />` : html`<${Icon} name=${save.state === 'error' ? 'alert' : 'saved'} />`}
    <span>${label}</span>
  </span>`;
}

function ProjectName() {
  const name = useStore((s) => s.doc?.name || '');
  const id = useStore((s) => s.doc?.id);
  const [editing, setEditing] = useState(false);
  const ref = useRef(null);
  useEffect(() => {
    if (editing) ref.current?.select();
  }, [editing]);
  const commit = async (e) => {
    const v = e.currentTarget.value.trim();
    setEditing(false);
    if (v && v !== name) {
      try {
        await A.renameProject(id, v);
        document.title = `${v} — Cutline`;
      } catch (err) {
        store.set({});
        import('./lib/ui.js').then((m) => m.toast({ kind: 'error', title: 'Could not rename the project', detail: err.message }));
      }
    }
  };
  if (editing)
    return html`<input
      ref=${ref}
      class="input project-name-input"
      aria-label="Project name"
      maxlength="120"
      defaultValue=${name}
      onBlur=${commit}
      onKeyDown=${(e) => {
        if (e.key === 'Enter') e.currentTarget.blur();
        if (e.key === 'Escape') {
          e.currentTarget.value = name;
          e.currentTarget.blur();
        }
        e.stopPropagation();
      }}
    />`;
  return html`<button type="button" class="project-name" onClick=${() => setEditing(true)} data-tip="Rename project" data-testid="project-name"><span class="truncate">${name}</span><${Icon} name="pencil" size=${12} /></button>`;
}

function Topbar() {
  const history = useStore((s) => s.history);
  const exporting = useStore((s) => s.exports.some((j) => j.state === 'rendering' || j.state === 'queued' || j.state === 'finalizing'));
  return html`<header class="topbar">
    <div class="row" style="min-width:0;gap:6px">
      <${IconButton} icon="home" label="All projects" onClick=${() => A.navigate({ name: 'home' })} tipPos="right" />
      <${ProjectName} />
      <${SaveStatus} />
    </div>
    <div class="row" style="gap:2px">
      <${IconButton} icon="undo" label=${history.undo_label ? `Undo: ${history.undo_label}` : 'Undo'} kbd=${kbd('mod+z')} disabled=${!history.can_undo} onClick=${() => A.undo()} data-testid="undo" />
      <${IconButton} icon="redo" label=${history.redo_label ? `Redo: ${history.redo_label}` : 'Redo'} kbd=${kbd('mod+shift+z')} disabled=${!history.can_redo} onClick=${() => A.redo()} data-testid="redo" />
    </div>
    <div class="row" style="justify-content:flex-end;gap:8px;min-width:0">
      <${ModeBadges} />
      <${IconButton} icon="keyboard" label="Keyboard shortcuts" kbd="?" onClick=${() => setUi({ dialog: 'shortcuts' })} tipPos="left" />
      <button type="button" class="btn primary" onClick=${() => setUi({ dialog: 'export' })} data-testid="open-export">
        ${exporting ? html`<${Spinner} label="Exporting" />` : html`<${Icon} name="export" />`} Export
      </button>
    </div>
  </header>`;
}

/** Draggable divider between panels (also operable with the arrow keys). */
function Splitter({ vertical, label, value, min, max, onChange, invert }) {
  const drag = useRef(null);
  const down = (e) => {
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { pos: vertical ? e.clientY : e.clientX, start: value };
    document.body.classList.add(vertical ? 'resizing-v' : 'resizing-h');
  };
  const move = (e) => {
    if (!drag.current) return;
    const d = (vertical ? e.clientY : e.clientX) - drag.current.pos;
    onChange(clamp(drag.current.start + (invert ? -d : d), min, max));
  };
  const up = () => {
    drag.current = null;
    document.body.classList.remove('resizing-v', 'resizing-h');
  };
  const key = (e) => {
    const dec = vertical ? 'ArrowUp' : 'ArrowLeft';
    const inc = vertical ? 'ArrowDown' : 'ArrowRight';
    if (e.key !== dec && e.key !== inc) return;
    e.preventDefault();
    const d = (e.key === inc ? 16 : -16) * (invert ? -1 : 1);
    onChange(clamp(value + d, min, max));
  };
  return html`<div
    class=${cx('splitter', vertical ? 'v' : 'h')}
    role="separator"
    tabindex="0"
    aria-label=${label}
    aria-orientation=${vertical ? 'horizontal' : 'vertical'}
    aria-valuenow=${Math.round(value)}
    aria-valuemin=${min}
    aria-valuemax=${max}
    onPointerDown=${down}
    onPointerMove=${move}
    onPointerUp=${up}
    onPointerCancel=${up}
    onKeyDown=${key}
  ></div>`;
}

const LEFT_TABS = [{ id: 'media', label: 'Media', icon: 'folder' }];

function RightPanel() {
  const tab = useStore((s) => s.ui.rightTab);
  const words = useStore((s) => s.transcript.view?.word_count || 0);
  const tabs = [
    { id: 'inspector', label: 'Inspector', icon: 'sliders' },
    { id: 'transcript', label: 'Transcript', icon: 'mic', count: words || undefined },
    { id: 'assistant', label: 'Assistant', icon: 'sparkles' },
  ];
  return html`<aside class="panel right" aria-label="Details">
    <${Tabs} tabs=${tabs} value=${tab} onChange=${(rightTab) => setUi({ rightTab })} label="Details panel" />
    <div class="panel-body" role="tabpanel" aria-labelledby=${`tab-${tab}`}>
      ${tab === 'inspector' && html`<${Boundary} name="The inspector"><${Inspector} /><//>`}
      ${tab === 'transcript' && html`<${Boundary} name="The transcript"><${TranscriptPanel} /><//>`}
      ${tab === 'assistant' && html`<${Boundary} name="The assistant"><${AssistantPanel} /><//>`}
    </div>
  </aside>`;
}

function StatusBar() {
  const { n, tr, mk, fixture, rev } = useStore((s) => ({ n: s.sel.clips.size, tr: !!s.sel.transition, mk: !!s.sel.marker, fixture: s.health?.fixture, rev: s.doc?.revision }));
  const snapping = useStore((s) => s.view.snapping);
  const linked = useStore((s) => s.view.linked);
  const announce = useStore((s) => s.announce);
  return html`<footer class="statusbar">
    <span class="sr-only" role="status" aria-live="polite">${announce || ''}</span>
    <span data-testid="status-selection">${n ? `${n} clip${n === 1 ? '' : 's'} selected` : tr ? 'Transition selected' : mk ? 'Marker selected' : 'No selection'}</span>
    <span class="sep"></span>
    <span>Snapping ${snapping ? 'on' : 'off'}</span>
    <span class="sep"></span>
    <span>Linked selection ${linked ? 'on' : 'off'}</span>
    <span class="grow"></span>
    <span class="hint">Drag to move · drag edges to trim · ${MOD}-drag edges to ripple trim · Alt-click selects one of a linked pair · ${MOD}-drop to insert</span>
    ${fixture && html`<span class="sep"></span><span style="color:var(--warning)">Fixture mode</span>`}
    <span class="sep"></span>
    <span class="tnum" data-testid="revision" data-revision=${rev}>rev ${rev}</span>
  </footer>`;
}

function Editor() {
  const { loading, loadError, hasDoc } = useStore((s) => ({ loading: s.loading, loadError: s.loadError, hasDoc: !!s.doc }));
  const ui = useStore((s) => s.ui);
  useEffect(() => (hasDoc ? installShortcuts() : undefined), [hasDoc]);

  if (loadError)
    return html`<main class="center-screen">
      <div class="empty" role="alert">
        <${Icon} name="alert" />
        <h3>This project could not be opened</h3>
        <p>${loadError}</p>
        <div class="row">
          <button type="button" class="btn" onClick=${() => A.navigate({ name: 'home' })}><${Icon} name="arrow-left" /> All projects</button>
          <button type="button" class="btn primary" onClick=${() => A.openProject(store.state.route.projectId)}><${Icon} name="refresh" /> Try again</button>
        </div>
      </div>
    </main>`;
  if (loading || !hasDoc)
    return html`<main class="center-screen" aria-busy="true">
      <div class="boot" role="status"><${Spinner} large label="Opening project" /><span>Opening project…</span></div>
    </main>`;

  const maxSide = Math.max(240, Math.min(560, window.innerWidth * 0.4));
  return html`<div class="editor" style=${{ '--left-w': `${ui.leftW}px`, '--right-w': `${ui.rightW}px`, '--timeline-h': `${ui.timelineH}px` }}>
    <${Topbar} />
    <div class="workspace">
      <aside class="panel left" aria-label="Library">
        <${Tabs} tabs=${LEFT_TABS} value="media" onChange=${() => {}} label="Library panel" />
        <div class="panel-body"><${Boundary} name="The media bin"><${MediaBin} /><//></div>
      </aside>
      <${Splitter} label="Resize library panel" value=${ui.leftW} min=${220} max=${maxSide} onChange=${(leftW) => setUi({ leftW })} />
      <main class="panel center" aria-label="Preview">
        <${Boundary} name="The preview"><${Monitor} /><//>
      </main>
      <${Splitter} label="Resize details panel" value=${ui.rightW} min=${280} max=${Math.max(320, Math.min(720, window.innerWidth * 0.5))} invert onChange=${(rightW) => setUi({ rightW })} />
      <${RightPanel} />
    </div>
    <${Splitter} vertical label="Resize timeline" value=${ui.timelineH} min=${160} max=${Math.max(200, window.innerHeight - 260)} invert onChange=${(timelineH) => setUi({ timelineH })} />
    <section class="timeline-region" aria-label="Timeline">
      <${Boundary} name="The timeline"><${Timeline} /><//>
    </section>
    <${StatusBar} />
    ${ui.dialog === 'export' && html`<${ExportDialog} onClose=${() => setUi({ dialog: null })} />`}
    ${ui.dialog === 'shortcuts' && html`<${ShortcutsDialog} onClose=${() => setUi({ dialog: null })} />`}
  </div>`;
}
