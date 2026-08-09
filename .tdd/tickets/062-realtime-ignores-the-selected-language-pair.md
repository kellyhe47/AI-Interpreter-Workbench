---
id: 062
title: "Realtime translated English into GERMAN — the selected language pair never reaches the session"
status: done
source: verification (missed by both the spec audit and the QA pass)
depends_on: []
touches: [src/client/transport/realtime.ts, src/client/transport/cascade.ts, src/client/views/useSessionController.ts, src/client/views/ReplayView.tsx, src/client/replay/runner.ts, src/client/state/sessionMachine.ts, src/client/state/ledger.ts, src/core/protocol.ts, src/core/types.ts, src/server/ws.ts, src/server/cascade/orchestrator.ts, src/server/providers/openai-mt.ts, src/server/providers/anthropic-mt.ts]
iterations: 1
test_files: [src/client/transport/realtime.test.ts, src/client/transport/cascade.test.ts, src/server/ws.test.ts, src/server/cascade/orchestrator.test.ts, src/server/providers/openai-mt.test.ts, src/server/providers/anthropic-mt.test.ts, src/client/replay/runner.test.ts, src/client/views/ReplayView.test.tsx, src/client/views/LiveView.test.tsx, src/client/views/LiveView.persistence.test.tsx]
branch: main
---

## RESOLUTION (2026-08-09)

All 34 locked tests green; suite 2128 passing / 0 failing. Three defects, one seam.

**The seam.** `deriveLanguageSelection(langIdx, reversed)` / `languageSelectionForSource(code)` /
`languageCode(name)` in `src/client/state/sessionMachine.ts`, beside the `pairs` table those strings
derive from. Nothing in production produced `'EN↔ES'` / `'en→es'` before — only fixtures did.

1. **Replay** — `ReplayView.tsx` `run()` and *every* sweep configuration now derive the languages
   from the selected Recording's own `sourceLanguage`. Replay needs no selector: a clip declares
   what language it is in, so an `es` clip runs `es→en` / `English` / `EN↔ES`.
2. **Live** — `LiveRunConfig` now carries the three fields, so `transportKey =
   JSON.stringify(runConfig)` moves on a pair or direction change and the session is genuinely
   re-instructed. Previously the button relabelled and the model kept the old language.
3. **Cascade** — `targetLanguage` rides `session.start`, `ws.ts` forwards it into `opts.session`,
   `runCascade` **spreads** it into `mt.translate()` opts (spread, not assign — a session that named
   no language leaves the key absent rather than inventing `'Spanish'`), and both MT adapters let the
   per-call value win over the construction default.

**The refusal (the part that disarms the failure mode rather than just fixing the callers).** A blank
or whitespace-only target language is refused at the source: `RealtimeTransport.start()` bails before
the token request — no channel, no `session.update`, `onError`, `disconnected`, never `connected` —
and `runOnce` fails the run before `transport.start()`, via the existing gate. No second aggregation
gate was added. No post-hoc output-language detection anywhere; the ticket forbids it and the
instruction is correct at the source.

`Run.languagePair` / `Run.direction` added (optional — pre-062 rows have neither, and in an
append-only ledger absence must stay absence, never `''`).

### Adversarial review

Mutation-tested, 18 mutations. M1–M3, M5–M9, M13, M14, M17, M18 all went red correctly — no headline
defect is reintroducible. Four mutations stayed green; all four were correct code with no test that
bites, and all four are now pinned (7 new assertions, each watched fail before being kept):

- **Live utterance RECORD** stamped `'EN↔ES'`/`'en→es'` for an EN↔YUE or reversed session was green —
  the ledger contradicting the session, this ticket's own defect class moved from wire to record.
  Pinned in `LiveView.persistence.test.tsx` through the real operator controls.
- Absence-vs-`''` on the stored Run; `.trim()` on the runner's cascade guard; MT precedence (the
  "overriding the construction default" cases never *set* a construction default, so the precedence
  was unfalsifiable).

Verified: `deriveArmTag` unaffected (reads `architecture` + `realtimeModel`/`providers` only —
languages are not part of arm configuration); no zero-caller helpers (every new seam is called on
both the Live and Replay paths); `isAggregatableRun` untouched.

### Remaining AC — blocked on Kelly, not on code

"Re-run the three recorded takes afterwards and confirm Spanish output before any figure is
reported." Needs real provider calls. Every stored Arm A number remains suspect until then.

### Filed separately

`src/core/protocol.test.ts:122-138` — the "session.start has NO extra field" guard is structurally
vacuous (`Array<keyof SessionStart>` widens, so the `Exclude` is `never` unconditionally). A bogus
field added to the frame typechecks clean and the guard stays green. Pre-existing, outside this diff;
it is the guard that should have flagged 062 widening the frame.

## Observed — verified from stored data

Run `dbeb6d94` · `armTag: A` · `status: complete` · **this is an English↔Spanish project**:

```
source: "Dr. Nguyen referred you to Cedars-Sinai for the MRI on Thursday."
target: "Dr. Nguyen hat Sie für das MRT am Donnerstag an das Cedars-Sinai überwiesen."
languagePair: None
```

**That is German.** The only complete Realtime run in the repository translated into the wrong
language, and the run does not record what language pair it was supposed to use.

## Why this is the most serious open defect

Rubric must-have **#5** — *"Language pair selection (minimum: English ↔ Spanish)"* — was marked ✅ by
both a spec audit and a manual QA pass. **Both were wrong, and for the same reason: the selector
renders and switches, so the UI looks correct.** The selection simply never reaches the Realtime
session's instructions.

It also silently invalidates everything downstream:
- Every Arm A latency figure is timing a translation into an unrequested language
- WER against a Spanish reference is meaningless
- Blind compare would present a German sample against a Spanish one, and the evaluator would score
  it as a quality difference
- With the Cantonese track kept, this is precisely the mechanism that would make EN→YUE silently
  produce something else — the failure §10 says a text-only evaluation scores as a success

## Acceptance criteria

- [ ] The selected language pair and direction reach the Realtime session's instructions, and the
      model's output is in the requested target language
- [ ] The same holds for cascade — verify, do not assume; the MT stage may be correct while Realtime
      is not
- [ ] Every Run records the `languagePair` and `direction` actually used (ticket 061)
- [ ] A run whose output language cannot be confirmed is not silently aggregated
- [ ] **A test that would have caught this**: assert the target-language instruction reaches the
      transport, per pair AND per direction. A test asserting only that the selector re-renders is
      what let this ship.
- [ ] Re-run the three recorded takes afterwards and confirm Spanish output before any figure is
      reported

## Notes
- Do not fix this by post-hoc language detection on the output. The instruction must be correct at
  the source; detection would be a second thing to get wrong.
- This is the strongest argument in the repo for the re-run: every stored Arm A number is suspect.
