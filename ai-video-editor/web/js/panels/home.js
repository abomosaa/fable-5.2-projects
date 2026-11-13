// Home: the project list (create, open, rename, duplicate, delete).
import { html, useEffect, useMemo, useRef, useState, useStore, cx, Icon, IconButton, Spinner, Dialog, ConfirmDialog, Notice, openMenu, toast, timeAgo } from '../lib/ui.js';
import { mediaUrl } from '../lib/api.js';
import { fpsLabel, humanDuration } from '../lib/time.js';
import * as A from '../state/actions.js';
import { ModeBadges } from '../app.js';

const validName = (v) => {
  const t = v.trim();
  if (!t) return 'Give the project a name.';
  if ([...t].length > 120) return 'Project names can be at most 120 characters.';
  return null;
};

/** Small dialog with one validated name field (used for "New project" and "Rename"). */
function NameDialog({ title, initial, submitLabel, onSubmit, onClose, hint }) {
  const [name, setName] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [touched, setTouched] = useState(false);
  const ref = useRef(null);
  useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);
  const problem = validName(name);
  const submit = async (e) => {
    e?.preventDefault();
    setTouched(true);
    if (problem || busy) return;
    setBusy(true);
    setError(null);
    try {
      await onSubmit(name.trim());
      onClose();
    } catch (err) {
      setError(err.message || 'Something went wrong.');
      setBusy(false);
    }
  };
  const shown = error || (touched && problem);
  return html`<${Dialog}
    title=${title}
    onClose=${onClose}
    busy=${busy}
    initialFocus="#project-name-field"
    footer=${html`<button type="button" class="btn" onClick=${onClose} disabled=${busy}>Cancel</button>
      <button type="button" class="btn primary" onClick=${submit} disabled=${busy} data-testid="name-dialog-submit">${busy && html`<${Spinner} />`}${submitLabel}</button>`}
  >
    <form class="field" onSubmit=${submit} novalidate>
      <label for="project-name-field">Project name</label>
      <input
        id="project-name-field"
        ref=${ref}
        class="input large"
        maxlength="140"
        autocomplete="off"
        spellcheck="false"
        value=${name}
        aria-invalid=${shown ? 'true' : undefined}
        aria-describedby="project-name-help"
        onInput=${(e) => {
          setName(e.currentTarget.value);
          setError(null);
        }}
        data-testid="project-name-field"
      />
      <div id="project-name-help" class=${cx('field-help', shown && 'error')} role=${shown ? 'alert' : undefined}>${shown || hint || ' '}</div>
    </form>
  <//>`;
}

function Poster({ project }) {
  const [failed, setFailed] = useState(false);
  const id = project.poster_asset;
  useEffect(() => setFailed(false), [id]);
  if (!id || failed)
    return html`<div class="project-poster placeholder" aria-hidden="true">
      <${Icon} name=${project.clip_count ? 'waveform' : 'film'} />
    </div>`;
  return html`<div class="project-poster" aria-hidden="true"><img src=${mediaUrl(id, 'poster.jpg')} alt="" loading="lazy" decoding="async" draggable=${false} onError=${() => setFailed(true)} /></div>`;
}

function ProjectCard({ project, onRename, onDelete }) {
  const [busy, setBusy] = useState(false);
  const open = () => A.navigate({ name: 'editor', projectId: project.id });
  const duplicate = async () => {
    setBusy(true);
    try {
      await A.duplicateProject(project.id);
    } catch (e) {
      toast({ kind: 'error', title: 'Could not duplicate the project', detail: e.message });
    } finally {
      setBusy(false);
    }
  };
  const menu = (at) =>
    openMenu(at, [
      { label: 'Open', icon: 'film', onSelect: open },
      { label: 'Rename…', icon: 'pencil', onSelect: () => onRename(project) },
      { label: 'Duplicate', icon: 'copy', onSelect: duplicate },
      { separator: true },
      { label: 'Delete…', icon: 'trash', danger: true, onSelect: () => onDelete(project) },
    ]);
  const empty = project.clip_count === 0;
  const meta = `${project.width}×${project.height} · ${fpsLabel(project.fps)} fps`;
  return html`<li class=${cx('project-card', busy && 'busy')} data-testid="project-card" data-project-id=${project.id} onContextMenu=${menu}>
    <button
      type="button"
      class="project-open"
      onClick=${open}
      onKeyDown=${(e) => {
        if (e.key === 'F2') {
          e.preventDefault();
          onRename(project);
        } else if (e.key === 'Delete') {
          e.preventDefault();
          onDelete(project);
        }
      }}
      aria-label=${`Open project ${project.name}, ${empty ? 'empty timeline' : humanDuration(project.duration)}, edited ${timeAgo(project.updated_at_ms)}`}
    >
      <${Poster} project=${project} />
      <span class="project-duration tnum">${empty ? 'Empty' : humanDuration(project.duration)}</span>
      <span class="project-info">
        <span class="project-title truncate" title=${project.name}>${project.name}</span>
        <span class="project-meta truncate">${meta}</span>
        <span class="project-meta truncate">${project.clip_count} clip${project.clip_count === 1 ? '' : 's'} · edited ${timeAgo(project.updated_at_ms)}</span>
      </span>
    </button>
    <div class="project-more">
      ${busy ? html`<${Spinner} label="Duplicating" />` : html`<${IconButton} icon="more" label=${`Actions for ${project.name}`} tipPos="left" onClick=${(e) => menu(e.currentTarget)} data-testid="project-menu" />`}
    </div>
  </li>`;
}

function SkeletonGrid() {
  return html`<ul class="project-grid" aria-hidden="true">
    ${[0, 1, 2, 3].map(
      (i) => html`<li class="project-card skeleton" key=${i}>
        <div class="project-poster"></div>
        <div class="project-info"><span class="sk-line w60"></span><span class="sk-line w40"></span></div>
      </li>`,
    )}
  </ul>`;
}

function HealthStrips() {
  const health = useStore((s) => s.health);
  const online = useStore((s) => s.online);
  if (!health)
    return online
      ? null
      : html`<${Notice} kind="error">
          <strong>Cannot reach the Cutline server.</strong> Make sure it is still running (<code>cargo run --release</code>), then reload this page.
        <//>`;
  return html`
    ${!health.ffmpeg?.ok &&
    html`<${Notice} kind="error">
      <strong>FFmpeg was not found.</strong> Importing media and exporting need it. Install FFmpeg (ffmpeg.org/download — or <code>brew install ffmpeg</code>, <code>apt install ffmpeg</code>, <code>winget install ffmpeg</code>), or set
      <code>FFMPEG_PATH</code> and <code>FFPROBE_PATH</code> in <code>.env</code>, then restart the server.
    <//>`}
    ${health.ffmpeg?.ok && health.ffmpeg?.message && html`<${Notice} kind="warning">${health.ffmpeg.message}<//>`}
    ${health.fixture &&
    html`<${Notice} kind="info" icon="info">
      <strong>Fixture mode.</strong> Transcripts and the assistant use deterministic, clearly labelled test data — nothing is sent to Soniox or an AI model. Start the server without <code>--fixture</code> for live mode.
    <//>`}
    ${!health.fixture &&
    health.speech &&
    !health.speech.configured &&
    html`<${Notice} kind="warning">
      <strong>Transcription is not configured.</strong> Editing and export work, but transcript-based editing needs a Soniox key: add <code>SONIOX_API_KEY=…</code> to <code>.env</code> and restart the server (or start it with
      <code>--fixture</code> to try it with sample data).
    <//>`}
  `;
}

export function Home() {
  const { list, broken, loading, error } = useStore((s) => s.projects);
  const [dialog, setDialog] = useState(null); // {type:'new'} | {type:'rename', project} | {type:'delete', project} | {type:'delete-broken', project}
  const [query, setQuery] = useState('');
  useEffect(() => {
    document.title = 'Cutline';
    // The list is (re)loaded whenever the home screen appears, including the very
    // first page load where the router has no route change to react to.
    A.refreshProjects();
  }, []);

  const q = query.trim().toLowerCase();
  const shown = useMemo(() => (q ? list.filter((p) => p.name.toLowerCase().includes(q)) : list), [list, q]);
  const firstLoad = loading && !list.length && !error;
  const newProject = () => setDialog({ type: 'new' });
  const defaultName = useMemo(() => {
    const names = new Set(list.map((p) => p.name));
    if (!names.has('Untitled project')) return 'Untitled project';
    let n = 2;
    while (names.has(`Untitled project ${n}`)) n++;
    return `Untitled project ${n}`;
  }, [list]);

  const doDelete = async (project) => {
    try {
      await A.deleteProject(project.id);
      toast({ kind: 'success', title: `Deleted “${project.name || project.id}”` });
    } catch (e) {
      toast({ kind: 'error', title: 'Could not delete the project', detail: e.message });
    }
  };

  return html`<div class="home">
    <header class="home-top">
      <div class="brand">
        <span class="brand-mark" aria-hidden="true"><svg viewBox="0 0 32 32"><rect width="32" height="32" rx="7" fill="currentColor" /><path d="M9 8v16M9 16h14M23 8v16" stroke="#0a1026" stroke-width="3.2" stroke-linecap="round" fill="none" /></svg></span>
        <span class="brand-name">Cutline</span>
      </div>
      <div class="row" style="gap:8px;min-width:0">
        <${ModeBadges} />
      </div>
    </header>
    <main class="home-main">
      <div class="home-inner">
        <div class="home-strips"><${HealthStrips} /></div>
        <div class="home-head">
          <div class="grow">
            <h1>Projects</h1>
            <p class="muted">${list.length ? `${list.length} project${list.length === 1 ? '' : 's'} · every edit is saved automatically` : 'Edit video by timeline or by transcript. Everything saves automatically.'}</p>
          </div>
          ${list.length >= 6 &&
          html`<div class="search-field">
            <${Icon} name="search" />
            <input class="input" type="search" placeholder="Search projects" aria-label="Search projects" value=${query} onInput=${(e) => setQuery(e.currentTarget.value)} />
          </div>`}
          ${!(list.length === 0 && !error && !firstLoad) && html`<button type="button" class="btn primary large" onClick=${newProject} data-testid="new-project"><${Icon} name="plus" /> New project</button>`}
        </div>

        ${error &&
        html`<${Notice} kind="error" action=${html`<button type="button" class="btn small" onClick=${() => A.refreshProjects()}><${Icon} name="refresh" /> Retry</button>`}>
          <strong>Your projects could not be loaded.</strong> ${error}
        <//>`}

        ${firstLoad
          ? html`<div role="status" aria-label="Loading projects"><${SkeletonGrid} /></div>`
          : list.length === 0 && !error
            ? html`<section class="home-empty">
                <div class="home-empty-art" aria-hidden="true">
                  <span class="strip v"></span><span class="strip v short"></span><span class="strip a"></span><span class="strip a short"></span><span class="ph"></span>
                </div>
                <h2>Start your first project</h2>
                <p class="muted">Import video, audio, images and subtitles, cut on a multitrack timeline or straight from the transcript, then export up to 4K at 60 fps.</p>
                <button type="button" class="btn primary large" onClick=${newProject} data-testid="new-project"><${Icon} name="plus" /> New project</button>
              </section>`
            : shown.length === 0 && q
              ? html`<div class="empty" role="status">
                  <${Icon} name="search" />
                  <h3>No projects match “${query.trim()}”</h3>
                  <button type="button" class="btn" onClick=${() => setQuery('')}>Clear search</button>
                </div>`
              : html`<ul class="project-grid" aria-label="Projects" aria-busy=${loading ? 'true' : undefined}>
                  ${shown.map((p) => html`<${ProjectCard} key=${p.id} project=${p} onRename=${(project) => setDialog({ type: 'rename', project })} onDelete=${(project) => setDialog({ type: 'delete', project })} />`)}
                </ul>`}

        ${broken.length > 0 &&
        html`<section class="home-broken" aria-labelledby="broken-h">
          <h2 id="broken-h"><${Icon} name="alert" /> Needs attention</h2>
          <p class="muted">These project folders could not be opened. Nothing was deleted; you can remove them here or restore the files from a backup.</p>
          <ul>
            ${broken.map(
              (b) => html`<li key=${b.id} class="broken-row">
                <div class="grow">
                  <div class="truncate tnum" title=${b.id}>${b.id}</div>
                  <div class="broken-error">${b.error}</div>
                </div>
                <button type="button" class="btn danger small" onClick=${() => setDialog({ type: 'delete-broken', project: b })}><${Icon} name="trash" /> Delete</button>
              </li>`,
            )}
          </ul>
        </section>`}
      </div>
    </main>

    ${dialog?.type === 'new' &&
    html`<${NameDialog} title="New project" initial=${defaultName} submitLabel="Create project" hint="You can rename it at any time." onSubmit=${(name) => A.createProject(name)} onClose=${() => setDialog(null)} />`}
    ${dialog?.type === 'rename' &&
    html`<${NameDialog}
      title="Rename project"
      initial=${dialog.project.name}
      submitLabel="Rename"
      onSubmit=${async (name) => {
        if (name !== dialog.project.name) await A.renameProject(dialog.project.id, name);
      }}
      onClose=${() => setDialog(null)}
    />`}
    ${dialog?.type === 'delete' &&
    html`<${ConfirmDialog}
      title=${`Delete “${dialog.project.name}”?`}
      danger
      confirmLabel="Delete project"
      message=${html`This permanently deletes the project and its undo history, along with the exports, media files and transcripts that only this project uses. Any data still held by Soniox for its media is cleaned up as well. Media shared with a
      duplicate of this project is kept. <strong>This cannot be undone.</strong>`}
      onConfirm=${() => doDelete(dialog.project)}
      onClose=${() => setDialog(null)}
    />`}
    ${dialog?.type === 'delete-broken' &&
    html`<${ConfirmDialog}
      title="Delete damaged project?"
      danger
      confirmLabel="Delete folder"
      message=${html`The folder <code>${dialog.project.id}</code> will be removed from the data directory. If you have a backup of its <code>project.json</code>, restore it instead. This cannot be undone.`}
      onConfirm=${() => doDelete({ id: dialog.project.id, name: '' })}
      onClose=${() => setDialog(null)}
    />`}
  </div>`;
}
