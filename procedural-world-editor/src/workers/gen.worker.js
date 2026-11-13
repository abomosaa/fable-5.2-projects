// Background worker for expensive terrain operations: world generation and erosion.
// Work is cut into batches with a macrotask yield between them so a cancel message can arrive.
import { generateTerrain } from '../core/terrainGen.js';
import { hydraulicErosion, thermalErosion } from '../core/erosion.js';

let cancelled = new Set();
const tick = () => new Promise((r) => setTimeout(r, 0));

self.onmessage = async (ev) => {
  const m = ev.data;
  if (m.type === 'cancel') {
    cancelled.add(m.job);
    return;
  }
  const job = m.job;
  try {
    if (m.type === 'generate') {
      // generation is synchronous; progress callbacks post messages, cancellation is checked between phases
      let lastPost = 0;
      const res = generateTerrain(m.params, (phase, f) => {
        const now = performance.now();
        if (now - lastPost > 60) {
          self.postMessage({ type: 'progress', job, phase, f });
          lastPost = now;
        }
        return true;
      });
      const transfer = [res.heights.buffer, res.sediment.buffer, res.ring.data.buffer];
      self.postMessage({ type: 'done', job, result: { heights: res.heights, sediment: res.sediment, ring: res.ring, suggested: res.suggested, params: res.params } }, transfer);
    } else if (m.type === 'erode') {
      const { heights, res, cell, kind, params, rect } = m;
      const sediment = new Float32Array(res * res);
      if (kind === 'hydraulic') {
        const total = params.droplets;
        const batch = 40000;
        for (let s = 0; s < total; s += batch) {
          if (cancelled.has(job)) return self.postMessage({ type: 'cancelled', job });
          hydraulicErosion(heights, res, cell, { ...params, start: s, count: Math.min(batch, total - s), sediment, rect });
          self.postMessage({ type: 'progress', job, phase: 'Hydraulic erosion', f: Math.min(1, (s + batch) / total) });
          await tick();
        }
      } else {
        const total = params.iterations;
        for (let i = 0; i < total; i += 2) {
          if (cancelled.has(job)) return self.postMessage({ type: 'cancelled', job });
          thermalErosion(heights, res, cell, { ...params, iterCount: Math.min(2, total - i), sediment, rect });
          self.postMessage({ type: 'progress', job, phase: 'Thermal erosion', f: Math.min(1, (i + 2) / total) });
          await tick();
        }
      }
      self.postMessage({ type: 'done', job, result: { heights, sediment } }, [heights.buffer, sediment.buffer]);
    }
  } catch (e) {
    self.postMessage({ type: 'error', job, message: e.message, stack: e.stack });
  }
};
