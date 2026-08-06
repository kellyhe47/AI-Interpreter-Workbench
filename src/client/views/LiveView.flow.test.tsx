/**
 * Ticket 012 — Live view flow tests: the single target card driven by
 * fixture scripts, architecture-differentiated failures, live transcripts,
 * reconnect banners, the 5-minute cap, the ledger-backed footer, and the
 * LiveSession saved on stop (metrics kept, audio discarded, wer null).
 *
 * All suites drive FixtureTransport scripts under vi.useFakeTimers(); see
 * sessionTestKit.ts for the shared script/deps helpers.
 */

import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_CASCADE_TRIPLE, REALTIME_MODEL } from '../../core/arms';
import type { FixtureScriptEvent } from '../transport/fixture';
import {
  COPY,
  SRC_FINAL,
  SRC_PARTIAL_1,
  SRC_PARTIAL_2,
  TGT_FINAL,
  advance,
  cascadeUtteranceScript,
  clickStartMicrophone,
  connLabel,
  elapsedLabel,
  realtimeUtteranceScript,
  renderApp,
  sessionFooter,
  sourceCard,
  stageRow,
  stateLabelEl,
  targetCard,
  targetCards,
  text,
} from './sessionTestKit';

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const CASCADE_SESSION = { mode: 'cascade' as const };

// ---------------------------------------------------------------------------
// AC — labelled per-stage milliseconds: 5 for cascade, 3 for realtime
// ---------------------------------------------------------------------------

describe('the single target card', () => {
  it('cascade: in-flight bar, then ready with text, play + duration, FIVE labelled stage ms', async () => {
    renderApp({
      initialState: CASCADE_SESSION,
      scripts: { cascade: cascadeUtteranceScript() },
    });
    await clickStartMicrophone();

    await advance(50); // first source partial arrived → utterance in flight
    const inFlight = targetCard();
    expect(inFlight).toHaveAttribute('data-target-status', 'in-flight');
    expect(inFlight.querySelector('[data-inflight-bar]')).not.toBeNull();

    await advance(1200); // utterance completes
    const card = targetCard();
    expect(targetCards()).toHaveLength(1);
    expect(card).toHaveAttribute('data-target-status', 'ready');
    expect(card).toHaveTextContent(TGT_FINAL);

    // The card names the architecture and its configured stages.
    expect(card.querySelector('[data-target-arch]')).toHaveTextContent('Cascade');
    expect(card.querySelector('[data-target-arch]')).toHaveTextContent(DEFAULT_CASCADE_TRIPLE.stt);

    const play = within(card).getByRole('button', { name: /^play/ });
    expect(play).toHaveTextContent('2.1 s');

    // Numbers, not bars alone: every interval carries a LABEL and a value.
    const stages: Array<[string, string]> = [
      ['endpointing', '500 ms'],
      ['stt', '42 ms'],
      ['mt', '298 ms'],
      ['tts', '201 ms'],
      ['queue', '12 ms'],
    ];
    for (const [label, ms] of stages) {
      const row = stageRow(card, label);
      expect(row, `stage row ${label}`).not.toBeNull();
      expect(row).toHaveTextContent(label);
      expect(row).toHaveTextContent(ms);
    }
    expect(card.querySelectorAll('[data-stage-row]')).toHaveLength(5);

    expect(card).toHaveTextContent('total');
    expect(card).toHaveTextContent('1053 ms');
    expect(card).toHaveTextContent(COPY.cascadeIntervals);
    expect(card).not.toHaveTextContent(COPY.realtimeIntervals);
  });

  it('realtime: THREE labelled rows with the model interval explicitly labelled opaque', async () => {
    renderApp({ scripts: { realtime: realtimeUtteranceScript() } });
    await clickStartMicrophone();
    await advance(1100);

    const card = targetCard();
    expect(targetCards()).toHaveLength(1);
    expect(card).toHaveAttribute('data-target-status', 'ready');
    expect(card.querySelector('[data-target-arch]')).toHaveTextContent('Realtime');
    expect(card.querySelector('[data-target-arch]')).toHaveTextContent(REALTIME_MODEL);

    const stages: Array<[string, string]> = [
      ['endpointing', '500 ms'],
      ['model', '471 ms'],
      ['queue', '9 ms'],
    ];
    for (const [label, ms] of stages) {
      const row = stageRow(card, label);
      expect(row, `stage row ${label}`).not.toBeNull();
      expect(row).toHaveTextContent(label);
      expect(row).toHaveTextContent(ms);
    }
    expect(card.querySelectorAll('[data-stage-row]')).toHaveLength(3);
    // No cascade-only rows on a realtime card.
    for (const label of ['stt', 'mt', 'tts']) {
      expect(stageRow(card, label), `${label} row must not exist`).toBeNull();
    }

    // The model interval is labelled opaque — the asymmetry is the finding.
    expect(stageRow(card, 'model')).toHaveTextContent(/opaque/i);
    expect(card).toHaveTextContent('total');
    expect(card).toHaveTextContent('980 ms');
    expect(card).toHaveTextContent(COPY.realtimeIntervals);
  });
});

// ---------------------------------------------------------------------------
// AC — architecture-differentiated failure copy; the session keeps running
// ---------------------------------------------------------------------------

describe('failure copy differs by architecture', () => {
  const failCascade: FixtureScriptEvent[] = [
    { at: 10, type: 'sourceText', kind: 'partial', text: SRC_PARTIAL_1, utt: 0 },
    {
      at: 300,
      type: 'error',
      message: 'mt stage timed out for this utterance',
      opaque: false,
      stage: 'mt',
    },
  ];

  const failRealtime: FixtureScriptEvent[] = [
    { at: 10, type: 'sourceText', kind: 'partial', text: SRC_PARTIAL_1, utt: 0 },
    { at: 300, type: 'error', message: 'response failed', opaque: true },
  ];

  it('cascade names the failing stage; the session keeps running', async () => {
    renderApp({ initialState: CASCADE_SESSION, scripts: { cascade: failCascade } });
    await clickStartMicrophone();
    await advance(400);

    const card = targetCard();
    expect(card).toHaveAttribute('data-target-status', 'failed');
    expect(card).toHaveTextContent(COPY.cascadeFail);

    expect(connLabel()).toHaveTextContent('connected');
    expect(screen.getByRole('button', { name: 'Stop session' })).toBeInTheDocument();
  });

  it('realtime is opaque — NO stage attribution; the session keeps running', async () => {
    renderApp({ scripts: { realtime: failRealtime } });
    await clickStartMicrophone();
    await advance(400);

    const card = targetCard();
    expect(card).toHaveAttribute('data-target-status', 'failed');
    expect(card).toHaveTextContent(COPY.realtimeFail);
    // No stage may be named on a realtime failure.
    for (const stage of ['stt stage', 'mt stage', 'tts stage']) {
      expect(card).not.toHaveTextContent(stage);
    }

    expect(connLabel()).toHaveTextContent('connected');
    expect(screen.getByRole('button', { name: 'Stop session' })).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Live transcripts
// ---------------------------------------------------------------------------

describe('live transcripts', () => {
  it('source shows accumulated partials then the final; target accumulates deltas', async () => {
    renderApp({
      initialState: CASCADE_SESSION,
      scripts: { cascade: cascadeUtteranceScript() },
    });
    await clickStartMicrophone();

    await advance(20);
    expect(sourceCard()).toHaveTextContent(SRC_PARTIAL_1);

    await advance(30); // t=50
    expect(sourceCard()).toHaveTextContent(SRC_PARTIAL_2);

    await advance(550); // t=600
    expect(sourceCard()).toHaveTextContent(SRC_FINAL);

    await advance(320); // t=920
    expect(targetCard()).toHaveTextContent('Necesito programar');

    await advance(50); // t=970
    expect(targetCard()).toHaveTextContent('Necesito programar una cita');

    await advance(200); // t=1170
    expect(targetCard()).toHaveTextContent(TGT_FINAL);
  });
});

// ---------------------------------------------------------------------------
// Reconnect / disconnect banners
// ---------------------------------------------------------------------------

describe('reconnect and disconnect banners', () => {
  const preamble: FixtureScriptEvent[] = [
    { at: 10, type: 'sourceText', kind: 'partial', text: SRC_PARTIAL_1, utt: 0 },
    { at: 50, type: 'sourceText', kind: 'final', text: SRC_FINAL, utt: 0 },
  ];

  it('reconnecting banner carries the attempt count; transcript history preserved', async () => {
    renderApp({
      initialState: CASCADE_SESSION,
      scripts: {
        cascade: [
          ...preamble,
          { at: 100, type: 'connection', state: 'reconnecting', attempt: 1 },
          { at: 200, type: 'connection', state: 'reconnecting', attempt: 2 },
        ],
      },
    });
    await clickStartMicrophone();
    await advance(250);

    expect(
      screen.getByText('Reconnecting — attempt 2 of 5 · transcript history preserved'),
    ).toBeInTheDocument();
    expect(connLabel()).toHaveTextContent('reconnecting…');
    expect(sourceCard()).toHaveTextContent(SRC_FINAL);
  });

  it('after exhaustion: red disconnected banner + Reconnect button, transcript intact', async () => {
    renderApp({
      initialState: CASCADE_SESSION,
      scripts: {
        cascade: [
          ...preamble,
          { at: 100, type: 'connection', state: 'reconnecting', attempt: 1 },
          { at: 150, type: 'connection', state: 'disconnected' },
        ],
      },
    });
    await clickStartMicrophone();
    await advance(200);

    expect(screen.getByText(COPY.disconnectedBanner)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Reconnect' })).toBeInTheDocument();
    expect(connLabel()).toHaveTextContent('disconnected');
    expect(sourceCard()).toHaveTextContent(SRC_FINAL);
  });
});

// ---------------------------------------------------------------------------
// AC — the 5-minute cap
// ---------------------------------------------------------------------------

describe('Live ends at five minutes', () => {
  it('elapsed counts up against / 5:00 and the session stops itself at the cap', async () => {
    let t = 0;
    renderApp({
      now: () => t,
      initialState: CASCADE_SESSION,
      scripts: { cascade: cascadeUtteranceScript() },
    });
    await clickStartMicrophone(); // startedAt = 0
    await advance(1200);

    t = 74_000; // 1:14 in
    await advance(1000);
    expect(text(elapsedLabel())).toBe('1:14 / 5:00 · autoplay on');
    expect(screen.getByRole('button', { name: 'Stop session' })).toBeInTheDocument();

    t = 300_000; // the cap
    await advance(1000);

    expect(stateLabelEl()).toHaveTextContent('stopped');
    expect(text(elapsedLabel())).toBe('5:00 / 5:00 · autoplay on');
    expect(screen.queryByRole('button', { name: 'Stop session' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Start new session' })).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// AC — stop: real summary, ledger-backed footer, LiveSession with no audio
// ---------------------------------------------------------------------------

describe('stopping the session', () => {
  function twoUtteranceCascadeRun(now: () => number) {
    return renderApp({
      now,
      initialState: CASCADE_SESSION,
      scripts: {
        cascade: [
          ...cascadeUtteranceScript({ utt: 0, base: 0 }),
          ...cascadeUtteranceScript({ utt: 1, base: 2000 }),
        ],
      },
    });
  }

  it('shows the green summary from REAL numbers and freezes elapsed', async () => {
    let t = 0;
    twoUtteranceCascadeRun(() => t);
    await clickStartMicrophone();
    await advance(3400);

    t = 242_000; // 4:02 elapsed
    fireEvent.click(screen.getByRole('button', { name: 'Stop session' }));
    await advance(100);

    // Never the mock's made-up '5:00 · 32 utterances'.
    expect(
      screen.getByText(
        'Session ended · 4:02 · 2 utterances · LiveSession metrics saved — audio discarded',
      ),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Start new session' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Stop session' })).not.toBeInTheDocument();

    expect(text(elapsedLabel())).toBe('4:02 / 5:00 · autoplay on');
    t = 400_000;
    await advance(5000);
    expect(text(elapsedLabel())).toBe('4:02 / 5:00 · autoplay on');
  });

  it('appends session-stamped records carrying the DERIVED arm tag', async () => {
    let t = 0;
    const { ledger } = twoUtteranceCascadeRun(() => t);
    await clickStartMicrophone();
    await advance(3400);

    const records = ledger.getRecords();
    expect(records).toHaveLength(2);
    // One shared live-session run id, stamped by the controller.
    expect(new Set(records.map((r) => r.runId)).size).toBe(1);
    expect(records[0]!.runId).toMatch(/^session/);
    // Membership is DERIVED: the default triple is Arm B's frozen recipe.
    expect(records.map((r) => r.arm)).toEqual(['B', 'B']);
  });

  it('footer figures come from the ledger aggregates; the illustrative pill never renders', async () => {
    let t = 0;
    twoUtteranceCascadeRun(() => t);
    await clickStartMicrophone();
    await advance(3400);

    const footer = sessionFooter();
    expect(footer).toHaveTextContent('2 utterances');
    expect(footer).toHaveTextContent('p50');
    expect(footer).toHaveTextContent('p95');
    // audio_queued − speech_end = 1053 ms for both records → 1.05 s.
    expect(footer).toHaveTextContent('1.05 s');
    // session cost = 2 × $0.005 = $0.01.
    expect(footer).toHaveTextContent('session');
    expect(footer).toHaveTextContent('$0.01');
    expect(screen.queryByText(/figures illustrative/i)).not.toBeInTheDocument();
  });

  it('saves ONE LiveSession carrying metrics and NO audio, with quality.wer null', async () => {
    let t = 0;
    const kit = twoUtteranceCascadeRun(() => t);
    await clickStartMicrophone();
    await advance(3400);
    t = 242_000;
    fireEvent.click(screen.getByRole('button', { name: 'Stop session' }));
    await advance(100);

    const sessions = kit.ledger.getLiveSessions();
    expect(sessions).toHaveLength(1);
    const session = sessions[0]!;

    // AUDIO IS DISCARDED: the stored shape has no audio-bearing field at all.
    expect(Object.keys(session).sort()).toEqual([
      'architecture',
      'contextPolicy',
      'cost',
      'durationMs',
      'endedAt',
      'id',
      'latency',
      'modelSnapshots',
      'providerTriple',
      'quality',
      'stability',
      'startedAt',
      'utterances',
    ]);
    for (const u of session.utterances) {
      expect(Object.keys(u).sort()).toEqual(['costUsd', 'id', 'timings']);
    }

    expect(session.architecture).toBe('cascade');
    expect(session.providerTriple).toEqual(DEFAULT_CASCADE_TRIPLE);
    expect(session.startedAt).toBe(0);
    expect(session.endedAt).toBe(242_000);
    expect(session.durationMs).toBe(242_000);
    expect(session.utterances).toHaveLength(2);
    expect(session.stability.utterancesCompleted).toBe(2);
    expect(session.stability.disconnects).toBe(0);
    expect(session.latency.p50).toBe(1053);
    expect(session.latency.p95).toBe(1053);
    expect(session.cost.totalUsd).toBeCloseTo(0.01, 6);

    // Free conversation has no reference transcript.
    expect(session.quality.wer).toBeNull();

    // A LiveSession is a soak measurement, never an experimental Run.
    expect(kit.ledger.getRuns()).toHaveLength(0);
  });

  it('a realtime session records the resolved model snapshot, not the dev default', async () => {
    let t = 0;
    const kit = renderApp({
      now: () => t,
      scripts: { realtime: realtimeUtteranceScript() },
    });
    await clickStartMicrophone();
    await advance(1200);
    t = 60_000;
    fireEvent.click(screen.getByRole('button', { name: 'Stop session' }));
    await advance(100);

    const session = kit.ledger.getLiveSessions()[0]!;
    expect(session.architecture).toBe('realtime');
    expect(session.modelSnapshots.realtime).toBe(REALTIME_MODEL);
    expect(session.quality.wer).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// The context policy must survive onto the saved LiveSession — PRD §8's
// conversation-length card renders realtime-default / realtime-trimmed /
// cascade FROM LiveSessions, so a session that does not record which policy
// it ran under makes one third of that card unfillable.
// ---------------------------------------------------------------------------

describe('the saved LiveSession records the context policy it ran under', () => {
  /** Start a session, optionally flip controls mid-flight, then stop at 60 s. */
  async function runAndStop(opts: {
    mode: 'realtime' | 'cascade';
    before?: () => void;
    during?: () => void;
  }) {
    let t = 0;
    const kit = renderApp({
      now: () => t,
      initialState: { mode: opts.mode },
      scripts: {
        realtime: realtimeUtteranceScript(),
        cascade: cascadeUtteranceScript(),
      },
    });
    opts.before?.();
    await clickStartMicrophone();
    await advance(1200);
    opts.during?.();
    t = 60_000;
    fireEvent.click(screen.getByRole('button', { name: 'Stop session' }));
    await advance(100);
    return kit.ledger.getLiveSessions()[0]!;
  }

  it("realtime under the default policy records 'default'", async () => {
    const session = await runAndStop({ mode: 'realtime' });
    expect(session.architecture).toBe('realtime');
    expect(session.contextPolicy).toBe('default');
  });

  it("realtime under the trimmed policy records 'trimmed'", async () => {
    const session = await runAndStop({
      mode: 'realtime',
      before: () => fireEvent.click(screen.getByRole('button', { name: 'trimmed' })),
    });
    expect(session.contextPolicy).toBe('trimmed');
  });

  it('records the policy IN FORCE AT STOP, not the one the session started with', async () => {
    // The toggle is Realtime-only and Live-only, and is NOT part of the
    // boundary-queued switch mechanism — it applies immediately.
    const session = await runAndStop({
      mode: 'realtime',
      during: () => fireEvent.click(screen.getByRole('button', { name: 'trimmed' })),
    });
    expect(session.contextPolicy).toBe('trimmed');
  });

  it("cascade records 'n/a' — it is context-free by design, not running the default", async () => {
    const session = await runAndStop({ mode: 'cascade' });
    expect(session.architecture).toBe('cascade');
    // Recording 'default' here would imply a knob cascade does not have, and
    // would let a cascade session land in the realtime-default column.
    expect(session.contextPolicy).toBe('n/a');
    expect(session.contextPolicy).not.toBe('default');
  });
});
