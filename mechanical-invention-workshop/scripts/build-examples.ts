/**
 * Generates the showcase projects as ordinary project files in
 * public/examples/, using the same authoring operations as the editor.
 *   npx tsx scripts/build-examples.ts
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { EXAMPLES } from '../src/examples/index';
import { serializeProject } from '../src/core/model/project';

const dir = new URL('../public/examples/', import.meta.url).pathname;
mkdirSync(dir, { recursive: true });
const index = [];
for (const ex of EXAMPLES) {
  const p = ex.build();
  writeFileSync(dir + ex.file, serializeProject(p));
  index.push({ id: ex.id, file: ex.file, title: ex.title, blurb: ex.blurb });
  console.log(`${ex.file}: ${p.parts.length} parts, ${p.joints.length} joints, ${p.variants.length} variants`);
}
writeFileSync(dir + 'index.json', JSON.stringify(index, null, 1));
