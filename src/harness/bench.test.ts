/**
 * Integration: runFixtureBench against a REAL in-process createAppServer
 * (real ws transport, fixture providers). No network beyond loopback,
 * no files written.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Server } from 'node:http';
import { isRealRecord } from '../client/state/ledger';
import type { CascadeTimestamps } from '../core/timing';
import { SAMPLE_RATE } from '../core/protocol';
import { createAppServer } from '../server/index';
import { runFixtureBench } from './bench';
import { generateClip } from './wav';

const FIXTURE_PROVIDERS = { stt: 'fixture', mt: 'fixture', tts: 'fixture' };

describe('runFixtureBench (in-process integration)', () => {
  let server: Server;

  beforeAll(async () => {
    server = createAppServer();
    await new Promise<void>((resolve) => server.listen(0, () => resolve()));
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) =>
      server.close((err) => (err ? reject(err) : resolve())),
    );
  });

  it(
    'produces one corpus-sourced, ledger-excluded record per clip',
    async () => {
      const clips = [
        {
          id: 'bench-a',
          samples: generateClip({ durationMs: 400, speechMs: 200, freq: 440, rate: SAMPLE_RATE }),
          speechEndMs: 200,
        },
        {
          id: 'bench-b',
          samples: generateClip({ durationMs: 300, speechMs: 150, freq: 660, rate: SAMPLE_RATE }),
          speechEndMs: 150,
        },
      ];

      const t0 = Date.now();
      const records = await runFixtureBench({
        server,
        clips,
        providers: FIXTURE_PROVIDERS,
        corpusId: 'placeholder-v0',
      });
      const t1 = Date.now();

      expect(records).toHaveLength(2);

      for (let i = 0; i < records.length; i++) {
        const record = records[i]!;
        const clip = clips[i]!;
        // Real pipeline output made it through the real ws transport.
        expect(record.sourceFinal.length).toBeGreaterThan(0);
        expect(record.targetFinal.length).toBeGreaterThan(0);
        expect(record.mode).toBe('cascade');
        expect(record.providers).toEqual(FIXTURE_PROVIDERS);

        // The harness client actually collected downstream TTS audio.
        expect(record.audioChunkCount).toBeGreaterThanOrEqual(1);

        // Stage timings are present and causally ordered.
        const t = record.timings as CascadeTimestamps;
        expect(t.stt_final).toBeTypeOf('number');
        expect(t.mt_first_token).toBeTypeOf('number');
        expect(t.tts_first_byte).toBeTypeOf('number');
        expect(t.stt_final!).toBeLessThanOrEqual(t.mt_first_token!);
        expect(t.mt_first_token!).toBeLessThanOrEqual(t.tts_first_byte!);

        // Corpus augmentation: speech_end = clip start + ground-truth
        // speechEndMs on the harness clock. Clip start lies in [t0, t1], so
        // speech_end lies in [t0 + speechEndMs, t1 + speechEndMs] regardless
        // of streaming pacing.
        expect(record.speechEndSource).toBe('corpus');
        expect(record.corpusId).toBe('placeholder-v0');
        expect(t.speech_end).toBeTypeOf('number');
        expect(t.speech_end!).toBeGreaterThanOrEqual(t0 + clip.speechEndMs);
        expect(t.speech_end!).toBeLessThanOrEqual(t1 + clip.speechEndMs);

        // PRD fixtures-never-report rule: the ledger must exclude this record.
        expect(isRealRecord(record)).toBe(false);
      }
    },
    20000,
  );
});
