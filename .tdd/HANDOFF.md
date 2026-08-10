# Handoff — 2026-08-10

Branch `main`. **Working tree clean. Nothing in flight.**

```
npx vitest run   2540 passing / 0 failing
npm run eval     13 pass / 0 fail
npm run check    exit 0     ← typecheck && test && eval && verify-citations
```

`npm run check` is the one command that runs every gate. Use it before claiming green.

---

## Read these first, in this order

1. `PRD.md` §15A (cut) / §15B (deferred) / §15C (status) / §15D (what the stored data shows) — these
   overrule older prose in the same document.
2. `AGENTS.md` — standing rules.
3. `.tdd/RUN-PLAN-062.md` — the board, and **"What this run learned"**, which is the most useful page
   in the repo for a new agent.
4. This file.

---

## The one item that was ready to pick up — now done

**Ticket 074 is CLOSED.** `inputCantoOnRealtime` and the whole `warnings()` helper are deleted, the
LiveView banner and `WarnIcon` with them, `COPY.cantoInputWarn` is retired copy asserted absent, and
the coverage card's **Cantonese → English × Realtime** cell reads `reached`. The two tests that had
to go red did, for the predicted reason, and were re-pointed rather than deleted. FINDINGS.md §2
records both Realtime directions as reached **by observation, neither scored**.

**Nothing is unblocked right now.** The next moves all sit with the operator (see below); 053 and
069 are the only code-side candidates, and both are described honestly in the table.

---

## Open tickets, with their real state

| # | state |
|---|---|
| **074** | **closed** — nothing left |
| **053** | **NOT merge-ready.** `tdd/053` holds `stub()` + `test()` only — 1218 lines of tests, no `feat`, no implementation. Its own header claims "COMPLETE ON BRANCH"; that is wrong. It is the right ticket for cascade **cost** metering (MT tokens, ElevenLabs characters). Arm B's cost can never exist regardless — `openai-tts` returns raw PCM while `gpt-4o-mini-tts` bills audio-out tokens. |
| **069** | landed, but **did not stop the STT hallucination**. 54 of 61 sweep runs on the deployed instance still failed segmentation, and all 54 stored **no utterances at all**. Next levers: an STT prompt, a stricter VAD threshold, or trimming from the manifest's first anchor rather than by amplitude. |
| 050, 026 | deferred by operator decision (PRD §15B) |
| 022, 063 | closed invalid |

---

## What is true about the data right now

- **Local `data/`**: 3 EN recordings, 28 runs. **Deployed instance**: 73 runs, of which only **14**
  are aggregate-eligible (A=12, B=2, **C=0**), because of the 069 failure above. **12 of 14 are
  priced** — ticket 070 works.
- **Experiment 2 (B vs C) renders its empty state** on that data. Arm C has zero eligible runs.
- A verified backup of the deployed instance sits in `backups/2026-08-10T04-43-08/` (gitignored) and
  at `~/boostlingo-backup-2026-08-10T04-43-08/`. 61 MB, 75 WAVs, all valid 24 kHz/mono/16-bit.
- `npm run backup-remote <url>` / `npm run restore-remote <url> <dir>` (ticket 072). **Railway's disk
  is ephemeral and mounting a volume is itself a redeploy** — so the order is always back up, mount,
  restore.

---

## Blocked on the operator, not on code

- **Re-run the sweep.** Everything since the last one (067, 068, 069, 070) is unexercised on fresh
  data. Cost in particular stays `not measured` until a run carries usage.
- ES takes 1–3 (needs a Spanish-speaking coworker — the only externally-blocked item); YUE takes 1–3.
- One 5-minute Live session per arm — the rubric's stability benchmark, never executed.
- **The audio-seam question**, still unanswered: play one stored `.out.wav` and say whether words are
  cut **mid-syllable** (a real gate bug), **intact but jumping** between utterances (by design), or
  **whole utterances missing** (the `no output audio` cases). Not determinable from the waveform.
- A persistent Railway volume mounted at the app's `data/`.

---

## How this project works — do not skip

**Loop, per ticket:** test-writer sub-agent → **lock (orchestrator commits the tests)** → implementer
→ adversarial reviewer → close findings → commit. The reviewer found something real on **every
single ticket** — 062:4, 061:2, 064:4, 055b:5, 055a:6, 059:2, 060:3, 065+066:6, 067:1. Almost all
were *unpinned intent*: correct code with no test that bit.

**Sub-agent rules, every time:**
- Run **NO git commands** — not even `status`. Two agents tripped a security alarm. Undo by editing
  files back by hand. **Only the orchestrator touches git.**
- No prettier (no repo config; it reformats unrelated regions).
- Do not start/stop dev servers without asking.
- No new test file in a module that already has one.
- `data/` is READ-ONLY.

**Standing rules that corrupt the experiment if broken:**
- `isAggregatableRun` is the ONE aggregation gate. Never a second.
- Arm membership is derived from configuration, never declared.
- Unmeasured is `null` → "not measured". **Never `$0.00`, never a zero.** A measured zero is still a
  measurement — do not collapse them.
- Never report a fixture-sourced number; never aggregate `origin: manual` or `status: failed`.
- The measured atom is the **utterance**, not the Run.
- Provenance reports **actual** N, never intended N.
- 24 kHz PCM16 mono; `SAMPLE_RATE` in `src/core/protocol.ts` is the single source of truth.
- Everything is an injectable seam — jsdom has no AudioContext/MediaStream/RTCPeerConnection.

---

## Lessons this run paid for — they will save you a day

**A stable pass/fail COUNT is not evidence the same cases pass.** `npm run eval` read 8/5 before and
after ticket 062 while its composition swapped. Reported "unchanged" three times before anyone
checked. **Enumerate case ids, never totals.**

**Four eval cases turned out not to gate their own ticket** — 056/case 12, 055a/case 04, 059/case 07,
060/case 10. Each passed or failed for a reason other than the defect it named. The locked unit tests
carried the load every time. **The eval board is not a completion signal on its own.**

**Three locked tests were logically unsatisfiable**, and in each case the implementer stopped and said
so rather than routing around it. That behaviour is worth more than the tests were. **If a locked
test looks wrong, stop and report — do not weaken it.**

**Ticket premises are frequently false.** 022 and 063 were closed invalid; 056, 055, 068, 069, 070,
073 and 074 all had premises corrected mid-flight — several of them mine. **Verify the premise
before building to it, and say so plainly when it does not hold.**

**Watch for the seam with zero production callers.** It recurred in 064, in 066 (`browserDeps`'s
`selectionStore` was deletable with a fully green suite), and again in 067 (`App`'s default
`sweepClock`, same shape). `browserDeps.inboundTap.test.ts` exists precisely because of this and
shows the two-way guard: a property probe off the **constructed** bag plus a scoped source scan.

**Prose can satisfy a grep.** Ticket 060's "is this a real gate?" test was a regex for
`process.exit(1)` — and the script's own JSDoc header spelled that call, so deleting every real exit
kept the suite green. Assemble needles from fragments (`'a4f' + '21c'`) and do not exempt the guard
file from its own scan.

---

## Two live findings not yet actioned

- **`ReplayView.tsx:637`** picks blind-compare pairs on `status === 'complete'` alone, with no
  stored-audio predicate — so BlindCompare can offer a play button for a run with no `.out.wav`. May
  be deliberate (gating inside BlindCompare would deanonymise the comparison) and adding one would
  violate 056's "no second has-audio predicate" rule. Operator's call.
- **`src/core/protocol.test.ts:122-138`** — the "session.start has no extra field" guard is
  structurally vacuous: `Array<keyof SessionStart>` widens, so the `Exclude` is `never`
  unconditionally. Adding a bogus field typechecks clean and the guard stays green. It is the guard
  that should have flagged ticket 062 widening that frame.

---

## Remotes

| name | url |
|---|---|
| `origin` | `github.com:kellyhe47/AI-Interpreter-Workbench.git` — **Railway deploys from this** |
| `gitlab` | `labs.gauntletai.com:22022/kellyhe/boostlingo.git` |

`main` currently tracks `gitlab/main`, so a bare `git push` goes to GitLab. **Push to `origin`
explicitly when you want a deploy.** Branch `tdd/053` is local-only — push it if you value the work.
