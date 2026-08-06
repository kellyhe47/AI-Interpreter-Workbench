#!/usr/bin/env node
/**
 * Ticket 017 — export the working store to a dated results bundle (STUB).
 *
 * Thin CLI shell over src/harness/exportResults.ts (not unit-tested itself —
 * scripts/ is outside the vitest glob). TypeScript imports require tsx:
 *
 *   npx tsx scripts/export-results.mjs [dataDir] [resultsDir]
 *
 * Prints the bundle path on success; on failure prints a plain message and
 * exits non-zero, leaving data/ untouched so export stays re-runnable.
 */
throw new Error('not implemented');
