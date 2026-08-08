/**
 * Tickets 020 + 024 — QA findings F3 and F7 against the Replay panel.
 *
 * This file EXTENDS the ticket-013 spec in ReplayView.test.tsx; it does not
 * restate it. Everything there still holds. Two new rules join it:
 *
 *  020 — A FAILED LOAD IS NOT AN EMPTY STORE (PRD §12). When
 *        recordings.list() rejects, the library renders an ERROR state with a
 *        retry, and [data-recordings-empty] is ABSENT. Rendering both would be
 *        the very confusion the ticket exists to remove: an operator reading
 *        "No Recordings yet" against a dead backend concludes the app works
 *        and is simply empty. A load that SUCCEEDS with zero Recordings still
 *        renders the existing empty state, copy unchanged.
 *
 *  024 — A CONTROL THAT CANNOT ACT DOES NOT LOOK ACTIONABLE (PRD §17 25c,
 *        already modelled by Results' 'Run sweep'). With no Recording
 *        selected, 'Run' and 'Batch sweep…' are `disabled` and carry a title
 *        saying why — and, load-bearing, no executor seam is reached. Silence
 *        with a side effect would be worse than the current silence.
 *
 * ======================= DOM CONTRACT THIS FILE ADDS =======================
 * RecordingsLibrary, load FAILED:
 *   [data-recordings-error][data-error-code=<ApiErrorCode>] — the failure
 *     state. `data-error-code` is the ApiError's `code` when the rejection is
 *     an ApiError, and some other non-empty marker otherwise. Its text names
 *     the failure in operator terms AND surfaces the underlying message.
 *     [data-recordings-empty] is ABSENT, and the string 'No Recordings yet'
 *     appears nowhere in the library.
 *   [data-recordings-retry] — a button named /retry/i inside the error state.
 *     Pressing it re-issues recordings.list().
 *   The rest of the view still renders: [data-replay-view],
 *   [data-run-config-panel], [data-runs-list], [data-library-footer].
 *
 * RunConfigPanel, no Recording selected:
 *   button 'Run' and button 'Batch sweep…' both carry the `disabled`
 *   attribute and a non-empty `title` mentioning the Recording. With a
 *   Recording selected both are enabled — until a run this panel started is in
 *   flight, which ticket 044 makes a second, differently-explained reason the
 *   control cannot act (contract in ReplayView.inflight.test.tsx).
 * ==========================================================================
 */

// Imported directly (in addition to vitest.setup.ts) so the jest-dom matcher
// type augmentation is visible to `tsc -p tsconfig.json`, whose include does
// not cover the setup file.
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_CASCADE_TRIPLE, REALTIME_MODEL, deriveArmTag } from '../../core/arms';
import App, { type AppDeps } from '../App';
import type { BatchHandle, BatchSummary } from '../batch/runner';
import { ApiError, type RecordingsClient, type RunsClient } from '../replay/recordingsClient';
import type { RunOnceResult } from '../replay/runner';
import type { Recording, Run } from '../state/ledger';
import { makeDeps } from './sessionTestKit';
import ReplayView, { type ReplayBatchRequest, type ReplayDeps, type ReplayRunRequest } from './ReplayView';

afterEach(cleanup);

/* ================================================================== copy == */

/** The empty state's copy, verbatim from RecordingsLibrary. It is GOOD copy
 *  for a store that is genuinely empty, and the 020 fix must not touch it. */
const EMPTY_TITLE = 'No Recordings yet';
const EMPTY_BODY =
  'Record a clip or load the corpus. Nothing is listed until a Recording ' +
  'exists — a sample row would be indistinguishable from one you could measure.';

const LIBRARY_FOOTER =
  'Labels are editable; audio is immutable. Deleting hides a Recording but keeps its Runs. ' +
  "Corpus Recordings can't be deleted — experiments depend on them.";

const RUN = 'Run';
const BATCH_SWEEP = 'Batch sweep…';

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

const RUN_TEMPLATE: Run = {
  id: 'run-seed',
  recordingId: CORPUS_REC.id,
  architecture: 'cascade',
  providerTriple: { ...DEFAULT_CASCADE_TRIPLE },
  modelSnapshots: { ...DEFAULT_CASCADE_TRIPLE },
  armTag: 'B',
  origin: 'sweep',
  status: 'complete',
  timings: { speech_end: T0, audio_queued: T0 + 1_053 },
  transcripts: { source: 'hello', target: 'hola' },
  outputAudioPath: 'runs/run-seed.out.wav',
  cost: 0.021,
  errors: [],
  createdAt: T0 + 60_000,
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

const errorState = (): HTMLElement | null => q('[data-recordings-error]');
const emptyState = (): HTMLElement | null => q('[data-recordings-empty]');

const actionButton = (name: string): HTMLElement => screen.getByRole('button', { name });

interface FakeOptions {
  recordings?: Recording[];
  runs?: Run[];
  /** Rejection recordings.list() throws while `failListTimes` remains. */
  listError?: unknown;
  /** How many recordings.list() calls reject. Default: every one of them. */
  failListTimes?: number;
  /** runOnce returns a promise that never settles — a run still in flight. */
  runNeverSettles?: boolean;
}

function makeFakes(options: FakeOptions = {}) {
  const store = {
    recordings: (options.recordings ?? []).map((r) => ({ ...r })),
    runs: (options.runs ?? []).map((r) => ({ ...r })),
  };

  let remainingFailures =
    options.listError === undefined ? 0 : (options.failListTimes ?? Number.POSITIVE_INFINITY);

  const recordings = {
    list: vi.fn(async (): Promise<Recording[]> => {
      if (remainingFailures > 0) {
        remainingFailures -= 1;
        throw options.listError;
      }
      return store.recordings.filter((r) => r.deletedAt === undefined).map((r) => ({ ...r }));
    }),
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

  const runOnce = vi.fn(async (request: ReplayRunRequest): Promise<RunOnceResult> => {
    if (options.runNeverSettles === true) return new Promise<RunOnceResult>(() => {});
    const run: Run = {
      ...RUN_TEMPLATE,
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
    };
    store.runs.push(run);
    return {
      run,
      outputAudio: new Int16Array(0),
      audioReady: true,
      t0: T0,
      speechEndMs: 0,
      cancelled: false,
    };
  });

  const batchRequests: ReplayBatchRequest[] = [];
  const startBatch = vi.fn((request: ReplayBatchRequest): BatchHandle => {
    batchRequests.push(request);
    return { done: new Promise<BatchSummary>(() => {}), cancel: vi.fn() };
  });

  const playRun = vi.fn();

  const deps: ReplayDeps = {
    recordings: recordings as unknown as RecordingsClient,
    runs: runs as unknown as RunsClient,
    runOnce: runOnce as unknown as ReplayDeps['runOnce'],
    startBatch: startBatch as unknown as ReplayDeps['startBatch'],
    playRun,
    now: () => T0,
    newId: () => 'id-1',
  };

  return { deps, store, recordings, runs, runOnce, startBatch, batchRequests, playRun };
}

/** Renders and waits for the library shell — success or failure, either way. */
async function mount(options: FakeOptions = {}) {
  const fakes = makeFakes(options);
  render(<ReplayView deps={fakes.deps} />);
  await waitFor(() => expect(q('[data-recordings-library]')).not.toBeNull());
  await waitFor(() => expect(fakes.recordings.list).toHaveBeenCalled());
  const expected = options.recordings ?? [];
  if (options.listError === undefined && expected.length > 0) {
    await waitFor(() => expect(rows()).toHaveLength(expected.length));
  }
  return fakes;
}

/** Renders against a store that cannot be read, and waits for the error. */
async function mountFailed(options: FakeOptions = {}) {
  const fakes = await mount({ listError: new ApiError('http-error', 500, 'HTTP 500'), ...options });
  await waitFor(() => expect(errorState()).not.toBeNull());
  return fakes;
}

async function selectRecording(recordingId: string): Promise<HTMLElement> {
  const element = get(`[data-recording-row][data-recording="${recordingId}"]`);
  fireEvent.click(element);
  await waitFor(() =>
    expect(get(`[data-recording-row][data-recording="${recordingId}"]`)).toHaveAttribute(
      'data-selected',
      'true',
    ),
  );
  return get(`[data-recording-row][data-recording="${recordingId}"]`);
}

/* ============================================================ ticket 020 == */

describe('ticket 020 — a failed recordings load is NOT an empty store', () => {
  /**
   * The shapes a dead backend actually arrives in. The QA repro is the first:
   * the proxy logs ECONNREFUSED and the client sees 500 with an empty body,
   * which recordingsClient surfaces as ApiError('http-error', 500).
   */
  const LOAD_FAILURES = [
    {
      name: '500 with an empty body (proxy ECONNREFUSED — the QA repro)',
      error: new ApiError('http-error', 500, 'HTTP 500'),
      code: 'http-error',
      detail: 'HTTP 500',
    },
    {
      name: '404 from the recordings endpoint',
      error: new ApiError('http-error', 404, 'HTTP 404'),
      code: 'http-error',
      detail: 'HTTP 404',
    },
    {
      name: 'fetch itself throwing — nothing is listening at all',
      error: new TypeError('Failed to fetch'),
      code: null,
      detail: 'Failed to fetch',
    },
  ] as const;

  it.each(LOAD_FAILURES)(
    '$name renders the error state and NOT the empty state',
    async ({ error, code }) => {
      await mountFailed({ recordings: [], listError: error });

      // BOTH halves. An implementation that renders the error state beside the
      // empty state is exactly the confusion this ticket exists to remove.
      expect(errorState()).not.toBeNull();
      expect(emptyState()).toBeNull();
      expect(rows()).toHaveLength(0);
      expect(text(get('[data-recordings-library]'))).not.toContain(EMPTY_TITLE);
      expect(screen.queryByText(EMPTY_TITLE)).toBeNull();
      expect(screen.queryByText(EMPTY_BODY)).toBeNull();

      const marker = errorState()!.getAttribute('data-error-code') ?? '';
      expect(marker.length).toBeGreaterThan(0);
      if (code !== null) expect(marker).toBe(code);
    },
  );

  it.each(LOAD_FAILURES)('$name is named in operator-readable terms', async ({ error, detail }) => {
    await mountFailed({ recordings: [], listError: error });
    const panel = text(errorState());

    // What went wrong, in words...
    expect(panel).toMatch(/recording/i);
    expect(panel).toMatch(/load|reach|unavailable|could ?n.t|couldn't|unable|error/i);
    // ...and the underlying reason, not swallowed.
    expect(panel).toContain(detail);
  });

  it('offers a retry inside the error state, and pressing it re-issues the request', async () => {
    const fakes = await mountFailed({ recordings: [CORPUS_REC, MIC_REC], failListTimes: 1 });
    expect(fakes.recordings.list).toHaveBeenCalledTimes(1);

    const retry = within(errorState()!).getByRole('button', { name: /retry/i });
    expect(retry).not.toBeDisabled();
    expect(errorState()!.querySelector('[data-recordings-retry]')).not.toBeNull();

    fireEvent.click(retry);

    await waitFor(() => expect(fakes.recordings.list).toHaveBeenCalledTimes(2));
    // The retry SUCCEEDED, so the store's rows replace the error entirely.
    await waitFor(() => expect(rows()).toHaveLength(2));
    expect(errorState()).toBeNull();
    expect(emptyState()).toBeNull();
  });

  it('a retry that fails again stays in the error state and can be pressed again', async () => {
    const fakes = await mountFailed({ recordings: [CORPUS_REC] });

    fireEvent.click(within(errorState()!).getByRole('button', { name: /retry/i }));
    await waitFor(() => expect(fakes.recordings.list).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(errorState()).not.toBeNull());
    expect(emptyState()).toBeNull();

    fireEvent.click(within(errorState()!).getByRole('button', { name: /retry/i }));
    await waitFor(() => expect(fakes.recordings.list).toHaveBeenCalledTimes(3));
  });

  it('a retry that succeeds into a genuinely empty store lands on the EMPTY state', async () => {
    const fakes = await mountFailed({ recordings: [], failListTimes: 1 });

    fireEvent.click(within(errorState()!).getByRole('button', { name: /retry/i }));

    await waitFor(() => expect(emptyState()).not.toBeNull());
    expect(errorState()).toBeNull();
    expect(fakes.recordings.list).toHaveBeenCalledTimes(2);
  });

  /* ---- regression guard: a SUCCESSFUL zero-Recording load is unchanged ---- */

  it('a successful load returning zero Recordings renders the empty state, copy verbatim', async () => {
    await mount({ recordings: [] });
    await waitFor(() => expect(emptyState()).not.toBeNull());

    expect(errorState()).toBeNull();
    expect(rows()).toHaveLength(0);

    // The copy is GOOD copy for a genuinely empty store. Pinned verbatim so
    // the 020 fix cannot replace it with an error.
    const empty = emptyState()!;
    expect(within(empty).getByText(EMPTY_TITLE)).toBeInTheDocument();
    expect(within(empty).getByText(EMPTY_BODY)).toBeInTheDocument();
    expect(empty.querySelector('[data-recordings-retry]')).toBeNull();
    expect(within(empty).queryByRole('button', { name: /retry/i })).toBeNull();
  });

  /* ---- the 024 interaction: not ready to run against an unreadable store -- */

  it('the run-configuration panel does not present itself as ready after a failed load', async () => {
    const fakes = await mountFailed({ recordings: [CORPUS_REC] });

    for (const name of [RUN, BATCH_SWEEP]) {
      const button = actionButton(name);
      expect(button, name).toBeDisabled();
      expect((button.getAttribute('title') ?? '').length, name).toBeGreaterThan(0);
    }

    fireEvent.click(actionButton(RUN));
    fireEvent.click(actionButton(BATCH_SWEEP));

    expect(fakes.runOnce).not.toHaveBeenCalled();
    expect(fakes.startBatch).not.toHaveBeenCalled();
    expect(fakes.runs.create).not.toHaveBeenCalled();
    expect(q('[data-batch-progress]')).toBeNull();
  });

  /* ---- the view survives: nothing crashes, nothing goes blank ------------- */

  it('a load failure leaves the whole view standing — not blank, not crashed', async () => {
    await mountFailed({ recordings: [CORPUS_REC] });

    expect(q('[data-replay-view]')).not.toBeNull();
    expect(screen.getByText('Replay')).toBeInTheDocument();
    expect(q('[data-recordings-library]')).not.toBeNull();
    expect(q('[data-run-config-panel]')).not.toBeNull();
    expect(q('[data-runs-list]')).not.toBeNull();
    // The lifecycle rules are stated whatever the store's state.
    expect(text(get('[data-library-footer]'))).toBe(LIBRARY_FOOTER);
  });

  it('Live, Results and Help stay reachable with the Replay store unreadable', async () => {
    const replay = makeFakes({
      recordings: [CORPUS_REC],
      listError: new ApiError('http-error', 500, 'HTTP 500'),
    });
    const kit = makeDeps({ now: () => T0 });
    const deps: AppDeps = { ...kit.deps, replay: replay.deps };
    render(<App deps={deps} />);

    fireEvent.click(screen.getByRole('button', { name: 'Replay' }));
    await waitFor(() => expect(errorState()).not.toBeNull());

    const REACHABLE = [
      ['Results', '[data-results-tab]'],
      ['Help', '[data-help-view]'],
      ['Live', '[data-mic-indicator]'],
    ] as const;

    for (const [tab, probe] of REACHABLE) {
      fireEvent.click(screen.getByRole('button', { name: tab }));
      await waitFor(() => expect(q(probe), tab).not.toBeNull());
    }
  });
});

/* ============================================================ ticket 024 == */

describe('ticket 024 — Run and Batch sweep have no affordance without a selection', () => {
  const ACTIONS = [
    { label: RUN, name: 'Run' },
    { label: BATCH_SWEEP, name: 'Batch sweep…' },
  ] as const;

  it.each(ACTIONS)('$name is disabled and says why with no Recording selected', async ({ label }) => {
    await mount({ recordings: [CORPUS_REC, MIC_REC] });

    const button = actionButton(label);
    expect(button).toBeDisabled();
    const title = button.getAttribute('title') ?? '';
    expect(title.length).toBeGreaterThan(0);
    // It explains the missing PRECONDITION, not the absence of a click handler.
    expect(title).toMatch(/recording/i);
  });

  it.each(ACTIONS)('$name is enabled once a Recording is selected', async ({ label }) => {
    await mount({ recordings: [CORPUS_REC, MIC_REC] });
    expect(actionButton(label)).toBeDisabled();

    await selectRecording(CORPUS_REC.id);

    expect(actionButton(label)).toBeEnabled();
  });

  it('selection is the ONLY thing that flips them — nothing was executed to enable them', async () => {
    const fakes = await mount({ recordings: [CORPUS_REC] });
    expect(actionButton(RUN)).toBeDisabled();
    expect(actionButton(BATCH_SWEEP)).toBeDisabled();

    await selectRecording(CORPUS_REC.id);

    expect(actionButton(RUN)).toBeEnabled();
    expect(actionButton(BATCH_SWEEP)).toBeEnabled();
    expect(fakes.runOnce).not.toHaveBeenCalled();
    expect(fakes.startBatch).not.toHaveBeenCalled();
  });

  it('clicking the disabled Run reaches NO executor seam', async () => {
    const fakes = await mount({ recordings: [CORPUS_REC, MIC_REC] });

    fireEvent.click(actionButton(RUN));
    fireEvent.click(actionButton(RUN));

    // Silence with a side effect would be worse than the current silence.
    expect(fakes.runOnce).not.toHaveBeenCalled();
    expect(fakes.runs.create).not.toHaveBeenCalled();
    expect(fakes.startBatch).not.toHaveBeenCalled();
  });

  it('clicking the disabled Batch sweep starts NO sweep and opens no progress panel', async () => {
    const fakes = await mount({ recordings: [CORPUS_REC, MIC_REC] });

    fireEvent.click(actionButton(BATCH_SWEEP));

    expect(fakes.startBatch).not.toHaveBeenCalled();
    expect(fakes.runOnce).not.toHaveBeenCalled();
    expect(q('[data-batch-progress]')).toBeNull();
  });

  /* ---- regression guards: the enabled path still does its job ------------- */

  it('Run with a Recording selected still triggers exactly one run of it', async () => {
    const fakes = await mount({ recordings: [CORPUS_REC, MIC_REC] });
    await selectRecording(MIC_REC.id);

    fireEvent.click(actionButton(RUN));

    await waitFor(() => expect(fakes.runOnce).toHaveBeenCalledTimes(1));
    const request = fakes.runOnce.mock.calls[0]![0] as ReplayRunRequest;
    expect(request.recordingId).toBe(MIC_REC.id);
    expect(fakes.startBatch).not.toHaveBeenCalled();
  });

  it('Batch sweep with a Recording selected still starts a sweep over it', async () => {
    const fakes = await mount({ recordings: [CORPUS_REC, MIC_REC] });
    await selectRecording(CORPUS_REC.id);

    fireEvent.click(actionButton(BATCH_SWEEP));

    await waitFor(() => expect(fakes.startBatch).toHaveBeenCalledTimes(1));
    expect(fakes.batchRequests[0]!.recordingIds).toContain(CORPUS_REC.id);
  });

  /* ---- SUPERSEDED BY TICKET 044 -------------------------------------------
   * This pin used to assert the opposite: that a run in flight left Run
   * enabled, because "whether the operator may start a run is not a fact about
   * the previous request". QA proved that wrong in the only way that counts —
   * with no feedback at all the operator clicks again, and a second billable
   * run starts. So 024's own principle now applies to the busy case too: while
   * a run is in flight the button cannot act, therefore it does not look
   * actionable. The reason it names is the RUN, never the selection; the full
   * in-flight contract lives in ReplayView.inflight.test.tsx.
   * ----------------------------------------------------------------------- */

  it('a run still in flight disables Run, and says the run — not the selection — is why', async () => {
    const fakes = await mount({ recordings: [CORPUS_REC], runNeverSettles: true });
    await selectRecording(CORPUS_REC.id);

    fireEvent.click(actionButton(RUN));
    await waitFor(() => expect(fakes.runOnce).toHaveBeenCalledTimes(1));

    // The request never settles, so the guard is the only thing that can stop
    // a second one.
    await waitFor(() => expect(actionButton(RUN)).toBeDisabled());
    fireEvent.click(actionButton(RUN));
    fireEvent.click(actionButton(RUN));
    await waitFor(() => expect(actionButton(RUN)).toBeDisabled());
    expect(fakes.runOnce).toHaveBeenCalledTimes(1);

    // A Recording IS selected — the explanation must not be the 024 gate's.
    const title = actionButton(RUN).getAttribute('title') ?? '';
    expect(title.length).toBeGreaterThan(0);
    expect(title).not.toMatch(/select a recording|no recording/i);
  });
});
