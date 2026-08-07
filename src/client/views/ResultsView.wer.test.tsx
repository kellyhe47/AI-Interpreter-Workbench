/**
 * TICKET 042 (part 1) — WER REACHES THE SCREEN.
 *
 * Ticket 034 built the whole WER path and it is all green, but the view layer
 * never read it: `ResultsView.tsx` hardcoded the literal `not yet measured` in
 * the Experiment 1 WER a/b cells and the by-category table had no WER column at
 * all. `deriveWerByArm` / `deriveWerByCategory` were derived and dropped on the
 * floor. This suite is the last mile.
 *
 * THE LOAD-BEARING RULE, restated here because the view is the last place it
 * can be broken:
 *
 *   NOT APPLICABLE IS NOT ZERO, AND IT IS NOT `not yet measured` EITHER.
 *
 * Cantonese is improvised from English prompt cards and carries no
 * `referenceText` (PRD §9). `not applicable` says the measurement is
 * IMPOSSIBLE; `not yet measured` says it has NOT BEEN TAKEN; `0.0%` says the
 * arm was PERFECT. 034 built four structural chokepoints to keep those three
 * apart, and a view that collapses any two of them destroys the distinction at
 * the only layer the operator actually reads.
 *
 * EVERY EXPECTED STRING IS COMPUTED FROM `derive.ts`, per this suite's standing
 * convention: a view that recomputes (or hardcodes) a WER figure disagrees with
 * the derivation and fails here.
 *
 * DOM contract this ticket ADDS to the one in ResultsView.tsx:
 *
 *   [data-card="exp1"] [data-metric="wer"] [data-col="a"|"b"]
 *       the per-arm figure from `deriveWerByArm`, or `not yet measured` when
 *       the arm has no WER aggregate at all. `data-sidecar` stays on column a.
 *   [data-category-row] [data-category-wer]
 *       NEW: the by-category table's WER cell, from `deriveWerByCategory`,
 *       joined to its row on (category × arm). A category × arm pair with no
 *       WER aggregate renders `not yet measured`.
 */

import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { REALTIME_MODEL, type ArmTag } from '../../core/arms';
import type { CorpusUtterance } from '../../core/corpus';
import { scoreRunWer } from '../../core/wer';
import {
  STT_UNCHANGED_CELL,
  WER_NOT_APPLICABLE_CELL,
  WER_NOT_MEASURED_CELL,
  deriveWerByArm,
  deriveWerByCategory,
  groupByCategory,
} from '../components/results/derive';
import type { AnnotatedRun } from '../components/results/derive';
import {
  ARM_B_TRIPLE,
  ARM_C_TRIPLE,
  CORPUS_VERSION,
  T0,
  makeRecordingEntity,
  makeRunEntity,
  makeUtteranceRecord,
  resetEntitySeq,
  seedCategorySweep,
  seedComparisonSweep,
} from '../components/results/testRecords';
import { RunLedger } from '../state/ledger';
import ResultsView from './ResultsView';

afterEach(cleanup);

const TAB_SECONDARY = 'By Recording & category';
const SCORED_AT = 1_700_000_000_000;

/* --------------------------------------------------------------- fixtures -- */

/** 4 reference tokens each, so every WER below is an exact quarter. */
const SCRIPTED: CorpusUtterance[] = [
  {
    id: 'u-1',
    index: 1,
    category: 'short-reply',
    trueSpeechEndMs: 1_000,
    referenceText: 'The quick brown fox.',
  },
  {
    id: 'u-2',
    index: 2,
    category: 'numbers-dates',
    trueSpeechEndMs: 2_000,
    referenceText: 'Take 250 mg twice.',
  },
];

/**
 * PRD §9's Cantonese manifest: improvised from English prompt cards, so NO
 * entry carries a `referenceText`. This is the fixture the whole ticket turns
 * on.
 */
const IMPROVISED: CorpusUtterance[] = [
  { id: 'y-1', index: 1, category: 'short-reply', trueSpeechEndMs: 1_000 },
  { id: 'y-2', index: 2, category: 'numbers-dates', trueSpeechEndMs: 2_000 },
];

/** 1 substitution over 4 reference tokens. */
const HYP_QUARTER: Record<string, string> = {
  'u-1': 'the quick brown ox',
  'u-2': 'take 250 mg once',
  'y-1': '你好嗎',
  'y-2': '唔該晒',
};

/** 2 deletions over 4 reference tokens. */
const HYP_HALF: Record<string, string> = {
  'u-1': 'the quick',
  'u-2': 'take 250',
  'y-1': '你好嗎',
  'y-2': '唔該晒',
};

/** The recipe fields that make a Run a given arm. Never `armTag` alone. */
function armRecipe(arm: ArmTag): Partial<AnnotatedRun> {
  if (arm === 'A') {
    return {
      architecture: 'realtime',
      providerTriple: undefined,
      modelSnapshots: { realtime: REALTIME_MODEL },
      armTag: 'A',
    };
  }
  const triple = arm === 'B' ? ARM_B_TRIPLE : ARM_C_TRIPLE;
  return {
    architecture: 'cascade',
    providerTriple: { ...triple },
    modelSnapshots: { ...triple },
    armTag: arm,
  };
}

interface ArmSeed {
  arm: ArmTag;
  manifest: CorpusUtterance[];
  hypotheses: Record<string, string>;
  /** False leaves the samples UNSCORED — the `not yet measured` case. */
  score?: boolean;
}

/**
 * One Recording + one gate-passing Run per arm, each carrying real utterance
 * records, and (unless `score` is false) the post-hoc scoring pass run over it.
 * Scoring is deliberately a SEPARATE step from recording, which is the whole
 * architectural point of ticket 034.
 */
function seedScoredLedger(seeds: ArmSeed[]): RunLedger {
  resetEntitySeq();
  const ledger = new RunLedger();
  for (const seed of seeds) {
    const recordingId = `rec-wer-${seed.arm}`;
    ledger.appendRecording(
      makeRecordingEntity({
        id: recordingId,
        utterances: seed.manifest,
        corpusVersion: CORPUS_VERSION,
      }),
    );
    const run = makeRunEntity({
      id: `run-wer-${seed.arm}`,
      recordingId,
      annotations: { repIndex: 1, corpusVersion: CORPUS_VERSION },
      utterances: seed.manifest.map((entry) =>
        makeUtteranceRecord({
          utteranceId: entry.id,
          index: entry.index,
          category: entry.category,
          timings: { speech_end: T0, audio_queued: T0 + 800 },
          transcripts: { source: seed.hypotheses[entry.id], target: 'target text' },
        }),
      ),
      ...armRecipe(seed.arm),
    });
    ledger.appendRun(run);
    if (seed.score !== false) {
      for (const score of scoreRunWer(run, seed.manifest, SCORED_AT)) ledger.appendWerScore(score);
    }
  }
  return ledger;
}

/** Arms A and B, both scored against a real script. A = 50%, B = 25%. */
function scriptedLedger(): RunLedger {
  return seedScoredLedger([
    { arm: 'A', manifest: SCRIPTED, hypotheses: HYP_HALF },
    { arm: 'B', manifest: SCRIPTED, hypotheses: HYP_QUARTER },
  ]);
}

/** Arms A and B over the IMPROVISED manifest: every score is `wer: null`. */
function cantoneseLedger(): RunLedger {
  return seedScoredLedger([
    { arm: 'A', manifest: IMPROVISED, hypotheses: HYP_HALF },
    { arm: 'B', manifest: IMPROVISED, hypotheses: HYP_QUARTER },
  ]);
}

/* ---------------------------------------------------------------- helpers -- */

function renderView(ledger: RunLedger) {
  return render(<ResultsView ledger={ledger} />);
}

function showSecondaryTab(): void {
  fireEvent.click(screen.getByRole('tab', { name: TAB_SECONDARY }));
}

/** The text of one cell of one metric row inside one card. */
function cell(cardName: string, metric: string, col: string): string {
  const found = document.querySelector(
    `[data-card="${cardName}"] [data-metric="${metric}"] [data-col="${col}"]`,
  );
  if (!found) throw new Error(`missing cell: ${cardName}/${metric}/${col}`);
  return (found.textContent ?? '').trim();
}

function categoryRows(): HTMLElement[] {
  return Array.from(document.querySelectorAll<HTMLElement>('[data-category-row]'));
}

/** The row's DERIVED arm, read off the p50 cell ticket 032 marked with it. */
function rowArm(row: HTMLElement): string {
  const found = row.querySelector('[data-arm]');
  if (!found) throw new Error(`row ${row.getAttribute('data-category')} has no [data-arm]`);
  return found.getAttribute('data-arm') ?? '';
}

/** The NEW by-category WER cell, by row. */
function categoryWerCell(row: HTMLElement): string {
  const found = row.querySelector('[data-category-wer]');
  if (!found) throw new Error(`row ${row.getAttribute('data-category')} has no [data-category-wer]`);
  return (found.textContent ?? '').trim();
}

/* ================================================ exp 1 renders the figure = */

describe('ticket 042 — Experiment 1 renders the real per-arm WER', () => {
  it('AC1: the a and b cells are deriveWerByArm’s cells, verbatim', () => {
    const ledger = scriptedLedger();
    const perArm = deriveWerByArm(ledger);
    renderView(ledger);

    expect(cell('exp1', 'wer', 'a')).toContain(perArm.A!.cell);
    expect(cell('exp1', 'wer', 'b')).toContain(perArm.B!.cell);
  });

  it('AC1: those cells are the hand-checkable figures, not a stand-in', () => {
    // Arm A: 2 deletions over 4 tokens, twice → 50.0%.
    // Arm B: 1 substitution over 4 tokens, twice → 25.0%.
    renderView(scriptedLedger());
    expect(cell('exp1', 'wer', 'a')).toContain('50.0%');
    expect(cell('exp1', 'wer', 'b')).toContain('25.0%');
    // The literal the view used to hardcode is GONE once a figure exists.
    expect(cell('exp1', 'wer', 'b')).not.toContain(WER_NOT_MEASURED_CELL);
  });

  it('AC1: the delta cell still comes from the comparison model', () => {
    renderView(scriptedLedger());
    // B - A = 0.25 - 0.50. Arms A and B pin different STT stages, so there IS
    // a delta to report here.
    expect(cell('exp1', 'wer', 'delta')).toBe('-25.0%');
  });

  it('column a keeps its data-sidecar marking even once it carries a figure', () => {
    renderView(scriptedLedger());
    const werA = document.querySelector('[data-card="exp1"] [data-metric="wer"] [data-col="a"]');
    expect(werA).not.toBeNull();
    // A speech-to-speech arm has no transcript of its own; that provenance is
    // true whether or not a sidecar pass has produced a number yet.
    expect(werA).toHaveAttribute('data-sidecar');
  });

  it('AC1: an UNSCORED ledger keeps `not yet measured` in both cells', () => {
    // Records exist and pass the gate; nobody has run the scoring pass.
    const ledger = seedScoredLedger([
      { arm: 'A', manifest: SCRIPTED, hypotheses: HYP_HALF, score: false },
      { arm: 'B', manifest: SCRIPTED, hypotheses: HYP_QUARTER, score: false },
    ]);
    expect(deriveWerByArm(ledger).B!.cell).toBe(WER_NOT_MEASURED_CELL);
    renderView(ledger);

    expect(cell('exp1', 'wer', 'a')).toContain(WER_NOT_MEASURED_CELL);
    expect(cell('exp1', 'wer', 'b')).toContain(WER_NOT_MEASURED_CELL);
    expect(cell('exp1', 'wer', 'a')).not.toMatch(/\d/);
    expect(cell('exp1', 'wer', 'b')).not.toMatch(/\d/);
  });

  it('AC1: a ledger whose runs carry NO records at all still says `not yet measured`', () => {
    // seedComparisonSweep's Runs have no `utterances[]`, so there is no
    // WER-bearing atom and `deriveWerByArm` yields nothing for either arm.
    const ledger = new RunLedger();
    seedComparisonSweep(ledger);
    expect(deriveWerByArm(ledger)).toEqual({});
    renderView(ledger);

    expect(cell('exp1', 'wer', 'a')).toContain(WER_NOT_MEASURED_CELL);
    expect(cell('exp1', 'wer', 'b')).toContain(WER_NOT_MEASURED_CELL);
    // Ticket 015's sidecar marking survives this ticket untouched.
    expect(cell('exp1', 'wer', 'a')).toMatch(/sidecar/i);
  });
});

/* ================ NOT APPLICABLE IS NOT ZERO — the load-bearing render test = */

describe('ticket 042 — Cantonese renders `not applicable`, NEVER 0', () => {
  let ledger: RunLedger;

  beforeEach(() => {
    ledger = cantoneseLedger();
    // The derivation already says so; this suite exists to prove the VIEW does.
    expect(deriveWerByArm(ledger).B!.cell).toBe(WER_NOT_APPLICABLE_CELL);
  });

  it('AC3: both exp 1 WER cells read `not applicable`', () => {
    renderView(ledger);
    expect(cell('exp1', 'wer', 'a')).toContain(WER_NOT_APPLICABLE_CELL);
    expect(cell('exp1', 'wer', 'b')).toContain(WER_NOT_APPLICABLE_CELL);
  });

  it('AC3: neither cell contains a digit, and neither is 0.0%', () => {
    renderView(ledger);
    for (const col of ['a', 'b']) {
      const text = cell('exp1', 'wer', col);
      // A ZERO WER IS A PERFECT SCORE. Any digit here reports the arm nobody
      // can score as the best arm in the study.
      expect(text).not.toMatch(/\d/);
      expect(text).not.toContain('0.0%');
    }
  });

  it('AC3: neither cell says `not yet measured` — impossible is not un-taken', () => {
    renderView(ledger);
    for (const col of ['a', 'b']) {
      expect(cell('exp1', 'wer', col)).not.toContain(WER_NOT_MEASURED_CELL);
    }
  });

  it('AC3: the by-category rows say `not applicable` too, with no digit', () => {
    renderView(ledger);
    showSecondaryTab();

    const rows = categoryRows();
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      const text = categoryWerCell(row);
      expect(text).toBe(WER_NOT_APPLICABLE_CELL);
      expect(text).not.toMatch(/\d/);
      expect(text).not.toBe(WER_NOT_MEASURED_CELL);
    }
  });
});

/* ====================================== the by-category table gains a column */

describe('ticket 042 — the by-category table renders WER', () => {
  it('AC2: the header names a WER column', () => {
    renderView(scriptedLedger());
    showSecondaryTab();
    const header = document.querySelector('[data-card="category"] [data-grid-header]');
    expect(header).not.toBeNull();
    expect(header!.textContent ?? '').toMatch(/wer/i);
  });

  it('AC2: every row carries a [data-category-wer] cell', () => {
    const ledger = scriptedLedger();
    const rows = groupByCategory(ledger);
    renderView(ledger);
    showSecondaryTab();

    expect(categoryRows()).toHaveLength(rows.length);
    expect(document.querySelectorAll('[data-category-row] [data-category-wer]')).toHaveLength(
      rows.length,
    );
  });

  it('AC2: each cell is deriveWerByCategory’s cell for that (category × arm)', () => {
    // KEYED ON THE PAIR, never the category alone: a two-arm ledger yields two
    // rows per category and a category-only lookup picks the wrong arm.
    const ledger = scriptedLedger();
    const werRows = deriveWerByCategory(ledger);
    expect(werRows.length).toBe(4);
    renderView(ledger);
    showSecondaryTab();

    for (const row of categoryRows()) {
      const category = row.getAttribute('data-category');
      const arm = rowArm(row);
      const werRow = werRows.find((w) => w.category === category && w.arm === arm)!;
      expect(werRow).toBeDefined();
      expect(categoryWerCell(row)).toBe(werRow.cell);
    }
  });

  it('AC2: the figures are the hand-checkable per-arm-per-category ones', () => {
    // Arm A scored 50% and Arm B 25% on BOTH of their utterances, one per
    // category, so every row reports its own arm's figure.
    renderView(scriptedLedger());
    showSecondaryTab();

    const seen = new Map<string, string>();
    for (const row of categoryRows()) {
      seen.set(`${row.getAttribute('data-category')}|${rowArm(row)}`, categoryWerCell(row));
    }
    expect(seen.get('short-reply|A')).toBe('50.0%');
    expect(seen.get('numbers-dates|A')).toBe('50.0%');
    expect(seen.get('short-reply|B')).toBe('25.0%');
    expect(seen.get('numbers-dates|B')).toBe('25.0%');
  });

  it('AC2: a category × arm with no WER atom at all reads `not yet measured`', () => {
    // seedCategorySweep's Runs carry no utterance records, so they are
    // categorised through the annotation envelope and have no WER-bearing atom.
    const ledger = new RunLedger();
    seedCategorySweep(ledger);
    expect(deriveWerByCategory(ledger)).toEqual([]);
    renderView(ledger);
    showSecondaryTab();

    const rows = categoryRows();
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(categoryWerCell(row)).toBe(WER_NOT_MEASURED_CELL);
      expect(categoryWerCell(row)).not.toBe(WER_NOT_APPLICABLE_CELL);
    }
  });
});

/* ============================================ what this ticket must NOT move */

describe('ticket 042 — behaviour this ticket leaves alone', () => {
  it('AC4: exp 2 still reads `— (STT unchanged)` when the arms share an STT stage', () => {
    // Arms B and C differ in TTS alone, so the transcript is identical by
    // construction — even with both arms fully scored, the delta is not a
    // number to report.
    const ledger = seedScoredLedger([
      { arm: 'B', manifest: SCRIPTED, hypotheses: HYP_QUARTER },
      { arm: 'C', manifest: SCRIPTED, hypotheses: HYP_QUARTER },
    ]);
    renderView(ledger);

    expect(cell('exp2', 'wer', 'delta')).toBe(STT_UNCHANGED_CELL);
    expect(cell('exp2', 'wer', 'delta')).not.toMatch(/\d/);
  });

  it('adequacy, fluency and intervals stay `not yet measured` with no digit', () => {
    renderView(scriptedLedger());
    for (const metric of ['adequacy', 'fluency', 'intervals']) {
      for (const col of ['a', 'b']) {
        expect(cell('exp1', metric, col)).toContain(WER_NOT_MEASURED_CELL);
        expect(cell('exp1', metric, col)).not.toMatch(/\d/);
      }
    }
  });

  it('AC5 (tickets 018/025): an empty ledger still renders ZERO DIGITS', () => {
    const { container } = renderView(new RunLedger());
    expect(screen.getByText('No runs recorded')).toBeInTheDocument();
    expect(container.textContent ?? '').not.toMatch(/\d/);
    showSecondaryTab();
    expect(container.textContent ?? '').not.toMatch(/\d/);
    // The new column cannot open a table an empty ledger does not have.
    expect(document.querySelectorAll('[data-category-wer]')).toHaveLength(0);
  });
});
