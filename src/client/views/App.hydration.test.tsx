/**
 * TICKET 019 — App forwards the Results hydration seam, and ONLY when given one.
 *
 * Two claims, and the second is what keeps the locked App suite green:
 *
 *  1. `deps.hydrate` reaches <ResultsView hydrate={...} />, so the real product
 *     shows the server's Runs.
 *  2. A host that wires REPLAY but no hydration seam gets today's behaviour
 *     exactly. Replay's clients are NOT implicitly the Results hydration
 *     source: the locked App.test.tsx renders a fully-wired Replay bag holding
 *     two gate-passing Runs while asserting Results reads "No runs recorded"
 *     and that a Live session's records show up with no reload. Deriving
 *     hydration from `deps.replay` would break both of those.
 *
 * ADDITIVE to the locked App.test.tsx.
 */

// Imported directly (in addition to vitest.setup.ts) so the jest-dom matcher
// type augmentation is visible to `tsc -p tsconfig.json`.
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import App, { type AppDeps } from '../App';
import type { BatchHandle } from '../batch/runner';
import { formatMs } from '../components/results/derive';
import type { RecordingsClient, RunsClient } from '../replay/recordingsClient';
import type { RunOnceResult } from '../replay/runner';
import {
  B_SWEEP_LATENCY_MS,
  C_SWEEP_LATENCY_MS,
  RUN_IDS,
  SERVER_RECORDINGS,
  SERVER_RUNS,
  staticHydrationSource,
} from '../state/hydrationFixtures';
import { makeDeps } from './sessionTestKit';
import type { ReplayDeps } from './ReplayView';

afterEach(cleanup);

const EMPTY_TITLE = 'No runs recorded';

function panel(): HTMLElement {
  const found = document.querySelector<HTMLElement>('[data-results-tab]');
  if (!found) throw new Error('missing results panel');
  return found;
}

function cell(cardName: string, metric: string, col: string): string {
  const found = document.querySelector(
    `[data-card="${cardName}"] [data-metric="${metric}"] [data-col="${col}"]`,
  );
  if (!found) throw new Error(`missing cell: ${cardName}/${metric}/${col}`);
  return (found.textContent ?? '').trim();
}

function showResults(): void {
  fireEvent.click(screen.getByRole('button', { name: 'Results' }));
}

/**
 * A Replay bag holding the SAME gate-passing Runs the hydration source does.
 * If App treated it as a hydration source, test 2 would show figures.
 */
function makeReplayDeps(): ReplayDeps {
  const recordings = {
    list: vi.fn(async () => SERVER_RECORDINGS.map((r) => ({ ...r }))),
    get: vi.fn(async () => ({ ...SERVER_RECORDINGS[0]! })),
    getAudio: vi.fn(async () => new Uint8Array()),
    create: vi.fn(async () => ({ ...SERVER_RECORDINGS[0]! })),
    patchLabel: vi.fn(async () => ({ ...SERVER_RECORDINGS[0]! })),
    remove: vi.fn(async () => ({ ...SERVER_RECORDINGS[0]! })),
  };
  const runs = {
    create: vi.fn(async () => ({ ...SERVER_RUNS[0]! })),
    list: vi.fn(async () => SERVER_RUNS.map((r) => ({ ...r }))),
    getAudio: vi.fn(async () => new Uint8Array()),
  };
  return {
    recordings: recordings as unknown as RecordingsClient,
    runs: runs as unknown as RunsClient,
    runOnce: vi.fn(async () => ({}) as RunOnceResult) as unknown as ReplayDeps['runOnce'],
    startBatch: vi.fn(() => ({}) as BatchHandle) as unknown as ReplayDeps['startBatch'],
    playRun: vi.fn(),
    now: () => 0,
    newId: () => 'blind-1',
  };
}

describe('ticket 019 — <App deps={{ hydrate }} /> forwards the seam to Results', () => {
  it('the Results tab renders the server’s Runs', async () => {
    const kit = makeDeps({ now: () => 0 });
    const { source } = staticHydrationSource();
    const deps: AppDeps = { ...kit.deps, hydrate: source };
    render(<App deps={deps} />);

    showResults();
    await waitFor(() =>
      expect(panel().getAttribute('data-results-hydration')).toBe('ready'),
    );

    expect(screen.queryByText(EMPTY_TITLE)).not.toBeInTheDocument();
    expect(cell('exp2', 'p50', 'a')).toBe(formatMs(B_SWEEP_LATENCY_MS));
    expect(cell('exp2', 'p50', 'b')).toBe(formatMs(C_SWEEP_LATENCY_MS));
  });

  it('hydration lands in the SHARED ledger — the one every view reads', async () => {
    const kit = makeDeps({ now: () => 0 });
    render(<App deps={{ ...kit.deps, hydrate: staticHydrationSource().source }} />);

    showResults();
    await waitFor(() =>
      expect(panel().getAttribute('data-results-hydration')).toBe('ready'),
    );

    expect(kit.ledger.getRuns().map((r) => r.id)).toEqual(SERVER_RUNS.map((r) => r.id));
    expect(kit.ledger.getRecordings().map((r) => r.id)).toEqual(
      SERVER_RECORDINGS.map((r) => r.id),
    );
  });
});

describe('ticket 019 — a Replay bag is NOT implicitly a hydration source', () => {
  it('with `replay` wired and no `hydrate`, Results reads the client ledger alone', async () => {
    const kit = makeDeps({ now: () => 0 });
    const replay = makeReplayDeps();
    render(<App deps={{ ...kit.deps, replay }} />);

    showResults();

    expect(screen.getByText(EMPTY_TITLE)).toBeInTheDocument();
    expect(panel().hasAttribute('data-results-hydration')).toBe(false);
    expect(panel().textContent ?? '').not.toMatch(/\d/);

    // Give any stray async load a chance to land, then re-check.
    await waitFor(() => expect(screen.getByText(EMPTY_TITLE)).toBeInTheDocument());
    expect(kit.ledger.getRuns()).toEqual([]);
    expect(kit.ledger.getRuns().map((r) => r.id)).not.toContain(RUN_IDS.bSweep);
  });
});
