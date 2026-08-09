# Handoff prompt — AI Interpreter Workbench

Paste everything below into a fresh agent session.

---

You are picking up an in-flight build at `/Users/kellyhe/Documents/gauntlet/boostlingo`, branch `main`, HEAD `54ca789`.

## What this project is

A research SPA comparing two live-interpretation architectures for a take-home graded against `boostlingo_project_rubric.pdf` (read it first — it is the grading contract):

- **Arm A** — OpenAI Realtime API, voice-to-voice, one sealed model
- **Arms B / C** — a composable STT → MT → TTS cascade; B and C differ in exactly one stage (TTS: `gpt-4o-mini-tts` vs ElevenLabs Flash)

`PRD.md` is the method. Read **§15A (cut)**, **§15B (deferred)**, **§15C (status)** and **§15D (what the stored data actually shows)** before anything else — they are recent and they overrule older prose in the same document. The scope contract was deliberately narrowed on 2026-08-09: **everything in §16 Deliverables will be built; §15A/B name what will not.** A cut item is not a debt and does not come back as a ticket.

`AGENTS.md` carries the standing rules. `.tdd/tickets/` is the board.

## Current state

```
npm test        → 2087 passing, 34 failing   (all 34 are ticket 062's intentional locked reds)
npm run eval    → 8 passing, 5 failing        (each failure maps to a named ticket)
npx tsc --noEmit -p tsconfig.json && -p tsconfig.server.json   → clean
npm run build   → clean
```

Both failing sets are expected. Do not "fix" them by weakening a test.

## The work, in order

### 1 · Ticket 062 — START HERE. Tests are already written and locked.

`.tdd/tickets/062-realtime-ignores-the-selected-language-pair.md`

Rubric must-have #5 (*"Language pair selection, minimum English ↔ Spanish"*) is **failing**, and it was marked ✅ by both a spec audit and a manual QA pass — because the selector renders and switches correctly. It is **three defects**:

1. **Replay never sends a language.** `ReplayView.tsx:522-528` builds config with no `languagePair`; `runner.ts:938-942` fills `''`; `realtime.ts:541-549` interpolates it into *"Translate everything the user says into . Speak only the translation"*. The model picked German. Stored proof: run `dbeb6d94` translated an English clip into German. **All 45 sweep runs would share this.**
2. **Live never re-sends it.** `transportKey` (`useSessionController.ts:799`) is `JSON.stringify(runConfig)`, and `LiveRunConfig` carries only architecture/model/providers — so a pair or direction switch never reaches a running session. The button relabels; the model keeps the old language.
3. **Cascade is defective too.** `targetLang` never reaches the MT provider; `openai-mt.ts:69` and `anthropic-mt.ts:105` fall back to `?? 'Spanish'`. Every cascade run was Spanish *by accident*. ES→EN translates Spanish into Spanish; EN→YUE produces Spanish.

34 red tests are locked across 9 files and assert the **wire payload**, not component state — reading state is the blind spot that let this pass QA twice. One design decision you must honour rather than route around: a session with an empty or whitespace-only target language is **refused** (no `session.update` on the wire, `onError`, `disconnected`), and such a run never reports `status: 'complete'`. Fixing only the callers leaves the failure mode armed for the next one.

### 2 · Then, in this order

| # | Ticket | Note |
|---|---|---|
| **061** | Runs record no `languagePair` / `direction` | Only the Run half is real — Recordings already record `sourceLanguage` correctly. The fields are not on the `Run` type at all. |
| **064** | `REALTIME · TRIMMED` samples pooled into `default` | A **wrong** number, not a missing one. `deriveLiveModel` groups by armTag only and never reads `contextPolicy`. |
| **055** | One ledger, one truth + the run envelope | **Consider splitting into 055a (ledger) / 055b (runner envelope)** — near-zero file overlap, different evals. A hardening pass recommended this. |
| **059** | `$0.000` on Results + Replay | Root cause is **not** the formatter — `costFromStored` treats a stored `0` as measured, and `Run` lacks the `pricingVersion` stamp that makes `LiveSession` correct. |
| **060** | Coverage card cites commits that do not exist | `ResultsView.test.tsx:587-589` currently **pins the fabricated hashes** — it will go red for the right reason; re-point it. |
| **065** | `Batch sweep…` launches 18 executions, no dialog | The runner itself is good. This is about the front of it only. |
| **066** | Replay loses its selection on tab change | |
| **054** | Delete the placeholder corpus | Keep `SCRIPTS.md` / `LIVE-SCRIPT.md`. **Keep the `placeholder`-prefix realness guards** — golden eval 06 requires them. |
| **058** | Delete fabricated benchmark data + null scaffolding | Collides with 054 on `scripts/bench-fixture.mjs`; do not run them in parallel. |
| **057** | `FINDINGS.md` — rubric must-have #8, 0% done | **No code, no tests.** Harvest `HelpView.tsx` (arms card :187-226, experiments :228-256, auditability :285-292). |

**Deferred, do not start:** 050, 026, 053 (053 is complete and green on branch `tdd/053`, deliberately unmerged). **Closed invalid:** 022, 063.

Every ticket 054–066 has a `## CONTEXT FOR A FRESH AGENT` section with verified file:line citations, inline code, the test file its assertions must land in, named seams, its golden evals, and known traps. **Trust it over your own re-derivation** — every citation was verified against the repo on 2026-08-09.

## How to work

Run a strict TDD loop per ticket:

1. **Test-writer subagent** — writes failing tests from the acceptance criteria. No implementation.
2. **Lock** — commit the tests. They become read-only for the implementer.
3. **Implementer subagent** — drives them green. May not edit a locked test; if it believes one is wrong, it stops and says so.
4. **Adversarial reviewer subagent** — read-only, mutation-based, reviews the diff **before** you commit.
5. **Loop** on findings until the reviewer returns GREEN.

**Gates before every commit:** `npm test` · `npm run eval` · both typechecks · `npm run build`.

`npm run eval` is the acceptance gate. Its 12 cases in `eval/golden/` encode verified defects and quoted rubric lines; the runner reads expectations out of the JSON, so editing a case moves the assertion. **Five cases are red and each names its ticket** — that is the work list. A case that goes green must go green because the product changed.

### Rules for subagents, every time

- **Run NO git commands** — not even `git checkout` or `git stash` to revert throwaway work. Two agents tripped a security alarm here doing exactly that. Undo by editing files back by hand. Only you touch git.
- Do NOT run `prettier` — this repo has no config and it reformats unrelated regions.
- Do not start or stop dev servers without asking — Kelly uses them.
- **No new test file may be added to a module that already has one.** New assertions go in the existing file.

## Standing rules — violating these corrupts the experiment

- `isAggregatableRun` is the **one** place that decides aggregation. Never add a second gate.
- Arm membership is **derived** from configuration, never declared. A Run whose declared tag disagrees with its config aggregates under the derived one.
- **Unmeasured is `null` and renders `not measured`** — never `$0.00`, never a zero. Zero is a measurement; absence is not.
- Never report a fixture-sourced number. Never aggregate a run whose `origin` is `manual` or `status` is `failed`.
- The measured atom is the **utterance**, not the Run.
- 24 kHz PCM16 mono everywhere; `SAMPLE_RATE` in `src/core/protocol.ts` is the single source of truth.
- Live persists **no** audio and creates **no** Run records. Replay autoplays nothing; Live autoplays always.
- Everything is an injectable seam — jsdom has no `AudioContext`, `MediaStream` or `RTCPeerConnection`.
- Provenance reports **actual** N, never intended N.

## Traps this project has actually hit

Nine vacuous assertions have been caught here. Assume more exist.

- A seam test that passed while production had **zero callers** (the fix was wired in Replay and not Live).
- A source-text `includes()` satisfied by an **import line**.
- A Web Audio graph whose `connect()` calls could **all be deleted** with the suite green.
- A regex guard bypassed successively by **bracket access**, then a **cast**, then a **`!` assertion**.
- A wiring seam delivered **incidentally** by an unrelated re-render.
- An arithmetic guard that **omitted the dominant term** (pacing, 45 s of a 77 s budget).
- A test that **compared a render against itself** — RTL appends and every accessor was `document.querySelector`.
- Two mutations restoring a ticket's **literal headline defect** with the whole suite green.

**Prefer asserting through the real operator path over the seam.** Mutate to prove each new assertion bites, then revert by hand.

## What is blocked on Kelly — do not attempt

- **YUE takes 1–3** (~15 min, solo, improvised from `corpus/LIVE-SCRIPT.md`, no reference text)
- **ES takes 1–3** — blocked on a Spanish-speaking coworker; the only externally-blocked item
- **One 5-minute Live session per arm** — the rubric's stability benchmark, never once executed
- **Listening to EN→YUE output** — PRD §10's Mandarin-pronunciation trap is audible only, and it is the project's most distinctive finding

3 EN corpus takes are recorded (12 utterances, categorised, verbatim reference text). **Do not re-run them until 062 lands** — you would collect German Arm A output and accidentally-Spanish cascade output.

## Report to Kelly

State plainly what you verified versus what you assumed. When a ticket's premise turns out false, say so and close it rather than building to it — that has already happened twice (022, 063). Correct your own earlier claims when evidence contradicts them; several corrections in this project have been to the prior agent's own findings.
