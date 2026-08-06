/**
 * Ticket 014 — RTL tests for <BlindCompare />, re-homed into Replay.
 *
 * The DOM contract they lock is documented at the top of BlindCompare.tsx.
 * Four rules run through all of them:
 *
 *  1. PAIRWISE ONLY (PRD §10). Ranking three samples simultaneously is not
 *     something a human can judge, so the unit of work is a PAIR — and both
 *     halves of it are Runs of the SAME Recording, because Runs over different
 *     inputs are not comparable at all.
 *  2. PLAYBACK ONLY (PRD §10, §11, §17 25d). Before submit the component
 *     renders NEITHER run's configuration identity NOR its transcript. This is
 *     the load-bearing rule: a TTS that reads Cantonese text aloud in Mandarin
 *     produces a transcript that reads correctly and audio that is wrong, so a
 *     text-visible evaluation scores that failure as a success.
 *  3. THE DRAW IS INJECTED AND PER COMPARISON (PRD §17 16b). Randomness
 *     arrives through `rng`, never `Math.random` captured directly, and two
 *     different draw values produce the two different orderings — a fixed A↔B
 *     inversion teaches the evaluator the mapping after a single reveal.
 *  4. THE DRAW IS PERSISTED, NOT RECOMPUTED. Submit appends the two run ids,
 *     the drawn assignment, both dimensions for both samples and the
 *     evaluator's language; the reveal reads back the persisted draw. That is
 *     what makes the blinding auditable rather than merely asserted.
 */

// Imported directly (in addition to vitest.setup.ts) so the jest-dom matcher
// type augmentation is visible to `tsc -p tsconfig.json`, whose include does
// not cover the setup file.
import '@testing-library/jest-dom/vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_CASCADE_TRIPLE,
  REALTIME_MODEL,
  armLabel,
  type ProviderTriple,
} from '../../../core/arms';
import type { BatchHandle } from '../../batch/runner';
import type { RecordingsClient, RunsClient } from '../../replay/recordingsClient';
import type { RunOnceResult } from '../../replay/runner';
import type { BlindComparison, Recording, Run } from '../../state/ledger';
import ReplayView, { type ReplayDeps } from '../../views/ReplayView';
import BlindCompare from './BlindCompare';

afterEach(cleanup);

/* ================================================================== copy == */

/** Verbatim from the design mock — the whole reason the mode exists. */
const BLURB =
  "Playback only — transcripts are hidden until you submit, so a wrong-language " +
  "pronunciation can't pass by reading. Assignment drawn at random per comparison " +
  'and persisted to the ledger.';

const HINT_HIDDEN = 'configuration identity hidden until you submit';
const HINT_REVEALED = 'identity revealed — appended to ledger';

const OPEN_BLIND = 'compare blind (pick 2 runs)';
const CLOSE_BLIND = 'close blind compare';

const SUBMIT = 'submit ratings';
const SUBMITTED = 'submitted';

const SAMPLE_TITLES = ['Sample A', 'Sample B'] as const;

/* ============================================================== fixtures == */

/** 2026-02-03T09:41:00Z. */
const T0 = Date.UTC(2026, 1, 3, 9, 41, 0);

const REC: Recording = {
  id: 'rec-1',
  label: 'clinic intake',
  sourceLanguage: 'en',
  durationMs: 60_000,
  speechEndMs: 59_000,
  origin: 'corpus',
  createdAt: T0,
};

/** A second Recording. Its Runs are a different input, so they never pair. */
const OTHER_REC: Recording = {
  id: 'rec-2',
  label: 'pharmacy dosage',
  sourceLanguage: 'en',
  durationMs: 30_000,
  speechEndMs: 29_000,
  origin: 'mic',
  createdAt: T0 + 1,
};

const ARM_C_TRIPLE: ProviderTriple = { ...DEFAULT_CASCADE_TRIPLE, tts: 'eleven_flash_v2_5' };

const TIMINGS: Record<string, number | null> = {
  speech_end: T0,
  vad_fired: T0 + 500,
  stt_final: T0 + 542,
  mt_first_token: T0 + 840,
  tts_first_byte: T0 + 1_041,
  audio_queued: T0 + 1_053,
};

/** The shared source utterance — every Run replayed the same audio. */
const SOURCE_TEXT = 'Where exactly does it hurt';

function completeRun(overrides: Partial<Run> & Pick<Run, 'id'>): Run {
  return {
    recordingId: REC.id,
    architecture: 'cascade',
    providerTriple: { ...DEFAULT_CASCADE_TRIPLE },
    modelSnapshots: { ...DEFAULT_CASCADE_TRIPLE },
    armTag: 'B',
    origin: 'sweep',
    status: 'complete',
    timings: { ...TIMINGS },
    transcripts: { source: SOURCE_TEXT, target: 'target-text-placeholder' },
    outputAudioPath: `runs/${overrides.id}.out.wav`,
    cost: 0.021,
    errors: [],
    createdAt: T0 + 60_000,
    ...overrides,
  };
}

/** Arm B — all-OpenAI cascade. */
const RUN_B: Run = completeRun({
  id: 'run-b',
  transcripts: { source: SOURCE_TEXT, target: 'Donde le duele exactamente' },
});

/** Arm C — the ElevenLabs TTS swap; differs from B in one stage only. */
const RUN_C: Run = completeRun({
  id: 'run-c',
  providerTriple: { ...ARM_C_TRIPLE },
  modelSnapshots: { ...ARM_C_TRIPLE },
  armTag: 'C',
  transcripts: { source: SOURCE_TEXT, target: 'En que parte siente el dolor' },
});

/** Arm A — realtime speech-to-speech. */
const RUN_A: Run = completeRun({
  id: 'run-a',
  architecture: 'realtime',
  providerTriple: undefined,
  modelSnapshots: { realtime: REALTIME_MODEL },
  armTag: 'A',
  transcripts: { source: SOURCE_TEXT, target: 'Que le duele mas' },
  createdAt: T0 + 120_000,
});

/** Lost its TTS stage: no audio, so nothing to listen to blind. */
const RUN_FAILED: Run = completeRun({
  id: 'run-failed',
  status: 'failed',
  outputAudioPath: undefined,
  timings: { speech_end: T0, audio_queued: null },
  transcripts: { source: SOURCE_TEXT },
  errors: ['tts: stage timed out for this utterance'],
  cost: 0,
  createdAt: T0 + 180_000,
});

/** Runs of the OTHER Recording. Never pairable with the ones above. */
function otherRun(id: string, target: string): Run {
  return completeRun({
    id,
    recordingId: OTHER_REC.id,
    transcripts: { source: 'Take one tablet with water', target },
    createdAt: T0 + 240_000,
  });
}

const RUN_OTHER: Run = otherRun('run-other', 'Tome una pastilla con agua');
const RUN_OTHER_2: Run = otherRun('run-other-2', 'Tomese una tableta con agua');
const RUN_OTHER_3: Run = otherRun('run-other-3', 'Beba agua con la pastilla');

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

const card = (): HTMLElement => get('[data-blind-card]');
const samples = (): HTMLElement[] => all('[data-blind-sample]');
const sample = (key: 'A' | 'B'): HTMLElement => get(`[data-blind-sample="${key}"]`);
const picks = (): HTMLElement[] => all('[data-blind-pick]');
const pressedPicks = (): HTMLElement[] => all('[data-blind-pick][aria-pressed="true"]');

function pick(runId: string): void {
  fireEvent.click(get(`[data-blind-pick][data-run="${runId}"]`));
}

function dimension(key: 'A' | 'B', name: 'adequacy' | 'fluency'): HTMLElement {
  const found = sample(key).querySelector<HTMLElement>(`[data-blind-dimension="${name}"]`);
  if (!found) throw new Error(`missing dimension ${name} on sample ${key}`);
  return found;
}

function score(key: 'A' | 'B', name: 'adequacy' | 'fluency', n: number): void {
  fireEvent.click(within(dimension(key, name)).getByRole('button', { name: String(n) }));
}

/** All four scores — the minimum for submit to be available. */
function scoreEverything(values = { aAdq: 4, aFlu: 3, bAdq: 2, bFlu: 5 }): void {
  score('A', 'adequacy', values.aAdq);
  score('A', 'fluency', values.aFlu);
  score('B', 'adequacy', values.bAdq);
  score('B', 'fluency', values.bFlu);
}

const submitButton = (): HTMLElement => screen.getByRole('button', { name: SUBMIT });

function playSample(key: 'A' | 'B'): void {
  fireEvent.click(within(sample(key)).getByRole('button', { name: 'play' }));
}

/** Everything about a Run a blinded evaluator must not be able to read. */
function identityStrings(run: Run): string[] {
  return [
    armLabel(run.armTag),
    ...Object.values(run.modelSnapshots),
    ...Object.values(run.providerTriple ?? {}),
    ...Object.values(run.transcripts).filter((value): value is string => typeof value === 'string'),
  ];
}

/** Renders the card directly. `draw` is the single rng value it consumes. */
function mountCard(
  options: {
    runs?: Run[];
    draw?: number;
    evaluatorLanguage?: string;
  } = {},
) {
  const rng = vi.fn(() => options.draw ?? 0.1);
  const onPlay = vi.fn();
  const onSubmit = vi.fn();
  let ids = 0;
  render(
    <BlindCompare
      recording={REC}
      runs={options.runs ?? [RUN_B, RUN_C]}
      rng={rng}
      evaluatorLanguage={options.evaluatorLanguage ?? 'es'}
      now={() => T0 + 900_000}
      newId={() => `draw-${++ids}`}
      onPlay={onPlay}
      onSubmit={onSubmit}
    />,
  );
  return { rng, onPlay, onSubmit };
}

/** The run id behind a sample, observed the only blinded way: by playing it. */
function playedRunId(onPlay: ReturnType<typeof vi.fn>, key: 'A' | 'B'): string {
  onPlay.mockClear();
  playSample(key);
  expect(onPlay).toHaveBeenCalledTimes(1);
  return onPlay.mock.calls[0]![0] as string;
}

/* ------------------------------------------------------- ReplayView mount -- */

function makeReplayFakes(options: { recordings: Recording[]; runs: Run[]; blindDeps?: boolean }) {
  const store = {
    recordings: options.recordings.map((r) => ({ ...r })),
    runs: options.runs.map((r) => ({ ...r })),
  };

  const recordings = {
    list: vi.fn(async () => store.recordings.map((r) => ({ ...r }))),
    get: vi.fn(async (id: string) => ({ ...store.recordings.find((r) => r.id === id)! })),
    getAudio: vi.fn(async () => new Uint8Array()),
    create: vi.fn(async () => ({ ...REC })),
    patchLabel: vi.fn(async (id: string) => ({ ...store.recordings.find((r) => r.id === id)! })),
    remove: vi.fn(async (id: string) => ({ ...store.recordings.find((r) => r.id === id)! })),
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

  const playRun = vi.fn();
  const rng = vi.fn(() => 0.1);
  const recordBlindComparison = vi.fn();

  const deps: ReplayDeps = {
    recordings: recordings as unknown as RecordingsClient,
    runs: runs as unknown as RunsClient,
    runOnce: vi.fn(async () => ({}) as RunOnceResult) as unknown as ReplayDeps['runOnce'],
    startBatch: vi.fn(() => ({}) as BatchHandle) as unknown as ReplayDeps['startBatch'],
    playRun,
    now: () => T0 + 900_000,
    newId: () => 'draw-1',
    ...(options.blindDeps === false ? {} : { rng, evaluatorLanguage: 'es', recordBlindComparison }),
  };

  return { deps, playRun, rng, recordBlindComparison };
}

async function mountReplay(options: {
  recordings: Recording[];
  runs: Run[];
  select?: string;
  blindDeps?: boolean;
}) {
  const fakes = makeReplayFakes(options);
  render(<ReplayView deps={fakes.deps} />);
  await waitFor(() => expect(q('[data-recordings-library]')).not.toBeNull());
  const target = options.select ?? REC.id;
  await waitFor(() =>
    expect(q(`[data-recording-row][data-recording="${target}"]`)).not.toBeNull(),
  );
  fireEvent.click(get(`[data-recording-row][data-recording="${target}"]`));
  await waitFor(() => expect(q('[data-runs-list]')).not.toBeNull());
  return fakes;
}

const openBlind = (): void => {
  fireEvent.click(screen.getByRole('button', { name: OPEN_BLIND }));
};

/* ====================================================== the move itself == */

describe('BlindCompare has MOVED out of session/ and into replay/', () => {
  const root = process.cwd();

  it('the session copy no longer exists', () => {
    expect(existsSync(resolve(root, 'src/client/components/session/BlindCompare.tsx'))).toBe(false);
  });

  it('the component lives under components/replay/', () => {
    expect(existsSync(resolve(root, 'src/client/components/replay/BlindCompare.tsx'))).toBe(true);
  });

  it('ReplayView mounts it', () => {
    const source = readFileSync(resolve(root, 'src/client/views/ReplayView.tsx'), 'utf8');
    expect(source).toContain('BlindCompare');
  });
});

/* ============================================= launched from ReplayView == */

describe('launched on demand from the runs column — never a phase to complete', () => {
  it('is offered when the Recording has two completed runs', async () => {
    await mountReplay({ recordings: [REC], runs: [RUN_B, RUN_C] });
    expect(screen.getByRole('button', { name: OPEN_BLIND })).toBeInTheDocument();
  });

  it('renders nothing until the trigger is pressed, then toggles closed again', async () => {
    await mountReplay({ recordings: [REC], runs: [RUN_B, RUN_C] });
    expect(q('[data-blind-card]')).toBeNull();

    openBlind();
    await waitFor(() => expect(q('[data-blind-card]')).not.toBeNull());

    fireEvent.click(screen.getByRole('button', { name: CLOSE_BLIND }));
    await waitFor(() => expect(q('[data-blind-card]')).toBeNull());
  });

  it('mounts in the runs column, alongside the runs list', async () => {
    await mountReplay({ recordings: [REC], runs: [RUN_B, RUN_C] });
    openBlind();
    await waitFor(() => expect(q('[data-blind-card]')).not.toBeNull());
    expect(card().parentElement).toBe(get('[data-runs-list]').parentElement);
  });

  const NOT_OFFERED = [
    { name: 'no runs at all', runs: [] as Run[] },
    { name: 'a single completed run', runs: [RUN_B] },
    // A failed run produced no audio: there is nothing to listen to.
    { name: 'one completed run and one failure', runs: [RUN_B, RUN_FAILED] },
  ] as const;

  it.each(NOT_OFFERED)(
    'offers NO affordance at all with $name — absent, not disabled',
    async ({ runs }) => {
      await mountReplay({ recordings: [REC], runs: [...runs] });
      expect(screen.queryByRole('button', { name: OPEN_BLIND })).toBeNull();
      expect(q('[data-blind-card]')).toBeNull();
    },
  );

  it('is not offered when the host supplies no randomness or ledger seam', async () => {
    await mountReplay({ recordings: [REC], runs: [RUN_B, RUN_C], blindDeps: false });
    expect(screen.queryByRole('button', { name: OPEN_BLIND })).toBeNull();
  });
});

/* ================================================== pairwise, same input == */

describe('pairwise only — two Runs, never three', () => {
  it('with exactly two completed runs it uses them and renders no picker', () => {
    mountCard({ runs: [RUN_B, RUN_C] });
    expect(q('[data-blind-pair-picker]')).toBeNull();
    expect(samples().map((s) => s.getAttribute('data-blind-sample'))).toEqual(['A', 'B']);
  });

  it('with three the evaluator picks, and nothing is presented until two are chosen', () => {
    mountCard({ runs: [RUN_A, RUN_B, RUN_C] });
    expect(q('[data-blind-pair-picker]')).not.toBeNull();
    expect(picks().map((p) => p.getAttribute('data-run'))).toEqual([RUN_A.id, RUN_B.id, RUN_C.id]);
    expect(samples()).toHaveLength(0);

    pick(RUN_B.id);
    expect(samples()).toHaveLength(0);

    pick(RUN_C.id);
    expect(samples().map((s) => s.getAttribute('data-blind-sample'))).toEqual(['A', 'B']);
  });

  it('a third pick never makes a third sample — the newest joins, the oldest leaves', () => {
    mountCard({ runs: [RUN_A, RUN_B, RUN_C] });
    pick(RUN_B.id);
    pick(RUN_C.id);
    pick(RUN_A.id);

    expect(pressedPicks()).toHaveLength(2);
    expect(pressedPicks().map((p) => p.getAttribute('data-run'))).toContain(RUN_A.id);
    expect(samples()).toHaveLength(2);
  });

  it('the picker names Runs neutrally — choosing must not leak the identity', () => {
    mountCard({ runs: [RUN_A, RUN_B, RUN_C] });
    const picker = get('[data-blind-pair-picker]');
    for (const run of [RUN_A, RUN_B, RUN_C]) {
      for (const secret of identityStrings(run)) {
        expect(picker.innerHTML, `picker must not name ${secret}`).not.toContain(secret);
      }
    }
  });
});

describe('only Runs of the SAME Recording can be compared', () => {
  it('the picker offers the selected Recording’s completed runs and nothing else', async () => {
    await mountReplay({
      recordings: [REC, OTHER_REC],
      runs: [RUN_B, RUN_C, RUN_A, RUN_FAILED, RUN_OTHER],
      select: REC.id,
    });
    openBlind();
    await waitFor(() => expect(q('[data-blind-pair-picker]')).not.toBeNull());

    const offered = picks().map((p) => p.getAttribute('data-run'));
    expect(offered).toEqual([RUN_B.id, RUN_C.id, RUN_A.id]);
    // A Run of another Recording is a different input, not a comparison...
    expect(offered).not.toContain(RUN_OTHER.id);
    // ...and a failed Run produced no audio to listen to.
    expect(offered).not.toContain(RUN_FAILED.id);
  });

  it('selecting the other Recording offers only ITS runs', async () => {
    await mountReplay({
      recordings: [REC, OTHER_REC],
      runs: [RUN_B, RUN_C, RUN_A, RUN_OTHER, RUN_OTHER_2, RUN_OTHER_3],
      select: OTHER_REC.id,
    });
    openBlind();
    await waitFor(() => expect(q('[data-blind-pair-picker]')).not.toBeNull());
    expect(picks().map((p) => p.getAttribute('data-run'))).toEqual([
      RUN_OTHER.id,
      RUN_OTHER_2.id,
      RUN_OTHER_3.id,
    ]);
  });

  it('a Recording with a single completed run offers no comparison at all', async () => {
    await mountReplay({
      recordings: [REC, OTHER_REC],
      runs: [RUN_B, RUN_C, RUN_OTHER],
      select: OTHER_REC.id,
    });
    // One completed run is not a pair, so the affordance is absent entirely.
    expect(screen.queryByRole('button', { name: OPEN_BLIND })).toBeNull();
  });
});

/* =========================================== THE BLINDING (load-bearing) == */

describe('playback only — identity AND transcript are absent before submit', () => {
  const PAIRS = [
    { name: 'exactly two runs', runs: [RUN_B, RUN_C], choose: () => {} },
    {
      name: 'three runs, two picked',
      runs: [RUN_A, RUN_B, RUN_C],
      choose: () => {
        pick(RUN_B.id);
        pick(RUN_C.id);
      },
    },
  ] as const;

  it.each(PAIRS)('$name: neither configuration identity nor transcript is rendered', ({ runs, choose }) => {
    mountCard({ runs: [...runs] });
    choose();
    // The comparison IS on screen — this is not vacuously true.
    expect(card()).toBeInTheDocument();
    expect(samples()).toHaveLength(2);

    const markup = card().innerHTML;
    const rendered = text(card());
    for (const run of runs) {
      for (const secret of identityStrings(run)) {
        expect(rendered, `text leaks ${secret}`).not.toContain(secret);
        // innerHTML, not just text: a title=, aria-label= or hidden node
        // leaks it just as effectively as visible copy.
        expect(markup, `markup leaks ${secret}`).not.toContain(secret);
      }
    }
    expect(all('[data-blind-identity]')).toHaveLength(0);
  });

  it('scoring and playing never reveal anything either', () => {
    const { onPlay } = mountCard({ runs: [RUN_B, RUN_C] });
    playSample('A');
    playSample('B');
    scoreEverything();

    expect(onPlay).toHaveBeenCalledTimes(2);
    expect(all('[data-blind-identity]')).toHaveLength(0);
    for (const run of [RUN_B, RUN_C]) {
      for (const secret of identityStrings(run)) {
        expect(card().innerHTML).not.toContain(secret);
      }
    }
  });

  it('states the playback-only rule verbatim', () => {
    mountCard();
    expect(text(get('[data-blind-blurb]'))).toBe(BLURB);
  });

  it('the hint says identity is hidden until submit', () => {
    mountCard();
    expect(text(get('[data-blind-hint]'))).toBe(HINT_HIDDEN);
  });
});

/* ============================================== the sample panels themselves */

describe('each sample offers a play control and adequacy + fluency, 1–5', () => {
  it('titles the two samples Sample A and Sample B', () => {
    mountCard();
    expect(samples().map((s) => text(s.querySelector('[data-blind-sample-title]')))).toEqual([
      ...SAMPLE_TITLES,
    ]);
  });

  it.each(['A', 'B'] as const)('sample %s offers play and both dimensions, 1–5', (key) => {
    mountCard();
    expect(within(sample(key)).getByRole('button', { name: 'play' })).toBeInTheDocument();

    for (const name of ['adequacy', 'fluency'] as const) {
      const dim = dimension(key, name);
      expect(text(dim)).toContain(name);
      const buttons = within(dim).getAllByRole('button');
      expect(buttons.map((b) => text(b))).toEqual(['1', '2', '3', '4', '5']);
    }
  });

  it('a picked score is the only pressed one in its dimension', () => {
    mountCard();
    score('A', 'adequacy', 4);
    const buttons = within(dimension('A', 'adequacy')).getAllByRole('button');
    expect(buttons.map((b) => b.getAttribute('aria-pressed'))).toEqual([
      'false',
      'false',
      'false',
      'true',
      'false',
    ]);
    // The other dimension of the same sample is untouched.
    expect(
      within(dimension('A', 'fluency'))
        .getAllByRole('button')
        .map((b) => b.getAttribute('aria-pressed')),
    ).toEqual(['false', 'false', 'false', 'false', 'false']);
  });

  it('ships unscored — nothing is pre-selected', () => {
    mountCard();
    expect(all('[data-blind-dimension]')).toHaveLength(4);
    expect(all('[data-blind-dimension] button[aria-pressed="true"]')).toHaveLength(0);
  });

  it('playing a sample calls the injected playback seam, and render alone calls nothing', () => {
    const { onPlay } = mountCard();
    expect(onPlay).not.toHaveBeenCalled();
    playSample('A');
    expect(onPlay).toHaveBeenCalledTimes(1);
  });
});

/* ================================================== the injected draw ===== */

describe('the A/B assignment comes from the injected randomness source', () => {
  it('two different draw values produce the two DIFFERENT orderings', () => {
    const low = mountCard({ runs: [RUN_B, RUN_C], draw: 0.1 });
    const lowOrder = [playedRunId(low.onPlay, 'A'), playedRunId(low.onPlay, 'B')];
    cleanup();

    const high = mountCard({ runs: [RUN_B, RUN_C], draw: 0.9 });
    const highOrder = [playedRunId(high.onPlay, 'A'), playedRunId(high.onPlay, 'B')];

    // Both orderings are the same pair...
    expect([...lowOrder].sort()).toEqual([RUN_B.id, RUN_C.id]);
    expect([...highOrder].sort()).toEqual([RUN_B.id, RUN_C.id]);
    // ...and the draw actually moved them. A fixed swap fails here.
    expect(highOrder).not.toEqual(lowOrder);
    expect(highOrder).toEqual([...lowOrder].reverse());
  });

  it('consumes exactly one rng value per comparison', () => {
    const { rng } = mountCard({ runs: [RUN_B, RUN_C], draw: 0.1 });
    expect(rng).toHaveBeenCalledTimes(1);
  });

  it('re-picking the pair draws again — randomization is per comparison', () => {
    const draws = [0.1, 0.9];
    const rng = vi.fn(() => draws.shift() ?? 0.1);
    const onPlay = vi.fn();
    render(
      <BlindCompare
        recording={REC}
        runs={[RUN_A, RUN_B, RUN_C]}
        rng={rng}
        evaluatorLanguage="es"
        now={() => T0}
        newId={() => 'draw-1'}
        onPlay={onPlay}
        onSubmit={vi.fn()}
      />,
    );

    pick(RUN_B.id);
    pick(RUN_C.id);
    const first = [playedRunId(onPlay, 'A'), playedRunId(onPlay, 'B')];

    pick(RUN_A.id);
    pick(RUN_B.id);
    expect(rng).toHaveBeenCalledTimes(2);
    const second = [playedRunId(onPlay, 'A'), playedRunId(onPlay, 'B')];
    expect(second).toEqual([RUN_B.id, RUN_A.id]);
    expect(first).toEqual([RUN_B.id, RUN_C.id]);
  });
});

/* ============================================== submit gating ============= */

describe('submit is unavailable until both dimensions are scored for both samples', () => {
  type Partial4 = Array<[('A' | 'B'), ('adequacy' | 'fluency')]>;

  const INCOMPLETE: Array<{ name: string; scored: Partial4 }> = [
    { name: 'nothing scored', scored: [] },
    { name: 'only sample A adequacy', scored: [['A', 'adequacy']] },
    { name: 'sample A fully, sample B not at all', scored: [['A', 'adequacy'], ['A', 'fluency']] },
    {
      name: 'adequacy on both, fluency on neither',
      scored: [['A', 'adequacy'], ['B', 'adequacy']],
    },
    {
      name: 'three of the four',
      scored: [['A', 'adequacy'], ['A', 'fluency'], ['B', 'adequacy']],
    },
  ];

  it.each(INCOMPLETE)('unavailable with $name', ({ scored }) => {
    const { onSubmit } = mountCard();
    for (const [key, name] of scored) score(key, name, 3);

    const button = submitButton();
    expect(button).toBeDisabled();
    fireEvent.click(button);
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('becomes available on the fourth score', () => {
    mountCard();
    expect(submitButton()).toBeDisabled();
    scoreEverything();
    expect(submitButton()).toBeEnabled();
  });
});

/* ============================================== the persisted round trip == */

describe('submitting persists the pair, THE DRAW, both dimensions and the language', () => {
  it('appends everything the audit needs', () => {
    const { onSubmit } = mountCard({ runs: [RUN_B, RUN_C], draw: 0.9, evaluatorLanguage: 'es' });
    scoreEverything({ aAdq: 4, aFlu: 3, bAdq: 2, bFlu: 5 });
    fireEvent.click(submitButton());

    expect(onSubmit).toHaveBeenCalledTimes(1);
    const comparison = onSubmit.mock.calls[0]![0] as BlindComparison;

    expect(comparison.recordingId).toBe(REC.id);
    expect([...comparison.runIds].sort()).toEqual([RUN_B.id, RUN_C.id]);
    // The DRAW, not the pick order: 0.9 swapped it.
    expect(comparison.order).toEqual([RUN_C.id, RUN_B.id]);
    expect(comparison.evaluatorLanguage).toBe('es');
    expect(comparison.scores).toEqual({
      A: { adequacy: 4, fluency: 3 },
      B: { adequacy: 2, fluency: 5 },
    });
  });

  it('the persisted order matches what was actually played, draw by draw', () => {
    for (const draw of [0.1, 0.9]) {
      const { onPlay, onSubmit } = mountCard({ runs: [RUN_B, RUN_C], draw });
      const played = [playedRunId(onPlay, 'A'), playedRunId(onPlay, 'B')];
      scoreEverything();
      fireEvent.click(submitButton());
      const comparison = onSubmit.mock.calls[0]![0] as BlindComparison;
      expect(comparison.order, `draw ${draw}`).toEqual(played);
      cleanup();
    }
  });

  it('reaches the ledger seam through ReplayView', async () => {
    const fakes = await mountReplay({ recordings: [REC], runs: [RUN_B, RUN_C] });
    openBlind();
    await waitFor(() => expect(q('[data-blind-card]')).not.toBeNull());
    scoreEverything({ aAdq: 5, aFlu: 4, bAdq: 3, bFlu: 2 });
    fireEvent.click(submitButton());

    await waitFor(() => expect(fakes.recordBlindComparison).toHaveBeenCalledTimes(1));
    const comparison = fakes.recordBlindComparison.mock.calls[0]![0] as BlindComparison;
    expect(comparison.recordingId).toBe(REC.id);
    expect([...comparison.runIds].sort()).toEqual([RUN_B.id, RUN_C.id]);
    expect([...comparison.order].sort()).toEqual([RUN_B.id, RUN_C.id]);
    expect(comparison.evaluatorLanguage).toBe('es');
    expect(comparison.scores).toEqual({
      A: { adequacy: 5, fluency: 4 },
      B: { adequacy: 3, fluency: 2 },
    });
    // The randomness came from the injected source, not from the module.
    expect(fakes.rng).toHaveBeenCalled();
  });
});

/* ============================================== the reveal =============== */

describe('identity is revealed only after submit, and matches the persisted draw', () => {
  it.each([0.1, 0.9])('draw %s: each sample reveals the run the ledger recorded', (draw) => {
    const { onSubmit } = mountCard({ runs: [RUN_B, RUN_C], draw });
    expect(all('[data-blind-identity]')).toHaveLength(0);

    scoreEverything();
    fireEvent.click(submitButton());

    const comparison = onSubmit.mock.calls[0]![0] as BlindComparison;
    const revealed = samples().map((s) =>
      s.querySelector('[data-blind-identity]')?.getAttribute('data-run'),
    );
    // Read back from the persisted draw, not recomputed.
    expect(revealed).toEqual([...comparison.order]);
  });

  it('the revealed identity names the configuration that was hidden', () => {
    const { onSubmit } = mountCard({ runs: [RUN_B, RUN_C], draw: 0.9 });
    scoreEverything();
    fireEvent.click(submitButton());

    const comparison = onSubmit.mock.calls[0]![0] as BlindComparison;
    const byRun = new Map([RUN_B, RUN_C].map((run) => [run.id, run]));
    for (const key of ['A', 'B'] as const) {
      const identity = sample(key).querySelector('[data-blind-identity]')!;
      const runId = identity.getAttribute('data-run')!;
      expect(text(identity)).toContain(armLabel(byRun.get(runId)!.armTag));
    }
    expect(comparison.order).toEqual([RUN_C.id, RUN_B.id]);
  });

  it('the hint and the submit label both flip on submit', () => {
    mountCard();
    expect(text(get('[data-blind-hint]'))).toBe(HINT_HIDDEN);
    scoreEverything();
    fireEvent.click(submitButton());

    expect(text(get('[data-blind-hint]'))).toBe(HINT_REVEALED);
    expect(screen.getByRole('button', { name: SUBMITTED })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: SUBMIT })).toBeNull();
  });

  it('submitting twice appends one comparison, not two', () => {
    const { onSubmit } = mountCard();
    scoreEverything();
    fireEvent.click(submitButton());
    fireEvent.click(screen.getByRole('button', { name: SUBMITTED }));
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });
});

/* ================================================ source-level guarantees == */

describe('BlindCompare source — tokens only, injected randomness', () => {
  const FILE = 'src/client/components/replay/BlindCompare.tsx';

  /** Blanks comments while preserving line count (see deletions.test.ts). */
  function stripComments(source: string): string {
    return source
      .replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, ' '))
      .replace(/(^|[^:])\/\/[^\n]*/g, (_m, lead: string) => lead);
  }

  const code = stripComments(readFileSync(resolve(process.cwd(), FILE), 'utf8'));

  it('styles from tokens only — no hex, rgb or oklch literal', () => {
    // The Live-era copy carried `0 1px 2px rgba(0,0,0,.05)`; under
    // components/replay/ that has to be var(--shadow-card).
    expect(code).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(code).not.toMatch(/\brgba?\(/);
    expect(code).not.toMatch(/\boklch\(/);
  });

  it('never captures Math.random — the draw is injected', () => {
    expect(code).not.toMatch(/Math\.random/);
  });

  it('carries none of the mock’s placeholder identities', () => {
    for (const sampleText of ['Arm B — Cascade all-OpenAI', 'Arm C — Cascade, EL Flash TTS']) {
      expect(code).not.toContain(sampleText);
    }
  });
});
