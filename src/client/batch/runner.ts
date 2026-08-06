/**
 * Ticket 009 — Batch runner (sweep): recordings × configurations × reps.
 *
 * ============================ API DESIGN (normative) =======================
 * startBatch(options) -> BatchHandle { done, cancel }
 * createRunOnceExecutor(deps) -> BatchExecutor
 *
 * THE BATCH RUNNER EXISTS FOR CONTROL ENFORCEMENT, NOT CLICK REDUCTION (PRD
 * §17 22f). Counterbalancing and warmup discard are §8 requirements a human
 * would apply inconsistently across 45 runs, and they are the entire reason
 * `origin: 'sweep'` means anything to the ledger's aggregation gate. A runner
 * that quietly skipped either control would make every 'sweep' Run a lie.
 *
 * SEQUENTIAL, NEVER CONCURRENT. The next run is not started until the previous
 * one settles. The effects being measured are ~100 ms (PRD §17 14g); two
 * streams contending for network and CPU would move that number by more than
 * the difference the experiment is trying to detect.
 *
 * COUNTERBALANCED ORDER. Within a recording, odd repetitions run the
 * configurations in declared order (A→B) and even repetitions run them
 * reversed (B→A). Always running A first would systematically advantage or
 * penalise one arm if provider latency drifted across the ~68-minute sweep
 * window; alternating makes that drift a wash rather than a bias.
 *
 * ---------------------------- COUNTING SEMANTICS ---------------------------
 * `reps` MEANS RETAINED REPS. Each (recording × configuration) cell executes
 * `reps + 1` times: one EXTRA, uncounted warmup first, then `reps` measured
 * repetitions. So:
 *
 *   BatchOptions.reps            retained reps per recording × configuration
 *   cell executions              reps + 1  (warmup is additional, never one of them)
 *   BatchConfigSummary.intended  === options.reps, exactly
 *   totalRuns / attemptedRuns    recordings × configurations × reps — warmups EXCLUDED
 *   BatchProgress.totalRuns      the same measured count (3 × 3 × 5 = 45)
 *   BatchProgress.runIndex       1-based among MEASURED runs; 0 for a warmup
 *   BatchExecutorRequest.repIndex 1-based for counted reps; 0 for the warmup
 *
 * Treating the warmup as one of the five would silently cost 20% of N, and p95
 * — the statistic the fatter cascade tail makes interesting, and the reason 5
 * repetitions were chosen (PRD §17 22c) — is exactly what degrades first when
 * N shrinks. Hence the warmup is extra, and `intendedReps` is what the sweep
 * SET OUT to retain, so `4 of 5` on the provenance line means a lost rep and
 * not a redefinition of the target.
 *
 * THE WARMUP IS RECORDED, NOT SWALLOWED. It appears in `summary.discarded`
 * with its runId and in the progress stream with `warmup: true`, while being
 * absent from `summary.runs`. A discard that vanished without trace would be
 * indistinguishable from a run that never happened, and the operator watching
 * a long sweep would see the clock move with nothing to account for it.
 *
 * ORIGIN TRAVELS ON THE REQUEST, NOT AS A PATCH AFTERWARDS. The executor is
 * told which origin to stamp (`'sweep'` for a measured run, `'manual'` for the
 * warmup) BEFORE the Run is built and POSTed, so exactly one record per run
 * reaches the ledger carrying the right origin. Patching `origin` onto a
 * returned Run would leave the ledger holding a 'manual' copy of a sweep run —
 * either a duplicate row or a row whose stored origin disagrees with the
 * summary. It also means the warmup can never accidentally acquire 'sweep',
 * which is what keeps `isAggregatableRun` false for it.
 *
 * A FAILED RUN DOES NOT ABORT THE BATCH. Any of three things is a failure: a
 * rejection, a RESOLVED run with status 'failed' (ticket 008's runOnce
 * resolves lost-stage runs rather than throwing), or a per-run timeout abort.
 * Each is retried exactly once — its own budget, never shared with another
 * cell — and then recorded in `failures` while the sweep continues.
 *
 * THE PER-RUN TIMEOUT IS THE RUNNER'S, NOT runOnce's. Ticket 008 has no
 * timeout: a wedged transport would hang a manual run, which the operator can
 * see and stop, but would hang an unattended 68-minute sweep forever.
 * `runTimeoutMs` is a required option rather than a constant because the right
 * bound depends on the clip length and the architecture under test.
 *
 * A CANCELLED SWEEP IS A SHORT SWEEP, NOT A DISCARDED ONE. Cancel aborts the
 * in-flight run, does NOT retry it, does NOT start the next cell, and returns
 * every run already completed. Throwing away 40 minutes of good runs because
 * the operator stopped at minute 41 would be the only truly unrecoverable
 * outcome here.
 * ==========================================================================
 */

import type { RunOrigin } from '../../core/protocol';
import type { RunsClient } from '../replay/recordingsClient';
import { runOnce, type RunOnceConfig, type RunOnceResult, type RunnerDeps } from '../replay/runner';
import type { Run } from '../state/ledger';

/** One selectable configuration in the sweep matrix. */
export interface BatchConfiguration {
  /** Stable id used in progress events and the summary. */
  id: string;
  config: RunOnceConfig;
  label?: string;
}

/** What the runner asks the single-run executor to do. */
export interface BatchExecutorRequest {
  recordingId: string;
  configId: string;
  config: RunOnceConfig;
  /** 1-based repetition index; 0 for the warmup, which counts as no rep. */
  repIndex: number;
  /** 1 = first try, 2 = the single retry. Never more. */
  attempt: number;
  /** True for the discarded warmup run of a configuration. */
  warmup: boolean;
  /** 'sweep' for a retained run; never 'sweep' for the warmup. */
  origin: RunOrigin;
  /** Aborted when the batch is cancelled or the per-run timeout elapses. */
  signal: AbortSignal;
}

export type BatchExecutor = (request: BatchExecutorRequest) => Promise<RunOnceResult>;

export interface BatchProgress {
  /** 1-based position in the MEASURED matrix; 0 for a warmup, which holds no
   * position in it (so the ratio runIndex/totalRuns never exceeds 1). */
  runIndex: number;
  /** Measured matrix size: recordings × configurations × reps. Warmups are
   * NOT counted — the mock's "run 17 of 45" is 3 × 3 × 5 retained runs. */
  totalRuns: number;
  recordingId: string;
  configId: string;
  repIndex: number;
  warmup: boolean;
  elapsedMs: number;
  /** null until the runner has a sample to estimate from. */
  estimatedRemainingMs: number | null;
}

export interface BatchCellRef {
  recordingId: string;
  configId: string;
  repIndex: number;
}

export interface BatchFailure extends BatchCellRef {
  status: 'failed';
  /** Attempts spent on this cell — 2 once the single retry is used. */
  attempts: number;
  runId?: string;
  error?: string;
}

export interface BatchDiscard extends BatchCellRef {
  reason: 'warmup';
  runId?: string;
}

export interface BatchConfigSummary {
  configId: string;
  /** Reps the sweep set out to retain — i.e. `options.reps`, exactly. */
  intendedReps: number;
  /** Reps that actually produced a retained, complete run. */
  completedReps: number;
}

export interface BatchSummary {
  status: 'complete' | 'cancelled';
  /** Measured matrix size — retained runs only, warmups excluded. */
  totalRuns: number;
  /** Measured cells actually attempted. Warmups are not cells. */
  attemptedRuns: number;
  completedRuns: number;
  warmupDiscardApplied: boolean;
  counterbalancingApplied: boolean;
  discarded: BatchDiscard[];
  failures: BatchFailure[];
  configurations: BatchConfigSummary[];
  /** Retained runs in execution order. Every one carries origin 'sweep'. */
  runs: Run[];
  elapsedMs: number;
}

export interface BatchDeps {
  execute: BatchExecutor;
  /** Epoch-ms clock. */
  now: () => number;
}

export interface BatchOptions {
  recordingIds: string[];
  configurations: BatchConfiguration[];
  /**
   * RETAINED reps per (recording × configuration) — PRD §17 22c, "5
   * repetitions retained". The warmup is an ADDITIONAL, uncounted execution,
   * so a cell runs `reps + 1` times and aggregates `reps` samples.
   */
  reps: number;
  /** Per-run completion timeout; an over-running run is aborted and failed. */
  runTimeoutMs: number;
  deps: BatchDeps;
  onProgress?: (progress: BatchProgress) => void;
}

export interface BatchHandle {
  done: Promise<BatchSummary>;
  cancel: () => void;
}

/** Attempts per measured cell: the first try plus one retry. Never more. */
const MEASURED_ATTEMPTS = 2;

/** The warmup is thrown away either way, so it never spends a retry. */
const WARMUP_ATTEMPTS = 1;

/** One planned execution: a matrix cell, or a configuration's warmup. */
interface PlannedCell {
  recordingId: string;
  configuration: BatchConfiguration;
  /** 1-based for counted reps; 0 for the warmup. */
  repIndex: number;
  warmup: boolean;
}

/** How one attempt ended. */
type AttemptOutcome =
  | { kind: 'ok'; run: Run }
  | { kind: 'failed'; runId?: string; error?: string }
  | { kind: 'cancelled'; run?: Run };

/**
 * The full execution order, warmups included.
 *
 * Per recording: every configuration's warmup first, then the counted reps —
 * odd reps in declared order, even reps reversed. The alternation is the
 * control; a `counterbalancingApplied` flag without it would be decoration.
 */
function planCells(
  recordingIds: string[],
  configurations: BatchConfiguration[],
  reps: number,
): PlannedCell[] {
  const cells: PlannedCell[] = [];
  for (const recordingId of recordingIds) {
    for (const configuration of configurations) {
      cells.push({ recordingId, configuration, repIndex: 0, warmup: true });
    }
    for (let rep = 1; rep <= reps; rep++) {
      const order = rep % 2 === 1 ? configurations : [...configurations].reverse();
      for (const configuration of order) {
        cells.push({ recordingId, configuration, repIndex: rep, warmup: false });
      }
    }
  }
  return cells;
}

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

export function startBatch(options: BatchOptions): BatchHandle {
  const { recordingIds, configurations, reps, runTimeoutMs, deps, onProgress } = options;

  const cancellation = new AbortController();
  const startedAt = deps.now();
  const totalRuns = recordingIds.length * configurations.length * reps;

  const runs: Run[] = [];
  const failures: BatchFailure[] = [];
  const discarded: BatchDiscard[] = [];
  /** configId -> recordingId -> retained, complete runs. */
  const completedByConfig = new Map<string, Map<string, number>>();

  let attemptedRuns = 0;
  /** 1-based position of the measured cell currently running; 0 before any. */
  let runIndex = 0;
  /** Measured cells that have settled — what the estimate counts down from. */
  let measuredSettled = 0;
  /** Executions that have settled, warmups and retries included. */
  let executions = 0;

  const emitProgress = (cell: PlannedCell): void => {
    if (!onProgress) return;
    const elapsedMs = deps.now() - startedAt;
    // Averaged over every execution so far (warmups cost wall clock too), and
    // counted down over the measured cells still to settle.
    const estimatedRemainingMs =
      executions === 0
        ? null
        : Math.max(0, Math.round((elapsedMs / executions) * (totalRuns - measuredSettled)));
    onProgress({
      // A warmup holds no position in the measured matrix, so the operator's
      // bar can never read more than 100%.
      runIndex: cell.warmup ? 0 : runIndex,
      totalRuns,
      recordingId: cell.recordingId,
      configId: cell.configuration.id,
      repIndex: cell.repIndex,
      warmup: cell.warmup,
      elapsedMs,
      estimatedRemainingMs,
    });
  };

  const attempt = async (cell: PlannedCell, attemptNo: number): Promise<AttemptOutcome> => {
    // A fresh controller per attempt: the retry of a timed-out run must start
    // with a live signal, or it would abort before the transport was touched.
    const controller = new AbortController();
    const propagate = (): void => controller.abort();
    if (cancellation.signal.aborted) controller.abort();
    else cancellation.signal.addEventListener('abort', propagate, { once: true });

    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, runTimeoutMs);

    try {
      const result = await deps.execute({
        recordingId: cell.recordingId,
        configId: cell.configuration.id,
        config: cell.configuration.config,
        repIndex: cell.repIndex,
        attempt: attemptNo,
        warmup: cell.warmup,
        // Never 'sweep' for the warmup: that is what keeps the discarded run
        // out of the ledger's aggregate for good.
        origin: cell.warmup ? 'manual' : 'sweep',
        signal: controller.signal,
      });
      if (cancellation.signal.aborted) {
        return { kind: 'cancelled', run: result.cancelled ? undefined : result.run };
      }
      // runOnce RESOLVES a lost-stage run rather than throwing, so a resolved
      // result is not automatically a success.
      if (result.cancelled || result.run.status !== 'complete') {
        return {
          kind: 'failed',
          runId: result.run.id,
          error: timedOut ? `run exceeded ${runTimeoutMs} ms` : result.run.errors[0],
        };
      }
      return { kind: 'ok', run: result.run };
    } catch (cause) {
      if (cancellation.signal.aborted) return { kind: 'cancelled' };
      return {
        kind: 'failed',
        error: timedOut ? `run exceeded ${runTimeoutMs} ms` : messageOf(cause),
      };
    } finally {
      clearTimeout(timer);
      cancellation.signal.removeEventListener('abort', propagate);
      executions += 1;
    }
  };

  const recordCompletion = (cell: PlannedCell, run: Run): void => {
    runs.push(run);
    let byRecording = completedByConfig.get(cell.configuration.id);
    if (!byRecording) {
      byRecording = new Map<string, number>();
      completedByConfig.set(cell.configuration.id, byRecording);
    }
    byRecording.set(cell.recordingId, (byRecording.get(cell.recordingId) ?? 0) + 1);
  };

  /** Runs one cell to its conclusion. Returns false once the batch is over. */
  const runCell = async (cell: PlannedCell): Promise<boolean> => {
    if (!cell.warmup) {
      runIndex += 1;
      attemptedRuns += 1;
    }
    emitProgress(cell);

    const maxAttempts = cell.warmup ? WARMUP_ATTEMPTS : MEASURED_ATTEMPTS;
    let outcome: AttemptOutcome = { kind: 'failed' };
    let spent = 0;

    for (let attemptNo = 1; attemptNo <= maxAttempts; attemptNo++) {
      spent = attemptNo;
      outcome = await attempt(cell, attemptNo);
      if (outcome.kind !== 'failed') break;
      // Cancel must not spend the retry on a run it just aborted.
      if (cancellation.signal.aborted) break;
    }

    if (!cell.warmup) measuredSettled += 1;

    if (outcome.kind === 'cancelled') {
      // A run that got all the way to 'complete' before the cancel landed is
      // still a good sample; a short sweep, not a discarded one.
      if (outcome.run && outcome.run.status === 'complete' && !cell.warmup) {
        recordCompletion(cell, outcome.run);
      }
      return false;
    }

    if (cell.warmup) {
      // Recorded, not swallowed — with the runId, so the discarded run can be
      // found in the ledger and accounted for.
      discarded.push({
        recordingId: cell.recordingId,
        configId: cell.configuration.id,
        repIndex: cell.repIndex,
        reason: 'warmup',
        runId: outcome.kind === 'ok' ? outcome.run.id : undefined,
      });
      return true;
    }

    if (outcome.kind === 'ok') {
      recordCompletion(cell, outcome.run);
      return true;
    }

    failures.push({
      recordingId: cell.recordingId,
      configId: cell.configuration.id,
      repIndex: cell.repIndex,
      status: 'failed',
      attempts: spent,
      runId: outcome.runId,
      error: outcome.error,
    });
    return true;
  };

  const summarize = (status: 'complete' | 'cancelled'): BatchSummary => ({
    status,
    totalRuns,
    attemptedRuns,
    completedRuns: runs.length,
    warmupDiscardApplied: discarded.length > 0,
    // True only when alternation actually had somewhere to happen: one
    // configuration, or one repetition, leaves nothing to counterbalance.
    counterbalancingApplied: configurations.length > 1 && reps > 1,
    discarded,
    failures,
    configurations: configurations.map((configuration) => {
      const byRecording = completedByConfig.get(configuration.id);
      // The reps that survived across the WHOLE matrix: a rep lost for one
      // recording is a rep this configuration did not retain. Never overstates.
      const completedReps =
        recordingIds.length === 0
          ? 0
          : Math.min(...recordingIds.map((id) => byRecording?.get(id) ?? 0));
      return {
        configId: configuration.id,
        // What the sweep SET OUT to retain — the denominator of '4 of 5'.
        intendedReps: reps,
        completedReps,
      };
    }),
    runs,
    elapsedMs: deps.now() - startedAt,
  });

  const done = (async (): Promise<BatchSummary> => {
    for (const cell of planCells(recordingIds, configurations, reps)) {
      if (cancellation.signal.aborted) return summarize('cancelled');
      // Awaited: the next run never starts before this one settles.
      const carryOn = await runCell(cell);
      if (!carryOn) return summarize('cancelled');
    }
    return summarize(cancellation.signal.aborted ? 'cancelled' : 'complete');
  })();

  return {
    done,
    cancel: () => {
      cancellation.abort();
    },
  };
}

/**
 * Adapts ticket 008's runOnce to the batch executor seam.
 *
 * runOnce hardcodes `origin: 'manual'` (only a sweep produces 'sweep', and
 * runOnce does not know it is in one). Rather than widen runOnce's options —
 * or POST a second, corrected copy of the Run — this wraps the RunsClient and
 * stamps the requested origin on the record on its way to `create()`. The
 * ledger therefore receives exactly one Run per executed run, already carrying
 * the origin the summary reports.
 */
export function createRunOnceExecutor(deps: RunnerDeps): BatchExecutor {
  return async (request: BatchExecutorRequest): Promise<RunOnceResult> => {
    let stamped: Run | undefined;
    const runs: RunsClient = {
      create: async (run: Run) => {
        stamped = { ...run, origin: request.origin };
        return deps.runs.create(stamped);
      },
      list: (recordingId?: string) => deps.runs.list(recordingId),
      getAudio: (id: string) => deps.runs.getAudio(id),
    };

    const result = await runOnce({
      recordingId: request.recordingId,
      config: request.config,
      deps: { ...deps, runs },
      signal: request.signal,
    });

    // A cancelled run is never POSTed (ticket 008), so there may be nothing
    // stamped; the returned record still reports the origin it ran under.
    return { ...result, run: stamped ?? { ...result.run, origin: request.origin } };
  };
}
