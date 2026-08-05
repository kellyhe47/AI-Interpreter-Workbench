#!/usr/bin/env node
/**
 * Ticket 015 — Emit the SYNTHETIC placeholder corpus to corpus/.
 *
 * Thin wrapper over src/harness/{corpus,wav}.ts (not unit-tested itself).
 * TypeScript imports require tsx:
 *
 *   npx tsx scripts/generate-placeholder-corpus.mjs
 *
 * Writes corpus/<id>.wav for all 36 manifest clips plus corpus/manifest.json.
 * Every clip is a tone burst + silence tail (wav.generateClip) — NOT speech.
 * The manifest is marked placeholder so no reported number can come from it.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { buildPlaceholderManifest, validateManifest } from '../src/harness/corpus.ts';
import { generateClip, writeWav } from '../src/harness/wav.ts';
import { SAMPLE_RATE } from '../src/core/protocol.ts';

/** Distinct tone per language so clips are tellable-apart by ear. */
const FREQ_BY_LANG = { en: 440, es: 554, yue: 659 };

const outDir = fileURLToPath(new URL('../corpus/', import.meta.url));

const manifest = buildPlaceholderManifest();
validateManifest(manifest);

await mkdir(outDir, { recursive: true });

for (const clip of manifest.clips) {
  const samples = generateClip({
    durationMs: clip.durationMs,
    speechMs: clip.speechEndMs,
    freq: FREQ_BY_LANG[clip.lang] ?? 440,
    rate: SAMPLE_RATE,
  });
  await writeFile(path.join(outDir, clip.file), writeWav(samples, SAMPLE_RATE));
}

await writeFile(
  path.join(outDir, 'manifest.json'),
  `${JSON.stringify(manifest, null, 2)}\n`,
);

console.log(`wrote ${manifest.clips.length} synthetic clips + manifest.json to ${outDir}`);
