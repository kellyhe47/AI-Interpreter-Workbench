/**
 * Filesystem store for Recordings and Runs (PRD §7). Pure data layer: no
 * express, no HTTP. Routes (ticket 003) sit on top of this and never reach for
 * `fs` themselves.
 *
 * Layout under `baseDir` (PRD §7 — normative):
 *   recordings/<id>.wav     24 kHz mono PCM16, opaque bytes to this module
 *   recordings/<id>.json    the Recording record
 *   runs/<id>.json          the Run record
 *   runs/<id>.out.wav       synthesized output audio
 *   ledger.jsonl            append-only, ONE LINE PER RUN
 *
 * THE BASE DIRECTORY IS INJECTED, NEVER HARDCODED. `createStorage(baseDir)`
 * takes the root as an argument so tests run against a `mkdtemp` directory and
 * nothing is ever written into the repo. Directories are created on demand, so
 * a caller may point the store at an empty (or not-yet-existing) path.
 *
 * STATE LIVES ON DISK, NOT IN THE PROCESS. There is no cache and no index: every
 * read goes to the filesystem. Two stores on the same base path therefore see
 * each other's writes, and a restart loses nothing — which is the only reason
 * the sweep runner and the HTTP process can be different processes.
 *
 * THE LEDGER IS APPEND-ONLY (PRD §17 20b). `appendRun` opens ledger.jsonl with
 * the 'a' flag and writes one newline-terminated JSON object. It never reads
 * the file, never rewrites an earlier line, and never rewrites the whole file:
 * a read-modify-write would make a crash mid-write cost the entire benchmark
 * history. `readLedger` pays for that by being tolerant — it skips any line it
 * cannot parse, so a process killed part-way through a write costs ONE line.
 *
 * AUDIO IS IMMUTABLE. A Recording's WAV is written once, by `createRecording`,
 * and there is deliberately no method to replace it. Only the label is mutable
 * (`updateRecordingLabel`), and it rewrites the JSON alone. If a run's audio
 * could be swapped underneath a recorded measurement, every number already in
 * the ledger would silently stop meaning anything.
 *
 * DELETION IS SOFT, AND CORPUS IS UNDELETABLE (PRD §7, §17 25c).
 * `deleteRecording` on a `mic` Recording stamps `deletedAt` and leaves both the
 * WAV and the JSON in place, so Runs that cite it stay readable and the ledger
 * never dangles. On a `corpus` Recording it throws and changes nothing: the
 * corpus is the shared comparison baseline, and losing a clip would retro-
 * actively invalidate every arm measured against it.
 *
 * FAILURES ARE TYPED, NEVER RAW ENOENT (PRD §12). Missing metadata is a value
 * (`getRecording` -> undefined); missing audio and corpus deletion are
 * `StorageError`s with distinct `code`s, so the route layer can map them to
 * status codes without sniffing `errno`.
 */
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

import { StorageError } from './types';
import type { NewRecording, Recording, Run } from './types';

export type {
  NewRecording,
  Recording,
  RecordingOrigin,
  Run,
  RunOrigin,
  RunStatus,
  StorageErrorCode,
} from './types';
export { StorageError } from './types';

export interface ListRecordingsOptions {
  /** Soft-deleted Recordings are omitted unless this is true. */
  includeDeleted?: boolean;
}

export interface ListRunsOptions {
  recordingId?: string;
}

export interface Storage {
  createRecording(meta: NewRecording, wavBytes: Uint8Array): Promise<Recording>;
  getRecording(id: string): Promise<Recording | undefined>;
  readRecordingAudio(id: string): Promise<Uint8Array>;
  listRecordings(opts?: ListRecordingsOptions): Promise<Recording[]>;
  updateRecordingLabel(id: string, label: string): Promise<Recording>;
  deleteRecording(id: string): Promise<Recording>;

  appendRun(run: Run): Promise<Run>;
  writeRunAudio(runId: string, wavBytes: Uint8Array): Promise<void>;
  readRunAudio(runId: string): Promise<Uint8Array>;
  listRuns(opts?: ListRunsOptions): Promise<Run[]>;
  readLedger(): Promise<Run[]>;
}

/**
 * Monotonic tiebreaker: `randomUUID` alone is already unique, but the counter
 * keeps ids from rapid successive calls sortable in creation order.
 */
let idCounter = 0;

function newId(prefix: string): string {
  idCounter += 1;
  const stamp = Date.now().toString(36);
  const seq = idCounter.toString(36).padStart(3, '0');
  return `${prefix}_${stamp}${seq}_${randomUUID().slice(0, 8)}`;
}

function isNotFound(err: unknown): boolean {
  return (err as { code?: string } | null)?.code === 'ENOENT';
}

async function ensureDir(dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
}

/** Read + parse a JSON record, or `undefined` when the file is not there. */
async function readJson<T>(file: string): Promise<T | undefined> {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8')) as T;
  } catch (err) {
    if (isNotFound(err)) return undefined;
    throw err;
  }
}

async function writeJson(file: string, value: unknown): Promise<void> {
  await ensureDir(path.dirname(file));
  await fs.writeFile(file, `${JSON.stringify(value)}\n`, 'utf8');
}

export function createStorage(baseDir: string): Storage {
  const recordingsDir = path.join(baseDir, 'recordings');
  const runsDir = path.join(baseDir, 'runs');
  const ledgerFile = path.join(baseDir, 'ledger.jsonl');

  const recordingJson = (id: string) => path.join(recordingsDir, `${id}.json`);
  const recordingWav = (id: string) => path.join(recordingsDir, `${id}.wav`);
  const runJson = (id: string) => path.join(runsDir, `${id}.json`);
  const runWav = (id: string) => path.join(runsDir, `${id}.out.wav`);

  async function getRecording(id: string): Promise<Recording | undefined> {
    return readJson<Recording>(recordingJson(id));
  }

  async function requireRecording(id: string): Promise<Recording> {
    const rec = await getRecording(id);
    if (!rec) {
      throw new StorageError('recording-not-found', `no recording with id "${id}"`);
    }
    return rec;
  }

  async function readAudio(
    file: string,
    code: 'recording-audio-missing' | 'run-audio-missing',
    message: string,
  ): Promise<Uint8Array> {
    try {
      const buf = await fs.readFile(file);
      return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
    } catch (err) {
      if (isNotFound(err)) throw new StorageError(code, message, { cause: err });
      throw err;
    }
  }

  /** Ids of the `<id>.<ext>` files in a directory; `[]` when it does not exist. */
  async function idsIn(dir: string, ext: string): Promise<string[]> {
    try {
      const names = await fs.readdir(dir);
      return names
        .filter((n) => n.endsWith(ext))
        .map((n) => n.slice(0, -ext.length))
        .sort();
    } catch (err) {
      if (isNotFound(err)) return [];
      throw err;
    }
  }

  return {
    async createRecording(meta: NewRecording, wavBytes: Uint8Array): Promise<Recording> {
      const rec: Recording = {
        id: newId('rec'),
        label: meta.label,
        sourceLanguage: meta.sourceLanguage,
        durationMs: meta.durationMs,
        speechEndMs: meta.speechEndMs,
        origin: meta.origin,
        createdAt: meta.createdAt ?? Date.now(),
      };
      await ensureDir(recordingsDir);
      // Audio first: a crash between the two writes leaves an orphan wav, which
      // is inert, rather than metadata pointing at audio that never landed.
      await fs.writeFile(recordingWav(rec.id), wavBytes);
      await writeJson(recordingJson(rec.id), rec);
      return rec;
    },

    getRecording,

    async readRecordingAudio(id: string): Promise<Uint8Array> {
      return readAudio(
        recordingWav(id),
        'recording-audio-missing',
        `recording "${id}" has no audio on disk`,
      );
    },

    async listRecordings(opts: ListRecordingsOptions = {}): Promise<Recording[]> {
      const ids = await idsIn(recordingsDir, '.json');
      const recs: Recording[] = [];
      for (const id of ids) {
        const rec = await getRecording(id);
        if (!rec) continue;
        if (rec.deletedAt !== undefined && !opts.includeDeleted) continue;
        recs.push(rec);
      }
      return recs.sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
    },

    async updateRecordingLabel(id: string, label: string): Promise<Recording> {
      const rec = await requireRecording(id);
      // Label only: every other field, and the audio, is carried through
      // untouched.
      const next: Recording = { ...rec, label };
      await writeJson(recordingJson(id), next);
      return next;
    },

    async deleteRecording(id: string): Promise<Recording> {
      const rec = await requireRecording(id);
      if (rec.origin === 'corpus') {
        throw new StorageError(
          'corpus-undeletable',
          `recording "${id}" is a corpus recording: the corpus is the shared ` +
            'comparison baseline, so it cannot be deleted',
        );
      }
      if (rec.deletedAt !== undefined) return rec;
      // SOFT: stamp only. The wav and the json both stay, so Runs citing this
      // recording remain readable.
      const next: Recording = { ...rec, deletedAt: Date.now() };
      await writeJson(recordingJson(id), next);
      return next;
    },

    async appendRun(run: Run): Promise<Run> {
      await ensureDir(runsDir);
      await writeJson(runJson(run.id), run);
      // APPEND-ONLY: one line, 'a' flag, no read of the existing file.
      await ensureDir(baseDir);
      await fs.appendFile(ledgerFile, `${JSON.stringify(run)}\n`, 'utf8');
      return run;
    },

    async writeRunAudio(runId: string, wavBytes: Uint8Array): Promise<void> {
      await ensureDir(runsDir);
      await fs.writeFile(runWav(runId), wavBytes);
    },

    async readRunAudio(runId: string): Promise<Uint8Array> {
      return readAudio(
        runWav(runId),
        'run-audio-missing',
        `run "${runId}" has no output audio on disk`,
      );
    },

    async listRuns(opts: ListRunsOptions = {}): Promise<Run[]> {
      const ids = await idsIn(runsDir, '.json');
      const runs: Run[] = [];
      for (const id of ids) {
        const run = await readJson<Run>(runJson(id));
        if (!run) continue;
        // Failed runs are listed like any other — they are excluded from
        // aggregates by the reader, not here.
        if (opts.recordingId !== undefined && run.recordingId !== opts.recordingId) {
          continue;
        }
        runs.push(run);
      }
      return runs;
    },

    async readLedger(): Promise<Run[]> {
      let text: string;
      try {
        text = await fs.readFile(ledgerFile, 'utf8');
      } catch (err) {
        if (isNotFound(err)) return [];
        throw err;
      }
      const runs: Run[] = [];
      for (const line of text.split('\n')) {
        if (line.trim().length === 0) continue;
        try {
          runs.push(JSON.parse(line) as Run);
        } catch {
          // A torn line (process killed mid-write) costs that line, not the
          // whole ledger.
        }
      }
      return runs;
    },
  };
}
