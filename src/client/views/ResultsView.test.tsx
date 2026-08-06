/**
 * Ticket 015 — RTL tests for the v2 two-tab <ResultsView />.
 *
 * These tests lock the DOM contract documented in ResultsView.tsx. Two rules
 * run through all of them:
 *
 *  1. EMPTY IS THE DEFAULT (PRD §8, §17 15g). With nothing real recorded the
 *     view renders 'No runs recorded' and NOTHING numeric — not a metric grid,
 *     not a provenance line, not a single digit. A fixture-only ledger renders
 *     byte-identically to an empty one.
 *  2. EVERY FIGURE COMES FROM derive.ts. Expected strings are computed from
 *     the same derivation the component renders, so a view that quietly
 *     recomputes (or hardcodes) a metric disagrees and fails.
 */

// Imported directly (in addition to vitest.setup.ts) so the jest-dom matcher
// type augmentation is visible to `tsc -p tsconfig.json`, whose include does
// not cover the setup file.
import '@testing-library/jest-dom/vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { armLabel } from '../../core/arms';
import { RunLedger } from '../state/ledger';
import {
  STT_UNCHANGED_CELL,
  deriveComparison,
  deriveLiveModel,
  formatMs,
  formatUsd,
  groupByCategory,
  groupByRecording,
} from '../components/results/derive';
import {
  ADHOC_RECORDING_ID,
  ARM_B_TRIPLE,
  CLEAN_RECORDING_ID,
  EXCLUDED_COST_USD,
  EXCLUDED_LATENCY_MS,
  FAILED_RECORDING_ID,
  FIXTURE_RECORDING_ID,
  MANUAL_RECORDING_ID,
  SHORT_RECORDING_ID,
  SHORT_SWEEP_ALL_FIVE_P50_MS,
  SHORT_SWEEP_COMPLETED_REPS,
  SHORT_SWEEP_INTENDED_REPS,
  SHORT_SWEEP_SURVIVING_P50_MS,
  makeRecordingEntity,
  runWithLatency,
  seedCategorySweep,
  seedCleanSweep,
  seedComparisonSweep,
  seedExclusionCases,
  seedLiveSessions,
  seedShortRepSweep,
} from '../components/results/testRecords';
import ResultsView from './ResultsView';

afterEach(cleanup);

/* ---------------------------------------------------------------- copy -- */

const HEADER_SUBLINE =
  'Every screen reads one append-only run ledger. Experiments aggregate only sweep-origin runs whose configuration matches a named arm.';

const TAB_PRIMARY = 'Experiments';
const TAB_SECONDARY = 'By Recording & category';

const EMPTY_TITLE = 'No runs recorded';
const EMPTY_SUBLINE =
  'Run a batch sweep in Replay to populate the experiments. Result cards never show sample data as evidence.';

/** The cell a metric with no derivation source yet renders. Never 0, never a guess. */
const NOT_MEASURED = 'not yet measured';

const EMPTY_CARD_COPY = {
  exp1: 'no sweep runs recorded for Arm A vs Arm B',
  exp2: 'no sweep runs recorded for Arm B vs Arm C',
  live: 'no live sessions recorded',
} as const;

/** Card identity: eyebrow / question title / takeaway, verbatim from the mock. */
const EXPERIMENT_CARDS = [
  {
    card: 'exp1',
    eyebrow: 'Experiment 1 · vendor held constant',
    title: 'Does the architecture itself cost latency?',
    takeaway: 'Latency is a wash. Cost is not.',
  },
  {
    card: 'exp2',
    eyebrow: 'Experiment 2 · architecture held constant · one stage varies',
    title: 'What does swapping providers buy?',
    takeaway:
      'One swapped stage, cleanly attributable: streaming text input is the single largest cascade latency lever.',
  },
  {
    card: 'live',
    eyebrow: 'Sourced from LiveSessions, not Replay runs',
    title: 'What changes as the conversation continues?',
    takeaway:
      'The slope belongs to token billing with conversation replay, not to voice-to-voice. Trimming context removes most of it; cascade never had it.',
  },
  {
    card: 'coverage',
    eyebrow: 'Exploratory case study · never pooled with experiments',
    title: 'What does provider choice let us reach?',
    takeaway: null,
  },
] as const;

const SECONDARY_CARD_EYEBROWS = {
  category: 'By utterance category — where the heterogeneity lives',
  recording: 'By Recording — includes ad-hoc runs, excluded from experiments',
} as const;

/* ------------------------------------------------------------- helpers -- */

function renderView(ledger: RunLedger) {
  return render(<ResultsView ledger={ledger} />);
}

function showSecondaryTab(): void {
  fireEvent.click(screen.getByRole('tab', { name: TAB_SECONDARY }));
}

function panel(tab: 'experiments' | 'secondary'): HTMLElement {
  const found = document.querySelector<HTMLElement>(`[data-results-tab="${tab}"]`);
  if (!found) throw new Error(`missing panel: ${tab}`);
  return found;
}

function card(name: string): HTMLElement {
  const found = document.querySelector<HTMLElement>(`[data-card="${name}"]`);
  if (!found) throw new Error(`missing card: ${name}`);
  return found;
}

/** The text of one cell of one metric row inside one card. */
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

/** A ledger holding one fixture-sourced Run and nothing else. */
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

/** Arms A + B + C, three gate-passing reps each — feeds exp 1 and exp 2. */
function comparisonLedger(): RunLedger {
  const ledger = new RunLedger();
  seedComparisonSweep(ledger);
  return ledger;
}

/* ================================================================ header == */

describe('ResultsView — header and tabs (always rendered)', () => {
  it('shows the title and the v2 ledger subline', () => {
    renderView(new RunLedger());
    expect(screen.getByText('Results')).toBeInTheDocument();
    expect(screen.getByText(HEADER_SUBLINE)).toBeInTheDocument();
  });

  it('does NOT build the mock’s "show recorded runs (mock)" switch', () => {
    renderView(comparisonLedger());
    expect(screen.queryByRole('switch')).not.toBeInTheDocument();
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
    expect(screen.queryByText(/show recorded runs/i)).not.toBeInTheDocument();
  });
});

/* ============================================================ empty state == */

describe('ResultsView — empty ledger is the default (PRD §17 15g)', () => {
  it('renders the empty card copy on the Experiments tab', () => {
    renderView(new RunLedger());
    expect(screen.getByText(EMPTY_TITLE)).toBeInTheDocument();
    expect(screen.getByText(EMPTY_SUBLINE)).toBeInTheDocument();
  });

  it('renders a disabled Run sweep button explaining that sweeps need the real corpus', () => {
    renderView(new RunLedger());
    const button = screen.getByRole('button', { name: /run sweep/i });
    expect(button).toBeDisabled();
    const explanation =
      button.getAttribute('title') ?? button.getAttribute('aria-label') ?? '';
    expect(explanation).toMatch(/real corpus/i);
  });

  it('shows the SAME empty state on the secondary tab, with no tables', () => {
    renderView(new RunLedger());
    showSecondaryTab();
    expect(screen.getByText(EMPTY_TITLE)).toBeInTheDocument();
    expect(document.querySelectorAll('[data-recording-row]')).toHaveLength(0);
    expect(document.querySelectorAll('[data-category-row]')).toHaveLength(0);
  });

  it('renders no metric grid, no provenance line and no card on either tab', () => {
    renderView(new RunLedger());
    for (const selector of ['[data-metric]', '[data-provenance]', '[data-card]']) {
      expect(document.querySelectorAll(selector)).toHaveLength(0);
    }
    showSecondaryTab();
    for (const selector of ['[data-metric]', '[data-provenance]', '[data-card]']) {
      expect(document.querySelectorAll(selector)).toHaveLength(0);
    }
  });

  it('contains NOT ONE DIGIT anywhere — a placeholder figure cannot read as evidence', () => {
    const { container } = renderView(new RunLedger());
    expect(container.textContent ?? '').not.toMatch(/\d/);
    showSecondaryTab();
    expect(container.textContent ?? '').not.toMatch(/\d/);
  });

  it('a fixture-only ledger renders IDENTICALLY to an empty one', () => {
    const empty = render(<ResultsView ledger={new RunLedger()} />);
    const fixture = render(<ResultsView ledger={fixtureOnlyLedger()} />);
    expect(fixture.container.innerHTML).toBe(empty.container.innerHTML);
    expect(fixture.container.textContent ?? '').not.toMatch(/\d/);
    expect(
      fixture.container.querySelectorAll('[data-metric], [data-recording-row]'),
    ).toHaveLength(0);
  });
});

/* ================================================================== tabs == */

describe('ResultsView — two tabs, exactly one rendered', () => {
  it('defaults to Experiments and marks it selected', () => {
    renderView(comparisonLedger());
    expect(screen.getByRole('tab', { name: TAB_PRIMARY })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    expect(screen.getByRole('tab', { name: TAB_SECONDARY })).toHaveAttribute(
      'aria-selected',
      'false',
    );
    expect(document.querySelector('[data-results-tab="experiments"]')).not.toBeNull();
    expect(document.querySelector('[data-results-tab="secondary"]')).toBeNull();
  });

  it('switches to By Recording & category and unmounts the Experiments panel', () => {
    renderView(comparisonLedger());
    showSecondaryTab();

    expect(document.querySelector('[data-results-tab="secondary"]')).not.toBeNull();
    expect(document.querySelector('[data-results-tab="experiments"]')).toBeNull();
    expect(screen.getByRole('tab', { name: TAB_SECONDARY })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    expect(document.querySelector('[data-card="exp1"]')).toBeNull();

    // ...and back again.
    fireEvent.click(screen.getByRole('tab', { name: TAB_PRIMARY }));
    expect(document.querySelector('[data-results-tab="experiments"]')).not.toBeNull();
    expect(document.querySelector('[data-results-tab="secondary"]')).toBeNull();
  });
});

/* ======================================================= experiment cards == */

describe('ResultsView — Experiments tab card identity', () => {
  it('renders the four question cards with their eyebrows and titles', () => {
    renderView(comparisonLedger());
    for (const spec of EXPERIMENT_CARDS) {
      const section = card(spec.card);
      expect(within(section).getByText(spec.eyebrow)).toBeInTheDocument();
      expect(within(section).getByText(spec.title)).toBeInTheDocument();
    }
  });

  it('renders each card’s gray takeaway when the card has data', () => {
    const ledger = comparisonLedger();
    seedLiveSessions(ledger); // so the live card has data too
    renderView(ledger);
    for (const spec of EXPERIMENT_CARDS) {
      if (spec.takeaway === null) continue;
      const takeaway = card(spec.card).querySelector('[data-takeaway]');
      expect(takeaway).not.toBeNull();
      expect((takeaway!.textContent ?? '').trim()).toBe(spec.takeaway);
    }
  });

  it('labels the un-measured coverage card illustrative, and the measured exp 1 card not', () => {
    renderView(comparisonLedger());
    const pill = card('coverage').querySelector('[data-illustrative]');
    expect(pill).not.toBeNull();
    expect((pill!.textContent ?? '').trim()).toBe('illustrative');
    expect(card('exp1').querySelector('[data-illustrative]')).toBeNull();
  });
});

describe('ResultsView — exp 1 (Arm A vs Arm B, vendor held constant)', () => {
  function renderExp1() {
    const ledger = comparisonLedger();
    const model = deriveComparison(ledger, 'A', 'B')!;
    return { ledger, model, ...renderView(ledger) };
  }

  it('renders p50, p95 and cost/min for Arm A vs Arm B, straight from the derivation', () => {
    const { model } = renderExp1();
    expect(within(card('exp1')).getByText(armLabel('A'))).toBeInTheDocument();
    expect(within(card('exp1')).getByText(armLabel('B'))).toBeInTheDocument();

    for (const metric of ['p50', 'p95', 'cost'] as const) {
      const row = model.rows.find((r) => r.metric === metric)!;
      expect(cell('exp1', metric, 'a')).toBe(row.valueA);
      expect(cell('exp1', metric, 'b')).toBe(row.valueB);
      expect(cell('exp1', metric, 'delta')).toBe(row.delta);
    }

    // Sanity: derivation and seeded fixture agree on the actual figures.
    expect(cell('exp1', 'p50', 'a')).toBe(formatMs(1100));
    expect(cell('exp1', 'p50', 'b')).toBe(formatMs(800));
    expect(cell('exp1', 'cost', 'a')).toBe(formatUsd(0.1));
    expect(cell('exp1', 'cost', 'b')).toBe(formatUsd(0.02));
  });

  it('tones the delta cell from the derivation, not from the component', () => {
    const { model } = renderExp1();
    for (const metric of ['p50', 'p95', 'cost'] as const) {
      const row = model.rows.find((r) => r.metric === metric)!;
      const delta = document.querySelector(
        `[data-card="exp1"] [data-metric="${metric}"] [data-col="delta"] [data-tone]`,
      );
      expect(delta).not.toBeNull();
      expect(delta!.getAttribute('data-tone')).toBe(row.deltaTone);
    }
  });

  it('renders WER, adequacy, fluency and the observable-interval count as rows', () => {
    renderExp1();
    for (const metric of ['wer', 'adequacy', 'fluency', 'intervals']) {
      expect(
        document.querySelector(`[data-card="exp1"] [data-metric="${metric}"]`),
      ).not.toBeNull();
    }
  });

  it('renders an explicit not-yet-measured cell — never a zero, never a figure', () => {
    renderExp1();
    for (const metric of ['adequacy', 'fluency', 'intervals']) {
      expect(cell('exp1', metric, 'a')).toContain(NOT_MEASURED);
      expect(cell('exp1', metric, 'b')).toContain(NOT_MEASURED);
      expect(cell('exp1', metric, 'a')).not.toMatch(/\d/);
      expect(cell('exp1', metric, 'b')).not.toMatch(/\d/);
    }
  });

  it('labels the Realtime WER cell a SIDECAR measurement', () => {
    renderExp1();
    const werA = document.querySelector(
      '[data-card="exp1"] [data-metric="wer"] [data-col="a"]',
    );
    expect(werA).not.toBeNull();
    expect(werA).toHaveAttribute('data-sidecar');
    expect(werA!.textContent ?? '').toMatch(/sidecar/i);
  });
});

describe('ResultsView — exp 2 (Arm B vs Arm C, only TTS differs)', () => {
  it('renders Arm B vs Arm C with the derivation’s p50, p95 and cost', () => {
    const ledger = comparisonLedger();
    const model = deriveComparison(ledger, 'B', 'C')!;
    renderView(ledger);

    expect(within(card('exp2')).getByText(armLabel('B'))).toBeInTheDocument();
    expect(within(card('exp2')).getByText(armLabel('C'))).toBeInTheDocument();
    for (const metric of ['p50', 'p95', 'cost'] as const) {
      const row = model.rows.find((r) => r.metric === metric)!;
      expect(cell('exp2', metric, 'a')).toBe(row.valueA);
      expect(cell('exp2', metric, 'b')).toBe(row.valueB);
    }
    expect(cell('exp2', 'p50', 'b')).toBe(formatMs(850));
  });

  it('renders the WER cell as "— (STT unchanged)" rather than a number', () => {
    renderView(comparisonLedger());
    expect(cell('exp2', 'wer', 'delta')).toBe(STT_UNCHANGED_CELL);
    expect(cell('exp2', 'wer', 'delta')).not.toMatch(/\d/);
  });

  it('renders a fluency row, not yet measured', () => {
    renderView(comparisonLedger());
    expect(cell('exp2', 'fluency', 'a')).toContain(NOT_MEASURED);
  });
});

/* ================================================================ provenance */

describe('ResultsView — provenance lines report ACTUAL N', () => {
  it('every experiment card carries a mono provenance line with reps, utterances, 500 ms and corpus', () => {
    const ledger = comparisonLedger();
    const exp1 = deriveComparison(ledger, 'A', 'B')!;
    const exp2 = deriveComparison(ledger, 'B', 'C')!;
    renderView(ledger);

    for (const [key, model] of [
      ['exp1', exp1],
      ['exp2', exp2],
    ] as const) {
      const line = document.querySelector(`[data-provenance="${key}"]`);
      expect(line).not.toBeNull();
      expect(line).toHaveAttribute('data-mono');
      const text = line!.textContent ?? '';
      expect(text).toContain(model.provenanceA.line);
      expect(text).toContain(model.provenanceB.line);
      // The four required items, spelled out.
      expect(text).toMatch(/\d+ of \d+ reps completed/);
      expect(text).toMatch(/\d+ utterances/);
      expect(text).toContain('endpointing pinned 500 ms');
      expect(text).toContain(model.provenanceA.corpusVersion!);
    }
  });

  it('the live and coverage cards carry their own mono provenance lines', () => {
    const ledger = comparisonLedger();
    seedLiveSessions(ledger);
    renderView(ledger);
    for (const key of ['live', 'coverage']) {
      const line = document.querySelector(`[data-provenance="${key}"]`);
      expect(line).not.toBeNull();
      expect(line).toHaveAttribute('data-mono');
      expect((line!.textContent ?? '').length).toBeGreaterThan(0);
    }
  });

  it('a 4-of-5 sweep reads "4 of 5" AND shows the 4-sample p50 — line and number agree', () => {
    const ledger = new RunLedger();
    seedCleanSweep(ledger); // Arm B, 5 of 5
    seedShortRepSweep(ledger); // Arm C, rep 3 failed
    renderView(ledger);

    const line = document.querySelector('[data-provenance="exp2"]')!.textContent ?? '';
    expect(line).toContain(
      `${SHORT_SWEEP_COMPLETED_REPS} of ${SHORT_SWEEP_INTENDED_REPS} reps completed`,
    );

    // Arm C is column B of exp 2. Its p50 must be the surviving-4 figure...
    expect(cell('exp2', 'p50', 'b')).toBe(formatMs(SHORT_SWEEP_SURVIVING_P50_MS));
    // ...and NOT the all-five figure the failed rep would have produced.
    expect(cell('exp2', 'p50', 'b')).not.toBe(formatMs(SHORT_SWEEP_ALL_FIVE_P50_MS));
  });
});

/* ============================================== card 3 — LiveSessions only == */

describe('ResultsView — conversation-length card is sourced from LiveSessions', () => {
  it('renders three columns: realtime-default, realtime-trimmed and cascade', () => {
    const ledger = comparisonLedger();
    seedLiveSessions(ledger);
    renderView(ledger);

    const headers = card('live').querySelectorAll('[data-grid-header] [data-live-column]');
    expect(Array.from(headers).map((h) => h.getAttribute('data-live-column'))).toEqual([
      'realtime-default',
      'realtime-trimmed',
      'cascade',
    ]);
    expect(within(card('live')).getByText('realtime · default')).toBeInTheDocument();
    expect(within(card('live')).getByText('realtime · trimmed')).toBeInTheDocument();
    expect(within(card('live')).getByText('cascade')).toBeInTheDocument();
  });

  it('fills the columns from deriveLiveModel, and leaves the un-recorded column blank', () => {
    const ledger = new RunLedger();
    seedLiveSessions(ledger);
    const model = deriveLiveModel(ledger);
    const armA = model.columns.find((c) => c.arm === 'A')!;
    const armB = model.columns.find((c) => c.arm === 'B')!;
    renderView(ledger);

    const liveCell = (metric: string, column: string): string => {
      const found = document.querySelector(
        `[data-card="live"] [data-metric="${metric}"] [data-live-column="${column}"]`,
      );
      if (!found) throw new Error(`missing live cell: ${metric}/${column}`);
      return (found.textContent ?? '').trim();
    };

    expect(liveCell('p50', 'realtime-default')).toBe(formatMs(armA.p50Ms));
    expect(liveCell('p50', 'cascade')).toBe(formatMs(armB.p50Ms));
    expect(liveCell('disconnects', 'realtime-default')).toBe(String(armA.disconnects));
    expect(liveCell('disconnects', 'cascade')).toBe(String(armB.disconnects));
    expect(liveCell('drift', 'realtime-default')).toBe(formatMs(armA.driftMinute1ToEndMs));
    expect(liveCell('cost-final-minute', 'realtime-default')).toBe(
      formatUsd(armA.costPerMinuteFinalMinute),
    );

    // No LiveSession declares a trimmed-context policy, so that column is '—'.
    expect(liveCell('p50', 'realtime-trimmed')).toBe(formatMs(null));
  });

  it('renders its OWN empty state when Runs exist but no LiveSession does', () => {
    renderView(comparisonLedger());
    const empty = card('live').querySelector('[data-empty-card="live"]');
    expect(empty).not.toBeNull();
    expect((empty!.textContent ?? '').trim()).toBe(EMPTY_CARD_COPY.live);
    expect(card('live').querySelectorAll('[data-metric]')).toHaveLength(0);
  });

  it('non-pooling in the other direction: LiveSessions alone leave exp 1 and exp 2 empty', () => {
    const ledger = new RunLedger();
    seedLiveSessions(ledger);
    renderView(ledger);

    expect(screen.queryByText(EMPTY_TITLE)).not.toBeInTheDocument();
    for (const key of ['exp1', 'exp2'] as const) {
      const empty = card(key).querySelector(`[data-empty-card="${key}"]`);
      expect(empty).not.toBeNull();
      expect((empty!.textContent ?? '').trim()).toBe(EMPTY_CARD_COPY[key]);
      expect(card(key).querySelectorAll('[data-metric]')).toHaveLength(0);
      expect(card(key).querySelector('[data-provenance]')).toBeNull();
    }
  });
});

/* ================================================= card 4 — coverage rows == */

describe('ResultsView — coverage card rows are DIRECTIONS with per-stage cells', () => {
  const DIRECTIONS = [
    { slug: 'en-es', label: 'English → Spanish' },
    { slug: 'es-en', label: 'Spanish → English' },
    { slug: 'en-yue', label: 'English → Cantonese' },
    { slug: 'yue-en', label: 'Cantonese → English' },
  ] as const;

  it('renders one row per direction — EN→YUE and YUE→EN are separate claims', () => {
    renderView(comparisonLedger());
    const rows = card('coverage').querySelectorAll('[data-direction]');
    expect(Array.from(rows).map((r) => r.getAttribute('data-direction'))).toEqual(
      DIRECTIONS.map((d) => d.slug),
    );
    for (const direction of DIRECTIONS) {
      const row = card('coverage').querySelector(`[data-direction="${direction.slug}"]`)!;
      expect(row.textContent).toContain(direction.label);
    }
  });

  it('gives every direction a cell per stage, so a failure is attributable to a stage', () => {
    renderView(comparisonLedger());
    for (const direction of DIRECTIONS) {
      const row = card('coverage').querySelector(`[data-direction="${direction.slug}"]`)!;
      const stages = Array.from(row.querySelectorAll('[data-stage]')).map((s) =>
        s.getAttribute('data-stage'),
      );
      expect(stages).toEqual(['realtime', 'stt', 'mt', 'tts']);
    }
  });

  it('carries a per-cell observation note and three time-to-add tiles citing commit and diff size', () => {
    renderView(comparisonLedger());
    const observation = card('coverage').querySelector('[data-observation]');
    expect(observation).not.toBeNull();
    expect(observation!.textContent).toContain('Observation · English → Cantonese on Realtime');
    expect(observation!.textContent).toMatch(/Mandarin, not Cantonese/);

    const tiles = card('coverage').querySelectorAll('[data-time-to-add]');
    expect(tiles).toHaveLength(3);
    const tileText = Array.from(tiles).map((t) => t.textContent ?? '');
    expect(tileText[0]).toContain('commit a4f21c');
    expect(tileText[0]).toContain('+11 lines');
    expect(tileText[1]).toContain('commit 9d0e77');
    expect(tileText[2]).toContain('no mechanism exists at any price');
  });
});

/* ====================================== secondary tab — recordings + category */

describe('ResultsView — secondary tab: per-recording table', () => {
  function renderExclusions() {
    const ledger = new RunLedger();
    seedCleanSweep(ledger);
    seedExclusionCases(ledger);
    renderView(ledger);
    return ledger;
  }

  it('renders the two secondary cards with their eyebrows', () => {
    renderView(comparisonLedger());
    showSecondaryTab();
    for (const [name, eyebrow] of Object.entries(SECONDARY_CARD_EYEBROWS)) {
      expect(within(card(name)).getByText(eyebrow)).toBeInTheDocument();
    }
  });

  it('renders one row per derived recording group, in derivation order', () => {
    const ledger = renderExclusions();
    showSecondaryTab();
    const expected = groupByRecording(ledger).map((r) => r.recordingId);
    const rendered = Array.from(document.querySelectorAll('[data-recording-row]')).map((r) =>
      r.getAttribute('data-recording'),
    );
    expect(rendered).toEqual(expected);
  });

  // The four exclusion reasons are a natural table: each is one Run on its own
  // Recording, and each must be VISIBLE and marked with WHY it is excluded.
  const EXCLUSIONS = [
    { recordingId: ADHOC_RECORDING_ID, reason: 'ad-hoc', arm: 'ad-hoc' },
    { recordingId: MANUAL_RECORDING_ID, reason: 'manual', arm: 'B' },
    { recordingId: FAILED_RECORDING_ID, reason: 'failed', arm: 'B' },
    { recordingId: FIXTURE_RECORDING_ID, reason: 'fixture', arm: 'B' },
  ] as const;

  it.each(EXCLUSIONS)(
    'lists the $reason run and marks it excluded from experiments',
    ({ recordingId, reason, arm }) => {
      renderExclusions();
      showSecondaryTab();
      const row = recordingRow(recordingId);
      expect(row).toHaveAttribute('data-excluded', 'true');
      expect(row).toHaveAttribute('data-arm', arm);
      expect(row.querySelector(`[data-exclusion="${reason}"]`)).not.toBeNull();
      expect(row.textContent ?? '').toMatch(/excluded/i);
    },
  );

  it('does not mark a clean sweep row excluded', () => {
    renderExclusions();
    showSecondaryTab();
    const row = recordingRow(CLEAN_RECORDING_ID);
    expect(row).toHaveAttribute('data-excluded', 'false');
    expect(row.querySelector('[data-exclusion]')).toBeNull();
  });

  it('is the ONLY place an ad-hoc run is visible — never on the Experiments tab', () => {
    renderExclusions();
    expect(panel('experiments').textContent ?? '').not.toContain('ad-hoc');
    showSecondaryTab();
    expect(panel('secondary').textContent ?? '').toContain('ad-hoc');
  });
});

describe('ResultsView — secondary tab: category table', () => {
  it('groups by utterance category, not by recording', () => {
    const ledger = new RunLedger();
    seedCategorySweep(ledger); // 2 recordings × 2 categories × 2 reps
    const rows = groupByCategory(ledger);
    renderView(ledger);
    showSecondaryTab();

    const rendered = Array.from(document.querySelectorAll('[data-category-row]')).map((r) =>
      r.getAttribute('data-category'),
    );
    expect(rendered).toEqual(rows.map((r) => r.category));
    expect(new Set(rendered)).toEqual(new Set(['numbers-dates', 'short-reply']));

    // A category figure pools across recordings, so it is reconstructible from
    // neither per-recording row (rec-cat-1 p50 760, rec-cat-2 p50 980).
    const numbersRow = document.querySelector('[data-category-row][data-category="numbers-dates"]')!;
    const armCell = numbersRow.querySelector('[data-arm="B"]');
    expect(armCell).not.toBeNull();
    expect((armCell!.textContent ?? '').trim()).toBe(formatMs(1300));
  });

  it('carries no hardcoded mock finding', () => {
    const ledger = new RunLedger();
    seedCategorySweep(ledger);
    renderView(ledger);
    showSecondaryTab();
    expect(card('category').textContent ?? '').not.toContain('400 ms');
  });
});

/* ================================================== the gate, as rendered == */

describe('ResultsView — no excluded run reaches a rendered experiment aggregate', () => {
  it('keeps manual, failed, ad-hoc and fixture runs out of every experiment figure', () => {
    const ledger = comparisonLedger();
    seedExclusionCases(ledger); // each 5.00 s and $0.500 — impossible to miss
    const model = deriveComparison(ledger, 'A', 'B')!;
    renderView(ledger);

    const text = panel('experiments').textContent ?? '';
    expect(text).not.toContain(formatMs(EXCLUDED_LATENCY_MS));
    expect(text).not.toContain(formatUsd(EXCLUDED_COST_USD));

    // The gate-passing figures are unchanged by their presence.
    expect(cell('exp1', 'p50', 'a')).toBe(model.rows.find((r) => r.metric === 'p50')!.valueA);
    expect(cell('exp1', 'p50', 'b')).toBe(formatMs(800));
  });

  it('a short-rep sweep’s failed run never contributes a sample', () => {
    const ledger = new RunLedger();
    seedCleanSweep(ledger);
    seedShortRepSweep(ledger);
    renderView(ledger);
    expect(panel('experiments').textContent ?? '').not.toContain(
      formatMs(SHORT_SWEEP_ALL_FIVE_P50_MS),
    );
    // ...yet the failed run is still findable on the secondary tab.
    showSecondaryTab();
    expect(recordingRow(SHORT_RECORDING_ID)).toBeInTheDocument();
  });
});

/* ============================================== source-level guarantees ==== */

describe('ResultsView.tsx source — no hardcoded metric, tokens only', () => {
  const source = readFileSync(
    resolve(process.cwd(), 'src/client/views/ResultsView.tsx'),
    'utf8',
  );

  it.each([
    ['a dollar figure', /\$\s*\d/],
    ['a millisecond figure', /\d+(\.\d+)?\s*ms\b/],
    ['a seconds figure', /\b\d+\.\d+\s*s\b/],
    ['a percentage figure', /\d+(\.\d+)?\s*%/],
  ])('contains no hardcoded latency/cost/WER/quality literal: %s', (_label, pattern) => {
    expect(source).not.toMatch(pattern as RegExp);
  });

  it('contains none of the mock’s sample figures', () => {
    for (const figure of ['0.140', '0.021', '1.02', '1.06', '4.2', '3.8', '4.6']) {
      expect(source).not.toContain(figure);
    }
  });

  it('styles from tokens only — no hex, rgb or oklch literal', () => {
    expect(source).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(source).not.toMatch(/\brgba?\(/);
    expect(source).not.toMatch(/\boklch\(/);
  });
});
