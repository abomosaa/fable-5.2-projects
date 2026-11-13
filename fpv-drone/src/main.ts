import { buildMap } from './world/map';
import { Simulation } from './sim/simulation';
import { getPreset } from './sim/params';
import { defaultFcConfig, FlightMode, RcInput } from './sim/fc';
import { View, CameraMode } from './render/view';
import { Input } from './input/input';
import { SimAudio } from './audio/audio';
import { Osd, telemetryText } from './ui/osd';
import { Menu, ApplyKind } from './ui/menu';
import { loadSettings, saveSettings } from './ui/settings';

function boot(): void {
  const settings = loadSettings();
  const viewCanvas = document.getElementById('view') as HTMLCanvasElement;
  const osdCanvas = document.getElementById('osd') as HTMLCanvasElement;
  const telemetryEl = document.getElementById('telemetry') as HTMLElement;
  const menuEl = document.getElementById('menu') as HTMLElement;
  const loadingEl = document.getElementById('loading') as HTMLElement;

  const map = buildMap();
  const preset = getPreset(settings.drone);
  const sim = new Simulation(preset, settings.env, map.collision, defaultFcConfig(preset.tune));
  const pickSpawn = () => map.spawns.find((p) => p.id === settings.spawn) ?? map.spawns[0];
  sim.spawn = pickSpawn();
  sim.gates = map.gates;
  sim.reset();

  let view: View;
  try {
    view = new View(viewCanvas, map);
  } catch (err) {
    loadingEl.innerHTML = '<b>FPV SIM</b>WebGL 2 is not available in this browser.';
    throw err;
  }
  view.setDrone(sim.drone);

  const input = new Input(window);
  input.padConfigs = settings.pads;
  const audio = new SimAudio();
  const osd = new Osd(osdCanvas);

  let paused = true;
  let fps = 60;
  let rcHz = 60;

  const apply = (kind: ApplyKind): void => {
    switch (kind) {
      case 'drone':
        sim.setDrone(getPreset(settings.drone));
        view.setDrone(sim.drone);
        applyFc();
        applySim();
        input.resetThrottle();
        break;
      case 'fc': applyFc(); break;
      case 'env': sim.env.set(settings.env); break;
      case 'graphics':
        if (view.quality !== settings.quality) view.setQuality(settings.quality);
        telemetryEl.style.display = settings.osd.telemetry ? 'block' : 'none';
        break;
      case 'audio': audio.setVolume(settings.volume); break;
      case 'input': input.keyboard.deflection = settings.keyboardDeflection; break;
      case 'sim': applySim(); break;
      case 'spawn':
        sim.spawn = pickSpawn();
        reset();
        break;
    }
  };
  const applyFc = (): void => {
    const c = sim.fc.cfg;
    c.mode = settings.mode;
    c.rates = settings.rates;
    c.throttleMid = settings.throttleMid;
    c.throttleExpo = settings.throttleExpo;
    c.throttleLimit = settings.throttleLimit;
    c.airmode = settings.airmode;
  };
  const applySim = (): void => {
    sim.timeScale = settings.timeScale;
    sim.damage = settings.damage;
    sim.drone.damageEnabled = settings.damage;
  };
  (['fc', 'env', 'graphics', 'audio', 'input', 'sim'] as ApplyKind[]).forEach(apply);

  function reset(): void {
    sim.reset();
    applySim();
    input.resetThrottle();
  }

  const menu = new Menu(menuEl, {
    settings, sim, input, apply, spawns: map.spawns,
    resume: () => setPaused(false),
    reset,
  });

  const setPaused = (p: boolean): void => {
    paused = p;
    if (p) {
      menu.open();
      audio.suspend();
    } else {
      menu.close();
      audio.start();
      audio.resume();
      audio.setVolume(settings.volume);
      // Drop focus from whatever menu control was last used so Space arms instead of re-clicking it.
      (document.activeElement as HTMLElement | null)?.blur?.();
      viewCanvas.focus();
    }
  };

  sim.onEvent = (e, v) => {
    audio.event(e, v);
    if (e === 'lap') osd.message(`LAP ${v.toFixed(2)} s`, 3);
  };
  input.onConfigChange = () => {
    settings.pads = input.padConfigs;
    saveSettings(settings);
  };

  const MODES: FlightMode[] = ['angle', 'horizon', 'acro'];
  const VIEWS: CameraMode[] = ['fpv', 'los', 'chase'];
  const MODE_NAMES: Record<FlightMode, string> = { angle: 'ANGLE MODE', horizon: 'HORIZON MODE', acro: 'ACRO MODE' };
  const VIEW_NAMES: Record<CameraMode, string> = { fpv: 'FPV CAMERA', los: 'LINE OF SIGHT', chase: 'CHASE CAMERA' };
  const SCALES = [0.25, 0.5, 0.75, 1];

  const handleActions = (): void => {
    for (const a of input.takeActions()) {
      if (a === 'menu' || a === 'pause') {
        setPaused(!paused);
        continue;
      }
      if (paused) continue;
      switch (a) {
        case 'armToggle':
          if (sim.fc.armed) sim.disarm();
          else sim.arm();
          break;
        case 'arm': sim.arm(); break;
        case 'disarm': sim.disarm(); break;
        case 'reset': reset(); break;
        case 'mode':
          settings.mode = MODES[(MODES.indexOf(settings.mode) + 1) % MODES.length];
          applyFc();
          osd.message(MODE_NAMES[settings.mode]);
          saveSettings(settings);
          break;
        case 'view':
          settings.view = VIEWS[(VIEWS.indexOf(settings.view) + 1) % VIEWS.length];
          osd.message(VIEW_NAMES[settings.view]);
          saveSettings(settings);
          break;
        case 'turtle':
          if (!sim.crashed) {
            sim.disarm();
            sim.fc.turtle = !sim.fc.turtle;
            osd.message(sim.fc.turtle ? 'TURTLE MODE: ARM, THEN PUSH ROLL/PITCH' : 'TURTLE MODE OFF', 3);
          }
          break;
        case 'osd':
          settings.osd.visible = !settings.osd.visible;
          saveSettings(settings);
          break;
        case 'telemetry':
          settings.osd.telemetry = !settings.osd.telemetry;
          apply('graphics');
          saveSettings(settings);
          break;
        case 'slower':
        case 'faster': {
          let i = SCALES.findIndex((x) => x >= settings.timeScale - 1e-6);
          if (i < 0) i = SCALES.length - 1;
          i = Math.max(0, Math.min(SCALES.length - 1, i + (a === 'faster' ? 1 : -1)));
          settings.timeScale = SCALES[i];
          applySim();
          osd.message(`TIME x${settings.timeScale}`);
          saveSettings(settings);
          break;
        }
      }
    }
  };

  const onResize = (): void => {
    const w = window.innerWidth, h = window.innerHeight;
    view.resize(w, h);
    osd.resize(w, h);
  };
  window.addEventListener('resize', onResize);
  onResize();

  document.addEventListener('visibilitychange', () => {
    if (document.hidden && !paused) setPaused(true);
  });

  // Debug / automation handle (also handy in the browser console).
  const debug: {
    sim: Simulation; view: View; input: Input; settings: typeof settings; map: typeof map;
    setPaused: typeof setPaused; reset: typeof reset; apply: typeof apply; rcOverride: RcInput | null;
  } = { sim, view, input, settings, map, setPaused, reset, apply, rcOverride: null };

  let last = performance.now();
  let telemetryTimer = 0;
  const frame = (now: number): void => {
    requestAnimationFrame(frame);
    const dt = Math.min(0.1, Math.max(0.0005, (now - last) / 1000));
    last = now;
    fps += (1 / dt - fps) * 0.05;

    input.suspended = paused;
    input.poll(dt);
    // Sticks first, so that arming checks see the current throttle position.
    const rc = debug.rcOverride ?? input.rc;
    sim.rc.roll = rc.roll;
    sim.rc.pitch = rc.pitch;
    sim.rc.yaw = rc.yaw;
    sim.rc.throttle = rc.throttle;
    handleActions();
    menu.update();

    if (!paused) {
      // Match the RC smoothing filter to how often new stick samples arrive.
      rcHz += (1 / dt - rcHz) * 0.02;
      const cut = Math.max(12, Math.min(70, rcHz * 0.4));
      if (Math.abs(cut - sim.fc.cfg.rcSmoothingHz) > 3) sim.fc.setRcSmoothing(cut);

      sim.advance(dt);
    }

    view.render(sim, settings.view, paused ? 0 : dt, {
      fov: settings.fov, lens: settings.lens, cameraTilt: settings.cameraTilt, gateMarker: settings.osd.gateMarker,
    });
    osd.draw(sim, settings, settings.view, input.source, fps);
    audio.update(sim, settings.view === 'fpv' ? null : settings.view === 'los' ? map.pilot : view.camera.position, dt);

    if (settings.osd.telemetry) {
      telemetryTimer -= dt;
      if (telemetryTimer <= 0) {
        telemetryTimer = 0.1;
        telemetryEl.textContent = telemetryText(sim);
      }
    }
  };

  (window as unknown as Record<string, unknown>).__fpv = debug;

  loadingEl.remove();
  setPaused(true);
  requestAnimationFrame(frame);
}

// Let the loading screen paint before the (synchronous) world build.
requestAnimationFrame(() => setTimeout(boot, 30));
