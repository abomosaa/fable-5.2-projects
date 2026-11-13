import { html, Dialog } from '../lib/ui.js';
import { SHORTCUTS, comboKeys } from '../lib/shortcuts.js';

export function ShortcutsDialog({ onClose }) {
  const groups = [...new Set(SHORTCUTS.map((s) => s.group))];
  return html`<${Dialog} title="Keyboard shortcuts" onClose=${onClose} wide>
    <div class="shortcut-grid">
      ${groups.map(
        (g) => html`<section>
          <h3>${g}</h3>
          <dl>
            ${SHORTCUTS.filter((s) => s.group === g).map(
              (s) => html`<div class="shortcut-row">
                <dt>${s.label}</dt>
                <dd>${s.combos.map((c, i) => html`${i > 0 && html`<span class="faint"> or </span>`}${comboKeys(c).map((k) => html`<kbd class=${/^[←→↑↓⌫⇧⌥⌘]$/.test(k) ? 'kbd sym' : 'kbd'}>${k}</kbd>`)}`)}</dd>
              </div>`,
            )}
          </dl>
        </section>`,
      )}
    </div>
  <//>`;
}
