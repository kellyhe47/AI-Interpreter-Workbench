/**
 * Registry additions for the real provider adapters (tickets 006/007).
 * Kept separate from the LOCKED registry.test.ts, which stays untouched.
 *
 * NOTE: this file must stay free of node-only *globals* — it is type-checked by
 * both the server and the client tsconfig. The `node:fs` import used by the
 * `.env.example` block below is an explicit module import (not a global) and
 * type-checks under both configs; this file only ever runs in the node vitest
 * environment (`src/client/**` is the only jsdom glob).
 */

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { createMt, createStt, createTts } from './registry';
import { FixtureTts } from './fixtures/index';
import { OpenAiStt } from '../server/providers/openai-stt';
import { OpenAiMt } from '../server/providers/openai-mt';
import { OpenAiTts } from '../server/providers/openai-tts';
import { ElevenLabsTts } from '../server/providers/elevenlabs-tts';
import { ElevenLabsStt } from '../server/providers/elevenlabs-stt';
import { AnthropicMt } from '../server/providers/anthropic-mt';

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

// ---------------------------------------------------------------------------
// Ticket 006 — the ticket-004 / ticket-005 adapters become reachable by name.
//
// Table over {factory, name, options, expectedClass, probe}: every new registry
// entry is one row, so a future adapter is one more row rather than one more
// bespoke test. `probe` picks the config field whose forwarding proves the
// options object reached the constructor untouched.
// ---------------------------------------------------------------------------

interface RegistryRow {
  readonly kind: 'STT' | 'MT' | 'TTS';
  readonly create: (name: string, options?: Record<string, unknown>) => unknown;
  readonly name: string;
  readonly options: Record<string, unknown>;
  readonly expected: abstract new (...args: never[]) => unknown;
  /** Subset of the constructed provider's `config` that must match. */
  readonly forwarded: Record<string, unknown>;
}

const NEW_ENTRIES: readonly RegistryRow[] = [
  {
    kind: 'STT',
    create: createStt,
    name: 'elevenlabs',
    options: { apiKey: 'k', languageCode: 'en' },
    expected: ElevenLabsStt,
    forwarded: { apiKey: 'k', languageCode: 'en' },
  },
  {
    kind: 'MT',
    create: createMt,
    name: 'anthropic',
    options: { apiKey: 'k', targetLang: 'Spanish' },
    expected: AnthropicMt,
    forwarded: { apiKey: 'k', targetLang: 'Spanish' },
  },
];

describe('provider registry: ticket-006 adapter entries', () => {
  for (const row of NEW_ENTRIES) {
    it(`create${row.kind[0]}${row.kind.slice(1).toLowerCase()}('${row.name}', opts) returns a ${row.expected.name} with config forwarded`, () => {
      const p = row.create(row.name, row.options);
      expect(p).toBeInstanceOf(row.expected);
      expect((p as { config: unknown }).config).toMatchObject(row.forwarded);
    });

    it(`options stay optional for '${row.name}' (${row.kind})`, () => {
      expect(row.create(row.name)).toBeInstanceOf(row.expected);
    });
  }
});

// ---------------------------------------------------------------------------
// Config-only variants: a same-vendor model swap must NOT need a registry name.
// ---------------------------------------------------------------------------

describe('provider registry: config-only model variants', () => {
  it("createStt('openai', {model:'gpt-4o-mini-transcribe'}) forwards the model — the half-price variant needs no new registry entry", () => {
    const p = createStt('openai', { apiKey: 'k', model: 'gpt-4o-mini-transcribe' });
    expect(p).toBeInstanceOf(OpenAiStt);
    expect((p as OpenAiStt).config.model).toBe('gpt-4o-mini-transcribe');
  });

  it("createTts('elevenlabs', {modelId:'eleven_multilingual_v2'}) forwards the model id", () => {
    const p = createTts('elevenlabs', { apiKey: 'k', modelId: 'eleven_multilingual_v2' });
    expect(p).toBeInstanceOf(ElevenLabsTts);
    expect((p as ElevenLabsTts).config.modelId).toBe('eleven_multilingual_v2');
  });
});

// ---------------------------------------------------------------------------
// Unknown-name errors must list EVERY known name for that kind. Phrasing is
// deliberately open — only containment of each name is asserted.
// ---------------------------------------------------------------------------

const KNOWN_NAMES: ReadonlyArray<{
  kind: string;
  create: (name: string) => unknown;
  known: readonly string[];
}> = [
  { kind: 'STT', create: createStt, known: ['fixture', 'openai', 'elevenlabs'] },
  { kind: 'MT', create: createMt, known: ['fixture', 'openai', 'anthropic'] },
  { kind: 'TTS', create: createTts, known: ['fixture', 'openai', 'elevenlabs'] },
];

describe('provider registry: unknown-name errors list every known name', () => {
  for (const { kind, create, known } of KNOWN_NAMES) {
    it(`${kind} lists ${known.join(', ')}`, () => {
      expect(() => create('does-not-exist')).toThrowError(/does-not-exist/);
      for (const name of known) {
        expect(() => create('does-not-exist')).toThrowError(new RegExp(name));
      }
    });
  }

  it('the MT error does NOT silently drop a kind-specific name into the wrong kind', () => {
    // 'anthropic' is an MT-only name; STT/TTS must not advertise it.
    expect(() => createStt('does-not-exist')).not.toThrowError(/anthropic/);
    expect(() => createTts('does-not-exist')).not.toThrowError(/anthropic/);
  });
});

// ---------------------------------------------------------------------------
// .env.example — the operator-facing half of "the provider is real".
// File-content assertion: the only way to make this criterion executable.
// ---------------------------------------------------------------------------

describe('.env.example documents the new providers', () => {
  const envExample = readFileSync(
    new URL('../../.env.example', import.meta.url),
    'utf8',
  );

  it('declares ANTHROPIC_API_KEY', () => {
    expect(envExample).toMatch(/^ANTHROPIC_API_KEY=/m);
  });

  it('keeps the existing OPENAI_API_KEY and ELEVENLABS_API_KEY entries', () => {
    expect(envExample).toMatch(/^OPENAI_API_KEY=/m);
    expect(envExample).toMatch(/^ELEVENLABS_API_KEY=/m);
  });

  it('notes the ElevenLabs key scopes: speech_to_text for Scribe and user_read for billing verification', () => {
    expect(envExample).toMatch(/speech_to_text/);
    expect(envExample).toMatch(/user_read/);
  });
});
