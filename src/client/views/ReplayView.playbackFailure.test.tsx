/**
 * Ticket 049 ROUND 2 (R2-5) — a Replay press that produces no sound SAYS SO.
 *
 * Reusing one AudioContext per bag fixed the leak and, on its own, made the
 * failure mode WORSE: before it, `playTake` threw out of the click handler and
 * at least reached the console; after it, a press whose context cannot be built
 * is a silent no-op. On this screen that is not merely unhelpful, it is
 * ambiguous — "I pressed play and heard nothing" is exactly how the operator
 * diagnoses a run whose stored output audio is empty (Arm A before ticket 046,
 * a failed upload, a genuinely silent run). Two very different findings must not
 * look identical.
 *
 * THE SURFACE — deliberately NOT Live's `[data-playback-notice]`:
 *   `deps.playRun(runId, onUnavailable?)` reports the browser's own error, and
 *   the view renders `[data-replay-playback-notice]` next to the runs it
 *   belongs to. It is a readout, not a control, and it carries the reason so
 *   "no audio stored" and "this browser refused an audio context" read
 *   differently.
 *
 * ROUND 3 — EVERY press arm, not just the runs list. R2-5 was delivered for one
 * of the three places Replay sounds audio: `playTake` was handed to RecordTake
 * RAW (`playTake={deps.playTake}`) and narrowed straight back to one argument
 * there, so the report parameter had ZERO production callers; and the
 * BlindCompare arm could be reverted to a bare `deps.playRun(runId)` with the
 * suite green. Blind compare is where silence costs most — judging the audio IS
 * the task — and a freshly recorded take has no "no audio stored" explanation
 * available at all.
 */
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { DEFAULT_CASCADE_TRIPLE } from '../../core/arms';
import type { CaptureDenied, RecordedTake, TakeRecorder } from '../replay/capture';
import type { SegmentedUtterance } from '../replay/segment';
import type { RecordingsClient, RunsClient } from '../replay/recordingsClient';
import type { BlindComparison, Recording, Run } from '../state/ledger';
import ReplayView, { type ReplayDeps, type ReplayTakeOptions } from './ReplayView';

afterEach(cleanup);

const T0 = Date.UTC(2026, 1, 3, 9, 41, 0);

const REC: Recording = {
  id: 'rec-1',
  label: 'clinic intake · corpus',
  sourceLanguage: 'en',
  durationMs: 60_000,
  speechEndMs: 59_000,
  origin: 'corpus',
  createdAt: T0,
};

/** A run with STORED AUDIO — the only kind that offers [data-run-play]. */
const RUN: Run = {
  id: 'run-1',
  recordingId: REC.id,
  architecture: 'cascade',
  providerTriple: { ...DEFAULT_CASCADE_TRIPLE },
  modelSnapshots: { ...DEFAULT_CASCADE_TRIPLE },
  armTag: 'B',
  origin: 'manual',
  status: 'complete',
  timings: { speech_end: T0, audio_queued: T0 + 1_053 },
  transcripts: { source: 'hello', target: 'hola' },
  outputAudioPath: 'runs/run-1.out.wav',
  cost: 0.021,
  errors: [],
  createdAt: T0 + 1_000,
};

/** The sentence the operator reads. The reason is appended, never replaced. */
const REPLAY_NOTICE_COPY = 'No audio output — this browser refused a new audio context.';

const q = (selector: string): HTMLElement | null => document.querySelector(selector);
const text = (el: Element | null): string => (el?.textContent ?? '').replace(/\s+/g, ' ').trim();

const replayNotice = (): HTMLElement | null => q('[data-replay-playback-notice]');

function contextLimitError(): Error {
  const err = new Error('the number of hardware contexts reached the maximum');
  err.name = 'NotSupportedError';
  return err;
}

/** A bag whose `playRun` fails (or does not) exactly as production would. */
function makeDeps(failure: Error | null, extraRuns: Run[] = []) {
  const playRun = vi.fn((_runId: string, onUnavailable?: (error: unknown) => void) => {
    if (failure) onUnavailable?.(failure);
  });
  const recordings = {
    list: vi.fn(async () => [{ ...REC }]),
    get: vi.fn(async () => ({ ...REC })),
    getAudio: vi.fn(async () => new Uint8Array()),
    create: vi.fn(async () => ({ ...REC })),
    patchLabel: vi.fn(async () => ({ ...REC })),
    remove: vi.fn(async () => ({ ...REC })),
  } as unknown as RecordingsClient;
  const runs = {
    create: vi.fn(async (run: Run) => run),
    list: vi.fn(async () => [{ ...RUN }, ...extraRuns.map((r) => ({ ...r }))]),
    getAudio: vi.fn(async () => new Uint8Array()),
  } as unknown as RunsClient;

  const deps: ReplayDeps = {
    recordings,
    runs,
    runOnce: vi.fn() as unknown as ReplayDeps['runOnce'],
    startBatch: vi.fn() as unknown as ReplayDeps['startBatch'],
    playRun,
    now: () => T0,
    newId: () => 'id-1',
  };
  return { deps, playRun };
}

async function mountAndSelect(failure: Error | null) {
  const fakes = makeDeps(failure);
  render(<ReplayView deps={fakes.deps} />);
  const row = `[data-recording-row][data-recording="${REC.id}"]`;
  await waitFor(() => expect(q(row)).not.toBeNull());
  fireEvent.click(q(row)!);
  await waitFor(() => expect(q('[data-run-play]')).not.toBeNull());
  return fakes;
}

describe('Replay tells the operator when a press produced no sound (ticket 049 R2-5)', () => {
  it('a failed press renders [data-replay-playback-notice] naming the browser’s reason', async () => {
    const fakes = await mountAndSelect(contextLimitError());

    expect(replayNotice(), 'nothing is claimed before a press').toBeNull();
    fireEvent.click(q('[data-run-play]')!);

    await waitFor(() => expect(replayNotice()).not.toBeNull());
    const el = replayNotice()!;
    expect(text(el)).toContain(REPLAY_NOTICE_COPY);
    // The reason, verbatim from the browser — this is what distinguishes it
    // from "no output audio stored", the other way a press yields silence.
    expect(text(el)).toContain('the number of hardware contexts reached the maximum');
    // A readout, not a control: nothing in Replay autoplays and nothing here
    // offers a retry that could not work anyway.
    expect(el.querySelector('button, [role="button"]')).toBeNull();
    // The press really was attempted, and the run list is untouched.
    expect(fakes.playRun).toHaveBeenCalledTimes(1);
    expect(fakes.playRun.mock.calls[0]![0]).toBe(RUN.id);
    expect(document.querySelectorAll('[data-run-card]')).toHaveLength(1);
  });

  it('REGRESSION GUARD: a press that sounds renders no notice at all', async () => {
    await mountAndSelect(null);

    fireEvent.click(q('[data-run-play]')!);
    await waitFor(() => expect(q('[data-run-play]')).not.toBeNull());

    expect(replayNotice()).toBeNull();
  });
});

/* ===========================================================================
 * ROUND 3 — the other two press arms
 * ======================================================================== */

/** A second complete run, so blind compare has a pair to draw from. */
const RUN_B: Run = {
  ...RUN,
  id: 'run-2',
  armTag: 'C',
  outputAudioPath: 'runs/run-2.out.wav',
  createdAt: T0 + 2_000,
};

const TAKE: RecordedTake = {
  samples: new Int16Array(24 * 4_000),
  wav: new Uint8Array(8),
  durationMs: 4_000,
};

const SEGMENTS: SegmentedUtterance[] = [{ index: 1, startMs: 200, trueSpeechEndMs: 3_000 }];

/**
 * R3-1 — the RECORD flow, driven the way an operator drives it: open, record,
 * stop, press "Play take". Calling `deps.playTake(take, cb)` directly is what
 * let this slip — the seam accepted the callback while the only production
 * caller, RecordTake, had already narrowed the type back to one argument.
 */
function makeRecordDeps(failure: Error | null) {
  const playTake = vi.fn((_take: RecordedTake, onUnavailable?: (error: unknown) => void) => {
    if (failure) onUnavailable?.(failure);
  });
  const base = makeDeps(null);
  const startTake = vi.fn(
    async (_options: ReplayTakeOptions): Promise<TakeRecorder | CaptureDenied> =>
      ({ stop: vi.fn(async () => TAKE), cancel: vi.fn() }) as unknown as TakeRecorder,
  );
  const deps: ReplayDeps = {
    ...base.deps,
    startTake: startTake as unknown as ReplayDeps['startTake'],
    segmentTake: vi.fn(() => SEGMENTS.map((s) => ({ ...s }))) as unknown as ReplayDeps['segmentTake'],
    playTake,
    corpusVersion: 'v3',
  };
  return { deps, playTake, startTake };
}

describe('R3-1: the RECORD flow reports a press that produced no sound', () => {
  async function recordAndStop(failure: Error | null) {
    const fakes = makeRecordDeps(failure);
    render(<ReplayView deps={fakes.deps} />);
    await waitFor(() => expect(q('[data-recordings-library]')).not.toBeNull());

    fireEvent.click(screen.getByRole('button', { name: /Record new clip/ }));
    await waitFor(() => expect(q('[data-record-take]')).not.toBeNull());
    fireEvent.click(screen.getByRole('button', { name: 'Start recording' }));
    await waitFor(() => expect(fakes.startTake).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole('button', { name: 'Stop recording' }));
    await waitFor(() => expect(q('[data-record-play]')).not.toBeNull());
    return fakes;
  }

  it('“Play take” with an unbuildable context surfaces the notice and the reason', async () => {
    const fakes = await recordAndStop(contextLimitError());

    expect(replayNotice()).toBeNull();
    fireEvent.click(q('[data-record-play]')!);

    await waitFor(() => expect(replayNotice()).not.toBeNull());
    expect(text(replayNotice()!)).toContain(REPLAY_NOTICE_COPY);
    expect(text(replayNotice()!)).toContain('the number of hardware contexts reached the maximum');
    // The seam really was handed a reporter — the raw `playTake={deps.playTake}`
    // forward could not have provided one.
    expect(fakes.playTake).toHaveBeenCalledTimes(1);
    expect(typeof fakes.playTake.mock.calls[0]![1]).toBe('function');
    // The take is still there to save: a silent sound path is not a lost take.
    expect(q('[data-record-take]')).not.toBeNull();
  });

  it('REGRESSION GUARD: a take that sounds surfaces nothing', async () => {
    await recordAndStop(null);
    fireEvent.click(q('[data-record-play]')!);
    await waitFor(() => expect(q('[data-record-play]')).not.toBeNull());
    expect(replayNotice()).toBeNull();
  });
});

/**
 * R3-3 — the BLIND COMPARE arm. Reverting it to `deps.playRun(runId)` left the
 * whole suite green, and this is the screen where hearing nothing costs most:
 * judging the audio IS the task, and an unexplained silence is scored as a
 * property of the run.
 */
describe('R3-3 GUARD: blind compare reports a press that produced no sound', () => {
  async function openBlind(failure: Error | null) {
    const base = makeDeps(failure, [RUN_B]);
    const submitted: BlindComparison[] = [];
    const deps: ReplayDeps = {
      ...base.deps,
      rng: () => 0.42,
      evaluatorLanguage: 'Spanish',
      recordBlindComparison: (comparison) => submitted.push(comparison),
    };
    render(<ReplayView deps={deps} />);
    const row = `[data-recording-row][data-recording="${REC.id}"]`;
    await waitFor(() => expect(q(row)).not.toBeNull());
    fireEvent.click(q(row)!);
    await waitFor(() => expect(q('[data-blind-toggle]')).not.toBeNull());
    fireEvent.click(q('[data-blind-toggle]')!);
    await waitFor(() => expect(q('[data-blind-sample="A"]')).not.toBeNull());
    return { ...base, deps };
  }

  // Green at HEAD — the funnel is already wired here — so this is a GUARD, and
  // it is mutation-proven: reverting the arm to `deps.playRun(runId)` turns it
  // red (mutation R2p), which is exactly the revert nothing else noticed.
  it('a blind sample press that cannot build a context says so', async () => {
    const fakes = await openBlind(contextLimitError());

    expect(replayNotice()).toBeNull();
    fireEvent.click(within(q('[data-blind-sample="A"]')!).getByRole('button', { name: 'play' }));

    await waitFor(() => expect(replayNotice()).not.toBeNull());
    expect(text(replayNotice()!)).toContain('the number of hardware contexts reached the maximum');
    expect(fakes.playRun).toHaveBeenCalledTimes(1);
    // The blinding is untouched: the notice names the browser, never the run.
    expect(text(replayNotice()!)).not.toContain(RUN.id);
    expect(text(replayNotice()!)).not.toContain(RUN_B.id);
    expect(q('[data-blind-identity]')).toBeNull();
  });

  it('REGRESSION GUARD: a blind sample that sounds surfaces nothing', async () => {
    await openBlind(null);
    fireEvent.click(within(q('[data-blind-sample="A"]')!).getByRole('button', { name: 'play' }));
    await waitFor(() => expect(q('[data-blind-sample="A"]')).not.toBeNull());
    expect(replayNotice()).toBeNull();
  });
});

/**
 * R4-1 — the notice CLEARS on the next press that works.
 *
 * Both funnels open with `setPlaybackError(null)`, and removing that line from
 * EITHER left 1859/1859 green. The consequence is the Replay analogue of the
 * two MAJORs graded on the Live side (R2-1/R2-2): press 1 fails, the cap frees,
 * press 2 succeeds — and the screen still reads "No audio output — …" while the
 * audio is audibly playing. Recovery is MORE reachable here than in Live:
 * `replayPlaybackContextFactory` uses `??=`, so every press retries
 * `new AudioContext()`, and each press builds a fresh `ArmPlayback` with a
 * fresh latch. The first successful press after a Live capture context closes
 * walks exactly this path, so a QA pass will hit it.
 *
 * ONE test, BOTH funnels: a stale notice is the same falsehood whichever press
 * cleared the failure.
 */
describe('GUARD: a successful press clears a previous failure (round 4, R4-1)', () => {
  /** Fails the FIRST press of each seam and succeeds from the second on. */
  function makeRecoveringDeps() {
    let runPresses = 0;
    let takePresses = 0;
    const base = makeDeps(null);
    const playRun = vi.fn((_runId: string, onUnavailable?: (error: unknown) => void) => {
      runPresses += 1;
      if (runPresses === 1) onUnavailable?.(contextLimitError());
    });
    const playTake = vi.fn((_take: RecordedTake, onUnavailable?: (error: unknown) => void) => {
      takePresses += 1;
      if (takePresses === 1) onUnavailable?.(contextLimitError());
    });
    const startTake = vi.fn(
      async (_options: ReplayTakeOptions): Promise<TakeRecorder | CaptureDenied> =>
        ({ stop: vi.fn(async () => TAKE), cancel: vi.fn() }) as unknown as TakeRecorder,
    );
    const deps: ReplayDeps = {
      ...base.deps,
      playRun,
      startTake: startTake as unknown as ReplayDeps['startTake'],
      segmentTake: vi.fn(() =>
        SEGMENTS.map((seg) => ({ ...seg })),
      ) as unknown as ReplayDeps['segmentTake'],
      playTake,
      corpusVersion: 'v3',
    };
    return { deps, playRun, playTake, startTake };
  }

  it('BOTH funnels: the second, working press takes the notice down', async () => {
    const fakes = makeRecoveringDeps();
    render(<ReplayView deps={fakes.deps} />);
    const row = `[data-recording-row][data-recording="${REC.id}"]`;
    await waitFor(() => expect(q(row)).not.toBeNull());
    fireEvent.click(q(row)!);
    await waitFor(() => expect(q('[data-run-play]')).not.toBeNull());

    /* ---- the RUN funnel ---- */
    fireEvent.click(q('[data-run-play]')!);
    await waitFor(() => expect(replayNotice()).not.toBeNull());
    expect(text(replayNotice()!)).toContain('the number of hardware contexts reached the maximum');

    // The cap freed; this press really does sound.
    fireEvent.click(q('[data-run-play]')!);
    await waitFor(() => expect(fakes.playRun).toHaveBeenCalledTimes(2));
    expect(
      replayNotice(),
      'the run is audibly playing while the screen says there is no audio output',
    ).toBeNull();

    /* ---- the TAKE funnel, on the same screen ---- */
    fireEvent.click(screen.getByRole('button', { name: /Record new clip/ }));
    await waitFor(() => expect(q('[data-record-take]')).not.toBeNull());
    fireEvent.click(screen.getByRole('button', { name: 'Start recording' }));
    await waitFor(() => expect(fakes.startTake).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole('button', { name: 'Stop recording' }));
    await waitFor(() => expect(q('[data-record-play]')).not.toBeNull());

    fireEvent.click(q('[data-record-play]')!);
    await waitFor(() => expect(replayNotice()).not.toBeNull());

    fireEvent.click(q('[data-record-play]')!);
    await waitFor(() => expect(fakes.playTake).toHaveBeenCalledTimes(2));
    expect(
      replayNotice(),
      'the take is audibly playing while the screen says there is no audio output',
    ).toBeNull();
  });
});
