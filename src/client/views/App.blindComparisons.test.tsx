/**
 * TICKET 023 (QA F6) — a submitted blind comparison reaches the SERVER.
 *
 * The observed bug: scoring two samples in Replay wrote the comparison into
 * `localStorage["workbench.runLedger.v1"].blindComparisons` and nowhere else.
 * The record itself was complete and correct; only its destination was wrong.
 * PRD §7 — "the server owns the store; the client reads and writes it over
 * REST" — and PRD §10 explicitly describes a Spanish-speaking coworker scoring
 * "on the deployed instance", which a browser-local store cannot serve.
 *
 * These tests drive the REAL <App />, exactly like the locked App.test.tsx,
 * with a replay bag that omits every optional blind seam — because App is what
 * fills `recordBlindComparison` in, so App is what decides where a judgement
 * lands.
 *
 * ADDITIVE to the locked App.test.tsx: nothing here weakens the ledger claim.
 * The ledger is still written; the server is written TOO. "No longer persists
 * ONLY to localStorage" is a both-of statement, and both halves are asserted.
 */

// Imported directly (in addition to vitest.setup.ts) so the jest-dom matcher
// type augmentation is visible to `tsc -p tsconfig.json`.
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import App, { type AppDeps } from '../App';
import { buildReplayDeps } from '../browserDeps';
import { DEFAULT_CASCADE_TRIPLE, type ProviderTriple } from '../../core/arms';
import type { BatchHandle } from '../batch/runner';
import type {
  BlindComparisonsClient,
  RecordingsClient,
  RunsClient,
} from '../replay/recordingsClient';
import type { RunOnceResult } from '../replay/runner';
import type { BlindComparison, Recording, Run } from '../state/ledger';
import type { ReplayDeps } from './ReplayView';
import { makeDeps } from './sessionTestKit';

afterEach(cleanup);

const OPEN_BLIND = 'compare blind (pick 2 runs)';

const q = (selector: string): HTMLElement | null => document.querySelector<HTMLElement>(selector);

function get(selector: string): HTMLElement {
  const found = q(selector);
  if (!found) throw new Error(`missing element: ${selector}`);
  return found;
}

/* ====================================================== replay fixtures === */

const T0 = Date.UTC(2026, 1, 3, 9, 41, 0);

const REC: Recording = {
  id: 'rec-1',
  label: 'clinic intake',
  sourceLanguage: 'en',
  durationMs: 60_000,
  speechEndMs: 59_000,
  origin: 'corpus',
  createdAt: T0,
};

const ARM_C_TRIPLE: ProviderTriple = { ...DEFAULT_CASCADE_TRIPLE, tts: 'eleven_flash_v2_5' };

function completeRun(overrides: Partial<Run> & Pick<Run, 'id'>): Run {
  return {
    recordingId: REC.id,
    architecture: 'cascade',
    providerTriple: { ...DEFAULT_CASCADE_TRIPLE },
    modelSnapshots: { ...DEFAULT_CASCADE_TRIPLE },
    armTag: 'B',
    origin: 'sweep',
    status: 'complete',
    timings: {
      speech_end: T0,
      audio_queued: T0 + 1_053,
    },
    transcripts: { source: 'Where exactly does it hurt', target: 'Donde le duele exactamente' },
    outputAudioPath: `runs/${overrides.id}.out.wav`,
    cost: 0.021,
    errors: [],
    createdAt: T0 + 60_000,
    ...overrides,
  };
}

const RUN_B = completeRun({ id: 'run-b' });
const RUN_C = completeRun({
  id: 'run-c',
  providerTriple: { ...ARM_C_TRIPLE },
  modelSnapshots: { ...ARM_C_TRIPLE },
  armTag: 'C',
});

/**
 * A Replay bag with every REQUIRED seam, NONE of the three optional blind ones,
 * and — the point of this suite — an injected blind-comparisons REST client.
 */
function makeReplayDeps(
  options: { create?: (c: BlindComparison) => Promise<BlindComparison> } = {},
) {
  const recordings = {
    list: vi.fn(async () => [{ ...REC }]),
    get: vi.fn(async () => ({ ...REC })),
    getAudio: vi.fn(async () => new Uint8Array()),
    create: vi.fn(async () => ({ ...REC })),
    patchLabel: vi.fn(async () => ({ ...REC })),
    remove: vi.fn(async () => ({ ...REC })),
  };
  const runs = {
    create: vi.fn(async (run: Run) => run),
    list: vi.fn(async () => [{ ...RUN_B }, { ...RUN_C }]),
    getAudio: vi.fn(async () => new Uint8Array()),
  };
  const create = vi.fn(
    options.create ?? (async (comparison: BlindComparison) => comparison),
  );
  const blindComparisons = {
    create,
    list: vi.fn(async () => []),
  };

  let ids = 0;
  const deps: ReplayDeps = {
    recordings: recordings as unknown as RecordingsClient,
    runs: runs as unknown as RunsClient,
    runOnce: vi.fn(async () => ({}) as RunOnceResult) as unknown as ReplayDeps['runOnce'],
    startBatch: vi.fn(() => ({}) as BatchHandle) as unknown as ReplayDeps['startBatch'],
    playRun: vi.fn(),
    now: () => T0 + 900_000,
    newId: () => `blind-${++ids}`,
    blindComparisons: blindComparisons as unknown as BlindComparisonsClient,
    // rng / evaluatorLanguage / recordBlindComparison DELIBERATELY ABSENT.
  };
  return { deps, create };
}

/* ============================================================= driving ==== */

function sample(key: 'A' | 'B'): HTMLElement {
  return get(`[data-blind-sample="${key}"]`);
}

function score(key: 'A' | 'B', dimension: 'adequacy' | 'fluency', n: number): void {
  const cell = sample(key).querySelector<HTMLElement>(`[data-blind-dimension="${dimension}"]`);
  if (!cell) throw new Error(`missing dimension ${dimension} on sample ${key}`);
  fireEvent.click(within(cell).getByRole('button', { name: String(n) }));
}

/** Replay → select the Recording → open blind compare → score all four → submit. */
async function submitAComparison(): Promise<void> {
  fireEvent.click(screen.getByRole('button', { name: 'Replay' }));
  await waitFor(() =>
    expect(q(`[data-recording-row][data-recording="${REC.id}"]`)).not.toBeNull(),
  );
  fireEvent.click(get(`[data-recording-row][data-recording="${REC.id}"]`));
  await waitFor(() => expect(q('[data-runs-list]')).not.toBeNull());

  fireEvent.click(screen.getByRole('button', { name: OPEN_BLIND }));
  expect(q('[data-blind-card]')).not.toBeNull();

  score('A', 'adequacy', 4);
  score('A', 'fluency', 3);
  score('B', 'adequacy', 2);
  score('B', 'fluency', 5);
  fireEvent.click(screen.getByRole('button', { name: 'submit ratings' }));
}

/* ============================================================== the tests = */

describe('ticket 023 — a submitted comparison reaches POST /api/blind-comparisons', () => {
  it('AC4: the comparison is POSTed, not merely stored in the browser', async () => {
    const kit = makeDeps({ now: () => T0 });
    const replay = makeReplayDeps();
    const deps: AppDeps = { ...kit.deps, replay: replay.deps };
    render(<App deps={deps} />);

    await submitAComparison();

    await waitFor(() => expect(replay.create).toHaveBeenCalledTimes(1));
    const posted = replay.create.mock.calls[0]![0] as BlindComparison;

    // The COMPLETE record travels — the draw, both samples' scores, the runs
    // compared and the evaluator's language (PRD §10).
    expect(posted.recordingId).toBe(REC.id);
    expect([...posted.runIds].sort()).toEqual([RUN_B.id, RUN_C.id]);
    expect(new Set(posted.order)).toEqual(new Set([RUN_B.id, RUN_C.id]));
    expect(posted.scores).toEqual({
      A: { adequacy: 4, fluency: 3 },
      B: { adequacy: 2, fluency: 5 },
    });
    expect(typeof posted.evaluatorLanguage).toBe('string');
    expect(posted.evaluatorLanguage.length).toBeGreaterThan(0);
    expect(typeof posted.id).toBe('string');
    expect(posted.id.length).toBeGreaterThan(0);
  });

  it('AC4: the SAME record goes to both destinations — no second, divergent copy', async () => {
    const kit = makeDeps({ now: () => T0 });
    const replay = makeReplayDeps();
    render(<App deps={{ ...kit.deps, replay: replay.deps }} />);

    await submitAComparison();

    await waitFor(() => expect(replay.create).toHaveBeenCalledTimes(1));
    const recorded = kit.ledger.getBlindComparisons();
    expect(recorded).toHaveLength(1);
    expect(replay.create.mock.calls[0]![0]).toEqual(recorded[0]);
  });

  it('AC4: a host that supplies NO client still records locally (no regression, no throw)', async () => {
    const kit = makeDeps({ now: () => T0 });
    const replay = makeReplayDeps();
    delete replay.deps.blindComparisons;
    render(<App deps={{ ...kit.deps, replay: replay.deps }} />);

    await submitAComparison();

    expect(kit.ledger.getBlindComparisons()).toHaveLength(1);
    expect(replay.create).not.toHaveBeenCalled();
  });

  it('AC6: a REJECTED post never costs the evaluator their work', async () => {
    const kit = makeDeps({ now: () => T0 });
    const replay = makeReplayDeps({
      create: () => Promise.reject(new Error('the server is unreachable')),
    });
    render(<App deps={{ ...kit.deps, replay: replay.deps }} />);

    await submitAComparison();

    await waitFor(() => expect(replay.create).toHaveBeenCalledTimes(1));
    // The judgement survives locally, and the reveal still happened — a failed
    // POST is not allowed to discard or hide what was scored.
    expect(kit.ledger.getBlindComparisons()).toHaveLength(1);
    expect(q('[data-blind-card]')).not.toBeNull();
  });
});

describe('ticket 023 — the PRODUCTION bag carries the client', () => {
  it('AC4: buildReplayDeps() supplies a blind-comparisons client', () => {
    const deps = buildReplayDeps();

    expect(deps.blindComparisons).toBeDefined();
    expect(typeof deps.blindComparisons?.create).toBe('function');
    expect(typeof deps.blindComparisons?.list).toBe('function');
  });
});
