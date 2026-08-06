import { describe, expect, it } from 'vitest';
import {
  ARMS,
  DEFAULT_CASCADE_TRIPLE,
  MENUS,
  REALTIME_MODEL,
  armLabel,
  deriveArmTag,
} from './arms';
import type { ArmTag, ProviderTriple, RunConfig } from './arms';

/** Arm B's frozen recipe, spelled out literally so the test does not read it from ARMS. */
const B: ProviderTriple = { stt: 'gpt-4o-transcribe', mt: 'gpt-4o-mini', tts: 'gpt-4o-mini-tts' };
/** Arm C's frozen recipe — same as B except the TTS stage. */
const C: ProviderTriple = { stt: 'gpt-4o-transcribe', mt: 'gpt-4o-mini', tts: 'eleven_flash_v2_5' };

const cascade = (providers?: ProviderTriple): RunConfig => ({
  architecture: 'cascade',
  ...(providers ? { providers } : {}),
});

interface Case {
  name: string;
  config: RunConfig;
  expected: ArmTag;
}

const cases: Case[] = [
  // --- Arm A: realtime ---
  {
    name: 'realtime with the pinned realtime model → A',
    config: { architecture: 'realtime', realtimeModel: 'gpt-realtime' },
    expected: 'A',
  },
  {
    name: 'realtime with realtimeModel omitted (means "the default") → A',
    config: { architecture: 'realtime' },
    expected: 'A',
  },
  {
    name: 'realtime with a DIFFERENT model snapshot (gpt-realtime-mini) → ad-hoc',
    config: { architecture: 'realtime', realtimeModel: 'gpt-realtime-mini' },
    expected: 'ad-hoc',
  },
  {
    name: 'realtime with an unknown model id → ad-hoc',
    config: { architecture: 'realtime', realtimeModel: 'not-a-real-model' },
    expected: 'ad-hoc',
  },
  {
    name: 'realtime config carrying a stray cascade triple → still A (recipe fields only)',
    config: { architecture: 'realtime', realtimeModel: 'gpt-realtime', providers: B },
    expected: 'A',
  },

  // --- Arms B and C: exact triples ---
  { name: "Arm B's exact triple → B", config: cascade(B), expected: 'B' },
  { name: "Arm C's exact triple → C", config: cascade(C), expected: 'C' },
  {
    name: 'cascade config carrying a stray realtimeModel → still B (recipe fields only)',
    config: { architecture: 'cascade', providers: B, realtimeModel: 'gpt-realtime' },
    expected: 'B',
  },

  // --- One-stage deviations from Arm B ---
  {
    name: 'B with STT swapped to gpt-4o-mini-transcribe → ad-hoc',
    config: cascade({ ...B, stt: 'gpt-4o-mini-transcribe' }),
    expected: 'ad-hoc',
  },
  {
    name: 'B with STT swapped to scribe_v2_realtime → ad-hoc',
    config: cascade({ ...B, stt: 'scribe_v2_realtime' }),
    expected: 'ad-hoc',
  },
  {
    name: 'B with MT swapped to claude-haiku-4-5 → ad-hoc',
    config: cascade({ ...B, mt: 'claude-haiku-4-5' }),
    expected: 'ad-hoc',
  },
  {
    name: 'B with TTS swapped to eleven_multilingual_v2 → ad-hoc',
    config: cascade({ ...B, tts: 'eleven_multilingual_v2' }),
    expected: 'ad-hoc',
  },
  {
    name: 'B with TTS swapped to eleven_flash_v2_5 → C, not ad-hoc',
    config: cascade({ ...B, tts: 'eleven_flash_v2_5' }),
    expected: 'C',
  },
  {
    name: 'C with TTS swapped back to gpt-4o-mini-tts → B, not ad-hoc',
    config: cascade({ ...C, tts: 'gpt-4o-mini-tts' }),
    expected: 'B',
  },

  // --- Sad paths ---
  {
    name: 'cascade with providers undefined → ad-hoc (never throws)',
    config: { architecture: 'cascade', providers: undefined },
    expected: 'ad-hoc',
  },
  {
    name: 'cascade with the providers key absent entirely → ad-hoc (never throws)',
    config: cascade(),
    expected: 'ad-hoc',
  },
  {
    name: 'cascade with an unknown STT model id → ad-hoc',
    config: cascade({ ...B, stt: 'whisper-9000' }),
    expected: 'ad-hoc',
  },
  {
    name: 'cascade with an unknown MT model id → ad-hoc',
    config: cascade({ ...B, mt: 'gpt-nonexistent' }),
    expected: 'ad-hoc',
  },
  {
    name: 'cascade with an unknown TTS model id → ad-hoc',
    config: cascade({ ...B, tts: 'fixture' }),
    expected: 'ad-hoc',
  },
  {
    name: 'cascade with empty-string stages → ad-hoc',
    config: cascade({ stt: '', mt: '', tts: '' }),
    expected: 'ad-hoc',
  },
];

describe('deriveArmTag', () => {
  for (const c of cases) {
    it(c.name, () => {
      expect(deriveArmTag(c.config)).toBe(c.expected);
    });
  }

  it('ignores extra/unrelated keys on the config object (a full run record derives too)', () => {
    // Not an object literal at the call site, so excess-property checking does
    // not apply — this models a caller passing a richer run record through.
    const richRunRecord = {
      architecture: 'cascade' as const,
      providers: B,
      runId: 'run-42',
      origin: 'sweep',
      status: 'complete',
      corpusId: 'c1',
      contextPolicy: 'none',
      nested: { anything: true },
    };
    expect(deriveArmTag(richRunRecord)).toBe('B');

    const richRealtimeRecord = {
      architecture: 'realtime' as const,
      realtimeModel: 'gpt-realtime',
      runId: 'run-43',
      origin: 'manual',
    };
    expect(deriveArmTag(richRealtimeRecord)).toBe('A');
  });

  it('never throws on any case in the table', () => {
    for (const c of cases) {
      expect(() => deriveArmTag(c.config)).not.toThrow();
    }
  });
});

describe('armLabel', () => {
  const labels: Array<[ArmTag, string]> = [
    ['A', 'Arm A'],
    ['B', 'Arm B'],
    ['C', 'Arm C'],
    ['ad-hoc', 'ad-hoc'],
  ];
  for (const [tag, label] of labels) {
    it(`armLabel('${tag}') → '${label}'`, () => {
      expect(armLabel(tag)).toBe(label);
    });
  }
});

describe('constants', () => {
  it("REALTIME_MODEL is 'gpt-realtime'", () => {
    expect(REALTIME_MODEL).toBe('gpt-realtime');
  });

  it("DEFAULT_CASCADE_TRIPLE derives to 'B' — the default panel state is comparable, not orphaned", () => {
    expect(deriveArmTag({ architecture: 'cascade', providers: DEFAULT_CASCADE_TRIPLE })).toBe('B');
  });

  it('MENUS lists the selectable model ids in menu order', () => {
    expect([...MENUS.stt]).toEqual([
      'gpt-4o-transcribe',
      'gpt-4o-mini-transcribe',
      'scribe_v2_realtime',
    ]);
    expect([...MENUS.mt]).toEqual(['gpt-4o-mini', 'claude-haiku-4-5']);
    expect([...MENUS.tts]).toEqual([
      'gpt-4o-mini-tts',
      'eleven_flash_v2_5',
      'eleven_multilingual_v2',
    ]);
  });

  it('no fixture appears in any menu', () => {
    const all = [...MENUS.stt, ...MENUS.mt, ...MENUS.tts];
    expect(all.length).toBeGreaterThan(0);
    for (const id of all) {
      expect(id.toLowerCase()).not.toContain('fixture');
    }
  });
});

describe('ARMS', () => {
  it('holds exactly the three frozen arms A, B, C', () => {
    expect(ARMS.map((a) => a.tag)).toEqual(['A', 'B', 'C']);
  });

  it('each entry has its armLabel label and a non-empty description string', () => {
    expect(ARMS).toHaveLength(3);
    for (const arm of ARMS) {
      expect(arm.label).toBe(armLabel(arm.tag));
      expect(typeof arm.description).toBe('string');
      expect(arm.description.length).toBeGreaterThan(0);
    }
  });

  it("each entry's frozen config derives back to its own tag (round trip)", () => {
    expect(ARMS).toHaveLength(3);
    for (const arm of ARMS) {
      expect(deriveArmTag(arm.config)).toBe(arm.tag);
    }
  });

  it("Arm B's config is the DEFAULT_CASCADE_TRIPLE", () => {
    const b = ARMS.find((a) => a.tag === 'B');
    expect(b?.config.providers).toEqual(DEFAULT_CASCADE_TRIPLE);
  });

  it('every model id used by any arm also appears in the corresponding MENUS list', () => {
    expect(ARMS).toHaveLength(3);
    for (const arm of ARMS) {
      if (arm.config.architecture === 'cascade') {
        const p = arm.config.providers;
        expect(p).toBeDefined();
        expect(MENUS.stt).toContain(p?.stt);
        expect(MENUS.mt).toContain(p?.mt);
        expect(MENUS.tts).toContain(p?.tts);
      }
    }
  });
});

/**
 * Object.freeze mutation is a throw under ES-module strict mode, but an
 * implementation may also achieve immutability some other way. Either
 * behaviour passes: the mutation must not change the observed value.
 */
function expectImmutable(read: () => unknown, mutate: () => void): void {
  const before = JSON.stringify(read());
  try {
    mutate();
  } catch {
    // Throwing on mutation is an acceptable outcome.
  }
  expect(JSON.stringify(read())).toBe(before);
}

describe('runtime freezing', () => {
  it('ARMS cannot be appended to', () => {
    expectImmutable(
      () => ARMS,
      () => {
        (ARMS as ArmDefinitionArray).push({
          tag: 'A',
          label: 'Arm A',
          description: 'injected',
          config: { architecture: 'realtime' },
        });
      },
    );
  });

  it('ARMS entries cannot be replaced by index', () => {
    expectImmutable(
      () => ARMS,
      () => {
        (ARMS as ArmDefinitionArray)[0] = {
          tag: 'C',
          label: 'Arm C',
          description: 'redefined',
          config: cascade(C),
        };
      },
    );
  });

  it('an ARMS entry cannot be redefined in place', () => {
    expectImmutable(
      () => ARMS,
      () => {
        const first = ARMS[0] as { tag: string; config: RunConfig } | undefined;
        if (first) {
          first.tag = 'ad-hoc-injected';
          first.config = cascade({ stt: 'x', mt: 'y', tts: 'z' });
        }
      },
    );
  });

  it('MENUS lists cannot be appended to', () => {
    expectImmutable(
      () => MENUS,
      () => {
        (MENUS.stt as string[]).push('fixture');
        (MENUS.mt as string[]).push('fixture');
        (MENUS.tts as string[]).push('fixture');
      },
    );
  });

  it('MENUS lists cannot be swapped out wholesale', () => {
    expectImmutable(
      () => MENUS,
      () => {
        (MENUS as { stt: readonly string[] }).stt = ['injected-menu-list'];
      },
    );
  });
});

type ArmDefinitionArray = Array<(typeof ARMS)[number]>;
