/** Landing screen, public room browser and the create/join dialogs. */
import { MAX_LAPS, MAX_RACERS, MIN_LAPS, NAME_MAX, ROOM_CODE_LENGTH, ROOM_NAME_MAX } from '../../../shared/constants';
import {
  BOT_SKILLS,
  defaultRoomSettings,
  normalizeRoomCode,
  sanitizeText,
  type BotSkill,
  type RoomSettings,
  type RoomSummary,
  type TrackRecord,
} from '../../../shared/protocol';
import { TRACK_DEFS, getTrack, getTrackDef } from '../../../shared/sim/tracks';
import type { RoomDirectory } from '../net/gameClient';
import { clear, drawTrackOutline, formatTime, h, icon, select } from './dom';
import type { ModalHandle, Modals } from './overlays';

export interface MenuActions {
  quickRace(): void;
  browse(): void;
  createRoom(settings: RoomSettings): void;
  joinRoom(code: string, spectate: boolean): void;
  refresh(): void;
  back(): void;
  openSettings(): void;
  setName(name: string): void;
  getName(): string;
  click(): void;
}

const THUMB_COLOURS = { road: '#e8ecf8', edge: '#39415f', line: '#ffb000' };

export function trackThumb(trackId: string, width: number, height: number): HTMLCanvasElement {
  const canvas = h('canvas', { class: 'thumb' });
  canvas.width = width * 2;
  canvas.height = height * 2;
  canvas.style.width = `${width}px`;
  canvas.style.height = `${height}px`;
  drawTrackOutline(canvas, getTrack(trackId), { ...THUMB_COLOURS, padding: 14 });
  return canvas;
}

function nameField(actions: MenuActions): HTMLInputElement {
  return h('input', {
    type: 'text',
    id: 'player-name',
    value: actions.getName(),
    maxLength: NAME_MAX,
    placeholder: 'Your driver name',
    autocomplete: 'nickname',
    spellcheck: false,
    aria: { label: 'Driver name' },
    onChange: (event) => {
      const input = event.target as HTMLInputElement;
      actions.setName(input.value);
      input.value = actions.getName();
    },
  });
}

// ------------------------------------------------------------------- home

export class HomeScreen {
  readonly element: HTMLElement;
  private readonly status = h('span', { text: 'Connecting...' });
  private readonly recordsBox = h('div', { class: 'records' });
  private readonly nameInput: HTMLInputElement;

  constructor(private readonly actions: MenuActions) {
    this.nameInput = nameField(actions);
    const code = h('input', {
      type: 'text',
      class: 'code-input',
      id: 'join-code',
      maxLength: ROOM_CODE_LENGTH,
      placeholder: 'CODE',
      autocomplete: 'off',
      spellcheck: false,
      aria: { label: 'Room code' },
      onInput: () => {
        code.value = normalizeRoomCode(code.value).slice(0, ROOM_CODE_LENGTH);
      },
      onKeyDown: (event) => {
        if (event.key === 'Enter') join();
      },
    });
    const join = (): void => {
      const value = normalizeRoomCode(code.value);
      if (value.length === ROOM_CODE_LENGTH) actions.joinRoom(value, false);
      else code.focus();
    };
    this.element = h(
      'div',
      { class: 'screen home', id: 'screen-home' },
      h(
        'div',
        { class: 'logo' },
        h('h1', {}, 'APEX ', h('span', { text: 'DRIFT' })),
        h('p', { text: 'Online multiplayer racing. Public rooms, real opponents, practice bots.' }),
      ),
      h(
        'div',
        { class: 'home-card panel' },
        h('label', { class: 'field', for: 'player-name' }, 'Driver name', this.nameInput),
        h(
          'div',
          { class: 'home-actions' },
          h('button', { class: 'btn primary big wide', id: 'btn-quick', onClick: () => actions.quickRace() }, icon('play'), 'Quick race'),
          h('button', { class: 'btn big', id: 'btn-browse', onClick: () => actions.browse() }, icon('users'), 'Browse rooms'),
          h('button', { class: 'btn big', id: 'btn-create', onClick: () => actions.createRoom(defaultRoomSettings(actions.getName())) }, icon('flag'), 'Create room'),
        ),
        h('label', { class: 'field', for: 'join-code' }, 'Have a room code?', h('div', { class: 'code-row' }, code, h('button', { class: 'btn', id: 'btn-join-code', text: 'Join', onClick: join }))),
      ),
      this.recordsBox,
      h(
        'div',
        { class: 'home-foot' },
        h('span', { class: 'badge' }, icon('signal', 14), this.status),
        h('span', {}, h('kbd', { text: 'W A S D' }), ' / arrows to drive, ', h('kbd', { text: 'Space' }), ' to drift, gamepads supported'),
        h('button', { class: 'btn small', id: 'btn-settings', onClick: () => actions.openSettings() }, icon('gear', 16), 'Settings'),
      ),
    );
  }

  /** Replaces the create button behaviour once the dialog exists. */
  setStatus(text: string): void {
    this.status.textContent = text;
  }

  setRecords(records: TrackRecord[]): void {
    clear(this.recordsBox);
    for (const record of records) {
      const def = TRACK_DEFS.find((d) => d.id === record.trackId);
      if (!def) continue;
      this.recordsBox.appendChild(
        h('span', { class: 'badge', title: 'Fastest lap set on this server' }, icon('clock', 14), `${def.name}: ${formatTime(record.ms)} by ${record.name}`),
      );
    }
  }

  refreshName(): void {
    this.nameInput.value = this.actions.getName();
  }
}

// ---------------------------------------------------------------- browser

const PHASE_LABEL: Record<RoomSummary['phase'], string> = { lobby: 'Open lobby', racing: 'Racing', results: 'Results' };

export class BrowserScreen {
  readonly element: HTMLElement;
  private readonly grid = h('div', { class: 'room-grid', id: 'room-grid' });
  private readonly summary = h('span', { class: 'muted', text: '' });
  private readonly nameInput: HTMLInputElement;
  private directory: RoomDirectory | null = null;
  private search = '';
  private trackFilter = 'all';
  private stateFilter: 'all' | 'lobby' | 'racing' = 'all';
  private hideFull = false;
  private pingMs = 0;
  private connected = false;

  constructor(private readonly actions: MenuActions) {
    this.nameInput = nameField(actions);
    this.nameInput.style.width = '180px';
    const trackOptions = [{ value: 'all', label: 'All tracks' }, ...TRACK_DEFS.map((d) => ({ value: d.id, label: d.name }))];
    this.element = h(
      'div',
      { class: 'screen', id: 'screen-browser' },
      h(
        'div',
        { class: 'topbar' },
        h('button', { class: 'btn small', id: 'btn-back', text: 'Back', onClick: () => actions.back() }),
        h('h2', { text: 'Public rooms' }),
        this.summary,
        h('span', { class: 'spacer' }),
        this.nameInput,
        h('button', { class: 'btn small', id: 'btn-refresh', onClick: () => actions.refresh() }, icon('refresh', 16), 'Refresh'),
        h('button', { class: 'btn small primary', id: 'btn-create-2', onClick: () => actions.createRoom(defaultRoomSettings(actions.getName())) }, 'Create room'),
      ),
      h(
        'div',
        { class: 'browser-body' },
        h(
          'div',
          { class: 'filters panel' },
          h('input', {
            type: 'text',
            id: 'room-search',
            placeholder: 'Search rooms or hosts',
            maxLength: 40,
            aria: { label: 'Search rooms' },
            onInput: (event) => {
              this.search = (event.target as HTMLInputElement).value.trim().toLowerCase();
              this.render();
            },
          }),
          select(trackOptions, this.trackFilter, (value) => {
            this.trackFilter = value;
            this.render();
          }, { aria: { label: 'Filter by track' } }),
          select(
            [
              { value: 'all', label: 'Any state' },
              { value: 'lobby', label: 'Open lobbies' },
              { value: 'racing', label: 'Racing now' },
            ] as const,
            this.stateFilter,
            (value) => {
              this.stateFilter = value;
              this.render();
            },
            { aria: { label: 'Filter by state' } },
          ),
          h(
            'label',
            { class: 'check' },
            h('input', {
              type: 'checkbox',
              onChange: (event) => {
                this.hideFull = (event.target as HTMLInputElement).checked;
                this.render();
              },
            }),
            'Hide full rooms',
          ),
        ),
        this.grid,
      ),
    );
  }

  refreshName(): void {
    this.nameInput.value = this.actions.getName();
  }

  setDirectory(directory: RoomDirectory): void {
    this.directory = directory;
    this.render();
  }

  setConnection(connected: boolean, pingMs: number): void {
    const pingChanged = Math.abs(pingMs - this.pingMs) >= 3 || pingMs > 0 !== this.pingMs > 0;
    if (connected === this.connected && !pingChanged) return;
    this.connected = connected;
    this.pingMs = pingMs;
    this.render();
  }

  private render(): void {
    clear(this.grid);
    if (!this.connected) {
      this.summary.textContent = '';
      this.grid.appendChild(
        h('div', { class: 'empty panel', style: { gridColumn: '1 / -1' } }, h('div', { class: 'spinner' }), h('h3', { text: 'Connecting...' }), h('p', { class: 'muted', text: 'Looking for the race server.' })),
      );
      return;
    }
    if (!this.directory) {
      this.grid.appendChild(h('div', { class: 'empty panel', style: { gridColumn: '1 / -1' } }, h('div', { class: 'spinner' }), h('h3', { text: 'Loading rooms...' })));
      return;
    }
    const all = this.directory.rooms;
    const rooms = all
      .filter((room) => {
        if (this.trackFilter !== 'all' && room.trackId !== this.trackFilter) return false;
        if (this.stateFilter === 'lobby' && room.phase !== 'lobby') return false;
        if (this.stateFilter === 'racing' && room.phase === 'lobby') return false;
        if (this.hideFull && room.players >= room.maxPlayers) return false;
        if (this.search && !room.name.toLowerCase().includes(this.search) && !room.hostName.toLowerCase().includes(this.search)) return false;
        return true;
      })
      .sort((a, b) => Number(a.phase !== 'lobby') - Number(b.phase !== 'lobby') || b.players - a.players || a.name.localeCompare(b.name));
    this.summary.textContent = `${all.length} public room${all.length === 1 ? '' : 's'} - ${this.directory.online} online`;

    if (rooms.length === 0) {
      const filtered = all.length > 0;
      this.grid.appendChild(
        h(
          'div',
          { class: 'empty panel', id: 'rooms-empty', style: { gridColumn: '1 / -1' } },
          h('h3', { text: filtered ? 'No rooms match your filters' : 'No public rooms right now' }),
          h('p', { class: 'muted', text: filtered ? 'Try clearing the search or filters.' : 'Be the first: create a room for others to find, or jump straight into a quick race with bots.' }),
          h(
            'div',
            { class: 'row' },
            h('button', { class: 'btn primary', text: 'Create room', onClick: () => this.actions.createRoom(defaultRoomSettings(this.actions.getName())) }),
            h('button', { class: 'btn', text: 'Quick race', onClick: () => this.actions.quickRace() }),
          ),
        ),
      );
      return;
    }
    for (const room of rooms) this.grid.appendChild(this.card(room));
  }

  private card(room: RoomSummary): HTMLElement {
    const def = getTrackDef(room.trackId);
    const full = room.players >= room.maxPlayers;
    const open = room.phase === 'lobby';
    const state = h('span', { class: `badge ${open ? (full ? 'full' : 'open') : room.phase}` });
    state.appendChild(icon(open ? (full ? 'x' : 'check') : room.phase === 'racing' ? 'play' : 'flag', 13));
    state.appendChild(document.createTextNode(open && full ? 'Full' : PHASE_LABEL[room.phase]));
    const ping = this.pingMs > 0 ? `${Math.max(1, Math.round(this.pingMs))} ms` : '-- ms';
    return h(
      'div',
      { class: 'card room-card panel', data: { code: room.code } },
      h(
        'div',
        { class: 'head' },
        trackThumb(room.trackId, 84, 60),
        h('div', { style: { minWidth: '0', display: 'grid', gap: '0.25rem' } }, h('h3', { text: room.name, title: room.name }), h('span', { class: 'muted', text: `Host: ${room.hostName}` })),
      ),
      h(
        'div',
        { class: 'meta' },
        state,
        h('span', { class: 'badge', title: 'Track' }, icon('flag', 13), def.name),
        h('span', { class: 'badge', title: 'Laps', text: `${room.laps} lap${room.laps === 1 ? '' : 's'}` }),
        h('span', { class: 'badge', title: 'Drivers / seats' }, icon('users', 13), `${room.players}/${room.maxPlayers}`),
        room.bots > 0 ? h('span', { class: 'badge', title: 'Practice bots' }, icon('bot', 13), `${room.bots}`) : null,
        room.spectators > 0 ? h('span', { class: 'badge', title: 'Spectators' }, icon('eye', 13), `${room.spectators}`) : null,
        room.region ? h('span', { class: 'badge', title: 'Server region', text: room.region }) : null,
        h('span', { class: 'badge', title: 'Your measured latency to this server' }, icon('signal', 13), ping),
      ),
      h(
        'div',
        { class: 'row' },
        h('span', { class: 'muted', text: `Code ${room.code}` }),
        h('span', { class: 'spacer' }),
        h('button', { class: 'btn small', text: 'Spectate', onClick: () => this.actions.joinRoom(room.code, true) }),
        h('button', {
          class: 'btn small primary',
          text: open ? 'Join' : 'Watch',
          disabled: open && full,
          title: open ? (full ? 'All driver seats are taken' : 'Join as a driver') : 'The race has started: join as a spectator and drive in the next one',
          onClick: () => this.actions.joinRoom(room.code, !open),
        }),
      ),
    );
  }
}

// ---------------------------------------------------------------- dialogs

/** Editable room settings, shared by the create dialog and the host's lobby panel. */
export function settingsForm(initial: RoomSettings, onChange: (settings: RoomSettings) => void, records: TrackRecord[], disabled = false): HTMLElement {
  const settings = { ...initial };
  const emit = (): void => onChange({ ...settings });
  const picker = h('div', { class: 'track-picker wide' });
  const renderPicker = (): void => {
    clear(picker);
    for (const def of TRACK_DEFS) {
      const record = records.find((r) => r.trackId === def.id);
      const option = h(
        'button',
        {
          class: `track-option${settings.trackId === def.id ? ' selected' : ''}`,
          disabled,
          data: { track: def.id },
          aria: { pressed: String(settings.trackId === def.id) },
          onClick: () => {
            settings.trackId = def.id;
            renderPicker();
            emit();
          },
        },
        trackThumb(def.id, 250, 130),
        h('strong', { text: def.name }),
        h('span', { class: 'tagline', text: def.tagline }),
        h(
          'span',
          { class: 'row' },
          h('span', { class: 'badge', text: def.difficulty }),
          h('span', { class: 'badge', text: `${(getTrack(def.id).length / 1000).toFixed(2)} km` }),
          h('span', { class: 'badge', text: def.surface.name }),
          record ? h('span', { class: 'badge', title: `Record by ${record.name}` }, icon('clock', 13), formatTime(record.ms)) : null,
        ),
      );
      picker.appendChild(option);
    }
  };
  renderPicker();

  const number = (label: string, value: number, min: number, max: number, apply: (v: number) => void): HTMLElement => {
    const input = h('input', {
      type: 'number',
      value: String(value),
      min,
      max,
      step: 1,
      disabled,
      onChange: () => {
        const parsed = Math.round(Number(input.value));
        const clamped = Number.isFinite(parsed) ? Math.min(max, Math.max(min, parsed)) : value;
        input.value = String(clamped);
        apply(clamped);
        emit();
      },
    });
    return h('label', { class: 'field' }, label, input);
  };

  const skill = select(
    BOT_SKILLS.map((value) => ({ value, label: value[0]!.toUpperCase() + value.slice(1) })),
    settings.botSkill,
    (value: BotSkill) => {
      settings.botSkill = value;
      emit();
    },
  );
  skill.disabled = disabled;

  return h(
    'div',
    { class: 'form-grid' },
    h(
      'label',
      { class: 'field wide' },
      'Room name',
      h('input', {
        type: 'text',
        value: settings.name,
        maxLength: ROOM_NAME_MAX,
        disabled,
        id: 'room-name',
        onChange: (event) => {
          const input = event.target as HTMLInputElement;
          const clean = sanitizeText(input.value, ROOM_NAME_MAX);
          if (clean) settings.name = clean;
          input.value = settings.name;
          emit();
        },
      }),
    ),
    picker,
    number('Laps', settings.laps, MIN_LAPS, MAX_LAPS, (v) => (settings.laps = v)),
    number('Driver seats', settings.maxPlayers, 1, MAX_RACERS, (v) => (settings.maxPlayers = v)),
    number('Practice bots', settings.bots, 0, MAX_RACERS - 1, (v) => (settings.bots = v)),
    h('label', { class: 'field' }, 'Bot difficulty', skill),
    h(
      'label',
      { class: 'check wide' },
      h('input', {
        type: 'checkbox',
        checked: settings.isPublic,
        disabled,
        id: 'room-public',
        onChange: (event) => {
          settings.isPublic = (event.target as HTMLInputElement).checked;
          emit();
        },
      }),
      'Public room (listed in the room browser for everyone)',
    ),
  );
}

export function openCreateDialog(modals: Modals, initial: RoomSettings, records: TrackRecord[], onCreate: (settings: RoomSettings) => void): ModalHandle {
  let settings = { ...initial };
  let handle: ModalHandle | null = null;
  const close = (): void => handle?.close();
  handle = modals.open(
    { title: 'Create a room', onDismiss: close },
    settingsForm(settings, (next) => (settings = next), records),
    h(
      'div',
      { class: 'actions' },
      h('button', { class: 'btn', text: 'Cancel', onClick: close }),
      h('button', {
        class: 'btn primary',
        id: 'btn-create-confirm',
        text: 'Create room',
        onClick: () => {
          close();
          onCreate(settings);
        },
      }),
    ),
  );
  return handle;
}

/** Shown when the page was opened from an invite link. */
export function openInviteDialog(modals: Modals, code: string, actions: MenuActions, onClose: () => void): ModalHandle {
  let handle: ModalHandle | null = null;
  const close = (): void => {
    handle?.close();
    onClose();
  };
  const name = nameField(actions);
  const go = (spectate: boolean): void => {
    actions.setName(name.value);
    handle?.close();
    actions.joinRoom(code, spectate);
  };
  name.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') go(false);
  });
  handle = modals.open(
    { title: `Join room ${code}`, narrow: true, onDismiss: close },
    h('p', { class: 'muted', text: 'You were invited to a race. Pick a name and jump in.' }),
    h('label', { class: 'field' }, 'Driver name', name),
    h(
      'div',
      { class: 'actions' },
      h('button', { class: 'btn', text: 'Not now', onClick: close }),
      h('button', { class: 'btn', text: 'Spectate', onClick: () => go(true) }),
      h('button', { class: 'btn primary', id: 'btn-invite-join', text: 'Join race', onClick: () => go(false) }),
    ),
  );
  return handle;
}
