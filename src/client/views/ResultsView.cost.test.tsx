/**
 * TICKET 052 ROUND 2 — R2-8(c) and the rendered half of R2-4/R2-5.
 *
 * R2-8(c): `ExperimentArmAggregate.costCell` is COMPUTED and PINNED and
 * RENDERED NOWHERE. The experiment cards show `costPerMinuteUsd` through
 * `formatUsd`, which turns an unmeasured cost into `—`. So one screen carries
 * two vocabularies for the same fact: `not measured` in the by-Recording table,
 * a bare em dash in the comparison rows. `—` is what this codebase uses for
 * "no sample", and a reader has no way to tell "nobody priced this arm" from
 * "there is nothing here".
 *
 * R2-4 / R2-5 (rendered): the provenance line under each card is where this
 * project puts the caveats a figure travels with. The cost denominator, the
 * rate-source version and the unverified label all have to arrive THERE, on
 * the screen, or they are not disclosures — they are fields.
 */

import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { COST_NOT_MEASURED_CELL, PRICING_VERSION } from '../../core/pricing';
import { RunLedger } from '../state/ledger';
import {
  ARM_C_TRIPLE,
  makeRecordingEntity,
  makeRunEntity,
  resetEntitySeq,
} from '../components/results/testRecords';
import ResultsView from './ResultsView';

afterEach(cleanup);

/** `Run.cost` widens to `number | null` under 052; this is an UNPRICED run. */
const UNPRICED = null as unknown as number;

/** A ledger holding Arm A, Arm B and Arm C sweeps with the given costs. */
function seededLedger(costs: { A: number | null; B: number | null; C: number | null }): RunLedger {
  resetEntitySeq();
  const ledger = new RunLedger();
  const recipes: Record<'A' | 'B' | 'C', Partial<Parameters<typeof makeRunEntity>[0]>> = {
    A: {
      architecture: 'realtime',
      providerTriple: undefined,
      modelSnapshots: { realtime: 'gpt-realtime' },
    },
    B: {},
    C: { providerTriple: { ...ARM_C_TRIPLE }, modelSnapshots: { ...ARM_C_TRIPLE } },
  };
  for (const tag of ['A', 'B', 'C'] as const) {
    const recordingId = `rec-${tag}`;
    ledger.appendRecording(makeRecordingEntity({ id: recordingId }));
    ledger.appendRun(
      makeRunEntity({
        id: `run-${tag}`,
        recordingId,
        armTag: tag,
        cost: (costs[tag] ?? UNPRICED) as number,
        ...recipes[tag],
      }),
    );
  }
  return ledger;
}

function cell(cardName: string, metric: string, col: string): string {
  const found = document.querySelector(
    `[data-card="${cardName}"] [data-metric="${metric}"] [data-col="${col}"]`,
  );
  if (!found) throw new Error(`missing cell: ${cardName}/${metric}/${col}`);
  return (found.textContent ?? '').trim();
}

function provenanceText(): string {
  return [...document.querySelectorAll('[data-provenance]')]
    .map((el) => el.textContent ?? '')
    .join(' | ')
    .replace(/\s+/g, ' ');
}

describe('R2-8c · one screen, ONE vocabulary for an unmeasured cost', () => {
  it('renders an unpriced arm as NOT MEASURED in the comparison rows, not as an em dash', () => {
    // `—` already means "no sample" on this screen. Reusing it for "nobody
    // priced this" makes the two indistinguishable to the only reader who
    // matters.
    render(<ResultsView ledger={seededLedger({ A: null, B: 0.02, C: 0.03 })} />);
    expect(cell('exp1', 'cost', 'a')).toBe(COST_NOT_MEASURED_CELL);
    expect(cell('exp1', 'cost', 'a')).not.toBe('—');
    expect(cell('exp1', 'cost', 'a')).not.toMatch(/\$0(\.0*)?$/);
  });

  it('still renders a priced arm as dollars', () => {
    render(<ResultsView ledger={seededLedger({ A: 0.1, B: 0.02, C: 0.03 })} />);
    expect(cell('exp1', 'cost', 'a')).toMatch(/^\$\d/);
  });

  it('renders no cost delta when one side was never priced', () => {
    // A delta between a number and a hole is not a comparison.
    render(<ResultsView ledger={seededLedger({ A: null, B: 0.02, C: 0.03 })} />);
    expect(cell('exp1', 'cost', 'delta')).toBe('—');
  });
});

describe('R2-5 (rendered) · the caveats reach the screen, not just the model', () => {
  it('names the rate source in the provenance line', () => {
    render(<ResultsView ledger={seededLedger({ A: 0.1, B: 0.02, C: 0.03 })} />);
    expect(provenanceText()).toContain(PRICING_VERSION);
  });

  it('labels Arm C unverified on screen, and does not label Arm B', () => {
    render(<ResultsView ledger={seededLedger({ A: 0.1, B: 0.02, C: 0.03 })} />);
    const exp2 = document.querySelector('[data-card="exp2"]')?.textContent ?? '';
    // Experiment 2 IS the Arm B / Arm C comparison, so the caveat belongs where
    // the comparison is read.
    expect(exp2.toLowerCase()).toContain('unverified');
  });

  it('discloses the cost denominator beside N in the provenance line', () => {
    render(<ResultsView ledger={seededLedger({ A: null, B: 0.02, C: 0.03 })} />);
    // Arm A: one gate-passing sample, none of them priced.
    expect(provenanceText()).toMatch(/cost measured on 0 of 1/);
  });

  it('renders the Results view without crashing on a wholly unpriced ledger', () => {
    // The degenerate case the operator will actually hit first: cascade prices
    // nothing today, so every figure on this screen is a hole.
    render(<ResultsView ledger={seededLedger({ A: null, B: null, C: null })} />);
    expect(screen.getByText('Results')).toBeInTheDocument();
    expect(document.body.textContent).not.toContain('$0.00');
  });
});

/* =========================================================================
 * TICKET 059 — THE RENDERED SURFACES, WHICH IS WHERE THE OPERATOR SEES IT.
 *
 * 052's rule holds on the Live footer and leaks on two Run-fed screens. This
 * block is the Results half: the By Recording COST column renders `$0.000` on
 * both complete rows at HEAD, because the three Runs in `data/runs/` carry
 * `"cost": 0` with no price source and `costFromStored(0)` reads that forward as
 * a MEASUREMENT.
 *
 * ONE RENDER PER TEST. RTL APPENDS to document.body and every accessor in this
 * file is `document.querySelector`, so two renders inside one `it()` leave both
 * trees mounted and the query answers from the FIRST — a "before and after"
 * assertion written that way compares a render against itself. Every test below
 * renders once and queries inside the container it was handed.
 * ====================================================================== */

import { fireEvent, within } from '@testing-library/react';

import { REALTIME_MODEL } from '../../core/arms';
import {
  makeLiveSessionEntity,
  makeUnstampedRunEntity,
} from '../components/results/testRecords';

/** The tab the By Recording table lives on. */
const TAB_BY_RECORDING = 'By Recording & category';

const REC_STAMPED_ZERO = 'rec-stamped-zero';
const REC_UNSTAMPED_ZERO = 'rec-unstamped-zero';
const REC_ALL_FAILED = 'rec-all-failed';

/** Four `complete` records each storing a `0` — the shape of 7acb0cc9. */
function zeroCostRecords() {
  return [1, 2, 3, 4].map((i) => ({
    utteranceId: `u${i}`,
    index: i,
    category: 'short-reply' as const,
    timings: { speech_end: 0, audio_queued: 700 + i },
    transcripts: {},
    cost: 0,
    status: 'complete' as const,
    errors: [],
  }));
}

/**
 * Two By Recording rows differing ONLY in whether their Run declared a price
 * source, plus a third whose runs all failed (n === 0 — the branch that can
 * mask a broken `costCell` by never reading it).
 */
function zeroCostLedger(): RunLedger {
  resetEntitySeq();
  const ledger = new RunLedger();
  for (const id of [REC_STAMPED_ZERO, REC_UNSTAMPED_ZERO, REC_ALL_FAILED]) {
    ledger.appendRecording(makeRecordingEntity({ id, label: id }));
  }
  ledger.appendRun(
    makeRunEntity({
      id: 'run-stamped-zero',
      recordingId: REC_STAMPED_ZERO,
      cost: 0,
      utterances: zeroCostRecords(),
    }),
  );
  ledger.appendRun(
    makeUnstampedRunEntity({
      id: 'run-unstamped-zero',
      recordingId: REC_UNSTAMPED_ZERO,
      cost: 0,
      utterances: zeroCostRecords(),
    }),
  );
  ledger.appendRun(
    makeRunEntity({
      id: 'run-all-failed',
      recordingId: REC_ALL_FAILED,
      status: 'failed',
      errors: ['tts: stage timed out'],
      cost: 0,
    }),
  );
  return ledger;
}

/** Renders once, switches to the secondary tab, and hands back that container. */
function renderByRecording(ledger: RunLedger): HTMLElement {
  const { container } = render(<ResultsView ledger={ledger} />);
  fireEvent.click(within(container).getByRole('tab', { name: TAB_BY_RECORDING }));
  return container;
}

function recordingRow(container: HTMLElement, recordingId: string): HTMLElement {
  const found = container.querySelector<HTMLElement>(
    `[data-card="recording"] [data-recording-row][data-recording="${recordingId}"]`,
  );
  if (!found) throw new Error(`missing By Recording row: ${recordingId}`);
  return found;
}

/** The COST column of a By Recording row — the 8th cell of the 9-column grid. */
function costCell(row: HTMLElement): string {
  const cell = row.children.item(7);
  if (!cell) throw new Error('missing COST cell on the By Recording row');
  return (cell.textContent ?? '').trim();
}

describe('TICKET 059 · Results › By Recording renders the STAMP, not the zero', () => {
  it('a Run written TODAY whose measured cost really is 0 still renders $0.000', () => {
    // THE HALF THAT KEEPS THE FIX FROM DEGENERATING INTO "0 MEANS ABSENT".
    // Written first and asserted on the SCREEN, because a fix that maps every
    // zero to `not measured` satisfies every other assertion in this ticket.
    const container = renderByRecording(zeroCostLedger());
    const row = recordingRow(container, REC_STAMPED_ZERO);

    expect(costCell(row)).toContain('$0.000');
    expect(costCell(row)).not.toContain(COST_NOT_MEASURED_CELL);
  });

  it('a stored, UNSTAMPED Run renders not measured — never $0.000', () => {
    // The two complete Runs on disk, exactly: four `complete` records each
    // carrying a stored `0`, and no price source anywhere on the record.
    const container = renderByRecording(zeroCostLedger());
    const row = recordingRow(container, REC_UNSTAMPED_ZERO);

    expect(costCell(row)).toContain(COST_NOT_MEASURED_CELL);
    expect(costCell(row)).not.toContain('$0.000');
    expect(costCell(row)).not.toMatch(/\$0(\.0*)?\b/);
  });

  it('the row discloses its cost denominator, as the experiment card already does', () => {
    // `$0.06 over 2 of 3 samples` and `$0.06 over 3 of 3` are different claims,
    // and the dollars cannot tell them apart. The Live footer says `N of M
    // metered` and the provenance line says `cost measured on N of M samples`;
    // this row is the one place on the screen that says neither.
    const container = renderByRecording(zeroCostLedger());

    expect(recordingRow(container, REC_UNSTAMPED_ZERO).textContent).toMatch(/\b0\s*of\s*4\b/);
    expect(recordingRow(container, REC_STAMPED_ZERO).textContent).toMatch(/\b4\s*of\s*4\b/);
  });

  it('a row with NO measured samples says not measured, not a bare em dash', () => {
    // TICKET 059 criterion 5, `ResultsView.tsx`'s `row.n === 0` branch: the last
    // cost value on this screen still rendered through `derive.ts`'s `formatUsd`,
    // which emits `—`. `—` already means "no sample" here, so reusing it for
    // "nobody priced this" makes the two indistinguishable — the very confusion
    // 052 removed one card over.
    const container = renderByRecording(zeroCostLedger());
    const row = recordingRow(container, REC_ALL_FAILED);

    expect(row.getAttribute('data-recording')).toBe(REC_ALL_FAILED);
    expect(costCell(row)).toBe(COST_NOT_MEASURED_CELL);
    expect(costCell(row)).not.toBe('—');
  });

  it('renders no $0.000 anywhere on the secondary tab for the unstamped ledger', () => {
    // The eval's own check, at the surface it names: `must_not_contain`
    // ["$0.000", "$0.00", "0.000/min"] with `must_include` "not measured".
    const container = renderByRecording(zeroCostLedger());
    const secondary = container.querySelector('[data-results-tab="secondary"]')!;

    expect(secondary.textContent).toContain(COST_NOT_MEASURED_CELL);
    expect(secondary.textContent).not.toContain('$0.00');
  });
});

describe('TICKET 059 · the last two formatUsd cost cells join the one vocabulary', () => {
  /** One Run so the view is not empty, plus an unpriced Live session. */
  function unpricedLiveLedger(): RunLedger {
    resetEntitySeq();
    const ledger = new RunLedger();
    ledger.appendRecording(makeRecordingEntity({ id: 'rec-live' }));
    ledger.appendRun(makeRunEntity({ id: 'run-live', recordingId: 'rec-live' }));
    ledger.appendLiveSession(
      makeLiveSessionEntity({
        id: 'live-unpriced',
        architecture: 'realtime',
        providerTriple: undefined,
        contextPolicy: 'default',
        modelSnapshots: { realtime: REALTIME_MODEL },
        utterances: [
          { id: 'lu-1', timings: { server_speech_stopped: 0, audio_queued: 900 }, costUsd: null },
        ],
        latency: { p50: 900, p95: 900, driftMinute1ToEnd: null },
        // Nobody could price this take — cascade reports no usage today, so
        // this is the ordinary case and not an edge one.
        cost: { totalUsd: null, perMinuteMinute1: null, perMinuteFinalMinute: null },
        stability: { utterancesCompleted: 1, disconnects: 0, heapStart: null, heapEnd: null },
        quality: { wer: null },
      }),
    );
    return ledger;
  }

  function liveCell(container: HTMLElement, metric: string, column: string): string {
    const found = container.querySelector(
      `[data-card="live"] [data-metric="${metric}"] [data-live-column="${column}"]`,
    );
    if (!found) throw new Error(`missing live cell: ${metric}/${column}`);
    return (found.textContent ?? '').trim();
  }

  it('the Live cost-per-minute rows read not measured, not an em dash', () => {
    // `ResultsView.tsx:545,550` — the last two `formatUsd` call sites. `—` is
    // what this codebase uses for "no sample"; a cost nobody could take is a
    // different fact and this screen already has a word for it.
    const container = render(<ResultsView ledger={unpricedLiveLedger()} />).container;

    expect(liveCell(container, 'cost-minute-1', 'realtime-default')).toBe(COST_NOT_MEASURED_CELL);
    expect(liveCell(container, 'cost-final-minute', 'realtime-default')).toBe(
      COST_NOT_MEASURED_CELL,
    );
  });

  it('still renders a priced Live slope as dollars', () => {
    // The regression guard on the same two cells: `formatCostUsd` must not
    // swallow a real figure on its way into the one vocabulary.
    resetEntitySeq();
    const ledger = new RunLedger();
    ledger.appendRecording(makeRecordingEntity({ id: 'rec-live-2' }));
    ledger.appendRun(makeRunEntity({ id: 'run-live-2', recordingId: 'rec-live-2' }));
    ledger.appendLiveSession(
      makeLiveSessionEntity({
        id: 'live-priced',
        architecture: 'realtime',
        providerTriple: undefined,
        contextPolicy: 'default',
        modelSnapshots: { realtime: REALTIME_MODEL },
        utterances: [
          { id: 'lu-1', timings: { server_speech_stopped: 0, audio_queued: 900 }, costUsd: 0.12 },
        ],
        latency: { p50: 900, p95: 900, driftMinute1ToEnd: null },
        cost: { totalUsd: 0.12, perMinuteMinute1: 0.12, perMinuteFinalMinute: 0.3 },
        stability: { utterancesCompleted: 1, disconnects: 0, heapStart: null, heapEnd: null },
        quality: { wer: null },
      }),
    );
    const container = render(<ResultsView ledger={ledger} />).container;

    expect(liveCell(container, 'cost-minute-1', 'realtime-default')).toBe('$0.120');
    expect(liveCell(container, 'cost-final-minute', 'realtime-default')).toBe('$0.300');
  });
});
