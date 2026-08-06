#!/usr/bin/env node
/**
 * Ticket 017 — export the working store to a dated results bundle.
 *
 * Thin CLI shell over src/harness/exportResults.ts (not unit-tested itself —
 * scripts/ is outside the vitest glob). TypeScript imports require tsx:
 *
 *   npx tsx scripts/export-results.mjs [dataDir] [resultsDir]
 *
 * Prints the bundle path on success; on failure prints a plain message and
 * exits non-zero, leaving data/ untouched so export stays re-runnable.
 *
 * ALL LOGIC LIVES IN THE MODULE. This file resolves two paths, calls
 * `exportResults` once, and maps the outcome to stdout/exit code — nothing
 * here decides what goes in a bundle, so nothing here can be wrong in a way
 * the test suite cannot see.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const { exportResults } = await import('../src/harness/exportResults.ts');

const repoRoot = fileURLToPath(new URL('../', import.meta.url));
const dataDir = path.resolve(process.argv[2] ?? path.join(repoRoot, 'data'));
const resultsDir = path.resolve(process.argv[3] ?? path.join(repoRoot, 'results'));

try {
  const outcome = await exportResults({ dataDir, resultsDir });
  console.log(outcome.message);
  console.log(outcome.bundleDir);
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
}
