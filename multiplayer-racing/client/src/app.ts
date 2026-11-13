/**
 * The browser application: wires the network client, renderer, audio, input
 * and UI together and owns the frame loop. No game rules live here.
 */
import { NAME_MAX, SIM_HZ } from '../../shared/constants';
import { parseNetConditions, type NetConditions } from '../../shared/net/netsim';
import { CarFlag, RacePhaseCode } from '../../shared/protocol/binary';
import { normalizeRoomCode, sanitizeText, type RoomSettings, type RoomState } from '../../shared/protocol';
import { BotDriver, botProfileFor } from '../../shared/sim/bot';
import { makeQuery, queryTrack } from '../../shared/sim/track';
import { getTrack } from '../../shared/sim/tracks';
import { gearForSpeed, rpmForSpeed, type CarInput } from '../../shared/sim/vehicle';
import { AudioEngine } from './audio/audio';
import type { ClientConfig } from './config';
import { GameRenderer, webglAvailable } from './game/renderer';
import { InputManager } from './input/input';
import type { ConnectionFailure, ConnectionStatus } from './net/connection';
import { GameClient } from './net/gameClient';
import { DEGRADED_MS, STALL_MS, type RaceClient, type RaceClientEvent, type RaceView } from './net/raceClient';
import { CAMERA_LABELS, CAMERA_MODES, loadSettings, randomDriverName, saveSettings, tabSessionStore, type Settings } from './storage/settings';
import { formatTime, h, ordinal } from './ui/dom';
import { Hud, type NetStatus } from './ui/hud';
import { LobbyScreen } from './ui/lobby';
import { BrowserScreen, HomeScreen, openCreateDialog, openInviteDialog, type MenuActions } from './ui/menu';
import { ConnectionBanner, Modals, Splash, Toasts, type ModalHandle } from './ui/overlays';
import { ResultsOverlay, openPauseMenu, openSettingsDialog } from './ui/panels';

type Screen = 'home' | 'browser' | 'lobby' | 'race' | 'results';

export class App {
  private readonly settings: Settings;
  private readonly game: GameClient;
  private readonly renderer: GameRenderer | null;
  private readonly audio: AudioEngine;
  private readonly input: InputManager;
  private readonly toasts = new Toasts();
  private readonly modals = new Modals();
  private readonly banner = new ConnectionBanner();
  private readonly splash = new Splash();
  private readonly home: HomeScreen;
  private readonly browser: BrowserScreen;
  private readonly lobby: LobbyScreen;
  private readonly hud: Hud;
  private readonly results: ResultsOverlay;
  private readonly screens: Record<'home' | 'browser' | 'lobby', HTMLElement>;

  private screen: Screen = 'home';
  private lastFrame = performance.now();
  private pauseMenu: ModalHandle | null = null;
  private settingsDialog: ModalHandle | null = null;
  private inviteCode: string | null;
  private everConnected = false;
  private followSlot = -1;
  private spectatorPick = -1;
  private netQuality: NetStatus['quality'] = 'good';
  private lastNetWarningAt = 0;
  private lastCountdownSecond = -1;
  private lastView: RaceView | null = null;
  private backdropTrack = 0;
  private shutdownNotice = '';
  private pendingJoin: { code: string; spectate: boolean } | null = null;
  private readonly remoteGears = new Map<number, number>();
  /** Debug/demo aid: when set, produces the local inputs instead of the keyboard. */
  private autopilot: ((race: RaceClient) => Readonly<CarInput>) | null = null;

  constructor(root: HTMLElement, canvas: HTMLCanvasElement, config: ClientConfig) {
    this.settings = loadSettings();
    if (!this.settings.name) {
      this.settings.name = randomDriverName();
      saveSettings(this.settings);
    }
    document.body.classList.toggle('reduced-motion', this.settings.reducedMotion);

    this.audio = new AudioEngine(this.settings);
    this.input = new InputManager(this.settings);
    this.renderer = webglAvailable() ? new GameRenderer(canvas, this.settings) : null;
    if (this.renderer) {
      this.renderer.cameraMode = this.settings.camera;
      this.renderer.setTrack(getTrack('harbor'));
    }

    const params = new URLSearchParams(location.search);
    const invite = normalizeRoomCode(params.get('room') ?? '');
    this.inviteCode = invite.length === 5 ? invite : null;

    this.game = new GameClient({ url: config.wsUrl, store: tabSessionStore() });
    const simulated = params.get('netsim');
    if (simulated) this.game.connection.setNetConditions(parseNetConditions(simulated));

    const menuActions: MenuActions = {
      quickRace: () => {
        this.audio.ui('click');
        this.game.quickJoin(this.settings.name);
      },
      browse: () => {
        this.audio.ui('click');
        this.show('browser');
      },
      createRoom: (initial) => {
        this.audio.ui('click');
        openCreateDialog(this.modals, initial, this.game.records, (settings: RoomSettings) => this.game.createRoom(this.settings.name, settings));
      },
      joinRoom: (code, spectate) => {
        this.audio.ui('click');
        this.pendingJoin = { code, spectate };
        this.game.joinRoom(code, this.settings.name, spectate);
      },
      refresh: () => {
        this.audio.ui('click');
        this.game.listRooms(true);
      },
      back: () => this.show('home'),
      openSettings: () => this.openSettings(),
      setName: (name) => this.setName(name),
      getName: () => this.settings.name,
      click: () => this.audio.ui('click'),
    };
    this.home = new HomeScreen(menuActions);
    this.browser = new BrowserScreen(menuActions);
    this.lobby = new LobbyScreen({
      leave: () => this.confirmLeave(),
      setReady: (ready) => {
        this.audio.ui(ready ? 'ready' : 'click');
        this.game.setReady(ready);
      },
      setRole: (role) => this.game.setRole(role),
      start: () => {
        this.audio.ui('click');
        this.game.startRace();
      },
      kick: (id, name) => this.modals.confirm('Remove player', `Remove ${name} from the room? They will not be able to rejoin for a while.`, 'Remove', () => this.game.kick(id), true),
      updateSettings: (patch) => this.game.updateSettings(patch),
      chat: (text) => this.game.chat(text),
      copyInvite: () => this.copyInvite(),
      openSettings: () => this.openSettings(),
      inviteUrl: () => this.inviteUrl(),
    });
    this.hud = new Hud(this.settings);
    this.results = new ResultsOverlay(this.modals, {
      backToLobby: () => this.game.returnToLobby(),
      leave: () => this.game.leaveRoom(),
    });
    this.screens = { home: this.home.element, browser: this.browser.element, lobby: this.lobby.element };

    root.append(this.home.element, this.browser.element, this.lobby.element, this.hud.element, this.banner.element, this.modals.element, this.toasts.element, this.splash.element);
    this.show('home');

    this.input.onUiAction = (action) => {
      if (action === 'pause') this.onPause();
      else if (action === 'camera' && this.screen === 'race' && !this.modals.isOpen) this.cycleCamera();
    };
    // Audio may only start after a user gesture.
    const unlock = (): void => this.audio.unlock();
    window.addEventListener('pointerdown', unlock);
    window.addEventListener('keydown', unlock);
    window.addEventListener('keydown', (event) => this.onSpectatorKey(event));
    window.addEventListener('resize', () => this.renderer?.resize());

    this.bindGame();
    this.installTestHook();

    if (!this.renderer) {
      this.splash.set('WebGL is not available', 'Apex Drift needs WebGL to draw the race. Enable hardware acceleration or try another browser.', false);
      return;
    }
    this.splash.set('Connecting to the race server...', '', true);
    this.game.connect();
    requestAnimationFrame((t) => this.frame(t));
  }

  // ------------------------------------------------------------ navigation

  private show(screen: Screen): void {
    this.screen = screen;
    for (const [name, element] of Object.entries(this.screens)) element.classList.toggle('hidden', name !== screen);
    if (screen !== 'race') this.hud.hide();
    if (screen === 'browser') {
      this.browser.refreshName();
      this.browser.setConnection(this.game.connection.isOpen, this.game.connection.rttMs);
      this.game.listRooms(true);
    } else if (screen === 'home') {
      this.home.refreshName();
      if (this.game.connection.isOpen) this.game.listRooms(false);
    }
    this.input.enabled = screen === 'race' && this.game.raceSlot >= 0 && !this.pauseMenu;
  }

  private setName(raw: string): void {
    const clean = sanitizeText(raw, NAME_MAX);
    if (!clean) return;
    this.settings.name = clean;
    saveSettings(this.settings);
    if (this.game.room && this.game.room.phase !== 'racing' && this.game.me && this.game.me.name !== clean) this.game.rename(clean);
  }

  private applySettings(): void {
    saveSettings(this.settings);
    document.body.classList.toggle('reduced-motion', this.settings.reducedMotion);
    this.audio.setSettings(this.settings);
    this.input.setSettings(this.settings);
    this.renderer?.setSettings(this.settings);
    this.hud.setSettings(this.settings);
  }

  private openSettings(): void {
    if (this.settingsDialog) return;
    this.input.enabled = false;
    this.settingsDialog = openSettingsDialog(
      this.modals,
      {
        settings: this.settings,
        input: this.input,
        apply: () => this.applySettings(),
        getNetConditions: () => this.game.connection.netConditions,
        setNetConditions: (conditions: NetConditions) => this.game.connection.setNetConditions(conditions),
        testSound: () => {
          this.audio.unlock();
          this.audio.lap(true);
        },
      },
      () => {
        this.settingsDialog = null;
        this.input.enabled = this.screen === 'race' && this.game.raceSlot >= 0 && !this.pauseMenu;
      },
    );
  }

  private inviteUrl(): string {
    const url = new URL(location.href);
    url.search = '';
    url.hash = '';
    if (this.game.room) url.searchParams.set('room', this.game.room.code);
    return url.toString();
  }

  private copyInvite(): void {
    const url = this.inviteUrl();
    const done = (): void => this.toasts.show('Invite link copied to the clipboard.', 'good');
    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(url).then(done, () => this.toasts.show(`Invite link: ${url}`, 'info', 9000));
    } else {
      this.toasts.show(`Invite link: ${url}`, 'info', 9000);
    }
  }

  private setUrlRoom(code: string | null): void {
    const url = new URL(location.href);
    if (code) url.searchParams.set('room', code);
    else url.searchParams.delete('room');
    history.replaceState(null, '', url);
  }

  private confirmLeave(): void {
    const room = this.game.room;
    if (room && room.phase === 'racing' && this.game.raceSlot >= 0) {
      this.modals.confirm('Leave the race?', 'Your car will be removed from the race.', 'Leave', () => this.game.leaveRoom(), true);
    } else {
      this.game.leaveRoom();
    }
  }

  // ---------------------------------------------------------- game events

  private bindGame(): void {
    const game = this.game;
    game.on('status', (status, failure) => this.onStatus(status, failure));
    game.on('ready', (reconnected) => {
      this.everConnected = true;
      this.shutdownNotice = '';
      this.splash.hide();
      this.banner.hide();
      if (reconnected && !game.hasStoredSession()) this.toasts.show('Reconnected to the server.', 'good');
      this.home.setStatus(`Online${game.connection.welcome?.region ? ` - ${game.connection.welcome.region}` : ''}`);
      this.browser.setConnection(true, game.connection.rttMs);
      if (this.screen === 'browser') game.listRooms(true);
      if (this.inviteCode && !game.hasStoredSession() && !game.room) {
        const code = this.inviteCode;
        this.inviteCode = null;
        openInviteDialog(this.modals, code, this.menuActionsForInvite(), () => this.setUrlRoom(null));
      }
    });
    game.on('directory', (directory) => this.browser.setDirectory(directory));
    game.on('records', (records) => {
      this.home.setRecords(records);
      this.lobby.setRecords(records);
      if (game.room && this.screen === 'lobby') this.lobby.render(game.room, game.youId);
    });
    game.on('joined', (room, resumed) => {
      this.pendingJoin = null;
      this.inviteCode = null;
      this.setUrlRoom(room.code);
      if (!resumed) this.lobby.clearChat();
      this.lobby.addSystem(resumed ? 'You are back in the room.' : `You joined ${room.settings.name}.`);
      if (resumed) this.toasts.show('Reconnected - you are back in your seat.', 'good');
      else this.audio.ui('join');
      this.syncRoom(room, null);
    });
    game.on('room', (room, previous) => this.syncRoom(room, previous));
    game.on('left', (reason, message) => {
      this.results.hide();
      this.closePause();
      this.setUrlRoom(null);
      this.show(this.screen === 'home' ? 'home' : 'browser');
      if (reason === 'kicked') this.modals.alert('Removed from the room', message || 'The host removed you from the room.');
      else if (reason === 'room_closed') this.modals.alert('Room closed', message || 'The room was closed.');
      else if (reason === 'expired') this.modals.alert('Seat expired', message || 'You were disconnected for too long and lost your seat.');
      else if (reason === 'replaced') this.modals.alert('Opened elsewhere', message);
    });
    game.on('notice', (code, message) => {
      this.lobby.addSystem(message);
      if (code === 'race_cancelled') {
        this.audio.ui('error');
        this.modals.alert('Race cancelled', message);
      } else if (code === 'host_changed') {
        this.toasts.show(message, game.isHost ? 'good' : 'info');
      } else if (this.screen === 'race' && code !== 'race_finished') {
        this.toasts.show(message, 'info', 2600);
      }
    });
    game.on('chat', (_from, name, text) => {
      this.lobby.addChat(name, text);
      if (this.screen !== 'lobby') this.toasts.show(`${name}: ${text}`, 'info', 3500);
    });
    game.on('error', (code, message, retryAfterMs) => {
      const pending = this.pendingJoin;
      this.pendingJoin = null;
      switch (code) {
        case 'room_full':
          if (pending && !pending.spectate) {
            this.modals.confirm('Room is full', 'Every driver seat is taken. You can watch the race as a spectator and take a seat when one frees up.', 'Spectate', () => this.game.joinRoom(pending.code, this.settings.name, true));
          } else {
            this.toasts.show(message, 'warn');
          }
          break;
        case 'room_not_found':
          this.setUrlRoom(null);
          this.modals.alert('Room unavailable', 'That room does not exist any more. It may have closed, or the code may be mistyped.');
          if (this.screen === 'browser') this.game.listRooms(true);
          break;
        case 'resume_failed':
          this.toasts.show('Your previous seat has expired.', 'warn');
          break;
        case 'rate_limited':
          this.toasts.show(retryAfterMs > 0 ? `${message} Try again in ${Math.ceil(retryAfterMs / 1000)}s.` : message, 'warn');
          break;
        case 'banned':
          this.modals.alert('Cannot join', message);
          break;
        case 'version_mismatch':
          break; // Shown through the connection status.
        default:
          this.toasts.show(message, 'error');
          this.audio.ui('error');
      }
    });
    game.on('raceStart', (race, room) => this.onRaceStart(race, room));
    game.on('raceEnd', () => this.onRaceEnd());
    game.on('shutdown', (message) => {
      this.shutdownNotice = message;
      this.banner.show(message, true);
    });
  }

  private menuActionsForInvite(): MenuActions {
    return {
      quickRace: () => undefined,
      browse: () => undefined,
      createRoom: () => undefined,
      joinRoom: (code, spectate) => {
        this.pendingJoin = { code, spectate };
        this.game.joinRoom(code, this.settings.name, spectate);
      },
      refresh: () => undefined,
      back: () => undefined,
      openSettings: () => undefined,
      setName: (name) => {
        this.setName(name);
        this.home.refreshName();
      },
      getName: () => this.settings.name,
      click: () => undefined,
    };
  }

  private onStatus(status: ConnectionStatus, failure: ConnectionFailure | null): void {
    const connection = this.game.connection;
    this.browser.setConnection(status === 'open', connection.rttMs);
    switch (status) {
      case 'connecting':
        this.home.setStatus('Connecting...');
        if (!this.everConnected) {
          if (connection.attempts >= 2) {
            this.splash.set('Cannot reach the race server', 'Still trying. Check that the server is running and that you are online.', true, { label: 'Retry now', run: () => location.reload() });
          } else {
            this.splash.set('Connecting to the race server...', '', true);
          }
        }
        break;
      case 'reconnecting':
        this.home.setStatus('Reconnecting...');
        this.banner.show(
          this.shutdownNotice || (this.game.room ? `Connection lost. Reconnecting (attempt ${connection.attempts})... your seat is held for a short while.` : `Connection lost. Reconnecting (attempt ${connection.attempts})...`),
          connection.attempts > 3,
        );
        break;
      case 'open':
        this.banner.hide();
        break;
      case 'failed': {
        this.home.setStatus('Offline');
        this.banner.hide();
        this.audio.setRacing(false);
        const kind = failure?.kind ?? 'rejected';
        if (kind === 'version_mismatch') {
          this.splash.set('Update required', failure?.message ?? 'This page is out of date. Reload to get the current version.', false, { label: 'Reload', run: () => location.reload() });
        } else if (kind === 'replaced') {
          this.splash.set('Opened in another tab', 'This seat is now being used from another tab or device.', false, { label: 'Take it back here', run: () => location.reload() });
        } else {
          this.splash.set('Disconnected by the server', failure?.message ?? 'The server closed the connection.', false, { label: 'Reconnect', run: () => location.reload() });
        }
        break;
      }
      default:
        break;
    }
  }

  /** Brings the UI in line with the room's phase. */
  private syncRoom(room: RoomState, previous: RoomState | null): void {
    if (room.phase === 'results') {
      this.closePause();
      if (!this.results.isOpen || previous?.phase !== 'results') {
        this.show('results');
        this.results.show(room, this.game.youId);
      }
      return;
    }
    this.results.hide();
    if (room.phase === 'racing') {
      if (this.screen !== 'race') this.show('race');
      this.lobby.render(room, this.game.youId);
      return;
    }
    this.closePause();
    this.lobby.render(room, this.game.youId);
    if (this.screen !== 'lobby') this.show('lobby');
    if (previous && previous.hostId !== room.hostId && room.hostId === this.game.youId) this.audio.ui('ready');
  }

  private onRaceStart(race: RaceClient, room: RoomState): void {
    const renderer = this.renderer;
    if (renderer) {
      renderer.setTrack(race.track);
      renderer.setRace(race.race);
      renderer.snapCamera();
    }
    this.spectatorPick = -1;
    this.followSlot = race.slot;
    this.lastCountdownSecond = -1;
    this.lastView = null;
    this.remoteGears.clear();
    this.hud.show(race.track, race.race, race.slot < 0);
    this.show('race');
    this.audio.unlock();
    this.audio.setRacing(true);
    if (race.slot < 0) this.toasts.show(room.members.find((m) => m.id === this.game.youId)?.role === 'spectator' ? 'Spectating. Use the steer keys to switch cars.' : 'Race in progress: you are spectating until it ends.', 'info', 5000);
  }

  private onRaceEnd(): void {
    this.audio.setRacing(false);
    this.input.enabled = false;
    this.hud.hide();
    this.renderer?.clearCars();
    this.renderer?.setNextGate(null);
    this.lastView = null;
    this.closePause();
  }

  // ----------------------------------------------------------------- input

  private onPause(): void {
    if (this.modals.dismissTop()) return;
    if (this.screen !== 'race') return;
    this.input.enabled = false;
    this.pauseMenu = openPauseMenu(this.modals, this.game.isHost, this.game.raceSlot < 0, {
      resume: () => {
        this.pauseMenu = null;
        this.input.enabled = this.screen === 'race' && this.game.raceSlot >= 0;
      },
      settings: () => {
        this.pauseMenu = null;
        this.openSettings();
      },
      leave: () => {
        this.pauseMenu = null;
        this.confirmLeave();
        this.input.enabled = this.screen === 'race' && this.game.raceSlot >= 0;
      },
      abort: () => {
        this.pauseMenu = null;
        this.modals.confirm('Cancel the race?', 'Everyone returns to the lobby and the race is void.', 'Cancel race', () => this.game.abortRace(), true);
        this.input.enabled = this.screen === 'race' && this.game.raceSlot >= 0;
      },
      help: () => {
        this.pauseMenu = null;
        this.hud.showHints();
        this.input.enabled = this.screen === 'race' && this.game.raceSlot >= 0;
      },
    });
  }

  private closePause(): void {
    this.pauseMenu?.close();
    this.pauseMenu = null;
  }

  private cycleCamera(): void {
    const next = CAMERA_MODES[(CAMERA_MODES.indexOf(this.settings.camera) + 1) % CAMERA_MODES.length]!;
    this.settings.camera = next;
    this.applySettings();
    this.renderer?.snapCamera();
    this.toasts.show(`Camera: ${CAMERA_LABELS[next]}`, 'info', 1400);
  }

  /** Spectators switch the followed car with the steering keys. */
  private onSpectatorKey(event: KeyboardEvent): void {
    const race = this.game.race;
    if (!race || race.slot >= 0 || this.screen !== 'race' || this.modals.isOpen || event.repeat) return;
    const view = this.lastView;
    if (!view) return;
    const direction = this.settings.keys.right.includes(event.code) ? 1 : this.settings.keys.left.includes(event.code) ? -1 : 0;
    if (direction === 0) return;
    const order = view.cars.filter((c) => c.present).sort((a, b) => a.rank - b.rank);
    if (order.length === 0) return;
    const at = order.findIndex((c) => c.slot === this.followSlot);
    const next = order[(Math.max(0, at) + direction + order.length) % order.length]!;
    this.spectatorPick = next.slot;
    this.renderer?.snapCamera();
  }

  // ------------------------------------------------------------------ frame

  private frame(time: number): void {
    requestAnimationFrame((t) => this.frame(t));
    const dt = Math.min(0.1, Math.max(0, (time - this.lastFrame) / 1000));
    this.lastFrame = time;
    const renderer = this.renderer;
    if (!renderer) return;
    this.input.poll();

    const race = this.game.race;
    if (!race) {
      // Menu backdrop: a slow fly-around, alternating tracks between visits.
      this.backdropTrack += dt;
      renderer.followSlot = -1;
      renderer.render(null, dt);
      if (this.screen === 'browser') this.browser.setConnection(this.game.connection.isOpen, this.game.connection.rttMs);
      return;
    }

    const now = performance.now();
    race.update(now, () => (this.autopilot ? this.autopilot(race) : this.input.sample()));
    const view = race.view(now);
    this.lastView = view;

    // Who the camera follows: our car, or (spectating) the pick / the leader.
    let follow = race.slot;
    if (follow < 0) {
      const picked = this.spectatorPick >= 0 ? view.cars[this.spectatorPick] : undefined;
      if (picked?.present) follow = picked.slot;
      else {
        const leader = view.cars.filter((c) => c.present).sort((a, b) => a.rank - b.rank)[0];
        follow = leader ? leader.slot : -1;
      }
    }
    if (follow !== this.followSlot) {
      this.followSlot = follow;
      renderer.snapCamera();
    }
    renderer.followSlot = follow;
    const followed = follow >= 0 ? view.cars[follow] : undefined;

    for (const event of race.drainEvents()) this.onRaceEvent(event, view, follow);

    // Countdown beeps on the viewer's own timeline.
    if (view.hasData && view.countdownTicks > 0) {
      const second = Math.ceil(view.countdownTicks / SIM_HZ);
      if (second !== this.lastCountdownSecond) {
        if (this.lastCountdownSecond !== -1 && second <= 3) this.audio.countdown(false);
        this.lastCountdownSecond = second;
      }
    }

    if (followed?.present && !(followed.flags & CarFlag.FINISHED) && view.phase !== RacePhaseCode.finished) {
      renderer.setNextGate(followed.cp % race.track.gates.length);
    } else {
      renderer.setNextGate(null);
    }

    const net = this.netStatus(race, now);
    renderer.render(view, dt);
    this.hud.update(view, follow, net, this.settings.netStats ? this.netDebug(race) : '', dt);
    this.updateAudio(view, follow, race);
  }

  private onRaceEvent(event: RaceClientEvent, view: RaceView, follow: number): void {
    const renderer = this.renderer;
    this.hud.onEvent(event, follow);
    switch (event.type) {
      case 'go':
        this.audio.countdown(true);
        this.hud.go();
        break;
      case 'checkpoint': {
        if (event.slot !== follow) break;
        this.audio.checkpoint();
        const car = view.cars[event.slot];
        if (car?.present) renderer?.checkpointFlash(car.x, car.z);
        break;
      }
      case 'lap':
        if (event.slot === follow && event.ms > 0) {
          this.audio.lap(event.best);
          this.hud.announce(`Lap ${event.lap}: ${formatTime(event.ms)}${event.best ? ' - best lap' : ''}`, event.best ? 'good' : 'info');
        }
        break;
      case 'finish':
        if (event.slot === follow) {
          this.audio.finish(event.rank === 1);
          this.hud.screenFlash(0.5);
          this.hud.announce(`Finished ${ordinal(event.rank)} - ${formatTime(event.ms)}`, 'good', 5000);
        } else {
          const name = this.game.race?.race.cars.find((c) => c.slot === event.slot)?.name ?? 'A driver';
          this.toasts.show(`${name} finished ${ordinal(event.rank)}.`, 'info', 2600);
        }
        break;
      case 'impact': {
        const car = view.cars[event.slot];
        if (!car?.present) break;
        renderer?.impact(car.x + Math.sin(car.yaw) * 1.5, car.z + Math.cos(car.yaw) * 1.5, event.strength, event.local);
        const mine = follow >= 0 ? view.cars[follow] : undefined;
        const distance = mine?.present ? Math.hypot(mine.x - car.x, mine.z - car.z) : 999;
        if (event.slot === follow) this.audio.impact(event.strength);
        else if (distance < 45) this.audio.impact(event.strength * (1 - distance / 45) * 0.6);
        break;
      }
      case 'penalty':
        if (event.slot === follow) {
          this.audio.penalty();
          this.hud.announce('Penalty: too long off the track', 'warn', 2400);
        }
        break;
      case 'reset':
        if (event.slot === follow) {
          this.audio.reset();
          renderer?.snapCamera();
        }
        break;
      case 'position':
        this.audio.overtake(event.to < event.from);
        break;
      default:
        break;
    }
  }

  private netStatus(race: RaceClient, now: number): NetStatus {
    const connection = this.game.connection;
    const silence = race.silenceMs(now);
    let quality: NetStatus['quality'] = 'good';
    let label = 'Connected';
    if (connection.status !== 'open') {
      quality = 'bad';
      label = 'Reconnecting';
    } else if (silence > STALL_MS) {
      quality = 'bad';
      label = 'Connection stalled';
    } else if (silence > DEGRADED_MS || race.stats.loss > 0.08 || connection.rttMs > 250 || race.clock.latenessTicks > this.game.tickRate * 0.2) {
      quality = 'degraded';
      label = 'Unstable connection';
    }
    if (quality !== this.netQuality) {
      if (quality !== 'good' && now - this.lastNetWarningAt > 6000) {
        this.lastNetWarningAt = now;
        this.audio.networkWarning();
      }
      this.netQuality = quality;
    }
    const detail = `Round trip ${Math.round(connection.rttMs)} ms, snapshot loss ${(race.stats.loss * 100).toFixed(0)}%, interpolation delay ${Math.round((race.clock.delayTicks / this.game.tickRate) * 1000)} ms`;
    return { quality, label, rttMs: connection.rttMs, detail };
  }

  private netDebug(race: RaceClient): string {
    const s = race.stats;
    const p = race.predictor;
    const sim = this.game.connection.netConditions;
    return [
      `rtt ${Math.round(this.game.connection.rttMs)} ms   loss ${(s.loss * 100).toFixed(0)}%`,
      `snap ${s.snapshots} (full ${s.fullSnapshots}) dup ${s.duplicates} ooo ${s.outOfOrder}`,
      `pending inputs ${p.pending.length}   queue ${race.queueDepth.toFixed(1)}`,
      `interp delay ${race.clock.delayTicks.toFixed(1)} t   scale ${race.timeScale.toFixed(3)}`,
      `correction ${(p.lastCorrection * 100).toFixed(1)} cm   max ${(p.stats.maxCorrection * 100).toFixed(0)} cm`,
      `in ${(s.bytesIn / 1024).toFixed(0)} kB   out ${(s.bytesOut / 1024).toFixed(0)} kB`,
      sim.latencyMs + sim.jitterMs + sim.loss + sim.duplicate + sim.reorder > 0 ? `SIM lat ${sim.latencyMs} jit ${sim.jitterMs} loss ${(sim.loss * 100).toFixed(0)}%` : 'simulator off',
    ].join('\n');
  }

  private updateAudio(view: RaceView, follow: number, race: RaceClient): void {
    const car = follow >= 0 ? view.cars[follow] : undefined;
    if (!car?.present) return;
    const onIce = race.track.def.theme === 'glacier';
    this.audio.updateLocal(this.hud.rpm, car.throttle, car.speed, car.slip, car.offroad, onIce);
    // The two nearest other cars get an engine voice.
    const others = view.cars
      .filter((c) => c.present && c.slot !== follow)
      .map((c) => ({ c, d: Math.hypot(c.x - car.x, c.z - car.z) }))
      .sort((a, b) => a.d - b.d);
    for (let i = 0; i < 2; i++) {
      const other = others[i];
      if (!other) {
        this.audio.silenceRemote(i);
        continue;
      }
      const gear = gearForSpeed(other.c.forwardSpeed, this.remoteGears.get(other.c.slot) ?? 1);
      this.remoteGears.set(other.c.slot, gear);
      this.audio.updateRemote(i, rpmForSpeed(other.c.forwardSpeed, gear), other.d);
    }
  }

  // -------------------------------------------------------------- test hook

  /** Read-only state for automated browser tests and debugging in the console. */
  private installTestHook(): void {
    const snapshot = (): Record<string, unknown> => {
      const game = this.game;
      const race = game.race;
      const view = this.lastView;
      return {
        screen: this.screen,
        status: game.connection.status,
        rttMs: game.connection.rttMs,
        name: this.settings.name,
        youId: game.youId,
        isHost: game.isHost,
        room: game.room
          ? {
              code: game.room.code,
              phase: game.room.phase,
              hostId: game.room.hostId,
              members: game.room.members.map((m) => ({ id: m.id, name: m.name, role: m.role, ready: m.ready, connected: m.connected, slot: m.slot, colour: m.colour })),
              results: game.room.results,
            }
          : null,
        publicRooms: game.directory.rooms.map((r) => r.code),
        race: race
          ? {
              raceId: race.race.raceId,
              trackId: race.race.trackId,
              slot: race.slot,
              goTick: race.latest?.goTick ?? race.race.goTick,
              serverTick: race.latest?.tick ?? 0,
              phase: race.latest?.phase ?? -1,
              predicting: race.predicting,
              snapshots: race.stats.snapshots,
              inputsSent: race.stats.inputsSent,
              net: { ...race.stats, maxCorrection: race.predictor.stats.maxCorrection, snaps: race.predictor.stats.snaps, queueDepth: race.queueDepth, delayTicks: race.clock.delayTicks },
              cars: (view?.cars ?? [])
                .filter((c) => c.present)
                .map((c) => ({ slot: c.slot, x: c.x, z: c.z, speed: c.speed, rank: c.rank, cp: c.cp, local: c.isLocal, name: race.race.cars.find((i) => i.slot === c.slot)?.name ?? '' })),
            }
          : null,
      };
    };
    (window as unknown as { __apex: unknown }).__apex = {
      state: snapshot,
      /** Simulates a dropped connection (the client reconnects by itself). */
      dropConnection: () => this.game.connection.simulateDrop(),
      setNetConditions: (text: string) => this.game.connection.setNetConditions(parseNetConditions(text)),
      /**
       * Lets a practice-bot driver steer your car (demo/testing aid). It only
       * produces ordinary inputs; the server still simulates and validates everything.
       */
      autopilot: (on: boolean, skill = 0.8) => {
        if (!on) {
          this.autopilot = null;
          return;
        }
        let driver: BotDriver | null = null;
        let driverRace: RaceClient | null = null;
        const query = makeQuery();
        this.autopilot = (race) => {
          if (driverRace !== race) {
            driverRace = race;
            driver = new BotDriver(race.track, botProfileFor(Math.max(0, race.slot), skill), 4242);
          }
          const state = race.predictor.state;
          const q = queryTrack(race.track, state.x, state.z, query);
          return driver!.compute({ slot: race.slot, state, s: q.s, lat: q.lat }, []);
        };
      },
    };
  }
}

export function mountFatal(root: HTMLElement, title: string, detail: string): void {
  root.appendChild(h('div', { class: 'splash' }, h('div', {}, h('h2', { text: title }), h('p', { class: 'muted', text: detail }))));
}
