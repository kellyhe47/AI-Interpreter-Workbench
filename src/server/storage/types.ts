/**
 * Entity vocabulary for the filesystem store (PRD §7). Server-only: this
 * module is compiled by tsconfig.server.json alone.
 *
 * The shared names are IMPORTED, never re-declared: `ArmTag`/`ProviderTriple`
 * from core/arms, `Mode` from core/timing, and `RunOrigin` from core/protocol —
 * a stored Run's origin and `session.start.origin` are the same vocabulary, so
 * there is exactly one declaration of it.
 */
import type { ArmTag, ProviderTriple } from '../../core/arms';
import type { RunOrigin } from '../../core/protocol';
import type { Mode } from '../../core/timing';

/** Where a Recording came from. `corpus` Recordings are undeletable (PRD §7). */
export type RecordingOrigin = 'mic' | 'corpus';

export type { RunOrigin };

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
 * Ticket 023 — one sample's two scores (PRD §10).
 * Mirrors src/client/state/ledger.ts's BlindComparison field-for-field, for
 * the same reason the Recording/Run shapes are mirrored: tsconfig.json excludes
 * src/server from the client program, so neither side may import the other.
 */
export interface BlindSampleScores {
  adequacy: number;
  fluency: number;
}

/**
 * Ticket 023 — a submitted pairwise blind comparison. Server-side twin of the
 * client type; it lands in its own append-only `comparisons.jsonl`.
 */
export interface BlindComparison {
  id: string;
  /** Both runs are Runs of THIS Recording. */
  recordingId: string;
  /** The two Runs compared, as picked. */
  runIds: [string, string];
  /** The drawn assignment: order[0] was Sample A, order[1] was Sample B. */
  order: [string, string];
  /** The language the evaluator judged in (PRD §10). */
  evaluatorLanguage: string;
  scores: { A: BlindSampleScores; B: BlindSampleScores };
  createdAt: number;
  revealedAt: number;
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
