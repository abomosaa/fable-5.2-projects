// Inspector view for one or more selected clips.
import { html, useState, useRef, useEffect, cx, Icon, Notice, Segmented, toast } from '../lib/ui.js';
import { applyClipPatch, clipLabel, linkGroups, setLive, store, trackById } from '../state/store.js';
import * as A from '../state/actions.js';
import { clipEnd, frameTicks, humanDuration, secondsToTicks, sourceOut, syncAnchor, timecode, TPS } from '../lib/time.js';
import { alphaOf, Chips, ColorField, Head, ISection, Locked, Num, round, Row, shared, SliderNum, TimeField, Toggle, useId, withAlpha } from './inspector-controls.js';

export const KIND = {
  video: { icon: 'film', label: 'Video clip' },
  audio: { icon: 'music', label: 'Audio clip' },
  image: { icon: 'image', label: 'Image' },
  text: { icon: 'type', label: 'Text' },
  caption: { icon: 'captions', label: 'Caption' },
};

const DEFAULT_TRANSFORM = { x: 0, y: 0, scale: 1, rotation: 0, flip_h: false, flip_v: false };
const DEFAULT_CROP = { crop_left: 0, crop_top: 0, crop_right: 0, crop_bottom: 0 };
const DEFAULT_COLOR = { brightness: 1, contrast: 1, saturation: 1, temperature: 0 };
const DEFAULT_TEXT_STYLE = { font_size: 0.09, text_color: '#ffffff', bold: true, align: 'center', background: null, outline_color: '#000000', outline_width: 0, shadow: true };

const SPEED_PRESETS = [0.25, 0.5, 1, 1.5, 2, 4].map((v) => ({ value: v, label: `${v}×` }));
let rippleSpeed = true;
/** Set by "Edit caption style": the project view scrolls to that section when it mounts. */
export const pendingScroll = { target: null };

const isVisual = (c) => c.content.kind === 'video' || c.content.kind === 'image' || c.content.kind === 'text';
const isPicture = (c) => c.content.kind === 'video' || c.content.kind === 'image';
const isTimed = (c) => c.content.kind === 'video' || c.content.kind === 'audio';
const speedOf = (c) => c.speed.num / c.speed.den;

/** Live preview + single undoable commit for a set of clips. */
function editor(clips) {
  const ids = clips.map((c) => c.id);
  return {
    ids,
    live: (patch) => ids.length && setLive(ids, patch),
    commit: (patch) => {
      if (!ids.length) return Promise.resolve(null);
      setLive(ids, patch); // keep showing the new value until the server confirms
      return A.exec({ type: 'update_clips', clip_ids: ids, patch }).then((change) => {
        if (!change) setLive(null);
        return change;
      });
    },
  };
}

/** Bind one numeric clip property (stored value ↔ displayed value). */
function bind(ed, clips, key, get, { toUi = (v) => v, fromUi = (v) => v } = {}) {
  const s = shared(clips, get);
  return {
    value: s.value === undefined ? undefined : toUi(s.value),
    mixed: s.mixed,
    onInput: (v) => ed.live({ [key]: fromUi(v) }),
    onCommit: (v) => ed.commit({ [key]: fromUi(v) }),
  };
}

const pct = { toUi: (v) => round(v * 100, 2), fromUi: (v) => round(v / 100, 4) };

// ---------------------------------------------------------------------------------

function Timing({ doc, clips }) {
  const fps = doc.settings.fps;
  const frame = frameTicks(fps);
  const startId = useId();
  const durId = useId();
  const srcId = useId();
  const start = Math.min(...clips.map((c) => c.start));
  const end = Math.max(...clips.map(clipEnd));
  const dur = shared(clips, (c) => c.duration);
  const timed = clips.filter(isTimed);
  const srcIn = shared(timed, (c) => c.source_in);
  const srcOut = shared(timed, (c) => Math.round(sourceOut(c)));
  const many = clips.length > 1;

  const move = (t) => {
    const delta = t - start;
    if (!delta) return;
    A.exec({ type: 'move_clips', moves: clips.map((c) => ({ clip_id: c.id, start: c.start + delta, track_id: c.track_id })) }, { errorTitle: 'Could not move the clip' });
  };
  const resize = (d) => {
    const delta = d - dur.value;
    if (!delta) return;
    A.exec({ type: 'trim_clips', clip_ids: clips.map((c) => c.id), edge: 'end', delta, ripple: false }, { errorTitle: 'Could not change the duration' });
  };
  const slip = (t) => {
    const delta = t - srcIn.value;
    if (!delta) return;
    A.exec({ type: 'slip_clips', clip_ids: timed.map((c) => c.id), delta }, { errorTitle: 'Could not slip the clip' });
  };
  return html`<${ISection} title="Timing">
    <${Row} label=${many ? 'Starts at' : 'Start'} name="start" htmlFor=${startId}>
      <${TimeField} id=${startId} value=${start} fps=${fps} label="Start time" onCommit=${move} />
    <//>
    <${Row} label="Duration" name="duration" htmlFor=${durId} hint=${dur.mixed ? 'The selected clips have different lengths.' : undefined}>
      <${TimeField} id=${durId} value=${dur.value} mixed=${dur.mixed} disabled=${dur.mixed} fps=${fps} label="Duration" min=${frame} onCommit=${resize} />
    <//>
    <${Row} label=${many ? 'Ends at' : 'End'} name="end">
      <${TimeField} value=${end} fps=${fps} label="End time" readOnly />
    <//>
    ${timed.length > 0 &&
    html`<${Row} label="Source in" name="source-in" htmlFor=${srcId} hint=${srcIn.mixed ? undefined : 'Change to slip the footage inside the clip.'}>
        <${TimeField} id=${srcId} value=${srcIn.value} mixed=${srcIn.mixed} disabled=${srcIn.mixed} fps=${fps} label="Source in (slip)" onCommit=${slip} />
      <//>
      <${Row} label="Source out" name="source-out">
        <${TimeField} value=${srcOut.value} mixed=${srcOut.mixed} fps=${fps} label="Source out" readOnly />
      <//>`}
  <//>`;
}

function Speed({ clips }) {
  const timed = clips.filter(isTimed);
  const [ripple, setRipple] = useState(rippleSpeed);
  const id = useId();
  if (!timed.length) return null;
  const s = shared(timed, speedOf);
  const apply = (v) => {
    if (!s.mixed && Math.abs(v - s.value) < 1e-9) return;
    A.exec({ type: 'set_speed', clip_ids: timed.map((c) => c.id), speed: v, ripple }, { errorTitle: 'Could not change the speed' });
  };
  return html`<${ISection} title="Speed" onReset=${() => apply(1)} canReset=${s.mixed || s.value !== 1}>
    <${Row} label="Speed" name="speed" htmlFor=${id}>
      <${Num} id=${id} value=${s.value} mixed=${s.mixed} min=${0.1} max=${16} step=${0.05} precision=${2} unit="×" label="Playback speed" onCommit=${(v) => apply(round(v, 3))} />
    <//>
    <${Chips} options=${SPEED_PRESETS} value=${s.mixed ? null : s.value} onPick=${apply} label="Speed presets" />
    <${Row} label="Ripple" name="speed-ripple" hint="Later clips follow the new length. Pitch is preserved.">
      <${Toggle}
        checked=${ripple}
        label="Ripple the timeline when the clip length changes"
        onChange=${(v) => {
          rippleSpeed = v;
          setRipple(v);
        }}
      />
    <//>
  <//>`;
}

/** Scale that makes the (cropped) picture cover the whole frame; 1 == fit inside. */
function coverScale(doc, clip) {
  const a = doc.assets.get(clip.content.asset_id);
  if (!a || !a.width || !a.height) return 1;
  const cr = clip.transform.crop;
  const cw = a.width * (1 - cr.left - cr.right);
  const ch = a.height * (1 - cr.top - cr.bottom);
  if (cw <= 0 || ch <= 0) return 1;
  const fx = doc.settings.width / cw;
  const fy = doc.settings.height / ch;
  return round(Math.max(fx, fy) / Math.min(fx, fy), 4);
}

function Transform({ doc, clips, locked }) {
  const visual = clips.filter(isVisual);
  const xId = useId();
  if (!visual.length) return null;
  const ed = editor(visual);
  const t = (k) => (c) => c.transform[k];
  const x = bind(ed, visual, 'x', t('x'), pct);
  const y = bind(ed, visual, 'y', t('y'), pct);
  const scale = bind(ed, visual, 'scale', t('scale'), pct);
  const rot = bind(ed, visual, 'rotation', t('rotation'), { toUi: (v) => round(v, 2), fromUi: (v) => round(v, 2) });
  const fh = shared(visual, t('flip_h'));
  const fv = shared(visual, t('flip_v'));
  const pictures = visual.filter(isPicture);
  const isDefault = visual.every((c) => Object.entries(DEFAULT_TRANSFORM).every(([k, v]) => c.transform[k] === v));

  const fill = () => {
    const groups = new Map();
    for (const c of pictures) {
      const s = coverScale(doc, c);
      (groups.get(s) || groups.set(s, []).get(s)).push(c.id);
    }
    const cmds = [...groups].map(([s, ids]) => ({ type: 'update_clips', clip_ids: ids, patch: { scale: s, x: 0, y: 0 } }));
    A.exec(cmds.length === 1 ? cmds[0] : { type: 'batch', commands: cmds, label: 'Fill frame' });
  };
  return html`<${ISection} title="Transform" onReset=${() => ed.commit(DEFAULT_TRANSFORM)} canReset=${!isDefault}>
    <${Row} label="Position" name="position" htmlFor=${xId}>
      <div class="pair">
        <span data-testid="prop-x"><${Num} id=${xId} ...${x} min=${-400} max=${400} step=${0.5} precision=${1} unit="%" scrub="X" label="Horizontal position" /></span>
        <span data-testid="prop-y"><${Num} ...${y} min=${-400} max=${400} step=${0.5} precision=${1} unit="%" scrub="Y" label="Vertical position" /></span>
      </div>
    <//>
    <${SliderNum} name="scale" label="Scale" ...${scale} min=${1} max=${2000} sliderMin=${10} sliderMax=${400} step=${1} precision=${0} unit="%" resetTo=${100} />
    <${SliderNum} name="rotation" label="Rotation" ...${rot} min=${-3600} max=${3600} sliderMin=${-180} sliderMax=${180} step=${1} precision=${1} unit="°" resetTo=${0} />
    <${Row} label="Flip" name="flip">
      <div class="btn-row">
        <button type="button" class="btn small" aria-pressed=${String(!!fh.value && !fh.mixed)} disabled=${locked} onClick=${() => ed.commit({ flip_h: fh.mixed ? true : !fh.value })}>Horizontal</button>
        <button type="button" class="btn small" aria-pressed=${String(!!fv.value && !fv.mixed)} disabled=${locked} onClick=${() => ed.commit({ flip_v: fv.mixed ? true : !fv.value })}>Vertical</button>
      </div>
    <//>
    <${Row} label="Place" name="place">
      <div class="btn-row">
        ${pictures.length > 0 &&
        html`<button type="button" class="btn small" disabled=${locked} title="Show the whole picture inside the frame" onClick=${() => editor(pictures).commit({ scale: 1, x: 0, y: 0 })}>Fit</button>
          <button type="button" class="btn small" disabled=${locked} title="Scale up until the picture covers the whole frame" onClick=${fill}>Fill</button>`}
        <button type="button" class="btn small" disabled=${locked} title="Centre in the frame" onClick=${() => ed.commit({ x: 0, y: 0 })}>Centre</button>
      </div>
    <//>
  <//>`;
}

function Crop({ clips }) {
  const pictures = clips.filter(isPicture);
  if (!pictures.length) return null;
  const ed = editor(pictures);
  const cr = (k) => (c) => c.transform.crop[k];
  // the two edges of one axis may remove at most 95 % together
  const room = (opposite) => Math.max(0, 95 - Math.max(...pictures.map((c) => c.transform.crop[opposite] * 100)));
  const edge = (key, side, opposite, label) => {
    const b = bind(ed, pictures, key, cr(side), pct);
    const max = round(room(opposite), 1);
    return html`<${SliderNum} name=${`crop-${side}`} label=${label} ...${b} min=${0} max=${max} sliderMax=${Math.max(max, 1)} step=${0.5} precision=${1} unit="%" resetTo=${0} />`;
  };
  const isDefault = pictures.every((c) => Object.values(c.transform.crop).every((v) => v === 0));
  return html`<${ISection} title="Crop" defaultOpen=${false} onReset=${() => ed.commit(DEFAULT_CROP)} canReset=${!isDefault}>
    ${edge('crop_left', 'left', 'right', 'Left')} ${edge('crop_right', 'right', 'left', 'Right')} ${edge('crop_top', 'top', 'bottom', 'Top')} ${edge('crop_bottom', 'bottom', 'top', 'Bottom')}
  <//>`;
}

function fadeBinding(ed, clips, key) {
  const maxSec = round(Math.min(...clips.map((c) => c.duration)) / TPS, 2);
  const b = bind(ed, clips, key, (c) => c[key], { toUi: (v) => round(v / TPS, 2), fromUi: (v) => secondsToTicks(v) });
  return { ...b, max: maxSec };
}

function Fades({ ed, clips, prefix }) {
  const fi = fadeBinding(ed, clips, 'fade_in');
  const fo = fadeBinding(ed, clips, 'fade_out');
  const sMax = Math.max(0.1, Math.min(fi.max, 5));
  return html`
    <${SliderNum} name=${`${prefix}fade-in`} label="Fade in" value=${fi.value} mixed=${fi.mixed} onInput=${fi.onInput} onCommit=${fi.onCommit} min=${0} max=${fi.max} sliderMax=${sMax} step=${0.05} precision=${2} unit="s" resetTo=${0} />
    <${SliderNum} name=${`${prefix}fade-out`} label="Fade out" value=${fo.value} mixed=${fo.mixed} onInput=${fo.onInput} onCommit=${fo.onCommit} min=${0} max=${fo.max} sliderMax=${sMax} step=${0.05} precision=${2} unit="s" resetTo=${0} />
  `;
}

function Opacity({ clips }) {
  const visual = clips.filter(isVisual);
  if (!visual.length) return null;
  const ed = editor(visual);
  const op = bind(ed, visual, 'opacity', (c) => c.transform.opacity, { toUi: (v) => Math.round(v * 100), fromUi: (v) => round(v / 100, 3) });
  const isDefault = visual.every((c) => c.transform.opacity === 1 && c.fade_in === 0 && c.fade_out === 0);
  return html`<${ISection} title="Opacity & fades" onReset=${() => ed.commit({ opacity: 1, fade_in: 0, fade_out: 0 })} canReset=${!isDefault}>
    <${SliderNum} name="opacity" label="Opacity" ...${op} min=${0} max=${100} step=${1} unit="%" resetTo=${100} />
    <${Fades} ed=${ed} clips=${visual} prefix="" />
  <//>`;
}

function Colour({ clips }) {
  const pictures = clips.filter(isPicture);
  if (!pictures.length) return null;
  const ed = editor(pictures);
  const p100 = { toUi: (v) => Math.round(v * 100), fromUi: (v) => round(v / 100, 3) };
  const c = (k) => bind(ed, pictures, k, (clip) => clip.color[k], p100);
  const isDefault = pictures.every((clip) => Object.entries(DEFAULT_COLOR).every(([k, v]) => clip.color[k] === v));
  return html`<${ISection} title="Colour" onReset=${() => ed.commit(DEFAULT_COLOR)} canReset=${!isDefault}>
    <${SliderNum} name="brightness" label="Brightness" ...${c('brightness')} min=${0} max=${200} step=${1} unit="%" resetTo=${100} />
    <${SliderNum} name="contrast" label="Contrast" ...${c('contrast')} min=${0} max=${200} step=${1} unit="%" resetTo=${100} />
    <${SliderNum} name="saturation" label="Saturation" ...${c('saturation')} min=${0} max=${200} step=${1} unit="%" resetTo=${100} />
    <${SliderNum} name="temperature" label="Temperature" ...${c('temperature')} min=${-100} max=${100} step=${1} resetTo=${0} hint="Negative is cooler, positive is warmer." />
  <//>`;
}

function Audio({ clips }) {
  const audio = clips.filter((c) => c.content.kind === 'audio');
  if (!audio.length) return null;
  const ed = editor(audio);
  const gain = bind(ed, audio, 'gain_db', (c) => c.gain_db, { toUi: (v) => round(v, 1), fromUi: (v) => round(v, 1) });
  const isDefault = audio.every((c) => c.gain_db === 0 && c.fade_in === 0 && c.fade_out === 0);
  const silent = !gain.mixed && gain.value <= -60;
  return html`<${ISection} title="Audio" onReset=${() => ed.commit({ gain_db: 0, fade_in: 0, fade_out: 0 })} canReset=${!isDefault}>
    <${SliderNum} name="gain" label="Volume" ...${gain} min=${-60} max=${24} step=${0.5} precision=${1} unit="dB" resetTo=${0} hint=${silent ? 'Muted: −60 dB is silent.' : '0 dB is the original level; −60 dB is silent.'} />
    <${Fades} ed=${ed} clips=${audio} prefix="audio-" />
  <//>`;
}

/** Multi-line text that previews while typing and commits on blur / Ctrl+Enter. */
function TextArea({ id, value, mixed, onLive, onCommit, onCancel, disabled, label, maxlength }) {
  const [draft, setDraft] = useState(null);
  const cancelled = useRef(false);
  const finish = () => {
    if (draft == null) return;
    const text = draft;
    setDraft(null);
    if (cancelled.current) {
      cancelled.current = false;
      return onCancel?.();
    }
    if (!text.trim()) {
      onCancel?.();
      return toast({ kind: 'warning', title: 'Text cannot be empty', detail: 'Delete the clip instead if you no longer need it.' });
    }
    if (mixed || text !== value) onCommit(text);
    else onCancel?.();
  };
  return html`<textarea
    id=${id}
    class="textarea"
    rows="3"
    aria-label=${label}
    maxlength=${maxlength}
    disabled=${disabled}
    placeholder=${mixed ? 'Multiple values — type to replace all' : 'Type here…'}
    value=${draft ?? (mixed ? '' : value)}
    onInput=${(e) => {
      const v = e.currentTarget.value;
      setDraft(v);
      if (v.trim()) onLive?.(v);
    }}
    onBlur=${finish}
    onKeyDown=${(e) => {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        e.currentTarget.blur();
      } else if (e.key === 'Escape') {
        cancelled.current = true;
        e.currentTarget.blur();
      }
      e.stopPropagation();
    }}
  ></textarea>`;
}

function Background({ ed, clips, getBg, patchKey = 'background', locked }) {
  const bg = shared(clips, getBg);
  const on = !bg.mixed && !!bg.value;
  const hex = on ? bg.value.slice(0, 7) : '#000000';
  const alpha = on ? alphaOf(bg.value) : 0.7;
  const colorId = useId();
  return html`
    <${Row} label="Background" name="background">
      <${Toggle} checked=${on} mixed=${bg.mixed} label="Background box" onChange=${(v) => ed.commit({ [patchKey]: v ? '#000000b3' : null })} />
    <//>
    ${on &&
    html`<${Row} label="Box colour" name="background-color" htmlFor=${colorId}>
        <${ColorField} id=${colorId} value=${hex} label="Background colour" onInput=${(c) => ed.live({ [patchKey]: withAlpha(c, alpha) })} onCommit=${(c) => ed.commit({ [patchKey]: withAlpha(c, alpha) })} />
      <//>
      <${SliderNum}
        name="background-opacity"
        label="Box opacity"
        value=${Math.round(alpha * 100)}
        min=${5}
        max=${100}
        step=${1}
        unit="%"
        disabled=${locked}
        onInput=${(v) => ed.live({ [patchKey]: withAlpha(hex, v / 100) })}
        onCommit=${(v) => ed.commit({ [patchKey]: withAlpha(hex, v / 100) })}
      />`}
  `;
}

/** Committed (not live-previewed) text shared by the clips. */
const savedText = (clips) => shared(clips, (c) => store.state.doc?.clips.get(c.id)?.content.text ?? c.content.text);

function Text({ clips, locked }) {
  const texts = clips.filter((c) => c.content.kind === 'text');
  const textId = useId();
  const colorId = useId();
  const outlineId = useId();
  if (!texts.length) return null;
  const ed = editor(texts);
  const st = (k) => (c) => c.content.style[k];
  const text = savedText(texts);
  const size = bind(ed, texts, 'font_size', st('font_size'), { toUi: (v) => round(v * 100, 1), fromUi: (v) => round(v / 100, 4) });
  const color = shared(texts, st('color'));
  const bold = shared(texts, st('bold'));
  const align = shared(texts, st('align'));
  const outlineColor = shared(texts, st('outline_color'));
  const outline = bind(ed, texts, 'outline_width', st('outline_width'), { toUi: (v) => Math.round(v * 100), fromUi: (v) => round(v / 100, 3) });
  const shadow = shared(texts, st('shadow'));
  const isDefault = texts.every((c) => {
    const s = c.content.style;
    return s.font_size === 0.09 && s.color === '#ffffff' && s.bold && s.align === 'center' && !s.background && s.outline_color === '#000000' && s.outline_width === 0 && s.shadow;
  });
  return html`<${ISection} title="Text" onReset=${() => ed.commit(DEFAULT_TEXT_STYLE)} canReset=${!isDefault}>
    <div class="field" data-testid="prop-text">
      <label for=${textId}>Content</label>
      <${TextArea} id=${textId} value=${text.value} mixed=${text.mixed} disabled=${locked} label="Text content" maxlength="2000" onLive=${(v) => ed.live({ text: v })} onCommit=${(v) => ed.commit({ text: v })} onCancel=${() => setLive(null)} />
      <span class="prop-hint">Line breaks are kept. Press Ctrl+Enter to apply.</span>
    </div>
    <${SliderNum} name="font-size" label="Size" ...${size} min=${1} max=${50} sliderMin=${2} sliderMax=${30} step=${0.5} precision=${1} unit="%" resetTo=${9} hint="Relative to the frame height." />
    <${Row} label="Colour" name="text-color" htmlFor=${colorId}>
      <${ColorField} id=${colorId} value=${color.value} mixed=${color.mixed} label="Text colour" onInput=${(c) => ed.live({ text_color: c })} onCommit=${(c) => ed.commit({ text_color: c })} />
    <//>
    <${Row} label="Style" name="text-style">
      <div class="btn-row">
        <button type="button" class="btn small" aria-pressed=${String(!!bold.value && !bold.mixed)} disabled=${locked} onClick=${() => ed.commit({ bold: bold.mixed ? true : !bold.value })}><strong>Bold</strong></button>
        <${Segmented}
          label="Text alignment"
          value=${align.mixed ? null : align.value}
          onChange=${(v) => !locked && ed.commit({ align: v })}
          options=${[
            { value: 'left', label: 'Left' },
            { value: 'center', label: 'Centre' },
            { value: 'right', label: 'Right' },
          ]}
        />
      </div>
    <//>
    <${Background} ed=${ed} clips=${texts} getBg=${st('background')} locked=${locked} />
    <${Row} label="Outline" name="outline-color" htmlFor=${outlineId}>
      <${ColorField} id=${outlineId} value=${outlineColor.value} mixed=${outlineColor.mixed} label="Outline colour" onInput=${(c) => ed.live({ outline_color: c })} onCommit=${(c) => ed.commit({ outline_color: c })} />
    <//>
    <${SliderNum} name="outline-width" label="Outline width" ...${outline} min=${0} max=${30} step=${1} unit="%" resetTo=${0} hint="Relative to the font size. 0 turns the outline off." />
    <${Row} label="Shadow" name="shadow">
      <${Toggle} checked=${shadow.value} mixed=${shadow.mixed} label="Drop shadow" onChange=${(v) => ed.commit({ shadow: v })} />
    <//>
  <//>`;
}

function Caption({ clips, locked }) {
  const caps = clips.filter((c) => c.content.kind === 'caption');
  const textId = useId();
  const spId = useId();
  if (!caps.length) return null;
  const ed = editor(caps);
  const text = savedText(caps);
  const speaker = shared(caps, (c) => c.content.speaker || '');
  const generated = caps.some((c) => c.content.generated);
  return html`<${ISection} title="Caption">
    <div class="field" data-testid="prop-caption-text">
      <label for=${textId}>Text</label>
      <${TextArea} id=${textId} value=${text.value} mixed=${text.mixed} disabled=${locked} label="Caption text" maxlength="500" onLive=${(v) => ed.live({ text: v })} onCommit=${(v) => ed.commit({ text: v })} onCancel=${() => setLive(null)} />
      ${generated && html`<span class="prop-hint">Generated from the transcript. Once edited, it is kept when captions are regenerated.</span>`}
    </div>
    <${Row} label="Speaker" name="speaker" htmlFor=${spId}>
      <input
        id=${spId}
        class="input"
        type="text"
        maxlength="60"
        disabled=${locked}
        placeholder=${speaker.mixed ? 'Mixed' : 'None'}
        defaultValue=${speaker.mixed ? '' : speaker.value}
        key=${speaker.mixed ? 'mixed' : speaker.value}
        onBlur=${(e) => {
          const v = e.currentTarget.value.trim();
          if (speaker.mixed ? v : v !== speaker.value) ed.commit({ speaker: v || null });
        }}
        onKeyDown=${(e) => {
          if (e.key === 'Enter') e.currentTarget.blur();
          e.stopPropagation();
        }}
      />
    <//>
    <div class="insp-note">
      <span>Captions share one look, set for the whole project.</span>
      <button
        type="button"
        class="btn small"
        onClick=${() => {
          pendingScroll.target = 'insp-caption-style';
          A.clearSelection();
        }}
      >
        Edit caption style
      </button>
    </div>
  <//>`;
}

/** Linked clips of the same asset that no longer line up (reference: the picture). */
function syncProblems(doc, clips) {
  const { links } = linkGroups(doc);
  const frame = frameTicks(doc.settings.fps);
  const seen = new Set();
  const out = [];
  for (const c of clips) {
    if (!c.link_id || seen.has(c.link_id)) continue;
    seen.add(c.link_id);
    const members = (links.get(c.link_id) || []).filter(isTimed);
    const byAsset = new Map();
    for (const m of members) (byAsset.get(m.content.asset_id) || byAsset.set(m.content.asset_id, []).get(m.content.asset_id)).push(m);
    for (const group of byAsset.values()) {
      if (group.length < 2) continue;
      const ref = group.find((m) => m.content.kind === 'video') || group[0];
      for (const m of group) {
        if (m === ref || m.speed.num * ref.speed.den !== ref.speed.num * m.speed.den) continue;
        const offset = syncAnchor(m) - syncAnchor(ref);
        if (Math.abs(offset) >= frame / 2) out.push({ clip: m, ref, offset, frames: Math.round(offset / frame) });
      }
    }
  }
  return out;
}

function LinkGroup({ doc, clips, locked }) {
  const { links, groups } = linkGroups(doc);
  const linkIds = new Set(clips.map((c) => c.link_id).filter(Boolean));
  const groupIds = new Set(clips.map((c) => c.group_id).filter(Boolean));
  const oneLink = linkIds.size === 1 && clips.every((c) => c.link_id);
  const linkCount = linkIds.size ? Math.max(...[...linkIds].map((l) => (links.get(l) || []).length)) : 0;
  const groupCount = groupIds.size ? Math.max(...[...groupIds].map((g) => (groups.get(g) || []).length)) : 0;
  const problems = syncProblems(doc, clips);
  const resync = () =>
    A.exec(
      { type: 'move_clips', moves: problems.map((p) => ({ clip_id: p.clip.id, start: Math.max(0, Math.round(p.clip.start - p.offset)), track_id: p.clip.track_id })) },
      { errorTitle: 'Could not move the clips into sync' },
    );
  return html`<${ISection} title="Link & group">
    <${Row} label="Link" name="link">
      <div class="btn-row">
        <span class=${cx('badge', linkIds.size && 'accent')}><${Icon} name=${linkIds.size ? 'link' : 'unlink'} size=${12} />${linkIds.size ? `Linked (${linkCount})` : 'Not linked'}</span>
        ${linkIds.size > 0
          ? html`<button type="button" class="btn small" disabled=${locked} onClick=${() => A.unlinkSelection()}>Unlink</button>`
          : html`<button type="button" class="btn small" disabled=${locked || clips.length < 2} title=${clips.length < 2 ? 'Select two or more clips first' : undefined} onClick=${() => A.linkSelection()}>Link</button>`}
        ${linkIds.size > 0 && !oneLink && clips.length > 1 && html`<button type="button" class="btn small" disabled=${locked} onClick=${() => A.linkSelection()}>Link all</button>`}
      </div>
    <//>
    <${Row} label="Group" name="group">
      <div class="btn-row">
        <span class=${cx('badge', groupIds.size && 'accent')}><${Icon} name="group" size=${12} />${groupIds.size ? `Grouped (${groupCount})` : 'Not grouped'}</span>
        ${groupIds.size > 0
          ? html`<button type="button" class="btn small" disabled=${locked} onClick=${() => A.ungroupSelection()}>Ungroup</button>`
          : html`<button type="button" class="btn small" disabled=${locked || clips.length < 2} title=${clips.length < 2 ? 'Select two or more clips first' : undefined} onClick=${() => A.groupSelection()}>Group</button>`}
      </div>
    <//>
    ${problems.length > 0 &&
    html`<${Notice} kind="warning" action=${html`<button type="button" class="btn small" disabled=${locked} onClick=${resync} data-testid="move-into-sync">Move into sync</button>`}>
      <strong>Out of sync.</strong> ${problems.length === 1
        ? `The linked ${problems[0].clip.content.kind} is ${Math.abs(problems[0].frames)} frame${Math.abs(problems[0].frames) === 1 ? '' : 's'} ${problems[0].frames > 0 ? 'late' : 'early'}.`
        : `${problems.length} linked clips have drifted from their picture.`}
    <//>`}
  <//>`;
}

function headerInfo(doc, clips) {
  if (clips.length === 1) {
    const c = clips[0];
    const k = KIND[c.content.kind];
    const track = trackById(doc, c.track_id);
    const asset = c.content.asset_id ? doc.assets.get(c.content.asset_id) : null;
    const bits = [k.label, track && `Track ${track.name}`];
    if (asset && asset.width && c.content.kind !== 'audio') bits.push(`${asset.width}×${asset.height}`);
    if (asset && asset.duration && c.content.kind !== 'image') bits.push(`source ${humanDuration(asset.duration)}`);
    return { icon: k.icon, kind: c.content.kind, title: clipLabel(doc, c), subtitle: bits.filter(Boolean).join(' · ') };
  }
  const counts = {};
  for (const c of clips) counts[c.content.kind] = (counts[c.content.kind] || 0) + 1;
  const kinds = Object.keys(counts);
  const one = kinds.length === 1 ? kinds[0] : null;
  return {
    icon: one ? KIND[one].icon : 'layers',
    kind: one || 'multi',
    title: `${clips.length} clips selected`,
    subtitle: kinds.map((k) => `${counts[k]} ${k}`).join(' · '),
  };
}

export function ClipInspector({ doc, clips, live }) {
  // drop any un-committed preview when the inspector goes away
  useEffect(() => () => store.state.live && setLive(null), []);
  // what is shown reflects the live preview (slider drags, monitor gizmo…)
  const shown = live ? clips.map((c) => (live.ids.has(c.id) ? applyClipPatch(c, live.patch) : c)) : clips;
  const lockedTracks = [...new Set(clips.map((c) => c.track_id))].map((id) => trackById(doc, id)).filter((t) => t && t.locked);
  const locked = lockedTracks.length > 0;
  const head = headerInfo(doc, shown);
  const enabled = shared(clips, (c) => c.enabled);
  const fpsLabel = timecode(Math.min(...clips.map((c) => c.start)), doc.settings.fps);
  return html`<div class="inspector" data-testid="inspector" data-view="clip">
    <${Head} ...${head} />
    ${locked &&
    html`<div class="insp-pad">
      <${Notice}
        kind="warning"
        icon="lock"
        action=${html`<button type="button" class="btn small" data-testid="unlock-track" onClick=${() => A.exec(lockedTracks.length === 1 ? { type: 'update_track', track_id: lockedTracks[0].id, locked: false } : { type: 'batch', label: 'Unlock tracks', commands: lockedTracks.map((t) => ({ type: 'update_track', track_id: t.id, locked: false })) })}>Unlock</button>`}
      >
        <strong>Track ${lockedTracks.map((t) => t.name).join(', ')} is locked.</strong> Unlock it to edit ${clips.length === 1 ? 'this clip' : 'these clips'}.
      <//>
    </div>`}
    <${Locked.Provider} value=${locked}>
      <${Timing} doc=${doc} clips=${shown} />
      <${Speed} clips=${shown} />
      <${Transform} doc=${doc} clips=${shown} locked=${locked} />
      <${Crop} clips=${shown} />
      <${Opacity} clips=${shown} />
      <${Colour} clips=${shown} />
      <${Audio} clips=${shown} />
      <${Text} clips=${shown} locked=${locked} />
      <${Caption} clips=${shown} locked=${locked} />
      <${LinkGroup} doc=${doc} clips=${clips} locked=${locked} />
      <div class="insp-footer">
        <${Row} label="Enabled" name="enabled" hint=${enabled.value === false && !enabled.mixed ? 'Disabled clips are skipped in the preview and export.' : undefined}>
          <${Toggle} checked=${enabled.value} mixed=${enabled.mixed} label="Clip enabled" onChange=${(v) => A.exec({ type: 'update_clips', clip_ids: clips.map((c) => c.id), patch: { enabled: v } })} />
        <//>
        <button type="button" class="btn danger block" disabled=${locked} data-testid="inspector-delete" aria-label=${`Delete ${clips.length === 1 ? 'clip' : `${clips.length} clips`} at ${fpsLabel}`} onClick=${() => A.deleteSelection()}>
          <${Icon} name="trash" /> Delete ${clips.length === 1 ? 'clip' : `${clips.length} clips`}
        </button>
      </div>
    <//>
  </div>`;
}
