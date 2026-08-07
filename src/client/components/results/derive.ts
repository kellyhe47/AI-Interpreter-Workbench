/**
 * Results derivation layer (tickets 011 + 015).
 *
 * Pure derivation over the Recording / Run / LiveSession entities. NO
 * component reads the ledger directly — the view renders these models
 * verbatim, which keeps every figure traceable and makes the math
 * unit-testable without the DOM.
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
 *   membership. costPerMinuteUsd = costUsd / (Sum durationMs of the source
 *   Recordings of the arm's gate-passing Runs / 60000); null when no
 *   contributing Recording declares a duration (never 0).
 * - PROVENANCE (per arm, PRD 8 register):
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
 * - groupByRecording(ledger): one row per (recordingId x configuration), in
 *   first-appended Run order. EVERY Run is listed, gate-passing or not: ad-hoc
 *   runs appear nowhere else. runCount / failedCount / origins describe the
 *   whole group; n / p50Ms / p95Ms / costUsd describe only the complete, real
 *   Runs in it. excludedFromExperiments is true iff NO Run in the group passes
 *   `isAggregatableRun`; exclusionReasons lists, deduped in first-appearance
 *   order, why each excluded Run was excluded, tested in the order
 *   fixture -> ad-hoc -> manual -> failed.
 * - groupByCategory(ledger): one row per (annotations.category x derived arm)
 *   over gate-passing Runs ONLY. Categories are distributed across recordings
 *   (PRD 9), so this is the grouping the findings actually live in.
 * - deriveComparison(ledger, armA, armB): p50 / p95 / cost rows (cost is per
 *   audio minute; lower-is-better, delta = B - A). werCell is
 *   STT_UNCHANGED_CELL whenever the two arms share an STT stage; otherwise the
 *   mean-WER delta, or '—' when either side carries none. null when either arm
 *   has no gate-passing sample.
 * - deriveLiveModel(ledger): one column per derived arm over LiveSessions.
 *   wer is ALWAYS null (PRD 7).
 * - formatMs(ms): null -> '—'; ms < 10000 -> seconds with 2 decimals + ' s';
 *   otherwise mm:ss with zero-padded seconds.
 * - formatUsd(usd): null -> '—'; otherwise '$' + usd.toFixed(3).
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
  isAggregatableRun,
  isRealLiveSession,
  isRealRecord,
  isRealRun,
  runArmTag,
  type LiveSession,
  type Run,
  type RunLedger,
  type RunOrigin,
} from '../../state/ledger';

export type Tone = 'good' | 'bad' | 'neutral';

/** The metrics the comparison model actually derives. */
export type MetricSlug = 'p50' | 'p95' | 'cost';

export interface MetricRow {
  /** Stable slug, rendered as data-metric on the row element. */
  metric: MetricSlug;
  /** Human label for the metric column. */
  label: string;
  /** Formatted value for column A. */
  valueA: string;
  /** Formatted value for column B. */
  valueB: string;
  /** Signed formatted delta (B - A), or '—'. */
  delta: string;
  /** Tone for the delta cell, rendered as data-tone. */
  deltaTone: Tone;
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

function sign(value: number): string {
  return value < 0 ? '-' : '+';
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
  /**
   * Distinct utterances behind the figure — the count of distinct
   * `RunUtterance.utteranceId` the arm ATTEMPTED over its gate-passing Runs
   * (falling back to `annotations.utteranceId`, then `recordingId`, for a Run
   * carrying no records). An utterance that failed is still one utterance.
   *
   * NEVER a rep count: 4 utterances × 5 reps is `utteranceCount` 4 and
   * `completedReps` 5, never 20 of anything.
   */
  utteranceCount: number;
  /**
   * TICKET 032 — samples the arm ATTEMPTED at record level: complete + failed.
   * `ExperimentArmAggregate.n` counts only the complete ones, so the gap
   * between the two is exactly the utterances that produced no output audio.
   * For a ledger with no manifest-backed runs this equals `n`.
   */
  attemptedSamples: number;
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
    // TICKET 032 STUB — implemented by the record-level aggregation.
    attemptedSamples: 0,
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

/**
 * TICKET 018 — is this LiveSession a MEASUREMENT?
 *
 * Two independent ways it is not, and both have to be asked:
 *
 * 1. ITS DECLARED RECIPE names a fixture stage — `isRealLiveSession`, the
 *    Run-shaped rule's sibling, exported beside it in the ledger.
 * 2. THE RECORDS IT ACTUALLY PRODUCED are fixture records. A LiveSession
 *    stores the recipe the operator SELECTED (`config.providers` /
 *    `config.realtimeModel`), which under `?fixture=1` still names the real
 *    speech-to-speech model even though a scripted FixtureTransport served
 *    every utterance. The session's own UtteranceRecords are the evidence
 *    behind its figures — they are in the same ledger under `runId ===
 *    session.id` and they carry `providers: fixture` — so a session whose
 *    evidence is fabricated is not a measurement no matter what its recipe
 *    field claims. This is what closes QA F1 through the real fixture path,
 *    and it is the "one ledger" rule doing the work: the session is judged on
 *    the records it wrote, not on a self-description.
 *
 * A session with NO records in the ledger (a hand-seeded soak summary) is
 * judged on clause 1 alone — absence of evidence is not fixture evidence.
 */
function isMeasuredLiveSession(ledger: RunLedger, session: LiveSession): boolean {
  if (!isRealLiveSession(session)) return false;
  return !ledger.getRecords(session.id).some((record) => !isRealRecord(record));
}

/**
 * The conversation-length screen. LiveSessions only — Runs never contribute.
 *
 * TICKET 018 — the REALNESS RULE APPLIES HERE TOO. `isRealLiveSession` is the
 * gate the Run path always had and this one did not: a `?fixture=1` soak
 * writes a complete, fat LiveSession whose latency is a configured constant,
 * and rendering it produced a p50 that equalled its p95 under a provenance
 * line claiming a measurement (PRD §8: no reported number may come from a
 * fixture run). Excluded sessions are dropped BEFORE grouping, so a fixture
 * session cannot even open a column — a ledger holding nothing but fixture
 * sessions derives `{ columns: [], empty: true }`, the same explicit empty
 * state an untouched ledger derives (PRD §17 15g). They remain stored; only
 * the derivation refuses them.
 */
export function deriveLiveModel(ledger: RunLedger): LiveModel {
  const order: ArmTag[] = [];
  const groups = new Map<ArmTag, LiveSession[]>();

  for (const session of ledger.getLiveSessions()) {
    if (!isMeasuredLiveSession(ledger, session)) continue;
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
