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
import { RUN_TIMEOUT_MS } from '../browserDeps';
import {
  AUDIO_UPLOAD_TIMEOUT_MS,
  MAX_CLIP_MS,
  RUN_COMPLETION_TIMED_OUT,
  RUN_COMPLETION_TIMEOUT_MS,
  RUN_POST_TIMED_OUT,
  RUN_POST_TIMEOUT_MS,
  type RunOnceConfig,
  type RunOnceResult,
  type RunnerDeps,
} from '../replay/runner';
import {
  RUN_ABANDONED,
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
  stepMs = 100,
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
  for (let elapsed = 0; elapsed < budgetMs && !settled; elapsed += stepMs) {
    await vi.advanceTimersByTimeAsync(stepMs);
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
  /**
   * ROUND 3 (R3-1) — ms the ledger POST stalls before the row really lands.
   * The row is recorded WHEN IT LANDS, not when the call is made: a POST the
   * caller gave up on has still been accepted by the server, which is precisely
   * why a retry beside it produces two rows for one rep.
   */
  createMs?: number;
  /** ROUND 3 (R3-3) — `transport.start()` NEVER resolves. */
  startForever?: boolean;
  /** ROUND 4 (R4-1) — ms `transport.start()` stalls before resolving normally. */
  startMs?: number;
  /** ROUND 4 (R4-1) — ms `recordings.getAudio` stalls before answering. */
  getAudioMs?: number;
  /** ROUND 4 (R4-3) — `transport.start()` REJECTS. */
  startRejects?: string;
  /** True: the ledger POST never answers at all. */
  createForever?: boolean;
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
/**
 * A transport whose handshake misbehaves: never lands, lands late, or REJECTS.
 * `transport.start()` is deliberately left unbounded (R2-7), so it is the seam
 * that makes the setup latency in R4-1's arithmetic real.
 */
class SlowStartTransport extends FixtureTransport {
  constructor(
    opts: ConstructorParameters<typeof FixtureTransport>[0],
    private readonly mode: { forever?: boolean; afterMs?: number; rejects?: string },
  ) {
    super(opts);
  }
  override async start(config: Parameters<FixtureTransport['start']>[0]): Promise<void> {
    await super.start(config);
    if (this.mode.forever) return new Promise<void>(() => {});
    if (this.mode.rejects !== undefined) throw new Error(this.mode.rejects);
    if (this.mode.afterMs === undefined) return;
    await new Promise<void>((resolve) => setTimeout(resolve, this.mode.afterMs));
  }
}

function realHarness(opts: {
  script?: FixtureScriptEvent[];
  scriptFor?: (req: BatchExecutorRequest) => FixtureScriptEvent[];
  stallFor?: (req: BatchExecutorRequest) => Stall;
  /** ROUND 4 (R4-1) — real pacing: the run's DOMINANT cost. Default 50 ms. */
  clipMs?: number;
}) {
  const clipMs = opts.clipMs ?? 50;
  const wav = writeWav(ramp((SAMPLE_RATE * clipMs) / 1000), SAMPLE_RATE);
  // The Recording must agree with the bytes, or `cost` and `speech_end` describe
  // a different clip from the one the pacer actually plays.
  const recording: Recording = { ...RECORDING, durationMs: clipMs, speechEndMs: clipMs };
  const posted: Run[] = [];
  const createCalls: { id: string; at: number }[] = [];
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
      list: async () => [recording],
      get: async (id) => {
        if (id !== RECORDING.id) throw new ApiError('recording-not-found', 404, 'no such id');
        return recording;
      },
      getAudio: () => {
        if (stall.getAudioForever) return new Promise<Uint8Array>(() => {});
        if (!stall.getAudioMs) return Promise.resolve(wav);
        return new Promise<Uint8Array>((resolve) => {
          setTimeout(() => resolve(wav), stall.getAudioMs);
        });
      },
      create: async () => recording,
      patchLabel: async () => recording,
      remove: async () => recording,
    };

    const runs: RunsClient = {
      create: (created: Run) => {
        createCalls.push({ id: created.id, at: Date.now() });
        if (stall.createForever) return new Promise<Run>(() => {});
        if (!stall.createMs) {
          posted.push(created);
          return Promise.resolve(created);
        }
        return new Promise<Run>((resolve) => {
          setTimeout(() => {
            // The server DID accept it; it simply answered late.
            posted.push(created);
            resolve(created);
          }, stall.createMs);
        });
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
        const transportOpts = {
          armId: 'fx',
          kind: 'cascade' as const,
          script: opts.scriptFor?.(req) ?? opts.script ?? completeScript(),
          costPerMinUsd: COST_PER_MIN,
        };
        const misbehaves =
          stall.startForever || stall.startMs !== undefined || stall.startRejects !== undefined;
        const transport = misbehaves
          ? new SlowStartTransport(transportOpts, {
              forever: stall.startForever,
              afterMs: stall.startMs,
              rejects: stall.startRejects,
            })
          : new FixtureTransport(transportOpts);
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
    createCalls,
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
function ledgerOf(posted: Run[], recording: Recording = RECORDING): RunLedger {
  const ledger = new RunLedger();
  ledger.appendRecording(recording);
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

// ===========================================================================
// TICKET 048 ROUND 3.
//
// R3-1 — THE DUPLICATE-RUN DEFECT SURVIVED, at the one stall point round 2
// never probed. Round 2's guard is a re-read of the abort signal, and the last
// re-read sits immediately BEFORE `deps.runs.create(run)`. An abort landing
// while the POST is IN FLIGHT is therefore too late: the run POSTs anyway, the
// sweep retries the attempt it abandoned, and both rows reach the append-only
// ledger with `origin: 'sweep'` and the same `annotations.repIndex`. Worse, the
// executor's stub guard sets `wrote = true` at CALL time, so the rep is not even
// accounted — the guard converts this case into the duplicate rather than the
// accounted one. Probing upload / `recordings.getAudio` / `transport.start()`
// gives 1 aggregatable Run each; probing `runs.create` gives 2, under a
// provenance line that renders a clean "1 of 1".
//
// R3-2 — THE TWO MECHANISMS ROUND 2 INVENTED ARE UNPINNED. Three separate
// deletions each leave the whole suite green, and each writes a FALSE ROW into
// an append-only stream:
//   * drop the `reason !== RUN_BUDGET_EXCEEDED` guard -> operator CANCEL writes a
//     sweep/failed stub, permanently recording the operator's decision as a
//     pipeline failure and contradicting "a cancelled run is never POSTed";
//   * drop `if (wrote) return;`      -> a stub beside the real Run, same execution;
//   * drop `wrote = true` in `create` -> the same double-write.
// The ordering that makes them correct today is protected by nothing.
//
// R3-3 — R2-2's teardown only covers aborts landing at a wait `runOnce`
// OBSERVES. `transport.start()` is awaited bare, so an abort there leaves the
// transport live until the handshake resolves on its own — forever, if it never
// does. Ticket 046's premise is that Chrome caps concurrent AudioContexts at
// about six.
// ===========================================================================

describe('a stalled ledger POST cannot produce a second sample (ticket 048, R3-1)', () => {
  it('the rep is measured ONCE: no retry races the POST, and provenance renders 1 of 1 over n=1', async () => {
    // The sweep's patience is set ABOVE the POST budget, exactly as production
    // does (120 s against 15 s). That ordering is the whole mechanism: `runOnce`
    // gives up on the acknowledgement first, so the attempt RETURNS and is never
    // abandoned mid-POST — and an attempt that is never abandoned is never
    // retried, so no second row can exist.
    const h = realHarness({
      stallFor: (req) =>
        req.repIndex === 1 && req.attempt === 1
          ? { createMs: RUN_POST_TIMEOUT_MS * 4 }
          : {},
    });

    const handle = handleOf({
      execute: h.execute,
      reps: 1,
      runTimeoutMs: RUN_POST_TIMEOUT_MS * 2,
    });
    const { settled, summary } = await drain(handle, RUN_POST_TIMEOUT_MS * 20);
    // ...and let the stalled POST land afterwards, which is what creates the
    // duplicate when a retry has been started beside it.
    await vi.advanceTimersByTimeAsync(RUN_POST_TIMEOUT_MS * 8);

    expect(settled).toBe(true);
    expect(summary!.status).toBe('complete');

    // THE criterion, stated as the reviewer's probe states it.
    const rep1 = sweepRunsOfRep(h.posted, 1);
    expect(rep1.filter((r) => isAggregatableRun(r))).toHaveLength(1);

    // ...and the figures, which is where the dishonesty actually shows: on the
    // defect this line reads "1 of 1 reps completed" over an `n` of 2 — the
    // summary is clean, the provenance is clean, and one repetition is weighted
    // twice in p50/p95.
    const arm = deriveExperimentAggregates(ledgerOf(h.posted)).perArm['B']!;
    expect(arm.n).toBe(1);
    expect(arm.provenance.line).toContain('1 of 1 reps completed');

    // ...because it was NEVER RETRIED. The attempt returned under its own budget,
    // so the sweep had no reason to start a second one — and a second one is the
    // only way a second row for this rep can be written.
    expect(h.createCalls).toHaveLength(2); // the warmup and rep 1, once each
  });

  it('CONTROL: a healthy POST is not bounded out and the rep still reads 1 of 1 (guard)', async () => {
    const h = realHarness({});
    const handle = handleOf({
      execute: h.execute,
      reps: 1,
      runTimeoutMs: RUN_POST_TIMEOUT_MS * 2,
    });
    const { settled, summary } = await drain(handle, RUN_POST_TIMEOUT_MS * 8);

    expect(settled).toBe(true);
    expect(summary!.completedRuns).toBe(1);
    expect(h.createCalls).toHaveLength(2);
    const arm = deriveExperimentAggregates(ledgerOf(h.posted)).perArm['B']!;
    expect(arm.n).toBe(1);
    expect(arm.provenance.line).toContain('1 of 1 reps completed');
  });
});

// ---------------------------------------------------------------------------

describe('what may be written for an abandoned execution (ticket 048, R3-2)', () => {
  it('GUARD: an operator CANCEL writes no stub — a cancelled run is never POSTed', async () => {
    // The `reason !== RUN_BUDGET_EXCEEDED` guard is deletable with the whole
    // suite green, and deleting it puts a sweep/failed row in an APPEND-ONLY
    // ledger for a run the operator stopped. There is no PATCH: that row is a
    // permanent claim that the pipeline failed where in fact nothing did, and it
    // would count toward the provenance denominator forever.
    const h = realHarness({
      // The warmup completes; rep 1 parks, so the cancel lands mid-run.
      scriptFor: (req) => (req.repIndex === 0 ? completeScript() : quietScript()),
    });
    const handle = handleOf({
      execute: h.execute,
      reps: 1,
      // Far above everything, so the BUDGET can never be the reason for the abort.
      runTimeoutMs: RUN_COMPLETION_TIMEOUT_MS * 4,
    });
    let settled = false;
    void handle.done.then(() => {
      settled = true;
    });

    await vi.advanceTimersByTimeAsync(1_000);
    handle.cancel();
    await vi.advanceTimersByTimeAsync(RUN_COMPLETION_TIMEOUT_MS * 4);

    expect(settled).toBe(true);
    // Only the warmup's own Run was ever written.
    expect(h.posted).toHaveLength(1);
    expect(h.posted[0]!.origin).toBe('manual');
    expect(sweepRunsOfRep(h.posted, 1)).toEqual([]);
    // Named explicitly, so a stub carrying any other reason is caught too.
    expect(h.posted.some((r) => r.errors.includes(RUN_ABANDONED))).toBe(false);
  });

  it('GUARD: a BUDGET abort writes exactly one stub per abandoned execution', async () => {
    // The mirror of the guard above: the reason guard must not be satisfiable by
    // never writing a stub at all.
    const h = realHarness({ stallFor: (req) => (req.repIndex === 1 ? { getAudioForever: true } : {}) });
    const handle = handleOf({ execute: h.execute, reps: 1, runTimeoutMs: RUN_BUDGET_MS });
    const { settled } = await drain(handle, RUN_BUDGET_MS * 20);

    expect(settled).toBe(true);
    // Two abandoned executions — the attempt and its retry — and exactly one row
    // each. Not zero (the rep would vanish from the denominator) and not two.
    const rep1 = sweepRunsOfRep(h.posted, 1);
    expect(rep1).toHaveLength(2);
    expect(rep1.every((r) => r.status === 'failed')).toBe(true);
    expect(rep1.every((r) => r.errors.includes(RUN_ABANDONED))).toBe(true);
  });

  // TICKET 061 — the abandoned row is the ONLY record that a rep was attempted
  // at all, and it rides the arm's provenance denominator forever. Written
  // without languages it is a row in an append-only ledger that cannot say
  // which direction the sweep was running — the same hole run dbeb6d94 left,
  // in the table whose entire job is to report what was attempted.
  //
  // This is the REAL path, not the constructor: startBatch -> the runOnce
  // executor's budget abort -> abandonedRunStub -> deps.runs.create. The
  // languages can only reach the POSTed row from CONFIG_B.
  it('TICKET 061: an abandoned execution POSTs a row carrying the sweep’s pair and direction', async () => {
    const h = realHarness({ stallFor: (req) => (req.repIndex === 1 ? { getAudioForever: true } : {}) });
    const handle = handleOf({ execute: h.execute, reps: 1, runTimeoutMs: RUN_BUDGET_MS });
    const { settled } = await drain(handle, RUN_BUDGET_MS * 20);

    expect(settled).toBe(true);
    const abandoned = h.posted.filter((r) => r.errors.includes(RUN_ABANDONED));
    expect(abandoned.length).toBeGreaterThan(0);
    for (const row of abandoned) {
      expect(row.languagePair).toBe(CONFIG_B.languagePair);
      expect(row.direction).toBe(CONFIG_B.direction);
    }
    // And the real Runs of the same sweep agree — one rule for both sites.
    const real = h.posted.filter((r) => !r.errors.includes(RUN_ABANDONED));
    expect(real.length).toBeGreaterThan(0);
    for (const row of real) {
      expect(row.languagePair).toBe(CONFIG_B.languagePair);
      expect(row.direction).toBe(CONFIG_B.direction);
    }
  });

  it('GUARD: an execution that already POSTed gets no stub beside its own Run', async () => {
    // `wrote = true` is set at CALL time in the wrapper, before any await, so an
    // abort landing while the POST is in flight finds it already set. That is
    // what stops a stub being written beside a real row for the SAME execution —
    // two rows for one attempt, one of them fabricated.
    //
    // Reaching that window needs a per-run budget SHORTER than the POST budget,
    // which `runTimeoutMs` being caller-supplied makes reachable.
    const h = realHarness({
      stallFor: (req) =>
        req.repIndex === 1 && req.attempt === 1
          ? { createMs: RUN_POST_TIMEOUT_MS * 4 }
          : {},
    });
    const handle = handleOf({
      execute: h.execute,
      reps: 1,
      runTimeoutMs: Math.round(RUN_POST_TIMEOUT_MS / 3),
    });
    const { settled } = await drain(handle, RUN_POST_TIMEOUT_MS * 20);
    await vi.advanceTimersByTimeAsync(RUN_POST_TIMEOUT_MS * 8);

    expect(settled).toBe(true);
    // The abandoned execution really did enter the POST before the abort landed.
    expect(h.createCalls.length).toBeGreaterThanOrEqual(2);
    // THE criterion: nothing fabricated was written for it.
    expect(h.posted.some((r) => r.errors.includes(RUN_ABANDONED))).toBe(false);
  });
});

// ---------------------------------------------------------------------------

describe('a stalled handshake gives its transport back too (ticket 048, R3-3)', () => {
  it('an abort inside transport.start() still tears the transport down', async () => {
    // `await transport.start(...)` is the one wait left that is not abort-aware,
    // and it is the WORST one to leave: the transport already exists, so an
    // abandoned attempt holds it — for Arm A an outbound sink plus an inbound tap,
    // two AudioContexts — until a handshake that may never land resolves. Four
    // abandoned attempts in a row is four live transports beside the sweep's own,
    // against Chrome's cap of roughly six.
    const h = realHarness({ stallFor: (req) => (req.repIndex === 0 ? {} : { startForever: true }) });

    const handle = handleOf({ execute: h.execute, reps: 2, runTimeoutMs: RUN_BUDGET_MS });
    const { settled } = await drain(handle, RUN_BUDGET_MS * 40);
    await vi.advanceTimersByTimeAsync(RUN_BUDGET_MS * 10);

    expect(settled).toBe(true);
    // The warmup plus two attempts on each of the two reps.
    expect(h.transports).toHaveLength(5);

    // THE criterion: nothing is still holding a context when the sweep is over.
    expect(h.live).toBe(0);
    // ...and abandoned attempts never STACK, which is 046's premise restated.
    expect(h.maxLive).toBeLessThanOrEqual(2);

    // Each abandoned attempt let go AT the abort, not when its handshake landed
    // (it never does), so the bound above is earned rather than incidental.
    for (const [i, record] of h.transports.entries()) {
      const aborted = h.abortedAt[i];
      if (aborted === null || aborted === undefined) continue;
      expect(record.stoppedAt).not.toBeNull();
      expect(record.stoppedAt! - aborted).toBeLessThanOrEqual(TOLERANCE_MS);
    }
  });

  it('CONTROL: a healthy handshake keeps its transport for the run and stops it once (guard)', async () => {
    const h = realHarness({});
    const handle = handleOf({ execute: h.execute, reps: 2, runTimeoutMs: RUN_BUDGET_MS });
    const { settled } = await drain(handle, RUN_BUDGET_MS * 8);

    expect(settled).toBe(true);
    expect(h.transports).toHaveLength(3); // warmup + two reps, no retries
    expect(h.abortedAt.every((a) => a === null)).toBe(true);
    expect(h.maxLive).toBe(1);
    expect(h.live).toBe(0);
  });
});

// ===========================================================================
// TICKET 048 ROUND 4.
//
// R4-1 — R3-1's defence is an INEQUALITY, and the inequality omitted the run's
// dominant cost. "Every budget a run can spend adds up to 77 s, against 120 s of
// sweep patience" left out PACING — up to 45 s at 1x for a PRD §9 take, a term
// larger than the 43 s of slack being claimed — and both unbounded setup awaits.
// At production constants the duplicate is still reachable, and the header
// asserts it is not. The arithmetic is fixed beside these tests; what is fixed
// HERE is structural, and it is the one that survives someone tuning a constant:
// A CELL WHOSE ATTEMPT ALREADY POSTED IS NEVER RETRIED. The executor already
// tracks exactly that (`wrote`), set at CALL time, before any await.
//
// R4-2 — and bounding the POST created a NEW way to lose a rep. A POST that
// never answers used to hang; now the run RETURNS `complete`, the batch counts
// it, and no row exists. Three reps ran, two rows, "2 of 2 reps completed".
// No stub covers it: the attempt was never abandoned, so `onAbandoned` never
// fires. The batch must at least stop calling it completed.
// ===========================================================================

describe('a cell whose attempt already POSTed is never retried (ticket 048, R4-1)', () => {
  it('the retry that would write the duplicate is not started, whatever the arithmetic says', async () => {
    // The per-run budget is deliberately set BELOW the POST budget, so the timing
    // inequality cannot be what saves this: the attempt IS abandoned mid-POST.
    // `runTimeoutMs` is caller-supplied, so this is reachable by configuration
    // alone — and the same window opens at production constants the moment a
    // clip plus setup eats the slack.
    const h = realHarness({
      stallFor: (req) =>
        req.repIndex === 1 && req.attempt === 1 ? { createMs: RUN_POST_TIMEOUT_MS * 4 } : {},
    });

    const handle = handleOf({
      execute: h.execute,
      reps: 1,
      runTimeoutMs: Math.round(RUN_POST_TIMEOUT_MS / 3),
    });
    const { settled, summary } = await drain(handle, RUN_POST_TIMEOUT_MS * 20);
    // Let the abandoned POST land — which is what writes the second row.
    await vi.advanceTimersByTimeAsync(RUN_POST_TIMEOUT_MS * 8);

    expect(settled).toBe(true);
    // The attempt really was abandoned mid-POST: it had entered `runs.create`.
    expect(h.createCalls.some((c) => c.at < RUN_POST_TIMEOUT_MS)).toBe(true);

    // THE criterion: one rep, one aggregatable sample. A retry here writes a
    // second row for the same `repIndex` that no gate can tell apart from the
    // first, and `derive.ts` counts DISTINCT rep indices, so the lie is silent.
    const rep1 = sweepRunsOfRep(h.posted, 1);
    expect(rep1.filter((r) => isAggregatableRun(r))).toHaveLength(1);
    const arm = deriveExperimentAggregates(ledgerOf(h.posted)).perArm['B']!;
    expect(arm.n).toBe(1);

    // ...because the cell was NOT tried a second time. This is the structural
    // half of the defence and it holds whatever the budget arithmetic says.
    expect(summary!.failures).toHaveLength(1);
    expect(summary!.failures[0]).toMatchObject({ repIndex: 1, attempts: 1 });
  });

  it('the R4-1 probe at PRODUCTION constants: a 45 s clip plus slow setup still measures once', async () => {
    // The reviewer's reproduction, verbatim: a §9-length clip, a 10 s
    // `recordings.getAudio`, a 25 s WebRTC handshake (both deliberately left
    // unbounded), a hung upload and a POST that lands at 20 s — against the real
    // per-run patience. On the defect this yields 2 aggregatable Runs for rep 1,
    // `n = 2`, "1 of 1 reps completed" and `summary.failures = []`.
    const h = realHarness({
      clipMs: MAX_CLIP_MS,
      stallFor: (req) =>
        req.repIndex === 1 && req.attempt === 1
          ? { getAudioMs: 10_000, startMs: 25_000, uploadMs: AUDIO_UPLOAD_TIMEOUT_MS * 2, createMs: 20_000 }
          : {},
    });

    const handle = handleOf({ execute: h.execute, reps: 1, runTimeoutMs: RUN_TIMEOUT_MS });
    const { settled, summary } = await drain(handle, RUN_TIMEOUT_MS * 4, 1_000);
    await vi.advanceTimersByTimeAsync(RUN_TIMEOUT_MS);

    expect(settled).toBe(true);

    // THE criterion, in the three places the defect shows.
    const rep1 = sweepRunsOfRep(h.posted, 1);
    expect(rep1.filter((r) => isAggregatableRun(r))).toHaveLength(1);
    const arm = deriveExperimentAggregates(
      ledgerOf(h.posted, { ...RECORDING, durationMs: MAX_CLIP_MS, speechEndMs: MAX_CLIP_MS }),
    ).perArm['B']!;
    expect(arm.n).toBe(1);
    expect(arm.provenance.line).toContain('1 of 1 reps completed');
    // ...and the sweep is not quietly reporting success over a doubled sample.
    expect(summary!.completedRuns).toBeLessThanOrEqual(1);
    // The rep was measured by exactly one execution: one transport for the
    // warmup and one for it, never a third for a retry racing a live POST.
    expect(h.transports).toHaveLength(2);
  });

  it('CONTROL: a cell whose attempt never POSTed IS still retried (guard)', async () => {
    // Without this, "never retry anything" would satisfy the tests above and
    // would silently delete the single retry the sweep is specified to spend.
    const h = realHarness({ stallFor: (req) => (req.repIndex === 1 ? { getAudioForever: true } : {}) });
    const handle = handleOf({ execute: h.execute, reps: 1, runTimeoutMs: RUN_BUDGET_MS });
    const { settled, summary } = await drain(handle, RUN_BUDGET_MS * 20);

    expect(settled).toBe(true);
    // Abandoned before `runs.create` was ever reached — the only rows written for
    // this rep are the two abandonment stubs, one per execution — so the single
    // retry the sweep is specified to spend was still owed, and still spent.
    expect(sweepRunsOfRep(h.posted, 1)).toHaveLength(2);
    expect(summary!.failures[0]).toMatchObject({ repIndex: 1, attempts: 2 });
  });
});

// ---------------------------------------------------------------------------

describe('a run whose POST went unacknowledged is not a completed rep (ticket 048, R4-2)', () => {
  it('the sweep reports the lost rep instead of counting it', async () => {
    // Bounding the POST (R3-1) turned "the run hangs" into "the run returns
    // `complete`, the batch counts it, and no row exists". Nothing writes a stub:
    // the attempt was never abandoned, so `onAbandoned` never fires, and `wrote`
    // was set at call time anyway. Three reps run, two rows exist, and the sweep
    // summary says everything succeeded.
    const h = realHarness({ stallFor: (req) => (req.repIndex === 2 ? { createForever: true } : {}) });

    const handle = handleOf({
      execute: h.execute,
      reps: 3,
      // Above the POST budget, so `runOnce` gives up on the acknowledgement first
      // and the attempt returns rather than being abandoned.
      runTimeoutMs: RUN_POST_TIMEOUT_MS * 4,
    });
    const { settled, summary } = await drain(handle, RUN_POST_TIMEOUT_MS * 40);

    expect(settled).toBe(true);

    // THE criterion: a rep whose row never landed is not a completed rep.
    expect(summary!.completedRuns).toBe(2);
    expect(summary!.runs.map((r) => (r as AnnotatedRun).annotations?.repIndex)).toEqual([1, 3]);
    // ...and it is SURFACED, with the reason, rather than vanishing.
    expect(summary!.failures.map((f) => f.repIndex)).toEqual([2]);
    expect(summary!.failures[0]!.error).toContain(RUN_POST_TIMED_OUT);

    // The ledger holds exactly the rows that were acknowledged — the bounded POST
    // invents nothing, which is the point of surfacing this in the summary
    // instead of writing a stub for a row that may yet land server-side.
    expect(h.posted.filter((r) => r.origin === 'sweep').map((r) => (r as AnnotatedRun).annotations?.repIndex)).toEqual([1, 3]);
    const arm = deriveExperimentAggregates(ledgerOf(h.posted)).perArm['B']!;
    expect(arm.n).toBe(2);

    // KNOWN GAP — TICKET 050, DELIBERATELY PINNED SO IT CANNOT DRIFT SILENTLY.
    // The rendered line still reads "2 of 2" rather than "2 of 3": `intendedReps`
    // is distinct `repIndex` over sweep ROWS, and rep 2 has none. Only an
    // idempotent server-side POST keyed by run id can restore that denominator
    // honestly — writing a stub here would invent a row that may yet land, and
    // retrying would risk the duplicate R4-1 exists to kill. When 050 lands this
    // assertion must be UPDATED to "2 of 3", never deleted.
    expect(arm.provenance.line).toContain('2 of 2 reps completed');
  });

  it('CONTROL: a rep whose POST is acknowledged is still counted (guard)', async () => {
    const h = realHarness({});
    const handle = handleOf({ execute: h.execute, reps: 3, runTimeoutMs: RUN_POST_TIMEOUT_MS * 4 });
    const { settled, summary } = await drain(handle, RUN_POST_TIMEOUT_MS * 20);

    expect(settled).toBe(true);
    expect(summary!.completedRuns).toBe(3);
    expect(summary!.failures).toEqual([]);
    const arm = deriveExperimentAggregates(ledgerOf(h.posted)).perArm['B']!;
    expect(arm.n).toBe(3);
    expect(arm.provenance.line).toContain('3 of 3 reps completed');
  });
});

// ---------------------------------------------------------------------------

describe('a REJECTING handshake still loses the run its stage (ticket 048, R4-3)', () => {
  it('GUARD: the rejection reaches the sweep as a named failure, not a swallowed one', async () => {
    // `untilSettledOrAborted` propagates rejections rather than swallowing them,
    // and reverting that was caught in only 2 of 6 full-suite runs — never as an
    // assertion, only as a suite-level crash in an unrelated file. That reads as
    // flake and gets retried away. This is the deterministic version: a sweep-path
    // `transport.start()` that REJECTS must lose the run its stage.
    const h = realHarness({
      stallFor: (req) => (req.repIndex === 1 ? { startRejects: 'handshake refused' } : {}),
    });

    const handle = handleOf({ execute: h.execute, reps: 1, runTimeoutMs: RUN_BUDGET_MS });
    const { settled, summary } = await drain(handle, RUN_BUDGET_MS * 20);

    expect(settled).toBe(true);
    // THE criterion: the reason travels, so an operator can see WHAT failed.
    expect(summary!.failures).toHaveLength(1);
    expect(summary!.failures[0]).toMatchObject({ repIndex: 1, attempts: 2 });
    expect(summary!.failures[0]!.error).toContain('handshake refused');

    // ...and a run whose handshake never happened is never a measurement: a
    // swallowed rejection would let it proceed and be counted.
    expect(summary!.completedRuns).toBe(0);
    expect(sweepRunsOfRep(h.posted, 1).filter((r) => isAggregatableRun(r))).toEqual([]);
  });

  it('CONTROL: a handshake that resolves loses the run nothing (guard)', async () => {
    const h = realHarness({ stallFor: () => ({ startMs: 100 }) });
    const handle = handleOf({ execute: h.execute, reps: 1, runTimeoutMs: RUN_BUDGET_MS });
    const { settled, summary } = await drain(handle, RUN_BUDGET_MS * 8);

    expect(settled).toBe(true);
    expect(summary!.failures).toEqual([]);
    expect(summary!.completedRuns).toBe(1);
  });
});
