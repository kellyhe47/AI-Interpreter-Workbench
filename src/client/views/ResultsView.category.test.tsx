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
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { armLabel } from '../../core/arms';
import { RunLedger } from '../state/ledger';
import { formatMs, formatUsd, groupByCategory, groupByRecording } from '../components/results/derive';
import {
  CORPUS_CATEGORY_EXPECTATIONS,
  CORPUS_RECORDING_EXPECTATIONS,
  CORPUS_SAMPLES_PER_CATEGORY,
  CORPUS_SAMPLES_PER_RECORDING,
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
