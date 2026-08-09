/**
 * Ticket 032 — the by-category table, rendered NON-EMPTY for the first time.
 *
 * PRD §8 calls this grouping "where the heterogeneity actually lives … the
 * grouping that produces findings". It has rendered zero rows since it was
 * built, because no Run ever carried a single category — a Run spans ~4
 * utterances of deliberately different categories, so there is no one category
 * to write. With utterance records there is, and the table fills.
 *
 * The DOM contract these tests extend (documented in ResultsView.tsx):
 *   [data-category-row][data-category="<category>"]   one row
 *   [data-category-row][data-n="<n>"]                 that row's SAMPLE count
 *   inside it, [data-arm="<arm>"]                     the p50 cell
 * `data-n` is new in 032: N is the number this ticket exists to correct, and it
 * has to be assertable without reading a concatenated text blob.
 */

import '@testing-library/jest-dom/vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { armLabel } from '../../core/arms';
import { RunLedger } from '../state/ledger';
import { formatMs, formatUsd, groupByCategory, groupByRecording } from '../components/results/derive';
import {
  ARM_C_TRIPLE,
  CORPUS_CATEGORY_EXPECTATIONS,
  CORPUS_RECORDING_EXPECTATIONS,
  CORPUS_SAMPLES_PER_CATEGORY,
  CORPUS_SAMPLES_PER_RECORDING,
  CORPUS_VERSION,
  T0,
  makeRecordingEntity,
  makeRunEntity,
  makeUnstampedRunEntity,
  makeUtteranceRecord,
  runWithLatency,
  seedCorpusExclusionCases,
  seedCorpusSweep,
} from '../components/results/testRecords';
import ResultsView from './ResultsView';

afterEach(cleanup);

const TAB_SECONDARY = 'By Recording & category';

function showCorpusSecondaryTab(ledger: RunLedger) {
  const result = render(<ResultsView ledger={ledger} />);
  fireEvent.click(screen.getByRole('tab', { name: TAB_SECONDARY }));
  return result;
}

function corpusLedger(): RunLedger {
  const ledger = new RunLedger();
  seedCorpusSweep(ledger);
  return ledger;
}

function categoryRowEl(category: string): HTMLElement {
  const found = document.querySelector<HTMLElement>(
    `[data-category-row][data-category="${category}"]`,
  );
  if (!found) throw new Error(`missing category row: ${category}`);
  return found;
}

describe('ResultsView — the by-category table fills for a manifest-backed ledger', () => {
  it('renders one row per category, all six of them, in derivation order', () => {
    const ledger = corpusLedger();
    const rows = groupByCategory(ledger);
    showCorpusSecondaryTab(ledger);

    const rendered = Array.from(document.querySelectorAll('[data-category-row]')).map((r) =>
      r.getAttribute('data-category'),
    );
    expect(rendered).toHaveLength(CORPUS_CATEGORY_EXPECTATIONS.length);
    expect(rendered).toEqual(rows.map((r) => r.category));
    expect(new Set(rendered)).toEqual(
      new Set(CORPUS_CATEGORY_EXPECTATIONS.map((e) => e.category)),
    );
  });

  it.each(CORPUS_CATEGORY_EXPECTATIONS)(
    '$category renders its 10 samples with the derived p50/p95/cost',
    ({ category, p50Ms, p95Ms }) => {
      const ledger = corpusLedger();
      const row = groupByCategory(ledger).find((r) => r.category === category)!;
      showCorpusSecondaryTab(ledger);

      const el = categoryRowEl(category);
      expect(el.getAttribute('data-n')).toBe(String(CORPUS_SAMPLES_PER_CATEGORY));
      expect(el.getAttribute('data-n')).toBe(String(row.n));

      const p50Cell = el.querySelector('[data-arm="B"]');
      expect(p50Cell).not.toBeNull();
      expect((p50Cell!.textContent ?? '').trim()).toBe(formatMs(p50Ms));

      const text = el.textContent ?? '';
      expect(text).toContain(armLabel('B'));
      expect(text).toContain(formatMs(p95Ms));
      expect(text).toContain(formatUsd(row.costUsd));
    },
  );

  it('a Recording row reports 5 Runs and 20 samples — reps are not utterances', () => {
    const ledger = corpusLedger();
    showCorpusSecondaryTab(ledger);

    for (const { recordingId, p50Ms, p95Ms } of CORPUS_RECORDING_EXPECTATIONS) {
      const row = document.querySelector<HTMLElement>(
        `[data-recording-row][data-recording="${recordingId}"]`,
      );
      expect(row).not.toBeNull();
      const text = row!.textContent ?? '';
      expect(text).toContain(formatMs(p50Ms));
      expect(text).toContain(formatMs(p95Ms));
      // §8: "each aggregating that recording's 20 samples (4 utterances × 5 reps)".
      const derived = groupByRecording(ledger).find((r) => r.recordingId === recordingId)!;
      expect(derived.n).toBe(CORPUS_SAMPLES_PER_RECORDING);
    }
  });

  it('no excluded run’s records reach a rendered category row', () => {
    const ledger = corpusLedger();
    seedCorpusExclusionCases(ledger);
    showCorpusSecondaryTab(ledger);

    const rows = Array.from(document.querySelectorAll('[data-category-row]'));
    expect(rows).toHaveLength(CORPUS_CATEGORY_EXPECTATIONS.length);
    for (const row of rows) {
      const text = row.textContent ?? '';
      // Every excluded record is 5.00 s and $0.500 — impossible to miss.
      expect(text).not.toContain(formatMs(5_000));
      expect(text).not.toContain(formatUsd(0.5));
      expect(text).not.toContain(armLabel('ad-hoc'));
    }
  });
});

/* ================ TICKET 061 — direction reaches the rendered category row == */

/**
 * TICKET 061 — A SPLIT THE ROW CANNOT REPORT IS A SPLIT THE TABLE CANNOT SHOW.
 *
 * `derive.ts` keys category rows on `${category}|${arm}` and ResultsView keys
 * the RENDERED children on the same pair. Splitting only the derivation leaves
 * two rows sharing one React key — the pooling this ticket exists to remove
 * survives in the rendered output, and React reconciles two different
 * measurements onto one child.
 *
 * The DOM contract these tests add:
 *   [data-category-row][data-direction="<direction>"]   the row's direction
 * asserted the same way `data-n` is: as its own attribute, so the two
 * directions are distinguishable without parsing a concatenated text blob.
 */
describe('ResultsView — TICKET 061: two directions render as two rows', () => {
  const CATEGORY = 'numbers-dates';

  function directionLedger(): RunLedger {
    const ledger = new RunLedger();
    ledger.appendRecording(makeRecordingEntity({ id: 'rec-dir', label: 'direction clip' }));
    const seed = (direction: string, pair: string, latencyMs: number, id: string): void => {
      ledger.appendRun(
        runWithLatency(latencyMs, {
          id,
          recordingId: 'rec-dir',
          languagePair: pair,
          direction,
          annotations: {
            utteranceId: 'u1',
            category: CATEGORY,
            repIndex: 1,
            corpusVersion: CORPUS_VERSION,
          },
        }),
      );
    };
    seed('en→es', 'EN↔ES', 1_000, 'run-dir-es');
    seed('en→yue', 'EN↔YUE', 2_000, 'run-dir-yue');
    return ledger;
  }

  const categoryRows = (): HTMLElement[] =>
    Array.from(
      document.querySelectorAll<HTMLElement>(
        `[data-category-row][data-category="${CATEGORY}"]`,
      ),
    );

  it('renders one row per direction, each carrying its own direction and its own N', () => {
    const ledger = directionLedger();
    showCorpusSecondaryTab(ledger);

    const rendered = categoryRows();
    expect(rendered).toHaveLength(2);
    expect(rendered.map((r) => r.getAttribute('data-direction'))).toEqual(['en→es', 'en→yue']);
    expect(rendered.map((r) => r.getAttribute('data-n'))).toEqual(['1', '1']);
  });

  it('each rendered row shows its OWN p50 — the pooled figure appears nowhere', () => {
    const ledger = directionLedger();
    const rows = groupByCategory(ledger);
    showCorpusSecondaryTab(ledger);

    for (const row of categoryRows()) {
      const direction = row.getAttribute('data-direction');
      const derived = rows.find(
        (r) => (r as { direction?: string }).direction === direction,
      );
      expect(derived).toBeDefined();
      // Scoped to THIS row: a document-wide query would read the other one.
      //
      // getAllByText, not getByText: each row here holds n = 1, and nearest
      // rank makes p50 === p95 for a single sample, so the row renders the SAME
      // string in both cells. The original getByText threw
      // getMultipleElementsFoundError on that — an ambiguous query, not a
      // missing split. Widening the fixture to n = 2 is not the fix: the
      // sibling test pins data-n as ['1','1'].
      expect(within(row).getAllByText(formatMs(derived!.p50Ms)).length).toBeGreaterThan(0);
      // ...and the bite the original lacked. Containment alone would survive a
      // row that ALSO rendered the other direction's figure — which is exactly
      // what pooling looks like once the rows are split but the samples are not.
      const other = rows.find((r) => r !== derived);
      expect(other).toBeDefined();
      expect(within(row).queryByText(formatMs(other!.p50Ms))).toBeNull();
    }
    // The two directions differ by a full second, so a pooled row would render
    // one of these and not the other.
    expect(document.body.textContent).toContain(formatMs(1_000));
    expect(document.body.textContent).toContain(formatMs(2_000));
  });

  it('the two rows have DISTINCT React keys — a split derivation is not enough', () => {
    // React logs "Encountered two children with the same key" and then keeps
    // only one of them across updates. Splitting derive.ts while leaving
    // ResultsView keyed on `${category}|${arm}` is exactly that mutation.
    const errors: unknown[][] = [];
    const spy = vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      errors.push(args);
    });
    try {
      const ledger = directionLedger();
      showCorpusSecondaryTab(ledger);
      expect(categoryRows()).toHaveLength(2);
      const text = errors.map((args) => args.map(String).join(' ')).join('\n');
      expect(text).not.toMatch(/same key/i);
    } finally {
      spy.mockRestore();
    }
  });
});

/* ============= TICKET 061 follow-up — the direction an OPERATOR can read === */

/**
 * A SPLIT NOBODY CAN SEE IS HALF A SPLIT.
 *
 * 061 split the by-category rows on direction and stopped there: the table
 * rendered category / arm / N / p50 / p95 / cost / WER, so a mixed-direction
 * ledger produced two rows both reading "numbers-dates · Arm B", carrying
 * different numbers, with nothing on screen telling them apart. The direction
 * existed only in `data-direction` — a fact about this test harness, not about
 * the operator.
 *
 * That is this ticket's own headline complaint — two runs of the same clip,
 * indistinguishable in the record — reproduced one layer up. AC4 asks for "two
 * rows where one appeared before"; two rows a reader cannot tell apart deliver
 * half of it. EN→YUE and YUE→EN are separate claims (PRD §7) and the ASYMMETRY
 * BETWEEN THEM is the finding, so which row is which has to be legible.
 *
 * Every query below is scoped with `within(row)`. RTL appends each render to
 * the same document, so a document-wide accessor would happily match the other
 * direction's cell — which is exactly how a pooled table passes a split-table
 * test.
 */
describe('ResultsView — the by-category table shows WHICH DIRECTION each row is', () => {
  const CATEGORY = 'numbers-dates';

  /** Two rows that differ ONLY in the direction their parent Run recorded. */
  function mixedDirectionLedger(): RunLedger {
    const ledger = new RunLedger();
    ledger.appendRecording(makeRecordingEntity({ id: 'rec-vis', label: 'visible direction' }));
    const seed = (direction: string, pair: string, latencyMs: number, id: string): void => {
      ledger.appendRun(
        runWithLatency(latencyMs, {
          id,
          recordingId: 'rec-vis',
          languagePair: pair,
          direction,
          annotations: {
            utteranceId: 'u1',
            category: CATEGORY,
            repIndex: 1,
            corpusVersion: CORPUS_VERSION,
          },
        }),
      );
    };
    seed('en→es', 'EN↔ES', 1_000, 'run-vis-es');
    seed('en→yue', 'EN↔YUE', 2_000, 'run-vis-yue');
    return ledger;
  }

  const categoryRows = (): HTMLElement[] =>
    Array.from(
      document.querySelectorAll<HTMLElement>(`[data-category-row][data-category="${CATEGORY}"]`),
    );

  it('the header names a direction column', () => {
    showCorpusSecondaryTab(mixedDirectionLedger());
    const header = document.querySelector('[data-card="category"] [data-grid-header]');
    expect(header).not.toBeNull();
    expect(header!.textContent ?? '').toMatch(/direction/i);
  });

  it('each row renders its OWN direction as a visible cell — never the other row’s', () => {
    const ledger = mixedDirectionLedger();
    const derived = groupByCategory(ledger);
    showCorpusSecondaryTab(ledger);

    const rows = categoryRows();
    expect(rows).toHaveLength(2);

    for (const row of rows) {
      const direction = row.getAttribute('data-direction');
      expect(direction).not.toBeNull();

      // Scoped to THIS row. `within(row)` searches descendants only, so a cell
      // belonging to the sibling row cannot satisfy it.
      const cell = within(row).getByText(direction!);
      expect(cell).toHaveAttribute('data-category-direction');
      expect((cell.textContent ?? '').trim()).not.toBe('');

      const other = direction === 'en→es' ? 'en→yue' : 'en→es';
      expect(within(row).queryByText(other)).toBeNull();
    }

    // NOT A CONSTANT: the two rendered strings are the two different directions,
    // in derivation order. A hardcoded literal satisfies at most one of them.
    expect(derived.map((row) => row.direction)).toEqual(['en→es', 'en→yue']);
    expect(
      rows.map((row) => {
        const cell = within(row).getByText(row.getAttribute('data-direction')!);
        return (cell.textContent ?? '').trim();
      }),
    ).toEqual(['en→es', 'en→yue']);
  });

  it('the cell is the DERIVATION’s cell, verbatim — the view formats nothing', () => {
    // The idiom the cost column already follows: absence is decided in ONE
    // place, so no view can invent a blank for a direction nobody recorded.
    const ledger = mixedDirectionLedger();
    const derived = groupByCategory(ledger);
    showCorpusSecondaryTab(ledger);

    const rows = categoryRows();
    expect(rows).toHaveLength(derived.length);
    rows.forEach((row, index) => {
      const expected = derived[index]!.directionCell;
      expect(expected).not.toBe('');
      const cell = within(row).getByText(expected);
      expect(cell).toHaveAttribute('data-category-direction');
    });
  });

  it('ABSENCE IS NOT A BLANK, and the view cannot make it one', () => {
    // `isAggregatableRun` rejects a Run that recorded no direction, so NO
    // ledger can render a row with an absent one — which is exactly why the
    // absence branch cannot be reached through the DOM, and why the two halves
    // of the rule are pinned separately:
    //   1. the DERIVATION decides the cell   (derive.test.ts, formatDirection)
    //   2. the VIEW only reads it back       (here)
    // Without (2) a later hand-rolled `row.direction ?? ''` would reintroduce
    // the empty cell with every DOM test above still green.
    const source = readFileSync(
      resolve(process.cwd(), 'src/client/views/ResultsView.tsx'),
      'utf8',
    )
      .replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, ' '))
      .replace(/(^|[^:])\/\/[^\n]*/g, (_m, lead: string) => lead);

    expect(source).toContain('{row.directionCell}');
    // The two shapes that turn "never recorded" into a value the table shows
    // as nothing at all. `data-direction={row.direction}` is NOT one of them —
    // an omitted attribute is a readable absence; an empty text node is not —
    // so the element-body form is what is barred, and the attribute stays.
    expect(source).not.toMatch(/row\.direction\s*\?\?\s*''/);
    expect(source).not.toMatch(/>\s*\{\s*row\.direction\s*\}/);
    expect(source).toContain('data-direction={row.direction}');
  });
});

/* ==== 059 FOLLOW-UP — the By Category cost cell discloses its denominator === */

/**
 * A DENOMINATOR ON ONE TABLE AND NOT THE OTHER IS A HOLE THAT READS AS COMPLETE.
 *
 * 059 gave the By Recording row `N of M priced` beside its cost cell and gave
 * `CategoryGroupRow` the same `measuredCostSamples` field — then rendered only
 * `{row.costCell}` here. So the field was COMPUTED, DECLARED and read by
 * nobody, and an operator looking at the two tables on this one tab saw a
 * disclosed denominator beside one cost column and a bare figure beside the
 * other. There is no way to tell a fully priced category from a half-priced one
 * from the dollars: summing a missing cost as 0 and skipping it produce the
 * SAME total.
 *
 * The vocabulary is the By Recording row's, verbatim — `N of M priced` — because
 * both tables read the same records through the same `costOf`, and a second
 * phrasing for one fact is the thing `derive.ts:476` says the field exists to
 * prevent.
 *
 * Every query below is scoped with `within(row)`. RTL appends each render to the
 * same document, so a document-wide accessor would happily match the OTHER
 * row's denominator — and a table that rendered one denominator for everything
 * is exactly what that mistake lets through.
 */
describe('ResultsView — the by-category cost cell shows HOW MUCH of the row was priced', () => {
  const CATEGORY = 'short-reply';
  const REC_PARTIAL = 'rec-cat-cost-partial';
  const REC_UNSTAMPED = 'rec-cat-cost-unstamped';

  /**
   * Two rows of ONE category that differ only in how much of them was priced.
   * Different arms, because the row key is (category × arm × direction).
   *
   *   arm B — stamped, one record of two priced  → `1 of 2 priced`
   *   arm C — no price source at all             → `0 of 2 priced`
   */
  function mixedPricingLedger(): RunLedger {
    const ledger = new RunLedger();
    ledger.appendRecording(makeRecordingEntity({ id: REC_PARTIAL, label: 'partly priced clip' }));
    ledger.appendRecording(makeRecordingEntity({ id: REC_UNSTAMPED, label: 'unstamped clip' }));

    const records = (costs: Array<number | null>) =>
      costs.map((cost, i) =>
        makeUtteranceRecord({
          utteranceId: `u${i + 1}`,
          index: i + 1,
          category: CATEGORY,
          timings: { speech_end: T0, audio_queued: T0 + 700 + i },
          cost,
        }),
      );

    ledger.appendRun(
      makeRunEntity({
        id: 'run-cost-partial',
        recordingId: REC_PARTIAL,
        cost: 0.002,
        utterances: records([0.002, null]),
      }),
    );
    ledger.appendRun(
      makeUnstampedRunEntity({
        id: 'run-cost-unstamped',
        recordingId: REC_UNSTAMPED,
        providerTriple: { ...ARM_C_TRIPLE },
        modelSnapshots: { ...ARM_C_TRIPLE },
        armTag: 'C',
        cost: 0.002,
        utterances: records([0.002, 0.002]),
      }),
    );
    return ledger;
  }

  /** The rendered by-category rows, in derivation order. */
  const categoryRows = (): HTMLElement[] =>
    Array.from(
      document.querySelectorAll<HTMLElement>(
        `[data-card="category"] [data-category-row][data-category="${CATEGORY}"]`,
      ),
    );

  it('each row renders its OWN denominator, in the By Recording vocabulary', () => {
    const ledger = mixedPricingLedger();
    const derived = groupByCategory(ledger);
    showCorpusSecondaryTab(ledger);

    const rows = categoryRows();
    expect(rows).toHaveLength(2);
    // NOT A CONSTANT: the two rows disagree, so one hardcoded string satisfies
    // at most one of them — and a denominator collapsed onto n satisfies
    // neither.
    expect(derived.map((row) => [row.measuredCostSamples, row.n])).toEqual([
      [1, 2],
      [0, 2],
    ]);

    rows.forEach((row, index) => {
      const expected = derived[index]!;
      const cell = within(row).getByText(
        `${expected.measuredCostSamples} of ${expected.n} priced`,
      );
      expect(cell).toHaveAttribute('data-cost-samples');
      // ...and the money it qualifies sits in the same cell, so the two are
      // never read apart.
      expect(within(row).getByText(expected.costCell)).toBeInTheDocument();

      // The SIBLING row's denominator is not in this row. Scoped, so a
      // document-wide query cannot borrow it from the other row.
      const other = derived[index === 0 ? 1 : 0]!;
      expect(
        within(row).queryByText(`${other.measuredCostSamples} of ${other.n} priced`),
      ).toBeNull();
    });
  });

  it('the half-priced row and the unpriced row read DIFFERENTLY on screen', () => {
    // The failure this closes: two rows over the same category, the same N and
    // the same stored dollars, indistinguishable in the rendered table.
    showCorpusSecondaryTab(mixedPricingLedger());

    const rows = categoryRows();
    expect(rows).toHaveLength(2);
    expect(
      rows.map((row) => within(row).getByText(/priced$/).textContent?.trim()),
    ).toEqual(['1 of 2 priced', '0 of 2 priced']);
  });

  it('the denominator does not disturb the direction column 064 added', () => {
    // The cell rides INSIDE the cost column, exactly as By Recording's does, so
    // the row's identity attributes and its direction cell are untouched.
    showCorpusSecondaryTab(mixedPricingLedger());

    for (const row of categoryRows()) {
      expect(row.getAttribute('data-n')).toBe('2');
      expect(row.getAttribute('data-direction')).toBe('en→es');
      expect(within(row).getByText('en→es')).toHaveAttribute('data-category-direction');
    }
  });

  it('every rendered category row on the corpus ledger discloses a denominator', () => {
    // Not just the fixture built for this test: the six-category corpus table
    // has no row that shows a cost with no denominator beside it.
    const ledger = corpusLedger();
    const derived = groupByCategory(ledger);
    showCorpusSecondaryTab(ledger);

    const rows = Array.from(
      document.querySelectorAll<HTMLElement>('[data-card="category"] [data-category-row]'),
    );
    expect(rows).toHaveLength(derived.length);
    rows.forEach((row, index) => {
      const expected = derived[index]!;
      expect(expected.measuredCostSamples).toBe(CORPUS_SAMPLES_PER_CATEGORY);
      const cell = within(row).getByText(
        `${expected.measuredCostSamples} of ${expected.n} priced`,
      );
      expect(cell).toHaveAttribute('data-cost-samples');
    });
  });
});
