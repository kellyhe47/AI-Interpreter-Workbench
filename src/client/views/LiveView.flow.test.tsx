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
// AC — span-labelled per-stage figures: 3 for cascade, 1 for realtime
// (ticket 051; the exhaustive contract lives in LiveView.timings.test.tsx)
// ---------------------------------------------------------------------------

describe('the single target card', () => {
  it('cascade: in-flight bar, then ready with text, duration readout, FOUR span-labelled stages', async () => {
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

    // TICKET 047 — the duration is a READOUT, not the label of a play button.
    // Live has no pause state, so the control it used to sit inside is gone.
    expect(card.querySelector('[data-utterance-duration]')).toHaveTextContent('2.1 s');
    expect(within(card).queryByRole('button', { name: /^(play|pause)/i })).not.toBeInTheDocument();

    // TICKET 051 — numbers, not bars alone, and every row NAMES ITS SPAN. The
    // old `endpointing` row is gone: Live cannot know when the human stopped,
    // only when the endpointer decided they had.
    // Marks: vad_fired 500 · stt_final 542 · mt_first_token 840 ·
    // tts_first_byte 1041 · audio_queued 1053 -> 0.04 / 0.30 / 0.20 / 0.01.
    const stages: Array<[string, string]> = [
      ['transcribe', '0.04 s'],
      ['translate', '0.30 s'],
      ['synthesize', '0.20 s'],
      ['deliver', '0.01 s'],
    ];
    for (const [label, s] of stages) {
      const row = stageRow(card, label);
      expect(row, `stage row ${label}`).not.toBeNull();
      expect(row).toHaveTextContent(label);
      expect(row).toHaveTextContent(s);
    }
    expect(card.querySelectorAll('[data-stage-row]')).toHaveLength(4);
    expect(stageRow(card, 'endpointing')).toBeNull();

    // This SCRIPT is fixture-shaped and carries a corpus-style `speech_end`,
    // which still wins as the start (Replay's rule, unmoved). The end is the
    // first synthesized byte either way: 1041 − 0.
    expect(card.querySelector('[data-live-total]')).toHaveTextContent('1.04 s');
    expect(card).toHaveTextContent(COPY.cascadeIntervals);
    expect(card).not.toHaveTextContent(COPY.realtimeIntervals);
  });

  it('realtime: ONE labelled row — the model interval, explicitly labelled opaque', async () => {
    renderApp({ scripts: { realtime: realtimeUtteranceScript() } });
    await clickStartMicrophone();
    await advance(1100);

    const card = targetCard();
    expect(targetCards()).toHaveLength(1);
    expect(card).toHaveAttribute('data-target-status', 'ready');
    expect(card.querySelector('[data-target-arch]')).toHaveTextContent('Realtime');
    expect(card.querySelector('[data-target-arch]')).toHaveTextContent(REALTIME_MODEL);

    // TICKET 051 — one row, because one model does everything and there is
    // exactly ONE observable span: server_speech_stopped 500 -> audio_queued
    // 980 = 0.48 s. This script also carries a `first_audio_delta` mark, which
    // WebRTC never sends; the figure must ignore it (0.47 / 0.01 would betray
    // an implementation reading it).
    expect(card.querySelectorAll('[data-stage-row]')).toHaveLength(1);
    const row = stageRow(card, 'model');
    expect(row).not.toBeNull();
    expect(row).toHaveTextContent('0.48 s');
    expect(row).not.toHaveTextContent('0.47 s');
    for (const label of ['endpointing', 'queue', 'stt', 'mt', 'tts', 'transcribe']) {
      expect(stageRow(card, label), `${label} row must not exist`).toBeNull();
    }

    // The model interval is labelled opaque — the asymmetry is the finding.
    expect(stageRow(card, 'model')).toHaveTextContent(/opaque/i);
    // The script's fixture-shaped `speech_end` still wins as the start, and
    // realtime has no synthesis mark, so the headline is 980 − 0.
    expect(card.querySelector('[data-live-total]')).toHaveTextContent('0.98 s');
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
    // ROUND 2 — the sample ends at the FIRST synthesized byte, so
    // tts_first_byte 1041 − speech_end 0 for both records → 1.04 s. (It ended
    // at `audio_queued` 1053 before; that mark is the LAST chunk of synthesis
    // and it is not the quantity Arm A can produce.)
    expect(footer).toHaveTextContent('1.04 s');
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
    expect(session.latency.p50).toBe(1041);
    expect(session.latency.p95).toBe(1041);
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

// ---------------------------------------------------------------------------
// TICKET 040, AS AMENDED BY 047 — Realtime audio arrives on the WebRTC MEDIA
// TRACK, never as PCM through onAudio, so the session's ArmPlayback queue is
// empty and the RemoteAudioSink is the only real audio path.
//
// 040 proved that by driving the sink from Live's play/pause button. 047
// DELETES that button: Live has no pause state, and pause/resume of a live feed
// behaves differently per arm (cascade replays LATE into a frozen clock;
// realtime loses whatever arrived). What 040 actually cared about — the inbound
// stream reaching the sink, and Live sounding without anyone pressing anything —
// is what is pinned here instead.
//
// ROUND 2 (R2-2): the controller no longer takes a `remoteAudioSink` at all —
// it never read one. In production the sink Live hears is the one browserDeps
// closes over and hands to the TRANSPORT factory, so a fake injected HERE could
// only ever have caught a controller-originated pause. The real coverage is:
// attach → play() on the PRODUCTION sink and the .enabled/.muted source guards
// (LiveView.autoplay.test.tsx), and ontrack → attach (transport/realtime.test.ts).
// ---------------------------------------------------------------------------

/** A realtime utterance carrying NO audio events: the media-track case. */
function realtimeTrackOnlyScript(): FixtureScriptEvent[] {
  return realtimeUtteranceScript().filter((e) => e.type !== 'audio');
}

describe('Live never offers a way to suspend its audio (ticket 040, amended by 047)', () => {
  it('a realtime session runs to ready with NO control to press', async () => {
    renderApp({ scripts: { realtime: realtimeTrackOnlyScript() } });
    await clickStartMicrophone();
    await advance(1200); // the utterance completes → card is 'ready'

    const card = targetCard();
    expect(card).toHaveAttribute('data-target-status', 'ready');
    // Nothing was ever enqueued into ArmPlayback — the audio is on the track.
    expect(within(card).queryByRole('button', { name: /^(play|pause)/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^(play|pause)/i })).not.toBeInTheDocument();
  });

  it('stopping the session surfaces no control either — a stopped feed is torn down, not suspended', async () => {
    renderApp({ scripts: { realtime: realtimeTrackOnlyScript() } });
    await clickStartMicrophone();
    await advance(1200);
    fireEvent.click(screen.getByRole('button', { name: 'Stop session' }));
    await advance(100);

    expect(screen.queryByRole('button', { name: /^(play|pause)/i })).not.toBeInTheDocument();
  });

  it('CASCADE: the utterance is audible with no press at all', async () => {
    renderApp({
      initialState: CASCADE_SESSION,
      scripts: { cascade: cascadeUtteranceScript() },
    });
    await clickStartMicrophone();
    await advance(1200);

    const card = targetCard();
    expect(card).toHaveAttribute('data-target-status', 'ready');
    expect(card.querySelector('[data-utterance-duration]')).toHaveTextContent('2.1 s');
    expect(within(card).queryByRole('button', { name: /^(play|pause)/i })).not.toBeInTheDocument();
  });
});
