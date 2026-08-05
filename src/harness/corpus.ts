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

/**
 * Reference sentences per (lang, category) cell — what a REAL recording of
 * this slot would say. The synthetic audio is a tone burst, not this speech.
 */
const TEXTS: Record<CorpusLang, Record<CorpusCategory, [string, string]>> = {
  en: {
    'short-reply': ['Yes, that works for me.', 'No, not today, thank you.'],
    'long-compound': [
      'I wanted to come earlier, but the traffic was terrible and I had to wait for my sister to arrive.',
      'If the pharmacy is closed when we get there, we can try the one across the street or come back tomorrow morning.',
    ],
    'numbers-dates': [
      'My appointment is on March 14th at 3:45 in the afternoon.',
      'The total comes to two hundred and fifty-seven dollars and sixty cents.',
    ],
    'proper-nouns': [
      'Doctor Nguyen works at Saint Vincent Hospital in San Francisco.',
      'I flew from Guadalajara to Vancouver with a layover in Los Angeles.',
    ],
    disfluency: [
      'So, um, I was thinking that maybe we could, uh, reschedule the meeting.',
      'Well, I mean, it is kind of, you know, complicated to explain.',
    ],
    interruption: [
      'Wait, before you continue, I need to ask something first.',
      'Sorry to cut in, but the doctor is ready to see you now.',
    ],
  },
  es: {
    'short-reply': ['Sí, me parece bien.', 'No, hoy no puedo, gracias.'],
    'long-compound': [
      'Quería llegar más temprano, pero el tráfico estaba terrible y tuve que esperar a que llegara mi hermana.',
      'Si la farmacia está cerrada cuando lleguemos, podemos probar la de enfrente o volver mañana por la mañana.',
    ],
    'numbers-dates': [
      'Mi cita es el catorce de marzo a las tres y cuarenta y cinco de la tarde.',
      'El total es doscientos cincuenta y siete dólares con sesenta centavos.',
    ],
    'proper-nouns': [
      'La doctora Nguyen trabaja en el Hospital San Vicente en San Francisco.',
      'Volé de Guadalajara a Vancouver con escala en Los Ángeles.',
    ],
    disfluency: [
      'Pues, este, estaba pensando que quizás podríamos, eh, cambiar la reunión.',
      'Bueno, o sea, es un poco, ya sabes, complicado de explicar.',
    ],
    interruption: [
      'Espera, antes de que sigas, necesito preguntar algo primero.',
      'Perdón por interrumpir, pero el doctor ya puede atenderlo.',
    ],
  },
  yue: {
    'short-reply': ['好呀，冇問題。', '唔得呀，今日唔方便，唔該。'],
    'long-compound': [
      '我本來想早啲嚟，但係塞車塞得好緊要，仲要等埋我家姐嚟到先得。',
      '如果我哋到嗰陣藥房閂咗門，可以試吓對面嗰間，或者聽朝再嚟過。',
    ],
    'numbers-dates': [
      '我個預約係三月十四號下晝三點四十五分。',
      '總共係二百五十七蚊六毫子。',
    ],
    'proper-nouns': [
      '阮醫生喺三藩市聖文森醫院做嘢。',
      '我由瓜達拉哈拉飛去溫哥華，中途喺洛杉磯轉機。',
    ],
    disfluency: [
      '即係，嗯，我諗緊我哋不如，呃，改期開會啦。',
      '咁，即係話，呢件事有啲，你知啦，好難解釋。',
    ],
    interruption: [
      '等陣，你講落去之前，我想先問樣嘢。',
      '唔好意思打斷你，醫生而家可以見你喇。',
    ],
  },
};

/** Deterministic per-category clip lengths (ms). Tone burst < total. */
const TIMING_BY_CATEGORY: Record<CorpusCategory, { speechEndMs: number; durationMs: number }> = {
  'short-reply': { speechEndMs: 900, durationMs: 1600 },
  'long-compound': { speechEndMs: 4200, durationMs: 5200 },
  'numbers-dates': { speechEndMs: 2400, durationMs: 3200 },
  'proper-nouns': { speechEndMs: 2600, durationMs: 3400 },
  disfluency: { speechEndMs: 2800, durationMs: 3800 },
  interruption: { speechEndMs: 1800, durationMs: 2600 },
};

export function buildPlaceholderManifest(): CorpusManifest {
  const clips: CorpusClip[] = [];
  for (const lang of CORPUS_LANGS) {
    for (const category of CORPUS_CATEGORIES) {
      const timing = TIMING_BY_CATEGORY[category];
      for (let i = 1; i <= CLIPS_PER_CELL; i++) {
        const id = `${lang}-${category}-${i}`;
        clips.push({
          id,
          lang,
          category,
          text: TEXTS[lang][category][i - 1]!,
          speechEndMs: timing.speechEndMs,
          durationMs: timing.durationMs,
          file: `${id}.wav`,
        });
      }
    }
  }
  return {
    corpusId: PLACEHOLDER_CORPUS_ID,
    placeholder: true,
    note: PLACEHOLDER_NOTE,
    clips,
  };
}

export function validateManifest(m: CorpusManifest): void {
  const expected = CORPUS_LANGS.length * CORPUS_CATEGORIES.length * CLIPS_PER_CELL;
  if (m.clips.length !== expected) {
    throw new Error(`manifest must have ${expected} clips, got ${m.clips.length}`);
  }
  if (m.placeholder !== true) {
    throw new Error('manifest placeholder flag must be exactly true');
  }
  for (const clip of m.clips) {
    if (clip.file !== `${clip.id}.wav`) {
      throw new Error(`clip ${clip.id}: file must be '${clip.id}.wav', got '${clip.file}'`);
    }
    if (clip.speechEndMs >= clip.durationMs) {
      throw new Error(
        `clip ${clip.id}: speechEndMs (${clip.speechEndMs}) must be < durationMs (${clip.durationMs})`,
      );
    }
  }
}
