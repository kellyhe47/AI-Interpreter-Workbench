/**
 * Ticket 009 — Batch runner acceptance tests (PRD §7 "The batch runner", §8
 * register, §13 test 9).
 *
 * THE LOAD-BEARING TEST is `counterbalancing`: it asserts the ACTUAL sequence
 * of (recording, configuration, rep) the executor was called with. A test that
 * read `summary.counterbalancingApplied` would pass on a runner that sets the
 * flag and always runs A first — which is exactly the failure that makes
 * `origin: 'sweep'` a lie (PRD §17 22f).
 *
 * The second load-bearing test is `warmup discard`, asserted in BOTH halves:
 * the discarded run is excluded from the aggregated set (isAggregatableRun is
 * false for it, and it is absent from the retained runs) AND it is still
 * visible in the summary. A discard that vanishes without trace is
 * indistinguishable from a run that never happened.
 *
 * EVERYTHING RUNS ON VIRTUAL TIME (vi.useFakeTimers + setSystemTime(0)). A
 * sweep is nominally ~68 minutes; no test here may cost real wall clock. The
 * single-run executor is injected, so the matrix runs with no transport at all
 * — except in the last describe, which drives the REAL ticket-008 runOnce over
 * a fixture transport to prove a sweep run takes the same code path as a
 * manual run (PRD §8: "There is no separate harness").
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_CASCADE_TRIPLE,
  REALTIME_MODEL,
  deriveArmTag,
  type ProviderTriple,
} from '../../core/arms';
import { SAMPLE_RATE, type RunOrigin } from '../../core/protocol';
import { writeWav } from '../../harness/wav';
import { isAggregatableRun, type Recording, type Run, type RunStatus } from '../state/ledger';
import { FixtureTransport, type FixtureScriptEvent } from '../transport/fixture';
import { ApiError, type RecordingsClient, type RunsClient } from '../replay/recordingsClient';
import type { RunOnceConfig, RunOnceResult, RunnerDeps } from '../replay/runner';
import {
  createRunOnceExecutor,
  startBatch,
  type BatchConfiguration,
  type BatchExecutorRequest,
  type BatchHandle,
  type BatchProgress,
  type BatchSummary,
} from './runner';
/**
 * TICKET 065 — read as a NAMESPACE so the estimator can be probed before it
 * exists. A named import of a missing export is a compile error, and this
 * ticket's tests have to typecheck cleanly while they are still red.
 */
import * as batchRunner from './runner';

// ---------------------------------------------------------------------------
// Matrix vocabulary

/** Arm A's frozen recipe — a named arm, so its runs are aggregatable. */
const CONFIG_A: RunOnceConfig = {
  architecture: 'realtime',
  realtimeModel: REALTIME_MODEL,
  languagePair: 'EN↔ES',
  direction: 'en→es',
  targetLanguage: 'Spanish',
};

/** Arm B's frozen recipe. */
const CONFIG_B: RunOnceConfig = {
  architecture: 'cascade',
  providers: DEFAULT_CASCADE_TRIPLE,
  languagePair: 'EN↔ES',
  direction: 'en→es',
  targetLanguage: 'Spanish',
};

const CONFIGS: BatchConfiguration[] = [
  { id: 'A', config: CONFIG_A },
  { id: 'B', config: CONFIG_B },
];

const ONE_CONFIG: BatchConfiguration[] = [{ id: 'B', config: CONFIG_B }];

/** Long enough that it never fires in tests that are not about the timeout. */
const NO_TIMEOUT = 600_000;

// ---------------------------------------------------------------------------
// The injected single-run executor

type Behaviour = 'ok' | 'reject' | 'failed' | 'hang';

interface Call {
  recordingId: string;
  configId: string;
  repIndex: number;
  attempt: number;
  warmup: boolean;
  origin: RunOrigin;
}

const EMPTY_PCM = new Int16Array(0);

function makeRun(req: BatchExecutorRequest, status: RunStatus): Run {
  const providers = req.config.providers as ProviderTriple | undefined;
  return {
    id: `run-${req.configId}-${req.recordingId}-r${req.repIndex}-a${req.attempt}`,
    recordingId: req.recordingId,
    architecture: req.config.architecture,
    providerTriple: providers,
    modelSnapshots:
      req.config.architecture === 'realtime'
        ? { realtime: req.config.realtimeModel ?? REALTIME_MODEL }
        : { ...(providers ?? DEFAULT_CASCADE_TRIPLE) },
    armTag: deriveArmTag(req.config),
    // The executor honours what the batch asked for — exactly as the runOnce
    // adapter does. A warmup run must not be handed 'sweep'.
    origin: req.origin,
    status,
    // TICKET 061 — the fake mirrors runOnce here too: the Run records the
    // languages of the config it ran, so the configuration is the one source
    // and this builder invents nothing. CONFIG_A/CONFIG_B both carry them.
    languagePair: req.config.languagePair,
    direction: req.config.direction,
    timings: { speech_end: 1_000, audio_queued: 1_500 },
    transcripts: { source: 'hello', target: 'hola' },
    cost: 0.01,
    errors: [],
    createdAt: 0,
  };
}

function result(run: Run, cancelled = false): RunOnceResult {
  return { run, outputAudio: EMPTY_PCM, audioReady: false, t0: 0, speechEndMs: 60, cancelled };
}

/** Rejects when the run's signal aborts; never resolves otherwise. */
function whenAborted(signal: AbortSignal): Promise<never> {
  return new Promise<never>((_, reject) => {
    if (signal.aborted) {
      reject(new Error('run aborted'));
      return;
    }
    signal.addEventListener('abort', () => reject(new Error('run aborted')), { once: true });
  });
}

interface ExecutorOptions {
  behaviour?: (req: BatchExecutorRequest) => Behaviour;
  /** Fake-clock ms each run consumes, on the faked global timer. */
  runMs?: number;
}

function makeExecutor(opts: ExecutorOptions = {}) {
  const calls: Call[] = [];
  const requests: BatchExecutorRequest[] = [];
  const runs: Run[] = [];
  let inFlight = 0;
  let maxInFlight = 0;

  const execute = async (req: BatchExecutorRequest): Promise<RunOnceResult> => {
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    calls.push({
      recordingId: req.recordingId,
      configId: req.configId,
      repIndex: req.repIndex,
      attempt: req.attempt,
      warmup: req.warmup,
      origin: req.origin,
    });
    requests.push(req);
    try {
      const behaviour = opts.behaviour?.(req) ?? 'ok';
      // Yield across several turns: a runner that launched the matrix
      // concurrently would have more than one call in flight here.
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      if (behaviour === 'hang') await whenAborted(req.signal);

      if (opts.runMs) {
        const cancelled = await new Promise<boolean>((resolve) => {
          const timer = setTimeout(() => resolve(false), opts.runMs);
          req.signal.addEventListener(
            'abort',
            () => {
              clearTimeout(timer);
              resolve(true);
            },
            { once: true },
          );
        });
        // Mirrors runOnce: an aborted run resolves cancelled, never complete.
        if (cancelled) return result(makeRun(req, 'failed'), true);
      }

      if (behaviour === 'reject') throw new Error(`boom ${req.configId}#${req.repIndex}`);
      const run = makeRun(req, behaviour === 'failed' ? 'failed' : 'complete');
      runs.push(run);
      return result(run);
    } finally {
      inFlight -= 1;
    }
  };

  return {
    execute,
    calls,
    requests,
    runs,
    get maxInFlight() {
      return maxInFlight;
    },
  };
}

/**
 * The MEASURED sequence the executor actually saw: first attempts, warmups
 * excluded. The warmup is an extra execution per configuration and its
 * position in the stream is deliberately not pinned — the alternation of the
 * counted reps is what counterbalancing means.
 */
const orderOf = (calls: Call[]): string[] =>
  calls
    .filter((c) => c.attempt === 1 && !c.warmup)
    .map((c) => `${c.recordingId}|${c.configId}|${c.repIndex}`);

// ---------------------------------------------------------------------------

let progress: BatchProgress[];

function run(options: {
  recordingIds: string[];
  configurations: BatchConfiguration[];
  reps: number;
  execute: (req: BatchExecutorRequest) => Promise<RunOnceResult>;
  runTimeoutMs?: number;
}): BatchHandle {
  return startBatch({
    recordingIds: options.recordingIds,
    configurations: options.configurations,
    reps: options.reps,
    runTimeoutMs: options.runTimeoutMs ?? NO_TIMEOUT,
    deps: { execute: options.execute, now: () => Date.now() },
    onProgress: (p) => progress.push(p),
  });
}

/** Advances virtual time until the batch settles. Never waits on real time. */
async function drain(handle: BatchHandle): Promise<BatchSummary> {
  let settled = false;
  void handle.done.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  for (let i = 0; i < 400 && !settled; i++) {
    await vi.advanceTimersByTimeAsync(50);
  }
  return handle.done;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
  progress = [];
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------

describe('batch runner — the matrix, executed sequentially', () => {
  it('runs recordings × configurations × reps with never more than one run in flight', async () => {
    const exec = makeExecutor();
    const summary = await drain(
      run({ recordingIds: ['rec-1', 'rec-2'], configurations: CONFIGS, reps: 3, execute: exec.execute }),
    );

    // 2 recordings × 2 configurations × 3 RETAINED reps. Warmups are extra
    // executions on top and are not counted in the measured matrix.
    expect(exec.calls.filter((c) => !c.warmup)).toHaveLength(12);
    expect(summary.totalRuns).toBe(12);
    expect(summary.attemptedRuns).toBe(12);
    // THE assertion: a concurrent launch would have overlapped here.
    expect(exec.maxInFlight).toBe(1);
  });

  it('visits every matrix cell exactly once', async () => {
    const exec = makeExecutor();
    await drain(
      run({ recordingIds: ['rec-1', 'rec-2'], configurations: CONFIGS, reps: 3, execute: exec.execute }),
    );

    const expected: string[] = [];
    for (const rec of ['rec-1', 'rec-2']) {
      for (const cfg of ['A', 'B']) {
        for (const rep of [1, 2, 3]) expected.push(`${rec}|${cfg}|${rep}`);
      }
    }
    expect([...orderOf(exec.calls)].sort()).toEqual(expected.sort());
  });
});

// ---------------------------------------------------------------------------

describe('batch runner — counterbalancing (PRD §8 register: A→B odd, B→A even)', () => {
  it('alternates the configuration order across reps — asserted on the ACTUAL sequence', async () => {
    const exec = makeExecutor();
    await drain(
      run({ recordingIds: ['rec-1'], configurations: CONFIGS, reps: 4, execute: exec.execute }),
    );

    // Odd reps run [A, B]; even reps run [B, A]. Nothing else is acceptable.
    expect(orderOf(exec.calls)).toEqual([
      'rec-1|A|1',
      'rec-1|B|1',
      'rec-1|B|2',
      'rec-1|A|2',
      'rec-1|A|3',
      'rec-1|B|3',
      'rec-1|B|4',
      'rec-1|A|4',
    ]);
  });

  it('alternates per repetition for every recording in the matrix', async () => {
    const exec = makeExecutor();
    await drain(
      run({ recordingIds: ['rec-1', 'rec-2'], configurations: CONFIGS, reps: 4, execute: exec.execute }),
    );

    // Grouped by (recording, rep) so the assertion does not depend on how the
    // runner nests its loops — only on the order WITHIN a repetition.
    const groups = new Map<string, string[]>();
    for (const call of exec.calls.filter((c) => c.attempt === 1 && !c.warmup)) {
      const key = `${call.recordingId}#${call.repIndex}`;
      const seen = groups.get(key) ?? [];
      seen.push(call.configId);
      groups.set(key, seen);
    }
    expect(groups.size).toBe(8); // 2 recordings × 4 reps
    for (const [key, order] of groups) {
      const rep = Number(key.split('#')[1]);
      expect({ key, order }).toEqual({ key, order: rep % 2 === 1 ? ['A', 'B'] : ['B', 'A'] });
    }
  });
});

// ---------------------------------------------------------------------------

describe('batch runner — warmup discard (PRD §8: first run per configuration)', () => {
  /** 1 recording, so "per configuration" and "per cell" cannot disagree. */
  async function sweep() {
    const exec = makeExecutor();
    const summary = await drain(
      run({ recordingIds: ['rec-1'], configurations: CONFIGS, reps: 5, execute: exec.execute }),
    );
    return { exec, summary };
  }

  it('discards an EXTRA first run per configuration — 5 reps still retain 5', async () => {
    const { exec, summary } = await sweep();

    // 2 configurations × (1 warmup + 5 retained). The warmup is additional:
    // treating it as one of the five would quietly cost 20% of N, and p95 is
    // exactly the statistic that degrades (PRD §17 22c).
    expect(exec.calls).toHaveLength(12);
    const warmups = exec.calls.filter((c) => c.warmup);
    expect(warmups.map((c) => `${c.configId}|${c.repIndex}`)).toEqual(['A|0', 'B|0']);

    // Half one: the discarded runs are NOT in the aggregated set.
    expect(summary.runs).toHaveLength(10);
    expect(summary.completedRuns).toBe(10);
    expect(summary.totalRuns).toBe(10);
    for (const cfg of ['A', 'B']) {
      expect(summary.runs.filter((r) => r.id.startsWith(`run-${cfg}-`))).toHaveLength(5);
    }
    const retainedIds = new Set(summary.runs.map((r) => r.id));
    const warmupRuns = exec.runs.filter((r) => r.id.includes('-r0-'));
    expect(warmupRuns).toHaveLength(2);
    for (const warmupRun of warmupRuns) {
      expect(retainedIds.has(warmupRun.id)).toBe(false);
      // The ledger's own gate agrees: a discarded run can never be aggregated.
      expect(isAggregatableRun(warmupRun)).toBe(false);
      expect(warmupRun.origin).not.toBe('sweep');
    }
  });

  it('records the discard rather than swallowing it', async () => {
    const { exec, summary } = await sweep();

    // Half two: still visible, and identified by cell.
    expect(summary.discarded).toHaveLength(2);
    expect(
      summary.discarded.map((d) => ({
        recordingId: d.recordingId,
        configId: d.configId,
        repIndex: d.repIndex,
        reason: d.reason,
      })),
    ).toEqual([
      { recordingId: 'rec-1', configId: 'A', repIndex: 0, reason: 'warmup' },
      { recordingId: 'rec-1', configId: 'B', repIndex: 0, reason: 'warmup' },
    ]);
    const warmupIds = new Set(exec.runs.filter((r) => r.id.includes('-r0-')).map((r) => r.id));
    for (const discard of summary.discarded) {
      expect(warmupIds.has(discard.runId ?? '')).toBe(true);
    }

    // ...and the summary states that both controls were applied (PRD §7).
    expect(summary.warmupDiscardApplied).toBe(true);
    expect(summary.counterbalancingApplied).toBe(true);

    // The progress stream shows the discarded run too — it is not hidden from
    // the operator watching a 68-minute sweep.
    expect(progress.filter((p) => p.warmup)).not.toHaveLength(0);
  });

  it("marks every retained run origin 'sweep' and never the warmup", async () => {
    const { exec, summary } = await sweep();

    for (const call of exec.calls) {
      expect({ id: `${call.configId}|${call.repIndex}`, origin: call.origin }).toEqual({
        id: `${call.configId}|${call.repIndex}`,
        origin: call.warmup ? 'manual' : 'sweep',
      });
    }
    for (const retained of summary.runs) {
      expect(retained.origin).toBe('sweep');
      expect(isAggregatableRun(retained)).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------

describe('batch runner — a failed run is retried once, then the batch continues', () => {
  /** 1 recording × 1 configuration × 3 retained reps, plus the rep-0 warmup. */
  const single = (execute: (req: BatchExecutorRequest) => Promise<RunOnceResult>) =>
    run({ recordingIds: ['rec-1'], configurations: ONE_CONFIG, reps: 3, execute });

  const attemptsFor = (calls: Call[], repIndex: number): number[] =>
    calls.filter((c) => c.repIndex === repIndex).map((c) => c.attempt);

  it('retries exactly once and retains the run when the retry succeeds', async () => {
    const exec = makeExecutor({
      behaviour: (req) => (req.repIndex === 3 && req.attempt === 1 ? 'reject' : 'ok'),
    });
    const summary = await drain(single(exec.execute));

    expect(attemptsFor(exec.calls, 3)).toEqual([1, 2]);
    expect(summary.failures).toEqual([]);
    // All three counted reps are retained, complete.
    expect(summary.runs).toHaveLength(3);
    expect(summary.runs.every((r) => r.status === 'complete' && r.origin === 'sweep')).toBe(true);
  });

  it("records status 'failed' after the second failure and continues to the next cell", async () => {
    const exec = makeExecutor({ behaviour: (req) => (req.repIndex === 2 ? 'reject' : 'ok') });
    const summary = await drain(single(exec.execute));

    expect(attemptsFor(exec.calls, 2)).toEqual([1, 2]);
    // The batch did NOT abort: rep 3 still ran, and it ended complete.
    expect(attemptsFor(exec.calls, 3)).toEqual([1]);
    expect(summary.status).toBe('complete');

    expect(summary.failures).toHaveLength(1);
    expect(summary.failures[0]).toMatchObject({
      recordingId: 'rec-1',
      configId: 'B',
      repIndex: 2,
      status: 'failed',
      attempts: 2,
    });
    expect(summary.runs.map((r) => r.id)).not.toContain('run-B-rec-1-r2-a2');
    // Reps 1 and 3 survive; rep 2 is lost.
    expect(summary.completedRuns).toBe(2);
  });

  it("treats a resolved run with status 'failed' as a failure, not a success", async () => {
    // runOnce RESOLVES a lost-stage run rather than throwing (ticket 008).
    const exec = makeExecutor({ behaviour: (req) => (req.repIndex === 2 ? 'failed' : 'ok') });
    const summary = await drain(single(exec.execute));

    expect(attemptsFor(exec.calls, 2)).toEqual([1, 2]);
    expect(summary.failures).toHaveLength(1);
    expect(summary.failures[0]).toMatchObject({ repIndex: 2, status: 'failed', attempts: 2 });
    expect(summary.runs.every((r) => r.status === 'complete')).toBe(true);
  });

  it("one cell's failure does not consume another cell's retry budget", async () => {
    const exec = makeExecutor({
      behaviour: (req) => {
        if (req.repIndex === 2) return 'reject'; // fails twice
        if (req.repIndex === 3 && req.attempt === 1) return 'reject'; // fails once
        return 'ok';
      },
    });
    const summary = await drain(single(exec.execute));

    expect(attemptsFor(exec.calls, 0)).toEqual([1]); // warmup, untouched
    expect(attemptsFor(exec.calls, 1)).toEqual([1]);
    expect(attemptsFor(exec.calls, 2)).toEqual([1, 2]);
    expect(attemptsFor(exec.calls, 3)).toEqual([1, 2]); // full budget of its own

    expect(summary.failures.map((f) => f.repIndex)).toEqual([2]);
    expect(summary.runs).toHaveLength(2); // reps 1 and 3
    expect(summary.runs.every((r) => r.status === 'complete')).toBe(true);
  });
});

// ---------------------------------------------------------------------------

describe('batch runner — the per-run timeout the runner owns (runOnce has none)', () => {
  it('aborts a run that exceeds runTimeoutMs, fails it, retries once, and continues', async () => {
    const exec = makeExecutor({ behaviour: (req) => (req.repIndex === 2 ? 'hang' : 'ok') });
    const handle = run({
      recordingIds: ['rec-1'],
      configurations: ONE_CONFIG,
      reps: 3,
      execute: exec.execute,
      runTimeoutMs: 5_000,
    });
    const summary = await drain(handle);

    // The hanging run was aborted through the signal the runner handed it...
    const hung = exec.requests.filter((r) => r.repIndex === 2);
    expect(hung).toHaveLength(2); // the original and its single retry
    expect(hung.every((r) => r.signal.aborted)).toBe(true);

    // ...counted as a failure, and the batch carried on to the next cell.
    expect(summary.failures).toHaveLength(1);
    expect(summary.failures[0]).toMatchObject({ repIndex: 2, status: 'failed', attempts: 2 });
    expect(exec.calls.filter((c) => c.repIndex === 3)).toHaveLength(1);
    expect(summary.status).toBe('complete');
  });

  it('does not abort a run that finishes inside the timeout', async () => {
    const exec = makeExecutor({ runMs: 100 });
    const summary = await drain(
      run({
        recordingIds: ['rec-1'],
        configurations: ONE_CONFIG,
        reps: 3,
        execute: exec.execute,
        runTimeoutMs: 5_000,
      }),
    );

    expect(summary.failures).toEqual([]);
    expect(summary.completedRuns).toBe(3);
    expect(exec.requests.some((r) => r.signal.aborted)).toBe(false);
  });
});

// ---------------------------------------------------------------------------

describe('batch runner — cancellation keeps the short sweep', () => {
  it('stops promptly, retains every completed run, and reports the batch cancelled', async () => {
    const exec = makeExecutor({ runMs: 100 });
    const handle = run({
      recordingIds: ['rec-1'],
      configurations: ONE_CONFIG,
      reps: 5,
      execute: exec.execute,
    });

    // The warmup and reps 1 and 2 complete; rep 3 is in flight.
    await vi.advanceTimersByTimeAsync(350);
    expect(exec.calls).toHaveLength(4);

    handle.cancel();
    const summary = await drain(handle);

    // Prompt: reps 4 and 5 were never started.
    expect(exec.calls).toHaveLength(4);
    expect(exec.calls.map((c) => c.repIndex)).toEqual([0, 1, 2, 3]);

    expect(summary.status).toBe('cancelled');
    // A cancelled sweep is a SHORT sweep: reps 1 and 2 survive.
    expect(summary.completedRuns).toBe(2);
    expect(summary.runs).toHaveLength(2);
    expect(summary.runs.every((r) => r.origin === 'sweep' && r.status === 'complete')).toBe(true);
  });
});

// ---------------------------------------------------------------------------

describe('batch runner — observable progress', () => {
  it('emits position in the matrix, the cell, rep, elapsed and an estimate', async () => {
    const exec = makeExecutor({ runMs: 100 });
    await drain(
      run({ recordingIds: ['rec-1'], configurations: CONFIGS, reps: 5, execute: exec.execute }),
    );

    // 2 configurations × 5 retained reps: the MEASURED matrix is 10, and the
    // two warmups do not inflate it — "run 17 of 45" counts measured runs.
    expect(progress.length).toBeGreaterThanOrEqual(10);
    for (const event of progress) expect(event.totalRuns).toBe(10);

    // A warmup holds no position in the measured matrix, so the bar can never
    // read more than 100%.
    const warmupEvents = progress.filter((p) => p.warmup);
    expect(warmupEvents).not.toHaveLength(0);
    for (const event of warmupEvents) expect(event.runIndex).toBe(0);

    // Position advances 1..10 through the matrix, in execution order.
    const measured = progress.filter((p) => !p.warmup);
    const indexes = measured.map((p) => p.runIndex);
    expect(indexes).toEqual([...indexes].sort((a, b) => a - b));
    expect([...new Set(indexes)]).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);

    // ...and each position names the cell that ran there (counterbalanced).
    const firstFor = (index: number): BatchProgress =>
      measured.find((p) => p.runIndex === index) as BatchProgress;
    const executed = orderOf(exec.calls);
    for (let index = 1; index <= 10; index++) {
      const event = firstFor(index);
      expect(`${event.recordingId}|${event.configId}|${event.repIndex}`).toBe(executed[index - 1]);
    }

    // Elapsed comes off the clock and never goes backwards. 12 executions of
    // 100 ms each, warmups included — the operator's clock is wall clock.
    const elapsed = progress.map((p) => p.elapsedMs);
    expect(elapsed).toEqual([...elapsed].sort((a, b) => a - b));
    expect(elapsed.at(-1)).toBeGreaterThanOrEqual(1_100);

    // An estimate is actually produced, and it shrinks as the sweep proceeds.
    const estimates = measured.map((p) => p.estimatedRemainingMs);
    expect(estimates.some((e) => typeof e === 'number')).toBe(true);
    const numeric = estimates.filter((e): e is number => typeof e === 'number');
    for (const value of numeric) expect(value).toBeGreaterThanOrEqual(0);
    expect(numeric).toEqual([...numeric].sort((a, b) => b - a));
  });
});

// ---------------------------------------------------------------------------

describe('batch runner — the summary reports actual reps against intended', () => {
  it('reports full reps per configuration on a clean sweep', async () => {
    const exec = makeExecutor();
    const summary = await drain(
      run({ recordingIds: ['rec-1'], configurations: CONFIGS, reps: 5, execute: exec.execute }),
    );

    // 5 intended, 5 completed — the warmup costs the sweep no sample.
    expect(summary.configurations).toEqual([
      { configId: 'A', intendedReps: 5, completedReps: 5 },
      { configId: 'B', intendedReps: 5, completedReps: 5 },
    ]);
  });

  it('surfaces a short rep count rather than hiding it', async () => {
    // Configuration B loses rep 3 outright (both attempts fail).
    const exec = makeExecutor({
      behaviour: (req) => (req.configId === 'B' && req.repIndex === 3 ? 'reject' : 'ok'),
    });
    const summary = await drain(
      run({ recordingIds: ['rec-1'], configurations: CONFIGS, reps: 5, execute: exec.execute }),
    );

    // The literal '4 of 5' the results provenance line renders.
    expect(summary.configurations).toEqual([
      { configId: 'A', intendedReps: 5, completedReps: 5 },
      { configId: 'B', intendedReps: 5, completedReps: 4 },
    ]);
    expect(summary.failures.map((f) => `${f.configId}|${f.repIndex}`)).toEqual(['B|3']);
  });
});

// ---------------------------------------------------------------------------
// The last criterion: a sweep run goes through ticket 008's runOnce, not a
// second implementation of it (PRD §8 "There is no separate harness").

/**
 * TICKET 028 — the Run as it reaches the ledger, with the annotation envelope
 * the Results derivations read. Declared locally (the same shape ReplayView's
 * tests declare) rather than imported from the results layer: the batch runner
 * knows about a repetition index, not about a category or a WER.
 */
type StampedRun = Run & { annotations?: { repIndex?: number } };

const RECORDING: Recording = {
  id: 'rec-1',
  label: 'clip one',
  sourceLanguage: 'en',
  durationMs: 100,
  speechEndMs: 60,
  origin: 'mic',
  createdAt: 1_000,
};

const ramp = (n: number): Int16Array =>
  Int16Array.from({ length: n }, (_, i) => ((i * 7919) % 65536) - 32768);

function utteranceScript(): FixtureScriptEvent[] {
  return [
    { at: 10, type: 'sourceText', kind: 'final', text: 'hello', utt: 0 },
    { at: 24, type: 'timing', event: 'stt_final', utt: 0, t: 24, stage: 'stt' },
    { at: 30, type: 'audio', pcm: ramp(240), utt: 0 },
    { at: 34, type: 'targetText', kind: 'final', text: 'hola', utt: 0 },
    { at: 60, type: 'utteranceComplete', record: { utt: 0 } },
  ];
}

describe('createRunOnceExecutor — the sweep drives the manual run path', () => {
  it('produces sweep-origin Runs through runOnce, one POST per run', async () => {
    const samples = ramp(SAMPLE_RATE / 20); // 50 ms of audio
    const wav = writeWav(samples, SAMPLE_RATE);
    const posted: Run[] = [];
    const transports: FixtureTransport[] = [];
    let nextId = 0;

    const recordings: RecordingsClient = {
      list: async () => [RECORDING],
      get: async (id) => {
        if (id !== RECORDING.id) throw new ApiError('recording-not-found', 404, 'no such id');
        return RECORDING;
      },
      getAudio: async () => wav,
      create: async () => RECORDING,
      patchLabel: async () => RECORDING,
      remove: async () => RECORDING,
    };
    const runs: RunsClient = {
      create: async (created: Run) => {
        posted.push(created);
        return created;
      },
      list: async () => posted,
      getAudio: async () => new Uint8Array(0),
      // TICKET 045 — the output-audio upload seam; these suites produce no assertions on it.
      uploadAudio: async (id: string) => ({ id, outputAudioPath: `runs/${id}.out.wav`, bytes: 0 }),
    };
    const deps: RunnerDeps = {
      recordings,
      runs,
      createTransport: () => {
        const transport = new FixtureTransport({ armId: 'fx', kind: 'cascade', script: utteranceScript() });
        transports.push(transport);
        return transport;
      },
      now: () => Date.now(),
      newId: () => `run-${++nextId}`,
    };

    const summary = await drain(
      run({
        recordingIds: ['rec-1'],
        configurations: ONE_CONFIG,
        reps: 1, // one discarded warmup, then one retained rep
        execute: createRunOnceExecutor(deps),
      }),
    );

    // It really went through runOnce: a transport was built and driven per run.
    expect(transports).toHaveLength(2);
    expect(transports[0]!.received.length).toBeGreaterThan(0);

    // Exactly one Run per executed run reaches the ledger — no duplicate
    // manual copy of a sweep run.
    expect(posted).toHaveLength(2);
    expect(posted.map((r) => r.origin)).toEqual(['manual', 'sweep']);

    expect(summary.runs).toHaveLength(1);
    const retained = summary.runs[0]!;
    expect(retained.origin).toBe('sweep');
    expect(retained.armTag).toBe('B');
    expect(retained.status).toBe('complete');
    expect(retained.recordingId).toBe('rec-1');
    // The ledger gate accepts it — which is the whole point of the sweep.
    expect(isAggregatableRun(retained)).toBe(true);
    expect(posted[1]).toEqual(retained);
  });
});

// ---------------------------------------------------------------------------
// TICKET 028 — the repIndex the executor is handed must reach the ledger.
//
// `createRunOnceExecutor` already receives `request.repIndex` and already
// stamps `request.origin` onto the Run on its way to `create()`; it dropped the
// index. Nothing downstream can recover it, so `buildProvenance`'s denominator
// (`intendedReps`, the distinct rep indices a sweep ATTEMPTED) always collapsed
// onto its numerator and provenance could only ever read "N of N" — a sweep
// that lost reps to failures reporting as clean.

/** The runOnce dependency bag over a fixture transport. Touches no network. */
function runOnceHarness() {
  const wav = writeWav(ramp(SAMPLE_RATE / 20), SAMPLE_RATE);
  const posted: StampedRun[] = [];
  let nextId = 0;

  const recordings: RecordingsClient = {
    list: async () => [RECORDING],
    get: async (id) => {
      if (id !== RECORDING.id) throw new ApiError('recording-not-found', 404, 'no such id');
      return RECORDING;
    },
    getAudio: async () => wav,
    create: async () => RECORDING,
    patchLabel: async () => RECORDING,
    remove: async () => RECORDING,
  };
  const runs: RunsClient = {
    create: async (created: Run) => {
      posted.push(created);
      return created;
    },
    list: async () => posted,
    getAudio: async () => new Uint8Array(0),
    // TICKET 045 — the output-audio upload seam; these suites produce no assertions on it.
    uploadAudio: async (id: string) => ({ id, outputAudioPath: `runs/${id}.out.wav`, bytes: 0 }),
  };
  const deps: RunnerDeps = {
    recordings,
    runs,
    createTransport: () =>
      new FixtureTransport({ armId: 'fx', kind: 'cascade', script: utteranceScript() }),
    now: () => Date.now(),
    newId: () => `run-${++nextId}`,
  };
  return { deps, posted };
}

describe('createRunOnceExecutor — the executed repIndex reaches the ledger', () => {
  it('stamps every executed repIndex onto the Run it POSTs, and onto the retained runs', async () => {
    const { deps, posted } = runOnceHarness();

    const summary = await drain(
      run({
        recordingIds: ['rec-1'],
        configurations: ONE_CONFIG,
        reps: 3, // one discarded warmup, then reps 1..3
        execute: createRunOnceExecutor(deps),
      }),
    );

    // One POST per execution, each carrying the index it ran as. `reps` means
    // RETAINED reps, so the warmup is the extra rep 0 — never one of the three.
    expect(posted.map((r) => r.annotations?.repIndex)).toEqual([0, 1, 2, 3]);
    expect(posted.map((r) => r.origin)).toEqual(['manual', 'sweep', 'sweep', 'sweep']);

    // ...and the record the summary hands back is the record that was stored.
    expect((summary.runs as StampedRun[]).map((r) => r.annotations?.repIndex)).toEqual([1, 2, 3]);
  });

  it('the warmup Run carries repIndex 0 and STILL fails the aggregation gate', async () => {
    const { deps, posted } = runOnceHarness();

    await drain(
      run({
        recordingIds: ['rec-1'],
        configurations: ONE_CONFIG,
        reps: 2,
        execute: createRunOnceExecutor(deps),
      }),
    );

    const warmup = posted[0]!;
    expect(warmup.annotations?.repIndex).toBe(0);
    // The annotation must not become a second route into the aggregate: the
    // gate is `isAggregatableRun` and nothing else, and origin still decides.
    expect(warmup.origin).toBe('manual');
    expect(isAggregatableRun(warmup)).toBe(false);
    for (const retained of posted.slice(1)) {
      expect(isAggregatableRun(retained)).toBe(true);
    }
  });
});

/* ================ TICKET 065 — the count the OPERATOR is billed for ======== */

/**
 * TICKET 065 — `executionCount` is the arithmetic behind the pre-launch
 * confirmation, and it lives HERE, beside the planner it has to agree with.
 *
 * THE WHOLE POINT IS THE TERM `totalRuns` LEAVES OUT. `startBatch` computes
 * `totalRuns = recordings × configurations × reps` (runner.ts:308) — warmups
 * EXCLUDED — and that is the number already on screen in BatchProgress ("run 17
 * of 45"), so it is the number a fresh implementer reaches for. It is 20% short
 * of what the sweep actually executes, and therefore 20% short of both the bill
 * and the wall clock. A confirmation that named it would be this project's
 * characteristic failure: a figure that is precise, derived, and about the
 * wrong quantity.
 *
 * The last test grounds the helper in what the runner ACTUALLY does rather than
 * in a second copy of the same formula — if `planCells` ever stops emitting one
 * warmup per (recording × configuration), the estimator is wrong and this says
 * so.
 */
describe('TICKET 065 — executionCount counts the warmups the bill includes', () => {
  type ExecutionCountFn = (recordings: number, configurations: number, reps: number) => number;

  /** Probed off the namespace: the export does not exist yet (see the import). */
  const executionCount = (batchRunner as unknown as { executionCount?: ExecutionCountFn })
    .executionCount;

  it('is exported from the module that owns the plan, so the two cannot drift', () => {
    expect(typeof executionCount).toBe('function');
  });

  it('1 × 3 × 5 is EIGHTEEN executions — not the fifteen totalRuns reports', () => {
    // Hand-derived, deliberately not re-expressed from the component's own
    // constants: 3 arms × (5 retained + 1 warmup) = 18 over one recording.
    expect(executionCount!(1, 3, 5)).toBe(18);
    expect(executionCount!(1, 3, 5)).not.toBe(15);
  });

  it('at PRD §15A’s three reps a single-clip sweep is TWELVE executions', () => {
    // 3 arms × (3 retained + 1 warmup) = 12; runner.totalRuns would say 9.
    expect(executionCount!(1, 3, 3)).toBe(12);
    expect(executionCount!(1, 3, 3)).not.toBe(9);
  });

  it('the reps multiplier is really in the arithmetic: 3 → 5 adds configurations × 2', () => {
    // A per-cell estimate that forgot to multiply by reps moves by 0 here.
    expect(executionCount!(1, 3, 5) - executionCount!(1, 3, 3)).toBe(6);
    expect(executionCount!(2, 4, 5) - executionCount!(2, 4, 3)).toBe(2 * 4 * 2);
  });

  it('the recordings multiplier is in it too', () => {
    expect(executionCount!(3, 3, 3)).toBe(36);
  });

  it('IT AGREES WITH WHAT THE RUNNER ACTUALLY EXECUTES, not with a second formula', async () => {
    const exec = makeExecutor();
    const summary = await drain(
      run({ recordingIds: ['rec-1'], configurations: CONFIGS, reps: 3, execute: exec.execute }),
    );

    // Every execution the executor saw, retries excluded — warmups included.
    const executed = exec.calls.filter((c) => c.attempt === 1).length;
    expect(executed).toBe(8); // 1 × 2 × (3 + 1)
    expect(executionCount!(1, CONFIGS.length, 3)).toBe(executed);
    // ...and the runner's own measured count is a DIFFERENT, smaller number.
    expect(summary.totalRuns).toBe(6);
    expect(executionCount!(1, CONFIGS.length, 3)).toBeGreaterThan(summary.totalRuns);
  });
});
