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

import {
  ARMS,
  REALTIME_MODEL,
  armLabel,
  deriveArmTag,
  type ArmTag,
} from '../../../core/arms';
import type { CorpusCategory } from '../../../harness/corpus';
import {
  deriveCascadeIntervals,
  deriveRealtimeIntervals,
  type CascadeTimestamps,
  type RealtimeTimestamps,
  type UtteranceRecord,
} from '../../../core/timing';
import {
  isAggregatableRun,
  isRealRecord,
  isRealRun,
  runArmTag,
  type LiveSession,
  type Run,
  type RunLedger,
  type RunOrigin,
} from '../../state/ledger';

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
  if (ms === null) return '—';
  if (ms < 10_000) return `${(ms / 1000).toFixed(2)} s`;
  const totalSeconds = Math.round(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

/** Format a USD amount per the locked rule (see module docs). */
export function formatUsd(usd: number | null): string {
  if (usd === null) return '—';
  return `$${usd.toFixed(3)}`;
}

type RunClass = 'benchmark' | 'stability' | 'coverage';

function classifyRun(runId: string): RunClass {
  if (runId.includes('stability')) return 'stability';
  if (runId.includes('coverage')) return 'coverage';
  return 'benchmark';
}

/** Distinct arm ids in first-appearance order. */
function armsOf(records: AnnotatedUtteranceRecord[]): string[] {
  const arms: string[] = [];
  for (const r of records) {
    if (!arms.includes(r.arm)) arms.push(r.arm);
  }
  return arms;
}

function sign(value: number): string {
  return value < 0 ? '-' : '+';
}

/** Mean of an optional annotation over the records that carry it, or null. */
function annotationMean(
  records: AnnotatedUtteranceRecord[],
  key: 'wer' | 'adequacy' | 'fluency',
): number | null {
  const values = records
    .map((r) => r.annotations?.[key])
    .filter((v): v is number => typeof v === 'number');
  if (values.length === 0) return null;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

/** Cost per audio minute for an arm's records, or null. */
function costPerMin(records: AnnotatedUtteranceRecord[]): number | null {
  const audioMs = records.reduce((sum, r) => sum + r.audioDurationMs, 0);
  if (audioMs === 0) return null;
  const costUsd = records.reduce((sum, r) => sum + r.costUnits, 0);
  return (costUsd * 60_000) / audioMs;
}

/** Count of named pipeline stages (excluding endToEnd) observable in ≥1 record. */
function observableIntervals(records: AnnotatedUtteranceRecord[]): number {
  const observed = new Set<string>();
  for (const r of records) {
    const intervals =
      r.mode === 'realtime'
        ? deriveRealtimeIntervals(r.timings as RealtimeTimestamps)
        : deriveCascadeIntervals(r.timings as CascadeTimestamps);
    for (const [stage, value] of Object.entries(intervals)) {
      if (stage !== 'endToEnd' && value !== null) observed.add(`${r.mode}:${stage}`);
    }
  }
  return observed.size;
}

interface MetricValues {
  /** Raw numeric value per side (null = absent). */
  a: number | null;
  b: number | null;
  valueA: string;
  valueB: string;
}

function metricRow(
  metric: MetricSlug,
  label: string,
  values: MetricValues,
  direction: 'lower' | 'higher' | 'none',
  formatDelta: (delta: number) => string,
): MetricRow {
  let delta = '—';
  let deltaTone: Tone = 'neutral';
  if (direction !== 'none' && values.a !== null && values.b !== null) {
    const d = values.b - values.a;
    delta = formatDelta(d);
    if (d !== 0) {
      const improved = direction === 'lower' ? d < 0 : d > 0;
      deltaTone = improved ? 'good' : 'bad';
    }
  }
  return { metric, label, valueA: values.valueA, valueB: values.valueB, delta, deltaTone };
}

/** Utterance key = record id up to an optional '#' suffix. */
function utteranceKey(id: string): string {
  const hash = id.indexOf('#');
  return hash === -1 ? id : id.slice(0, hash);
}

function buildComparisonCard(
  ledger: RunLedger,
  runId: string,
  records: AnnotatedUtteranceRecord[],
  armA: string,
  armB: string,
  provenanceSuffix: string,
): ComparisonCardModel {
  const recordsA = records.filter((r) => r.arm === armA);
  const recordsB = records.filter((r) => r.arm === armB);
  const perArm = ledger.aggregates(runId).perArm;

  const msRow = (metric: 'p50' | 'p95', label: string): MetricRow => {
    const a = perArm[armA]?.[metric === 'p50' ? 'p50Ms' : 'p95Ms'] ?? null;
    const b = perArm[armB]?.[metric === 'p50' ? 'p50Ms' : 'p95Ms'] ?? null;
    return metricRow(
      metric,
      label,
      { a, b, valueA: formatMs(a), valueB: formatMs(b) },
      'lower',
      (d) => `${sign(d)}${formatMs(Math.abs(d))}`,
    );
  };

  const costA = costPerMin(recordsA);
  const costB = costPerMin(recordsB);
  const annotationRow = (
    metric: 'wer' | 'adequacy' | 'fluency',
    label: string,
    direction: 'lower' | 'higher',
  ): MetricRow => {
    const a = annotationMean(recordsA, metric);
    const b = annotationMean(recordsB, metric);
    const format = (v: number | null): string => {
      if (v === null) return '—';
      return metric === 'wer' ? `${(v * 100).toFixed(1)}%` : v.toFixed(1);
    };
    const formatDelta = (d: number): string =>
      metric === 'wer'
        ? `${sign(d)}${(Math.abs(d) * 100).toFixed(1)}%`
        : `${sign(d)}${Math.abs(d).toFixed(1)}`;
    return metricRow(metric, label, { a, b, valueA: format(a), valueB: format(b) }, direction, formatDelta);
  };

  const rows: MetricRow[] = [
    msRow('p50', 'p50 latency'),
    msRow('p95', 'p95 latency'),
    metricRow(
      'cost',
      'cost per min',
      { a: costA, b: costB, valueA: formatUsd(costA), valueB: formatUsd(costB) },
      'lower',
      (d) => `${sign(d)}${formatUsd(Math.abs(d))}`,
    ),
    annotationRow('wer', 'word error rate', 'lower'),
    annotationRow('adequacy', 'adequacy 1–5', 'higher'),
    annotationRow('fluency', 'fluency 1–5', 'higher'),
    metricRow(
      'intervals',
      'observable intervals',
      {
        a: null,
        b: null,
        valueA: String(observableIntervals(recordsA)),
        valueB: String(observableIntervals(recordsB)),
      },
      'none',
      () => '—',
    ),
  ];

  const first = records[0]!;
  const utterances = new Set(recordsA.map((r) => utteranceKey(r.id)));
  const n = utterances.size;
  const reps = n === 0 ? 0 : Math.round(recordsA.length / n);
  const provenance =
    `${first.languagePair} · ${n} utterances × ${reps} runs · ` +
    'endpointing pinned 500 ms · turn-final trigger · ' +
    `${first.corpusId} · run ${runId}${provenanceSuffix}`;

  return { provenance, armA, armB, rows };
}

/** Derive the full, render-ready Results model from the ledger. */
export function deriveResultsModel(ledger: RunLedger): ResultsModel {
  const real = (ledger.getRecords() as AnnotatedUtteranceRecord[]).filter(isRealRecord);

  // Group real records by run, first-appended order.
  const runIds: string[] = [];
  const byRun = new Map<string, AnnotatedUtteranceRecord[]>();
  for (const r of real) {
    let run = byRun.get(r.runId);
    if (!run) {
      run = [];
      byRun.set(r.runId, run);
      runIds.push(r.runId);
    }
    run.push(r);
  }

  const model: ResultsModel = {
    hasRuns: ledger.hasRuns,
    ledgerRows: [],
  };

  for (const runId of runIds) {
    const records = byRun.get(runId)!;
    const experiment = classifyRun(runId);

    // exp1: first benchmark run with both a realtime-mode and a cascade-mode arm.
    if (!model.exp1 && experiment === 'benchmark') {
      const realtimeArm = records.find((r) => r.mode === 'realtime')?.arm;
      const cascadeArm = records.find((r) => r.mode === 'cascade')?.arm;
      if (realtimeArm !== undefined && cascadeArm !== undefined) {
        model.exp1 = buildComparisonCard(ledger, runId, records, realtimeArm, cascadeArm, '');
      }
    }

    // exp2: first benchmark run with two or more distinct cascade-mode arms.
    if (!model.exp2 && experiment === 'benchmark') {
      const cascadeArms = armsOf(records.filter((r) => r.mode === 'cascade'));
      if (cascadeArms.length >= 2) {
        model.exp2 = buildComparisonCard(
          ledger,
          runId,
          records,
          cascadeArms[0]!,
          cascadeArms[1]!,
          ' · not pooled with track 1',
        );
      }
    }

    // stability: first stability-marked run with real records.
    if (!model.stability && experiment === 'stability') {
      model.stability = { runId, count: records.length };
    }

    // coverage: stage-annotated records of coverage runs.
    if (experiment === 'coverage') {
      for (const r of records) {
        const stage = r.annotations?.stage;
        if (stage === undefined) continue;
        if (!model.coverage) {
          model.coverage = { stages: [], arms: [], counts: {} };
        }
        if (!model.coverage.stages.includes(stage)) model.coverage.stages.push(stage);
        if (!model.coverage.arms.includes(r.arm)) model.coverage.arms.push(r.arm);
        const byStage = (model.coverage.counts[stage] ??= {});
        byStage[r.arm] = (byStage[r.arm] ?? 0) + 1;
      }
    }

    // Ledger row.
    const speechEnds = records
      .map((r) => (r.timings as { speech_end?: number }).speech_end)
      .filter((t): t is number => typeof t === 'number');
    model.ledgerRows.push({
      runId,
      experiment,
      configuration: armsOf(records).join(' vs '),
      pair: records[0]!.languagePair,
      n: records.length,
      date:
        speechEnds.length === 0
          ? '—'
          : new Date(Math.min(...speechEnds)).toISOString().slice(0, 10),
    });
  }

  return model;
}

/* =========================================================================
 * Ticket 011 — v2 derivation over the Recording / Run / LiveSession entities.
 *
 * The v1 surface above (deriveResultsModel and friends) still classifies runs
 * by runId substring and reads UtteranceRecords. It is retired by ticket 015
 * and left in place only so ResultsView.test.tsx keeps passing between
 * tickets. Everything below is the v2 model:
 *
 * - THE GATE IS THE LEDGER'S. Experiment figures come from
 *   `ledger.runAggregates()` — derived armTag names an arm AND origin ===
 *   'sweep' AND status === 'complete' AND the realness rule. The gate is NOT
 *   reimplemented here; a run excluded from an aggregate is still listed in
 *   the per-Recording grouping, marked with WHY it was excluded.
 * - PROVENANCE REPORTS ACTUAL N. `completedReps` counts the distinct rep
 *   indices that actually produced a gate-passing Run; `intendedReps` counts
 *   the distinct rep indices the sweep attempted (any status). A sweep that
 *   intended 5 and lost one reads `4 of 5`, and the percentiles are computed
 *   over the surviving 4 — the number and the line agree.
 * - TWO GROUPINGS, ONE LEDGER. groupByRecording and groupByCategory read the
 *   same Runs as the aggregates. No second store, no recomputed gate.
 * - LIVE IS SEPARATE. deriveLiveModel reads LiveSessions and nothing else;
 *   a Run can never move a Live figure and vice versa.
 * - EMPTY MEANS EMPTY. Every derivation has an explicit empty state; a zero
 *   is a measurement, never a stand-in for "nothing recorded".
 *
 * The individual derivations, in the same terms:
 *
 * - deriveExperimentAggregates(ledger): n / p50Ms / p95Ms / costUsd are taken
 *   VERBATIM from `ledger.runAggregates()` — this function adds provenance and
 *   a cost-per-audio-minute normalization on top and decides nothing about
 *   membership. costPerMinuteUsd = costUsd / (Σ durationMs of the source
 *   Recordings of the arm's gate-passing Runs / 60000); null when no
 *   contributing Recording declares a duration (never 0).
 * - PROVENANCE (per arm, PRD §8 register):
 *     utteranceCount  distinct annotations.utteranceId over gate-passing Runs
 *                     (falling back to the recordingId when a Run carries no
 *                     utterance id).
 *     completedReps   distinct annotations.repIndex over gate-passing Runs —
 *                     the ACTUAL count.
 *     intendedReps    distinct annotations.repIndex over the arm's
 *                     sweep-origin, named-arm Runs of ANY status. Derived, not
 *                     declared: nothing extra has to be recorded for a sweep
 *                     that lost a rep to read '4 of 5'.
 *     endpointingMs   always PINNED_ENDPOINTING_MS — a pinned control, not a
 *                     measurement.
 *     corpusVersion   the first annotations.corpusVersion among the
 *                     contributing Runs; null when none declares one.
 *   The line's wording is not locked; the counts inside it are, and they are
 *   read from the same fields the figures are.
 * - groupByRecording(ledger): one row per (recordingId × configuration), in
 *   first-appended Run order. The configuration key is the Run's recipe —
 *   `realtime:<model snapshot>` or `cascade:<stt> → <mt> → <tts>` — so a row is
 *   one clip under one recipe. EVERY Run is listed, gate-passing or not: ad-hoc
 *   runs appear nowhere else, and a run silently dropped here would be a run
 *   the operator cannot find. runCount / failedCount / origins describe the
 *   whole group; n / p50Ms / p95Ms / costUsd describe only the complete, real
 *   Runs in it (a failed or fixture-sourced Run reports no figure, and null is
 *   never rendered as 0). excludedFromExperiments is true iff NO Run in the
 *   group passes `isAggregatableRun`; exclusionReasons lists, deduped in
 *   first-appearance order, why each excluded Run was excluded, tested in the
 *   order fixture → ad-hoc → manual → failed so the reason named is the one
 *   that disqualifies the Run first.
 * - groupByCategory(ledger): one row per (annotations.category × derived arm)
 *   over gate-passing Runs ONLY. Categories are distributed across recordings
 *   (PRD §9), so this is the grouping the findings actually live in and it is
 *   deliberately NOT reconstructible from any per-recording row.
 * - deriveComparison(ledger, armA, armB): p50 / p95 / cost rows in the v1
 *   MetricRow vocabulary (lower-is-better, delta = B − A). cost is per audio
 *   minute. werCell is STT_UNCHANGED_CELL whenever the two arms share an STT
 *   stage (`sttUnchangedBetween`), because there is no STT delta to report;
 *   otherwise the mean-WER delta over the arms' annotations, or '—' when
 *   either side carries none. null when either arm has no gate-passing sample.
 * - deriveLiveModel(ledger): one column per derived arm over LiveSessions.
 *   Percentiles are computed over the sessions' own utterances (pooled when an
 *   arm has several), falling back to the session's declared percentiles when
 *   no utterance carries a usable pair of timestamps. Drift and cost-per-minute
 *   are means over the sessions that report them. wer is ALWAYS null (PRD §7).
 * ====================================================================== */

/** The pinned endpointing control (PRD §8 register). Stated in every line. */
export const PINNED_ENDPOINTING_MS = 500;

/**
 * Exp 2 compares Arm B with Arm C, which differ in the TTS stage alone. The
 * STT transcript is byte-identical, so there is no WER delta to report — the
 * cell says so instead of carrying a fabricated number.
 */
export const STT_UNCHANGED_CELL = '— (STT unchanged)';

/** The six PRD §9 utterance categories — the meaningful analytical grouping. */
export type UtteranceCategory = CorpusCategory;

/**
 * Utterance-level metadata a Run MAY carry. Declared here as an optional
 * envelope (the v1 `annotations` pattern) rather than widening the stored Run
 * type, which is the server's.
 */
export interface RunAnnotations {
  /** Which corpus utterance this Run replayed. */
  utteranceId?: string;
  /** PRD §9 category tag — distributed across recordings, never grouped. */
  category?: UtteranceCategory;
  /** 1-based repetition index within the sweep. */
  repIndex?: number;
  /** Corpus version behind the sample. */
  corpusVersion?: string;
  /** Post-hoc word error rate as a fraction. */
  wer?: number;
}

export type AnnotatedRun = Run & { annotations?: RunAnnotations };

/** PRD §8: every figure carries its origin. A number without one is a claim. */
export interface Provenance {
  /** Distinct utterances behind the figure. */
  utteranceCount: number;
  /** ACTUAL reps that completed. NEVER the intended count. */
  completedReps: number;
  /** Reps the sweep set out to run. */
  intendedReps: number;
  /** The pinned endpointing control in ms — always PINNED_ENDPOINTING_MS. */
  endpointingMs: number;
  /** Corpus version; null when no contributing sample declares one. */
  corpusVersion: string | null;
  /** Rendered line. Exact wording is NOT locked — assert containment only. */
  line: string;
}

/** One named arm's experiment aggregate. `n` is the ACTUAL sample count. */
export interface ExperimentArmAggregate {
  arm: ArmTag;
  n: number;
  p50Ms: number | null;
  p95Ms: number | null;
  costUsd: number;
  /** Cost per audio minute, normalized by the source Recordings' duration. */
  costPerMinuteUsd: number | null;
  provenance: Provenance;
}

export interface ExperimentAggregates {
  /** Keyed by DERIVED arm tag; named arms only. Empty when nothing qualifies. */
  perArm: { [arm: string]: ExperimentArmAggregate };
  /** True when no Run passes the gate — an explicit empty state, not zeros. */
  empty: boolean;
}

/** Why a Run is kept out of the experiment aggregates. */
export type ExclusionReason = 'ad-hoc' | 'manual' | 'failed' | 'fixture';

/** One row of the "By Recording" secondary tab: recording × configuration. */
export interface RecordingGroupRow {
  recordingId: string;
  /** Recording label, or null when the Recording entity is not in the ledger. */
  recordingLabel: string | null;
  /** DERIVED arm tag — 'ad-hoc' for a free-exploration configuration. */
  arm: ArmTag;
  /** Stable configuration key; (recordingId, configuration) is unique. */
  configuration: string;
  origins: RunOrigin[];
  /** Runs in the group, every status included. */
  runCount: number;
  /** Failed runs in the group. */
  failedCount: number;
  /** Samples actually backing the figures below (complete + real). */
  n: number;
  p50Ms: number | null;
  p95Ms: number | null;
  costUsd: number;
  /** True when NO run in the group reaches the experiment aggregates. */
  excludedFromExperiments: boolean;
  /** Why, for the runs that are excluded. Empty when nothing is excluded. */
  exclusionReasons: ExclusionReason[];
}

/** One row of the "By utterance category" secondary tab: category × arm. */
export interface CategoryGroupRow {
  category: UtteranceCategory;
  arm: ArmTag;
  n: number;
  p50Ms: number | null;
  p95Ms: number | null;
  costUsd: number;
}

/** A head-to-head between two named arms, built from gate-passing Runs only. */
export interface ComparisonModel {
  armA: ArmTag;
  armB: ArmTag;
  /** p50 / p95 / cost rows, reusing the v1 MetricRow vocabulary. */
  rows: MetricRow[];
  /** STT_UNCHANGED_CELL when the two arms share an STT stage. */
  werCell: string;
  provenanceA: Provenance;
  provenanceB: Provenance;
}

/** One column of the conversation-length screen. Sourced from LiveSessions. */
export interface LiveArmColumn {
  arm: ArmTag;
  label: string;
  sessions: number;
  utterancesCompleted: number;
  disconnects: number;
  p50Ms: number | null;
  p95Ms: number | null;
  driftMinute1ToEndMs: number | null;
  costPerMinuteMinute1: number | null;
  costPerMinuteFinalMinute: number | null;
  /** ALWAYS null in Live — there is no reference text (PRD §7). */
  wer: null;
}

export interface LiveModel {
  columns: LiveArmColumn[];
  empty: boolean;
}

/* ------------------------------------------------------- shared v2 helpers -- */

/** Nearest-rank percentile, the same formula the ledger uses: sorted[⌈p·n⌉−1]. */
function nearestRank(sorted: number[], p: number): number {
  return sorted[Math.ceil(p * sorted.length) - 1]!;
}

interface Percentiles {
  p50Ms: number | null;
  p95Ms: number | null;
}

/** p50/p95 over a sample set. No samples → null, never 0. */
function percentilesOf(samples: number[]): Percentiles {
  if (samples.length === 0) return { p50Ms: null, p95Ms: null };
  const sorted = [...samples].sort((a, b) => a - b);
  return { p50Ms: nearestRank(sorted, 0.5), p95Ms: nearestRank(sorted, 0.95) };
}

/** Perceived end-to-end latency of a Run, or null when either stamp is absent. */
function runLatencyMs(run: Run): number | null {
  const speechEnd = run.timings?.speech_end;
  const audioQueued = run.timings?.audio_queued;
  if (typeof speechEnd !== 'number' || typeof audioQueued !== 'number') return null;
  return audioQueued - speechEnd;
}

/** The Run's recipe as a stable key: (recordingId, configuration) is unique. */
function configurationKey(run: Run): string {
  if (run.architecture === 'realtime') {
    return `realtime · ${run.modelSnapshots?.realtime ?? REALTIME_MODEL}`;
  }
  const triple = run.providerTriple;
  if (!triple) return 'cascade · (unspecified)';
  return `cascade · ${triple.stt} → ${triple.mt} → ${triple.tts}`;
}

/** The arm a LiveSession belongs to — derived from its recipe, like a Run's. */
function liveArmTag(session: LiveSession): ArmTag {
  return deriveArmTag({
    architecture: session.architecture,
    realtimeModel: session.modelSnapshots?.realtime,
    providers: session.providerTriple,
  });
}

/**
 * Why this Run is not in the experiment aggregates, or null when it IS.
 * Membership itself is never re-decided here — `isAggregatableRun` answers
 * that, and this only explains an answer the ledger already gave.
 */
function exclusionReasonFor(run: Run): ExclusionReason | null {
  if (isAggregatableRun(run)) return null;
  if (!isRealRun(run)) return 'fixture';
  if (runArmTag(run) === 'ad-hoc') return 'ad-hoc';
  if (run.origin !== 'sweep') return 'manual';
  return 'failed';
}

/** Distinct values of an annotation over a set of Runs. */
function distinct<T>(values: Array<T | undefined>): Set<T> {
  const set = new Set<T>();
  for (const v of values) {
    if (v !== undefined) set.add(v);
  }
  return set;
}

function meanOf(values: number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

/**
 * Provenance for one arm. `gatePassing` are the Runs actually behind the
 * figures; `attempted` are every sweep-origin Run the arm set out to run, of
 * ANY status — the difference between the two is what makes `4 of 5` true.
 */
function buildProvenance(
  arm: ArmTag,
  gatePassing: AnnotatedRun[],
  attempted: AnnotatedRun[],
): Provenance {
  const utteranceCount = distinct(
    gatePassing.map((r) => r.annotations?.utteranceId ?? r.recordingId),
  ).size;

  const completedRepIndices = distinct(gatePassing.map((r) => r.annotations?.repIndex));
  const completedReps = completedRepIndices.size > 0 ? completedRepIndices.size : gatePassing.length;

  const attemptedRepIndices = distinct(attempted.map((r) => r.annotations?.repIndex));
  const intendedReps = attemptedRepIndices.size > 0 ? attemptedRepIndices.size : completedReps;

  const corpusVersion =
    gatePassing.map((r) => r.annotations?.corpusVersion).find((v) => v !== undefined) ?? null;

  const line =
    `${armLabel(arm)} · ${utteranceCount} utterances · ` +
    `${completedReps} of ${intendedReps} reps completed · ` +
    `endpointing pinned ${PINNED_ENDPOINTING_MS} ms · turn-final trigger · ` +
    `${corpusVersion ?? 'corpus version unrecorded'}`;

  return {
    utteranceCount,
    completedReps,
    intendedReps,
    endpointingMs: PINNED_ENDPOINTING_MS,
    corpusVersion,
    line,
  };
}

/** The STT stage an arm pins, or null for a configuration that is no arm. */
function sttStageOf(arm: ArmTag): string | null {
  const definition = ARMS.find((a) => a.tag === arm);
  if (!definition) return null;
  if (definition.config.architecture === 'realtime') {
    // A realtime arm has no separable STT stage: the speech-to-speech model IS
    // the transcriber, so its identity is what would have to match.
    return `realtime:${definition.config.realtimeModel ?? REALTIME_MODEL}`;
  }
  return definition.config.providers?.stt ?? null;
}

/**
 * True when `armA` and `armB` share an identical STT stage, so no STT-derived
 * delta (WER) exists between them.
 */
export function sttUnchangedBetween(armA: ArmTag, armB: ArmTag): boolean {
  const a = sttStageOf(armA);
  const b = sttStageOf(armB);
  return a !== null && b !== null && a === b;
}

/** Experiment aggregates over gate-passing Runs, with per-arm provenance. */
export function deriveExperimentAggregates(ledger: RunLedger): ExperimentAggregates {
  const runs = ledger.getRuns() as AnnotatedRun[];
  const durationByRecording = new Map(ledger.getRecordings().map((r) => [r.id, r.durationMs]));

  // The gate is the ledger's, and so are the figures it produces.
  const perArm: { [arm: string]: ExperimentArmAggregate } = {};
  for (const [arm, entry] of Object.entries(ledger.runAggregates().perArm)) {
    const tag = arm as ArmTag;
    const gatePassing = runs.filter((run) => isAggregatableRun(run) && runArmTag(run) === tag);
    const attempted = runs.filter((run) => run.origin === 'sweep' && runArmTag(run) === tag);

    const audioMs = gatePassing.reduce(
      (sum, run) => sum + (durationByRecording.get(run.recordingId) ?? 0),
      0,
    );

    perArm[arm] = {
      arm: tag,
      n: entry.n,
      p50Ms: entry.p50Ms,
      p95Ms: entry.p95Ms,
      costUsd: entry.costUsd,
      costPerMinuteUsd: audioMs === 0 ? null : (entry.costUsd * 60_000) / audioMs,
      provenance: buildProvenance(tag, gatePassing, attempted),
    };
  }

  return { perArm, empty: Object.keys(perArm).length === 0 };
}

/**
 * "By Recording": one row per (recording × configuration), INCLUDING ad-hoc
 * and manual runs, each marked excluded-from-experiments with the reason.
 */
export function groupByRecording(ledger: RunLedger): RecordingGroupRow[] {
  const labelByRecording = new Map(ledger.getRecordings().map((r) => [r.id, r.label]));

  const order: string[] = [];
  const groups = new Map<string, Run[]>();
  for (const run of ledger.getRuns()) {
    const key = `${run.recordingId}|${configurationKey(run)}`;
    let group = groups.get(key);
    if (!group) {
      group = [];
      groups.set(key, group);
      order.push(key);
    }
    group.push(run);
  }

  return order.map((key) => {
    const group = groups.get(key)!;
    const first = group[0]!;

    // Figures come from the complete, real runs only. A failed run is real
    // information and stays listed; it is simply not a latency sample.
    const measured = group.filter((run) => run.status === 'complete' && isRealRun(run));
    const samples = measured
      .map(runLatencyMs)
      .filter((ms): ms is number => ms !== null);

    const origins: RunOrigin[] = [];
    for (const run of group) {
      if (!origins.includes(run.origin)) origins.push(run.origin);
    }

    const exclusionReasons: ExclusionReason[] = [];
    for (const run of group) {
      const reason = exclusionReasonFor(run);
      if (reason !== null && !exclusionReasons.includes(reason)) exclusionReasons.push(reason);
    }

    return {
      recordingId: first.recordingId,
      recordingLabel: labelByRecording.get(first.recordingId) ?? null,
      arm: runArmTag(first),
      configuration: configurationKey(first),
      origins,
      runCount: group.length,
      failedCount: group.filter((run) => run.status === 'failed').length,
      n: measured.length,
      ...percentilesOf(samples),
      costUsd: measured.reduce((sum, run) => sum + run.cost, 0),
      excludedFromExperiments: !group.some(isAggregatableRun),
      exclusionReasons,
    };
  });
}

/** "By utterance category": grouped on the category tag, never the recording. */
export function groupByCategory(ledger: RunLedger): CategoryGroupRow[] {
  const order: string[] = [];
  const groups = new Map<string, AnnotatedRun[]>();

  for (const run of ledger.getRuns() as AnnotatedRun[]) {
    if (!isAggregatableRun(run)) continue;
    const category = run.annotations?.category;
    if (category === undefined) continue;
    const key = `${category}|${runArmTag(run)}`;
    let group = groups.get(key);
    if (!group) {
      group = [];
      groups.set(key, group);
      order.push(key);
    }
    group.push(run);
  }

  return order.map((key) => {
    const group = groups.get(key)!;
    const first = group[0]!;
    const samples = group.map(runLatencyMs).filter((ms): ms is number => ms !== null);
    return {
      category: first.annotations!.category!,
      arm: runArmTag(first),
      n: group.length,
      ...percentilesOf(samples),
      costUsd: group.reduce((sum, run) => sum + run.cost, 0),
    };
  });
}

/** Head-to-head for two named arms; null when either arm has no samples. */
export function deriveComparison(
  ledger: RunLedger,
  armA: ArmTag,
  armB: ArmTag,
): ComparisonModel | null {
  const aggregates = deriveExperimentAggregates(ledger).perArm;
  const a = aggregates[armA];
  const b = aggregates[armB];
  if (!a || !b) return null;

  const msRow = (metric: 'p50' | 'p95', label: string): MetricRow => {
    const valueA = metric === 'p50' ? a.p50Ms : a.p95Ms;
    const valueB = metric === 'p50' ? b.p50Ms : b.p95Ms;
    return metricRow(
      metric,
      label,
      { a: valueA, b: valueB, valueA: formatMs(valueA), valueB: formatMs(valueB) },
      'lower',
      (d) => `${sign(d)}${formatMs(Math.abs(d))}`,
    );
  };

  const rows: MetricRow[] = [
    msRow('p50', 'p50 latency'),
    msRow('p95', 'p95 latency'),
    metricRow(
      'cost',
      'cost per min',
      {
        a: a.costPerMinuteUsd,
        b: b.costPerMinuteUsd,
        valueA: formatUsd(a.costPerMinuteUsd),
        valueB: formatUsd(b.costPerMinuteUsd),
      },
      'lower',
      (d) => `${sign(d)}${formatUsd(Math.abs(d))}`,
    ),
  ];

  return {
    armA,
    armB,
    rows,
    werCell: deriveWerCell(ledger, armA, armB),
    provenanceA: a.provenance,
    provenanceB: b.provenance,
  };
}

/**
 * The WER cell. When the two arms pin the same STT stage the transcript is
 * identical by construction, so the cell SAYS SO instead of carrying a number
 * that would look like a measurement (PRD §8).
 */
function deriveWerCell(ledger: RunLedger, armA: ArmTag, armB: ArmTag): string {
  if (sttUnchangedBetween(armA, armB)) return STT_UNCHANGED_CELL;
  const werOf = (arm: ArmTag): number | null =>
    meanOf(
      (ledger.getRuns() as AnnotatedRun[])
        .filter((run) => isAggregatableRun(run) && runArmTag(run) === arm)
        .map((run) => run.annotations?.wer)
        .filter((wer): wer is number => typeof wer === 'number'),
    );
  const a = werOf(armA);
  const b = werOf(armB);
  if (a === null || b === null) return '—';
  const delta = b - a;
  return `${sign(delta)}${(Math.abs(delta) * 100).toFixed(1)}%`;
}

/** The conversation-length screen. LiveSessions only — Runs never contribute. */
export function deriveLiveModel(ledger: RunLedger): LiveModel {
  const order: ArmTag[] = [];
  const groups = new Map<ArmTag, LiveSession[]>();

  for (const session of ledger.getLiveSessions()) {
    const arm = liveArmTag(session);
    let group = groups.get(arm);
    if (!group) {
      group = [];
      groups.set(arm, group);
      order.push(arm);
    }
    group.push(session);
  }

  const columns = order.map((arm): LiveArmColumn => {
    const sessions = groups.get(arm)!;
    const samples = sessions
      .flatMap((s) => s.utterances)
      .map((u) => {
        const speechEnd = u.timings?.speech_end;
        const audioQueued = u.timings?.audio_queued;
        if (typeof speechEnd !== 'number' || typeof audioQueued !== 'number') return null;
        return audioQueued - speechEnd;
      })
      .filter((ms): ms is number => ms !== null);

    // Prefer the sessions' own utterances; fall back to what each session
    // reported when none of them carries a usable pair of timestamps.
    const measured = percentilesOf(samples);
    const p50Ms =
      samples.length > 0
        ? measured.p50Ms
        : meanOf(sessions.map((s) => s.latency.p50).filter((v): v is number => v !== null));
    const p95Ms =
      samples.length > 0
        ? measured.p95Ms
        : meanOf(sessions.map((s) => s.latency.p95).filter((v): v is number => v !== null));

    return {
      arm,
      label: armLabel(arm),
      sessions: sessions.length,
      utterancesCompleted: sessions.reduce((sum, s) => sum + s.stability.utterancesCompleted, 0),
      disconnects: sessions.reduce((sum, s) => sum + s.stability.disconnects, 0),
      p50Ms,
      p95Ms,
      driftMinute1ToEndMs: meanOf(
        sessions
          .map((s) => s.latency.driftMinute1ToEnd)
          .filter((v): v is number => v !== null),
      ),
      costPerMinuteMinute1: meanOf(
        sessions.map((s) => s.cost.perMinuteMinute1).filter((v): v is number => v !== null),
      ),
      costPerMinuteFinalMinute: meanOf(
        sessions.map((s) => s.cost.perMinuteFinalMinute).filter((v): v is number => v !== null),
      ),
      // PRD §7: there is no reference text in Live, so WER is never available.
      wer: null,
    };
  });

  return { columns, empty: columns.length === 0 };
}
