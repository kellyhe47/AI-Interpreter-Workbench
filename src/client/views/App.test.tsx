/**
 * Ticket 016 — the App shell that ties all four views together.
 *
 * Four tabs (Live · Replay · Results · Help) over ONE deps bag. Four rules run
 * through this suite:
 *
 *  1. EXACTLY ONE VIEW IS MOUNTED. Tabs are not panels; switching tab unmounts
 *     the view you left.
 *  2. THE LIVE INDICATOR REFLECTS SESSION STATE, NOT THE OPEN TAB. A session
 *     keeps running while you read Results, and the indicator has to say so —
 *     the pre-016 gate (`view === 'session' && …`) hid it the moment you
 *     navigated away, which is exactly what these tests forbid.
 *  3. ONE DEPS BAG. The ledger a Live session appends to IS the ledger Results
 *     reads: no reload, no remount, no second instance.
 *  4. APP SUPPLIES THE BLIND SEAMS. `rng`, `evaluatorLanguage` and
 *     `recordBlindComparison` are OPTIONAL on ReplayDeps, and a host that
 *     supplies none of them gets no blind-compare trigger at all — absent,
 *     not disabled. So the trigger is exercised through the REAL <App />,
 *     with a replay bag that deliberately omits all three.
 */

// Imported directly (in addition to vitest.setup.ts) so the jest-dom matcher
// type augmentation is visible to `tsc -p tsconfig.json`.
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import App, { type AppDeps } from '../App';
import { DEFAULT_CASCADE_TRIPLE, type ProviderTriple } from '../../core/arms';
import type { BatchHandle } from '../batch/runner';
import type { RecordingsClient, RunsClient } from '../replay/recordingsClient';
import type { RunOnceResult } from '../replay/runner';
import { RunLedger, type Recording, type Run } from '../state/ledger';
import { seedCleanSweep } from '../components/results/testRecords';
import type { ReplayDeps } from './ReplayView';
import {
  COPY,
  advance,
  cascadeUtteranceScript,
  clickStartMicrophone,
  deniedCard,
  liveDot,
  makeDenyingCapture,
  makeDeps,
  makeGrantingCapture,
  micIndicator,
  stateLabelEl,
  type TestDepsOptions,
} from './sessionTestKit';

afterEach(cleanup);

/* =============================================================== helpers == */

const q = (selector: string): HTMLElement | null => document.querySelector<HTMLElement>(selector);

function get(selector: string): HTMLElement {
  const found = q(selector);
  if (!found) throw new Error(`missing element: ${selector}`);
  return found;
}

/** deps.now pinned to 2026-08-05 UTC so the provenance date is deterministic. */
const NOW = Date.UTC(2026, 7, 5, 12, 0, 0);
const PROVENANCE = 'run 2026-08-05 · corpus v1';

/** The four tab names, in the order the top bar must render them. */
const TABS = ['Live', 'Replay', 'Results', 'Help'] as const;
type TabName = (typeof TABS)[number];

/** One probe per view — the marker that proves that view is MOUNTED. */
const PROBE: Record<TabName, string> = {
  Live: '[data-mic-indicator]',
  Replay: '[data-replay-view]',
  Results: '[data-results-tab]',
  Help: '[data-help-view]',
};

const tab = (name: TabName): HTMLElement => screen.getByRole('button', { name });

function clickTab(name: TabName): void {
  fireEvent.click(tab(name));
}

/** Clicks a tab and waits for its view to finish mounting (Replay is async). */
async function showTab(name: TabName): Promise<void> {
  clickTab(name);
  await waitFor(() => expect(q(PROBE[name])).not.toBeNull());
}

/* ====================================================== replay fixtures === */

/** 2026-02-03T09:41:00Z. */
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

const TIMINGS: Record<string, number | null> = {
  speech_end: T0,
  vad_fired: T0 + 500,
  stt_final: T0 + 542,
  mt_first_token: T0 + 840,
  tts_first_byte: T0 + 1_041,
  audio_queued: T0 + 1_053,
};

const SOURCE_TEXT = 'Where exactly does it hurt';

function completeRun(overrides: Partial<Run> & Pick<Run, 'id'>): Run {
  return {
    recordingId: REC.id,
    architecture: 'cascade',
    providerTriple: { ...DEFAULT_CASCADE_TRIPLE },
    modelSnapshots: { ...DEFAULT_CASCADE_TRIPLE },
    armTag: 'B',
    origin: 'sweep',
    status: 'complete',
    timings: { ...TIMINGS },
    transcripts: { source: SOURCE_TEXT, target: 'target-text-placeholder' },
    outputAudioPath: `runs/${overrides.id}.out.wav`,
    cost: 0.021,
    errors: [],
    createdAt: T0 + 60_000,
    ...overrides,
  };
}

const RUN_B: Run = completeRun({
  id: 'run-b',
  transcripts: { source: SOURCE_TEXT, target: 'Donde le duele exactamente' },
});

const RUN_C: Run = completeRun({
  id: 'run-c',
  providerTriple: { ...ARM_C_TRIPLE },
  modelSnapshots: { ...ARM_C_TRIPLE },
  armTag: 'C',
  transcripts: { source: SOURCE_TEXT, target: 'En que parte siente el dolor' },
});

/**
 * A Replay deps bag that supplies EVERY REQUIRED seam and NONE of the three
 * optional blind ones. If App forwards this bag untouched there is no blind
 * trigger anywhere — which is the failure this suite exists to catch.
 */
function makeReplayDeps(options: { recordings?: Recording[]; runs?: Run[] } = {}) {
  const store = {
    recordings: (options.recordings ?? [REC]).map((r) => ({ ...r })),
    runs: (options.runs ?? [RUN_B, RUN_C]).map((r) => ({ ...r })),
  };

  const recordings = {
    list: vi.fn(async () => store.recordings.map((r) => ({ ...r }))),
    get: vi.fn(async (id: string) => ({ ...store.recordings.find((r) => r.id === id)! })),
    getAudio: vi.fn(async () => new Uint8Array()),
    create: vi.fn(async () => ({ ...REC })),
    patchLabel: vi.fn(async (id: string) => ({ ...store.recordings.find((r) => r.id === id)! })),
    remove: vi.fn(async (id: string) => ({ ...store.recordings.find((r) => r.id === id)! })),
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

  const playRun = vi.fn();
  let ids = 0;

  const deps: ReplayDeps = {
    recordings: recordings as unknown as RecordingsClient,
    runs: runs as unknown as RunsClient,
    runOnce: vi.fn(async () => ({}) as RunOnceResult) as unknown as ReplayDeps['runOnce'],
    startBatch: vi.fn(() => ({}) as BatchHandle) as unknown as ReplayDeps['startBatch'],
    playRun,
    now: () => T0 + 900_000,
    newId: () => `blind-${++ids}`,
    // rng / evaluatorLanguage / recordBlindComparison DELIBERATELY ABSENT.
  };

  return { deps, playRun };
}

/* ============================================================= rendering == */

interface WorkbenchOptions extends TestDepsOptions {
  replay?: ReplayDeps;
}

function renderWorkbench(opts: WorkbenchOptions = {}) {
  const { replay, ...sessionOpts } = opts;
  const kit = makeDeps(sessionOpts);
  const deps: AppDeps = { ...kit.deps, ...(replay ? { replay } : {}) };
  const view = render(<App deps={deps} />);
  return { ...kit, view };
}

/** The common case: a pinned clock and a fully-wired Replay bag. */
function renderPinnedWorkbench(opts: WorkbenchOptions = {}) {
  return renderWorkbench({ now: () => NOW, replay: makeReplayDeps().deps, ...opts });
}

/* ============================================================ the tabs ==== */

describe('TopBar — four tabs', () => {
  it('renders exactly four tabs, in order: Live, Replay, Results, Help', () => {
    renderPinnedWorkbench();

    const buttons = TABS.map((name) => tab(name));
    const group = buttons[0]!.parentElement;
    expect(group).not.toBeNull();
    for (const button of buttons) expect(button.parentElement).toBe(group);
    expect(Array.from(group!.children)).toHaveLength(4);
    expect(Array.from(group!.children).map((child) => child.textContent?.trim())).toEqual([
      ...TABS,
    ]);
  });

  it('defaults to the Live view on load', () => {
    renderPinnedWorkbench();

    expect(tab('Live')).toHaveAttribute('aria-pressed', 'true');
    for (const name of ['Replay', 'Results', 'Help'] as const) {
      expect(tab(name)).toHaveAttribute('aria-pressed', 'false');
    }
    expect(q(PROBE.Live)).not.toBeNull();
    expect(screen.getByText(COPY.idleTitle)).toBeInTheDocument();
  });

  it.each(TABS)('the %s tab mounts its view and unmounts every other view', async (name) => {
    renderPinnedWorkbench();
    await showTab(name);

    expect(tab(name)).toHaveAttribute('aria-pressed', 'true');
    for (const other of TABS) {
      if (other === name) continue;
      expect(q(PROBE[other]), `${other} must be unmounted while on ${name}`).toBeNull();
      expect(tab(other)).toHaveAttribute('aria-pressed', 'false');
    }
  });

  it('the top bar is 52px and sticky', () => {
    renderPinnedWorkbench();
    const bar = get('[data-topbar]');
    expect(bar).toHaveStyle({ height: '52px', position: 'sticky' });
  });

  it('run-provenance mono text renders on Results and nowhere else', async () => {
    // TICKET 025 — the stamp attributes RESULTS, so the Results half of this
    // test needs something attributable in the ledger. The claim under test is
    // TAB SCOPING ('and nowhere else'); the empty ledger this used to render
    // with was incidental to renderPinnedWorkbench(), not a statement that
    // provenance may attach to nothing. Cf. App.tsx:20-22 — a live session is
    // not a run, and a Results view with zero runs is the same category error.
    // The empty-ledger counterpart is asserted in App.provenance.test.tsx.
    const ledger = new RunLedger();
    seedCleanSweep(ledger);
    renderPinnedWorkbench({ ledger });

    expect(q('[data-provenance-run]')).toBeNull();
    await showTab('Replay');
    expect(q('[data-provenance-run]')).toBeNull();
    await showTab('Help');
    expect(q('[data-provenance-run]')).toBeNull();

    await showTab('Results');
    expect(get('[data-provenance-run]')).toHaveTextContent(PROVENANCE);

    await showTab('Live');
    expect(q('[data-provenance-run]')).toBeNull();
  });
});

/* ================================================ the live-session dot ==== */

describe('the live-session indicator reflects SESSION state, not the open tab', () => {
  it('is absent on every tab while no session is running', async () => {
    renderPinnedWorkbench();
    for (const name of TABS) {
      await showTab(name);
      expect(liveDot(), `no session, but the dot showed on ${name}`).toBeNull();
    }
  });

  it('PERSISTS while the user reads Replay, Results and Help mid-session', async () => {
    renderPinnedWorkbench();
    await clickStartMicrophone();
    expect(liveDot()).not.toBeNull();

    for (const name of ['Replay', 'Results', 'Help'] as const) {
      await showTab(name);
      expect(
        liveDot(),
        `the session is still running, but the dot vanished on ${name}`,
      ).not.toBeNull();
    }

    await showTab('Live');
    expect(liveDot()).not.toBeNull();
  });
});

/* ============================================ session state survives tabs = */

describe('session state survives tab switches', () => {
  it('Live → Results → Live does not reset the machine or re-request the mic', async () => {
    const capture = makeGrantingCapture();
    renderPinnedWorkbench({ capture: capture.fn });

    await clickStartMicrophone();
    expect(stateLabelEl()).toHaveTextContent('listening');
    expect(screen.getByRole('button', { name: 'Stop session' })).toBeInTheDocument();

    await showTab('Results');
    await showTab('Live');

    expect(stateLabelEl()).toHaveTextContent('listening');
    expect(micIndicator()).toHaveAttribute('data-mic-indicator', 'granted');
    expect(screen.getByRole('button', { name: 'Stop session' })).toBeInTheDocument();
    expect(screen.queryByText(COPY.idleTitle)).not.toBeInTheDocument();
    // A remount would have asked for the microphone a second time.
    expect(capture.fn).toHaveBeenCalledTimes(1);
  });
});

/* =========================================== the mic card blocks LIVE only = */

describe('permission-denied blocks the Live session, not the app', () => {
  it('Replay, Results and Help stay usable while Live is denied', async () => {
    renderPinnedWorkbench({ capture: makeDenyingCapture() });
    await clickStartMicrophone();
    expect(deniedCard()).not.toBeNull();

    await showTab('Replay');
    expect(deniedCard()).toBeNull();
    expect(q('[data-recordings-library]')).not.toBeNull();

    await showTab('Results');
    expect(screen.getByText('No runs recorded')).toBeInTheDocument();

    await showTab('Help');
    expect(q('[data-help-view]')).not.toBeNull();

    // ...and the blocking card is still there when you come back.
    await showTab('Live');
    expect(deniedCard()).not.toBeNull();
  });
});

/* ================================================== ONE shared deps bag === */

describe('all four views share ONE deps bag', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it("a Live session's appended records are on Results immediately — no reload", async () => {
    let t = 0;
    const kit = renderWorkbench({
      now: () => t,
      initialState: { mode: 'cascade' },
      scripts: {
        cascade: [
          ...cascadeUtteranceScript({ utt: 0, base: 0 }),
          ...cascadeUtteranceScript({ utt: 1, base: 2000 }),
        ],
      },
      replay: makeReplayDeps().deps,
    });

    await clickStartMicrophone();
    await advance(3400);
    t = 242_000;
    fireEvent.click(screen.getByRole('button', { name: 'Stop session' }));
    await advance(100);

    // The session wrote into the bag's ledger...
    expect(kit.ledger.getRecords()).toHaveLength(2);
    expect(kit.ledger.getLiveSessions()).toHaveLength(1);

    // ...and Results reads that very instance, with no remount in between.
    clickTab('Results');
    expect(q('[data-results-tab]')).not.toBeNull();
    expect(screen.queryByText('No runs recorded')).not.toBeInTheDocument();
    expect(q('[data-card="live"]')).not.toBeNull();
  });
});

/* ================================== App supplies the blind-compare seams == */

describe('App supplies rng, evaluatorLanguage and recordBlindComparison', () => {
  const OPEN_BLIND = 'compare blind (pick 2 runs)';

  /** Navigates to Replay and selects the seeded Recording. */
  async function showReplayWithRuns(): Promise<void> {
    await showTab('Replay');
    await waitFor(() =>
      expect(q(`[data-recording-row][data-recording="${REC.id}"]`)).not.toBeNull(),
    );
    fireEvent.click(get(`[data-recording-row][data-recording="${REC.id}"]`));
    await waitFor(() => expect(q('[data-runs-list]')).not.toBeNull());
  }

  function sample(key: 'A' | 'B'): HTMLElement {
    return get(`[data-blind-sample="${key}"]`);
  }

  function score(key: 'A' | 'B', dimension: 'adequacy' | 'fluency', n: number): void {
    const cell = sample(key).querySelector<HTMLElement>(`[data-blind-dimension="${dimension}"]`);
    if (!cell) throw new Error(`missing dimension ${dimension} on sample ${key}`);
    fireEvent.click(within(cell).getByRole('button', { name: String(n) }));
  }

  /** The run id behind a sample, observed the only blinded way: by playing it. */
  function playedRunId(playRun: ReturnType<typeof vi.fn>, key: 'A' | 'B'): string {
    playRun.mockClear();
    fireEvent.click(within(sample(key)).getByRole('button', { name: 'play' }));
    expect(playRun).toHaveBeenCalledTimes(1);
    return playRun.mock.calls[0]![0] as string;
  }

  it('the blind trigger is REACHABLE through the real <App /> on two completed runs', async () => {
    const replay = makeReplayDeps();
    // The host handed over none of the three optional seams...
    expect(replay.deps.rng).toBeUndefined();
    expect(replay.deps.evaluatorLanguage).toBeUndefined();
    expect(replay.deps.recordBlindComparison).toBeUndefined();

    renderWorkbench({ now: () => NOW, replay: replay.deps });
    await showReplayWithRuns();

    // ...so if App forwarded the bag untouched, this trigger would not exist.
    expect(screen.getByRole('button', { name: OPEN_BLIND })).toBeInTheDocument();
  });

  it('a submitted comparison is PERSISTED: draw, both dimensions, run ids, language', async () => {
    const replay = makeReplayDeps();
    const kit = renderWorkbench({ now: () => NOW, replay: replay.deps });
    await showReplayWithRuns();

    fireEvent.click(screen.getByRole('button', { name: OPEN_BLIND }));
    expect(q('[data-blind-card]')).not.toBeNull();

    // The DRAWN order, read the blinded way — whichever run each slot plays.
    const drawn: [string, string] = [
      playedRunId(replay.playRun, 'A'),
      playedRunId(replay.playRun, 'B'),
    ];
    expect(new Set(drawn)).toEqual(new Set([RUN_B.id, RUN_C.id]));

    score('A', 'adequacy', 4);
    score('A', 'fluency', 3);
    score('B', 'adequacy', 2);
    score('B', 'fluency', 5);
    fireEvent.click(screen.getByRole('button', { name: 'submit ratings' }));

    const comparisons = kit.ledger.getBlindComparisons();
    expect(comparisons).toHaveLength(1);
    const comparison = comparisons[0]!;

    expect(comparison.recordingId).toBe(REC.id);
    expect([...comparison.runIds].sort()).toEqual([RUN_B.id, RUN_C.id]);
    expect(comparison.order).toEqual(drawn);
    expect(comparison.scores).toEqual({
      A: { adequacy: 4, fluency: 3 },
      B: { adequacy: 2, fluency: 5 },
    });
    // App has to have chosen SOME evaluator language — a blank one is not one.
    expect(typeof comparison.evaluatorLanguage).toBe('string');
    expect(comparison.evaluatorLanguage.length).toBeGreaterThan(0);
  });
});

/* ====== TICKET 066 — the Recording selection survives a tab round-trip ==== */

/**
 * TICKET 066 — `ReplayView.tsx:379` holds the selected Recording in a plain
 * `useState<string | null>(null)`, and App mounts EXACTLY ONE VIEW: switching
 * tab unmounts the one you left. So `Replay → Results → Replay` drops the
 * selection to null, the Runs panel renders "No Runs of this Recording yet." —
 * and the sidebar row still reads "2 runs", because `runCounts` is built from
 * the full `runs` array and never mentions the selection. The library says the
 * Recording has runs; the panel says it has none.
 *
 * THE ROUND TRIP IS DRIVEN THROUGH THE REAL VIEW SWITCHER, inside ONE
 * `render(<App/>)` — never by re-rendering ReplayView with a prop, and never by
 * a second `render`. RTL appends to `document.body` and these accessors are
 * global `document.querySelector`, so a second mount would leave the "it
 * survived" assertion reading the FIRST mount's DOM.
 *
 * `makeReplayDeps()` DELIBERATELY supplies no persistence seam. App is the host
 * that fills one in — the same rule it already follows for `rng`,
 * `evaluatorLanguage` and `recordBlindComparison` — so a fix that makes the
 * seam a required host responsibility leaves the feature dead in the product's
 * own shell, and these tests say so.
 */
describe('TICKET 066 — Replay keeps its selection across a tab change', () => {
  const NO_SELECTION_HINT = 'Select a Recording in the library to run against';
  const RUNS_EMPTY = 'No Runs of this Recording yet.';

  const text = (element: Element | null): string => (element?.textContent ?? '').trim();

  const replayRow = (): HTMLElement =>
    get(`[data-recording-row][data-recording="${REC.id}"]`);

  const runCardIds = (): string[] =>
    Array.from(document.querySelectorAll<HTMLElement>('[data-run-card]'))
      .map((card) => card.getAttribute('data-run') ?? '')
      .sort();

  /** Opens Replay and selects the seeded Recording, with its two runs listed. */
  async function selectOnReplay(): Promise<void> {
    await showTab('Replay');
    await waitFor(() =>
      expect(q(`[data-recording-row][data-recording="${REC.id}"]`)).not.toBeNull(),
    );
    fireEvent.click(replayRow());
    await waitFor(() => {
      expect(replayRow()).toHaveAttribute('data-selected', 'true');
      expect(runCardIds()).toEqual([RUN_B.id, RUN_C.id].sort());
    });
  }

  it('nothing is selected before the operator picks a clip', async () => {
    // The control for the two below: a fix that simply marks the first row
    // selected on mount would satisfy them and break this.
    renderPinnedWorkbench();
    await showTab('Replay');
    await waitFor(() => expect(q('[data-recordings-library]')).not.toBeNull());

    expect(document.querySelectorAll('[data-recording-row][data-selected="true"]')).toHaveLength(0);
    expect(get('[data-run-button]')).toBeDisabled();
    expect(get('[data-batch-button]')).toBeDisabled();
  });

  it.each(['Results', 'Help', 'Live'] as const)(
    'Replay → %s → Replay keeps the row selected, the runs listed and the count agreeing',
    async (away) => {
      renderPinnedWorkbench();
      await selectOnReplay();
      const before = runCardIds();
      expect(before).toEqual([RUN_B.id, RUN_C.id].sort());

      await showTab(away);
      await showTab('Replay');

      // Row marker, run cards and sidebar count in ONE assertion: the defect is
      // that these can disagree, so a race that satisfies them one at a time
      // must not pass. The run IDS are pinned, not just the count — a refetch
      // that landed late would otherwise look like a restored selection.
      await waitFor(() => {
        const element = replayRow();
        expect(element).toHaveAttribute('data-selected', 'true');
        expect(runCardIds()).toEqual(before);
        expect(text(element.querySelector('[data-recording-run-count]'))).toContain('2');
      });
      // The screen must not contradict itself in the other direction either.
      expect(screen.queryByText(RUNS_EMPTY)).toBeNull();
    },
  );

  it('after the round trip Run and Batch sweep are enabled, with no no-selection hint', async () => {
    renderPinnedWorkbench();
    await selectOnReplay();
    expect(get('[data-run-button]')).not.toBeDisabled();

    await showTab('Results');
    await showTab('Replay');

    await waitFor(() => expect(replayRow()).toHaveAttribute('data-selected', 'true'));
    for (const selector of ['[data-run-button]', '[data-batch-button]']) {
      expect(get(selector), selector).not.toBeDisabled();
      // A control disabled for a reason that is no longer true is the same
      // contradiction wearing a tooltip (tickets 024, 044).
      expect(get(selector), selector).not.toHaveAttribute('title', NO_SELECTION_HINT);
    }
  });

  it('the target-language control comes back with the clip it belongs to', async () => {
    // Ticket 061's control is a property of the SELECTED clip, so its absence
    // after the round trip is the same lost selection said a fourth way.
    renderPinnedWorkbench();
    await selectOnReplay();
    expect(q('[data-target-language]')).not.toBeNull();

    await showTab('Results');
    await showTab('Replay');

    await waitFor(() => expect(q('[data-target-language]')).not.toBeNull());
  });
});
