#!/usr/bin/env node
/**
 * Ticket 015 — Fixture benchmark smoke run.
 *
 * Thin wrapper over src/harness/bench.ts (not unit-tested itself).
 * TypeScript imports require tsx:
 *
 *   npx tsx scripts/bench-fixture.mjs [N]
 *
 * Boots createAppServer on an ephemeral port, runs runFixtureBench over the
 * first N (default 2) clips of corpus/manifest.json with all-fixture
 * providers, and writes benchmark-results/fixture-smoke.json as
 * {PLACEHOLDER: true, records}. PLACEHOLDER:true marks the output as
 * never-reportable (PRD fixtures-never-report rule).
 *
 * Run scripts/generate-placeholder-corpus.mjs first to produce corpus/.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// Must be set before importing src/server/index.ts, which auto-listens on
// the default port unless NODE_ENV === 'test'.
process.env.NODE_ENV = 'test';

const { createAppServer } = await import('../src/server/index.ts');
const { runFixtureBench } = await import('../src/harness/bench.ts');
const { readWav } = await import('../src/harness/wav.ts');
const { validateManifest } = await import('../src/harness/corpus.ts');

const n = Number(process.argv[2] ?? 2);
const corpusDir = fileURLToPath(new URL('../corpus/', import.meta.url));
const outDir = fileURLToPath(new URL('../benchmark-results/', import.meta.url));

const manifest = JSON.parse(await readFile(path.join(corpusDir, 'manifest.json'), 'utf8'));
validateManifest(manifest);

const clips = [];
for (const clip of manifest.clips.slice(0, n)) {
  const bytes = new Uint8Array(await readFile(path.join(corpusDir, clip.file)));
  const { samples } = readWav(bytes);
  clips.push({ id: clip.id, samples, speechEndMs: clip.speechEndMs });
}

const server = createAppServer();
await new Promise((resolve) => server.listen(0, resolve));
try {
  const records = await runFixtureBench({
    server,
    clips,
    providers: { stt: 'fixture', mt: 'fixture', tts: 'fixture' },
    corpusId: manifest.corpusId,
  });
  await mkdir(outDir, { recursive: true });
  const outFile = path.join(outDir, 'fixture-smoke.json');
  await writeFile(outFile, `${JSON.stringify({ PLACEHOLDER: true, records }, null, 2)}\n`);
  console.log(`wrote ${records.length} PLACEHOLDER records to ${outFile}`);
} finally {
  await new Promise((resolve) => server.close(resolve));
}
