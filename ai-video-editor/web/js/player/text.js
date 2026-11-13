// Text rasteriser for text overlays and captions.
//
// Mirrors `text_metrics` / `drawtext_filter` in crates/core/src/render.rs so the
// preview matches the export:
//   * font px = round(font_size · H · scale), the bundled Inter files ("Cutline Text")
//   * lines split on "\n" only; each line is 1.21·px tall, baseline 0.96875·px below
//     the line top
//   * the block is as wide as its widest line; `align` positions lines inside it
//   * background box extends round(0.3·px) beyond the block
//   * outline is an outer border of round(outline_width·px)
//   * shadow is the text offset by max(1, round(0.06·px)), black @ 60 %, no blur

export const TEXT_FONT_FAMILY = '"Cutline Text"';
export const TEXT_LINE_HEIGHT = 1.21;
export const TEXT_ASCENT = 0.96875;
export const TEXT_BOX_PADDING = 0.3;
export const TEXT_SHADOW_OFFSET = 0.06;
export const TEXT_SHADOW_ALPHA = 0.6;

let fontsReady = false;
let fontVersion = 0;
const fontListeners = new Set();

/** Load the export fonts; resolves once both weights can be drawn. */
export function loadTextFonts() {
  if (!document.fonts?.load) {
    fontsReady = true;
    return Promise.resolve();
  }
  return Promise.all([document.fonts.load(`400 24px ${TEXT_FONT_FAMILY}`), document.fonts.load(`700 24px ${TEXT_FONT_FAMILY}`)])
    .catch(() => {})
    .then(() => {
      fontsReady = true;
      fontVersion++;
      cache.clear();
      for (const fn of fontListeners) fn();
    });
}
export const textFontsReady = () => fontsReady;
/** fn() is called when the fonts finish loading (text must be re-rasterised). */
export function onTextFontsLoaded(fn) {
  fontListeners.add(fn);
  return () => fontListeners.delete(fn);
}

/** Same normalisation as the exporter: unify newlines, drop trailing ones. */
export function cleanText(text) {
  return String(text ?? '')
    .replace(/\r\n?/g, '\n')
    .replace(/\n+$/, '');
}

/** Geometry in project pixels (see render.rs `text_metrics`). */
export function textMetrics(canvasH, style, scale, text) {
  const px = Math.max(1, Math.round(style.font_size * canvasH * scale));
  const lines = cleanText(text).split('\n');
  return {
    px,
    lines,
    lineHeight: TEXT_LINE_HEIGHT * px,
    blockHeight: lines.length * TEXT_LINE_HEIGHT * px,
    boxPadding: style.background ? Math.round(TEXT_BOX_PADDING * px) : 0,
    outline: Math.round((style.outline_width || 0) * px),
    shadow: style.shadow ? Math.max(1, Math.round(TEXT_SHADOW_OFFSET * px)) : 0,
  };
}

let measureCtx = null;
const fontOf = (style, px) => `${style.bold ? 700 : 400} ${px}px ${TEXT_FONT_FAMILY}, Inter, sans-serif`;

/** Width of the text block in project pixels. */
export function measureBlock(style, m) {
  measureCtx ||= document.createElement('canvas').getContext('2d');
  measureCtx.font = fontOf(style, m.px);
  let w = 1;
  for (const line of m.lines) w = Math.max(w, measureCtx.measureText(line).width);
  return w;
}

function cssColor(hex, fallback) {
  if (typeof hex !== 'string' || !/^#[0-9a-f]{6}([0-9a-f]{2})?$/i.test(hex)) return fallback;
  if (hex.length === 7) return hex;
  const n = (i) => parseInt(hex.slice(i, i + 2), 16);
  return `rgba(${n(1)},${n(3)},${n(5)},${(n(7) / 255).toFixed(4)})`;
}

const MAX_CACHE = 96;
/** @type {Map<string, any>} */
const cache = new Map();
/** Called with evicted canvases so the compositor can drop their textures. */
let onEvict = null;
export function setTextEvictHandler(fn) {
  onEvict = fn;
}

/**
 * Rasterise a text block.
 * @param {string} text
 * @param {object} style   TextStyle
 * @param {number} scale   transform scale (1 for captions)
 * @param {number} canvasH project height in px
 * @param {number} k       backing pixels per project pixel
 * @returns {null | {canvas: HTMLCanvasElement, version: number, w: number, h: number, blockW: number, blockH: number, offsetY: number}}
 *   `w`,`h`: size of the raster in project px; the block is centred in it
 *   horizontally; `offsetY` is the distance from the raster top to the block top.
 */
export function rasterText(text, style, scale, canvasH, k) {
  const clean = cleanText(text);
  if (!clean.trim()) return null;
  const kq = Math.max(0.05, Math.round(k * 64) / 64);
  const key = `${fontVersion}|${kq}|${canvasH}|${scale}|${style.font_size}|${style.color}|${style.bold}|${style.align}|${style.background}|${style.outline_color}|${style.outline_width}|${style.shadow}|${clean}`;
  const hit = cache.get(key);
  if (hit) {
    // refresh LRU position
    cache.delete(key);
    cache.set(key, hit);
    return hit;
  }
  const m = textMetrics(canvasH, style, scale, clean);
  const blockW = measureBlock(style, m);
  const blockH = m.blockHeight;
  // room for the box, the outline and the shadow (plus a pixel of anti-aliasing)
  const margin = Math.max(m.boxPadding, m.outline + m.shadow) + 2;
  const w = blockW + 2 * margin;
  const h = blockH + 2 * margin;
  const canvas = document.createElement('canvas');
  // keep rasters within sane texture sizes even for huge type
  const kk = Math.min(kq, 4096 / Math.max(w, h));
  canvas.width = Math.max(1, Math.ceil(w * kk));
  canvas.height = Math.max(1, Math.ceil(h * kk));
  const ctx = canvas.getContext('2d');
  ctx.setTransform(kk, 0, 0, kk, 0, 0);
  ctx.font = fontOf(style, m.px);
  ctx.textBaseline = 'alphabetic';
  ctx.lineJoin = 'round';
  ctx.miterLimit = 2;
  const left = margin;
  const top = margin;
  if (style.background) {
    ctx.fillStyle = cssColor(style.background, 'rgba(0,0,0,0.7)');
    ctx.fillRect(left - m.boxPadding, top - m.boxPadding, blockW + 2 * m.boxPadding, blockH + 2 * m.boxPadding);
  }
  const align = style.align || 'center';
  ctx.textAlign = align === 'left' ? 'left' : align === 'right' ? 'right' : 'center';
  const x = align === 'left' ? left : align === 'right' ? left + blockW : left + blockW / 2;
  const baseline = (i) => top + i * m.lineHeight + TEXT_ASCENT * m.px;
  if (m.shadow) {
    if (m.outline > 0) {
      // drawtext shadows the outlined glyphs: build the solid silhouette first so the
      // overlap of stroke and fill is not darkened twice
      const sil = document.createElement('canvas');
      sil.width = canvas.width;
      sil.height = canvas.height;
      const sc = sil.getContext('2d');
      sc.setTransform(kk, 0, 0, kk, 0, 0);
      sc.font = ctx.font;
      sc.textBaseline = 'alphabetic';
      sc.textAlign = ctx.textAlign;
      sc.lineJoin = 'round';
      sc.fillStyle = sc.strokeStyle = '#000';
      sc.lineWidth = m.outline * 2;
      m.lines.forEach((line, i) => {
        sc.strokeText(line, x, baseline(i));
        sc.fillText(line, x, baseline(i));
      });
      ctx.save();
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.globalAlpha = TEXT_SHADOW_ALPHA;
      ctx.drawImage(sil, Math.round(m.shadow * kk), Math.round(m.shadow * kk));
      ctx.restore();
    } else {
      ctx.fillStyle = `rgba(0,0,0,${TEXT_SHADOW_ALPHA})`;
      m.lines.forEach((line, i) => ctx.fillText(line, x + m.shadow, baseline(i) + m.shadow));
    }
  }
  if (m.outline > 0) {
    ctx.strokeStyle = cssColor(style.outline_color, '#000000');
    ctx.lineWidth = m.outline * 2;
    m.lines.forEach((line, i) => ctx.strokeText(line, x, baseline(i)));
  }
  ctx.fillStyle = cssColor(style.color, '#ffffff');
  m.lines.forEach((line, i) => ctx.fillText(line, x, baseline(i)));

  const out = { canvas, version: 1, w, h, blockW, blockH, offsetY: margin, metrics: m };
  cache.set(key, out);
  while (cache.size > MAX_CACHE) {
    const [oldKey, old] = cache.entries().next().value;
    cache.delete(oldKey);
    onEvict?.(old.canvas);
  }
  return out;
}

/**
 * Where the raster quad goes for a block centred on (cx, cy) in project px.
 * The export rounds the block top to a whole pixel; so do we.
 */
export function textQuad(raster, cx, cy) {
  const blockTop = Math.round(cy - raster.blockH / 2);
  return { cx, cy: blockTop - raster.offsetY + raster.h / 2, w: raster.w, h: raster.h };
}
