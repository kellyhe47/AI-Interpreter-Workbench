/**
 * TICKET 042 — the post-hoc WER scoring pass.
 *
 * The testable half of `npm run score-wer`; `scripts/score-wer.mjs` is a thin
 * CLI shell over it, the same split `exportResults` uses (scripts/ is outside
 * the vitest glob, so no logic may live there).
 *
 * WHY A SCRIPT AND NOT A UI CONTROL. WER is POST HOC by construction, so the
 * pass has to be re-runnable over a whole corpus after the fact — including
 * over runs recorded before the scorer existed. A script needs no UI decisions
 * and it composes with `export-results`, which is the other thing an operator
 * runs over a finished corpus.
 *
 * WHAT THE PASS IS. A JOIN OVER ALREADY-PERSISTED DATA, never a new
 * measurement: each Run's `RunUtterance.transcripts.source` is joined to its
 * Recording's manifest `referenceText` by `utteranceId`, `scoreRunWer`
 * (src/core/wer.ts, the ONE place a WER is decided) produces the scores, and
 * they are APPENDED to wer-scores.jsonl. No audio is replayed, no provider is
 * called, and no Run is touched.
 *
 * THE FIVE RULES THIS MODULE IS BUILT AROUND
 *
 * 1. THE GATE IS THE LEDGER'S, AND IT IS APPLIED BEFORE SCORING, NOT AFTER.
 *    A fixture-sourced, ad-hoc, manual or failed run is not evidence, so no
 *    line is written for it at all — the alternative, scoring everything and
 *    filtering on read, leaves the store full of numbers no figure may cite.
 *    The predicate is `exportResults`' own `isGatePassingRun`, imported rather
 *    than restated so the two cannot drift.
 *
 * 2. MANIFEST ABSENT IS NOT REFERENCE ABSENT, and the split is the whole
 *    reason this module has two skip reasons instead of one:
 *      - a Recording with NO `utterances` manifest (a mic take), or a Run
 *        naming a Recording the store does not hold, is SKIPPED. There is
 *        nothing to join to, so the pass has no basis for a judgement of any
 *        kind, and writing `wer: null` there would read as "we tried and could
 *        not" for every microphone run in the store.
 *      - a manifest whose entries exist and carry NO `referenceText` (PRD §9's
 *        Cantonese, improvised from English prompt cards) is SCORED, as
 *        `wer: null` / `no-reference-text`. The absence is RECORDED, which is
 *        what keeps it distinguishable from "nobody has scored this yet".
 *
 * 3. NOT APPLICABLE IS NOT ZERO. This module never produces a WER value of its
 *    own: `scoreUtteranceWer` owns the one code path on which a null score is
 *    written, and it is unreachable without a named reason. `notApplicable`
 *    below counts those atoms by name so the CLI can say so out loud.
 *
 * 4. RE-RUNNING IS SAFE. The stream is append-only, so a second pass writes a
 *    SECOND line per atom and the superseded lines survive on disk. Nothing
 *    double-counts, because last-write-wins is applied ON READ, in
 *    `latestWerScores` — the one place that rule lives. This module therefore
 *    performs no de-duplication and reads no prior score: doing either here
 *    would put a second, divergent copy of that rule in the write path.
 *
 * 5. SCORING IS A JUDGEMENT ABOUT A RUN, NOT A CHANGE TO ONE. No Run is
 *    mutated, no `wer` field is grafted onto a record, and `ledger.jsonl` is
 *    never written — a score in the ledger would be read back as a Run
 *    (`readLedger()` is typed `Run[]`) and counted in `totals.runs`. The only
 *    write this module makes is `store.appendWerScore`.
 *
 * FAILURE LEAVES THE SOURCE RE-RUNNABLE. Reads and appends only: a pass that
 * throws has removed nothing and rewritten nothing, so running it again is
 * always safe.
 */
import { scoreRunWer } from '../core/wer';
import type { WerScore } from '../core/wer';
import { createStorage } from '../server/storage/index';
import type { Recording, Run } from '../server/storage/index';
import { isGatePassingRun } from './exportResults';

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

function reason(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * The corpus manifest to join against, or `undefined` when there is none.
 *
 * An EMPTY array is treated exactly as an absent key: a Recording that names no
 * utterances offers nothing to join to, and calling that "the reference is
 * missing" would be a judgement the store has no grounds for. See rule 2.
 */
function manifestOf(recording: Recording | undefined) {
  const manifest = recording?.utterances;
  return manifest === undefined || manifest.length === 0 ? undefined : manifest;
}

export async function scoreWer(opts: ScoreWerOptions): Promise<ScoreWerOutcome> {
  const { dataDir } = opts;
  const clock = opts.now ?? Date.now;

  // READ ONLY, through the store — this module never parses data/ by hand.
  const store = createStorage(dataDir);
  let ledger: Run[];
  let stored: Run[];
  try {
    [ledger, stored] = await Promise.all([store.readLedger(), store.listRuns()]);
  } catch (err) {
    throw new Error(`score-wer: could not read the data store at ${dataDir} — ${reason(err)}`, {
      cause: err,
    });
  }

  // The same record set `exportResults` builds: the ledger is the append-only
  // source of truth, and the per-run JSON files catch anything a torn final
  // ledger line cost us. Scoring a run the export would not carry, or missing
  // one it would, is how the two views of the corpus start to disagree.
  const byId = new Map<string, Run>();
  for (const run of stored) byId.set(run.id, run);
  for (const run of ledger) byId.set(run.id, run);
  const runs = [...byId.values()].sort(
    (a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0) || a.id.localeCompare(b.id),
  );

  // Recordings are looked up ONCE per id: a sweep points many runs at one
  // Recording, and re-reading it per run would read the same file five times.
  const recordings = new Map<string, Recording | undefined>();
  const recordingFor = async (id: string): Promise<Recording | undefined> => {
    if (!recordings.has(id)) recordings.set(id, await store.getRecording(id));
    return recordings.get(id);
  };

  const skipped: ScoreWerSkipped = { gate: 0, noRecords: 0, noManifest: 0 };
  let runsScored = 0;
  let scoresWritten = 0;
  let scored = 0;
  let notApplicable = 0;

  for (const run of runs) {
    // RULE 1 — the gate comes FIRST, so a run that is not evidence produces no
    // line at all rather than a line something has to remember to ignore.
    if (!isGatePassingRun(run)) {
      skipped.gate += 1;
      continue;
    }
    if ((run.utterances ?? []).length === 0) {
      // WER is keyed by (runId, utteranceId) and this Run has no atom to key by.
      skipped.noRecords += 1;
      continue;
    }
    const manifest = manifestOf(await recordingFor(run.recordingId));
    if (manifest === undefined) {
      // RULE 2 — NOTHING TO JOIN TO. Distinct from a manifest that deliberately
      // carries no script, which is scored `not applicable` below.
      skipped.noManifest += 1;
      continue;
    }

    // THE JOIN. `scoreRunWer` owns the pairing and the decision; this module
    // supplies the two already-persisted sides and the clock.
    let werScores: WerScore[];
    try {
      werScores = scoreRunWer(run, manifest, clock());
    } catch (err) {
      throw new Error(`score-wer: could not score run ${run.id} — ${reason(err)}`, { cause: err });
    }
    if (werScores.length === 0) continue;

    for (const score of werScores) {
      try {
        await store.appendWerScore(score);
      } catch (err) {
        throw new Error(
          `score-wer: could not append a score for run ${run.id} to the store at ${dataDir} — ` +
            `${reason(err)}. The stream is append-only, so nothing was rewritten and the pass ` +
            'can be re-run.',
          { cause: err },
        );
      }
      scoresWritten += 1;
      // NOT APPLICABLE IS NOT ZERO: a null score is counted by name here and
      // reaches no total that a mean is taken over.
      if (score.wer === null) notApplicable += 1;
      else scored += 1;
    }
    runsScored += 1;
  }

  const skips = skipped.gate + skipped.noRecords + skipped.noManifest;
  const message =
    scoresWritten === 0
      ? `score-wer: wrote 0 score(s) — examined ${runs.length} run(s), skipped ${skips} ` +
        `(${skipped.gate} gate, ${skipped.noRecords} no records, ${skipped.noManifest} no manifest) ` +
        `— in ${dataDir}`
      : `score-wer: wrote ${scoresWritten} score(s) over ${runsScored} of ${runs.length} run(s) — ` +
        `${scored} scored, ${notApplicable} not applicable, ${skips} run(s) skipped ` +
        `(${skipped.gate} gate, ${skipped.noRecords} no records, ${skipped.noManifest} no manifest) ` +
        `— in ${dataDir}`;

  return {
    runsExamined: runs.length,
    runsScored,
    scoresWritten,
    scored,
    notApplicable,
    skipped,
    message,
  };
}
