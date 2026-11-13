/**
 * Developer tool: prints a geometry report for every track and writes a
 * top-down SVG preview. Usage: `npx tsx scripts/track-preview.ts [outDir]`.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { analyseTrack, type Track } from '../shared/sim/track';
import { TRACK_DEFS, getTrack } from '../shared/sim/tracks';

function offsetPath(track: Track, lat: number): string {
  const parts: string[] = [];
  for (let i = 0; i <= track.n; i++) {
    const k = i % track.n;
    const x = track.px[k]! + track.tz[k]! * lat;
    const z = track.pz[k]! - track.tx[k]! * lat;
    parts.push(`${i === 0 ? 'M' : 'L'}${x.toFixed(1)} ${z.toFixed(1)}`);
  }
  return parts.join(' ') + ' Z';
}

function toSvg(track: Track): string {
  const b = track.bounds;
  const w = b.maxX - b.minX;
  const h = b.maxZ - b.minZ;
  const gates = track.gates
    .map(
      (g) =>
        `<line x1="${g.ax.toFixed(1)}" y1="${g.az.toFixed(1)}" x2="${g.bx.toFixed(1)}" y2="${g.bz.toFixed(1)}" stroke="${g.index === 0 ? '#fff' : '#fc0'}" stroke-width="1.5"/>` +
        `<text x="${g.cx.toFixed(1)}" y="${(g.cz - 16).toFixed(1)}" fill="#fc0" font-size="12">${g.index}</text>`,
    )
    .join('');
  const grid = track.grid.map((p) => `<circle cx="${p.x.toFixed(1)}" cy="${p.z.toFixed(1)}" r="1.2" fill="#0f0"/>`).join('');
  const ctrl = track.def.points
    .map((p, i) => `<circle cx="${p[0]}" cy="${p[1]}" r="2" fill="#f0f"/><text x="${p[0] + 4}" y="${p[1] + 4}" fill="#f0f" font-size="9">${i}</text>`)
    .join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${b.minX} ${b.minZ} ${w} ${h}" width="${Math.round(w * 2)}" height="${Math.round(h * 2)}">
<rect x="${b.minX}" y="${b.minZ}" width="${w}" height="${h}" fill="#1c2b1c"/>
<path d="${offsetPath(track, 0)}" fill="none" stroke="#555" stroke-width="${track.wallDist * 2}" stroke-linejoin="round"/>
<path d="${offsetPath(track, 0)}" fill="none" stroke="#333" stroke-width="${track.halfWidth * 2}" stroke-linejoin="round"/>
<path d="${offsetPath(track, 0)}" fill="none" stroke="#999" stroke-width="0.4" stroke-dasharray="3 3"/>
${gates}${grid}${ctrl}
</svg>`;
}

const outDir = process.argv[2] ?? 'track-previews';
mkdirSync(outDir, { recursive: true });
for (const def of TRACK_DEFS) {
  const track = getTrack(def.id);
  const report = analyseTrack(track);
  console.log(
    `${def.id}: length=${report.length.toFixed(0)}m minRadius=${report.minRadius.toFixed(1)}m (wall ${track.wallDist}m) ` +
      `minSeparation=${report.minSeparation.toFixed(1)}m (needs > ${(track.wallDist * 2 + 4).toFixed(1)}m) startStraight=${report.startStraight.toFixed(0)}m`,
  );
  writeFileSync(join(outDir, `${def.id}.svg`), toSvg(track));
}
