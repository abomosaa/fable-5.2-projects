// usage: node tools/gltf-validate/validate.mjs <file.glb> [more.glb ...]
// Prints a one-line verdict per file and exits non-zero if any file has validation errors.
import fs from 'node:fs';
import path from 'node:path';
import validator from 'gltf-validator';

let failed = false;
for (const file of process.argv.slice(2)) {
  const data = new Uint8Array(fs.readFileSync(file));
  const report = await validator.validateBytes(data, { uri: path.basename(file), maxIssues: 200 });
  const { numErrors, numWarnings, numInfos, numHints, messages } = report.issues;
  const info = report.info;
  console.log(JSON.stringify({
    file, validatorVersion: report.validatorVersion, errors: numErrors, warnings: numWarnings, infos: numInfos, hints: numHints,
    generator: info.generator, drawCalls: info.drawCallCount, vertices: info.totalVertexCount, triangles: info.totalTriangleCount,
    materials: info.materialCount, hasTextures: info.hasTextures,
    images: (info.resources || []).filter(r => r.image).map(r => `${r.mimeType} ${r.image.width}x${r.image.height}`),
    messages: messages.filter(m => m.severity <= 1).slice(0, 12).map(m => `${m.code} ${m.pointer || ''}: ${m.message}`),
    otherCodes: [...new Set(messages.filter(m => m.severity > 1).map(m => m.code))],
  }));
  if (numErrors > 0) failed = true;
}
process.exit(failed ? 1 : 0);
