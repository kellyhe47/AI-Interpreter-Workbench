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
 *   latency = the record's FIRST AUDIO (`tts_first_byte ?? audio_queued`, since
 *   cascade re-stamps audio_queued per chunk and realtime does not) minus its
 *   END-OF-SPEECH ANCHOR: `speech_end` (corpus ground truth — Replay) when
 *   present, otherwise the endpointer's decision (`vad_fired` /
 *   `server_speech_stopped` — Live, which has no ground truth and never will;
 *   ticket 051, anchoredLatencyMs). Records with neither anchor, or no audio at
 *   all, still count toward `count` and `costUsd` but are excluded from
 *   percentiles. An UNSCOPED call whose arm holds BOTH anchors reports no
 *   percentile at all — that pool describes no single quantity (R2-6). Percentiles use nearest-rank:
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
 *
 * Ticket 016 — the pairwise BlindComparison finally gets a home
 * (recordBlindComparison / getBlindComparisons). Additive by construction:
 *
 * - A fourth append-only store, deep-copied in and out like every other one, so
 *   neither the submitter nor a reader can rewrite a judgement after the fact.
 * - It rides the same persisted blob, so a submitted comparison survives a
 *   reload; a pre-016 blob simply has no `blindComparisons` key and restores
 *   as empty.
 * - It is NOT in LedgerExport. That envelope's shape is pinned by the locked
 *   export/import tests, so `exportRuns`/`importRuns` are untouched and
 *   `importRuns` leaves the comparison store alone rather than discarding
 *   judgements the export it was handed never carried.
 *
 * Ticket 032 — THE MEASURED ATOM IS THE UTTERANCE, NOT THE RUN (PRD §8; see
 * .tdd/tickets/README-v3-corpus.md). A corpus Recording is a ≤45 s take holding
 * ~4 utterances of deliberately different categories, so a Run is the CONTAINER
 * that produced a set of records and not itself a measurement. Any aggregate
 * computed per-Run is wrong by construction under a multi-utterance corpus — N
 * comes out 4× too small. The decisions:
 *
 * - `runSamples(run)` expands a Run into its measured atoms: one `RunSample`
 *   per `RunUtterance` when the Run carries records, or exactly ONE Run-level
 *   sample when it carries none. Never both — a Run whose records are counted
 *   ALONGSIDE its own sample reports 75 where 60 is right. Runs with no
 *   `utterances[]` therefore aggregate exactly as they did before 032, and no
 *   figure moves for a ledger with no manifest-backed run.
 * - `isAggregatableUtterance(run, utterance?)` is the gate ONE LEVEL DOWN, and
 *   it is applied to a record THROUGH ITS PARENT RUN: the record inherits the
 *   Run's origin, status and DERIVED arm and can never out-vote them. On top of
 *   that a record must have completed. Called with no record it is exactly
 *   `isAggregatableRun`, which is UNCHANGED — 032 sits beside it rather than
 *   editing it, so the Run-level gate keeps one definition.
 * - A FAILED RECORD INSIDE A COMPLETE RUN is ticket 027's rule one level down:
 *   it does not fail its Run, it is excluded from the figures (no latency, no
 *   cost, not in `n`), and it is still an attempt — the Results layer reports
 *   the gap as `Provenance.attemptedSamples`.
 * - Run-level `timings` / `transcripts` / `cost` KEEP TODAY'S SEMANTICS
 *   verbatim (ticket 031's regression pin). The per-record latency is the same
 *   formula over the record's own stamps — `audio_queued − speech_end`, both
 *   from the SAME level — so the two can never disagree about what latency
 *   means, and a record's split cost sums back to `run.cost` exactly.
 * - `runAggregates()` is where record-awareness LIVES. The Results derivation
 *   layer delegates to it rather than reimplementing the gate, so there is one
 *   aggregate and not two that can drift.
 *
 * Ticket 034 — POST-HOC WER SCORES get a FIFTH append-only store, keyed by the
 * measured atom (runId, utteranceId) and never merged into a Run:
 *
 * - `appendWerScore` / `getWerScores()` mirror every other store here — deep
 *   copies in and out, never mutated, never removed — so a re-score APPENDS and
 *   the earlier score survives, exactly as the server's wer-scores.jsonl does.
 * - `getWerScore(runId, utteranceId)` is the LAST-WRITE-WINS read, delegating to
 *   `latestWerScores` in src/core/wer.ts so the collapse rule has ONE
 *   definition shared with the export.
 * - It is NOT in `LedgerExport`, for exactly the reason ticket 016's
 *   comparisons are not: that envelope's shape is pinned by the locked
 *   export/import tests, and `importRuns` therefore leaves the score store
 *   alone rather than discarding scores the export it was handed never carried.
 * - THE WER TYPE IS IMPORTED FROM src/core/wer.ts, not re-declared: the
 *   normalizer, the formula and the record are one vocabulary. (The
 *   Recording/Run/LiveSession shapes are re-declared only because they live
 *   under src/server, which the client program excludes.)
 */

import { deriveArmTag, type ArmTag, type ProviderTriple } from '../../core/arms';
import type { CorpusCategory, CorpusUtterance } from '../../core/corpus';
import { latestWerScores, werScoreKey } from '../../core/wer';
import type { WerScore } from '../../core/wer';
import type { RunOrigin } from '../../core/protocol';
import {
  CLOCK_INVERSION,
  anchoredLatencyMs,
  isClockInversion,
  isMeasuredLatencyMs,
  latencyAnchorOf,
} from '../../core/timing';
import type { LatencyAnchor, Mode, UtteranceRecord } from '../../core/timing';

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
/** Ticket 034 — re-exported so callers reach it through the ledger barrel. */
export type { WerScore };

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
   * Ticket 030 — mirror of the server's PRD §9 corpus manifest. Per-utterance
   * category and reference; a mic Recording has none. See src/core/corpus.ts.
   */
  utterances?: CorpusUtterance[];
  corpusVersion?: string;
  deletedAt?: number;
}

/**
 * Ticket 028 — the additive annotation envelope a Run carries. Mirrors
 * src/server/storage/types.ts's RunAnnotations field-for-field, for the same
 * reason the Recording/Run shapes are mirrored: neither side may import the
 * other.
 *
 * DATA, NEVER A GATE. `isAggregatableRun` does not read it: the warmup carries
 * repIndex 0 and is excluded by its 'manual' origin exactly as before.
 */
export interface RunAnnotations {
  /** 1-based repetition index within the sweep; 0 is the discarded warmup. */
  repIndex?: number;
  /**
   * Ticket 033 — the corpus version of the Recording this Run replayed, copied
   * by `runOnce` at the moment of the run. Absent for a mic Recording and for
   * every Run written before 033.
   *
   * COPIED, NOT LOOKED UP LATER. The ledger is append-only: a Run written
   * without a corpus version can never be retro-fixed, so a re-cut of the
   * corpus would leave two corpora and no way to say which numbers came from
   * which.
   */
  corpusVersion?: string;
  /**
   * TICKET 055a — the retained rep count the sweep DECLARED (`BatchOptions.reps`,
   * the same number `BatchConfigSummary.intendedReps` reports), stamped on every
   * row by `createRunOnceExecutor` right beside `repIndex`.
   *
   * IT EXISTS BECAUSE A LOST REP LEAVES NOTHING TO DERIVE FROM. `intendedReps`
   * was distinct `repIndex` over the arm's sweep rows, so a rep whose POST went
   * unacknowledged (ticket 048 R4-2) is absent from the DENOMINATOR too and the
   * line reads a clean "2 of 2" — the exact failure AGENTS.md names. No
   * derivation over the surviving rows can recover the 3; the sweep's own PLAN
   * is the only evidence left, and it survives only if the rows CARRY it.
   *
   * COPIED, NOT LOOKED UP LATER — the same decision `corpusVersion` embodies.
   * And a FLOOR, never a ceiling: `buildProvenance` takes the larger of this and
   * the reps the rows prove, so a stale declaration can never delete a rep that
   * demonstrably ran.
   */
  intendedReps?: number;
}

/**
 * Ticket 031 — ONE MEASURED UTTERANCE. A corpus Recording is a ≤45 s take
 * holding ~4 utterances of deliberately different categories (PRD §9), so the
 * measured atom is the utterance and the Run is only the container that
 * produced a set of them.
 *
 * `timings` is anchored PER UTTERANCE: `speech_end` is
 * `t0 + manifest[index - 1].trueSpeechEndMs`, from the corpus manifest and
 * never from VAD, and `audio_queued` is the first output sample attributable
 * to THIS utterance (null when it produced none).
 *
 * Additive and optional: a mic Recording and every Run written before 031 has
 * no key at all, and no aggregate reads it until ticket 032.
 */
export interface RunUtterance {
  /** The manifest's `CorpusUtterance.id`. */
  utteranceId: string;
  /** 1-based, manifest order. Maps to transport `utt` as `index - 1`. */
  index: number;
  category: CorpusCategory;
  timings: Record<string, number | null>;
  transcripts: { source?: string; target?: string };
  /**
   * TICKET 052 — `null` is UNMEASURED, and it is NOT the same fact as `0`.
   * A record nobody could price contributes nothing to an arm's total and is
   * disclosed in the provenance line; a `0` would claim the utterance was free.
   */
  cost: number | null;
  status: 'complete' | 'failed';
  errors: string[];
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
  /**
   * TICKET 062 — the languages the run ACTUALLY ran with, copied from the
   * config the transport was started with rather than declared beside it.
   *
   * Run dbeb6d94 translated English into German and recorded no pair at all, so
   * nothing stored could contradict it: without these fields a wrong-language
   * run and a right-language one are byte-identical in the ledger, and every WER
   * score, latency figure and blind-compare pairing derived from it is a claim
   * about a language nobody can name. Optional — every Run written before this
   * ticket has neither, and an absent field must stay absent rather than become
   * a default nobody can take back out of an append-only ledger.
   */
  languagePair?: string;
  direction?: string;
  timings: Record<string, number | null>;
  transcripts: { source?: string; target?: string };
  outputAudioPath?: string;
  /** TICKET 052 — `null` is UNMEASURED. Never rendered as `$0.00`. */
  cost: number | null;
  errors: string[];
  createdAt: number;
  /**
   * Ticket 028 — measurement metadata about the execution. Absent on every Run
   * written before it; the Results derivations read it through `AnnotatedRun`.
   */
  annotations?: RunAnnotations;
  /**
   * Ticket 031 — the per-utterance records this Run produced, in manifest
   * order. Absent when the Recording carries no manifest, and absent (never
   * partial) when the run's segmentation disagreed with the manifest.
   */
  utterances?: RunUtterance[];
}

export interface LiveSessionUtterance {
  id: string;
  timings: Record<string, number | null>;
  /** TICKET 052 — `null` when the transport reported no usage to price. */
  costUsd: number | null;
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

/**
 * TICKET 055a — WHAT THE REPO KNOWS ABOUT THIS TAKE.
 *
 * There is exactly ONE state, and it is the NEGATIVE one. `'unsynced'` says
 * "this record exists in the browser and the repo did not acknowledge it";
 * ABSENT says nothing has contradicted the record, which is the state every
 * session hydrated from the server's own listing is in and the state a
 * successful POST leaves behind.
 *
 * A `'synced'` value is deliberately NOT modelled. The server is the source of
 * these records, so a session it handed back cannot also carry a client-side
 * claim about itself — `hydrateLiveSessions.test.ts:57` pins the hydrated store
 * field-for-field against the listing, and any stamp the client added would be
 * a field the artifact does not have.
 */
export type LiveSessionSyncState = 'unsynced';

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
  /**
   * TICKET 052 R2 — the price source in force WHEN THIS SESSION WAS WRITTEN.
   *
   * ABSENT MEANS "WRITTEN BEFORE A COST MODEL EXISTED", and the costs on such a
   * session are not measurements. The eight sessions in `data/live-sessions.jsonl`
   * carry `costUsd: 0` on every utterance because the build that wrote them
   * hardcoded `costUnits: 0`; read forward naively they are eight takes
   * asserting the configuration was free. The stamp is what tells a zero that
   * was MEASURED from a zero that is the absence of a measurement — the same
   * job `corpusVersion` does for a Run, and the reason a versioned control is
   * stamped onto the record rather than assumed at read time.
   */
  pricingVersion?: string;
  modelSnapshots: Record<string, string>;
  utterances: LiveSessionUtterance[];
  latency: { p50: number | null; p95: number | null; driftMinute1ToEnd: number | null };
  cost: {
    /** TICKET 052 — `null` when NO utterance in the session could be priced. */
    totalUsd: number | null;
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
  /**
   * TICKET 055a — THE STATE RIDES THE RECORD, so the ONE gate can read it
   * wherever the record came from and the deep copy `getLiveSessions()` returns
   * carries it. A side table would be invisible to the getter, to
   * `exportRuns()` and to `localStorage`.
   *
   * Absent on every session written before this ticket, on every session the
   * server listing hands back, and on a take whose POST was acknowledged.
   */
  syncState?: LiveSessionSyncState;
}

/** One arm's aggregate over gate-passing Runs. `n` is the ACTUAL count. */
export interface RunArmAggregate {
  n: number;
  p50Ms: number | null;
  p95Ms: number | null;
  /**
   * TICKET 052 — the sum of the MEASURED sample costs, or `null` when none of
   * the arm's samples carried one. Never 0-for-absent: an unmeasured sample
   * contributes nothing, and a total of 0 would understate the arm exactly as
   * `$0.00` misstates a run.
   */
  costUsd: number | null;
  /**
   * How many of `n` samples carried a measured cost — the denominator the
   * dollars cannot supply. Summing a missing cost as 0 and skipping it produce
   * the SAME total, so only this number tells an honest aggregate from a
   * dishonest one, and it is what the provenance line discloses.
   */
  measuredCostSamples: number;
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

/* -------------------------------------------------------------------------
 * Ticket 014 — the REPLAY-shaped blind comparison (PRD §10, §17 16b · 25d).
 *
 * The shapes above are Live-era: they blind the ARMS of one utterance and
 * carry a single score per sample. A Replay comparison is a different object
 * — it is between two RUNS of one Recording, it is rated on TWO dimensions,
 * and PRD §10 requires the evaluator's language to be recorded alongside the
 * drawn assignment. `utteranceId` is simply the wrong key for it.
 *
 * These types are ADDITIVE: nothing above changes, so every existing caller
 * and every locked ledger test keeps its meaning.
 * ---------------------------------------------------------------------- */

/** The two presentation slots. `order[0]` was presented as Sample A. */
export type BlindSampleKey = 'A' | 'B';

/** The two dimensions a sample is rated on, 1–5 each (PRD §10). */
export type BlindDimension = 'adequacy' | 'fluency';

/** One sample's rating. Both dimensions, never one. */
export type BlindSampleScores = { [dimension in BlindDimension]: number };

/**
 * One pairwise blind comparison, as it is appended to the ledger.
 *
 * `runIds` is the pair the evaluator chose; `order` is the DRAW — what was
 * actually presented, order[0] as Sample A. Persisting both is what makes the
 * blinding auditable after the fact rather than merely asserted (PRD §17 16b):
 * recomputing the assignment later would prove nothing.
 */
export interface BlindComparison {
  id: string;
  /** Both runs are Runs of THIS Recording — cross-Recording pairs are not comparable. */
  recordingId: string;
  /** The two Runs compared, as picked. */
  runIds: [string, string];
  /** The drawn assignment: order[0] was Sample A, order[1] was Sample B. */
  order: [string, string];
  /** The language the evaluator judged in (PRD §10 — a single native evaluator). */
  evaluatorLanguage: string;
  scores: { [sample in BlindSampleKey]: BlindSampleScores };
  createdAt: number;
  revealedAt: number;
}

export interface ArmAggregate {
  count: number;
  p50Ms: number | null;
  p95Ms: number | null;
  /** TICKET 052 — measured records only; `null` when none of them was priced. */
  costUsd: number | null;
  /** How many of `count` records carried a measured cost. */
  measuredCostRecords: number;
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
 * TICKET 018 — the realness rule for a LiveSession: the third sibling of
 * `isRealRecord` and `isRealRun`, deliberately sitting beside them so the
 * three read as ONE rule with three shapes rather than three that can drift.
 *
 * PRD §8: "No number reported in the write-up may come from a fixture run.
 * Fixture latency is a configured constant." The Run path enforced that; the
 * LiveSession path did not, so a `?fixture=1` soak rendered p50/p95 in the
 * conversation-length card as though they were measurements.
 *
 * A LiveSession carries no `recordingId` and no `corpusId`, so the rule is
 * the two clauses the shape supports: false iff any of
 * providerTriple.stt/mt/tts === 'fixture', OR any modelSnapshots value ===
 * 'fixture'. On every recipe the two shapes DO share, this returns exactly
 * what `isRealRun` returns — the clauses below are that function's, minus the
 * one field a LiveSession does not have.
 *
 * The session is still STORED. Fixture data is dev data, not garbage: the
 * ledger is append-only, so `appendLiveSession` keeps it, `getLiveSessions`
 * lists it and `exportRuns` carries it. It is kept out of the DERIVATIONS, in
 * exactly the way a fixture Run is kept out of `runAggregates()`.
 */
export function isRealLiveSession(session: LiveSession): boolean {
  const triple = session.providerTriple;
  if (triple && (triple.stt === 'fixture' || triple.mt === 'fixture' || triple.tts === 'fixture')) {
    return false;
  }
  if (Object.values(session.modelSnapshots ?? {}).includes('fixture')) return false;
  return true;
}

/**
 * TICKET 041 — the aggregation gate for a LiveSession: the third sibling of
 * `isAggregatableRun` / `isAggregatableUtterance`.
 *
 * A session enters a REPORTED FIGURE only when BOTH hold:
 *   1. it passes `isRealLiveSession` (ticket 018 — fixtures never report), and
 *   2. it produced at least one utterance.
 *
 * Clause 2 is the "a zero reads as a measurement" rule: most of the operator's
 * 12 sessions carry `utterances: []` and `totalUsd: 0` — cascade takes that
 * could never start and Realtime takes stopped before the first turn. Pooling
 * one into a column adds a session to `sessions`, zero to every latency sample
 * and zero dollars to the cost, which reads as "we measured a free session"
 * rather than "nothing happened". It is treated exactly like a failed Run:
 * STORED, listed and exported — never aggregated.
 *
 * The two clauses answer DIFFERENT questions and neither is folded into the
 * other: `isRealLiveSession` still returns true for an empty session, because
 * "not a fixture" is not the same claim as "produced a measurement", and moving
 * clause 2 into it would silently change ticket 018's rule.
 */
export function isAggregatableLiveSession(session: LiveSession): boolean {
  if (!isRealLiveSession(session)) return false;
  // TICKET 055a — A TAKE THE REPO NEVER RECEIVED IS NOT EVIDENCE. The local
  // append at Stop is unconditional and stays that way (ticket 023: the
  // operator's take is not contingent on a reachable server); what changes is
  // that the same store is no longer AGGREGATED FROM when the server never got
  // the record. The audit measured 14 sessions on screen over 8 in `data/`, and
  // PRD §8 wants one ledger under every view: a figure a reviewer cannot
  // reproduce from a clone is not a figure.
  //
  // THE CLAUSE LIVES HERE, IN THE ONE GATE, and reads a FIELD — never a
  // bracket lookup, a cast or a `!`, all three of which this repo has been
  // bitten by. `deriveLiveModel` adds no filter of its own.
  if (session.syncState === 'unsynced') return false;
  return session.utterances.length > 0;
}

/**
 * The aggregation gate (PRD §7, §8, §17 22d): derived armTag is a named arm
 * AND origin === 'sweep' AND status === 'complete' AND the run RECORDED the
 * languages it ran — then the realness rule on top.
 *
 * TICKET 061 — A CONTROLLED VARIABLE THAT IS NOT RECORDED IS NOT CONTROLLED.
 * PRD §7's register pins "language pair + direction — fixed per sweep", and a
 * Run that does not say which direction it ran cannot be reproduced from the
 * ledger, cannot be grouped by the by-category view, and cannot be told apart
 * from a run of the OTHER direction. Runs 7acb0cc9 (Spanish) and dbeb6d94
 * (German) are exactly that: two different experiments, byte-indistinguishable.
 *
 * THIS IS THE ONE PLACE THAT DECIDES AGGREGATION. Rejecting a fieldless Run in
 * `groupByCategory`, `runSamples` or `exportResults` instead would split the
 * rule across five files, each free to disagree; `isAggregatableUtterance`
 * applies it THROUGH the parent Run and needs no clause of its own.
 *
 * `?? ''` COVERS BOTH SHAPES. Absent is the pre-061 Run; `''` is what the
 * runner's own `?? ''` used to store, and it is a VALUE that sails through any
 * `!== undefined` check. Neither names a language.
 *
 * IT IS NOT A LANGUAGE POLICE: it asks whether the run recorded its direction,
 * never which one. A gate that admitted only 'en→es' would quietly delete the
 * Cantonese track, whose asymmetry is the finding.
 */
export function isAggregatableRun(run: Run): boolean {
  if (runArmTag(run) === 'ad-hoc') return false;
  if (run.origin !== 'sweep') return false;
  if (run.status !== 'complete') return false;
  if ((run.languagePair ?? '') === '') return false;
  if ((run.direction ?? '') === '') return false;
  return isRealRun(run);
}

/* -------------------------------------------------------------------------
 * TICKET 032 — THE MEASURED ATOM IS THE UTTERANCE, NOT THE RUN.
 *
 * A Run is the CONTAINER that produced a set of utterance records; it is not
 * itself a measurement. Every aggregate therefore expands each Run into its
 * samples first, and applies the gate to each sample THROUGH ITS PARENT RUN —
 * a record inherits its Run's origin, status and DERIVED arm, and can never
 * out-vote them.
 *
 * `isAggregatableRun` is deliberately UNCHANGED; these sit beside it.
 * ---------------------------------------------------------------------- */

/**
 * One measured atom. `utterance` is absent for a Run that carries no records
 * (a mic run, a pre-031 run, a segmentation-mismatch run) — such a Run yields
 * exactly ONE sample, today's Run-level one, so no figure moves for a ledger
 * with no manifest-backed runs.
 */
export interface RunSample {
  run: Run;
  /** The record this sample came from; absent for a Run-level fallback. */
  utterance?: RunUtterance;
  /** DERIVED from the parent Run. A record never names its own arm. */
  arm: ArmTag;
  utteranceId?: string;
  category?: CorpusCategory;
  /** The record's status, or the Run's when there is no record. */
  status: RunStatus;
  /** audio_queued − speech_end, both from the SAME level. Null when either is absent. */
  latencyMs: number | null;
  /** The record's split of the Run cost, or the whole Run cost. Null = unmeasured. */
  cost: number | null;
}

/**
 * Perceived end-to-end latency out of ONE timings map: audio_queued −
 * speech_end. Both stamps must come from the SAME level — a Run's `speech_end`
 * crossed with a record's `audio_queued` is not a measurement of anything — so
 * this only ever sees one map at a time. Null, never 0, when either is absent:
 * an utterance that produced no output audio has `audio_queued: null`.
 */
function pairedLatencyMs(timings: Record<string, number | null> | undefined): number | null {
  const speechEnd = timings?.speech_end;
  const audioQueued = timings?.audio_queued;
  if (typeof speechEnd !== 'number' || typeof audioQueued !== 'number') return null;
  return audioQueued - speechEnd;
}

/**
 * TICKET 055b — THE WRITE-TIME BACKSTOP, and only a backstop.
 *
 * Run 7acb0cc9 is on disk with every utterance `complete` while two of them
 * report their output audio BEFORE the speech that produced it ended (−1435 and
 * −2364 ms), and a run-level envelope of −13973 ms. The RUNNER no longer
 * produces such a record — that is the fix, and it lives in `replay/runner.ts`
 * — but the ledger also receives records it did not produce: the server's
 * ledger through `hydrateLedger`, an imported bundle, a `localStorage` blob
 * written by an older build. A record that already carries an impossible
 * interval must not read as evidence just because it arrived from disk.
 *
 * SO THE VERDICT RIDES `status`, WHICH `isAggregatableRun` ALREADY REJECTS. No
 * clause is added to the one place that decides aggregation, and the exclusion
 * cannot drift away from it.
 *
 * THE RUN IS STILL STORED, records, transcripts and all (PRD §12): a refused
 * run is real information, and relabelling it while deleting the evidence would
 * hide the very drift the label exists to flag. The reason NAMES the utterances
 * that inverted — a run-level verdict alone loses which ones, which is the
 * signal that the drift is PROGRESSIVE rather than a one-off.
 */
function refuseClockInversion(run: Run): Run {
  const invertedIds = (run.utterances ?? [])
    .filter((u) => isClockInversion(pairedLatencyMs(u.timings)))
    .map((u) => u.utteranceId);
  const envelopeMs = pairedLatencyMs(run.timings);
  const envelopeInverted = isClockInversion(envelopeMs);
  if (invertedIds.length === 0 && !envelopeInverted) return run;

  const named =
    invertedIds.length > 0
      ? `output audio precedes the speech end it is measured from — ${invertedIds.join(', ')}`
      : // The envelope alone: naming no utterance is the honest report when no
        // record carries the fault (a run with no records at all, for one).
        'the run envelope pairs output audio with a LATER speech end';
  const envelopeNote =
    envelopeInverted && invertedIds.length > 0 ? ' (and so does the run envelope)' : '';
  return {
    ...run,
    status: 'failed',
    errors: [...run.errors, `${CLOCK_INVERSION}: ${named}${envelopeNote}`],
  };
}

/**
 * Every measured atom of one Run, in manifest order. Never empty.
 *
 * A Run carrying records expands into exactly those records and the Run-level
 * sample is NOT emitted alongside them — emitting both is the double-count that
 * turns 60 samples into 75. A Run carrying none yields today's single Run-level
 * sample, which is why no figure moves for a ledger with no manifest-backed run.
 */
export function runSamples(run: Run): RunSample[] {
  const arm = runArmTag(run);
  const records = run.utterances;

  if (records === undefined || records.length === 0) {
    return [
      {
        run,
        arm,
        status: run.status,
        latencyMs: pairedLatencyMs(run.timings),
        cost: run.cost,
      },
    ];
  }

  return records.map((utterance) => ({
    run,
    utterance,
    // DERIVED from the parent Run on every record: a record never names its
    // own arm, so a mislabelled container cannot re-home its contents.
    arm,
    utteranceId: utterance.utteranceId,
    category: utterance.category,
    status: utterance.status,
    latencyMs: pairedLatencyMs(utterance.timings),
    // The Run's whole-clip cost, split by the manifest span (ticket 031); the
    // splits sum back to run.cost exactly, so expanding moves no money.
    cost: utterance.cost,
  }));
}

/**
 * The gate, one level down. A record is aggregatable iff its PARENT RUN passes
 * `isAggregatableRun` and the record itself completed. Called with no record it
 * is exactly `isAggregatableRun`.
 *
 * The parent's verdict is checked FIRST and cannot be out-voted: the four
 * exclusion reasons (ad-hoc / manual / failed / fixture) are facts about the
 * measurement conditions the container ran under, and a complete record inside
 * a failed Run is still not evidence. A failed record inside a complete Run is
 * ticket 027's rule one level down — excluded from the figures, still counted
 * in `Provenance.attemptedSamples`.
 */
export function isAggregatableUtterance(run: Run, utterance?: RunUtterance): boolean {
  if (!isAggregatableRun(run)) return false;
  if (utterance !== undefined && utterance.status !== 'complete') return false;
  return true;
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
  /** Ticket 016. Absent in every pre-016 blob; restored as empty. */
  blindComparisons?: BlindComparison[];
  /** Ticket 034. Absent in every pre-034 blob; restored as empty. */
  werScores?: WerScore[];
}

export class RunLedger {
  private records: UtteranceRecord[] = [];
  private blindDraws: BlindDraw[] = [];
  private recordings: Recording[] = [];
  private runs: Run[] = [];
  private liveSessions: LiveSession[] = [];
  private blindComparisons: BlindComparison[] = [];
  private werScores: WerScore[] = [];
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
        this.blindComparisons = state.blindComparisons ?? [];
        // Ticket 034 — a pre-034 blob has no `werScores` key at all; that is
        // "no scores yet", never a corrupt blob.
        this.werScores = state.werScores ?? [];
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
          blindComparisons: this.blindComparisons,
          werScores: this.werScores,
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
    this.runs.push(refuseClockInversion(deepCopy(run)));
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

  /**
   * TICKET 055a — record that the repo did NOT acknowledge this take.
   *
   * The only mutation any store on this ledger has, and it is deliberately not
   * an edit to a measurement: nothing the session MEASURED can be reached from
   * here, only what is known about where the record ended up. The take is never
   * removed — it is the evidence of the divergence — and it stays listed and
   * exported exactly as before; `isAggregatableLiveSession` is what keeps it out
   * of a figure.
   *
   * Unknown ids are a no-op: hydration and a settling POST both run against a
   * store that may have moved on.
   */
  markLiveSessionUnsynced(id: string): void {
    const session = this.liveSessions.find((s) => s.id === id);
    if (!session || session.syncState === 'unsynced') return;
    session.syncState = 'unsynced';
    this.persist();
  }

  /**
   * TICKET 055a — the server named this session, so the mark is SETTLED.
   *
   * The field is DELETED rather than set to a 'synced' value: an acknowledged
   * session must be byte-identical to the one the listing handed over (see
   * `LiveSessionSyncState`), and a stamp the server never wrote would be a
   * claim the artifact does not carry.
   */
  markLiveSessionSynced(id: string): void {
    const session = this.liveSessions.find((s) => s.id === id);
    if (!session || session.syncState === undefined) return;
    delete session.syncState;
    this.persist();
  }

  /**
   * Experiment aggregates over gate-passing SAMPLES. Never sees LiveSessions.
   *
   * TICKET 032 — each Run is expanded into its measured atoms first, so `n` is
   * a sample count and not a Run count: 3 recordings × 4 utterances × 5 reps is
   * 60, not the 15 Runs that produced them. A Run with no records expands into
   * one sample and this loop is byte-for-byte what it was before.
   */
  runAggregates(): RunAggregates {
    const perArm: { [arm: string]: RunArmAggregate } = {};
    const latenciesByArm: { [arm: string]: number[] } = {};

    for (const run of this.runs) {
      for (const sample of runSamples(run)) {
        if (!isAggregatableUtterance(run, sample.utterance)) continue;
        // TICKET 055b — A NON-POSITIVE INTERVAL LEAVES THE NUMERATOR AND THE
        // DENOMINATOR TOGETHER. Dropping it from the percentile pool alone
        // would keep it in `n`, so the figure would read as an average over
        // samples one of which was never a measurement; keeping it in the pool
        // drags the percentile below the benchmark it is compared against.
        // Leaving on this line is what makes the drop VISIBLE — `n` falls, and
        // the run itself is still stored, listed and exported.
        //
        // `null` is untouched: "this utterance produced no output audio" is a
        // sample with a cost and no latency, which is exactly what the pool
        // below already handles.
        if (sample.latencyMs !== null && !isMeasuredLatencyMs(sample.latencyMs)) continue;
        const arm = sample.arm;
        let agg = perArm[arm];
        if (!agg) {
          agg = { n: 0, p50Ms: null, p95Ms: null, costUsd: null, measuredCostSamples: 0 };
          perArm[arm] = agg;
          latenciesByArm[arm] = [];
        }
        agg.n += 1;
        // A failed record contributes no cost, by analogy with a failed Run:
        // it is filtered out above before it reaches this line.
        //
        // TICKET 052 — and an UNMEASURED cost contributes nothing either, which
        // is a different thing from contributing a zero. `costUsd` stays null
        // until the first measured sample, so an arm nobody priced reports
        // `not measured` rather than `$0.00`.
        if (sample.cost !== null) {
          agg.costUsd = (agg.costUsd ?? 0) + sample.cost;
          agg.measuredCostSamples += 1;
        }
        if (sample.latencyMs !== null) latenciesByArm[arm]!.push(sample.latencyMs);
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

  /* --- ticket 016: pairwise blind comparisons (additive) ----------------
   *
   * The ticket-014 BlindComparison type had no persistence at all. These two
   * are strictly ADDITIVE: nothing above changes, so every locked ledger test
   * keeps its meaning.
   *
   * Append-only and deep-copied on both sides, exactly like every other store
   * here: a caller mutating what it handed in — or what it read back — must
   * not be able to rewrite a recorded judgement after the reveal.
   *
   * They ride the SAME persisted blob (so a comparison survives a reload) but
   * they are deliberately NOT part of `LedgerExport`. That envelope's shape is
   * pinned by the locked export/import tests, and widening it would change
   * what `importRuns(exportRuns())` round-trips; `importRuns` therefore leaves
   * the comparison store alone rather than silently discarding judgements that
   * the export it was handed never carried. */

  /** Appends one completed pairwise blind comparison. */
  recordBlindComparison(comparison: BlindComparison): void {
    this.blindComparisons.push(deepCopy(comparison));
    this.persist();
  }

  /** Every persisted pairwise blind comparison, in append order. */
  getBlindComparisons(): BlindComparison[] {
    return deepCopy(this.blindComparisons);
  }

  /* --- ticket 034: post-hoc WER scores (additive, append-only) ----------
   *
   * Keyed by the MEASURED ATOM, (runId, utteranceId). Appending never mutates
   * a Run and never rewrites an earlier score: re-scoring a corpus is a second
   * line, and the first one stays readable. The collapse to one figure is on
   * READ, in `getWerScore`.
   *
   * Like the comparison store this rides the same persisted blob but is
   * deliberately NOT part of `LedgerExport`, whose shape is pinned by the
   * locked export/import tests. */

  /** Appends one post-hoc WER score. Never replaces an earlier one. */
  appendWerScore(score: WerScore): void {
    // Deep-copied on the way in for the same reason every other store here is:
    // a caller mutating what it handed in must not be able to rewrite a
    // recorded measurement after the fact.
    this.werScores.push(deepCopy(score));
    this.persist();
  }

  /** Every persisted score, in append order, INCLUDING superseded ones. */
  getWerScores(): WerScore[] {
    return deepCopy(this.werScores);
  }

  /**
   * The score in force for one measured atom — LAST WRITE WINS.
   *
   * `undefined` means NOT SCORED, which is a different fact from a stored
   * `wer: null` (`not applicable`), and both are different from a 0. A reader
   * that cannot tell the three apart cannot render Cantonese honestly.
   */
  getWerScore(runId: string, utteranceId: string): WerScore | undefined {
    // Delegated to `latestWerScores` so the last-write-wins rule has ONE
    // definition shared with the server-side readers and the export.
    const key = werScoreKey(runId, utteranceId);
    const latest = latestWerScores(this.werScores).find(
      (score) => werScoreKey(score.runId, score.utteranceId) === key,
    );
    return latest === undefined ? undefined : deepCopy(latest);
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
    /** R2-6 — which anchors an arm's samples were taken under. */
    const anchorsByArm: { [arm: string]: Set<LatencyAnchor> } = {};

    for (const r of this.records) {
      if (runId !== undefined && r.runId !== runId) continue;
      if (!isRealRecord(r)) continue;
      let agg = perArm[r.arm];
      if (!agg) {
        agg = { count: 0, p50Ms: null, p95Ms: null, costUsd: null, measuredCostRecords: 0 };
        perArm[r.arm] = agg;
        latenciesByArm[r.arm] = [];
        anchorsByArm[r.arm] = new Set<LatencyAnchor>();
      }
      agg.count += 1;
      // TICKET 052 — measured records only. A record the transport reported no
      // usage for carries `costUnits: null` and contributes NOTHING, not a zero.
      if (r.costUnits !== null) {
        agg.costUsd = (agg.costUsd ?? 0) + r.costUnits;
        agg.measuredCostRecords += 1;
      }
      // TICKET 051 — anchored per record: `speech_end` when the corpus supplied
      // it (REPLAY, unmoved), otherwise the endpointer's decision, which is the
      // only end-of-speech instant a LIVE record can carry. The interval ENDS
      // at the first audio (`tts_first_byte ?? audio_queued`), because cascade's
      // `audio_queued` is the LAST synthesized chunk and realtime's is the
      // first. Records with neither anchor still count toward `count` and
      // `costUsd`.
      const marks = r.timings as Record<string, number | undefined>;
      const latency = anchoredLatencyMs(marks);
      if (latency !== null) {
        latenciesByArm[r.arm]!.push(latency);
        anchorsByArm[r.arm]!.add(latencyAnchorOf(marks)!);
      }
    }

    for (const [arm, latencies] of Object.entries(latenciesByArm)) {
      if (latencies.length === 0) continue;
      // R2-6 — REFUSE TO MIX. An unscoped pool can hold corpus-anchored and
      // endpointer-anchored samples at once, and a percentile over both
      // describes neither quantity. Scoping to a runId is never such a pool —
      // one run has one anchor — so every in-app caller is unaffected.
      if (runId === undefined && anchorsByArm[arm]!.size > 1) continue;
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
