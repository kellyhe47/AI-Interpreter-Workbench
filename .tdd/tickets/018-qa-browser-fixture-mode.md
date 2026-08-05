---
id: 018
title: Dev-only browser fixture mode (?fixture=1) — fixture transports + fake capture in the real SPA
status: pending
source: qa
depends_on: []
touches: [src/client/browserDeps.ts, src/client/main.tsx, src/client/fixtureDeps.ts]
test_files: []
iterations: 0
---

## Finding (QA iteration 1, sha aa9a6c0)
All live-session journeys (transcripts, switch-queued banner mid-session, arms strip /
comparison cards with labelled ms, blind compare, stop summary, reconnect banners) are
unreachable in a real browser without a grantable microphone — production deps only.
Expected: PRD §7 — "Fixture providers … are used for development, CI, error-path tests, and
long-running stability runs"; the benchmark harness drives the real SPA in a browser. A
browser-reachable fixture path is the enabler for manual QA and the future Playwright runner.

## Acceptance criteria
1. `?fixture=1` (or VITE env flag) makes App build fixture deps instead of browser deps:
   FixtureTransport-backed arm catalog (scripted utterances incl. per-stage timings, one
   scripted failure injectable via `?fixture=fail-mt`), fake capture that "grants" without
   getUserMedia and emits synthetic level/chunks, fake playback context (silent), in-memory
   ledger, Date.now.
2. Production default (no flag) is byte-identical behavior to today.
3. Fixture-mode session: Start microphone → listening → scripted utterances flow through the
   real UI (source partials/final, target deltas, arm cards reach ready with labelled ms);
   comparison mode + blind compare drivable; stop produces a real summary.
4. Records created in fixture mode carry fixture provider names so the ledger keeps excluding
   them from Results (assert).
5. Unit test: fixture deps factory returns the shape App expects and is selected by the flag
   (no full-browser test required — that's what manual QA does next iteration).
