---
id: 057
title: FINDINGS.md — rubric must-have #8, currently 0%
status: done
source: rubric
depends_on: []
touches: [FINDINGS.md]
iterations: 1
test_files: []
branch: main
---

## Why

Rubric must-have #8, quoted:

> *"Comparison write-up (1–2 pages) covering latency, quality, cost, controllability, and a
> recommendation for which mode fits which scenario"*

**There is no artifact.** No `FINDINGS.md`, no `COMPARISON.md`, no `results/` directory. It is the
only must-have with zero code or prose behind it, and it is worth more than the rest of the open
backlog combined — the other seven are already built.

## Scope

Draft the skeleton NOW with explicit `not yet measured` placeholders, so the hour real numbers exist
the document is a fill-in rather than a blank page.

**Harvest `HelpView.tsx`.** It already explains the three arms, the experiments and the 5-vs-3
auditability gap in plainer language than the PRD does. It is the write-up's first draft and it is
already written.

## Acceptance criteria

- [ ] `FINDINGS.md` exists at the repo root with exactly five top-level sections, in this order:
      **latency · quality · cost · controllability · recommendation**
- [ ] Every figure in the document is either (a) a number with a citation to a `results/<date>/`
      bundle file, or (b) the literal string `not yet measured`. No third state — no blank cell, no
      unattributed number, no fixture number.
- [ ] Every `not yet measured` is followed on the same line by **what would fill it** (the specific
      run/sweep/export that would produce it)
- [ ] **Controllability is written in full today** — it is reasoned from architecture, not measured.
      It must state the 5-vs-3 observable-interval asymmetry: the cascade exposes five stage
      timings, Realtime exposes three with its middle interval marked `opaque`.
- [ ] Controllability must also state the **auditability** argument: the cascade's transcript IS
      what got translated, so a wrong output is traceable to a stage; Realtime's transcript is a
      second model's guess at what the first one said. Name the medical/legal compliance
      consequence explicitly.
- [ ] Controllability must also state **provider swapping as a contained change** — Arm C differs
      from Arm B in exactly one stage.
- [ ] **Cost's honest state is written today.** State it accurately: **Arm A (Realtime) is the only
      arm metered end to end** (`priceRealtimeUsage`, `src/core/pricing.ts:418`). **Arms B AND C
      both report `not measured`**, because `priceCascade` (`src/core/pricing.ts:515-533`) refuses a
      total when any stage is unmeasured — MT reports no token usage at all, and
      `gpt-4o-mini-tts` bills audio-out tokens its API never returns. Arm C's per-character
      figures additionally carry `verified: false` (the ElevenLabs 1,000-char-per-request minimum
      is an unverified assumption).
- [ ] That cost asymmetry is stated **as a controllability finding**, not only as a gap — one
      provider tells you what you spent and the others do not.
- [ ] Limitations section states, each as its own line: N (actual, not intended), single evaluator,
      one operator, and which language pairs were and were not covered
- [ ] Length is 1–2 pages: **≤ 250 lines of Markdown.** The PRD is 1,105 lines for a 15–20 hour
      brief — do not repeat that mistake here.

> removed — "Every number cites the exported bundle it came from; nothing is retyped from a screen"
> is now folded into the second criterion above, which is falsifiable as written. Note that
> `results/` does not exist yet (`npm run export-results` has never been run), so at draft time
> EVERY figure is legitimately `not yet measured`.

## Out of scope

- **No code changes.** This ticket adds one Markdown file at the repo root. It must not touch
  `src/`, `eval/`, `PRD.md`, `package.json`, or any other ticket.
- **No new numbers.** Do not run a sweep, do not run `npm run export-results`, do not compute a
  figure. If a number is not already in a committed bundle, it is `not yet measured`.
- **No fixture, placeholder, or illustrative number may appear**, even labelled.
- Do not restate the PRD. Harvest `HelpView.tsx` prose instead — it is already plainer.
- The recommendation is scenario-based ("which mode fits which scenario"), never a winner.

## Notes
- If a dimension stays unmeasured at submission, say so in one line and say why. A stated gap is a
  finding; a silent one is a hole.

## CONTEXT FOR A FRESH AGENT

### 1. Verified facts and citations

| Claim | Verified |
| --- | --- |
| `FINDINGS.md` does not exist | true — nor `COMPARISON.md`, nor `results/` |
| Export bundle producer | `src/harness/exportResults.ts` (715 lines), CLI shell `scripts/export-results.mjs` |
| npm script name | **`npm run export-results`** (`package.json` → `"export-results": "tsx scripts/export-results.mjs"`). There is no `npm run export`. |
| Bundle destination | `results/<YYYY-MM-DD>/` — committed, and it is what the write-up cites (`exportResults.ts:8-22`) |
| Harvest source | `src/client/views/HelpView.tsx`, 313 lines |
| Arms explanation | `HelpView.tsx:187-226` (card "The three arms"): Arm A rows 202-209, Arm B 209-216, Arm C 217-224 |
| Experiments explanation | `HelpView.tsx:228-256` (card "The experiments"); the Cantonese/Mandarin case is `:245-250` |
| 5-vs-3 auditability gap | `HelpView.tsx:285-292` (card "How to read it", first item) |
| Provenance / illustrative prose | `HelpView.tsx:299-309` |
| Arm A metered end to end | `src/core/pricing.ts:418` `priceRealtimeUsage` |
| Arms B and C both unmeasured | `src/core/pricing.ts:515-533` `priceCascade` → `unmeasured('stage-unmeasured', verified)` |
| `gpt-4o-mini-tts` is Arm B's TTS | `src/core/arms.ts:94,120` |
| Arm C's TTS is `eleven_flash_v2_5` | `src/core/arms.ts:127-131` |
| Unmeasured renders as | `COST_NOT_MEASURED_CELL = 'not measured'` (`src/core/pricing.ts:49`) |
| Actual data on disk | 3 Recordings (all EN), 3 Runs (all `origin: "manual"`, one `failed`), 0 stored output audio, 0 exported bundles |

### 2. The prose to harvest, inline

`src/client/views/HelpView.tsx:285-292` — the 5-vs-3 auditability gap, verbatim:

```tsx
<Term>The stage timings</Term> show where the time goes, in labelled milliseconds. The
cascade shows all five steps; Realtime shows three, with its big middle one marked{' '}
<i>opaque</i> — the sealed box. When something breaks, the cascade names the failed
stage; Realtime can&apos;t. That difference is itself a finding.
```

`src/client/views/HelpView.tsx:203-223` — the arm explanations:

```tsx
<Term>Realtime</Term> — the sealed box. OpenAI's voice-to-voice model does
everything internally. We can't see inside; we can only time the whole thing.
...
<Term>Cascade, all-OpenAI</Term> — the assembly line built entirely from OpenAI parts.
A and B share a vendor, so any difference between them is caused by the design, not
the company.
...
<Term>Cascade, one part swapped</Term> — identical to B except the voice stage, which
uses ElevenLabs. Exactly one difference, so whatever changes between B and C is caused
by that one swap.
```

`src/client/views/HelpView.tsx:245-250` — the quality finding the write-up must carry:

```tsx
<Term>4 · What about a less common language?</Term> Cantonese, as a case study against
the same vendors. Realtime doesn't list it; we run it anyway to see <i>how</i> it
fails — the transcript can look right while the audio is actually Mandarin. Only a
native speaker's ear catches that, which is why blind scoring is playback-only.
```

`src/core/pricing.ts:515-533` — why B and C have no total:

```ts
export function priceCascade(usages: CascadeStageUsages): CascadeCost {
  ...
    ? unmeasured('stage-unmeasured', verified)
```

### 3. Tests

**This ticket has NO code tests, and must not create any.** It produces one Markdown file; there is
no module for a suite to attach to, and the standing policy forbids adding a test file to a module
that already has one — here there is no module at all.

The "test" is a **manual structural check by the author**, run before marking the ticket done:

1. `rg -c '' FINDINGS.md` ≤ 250
2. `rg -n '^## ' FINDINGS.md` lists exactly the five sections in order
3. `rg -n '\$[0-9]|\b[0-9]+ ?ms\b|p50|p95' FINDINGS.md` — every hit is either adjacent to a
   `results/<date>/` citation or is inside a `not yet measured` line
4. `rg -n 'not yet measured' FINDINGS.md` — every hit names what would fill it
5. `rg -n '\$0\.00|illustrative|placeholder|fixture' FINDINGS.md` returns nothing

If a check is later wanted in CI, it belongs as a script, not as a new vitest file.

### 4. Seams / injectable dependencies

**None.** No runtime code is involved. Do not wire a seam for a Markdown file.

### 5. Golden evals

No golden eval binds this ticket directly — they are all code-surface (`pure` or `dom`). Three
constrain what the prose may CLAIM, and must be read before writing the cost and provenance
sections:

- `eval/golden/07-unmeasured-cost-is-null-not-zero.json` — unmeasured is `not measured`, never
  `$0.000`. The write-up must not print a zero cost for Arm B or C.
- `eval/golden/04-provenance-reports-actual-n.json` — report ACTUAL N, never intended N. The
  limitations section's N must be the completed count.
- `eval/golden/06-fixture-and-placeholder-never-aggregate.json` — no fixture- or
  placeholder-sourced number may reach the write-up.
- `eval/golden/10-onboarding-cost-cites-a-real-commit.json` — if the controllability section cites
  a commit for the "provider swap is a contained change" claim, the hash must satisfy
  `git cat-file -t`. Two hashes currently rendered in the app (`a4f21c`, `9d0e77`) do NOT resolve;
  that is ticket 060. Do not copy them into `FINDINGS.md`.

### 6. Known traps for THIS ticket

- **Retyping a screen.** Every figure visible in the running app today is either an empty state or
  an illustrative badge. There is nothing measured to copy. A number that appears in `FINDINGS.md`
  without a `results/` bundle behind it is fabricated by definition.
- **Repeating the cost claim wrongly.** The intuitive story ("Arm C meters, Arm B doesn't") is
  backwards. Arm A meters; B and C both do not, for a shared reason (MT reports no usage). Ticket
  053 is the fix and it is still `pending`.
- **A `> already satisfied` that is not.** `HelpView.tsx` explains the arms; that is UI help text,
  not the rubric artifact. Harvesting it is allowed; pointing at it as the deliverable is not.
- **Scope creep back into code.** This backlog has regenerated repeatedly from tickets that grew.
  If writing the document surfaces a defect, file it — do not fix it here.
- **Citing 060's fabricated commit hashes.**

### Standing project rules

- `isAggregatableRun` is the ONE place that decides aggregation — never add a second gate.
- Arm membership is DERIVED from configuration, never declared.
- Unmeasured is `null` and renders `not measured` — never `$0.00`, never a zero.
- Never report a fixture-sourced number; never aggregate a run whose `origin` is `manual` or
  `status` is `failed`.
- The measured atom is the UTTERANCE, not the Run.
- 24 kHz PCM16 mono everywhere; `SAMPLE_RATE` in `src/core/protocol.ts` is the single source of truth.
- Live persists no audio and creates no Run records.
- Replay autoplays nothing; Live autoplays always.

## RESOLUTION (2026-08-09)

`FINDINGS.md` at the repo root, **249 lines** (limit 250). Five top-level sections in order —
latency · quality · cost · controllability · recommendation — plus Limitations. No code changed.

### One AC deviated from, deliberately, by the orchestrator

AC2 allows only two states: a number citing a `results/<date>/` bundle, or the literal
`not yet measured`. **`results/` has never been generated**, so read literally every figure becomes
`not yet measured` — a blank page that demonstrates nothing.

Real verified measurements do exist on disk. They are included inside a visibly-marked
**`MEASURED TODAY — PRE-EXPORT`** blockquote that names its source file (`data/live-sessions.jsonl`),
states the recomputation method, and says outright that it predates any bundle and is not cited from
one. **Nothing is presented as bundle-cited that is not.** Every remaining figure is
`not yet measured` followed on the same line by the specific run, sweep or export that would fill it
— nine of them.

### What the document actually establishes

- Live latency: `realtime · default` p50 **260 ms** (n=7), `realtime · trimmed` **423 ms** (n=8),
  `cascade` **1487 ms** / p95 **2858 ms** (n=16) — cascade *partially* meets the rubric's
  "under 3s, target under 2s", and the two Realtime policies were pooled at **399 ms** until ticket
  064 split them (a wrong number, not a missing one; p95 unchanged at 512).
- Onboarding: **1351 insertions** for the first additional language pair (`a6ca500` +694,
  `a57cd3a` +657, both verified against git by `npm run verify-citations`), then one `pairs` entry
  for the next. **The shape of the curve is the finding**, and it contradicts the fabricated
  "+11 lines · one language constant" claim ticket 060 deleted.
- Cost stated as a **controllability** finding: Arm A is the only arm metered end to end; Arms B and
  C both report `not measured`; Arm C additionally carries `verified: false`. *The architecture with
  more knobs is the one you can least account for financially.*
- Zero aggregate-eligible Runs: all 3 stored Runs are `origin: 'manual'`, one failed.

The recommendation section gives four scenarios, each with what it rests on **and what it lacks**,
and refuses to recommend on cost predictability — *"anyone quoting a per-minute figure for Arm B or C
is quoting nothing."* The single most consequential unknown is named as such: whether Realtime's
Cantonese comes back as fluent Mandarin. It is audible only, and nobody has listened.

The "single native evaluator" claim is sourced — PRD.md:791.
