/**
 * TICKET 052 ROUND 2 — R2-3 and R2-8b. The EXPORTED bundle's cost fields.
 *
 * The whole 052 change to `exportResults` was unguarded: replacing
 *
 *     sumMeasuredCosts(aggregated.map((run) => costFromStored(run.cost)))
 *
 * with the pre-052 `reduce((total, run) => total + (run.cost ?? 0), 0)` and
 * `measuredCostRuns: aggregated.length` left 2014/2014 tests green.
 * `measuredCostRuns`, `costCell` and `pricingVersion` appear in NO test file.
 *
 * WHY THIS ONE MATTERS MOST. The bundle is the artifact the write-up cites. An
 * arm with 3 of 5 runs priced exports as though all 5 were, and the field that
 * would disclose the gap is asserted nowhere — so the understatement travels
 * out of the repo, into the document, with a provenance line that looks
 * complete. It is the `$0.00` failure at the one place it becomes permanent.
 *
 * R2-8b: `latencySample` reads `speech_end` -> `audio_queued`, the REPLAY
 * anchor. Its ledger twin (`anchoredLatencyMs`) is pinned; this one is not, so
 * it could silently start accepting a Live-shaped record whose interval is a
 * different quantity, and the bundle would pool the two under one p50.
 */

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { DEFAULT_CASCADE_TRIPLE, type ProviderTriple } from '../core/arms';
import { COST_NOT_MEASURED_CELL, PRICING_VERSION } from '../core/pricing';
import { createStorage } from '../server/storage/index';
import type { Run } from '../server/storage/index';
import { makeRun } from '../server/storage/test-support';
import { exportResults } from './exportResults';
import type { ConfigurationSummary, ExportSummary } from './exportResults';

const FIXED_NOW = Date.UTC(2026, 0, 15, 12, 0, 0);
const B_TRIPLE: ProviderTriple = DEFAULT_CASCADE_TRIPLE;

let dataDir: string;
let resultsDir: string;
let tmpRoot: string;

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'wb-export-cost-'));
  dataDir = path.join(tmpRoot, 'data');
  resultsDir = path.join(tmpRoot, 'results');
  await fs.mkdir(dataDir, { recursive: true });
});

afterEach(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

/** A gate-passing Arm B run. `cost: null` is an UNPRICED run, not a free one. */
function armBRun(id: string, cost: number | null, overrides: Partial<Run> = {}): Run {
  return makeRun({
    id,
    recordingId: 'rec-1',
    architecture: 'cascade',
    providerTriple: B_TRIPLE,
    modelSnapshots: { ...B_TRIPLE },
    origin: 'sweep',
    status: 'complete',
    timings: { speech_end: 1_000, audio_queued: 1_500 },
    // `Run.cost` is `number | null` under 052; the cast is only for the days
    // the stored type still says otherwise.
    cost: cost as unknown as number,
    ...overrides,
  });
}

async function summaryFor(runs: Run[]): Promise<ConfigurationSummary> {
  const store = createStorage(dataDir);
  for (const run of runs) await store.appendRun(run);
  const outcome = await exportResults({ dataDir, resultsDir, now: () => FIXED_NOW });
  const summary = JSON.parse(
    await fs.readFile(path.join(outcome.bundleDir, 'summary.json'), 'utf8'),
  ) as ExportSummary;
  for (const experiment of summary.experiments) {
    const found = experiment.configurations.find((c) => c.configuration === 'B');
    if (found) return found;
  }
  throw new Error('Arm B is not in the exported summary');
}

describe('R2-3 · the bundle sums only the runs that were actually priced', () => {
  it('exports the measured sum and the honest denominator on a mixed arm', async () => {
    const config = await summaryFor([
      armBRun('run-a', 0.01),
      armBRun('run-b', 0.02),
      armBRun('run-c', null),
    ]);

    expect(config.n).toBe(3);
    expect(config.costUsd).toBeCloseTo(0.03, 10);
    // THE FIELD THE OLD REDUCE COULD NOT PRODUCE. `0.03` is what BOTH the
    // measured-only sum and the `?? 0` fold report; `2` against `n: 3` is the
    // only thing that separates them.
    expect(config.measuredCostRuns).toBe(2);
    expect(config.measuredCostRuns).toBeLessThan(config.n);
  });

  it('exports costUsd null and a not-measured cell when no run was priced', async () => {
    const config = await summaryFor([armBRun('run-a', null), armBRun('run-b', null)]);

    expect(config.costUsd).toBeNull();
    expect(config.measuredCostRuns).toBe(0);
    expect(config.costCell).toBe(COST_NOT_MEASURED_CELL);
    expect(config.costCell).not.toMatch(/\$0(\.0*)?$/);
  });

  it('reports a fully priced arm as fully priced', async () => {
    const config = await summaryFor([armBRun('run-a', 0.01), armBRun('run-b', 0.02)]);
    expect(config.measuredCostRuns).toBe(config.n);
    expect(config.costCell).toMatch(/^\$\d/);
  });

  it('stamps the declared price source on every configuration', async () => {
    // A rate change must visibly RESTATE the bundle rather than silently move
    // it — the same discipline `corpus-v1` and `wer-norm-v1` already carry.
    const config = await summaryFor([armBRun('run-a', 0.01)]);
    expect(config.pricingVersion).toBe(PRICING_VERSION);
    expect(config.pricingVersion).toBe('pricing-v1');
  });
});

describe('R2-8b · the exported latency sample keeps its REPLAY anchor', () => {
  it('samples speech_end -> audio_queued and nothing else', async () => {
    const config = await summaryFor([
      armBRun('run-a', 0.01, { timings: { speech_end: 1_000, audio_queued: 2_200 } }),
    ]);
    expect(config.p50Ms).toBe(1_200);
  });

  it('refuses a Live-shaped record that carries no corpus speech_end', async () => {
    // Live never stamps `speech_end` (ticket 051, option (c)); its interval
    // starts where the ENDPOINTER decided. Accepting `vad_fired` here would
    // pool two different quantities under one exported p50 — the confound the
    // ledger twin already refuses.
    const config = await summaryFor([
      armBRun('run-a', 0.01, { timings: { vad_fired: 1_000, audio_queued: 2_200 } }),
    ]);
    expect(config.p50Ms).toBeNull();
    expect(config.p95Ms).toBeNull();
    // The run is still counted and still priced — an unsampled latency is not
    // an unsampled run (ticket 027's rule).
    expect(config.n).toBe(1);
    expect(config.measuredCostRuns).toBe(1);
  });
});
