/**
 * Source-reading helpers for the repo's SOURCE-LEVEL GUARDS.
 *
 * Several tickets pin a criterion that only a source scan can hold — "this
 * identifier is DELETED", "no code path suspends Live's audio", "nothing mutes
 * the microphone". Those guards all need the same two primitives, and they used
 * to live in `deletions.test.ts`, which meant every file importing them
 * RE-EXECUTED the ticket-012 DELETE manifest inside its own suite: unrelated
 * failures reported under the wrong file, and a 25-test file ran 36 tests.
 *
 * This module is test infrastructure that is deliberately NOT a `.test` file.
 * It contains no assertions and no suites, so importing it costs nothing.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Blanks out comments while preserving line numbering. Prose may explain what
 * was removed and why — the criterion is about CODE, and a header that says
 * "there is no play/pause control any more" is the opposite of a regression.
 */
export function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:])\/\/[^\n]*/g, (_m, lead: string) => lead);
}

/** A repo-relative source file, verbatim. vitest.config.ts pins `root`. */
export function readSource(relativePath: string): string {
  return readFileSync(resolve(process.cwd(), relativePath), 'utf8');
}

/** A repo-relative source file with its comments blanked out. */
export function readCode(relativePath: string): string {
  return stripComments(readSource(relativePath));
}

/**
 * Every line of `code` matching `pattern`, trimmed. Guards assert on the LIST
 * rather than on a boolean so a failure names the offending line, and so an
 * exemption can be expressed as an exact-equality allow-list instead of a
 * regex hole that anything else can slip through.
 */
export function matchingLines(code: string, pattern: RegExp): string[] {
  return code
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => pattern.test(line));
}
