/**
 * TICKET 034 — post-hoc WER scores get their OWN append-only stream.
 *
 * THE DEFECT: WER is one of four measured quality dimensions and there was no
 * server-side WER anywhere — no file, no storage method, no route. PRD §9 had
 * the Spanish coworker read VERBATIM rather than improvise solely so a Spanish
 * WER would exist, and nothing could store one.
 *
 * WHY A SEPARATE STREAM AND NOT A FIELD ON THE RUN. WER is scored AFTER a run,
 * and the Run store deliberately has no update route: it is append-only, so
 * "add a number to an existing record" is not an operation it has. A score is a
 * second, later fact about an (runId, utteranceId) pair. It gets its own
 * destination, Runs stay immutable, and a corpus can be re-scored without
 * rewriting history.
 *
 * THE PRECEDENTS MIRRORED HERE are ticket 023's comparison stream and ticket
 * 041's live-session stream: own file, append-only, tolerant reader, record
 * stored VERBATIM.
 *
 *   wer-scores.jsonl      append-only, ONE LINE PER SCORE
 *   appendWerScore(score) -> the score, VERBATIM
 *   listWerScores()       -> every stored score, in write order, uncollapsed
 *
 * Every test runs against a `mkdtemp` base directory.
 */
import fs from 'node:fs/promises';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { latestWerScores } from '../../core/wer';
import { createStorage } from './index';
import type { Storage, WerScore } from './index';
import {
  LAYOUT,
  exists,
  makeNotApplicableWerScore,
  makeRun,
  makeTempBase,
  makeWerScore,
  removeTempBase,
} from './test-support';

let dir: string;
let store: Storage;

beforeEach(async () => {
  dir = await makeTempBase();
  store = createStorage(dir);
});

afterEach(async () => {
  await removeTempBase(dir);
});

/** Every parsed line of the append-only score file, in write order. */
async function lines(): Promise<WerScore[]> {
  const text = await fs.readFile(LAYOUT.werScores(dir), 'utf8');
  return text
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as WerScore);
}

describe('ticket 034 — appendWerScore / listWerScores round trip', () => {
  it('AC1: a score is stored VERBATIM and listed back field-for-field', async () => {
    const score = makeWerScore();

    expect(await store.appendWerScore(score)).toEqual(score);
    expect(await store.listWerScores()).toEqual([score]);
    expect(await lines()).toEqual([score]);
  });

  it('AC1: a score is keyed by (runId, utteranceId), so one run has many', async () => {
    await store.appendWerScore(makeWerScore({ runId: 'run-1', utteranceId: 'u-1', wer: 0.1 }));
    await store.appendWerScore(makeWerScore({ runId: 'run-1', utteranceId: 'u-2', wer: 0.2 }));
    await store.appendWerScore(makeWerScore({ runId: 'run-2', utteranceId: 'u-1', wer: 0.3 }));

    expect((await store.listWerScores()).map((s) => [s.runId, s.utteranceId, s.wer])).toEqual([
      ['run-1', 'u-1', 0.1],
      ['run-1', 'u-2', 0.2],
      ['run-2', 'u-1', 0.3],
    ]);
  });

  it('AC1: an empty store lists an empty array, not an ENOENT', async () => {
    expect(await store.listWerScores()).toEqual([]);
    expect(await exists(LAYOUT.werScores(dir))).toBe(false);
  });

  it('AC1: a second store on the same base directory sees the write', async () => {
    await store.appendWerScore(makeWerScore({ utteranceId: 'u-shared' }));

    expect((await createStorage(dir).listWerScores()).map((s) => s.utteranceId)).toEqual([
      'u-shared',
    ]);
  });

  it('AC3: a NOT-APPLICABLE score is stored like any other — null, never 0', async () => {
    // Cantonese has no written script (PRD §9). Refusing to store the fact
    // would leave the row indistinguishable from "nobody has scored it yet".
    const na = makeNotApplicableWerScore();
    expect(na.wer).toBeNull();

    expect(await store.appendWerScore(na)).toEqual(na);
    const [stored] = await store.listWerScores();
    expect(stored!.wer).toBeNull();
    expect(stored!.wer).not.toBe(0);
    expect(stored!.notApplicableReason).toBe('no-reference-text');
  });

  it('AC3: a null wer survives the JSONL round trip as null, not as absent', async () => {
    await store.appendWerScore(makeNotApplicableWerScore());
    const [raw] = await lines();
    expect(Object.keys(raw!)).toContain('wer');
    expect(raw!.wer).toBeNull();
  });

  it('AC4: a score whose wer exceeds 1.0 is stored unclamped', async () => {
    // A one-word reference against a three-word hallucination is WER 2.0.
    // Clamping on the way in would make a babbling arm look like a silent one.
    await store.appendWerScore(makeWerScore({ wer: 2 }));
    expect((await store.listWerScores())[0]!.wer).toBe(2);
  });
});

describe('ticket 034 — the WER stream is APPEND-ONLY and RUNS ARE NEVER MUTATED', () => {
  it('AC6: re-scoring the same key writes a SECOND line — the first survives', async () => {
    const first = makeWerScore({ wer: 0.5, scoredAt: 1 });
    const second = makeWerScore({ wer: 0.1, scoredAt: 2 });

    await store.appendWerScore(first);
    await store.appendWerScore(second);

    // Both lines are on disk: the history is the point of an append-only file.
    expect(await lines()).toEqual([first, second]);
    expect(await store.listWerScores()).toEqual([first, second]);
    // LAST WRITE WINS is a READ-SIDE collapse, never a rewrite.
    expect(latestWerScores(await store.listWerScores())).toEqual([second]);
  });

  it('AC2: appending a score does not touch the Run it is about', async () => {
    const run = makeRun({ id: 'run-1' });
    await store.appendRun(run);
    const ledgerBefore = await fs.readFile(LAYOUT.ledger(dir), 'utf8');
    const runJsonBefore = await fs.readFile(LAYOUT.runJson(dir, 'run-1'), 'utf8');

    await store.appendWerScore(makeWerScore({ runId: 'run-1' }));

    expect(await fs.readFile(LAYOUT.ledger(dir), 'utf8')).toBe(ledgerBefore);
    expect(await fs.readFile(LAYOUT.runJson(dir, 'run-1'), 'utf8')).toBe(runJsonBefore);
    expect(await store.listRuns()).toEqual([run]);
    expect(await store.readLedger()).toEqual([run]);
  });

  it('AC1: a torn line costs THAT LINE alone, not the whole stream', async () => {
    await store.appendWerScore(makeWerScore({ utteranceId: 'u-good' }));
    // A process killed part-way through a write.
    await fs.appendFile(LAYOUT.werScores(dir), '{"runId":"run-tor\n', 'utf8');
    await store.appendWerScore(makeWerScore({ utteranceId: 'u-after' }));

    expect((await store.listWerScores()).map((s) => s.utteranceId)).toEqual([
      'u-good',
      'u-after',
    ]);
  });
});

describe('ticket 034 — a WER score NEVER lands in ledger.jsonl', () => {
  it('AC2: appending a score leaves the run ledger and the run store empty', async () => {
    await store.appendWerScore(makeWerScore({ runId: 'run-not-a-run' }));

    expect(await store.readLedger()).toEqual([]);
    expect(await store.listRuns()).toEqual([]);
    // Not even the file exists — a score is not half a run.
    expect(await exists(LAYOUT.ledger(dir))).toBe(false);
    expect(await exists(LAYOUT.werScores(dir))).toBe(true);
  });

  it('AC2: with Runs present, the ledger text does not mention the score at all', async () => {
    await store.appendRun(makeRun({ id: 'run-only' }));
    await store.appendWerScore(makeWerScore({ runId: 'run-only', utteranceId: 'u-scored' }));

    const ledger = await fs.readFile(LAYOUT.ledger(dir), 'utf8');
    expect(ledger).not.toContain('u-scored');
    expect(ledger).not.toContain('normalizationVersion');
    expect((await store.readLedger()).map((r) => r.id)).toEqual(['run-only']);
  });

  it('AC2: scores do not leak into the OTHER two side streams either', async () => {
    await store.appendWerScore(makeWerScore());

    expect(await store.listBlindComparisons()).toEqual([]);
    expect(await store.listLiveSessions()).toEqual([]);
    expect(await exists(LAYOUT.comparisons(dir))).toBe(false);
    expect(await exists(LAYOUT.liveSessions(dir))).toBe(false);
  });

  it('AC2: no audio and no Run JSON is written for a score', async () => {
    await store.appendWerScore(makeWerScore({ runId: 'run-1' }));

    expect(await exists(LAYOUT.runJson(dir, 'run-1'))).toBe(false);
    expect(await exists(LAYOUT.runWav(dir, 'run-1'))).toBe(false);
  });
});
