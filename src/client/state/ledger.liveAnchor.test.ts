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
 *
 * ROUND 2 (R2-1) — and the OTHER END of the interval is not one event either.
 * Cascade's `audio_queued` is re-stamped on every synthesized chunk (last chunk
 * wins), so it is time-to-LAST-audio and it grows with the length of the
 * utterance; realtime's is stamped once at `output_audio_buffer.started`, which
 * is time-to-FIRST-audio. Pooling both into one p50 compares response time
 * against playout duration. The sample therefore ends at the FIRST audio:
 * `tts_first_byte` when the record carries it, `audio_queued` otherwise.
 *
 * ROUND 2 (R2-6) — and `aggregates()` with no runId REFUSES TO MIX. Every
 * in-app caller passes a runId so nothing shipped moves, but a pool holding
 * both corpus-anchored and endpointer-anchored samples describes no single
 * quantity, and reporting a percentile over it would be inventing one.
 */

import { describe, expect, it } from 'vitest';
import { DEFAULT_CASCADE_TRIPLE } from '../../core/arms';
import type { UtteranceRecord } from '../../core/timing';
import { RunLedger, type Run } from './ledger';

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
    // GUARD — Replay's cascade marks, with no synthesis mark to end on.
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
    // R2-1 — the END is the FIRST synthesized byte, not the last queued chunk.
    // `audio_queued − vad_fired` would be 4000: 2.76 s of that is playout.
    name: 'live cascade: ends at tts_first_byte, never at the last-chunk audio_queued',
    timings: {
      vad_fired: T0 + 500,
      stt_final: T0 + 810,
      mt_first_token: T0 + 1_030,
      tts_first_byte: T0 + 1_740,
      audio_queued: T0 + 4_500,
    },
    p50: 1_240,
  },
  {
    // The two rules compose: `speech_end` still decides the START, and the
    // first synthesized byte still decides the END. This is the shape
    // `fixtureDeps.ts` emits, and the card must render the same figure (see
    // LiveView.timings.test.tsx, "a record carrying BOTH anchors").
    name: 'both anchors: speech_end starts it, tts_first_byte ends it',
    timings: {
      speech_end: T0,
      vad_fired: T0 + 500,
      tts_first_byte: T0 + 1_740,
      audio_queued: T0 + 4_500,
    },
    p50: 1_740,
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

/* ------------------------------------------------ R2-6 — refusing to mix ---- */

describe('aggregates() over the whole ledger refuses to pool two anchors', () => {
  const corpus = { speech_end: T0, audio_queued: T0 + 1_500 };
  const live = { server_speech_stopped: T0 + 500, audio_queued: T0 + 1_740 };

  it('an arm whose samples are all corpus-anchored still reports percentiles', () => {
    const ledger = new RunLedger();
    ledger.append({ ...record(corpus, 'utt-1'), runId: 'run-a' });
    ledger.append({ ...record(corpus, 'utt-2'), runId: 'run-b' });
    expect(ledger.aggregates().perArm.A!.p50Ms).toBe(1_500);
  });

  it('an arm whose samples are all endpointer-anchored still reports percentiles', () => {
    const ledger = new RunLedger();
    ledger.append({ ...record(live, 'utt-1'), runId: 'run-a' });
    ledger.append({ ...record(live, 'utt-2'), runId: 'run-b' });
    expect(ledger.aggregates().perArm.A!.p50Ms).toBe(1_240);
  });

  it('an arm holding BOTH reports no percentile — the pool describes no one quantity', () => {
    const ledger = new RunLedger();
    ledger.append({ ...record(corpus, 'utt-1'), runId: 'run-a', costUnits: 0.01 });
    ledger.append({ ...record(live, 'utt-2'), runId: 'run-b', costUnits: 0.02 });

    const agg = ledger.aggregates().perArm.A!;
    expect(agg.p50Ms).toBeNull();
    expect(agg.p95Ms).toBeNull();
    // The count and the money are still facts about the same records.
    expect(agg.count).toBe(2);
    expect(agg.costUsd).toBeCloseTo(0.03, 6);
  });

  it('GUARD: scoping to one runId is never a mixed pool, so it still answers', () => {
    const ledger = new RunLedger();
    ledger.append({ ...record(corpus, 'utt-1'), runId: 'run-a' });
    ledger.append({ ...record(live, 'utt-2'), runId: 'run-b' });
    expect(ledger.aggregates('run-a').perArm.A!.p50Ms).toBe(1_500);
    expect(ledger.aggregates('run-b').perArm.A!.p50Ms).toBe(1_240);
  });
});

/* ------------------------------- REPLAY IS UNTOUCHED, pinned at the source -- */

/**
 * `runAggregates()` — the ONLY aggregate any published Replay figure comes from
 * — keeps its own definition: `audio_queued − speech_end`, whole stop. The
 * first-audio rule above must not reach it, even for a Run that carries
 * `tts_first_byte`, or the arms comparison in the write-up silently re-bases.
 */
function replayRun(overrides: Partial<Run> = {}): Run {
  return {
    id: 'run-1',
    recordingId: 'rec-1',
    architecture: 'cascade',
    providerTriple: { ...DEFAULT_CASCADE_TRIPLE },
    modelSnapshots: { ...DEFAULT_CASCADE_TRIPLE },
    armTag: 'B',
    origin: 'sweep',
    status: 'complete',
    // TICKET 061 — a builder default beside `origin: 'sweep'`: the aggregation
    // gate requires recorded languages, and this fixture is about the LATENCY
    // ANCHOR, not about which languages a run named.
    languagePair: 'EN↔ES',
    direction: 'en→es',
    timings: {
      speech_end: T0,
      vad_fired: T0 + 500,
      tts_first_byte: T0 + 1_041,
      audio_queued: T0 + 1_053,
    },
    transcripts: { source: 'hello', target: 'hola' },
    cost: 0.02,
    errors: [],
    createdAt: T0 + 1,
    ...overrides,
  };
}

describe('GUARD: Replay figures are corpus-anchored to audio_queued, unmoved', () => {
  it('runAggregates keeps audio_queued − speech_end even when tts_first_byte exists', () => {
    const ledger = new RunLedger();
    ledger.appendRun(replayRun());
    const agg = ledger.runAggregates().perArm.B!;
    expect(agg.p50Ms).toBe(1_053);
    expect(agg.p95Ms).toBe(1_053);
    // 1041 would be the Live quantity. Replay does not use it.
    expect(agg.p50Ms).not.toBe(1_041);
  });
});
