/**
 * TICKET 048 — the two remaining UNBOUNDED waits in `runOnce`.
 *
 * Ticket 046 R3-1 bounded exactly one of them (`await transport.stop()`), for a
 * reason that applies verbatim to the other two: NOTHING RACES `deps.execute(...)`.
 * `startBatch`'s `runTimeoutMs` only calls `controller.abort()`, and `runOnce`
 * observes that signal nowhere after `await pacer.start()`. So `runTimeoutMs` is
 * not a timeout, and every remaining wait in the tail of a run is unbounded:
 *
 *   1. `uploadOutputAudio` -> `runs.uploadAudio` is a bare browser `fetch` with no
 *      timeout. A server that accepts the connection and never responds hangs the
 *      run forever.
 *   2. `await finished` is unbounded for a MANIFEST-LESS (mic-shaped) run: it arms
 *      neither 031 timer, so a transport that goes quiet without completing its
 *      utterance freezes the run "running" for good.
 *
 * ========================= WHICH TIMEOUTS ARE FATAL ========================
 *
 * The ticket's own note ("a run that timed out is not a measurement") and its AC1
 * ("a hung upload must still store the Run and keep every timing figure") pull in
 * opposite directions, so the rule has to be stated rather than guessed. THE LINE
 * IS DRAWN AT THE MEASUREMENT, NOT AT THE CLOCK:
 *
 * - THE UPLOAD DEADLINE IS NOT FATAL. By the time `uploadOutputAudio` is called
 *   the measurement is finished and in hand: every mark is stamped, the
 *   transcripts are final, the cost is computed, the utterances are attributed.
 *   The upload is an ARTIFACT side-effect on a separate endpoint. Ticket 045
 *   already decided that a REJECTED upload does not fail the run — a HUNG upload
 *   is a failed upload with a slower cause, and giving it a different verdict
 *   would mean a flaky store silently deleted good latency samples from the
 *   experiment. So: `status` stays `'complete'`, every timing survives, the Run is
 *   POSTed, `outputAudioPath` stays UNSET (it is a report, never a promise), and
 *   the reason rides `errors` exactly as 045's and 046 R3-7's diagnostics do.
 *
 * - THE COMPLETION DEADLINE IS FATAL. A run that gave up waiting on `finished`
 *   never saw its utterance complete, so it does not know whether it observed the
 *   whole answer: `audio_queued` may be missing or may belong to a partial answer,
 *   and the transcripts may be mid-stream. That is not a measurement, and AGENTS.md
 *   forbids aggregating one. So: `status` is `'failed'` — which is the EXISTING
 *   `isAggregatableRun` clause and NOT a new gate — the named reason rides
 *   `errors`, and the Run is still STORED (a failure is real information, PRD §12).
 *
 * Getting this wrong in either direction is the ticket's main risk: too strict and
 * a flaky artifact store discards valid measurements; too loose and a run that
 * never finished is pooled into p50/p95.
 *
 * ========================== FALSIFIABILITY ================================
 *
 * Every deadline is asserted from BOTH sides — `>= budget` (the run really WAITED,
 * so an implementation that skipped the await entirely fails) and
 * `<= budget + tolerance` (it really GAVE UP). Each hang test has a healthy-path
 * control beside it, so a deadline that fired unconditionally would fail too.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DEFAULT_CASCADE_TRIPLE } from '../../core/arms';
import { SAMPLE_RATE } from '../../core/protocol';
import { writeWav } from '../../harness/wav';
import { isAggregatableRun, type Recording, type Run } from '../state/ledger';
import { FixtureTransport, type FixtureScriptEvent } from '../transport/fixture';
import { FRAME_SAMPLES } from './pacer';
import type { RecordingsClient, RunAudioUpload, RunsClient } from './recordingsClient';
import {
  AUDIO_UPLOAD_TIMEOUT_MS,
  RUN_COMPLETION_TIMED_OUT,
  RUN_COMPLETION_TIMEOUT_MS,
  SEGMENTATION_IDLE_MS,
  TRANSPORT_CLOSE_TIMEOUT_MS,
  runOnce,
  type RunOnceConfig,
  type RunnerDeps,
} from './runner';

/** Slack for the pacer's own 20 ms frame schedule and a microtask or two. */
const TOLERANCE_MS = 60;

const ramp = (n: number): Int16Array =>
  Int16Array.from({ length: n }, (_, i) => ((i * 7919) % 65536) - 32768);

/** MIC-SHAPED: no `utterances`, so neither 031 deadline is ever armed. */
const RECORDING: Recording = {
  id: 'rec-mic-1',
  label: 'mic clip',
  sourceLanguage: 'en',
  durationMs: 100,
  speechEndMs: 60,
  origin: 'mic',
  createdAt: 1_000,
};

const CASCADE_CONFIG: RunOnceConfig = {
  architecture: 'cascade',
  providers: DEFAULT_CASCADE_TRIPLE,
  languagePair: 'EN↔ES',
  direction: 'en→es',
  targetLanguage: 'Spanish',
};

/** Non-zero so `run.cost` is a figure a lost measurement could visibly drop. */
const COST_PER_MIN = 0.12;

const CHUNK = ramp(240);

/** A complete cascade answer: transcripts, a mark, audio, and a completion. */
function completeScript(): FixtureScriptEvent[] {
  return [
    { at: 20, type: 'sourceText', kind: 'final', text: 'hello', utt: 0 },
    { at: 24, type: 'timing', event: 'stt_final', utt: 0, t: 24 },
    { at: 30, type: 'audio', pcm: CHUNK, utt: 0 },
    { at: 34, type: 'targetText', kind: 'final', text: 'hola', utt: 0 },
    { at: 90, type: 'utteranceComplete', record: { utt: 0 } },
  ];
}

/** The same answer with the completion REMOVED: the transport goes quiet. */
function neverCompletesScript(): FixtureScriptEvent[] {
  return completeScript().filter((e) => e.type !== 'utteranceComplete');
}

/** A transport whose teardown never settles — 046 R3-1's wedged AudioContext. */
class WedgedStopTransport extends FixtureTransport {
  override stop(): void | Promise<void> {
    super.stop();
    return new Promise<void>(() => {});
  }
}

interface HarnessOptions {
  script?: FixtureScriptEvent[];
  /** 'hang' never settles; 'hang-then-reject' settles LATE, with a rejection. */
  upload?: 'ok' | 'hang' | 'hang-then-reject';
  /** How long after the call a 'hang-then-reject' upload finally rejects. */
  uploadRejectsAfterMs?: number;
  /** Make `transport.stop()` hang, to prove the two deadlines are not nested. */
  wedgeClose?: boolean;
}

function makeHarness(opts: HarnessOptions = {}) {
  const wav = writeWav(ramp(FRAME_SAMPLES * 5), SAMPLE_RATE);
  const calls: string[] = [];
  const posted: Run[] = [];
  /** Virtual clock at which the upload seam was entered. */
  let uploadStartedAt: number | null = null;
  /** Virtual clock at which `transport.stop()` was entered. */
  let stopStartedAt: number | null = null;

  const recordings: RecordingsClient = {
    list: async () => [RECORDING],
    get: async () => RECORDING,
    getAudio: async () => wav,
    create: async () => RECORDING,
    patchLabel: async () => RECORDING,
    remove: async () => RECORDING,
  };

  const runs: RunsClient = {
    create: async (run: Run) => {
      calls.push('create');
      posted.push(run);
      return run;
    },
    list: async () => posted,
    getAudio: async () => new Uint8Array(0),
    uploadAudio: (id: string, wavBytes: Uint8Array): Promise<RunAudioUpload> => {
      calls.push('uploadAudio');
      uploadStartedAt = Date.now();
      const mode = opts.upload ?? 'ok';
      if (mode === 'ok') {
        return Promise.resolve({ id, outputAudioPath: `runs/${id}.out.wav`, bytes: wavBytes.length });
      }
      // A server that ACCEPTED the connection and never answered. `fetch` has no
      // timeout of its own, so this is exactly what the browser does.
      return new Promise<RunAudioUpload>((_resolve, reject) => {
        if (mode !== 'hang-then-reject') return;
        setTimeout(
          () => reject(new Error('socket closed')),
          opts.uploadRejectsAfterMs ?? AUDIO_UPLOAD_TIMEOUT_MS * 3,
        );
      });
    },
  };

  const deps: RunnerDeps = {
    recordings,
    runs,
    createTransport: () => {
      const transportOpts = {
        armId: 'fx',
        kind: 'cascade' as const,
        script: opts.script ?? completeScript(),
        costPerMinUsd: COST_PER_MIN,
      };
      const transport = opts.wedgeClose
        ? new WedgedStopTransport(transportOpts)
        : new FixtureTransport(transportOpts);
      const stop = transport.stop.bind(transport);
      vi.spyOn(transport, 'stop').mockImplementation(() => {
        stopStartedAt = Date.now();
        return stop();
      });
      return transport;
    },
    now: () => Date.now(),
    newId: () => 'run-1',
  };

  return {
    deps,
    calls,
    posted,
    get uploadStartedAt() {
      return uploadStartedAt;
    },
    get stopStartedAt() {
      return stopStartedAt;
    },
  };
}

type Harness = ReturnType<typeof makeHarness>;

/**
 * Starts the run and records WHEN it settled, without ever awaiting it — a test
 * that awaited a promise the implementation never resolves would hang rather
 * than fail.
 */
function launch(h: Harness) {
  let resolvedAt: number | null = null;
  let rejection: unknown;
  const done = runOnce({ recordingId: RECORDING.id, config: CASCADE_CONFIG, deps: h.deps });
  void done.then(
    () => {
      resolvedAt = Date.now();
    },
    (cause) => {
      resolvedAt = Date.now();
      rejection = cause;
    },
  );
  return {
    done,
    get resolvedAt() {
      return resolvedAt;
    },
    get rejection() {
      return rejection;
    },
  };
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
// AC1 — a hung upload must cost the BYTES, never the MEASUREMENT.
// ---------------------------------------------------------------------------

describe('runOnce — the output-audio upload is BOUNDED (ticket 048, AC1)', () => {
  it('a upload that NEVER responds still completes the run, stores it, and keeps every timing', async () => {
    const h = makeHarness({ upload: 'hang' });
    const started = launch(h);

    await vi.advanceTimersByTimeAsync(AUDIO_UPLOAD_TIMEOUT_MS * 3);

    // THE criterion: the run finished at all.
    expect(started.resolvedAt).not.toBeNull();
    expect(h.uploadStartedAt).not.toBeNull();
    const waited = started.resolvedAt! - h.uploadStartedAt!;
    // It really WAITED the budget — a run that never awaited the upload would
    // show ~0 here and 045's ordering guarantee would be meaningless...
    expect(waited).toBeGreaterThanOrEqual(AUDIO_UPLOAD_TIMEOUT_MS);
    // ...and it really GAVE UP, rather than riding some larger deadline.
    expect(waited).toBeLessThanOrEqual(AUDIO_UPLOAD_TIMEOUT_MS + TOLERANCE_MS);

    const { run } = await started.done;

    // THE MEASUREMENT SURVIVED, in full. Same trade as 046 R4-2's throwing stop().
    expect(run.status).toBe('complete');
    expect(run.timings.audio_queued).toBe(30);
    expect(run.timings.speech_end).toBe(RECORDING.speechEndMs);
    expect(run.timings.stt_final).toBe(24);
    expect(run.transcripts).toEqual({ source: 'hello', target: 'hola' });
    expect(run.cost).toBeCloseTo(COST_PER_MIN * (RECORDING.durationMs / 60_000), 12);

    // It is STORED, upload first and POST second exactly as 045 pinned.
    expect(h.calls).toEqual(['uploadAudio', 'create']);
    expect(h.posted).toHaveLength(1);
    expect(h.posted[0]).toEqual(run);

    // It claims NO path — `outputAudioPath` is a report of bytes on disk, and
    // there are none, so the play control stays absent rather than 404ing.
    expect(run.outputAudioPath).toBeUndefined();

    // The reason rides the EXISTING 045 error line and NAMES the budget, so the
    // operator can tell a hung store from a rejecting one.
    const line = run.errors.find((e) => e.startsWith('output audio upload failed'));
    expect(line).toBeDefined();
    expect(line).toContain(String(AUDIO_UPLOAD_TIMEOUT_MS));
    expect(h.posted[0]!.errors).toEqual(run.errors);

    // ...and it is STILL EVIDENCE: the store lost the artifact, not the numbers.
    expect(isAggregatableRun({ ...run, origin: 'sweep' })).toBe(true);

    // The deadline's handle is cleared on the winning path (046 R3-1's rule): a
    // race that leaves its timer armed is 60 live handles in a sweep.
    expect(vi.getTimerCount()).toBe(0);
  });

  it('CONTROL: a healthy upload costs the run nothing and still reports its path', async () => {
    // The mirror. Without this, an implementation that always waited the full
    // budget — or that skipped the upload entirely — would pass the test above.
    const h = makeHarness({ upload: 'ok' });
    const started = launch(h);
    await vi.advanceTimersByTimeAsync(1_000);
    const { run } = await started.done;

    expect(started.resolvedAt).not.toBeNull();
    expect(started.resolvedAt! - h.uploadStartedAt!).toBeLessThan(AUDIO_UPLOAD_TIMEOUT_MS);
    expect(run.outputAudioPath).toBe(`runs/${run.id}.out.wav`);
    expect(run.errors).toEqual([]);
    expect(run.status).toBe('complete');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('AC5: an abandoned upload that rejects LATE raises no unhandled rejection', async () => {
    // The bounded path abandons the in-flight `fetch` promise. If the runner
    // races it without attaching a handler, the eventual network error becomes an
    // unhandled rejection long after the run was recorded — in a 60-run sweep,
    // 60 of them.
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on('unhandledRejection', onUnhandled);
    try {
      const h = makeHarness({
        upload: 'hang-then-reject',
        uploadRejectsAfterMs: AUDIO_UPLOAD_TIMEOUT_MS * 3,
      });
      const started = launch(h);

      // Past the upload budget, but well short of the abandoned request's own
      // failure at 3x it.
      await vi.advanceTimersByTimeAsync(AUDIO_UPLOAD_TIMEOUT_MS * 2);
      // Guarded, so an unbounded upload fails this test rather than hanging it.
      expect(started.resolvedAt).not.toBeNull();
      const { run } = await started.done;
      expect(run.status).toBe('complete');

      // Now let the abandoned request fail, well after the run was recorded.
      await vi.advanceTimersByTimeAsync(AUDIO_UPLOAD_TIMEOUT_MS * 4);
      await Promise.resolve();
      await Promise.resolve();

      expect(unhandled).toEqual([]);
      // ...and the late failure did not retro-edit the append-only record.
      expect(h.posted).toHaveLength(1);
      expect(h.posted[0]!.outputAudioPath).toBeUndefined();
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });
});

// ---------------------------------------------------------------------------
// AC2 / AC4 — a mic-shaped run cannot wait forever, and what it records is honest.
// ---------------------------------------------------------------------------

describe('runOnce — a MANIFEST-LESS run is BOUNDED on `finished` (ticket 048, AC2)', () => {
  it('a transport that goes quiet without completing its utterance no longer hangs the run', async () => {
    const h = makeHarness({ script: neverCompletesScript() });
    const started = launch(h);

    await vi.advanceTimersByTimeAsync(RUN_COMPLETION_TIMEOUT_MS * 2);

    // THE criterion.
    expect(started.resolvedAt).not.toBeNull();
    expect(started.rejection).toBeUndefined(); // it RESOLVES, as runOnce always does
    // It really waited the budget (measured from run start, so the clip's own
    // 100 ms of pacing is inside the tolerance)...
    expect(started.resolvedAt!).toBeGreaterThanOrEqual(RUN_COMPLETION_TIMEOUT_MS);
    // ...and really gave up on it.
    expect(started.resolvedAt!).toBeLessThanOrEqual(
      RUN_COMPLETION_TIMEOUT_MS + RECORDING.durationMs + TOLERANCE_MS,
    );

    const { run } = await started.done;

    // AC4 — HONEST. A run that never saw its utterance complete does not know it
    // saw the whole answer, so it is not a measurement.
    expect(run.status).toBe('failed');
    const line = run.errors.find((e) => e.startsWith(RUN_COMPLETION_TIMED_OUT));
    expect(line).toBeDefined();
    expect(line).toContain(String(RUN_COMPLETION_TIMEOUT_MS));

    // STORED like any other failure (PRD §12) — a hang that stored nothing was
    // half of what made this defect invisible.
    expect(h.posted).toHaveLength(1);
    expect(h.posted[0]).toEqual(run);

    // No timer outlives the run.
    expect(vi.getTimerCount()).toBe(0);
  });

  it('AC4: it is excluded by the EXISTING gate — `status`, not a new special case', async () => {
    const h = makeHarness({ script: neverCompletesScript() });
    const started = launch(h);
    await vi.advanceTimersByTimeAsync(RUN_COMPLETION_TIMEOUT_MS * 2);
    expect(started.resolvedAt).not.toBeNull();
    const { run } = await started.done;

    const asSweepRun: Run = { ...run, origin: 'sweep' };
    expect(isAggregatableRun(asSweepRun)).toBe(false);
    // ...and `status` is DEMONSTRABLY the clause doing it: the same record with
    // a complete status passes. That is what proves the exclusion runs through
    // `isAggregatableRun`'s existing rule and not through a second gate bolted
    // on beside it (which would leave two definitions to drift).
    expect(isAggregatableRun({ ...asSweepRun, status: 'complete' })).toBe(true);
  });

  it('CONTROL: a mic run whose utterance DOES complete pays none of the budget', async () => {
    // Without this, an implementation that failed every mic run on the deadline
    // would satisfy the two tests above.
    const h = makeHarness({ script: completeScript() });
    const started = launch(h);
    await vi.advanceTimersByTimeAsync(1_000);
    const { run } = await started.done;

    expect(started.resolvedAt!).toBeLessThan(RUN_COMPLETION_TIMEOUT_MS);
    expect(run.status).toBe('complete');
    expect(run.errors).toEqual([]);
    expect(run.timings.audio_queued).toBe(30);
  });
});

// ---------------------------------------------------------------------------
// AC6 — 046's close deadline is PRESERVED, not duplicated or nested.
// ---------------------------------------------------------------------------

describe('runOnce — the close deadline stays its own (ticket 048, AC6)', () => {
  it('a wedged close costs TRANSPORT_CLOSE_TIMEOUT_MS and nothing more (guard)', async () => {
    // 046 R3-1's contract, restated at the mic-shaped seam this ticket touches:
    // the close budget must not silently grow into the new completion budget.
    const h = makeHarness({ wedgeClose: true });
    const started = launch(h);
    await vi.advanceTimersByTimeAsync(RUN_COMPLETION_TIMEOUT_MS * 2);

    expect(started.resolvedAt).not.toBeNull();
    expect(h.stopStartedAt).not.toBeNull();
    const closeWait = started.resolvedAt! - h.stopStartedAt!;
    expect(closeWait).toBeGreaterThanOrEqual(TRANSPORT_CLOSE_TIMEOUT_MS);
    expect(closeWait).toBeLessThanOrEqual(TRANSPORT_CLOSE_TIMEOUT_MS + TOLERANCE_MS);

    const { run } = await started.done;
    expect(run.status).toBe('complete');
    expect(run.outputAudioPath).toBe(`runs/${run.id}.out.wav`);
  });

  it('a run that hangs on BOTH `finished` and the close pays the two budgets IN SERIES', async () => {
    // The "not nested inside a second deadline" clause, made falsifiable: an
    // implementation that wrapped the whole tail in ONE deadline would resolve at
    // ~RUN_COMPLETION_TIMEOUT_MS and skip the close wait entirely, and one that
    // nested the close inside the completion budget would resolve early too.
    const h = makeHarness({ script: neverCompletesScript(), wedgeClose: true });
    const started = launch(h);
    await vi.advanceTimersByTimeAsync(RUN_COMPLETION_TIMEOUT_MS * 3);

    expect(started.resolvedAt).not.toBeNull();
    const total = RUN_COMPLETION_TIMEOUT_MS + TRANSPORT_CLOSE_TIMEOUT_MS;
    expect(started.resolvedAt!).toBeGreaterThanOrEqual(total);
    expect(started.resolvedAt!).toBeLessThanOrEqual(
      total + RECORDING.durationMs + TOLERANCE_MS,
    );

    const { run } = await started.done;
    expect(run.status).toBe('failed');
    expect(run.errors.some((e) => e.startsWith(RUN_COMPLETION_TIMED_OUT))).toBe(true);
  });
});

// ---------------------------------------------------------------------------

describe('the deadlines relate to the ones already in place (ticket 048, guard)', () => {
  it('the completion budget sits between 031s idle deadline and the sweeps per-run patience', () => {
    // Longer than SEGMENTATION_IDLE_MS: a manifest-backed run must keep failing
    // with its own NAMED segmentation reason rather than being pre-empted by this
    // blunter one...
    expect(RUN_COMPLETION_TIMEOUT_MS).toBeGreaterThan(SEGMENTATION_IDLE_MS);
    // ...and far shorter than browserDeps' RUN_TIMEOUT_MS (120 s), so runOnce
    // names the reason before `startBatch`'s blunt abort fires.
    expect(RUN_COMPLETION_TIMEOUT_MS).toBeLessThan(120_000);
    expect(AUDIO_UPLOAD_TIMEOUT_MS).toBeLessThan(120_000);
    // The close budget stays the smallest of the three — it is the only one that
    // costs a leak rather than a measurement or an artifact.
    expect(TRANSPORT_CLOSE_TIMEOUT_MS).toBeLessThan(AUDIO_UPLOAD_TIMEOUT_MS);
  });
});
