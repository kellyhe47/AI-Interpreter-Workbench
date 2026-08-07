/**
 * TICKET 034 — the WER vocabulary: ONE normalizer, ONE distance, ONE score
 * shape.
 *
 * ============================ API DESIGN (normative) =======================
 * WER is scored POST HOC, after a run, against the corpus manifest's
 * `referenceText` (src/core/corpus.ts, ticket 030). The measured atom is the
 * UTTERANCE, so a score is keyed by (runId, utteranceId) and never by Run.
 *
 * This module is compiled by BOTH tsconfigs, so it stays free of node-only and
 * DOM-only globals. It is pure string work: no I/O, no clock (`scoredAt` is
 * passed in), no API call.
 *
 * ---------------------------------------------------------------------------
 * THE NORMALIZER — `normalizeForWer`
 *
 * Normalization materially changes WER, so it is ONE documented function
 * applied IDENTICALLY to reference and hypothesis. Its rules, in order:
 *
 *  1. ñ IS PROTECTED, then stress marks and the diaeresis are STRIPPED.
 *     á é í ó ú ü -> a e i o u. Spanish STT vendors differ in whether they
 *     emit accents at all, and an accent is an ORTHOGRAPHIC convention rather
 *     than a recognition result; scoring it would measure the vendor's style
 *     guide. `ñ` is exempt because it is a SEPARATE LETTER of the Spanish
 *     alphabet, not an accented n — folding it would make `año` and `ano` the
 *     same word, which is a semantic collapse and not a spelling one.
 *  2. CASE FOLDING — lowercase.
 *  3. THOUSANDS SEPARATORS — a `,` BETWEEN TWO DIGITS is deleted, so `1,250`
 *     and `1250` are one token.
 *  4. WORD JOINERS — `-` (and the unicode dashes), `/`, `\` and `_` become a
 *     SPACE, so `twenty-five` is two tokens on both sides.
 *  5. EVERYTHING ELSE that is not a letter, a digit or a space is DELETED —
 *     `.` `,` `?` `!` `;` `:` quotes, brackets, `$`, `%`, and Spanish `¿`/`¡`.
 *     THE ONE EXCEPTION is a `.` BETWEEN TWO DIGITS, kept so `2.5` does not
 *     become `25`.
 *  6. WHITESPACE is collapsed to single spaces and trimmed.
 *
 * NUMBERS — THE RULING. `250` and `two hundred fifty` are DIFFERENT TOKENS and
 * are NOT reconciled. There is no digit<->word conversion in either direction.
 *
 *   Why: any conversion needs a language-specific number lexicon for EN and ES
 *   (and would have to handle ordinals, years, dosages and dates), and that
 *   lexicon is itself a silent source of error inside the very metric it is
 *   supposed to clean up. The reference is a VERBATIM script the operator
 *   controls, so the form in the reference is a deliberate choice, and the rule
 *   is applied identically to both sides — which is the property that makes the
 *   comparison between arms fair.
 *
 *   The consequence, stated rather than hidden: in the `numbers-dates`
 *   category, an STT stage that emits `250` where the script says
 *   `two hundred fifty` scores errors for it. That is not noise — that category
 *   exists precisely to expose digits-vs-words divergence between vendors, and
 *   normalizing it away would delete the finding the category was designed to
 *   produce.
 *
 * ---------------------------------------------------------------------------
 * THE FORMULA — `wordErrorRate`
 *
 *   WER = (S + D + I) / N_reference
 *
 * Levenshtein edit distance over TOKENS (never characters), unit cost for a
 * substitution, a deletion and an insertion alike.
 *
 * - An EMPTY HYPOTHESIS against an N-token reference costs N deletions, so
 *   WER is exactly 1.0.
 * - A HYPOTHESIS LONGER THAN THE REFERENCE can exceed 1.0 and is NEVER
 *   CLAMPED. A one-word reference against a three-word hallucination is
 *   WER 2.0, and clamping it to 1.0 would render a babbling arm and a silent
 *   arm as the same number.
 * - An EMPTY REFERENCE has no denominator. `wordErrorRate` throws rather than
 *   dividing by zero; `scoreUtteranceWer` never reaches it, because a
 *   reference that normalizes to nothing is `not applicable`.
 *
 * ---------------------------------------------------------------------------
 * NOT APPLICABLE IS NOT ZERO — `scoreUtteranceWer`
 *
 * PRD §9: the Cantonese material is IMPROVISED from English prompt cards and
 * has NO WRITTEN SCRIPT, so its manifest entries carry no `referenceText`. A
 * WER of 0 is a PERFECT SCORE, so writing 0 there would report the unscoreable
 * arm as the best one in the study. The score's `wer` is `null` with a named
 * `notApplicableReason` instead, and every reader renders that as
 * `not applicable`.
 *
 * The two reasons are kept apart because they are different facts:
 *   'no-reference-text'  the manifest has no script for this utterance (YUE)
 *   'no-hypothesis'      the run captured no source transcript at all
 * An EMPTY-STRING hypothesis is NOT `no-hypothesis`: the arm produced output
 * and it was nothing, which is a real, total miss and scores 1.0.
 * ==========================================================================
 */

/** Stamped on every score, so a re-normalization is a visible change. */
export const WER_NORMALIZATION_VERSION = 'wer-norm-v1';

/** How a null WER renders. NEVER `0`, and never a blank cell. */
export const WER_NOT_APPLICABLE = 'not applicable';

/** Why a WER could not be computed. Absent when `wer` is a number. */
export type WerNotApplicableReason = 'no-reference-text' | 'no-hypothesis';

/**
 * ONE post-hoc word-error-rate score, keyed by the MEASURED ATOM.
 *
 * `referenceText` / `hypothesisText` are stored VERBATIM (pre-normalization)
 * so a reviewer can recompute the number instead of trusting it.
 */
export interface WerScore {
  /** The Run the hypothesis came from. */
  runId: string;
  /** The manifest `CorpusUtterance.id` the reference came from. */
  utteranceId: string;
  /** (S + D + I) / N_reference, or null for `not applicable`. NEVER 0 for null. */
  wer: number | null;
  /** Present iff `wer` is null. */
  notApplicableReason?: WerNotApplicableReason;
  referenceText: string | null;
  hypothesisText: string | null;
  /** WER_NORMALIZATION_VERSION at the time of scoring. */
  normalizationVersion: string;
  scoredAt: number;
}

/** What `scoreUtteranceWer` needs. Structural, so core imports no layer. */
export interface WerScoringInput {
  runId: string;
  utteranceId: string;
  /** The manifest's verbatim script. Absent for Cantonese (PRD §9). */
  referenceText?: string;
  /** The run's source-language transcript. Absent when none was captured. */
  hypothesisText?: string;
  scoredAt: number;
}

/** The manifest shape scoring reads. Structurally satisfied by CorpusUtterance. */
export interface WerReferenceEntry {
  id: string;
  referenceText?: string;
}

/** The Run shape scoring reads. Structurally satisfied by RunUtterance. */
export interface WerHypothesisEntry {
  utteranceId: string;
  transcripts: { source?: string; target?: string };
}

/** The stable string key of a score. (runId, utteranceId), nothing else. */
export function werScoreKey(runId: string, utteranceId: string): string {
  // The separator is a unit separator rather than a printable character, so no
  // id containing the delimiter can forge another pair's key.
  return `${runId}\u001f${utteranceId}`;
}

/**
 * Private-use placeholders. `ñ` and a decimal point BETWEEN DIGITS both have to
 * survive a pass that would otherwise destroy them, so each is swapped for a
 * character no transcript can contain and swapped back afterwards.
 */
const N_TILDE = '\uE000';
const KEPT_DECIMAL = '\uE001';

/** `-` and the unicode dashes, plus the other joiners, all become a space. */
const WORD_JOINERS = /[-\u2010-\u2015\u2212/\\_]/g;

/** The ONE normalizer. See the module header for the rules and the rulings. */
export function normalizeForWer(text: string): string {
  // Composed first, so a decomposed `ñ` (n + U+0303) is protected by the same
  // rule as a precomposed one.
  let out = text.normalize('NFC').toLowerCase();

  // 1. ñ IS PROTECTED, then every remaining combining mark is stripped — á é í
  //    ó ú ü fold to their base letters. `ñ` is a SEPARATE LETTER, so folding it
  //    would make `año` and `ano` one word: a semantic collapse, not a spelling
  //    one.
  out = out.split('ñ').join(N_TILDE);
  out = out.normalize('NFD').replace(/\p{M}/gu, '').normalize('NFC');
  out = out.split(N_TILDE).join('ñ');

  // 2. THOUSANDS SEPARATORS — a `,` between two digits alone, so `1,250` and
  //    `1250` are one token while a sentence comma is still punctuation.
  out = out.replace(/(\d),(?=\d)/g, '$1');

  // 3. WORD JOINERS become a SPACE, so `twenty-five` is two tokens on both
  //    sides rather than one token on one side and two on the other.
  out = out.replace(WORD_JOINERS, ' ');

  // 4. EVERYTHING ELSE that is not a letter, a digit or WHITESPACE is deleted —
  //    quotes, brackets, `$`, `%`, `¿`, `¡`. The ONE exception is a `.` between
  //    two digits, kept so `2.5` does not become `25`.
  //
  //    WHITESPACE IS SPARED FROM THE CLASS ON PURPOSE. A class written with a
  //    literal space instead of `\s` deletes tabs and newlines as punctuation
  //    and welds `a\t\tb` into `ab`, so any transcript containing a line break
  //    would silently lose a token boundary and report an inflated WER.
  out = out.replace(/(\d)\.(?=\d)/g, `$1${KEPT_DECIMAL}`);
  out = out.replace(/[^\p{L}\p{N}\s]/gu, '');
  out = out.split(KEPT_DECIMAL).join('.');

  // 5. WHITESPACE collapses to single spaces and trims.
  return out.trim().replace(/\s+/g, ' ');
}

/** The normalized token sequence. Empty text is ZERO tokens, never one. */
export function werTokens(text: string): string[] {
  const normalized = normalizeForWer(text);
  // `''.split(' ')` is `['']` — one phantom token, which would give an empty
  // reference a denominator of 1 and turn "no reference" into a real score.
  return normalized.length === 0 ? [] : normalized.split(' ');
}

/** Levenshtein edit distance over TOKENS. Unit cost for S, D and I alike. */
export function tokenEditDistance(
  reference: readonly string[],
  hypothesis: readonly string[],
): number {
  // Two rolling rows rather than the full matrix: the distance is all that is
  // wanted, never the alignment path.
  let previous = Array.from({ length: hypothesis.length + 1 }, (_, j) => j);
  for (let i = 1; i <= reference.length; i += 1) {
    const current = [i];
    for (let j = 1; j <= hypothesis.length; j += 1) {
      const substitution = previous[j - 1]! + (reference[i - 1] === hypothesis[j - 1] ? 0 : 1);
      const deletion = previous[j]! + 1;
      const insertion = current[j - 1]! + 1;
      current[j] = Math.min(substitution, deletion, insertion);
    }
    previous = current;
  }
  return previous[hypothesis.length]!;
}

/**
 * (S + D + I) / N_reference over NORMALIZED tokens. Never clamped: a
 * hypothesis longer than the reference yields more than 1.0, on purpose.
 *
 * Throws on an empty reference — there is no denominator, and returning 0 or 1
 * would both be inventions. `scoreUtteranceWer` guards this case as
 * `not applicable`.
 */
export function wordErrorRate(reference: string, hypothesis: string): number {
  const referenceTokens = werTokens(reference);
  if (referenceTokens.length === 0) {
    throw new Error(
      'wordErrorRate: an empty reference has no denominator — 0 and 1 would both ' +
        'be inventions, so an absent reference is `not applicable` instead',
    );
  }
  // NEVER CLAMPED: a hypothesis longer than the reference exceeds 1.0 on
  // purpose, so a babbling arm and a silent arm do not report the same number.
  return tokenEditDistance(referenceTokens, werTokens(hypothesis)) / referenceTokens.length;
}

/**
 * ONE score for ONE (runId, utteranceId).
 *
 * NOT APPLICABLE IS NOT ZERO: a missing reference (Cantonese, PRD §9) and a
 * missing hypothesis both produce `wer: null` with a named reason, never 0.
 * An EMPTY-STRING hypothesis is a real total miss and scores 1.0.
 */
export function scoreUtteranceWer(input: WerScoringInput): WerScore {
  const { runId, utteranceId, referenceText, hypothesisText, scoredAt } = input;

  const base = {
    runId,
    utteranceId,
    referenceText: referenceText ?? null,
    hypothesisText: hypothesisText ?? null,
    normalizationVersion: WER_NORMALIZATION_VERSION,
    scoredAt,
  };

  // THE ONE PLACE A NULL WER IS PRODUCED, and it is unreachable without a
  // reason: the two `not applicable` branches below are the only `return`s that
  // set `wer: null`, and each sets `notApplicableReason` in the same literal.
  // There is no code path on which a null score can be written bare, and none
  // on which "unscoreable" can become a 0 — the numeric branch is the only one
  // that calls `wordErrorRate` at all.
  if (referenceText === undefined || werTokens(referenceText).length === 0) {
    // Cantonese is improvised from English prompt cards (PRD §9). There is
    // nothing to score against, which is NOT a perfect transcription.
    return { ...base, wer: null, notApplicableReason: 'no-reference-text' };
  }

  if (hypothesisText === undefined) {
    // No transcript was captured at all. An EMPTY-STRING hypothesis is a
    // different fact and falls through to the 1.0 below: the arm produced
    // output and the output was nothing, which is a real, total miss.
    return { ...base, wer: null, notApplicableReason: 'no-hypothesis' };
  }

  return { ...base, wer: wordErrorRate(referenceText, hypothesisText) };
}

/**
 * Every score for one Run, in manifest order.
 *
 * THE HYPOTHESIS IS `transcripts.source`, never `transcripts.target`: the
 * manifest's script is in the SOURCE language, so the source transcript is the
 * only thing it can score. That makes WER a measurement of the STT stage,
 * which is exactly why two arms sharing an STT stage have no WER delta.
 *
 * A Run carrying no per-utterance records produces NO scores: WER attaches to
 * the measured atom, and a record-less Run has none.
 */
export function scoreRunWer(
  run: { id: string; utterances?: readonly WerHypothesisEntry[] },
  manifest: readonly WerReferenceEntry[],
  scoredAt: number,
): WerScore[] {
  const referenceById = new Map(manifest.map((entry) => [entry.id, entry]));
  // A record-less Run produces NOTHING: WER attaches to the measured atom, and
  // a Run that carries no records has none to attach to.
  return (run.utterances ?? []).map((record) =>
    scoreUtteranceWer({
      runId: run.id,
      utteranceId: record.utteranceId,
      // An utterance the manifest does not name has no script, so it is
      // `not applicable` on exactly the terms Cantonese is — never a 0.
      referenceText: referenceById.get(record.utteranceId)?.referenceText,
      // THE SOURCE TRANSCRIPT, never the target: the manifest's script is in the
      // SOURCE language, so it is the only thing the reference can score.
      hypothesisText: record.transcripts.source,
      scoredAt,
    }),
  );
}

/**
 * LAST WRITE WINS ON READ. The stream is append-only, so re-scoring the same
 * (runId, utteranceId) writes a SECOND line and the earlier one survives on
 * disk; every reader collapses the history here, keeping the LAST entry per
 * key. Result order is the FIRST appearance of each key, so a re-score does not
 * reshuffle the table.
 */
export function latestWerScores(scores: readonly WerScore[]): WerScore[] {
  // A Map keeps FIRST-APPEARANCE insertion order while `set` overwrites the
  // value, which is exactly "last write wins, first appearance orders". The
  // input is never touched: the collapse happens on READ and nowhere else.
  const byKey = new Map<string, WerScore>();
  for (const score of scores) {
    byKey.set(werScoreKey(score.runId, score.utteranceId), score);
  }
  return [...byKey.values()];
}
