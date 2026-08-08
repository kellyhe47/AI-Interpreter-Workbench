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
import { readCode, readSource, stripComments } from './testSource';

// Re-exported for the guards that already import it from here. The
// implementation moved to testSource.ts (a NON-test module) so importing it no
// longer re-runs this manifest inside the importing file's suite.
export { stripComments };

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
    // TICKET 047 — Live has no pause state. AGENTS.md: deleted code has no
    // test of its own, so THIS manifest is what keeps it deleted. The action
    // and the prop that carried it are gone from the whole client tree; a
    // dead action is a control someone re-wires later.
    ['togglePlay / onTogglePlay (ticket 047)', /\b(togglePlay|onTogglePlay)\b/],
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

  /* -------------------------------------------------------------------------
   * TICKET 047 — the play/pause glyphs are deleted FROM LIVE ONLY.
   *
   * Deliberately NOT a repo-wide manifest row: `PlayGlyph` is alive and correct
   * in components/replay/RunsList.tsx and components/replay/BlindCompare.tsx.
   * Replay's play control is a different thing — on-demand playback of a STORED
   * run, "nothing autoplays in Replay" (PRD §7). Banning the name everywhere
   * would delete a feature the ticket explicitly protects.
   * ---------------------------------------------------------------------- */
  it('Live carries no play/pause glyph — Replay keeps its own (ticket 047)', () => {
    expect(readCode('src/client/views/LiveView.tsx')).not.toMatch(/\b(PlayGlyph|PauseGlyph)\b/);
    // ...and the ban really is Live-scoped: Replay's control still renders one.
    expect(readCode('src/client/components/replay/RunsList.tsx')).toMatch(/\bPlayGlyph\b/);
  });

  /**
   * TICKET 047 — `PLAY` / `PLAYBACK_ENDED` / `status: 'playing'` are now
   * UNREACHABLE (nothing dispatches PLAY outside tests) and are KEPT ON
   * PURPOSE. `'playing'` staying in the SessionStatus union is what lets
   * LiveView.autoplay.test.tsx pin "no control even in status 'playing'" — the
   * hedge that catches a reintroduction routed through the machine. Deleting
   * the state would delete the trap, so the state is documented, not removed.
   */
  it('the orphaned playback states are RETAINED deliberately, and documented as such', () => {
    const machine = readSource('src/client/state/sessionMachine.ts');
    expect(machine).toMatch(/'playing'/);
    // The retention is explained where the states live, not only in a ticket.
    expect(machine).toMatch(/047/);
  });

  it('no armId survives on the transport contract or the router', () => {
    for (const file of ['transport/types.ts', 'transport/router.ts']) {
      const source = stripComments(readFileSync(join(CLIENT_ROOT, file), 'utf8'));
      expect(source, `${file} must not carry armId`).not.toMatch(/\barmId\b/);
    }
  });
});
