/**
 * TICKET 041 — LiveSessions get their OWN append-only stream in the store.
 *
 * THE DEFECT: after the operator's 12 Live takes, `data/` held only the seeded
 * corpus fixtures. There was no route, no storage method and no file for a
 * LiveSession anywhere under src/server — the takes existed solely in one
 * browser's localStorage. PRD §17 19i makes every Live session THE stability
 * artifact, so the artifact could not leave the machine that produced it.
 *
 * THE PRECEDENT MIRRORED HERE is ticket 023's blind-comparison stream: own
 * file, append-only, tolerant reader, record stored VERBATIM. `ledger.jsonl` is
 * typed `Run[]` and `exportResults` unions it into the exported RUN record set,
 * so a session sharing that file would be counted in `totals.runs` and derived
 * into an arm.
 *
 *   live-sessions.jsonl   append-only, ONE LINE PER LIVE SESSION
 *   appendLiveSession(session) -> the session, VERBATIM
 *   listLiveSessions()         -> every stored session, in write order
 *
 * Every test runs against a `mkdtemp` base directory.
 */
import fs from 'node:fs/promises';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createStorage } from './index';
import type { LiveSession, Storage } from './index';
import {
  LAYOUT,
  exists,
  makeEmptyLiveSession,
  makeLiveSession,
  makeRun,
  makeTempBase,
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

/** Every parsed line of the append-only live-session file, in write order. */
async function lines(): Promise<LiveSession[]> {
  const text = await fs.readFile(LAYOUT.liveSessions(dir), 'utf8');
  return text
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as LiveSession);
}

describe('ticket 041 — appendLiveSession / listLiveSessions round trip', () => {
  it('AC1: a session is stored VERBATIM and listed back field-for-field', async () => {
    const session = makeLiveSession({ id: 'live-round-trip' });

    expect(await store.appendLiveSession(session)).toEqual(session);
    expect(await store.listLiveSessions()).toEqual([session]);
    expect(await lines()).toEqual([session]);
  });

  it('AC1: sessions come back in WRITE order', async () => {
    const first = makeLiveSession({ id: 'live-1' });
    const second = makeLiveSession({ id: 'live-2', startedAt: 1 });
    await store.appendLiveSession(first);
    await store.appendLiveSession(second);

    expect((await store.listLiveSessions()).map((s) => s.id)).toEqual(['live-1', 'live-2']);
  });

  it('AC1: an empty store lists an empty array, not an ENOENT', async () => {
    expect(await store.listLiveSessions()).toEqual([]);
    expect(await exists(LAYOUT.liveSessions(dir))).toBe(false);
  });

  it('AC1: a second store on the same base directory sees the write', async () => {
    await store.appendLiveSession(makeLiveSession({ id: 'live-shared' }));

    expect((await createStorage(dir).listLiveSessions()).map((s) => s.id)).toEqual([
      'live-shared',
    ]);
  });

  it('AC5: a ZERO-UTTERANCE session is STORED like any other', async () => {
    // The operator's empty takes. Storing is not aggregating: the exclusion
    // happens in the readers, exactly as it does for a failed Run.
    const empty = makeEmptyLiveSession();

    expect(await store.appendLiveSession(empty)).toEqual(empty);
    expect(await store.listLiveSessions()).toEqual([empty]);
  });
});

describe('ticket 041 — the live-session stream is APPEND-ONLY', () => {
  it('AC1: the same id posted twice writes a SECOND line, never a rewrite', async () => {
    const first = makeLiveSession({ id: 'live-dup', endedAt: 1_000, durationMs: 1_000 });
    const second = makeLiveSession({ id: 'live-dup', endedAt: 2_000, durationMs: 2_000 });

    await store.appendLiveSession(first);
    await store.appendLiveSession(second);

    expect(await lines()).toEqual([first, second]);
    expect(await store.listLiveSessions()).toEqual([first, second]);
  });

  it('AC1: a torn line costs THAT LINE alone, not the whole stream', async () => {
    const good = makeLiveSession({ id: 'live-good' });
    await store.appendLiveSession(good);
    // A process killed part-way through a write.
    await fs.appendFile(LAYOUT.liveSessions(dir), '{"id":"live-tor\n', 'utf8');
    const after = makeLiveSession({ id: 'live-after' });
    await store.appendLiveSession(after);

    expect((await store.listLiveSessions()).map((s) => s.id)).toEqual([
      'live-good',
      'live-after',
    ]);
  });
});

describe('ticket 041 — a LiveSession NEVER lands in ledger.jsonl', () => {
  it('AC1: appending a session leaves the run ledger and the run store empty', async () => {
    await store.appendLiveSession(makeLiveSession({ id: 'live-not-a-run' }));

    expect(await store.readLedger()).toEqual([]);
    expect(await store.listRuns()).toEqual([]);
    // Not even the file exists — a session is not half a run.
    expect(await exists(LAYOUT.ledger(dir))).toBe(false);
  });

  it('AC1: with Runs present, the ledger text does not mention the session at all', async () => {
    await store.appendRun(makeRun({ id: 'run-only' }));
    await store.appendLiveSession(makeLiveSession({ id: 'live-not-a-run' }));

    const ledger = await fs.readFile(LAYOUT.ledger(dir), 'utf8');
    expect(ledger).not.toContain('live-not-a-run');
    expect((await store.readLedger()).map((r) => r.id)).toEqual(['run-only']);
    expect((await store.listRuns()).map((r) => r.id)).toEqual(['run-only']);
  });

  it('AC6: no audio and no Run JSON is written for a session', async () => {
    const session = makeLiveSession({ id: 'live-no-audio' });
    await store.appendLiveSession(session);

    expect(await exists(LAYOUT.runJson(dir, session.id))).toBe(false);
    expect(await exists(LAYOUT.runWav(dir, session.id))).toBe(false);
    expect(await exists(LAYOUT.recordingWav(dir, session.id))).toBe(false);
    // The stored shape carries no audio-bearing field of any kind.
    const [stored] = await lines();
    expect(Object.keys(stored!).sort()).toEqual([
      'architecture',
      'contextPolicy',
      'cost',
      'durationMs',
      'endedAt',
      'id',
      'latency',
      'modelSnapshots',
      'providerTriple',
      'quality',
      'stability',
      'startedAt',
      'utterances',
    ]);
  });
});
