/**
 * Ticket 044 — a Run in flight is VISIBLE, and cannot be fired twice.
 *
 * This file EXTENDS the ticket-013 spec in ReplayView.test.tsx and the
 * ticket-020/024 spec in ReplayView.failures.test.tsx; it restates neither.
 *
 * The defect: between the click and the run card there is a ~20 s window (the
 * clip paces at 1×, plus provider latency) in which the UI is byte-identical to
 * not having clicked. The natural response is to click again — which starts a
 * SECOND run and spends provider budget a second time. A Replay run is a real,
 * billable action, so the double-fire guard is the load-bearing half of this
 * ticket and the visible indication is the half that stops the operator wanting
 * to double-fire in the first place.
 *
 * Ticket 024's principle is not overturned here, it is APPLIED: a control that
 * cannot act does not look actionable. While a run is in flight the Run button
 * genuinely cannot act, so it carries the real `disabled` attribute plus a
 * title naming the reason — the same shape the no-selection gate already uses,
 * and the reason the ticket-024 pin that asserted the opposite is rewritten in
 * ReplayView.failures.test.tsx alongside this file.
 *
 * ======================= DOM CONTRACT THIS FILE ADDS =======================
 * RunConfigPanel, a manual Run in flight:
 *   [data-run-inflight] — present ONLY while a manual run is in flight, inside
 *     [data-run-config-panel], carrying RUN_INFLIGHT_NOTE verbatim. The copy is
 *     honest about the pacing: a Replay run plays the clip at 1×, so "running"
 *     means "playing in real time", which is what sets a ≤45 s expectation
 *     instead of reading as a hang.
 *   button 'Run' carries [data-run-button] and, while in flight, `disabled`
 *     plus a non-empty `title` naming the in-flight run (RUN_BUSY_HINT).
 *   It clears on EVERY exit: a run that completes, a run that RESOLVES as
 *     `status: 'failed'` (runner.ts resolves rather than throws when a stage is
 *     lost), and a runOnce that REJECTS outright. Three different paths, one
 *     rule — a failed run must not leave the panel looking permanently busy.
 *
 * RunConfigPanel, a sweep in flight:
 *   button 'Batch sweep…' carries [data-batch-button] and, while a sweep is in
 *     flight, `disabled` plus BATCH_BUSY_HINT. The INDICATION stays
 *     [data-batch-progress], which already renders; [data-run-inflight] is
 *     ABSENT during a sweep, because a sweep is not a manual run and two
 *     panels claiming different things is the contradiction this forbids.
 *
 * Unchanged: selection gating (ticket 024) and every run semantic. The Run
 * produced, its `origin` and every figure are identical.
 * ==========================================================================
 */

// Imported directly (in addition to vitest.setup.ts) so the jest-dom matcher
// type augmentation is visible to `tsc -p tsconfig.json`, whose include does
// not cover the setup file.
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_CASCADE_TRIPLE, REALTIME_MODEL, deriveArmTag } from '../../core/arms';
import type { BatchHandle, BatchSummary } from '../batch/runner';
import type { RecordingsClient, RunsClient } from '../replay/recordingsClient';
import type { RunOnceResult } from '../replay/runner';
import type { Recording, Run } from '../state/ledger';
import ReplayView, {
  type ReplayBatchRequest,
  type ReplayDeps,
  type ReplayRunRequest,
} from './ReplayView';

afterEach(cleanup);

/* ================================================================== copy == */

const RUN = 'Run';
const BATCH_SWEEP = 'Batch sweep…';

/**
 * The visible indication, verbatim. It names the PACING because that is the
 * honest explanation of the wait: nothing is stuck, the clip is being played.
 */
const RUN_INFLIGHT_NOTE =
  'Running — the clip is playing at 1×, so this takes about as long as the Recording.';

/** Why Run cannot act right now. A run in flight, not a missing selection. */
const RUN_BUSY_HINT = 'A run is already in flight — the clip is playing at 1×';

/** Why Batch sweep cannot act right now. */
const BATCH_BUSY_HINT = 'A batch sweep is already in flight';

/* ============================================================== fixtures == */

/** 2026-02-03T09:41:00Z. */
const T0 = Date.UTC(2026, 1, 3, 9, 41, 0);

const CORPUS_REC: Recording = {
  id: 'rec-corpus',
  label: 'clinic intake · corpus',
  sourceLanguage: 'en',
  durationMs: 60_000,
  speechEndMs: 59_000,
  origin: 'corpus',
  createdAt: T0,
};

const MIC_REC: Recording = {
  id: 'rec-mic',
  label: 'pharmacy dosage test',
  sourceLanguage: 'es',
  durationMs: 30_000,
  speechEndMs: 29_500,
  origin: 'mic',
  createdAt: T0 + 1,
};

/* =============================================================== helpers == */

const q = (selector: string): HTMLElement | null => document.querySelector<HTMLElement>(selector);

function get(selector: string): HTMLElement {
  const found = q(selector);
  if (!found) throw new Error(`missing element: ${selector}`);
  return found;
}

const text = (element: Element | null): string => (element?.textContent ?? '').trim();

const rows = (): HTMLElement[] =>
  Array.from(document.querySelectorAll<HTMLElement>('[data-recording-row]'));

const runCards = (): HTMLElement[] =>
  Array.from(document.querySelectorAll<HTMLElement>('[data-run-card]'));

const actionButton = (name: string): HTMLElement => screen.getByRole('button', { name });

const inflightNote = (): HTMLElement | null => q('[data-run-inflight]');

const titleOf = (element: HTMLElement): string => element.getAttribute('title') ?? '';

/** Lets microtask chains (the run promise's .then/.catch) drain. */
const flush = async (): Promise<void> => {
  await waitFor(() => expect(true).toBe(true));
};

/** One manual run the test settles by hand, whichever way it likes. */
interface PendingRun {
  request: ReplayRunRequest;
  complete: () => void;
  failStage: () => void;
  reject: (cause: unknown) => void;
}

function makeFakes(options: { recordings?: Recording[]; runs?: Run[] } = {}) {
  const store = {
    recordings: (options.recordings ?? []).map((r) => ({ ...r })),
    runs: (options.runs ?? []).map((r) => ({ ...r })),
  };

  const recordings = {
    list: vi.fn(async () =>
      store.recordings.filter((r) => r.deletedAt === undefined).map((r) => ({ ...r })),
    ),
    get: vi.fn(async (id: string) => ({ ...store.recordings.find((r) => r.id === id)! })),
    getAudio: vi.fn(async () => new Uint8Array()),
    create: vi.fn(async () => ({ ...CORPUS_REC })),
    patchLabel: vi.fn(async (id: string, label: string) => {
      const found = store.recordings.find((r) => r.id === id)!;
      found.label = label;
      return { ...found };
    }),
    remove: vi.fn(async (id: string) => {
      const found = store.recordings.find((r) => r.id === id)!;
      found.deletedAt = T0 + 999;
      return { ...found };
    }),
  };

  const runs = {
    create: vi.fn(async (run: Run) => run),
    list: vi.fn(async (recordingId?: string) =>
      store.runs
        .filter((r) => recordingId === undefined || r.recordingId === recordingId)
        .map((r) => ({ ...r })),
    ),
    getAudio: vi.fn(async () => new Uint8Array()),
  };

  /** Every manual run the view asked for, still unsettled until a test says so. */
  const pending: PendingRun[] = [];

  const runOnce = vi.fn(
    (request: ReplayRunRequest): Promise<RunOnceResult> =>
      new Promise<RunOnceResult>((resolveRun, rejectRun) => {
        const made = (status: Run['status'], errors: string[]): Run => {
          const run: Run = {
            id: `run-new-${store.runs.length + 1}`,
            recordingId: request.recordingId,
            architecture: request.config.architecture,
            providerTriple: request.config.providers,
            modelSnapshots:
              request.config.architecture === 'realtime'
                ? { realtime: request.config.realtimeModel ?? REALTIME_MODEL }
                : { ...(request.config.providers ?? DEFAULT_CASCADE_TRIPLE) },
            armTag: deriveArmTag(request.config),
            origin: 'manual',
            status,
            timings:
              status === 'complete'
                ? { speech_end: T0, audio_queued: T0 + 1_053 }
                : { speech_end: T0, audio_queued: null },
            transcripts: status === 'complete' ? { source: 'hello', target: 'hola' } : { source: 'hello' },
            outputAudioPath: status === 'complete' ? 'runs/run-new.out.wav' : undefined,
            cost: status === 'complete' ? 0.021 : 0,
            errors,
            createdAt: T0 + 60_000,
          };
          store.runs.push(run);
          return run;
        };

        const settle = (run: Run): void =>
          resolveRun({
            run,
            outputAudio: new Int16Array(0),
            audioReady: run.status === 'complete',
            t0: T0,
            speechEndMs: 0,
            cancelled: false,
          });

        pending.push({
          request,
          complete: () => settle(made('complete', [])),
          // runner.ts RESOLVES a lost stage as `status: 'failed'`; it does not
          // throw. A resolved failure and a rejection are different paths.
          failStage: () => settle(made('failed', ['tts: stage timed out for this utterance'])),
          reject: (cause: unknown) => rejectRun(cause),
        });
      }),
  );

  const batches: Array<{
    request: ReplayBatchRequest;
    cancel: ReturnType<typeof vi.fn>;
    settle: () => void;
  }> = [];

  const startBatch = vi.fn((request: ReplayBatchRequest): BatchHandle => {
    const cancel = vi.fn();
    let settleDone: (summary: BatchSummary) => void = () => {};
    const done = new Promise<BatchSummary>((resolveDone) => {
      settleDone = resolveDone;
    });
    batches.push({
      request,
      cancel,
      settle: () =>
        settleDone({
          status: 'cancelled',
          totalRuns: 45,
          attemptedRuns: 2,
          completedRuns: 2,
          warmupDiscardApplied: true,
          counterbalancingApplied: true,
          discarded: [],
          failures: [],
          configurations: [],
          runs: [],
          elapsedMs: 1_000,
        }),
    });
    return { done, cancel };
  });

  const deps: ReplayDeps = {
    recordings: recordings as unknown as RecordingsClient,
    runs: runs as unknown as RunsClient,
    runOnce: runOnce as unknown as ReplayDeps['runOnce'],
    startBatch: startBatch as unknown as ReplayDeps['startBatch'],
    playRun: vi.fn(),
    now: () => T0,
    newId: () => 'id-1',
  };

  return { deps, store, recordings, runs, runOnce, startBatch, pending, batches };
}

async function mount(options: { recordings?: Recording[]; runs?: Run[] } = {}) {
  const fakes = makeFakes(options);
  render(<ReplayView deps={fakes.deps} />);
  await waitFor(() => expect(q('[data-recordings-library]')).not.toBeNull());
  const expected = options.recordings ?? [];
  if (expected.length > 0) await waitFor(() => expect(rows()).toHaveLength(expected.length));
  return fakes;
}

async function selectRecording(recordingId: string): Promise<void> {
  const selector = `[data-recording-row][data-recording="${recordingId}"]`;
  fireEvent.click(get(selector));
  await waitFor(() => expect(get(selector)).toHaveAttribute('data-selected', 'true'));
}

/** Selects, clicks Run once, and waits until the request is genuinely out. */
async function startRun(recordingId: string = CORPUS_REC.id) {
  const fakes = await mount({ recordings: [CORPUS_REC, MIC_REC] });
  await selectRecording(recordingId);
  fireEvent.click(actionButton(RUN));
  await waitFor(() => expect(fakes.runOnce).toHaveBeenCalledTimes(1));
  await waitFor(() => expect(inflightNote()).not.toBeNull());
  return fakes;
}

/* ================================================ the run is VISIBLY out == */

describe('ticket 044 — a manual Run in flight says so', () => {
  it('nothing claims a run is in flight before the button is pressed', async () => {
    await mount({ recordings: [CORPUS_REC, MIC_REC] });
    expect(inflightNote()).toBeNull();
    await selectRecording(CORPUS_REC.id);
    expect(inflightNote()).toBeNull();
  });

  it('renders the in-flight note verbatim, inside the run config panel', async () => {
    await startRun();

    const note = get('[data-run-inflight]');
    expect(text(note)).toBe(RUN_INFLIGHT_NOTE);
    // Where the operator is looking: beside the button they just pressed.
    expect(get('[data-run-config-panel]').contains(note)).toBe(true);
    // The state is VISIBLE, not merely encoded — the pacing is in the words.
    expect(text(note)).toContain('1×');
  });

  it('the note is not a control — it is a readout of what is happening', async () => {
    await startRun();
    const note = get('[data-run-inflight]');
    expect(['BUTTON', 'INPUT', 'SELECT', 'TEXTAREA']).not.toContain(note.tagName);
    expect(note.querySelectorAll('button, input, select, textarea')).toHaveLength(0);
  });
});

/* ===================================== the double-fire guard — the money == */

describe('ticket 044 — Run cannot be double-fired', () => {
  it('a second click while a run is in flight starts NO second run', async () => {
    const fakes = await startRun();

    fireEvent.click(actionButton(RUN));
    fireEvent.click(actionButton(RUN));
    await flush();

    // The one that costs money: one click, one billable run.
    expect(fakes.runOnce).toHaveBeenCalledTimes(1);
    expect(fakes.pending).toHaveLength(1);
    expect(fakes.startBatch).not.toHaveBeenCalled();
  });

  it('Run is disabled while in flight and its title names the run, not a selection', async () => {
    await startRun();

    const button = actionButton(RUN);
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute('data-run-button');
    expect(titleOf(button)).toBe(RUN_BUSY_HINT);
    // A Recording IS selected — the busy reason must not masquerade as the
    // ticket-024 gate, or the operator learns the wrong lesson.
    expect(titleOf(button)).not.toMatch(/select a recording|no recording/i);
  });

  it('run semantics are untouched — the request and the produced Run are unchanged', async () => {
    const fakes = await startRun(MIC_REC.id);

    const request = fakes.pending[0]!.request;
    expect(request.recordingId).toBe(MIC_REC.id);
    expect(request.config.architecture).toBe('cascade');
    expect(request.config.providers).toEqual(DEFAULT_CASCADE_TRIPLE);

    fakes.pending[0]!.complete();

    await waitFor(() => expect(runCards()).toHaveLength(1));
    const created = fakes.store.runs[0]!;
    expect(created.origin).toBe('manual');
    expect(created.armTag).toBe('B');
    expect(created.cost).toBe(0.021);
  });
});

/* ============================================ every exit clears it ======= */

describe('ticket 044 — the indication clears on completion AND on failure', () => {
  const EXITS = [
    {
      name: 'a run that completes',
      settle: (pending: PendingRun) => pending.complete(),
      cards: 1,
    },
    {
      name: 'a run that RESOLVES as failed — a lost stage, not a throw',
      settle: (pending: PendingRun) => pending.failStage(),
      cards: 1,
    },
    {
      name: 'a runOnce that REJECTS outright',
      settle: (pending: PendingRun) => pending.reject(new Error('provider unreachable')),
      cards: 0,
    },
  ] as const;

  it.each(EXITS)('$name clears the note and re-enables Run', async ({ settle, cards }) => {
    const fakes = await startRun();

    settle(fakes.pending[0]!);

    await waitFor(() => expect(inflightNote()).toBeNull());
    await waitFor(() => expect(actionButton(RUN)).toBeEnabled());
    // Re-enabled means re-usable: no leftover busy explanation either.
    expect(titleOf(actionButton(RUN))).not.toBe(RUN_BUSY_HINT);
    await waitFor(() => expect(runCards()).toHaveLength(cards));
  });

  it('a rejected run leaves the panel usable — a second Run is accepted afterwards', async () => {
    const fakes = await startRun();

    fakes.pending[0]!.reject(new Error('provider unreachable'));
    await waitFor(() => expect(actionButton(RUN)).toBeEnabled());

    fireEvent.click(actionButton(RUN));

    await waitFor(() => expect(fakes.runOnce).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(inflightNote()).not.toBeNull());
  });

  it('a rejected run is HANDLED — the view catches it rather than leaking it', async () => {
    const leaked: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      leaked.push(reason);
    };
    process.on('unhandledRejection', onUnhandled);
    try {
      const fakes = await startRun();
      fakes.pending[0]!.reject(new Error('provider unreachable'));
      await waitFor(() => expect(inflightNote()).toBeNull());
      await flush();
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
    expect(leaked).toEqual([]);
  });
});

/* ==================================================== the batch sweep ===== */

describe('ticket 044 — Batch sweep is not double-fireable, and does not contradict BatchProgress', () => {
  /**
   * TICKET 065 — the press now opens a confirmation and reaches no executor, so
   * getting a sweep IN FLIGHT takes one more step. Nothing below changed: the
   * disabled-while-sweeping and not-double-fireable contracts are asserted
   * exactly as before, against a sweep that is genuinely running.
   */
  async function startSweep() {
    const fakes = await mount({ recordings: [CORPUS_REC, MIC_REC] });
    await selectRecording(CORPUS_REC.id);
    fireEvent.click(actionButton(BATCH_SWEEP));
    await waitFor(() => expect(q('[data-sweep-confirm]')).not.toBeNull());
    fireEvent.click(get('[data-sweep-confirm-start]'));
    await waitFor(() => expect(fakes.batches).toHaveLength(1));
    await waitFor(() => expect(q('[data-batch-progress]')).not.toBeNull());
    return fakes;
  }

  it('a second click while a sweep is in flight starts NO second sweep', async () => {
    const fakes = await startSweep();

    fireEvent.click(actionButton(BATCH_SWEEP));
    fireEvent.click(actionButton(BATCH_SWEEP));
    await flush();

    expect(fakes.startBatch).toHaveBeenCalledTimes(1);
    expect(fakes.batches).toHaveLength(1);
    expect(document.querySelectorAll('[data-batch-progress]')).toHaveLength(1);
  });

  it('Batch sweep is disabled while sweeping and its title names the sweep', async () => {
    await startSweep();

    const button = actionButton(BATCH_SWEEP);
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute('data-batch-button');
    expect(titleOf(button)).toBe(BATCH_BUSY_HINT);
    expect(titleOf(button)).not.toMatch(/select a recording|no recording/i);
  });

  it('BatchProgress is the sweep’s indication — no second panel claims a manual run', async () => {
    await startSweep();

    // A sweep is not a manual run. Two panels saying different things about
    // what is executing is exactly the contradiction this rules out.
    expect(inflightNote()).toBeNull();
    expect(text(get('[data-batch-progress]'))).toContain('Batch sweep running');
  });

  it('when the sweep settles the panel goes and Batch sweep is offered again', async () => {
    const fakes = await startSweep();

    fakes.batches[0]!.settle();

    await waitFor(() => expect(q('[data-batch-progress]')).toBeNull());
    await waitFor(() => expect(actionButton(BATCH_SWEEP)).toBeEnabled());
    expect(titleOf(actionButton(BATCH_SWEEP))).not.toBe(BATCH_BUSY_HINT);
  });
});

/* ============================== ticket 024 still holds underneath ========= */

describe('ticket 044 — selection gating (ticket 024) survives the in-flight state', () => {
  const ACTIONS = [
    { name: 'Run', label: RUN },
    { name: 'Batch sweep…', label: BATCH_SWEEP },
  ] as const;

  it.each(ACTIONS)('$name stays disabled with its explanatory title and no selection', async ({ label }) => {
    await mount({ recordings: [CORPUS_REC, MIC_REC] });

    const button = actionButton(label);
    expect(button).toBeDisabled();
    expect(titleOf(button)).toMatch(/recording/i);
    // The no-selection explanation is not quietly replaced by a busy one.
    expect(titleOf(button)).not.toBe(RUN_BUSY_HINT);
    expect(titleOf(button)).not.toBe(BATCH_BUSY_HINT);
    expect(inflightNote()).toBeNull();
  });

  it('an unselected panel reaches no executor seam however often it is clicked', async () => {
    const fakes = await mount({ recordings: [CORPUS_REC, MIC_REC] });

    fireEvent.click(actionButton(RUN));
    fireEvent.click(actionButton(RUN));
    fireEvent.click(actionButton(BATCH_SWEEP));
    await flush();

    expect(fakes.runOnce).not.toHaveBeenCalled();
    expect(fakes.startBatch).not.toHaveBeenCalled();
    expect(inflightNote()).toBeNull();
  });
});
