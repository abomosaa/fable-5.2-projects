/** Results table, pause menu and the settings dialog. */
import { CAR_COLORS } from '../../../shared/constants';
import { PERFECT_NETWORK, type NetConditions } from '../../../shared/net/netsim';
import type { ResultRow, RoomState } from '../../../shared/protocol';
import type { InputManager } from '../input/input';
import {
  ACTIONS,
  ACTION_LABELS,
  CAMERA_LABELS,
  CAMERA_MODES,
  DEFAULT_KEYS,
  DEFAULT_PAD,
  PAD_ACTIONS,
  QUALITY_LEVELS,
  keyLabel,
  type Action,
  type PadAction,
  type Settings,
} from '../storage/settings';
import { clear, colourHex, formatTime, h, icon, select } from './dom';
import type { ModalHandle, Modals } from './overlays';

// ---------------------------------------------------------------- results

export interface ResultsActions {
  backToLobby(): void;
  leave(): void;
}

export function resultsTable(rows: ResultRow[], youId: string): HTMLElement {
  const winner = rows.find((r) => r.finished);
  const body = h('tbody', {});
  for (const row of rows) {
    let time = 'DNF';
    if (row.finished) time = row === winner ? formatTime(row.totalMs) : `+${((row.totalMs - (winner?.totalMs ?? 0)) / 1000).toFixed(3)}s`;
    else if (row.lapsCompleted > 0) time = `DNF (${row.lapsCompleted} lap${row.lapsCompleted === 1 ? '' : 's'})`;
    const tr = h(
      'tr',
      { class: row.memberId === youId ? 'me' : '', data: { slot: String(row.slot) } },
      h('td', { class: 'place', text: String(row.place) }),
      h(
        'td',
        {},
        h(
          'div',
          { class: 'who' },
          h('span', { class: 'num', text: String(row.slot + 1), style: { background: colourHex(CAR_COLORS[row.colour % CAR_COLORS.length]!) } }),
          h('span', { text: row.name }),
          row.isBot ? h('span', { class: 'badge' }, icon('bot', 12), 'Bot') : null,
          row.memberId === youId ? h('span', { class: 'badge', text: 'You' }) : null,
        ),
      ),
      h('td', { text: time }),
      h('td', { text: formatTime(row.bestLapMs) }),
      h('td', { text: row.penalties > 0 ? String(row.penalties) : '-' }),
    );
    body.appendChild(tr);
  }
  return h(
    'table',
    { class: 'results-table', id: 'results-table' },
    h('thead', {}, h('tr', {}, h('th', { text: 'Pos' }), h('th', { text: 'Driver' }), h('th', { text: 'Time' }), h('th', { text: 'Best lap' }), h('th', { text: 'Penalties' }))),
    body,
  );
}

export class ResultsOverlay {
  private handle: ModalHandle | null = null;
  private footer = h('div', { class: 'muted' });
  private endsAt = 0;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly modals: Modals,
    private readonly actions: ResultsActions,
  ) {}

  get isOpen(): boolean {
    return this.handle !== null;
  }

  show(room: RoomState, youId: string): void {
    this.hide();
    const rows = room.results ?? [];
    const isHost = room.hostId === youId;
    const mine = rows.find((r) => r.memberId === youId);
    const title = mine ? (mine.finished ? `You finished ${mine.place}${suffix(mine.place)}` : 'Did not finish') : 'Race results';
    this.footer = h('div', { class: 'muted', id: 'results-footer' });
    this.endsAt = performance.now() + room.phaseEndsInMs;
    this.handle = this.modals.open(
      { title },
      resultsTable(rows, youId),
      this.footer,
      h(
        'div',
        { class: 'actions' },
        h('button', { class: 'btn danger', text: 'Leave room', onClick: () => this.actions.leave() }),
        isHost ? h('button', { class: 'btn primary', id: 'btn-back-lobby', text: 'Back to lobby', onClick: () => this.actions.backToLobby() }) : null,
      ),
    );
    this.handle.element.id = 'results';
    const tick = (): void => {
      const left = Math.max(0, Math.ceil((this.endsAt - performance.now()) / 1000));
      this.footer.textContent = isHost ? `Returning to the lobby in ${left}s, or continue now.` : `Waiting for the host. Returning to the lobby in ${left}s.`;
    };
    tick();
    this.timer = setInterval(tick, 500);
  }

  hide(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.handle?.close();
    this.handle = null;
  }
}

function suffix(n: number): string {
  const tens = n % 100;
  if (tens >= 11 && tens <= 13) return 'th';
  return n % 10 === 1 ? 'st' : n % 10 === 2 ? 'nd' : n % 10 === 3 ? 'rd' : 'th';
}

// ------------------------------------------------------------------ pause

export interface PauseActions {
  resume(): void;
  settings(): void;
  leave(): void;
  abort(): void;
  help(): void;
}

export function openPauseMenu(modals: Modals, isHost: boolean, spectating: boolean, actions: PauseActions): ModalHandle {
  let handle: ModalHandle | null = null;
  const close = (): void => {
    handle?.close();
    actions.resume();
  };
  const run = (fn: () => void) => (): void => {
    handle?.close();
    fn();
  };
  handle = modals.open(
    { title: 'Race menu', narrow: true, onDismiss: close },
    h('p', { class: 'muted', text: spectating ? 'You are watching this race live.' : 'The race keeps running while this menu is open: it is a live multiplayer session.' }),
    h(
      'div',
      { style: { display: 'grid', gap: '0.6rem' } },
      h('button', { class: 'btn primary', id: 'btn-resume', text: 'Resume', onClick: close }),
      h('button', { class: 'btn', text: 'Settings', onClick: run(actions.settings) }),
      h('button', { class: 'btn', text: 'Show controls', onClick: run(actions.help) }),
      isHost ? h('button', { class: 'btn danger', id: 'btn-abort', text: 'Cancel race for everyone', onClick: run(actions.abort) }) : null,
      h('button', { class: 'btn danger', id: 'btn-leave-race', text: 'Leave room', onClick: run(actions.leave) }),
    ),
  );
  return handle;
}

// --------------------------------------------------------------- settings

export interface SettingsContext {
  settings: Settings;
  input: InputManager;
  /** Persist and apply the (mutated) settings. */
  apply(): void;
  getNetConditions(): NetConditions;
  setNetConditions(conditions: NetConditions): void;
  testSound(): void;
}

type Tab = 'audio' | 'video' | 'controls' | 'network';

export function openSettingsDialog(modals: Modals, ctx: SettingsContext, onClose: () => void): ModalHandle {
  const { settings } = ctx;
  let tab: Tab = 'audio';
  let handle: ModalHandle | null = null;
  const body = h('div', { class: 'settings-list' });
  const tabs = h('div', { class: 'tabs', role: 'tablist' });

  const close = (): void => {
    ctx.input.cancelCapture();
    handle?.close();
    onClose();
  };

  const row = (label: string, hint: string, control: HTMLElement): HTMLElement =>
    h('div', { class: 'setting' }, h('div', {}, h('strong', { text: label }), hint ? h('small', { text: hint }) : null), control);

  const slider = (value: number, min: number, max: number, step: number, set: (v: number) => void, format: (v: number) => string, label: string): HTMLElement => {
    const readout = h('span', { class: 'muted', text: format(value), style: { minWidth: '4.5em', textAlign: 'right' } });
    const input = h('input', {
      type: 'range',
      min,
      max,
      step,
      value: String(value),
      aria: { label },
      onInput: () => {
        const v = Number(input.value);
        set(v);
        readout.textContent = format(v);
      },
    });
    return h('div', { class: 'row', style: { flexWrap: 'nowrap' } }, input, readout);
  };

  const toggle = (value: boolean, set: (v: boolean) => void, label: string): HTMLElement =>
    h(
      'label',
      { class: 'check' },
      h('input', {
        type: 'checkbox',
        checked: value,
        aria: { label },
        onChange: (event) => set((event.target as HTMLInputElement).checked),
      }),
      'Enabled',
    );

  const percent = (v: number): string => `${Math.round(v * 100)}%`;

  const render = (): void => {
    clear(tabs);
    for (const [id, label] of [
      ['audio', 'Sound'],
      ['video', 'Display'],
      ['controls', 'Controls'],
      ['network', 'Network'],
    ] as Array<[Tab, string]>) {
      tabs.appendChild(
        h('button', {
          class: `tab${tab === id ? ' active' : ''}`,
          text: label,
          role: 'tab',
          aria: { selected: String(tab === id) },
          onClick: () => {
            ctx.input.cancelCapture();
            tab = id;
            render();
          },
        }),
      );
    }
    clear(body);
    if (tab === 'audio') {
      body.append(
        row('Mute all sound', '', toggle(settings.muted, (v) => { settings.muted = v; ctx.apply(); }, 'Mute all sound')),
        row('Master volume', '', slider(settings.masterVolume, 0, 1, 0.01, (v) => { settings.masterVolume = v; ctx.apply(); }, percent, 'Master volume')),
        row('Engines', 'Your car and nearby rivals', slider(settings.engineVolume, 0, 1, 0.01, (v) => { settings.engineVolume = v; ctx.apply(); }, percent, 'Engine volume')),
        row('Effects', 'Tyres, impacts, checkpoints, alerts', slider(settings.sfxVolume, 0, 1, 0.01, (v) => { settings.sfxVolume = v; ctx.apply(); }, percent, 'Effects volume')),
        row('Test', 'All sound is synthesised in your browser', h('button', { class: 'btn small', onClick: () => ctx.testSound() }, icon('volume', 15), 'Play test sound')),
      );
    } else if (tab === 'video') {
      body.append(
        row(
          'Camera',
          'Also switchable while driving',
          select(CAMERA_MODES.map((value) => ({ value, label: CAMERA_LABELS[value] })), settings.camera, (v) => { settings.camera = v; ctx.apply(); }),
        ),
        row(
          'Reduced motion',
          'No camera shake, speed zoom, screen flashes or fast particles',
          toggle(settings.reducedMotion, (v) => { settings.reducedMotion = v; ctx.apply(); }, 'Reduced motion'),
        ),
        row(
          'Graphics quality',
          'Lower it if the frame rate drops',
          select(QUALITY_LEVELS.map((value) => ({ value, label: value[0]!.toUpperCase() + value.slice(1) })), settings.quality, (v) => { settings.quality = v; ctx.apply(); }),
        ),
        row('Name tags', 'Driver names above other cars', toggle(settings.nameTags, (v) => { settings.nameTags = v; ctx.apply(); }, 'Name tags')),
        row(
          'Speed unit',
          '',
          select(
            [
              { value: 'kmh', label: 'km/h' },
              { value: 'mph', label: 'mph' },
            ] as const,
            settings.units,
            (v) => { settings.units = v; ctx.apply(); },
          ),
        ),
        h('p', { class: 'muted', text: 'Indicators never rely on colour alone: cars carry numbers, warnings carry icons and text, and the paint palette is colour-blind safe.' }),
      );
    } else if (tab === 'controls') {
      for (const action of ACTIONS) {
        const keys = h('div', { class: 'keys' });
        for (let slot = 0; slot < 2; slot++) {
          const code = settings.keys[action][slot];
          const button = h('button', {
            class: 'key',
            text: code ? keyLabel(code) : '-',
            title: 'Click, then press a key. Press Backspace to clear.',
            aria: { label: `${ACTION_LABELS[action]} key ${slot + 1}` },
            onClick: () => {
              button.classList.add('listening');
              button.textContent = 'Press a key';
              ctx.input.captureNextKey((pressed) => {
                rebind(settings, action, slot, pressed === 'Backspace' ? null : pressed);
                ctx.apply();
                render();
              });
            },
          });
          keys.appendChild(button);
        }
        body.appendChild(row(ACTION_LABELS[action], '', keys));
      }
      body.appendChild(h('div', { class: 'section-title', text: `Gamepad${ctx.input.gamepadName ? `: ${ctx.input.gamepadName.slice(0, 40)}` : ' (press a button to connect)'}` }));
      body.appendChild(h('p', { class: 'muted', text: 'Left stick or D-pad steers. Buttons can be remapped below.' }));
      for (const action of PAD_ACTIONS) {
        const button = h('button', {
          class: 'key',
          text: padLabel(settings.pad[action]),
          aria: { label: `${ACTION_LABELS[action]} gamepad button` },
          onClick: () => {
            button.classList.add('listening');
            button.textContent = 'Press a button';
            ctx.input.captureNextPadButton((index) => {
              rebindPad(settings, action, index);
              ctx.apply();
              render();
            });
          },
        });
        body.appendChild(row(ACTION_LABELS[action], '', h('div', { class: 'keys' }, button)));
      }
      body.appendChild(row('Stick dead zone', '', slider(settings.padDeadzone, 0, 0.5, 0.01, (v) => { settings.padDeadzone = v; ctx.apply(); }, percent, 'Stick dead zone')));
      body.appendChild(
        h(
          'div',
          { class: 'row' },
          h('button', {
            class: 'btn small',
            text: 'Restore default controls',
            onClick: () => {
              settings.keys = structuredClone(DEFAULT_KEYS);
              settings.pad = { ...DEFAULT_PAD };
              ctx.apply();
              render();
            },
          }),
        ),
      );
    } else {
      const net = { ...ctx.getNetConditions() };
      const update = (): void => ctx.setNetConditions({ ...net });
      body.append(
        row('Network statistics', 'Show a live netcode read-out while racing', toggle(settings.netStats, (v) => { settings.netStats = v; ctx.apply(); }, 'Network statistics')),
        h('div', { class: 'section-title', text: 'Network simulator (testing aid)' }),
        h('p', { class: 'muted', text: 'Degrades your own connection so you can see prediction, reconciliation and interpolation at work. Applies to this tab only and is not saved.' }),
        row('Added latency', 'Each way', slider(net.latencyMs, 0, 400, 5, (v) => { net.latencyMs = v; update(); }, (v) => `${v} ms`, 'Added latency')),
        row('Jitter', 'Random extra delay', slider(net.jitterMs, 0, 200, 5, (v) => { net.jitterMs = v; update(); }, (v) => `${v} ms`, 'Jitter')),
        row('Packet loss', 'Inputs and snapshots', slider(net.loss, 0, 0.5, 0.01, (v) => { net.loss = v; update(); }, percent, 'Packet loss')),
        row('Duplication', '', slider(net.duplicate, 0, 0.5, 0.01, (v) => { net.duplicate = v; update(); }, percent, 'Duplication')),
        row('Reordering', '', slider(net.reorder, 0, 0.5, 0.01, (v) => { net.reorder = v; update(); }, percent, 'Reordering')),
        h(
          'div',
          { class: 'row' },
          h('button', {
            class: 'btn small',
            text: 'Reset simulator',
            onClick: () => {
              ctx.setNetConditions({ ...PERFECT_NETWORK });
              render();
            },
          }),
        ),
      );
    }
  };

  handle = modals.open({ title: 'Settings', onDismiss: close }, tabs, body, h('div', { class: 'actions' }, h('button', { class: 'btn primary', id: 'btn-settings-done', text: 'Done', onClick: close })));
  render();
  return handle;
}

/** Binds a key to an action slot, removing it from any other action first. */
function rebind(settings: Settings, action: Action, slot: number, code: string | null): void {
  if (code !== null) {
    for (const other of ACTIONS) settings.keys[other] = settings.keys[other].filter((c) => c !== code);
  }
  const list = [...settings.keys[action]];
  if (code === null) list.splice(slot, 1);
  else if (slot < list.length) list[slot] = code;
  else list.push(code);
  settings.keys[action] = list.slice(0, 2);
}

function rebindPad(settings: Settings, action: PadAction, index: number): void {
  // Swap with whichever action used that button, so nothing ends up unbound.
  for (const other of PAD_ACTIONS) {
    if (other !== action && settings.pad[other] === index) settings.pad[other] = settings.pad[action];
  }
  settings.pad[action] = index;
}

function padLabel(index: number): string {
  const names = ['A', 'B', 'X', 'Y', 'LB', 'RB', 'LT', 'RT', 'Back', 'Start', 'L3', 'R3', 'D-up', 'D-down', 'D-left', 'D-right'];
  return names[index] ?? `Button ${index}`;
}
