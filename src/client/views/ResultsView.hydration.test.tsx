/**
 * TICKET 019 — Results derives from the SAME store the server holds.
 *
 * QA F2 repro: POST two Recordings and four Runs to the real API. Replay
 * renders all four run cards; Results says "No runs recorded" and the client
 * ledger blob holds `runs: 0, recordings: 0, liveSessions: 0`. Two stores
 * under one screen — PRD §8 allows exactly one.
 *
 * Three rules run through this suite:
 *
 *  1. HYDRATION IS INJECTED. `<ResultsView hydrate={...} />` takes the same
 *     kind of seam ReplayView's clients are. No test here reaches the network.
 *  2. THE GATE STILL HOLDS AFTER HYDRATION. Loading more data must not load
 *     more data PAST the gate: the failed run, the ad-hoc/manual run and the
 *     fixture-sourced run stay out of every aggregate — and stay VISIBLE on
 *     the By Recording & category tab, marked with why.
 *  3. IN FLIGHT IS NOT EMPTY, AND FAILED IS NOT EMPTY. Neither may render as
 *     "No runs recorded" — that is QA F3's bug relocated to a new screen.
 *
 * DOM addition (this ticket): the results panel carries
 *   [data-results-hydration="loading" | "ready" | "failed"]
 * and carries it ONLY when a `hydrate` source was supplied, so every pre-019
 * caller renders byte-identically to before.
 *
 * ADDITIVE to the locked ResultsView.test.tsx.
 */

// Imported directly (in addition to vitest.setup.ts) so the jest-dom matcher
// type augmentation is visible to `tsc -p tsconfig.json`.
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  deriveComparison,
  formatMs,
  formatUsd,
  type AnnotatedRun,
} from '../components/results/derive';
import {
  EXCLUDED_COST_USD,
  EXCLUDED_LATENCY_MS,
  seedLiveSessions,
} from '../components/results/testRecords';
import { ApiError } from '../replay/recordingsClient';
import type { LedgerHydrationSource } from '../state/hydrateLedger';
import {
  B_SWEEP_LATENCY_MS,
  C_SWEEP_LATENCY_MS,
  FIXTURE_RECORDING,
  FIXTURE_RUN,
  RECORDING_LABELS,
  RUN_IDS,
  SERVER_RECORDINGS,
  SERVER_RECORDING_IDS,
  SERVER_RUNS,
  staticHydrationSource,
} from '../state/hydrationFixtures';
import { RunLedger, type Recording, type Run } from '../state/ledger';
import ResultsView from './ResultsView';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const EMPTY_TITLE = 'No runs recorded';
const TAB_SECONDARY = 'By Recording & category';

const ALL_RECORDINGS: readonly Recording[] = [...SERVER_RECORDINGS, FIXTURE_RECORDING];
const ALL_RUNS: readonly AnnotatedRun[] = [...SERVER_RUNS, FIXTURE_RUN];

/* ------------------------------------------------------------- helpers -- */

/**
 * The ledger the hydrated view must be equivalent to, built by appending the
 * same entities directly. Expectations are derived from THIS, never from
 * literals, so the assertion cannot drift from the derivation.
 */
function expectedLedger(): RunLedger {
  const ledger = new RunLedger();
  for (const recording of ALL_RECORDINGS) ledger.appendRecording({ ...recording });
  for (const run of ALL_RUNS) ledger.appendRun({ ...(run as Run) });
  return ledger;
}

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

function recordingRow(recordingId: string): HTMLElement {
  const found = document.querySelector<HTMLElement>(
    `[data-recording-row][data-recording="${recordingId}"]`,
  );
  if (!found) throw new Error(`missing recording row: ${recordingId}`);
  return found;
}

function showSecondaryTab(): void {
  fireEvent.click(screen.getByRole('tab', { name: TAB_SECONDARY }));
}

/** Renders against a live ledger + the full server store, and waits for ready. */
async function renderHydrated(ledger: RunLedger = new RunLedger()) {
  const { source, calls } = staticHydrationSource(ALL_RECORDINGS, ALL_RUNS);
  const view = render(<ResultsView ledger={ledger} hydrate={source} />);
  await waitFor(() =>
    expect(panel().getAttribute('data-results-hydration')).toBe('ready'),
  );
  return { ...view, ledger, calls };
}

/* ============================================ hydration reaches the view == */

describe('ticket 019 — Results renders the server’s Runs after hydration', () => {
  it('leaves the empty state and renders Exp 2 (Arm B vs Arm C) with figures', async () => {
    await renderHydrated();

    expect(screen.queryByText(EMPTY_TITLE)).not.toBeInTheDocument();
    const model = deriveComparison(expectedLedger(), 'B', 'C')!;
    for (const metric of ['p50', 'p95', 'cost'] as const) {
      const row = model.rows.find((r) => r.metric === metric)!;
      expect(cell('exp2', metric, 'a')).toBe(row.valueA);
      expect(cell('exp2', metric, 'b')).toBe(row.valueB);
    }
    // Sanity: the derivation and the seeded server store agree on the figures.
    expect(cell('exp2', 'p50', 'a')).toBe(formatMs(B_SWEEP_LATENCY_MS));
    expect(cell('exp2', 'p50', 'b')).toBe(formatMs(C_SWEEP_LATENCY_MS));
  });

  it('the hydrated ledger IS the ledger it was handed — one store, not a copy', async () => {
    const ledger = new RunLedger();
    await renderHydrated(ledger);

    expect(ledger.getRuns().map((r) => r.id)).toEqual(ALL_RUNS.map((r) => r.id));
    expect(ledger.getRecordings().map((r) => r.id)).toEqual(ALL_RECORDINGS.map((r) => r.id));
  });

  it('hydrates Recordings too — the By Recording table shows server labels', async () => {
    await renderHydrated();
    showSecondaryTab();

    const row = recordingRow(SERVER_RECORDING_IDS.b);
    expect(row.textContent ?? '').toContain(RECORDING_LABELS[SERVER_RECORDING_IDS.b]);
  });

  it('reaches no network: globalThis.fetch is never called', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    try {
      await renderHydrated();
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

/* ============================================ the gate holds after hydration */

describe('ticket 019 — the gate survives hydration: excluded, but still visible', () => {
  /**
   * Each row is one excluded Run: it must be ABSENT from every experiment
   * figure AND PRESENT, marked, on the secondary tab. An implementation that
   * drops excluded data on the floor passes the first half and fails the
   * second.
   */
  const EXCLUSIONS = [
    {
      label: 'failed sweep run',
      runId: RUN_IDS.failed,
      recordingId: SERVER_RECORDING_IDS.failed,
      reason: 'failed',
      arm: 'B',
    },
    {
      label: 'ad-hoc/manual run declared B',
      runId: RUN_IDS.adhoc,
      recordingId: SERVER_RECORDING_IDS.adhoc,
      reason: 'ad-hoc',
      arm: 'ad-hoc',
    },
    {
      label: 'fixture-sourced run that would otherwise pass',
      runId: RUN_IDS.fixture,
      recordingId: SERVER_RECORDING_IDS.fixture,
      reason: 'fixture',
      arm: 'B',
    },
  ] as const;

  it('no excluded run moves an experiment figure', async () => {
    await renderHydrated();
    const text = panel().textContent ?? '';
    // Every excluded run carries 5.00 s / $0.500 — impossible to miss.
    expect(text).not.toContain(formatMs(EXCLUDED_LATENCY_MS));
    expect(text).not.toContain(formatUsd(EXCLUDED_COST_USD));
  });

  it('Arm B and Arm C each aggregate exactly ONE sample', async () => {
    await renderHydrated();
    const model = deriveComparison(expectedLedger(), 'B', 'C')!;
    // p50 === p95 for a single-sample arm; a leaked run would break that.
    expect(cell('exp2', 'p50', 'a')).toBe(cell('exp2', 'p95', 'a'));
    expect(cell('exp2', 'p50', 'b')).toBe(cell('exp2', 'p95', 'b'));
    expect(model.provenanceA.completedReps).toBe(1);
    expect(model.provenanceB.completedReps).toBe(1);
  });

  it.each(EXCLUSIONS)(
    '$label is listed on the secondary tab, marked excluded · $reason',
    async ({ recordingId, reason, arm }) => {
      await renderHydrated();
      showSecondaryTab();

      const row = recordingRow(recordingId);
      expect(row).toHaveAttribute('data-excluded', 'true');
      expect(row).toHaveAttribute('data-arm', arm);
      expect(row.querySelector(`[data-exclusion="${reason}"]`)).not.toBeNull();
      expect(row.textContent ?? '').toMatch(/excluded/i);
    },
  );

  it('a Run stored as armTag "B" on an off-arm triple derives ad-hoc, not B', async () => {
    const stored = ALL_RUNS.find((r) => r.id === RUN_IDS.adhoc)!;
    expect(stored.armTag).toBe('B'); // the DECLARED tag, never trusted

    await renderHydrated();
    showSecondaryTab();
    expect(recordingRow(SERVER_RECORDING_IDS.adhoc)).toHaveAttribute('data-arm', 'ad-hoc');

    // ...and 'ad-hoc' is visible ONLY here, never on the Experiments tab.
    fireEvent.click(screen.getByRole('tab', { name: 'Experiments' }));
    expect(panel().textContent ?? '').not.toContain('ad-hoc');
  });
});

/* ==================================== in flight and failed are not "empty" = */

describe('ticket 019 — hydration in flight renders no figures it does not have', () => {
  function pendingSource(): LedgerHydrationSource {
    return {
      recordings: { list: () => new Promise<Recording[]>(() => {}) },
      runs: { list: () => new Promise<Run[]>(() => {}) },
    };
  }

  it('marks the panel loading, with no metric grid and no provenance line', () => {
    render(<ResultsView ledger={new RunLedger()} hydrate={pendingSource()} />);

    expect(panel()).toHaveAttribute('data-results-hydration', 'loading');
    expect(document.querySelectorAll('[data-metric]')).toHaveLength(0);
    expect(document.querySelectorAll('[data-provenance]')).toHaveLength(0);
  });

  it('does NOT claim "No runs recorded" while it is still asking', () => {
    render(<ResultsView ledger={new RunLedger()} hydrate={pendingSource()} />);
    expect(screen.queryByText(EMPTY_TITLE)).not.toBeInTheDocument();
  });
});

describe('ticket 019 — a FAILED hydration is distinguishable from emptiness', () => {
  function failingSource(): LedgerHydrationSource {
    return {
      recordings: { list: async () => [] },
      runs: { list: () => Promise.reject(new ApiError('http-error', 500, 'HTTP 500')) },
    };
  }

  it('marks the panel failed rather than rendering the empty state', async () => {
    render(<ResultsView ledger={new RunLedger()} hydrate={failingSource()} />);

    await waitFor(() =>
      expect(panel().getAttribute('data-results-hydration')).toBe('failed'),
    );
    expect(screen.queryByText(EMPTY_TITLE)).not.toBeInTheDocument();
  });

  it('says something about the failure — an operator must not read it as "empty"', async () => {
    render(<ResultsView ledger={new RunLedger()} hydrate={failingSource()} />);
    await waitFor(() =>
      expect(panel().getAttribute('data-results-hydration')).toBe('failed'),
    );

    const empty = render(<ResultsView ledger={new RunLedger()} />);
    expect(panel().textContent ?? '').not.toBe(empty.container.textContent ?? '');
    expect((panel().textContent ?? '').length).toBeGreaterThan(0);
  });

  it('invents no figures on the way down — not one digit leaks', async () => {
    render(<ResultsView ledger={new RunLedger()} hydrate={failingSource()} />);
    await waitFor(() =>
      expect(panel().getAttribute('data-results-hydration')).toBe('failed'),
    );
    expect(panel().textContent ?? '').not.toMatch(/\d/);
  });
});

/* ================================ live-appended records survive hydration == */

describe('ticket 019 — live-appended records stay visible (regression guard)', () => {
  it('a LiveSession already in the ledger still renders after the server load', async () => {
    const ledger = new RunLedger();
    seedLiveSessions(ledger); // real sessions, appended before hydration

    await renderHydrated(ledger);

    // Both tracks are present: the local Live card AND the hydrated experiment.
    const liveCard = document.querySelector('[data-card="live"]');
    expect(liveCard).not.toBeNull();
    expect(liveCard!.querySelector('[data-empty-card="live"]')).toBeNull();
    expect(cell('exp2', 'p50', 'a')).toBe(formatMs(B_SWEEP_LATENCY_MS));
    expect(ledger.getLiveSessions()).toHaveLength(2);
  });
});

/* =========================== no hydrate prop → byte-identical to pre-019 === */

describe('ticket 019 — a host that supplies no seam is unchanged', () => {
  it('renders no hydration state attribute at all', () => {
    render(<ResultsView ledger={new RunLedger()} />);
    expect(panel().hasAttribute('data-results-hydration')).toBe(false);
    expect(screen.getByText(EMPTY_TITLE)).toBeInTheDocument();
  });

  it('does not go looking for a server on its own', () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    try {
      render(<ResultsView ledger={new RunLedger()} />);
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
