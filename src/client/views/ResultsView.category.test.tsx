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
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { armLabel } from '../../core/arms';
import { RunLedger } from '../state/ledger';
import { formatMs, formatUsd, groupByCategory, groupByRecording } from '../components/results/derive';
import {
  CORPUS_CATEGORY_EXPECTATIONS,
  CORPUS_RECORDING_EXPECTATIONS,
  CORPUS_SAMPLES_PER_CATEGORY,
  CORPUS_SAMPLES_PER_RECORDING,
  CORPUS_VERSION,
  makeRecordingEntity,
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
      expect(within(row).getByText(formatMs(derived!.p50Ms))).toBeInTheDocument();
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
