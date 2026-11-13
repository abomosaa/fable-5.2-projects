/** Toasts, modal dialogs and the connection banners. */
import { append, clear, h, icon, type ICONS } from './dom';

export type ToastKind = 'info' | 'error' | 'warn' | 'good';

export class Toasts {
  readonly element = h('div', { class: 'toasts', role: 'status', aria: { live: 'polite' } });
  private last = '';
  private lastAt = 0;

  show(message: string, kind: ToastKind = 'info', durationMs = 4200): void {
    // Collapse bursts of identical messages (e.g. repeated rate-limit errors).
    const now = performance.now();
    if (message === this.last && now - this.lastAt < 1500) return;
    this.last = message;
    this.lastAt = now;
    const symbol: keyof typeof ICONS = kind === 'error' || kind === 'warn' ? 'warning' : kind === 'good' ? 'check' : 'flag';
    const toast = h('div', { class: `toast ${kind}` }, icon(symbol), h('span', { text: message }));
    this.element.appendChild(toast);
    while (this.element.children.length > 4) this.element.firstElementChild?.remove();
    setTimeout(() => toast.remove(), durationMs);
  }
}

export interface ModalHandle {
  element: HTMLElement;
  close(): void;
}

export interface ModalOptions {
  title: string;
  narrow?: boolean;
  /** Called when the dialog is dismissed with Escape or the backdrop; omit to make it modal-only. */
  onDismiss?: () => void;
}

/** Stack of open dialogs; Escape closes the top-most dismissible one. */
export class Modals {
  readonly element = h('div', {});
  private readonly stack: Array<{ node: HTMLElement; dismiss: (() => void) | undefined; restore: Element | null }> = [];

  get isOpen(): boolean {
    return this.stack.length > 0;
  }

  open(options: ModalOptions, ...content: Array<Node | null | false>): ModalHandle {
    const panel = h('div', { class: `modal panel${options.narrow ? ' narrow' : ''}`, role: 'dialog', aria: { modal: 'true', label: options.title } });
    panel.appendChild(h('h2', { text: options.title }));
    append(panel, content);
    const backdrop = h('div', { class: 'modal-backdrop' }, panel);
    const entry = { node: backdrop, dismiss: options.onDismiss, restore: document.activeElement };
    backdrop.addEventListener('mousedown', (event) => {
      if (event.target === backdrop && entry.dismiss) entry.dismiss();
    });
    this.stack.push(entry);
    this.element.appendChild(backdrop);
    // Move focus into the dialog for keyboard users.
    const focusable = panel.querySelector<HTMLElement>('input:not([type=range]):not([type=checkbox]), button.primary, button');
    focusable?.focus();
    return {
      element: panel,
      close: () => {
        const at = this.stack.indexOf(entry);
        if (at < 0) return;
        this.stack.splice(at, 1);
        backdrop.remove();
        if (entry.restore instanceof HTMLElement && entry.restore.isConnected) entry.restore.focus();
      },
    };
  }

  /** Handles Escape. Returns true if a dialog consumed it. */
  dismissTop(): boolean {
    const top = this.stack[this.stack.length - 1];
    if (!top) return false;
    if (top.dismiss) top.dismiss();
    return true;
  }

  /** Simple message box. */
  alert(title: string, message: string, buttonLabel = 'OK', onClose?: () => void): ModalHandle {
    let handle: ModalHandle | null = null;
    const done = (): void => {
      handle?.close();
      onClose?.();
    };
    handle = this.open(
      { title, narrow: true, onDismiss: done },
      h('p', { text: message, class: 'muted' }),
      h('div', { class: 'actions' }, h('button', { class: 'btn primary', text: buttonLabel, onClick: done })),
    );
    return handle;
  }

  confirm(title: string, message: string, confirmLabel: string, onConfirm: () => void, danger = false): ModalHandle {
    let handle: ModalHandle | null = null;
    const close = (): void => handle?.close();
    handle = this.open(
      { title, narrow: true, onDismiss: close },
      h('p', { text: message, class: 'muted' }),
      h(
        'div',
        { class: 'actions' },
        h('button', { class: 'btn', text: 'Cancel', onClick: close }),
        h('button', {
          class: `btn ${danger ? 'danger' : 'primary'}`,
          text: confirmLabel,
          onClick: () => {
            close();
            onConfirm();
          },
        }),
      ),
    );
    return handle;
  }
}

/** Thin bar across the top while the connection is being restored. */
export class ConnectionBanner {
  readonly element = h('div', { class: 'conn-banner hidden', role: 'alert' });

  show(message: string, bad = false): void {
    clear(this.element);
    this.element.appendChild(icon('warning'));
    this.element.appendChild(h('span', { text: message }));
    this.element.className = `conn-banner${bad ? ' bad' : ''}`;
  }

  hide(): void {
    this.element.classList.add('hidden');
  }
}

/** Full-screen state used before the first successful connection. */
export class Splash {
  private readonly title = h('h2', { text: 'Connecting to the race server...' });
  private readonly detail = h('p', { class: 'muted', text: '' });
  private readonly spinner = h('div', { class: 'spinner' });
  private readonly actions = h('div', { class: 'row' });
  readonly element = h('div', { class: 'splash' }, h('div', {}, this.spinner, h('div', { style: { height: '1rem' } }), this.title, this.detail, this.actions));

  set(title: string, detail: string, spinning: boolean, action?: { label: string; run: () => void }): void {
    this.title.textContent = title;
    this.detail.textContent = detail;
    this.spinner.classList.toggle('hidden', !spinning);
    clear(this.actions);
    this.actions.style.justifyContent = 'center';
    if (action) this.actions.appendChild(h('button', { class: 'btn primary', text: action.label, onClick: action.run }));
    this.element.classList.remove('hidden');
  }

  hide(): void {
    this.element.classList.add('hidden');
  }
}
