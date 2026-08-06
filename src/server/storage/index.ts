/**
 * STUB (ticket 002 — test-writer). Signatures only; every method throws.
 *
 * Filesystem store for Recordings and Runs (PRD §7). Pure data layer: no
 * express, no HTTP. The base directory is INJECTED so tests never write into
 * the repo.
 *
 * Layout under `baseDir` (PRD §7 — normative):
 *   recordings/<id>.wav
 *   recordings/<id>.json
 *   runs/<id>.json
 *   runs/<id>.out.wav
 *   ledger.jsonl        append-only, ONE LINE PER RUN
 */
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

function notImplemented(): never {
  throw new Error('storage: not implemented');
}

export function createStorage(baseDir: string): Storage {
  void baseDir;
  return {
    createRecording: notImplemented,
    getRecording: notImplemented,
    readRecordingAudio: notImplemented,
    listRecordings: notImplemented,
    updateRecordingLabel: notImplemented,
    deleteRecording: notImplemented,
    appendRun: notImplemented,
    writeRunAudio: notImplemented,
    readRunAudio: notImplemented,
    listRuns: notImplemented,
    readLedger: notImplemented,
  };
}
