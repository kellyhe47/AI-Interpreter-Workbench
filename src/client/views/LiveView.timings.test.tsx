/**
 * TICKET 051 — Live's per-utterance figures, measured from marks Live can
 * ACTUALLY observe, and labelled so they need no glossary.
 *
 * THE DEFECT: a completed real Arm A utterance rendered `endpointing —`,
 * `model —`, `queue —`, `total —`, `p50 —`, `p95 —`, `session $0.00`. Two
 * independent, structural causes:
 *   1. `speech_end` is NEVER stamped in Live — it is corpus ground truth and
 *      only Replay's manifest has it. Every interval anchored on it is null.
 *   2. `first_audio_delta` DOES NOT EXIST over WebRTC (ticket 040) — the
 *      model's audio arrives on the media track, so `response.output_audio
 *      .delta` never fires and `model`/`queue` are null by construction.
 *
 * THE DECISION (operator, option (c)): Live anchors on `server_speech_stopped
 * -> audio_queued` — what it can observe. Therefore:
 *   - Live renders NO `endpointing` row. Endpointing is the gap between when
 *     the human stopped and when the system decided they had; Live has no
 *     ground truth for the former, so the row could never hold a value, and a
 *     row structurally incapable of one reads as breakage forever. REMOVED,
 *     not blanked.
 *   - Arm A has NO separate `queue` row. Over WebRTC there is no observable
 *     instant between "model produced audio" and "audio queued". One
 *     observable span means ONE row.
 *   - EVERY row names the two events it spans, in plain language.
 *   - Live's headline total states its anchor, so it can never be read as
 *     Replay's end-to-end. They are different quantities.
 *
 * WHY THE SCRIPTS HERE LOOK DIFFERENT FROM sessionTestKit's: the kit's scripts
 * emit `speech_end` and `first_audio_delta`, which NO live transport emits.
 * That fiction is why the suite was green while the product was blank. These
 * scripts carry exactly the marks the real transports produce.
 */

import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FixtureScriptEvent } from '../transport/fixture';
import {
  SRC_FINAL,
  SRC_PARTIAL_1,
  TGT_FINAL,
  advance,
  audioChunk,
  clickStartMicrophone,
  makeRecord,
  renderApp,
  sessionFooter,
  stageRow,
  targetCard,
  text,
} from './sessionTestKit';

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

/** The span both architectures anchor on, in the operator's words. */
const DETECTED_END = 'detected end of speech';

/* ------------------------------------------------------------------ scripts */

interface RealtimeOpts {
  utt?: number;
  base?: number;
  /** `audio_queued − server_speech_stopped`, the ONLY observable Arm A span. */
  spanMs?: number;
  usage?: unknown;
  /**
   * Emit a `first_audio_delta` mark anyway. WebRTC never does — this is a
   * DECOY: any figure that moves when it appears is derived from a mark that
   * does not exist in production.
   */
  decoyFirstAudioDelta?: boolean;
}

/**
 * One Arm A utterance as the REAL WebRTC transport delivers it: a
 * `server_speech_stopped` mark, an `audio_queued` mark, NO `speech_end`, NO
 * `first_audio_delta`, and NO PCM (the audio rides the media track).
 */
function liveRealtimeScript(opts: RealtimeOpts = {}): FixtureScriptEvent[] {
  const utt = opts.utt ?? 0;
  const base = opts.base ?? 0;
  const span = opts.spanMs ?? 1_240;
  const stopped = base + 500;
  const queued = stopped + span;
  const events: FixtureScriptEvent[] = [
    { at: base + 10, type: 'sourceText', kind: 'partial', text: SRC_PARTIAL_1, utt },
    { at: base + 20, type: 'timing', event: 'server_speech_stopped', t: stopped, utt },
    { at: base + 30, type: 'sourceText', kind: 'final', text: SRC_FINAL, utt },
    { at: base + 40, type: 'targetText', kind: 'final', text: TGT_FINAL, utt },
  ];
  if (opts.decoyFirstAudioDelta === true) {
    events.push({ at: base + 45, type: 'timing', event: 'first_audio_delta', t: queued - 140, utt });
  }
  events.push(
    { at: base + 50, type: 'timing', event: 'audio_queued', t: queued, utt },
    { at: base + 60, type: 'utteranceComplete', record: { utt, usage: opts.usage } },
  );
  return events;
}

/** Cascade marks: NO speech_end — the server has no ground truth either. */
function cascadeMarks(base: number) {
  return {
    vad_fired: base + 500,
    stt_final: base + 810,
    mt_first_token: base + 1_030,
    tts_first_byte: base + 1_300,
    audio_queued: base + 1_510,
  };
}

/**
 * One cascade utterance as the REAL server delivers it: the marks arrive ONLY
 * on the `utterance.complete` record (`src/server/ws.ts` sends no
 * `stage.timing` message at all), so a card that reads nothing but the
 * `onTiming` stream stays blank forever.
 */
function liveCascadeScript(opts: { utt?: number; base?: number } = {}): FixtureScriptEvent[] {
  const utt = opts.utt ?? 0;
  const base = opts.base ?? 0;
  return [
    { at: base + 10, type: 'sourceText', kind: 'partial', text: SRC_PARTIAL_1, utt },
    { at: base + 30, type: 'sourceText', kind: 'final', text: SRC_FINAL, utt },
    { at: base + 40, type: 'targetText', kind: 'final', text: TGT_FINAL, utt },
    { at: base + 50, type: 'audio', pcm: audioChunk(), utt },
    {
      at: base + 60,
      type: 'utteranceComplete',
      record: makeRecord({ id: `utt-${utt}`, timings: cascadeMarks(base) }),
    },
  ];
}

/* ------------------------------------------------------------------ helpers */

function stageRowLabels(): string[] {
  return [...targetCard().querySelectorAll('[data-stage-row]')].map(
    (el) => el.getAttribute('data-stage-row') ?? '',
  );
}

function liveTotal(): HTMLElement {
  const el = targetCard().querySelector('[data-live-total]');
  if (el === null) throw new Error('expected the target card to carry [data-live-total]');
  return el as HTMLElement;
}

/* =========================================================== 1 — Arm A rows */

describe('Live · Arm A renders ONE row, from the only span WebRTC can observe', () => {
  it('one row spanning detected end of speech -> audio ready, with its figure', async () => {
    renderApp({ scripts: { realtime: liveRealtimeScript() } });
    await clickStartMicrophone();
    await advance(200);

    const card = targetCard();
    expect(card).toHaveAttribute('data-target-status', 'ready');

    // Exactly one stage row, and it is the model's.
    expect(stageRowLabels()).toEqual(['model']);

    const row = stageRow(card, 'model')!;
    // audio_queued − server_speech_stopped = 1240 ms.
    expect(text(row)).toContain('1.24 s');
    // It NAMES ITS SPAN — no glossary, no jargon standing alone.
    expect(text(row)).toContain(`${DETECTED_END} → audio ready`);
    // The opacity note is still true and still there: one model does
    // recognition, translation and voice, so no finer split is observable.
    expect(text(row)).toMatch(/opaque/i);
    expect(text(row)).not.toContain('—');
  });

  it('renders NO endpointing row and NO queue row — removed, not blanked', async () => {
    renderApp({ scripts: { realtime: liveRealtimeScript() } });
    await clickStartMicrophone();
    await advance(200);

    expect(stageRow(targetCard(), 'endpointing')).toBeNull();
    expect(stageRow(targetCard(), 'queue')).toBeNull();
    // Not anywhere in the Live surface, under any spelling.
    expect(document.body.textContent).not.toMatch(/endpointing/i);
    expect(document.body.textContent).not.toMatch(/\bqueue\b/i);
  });

  it('the figure comes from audio_queued − server_speech_stopped, NEVER first_audio_delta', async () => {
    // Same session, plus a `first_audio_delta` mark 140 ms before
    // `audio_queued`. Over WebRTC that mark never arrives; an implementation
    // that reads it would render 1.10 s (delta − stopped) or 0.14 s (queued −
    // delta) instead of the one honest span.
    renderApp({ scripts: { realtime: liveRealtimeScript({ decoyFirstAudioDelta: true }) } });
    await clickStartMicrophone();
    await advance(200);

    expect(stageRowLabels()).toEqual(['model']);
    const row = text(stageRow(targetCard(), 'model')!);
    expect(row).toContain('1.24 s');
    expect(row).not.toContain('1.10 s');
    expect(row).not.toContain('0.14 s');
    expect(text(liveTotal())).toContain('1.24 s');
  });
});

/* ========================================================= 2 — Cascade rows */

describe('Live · Cascade renders the three stages it CAN see, from real marks', () => {
  it('transcribe / translate / speak, each naming its span, each carrying a figure', async () => {
    renderApp({
      initialState: { mode: 'cascade' as const },
      scripts: { cascade: liveCascadeScript() },
    });
    await clickStartMicrophone();
    await advance(200);

    expect(stageRowLabels()).toEqual(['transcribe', 'translate', 'speak']);

    const expected: Array<[string, string, string]> = [
      // label, span, figure
      ['transcribe', `${DETECTED_END} → transcript`, '0.31 s'],
      ['translate', 'transcript → translated text', '0.22 s'],
      ['speak', 'translated text → audio ready', '0.48 s'],
    ];
    for (const [label, span, figure] of expected) {
      const row = stageRow(targetCard(), label);
      expect(row, `stage row ${label}`).not.toBeNull();
      expect(text(row!), `${label} span`).toContain(span);
      expect(text(row!), `${label} figure`).toContain(figure);
      expect(text(row!)).not.toContain('—');
    }

    // audio_queued − vad_fired = 1010 ms, and it is the sum of the three.
    expect(text(liveTotal())).toContain('1.01 s');
  });

  it('the marks are read off the completion record — the server sends no stage.timing', async () => {
    // liveCascadeScript emits ZERO `timing` events by construction; this
    // asserts that fact so the coverage above cannot be quietly satisfied by
    // an onTiming-only path that production never exercises.
    expect(liveCascadeScript().filter((e) => e.type === 'timing')).toHaveLength(0);

    renderApp({
      initialState: { mode: 'cascade' as const },
      scripts: { cascade: liveCascadeScript() },
    });
    await clickStartMicrophone();
    await advance(200);

    expect(text(stageRow(targetCard(), 'transcribe')!)).toContain('0.31 s');
  });

  it('renders NO endpointing row on cascade either', async () => {
    renderApp({
      initialState: { mode: 'cascade' as const },
      scripts: { cascade: liveCascadeScript() },
    });
    await clickStartMicrophone();
    await advance(200);

    expect(stageRow(targetCard(), 'endpointing')).toBeNull();
    expect(document.body.textContent).not.toMatch(/endpointing/i);
  });
});

/* =============================================== 3 — the headline's own name */

describe("Live's headline total is a DIFFERENT quantity from Replay's, and says so", () => {
  it('the total names its anchor and never calls itself end-to-end', async () => {
    renderApp({ scripts: { realtime: liveRealtimeScript() } });
    await clickStartMicrophone();
    await advance(200);

    const total = text(liveTotal());
    expect(total).toContain('1.24 s');
    // Replay's card labels its manifest-anchored figure `total` and nothing
    // else. Live's must state where it starts, or the two get compared as if
    // they measured the same thing.
    expect(total).toContain(DETECTED_END);
    expect(total).not.toBe('total 1.24 s');
    expect(total).not.toMatch(/end-to-end/i);
  });

  it('the session footer states the anchor too — its p50/p95 are not Replay p50/p95', async () => {
    renderApp({ scripts: { realtime: liveRealtimeScript() } });
    await clickStartMicrophone();
    await advance(200);

    expect(text(sessionFooter())).toContain(DETECTED_END);
  });
});

/* ================================================== 4 — footer p50/p95/cost */

describe('the session footer populates from real Live utterances', () => {
  it('p50 / p95 come from the new anchor across two realtime utterances', async () => {
    renderApp({
      scripts: {
        realtime: [
          ...liveRealtimeScript({ utt: 0, base: 0, spanMs: 1_240 }),
          ...liveRealtimeScript({ utt: 1, base: 2_000, spanMs: 1_500 }),
        ],
      },
    });
    await clickStartMicrophone();
    await advance(2_500);

    const footer = text(sessionFooter());
    expect(footer).toContain('2 utterances');
    // nearest-rank over [1240, 1500]: p50 = 1240, p95 = 1500.
    expect(footer).toContain('1.24 s');
    expect(footer).toContain('1.50 s');
    expect(footer).not.toMatch(/p50\s+—/);
    expect(footer).not.toMatch(/p95\s+—/);
  });

  it('a cascade Live session populates p50 from vad_fired -> audio_queued', async () => {
    renderApp({
      initialState: { mode: 'cascade' as const },
      scripts: { cascade: liveCascadeScript() },
    });
    await clickStartMicrophone();
    await advance(200);

    expect(text(sessionFooter())).toContain('1.01 s');
  });

  it('the saved LiveSession carries the same anchored latency, not null', async () => {
    let t = 0;
    const kit = renderApp({
      now: () => t,
      scripts: { realtime: liveRealtimeScript() },
    });
    await clickStartMicrophone();
    await advance(200);
    t = 60_000;
    fireEvent.click(screen.getByRole('button', { name: 'Stop session' }));
    await advance(100);

    const session = kit.ledger.getLiveSessions()[0]!;
    expect(session.latency.p50).toBe(1_240);
    expect(session.latency.p95).toBe(1_240);
  });
});

/* ============================================================== 5 — the cost */

/** OpenAI Realtime's `response.done` usage shape, trimmed to what is priced. */
function usage(inputAudioTokens: number, outputAudioTokens: number): unknown {
  return {
    input_tokens: inputAudioTokens,
    output_tokens: outputAudioTokens,
    input_token_details: { audio_tokens: inputAudioTokens, text_tokens: 0, cached_tokens: 0 },
    output_token_details: { audio_tokens: outputAudioTokens, text_tokens: 0 },
  };
}

describe('per-utterance cost is visible as the utterance completes', () => {
  /** Three utterances whose metered usage differs; costs read off the ledger. */
  async function costsOfThreeUtterances(): Promise<{ costs: number[]; footer: string }> {
    const kit = renderApp({
      scripts: {
        realtime: [
          ...liveRealtimeScript({ utt: 0, base: 0, usage: usage(1_000, 0) }),
          ...liveRealtimeScript({ utt: 1, base: 2_000, usage: usage(2_000, 0) }),
          ...liveRealtimeScript({ utt: 2, base: 4_000, usage: usage(0, 1_000) }),
        ],
      },
    });
    await clickStartMicrophone();
    await advance(4_500);
    return {
      costs: kit.ledger.getRecords().map((r) => r.costUnits),
      footer: text(sessionFooter()),
    };
  }

  it('the footer accumulates real money instead of sitting at $0.00', async () => {
    const { costs, footer } = await costsOfThreeUtterances();
    expect(costs).toHaveLength(3);
    for (const c of costs) expect(c).toBeGreaterThan(0);
    expect(footer).toMatch(/session \$\d+\.\d{2}/);
    expect(footer).not.toContain('$0.00');
  });

  it('cost is METERED, not a per-utterance constant', async () => {
    const { costs } = await costsOfThreeUtterances();
    // Twice the audio-in tokens costs exactly twice as much: a flat per
    // utterance figure, or a figure derived from wall-clock alone, fails here.
    expect(costs[1]!).toBeCloseTo(costs[0]! * 2, 8);
    // Audio OUT is published at twice the audio-in rate; the same token count
    // on the output side must therefore cost strictly more.
    expect(costs[2]!).toBeGreaterThan(costs[0]!);
  });

  it('an utterance the transport reported no usage for costs nothing (never invented)', async () => {
    const kit = renderApp({ scripts: { realtime: liveRealtimeScript({ usage: undefined }) } });
    await clickStartMicrophone();
    await advance(200);
    expect(kit.ledger.getRecords()[0]!.costUnits).toBe(0);
  });
});
