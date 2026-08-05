import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { withRetry, withTimeout, withTiming } from './index';
import type { TimingMark } from './index';
import { FixtureMt, FixtureStt } from '../fixtures/index';
import {
  ProviderError,
  RateLimitError,
  TimeoutError,
} from '../types';
import type {
  MtProvider,
  ProviderCallOpts,
  SttProvider,
  TtsProvider,
} from '../types';

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

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('withTiming', () => {
  it('reports a 200ms call_start -> first_yield gap for a fixture with 200ms first-yield delay', async () => {
    const marks: TimingMark[] = [];
    const provider = new FixtureMt({ delayMs: 200, translation: 'hola mundo' });
    const timed = withTiming('mt', provider, (m) => marks.push(m));

    const done = collect(timed.translate('hello world'));
    done.catch(() => {});
    await vi.advanceTimersByTimeAsync(5000);
    const chunks = await done;

    expect(chunks.join('')).toBe('hola mundo');
    expect(marks.map((m) => m.event)).toEqual([
      'call_start',
      'first_yield',
      'complete',
    ]);
    expect(marks.every((m) => m.stage === 'mt')).toBe(true);

    const callStart = marks.find((m) => m.event === 'call_start');
    const firstYield = marks.find((m) => m.event === 'first_yield');
    expect(firstYield!.t - callStart!.t).toBe(200);
  });
});

describe('withTimeout', () => {
  it('throws TimeoutError for a never-yielding provider and aborts the underlying signal', async () => {
    let observedSignal: AbortSignal | undefined;
    const hang: SttProvider = {
      name: 'hang',
      // eslint-disable-next-line require-yield
      transcribe: async function* (_audio, opts?: ProviderCallOpts) {
        observedSignal = opts?.signal;
        await new Promise<never>(() => {});
      },
    };

    const wrapped = withTimeout(hang, 500);
    const gen = wrapped.transcribe(noAudio());
    const p = gen.next();
    p.catch(() => {});

    await vi.advanceTimersByTimeAsync(500);
    await expect(p).rejects.toBeInstanceOf(TimeoutError);
    expect(observedSignal).toBeDefined();
    expect(observedSignal!.aborted).toBe(true);
  });
});

describe('withRetry', () => {
  function makeFlaky(failures: number, error: () => Error) {
    let attempts = 0;
    const provider: MtProvider = {
      name: 'flaky',
      streaming: true,
      translate: async function* (_text: string) {
        attempts += 1;
        if (attempts <= failures) throw error();
        yield 'ok';
      },
    };
    return { provider, attempts: () => attempts };
  }

  it('retries on RateLimitError with backoff between attempts, succeeding on the 3rd attempt', async () => {
    const { provider, attempts } = makeFlaky(2, () => new RateLimitError());
    const wrapped = withRetry(provider, { retries: 3, backoffMs: 100 });

    const done = collect(wrapped.translate('hi'));
    done.catch(() => {});

    // First attempt happens immediately (no backoff before attempt 1).
    await vi.advanceTimersByTimeAsync(0);
    expect(attempts()).toBe(1);

    // Second attempt only after backoffMs.
    await vi.advanceTimersByTimeAsync(99);
    expect(attempts()).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(attempts()).toBe(2);

    // Third attempt after another backoffMs; succeeds.
    await vi.advanceTimersByTimeAsync(100);
    expect(attempts()).toBe(3);

    await expect(done).resolves.toEqual(['ok']);
  });

  it('does not retry non-RateLimit errors: they propagate immediately', async () => {
    const { provider, attempts } = makeFlaky(99, () => new ProviderError('boom'));
    const wrapped = withRetry(provider, { retries: 3, backoffMs: 100 });

    const done = collect(wrapped.translate('hi'));
    const err = await done.then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(ProviderError);
    expect(err).not.toBeInstanceOf(RateLimitError);
    expect(attempts()).toBe(1);
  });
});

describe('composition: withTiming(withRetry(withTimeout(fixture)))', () => {
  function compose(marks: TimingMark[]) {
    const stt = new FixtureStt({
      delayMs: 50,
      partials: ['he'],
      finalText: 'hello',
    });
    return withTiming(
      'stt',
      withRetry(withTimeout(stt, 5000), { retries: 2, backoffMs: 10 }),
      (m) => marks.push(m),
    );
  }

  it('produces correct output and timing marks through all three decorators', async () => {
    const marks: TimingMark[] = [];
    const composed = compose(marks);

    const done = collect(composed.transcribe(noAudio()));
    done.catch(() => {});
    await vi.advanceTimersByTimeAsync(1000);
    const events = await done;

    expect(events).toMatchObject([
      { type: 'partial', text: 'he' },
      { type: 'final', text: 'hello' },
    ]);
    expect(marks.map((m) => m.event)).toEqual([
      'call_start',
      'first_yield',
      'complete',
    ]);
    expect(marks.every((m) => m.stage === 'stt')).toBe(true);
    const callStart = marks.find((m) => m.event === 'call_start');
    const firstYield = marks.find((m) => m.event === 'first_yield');
    expect(firstYield!.t - callStart!.t).toBe(50);
  });

  it('propagates the caller AbortSignal through all decorators', async () => {
    const marks: TimingMark[] = [];
    const composed = compose(marks);
    const ac = new AbortController();
    const gen = composed.transcribe(noAudio(), { signal: ac.signal });

    const p1 = gen.next();
    p1.catch(() => {});
    await vi.advanceTimersByTimeAsync(50);
    const first = await p1;
    expect(first.done).toBe(false);

    const p2 = gen.next();
    p2.catch(() => {});
    ac.abort();
    await vi.advanceTimersByTimeAsync(0);
    const second = await p2;
    expect(second.done).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('interface-generic decorators', () => {
  it('work on a TTS provider (Int16Array stream) as well as STT', async () => {
    const tts: TtsProvider = {
      name: 'inline-tts',
      streamingInput: true,
      synthesize: async function* (input: AsyncIterable<string>) {
        for await (const s of input) yield new Int16Array(s.length);
      },
    };

    const marks: TimingMark[] = [];
    const wrapped = withTiming(
      'tts',
      withRetry(withTimeout(tts, 1000), { retries: 1, backoffMs: 10 }),
      (m) => marks.push(m),
    );

    const done = collect(wrapped.synthesize(textOf('ab', 'cde')));
    done.catch(() => {});
    await vi.advanceTimersByTimeAsync(100);
    const chunks = await done;

    expect(chunks).toHaveLength(2);
    expect(chunks[0]).toBeInstanceOf(Int16Array);
    expect(chunks[0]!.length).toBe(2);
    expect(chunks[1]!.length).toBe(3);
    expect(marks.map((m) => m.event)).toEqual([
      'call_start',
      'first_yield',
      'complete',
    ]);
    expect(marks.every((m) => m.stage === 'tts')).toBe(true);
  });
});
