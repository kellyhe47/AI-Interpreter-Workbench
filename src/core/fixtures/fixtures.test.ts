import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FixtureMt, FixtureStt, FixtureTts } from './index';
import type { FixtureFault } from './index';
import { ProviderError, RateLimitError } from '../types';

async function collect<T>(iter: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const v of iter) out.push(v);
  return out;
}

function noAudio(): AsyncIterable<Int16Array> {
  return (async function* () {})();
}

function textOf(...chunks: string[]): AsyncIterable<string> {
  return (async function* () {
    for (const c of chunks) yield c;
  })();
}

describe('FixtureStt', () => {
  it('emits at least one partial then exactly one TURN-final per utterance, in order', async () => {
    const stt = new FixtureStt({
      partials: ['hel', 'hello'],
      finalText: 'hello world',
    });
    const events = await collect(stt.transcribe(noAudio()));

    const partials = events.filter((e) => e.type === 'partial');
    const finals = events.filter((e) => e.type === 'final');
    expect(partials.length).toBeGreaterThanOrEqual(1);
    expect(partials.map((p) => p.text)).toEqual(['hel', 'hello']);
    expect(finals).toHaveLength(1);
    // The final is the last event of the turn.
    expect(events.at(-1)).toMatchObject({ type: 'final', text: 'hello world' });
    for (const e of events) {
      expect(typeof e.tStart).toBe('number');
      expect(typeof e.tEnd).toBe('number');
    }
  });

  it('emits usable defaults when constructed with no options', async () => {
    const events = await collect(new FixtureStt().transcribe(noAudio()));
    expect(events.filter((e) => e.type === 'partial').length).toBeGreaterThanOrEqual(1);
    expect(events.filter((e) => e.type === 'final')).toHaveLength(1);
  });
});

describe('FixtureMt', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('with delayMs yields >=2 token chunks over time whose concatenation equals the canned text', async () => {
    const mt = new FixtureMt({ delayMs: 50, translation: 'hola mundo' });
    expect(mt.streaming).toBe(true);

    const seen: Array<{ text: string; t: number }> = [];
    const done = (async () => {
      for await (const chunk of mt.translate('hello world')) {
        seen.push({ text: chunk, t: Date.now() });
      }
    })();
    done.catch(() => {});

    await vi.advanceTimersByTimeAsync(5000);
    await done;

    expect(seen.length).toBeGreaterThanOrEqual(2);
    expect(seen.map((s) => s.text).join('')).toBe('hola mundo');
    // Chunks arrive over time, not all in one tick.
    expect(new Set(seen.map((s) => s.t)).size).toBeGreaterThanOrEqual(2);
  });
});

describe('FixtureTts', () => {
  it('starts yielding Int16Array audio before its text input iterable completes', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let inputCompleted = false;

    async function* text(): AsyncGenerator<string, void, void> {
      yield 'hello ';
      await gate;
      yield 'world';
      inputCompleted = true;
    }

    const tts = new FixtureTts();
    expect(tts.streamingInput).toBe(true);
    const gen = tts.synthesize(text());

    const first = await gen.next();
    expect(first.done).toBe(false);
    expect(first.value).toBeInstanceOf(Int16Array);
    // First audio arrived while the input iterable was still open.
    expect(inputCompleted).toBe(false);

    release();
    const rest = await collect(gen);
    const total =
      (first.value as Int16Array).length + rest.reduce((n, c) => n + c.length, 0);
    expect(total).toBeGreaterThan(0);
    for (const c of rest) expect(c).toBeInstanceOf(Int16Array);
  });
});

describe('abort mid-stream (each fixture)', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  const cases: Array<{
    name: string;
    start: (signal: AbortSignal) => AsyncGenerator<unknown, void, void>;
  }> = [
    {
      name: 'FixtureStt',
      start: (signal) =>
        new FixtureStt({
          delayMs: 100,
          partials: ['a', 'ab'],
          finalText: 'abc',
        }).transcribe(noAudio(), { signal }),
    },
    {
      name: 'FixtureMt',
      start: (signal) =>
        new FixtureMt({ delayMs: 100, translation: 'uno dos tres' }).translate(
          'one two three',
          { signal },
        ),
    },
    {
      name: 'FixtureTts',
      start: (signal) =>
        new FixtureTts({ delayMs: 100 }).synthesize(
          textOf('hello ', 'big ', 'world'),
          { signal },
        ),
    },
  ];

  for (const { name, start } of cases) {
    it(`${name}: generator returns promptly, no timer leaks, no further yields`, async () => {
      const ac = new AbortController();
      const gen = start(ac.signal);

      const p1 = gen.next();
      p1.catch(() => {});
      await vi.advanceTimersByTimeAsync(100);
      const first = await p1;
      expect(first.done).toBe(false);

      const p2 = gen.next();
      p2.catch(() => {});
      ac.abort();
      await vi.advanceTimersByTimeAsync(0);
      const second = await p2;
      expect(second.done).toBe(true);

      // No further yields ever.
      const third = await gen.next();
      expect(third.done).toBe(true);
      // No timer leaks.
      expect(vi.getTimerCount()).toBe(0);
    });
  }
});

describe('fault injection (each fixture)', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  const starters: Array<{
    name: string;
    start: (
      fault: FixtureFault,
      signal?: AbortSignal,
    ) => AsyncGenerator<unknown, void, void>;
  }> = [
    {
      name: 'FixtureStt',
      start: (fault, signal) =>
        new FixtureStt({ failWith: fault }).transcribe(noAudio(), { signal }),
    },
    {
      name: 'FixtureMt',
      start: (fault, signal) =>
        new FixtureMt({ failWith: fault }).translate('hello', { signal }),
    },
    {
      name: 'FixtureTts',
      start: (fault, signal) =>
        new FixtureTts({ failWith: fault }).synthesize(textOf('hello'), {
          signal,
        }),
    },
  ];

  for (const { name, start } of starters) {
    it(`${name} failWith:'timeout' hangs until aborted`, async () => {
      const ac = new AbortController();
      const gen = start('timeout', ac.signal);

      let settled = false;
      const p = gen.next().finally(() => {
        settled = true;
      });
      p.catch(() => {});

      await vi.advanceTimersByTimeAsync(60_000);
      expect(settled).toBe(false);

      ac.abort();
      await vi.advanceTimersByTimeAsync(0);
      const result = await p;
      expect(result.done).toBe(true);
      expect(vi.getTimerCount()).toBe(0);
    });

    it(`${name} failWith:'rate-limit' throws RateLimitError with status 429`, async () => {
      const err = await collect(start('rate-limit')).then(
        () => null,
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(RateLimitError);
      expect(err).toBeInstanceOf(ProviderError);
      expect((err as RateLimitError).status).toBe(429);
    });

    it(`${name} failWith:'empty' completes with no output`, async () => {
      await expect(collect(start('empty'))).resolves.toEqual([]);
    });

    it(`${name} failWith:'error' throws ProviderError`, async () => {
      const err = await collect(start('error')).then(
        () => null,
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(ProviderError);
      expect(err).not.toBeInstanceOf(RateLimitError);
    });
  }
});
