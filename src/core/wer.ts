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
  // TICKET 034 stub — the implementation is the implementer's.
  throw new Error('ticket 034: not implemented');
}

/** The ONE normalizer. See the module header for the rules and the rulings. */
export function normalizeForWer(text: string): string {
  // TICKET 034 stub — the implementation is the implementer's.
  throw new Error('ticket 034: not implemented');
}

/** The normalized token sequence. Empty text is ZERO tokens, never one. */
export function werTokens(text: string): string[] {
  // TICKET 034 stub — the implementation is the implementer's.
  throw new Error('ticket 034: not implemented');
}

/** Levenshtein edit distance over TOKENS. Unit cost for S, D and I alike. */
export function tokenEditDistance(
  reference: readonly string[],
  hypothesis: readonly string[],
): number {
  // TICKET 034 stub — the implementation is the implementer's.
  throw new Error('ticket 034: not implemented');
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
  // TICKET 034 stub — the implementation is the implementer's.
  throw new Error('ticket 034: not implemented');
}

/**
 * ONE score for ONE (runId, utteranceId).
 *
 * NOT APPLICABLE IS NOT ZERO: a missing reference (Cantonese, PRD §9) and a
 * missing hypothesis both produce `wer: null` with a named reason, never 0.
 * An EMPTY-STRING hypothesis is a real total miss and scores 1.0.
 */
export function scoreUtteranceWer(input: WerScoringInput): WerScore {
  // TICKET 034 stub — the implementation is the implementer's.
  throw new Error('ticket 034: not implemented');
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
  // TICKET 034 stub — the implementation is the implementer's.
  throw new Error('ticket 034: not implemented');
}

/**
 * LAST WRITE WINS ON READ. The stream is append-only, so re-scoring the same
 * (runId, utteranceId) writes a SECOND line and the earlier one survives on
 * disk; every reader collapses the history here, keeping the LAST entry per
 * key. Result order is the FIRST appearance of each key, so a re-score does not
 * reshuffle the table.
 */
export function latestWerScores(scores: readonly WerScore[]): WerScore[] {
  // TICKET 034 stub — the implementation is the implementer's.
  throw new Error('ticket 034: not implemented');
}
