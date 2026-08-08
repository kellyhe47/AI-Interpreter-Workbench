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
 */
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { DEFAULT_CASCADE_TRIPLE } from '../../core/arms';
import type { RecordingsClient, RunsClient } from '../replay/recordingsClient';
import type { Recording, Run } from '../state/ledger';
import ReplayView, { type ReplayDeps } from './ReplayView';

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
function makeDeps(failure: Error | null) {
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
    list: vi.fn(async () => [{ ...RUN }]),
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
