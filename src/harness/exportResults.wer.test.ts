/**
 * TICKET 034 — the exported bundle carries the post-hoc WER scores, and the
 * scores stream NEVER becomes a run.
 *
 * THE STRUCTURAL RULE THIS SUITE PINS: `readLedger()` is typed `Run[]` and
 * `exportResults` unions it into the exported RUN record set. A WER score
 * sharing `ledger.jsonl` would therefore be counted in `totals.runs` and
 * derived into an arm — a judgement about one utterance of a run is not another
 * run. `wer-scores.jsonl` is a separate stream for exactly that reason, and
 * `totals.runs` must be blind to it.
 *
 * THE MEASUREMENT RULE: `not applicable` is NOT `0`. Cantonese carries no
 * script (PRD §9), its scores are `wer: null`, and they must be disclosed by
 * name and never folded into a mean.
 *
 * Every test reads from and writes into `mkdtemp` directories.
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { DEFAULT_CASCADE_TRIPLE } from '../core/arms';
import { WER_NORMALIZATION_VERSION } from '../core/wer';
import type { WerScore } from '../core/wer';
import { createStorage } from '../server/storage/index';
import type { Run, RunUtterance } from '../server/storage/types';
import { makeRun } from '../server/storage/test-support';
import { exportResults } from './exportResults';
import type { ExportSummary } from './exportResults';

const FIXED_NOW = Date.UTC(2026, 0, 15, 12, 0, 0);
const FIXED_DATE = '2026-01-15';

let tmpRoot: string;
let dataDir: string;
let resultsDir: string;

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'wb-export-wer-'));
  dataDir = path.join(tmpRoot, 'data');
  resultsDir = path.join(tmpRoot, 'results');
  await fs.mkdir(dataDir, { recursive: true });
});

afterEach(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

function record(utteranceId: string, overrides: Partial<RunUtterance> = {}): RunUtterance {
  return {
    utteranceId,
    index: 1,
    category: 'short-reply',
    timings: { speech_end: 1_000, audio_queued: 1_800 },
    transcripts: { source: 'the quick brown ox', target: 'x' },
    cost: 0.001,
    status: 'complete',
    errors: [],
    ...overrides,
  };
}

/** A gate-passing Arm-B run carrying two utterance records. */
function gatePassingRun(id: string, overrides: Partial<Run> = {}): Run {
  return makeRun({
    id,
    recordingId: 'rec-1',
    providerTriple: { ...DEFAULT_CASCADE_TRIPLE },
    modelSnapshots: { ...DEFAULT_CASCADE_TRIPLE },
    origin: 'sweep',
    status: 'complete',
    timings: { speech_end: 1_000, audio_queued: 1_800 },
    utterances: [record('u-1', { index: 1 }), record('u-2', { index: 2 })],
    ...overrides,
  });
}

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

function notApplicable(overrides: Partial<WerScore> = {}): WerScore {
  return score({
    wer: null,
    notApplicableReason: 'no-reference-text',
    referenceText: null,
    ...overrides,
  });
}

async function seed(runs: Run[], scores: WerScore[]): Promise<void> {
  const store = createStorage(dataDir);
  for (const run of runs) await store.appendRun(run);
  for (const s of scores) await store.appendWerScore(s);
}

async function run(): Promise<ExportSummary> {
  const outcome = await exportResults({ dataDir, resultsDir, now: () => FIXED_NOW });
  return outcome.summary;
}

async function readJson<T>(file: string): Promise<T> {
  return JSON.parse(await fs.readFile(file, 'utf8')) as T;
}

/* ============================== the stream is NEVER counted as a run ======= */

describe('ticket 034 — WER scores never reach totals.runs', () => {
  it('AC2: a store holding ONLY scores exports an EMPTY bundle', async () => {
    await seed([], [score(), score({ utteranceId: 'u-2' })]);

    const summary = await run();
    // The load-bearing assertion. A score sharing ledger.jsonl would land here.
    expect(summary.totals).toEqual({ runs: 0, aggregated: 0, excluded: 0 });
    expect(summary.empty).toBe(true);
    // …and it is still disclosed, not discarded.
    expect(summary.werScores.total).toBe(2);
  });

  it('AC2: adding scores to a store with runs does not move a single run figure', async () => {
    await seed([gatePassingRun('run-1'), gatePassingRun('run-2')], []);
    const before = await run();

    await seed([], [score({ runId: 'run-1' }), score({ runId: 'run-2' }), notApplicable({ runId: 'run-1', utteranceId: 'u-2' })]);
    const after = await run();

    expect(after.totals).toEqual(before.totals);
    expect(after.experiments).toEqual(before.experiments);
    expect(after.empty).toBe(before.empty);
    expect(after.werScores.total).toBe(3);
  });

  it('AC2: no score id appears in the exported run record set', async () => {
    await seed([gatePassingRun('run-1')], [score({ runId: 'run-1' })]);
    await run();

    const runFiles = await fs.readdir(path.join(resultsDir, FIXED_DATE, 'runs'));
    expect(runFiles).toEqual(['run-1.json']);
    const stored = await readJson<Run>(path.join(resultsDir, FIXED_DATE, 'runs', 'run-1.json'));
    expect(JSON.stringify(stored)).not.toContain('normalizationVersion');
  });
});

/* ================================================= the bundle carries them = */

describe('ticket 034 — wer-scores.json is written verbatim and uncollapsed', () => {
  it('AC1: every line is exported, superseded re-scores included', async () => {
    const first = score({ wer: 0.5, scoredAt: 1 });
    const second = score({ wer: 0.1, scoredAt: 2 });
    await seed([gatePassingRun('run-1')], [first, second]);

    await run();

    const exported = await readJson<WerScore[]>(
      path.join(resultsDir, FIXED_DATE, 'wer-scores.json'),
    );
    // VERBATIM and in write order: a reviewer can recompute the mean and see
    // the history the append-only stream exists to keep.
    expect(exported).toEqual([first, second]);
  });

  it('AC1: the file is written even on an empty store, so the shape is stable', async () => {
    await run();
    expect(
      await readJson<WerScore[]>(path.join(resultsDir, FIXED_DATE, 'wer-scores.json')),
    ).toEqual([]);
    expect((await run()).werScores).toEqual({
      total: 0,
      atoms: 0,
      aggregated: 0,
      notApplicable: 0,
      excluded: 0,
      meanByArm: {},
    });
  });
});

/* ======================================== the gate, and not-applicable ===== */

describe('ticket 034 — the disclosure obeys the gate and never averages a null', () => {
  it('AC4: meanByArm is the mean over gate-passing, SCORED atoms', async () => {
    await seed(
      [gatePassingRun('run-1')],
      [score({ runId: 'run-1', utteranceId: 'u-1', wer: 0.2 }), score({ runId: 'run-1', utteranceId: 'u-2', wer: 0.4 })],
    );

    const { werScores } = await run();
    expect(werScores.aggregated).toBe(2);
    expect(werScores.notApplicable).toBe(0);
    expect(werScores.meanByArm.B).toBeCloseTo(0.3, 10);
  });

  it('AC3: a NOT-APPLICABLE atom is disclosed by name and NEVER averaged in', async () => {
    await seed(
      [gatePassingRun('run-1')],
      [
        score({ runId: 'run-1', utteranceId: 'u-1', wer: 0.4 }),
        notApplicable({ runId: 'run-1', utteranceId: 'u-2' }),
      ],
    );

    const { werScores } = await run();
    expect(werScores.notApplicable).toBe(1);
    expect(werScores.aggregated).toBe(1);
    // 0.4 alone. Folding the null in as a 0 would report 0.2 — a better-looking
    // number for an arm half of which nobody can score.
    expect(werScores.meanByArm.B).toBeCloseTo(0.4, 10);
  });

  it('AC3: an all-Cantonese store reports NO arm mean at all, not a 0', async () => {
    await seed(
      [gatePassingRun('run-1')],
      [notApplicable({ runId: 'run-1', utteranceId: 'u-1' }), notApplicable({ runId: 'run-1', utteranceId: 'u-2' })],
    );

    const { werScores } = await run();
    expect(werScores.meanByArm).toEqual({});
    expect(werScores.meanByArm.B).toBeUndefined();
    expect(werScores.notApplicable).toBe(2);
    expect(werScores.aggregated).toBe(0);
  });

  /** Each case is a gate-passing Run minus ONE thing. */
  const excluded: Array<{ reason: string; overrides: Partial<Run> }> = [
    { reason: 'manual origin', overrides: { origin: 'manual' } },
    { reason: 'failed status', overrides: { status: 'failed' } },
    {
      reason: 'ad-hoc configuration',
      overrides: {
        providerTriple: { stt: 'gpt-4o-transcribe', mt: 'claude-haiku-4-5', tts: 'eleven_flash_v2_5' },
        modelSnapshots: { stt: 'gpt-4o-transcribe', mt: 'claude-haiku-4-5', tts: 'eleven_flash_v2_5' },
      },
    },
    {
      reason: 'fixture-sourced',
      overrides: { modelSnapshots: { ...DEFAULT_CASCADE_TRIPLE, mt: 'fixture' } },
    },
  ];

  it.each(excluded)('AC5: a score on a $reason run is exported but never averaged', async ({ overrides }) => {
    await seed([gatePassingRun('run-1', overrides)], [score({ runId: 'run-1' })]);

    const { werScores } = await run();
    expect(werScores.total).toBe(1);
    expect(werScores.aggregated).toBe(0);
    expect(werScores.excluded).toBe(1);
    expect(werScores.meanByArm).toEqual({});
  });

  it('AC5: a score on a FAILED RECORD inside a complete Run is not averaged', async () => {
    await seed(
      [
        gatePassingRun('run-1', {
          utterances: [
            record('u-1', { index: 1 }),
            record('u-2', { index: 2, status: 'failed', timings: { speech_end: 1_000, audio_queued: null } }),
          ],
        }),
      ],
      [score({ runId: 'run-1', utteranceId: 'u-1', wer: 0.2 }), score({ runId: 'run-1', utteranceId: 'u-2', wer: 0.9 })],
    );

    const { werScores } = await run();
    expect(werScores.aggregated).toBe(1);
    expect(werScores.meanByArm.B).toBeCloseTo(0.2, 10);
  });

  it('AC5: a score naming a Run this bundle does not carry is excluded, not attributed', async () => {
    await seed([gatePassingRun('run-1')], [score({ runId: 'run-nowhere' })]);

    const { werScores } = await run();
    expect(werScores.total).toBe(1);
    expect(werScores.excluded).toBe(1);
    expect(werScores.meanByArm).toEqual({});
  });
});

/* ================================================== last write wins ======== */

describe('ticket 034 — the disclosure collapses re-scores last-write-wins', () => {
  it('AC6: `total` counts LINES, `atoms` counts keys, and the mean uses the newest', async () => {
    await seed(
      [gatePassingRun('run-1')],
      [
        score({ runId: 'run-1', utteranceId: 'u-1', wer: 0.9, scoredAt: 1 }),
        score({ runId: 'run-1', utteranceId: 'u-1', wer: 0.1, scoredAt: 2 }),
      ],
    );

    const { werScores } = await run();
    expect(werScores.total).toBe(2);
    expect(werScores.atoms).toBe(1);
    expect(werScores.aggregated).toBe(1);
    expect(werScores.meanByArm.B).toBeCloseTo(0.1, 10);
  });

  it('AC6: a re-score to NOT APPLICABLE removes the atom from the mean entirely', async () => {
    await seed(
      [gatePassingRun('run-1')],
      [
        score({ runId: 'run-1', utteranceId: 'u-1', wer: 0.9, scoredAt: 1 }),
        notApplicable({ runId: 'run-1', utteranceId: 'u-1', scoredAt: 2 }),
      ],
    );

    const { werScores } = await run();
    expect(werScores.atoms).toBe(1);
    expect(werScores.notApplicable).toBe(1);
    expect(werScores.aggregated).toBe(0);
    expect(werScores.meanByArm).toEqual({});
  });
});
