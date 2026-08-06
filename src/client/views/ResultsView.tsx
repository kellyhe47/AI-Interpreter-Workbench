/**
 * Ticket 015 — Results view (v2 two-tab shape).
 *
 * STUB. Ticket 015's tests are written first and are RED against this file;
 * the implementation ticket fills it in. The prop shape is deliberately
 * unchanged from v1 (`<ResultsView ledger={runLedger} />`) so App.tsx does
 * not have to move — ticket 016 owns App.
 *
 * The DOM contract the implementation must satisfy is locked by
 * ResultsView.test.tsx. In summary:
 *
 *   [data-results-tab="experiments" | "secondary"]  the mounted panel; exactly
 *                                                   one exists at a time
 *   role="tab" buttons 'Experiments' / 'By Recording & category', aria-selected
 *   [data-card="exp1"|"exp2"|"live"|"coverage"|"category"|"recording"]
 *   [data-eyebrow]                 track eyebrow inside a card
 *   [data-provenance="<card>"]     mono provenance line (also carries data-mono)
 *   [data-illustrative]            card-level 'illustrative' pill
 *   [data-takeaway]                gray takeaway box
 *   [data-empty-card="<card>"]     a card's own empty state
 *   [data-metric="<slug>"]         one metric-grid row
 *   [data-col="a"|"b"|"delta"]     cells of an exp1 / exp2 metric row
 *   [data-tone="good|bad|neutral"] on the delta cell
 *   [data-sidecar]                 exp1's Realtime WER cell
 *   [data-grid-header]             a metric grid's header row
 *   [data-live-column="realtime-default"|"realtime-trimmed"|"cascade"]
 *   [data-direction="<slug>"]      coverage row (a DIRECTION, never a pair)
 *   [data-stage="realtime"|"stt"|"mt"|"tts"]  coverage per-stage cell
 *   [data-observation]             coverage per-cell observation note
 *   [data-time-to-add]             one of the three time-to-add tiles
 *   [data-category-row][data-category="<category>"]
 *   [data-recording-row][data-recording="<id>"][data-arm][data-excluded]
 *   [data-exclusion="ad-hoc"|"manual"|"failed"|"fixture"]
 *
 * Every figure comes from src/client/components/results/derive.ts. This
 * component computes no metric and hardcodes no latency, cost, WER or
 * quality literal.
 */

import type { ReactElement } from 'react';
import type { RunLedger } from '../state/ledger';

export interface ResultsViewProps {
  ledger: RunLedger;
}

export default function ResultsView(_props: ResultsViewProps): ReactElement {
  return <div />;
}
