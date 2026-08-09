#!/usr/bin/env node
/**
 * TICKET 060 — THE GATE BEHIND THE COVERAGE CARD'S CITATIONS.
 *
 *   npm run verify-citations      (and `npm run check`, which runs every gate)
 *
 * Reads `src/client/views/coverageCitations.ts` — the same module the Results
 * screen renders, never a copy of the list — and binds every non-null `commit`
 * to reality:
 *
 *   1. `git cat-file -t <hash>` must print exactly `commit`. A hash nobody can
 *      resolve is the fabrication this ticket removed; a hash that resolves to
 *      a tree or a blob is not a citation either.
 *   2. `addedLines` must equal the WHOLE-COMMIT insertion count — every file in
 *      the commit, tests included, no exclusion rule — summed from
 *      `git show --numstat`. Resolving the object only proves it exists; the
 *      diffstat is what binds the object to the change it claims to be, and the
 *      `+N` was invented alongside the hash the last time this card was wrong.
 *   3. `commit: null` must be paired with `addedLines: null`. Absence is not a
 *      zero, and a zero here would read as "it cost nothing".
 *
 * NON-ZERO EXIT ON ANY MISMATCH — the CLI wrapper at the foot of this file
 * turns a non-empty problem list into a failing status code. A script that
 * prints its complaints and then walks away green is not a gate.
 *
 * THIS COMMENT IS NOT THE EVIDENCE. It deliberately does not spell the exit
 * call, so the suite's guard on that call can only be satisfied by the call
 * itself — prose standing in for proof is the very sin this ticket exists to
 * remove, and a header is prose.
 *
 * GIT IS AN INJECTABLE SEAM. `verifyCitations(citations, runGit)` is pure: it
 * decides which git commands to ask for, reads the answers, and RETURNS the
 * list of problems. It never touches a process and never needs a `.git`
 * directory, so the harness unit suite drives every branch through a FAKE
 * `runGit` — including the unresolvable-hash branch, which a real-history run
 * can never reach while the citations are correct. The wrapper below supplies
 * the real one.
 *
 * Anchored on `import.meta.url`, so it behaves identically run from the repo
 * root via npm, from `scripts/`, or from anywhere else.
 */

import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const MODULE_PATH = resolve(REPO_ROOT, 'src/client/views/coverageCitations.ts');
export const MODULE_LABEL = 'src/client/views/coverageCitations.ts';

/**
 * The whole-commit insertion count, summed from `git show --numstat`, which
 * prints `<added>\t<deleted>\t<path>` per file. EVERY row counts — production,
 * tests, fixtures, docs, all of it — because that is the number `git show
 * --stat` reports as "N insertions(+)", and any exclusion rule here would make
 * the module's figures mean something the script's name does not say. Binary
 * files print `-` for both columns and contribute nothing.
 *
 * @param {string} hash
 * @param {(args: readonly string[]) => string} runGit
 * @returns {number}
 */
export function insertionsIn(hash, runGit) {
  const out = runGit(['show', '--numstat', '--format=', hash]);
  let total = 0;
  for (const line of out.split('\n')) {
    const row = line.trim();
    if (row === '') continue;
    const added = row.split('\t')[0];
    if (added === '-') continue;
    const n = Number.parseInt(added, 10);
    if (Number.isNaN(n)) continue;
    total += n;
  }
  return total;
}

/**
 * THE WHOLE GATE, AS A PURE FUNCTION. No process, no filesystem, no `.git`.
 *
 * Failures accumulate so one run reports every bad citation, not just the
 * first, and an unresolvable hash is REPORTED rather than skipped — silently
 * continuing past a hash git cannot name would let the fabrication this ticket
 * removed walk straight back in.
 *
 * @param {unknown} citations the module's `COVERAGE_CITATIONS` export
 * @param {(args: readonly string[]) => string} runGit throws when git would fail
 * @returns {{ problems: string[], log: string[] }} `problems` empty means pass
 */
export function verifyCitations(citations, runGit) {
  /** @type {string[]} */
  const problems = [];
  /** @type {string[]} */
  const log = [];

  if (!Array.isArray(citations)) {
    problems.push(`${MODULE_LABEL} must export COVERAGE_CITATIONS as an array`);
    return { problems, log };
  }

  for (const entry of citations) {
    const where = `${MODULE_LABEL} · "${String(entry.direction)}"`;

    if (entry.commit === null) {
      // The invariant the git checks below cannot see: an unproven claim states
      // no figure at all.
      if (entry.addedLines !== null) {
        problems.push(
          `${where}: commit is null, so addedLines must be null — found ${String(entry.addedLines)}`,
        );
      }
      log.push(`  no commit — nothing claimed  ${entry.direction}`);
      continue;
    }

    if (typeof entry.commit !== 'string' || !/^[0-9a-f]{7,40}$/.test(entry.commit)) {
      problems.push(`${where}: "${String(entry.commit)}" is not an abbreviated SHA git would print`);
      continue;
    }

    let type = '';
    try {
      type = runGit(['cat-file', '-t', entry.commit]).trim();
    } catch {
      problems.push(
        `${where}: git cannot resolve ${entry.commit} — not a valid object name in this repository`,
      );
      continue;
    }
    if (type !== 'commit') {
      problems.push(`${where}: ${entry.commit} resolves to a ${type}, not a commit`);
      continue;
    }

    if (typeof entry.addedLines !== 'number') {
      problems.push(
        `${where}: ${entry.commit} is cited with no addedLines — the dominant term is unverified`,
      );
      continue;
    }

    const actual = insertionsIn(entry.commit, runGit);
    if (actual !== entry.addedLines) {
      problems.push(
        `${where}: ${entry.commit} inserts ${actual} lines, the module claims ${entry.addedLines}` +
          ' (whole-commit insertions, every path counted)',
      );
      continue;
    }

    log.push(`  ok  ${entry.commit}  +${actual} lines  ${entry.direction}`);
  }

  return { problems, log };
}

/** git, from the repo root, with stderr captured rather than leaked. */
function realGit(args) {
  return execFileSync('git', [...args], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

/**
 * THE CLI SHELL. Loads the module, calls the pure function once, prints, and
 * maps a non-empty problem list to a failing status code — nothing here decides
 * what counts as a bad citation, so nothing here can be wrong in a way the
 * suite cannot see.
 */
async function main() {
  const loaded = await import(pathToFileURL(MODULE_PATH).href);
  const { problems, log } = verifyCitations(loaded.COVERAGE_CITATIONS, realGit);

  for (const line of log) console.log(line);

  if (problems.length > 0) {
    console.error(`\n${problems.length} bad citation(s):`);
    for (const problem of problems) console.error(`  ✗ ${problem}`);
    console.error('\nA cited commit is a claim that evidence was gathered. Fix the module.');
    process.exit(1);
  }

  console.log(`\n${log.length} citation(s) verified against git history.`);
}

// Run only as a CLI. Importing this file — which the unit tests do — must load
// the pure function without shelling out to anything.
const invokedPath = process.argv[1];
if (invokedPath !== undefined && import.meta.url === pathToFileURL(invokedPath).href) {
  await main();
}
