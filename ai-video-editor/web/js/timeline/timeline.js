// Timeline panel: toolbar, track headers and the tracks view (drawn and driven by
// TimelineController).
import { html, useEffect, useRef, useState, useStore, useEmitter, cx, Icon, IconButton, openMenu, MOD } from '../lib/ui.js';
import { timecode } from '../lib/time.js';
import { kbd } from '../lib/shortcuts.js';
import { setView, store, tracksOfKind } from '../state/store.js';
import * as A from '../state/actions.js';
import { transport } from '../player/transport.js';
import { TimelineController } from './controller.js';
import { HEADER_W, RULER_H, TRACK_H, LANE_GAP } from './geometry.js';
import { MAX_PX_PER_SEC, MIN_PX_PER_SEC, zoomBy, zoomTo, zoomToFit } from './view.js';

const exec = A.exec;

function Timecode() {
  const fps = useStore((s) => s.doc?.settings.fps);
  const t = useEmitter(transport, () => transport.frameTime);
  return html`<span class="tl-timecode tnum" aria-label="Playhead position" data-testid="timeline-timecode">${fps ? timecode(t, fps) : '--:--:--:--'}</span>`;
}

function Toolbar() {
  const { snapping, linked, pxPerSec } = useStore((s) => s.view);
  const hasSel = useStore((s) => s.sel.clips.size > 0 || !!s.sel.transition || !!s.sel.marker);
  const hasClips = useStore((s) => (s.doc?.clips.size || 0) > 0);
  // logarithmic zoom slider
  const zMin = Math.log(MIN_PX_PER_SEC);
  const zMax = Math.log(MAX_PX_PER_SEC);
  const zVal = pxPerSec ? (Math.log(pxPerSec) - zMin) / (zMax - zMin) : 0.5;
  const transitionMenu = (e) =>
    openMenu(e.currentTarget, [
      { heading: 'Add transition at the cut of the selected clip' },
      { label: 'Cross dissolve', icon: 'transition', hint: `${MOD}+T`, onSelect: () => A.addTransition('cross_dissolve') },
      { label: 'Dip to black', icon: 'transition', onSelect: () => A.addTransition('dip_to_black') },
      { label: 'Slide', icon: 'transition', onSelect: () => A.addTransition('slide') },
      { label: 'Push', icon: 'transition', onSelect: () => A.addTransition('push') },
    ]);
  const trackMenu = (e) =>
    openMenu(e.currentTarget, [
      { label: 'Add video track', icon: 'film', onSelect: () => exec({ type: 'add_track', kind: 'video' }) },
      { label: 'Add audio track', icon: 'music', onSelect: () => exec({ type: 'add_track', kind: 'audio' }) },
      { label: 'Add caption track', icon: 'captions', onSelect: () => exec({ type: 'add_track', kind: 'caption' }) },
    ]);
  return html`<div class="tl-toolbar" role="toolbar" aria-label="Timeline tools">
    <${Timecode} />
    <span class="tl-sep"></span>
    <${IconButton} icon="scissors" label="Split at playhead" kbd="S" disabled=${!hasClips} onClick=${() => A.splitAtPlayhead()} data-testid="tool-split" />
    <${IconButton} icon="trash" label="Delete (leave gap)" kbd="Del" disabled=${!hasSel} onClick=${() => A.deleteSelection()} data-testid="tool-delete" />
    <${IconButton} icon="ripple" label="Ripple delete (close gap)" kbd="Shift+Del" disabled=${!hasSel} onClick=${() => A.deleteSelection({ ripple: true })} data-testid="tool-ripple-delete" />
    <${IconButton} icon="copy" label="Duplicate" kbd=${kbd('mod+d')} disabled=${!hasSel} onClick=${() => A.duplicateSelection()} />
    <span class="tl-sep"></span>
    <${IconButton} icon="trim-start" label="Ripple trim start to playhead" kbd="Q" disabled=${!hasClips} onClick=${() => A.trimToPlayhead('start', { ripple: true })} />
    <${IconButton} icon="trim-end" label="Ripple trim end to playhead" kbd="W" disabled=${!hasClips} onClick=${() => A.trimToPlayhead('end', { ripple: true })} />
    <span class="tl-sep"></span>
    <${IconButton}
      icon="magnet"
      label=${snapping ? 'Snapping on' : 'Snapping off'}
      kbd="N"
      pressed=${snapping}
      onClick=${() => {
        setView({ snapping: !snapping });
        A.persistViewSoon();
      }}
      data-testid="toggle-snapping"
    />
    <${IconButton}
      icon=${linked ? 'link' : 'unlink'}
      label=${linked ? 'Linked selection on: linked video and audio select, move and trim together' : 'Linked selection off: linked clips are edited independently'}
      kbd=${kbd('mod+shift+l')}
      pressed=${linked}
      onClick=${() => {
        setView({ linked: !linked });
        A.persistViewSoon();
      }}
      data-testid="toggle-linked"
    />
    <span class="tl-sep"></span>
    <${IconButton} icon="type" label="Add text at playhead" kbd="T" onClick=${() => A.addTextAtPlayhead()} data-testid="tool-text" />
    <${IconButton} icon="transition" label="Add transition" onClick=${transitionMenu} aria-haspopup="menu" data-testid="tool-transition" />
    <${IconButton} icon="flag" label="Add marker" kbd="M" onClick=${() => A.addMarkerAtPlayhead()} />
    <${IconButton} icon="layers" label="Add track" onClick=${trackMenu} aria-haspopup="menu" />
    <span class="grow"></span>
    <${IconButton} icon="zoom-out" label="Zoom out" kbd="−" onClick=${() => zoomBy(1 / 1.4)} />
    <input
      class="slider tl-zoom"
      type="range"
      min="0"
      max="1"
      step="0.001"
      value=${zVal}
      aria-label="Timeline zoom"
      style=${{ '--fill': `${zVal * 100}%` }}
      onInput=${(e) => zoomTo(Math.exp(zMin + parseFloat(e.currentTarget.value) * (zMax - zMin)))}
    />
    <${IconButton} icon="zoom-in" label="Zoom in" kbd="+" onClick=${() => zoomBy(1.4)} />
    <${IconButton} icon="fit" label="Zoom to fit" kbd="Shift+Z" onClick=${() => zoomToFit()} tipPos="left" />
  </div>`;
}

function TrackHeader({ track, ordinalCount, ordinal }) {
  const [renaming, setRenaming] = useState(false);
  const update = (patch) => exec({ type: 'update_track', track_id: track.id, ...patch });
  const menu = (e) =>
    openMenu(e, [
      { label: 'Rename…', icon: 'pencil', onSelect: () => setRenaming(true) },
      track.kind === 'audio' && { label: track.muted ? 'Unmute' : 'Mute', icon: 'mute', onSelect: () => update({ muted: !track.muted }) },
      track.kind === 'audio' && { label: track.solo ? 'Unsolo' : 'Solo', icon: 'headphones', onSelect: () => update({ solo: !track.solo }) },
      track.kind !== 'audio' && { label: track.hidden ? 'Show' : 'Hide', icon: track.hidden ? 'eye' : 'eye-off', onSelect: () => update({ hidden: !track.hidden }) },
      { label: track.locked ? 'Unlock' : 'Lock', icon: track.locked ? 'unlock' : 'lock', onSelect: () => update({ locked: !track.locked }) },
      track.kind !== 'caption' && { separator: true },
      track.kind !== 'caption' && { label: track.kind === 'audio' ? 'Move up' : 'Move up (in front)', icon: 'chevron-up', disabled: track.kind === 'audio' ? ordinal === 0 : ordinal === ordinalCount - 1, onSelect: () => exec({ type: 'move_track', track_id: track.id, ordinal: ordinal + (track.kind === 'audio' ? -1 : 1) }) },
      track.kind !== 'caption' && { label: track.kind === 'audio' ? 'Move down' : 'Move down (behind)', icon: 'chevron-down', disabled: track.kind === 'audio' ? ordinal === ordinalCount - 1 : ordinal === 0, onSelect: () => exec({ type: 'move_track', track_id: track.id, ordinal: ordinal + (track.kind === 'audio' ? 1 : -1) }) },
      { separator: true },
      { label: 'Add video track', icon: 'film', onSelect: () => exec({ type: 'add_track', kind: 'video' }) },
      { label: 'Add audio track', icon: 'music', onSelect: () => exec({ type: 'add_track', kind: 'audio' }) },
      { separator: true },
      { label: 'Delete track', icon: 'trash', danger: true, onSelect: () => exec({ type: 'remove_track', track_id: track.id }, { errorTitle: 'Could not delete the track' }) },
    ]);
  return html`<div class=${cx('tl-header', track.kind, track.locked && 'locked')} style=${{ height: `${TRACK_H[track.kind]}px`, marginBottom: `${LANE_GAP}px` }} onContextMenu=${menu} data-track-id=${track.id} data-testid="track-header">
    ${renaming
      ? html`<input
          class="input tl-rename"
          aria-label="Track name"
          maxlength="40"
          defaultValue=${track.name}
          ref=${(el) => el && !el._f && ((el._f = 1), el.select())}
          onBlur=${(e) => {
            const v = e.currentTarget.value.trim();
            setRenaming(false);
            if (v && v !== track.name) update({ name: v });
          }}
          onKeyDown=${(e) => {
            if (e.key === 'Enter') e.currentTarget.blur();
            if (e.key === 'Escape') {
              e.currentTarget.value = track.name;
              e.currentTarget.blur();
            }
            e.stopPropagation();
          }}
        />`
      : html`<button type="button" class="tl-name truncate" onDblClick=${() => setRenaming(true)} onClick=${menu} aria-label=${`Track ${track.name} options`} aria-haspopup="menu">${track.name}</button>`}
    <div class="tl-header-btns">
      ${track.kind === 'audio'
        ? html`<${IconButton} small icon=${track.muted ? 'mute' : 'volume'} label=${track.muted ? `Unmute ${track.name}` : `Mute ${track.name}`} pressed=${track.muted} class=${track.muted ? 'warn' : ''} onClick=${() => update({ muted: !track.muted })} data-testid="track-mute" />
            <${IconButton} small icon="headphones" label=${track.solo ? `Unsolo ${track.name}` : `Solo ${track.name}`} pressed=${track.solo} onClick=${() => update({ solo: !track.solo })} data-testid="track-solo" />`
        : html`<${IconButton} small icon=${track.hidden ? 'eye-off' : 'eye'} label=${track.hidden ? `Show ${track.name}` : `Hide ${track.name}`} pressed=${track.hidden} class=${track.hidden ? 'warn' : ''} onClick=${() => update({ hidden: !track.hidden })} />`}
      <${IconButton} small icon=${track.locked ? 'lock' : 'unlock'} label=${track.locked ? `Unlock ${track.name}` : `Lock ${track.name}`} pressed=${track.locked} class=${track.locked ? 'warn' : ''} onClick=${() => update({ locked: !track.locked })} data-testid="track-lock" tipPos="right" />
    </div>
  </div>`;
}

function Headers() {
  const tracks = useStore((s) => s.doc?.tracks);
  const scrollY = useStore((s) => s.view.scrollY);
  const doc = store.state.doc;
  if (!tracks || !doc) return null;
  const counts = { video: tracksOfKind(doc, 'video'), audio: tracksOfKind(doc, 'audio'), caption: tracksOfKind(doc, 'caption') };
  return html`<div class="tl-headers" style=${{ width: `${HEADER_W}px` }}>
    <div class="tl-corner" style=${{ height: `${RULER_H}px` }}><span class="faint">Tracks</span></div>
    <div class="tl-header-list" style=${{ transform: `translateY(${-scrollY}px)` }}>
      ${tracks.map((t) => html`<${TrackHeader} key=${t.id} track=${t} ordinal=${counts[t.kind].findIndex((x) => x.id === t.id)} ordinalCount=${counts[t.kind].length} />`)}
    </div>
  </div>`;
}

export function Timeline() {
  const view = useRef(null);
  const canvas = useRef(null);
  const clips = useRef(null);
  const playhead = useRef(null);
  const hscroll = useRef(null);
  const vscroll = useRef(null);
  const empty = useRef(null);
  useEffect(() => {
    const c = new TimelineController({ view: view.current, canvas: canvas.current, clips: clips.current, playhead: playhead.current, hscroll: hscroll.current, vscroll: vscroll.current, empty: empty.current });
    return () => c.destroy();
  }, []);
  return html`<div class="tl" data-testid="timeline">
    <${Toolbar} />
    <div class="tl-main">
      <${Headers} />
      <div class="tl-stage">
        <div
          class="tl-view"
          ref=${view}
          tabindex="0"
          role="group"
          aria-label="Timeline tracks"
          aria-describedby="tl-help"
          data-testid="timeline-view"
        >
          <canvas ref=${canvas} class="tl-canvas" aria-hidden="true"></canvas>
          <div class="tl-clips" ref=${clips}></div>
          <div class="tl-playhead" ref=${playhead} aria-hidden="true"><i></i></div>
          <div class="tl-empty" ref=${empty} hidden>
            <${Icon} name="film" />
            <strong>Your timeline is empty</strong>
            <span>Drag media here from the bin, or double-click a clip in the bin to add it.</span>
          </div>
        </div>
        <div class="tl-vscroll" ref=${vscroll} tabindex="-1" aria-hidden="true"><div></div></div>
        <div class="tl-hscroll" ref=${hscroll} tabindex="-1" aria-hidden="true"><div></div></div>
      </div>
    </div>
    <p id="tl-help" class="sr-only">
      Clips are listed as buttons. Use ${MOD} plus the arrow keys to move between clips and tracks, Space to play, S to split at the playhead, Delete to remove the selection and Shift plus Delete to ripple delete. Press the
      context menu key on a clip for more actions.
    </p>
  </div>`;
}
