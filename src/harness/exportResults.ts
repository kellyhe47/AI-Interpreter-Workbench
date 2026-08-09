/**
 * Ticket 017 — export-results logic.
 *
 * The testable half of `npm run export-results`. `scripts/export-results.mjs`
 * is a thin CLI shell over this module — the logic is here so it can be tested
 * without a process, and the script only parses argv and prints.
 * (TICKET 058 deleted the fixture-bench module this header used to cite as the
 * sibling example of that split; it had no production importer.)
 *
 * Reads the working store at `dataDir` (normally `data/`, gitignored) through
 * `createStorage` and writes a dated bundle into `resultsDir` (normally
 * `results/`, committed — it is what the write-up cites, PRD §7, §17 20c).
 * BOTH paths are injected so tests never touch the repo's data/ or results/.
 *
 * The clock is injected too (`now`), so the `<YYYY-MM-DD>` bundle directory is
 * deterministic under test.
 *
 * WHY THE DATED BUNDLE EXISTS AT ALL. `data/` is gitignored working state: it
 * is whatever the last sweep left behind on one machine, and it changes under
 * you. `results/<YYYY-MM-DD>/` is committed, so a figure in the write-up cites
 * a directory a reviewer can check out and recompute from. Export is the seam
 * between the two, and it only ever READS `dataDir` — this module contains no
 * write into the source store, by construction.
 *
 * THE LEDGER GATE (PRD §6 quarantine, §8, decisions 22d-22e). A run enters an
 * AGGREGATE only when all four hold:
 *   1. its DERIVED arm tag names an arm ('A' | 'B' | 'C', never 'ad-hoc'),
 *   2. `origin === 'sweep'`   — only sweeps had counterbalancing and warmup
 *      discard applied, so a manual run is not comparable evidence,
 *   3. `status === 'complete'`,
 *   4. it is not fixture-sourced (fixtures never report).
 * The tag is DERIVED here, never read off `run.armTag`: a stored label can be
 * stale or wrong, and trusting it would silently corrupt an experiment. The
 * derivation is the same `deriveArmTag` the UI and the in-app results view use,
 * so a figure cannot mean one thing on screen and another in the bundle.
 *
 * EXCLUDED IS NOT DELETED. Manual, ad-hoc, failed and fixture-sourced runs are
 * real information — a failed rep is the most interesting record in the store.
 * They are written into the bundle's record set exactly like any other run and
 * counted in `totals.runs`; they are simply never inside a figure. An export
 * that dropped them would make the bundle unable to answer "how much of the
 * sweep actually landed?", which is the one question the summary exists for.
 *
 * ACTUAL VS INTENDED (same discipline as the in-app provenance line). The
 * summary never reports the sweep that was planned. `repsIntended` is
 * `intendedReps × recordings.length` — what the sweep set out to collect over
 * the recordings it actually touched — and `repsCompleted` (=== `n`) is the
 * count that passed the gate. When they differ, the gap is the finding, so it
 * is stated rather than smoothed over by reporting one number.
 * `recordings` deliberately counts a configuration's SWEEP, NON-FIXTURE runs
 * INCLUDING FAILED ONES: a rep that failed still names the recording it was
 * attempted against, and dropping it would shrink the denominator to hide the
 * very shortfall being measured.
 *
 * BLIND COMPARISONS ARE EXPORTED AND DISCLOSED (ticket 023, PRD §10). They are
 * read from their own append-only stream, written verbatim into the bundle as
 * `blind-comparisons.json`, and counted in `summary.blindComparisons` — a
 * TOP-LEVEL field, never inside `totals`, because a judgement about two runs is
 * not a third run. Only comparisons whose BOTH runs are in the exported record
 * set are `scored`; the rest are `unattributable` — exported in full, counted
 * toward no Recording. Discarding them would destroy real evaluator work;
 * counting them would let an id nothing in the bundle defines inflate a claim.
 *
 * LIVE SESSIONS ARE EXPORTED AND DISCLOSED TOO (ticket 041, PRD §17 19i). They
 * are read from their own append-only stream (live-sessions.jsonl), written
 * verbatim as `live-sessions.json`, and counted in `summary.liveSessions` — a
 * TOP-LEVEL field, never inside `totals`, because a five-minute soak over free
 * conversation is not a Run over a fixed Recording. They are deliberately NOT
 * unioned into the run record set, so they can reach neither `totals.runs` nor
 * an experiment aggregate. `aggregated` mirrors the client's
 * `isAggregatableLiveSession` exactly — real AND non-empty — so the bundle and
 * the Results screen cannot disagree about how much Live evidence exists.
 * ZERO-UTTERANCE and FIXTURE-sourced sessions are exported in full and counted
 * toward no arm, disclosed by name: a take that produced nothing is the
 * finding, not a gap to smooth over.
 *
 * WER SCORES ARE EXPORTED AND DISCLOSED (ticket 034, PRD §8, §9). They are read
 * from their own append-only stream (wer-scores.jsonl), written verbatim as
 * `wer-scores.json`, and counted in `summary.werScores` — a TOP-LEVEL field,
 * never inside `totals`, because a post-hoc judgement about one utterance of a
 * run is not another run. They are deliberately NOT unioned into the run record
 * set, so they can reach neither `totals.runs` nor an experiment aggregate.
 *
 * THE SAME GATE AS LATENCY. A score counts toward `meanByArm` only when its Run
 * passes the ledger gate above AND the Run's own record for that utterance
 * completed — no fixture-sourced WER, no WER from a manual or failed run.
 * LAST WRITE WINS is applied on read (`latestWerScores`, src/core/wer.ts), so a
 * re-scored corpus reports the newest number while the superseded lines are
 * still exported in full.
 *
 * NOT APPLICABLE IS NOT ZERO. Cantonese is improvised from English prompt cards
 * and has no written script (PRD §9), so its scores carry `wer: null`. They are
 * counted in `notApplicable` and NEVER folded into a mean — a zero WER is a
 * perfect score, and averaging one in would report the unscoreable arm as the
 * best one in the study.
 *
 * FAILURE LEAVES THE SOURCE ALONE (PRD §12). The bundle is staged in a sibling
 * directory and renamed into place, so a failed export never leaves a
 * half-written `results/<date>/`. The error names the output path that could
 * not be written, and `dataDir` is untouched either way — export is always
 * re-runnable.
 */
import fs from 'node:fs/promises';
import path from 'node:path';

import { deriveArmTag } from '../core/arms';
import type { ArmTag } from '../core/arms';
import {
  PRICING_VERSION,
  costFromPriceSource,
  formatCostUsd,
  sumMeasuredCosts,
} from '../core/pricing';
import { latestWerScores } from '../core/wer';
import type { WerScore } from '../core/wer';
import { createStorage } from '../server/storage/index';
import type { BlindComparison, LiveSession, Run } from '../server/storage/index';

/** PRD §9: 5 repetitions per utterance per arm. */
export const DEFAULT_INTENDED_REPS = 5;

export interface ExportResultsOptions {
  /** Source working store — normally `data/`. */
  dataDir: string;
  /** Destination root the dated bundle is written INTO — normally `results/`. */
  resultsDir: string;
  /** Injected clock, epoch ms. Defaults to Date.now. */
  now?: () => number;
  /** Intended repetitions per configuration per recording. */
  intendedReps?: number;
}

/** One configuration's aggregate. Every figure obeys the ledger gate. */
export interface ConfigurationSummary {
  /** The DERIVED arm tag — a named arm only. */
  configuration: ArmTag;
  /** ACTUAL count of gate-passing runs. */
  n: number;
  repsCompleted: number;
  repsIntended: number;
  /** Distinct recordingIds this configuration was swept over, sorted. */
  recordings: string[];
  p50Ms: number | null;
  p95Ms: number | null;
  /**
   * TICKET 052 — the sum of the MEASURED run costs, or `null` when none of the
   * configuration's runs carried one. Never `0` for absent: `run.cost ?? 0`
   * folded an unpriced run in as a free one, which understates the arm in the
   * committed bundle the write-up cites.
   */
  costUsd: number | null;
  /** How many of `n` runs carried a measured cost — the honest denominator. */
  measuredCostRuns: number;
  /** Rendered through the ONE formatter: `not measured`, never `$0.00`. */
  costCell: string;
  /** The declared price source behind `costUsd` (PRD §8's provenance rule). */
  pricingVersion: string;
}

export interface ExperimentSummary {
  experiment: string;
  configurations: ConfigurationSummary[];
}

/**
 * Ticket 023 (QA F6) — PRD §10's disclosure requirement: the number of
 * comparisons SCORED is stated alongside N, "so a small sample is disclosed
 * rather than implied to be complete".
 *
 * It is a TOP-LEVEL summary field and deliberately NOT part of `totals`.
 * `totals` counts RUNS and its exact shape is pinned (`toEqual`) by the
 * empty-bundle test; a comparison is a judgement ABOUT two runs, not a third
 * run, so folding it in there would both break that pin and inflate a figure
 * that means "how much of the sweep landed".
 */
export interface BlindComparisonSummary {
  /** Every comparison in the bundle, including unattributable ones. */
  total: number;
  /**
   * Comparisons whose BOTH runIds are in the exported record set — the number
   * disclosed alongside N.
   */
  scored: number;
  /** `total - scored`. Stored, exported, never counted toward a Recording. */
  unattributable: number;
  /** Scored comparisons per recordingId. Unattributable ones appear nowhere. */
  byRecording: Record<string, number>;
}

/**
 * TICKET 041 — the Live-session disclosure. A TOP-LEVEL summary field and
 * deliberately NOT part of `totals`, for the same reason `blindComparisons` is
 * not: `totals` counts RUNS, its exact shape is pinned by the empty-bundle
 * test, and a five-minute soak over free conversation is not a Run over a fixed
 * Recording.
 */
export interface LiveSessionSummary {
  /** Every session in the bundle, including excluded ones. */
  total: number;
  /** Sessions that may enter a reported figure: real AND non-empty. */
  aggregated: number;
  /** `total - aggregated`. Stored, exported, never inside a figure. */
  excluded: number;
  /**
   * Sessions with NO utterances — stored, never aggregated. Disclosed because
   * a run that produced nothing is the finding, not a gap to smooth over.
   */
  zeroUtterance: number;
  /** Fixture-sourced sessions (ticket 018's rule). May overlap zeroUtterance. */
  fixtureSourced: number;
  /** AGGREGATED sessions per DERIVED arm tag. Excluded ones appear nowhere. */
  byArm: Record<string, number>;
}

/**
 * TICKET 034 — the WER disclosure. A TOP-LEVEL summary field and deliberately
 * NOT part of `totals`, for the same reason `blindComparisons` and
 * `liveSessions` are not: `totals` counts RUNS, its exact shape is pinned by
 * the empty-bundle test, and a post-hoc score about one utterance is not a run.
 */
export interface WerScoreSummary {
  /** Every line in the stream, INCLUDING superseded re-scores. */
  total: number;
  /** Distinct (runId, utteranceId) atoms after last-write-wins. */
  atoms: number;
  /**
   * Atoms carrying a NUMBER whose Run and record both pass the gate — the
   * population behind `meanByArm`.
   */
  aggregated: number;
  /**
   * Atoms whose score is `wer: null` — no reference text (Cantonese, PRD §9)
   * or no hypothesis. Disclosed by name, and NEVER folded into a mean: a zero
   * WER is a perfect score.
   */
  notApplicable: number;
  /** Atoms the gate excludes, or that name a Run this bundle does not carry. */
  excluded: number;
  /** Mean WER per DERIVED arm over the aggregated atoms. Absent arms have none. */
  meanByArm: Record<string, number>;
}

export interface ExportSummary {
  /** Bundle date, YYYY-MM-DD. */
  exportedAt: string;
  intendedReps: number;
  /** Ticket 023 — the human-judgement disclosure. Never inside `totals`. */
  blindComparisons: BlindComparisonSummary;
  /** Ticket 041 — the Live-session disclosure. Never inside `totals`. */
  liveSessions: LiveSessionSummary;
  /** Ticket 034 — the post-hoc WER disclosure. Never inside `totals`. */
  werScores: WerScoreSummary;
  totals: {
    /** ALL exported run records, including every excluded one. */
    runs: number;
    /** Runs passing the ledger gate. */
    aggregated: number;
    /** Runs in the record set that no aggregate counts. */
    excluded: number;
  };
  experiments: ExperimentSummary[];
  empty: boolean;
}

export interface ExportResultsOutcome {
  /** YYYY-MM-DD. */
  date: string;
  /** Absolute path of `<resultsDir>/<YYYY-MM-DD>`. */
  bundleDir: string;
  summaryPath: string;
  empty: boolean;
  /** Human-readable one-liner the CLI shell prints. */
  message: string;
  summary: ExportSummary;
}

/** A named arm — the only thing an aggregate may be keyed by. */
type NamedArm = Exclude<ArmTag, 'ad-hoc'>;

/**
 * How the arms are grouped for reporting (PRD §3). Exp 1 varies architecture
 * with the vendor held constant (A vs B); Exp 2 varies the TTS stage with the
 * architecture held constant, against Exp 1's B as its baseline.
 *
 * EACH ARM APPEARS EXACTLY ONCE. Arm B is Exp 2's baseline as well, but its
 * aggregate is reported in one place only: two entries for one arm are two
 * figures that can drift apart, and a reader comparing C against B reads B's
 * single row in exp1.
 */
const EXPERIMENT_PLAN: ReadonlyArray<{ experiment: string; arms: readonly NamedArm[] }> = [
  { experiment: 'exp1', arms: ['A', 'B'] },
  { experiment: 'exp2', arms: ['C'] },
];

/**
 * The arm a run belongs to, DERIVED from its recipe fields. `run.armTag` is
 * never consulted — see the file header.
 */
function armOf(run: Run): ArmTag {
  return deriveArmTag({
    architecture: run.architecture,
    realtimeModel: run.modelSnapshots?.realtime,
    providers: run.providerTriple,
  });
}

/**
 * Fixtures never report. A run is fixture-sourced when any provider in its
 * triple is the fixture provider, any model snapshot is 'fixture', or its
 * recording is one of the generated placeholder clips.
 */
function isFixtureSourced(run: Run): boolean {
  const triple = run.providerTriple;
  if (triple && (triple.stt === 'fixture' || triple.mt === 'fixture' || triple.tts === 'fixture')) {
    return true;
  }
  for (const value of Object.values(run.modelSnapshots ?? {})) {
    if (value === 'fixture') return true;
  }
  return (run.recordingId ?? '').startsWith('placeholder');
}

/** Sweep + non-fixture + a named arm: the population `recordings` is drawn from. */
function isSweptEvidence(run: Run, arm: NamedArm): boolean {
  return run.origin === 'sweep' && !isFixtureSourced(run) && armOf(run) === arm;
}

/**
 * The measured latency: speech end (ground truth) to the first byte of output
 * audio being queued. `null` when either endpoint is missing — a half-timed run
 * contributes no sample rather than a fabricated 0.
 */
function latencySample(run: Run): number | null {
  const speechEnd = run.timings?.speech_end;
  const audioQueued = run.timings?.audio_queued;
  if (typeof speechEnd !== 'number' || typeof audioQueued !== 'number') return null;
  const sample = audioQueued - speechEnd;
  return Number.isFinite(sample) ? sample : null;
}

/**
 * Nearest-rank percentile over an ascending array: `sorted[ceil(p*n)-1]`.
 * Returns null (never 0) for an empty sample — "no measurement" and "measured
 * zero" must not render the same.
 */
function percentile(sorted: readonly number[], p: number): number | null {
  if (sorted.length === 0) return null;
  const rank = Math.min(Math.max(Math.ceil(p * sorted.length), 1), sorted.length);
  return sorted[rank - 1] ?? null;
}

function summariseArm(arm: NamedArm, runs: readonly Run[], intendedReps: number): ConfigurationSummary {
  // INCLUDING FAILED: a failed rep still names the recording it targeted.
  const swept = runs.filter((run) => isSweptEvidence(run, arm));
  const recordings = [...new Set(swept.map((run) => run.recordingId))].sort();

  // The gate: swept evidence that also completed.
  const aggregated = swept.filter((run) => run.status === 'complete');
  const samples = aggregated
    .map(latencySample)
    .filter((sample): sample is number => sample !== null)
    .sort((a, b) => a - b);

  // TICKET 052 — MEASURED runs only. An unmeasured cost contributes nothing
  // and is disclosed, rather than silently entering the total as a zero.
  //
  // TICKET 059 — AND MEASURED MEANS "READ UNDER A DECLARED PRICE SOURCE". The
  // bundle is the copy that outlives the session, so a `0` from a build with no
  // cost model must not become a measured zero here after the screen has stopped
  // calling it one. `pricingVersion` on the ConfigurationSummary below says which
  // rate table THE EXPORT ran under and is a different question entirely — it is
  // never a claim about the runs, and the pre-059 runs ran under none.
  const summed = sumMeasuredCosts(
    aggregated.map((run) => costFromPriceSource(run.pricingVersion, run.cost)),
  );
  const cost = { costUsd: summed.usd, measuredCostRuns: summed.measured };

  return {
    configuration: arm,
    n: aggregated.length,
    repsCompleted: aggregated.length,
    repsIntended: intendedReps * recordings.length,
    recordings,
    p50Ms: percentile(samples, 0.5),
    p95Ms: percentile(samples, 0.95),
    ...cost,
    costCell: formatCostUsd(cost.costUsd),
    pricingVersion: PRICING_VERSION,
  };
}

/**
 * Ticket 023 — the disclosure figures.
 *
 * SCORED means ATTRIBUTABLE: both of a comparison's `runIds` are in the
 * exported record set, so a reader can follow the judgement back to the two
 * runs it was made over. A comparison naming a run this bundle does not carry
 * is `unattributable`: it is still exported (the evaluator's work is never
 * discarded — see the router header) but it is counted toward NO Recording,
 * because attributing it would mean asserting which arms were compared on the
 * strength of an id nothing in the bundle defines.
 *
 * `recordingId` is deliberately NOT the attribution key. A comparison carries
 * one, but a self-declared label cannot be checked; the pair of run ids can.
 */
function summariseComparisons(
  comparisons: readonly BlindComparison[],
  runIds: ReadonlySet<string>,
): BlindComparisonSummary {
  const byRecording: Record<string, number> = {};
  let scored = 0;
  for (const comparison of comparisons) {
    const pair = comparison.runIds ?? [];
    if (pair.length !== 2 || !pair.every((id) => runIds.has(id))) continue;
    scored += 1;
    byRecording[comparison.recordingId] = (byRecording[comparison.recordingId] ?? 0) + 1;
  }
  return {
    total: comparisons.length,
    scored,
    unattributable: comparisons.length - scored,
    byRecording,
  };
}

/**
 * TICKET 041 — the arm a LiveSession belongs to, DERIVED from its recipe, on
 * exactly the terms a Run's arm is derived. `deriveArmTag` is the one place
 * that mapping lives, so a soak and a sweep can never disagree about what Arm B
 * is.
 */
function liveArmOf(session: LiveSession): ArmTag {
  return deriveArmTag({
    architecture: session.architecture,
    realtimeModel: session.modelSnapshots?.realtime,
    providers: session.providerTriple,
  });
}

/** Ticket 018's rule, on the LiveSession shape (it carries no recordingId). */
function isFixtureSourcedSession(session: LiveSession): boolean {
  const triple = session.providerTriple;
  if (triple && (triple.stt === 'fixture' || triple.mt === 'fixture' || triple.tts === 'fixture')) {
    return true;
  }
  return Object.values(session.modelSnapshots ?? {}).includes('fixture');
}

/**
 * TICKET 041 — the Live-session disclosure.
 *
 * AGGREGATED mirrors the client's `isAggregatableLiveSession` exactly: real AND
 * non-empty. The two must not drift, or the exported bundle and the Results
 * screen would disagree about how much Live evidence exists.
 *
 * A ZERO-UTTERANCE session is counted in `total`, exported verbatim, and
 * counted toward NO arm. Pooling one would add a session to a column behind
 * zero latency samples and zero dollars, which reads as a measured free
 * session rather than as "nothing happened" — the finding, smoothed over. It is
 * disclosed by name for the same reason a failed Run is.
 */
function summariseLiveSessions(sessions: readonly LiveSession[]): LiveSessionSummary {
  const byArm: Record<string, number> = {};
  let aggregated = 0;
  let zeroUtterance = 0;
  let fixtureSourced = 0;

  for (const session of sessions) {
    const empty = (session.utterances ?? []).length === 0;
    const fixture = isFixtureSourcedSession(session);
    if (empty) zeroUtterance += 1;
    if (fixture) fixtureSourced += 1;
    if (empty || fixture) continue;
    aggregated += 1;
    const arm = liveArmOf(session);
    byArm[arm] = (byArm[arm] ?? 0) + 1;
  }

  return {
    total: sessions.length,
    aggregated,
    excluded: sessions.length - aggregated,
    zeroUtterance,
    fixtureSourced,
    byArm,
  };
}

/**
 * TICKET 034 — the WER disclosure.
 *
 * LAST WRITE WINS FIRST: the stream is collapsed by (runId, utteranceId)
 * through `latestWerScores`, the one place that rule lives, so `total` reports
 * the lines on disk and every other figure reports the atoms in force.
 *
 * THE GATE IS THE LATENCY GATE. An atom contributes to `meanByArm` only when
 * its Run is in the exported record set, that Run passes all four gate clauses,
 * and the Run's OWN record for that utterance completed. A score naming a Run
 * this bundle does not carry is `excluded` rather than attributed on the
 * strength of an id nothing here defines — exactly how an unattributable blind
 * comparison is handled.
 *
 * NOT APPLICABLE IS NOT ZERO: a `wer: null` atom is counted by name and never
 * reaches a mean.
 */
function summariseWerScores(
  scores: readonly WerScore[],
  runsById: ReadonlyMap<string, Run>,
): WerScoreSummary {
  // LAST WRITE WINS FIRST, through the one place that rule lives. `total`
  // reports the LINES on disk; every figure below reports the ATOMS in force.
  const atoms = latestWerScores(scores);

  const sumByArm: Record<string, { total: number; n: number }> = {};
  let aggregated = 0;
  let notApplicable = 0;
  let excluded = 0;

  for (const atom of atoms) {
    const run = runsById.get(atom.runId);
    // A score naming a Run this bundle does not carry is EXCLUDED rather than
    // attributed on the strength of an id nothing here defines — exactly how an
    // unattributable blind comparison is handled.
    if (run === undefined || !isGatePassingRun(run) || !isCompletedRecord(run, atom.utteranceId)) {
      excluded += 1;
      continue;
    }
    if (atom.wer === null) {
      // NOT APPLICABLE IS NOT ZERO. Counted by name, and it reaches no mean:
      // this branch returns before a value is ever added.
      notApplicable += 1;
      continue;
    }
    aggregated += 1;
    const arm = armOf(run);
    const bucket = (sumByArm[arm] ??= { total: 0, n: 0 });
    bucket.total += atom.wer;
    bucket.n += 1;
  }

  const meanByArm: Record<string, number> = {};
  for (const [arm, { total, n }] of Object.entries(sumByArm)) meanByArm[arm] = total / n;

  return {
    total: scores.length,
    atoms: atoms.length,
    aggregated,
    notApplicable,
    excluded,
    meanByArm,
  };
}

/**
 * The four gate clauses of the file header, as one predicate over a Run.
 *
 * EXPORTED (ticket 042) so the post-hoc WER scoring pass can refuse to score a
 * run this module would refuse to report. Two copies of the gate could drift,
 * and the drift would be a score written for evidence no figure may cite.
 */
export function isGatePassingRun(run: Run): boolean {
  const arm = armOf(run);
  if (arm === 'ad-hoc') return false;
  return isSweptEvidence(run, arm) && run.status === 'complete';
}

/**
 * The gate ONE LEVEL DOWN (the client's `isAggregatableUtterance`). A Run that
 * carries records is judged on the record for THIS utterance: one that produced
 * no output audio is not a measurement — of latency OR of transcription
 * quality. A Run carrying no records at all is judged on the Run alone.
 */
function isCompletedRecord(run: Run, utteranceId: string): boolean {
  const records = run.utterances;
  if (records === undefined || records.length === 0) return true;
  const record = records.find((r) => r.utteranceId === utteranceId);
  // A score naming an utterance the Run never recorded cannot be verified
  // against a measured atom, so it is excluded rather than credited.
  return record !== undefined && record.status === 'complete';
}

function reason(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** UTC so the bundle date is the same wherever the export is run. */
function isoDate(epochMs: number): string {
  return new Date(epochMs).toISOString().slice(0, 10);
}

export async function exportResults(opts: ExportResultsOptions): Promise<ExportResultsOutcome> {
  const { dataDir, resultsDir } = opts;
  const intendedReps = opts.intendedReps ?? DEFAULT_INTENDED_REPS;
  const date = isoDate((opts.now ?? Date.now)());
  const bundleDir = path.join(resultsDir, date);
  const summaryPath = path.join(bundleDir, 'summary.json');

  // READ ONLY. The store is the single reader of the layout; this module never
  // parses data/ by hand and never writes into it.
  const store = createStorage(dataDir);
  let ledger: Run[];
  let stored: Run[];
  let comparisons: BlindComparison[];
  let liveSessions: LiveSession[];
  let werScores: WerScore[];
  try {
    // Comparisons come from their OWN append-only stream (comparisons.jsonl),
    // never from the ledger — see the storage header. Reading them here is what
    // puts human judgement into the bundle the write-up cites. Ticket 041's
    // sessions arrive the same way, from live-sessions.jsonl: they are NOT
    // unioned into `runs` below, so they cannot reach `totals.runs` or an
    // experiment aggregate.
    // Ticket 034's scores arrive the same way again, from wer-scores.jsonl,
    // and are likewise NOT unioned into `runs`: a post-hoc judgement about one
    // utterance of a run is not another run.
    [ledger, stored, comparisons, liveSessions, werScores] = await Promise.all([
      store.readLedger(),
      store.listRuns(),
      store.listBlindComparisons(),
      store.listLiveSessions(),
      store.listWerScores(),
    ]);
  } catch (err) {
    throw new Error(`export-results: could not read the data store at ${dataDir} — ${reason(err)}`, {
      cause: err,
    });
  }

  // The record set is the union of both views, keyed by id: the ledger is the
  // append-only source of truth, and the per-run JSON files catch anything a
  // torn final ledger line cost us.
  const byId = new Map<string, Run>();
  for (const run of stored) byId.set(run.id, run);
  for (const run of ledger) byId.set(run.id, run);
  const runs = [...byId.values()].sort(
    (a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0) || a.id.localeCompare(b.id),
  );

  const experiments: ExperimentSummary[] = EXPERIMENT_PLAN.map(({ experiment, arms }) => ({
    experiment,
    configurations: arms.map((arm) => summariseArm(arm, runs, intendedReps)),
  }));
  const aggregated = experiments.reduce(
    (total, exp) => total + exp.configurations.reduce((sum, config) => sum + config.n, 0),
    0,
  );
  const empty = runs.length === 0;

  const summary: ExportSummary = {
    exportedAt: date,
    intendedReps,
    blindComparisons: summariseComparisons(comparisons, new Set(byId.keys())),
    liveSessions: summariseLiveSessions(liveSessions),
    werScores: summariseWerScores(werScores, byId),
    totals: { runs: runs.length, aggregated, excluded: runs.length - aggregated },
    experiments,
    empty,
  };

  // STAGE THEN RENAME: a failure never leaves a half-written results/<date>/.
  const stagingDir = path.join(resultsDir, `.${date}.partial`);
  try {
    await fs.rm(stagingDir, { recursive: true, force: true });
    await fs.mkdir(path.join(stagingDir, 'runs'), { recursive: true });
    for (const run of runs) {
      await fs.writeFile(
        path.join(stagingDir, 'runs', `${run.id}.json`),
        `${JSON.stringify(run, null, 2)}\n`,
        'utf8',
      );
    }
    // Ticket 023 — the records themselves, so a reviewer can recompute the
    // disclosed number instead of taking the summary's word for it. Written
    // unconditionally (an empty array on an empty store) so the bundle's shape
    // never depends on whether anyone scored anything.
    await fs.writeFile(
      path.join(stagingDir, 'blind-comparisons.json'),
      `${JSON.stringify(comparisons, null, 2)}\n`,
      'utf8',
    );
    // Ticket 041 — the sessions themselves, VERBATIM, so a reviewer can
    // recompute the disclosed figures and read the excluded takes rather than
    // taking the summary's word for either. Written unconditionally (an empty
    // array on an empty store), like blind-comparisons.json, so the bundle's
    // shape never depends on whether anyone ran a Live session. NO audio is
    // written — the shape carries none (PRD §17 19h).
    await fs.writeFile(
      path.join(stagingDir, 'live-sessions.json'),
      `${JSON.stringify(liveSessions, null, 2)}\n`,
      'utf8',
    );
    // Ticket 034 — the scores themselves, VERBATIM and UNCOLLAPSED, so a
    // reviewer can recompute the disclosed mean and read the superseded lines
    // of a re-scored corpus. Written unconditionally (an empty array on an
    // empty store), like the other two side streams, so the bundle's shape
    // never depends on whether anyone scored anything.
    await fs.writeFile(
      path.join(stagingDir, 'wer-scores.json'),
      `${JSON.stringify(werScores, null, 2)}\n`,
      'utf8',
    );
    await fs.writeFile(
      path.join(stagingDir, 'summary.json'),
      `${JSON.stringify(summary, null, 2)}\n`,
      'utf8',
    );
    await fs.rm(bundleDir, { recursive: true, force: true });
    await fs.rename(stagingDir, bundleDir);
  } catch (err) {
    await fs.rm(stagingDir, { recursive: true, force: true }).catch(() => undefined);
    // PLAIN: name the path that could not be written, and say the source is
    // intact so the operator knows a re-run is safe.
    throw new Error(
      `export-results: could not write the results bundle at ${bundleDir} — ${reason(err)}. ` +
        `Nothing was written; the data directory ${dataDir} is unmodified, so the export can be re-run.`,
      { cause: err },
    );
  }

  const message = empty
    ? `export-results: no runs in ${dataDir} — wrote an empty but valid bundle to ${bundleDir}`
    : `export-results: wrote ${runs.length} run record(s) — ${aggregated} aggregated, ` +
      `${runs.length - aggregated} excluded from aggregates — to ${bundleDir}`;

  return { date, bundleDir, summaryPath, empty, message, summary };
}
