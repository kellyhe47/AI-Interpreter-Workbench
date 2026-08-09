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

/* =========================================================================
 * TICKET 059 — THE REPLAY RUN CARD, THE SECOND SURFACE THAT STILL SAYS $0.000.
 *
 * `formatPerMinute` already carries 052's guard:
 *
 *     if (cost === null) return COST_NOT_MEASURED_CELL;
 *
 * The guard is real and it NEVER FIRES, because every stored `run.cost` is `0`,
 * not `null` — the three Runs in `data/runs/` were written by a build with no
 * cost model at all, and `0` was what it hardcoded. So both complete cards
 * render `$0.000/min`: two takes reporting the configuration as free.
 *
 * `LiveSession` solved this with a `pricingVersion` stamp that `liveCostOf`
 * reads as the discriminator. The Run gets the same stamp, and the card reads
 * it — never a per-surface special case, and never a rule that says "0 means
 * absent", which would delete the distinction from the other side.
 * ====================================================================== */

import { COST_NOT_MEASURED_CELL, PRICING_VERSION } from '../../../core/pricing';

/** What a cost cell says when nobody could price it. Never `$0.00`. */
const NOT_MEASURED = COST_NOT_MEASURED_CELL;

/** TICKET 059 — the `Run` shape with the stamp, as a widening of today's. */
type StampedRun = Run & { pricingVersion?: string };

/** A run written by TODAY's code: it declares the price source it ran under. */
function stampedRun(overrides: Partial<Run> & { id: string }): Run {
  const run = makeRun(overrides);
  (run as StampedRun).pricingVersion = PRICING_VERSION;
  return run;
}

/** A run as the three in `data/runs/` are: `cost: 0`, no price source at all. */
function unstampedRun(overrides: Partial<Run> & { id: string }): Run {
  return makeRun(overrides);
}

/** The `$/min` cell of a run card. */
function costOf(runId: string): string {
  const cell = card(runId).querySelector('[data-run-cost]');
  expect(cell, `run ${runId} has no [data-run-cost]`).not.toBeNull();
  return (cell!.textContent ?? '').trim();
}

describe('TICKET 059 — a run card prices from the STAMP, never from the zero', () => {
  it('a run written TODAY whose measured cost really is 0 still reads $0.000/min', () => {
    // THE HALF THAT KEEPS THE FIX FROM DEGENERATING INTO "0 MEANS ABSENT". A
    // configuration that really did cost nothing has to be able to say so, and
    // a fix that reads every zero as an absence fails here — as it must.
    mount([stampedRun({ id: 'run-real-zero', cost: 0 })]);

    // RECORDING.durationMs is 60_000, so $/min is the Run cost verbatim.
    expect(costOf('run-real-zero')).toBe('$0.000/min');
    expect(costOf('run-real-zero')).not.toContain(NOT_MEASURED);
  });

  it('a stored, UNSTAMPED run reads not measured — never $0.000/min', () => {
    mount([unstampedRun({ id: 'run-stored-zero', cost: 0 })]);

    expect(costOf('run-stored-zero')).toBe(NOT_MEASURED);
    expect(costOf('run-stored-zero')).not.toContain('$0.000');
    expect(costOf('run-stored-zero')).not.toContain('/min');
  });

  it('an unstamped run with a NON-zero stored cost is unpriced too', () => {
    // The stamp is the discriminator, not the value — in both directions. A
    // figure written by a build that declared no rate source is not a
    // measurement just because it happens to be non-zero.
    mount([unstampedRun({ id: 'run-stored-nonzero', cost: 0.021 })]);

    expect(costOf('run-stored-nonzero')).toBe(NOT_MEASURED);
    expect(costOf('run-stored-nonzero')).not.toContain('$0.021');
  });

  it('still normalizes a stamped, priced run per audio minute', () => {
    // The regression guard: the gate must not swallow a real figure, and $/min
    // is still NORMALIZED rather than copied off the Run.
    mount([stampedRun({ id: 'run-priced', cost: 0.021 })]);
    expect(costOf('run-priced')).toBe('$0.021/min');
  });

  it('an unmeasured cost is still not a cheap run — the 052 guard survives', () => {
    mount([stampedRun({ id: 'run-null-cost', cost: null as unknown as number })]);
    expect(costOf('run-null-cost')).toBe(NOT_MEASURED);
  });

  it('renders no $0.00 anywhere in a list of unstamped cards', () => {
    // The eval's own check at the surface it names: `must_not_contain`
    // ["$0.000", "$0.00", "0.000/min"], `must_include` "not measured".
    mount([
      unstampedRun({ id: 'run-u1', cost: 0 }),
      unstampedRun({ id: 'run-u2', cost: 0, architecture: 'realtime', armTag: 'A' }),
    ]);

    expect(document.body.textContent).toContain(NOT_MEASURED);
    expect(document.body.textContent).not.toContain('$0.00');
    expect(document.body.textContent).not.toContain('0.000/min');
  });
});
