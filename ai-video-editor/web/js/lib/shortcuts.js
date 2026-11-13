// Keyboard shortcuts. One table drives both the key handler and the shortcuts dialog.
import { isMac, MOD, toast } from './ui.js';
import { setUi, setView, store } from '../state/store.js';
import * as A from '../state/actions.js';
import { transport } from '../player/transport.js';
import { zoomBy, zoomToFit } from '../timeline/view.js';

const openDialog = (dialog) => setUi({ dialog });

/** combo syntax: "mod+shift+z", "space", "arrowleft", "shift+delete", "?" */
export const SHORTCUTS = [
  { group: 'Playback', combos: ['space'], label: 'Play / pause', run: () => transport.toggle() },
  { group: 'Playback', combos: ['k'], label: 'Pause', run: () => transport.pause() },
  { group: 'Playback', combos: ['l'], label: 'Play forward (press again: faster)', run: () => transport.shuttle(1) },
  { group: 'Playback', combos: ['j'], label: 'Play backward (press again: faster)', run: () => transport.shuttle(-1) },
  { group: 'Playback', combos: ['arrowleft'], label: 'Previous frame', run: () => transport.stepFrames(-1), repeat: true },
  { group: 'Playback', combos: ['arrowright'], label: 'Next frame', run: () => transport.stepFrames(1), repeat: true },
  { group: 'Playback', combos: ['shift+arrowleft'], label: 'Back 10 frames', run: () => transport.stepFrames(-10), repeat: true },
  { group: 'Playback', combos: ['shift+arrowright'], label: 'Forward 10 frames', run: () => transport.stepFrames(10), repeat: true },
  { group: 'Playback', combos: ['arrowup'], label: 'Previous edit point', run: () => A.jumpToEdit(-1), repeat: true },
  { group: 'Playback', combos: ['arrowdown'], label: 'Next edit point', run: () => A.jumpToEdit(1), repeat: true },
  { group: 'Playback', combos: ['home'], label: 'Go to start', run: () => transport.seek(0) },
  { group: 'Playback', combos: ['end'], label: 'Go to end', run: () => transport.seek(store.state.duration) },

  { group: 'Editing', combos: ['s', 'mod+b'], label: 'Split at playhead', run: () => A.splitAtPlayhead() },
  { group: 'Editing', combos: ['delete', 'backspace'], label: 'Delete (leave gap)', run: () => A.deleteSelection({ ripple: false }) },
  { group: 'Editing', combos: ['shift+delete', 'shift+backspace'], label: 'Ripple delete (close gap)', run: () => A.deleteSelection({ ripple: true }) },
  { group: 'Editing', combos: ['q'], label: 'Ripple trim start to playhead', run: () => A.trimToPlayhead('start', { ripple: true }) },
  { group: 'Editing', combos: ['w'], label: 'Ripple trim end to playhead', run: () => A.trimToPlayhead('end', { ripple: true }) },
  { group: 'Editing', combos: ['['], label: 'Trim start to playhead', run: () => A.trimToPlayhead('start') },
  { group: 'Editing', combos: [']'], label: 'Trim end to playhead', run: () => A.trimToPlayhead('end') },
  { group: 'Editing', combos: ['mod+d'], label: 'Duplicate', run: () => A.duplicateSelection() },
  { group: 'Editing', combos: ['mod+c'], label: 'Copy', run: () => A.copySelection() },
  { group: 'Editing', combos: ['mod+x'], label: 'Cut', run: () => A.cutSelection() },
  { group: 'Editing', combos: ['mod+v'], label: 'Paste at playhead', run: () => A.paste() },
  { group: 'Editing', combos: ['mod+shift+v'], label: 'Paste insert (ripple)', run: () => A.paste({ mode: 'insert' }) },
  { group: 'Editing', combos: ['alt+arrowleft'], label: 'Nudge left one frame', run: () => A.nudgeSelection(-1), repeat: true },
  { group: 'Editing', combos: ['alt+arrowright'], label: 'Nudge right one frame', run: () => A.nudgeSelection(1), repeat: true },
  { group: 'Editing', combos: ['alt+shift+arrowleft'], label: 'Nudge left 10 frames', run: () => A.nudgeSelection(-10), repeat: true },
  { group: 'Editing', combos: ['alt+shift+arrowright'], label: 'Nudge right 10 frames', run: () => A.nudgeSelection(10), repeat: true },
  { group: 'Editing', combos: ['d'], label: 'Enable / disable clip', run: () => A.toggleEnabled() },
  { group: 'Editing', combos: ['mod+t'], label: 'Add cross dissolve', run: () => A.addTransition('cross_dissolve') },
  { group: 'Editing', combos: ['t'], label: 'Add text at playhead', run: () => A.addTextAtPlayhead() },
  { group: 'Editing', combos: ['m'], label: 'Add marker', run: () => A.addMarkerAtPlayhead() },
  { group: 'Editing', combos: ['mod+z'], label: 'Undo', run: () => A.undo() },
  { group: 'Editing', combos: ['mod+shift+z', 'mod+y'], label: 'Redo', run: () => A.redo() },

  { group: 'Selection', combos: ['mod+a'], label: 'Select all clips', run: () => A.selectAll() },
  { group: 'Selection', combos: ['escape'], label: 'Deselect', run: () => A.clearSelection() },
  { group: 'Selection', combos: ['mod+shift+l'], label: 'Toggle linked selection', run: () => toggleView('linked', 'Linked selection') },
  { group: 'Selection', combos: ['mod+alt+l'], label: 'Link / unlink clips', run: () => (A.selectedClips().some((c) => c.link_id) ? A.unlinkSelection() : A.linkSelection()) },
  { group: 'Selection', combos: ['mod+g'], label: 'Group clips', run: () => A.groupSelection() },
  { group: 'Selection', combos: ['mod+shift+g'], label: 'Ungroup clips', run: () => A.ungroupSelection() },

  { group: 'Timeline', combos: ['n'], label: 'Toggle snapping', run: () => toggleView('snapping', 'Snapping') },
  { group: 'Timeline', combos: ['=', '+'], label: 'Zoom in', run: () => zoomBy(1.4), repeat: true },
  { group: 'Timeline', combos: ['-'], label: 'Zoom out', run: () => zoomBy(1 / 1.4), repeat: true },
  { group: 'Timeline', combos: ['shift+z'], label: 'Zoom to fit', run: () => zoomToFit() },

  { group: 'Project', combos: ['mod+e'], label: 'Export…', run: () => openDialog('export') },
  { group: 'Project', combos: ['mod+i'], label: 'Import media…', run: () => document.getElementById('import-input')?.click() },
  { group: 'Project', combos: ['mod+s'], label: 'Save (projects save automatically)', run: () => toast({ kind: 'success', title: 'All changes are saved automatically', timeout: 2200 }) },
  { group: 'Project', combos: ['?', 'shift+/'], label: 'Keyboard shortcuts', run: () => openDialog('shortcuts') },
];

function toggleView(key, label) {
  const v = !store.state.view[key];
  setView({ [key]: v });
  A.persistViewSoon();
  toast({ title: `${label} ${v ? 'on' : 'off'}`, timeout: 1500 });
}

/** Pretty key caps for a combo, e.g. "mod+shift+z" → ["Ctrl","Shift","Z"]. */
export function comboKeys(combo) {
  const names = { mod: MOD, shift: isMac ? '⇧' : 'Shift', alt: isMac ? '⌥' : 'Alt', space: 'Space', arrowleft: '←', arrowright: '→', arrowup: '↑', arrowdown: '↓', delete: 'Del', backspace: '⌫', escape: 'Esc', home: 'Home', end: 'End' };
  if (combo === '+') return ['+'];
  return combo.split('+').map((k) => names[k] || k.toUpperCase());
}

/** Shortcut hint for tooltips, e.g. kbd('mod+z') → "Ctrl+Z". */
export const kbd = (combo) => comboKeys(combo).join(isMac ? '' : '+');

const index = new Map();
for (const s of SHORTCUTS) for (const c of s.combos) index.set(c, s);

function comboOf(e) {
  let key = e.key.toLowerCase();
  if (key === ' ') key = 'space';
  const parts = [];
  if (isMac ? e.metaKey : e.ctrlKey) parts.push('mod');
  if (e.altKey) parts.push('alt');
  if (e.shiftKey) parts.push('shift');
  // with alt held, e.key may be a composed character (mac): fall back to the physical key
  if (e.altKey && e.code.startsWith('Key')) key = e.code.slice(3).toLowerCase();
  return { withShift: [...parts, key].join('+'), bare: [...parts.filter((p) => p !== 'shift'), key].join('+') };
}

const isTextTarget = (el) => !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable);

/** Install the global key handler. Returns an uninstall function. */
export function installShortcuts() {
  const onKey = (e) => {
    if (e.defaultPrevented || !store.state.doc) return;
    if (store.state.ui.dialog || document.querySelector('.scrim, .menu')) return;
    const typing = isTextTarget(e.target);
    const { withShift, bare } = comboOf(e);
    // symbols such as "?" or "+" already include shift in e.key
    const hit = index.get(withShift) || (e.key.length === 1 && !/[a-z0-9]/i.test(e.key) ? index.get(bare) : null);
    if (!hit) return;
    if (typing) {
      // inside text fields only non-text combos stay active, and never clipboard / undo keys
      const combo = index.get(withShift) ? withShift : bare;
      const safe = combo.startsWith('mod+') && !['mod+a', 'mod+c', 'mod+x', 'mod+v', 'mod+z', 'mod+shift+z', 'mod+y', 'mod+b', 'mod+i', 'mod+d', 'mod+t', 'mod+g'].includes(combo);
      if (!safe) return;
    }
    // Space/Enter on a focused button must activate the button, not the transport
    if ((withShift === 'space' || withShift === 'enter') && e.target instanceof HTMLElement && e.target.closest('button, a, [role="button"], [role="tab"], [role="menuitem"], summary')) {
      if (!e.target.closest('[data-shortcut-passthrough]')) return;
    }
    if (e.repeat && !hit.repeat) {
      e.preventDefault();
      return;
    }
    e.preventDefault();
    hit.run(e);
  };
  window.addEventListener('keydown', onKey);
  return () => window.removeEventListener('keydown', onKey);
}
