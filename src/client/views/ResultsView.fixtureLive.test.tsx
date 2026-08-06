/**
 * TICKET 018 — Results never reports a fixture LiveSession as a measurement.
 *
 * QA F1 repro: `/?fixture=1` → Live → Start microphone → ~20 utterances →
 * Stop session → Results. The conversation-length card left its empty state
 * and rendered 20 utterances completed, 0 disconnects, p50 0.98 s, p95 0.98 s,
 * with no illustrative badge. Results-panel digit count went 0 → 29.
 *
 * The load-bearing assertion is the digit count, and it deliberately reuses
 * the pattern the locked empty-state block already uses
 * (ResultsView.test.tsx: "contains NOT ONE DIGIT anywhere"), so the two agree
 * about what "nothing recorded" looks like.
 *
 * ADDITIVE to the locked ResultsView.test.tsx.
 */

// Imported directly (in addition to vitest.setup.ts) so the jest-dom matcher
// type augmentation is visible to `tsc -p tsconfig.json`.
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_CASCADE_TRIPLE, type ProviderTriple } from '../../core/arms';
import App from '../App';
import { buildFixtureDeps } from '../fixtureDeps';
import { deriveLiveModel } from '../components/results/derive';
import {
  makeLiveSessionEntity,
  seedComparisonSweep,
  seedLiveSessions,
} from '../components/results/testRecords';
import { RunLedger, type LiveSession } from '../state/ledger';
import { advance, clickStartMicrophone } from './sessionTestKit';
import ResultsView from './ResultsView';

afterEach(cleanup);

const FIXTURE_TRIPLE: ProviderTriple = { stt: 'fixture', mt: 'fixture', tts: 'fixture' };

const EMPTY_TITLE = 'No runs recorded';
const LIVE_EMPTY = 'no live sessions recorded';

/** The exact figures QA saw rendered. None of them may reach the DOM. */
const FIXTURE_UTTERANCES_COMPLETED = 20;
const FIXTURE_CONSTANT_LATENCY_MS = 980;

function fixtureLiveSession(overrides: Partial<LiveSession> = {}): LiveSession {
  return makeLiveSessionEntity({
    id: 'live-fixture-1',
    providerTriple: { ...FIXTURE_TRIPLE },
    modelSnapshots: { ...FIXTURE_TRIPLE },
    utterances: Array.from({ length: FIXTURE_UTTERANCES_COMPLETED }, (_, i) => ({
      id: `lu-${i + 1}`,
      timings: { speech_end: 0, audio_queued: FIXTURE_CONSTANT_LATENCY_MS },
      costUsd: 0.001,
    })),
    latency: {
      p50: FIXTURE_CONSTANT_LATENCY_MS,
      p95: FIXTURE_CONSTANT_LATENCY_MS,
      driftMinute1ToEnd: 0,
    },
    cost: { totalUsd: 0.02, perMinuteMinute1: 0.004, perMinuteFinalMinute: 0.004 },
    stability: {
      utterancesCompleted: FIXTURE_UTTERANCES_COMPLETED,
      disconnects: 0,
      heapStart: null,
      heapEnd: null,
    },
    ...overrides,
  });
}

function panel(): HTMLElement {
  const found = document.querySelector<HTMLElement>('[data-results-tab]');
  if (!found) throw new Error('missing results panel');
  return found;
}

function showSecondaryTab(): void {
  fireEvent.click(screen.getByRole('tab', { name: 'By Recording & category' }));
}

/* ================================ a fixture-only ledger IS an empty ledger = */

describe('ticket 018 — a fixture-only LiveSession ledger renders the empty state', () => {
  function fixtureOnlyLedger(): RunLedger {
    const ledger = new RunLedger();
    ledger.appendLiveSession(fixtureLiveSession());
    return ledger;
  }

  it('renders "No runs recorded", exactly as an untouched ledger does', () => {
    render(<ResultsView ledger={fixtureOnlyLedger()} />);
    expect(screen.getByText(EMPTY_TITLE)).toBeInTheDocument();
  });

  it('CONTAINS NOT ONE DIGIT on either tab — the empty-state assertion, unchanged', () => {
    const { container } = render(<ResultsView ledger={fixtureOnlyLedger()} />);
    expect(container.textContent ?? '').not.toMatch(/\d/);
    showSecondaryTab();
    expect(container.textContent ?? '').not.toMatch(/\d/);
  });

  it('renders no metric grid, no provenance line and no card', () => {
    render(<ResultsView ledger={fixtureOnlyLedger()} />);
    for (const selector of ['[data-metric]', '[data-provenance]', '[data-card]']) {
      expect(document.querySelectorAll(selector)).toHaveLength(0);
    }
  });

  it('renders IDENTICALLY to an empty ledger, byte for byte', () => {
    const empty = render(<ResultsView ledger={new RunLedger()} />);
    const fixture = render(<ResultsView ledger={fixtureOnlyLedger()} />);
    expect(fixture.container.innerHTML).toBe(empty.container.innerHTML);
  });

  it('the underlying derivation agrees: LiveModel.empty is true', () => {
    expect(deriveLiveModel(fixtureOnlyLedger()).empty).toBe(true);
  });
});

/* ================== a fixture session beside real Runs: the card is empty == */

describe('ticket 018 — with real Runs present, the live card renders its OWN empty note', () => {
  function ledgerWithRunsAndFixtureLive(): RunLedger {
    const ledger = new RunLedger();
    seedComparisonSweep(ledger); // real sweep Runs → the view is not empty
    ledger.appendLiveSession(fixtureLiveSession());
    return ledger;
  }

  it('shows "no live sessions recorded" and no live metric rows', () => {
    render(<ResultsView ledger={ledgerWithRunsAndFixtureLive()} />);
    const card = document.querySelector('[data-card="live"]');
    expect(card).not.toBeNull();
    const empty = card!.querySelector('[data-empty-card="live"]');
    expect(empty).not.toBeNull();
    expect((empty!.textContent ?? '').trim()).toBe(LIVE_EMPTY);
    expect(card!.querySelectorAll('[data-metric]')).toHaveLength(0);
    expect(card!.querySelector('[data-provenance="live"]')).toBeNull();
  });

  it('none of the fixture figures appear anywhere on the Experiments panel', () => {
    render(<ResultsView ledger={ledgerWithRunsAndFixtureLive()} />);

    // Scoped to the live card, because that is the only place a fixture
    // LiveSession can surface — and an excluded one leaves it digit-free.
    // A panel-wide digit check would be wrong here: the REAL gate-passing
    // sweep runs legitimately render figures like '$0.020', and '20' inside
    // Arm B's genuine cost is arithmetic, not a fixture fingerprint.
    const card = document.querySelector('[data-card="live"]')!;
    expect(card.textContent ?? '').not.toMatch(/\d/);
    // The provenance phrasing QA saw: '1 sessions · 20 utterances completed'.
    expect(card.textContent ?? '').not.toContain(
      `${FIXTURE_UTTERANCES_COMPLETED} utterances`,
    );

    // 0.98 s — the constant-delay signature QA saw as both p50 and p95. This
    // one is a real fingerprint, so it stays scoped to the whole panel.
    expect(panel().textContent ?? '').not.toContain('0.98 s');
  });
});

/* ======================== regression guard: real sessions still render ==== */

describe('ticket 018 — regression guard: a REAL LiveSession still fills the card', () => {
  function realLiveLedger(): RunLedger {
    const ledger = new RunLedger();
    seedLiveSessions(ledger);
    return ledger;
  }

  function liveCell(metric: string, column: string): string {
    const found = document.querySelector(
      `[data-card="live"] [data-metric="${metric}"] [data-live-column="${column}"]`,
    );
    if (!found) throw new Error(`missing live cell: ${metric}/${column}`);
    return (found.textContent ?? '').trim();
  }

  it('fills realtime-default and cascade from deriveLiveModel', () => {
    const ledger = realLiveLedger();
    const model = deriveLiveModel(ledger);
    const armA = model.columns.find((c) => c.arm === 'A')!;
    const armB = model.columns.find((c) => c.arm === 'B')!;
    render(<ResultsView ledger={ledger} />);

    expect(document.querySelector('[data-empty-card="live"]')).toBeNull();
    expect(liveCell('utterances', 'realtime-default')).toBe(String(armA.utterancesCompleted));
    expect(liveCell('disconnects', 'realtime-default')).toBe(String(armA.disconnects));
    expect(liveCell('utterances', 'cascade')).toBe(String(armB.utterancesCompleted));
    expect(panel().textContent ?? '').toMatch(/\d/);
  });

  it('a fixture session appended alongside does not change a single rendered cell', () => {
    const before = render(<ResultsView ledger={realLiveLedger()} />).container.innerHTML;

    const mixed = realLiveLedger();
    mixed.appendLiveSession(
      fixtureLiveSession({
        // Same derived arm as the real cascade session — a leak would pool.
        providerTriple: { ...DEFAULT_CASCADE_TRIPLE, tts: 'fixture' },
        modelSnapshots: { ...DEFAULT_CASCADE_TRIPLE, tts: 'fixture' },
      }),
    );
    const after = render(<ResultsView ledger={mixed} />).container.innerHTML;

    expect(after).toBe(before);
  });
});

/* ============================ the QA repro, through the real fixture path == */

describe('ticket 018 — the F1 repro: a `?fixture=1` Live session leaves Results empty', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it('after a full fixture Live session, the Results panel contains NOT ONE DIGIT', async () => {
    const deps = buildFixtureDeps({
      now: () => 0,
      utterancesPerLoop: 2,
      utteranceSpacingMs: 1_500,
    });
    render(<App deps={deps} />);

    await clickStartMicrophone();
    await advance(6_000);
    fireEvent.click(screen.getByRole('button', { name: 'Stop session' }));
    await advance(100);

    // Precondition: the session really did run and really was persisted —
    // otherwise the digit assertion below would pass for the wrong reason.
    const sessions = deps.ledger.getLiveSessions();
    expect(sessions).toHaveLength(1);
    expect(sessions[0]!.stability.utterancesCompleted).toBeGreaterThan(0);

    fireEvent.click(screen.getByRole('button', { name: 'Results' }));

    // Scoped to the results PANEL: the top bar's run-provenance stamp lives
    // outside it and carries a date (QA F8, a separate finding).
    expect(panel().textContent ?? '').not.toMatch(/\d/);
    expect(screen.getByText(EMPTY_TITLE)).toBeInTheDocument();
    expect(document.querySelector('[data-card="live"]')).toBeNull();
  });
});
