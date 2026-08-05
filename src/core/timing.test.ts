import { describe, expect, it } from 'vitest';
import { deriveCascadeIntervals, deriveRealtimeIntervals } from './timing';
import type {
  CascadeIntervals,
  CascadeTimestamps,
  RealtimeIntervals,
  RealtimeTimestamps,
  UtteranceRecord,
} from './timing';

const fullCascade: Required<CascadeTimestamps> = {
  speech_end: 1000,
  vad_fired: 1120,
  stt_final: 1300,
  mt_first_token: 1450,
  tts_first_byte: 1700,
  audio_queued: 1800,
};

const fullRealtime: Required<RealtimeTimestamps> = {
  speech_end: 2000,
  server_speech_stopped: 2090,
  first_audio_delta: 2400,
  audio_queued: 2450,
};

const cascadeKeys = ['endpointing', 'stt', 'mt', 'tts', 'queue'] as const;
const realtimeKeys = ['endpointing', 'model', 'queue'] as const;

describe('deriveCascadeIntervals', () => {
  it('derives the 5 named intervals plus endToEnd from a full record', () => {
    const iv = deriveCascadeIntervals(fullCascade);
    expect(iv).toEqual({
      endpointing: 120,
      stt: 180,
      mt: 150,
      tts: 250,
      queue: 100,
      endToEnd: 800,
    });
    expect(Object.keys(iv).sort()).toEqual(
      ['endToEnd', 'endpointing', 'mt', 'queue', 'stt', 'tts'].sort(),
    );
  });

  it('the 5 stage intervals sum to audio_queued - speech_end (= endToEnd)', () => {
    const iv = deriveCascadeIntervals(fullCascade);
    let sum = 0;
    for (const k of cascadeKeys) {
      const v = iv[k];
      expect(v).not.toBeNull();
      sum += v as number;
    }
    expect(sum).toBe(fullCascade.audio_queued - fullCascade.speech_end);
    expect(iv.endToEnd).toBe(sum);
  });

  const missingCases: Array<{
    omit: keyof CascadeTimestamps;
    nullKeys: Array<keyof CascadeIntervals>;
  }> = [
    { omit: 'vad_fired', nullKeys: ['endpointing', 'stt'] },
    { omit: 'mt_first_token', nullKeys: ['mt', 'tts'] },
    { omit: 'audio_queued', nullKeys: ['queue', 'endToEnd'] },
  ];

  for (const { omit, nullKeys } of missingCases) {
    it(`missing ${omit}: dependent intervals are null, others computed, no throw`, () => {
      const t: CascadeTimestamps = { ...fullCascade };
      delete t[omit];
      const iv = deriveCascadeIntervals(t);
      for (const k of [...cascadeKeys, 'endToEnd'] as Array<keyof CascadeIntervals>) {
        if (nullKeys.includes(k)) {
          expect(iv[k], `${k} should be null when ${omit} is missing`).toBeNull();
        } else {
          expect(typeof iv[k], `${k} should be computed`).toBe('number');
        }
      }
    });
  }

  it('empty timestamps: all intervals null, no throw', () => {
    const iv = deriveCascadeIntervals({});
    expect(iv).toEqual({
      endpointing: null,
      stt: null,
      mt: null,
      tts: null,
      queue: null,
      endToEnd: null,
    });
  });
});

describe('deriveRealtimeIntervals', () => {
  it('derives the 3 named intervals plus endToEnd from a full record', () => {
    const iv = deriveRealtimeIntervals(fullRealtime);
    expect(iv).toEqual({
      endpointing: 90,
      model: 310,
      queue: 50,
      endToEnd: 450,
    });
    expect(Object.keys(iv).sort()).toEqual(
      ['endToEnd', 'endpointing', 'model', 'queue'].sort(),
    );
  });

  it('the 3 stage intervals sum to audio_queued - speech_end (= endToEnd)', () => {
    const iv = deriveRealtimeIntervals(fullRealtime);
    let sum = 0;
    for (const k of realtimeKeys) {
      const v = iv[k];
      expect(v).not.toBeNull();
      sum += v as number;
    }
    expect(sum).toBe(fullRealtime.audio_queued - fullRealtime.speech_end);
    expect(iv.endToEnd).toBe(sum);
  });

  it('missing server_speech_stopped: endpointing and model null, queue and endToEnd computed, no throw', () => {
    const t: RealtimeTimestamps = { ...fullRealtime };
    delete t.server_speech_stopped;
    const iv = deriveRealtimeIntervals(t);
    expect(iv.endpointing).toBeNull();
    expect(iv.model).toBeNull();
    expect(iv.queue).toBe(50);
    expect(iv.endToEnd).toBe(450);
  });

  it('empty timestamps: all intervals null, no throw', () => {
    const iv = deriveRealtimeIntervals({});
    expect(iv).toEqual({
      endpointing: null,
      model: null,
      queue: null,
      endToEnd: null,
    });
  });
});

describe('UtteranceRecord (compile-time shape lock)', () => {
  it('accepts a full cascade record and a realtime record', () => {
    const cascade = {
      id: 'utt-1',
      arm: 'cascade-baseline',
      mode: 'cascade',
      languagePair: 'en-es',
      direction: 'en->es',
      sourcePartials: ['hel', 'hello'],
      sourceFinal: 'hello world',
      targetPartials: ['hola'],
      targetFinal: 'hola mundo',
      audioState: 'played',
      audioDurationMs: 1200,
      timings: fullCascade,
      speechEndSource: 'corpus',
      providers: { stt: 'fixture', mt: 'fixture', tts: 'fixture' },
      costUnits: 3,
      corpusId: 'corpus-1',
      runId: 'run-1',
    } satisfies UtteranceRecord;

    const realtime = {
      ...cascade,
      id: 'utt-2',
      mode: 'realtime',
      timings: fullRealtime,
      speechEndSource: 'vad',
      error: 'boom',
    } satisfies UtteranceRecord;

    expect(cascade.speechEndSource).toBe('corpus');
    expect(realtime.error).toBe('boom');
  });
});

// Compile-time only: intervals types are referenced so they stay exported.
const _typeCheck: RealtimeIntervals | CascadeIntervals | null = null;
void _typeCheck;
