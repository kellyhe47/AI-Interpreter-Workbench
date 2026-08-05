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

import type { UtteranceRecord } from '../../core/timing';

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
}

/**
 * True iff the record is "real" per the realness rule (no fixture provider,
 * corpusId not placeholder-prefixed, arm not 'fixture').
 */
export function isRealRecord(record: UtteranceRecord): boolean {
  void record;
  throw new Error('not implemented');
}

export class RunLedger {
  constructor(storage?: StorageAdapter) {
    void storage;
    throw new Error('not implemented');
  }

  append(record: UtteranceRecord): void {
    void record;
    throw new Error('not implemented');
  }

  getRecords(runId?: string): UtteranceRecord[] {
    void runId;
    throw new Error('not implemented');
  }

  recordBlindDraw(draw: BlindDrawInput): void {
    void draw;
    throw new Error('not implemented');
  }

  recordBlindScores(input: BlindScoresInput): void {
    void input;
    throw new Error('not implemented');
  }

  exportRuns(): LedgerExport {
    throw new Error('not implemented');
  }

  importRuns(data: LedgerExport): void {
    void data;
    throw new Error('not implemented');
  }

  aggregates(runId?: string): LedgerAggregates {
    void runId;
    throw new Error('not implemented');
  }

  get hasRuns(): boolean {
    throw new Error('not implemented');
  }
}
