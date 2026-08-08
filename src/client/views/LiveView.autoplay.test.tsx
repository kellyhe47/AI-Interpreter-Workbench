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
 *  4. `actions.togglePlay` is GONE from the controller's surface — asserted on
 *     the LIVE HOOK, not on a string in a file.
 *  5. Source-level guards: Live invokes no pause()/suspend(), and nothing mutes
 *     or gates the microphone while output plays (input gating was CONSIDERED
 *     AND REJECTED — it kills barge-in and can drop real speech).
 *
 * Replay is untouched and stays covered by its own suites:
 * `RunsList.playGate.test.tsx` / `ReplayView.test.tsx` ([data-run-play]) and
 * `BlindCompare.test.tsx` (blind sample play). Those are on-demand playback of
 * a STORED run — "nothing autoplays in Replay" (PRD §7) — a different thing.
 */

import '@testing-library/jest-dom/vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { cleanup, render, renderHook, screen } from '@testing-library/react';
import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import App from '../App';
import { DEFAULT_CASCADE_TRIPLE, REALTIME_MODEL, deriveArmTag } from '../../core/arms';
import { buildBrowserDeps } from '../browserDeps';
import { stripComments } from '../deletions.test';
import type {
  PlaybackAudioContextLike,
  PlaybackBufferLike,
  PlaybackSourceLike,
} from '../audio/playback';
import { createInitialState, type SessionState, type SessionStatus } from '../state/sessionMachine';
import LiveView from './LiveView';
import {
  advance,
  cascadeUtteranceScript,
  clickStartMicrophone,
  makeDeps,
  makeFakeRemoteAudioSink,
  realtimeUtteranceScript,
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

const src = (file: string): string =>
  stripComments(readFileSync(resolve(process.cwd(), file), 'utf8'));

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
  // Cast, deliberately: the point of this ticket is that `togglePlay` leaves
  // SessionActions, and a stub typed against the current shape would make this
  // file fail to compile for the wrong reason.
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
    footer: { utterances: 1, p50Ms: 980, p95Ms: 980, costUsd: 0.005 },
    elapsedMs: 12_000,
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

describe('translated audio plays immediately, with ZERO user action', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('GUARD — CASCADE: enqueued PCM is start()ed as it arrives, never buffered pending a press', async () => {
    const kit = makeDeps({
      initialState: { mode: 'cascade' },
      scripts: { cascade: cascadeUtteranceScript() },
    });
    const rec = recordingPlaybackContext();
    kit.deps.playbackContextFactory = () => rec.context;
    render(createElement(App, { deps: kit.deps }));

    await clickStartMicrophone();
    await advance(1200);

    // Nobody clicked anything: the only press in this test was "Start
    // microphone". A queue waiting for play() would have started nothing.
    expect(rec.started).toEqual([50400]);
    // ...and nothing suspended it on the way.
    expect(rec.suspends).toBe(0);
  });

  it('REALTIME: the session runs end to end and the sink is NEVER paused', async () => {
    const audio = makeFakeRemoteAudioSink();
    const kit = makeDeps({
      scripts: { realtime: realtimeUtteranceScript().filter((e) => e.type !== 'audio') },
      remoteAudioSink: audio.sink,
    });
    render(createElement(App, { deps: kit.deps }));

    await clickStartMicrophone();
    await advance(1200);

    expect(targetCard()).toHaveAttribute('data-target-status', 'ready');
    // There is no affordance that could have paused it, and none was called.
    expect(playAffordances().map((el) => text(el))).toEqual([]);
    expect(audio.calls).not.toContain('pause');
  });

  it('REGRESSION GUARD: the production Live sink PLAYS on attach — audible with no interaction', () => {
    // Realtime audio rides the WebRTC media track: `attach` is the whole
    // playback path, so `attach` alone must sound. (RealtimeTransport calling
    // attach on ontrack is pinned by transport/realtime.test.ts.)
    const play = vi
      .spyOn(window.HTMLMediaElement.prototype, 'play')
      .mockImplementation(() => Promise.resolve());
    const elements = () => [...document.querySelectorAll('audio')] as HTMLAudioElement[];
    document.body.innerHTML = '';
    try {
      const sink = buildBrowserDeps().remoteAudioSink!;
      sink.attach({ getAudioTracks: () => [{ kind: 'audio' }] });

      expect(play).toHaveBeenCalledTimes(1);
      const el = elements().at(-1)!;
      expect(el.autoplay).toBe(true);
      expect(el.muted).toBe(false); // Live is the audible one
    } finally {
      play.mockRestore();
      document.body.innerHTML = '';
    }
  });
});

/* ===========================================================================
 * 4 — togglePlay is gone from the controller's SURFACE
 * ======================================================================== */

describe('the session controller exposes no togglePlay action', () => {
  it('actions carries no togglePlay — a dead action is a control someone re-wires', () => {
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
    expect(actions.togglePlay).toBeUndefined();
  });
});

/* ===========================================================================
 * 5 — source-level guarantees
 * ======================================================================== */

describe('source-level guarantees — Live can never suspend its own audio', () => {
  const LIVE_FILES = ['src/client/views/LiveView.tsx', 'src/client/views/useSessionController.ts'];

  for (const file of LIVE_FILES) {
    it(`${file} names no togglePlay/onTogglePlay in CODE`, () => {
      expect(src(file)).not.toMatch(/\b(togglePlay|onTogglePlay)\b/);
    });

    it(`${file} calls no pause() / suspend() on any playback or sink`, () => {
      // The two idioms that leave Live audio suspended.
      expect(src(file)).not.toMatch(/\.pause\s*\(/);
      expect(src(file)).not.toMatch(/\.suspend\s*\(/);
    });
  }

  it('REGRESSION GUARD: nothing in the Live path mutes or gates the microphone', () => {
    // Input gating during output was CONSIDERED AND REJECTED: it kills barge-in
    // (hiding a real architectural difference between arms), it can silently
    // drop real speech, and it layers a second gate on the pinned
    // `silence_duration_ms: 500` VAD control.
    for (const file of [
      'src/client/audio/capture.ts',
      'src/client/views/useSessionController.ts',
      'src/client/views/LiveView.tsx',
    ]) {
      const code = src(file);
      // `track.enabled = false` and `stream/element .muted = true` are the two
      // ways a client mutes its own microphone.
      expect(code, `${file} must not toggle track.enabled`).not.toMatch(/\.enabled\s*=/);
      expect(code, `${file} must not mute anything`).not.toMatch(/\.muted\s*=/);
    }
  });
});
