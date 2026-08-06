/**
 * Ticket 002 — Runs half of the filesystem store (PRD §7, §17 20b).
 *
 * The load-bearing property is APPEND-ONLY: one line per run, in append order,
 * and an earlier line is never rewritten.
 */
import fs from 'node:fs/promises';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createStorage } from './index';
import type { Run, Storage } from './index';
import {
  LAYOUT,
  exists,
  makeRun,
  makeTempBase,
  removeTempBase,
  wavBytes,
} from './test-support';

let base: string;
let store: Storage;

beforeEach(async () => {
  base = await makeTempBase();
  store = createStorage(base);
});

afterEach(async () => {
  await removeTempBase(base);
});

async function ledgerText(): Promise<string> {
  return fs.readFile(LAYOUT.ledger(base), 'utf8');
}

function nonEmptyLines(text: string): string[] {
  return text.split('\n').filter((l) => l.length > 0);
}

describe('appendRun', () => {
  it('writes runs/<id>.json and appends exactly ONE ledger line', async () => {
    const run = makeRun({ id: 'r-solo' });
    await store.appendRun(run);

    expect(await exists(LAYOUT.runJson(base, 'r-solo'))).toBe(true);

    const lines = nonEmptyLines(await ledgerText());
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!)).toMatchObject({ id: 'r-solo', recordingId: 'rec-1' });
  });

  it('is append-only: three appends leave a 3-line ledger in append order', async () => {
    for (const id of ['r-1', 'r-2', 'r-3']) {
      await store.appendRun(makeRun({ id, createdAt: 1 }));
    }

    const lines = nonEmptyLines(await ledgerText());
    expect(lines).toHaveLength(3);
    expect(lines.map((l) => (JSON.parse(l) as { id: string }).id)).toEqual([
      'r-1',
      'r-2',
      'r-3',
    ]);
  });

  it('never rewrites an earlier line — the previous content is a byte-exact prefix', async () => {
    await store.appendRun(makeRun({ id: 'r-1' }));
    await store.appendRun(makeRun({ id: 'r-2' }));
    const afterTwo = await ledgerText();

    await store.appendRun(makeRun({ id: 'r-3' }));
    const afterThree = await ledgerText();

    expect(afterThree.startsWith(afterTwo)).toBe(true);
    expect(nonEmptyLines(afterThree)).toHaveLength(3);
  });
});

describe('run audio', () => {
  it('writeRunAudio writes runs/<id>.out.wav and readRunAudio returns the exact bytes', async () => {
    const bytes = wavBytes(11, 200);
    await store.appendRun(makeRun({ id: 'r-audio' }));
    await store.writeRunAudio('r-audio', bytes);

    expect(await exists(LAYOUT.runWav(base, 'r-audio'))).toBe(true);
    const read = await store.readRunAudio('r-audio');
    expect(Array.from(read)).toEqual(Array.from(bytes));
  });
});

describe('listRuns', () => {
  it('returns every run, and filters to one Recording when asked', async () => {
    await store.appendRun(makeRun({ id: 'r-a', recordingId: 'rec-A' }));
    await store.appendRun(makeRun({ id: 'r-b', recordingId: 'rec-B' }));
    await store.appendRun(makeRun({ id: 'r-c', recordingId: 'rec-A' }));

    const all = await store.listRuns();
    expect(all.map((r) => r.id).sort()).toEqual(['r-a', 'r-b', 'r-c']);

    const onlyA = await store.listRuns({ recordingId: 'rec-A' });
    expect(onlyA.map((r) => r.id).sort()).toEqual(['r-a', 'r-c']);
  });

  it('stores and lists a failed run like any other — storage does not filter it out', async () => {
    const failed = makeRun({
      id: 'r-failed',
      status: 'failed',
      errors: ['tts: upstream 500'],
      transcripts: { source: 'hello' },
      outputAudioPath: undefined,
    });
    await store.appendRun(failed);
    await store.appendRun(makeRun({ id: 'r-ok', status: 'complete' }));

    const all = await store.listRuns();
    expect(all.map((r) => r.id).sort()).toEqual(['r-failed', 'r-ok']);
    const readBack = all.find((r) => r.id === 'r-failed');
    expect(readBack?.status).toBe('failed');
    expect(readBack?.errors).toEqual(['tts: upstream 500']);

    const ledger = await store.readLedger();
    expect(ledger.map((r) => r.id)).toContain('r-failed');
  });
});

describe('readLedger', () => {
  it('parses ledger.jsonl back into run records', async () => {
    const runs = [
      makeRun({ id: 'r-1', recordingId: 'rec-A', armTag: 'B' }),
      makeRun({ id: 'r-2', recordingId: 'rec-B', armTag: 'C', origin: 'sweep' }),
    ];
    for (const r of runs) await store.appendRun(r);

    const ledger = await store.readLedger();
    expect(ledger.map((r) => r.id)).toEqual(['r-1', 'r-2']);
    expect(ledger[1]).toMatchObject({ recordingId: 'rec-B', armTag: 'C', origin: 'sweep' });
  });

  it('tolerates a trailing newline', async () => {
    await store.appendRun(makeRun({ id: 'r-1' }));
    const text = await ledgerText();
    if (!text.endsWith('\n')) await fs.appendFile(LAYOUT.ledger(base), '\n');
    await fs.appendFile(LAYOUT.ledger(base), '\n');

    const ledger = await store.readLedger();
    expect(ledger.map((r) => r.id)).toEqual(['r-1']);
  });

  it('skips a malformed final line without throwing — a crash mid-write costs one line', async () => {
    await store.appendRun(makeRun({ id: 'r-1' }));
    await store.appendRun(makeRun({ id: 'r-2' }));
    // Simulate a process killed part-way through writing the third line.
    await fs.appendFile(LAYOUT.ledger(base), '{"id":"r-3","recordi');

    const ledger = await store.readLedger();
    expect(ledger.map((r) => r.id)).toEqual(['r-1', 'r-2']);
  });
});

/* --------------------------------------------------------------- ticket 028 */

/**
 * TICKET 028 — the persisted Run gains an ANNOTATION ENVELOPE so a sweep's
 * repetition index survives to the Results derivations. Without it
 * `buildProvenance`'s denominator collapses onto its numerator and provenance
 * can only ever read "N of N".
 *
 * The envelope is ADDITIVE and OPTIONAL at every layer: a pre-028 ledger line
 * has no `annotations` key at all and must still read back, and a torn line
 * must still cost exactly that line.
 */
/**
 * A stored Run carrying the rep index the sweep executed it as. Annotated at
 * `Run` on purpose: this does not compile until the persisted shape declares
 * the field, which is half of what this ticket is.
 */
function annotatedRun(id: string, repIndex: number, origin: Run['origin'] = 'sweep'): Run {
  return { ...makeRun({ id, origin }), annotations: { repIndex } };
}

describe('ticket 028 — run annotations ride the persisted envelope', () => {
  it('appendRun stores annotations.repIndex; readLedger and listRuns give it back', async () => {
    const stored = annotatedRun('r-rep-3', 3);
    await store.appendRun(stored);

    // The ledger line is the record, verbatim — annotations included.
    const line = JSON.parse(nonEmptyLines(await ledgerText())[0]!) as Run;
    expect(line.annotations?.repIndex).toBe(3);
    expect(line).toEqual(stored);

    const [fromLedger] = await store.readLedger();
    expect(fromLedger!.annotations?.repIndex).toBe(3);

    // ...and the runs/<id>.json half agrees, which is what GET /api/runs reads.
    const [fromList] = await store.listRuns();
    expect(fromList!.annotations?.repIndex).toBe(3);
    expect(fromList).toEqual(stored);
  });

  it('the warmup is persisted as repIndex 0 with origin manual, distinct from rep 1', async () => {
    await store.appendRun(annotatedRun('r-warmup', 0, 'manual'));
    await store.appendRun(annotatedRun('r-rep-1', 1));

    const ledger = await store.readLedger();
    expect(ledger.map((r) => [r.id, r.origin, r.annotations?.repIndex])).toEqual([
      ['r-warmup', 'manual', 0],
      ['r-rep-1', 'sweep', 1],
    ]);
  });

  it('is ADDITIVE: a pre-028 line without annotations still reads, and a torn line still costs one line', async () => {
    // A line written before this change: no `annotations` key at any depth.
    const legacy = makeRun({ id: 'r-legacy' });
    expect(JSON.stringify(legacy)).not.toContain('annotations');
    await store.appendRun(legacy);
    await store.appendRun(annotatedRun('r-annotated', 2));
    // A process killed part-way through writing a third line.
    await fs.appendFile(LAYOUT.ledger(base), '{"id":"r-torn","annotations":{"repInd');

    const ledger = await store.readLedger();
    expect(ledger.map((r) => r.id)).toEqual(['r-legacy', 'r-annotated']);
    expect(ledger[0]!.annotations).toBeUndefined();
    expect(ledger[0]).toEqual(legacy);
    expect(ledger[1]!.annotations?.repIndex).toBe(2);
  });
});

describe('state lives on disk, not in process memory', () => {
  it('a second store on the same base path sees the first store’s writes', async () => {
    const rec = await store.createRecording(
      {
        label: 'shared',
        sourceLanguage: 'en',
        durationMs: 1000,
        speechEndMs: 900,
        origin: 'mic',
      },
      wavBytes(6, 48),
    );
    await store.appendRun(makeRun({ id: 'r-shared', recordingId: rec.id }));
    await store.writeRunAudio('r-shared', wavBytes(8, 32));

    const other = createStorage(base);

    expect(await other.getRecording(rec.id)).toEqual(rec);
    expect(Array.from(await other.readRecordingAudio(rec.id))).toEqual(
      Array.from(wavBytes(6, 48)),
    );
    expect((await other.listRuns()).map((r) => r.id)).toEqual(['r-shared']);
    expect(Array.from(await other.readRunAudio('r-shared'))).toEqual(
      Array.from(wavBytes(8, 32)),
    );
    expect((await other.readLedger()).map((r) => r.id)).toEqual(['r-shared']);
  });
});
