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
/** ...and the instant both architectures END on. See section 2b. */
const FIRST_AUDIO = 'audio starts';

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

/**
 * Cascade marks: NO speech_end — the server has no ground truth either.
 *
 * ROUND 2 — the gap between `tts_first_byte` and `audio_queued` is DELIBERATELY
 * enormous here (2.76 s). Cascade's `audio_queued` is re-stamped on every TTS
 * chunk (`orchestrator.ts:309`, "last chunk wins"), so it is the moment the
 * LAST byte of synthesis was queued and it grows with the length of the
 * utterance. Arm A's `audio_queued` comes from `output_audio_buffer.started` —
 * the FIRST audio. Anything that renders the two under one label is comparing
 * time-to-first-audio against time-to-last-audio, and the wider this gap is the
 * louder such an implementation fails.
 *
 *   transcribe  810 − 500  = 310 ms
 *   translate  1030 − 810  = 220 ms
 *   synthesize 1740 − 1030 = 710 ms   <- ends at the FIRST synthesized byte
 *   deliver    4500 − 1740 = 2760 ms  <- real information, never the headline
 *   HEADLINE   1740 − 500  = 1240 ms  == Arm A's headline, by construction
 */
function cascadeMarks(base: number) {
  return {
    vad_fired: base + 500,
    stt_final: base + 810,
    mt_first_token: base + 1_030,
    tts_first_byte: base + 1_740,
    audio_queued: base + 4_500,
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

/** Start a Live session of one architecture and run it to `ready`. */
async function runOneUtterance(
  mode: 'realtime' | 'cascade',
  script: FixtureScriptEvent[],
): Promise<void> {
  renderApp({ initialState: { mode }, scripts: { [mode]: script } });
  await clickStartMicrophone();
  await advance(200);
}

/* =========================================================== 1 — Arm A rows */

describe('Live · Arm A renders ONE row, from the only span WebRTC can observe', () => {
  it('one row spanning detected end of speech -> audio starts, with its figure', async () => {
    renderApp({ scripts: { realtime: liveRealtimeScript() } });
    await clickStartMicrophone();
    await advance(200);

    const card = targetCard();
    expect(card).toHaveAttribute('data-target-status', 'ready');

    // Exactly one stage row, and it is the model's.
    expect(stageRowLabels()).toEqual(['model']);

    const row = stageRow(card, 'model')!;
    // audio_queued − server_speech_stopped = 1240 ms. Arm A's `audio_queued`
    // is stamped ONCE from `output_audio_buffer.started` (realtime.ts:599), so
    // this is time-to-FIRST-audio — which is what the span must say.
    expect(text(row)).toContain('1.24 s');
    // It NAMES ITS SPAN — no glossary, no jargon standing alone.
    expect(text(row)).toContain(`${DETECTED_END} → ${FIRST_AUDIO}`);
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

describe('Live · Cascade renders the four stages it CAN see, from real marks', () => {
  it('transcribe / translate / synthesize / deliver, each naming its span and figure', async () => {
    await runOneUtterance('cascade', liveCascadeScript());

    expect(stageRowLabels()).toEqual(['transcribe', 'translate', 'synthesize', 'deliver']);

    const expected: Array<[string, string, string]> = [
      // label, span, figure
      ['transcribe', `${DETECTED_END} → transcript`, '0.31 s'],
      ['translate', 'transcript → translated text', '0.22 s'],
      // ROUND 2 — `tts_first_byte` is a mark the server DOES stamp
      // (orchestrator.ts:307) and it is the only one from which cascade's
      // time-to-first-audio can be recovered. Folding it into one `speak` row
      // deleted the one boundary that makes the two arms comparable, and cost
      // an observable interval against PRD §8's auditability count.
      ['synthesize', `translated text → ${FIRST_AUDIO}`, '0.71 s'],
      ['deliver', `${FIRST_AUDIO} → audio complete`, '2.76 s'],
    ];
    for (const [label, span, figure] of expected) {
      const row = stageRow(targetCard(), label);
      expect(row, `stage row ${label}`).not.toBeNull();
      expect(text(row!), `${label} span`).toContain(span);
      expect(text(row!), `${label} figure`).toContain(figure);
      expect(text(row!)).not.toContain('—');
    }
  });

  it('the headline is time-to-FIRST-audio: tts_first_byte − vad_fired, not audio_queued', async () => {
    await runOneUtterance('cascade', liveCascadeScript());

    const total = text(liveTotal());
    // 1740 − 500. It is the sum of the first THREE rows (0.31 + 0.22 + 0.71),
    // and `deliver` — the tail of synthesis, which scales with how long the
    // sentence is — is deliberately outside it.
    expect(total).toContain('1.24 s');
    // audio_queued − vad_fired would be 4.00 s: time-to-LAST-audio, the figure
    // that made a long cascade utterance look 4× slower than a short Arm A one.
    expect(total).not.toContain('4.00 s');
    // ...but `deliver` is still ON the card. It is real information; it is just
    // not the headline.
    expect(text(stageRow(targetCard(), 'deliver')!)).toContain('2.76 s');
  });

  it('the marks are read off the completion record — the server sends no stage.timing', async () => {
    // liveCascadeScript emits ZERO `timing` events by construction; this
    // asserts that fact so the coverage above cannot be quietly satisfied by
    // an onTiming-only path that production never exercises.
    expect(liveCascadeScript().filter((e) => e.type === 'timing')).toHaveLength(0);

    await runOneUtterance('cascade', liveCascadeScript());
    expect(text(stageRow(targetCard(), 'transcribe')!)).toContain('0.31 s');
  });

  it('renders NO endpointing row on cascade either', async () => {
    await runOneUtterance('cascade', liveCascadeScript());

    expect(stageRow(targetCard(), 'endpointing')).toBeNull();
    expect(document.body.textContent).not.toMatch(/endpointing/i);
  });
});

/* ============================================ 2b — THE COMMENSURABILITY PIN */

/**
 * ROUND 2, R2-1 — the two arms' headlines must measure THE SAME QUANTITY.
 *
 * `audio_queued` means different things in the two transports:
 *   cascade  — re-stamped per TTS chunk, last chunk wins  -> LAST audio
 *   realtime — stamped once at output_audio_buffer.started -> FIRST audio
 * The fixtures below are built so both arms' audio STARTS 1240 ms after the
 * detected end of speech, while cascade's audio finishes 2760 ms later still.
 * Any implementation anchored on the wrong end of the audio separates them.
 */
describe('both arms report time-to-first-audio, so their headlines are comparable', () => {
  it('identical first-audio latency renders as an identical figure on both arms', async () => {
    await runOneUtterance('realtime', liveRealtimeScript({ spanMs: 1_240 }));
    const realtimeTotal = text(liveTotal());
    const realtimeFooter = text(sessionFooter());
    cleanup();

    await runOneUtterance('cascade', liveCascadeScript());
    const cascadeTotal = text(liveTotal());
    const cascadeFooter = text(sessionFooter());

    // Same figure, and the SAME LABEL — one quantity, one name.
    expect(cascadeTotal).toBe(realtimeTotal);
    expect(cascadeTotal).toContain('1.24 s');
    // The session-level figures agree too, so a p50 pooled across a mixed
    // ledger is not comparing playout duration against response time.
    expect(cascadeFooter).toContain('1.24 s');
    expect(realtimeFooter).toContain('1.24 s');
    expect(cascadeFooter).not.toContain('4.00 s');
  });

  it('the total label names the same two events on both arms', async () => {
    await runOneUtterance('realtime', liveRealtimeScript());
    const realtimeLabel = text(liveTotal()).replace(/[\d.]+ s/, '').trim();
    cleanup();

    await runOneUtterance('cascade', liveCascadeScript());
    const cascadeLabel = text(liveTotal()).replace(/[\d.]+ s/, '').trim();

    expect(cascadeLabel).toBe(realtimeLabel);
    expect(cascadeLabel).toContain(DETECTED_END);
    expect(cascadeLabel).toContain(FIRST_AUDIO);
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

  it('a cascade Live session populates p50 from vad_fired -> tts_first_byte', async () => {
    await runOneUtterance('cascade', liveCascadeScript());

    const footer = text(sessionFooter());
    expect(footer).toContain('1.24 s');
    // Not the last-audio figure, which is what `audio_queued` means here.
    expect(footer).not.toContain('4.00 s');
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
  async function costsOfThreeUtterances(): Promise<{
    costs: Array<number | null>;
    footer: string;
  }> {
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

  it('GUARD: an utterance the transport reported no usage for is NOT METERED, never $0', async () => {
    // TICKET 052 owns the nullable-cost rule; this is the Live end of it. `0`
    // is the claim that a turn was free, which is never true of a real one.
    const kit = renderApp({ scripts: { realtime: liveRealtimeScript({ usage: undefined }) } });
    await clickStartMicrophone();
    await advance(200);
    expect(kit.ledger.getRecords()[0]!.costUnits).toBeNull();
  });
});

/* ============================== 6 — one card, one anchor (R2-5 / R2-4 / R2-7) */

/**
 * ROUND 2, R2-5 — the card and the footer must never disagree under one label.
 *
 * `anchoredLatencyMs` prefers `speech_end` when a record carries it; the card's
 * own derivation never looked at that mark, so a record carrying BOTH rendered
 * one number on the card and a different one in the footer, both labelled
 * "from detected end of speech". `fixtureDeps.ts:148` emits exactly such
 * records — it escapes notice today only because fixture records fail
 * `isRealRecord` and never reach the footer at all.
 *
 * The marks below are the fixture shape: a corpus-style `speech_end` 500 ms
 * ahead of the endpointer's `vad_fired`. Whichever anchor wins, ONE of them
 * must win everywhere.
 */
function bothAnchorsCascadeScript(): FixtureScriptEvent[] {
  const marks = { speech_end: 0, ...cascadeMarks(0) };
  return [
    { at: 10, type: 'sourceText', kind: 'partial', text: SRC_PARTIAL_1, utt: 0 },
    { at: 30, type: 'sourceText', kind: 'final', text: SRC_FINAL, utt: 0 },
    { at: 40, type: 'targetText', kind: 'final', text: TGT_FINAL, utt: 0 },
    { at: 50, type: 'audio', pcm: audioChunk(), utt: 0 },
    {
      at: 60,
      type: 'utteranceComplete',
      record: makeRecord({ id: 'utt-0', timings: marks, costUnits: 0.01 }),
    },
  ];
}

describe('a record carrying BOTH anchors renders ONE number, not two', () => {
  it('the card total and the footer p50 agree', async () => {
    await runOneUtterance('cascade', bothAnchorsCascadeScript());

    // `speech_end` wins as the START (it always has — that is what keeps every
    // Replay figure still), and the END is the first audio, as everywhere else:
    // tts_first_byte 1740 − speech_end 0.
    const total = text(liveTotal());
    const footer = text(sessionFooter());
    expect(total).toContain('1.74 s');
    expect(footer).toContain('1.74 s');
    // The two numbers that used to appear under one label.
    expect(footer).not.toContain('1.24 s');
    expect(total).not.toContain('4.50 s');
  });
});

describe('R2-7 — a single row has no proportion to show', () => {
  it('Arm A renders no bar; cascade, with four rows, does', async () => {
    await runOneUtterance('realtime', liveRealtimeScript());
    expect(stageRow(targetCard(), 'model')!.querySelector('[data-stage-bar]')).toBeNull();
    cleanup();

    await runOneUtterance('cascade', liveCascadeScript());
    for (const label of ['transcribe', 'translate', 'synthesize', 'deliver']) {
      expect(
        stageRow(targetCard(), label)!.querySelector('[data-stage-bar]'),
        `${label} bar`,
      ).not.toBeNull();
    }
  });
});

describe('R2-4 — a Live record does not claim a speech_end source it has none of', () => {
  it("realtime: speechEndSource is 'none', and no speech_end mark exists", async () => {
    const kit = renderApp({ scripts: { realtime: liveRealtimeScript() } });
    await clickStartMicrophone();
    await advance(200);

    const record = kit.ledger.getRecords()[0]!;
    // Option (c) deliberately never stamps speech_end in Live. Declaring it
    // VAD-derived is a false claim in a PERSISTED, EXPORTED field.
    expect((record.timings as Record<string, unknown>).speech_end).toBeUndefined();
    expect(record.speechEndSource).toBe('none');
  });

  it("GUARD: a record the controller assembles WITH a speech_end still names its source", async () => {
    // Realtime completions are `{ utt, usage }` — the controller assembles the
    // record from the marks it accumulated, so this exercises the very line
    // that decides the claim. A blanket `'none'` would be just as false as the
    // blanket `'vad'` it replaces.
    const withSpeechEnd = liveRealtimeScript();
    withSpeechEnd.splice(1, 0, { at: 15, type: 'timing', event: 'speech_end', t: 0, utt: 0 });

    const kit = renderApp({ scripts: { realtime: withSpeechEnd } });
    await clickStartMicrophone();
    await advance(200);

    const record = kit.ledger.getRecords()[0]!;
    expect((record.timings as Record<string, unknown>).speech_end).toBe(0);
    expect(record.speechEndSource).toBe('vad');
  });
});
