// Inspector: contextual properties for whatever is selected.
//
// Every control previews instantly through the store's `live` patch and commits
// exactly one undoable command per gesture (see inspector-clip.js).
import { html, useEffect, useStore } from '../lib/ui.js';
import { ClipInspector } from './inspector-clip.js';
import { MarkerInspector, ProjectInspector, TransitionInspector } from './inspector-project.js';

export function Inspector() {
  const { doc, sel, live, duration } = useStore((s) => ({ doc: s.doc, sel: s.sel, live: s.live, duration: s.duration }));
  // A different kind of selection shows a different set of sections: start at the top
  // again. (Stepping through clips of the same kind keeps the scroll position.)
  const viewKey = !doc
    ? ''
    : sel.transition
      ? 'transition'
      : sel.marker
        ? 'marker'
        : [...new Set([...sel.clips].map((id) => doc.clips.get(id)?.content.kind).filter(Boolean))].sort().join('+') || 'project';
  useEffect(() => {
    const body = document.querySelector('.panel.right > .panel-body');
    if (body) body.scrollTop = 0;
  }, [viewKey]);
  if (!doc) return null;
  const transition = sel.transition && doc.transitions.get(sel.transition);
  if (transition) return html`<${TransitionInspector} key=${transition.id} doc=${doc} transition=${transition} />`;
  const marker = sel.marker && doc.markers.find((m) => m.id === sel.marker);
  if (marker) return html`<${MarkerInspector} key=${marker.id} doc=${doc} marker=${marker} duration=${duration} />`;
  const clips = [...sel.clips].map((id) => doc.clips.get(id)).filter(Boolean);
  if (clips.length) {
    clips.sort((a, b) => a.start - b.start || (a.id < b.id ? -1 : 1));
    return html`<${ClipInspector} doc=${doc} clips=${clips} live=${live} />`;
  }
  return html`<${ProjectInspector} doc=${doc} duration=${duration} />`;
}
