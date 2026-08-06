/**
 * STUB (ticket 002 — test-writer). Types only, no behaviour.
 *
 * Entity vocabulary for the filesystem store (PRD §7). Server-only: this
 * module is compiled by tsconfig.server.json alone.
 */
import type { ArmTag, ProviderTriple } from '../../core/arms';
import type { Mode } from '../../core/timing';

/** Where a Recording came from. `corpus` Recordings are undeletable (PRD §7). */
export type RecordingOrigin = 'mic' | 'corpus';

/**
 * Where a Run came from. Same vocabulary as `session.start.origin` on the
 * wire protocol (PRD §7).
 */
export type RunOrigin = 'sweep' | 'manual';

/** Failed runs are stored and listed like any other (PRD §12). */
export type RunStatus = 'complete' | 'failed';

export interface Recording {
  id: string;
  label: string;
  sourceLanguage: string;
  durationMs: number;
  speechEndMs: number;
  origin: RecordingOrigin;
  createdAt: number;
  /** Set by the SOFT delete. Audio and JSON both survive. */
  deletedAt?: number;
}

/** Recording metadata as supplied by a caller — the store generates the id. */
export interface NewRecording {
  label: string;
  sourceLanguage: string;
  durationMs: number;
  speechEndMs: number;
  origin: RecordingOrigin;
  /** Optional; the store stamps one when omitted. */
  createdAt?: number;
}

export interface Run {
  id: string;
  recordingId: string;
  architecture: Mode;
  providerTriple?: ProviderTriple;
  modelSnapshots: Record<string, string>;
  armTag: ArmTag;
  origin: RunOrigin;
  status: RunStatus;
  timings: Record<string, number | null>;
  transcripts: { source?: string; target?: string };
  outputAudioPath?: string;
  cost: number;
  errors: string[];
  createdAt: number;
}

/**
 * Every storage failure the route layer has to map surfaces as one of these,
 * distinguished by `code` — never as a raw ENOENT (PRD §12).
 */
export type StorageErrorCode =
  | 'recording-not-found'
  | 'recording-audio-missing'
  | 'run-audio-missing'
  | 'corpus-undeletable';

export class StorageError extends Error {
  readonly code: StorageErrorCode;
  constructor(code: StorageErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'StorageError';
    this.code = code;
  }
}
