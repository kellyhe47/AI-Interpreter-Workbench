/**
 * Ticket 013 — Results view.
 *
 * `<ResultsView ledger={runLedger} />` — pure-props component (no context).
 * ALL figures come from deriveResultsModel(ledger) in
 * src/client/components/results/derive.ts; this component renders that
 * model verbatim and never computes or hardcodes a number. No sample /
 * fixture figure ever appears in the DOM.
 *
 * DOM contract (locked by ResultsView.test.tsx):
 *
 * - Header, always rendered: title 'Results' (600 22px) + subline
 *   'Four questions, one run ledger. Every figure carries its provenance;
 *   nothing here comes from a fixture run.'
 *   There is NO 'show recorded runs' switch — visibility derives from
 *   ledger.hasRuns.
 * - EMPTY STATE (!model.hasRuns — also a fixture/placeholder-only ledger):
 *   centered card with a chart glyph, 'No runs recorded' (600 14px),
 *   subline 'Run a benchmark sweep to populate experiment 1. Result cards
 *   never show sample data as evidence.', and a disabled 'Run sweep' button
 *   whose title/aria-label explain that sweeps need the real corpus.
 *   NONE of the four question cards is in the DOM, and the run-ledger table
 *   is absent too. No sample figures anywhere.
 * - WHEN hasRuns: four question cards (uppercase 10.5px tracked eyebrow,
 *   17px 600 title, mono 11px provenance line, metric grid, gray takeaway
 *   note in a sunken box):
 *     1. 'Track 1 of 3 · vendor held constant' /
 *        'Does the architecture itself cost latency?' — always rendered
 *        (exp1 model), columns realtime vs cascade·OpenAI vs delta.
 *     2. 'Track 2 of 3 · architecture held constant' /
 *        'What does swapping providers buy?' — metric grid only when
 *        model.exp2 exists, else its own empty note
 *        'no provider-swap runs recorded'.
 *     3. 'Track 1 · extended along time' /
 *        'What changes as the conversation continues?' — data only when
 *        model.stability exists, else 'no stability runs recorded'.
 *     4. 'Track 3 of 3 · exploratory case study' /
 *        'What does provider choice actually let us reach?' — coverage
 *        matrix only when model.coverage exists, else
 *        'no coverage observations recorded'.
 * - Run ledger table card, rendered whenever ANY real runs exist: title
 *   'Run ledger', subline 'One append-only ledger beneath every view. A
 *   metric cannot drift between screens or between a screen and the
 *   write-up.', grid header run id / experiment / configuration / pair /
 *   N / date, one row per run.
 * - Test hooks (style-agnostic, asserted instead of CSS classes):
 *     data-metric="<slug>"        on each metric-grid row (p50, p95, cost,
 *                                 wer, adequacy, fluency, intervals)
 *     data-tone="good|bad|neutral" on the row's delta cell (positive=green,
 *                                 negative=red, muted=gray styling keys off
 *                                 this attribute)
 *     data-provenance="exp1|exp2" on the mono provenance line of cards 1–2
 *     data-run-row                on each run-ledger table row
 *     data-mono                   on the mono run-id cell inside a run row
 */

import type { ReactElement } from 'react';
import type { RunLedger } from '../state/ledger';

export interface ResultsViewProps {
  ledger: RunLedger;
}

export default function ResultsView(props: ResultsViewProps): ReactElement {
  throw new Error('not implemented (ticket 013)');
}
