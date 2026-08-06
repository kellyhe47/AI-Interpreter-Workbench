/**
 * Ticket 017 — export-results logic (STUB: tests are red until implemented).
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
 */
import type { ArmTag } from '../core/arms';

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

export interface ExportSummary {
  /** Bundle date, YYYY-MM-DD. */
  exportedAt: string;
  intendedReps: number;
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

export async function exportResults(
  _opts: ExportResultsOptions,
): Promise<ExportResultsOutcome> {
  throw new Error('not implemented');
}
