/**
 * TICKET 048 — `runTimeoutMs` must actually BE a timeout.
 *
 * `startBatch` documents a per-run timeout ("THE PER-RUN TIMEOUT IS THE RUNNER'S,
 * NOT runOnce's ... a wedged transport would hang an unattended 68-minute sweep
 * forever"), but what it implements is `setTimeout(() => controller.abort())`
 * around an UNBOUNDED `await deps.execute(...)`. Nothing downstream reads that
 * signal once pacing has started — `runOnce` observes it nowhere after
 * `await pacer.start()` — so an executor that does not volunteer to stop simply
 * stalls the sweep. Every existing timeout test here is satisfied by a COOPERATIVE
 * executor (`whenAborted` in runner.test.ts rejects on the signal), which is why
 * the defect has been invisible.
 *
 * These tests use an executor that IGNORES THE SIGNAL ENTIRELY — the wedged
 * transport the comment is about — and pin that the sweep advances anyway.
 *
 * The complementary half is at the `runOnce` seam (runner.unboundedWaits.test.ts):
 * a run that bounds ITSELF fails with a NAMED reason well before this blunt abort
 * fires, so the blunt abort is the backstop and not the everyday path. The last
 * test here is that ordering, end to end through the real `createRunOnceExecutor`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DEFAULT_CASCADE_TRIPLE } from '../../core/arms';
import { SAMPLE_RATE } from '../../core/protocol';
import { writeWav } from '../../harness/wav';
import { isAggregatableRun, type Recording, type Run } from '../state/ledger';
import { FixtureTransport, type FixtureScriptEvent } from '../transport/fixture';
import { ApiError, type RecordingsClient, type RunsClient } from '../replay/recordingsClient';
import {
  RUN_COMPLETION_TIMED_OUT,
  RUN_COMPLETION_TIMEOUT_MS,
  type RunOnceConfig,
  type RunOnceResult,
  type RunnerDeps,
} from '../replay/runner';
import {
  createRunOnceExecutor,
  startBatch,
  type BatchConfiguration,
  type BatchExecutorRequest,
  type BatchHandle,
  type BatchSummary,
} from './runner';

const ramp = (n: number): Int16Array =>
  Int16Array.from({ length: n }, (_, i) => ((i * 7919) % 65536) - 32768);

const CONFIG_B: RunOnceConfig = {
  architecture: 'cascade',
  providers: DEFAULT_CASCADE_TRIPLE,
  languagePair: 'EN↔ES',
  direction: 'en→es',
  targetLanguage: 'Spanish',
};

const ONE_CONFIG: BatchConfiguration[] = [{ id: 'B', config: CONFIG_B }];

/** MIC-SHAPED: no manifest, so neither 031 deadline is armed. */
const RECORDING: Recording = {
  id: 'rec-1',
  label: 'clip one',
  sourceLanguage: 'en',
  durationMs: 100,
  speechEndMs: 60,
  origin: 'mic',
  createdAt: 1_000,
};

const RUN_TIMEOUT_MS = 5_000;

/** Slack for the fake clock's own scheduling granularity. */
const TOLERANCE_MS = 200;

function handleOf(options: {
  execute: (req: BatchExecutorRequest) => Promise<RunOnceResult>;
  reps: number;
  runTimeoutMs: number;
}): BatchHandle {
  return startBatch({
    recordingIds: [RECORDING.id],
    configurations: ONE_CONFIG,
    reps: options.reps,
    runTimeoutMs: options.runTimeoutMs,
    deps: { execute: options.execute, now: () => Date.now() },
  });
}

/**
 * Advances virtual time in coarse steps and reports WHETHER the sweep settled —
 * it never awaits `handle.done`, because a sweep that stalls would hang the test
 * rather than fail it.
 */
async function drain(
  handle: BatchHandle,
  budgetMs: number,
): Promise<{ settled: boolean; summary: BatchSummary | undefined }> {
  let settled = false;
  let summary: BatchSummary | undefined;
  void handle.done.then(
    (s) => {
      settled = true;
      summary = s;
    },
    () => {
      settled = true;
    },
  );
  const step = 100;
  for (let elapsed = 0; elapsed < budgetMs && !settled; elapsed += step) {
    await vi.advanceTimersByTimeAsync(step);
  }
  return { settled, summary };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------

describe('startBatch — runTimeoutMs bounds a run that ignores the abort (ticket 048, AC3)', () => {
  it('a WEDGED run does not stall the sweep: it is failed and the next rep runs', async () => {
    /** Virtual clock at every executor entry, so the wait is measurable. */
    const entries: { repIndex: number; attempt: number; at: number }[] = [];

    const execute = (req: BatchExecutorRequest): Promise<RunOnceResult> => {
      entries.push({ repIndex: req.repIndex, attempt: req.attempt, at: Date.now() });
      // Rep 2 is the wedged transport the runner's own comment describes: it
      // NEVER settles and it never looks at `req.signal`. Aborting a signal
      // nobody reads is not a timeout.
      if (req.repIndex === 2) return new Promise<RunOnceResult>(() => {});
      return Promise.resolve(okResult(req));
    };

    const handle = handleOf({ execute, reps: 3, runTimeoutMs: RUN_TIMEOUT_MS });
    const { settled, summary } = await drain(handle, RUN_TIMEOUT_MS * 20);

    // THE criterion: the sweep finished at all.
    expect(settled).toBe(true);
    expect(summary).toBeDefined();
    expect(summary!.status).toBe('complete');

    // It really WAITED the budget before giving up — the two attempts on rep 2
    // are one budget apart, so an implementation that abandoned the run instantly
    // fails here just as loudly as one that never abandoned it.
    const wedged = entries.filter((e) => e.repIndex === 2);
    expect(wedged).toHaveLength(2); // the first try and its single retry
    const gap = wedged[1]!.at - wedged[0]!.at;
    expect(gap).toBeGreaterThanOrEqual(RUN_TIMEOUT_MS);
    expect(gap).toBeLessThanOrEqual(RUN_TIMEOUT_MS + TOLERANCE_MS);

    // ...and the sweep ADVANCED: rep 3 ran, one budget after the retry.
    const next = entries.find((e) => e.repIndex === 3);
    expect(next).toBeDefined();
    expect(next!.at).toBeGreaterThanOrEqual(wedged[1]!.at + RUN_TIMEOUT_MS);

    // The cell is recorded as the failure it is, naming the budget it blew.
    expect(summary!.failures).toHaveLength(1);
    expect(summary!.failures[0]).toMatchObject({ repIndex: 2, status: 'failed', attempts: 2 });
    expect(summary!.failures[0]!.error).toBe(`run exceeded ${RUN_TIMEOUT_MS} ms`);
    // A run that never returned contributes NOTHING to aggregate — there is no
    // Run at all, so no second gate is needed to keep it out.
    expect(summary!.failures[0]!.runId).toBeUndefined();
    expect(summary!.runs.map((r) => r.status)).toEqual(['complete', 'complete']);
    expect(summary!.completedRuns).toBe(2);
  });

  it('CONTROL: a run that settles inside the budget is not bounded out (guard)', async () => {
    // Without this, an implementation that failed every run on a zero-length
    // deadline would satisfy the test above.
    const entries: number[] = [];
    const execute = (req: BatchExecutorRequest): Promise<RunOnceResult> => {
      entries.push(Date.now());
      return new Promise<RunOnceResult>((resolve) => {
        setTimeout(() => resolve(okResult(req)), 100);
      });
    };

    const handle = handleOf({ execute, reps: 3, runTimeoutMs: RUN_TIMEOUT_MS });
    const { settled, summary } = await drain(handle, RUN_TIMEOUT_MS * 20);

    expect(settled).toBe(true);
    expect(summary!.failures).toEqual([]);
    expect(summary!.completedRuns).toBe(3);
    // 4 executions (warmup + 3 reps), 100 ms each — nothing paid the budget.
    expect(entries).toHaveLength(4);
    expect(entries.at(-1)!).toBeLessThan(RUN_TIMEOUT_MS);
  });

  it('AC5: a bounded-out run that rejects LATE raises no unhandled rejection', async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on('unhandledRejection', onUnhandled);
    try {
      const execute = (req: BatchExecutorRequest): Promise<RunOnceResult> => {
        if (req.repIndex !== 2) return Promise.resolve(okResult(req));
        // Abandoned by the bound, then fails on its own long afterwards — the
        // real shape of a wedged transport that eventually errors out.
        return new Promise<RunOnceResult>((_resolve, reject) => {
          setTimeout(() => reject(new Error('transport gave up')), RUN_TIMEOUT_MS * 3);
        });
      };

      const handle = handleOf({ execute, reps: 3, runTimeoutMs: RUN_TIMEOUT_MS });
      const { settled, summary } = await drain(handle, RUN_TIMEOUT_MS * 20);

      expect(settled).toBe(true);
      expect(summary!.failures).toHaveLength(1);
      // Let every abandoned attempt reach its late rejection.
      await vi.advanceTimersByTimeAsync(RUN_TIMEOUT_MS * 6);
      await Promise.resolve();
      await Promise.resolve();

      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });
});

// ---------------------------------------------------------------------------

describe('a self-bounded run reaches the ledger honestly (ticket 048, AC4)', () => {
  it('a mic-shaped run whose transport goes quiet fails with its OWN reason, and the gate rejects it', async () => {
    // End to end through the real `createRunOnceExecutor`: `runTimeoutMs` here is
    // deliberately LARGER than `RUN_COMPLETION_TIMEOUT_MS`, so if the blunt abort
    // were doing the work the error would read "run exceeded ...". It must not:
    // a named reason is the whole difference between a diagnosable sweep and one
    // that reports "something took too long" 45 times.
    const wav = writeWav(ramp(SAMPLE_RATE / 20), SAMPLE_RATE);
    const posted: Run[] = [];
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
      uploadAudio: async (id: string) => ({
        id,
        outputAudioPath: `runs/${id}.out.wav`,
        bytes: 0,
      }),
    };

    /** Every event of the utterance EXCEPT its completion: the transport goes quiet. */
    const script: FixtureScriptEvent[] = [
      { at: 20, type: 'sourceText', kind: 'final', text: 'hello', utt: 0 },
      { at: 30, type: 'audio', pcm: ramp(240), utt: 0 },
      { at: 34, type: 'targetText', kind: 'final', text: 'hola', utt: 0 },
    ];

    const deps: RunnerDeps = {
      recordings,
      runs,
      createTransport: () =>
        new FixtureTransport({ armId: 'fx', kind: 'cascade', script, costPerMinUsd: 0.12 }),
      now: () => Date.now(),
      newId: () => `run-${++nextId}`,
    };

    const handle = handleOf({
      execute: createRunOnceExecutor(deps),
      reps: 1, // one discarded warmup, then one retained rep
      runTimeoutMs: RUN_COMPLETION_TIMEOUT_MS * 4,
    });
    const { settled, summary } = await drain(handle, RUN_COMPLETION_TIMEOUT_MS * 12);

    expect(settled).toBe(true);
    // Every execution bounded ITSELF and stored a Run: warmup, rep 1, rep 1 retry.
    expect(posted).toHaveLength(3);
    expect(posted.map((r) => r.origin)).toEqual(['manual', 'sweep', 'sweep']);

    for (const run of posted) {
      expect(run.status).toBe('failed');
      expect(run.errors.some((e) => e.startsWith(RUN_COMPLETION_TIMED_OUT))).toBe(true);
      // AC4 — kept out by the EXISTING clause, and demonstrably by THAT clause:
      // the same record with a complete status passes the very same gate.
      expect(isAggregatableRun(run)).toBe(false);
    }
    const swept = posted[1]!;
    expect(isAggregatableRun({ ...swept, status: 'complete' })).toBe(true);

    // The sweep reports the run's own reason, not the blunt one it never needed.
    expect(summary!.failures).toHaveLength(1);
    expect(summary!.failures[0]!.error).toContain(RUN_COMPLETION_TIMED_OUT);
    expect(summary!.failures[0]!.error).not.toContain('run exceeded');
    expect(summary!.completedRuns).toBe(0);
    expect(summary!.status).toBe('complete');
  });
});

// ---------------------------------------------------------------------------

const EMPTY_PCM = new Int16Array(0);

function okResult(req: BatchExecutorRequest): RunOnceResult {
  const run: Run = {
    id: `run-${req.configId}-r${req.repIndex}-a${req.attempt}`,
    recordingId: req.recordingId,
    architecture: 'cascade',
    providerTriple: DEFAULT_CASCADE_TRIPLE,
    modelSnapshots: { ...DEFAULT_CASCADE_TRIPLE },
    armTag: 'B',
    origin: req.origin,
    status: 'complete',
    timings: { speech_end: 1_000, audio_queued: 1_500 },
    transcripts: { source: 'hello', target: 'hola' },
    cost: 0.01,
    errors: [],
    createdAt: Date.now(),
  };
  return { run, outputAudio: EMPTY_PCM, audioReady: false, t0: 0, speechEndMs: 60, cancelled: false };
}
