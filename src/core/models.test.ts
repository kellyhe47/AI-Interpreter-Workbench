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

// ---------------------------------------------------------------------------
// TICKET 069 — THE SOURCE-LANGUAGE HINT, ROUTED EXACTLY AS 062 ROUTED THE
// TARGET.
//
// `resolveTriple` builds every provider from `{ model }` alone, so both STT
// adapters open their session with no language at all: `OpenAiSttConfig` has no
// language field, and `ElevenLabsSttConfig.languageCode` — which already
// reaches the URL query AND the config frame — is never populated by anything.
// A Whisper-family model handed no language and a moment of non-speech invents
// one: "그러나.", "żeśmy.", "Yardımımın", "Hallo." in 7 of 17 real sweep runs.
//
// This is ticket 062's defect one stage upstream: the adapter has the knob, the
// session has the answer, and nothing connects them. `resolveTriple` is the
// connection, and the hint lands on the STT stage ONLY.
// ---------------------------------------------------------------------------

/** The second argument `resolveTriple` gains — not yet declared in production. */
type TripleOptions = { sourceLanguage?: string };
type ResolveTripleWithSource = (
  triple: ProviderTriple,
  opts?: TripleOptions,
) => ReturnType<typeof resolveTriple>;
const resolveTripleWithSource = resolveTriple as ResolveTripleWithSource;

describe('TICKET 069 — the source language reaches the STT stage, and only it', () => {
  const REAL_TRIPLE: ProviderTriple = {
    stt: 'gpt-4o-transcribe',
    mt: 'gpt-4o-mini',
    tts: 'eleven_flash_v2_5',
  };

  it('carries the source language onto the STT options, beside the model', () => {
    const r = resolveTripleWithSource(REAL_TRIPLE, { sourceLanguage: 'en' });
    // Deep-equal: the KEY is pinned and nothing else leaks onto the stage.
    expect(r.stt).toEqual({
      vendor: 'openai',
      options: { model: 'gpt-4o-transcribe', languageCode: 'en' },
    });
  });

  it('carries it for the ElevenLabs STT too — the SAME option key, so the mapping stays uniform', () => {
    const r = resolveTripleWithSource(
      { ...REAL_TRIPLE, stt: 'scribe_v2_realtime' },
      { sourceLanguage: 'es' },
    );
    expect(r.stt).toEqual({
      vendor: 'elevenlabs',
      options: { model: 'scribe_v2_realtime', languageCode: 'es' },
    });
  });

  it('leaves MT and TTS EXACTLY as they were — the hint is an STT concern', () => {
    const plain = resolveTriple(REAL_TRIPLE);
    const hinted = resolveTripleWithSource(REAL_TRIPLE, { sourceLanguage: 'es' });
    expect(hinted.mt).toEqual(plain.mt);
    expect(hinted.tts).toEqual(plain.tts);
    // Said absolutely, so a future change to `plain` cannot make this vacuous.
    expect(hinted.mt).toEqual({ vendor: 'openai', options: { model: 'gpt-4o-mini' } });
    expect(hinted.tts).toEqual({
      vendor: 'elevenlabs',
      options: { modelId: 'eleven_flash_v2_5' },
    });
  });

  it('NO source language means NO key — absent, never a guessed default', () => {
    expect(resolveTripleWithSource(REAL_TRIPLE)).toEqual(resolveTriple(REAL_TRIPLE));
    expect(resolveTripleWithSource(REAL_TRIPLE, {}).stt.options).toEqual({
      model: 'gpt-4o-transcribe',
    });
    // An EMPTY source language is the same absence, not the string ''. A run
    // that could not name its own language must not claim one on the wire.
    expect(resolveTripleWithSource(REAL_TRIPLE, { sourceLanguage: '' }).stt.options).toEqual({
      model: 'gpt-4o-transcribe',
    });
    expect(
      'languageCode' in resolveTripleWithSource(REAL_TRIPLE, { sourceLanguage: '' }).stt.options,
    ).toBe(false);
  });

  it('the hint lands on the ADAPTER, not just on the options bag', () => {
    const r = resolveTripleWithSource(
      { ...REAL_TRIPLE, stt: 'scribe_v2_realtime' },
      { sourceLanguage: 'yue' },
    );
    const stt = createStt(r.stt.vendor, r.stt.options) as unknown as {
      config: Record<string, unknown>;
    };
    expect(stt.config.languageCode).toBe('yue');
    expect(stt.config.model).toBe('scribe_v2_realtime');

    const openai = resolveTripleWithSource(REAL_TRIPLE, { sourceLanguage: 'es' });
    const openaiStt = createStt(openai.stt.vendor, openai.stt.options) as unknown as {
      config: Record<string, unknown>;
    };
    // TICKET 069 — `OpenAiSttConfig` gains the field it never had.
    expect(openaiStt.config.languageCode).toBe('es');
  });

  it('FIXTURE STT is untouched — it is an escape, not a table entry, and has no language knob', () => {
    const r = resolveTripleWithSource(
      { stt: 'fixture', mt: 'fixture', tts: 'fixture' },
      { sourceLanguage: 'es' },
    );
    expect(r.stt).toEqual({ vendor: 'fixture', options: {} });
  });
});

// ---------------------------------------------------------------------------
// TICKET 074 — AND THE TARGET LANGUAGE HAS TO REACH THE *TTS* STAGE.
//
// 062 gave the MT stage its target and 069 gave the STT stage its source. The
// TTS stage was still built from `{ model }` alone, so the cascade handed
// correct Cantonese characters to a model with no instruction about how to
// pronounce them — and Mandarin and Cantonese share those characters. That is
// PRD §10's trap: a transcript that reads perfectly and audio that is wrong.
//
// The lever is `gpt-4o-mini-tts`'s natural-language `instructions` field. It
// exists on ONE of the two TTS vendors, which is the finding: ElevenLabs'
// `eleven_flash_v2_5` has a fixed language list with no Cantonese in it and an
// ISO 639-1 `language_code` that cannot express Cantonese at all. Arm C's
// inability is reported, never papered over with `zh` — which would request
// MANDARIN, the defect wearing the fix's clothes.
// ---------------------------------------------------------------------------

type TripleTargetOptions = { sourceLanguage?: string; targetLanguage?: string };
type ResolveTripleWithTarget = (
  triple: ProviderTriple,
  opts?: TripleTargetOptions,
) => ReturnType<typeof resolveTriple>;
const resolveTripleWithTarget = resolveTriple as ResolveTripleWithTarget;

describe('TICKET 074 — the Cantonese pronunciation instruction reaches the TTS stage', () => {
  const ARM_B: ProviderTriple = {
    stt: 'gpt-4o-transcribe',
    mt: 'gpt-4o-mini',
    tts: 'gpt-4o-mini-tts',
  };
  const ARM_C: ProviderTriple = { ...ARM_B, tts: 'eleven_flash_v2_5' };

  it('en→yue: Arm B gets an instruction that NAMES Cantonese pronunciation', () => {
    const r = resolveTripleWithTarget(ARM_B, { targetLanguage: 'Cantonese' });
    expect(r.tts.vendor).toBe('openai');
    const instructions = r.tts.options.instructions;
    expect(typeof instructions).toBe('string');
    expect(instructions as string).toMatch(/Cantonese/);
    // The model is still carried — the instruction is added beside it.
    expect(r.tts.options.model).toBe('gpt-4o-mini-tts');
  });

  it('en→es: NO instructions key at all — absence, never a guessed default', () => {
    const r = resolveTripleWithTarget(ARM_B, { targetLanguage: 'Spanish' });
    expect(r.tts).toEqual({ vendor: 'openai', options: { model: 'gpt-4o-mini-tts' } });
    expect('instructions' in r.tts.options).toBe(false);
  });

  it('no target language named is the same absence', () => {
    expect('instructions' in resolveTripleWithTarget(ARM_B).tts.options).toBe(false);
    expect('instructions' in resolveTripleWithTarget(ARM_B, {}).tts.options).toBe(false);
    expect(
      'instructions' in resolveTripleWithTarget(ARM_B, { targetLanguage: '' }).tts.options,
    ).toBe(false);
  });

  it('the two directions differ on the wire — that is what makes this falsifiable', () => {
    const yue = resolveTripleWithTarget(ARM_B, { targetLanguage: 'Cantonese' }).tts.options
      .instructions;
    const es = resolveTripleWithTarget(ARM_B, { targetLanguage: 'Spanish' }).tts.options
      .instructions;
    expect(yue).not.toEqual(es);
    expect(es).toBeUndefined();
  });

  it('ARM C IS NOT PAPERED OVER: ElevenLabs gets no instruction and NO Cantonese language code', () => {
    const r = resolveTripleWithTarget(ARM_C, { targetLanguage: 'Cantonese' });
    // Deep-equal: the model, and nothing else. No `instructions` it cannot
    // read, and above all no `language_code` — ISO 639-1 has no Cantonese and
    // `zh` would request Mandarin.
    expect(r.tts).toEqual({ vendor: 'elevenlabs', options: { modelId: 'eleven_flash_v2_5' } });
    expect(JSON.stringify(r.tts.options)).not.toMatch(/zh|language_code|Cantonese/i);
  });

  it('the instruction lands on the ADAPTER, and reaches the request body', () => {
    const r = resolveTripleWithTarget(ARM_B, { targetLanguage: 'Cantonese' });
    const tts = createTts(r.tts.vendor, r.tts.options) as unknown as {
      config: Record<string, unknown>;
    };
    expect(tts.config.instructions).toMatch(/Cantonese/);
    expect(tts.config.model).toBe('gpt-4o-mini-tts');
  });

  it('FIXTURE TTS is untouched — an escape, not a table entry', () => {
    const r = resolveTripleWithTarget(
      { stt: 'fixture', mt: 'fixture', tts: 'fixture' },
      { targetLanguage: 'Cantonese' },
    );
    expect(r.tts).toEqual({ vendor: 'fixture', options: {} });
  });
});
