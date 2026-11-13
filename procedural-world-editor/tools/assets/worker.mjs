// Child process used by process.mjs: handles one asset job at a time (keeps peak memory per process bounded).
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { SRC, OUT } from './lib/paths.mjs';
import { processModel } from './lib/model.mjs';
import { processTextureSet } from './lib/texset.mjs';

process.on('message', async (job) => {
  const logs = [];
  const log = (m) => { logs.push(m); if (job.verbose) process.send({ type: 'log', id: job.entry.id, message: m }); };
  try {
    let results;
    const srcDir = path.join(SRC, job.entry.id);
    if (job.kind === 'texture') {
      const outDir = path.join(OUT, 'textures', job.entry.id);
      const info = await processTextureSet(job.entry.id, srcDir, outDir, job.src);
      const files = {}, sha = {}; let bytes = 0;
      for (const role of ['diff', 'nor', 'arm', 'disp']) {
        const rel = `textures/${job.entry.id}/${role}.jpg`;
        const buf = fs.readFileSync(path.join(OUT, rel));
        files[role] = rel; sha[rel] = crypto.createHash('sha256').update(buf).digest('hex'); bytes += buf.length;
      }
      if (info.seam > 1.6) log(`WARNING seam score ${info.seam} (expected <= ~1 for a tileable texture)`);
      results = [{ id: job.entry.id, files, sha256: sha, bytes, ...info }];
    } else {
      results = await processModel(job.entry, job.src, { srcDir, outModels: path.join(OUT, 'models'), log });
    }
    process.send({ type: 'done', id: job.entry.id, results, logs });
  } catch (e) {
    process.send({ type: 'error', id: job.entry.id, error: e.stack ?? String(e), logs });
  }
});
process.send({ type: 'ready' });
