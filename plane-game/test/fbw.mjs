import * as T from './lib.mjs';
const name = process.argv[2] || 'fighter';
const base = (await import(`../src/aircraft/${name}.js`)).default;
const variants = JSON.parse(process.argv[3] || '[{}]');
const cases = JSON.parse(process.argv[4] || '[[250,3000,1],[350,3000,1],[450,3000,1],[600,1000,1],[450,3000,0.4],[300,9000,1],[450,3000,-1]]');
for (const v of variants) {
  const def = structuredClone(base); Object.assign(def.controls.fbw, v);
  console.log('variant', JSON.stringify(v));
  for (const [k, alt, stick] of cases) {
    const ac = T.airStart(def, k, alt);
    let maxG = -99, minG = 99, maxA = -9, minA = 9; const tr = [];
    T.run(ac, 5, (t, a) => { a.ctrl.pitch = t > 0.3 ? stick : 0; maxG = Math.max(maxG, a.nz); minG = Math.min(minG, a.nz); maxA = Math.max(maxA, a.alpha); minA = Math.min(minA, a.alpha); if (Math.round(t / T.PHYSICS_DT) % 75 === 0) tr.push(a.nz.toFixed(1)); });
    console.log(`  ${k}kt@${alt} stick=${stick}: G[${minG.toFixed(1)},${maxG.toFixed(1)}] alpha[${T.deg(minA)},${T.deg(maxA)}] ${ac.crashed ? 'CRASH ' + ac.crashed.reason : ''} | ${tr.join(' ')}`);
  }
}
