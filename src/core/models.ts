/**
 * Model id -> (vendor, adapter options) resolution.
 * Isomorphic TypeScript — no node/DOM imports (src/core is compiled by BOTH
 * tsconfigs).
 *
 * `registry.ts` is keyed by VENDOR ('openai' | 'elevenlabs' | 'anthropic' |
 * 'fixture'); `arms.ts` MENUS are MODEL ids. This module is the single mapping
 * between the two, in `src/core/` so client and server agree on one answer.
 * The registry stays vendor-keyed on purpose (same-vendor model swaps are
 * config-only and get no registry name of their own); the model layer sits
 * beside it rather than inside it.
 *
 * THE OPTION KEY IS PART OF THE MAPPING, NOT A CONSTANT. Every adapter but one
 * takes its model as `config.model`; ElevenLabs TTS takes `config.modelId`
 * (`elevenlabs-tts.ts`: `this.config.modelId ?? ELEVENLABS_DEFAULT_MODEL_ID`).
 * A uniform `model` mapping would therefore drop the ElevenLabs TTS model
 * silently — and because Arm C's model IS that adapter's default, Arm C would
 * *look* correct while `eleven_multilingual_v2` actually ran as flash. So the
 * key is pinned per entry, next to the vendor.
 *
 * THE MODEL MUST BE CARRIED, NOT JUST THE VENDOR. Arms B and C differ ONLY in
 * the TTS stage, so a vendor-only resolution would make two labelled arms run
 * one configuration — a wrong result reported confidently, which is worse than
 * the loud `Unknown STT provider "..."` failure this replaces.
 *
 * FIXTURE IS AN ESCAPE, NOT A TABLE ENTRY. 'fixture' is a vendor rather than a
 * model and is deliberately absent from MENUS (arms.ts: no fixture in the
 * menus), so it is handled before the lookup — otherwise fixture mode, which
 * the rest of the suite runs on, would start throwing.
 *
 * UNKNOWN MODELS THROW. There is no default: silently falling back would let a
 * typo'd or stale menu entry produce a run that is labelled as one thing and
 * executed as another. The known-model list in the message is read from MENUS,
 * so a menu entry added without a mapping here fails loudly and names itself.
 *
 * TICKET 069 — AND THE SESSION'S SOURCE LANGUAGE RIDES THROUGH HERE TOO.
 * `resolveTriple` is the ONE place a model id becomes adapter options, so it is
 * also the only place the session can hand the STT stage a fact the model id
 * cannot carry. Ticket 062 routed the TARGET language to the MT stage; the
 * SOURCE language is the same wiring one stage upstream, and its absence is
 * what let a Whisper-family model invent "그러나." / "żeśmy." / "Yardımımın" on
 * the clip's opening silence in 7 of the operator's 17 sweep runs.
 *
 * IT LANDS ON THE STT STAGE AND NOWHERE ELSE, under ONE option key
 * (`languageCode`) for both vendors, so the mapping stays uniform: ElevenLabs
 * already declared exactly that field, and `OpenAiSttConfig` gained it rather
 * than a second name meaning the same thing. Fixture STT is untouched — it is
 * an escape rather than a table entry and has no language knob to set.
 *
 * ABSENCE STAYS ABSENCE. No source language, or an empty one, means NO KEY at
 * all: `''` on the wire is a claim a run that could not name its own language
 * has no business making, and a defaulted `'en'` would be this project's
 * characteristic sin in a new place.
 *
 * TICKET 074 — AND THE TARGET LANGUAGE RIDES THROUGH HERE ONTO THE *TTS*.
 * 062 gave the MT stage its target and 069 gave the STT stage its source; the
 * TTS stage was still built from `{ model }` alone. Mandarin and Cantonese
 * SHARE their written characters — the same characters are simply pronounced
 * differently — so correct Cantonese text handed to a TTS with no delivery
 * instruction is read in Mandarin. That is PRD §10's trap, and it lived in the
 * cascade, not in Realtime (ticket 073).
 *
 * THE LEVER IS PRONUNCIATION, NOT THE VOICE AND NOT THE TEXT. The MT prompt is
 * already correct, and voice ids supply timbre only. `gpt-4o-mini-tts` takes a
 * natural-language `instructions` field documented to steer accent, intonation
 * and tone; that is the whole mechanism.
 *
 * AND ONLY ONE VENDOR HAS IT — WHICH IS EXPERIMENT 2'S ACTUAL RESULT.
 * `eleven_flash_v2_5` has a fixed language list with no Cantonese in it, and
 * its `language_code` is ISO 639-1, which has no code for Cantonese at all
 * (`zh` is the macrolanguage and conventionally resolves to MANDARIN). So Arm C
 * gets NOTHING here: no instruction it cannot read, and above all no `zh` —
 * requesting the wrong variety is worse than requesting none. Arm C's
 * inability is a finding to report, not a gap to paper over.
 */
import { MENUS, type ProviderTriple } from './arms';

export type ProviderKind = 'stt' | 'mt' | 'tts';

export interface ResolvedProvider {
  /** Registry key for createStt/createMt/createTts. */
  vendor: string;
  /** Options forwarded verbatim to the adapter constructor. */
  options: Record<string, unknown>;
}

export interface ResolvedTriple {
  stt: ResolvedProvider;
  mt: ResolvedProvider;
  tts: ResolvedProvider;
}

/** The vendor key that means "no real provider" for every kind. */
const FIXTURE_VENDOR = 'fixture';

interface ModelMapping {
  /** Registry vendor key. */
  vendor: string;
  /** The adapter config property this model id belongs on. */
  optionKey: 'model' | 'modelId';
}

/**
 * Every MENUS entry, per kind. Verified against each adapter's own config
 * interface; `optionKey` is `modelId` for ElevenLabs TTS only.
 */
const MAPPINGS: Record<ProviderKind, Readonly<Record<string, ModelMapping>>> = {
  stt: {
    'gpt-4o-transcribe': { vendor: 'openai', optionKey: 'model' },
    'gpt-4o-mini-transcribe': { vendor: 'openai', optionKey: 'model' },
    scribe_v2_realtime: { vendor: 'elevenlabs', optionKey: 'model' },
  },
  mt: {
    'gpt-4o-mini': { vendor: 'openai', optionKey: 'model' },
    'claude-haiku-4-5': { vendor: 'anthropic', optionKey: 'model' },
  },
  tts: {
    'gpt-4o-mini-tts': { vendor: 'openai', optionKey: 'model' },
    // ElevenLabs TTS is the one adapter keyed on `modelId`.
    eleven_flash_v2_5: { vendor: 'elevenlabs', optionKey: 'modelId' },
    eleven_multilingual_v2: { vendor: 'elevenlabs', optionKey: 'modelId' },
  },
};

/** 'stt' -> 'STT'. The error message names the stage, not just the model. */
const KIND_LABEL: Record<ProviderKind, string> = { stt: 'STT', mt: 'MT', tts: 'TTS' };

function unknownModel(kind: ProviderKind, model: string): Error {
  return new Error(
    `Unknown ${KIND_LABEL[kind]} model "${model}". Known models: ${MENUS[kind].join(', ')}`,
  );
}

/**
 * Resolve one stage's model id to the vendor its adapter is registered under
 * plus the options that carry the model onto that adapter. Kinds are not
 * interchangeable: an STT model asked for as TTS throws.
 */
export function resolveModel(kind: ProviderKind, model: string): ResolvedProvider {
  if (model === FIXTURE_VENDOR) return { vendor: FIXTURE_VENDOR, options: {} };

  const mapping = MAPPINGS[kind]?.[model];
  if (mapping === undefined) throw unknownModel(kind, model);

  return { vendor: mapping.vendor, options: { [mapping.optionKey]: model } };
}

/** What the SESSION knows that a model id cannot carry (ticket 069). */
export interface ResolveTripleOptions {
  /**
   * ISO code of the language being SPOKEN — `'en'` for an `en→es` run, `'es'`
   * for `es→en`. A CODE, not a human name: both STT wire fields
   * (ElevenLabs `language_code`, OpenAI `session.audio.input.transcription
   * .language`) take codes, and the config key both adapters share is already
   * named `languageCode`.
   *
   * DERIVED FROM `direction` BY THE CALLER, never declared beside it — see
   * `sourceLanguageOfDirection` in core/protocol.ts. Omitted (or empty) when
   * the session cannot name it, and then no key reaches the adapter at all.
   */
  sourceLanguage?: string;
  /**
   * TICKET 074 — the HUMAN NAME of the language being spoken TO, exactly as the
   * MT stage receives it ('Cantonese', 'Spanish', 'English'). Used for one
   * thing: choosing a TTS pronunciation instruction. A language with no special
   * pronunciation requirement yields NO option at all.
   */
  targetLanguage?: string;
}

/**
 * Target languages whose PRONUNCIATION must be named, and the instruction that
 * names it. Keyed on the same human names the MT stage is given.
 *
 * Cantonese is the only entry, and deliberately so: every other supported
 * target is unambiguous from its own characters, and an entry here is a claim
 * about a real failure mode, not a stylistic preference.
 */
const TTS_PRONUNCIATION_INSTRUCTIONS: Readonly<Record<string, string>> = {
  Cantonese:
    'Read the text aloud in Cantonese (Yue) — use Cantonese pronunciation and tones, ' +
    'as spoken in Hong Kong. The characters are shared with Mandarin; do NOT read them ' +
    'in Mandarin.',
};

/** The one TTS vendor whose API takes a natural-language delivery instruction. */
const INSTRUCTABLE_TTS_VENDOR = 'openai';

/**
 * Resolve a whole cascade triple, each stage under its own kind.
 *
 * TICKET 069 — `opts.sourceLanguage` is added to the STT stage's options as
 * `languageCode`, for real vendors only. See the header: absent means absent.
 *
 * TICKET 074 — `opts.targetLanguage` may add `instructions` to the TTS stage,
 * for the one vendor that has the field and only for a language whose
 * pronunciation must be named. See the header: Arm C gets nothing.
 */
export function resolveTriple(
  triple: ProviderTriple,
  opts: ResolveTripleOptions = {},
): ResolvedTriple {
  const stt = resolveModel('stt', triple.stt);
  const sourceLanguage = opts.sourceLanguage ?? '';
  // Fixture STT is excluded by its VENDOR, not by the model id: it is the one
  // stage that is an escape rather than a table entry, and it has no knob.
  if (sourceLanguage !== '' && stt.vendor !== FIXTURE_VENDOR) {
    stt.options.languageCode = sourceLanguage;
  }
  const tts = resolveModel('tts', triple.tts);
  const instruction = TTS_PRONUNCIATION_INSTRUCTIONS[opts.targetLanguage ?? ''];
  if (instruction !== undefined && tts.vendor === INSTRUCTABLE_TTS_VENDOR) {
    tts.options.instructions = instruction;
  }
  return {
    stt,
    mt: resolveModel('mt', triple.mt),
    tts,
  };
}
