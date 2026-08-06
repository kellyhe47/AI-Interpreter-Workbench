/**
 * Frozen arm definitions and the derived arm tag.
 * Isomorphic TypeScript — no node/DOM imports.
 *
 * QUARANTINE: MEMBERSHIP IS DERIVED, NEVER DECLARED (PRD §6, decisions 22d-22e).
 *
 * There is no arm-labelling UI anywhere in the product. A run does not carry a
 * tag because someone typed one; it carries a tag because `deriveArmTag` looked
 * at the run's recipe fields and recognised them. That makes mislabelling
 * structurally impossible rather than merely discouraged: a config either IS
 * one of the three frozen recipes or it is 'ad-hoc', and no caller — UI,
 * storage, sweep runner, aggregator — has any other way to decide.
 *
 * RECIPE FIELDS ONLY. `deriveArmTag` matches on `architecture` plus the fields
 * that architecture actually uses (`realtimeModel` for realtime, `providers`
 * for cascade) and ignores everything else on the object. Callers may therefore
 * pass a whole run record straight through, and a stale field left over from a
 * mode switch (a cascade triple hanging off a realtime run) cannot change the
 * answer.
 *
 * TOTAL AND NON-THROWING. Every input maps to a tag. Missing `providers`,
 * empty strings and unknown model ids all resolve to 'ad-hoc' rather than
 * throwing — this function runs on the read path of the runs list and the
 * results aggregation, where a throw would take out the view over one bad
 * record.
 *
 * MODEL SNAPSHOTS ARE A PINNED CONTROL (PRD §8 register). A realtime run on
 * `gpt-realtime-mini` is NOT Arm A, because the model snapshot is part of what
 * the arm holds fixed. Omitting `realtimeModel` means "the default", i.e.
 * REALTIME_MODEL, so it does derive to 'A'.
 *
 * FROZEN AT RUNTIME. ARMS and MENUS are deep-frozen. An arm is a comparison
 * baseline: if any caller could append to ARMS or edit an entry in place, runs
 * recorded before and after that mutation would silently stop being
 * comparable while still sharing a tag.
 *
 * NO FIXTURE IN THE MENUS (PRD §17, decision 23b). The fixture providers exist
 * for development, but listing one beside the real providers invites a
 * fabricated-output run into the ledger, so MENUS carries real models only.
 */
import type { Mode } from './timing';

export type ArmTag = 'A' | 'B' | 'C' | 'ad-hoc';

/** Provider triple for a cascade configuration. Values are MODEL ids (see MENUS). */
export interface ProviderTriple {
  stt: string;
  mt: string;
  tts: string;
}

export interface RunConfig {
  architecture: Mode;
  /** Realtime model id; only meaningful when architecture === 'realtime'. */
  realtimeModel?: string;
  /** Required when architecture === 'cascade'. */
  providers?: ProviderTriple;
}

export interface ArmDefinition {
  tag: 'A' | 'B' | 'C';
  label: string;
  description: string;
  /** The frozen recipe. */
  config: RunConfig;
}

/**
 * Recursively freezes a value and everything reachable from it. Object.freeze
 * is shallow, and ARMS nests two levels deep (entry -> config -> providers),
 * so a shallow freeze would still let a caller rewrite an arm's triple.
 */
function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const nested of Object.values(value as Record<string, unknown>)) {
      deepFreeze(nested);
    }
    Object.freeze(value);
  }
  return value;
}

/** The pinned realtime model snapshot — the only model that derives to Arm A. */
export const REALTIME_MODEL = 'gpt-realtime';

/**
 * The default cascade triple for a fresh config panel. It is Arm B's recipe by
 * construction (PRD §17, decision 23d): a default that derived to 'ad-hoc'
 * would quietly turn every unconfigured run into an orphan no comparison can use.
 */
export const DEFAULT_CASCADE_TRIPLE: ProviderTriple = deepFreeze({
  stt: 'gpt-4o-transcribe',
  mt: 'gpt-4o-mini',
  tts: 'gpt-4o-mini-tts',
});

/** The selectable model ids per stage, in menu order (PRD §6 table). */
export const MENUS: { stt: readonly string[]; mt: readonly string[]; tts: readonly string[] } =
  deepFreeze({
    stt: ['gpt-4o-transcribe', 'gpt-4o-mini-transcribe', 'scribe_v2_realtime'],
    mt: ['gpt-4o-mini', 'claude-haiku-4-5'],
    tts: ['gpt-4o-mini-tts', 'eleven_flash_v2_5', 'eleven_multilingual_v2'],
  });

export function armLabel(tag: ArmTag): string {
  return tag === 'ad-hoc' ? 'ad-hoc' : `Arm ${tag}`;
}

/** The three frozen arms (PRD §3). Every model id here also appears in MENUS. */
export const ARMS: readonly ArmDefinition[] = deepFreeze([
  {
    tag: 'A',
    label: armLabel('A'),
    description: 'Realtime speech-to-speech on the pinned gpt-realtime snapshot.',
    config: { architecture: 'realtime', realtimeModel: REALTIME_MODEL },
  },
  {
    tag: 'B',
    label: armLabel('B'),
    description: 'Cascade, all-OpenAI: gpt-4o-transcribe -> gpt-4o-mini -> gpt-4o-mini-tts.',
    config: { architecture: 'cascade', providers: DEFAULT_CASCADE_TRIPLE },
  },
  {
    tag: 'C',
    label: armLabel('C'),
    description:
      'Cascade, ElevenLabs TTS: gpt-4o-transcribe -> gpt-4o-mini -> eleven_flash_v2_5. ' +
      'Differs from Arm B in the TTS stage only, isolating the TTS swap.',
    config: {
      architecture: 'cascade',
      providers: { stt: 'gpt-4o-transcribe', mt: 'gpt-4o-mini', tts: 'eleven_flash_v2_5' },
    },
  },
]);

function sameTriple(a: ProviderTriple | undefined, b: ProviderTriple | undefined): boolean {
  if (a === undefined || b === undefined) return false;
  return a.stt === b.stt && a.mt === b.mt && a.tts === b.tts;
}

/**
 * The single source of truth for which arm a configuration belongs to.
 * Total: anything that is not exactly one of the frozen recipes is 'ad-hoc'.
 */
export function deriveArmTag(config: RunConfig): ArmTag {
  const architecture = config?.architecture;

  for (const arm of ARMS) {
    if (arm.config.architecture !== architecture) continue;

    if (architecture === 'realtime') {
      // An omitted realtimeModel means "the default", not "unknown".
      const model = config?.realtimeModel ?? REALTIME_MODEL;
      if (model === (arm.config.realtimeModel ?? REALTIME_MODEL)) return arm.tag;
      continue;
    }

    if (sameTriple(config?.providers, arm.config.providers)) return arm.tag;
  }

  return 'ad-hoc';
}
