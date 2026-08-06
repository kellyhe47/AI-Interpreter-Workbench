import { describe, expect, it } from 'vitest';
import {
  CORPUS_CATEGORIES,
  isCorpusCategory,
  validateManifest,
  type CorpusUtterance,
} from './corpus';

const DURATION = 45_000;

/** A valid 4-utterance take, the §9 shape: ~4 utterances, ≤45 s. */
function manifest(overrides: Partial<CorpusUtterance>[] = []): CorpusUtterance[] {
  const base: CorpusUtterance[] = [
    { id: 'en-1-1', index: 1, category: 'short-reply', trueSpeechEndMs: 4_000, referenceText: 'Yes.' },
    { id: 'en-1-2', index: 2, category: 'numbers-dates', trueSpeechEndMs: 16_000, referenceText: 'Take 250 milligrams twice daily.' },
    { id: 'en-1-3', index: 3, category: 'disfluency', trueSpeechEndMs: 27_500, referenceText: 'I— sorry, I meant Tuesday.' },
    { id: 'en-1-4', index: 4, category: 'proper-nouns', trueSpeechEndMs: 41_000, referenceText: 'Doctor Nguyen at Cedars-Sinai.' },
  ];
  return base.map((u, i) => ({ ...u, ...(overrides[i] ?? {}) }));
}

describe('CORPUS_CATEGORIES', () => {
  it('is exactly the six PRD §9 categories', () => {
    expect([...CORPUS_CATEGORIES]).toEqual([
      'short-reply',
      'long-compound',
      'numbers-dates',
      'proper-nouns',
      'disfluency',
      'interruption',
    ]);
  });

  it('recognises its own members and nothing else', () => {
    for (const category of CORPUS_CATEGORIES) expect(isCorpusCategory(category)).toBe(true);
    for (const notACategory of ['', 'numbers', 'Short-Reply', 42, null, undefined]) {
      expect(isCorpusCategory(notACategory)).toBe(false);
    }
  });
});

describe('validateManifest — accepts a well-formed take', () => {
  it('accepts the §9 four-utterance shape', () => {
    expect(validateManifest(manifest(), DURATION)).toBeNull();
  });

  it('accepts a Cantonese take, where no utterance carries a reference', () => {
    const yue = manifest().map(({ referenceText: _drop, ...rest }) => rest);
    expect(validateManifest(yue, DURATION)).toBeNull();
  });

  it('accepts a single-utterance take', () => {
    const one: CorpusUtterance[] = [
      { id: 'es-3-1', index: 1, category: 'interruption', trueSpeechEndMs: 9_000 },
    ];
    expect(validateManifest(one, DURATION)).toBeNull();
  });

  it('does not depend on ARRAY order — the index carries the ordering', () => {
    const shuffled = [...manifest()].reverse();
    expect(validateManifest(shuffled, DURATION)).toBeNull();
  });
});

describe('validateManifest — rejects with a named reason', () => {
  // Table-driven: every rule exists because breaking it yields a plausible
  // WRONG number rather than an obvious failure.
  const cases: Array<{ name: string; utterances: CorpusUtterance[]; match: RegExp }> = [
    {
      name: 'an empty manifest',
      utterances: [],
      match: /must not be empty/,
    },
    {
      name: 'a duplicate id (WER and category rows key on it)',
      utterances: manifest([{}, { id: 'en-1-1' }]),
      match: /duplicate utterance id 'en-1-1'/,
    },
    {
      name: 'a duplicate index',
      utterances: manifest([{}, { index: 1 }]),
      match: /duplicate utterance index 1/,
    },
    {
      name: 'a gap in the indices (index IS the replay completion order)',
      utterances: manifest([{}, {}, {}, { index: 9 }]),
      match: /indices must be 1\.\.4/,
    },
    {
      name: 'an index below 1',
      utterances: manifest([{ index: 0 }]),
      match: /non-positive index/,
    },
    {
      name: 'an unknown category (would silently drop a by-category row)',
      utterances: manifest([{ category: 'numbers' as never }]),
      match: /unknown category/,
    },
    {
      name: 'a speech end at the clip start',
      utterances: manifest([{ trueSpeechEndMs: 0 }]),
      match: /at or before the clip start/,
    },
    {
      name: 'a speech end past the clip duration',
      utterances: manifest([{}, {}, {}, { trueSpeechEndMs: DURATION + 1 }]),
      match: /beyond the clip duration/,
    },
    {
      name: 'a non-monotonic boundary (utterance k anchored inside k-1)',
      utterances: manifest([{}, { trueSpeechEndMs: 3_000 }]),
      match: /does not advance past the previous speech end/,
    },
    {
      name: 'two utterances sharing one boundary',
      utterances: manifest([{}, { trueSpeechEndMs: 4_000 }]),
      match: /does not advance past the previous speech end/,
    },
    {
      name: 'a non-string referenceText',
      utterances: manifest([{ referenceText: 12 as never }]),
      match: /non-string referenceText/,
    },
    {
      name: 'a non-numeric speech end',
      utterances: manifest([{ trueSpeechEndMs: Number.NaN }]),
      match: /non-numeric trueSpeechEndMs/,
    },
    {
      name: 'an empty id',
      utterances: manifest([{ id: '' }]),
      match: /non-empty id/,
    },
  ];

  for (const { name, utterances, match } of cases) {
    it(`rejects ${name}`, () => {
      const reason = validateManifest(utterances, DURATION);
      expect(reason).not.toBeNull();
      expect(reason!).toMatch(match);
    });
  }

  it('a boundary exactly at durationMs is allowed — speech may end at the last sample', () => {
    expect(validateManifest(manifest([{}, {}, {}, { trueSpeechEndMs: DURATION }]), DURATION)).toBeNull();
  });
});
