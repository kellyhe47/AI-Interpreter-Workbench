/**
 * Ticket 013 — RTL tests for <ResultsView />.
 * Locks the DOM contract documented in ResultsView.tsx. All figures must be
 * derived from the ledger; no sample figure may ever reach the DOM.
 */

// Imported directly (in addition to vitest.setup.ts) so the jest-dom matcher
// type augmentation is visible to `tsc -p tsconfig.json`, whose include does
// not cover the setup file.
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { RunLedger } from '../state/ledger';
import {
  deriveResultsModel,
  formatMs,
} from '../components/results/derive';
import {
  BENCHMARK_RUN_ID,
  STABILITY_RUN_ID,
  SWAP_RUN_ID,
  seedBenchmarkRun,
  seedCoverageRun,
  seedFixtureRun,
  seedProviderSwapRun,
  seedStabilityRun,
} from '../components/results/testRecords';
import ResultsView from './ResultsView';

afterEach(cleanup);

const QUESTION_TITLES = [
  'Does the architecture itself cost latency?',
  'What does swapping providers buy?',
  'What changes as the conversation continues?',
  'What does provider choice actually let us reach?',
] as const;

// Two figures lifted from the design-handoff mock. They must NEVER appear:
// result cards never show sample data as evidence.
const MOCK_FIGURES = [/\$0\.140/, /\$0\.021/] as const;

function renderView(ledger: RunLedger) {
  return render(<ResultsView ledger={ledger} />);
}

describe('ResultsView — header (always rendered)', () => {
  it('shows the title and the provenance subline', () => {
    renderView(new RunLedger());
    expect(screen.getByText('Results')).toBeInTheDocument();
    expect(
      screen.getByText(
        'Four questions, one run ledger. Every figure carries its provenance; nothing here comes from a fixture run.',
      ),
    ).toBeInTheDocument();
  });

  it('has no "show recorded runs" switch — visibility derives from the ledger', () => {
    renderView(new RunLedger());
    expect(screen.queryByRole('switch')).not.toBeInTheDocument();
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
    expect(screen.queryByText(/show recorded runs/i)).not.toBeInTheDocument();
  });
});

describe('ResultsView — empty state (default: no runs recorded)', () => {
  function renderEmpty() {
    return renderView(new RunLedger());
  }

  it('renders the empty card copy exactly', () => {
    renderEmpty();
    expect(screen.getByText('No runs recorded')).toBeInTheDocument();
    expect(
      screen.getByText(
        'Run a benchmark sweep to populate experiment 1. Result cards never show sample data as evidence.',
      ),
    ).toBeInTheDocument();
  });

  it('renders a disabled Run sweep button explaining that sweeps need the real corpus', () => {
    renderEmpty();
    const button = screen.getByRole('button', { name: /run sweep/i });
    expect(button).toBeDisabled();
    const explanation =
      button.getAttribute('title') ?? button.getAttribute('aria-label') ?? '';
    expect(explanation).toMatch(/real corpus/i);
  });

  it('renders NONE of the four question cards', () => {
    renderEmpty();
    for (const title of QUESTION_TITLES) {
      expect(screen.queryByText(title)).not.toBeInTheDocument();
    }
  });

  it('does not render the run ledger table', () => {
    renderEmpty();
    expect(screen.queryByText('Run ledger')).not.toBeInTheDocument();
    expect(document.querySelectorAll('[data-run-row]')).toHaveLength(0);
  });

  it('contains no sample figures anywhere', () => {
    const { container } = renderEmpty();
    const text = container.textContent ?? '';
    for (const figure of MOCK_FIGURES) {
      expect(text).not.toMatch(figure);
    }
    expect(text).not.toContain('1.02');
  });
});

describe('ResultsView — fixture/placeholder-only ledger behaves as empty', () => {
  it('shows the empty state and no cards, figures, or ledger rows', () => {
    const ledger = new RunLedger();
    seedFixtureRun(ledger);
    const { container } = renderView(ledger);
    expect(screen.getByText('No runs recorded')).toBeInTheDocument();
    for (const title of QUESTION_TITLES) {
      expect(screen.queryByText(title)).not.toBeInTheDocument();
    }
    expect(document.querySelectorAll('[data-run-row]')).toHaveLength(0);
    const text = container.textContent ?? '';
    expect(text).not.toContain('1.02');
    for (const figure of MOCK_FIGURES) {
      expect(text).not.toMatch(figure);
    }
  });
});

describe('ResultsView — with a real benchmark run', () => {
  function renderBenchmark() {
    const ledger = new RunLedger();
    seedBenchmarkRun(ledger);
    return { ledger, ...renderView(ledger) };
  }

  it('drops the empty state and renders all four question cards with their eyebrows', () => {
    renderBenchmark();
    expect(screen.queryByText('No runs recorded')).not.toBeInTheDocument();
    for (const title of QUESTION_TITLES) {
      expect(screen.getByText(title)).toBeInTheDocument();
    }
    expect(
      screen.getByText('Track 1 of 3 · vendor held constant'),
    ).toBeInTheDocument();
    expect(
      screen.getByText('Track 2 of 3 · architecture held constant'),
    ).toBeInTheDocument();
    expect(screen.getByText('Track 1 · extended along time')).toBeInTheDocument();
    expect(
      screen.getByText('Track 3 of 3 · exploratory case study'),
    ).toBeInTheDocument();
  });

  it('renders the p50 cell with the exact aggregates-derived value', () => {
    const { ledger } = renderBenchmark();
    const expected = formatMs(
      ledger.aggregates(BENCHMARK_RUN_ID).perArm['realtime']!.p50Ms,
    );
    expect(expected).toBe('1.02 s'); // sanity: derive fn and DOM agree
    const p50Row = document.querySelector('[data-metric="p50"]');
    expect(p50Row).not.toBeNull();
    expect(p50Row!.textContent).toContain(expected);
    expect(p50Row!.textContent).toContain('0.78 s'); // cascade column
  });

  it('renders the exp1 provenance line from the run config', () => {
    renderBenchmark();
    const provenance = document.querySelector('[data-provenance="exp1"]');
    expect(provenance).not.toBeNull();
    const text = provenance!.textContent ?? '';
    expect(text).toContain('endpointing pinned 500 ms');
    expect(text).toContain('corpus-es-en-v1');
    expect(text).toContain('2 utterances');
    expect(text).toContain(`run ${BENCHMARK_RUN_ID}`);
  });

  it('marks the p50 delta cell good (green) when cascade is faster', () => {
    renderBenchmark();
    const delta = document.querySelector('[data-metric="p50"] [data-tone]');
    expect(delta).not.toBeNull();
    expect(delta!.getAttribute('data-tone')).toBe('good');
  });

  it('marks the cost delta cell good when the cost delta is negative', () => {
    renderBenchmark();
    const delta = document.querySelector('[data-metric="cost"] [data-tone]');
    expect(delta).not.toBeNull();
    expect(delta!.getAttribute('data-tone')).toBe('good');
  });

  it('renders — for wer, adequacy and fluency when absent from records', () => {
    renderBenchmark();
    for (const metric of ['wer', 'adequacy', 'fluency']) {
      const row = document.querySelector(`[data-metric="${metric}"]`);
      expect(row).not.toBeNull();
      expect(row!.textContent).toContain('—');
    }
  });

  it('shows the per-card empty notes for tracks 2–3 and coverage', () => {
    renderBenchmark();
    expect(
      screen.getByText('no provider-swap runs recorded'),
    ).toBeInTheDocument();
    expect(screen.getByText('no stability runs recorded')).toBeInTheDocument();
    expect(
      screen.getByText('no coverage observations recorded'),
    ).toBeInTheDocument();
  });
});

describe('ResultsView — provider-swap, stability and coverage runs', () => {
  it('replaces the track-2 empty note with data when a provider-swap run exists', () => {
    const ledger = new RunLedger();
    seedBenchmarkRun(ledger);
    seedProviderSwapRun(ledger);
    renderView(ledger);
    expect(
      screen.queryByText('no provider-swap runs recorded'),
    ).not.toBeInTheDocument();
    const provenance = document.querySelector('[data-provenance="exp2"]');
    expect(provenance).not.toBeNull();
    expect(provenance!.textContent).toContain('not pooled with track 1');
    expect(provenance!.textContent).toContain(SWAP_RUN_ID);
  });

  it('replaces the stability empty note when a stability-marked run exists', () => {
    const ledger = new RunLedger();
    seedBenchmarkRun(ledger);
    seedStabilityRun(ledger);
    renderView(ledger);
    expect(
      screen.queryByText('no stability runs recorded'),
    ).not.toBeInTheDocument();
    expect(
      screen.getByText('What changes as the conversation continues?'),
    ).toBeInTheDocument();
  });

  it('replaces the coverage empty note when stage-annotated coverage records exist', () => {
    const ledger = new RunLedger();
    seedBenchmarkRun(ledger);
    seedCoverageRun(ledger);
    renderView(ledger);
    expect(
      screen.queryByText('no coverage observations recorded'),
    ).not.toBeInTheDocument();
    // Matrix content comes from the derived model's stages.
    expect(screen.getAllByText(/intake/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/discharge/).length).toBeGreaterThan(0);
  });
});

describe('ResultsView — run ledger table', () => {
  function renderTwoRuns() {
    const ledger = new RunLedger();
    seedBenchmarkRun(ledger);
    seedStabilityRun(ledger);
    seedFixtureRun(ledger); // must not add a row
    return { ledger, ...renderView(ledger) };
  }

  it('renders the card title, subline and grid header', () => {
    renderTwoRuns();
    expect(screen.getByText('Run ledger')).toBeInTheDocument();
    expect(
      screen.getByText(
        'One append-only ledger beneath every view. A metric cannot drift between screens or between a screen and the write-up.',
      ),
    ).toBeInTheDocument();
    for (const header of ['run id', 'experiment', 'configuration', 'pair', 'N', 'date']) {
      expect(screen.getByText(header)).toBeInTheDocument();
    }
  });

  it('renders exactly one row per real run, matching the derived model', () => {
    const { ledger } = renderTwoRuns();
    const rows = document.querySelectorAll('[data-run-row]');
    expect(rows).toHaveLength(2);
    expect(deriveResultsModel(ledger).ledgerRows).toHaveLength(2);
    const ids = Array.from(rows).map(
      (row) => row.querySelector('[data-mono]')?.textContent,
    );
    expect(ids).toEqual([BENCHMARK_RUN_ID, STABILITY_RUN_ID]);
  });

  it('renders each run id in a mono-flagged cell', () => {
    renderTwoRuns();
    const firstRow = document.querySelector('[data-run-row]');
    expect(firstRow).not.toBeNull();
    const idCell = firstRow!.querySelector('[data-mono]');
    expect(idCell).not.toBeNull();
    expect(idCell!.textContent).toBe(BENCHMARK_RUN_ID);
  });
});
