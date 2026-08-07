#!/usr/bin/env node
/**
 * Ticket 042 — score the working store's runs for word error rate, post hoc.
 *
 * Thin CLI shell over src/harness/scoreWer.ts (not unit-tested itself —
 * scripts/ is outside the vitest glob). TypeScript imports require tsx:
 *
 *   npx tsx scripts/score-wer.mjs [dataDir]
 *
 * Prints the summary line on success; on failure prints a plain message and
 * exits non-zero. The pass reads the store and APPENDS to wer-scores.jsonl and
 * nothing else, so a failure has rewritten nothing and re-running is always
 * safe — as is running it twice, because last-write-wins is applied on read.
 *
 * ALL LOGIC LIVES IN THE MODULE. This file resolves one path, calls `scoreWer`
 * once, and maps the outcome to stdout/exit code — nothing here decides what
 * gets scored, so nothing here can be wrong in a way the test suite cannot see.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const { scoreWer } = await import('../src/harness/scoreWer.ts');

const repoRoot = fileURLToPath(new URL('../', import.meta.url));
const dataDir = path.resolve(process.argv[2] ?? path.join(repoRoot, 'data'));

try {
  const outcome = await scoreWer({ dataDir });
  console.log(outcome.message);
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
}
