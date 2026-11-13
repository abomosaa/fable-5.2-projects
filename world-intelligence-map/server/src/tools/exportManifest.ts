/**
 * Exports the machine-readable source inventory:
 *   docs/sources.manifest.json – every source manifest, verbatim
 *   docs/SOURCES.md            – the same inventory as a readable table (generated; do not edit by hand)
 * Run: npm run manifest
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { ADAPTERS } from '../adapters/registry.ts';
import { adaptersPath, repoRoot } from '../core/paths.ts';
import { DOMAINS } from '../core/types.ts';

const docs = path.join(repoRoot(), 'docs');
mkdirSync(docs, { recursive: true });

/** How the bundled fixture of a source was obtained, from its fixtures/index.json notes. */
function fixtureOrigin(id: string): { kind: 'captured' | 'authored'; capturedAt: string | null; notes: string } {
  const file = path.join(adaptersPath(), id, 'fixtures', 'index.json');
  if (!existsSync(file)) return { kind: 'authored', capturedAt: null, notes: '' };
  const idx = JSON.parse(readFileSync(file, 'utf8')) as { capturedAt?: string; notes?: string };
  const notes = idx.notes ?? '';
  return { kind: /^authored/i.test(notes.trim()) ? 'authored' : 'captured', capturedAt: idx.capturedAt ?? null, notes };
}

const manifests = ADAPTERS.map((a) => ({ adapterVersion: a.version, fixture: fixtureOrigin(a.manifest.id), ...a.manifest }));
writeFileSync(
  path.join(docs, 'sources.manifest.json'),
  JSON.stringify({ generatedBy: 'npm run manifest', sourceCount: manifests.length, layerCount: manifests.reduce((n, m) => n + m.layers.length, 0), domains: DOMAINS, sources: manifests }, null, 2) + '\n',
);

const esc = (s: string) => s.replace(/\|/g, '\\|').replace(/\n/g, ' ');
const dur = (sec: number) => (sec < 3600 ? `${Math.round(sec / 60)} min` : sec < 172800 ? `${Math.round(sec / 3600)} h` : `${Math.round(sec / 86400)} d`);
const lines: string[] = [];
const layers = manifests.flatMap((m) => m.layers);
const keyless = manifests.filter((m) => m.auth.envVars.every((v) => !v.required));
lines.push('# Source inventory', '', '_Generated from the adapter manifests by `npm run manifest` – do not edit by hand._', '');
lines.push(`**${manifests.length} sources · ${layers.length} layers · ${new Set(layers.map((l) => l.domain)).size} domains · ${keyless.length} sources need no credentials.**`, '');
lines.push('Access: 🔓 no credentials · 🔑 credentials required (the source is reported as *not configured* until they are set) · ⏻ opt-in (off until listed in `WIM_ENABLED_SOURCES`).', '');
for (const d of DOMAINS) {
  const inDomain = manifests.filter((m) => m.layers.some((l) => l.domain === d.id));
  if (!inDomain.length) continue;
  lines.push(`## ${d.name}`, '', '| Source (id) | Layers | Access | Poll | Licence / terms | Redistribution | Bundled fixture |', '| --- | --- | --- | --- | --- | --- | --- |');
  for (const m of inDomain) {
    const access = `${m.auth.envVars.some((v) => v.required) ? `🔑 ${m.auth.envVars.filter((v) => v.required).map((v) => `\`${v.name}\``).join(', ')}` : '🔓'}${m.enabledByDefault ? '' : ' ⏻'}`;
    const ls = m.layers.filter((l) => l.domain === d.id).map((l) => `${l.name} (\`${l.id}\`)`).join('<br>');
    lines.push(`| **${esc(m.provider)}** — ${esc(m.dataset)} (\`${m.id}\`) · [docs](${m.documentationUrl}) | ${esc(ls)} | ${access} | ${dur(m.updateCadence.pollIntervalSec)} | [${esc(m.license.name)}](${m.license.url}) | ${m.license.redistribution}${m.license.nonCommercialOnly ? ', **non-commercial only**' : ''} | ${m.fixture.kind === 'authored' ? 'synthetic (authored from the documented schema)' : 'captured sample of the live response'} |`);
  }
  lines.push('');
}
lines.push('## Attribution', '', 'Shown in the application next to every record and in the Sources panel:', '');
for (const m of manifests) lines.push(`- \`${m.id}\`: ${m.attribution}`);
lines.push('', '## Known limitations per source', '');
for (const m of manifests) {
  lines.push(`### ${m.provider} — ${m.dataset} (\`${m.id}\`)`, '');
  lines.push(`- **Coverage:** ${m.coverage.geographic}; ${m.coverage.temporal}`);
  lines.push(`- **Upstream cadence:** ${m.updateCadence.upstream}; polled every ${dur(m.updateCadence.pollIntervalSec)}, flagged stale after ${dur(m.updateCadence.staleAfterSec)}`);
  lines.push(`- **Confidence:** ${m.confidenceNotes}`);
  lines.push(`- **Retention:** ${m.retention.note}`);
  if (m.license.notes) lines.push(`- **Licence notes:** ${m.license.notes}`);
  if (m.auth.setup) lines.push(`- **Setup:** ${m.auth.setup}`);
  if (m.fixture.notes) lines.push(`- **Bundled fixture:** ${m.fixture.notes}`);
  for (const l of m.limitations) lines.push(`- ${l}`);
  lines.push('');
}
writeFileSync(path.join(docs, 'SOURCES.md'), lines.join('\n'));
console.log(`wrote docs/sources.manifest.json and docs/SOURCES.md (${manifests.length} sources, ${layers.length} layers)`);
