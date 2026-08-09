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
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
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
// TICKET 059 — the four Run fixtures below are runs written by TODAY's code, so
// they declare the price source they ran under; a Run with no stamp priced
// NOTHING and its card reads `not measured` (see `RunsList.playGate.test.tsx`).
import { PRICING_VERSION } from '../../core/pricing';
// TICKET 065 ROUND 2 (F4) — the PRODUCTION execution helper, so the figure on
// screen is pinned to the derivation that owns it and not to a literal 12.
import { executionCount } from '../batch/runner';
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
  pricingVersion: PRICING_VERSION,
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
  pricingVersion: PRICING_VERSION,
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
  pricingVersion: PRICING_VERSION,
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
  pricingVersion: PRICING_VERSION,
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
  // Copied per element, not just per array: `patchLabel` and `remove` write
  // through to the stored object, and sharing identity with the module-level
  // fixtures would let one test's soft delete leak into every later mount.
  const store = {
    recordings: (options.recordings ?? []).map((r) => ({ ...r })),
    runs: (options.runs ?? []).map((r) => ({ ...r })),
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
    // TICKET 049 R2-5 — asserted on the FIRST ARGUMENT rather than the whole
    // call: the seam now takes an optional second argument, the callback a
    // press that could not build an AudioContext reports through
    // (ReplayView.playbackFailure.test.tsx). Which run was played is what this
    // test is about, and that is unchanged.
    expect(fakes.playRun.mock.calls[0]![0]).toBe(RUN_REALTIME.id);
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

  /**
   * TICKET 065 — the press now opens a confirmation and reaches no executor, so
   * "a sweep is running" takes one more step to arrange. Every assertion below
   * is unchanged: what moved is how the sweep gets started, not what it does.
   */
  async function openSweep() {
    const fakes = await mount(DEFAULT_LIBRARY);
    await selectRecording(CORPUS_REC.id);
    fireEvent.click(screen.getByRole('button', { name: 'Batch sweep…' }));
    await waitFor(() => expect(q('[data-sweep-confirm]')).not.toBeNull());
    fireEvent.click(get('[data-sweep-confirm-start]'));
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
    fakes.store.runs.push({ ...RUN_CASCADE }, { ...RUN_REALTIME });

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

/* =========================================== TICKET 062 — the language pair */

/**
 * TICKET 062 — Replay is where the German answer came from.
 *
 * `run()` builds `{ architecture, realtimeModel, providers }` and nothing else,
 * so `runOnce` fills `languagePair`, `direction` and `targetLanguage` with the
 * empty string and the realtime session is instructed to "translate into ".
 * Run dbeb6d94 is that instruction's output: German, on an English↔Spanish
 * project, stored with `languagePair: ''`.
 *
 * The Recording already knows its own `sourceLanguage`, so a run over it can
 * never be language-less. These tests do not dictate a control — they assert
 * that whatever the panel decides, it is CARRIED, non-empty, and points AWAY
 * from the clip's own language.
 */
describe('TICKET 062 — a Replay run carries the language pair and direction', () => {
  /** The two supported pairs, as the session machine defines them. */
  const TARGETS_FROM_EN = ['Spanish', 'Cantonese'];
  const DIRECTIONS_FROM_EN = ['en→es', 'en→yue'];

  it('a run over an ENGLISH Recording is instructed into the other language, never blank', async () => {
    const fakes = await mount(DEFAULT_LIBRARY);
    await selectRecording(CORPUS_REC.id); // sourceLanguage 'en'
    fireEvent.click(screen.getByRole('button', { name: 'Run' }));

    await waitFor(() => expect(fakes.runOnce).toHaveBeenCalledTimes(1));
    const { config } = fakes.runOnce.mock.calls[0]![0] as ReplayRunRequest;
    expect(config.languagePair ?? '').not.toBe('');
    expect(DIRECTIONS_FROM_EN).toContain(config.direction);
    expect(TARGETS_FROM_EN).toContain(config.targetLanguage);
  });

  it('a run over a SPANISH Recording runs es→en — the direction follows the clip', async () => {
    const fakes = await mount(DEFAULT_LIBRARY);
    await selectRecording(MIC_REC.id); // sourceLanguage 'es'
    fireEvent.click(screen.getByRole('button', { name: 'Run' }));

    await waitFor(() => expect(fakes.runOnce).toHaveBeenCalledTimes(1));
    const { config } = fakes.runOnce.mock.calls[0]![0] as ReplayRunRequest;
    // Spanish appears in exactly one pair, so this is fully determined: a clip
    // of Spanish speech cannot be a run whose target is Spanish.
    expect(config.direction).toBe('es→en');
    expect(config.targetLanguage).toBe('English');
    expect(config.languagePair).toBe('EN↔ES');
  });

  it('a REALTIME run carries the language pair too — this is the arm that shipped German', async () => {
    const fakes = await mount(DEFAULT_LIBRARY);
    await selectRecording(CORPUS_REC.id);
    fireEvent.click(screen.getByRole('button', { name: 'Realtime' }));
    fireEvent.click(screen.getByRole('button', { name: 'Run' }));

    await waitFor(() => expect(fakes.runOnce).toHaveBeenCalledTimes(1));
    const { config } = fakes.runOnce.mock.calls[0]![0] as ReplayRunRequest;
    expect(config.architecture).toBe('realtime');
    expect(config.targetLanguage ?? '').not.toBe('');
    expect(TARGETS_FROM_EN).toContain(config.targetLanguage);
  });

  it('EVERY sweep configuration carries it — a sweep is 45 runs of the same defect', async () => {
    const fakes = await mount(DEFAULT_LIBRARY);
    await selectRecording(CORPUS_REC.id);
    fireEvent.click(screen.getByRole('button', { name: 'Batch sweep…' }));
    // TICKET 065 — the press opens a confirmation; confirming is what launches.
    // The configuration assertions below are untouched.
    await waitFor(() => expect(q('[data-sweep-confirm]')).not.toBeNull());
    fireEvent.click(get('[data-sweep-confirm-start]'));
    await waitFor(() => expect(fakes.batches).toHaveLength(1));

    const { configurations } = fakes.batches[0]!.request;
    expect(configurations.length).toBeGreaterThan(0);
    for (const configuration of configurations) {
      expect(configuration.config.languagePair ?? '').not.toBe('');
      expect(DIRECTIONS_FROM_EN).toContain(configuration.config.direction);
      expect(TARGETS_FROM_EN).toContain(configuration.config.targetLanguage);
    }
  });
});

/* =========================== TICKET 061 — the direction is an OPERATOR choice */

/**
 * TICKET 061 AC2 — THE DIRECTION MUST COME FROM AN OPERATOR-VISIBLE CONTROL,
 * NOT A HARDCODED DEFAULT.
 *
 * Ticket 062 made Replay carry a direction, derived from the clip's own
 * `sourceLanguage` through `languageSelectionForSource`. That function returns
 * the FIRST pair whose source matches, and `pairs[0]` is EN↔ES — so every
 * English clip resolves to Spanish and EN→YUE IS UNREACHABLE FROM REPLAY.
 * Sweeps run through Replay, so the kept Cantonese track (PRD §7) cannot be
 * produced at all, and the asymmetry between EN→YUE and YUE→EN — the finding
 * this study exists to report — has no way of being measured.
 *
 * The DOM contract these tests add to RunConfigPanel:
 *   [data-target-language]              the control, present once a Recording
 *                                       is selected
 *     one <button> per LEGAL target for that clip, accessible name = the
 *     language name ('Spanish' / 'Cantonese' for an English clip). The clip's
 *     OWN language is never offered: a run can never point at the language it
 *     is already in, so a Spanish clip has exactly one target and nothing to
 *     resolve. The chosen one carries aria-pressed='true'.
 *
 * The load-bearing assertions read the object handed to `runOnce` and to
 * `startBatch`, never the control's own DOM: a value that changes on screen and
 * never crosses the seam is the defect, not the fix.
 */
describe('TICKET 061 — an operator-visible control picks the target language', () => {
  const targetGroup = (): HTMLElement => get('[data-target-language]');

  const targetOptions = (): string[] =>
    within(targetGroup())
      .getAllByRole('button')
      .map((button) => (button.textContent ?? '').trim());

  const chooseTarget = (language: string): void => {
    fireEvent.click(within(targetGroup()).getByRole('button', { name: language }));
  };

  /** The Run button clears its in-flight lock on every exit (ticket 044). */
  const runAndSettle = async (fakes: { runOnce: { mock: { calls: unknown[] } } }, calls: number) => {
    fireEvent.click(screen.getByRole('button', { name: 'Run' }));
    await waitFor(() => expect(fakes.runOnce.mock.calls).toHaveLength(calls));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Run' })).not.toBeDisabled());
  };

  it('an ENGLISH clip offers both targets of the two supported pairs, and never English', async () => {
    await mount(DEFAULT_LIBRARY);
    await selectRecording(CORPUS_REC.id); // sourceLanguage 'en'

    expect(targetOptions()).toEqual(['Spanish', 'Cantonese']);
    // A run into the language the clip is already in measures nothing.
    expect(within(targetGroup()).queryByRole('button', { name: 'English' })).toBeNull();
  });

  it('choosing Cantonese sends EN↔YUE / en→yue / Cantonese across the runOnce seam', async () => {
    const fakes = await mount(DEFAULT_LIBRARY);
    await selectRecording(CORPUS_REC.id);
    chooseTarget('Cantonese');
    await runAndSettle(fakes, 1);

    const { config } = fakes.runOnce.mock.calls[0]![0] as ReplayRunRequest;
    expect(config.languagePair).toBe('EN↔YUE');
    expect(config.direction).toBe('en→yue');
    expect(config.targetLanguage).toBe('Cantonese');
  });

  it('the choice is visible on the control it was made with', async () => {
    await mount(DEFAULT_LIBRARY);
    await selectRecording(CORPUS_REC.id);
    chooseTarget('Cantonese');

    const group = targetGroup();
    expect(within(group).getByRole('button', { name: 'Cantonese' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect(within(group).getByRole('button', { name: 'Spanish' })).toHaveAttribute(
      'aria-pressed',
      'false',
    );
  });

  it('IT IS THE CONTROL, NOT A CONSTANT: two choices produce two different runs', async () => {
    // The one assertion a hardcoded default cannot satisfy. Either literal —
    // 'en→es' today, 'en→yue' after a careless fix — fails one of these calls.
    const fakes = await mount(DEFAULT_LIBRARY);
    await selectRecording(CORPUS_REC.id);

    chooseTarget('Cantonese');
    await runAndSettle(fakes, 1);
    chooseTarget('Spanish');
    await runAndSettle(fakes, 2);

    const first = (fakes.runOnce.mock.calls[0]![0] as ReplayRunRequest).config;
    const second = (fakes.runOnce.mock.calls[1]![0] as ReplayRunRequest).config;
    expect(first.direction).toBe('en→yue');
    expect(second.direction).toBe('en→es');
    expect(first.targetLanguage).toBe('Cantonese');
    expect(second.targetLanguage).toBe('Spanish');
    expect(first.languagePair).not.toBe(second.languagePair);
  });

  it('EVERY sweep configuration carries the CHOSEN direction — a sweep is 45 runs of it', async () => {
    const fakes = await mount(DEFAULT_LIBRARY);
    await selectRecording(CORPUS_REC.id);
    chooseTarget('Cantonese');
    fireEvent.click(screen.getByRole('button', { name: 'Batch sweep…' }));
    // TICKET 065 — the press opens a confirmation; confirming is what launches.
    // The chosen direction must survive that step, which is the point here.
    await waitFor(() => expect(q('[data-sweep-confirm]')).not.toBeNull());
    fireEvent.click(get('[data-sweep-confirm-start]'));
    await waitFor(() => expect(fakes.batches).toHaveLength(1));

    const { configurations } = fakes.batches[0]!.request;
    expect(configurations.length).toBeGreaterThan(0);
    for (const configuration of configurations) {
      expect(configuration.config.languagePair).toBe('EN↔YUE');
      expect(configuration.config.direction).toBe('en→yue');
      expect(configuration.config.targetLanguage).toBe('Cantonese');
    }
  });

  it('a SPANISH clip has exactly one legal target and still runs es→en', async () => {
    // Spanish appears in one pair only, so there is nothing for an operator to
    // resolve — and the control must not be able to point the clip at Spanish.
    const fakes = await mount(DEFAULT_LIBRARY);
    await selectRecording(MIC_REC.id); // sourceLanguage 'es'

    expect(targetOptions()).toEqual(['English']);
    expect(within(targetGroup()).queryByRole('button', { name: 'Spanish' })).toBeNull();
    expect(within(targetGroup()).queryByRole('button', { name: 'Cantonese' })).toBeNull();

    await runAndSettle(fakes, 1);
    const { config } = fakes.runOnce.mock.calls[0]![0] as ReplayRunRequest;
    expect(config.direction).toBe('es→en');
    expect(config.targetLanguage).toBe('English');
    expect(config.languagePair).toBe('EN↔ES');
  });

  it('a choice made for one clip never leaks onto a clip of another language', async () => {
    // Cantonese chosen for the English clip, then the Spanish clip selected:
    // 'es→yue' is not a pair this study runs, and 'en→yue' would be a run
    // pointed at the wrong source entirely.
    const fakes = await mount(DEFAULT_LIBRARY);
    await selectRecording(CORPUS_REC.id);
    chooseTarget('Cantonese');
    await selectRecording(MIC_REC.id);

    expect(targetOptions()).toEqual(['English']);
    await runAndSettle(fakes, 1);
    const { config } = fakes.runOnce.mock.calls[0]![0] as ReplayRunRequest;
    expect(config.direction).toBe('es→en');
    expect(config.targetLanguage).toBe('English');
  });
});

/* ============ the target-language control is a property of the SELECTED clip */

/**
 * COVERAGE GAP CLOSED — the "absent until a Recording is selected" half of the
 * 061 control contract was asserted in three code comments (ReplayView.tsx
 * :784-786, RunConfigPanel.tsx :350-353) and in no test: every existing case
 * selects a Recording first, so rendering the control with nothing selected
 * left the whole suite green.
 *
 * PRD §17 25c — AN OPERATION THAT IS DISALLOWED HAS NO AFFORDANCE. The legal
 * targets are a property of the CLIP, so with no clip there is no list to
 * offer, and a group rendered anyway "would read as a choice that exists and
 * happens to be unavailable".
 *
 * RunConfigPanel's own `targetLanguages.length > 0` guard cannot carry this:
 * `targetLanguagesForSource('')` is NOT empty — it falls back to the default
 * pair's forward target (sessionMachine.ts:314) — so an unselected view that
 * forwarded `targetOptions` unconditionally would render a one-button
 * 'Spanish' control belonging to no clip at all. The withholding has to happen
 * in the VIEW, and this is the test that makes that line load-bearing.
 */
describe('ReplayView — the target-language control appears only with a clip', () => {
  it('is ABSENT with no Recording selected, and present once one is', async () => {
    await mount(DEFAULT_LIBRARY);

    // Not "disabled", not "empty" — not in the document.
    expect(q('[data-target-language]')).toBeNull();
    expect(screen.queryByText('target language')).toBeNull();
    // And no stray option from the fallback pair is operable either.
    expect(screen.queryByRole('button', { name: 'Spanish' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Cantonese' })).toBeNull();

    await selectRecording(CORPUS_REC.id);

    expect(q('[data-target-language]')).not.toBeNull();
    expect(screen.getByText('target language')).toBeInTheDocument();
    expect(
      within(get('[data-target-language]'))
        .getAllByRole('button')
        .map((button) => (button.textContent ?? '').trim()),
    ).toEqual(['Spanish', 'Cantonese']);
  });

  it('an EMPTY library never renders it — there is no clip to select', async () => {
    await mount({ recordings: [] });
    expect(q('[data-target-language]')).toBeNull();
    expect(screen.queryByText('target language')).toBeNull();
  });
});

/* ========== TICKET 065 — the ellipsis is a promise of a next step ========== */

/**
 * TICKET 065 — `Batch sweep…` calls `deps.startBatch` SYNCHRONOUSLY on click.
 * One click starts 1 recording × 3 frozen arms × (reps + 1) executions —
 * roughly $4 and ~68 minutes at PRD §7's scale — with no cost estimate, no
 * time estimate and no confirmation. A trailing ellipsis promises a next step;
 * there is none, and there is no dialog primitive anywhere in `src/client`.
 *
 * ============ THE DOM CONTRACT THESE TESTS INVENT (it does not exist) =======
 * [data-sweep-confirm]              the intermediate step, rendered OPEN (jsdom
 *                                   has no <dialog>.showModal), role="dialog"
 *                                   with an accessible name. Absent until the
 *                                   batch button is pressed; absent again after
 *                                   either of its two controls.
 *   [data-sweep-reps=<n>]           the retained reps in force — the value that
 *                                   is passed as `reps` to startBatch
 *   [data-sweep-executions=<n>]     TOTAL executions INCLUDING the per-cell
 *                                   warmups: recordings × configurations ×
 *                                   (reps + 1). NOT runner.totalRuns, which
 *                                   excludes them and is 20% short of the bill
 *   [data-sweep-wallclock-ms=<n>]   estimated wall clock: the SELECTED clip's
 *                                   durationMs × executions (replay is paced at
 *                                   1× — eval 08), never a constant
 *   [data-sweep-cost]               an estimated $ figure, or the words
 *                                   `not measured` (COST_NOT_MEASURED_CELL).
 *                                   Never `$0.00` — eval 07
 *   [data-sweep-confirm-start]      button: the ONLY path to deps.startBatch
 *   [data-sweep-confirm-cancel]     button: dismisses, launching nothing
 * ===========================================================================
 *
 * The value-bearing `data-*` attributes follow the file's existing convention
 * (`data-derived-tag={tag}`, `data-target-language={language}`): the datum on
 * the attribute, the prose in the text, so an assertion never has to parse copy.
 *
 * These tests DELIBERATELY do not pin the button's label. Removing the ellipsis
 * and keeping the confirmation both satisfy AC1; what may not survive is a
 * click that reaches an executor.
 */
describe('TICKET 065 — Batch sweep confirms before it spends anything', () => {
  const batchButton = (): HTMLElement => get('[data-batch-button]');
  const confirmPanel = (): HTMLElement | null => q('[data-sweep-confirm]');
  const startControl = (): HTMLElement => get('[data-sweep-confirm-start]');
  const cancelControl = (): HTMLElement => get('[data-sweep-confirm-cancel]');

  /** The datum off the attribute, never scraped out of the copy. */
  const datum = (selector: string, attribute: string): number => {
    const raw = get(selector).getAttribute(attribute);
    expect(raw, `${selector} must carry ${attribute}`).not.toBeNull();
    return Number(raw);
  };

  /** Selects a clip and presses the batch button. Nothing may launch. */
  async function openConfirm(recordingId: string = CORPUS_REC.id) {
    const fakes = await mount({
      recordings: [CORPUS_REC, MIC_REC],
      runs: [] as SeededRun[],
    });
    await selectRecording(recordingId);
    fireEvent.click(batchButton());
    await waitFor(() => expect(confirmPanel()).not.toBeNull());
    return fakes;
  }

  /* -- AC1 + AC5: the click opens something, and spends nothing ------------ */

  it('the click opens an intermediate step and calls startBatch ZERO times', async () => {
    const fakes = await mount(DEFAULT_LIBRARY);
    await selectRecording(CORPUS_REC.id);

    fireEvent.click(batchButton());

    await waitFor(() => expect(confirmPanel()).not.toBeNull());
    // THE assertion of this ticket. An implementation that renders a panel and
    // launches anyway has changed the screen and not the behaviour.
    expect(fakes.startBatch).not.toHaveBeenCalled();
    expect(fakes.batches).toHaveLength(0);
    expect(q('[data-batch-progress]')).toBeNull();
  });

  it('the step is a dialog by role, and it names itself', async () => {
    await openConfirm();
    const panel = confirmPanel()!;
    expect(panel).toHaveAttribute('role', 'dialog');
    const name = panel.getAttribute('aria-label') ?? panel.getAttribute('aria-labelledby') ?? '';
    expect(name.length).toBeGreaterThan(0);
  });

  it('CANCEL dismisses it, starts nothing, and opens no progress panel', async () => {
    const fakes = await openConfirm();

    fireEvent.click(cancelControl());

    await waitFor(() => expect(confirmPanel()).toBeNull());
    expect(fakes.startBatch).not.toHaveBeenCalled();
    expect(fakes.batches).toHaveLength(0);
    expect(q('[data-batch-progress]')).toBeNull();
  });

  /* -- AC2: the count includes the warmups -------------------------------- */

  it('names the execution count INCLUDING warmups — twelve, not the nine totalRuns reports', async () => {
    await openConfirm();

    // Hand-derived from the matrix, not re-expressed from the component's
    // constants: 1 clip × 3 frozen arms × (3 retained reps + 1 warmup) = 12.
    // `runner.ts` would report 9 for the same sweep, and 9 is the number
    // already on screen in BatchProgress — so it is the one a fix reaches for.
    expect(datum('[data-sweep-executions]', 'data-sweep-executions')).toBe(12);
    expect(datum('[data-sweep-executions]', 'data-sweep-executions')).not.toBe(9);
    expect(text(get('[data-sweep-executions]'))).toContain('12');
  });

  /* -- AC6: §15A cut five-rep sweeps to three ----------------------------- */

  it('the reps in force are THREE — PRD §15A (2026-08-09) beats §17 22c', async () => {
    await openConfirm();
    expect(datum('[data-sweep-reps]', 'data-sweep-reps')).toBe(3);
    expect(datum('[data-sweep-reps]', 'data-sweep-reps')).not.toBe(5);
  });

  it('the reps the operator was SHOWN are the reps the sweep is started with', async () => {
    const fakes = await openConfirm();
    const shown = datum('[data-sweep-reps]', 'data-sweep-reps');

    fireEvent.click(startControl());

    await waitFor(() => expect(fakes.batches).toHaveLength(1));
    expect(fakes.batches[0]!.request.reps).toBe(shown);
    expect(fakes.batches[0]!.request.reps).toBe(3);
  });

  /* -- AC3: the wall clock comes from the CLIP ---------------------------- */

  const CLIPS = [
    { name: 'the 60 s corpus clip', recordingId: CORPUS_REC.id, wallclockMs: 720_000 },
    { name: 'the 30 s mic clip', recordingId: MIC_REC.id, wallclockMs: 360_000 },
  ] as const;

  it.each(CLIPS)(
    'the wall-clock estimate is derived from $name, not from a constant',
    async ({ recordingId, wallclockMs }) => {
      await openConfirm(recordingId);
      // durationMs × 12 executions — replay is paced at 1× (eval 08), so the
      // duration of a sweep is bounded by real time, not by compute. Two clips
      // of different lengths must produce two different figures; a constant
      // fails one of these two cases whichever constant it is.
      expect(datum('[data-sweep-wallclock-ms]', 'data-sweep-wallclock-ms')).toBe(wallclockMs);
    },
  );

  /* -- AC4: an unpriced estimate says so ---------------------------------- */

  it('the cost is a figure or the words `not measured` — never $0.00', async () => {
    await openConfirm();
    const cost = text(get('[data-sweep-cost]'));

    expect(cost).not.toBe('');
    // Unmeasured is null and renders `not measured`; a zero would report the
    // sweep as free (eval 07, and COST_NOT_MEASURED_CELL in core/pricing).
    // Two legal answers and no third: a priced figure that is not zero, or the
    // words. `$0.00` is neither, and is the failure this criterion names.
    const figure = /\$([\d.]+)/.exec(cost);
    if (figure === null) {
      expect(cost).toBe('not measured');
    } else {
      expect(Number(figure[1])).toBeGreaterThan(0);
    }
  });

  /* -- AC5: confirming is the only path to the executor -------------------- */

  it('CONFIRM starts exactly one sweep, over the selected clip and the three arms', async () => {
    const fakes = await openConfirm();

    fireEvent.click(startControl());

    await waitFor(() => expect(fakes.batches).toHaveLength(1));
    const request = fakes.batches[0]!.request;
    expect(request.recordingIds).toEqual([CORPUS_REC.id]);
    expect(request.configurations).toHaveLength(3);
    expect(request.configurations.map((c) => c.id).sort()).toEqual(['A', 'B', 'C']);
    await waitFor(() => expect(q('[data-batch-progress]')).not.toBeNull());
    await waitFor(() => expect(confirmPanel()).toBeNull());
  });

  it('pressing the batch button twice cannot launch twice — the GATE is on the handler', async () => {
    // The trap: a confirm added INSIDE startSweep, after its
    // `if (selectedRecordingId === null || sweep !== null) return;` guard, is
    // re-enterable while `sweep` is still null.
    const fakes = await openConfirm();

    fireEvent.click(batchButton());
    fireEvent.click(batchButton());
    expect(fakes.startBatch).not.toHaveBeenCalled();

    fireEvent.click(startControl());

    await waitFor(() => expect(fakes.batches).toHaveLength(1));
    expect(fakes.startBatch).toHaveBeenCalledTimes(1);
  });

  it('the chosen target language survives the confirmation (ticket 061 regression)', async () => {
    const fakes = await mount(DEFAULT_LIBRARY);
    await selectRecording(CORPUS_REC.id);
    fireEvent.click(
      within(get('[data-target-language]')).getByRole('button', { name: 'Cantonese' }),
    );

    fireEvent.click(batchButton());
    await waitFor(() => expect(confirmPanel()).not.toBeNull());
    fireEvent.click(startControl());

    await waitFor(() => expect(fakes.batches).toHaveLength(1));
    for (const configuration of fakes.batches[0]!.request.configurations) {
      expect(configuration.config.languagePair).toBe('EN↔YUE');
      expect(configuration.config.direction).toBe('en→yue');
      expect(configuration.config.targetLanguage).toBe('Cantonese');
    }
  });
});

/* ===== TICKET 066 — a restored selection resolves against the library ====== */

/**
 * TICKET 066 — the selection lives in a plain `useState<string | null>(null)`
 * that `App.tsx` unmounts on every tab change, so `Replay → Results → Replay`
 * leaves the Runs panel saying "No Runs of this Recording yet." while the
 * sidebar row still reads "3 runs". The round-trip itself is asserted through
 * the REAL view switcher in App.test.tsx; what lives here is the half that is
 * ReplayView's alone — what a RESTORED id means when it names nothing.
 *
 * ================= THE SEAM THESE TESTS INVENT (it does not exist) =========
 * `ReplayDeps.selectionStore?: { get(): string | null; set(id: string | null): void }`
 *   — injected, on the deps bag, exactly as `RunLedger`'s localStorage-shaped
 *   seam is (ledger.ts:382 → browserDeps.ts:522). OPTIONAL on the bag, because
 *   App must fill it in for a host that omits one — the same way App already
 *   supplies `rng`, `evaluatorLanguage` and `recordBlindComparison`. That is
 *   what keeps App.test.tsx's deliberately-minimal bag working, and it is what
 *   the App round-trip test proves.
 *
 * The two failure cases below are where the contradiction MOVES rather than
 * disappears: an id whose Recording is gone is a selection with no row, which
 * is the same bug inverted.
 * ===========================================================================
 */
describe('TICKET 066 — a restored Recording selection', () => {
  interface SelectionSeam {
    get: () => string | null;
    set: (id: string | null) => void;
  }

  /** A fakes bag carrying a pre-loaded selection store, plus a way to read it. */
  function withRestoredSelection(
    options: { recordings?: Recording[]; runs?: SeededRun[]; listDeleted?: boolean },
    restored: string | null,
  ) {
    const fakes = makeFakes({ recordings: options.recordings, runs: options.runs });
    if (options.listDeleted === true) {
      // The default fake hides soft-deleted Recordings from `list()`. A stored
      // id naming one has to be REACHABLE to be resolved, so this bag answers
      // with the whole store — which is what the production client does, and
      // why `selectedRecording` (all recordings) and `visibleRecordings`
      // (deletedAt === undefined) can disagree at all.
      fakes.recordings.list.mockImplementation(async () =>
        fakes.store.recordings.map((r) => ({ ...r })),
      );
    }
    let current = restored;
    const selectionStore: SelectionSeam = {
      get: () => current,
      set: (id) => {
        current = id;
      },
    };
    const deps = { ...fakes.deps, selectionStore } as ReplayDeps;
    return { ...fakes, deps, read: (): string | null => current };
  }

  const selectedRows = (): HTMLElement[] =>
    Array.from(document.querySelectorAll<HTMLElement>('[data-recording-row][data-selected="true"]'));

  const NO_SELECTION_HINT = 'Select a Recording in the library to run against';

  /** The RESTORED clip is really selected — without this, the two below pass dead. */
  it('naming a live Recording selects it, and the count and the Runs list agree', async () => {
    const bag = withRestoredSelection(
      {
        recordings: [CORPUS_REC, MIC_REC],
        runs: [RUN_CASCADE, RUN_REALTIME, RUN_FAILED, RUN_ON_MIC],
      },
      CORPUS_REC.id,
    );
    render(<ReplayView deps={bag.deps} />);

    await waitFor(() => {
      const element = row(CORPUS_REC.id);
      expect(element).toHaveAttribute('data-selected', 'true');
      // The library's count and the panel's list, read in the SAME assertion:
      // the defect is that these two can disagree, so they are never checked
      // one after the other.
      expect(text(element.querySelector('[data-recording-run-count]'))).toContain('3');
      expect(runCards().map((card) => card.getAttribute('data-run')).sort()).toEqual(
        [RUN_CASCADE.id, RUN_FAILED.id, RUN_REALTIME.id].sort(),
      );
    });
    expect(screen.queryByText('No Runs of this Recording yet.')).toBeNull();
    expect(get('[data-run-button]')).not.toBeDisabled();
    expect(get('[data-batch-button]')).not.toBeDisabled();
  });

  it('naming a Recording ABSENT from the library resolves to NO selection', async () => {
    const bag = withRestoredSelection(
      { recordings: [CORPUS_REC, MIC_REC], runs: [RUN_CASCADE] },
      'rec-that-is-gone',
    );
    render(<ReplayView deps={bag.deps} />);
    await waitFor(() => expect(rows()).toHaveLength(2));

    // Not one row left marked selected...
    expect(selectedRows()).toHaveLength(0);
    // ...and no control left holding the stale id: both actions are disabled
    // for the NO-SELECTION reason, which is the reason that is true.
    expect(get('[data-run-button]')).toBeDisabled();
    expect(get('[data-batch-button]')).toBeDisabled();
    expect(get('[data-run-button]')).toHaveAttribute('title', NO_SELECTION_HINT);
    expect(get('[data-batch-button]')).toHaveAttribute('title', NO_SELECTION_HINT);
    expect(text(get('[data-run-config-panel]'))).toContain('select a Recording to run against');
    // No clip means no legal targets, so the 061 control is absent too.
    expect(q('[data-target-language]')).toBeNull();
  });

  it('naming a SOFT-DELETED Recording resolves to NO selection the same way', async () => {
    // `selectedRecording` searches ALL recordings while `visibleRecordings`
    // excludes soft-deleted ones, so this id otherwise yields a non-null
    // selection with no row to mark — the contradiction, inverted.
    const DELETED_MIC: Recording = { ...MIC_REC, deletedAt: T0 + 5_000 };
    const bag = withRestoredSelection(
      {
        recordings: [CORPUS_REC, DELETED_MIC],
        runs: [RUN_CASCADE, RUN_ON_MIC],
        listDeleted: true,
      },
      MIC_REC.id,
    );
    render(<ReplayView deps={bag.deps} />);
    await waitFor(() => expect(rows()).toHaveLength(1));

    expect(q(`[data-recording-row][data-recording="${MIC_REC.id}"]`)).toBeNull();
    expect(selectedRows()).toHaveLength(0);
    expect(get('[data-run-button]')).toBeDisabled();
    expect(get('[data-batch-button]')).toBeDisabled();
    expect(get('[data-run-button]')).toHaveAttribute('title', NO_SELECTION_HINT);
    expect(text(get('[data-run-config-panel]'))).toContain('select a Recording to run against');
  });

  it('an operator selection is written to the store it was restored from', async () => {
    const bag = withRestoredSelection(
      { recordings: [CORPUS_REC, MIC_REC], runs: [RUN_ON_MIC] },
      null,
    );
    render(<ReplayView deps={bag.deps} />);
    await waitFor(() => expect(rows()).toHaveLength(2));

    await selectRecording(MIC_REC.id);

    // A store that is only ever READ restores whatever it was seeded with and
    // never the clip the operator actually picked.
    await waitFor(() => expect(bag.read()).toBe(MIC_REC.id));
  });
});

/* ===== TICKET 066 — the count and the empty state never contradict ======== */

/**
 * AC6 — `No Runs of this Recording yet.` may render only when a Recording IS
 * selected and its `runCounts` entry is 0. These two are the invariant stated
 * in both directions; the case where today's code breaks it (after a tab
 * round-trip) is asserted through <App /> in App.test.tsx, because the
 * contradiction needs the unmount to appear at all.
 */
describe('TICKET 066 — the sidebar count and the Runs panel say the same thing', () => {
  it('a clip WITH runs: no empty state, and the count equals the cards', async () => {
    await mount({
      recordings: [CORPUS_REC, MIC_REC],
      runs: [RUN_CASCADE, RUN_REALTIME, RUN_FAILED, RUN_ON_MIC],
    });
    await selectRecording(CORPUS_REC.id);

    await waitFor(() => expect(runCards()).toHaveLength(3));
    expect(screen.queryByText('No Runs of this Recording yet.')).toBeNull();
    expect(text(row(CORPUS_REC.id).querySelector('[data-recording-run-count]'))).toContain(
      String(runCards().length),
    );
  });

  it('a clip with ZERO runs: the empty state, and a count that says zero', async () => {
    await mount({
      recordings: [CORPUS_REC, MIC_REC],
      runs: [RUN_CASCADE, RUN_REALTIME, RUN_FAILED],
    });
    await selectRecording(MIC_REC.id);

    await waitFor(() =>
      expect(screen.queryByText('No Runs of this Recording yet.')).not.toBeNull(),
    );
    expect(runCards()).toHaveLength(0);
    expect(text(row(MIC_REC.id).querySelector('[data-recording-run-count]'))).toContain('0');
  });
});

/* ======= TICKET 066 — the persistence is a SEAM, not a global reach ======= */

describe('TICKET 066 — no view reaches for browser storage directly', () => {
  const FILES = ['src/client/views/ReplayView.tsx', 'src/client/App.tsx'] as const;

  /** Blanks comments while preserving line count (see deletions.test.ts). */
  function strip(source: string): string {
    return source
      .replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, ' '))
      .replace(/(^|[^:])\/\/[^\n]*/g, (_m, lead: string) => lead);
  }

  it.each(FILES)('%s names no localStorage or sessionStorage', (file) => {
    // The precedent is `new RunLedger(window.localStorage)` in browserDeps.ts:
    // the store is handed IN. A view that reaches for `window.localStorage`
    // works in jsdom, which is exactly why the bypass survives a test suite.
    // (The URL is a legitimate alternative store — ticket 066's own note — so
    // it is not forbidden here; it too must arrive through the bag.)
    const code = strip(readFileSync(resolve(process.cwd(), file), 'utf8'));
    expect(code, `${file} must take its store through deps`).not.toMatch(/\blocalStorage\b/);
    expect(code, `${file} must take its store through deps`).not.toMatch(/\bsessionStorage\b/);
  });
});

/* ===== TICKET 065 ROUND 2 — the quote and the screen cannot disagree ====== */

/**
 * ROUND 2 F2 (P1) — THE QUOTE FROZE; THE SCREEN BEHIND IT DID NOT.
 *
 * `SweepPlan` captures the recording id and the configurations at press time and
 * hands THOSE objects to the executor — which is right, and is what ticket 065
 * fixed. But `sweepInFlight` is false while a quote is open and the panel was
 * modal in name only: no backdrop, no focus trap, no `inert`. So the operator
 * could click a different library row, or change ticket 061's target language,
 * and then press Start sweep: the sweep ran the QUOTED clip and target while the
 * library and the target control showed the NEW ones. That is a displayed value
 * disagreeing with what runs — the characteristic failure, one step past the one
 * 065 fixed — and `aria-modal="true"` on a non-modal panel was itself a false
 * claim.
 *
 * THE FIX ASSERTED HERE: the quote is genuinely modal. The two regions holding
 * every control that could contradict it are `inert` (the affordance), and the
 * selection and target-language handlers refuse while it is open (the fact —
 * jsdom does not implement inert, and neither does a keyboard-driven browser
 * without it). Plus the dialog NAMES the language pair and direction it will
 * run, so the quote is self-describing rather than silent about the one thing
 * ticket 061 made variable.
 *
 * ============ ADDED TO THE DOM CONTRACT =====================================
 * [data-sweep-language-pair=<pair>][data-sweep-direction=<direction>]
 *   [data-sweep-target-language=<language>]  inside [data-sweep-confirm]
 * [data-replay-background] — the regions behind the quote; `inert` while open
 * ===========================================================================
 */
describe('TICKET 065 ROUND 2 — the quote is MODAL, and it names its language pair', () => {
  const batchButton = (): HTMLElement => get('[data-batch-button]');
  const confirmPanel = (): HTMLElement | null => q('[data-sweep-confirm]');
  const startControl = (): HTMLElement => get('[data-sweep-confirm-start]');
  const cancelControl = (): HTMLElement => get('[data-sweep-confirm-cancel]');
  const backgrounds = (): HTMLElement[] =>
    Array.from(document.querySelectorAll<HTMLElement>('[data-replay-background]'));

  const pickTarget = (language: string): void => {
    fireEvent.click(within(get('[data-target-language]')).getByRole('button', { name: language }));
  };

  async function openConfirm(recordingId: string = CORPUS_REC.id) {
    const fakes = await mount({ recordings: [CORPUS_REC, MIC_REC], runs: [] as SeededRun[] });
    await selectRecording(recordingId);
    fireEvent.click(batchButton());
    await waitFor(() => expect(confirmPanel()).not.toBeNull());
    return fakes;
  }

  it('the dialog NAMES the pair, the direction and the target it will run', async () => {
    const fakes = await mount(DEFAULT_LIBRARY);
    await selectRecording(CORPUS_REC.id);
    pickTarget('Cantonese');
    fireEvent.click(batchButton());
    await waitFor(() => expect(confirmPanel()).not.toBeNull());

    // Read off the DIALOG, then compared against what the executor receives —
    // never two literals compared with each other.
    const named = get('[data-sweep-language-pair]');
    expect(named.getAttribute('data-sweep-language-pair')).toBe('EN↔YUE');
    expect(named.getAttribute('data-sweep-direction')).toBe('en→yue');
    expect(named.getAttribute('data-sweep-target-language')).toBe('Cantonese');
    // The operator reads the copy, not the attributes.
    expect(text(named)).toContain('EN↔YUE');
    expect(text(named)).toContain('en→yue');
    expect(text(named)).toContain('Cantonese');

    fireEvent.click(startControl());

    await waitFor(() => expect(fakes.batches).toHaveLength(1));
    for (const configuration of fakes.batches[0]!.request.configurations) {
      expect(configuration.config.languagePair).toBe(
        named.getAttribute('data-sweep-language-pair'),
      );
      expect(configuration.config.direction).toBe(named.getAttribute('data-sweep-direction'));
      expect(configuration.config.targetLanguage).toBe(
        named.getAttribute('data-sweep-target-language'),
      );
    }
  });

  it('a LIBRARY ROW pressed while the quote is open changes nothing — and the sweep is the quoted clip', async () => {
    const fakes = await openConfirm(CORPUS_REC.id);
    const quotedWallclock = get('[data-sweep-wallclock-ms]').getAttribute(
      'data-sweep-wallclock-ms',
    );

    fireEvent.click(row(MIC_REC.id));

    // The SCREEN did not move: the quoted clip is still the selected one, so
    // there is nothing for the executor to disagree with.
    expect(row(CORPUS_REC.id)).toHaveAttribute('data-selected', 'true');
    expect(row(MIC_REC.id)).toHaveAttribute('data-selected', 'false');
    // ...and the quote did not move either — the 30 s clip would have re-quoted
    // the wall clock at 360000.
    expect(get('[data-sweep-wallclock-ms]').getAttribute('data-sweep-wallclock-ms')).toBe(
      quotedWallclock,
    );

    fireEvent.click(startControl());

    await waitFor(() => expect(fakes.batches).toHaveLength(1));
    expect(fakes.batches[0]!.request.recordingIds).toEqual([CORPUS_REC.id]);
  });

  it('a TARGET-LANGUAGE press while the quote is open changes nothing — and the sweep is the quoted target', async () => {
    const fakes = await openConfirm(CORPUS_REC.id);
    expect(get('[data-sweep-language-pair]').getAttribute('data-sweep-direction')).toBe('en→es');

    pickTarget('Cantonese');

    // The control still reads what the quote names — this is the pairing that
    // was silently breakable: the dialog said en→es and en→yue would have run.
    expect(get('[data-target-language]').getAttribute('data-target-language')).toBe('Spanish');
    expect(get('[data-sweep-language-pair]').getAttribute('data-sweep-direction')).toBe('en→es');

    fireEvent.click(startControl());

    await waitFor(() => expect(fakes.batches).toHaveLength(1));
    for (const configuration of fakes.batches[0]!.request.configurations) {
      expect(configuration.config.languagePair).toBe('EN↔ES');
      expect(configuration.config.direction).toBe('en→es');
      expect(configuration.config.targetLanguage).toBe('Spanish');
    }
  });

  it('the regions behind the quote are INERT while it is open — the affordance', async () => {
    await openConfirm(CORPUS_REC.id);
    const behind = backgrounds();
    // Both regions holding a control that could contradict the quote: the
    // library and the run panel (the 061 target control), and the header.
    expect(behind.length).toBeGreaterThanOrEqual(2);
    expect(behind.some((element) => element.contains(get('[data-recordings-library]')))).toBe(
      true,
    );
    expect(behind.some((element) => element.contains(get('[data-target-language]')))).toBe(true);
    for (const element of behind) expect(element).toHaveAttribute('inert');
    // The dialog itself must NOT be inert — it is the thing being operated.
    expect(confirmPanel()!.hasAttribute('inert')).toBe(false);
    expect(backgrounds().some((element) => element.contains(confirmPanel()!))).toBe(false);
  });

  it('CANCEL gives the screen back — the modality is the quote’s, not permanent', async () => {
    await openConfirm(CORPUS_REC.id);

    fireEvent.click(cancelControl());
    await waitFor(() => expect(confirmPanel()).toBeNull());

    for (const element of backgrounds()) expect(element.hasAttribute('inert')).toBe(false);
    // ...and both refusals are lifted, not latched.
    await selectRecording(MIC_REC.id);
    pickTarget('English');
    expect(get('[data-target-language]').getAttribute('data-target-language')).toBe('English');
  });
});

/* ===== TICKET 065 ROUND 2 — the PRICED branch of the quote =============== */

/**
 * ROUND 2 F3 (P1) — every 065 test mounted with `runs: []`, so the figure branch
 * of `[data-sweep-cost]` never rendered: `projectSweepCostUsd` could be replaced
 * by a constant `not measured` with the suite green.
 *
 * THE MEASURED-ZERO RULING (F3's flagged judgment call). The guard was
 * `if (!(perExecution > 0)) return { usd: null }`, which reported a rate of
 * exactly zero — stamped with a price source, priced today, genuinely free — as
 * ABSENCE. That inverts the other half of ticket 059 ("a Run written today whose
 * measured cost really is 0 still renders $0.000") and breaks the standing rule
 * that zero is a measurement and absence is not. It is FIXED here rather than
 * pinned: AC4 forbids `$0.00`, and `formatCostUsd` renders a measured zero as
 * `$0.000` — three decimals, because `formatAmountUsd` already refuses to let a
 * real figure collapse into two. An UNPRICED sweep still reads `not measured`.
 */
describe('TICKET 065 ROUND 2 — the quote prices itself from PRICED prior runs', () => {
  const batchButton = (): HTMLElement => get('[data-batch-button]');
  const confirmPanel = (): HTMLElement | null => q('[data-sweep-confirm]');
  const cost = (): HTMLElement => get('[data-sweep-cost]');

  async function quote(runs: SeededRun[], recordingId: string = CORPUS_REC.id) {
    const fakes = await mount({ recordings: [CORPUS_REC, MIC_REC], runs });
    await selectRecording(recordingId);
    fireEvent.click(batchButton());
    await waitFor(() => expect(confirmPanel()).not.toBeNull());
    return fakes;
  }

  /** Completed, priced today: $0.021 and $0.14 over the corpus clip. */
  const PRICED_PAIR = [RUN_CASCADE, RUN_REALTIME];

  it('renders a REAL $ figure — the mean measured rate × the executions ahead', async () => {
    await quote([...PRICED_PAIR, RUN_FAILED]);

    // Hand-derived, not re-expressed from the component: (0.021 + 0.14) / 2
    // = 0.0805 per execution × 12 executions = 0.966. RUN_FAILED is not
    // complete, so it is no evidence of a rate at all.
    expect(text(cost())).toBe('$0.966');
    expect(text(get('[data-sweep-cost]').parentElement)).toContain(
      'projected from 2 priced prior runs of this clip',
    );
  });

  it('an UNSTAMPED prior run contributes NOTHING — not to the sum, not to the denominator', async () => {
    // TICKET 059's discriminator: a Run that declares no price source priced
    // nothing, whatever figure it stores. $9.99 landing in the numerator would
    // read $60.06; landing in the denominator alone would read $0.126.
    const UNSTAMPED: SeededRun = {
      ...RUN_REALTIME,
      id: 'run-unstamped',
      cost: 9.99,
      pricingVersion: undefined,
    };
    await quote([RUN_CASCADE, UNSTAMPED]);

    // 0.021 × 12 — the ONE priced run is the whole basis.
    expect(text(cost())).toBe('$0.252');
    expect(text(get('[data-sweep-cost]').parentElement)).toContain(
      'projected from 1 priced prior runs of this clip',
    );
  });

  it('a clip whose prior runs are ALL unstamped quotes `not measured`, never a zero', async () => {
    const UNSTAMPED: SeededRun = { ...RUN_CASCADE, id: 'run-u1', pricingVersion: undefined };
    await quote([UNSTAMPED]);

    expect(text(cost())).toBe('not measured');
    expect(text(get('[data-sweep-cost]').parentElement)).toContain(
      'no priced run of this clip to project from',
    );
  });

  it('a MEASURED zero is a measurement: it quotes $0.000, not `not measured`', async () => {
    // The F3 ruling, pinned. This Run was written today, under a named price
    // source, and really cost nothing. Absence would be a different fact.
    const FREE: SeededRun = { ...RUN_CASCADE, id: 'run-free', cost: 0 };
    await quote([FREE]);

    expect(text(cost())).toBe('$0.000');
    expect(text(cost())).not.toBe('not measured');
    // AC4 stands: the string this ticket forbids is `$0.00`, and the formatter
    // never produces it for a figure anyone measured.
    expect(text(cost())).not.toBe('$0.00');
    expect(text(get('[data-sweep-cost]').parentElement)).toContain(
      'projected from 1 priced prior runs of this clip',
    );
  });

  it('the runs of ANOTHER clip price nothing here — the basis is this clip’s own', async () => {
    // RUN_ON_MIC is priced and complete, but it is evidence about the 30 s mic
    // clip, not about the corpus one.
    await quote([RUN_ON_MIC], CORPUS_REC.id);

    expect(text(cost())).toBe('not measured');
  });
});

/* ===== TICKET 065 ROUND 2 — the execution figure is PINNED to its source == */

/**
 * ROUND 2 F4 (P2) — `const executions = 12` hardcoded in the view passed
 * everything: reps are separately pinned to what `startBatch` receives, but an
 * ARM-COUNT change (3 → 4) would drift silently, and the copy would then read
 * "12 · 1 clip × 4 configurations × (3 + 1 warmup)" with nothing objecting.
 *
 * So the displayed count is pinned to `executionCount` over the configuration
 * count the executor ACTUALLY receives — the same production helper the view
 * calls, fed the matrix that really ran.
 */
describe('TICKET 065 ROUND 2 — the quoted executions are derived from the REAL matrix', () => {
  it('the figure equals executionCount(1, the configurations that launch, the reps that launch)', async () => {
    const fakes = await mount(DEFAULT_LIBRARY);
    await selectRecording(CORPUS_REC.id);
    fireEvent.click(get('[data-batch-button]'));
    await waitFor(() => expect(q('[data-sweep-confirm]')).not.toBeNull());

    const shown = Number(get('[data-sweep-executions]').getAttribute('data-sweep-executions'));
    const shownCopy = text(get('[data-sweep-executions]'));

    fireEvent.click(get('[data-sweep-confirm-start]'));
    await waitFor(() => expect(fakes.batches).toHaveLength(1));
    const request = fakes.batches[0]!.request;

    // The matrix that RAN is the authority: grow ARMS to four and this moves,
    // where a literal 12 in the view would not.
    expect(shown).toBe(executionCount(1, request.configurations.length, request.reps));
    // ...and the copy names the same configuration count it was derived from,
    // so the sentence cannot contradict its own leading number.
    expect(shownCopy).toContain(`${request.configurations.length} configurations`);
    expect(shownCopy).toContain(`(${request.reps} + 1 warmup)`);
  });

  it('the view DERIVES the figure — it does not carry one', () => {
    // A SOURCE-TEXT assertion BY NECESSITY, and labelled as one — the same
    // necessity `browserDeps.inboundTap.test.ts` documents for its R3-5 case.
    // The sweep matrix has exactly ONE shape at runtime (1 clip × frozen ARMS ×
    // SWEEP_REPS), so `const executions = 12` and the derivation render the
    // identical DOM today and diverge only when ARMS grows to four. Nothing
    // observable distinguishes them from outside, so the assertion above cannot
    // reach the drift on its own, and this is what holds the derivation in
    // place until the day it does.
    const source = readFileSync(resolve(process.cwd(), 'src/client/views/ReplayView.tsx'), 'utf8');
    const quoteBody = source.slice(
      source.indexOf('const openSweepConfirm'),
      source.indexOf('const cancelSweepConfirm'),
    );
    expect(quoteBody).toMatch(/executionCount\(1, configurations\.length, SWEEP_REPS\)/);
    // ...and no literal standing in for it.
    expect(quoteBody).not.toMatch(/const executions = \d/);
  });
});

/* ===== TICKET 066 ROUND 2 — a stale id is CLEARED, not merely ignored ===== */

/**
 * ROUND 2 F5 (P2) — the absent-Recording case passed vacuously: both actions
 * disable on `recordingLabel === null` (the RESOLVED object), so an unresolved
 * stale id naming an absent clip already yields the asserted state, for the
 * wrong reason. What actually went untested is `deps.selectionStore?.set(null)`
 * — without it the dead id is restored on every future mount, forever.
 */
describe('TICKET 066 ROUND 2 — an unresolvable restored id is CLEARED from the store', () => {
  it('an ABSENT clip’s id is erased, so the next mount restores nothing', async () => {
    const fakes = makeFakes({ recordings: [CORPUS_REC, MIC_REC], runs: [RUN_CASCADE] });
    let current: string | null = 'rec-that-is-gone';
    const deps = {
      ...fakes.deps,
      selectionStore: {
        get: () => current,
        set: (id: string | null) => {
          current = id;
        },
      },
    } as ReplayDeps;

    const first = render(<ReplayView deps={deps} />);
    await waitFor(() => expect(rows()).toHaveLength(2));

    // THE assertion: not "the id is ignored" — "the id is gone".
    await waitFor(() => expect(current).toBeNull());

    // And the harm it prevents, played out: a fresh mount over the same store.
    first.unmount();
    render(<ReplayView deps={deps} />);
    await waitFor(() => expect(rows()).toHaveLength(2));
    expect(
      document.querySelectorAll('[data-recording-row][data-selected="true"]'),
    ).toHaveLength(0);
    expect(current).toBeNull();
  });
});

/* ===== TICKET 067 — the sweep clock TICKS, and a tick is not a measurement === */

/**
 * TICKET 067 — THE SWEEP CLOCK DOES NOT TICK.
 *
 * `BatchProgress` already renders `[data-batch-clock]`. What it does not do is
 * MOVE: `elapsedMs` and `estimatedRemainingMs` are fields on the progress event,
 * and `runner.ts` emits only at run boundaries. Replay is paced at 1× (golden
 * eval 08 pins that), so a one-recording sweep is 12 executions over 6-8 minutes
 * and the clock advances about 12 times. Between those it shows a stale
 * snapshot, which is indistinguishable from a hung sweep — the operator
 * refreshed, and because the batch runner is client-side the refresh killed the
 * sweep. The frozen clock cost a real sweep.
 *
 * ============ THE SEAM THESE TESTS DEFINE ===================================
 *
 *   /** TICKET 067 — where the sweep clock's ticks come from. *\/
 *   export interface SweepClock {
 *     /** Wall clock in ms — the SAME units as `BatchProgress.elapsedMs`. *\/
 *     now: () => number;
 *     /**
 *      * Calls `onTick` while a sweep is in flight (production: about 1 Hz).
 *      * Returns the teardown, which MUST be called when the sweep ends, is
 *      * cancelled, or the panel unmounts.
 *      *\/
 *     subscribe: (onTick: () => void) => () => void;
 *   }
 *
 *   // on ReplayDeps, OPTIONAL exactly as `selectionStore` and `rng` are —
 *   // App is the host that fills it in; a bag without one simply does not tick.
 *   sweepClock?: SweepClock;
 *
 * WHY THERE. `ReplayView` owns `SweepState` and therefore owns the three moments
 * the subscription's lifetime is defined by (start, cancel, done), and it is
 * already the single boundary every outside-world reach in this view goes
 * through — `now`, `newId`, `selectionStore`, `rng`. The panel receives the
 * clock down the same path it already receives `progress` / `configurations` /
 * `reps`; whether the interpolation is computed in `ReplayView` or in
 * `BatchProgress` is the implementer's call, and nothing below asserts which.
 *
 * WHY `now` LIVES ON THE SEAM. The anchor and the tick must read ONE clock or
 * the interpolation drifts against itself; bundling them makes a fake that
 * disagrees with itself impossible to build. (The probe below also drives
 * `deps.now` off the same counter, so an implementation that anchors on
 * `deps.now()` instead is not punished for it — the seam identity is not what
 * this ticket is about.)
 *
 * WHY NOT `vi.useFakeTimers`. jsdom plus fake timers would let a direct reach
 * for `setInterval` pass every behavioural assertion here while production
 * leaks a timer past the panel's unmount. So the tick arrives ONLY through the
 * injected seam, AC6 is asserted against the seam's own teardown record, and a
 * source scan forbids the ambient names outright.
 *
 * ============ ADDED TO THE DOM CONTRACT =====================================
 * [data-batch-clock] — `elapsed M:SS · est. remaining M:SS | — | finishing`
 *   `finishing`  once the local countdown reaches zero while the sweep runs;
 *                never `0:00`, never a negative clock
 *   `—`          unchanged: `estimatedRemainingMs === null` is an ABSENCE and
 *                no countdown is invented before there is a measurement
 * ===========================================================================
 *
 * THE RULE UNDER ALL OF IT: the runner's figure is the MEASUREMENT and a tick
 * between measurements is interpolation. AC3 is the sharp end — after an event
 * carrying `elapsedMs: X` the panel reads X, even when X is LOWER than what the
 * ticking accumulated. A wrong number is worse than a missing one.
 */

/** The honest reading once the countdown runs out with the sweep still going. */
const SWEEP_FINISHING = 'finishing';
/** Unchanged from ticket 013 — an estimate the runner has not produced. */
const SWEEP_NO_ESTIMATE = '—';

/**
 * The injected clock, plus the levers a test drives it through.
 *
 * `live()` / `subscribes()` / `teardowns()` are the seam's own bookkeeping —
 * they are what AC6 is asserted against, so "no interval leaked" is a FACT the
 * probe recorded and not "no error was thrown".
 */
function makeSweepClockProbe(startMs: number = T0) {
  const listeners = new Set<() => void>();
  let current = startMs;
  let subscribes = 0;
  let teardowns = 0;

  const seam = {
    now: (): number => current,
    subscribe: (onTick: () => void): (() => void) => {
      subscribes += 1;
      listeners.add(onTick);
      return () => {
        teardowns += 1;
        listeners.delete(onTick);
      };
    },
  };

  return {
    seam,
    now: (): number => current,
    /** Advance the wall clock and deliver ONE tick to every live listener. */
    tick(ms: number): void {
      current += ms;
      act(() => {
        for (const listener of [...listeners]) listener();
      });
    },
    /** Subscriptions still live. After teardown the only honest reading is 0. */
    live: (): number => listeners.size,
    subscribes: (): number => subscribes,
    teardowns: (): number => teardowns,
  };
}

/** Scoped to the render's own container — RTL APPENDS, and a stale panel lies. */
const clockIn = (container: HTMLElement): string =>
  (container.querySelector('[data-batch-clock]')?.textContent ?? '').trim();

const positionIn = (container: HTMLElement): string =>
  (container.querySelector('[data-batch-position]')?.textContent ?? '').trim();

const barIn = (container: HTMLElement): HTMLElement => {
  const found = container.querySelector<HTMLElement>('[data-batch-bar]');
  if (!found) throw new Error('missing element: [data-batch-bar]');
  return found;
};

/** The WHOLE cell, verbatim — an extra fabricated figure cannot hide in it. */
function expectClock(container: HTMLElement, elapsed: string, remaining: string): void {
  expect(clockIn(container)).toBe(`elapsed ${elapsed} · est. remaining ${remaining}`);
}

/** A confirmed, running sweep over a bag whose clock the test owns. */
async function openTickingSweep(clock: ReturnType<typeof makeSweepClockProbe>) {
  const fakes = makeFakes(DEFAULT_LIBRARY);
  // NARROW LOCAL CAST — `sweepClock` is the seam this ticket adds, so the bag
  // does not carry it yet and `tsc` must stay clean while these tests are red.
  const deps = {
    ...fakes.deps,
    now: () => clock.now(),
    sweepClock: clock.seam,
  } as ReplayDeps;

  const view = render(<ReplayView deps={deps} />);
  await waitFor(() => expect(rows()).toHaveLength(2));
  await selectRecording(CORPUS_REC.id);
  fireEvent.click(screen.getByRole('button', { name: 'Batch sweep…' }));
  await waitFor(() => expect(q('[data-sweep-confirm]')).not.toBeNull());
  fireEvent.click(get('[data-sweep-confirm-start]'));
  await waitFor(() => expect(fakes.batches).toHaveLength(1));
  await waitFor(() => expect(q('[data-batch-progress]')).not.toBeNull());

  return { fakes, view, container: view.container, batch: fakes.batches[0]! };
}

describe('TICKET 067 — a progress event RE-ANCHORS the clock (AC3)', () => {
  it('an event whose elapsed is LOWER than the accumulated total still wins outright', async () => {
    const clock = makeSweepClockProbe();
    const { container, batch } = await openTickingSweep(clock);

    batch.emit({ elapsedMs: 60_000, estimatedRemainingMs: 300_000 });
    await waitFor(() => expectClock(container, '1:00', '5:00'));

    // Two minutes with no event: the panel has interpolated its way to 3:00.
    clock.tick(60_000);
    clock.tick(60_000);
    expectClock(container, '3:00', '3:00');

    // THE ASSERTION THIS TICKET TURNS ON. The runner then MEASURES 1:30 — less
    // than the 3:00 the ticking accumulated. The measurement wins, whole. A
    // `Math.max(local, event)`, a monotonic guard, or any "the clock only ever
    // moves forward" tick is dead right here.
    batch.emit({ elapsedMs: 90_000, estimatedRemainingMs: 30_000 });
    await waitFor(() => expectClock(container, '1:30', '0:30'));

    // ...and the interpolation resumes FROM the measurement, never from the
    // local total it just replaced.
    clock.tick(10_000);
    expectClock(container, '1:40', '0:20');
  });

  it('an event whose elapsed is HIGHER than the accumulated total wins too', async () => {
    const clock = makeSweepClockProbe();
    const { container, batch } = await openTickingSweep(clock);

    batch.emit({ elapsedMs: 60_000, estimatedRemainingMs: 300_000 });
    await waitFor(() => expectClock(container, '1:00', '5:00'));

    clock.tick(10_000);
    expectClock(container, '1:10', '4:50');

    // Provider latency the local tick never saw: 10:00 measured, not 1:10.
    batch.emit({ elapsedMs: 600_000, estimatedRemainingMs: 60_000 });
    await waitFor(() => expectClock(container, '10:00', '1:00'));

    clock.tick(20_000);
    expectClock(container, '10:20', '0:40');
  });
});

describe('TICKET 067 — the clock moves between progress events (AC1, AC2)', () => {
  it('elapsed advances with NO event arriving, driven through the injected seam', async () => {
    const clock = makeSweepClockProbe();
    const { container, batch } = await openTickingSweep(clock);

    batch.emit({ elapsedMs: 1_446_000, estimatedRemainingMs: 2_490_000 });
    await waitFor(() => expectClock(container, '24:06', '41:30'));

    // The movement below comes through the SEAM — nothing else can drive it,
    // because no real timer runs and no second event is emitted.
    expect(clock.subscribes()).toBeGreaterThan(0);
    expect(clock.live()).toBeGreaterThan(0);

    clock.tick(60_000);
    expectClock(container, '25:06', '40:30');
    clock.tick(60_000);
    expectClock(container, '26:06', '39:30');
    clock.tick(1_000);
    expectClock(container, '26:07', '39:29');
  });

  it('remaining counts DOWN from the last estimate the runner actually produced', async () => {
    const clock = makeSweepClockProbe();
    const { container, batch } = await openTickingSweep(clock);

    // A MEASURED zero elapsed is fine — it is a measurement. Compare AC4, where
    // a countdown that reaches zero is an inference and must say so.
    batch.emit({ elapsedMs: 0, estimatedRemainingMs: 300_000 });
    await waitFor(() => expectClock(container, '0:00', '5:00'));

    clock.tick(30_000);
    expectClock(container, '0:30', '4:30');
    clock.tick(30_000);
    expectClock(container, '1:00', '4:00');
    clock.tick(1_000);
    expectClock(container, '1:01', '3:59');
  });
});

describe('TICKET 067 — the countdown never goes negative or invents precision (AC4)', () => {
  it('reaching zero with the sweep still running reads `finishing`, not 0:00', async () => {
    const clock = makeSweepClockProbe();
    const { container, batch } = await openTickingSweep(clock);

    batch.emit({ elapsedMs: 0, estimatedRemainingMs: 90_000 });
    await waitFor(() => expectClock(container, '0:00', '1:30'));

    // One second left is still a real countdown.
    clock.tick(89_000);
    expectClock(container, '1:29', '0:01');

    // The estimate is spent. The panel stops claiming a figure it no longer has.
    clock.tick(1_000);
    expectClock(container, '1:30', SWEEP_FINISHING);

    // Ten minutes past the estimate — no `-10:00`, no minus sign anywhere, and
    // no `0:00` standing in for "I do not know".
    clock.tick(600_000);
    expectClock(container, '11:30', SWEEP_FINISHING);
    expect(clockIn(container)).not.toMatch(/-\s*\d/);
    expect(clockIn(container)).not.toMatch(/est\. remaining 0:00/);
  });

  it('a fresh measurement after `finishing` puts a real countdown back', async () => {
    const clock = makeSweepClockProbe();
    const { container, batch } = await openTickingSweep(clock);

    batch.emit({ elapsedMs: 0, estimatedRemainingMs: 10_000 });
    await waitFor(() => expectClock(container, '0:00', '0:10'));
    clock.tick(20_000);
    expectClock(container, '0:20', SWEEP_FINISHING);

    // `finishing` is a statement about the LAST estimate, not a terminal state.
    batch.emit({ elapsedMs: 20_000, estimatedRemainingMs: 120_000 });
    await waitFor(() => expectClock(container, '0:20', '2:00'));
    clock.tick(30_000);
    expectClock(container, '0:50', '1:30');
  });
});

describe('TICKET 067 — no countdown is invented before there is one (AC5)', () => {
  it('`estimatedRemainingMs === null` stays `—` while elapsed keeps ticking', async () => {
    const clock = makeSweepClockProbe();
    const { container, batch } = await openTickingSweep(clock);

    batch.emit({ elapsedMs: 1_446_000, estimatedRemainingMs: null });
    await waitFor(() => expectClock(container, '24:06', SWEEP_NO_ESTIMATE));

    // Elapsed is anchored on a MEASUREMENT, so it moves...
    clock.tick(60_000);
    expectClock(container, '25:06', SWEEP_NO_ESTIMATE);
    clock.tick(60_000);
    expectClock(container, '26:06', SWEEP_NO_ESTIMATE);

    // ...and the estimate, which was never measured, stays an absence. Not a
    // zero, not `finishing`, not a figure derived from the elapsed side.
    expect(clockIn(container)).not.toMatch(/est\. remaining\s*-?\d/);
    expect(clockIn(container)).not.toContain(SWEEP_FINISHING);
  });
});

describe('TICKET 067 — the ticking stops, asserted through the seam (AC6)', () => {
  it('the sweep ENDING tears the subscription down', async () => {
    const clock = makeSweepClockProbe();
    const { container, batch } = await openTickingSweep(clock);

    batch.emit({ elapsedMs: 60_000, estimatedRemainingMs: 300_000 });
    await waitFor(() => expectClock(container, '1:00', '5:00'));
    clock.tick(60_000);
    expectClock(container, '2:00', '4:00');
    // Non-vacuity: something was subscribed, so a teardown count means something.
    expect(clock.subscribes()).toBeGreaterThan(0);

    batch.settle({ status: 'complete', completedRuns: 12 });
    await waitFor(() => expect(container.querySelector('[data-batch-progress]')).toBeNull());

    // THE SEAM'S OWN RECORD, not "no error was thrown".
    await waitFor(() => expect(clock.live()).toBe(0));
    expect(clock.teardowns()).toBe(clock.subscribes());
  });

  it('CANCEL stops the ticking', async () => {
    const clock = makeSweepClockProbe();
    const { container, batch } = await openTickingSweep(clock);

    batch.emit({ elapsedMs: 60_000, estimatedRemainingMs: 300_000 });
    await waitFor(() => expectClock(container, '1:00', '5:00'));
    clock.tick(30_000);
    expectClock(container, '1:30', '4:30');
    expect(clock.subscribes()).toBeGreaterThan(0);

    fireEvent.click(screen.getByRole('button', { name: CANCEL_BATCH }));
    expect(batch.cancel).toHaveBeenCalledTimes(1);
    batch.settle({ status: 'cancelled', completedRuns: 2 });

    await waitFor(() => expect(container.querySelector('[data-batch-progress]')).toBeNull());
    await waitFor(() => expect(clock.live()).toBe(0));
    expect(clock.teardowns()).toBe(clock.subscribes());
  });

  it('UNMOUNT stops the ticking — no interval outlives the panel', async () => {
    const clock = makeSweepClockProbe();
    const { container, view, batch } = await openTickingSweep(clock);

    batch.emit({ elapsedMs: 60_000, estimatedRemainingMs: 300_000 });
    await waitFor(() => expectClock(container, '1:00', '5:00'));
    clock.tick(45_000);
    expectClock(container, '1:45', '4:15');
    const subscribed = clock.subscribes();
    expect(subscribed).toBeGreaterThan(0);

    view.unmount();

    // A leaked interval is precisely a subscription with no teardown. jsdom
    // would never complain about one; the seam counted it.
    expect(clock.live()).toBe(0);
    expect(clock.teardowns()).toBe(subscribed);

    // And a tick delivered after the unmount reaches nothing at all.
    clock.tick(60_000);
    expect(clock.live()).toBe(0);
    expect(clock.teardowns()).toBe(subscribed);
  });
});

describe('TICKET 067 — a tick moves the clock and NOTHING else (AC7)', () => {
  it('position and progress bar are per-run facts and are never interpolated', async () => {
    const clock = makeSweepClockProbe();
    const { container, batch } = await openTickingSweep(clock);

    const configuration = batch.request.configurations[0] as BatchConfiguration;
    batch.emit({
      runIndex: 17,
      totalRuns: 45,
      repIndex: 3,
      configId: configuration.id,
      elapsedMs: 1_446_000,
      estimatedRemainingMs: 2_490_000,
    });
    await waitFor(() => expectClock(container, '24:06', '41:30'));

    const position = positionIn(container);
    expect(position).toContain('run 17 of 45');
    const valueNow = barIn(container).getAttribute('aria-valuenow');
    const valueMax = barIn(container).getAttribute('aria-valuemax');
    const fill = (barIn(container).firstElementChild as HTMLElement).style.width;
    expect(valueNow).toBe('17');
    expect(valueMax).toBe('45');

    clock.tick(300_000);

    // The tick GENUINELY happened — without this the four assertions below
    // would pass against a panel that never moved at all.
    expectClock(container, '29:06', '36:30');

    expect(positionIn(container)).toBe(position);
    expect(barIn(container).getAttribute('aria-valuenow')).toBe(valueNow);
    expect(barIn(container).getAttribute('aria-valuemax')).toBe(valueMax);
    expect((barIn(container).firstElementChild as HTMLElement).style.width).toBe(fill);
  });
});

/* ===== TICKET 067 — the tick is a SEAM, not a timer reached for directly ==== */

/**
 * The `localStorage` scan added for ticket 066 exists for exactly this reason:
 * jsdom supplies the global, so the bypass passes the whole suite and ships.
 * `setInterval` is the same trap one step worse — under `vi.useFakeTimers` a
 * direct reach satisfies every behavioural assertion above while production
 * leaks a timer past the panel's unmount.
 */
describe('TICKET 067 — no ambient timer, no ambient clock, in either file', () => {
  const FILES = [
    'src/client/components/replay/BatchProgress.tsx',
    'src/client/views/ReplayView.tsx',
  ] as const;

  const FORBIDDEN: ReadonlyArray<readonly [string, RegExp]> = [
    ['setInterval', /\bsetInterval\b/],
    ['setTimeout', /\bsetTimeout\b/],
    ['Date.now', /\bDate\s*\.\s*now\b/],
    ['performance.now', /\bperformance\s*\.\s*now\b/],
    ['requestAnimationFrame', /\brequestAnimationFrame\b/],
  ];

  /** Blanks comments while preserving line count (see deletions.test.ts). */
  function strip(source: string): string {
    return source
      .replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, ' '))
      .replace(/(^|[^:])\/\/[^\n]*/g, (_m, lead: string) => lead);
  }

  it.each(FILES)('%s takes its clock through the bag', (file) => {
    const code = strip(readFileSync(resolve(process.cwd(), file), 'utf8'));
    for (const [name, pattern] of FORBIDDEN) {
      expect(code, `${file} must not name ${name} — the clock is injected`).not.toMatch(pattern);
    }
  });
});
