---
id: 060
title: The coverage card cites two commit hashes that do not exist — the app displays fabricated evidence
status: done
source: spec-audit + qa
depends_on: []
touches: [src/client/views/ResultsView.tsx, src/client/views/coverageCitations.ts, scripts/verify-citations.mjs, package.json]
iterations: 1
test_files: []
branch: main
---

## Observed — verified

`src/client/views/ResultsView.tsx:653-654` hardcodes, and the Results screen renders:

```
Spanish → English on cascade · commit a4f21c · +11 lines · one language constant
English → Cantonese on cascade · commit 9d0e77 · +14 lines · one voice id per direction
```

```
$ git cat-file -t a4f21c   → fatal: Not a valid object name a4f21c
$ git cat-file -t 9d0e77   → fatal: Not a valid object name 9d0e77
```

**Neither hash exists in this repository.**

PRD §11 stakes this card on *"onboarding cost is proven by commit, not claimed."* The card is badged
`illustrative`, so it is not presented as a measured experiment — but the specific mechanism the PRD
promised as proof is fabricated. **A wrong number is an error; a wrong citation is a claim that
evidence was gathered when it never was.**

This escalated when the Cantonese track was kept: the coverage card became a real deliverable
answering two of the brief's named Key Impact Metrics — *provider flexibility* and *time-to-onboard
a new language pair*.

## Acceptance criteria

- [ ] The card's citations live in a **typed data module** — an exported array of
      `{ direction, commit: string | null, addedLines: number | null, note }` — not free-text
      prose inside `ResultsView.tsx`. The view renders fields; it never contains a hash literal.
      *(split from the old "a guard makes an unresolvable hash impossible to ship" — this is the
      structural half)*
- [ ] A checked-in script (`scripts/verify-citations.mjs`, wired as an npm script) reads that module
      and, for each entry with a non-null `commit`, asserts `git cat-file -t <hash>` prints `commit`
      and that `addedLines` equals the real diffstat insertion count. Non-zero exit on any mismatch.
      *(the old criterion "a guard makes an unresolvable hash impossible to ship" was not falsifiable
      — "something checks them" names no artifact and no failure mode; this replaces it)*
- [ ] A unit test asserts the invariant the script cannot: **an entry with `commit: null` must have
      `addedLines: null`**, and the renderer emits no digits for it. Lands in
      `src/client/views/ResultsView.test.tsx`. *(this is the testable form of "renders no digits")*
- [ ] `a4f21c` and `9d0e77` no longer appear anywhere in `src/` — verified by grep in the same test
- [ ] A tile with `commit: null` renders its `note` and the word `illustrative` stays on the card;
      it carries no `+N lines` and no hash-shaped string
- [ ] `src/client/views/ResultsView.test.tsx:587-589` — which currently PINS `commit a4f21c` /
      `+11 lines` / `commit 9d0e77` — is updated in the same change, or the suite is red for the
      wrong reason

> already satisfied: *"the card is not presented as a measured experiment"* — `CoverageCard` passes
> `illustrative` (`src/client/views/ResultsView.tsx:660`), the pill renders at `:348-351`, and it is
> pinned by `src/client/views/ResultsView.test.tsx:310-315`.

> removed: *"the real EN↔YUE onboarding diff replaces the invented one once that work is done"* —
> conditional on unscheduled future work, so it can never fail. The `commit: null` /
> `addedLines: null` path above is what covers this ticket's obligation today.

## Out of scope

- Doing the EN↔YUE onboarding work itself, or producing a commit to cite.
- The coverage matrix rows (`COVERAGE_ROWS`, `src/client/views/ResultsView.tsx:625-649`), the
  observation note, and the provenance line — all separately correct and untouched.
- Any experiment, category, or By Recording card.

## Notes
- The honest version of this card is trivially derivable from actual history — the work it describes
  either happened in a commit or it did not.
- Golden eval `eval/golden/10-onboarding-cost-cites-a-real-commit.json`.

## CONTEXT FOR A FRESH AGENT

### 1-2. Verified citations, with the code

**The fabricated data.** `src/client/views/ResultsView.tsx:652-656` (VERIFIED at this revision):

```ts
const TIME_TO_ADD: readonly string[] = [
  'Spanish → English on cascade · commit a4f21c · +11 lines · one language constant',
  'English → Cantonese on cascade · commit 9d0e77 · +14 lines · one voice id per direction',
  'English → Cantonese on Realtime · no mechanism exists at any price',
];
```

Three prose strings. There is no `commit` field, no `lines` field, and nothing type-level that
could distinguish a real hash from an invented one.

**Where it renders.** `src/client/views/ResultsView.tsx:702-716` — a bare `.map` over the strings,
each into a `<div data-time-to-add="">{tile}</div>`. The card wrapper is
`<Card card="coverage" … illustrative>` at `:660`; the `illustrative` pill is emitted at `:348-351`.

**The DOM contract** is documented in the file header: `[data-illustrative]` at
`src/client/views/ResultsView.tsx:71`, `[data-direction="<slug>"]` at `:80`.

**YOU MUST NOT RUN GIT IN THIS TICKET'S RESEARCH PHASE — but the IMPLEMENTING agent must.**
Hashes cannot be resolved from the file tree. The implementing agent resolves each candidate with
`git cat-file -t <hash>` (expect the literal output `commit`) and derives `+N lines` from
`git show --numstat <hash>` / `git diff --shortstat`. `a4f21c` and `9d0e77` are already known to
fail this (`fatal: Not a valid object name`); do not attempt to "find the right hash" for them —
absent the real work, the correct value is `null`.

**Where the script goes.** `scripts/` currently holds `bench-fixture.mjs`, `export-results.mjs`,
`generate-placeholder-corpus.mjs`, `score-wer.mjs`, `smoke-elevenlabs.mjs`, `smoke-openai.mjs`,
`soak-fixture.mjs`. `package.json` scripts already follow the `"export-results": "tsx
scripts/export-results.mjs"` shape — add `"verify-citations"` the same way.

### 3. Where the tests must land

STANDING POLICY — no new test file may be added to a module that already has one.
**This ticket's tests land in `src/client/views/ResultsView.test.tsx`.** That file already owns the
coverage card (`describe` at `:546`, the time-to-add test at `:577-590`) and already pins the two
fabricated hashes at `:587-589` — those exact assertions must be rewritten, not duplicated
elsewhere. Do NOT create `ResultsView.coverage.test.tsx` or `citations.test.ts`.

The ten sibling files (`ResultsView.cost/category/wer/hydration/liveAnchor/fixtureLive.test.tsx`)
are pre-existing per-concern splits; they do not license a new one.

### 4. Seams

This card takes **no props and reads no ledger** — `function CoverageCard(): ReactElement` at
`src/client/views/ResultsView.tsx:657`. It renders from module constants only, so the test needs no
deps bag, no `hydrationFixtures`, and no server. `renderView(ledger)` /
`card('coverage')` helpers already exist in `ResultsView.test.tsx` (~`:119`).

Relevant but NOT needed here: `src/client/browserDeps.ts` (`BrowserDeps extends SessionDeps` ~`:94`),
`src/client/state/hydrationFixtures.ts`, `src/client/components/results/testRecords.ts`.
jsdom has no `AudioContext` / `MediaStream` / `RTCPeerConnection`; this card touches none of them.

### 5. Golden eval

`eval/golden/10-onboarding-cost-cites-a-real-commit.json` — `surface: "dom"`,
`result_type: "coverage_tile"`, `must_include: ["commit_resolves_in_repo",
"line_count_matches_diff"]`, `on_unresolvable: { "render": "illustrative", "digits_rendered": 0 }`.
Note `digits_rendered: 0` is literal: an unresolvable tile carries **no numerals at all**.

### 6. Traps — this ticket specifically

- **ACUTE (DOM ticket): a test that compares a render against itself.** RTL *appends* to
  `document.body` and every accessor here is `document.querySelector` (`card()` helper,
  `ResultsView.test.tsx` ~`:119`). Two `render()` calls in one `it()` leave both trees mounted and
  `querySelectorAll('[data-time-to-add]')` then returns SIX tiles, not three — a length assertion
  written against that is comparing one render to itself. One render per test.
- **A fix that satisfies the seam while production has zero callers.** Creating the typed citations
  module and its verifier script while `ResultsView.tsx` keeps its own string literals is the exact
  failure mode. Assert the rendered DOM comes from the module (e.g. import the module in the test
  and assert tile text is derived from it), not just that the module exists.
- **A guard bypassed by bracket access, a cast, or a `!` assertion.** `commit: string | null` is
  defeated by `entry.commit!` in the renderer or by `as string`. The renderer must branch on
  `=== null`.
- **An arithmetic guard that omits the dominant term.** A verifier that checks the hash resolves but
  never checks `addedLines` against the diffstat leaves half the fabrication in place — the `+N` was
  invented alongside the hash.
- **A hash that resolves but is unrelated.** `git cat-file -t` succeeding proves the object exists,
  not that it contains the described change. The `addedLines` diffstat check is what binds them.

### Standing project rules

- `isAggregatableRun` (`src/client/state/ledger.ts:572`) is the ONE place that decides aggregation —
  never add a second gate.
- Arm membership is DERIVED from configuration, never declared.
- Unmeasured is `null` and renders `not measured` — never `$0.00`, never a zero.
- Never report a fixture-sourced number; never aggregate a run whose `origin` is `manual` or
  `status` is `failed`.
- The measured atom is the UTTERANCE, not the Run.
- 24 kHz PCM16 mono everywhere; `SAMPLE_RATE` in `src/core/protocol.ts` is the single source of truth.
- Live persists no audio and creates no Run records.
- Replay autoplays nothing; Live autoplays always.

## RESOLUTION (2026-08-09)

Suite 2351 passing / 0 failing. **`npm run eval` is 13 pass / 0 fail — every golden case green.**

Citations now live in `src/client/views/coverageCitations.ts` as typed
`{ direction, commit, addedLines, note }`; the view renders fields and holds no hash literal.
`scripts/verify-citations.mjs` resolves each non-null commit against real history.

### The honest numbers, which contradict the fabricated card

The card claimed *"one language constant, +11 lines"*. Neither `a4f21c` nor `9d0e77` resolves. What
actually happened, verified by the orchestrator against git and now checked by the script on every
run:

| commit | insertions | what it did |
|---|---|---|
| `a6ca500` | **+694** | ticket 061 — the Replay target-language control; before it, no screen could ask for Cantonese |
| `a57cd3a` | **+657** | ticket 062 — carried the chosen pair through both arms and both paths |

**1351 whole-commit insertions for the first additional pair**, because the plumbing did not exist.
Only the *next* pair is cheap — one entry in `pairs` (`sessionMachine.ts:216-219`) — and that entry
carries `commit: null` / `addedLines: null` because nobody has done it. The fourth entry states that
EN→YUE on Realtime has no mechanism at any price. `addedLines` is **whole-commit insertions, every
path, tests included** — no exclusion rule, pinned by test and enforced by the script.

Ticket 057 should carry this: the real onboarding-cost finding is the *shape* of the curve, not a
single cheap number.

### Adversarial review — RED, and the findings were about the GATE, not the card

The card work was clean and the eval-executor edit was judged **strictly stronger** (it executes two
`must_include` clauses that were previously dead code, and the old executor was proven *structurally
unsatisfiable* — it asserted the whole coverage card contained no digits, which is only true if the
card cites nothing). But three findings, all now closed:

1. **The ticket's own sin, one level up.** The locked assertion "a verifier that reports and exits 0
   is not a gate" was a regex for `process.exit(1)` — and the script's own JSDoc header **spelled
   that literal call**. With every real exit deleted, the comment alone kept the suite green. Prose
   standing in for evidence, in the gate for a ticket about prose standing in for evidence. The
   header was reworded so the assertion bites.
2. **The verifier was pinned only by grepping its own source**, so `catch { continue }` (silently
   passing an unresolvable hash) and a regex-form test-file exclusion both survived. It is now an
   **injectable seam** — `verifyCitations(citations, runGit)` is pure and unit-tested against a fake
   git, with the CLI a thin wrapper. 16 tests, no `.git` required.
3. **The gate was wired into nothing.** `verify-citations` appeared in no aggregate script, so
   `commit: 'deadbee', addedLines: 694` passed 2335/2335 and 13/13. A fabricated citation reached
   the screen with both declared gates green. Added `npm run check` =
   `typecheck && test && eval && verify-citations`. **Verified by the orchestrator: `check` exits 1
   on a fabricated citation and 0 when clean.**

Deliberately NOT added to `build` — builds must stay runnable where `.git` is absent (container,
tarball, shallow checkout), and failing a bundle for a missing object would be a failure unrelated to
the bundle. `test` and `eval` stay git-free for the same reason.

### New: `npm run check`

One command that runs every gate. Use it before any claim that the project is green.
