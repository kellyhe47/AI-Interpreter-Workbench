/**
 * TICKET 025 (QA F8) — the provenance stamp attributes RESULTS, so with no
 * results it says nothing.
 *
 * The observed bug: opening Results on an empty ledger rendered
 * `run 2026-08-06 · corpus v1` in the top bar beside a body reading "No runs
 * recorded". The panel itself is correctly digit-free; the stamp sits outside
 * it and asserted a corpus version over nothing.
 *
 * PRD §8: "Every result carries a provenance line — corpus version, utterance
 * count, repetitions, pinned endpointing value. A number without provenance is
 * a claim; a number with it is citable." With zero results there is nothing to
 * attribute. App.tsx:20-22 already documents the neighbouring judgement —
 * provenance is withheld from Live because "a live session is not a run;
 * provenance over it would be a category error". A Results view with nothing in
 * it is the same category error.
 *
 * BOTH HALVES LIVE IN THIS FILE ON PURPOSE. Absence on an empty ledger and
 * PRESENCE with gate-passing runs are asserted side by side, so the fix cannot
 * be "delete the stamp".
 *
 * The rule these tests pin is not "count records" but: THE STAMP APPEARS
 * EXACTLY WHEN RESULTS IS SHOWING RESULTS. A fixture-only ledger and a ledger
 * mid-hydration both render 'No runs recorded' / the loading note, and neither
 * has anything to attribute.
 */

// Imported directly (in addition to vitest.setup.ts) so the jest-dom matcher
// type augmentation is visible to `tsc -p tsconfig.json`.
import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import App, { type AppDeps } from '../App';
import { DEFAULT_CASCADE_TRIPLE } from '../../core/arms';
import type { BatchHandle } from '../batch/runner';
import {
  ARM_B_TRIPLE,
  FIXTURE_RECORDING_ID,
  makeRecordingEntity,
  runWithLatency,
  seedCleanSweep,
} from '../components/results/testRecords';
import { ApiError, type RecordingsClient, type RunsClient } from '../replay/recordingsClient';
import type { RunOnceResult } from '../replay/runner';
import type { LedgerHydrationSource } from '../state/hydrateLedger';
import { RunLedger, type Recording, type Run } from '../state/ledger';
import type { ReplayDeps } from './ReplayView';
import { makeDeps } from './sessionTestKit';

afterEach(cleanup);

/** deps.now pinned to 2026-08-05 UTC so the stamp's date is deterministic. */
const NOW = Date.UTC(2026, 7, 5, 12, 0, 0);
const PROVENANCE = 'run 2026-08-05 · corpus v1';

const EMPTY_TITLE = 'No runs recorded';

const TABS = ['Live', 'Replay', 'Results', 'Help'] as const;
type TabName = (typeof TABS)[number];

const PROBE: Record<TabName, string> = {
  Live: '[data-mic-indicator]',
  Replay: '[data-replay-view]',
  Results: '[data-results-tab]',
  Help: '[data-help-view]',
};

const q = (selector: string): HTMLElement | null => document.querySelector<HTMLElement>(selector);

function get(selector: string): HTMLElement {
  const found = q(selector);
  if (!found) throw new Error(`missing element: ${selector}`);
  return found;
}

const stamp = (): HTMLElement | null => q('[data-provenance-run]');

async function showTab(name: TabName): Promise<void> {
  fireEvent.click(screen.getByRole('button', { name }));
  await waitFor(() => expect(q(PROBE[name])).not.toBeNull());
}

/* ------------------------------------------------------------- fixtures -- */

const REC: Recording = {
  id: 'rec-replay-1',
  label: 'clinic intake',
  sourceLanguage: 'en',
  durationMs: 60_000,
  speechEndMs: 59_000,
  origin: 'corpus',
  createdAt: NOW - 900_000,
};

/** The minimum Replay bag the Replay tab needs to mount. */
function makeReplayDeps(): ReplayDeps {
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
    list: vi.fn(async () => [] as Run[]),
    getAudio: vi.fn(async () => new Uint8Array()),
  };
  return {
    recordings: recordings as unknown as RecordingsClient,
    runs: runs as unknown as RunsClient,
    runOnce: vi.fn(async () => ({}) as RunOnceResult) as unknown as ReplayDeps['runOnce'],
    startBatch: vi.fn(() => ({}) as BatchHandle) as unknown as ReplayDeps['startBatch'],
    playRun: vi.fn(),
    now: () => NOW,
    newId: () => 'blind-1',
  };
}

/** A ledger holding five gate-passing sweep runs of one real Recording. */
function seededLedger(): RunLedger {
  const ledger = new RunLedger();
  seedCleanSweep(ledger);
  return ledger;
}

/** A ledger whose only Run is fixture-sourced — Results calls this empty. */
function fixtureOnlyLedger(): RunLedger {
  const ledger = new RunLedger();
  ledger.appendRecording(makeRecordingEntity({ id: FIXTURE_RECORDING_ID }));
  ledger.appendRun(
    runWithLatency(1_000, {
      id: 'run-fx-only',
      recordingId: FIXTURE_RECORDING_ID,
      modelSnapshots: { ...ARM_B_TRIPLE, tts: 'fixture' },
    }),
  );
  return ledger;
}

function renderWorkbench(opts: { ledger?: RunLedger; hydrate?: LedgerHydrationSource } = {}) {
  const kit = makeDeps({ now: () => NOW, ...(opts.ledger ? { ledger: opts.ledger } : {}) });
  const deps: AppDeps = {
    ...kit.deps,
    replay: makeReplayDeps(),
    ...(opts.hydrate ? { hydrate: opts.hydrate } : {}),
  };
  return { ...kit, view: render(<App deps={deps} />) };
}

/* ======================================================= the two halves === */

describe('ticket 025 — the run-provenance stamp on Results', () => {
  it('AC1: an EMPTY ledger renders NO provenance stamp', async () => {
    renderWorkbench();

    await showTab('Results');

    // The screen is mounted and says there is nothing...
    expect(screen.getByText(EMPTY_TITLE)).toBeInTheDocument();
    // ...so nothing may claim a corpus version over it.
    expect(stamp()).toBeNull();
  });

  it('AC1: neither does a FIXTURE-ONLY ledger — Results renders it as empty', async () => {
    renderWorkbench({ ledger: fixtureOnlyLedger() });

    await showTab('Results');

    expect(screen.getByText(EMPTY_TITLE)).toBeInTheDocument();
    expect(stamp()).toBeNull();
  });

  it('AC2: with gate-passing runs present the stamp renders exactly as it does today', async () => {
    renderWorkbench({ ledger: seededLedger() });

    await showTab('Results');

    expect(screen.queryByText(EMPTY_TITLE)).not.toBeInTheDocument();
    expect(get('[data-provenance-run]')).toHaveTextContent(PROVENANCE);
  });

  it('AC1+AC2: one ledger, two states — the stamp follows the CONTENT, not the tab', async () => {
    const ledger = new RunLedger();
    renderWorkbench({ ledger });

    await showTab('Results');
    expect(stamp()).toBeNull();

    // Populate the very same ledger instance and come back.
    seedCleanSweep(ledger);
    await showTab('Live');
    await showTab('Results');

    expect(screen.queryByText(EMPTY_TITLE)).not.toBeInTheDocument();
    expect(get('[data-provenance-run]')).toHaveTextContent(PROVENANCE);
  });
});

/* ================================================= the other three views = */

describe('ticket 025 — the stamp stays Results-only (regression)', () => {
  it.each(['Live', 'Replay', 'Help'] as const)(
    'AC3: absent on %s with a ledger FULL of gate-passing runs',
    async (name) => {
      renderWorkbench({ ledger: seededLedger() });

      await showTab(name);
      expect(stamp(), `${name} is not a run`).toBeNull();

      // ...and it is genuinely available on Results with this same ledger.
      await showTab('Results');
      expect(stamp()).not.toBeNull();
    },
  );

  it.each(['Live', 'Replay', 'Help'] as const)(
    'AC3: absent on %s with an EMPTY ledger too',
    async (name) => {
      renderWorkbench();

      await showTab(name);
      expect(stamp()).toBeNull();
    },
  );
});

/* ==================================================== hydration in flight = */

describe('ticket 025 — hydration in flight asserts nothing', () => {
  /** A hydration source whose listings resolve only when told to. */
  function deferredHydration() {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const source: LedgerHydrationSource = {
      recordings: {
        list: async (): Promise<Recording[]> => {
          await gate;
          return [];
        },
      },
      runs: {
        list: async (): Promise<Run[]> => {
          await gate;
          return [];
        },
      },
    };
    return { source, release };
  }

  function panel(): HTMLElement {
    return get('[data-results-tab]');
  }

  it('AC4: while data-results-hydration="loading" there is no corpus-version claim', async () => {
    const { source, release } = deferredHydration();
    renderWorkbench({ hydrate: source });

    await showTab('Results');

    expect(panel().getAttribute('data-results-hydration')).toBe('loading');
    expect(stamp(), 'nothing is loaded yet — there is nothing to attribute').toBeNull();

    release();
    await waitFor(() => expect(panel().getAttribute('data-results-hydration')).toBe('ready'));
    // Nothing came back, so it is still empty — and still unstamped.
    expect(stamp()).toBeNull();
  });

  it('AC4+AC2: once hydration lands gate-passing runs, the stamp appears', async () => {
    const ledger = new RunLedger();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const source: LedgerHydrationSource = {
      recordings: {
        list: async (): Promise<Recording[]> => {
          await gate;
          return [];
        },
      },
      runs: {
        list: async (): Promise<Run[]> => {
          await gate;
          // The hydration seam writes into the SHARED ledger instance; this
          // stands in for the server having had the sweep all along.
          seedCleanSweep(ledger);
          return [];
        },
      },
    };
    renderWorkbench({ ledger, hydrate: source });

    await showTab('Results');
    expect(stamp()).toBeNull();

    release();
    await waitFor(() => expect(panel().getAttribute('data-results-hydration')).toBe('ready'));
    await waitFor(() => expect(stamp()).not.toBeNull());
    expect(get('[data-provenance-run]')).toHaveTextContent(PROVENANCE);
  });
});

/* ====================================================== hydration FAILED = */

/**
 * TICKET 029 (QA iteration 4) — a FAILED load has strictly LESS to attribute
 * than an empty one: it does not even know what it has.
 *
 * The observed bug: the client ledger persists to
 * localStorage["workbench.runLedger.v1"], so a reload against a stopped API
 * leaves it populated from the previous successful load while hydration
 * rejects. The stamp's gate reads ledger CONTENT only, so the top bar rendered
 * `run … · corpus v1` beside a body reading "The run store did not answer, so
 * this screen has nothing to show" — the screen asserting a run and denying it
 * has anything to show, at once.
 *
 * Ticket 025's rule is unchanged and extended, not replaced: THE STAMP APPEARS
 * EXACTLY WHEN RESULTS IS SHOWING RESULTS. The matrix below states all four
 * (ledger × hydration) states together so the gate cannot be fixed in one and
 * broken in another; three of the four are regression guards for 025 and pass
 * today.
 */
describe('ticket 029 — the stamp is gated on the LOAD as well as the ledger', () => {
  /** The panel's own copy for a failed load — asserted verbatim, unchanged. */
  const FAILED_TITLE = 'Could not read the run ledger';
  const FAILED_SUBLINE =
    'The run store did not answer, so this screen has nothing to show. That is not ' +
    'the same as an empty ledger: check that the server is reachable, then reopen ' +
    'this tab.';

  function panel(): HTMLElement {
    return get('[data-results-tab]');
  }

  /**
   * A run store that is unreachable until `heal()` — an API that was stopped
   * and later came back. It appends nothing: the ledger it is paired with
   * stands in for what localStorage already restored.
   */
  function flakyHydration(opts: { healthy: boolean }) {
    let healthy = opts.healthy;
    const answer = async <T,>(rows: T[]): Promise<T[]> => {
      if (!healthy) throw new ApiError('http-error', 500, 'HTTP 500');
      return rows;
    };
    const source: LedgerHydrationSource = {
      recordings: { list: () => answer<Recording>([]) },
      runs: { list: () => answer<Run>([]) },
    };
    return {
      source,
      heal: (): void => {
        healthy = true;
      },
    };
  }

  /**
   * App defers its content bump to a macrotask (see App.tsx), so absence must
   * be judged AFTER that lands — otherwise a stamp that is about to appear
   * reads as a stamp that never does.
   */
  async function settle(): Promise<void> {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }

  const MATRIX = [
    {
      label: 'empty ledger + ready — nothing recorded (025 guard)',
      populated: false,
      healthy: true,
      hydration: 'ready',
      stamped: false,
    },
    {
      label: 'populated ledger + ready — the one state that IS attributable (025 guard)',
      populated: true,
      healthy: true,
      hydration: 'ready',
      stamped: true,
    },
    {
      label: 'empty ledger + failed — nothing loaded, nothing cached (025 guard)',
      populated: false,
      healthy: false,
      hydration: 'failed',
      stamped: false,
    },
    {
      label: 'CACHED populated ledger + failed — the defect: no stamp over "nothing to show"',
      populated: true,
      healthy: false,
      hydration: 'failed',
      stamped: false,
    },
  ] as const;

  it.each(MATRIX)('AC1+AC2: $label', async ({ populated, healthy, hydration, stamped }) => {
    const ledger = populated ? seededLedger() : new RunLedger();
    renderWorkbench({ ledger, hydrate: flakyHydration({ healthy }).source });

    await showTab('Results');
    await waitFor(() =>
      expect(panel().getAttribute('data-results-hydration')).toBe(hydration),
    );
    await settle();

    if (stamped) {
      expect(get('[data-provenance-run]')).toHaveTextContent(PROVENANCE);
    } else {
      expect(stamp()).toBeNull();
    }
  });

  it('AC3: the failure body copy is untouched — failed still reads as failed, not empty', async () => {
    renderWorkbench({ ledger: seededLedger(), hydrate: flakyHydration({ healthy: false }).source });

    await showTab('Results');
    await waitFor(() => expect(panel().getAttribute('data-results-hydration')).toBe('failed'));

    expect(screen.getByText(FAILED_TITLE)).toBeInTheDocument();
    expect(screen.getByText(FAILED_SUBLINE)).toBeInTheDocument();
    expect(screen.queryByText(EMPTY_TITLE)).not.toBeInTheDocument();
  });

  it('AC4: a recovered load restores the stamp — reopening the tab, no page reload', async () => {
    const ledger = seededLedger();
    const { source, heal } = flakyHydration({ healthy: false });
    renderWorkbench({ ledger, hydrate: source });

    await showTab('Results');
    await waitFor(() => expect(panel().getAttribute('data-results-hydration')).toBe('failed'));
    await settle();
    expect(stamp()).toBeNull();

    // The failure copy tells the operator to "reopen this tab", and Results is
    // unmounted on leaving it — so coming back re-runs hydration in place.
    heal();
    await showTab('Live');
    await showTab('Results');

    await waitFor(() => expect(panel().getAttribute('data-results-hydration')).toBe('ready'));
    await waitFor(() => expect(stamp()).not.toBeNull());
    expect(get('[data-provenance-run]')).toHaveTextContent(PROVENANCE);
  });
});
