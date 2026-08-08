---
id: 050
title: A run record POST that goes unacknowledged loses its ledger row forever — make the POST idempotent by run id
status: pending
source: code-review (048 round 4)
depends_on: [048]
touches: [src/server/routes/runs.ts, src/server/storage/index.ts, src/client/replay/runner.ts]
iterations: 0
test_files: []
branch: ""
---

## Why

Ticket 048 bounded the ledger POST so a hung `runs.create` can no longer stall a sweep. That was
correct, and it converted one failure into another: **the run now returns `complete` with its
measurement intact and no row is ever stored.**

Probe from 048's round-4 review — 3 reps, rep 2's POST never answers:
```
ledger rows: rep 1, rep 3     n = 2     provenance: "2 of 2 reps completed"
summary.completedRuns = 3     summary.failures = []
```
Three reps ran. Two rows exist. The provenance line claims **2 of 2**. That is the exact dishonesty
AGENTS.md names — *"the denominator silently falls back to the numerator and every line reads a
clean N of N"* — because `intendedReps` is derived from ledger rows, so a rep with no row is not
merely uncounted, it is **invisible**.

048 lands the minimum fix: the batch stops REPORTING such a run as completed and surfaces it in
`summary.failures`. That makes the loss visible in the sweep summary. **It does not restore the
row**, so the provenance line is still computed over a set that is missing a rep.

The reason 048 cannot simply retry the POST is that it is not safe to: the client cannot tell
"the server never received it" from "the server stored it and the response was lost". Retrying the
second case creates the duplicate aggregatable Run that 048 spent three rounds eliminating.

## Scope

Make the run POST idempotent by run id, so a retry is safe and the row is exactly-once.

The run id is minted client-side before the POST, which is what makes this tractable.

## Acceptance criteria

- [ ] `POST /api/runs` with a run id that already exists is a no-op that reports success — it does
      NOT create a second row, and does NOT overwrite the stored record
- [ ] The append-only ledger gains exactly one line per run id, no matter how many times the POST is
      delivered. Runs are stored twice by design (queryable `data/runs/<id>.json` + `ledger.jsonl`)
      — BOTH must be exactly-once
- [ ] `runOnce` retries an unacknowledged POST at least once, and a run whose retry succeeds is
      stored normally with `status` unchanged
- [ ] A run whose POST fails on every attempt still returns its measurement to the caller and is
      surfaced by the batch in `summary.failures` (048's behaviour — do not regress it)
- [ ] A rep that reaches the ledger via a retry is counted ONCE in `intendedReps` and once in
      `completedReps` — assert the RENDERED provenance line, not the intermediate counts
- [ ] The retry cannot reintroduce 048's duplicate: assert that a POST delivered twice (once late,
      once as a retry) yields exactly one aggregatable Run for the rep

## Notes

- `isAggregatableRun` stays the ONE place that decides aggregation. Do not add a second gate.
- Follow 048's `withDeadline` shape for the retry bound; do not nest a second deadline inside
  `RUN_POST_TIMEOUT_MS`.
- The server currently assigns its own id in at least one adjacent route (`POST /api/recordings`) —
  check before assuming the run route honours the client's id.
