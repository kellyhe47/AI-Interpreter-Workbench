/**
 * TICKET 023 (QA F6) — blind comparisons in the exported bundle.
 *
 * `results/<date>/` is what the write-up cites. Scores that never leave the
 * browser are absent from it, so a claim about human judgement had nothing a
 * reviewer could check out and recompute from.
 *
 * PRD §10 also requires DISCLOSURE: "The number of comparisons scored is
 * stated in the provenance line … so a small sample is disclosed rather than
 * implied to be complete." The bundle's summary is where the exported form of
 * that number lives.
 *
 * THE FIELD THIS SUITE PINS: `summary.blindComparisons`, a TOP-LEVEL member —
 * deliberately NOT part of `totals`, whose exact shape is pinned by the locked
 * `exportResults.test.ts` empty-bundle test (`toEqual({runs, aggregated,
 * excluded})`), and which counts RUNS. A comparison is not a run.
 *
 *   blindComparisons: {
 *     total,            // every comparison in the bundle
 *     scored,           // both runIds present in the record set — the
 *                       // disclosed number
 *     unattributable,   // total - scored: stored, exported, never counted
 *     byRecording,      // scored count per recordingId
 *   }
 *
 * ADDITIVE to exportResults.test.ts (locked): nothing here asserts on
 * `totals`, the run records, or the failure path.
 *
 * Both the source store and the bundle destination are `mkdtemp` directories —
 * nothing here touches the repo's data/ or results/.
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { DEFAULT_CASCADE_TRIPLE } from '../core/arms';
import { createStorage } from '../server/storage/index';
import type { BlindComparison, Run } from '../server/storage/index';
import { LAYOUT, makeBlindComparison, makeRun } from '../server/storage/test-support';
import { exportResults } from './exportResults';
import type { ExportSummary } from './exportResults';

const FIXED_NOW = Date.UTC(2026, 0, 15, 12, 0, 0);
const FIXED_DATE = '2026-01-15';

/** The bundle member holding the exported comparison records. */
const COMPARISONS_FILE = 'blind-comparisons.json';

let dataDir: string;
let resultsDir: string;
let tmpRoot: string;

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'wb-export-cmp-'));
  dataDir = path.join(tmpRoot, 'data');
  resultsDir = path.join(tmpRoot, 'results');
  await fs.mkdir(dataDir, { recursive: true });
});

afterEach(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

function sweepRun(id: string, overrides: Partial<Run> = {}): Run {
  return makeRun({
    id,
    recordingId: 'rec-1',
    architecture: 'cascade',
    providerTriple: DEFAULT_CASCADE_TRIPLE,
    modelSnapshots: { ...DEFAULT_CASCADE_TRIPLE },
    origin: 'sweep',
    status: 'complete',
    timings: { speech_end: 1_000, audio_queued: 1_500 },
    cost: 0.01,
    ...overrides,
  });
}

async function seedRuns(runs: Run[]): Promise<void> {
  const store = createStorage(dataDir);
  for (const run of runs) await store.appendRun(run);
}

/**
 * Seeded by appending to the store's own append-only comparisons file rather
 * than through `appendBlindComparison`, so a failure in this suite is an
 * export failure and never a seeding failure. The path is the one ticket 023
 * pins (see routes/blindComparisons.test.ts).
 */
async function seedComparisons(comparisons: BlindComparison[]): Promise<void> {
  await fs.mkdir(dataDir, { recursive: true });
  for (const comparison of comparisons) {
    await fs.appendFile(
      LAYOUT.comparisons(dataDir),
      `${JSON.stringify(comparison)}\n`,
      'utf8',
    );
  }
}

async function run(): Promise<Awaited<ReturnType<typeof exportResults>>> {
  return exportResults({ dataDir, resultsDir, now: () => FIXED_NOW });
}

async function readJson<T>(file: string): Promise<T> {
  return JSON.parse(await fs.readFile(file, 'utf8')) as T;
}

async function exists(p: string): Promise<boolean> {
  try {
    await fs.stat(p);
    return true;
  } catch {
    return false;
  }
}

const bundle = (): string => path.join(resultsDir, FIXED_DATE);

/* ================================================ the bundle carries them = */

describe('ticket 023 — the export bundle includes the blind comparisons', () => {
  it('AC5: the comparison records are written into the bundle', async () => {
    const comparisons = [
      makeBlindComparison({ id: 'cmp-1', recordingId: 'rec-1', runIds: ['b-1', 'b-2'], order: ['b-2', 'b-1'] }),
      makeBlindComparison({ id: 'cmp-2', recordingId: 'rec-1', runIds: ['b-1', 'b-3'], order: ['b-1', 'b-3'] }),
    ];
    await seedRuns([sweepRun('b-1'), sweepRun('b-2'), sweepRun('b-3')]);
    await seedComparisons(comparisons);

    const outcome = await run();

    const file = path.join(outcome.bundleDir, COMPARISONS_FILE);
    expect(await exists(file)).toBe(true);
    const exported = await readJson<BlindComparison[]>(file);
    expect(exported).toEqual(comparisons);
  });

  it('AC5: the summary states HOW MANY comparisons were scored', async () => {
    await seedRuns([sweepRun('b-1'), sweepRun('b-2'), sweepRun('b-3')]);
    await seedComparisons([
      makeBlindComparison({ id: 'cmp-1', recordingId: 'rec-1', runIds: ['b-1', 'b-2'], order: ['b-2', 'b-1'] }),
      makeBlindComparison({ id: 'cmp-2', recordingId: 'rec-1', runIds: ['b-1', 'b-3'], order: ['b-1', 'b-3'] }),
    ]);

    const summary = (await run()).summary;

    expect(summary.blindComparisons.total).toBe(2);
    expect(summary.blindComparisons.scored).toBe(2);
    expect(summary.blindComparisons.unattributable).toBe(0);
    expect(summary.blindComparisons.byRecording).toEqual({ 'rec-1': 2 });
  });

  it('AC5: the number is on disk in summary.json, not only in the return value', async () => {
    await seedRuns([sweepRun('b-1'), sweepRun('b-2')]);
    await seedComparisons([
      makeBlindComparison({ id: 'cmp-1', recordingId: 'rec-1', runIds: ['b-1', 'b-2'], order: ['b-1', 'b-2'] }),
    ]);

    const outcome = await run();

    const onDisk = await readJson<ExportSummary>(outcome.summaryPath);
    expect(onDisk.blindComparisons).toEqual(outcome.summary.blindComparisons);
    expect(onDisk.blindComparisons.scored).toBe(1);
  });

  it('AC5: comparisons over two Recordings are disclosed per Recording', async () => {
    await seedRuns([
      sweepRun('b-1'),
      sweepRun('b-2'),
      sweepRun('c-1', { recordingId: 'rec-2' }),
      sweepRun('c-2', { recordingId: 'rec-2' }),
    ]);
    await seedComparisons([
      makeBlindComparison({ id: 'cmp-1', recordingId: 'rec-1', runIds: ['b-1', 'b-2'], order: ['b-1', 'b-2'] }),
      makeBlindComparison({ id: 'cmp-2', recordingId: 'rec-2', runIds: ['c-1', 'c-2'], order: ['c-2', 'c-1'] }),
      makeBlindComparison({ id: 'cmp-3', recordingId: 'rec-2', runIds: ['c-1', 'c-2'], order: ['c-1', 'c-2'] }),
    ]);

    const summary = (await run()).summary;

    expect(summary.blindComparisons.scored).toBe(3);
    expect(summary.blindComparisons.byRecording).toEqual({ 'rec-1': 1, 'rec-2': 2 });
  });
});

/* ==================================== unattributable: stored, NOT counted = */

describe('ticket 023 — an unattributable comparison is exported but never counted', () => {
  const attributable = makeBlindComparison({
    id: 'cmp-real',
    recordingId: 'rec-1',
    runIds: ['b-1', 'b-2'],
    order: ['b-2', 'b-1'],
  });
  /** Neither run exists, so nothing can attribute this judgement to rec-ghost. */
  const orphan = makeBlindComparison({
    id: 'cmp-orphan',
    recordingId: 'rec-ghost',
    runIds: ['run-gone-1', 'run-gone-2'],
    order: ['run-gone-2', 'run-gone-1'],
  });
  /** Half-dangling is still dangling: one of the two runs was never stored. */
  const halfOrphan = makeBlindComparison({
    id: 'cmp-half',
    recordingId: 'rec-1',
    runIds: ['b-1', 'run-gone-3'],
    order: ['b-1', 'run-gone-3'],
  });

  async function seedMixed(): Promise<void> {
    await seedRuns([sweepRun('b-1'), sweepRun('b-2')]);
    await seedComparisons([attributable, orphan, halfOrphan]);
  }

  it('AC6 (half one): it is STILL in the bundle — the work is not discarded', async () => {
    await seedMixed();

    const outcome = await run();

    const exported = await readJson<BlindComparison[]>(
      path.join(outcome.bundleDir, COMPARISONS_FILE),
    );
    expect(exported.map((c) => c.id).sort()).toEqual(['cmp-half', 'cmp-orphan', 'cmp-real']);
    expect(exported).toContainEqual(orphan);
    expect(exported).toContainEqual(halfOrphan);
  });

  it('AC6 (half two): it is NOT counted toward any Recording', async () => {
    await seedMixed();

    const summary = (await run()).summary;

    expect(summary.blindComparisons.total).toBe(3);
    expect(summary.blindComparisons.scored).toBe(1);
    expect(summary.blindComparisons.unattributable).toBe(2);
    // rec-ghost is not a key at all, and rec-1 counts only the attributable one.
    expect(summary.blindComparisons.byRecording).toEqual({ 'rec-1': 1 });
    expect(Object.keys(summary.blindComparisons.byRecording)).not.toContain('rec-ghost');
  });
});

/* ============================================================== guards ==== */

describe('ticket 023 — guards on what comparisons must NOT disturb', () => {
  it('GUARD (passes today): comparisons never inflate the RUN totals', async () => {
    await seedRuns([sweepRun('b-1'), sweepRun('b-2')]);
    await seedComparisons([
      makeBlindComparison({ id: 'cmp-1', recordingId: 'rec-1', runIds: ['b-1', 'b-2'], order: ['b-1', 'b-2'] }),
      makeBlindComparison({ id: 'cmp-2', recordingId: 'rec-1', runIds: ['b-1', 'b-2'], order: ['b-2', 'b-1'] }),
    ]);

    const summary = (await run()).summary;

    // A comparison sharing ledger.jsonl would show up here as a third "run".
    expect(summary.totals.runs).toBe(2);
    expect(summary.totals.aggregated).toBe(2);
    expect(summary.totals.excluded).toBe(0);
    expect(await exists(path.join(bundle(), 'runs', 'cmp-1.json'))).toBe(false);
  });

  it('GUARD (passes today): an empty store discloses zero, not a missing field', async () => {
    const summary = (await run()).summary;

    expect(summary.blindComparisons).toEqual({
      total: 0,
      scored: 0,
      unattributable: 0,
      byRecording: {},
    });
  });

  it('a torn comparison line costs that line alone, not the export', async () => {
    await seedRuns([sweepRun('b-1'), sweepRun('b-2')]);
    await seedComparisons([
      makeBlindComparison({ id: 'cmp-1', recordingId: 'rec-1', runIds: ['b-1', 'b-2'], order: ['b-1', 'b-2'] }),
    ]);
    await fs.appendFile(LAYOUT.comparisons(dataDir), '{"id":"cmp-tor\n', 'utf8');

    const summary = (await run()).summary;

    expect(summary.blindComparisons.total).toBe(1);
    expect(summary.blindComparisons.scored).toBe(1);
  });
});
