// Tiny DOM helpers and form-field builders shared by all panels.

export function h(tag, props, ...children) {
  const el = document.createElement(tag);
  if (props) {
    for (const [k, v] of Object.entries(props)) {
      if (v === undefined || v === null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
      else if (k === 'dataset') Object.assign(el.dataset, v);
      else if (k in el && k !== 'list') el[k] = v;
      else el.setAttribute(k, v);
    }
  }
  for (const c of children.flat(Infinity)) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c.nodeType ? c : document.createTextNode(String(c)));
  }
  return el;
}

export function clear(el) {
  while (el.firstChild) el.removeChild(el.firstChild);
  return el;
}

const fmt = (v, step) => {
  if (!Number.isFinite(v)) return String(v);
  const d = step >= 1 ? 0 : step >= 0.1 ? 1 : step >= 0.01 ? 2 : 3;
  return v.toFixed(d);
};

/**
 * Slider + number box. onInput fires continuously while dragging, onChange once when released
 * (use onChange to close an undo transaction).
 */
export function slider(label, value, min, max, step, onInput, onChange, opts = {}) {
  const range = h('input', { type: 'range', min, max, step, value });
  const num = h('input', { type: 'number', min: opts.hardMin ?? min, max: opts.hardMax ?? max, step, value: fmt(value, step), class: 'num' });
  const emit = (v, final) => {
    if (!Number.isFinite(v)) return;
    range.value = v;
    if (document.activeElement !== num) num.value = fmt(v, step);
    if (final) (onChange || onInput)?.(v, true);
    else onInput?.(v, false);
  };
  range.addEventListener('input', () => emit(parseFloat(range.value), false));
  range.addEventListener('change', () => emit(parseFloat(range.value), true));
  num.addEventListener('change', () => emit(parseFloat(num.value), true));
  const row = h('label', { class: 'field', title: opts.title || '' }, h('span', { class: 'lbl' }, label), range, num, opts.unit ? h('span', { class: 'unit' }, opts.unit) : null);
  row.setValue = (v) => {
    range.value = v;
    num.value = fmt(v, step);
  };
  return row;
}

export function number(label, value, step, onChange, opts = {}) {
  const num = h('input', { type: 'number', step, value: fmt(value, step), class: 'num wide', min: opts.min, max: opts.max });
  num.addEventListener('change', () => {
    const v = parseFloat(num.value);
    if (Number.isFinite(v)) onChange(v);
  });
  return h('label', { class: 'field', title: opts.title || '' }, h('span', { class: 'lbl' }, label), num, opts.unit ? h('span', { class: 'unit' }, opts.unit) : null);
}

export function select(label, value, options, onChange, opts = {}) {
  const sel = h(
    'select',
    null,
    options.map((o) => {
      const [v, t] = Array.isArray(o) ? o : [o, o];
      return h('option', { value: v, selected: String(v) === String(value) }, t);
    }),
  );
  sel.addEventListener('change', () => onChange(sel.value));
  return h('label', { class: 'field', title: opts.title || '' }, h('span', { class: 'lbl' }, label), sel);
}

export function checkbox(label, value, onChange, opts = {}) {
  const cb = h('input', { type: 'checkbox', checked: !!value });
  cb.addEventListener('change', () => onChange(cb.checked));
  return h('label', { class: 'field check', title: opts.title || '' }, cb, h('span', null, label));
}

export function text(label, value, onChange, opts = {}) {
  const inp = h('input', { type: 'text', value: value ?? '', placeholder: opts.placeholder || '' });
  inp.addEventListener('change', () => onChange(inp.value));
  return h('label', { class: 'field' }, h('span', { class: 'lbl' }, label), inp);
}

export function color(label, rgb, onInput, onChange) {
  const toHex = (c) => '#' + c.map((v) => Math.round(Math.max(0, Math.min(1, v)) * 255).toString(16).padStart(2, '0')).join('');
  const fromHex = (s) => [1, 3, 5].map((i) => parseInt(s.slice(i, i + 2), 16) / 255);
  const inp = h('input', { type: 'color', value: toHex(rgb) });
  inp.addEventListener('input', () => onInput(fromHex(inp.value), false));
  inp.addEventListener('change', () => (onChange || onInput)(fromHex(inp.value), true));
  return h('label', { class: 'field' }, h('span', { class: 'lbl' }, label), inp);
}

export function button(label, onClick, opts = {}) {
  return h('button', { class: 'btn ' + (opts.class || ''), title: opts.title || '', disabled: opts.disabled, onclick: onClick }, label);
}

export function section(title, ...children) {
  const body = h('div', { class: 'sec-body' }, children);
  const head = h('div', { class: 'sec-head' }, title);
  const sec = h('section', { class: 'sec' }, head, body);
  head.addEventListener('click', () => sec.classList.toggle('collapsed'));
  return sec;
}

export function note(textContent, cls = '') {
  return h('p', { class: 'note ' + cls }, textContent);
}
