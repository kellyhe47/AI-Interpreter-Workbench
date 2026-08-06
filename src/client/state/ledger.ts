/**
 * Ticket 009 — Run ledger.
 *
 * Append-only store of UtteranceRecords plus blind-test draws, with
 * export/import, aggregates, and pluggable persistence.
 *
 * Design decisions (locked by ledger.test.ts):
 *
 * - Storage: constructor takes an optional {getItem, setItem} adapter (the
 *   localStorage subset). Default is in-memory. The whole ledger state is
 *   persisted as ONE JSON blob under LEDGER_STORAGE_KEY; every append /
 *   recordBlindDraw / recordBlindScores writes through via setItem, and the
 *   constructor restores from storage when a blob is present.
 * - Append-only: records are never mutated or removed. getRecords(runId?)
 *   returns deep copies — mutating the returned array or a returned record
 *   must not affect the store.
 * - REALNESS RULE (PRD: no fixture/placeholder number is ever reported):
 *   a record is "real" iff none of providers.stt/mt/tts === 'fixture' AND
 *   corpusId does not start with 'placeholder' AND arm !== 'fixture'.
 *   aggregates() and hasRuns consider ONLY real records. Fixture/placeholder
 *   records are still stored and exported (they are dev data) but never
 *   aggregated.
 * - aggregates(runId?) → { perArm } keyed by arm id, one entry per arm with
 *   at least one real record (fixture-only arms are absent). Perceived
 *   end-to-end latency = timings.audio_queued − timings.speech_end. Records
 *   missing either timestamp still count toward `count` and `costUsd` but
 *   are excluded from percentiles. Percentiles use nearest-rank:
 *   sorted[ceil(p * n) − 1] (p50 of 10 sorted values = 5th, p95 = 10th).
 *   No latency samples → p50Ms/p95Ms are null, never 0.
 * - costUsd = sum of costUnits over the aggregated records (costUnits are
 *   denominated in USD).
 * - Blind draws: recordBlindDraw({id, utteranceId, order, createdAt}) stores
 *   a draw; the draw belongs to the run of the utterance it references.
 *   recordBlindScores({drawId, scores, revealedAt}) attaches scores to an
 *   existing draw and throws an Error naming the drawId when unknown.
 * - exportRuns() → JSON-serializable {runs: [{runId, records, blindDraws}]},
 *   runs in first-appended order, records in append order, draws included
 *   with any attached scores. importRuns(data) REPLACES the current state;
 *   importRuns(exportRuns()) round-trips deep-equal.
 * - hasRuns getter: true iff at least one REAL record is stored.
 */

import type { ArmTag, ProviderTriple } from '../../core/arms';
import type { RunOrigin } from '../../core/protocol';
import type { Mode, UtteranceRecord } from '../../core/timing';

/* -------------------------------------------------------------------------
 * Ticket 010 — the ledger becomes the client's VIEW over the server-persisted
 * Recording / Run / LiveSession entities.
 *
 * These shapes MIRROR src/server/storage/types.ts field-for-field. They are
 * re-declared rather than imported because tsconfig.json excludes src/server
 * from the client program.
 * ---------------------------------------------------------------------- */

/** Where a Recording came from (PRD §7). */
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
  deletedAt?: number;
}

export interface Run {
  id: string;
  recordingId: string;
  architecture: Mode;
  providerTriple?: ProviderTriple;
  modelSnapshots: Record<string, string>;
  /** DECLARED tag. Never trusted — the ledger derives its own (see runArmTag). */
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

export interface LiveSessionUtterance {
  id: string;
  timings: Record<string, number | null>;
  costUsd: number;
}

/** PRD §7. `quality.wer` is ALWAYS null in Live — there is no reference text. */
export interface LiveSession {
  id: string;
  startedAt: number;
  endedAt: number;
  durationMs: number;
  architecture: Mode;
  providerTriple?: ProviderTriple;
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

/** One arm's aggregate over gate-passing Runs. `n` is the ACTUAL count. */
export interface RunArmAggregate {
  n: number;
  p50Ms: number | null;
  p95Ms: number | null;
  costUsd: number;
}

export interface RunAggregates {
  perArm: { [arm: string]: RunArmAggregate };
}

/** localStorage-compatible subset used for persistence. */
export interface StorageAdapter {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export const LEDGER_STORAGE_KEY = 'workbench.runLedger.v1';

export interface BlindDrawInput {
  id: string;
  utteranceId: string;
  /** Arm ids in the order presented to the rater. */
  order: string[];
  createdAt: number;
}

export interface BlindScoresInput {
  drawId: string;
  /** Score per presented sample key. */
  scores: { [sample: string]: number };
  revealedAt: number;
}

export interface BlindDraw extends BlindDrawInput {
  scores?: { [sample: string]: number };
  revealedAt?: number;
}

export interface ArmAggregate {
  count: number;
  p50Ms: number | null;
  p95Ms: number | null;
  costUsd: number;
}

export interface LedgerAggregates {
  perArm: { [arm: string]: ArmAggregate };
}

export interface LedgerExport {
  runs: Array<{
    runId: string;
    records: UtteranceRecord[];
    blindDraws: BlindDraw[];
  }>;
  /**
   * The v2 entities. Nested so that `runs` keeps meaning "utterance records
   * grouped by their runId" for existing callers.
   */
  entities: {
    recordings: Recording[];
    runs: Run[];
    liveSessions: LiveSession[];
  };
}

/**
 * The arm a Run belongs to, DERIVED from its configuration. A declared
 * `run.armTag` that disagrees with the configuration loses.
 */
export function runArmTag(_run: Run): ArmTag {
  throw new Error('runArmTag: not implemented');
}

/** The realness rule for a Run — the Run-shaped mirror of `isRealRecord`. */
export function isRealRun(_run: Run): boolean {
  throw new Error('isRealRun: not implemented');
}

/**
 * The aggregation gate (PRD §7, §8, §17 22d): derived armTag is a named arm
 * AND origin === 'sweep' AND status === 'complete' — then the realness rule
 * on top.
 */
export function isAggregatableRun(_run: Run): boolean {
  throw new Error('isAggregatableRun: not implemented');
}

/**
 * True iff the record is "real" per the realness rule (no fixture provider,
 * corpusId not placeholder-prefixed, arm not 'fixture').
 */
export function isRealRecord(record: UtteranceRecord): boolean {
  const { stt, mt, tts } = record.providers;
  if (stt === 'fixture' || mt === 'fixture' || tts === 'fixture') return false;
  if (record.corpusId.startsWith('placeholder')) return false;
  if (record.arm === 'fixture') return false;
  return true;
}

function deepCopy<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

interface LedgerState {
  records: UtteranceRecord[];
  blindDraws: BlindDraw[];
}

export class RunLedger {
  private records: UtteranceRecord[] = [];
  private blindDraws: BlindDraw[] = [];
  private readonly storage?: StorageAdapter;

  constructor(storage?: StorageAdapter) {
    this.storage = storage;
    if (storage) {
      const blob = storage.getItem(LEDGER_STORAGE_KEY);
      if (blob !== null) {
        const state = JSON.parse(blob) as LedgerState;
        this.records = state.records ?? [];
        this.blindDraws = state.blindDraws ?? [];
      }
    }
  }

  private persist(): void {
    if (this.storage) {
      this.storage.setItem(
        LEDGER_STORAGE_KEY,
        JSON.stringify({ records: this.records, blindDraws: this.blindDraws }),
      );
    }
  }

  append(record: UtteranceRecord): void {
    this.records.push(deepCopy(record));
    this.persist();
  }

  /* --- ticket 010: the three v2 entities (stubs) --- */

  appendRecording(_recording: Recording): void {
    throw new Error('appendRecording: not implemented');
  }

  getRecordings(): Recording[] {
    throw new Error('getRecordings: not implemented');
  }

  appendRun(_run: Run): void {
    throw new Error('appendRun: not implemented');
  }

  /** All Runs, or only those of `recordingId` — the per-Recording listing. */
  getRuns(_recordingId?: string): Run[] {
    throw new Error('getRuns: not implemented');
  }

  appendLiveSession(_session: LiveSession): void {
    throw new Error('appendLiveSession: not implemented');
  }

  getLiveSessions(): LiveSession[] {
    throw new Error('getLiveSessions: not implemented');
  }

  /** Experiment aggregates over gate-passing Runs. Never sees LiveSessions. */
  runAggregates(): RunAggregates {
    throw new Error('runAggregates: not implemented');
  }

  getRecords(runId?: string): UtteranceRecord[] {
    const matching =
      runId === undefined ? this.records : this.records.filter((r) => r.runId === runId);
    return deepCopy(matching);
  }

  recordBlindDraw(draw: BlindDrawInput): void {
    this.blindDraws.push(deepCopy(draw));
    this.persist();
  }

  recordBlindScores(input: BlindScoresInput): void {
    const draw = this.blindDraws.find((d) => d.id === input.drawId);
    if (!draw) {
      throw new Error(`Unknown blind draw id: ${input.drawId}`);
    }
    draw.scores = deepCopy(input.scores);
    draw.revealedAt = input.revealedAt;
    this.persist();
  }

  exportRuns(): LedgerExport {
    const runIds: string[] = [];
    for (const r of this.records) {
      if (!runIds.includes(r.runId)) runIds.push(r.runId);
    }
    const utteranceRun = new Map<string, string>();
    for (const r of this.records) utteranceRun.set(r.id, r.runId);

    return {
      runs: runIds.map((runId) => ({
        runId,
        records: deepCopy(this.records.filter((r) => r.runId === runId)),
        blindDraws: deepCopy(
          this.blindDraws.filter((d) => utteranceRun.get(d.utteranceId) === runId),
        ),
      })),
      // TODO(010): carry the three v2 entities.
      entities: { recordings: [], runs: [], liveSessions: [] },
    };
  }

  importRuns(data: LedgerExport): void {
    const records: UtteranceRecord[] = [];
    const blindDraws: BlindDraw[] = [];
    for (const run of data.runs) {
      for (const r of run.records) records.push(deepCopy(r));
      for (const d of run.blindDraws) blindDraws.push(deepCopy(d));
    }
    this.records = records;
    this.blindDraws = blindDraws;
    this.persist();
  }

  aggregates(runId?: string): LedgerAggregates {
    const perArm: { [arm: string]: ArmAggregate } = {};
    const latenciesByArm: { [arm: string]: number[] } = {};

    for (const r of this.records) {
      if (runId !== undefined && r.runId !== runId) continue;
      if (!isRealRecord(r)) continue;
      let agg = perArm[r.arm];
      if (!agg) {
        agg = { count: 0, p50Ms: null, p95Ms: null, costUsd: 0 };
        perArm[r.arm] = agg;
        latenciesByArm[r.arm] = [];
      }
      agg.count += 1;
      agg.costUsd += r.costUnits;
      const timings = r.timings as { speech_end?: number; audio_queued?: number };
      if (typeof timings.speech_end === 'number' && typeof timings.audio_queued === 'number') {
        latenciesByArm[r.arm]!.push(timings.audio_queued - timings.speech_end);
      }
    }

    for (const [arm, latencies] of Object.entries(latenciesByArm)) {
      if (latencies.length === 0) continue;
      const sorted = [...latencies].sort((a, b) => a - b);
      const rank = (p: number) => sorted[Math.ceil(p * sorted.length) - 1]!;
      perArm[arm]!.p50Ms = rank(0.5);
      perArm[arm]!.p95Ms = rank(0.95);
    }

    return { perArm };
  }

  get hasRuns(): boolean {
    return this.records.some(isRealRecord);
  }
}
