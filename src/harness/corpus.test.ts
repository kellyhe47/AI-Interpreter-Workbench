import { describe, expect, it } from 'vitest';
import type { CorpusManifest } from './corpus';
import { buildPlaceholderManifest, validateManifest } from './corpus';

const LANGS = ['en', 'es', 'yue'] as const;
const CATEGORIES = [
  'short-reply',
  'long-compound',
  'numbers-dates',
  'proper-nouns',
  'disfluency',
  'interruption',
] as const;

function clone(m: CorpusManifest): CorpusManifest {
  return JSON.parse(JSON.stringify(m)) as CorpusManifest;
}

describe('buildPlaceholderManifest', () => {
  // Built lazily inside each test so an unimplemented stub fails the tests,
  // not collection.
  const build = () => buildPlaceholderManifest();

  it('has exactly 36 clips = 3 langs x 6 categories x 2', () => {
    const m = build();
    expect(m.clips).toHaveLength(36);
    for (const lang of LANGS) {
      for (const category of CATEGORIES) {
        const cell = m.clips.filter((c) => c.lang === lang && c.category === category);
        expect(cell, `${lang}/${category}`).toHaveLength(2);
      }
    }
  });

  it('is unmistakably marked as placeholder', () => {
    const m = build();
    expect(m.corpusId.startsWith('placeholder')).toBe(true);
    expect(m.corpusId).toBe('placeholder-v0');
    expect(m.placeholder).toBe(true);
    expect(m.note).toBe(
      'synthetic placeholder — no reported number may come from this corpus',
    );
  });

  it('gives every clip a unique id, matching file name, and non-empty text', () => {
    const m = build();
    const ids = new Set(m.clips.map((c) => c.id));
    expect(ids.size).toBe(36);
    for (const clip of m.clips) {
      expect(clip.file).toBe(`${clip.id}.wav`);
      expect(clip.text.length).toBeGreaterThan(0);
    }
  });

  it('has speechEndMs strictly before durationMs on every clip (silence tail)', () => {
    const m = build();
    for (const clip of m.clips) {
      expect(clip.speechEndMs, clip.id).toBeGreaterThan(0);
      expect(clip.speechEndMs, clip.id).toBeLessThan(clip.durationMs);
    }
  });

  it('passes its own validation', () => {
    expect(() => validateManifest(build())).not.toThrow();
  });
});

describe('validateManifest', () => {
  const corruptions: Array<[name: string, corrupt: (m: CorpusManifest) => CorpusManifest]> = [
    [
      'wrong clip count (35)',
      (m) => ({ ...m, clips: m.clips.slice(0, 35) }),
    ],
    [
      'wrong clip count (37)',
      (m) => ({ ...m, clips: [...m.clips, { ...m.clips[0]!, id: 'extra', file: 'extra.wav' }] }),
    ],
    [
      'placeholder flag false',
      (m) => ({ ...m, placeholder: false }),
    ],
    [
      'placeholder flag missing',
      (m) => {
        const bad = clone(m) as Partial<CorpusManifest>;
        delete bad.placeholder;
        return bad as CorpusManifest;
      },
    ],
    [
      'clip file not matching id',
      (m) => {
        const bad = clone(m);
        bad.clips[0]!.file = 'somebody-else.wav';
        return bad;
      },
    ],
    [
      'speechEndMs === durationMs',
      (m) => {
        const bad = clone(m);
        bad.clips[5]!.speechEndMs = bad.clips[5]!.durationMs;
        return bad;
      },
    ],
    [
      'speechEndMs > durationMs',
      (m) => {
        const bad = clone(m);
        bad.clips[5]!.speechEndMs = bad.clips[5]!.durationMs + 100;
        return bad;
      },
    ],
  ];

  it.each(corruptions)('throws on %s', (_name, corrupt) => {
    const bad = corrupt(clone(buildPlaceholderManifest()));
    expect(() => validateManifest(bad)).toThrow();
  });
});
