/**
 * TICKET 051 — the ledger's latency sample under TWO anchors.
 *
 * Replay records carry `speech_end` from the corpus manifest: the operator-
 * annotated instant the human stopped speaking. LIVE HAS NO SUCH GROUND TRUTH
 * and never will — nothing in the browser knows when the human stopped, only
 * when the endpointer DECIDED they had. Before this ticket `aggregates()`
 * derived its only latency sample as `audio_queued − speech_end`, so every
 * Live record contributed nothing and Live's footer sat at `p50 —` forever.
 *
 * The rule pinned here:
 *   speech_end present  -> audio_queued − speech_end        (REPLAY, unmoved)
 *   otherwise           -> audio_queued − <detected end of speech>
 *                          (`server_speech_stopped` for realtime,
 *                           `vad_fired` for cascade)
 *   neither             -> no sample (never 0, never invented)
 *
 * THE FIRST LINE IS A REGRESSION PIN, not a new behaviour: a record that has
 * both marks must keep answering from `speech_end`, or every experimental
 * figure in the write-up silently changes meaning.
 */

import { describe, expect, it } from 'vitest';
import type { UtteranceRecord } from '../../core/timing';
import { RunLedger } from './ledger';

const T0 = 1_700_000_000_000;

function record(timings: Record<string, number>, id = 'utt-1'): UtteranceRecord {
  return {
    id,
    arm: 'A',
    mode: 'realtime',
    languagePair: 'EN↔ES',
    direction: 'en→es',
    sourcePartials: [],
    sourceFinal: 'hello',
    targetPartials: [],
    targetFinal: 'hola',
    audioState: 'queued',
    audioDurationMs: 900,
    timings: timings as UtteranceRecord['timings'],
    speechEndSource: 'vad',
    providers: { stt: 'openai-realtime', mt: 'openai-realtime', tts: 'openai-realtime' },
    costUnits: 0,
    corpusId: 'live-mic',
    runId: 'run-1',
  };
}

function p50Of(timings: Record<string, number>): number | null {
  const ledger = new RunLedger();
  ledger.append(record(timings));
  return ledger.aggregates('run-1').perArm.A!.p50Ms;
}

interface Case {
  name: string;
  timings: Record<string, number>;
  p50: number | null;
}

const CASES: Case[] = [
  {
    // GUARD — Replay's realtime marks. `server_speech_stopped` is present here
    // too, so this case is exactly the one a naive "prefer the new anchor"
    // implementation would corrupt.
    name: 'GUARD replay realtime: speech_end wins even though the VAD mark is present',
    timings: {
      speech_end: T0,
      server_speech_stopped: T0 + 500,
      first_audio_delta: T0 + 1_600,
      audio_queued: T0 + 1_740,
    },
    p50: 1_740,
  },
  {
    // GUARD — Replay's cascade marks.
    name: 'GUARD replay cascade: speech_end wins over vad_fired',
    timings: {
      speech_end: T0,
      vad_fired: T0 + 500,
      stt_final: T0 + 810,
      audio_queued: T0 + 1_510,
    },
    p50: 1_510,
  },
  {
    name: 'live realtime: no speech_end -> audio_queued − server_speech_stopped',
    timings: { server_speech_stopped: T0 + 500, audio_queued: T0 + 1_740 },
    p50: 1_240,
  },
  {
    name: 'live cascade: no speech_end -> audio_queued − vad_fired',
    timings: {
      vad_fired: T0 + 500,
      stt_final: T0 + 810,
      mt_first_token: T0 + 1_030,
      audio_queued: T0 + 1_510,
    },
    p50: 1_010,
  },
  {
    // `first_audio_delta` DOES NOT EXIST over WebRTC (ticket 040). A record
    // carrying only it must not be rescued by it — that would put a figure on
    // screen for a transport that cannot produce one.
    name: 'no anchor at all -> no sample (never 0, never invented)',
    timings: { first_audio_delta: T0 + 1_600, audio_queued: T0 + 1_740 },
    p50: null,
  },
];

describe('RunLedger.aggregates — the latency anchor', () => {
  it.each(CASES)('$name', ({ timings, p50 }) => {
    expect(p50Of(timings)).toBe(p50);
  });

  it('a live-anchored record still contributes its cost and its count', () => {
    const ledger = new RunLedger();
    ledger.append({
      ...record({ server_speech_stopped: T0 + 500, audio_queued: T0 + 1_740 }),
      costUnits: 0.03,
    });
    const agg = ledger.aggregates('run-1').perArm.A!;
    expect(agg.count).toBe(1);
    expect(agg.costUsd).toBeCloseTo(0.03, 6);
    expect(agg.p95Ms).toBe(1_240);
  });
});
