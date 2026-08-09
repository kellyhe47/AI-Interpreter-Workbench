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
import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { REALTIME_MODEL } from '../../core/arms';
import {
  makeLiveSessionEntity,
  seedCleanSweep,
  seedLiveSessions,
  seedTrimmedLiveSession,
} from '../components/results/testRecords';
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

/* ======================================================= TICKET 064 — policy */

/**
 * TICKET 064 — THE TRIMMED SESSIONS WERE NOT MISSING FROM THIS CARD. THEY WERE
 * IN THE WRONG COLUMN.
 *
 * `LIVE_COLUMNS` gave `realtime-trimmed` `arm: null` and `columnFor` returns
 * `undefined` for a null arm, so that column rendered absent UNCONDITIONALLY —
 * not because of data. Meanwhile `deriveLiveModel` grouped on the arm alone, and
 * a trimmed session is `architecture: realtime` + `modelSnapshots.realtime`, so
 * it derives arm A and its samples were pooled into `realtime · default`.
 *
 * So the visible bug (a blank column) and the reportable bug (a contaminated
 * p50 under `realtime · default`) are different facts, and only the second one
 * changes a claim in the write-up. EVERY EXPECTED FIGURE BELOW IS A LITERAL:
 * comparing the render against a `deriveLiveModel(ledger)` computed in the test
 * lets both sides move together and stay green while the pooling survives.
 *
 * Hand-derived, nearest rank sorted[⌈p·n⌉−1] (see `testRecords.ts`):
 *
 *   realtime · default  [1000, 1100, 1200]              p50 1100  p95 1200
 *   realtime · trimmed  [4000, 4100]                    p50 4000  p95 4100
 *   POOLED (the bug)    [1000, 1100, 1200, 4000, 4100]  p50 1200  p95 4100
 *
 *   cost/min, first · final     default  $0.120 · $0.300
 *                               trimmed  $0.500 · $0.800
 *                               POOLED (their mean)  $0.310 · $0.550
 */

/** Arm A · default (3 turns), arm A · trimmed (2 turns), arm B · n/a (3 turns). */
function policyLedger(): RunLedger {
  const ledger = new RunLedger();
  seedLiveSessions(ledger);
  seedTrimmedLiveSession(ledger);
  return ledger;
}

function liveCell(metric: string, column: string): string {
  const found = document.querySelector(
    `[data-card="live"] [data-metric="${metric}"] [data-live-column="${column}"]`,
  );
  if (found === null) throw new Error(`missing live cell: ${metric}/${column}`);
  return (found.textContent ?? '').trim();
}

describe('the Results Live card keeps the two context policies apart (TICKET 064)', () => {
  it('DOMINANT — realtime · default shows the DEFAULT-only p50, not the pooled one', () => {
    render(<ResultsView ledger={policyLedger()} />);

    expect(liveCell('p50', 'realtime-default')).toBe('1.10 s');
    // 1.20 s is the figure the trimmed session's turns drag it to. It is the
    // number §7's controllability comparison would otherwise have been read off.
    expect(liveCell('p50', 'realtime-default')).not.toBe('1.20 s');
    expect(liveCell('p95', 'realtime-default')).toBe('1.20 s');
    expect(liveCell('p95', 'realtime-default')).not.toBe('4.10 s');
    // ...and the trimmed session's turns and drops are not counted here.
    expect(liveCell('utterances', 'realtime-default')).toBe('3');
    expect(liveCell('disconnects', 'realtime-default')).toBe('1');
  });

  it('realtime · trimmed renders its OWN figures rather than a dash', () => {
    render(<ResultsView ledger={policyLedger()} />);

    expect(liveCell('p50', 'realtime-trimmed')).toBe('4.00 s');
    expect(liveCell('p95', 'realtime-trimmed')).toBe('4.10 s');
    expect(liveCell('utterances', 'realtime-trimmed')).toBe('2');
    expect(liveCell('disconnects', 'realtime-trimmed')).toBe('2');
    for (const metric of ['p50', 'p95', 'utterances', 'disconnects']) {
      expect(liveCell(metric, 'realtime-trimmed'), metric).not.toBe('—');
    }
  });

  it('a coerced arm cannot satisfy this: the two realtime columns disagree', () => {
    render(<ResultsView ledger={policyLedger()} />);
    // `columnFor(column.arm as ArmTag)` would find the same arm-A column twice
    // and print one set of figures under both labels. The column identity has
    // to be the PAIR, so these must differ on every row that has a figure.
    for (const metric of ['p50', 'p95', 'utterances', 'disconnects', 'cost-final-minute']) {
      expect(
        liveCell(metric, 'realtime-default'),
        `${metric} is identical in both realtime columns`,
      ).not.toBe(liveCell(metric, 'realtime-trimmed'));
    }
  });

  it('the COST SLOPE rows read from the same per-pair column as the latency rows', () => {
    render(<ResultsView ledger={policyLedger()} />);

    expect(liveCell('cost-minute-1', 'realtime-default')).toBe('$0.120');
    expect(liveCell('cost-final-minute', 'realtime-default')).toBe('$0.300');
    expect(liveCell('cost-minute-1', 'realtime-trimmed')).toBe('$0.500');
    expect(liveCell('cost-final-minute', 'realtime-trimmed')).toBe('$0.800');
    // Pooled, both rows are the MEAN of the two policies. The slope is the
    // whole finding for Arm A, so a pooled slope is not a smaller error than a
    // pooled p50 — it is the same error on the row that carries the claim.
    expect(liveCell('cost-minute-1', 'realtime-default')).not.toBe('$0.310');
    expect(liveCell('cost-final-minute', 'realtime-default')).not.toBe('$0.550');
  });

  it("cascade stays ONE column — 'n/a' is not a policy that splits arm B", () => {
    render(<ResultsView ledger={policyLedger()} />);

    // Arm B's utterances are [600, 700, 800] -> p50 700.
    expect(liveCell('p50', 'cascade')).toBe('0.70 s');
    expect(liveCell('utterances', 'cascade')).toBe('3');
    // Still exactly three columns: no `cascade · n/a` fourth one appeared.
    const headers = document.querySelectorAll(
      '[data-card="live"] [data-grid-header] [data-live-column]',
    );
    expect(Array.from(headers).map((h) => h.getAttribute('data-live-column'))).toEqual([
      'realtime-default',
      'realtime-trimmed',
      'cascade',
    ]);
  });
});

/** A pre-012 session: real, measured, arm A — and declaring NO policy at all. */
function prePolicySession() {
  return makeLiveSessionEntity({
    id: 'live-pre-012',
    architecture: 'realtime',
    providerTriple: undefined,
    // Optional on LiveSession precisely so pre-012 sessions still parse.
    contextPolicy: undefined,
    modelSnapshots: { realtime: REALTIME_MODEL },
    utterances: [9_000, 9_100].map((ms, i) => ({
      id: `lu-pre-${i + 1}`,
      timings: { server_speech_stopped: 0, audio_queued: ms },
      costUsd: 1,
    })),
    latency: { p50: 9_000, p95: 9_100, driftMinute1ToEnd: 700 },
    cost: { totalUsd: 2, perMinuteMinute1: 0.9, perMinuteFinalMinute: 0.9 },
    stability: { utterancesCompleted: 2, disconnects: 0, heapStart: null, heapEnd: null },
  });
}

describe('the Results Live card DISCLOSES a session that declared no context policy', () => {
  it('does not fold it into realtime · default', () => {
    const ledger = new RunLedger();
    seedLiveSessions(ledger);
    ledger.appendLiveSession(prePolicySession());
    render(<ResultsView ledger={ledger} />);

    // Pooled with [9000, 9100] the default column answers 1.20 s and 5 turns.
    expect(liveCell('p50', 'realtime-default')).toBe('1.10 s');
    expect(liveCell('p50', 'realtime-default')).not.toBe('1.20 s');
    expect(liveCell('utterances', 'realtime-default')).toBe('3');
    // ...and it did not quietly become the trimmed column either.
    expect(liveCell('p50', 'realtime-trimmed')).toBe('—');
  });

  it('says so on the card, rather than dropping it in silence', () => {
    const ledger = new RunLedger();
    seedLiveSessions(ledger);
    ledger.appendLiveSession(prePolicySession());
    render(<ResultsView ledger={ledger} />);

    // Wording is the implementation's to choose; the disclosure is not
    // optional. A session excluded from every column is a hole in the evidence
    // and the card is the only place it can be reported.
    const text = textOf(liveCard());
    expect(text).toMatch(/exclud/i);
    expect(text).toMatch(/context polic/i);
  });

  it('GUARD: a ledger where every session declares a policy discloses no exclusion', () => {
    render(<ResultsView ledger={policyLedger()} />);
    // Otherwise the disclosure above is satisfiable by a constant string.
    expect(textOf(liveCard())).not.toMatch(/exclud/i);
  });
});

/* ========================================== TICKET 064 — ADVERSARIAL REVIEW */

/**
 * FINDING 2 — NOTHING PINNED A HEADER LABEL TO ITS COLUMN KEY.
 *
 * Every accessor in this file, and every one in the locked ResultsView.test.tsx,
 * addresses a cell by `data-live-column`. The two `label` strings in
 * `LIVE_COLUMNS` could therefore be swapped with the whole suite green, and the
 * card would render `realtime · trimmed` above the DEFAULT-policy figures and
 * `realtime · default` above the trimmed ones — this ticket's own failure mode,
 * a number published under the wrong policy name, moved from the derivation into
 * the header row. The existing check (ResultsView.test.tsx) only asserts both
 * strings appear SOMEWHERE in the card, which a swap satisfies exactly.
 *
 * So the assertion has to travel through the key: read the header cell BY its
 * `data-live-column`, and require the label above the figures that cell governs.
 */

/** The header cell for `key`, scoped to the render under test (RTL appends). */
function liveHeaderCell(container: HTMLElement, key: string): HTMLElement {
  const card = container.querySelector('[data-card="live"]');
  if (card === null) throw new Error('expected the live card to render');
  const cell = card.querySelector(`[data-grid-header] [data-live-column="${key}"]`);
  if (cell === null) throw new Error(`missing live header cell: ${key}`);
  return cell as HTMLElement;
}

describe('the Results Live card labels each column with ITS OWN name (TICKET 064)', () => {
  const HEADERS: ReadonlyArray<{ key: string; label: string }> = [
    { key: 'realtime-default', label: 'realtime · default' },
    { key: 'realtime-trimmed', label: 'realtime · trimmed' },
    { key: 'cascade', label: 'cascade' },
  ];

  it.each(HEADERS)('the $key column is headed "$label"', ({ key, label }) => {
    const { container } = render(<ResultsView ledger={policyLedger()} />);
    const cell = liveHeaderCell(container, key);

    // Scoped to the cell the key selects, so a swapped pair of labels cannot
    // satisfy this by appearing elsewhere in the card.
    expect(within(cell).getByText(label)).toBeInTheDocument();
    expect(cell.textContent?.trim()).toBe(label);
  });

  it('DOMINANT — the header above the DEFAULT-only p50 says default, not trimmed', () => {
    const { container } = render(<ResultsView ledger={policyLedger()} />);

    // 1.10 s is the default-only p50 and 4.00 s the trimmed one (hand-derived
    // above). Pairing each figure with the header of the SAME key is what makes
    // a label swap a failing test rather than a cosmetic one.
    expect(liveHeaderCell(container, 'realtime-default').textContent?.trim()).toBe(
      'realtime · default',
    );
    expect(liveCell('p50', 'realtime-default')).toBe('1.10 s');
    expect(liveHeaderCell(container, 'realtime-trimmed').textContent?.trim()).toBe(
      'realtime · trimmed',
    );
    expect(liveCell('p50', 'realtime-trimmed')).toBe('4.00 s');
  });
});

/**
 * FINDING 3 — THE EXCLUSION COUNT WAS NEVER ASSERTED, ANYWHERE.
 *
 * The only nonzero-path assertions were the regexes /exclud/i and /context
 * polic/i above: they pin that a sentence appears, never that the NUMBER in it
 * is the number of excluded sessions. Replacing the count with a constant 99 on
 * the nonzero path left the suite green, and the card then printed "99 sessions
 * excluded from every column" — a fabricated count, in the ticket whose thesis
 * is that a wrong number is worse than a missing one, on the one line that
 * exists to say how big the hole in the evidence is.
 *
 * The singular/plural branch is pinned for the same reason: it is the only other
 * thing the sentence computes.
 */

/** A pre-012 session under a caller-chosen id, so a ledger can hold several. */
function prePolicySessionNamed(id: string) {
  return makeLiveSessionEntity({
    id,
    architecture: 'realtime',
    providerTriple: undefined,
    contextPolicy: undefined,
    modelSnapshots: { realtime: REALTIME_MODEL },
    utterances: [8_000, 8_100].map((ms, i) => ({
      id: `${id}-u${i + 1}`,
      timings: { server_speech_stopped: 0, audio_queued: ms },
      costUsd: 1,
    })),
    latency: { p50: 8_000, p95: 8_100, driftMinute1ToEnd: 700 },
    cost: { totalUsd: 2, perMinuteMinute1: 0.9, perMinuteFinalMinute: 0.9 },
    stability: { utterancesCompleted: 2, disconnects: 0, heapStart: null, heapEnd: null },
  });
}

describe('the Results Live card reports HOW MANY sessions it excluded (TICKET 064)', () => {
  it('DOMINANT — one excluded session is disclosed as "1 session", not as some other count', () => {
    const ledger = new RunLedger();
    seedLiveSessions(ledger);
    ledger.appendLiveSession(prePolicySession());
    render(<ResultsView ledger={ledger} />);

    const text = textOf(liveCard());
    expect(text).toContain('1 session excluded');
    // A constant in place of the count publishes a fabricated number under a
    // sentence that reads as a measurement.
    expect(text).not.toMatch(/\b(?!1\b)\d+ sessions? excluded/);
  });

  it('two excluded sessions read "2 sessions" — the count is derived and the noun agrees', () => {
    const ledger = new RunLedger();
    seedLiveSessions(ledger);
    ledger.appendLiveSession(prePolicySession());
    ledger.appendLiveSession(prePolicySessionNamed('live-pre-012-b'));
    render(<ResultsView ledger={ledger} />);

    const text = textOf(liveCard());
    expect(text).toContain('2 sessions excluded');
    expect(text).not.toContain('1 session excluded');
    // ...and the singular noun is not printed for a plural count.
    expect(text).not.toContain('2 session excluded');
  });

  it('GUARD: the singular case does not print the plural noun', () => {
    const ledger = new RunLedger();
    seedLiveSessions(ledger);
    ledger.appendLiveSession(prePolicySession());
    render(<ResultsView ledger={ledger} />);

    expect(textOf(liveCard())).not.toContain('1 sessions excluded');
  });
});

/**
 * FINDING 4 — THE EXCLUSION NOTE WAS UNTESTED ON THE `empty` BRANCH.
 *
 * A ledger whose sessions ALL lack a context policy derives no column at all
 * (`deriveLive.anchor.test.ts` pins that), so the card takes its `model.empty`
 * path. Deleting the disclosure from that branch left the suite green, and the
 * card then rendered the plain "no live sessions recorded" empty state over
 * evidence that had been thrown away — exactly the hole-that-reads-as-complete
 * the code comment beside `LiveExclusionNote` says it exists to prevent. The
 * empty state is the branch where the omission is WORST: there is no other
 * figure on the card to hint that anything was measured at all.
 *
 * The ledger carries a Replay sweep as well, because `resultsAreEmpty` blanks
 * the WHOLE view (no cards at all) when the live model is empty and every
 * recording is fixture-only — so a ledger of nothing but policy-less sessions
 * never reaches `LiveCard`. Runs present, live sessions all policy-less, is the
 * state in which this branch actually renders.
 */
describe('the Results Live EMPTY card still discloses the exclusion (TICKET 064)', () => {
  function policylessOnlyLedger(): RunLedger {
    const ledger = new RunLedger();
    seedCleanSweep(ledger);
    ledger.appendLiveSession(prePolicySession());
    return ledger;
  }

  it('DOMINANT — a ledger of nothing but policy-less sessions says why the card is empty', () => {
    render(<ResultsView ledger={policylessOnlyLedger()} />);

    const text = textOf(liveCard());
    expect(text).toMatch(/exclud/i);
    expect(text).toMatch(/context polic/i);
    // The count is derived on this branch too, not just on the populated one.
    expect(text).toContain('1 session excluded');
  });

  it('it is the empty state that carries it — no column was derived to hang it on', () => {
    const { container } = render(<ResultsView ledger={policylessOnlyLedger()} />);

    // No column headers at all: the card really is on the `model.empty` path,
    // so the disclosure above cannot have come from the populated branch.
    expect(
      container.querySelectorAll('[data-card="live"] [data-grid-header] [data-live-column]'),
    ).toHaveLength(0);
    expect(within(liveCard()).getByText(/no live/i)).toBeInTheDocument();
  });

  it('GUARD: the same card with no policy-less session discloses NOTHING', () => {
    // Otherwise the empty-branch disclosure is satisfiable by a constant.
    const ledger = new RunLedger();
    seedCleanSweep(ledger);
    render(<ResultsView ledger={ledger} />);

    expect(textOf(liveCard())).toMatch(/no live sessions/i);
    expect(textOf(liveCard())).not.toMatch(/exclud/i);
  });
});
