/**
 * Registry additions for the real provider adapters (tickets 006/007).
 * Kept separate from the LOCKED registry.test.ts, which stays untouched.
 *
 * NOTE: this file must stay free of node-only globals — it is type-checked by
 * both the server and the client tsconfig.
 */

import { describe, expect, it } from 'vitest';
import { createMt, createStt, createTts } from './registry';
import { FixtureTts } from './fixtures/index';
import { OpenAiStt } from '../server/providers/openai-stt';
import { OpenAiMt } from '../server/providers/openai-mt';
import { OpenAiTts } from '../server/providers/openai-tts';
import { ElevenLabsTts } from '../server/providers/elevenlabs-tts';

describe('provider registry: real adapter entries', () => {
  it("createStt('openai') returns an OpenAiStt with config forwarded", () => {
    const p = createStt('openai', { apiKey: 'k', model: 'gpt-4o-transcribe' });
    expect(p).toBeInstanceOf(OpenAiStt);
    expect((p as OpenAiStt).config).toMatchObject({ apiKey: 'k' });
  });

  it("createMt('openai') returns an OpenAiMt", () => {
    const p = createMt('openai', { apiKey: 'k', targetLang: 'Spanish' });
    expect(p).toBeInstanceOf(OpenAiMt);
    expect((p as OpenAiMt).config).toMatchObject({ targetLang: 'Spanish' });
  });

  it("createTts('openai') returns an OpenAiTts", () => {
    const p = createTts('openai', { apiKey: 'k', voice: 'nova' });
    expect(p).toBeInstanceOf(OpenAiTts);
    expect((p as OpenAiTts).config).toMatchObject({ voice: 'nova' });
  });

  it("createTts('elevenlabs') returns an ElevenLabsTts with config forwarded", () => {
    const p = createTts('elevenlabs', { apiKey: 'k', voiceId: 'v123' });
    expect(p).toBeInstanceOf(ElevenLabsTts);
    expect((p as ElevenLabsTts).config).toMatchObject({ voiceId: 'v123' });
  });

  it('options stay optional for the new entries', () => {
    expect(createStt('openai')).toBeInstanceOf(OpenAiStt);
    expect(createMt('openai')).toBeInstanceOf(OpenAiMt);
    expect(createTts('openai')).toBeInstanceOf(OpenAiTts);
    expect(createTts('elevenlabs')).toBeInstanceOf(ElevenLabsTts);
  });

  it("the 'fixture' entry keeps working alongside the new ones", () => {
    expect(createTts('fixture')).toBeInstanceOf(FixtureTts);
  });

  it('unknown-name errors now list ALL known provider names', () => {
    expect(() => createStt('nope')).toThrowError(/nope/);
    expect(() => createStt('nope')).toThrowError(/fixture/);
    expect(() => createStt('nope')).toThrowError(/openai/);

    expect(() => createMt('nope')).toThrowError(/fixture/);
    expect(() => createMt('nope')).toThrowError(/openai/);

    expect(() => createTts('nope')).toThrowError(/fixture/);
    expect(() => createTts('nope')).toThrowError(/openai/);
    expect(() => createTts('nope')).toThrowError(/elevenlabs/);
  });
});
