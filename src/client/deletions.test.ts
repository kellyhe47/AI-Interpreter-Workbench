/**
 * Ticket 012 — the DELETE manifest, enforced.
 *
 * Live collapsed from a multi-arm comparison grid to exactly ONE architecture
 * per session (PRD §17 19g). The identifiers below did not just stop being
 * used — they must be GONE from the client tree, otherwise the next change
 * quietly reintroduces the grid. This is a structural test on purpose: it is
 * the only way the deletion criterion stays true after this ticket.
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { describe, expect, it } from 'vitest';
import { matchingLines, readCode, readSource, stripComments } from './testSource';

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

/* ===========================================================================
 * TICKETS 054 + 058 — THE REPO-LEVEL DELETE MANIFEST.
 *
 * The manifest above is scoped to `src/client/`. Tickets 054 and 058 delete
 * files that live OUTSIDE it — `corpus/`, `benchmark-results/`, two harness
 * modules, three scripts — and both state their criteria as an `rg` over
 * `src/`, `scripts/` and `package.json`. The two are enforced together because
 * 058 deletes the very scripts 054 de-corpuses.
 *
 * TWO TRAPS THIS SECTION IS BUILT AGAINST, both of which have bitten here:
 *
 *  1. A SOURCE SEARCH SATISFIED BY ITS OWN ASSERTION. This file sits inside the
 *     scanned tree, so a test that SPELT a banned name would find itself and
 *     could never go green. Every banned name is therefore ASSEMBLED FROM
 *     FRAGMENTS (the idiom already used in ResultsView.test.tsx), and the walk
 *     does NOT exempt this file — if a literal ever creeps back in, the ban that
 *     names it fails, loudly, here. That is also why the prose in this section
 *     kebab-cases the banned identifiers (`drift-minute-1-to-end`, `heap-start`,
 *     `heap-end`, the bench module) instead of quoting them: a comment is
 *     still text, and `rg` does not care that it was only an explanation.
 *  2. A DELETION TEST THAT PASSES BECAUSE THE PATH WAS ALREADY WRONG. Every
 *     "X is gone" assertion names, in the SAME test, a SIBLING THAT MUST
 *     SURVIVE. A typo'd root cannot satisfy both halves, and the scanner itself
 *     is anchored by a control needle that must keep matching.
 * ======================================================================== */

/** vitest.config.ts pins `root` to the repo root, so cwd is stable here too. */
const REPO_ROOT = resolve(process.cwd());
const CORPUS_DIR = join(REPO_ROOT, 'corpus');

/** Every file under `dir` whose basename matches `keep`, absolute, recursive. */
function filesUnder(dir: string, keep: RegExp, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules') continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) filesUnder(full, keep, out);
    else if (keep.test(entry)) out.push(full);
  }
  return out;
}

/**
 * EXACTLY THE SCOPE BOTH TICKETS WRITE THEIR CRITERIA OVER: `src/`, `scripts/`
 * and `package.json`. Deliberately NOT the whole repo — PRD.md, RUN_LOG.md and
 * the ticket files themselves discuss the deleted names in prose, and a ban that
 * covered them would forbid documenting the deletion.
 */
const SCANNED: readonly string[] = [
  ...filesUnder(join(REPO_ROOT, 'src'), /\.(ts|tsx)$/),
  ...filesUnder(join(REPO_ROOT, 'scripts'), /\.(mjs|cjs|js|ts)$/),
  join(REPO_ROOT, 'package.json'),
];

/**
 * Every occurrence of `needle` in the scanned scope, as 'path:line' strings, so
 * a failure names the offending file instead of asserting a bare boolean.
 * `comments: false` narrows the ban to LIVE CODE — which is precisely how 054
 * words its criterion, and is why an explanatory header may still say what was
 * removed.
 */
function repoHits(needle: string, opts: { comments: boolean }): string[] {
  const found: string[] = [];
  for (const file of SCANNED) {
    const raw = readFileSync(file, 'utf8');
    const text = opts.comments ? raw : stripComments(raw);
    text.split('\n').forEach((line, i) => {
      if (line.includes(needle)) {
        found.push(`${relative(REPO_ROOT, file)}:${i + 1}: ${line.trim()}`);
      }
    });
  }
  return found;
}

/**
 * THE BANNED NAMES, NEVER SPELT OUT. Concatenation is invisible to a text search
 * but not to `String.prototype.includes`, so these needles hunt the repo without
 * being findable in it. `NEEDLE_SHAPE` below pins each one's length and ends so
 * a typo cannot quietly turn a ban into a search for the empty string.
 */
const BANNED = {
  drift: ['drift', 'Minute1', 'ToEnd'].join(''),
  heap_start: 'heap' + 'Start',
  heap_end: 'heap' + 'End',
  bench_module: 'harness/' + 'bench',
  bench_entry: 'run' + 'FixtureBench',
  harness_corpus: 'harness/' + 'corpus',
  corpus_manifest: 'corpus/' + 'manifest',
  generator: 'generate-' + 'placeholder-corpus',
} as const;

/** [needle, expected length, expected first fragment, expected last fragment] */
const NEEDLE_SHAPE: ReadonlyArray<[string, number, string, string]> = [
  [BANNED.drift, 17, 'drift', 'ToEnd'],
  [BANNED.heap_start, 9, 'heap', 'Start'],
  [BANNED.heap_end, 7, 'heap', 'End'],
  [BANNED.bench_module, 13, 'harness/', 'bench'],
  [BANNED.bench_entry, 15, 'run', 'Bench'],
  [BANNED.harness_corpus, 14, 'harness/', 'corpus'],
  [BANNED.corpus_manifest, 15, 'corpus/', 'manifest'],
  [BANNED.generator, 27, 'generate-', 'corpus'],
];

/**
 * A repo-relative path that itself contains a banned substring, spliced so the
 * path can be ASSERTED ON without being FOUND by the very sweep it serves.
 */
function path_(...parts: string[]): string {
  return parts.join('');
}

/** The realness guard 054 must NOT delete alongside the data it guards. */
const PLACEHOLDER_PREFIX_GUARD = /\.startsWith\('placeholder'\)/;

describe('TICKETS 054 + 058 — the scanner itself (non-vacuity guard)', () => {
  it('the walk is ANCHORED: it reaches every tree the two tickets write criteria over', () => {
    // A wrong or empty root is the way a deletion sweep passes for free.
    expect(SCANNED.length).toBeGreaterThan(150);
    expect(SCANNED).toContain(join(REPO_ROOT, 'package.json'));
    expect(SCANNED).toContain(join(REPO_ROOT, 'src', 'client', 'views', 'useSessionController.ts'));
    expect(SCANNED).toContain(join(REPO_ROOT, 'src', 'server', 'routes', 'liveSessions.ts'));
    expect(SCANNED).toContain(join(REPO_ROOT, 'src', 'harness', 'exportResults.ts'));
    expect(SCANNED.some((f) => f.startsWith(join(REPO_ROOT, 'scripts') + sep))).toBe(true);
  });

  it('the READER really reads: control needles that must never stop matching', () => {
    // If `repoHits` returned [] for everything, every ban below would be green
    // and meaningless. These two names are load-bearing project vocabulary and
    // are not going anywhere.
    expect(repoHits('isAggregatable' + 'Run', { comments: true }).length).toBeGreaterThan(5);
    expect(repoHits('corpus' + 'Version', { comments: true }).length).toBeGreaterThan(5);
    // ...and comment-stripping does not blind the reader to code.
    expect(repoHits('isAggregatable' + 'Run', { comments: false }).length).toBeGreaterThan(5);
  });

  it('every banned needle is the string it is supposed to be, assembled', () => {
    for (const [needle, length, head, tail] of NEEDLE_SHAPE) {
      expect(needle).toHaveLength(length);
      expect(needle.startsWith(head), `${head}… must open the needle`).toBe(true);
      expect(needle.endsWith(tail), `…${tail} must close the needle`).toBe(true);
    }
  });
});

describe('TICKET 054 — the placeholder corpus is deleted; the REAL scripts survive', () => {
  it('AC1: every placeholder .wav is gone — and SCRIPTS.md / LIVE-SCRIPT.md are not', () => {
    const entries = existsSync(CORPUS_DIR) ? readdirSync(CORPUS_DIR) : [];
    expect(entries.filter((e) => e.endsWith('.wav'))).toEqual([]);
    // THE SIBLINGS THAT MUST SURVIVE, asserted in the same test on purpose: the
    // recorded takes were read from these two documents, and a `corpus/` that
    // was deleted wholesale (or a mistyped path) fails right here instead of
    // making the line above pass vacuously.
    expect(existsSync(join(CORPUS_DIR, 'SCRIPTS.md')), 'corpus/SCRIPTS.md must survive').toBe(true);
    expect(
      existsSync(join(CORPUS_DIR, 'LIVE-SCRIPT.md')),
      'corpus/LIVE-SCRIPT.md must survive',
    ).toBe(true);
  });

  it('AC1: the placeholder manifest — the only thing between a tone burst and a figure — is gone', () => {
    expect(existsSync(join(CORPUS_DIR, 'manifest.json'))).toBe(false);
    expect(existsSync(join(CORPUS_DIR, 'SCRIPTS.md'))).toBe(true);
  });

  it('AC2/AC4/AC5: the generator and the harness-only corpus module are gone', () => {
    for (const gone of [
      path_('scripts/generate-', 'placeholder-corpus.mjs'),
      path_('src/harness/', 'corpus.ts'),
      path_('src/harness/', 'corpus.test.ts'),
    ]) {
      expect(existsSync(join(REPO_ROOT, gone)), `${gone} must be deleted`).toBe(false);
    }
    // The DIFFERENT validateManifest — the recorded-take one the record flow
    // depends on — is a separate module and stays. "Consolidating" the two is
    // the trap; this pair is what catches it.
    expect(existsSync(join(REPO_ROOT, 'src/core/corpus.ts'))).toBe(true);
    expect(existsSync(join(REPO_ROOT, 'src/core/corpus.test.ts'))).toBe(true);
  });

  it('AC6: src/harness/wav.ts LOOKS placeholder-only and is NOT — it survives with its suite', () => {
    expect(existsSync(join(REPO_ROOT, 'src/harness/wav.ts'))).toBe(true);
    expect(existsSync(join(REPO_ROOT, 'src/harness/wav.test.ts'))).toBe(true);
    // readWav/writeWav are production dependencies of the replay path.
    expect(readCode('src/client/replay/runner.ts') + readCode('src/client/browserDeps.ts')).toMatch(
      /\b(readWav|writeWav)\b/,
    );
  });

  it('AC7: no LIVE CODE names the placeholder manifest, its module, or its generator', () => {
    expect(repoHits(BANNED.corpus_manifest, { comments: false })).toEqual([]);
    expect(repoHits(BANNED.harness_corpus, { comments: false })).toEqual([]);
    expect(repoHits(BANNED.generator, { comments: false })).toEqual([]);
  });

  /**
   * AC8 — THE RULE OUTLIVES THE DATA.
   *
   * The obvious "clean up all the placeholder stuff" sweep rips the
   * `startsWith('placeholder')` guards out alongside the clips. The guard is not
   * about THESE 36 files: it is what stops the NEXT placeholder from reaching a
   * reported figure. Both halves are asserted together so the deletion cannot be
   * bought by weakening the rule.
   */
  it('AC8: deleting the placeholder DATA does not delete the placeholder RULE', () => {
    expect(existsSync(join(CORPUS_DIR, 'manifest.json'))).toBe(false);

    expect(
      matchingLines(readCode('src/client/state/ledger.ts'), PLACEHOLDER_PREFIX_GUARD),
      'isRealRun and isRealRecord must both keep the prefix guard',
    ).toHaveLength(2);
    expect(
      matchingLines(readCode('src/harness/exportResults.ts'), PLACEHOLDER_PREFIX_GUARD),
      'the export bundle must keep its own prefix guard',
    ).toHaveLength(1);
  });

  it('AC8: golden eval 06 still demands that a placeholder-sourced record be EXCLUDED', () => {
    const six = JSON.parse(
      readSource('eval/golden/06-fixture-and-placeholder-never-aggregate.json'),
    ) as {
      given: { records: Array<{ id: string; corpusId?: string }> };
      expect: { must_exclude: Array<{ id: string }>; counts: { samples_admitted: number } };
    };
    const placeholderRecord = six.given.records.find((r) => r.corpusId?.startsWith('placeholder'));
    expect(placeholderRecord, 'the placeholder record must stay in the case').toBeDefined();
    expect(six.expect.must_exclude.map((e) => e.id)).toContain(placeholderRecord!.id);
    expect(six.expect.counts.samples_admitted).toBe(1);
  });
});

describe('TICKET 058 — the fabricated artifacts are deleted', () => {
  it('AC1: benchmark-results/ is gone ENTIRELY — the invented heap figures with it', () => {
    expect(existsSync(join(REPO_ROOT, 'benchmark-results'))).toBe(false);
    // The rule the fabricated file offended against is still on disk: this is
    // the sibling that proves the path root above is right.
    expect(
      existsSync(join(REPO_ROOT, 'eval/golden/06-fixture-and-placeholder-never-aggregate.json')),
    ).toBe(true);
  });

  it('AC2: the bench module, its suite and its two callers are gone; the wired scripts stay', () => {
    for (const gone of [
      path_('src/harness/', 'bench.ts'),
      path_('src/harness/', 'bench.test.ts'),
      'scripts/bench-fixture.mjs',
      'scripts/soak-fixture.mjs',
    ]) {
      expect(existsSync(join(REPO_ROOT, gone)), `${gone} must be deleted`).toBe(false);
    }
    // The scripts that ARE referenced by package.json are untouched.
    expect(existsSync(join(REPO_ROOT, 'scripts/export-results.mjs'))).toBe(true);
    expect(existsSync(join(REPO_ROOT, 'scripts/score-wer.mjs'))).toBe(true);
    expect(existsSync(join(REPO_ROOT, 'src/harness/exportResults.ts'))).toBe(true);
  });

  it('AC2: nothing under src/, scripts/ or package.json names the bench harness — prose included', () => {
    // Comments count here, unlike 054: the ticket names the stale mention in
    // exportResults.ts's header as something to update, and a comment pointing
    // at a module that no longer exists is a reader's dead end.
    expect(repoHits(BANNED.bench_module, { comments: true })).toEqual([]);
    expect(repoHits(BANNED.bench_entry, { comments: true })).toEqual([]);
  });

  it('AC3: drift-minute-1-to-end is gone END-TO-END — type, validator, writer, aggregator, row', () => {
    // One list, every layer: a removal that stops at the type leaves the
    // validator demanding a key nobody sends, which 400s every POST silently.
    expect(repoHits(BANNED.drift, { comments: true })).toEqual([]);
  });

  it('AC4: heap-start / heap-end are gone END-TO-END', () => {
    // Split from drift deliberately: they live in `stability`, touch a
    // different validator block, and have no render row to remove.
    expect(repoHits(BANNED.heap_start, { comments: true })).toEqual([]);
    expect(repoHits(BANNED.heap_end, { comments: true })).toEqual([]);
  });

  it('AC7: the stale 053 worktree is gone — a reviewer must not hit doubled results', () => {
    expect(existsSync(join(REPO_ROOT, '.tdd/worktrees/053'))).toBe(false);
    // The live ticket tree is not what was removed.
    expect(existsSync(join(REPO_ROOT, '.tdd/tickets'))).toBe(true);
  });

  it('AC6: each smoke script is either WIRED to an npm script or deleted — never orphaned', () => {
    const pkg = JSON.parse(readSource('package.json')) as { scripts: Record<string, string> };
    const wired = Object.values(pkg.scripts).join(' ; ');
    // Anchor: the manifest really was parsed, and it really does name scripts.
    expect(wired).toContain('scripts/export-results.mjs');

    for (const rel of ['scripts/smoke-openai.mjs', 'scripts/smoke-elevenlabs.mjs']) {
      const checkedIn = existsSync(join(REPO_ROOT, rel));
      expect(
        checkedIn ? wired.includes(rel) : true,
        `${rel} is checked in but no npm script runs it — wire it or delete it`,
      ).toBe(true);
    }
  });
});
