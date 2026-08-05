/**
 * Ticket 014 — Blind compare (comparison mode only).
 *
 * Rendered through <App deps={fakes} /> via the shared session kit so the
 * integration is real: two live arms (realtime + Cascade · OpenAI) each
 * complete utterance 0 from fixture scripts, then the blind-compare flow is
 * exercised against the REAL RunLedger (spied, not stubbed — recordBlindDraw
 * / recordBlindScores still execute, so exportRuns() proves persistence).
 *
 * RNG contract under test (SessionDeps.rng): one rng() value per open with
 * two arms; < 0.5 keeps the active arm order [realtime, cascade-openai],
 * >= 0.5 swaps it. order[0] is Sample A.
 */

import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  advance,
  cascadeUtteranceScript,
  clickStartMicrophone,
  realtimeUtteranceScript,
  renderApp,
  type TestDepsOptions,
} from '../../views/sessionTestKit';

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const COMPARE = 'compare blind';
const CLOSE = 'close blind compare';
const SUBMIT = 'submit ratings';
const HINT_HIDDEN = 'arm identity hidden until you submit';
const HINT_REVEALED = 'identity revealed — scores appended to ledger';
const FOOTER_NOTE = 'rate fluency 1–5 · order randomized · scores append to the run ledger';

/** Active arm order after add-arm: ['realtime', 'cascade-openai']. */
const ACTIVE_ORDER = ['realtime', 'cascade-openai'];
const SWAPPED_ORDER = ['cascade-openai', 'realtime'];

/** Start a session with realtime, add the Cascade · OpenAI arm, and let both
 * arms complete utterance 0. */
async function startComparison(opts: Pick<TestDepsOptions, 'rng' | 'now'> = {}) {
  const kit = renderApp({
    initialState: { mode: 'realtime', arms: ['realtime'] },
    scripts: {
      realtime: realtimeUtteranceScript(),
      'cascade-openai': cascadeUtteranceScript(),
    },
    ...opts,
  });
  await clickStartMicrophone();
  fireEvent.click(screen.getByRole('button', { name: '+ Cascade · OpenAI · $0.021/min' }));
  await advance(1300); // both arms complete utterance 0 → utteranceCount 1
  return kit;
}

function blindCard(): HTMLElement {
  const el = document.querySelector('[data-blind-card]');
  if (!el) throw new Error('blind-compare card not rendered');
  return el as HTMLElement;
}

function samplePanel(key: 'A' | 'B'): HTMLElement {
  const el = document.querySelector(`[data-blind-sample="${key}"]`);
  if (!el) throw new Error(`sample panel ${key} not rendered`);
  return el as HTMLElement;
}

function open(): void {
  fireEvent.click(screen.getByRole('button', { name: COMPARE }));
}

describe('AC1 — blind compare is offered only in comparison mode', () => {
  it('single arm → no compare-blind button; two arms → button + summary note', async () => {
    // Single arm: nothing.
    renderApp({
      initialState: { mode: 'realtime', arms: ['realtime'] },
      scripts: { realtime: realtimeUtteranceScript() },
    });
    await clickStartMicrophone();
    await advance(1100);
    expect(screen.queryByRole('button', { name: COMPARE })).not.toBeInTheDocument();
    cleanup();

    // Comparison mode: trigger button + right-aligned note.
    await startComparison();
    expect(screen.getByRole('button', { name: COMPARE })).toBeInTheDocument();
    expect(screen.getByText('utterance 1 · 2 arms · all succeeded')).toBeInTheDocument();
    // Card itself only appears on open.
    expect(document.querySelector('[data-blind-card]')).toBeNull();
  });
});

describe('AC2 — order re-randomized per open; draw recorded at open time', () => {
  it('rigged rng flips the order between opens and every open records a draw', async () => {
    const values = [0.9, 0.1];
    const rng = vi.fn(() => values.shift() ?? 0.5);
    const { ledger } = await startComparison({ rng });
    const drawSpy = vi.spyOn(ledger, 'recordBlindDraw');

    open();
    expect(screen.getByText('Compare blind')).toBeInTheDocument();
    expect(drawSpy).toHaveBeenCalledTimes(1);
    const draw1 = drawSpy.mock.calls[0]![0];
    expect(draw1.order).toEqual(SWAPPED_ORDER); // rng 0.9 >= .5 → swapped
    expect(draw1.utteranceId).toBe('utt-0'); // attaches to the session's records
    expect(typeof draw1.id).toBe('string');
    expect(draw1.id.length).toBeGreaterThan(0);
    expect(typeof draw1.createdAt).toBe('number');

    fireEvent.click(screen.getByRole('button', { name: CLOSE }));
    expect(screen.queryByText('Compare blind')).not.toBeInTheDocument();

    open();
    expect(drawSpy).toHaveBeenCalledTimes(2);
    const draw2 = drawSpy.mock.calls[1]![0];
    expect(draw2.order).toEqual(ACTIVE_ORDER); // rng 0.1 < .5 → active order
    expect(draw2.id).not.toBe(draw1.id);

    // Exactly one rng consumption per open (two arms → Fisher–Yates N−1 = 1).
    expect(rng).toHaveBeenCalledTimes(2);
  });
});

describe('AC3 — submit attaches scores to the open draw', () => {
  it('records scores under the drawId; revealed identities match the recorded order', async () => {
    const { ledger } = await startComparison({ rng: () => 0.1 }); // A=realtime, B=cascade
    const drawSpy = vi.spyOn(ledger, 'recordBlindDraw');
    const scoreSpy = vi.spyOn(ledger, 'recordBlindScores');

    open();
    const draw = drawSpy.mock.calls[0]![0];
    expect(draw.order).toEqual(ACTIVE_ORDER);

    fireEvent.click(within(samplePanel('A')).getByRole('button', { name: '4' }));
    fireEvent.click(within(samplePanel('B')).getByRole('button', { name: '2' }));
    expect(within(samplePanel('A')).getByRole('button', { name: '4' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect(within(samplePanel('B')).getByRole('button', { name: '2' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );

    fireEvent.click(screen.getByRole('button', { name: SUBMIT }));

    expect(scoreSpy).toHaveBeenCalledTimes(1);
    const scored = scoreSpy.mock.calls[0]![0];
    expect(scored.drawId).toBe(draw.id);
    expect(scored.scores).toEqual({ A: 4, B: 2 });
    expect(typeof scored.revealedAt).toBe('number');

    // Reveal: identities under the sample titles, matching the draw order.
    expect(within(samplePanel('A')).getByText('Realtime')).toBeInTheDocument();
    expect(within(samplePanel('B')).getByText('Cascade · OpenAI')).toBeInTheDocument();
    expect(screen.getByText(HINT_REVEALED)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'submitted' })).toBeInTheDocument();

    // Auditable end-to-end: the REAL ledger export carries the scored draw
    // attached to the session run (utteranceId matched a session record).
    const draws = ledger.exportRuns().runs.flatMap((r) => r.blindDraws);
    expect(draws).toHaveLength(1);
    expect(draws[0]!.id).toBe(draw.id);
    expect(draws[0]!.scores).toEqual({ A: 4, B: 2 });
    expect(draws[0]!.order).toEqual(ACTIVE_ORDER);
  });
});

describe('AC4 — identities hidden pre-submit', () => {
  it('arm labels are ABSENT from the card DOM; full pre-submit copy; no seeded scores', async () => {
    await startComparison({ rng: () => 0.1 });
    open();

    const card = blindCard();
    expect(within(card).queryByText('Realtime')).not.toBeInTheDocument();
    expect(within(card).queryByText('Cascade · OpenAI')).not.toBeInTheDocument();

    expect(within(card).getByText('Compare blind')).toBeInTheDocument();
    expect(within(card).getByText('Sample A')).toBeInTheDocument();
    expect(within(card).getByText('Sample B')).toBeInTheDocument();
    expect(screen.getByText(HINT_HIDDEN)).toBeInTheDocument();
    expect(screen.getByText(FOOTER_NOTE)).toBeInTheDocument();

    // Per-sample play buttons (named exactly 'play').
    expect(within(samplePanel('A')).getByRole('button', { name: 'play' })).toBeInTheDocument();
    expect(within(samplePanel('B')).getByRole('button', { name: 'play' })).toBeInTheDocument();

    // Each panel offers 1–5; ships built-but-unscored — nothing pre-selected.
    for (const key of ['A', 'B'] as const) {
      for (const n of ['1', '2', '3', '4', '5']) {
        expect(within(samplePanel(key)).getByRole('button', { name: n })).toBeInTheDocument();
      }
    }
    expect(card.querySelectorAll('button[aria-pressed="true"]')).toHaveLength(0);
  });
});

describe('AC5 — reopen after submit', () => {
  it('draws fresh, clears pickers, hides identities again', async () => {
    const values = [0.1, 0.9];
    const rng = vi.fn(() => values.shift() ?? 0.5);
    const { ledger } = await startComparison({ rng });
    const drawSpy = vi.spyOn(ledger, 'recordBlindDraw');

    open();
    fireEvent.click(within(samplePanel('A')).getByRole('button', { name: '5' }));
    fireEvent.click(within(samplePanel('B')).getByRole('button', { name: '1' }));
    fireEvent.click(screen.getByRole('button', { name: SUBMIT }));
    fireEvent.click(screen.getByRole('button', { name: CLOSE }));

    open();
    expect(drawSpy).toHaveBeenCalledTimes(2);
    const draw1 = drawSpy.mock.calls[0]![0];
    const draw2 = drawSpy.mock.calls[1]![0];
    expect(draw2.id).not.toBe(draw1.id);
    expect(draw2.order).toEqual(SWAPPED_ORDER); // second rigged value 0.9 → swapped

    const card = blindCard();
    expect(card.querySelectorAll('button[aria-pressed="true"]')).toHaveLength(0);
    expect(within(card).queryByText('Realtime')).not.toBeInTheDocument();
    expect(within(card).queryByText('Cascade · OpenAI')).not.toBeInTheDocument();
    expect(screen.getByText(HINT_HIDDEN)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: SUBMIT })).toBeInTheDocument();
    expect(screen.queryByText(HINT_REVEALED)).not.toBeInTheDocument();
  });
});
