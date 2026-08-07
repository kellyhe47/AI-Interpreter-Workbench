/**
 * TICKET 034 — the client ledger's post-hoc WER store, and the hydration seam
 * that brings server-persisted scores into it.
 *
 * PRD §8 wants ONE ledger under every view. A WER computed on one machine has
 * to reach Results on another, and it does that through the same append-only
 * discipline every other store here uses:
 *
 * - APPEND-ONLY. `appendWerScore` never rewrites an earlier score, so
 *   re-scoring a corpus is a SECOND record and the first one survives.
 * - LAST WRITE WINS ON READ. `getWerScore(runId, utteranceId)` collapses the
 *   history, delegating to `latestWerScores` so the rule has one definition.
 * - THREE DISTINCT ANSWERS. `undefined` (never scored), `wer: null`
 *   (`not applicable`) and a number are three different facts, and a reader
 *   that cannot tell them apart cannot render Cantonese honestly.
 * - HYDRATION DEDUPES ON (runId, utteranceId, scoredAt), not on identity: a
 *   score has no id, and a genuine re-score must still land.
 */
import { describe, expect, it, vi } from 'vitest';

import { WER_NORMALIZATION_VERSION, type WerScore } from '../../core/wer';
import { hydrateLedger } from './hydrateLedger';
import { LEDGER_STORAGE_KEY, RunLedger } from './ledger';

function score(overrides: Partial<WerScore> = {}): WerScore {
  return {
    runId: 'run-1',
    utteranceId: 'u-1',
    wer: 0.25,
    referenceText: 'The quick brown fox.',
    hypothesisText: 'the quick brown ox',
    normalizationVersion: WER_NORMALIZATION_VERSION,
    scoredAt: 1_700_000_000_000,
    ...overrides,
  };
}

const NOT_APPLICABLE: WerScore = score({
  runId: 'run-yue',
  utteranceId: 'y-1',
  wer: null,
  notApplicableReason: 'no-reference-text',
  referenceText: null,
  hypothesisText: '你好嗎',
});

/** A minimal in-memory storage adapter, matching the ledger's own subset. */
function memoryStorage(): { getItem(k: string): string | null; setItem(k: string, v: string): void; blob(): string | null } {
  const map = new Map<string, string>();
  return {
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => {
      map.set(k, v);
    },
    blob: () => map.get(LEDGER_STORAGE_KEY) ?? null,
  };
}

describe('ticket 034 — appendWerScore / getWerScores', () => {
  it('AC1: scores come back in APPEND order, deep-copied both ways', () => {
    const ledger = new RunLedger();
    const original = score();
    ledger.appendWerScore(original);
    ledger.appendWerScore(score({ utteranceId: 'u-2', wer: 0.5 }));

    expect(ledger.getWerScores().map((s) => [s.utteranceId, s.wer])).toEqual([
      ['u-1', 0.25],
      ['u-2', 0.5],
    ]);

    // Mutating what was handed in, or what was read back, must not rewrite a
    // recorded measurement.
    original.wer = 99;
    const read = ledger.getWerScores();
    read[0]!.wer = 42;
    expect(ledger.getWerScores()[0]!.wer).toBe(0.25);
  });

  it('AC1: getWerScore is keyed by (runId, utteranceId) and nothing else', () => {
    const ledger = new RunLedger();
    ledger.appendWerScore(score({ runId: 'run-a', utteranceId: 'u-1', wer: 0.1 }));
    ledger.appendWerScore(score({ runId: 'run-b', utteranceId: 'u-1', wer: 0.9 }));

    expect(ledger.getWerScore('run-a', 'u-1')!.wer).toBe(0.1);
    expect(ledger.getWerScore('run-b', 'u-1')!.wer).toBe(0.9);
    expect(ledger.getWerScore('run-a', 'u-2')).toBeUndefined();
    expect(ledger.getWerScore('run-c', 'u-1')).toBeUndefined();
  });

  it('AC3: NOT SCORED, NOT APPLICABLE and a real 0 are three different answers', () => {
    const ledger = new RunLedger();
    ledger.appendWerScore(NOT_APPLICABLE);
    ledger.appendWerScore(score({ runId: 'run-perfect', utteranceId: 'u-1', wer: 0 }));

    // never scored
    expect(ledger.getWerScore('run-1', 'u-1')).toBeUndefined();
    // not applicable — Cantonese has no script (PRD §9)
    const na = ledger.getWerScore('run-yue', 'y-1')!;
    expect(na.wer).toBeNull();
    expect(na.wer).not.toBe(0);
    expect(na.notApplicableReason).toBe('no-reference-text');
    // a genuine perfect transcript
    expect(ledger.getWerScore('run-perfect', 'u-1')!.wer).toBe(0);
    expect(ledger.getWerScore('run-perfect', 'u-1')!.notApplicableReason).toBeUndefined();
  });

  it('AC6: re-scoring APPENDS — last write wins on read, history survives', () => {
    const ledger = new RunLedger();
    ledger.appendWerScore(score({ wer: 0.9, scoredAt: 1 }));
    ledger.appendWerScore(score({ wer: 0.1, scoredAt: 2 }));

    expect(ledger.getWerScore('run-1', 'u-1')!.wer).toBe(0.1);
    // The earlier line is STILL THERE — that is what append-only buys.
    expect(ledger.getWerScores().map((s) => s.wer)).toEqual([0.9, 0.1]);
  });

  it('AC1: the scores ride the persisted blob and survive a reload', () => {
    const storage = memoryStorage();
    new RunLedger(storage).appendWerScore(score());

    const restored = new RunLedger(storage);
    expect(restored.getWerScore('run-1', 'u-1')!.wer).toBe(0.25);
  });

  it('AC1: a PRE-034 blob has no werScores key and restores as empty', () => {
    const storage = memoryStorage();
    storage.setItem(
      LEDGER_STORAGE_KEY,
      JSON.stringify({ records: [], blindDraws: [], recordings: [], runs: [], liveSessions: [] }),
    );

    const ledger = new RunLedger(storage);
    expect(ledger.getWerScores()).toEqual([]);
    expect(ledger.getWerScore('run-1', 'u-1')).toBeUndefined();
  });

  it('AC1: scores are NOT in LedgerExport, so importRuns cannot discard them', () => {
    const ledger = new RunLedger();
    ledger.appendWerScore(score());
    const exported = ledger.exportRuns();

    // The export envelope's shape is pinned by the locked ticket-009 tests, so
    // 034 rides beside it exactly as ticket 016's comparisons do.
    expect(JSON.stringify(exported)).not.toContain('normalizationVersion');
    ledger.importRuns(exported);
    expect(ledger.getWerScore('run-1', 'u-1')!.wer).toBe(0.25);
  });
});

/* ================================================== the hydration seam ===== */

describe('ticket 034 — hydrateLedger loads server-persisted WER scores', () => {
  const emptyRest = {
    recordings: { list: async () => [] },
    runs: { list: async () => [] },
  };

  it('AC4: the scores listing is loaded into the SAME ledger every view reads', async () => {
    const ledger = new RunLedger();

    await hydrateLedger(ledger, {
      ...emptyRest,
      werScores: { list: async () => [score(), NOT_APPLICABLE] },
    });

    expect(ledger.getWerScores()).toHaveLength(2);
    expect(ledger.getWerScore('run-1', 'u-1')!.wer).toBe(0.25);
    expect(ledger.getWerScore('run-yue', 'y-1')!.wer).toBeNull();
  });

  it('AC4: a host that wires NO werScores listing leaves the store untouched', async () => {
    const ledger = new RunLedger();
    ledger.appendWerScore(score());

    await hydrateLedger(ledger, emptyRest);

    expect(ledger.getWerScores()).toHaveLength(1);
  });

  it('AC6: hydrating twice does not duplicate, but a genuine RE-SCORE still lands', async () => {
    const ledger = new RunLedger();
    const first = score({ wer: 0.9, scoredAt: 1 });
    const list = vi.fn(async () => [first]);

    await hydrateLedger(ledger, { ...emptyRest, werScores: { list } });
    await hydrateLedger(ledger, { ...emptyRest, werScores: { list } });
    expect(ledger.getWerScores()).toHaveLength(1);

    // A score has NO id, so identity cannot be the dedupe key: re-scoring the
    // same atom is a legitimate second record and must not be swallowed.
    const rescored = score({ wer: 0.1, scoredAt: 2 });
    await hydrateLedger(ledger, { ...emptyRest, werScores: { list: async () => [first, rescored] } });

    expect(ledger.getWerScores()).toHaveLength(2);
    expect(ledger.getWerScore('run-1', 'u-1')!.wer).toBe(0.1);
  });

  it('AC4: a rejected scores listing fails the whole hydration atomically', async () => {
    const ledger = new RunLedger();

    await expect(
      hydrateLedger(ledger, {
        ...emptyRest,
        werScores: {
          list: async () => {
            throw new Error('backend unreachable');
          },
        },
      }),
    ).rejects.toThrow(/unreachable/);

    // Nothing landed: a half-hydrated ledger reads exactly like a real empty
    // one, which is the failure mode PRD §12 forbids.
    expect(ledger.getWerScores()).toEqual([]);
  });
});
