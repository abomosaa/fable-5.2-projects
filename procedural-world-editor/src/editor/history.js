// Transactional undo / redo. DOM-free.
// A command is { label, undo(), redo(), bytes? }. Commands pushed between begin() and commit()
// form one undoable transaction. Memory is bounded by `limitBytes` (oldest entries are dropped).

export class History {
  constructor(limitBytes = 700e6, limitCount = 200) {
    this.undoStack = [];
    this.redoStack = [];
    this.limitBytes = limitBytes;
    this.limitCount = limitCount;
    this.open = null;
    this.listeners = new Set();
    this.revision = 0; // increments on every change to the document
    this.savedRevision = 0;
  }
  onChange(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
  _emit() {
    for (const fn of this.listeners) fn(this);
  }
  get canUndo() {
    return this.undoStack.length > 0;
  }
  get canRedo() {
    return this.redoStack.length > 0;
  }
  get dirty() {
    return this.revision !== this.savedRevision;
  }
  markSaved() {
    this.savedRevision = this.revision;
    this._emit();
  }
  get undoLabel() {
    return this.canUndo ? this.undoStack[this.undoStack.length - 1].label : null;
  }
  get redoLabel() {
    return this.canRedo ? this.redoStack[this.redoStack.length - 1].label : null;
  }

  begin(label) {
    if (this.open) throw new Error('history transaction already open: ' + this.open.label);
    this.open = { label, cmds: [] };
  }
  commit() {
    const t = this.open;
    this.open = null;
    if (!t || !t.cmds.length) return false;
    const cmds = t.cmds;
    this._push({
      label: t.label,
      bytes: cmds.reduce((s, c) => s + (c.bytes || 0), 0),
      undo: () => {
        for (let i = cmds.length - 1; i >= 0; i--) cmds[i].undo();
      },
      redo: () => {
        for (const c of cmds) c.redo();
      },
    });
    return true;
  }
  /** Abort the open transaction, undoing what it did so far. */
  rollback() {
    const t = this.open;
    this.open = null;
    if (!t) return;
    for (let i = t.cmds.length - 1; i >= 0; i--) t.cmds[i].undo();
  }

  /** Record a command that has ALREADY been applied. */
  push(cmd) {
    if (this.open) {
      this.open.cmds.push(cmd);
      return;
    }
    this._push(cmd);
  }
  _push(cmd) {
    // coalesce rapid edits of the same field (slider drags) into one entry
    const top = this.undoStack[this.undoStack.length - 1];
    if (cmd.mergeKey && top && top.mergeKey === cmd.mergeKey && cmd.time - top.time < 1200 && !this.redoStack.length) {
      const firstUndo = top.undo;
      top.redo = cmd.redo;
      top.undo = firstUndo;
      top.time = cmd.time;
      this.revision++;
      this._emit();
      return;
    }
    this.undoStack.push(cmd);
    this.redoStack.length = 0;
    this.revision++;
    this._trim();
    this._emit();
  }
  _trim() {
    let bytes = 0;
    for (const c of this.undoStack) bytes += c.bytes || 0;
    while (this.undoStack.length > 1 && (bytes > this.limitBytes || this.undoStack.length > this.limitCount)) {
      bytes -= this.undoStack.shift().bytes || 0;
    }
  }
  undo() {
    if (this.open) this.rollback();
    const c = this.undoStack.pop();
    if (!c) return null;
    c.undo();
    this.redoStack.push(c);
    this.revision++;
    this._emit();
    return c.label;
  }
  redo() {
    const c = this.redoStack.pop();
    if (!c) return null;
    c.redo();
    this.undoStack.push(c);
    this.revision++;
    this._emit();
    return c.label;
  }
  clear() {
    this.undoStack.length = 0;
    this.redoStack.length = 0;
    this.open = null;
    this.revision = 0;
    this.savedRevision = 0;
    this._emit();
  }
}

/** Region edit of a typed-array grid layer (heights, sediment, paint masks). */
export function gridCommand(label, grid, res, rect, before, after, apply) {
  const w = rect.x1 - rect.x0 + 1;
  const hgt = rect.z1 - rect.z0 + 1;
  const put = (buf) => {
    for (let j = 0; j < hgt; j++) grid.set(buf.subarray(j * w, j * w + w), (rect.z0 + j) * res + rect.x0);
    apply(rect);
  };
  return { label, bytes: before.byteLength + after.byteLength, undo: () => put(before), redo: () => put(after) };
}

/**
 * One undo step covering several grid layers edited in the same rect. The layers are restored
 * first and `apply(rect)` (re-derivation) runs afterwards, for undo and redo alike.
 * entries: [{grid, before, after}] where before/after are rect-sized copies.
 */
export function gridsCommand(label, res, rect, entries, apply) {
  const w = rect.x1 - rect.x0 + 1;
  const hgt = rect.z1 - rect.z0 + 1;
  const put = (key) => {
    for (const e of entries) for (let j = 0; j < hgt; j++) e.grid.set(e[key].subarray(j * w, j * w + w), (rect.z0 + j) * res + rect.x0);
    apply(rect);
  };
  return { label, bytes: entries.reduce((s, e) => s + e.before.byteLength + e.after.byteLength, 0), undo: () => put('before'), redo: () => put('after') };
}

export function extractRect(grid, res, rect) {
  const w = rect.x1 - rect.x0 + 1;
  const hgt = rect.z1 - rect.z0 + 1;
  const out = new grid.constructor(w * hgt);
  for (let j = 0; j < hgt; j++) {
    const s = (rect.z0 + j) * res + rect.x0;
    out.set(grid.subarray(s, s + w), j * w);
  }
  return out;
}

/** Replace the contents of `target` (object) with a deep copy of `source`, keeping the identity. */
export function replaceObject(target, source) {
  for (const k of Object.keys(target)) delete target[k];
  Object.assign(target, JSON.parse(JSON.stringify(source)));
}

/**
 * Document edit: `beforeJSON` / `afterJSON` are JSON strings of the document; `apply(kind)` re-derives.
 */
export function docCommand(label, doc, beforeJSON, afterJSON, apply, mergeKey) {
  return {
    label,
    bytes: (beforeJSON.length + afterJSON.length) * 2,
    mergeKey,
    time: typeof performance !== 'undefined' ? performance.now() : Date.now(),
    undo: () => {
      replaceObject(doc, JSON.parse(beforeJSON));
      apply();
    },
    redo: () => {
      replaceObject(doc, JSON.parse(afterJSON));
      apply();
    },
  };
}
