import type { CorpusCategory, CorpusUtterance } from '../../core/corpus';

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
  /**
   * Ticket 030 — the PRD §9 corpus manifest. A corpus Recording is a ≤45 s take
   * holding ~4 utterances, each with its OWN category and reference; a mic
   * Recording has none. Optional at every layer: storage is append-only and
   * every Recording written before 030 has no key at all.
   */
  utterances?: CorpusUtterance[];
  /** Stamped when the corpus take is saved; feeds the provenance line. */
  corpusVersion?: string;
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
  utterances?: CorpusUtterance[];
  corpusVersion?: string;
  /** Optional; the store stamps one when omitted. */
  createdAt?: number;
}

/**
 * Ticket 028 — the additive annotation envelope a Run carries into the ledger.
 * Mirrors src/client/state/ledger.ts's RunAnnotations field-for-field, for the
 * same reason the Recording/Run shapes are mirrored.
 *
 * Optional at every layer: a line written before this change has no
 * `annotations` key at all and must still read back.
 */
export interface RunAnnotations {
  /** 1-based repetition index within the sweep; 0 is the discarded warmup. */
  repIndex?: number;
  /** Ticket 033 — the corpus version of the Recording this Run replayed. */
  corpusVersion?: string;
}

/**
 * Ticket 031 — one measured utterance. Mirrors src/client/state/ledger.ts's
 * RunUtterance field-for-field; the Run is stored verbatim, so the server only
 * needs the vocabulary, never a derivation.
 */
export interface RunUtterance {
  utteranceId: string;
  /** 1-based, manifest order. Maps to transport `utt` as `index - 1`. */
  index: number;
  category: CorpusCategory;
  timings: Record<string, number | null>;
  transcripts: { source?: string; target?: string };
  cost: number;
  status: 'complete' | 'failed';
  errors: string[];
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
  /**
   * Ticket 028 — measurement metadata about the execution, stored verbatim
   * with the rest of the record. Absent on every Run written before it.
   */
  annotations?: RunAnnotations;
  /**
   * Ticket 031 — the per-utterance records the run produced, in manifest order.
   * Absent when the Recording carried no manifest, and absent (never partial)
   * when the run's segmentation disagreed with the manifest.
   */
  utterances?: RunUtterance[];
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

/* -------------------------------------------------------------------------
 * TICKET 041 — the LiveSession, server-side.
 *
 * Mirrors src/client/state/ledger.ts's LiveSession field-for-field, for the
 * same reason the Recording/Run shapes are mirrored: tsconfig.json excludes
 * src/server from the client program, so neither side may import the other.
 *
 * NO AUDIO-BEARING FIELD EXISTS ON THIS SHAPE, BY CONSTRUCTION (PRD §17 19h).
 * A Live session persists metrics only; there is no `audioBase64`, no
 * `outputAudioPath`, and no method anywhere that writes bytes for one.
 * ---------------------------------------------------------------------- */

export interface LiveSessionUtterance {
  id: string;
  timings: Record<string, number | null>;
  costUsd: number;
}

/** Realtime-only conversation-context policy; 'n/a' for cascade (PRD §17 21a). */
export type LiveContextPolicy = 'default' | 'trimmed' | 'n/a';

/** PRD §7. `quality.wer` is ALWAYS null in Live — there is no reference text. */
export interface LiveSession {
  id: string;
  startedAt: number;
  endedAt: number;
  durationMs: number;
  architecture: Mode;
  providerTriple?: ProviderTriple;
  contextPolicy?: LiveContextPolicy;
  modelSnapshots: Record<string, string>;
  utterances: LiveSessionUtterance[];
  latency: { p50: number | null; p95: number | null; driftMinute1ToEnd: number | null };
  cost: {
    totalUsd: number;
    perMinuteMinute1: number | null;
    perMinuteFinalMinute: number | null;
  };
  stability: {
    utterancesCompleted: number;
    disconnects: number;
    heapStart: number | null;
    heapEnd: number | null;
  };
  quality: { wer: null; subjectiveNotes?: string };
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
