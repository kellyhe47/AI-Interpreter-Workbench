/**
 * TICKET 060 — THE COVERAGE CARD'S ONBOARDING-COST CITATIONS, AS DATA.
 *
 * PRD §11 stakes this card on "onboarding cost is proven by commit, not
 * claimed". Until this ticket the card carried three prose strings, two of them
 * citing six-character hashes that resolve to nothing in this repository —
 * `git cat-file -t` answered "Not a valid object name" for both. **A wrong number is
 * an error; a wrong citation is a claim that evidence was gathered when it
 * never was.**
 *
 * THE SHAPE IS THE GUARD. `commit` is a real abbreviated SHA or it is `null`;
 * there is no third state, and a `null` commit forces a `null` line count —
 * absence, never a zero, exactly as every unmeasured figure on this screen.
 * `ResultsView` renders these FIELDS and holds no hash of its own, so the only
 * place a citation can be written is the one place a checked-in gate reads:
 * `scripts/verify-citations.mjs` resolves every non-null `commit` with
 * `git cat-file -t` and checks `addedLines` against the real diffstat.
 *
 * WHICH COMMAND ENFORCES THAT, EXACTLY. `npm run check` — typecheck, then
 * `npm test`, then `npm run eval`, then `npm run verify-citations`, stopping at
 * the first failure. That last step is the only one that touches history, and
 * it is deliberately NOT in `build`: a build must stay runnable where `.git` is
 * absent. `npm test` alone cannot catch an invented hash — it has no history to
 * ask — but it does cover the verifier's own logic, which is unit-tested
 * against a fake git. So: an invented hash survives `npm test`; it does not
 * survive `npm run check`, and neither does a remembered line count attached to
 * a hash that happens to exist.
 *
 * `addedLines` IS THE WHOLE-COMMIT INSERTION COUNT — every file in the commit,
 * tests included, no exclusion rule. That is the number `git show --numstat`
 * sums directly, so the verifier can check it without a convention of its own.
 * A production-only count would read smaller and would mean something the
 * script's name does not say.
 *
 * WHAT THE HONEST NUMBERS SAY, AND IT IS NOT THE OLD STORY. The fabricated
 * tiles claimed a new pair cost a dozen-odd lines and one language constant. It
 * did not. The FIRST additional pair cost two whole commits and the absence
 * of plumbing beneath them: one to give Replay a target-language control at all
 * (`a6ca500`), one to carry the chosen pair to the wire on both arms and both
 * paths (`a57cd3a`). Only the pair AFTER that is cheap — it is one entry in the
 * `pairs` table in `src/client/state/sessionMachine.ts`, and it has not been
 * done, so it cites nothing.
 */

export interface CoverageCitation {
  /** The claim this entry is evidence for, as a reader would name it. */
  direction: string;
  /** A resolvable abbreviated SHA, or `null` when nothing was built. */
  commit: string | null;
  /** Whole-commit insertions from the diffstat, or `null` beside a `null` commit. */
  addedLines: number | null;
  /** What the commit did — or, absent one, why there is nothing to cite. */
  note: string;
}

export const COVERAGE_CITATIONS: readonly CoverageCitation[] = [
  {
    direction: 'English → Cantonese on cascade · making the pair askable',
    commit: 'a6ca500',
    addedLines: 694,
    note:
      'Replay gained a target-language control. Before it no screen could ask ' +
      'for Cantonese, so the pair was unreachable whatever the providers ' +
      'supported. Whole-commit insertions, tests included.',
  },
  {
    direction: 'English → Cantonese on cascade · making the pair reach the wire',
    commit: 'a57cd3a',
    addedLines: 657,
    note:
      'The chosen pair was carried through both arms and both paths, so the ' +
      'request leaving the browser names the language the operator selected. ' +
      'Whole-commit insertions, tests included.',
  },
  {
    // No commit, so no count: this is the claim the fabricated tiles made, told
    // truthfully. It is cheap NOW, and only because the two commits above were
    // paid for first.
    direction: 'The pair after this one, on cascade',
    commit: null,
    addedLines: null,
    note:
      'One entry in the session machine’s pairs table, now that the plumbing ' +
      'above exists. Nobody has done it, so there is no commit to cite and no ' +
      'diffstat to state — and the first pair was never this cheap.',
  },
  {
    direction: 'English → Cantonese on Realtime',
    commit: null,
    addedLines: null,
    note:
      'No mechanism exists at any price. The speech-to-speech model answers a ' +
      'Cantonese request in Mandarin and no parameter changes that, so nothing ' +
      'was built and there is nothing to cite.',
  },
];
