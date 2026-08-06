/**
 * Ticket 036 — RTL tests for the "Record new clip" flow.
 *
 * This file EXTENDS the ticket-013 spec in ReplayView.test.tsx and the
 * 020/024 spec in ReplayView.failures.test.tsx; it restates neither.
 *
 * PRD §7 step 1 — "Record a clip — maximum 1 minute. It is saved and appears in
 * the UI" — was never built: [data-record-new] was a disabled caption. This is
 * the flow that makes the app able to ingest its own primary input, so five
 * rules run through every test here:
 *
 *  1. NOTHING IS GLOBAL, AND NOTHING TOUCHES A MICROPHONE. `startTake`,
 *     `segmentTake`, take playback and the recordings client all arrive through
 *     `deps`. No test constructs an AudioContext or calls getUserMedia.
 *  2. SEGMENTATION IS A SUGGESTION, NEVER THE RECORD. Every detected boundary
 *     is shown and editable, and utterances can be added and removed. A wrong
 *     boundary mis-attributes every later category finding (README-v3-corpus,
 *     "the load-bearing risk"), so the operator confirms it, not the VAD.
 *  3. AN INVALID MANIFEST IS IMPOSSIBLE TO SUBMIT. The save control is gated by
 *     the REAL `validateManifest` (src/core/corpus.ts) and states the reason;
 *     the server's 400 must never be the first the operator hears of it.
 *  4. ONE MIC-DENIAL COPY. The remediation names BOTH layers — the browser site
 *     permission and the OS privacy setting — plus the no-re-prompt sentence,
 *     and it is the SAME text the Live view shows, shared as constants. A
 *     second, weaker copy is a test failure.
 *  5. NOTHING AUTOPLAYS (PRD §7). Recording and review construct no
 *     AudioContext and call no playback seam; the take sounds from a click.
 *
 * ======================= DOM CONTRACT THIS FILE ADDS =======================
 * [data-record-new] — now ENABLED (given the capture seams) and opens the flow.
 *
 * RecordTake [data-record-take][data-record-stage='armed'|'recording'|'review'|'denied']
 *   armed / recording:
 *     [data-record-cap-note]      CAP_NOTE, verbatim
 *     [data-record-elapsed]       'M:SS / 1:00'
 *     [data-record-level][data-level='0'..'5']   mic level, recording only
 *     [data-record-start]         button 'Start recording'   (armed)
 *     [data-record-stop]          button 'Stop recording'    (recording)
 *     [data-record-cancel]        button 'Cancel take'       (both, and review)
 *   review:
 *     [data-record-cap-reached]   CAP_REACHED — only when the cap stopped it
 *     [data-take-duration]        the take's length
 *     [data-record-play]          button 'Play take' → deps.playTake(take)
 *     [data-take-label]           textbox 'Clip label'
 *     [data-take-language]        select 'Source language' — en | es | yue
 *     [data-segmentation-note]    SEGMENTATION_NOTE, verbatim
 *     [data-utterance-row][data-utterance-index=<1-based>], each holding
 *       [data-utterance-start]      number input 'Utterance {i} start (ms)'
 *       [data-utterance-end]        number input 'Utterance {i} speech end (ms)'
 *       [data-utterance-category]   select 'Utterance {i} category', one option
 *                                   per CORPUS_CATEGORIES plus an empty
 *                                   'untagged' placeholder
 *       [data-utterance-reference]  textbox 'Utterance {i} reference text' —
 *                                   EN/ES ONLY; ABSENT for yue
 *       [data-utterance-remove]     button 'Remove utterance {i}'
 *     [data-utterance-add]        button 'Add utterance'
 *     [data-reference-withheld]   REFERENCE_WITHHELD, yue only
 *     [data-save-corpus]          button 'Save as corpus clip'
 *     [data-save-adhoc]           button 'Save as ad-hoc clip'
 *     [data-save-blocked]         the reason the corpus save is refused —
 *                                 ABSENT when nothing blocks it. The same text
 *                                 is [data-save-corpus]'s `title` while it is
 *                                 `disabled`.
 *   denied:
 *     [data-record-denied]        the two-layer remediation, from the SHARED
 *                                 src/client/copy/micDenial.ts constants.
 * ==========================================================================
 */

// Imported directly (in addition to vitest.setup.ts) so the jest-dom matcher
// type augmentation is visible to `tsc -p tsconfig.json`, whose include does
// not cover the setup file.
import '@testing-library/jest-dom/vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CORPUS_CATEGORIES,
  validateManifest,
  type CorpusUtterance,
} from '../../core/corpus';
import {
  MIC_DENIED_HEADING,
  MIC_DENIED_NO_REPROMPT,
  MIC_DENIED_OS_SETTING,
  MIC_DENIED_SITE_PERMISSION,
} from '../copy/micDenial';
import {
  MAX_TAKE_MS,
  type CaptureDenied,
  type RecordedTake,
  type TakeRecorder,
} from '../replay/capture';
import type { SegmentedUtterance } from '../replay/segment';
import type {
  NewRecordingInput,
  RecordingsClient,
  RunsClient,
} from '../replay/recordingsClient';
import type { Recording, Run } from '../state/ledger';
import ReplayView, { type ReplayDeps, type ReplayTakeOptions } from './ReplayView';

afterEach(cleanup);

/* ================================================================== copy == */

const RECORD_NEW = 'Record new clip · max 1 min';

/** The affordance states the cap it ENFORCES — ticket 035 clamps to MAX_TAKE_MS. */
const CAP_NOTE = 'Maximum 1 minute — the take stops itself at the cap.';

/** Shown only when the cap, not the operator, ended the take. */
const CAP_REACHED = 'Stopped at the 1 minute cap.';

const SEGMENTATION_NOTE = 'Segmentation is a suggestion — check every boundary before saving.';

const BLOCKED_CATEGORY =
  'Every utterance needs a category before this take can be saved as corpus.';

const BLOCKED_REFERENCE =
  'Every English or Spanish utterance needs its verbatim reference text — WER is scored against it.';

/** PRD §9: Cantonese is improvised, so there is no script to score WER against. */
const REFERENCE_WITHHELD =
  'Cantonese is improvised from English prompt cards — there is no written script, ' +
  'so no reference text and no WER.';

/* ============================================================== fixtures == */

/** 2026-02-03T09:41:00Z. */
const T0 = Date.UTC(2026, 1, 3, 9, 41, 0);

const CORPUS_VERSION_UNDER_TEST = 'corpus-v-test';

const EXISTING_REC: Recording = {
  id: 'rec-existing',
  label: 'clinic intake · corpus',
  sourceLanguage: 'en',
  durationMs: 60_000,
  speechEndMs: 59_000,
  origin: 'corpus',
  createdAt: T0,
};

/** What the server hands back for the clip this flow records. */
const SAVED_REC: Recording = {
  id: 'rec-recorded',
  label: 'pharmacy counter · take 1',
  sourceLanguage: 'en',
  durationMs: 12_000,
  speechEndMs: 11_000,
  origin: 'corpus',
  createdAt: T0 + 1,
};

const TAKE_MS = 12_000;

/** Distinctive bytes, so the POSTed base64 can be decoded and compared. */
const WAV_BYTES = new Uint8Array([82, 73, 70, 70, 9, 7, 3, 1]);

function makeTake(durationMs = TAKE_MS): RecordedTake {
  // 24 kHz mono: 24 samples per millisecond. Content is irrelevant here —
  // segmentation is INJECTED, never recomputed by the view.
  return { samples: new Int16Array(24 * durationMs), wav: WAV_BYTES, durationMs };
}

/** Three utterances, comfortably inside a 12 s take. */
const SEGMENTS: SegmentedUtterance[] = [
  { index: 1, startMs: 200, trueSpeechEndMs: 3_000 },
  { index: 2, startMs: 4_000, trueSpeechEndMs: 7_000 },
  { index: 3, startMs: 8_000, trueSpeechEndMs: 11_000 },
];

/* =============================================================== helpers == */

const q = (selector: string): HTMLElement | null => document.querySelector<HTMLElement>(selector);

function get(selector: string): HTMLElement {
  const found = q(selector);
  if (!found) throw new Error(`missing element: ${selector}`);
  return found;
}

const all = (selector: string): HTMLElement[] =>
  Array.from(document.querySelectorAll<HTMLElement>(selector));

const text = (element: Element | null): string => (element?.textContent ?? '').trim();

const utteranceRows = (): HTMLElement[] => all('[data-utterance-row]');

function utteranceRow(index: number): HTMLElement {
  return get(`[data-utterance-row][data-utterance-index="${index}"]`);
}

function field(index: number, name: string): HTMLElement {
  const found = utteranceRow(index).querySelector<HTMLElement>(`[${name}]`);
  if (!found) throw new Error(`utterance ${index} has no [${name}]`);
  return found;
}

const decodeBase64 = (value: string): Uint8Array =>
  Uint8Array.from(atob(value), (character) => character.charCodeAt(0));

/* ================================================================ fakes === */

interface TakeProbe {
  options: ReplayTakeOptions;
  recorder: { stop: ReturnType<typeof vi.fn>; cancel: ReturnType<typeof vi.fn> };
}

function makeFakes(
  options: {
    recordings?: Recording[];
    take?: RecordedTake;
    segments?: SegmentedUtterance[];
    denial?: CaptureDenied;
    /** Omits startTake/segmentTake/playTake — a host with no capture seams. */
    withoutCaptureSeams?: boolean;
  } = {},
) {
  const store = { recordings: (options.recordings ?? []).map((r) => ({ ...r })) };
  const take = options.take ?? makeTake();

  const recordings = {
    list: vi.fn(async () => store.recordings.map((r) => ({ ...r }))),
    get: vi.fn(async (id: string) => ({ ...store.recordings.find((r) => r.id === id)! })),
    getAudio: vi.fn(async () => new Uint8Array()),
    create: vi.fn(async (_input: NewRecordingInput) => {
      const created = { ...SAVED_REC };
      store.recordings.push(created);
      return { ...created };
    }),
    patchLabel: vi.fn(async (id: string, label: string) => {
      const found = store.recordings.find((r) => r.id === id)!;
      found.label = label;
      return { ...found };
    }),
    remove: vi.fn(async (id: string) => {
      const found = store.recordings.find((r) => r.id === id)!;
      found.deletedAt = T0 + 999;
      return { ...found };
    }),
  };

  const runs = {
    create: vi.fn(async (run: Run) => run),
    list: vi.fn(async () => [] as Run[]),
    getAudio: vi.fn(async () => new Uint8Array()),
  };

  const takes: TakeProbe[] = [];
  const startTake = vi.fn(
    async (takeOptions: ReplayTakeOptions): Promise<TakeRecorder | CaptureDenied> => {
      const recorder = { stop: vi.fn(async () => take), cancel: vi.fn() };
      takes.push({ options: takeOptions, recorder });
      if (options.denial) return options.denial;
      return recorder as unknown as TakeRecorder;
    },
  );

  const segmentTake = vi.fn(
    (_samples: Int16Array): SegmentedUtterance[] =>
      (options.segments ?? SEGMENTS).map((s) => ({ ...s })),
  );

  const playTake = vi.fn();

  let ids = 0;

  const deps: ReplayDeps = {
    recordings: recordings as unknown as RecordingsClient,
    runs: runs as unknown as RunsClient,
    runOnce: vi.fn() as unknown as ReplayDeps['runOnce'],
    startBatch: vi.fn() as unknown as ReplayDeps['startBatch'],
    playRun: vi.fn(),
    now: () => T0,
    newId: () => `id-${(ids += 1)}`,
    ...(options.withoutCaptureSeams
      ? {}
      : {
          startTake: startTake as unknown as ReplayDeps['startTake'],
          segmentTake: segmentTake as unknown as ReplayDeps['segmentTake'],
          playTake,
          corpusVersion: CORPUS_VERSION_UNDER_TEST,
        }),
  };

  return { deps, store, recordings, runs, startTake, segmentTake, playTake, takes, take };
}

type Fakes = ReturnType<typeof makeFakes>;

async function mount(options: Parameters<typeof makeFakes>[0] = {}): Promise<Fakes> {
  const fakes = makeFakes({ recordings: [EXISTING_REC], ...options });
  render(<ReplayView deps={fakes.deps} />);
  await waitFor(() => expect(q('[data-recordings-library]')).not.toBeNull());
  return fakes;
}

/** Opens the flow. The panel is absent until the button is pressed. */
async function openFlow(): Promise<void> {
  fireEvent.click(screen.getByRole('button', { name: RECORD_NEW }));
  await waitFor(() => expect(q('[data-record-take]')).not.toBeNull());
}

/** Opens, records and stops — leaving the flow at the review stage. */
async function recordAndStop(fakes: Fakes): Promise<TakeProbe> {
  await openFlow();
  fireEvent.click(screen.getByRole('button', { name: 'Start recording' }));
  await waitFor(() => expect(fakes.startTake).toHaveBeenCalledTimes(1));
  await waitFor(() => expect(get('[data-record-take]')).toHaveAttribute('data-record-stage', 'recording'));
  fireEvent.click(screen.getByRole('button', { name: 'Stop recording' }));
  await waitFor(() => expect(utteranceRows().length).toBeGreaterThan(0));
  return fakes.takes[0]!;
}

function setLanguage(code: string): void {
  fireEvent.change(get('[data-take-language]'), { target: { value: code } });
}

function setCategory(index: number, category: string): void {
  fireEvent.change(field(index, 'data-utterance-category'), { target: { value: category } });
}

function setReference(index: number, value: string): void {
  fireEvent.change(field(index, 'data-utterance-reference'), { target: { value } });
}

function setBoundary(index: number, which: 'start' | 'end', ms: number): void {
  fireEvent.change(field(index, `data-utterance-${which}`), { target: { value: String(ms) } });
}

/** Tags every row so a corpus save is allowed (EN: category + reference). */
function tagAll(withReference = true): void {
  utteranceRows().forEach((_row, position) => {
    const index = position + 1;
    setCategory(index, CORPUS_CATEGORIES[position % CORPUS_CATEGORIES.length]!);
    if (withReference) setReference(index, `reference text ${index}`);
  });
}

const savedInput = (fakes: Fakes): NewRecordingInput =>
  fakes.recordings.create.mock.calls[0]![0] as NewRecordingInput;

/* ========================================================== opening it === */

describe('ReplayView — [data-record-new] opens a real record flow', () => {
  it('the record button is enabled and opens [data-record-take]', async () => {
    await mount();
    const button = screen.getByRole('button', { name: RECORD_NEW });
    expect(button).toBeEnabled();
    expect(q('[data-record-take]')).toBeNull();

    fireEvent.click(button);

    await waitFor(() => expect(q('[data-record-take]')).not.toBeNull());
    expect(get('[data-record-take]')).toHaveAttribute('data-record-stage', 'armed');
  });

  it('opening the flow touches no capture seam — the mic waits for Start', async () => {
    const fakes = await mount();
    await openFlow();
    expect(fakes.startTake).not.toHaveBeenCalled();
    expect(fakes.segmentTake).not.toHaveBeenCalled();
    expect(fakes.recordings.create).not.toHaveBeenCalled();
  });

  it('a host with no capture seams disables the button with a reason that is not the stale hint', async () => {
    await mount({ withoutCaptureSeams: true });
    const button = screen.getByRole('button', { name: RECORD_NEW });
    expect(button).toBeDisabled();
    const title = button.getAttribute('title') ?? '';
    expect(title.length).toBeGreaterThan(0);
    expect(title).not.toContain('not wired into Replay yet');
  });
});

/* ============================================================ the cap ==== */

describe('RecordTake — the 1 minute cap is enforced and visible', () => {
  it('states the cap before recording and asks startTake to enforce MAX_TAKE_MS', async () => {
    const fakes = await mount();
    await openFlow();
    expect(text(get('[data-record-cap-note]'))).toBe(CAP_NOTE);
    expect(text(get('[data-record-elapsed]'))).toBe('0:00 / 1:00');

    fireEvent.click(screen.getByRole('button', { name: 'Start recording' }));

    await waitFor(() => expect(fakes.startTake).toHaveBeenCalledTimes(1));
    expect(fakes.takes[0]!.options.maxDurationMs).toBe(MAX_TAKE_MS);
    expect(text(get('[data-record-cap-note]'))).toBe(CAP_NOTE);
  });

  it('a take that hits the cap stops, says so, and lands in review', async () => {
    const fakes = await mount();
    await openFlow();
    fireEvent.click(screen.getByRole('button', { name: 'Start recording' }));
    await waitFor(() => expect(fakes.startTake).toHaveBeenCalledTimes(1));
    expect(q('[data-record-cap-reached]')).toBeNull();

    const capped = makeTake(MAX_TAKE_MS);
    await act(async () => {
      fakes.takes[0]!.options.onMaxDuration?.(capped);
    });

    await waitFor(() =>
      expect(get('[data-record-take]')).toHaveAttribute('data-record-stage', 'review'),
    );
    expect(text(get('[data-record-cap-reached]'))).toBe(CAP_REACHED);
    // The capped take is the one under review, and it was segmented.
    expect(fakes.segmentTake).toHaveBeenCalledTimes(1);
    expect(fakes.segmentTake.mock.calls[0]![0]).toBe(capped.samples);
    expect(utteranceRows()).toHaveLength(SEGMENTS.length);
  });

  it('an operator-stopped take shows no cap notice', async () => {
    const fakes = await mount();
    await recordAndStop(fakes);
    expect(q('[data-record-cap-reached]')).toBeNull();
  });

  it('the mic level is reported while recording', async () => {
    const fakes = await mount();
    await openFlow();
    fireEvent.click(screen.getByRole('button', { name: 'Start recording' }));
    await waitFor(() => expect(fakes.startTake).toHaveBeenCalledTimes(1));

    await act(async () => {
      fakes.takes[0]!.options.onLevel?.(3);
    });

    await waitFor(() => expect(get('[data-record-level]')).toHaveAttribute('data-level', '3'));
  });
});

/* ========================================================= mic denial ==== */

describe('RecordTake — mic denial reuses the Live remediation copy', () => {
  it('the shared constants ARE the Live view’s two-layer copy, verbatim', () => {
    expect(MIC_DENIED_HEADING).toBe('Microphone blocked');
    expect(MIC_DENIED_SITE_PERMISSION).toBe(
      'Check the browser site permission: allow microphone access for this site ' +
        '(look for the mic icon in the address bar).',
    );
    expect(MIC_DENIED_OS_SETTING).toBe(
      'Check the OS microphone setting: your system privacy settings must allow ' +
        'this browser to use the microphone.',
    );
    expect(MIC_DENIED_NO_REPROMPT).toBe(
      'Browsers do not re-prompt after a denial — reset the site permission first, then retry.',
    );
  });

  const DENIALS: CaptureDenied[] = [
    { status: 'denied', reason: 'blocked' },
    { status: 'denied', reason: 'unavailable' },
  ];

  it.each(DENIALS)('$reason shows BOTH remediation layers and POSTs nothing', async (denial) => {
    const fakes = await mount({ denial });
    await openFlow();
    fireEvent.click(screen.getByRole('button', { name: 'Start recording' }));

    await waitFor(() => expect(q('[data-record-denied]')).not.toBeNull());
    expect(get('[data-record-take]')).toHaveAttribute('data-record-stage', 'denied');

    const card = get('[data-record-denied]');
    expect(card).toHaveTextContent(MIC_DENIED_HEADING);
    expect(card).toHaveTextContent(MIC_DENIED_SITE_PERMISSION);
    expect(card).toHaveTextContent(MIC_DENIED_OS_SETTING);
    expect(card).toHaveTextContent(MIC_DENIED_NO_REPROMPT);

    // A denial produced no take: nothing to segment, nothing to save.
    expect(fakes.segmentTake).not.toHaveBeenCalled();
    expect(fakes.recordings.create).not.toHaveBeenCalled();
    expect(utteranceRows()).toHaveLength(0);
  });
});

/* ================================================ review — segmentation == */

describe('RecordTake — segmentation is operator-adjustable, never authoritative', () => {
  it('lists one row per detected utterance with its boundaries, editable', async () => {
    const fakes = await mount();
    await recordAndStop(fakes);

    expect(text(get('[data-segmentation-note]'))).toBe(SEGMENTATION_NOTE);
    expect(text(get('[data-take-duration]'))).toContain('12');
    expect(utteranceRows()).toHaveLength(SEGMENTS.length);

    SEGMENTS.forEach((segment) => {
      const start = field(segment.index, 'data-utterance-start') as HTMLInputElement;
      const end = field(segment.index, 'data-utterance-end') as HTMLInputElement;
      expect(Number(start.value)).toBe(segment.startMs);
      expect(Number(end.value)).toBe(segment.trueSpeechEndMs);
      // Editable, not a readout: the operator owns the boundary.
      expect(start).toBeEnabled();
      expect(end).toBeEnabled();
      expect(screen.getByLabelText(`Utterance ${segment.index} start (ms)`)).toBe(start);
      expect(screen.getByLabelText(`Utterance ${segment.index} speech end (ms)`)).toBe(end);
    });
  });

  it('utterances can be added and removed, and the indices stay contiguous', async () => {
    const fakes = await mount();
    await recordAndStop(fakes);

    fireEvent.click(screen.getByRole('button', { name: 'Remove utterance 2' }));

    await waitFor(() => expect(utteranceRows()).toHaveLength(2));
    expect(utteranceRows().map((r) => r.getAttribute('data-utterance-index'))).toEqual(['1', '2']);
    // The surviving second row is the take's THIRD detected utterance.
    expect(Number((field(2, 'data-utterance-end') as HTMLInputElement).value)).toBe(
      SEGMENTS[2]!.trueSpeechEndMs,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Add utterance' }));

    await waitFor(() => expect(utteranceRows()).toHaveLength(3));
    expect(utteranceRows().map((r) => r.getAttribute('data-utterance-index'))).toEqual([
      '1',
      '2',
      '3',
    ]);
  });

  it('a boundary edit that breaks the manifest blocks the save with validateManifest’s own reason', async () => {
    const fakes = await mount();
    await recordAndStop(fakes);
    tagAll();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Save as corpus clip' })).toBeEnabled());

    // Utterance 2's speech end now sits INSIDE utterance 1 — the exact class of
    // error that would anchor t0 in the wrong place for every later utterance.
    setBoundary(2, 'end', 1_500);

    const reference = validateManifest(
      [
        { id: 'a', index: 1, category: 'short-reply', trueSpeechEndMs: 3_000 },
        { id: 'b', index: 2, category: 'short-reply', trueSpeechEndMs: 1_500 },
      ],
      TAKE_MS,
    );
    expect(reference).not.toBeNull();
    const tail = reference!.slice(reference!.indexOf('does not advance'));

    await waitFor(() => expect(text(get('[data-save-blocked]'))).toContain(tail));
    const save = screen.getByRole('button', { name: 'Save as corpus clip' });
    expect(save).toBeDisabled();
    expect(save.getAttribute('title')).toContain(tail);

    fireEvent.click(save);
    expect(fakes.recordings.create).not.toHaveBeenCalled();
  });
});

/* ==================================================== review — tagging === */

describe('RecordTake — a corpus save waits for every utterance to be tagged', () => {
  it('offers exactly the six categories plus an untagged placeholder', async () => {
    const fakes = await mount();
    await recordAndStop(fakes);
    const select = field(1, 'data-utterance-category') as HTMLSelectElement;
    const values = Array.from(select.options).map((option) => option.value);
    expect(values.filter((value) => value !== '')).toEqual([...CORPUS_CATEGORIES]);
    expect(values).toContain('');
    expect(select.value).toBe('');
  });

  it('is blocked while a category is missing, and the control says why', async () => {
    const fakes = await mount();
    await recordAndStop(fakes);

    const save = screen.getByRole('button', { name: 'Save as corpus clip' });
    expect(save).toBeDisabled();
    expect(text(get('[data-save-blocked]'))).toBe(BLOCKED_CATEGORY);
    expect(save).toHaveAttribute('title', BLOCKED_CATEGORY);

    // Two of three tagged is still not tagged.
    setCategory(1, 'short-reply');
    setReference(1, 'one');
    setCategory(2, 'numbers-dates');
    setReference(2, 'two');
    await waitFor(() => expect(text(get('[data-save-blocked]'))).toBe(BLOCKED_CATEGORY));
    expect(screen.getByRole('button', { name: 'Save as corpus clip' })).toBeDisabled();

    setCategory(3, 'disfluency');
    setReference(3, 'three');

    await waitFor(() => expect(q('[data-save-blocked]')).toBeNull());
    expect(screen.getByRole('button', { name: 'Save as corpus clip' })).toBeEnabled();
  });

  it('is blocked while an EN/ES utterance has no reference text — WER is scored against it', async () => {
    const fakes = await mount();
    await recordAndStop(fakes);
    tagAll(false);

    await waitFor(() => expect(text(get('[data-save-blocked]'))).toBe(BLOCKED_REFERENCE));
    expect(screen.getByRole('button', { name: 'Save as corpus clip' })).toBeDisabled();
    expect(fakes.recordings.create).not.toHaveBeenCalled();
  });

  const REFERENCED = ['en', 'es'] as const;

  it.each(REFERENCED)('reference text is offered for %s', async (language) => {
    const fakes = await mount();
    await recordAndStop(fakes);
    setLanguage(language);

    await waitFor(() => expect(utteranceRows()).toHaveLength(SEGMENTS.length));
    for (const segment of SEGMENTS) {
      expect(field(segment.index, 'data-utterance-reference')).toBeEnabled();
      expect(screen.getByLabelText(`Utterance ${segment.index} reference text`)).toBe(
        field(segment.index, 'data-utterance-reference'),
      );
    }
    expect(q('[data-reference-withheld]')).toBeNull();
  });

  it('reference text is WITHHELD for yue, with the reason stated', async () => {
    const fakes = await mount();
    await recordAndStop(fakes);
    setLanguage('yue');

    await waitFor(() => expect(q('[data-reference-withheld]')).not.toBeNull());
    expect(text(get('[data-reference-withheld]'))).toBe(REFERENCE_WITHHELD);
    // ABSENT, not disabled: there is no script to type in (PRD §9).
    expect(all('[data-utterance-reference]')).toHaveLength(0);

    // Category alone unblocks a Cantonese take.
    tagAll(false);
    await waitFor(() => expect(q('[data-save-blocked]')).toBeNull());
    expect(screen.getByRole('button', { name: 'Save as corpus clip' })).toBeEnabled();

    fireEvent.click(screen.getByRole('button', { name: 'Save as corpus clip' }));
    await waitFor(() => expect(fakes.recordings.create).toHaveBeenCalledTimes(1));
    const input = savedInput(fakes);
    expect(input.sourceLanguage).toBe('yue');
    for (const utterance of input.utterances ?? []) {
      expect(utterance).not.toHaveProperty('referenceText');
    }
  });
});

/* ====================================================== review — saving == */

describe('RecordTake — saving as corpus', () => {
  async function saveCorpus(fakes: Fakes): Promise<NewRecordingInput> {
    await recordAndStop(fakes);
    fireEvent.change(get('[data-take-label]'), {
      target: { value: 'pharmacy counter · take 1' },
    });
    tagAll();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Save as corpus clip' })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: 'Save as corpus clip' }));
    await waitFor(() => expect(fakes.recordings.create).toHaveBeenCalledTimes(1));
    return savedInput(fakes);
  }

  it('POSTs origin corpus, the take’s audio, the operator’s label and the corpusVersion', async () => {
    const fakes = await mount();
    const input = await saveCorpus(fakes);

    expect(input.origin).toBe('corpus');
    expect(input.label).toBe('pharmacy counter · take 1');
    expect(input.sourceLanguage).toBe('en');
    expect(input.durationMs).toBe(TAKE_MS);
    expect(input.createdAt).toBe(T0);
    expect(input.corpusVersion).toBe(CORPUS_VERSION_UNDER_TEST);
    expect(decodeBase64(input.audioBase64)).toEqual(WAV_BYTES);
    // t0 is the LAST utterance's frozen speech end, not a per-run guess.
    expect(input.speechEndMs).toBe(SEGMENTS[SEGMENTS.length - 1]!.trueSpeechEndMs);
  });

  it('the POSTed manifest passes the REAL validateManifest', async () => {
    const fakes = await mount();
    const input = await saveCorpus(fakes);
    const manifest = input.utterances as CorpusUtterance[];

    expect(validateManifest(manifest, input.durationMs)).toBeNull();
    expect(manifest).toHaveLength(SEGMENTS.length);
    expect(manifest.map((u) => u.index)).toEqual([1, 2, 3]);
    expect(manifest.map((u) => u.trueSpeechEndMs)).toEqual(
      SEGMENTS.map((s) => s.trueSpeechEndMs),
    );
    expect(manifest.map((u) => u.category)).toEqual([
      CORPUS_CATEGORIES[0],
      CORPUS_CATEGORIES[1],
      CORPUS_CATEGORIES[2],
    ]);
    expect(manifest.map((u) => u.referenceText)).toEqual([
      'reference text 1',
      'reference text 2',
      'reference text 3',
    ]);
    expect(new Set(manifest.map((u) => u.id)).size).toBe(manifest.length);
  });

  it('what the operator edited is what gets POSTed', async () => {
    const fakes = await mount();
    await recordAndStop(fakes);
    fireEvent.click(screen.getByRole('button', { name: 'Remove utterance 2' }));
    await waitFor(() => expect(utteranceRows()).toHaveLength(2));
    setBoundary(1, 'end', 2_500);
    tagAll();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Save as corpus clip' })).toBeEnabled());

    fireEvent.click(screen.getByRole('button', { name: 'Save as corpus clip' }));

    await waitFor(() => expect(fakes.recordings.create).toHaveBeenCalledTimes(1));
    const input = savedInput(fakes);
    const manifest = input.utterances as CorpusUtterance[];
    expect(validateManifest(manifest, input.durationMs)).toBeNull();
    expect(manifest.map((u) => u.index)).toEqual([1, 2]);
    expect(manifest.map((u) => u.trueSpeechEndMs)).toEqual([2_500, SEGMENTS[2]!.trueSpeechEndMs]);
    expect(input.speechEndMs).toBe(SEGMENTS[2]!.trueSpeechEndMs);
  });

  it('the saved Recording appears in the library without a reload, and the flow closes', async () => {
    const fakes = await mount();
    expect(q(`[data-recording-row][data-recording="${SAVED_REC.id}"]`)).toBeNull();
    const listCallsBefore = fakes.recordings.list.mock.calls.length;

    await saveCorpus(fakes);

    await waitFor(() =>
      expect(q(`[data-recording-row][data-recording="${SAVED_REC.id}"]`)).not.toBeNull(),
    );
    await waitFor(() => expect(q('[data-record-take]')).toBeNull());
    // The existing row is still there — a save is an append, not a reset.
    expect(q(`[data-recording-row][data-recording="${EXISTING_REC.id}"]`)).not.toBeNull();
    // Either the client re-listed or the view appended; what must NOT happen is
    // the operator having to reload to see it.
    expect(fakes.recordings.list.mock.calls.length).toBeGreaterThanOrEqual(listCallsBefore);
  });
});

describe('RecordTake — saving as an ad-hoc clip', () => {
  it('POSTs origin mic with NO utterances key and no corpusVersion', async () => {
    const fakes = await mount();
    await recordAndStop(fakes);

    // Untagged: the ad-hoc path is always available, tagging is not its gate.
    const adhoc = screen.getByRole('button', { name: 'Save as ad-hoc clip' });
    expect(adhoc).toBeEnabled();
    fireEvent.click(adhoc);

    await waitFor(() => expect(fakes.recordings.create).toHaveBeenCalledTimes(1));
    const input = savedInput(fakes);
    expect(input.origin).toBe('mic');
    // NO KEY AT ALL — an empty array would read as "a corpus take with no
    // utterances", which the server's validator rejects and the ledger
    // mis-reports.
    expect(Object.prototype.hasOwnProperty.call(input, 'utterances')).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(input, 'corpusVersion')).toBe(false);
    expect(input.durationMs).toBe(TAKE_MS);
    expect(decodeBase64(input.audioBase64)).toEqual(WAV_BYTES);
  });
});

describe('RecordTake — cancelling discards and POSTs nothing', () => {
  it('cancelling mid-recording abandons the take through the recorder', async () => {
    const fakes = await mount();
    await openFlow();
    fireEvent.click(screen.getByRole('button', { name: 'Start recording' }));
    await waitFor(() => expect(fakes.startTake).toHaveBeenCalledTimes(1));

    fireEvent.click(screen.getByRole('button', { name: 'Cancel take' }));

    await waitFor(() => expect(fakes.takes[0]!.recorder.cancel).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(q('[data-record-take]')).toBeNull());
    expect(fakes.recordings.create).not.toHaveBeenCalled();
    expect(q(`[data-recording-row][data-recording="${SAVED_REC.id}"]`)).toBeNull();
  });

  it('cancelling at review discards a fully tagged take', async () => {
    const fakes = await mount();
    await recordAndStop(fakes);
    tagAll();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Save as corpus clip' })).toBeEnabled());

    fireEvent.click(screen.getByRole('button', { name: 'Cancel take' }));

    await waitFor(() => expect(q('[data-record-take]')).toBeNull());
    expect(fakes.recordings.create).not.toHaveBeenCalled();
    expect(utteranceRows()).toHaveLength(0);

    // ...and reopening starts from nothing, not from the discarded take.
    await openFlow();
    expect(get('[data-record-take]')).toHaveAttribute('data-record-stage', 'armed');
    expect(utteranceRows()).toHaveLength(0);
  });
});

/* ======================================================= nothing autoplays */

describe('RecordTake — NOTHING autoplays (PRD §7)', () => {
  let audioContexts = 0;
  let playSpy = vi.fn();

  beforeEach(() => {
    audioContexts = 0;
    class SpyAudioContext {
      constructor() {
        audioContexts += 1;
      }
    }
    vi.stubGlobal('AudioContext', SpyAudioContext);
    vi.stubGlobal('webkitAudioContext', SpyAudioContext);
    playSpy = vi.fn();
    vi.spyOn(window.HTMLMediaElement.prototype, 'play').mockImplementation(() => {
      playSpy();
      return Promise.resolve();
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('recording and review construct no AudioContext and sound nothing', async () => {
    const fakes = await mount();
    await recordAndStop(fakes);

    expect(screen.getByRole('button', { name: 'Play take' })).toBeInTheDocument();
    expect(audioContexts).toBe(0);
    expect(fakes.playTake).not.toHaveBeenCalled();
    expect(playSpy).not.toHaveBeenCalled();
    expect(document.querySelectorAll('audio[autoplay], video[autoplay]')).toHaveLength(0);
  });

  it('the take sounds only from the explicit control', async () => {
    const fakes = await mount();
    await recordAndStop(fakes);

    fireEvent.click(screen.getByRole('button', { name: 'Play take' }));

    await waitFor(() => expect(fakes.playTake).toHaveBeenCalledTimes(1));
    const played = fakes.playTake.mock.calls[0]![0] as RecordedTake;
    expect(played.durationMs).toBe(TAKE_MS);
    expect(audioContexts).toBe(0);
  });
});

/* ================================================ source-level guarantees == */

describe('Record sources — tokens only, one mic-denial copy, no stale hint', () => {
  const FILES = [
    'src/client/views/ReplayView.tsx',
    'src/client/components/replay/RecordTake.tsx',
  ] as const;

  /** Blanks comments while preserving line count (see deletions.test.ts). */
  function stripComments(source: string): string {
    return source
      .replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, ' '))
      .replace(/(^|[^:])\/\/[^\n]*/g, (_m, lead: string) => lead);
  }

  const read = (file: string): string =>
    stripComments(readFileSync(resolve(process.cwd(), file), 'utf8'));

  const sources = FILES.map((file) => ({ file, code: read(file) }));

  it('styles from tokens only — no hex, rgb or oklch literal', () => {
    for (const { file, code } of sources) {
      expect(code, file).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
      expect(code, file).not.toMatch(/\brgba?\(/);
      expect(code, file).not.toMatch(/\boklch\(/);
    }
  });

  it('the stale "not wired into Replay yet" hint is GONE from the source', () => {
    for (const { file, code } of sources) {
      expect(code, file).not.toContain('not wired into Replay yet');
      expect(code, file).not.toMatch(/\bRECORD_NEW_HINT\b/);
    }
  });

  it('ReplayView composes RecordTake and drives it through injected seams', () => {
    const view = sources.find((s) => s.file.endsWith('ReplayView.tsx'))!.code;
    expect(view).toContain('RecordTake');
    expect(view).toMatch(/\bstartTake\b/);
    expect(view).toMatch(/\bsegmentTake\b/);
  });

  it('the mic-denial copy lives in ONE module — neither view restates it', () => {
    const collapse = (value: string): string => value.replace(/\s+/g, ' ');
    const consumers = ['src/client/views/LiveView.tsx', 'src/client/components/replay/RecordTake.tsx'];
    for (const file of consumers) {
      const code = collapse(read(file));
      for (const sentence of [MIC_DENIED_SITE_PERMISSION, MIC_DENIED_OS_SETTING, MIC_DENIED_NO_REPROMPT]) {
        expect(code, `${file} must not restate the mic-denial copy`).not.toContain(
          collapse(sentence),
        );
      }
      expect(code, `${file} must import the shared mic-denial copy`).toContain('micDenial');
    }
  });

  it('the real browser bag wires the capture seams', () => {
    const code = read('src/client/browserDeps.ts');
    expect(code).toMatch(/\bstartTake\b/);
    expect(code).toMatch(/\bsegmentTake\b/);
  });
});
