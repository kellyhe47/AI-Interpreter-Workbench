/**
 * TICKET 042 (part 2) — THE SCORING PASS IS ARMED.
 *
 * Ticket 034 built `scoreRunWer` and `POST /api/wer-scores`, and nothing ever
 * called either: a corpus could be recorded and swept and still produce zero
 * scores. The write path was complete but UNARMED.
 *
 * WHY A SCRIPT AND NOT A UI CONTROL (PRD note on 042): WER is POST HOC by
 * construction, so the pass has to be re-runnable over a whole corpus after the
 * fact — including over runs recorded before the scorer existed. A script needs
 * no UI decisions and it composes with `export-results`, which is the other
 * thing an operator runs over the finished corpus.
 *
 * THE SHAPE, mirroring `exportResults` exactly:
 *   src/harness/scoreWer.ts   the testable half — injected `dataDir` and `now`
 *   scripts/score-wer.mjs     a thin CLI shell (scripts/ is outside the vitest
 *                             glob, so no logic may live there)
 *   npm run score-wer         `tsx scripts/score-wer.mjs [dataDir]`
 *
 * WHAT THE PASS IS. A JOIN OVER ALREADY-PERSISTED DATA, never a new
 * measurement: each Run's `RunUtterance.transcripts.source` is joined to its
 * Recording's manifest `referenceText` by `utteranceId`, `scoreRunWer` decides
 * the number, and the results are APPENDED to `wer-scores.jsonl`. No audio is
 * replayed, no provider is called, no Run is touched.
 *
 * THE FOUR RULES THIS SUITE PINS:
 *  1. RE-RUNNING IS SAFE. The stream is append-only, so a second pass writes a
 *     second line per atom; last-write-wins is applied ON READ, so nothing
 *     double-counts. Asserted END TO END through `exportResults`, not only in
 *     `latestWerScores`.
 *  2. RUNS ARE NEVER MUTATED and `ledger.jsonl` is never written. Scoring is a
 *     judgement ABOUT a run, not a change to one.
 *  3. NOT APPLICABLE IS NOT ZERO AND NOT A SKIP. A Cantonese utterance (no
 *     `referenceText`, PRD §9) gets a `wer: null` / `no-reference-text` score
 *     WRITTEN — the absence is recorded rather than left indistinguishable from
 *     "nobody has scored this yet".
 *  4. THE GATE IS THE LEDGER'S. A fixture-sourced, ad-hoc, manual or failed run
 *     is not evidence, so the pass writes no score for it at all.
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { DEFAULT_CASCADE_TRIPLE } from '../core/arms';
import type { CorpusUtterance } from '../core/corpus';
import { WER_NORMALIZATION_VERSION, latestWerScores } from '../core/wer';
import { createStorage } from '../server/storage/index';
import type { Recording, Run, RunUtterance } from '../server/storage/types';
import { LAYOUT, makeRun, newRecording, wavBytes } from '../server/storage/test-support';
import { exportResults } from './exportResults';
import { scoreWer } from './scoreWer';
import type { ScoreWerOutcome } from './scoreWer';

const SCORED_AT = 1_700_000_000_000;
const EXPORT_NOW = Date.UTC(2026, 0, 15, 12, 0, 0);

/** An off-arm triple: a real recipe that derives to 'ad-hoc'. */
const OFF_ARM_TRIPLE = {
  stt: 'gpt-4o-mini-transcribe',
  mt: 'claude-haiku-4-5',
  tts: 'eleven_multilingual_v2',
};

let tmpRoot: string;
let dataDir: string;

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'wb-score-wer-'));
  dataDir = path.join(tmpRoot, 'data');
  await fs.mkdir(dataDir, { recursive: true });
});

afterEach(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

/* -------------------------------------------------------------- fixtures -- */

/** Two utterances, both with a verbatim script. 4 reference tokens each. */
const SCRIPTED: CorpusUtterance[] = [
  {
    id: 'u-1',
    index: 1,
    category: 'short-reply',
    trueSpeechEndMs: 1_000,
    referenceText: 'The quick brown fox.',
  },
  {
    id: 'u-2',
    index: 2,
    category: 'numbers-dates',
    trueSpeechEndMs: 2_000,
    referenceText: 'Take 250 mg twice.',
  },
];

/** PRD §9's Cantonese manifest: entries exist, NO entry carries a script. */
const IMPROVISED: CorpusUtterance[] = [
  { id: 'y-1', index: 1, category: 'short-reply', trueSpeechEndMs: 1_000 },
  { id: 'y-2', index: 2, category: 'disfluency', trueSpeechEndMs: 2_000 },
];

/** utteranceId -> the run's captured source transcript. */
const HYPOTHESES: Record<string, string> = {
  // 1 substitution over 4 tokens -> 0.25.
  'u-1': 'the quick brown ox',
  // 3 deletions over 4 tokens -> 0.75.
  'u-2': 'take',
  'y-1': '你好嗎',
  'y-2': '唔該晒',
};

function record(entry: CorpusUtterance, overrides: Partial<RunUtterance> = {}): RunUtterance {
  return {
    utteranceId: entry.id,
    index: entry.index,
    category: entry.category,
    timings: { speech_end: 1_000, audio_queued: 1_800 },
    transcripts: { source: HYPOTHESES[entry.id], target: 'target text' },
    cost: 0.001,
    status: 'complete',
    errors: [],
    ...overrides,
  };
}

/** A gate-passing Arm-B run over `manifest`, carrying one record per entry. */
function gatePassingRun(id: string, recordingId: string, manifest: CorpusUtterance[], overrides: Partial<Run> = {}): Run {
  return makeRun({
    id,
    recordingId,
    providerTriple: { ...DEFAULT_CASCADE_TRIPLE },
    modelSnapshots: { ...DEFAULT_CASCADE_TRIPLE },
    origin: 'sweep',
    status: 'complete',
    timings: { speech_end: 1_000, audio_queued: 1_800 },
    utterances: manifest.map((entry) => record(entry)),
    ...overrides,
  });
}

/** Persist one manifest-backed Recording; returns the store-generated entity. */
async function seedRecording(manifest?: CorpusUtterance[]): Promise<Recording> {
  const store = createStorage(dataDir);
  return store.createRecording(
    newRecording({ origin: 'corpus', utterances: manifest, corpusVersion: 'corpus-en-es-v2' }),
    wavBytes(),
  );
}

async function seedRuns(runs: Run[]): Promise<void> {
  const store = createStorage(dataDir);
  for (const run of runs) await store.appendRun(run);
}

/** The default seed: one scripted Recording + one gate-passing Run over it. */
async function seedScriptedCorpus(): Promise<Recording> {
  const recording = await seedRecording(SCRIPTED);
  await seedRuns([gatePassingRun('run-1', recording.id, SCRIPTED)]);
  return recording;
}

function pass(): Promise<ScoreWerOutcome> {
  return scoreWer({ dataDir, now: () => SCORED_AT });
}

async function storedScores() {
  return createStorage(dataDir).listWerScores();
}

/** Every byte the pass must not move: the ledger and the per-run JSON files. */
async function runStoreSnapshot(): Promise<Record<string, string>> {
  const snapshot: Record<string, string> = {};
  const ledgerPath = LAYOUT.ledger(dataDir);
  snapshot['ledger.jsonl'] = await fs.readFile(ledgerPath, 'utf8').catch(() => '<absent>');
  const runsDir = path.join(dataDir, 'runs');
  const entries = await fs.readdir(runsDir).catch(() => [] as string[]);
  for (const entry of entries.sort()) {
    snapshot[`runs/${entry}`] = await fs.readFile(path.join(runsDir, entry), 'utf8');
  }
  return snapshot;
}

/* ================================================== it scores what it should */

describe('ticket 042 — the pass scores every gate-eligible (run, utterance) pair', () => {
  it('AC5: writes ONE score per record and reports how many', async () => {
    await seedScriptedCorpus();

    const outcome = await pass();

    expect(outcome.scoresWritten).toBe(2);
    expect(outcome.scored).toBe(2);
    expect(outcome.notApplicable).toBe(0);
    expect(outcome.runsScored).toBe(1);
    expect(outcome.runsExamined).toBe(1);
    expect(outcome.skipped).toEqual({ gate: 0, noRecords: 0, noManifest: 0 });
    // The message is what the CLI shell prints; it has to carry the count.
    expect(outcome.message).toContain('2');
    expect(outcome.message).toContain(dataDir);
  });

  it('AC5: the score is the JOIN of the manifest reference and the run transcript', async () => {
    await seedScriptedCorpus();
    await pass();

    const byUtterance = new Map((await storedScores()).map((s) => [s.utteranceId, s]));
    const u1 = byUtterance.get('u-1')!;
    // 1 substitution over 4 reference tokens.
    expect(u1.wer).toBeCloseTo(0.25, 10);
    expect(u1.runId).toBe('run-1');
    // Both sides are stored VERBATIM so a reviewer can recompute the number.
    expect(u1.referenceText).toBe('The quick brown fox.');
    expect(u1.hypothesisText).toBe('the quick brown ox');
    expect(u1.normalizationVersion).toBe(WER_NORMALIZATION_VERSION);
    // The clock is INJECTED — nothing here reads Date.now.
    expect(u1.scoredAt).toBe(SCORED_AT);

    // 3 deletions over 4 reference tokens.
    expect(byUtterance.get('u-2')!.wer).toBeCloseTo(0.75, 10);
  });

  it('AC5: scores land in wer-scores.jsonl, one JSON line each', async () => {
    await seedScriptedCorpus();
    await pass();

    const lines = (await fs.readFile(LAYOUT.werScores(dataDir), 'utf8'))
      .split('\n')
      .filter((line) => line.length > 0);
    expect(lines).toHaveLength(2);
    for (const line of lines) expect(() => JSON.parse(line)).not.toThrow();
  });

  it('an empty store writes nothing and says so', async () => {
    const outcome = await pass();

    expect(outcome.scoresWritten).toBe(0);
    expect(outcome.runsExamined).toBe(0);
    expect(await storedScores()).toEqual([]);
    expect(outcome.message).toContain(dataDir);
  });
});

/* ============================================== re-running is safe, END TO END */

describe('ticket 042 — re-scoring is safe and never double-counts', () => {
  it('AC6: a second pass appends a second line per atom, and the ATOMS do not grow', async () => {
    await seedScriptedCorpus();

    const first = await pass();
    const second = await scoreWer({ dataDir, now: () => SCORED_AT + 60_000 });

    expect(first.scoresWritten).toBe(2);
    expect(second.scoresWritten).toBe(2);

    const scores = await storedScores();
    // APPEND-ONLY: the superseded lines survive on disk. That is the point.
    expect(scores).toHaveLength(4);
    // LAST WRITE WINS ON READ: two atoms, carrying the NEWER stamp.
    const atoms = latestWerScores(scores);
    expect(atoms).toHaveLength(2);
    for (const atom of atoms) expect(atom.scoredAt).toBe(SCORED_AT + 60_000);
  });

  it('AC6: END TO END — the exported figures are identical after one pass and after two', async () => {
    await seedScriptedCorpus();

    await pass();
    const once = (await exportResults({
      dataDir,
      resultsDir: path.join(tmpRoot, 'results-1'),
      now: () => EXPORT_NOW,
    })).summary.werScores;

    await scoreWer({ dataDir, now: () => SCORED_AT + 60_000 });
    const twice = (await exportResults({
      dataDir,
      resultsDir: path.join(tmpRoot, 'results-2'),
      now: () => EXPORT_NOW,
    })).summary.werScores;

    expect(once.atoms).toBe(2);
    expect(once.aggregated).toBe(2);
    // The LINES double; nothing a reader reports does.
    expect(twice.total).toBe(once.total * 2);
    expect(twice.atoms).toBe(once.atoms);
    expect(twice.aggregated).toBe(once.aggregated);
    expect(twice.notApplicable).toBe(once.notApplicable);
    expect(twice.meanByArm).toEqual(once.meanByArm);
    // (0.25 + 0.75) / 2, unchanged by the re-score.
    expect(twice.meanByArm.B).toBeCloseTo(0.5, 10);
  });
});

/* ============================== scoring is a judgement ABOUT a run, not to it */

describe('ticket 042 — the pass never mutates a Run and never writes the ledger', () => {
  it('AC7: ledger.jsonl and every runs/*.json are byte-identical afterwards', async () => {
    await seedScriptedCorpus();
    const before = await runStoreSnapshot();

    await pass();

    expect(await runStoreSnapshot()).toEqual(before);
    expect(before['ledger.jsonl']).not.toBe('<absent>');
    // And the ledger still holds no score-shaped line: readLedger() is typed
    // Run[] and exportResults unions it into the run record set.
    expect(before['ledger.jsonl']).not.toContain('normalizationVersion');
    expect(await fs.readFile(LAYOUT.ledger(dataDir), 'utf8')).not.toContain(
      WER_NORMALIZATION_VERSION,
    );
  });

  it('AC7: the Runs read back deep-equal to what was written', async () => {
    await seedScriptedCorpus();
    const store = createStorage(dataDir);
    const before = await store.listRuns();

    await pass();

    expect(await store.listRuns()).toEqual(before);
    // No `wer` field was grafted onto a Run or one of its records.
    expect(JSON.stringify(await store.listRuns())).not.toContain('"wer"');
  });

  it('AC7: totals.runs is untouched by a scoring pass', async () => {
    await seedScriptedCorpus();
    await pass();
    await pass();

    const summary = (await exportResults({
      dataDir,
      resultsDir: path.join(tmpRoot, 'results'),
      now: () => EXPORT_NOW,
    })).summary;
    expect(summary.totals.runs).toBe(1);
  });
});

/* ======================== NOT APPLICABLE IS NOT ZERO, AND IT IS NOT A SKIP == */

describe('ticket 042 — a Cantonese utterance is SCORED as `not applicable`', () => {
  beforeEach(async () => {
    const recording = await seedRecording(IMPROVISED);
    await seedRuns([gatePassingRun('run-yue', recording.id, IMPROVISED)]);
  });

  it('AC3: a score IS written, with wer null and a named reason', async () => {
    const outcome = await pass();

    expect(outcome.scoresWritten).toBe(2);
    expect(outcome.notApplicable).toBe(2);
    expect(outcome.scored).toBe(0);

    const scores = await storedScores();
    expect(scores).toHaveLength(2);
    for (const score of scores) {
      expect(score.wer).toBeNull();
      // A ZERO WER IS A PERFECT SCORE.
      expect(score.wer).not.toBe(0);
      expect(score.notApplicableReason).toBe('no-reference-text');
      expect(score.referenceText).toBeNull();
    }
  });

  it('AC3: the not-applicable atoms reach the export disclosure, not a mean', async () => {
    await pass();

    const summary = (await exportResults({
      dataDir,
      resultsDir: path.join(tmpRoot, 'results'),
      now: () => EXPORT_NOW,
    })).summary.werScores;

    expect(summary.atoms).toBe(2);
    expect(summary.notApplicable).toBe(2);
    expect(summary.aggregated).toBe(0);
    // Averaging a null in as 0 would report the unscoreable arm as the best.
    expect(summary.meanByArm).toEqual({});
  });

  it('AC3: a MIXED run scores the scripted utterance and nulls the improvised one', async () => {
    await fs.rm(dataDir, { recursive: true, force: true });
    await fs.mkdir(dataDir, { recursive: true });
    const manifest = [SCRIPTED[0]!, IMPROVISED[1]!];
    const recording = await seedRecording(manifest);
    await seedRuns([gatePassingRun('run-mixed', recording.id, manifest)]);

    const outcome = await pass();
    expect(outcome.scored).toBe(1);
    expect(outcome.notApplicable).toBe(1);

    const byUtterance = new Map((await storedScores()).map((s) => [s.utteranceId, s]));
    expect(byUtterance.get('u-1')!.wer).toBeCloseTo(0.25, 10);
    expect(byUtterance.get('y-2')!.wer).toBeNull();
  });
});

/* ============================================ what the pass refuses to score */

describe('ticket 042 — runs that are not evidence contribute no score', () => {
  const gateFailing: Array<{ reason: string; overrides: Partial<Run> }> = [
    { reason: 'manual origin', overrides: { origin: 'manual' } },
    { reason: 'failed status', overrides: { status: 'failed' } },
    {
      reason: 'ad-hoc configuration',
      overrides: {
        providerTriple: { ...OFF_ARM_TRIPLE },
        modelSnapshots: { ...OFF_ARM_TRIPLE },
      },
    },
    {
      reason: 'fixture-sourced providers',
      overrides: {
        providerTriple: { stt: 'fixture', mt: 'fixture', tts: 'fixture' },
        modelSnapshots: { stt: 'fixture', mt: 'fixture', tts: 'fixture' },
      },
    },
  ];

  it.each(gateFailing)('AC8: $reason writes no score at all', async ({ overrides }) => {
    const recording = await seedRecording(SCRIPTED);
    await seedRuns([gatePassingRun('run-excluded', recording.id, SCRIPTED, overrides)]);

    const outcome = await pass();

    expect(outcome.scoresWritten).toBe(0);
    expect(outcome.runsScored).toBe(0);
    expect(outcome.skipped.gate).toBe(1);
    expect(await storedScores()).toEqual([]);
  });

  it('AC8: an excluded run beside a good one leaves the good one’s score alone', async () => {
    const recording = await seedRecording(SCRIPTED);
    await seedRuns([
      gatePassingRun('run-good', recording.id, SCRIPTED),
      gatePassingRun('run-bad', recording.id, SCRIPTED, { status: 'failed' }),
    ]);

    const outcome = await pass();

    expect(outcome.runsExamined).toBe(2);
    expect(outcome.runsScored).toBe(1);
    expect(outcome.skipped.gate).toBe(1);
    expect((await storedScores()).map((s) => s.runId)).toEqual(['run-good', 'run-good']);
  });

  it('a Run carrying NO utterances[] contributes nothing — WER has no atom to key by', async () => {
    const recording = await seedRecording(SCRIPTED);
    await seedRuns([gatePassingRun('run-plain', recording.id, SCRIPTED, { utterances: undefined })]);

    const outcome = await pass();

    expect(outcome.scoresWritten).toBe(0);
    expect(outcome.skipped.noRecords).toBe(1);
    expect(outcome.skipped.gate).toBe(0);
    expect(await storedScores()).toEqual([]);
  });

  it('a Run whose Recording carries NO manifest is skipped, not nulled', async () => {
    // A mic Recording has no manifest at all — there is nothing to join to, so
    // the pass has no basis for a judgement of any kind. That is DIFFERENT from
    // Cantonese, whose manifest exists and deliberately carries no script.
    const recording = await seedRecording(undefined);
    await seedRuns([gatePassingRun('run-mic', recording.id, SCRIPTED)]);

    const outcome = await pass();

    expect(outcome.scoresWritten).toBe(0);
    expect(outcome.skipped.noManifest).toBe(1);
    expect(await storedScores()).toEqual([]);
  });

  it('a Run naming a Recording the store does not hold is skipped', async () => {
    await seedRuns([gatePassingRun('run-orphan', 'rec-nope', SCRIPTED)]);

    const outcome = await pass();

    expect(outcome.scoresWritten).toBe(0);
    expect(outcome.skipped.noManifest).toBe(1);
    expect(await storedScores()).toEqual([]);
  });
});
