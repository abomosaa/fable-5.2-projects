/**
 * In-race heads-up display: position, laps, checkpoints, timing and deltas,
 * leaderboard with gaps, minimap, speedometer, start lights, warnings and
 * network status. Every state is conveyed by text or shape as well as colour.
 */
import { CAR_COLORS, MAX_RACERS, SIM_HZ } from '../../../shared/constants';
import { CarFlag, RacePhaseCode } from '../../../shared/protocol/binary';
import type { RaceInfo } from '../../../shared/protocol';
import { checkpointOf, lapOf } from '../../../shared/sim/race';
import type { Track } from '../../../shared/sim/track';
import { gearForSpeed, rpmForSpeed } from '../../../shared/sim/vehicle';
import type { RaceClientEvent, RaceView } from '../net/raceClient';
import { keyLabel, type Settings } from '../storage/settings';
import { clear, colourHex, drawTrackOutline, formatDelta, formatTime, h, icon, ordinal, setText, toggleClass } from './dom';

export type NetQuality = 'good' | 'degraded' | 'bad';

export interface NetStatus {
  quality: NetQuality;
  label: string;
  rttMs: number;
  detail: string;
}

const MAP_SIZE = 420;

export class Hud {
  readonly element: HTMLElement;
  /** Current cosmetic gear and engine speed of the followed car (shared with the audio). */
  gear = 1;
  rpm = 0;

  private readonly position = h('span', { class: 'big', id: 'hud-position', text: '-' });
  private readonly positionOf = h('span', { class: 'of', text: '' });
  private readonly lap = h('span', { class: 'v', id: 'hud-lap', text: '-' });
  private readonly checkpoint = h('span', { class: 'v', id: 'hud-checkpoint', text: '-' });
  private readonly lapTime = h('span', { class: 'v main', id: 'hud-laptime', text: '0:00.000' });
  private readonly lastLap = h('span', { class: 'v', text: '-:--.---' });
  private readonly bestLap = h('span', { class: 'v', text: '-:--.---' });
  private readonly raceTime = h('span', { class: 'v', text: '0:00.000' });
  private readonly gapAhead = h('span', { class: 'v', text: '' });
  private readonly gapBehind = h('span', { class: 'v', text: '' });
  private readonly delta = h('div', { class: 'delta hidden', id: 'hud-delta' });
  private readonly board = h('div', { class: 'board box', id: 'hud-board' });
  private readonly speed = h('span', { class: 'speed', id: 'hud-speed', text: '0' });
  private readonly unit = h('span', { class: 'unit', text: 'KM/H' });
  private readonly gearBox = h('span', { class: 'gear', id: 'hud-gear', text: 'N' });
  private readonly rpmBar = h('i', {});
  private readonly net = h('div', { class: 'net box good', id: 'hud-net' });
  private readonly netText = h('span', { text: '' });
  private readonly netStats = h('div', { class: 'netstats box hidden' });
  private readonly lights = h('div', { class: 'lights box hidden', id: 'hud-lights', role: 'img' });
  private readonly countdown = h('div', { class: 'countdown-num hidden', id: 'hud-countdown' });
  private readonly banners = h('div', { style: { display: 'grid', gap: '0.5rem', justifyItems: 'center' }, id: 'hud-banners' });
  private readonly hints = h('div', { class: 'hints box' });
  private readonly vignette = h('div', { class: 'speed-vignette' });
  private readonly flashLayer = h('div', { class: 'flash' });
  private readonly mapCanvas = h('canvas', {});
  private readonly mapBase = document.createElement('canvas');
  private mapTransform = { scale: 1, offsetX: 0, offsetZ: 0 };
  private readonly spectating = h('div', { class: 'banner info hidden', id: 'hud-spectating' });

  private track: Track | null = null;
  private race: RaceInfo | null = null;
  private settings: Settings;
  private readonly boardRows: HTMLElement[] = [];
  private bannerKey = '';
  private boardKey = '';
  private deltaUntil = 0;
  private flash = 0;
  private goShownUntil = 0;
  private hintsUntil = 0;
  private lastLight = -1;
  private messageUntil = 0;
  private message: { text: string; kind: string } | null = null;
  // Timing bookkeeping (all derived from authoritative checkpoint times).
  private readonly gateTimes: Array<Map<number, number>> = Array.from({ length: MAX_RACERS }, () => new Map());
  private splits: number[] = [];
  private bestSplits: number[] = [];
  private frame = 0;

  constructor(settings: Settings) {
    this.settings = settings;
    this.mapCanvas.width = MAP_SIZE;
    this.mapCanvas.height = MAP_SIZE;
    this.mapBase.width = MAP_SIZE;
    this.mapBase.height = MAP_SIZE;
    for (let i = 0; i < 5; i++) this.lights.appendChild(h('div', { class: 'light' }));
    this.net.append(icon('signal', 15), this.netText);
    this.element = h(
      'div',
      { class: 'hud hidden', id: 'hud' },
      this.vignette,
      this.flashLayer,
      h(
        'div',
        { class: 'hud-tl' },
        h('div', { class: 'box hud-pos' }, this.position, this.positionOf),
        h('div', { class: 'box hud-stats' }, h('span', { class: 'k', text: 'LAP' }), this.lap, h('span', { class: 'k', text: 'CHECKPOINT' }), this.checkpoint),
      ),
      h(
        'div',
        { class: 'hud-tr' },
        h(
          'div',
          { class: 'box timing' },
          h('span', { class: 'k', text: 'LAP TIME' }),
          this.lapTime,
          h('span', { class: 'k', text: 'LAST' }),
          this.lastLap,
          h('span', { class: 'k', text: 'BEST' }),
          this.bestLap,
          h('span', { class: 'k', text: 'RACE' }),
          this.raceTime,
          h('span', { class: 'k', text: 'AHEAD' }),
          this.gapAhead,
          h('span', { class: 'k', text: 'BEHIND' }),
          this.gapBehind,
        ),
        this.delta,
        this.board,
      ),
      h('div', { class: 'hud-center' }, this.spectating, this.lights, this.countdown, this.banners),
      h('div', { class: 'hud-bl' }, this.netStats, h('div', { class: 'box minimap', id: 'hud-minimap' }, this.mapCanvas)),
      h('div', { class: 'hud-br' }, this.net, h('div', { class: 'box speedo' }, h('div', { style: { display: 'grid', justifyItems: 'end' } }, this.speed, this.unit), this.gearBox, h('div', { class: 'rpm' }, this.rpmBar))),
      h('div', { class: 'hud-bottom' }, this.hints),
    );
    this.renderHints();
  }

  setSettings(settings: Settings): void {
    this.settings = settings;
    this.renderHints();
    toggleClass(this.netStats, 'hidden', !settings.netStats);
  }

  private renderHints(): void {
    clear(this.hints);
    const key = (action: keyof Settings['keys']): string => this.settings.keys[action].map(keyLabel).join(' / ') || 'unbound';
    const add = (keys: string, label: string): void => {
      this.hints.appendChild(h('span', {}, h('kbd', { text: keys }), ` ${label}`));
    };
    add(`${key('accelerate')}`, 'accelerate');
    add(`${key('brake')}`, 'brake / reverse');
    add(`${key('left')} ${key('right')}`, 'steer');
    add(key('handbrake'), 'handbrake');
    add(key('reset'), 'reset');
    add(key('camera'), 'camera');
    add(key('pause'), 'menu');
  }

  show(track: Track, race: RaceInfo, spectating: boolean): void {
    this.track = track;
    this.race = race;
    this.mapTransform = drawTrackOutline(this.mapBase, track, { road: '#dfe6ff', edge: '#141a30', line: '#ffb000', padding: 26 });
    for (const map of this.gateTimes) map.clear();
    this.splits = [];
    this.bestSplits = [];
    this.bannerKey = '';
    this.boardKey = '';
    this.deltaUntil = 0;
    this.goShownUntil = 0;
    this.lastLight = -1;
    this.message = null;
    this.gear = 1;
    this.delta.classList.add('hidden');
    this.countdown.classList.add('hidden');
    this.lights.classList.add('hidden');
    clear(this.banners);
    clear(this.board);
    this.boardRows.length = 0;
    toggleClass(this.spectating, 'hidden', !spectating);
    this.hintsUntil = performance.now() + 14_000;
    this.hints.classList.remove('faded');
    toggleClass(this.hints, 'hidden', spectating);
    toggleClass(this.netStats, 'hidden', !this.settings.netStats);
    this.element.classList.remove('hidden');
  }

  hide(): void {
    this.element.classList.add('hidden');
  }

  /** Shows the controls reminder again for a while. */
  showHints(): void {
    this.hintsUntil = performance.now() + 8000;
    this.hints.classList.remove('faded');
  }

  /** A short centre-screen message (lap times, finishing position, ...). */
  announce(text: string, kind: 'good' | 'info' | 'warn' | 'bad' = 'info', durationMs = 2600): void {
    this.message = { text, kind };
    this.messageUntil = performance.now() + durationMs;
    this.bannerKey = '';
  }

  /** Feeds race events so splits and gaps can be tracked. */
  onEvent(event: RaceClientEvent, followSlot: number): void {
    const gates = this.track?.gates.length ?? 1;
    if (event.type === 'checkpoint') {
      this.gateTimes[event.slot]!.set(event.cp, event.ms);
      if (event.slot !== followSlot || event.cp < 1) return;
      const index = checkpointOf(event.cp, gates);
      if (event.cp === 1) {
        this.splits = [];
        return;
      }
      if (index === 0) return; // The lap event carries the lap time.
      const start = this.gateTimes[event.slot]!.get(event.cp - index);
      if (start === undefined) return;
      const split = event.ms - start;
      this.splits[index] = split;
      const best = this.bestSplits[index];
      if (best !== undefined) this.showDelta(split - best);
    } else if (event.type === 'lap' && event.slot === followSlot) {
      const previousBest = this.bestSplits[0];
      if (previousBest !== undefined) this.showDelta(event.ms - previousBest);
      if (event.best || previousBest === undefined) {
        this.bestSplits = [...this.splits];
        this.bestSplits[0] = event.ms;
      }
      this.splits = [];
    }
  }

  private showDelta(ms: number): void {
    const faster = ms <= 0;
    this.delta.className = `delta ${faster ? 'faster' : 'slower'}`;
    // Arrow + sign so the meaning does not depend on colour.
    this.delta.textContent = `${faster ? '▼' : '▲'} ${formatDelta(ms)}`;
    this.delta.title = faster ? 'Faster than your best lap' : 'Slower than your best lap';
    this.deltaUntil = performance.now() + 3500;
  }

  screenFlash(amount: number): void {
    if (!this.settings.reducedMotion) this.flash = Math.max(this.flash, amount);
  }

  update(view: RaceView, followSlot: number, net: NetStatus, netDebug: string, dt: number): void {
    const track = this.track;
    const race = this.race;
    if (!track || !race) return;
    const now = performance.now();
    this.frame++;
    const gates = track.gates.length;
    const car = followSlot >= 0 ? view.cars[followSlot] : undefined;
    const active = view.cars.filter((c) => c.present);

    if (view.localSlot < 0) {
      const name = race.cars.find((c) => c.slot === followSlot)?.name;
      const keys = [...this.settings.keys.left, ...this.settings.keys.right].slice(0, 4).map(keyLabel).join(' / ');
      setText(this.spectating, name ? `Spectating ${name}  -  ${keys || 'steer keys'}: switch car` : 'Spectating');
    }

    // ---- Position, lap, checkpoint.
    if (car?.present) {
      setText(this.position, ordinal(car.rank));
      setText(this.positionOf, `/ ${active.length}`);
      setText(this.lap, `${lapOf(car.cp, gates, race.laps)} / ${race.laps}`);
      setText(this.checkpoint, `${car.cp === 0 ? 0 : checkpointOf(car.cp, gates) + 1} / ${gates}`);
      const finished = (car.flags & CarFlag.FINISHED) !== 0;
      const started = car.cp >= 1;
      const lapMs = finished ? car.lastLapMs : started ? Math.max(0, view.raceMs - car.lapStartMs) : 0;
      setText(this.lapTime, started || finished ? formatTime(Math.max(1, lapMs)) : '0:00.000');
      setText(this.lastLap, formatTime(car.lastLapMs));
      setText(this.bestLap, formatTime(car.bestLapMs));
      setText(this.raceTime, finished ? formatTime(car.finishMs) : view.raceMs > 0 ? formatTime(view.raceMs) : '0:00.000');

      // ---- Speed, gear, rpm.
      const kmh = car.speed * 3.6;
      setText(this.speed, String(Math.round(this.settings.units === 'mph' ? kmh * 0.621371 : kmh)));
      setText(this.unit, this.settings.units === 'mph' ? 'MPH' : 'KM/H');
      this.gear = gearForSpeed(car.forwardSpeed, this.gear);
      this.rpm = car.frozen > 0 ? 0.12 + car.throttle * 0.6 : rpmForSpeed(car.forwardSpeed, this.gear);
      setText(this.gearBox, this.gear < 0 ? 'R' : this.gear === 0 ? 'N' : String(this.gear));
      this.rpmBar.style.transform = `scaleX(${this.rpm.toFixed(3)})`;
      this.vignette.style.opacity = this.settings.reducedMotion ? '0' : String(Math.min(0.9, Math.max(0, (car.speed - 35) / 45)).toFixed(2));
    }

    // ---- Gaps (time between cars at the last checkpoint both have passed).
    if (this.frame % 6 === 0) {
      this.updateBoard(view, followSlot);
      if (car?.present) {
        const ahead = active.find((c) => c.rank === car.rank - 1);
        const behind = active.find((c) => c.rank === car.rank + 1);
        setText(this.gapAhead, ahead ? this.gapText(car.slot, car.cp, ahead.slot, '+') : '-');
        setText(this.gapBehind, behind ? this.gapText(behind.slot, behind.cp, car.slot, '-') : '-');
      }
    }

    if (now > this.deltaUntil) this.delta.classList.add('hidden');

    // ---- Start lights and countdown.
    const counting = view.phase === RacePhaseCode.countdown || view.countdownTicks > 0;
    if (counting && view.hasData) {
      const seconds = view.countdownTicks / SIM_HZ;
      const lit = seconds > 3 ? 0 : Math.min(5, Math.ceil((3 - seconds) / 0.6));
      if (lit !== this.lastLight) {
        this.lastLight = lit;
        this.lights.classList.remove('hidden');
        [...this.lights.children].forEach((node, i) => {
          node.className = `light${i < lit ? ' red' : ''}`;
          node.textContent = i < lit ? '●' : '';
        });
        this.lights.setAttribute('aria-label', `Start lights: ${lit} of 5 red`);
      }
      const whole = Math.ceil(seconds);
      this.countdown.classList.remove('hidden');
      setText(this.countdown, whole > 3 ? 'GET READY' : String(Math.max(1, whole)));
      this.countdown.style.fontSize = whole > 3 ? 'clamp(2rem, 6vw, 3.4rem)' : '';
    } else if (now < this.goShownUntil) {
      this.countdown.classList.remove('hidden');
      this.countdown.style.fontSize = '';
      setText(this.countdown, 'GO!');
      if (this.lastLight !== 99) {
        this.lastLight = 99;
        [...this.lights.children].forEach((node) => {
          node.className = 'light green';
          node.textContent = '▶';
        });
        this.lights.setAttribute('aria-label', 'Start lights: green, go');
      }
    } else {
      this.countdown.classList.add('hidden');
      this.lights.classList.add('hidden');
    }

    // ---- Warning banners. Rebuilt only when the set of banners changes.
    const banners: Array<{ text: string; kind: string; symbol: 'warning' | 'flag' | 'clock' | 'check' }> = [];
    if (this.message && now < this.messageUntil) banners.push({ text: this.message.text, kind: this.message.kind, symbol: this.message.kind === 'good' ? 'check' : 'flag' });
    if (car?.present && view.phase === RacePhaseCode.racing && !(car.flags & CarFlag.FINISHED)) {
      if (car.flags & CarFlag.WRONG_WAY) banners.push({ text: 'Wrong way', kind: 'bad', symbol: 'warning' });
      if (car.flags & CarFlag.MISSED_GATE) banners.push({ text: 'Missed checkpoint - go back', kind: 'bad', symbol: 'warning' });
      if (car.penalty > 0) banners.push({ text: `Penalty - power cut ${(car.penalty / SIM_HZ).toFixed(1)}s`, kind: 'warn', symbol: 'warning' });
      else if (car.offroad > 0.6 && car.speed > 4) banners.push({ text: 'Off track', kind: 'warn', symbol: 'warning' });
      if (car.frozen > 0 && view.countdownTicks === 0) banners.push({ text: 'Resetting to track...', kind: 'info', symbol: 'clock' });
    }
    if (view.endsAtTick > 0 && view.phase === RacePhaseCode.racing) {
      const left = Math.max(0, Math.ceil((view.endsAtTick - view.tick) / SIM_HZ));
      banners.push({ text: `Race ends in ${left}s`, kind: 'info', symbol: 'clock' });
    }
    if (car?.present && car.flags & CarFlag.FINISHED) banners.push({ text: `Finished ${ordinal(car.rank)}`, kind: 'good', symbol: 'flag' });
    if (car?.stale) banners.push({ text: 'Waiting for the server...', kind: 'bad', symbol: 'warning' });
    const key = banners.map((b) => b.text).join('|');
    if (key !== this.bannerKey) {
      this.bannerKey = key;
      clear(this.banners);
      for (const banner of banners) this.banners.appendChild(h('div', { class: `banner ${banner.kind}` }, icon(banner.symbol, 22), banner.text));
    }

    // ---- Network status.
    setText(this.netText, net.rttMs > 0 ? `${net.label} - ${Math.round(net.rttMs)} ms` : net.label);
    this.net.className = `net box ${net.quality}`;
    this.net.title = net.detail;
    if (this.settings.netStats && this.frame % 10 === 0) setText(this.netStats, netDebug);

    if (now > this.hintsUntil) this.hints.classList.add('faded');

    if (this.flash > 0.005) {
      this.flashLayer.style.opacity = this.flash.toFixed(3);
      this.flash *= Math.exp(-dt * 9);
    } else if (this.flash !== 0) {
      this.flash = 0;
      this.flashLayer.style.opacity = '0';
    }

    this.drawMap(view, followSlot);
  }

  /** Called when the lights go out. */
  go(): void {
    this.goShownUntil = performance.now() + 1300;
    this.lastLight = -1;
  }

  /** Time gap between two cars at the furthest checkpoint the trailing one has reached. */
  private gapMs(behindSlot: number, behindCp: number, aheadSlot: number): number | null {
    if (behindCp < 1) return null;
    const mine = this.gateTimes[behindSlot]!.get(behindCp);
    const theirs = this.gateTimes[aheadSlot]!.get(behindCp);
    if (mine === undefined || theirs === undefined) return null;
    return mine - theirs;
  }

  private gapText(behindSlot: number, behindCp: number, aheadSlot: number, sign: '+' | '-'): string {
    const gap = this.gapMs(behindSlot, behindCp, aheadSlot);
    return gap === null ? '-' : `${sign}${(Math.max(0, gap) / 1000).toFixed(2)}s`;
  }

  private updateBoard(view: RaceView, followSlot: number): void {
    const race = this.race;
    if (!race) return;
    const cars = view.cars.filter((c) => c.present).sort((a, b) => a.rank - b.rank);
    const leader = cars[0];
    const parts: string[] = [];
    const rows: Array<{ slot: number; rank: number; name: string; gap: string; colour: number; bot: boolean; flags: number }> = [];
    for (const car of cars) {
      const info = race.cars.find((c) => c.slot === car.slot);
      if (!info) continue;
      let gap = '';
      if (car.flags & CarFlag.FINISHED) gap = formatTime(car.finishMs);
      else if (leader && car !== leader) {
        const ms = this.gapMs(car.slot, car.cp, leader.slot);
        gap = ms === null ? '' : `+${(Math.max(0, ms) / 1000).toFixed(1)}`;
      } else if (car === leader) gap = 'Leader';
      rows.push({ slot: car.slot, rank: car.rank, name: info.name, gap, colour: info.colour, bot: info.isBot, flags: car.flags });
      parts.push(`${car.slot}:${car.rank}:${gap}:${car.flags & (CarFlag.FINISHED | CarFlag.DISCONNECTED)}:${car.slot === followSlot}`);
    }
    const key = parts.join('|');
    if (key === this.boardKey) return;
    this.boardKey = key;
    clear(this.board);
    for (const row of rows) {
      const me = row.slot === view.localSlot;
      this.board.appendChild(
        h(
          'div',
          { class: `board-row${me ? ' me' : ''}${row.slot === followSlot && !me ? ' followed' : ''}`, data: { slot: String(row.slot) } },
          h('span', { class: 'n', text: String(row.rank) }),
          h('span', { class: 'num', text: String(row.slot + 1), style: { background: colourHex(CAR_COLORS[row.colour % CAR_COLORS.length]!) } }),
          h('span', { class: 'nm', text: `${row.name}${row.flags & CarFlag.DISCONNECTED ? ' (offline)' : ''}`, style: { fontStyle: row.bot ? 'italic' : 'normal' } }),
          h('span', { class: 'gap', text: row.gap }),
        ),
      );
    }
  }

  private drawMap(view: RaceView, followSlot: number): void {
    const ctx = this.mapCanvas.getContext('2d');
    const track = this.track;
    const race = this.race;
    if (!ctx || !track || !race) return;
    const { scale, offsetX, offsetZ } = this.mapTransform;
    ctx.clearRect(0, 0, MAP_SIZE, MAP_SIZE);
    ctx.drawImage(this.mapBase, 0, 0);

    // Next checkpoint for the followed car.
    const followed = followSlot >= 0 ? view.cars[followSlot] : undefined;
    if (followed?.present && !(followed.flags & CarFlag.FINISHED)) {
      const gate = track.gates[followed.cp % track.gates.length]!;
      ctx.strokeStyle = '#58e6ff';
      ctx.lineWidth = 5;
      const span = 12;
      ctx.beginPath();
      ctx.moveTo(gate.cx * scale + offsetX + gate.tz * span, gate.cz * scale + offsetZ - gate.tx * span);
      ctx.lineTo(gate.cx * scale + offsetX - gate.tz * span, gate.cz * scale + offsetZ + gate.tx * span);
      ctx.stroke();
    }

    // Draw the followed car last so it is always on top.
    const order = view.cars.filter((c) => c.present).sort((a, b) => Number(a.slot === followSlot) - Number(b.slot === followSlot));
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (const car of order) {
      const info = race.cars.find((c) => c.slot === car.slot);
      if (!info) continue;
      const x = car.x * scale + offsetX;
      const y = car.z * scale + offsetZ;
      const colour = colourHex(CAR_COLORS[info.colour % CAR_COLORS.length]!);
      ctx.save();
      ctx.translate(x, y);
      if (car.slot === followSlot) {
        // The followed car is a large arrow pointing along its heading.
        ctx.rotate(Math.atan2(Math.sin(car.yaw), -Math.cos(car.yaw)));
        ctx.beginPath();
        ctx.moveTo(0, -22);
        ctx.lineTo(15, 16);
        ctx.lineTo(0, 8);
        ctx.lineTo(-15, 16);
        ctx.closePath();
        ctx.fillStyle = colour;
        ctx.strokeStyle = '#ffffff';
        ctx.lineWidth = 3.5;
        ctx.fill();
        ctx.stroke();
      } else {
        // Others are numbered discs (bots are squares).
        ctx.fillStyle = colour;
        ctx.strokeStyle = '#0b1020';
        ctx.lineWidth = 3;
        ctx.beginPath();
        if (info.isBot) ctx.rect(-12, -12, 24, 24);
        else ctx.arc(0, 0, 13.5, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
        ctx.fillStyle = '#0b1020';
        ctx.font = '900 18px system-ui, sans-serif';
        ctx.fillText(String(car.slot + 1), 0, 1);
      }
      ctx.restore();
    }
  }
}
