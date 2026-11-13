/**
 * Procedural textures drawn on 2D canvases. The game ships no image assets.
 */
import * as THREE from 'three';
import { Rng } from '../../../shared/sim/rng';

function canvas(width: number, height: number): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const element = document.createElement('canvas');
  element.width = width;
  element.height = height;
  const ctx = element.getContext('2d');
  if (!ctx) throw new Error('2D canvas is not available');
  return [element, ctx];
}

function finish(element: HTMLCanvasElement, repeat = true, anisotropy = 8): THREE.CanvasTexture {
  const texture = new THREE.CanvasTexture(element);
  texture.colorSpace = THREE.SRGBColorSpace;
  if (repeat) {
    texture.wrapS = THREE.RepeatWrapping;
    texture.wrapT = THREE.RepeatWrapping;
  }
  texture.anisotropy = anisotropy;
  texture.generateMipmaps = true;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  return texture;
}

/** Speckles a canvas with random light/dark dots. */
function speckle(ctx: CanvasRenderingContext2D, w: number, h: number, rng: Rng, count: number, light: string, dark: string, maxSize = 2): void {
  for (let i = 0; i < count; i++) {
    ctx.fillStyle = rng.next() < 0.5 ? light : dark;
    const size = 0.5 + rng.next() * maxSize;
    ctx.fillRect(rng.next() * w, rng.next() * h, size, size);
  }
}

/** Road surface: u runs across the road, v along it. */
export function roadTexture(theme: 'harbor' | 'glacier'): THREE.CanvasTexture {
  const [element, ctx] = canvas(256, 512);
  const rng = new Rng(theme === 'harbor' ? 101 : 202);
  if (theme === 'harbor') {
    ctx.fillStyle = '#33363d';
    ctx.fillRect(0, 0, 256, 512);
    speckle(ctx, 256, 512, rng, 9000, 'rgba(255,255,255,0.05)', 'rgba(0,0,0,0.12)');
    // Rubbered-in racing groove.
    const groove = ctx.createLinearGradient(0, 0, 256, 0);
    groove.addColorStop(0, 'rgba(0,0,0,0)');
    groove.addColorStop(0.35, 'rgba(0,0,0,0.16)');
    groove.addColorStop(0.65, 'rgba(0,0,0,0.16)');
    groove.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = groove;
    ctx.fillRect(0, 0, 256, 512);
    ctx.fillStyle = '#e8e8e8';
    ctx.fillRect(6, 0, 6, 512);
    ctx.fillRect(244, 0, 6, 512);
    ctx.fillStyle = 'rgba(240,240,240,0.85)';
    ctx.fillRect(126, 0, 4, 200);
  } else {
    ctx.fillStyle = '#b9cfe0';
    ctx.fillRect(0, 0, 256, 512);
    // Polished ice streaks along the driving direction.
    for (let i = 0; i < 260; i++) {
      const x = rng.next() * 256;
      const y = rng.next() * 512;
      const length = 30 + rng.next() * 160;
      ctx.strokeStyle = rng.next() < 0.5 ? 'rgba(255,255,255,0.22)' : 'rgba(80,120,160,0.14)';
      ctx.lineWidth = 0.6 + rng.next() * 1.6;
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.lineTo(x + (rng.next() - 0.5) * 8, y + length);
      ctx.stroke();
    }
    speckle(ctx, 256, 512, rng, 5000, 'rgba(255,255,255,0.25)', 'rgba(70,110,150,0.10)');
    const sheen = ctx.createLinearGradient(0, 0, 256, 0);
    sheen.addColorStop(0, 'rgba(255,255,255,0.35)');
    sheen.addColorStop(0.2, 'rgba(255,255,255,0)');
    sheen.addColorStop(0.8, 'rgba(255,255,255,0)');
    sheen.addColorStop(1, 'rgba(255,255,255,0.35)');
    ctx.fillStyle = sheen;
    ctx.fillRect(0, 0, 256, 512);
    ctx.fillStyle = 'rgba(30,90,150,0.55)';
    ctx.fillRect(4, 0, 5, 512);
    ctx.fillRect(247, 0, 5, 512);
  }
  return finish(element, true, 16);
}

export function groundTexture(theme: 'harbor' | 'glacier'): THREE.CanvasTexture {
  const [element, ctx] = canvas(512, 512);
  const rng = new Rng(theme === 'harbor' ? 303 : 404);
  if (theme === 'harbor') {
    ctx.fillStyle = '#4f7d3a';
    ctx.fillRect(0, 0, 512, 512);
    for (let i = 0; i < 90; i++) {
      ctx.fillStyle = rng.next() < 0.5 ? 'rgba(90,140,60,0.25)' : 'rgba(50,90,40,0.25)';
      ctx.beginPath();
      ctx.arc(rng.next() * 512, rng.next() * 512, 20 + rng.next() * 60, 0, Math.PI * 2);
      ctx.fill();
    }
    speckle(ctx, 512, 512, rng, 16000, 'rgba(150,190,90,0.16)', 'rgba(20,50,20,0.18)');
  } else {
    ctx.fillStyle = '#eef3f8';
    ctx.fillRect(0, 0, 512, 512);
    for (let i = 0; i < 70; i++) {
      ctx.fillStyle = rng.next() < 0.5 ? 'rgba(200,215,235,0.35)' : 'rgba(255,255,255,0.5)';
      ctx.beginPath();
      ctx.arc(rng.next() * 512, rng.next() * 512, 20 + rng.next() * 70, 0, Math.PI * 2);
      ctx.fill();
    }
    speckle(ctx, 512, 512, rng, 9000, 'rgba(255,255,255,0.6)', 'rgba(150,175,205,0.2)');
  }
  return finish(element);
}

/** The strip between the road edge and the barrier. */
export function vergeTexture(theme: 'harbor' | 'glacier'): THREE.CanvasTexture {
  const [element, ctx] = canvas(128, 256);
  const rng = new Rng(theme === 'harbor' ? 505 : 606);
  if (theme === 'harbor') {
    ctx.fillStyle = '#5d8a41';
    ctx.fillRect(0, 0, 128, 256);
    // Mown stripes.
    for (let y = 0; y < 256; y += 64) {
      ctx.fillStyle = 'rgba(255,255,255,0.06)';
      ctx.fillRect(0, y, 128, 32);
    }
    speckle(ctx, 128, 256, rng, 3000, 'rgba(170,200,100,0.2)', 'rgba(30,60,25,0.2)');
  } else {
    ctx.fillStyle = '#dbe6f1';
    ctx.fillRect(0, 0, 128, 256);
    speckle(ctx, 128, 256, rng, 2500, 'rgba(255,255,255,0.7)', 'rgba(140,165,195,0.25)', 3);
  }
  return finish(element);
}

export function kerbTexture(): THREE.CanvasTexture {
  const [element, ctx] = canvas(32, 128);
  ctx.fillStyle = '#f2f2f2';
  ctx.fillRect(0, 0, 32, 128);
  ctx.fillStyle = '#d0342c';
  ctx.fillRect(0, 0, 32, 64);
  return finish(element);
}

export function barrierTexture(theme: 'harbor' | 'glacier'): THREE.CanvasTexture {
  const [element, ctx] = canvas(256, 64);
  const rng = new Rng(707);
  if (theme === 'harbor') {
    ctx.fillStyle = '#c9ccd1';
    ctx.fillRect(0, 0, 256, 64);
    speckle(ctx, 256, 64, rng, 1200, 'rgba(255,255,255,0.2)', 'rgba(0,0,0,0.12)');
    // Alternating red and white blocks, like tyre-wall caps.
    for (let x = 0; x < 256; x += 64) {
      ctx.fillStyle = '#c8322b';
      ctx.fillRect(x, 8, 32, 22);
      ctx.fillStyle = '#f4f4f4';
      ctx.fillRect(x + 32, 8, 32, 22);
    }
    ctx.fillStyle = 'rgba(0,0,0,0.25)';
    ctx.fillRect(0, 56, 256, 8);
  } else {
    ctx.fillStyle = '#f4f8fc';
    ctx.fillRect(0, 0, 256, 64);
    speckle(ctx, 256, 64, rng, 900, 'rgba(255,255,255,0.8)', 'rgba(150,180,215,0.3)', 3);
    const shade = ctx.createLinearGradient(0, 0, 0, 64);
    shade.addColorStop(0, 'rgba(120,160,205,0.0)');
    shade.addColorStop(1, 'rgba(120,160,205,0.35)');
    ctx.fillStyle = shade;
    ctx.fillRect(0, 0, 256, 64);
  }
  return finish(element);
}

export function checkerTexture(): THREE.CanvasTexture {
  const [element, ctx] = canvas(128, 32);
  for (let y = 0; y < 2; y++) {
    for (let x = 0; x < 8; x++) {
      ctx.fillStyle = (x + y) % 2 === 0 ? '#f5f5f5' : '#15171c';
      ctx.fillRect(x * 16, y * 16, 16, 16);
    }
  }
  const texture = finish(element, false);
  texture.magFilter = THREE.NearestFilter;
  return texture;
}

export function bannerTexture(text: string, background: string, foreground: string): THREE.CanvasTexture {
  const [element, ctx] = canvas(1024, 128);
  ctx.fillStyle = background;
  ctx.fillRect(0, 0, 1024, 128);
  ctx.fillStyle = 'rgba(255,255,255,0.12)';
  for (let x = -128; x < 1024; x += 96) {
    ctx.beginPath();
    ctx.moveTo(x, 128);
    ctx.lineTo(x + 64, 0);
    ctx.lineTo(x + 96, 0);
    ctx.lineTo(x + 32, 128);
    ctx.fill();
  }
  ctx.fillStyle = foreground;
  ctx.font = 'italic 900 84px system-ui, "Segoe UI", Arial, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text.toUpperCase(), 512, 68, 960);
  return finish(element, false);
}

export function crowdTexture(): THREE.CanvasTexture {
  const [element, ctx] = canvas(256, 64);
  const rng = new Rng(808);
  ctx.fillStyle = '#2a2f3a';
  ctx.fillRect(0, 0, 256, 64);
  const colours = ['#e69f00', '#56b4e9', '#f0e442', '#cc79a7', '#ffffff', '#d55e00', '#009e73'];
  for (let row = 0; row < 6; row++) {
    for (let x = 2; x < 256; x += 6) {
      if (rng.next() < 0.15) continue;
      ctx.fillStyle = rng.pick(colours);
      ctx.fillRect(x + rng.next() * 2, row * 10 + 4, 4, 5);
      ctx.fillStyle = '#e8c9a8';
      ctx.fillRect(x + 1 + rng.next(), row * 10 + 1, 2.5, 3);
    }
  }
  return finish(element);
}

/** A sky dome gradient from zenith to horizon. */
export function skyTexture(top: string, middle: string, horizon: string): THREE.CanvasTexture {
  const [element, ctx] = canvas(16, 512);
  const gradient = ctx.createLinearGradient(0, 0, 0, 512);
  gradient.addColorStop(0, top);
  gradient.addColorStop(0.36, middle);
  gradient.addColorStop(0.5, horizon);
  gradient.addColorStop(1, horizon);
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, 16, 512);
  const texture = new THREE.CanvasTexture(element);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

/** Floating label above a car: number badge plus name. Works without colour. */
export function nameTagTexture(name: string, number: number, colour: number, isBot: boolean): THREE.CanvasTexture {
  const [element, ctx] = canvas(512, 96);
  const hex = `#${colour.toString(16).padStart(6, '0')}`;
  ctx.fillStyle = 'rgba(8,12,24,0.78)';
  ctx.beginPath();
  ctx.roundRect(4, 8, 504, 80, 18);
  ctx.fill();
  ctx.fillStyle = hex;
  ctx.beginPath();
  ctx.roundRect(12, 16, 72, 64, 12);
  ctx.fill();
  ctx.fillStyle = '#0b1020';
  ctx.font = '900 46px system-ui, "Segoe UI", Arial, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(String(number), 48, 50);
  ctx.fillStyle = isBot ? '#b9c2d6' : '#ffffff';
  ctx.font = `${isBot ? 'italic ' : ''}700 40px system-ui, "Segoe UI", Arial, sans-serif`;
  ctx.textAlign = 'left';
  ctx.fillText(name, 100, 50, 396);
  const texture = finish(element, false, 4);
  return texture;
}

/** Roof number decal. */
export function numberTexture(number: number): THREE.CanvasTexture {
  const [element, ctx] = canvas(128, 128);
  ctx.fillStyle = '#ffffff';
  ctx.beginPath();
  ctx.arc(64, 64, 58, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = '#10131c';
  ctx.font = '900 84px system-ui, "Segoe UI", Arial, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(String(number), 64, 70);
  return finish(element, false, 4);
}

/** A soft round dot for point sprites (snowflakes). */
export function dotTexture(): THREE.CanvasTexture {
  const [element, ctx] = canvas(32, 32);
  const gradient = ctx.createRadialGradient(16, 16, 0, 16, 16, 16);
  gradient.addColorStop(0, 'rgba(255,255,255,1)');
  gradient.addColorStop(0.5, 'rgba(255,255,255,0.7)');
  gradient.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, 32, 32);
  const texture = new THREE.CanvasTexture(element);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

/** Chevron arrows for the "next checkpoint" marker. */
export function chevronTexture(): THREE.CanvasTexture {
  const [element, ctx] = canvas(128, 128);
  ctx.clearRect(0, 0, 128, 128);
  ctx.strokeStyle = '#ffffff';
  ctx.lineWidth = 18;
  ctx.lineJoin = 'miter';
  for (const y of [100, 52]) {
    ctx.beginPath();
    ctx.moveTo(20, y);
    ctx.lineTo(64, y - 36);
    ctx.lineTo(108, y);
    ctx.stroke();
  }
  return finish(element, true, 4);
}
