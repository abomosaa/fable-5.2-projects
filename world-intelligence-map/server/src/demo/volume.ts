/**
 * Deterministic high-volume fixture generators. They produce payloads in the exact upstream wire format so the
 * real adapter parser and the whole normalisation path are exercised with tens of thousands of records.
 * The output is synthetic and exists only in fixture mode, where everything is labelled as fixture data.
 */
import { seededRandom } from '../core/text.ts';
import { FIXTURE_EPOCH } from '../core/fixtureEpoch.ts';
import type { FixtureGenerator } from '../http/fixtureTransport.ts';

/** [lon, lat, spreadDeg, weight] – regions where vegetation fires are common, used to make the synthetic pattern plausible. */
const FIRE_REGIONS: [number, number, number, number][] = [
  [22, -8, 7, 16], [28, -14, 6, 10], [15, 8, 6, 9], [32, 9, 5, 7], [-2, 10, 5, 6], [36, -18, 4, 5], [47, -19, 2.5, 3],
  [-55, -10, 8, 14], [-47, -12, 6, 8], [-62, -17, 5, 5], [-60, -28, 5, 3], [-72, 5, 4, 2], [-100, 20, 5, 3], [-120, 39, 3, 2], [-84, 31, 4, 2],
  [102, 18, 5, 7], [106, 13, 4, 4], [113, -1, 5, 5], [102, 0, 4, 3], [76, 30.5, 2, 6], [82, 22, 5, 3], [133, -15, 8, 8], [146, -22, 5, 3],
  [118, 52, 9, 3], [70, 50, 9, 2], [30, 48, 6, 2], [-112, 57, 7, 1], [18, -24, 5, 3], [100, 25, 4, 2],
];

function gaussian(rnd: () => number): number {
  let u = 0;
  let v = 0;
  while (u === 0) u = rnd();
  while (v === 0) v = rnd();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/** NASA FIRMS VIIRS area CSV (documented column set). params: { count } */
export const firmsVolume: FixtureGenerator = (params) => {
  const count = Math.max(1, Number(params.count ?? 40_000));
  const rnd = seededRandom(20261111);
  const totalW = FIRE_REGIONS.reduce((a, r) => a + r[3], 0);
  // sub-clusters ("fire complexes") inside each region so that zooming in reveals structure
  const complexes: [number, number, number][] = [];
  for (const [lon, lat, spread, w] of FIRE_REGIONS) {
    const n = Math.max(3, Math.round((w / totalW) * 900));
    for (let i = 0; i < n; i++) complexes.push([lon + gaussian(rnd) * spread, lat + gaussian(rnd) * spread * 0.7, 0.02 + rnd() * 0.18]);
  }
  const lines: string[] = ['latitude,longitude,bright_ti4,scan,track,acq_date,acq_time,satellite,instrument,confidence,version,bright_ti5,frp,daynight'];
  const day0 = FIXTURE_EPOCH - 2 * 86_400_000;
  const seen = new Set<string>();
  while (lines.length <= count) {
    const c = complexes[Math.floor(rnd() * complexes.length)]!;
    const lat = Math.max(-60, Math.min(72, c[1] + gaussian(rnd) * c[2]));
    let lon = c[0] + gaussian(rnd) * c[2] * 1.2;
    if (lon > 180) lon -= 360;
    if (lon < -180) lon += 360;
    // Sun-synchronous overpasses: ~01:30 and ~13:30 local solar time.
    const night = rnd() < 0.35;
    const dayIdx = Math.floor(rnd() * 2);
    const localHour = (night ? 1.5 : 13.5) + (rnd() - 0.5) * 1.2;
    const utcHour = (((localHour - lon / 15) % 24) + 24) % 24;
    const t = new Date(day0 + dayIdx * 86_400_000);
    const hh = Math.floor(utcHour);
    const mm = Math.floor((utcHour - hh) * 60);
    const acqDate = t.toISOString().slice(0, 10);
    const acqTime = `${String(hh).padStart(2, '0')}${String(mm).padStart(2, '0')}`;
    const la = lat.toFixed(5);
    const lo = lon.toFixed(5);
    const key = `${la},${lo},${acqDate},${acqTime}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const frp = Math.exp(gaussian(rnd) * 0.9 + 1.4);
    const conf = rnd() < 0.08 ? 'l' : rnd() < 0.85 ? 'n' : 'h';
    lines.push(
      `${la},${lo},${(300 + rnd() * 60).toFixed(2)},${(0.38 + rnd() * 0.3).toFixed(2)},${(0.36 + rnd() * 0.3).toFixed(2)},${acqDate},${acqTime},N20,VIIRS,${conf},2.0NRT,${(280 + rnd() * 25).toFixed(2)},${frp.toFixed(2)},${night ? 'N' : 'D'}`,
    );
  }
  return lines.join('\n') + '\n';
};

export const GENERATORS: Record<string, FixtureGenerator> = { 'firms-volume': firmsVolume };
