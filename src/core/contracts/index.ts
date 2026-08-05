/**
 * Shared provider contract suites.
 *
 * TEST INFRASTRUCTURE — fully implemented (not a stub). Any provider
 * implementation (fixture or real adapter) registers against these suites:
 *
 *   describeSttContract('FixtureStt', () => new FixtureStt());
 *   describeMtContract('MyMt', () => new MyMt(), { expected: 'hola mundo' });
 *   describeTtsContract('MyTts', () => new MyTts());
 *
 * Abort semantics asserted here (pinned project-wide): on an aborted signal a
 * provider generator RETURNS promptly (clean end, no throw) and yields nothing
 * further; an already-aborted signal yields nothing at all.
 */

import { describe, expect, it } from 'vitest';
import type { MtProvider, SttEvent, SttProvider, TtsProvider } from '../types';

/** Drain an async iterable into an array. */
export async function collect<T>(iter: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const v of iter) out.push(v);
  return out;
}

/**
 * Turn-final mapping checker, exported so it is testable in isolation.
 * A well-formed turn is: zero or more 'partial' events followed by EXACTLY ONE
 * 'final' event, which must be the last event of the turn ('final' means
 * TURN-final, not segment-final).
 */
export function checkTurnFinalMapping(events: SttEvent[]): {
  ok: boolean;
  reason?: string;
} {
  const finals = events.filter((e) => e.type === 'final');
  if (finals.length === 0) {
    return { ok: false, reason: 'no TURN-final event was emitted' };
  }
  if (finals.length > 1) {
    return {
      ok: false,
      reason: `expected exactly one TURN-final event per turn, got ${finals.length}`,
    };
  }
  const last = events[events.length - 1];
  if (!last || last.type !== 'final') {
    return {
      ok: false,
      reason: 'the TURN-final event must be the last event of the turn',
    };
  }
  return { ok: true };
}

function defaultAudio(): AsyncIterable<Int16Array> {
  return (async function* () {
    yield new Int16Array(480);
    yield new Int16Array(480);
  })();
}

function textIterable(chunks: readonly string[]): AsyncIterable<string> {
  return (async function* () {
    for (const c of chunks) yield c;
  })();
}

export interface SttContractOptions {
  /** Audio for exactly one turn. Defaults to two chunks of silence. */
  makeAudio?: () => AsyncIterable<Int16Array>;
}

export function describeSttContract(
  name: string,
  factory: () => SttProvider,
  opts: SttContractOptions = {},
): void {
  const makeAudio = opts.makeAudio ?? defaultAudio;

  describe(`STT provider contract: ${name}`, () => {
    it('emits zero or more partials followed by exactly one TURN-final event', async () => {
      const events = await collect(factory().transcribe(makeAudio()));
      const verdict = checkTurnFinalMapping(events);
      expect(verdict.ok, verdict.reason).toBe(true);
      for (const e of events) {
        expect(['partial', 'final']).toContain(e.type);
        expect(typeof e.text).toBe('string');
        expect(typeof e.tStart).toBe('number');
        expect(typeof e.tEnd).toBe('number');
      }
    });

    it('yields nothing for an already-aborted signal', async () => {
      const ac = new AbortController();
      ac.abort();
      const events = await collect(
        factory().transcribe(makeAudio(), { signal: ac.signal }),
      );
      expect(events).toEqual([]);
    });

    it('ends promptly when aborted mid-stream', async () => {
      const ac = new AbortController();
      const gen = factory().transcribe(makeAudio(), { signal: ac.signal });
      const first = await gen.next();
      ac.abort();
      if (!first.done) {
        const after = await gen.next();
        expect(after.done).toBe(true);
      }
    });
  });
}

export interface MtContractOptions {
  /**
   * Source text for one translation call. Must contain at least two tokens so
   * the streaming (>=2 chunks) assertion is meaningful. Defaults to
   * 'hello world'.
   */
  sourceText?: string;
  /** If provided, the concatenated chunks must equal this exactly. */
  expected?: string;
}

export function describeMtContract(
  name: string,
  factory: () => MtProvider,
  opts: MtContractOptions = {},
): void {
  const sourceText = opts.sourceText ?? 'hello world';

  describe(`MT provider contract: ${name}`, () => {
    it('yields string chunks whose concatenation is the translation', async () => {
      const chunks = await collect(factory().translate(sourceText));
      expect(chunks.length).toBeGreaterThanOrEqual(1);
      for (const c of chunks) expect(typeof c).toBe('string');
      const joined = chunks.join('');
      expect(joined.length).toBeGreaterThan(0);
      if (opts.expected !== undefined) {
        expect(joined).toBe(opts.expected);
      }
    });

    it('honors its streaming flag (streaming: >=2 chunks; non-streaming: exactly 1)', async () => {
      const provider = factory();
      const chunks = await collect(provider.translate(sourceText));
      if (provider.streaming) {
        expect(chunks.length).toBeGreaterThanOrEqual(2);
      } else {
        expect(chunks.length).toBe(1);
      }
    });

    it('yields nothing for an already-aborted signal', async () => {
      const ac = new AbortController();
      ac.abort();
      const chunks = await collect(
        factory().translate(sourceText, { signal: ac.signal }),
      );
      expect(chunks).toEqual([]);
    });
  });
}

export interface TtsContractOptions {
  /** Streaming text input chunks. Defaults to ['hello ', 'world']. */
  textChunks?: readonly string[];
}

export function describeTtsContract(
  name: string,
  factory: () => TtsProvider,
  opts: TtsContractOptions = {},
): void {
  const textChunks = opts.textChunks ?? ['hello ', 'world'];

  describe(`TTS provider contract: ${name}`, () => {
    it('accepts an AsyncIterable<string> and yields Int16Array audio', async () => {
      const chunks = await collect(factory().synthesize(textIterable(textChunks)));
      expect(chunks.length).toBeGreaterThanOrEqual(1);
      for (const c of chunks) expect(c).toBeInstanceOf(Int16Array);
      const totalSamples = chunks.reduce((n, c) => n + c.length, 0);
      expect(totalSamples).toBeGreaterThan(0);
    });

    it('starts yielding audio before its input completes when streamingInput=true', async () => {
      const provider = factory();
      if (!provider.streamingInput) return;
      let inputCompleted = false;
      async function* input(): AsyncGenerator<string, void, void> {
        for (const t of textChunks) yield t;
        inputCompleted = true;
      }
      const gen = provider.synthesize(input());
      const first = await gen.next();
      expect(first.done).toBe(false);
      expect(first.value).toBeInstanceOf(Int16Array);
      expect(inputCompleted).toBe(false);
      // Drain the rest so the generator finishes cleanly.
      let step = await gen.next();
      while (!step.done) step = await gen.next();
    });

    it('completes without audio for empty input', async () => {
      const chunks = await collect(factory().synthesize(textIterable([])));
      expect(chunks).toEqual([]);
    });

    it('yields nothing for an already-aborted signal', async () => {
      const ac = new AbortController();
      ac.abort();
      const chunks = await collect(
        factory().synthesize(textIterable(textChunks), { signal: ac.signal }),
      );
      expect(chunks).toEqual([]);
    });
  });
}
