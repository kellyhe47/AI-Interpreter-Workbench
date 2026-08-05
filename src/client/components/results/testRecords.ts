/**
 * Ticket 013 — shared record builders for the Results-view tests.
 *
 * Test-only helper (imported by derive.test.ts and ResultsView.test.tsx).
 * All seeded numbers are chosen so the locked formatters produce exact,
 * assertable strings:
 *
 * - Benchmark run 'run-001' (2 utterances × 2 reps per arm, '#rep<n>' id
 *   suffixes):
 *     realtime        latencies [900, 1020, 1100, 1400] → p50 1020 ('1.02 s'),
 *                     p95 1400 ('1.40 s'); costUnits 0.01 × 4 over 4×3000 ms
 *                     of audio → $0.200 / min
 *     cascade-openai  latencies [700, 780, 900, 1000] → p50 780 ('0.78 s'),
 *                     p95 1000 ('1.00 s'); costUnits 0.002 × 4 → $0.040 / min
 *   Cascade is faster AND cheaper, so the p50 and cost deltas are negative
 *   → tone 'good'.
 * - Provider-swap run 'run-002': cascade-openai [800, 900] vs
 *   cascade-elevenlabs [900, 1000] (slower, pricier → tone 'bad').
 * - Stability run 'run-003-stability', coverage run 'run-004-coverage'.
 * - Fixture run: 'fixture' provider + 'placeholder' corpus → never real.
 */

import type { RunLedger } from '../../state/ledger';
import type { AnnotatedUtteranceRecord } from './derive';

/** 2026-01-05T12:00:00Z — makes ledger-row date assertions deterministic. */
export const T0 = Date.UTC(2026, 0, 5, 12, 0, 0);

type RequiredFields = Pick<AnnotatedUtteranceRecord, 'id' | 'arm' | 'runId'>;

export function makeRecord(
  overrides: Partial<AnnotatedUtteranceRecord> & RequiredFields,
): AnnotatedUtteranceRecord {
  return {
    mode: 'cascade',
    languagePair: 'EN↔ES',
    direction: 'en→es',
    sourcePartials: [],
    sourceFinal: 'buenos días',
    targetPartials: [],
    targetFinal: 'good morning',
    audioState: 'played',
    audioDurationMs: 3000,
    timings: {},
    speechEndSource: 'corpus',
    providers: { stt: 'openai', mt: 'openai', tts: 'openai' },
    costUnits: 0.002,
    corpusId: 'corpus-es-en-v1',
    ...overrides,
  };
}

export function realtimeTimings(t0: number, latencyMs: number) {
  return {
    speech_end: t0,
    server_speech_stopped: t0 + 500,
    first_audio_delta: t0 + latencyMs - 50,
    audio_queued: t0 + latencyMs,
  };
}

export function cascadeTimings(t0: number, latencyMs: number) {
  return {
    speech_end: t0,
    vad_fired: t0 + 500,
    stt_final: t0 + 540,
    mt_first_token: t0 + 580,
    tts_first_byte: t0 + 620,
    audio_queued: t0 + latencyMs,
  };
}

export const BENCHMARK_RUN_ID = 'run-001';
export const REALTIME_LATENCIES = [900, 1020, 1100, 1400] as const;
export const CASCADE_LATENCIES = [700, 780, 900, 1000] as const;

/** Track-1 run: arms 'realtime' and 'cascade-openai', 2 utterances × 2 reps. */
export function seedBenchmarkRun(ledger: RunLedger): void {
  let i = 0;
  for (const rep of [1, 2]) {
    for (const u of ['u1', 'u2']) {
      ledger.append(
        makeRecord({
          id: `rt-${u}#rep${rep}`,
          arm: 'realtime',
          mode: 'realtime',
          runId: BENCHMARK_RUN_ID,
          providers: {
            stt: 'openai-realtime',
            mt: 'openai-realtime',
            tts: 'openai-realtime',
          },
          costUnits: 0.01,
          timings: realtimeTimings(T0 + i * 10_000, REALTIME_LATENCIES[i % 4]!),
        }),
      );
      i += 1;
    }
  }
  i = 0;
  for (const rep of [1, 2]) {
    for (const u of ['u1', 'u2']) {
      ledger.append(
        makeRecord({
          id: `cas-${u}#rep${rep}`,
          arm: 'cascade-openai',
          mode: 'cascade',
          runId: BENCHMARK_RUN_ID,
          costUnits: 0.002,
          timings: cascadeTimings(T0 + 100_000 + i * 10_000, CASCADE_LATENCIES[i % 4]!),
        }),
      );
      i += 1;
    }
  }
}

export const SWAP_RUN_ID = 'run-002';

/** Track-2 run: cascade-openai vs cascade-elevenlabs, NOT pooled with run-001. */
export function seedProviderSwapRun(ledger: RunLedger): void {
  const openaiLat = [800, 900];
  const elevenLat = [900, 1000];
  for (let i = 0; i < 2; i += 1) {
    ledger.append(
      makeRecord({
        id: `sw-oa-u${i + 1}#rep1`,
        arm: 'cascade-openai',
        mode: 'cascade',
        runId: SWAP_RUN_ID,
        costUnits: 0.002,
        timings: cascadeTimings(T0 + 200_000 + i * 10_000, openaiLat[i]!),
      }),
    );
  }
  for (let i = 0; i < 2; i += 1) {
    ledger.append(
      makeRecord({
        id: `sw-el-u${i + 1}#rep1`,
        arm: 'cascade-elevenlabs',
        mode: 'cascade',
        runId: SWAP_RUN_ID,
        providers: { stt: 'openai', mt: 'openai', tts: 'elevenlabs' },
        costUnits: 0.004,
        timings: cascadeTimings(T0 + 300_000 + i * 10_000, elevenLat[i]!),
      }),
    );
  }
}

export const STABILITY_RUN_ID = 'run-003-stability';

/** Track-1-extended run: runId marks it a stability run. */
export function seedStabilityRun(ledger: RunLedger): void {
  const latencies = [1000, 1100, 1200];
  for (let i = 0; i < 3; i += 1) {
    ledger.append(
      makeRecord({
        id: `st-u${i + 1}#rep1`,
        arm: 'realtime',
        mode: 'realtime',
        runId: STABILITY_RUN_ID,
        providers: {
          stt: 'openai-realtime',
          mt: 'openai-realtime',
          tts: 'openai-realtime',
        },
        costUnits: 0.01,
        timings: realtimeTimings(T0 + 400_000 + i * 10_000, latencies[i]!),
      }),
    );
  }
}

export const COVERAGE_RUN_ID = 'run-004-coverage';

/** Track-3 run: stage-annotated observations for the coverage matrix. */
export function seedCoverageRun(ledger: RunLedger): void {
  const stages = ['intake', 'intake', 'discharge'];
  for (let i = 0; i < stages.length; i += 1) {
    ledger.append(
      makeRecord({
        id: `cov-u${i + 1}#rep1`,
        arm: 'cascade-openai',
        mode: 'cascade',
        runId: COVERAGE_RUN_ID,
        costUnits: 0.002,
        timings: cascadeTimings(T0 + 500_000 + i * 10_000, 900),
        annotations: { stage: stages[i]! },
      }),
    );
  }
}

/** Fixture/placeholder-only run — must NEVER surface in the Results view. */
export function seedFixtureRun(ledger: RunLedger): void {
  for (let i = 0; i < 3; i += 1) {
    ledger.append(
      makeRecord({
        id: `fx-u${i + 1}#rep1`,
        arm: 'cascade-openai',
        mode: 'cascade',
        runId: 'run-fx',
        providers: { stt: 'fixture', mt: 'fixture', tts: 'fixture' },
        corpusId: 'placeholder-corpus',
        costUnits: 0.14,
        timings: cascadeTimings(T0 + 600_000 + i * 10_000, 1020),
      }),
    );
  }
}
