/**
 * Ticket 013 — Results view data plumbing.
 *
 * Pure derivation layer: `deriveResultsModel(ledger)` turns the RunLedger
 * into a render-ready model. NO component reads the ledger directly — the
 * view renders this model verbatim, which keeps every figure traceable to
 * `ledger.aggregates()` / record fields and makes the math unit-testable
 * without the DOM.
 *
 * Design decisions (locked by derive.test.ts + ResultsView.test.tsx):
 *
 * - REALNESS: everything here inherits the ledger's realness rule.
 *   `model.hasRuns === ledger.hasRuns`; fixture/placeholder records never
 *   contribute a figure, a ledger row, or a card. A fixture-only ledger
 *   derives the exact same model as an empty one.
 * - Run classification by runId substring: a runId containing 'stability'
 *   is a stability run; containing 'coverage' is a coverage run; everything
 *   else is a benchmark run.
 * - exp1 (track 1): the FIRST benchmark run (first-appended order) that has
 *   real records for both a realtime-mode arm and a cascade-mode arm.
 *   Column A = the realtime arm, column B = the first cascade arm of that
 *   run. Rows in fixed order (metric slug / label):
 *     p50        'p50 latency'
 *     p95        'p95 latency'
 *     cost       'cost per min'
 *     wer        'word error rate'
 *     adequacy   'adequacy 1–5'
 *     fluency    'fluency 1–5'
 *     intervals  'observable intervals'
 *   Values:
 *     p50/p95  = formatMs of ledger.aggregates(runId).perArm[arm].p50Ms/p95Ms
 *     cost     = formatUsd(costUsd * 60000 / Σ audioDurationMs) per arm
 *     wer/adequacy/fluency = mean of the optional `annotations` field over
 *       the arm's records that carry it; '—' when absent from records.
 *       wer formatted `${(mean*100).toFixed(1)}%`, scores `mean.toFixed(1)`.
 *     intervals = count of named pipeline stages (excluding endToEnd)
 *       observable (non-null via deriveCascadeIntervals /
 *       deriveRealtimeIntervals) in at least one record of the arm — '3'
 *       for a fully-timed realtime arm, '5' for a fully-timed cascade arm.
 *   Delta column = B − A in the metric's native unit, rendered signed
 *   ('-0.24 s', '-$0.160', '-2.0%', '+1.0'); '—' when either side is
 *   missing, and always '—' for the intervals row.
 *   deltaTone ('good' | 'bad' | 'neutral', rendered as the delta cell's
 *   data-tone): lower-is-better metrics (p50, p95, cost, wer) → negative
 *   delta = 'good', positive = 'bad'; higher-is-better (adequacy, fluency)
 *   → positive = 'good'; zero, missing, or intervals → 'neutral'.
 * - Provenance line (exp1), built from the run's own records:
 *   '<pair> · <N> utterances × <reps> runs · endpointing pinned 500 ms ·
 *    turn-final trigger · <corpusId> · run <runId>'
 *   where pair/corpusId come from the run's records, N = distinct utterance
 *   keys per arm (utterance key = record.id up to an optional '#' suffix;
 *   the sweep runner appends '#rep<n>' per repetition), and reps =
 *   round(per-arm record count / N). 'endpointing pinned 500 ms ·
 *   turn-final trigger' is the pinned experimental control, stated verbatim.
 * - exp2 (track 2): present iff some benchmark run holds real records for
 *   TWO OR MORE distinct cascade-mode arms (a provider-swap run — swaps are
 *   compared within their own run, never pooled with track 1). Column A =
 *   first cascade arm of that run, column B = second. Same row set as exp1.
 *   Its provenance ends with '· not pooled with track 1'.
 * - stability (track 1 extended): present iff a stability run has real
 *   records. Model carries { runId, count } (per-position drift rendering
 *   is a later ticket).
 * - coverage (track 3): present iff a coverage run has real records
 *   annotated with a `stage` (via the optional `annotations` field).
 *   Matrix: stages and arms in first-appearance order,
 *   counts[stage][arm] = number of real annotated records.
 * - ledgerRows: one row per run with ≥1 REAL record, first-appended order.
 *   { runId, experiment: 'benchmark' | 'stability' | 'coverage',
 *     configuration: distinct arms in appearance order joined ' vs ',
 *     pair: languagePair of the run's first real record,
 *     n: real-record count,
 *     date: ISO date (YYYY-MM-DD) of the earliest timings.speech_end,
 *           '—' when no record has one }.
 * - formatMs(ms): null → '—'; ms < 10000 → seconds with 2 decimals + ' s'
 *   ('1.02 s'); otherwise mm:ss from Math.round(ms/1000) with zero-padded
 *   seconds ('0:10', '1:05', '10:00').
 * - formatUsd(usd): null → '—'; otherwise '$' + usd.toFixed(3) ('$0.200').
 */

import type { UtteranceRecord } from '../../../core/timing';
import type { RunLedger } from '../../state/ledger';

/** Post-hoc quality annotations a record MAY carry (absent tonight). */
export interface RecordAnnotations {
  /** Word error rate as a fraction (0.12 = 12%). */
  wer?: number;
  /** Adequacy rating on the 1–5 scale. */
  adequacy?: number;
  /** Fluency rating on the 1–5 scale. */
  fluency?: number;
  /** Conversation stage label for the track-3 coverage matrix. */
  stage?: string;
}

/** UtteranceRecord extended with the optional annotations envelope. */
export type AnnotatedUtteranceRecord = UtteranceRecord & {
  annotations?: RecordAnnotations;
};

export type Tone = 'good' | 'bad' | 'neutral';

export type MetricSlug =
  | 'p50'
  | 'p95'
  | 'cost'
  | 'wer'
  | 'adequacy'
  | 'fluency'
  | 'intervals';

export interface MetricRow {
  /** Stable slug, rendered as data-metric on the row element. */
  metric: MetricSlug;
  /** Human label for the secondary label column. */
  label: string;
  /** Formatted value for column A (exp1: the realtime arm). */
  valueA: string;
  /** Formatted value for column B (exp1: the cascade arm). */
  valueB: string;
  /** Signed formatted delta (B − A), or '—'. */
  delta: string;
  /** Tone for the delta cell, rendered as data-tone. */
  deltaTone: Tone;
}

export interface ComparisonCardModel {
  /** Mono provenance line — every figure's origin in one string. */
  provenance: string;
  /** Arm id feeding column A. */
  armA: string;
  /** Arm id feeding column B. */
  armB: string;
  rows: MetricRow[];
}

export interface StabilityModel {
  runId: string;
  /** Real-record count in the stability run. */
  count: number;
}

export interface CoverageModel {
  /** Stage labels in first-appearance order. */
  stages: string[];
  /** Arm ids in first-appearance order. */
  arms: string[];
  /** counts[stage][arm] = real annotated record count. */
  counts: { [stage: string]: { [arm: string]: number } };
}

export interface LedgerRow {
  runId: string;
  experiment: 'benchmark' | 'stability' | 'coverage';
  configuration: string;
  pair: string;
  n: number;
  date: string;
}

export interface ResultsModel {
  hasRuns: boolean;
  exp1?: ComparisonCardModel;
  exp2?: ComparisonCardModel;
  stability?: StabilityModel;
  coverage?: CoverageModel;
  ledgerRows: LedgerRow[];
}

/** Format a millisecond duration per the locked rule (see module docs). */
export function formatMs(ms: number | null): string {
  throw new Error('not implemented (ticket 013)');
}

/** Format a USD amount per the locked rule (see module docs). */
export function formatUsd(usd: number | null): string {
  throw new Error('not implemented (ticket 013)');
}

/** Derive the full, render-ready Results model from the ledger. */
export function deriveResultsModel(ledger: RunLedger): ResultsModel {
  throw new Error('not implemented (ticket 013)');
}
