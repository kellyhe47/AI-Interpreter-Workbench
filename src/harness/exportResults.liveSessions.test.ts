/**
 * TICKET 041 — Live sessions in the exported bundle.
 *
 * `npm run export-results` reads the SERVER ledger, so while Live sessions
 * lived in localStorage no Live metric could appear in the bundle the write-up
 * cites — even though PRD §17 19i makes every Live session THE stability
 * artifact.
 *
 * THE BUNDLE MEMBERS THIS SUITE PINS:
 *   live-sessions.json        every stored session, VERBATIM, written
 *                             unconditionally (an empty array on an empty store)
 *   summary.liveSessions      a TOP-LEVEL field, never inside `totals`:
 *     { total,            every session in the bundle
 *       aggregated,       real AND non-empty — the ones a figure may use
 *       excluded,         total - aggregated
 *       zeroUtterance,    sessions that produced nothing (stored, not counted)
 *       fixtureSourced,   ticket 018's rule (may overlap zeroUtterance)
 *       byArm }           AGGREGATED sessions per DERIVED arm tag
 *
 * `totals` counts RUNS and its exact shape is pinned by the locked
 * exportResults.test.ts empty-bundle test. A five-minute soak over free
 * conversation is not a Run over a fixed Recording.
 *
 * ADDITIVE to exportResults.test.ts and exportResults.comparisons.test.ts.
 * Both directories are `mkdtemp`.
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { DEFAULT_CASCADE_TRIPLE, REALTIME_MODEL } from '../core/arms';
import { createStorage } from '../server/storage/index';
import type { LiveSession, Run } from '../server/storage/index';
import { LAYOUT, makeEmptyLiveSession, makeLiveSession, makeRun } from '../server/storage/test-support';
import { exportResults } from './exportResults';
import type { ExportSummary } from './exportResults';

const FIXED_NOW = Date.UTC(2026, 0, 15, 12, 0, 0);
const FIXED_DATE = '2026-01-15';

/** The bundle member holding the exported LiveSession records. */
const LIVE_SESSIONS_FILE = 'live-sessions.json';

let dataDir: string;
let resultsDir: string;
let tmpRoot: string;

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'wb-export-live-'));
  dataDir = path.join(tmpRoot, 'data');
  resultsDir = path.join(tmpRoot, 'results');
  await fs.mkdir(dataDir, { recursive: true });
});

afterEach(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

/** An Arm B cascade session with two measured utterances. */
function cascadeSession(id: string, overrides: Partial<LiveSession> = {}): LiveSession {
  return makeLiveSession({
    id,
    architecture: 'cascade',
    providerTriple: { ...DEFAULT_CASCADE_TRIPLE },
    modelSnapshots: { ...DEFAULT_CASCADE_TRIPLE },
    ...overrides,
  });
}

/** An Arm A realtime session on the pinned model. */
function realtimeSession(id: string, overrides: Partial<LiveSession> = {}): LiveSession {
  return makeLiveSession({
    id,
    architecture: 'realtime',
    providerTriple: undefined,
    contextPolicy: 'default',
    modelSnapshots: { realtime: REALTIME_MODEL },
    ...overrides,
  });
}

/**
 * Seeded by appending to the store's own append-only file rather than through
 * `appendLiveSession`, so a failure in this suite is an EXPORT failure and
 * never a seeding failure.
 */
async function seedSessions(sessions: LiveSession[]): Promise<void> {
  await fs.mkdir(dataDir, { recursive: true });
  for (const session of sessions) {
    await fs.appendFile(LAYOUT.liveSessions(dataDir), `${JSON.stringify(session)}\n`, 'utf8');
  }
}

async function seedRuns(runs: Run[]): Promise<void> {
  const store = createStorage(dataDir);
  for (const run of runs) await store.appendRun(run);
}

function sweepRun(id: string): Run {
  return makeRun({
    id,
    recordingId: 'rec-1',
    architecture: 'cascade',
    providerTriple: { ...DEFAULT_CASCADE_TRIPLE },
    modelSnapshots: { ...DEFAULT_CASCADE_TRIPLE },
    origin: 'sweep',
    status: 'complete',
    timings: { speech_end: 1_000, audio_queued: 1_500 },
    cost: 0.01,
  });
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

describe('ticket 041 — the export bundle includes the Live sessions', () => {
  it('AC3: the session records are written into the bundle, verbatim', async () => {
    const sessions = [cascadeSession('live-1'), realtimeSession('live-2')];
    await seedSessions(sessions);

    const outcome = await run();

    const file = path.join(outcome.bundleDir, LIVE_SESSIONS_FILE);
    expect(await exists(file)).toBe(true);
    expect(await readJson<LiveSession[]>(file)).toEqual(sessions);
  });

  it('AC3: the summary discloses how many sessions were aggregated, per arm', async () => {
    await seedSessions([
      cascadeSession('live-b1'),
      cascadeSession('live-b2'),
      realtimeSession('live-a1'),
    ]);

    const summary = (await run()).summary;

    expect(summary.liveSessions.total).toBe(3);
    expect(summary.liveSessions.aggregated).toBe(3);
    expect(summary.liveSessions.excluded).toBe(0);
    expect(summary.liveSessions.byArm).toEqual({ A: 1, B: 2 });
  });

  it('AC3: the disclosure is on disk in summary.json, not only in the return value', async () => {
    await seedSessions([cascadeSession('live-b1')]);

    const outcome = await run();

    const onDisk = await readJson<ExportSummary>(outcome.summaryPath);
    expect(onDisk.liveSessions).toEqual(outcome.summary.liveSessions);
    expect(onDisk.liveSessions.aggregated).toBe(1);
  });

  it('AC3: an empty store discloses zeros, not a missing field or a missing file', async () => {
    const outcome = await run();

    expect(outcome.summary.liveSessions).toEqual({
      total: 0,
      aggregated: 0,
      excluded: 0,
      zeroUtterance: 0,
      fixtureSourced: 0,
      byArm: {},
    });
    // Written unconditionally, so the bundle's shape never depends on whether
    // anyone ran a Live session.
    expect(await readJson<LiveSession[]>(path.join(bundle(), LIVE_SESSIONS_FILE))).toEqual([]);
  });

  it('a torn session line costs that line alone, not the export', async () => {
    await seedSessions([cascadeSession('live-b1')]);
    await fs.appendFile(LAYOUT.liveSessions(dataDir), '{"id":"live-tor\n', 'utf8');

    const summary = (await run()).summary;

    expect(summary.liveSessions.total).toBe(1);
    expect(summary.liveSessions.aggregated).toBe(1);
  });
});

/* =========================== stored but never aggregated: empty + fixture = */

describe('ticket 041 — a session that produced nothing is stored, never aggregated', () => {
  it('AC5: a ZERO-UTTERANCE session is in the bundle but in no figure', async () => {
    await seedSessions([cascadeSession('live-real'), makeEmptyLiveSession({ id: 'live-empty' })]);

    const outcome = await run();

    const exported = await readJson<LiveSession[]>(
      path.join(outcome.bundleDir, LIVE_SESSIONS_FILE),
    );
    expect(exported.map((s) => s.id)).toEqual(['live-real', 'live-empty']);

    const { liveSessions } = outcome.summary;
    expect(liveSessions.total).toBe(2);
    expect(liveSessions.aggregated).toBe(1);
    expect(liveSessions.excluded).toBe(1);
    expect(liveSessions.zeroUtterance).toBe(1);
    // One session in the column, not two: a zero is not a measurement.
    expect(liveSessions.byArm).toEqual({ B: 1 });
  });

  it('AC5: a bundle of nothing BUT empty sessions aggregates nothing at all', async () => {
    await seedSessions([
      makeEmptyLiveSession({ id: 'live-empty-1' }),
      makeEmptyLiveSession({ id: 'live-empty-2' }),
      makeEmptyLiveSession({
        id: 'live-empty-3',
        architecture: 'realtime',
        providerTriple: undefined,
        modelSnapshots: { realtime: REALTIME_MODEL },
      }),
    ]);

    const summary = (await run()).summary;

    expect(summary.liveSessions.total).toBe(3);
    expect(summary.liveSessions.aggregated).toBe(0);
    expect(summary.liveSessions.zeroUtterance).toBe(3);
    expect(summary.liveSessions.byArm).toEqual({});
  });

  it('AC4: a FIXTURE-sourced session is exported but never reaches a figure', async () => {
    const fixture = cascadeSession('live-fixture', {
      providerTriple: { ...DEFAULT_CASCADE_TRIPLE, tts: 'fixture' },
      modelSnapshots: { ...DEFAULT_CASCADE_TRIPLE, tts: 'fixture' },
    });
    await seedSessions([cascadeSession('live-real'), fixture]);

    const outcome = await run();

    expect(
      await readJson<LiveSession[]>(path.join(outcome.bundleDir, LIVE_SESSIONS_FILE)),
    ).toContainEqual(fixture);

    const { liveSessions } = outcome.summary;
    expect(liveSessions.total).toBe(2);
    expect(liveSessions.aggregated).toBe(1);
    expect(liveSessions.fixtureSourced).toBe(1);
    expect(liveSessions.byArm).toEqual({ B: 1 });
  });

  it('AC4: a realtime session on a fixture model snapshot is excluded too', async () => {
    await seedSessions([
      realtimeSession('live-fixture-rt', { modelSnapshots: { realtime: 'fixture' } }),
    ]);

    const { liveSessions } = (await run()).summary;

    expect(liveSessions.total).toBe(1);
    expect(liveSessions.aggregated).toBe(0);
    expect(liveSessions.fixtureSourced).toBe(1);
    expect(liveSessions.byArm).toEqual({});
  });
});

/* ============================================================== guards ==== */

describe('ticket 041 — what Live sessions must NOT disturb', () => {
  it('AC1: sessions never inflate the RUN totals, and no run record is written for one', async () => {
    await seedRuns([sweepRun('b-1'), sweepRun('b-2')]);
    await seedSessions([cascadeSession('live-1'), cascadeSession('live-2')]);

    const summary = (await run()).summary;

    // A session sharing ledger.jsonl would show up here as a third and fourth
    // "run" and would be derived into Arm B's aggregate.
    expect(summary.totals).toEqual({ runs: 2, aggregated: 2, excluded: 0 });
    expect(await exists(path.join(bundle(), 'runs', 'live-1.json'))).toBe(false);
    expect(await exists(path.join(bundle(), 'runs', 'live-2.json'))).toBe(false);
  });

  it('AC6: no Live audio is written anywhere in the bundle', async () => {
    await seedSessions([cascadeSession('live-1')]);

    await run();

    const names = await fs.readdir(bundle(), { recursive: true, withFileTypes: false });
    expect(names.filter((n) => String(n).endsWith('.wav'))).toEqual([]);
  });

  it('the run figures are byte-identical with and without sessions in the store', async () => {
    await seedRuns([sweepRun('b-1'), sweepRun('b-2')]);
    const before = (await run()).summary.experiments;

    await seedSessions([cascadeSession('live-1'), makeEmptyLiveSession({ id: 'live-empty' })]);
    const after = (await run()).summary.experiments;

    expect(after).toEqual(before);
  });
});
