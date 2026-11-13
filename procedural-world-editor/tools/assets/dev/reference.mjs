// Scratch: write an (almost) undecimated GLB of one variant as a visual reference for judging LODs.
// usage: node dev/reference.mjs <id> <variantIndex> <outDir> [budget]
import path from 'node:path'; import fs from 'node:fs';
import { MODELS } from '../catalog.mjs';
import { SRC, LOCK } from '../lib/paths.mjs';
import { processModel } from '../lib/model.mjs';
const [id, vi, outDir, budget = '1500000'] = process.argv.slice(2);
const lock = JSON.parse(fs.readFileSync(LOCK, 'utf8'));
const entry = { ...MODELS.find((m) => m.id === id), only: [+vi], budgets: [+budget], cards: [false], barkShare: [0.1], maxGeomScale: [1] };
const r = await processModel(entry, lock.assets[id], { srcDir: path.join(SRC, id), outModels: outDir, log: console.log });
console.log(r.map((x) => `${x.id}: ${x.lods[0].triangles} tris ${(x.bytes / 1e6).toFixed(1)} MB`).join('\n'));
