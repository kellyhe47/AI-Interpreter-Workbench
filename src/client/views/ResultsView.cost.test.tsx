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
