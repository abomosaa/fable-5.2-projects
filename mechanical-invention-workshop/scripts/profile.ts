/**
 * Measures solver cost and constraint error for every showcase project on
 * this machine and writes docs/verification/performance.json.
 *   npx tsx scripts/profile.ts
 */
import { cpus, totalmem, platform, release } from 'node:os';
import { mkdirSync, writeFileSync } from 'node:fs';
import { EXAMPLES } from '../src/examples/index';
import { SimRunner } from '../src/core/sim/runner';
import { initKernel } from '../src/core/geom/kernel';
import { buildSolid } from '../src/core/geom/kernel';
import { geometryOf } from '../src/core/model/project';

await initKernel();
const rows: any[] = [];
for (const ex of EXAMPLES) {
  const p = ex.build();
  for (const mode of ['dynamic', 'kinematic'] as const) {
    if (mode === 'kinematic' && p.sim.floor.enabled) continue;     // free-body contact needs dynamics
    const q = { ...p, sim: { ...p.sim, mode } };
    // warm-up (JIT), then measure solver alone and with interference checking
    new SimRunner(q, { interference: false }).advance(300);
    const simT = 5;
    const a = new SimRunner(q, { interference: false });
    const n = Math.round(simT / a.dt);
    let t0 = performance.now();
    a.advance(n);
    const solverMs = performance.now() - t0;
    const b = new SimRunner(q);
    t0 = performance.now();
    b.advance(n);
    const fullMs = performance.now() - t0;
    rows.push({
      project: p.name, mode, dt_ms: a.dt * 1000, steps: a.sim.stepCount, parts: p.parts.length, bodies: a.model.bodies.length, jointEquations: a.sim.mB,
      boundedRowsLast: a.sim.stats.boundedRows, status: a.sim.status,
      solver_ms_per_step: +(solverMs / a.sim.stepCount).toFixed(5), with_interference_ms_per_step: +(fullMs / b.sim.stepCount).toFixed(5),
      realtime_factor_solver_only: +((a.sim.stepCount * a.dt * 1000) / solverMs).toFixed(1),
      max_joint_error_mm: a.sim.stats.maxPosError, max_step_ms: +a.stepTimeMaxMs.toFixed(3), interference_pairs: b.checker?.candidatePairs ?? 0,
    });
  }
  // geometry build cost + scene complexity
  let tris = 0; const t0 = performance.now();
  for (const part of p.parts) { const s = buildSolid(geometryOf(p, { ...part, params: { ...part.params } }).layers); if (s) tris += s.indices.length / 3; }
  rows.push({ project: p.name, mode: 'geometry', parts: p.parts.length, triangles: tris, kernel_build_ms_all_parts: +(performance.now() - t0).toFixed(1) });
}
const hw = { cpu: cpus()[0].model, logicalCores: cpus().length, memoryGB: +(totalmem() / 2 ** 30).toFixed(1), os: `${platform()} ${release()}`, node: process.version, date: new Date().toISOString() };
mkdirSync('docs/verification', { recursive: true });
writeFileSync('docs/verification/performance.json', JSON.stringify({ hardware: hw, note: 'Single-threaded JavaScript, measured by scripts/profile.ts. 5 s of simulated time per run.', rows }, null, 1));
console.log(JSON.stringify(hw));
for (const r of rows) console.log(Object.entries(r).map(([k, v]) => `${k}=${v}`).join('  '));
