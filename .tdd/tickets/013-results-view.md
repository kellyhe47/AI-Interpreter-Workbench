---
id: 013
title: Results view — four question-titled cards, mandatory empty states, ledger table
status: pending
depends_on: [009]
touches: [src/client/views/ResultsView.tsx, src/client/components/results/*]
test_files: []
iterations: 0
---

## Scope
Results view per mock: header ('Results' + subline 'Four questions, one run ledger…'), NO mock
'show recorded runs' switch (real app derives from ledger). Empty state card (chart glyph, 'No
runs recorded', 'Run a benchmark sweep to populate experiment 1. Result cards never show
sample data as evidence.', 'Run sweep' button may be disabled/informational tonight). When
ledger hasRuns: four cards exactly as mock — Track 1 exp1 (question title 'Does the
architecture itself cost latency?', mono provenance line from ledger config, metric grid
p50/p95/cost/WER/adequacy/fluency/observable intervals, takeaway), Track 2 exp2 ('What does
swapping providers buy?', 'not pooled with track 1' provenance), Track 1-extended stability
('What changes as the conversation continues?' incl. red/green cell coloring + realtime-translate
takeaway), Track 3 coverage ('What does provider choice actually let us reach?', per-stage
coverage matrix with ok/no/verify/— cell colors, observation note block, three time-to-add
tiles with commit-hash provenance). Run ledger table card (run id mono, experiment, config,
pair, N, date). All figures computed from ledger records — never hardcoded; cards carry
'illustrative' amber pill ONLY if fed non-real data (should never happen tonight — empty
states rule). Top bar shows mono 'run … · corpus …' provenance only on this view when runs
exist.

## Acceptance criteria
1. Default (empty ledger): header + empty-state card only; NONE of the four question cards
   render; no sample figures anywhere in DOM.
2. With injected real-provenance ledger records: exp1 card renders p50/p95 computed from the
   records (assert one exact computed value), provenance line contains corpus version + N +
   'endpointing pinned 500 ms'.
3. Fixture-provider records injected → still empty state (PRD §7 fixtures-never-report rule).
4. Ledger table lists one row per run with mono run id.
5. Stability card renders only when a stability run exists in the ledger; coverage card
   renders observation notes from ledger annotations.
