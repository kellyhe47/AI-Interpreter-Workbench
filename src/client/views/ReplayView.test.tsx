/**
 * Ticket 013 — RTL tests for <ReplayView />.
 *
 * The DOM contract they lock is documented at the top of ReplayView.tsx.
 * Four rules run through all of them:
 *
 *  1. NOTHING IS GLOBAL. The recordings client, the runs client, the single-run
 *     executor, the batch starter, the playback seam and the clock are all
 *     injected. No test touches the network, an AudioContext, or a real timer.
 *  2. MEMBERSHIP IS DERIVED, NEVER DECLARED (PRD §6, §17 22d-22e). The arm tag
 *     is a readout of the configuration and flips LIVE, before any run exists.
 *     No control anywhere sets a tag — asserted in the DOM and in the source.
 *  3. AN OPERATION THAT IS DISALLOWED HAS NO AFFORDANCE (PRD §17 25c). A corpus
 *     Recording renders no delete control at all — not a disabled one.
 *  4. NOTHING AUTOPLAYS (PRD §7). Rendering a completed run must construct no
 *     AudioContext, fetch no audio and call no playback seam.
 */

// Imported directly (in addition to vitest.setup.ts) so the jest-dom matcher
// type augmentation is visible to `tsc -p tsconfig.json`, whose include does
// not cover the setup file.
import '@testing-library/jest-dom/vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_CASCADE_TRIPLE,
  MENUS,
  REALTIME_MODEL,
  armLabel,
  deriveArmTag,
  type ArmTag,
  type ProviderTriple,
} from '../../core/arms';
import type {
  BatchConfiguration,
  BatchHandle,
  BatchProgress,
  BatchSummary,
} from '../batch/runner';
import type { RecordingsClient, RunsClient } from '../replay/recordingsClient';
import type { RunOnceResult } from '../replay/runner';
import type { Recording, Run } from '../state/ledger';
import ReplayView, {
  type ReplayBatchRequest,
  type ReplayDeps,
  type ReplayRunRequest,
} from './ReplayView';

afterEach(cleanup);

/* ================================================================== copy == */

const HEADER_SUBLINE =
  'Record once, run it through any configuration. Runs of the same Recording are comparable by construction.';

const RECORD_NEW = 'Record new clip · max 1 min';

const LIBRARY_FOOTER =
  "Labels are editable; audio is immutable. Deleting hides a Recording but keeps its Runs. " +
  "Corpus Recordings can't be deleted — experiments depend on them.";

const PINNED_NOTE =
  'context pinned to zero in Replay · voice pinned per vendor · replay paced at 1× · ' +
  'manual runs are explorable but never aggregated into experiments';

const BATCH_CONTROLS_NOTE =
  'counterbalanced order · first run per configuration discarded as warmup · ' +
  'failures retried once, then the batch continues · origin: sweep';

const CANCEL_BATCH = 'Cancel — keep completed runs';

/** The tail every failed run card ends with, whatever stage was lost. */
const FAILURE_TAIL = '— run saved as failed, excluded from every aggregate';

/* ============================================================== fixtures == */

/** 2026-02-03T09:41:00Z. */
const T0 = Date.UTC(2026, 1, 3, 9, 41, 0);

/** Exactly one minute of audio, so $/min is the run's cost unchanged. */
const CORPUS_REC: Recording = {
  id: 'rec-corpus',
  label: 'clinic intake · corpus',
  sourceLanguage: 'en',
  durationMs: 60_000,
  speechEndMs: 59_000,
  origin: 'corpus',
  createdAt: T0,
};

/** Half a minute, so a $/min cell that forgot to normalize disagrees. */
const MIC_REC: Recording = {
  id: 'rec-mic',
  label: 'pharmacy dosage test',
  sourceLanguage: 'es',
  durationMs: 30_000,
  speechEndMs: 29_500,
  origin: 'mic',
  createdAt: T0 + 1,
};

const ARM_C_TRIPLE: ProviderTriple = { ...DEFAULT_CASCADE_TRIPLE, tts: 'eleven_flash_v2_5' };
/** Every stage is a legal menu choice; the combination is no frozen arm. */
const OFF_ARM_TRIPLE: ProviderTriple = {
  stt: 'gpt-4o-mini-transcribe',
  mt: 'claude-haiku-4-5',
  tts: 'eleven_multilingual_v2',
};

/**
 * Cascade marks that make every named interval exact:
 * endpointing 500 · stt 42 · mt 298 · tts 201 · queue 12 → end-to-end 1053.
 */
const CASCADE_TIMINGS: Record<string, number> = {
  speech_end: T0,
  vad_fired: T0 + 500,
  stt_final: T0 + 542,
  mt_first_token: T0 + 840,
  tts_first_byte: T0 + 1_041,
  audio_queued: T0 + 1_053,
};
const CASCADE_STAGES = [
  ['endpointing', 500],
  ['stt', 42],
  ['mt', 298],
  ['tts', 201],
  ['queue', 12],
] as const;
const CASCADE_TOTAL_MS = 1_053;

/** Realtime marks: endpointing 500 · model 471 · queue 9 → end-to-end 980. */
const REALTIME_TIMINGS: Record<string, number> = {
  speech_end: T0,
  server_speech_stopped: T0 + 500,
  first_audio_delta: T0 + 971,
  audio_queued: T0 + 980,
};
const REALTIME_STAGES = [
  ['endpointing', 500],
  ['model', 471],
  ['queue', 9],
] as const;
const REALTIME_TOTAL_MS = 980;

type SeededRun = Run & { annotations?: { repIndex?: number } };

/** Arm B, sweep, rep 3 — the ordinary complete cascade card. */
const RUN_CASCADE: SeededRun = {
  id: 'run-cascade',
  recordingId: CORPUS_REC.id,
  architecture: 'cascade',
  providerTriple: { ...DEFAULT_CASCADE_TRIPLE },
  modelSnapshots: { ...DEFAULT_CASCADE_TRIPLE },
  armTag: 'B',
  origin: 'sweep',
  status: 'complete',
  timings: { ...CASCADE_TIMINGS },
  transcripts: { source: 'hello', target: 'hola' },
  outputAudioPath: 'runs/run-cascade.out.wav',
  cost: 0.021,
  errors: [],
  createdAt: T0 + 60_000,
  annotations: { repIndex: 3 },
};

/** Arm A, manual — the realtime card, three intervals not five. */
const RUN_REALTIME: SeededRun = {
  id: 'run-realtime',
  recordingId: CORPUS_REC.id,
  architecture: 'realtime',
  modelSnapshots: { realtime: REALTIME_MODEL },
  armTag: 'A',
  origin: 'manual',
  status: 'complete',
  timings: { ...REALTIME_TIMINGS },
  transcripts: { source: 'hello', target: 'hola' },
  outputAudioPath: 'runs/run-realtime.out.wav',
  cost: 0.14,
  errors: [],
  createdAt: T0 + 120_000,
};

/** ad-hoc, manual, lost its TTS stage. Saved, listed, never aggregated. */
const RUN_FAILED: SeededRun = {
  id: 'run-failed',
  recordingId: CORPUS_REC.id,
  architecture: 'cascade',
  providerTriple: { ...OFF_ARM_TRIPLE },
  modelSnapshots: { ...OFF_ARM_TRIPLE },
  armTag: 'ad-hoc',
  origin: 'manual',
  status: 'failed',
  timings: { speech_end: T0, audio_queued: null },
  transcripts: { source: 'hello' },
  cost: 0,
  errors: ['tts: stage timed out for this utterance'],
  createdAt: T0 + 180_000,
};

/** Arm B over the 30-second clip: cost 0.0105 over half a minute = $0.021/min. */
const RUN_ON_MIC: SeededRun = {
  id: 'run-mic',
  recordingId: MIC_REC.id,
  architecture: 'cascade',
  providerTriple: { ...DEFAULT_CASCADE_TRIPLE },
  modelSnapshots: { ...DEFAULT_CASCADE_TRIPLE },
  armTag: 'B',
  origin: 'sweep',
  status: 'complete',
  timings: { ...CASCADE_TIMINGS },
  transcripts: { source: 'hola', target: 'hello' },
  outputAudioPath: 'runs/run-mic.out.wav',
  cost: 0.0105,
  errors: [],
  createdAt: T0 + 240_000,
  annotations: { repIndex: 1 },
};

/* =============================================================== helpers == */

/** '{ms} ms' — the run card's per-stage and total format (design mock). */
const ms = (value: number): string => `${value} ms`;
/** '$0.021/min' — cost normalized by the Recording's minutes of audio. */
const perMinute = (usd: number): string => `$${usd.toFixed(3)}/min`;

/** One started sweep, with the handle levers the test drives it through. */
interface BatchProbe {
  request: ReplayBatchRequest;
  cancel: () => void;
  emit: (progress: Partial<BatchProgress>) => void;
  settle: (summary?: Partial<BatchSummary>) => void;
}

function makeFakes(options: { recordings?: Recording[]; runs?: SeededRun[] } = {}) {
  const store = {
    recordings: [...(options.recordings ?? [])],
    runs: [...(options.runs ?? [])],
  };

  const visible = (): Recording[] => store.recordings.filter((r) => r.deletedAt === undefined);

  const recordings = {
    list: vi.fn(async () => visible().map((r) => ({ ...r }))),
    get: vi.fn(async (id: string) => ({ ...store.recordings.find((r) => r.id === id)! })),
    getAudio: vi.fn(async () => new Uint8Array()),
    create: vi.fn(async () => ({ ...CORPUS_REC })),
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
    list: vi.fn(async (recordingId?: string) =>
      store.runs
        .filter((r) => recordingId === undefined || r.recordingId === recordingId)
        .map((r) => ({ ...r })),
    ),
    getAudio: vi.fn(async () => new Uint8Array()),
  };

  const runOnce = vi.fn(async (request: ReplayRunRequest): Promise<RunOnceResult> => {
    const run: SeededRun = {
      ...RUN_CASCADE,
      id: `run-new-${store.runs.length + 1}`,
      recordingId: request.recordingId,
      architecture: request.config.architecture,
      providerTriple: request.config.providers,
      modelSnapshots:
        request.config.architecture === 'realtime'
          ? { realtime: request.config.realtimeModel ?? REALTIME_MODEL }
          : { ...(request.config.providers ?? DEFAULT_CASCADE_TRIPLE) },
      armTag: deriveArmTag(request.config),
      origin: 'manual',
      annotations: undefined,
    };
    store.runs.push(run);
    return {
      run,
      outputAudio: new Int16Array(0),
      audioReady: true,
      t0: T0,
      speechEndMs: 0,
      cancelled: false,
    };
  });

  const batches: BatchProbe[] = [];
  const startBatch = vi.fn((request: ReplayBatchRequest): BatchHandle => {
    const cancel = vi.fn();
    let settleDone: (summary: BatchSummary) => void = () => {};
    const done = new Promise<BatchSummary>((resolveDone) => {
      settleDone = resolveDone;
    });
    batches.push({
      request,
      cancel,
      emit: (progress) =>
        request.onProgress?.({
          runIndex: 1,
          totalRuns: 45,
          recordingId: request.recordingIds[0] ?? '',
          configId: request.configurations[0]?.id ?? '',
          repIndex: 1,
          warmup: false,
          elapsedMs: 0,
          estimatedRemainingMs: null,
          ...progress,
        }),
      settle: (summary) =>
        settleDone({
          status: 'cancelled',
          totalRuns: 45,
          attemptedRuns: 17,
          completedRuns: 17,
          warmupDiscardApplied: true,
          counterbalancingApplied: true,
          discarded: [],
          failures: [],
          configurations: [],
          runs: [],
          elapsedMs: 1_000,
          ...summary,
        }),
    });
    return { done, cancel };
  });

  const playRun = vi.fn();

  const deps: ReplayDeps = {
    recordings: recordings as unknown as RecordingsClient,
    runs: runs as unknown as RunsClient,
    runOnce: runOnce as unknown as ReplayDeps['runOnce'],
    startBatch: startBatch as unknown as ReplayDeps['startBatch'],
    playRun,
    now: () => T0,
    newId: () => 'id-1',
  };

  return { deps, store, recordings, runs, runOnce, startBatch, playRun, batches };
}

/** Renders and waits until the library has settled (rows or the empty state). */
async function mount(options: { recordings?: Recording[]; runs?: SeededRun[] } = {}) {
  const fakes = makeFakes(options);
  render(<ReplayView deps={fakes.deps} />);
  await waitFor(() => expect(q('[data-recordings-library]')).not.toBeNull());
  if ((options.recordings ?? []).length > 0) {
    await waitFor(() => expect(rows().length).toBe((options.recordings ?? []).length));
  } else {
    await waitFor(() =>
      expect(document.querySelector('[data-recordings-empty]')).not.toBeNull(),
    );
  }
  return fakes;
}

const q = (selector: string): HTMLElement | null =>
  document.querySelector<HTMLElement>(selector);

function get(selector: string): HTMLElement {
  const found = q(selector);
  if (!found) throw new Error(`missing element: ${selector}`);
  return found;
}

const rows = (): HTMLElement[] =>
  Array.from(document.querySelectorAll<HTMLElement>('[data-recording-row]'));

function row(recordingId: string): HTMLElement {
  return get(`[data-recording-row][data-recording="${recordingId}"]`);
}

/** Selection is idempotent — clicking the already-selected row is a no-op. */
async function selectRecording(recordingId: string): Promise<HTMLElement> {
  fireEvent.click(row(recordingId));
  await waitFor(() => expect(row(recordingId)).toHaveAttribute('data-selected', 'true'));
  return row(recordingId);
}

const derivedTag = (): HTMLElement => get('[data-derived-tag]');
const stageSelect = (stage: 'stt' | 'mt' | 'tts'): HTMLElement | null =>
  q(`[data-stage-select="${stage}"]`);
const stageSelects = (): HTMLElement[] =>
  Array.from(document.querySelectorAll<HTMLElement>('[data-stage-select]'));

const runCard = (runId: string): HTMLElement => get(`[data-run-card][data-run="${runId}"]`);
const runCards = (): HTMLElement[] =>
  Array.from(document.querySelectorAll<HTMLElement>('[data-run-card]'));

const text = (element: Element | null): string => (element?.textContent ?? '').trim();

/** Every element a user could operate. */
function interactiveElements(): HTMLElement[] {
  return Array.from(
    document.querySelectorAll<HTMLElement>(
      'button, input, select, textarea, option, [role="button"], [contenteditable]',
    ),
  );
}

function setStage(stage: 'stt' | 'mt' | 'tts', model: string): void {
  const select = stageSelect(stage);
  if (!select) throw new Error(`missing stage selector: ${stage}`);
  fireEvent.change(select, { target: { value: model } });
}

/** Cascade is the default architecture, so a fresh panel must already be Arm B. */
const DEFAULT_LIBRARY = { recordings: [CORPUS_REC, MIC_REC], runs: [] as SeededRun[] };

/* ============================================================ header/copy == */

describe('ReplayView — header', () => {
  it('renders the title and the comparable-by-construction subline verbatim', async () => {
    await mount(DEFAULT_LIBRARY);
    expect(screen.getByText('Replay')).toBeInTheDocument();
    expect(screen.getByText(HEADER_SUBLINE)).toBeInTheDocument();
  });

  it('offers a record-new-clip affordance that states the 1 minute cap', async () => {
    await mount(DEFAULT_LIBRARY);
    const button = screen.getByRole('button', { name: RECORD_NEW });
    expect(button).toBeInTheDocument();
    expect(text(button)).toContain('1 min');
  });
});

/* ============================================== library — rows and empty == */

describe('RecordingsLibrary — empty is genuinely empty', () => {
  it('renders an empty state and NOT ONE sample row', async () => {
    await mount({ recordings: [], runs: [] });
    expect(q('[data-recordings-empty]')).not.toBeNull();
    expect(rows()).toHaveLength(0);
    // The mock's placeholder library must not survive as hardcoded rows.
    expect(text(get('[data-recordings-library]'))).not.toMatch(/rec-en-0\d/);
  });

  it('still states the lifecycle rules verbatim with nothing recorded', async () => {
    await mount({ recordings: [], runs: [] });
    expect(text(get('[data-library-footer]'))).toBe(LIBRARY_FOOTER);
  });
});

describe('RecordingsLibrary — a row carries label, origin, language, duration, runs', () => {
  const ROWS = [
    { recording: CORPUS_REC, origin: 'corpus', duration: '1:00', runCount: 3 },
    { recording: MIC_REC, origin: 'mic', duration: '0:30', runCount: 1 },
  ] as const;

  it.each(ROWS)('$origin row renders every column', async ({ recording, origin, duration, runCount }) => {
    await mount({
      recordings: [CORPUS_REC, MIC_REC],
      runs: [RUN_CASCADE, RUN_REALTIME, RUN_FAILED, RUN_ON_MIC],
    });
    const element = row(recording.id);
    expect(element).toHaveAttribute('data-origin', origin);
    expect(text(element.querySelector('[data-recording-label]'))).toBe(recording.label);
    expect(text(element.querySelector('[data-origin-pill]'))).toBe(origin);
    expect(text(element.querySelector('[data-recording-language]')).toLowerCase()).toBe(
      recording.sourceLanguage.toLowerCase(),
    );
    expect(text(element.querySelector('[data-recording-duration]'))).toBe(duration);
    // The count includes the failed run — a failure is a Run like any other.
    expect(text(element.querySelector('[data-recording-run-count]'))).toContain(String(runCount));
  });
});

/* ================================================== library — label edit == */

describe('RecordingsLibrary — labels are editable, everything else is not', () => {
  it('committing an edit calls patchLabel and leaves duration/origin/language intact', async () => {
    const fakes = await mount({ recordings: [CORPUS_REC, MIC_REC], runs: [RUN_ON_MIC] });
    const before = row(MIC_REC.id);
    const duration = text(before.querySelector('[data-recording-duration]'));
    const language = text(before.querySelector('[data-recording-language]'));
    const origin = before.getAttribute('data-origin');

    fireEvent.click(within(before).getByRole('button', { name: /edit label/i }));
    const input = await screen.findByRole('textbox', { name: /recording label/i });
    fireEvent.change(input, { target: { value: 'pharmacy dosage · take 2' } });
    fireEvent.keyDown(input, { key: 'Enter', code: 'Enter' });

    await waitFor(() =>
      expect(fakes.recordings.patchLabel).toHaveBeenCalledWith(MIC_REC.id, 'pharmacy dosage · take 2'),
    );
    const after = await waitFor(() => {
      const element = row(MIC_REC.id);
      expect(text(element.querySelector('[data-recording-label]'))).toBe('pharmacy dosage · take 2');
      return element;
    });

    // Immutable fields are untouched in the rendered row...
    expect(text(after.querySelector('[data-recording-duration]'))).toBe(duration);
    expect(text(after.querySelector('[data-recording-language]'))).toBe(language);
    expect(after.getAttribute('data-origin')).toBe(origin);
    // ...and no audio-bearing path was invoked to rename a clip.
    expect(fakes.recordings.create).not.toHaveBeenCalled();
    expect(fakes.recordings.getAudio).not.toHaveBeenCalled();
    expect(fakes.recordings.remove).not.toHaveBeenCalled();
  });
});

/* ====================================== library — deletion (PRD §17 25c) == */

describe('RecordingsLibrary — deletion is soft, and corpus clips have no affordance', () => {
  const AFFORDANCE = [
    { origin: 'mic', recordingId: MIC_REC.id, deletable: true },
    { origin: 'corpus', recordingId: CORPUS_REC.id, deletable: false },
  ] as const;

  it.each(AFFORDANCE)('a $origin Recording deletable=$deletable', async ({ recordingId, deletable }) => {
    await mount({ recordings: [CORPUS_REC, MIC_REC], runs: [] });
    const element = row(recordingId);
    const control = element.querySelector('[data-delete-recording]');
    const byRole = within(element).queryByRole('button', { name: /delete/i });
    if (deletable) {
      expect(control).not.toBeNull();
      expect(byRole).not.toBeNull();
    } else {
      // ABSENT, not disabled: the operation is disallowed, not warned about.
      expect(control).toBeNull();
      expect(byRole).toBeNull();
    }
  });

  it('the whole view offers exactly one delete control — the mic row’s', async () => {
    await mount({ recordings: [CORPUS_REC, MIC_REC], runs: [] });
    expect(document.querySelectorAll('[data-delete-recording]')).toHaveLength(1);
    expect(row(MIC_REC.id).querySelector('[data-delete-recording]')).not.toBeNull();
  });

  it('deleting a mic Recording removes its row while its Runs stay listed', async () => {
    const fakes = await mount({
      recordings: [CORPUS_REC, MIC_REC],
      runs: [RUN_CASCADE, RUN_ON_MIC],
    });
    await selectRecording(MIC_REC.id);
    await waitFor(() => expect(runCard(RUN_ON_MIC.id)).toBeInTheDocument());

    fireEvent.click(within(row(MIC_REC.id)).getByRole('button', { name: /delete/i }));

    await waitFor(() => expect(fakes.recordings.remove).toHaveBeenCalledWith(MIC_REC.id));
    await waitFor(() => expect(q(`[data-recording-row][data-recording="${MIC_REC.id}"]`)).toBeNull());
    // The Recording is hidden; its Run is not. A Run must always be able to
    // reach the input that produced it (PRD §7, §17 25c).
    expect(runCard(RUN_ON_MIC.id)).toBeInTheDocument();
    expect(row(CORPUS_REC.id)).toBeInTheDocument();
  });
});

/* ============================================ config panel — derived tag == */

describe('RunConfigPanel — the tag is DERIVED, live, and never declared', () => {
  it('the untouched panel derives Arm B from DEFAULT_CASCADE_TRIPLE', async () => {
    await mount(DEFAULT_LIBRARY);
    await selectRecording(CORPUS_REC.id);
    expect(deriveArmTag({ architecture: 'cascade', providers: DEFAULT_CASCADE_TRIPLE })).toBe('B');
    expect(derivedTag()).toHaveAttribute('data-derived-tag', 'B');
    expect(text(derivedTag())).toBe(`derived tag: ${armLabel('B')}`);
    for (const stage of ['stt', 'mt', 'tts'] as const) {
      expect(stageSelect(stage)).toHaveValue(DEFAULT_CASCADE_TRIPLE[stage]);
    }
  });

  // One selector moved off Arm B's triple, every legal menu value, and the
  // expectation computed by the same derivation the panel must use.
  const STAGE_CHANGES = (['stt', 'mt', 'tts'] as const).flatMap((stage) =>
    MENUS[stage]
      .filter((model) => model !== DEFAULT_CASCADE_TRIPLE[stage])
      .map((model) => {
        const providers: ProviderTriple = { ...DEFAULT_CASCADE_TRIPLE, [stage]: model };
        return { stage, model, expected: deriveArmTag({ architecture: 'cascade', providers }) };
      }),
  );

  it.each(STAGE_CHANGES)(
    '$stage → $model flips the pill to $expected BEFORE any run is triggered',
    async ({ stage, model, expected }) => {
      const fakes = await mount(DEFAULT_LIBRARY);
      await selectRecording(CORPUS_REC.id);
      expect(derivedTag()).toHaveAttribute('data-derived-tag', 'B');

      setStage(stage, model);

      await waitFor(() => expect(derivedTag()).toHaveAttribute('data-derived-tag', expected));
      expect(text(derivedTag())).toBe(
        expected === 'ad-hoc' ? 'derived tag: ad-hoc' : `derived tag: ${armLabel(expected)}`,
      );
      // Live means live: nothing was executed to earn the new tag.
      expect(fakes.runOnce).not.toHaveBeenCalled();
      expect(fakes.startBatch).not.toHaveBeenCalled();
      expect(fakes.runs.create).not.toHaveBeenCalled();
    },
  );

  it('an off-arm combination reads ad-hoc, and going back to the triple restores Arm B', async () => {
    await mount(DEFAULT_LIBRARY);
    await selectRecording(CORPUS_REC.id);
    setStage('stt', OFF_ARM_TRIPLE.stt);
    setStage('mt', OFF_ARM_TRIPLE.mt);
    await waitFor(() => expect(derivedTag()).toHaveAttribute('data-derived-tag', 'ad-hoc'));

    setStage('stt', DEFAULT_CASCADE_TRIPLE.stt);
    setStage('mt', DEFAULT_CASCADE_TRIPLE.mt);
    await waitFor(() => expect(derivedTag()).toHaveAttribute('data-derived-tag', 'B'));
  });

  it('switching to Realtime derives Arm A and hides the per-stage selectors', async () => {
    await mount(DEFAULT_LIBRARY);
    await selectRecording(CORPUS_REC.id);
    expect(stageSelects()).toHaveLength(3);

    fireEvent.click(screen.getByRole('button', { name: 'Realtime' }));

    await waitFor(() => expect(derivedTag()).toHaveAttribute('data-derived-tag', 'A'));
    expect(text(derivedTag())).toBe(`derived tag: ${armLabel('A')}`);
    expect(stageSelects()).toHaveLength(0);

    // ...and back to Cascade restores them, still on Arm B's triple.
    fireEvent.click(screen.getByRole('button', { name: 'Cascade' }));
    await waitFor(() => expect(derivedTag()).toHaveAttribute('data-derived-tag', 'B'));
    expect(stageSelects()).toHaveLength(3);
  });

  it('the pill is a readout — not a button, and holding no control', async () => {
    await mount(DEFAULT_LIBRARY);
    await selectRecording(CORPUS_REC.id);
    const pill = derivedTag();
    expect(['BUTTON', 'INPUT', 'SELECT', 'TEXTAREA']).not.toContain(pill.tagName);
    expect(pill.getAttribute('role')).not.toBe('button');
    expect(pill.querySelectorAll('button, input, select, textarea')).toHaveLength(0);
  });

  it('NO control anywhere sets an arm tag directly', async () => {
    await mount({
      recordings: [CORPUS_REC, MIC_REC],
      runs: [RUN_CASCADE, RUN_REALTIME, RUN_FAILED],
    });
    await selectRecording(CORPUS_REC.id);
    const offenders = interactiveElements().filter((element) => {
      const value = (element as HTMLInputElement).value ?? '';
      return /\barm\b/i.test(text(element)) || /\barm\b/i.test(value);
    });
    expect(offenders.map((o) => `${o.tagName}:${text(o) || (o as HTMLInputElement).value}`)).toEqual([]);
  });
});

/* ============================================= config panel — the pinned == */

describe('RunConfigPanel — pinned constants are stated, and context is locked', () => {
  it('renders the pinned-constants note verbatim', async () => {
    await mount(DEFAULT_LIBRARY);
    await selectRecording(CORPUS_REC.id);
    expect(text(get('[data-pinned-note]'))).toBe(PINNED_NOTE);
  });

  it('replay context is a locked field pinned to zero, not a control', async () => {
    await mount(DEFAULT_LIBRARY);
    await selectRecording(CORPUS_REC.id);
    const field = get('[data-replay-context]');
    expect(field).toHaveAttribute('data-locked', 'true');
    expect(text(field)).toMatch(/\b0\b|zero/i);
    // Nothing inside it can be operated, and it is not itself a control.
    expect(['BUTTON', 'SELECT', 'TEXTAREA']).not.toContain(field.tagName);
    const enabled = Array.from(
      field.querySelectorAll(
        'button:not([disabled]), input:not([disabled]), select:not([disabled]), ' +
          'textarea:not([disabled]), [role="button"], [contenteditable="true"]',
      ),
    );
    expect(enabled).toHaveLength(0);
    if (field.tagName === 'INPUT') expect(field).toBeDisabled();
  });
});

/* ================================================= config panel — running == */

describe('RunConfigPanel — Run triggers exactly one run of the selected Recording', () => {
  it('passes the selected Recording and the panel’s configuration', async () => {
    const fakes = await mount(DEFAULT_LIBRARY);
    await selectRecording(MIC_REC.id);
    setStage('tts', ARM_C_TRIPLE.tts);
    await waitFor(() => expect(derivedTag()).toHaveAttribute('data-derived-tag', 'C'));

    fireEvent.click(screen.getByRole('button', { name: 'Run' }));

    await waitFor(() => expect(fakes.runOnce).toHaveBeenCalledTimes(1));
    const request = fakes.runOnce.mock.calls[0]![0] as ReplayRunRequest;
    expect(request.recordingId).toBe(MIC_REC.id);
    expect(request.config.architecture).toBe('cascade');
    expect(request.config.providers).toEqual(ARM_C_TRIPLE);
    // A single run, and never the sweep.
    expect(fakes.startBatch).not.toHaveBeenCalled();
  });

  it('the produced Run appears in the list of that Recording', async () => {
    const fakes = await mount(DEFAULT_LIBRARY);
    await selectRecording(CORPUS_REC.id);
    expect(runCards()).toHaveLength(0);

    fireEvent.click(screen.getByRole('button', { name: 'Run' }));

    await waitFor(() => expect(runCards().length).toBe(1));
    const created = fakes.store.runs[0]!;
    expect(runCard(created.id)).toHaveAttribute('data-arm', 'B');
  });

  it('a Realtime run carries the pinned realtime model', async () => {
    const fakes = await mount(DEFAULT_LIBRARY);
    await selectRecording(CORPUS_REC.id);
    fireEvent.click(screen.getByRole('button', { name: 'Realtime' }));
    fireEvent.click(screen.getByRole('button', { name: 'Run' }));

    await waitFor(() => expect(fakes.runOnce).toHaveBeenCalledTimes(1));
    const request = fakes.runOnce.mock.calls[0]![0] as ReplayRunRequest;
    expect(request.config.architecture).toBe('realtime');
    expect(request.config.realtimeModel).toBe(REALTIME_MODEL);
  });
});

/* ================================================================ runs list */

describe('RunsList — a run card reports everything a comparison needs', () => {
  const CARDS = [
    {
      name: 'cascade sweep run',
      run: RUN_CASCADE,
      arm: 'B' as ArmTag,
      stages: CASCADE_STAGES,
      total: CASCADE_TOTAL_MS,
      cost: 0.021,
      origin: 'sweep',
    },
    {
      name: 'realtime manual run',
      run: RUN_REALTIME,
      arm: 'A' as ArmTag,
      stages: REALTIME_STAGES,
      total: REALTIME_TOTAL_MS,
      cost: 0.14,
      origin: 'manual',
    },
  ] as const;

  it.each(CARDS)('$name renders pill, config, meta, status, stages, total and $/min', async (spec) => {
    await mount({ recordings: [CORPUS_REC], runs: [RUN_CASCADE, RUN_REALTIME] });
    await selectRecording(CORPUS_REC.id);
    const card = runCard(spec.run.id);

    expect(card).toHaveAttribute('data-arm', spec.arm);
    expect(card).toHaveAttribute('data-status', 'complete');
    expect(text(card.querySelector('[data-run-arm-pill]'))).toBe(armLabel(spec.arm));

    const config = text(card.querySelector('[data-run-config]'));
    for (const model of Object.values(spec.run.modelSnapshots)) {
      expect(config).toContain(model);
    }

    const meta = card.querySelector('[data-run-meta]')!;
    expect(meta).toHaveAttribute('data-mono');
    expect(text(meta)).toContain(`origin ${spec.origin}`);

    expect(text(card.querySelector('[data-run-status]'))).toBe('complete');

    const stages = Array.from(card.querySelectorAll('[data-run-stage]'));
    expect(stages.map((s) => s.getAttribute('data-run-stage'))).toEqual(
      spec.stages.map(([label]) => label),
    );
    for (const [label, value] of spec.stages) {
      const cell = card.querySelector(`[data-run-stage="${label}"]`)!;
      expect(text(cell)).toContain(label);
      expect(text(cell)).toContain(ms(value));
    }

    expect(text(card.querySelector('[data-run-total]'))).toContain(ms(spec.total));
    expect(text(card.querySelector('[data-run-cost]'))).toContain(perMinute(spec.cost));
  });

  it('reports the sweep rep in the meta line', async () => {
    await mount({ recordings: [CORPUS_REC], runs: [RUN_CASCADE] });
    await selectRecording(CORPUS_REC.id);
    expect(text(runCard(RUN_CASCADE.id).querySelector('[data-run-meta]'))).toMatch(/rep 3\b/);
  });

  it('the arm pill is accent for a named arm and gray for ad-hoc — by data, not class', async () => {
    await mount({ recordings: [CORPUS_REC], runs: [RUN_CASCADE, RUN_FAILED] });
    await selectRecording(CORPUS_REC.id);
    expect(runCard(RUN_CASCADE.id)).toHaveAttribute('data-arm', 'B');
    expect(text(runCard(RUN_CASCADE.id).querySelector('[data-run-arm-pill]'))).toBe(armLabel('B'));
    expect(runCard(RUN_FAILED.id)).toHaveAttribute('data-arm', 'ad-hoc');
    expect(text(runCard(RUN_FAILED.id).querySelector('[data-run-arm-pill]'))).toBe('ad-hoc');
  });

  it('cost is normalized per audio minute, not copied off the Run', async () => {
    await mount({ recordings: [MIC_REC], runs: [RUN_ON_MIC] });
    await selectRecording(MIC_REC.id);
    // 0.0105 over a 30-second clip is $0.021 per minute.
    expect(text(runCard(RUN_ON_MIC.id).querySelector('[data-run-cost]'))).toContain(perMinute(0.021));
    expect(text(runCard(RUN_ON_MIC.id).querySelector('[data-run-cost]'))).not.toContain('$0.011');
  });

  it('lists only the selected Recording’s runs', async () => {
    await mount({
      recordings: [CORPUS_REC, MIC_REC],
      runs: [RUN_CASCADE, RUN_REALTIME, RUN_FAILED, RUN_ON_MIC],
    });
    await selectRecording(CORPUS_REC.id);
    expect(runCards().map((c) => c.getAttribute('data-run'))).toEqual([
      RUN_CASCADE.id,
      RUN_REALTIME.id,
      RUN_FAILED.id,
    ]);

    await selectRecording(MIC_REC.id);
    await waitFor(() =>
      expect(runCards().map((c) => c.getAttribute('data-run'))).toEqual([RUN_ON_MIC.id]),
    );
  });
});

describe('RunsList — a failed run is saved, visible and excluded', () => {
  it('names the failing stage and states the exclusion', async () => {
    await mount({ recordings: [CORPUS_REC], runs: [RUN_FAILED] });
    await selectRecording(CORPUS_REC.id);
    const card = runCard(RUN_FAILED.id);

    expect(card).toHaveAttribute('data-status', 'failed');
    expect(text(card.querySelector('[data-run-status]'))).toBe('failed');

    const notice = card.querySelector('[data-run-failure]')!;
    expect(notice).not.toBeNull();
    expect(notice).toHaveAttribute('data-failed-stage', 'tts');
    expect(text(notice)).toContain('tts');
    expect(text(notice)).toContain(FAILURE_TAIL);
  });

  it('offers no playback and no stage figures for a run that produced neither', async () => {
    await mount({ recordings: [CORPUS_REC], runs: [RUN_FAILED] });
    await selectRecording(CORPUS_REC.id);
    const card = runCard(RUN_FAILED.id);
    expect(card.querySelector('[data-run-play]')).toBeNull();
    expect(card.querySelectorAll('[data-run-stage]')).toHaveLength(0);
    expect(card.querySelector('[data-run-total]')).toBeNull();
  });
});

/* ======================================================= nothing autoplays == */

describe('RunsList — NOTHING autoplays (PRD §7)', () => {
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

  it('rendering completed runs constructs no AudioContext, fetches no audio, plays nothing', async () => {
    const fakes = await mount({
      recordings: [CORPUS_REC],
      runs: [RUN_CASCADE, RUN_REALTIME],
    });
    await selectRecording(CORPUS_REC.id);
    expect(runCards()).toHaveLength(2);

    // The play control exists...
    expect(within(runCard(RUN_CASCADE.id)).getByRole('button', { name: 'play' })).toBeInTheDocument();
    // ...and NOTHING has sounded.
    expect(audioContexts).toBe(0);
    expect(fakes.playRun).not.toHaveBeenCalled();
    expect(fakes.runs.getAudio).not.toHaveBeenCalled();
    expect(playSpy).not.toHaveBeenCalled();
    expect(document.querySelectorAll('audio[autoplay], video[autoplay]')).toHaveLength(0);
  });

  it('audio plays only once the control is pressed, and only for that run', async () => {
    const fakes = await mount({
      recordings: [CORPUS_REC],
      runs: [RUN_CASCADE, RUN_REALTIME],
    });
    await selectRecording(CORPUS_REC.id);

    fireEvent.click(within(runCard(RUN_REALTIME.id)).getByRole('button', { name: 'play' }));

    await waitFor(() => expect(fakes.playRun).toHaveBeenCalledTimes(1));
    expect(fakes.playRun).toHaveBeenCalledWith(RUN_REALTIME.id);
  });
});

/* =============================================================== batch ==== */

describe('BatchProgress — position, clock, bar, controls note and cancel', () => {
  const PROGRESS: BatchProgress = {
    runIndex: 17,
    totalRuns: 45,
    recordingId: CORPUS_REC.id,
    configId: '',
    repIndex: 3,
    warmup: false,
    elapsedMs: 1_446_000, // 24:06
    estimatedRemainingMs: 2_490_000, // 41:30
  };

  async function openSweep() {
    const fakes = await mount(DEFAULT_LIBRARY);
    await selectRecording(CORPUS_REC.id);
    fireEvent.click(screen.getByRole('button', { name: 'Batch sweep…' }));
    await waitFor(() => expect(fakes.batches).toHaveLength(1));
    await waitFor(() => expect(q('[data-batch-progress]')).not.toBeNull());
    return fakes;
  }

  it('is absent until the sweep is opened', async () => {
    await mount(DEFAULT_LIBRARY);
    await selectRecording(CORPUS_REC.id);
    expect(q('[data-batch-progress]')).toBeNull();
  });

  it('opens on "Batch sweep…" and starts a sweep over the selected Recording', async () => {
    const fakes = await openSweep();
    const request = fakes.batches[0]!.request;
    expect(request.recordingIds).toContain(CORPUS_REC.id);
    expect(request.configurations.length).toBeGreaterThan(0);
    expect(request.reps).toBeGreaterThan(0);
  });

  it('renders matrix position, elapsed, estimated remaining and a progress bar', async () => {
    const fakes = await openSweep();
    const batch = fakes.batches[0]!;
    const configuration = batch.request.configurations[0] as BatchConfiguration;
    batch.emit({ ...PROGRESS, configId: configuration.id });

    const position = await waitFor(() => get('[data-batch-position]'));
    expect(text(position)).toContain('run 17 of 45');
    expect(text(position)).toContain(CORPUS_REC.id);
    expect(text(position)).toContain(configuration.label ?? configuration.id);
    expect(text(position)).toContain(`rep 3/${batch.request.reps}`);

    const clock = get('[data-batch-clock]');
    expect(text(clock)).toContain('elapsed 24:06');
    expect(text(clock)).toContain('est. remaining 41:30');

    const bar = get('[data-batch-bar]');
    expect(bar).toHaveAttribute('role', 'progressbar');
    expect(bar).toHaveAttribute('aria-valuenow', '17');
    expect(bar).toHaveAttribute('aria-valuemin', '0');
    expect(bar).toHaveAttribute('aria-valuemax', '45');
  });

  it('never fabricates an estimate it does not have', async () => {
    const fakes = await openSweep();
    fakes.batches[0]!.emit({ ...PROGRESS, estimatedRemainingMs: null });
    const clock = await waitFor(() => get('[data-batch-clock]'));
    expect(text(clock)).toContain('elapsed 24:06');
    expect(text(clock)).not.toMatch(/est\. remaining\s*\d/);
  });

  it('states the controls the sweep applied, verbatim', async () => {
    await openSweep();
    expect(text(get('[data-batch-controls-note]'))).toBe(BATCH_CONTROLS_NOTE);
  });

  it('"Cancel — keep completed runs" cancels and the completed runs remain listed', async () => {
    const fakes = await openSweep();
    const batch = fakes.batches[0]!;
    batch.emit(PROGRESS);

    // Two runs completed before the operator stopped watching.
    fakes.store.runs.push(RUN_CASCADE, RUN_REALTIME);

    fireEvent.click(screen.getByRole('button', { name: CANCEL_BATCH }));
    expect(batch.cancel).toHaveBeenCalledTimes(1);

    batch.settle({ status: 'cancelled', completedRuns: 2 });

    await waitFor(() => expect(q('[data-batch-progress]')).toBeNull());
    await waitFor(() => expect(runCards()).toHaveLength(2));
    expect(runCard(RUN_CASCADE.id)).toBeInTheDocument();
    expect(runCard(RUN_REALTIME.id)).toBeInTheDocument();
  });
});

/* ================================================ source-level guarantees == */

describe('Replay sources — tokens only, no mock data, no tag control', () => {
  const FILES = [
    'src/client/views/ReplayView.tsx',
    'src/client/components/replay/RecordingsLibrary.tsx',
    'src/client/components/replay/RunConfigPanel.tsx',
    'src/client/components/replay/RunsList.tsx',
    'src/client/components/replay/BatchProgress.tsx',
  ] as const;

  /** Blanks comments while preserving line count (see deletions.test.ts). */
  function stripComments(source: string): string {
    return source
      .replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, ' '))
      .replace(/(^|[^:])\/\/[^\n]*/g, (_m, lead: string) => lead);
  }

  const sources = FILES.map((file) => ({
    file,
    code: stripComments(readFileSync(resolve(process.cwd(), file), 'utf8')),
  }));

  it('all five components exist and ReplayView composes them', () => {
    const view = sources.find((s) => s.file.endsWith('ReplayView.tsx'))!.code;
    for (const component of ['RecordingsLibrary', 'RunConfigPanel', 'RunsList', 'BatchProgress']) {
      expect(view, `ReplayView must render <${component} />`).toContain(component);
    }
  });

  it('styles from tokens only — no hex, rgb or oklch literal', () => {
    for (const { file, code } of sources) {
      expect(code, file).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
      expect(code, file).not.toMatch(/\brgba?\(/);
      expect(code, file).not.toMatch(/\boklch\(/);
    }
  });

  it('carries none of the mock’s sample recordings, runs or sweep figures', () => {
    const samples = [
      'rec-en-01',
      'rec-en-02',
      'pharmacy dosage test',
      '0:42',
      'run 17 of 45',
      '24:06',
      '41:30',
      '1053 ms',
      '$0.140',
      '$0.021',
      '0.038',
    ];
    for (const { file, code } of sources) {
      for (const sample of samples) {
        expect(code, `${file} must not hardcode ${sample}`).not.toContain(sample);
      }
    }
  });

  // The same discipline deletions.test.ts uses: the criterion is structural,
  // so it is enforced structurally. A tag is READ from deriveArmTag; it is
  // never set, stored, defaulted or typed in.
  const FORBIDDEN: Array<[string, RegExp]> = [
    ['setArmTag', /\bsetArmTag\b/],
    ['onArmTagChange / onTagChange', /\bon(Arm)?TagChange\b/],
    ['selectArm / pickArm / chooseArm', /\b(selectArm|pickArm|chooseArm)\b/],
    ['an arm-selection hook', /data-arm-select|armSelect|armPicker/],
    ['a hardcoded arm label literal', /['"`]Arm [ABC]['"`]/],
    ['a declared tag literal', /armTag\s*[:=]\s*['"`](A|B|C|ad-hoc)['"`]/],
  ];

  it.each(FORBIDDEN)('no control sets a tag directly: %s', (_label, pattern) => {
    for (const { file, code } of sources) {
      expect(code.match(pattern as RegExp) ?? [], file).toEqual([]);
    }
  });

  it('the tag comes from deriveArmTag, and the default triple from core/arms', () => {
    const all = sources.map((s) => s.code).join('\n');
    expect(all).toMatch(/\bderiveArmTag\b/);
    expect(all).toMatch(/\bDEFAULT_CASCADE_TRIPLE\b/);
    expect(all).toMatch(/\bMENUS\b/);
  });
});
