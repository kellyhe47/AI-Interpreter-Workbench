---
id: 022
title: "?fixture=fail-mt injects no fault — the documented failure path is unreachable"
status: closed-not-a-defect
source: qa
depends_on: []
touches: [src/client/fixtureDeps.ts]
iterations: 0
test_files: []
branch: ""
---

## Repro

1. Open `/?fixture=fail-mt`
2. Select **Cascade**
3. Start microphone and let the session run

Evidence: `.qa/screens/F5-fail-mt-inert.txt`

## Expected

`AGENTS.md` documents `?fixture=1` / `?fixture=fail-mt` as the browser-drivable fixture modes, with
`fail-mt` injecting an MT stage failure. PRD §12 makes the resulting copy a finding in its own right:

> Cascade — *"mt stage timed out for this utterance — session still running"*
> Realtime — *"opaque failure — no stage attribution · session still running"*
>
> The auditability gap does not only appear in the happy path's timing breakdown. It appears again,
> and more sharply, at the moment something breaks.

## Observed

`location.search === "?fixture=fail-mt"` is active and the session ran to **utterance 17** with no
stage failure ever surfacing. `/stage timed out/i` and `/opaque failure/i` are absent from the
document throughout; the target card status stayed `ready`.

The failure copy itself is implemented and correct elsewhere — Replay's failed-run card renders
*"tts stage timed out — run saved as failed, excluded from every aggregate"*. What is broken is the
documented manual path for exercising the Live failure state, which is also how a reviewer would see
the architecture-differentiated copy.

## Suggested direction

Restore fault injection in the fixture deps so `fail-mt` fails a specific utterance, and keep the
session alive afterwards (the PRD's point is that the session survives). Worth an assertion that the
fault actually fires, so this cannot go inert again unnoticed.

---

## CLOSED — not a defect (orchestrator, before dispatch)

**The finding was wrong. `?fixture=fail-mt` works exactly as specified.**

Cause of the false positive: `src/client/fixtureDeps.ts:348` fires the fault on
`utt === 1` (displayed *"utterance 2"*), and the failed state is **transient** — the next
utterance replaces the card about 4 s later. The QA pass first sampled at utterance 4 and
again at utterance 17, both after it had gone. The report even quoted v1's note that the
"session recovers and streams the next utterance normally", which should have prompted
polling rather than spot-checks.

Re-verified by polling the DOM every 150 ms from session start:

```
utterance: "utterance 2"
status:    failed
copy:      "mt stage timed out for this utterance — session still running"
session survived (Stop session still present): true
```

That is the exact PRD §12 cascade string, naming the failing stage, with the session
continuing. **No code change made.** Evidence: `.qa/screens/F5-CORRECTION-fail-mt-works.txt`

Method note for future QA: transient per-utterance states must be observed by polling,
not by spot-checking a long-running session.
