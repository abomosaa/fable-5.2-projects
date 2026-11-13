// Inspector views shown when no clip is selected: project settings, caption style,
// and the editors for a selected transition or marker.
import { html, useState, useEffect, useRef, cx, Icon, ConfirmDialog, Segmented } from '../lib/ui.js';
import { clipLabel, trackById } from '../state/store.js';
import * as A from '../state/actions.js';
import { FPS_PRESETS, clipEnd, fpsLabel, frameTicks, humanDuration, secondsToTicks, timecode, TPS } from '../lib/time.js';
import { alphaOf, ColorField, Head, ISection, Locked, Num, round, Row, SliderNum, TimeField, Toggle, useId, withAlpha } from './inspector-controls.js';
import { pendingScroll } from './inspector-clip.js';

const RES_PRESETS = [
  { w: 1920, h: 1080, label: '1920 × 1080 — Full HD' },
  { w: 1280, h: 720, label: '1280 × 720 — HD' },
  { w: 2560, h: 1440, label: '2560 × 1440 — QHD' },
  { w: 3840, h: 2160, label: '3840 × 2160 — 4K UHD' },
  { w: 4096, h: 2160, label: '4096 × 2160 — 4K DCI' },
  { w: 1080, h: 1920, label: '1080 × 1920 — Vertical' },
  { w: 1080, h: 1080, label: '1080 × 1080 — Square' },
];

const DEFAULT_CAPTION_STYLE = {
  text: { font_size: 0.048, color: '#ffffff', bold: true, align: 'center', background: '#000000b3', outline_color: '#000000', outline_width: 0, shadow: false },
  y: 0.38,
};

const even = (v) => Math.max(16, Math.min(4096, Math.round(v / 2) * 2));
const settings = (patch, opts) => A.exec({ type: 'update_settings', ...patch }, { errorTitle: 'Could not change the project settings', ...opts });

function Format({ doc }) {
  const s = doc.settings;
  const resId = useId();
  const fpsId = useId();
  const bgId = useId();
  const wId = useId();
  const preset = RES_PRESETS.find((p) => p.w === s.width && p.h === s.height);
  const [custom, setCustom] = useState(!preset);
  const [confirmFps, setConfirmFps] = useState(null);
  useEffect(() => {
    if (!preset) setCustom(true);
  }, [!preset]);
  const fpsKey = `${s.fps.num}/${s.fps.den}`;
  const fpsOptions = FPS_PRESETS.some((p) => `${p.num}/${p.den}` === fpsKey) ? FPS_PRESETS : [...FPS_PRESETS, { label: fpsLabel(s.fps), num: s.fps.num, den: s.fps.den }];
  const pickFps = (key) => {
    const [num, den] = key.split('/').map(Number);
    if (key === fpsKey) return;
    if (doc.clips.size > 0) setConfirmFps({ num, den });
    else settings({ fps: { num, den } });
  };
  return html`<${ISection} title="Format">
    <${Row} label="Resolution" name="resolution" htmlFor=${resId}>
      <select
        id=${resId}
        class="select"
        value=${custom || !preset ? 'custom' : `${preset.w}x${preset.h}`}
        onChange=${(e) => {
          const v = e.currentTarget.value;
          if (v === 'custom') return setCustom(true);
          const [w, h] = v.split('x').map(Number);
          setCustom(false);
          if (w !== s.width || h !== s.height) settings({ width: w, height: h });
        }}
      >
        ${RES_PRESETS.map((p) => html`<option value=${`${p.w}x${p.h}`}>${p.label}</option>`)}
        <option value="custom">Custom…</option>
      </select>
    <//>
    ${(custom || !preset) &&
    html`<${Row} label="Custom size" name="custom-size" htmlFor=${wId} hint="Even numbers from 16 to 4096 pixels.">
      <div class="pair">
        <span data-testid="prop-width"><${Num} id=${wId} value=${s.width} min=${16} max=${4096} step=${2} scrub="W" unit="px" label="Width in pixels" onCommit=${(v) => even(v) !== s.width && settings({ width: even(v) })} /></span>
        <span data-testid="prop-height"><${Num} value=${s.height} min=${16} max=${4096} step=${2} scrub="H" unit="px" label="Height in pixels" onCommit=${(v) => even(v) !== s.height && settings({ height: even(v) })} /></span>
      </div>
    <//>`}
    <${Row} label="Frame rate" name="fps" htmlFor=${fpsId} hint="Changing it re-conforms every edit point to the new frame grid.">
      <select id=${fpsId} class="select" value=${fpsKey} onChange=${(e) => pickFps(e.currentTarget.value)}>
        ${fpsOptions.map((p) => html`<option value=${`${p.num}/${p.den}`}>${p.label} fps</option>`)}
      </select>
    <//>
    <${Row} label="Background" name="background" htmlFor=${bgId}>
      <${ColorField} id=${bgId} value=${s.background} label="Canvas background colour" onCommit=${(c) => c !== s.background && settings({ background: c })} />
    <//>
    ${confirmFps &&
    html`<${ConfirmDialog}
      title="Change the frame rate?"
      confirmLabel=${`Change to ${fpsLabel(confirmFps)} fps`}
      message=${`Every clip, fade, transition and marker will be snapped to the ${fpsLabel(confirmFps)} fps frame grid. Edit points can move by up to half a frame. You can undo this.`}
      onConfirm=${() => settings({ fps: confirmFps })}
      onClose=${() => setConfirmFps(null)}
    />`}
  <//>`;
}

function CaptionStyle({ doc }) {
  const saved = doc.settings.caption_style;
  // local draft so sliders move smoothly; one command per gesture
  const [draft, setDraft] = useState(null);
  const ref = useRef(null);
  useEffect(() => setDraft(null), [saved]);
  useEffect(() => {
    if (pendingScroll.target === 'insp-caption-style') {
      pendingScroll.target = null;
      requestAnimationFrame(() => ref.current?.scrollIntoView({ block: 'start' }));
    }
  }, []);
  const cs = draft || saved;
  const t = cs.text;
  const colorId = useId();
  const boxId = useId();
  const outId = useId();
  const posId = useId();
  const merge = (patch) => ({ y: patch.y ?? cs.y, text: { ...cs.text, ...(patch.text || {}) } });
  const live = (patch) => setDraft(merge(patch));
  const commit = (patch) => {
    const next = merge(patch);
    setDraft(next);
    settings({ caption_style: next }, { errorTitle: 'Could not change the caption style' }).then((ch) => !ch && setDraft(null));
  };
  const text = (k, conv = (v) => v) => ({ onInput: (v) => live({ text: { [k]: conv(v) } }), onCommit: (v) => commit({ text: { [k]: conv(v) } }) });
  const boxOn = !!t.background;
  const boxHex = boxOn ? t.background.slice(0, 7) : '#000000';
  const boxAlpha = boxOn ? alphaOf(t.background) : 0.7;
  const isDefault = JSON.stringify(saved) === JSON.stringify(DEFAULT_CAPTION_STYLE);
  const captions = [...doc.clips.values()].filter((c) => c.content.kind === 'caption').length;
  const pos = Math.abs(cs.y - 0.38) < 0.005 ? 'bottom' : Math.abs(cs.y) < 0.005 ? 'middle' : Math.abs(cs.y + 0.38) < 0.005 ? 'top' : null;
  return html`<div ref=${ref}>
    <${ISection} title="Caption style" id="insp-caption-style" onReset=${() => commit(DEFAULT_CAPTION_STYLE)} canReset=${!isDefault}>
      <p class="insp-lede">One look for every caption in the project${captions ? ` (${captions} on the timeline)` : ''}. It is used in the preview and burned into exports.</p>
      <div class="caption-sample" aria-hidden="true" style=${{ justifyContent: t.align === 'left' ? 'flex-start' : t.align === 'right' ? 'flex-end' : 'center', alignItems: cs.y < -0.15 ? 'flex-start' : cs.y > 0.15 ? 'flex-end' : 'center' }}>
        <span
          style=${{
            color: t.color,
            fontWeight: t.bold ? 700 : 400,
            background: boxOn ? t.background : 'transparent',
            fontSize: `${Math.max(10, Math.min(26, t.font_size * 300))}px`,
            WebkitTextStroke: t.outline_width > 0 ? `${Math.max(0.5, t.outline_width * 14)}px ${t.outline_color}` : undefined,
            paintOrder: 'stroke fill',
            textShadow: t.shadow ? '1px 1px 0 rgba(0,0,0,.6)' : 'none',
          }}
          >Caption sample</span
        >
      </div>
      <${SliderNum} name="caption-size" label="Size" value=${round(t.font_size * 100, 1)} min=${1} max=${50} sliderMin=${2} sliderMax=${12} step=${0.1} precision=${1} unit="%" resetTo=${4.8} hint="Relative to the frame height." ...${text('font_size', (v) => round(v / 100, 4))} />
      <${Row} label="Colour" name="caption-color" htmlFor=${colorId}>
        <${ColorField} id=${colorId} value=${t.color} label="Caption colour" ...${text('color')} />
      <//>
      <${Row} label="Bold" name="caption-bold">
        <${Toggle} checked=${t.bold} label="Bold captions" onChange=${(v) => commit({ text: { bold: v } })} />
      <//>
      <${Row} label="Background" name="caption-background">
        <${Toggle} checked=${boxOn} label="Caption background box" onChange=${(v) => commit({ text: { background: v ? '#000000b3' : null } })} />
      <//>
      ${boxOn &&
      html`<${Row} label="Box colour" name="caption-box-color" htmlFor=${boxId}>
          <${ColorField} id=${boxId} value=${boxHex} label="Caption box colour" onInput=${(c) => live({ text: { background: withAlpha(c, boxAlpha) } })} onCommit=${(c) => commit({ text: { background: withAlpha(c, boxAlpha) } })} />
        <//>
        <${SliderNum} name="caption-box-opacity" label="Box opacity" value=${Math.round(boxAlpha * 100)} min=${5} max=${100} step=${1} unit="%" onInput=${(v) => live({ text: { background: withAlpha(boxHex, v / 100) } })} onCommit=${(v) => commit({ text: { background: withAlpha(boxHex, v / 100) } })} />`}
      <${Row} label="Outline" name="caption-outline-color" htmlFor=${outId}>
        <${ColorField} id=${outId} value=${t.outline_color} label="Caption outline colour" ...${text('outline_color')} />
      <//>
      <${SliderNum} name="caption-outline-width" label="Outline width" value=${Math.round(t.outline_width * 100)} min=${0} max=${30} step=${1} unit="%" resetTo=${0} hint="Relative to the font size. 0 turns the outline off." ...${text('outline_width', (v) => round(v / 100, 3))} />
      <${Row} label="Shadow" name="caption-shadow">
        <${Toggle} checked=${t.shadow} label="Caption drop shadow" onChange=${(v) => commit({ text: { shadow: v } })} />
      <//>
      <${Row} label="Position" name="caption-position-preset">
        <${Segmented}
          label="Caption position"
          value=${pos}
          onChange=${(v) => commit({ y: v === 'top' ? -0.38 : v === 'middle' ? 0 : 0.38 })}
          options=${[
            { value: 'top', label: 'Top' },
            { value: 'middle', label: 'Middle' },
            { value: 'bottom', label: 'Bottom' },
          ]}
        />
      <//>
      <${SliderNum} name="caption-position" label="Vertical" value=${Math.round(cs.y * 100)} min=${-50} max=${50} step=${1} unit="%" resetTo=${38} hint="Offset of the caption from the centre of the frame." onInput=${(v) => live({ y: round(v / 100, 3) })} onCommit=${(v) => commit({ y: round(v / 100, 3) })} />
    <//>
  </div>`;
}

function Stats({ doc, duration }) {
  const fps = doc.settings.fps;
  const kinds = { video: 0, audio: 0, caption: 0 };
  for (const t of doc.tracks) kinds[t.kind] = (kinds[t.kind] || 0) + 1;
  const row = (label, value, name) => html`<div class="stat" data-testid=${`stat-${name}`}><dt>${label}</dt><dd class="tnum">${value}</dd></div>`;
  return html`<${ISection} title="Timeline">
    <dl class="stats">
      ${row('Duration', duration > 0 ? html`${timecode(duration, fps)} <span class="faint">(${humanDuration(duration)})</span>` : 'Empty', 'duration')}
      ${row('Clips', doc.clips.size, 'clips')}
      ${row('Tracks', `${kinds.video} video · ${kinds.audio} audio${kinds.caption ? ` · ${kinds.caption} caption` : ''}`, 'tracks')}
      ${row('Media', doc.assets.size, 'media')} ${row('Transitions', doc.transitions.size, 'transitions')} ${row('Markers', doc.markers.length, 'markers')}
    </dl>
  <//>`;
}

export function ProjectInspector({ doc, duration }) {
  const s = doc.settings;
  return html`<div class="inspector" data-testid="inspector" data-view="project">
    <${Head} icon="film" kind="project" title=${doc.name} subtitle=${`Project · ${s.width}×${s.height} · ${fpsLabel(s.fps)} fps`} />
    <p class="insp-lede insp-pad">Nothing is selected. Select a clip, transition or marker on the timeline to edit it; project-wide settings are below.</p>
    <${Format} doc=${doc} />
    <${CaptionStyle} doc=${doc} />
    <${Stats} doc=${doc} duration=${duration} />
  </div>`;
}

// ---------------------------------------------------------------------------------
// Transition
// ---------------------------------------------------------------------------------
const TRANSITIONS = [
  { value: 'cross_dissolve', label: 'Cross dissolve', hint: 'The outgoing clip blends into the incoming one.' },
  { value: 'dip_to_black', label: 'Dip to black', hint: 'Fades out to black, then up from black.' },
  { value: 'slide', label: 'Slide', hint: 'The incoming clip slides in over the outgoing one.' },
  { value: 'push', label: 'Push', hint: 'The incoming clip pushes the outgoing one out.' },
];

export function TransitionInspector({ doc, transition }) {
  const fps = doc.settings.fps;
  const frame = frameTicks(fps);
  const left = doc.clips.get(transition.left);
  const right = doc.clips.get(transition.right);
  const track = left && trackById(doc, left.track_id);
  const audio = track?.kind === 'audio';
  const locked = !!track?.locked;
  const [draft, setDraft] = useState(null);
  useEffect(() => setDraft(null), [transition.duration, transition.id]);
  if (!left || !right) return null;
  const maxSec = round(Math.min(left.duration, right.duration) / TPS, 2);
  const minSec = round((2 * frame) / TPS, 3);
  const sec = draft ?? round(transition.duration / TPS, 2);
  const update = (patch) => A.exec({ type: 'update_transition', transition_id: transition.id, ...patch }, { errorTitle: 'Could not change the transition' });
  const current = TRANSITIONS.find((t) => t.value === transition.kind);
  return html`<div class="inspector" data-testid="inspector" data-view="transition">
    <${Head} icon="transition" kind="transition" title=${audio ? 'Audio crossfade' : current?.label || 'Transition'} subtitle=${`Track ${track?.name || '?'} · at ${timecode(clipEnd(left), fps)}`} />
    ${locked &&
    html`<div class="insp-pad">
      <div class="notice warning" role="status">
        <${Icon} name="lock" />
        <div class="grow"><strong>Track ${track.name} is locked.</strong> Unlock it to edit this transition.</div>
        <button type="button" class="btn small" onClick=${() => A.exec({ type: 'update_track', track_id: track.id, locked: false })}>Unlock</button>
      </div>
    </div>`}
    <${Locked.Provider} value=${locked}>
      <${ISection} title="Transition">
        <p class="insp-lede">Between <strong>${clipLabel(doc, left)}</strong> and <strong>${clipLabel(doc, right)}</strong>.</p>
        ${audio
          ? html`<${Row} label="Type" name="transition-kind"><span class="badge accent">Crossfade</span><//>
              <p class="prop-hint">Audio tracks always crossfade: the outgoing sound fades out while the incoming one fades in.</p>`
          : html`<div class="transition-grid" role="radiogroup" aria-label="Transition type" data-testid="prop-transition-kind">
              ${TRANSITIONS.map(
                (t) => html`<button type="button" role="radio" class=${cx('transition-card', t.value)} aria-checked=${String(transition.kind === t.value)} disabled=${locked} data-kind=${t.value} title=${t.hint} onClick=${() => transition.kind !== t.value && update({ kind: t.value })}>
                  <span class="glyph" aria-hidden="true"><i class="a"></i><i class="b"></i></span>
                  <span>${t.label}</span>
                </button>`,
              )}
            </div>`}
        <${SliderNum}
          name="transition-duration"
          label="Duration"
          value=${sec}
          min=${minSec}
          max=${maxSec}
          sliderMax=${Math.max(maxSec, minSec + 0.01)}
          step=${0.05}
          precision=${2}
          unit="s"
          onInput=${(v) => setDraft(v)}
          onCommit=${(v) => {
            setDraft(v);
            update({ duration: secondsToTicks(v) }).then((ch) => !ch && setDraft(null));
          }}
          hint=${`Up to ${maxSec.toFixed(2)} s here (the shorter of the two clips). Rounded to an even number of frames.`}
        />
        <p class="prop-hint">Transitions use spare source media beyond the cut (“handles”). Where a clip has none, its first or last frame is held instead.</p>
      <//>
      <div class="insp-footer">
        <button type="button" class="btn danger block" disabled=${locked} data-testid="inspector-delete" onClick=${() => A.exec({ type: 'remove_transitions', transition_ids: [transition.id] })}><${Icon} name="trash" /> Remove transition</button>
      </div>
    <//>
  </div>`;
}

// ---------------------------------------------------------------------------------
// Marker
// ---------------------------------------------------------------------------------
const MARKER_COLORS = ['#f5c542', '#ff6b6e', '#3fcf8e', '#5cc8ff', '#7c9cff', '#ff8fcb'];

export function MarkerInspector({ doc, marker, duration }) {
  const fps = doc.settings.fps;
  const labelId = useId();
  const timeId = useId();
  const colorId = useId();
  const update = (patch) => A.exec({ type: 'update_marker', marker_id: marker.id, ...patch }, { errorTitle: 'Could not change the marker' });
  return html`<div class="inspector" data-testid="inspector" data-view="marker">
    <${Head} icon="flag" kind="marker" title=${marker.label || 'Marker'} subtitle=${`Marker · at ${timecode(marker.time, fps)}`} />
    <${ISection} title="Marker">
      <${Row} label="Label" name="marker-label" htmlFor=${labelId}>
        <input
          id=${labelId}
          class="input"
          type="text"
          maxlength="80"
          placeholder="Add a note…"
          key=${marker.id + marker.label}
          defaultValue=${marker.label}
          onBlur=${(e) => e.currentTarget.value.trim() !== marker.label && update({ label: e.currentTarget.value.trim() })}
          onKeyDown=${(e) => {
            if (e.key === 'Enter') e.currentTarget.blur();
            if (e.key === 'Escape') {
              e.currentTarget.value = marker.label;
              e.currentTarget.blur();
            }
            e.stopPropagation();
          }}
        />
      <//>
      <${Row} label="Time" name="marker-time" htmlFor=${timeId}>
        <${TimeField} id=${timeId} value=${marker.time} fps=${fps} label="Marker time" max=${Math.max(duration, marker.time) + 3600 * TPS} onCommit=${(t) => update({ time: t })} />
      <//>
      <${Row} label="Colour" name="marker-color" htmlFor=${colorId}>
        <${ColorField} id=${colorId} value=${marker.color} label="Marker colour" onCommit=${(c) => c !== marker.color && update({ color: c })} />
      <//>
      <div class="swatches" role="group" aria-label="Marker colour presets">
        ${MARKER_COLORS.map(
          (c) => html`<button type="button" class=${cx('swatch-dot', marker.color === c && 'on')} style=${{ background: c }} aria-label=${`Use colour ${c}`} aria-pressed=${String(marker.color === c)} onClick=${() => marker.color !== c && update({ color: c })}></button>`,
        )}
      </div>
    <//>
    <div class="insp-footer">
      <button type="button" class="btn danger block" data-testid="inspector-delete" onClick=${() => A.exec({ type: 'remove_marker', marker_id: marker.id })}><${Icon} name="trash" /> Delete marker</button>
    </div>
  </div>`;
}
