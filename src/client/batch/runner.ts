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
 * TICKET 048 — AND IT IS A REAL TIMEOUT: the budget RACES the execution rather
 * than only aborting a signal beside it. An abort is a request a wedged
 * transport is free to ignore, which made this the backstop that never fired.
 * It stays a BACKSTOP, though: `runOnce` bounds its own waits with named reasons
 * (RUN_COMPLETION_TIMEOUT_MS, AUDIO_UPLOAD_TIMEOUT_MS, TRANSPORT_CLOSE_TIMEOUT_MS),
 * all far shorter than a sane `runTimeoutMs`, so a diagnosable sweep reports what
 * actually went wrong and only a truly wedged executor reaches this blunt line.
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
import {
  RUN_POST_TIMED_OUT,
  abandonedRunStub,
  runOnce,
  type RunOnceConfig,
  type RunOnceResult,
  type RunnerDeps,
} from '../replay/runner';
import type { Run } from '../state/ledger';

/**
 * TICKET 048 ROUND 2 — the abort REASON the per-run budget raises, so a listener
 * downstream can tell "the sweep gave up on this attempt" from "the operator
 * stopped the sweep".
 *
 * The two must not be conflated: an abandoned attempt leaves a hole in the
 * provenance denominator that has to be filled with a failed Run (see
 * `createRunOnceExecutor`), whereas a CANCELLED run is deliberately never
 * POSTed at all — "a cancelled sweep is a short sweep, not a discarded one", and
 * a stored failure would be the sweep blaming the pipeline for the operator's
 * decision.
 */
export const RUN_BUDGET_EXCEEDED = 'run-budget-exceeded';

/** The reason a stub carries: the attempt was abandoned, not measured. */
export const RUN_ABANDONED = 'run abandoned: the sweep exceeded its per-run budget';

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
  /**
   * TICKET 048 ROUND 4 (R4-1) — the executor tells the runner when the ledger
   * POST for this attempt is IN FLIGHT (`true` at the call, `false` on
   * acknowledgement).
   *
   * IT EXISTS TO SUPPRESS THE RETRY, and only that. A retry started beside an
   * attempt whose POST may still land writes a SECOND `origin: 'sweep'` Run
   * carrying the same `annotations.repIndex`; both pass `isAggregatableRun`, and
   * `derive.ts` counts DISTINCT rep indices, so p50/p95 and `n` are pooled over
   * two samples of one repetition under a provenance line that reads a clean
   * "1 of 1". No gate downstream can tell the two rows apart, which is why this
   * has to be prevented rather than filtered.
   *
   * THE RULE IS "FATE UNKNOWN", NOT "ALREADY POSTED". An ACKNOWLEDGED POST is a
   * known outcome — including a POST that stored a legitimately `failed` Run —
   * and the sweep's single specified retry still runs for it. Only an
   * unacknowledged POST (abandoned mid-flight, or bounded out by
   * RUN_POST_TIMEOUT_MS) leaves the row's existence genuinely unknown to the
   * client, and only then is the retry unsafe.
   */
  reportPostInFlight?: (inFlight: boolean) => void;
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

  const attempt = async (
    cell: PlannedCell,
    attemptNo: number,
    /** Mutated by the executor; read by `runCell` to decide about the retry. */
    post: { inFlight: boolean },
  ): Promise<AttemptOutcome> => {
    // A fresh controller per attempt: the retry of a timed-out run must start
    // with a live signal, or it would abort before the transport was touched.
    const controller = new AbortController();
    const propagate = (): void => controller.abort();
    if (cancellation.signal.aborted) controller.abort();
    else cancellation.signal.addEventListener('abort', propagate, { once: true });

    let timedOut = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    try {
      // TICKET 048 — THE BUDGET RACES THE EXECUTION, it does not merely abort a
      // signal beside it. Aborting `controller` is a REQUEST to stop that only a
      // cooperative executor honours; `runOnce` reads the signal nowhere after
      // `await pacer.start()`, so a wedged transport simply ignored it and
      // stalled the whole unattended sweep — the exact failure this option's own
      // documentation says it prevents. The abort is still raised first, so an
      // executor that CAN unwind still gets the chance to.
      const pending = deps.execute({
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
        reportPostInFlight: (inFlight: boolean) => {
          post.inFlight = inFlight;
        },
      });
      // An abandoned attempt usually fails on its own long afterwards. What keeps
      // that from being an unhandled rejection is the SHAPE below — `pending` is
      // an operand of the race, and `Promise.race` attaches a rejection handler
      // to every operand. ROUND 2 (R2-6): this line is belt-and-braces against a
      // future refactor away from `race`; it is not what makes today's version
      // safe. What WOULD leak is a fulfilment-only bound (`pending.then(...)`
      // beside a bare timer), which is the shape this deliberately avoids.
      void pending.catch(() => undefined);

      const raced = await Promise.race([
        pending.then((value) => ({ value })),
        new Promise<{ value?: undefined }>((resolve) => {
          timer = setTimeout(() => {
            timedOut = true;
            // ROUND 2 — the reason is load-bearing: it is what tells the executor
            // this attempt was ABANDONED (and so owes the ledger a failed Run)
            // rather than CANCELLED (which is never stored).
            controller.abort(RUN_BUDGET_EXCEEDED);
            resolve({});
          }, runTimeoutMs);
        }),
      ]);

      if (raced.value === undefined) {
        // The budget won. The attempt is abandoned where it stands: there is no
        // Run at all, so nothing needs excluding from the aggregate downstream.
        if (cancellation.signal.aborted) return { kind: 'cancelled' };
        return { kind: 'failed', error: `run exceeded ${runTimeoutMs} ms` };
      }
      const result = raced.value;

      if (cancellation.signal.aborted) {
        return { kind: 'cancelled', run: result.cancelled ? undefined : result.run };
      }
      // TICKET 048 ROUND 4 (R4-2) — A RUN WHOSE POST WENT UNACKNOWLEDGED IS NOT
      // A COMPLETED REP, whatever its `status` says.
      //
      // Bounding the POST (R3-1) converted "the run hangs" into "the run returns
      // `complete`, the batch counts it, and NO ROW EXISTS". No stub covers it —
      // the attempt was never abandoned, so the executor's abort path never
      // fires — so three reps could run, two rows exist, and the sweep report
      // read `completedRuns: 3` with `failures: []`. That is R2-3's failure mode
      // reintroduced through a new door.
      //
      // The status is deliberately LEFT ALONE (the measurement really is
      // complete; it is the STORE that failed) and NOTHING is written here: a
      // stub would invent a row that may yet land server-side, and re-POSTing
      // would risk the very duplicate R4-1 exists to kill. Surfacing it in
      // `failures` invents nothing and loses nothing.
      //
      // KNOWN RESIDUAL — TICKET 050. The rendered provenance still reads "2 of 2"
      // rather than "2 of 3" for a lost rep, because `intendedReps` is distinct
      // `repIndex` over sweep ROWS and this rep has none. Only an idempotent
      // server-side POST keyed by run id can restore that denominator honestly.
      const postUnacknowledged = result.run.errors.some((e) => e.startsWith(RUN_POST_TIMED_OUT));
      if (result.cancelled || postUnacknowledged || result.run.status !== 'complete') {
        return {
          kind: 'failed',
          runId: result.run.id,
          error: timedOut
            ? `run exceeded ${runTimeoutMs} ms`
            : postUnacknowledged
              ? result.run.errors.find((e) => e.startsWith(RUN_POST_TIMED_OUT))
              : result.run.errors[0],
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
      if (timer !== undefined) clearTimeout(timer);
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
      const post = { inFlight: false };
      outcome = await attempt(cell, attemptNo, post);
      if (outcome.kind !== 'failed') break;
      // Cancel must not spend the retry on a run it just aborted.
      if (cancellation.signal.aborted) break;
      // TICKET 048 ROUND 4 (R4-1) — AND NEITHER MUST A POST WHOSE FATE IS
      // UNKNOWN. If the attempt reached `runs.create` and never got an
      // acknowledgement — abandoned mid-flight, or bounded out by
      // RUN_POST_TIMEOUT_MS — the row may still land, and a retry beside it
      // writes a SECOND aggregatable Run for this rep that no downstream gate can
      // tell from the first. This is the STRUCTURAL half of the defence: it holds
      // whatever the budget arithmetic says, which matters because that
      // arithmetic is a promise about constants nobody re-derives when one moves.
      //
      // NOT "already POSTed" — that would be too broad, deleting the sweep's
      // specified retry for a run whose legitimately `failed` Run was stored and
      // ACKNOWLEDGED. A known outcome is still retryable; only an unknown one is
      // not.
      if (post.inFlight) break;
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
 *
 * TICKET 028 — the executed `repIndex` rides the same stamp, in the Run's
 * `annotations` envelope. It is the only record of which repetition produced
 * the row: without it `buildProvenance`'s denominator (the distinct rep indices
 * a sweep ATTEMPTED) collapses onto its numerator and provenance can only ever
 * read "N of N", so a sweep that lost reps reports as clean. Every execution is
 * stamped, warmup included — the warmup as repIndex 0, which is not one of the
 * retained reps and stays out of the aggregate on its 'manual' origin.
 */
export function createRunOnceExecutor(deps: RunnerDeps): BatchExecutor {
  return async (request: BatchExecutorRequest): Promise<RunOnceResult> => {
    let stamped: Run | undefined;
    /** True once SOMETHING has been written for this execution — real or stub. */
    let wrote = false;

    // TICKET 048 ROUND 2 (R2-3) — A REP THE BUDGET ABANDONS STILL OWES THE
    // LEDGER A ROW.
    //
    // `derive.ts` builds `intendedReps` from the distinct `annotations.repIndex`
    // over the arm's sweep Runs of ANY status, so a rep abandoned before
    // `runOnce` produced a Run at all is absent from the DENOMINATOR and a sweep
    // that lost rep 2 renders "2 of 2 reps completed" — provenance reporting a
    // lossy sweep as clean. The stub carries the real arm, the real rep index
    // and `status: 'failed'`, so it counts as attempted and is kept out of every
    // figure by `isAggregatableRun`'s existing status clause and nothing else.
    //
    // WRITTEN FROM THE ABORT, NOT AFTER `await runOnce(...)`. The abandoning
    // cases include seams that never answer at all (a `recordings.getAudio` that
    // hangs), so a stub written on return would never be written.
    //
    // ONLY FOR THE BUDGET'S OWN ABORT. A cancelled run is deliberately never
    // POSTed, and a failure row for it would be the sweep blaming the pipeline
    // for the operator's decision.
    const onAbandoned = (): void => {
      if (request.signal.reason !== RUN_BUDGET_EXCEEDED) return;
      if (wrote) return;
      wrote = true;
      const stub: Run = {
        ...abandonedRunStub({
          id: deps.newId(),
          recordingId: request.recordingId,
          config: request.config,
          createdAt: deps.now(),
          reason: RUN_ABANDONED,
        }),
        origin: request.origin,
        annotations: { repIndex: request.repIndex },
      };
      // Fire and forget, and never allowed to reject: the attempt it belongs to
      // has already been written off, so a store that refuses the stub must not
      // surface as an unhandled rejection in an unattended sweep.
      void Promise.resolve(deps.runs.create(stub)).catch(() => undefined);
    };
    if (request.signal.aborted) onAbandoned();
    else request.signal.addEventListener('abort', onAbandoned, { once: true });

    const runs: RunsClient = {
      create: async (run: Run) => {
        // Both flags are set HERE, at CALL time, before any await — which is what
        // makes them race-free against the abort listener above (`abort()`
        // dispatches its listeners synchronously, so it can never interleave).
        wrote = true;
        // TICKET 048 ROUND 4 (R4-1) — from this instant the row's existence is
        // UNKNOWN to the client, and stays unknown until the store answers. A
        // retry started inside that window can write a second aggregatable Run
        // for this rep.
        request.reportPostInFlight?.(true);
        stamped = {
          ...run,
          origin: request.origin,
          annotations: { ...run.annotations, repIndex: request.repIndex },
        };
        const acknowledged = await deps.runs.create(stamped);
        // ...and CLEARED only on a real acknowledgement. A POST that was
        // abandoned mid-flight or bounded out by RUN_POST_TIMEOUT_MS never
        // reaches this line, so the retry stays suppressed for exactly the cases
        // where the row may still land. A rejection does not clear it either: a
        // refused fetch is no more proof the server dropped the write than a
        // timeout is.
        request.reportPostInFlight?.(false);
        return acknowledged;
      },
      list: (recordingId?: string) => deps.runs.list(recordingId),
      getAudio: (id: string) => deps.runs.getAudio(id),
      // TICKET 045 — the wrapper stamps the RECORD only; the output audio rides
      // its own endpoint and passes straight through.
      uploadAudio: (id: string, wavBytes: Uint8Array) => deps.runs.uploadAudio(id, wavBytes),
    };

    const result = await runOnce({
      recordingId: request.recordingId,
      config: request.config,
      deps: { ...deps, runs },
      signal: request.signal,
    });

    // A cancelled run is never POSTed (ticket 008), so there may be nothing
    // stamped; the returned record still reports the origin it ran under.
    return {
      ...result,
      run:
        stamped ?? {
          ...result.run,
          origin: request.origin,
          annotations: { ...result.run.annotations, repIndex: request.repIndex },
        },
    };
  };
}
