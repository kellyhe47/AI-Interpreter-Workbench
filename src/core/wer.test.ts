/**
 * TICKET 034 — the WER core: ONE normalizer, ONE distance, ONE score shape.
 *
 * WHY THIS SUITE IS THE LOAD-BEARING ONE. Normalization materially changes WER,
 * so every rule below is PINNED rather than left to the implementation, and the
 * two rulings the ticket asked to be decided out loud — NUMBERS and SPANISH
 * DIACRITICS — get their own tables.
 *
 * The single most important assertion in the file is the Cantonese one:
 * a missing `referenceText` must produce `wer: null`, NEVER `0`. Zero is a
 * PERFECT score, so a 0 there would report the one arm nobody can score as the
 * best arm in the study.
 *
 * Pure string work: no I/O, no clock, no API call.
 */
import { describe, expect, it } from 'vitest';

import type { CorpusUtterance } from './corpus';
import {
  WER_NORMALIZATION_VERSION,
  WER_NOT_APPLICABLE,
  latestWerScores,
  normalizeForWer,
  scoreRunWer,
  scoreUtteranceWer,
  tokenEditDistance,
  werScoreKey,
  werTokens,
  wordErrorRate,
  type WerScore,
} from './wer';

const AT = 1_700_000_000_000;

/* ==================================================== the normalizer, table = */

describe('ticket 034 — normalizeForWer: ONE function, applied to both sides', () => {
  const cases: Array<{ rule: string; input: string; expected: string }> = [
    { rule: 'case folding', input: 'The Quick BROWN Fox', expected: 'the quick brown fox' },
    {
      rule: 'sentence punctuation is stripped',
      input: 'Hello, world! Is it? Yes; it is: yes.',
      expected: 'hello world is it yes it is yes',
    },
    {
      rule: 'Spanish ¿ and ¡ are stripped like any other punctuation',
      input: '¿Cómo está? ¡Bien!',
      expected: 'como esta bien',
    },
    {
      rule: 'quotes, brackets and symbols are stripped',
      input: '“He said (twice) — $5 & 10%”',
      expected: 'he said twice 5 10',
    },
    { rule: 'whitespace collapses and trims', input: '  a\t\tb\n c  ', expected: 'a b c' },
    {
      rule: 'hyphens JOIN words, so they become a space',
      input: 'twenty-five state-of-the-art',
      expected: 'twenty five state of the art',
    },
    { rule: 'slashes become a space too', input: 'and/or', expected: 'and or' },
    {
      rule: "an apostrophe is dropped, identically on both sides",
      input: "don't o'clock",
      expected: 'dont oclock',
    },
    { rule: 'an empty string normalizes to an empty string', input: '', expected: '' },
    { rule: 'punctuation-only text normalizes to nothing', input: '¿?!.,', expected: '' },
  ];

  it.each(cases)('AC-norm: $rule', ({ input, expected }) => {
    expect(normalizeForWer(input)).toBe(expected);
  });

  it('AC-norm: it is IDEMPOTENT — normalizing twice changes nothing', () => {
    for (const { input } of cases) {
      expect(normalizeForWer(normalizeForWer(input))).toBe(normalizeForWer(input));
    }
  });
});

/* ============================================ THE RULING: Spanish diacritics = */

describe('ticket 034 — RULING: stress marks and the diaeresis are STRIPPED, ñ is NOT', () => {
  /**
   * Accents are an ORTHOGRAPHIC convention vendors disagree about, so scoring
   * them measures a style guide rather than recognition. `ñ` is exempt because
   * it is a SEPARATE LETTER — folding it makes `año` and `ano` the same word,
   * which is a semantic collapse, not a spelling one.
   */
  const cases: Array<{ rule: string; input: string; expected: string }> = [
    { rule: 'á é í ó ú fold to their base letters', input: 'árbol café así jóven útil', expected: 'arbol cafe asi joven util' },
    { rule: 'the diaeresis folds too', input: 'pingüino', expected: 'pinguino' },
    { rule: 'ñ SURVIVES — it is a letter, not an accent', input: 'año señor niño', expected: 'año señor niño' },
    { rule: 'Ñ survives case folding as ñ', input: 'AÑO', expected: 'año' },
  ];

  it.each(cases)('AC-norm: $rule', ({ input, expected }) => {
    expect(normalizeForWer(input)).toBe(expected);
  });

  it('AC-norm: an accent-dropping STT scores 0 against an accented script', () => {
    // The whole point of the ruling: the vendor that writes "como esta" and the
    // vendor that writes "cómo está" are not being ranked on their accents.
    expect(wordErrorRate('¿Cómo está usted?', 'como esta usted')).toBe(0);
  });

  it('AC-norm: but ano and año are still two DIFFERENT words', () => {
    expect(wordErrorRate('el año pasado', 'el ano pasado')).toBeCloseTo(1 / 3, 10);
  });
});

/* ================================================== THE RULING: numbers ===== */

describe('ticket 034 — RULING: digits and number words are DIFFERENT tokens', () => {
  /**
   * NO digit<->word conversion in either direction. A conversion needs a
   * language-specific lexicon for EN and ES that is itself a silent source of
   * error inside the metric, and the reference is a verbatim script the
   * operator controls. Applied identically to both sides, which is what makes
   * the comparison between arms fair. The `numbers-dates` category exists to
   * EXPOSE this divergence; normalizing it away would delete the finding.
   */
  it('AC-norm: "250" is not reconciled with "two hundred fifty"', () => {
    expect(normalizeForWer('250')).toBe('250');
    expect(normalizeForWer('two hundred fifty')).toBe('two hundred fifty');
    // 1 reference token, 3 hypothesis tokens: 1 substitution + 2 insertions.
    expect(wordErrorRate('250', 'two hundred fifty')).toBe(3);
  });

  it('AC-norm: and the reverse direction is not reconciled either', () => {
    // 3 reference tokens vs 1: 1 substitution + 2 deletions = 3/3.
    expect(wordErrorRate('two hundred fifty', '250')).toBe(1);
  });

  const numeric: Array<{ rule: string; input: string; expected: string }> = [
    { rule: 'a thousands separator is deleted, so 1,250 === 1250', input: 'take 1,250 mg', expected: 'take 1250 mg' },
    { rule: 'a decimal point BETWEEN DIGITS survives — 2.5 must not become 25', input: '2.5 mg', expected: '2.5 mg' },
    { rule: 'a sentence-final period after a digit is still stripped', input: 'Take 5.', expected: 'take 5' },
    { rule: 'a currency symbol is stripped like other punctuation', input: '$1,250.75', expected: '1250.75' },
    { rule: 'a date keeps its parts as separate tokens', input: '2026/08/07', expected: '2026 08 07' },
    { rule: 'a hyphenated dosage splits', input: '10-20 mg', expected: '10 20 mg' },
  ];

  it.each(numeric)('AC-norm: $rule', ({ input, expected }) => {
    expect(normalizeForWer(input)).toBe(expected);
  });

  it('AC-norm: 1,250 and 1250 therefore score 0 against each other', () => {
    expect(wordErrorRate('take 1,250 mg', 'take 1250 mg')).toBe(0);
  });

  it('AC-norm: 2.5 and 25 do NOT — the decimal point is load-bearing', () => {
    expect(wordErrorRate('2.5 mg', '25 mg')).toBe(0.5);
  });
});

/* ============================================================ tokenization = */

describe('ticket 034 — werTokens', () => {
  it('AC-norm: tokens are words, and an empty string is ZERO tokens not one', () => {
    expect(werTokens('The quick,  brown fox!')).toEqual(['the', 'quick', 'brown', 'fox']);
    expect(werTokens('')).toEqual([]);
    expect(werTokens('   ')).toEqual([]);
    expect(werTokens('¿?!')).toEqual([]);
  });
});

/* ================================================= the distance and formula = */

describe('ticket 034 — tokenEditDistance is over TOKENS, never characters', () => {
  it('AC-formula: a one-character difference inside a word is ONE token edit', () => {
    // Character-level distance would be 1 too, but for 8 tokens of difference
    // the two disagree wildly — this pins which one is implemented.
    expect(tokenEditDistance(['catastrophe'], ['catastrophes'])).toBe(1);
    expect(tokenEditDistance(['a', 'b', 'c'], ['a', 'b', 'c'])).toBe(0);
    expect(tokenEditDistance([], ['a', 'b'])).toBe(2);
    expect(tokenEditDistance(['a', 'b'], [])).toBe(2);
    expect(tokenEditDistance([], [])).toBe(0);
  });

  it('AC-formula: substitution, deletion and insertion all cost ONE', () => {
    expect(tokenEditDistance(['a', 'b', 'c'], ['a', 'x', 'c'])).toBe(1);
    expect(tokenEditDistance(['a', 'b', 'c'], ['a', 'c'])).toBe(1);
    expect(tokenEditDistance(['a', 'b', 'c'], ['a', 'b', 'x', 'c'])).toBe(1);
  });
});

describe('ticket 034 — wordErrorRate = (S + D + I) / N_reference, hand-computed', () => {
  /** Every expectation here was computed by hand from the module's rules. */
  const cases: Array<{ name: string; reference: string; hypothesis: string; wer: number }> = [
    { name: 'a perfect transcript is 0', reference: 'the quick brown fox', hypothesis: 'the quick brown fox', wer: 0 },
    { name: 'one substitution over four reference tokens', reference: 'the quick brown fox', hypothesis: 'the fast brown fox', wer: 0.25 },
    { name: 'one deletion over four', reference: 'the quick brown fox', hypothesis: 'the quick brown', wer: 0.25 },
    { name: 'one insertion over four', reference: 'the quick brown fox', hypothesis: 'the very quick brown fox', wer: 0.25 },
    { name: 'S + D + I together: 3 edits over four', reference: 'the quick brown fox', hypothesis: 'a quick brown fox jumps', wer: 0.5 },
    { name: 'a transposition costs TWO substitutions', reference: 'uno dos tres', hypothesis: 'uno tres dos', wer: 2 / 3 },
    { name: 'an EMPTY hypothesis is exactly 1.0 — every token deleted', reference: 'the quick brown fox', hypothesis: '', wer: 1 },
    { name: 'punctuation-only hypothesis is also 1.0', reference: 'the quick brown fox', hypothesis: '...!?', wer: 1 },
    { name: 'a total mismatch of equal length is 1.0', reference: 'one two', hypothesis: 'three four', wer: 1 },
  ];

  it.each(cases)('AC-formula: $name', ({ reference, hypothesis, wer }) => {
    expect(wordErrorRate(reference, hypothesis)).toBeCloseTo(wer, 10);
  });

  it('AC-formula: WER ABOVE 1.0 IS POSSIBLE and is NEVER CLAMPED', () => {
    // A one-word reference against a three-word hallucination: 1 substitution +
    // 2 insertions over 1 reference token. Clamping this to 1.0 would render a
    // babbling arm and a silent arm as the same number.
    expect(wordErrorRate('hola', 'buenos dias amigos')).toBe(3);
    expect(wordErrorRate('hola', 'hola mundo entero')).toBe(2);
    expect(wordErrorRate('hola', 'hola')).toBe(0);
  });

  it('AC-formula: an EMPTY REFERENCE has no denominator and THROWS', () => {
    // 0 and 1 would both be inventions. The `not applicable` path is where an
    // absent reference is handled — see scoreUtteranceWer.
    expect(() => wordErrorRate('', 'anything')).toThrow(/denominator|empty reference/i);
    expect(() => wordErrorRate('¿?', 'anything')).toThrow();
  });
});

/* ======================== NOT APPLICABLE IS NOT ZERO (the load-bearing rule) = */

describe('ticket 034 — a missing referenceText is `not applicable`, NEVER 0', () => {
  it('AC3: Cantonese has no script (PRD §9), so wer is null with a named reason', () => {
    const score = scoreUtteranceWer({
      runId: 'run-yue',
      utteranceId: 'u-yue-1',
      // NO referenceText: improvised from English prompt cards.
      hypothesisText: '你好嗎',
      scoredAt: AT,
    });

    expect(score.wer).toBeNull();
    // A ZERO WER IS A PERFECT SCORE. Writing one here would report the one arm
    // nobody can score as the best arm in the study.
    expect(score.wer).not.toBe(0);
    expect(score.notApplicableReason).toBe('no-reference-text');
    expect(score.referenceText).toBeNull();
    expect(score.hypothesisText).toBe('你好嗎');
    expect(WER_NOT_APPLICABLE).toBe('not applicable');
  });

  it('AC3: a reference that normalizes to NOTHING is also not applicable', () => {
    const score = scoreUtteranceWer({
      runId: 'run-1',
      utteranceId: 'u-1',
      referenceText: '   ',
      hypothesisText: 'hello',
      scoredAt: AT,
    });
    expect(score.wer).toBeNull();
    expect(score.notApplicableReason).toBe('no-reference-text');
  });

  it('AC3: an ABSENT hypothesis is not applicable — a different reason', () => {
    const score = scoreUtteranceWer({
      runId: 'run-1',
      utteranceId: 'u-1',
      referenceText: 'the quick brown fox',
      scoredAt: AT,
    });
    expect(score.wer).toBeNull();
    expect(score.notApplicableReason).toBe('no-hypothesis');
  });

  it('AC3: an EMPTY-STRING hypothesis is NOT `no-hypothesis` — it is a 1.0 miss', () => {
    // The arm produced output and the output was nothing. That is a real, total
    // failure and it must be counted as one, not excused as unmeasurable.
    const score = scoreUtteranceWer({
      runId: 'run-1',
      utteranceId: 'u-1',
      referenceText: 'the quick brown fox',
      hypothesisText: '',
      scoredAt: AT,
    });
    expect(score.wer).toBe(1);
    expect(score.notApplicableReason).toBeUndefined();
  });

  it('AC1: a scored record carries its key, its inputs and the normalizer version', () => {
    const score = scoreUtteranceWer({
      runId: 'run-1',
      utteranceId: 'u-1',
      referenceText: 'The quick brown fox.',
      hypothesisText: 'the quick brown ox',
      scoredAt: AT,
    });

    expect(score).toEqual({
      runId: 'run-1',
      utteranceId: 'u-1',
      wer: 0.25,
      // Stored VERBATIM (pre-normalization) so a reviewer can recompute it.
      referenceText: 'The quick brown fox.',
      hypothesisText: 'the quick brown ox',
      normalizationVersion: WER_NORMALIZATION_VERSION,
      scoredAt: AT,
    });
    expect(WER_NORMALIZATION_VERSION.length).toBeGreaterThan(0);
  });

  it('AC1: the score key is (runId, utteranceId) and nothing else', () => {
    expect(werScoreKey('run-1', 'u-1')).toBe(werScoreKey('run-1', 'u-1'));
    expect(werScoreKey('run-1', 'u-1')).not.toBe(werScoreKey('run-2', 'u-1'));
    expect(werScoreKey('run-1', 'u-1')).not.toBe(werScoreKey('run-1', 'u-2'));
  });
});

/* ================================================ scoring a whole Run ====== */

describe('ticket 034 — scoreRunWer maps a Run onto its manifest', () => {
  const manifest: CorpusUtterance[] = [
    { id: 'u-1', index: 1, category: 'short-reply', trueSpeechEndMs: 1_000, referenceText: 'Hello there.' },
    { id: 'u-2', index: 2, category: 'numbers-dates', trueSpeechEndMs: 2_000, referenceText: 'Take 250 mg twice.' },
    // Cantonese-style entry: NO referenceText at all (PRD §9).
    { id: 'u-3', index: 3, category: 'disfluency', trueSpeechEndMs: 3_000 },
  ];

  const run = {
    id: 'run-1',
    utterances: [
      { utteranceId: 'u-1', transcripts: { source: 'hello there', target: 'hola' } },
      { utteranceId: 'u-2', transcripts: { source: 'take two hundred fifty mg twice', target: '' } },
      { utteranceId: 'u-3', transcripts: { source: '你好', target: 'hello' } },
    ],
  };

  it('AC1: one score per utterance record, keyed by (runId, utteranceId)', () => {
    const scores = scoreRunWer(run, manifest, AT);
    expect(scores.map((s) => [s.runId, s.utteranceId])).toEqual([
      ['run-1', 'u-1'],
      ['run-1', 'u-2'],
      ['run-1', 'u-3'],
    ]);
  });

  it('AC3: the Cantonese-style entry reports not applicable while the others score', () => {
    const [first, second, third] = scoreRunWer(run, manifest, AT);
    expect(first!.wer).toBe(0);
    // "250" vs "two hundred fifty": 1 substitution + 2 insertions over 4 tokens.
    expect(second!.wer).toBeCloseTo(3 / 4, 10);
    expect(third!.wer).toBeNull();
    expect(third!.notApplicableReason).toBe('no-reference-text');
  });

  it('AC1: THE HYPOTHESIS IS transcripts.source, never transcripts.target', () => {
    // The manifest script is in the SOURCE language, so only the source
    // transcript can be scored against it — which is why WER measures the STT
    // stage and two arms sharing an STT stage have no WER delta.
    const scores = scoreRunWer(
      { id: 'run-x', utterances: [{ utteranceId: 'u-1', transcripts: { source: 'hello there', target: 'utter nonsense here' } }] },
      manifest,
      AT,
    );
    expect(scores[0]!.wer).toBe(0);
    expect(scores[0]!.hypothesisText).toBe('hello there');
  });

  it('AC1: a Run carrying NO utterance records produces NO scores', () => {
    // WER attaches to the measured atom; a record-less Run has none.
    expect(scoreRunWer({ id: 'run-empty' }, manifest, AT)).toEqual([]);
    expect(scoreRunWer({ id: 'run-empty', utterances: [] }, manifest, AT)).toEqual([]);
  });

  it('AC3: an utterance the manifest does not name is not applicable, not 0', () => {
    const scores = scoreRunWer(
      { id: 'run-y', utterances: [{ utteranceId: 'u-unknown', transcripts: { source: 'anything' } }] },
      manifest,
      AT,
    );
    expect(scores[0]!.wer).toBeNull();
    expect(scores[0]!.notApplicableReason).toBe('no-reference-text');
  });
});

/* ========================================== last-write-wins over the history = */

describe('ticket 034 — latestWerScores: LAST WRITE WINS, history preserved', () => {
  const score = (utteranceId: string, wer: number | null, scoredAt: number): WerScore => ({
    runId: 'run-1',
    utteranceId,
    wer,
    ...(wer === null ? { notApplicableReason: 'no-reference-text' as const } : {}),
    referenceText: wer === null ? null : 'hello there',
    hypothesisText: 'hello there',
    normalizationVersion: WER_NORMALIZATION_VERSION,
    scoredAt,
  });

  it('AC6: re-scoring the same key wins on read — the LAST entry', () => {
    const history = [score('u-1', 0.5, 1), score('u-2', 0.25, 2), score('u-1', 0.1, 3)];

    expect(latestWerScores(history).map((s) => [s.utteranceId, s.wer])).toEqual([
      ['u-1', 0.1],
      ['u-2', 0.25],
    ]);
    // The INPUT is untouched: the stream is append-only and the earlier line
    // survives on disk, so the collapse happens on READ and nowhere else.
    expect(history).toHaveLength(3);
    expect(history[0]!.wer).toBe(0.5);
  });

  it('AC6: the result keeps FIRST-APPEARANCE order, so a re-score does not reshuffle', () => {
    const history = [score('u-1', 0.5, 1), score('u-2', 0.25, 2), score('u-1', 0.1, 3)];
    expect(latestWerScores(history).map((s) => s.utteranceId)).toEqual(['u-1', 'u-2']);
  });

  it('AC6: scores of DIFFERENT runs never collide, even on the same utteranceId', () => {
    const a = { ...score('u-1', 0.5, 1), runId: 'run-a' };
    const b = { ...score('u-1', 0.9, 2), runId: 'run-b' };
    expect(latestWerScores([a, b])).toEqual([a, b]);
  });

  it('AC6: an empty history collapses to an empty list', () => {
    expect(latestWerScores([])).toEqual([]);
  });
});
