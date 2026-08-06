/**
 * Ticket 012 — the DELETE manifest, enforced.
 *
 * Live collapsed from a multi-arm comparison grid to exactly ONE architecture
 * per session (PRD §17 19g). The identifiers below did not just stop being
 * used — they must be GONE from the client tree, otherwise the next change
 * quietly reintroduces the grid. This is a structural test on purpose: it is
 * the only way the deletion criterion stays true after this ticket.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/** vitest.config.ts pins `root` to the repo root, so cwd is stable here. */
const CLIENT_ROOT = resolve(process.cwd(), 'src/client');

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules') continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      sourceFiles(full, out);
    } else if (/\.(ts|tsx)$/.test(entry)) {
      out.push(full);
    }
  }
  return out;
}

/** Every client source file EXCEPT this guard, which quotes the banned names. */
const FILES = sourceFiles(CLIENT_ROOT).filter((f) => !f.endsWith('deletions.test.ts'));

/**
 * Blanks out comments while preserving line numbering. Prose may explain what
 * was removed and why — the criterion is about CODE, and a header that says
 * "there is no arm catalog any more" is the opposite of a regression.
 */
export function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:])\/\/[^\n]*/g, (_m, lead: string) => lead);
}

/** Every occurrence of `pattern` in client CODE, as 'path:line' strings. */
function hits(pattern: RegExp): string[] {
  const found: string[] = [];
  for (const file of FILES) {
    const lines = stripComments(readFileSync(file, 'utf8')).split('\n');
    lines.forEach((line, i) => {
      if (pattern.test(line)) found.push(`${relative(CLIENT_ROOT, file)}:${i + 1}: ${line.trim()}`);
    });
  }
  return found;
}

describe('the ticket-012 DELETE manifest', () => {
  it('finds source files to scan at all (guards the scanner itself)', () => {
    expect(FILES.length).toBeGreaterThan(20);
    expect(hits(/useSessionController/)).not.toHaveLength(0);
  });

  const forbidden: Array<[string, RegExp]> = [
    ['ARM_CATALOG', /\bARM_CATALOG\b/],
    ['CASCADE_PROVIDERS', /\bCASCADE_PROVIDERS\b/],
    ['ADD_ORDER', /\bADD_ORDER\b/],
    // A vendor that was cut from the product.
    ["'deepgram'", /deepgram/i],
    ['ADD_ARM / REMOVE_ARM', /\b(ADD_ARM|REMOVE_ARM)\b/],
    ['addArm / removeArm', /\b(addArm|removeArm)\b/],
    ['ArmRouter (the fan-out router)', /\bArmRouter\b/],
    ['stopAll (fan-out teardown)', /\bstopAll\b/],
  ];

  for (const [name, pattern] of forbidden) {
    it(`${name} does not appear anywhere under src/client/`, () => {
      expect(hits(pattern)).toEqual([]);
    });
  }

  it('SessionView is gone — the Live view is LiveView', () => {
    expect(hits(/\bSessionView\b/)).toEqual([]);
    expect(FILES.some((f) => f.endsWith('views/LiveView.tsx'))).toBe(true);
    expect(FILES.some((f) => f.endsWith('views/SessionView.tsx'))).toBe(false);
  });

  it('no armId survives on the transport contract or the router', () => {
    for (const file of ['transport/types.ts', 'transport/router.ts']) {
      const source = stripComments(readFileSync(join(CLIENT_ROOT, file), 'utf8'));
      expect(source, `${file} must not carry armId`).not.toMatch(/\barmId\b/);
    }
  });
});
