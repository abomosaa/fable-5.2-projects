// Drag payload shared between the media bin (drag source) and the timeline (drop
// target). HTML5 drag-and-drop hides the payload during `dragover`, so the bin
// stores what is being dragged here.
export const dragPayload = {
  /** @type {null | {assetId: string}} */
  asset: null,
};
export const DRAG_MIME = 'application/x-cutline-asset';
