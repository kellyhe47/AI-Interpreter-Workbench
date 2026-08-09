/**
 * TICKET 060 — ADVERSARIAL REVIEW, FINDING 2: the citation gate's BEHAVIOUR,
 * not its source text.
 *
 * Before this file the verifier was pinned only by grepping its own source in
 * `ResultsView.test.tsx`, so two mutations survived the whole suite:
 *
 *   - turning the unresolvable-hash `catch` into a silent `continue`, which is
 *     precisely the fabrication ticket 060 exists to catch;
 *   - excluding test paths from the insertion sum via a regex, which slips past
 *     a literal-substring grep and quietly redefines `addedLines`.
 *
 * Both are now executed. `scripts/verify-citations.mjs` exports its logic as
 * `verifyCitations(citations, runGit)` — pure, no process, no `.git` — and
 * everything below drives it through a FAKE `runGit`. That matters twice over:
 * these tests run in a checkout with no history at all, and they can reach the
 * failure branches a real-history run can never reach while the citations in
 * the module are correct.
 *
 * WHY THIS FILE EXISTS AT ALL. Nothing under `src/` covered `scripts/` — the
 * sibling shells (`export-results.mjs`, `score-wer.mjs`) say so in their own
 * headers, and they get away with it because all their logic lives in a
 * `src/harness/*.ts` module that IS tested. This verifier cannot follow that
 * pattern: the suite's locked assertions require the git invocations and the
 * exit call to be readable in `scripts/verify-citations.mjs` itself, so the
 * logic stays there and the test comes to it. `src/harness/` is where this
 * repo's script-adjacent logic is tested, so it lives here.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  MODULE_LABEL,
  insertionsIn,
  verifyCitations,
} from '../../scripts/verify-citations.mjs';

/* ------------------------------------------------------------------ the fake */

interface FakeObject {
  /** What `git cat-file -t` prints. Absent means "commit". */
  type?: string;
  /** What `git show --numstat --format=` prints. */
  numstat?: string;
}

/**
 * A `runGit` that knows only the objects handed to it. An unknown hash THROWS,
 * exactly as `execFileSync` does when git exits non-zero — the seam's whole
 * point is that this branch is reachable without a repository.
 */
function fakeGit(objects: Record<string, FakeObject>) {
  const calls: string[][] = [];
  const runGit = (args: readonly string[]): string => {
    calls.push([...args]);
    if (args[0] === 'cat-file' && args[1] === '-t') {
      const found = objects[args[2] ?? ''];
      if (found === undefined) {
        throw new Error(`fatal: Not a valid object name ${String(args[2])}`);
      }
      return `${found.type ?? 'commit'}\n`;
    }
    if (args[0] === 'show') {
      const found = objects[args[args.length - 1] ?? ''];
      if (found === undefined) throw new Error('fatal: bad object');
      return found.numstat ?? '';
    }
    throw new Error(`unexpected git invocation: git ${args.join(' ')}`);
  };
  return { runGit, calls };
}

/** The module's shape, spelled here so a citation literal reads at a glance. */
function citation(over: {
  direction?: string;
  commit?: string | null;
  addedLines?: number | null;
}) {
  return {
    direction: over.direction ?? 'a claim',
    commit: over.commit ?? null,
    addedLines: over.addedLines ?? null,
    note: 'why this claim is what it is',
  };
}

const HASH = 'a1b2c3d';
const OTHER = 'f0e9d8c';

describe('scripts/verify-citations.mjs — verifyCitations() behaviour, through a fake git', () => {
  it('passes a resolvable commit whose whole-commit insertions match the claim', () => {
    const { runGit } = fakeGit({
      [HASH]: { numstat: '10\t2\tsrc/a.ts\n5\t0\tsrc/b.ts\n' },
    });

    const { problems, log } = verifyCitations(
      [citation({ direction: 'the pair', commit: HASH, addedLines: 15 })],
      runGit,
    );

    expect(problems).toEqual([]);
    expect(log).toEqual([`  ok  ${HASH}  +15 lines  the pair`]);
  });

  it('asks git the two questions the header promises, and no others', () => {
    const { runGit, calls } = fakeGit({ [HASH]: { numstat: '15\t0\tsrc/a.ts\n' } });

    verifyCitations([citation({ commit: HASH, addedLines: 15 })], runGit);

    expect(calls).toEqual([
      ['cat-file', '-t', HASH],
      ['show', '--numstat', '--format=', HASH],
    ]);
  });

  it('REPORTS an unresolvable hash — it is never silently skipped', () => {
    // `deadbee` is the reviewer's fabrication: well-formed, resolves to nothing.
    const { runGit } = fakeGit({});

    const { problems, log } = verifyCitations(
      [citation({ direction: 'invented', commit: 'deadbee', addedLines: 694 })],
      runGit,
    );

    // The count, first: a `catch { continue }` returns zero problems here, and
    // that mutation is the one this file exists to kill.
    expect(problems).toHaveLength(1);
    expect(problems[0]).toBe(
      `${MODULE_LABEL} · "invented": git cannot resolve deadbee — not a valid ` +
        'object name in this repository',
    );
    // ...and it must not also be announced as verified.
    expect(log).toEqual([]);
  });

  it('reports a count mismatch, naming both the real figure and the claim', () => {
    const { runGit } = fakeGit({ [HASH]: { numstat: '657\t3\tsrc/a.ts\n' } });

    const { problems, log } = verifyCitations(
      [citation({ direction: 'off by one', commit: HASH, addedLines: 658 })],
      runGit,
    );

    expect(problems).toHaveLength(1);
    expect(problems[0]).toBe(
      `${MODULE_LABEL} · "off by one": ${HASH} inserts 657 lines, the module claims 658` +
        ' (whole-commit insertions, every path counted)',
    );
    expect(log).toEqual([]);
  });

  it('reports a null commit carrying a non-null addedLines — absence is not a figure', () => {
    const { runGit, calls } = fakeGit({});

    const { problems } = verifyCitations(
      [citation({ direction: 'nothing was built', commit: null, addedLines: 0 })],
      runGit,
    );

    expect(problems).toHaveLength(1);
    expect(problems[0]).toBe(
      `${MODULE_LABEL} · "nothing was built": commit is null, so addedLines must be null — found 0`,
    );
    // A zero is the plausible-looking stand-in this card must never print, and
    // no git question is asked about a claim that cites nothing.
    expect(calls).toEqual([]);
  });

  it('accepts a null commit paired with a null count, and asks git nothing', () => {
    const { runGit, calls } = fakeGit({});

    const { problems, log } = verifyCitations(
      [citation({ direction: 'no mechanism at any price', commit: null, addedLines: null })],
      runGit,
    );

    expect(problems).toEqual([]);
    expect(log).toEqual(['  no commit — nothing claimed  no mechanism at any price']);
    expect(calls).toEqual([]);
  });

  it('reports a hash that resolves to a tree or a blob — existing is not being a commit', () => {
    const { runGit } = fakeGit({ [HASH]: { type: 'blob', numstat: '15\t0\tsrc/a.ts\n' } });

    const { problems } = verifyCitations(
      [citation({ direction: 'a blob', commit: HASH, addedLines: 15 })],
      runGit,
    );

    expect(problems).toEqual([`${MODULE_LABEL} · "a blob": ${HASH} resolves to a blob, not a commit`]);
  });

  it('reports a cited commit with no line count — the dominant term would go unverified', () => {
    const { runGit } = fakeGit({ [HASH]: { numstat: '15\t0\tsrc/a.ts\n' } });

    const { problems } = verifyCitations(
      [citation({ direction: 'half a citation', commit: HASH, addedLines: null })],
      runGit,
    );

    expect(problems).toEqual([
      `${MODULE_LABEL} · "half a citation": ${HASH} is cited with no addedLines — ` +
        'the dominant term is unverified',
    ]);
  });

  it('reports a commit field that is not a SHA git would print', () => {
    const { runGit, calls } = fakeGit({});

    const { problems } = verifyCitations(
      [citation({ direction: 'prose', commit: 'sometime last week', addedLines: 12 })],
      runGit,
    );

    expect(problems).toEqual([
      `${MODULE_LABEL} · "prose": "sometime last week" is not an abbreviated SHA git would print`,
    ]);
    expect(calls).toEqual([]);
  });

  it('accumulates every bad citation in one run, not just the first', () => {
    const { runGit } = fakeGit({ [OTHER]: { numstat: '1\t0\tsrc/a.ts\n' } });

    const { problems } = verifyCitations(
      [
        citation({ direction: 'first', commit: 'deadbee', addedLines: 694 }),
        citation({ direction: 'second', commit: OTHER, addedLines: 99 }),
      ],
      runGit,
    );

    expect(problems).toHaveLength(2);
    expect(problems[0]).toContain('first');
    expect(problems[1]).toContain('second');
  });

  it('reports a COVERAGE_CITATIONS export that is not an array', () => {
    const { runGit } = fakeGit({});

    const { problems } = verifyCitations(undefined, runGit);

    expect(problems).toEqual([`${MODULE_LABEL} must export COVERAGE_CITATIONS as an array`]);
  });
});

describe('scripts/verify-citations.mjs — insertionsIn() sums the WHOLE commit', () => {
  it('counts every path, tests included — there is no exclusion rule', () => {
    // The paths below are deliberately the ones a "production lines only" rule
    // would drop. Their insertions are part of the number the card cites.
    const { runGit } = fakeGit({
      [HASH]: {
        numstat: [
          '100\t4\tsrc/client/views/ResultsView.tsx',
          '200\t0\tsrc/client/views/ResultsView.test.tsx',
          '30\t1\tsrc/core/arms.spec.ts',
          '9\t0\teval/golden.eval.test.tsx',
          '',
        ].join('\n'),
      },
    });

    // 100 + 200 + 30 + 9. Drop any one path and this is not the diffstat.
    expect(insertionsIn(HASH, runGit)).toBe(339);
  });

  it('treats a binary file’s `-` row as contributing nothing, not as NaN', () => {
    const { runGit } = fakeGit({
      [HASH]: { numstat: '12\t0\tsrc/a.ts\n-\t-\tdata/clip.wav\n8\t2\tsrc/b.ts\n' },
    });

    expect(insertionsIn(HASH, runGit)).toBe(20);
  });

  it('sums to zero for a commit that inserts nothing, rather than throwing', () => {
    const { runGit } = fakeGit({ [HASH]: { numstat: '0\t14\tsrc/a.ts\n' } });

    expect(insertionsIn(HASH, runGit)).toBe(0);
  });
});

/* ---------------------------------------------------------------------------
 * TICKET 060 — ADVERSARIAL REVIEW, FINDING 3: a gate nobody is obliged to run.
 *
 * `verify-citations` existed in no aggregate script, so `deadbee`/`+694` in the
 * module gave a fully green `npm test` and `npm run eval`. The logic is covered
 * by `npm test` now that this file exists; the REAL-HISTORY check needs a
 * command that actually invokes it.
 * ------------------------------------------------------------------------- */
describe('TICKET 060 — the citation gate is wired into a command that runs it', () => {
  const pkg = JSON.parse(
    readFileSync(resolve(process.cwd(), 'package.json'), 'utf8'),
  ) as { scripts?: Record<string, string> };

  it('has one aggregate script that runs every declared gate, citations included', () => {
    const check = pkg.scripts?.['check'];
    expect(check).toBeDefined();
    // All four, by name. A "check" that skips one is the hole this closes.
    for (const gate of ['typecheck', 'test', 'eval', 'verify-citations']) {
      expect(check).toContain(`npm run ${gate}`);
    }
    // `&&`, not `;` — a failing gate must stop the run rather than be printed
    // and stepped over, which is Finding 1's sin at the script level.
    expect(check).not.toContain(';');
    expect(check).toContain('&&');
  });

  it('keeps the git-dependent step OUT of build — a build must not need a .git', () => {
    // `build` runs where history is often absent (a container, an unpacked
    // tarball, a shallow checkout). Coupling it to `git cat-file` would fail
    // the build for a reason that has nothing to do with the bundle.
    expect(pkg.scripts?.['build']).toBeDefined();
    expect(pkg.scripts?.['build']).not.toContain('verify-citations');
    expect(pkg.scripts?.['test']).not.toContain('verify-citations');
    expect(pkg.scripts?.['eval']).not.toContain('verify-citations');
  });
});
