---
id: 009
title: Run ledger — append-only utterance records, aggregation, export, blind draws
status: green
depends_on: []
touches: [src/client/state/ledger.ts]
test_files: [src/client/state/ledger.test.ts]
iterations: 0
---

## Scope
`src/client/state/ledger.ts` (pure TS): append-only ledger of `UtteranceRecord`s (type from
core/timing.ts — if 001 not merged when this starts, define locally-compatible import path
src/core/timing.ts as the dependency; coordinate: this ticket only READS that type).
- append(record); records immutable once appended; grouped by runId.
- Aggregations: p50/p95 of end-to-end perceived latency per arm; session cost sum; utterance
  count; per-stage interval aggregates. Percentile = nearest-rank.
- Blind comparison draws: recordBlindDraw({utteranceId, order: [armA, armB], drawnAtRandom:
  boolean seed}) + scores appended with the draw persisted (PRD §9 — auditable blinding).
- JSON export: exportRuns() → serializable {runs: [{runId, config, records[]}]}; import back.
- localStorage persistence adapter (injectable storage; memory fallback) — client-side.
- `hasRuns` derivation: true only when ≥1 REAL (non-placeholder-corpus, non-fixture) record
  exists — records carry provenance {providers, corpusId}; fixture provider names or
  placeholder corpus ids ⇒ excluded from results aggregation entirely (PRD §7 hard rule).

## Acceptance criteria
1. append + get by run; mutation attempts on returned arrays don't alter store (defensive copy).
2. p50/p95 nearest-rank correct on a known 10-record set; empty ledger → null (not 0).
3. Fixture-provider records and placeholder-corpus records are excluded from aggregates and
   from hasRuns (empty-state stays until real data).
4. Blind draw persisted alongside scores; export contains draws; re-import round-trips equal.
5. Storage adapter: writes on append, restores on construction (fake storage in test).
