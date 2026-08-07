/**
 * Ticket 039 — model id -> (vendor, option key, model) resolution.
 *
 * The registry is keyed by VENDOR; the arm menus are MODEL ids. Without this
 * mapping every cascade arm fails with `Unknown STT provider "..."`, and a
 * vendor-only mapping is WORSE than the failure: it would make Arms B and C
 * run the identical configuration while still being labelled as two arms.
 *
 * The most load-bearing assertion here is the option KEY. ElevenLabs TTS takes
 * `modelId`; every other adapter takes `model`. A uniform `model` mapping
 * silently drops the ElevenLabs TTS model — and since Arm C's model IS the
 * ElevenLabs default, Arm C would look correct while `eleven_multilingual_v2`
 * ran as flash. So we pin the whole options object, key included.
 */
import { describe, expect, it } from 'vitest';
import { MENUS, ARMS, DEFAULT_CASCADE_TRIPLE, type ProviderTriple } from './arms';
import { resolveModel, resolveTriple, type ProviderKind } from './models';
import { createMt, createStt, createTts } from './registry';

interface Case {
  kind: ProviderKind;
  model: string;
  vendor: string;
  optionKey: 'model' | 'modelId';
}

const CASES: readonly Case[] = [
  { kind: 'stt', model: 'gpt-4o-transcribe', vendor: 'openai', optionKey: 'model' },
  { kind: 'stt', model: 'gpt-4o-mini-transcribe', vendor: 'openai', optionKey: 'model' },
  { kind: 'stt', model: 'scribe_v2_realtime', vendor: 'elevenlabs', optionKey: 'model' },
  { kind: 'mt', model: 'gpt-4o-mini', vendor: 'openai', optionKey: 'model' },
  { kind: 'mt', model: 'claude-haiku-4-5', vendor: 'anthropic', optionKey: 'model' },
  { kind: 'tts', model: 'gpt-4o-mini-tts', vendor: 'openai', optionKey: 'model' },
  { kind: 'tts', model: 'eleven_flash_v2_5', vendor: 'elevenlabs', optionKey: 'modelId' },
  { kind: 'tts', model: 'eleven_multilingual_v2', vendor: 'elevenlabs', optionKey: 'modelId' },
];

describe('resolveModel — every MENUS entry maps to (vendor, optionKey, model)', () => {
  for (const c of CASES) {
    it(`${c.kind} "${c.model}" -> ${c.vendor} { ${c.optionKey} }`, () => {
      const resolved = resolveModel(c.kind, c.model);
      expect(resolved.vendor).toBe(c.vendor);
      // Deep-equal, so the option KEY is pinned and no extra keys leak in.
      expect(resolved.options).toEqual({ [c.optionKey]: c.model });
    });
  }

  it('covers every MENUS entry — no menu model is unmappable', () => {
    const covered = new Set(CASES.map((c) => `${c.kind}:${c.model}`));
    const menuEntries: string[] = [
      ...MENUS.stt.map((m) => `stt:${m}`),
      ...MENUS.mt.map((m) => `mt:${m}`),
      ...MENUS.tts.map((m) => `tts:${m}`),
    ];
    expect(menuEntries.filter((e) => !covered.has(e))).toEqual([]);
    for (const kind of ['stt', 'mt', 'tts'] as const) {
      for (const model of MENUS[kind]) {
        expect(() => resolveModel(kind, model)).not.toThrow();
      }
    }
  });

  it("resolved vendors are real registry keys — createX accepts every one", () => {
    for (const c of CASES) {
      const { vendor, options } = resolveModel(c.kind, c.model);
      const create =
        c.kind === 'stt' ? createStt : c.kind === 'mt' ? createMt : createTts;
      const provider = create(vendor, options);
      expect(provider.name).toBe(c.vendor);
      // The model actually lands on the adapter's own config.
      expect((provider as unknown as { config: Record<string, unknown> }).config[c.optionKey]).toBe(
        c.model,
      );
    }
  });
});

describe('fixture mode is unaffected', () => {
  it("'fixture' resolves for all three kinds to the fixture vendor with no options", () => {
    for (const kind of ['stt', 'mt', 'tts'] as const) {
      const resolved = resolveModel(kind, 'fixture');
      expect(resolved.vendor).toBe('fixture');
      expect(resolved.options).toEqual({});
    }
  });

  it('resolveTriple of an all-fixture triple still builds fixture providers', () => {
    const t = resolveTriple({ stt: 'fixture', mt: 'fixture', tts: 'fixture' });
    expect(createStt(t.stt.vendor, t.stt.options).name).toBe('fixture');
    expect(createMt(t.mt.vendor, t.mt.options).name).toBe('fixture');
    expect(createTts(t.tts.vendor, t.tts.options).name).toBe('fixture');
  });
});

describe('unknown models fail loudly — never a silent default', () => {
  it('names the unknown model and the kind', () => {
    expect(() => resolveModel('stt', 'gpt-9-imaginary')).toThrow(/gpt-9-imaginary/);
    expect(() => resolveModel('stt', 'gpt-9-imaginary')).toThrow(/STT/i);
  });

  it('lists the known models for that kind', () => {
    let message = '';
    try {
      resolveModel('tts', 'nope');
    } catch (err) {
      message = (err as Error).message;
    }
    for (const model of MENUS.tts) expect(message).toContain(model);
  });

  it('a model valid for another kind does not resolve (kinds are not interchangeable)', () => {
    expect(() => resolveModel('tts', 'gpt-4o-transcribe')).toThrow(/gpt-4o-transcribe/);
    expect(() => resolveModel('stt', 'gpt-4o-mini-tts')).toThrow(/gpt-4o-mini-tts/);
  });

  it('empty string throws rather than defaulting', () => {
    expect(() => resolveModel('mt', '')).toThrow(/Unknown MT model/);
  });
});

/**
 * THE ANTI-COLLAPSE TEST. Arms B and C differ ONLY in the TTS stage. A
 * vendor-only mapping (or one that drops the model) makes them resolve
 * identically while the ledger still labels them B and C — a wrong
 * configuration reported as a correct one, which destroys Experiment 2.
 */
describe('Arm B vs Arm C resolve to demonstrably different configurations', () => {
  const tripleOf = (tag: 'B' | 'C'): ProviderTriple =>
    ARMS.find((a) => a.tag === tag)!.config.providers!;

  it('Arm B is the all-OpenAI resolution', () => {
    const r = resolveTriple(tripleOf('B'));
    expect(r).toEqual({
      stt: { vendor: 'openai', options: { model: 'gpt-4o-transcribe' } },
      mt: { vendor: 'openai', options: { model: 'gpt-4o-mini' } },
      tts: { vendor: 'openai', options: { model: 'gpt-4o-mini-tts' } },
    });
  });

  it('Arm C reaches ElevenLabs for TTS, carrying modelId', () => {
    const r = resolveTriple(tripleOf('C'));
    expect(r.tts).toEqual({
      vendor: 'elevenlabs',
      options: { modelId: 'eleven_flash_v2_5' },
    });
    // ...and is otherwise identical to B, isolating the TTS swap.
    const b = resolveTriple(tripleOf('B'));
    expect(r.stt).toEqual(b.stt);
    expect(r.mt).toEqual(b.mt);
  });

  it('B and C do NOT collapse to the same TTS configuration', () => {
    const b = resolveTriple(tripleOf('B'));
    const c = resolveTriple(tripleOf('C'));
    expect(c.tts).not.toEqual(b.tts);
    expect(c.tts.vendor).not.toBe(b.tts.vendor);
  });

  it('the two ElevenLabs TTS models do not collapse either (modelId is carried)', () => {
    const flash = resolveModel('tts', 'eleven_flash_v2_5');
    const multi = resolveModel('tts', 'eleven_multilingual_v2');
    expect(flash.vendor).toBe(multi.vendor);
    expect(multi.options).not.toEqual(flash.options);
    expect(multi.options).toEqual({ modelId: 'eleven_multilingual_v2' });
  });

  it('DEFAULT_CASCADE_TRIPLE (Arm B) resolves without throwing', () => {
    expect(() => resolveTriple(DEFAULT_CASCADE_TRIPLE)).not.toThrow();
  });
});

describe('resolveTriple resolves each stage with its own kind', () => {
  it('a triple mixing vendors resolves per stage', () => {
    const r = resolveTriple({
      stt: 'scribe_v2_realtime',
      mt: 'claude-haiku-4-5',
      tts: 'eleven_multilingual_v2',
    });
    expect(r).toEqual({
      stt: { vendor: 'elevenlabs', options: { model: 'scribe_v2_realtime' } },
      mt: { vendor: 'anthropic', options: { model: 'claude-haiku-4-5' } },
      tts: { vendor: 'elevenlabs', options: { modelId: 'eleven_multilingual_v2' } },
    });
  });

  it('propagates the named error from whichever stage is unknown', () => {
    expect(() =>
      resolveTriple({ stt: 'gpt-4o-transcribe', mt: 'bogus-mt', tts: 'gpt-4o-mini-tts' }),
    ).toThrow(/bogus-mt/);
  });
});
