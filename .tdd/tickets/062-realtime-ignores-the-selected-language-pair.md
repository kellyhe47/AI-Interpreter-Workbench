---
id: 062
title: "Realtime translated English into GERMAN — the selected language pair never reaches the session"
status: pending
source: verification (missed by both the spec audit and the QA pass)
depends_on: []
touches: [src/client/transport/realtime.ts, src/client/views/useSessionController.ts, src/client/replay/runner.ts]
iterations: 0
test_files: []
branch: ""
---

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
