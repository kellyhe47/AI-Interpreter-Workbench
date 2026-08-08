/**
 * TICKET 051 ROUND 2 (R2-2) — the Results Live card must name its anchor.
 *
 * The conversation-length card's `p50 latency` / `p95 latency` rows sit on the
 * same screen as Experiment 1's p50 / p95, and the two are DIFFERENT
 * QUANTITIES: Replay's runs from the corpus manifest's annotated `speech_end`;
 * Live's runs from the instant the endpointer DECIDED the speaker had stopped,
 * because Live has no ground truth and never will. Publishing them side by side
 * under the same word, with no label anywhere, invites exactly the comparison
 * this ticket exists to prevent.
 *
 * ADDITIVE to the locked ResultsView.test.tsx.
 */

import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { REALTIME_MODEL } from '../../core/arms';
import { makeLiveSessionEntity } from '../components/results/testRecords';
import { RunLedger } from '../state/ledger';
import ResultsView from './ResultsView';

afterEach(cleanup);

const ANCHOR = 'from detected end of speech';

/** One measured, non-fixture Live session with endpointer-anchored marks. */
function ledgerWithLiveSession(): RunLedger {
  const ledger = new RunLedger();
  ledger.appendLiveSession(
    makeLiveSessionEntity({
      id: 'live-anchor-1',
      architecture: 'realtime',
      providerTriple: undefined,
      modelSnapshots: { realtime: REALTIME_MODEL },
      utterances: [
        { id: 'u-1', timings: { server_speech_stopped: 500, audio_queued: 1_740 }, costUsd: 0.02 },
      ],
      // A self-reported summary the utterances CANNOT produce: if the card
      // still shows 9.99 s it is reading the session's own field rather than
      // measuring the utterances it carries (R2-2's mean-of-p50s fallback).
      latency: { p50: 9_999, p95: 9_999, driftMinute1ToEnd: null },
      stability: { utterancesCompleted: 1, disconnects: 0, heapStart: null, heapEnd: null },
    }),
  );
  return ledger;
}

function liveCard(): HTMLElement {
  const card = document.querySelector('[data-card="live"]');
  if (card === null) throw new Error('expected the live card to render');
  return card as HTMLElement;
}

function textOf(el: Element | null): string {
  return (el?.textContent ?? '').replace(/\s+/g, ' ').trim();
}

describe('the Results Live card says which end of speech its latency is measured from', () => {
  it('the card states the anchor', () => {
    render(<ResultsView ledger={ledgerWithLiveSession()} />);
    expect(textOf(liveCard())).toContain(ANCHOR);
  });

  it('the figure it labels is the anchored one, not the session summary', () => {
    render(<ResultsView ledger={ledgerWithLiveSession()} />);
    // audio_queued 1740 − server_speech_stopped 500.
    expect(textOf(liveCard())).toContain('1.24 s');
    expect(textOf(liveCard())).not.toContain('9.99 s');
  });

  it('GUARD: the experiment cards do NOT borrow the Live anchor wording', () => {
    // Replay's figures are corpus-anchored. If this phrase leaks onto them,
    // the two quantities have been conflated in the other direction.
    render(<ResultsView ledger={ledgerWithLiveSession()} />);
    for (const card of document.querySelectorAll('[data-card]')) {
      if (card.getAttribute('data-card') === 'live') continue;
      expect(textOf(card), `card ${card.getAttribute('data-card')}`).not.toContain(ANCHOR);
    }
  });

  it('GUARD: an empty ledger still renders the plain empty state, digits and all', () => {
    const { container } = render(<ResultsView ledger={new RunLedger()} />);
    expect(container.textContent ?? '').not.toMatch(/\d/);
    expect(screen.queryByText(ANCHOR)).not.toBeInTheDocument();
  });
});
