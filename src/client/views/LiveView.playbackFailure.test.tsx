/**
 * Ticket 049 — a hostile AudioContext is a DEGRADED Live session, not a dead one.
 *
 * Ticket 047 R3-1 fixed the Start-gesture path and left an in-file note saying
 * so: `ArmPlayback` builds its context lazily inside `enqueue`, so with a
 * throwing `AudioContext` the FIRST TTS chunk throws from inside the transport's
 * `onAudio` callback, where nothing catches it. A reviewer reproduced it against
 * the pre-047 snapshot: `advance threw: NotSupportedError`, card stuck at
 * `ready` with 0 utterances.
 *
 * WHAT THIS FILE PINS
 *  1. Cascade: the session survives the first chunk and every later one.
 *  2. The operator is TOLD — `[data-playback-notice]`, a surfaced, non-fatal
 *     state carrying verbatim copy, driven by `controller.playbackUnavailable`.
 *     It is NOT a console.warn and NOT a silent swallow.
 *  3. MEASUREMENT IS UNTOUCHED: the ledger record, the footer figures and the
 *     `[data-utterance-duration]` readout are identical to the healthy run.
 *     Sound is not a measurement.
 *  4. Realtime is unaffected: nothing is enqueued there (audio rides the
 *     `remoteAudioSink` element), so no notice appears even though the very
 *     same hostile factory is wired.
 *  5. The notice reintroduces NO control — ticket 047 deleted Live's
 *     play/pause deliberately and this must not be the excuse to bring it back.
 *
 * The Start-path half of the criterion (047 R3-1) stays green in
 * LiveView.autoplay.test.tsx and is not duplicated here.
 */

import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import App from '../App';
import type { UtteranceRecord } from '../../core/timing';
import type { PlaybackAudioContextLike } from '../audio/playback';
import type { RunLedger } from '../state/ledger';
import {
  advance,
  cascadeUtteranceScript,
  clickStartMicrophone,
  makeDeps,
  makeFakePlaybackContext,
  makeGrantingCapture,
  micIndicator,
  realtimeUtteranceScript,
  sessionFooter,
  targetCard,
  text,
} from './sessionTestKit';

afterEach(cleanup);

/**
 * The surfaced state, verbatim. It says three things on purpose: WHAT was lost
 * (the sound), that the session is STILL RUNNING and STILL MEASURED, and that
 * nothing here is a measurement failure.
 */
const NOTICE_COPY =
  'No audio output — this browser refused a new audio context. The session is still running and still being measured; only the sound is missing.';

const notice = (): HTMLElement | null =>
  document.querySelector('[data-playback-notice]') as HTMLElement | null;

/** The real throw, verbatim from Chrome at its per-document context limit. */
function hostileFactory(): () => PlaybackAudioContextLike {
  return () => {
    const err = new Error('the number of hardware contexts reached the maximum');
    err.name = 'NotSupportedError';
    throw err;
  };
}

interface RunOptions {
  hostile: boolean;
  mode?: 'cascade' | 'realtime';
  /** Realtime never delivers PCM — its audio is on the media track. */
  dropAudio?: boolean;
}

function startSession(opts: RunOptions) {
  const capture = makeGrantingCapture();
  const mode = opts.mode ?? 'cascade';
  const full = mode === 'cascade' ? cascadeUtteranceScript() : realtimeUtteranceScript();
  const script = opts.dropAudio ? full.filter((e) => e.type !== 'audio') : full;
  const kit = makeDeps({
    initialState: { mode },
    scripts: mode === 'cascade' ? { cascade: script } : { realtime: script },
    capture: capture.fn,
  });
  kit.deps.playbackContextFactory = opts.hostile ? hostileFactory() : makeFakePlaybackContext;
  const view = render(createElement(App, { deps: kit.deps }));
  return { ...kit, capture, view };
}

/** Every utterance record this session appended, in order. */
function recordsOf(ledger: RunLedger): UtteranceRecord[] {
  return ledger.exportRuns().runs.flatMap((run) => run.records);
}

describe('a hostile AudioContext does not kill a Live session (ticket 049)', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('CASCADE: the first audio chunk does not wedge the session — it settles and runs on', async () => {
    const kit = startSession({ hostile: true });
    await clickStartMicrophone();

    // The chunk lands at 1055 ms; the completion at 1100 ms.
    await advance(1300);

    expect(kit.capture.fn).toHaveBeenCalledTimes(1);
    expect(micIndicator()).toHaveAttribute('data-mic-indicator', 'granted');
    expect(targetCard()).toHaveAttribute('data-target-status', 'ready');
    expect(screen.getByRole('button', { name: 'Stop session' })).toBeInTheDocument();
    // The transcript arrived and the utterance was RECORDED — not merely "no
    // throw". The reviewer's pre-fix probe got 0 utterances here.
    expect(targetCard()).toHaveTextContent('Necesito programar una cita');
    expect(recordsOf(kit.ledger)).toHaveLength(1);
  });

  it('CASCADE: a SECOND utterance still flows after the first chunk failed', async () => {
    // "not on the first or any later audio chunk" — a fix that survived chunk
    // one by luck and threw on chunk two would pass the test above.
    const capture = makeGrantingCapture();
    const kit = makeDeps({
      initialState: { mode: 'cascade' },
      scripts: {
        cascade: [
          ...cascadeUtteranceScript({ utt: 0 }),
          ...cascadeUtteranceScript({ utt: 1, base: 2000 }),
        ],
      },
      capture: capture.fn,
    });
    kit.deps.playbackContextFactory = hostileFactory();
    render(createElement(App, { deps: kit.deps }));

    await clickStartMicrophone();
    await advance(3400);

    expect(targetCard()).toHaveAttribute('data-target-status', 'ready');
    expect(recordsOf(kit.ledger).map((r) => r.id)).toEqual(['utt-0', 'utt-1']);
  });

  it('the OPERATOR IS TOLD: [data-playback-notice] appears when sound is actually lost', async () => {
    const kit = startSession({ hostile: true });
    await clickStartMicrophone();

    // Before any audio: nothing is lost yet, so nothing is claimed. (The Start
    // gesture's resume already failed by now — that alone must not raise it.)
    await advance(600);
    expect(notice()).toBeNull();

    await advance(700); // the chunk at 1055 ms
    const el = notice();
    expect(el, 'a failed playback context must be SURFACED, not swallowed').not.toBeNull();
    expect(text(el)).toBe(NOTICE_COPY);
    // Non-fatal, and it says so: the session is not stopped and not failed.
    expect(targetCard()).toHaveAttribute('data-target-status', 'ready');
    expect(screen.getByRole('button', { name: 'Stop session' })).toBeInTheDocument();
    expect(kit.ledger.exportRuns().runs).toHaveLength(1);
  });

  it('REGRESSION GUARD: a healthy context surfaces no notice at all', async () => {
    startSession({ hostile: false });
    await clickStartMicrophone();
    await advance(1300);

    expect(notice()).toBeNull();
    expect(targetCard()).toHaveAttribute('data-target-status', 'ready');
  });

  it('MEASUREMENT IS UNTOUCHED: record, duration readout and footer match the healthy run', async () => {
    // Sound is not a measurement. Same script, same clock, two playback
    // contexts — one working, one hostile — must measure identically.
    const healthy = startSession({ hostile: false });
    await clickStartMicrophone();
    await advance(1300);
    const healthyRecords = recordsOf(healthy.ledger);
    const healthyDuration = text(targetCard().querySelector('[data-utterance-duration]'));
    const healthyFooter = text(sessionFooter());
    cleanup();

    const degraded = startSession({ hostile: true });
    await clickStartMicrophone();
    await advance(1300);

    expect(recordsOf(degraded.ledger)).toEqual(healthyRecords);
    // 50400 samples @ 24 kHz = 2.1 s. ArmPlayback counts samples it could not
    // sound exactly as it counts samples it did.
    expect(healthyDuration).toBe('2.1 s');
    expect(text(targetCard().querySelector('[data-utterance-duration]'))).toBe(healthyDuration);
    expect(text(sessionFooter())).toBe(healthyFooter);
  });

  it('REALTIME GUARD: the same hostile factory raises no notice — realtime is unaffected', async () => {
    // Labelled a GUARD because it is green before the implementation exists
    // (nothing renders a notice yet). It is not vacuous: it is the test that
    // kills the NAIVE design — reporting from `play()` as well as `enqueue` —
    // which was mutated in and turned this red.
    // Realtime audio arrives on the WebRTC media track and never as PCM, so
    // ArmPlayback stays empty and the sound rides `remoteAudioSink`. The Start
    // gesture still tries to build a context and still fails — reporting THAT
    // would put "no audio output" on screen during an audible session.
    const kit = startSession({ hostile: true, mode: 'realtime', dropAudio: true });
    await clickStartMicrophone();
    await advance(1200);

    expect(notice()).toBeNull();
    expect(targetCard()).toHaveAttribute('data-target-status', 'ready');
    expect(recordsOf(kit.ledger)).toHaveLength(1);
  });

  it('the notice is a READOUT — it reintroduces no play/pause control (ticket 047)', async () => {
    startSession({ hostile: true });
    await clickStartMicrophone();
    await advance(1300);

    const el = notice();
    expect(el).not.toBeNull();
    // Not a control, and not a wrapper around one: 047 deleted Live's transport
    // affordance on purpose, and a degraded-audio banner is not a reason for a
    // "retry playback" button that would need a fresh user gesture anyway.
    expect(el!.querySelector('button, [role="button"], [data-live-play]')).toBeNull();
    expect(el!.closest('button')).toBeNull();
    expect(document.querySelectorAll('[data-live-play]')).toHaveLength(0);
  });
});
