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
 *
 * Ticket 010 — the ledger is ALSO the client's view over the server-persisted
 * Recording / Run / LiveSession entities. Additional decisions (locked by the
 * same test file):
 *
 * - The three entity stores are append-only and independent of the utterance
 *   records: appendRecording/appendRun/appendLiveSession never mutate or remove,
 *   and getRecordings()/getRuns(recordingId?)/getLiveSessions() return deep
 *   copies in append order. getRuns(recordingId) is the per-Recording listing.
 * - MEMBERSHIP IS DERIVED, NEVER DECLARED (PRD §6, decision 22d). runArmTag()
 *   feeds the Run's recipe fields to deriveArmTag from core/arms — the single
 *   place membership is computed — bridging Run -> RunConfig as
 *   {architecture, realtimeModel: modelSnapshots.realtime, providers:
 *   providerTriple}. A Run carrying a declared `armTag` that disagrees with its
 *   configuration aggregates under the DERIVED tag; the declared one is ignored
 *   entirely, so mislabelling cannot move a number.
 * - THE AGGREGATION GATE (PRD §7, §8, §17 22d). A Run contributes to
 *   runAggregates() iff ALL of: (1) its DERIVED armTag is a named arm
 *   ('A' | 'B' | 'C' — never 'ad-hoc'), (2) origin === 'sweep', (3) status ===
 *   'complete', and (4) it passes the realness rule. `origin` matters because a
 *   sweep run had counterbalancing and warmup discard applied and a manual run
 *   with an identical triple did not: same configuration, different measurement
 *   conditions. A failed run is real information — it stays visible in the
 *   per-Recording listing — it is simply not a latency sample. Excluded Runs of
 *   every kind are stored, listed and exported; they are only kept out of the
 *   aggregate.
 * - REALNESS RULE FOR RUNS (isRealRun), the Run-shaped mirror of isRealRecord:
 *   false iff any of providerTriple.stt/mt/tts === 'fixture', OR any
 *   modelSnapshots value === 'fixture', OR recordingId starts with
 *   'placeholder'. No fixture-sourced number is ever reported (PRD §8).
 * - runAggregates() → { perArm } keyed by the DERIVED tag, named arms only.
 *   `n` is the ACTUAL count of gate-passing Runs (a 5-rep sweep with one
 *   failure reports 4). Run latency sample = timings.audio_queued −
 *   timings.speech_end; a Run missing either timestamp still counts toward `n`
 *   and `costUsd` but is excluded from the percentiles. Same nearest-rank
 *   formula as aggregates(); no samples → p50Ms/p95Ms null, never 0.
 *   costUsd = sum of run.cost.
 * - LiveSessions are stored in their own list and are NEVER pooled with Runs in
 *   any aggregate — a Live session is a soak measurement, not a latency sample
 *   over a fixed Recording, so mixing them would compare different things.
 * - LedgerExport gains a NESTED `entities` key ({recordings, runs,
 *   liveSessions}); the existing top-level `runs` key keeps meaning "utterance
 *   records grouped by runId" for existing callers. importRuns replaces the
 *   entity stores too, and the whole set persists through the storage adapter.
 * - The entity types are RE-DECLARED here, mirroring src/server/storage/types.ts
 *   field-for-field, because tsconfig.json excludes src/server from the client
 *   program.
 */

import { deriveArmTag, type ArmTag, type ProviderTriple } from '../../core/arms';
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

/**
 * The conversation-context policy a LiveSession ran under (PRD §7 tier-2
 * control · §17 21a/21e). Realtime-only: 'default' replays the whole
 * conversation each turn, 'trimmed' deletes history after each response.
 *
 * TICKET 012 — 'n/a' is NOT a null-object. Cascade is context-free BY
 * DESIGN, so the knob does not exist for it; recording 'default' would
 * imply one and would pool cascade sessions into the `realtime-default`
 * column of PRD §8's conversation-length card. 'n/a' says "this session had
 * no policy", which is a different claim from "this session ran the default
 * policy", and only one of them is true.
 */
export type LiveContextPolicy = 'default' | 'trimmed' | 'n/a';

/** PRD §7. `quality.wer` is ALWAYS null in Live — there is no reference text. */
export interface LiveSession {
  id: string;
  startedAt: number;
  endedAt: number;
  durationMs: number;
  architecture: Mode;
  providerTriple?: ProviderTriple;
  /**
   * TICKET 012 (additive): the policy IN FORCE AT STOP. PRD §8's
   * conversation-length card renders realtime-default / realtime-trimmed /
   * cascade from LiveSessions, and without this field the trimmed column is
   * structurally unfillable. Optional so pre-012 sessions still parse.
   */
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
export function runArmTag(run: Run): ArmTag {
  return deriveArmTag({
    architecture: run.architecture,
    // The `realtime` snapshot key is what pins a realtime run's model.
    realtimeModel: run.modelSnapshots?.realtime,
    providers: run.providerTriple,
  });
}

/** The realness rule for a Run — the Run-shaped mirror of `isRealRecord`. */
export function isRealRun(run: Run): boolean {
  const triple = run.providerTriple;
  if (triple && (triple.stt === 'fixture' || triple.mt === 'fixture' || triple.tts === 'fixture')) {
    return false;
  }
  if (Object.values(run.modelSnapshots ?? {}).includes('fixture')) return false;
  if (run.recordingId.startsWith('placeholder')) return false;
  return true;
}

/**
 * The aggregation gate (PRD §7, §8, §17 22d): derived armTag is a named arm
 * AND origin === 'sweep' AND status === 'complete' — then the realness rule
 * on top.
 */
export function isAggregatableRun(run: Run): boolean {
  if (runArmTag(run) === 'ad-hoc') return false;
  if (run.origin !== 'sweep') return false;
  if (run.status !== 'complete') return false;
  return isRealRun(run);
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

/** Nearest-rank percentile: sorted[ceil(p * n) − 1]. Caller guarantees n > 0. */
function nearestRank(sorted: number[], p: number): number {
  return sorted[Math.ceil(p * sorted.length) - 1]!;
}

interface LedgerState {
  records: UtteranceRecord[];
  blindDraws: BlindDraw[];
  recordings?: Recording[];
  runs?: Run[];
  liveSessions?: LiveSession[];
}

export class RunLedger {
  private records: UtteranceRecord[] = [];
  private blindDraws: BlindDraw[] = [];
  private recordings: Recording[] = [];
  private runs: Run[] = [];
  private liveSessions: LiveSession[] = [];
  private readonly storage?: StorageAdapter;

  constructor(storage?: StorageAdapter) {
    this.storage = storage;
    if (storage) {
      const blob = storage.getItem(LEDGER_STORAGE_KEY);
      if (blob !== null) {
        const state = JSON.parse(blob) as LedgerState;
        this.records = state.records ?? [];
        this.blindDraws = state.blindDraws ?? [];
        this.recordings = state.recordings ?? [];
        this.runs = state.runs ?? [];
        this.liveSessions = state.liveSessions ?? [];
      }
    }
  }

  private persist(): void {
    if (this.storage) {
      this.storage.setItem(
        LEDGER_STORAGE_KEY,
        JSON.stringify({
          records: this.records,
          blindDraws: this.blindDraws,
          recordings: this.recordings,
          runs: this.runs,
          liveSessions: this.liveSessions,
        }),
      );
    }
  }

  append(record: UtteranceRecord): void {
    this.records.push(deepCopy(record));
    this.persist();
  }

  /* --- ticket 010: the three v2 entities --- */

  appendRecording(recording: Recording): void {
    this.recordings.push(deepCopy(recording));
    this.persist();
  }

  getRecordings(): Recording[] {
    return deepCopy(this.recordings);
  }

  appendRun(run: Run): void {
    this.runs.push(deepCopy(run));
    this.persist();
  }

  /** All Runs, or only those of `recordingId` — the per-Recording listing. */
  getRuns(recordingId?: string): Run[] {
    const matching =
      recordingId === undefined ? this.runs : this.runs.filter((r) => r.recordingId === recordingId);
    return deepCopy(matching);
  }

  appendLiveSession(session: LiveSession): void {
    this.liveSessions.push(deepCopy(session));
    this.persist();
  }

  getLiveSessions(): LiveSession[] {
    return deepCopy(this.liveSessions);
  }

  /** Experiment aggregates over gate-passing Runs. Never sees LiveSessions. */
  runAggregates(): RunAggregates {
    const perArm: { [arm: string]: RunArmAggregate } = {};
    const latenciesByArm: { [arm: string]: number[] } = {};

    for (const run of this.runs) {
      if (!isAggregatableRun(run)) continue;
      const arm = runArmTag(run);
      let agg = perArm[arm];
      if (!agg) {
        agg = { n: 0, p50Ms: null, p95Ms: null, costUsd: 0 };
        perArm[arm] = agg;
        latenciesByArm[arm] = [];
      }
      agg.n += 1;
      agg.costUsd += run.cost;
      const { speech_end: speechEnd, audio_queued: audioQueued } = run.timings;
      if (typeof speechEnd === 'number' && typeof audioQueued === 'number') {
        latenciesByArm[arm]!.push(audioQueued - speechEnd);
      }
    }

    for (const [arm, latencies] of Object.entries(latenciesByArm)) {
      if (latencies.length === 0) continue;
      const sorted = [...latencies].sort((a, b) => a - b);
      perArm[arm]!.p50Ms = nearestRank(sorted, 0.5);
      perArm[arm]!.p95Ms = nearestRank(sorted, 0.95);
    }

    return { perArm };
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
      entities: {
        recordings: deepCopy(this.recordings),
        runs: deepCopy(this.runs),
        liveSessions: deepCopy(this.liveSessions),
      },
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
    // Entities REPLACE the current stores too. A pre-010 blob has no
    // `entities` key; treat that as "no entities" rather than throwing.
    const entities = data.entities;
    this.recordings = deepCopy(entities?.recordings ?? []);
    this.runs = deepCopy(entities?.runs ?? []);
    this.liveSessions = deepCopy(entities?.liveSessions ?? []);
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
      perArm[arm]!.p50Ms = nearestRank(sorted, 0.5);
      perArm[arm]!.p95Ms = nearestRank(sorted, 0.95);
    }

    return { perArm };
  }

  get hasRuns(): boolean {
    return this.records.some(isRealRecord);
  }
}
