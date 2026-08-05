/**
 * Ticket 015 — Placeholder corpus manifest.
 *
 * ============================ API DESIGN (normative) =======================
 * PRD corpus shape: 36 clips = 3 languages (en, es, yue) x 6 categories x 2
 * clips each, all 24 kHz mono PCM16 WAV. THIS corpus is a SYNTHETIC
 * placeholder (tone bursts + silence tail, see wav.generateClip) and is
 * marked so that NO reported number can ever come from it:
 *   - corpusId 'placeholder-v0' (the 'placeholder' prefix trips the ledger's
 *     realness rule — see src/client/state/ledger.ts isRealRecord).
 *   - placeholder: true flag.
 *   - note: PLACEHOLDER_NOTE verbatim.
 *
 * buildPlaceholderManifest() -> CorpusManifest
 *   Deterministic manifest of 36 clips. Each clip:
 *     id          unique, stable (e.g. 'en-short-reply-1')
 *     lang        'en' | 'es' | 'yue'
 *     category    one of CORPUS_CATEGORIES
 *     text        non-empty reference sentence for the category (what a real
 *                 recording of this slot would say; synthetic audio does NOT
 *                 contain this speech — it is a tone burst)
 *     speechEndMs ground-truth speech end (tone-burst length), strictly less
 *                 than durationMs (silence tail always present)
 *     durationMs  total clip length
 *     file        `${id}.wav`
 *
 * validateManifest(m) -> void; throws Error on:
 *   - clip count !== 36
 *   - placeholder flag missing or not === true
 *   - any clip whose file !== `${clip.id}.wav`
 *   - any clip with speechEndMs >= durationMs
 * ==========================================================================
 */

export const PLACEHOLDER_CORPUS_ID = 'placeholder-v0';

export const PLACEHOLDER_NOTE =
  'synthetic placeholder — no reported number may come from this corpus';

export const CORPUS_LANGS = ['en', 'es', 'yue'] as const;
export type CorpusLang = (typeof CORPUS_LANGS)[number];

/** The 6 PRD clip categories. */
export const CORPUS_CATEGORIES = [
  'short-reply',
  'long-compound',
  'numbers-dates',
  'proper-nouns',
  'disfluency',
  'interruption',
] as const;
export type CorpusCategory = (typeof CORPUS_CATEGORIES)[number];

/** Clips per (lang, category) cell: 3 x 6 x 2 = 36. */
export const CLIPS_PER_CELL = 2;

export interface CorpusClip {
  id: string;
  lang: CorpusLang;
  category: CorpusCategory;
  /** Reference sentence for the slot (non-empty). */
  text: string;
  /** Ground-truth speech end within the clip; < durationMs. */
  speechEndMs: number;
  /** Total clip length in ms. */
  durationMs: number;
  /** WAV filename relative to the corpus dir; always `${id}.wav`. */
  file: string;
}

export interface CorpusManifest {
  corpusId: string;
  /** True marks the corpus as never-reportable (fixtures-never-report rule). */
  placeholder: boolean;
  note: string;
  clips: CorpusClip[];
}

export function buildPlaceholderManifest(): CorpusManifest {
  throw new Error('not implemented');
}

export function validateManifest(m: CorpusManifest): void {
  void m;
  throw new Error('not implemented');
}
