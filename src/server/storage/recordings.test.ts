/**
 * Ticket 002 — Recordings half of the filesystem store (PRD §7, §12, §17 25c).
 *
 * Node env. Every test gets a fresh mkdtemp base dir; nothing is written into
 * the repo.
 */
import fs from 'node:fs/promises';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { StorageError, createStorage } from './index';
import type { Storage } from './index';
import {
  LAYOUT,
  exists,
  makeTempBase,
  newRecording,
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

describe('createRecording', () => {
  it('writes <id>.wav + <id>.json and returns the Recording with a generated id', async () => {
    const bytes = wavBytes(3);
    const rec = await store.createRecording(newRecording({ label: 'first' }), bytes);

    expect(typeof rec.id).toBe('string');
    expect(rec.id.length).toBeGreaterThan(0);
    expect(rec.label).toBe('first');
    expect(rec.origin).toBe('mic');
    expect(rec.durationMs).toBe(4200);
    expect(rec.speechEndMs).toBe(3800);
    expect(typeof rec.createdAt).toBe('number');

    expect(await exists(LAYOUT.recordingWav(base, rec.id))).toBe(true);
    expect(await exists(LAYOUT.recordingJson(base, rec.id))).toBe(true);
  });

  it('creates directories on demand — the base dir starts empty', async () => {
    expect(await fs.readdir(base)).toEqual([]);
    const rec = await store.createRecording(newRecording(), wavBytes());
    expect(await exists(LAYOUT.recordingWav(base, rec.id))).toBe(true);
  });

  it('gives distinct ids to distinct Recordings', async () => {
    const a = await store.createRecording(newRecording({ label: 'a' }), wavBytes(1));
    const b = await store.createRecording(newRecording({ label: 'b' }), wavBytes(2));
    expect(a.id).not.toBe(b.id);
  });
});

describe('getRecording / readRecordingAudio round-trip', () => {
  it('returns the same metadata and byte-exact audio', async () => {
    const bytes = wavBytes(9, 128);
    const created = await store.createRecording(
      newRecording({ label: 'round trip', sourceLanguage: 'es', origin: 'corpus' }),
      bytes,
    );

    const read = await store.getRecording(created.id);
    expect(read).toEqual(created);

    const audio = await store.readRecordingAudio(created.id);
    expect(Array.from(audio)).toEqual(Array.from(bytes));
  });
});

describe('listRecordings', () => {
  it('omits soft-deleted Recordings by default and includes them on request', async () => {
    const kept = await store.createRecording(newRecording({ label: 'kept' }), wavBytes(1));
    const gone = await store.createRecording(newRecording({ label: 'gone' }), wavBytes(2));
    await store.deleteRecording(gone.id);

    const visible = await store.listRecordings();
    expect(visible.map((r) => r.id)).toEqual([kept.id]);

    const all = await store.listRecordings({ includeDeleted: true });
    expect(all.map((r) => r.id).sort()).toEqual([kept.id, gone.id].sort());
    const deleted = all.find((r) => r.id === gone.id);
    expect(typeof deleted?.deletedAt).toBe('number');
  });
});

describe('updateRecordingLabel', () => {
  it('changes ONLY the label — every other field and the audio are untouched', async () => {
    const bytes = wavBytes(5, 96);
    const before = await store.createRecording(
      newRecording({ label: 'old label', sourceLanguage: 'yue' }),
      bytes,
    );

    await store.updateRecordingLabel(before.id, 'new label');
    const after = await store.getRecording(before.id);

    expect(after?.label).toBe('new label');
    expect(after?.durationMs).toBe(before.durationMs);
    expect(after?.speechEndMs).toBe(before.speechEndMs);
    expect(after?.sourceLanguage).toBe(before.sourceLanguage);
    expect(after?.origin).toBe(before.origin);
    expect(after?.createdAt).toBe(before.createdAt);
    expect(after?.deletedAt).toBe(before.deletedAt);

    const audio = await store.readRecordingAudio(before.id);
    expect(Array.from(audio)).toEqual(Array.from(bytes));
  });

  it('exposes no API for replacing a Recording’s audio (audio is immutable)', () => {
    const surface = store as unknown as Record<string, unknown>;
    for (const name of [
      'writeRecordingAudio',
      'updateRecordingAudio',
      'replaceRecordingAudio',
      'setRecordingAudio',
    ]) {
      expect(surface[name], name).toBeUndefined();
    }
  });
});

describe('deleteRecording', () => {
  it('is SOFT on a mic Recording: deletedAt stamped, wav + json survive, Runs still readable', async () => {
    const rec = await store.createRecording(newRecording({ origin: 'mic' }), wavBytes(7));
    await store.appendRun({
      id: 'run-of-deleted',
      recordingId: rec.id,
      architecture: 'cascade',
      providerTriple: { stt: 's', mt: 'm', tts: 't' },
      modelSnapshots: {},
      armTag: 'ad-hoc',
      origin: 'manual',
      status: 'complete',
      timings: {},
      transcripts: {},
      cost: 0,
      errors: [],
      createdAt: 1,
    });

    const deleted = await store.deleteRecording(rec.id);
    expect(typeof deleted.deletedAt).toBe('number');

    expect(await exists(LAYOUT.recordingWav(base, rec.id))).toBe(true);
    expect(await exists(LAYOUT.recordingJson(base, rec.id))).toBe(true);

    const stillThere = await store.getRecording(rec.id);
    expect(typeof stillThere?.deletedAt).toBe('number');
    expect(Array.from(await store.readRecordingAudio(rec.id))).toEqual(
      Array.from(wavBytes(7)),
    );

    const runs = await store.listRuns({ recordingId: rec.id });
    expect(runs.map((r) => r.id)).toEqual(['run-of-deleted']);
  });

  it('throws on a corpus Recording and changes nothing — the message says why', async () => {
    const rec = await store.createRecording(newRecording({ origin: 'corpus' }), wavBytes(4));

    await expect(store.deleteRecording(rec.id)).rejects.toThrow(/corpus/i);

    const after = await store.getRecording(rec.id);
    expect(after).toEqual(rec);
    expect(after?.deletedAt).toBeUndefined();
    expect((await store.listRecordings()).map((r) => r.id)).toEqual([rec.id]);
  });
});

describe('missing / unreadable recordings surface as typed results, never raw ENOENT', () => {
  it('getRecording on an unknown id returns undefined', async () => {
    await expect(store.getRecording('no-such-id')).resolves.toBeUndefined();
  });

  it('readRecordingAudio throws a named StorageError when the wav is absent', async () => {
    const rec = await store.createRecording(newRecording(), wavBytes(2));
    await fs.rm(LAYOUT.recordingWav(base, rec.id));

    const err = await store.readRecordingAudio(rec.id).then(
      () => undefined,
      (e: unknown) => e,
    );

    expect(err).toBeInstanceOf(StorageError);
    const storageErr = err as StorageError;
    expect(storageErr.name).toBe('StorageError');
    expect(typeof storageErr.code).toBe('string');
    expect(storageErr.code.length).toBeGreaterThan(0);
    // Not a bare fs error leaking through.
    expect((storageErr as unknown as { errno?: number }).errno).toBeUndefined();
  });

  it('gives the corpus-deletion and missing-audio failures DIFFERENT codes so a route can map them', async () => {
    const corpus = await store.createRecording(newRecording({ origin: 'corpus' }), wavBytes(1));
    const mic = await store.createRecording(newRecording({ origin: 'mic' }), wavBytes(1));
    await fs.rm(LAYOUT.recordingWav(base, mic.id));

    const deleteErr = (await store.deleteRecording(corpus.id).catch((e: unknown) => e)) as StorageError;
    const audioErr = (await store.readRecordingAudio(mic.id).catch((e: unknown) => e)) as StorageError;

    expect(deleteErr).toBeInstanceOf(StorageError);
    expect(audioErr).toBeInstanceOf(StorageError);
    expect(deleteErr.code).not.toBe(audioErr.code);
  });
});
