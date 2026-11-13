/** Canvas-drawn point symbols. Shape is the second visual channel next to colour (never colour alone). */
import type { Shape } from '../types';

const SIZE = 48; // drawn at 2× for crisp rendering; registered with pixelRatio 2 → 24 CSS px

function poly(ctx: CanvasRenderingContext2D, pts: [number, number][]): void {
  ctx.beginPath();
  pts.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
  ctx.closePath();
}

function regular(n: number, r: number, rot = -Math.PI / 2): [number, number][] {
  return Array.from({ length: n }, (_, i) => {
    const a = rot + (i * 2 * Math.PI) / n;
    return [SIZE / 2 + r * Math.cos(a), SIZE / 2 + r * Math.sin(a)] as [number, number];
  });
}

export function shapePath(ctx: CanvasRenderingContext2D, shape: Shape): void {
  const c = SIZE / 2;
  switch (shape) {
    case 'circle':
      ctx.beginPath();
      ctx.arc(c, c, 13, 0, Math.PI * 2);
      ctx.closePath();
      break;
    case 'triangle':
      poly(ctx, [[c, 7], [41, 39], [7, 39]]);
      break;
    case 'square':
      poly(ctx, [[10, 10], [38, 10], [38, 38], [10, 38]]);
      break;
    case 'diamond':
      poly(ctx, [[c, 6], [42, c], [c, 42], [6, c]]);
      break;
    case 'hexagon':
      poly(ctx, regular(6, 16, 0));
      break;
    case 'pentagon':
      poly(ctx, regular(5, 16.5));
      break;
    case 'star': {
      const pts: [number, number][] = [];
      for (let i = 0; i < 10; i++) {
        const r = i % 2 === 0 ? 18 : 8;
        const a = -Math.PI / 2 + (i * Math.PI) / 5;
        pts.push([c + r * Math.cos(a), c + r * Math.sin(a)]);
      }
      poly(ctx, pts);
      break;
    }
    case 'cross':
      poly(ctx, [[18, 7], [30, 7], [30, 18], [41, 18], [41, 30], [30, 30], [30, 41], [18, 41], [18, 30], [7, 30], [7, 18], [18, 18]]);
      break;
    case 'plane':
      poly(ctx, [[c, 5], [28, 18], [43, 28], [43, 33], [28, 29], [27, 37], [32, 41], [32, 44], [c, 42], [16, 44], [16, 41], [21, 37], [20, 29], [5, 33], [5, 28], [20, 18]]);
      break;
    case 'ship':
      poly(ctx, [[c, 5], [34, 16], [34, 40], [14, 40], [14, 16]]);
      break;
    case 'satellite':
      poly(ctx, [[17, 17], [31, 17], [31, 21], [44, 21], [44, 27], [31, 27], [31, 31], [17, 31], [17, 27], [4, 27], [4, 21], [17, 21]]);
      break;
  }
}

export function drawIcon(shape: Shape, fill: string, stroke: string): ImageData | null {
  const canvas = document.createElement('canvas');
  canvas.width = SIZE;
  canvas.height = SIZE;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) return null;
  ctx.lineJoin = 'round';
  shapePath(ctx, shape);
  ctx.fillStyle = fill;
  ctx.fill();
  ctx.lineWidth = 3;
  ctx.strokeStyle = stroke;
  ctx.stroke();
  return ctx.getImageData(0, 0, SIZE, SIZE);
}

/** Inline SVG path data for legends (viewBox 0 0 48 48), mirroring shapePath. */
export function shapeSvg(shape: Shape): string {
  const c = 24;
  const pts = (p: [number, number][]) => `M${p.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join('L')}Z`;
  switch (shape) {
    case 'circle':
      return 'M24,11a13,13 0 1,0 0.01,0Z';
    case 'triangle':
      return pts([[c, 7], [41, 39], [7, 39]]);
    case 'square':
      return pts([[10, 10], [38, 10], [38, 38], [10, 38]]);
    case 'diamond':
      return pts([[c, 6], [42, c], [c, 42], [6, c]]);
    case 'hexagon':
      return pts(regular(6, 16, 0));
    case 'pentagon':
      return pts(regular(5, 16.5));
    case 'star': {
      const p: [number, number][] = [];
      for (let i = 0; i < 10; i++) {
        const r = i % 2 === 0 ? 18 : 8;
        const a = -Math.PI / 2 + (i * Math.PI) / 5;
        p.push([c + r * Math.cos(a), c + r * Math.sin(a)]);
      }
      return pts(p);
    }
    case 'cross':
      return pts([[18, 7], [30, 7], [30, 18], [41, 18], [41, 30], [30, 30], [30, 41], [18, 41], [18, 30], [7, 30], [7, 18], [18, 18]]);
    case 'plane':
      return pts([[c, 5], [28, 18], [43, 28], [43, 33], [28, 29], [27, 37], [32, 41], [32, 44], [c, 42], [16, 44], [16, 41], [21, 37], [20, 29], [5, 33], [5, 28], [20, 18]]);
    case 'ship':
      return pts([[c, 5], [34, 16], [34, 40], [14, 40], [14, 16]]);
    case 'satellite':
      return pts([[17, 17], [31, 17], [31, 21], [44, 21], [44, 27], [31, 27], [31, 31], [17, 31], [17, 27], [4, 27], [4, 21], [17, 21]]);
  }
}
