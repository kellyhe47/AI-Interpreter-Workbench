/**
 * TICKET 051 ROUND 2 (R2-2) — the anchor fix must not stop at LiveView.
 *
 * `deriveLiveModel` reads `u.timings?.speech_end`, which Live NEVER has (option
 * (c) deliberately never stamps it). So `samples` was always empty and the
 * column fell through to `meanOf(sessions.map(s => s.latency.p50))` — a MEAN OF
 * PER-SESSION p50s, which is not a percentile of anything. Before this ticket
 * that path produced `null` and the card was blank, so nothing showed. Now
 * `saveLiveSession` writes real numbers, and Results begins publishing an
 * endpointer-anchored figure, computed by the wrong statistic, immediately
 * beside Replay's corpus-anchored p50 — the exact confusion this ticket exists
 * to prevent, one file over.
 *
 * Both directions were vacuous against the round-1 code: forcing the fallback
 * left the suite green, and switching to the anchored rule ALSO left it green.
 * These fixtures make the two answers differ by construction:
 *
 *   session 1 utterances  1000 / 1200 / 5000     (its own reported p50: 1200)
 *   session 2 utterance   1100                   (its own reported p50: 1100)
 *   POOLED nearest-rank   p50 1100 · p95 5000
 *   mean of the p50s      1150                   <- the wrong statistic
 *
 * The same rule as everywhere else in 051: the sample runs from the detected
 * end of speech to the FIRST audio.
 */

import { describe, expect, it } from 'vitest';
import { REALTIME_MODEL } from '../../../core/arms';
import { RunLedger } from '../../state/ledger';
import { deriveLiveModel } from './derive';
import { ARM_B_TRIPLE, makeLiveSessionEntity } from './testRecords';

type Marks = Record<string, number | null>;

function utterance(id: string, timings: Marks) {
  return { id, timings, costUsd: 0.01 };
}

/** Arm A marks: the endpointer's decision, then the first audio. */
function realtimeMarks(latencyMs: number): Marks {
  return { server_speech_stopped: 500, audio_queued: 500 + latencyMs };
}

/**
 * Arm B marks. `audio_queued` trails `tts_first_byte` by 2 600 ms — that tail
 * is playout of a long sentence, and pooling it against Arm A's
 * time-to-first-audio is what makes cascade look several times slower.
 */
function cascadeMarks(latencyMs: number): Marks {
  return {
    vad_fired: 500,
    stt_final: 700,
    mt_first_token: 900,
    tts_first_byte: 500 + latencyMs,
    audio_queued: 500 + latencyMs + 2_600,
  };
}

function realtimeSession(id: string, latencies: number[], reported: { p50: number; p95: number }) {
  return makeLiveSessionEntity({
    id,
    architecture: 'realtime',
    providerTriple: undefined,
    modelSnapshots: { realtime: REALTIME_MODEL },
    utterances: latencies.map((ms, i) => utterance(`${id}-u${i + 1}`, realtimeMarks(ms))),
    latency: { p50: reported.p50, p95: reported.p95, driftMinute1ToEnd: null },
    stability: {
      utterancesCompleted: latencies.length,
      disconnects: 0,
      heapStart: null,
      heapEnd: null,
    },
  });
}

function cascadeSession(id: string, latencies: number[], reported: { p50: number; p95: number }) {
  return makeLiveSessionEntity({
    id,
    architecture: 'cascade',
    providerTriple: { ...ARM_B_TRIPLE },
    modelSnapshots: { ...ARM_B_TRIPLE },
    utterances: latencies.map((ms, i) => utterance(`${id}-u${i + 1}`, cascadeMarks(ms))),
    latency: { p50: reported.p50, p95: reported.p95, driftMinute1ToEnd: null },
    stability: {
      utterancesCompleted: latencies.length,
      disconnects: 0,
      heapStart: null,
      heapEnd: null,
    },
  });
}

function columnFor(ledger: RunLedger, arm: 'A' | 'B') {
  const model = deriveLiveModel(ledger);
  const column = model.columns.find((c) => c.arm === arm);
  expect(column, `expected a column for arm ${arm}`).toBeDefined();
  return column!;
}

describe('deriveLiveModel — the statistic', () => {
  it('pools the utterances of every session and takes a nearest-rank percentile', () => {
    const ledger = new RunLedger();
    ledger.appendLiveSession(realtimeSession('live-a1', [1_000, 1_200, 5_000], { p50: 1_200, p95: 5_000 }));
    ledger.appendLiveSession(realtimeSession('live-a2', [1_100], { p50: 1_100, p95: 1_100 }));

    const a = columnFor(ledger, 'A');
    expect(a.sessions).toBe(2);
    // nearest rank over [1000, 1100, 1200, 5000].
    expect(a.p50Ms).toBe(1_100);
    expect(a.p95Ms).toBe(5_000);
    // The mean of the two sessions' own p50s. A session-weighted average lets
    // a one-utterance take count as much as a fifty-utterance one.
    expect(a.p50Ms).not.toBe(1_150);
  });

  it('reads the SAME anchor the rest of the ticket does — detected end of speech', () => {
    const ledger = new RunLedger();
    // The reported p50 is deliberately a number the utterances cannot produce,
    // so a column that still answers 9999 is reading the wrong field.
    ledger.appendLiveSession(realtimeSession('live-a1', [1_240], { p50: 9_999, p95: 9_999 }));

    expect(columnFor(ledger, 'A').p50Ms).toBe(1_240);
  });

  it('ends the cascade sample at the FIRST audio, so the two arms are comparable', () => {
    const ledger = new RunLedger();
    ledger.appendLiveSession(realtimeSession('live-a1', [1_240], { p50: 1_240, p95: 1_240 }));
    ledger.appendLiveSession(cascadeSession('live-b1', [1_240], { p50: 3_840, p95: 3_840 }));

    // Identical time-to-first-audio must read as identical latency.
    expect(columnFor(ledger, 'A').p50Ms).toBe(1_240);
    expect(columnFor(ledger, 'B').p50Ms).toBe(1_240);
    // audio_queued − vad_fired would be 3840 for the cascade column: mostly
    // playout duration of a longer utterance.
    expect(columnFor(ledger, 'B').p50Ms).not.toBe(3_840);
  });

  it('refuses to average per-session p50s when no utterance carries usable marks', () => {
    const ledger = new RunLedger();
    ledger.appendLiveSession(
      makeLiveSessionEntity({
        id: 'live-unmeasurable',
        utterances: [utterance('u-1', {}), utterance('u-2', { audio_queued: 900 })],
        latency: { p50: 900, p95: 900, driftMinute1ToEnd: null },
        stability: { utterancesCompleted: 2, disconnects: 0, heapStart: null, heapEnd: null },
      }),
    );

    const b = columnFor(ledger, 'B');
    // A session's self-reported summary is not a measurement of the utterances
    // it carries, and a percentile computed from no samples is not a figure.
    expect(b.p50Ms).toBeNull();
    expect(b.p95Ms).toBeNull();
    // The session is still counted — it happened.
    expect(b.sessions).toBe(1);
    expect(b.utterancesCompleted).toBe(2);
  });

  it('GUARD: a corpus-anchored session (speech_end present) still answers from speech_end', () => {
    const ledger = new RunLedger();
    ledger.appendLiveSession(
      makeLiveSessionEntity({
        id: 'live-corpus',
        utterances: [
          utterance('u-1', { speech_end: 0, vad_fired: 500, audio_queued: 1_053 }),
        ],
        latency: { p50: 1_053, p95: 1_053, driftMinute1ToEnd: null },
        stability: { utterancesCompleted: 1, disconnects: 0, heapStart: null, heapEnd: null },
      }),
    );

    expect(columnFor(ledger, 'B').p50Ms).toBe(1_053);
  });
});
