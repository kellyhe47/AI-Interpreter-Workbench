/**
 * Ticket 017 — export-results.
 *
 * EVERY test reads from and writes into `mkdtemp` directories, for BOTH the
 * source store and the bundle destination: nothing here may touch the repo's
 * `data/` or `results/`. That is exactly why both paths are injected.
 *
 * The clock is injected too, so `<YYYY-MM-DD>` is deterministic.
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { DEFAULT_CASCADE_TRIPLE } from '../core/arms';
import type { ProviderTriple } from '../core/arms';
import { createStorage } from '../server/storage/index';
import type { Run } from '../server/storage/index';
import { makeRun } from '../server/storage/test-support';
import { exportResults } from './exportResults';
import type { ConfigurationSummary, ExportSummary } from './exportResults';

/** 2026-01-15T12:00:00Z — the only date any bundle here may be stamped with. */
const FIXED_NOW = Date.UTC(2026, 0, 15, 12, 0, 0);
const FIXED_DATE = '2026-01-15';

const B_TRIPLE: ProviderTriple = DEFAULT_CASCADE_TRIPLE;
const C_TRIPLE: ProviderTriple = {
  stt: 'gpt-4o-transcribe',
  mt: 'gpt-4o-mini',
  tts: 'eleven_flash_v2_5',
};

const repoRoot = fileURLToPath(new URL('../../', import.meta.url));

let dataDir: string;
let resultsDir: string;
let tmpRoot: string;

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'wb-export-'));
  dataDir = path.join(tmpRoot, 'data');
  resultsDir = path.join(tmpRoot, 'results');
  await fs.mkdir(dataDir, { recursive: true });
});

afterEach(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

/**
 * A cascade run with a real latency sample. Defaults to the gate-passing
 * shape: Arm B's triple, origin 'sweep', status 'complete', non-fixture.
 */
function cascadeRun(id: string, overrides: Partial<Run> = {}): Run {
  const triple = overrides.providerTriple ?? B_TRIPLE;
  return makeRun({
    id,
    recordingId: 'rec-1',
    architecture: 'cascade',
    providerTriple: triple,
    modelSnapshots: { stt: triple.stt, mt: triple.mt, tts: triple.tts },
    origin: 'sweep',
    status: 'complete',
    timings: { speech_end: 1_000, audio_queued: 1_500 },
    cost: 0.01,
    ...overrides,
  });
}

async function seed(runs: Run[]): Promise<void> {
  const store = createStorage(dataDir);
  for (const run of runs) await store.appendRun(run);
}

async function run(
  overrides: Partial<Parameters<typeof exportResults>[0]> = {},
): Promise<Awaited<ReturnType<typeof exportResults>>> {
  return exportResults({ dataDir, resultsDir, now: () => FIXED_NOW, ...overrides });
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

/** The configuration entry for an arm, wherever it sits in the summary. */
function configOf(summary: ExportSummary, configuration: string): ConfigurationSummary | undefined {
  for (const experiment of summary.experiments) {
    const found = experiment.configurations.find((c) => c.configuration === configuration);
    if (found) return found;
  }
  return undefined;
}

/** Every file under `dir` as relative path -> contents. */
async function snapshotTree(dir: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  async function walk(current: string): Promise<void> {
    for (const entry of await fs.readdir(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) await walk(full);
      else out[path.relative(dir, full)] = await fs.readFile(full, 'utf8');
    }
  }
  await walk(dir);
  return out;
}

describe('exportResults — bundle layout', () => {
  it('writes <resultsDir>/<YYYY-MM-DD>/ with the run records and a summary', async () => {
    await seed([cascadeRun('run-a'), cascadeRun('run-b')]);

    const outcome = await run();

    const bundleDir = path.join(resultsDir, FIXED_DATE);
    expect(outcome.date).toBe(FIXED_DATE);
    expect(outcome.bundleDir).toBe(bundleDir);
    expect(await exists(bundleDir)).toBe(true);

    // The run records themselves.
    for (const id of ['run-a', 'run-b']) {
      const file = path.join(bundleDir, 'runs', `${id}.json`);
      expect(await exists(file)).toBe(true);
      expect(await readJson<Run>(file)).toMatchObject({ id, recordingId: 'rec-1' });
    }

    // The summary.
    expect(outcome.summaryPath).toBe(path.join(bundleDir, 'summary.json'));
    const summary = await readJson<ExportSummary>(outcome.summaryPath);
    expect(summary.exportedAt).toBe(FIXED_DATE);
    expect(summary.totals.runs).toBe(2);
    expect(outcome.empty).toBe(false);
    // The path is what the CLI shell prints on success.
    expect(outcome.message).toContain(bundleDir);
  });
});

describe('exportResults — the ledger gate', () => {
  /**
   * THE LOAD-BEARING TEST. Manual, failed, ad-hoc and fixture-sourced runs are
   * real information: they stay in the exported RECORD SET. They are simply
   * never inside an AGGREGATE. Asserting only the exclusion would also pass on
   * an implementation that drops them from the bundle entirely.
   */
  const excluded: Array<{ reason: string; run: Run }> = [
    {
      reason: 'manual origin',
      run: cascadeRun('run-manual', { origin: 'manual', cost: 1 }),
    },
    {
      reason: 'failed status',
      run: cascadeRun('run-failed', {
        status: 'failed',
        timings: { speech_end: 1_000, audio_queued: 99_000 },
        cost: 1,
      }),
    },
    {
      reason: 'ad-hoc configuration',
      run: cascadeRun('run-adhoc', {
        providerTriple: { stt: 'gpt-4o-transcribe', mt: 'claude-haiku-4-5', tts: 'eleven_flash_v2_5' },
        timings: { speech_end: 1_000, audio_queued: 99_000 },
        cost: 1,
      }),
    },
    {
      reason: 'fixture-sourced',
      run: cascadeRun('run-fixture', {
        modelSnapshots: { stt: 'gpt-4o-transcribe', mt: 'fixture', tts: 'gpt-4o-mini-tts' },
        timings: { speech_end: 1_000, audio_queued: 99_000 },
        cost: 1,
      }),
    },
  ];

  it('excludes them from every aggregate while the record set still contains them', async () => {
    const clean = cascadeRun('run-clean', {
      timings: { speech_end: 1_000, audio_queued: 1_400 },
      cost: 0.01,
    });
    await seed([clean, ...excluded.map((e) => e.run)]);

    const outcome = await run();
    const summary = outcome.summary;

    // --- half one: the aggregates see ONLY the clean sweep run.
    expect(summary.totals.aggregated).toBe(1);
    expect(summary.totals.excluded).toBe(excluded.length);
    const armB = configOf(summary, 'B');
    expect(armB).toBeDefined();
    expect(armB!.n).toBe(1);
    // The excluded runs' 99 s latencies and $1 costs never reach a figure.
    expect(armB!.p50Ms).toBe(400);
    expect(armB!.p95Ms).toBe(400);
    expect(armB!.costUsd).toBeCloseTo(0.01, 10);
    // 'ad-hoc' is never a configuration in any experiment.
    expect(configOf(summary, 'ad-hoc')).toBeUndefined();

    // --- half two: all five runs are still exported records.
    expect(summary.totals.runs).toBe(5);
    const bundleDir = path.join(resultsDir, FIXED_DATE);
    for (const { reason, run: excludedRun } of excluded) {
      const file = path.join(bundleDir, 'runs', `${excludedRun.id}.json`);
      expect(await exists(file), `${reason} must stay in the record set`).toBe(true);
      expect(await readJson<Run>(file)).toMatchObject({
        id: excludedRun.id,
        origin: excludedRun.origin,
        status: excludedRun.status,
      });
    }
  });
});

describe('exportResults — actual reps completed vs intended', () => {
  it('reports actual N and reps completed vs intended per configuration', async () => {
    // Arm B: 5 intended reps on one recording, one of which failed.
    const armB = [
      cascadeRun('b-1'),
      cascadeRun('b-2'),
      cascadeRun('b-3'),
      cascadeRun('b-4'),
      cascadeRun('b-5', { status: 'failed' }),
    ];
    // Arm C: two recordings, three completed reps each.
    const armC = ['rec-1', 'rec-2'].flatMap((recordingId) =>
      [1, 2, 3].map((rep) =>
        cascadeRun(`c-${recordingId}-${rep}`, { recordingId, providerTriple: C_TRIPLE }),
      ),
    );
    await seed([...armB, ...armC]);

    const summary = (await run()).summary;

    expect(summary.intendedReps).toBe(5);

    const b = configOf(summary, 'B')!;
    expect(b.n).toBe(4);
    expect(b.repsCompleted).toBe(4);
    expect(b.repsIntended).toBe(5);
    expect(b.recordings).toEqual(['rec-1']);

    const c = configOf(summary, 'C')!;
    expect(c.n).toBe(6);
    expect(c.repsCompleted).toBe(6);
    // Two recordings swept, 5 intended reps each.
    expect(c.repsIntended).toBe(10);
    expect(c.recordings).toEqual(['rec-1', 'rec-2']);
  });

  it('takes the intended rep count from the caller', async () => {
    await seed([cascadeRun('b-1'), cascadeRun('b-2')]);

    const summary = (await run({ intendedReps: 3 })).summary;

    expect(summary.intendedReps).toBe(3);
    expect(configOf(summary, 'B')).toMatchObject({ repsCompleted: 2, repsIntended: 3 });
  });
});

describe('exportResults — empty data dir', () => {
  it('produces an empty-but-valid bundle and says so, rather than throwing', async () => {
    const outcome = await run();

    const bundleDir = path.join(resultsDir, FIXED_DATE);
    expect(await exists(bundleDir)).toBe(true);
    expect(await exists(outcome.summaryPath)).toBe(true);

    const summary = await readJson<ExportSummary>(outcome.summaryPath);
    expect(summary.exportedAt).toBe(FIXED_DATE);
    expect(summary.totals).toEqual({ runs: 0, aggregated: 0, excluded: 0 });
    expect(Array.isArray(summary.experiments)).toBe(true);
    expect(summary.empty).toBe(true);

    // It SAYS SO — an empty bundle must not read as a successful export of data.
    expect(outcome.empty).toBe(true);
    expect(outcome.message).toMatch(/empty/i);
  });
});

describe('exportResults — failure', () => {
  it('reports plainly and leaves the data dir untouched when the output path is unwritable', async () => {
    await seed([cascadeRun('run-a'), cascadeRun('run-b')]);
    const before = await snapshotTree(dataDir);

    // A FILE where the results root should be: nothing can be created under it.
    const blocked = path.join(tmpRoot, 'results-is-a-file');
    await fs.writeFile(blocked, 'not a directory', 'utf8');

    const err: unknown = await run({ resultsDir: blocked }).then(
      () => undefined,
      (e: unknown) => e,
    );

    expect(err).toBeInstanceOf(Error);
    // Plain: the message names the path that could not be written.
    expect((err as Error).message).toContain(blocked);

    // Re-runnable: data/ is byte-for-byte what it was.
    expect(await snapshotTree(dataDir)).toEqual(before);
    expect(await fs.readFile(blocked, 'utf8')).toBe('not a directory');
  });
});

describe('npm + repo wiring', () => {
  it('package.json has an export-results script that invokes scripts/export-results.mjs', async () => {
    const pkg = await readJson<{ scripts: Record<string, string> }>(
      path.join(repoRoot, 'package.json'),
    );

    expect(Object.keys(pkg.scripts)).toContain('export-results');
    expect(pkg.scripts['export-results']).toContain('scripts/export-results.mjs');
  });

  it('the CLI shell delegates to the logic module and exits non-zero on failure', async () => {
    const shell = await fs.readFile(path.join(repoRoot, 'scripts', 'export-results.mjs'), 'utf8');

    expect(shell).toContain('exportResults');
    expect(shell).toMatch(/harness\/exportResults/);
    // Non-zero exit on failure (process.exit(1) or process.exitCode = 1).
    expect(shell).toMatch(/process\.exit(Code)?\s*[(=]\s*1/);
  });

  it('leaves the ignore rules alone: data/ stays gitignored, results/ does not', async () => {
    const before = await fs.readFile(path.join(repoRoot, '.gitignore'), 'utf8');
    const lines = before.split('\n').map((l) => l.trim());

    expect(lines).toContain('data/');
    expect(lines.some((l) => /^!?results\/?$/.test(l))).toBe(false);

    await seed([cascadeRun('run-a')]);
    await run();

    expect(await fs.readFile(path.join(repoRoot, '.gitignore'), 'utf8')).toBe(before);
  });
});
