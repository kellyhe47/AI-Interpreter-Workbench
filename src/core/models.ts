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

/** Resolve a whole cascade triple, each stage under its own kind. */
export function resolveTriple(triple: ProviderTriple): ResolvedTriple {
  return {
    stt: resolveModel('stt', triple.stt),
    mt: resolveModel('mt', triple.mt),
    tts: resolveModel('tts', triple.tts),
  };
}
