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
import { deriveExperimentAggregates, type AnnotatedRun } from '../components/results/derive';
import { RunLedger, isAggregatableRun, type Recording, type Run } from '../state/ledger';
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

const RUN_BUDGET_MS = 5_000;

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

    const handle = handleOf({ execute, reps: 3, runTimeoutMs: RUN_BUDGET_MS });
    const { settled, summary } = await drain(handle, RUN_BUDGET_MS * 20);

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
    expect(gap).toBeGreaterThanOrEqual(RUN_BUDGET_MS);
    expect(gap).toBeLessThanOrEqual(RUN_BUDGET_MS + TOLERANCE_MS);

    // ...and the sweep ADVANCED: rep 3 ran, one budget after the retry.
    const next = entries.find((e) => e.repIndex === 3);
    expect(next).toBeDefined();
    expect(next!.at).toBeGreaterThanOrEqual(wedged[1]!.at + RUN_BUDGET_MS);

    // The cell is recorded as the failure it is, naming the budget it blew.
    expect(summary!.failures).toHaveLength(1);
    expect(summary!.failures[0]).toMatchObject({ repIndex: 2, status: 'failed', attempts: 2 });
    expect(summary!.failures[0]!.error).toBe(`run exceeded ${RUN_BUDGET_MS} ms`);
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

    const handle = handleOf({ execute, reps: 3, runTimeoutMs: RUN_BUDGET_MS });
    const { settled, summary } = await drain(handle, RUN_BUDGET_MS * 20);

    expect(settled).toBe(true);
    expect(summary!.failures).toEqual([]);
    expect(summary!.completedRuns).toBe(3);
    // 4 executions (warmup + 3 reps), 100 ms each — nothing paid the budget.
    expect(entries).toHaveLength(4);
    expect(entries.at(-1)!).toBeLessThan(RUN_BUDGET_MS);
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
          setTimeout(() => reject(new Error('transport gave up')), RUN_BUDGET_MS * 3);
        });
      };

      const handle = handleOf({ execute, reps: 3, runTimeoutMs: RUN_BUDGET_MS });
      const { settled, summary } = await drain(handle, RUN_BUDGET_MS * 20);

      expect(settled).toBe(true);
      expect(summary!.failures).toHaveLength(1);
      // Let every abandoned attempt reach its late rejection.
      await vi.advanceTimersByTimeAsync(RUN_BUDGET_MS * 6);
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

// ===========================================================================
// TICKET 048 ROUND 2 — WHAT THE BUDGET ABANDONS MUST REALLY BE ABANDONED.
//
// Round 1 made `runTimeoutMs` stop WAITING. It did not make the abandoned
// attempt stop WORKING, and `runOnce` reads `signal` exactly once — immediately
// after pacing — so every decision downstream keys on that snapshot. An attempt
// that blows the budget AFTER pacing (a stalled upload, a stalled POST, a
// transport that went quiet) therefore runs to completion in the background and:
//
//   R2-1  POSTs an `origin:'sweep'`, `status:'complete'` Run carrying the rep's
//         `repIndex`, beside the one its retry POSTs. Both pass
//         `isAggregatableRun`, so p50/p95 and `n` are pooled over TWO samples of
//         one repetition — while `derive.ts` counts DISTINCT rep indices and
//         renders "1 of 1 reps completed". The provenance line says the sweep is
//         clean while the figures are silently double-weighted.
//   R2-2  keeps its transport — for Arm A an outbound sink plus an inbound tap,
//         two AudioContexts — alive beside the retry's own, for as long as its
//         own completion budget. That partially reverses ticket 046's premise
//         (Chrome caps concurrent contexts at roughly six) at exactly the moment
//         the sweep is already unhealthy.
//   R2-3  and when it is abandoned so early that no Run exists at all, the rep
//         vanishes from `intendedReps` — which is DISTINCT `repIndex` over sweep
//         Runs of ANY status — so a sweep that lost rep 2 renders "2 of 2".
//         That is the failure AGENTS.md names verbatim: provenance that reports
//         a lossy sweep as clean.
// ===========================================================================

/** A complete cascade answer — transcripts, audio, and a completion. */
function completeScript(): FixtureScriptEvent[] {
  return [
    { at: 20, type: 'sourceText', kind: 'final', text: 'hello', utt: 0 },
    { at: 30, type: 'audio', pcm: ramp(240), utt: 0 },
    { at: 34, type: 'targetText', kind: 'final', text: 'hola', utt: 0 },
    { at: 90, type: 'utteranceComplete', record: { utt: 0 } },
  ];
}

/** The same answer with the completion REMOVED: the transport goes quiet. */
function quietScript(): FixtureScriptEvent[] {
  return completeScript().filter((e) => e.type !== 'utteranceComplete');
}

const COST_PER_MIN = 0.12;

interface Stall {
  /** ms the upload stalls before answering normally. 0 = immediate. */
  uploadMs?: number;
  /** True: `recordings.getAudio` NEVER answers, so no Run can ever exist. */
  getAudioForever?: boolean;
}

interface TransportRecord {
  createdAt: number;
  stoppedAt: number | null;
}

/**
 * The REAL `runOnce` behind the executor, one dependency bag per request so
 * every seam knows which (rep, attempt) it is serving. Two attempts of one cell
 * overlap once the first is abandoned, and a bag shared between them could not
 * tell them apart.
 */
function realHarness(opts: {
  script?: FixtureScriptEvent[];
  stallFor?: (req: BatchExecutorRequest) => Stall;
}) {
  const wav = writeWav(ramp(SAMPLE_RATE / 20), SAMPLE_RATE);
  const posted: Run[] = [];
  const uploads: string[] = [];
  const transports: TransportRecord[] = [];
  /** Virtual clock at which each attempt's signal aborted. */
  const abortedAt: (number | null)[] = [];
  let nextId = 0;
  let live = 0;
  let maxLive = 0;

  const depsFor = (req: BatchExecutorRequest): RunnerDeps => {
    const stall = opts.stallFor?.(req) ?? {};

    const recordings: RecordingsClient = {
      list: async () => [RECORDING],
      get: async (id) => {
        if (id !== RECORDING.id) throw new ApiError('recording-not-found', 404, 'no such id');
        return RECORDING;
      },
      getAudio: () =>
        stall.getAudioForever
          ? new Promise<Uint8Array>(() => {})
          : Promise.resolve(wav),
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
      uploadAudio: (id: string) => {
        uploads.push(id);
        const answer = { id, outputAudioPath: `runs/${id}.out.wav`, bytes: 0 };
        if (!stall.uploadMs) return Promise.resolve(answer);
        return new Promise<typeof answer>((resolve) => {
          setTimeout(() => resolve(answer), stall.uploadMs);
        });
      },
    };

    return {
      recordings,
      runs,
      createTransport: () => {
        const record: TransportRecord = { createdAt: Date.now(), stoppedAt: null };
        transports.push(record);
        live += 1;
        maxLive = Math.max(maxLive, live);
        const transport = new FixtureTransport({
          armId: 'fx',
          kind: 'cascade',
          script: opts.script ?? completeScript(),
          costPerMinUsd: COST_PER_MIN,
        });
        const stop = transport.stop.bind(transport);
        vi.spyOn(transport, 'stop').mockImplementation(() => {
          if (record.stoppedAt === null) {
            record.stoppedAt = Date.now();
            live -= 1;
          }
          stop();
        });
        return transport;
      },
      now: () => Date.now(),
      newId: () => `run-${++nextId}`,
    };
  };

  const execute = (req: BatchExecutorRequest): Promise<RunOnceResult> => {
    const index = abortedAt.length;
    abortedAt.push(null);
    req.signal.addEventListener(
      'abort',
      () => {
        abortedAt[index] = Date.now();
      },
      { once: true },
    );
    return createRunOnceExecutor(depsFor(req))(req);
  };

  return {
    execute,
    posted,
    uploads,
    transports,
    abortedAt,
    get maxLive() {
      return maxLive;
    },
    get live() {
      return live;
    },
  };
}

/** The posted Runs of one rep, sweep-origin only. */
const sweepRunsOfRep = (posted: Run[], repIndex: number): AnnotatedRun[] =>
  (posted as AnnotatedRun[]).filter(
    (r) => r.origin === 'sweep' && r.annotations?.repIndex === repIndex,
  );

/** The ledger the Results layer would derive from, built from what was POSTed. */
function ledgerOf(posted: Run[]): RunLedger {
  const ledger = new RunLedger();
  ledger.appendRecording(RECORDING);
  for (const run of posted) ledger.appendRun(run);
  return ledger;
}

// ---------------------------------------------------------------------------

describe('an abandoned attempt does not write (ticket 048, R2-1)', () => {
  it('a stalled UPLOAD must not produce a second aggregatable Run for the rep', async () => {
    // The attempt blows the budget while its upload is in flight, so the abort
    // lands AFTER pacing — the one place `runOnce` never looks again. It then
    // finishes on its own schedule and POSTs a complete sweep Run for rep 1,
    // while the retry POSTs its own.
    const h = realHarness({
      // 8 s: past the 5 s per-run budget, inside the upload's own deadline, so
      // the upload really does answer rather than timing out.
      stallFor: (req) =>
        req.repIndex === 1 && req.attempt === 1 ? { uploadMs: RUN_BUDGET_MS + 3_000 } : {},
    });

    const handle = handleOf({ execute: h.execute, reps: 1, runTimeoutMs: RUN_BUDGET_MS });
    const { settled, summary } = await drain(handle, RUN_BUDGET_MS * 20);
    // Let the abandoned attempt's upload answer and its run finish unwinding.
    await vi.advanceTimersByTimeAsync(RUN_BUDGET_MS * 10);

    expect(settled).toBe(true);
    expect(summary!.completedRuns).toBe(1);

    // THE criterion: ONE aggregatable Run for rep 1 — the retry's.
    const rep1 = sweepRunsOfRep(h.posted, 1);
    expect(rep1.filter((r) => isAggregatableRun(r))).toHaveLength(1);

    // ...and the figures say so. `n` pooled over two samples of one repetition
    // while provenance counts DISTINCT rep indices is exactly the silent
    // double-weighting this exists to prevent.
    const arm = deriveExperimentAggregates(ledgerOf(h.posted)).perArm['B']!;
    expect(arm.n).toBe(1);
    expect(arm.provenance.completedReps).toBe(1);
    expect(arm.provenance.intendedReps).toBe(1);
    expect(arm.provenance.line).toContain('1 of 1 reps completed');
  });

  it('an abandoned attempt uploads nothing once the abort has landed', async () => {
    // Same hole at the other seam: here the abort lands while the run is parked
    // on `finished`, so `uploadOutputAudio` has not been entered yet. Uploading
    // afterwards writes an artifact for a run the sweep has written off, and
    // (045) the path is then claimed by whatever Run gets POSTed.
    const h = realHarness({ script: quietScript() });

    const handle = handleOf({ execute: h.execute, reps: 1, runTimeoutMs: RUN_BUDGET_MS });
    const { settled } = await drain(handle, RUN_COMPLETION_TIMEOUT_MS * 6);
    await vi.advanceTimersByTimeAsync(RUN_COMPLETION_TIMEOUT_MS * 3);

    expect(settled).toBe(true);
    // Every execution here is abandoned by the budget, so NOTHING may be stored.
    expect(h.uploads).toEqual([]);
    expect(h.posted.some((r) => r.outputAudioPath !== undefined)).toBe(false);
    // ...and none of them claims to be a measurement.
    expect(h.posted.every((r) => r.status === 'failed')).toBe(true);
  });

  it('CONTROL: a healthy sweep still uploads and POSTs one Run per execution (guard)', async () => {
    // Without this, a runner that stopped writing altogether would pass both
    // tests above.
    const h = realHarness({});
    const handle = handleOf({ execute: h.execute, reps: 1, runTimeoutMs: RUN_BUDGET_MS });
    const { settled, summary } = await drain(handle, RUN_BUDGET_MS * 4);

    expect(settled).toBe(true);
    expect(summary!.completedRuns).toBe(1);
    expect(h.uploads).toHaveLength(2); // the warmup and the retained rep
    expect(h.posted.map((r) => r.origin)).toEqual(['manual', 'sweep']);
    expect(h.posted.every((r) => r.status === 'complete')).toBe(true);
    expect(sweepRunsOfRep(h.posted, 1).filter((r) => isAggregatableRun(r))).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------

describe('an abandoned attempt gives its transport back (ticket 048, R2-2)', () => {
  it('the abandoned run tears its transport down at the abort, not at its own deadline', async () => {
    // A transport that went quiet parks the run on `finished` for its full
    // completion budget. Abandoned at the 5 s per-run budget, it goes on holding
    // its transport for another 25 s — and for Arm A that is two live
    // AudioContexts — while the retry builds its own. Ticket 046 exists because
    // Chrome caps concurrent contexts at roughly six.
    const h = realHarness({ script: quietScript() });

    const handle = handleOf({ execute: h.execute, reps: 1, runTimeoutMs: RUN_BUDGET_MS });
    const { settled } = await drain(handle, RUN_COMPLETION_TIMEOUT_MS * 6);
    await vi.advanceTimersByTimeAsync(RUN_COMPLETION_TIMEOUT_MS * 3);
    expect(settled).toBe(true);

    // Three executions: the warmup, rep 1, and rep 1's retry — each abandoned.
    expect(h.transports).toHaveLength(3);
    for (const [i, record] of h.transports.entries()) {
      const aborted = h.abortedAt[i];
      expect(aborted).not.toBeNull();
      expect(record.stoppedAt).not.toBeNull();
      // It really let go at the abort — an abandoned run must honour a LATE
      // abort at its next await, not sleep out its own budget first.
      expect(record.stoppedAt! - aborted!).toBeLessThanOrEqual(TOLERANCE_MS);
      expect(record.stoppedAt! - aborted!).toBeLessThan(RUN_COMPLETION_TIMEOUT_MS);
    }

    // Nothing is left holding a context, and abandoned runs never STACK: the
    // count does not grow with the number of attempts the sweep writes off.
    expect(h.live).toBe(0);
    expect(h.maxLive).toBeLessThanOrEqual(2);
  });

  it('CONTROL: a healthy run keeps its transport for the whole run and stops it once (guard)', async () => {
    const h = realHarness({});
    const handle = handleOf({ execute: h.execute, reps: 1, runTimeoutMs: RUN_BUDGET_MS });
    const { settled } = await drain(handle, RUN_BUDGET_MS * 4);

    expect(settled).toBe(true);
    expect(h.transports).toHaveLength(2);
    // Never abandoned, so never aborted — the teardown is the run's own.
    expect(h.abortedAt.every((a) => a === null)).toBe(true);
    expect(h.transports.every((t) => t.stoppedAt !== null)).toBe(true);
    // Strictly sequential: the next transport is built only once the last is gone.
    expect(h.maxLive).toBe(1);
    expect(h.live).toBe(0);
  });
});

// ---------------------------------------------------------------------------

describe('a lost rep stays in the provenance denominator (ticket 048, R2-3)', () => {
  it('a rep abandoned before any Run exists is still counted as attempted', async () => {
    // `recordings.getAudio` never answers, so rep 2 is abandoned before `runOnce`
    // has a Run to POST — the case round 1 recorded as "there is no Run at all, so
    // nothing needs excluding downstream". That reasoning is wrong in the other
    // direction: `intendedReps` is DISTINCT `repIndex` over sweep Runs of ANY
    // status, so a rep with no Run is absent from the DENOMINATOR and the sweep
    // renders "2 of 2" — a lossy sweep reporting as clean, which is the failure
    // AGENTS.md names verbatim.
    const h = realHarness({ stallFor: (req) => (req.repIndex === 2 ? { getAudioForever: true } : {}) });

    const handle = handleOf({ execute: h.execute, reps: 3, runTimeoutMs: RUN_BUDGET_MS });
    const { settled, summary } = await drain(handle, RUN_BUDGET_MS * 20);

    expect(settled).toBe(true);
    expect(summary!.failures.map((f) => f.repIndex)).toEqual([2]);

    // The rep is REPRESENTED in the ledger, as the failure it was.
    const rep2 = sweepRunsOfRep(h.posted, 2);
    expect(rep2.length).toBeGreaterThan(0);
    expect(rep2.every((r) => r.status === 'failed')).toBe(true);
    expect(rep2.every((r) => r.errors.length > 0)).toBe(true);

    // Kept out by the EXISTING clause, and demonstrably by THAT clause: flip only
    // `status` and the same gate changes its mind. No second gate beside it.
    const stub = rep2[0]!;
    expect(isAggregatableRun(stub)).toBe(false);
    expect(isAggregatableRun({ ...stub, status: 'complete' })).toBe(true);

    // THE criterion: the denominator tells the truth.
    const arm = deriveExperimentAggregates(ledgerOf(h.posted)).perArm['B']!;
    expect(arm.provenance.completedReps).toBe(2);
    expect(arm.provenance.intendedReps).toBe(3);
    expect(arm.provenance.line).toContain('2 of 3 reps completed');
    // ...and the lost rep contributes no sample to the figures it is absent from.
    expect(arm.n).toBe(2);
  });

  it('CONTROL: a sweep that loses nothing still reads N of N (guard)', async () => {
    const h = realHarness({});
    const handle = handleOf({ execute: h.execute, reps: 3, runTimeoutMs: RUN_BUDGET_MS });
    const { settled, summary } = await drain(handle, RUN_BUDGET_MS * 8);

    expect(settled).toBe(true);
    expect(summary!.failures).toEqual([]);
    const arm = deriveExperimentAggregates(ledgerOf(h.posted)).perArm['B']!;
    expect(arm.provenance.line).toContain('3 of 3 reps completed');
    expect(arm.n).toBe(3);
  });
});

// ---------------------------------------------------------------------------

describe('a bounded-out attempt during a CANCELLED sweep is not a failure (ticket 048, R2-5)', () => {
  it('cancel wins the budget: the in-flight run is cancelled, not failed, and is not retried', async () => {
    // The `cancellation.signal.aborted` yield inside the budget's own branch was
    // deletable with the whole suite green. Without it a cancelled sweep records
    // a spurious failure for the run the OPERATOR stopped — "a cancelled sweep is
    // a SHORT sweep, not a discarded one", and a failure row is the sweep blaming
    // the pipeline for the operator's decision.
    const entries: { repIndex: number; attempt: number }[] = [];
    const execute = (req: BatchExecutorRequest): Promise<RunOnceResult> => {
      entries.push({ repIndex: req.repIndex, attempt: req.attempt });
      // The warmup settles; rep 1 wedges and ignores the signal entirely.
      if (req.repIndex === 0) return Promise.resolve(okResult(req));
      return new Promise<RunOnceResult>(() => {});
    };

    const handle = handleOf({ execute, reps: 3, runTimeoutMs: RUN_BUDGET_MS });
    let settled = false;
    let summary: BatchSummary | undefined;
    void handle.done.then((s) => {
      settled = true;
      summary = s;
    });

    // The operator stops the sweep while rep 1 is still wedged...
    await vi.advanceTimersByTimeAsync(1_000);
    handle.cancel();
    // ...and only then does the budget expire on it.
    await vi.advanceTimersByTimeAsync(RUN_BUDGET_MS * 4);

    expect(settled).toBe(true);
    expect(summary!.status).toBe('cancelled');
    // THE criterion: the operator's cancel is not recorded as a pipeline failure.
    expect(summary!.failures).toEqual([]);
    // ...and it did not spend the retry on a run it had just abandoned.
    expect(entries).toEqual([
      { repIndex: 0, attempt: 1 },
      { repIndex: 1, attempt: 1 },
    ]);
  });

  it('the other direction: with no cancel the same wedged run IS a failure and IS retried', async () => {
    // The mirror, so "always report cancelled" cannot satisfy the test above.
    const entries: { repIndex: number; attempt: number }[] = [];
    const execute = (req: BatchExecutorRequest): Promise<RunOnceResult> => {
      entries.push({ repIndex: req.repIndex, attempt: req.attempt });
      if (req.repIndex === 0) return Promise.resolve(okResult(req));
      return new Promise<RunOnceResult>(() => {});
    };

    const handle = handleOf({ execute, reps: 1, runTimeoutMs: RUN_BUDGET_MS });
    const { settled, summary } = await drain(handle, RUN_BUDGET_MS * 20);

    expect(settled).toBe(true);
    expect(summary!.status).toBe('complete');
    expect(summary!.failures).toHaveLength(1);
    expect(summary!.failures[0]!.attempts).toBe(2);
    expect(entries).toEqual([
      { repIndex: 0, attempt: 1 },
      { repIndex: 1, attempt: 1 },
      { repIndex: 1, attempt: 2 },
    ]);
  });
});
