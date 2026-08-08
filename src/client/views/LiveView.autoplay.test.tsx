/**
 * Ticket 047 — LIVE HAS NO PAUSE STATE.
 *
 * The play/pause control in Live was never a replay button and could not become
 * one: `ArmPlayback.play()` drains its queue, and realtime plays a live WebRTC
 * MediaStream with no timeline to seek. "play/pause" therefore meant
 * resume/suspend the LIVE FEED — a control nobody wants during a ≤5-minute
 * measured conversation, and one that behaves differently per arm (cascade
 * schedules into a frozen clock and plays LATE; realtime loses whatever
 * arrived). The PRD already says "Live: autoplay on", unconditionally.
 *
 * WHAT THIS FILE PINS
 *  1. No play/pause affordance renders in ANY session state — a TABLE, so it
 *     cannot come back in one branch.
 *  2. The utterance duration readout the button carried SURVIVES, as its own
 *     element `[data-utterance-duration]`, in the target card. It is
 *     information, not a control.
 *  3. Translated audio plays with ZERO user action, in both arms.
 *  4. The deleted action is GONE from the controller's surface — asserted on
 *     the LIVE HOOK by key equality, not by a grep. (The repo-wide identifier
 *     ban lives in deletions.test.ts, the project's stated mechanism for
 *     keeping deleted code deleted.)
 *  5. Source-level guards: Live invokes no pause()/suspend(), and NOTHING in
 *     the client mutes or gates the microphone (input gating was CONSIDERED
 *     AND REJECTED — it kills barge-in and can drop real speech).
 *  6. ROUND 2 — the PRODUCTION wiring, not just the seam: browserDeps forwards
 *     the exact constraint object to the real getUserMedia, and the real sink
 *     sounds on attach. Both of those were reverted by a reviewer mutation
 *     with the whole suite green, because nothing looked at browserDeps.ts.
 *
 * Replay is untouched and stays covered by its own suites:
 * `RunsList.playGate.test.tsx` / `ReplayView.test.tsx` ([data-run-play]) and
 * `BlindCompare.test.tsx` (blind sample play). Those are on-demand playback of
 * a STORED run — "nothing autoplays in Replay" (PRD §7) — a different thing.
 */

import '@testing-library/jest-dom/vitest';
import { cleanup, render, renderHook, screen } from '@testing-library/react';
import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import App from '../App';
import { DEFAULT_CASCADE_TRIPLE, REALTIME_MODEL, deriveArmTag } from '../../core/arms';
import { buildBrowserDeps } from '../browserDeps';
import { matchingLines, readCode, readSource } from '../testSource';
import type {
  PlaybackAudioContextLike,
  PlaybackBufferLike,
  PlaybackSourceLike,
} from '../audio/playback';
import { createInitialState, type SessionState, type SessionStatus } from '../state/sessionMachine';
import LiveView from './LiveView';
import type { FixtureScriptEvent } from '../transport/fixture';
import type { RealtimeDeps } from '../transport/realtime';
import {
  advance,
  cascadeUtteranceScript,
  clickStartMicrophone,
  makeDeps,
  makeGrantingCapture,
  micIndicator,
  realtimeUtteranceScript,
  stateLabelEl,
  targetCard,
  text,
} from './sessionTestKit';
import {
  useSessionController,
  type SessionActions,
  type SessionController,
  type TargetView,
} from './useSessionController';

afterEach(cleanup);

/**
 * The identifier this ticket deleted, assembled at runtime. Spelling it out
 * would put a literal `togglePlay` in CODE, and deletions.test.ts now bans that
 * string across the whole client tree — including this file.
 */
const GONE_ACTION = ['toggle', 'Play'].join('');

/* ===========================================================================
 * 1 — no play/pause affordance, in EVERY session state
 * ======================================================================== */

/**
 * A target card WITH DATA. This matters: the old button rendered only when
 * `target.hasData` was true, so a table seeded with an empty card would pass
 * against the UNCHANGED view and prove nothing.
 */
function readyTarget(): TargetView {
  return {
    utt: 0,
    status: 'ready',
    hasData: true,
    targetText: 'Necesito programar una cita',
    failMessage: null,
    timings: {
      speech_end: 0,
      server_speech_stopped: 500,
      first_audio_delta: 971,
      audio_queued: 980,
    },
    durationMs: 2100,
  };
}

/** A controller stub: the view renders exactly what it is handed. */
function stubController(state: Partial<SessionState>): SessionController {
  const full = createInitialState(state);
  const runConfig = {
    architecture: full.mode,
    realtimeModel: REALTIME_MODEL,
    providers: { ...full.providers },
    contextPolicy: full.contextPolicy,
  };
  // Cast, deliberately: the point of this ticket is that the play action
  // leaves SessionActions, and a stub typed against the current shape would
  // make this file fail to compile for the wrong reason.
  const actions = {
    start: () => {},
    stop: () => {},
    newSession: () => {},
    requestMode: () => {},
    cycleLanguage: () => {},
    swapDirection: () => {},
    cycleProvider: () => {},
    setContextPolicy: () => {},
    reconnect: () => {},
  } as unknown as SessionActions;
  return {
    state: full,
    sourceText: 'I need to schedule an appointment',
    level: 2,
    armTag: deriveArmTag({ ...runConfig, providers: DEFAULT_CASCADE_TRIPLE }),
    runConfig,
    target: readyTarget(),
    footer: { utterances: 1, p50Ms: 980, p95Ms: 980, costUsd: 0.005, costCell: '$0.005' },
    elapsedMs: 12_000,
    // TICKET 049 — the healthy default. The degraded state is pinned by
    // LiveView.playbackFailure.test.tsx; here it must stay false so these
    // no-affordance tables keep describing an ordinary session.
    playbackUnavailable: false,
    playbackUnavailableReason: null,
    actions,
  };
}

/**
 * Anything an operator could press to start or stop the live feed. Deliberately
 * WIDER than `getByRole('button', { name: 'play' })`: a disabled button, a
 * `[role=button]` div, a toggle, or a `data-live-play` hook all count.
 * NOTE the leading-boundary-only regex: the old button's label was
 * "play2.1 s" (glyph + word + duration), which a trailing `\b` would MISS.
 * "autoplay" is still not a hit — no word boundary precedes its "play" — so
 * the elapsed strip's "autoplay on" caption (a caption, not a control) is safe.
 */
const PLAY_WORD = /(^|[^0-9a-z])(play|pause|resume|mute)/i;

function playAffordances(root: ParentNode = document): Element[] {
  const candidates = root.querySelectorAll(
    'button, [role="button"], input[type="checkbox"], input[type="button"], [data-live-play]',
  );
  return [...candidates].filter((el) => {
    if (el.hasAttribute('data-live-play')) return true;
    const label = `${el.textContent ?? ''} ${el.getAttribute('aria-label') ?? ''} ${
      el.getAttribute('title') ?? ''
    }`;
    return PLAY_WORD.test(label);
  });
}

/** The accessible name of the control this ticket deletes ("play2.1 s"). */
const PLAY_NAME = /^(play|pause)/i;

/** Every state in which the Live session area renders a populated card. */
const SESSION_STATES: Array<[label: string, patch: Partial<SessionState>]> = [
  ['listening', { status: 'listening' }],
  // 'speaking' in PRD language: an utterance is in flight through the model.
  ['speaking (processing)', { status: 'processing' }],
  ['ready', { status: 'ready' }],
  // Reachable only via the control this ticket deletes — pinned anyway, so a
  // reintroduced PLAY dispatch cannot bring the button back with it.
  ['playing', { status: 'playing' }],
  ['reconnecting', { status: 'reconnecting' }],
  ['disconnected', { status: 'disconnected' }],
  [
    'switch-queued',
    {
      status: 'listening',
      pending: { kind: 'mode', label: 'Cascade', patch: { mode: 'cascade' } },
    },
  ],
  ['stopping', { status: 'stopping' }],
  ['stopped', { status: 'stopped' }],
];

describe('Live renders NO play/pause control, in every session state (ticket 047)', () => {
  for (const [label, patch] of SESSION_STATES) {
    it(`${label}: no play/pause affordance — not even a disabled one`, () => {
      render(createElement(LiveView, { controller: stubController(patch) }));

      // The card really is populated, so this state genuinely exercised the
      // branch the button used to live in.
      expect(targetCard()).toHaveTextContent('Necesito programar una cita');

      expect(playAffordances().map((el) => text(el))).toEqual([]);
      expect(screen.queryByRole('button', { name: PLAY_NAME })).not.toBeInTheDocument();
    });
  }

  it('REGRESSION GUARD: no [data-live-play] hook in any state', () => {
    for (const [, patch] of SESSION_STATES) {
      const view = render(createElement(LiveView, { controller: stubController(patch) }));
      expect(document.querySelectorAll('[data-live-play]')).toHaveLength(0);
      view.unmount();
    }
  });
});

/* ===========================================================================
 * 2 — the duration readout survives the button
 * ======================================================================== */

describe('the utterance duration readout is KEPT — information, not a control', () => {
  const status: SessionStatus[] = ['listening', 'processing', 'ready', 'stopping', 'stopped'];

  for (const s of status) {
    it(`${s}: the target card shows [data-utterance-duration] = 2.1 s`, () => {
      render(createElement(LiveView, { controller: stubController({ status: s }) }));
      const readout = targetCard().querySelector('[data-utterance-duration]');
      expect(readout, 'the duration readout must survive the deleted button').not.toBeNull();
      expect(text(readout)).toBe('2.1 s');
      // ...and it is a readout, not the old button wearing a new hook.
      expect(readout!.closest('button')).toBeNull();
    });
  }

  it('it TRACKS the current utterance in a real session (0.0 s → 2.1 s)', async () => {
    vi.useFakeTimers();
    try {
      const kit = makeDeps({
        initialState: { mode: 'cascade' },
        scripts: { cascade: cascadeUtteranceScript() },
      });
      render(createElement(App, { deps: kit.deps }));
      await clickStartMicrophone();

      await advance(50); // utterance in flight — no audio queued yet
      expect(text(targetCard().querySelector('[data-utterance-duration]'))).not.toBe('2.1 s');

      await advance(1200); // audio arrived: 50400 samples @ 24 kHz = 2.1 s
      expect(text(targetCard().querySelector('[data-utterance-duration]'))).toBe('2.1 s');
    } finally {
      vi.useRealTimers();
    }
  });
});

/* ===========================================================================
 * 3 — audio plays with ZERO user action, in both arms
 * ======================================================================== */

interface RecordingPlaybackContext {
  context: PlaybackAudioContextLike;
  /** One entry per buffer source that was actually start()ed. */
  started: number[];
  suspends: number;
  resumes: number;
}

function recordingPlaybackContext(): RecordingPlaybackContext {
  const rec: RecordingPlaybackContext = {
    started: [],
    suspends: 0,
    resumes: 0,
    context: null as unknown as PlaybackAudioContextLike,
  };
  let length = 0;
  rec.context = {
    createBuffer: (_ch: number, len: number): PlaybackBufferLike => {
      length = len;
      return { getChannelData: () => new Float32Array(len) };
    },
    createBufferSource: (): PlaybackSourceLike => {
      const captured = length;
      return {
        buffer: null,
        connect: () => {},
        start: () => rec.started.push(captured),
        stop: () => {},
        onended: null,
      };
    },
    destination: {},
    currentTime: 0,
    resume: () => {
      rec.resumes += 1;
    },
    suspend: () => {
      rec.suspends += 1;
    },
  };
  return rec;
}

/**
 * ROUND 2 (R2-6) — a cascade utterance carrying THREE audio chunks.
 *
 * The shared fixture emits exactly ONE chunk, and that made the anti-suspend
 * assertion single-chunk-shallow: a `pause()` inserted BEFORE `enqueue` records
 * no suspend on the first chunk, because ArmPlayback creates its context
 * lazily inside `enqueue` and `this.context` is still null. From the second
 * chunk on it suspends on every chunk — and the suite stayed green.
 * Three chunks of 1.0 s each also let the assertion watch playback START as
 * each chunk lands, rather than only counting at the end.
 */
function multiChunkCascadeScript(): FixtureScriptEvent[] {
  const chunk = (): Int16Array => new Int16Array(24_000); // 1.0 s @ 24 kHz
  const base = cascadeUtteranceScript().filter((e) => e.type !== 'audio');
  const chunks: FixtureScriptEvent[] = [
    { at: 1055, type: 'audio', pcm: chunk(), utt: 0 },
    { at: 1065, type: 'audio', pcm: chunk(), utt: 0 },
    { at: 1075, type: 'audio', pcm: chunk(), utt: 0 },
  ];
  return [...base, ...chunks].sort((a, b) => a.at - b.at);
}

describe('translated audio plays immediately, with ZERO user action', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('CASCADE: EVERY chunk starts as it arrives, and nothing suspends the context', async () => {
    const kit = makeDeps({
      initialState: { mode: 'cascade' },
      scripts: { cascade: multiChunkCascadeScript() },
    });
    const rec = recordingPlaybackContext();
    kit.deps.playbackContextFactory = () => rec.context;
    render(createElement(App, { deps: kit.deps }));

    await clickStartMicrophone();

    // Chunk by chunk: playback is not merely "eventually started", it starts
    // as each chunk lands. A queue waiting for a press would sit at length 0.
    await advance(1060);
    expect(rec.started).toEqual([24_000]);
    expect(rec.suspends).toBe(0);

    await advance(10);
    expect(rec.started).toEqual([24_000, 24_000]);
    expect(rec.suspends).toBe(0);

    await advance(200);
    expect(rec.started).toEqual([24_000, 24_000, 24_000]);
    // The whole point: no chunk was preceded or followed by a suspend.
    expect(rec.suspends).toBe(0);
  });

  it('CASCADE: the AudioContext is RESUMED inside the Start gesture (autoplay-policy recovery)', async () => {
    // R2-3. `ArmPlayback.play()` is the client's only `ctx.resume()`, and with
    // the play button gone it had zero non-Replay callers — a context that
    // starts `suspended` under an autoplay policy could never recover, and the
    // operator has no affordance to recover it by hand. So `start` calls
    // play() once, inside the real user gesture. It reintroduces no control:
    // there is nothing to press and nothing to un-press.
    const kit = makeDeps({
      initialState: { mode: 'cascade' },
      scripts: { cascade: multiChunkCascadeScript() },
    });
    const rec = recordingPlaybackContext();
    kit.deps.playbackContextFactory = () => rec.context;
    render(createElement(App, { deps: kit.deps }));

    expect(rec.resumes).toBe(0); // not on render — only on the gesture

    await clickStartMicrophone();
    expect(rec.resumes).toBe(1);
    // Resuming is not playing: no audio has arrived yet, so nothing started.
    expect(rec.started).toEqual([]);
    expect(rec.suspends).toBe(0);
  });

  it('CASCADE: a THROWING playbackContextFactory must not stop the microphone (R3-1)', async () => {
    // R2-3 put `playback.play()` in the Start handler, which constructs the
    // AudioContext SYNCHRONOUSLY. `new AudioContext()` throws for real —
    // Chrome at the per-document limit (reachable after a dozen Replay
    // presses, which build one per play and never close it), Safari under some
    // policy states. Ordered before `requestCapture()`, that throw skipped the
    // microphone entirely: 0 calls on the first click and on every retry,
    // swallowed by React into a guarded callback, `micPermission` stuck at
    // 'requesting' so not even the denied card renders. Live silently dead.
    //
    // Autoplay recovery is BEST-EFFORT. The microphone is not.
    const capture = makeGrantingCapture();
    const kit = makeDeps({
      initialState: { mode: 'cascade' },
      // NO audio events: `enqueue` builds the context too, and a factory that
      // throws THERE has thrown since long before this ticket. R3-1 is about
      // the START path only — see the note at the bottom of this test.
      scripts: { cascade: cascadeUtteranceScript().filter((e) => e.type !== 'audio') },
      capture: capture.fn,
    });
    kit.deps.playbackContextFactory = () => {
      const err = new Error('the number of hardware contexts reached the maximum');
      err.name = 'NotSupportedError';
      throw err;
    };
    render(createElement(App, { deps: kit.deps }));

    await clickStartMicrophone();

    // The microphone was still requested, and the session reached a REAL
    // permission outcome rather than hanging in 'requesting' forever.
    expect(capture.fn).toHaveBeenCalledTimes(1);
    expect(micIndicator()).toHaveAttribute('data-mic-indicator', 'granted');
    expect(text(stateLabelEl())).not.toContain('requesting');

    // ...and the session goes on to RUN: the transport started, the utterance
    // flowed, the card settled. Not merely "no throw" — Live is alive.
    await advance(1300);
    expect(targetCard()).toHaveAttribute('data-target-status', 'ready');
    expect(screen.getByRole('button', { name: 'Stop session' })).toBeInTheDocument();

    // NOT pinned here, and pre-existing: a factory that throws is still fatal
    // at the first `enqueue`, because ArmPlayback builds its context lazily
    // there too. That was true before the Start-path resume existed and is not
    // what R3-1 decided; it is recorded so the next reader does not mistake
    // this test for full coverage of a hostile AudioContext.
  });

  it('REALTIME: the session runs end to end with no affordance to press', async () => {
    const kit = makeDeps({
      scripts: { realtime: realtimeUtteranceScript().filter((e) => e.type !== 'audio') },
    });
    render(createElement(App, { deps: kit.deps }));

    await clickStartMicrophone();
    await advance(1200);

    expect(targetCard()).toHaveAttribute('data-target-status', 'ready');
    expect(playAffordances().map((el) => text(el))).toEqual([]);
  });
});

/* ===========================================================================
 * 3b — the PRODUCTION wiring (round 2, R2-1)
 *
 * `browserDeps.ts` is where both halves of this ticket are actually delivered,
 * and it was the one file 047 never looked at. A reviewer rewrote the Live
 * forward to `getUserMedia({ audio: true })` and hard-muted every microphone
 * track, and the whole suite stayed green. These two tests are what close that.
 * ======================================================================== */

/** The realtime transport's injected deps bag, read off the instance. */
function realtimeDepsOf(transport: unknown): RealtimeDeps {
  return (transport as { deps: RealtimeDeps }).deps;
}

/** The AUDIBLE Live sink, read where production actually delivers it: the
 *  bag the transport factory constructs a realtime transport with. */
function productionLiveSink() {
  const transport = buildBrowserDeps().transportFactory({
    architecture: 'realtime',
    realtimeModel: REALTIME_MODEL,
    contextPolicy: 'default',
  });
  const sink = realtimeDepsOf(transport).remoteAudioSink;
  if (!sink) throw new Error('the LIVE realtime transport was built with no remoteAudioSink');
  return sink;
}

describe('the PRODUCTION Live wiring, not just the seam (round 2)', () => {
  const originalMediaDevices = Object.getOwnPropertyDescriptor(navigator, 'mediaDevices');

  afterEach(() => {
    if (originalMediaDevices) {
      Object.defineProperty(navigator, 'mediaDevices', originalMediaDevices);
    } else {
      delete (navigator as unknown as Record<string, unknown>).mediaDevices;
    }
    document.body.innerHTML = '';
  });

  it('buildBrowserDeps().startCapture forwards the EXACT constraints to the real getUserMedia', async () => {
    // The constraint object is only a requirement if the PRODUCTION forward
    // carries it. `startCapture` passing it to an injected fake proves nothing
    // about what `navigator.mediaDevices.getUserMedia` is actually asked for.
    const denial = new Error('Permission denied');
    denial.name = 'NotAllowedError';
    const getUserMedia = vi.fn(async () => Promise.reject(denial));
    Object.defineProperty(navigator, 'mediaDevices', {
      value: { getUserMedia },
      configurable: true,
    });

    // Denied on purpose: the grant path would need a real AudioContext and
    // AudioWorklet, and the constraints are requested before either exists.
    const result = await buildBrowserDeps().startCapture({ onChunk: () => {}, onLevel: () => {} });

    expect(result).toEqual({ status: 'denied', reason: 'blocked' });
    expect(getUserMedia).toHaveBeenCalledTimes(1);
    expect(getUserMedia).toHaveBeenCalledWith({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    });
  });

  it('the production Live sink PLAYS on attach — audible with no interaction', () => {
    // Realtime audio rides the WebRTC media track: `attach` is the whole
    // playback path, so `attach` alone must sound. (RealtimeTransport calling
    // attach on ontrack is pinned by transport/realtime.test.ts.)
    const play = vi
      .spyOn(window.HTMLMediaElement.prototype, 'play')
      .mockImplementation(() => Promise.resolve());
    document.body.innerHTML = '';
    try {
      productionLiveSink().attach({ getAudioTracks: () => [{ kind: 'audio' }] });

      expect(play).toHaveBeenCalledTimes(1);
      const el = [...document.querySelectorAll('audio')].at(-1) as HTMLAudioElement;
      expect(el.autoplay).toBe(true);
      expect(el.muted).toBe(false); // Live is the audible one
    } finally {
      play.mockRestore();
    }
  });
});

/* ===========================================================================
 * 4 — the play action is gone from the controller's SURFACE
 * ======================================================================== */

describe('the session controller exposes no play/pause action', () => {
  it('actions carries exactly nine keys — a dead action is a control someone re-wires', () => {
    const kit = makeDeps({ scripts: { realtime: realtimeUtteranceScript() } });
    const { result } = renderHook(() => useSessionController(kit.deps));

    const actions = result.current.actions as unknown as Record<string, unknown>;
    expect(Object.keys(actions).sort()).toEqual([
      'cycleLanguage',
      'cycleProvider',
      'newSession',
      'reconnect',
      'requestMode',
      'setContextPolicy',
      'start',
      'stop',
      'swapDirection',
    ]);
    expect(actions[GONE_ACTION]).toBeUndefined();
  });

  it('SessionDeps carries no remoteAudioSink either — a dead SEAM is the same landmine (R2-2)', () => {
    // The controller never read it. In production the sink Live hears is the
    // one browserDeps hands to the TRANSPORT factory, so this field was a
    // second, non-functional way to "wire Live's audio" sitting on the
    // controller's surface waiting to be believed.
    expect(readCode('src/client/views/useSessionController.ts')).not.toMatch(
      /\bremoteAudioSink\b/,
    );
    // ...and the fake plumbing that fed it is gone from the shared test kit.
    expect(readCode('src/client/views/sessionTestKit.ts')).not.toMatch(/\bremoteAudioSink\b/i);
  });
});

/* ===========================================================================
 * 5 — source-level guarantees
 * ======================================================================== */

describe('source-level guarantees — Live can never suspend its own audio', () => {
  const LIVE_FILES = ['src/client/views/LiveView.tsx', 'src/client/views/useSessionController.ts'];

  for (const file of LIVE_FILES) {
    it(`${file} calls no pause() / suspend() on any playback or sink`, () => {
      // The two idioms that leave Live audio suspended. NOTE the behavioural
      // partner above: bracket access (`sink['pause']()`) slips past a regex,
      // which is why the multi-chunk `suspends === 0` assertion exists.
      expect(readCode(file)).not.toMatch(/\.pause\s*\(/);
      expect(readCode(file)).not.toMatch(/\.suspend\s*\(/);
    });
  }

  /* -------------------------------------------------------------------------
   * R2-1 — the anti-gating guard now covers the files that actually HOLD a
   * MediaStreamTrack. Before round 2 it scanned capture.ts, the controller and
   * the view, none of which touch a track; the reviewer muted every microphone
   * track in browserDeps.ts with the suite green.
   * ---------------------------------------------------------------------- */
  const TRACK_HOLDING_FILES = [
    'src/client/audio/capture.ts',
    'src/client/views/useSessionController.ts',
    'src/client/views/LiveView.tsx',
    'src/client/browserDeps.ts',
    'src/client/transport/realtime.ts',
  ];

  /**
   * ROUND 3 (R3-2, R3-3, R3-4) — WHAT THIS GUARD IS AND IS NOT.
   *
   * It is a TRIPWIRE, not proof. Nothing drives a real `MediaStream` through
   * the Live capture path in jsdom, so there is no behavioural partner here the
   * way the multi-chunk `suspends === 0` assertion partners the pause grep. It
   * exists to make the OBVIOUS reintroduction loud, which is the failure mode
   * that actually happened: `t.enabled = false` (M6b), `t['enabled'] = false`
   * (M10), and the CAST form below.
   *
   * KNOWN ESCAPE ROUTES — written down rather than implied, so nobody reads a
   * green suite here as a guarantee:
   *   - a receiver this pattern does not recognise: `ts[0].enabled = false`
   *     and `ts[0]!.enabled = false` ARE caught (the `]`, and the `!` this
   *     codebase's strict indexing forces after it), but
   *     `for (const m of list) m.enabled = false` and
   *     `list.forEach((m) => { m.enabled = false; })` are NOT;
   *   - `Reflect.set(track, 'enabled', false)`, or a computed key;
   *   - a helper in a file outside TRACK_HOLDING_FILES.
   *
   * R3-2: bracket access is covered — that is how M10 slipped.
   * R3-3: the RECEIVER must be track-ish, so an unrelated `this.enabled =
   * false` in realtime.ts (~750 lines) does not fail a test whose message
   * claims barge-in was killed. A guard that fails for a reason other than the
   * one it states is worse than none.
   * R3-4 (this round): `)` and `]` count as track-ish receivers too. Narrowing
   * to NAMES alone reopened a hole round 2 did not have. `MediaTrackLike`
   * declares only `stop()` and `RtcMediaStreamLike.getAudioTracks()` returns
   * `unknown[]`, so inside capture.ts and realtime.ts a bare `track.enabled =`
   * does not even typecheck — the form an implementer would ACTUALLY have to
   * write is the cast, `(track as unknown as { enabled: boolean }).enabled =
   * false`, and that ends in `)`. The name-only guard fired solely on code that
   * could never compile. A non-null assertion may sit between the receiver and
   * the property (`getAudioTracks()[0]!.enabled`) — `noUncheckedIndexedAccess`
   * makes that the ordinary spelling here, so `!` is allowed through.
   * `this.enabled` still passes: its receiver token is `this`, with no `)` or
   * `]` before the property.
   */
  const GATES_A_TRACK =
    /(?:\b\w*(?:track|stream|mic|audio)\w*|\bt\b|\btr\b|\btrk\b|\)|\])\s*!?\s*(?:\.\s*enabled|\[\s*['"]enabled['"]\s*\])\s*=[^=]/i;

  for (const file of TRACK_HOLDING_FILES) {
    it(`${file} gates no microphone track — barge-in stays possible`, () => {
      // Input gating during output was CONSIDERED AND REJECTED: it kills
      // barge-in (hiding a real architectural difference between arms), it can
      // silently drop real speech, and it layers a second gate on the pinned
      // `silence_duration_ms: 500` VAD control.
      expect(matchingLines(readCode(file), GATES_A_TRACK)).toEqual([]);
    });
  }

  it('the ONLY muting assignment in the client is Replay’s silent <audio> element', () => {
    // Kept as an exact-line allow-list across ALL the files at once, rather
    // than a regex exemption: `el.muted = true` (which would silence the
    // operator) and `track.muted = true` (which is not even the same object)
    // both fail, because neither IS the allowed line.
    const found = TRACK_HOLDING_FILES.flatMap((file) =>
      matchingLines(readCode(file), /(?:\.\s*muted|\[\s*['"]muted['"]\s*\])\s*=[^=]/),
    );
    expect(found).toEqual(['el.muted = options.muted;']);
  });

  it('the stale comments that justified the deleted control are gone from browserDeps.ts (R2-3)', () => {
    // `browserDeps.ts:173` was not decoration: "a rejected autoplay is not a
    // failure worth surfacing — the operator still has the play button" is the
    // JUSTIFICATION for swallowing `play().catch(() => {})`. There is no play
    // button. A comment that asserts a lie about the recovery path is worse
    // than no comment.
    //
    // R3-4: scoped to the CLAIM, not the vocabulary. The previous version
    // banned the substring "play/pause" outright, which distorted the source —
    // a comment was visibly reworded to dodge it. Describing Replay's
    // play/pause seam is legitimate; asserting Live has a recovery affordance
    // is not.
    const raw = readSource('src/client/browserDeps.ts');
    expect(
      matchingLines(
        raw,
        /still has the play button|operator (still )?has[^.\n]*\bplay\b|Live's (own )?play/i,
      ),
    ).toEqual([]);
  });

  it("LiveView.tsx no longer advertises 'playing' as a [data-target-status] value (R2-4)", () => {
    // The removal itself is correct — nothing dispatches PLAY — but the DOM
    // contract at the top of the file still listed a value the view cannot
    // render, and that header is what the next author reads first.
    // R3-4: matched as an ENUMERATION (`[data-target-status] in ... 'playing'`)
    // rather than any mention of the word, so a note that the value USED to
    // exist — which is exactly the kind of history worth writing down — does
    // not fail the suite.
    const raw = readSource('src/client/views/LiveView.tsx');
    expect(
      matchingLines(raw, /\[data-target-status\][^\n]*\bin\b[^\n]*'playing'/),
    ).toEqual([]);
  });
});
