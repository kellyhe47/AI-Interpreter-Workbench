/**
 * Ticket 030 — the corpus utterance manifest.
 *
 * ============================ API DESIGN (normative) =======================
 * PRD §9 decouples Recordings from utterances: a corpus Recording is a ≤45 s
 * take holding ~4 utterances, and "categories are distributed across the
 * recordings, not grouped". A Recording therefore carries a MANIFEST of
 * utterances, never a single category — the tag is per utterance, and the tag
 * is the meaningful analytical grouping (§8).
 *
 * CorpusUtterance
 *   id               stable within the corpus; this is annotations.utteranceId
 *   index            1-based position WITHIN the Recording. At replay it maps
 *                    to the completion ORDER of utterance.complete events.
 *   category         one of CORPUS_CATEGORIES
 *   trueSpeechEndMs  TRUE speech end, ms from the START OF THE CLIP, computed
 *                    ONCE from the waveform and frozen here. PRD §8: t0 is
 *                    "corpus-derived true speech end", never a VAD guess that
 *                    differs per arm. Every Run of this Recording shares it.
 *   referenceText    verbatim script. Present for EN/ES (WER computed).
 *                    ABSENT for YUE, which is improvised from English prompt
 *                    cards and has no written script (§9) — so WER is not
 *                    applicable there, which is NOT the same as a WER of 0.
 *
 * validateManifest(utterances, durationMs) -> string | null
 *   Returns a NAMED reason, or null when valid. A malformed manifest silently
 *   corrupts every number derived from it later, so this is a hard gate at the
 *   API boundary rather than a warning.
 *
 * This module is compiled by BOTH tsconfigs, so it stays free of node-only and
 * DOM-only globals.
 * ==========================================================================
 */

/** The six PRD §9 categories — chosen because the architectures diverge here. */
export const CORPUS_CATEGORIES = [
  'short-reply',
  'long-compound',
  'numbers-dates',
  'proper-nouns',
  'disfluency',
  'interruption',
] as const;

export type CorpusCategory = (typeof CORPUS_CATEGORIES)[number];

/**
 * TICKET 036 — the provenance stamp the app writes onto every corpus Recording
 * it records. It names the corpus a clip BELONGS to, so a later re-cut of the
 * material is a new version rather than a silent edit of the one past numbers
 * were measured against. It is a constant here and injected into the view
 * through the host deps bag: provenance is the host's fact, not the form's.
 */
export const CORPUS_VERSION = 'corpus-v1';

export interface CorpusUtterance {
  id: string;
  index: number;
  category: CorpusCategory;
  trueSpeechEndMs: number;
  referenceText?: string;
}

/** Frozen so a caller cannot mutate the category list out from under a check. */
export const CATEGORY_SET: ReadonlySet<string> = new Set(CORPUS_CATEGORIES);

export function isCorpusCategory(value: unknown): value is CorpusCategory {
  return typeof value === 'string' && CATEGORY_SET.has(value);
}

/**
 * Validates a manifest against its Recording's duration.
 *
 * Returns null when valid, otherwise a named reason suitable for a 400 body.
 * Every rule here exists because breaking it produces a plausible wrong number
 * rather than an obvious failure:
 *
 * - indices 1..N contiguous  -> the index IS the replay completion order
 * - trueSpeechEndMs strictly increasing and within the clip
 *                            -> a non-monotonic boundary means utterance k's
 *                               anchor sits inside utterance k-1
 * - unique ids               -> WER and category rows key on the id
 * - known category           -> an unknown tag silently drops a row from the
 *                               by-category grouping
 */
export function validateManifest(
  utterances: readonly CorpusUtterance[],
  durationMs: number,
): string | null {
  if (utterances.length === 0) return 'utterances must not be empty';

  const seenIds = new Set<string>();
  const seenIndices = new Set<number>();
  let previousSpeechEnd = 0;

  for (const utterance of utterances) {
    const { id, index, category, trueSpeechEndMs, referenceText } = utterance;

    if (typeof id !== 'string' || id.length === 0) {
      return 'each utterance needs a non-empty id';
    }
    if (seenIds.has(id)) return `duplicate utterance id '${id}'`;
    seenIds.add(id);

    if (!Number.isInteger(index) || index < 1) {
      return `utterance '${id}' has a non-positive index`;
    }
    if (seenIndices.has(index)) return `duplicate utterance index ${index}`;
    seenIndices.add(index);

    if (!isCorpusCategory(category)) {
      return `utterance '${id}' has an unknown category`;
    }

    if (typeof trueSpeechEndMs !== 'number' || !Number.isFinite(trueSpeechEndMs)) {
      return `utterance '${id}' has a non-numeric trueSpeechEndMs`;
    }
    if (trueSpeechEndMs <= 0) {
      return `utterance '${id}' has a trueSpeechEndMs at or before the clip start`;
    }
    if (trueSpeechEndMs > durationMs) {
      return `utterance '${id}' has a trueSpeechEndMs beyond the clip duration`;
    }

    if (referenceText !== undefined && typeof referenceText !== 'string') {
      return `utterance '${id}' has a non-string referenceText`;
    }
  }

  // Contiguity is checked on the set so the order of the array itself is free;
  // the INDEX carries the ordering, not the array position.
  for (let expected = 1; expected <= utterances.length; expected += 1) {
    if (!seenIndices.has(expected)) return `utterance indices must be 1..${utterances.length}`;
  }

  // Monotonicity is checked in index order, which may differ from array order.
  const byIndex = [...utterances].sort((a, b) => a.index - b.index);
  for (const utterance of byIndex) {
    if (utterance.trueSpeechEndMs <= previousSpeechEnd) {
      return `utterance '${utterance.id}' does not advance past the previous speech end`;
    }
    previousSpeechEnd = utterance.trueSpeechEndMs;
  }

  return null;
}
