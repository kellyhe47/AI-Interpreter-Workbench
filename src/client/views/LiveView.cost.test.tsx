/**
 * TICKET 052 ROUND 2 — R2-1(a) and R2-4. What the LIVE FOOTER renders.
 *
 * R2-1(a): the footer initialiser
 *     costUsd: null, costCell: COST_NOT_MEASURED_CELL
 * could be changed back to
 *     costUsd: 0, costCell: '$0.00'
 * with the whole suite green. That single line IS the defect this ticket was
 * filed against — `session $0.00` on a live take, which reads as "this
 * configuration is free" rather than "nobody priced it". `LiveView.timings
 * .test.tsx` pins `costUnits === null` on the RECORD; nothing pinned what the
 * FOOTER makes of it. A cascade Live session — every record unpriced today,
 * because MT reports no usage — is exactly the take that regresses.
 *
 * R2-4: the footer shows a bare dollar figure with no denominator, while
 * `ArmAggregate.measuredCostRecords` is computed for precisely this and read by
 * nothing outside tests. Arm A is where it bites: `priceRealtimeUsage` returns
 * null whenever a `response.done` arrives without a usage block, which is a
 * PER-TURN condition — a five-utterance session can easily be metered on three.
 * `$0.041` over three of five turns and `$0.041` over five of five are
 * different claims and the dollars cannot tell them apart.
 *
 * DECIDED RENDERING: `session $0.041 · 3 of 5 metered`.
 *
 * The scripts here carry the marks the REAL WebRTC transport produces —
 * `server_speech_stopped` and `audio_queued`, never `speech_end` and never
 * `first_audio_delta` (ticket 040/051). A script that emits the fictional marks
 * is why this screen was green while the product was blank.
 */

import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { COST_NOT_MEASURED_CELL } from '../../core/pricing';
import type { FixtureScriptEvent } from '../transport/fixture';
import {
  SRC_FINAL,
  TGT_FINAL,
  advance,
  clickStartMicrophone,
  renderApp,
  sessionFooter,
  text,
} from './sessionTestKit';

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

/** `response.done` usage, trimmed to the fields the model prices. */
function usage(audioIn: number, audioOut: number): unknown {
  return {
    input_token_details: { audio_tokens: audioIn, text_tokens: 0 },
    output_token_details: { audio_tokens: audioOut, text_tokens: 0 },
  };
}

/**
 * One Arm A utterance as the real transport delivers it. `usage: undefined` is
 * the PRODUCTION case this ticket cares about: a `response.done` with no usage
 * block, which prices to `null` — not measured, not free.
 */
function realtimeTurn(opts: { utt: number; base: number; usage?: unknown }): FixtureScriptEvent[] {
  const { utt, base } = opts;
  const stopped = base + 100;
  return [
    { at: base + 10, type: 'timing', event: 'server_speech_stopped', t: stopped, utt },
    { at: base + 20, type: 'sourceText', kind: 'final', text: SRC_FINAL, utt },
    { at: base + 30, type: 'targetText', kind: 'final', text: TGT_FINAL, utt },
    { at: base + 40, type: 'timing', event: 'audio_queued', t: stopped + 1_240, utt },
    { at: base + 50, type: 'utteranceComplete', record: { utt, usage: opts.usage } },
  ];
}

/** Run a session of `usages.length` turns; returns the rendered footer text. */
async function footerAfter(usages: Array<unknown | undefined>): Promise<string> {
  const script = usages.flatMap((u, i) =>
    realtimeTurn({ utt: i, base: i * 1_000, usage: u }),
  );
  renderApp({ scripts: { realtime: script } });
  await clickStartMicrophone();
  await advance(usages.length * 1_000 + 500);
  return text(sessionFooter());
}

describe('R2-1a · the Live footer never renders an unpriced session as $0.00', () => {
  it('says NOT MEASURED when no turn carried usage', async () => {
    const footer = await footerAfter([undefined, undefined]);
    expect(footer).toContain(COST_NOT_MEASURED_CELL);
    // The literal defect, in every shape it could return in.
    expect(footer).not.toContain('$0.00');
    expect(footer).not.toMatch(/session\s+\$0(\.0*)?(\s|$)/);
  });

  it('says NOT MEASURED before any utterance has completed', async () => {
    // A session that has just started has priced nothing. `$0.00` there is the
    // same false claim, made earlier.
    renderApp({ scripts: { realtime: realtimeTurn({ utt: 0, base: 10_000 }) } });
    await clickStartMicrophone();
    await advance(50);
    const footer = text(sessionFooter());
    expect(footer).toContain(COST_NOT_MEASURED_CELL);
    expect(footer).not.toContain('$0.00');
  });

  it('renders real money once a turn IS priced', async () => {
    // The control: refusing to invent a zero must not suppress a measurement.
    const footer = await footerAfter([usage(1_000_000, 0)]);
    expect(footer).toMatch(/session\s+\$\d/);
    expect(footer).not.toContain(COST_NOT_MEASURED_CELL);
  });
});

describe('R2-4 · the Live footer discloses HOW MANY turns were metered', () => {
  it('names the denominator beside the dollars on a partly metered session', async () => {
    const footer = await footerAfter([
      usage(1_000_000, 0),
      undefined,
      usage(1_000_000, 0),
      undefined,
      usage(1_000_000, 0),
    ]);
    // THE CLAIM THE DOLLARS CANNOT MAKE. Without this the same figure reads as
    // the whole session's spend.
    expect(footer).toMatch(/3\s*of\s*5\s*metered/);
    expect(footer).toMatch(/session\s+\$\d/);
  });

  it('states the denominator even when every turn was metered', async () => {
    // A disclosure that appears only when something is missing teaches the
    // reader to read its absence as "complete" — which is a claim nothing
    // checks. It is stated always, like `n` and the completed reps.
    const footer = await footerAfter([usage(1_000_000, 0), usage(1_000_000, 0)]);
    expect(footer).toMatch(/2\s*of\s*2\s*metered/);
  });

  it('states the denominator when NOTHING was metered', async () => {
    const footer = await footerAfter([undefined, undefined, undefined]);
    expect(footer).toMatch(/0\s*of\s*3\s*metered/);
    expect(footer).toContain(COST_NOT_MEASURED_CELL);
  });

  it('the denominator tracks the turns, not a constant', async () => {
    // Two sessions of different length must not report the same denominator —
    // a hardcoded `n of n` string would pass every assertion above.
    const short = await footerAfter([usage(1_000_000, 0), undefined]);
    const long = await footerAfter([
      usage(1_000_000, 0),
      undefined,
      undefined,
      undefined,
    ]);
    expect(short).toMatch(/1\s*of\s*2\s*metered/);
    expect(long).toMatch(/1\s*of\s*4\s*metered/);
  });
});

/* ================================================================ R2-5c ==== */

/**
 * R2-5(c) — THE COST SLOPE IS THE FINDING FOR ARM A, and it is not implemented.
 * `costSlope()` and `costPerMinuteUsd()` are dead exports; `saveLiveSession`
 * hardcodes `perMinuteMinute1: null, perMinuteFinalMinute: null`, so the two
 * Live rows on the Results screen render `—` forever.
 *
 * PRD §8: Realtime replays the ACCUMULATED CONVERSATION each turn, so the cost
 * per minute CLIMBS with session length. That climb is one of the reasons Live
 * exists at all (§17 21e, context policy under controllability) and a ≤1-minute
 * clip cannot show it — which is exactly why Replay cannot answer this and a
 * soak can.
 *
 * The turns below are placed by their WALL-CLOCK marks, not by script order:
 * one in minute 1, one in the final minute of a three-minute session, with the
 * later turn metered four times heavier. A flat implementation, a constant, and
 * a null both report the same thing here and all three fail.
 */
function turnAt(opts: { utt: number; scriptAt: number; queuedAt: number; usage?: unknown }): FixtureScriptEvent[] {
  const { utt, scriptAt, queuedAt } = opts;
  return [
    { at: scriptAt, type: 'timing', event: 'server_speech_stopped', t: queuedAt - 1_240, utt },
    { at: scriptAt + 5, type: 'sourceText', kind: 'final', text: SRC_FINAL, utt },
    { at: scriptAt + 10, type: 'targetText', kind: 'final', text: TGT_FINAL, utt },
    { at: scriptAt + 15, type: 'timing', event: 'audio_queued', t: queuedAt, utt },
    { at: scriptAt + 20, type: 'utteranceComplete', record: { utt, usage: opts.usage } },
  ];
}

/** Run a session of `durationMs`, then stop it and return the saved session. */
async function sessionOf(script: FixtureScriptEvent[], durationMs: number) {
  let clock = 0;
  const kit = renderApp({ now: () => clock, scripts: { realtime: script } });
  await clickStartMicrophone();
  await advance(2_000);
  clock = durationMs;
  fireEvent.click(screen.getByRole('button', { name: 'Stop session' }));
  await advance(100);
  return kit.ledger.getLiveSessions()[0]!;
}

describe('R2-5c · a Live session reports its COST SLOPE, not just a total', () => {
  it('fills both per-minute figures instead of the hardcoded nulls', async () => {
    const session = await sessionOf(
      [
        ...turnAt({ utt: 0, scriptAt: 10, queuedAt: 20_000, usage: usage(1_000_000, 0) }),
        ...turnAt({ utt: 1, scriptAt: 200, queuedAt: 170_000, usage: usage(4_000_000, 0) }),
      ],
      180_000,
    );
    expect(session.cost.perMinuteMinute1).not.toBeNull();
    expect(session.cost.perMinuteFinalMinute).not.toBeNull();
  });

  it('shows the climb: the final minute costs more per minute than the first', async () => {
    const session = await sessionOf(
      [
        ...turnAt({ utt: 0, scriptAt: 10, queuedAt: 20_000, usage: usage(1_000_000, 0) }),
        ...turnAt({ utt: 1, scriptAt: 200, queuedAt: 170_000, usage: usage(4_000_000, 0) }),
      ],
      180_000,
    );
    // A constant, a session-wide average, and a flat curve all fail here.
    expect(session.cost.perMinuteFinalMinute!).toBeGreaterThan(session.cost.perMinuteMinute1!);
  });

  it('reports NO final-minute figure for a session too short to show a climb', async () => {
    // PRD §8 — a ≤1-minute take accumulates almost no conversation context, so
    // there is no second minute to compare against. NULL, never 0: a zero slope
    // is the claim that the cost curve is FLAT, which is the finding under test.
    const session = await sessionOf(
      [...turnAt({ utt: 0, scriptAt: 10, queuedAt: 20_000, usage: usage(1_000_000, 0) })],
      45_000,
    );
    expect(session.cost.perMinuteFinalMinute).toBeNull();
  });

  it('reports NO per-minute figure at all when nothing was metered', async () => {
    // The `$0.00` rule applied to the derived figure: spend ÷ duration is null
    // when the spend is null, never 0.
    const session = await sessionOf(
      [
        ...turnAt({ utt: 0, scriptAt: 10, queuedAt: 20_000 }),
        ...turnAt({ utt: 1, scriptAt: 200, queuedAt: 170_000 }),
      ],
      180_000,
    );
    expect(session.cost.totalUsd).toBeNull();
    expect(session.cost.perMinuteMinute1).toBeNull();
    expect(session.cost.perMinuteFinalMinute).toBeNull();
  });
});
