/**
 * TICKET 042 — the post-hoc WER scoring pass (STUB — tests are red).
 *
 * The testable half of `npm run score-wer`; `scripts/score-wer.mjs` is a thin
 * CLI shell over it, the same split `exportResults` uses (scripts/ is outside
 * the vitest glob, so no logic may live there).
 *
 * A JOIN OVER ALREADY-PERSISTED DATA, never a new measurement: each Run's
 * `RunUtterance.transcripts.source` is joined to its Recording's manifest
 * `referenceText` by `utteranceId`, `scoreRunWer` decides the number, and the
 * results are APPENDED to wer-scores.jsonl. See src/harness/scoreWer.test.ts
 * for the contract.
 */

export interface ScoreWerOptions {
  /** The working store — normally `data/`. Read, and appended to; never rewritten. */
  dataDir: string;
  /** Injected clock, epoch ms. Stamped as each score's `scoredAt`. */
  now?: () => number;
}

/** Why a Run produced no score. Each count is a Run, never a record. */
export interface ScoreWerSkipped {
  /** Fixture-sourced, ad-hoc, manual or failed — not evidence. */
  gate: number;
  /** No `utterances[]`: WER is keyed by the atom, and there is none. */
  noRecords: number;
  /** Its Recording is absent, or carries no corpus manifest to join to. */
  noManifest: number;
}

export interface ScoreWerOutcome {
  /** Runs in the store the pass looked at. */
  runsExamined: number;
  /** Runs that produced at least one score. */
  runsScored: number;
  /** Score lines appended by THIS pass. */
  scoresWritten: number;
  /** Of those, the ones carrying a NUMBER. */
  scored: number;
  /** Of those, the ones carrying `wer: null`. Never 0, never a skip. */
  notApplicable: number;
  skipped: ScoreWerSkipped;
  /** Human-readable one-liner the CLI shell prints. */
  message: string;
}

export async function scoreWer(_opts: ScoreWerOptions): Promise<ScoreWerOutcome> {
  throw new Error('scoreWer: not implemented (ticket 042)');
}
