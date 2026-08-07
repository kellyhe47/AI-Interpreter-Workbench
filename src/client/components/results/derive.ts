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
 * - TICKET 032: THE MEASURED ATOM IS THE UTTERANCE, NOT THE RUN. Every
 *   derivation below expands a Run into `ledger.runSamples(run)` first — one
 *   sample per `RunUtterance`, or exactly one Run-level sample for a Run that
 *   carries none — and applies `isAggregatableUtterance` to each. So `n` is a
 *   SAMPLE count everywhere: PRD §8's 60 per arm (3 recordings × 4 utterances
 *   × 5 reps), 20 per recording, 10 per category. Runs with no `utterances[]`
 *   expand to one sample and every pre-032 figure is untouched.
 *   REPS AND UTTERANCES ARE NEVER CONFLATED: `runCount` and `completedReps`
 *   stay Run-level and keep counting reps, `n` counts samples, and the two are
 *   deliberately different numbers on the same row.
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
 *     utteranceCount  distinct utterances behind the figure: the RECORD's
 *                     utteranceId over the gate-passing Runs' samples, falling
 *                     back to annotations.utteranceId and then the recordingId
 *                     for a Run that carries no records. An utterance that
 *                     failed is still one utterance.
 *     attemptedSamples  samples the arm ATTEMPTED at record level, complete and
 *                     failed alike. `n` counts only the complete ones, so the
 *                     gap is exactly the utterances that produced no output
 *                     audio — without it a 20-attempt / 18-measured arm is
 *                     indistinguishable from a clean one, and a failed
 *                     utterance loses no REP so intendedReps cannot say it.
 *                     Equals `n` for a ledger with no manifest-backed run.
 *     completedReps   distinct annotations.repIndex over gate-passing Runs —
 *                     the ACTUAL count.
 *     intendedReps    distinct annotations.repIndex over the arm's
 *                     sweep-origin, named-arm Runs of ANY status. Derived, not
 *                     declared: nothing extra has to be recorded for a sweep
 *                     that lost a rep to read '4 of 5'.
 *     endpointingMs   always PINNED_ENDPOINTING_MS — a pinned control, not a
 *                     measurement.
 *     corpusVersions  TICKET 033 — EVERY distinct annotations.corpusVersion
 *                     among the contributing Runs, deduped and sorted
 *                     ascending. An aggregate spanning two corpus versions
 *                     NAMES BOTH; picking the first would imply homogeneity
 *                     over evidence gathered from two corpora.
 *     corpusVersion   that list when it holds EXACTLY one entry, else null —
 *                     null for none AND for several, so a caller reading it
 *                     alone degrades to "unrecorded" rather than to a wrong
 *                     claim.
 *   The line's wording is not locked; the counts inside it are, and they are
 *   read from the same fields the figures are.
 * - groupByRecording(ledger): one row per (recordingId x configuration), in
 *   first-appended Run order. EVERY Run is listed, gate-passing or not: ad-hoc
 *   runs appear nowhere else — which is why an ad-hoc Run's RECORDS do carry
 *   figures on its row (n = 4 for a 4-utterance clip, exactly as n = 1 was
 *   right before) while the row stays marked excluded from experiments.
 *   runCount / failedCount / origins describe the whole group in RUNS;
 *   n / p50Ms / p95Ms / costUsd describe the complete SAMPLES of the complete,
 *   real Runs in it. excludedFromExperiments is true iff NO Run in the group passes
 *   `isAggregatableRun`; exclusionReasons lists, deduped in first-appearance
 *   order, why each excluded Run was excluded, tested in the order
 *   fixture -> ad-hoc -> manual -> failed.
 * - groupByCategory(ledger): one row per (category x derived arm) over
 *   gate-passing SAMPLES only, the record's category winning over the
 *   annotation envelope. Categories are distributed across recordings (PRD 9),
 *   so this is the grouping the findings actually live in — and it is keyed on
 *   the pair, never the category alone, because a mixed ledger yields several
 *   rows per category and a category-only lookup picks the wrong arm.
 * - deriveComparison(ledger, armA, armB): p50 / p95 / cost rows (cost is per
 *   audio minute; lower-is-better, delta = B - A). werCell is
 *   STT_UNCHANGED_CELL whenever the two arms share an STT stage; otherwise the
 *   mean-WER delta, or '—' when either side carries none. null when either arm
 *   has no gate-passing sample.
 * - TICKET 034 — WER IS READ FROM THE SCORES STREAM, per arm and per category.
 *   deriveWerByArm / deriveWerByCategory walk exactly the samples the latency
 *   figures walk — `runSamples` + `isAggregatableUtterance` — and look each one
 *   up by (runId, utteranceId) through `ledger.getWerScore`, which is
 *   last-write-wins. So the realness rule and the aggregation gate apply to WER
 *   EXACTLY as to latency: no fixture-sourced WER, no WER from a manual or
 *   failed run. `meanWer` averages only the samples that carry a NUMBER.
 *   NOT APPLICABLE IS NOT ZERO: Cantonese carries no referenceText by design
 *   (PRD §9), its scores are `wer: null`, they are counted in `notApplicable`
 *   and they NEVER enter the mean. An arm whose every sample is not applicable
 *   reports `WER_NOT_APPLICABLE_CELL`, never '0.0%'.
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
// src/core/corpus.ts is the CANONICAL category union (ticket 030; compiled by
// both tsconfigs, and what `RunUtterance.category` is typed as). The identical
// union in src/harness/corpus.ts is the pre-22a synthetic placeholder kept for
// bench/soak — importing it here left two copies free to drift apart.
import type { CorpusCategory } from '../../../core/corpus';
import type { WerScore } from '../../../core/wer';
import {
  isAggregatableLiveSession,
  isAggregatableRun,
  isAggregatableUtterance,
  isRealRecord,
  isRealRun,
  runArmTag,
  runSamples,
  type LiveSession,
  type Run,
  type RunLedger,
  type RunOrigin,
  type RunSample,
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
  // TICKET 034 removed `wer`. Nothing ever wrote it, and a Run-level WER could
  // not have been correct anyway: a Run spans ~4 utterances of deliberately
  // different categories (PRD §9), so there is no single reference for it to
  // have been scored against. WER now lives in its own append-only stream,
  // keyed by the measured atom — see `deriveWerByArm` below.
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
  /**
   * TICKET 033 — EVERY distinct corpus version behind the figure, deduped and
   * sorted ascending so the order is stable across ledger append order. Empty
   * when no contributing Run declares one.
   *
   * THE RULE: an aggregate spanning two corpus versions NAMES BOTH. Picking the
   * first and implying homogeneity is a confident, wrong provenance claim —
   * strictly worse than the honest `corpus version unrecorded` it replaces
   * (PRD §8: a number without provenance is a claim). Aggregation itself is NOT
   * refused: the samples are real measurements and suppressing them would lose
   * evidence; what the line owes the reader is that the input changed.
   */
  corpusVersions: string[];
  /**
   * The single corpus version behind the figure, or null when there is NOT
   * exactly one — i.e. null for none AND for several. Read `corpusVersions`
   * to tell those apart; a caller that renders this alone degrades to
   * "unrecorded" on a mixed aggregate, which is honest rather than wrong.
   */
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

/* --------------------------------------------- ticket 034: WER derivations -- */

/**
 * How a WER cell renders when the corpus has no script to score against.
 * PRD §9: Cantonese is improvised from English prompt cards. NEVER '0.0%' —
 * a zero WER is a PERFECT score, which is the worst possible way to say
 * "there is no reference".
 */
export const WER_NOT_APPLICABLE_CELL = 'not applicable';

/**
 * How a WER cell renders when the samples exist but nobody has scored them.
 * Distinct from `not applicable`: one says the measurement is impossible, the
 * other says it has not been taken.
 */
export const WER_NOT_MEASURED_CELL = 'not yet measured';

/** One arm's (or one category × arm's) WER, over gate-passing samples only. */
export interface WerAggregate {
  /** Mean over the samples carrying a NUMBER. null when there are none. */
  meanWer: number | null;
  /** Gate-passing samples with a numeric WER — the mean's denominator. */
  scored: number;
  /**
   * Gate-passing samples whose score says `not applicable` (no referenceText,
   * or no hypothesis). Counted, never averaged, and never rendered as 0.
   */
  notApplicable: number;
  /** Gate-passing samples with NO score record at all. */
  unscored: number;
  /**
   * The rendered cell, decided in one place so no view can invent a zero:
   * a percentage when anything scored, else WER_NOT_APPLICABLE_CELL when
   * anything is not applicable, else WER_NOT_MEASURED_CELL.
   */
  cell: string;
}

/** One row of the by-category WER table: category × DERIVED arm. */
export interface WerCategoryRow extends WerAggregate {
  category: UtteranceCategory;
  arm: ArmTag;
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

// Perceived end-to-end latency now lives on the SAMPLE, not the Run: the
// ledger's `runSamples` pairs `audio_queued` with the `speech_end` from the
// same level, so a Run's stamp can never be crossed with a record's.

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

/* ------------------------------- ticket 032: the record beats the envelope -- */

/**
 * The utterance a sample measured. THE RECORD WINS; `annotations.utteranceId`
 * is the fallback for a record-less Run (the 028 write path still fills it),
 * and `recordingId` the last resort. The two representations are reconciled
 * here rather than carried silently side by side.
 */
function sampleUtteranceId(sample: RunSample): string {
  const run = sample.run as AnnotatedRun;
  return sample.utteranceId ?? run.annotations?.utteranceId ?? run.recordingId;
}

/**
 * The category a sample belongs to, or undefined when nothing declares one.
 * Same precedence: the record's tag, then the annotation envelope. A Run spans
 * ~4 utterances of deliberately DIFFERENT categories (PRD §9), so the record is
 * the only level at which the question has a single honest answer.
 */
function sampleCategory(sample: RunSample): UtteranceCategory | undefined {
  return sample.category ?? (sample.run as AnnotatedRun).annotations?.category;
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
  // TICKET 032 — the arm's ATTEMPTED atoms: every record of every gate-passing
  // Run, failed ones included, or the single Run-level sample when a Run
  // carries none. `n` counts only the ones that completed, so the gap between
  // the two is exactly the utterances that produced no output audio.
  const gateSamples = gatePassing.flatMap((run) => runSamples(run));
  const attemptedSamples = gateSamples.length;

  // The RECORD's id wins; `annotations.utteranceId` is the fallback for a Run
  // that carries no records, and the recordingId the fallback for that. A
  // derivation still reading the annotation envelope reports 3 utterances for
  // PRD §8's corpus where 12 is the truth.
  const utteranceCount = distinct(
    gateSamples.map((s) => sampleUtteranceId(s)),
  ).size;

  const completedRepIndices = distinct(gatePassing.map((r) => r.annotations?.repIndex));
  const completedReps = completedRepIndices.size > 0 ? completedRepIndices.size : gatePassing.length;

  const attemptedRepIndices = distinct(attempted.map((r) => r.annotations?.repIndex));
  const intendedReps = attemptedRepIndices.size > 0 ? attemptedRepIndices.size : completedReps;

  // TICKET 033 — EVERY distinct version behind the figure, sorted so the order
  // does not depend on ledger append order. Only GATE-PASSING Runs contribute:
  // provenance follows the figures, so a Run outside them is not provenance for
  // them. A Run declaring none is silence, never a version of its own.
  const corpusVersions = [...distinct(gatePassing.map((r) => r.annotations?.corpusVersion))].sort();
  // null for NONE and for SEVERAL alike: a caller rendering this alone degrades
  // to the honest "unrecorded" rather than naming one corpus over evidence
  // gathered from two.
  const corpusVersion = corpusVersions.length === 1 ? corpusVersions[0]! : null;

  const line =
    `${armLabel(arm)} · ${utteranceCount} utterances · ` +
    `${completedReps} of ${intendedReps} reps completed · ` +
    `endpointing pinned ${PINNED_ENDPOINTING_MS} ms · turn-final trigger · ` +
    `${corpusVersions.length === 0 ? 'corpus version unrecorded' : corpusVersions.join(', ')}`;

  return {
    utteranceCount,
    attemptedSamples,
    completedReps,
    intendedReps,
    endpointingMs: PINNED_ENDPOINTING_MS,
    corpusVersions,
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
    //
    // TICKET 032 — and then each of those Runs is expanded into its RECORDS, so
    // a row reports PRD §8's "20 samples (4 utterances × 5 reps)" while
    // `runCount` still reports the five Runs. Reps and utterances are never
    // conflated: a row reading runCount 20 has silently renamed one as the
    // other. A record that produced no output audio is dropped here for the
    // same reason its Run would be — it is not a measurement — while its Run
    // stays `complete`, so `failedCount` is untouched by it.
    const measuredRuns = group.filter((run) => run.status === 'complete' && isRealRun(run));
    const measured = measuredRuns
      .flatMap(runSamples)
      .filter((sample) => sample.status === 'complete');
    const samples = measured
      .map((sample) => sample.latencyMs)
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
      costUsd: measured.reduce((sum, sample) => sum + sample.cost, 0),
      excludedFromExperiments: !group.some(isAggregatableRun),
      exclusionReasons,
    };
  });
}

/**
 * "By utterance category": grouped on the category tag, never the recording.
 *
 * TICKET 032 — this table rendered ZERO ROWS from the day it was built. It
 * grouped Runs on `annotations.category`, and a Run spans ~4 utterances of
 * deliberately different categories (PRD §9), so nothing could ever honestly
 * write that field. Grouping RECORDS gives every sample exactly one category
 * and the table fills.
 *
 * Rows are keyed on (category × DERIVED arm), never on category alone: a mixed
 * ledger yields several rows per category and a category-only lookup silently
 * picks whichever arm was appended first.
 */
export function groupByCategory(ledger: RunLedger): CategoryGroupRow[] {
  const order: string[] = [];
  const groups = new Map<string, Array<{ category: UtteranceCategory; sample: RunSample }>>();

  for (const run of ledger.getRuns() as AnnotatedRun[]) {
    for (const sample of runSamples(run)) {
      // The gate, through the parent Run. A record inside an ad-hoc, manual,
      // failed or fixture-sourced Run reaches nothing here.
      if (!isAggregatableUtterance(run, sample.utterance)) continue;
      const category = sampleCategory(sample);
      if (category === undefined) continue;
      const key = `${category}|${sample.arm}`;
      let group = groups.get(key);
      if (!group) {
        group = [];
        groups.set(key, group);
        order.push(key);
      }
      group.push({ category, sample });
    }
  }

  return order.map((key) => {
    const group = groups.get(key)!;
    const first = group[0]!;
    const samples = group
      .map((entry) => entry.sample.latencyMs)
      .filter((ms): ms is number => ms !== null);
    return {
      category: first.category,
      arm: first.sample.arm,
      n: group.length,
      ...percentilesOf(samples),
      costUsd: group.reduce((sum, entry) => sum + entry.sample.cost, 0),
    };
  });
}

/**
 * TICKET 034 — a WER as a percentage, or '—' for null. Percentages, like every
 * other formatter here, live in ONE place so no component formats by hand.
 */
export function formatWer(wer: number | null): string {
  // NULL IS AN EM DASH, NEVER '0.0%'. A zero WER is a perfect score, so
  // rendering an absent measurement as one would report the arm nobody can
  // score as the best arm in the study.
  if (wer === null) return '—';
  return `${(wer * 100).toFixed(1)}%`;
}

/**
 * A running tally of one WER population. The counters are kept apart because
 * NOT SCORED, NOT APPLICABLE and a real number are three different facts, and a
 * reader that cannot tell them apart cannot render Cantonese honestly.
 */
interface WerTally {
  scoredValues: number[];
  notApplicable: number;
  unscored: number;
}

function emptyTally(): WerTally {
  return { scoredValues: [], notApplicable: 0, unscored: 0 };
}

/**
 * Fold ONE gate-passing sample's score into a tally. THE ONLY PLACE a WER value
 * enters a mean: a null score increments `notApplicable` and contributes
 * nothing, so there is no path on which `not applicable` can be averaged in as
 * a 0.
 */
function tallyScore(tally: WerTally, score: WerScore | undefined): void {
  if (score === undefined) {
    tally.unscored += 1;
    return;
  }
  if (score.wer === null) {
    tally.notApplicable += 1;
    return;
  }
  tally.scoredValues.push(score.wer);
}

/**
 * The tally as a reported aggregate. The cell is decided HERE, in one place, so
 * no view can invent a zero: a percentage when anything scored, else
 * `not applicable` when anything was unscoreable, else `not yet measured`.
 */
function toWerAggregate(tally: WerTally): WerAggregate {
  const meanWer = meanOf(tally.scoredValues);
  return {
    meanWer,
    scored: tally.scoredValues.length,
    notApplicable: tally.notApplicable,
    unscored: tally.unscored,
    cell:
      meanWer !== null
        ? formatWer(meanWer)
        : tally.notApplicable > 0
          ? WER_NOT_APPLICABLE_CELL
          : WER_NOT_MEASURED_CELL,
  };
}

/**
 * Every WER-BEARING atom of the ledger: one entry per gate-passing sample that
 * carries a `utteranceId`, paired with the score in force for it.
 *
 * THE GATE IS THE LATENCY GATE, unchanged — `runSamples` + the parent Run's
 * `isAggregatableUtterance` — so a fixture-sourced, ad-hoc, manual or failed
 * run contributes no WER for exactly the reason it contributes no latency.
 *
 * A sample with NO `utteranceId` (a record-less Run) is skipped: WER is keyed
 * by (runId, utteranceId), so a Run with no records has no atom to key by.
 *
 * The walk is over RUNS, looking scores up — never over scores looking runs up.
 * An orphan score naming a Run the ledger does not hold therefore cannot open a
 * row or move a figure.
 */
function werAtoms(
  ledger: RunLedger,
): Array<{ sample: RunSample; utteranceId: string; score: WerScore | undefined }> {
  const atoms: Array<{ sample: RunSample; utteranceId: string; score: WerScore | undefined }> = [];
  for (const run of ledger.getRuns() as AnnotatedRun[]) {
    for (const sample of runSamples(run)) {
      if (!isAggregatableUtterance(run, sample.utterance)) continue;
      const utteranceId = sample.utteranceId;
      if (utteranceId === undefined) continue;
      // LAST WRITE WINS, in the ledger: a re-scored corpus reports the newest
      // number while the superseded lines stay in the store.
      atoms.push({ sample, utteranceId, score: ledger.getWerScore(run.id, utteranceId) });
    }
  }
  return atoms;
}

/** TICKET 034 — WER per DERIVED arm, keyed by arm tag. Named arms only. */
export function deriveWerByArm(ledger: RunLedger): { [arm: string]: WerAggregate } {
  const order: ArmTag[] = [];
  const tallies = new Map<ArmTag, WerTally>();

  for (const { sample, score } of werAtoms(ledger)) {
    let tally = tallies.get(sample.arm);
    if (!tally) {
      tally = emptyTally();
      tallies.set(sample.arm, tally);
      order.push(sample.arm);
    }
    tallyScore(tally, score);
  }

  const perArm: { [arm: string]: WerAggregate } = {};
  for (const arm of order) perArm[arm] = toWerAggregate(tallies.get(arm)!);
  return perArm;
}

/**
 * TICKET 034 — WER per (category × DERIVED arm), the grouping the findings
 * actually live in. Keyed on the PAIR for the same reason `groupByCategory` is:
 * a mixed ledger yields several rows per category and a category-only lookup
 * silently picks whichever arm was appended first.
 */
export function deriveWerByCategory(ledger: RunLedger): WerCategoryRow[] {
  const order: string[] = [];
  const rows = new Map<string, { category: UtteranceCategory; arm: ArmTag; tally: WerTally }>();

  for (const { sample, score } of werAtoms(ledger)) {
    const category = sampleCategory(sample);
    if (category === undefined) continue;
    const key = `${category}|${sample.arm}`;
    let row = rows.get(key);
    if (!row) {
      row = { category, arm: sample.arm, tally: emptyTally() };
      rows.set(key, row);
      order.push(key);
    }
    tallyScore(row.tally, score);
  }

  return order.map((key) => {
    const { category, arm, tally } = rows.get(key)!;
    return { category, arm, ...toWerAggregate(tally) };
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
  // TICKET 034 — RE-SOURCED FROM THE SCORES STREAM. This used to read
  // `annotations.wer`, a Run-level field nothing ever wrote and which could not
  // have been right anyway (a Run spans ~4 utterances of different categories),
  // so the cell was permanently '—'. `deriveWerByArm` is the one place a mean
  // is computed, which is also what keeps a `not applicable` out of it.
  const perArm = deriveWerByArm(ledger);
  const a = perArm[armA]?.meanWer ?? null;
  const b = perArm[armB]?.meanWer ?? null;
  if (a === null || b === null) return '—';
  const delta = b - a;
  return `${sign(delta)}${(Math.abs(delta) * 100).toFixed(1)}%`;
}

/**
 * TICKET 018 / TICKET 041 — is this LiveSession a MEASUREMENT?
 *
 * Three independent ways it is not, and all have to be asked:
 *
 * 0. IT PRODUCED NOTHING, or its recipe names a fixture stage —
 *    `isAggregatableLiveSession`, the gate exported beside `isAggregatableRun`
 *    in the ledger. Ticket 041's clause is the zero-utterance one: pooling a
 *    take that produced no utterance adds a session to `sessions` behind zero
 *    latency samples and zero dollars, so the card reports more sessions behind
 *    the same figures — which reads as evidence. Stored, listed, never counted.
 * 1. (folded into 0) ITS DECLARED RECIPE names a fixture stage —
 *    `isRealLiveSession`, the Run-shaped rule's sibling.
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
  if (!isAggregatableLiveSession(session)) return false;
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
 *
 * TICKET 041 — a session that produced NO UTTERANCE is refused on exactly the
 * same terms, and both clauses now live in one place
 * (`isAggregatableLiveSession`). A ledger holding nothing but empty sessions
 * therefore derives that same explicit empty state rather than a column of
 * zeros: a zero is not a measurement.
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
