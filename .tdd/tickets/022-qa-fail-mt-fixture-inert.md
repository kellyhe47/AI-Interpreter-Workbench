---
id: 022
title: "?fixture=fail-mt injects no fault — the documented failure path is unreachable"
status: pending
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
