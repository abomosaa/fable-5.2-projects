// Scratch: dump the embedded images of a GLB. usage: node dev/glbimg.mjs <file.glb> <outPrefix>
import fs from 'node:fs';
const [file, out] = process.argv.slice(2);
const b = fs.readFileSync(file);
const jl = b.readUInt32LE(12); const json = JSON.parse(b.toString('utf8', 20, 20 + jl)); const bin = b.subarray(20 + jl + 8);
(json.images ?? []).forEach((im, i) => { const v = json.bufferViews[im.bufferView]; const ext = im.mimeType.split('/')[1]; fs.writeFileSync(`${out}_${i}.${ext}`, bin.subarray(v.byteOffset, v.byteOffset + v.byteLength)); console.log(i, im.mimeType, v.byteLength); });
console.log(json.materials.map((m) => `${m.name} ${m.alphaMode ?? 'OPAQUE'} bc=${m.pbrMetallicRoughness.baseColorTexture?.index}`).join(' | '));
