/**
 * TICKET 045 — the play control is gated on AUDIO EXISTING, not on status.
 *
 * ============================= THE PIN THIS REWRITES =======================
 * Ticket 013's DOM contract (ReplayView.tsx) said `[data-run-play]` is offered
 * on "complete only". That was true while `Run.outputAudioPath` was populated
 * only in fixtures — status was the best proxy available. It is now false in
 * both directions:
 *
 *   - A COMPLETE run may have no stored audio — every Arm A run did, until
 *     ticket 046 tapped the WebRTC media track its audio rides (Arm A now
 *     uploads like any other arm; a run whose output audio is genuinely empty,
 *     or whose upload failed, still lands here). Every such card offered a play
 *     button that answered 404 `run-audio-missing`. That is the defect tickets
 *     024 and 044 both ruled on: a control that cannot act must not look
 *     actionable.
 *   - A FAILED run may HAVE stored audio. A run that lost a stage after some
 *     output was synthesized keeps that partial audio, and it is diagnostic
 *     (PRD §12) — refusing to play it hides real information.
 *
 * So the gate is `run.outputAudioPath !== undefined`, and status governs only
 * what ticket 013 always used it for: the failure notice and the stage cells.
 * 013's "complete only" wording is superseded here, deliberately.
 * ==========================================================================
 *
 * NOTHING AUTOPLAYS (PRD §7) is unchanged and re-pinned below: rendering these
 * cards constructs no AudioContext and calls `onPlay` never.
 */
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DEFAULT_CASCADE_TRIPLE, REALTIME_MODEL } from '../../../core/arms';
import type { Recording, Run } from '../../state/ledger';
import RunsList from './RunsList';

afterEach(cleanup);

const T0 = 1_700_000_000_000;

const RECORDING: Recording = {
  id: 'rec-1',
  label: 'clip one',
  sourceLanguage: 'en',
  durationMs: 60_000,
  speechEndMs: 40_000,
  origin: 'corpus',
  createdAt: T0,
};

const TIMINGS = { speech_end: T0, vad_fired: T0 + 500, audio_queued: T0 + 1000 };

function makeRun(overrides: Partial<Run> & { id: string }): Run {
  return {
    recordingId: RECORDING.id,
    architecture: 'cascade',
    providerTriple: { ...DEFAULT_CASCADE_TRIPLE },
    modelSnapshots: { ...DEFAULT_CASCADE_TRIPLE },
    armTag: 'B',
    origin: 'sweep',
    status: 'complete',
    timings: { ...TIMINGS },
    transcripts: { source: 'hello', target: 'hola' },
    cost: 0.021,
    errors: [],
    createdAt: T0 + 1000,
    ...overrides,
  };
}

/** Arm A as it really is today: complete, and with no audio in the store. */
const REALTIME_NO_AUDIO: Run = makeRun({
  id: 'run-realtime',
  architecture: 'realtime',
  providerTriple: undefined,
  modelSnapshots: { realtime: REALTIME_MODEL },
  armTag: 'A',
});

/** The copy a card shows in place of a play control it cannot honour. */
const NO_AUDIO_NOTE = 'no output audio stored';

function mount(runs: Run[], onPlay = vi.fn()) {
  render(<RunsList recording={RECORDING} runs={runs} onPlay={onPlay} />);
  return { onPlay };
}

function card(id: string): HTMLElement {
  const found = document.querySelector<HTMLElement>(`[data-run-card][data-run="${id}"]`);
  expect(found).not.toBeNull();
  return found!;
}

/* ================================================================ the gate = */

describe('RunsList — [data-run-play] is gated on stored audio, not on status', () => {
  const cases: {
    label: string;
    run: Run;
    play: boolean;
    /** Status still governs the failure notice and the stage cells. */
    failureNotice: boolean;
  }[] = [
    {
      label: 'complete WITH stored audio — the ordinary cascade card',
      run: makeRun({ id: 'run-complete-audio', outputAudioPath: 'runs/run-complete-audio.out.wav' }),
      play: true,
      failureNotice: false,
    },
    {
      label: 'complete WITHOUT stored audio — Arm A today; a play button here 404s',
      run: REALTIME_NO_AUDIO,
      play: false,
      failureNotice: false,
    },
    {
      label: 'failed WITH stored audio — partial output is diagnostic (PRD §12)',
      run: makeRun({
        id: 'run-failed-audio',
        status: 'failed',
        errors: ['tts: stage timed out for this utterance'],
        outputAudioPath: 'runs/run-failed-audio.out.wav',
      }),
      play: true,
      failureNotice: true,
    },
    {
      label: 'failed WITHOUT stored audio — produced neither audio nor figures',
      run: makeRun({
        id: 'run-failed-silent',
        status: 'failed',
        errors: ['tts: stage timed out for this utterance'],
      }),
      play: false,
      failureNotice: true,
    },
  ];

  it.each(cases)('$label', ({ run, play, failureNotice }) => {
    mount([run]);
    const el = card(run.id);

    expect(el.querySelector('[data-run-play]') !== null).toBe(play);
    if (play) {
      expect(within(el).getByRole('button', { name: 'play' })).toBeInTheDocument();
    } else {
      // Absent, not disabled — and the card SAYS why, rather than leaving a
      // silent gap where a control used to be.
      expect(el.querySelector('[data-run-no-audio]')).not.toBeNull();
      expect(el.querySelector('[data-run-no-audio]')!.textContent).toContain(NO_AUDIO_NOTE);
    }

    // Ticket 013, unchanged: STATUS still decides the failure notice and
    // whether stage figures are shown at all.
    expect(el.querySelector('[data-run-failure]') !== null).toBe(failureNotice);
    expect(el.querySelectorAll('[data-run-stage]').length > 0).toBe(!failureNotice);
  });

  it('a stored-audio card plays only that run, and only on click', () => {
    const withAudio = makeRun({ id: 'run-a', outputAudioPath: 'runs/run-a.out.wav' });
    const { onPlay } = mount([withAudio, REALTIME_NO_AUDIO]);

    expect(onPlay).not.toHaveBeenCalled();
    fireEvent.click(within(card('run-a')).getByRole('button', { name: 'play' }));
    expect(onPlay.mock.calls).toEqual([['run-a']]);
  });
});

/* ====================================================== nothing autoplays == */

describe('RunsList — rendering the gate constructs no AudioContext', () => {
  let audioContexts = 0;

  beforeEach(() => {
    audioContexts = 0;
    class SpyAudioContext {
      constructor() {
        audioContexts += 1;
      }
    }
    vi.stubGlobal('AudioContext', SpyAudioContext);
    vi.stubGlobal('webkitAudioContext', SpyAudioContext);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('mounting cards with and without stored audio plays nothing at all', () => {
    const { onPlay } = mount([
      makeRun({ id: 'run-a', outputAudioPath: 'runs/run-a.out.wav' }),
      REALTIME_NO_AUDIO,
    ]);

    expect(audioContexts).toBe(0);
    expect(onPlay).not.toHaveBeenCalled();
    expect(document.querySelectorAll('audio[autoplay], video[autoplay]')).toHaveLength(0);
  });
});
