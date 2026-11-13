/** The room lobby: roster, ready state, host settings, invite link and chat. */
import { CAR_COLORS, CHAT_MAX, MAX_RACERS } from '../../../shared/constants';
import type { RoomSettingsPatch, RoomState, TrackRecord } from '../../../shared/protocol';
import { getTrack, getTrackDef } from '../../../shared/sim/tracks';
import { clear, colourHex, formatTime, h, icon } from './dom';
import { settingsForm, trackThumb } from './menu';

export interface LobbyActions {
  leave(): void;
  setReady(ready: boolean): void;
  setRole(role: 'racer' | 'spectator'): void;
  start(): void;
  kick(memberId: string, name: string): void;
  updateSettings(patch: RoomSettingsPatch): void;
  chat(text: string): void;
  copyInvite(): void;
  openSettings(): void;
  inviteUrl(): string;
}

export class LobbyScreen {
  readonly element: HTMLElement;
  private readonly title = h('h2', { text: 'Lobby' });
  private readonly code = h('span', { class: 'code-chip', id: 'room-code', title: 'Room code' });
  private readonly left = h('div', { class: 'lobby-col' });
  private readonly right = h('div', { class: 'lobby-col' });
  private readonly chatLog = h('div', { class: 'chat-log', id: 'chat-log', aria: { live: 'polite' } });
  private readonly chatPanel: HTMLElement;
  private settingsKey = '';
  private settingsPanel: HTMLElement | null = null;
  private records: TrackRecord[] = [];

  constructor(private readonly actions: LobbyActions) {
    const chatInput = h('input', { type: 'text', maxLength: CHAT_MAX, placeholder: 'Say something...', id: 'chat-input', autocomplete: 'off', aria: { label: 'Chat message' } });
    this.chatPanel = h(
      'div',
      { class: 'panel card chat' },
      h('div', { class: 'section-title', text: 'Chat' }),
      this.chatLog,
      h(
        'form',
        {
          onSubmit: (event) => {
            event.preventDefault();
            const text = chatInput.value.trim();
            if (text) actions.chat(text);
            chatInput.value = '';
          },
        },
        chatInput,
        h('button', { class: 'btn', type: 'submit', text: 'Send' }),
      ),
    );
    this.element = h(
      'div',
      { class: 'screen', id: 'screen-lobby' },
      h(
        'div',
        { class: 'topbar' },
        h('button', { class: 'btn small danger', id: 'btn-leave', text: 'Leave', onClick: () => actions.leave() }),
        this.title,
        this.code,
        h('button', { class: 'btn small', id: 'btn-invite', onClick: () => actions.copyInvite() }, icon('link', 16), 'Copy invite link'),
        h('span', { class: 'spacer' }),
        h('button', { class: 'btn small', onClick: () => actions.openSettings() }, icon('gear', 16), 'Settings'),
      ),
      h('div', { class: 'lobby-body' }, this.left, this.right),
    );
  }

  setRecords(records: TrackRecord[]): void {
    this.records = records;
    this.settingsKey = '';
  }

  addChat(name: string, text: string): void {
    this.chatLog.appendChild(h('div', {}, h('b', { text: `${name}: ` }), text));
    this.trimChat();
  }

  addSystem(text: string): void {
    this.chatLog.appendChild(h('div', { class: 'sys', text }));
    this.trimChat();
  }

  clearChat(): void {
    clear(this.chatLog);
  }

  private trimChat(): void {
    while (this.chatLog.children.length > 80) this.chatLog.firstElementChild?.remove();
    this.chatLog.scrollTop = this.chatLog.scrollHeight;
  }

  render(room: RoomState, youId: string): void {
    const isHost = room.hostId === youId;
    const me = room.members.find((m) => m.id === youId);
    const racers = room.members.filter((m) => m.role === 'racer');
    const spectators = room.members.filter((m) => m.role === 'spectator');
    const def = getTrackDef(room.settings.trackId);
    this.title.textContent = room.settings.name;
    this.code.textContent = room.code;

    // ---- Left column: roster and actions.
    clear(this.left);
    if (room.lastRaceNote) this.left.appendChild(h('div', { class: 'note', id: 'race-note' }, icon('warning'), h('span', { text: room.lastRaceNote })));

    const bots = Math.min(room.settings.bots, MAX_RACERS - racers.length);
    const roster = h('div', { class: 'panel card' });
    roster.appendChild(
      h('div', { class: 'row' }, h('div', { class: 'section-title', text: `Drivers ${racers.length}/${room.settings.maxPlayers}` }), h('span', { class: 'spacer' }), bots > 0 ? h('span', { class: 'badge' }, icon('bot', 13), `+${bots} bot${bots === 1 ? '' : 's'} (${room.settings.botSkill})`) : null),
    );
    const list = h('div', { class: 'members', id: 'drivers' });
    for (const member of racers) list.appendChild(this.memberRow(room, member, true, youId, isHost));
    if (racers.length === 0) list.appendChild(h('div', { class: 'muted', text: 'No drivers yet.' }));
    roster.appendChild(list);
    if (spectators.length > 0) {
      roster.appendChild(h('div', { class: 'section-title', text: `Spectators ${spectators.length}` }));
      const watching = h('div', { class: 'members', id: 'spectators' });
      for (const member of spectators) watching.appendChild(this.memberRow(room, member, false, youId, isHost));
      roster.appendChild(watching);
    }
    this.left.appendChild(roster);

    const controls = h('div', { class: 'panel card' });
    if (room.phase !== 'lobby') {
      controls.appendChild(h('div', { class: 'note' }, icon('play'), h('span', { text: room.phase === 'racing' ? 'A race is in progress.' : 'The race has finished.' })));
    } else if (me) {
      const waiting = racers.filter((m) => m.connected && !m.ready && m.id !== room.hostId);
      const row = h('div', { class: 'row' });
      if (me.role === 'racer' && !isHost) {
        row.appendChild(
          h(
            'button',
            { class: `btn big ${me.ready ? 'on' : 'primary'}`, id: 'btn-ready', aria: { pressed: String(me.ready) }, onClick: () => this.actions.setReady(!me.ready) },
            icon(me.ready ? 'check' : 'flag'),
            me.ready ? 'Ready - click to cancel' : 'Ready up',
          ),
        );
      }
      if (isHost) {
        const canStart = waiting.length === 0 && racers.some((m) => m.connected);
        row.appendChild(
          h(
            'button',
            { class: 'btn big primary', id: 'btn-start', disabled: !canStart, title: canStart ? 'Start the countdown for everyone' : 'Waiting for drivers to ready up', onClick: () => this.actions.start() },
            icon('play'),
            'Start race',
          ),
        );
      }
      row.appendChild(
        h('button', {
          class: 'btn',
          id: 'btn-role',
          text: me.role === 'racer' ? 'Spectate instead' : 'Take a driver seat',
          disabled: me.role === 'spectator' && racers.length >= room.settings.maxPlayers,
          onClick: () => this.actions.setRole(me.role === 'racer' ? 'spectator' : 'racer'),
        }),
      );
      controls.appendChild(row);
      let hint: string;
      if (isHost) {
        if (!racers.some((m) => m.connected)) hint = 'Take a driver seat to start a race.';
        else if (waiting.length > 0) hint = `Waiting for ${waiting.map((m) => m.name).join(', ')} to ready up.`;
        else hint = 'Everyone is ready. Start whenever you like.';
      } else if (me.role === 'racer') {
        hint = me.ready ? 'Waiting for the host to start the race.' : 'Ready up so the host can start.';
      } else {
        hint = 'You are spectating. You will watch the race live.';
      }
      controls.appendChild(h('div', { class: 'muted', id: 'lobby-hint', text: hint }));
    }
    this.left.appendChild(controls);
    this.left.appendChild(
      h(
        'div',
        { class: 'panel card' },
        h('div', { class: 'section-title', text: 'Invite friends' }),
        h('div', { class: 'muted', text: 'Share this link, or tell them the room code:' }),
        h('input', { type: 'text', value: this.actions.inviteUrl(), id: 'invite-url', aria: { label: 'Invite link' }, onClick: (event) => (event.target as HTMLInputElement).select() }),
      ),
    );

    // ---- Right column: race settings and chat. The settings form is only
    // rebuilt when the settings change, so the host's inputs keep focus.
    const key = JSON.stringify([room.settings, isHost, room.phase, this.records]);
    if (key !== this.settingsKey || !this.settingsPanel) {
      this.settingsKey = key;
      const panel = h('div', { class: 'panel card', id: 'race-settings' });
      panel.appendChild(h('div', { class: 'section-title', text: isHost ? 'Race settings (you are the host)' : 'Race settings' }));
      if (isHost && room.phase === 'lobby') {
        let current = { ...room.settings };
        panel.appendChild(
          settingsForm(
            room.settings,
            (next) => {
              const patch: Record<string, unknown> = {};
              for (const k of Object.keys(next) as Array<keyof typeof next>) if (next[k] !== current[k]) patch[k] = next[k];
              current = next;
              if (Object.keys(patch).length > 0) this.actions.updateSettings(patch as RoomSettingsPatch);
            },
            this.records,
          ),
        );
      } else {
        const record = this.records.find((r) => r.trackId === def.id);
        panel.appendChild(
          h(
            'div',
            { class: 'row', style: { alignItems: 'flex-start' } },
            trackThumb(def.id, 190, 120),
            h(
              'div',
              { style: { display: 'grid', gap: '0.4rem', flex: '1', minWidth: '180px' } },
              h('strong', { text: def.name, id: 'lobby-track' }),
              h('span', { class: 'muted', text: def.tagline }),
              h(
                'div',
                { class: 'row' },
                h('span', { class: 'badge', text: `${room.settings.laps} lap${room.settings.laps === 1 ? '' : 's'}` }),
                h('span', { class: 'badge', text: `${(getTrack(def.id).length / 1000).toFixed(2)} km` }),
                h('span', { class: 'badge', text: def.surface.name }),
                h('span', { class: 'badge', text: room.settings.isPublic ? 'Public' : 'Private' }),
                record ? h('span', { class: 'badge', title: `Record by ${record.name}` }, icon('clock', 13), formatTime(record.ms)) : null,
              ),
            ),
          ),
        );
      }
      this.settingsPanel = panel;
    }
    clear(this.right);
    this.right.appendChild(this.settingsPanel);
    this.right.appendChild(this.chatPanel);
  }

  private memberRow(room: RoomState, member: RoomState['members'][number], driver: boolean, youId: string, isHost: boolean): HTMLElement {
    const you = member.id === youId;
    const host = member.id === room.hostId;
    const row = h('div', { class: `member${you ? ' you' : ''}${member.connected ? '' : ' offline'}`, data: { member: member.id } });
    if (driver) {
      // The swatch is the paint colour of this driver's car; the initial keeps it readable without colour.
      const initial = [...member.name][0]?.toUpperCase() ?? '?';
      row.appendChild(h('span', { class: 'num', text: initial, title: 'Car colour', style: { background: colourHex(CAR_COLORS[member.colour % CAR_COLORS.length]!) } }));
    } else {
      row.appendChild(icon('eye'));
    }
    row.appendChild(h('span', { class: 'name', text: member.name }));
    if (you) row.appendChild(h('span', { class: 'badge', text: 'You' }));
    if (host) row.appendChild(h('span', { class: 'badge', title: 'Room host' }, icon('crown', 13), 'Host'));
    row.appendChild(h('span', { class: 'spacer' }));
    if (!member.connected) {
      row.appendChild(h('span', { class: 'badge full' }, icon('warning', 13), 'Reconnecting'));
    } else if (member.role === 'racer' && room.phase === 'lobby') {
      const ready = member.ready || host;
      row.appendChild(h('span', { class: `badge ${ready ? 'open' : ''}`, data: { ready: String(ready) } }, icon(ready ? 'check' : 'clock', 13), ready ? 'Ready' : 'Not ready'));
    }
    if (member.connected) row.appendChild(h('span', { class: 'ping', text: member.pingMs > 0 ? `${member.pingMs} ms` : '' }));
    if (isHost && !you) {
      row.appendChild(h('button', { class: 'btn small danger', text: 'Kick', title: `Remove ${member.name} from the room`, onClick: () => this.actions.kick(member.id, member.name) }));
    }
    return row;
  }
}
