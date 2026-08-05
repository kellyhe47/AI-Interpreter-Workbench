/**
 * TDD tests for the cascade orchestrator (Ticket 004).
 * These encode the contract documented in ./orchestrator.ts — the stub throws
 * 'not implemented', so every test here starts RED.
 */
import { describe, expect, it } from 'vitest';
import { FixtureMt, FixtureStt, FixtureTts } from '../../core/fixtures/index';
import type {
  MtProvider,
  ProviderCallOpts,
  SttEvent,
  SttProvider,
  TtsProvider,
} from '../../core/types';
import { ProviderError, TimeoutError } from '../../core/types';
import type { CascadeTimestamps } from '../../core/timing';
import { buildPipeline, runCascade } from './orchestrator';
import type { CascadeEvent, CascadeProviders } from './orchestrator';

/** Audio source of n chunks. With FixtureStt, n chunks == n turns. */
function chunks(n: number, samples = 480): AsyncIterable<Int16Array> {
  return (async function* () {
    for (let i = 0; i < n; i += 1) yield new Int16Array(samples);
  })();
}

async function collect(gen: AsyncIterable<CascadeEvent>): Promise<CascadeEvent[]> {
  const out: CascadeEvent[] = [];
  for await (const e of gen) out.push(e);
  return out;
}

function fixtureProviders(overrides?: Partial<CascadeProviders>): CascadeProviders {
  return {
    stt: new FixtureStt({ partials: ['hel', 'hello'], finalText: 'hello world' }),
    mt: new FixtureMt({ translation: 'hola mundo' }),
    tts: new FixtureTts({ samplesPerChar: 4 }),
    ...overrides,
  };
}

function ofType<T extends CascadeEvent['type']>(
  events: CascadeEvent[],
  type: T,
): Extract<CascadeEvent, { type: T }>[] {
  return events.filter((e) => e.type === type) as Extract<CascadeEvent, { type: T }>[];
}

describe('runCascade', () => {
  it('AC1: 2 turn-finals -> exactly 2 complete utterances with texts, audio, ordered timings', async () => {
    const events = await collect(runCascade(chunks(2), fixtureProviders()));

    const completes = ofType(events, 'utterance.complete');
    expect(completes).toHaveLength(2);
    expect(completes.map((c) => c.utt)).toEqual([0, 1]);

    for (const c of completes) {
      expect(c.record.sourceFinal).toBe('hello world');
      expect(c.record.targetFinal).toBe('hola mundo');
      expect(c.record.mode).toBe('cascade');
      expect(c.record.sourcePartials).toEqual(['hel', 'hello']);

      const audio = ofType(events, 'tts.audio').filter((a) => a.utt === c.utt);
      expect(audio.length).toBeGreaterThanOrEqual(1);

      const t = c.record.timings as CascadeTimestamps;
      expect(t.stt_final).toBeTypeOf('number');
      expect(t.mt_first_token).toBeTypeOf('number');
      expect(t.tts_first_byte).toBeTypeOf('number');
      expect(t.stt_final!).toBeLessThanOrEqual(t.mt_first_token!);
      expect(t.mt_first_token!).toBeLessThanOrEqual(t.tts_first_byte!);
    }
  });

  it('AC2: streaming bridge — first TTS audio is emitted BEFORE the last MT token', async () => {
    const providers = fixtureProviders({
      mt: new FixtureMt({ translation: 'hola mundo', delayMs: 40 }),
      tts: new FixtureTts({ samplesPerChar: 4 }),
    });
    const events = await collect(runCascade(chunks(1), providers));

    const deltas = ofType(events, 'mt.delta');
    expect(deltas.length).toBeGreaterThanOrEqual(2);
    const firstAudioIdx = events.findIndex((e) => e.type === 'tts.audio');
    const lastDeltaIdx = events.lastIndexOf(deltas[deltas.length - 1]!);
    expect(firstAudioIdx).toBeGreaterThanOrEqual(0);
    expect(firstAudioIdx).toBeLessThan(lastDeltaIdx);
  });

  it('AC3: MT timeout fault -> exact error copy, stage mt, and the next turn still completes', async () => {
    let call = 0;
    const flakyMt: MtProvider = {
      name: 'flaky-mt',
      streaming: true,
      // First call: TimeoutError. Second call: normal translation.
      async *translate(_text: string, _opts?: ProviderCallOpts) {
        call += 1;
        if (call === 1) throw new TimeoutError('mt fixture timed out');
        yield 'hola ';
        yield 'mundo';
      },
    };
    const events = await collect(runCascade(chunks(2), fixtureProviders({ mt: flakyMt })));

    const errors = ofType(events, 'error');
    expect(errors).toHaveLength(1);
    expect(errors[0]!.stage).toBe('mt');
    expect(errors[0]!.utt).toBe(0);
    expect(errors[0]!.message).toBe(
      'mt stage timed out for this utterance — session still running',
    );

    // utterance 0 is abandoned, utterance 1 completes
    const completes = ofType(events, 'utterance.complete');
    expect(completes).toHaveLength(1);
    expect(completes[0]!.utt).toBe(1);
    expect(completes[0]!.record.targetFinal).toBe('hola mundo');
    expect(ofType(events, 'tts.audio').every((a) => a.utt === 1)).toBe(true);
  });

  it('AC3b: non-timeout stage failure uses the "failed" copy', async () => {
    const brokenMt: MtProvider = {
      name: 'broken-mt',
      streaming: true,
      // eslint-disable-next-line require-yield
      async *translate(): AsyncGenerator<string, void, void> {
        throw new ProviderError('kaboom');
      },
    };
    const events = await collect(runCascade(chunks(1), fixtureProviders({ mt: brokenMt })));
    const errors = ofType(events, 'error');
    expect(errors).toHaveLength(1);
    expect(errors[0]!.message).toBe(
      'mt stage failed for this utterance — session still running',
    );
    expect(ofType(events, 'utterance.complete')).toHaveLength(0);
  });

  it('AC4: abort mid-MT -> no target-final/audio after abort; stage generators closed', async () => {
    let mtClosed = false;
    let ttsClosed = false;

    const hangingMt: MtProvider = {
      name: 'hanging-mt',
      streaming: true,
      async *translate(_text: string, opts?: ProviderCallOpts) {
        try {
          yield 'hola ';
          // Hang until aborted, then return cleanly (project abort semantics).
          await new Promise<void>((resolve) => {
            const signal = opts?.signal;
            if (!signal) return; // no signal: hang forever (test would time out)
            if (signal.aborted) return resolve();
            signal.addEventListener('abort', () => resolve(), { once: true });
          });
        } finally {
          mtClosed = true;
        }
      },
    };
    const silentTts: TtsProvider = {
      name: 'silent-tts',
      streamingInput: true,
      // Consumes its input but never yields audio; closes on abort/teardown.
      async *synthesize(text: AsyncIterable<string>, _opts?: ProviderCallOpts) {
        try {
          for await (const _chunk of text) {
            void _chunk;
          }
        } finally {
          ttsClosed = true;
        }
      },
    };

    const ac = new AbortController();
    const events: CascadeEvent[] = [];
    for await (const e of runCascade(
      chunks(1),
      fixtureProviders({ mt: hangingMt, tts: silentTts }),
      { signal: ac.signal },
    )) {
      events.push(e);
      if (e.type === 'mt.delta') ac.abort(); // abort mid-MT
    }

    // Stream ended cleanly after abort; nothing completed.
    expect(ofType(events, 'mt.final')).toHaveLength(0);
    expect(ofType(events, 'tts.audio')).toHaveLength(0);
    expect(ofType(events, 'utterance.complete')).toHaveLength(0);

    // Generators were torn down (finally blocks ran).
    await new Promise((r) => setTimeout(r, 20));
    expect(mtClosed).toBe(true);
    expect(ttsClosed).toBe(true);
  });

  it('AC5: empty STT turn is skipped without crashing; session continues', async () => {
    let call = 0;
    const sometimesEmptyStt: SttProvider = {
      name: 'sometimes-empty-stt',
      async *transcribe(
        _audio: AsyncIterable<Int16Array>,
        _opts?: ProviderCallOpts,
      ): AsyncGenerator<SttEvent, void, void> {
        call += 1;
        if (call === 1) return; // empty turn: no partials, no final
        yield { type: 'partial', text: 'hel', tStart: 0, tEnd: 1 };
        yield { type: 'final', text: 'hello world', tStart: 0, tEnd: 2 };
      },
    };
    const events = await collect(
      runCascade(chunks(2), fixtureProviders({ stt: sometimesEmptyStt })),
    );

    expect(ofType(events, 'error')).toHaveLength(0);
    const completes = ofType(events, 'utterance.complete');
    expect(completes).toHaveLength(1);
    // Empty turns consume no utt number.
    expect(completes[0]!.utt).toBe(0);
    expect(completes[0]!.record.sourceFinal).toBe('hello world');
  });

  it('AC5b: all-empty STT (fixture failWith empty) -> no events, clean end', async () => {
    const events = await collect(
      runCascade(chunks(2), fixtureProviders({ stt: new FixtureStt({ failWith: 'empty' }) })),
    );
    expect(events).toHaveLength(0);
  });

  it('AC6: source partials are forwarded before the source final', async () => {
    const events = await collect(runCascade(chunks(1), fixtureProviders()));
    const partialIdxs = events
      .map((e, i) => (e.type === 'stt.partial' ? i : -1))
      .filter((i) => i >= 0);
    const finalIdx = events.findIndex((e) => e.type === 'stt.final');
    expect(partialIdxs).toHaveLength(2);
    expect(finalIdx).toBeGreaterThanOrEqual(0);
    for (const i of partialIdxs) expect(i).toBeLessThan(finalIdx);
    expect(
      ofType(events, 'stt.partial').map((p) => p.text),
    ).toEqual(['hel', 'hello']);
  });
});

describe('buildPipeline', () => {
  it('composes registry providers and feeds timing marks through the sink', async () => {
    const pipeline = buildPipeline({
      providers: { stt: 'fixture', mt: 'fixture', tts: 'fixture' },
      providerOptions: { mt: { translation: 'hola mundo' } },
    });

    expect(pipeline.marks).toEqual([]);

    // Drain one MT call through the decorated provider.
    let out = '';
    for await (const tok of pipeline.providers.mt.translate('hello world')) out += tok;
    expect(out).toBe('hola mundo');

    const mtMarks = pipeline.marks.filter((m) => m.stage === 'mt');
    expect(mtMarks.map((m) => m.event)).toEqual(['call_start', 'first_yield', 'complete']);
  });

  it('runs end-to-end with runCascade producing complete utterances', async () => {
    const pipeline = buildPipeline({
      providers: { stt: 'fixture', mt: 'fixture', tts: 'fixture' },
    });
    const events = await collect(runCascade(chunks(1), pipeline.providers));
    expect(ofType(events, 'utterance.complete')).toHaveLength(1);
    // withTiming saw all three stages.
    const stages = new Set(pipeline.marks.map((m) => m.stage));
    expect(stages).toEqual(new Set(['stt', 'mt', 'tts']));
  });

  it('propagates the registry error for unknown provider names', () => {
    expect(() =>
      buildPipeline({ providers: { stt: 'nope', mt: 'fixture', tts: 'fixture' } }),
    ).toThrow(/nope/);
  });
});
