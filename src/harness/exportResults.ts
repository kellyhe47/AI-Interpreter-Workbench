/**
 * Ticket 017 — export-results logic.
 *
 * The testable half of `npm run export-results`. `scripts/export-results.mjs`
 * is a thin CLI shell over this module — same split as
 * scripts/bench-fixture.mjs over src/harness/bench.ts.
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
import { createStorage } from '../server/storage/index';
import type { Run } from '../server/storage/index';

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
  costUsd: number;
}

export interface ExperimentSummary {
  experiment: string;
  configurations: ConfigurationSummary[];
}

/**
 * STUB (ticket 023 — test-writer). PRD §10's disclosure requirement: the
 * number of comparisons scored is stated alongside N, "so a small sample is
 * disclosed rather than implied to be complete".
 *
 * It is a TOP-LEVEL field and deliberately NOT part of `totals`: `totals` is
 * pinned exactly (`toEqual`) by the locked empty-bundle test, and comparisons
 * are not runs.
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

export interface ExportSummary {
  /** Bundle date, YYYY-MM-DD. */
  exportedAt: string;
  intendedReps: number;
  /** STUB (ticket 023 — test-writer). */
  blindComparisons: BlindComparisonSummary;
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

  return {
    configuration: arm,
    n: aggregated.length,
    repsCompleted: aggregated.length,
    repsIntended: intendedReps * recordings.length,
    recordings,
    p50Ms: percentile(samples, 0.5),
    p95Ms: percentile(samples, 0.95),
    costUsd: aggregated.reduce((total, run) => total + (run.cost ?? 0), 0),
  };
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
  try {
    [ledger, stored] = await Promise.all([store.readLedger(), store.listRuns()]);
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
    // STUB (ticket 023 — test-writer). NO IMPLEMENTATION: the store is never
    // asked for its comparisons and nothing is counted.
    blindComparisons: { total: 0, scored: 0, unattributable: 0, byRecording: {} },
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
