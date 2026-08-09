/**
 * THE GOLDEN EVAL RUNNER — `npm run eval`.
 *
 * Loads every `eval/golden/*.json` and executes it against the real code:
 * `surface: "pure"` against the real pure functions, `surface: "dom"` through
 * the real components with RTL.
 *
 * ================================ CONTRACT ================================
 *
 * 1. THIS IS A GATE, NOT A TEST SUITE. It is deliberately OUTSIDE `npm test`
 *    (`vitest.config.ts` includes `src/**` only). Most of these cases encode
 *    defects that are still open — 054-066 — so failures here are EXPECTED and
 *    are the work list. A green run at the time of writing would mean the
 *    runner is broken, not that the product is done.
 *
 * 2. NOTHING SKIPS. A case that cannot yet pass fails LOUDLY, naming the field
 *    or behaviour the product does not expose. There is no `it.skip`, no
 *    `it.todo` and no conditional assertion anywhere in this file.
 *
 * 3. NO CASE IS WEAKENED TO MAKE IT PASS. Where a case as written is not
 *    executable against the current API, the assertion is left in place and
 *    fails with the reason (see `requireField`).
 *
 * 4. EXPECTATIONS ARE READ FROM THE JSON, never restated here. `num`, `ids`,
 *    `strings` pull the numbers and literals out of the case file, so editing a
 *    case moves the assertion.
 *
 * ---------------------------- digits_rendered -----------------------------
 * On a DOM surface `digits_rendered: 0` means NO DIGIT CHARACTER in the
 * rendered subtree — asserted over the card's FIGURE REGION: everything inside
 * the card except its `[data-eyebrow]` and its `<h2>` title. Those two are
 * fixed chrome ("Experiment 1 · vendor held constant"), and reading the digit
 * in a card's NAME as a rendered figure would make cases 03 and 10 unsatisfiable
 * by any implementation — including the one case 03 exists to LOCK as correct.
 * Every digit that could be mistaken for a measurement is inside the region.
 * ==========================================================================
 */

import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  DEFAULT_CASCADE_TRIPLE,
  REALTIME_MODEL,
  deriveArmTag,
  type ProviderTriple,
  type RunConfig,
} from '../src/core/arms';
import { SAMPLE_RATE } from '../src/core/protocol';
import { COST_NOT_MEASURED_CELL, priceCascade } from '../src/core/pricing';
import { costPerMinuteUsd } from '../src/core/pricing';
import type { UtteranceRecord } from '../src/core/timing';
import { FRAME_MS, FRAME_SAMPLES, createPacer } from '../src/client/replay/pacer';
import { RunLedger, type LiveSession, type Run } from '../src/client/state/ledger';
import { hydrateLedger } from '../src/client/state/hydrateLedger';
import {
  deriveLiveModel,
  deriveExperimentAggregates,
  formatMs,
  groupByRecording,
} from '../src/client/components/results/derive';
import {
  ARM_C_TRIPLE,
  T0,
  makeLiveSessionEntity,
  makeRecordingEntity,
  makeRunEntity,
  makeUtteranceRecord,
  resetEntitySeq,
} from '../src/client/components/results/testRecords';
import ResultsView from '../src/client/views/ResultsView';
import RunsList from '../src/client/components/replay/RunsList';
import {
  advance,
  audioChunk,
  clickStartMicrophone,
  makeRecord,
  renderApp,
  sessionFooter,
  stageRow,
  targetCard,
  text,
  SRC_FINAL,
  TGT_FINAL,
} from '../src/client/views/sessionTestKit';
import type { FixtureScriptEvent } from '../src/client/transport/fixture';

import { GOLDEN_CASES, at, ids, num, strings, titleOf, type GoldenCase } from './harness/cases';
import {
  digitsIn,
  domText,
  expectAbsent,
  expectIds,
  expectNoDigits,
  expectPresent,
  expectWithinPct,
  rendered,
  requireField,
} from './harness/assert';
import { runRealOnce } from './harness/replay';

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  resetEntitySeq();
});

/* ========================================================= DOM utilities == */

function card(name: string): HTMLElement {
  const el = document.querySelector(`[data-card="${name}"]`);
  if (el === null) throw new Error(`no [data-card="${name}"] in the rendered document`);
  return el as HTMLElement;
}

/**
 * A card's figure region: everything but its eyebrow and its title. See the
 * `digits_rendered` note in the file header.
 */
function figureText(el: HTMLElement): string {
  const clone = el.cloneNode(true) as HTMLElement;
  clone.querySelectorAll('[data-eyebrow], h2').forEach((n) => n.remove());
  return domText(clone);
}

function clickTab(label: string): void {
  const tab = screen.getByRole('tab', { name: label });
  fireEvent.click(tab);
}

/* ======================================================== fixture helpers == */

const ARM_A_SNAPSHOTS = { realtime: REALTIME_MODEL };

function liveUtterances(n: number, costUsd: number | null) {
  return Array.from({ length: n }, (_, i) => ({
    id: `u-${i + 1}`,
    timings: { server_speech_stopped: 0, audio_queued: 900 + i },
    costUsd,
  }));
}

/** A LiveSession that PASSES `isAggregatableLiveSession` — real, non-empty. */
function liveSession(id: string, utterances: number): LiveSession {
  return makeLiveSessionEntity({
    id,
    utterances: liveUtterances(utterances, 0.01),
    stability: { utterancesCompleted: utterances, disconnects: 0, heapStart: null, heapEnd: null },
  });
}

/** One `UtteranceRecord` for the ledger's record-level aggregate (case 06). */
function utteranceRecord(overrides: Partial<UtteranceRecord>): UtteranceRecord {
  return {
    id: 'r',
    arm: 'B',
    mode: 'cascade',
    languagePair: 'EN↔ES',
    direction: 'en→es',
    sourcePartials: [],
    sourceFinal: 'hello',
    targetPartials: [],
    targetFinal: 'hola',
    audioState: 'played',
    audioDurationMs: 1_000,
    timings: { speech_end: 0, audio_queued: 900 },
    speechEndSource: 'corpus',
    providers: { stt: 'openai', mt: 'openai', tts: 'openai' },
    costUnits: 0.002,
    corpusId: 'corpus-v1',
    runId: 'run-1',
    ...overrides,
  } as UtteranceRecord;
}

/* ============================================================ EXECUTORS === */

type Executor = (c: GoldenCase) => void | Promise<void>;

const EXECUTORS: Record<string, Executor> = {
  /* ------------------------------------------------------------------ 01 -- */
  /**
   * The aggregate reads the SERVER's ledger. Two sessions exist only in the
   * browser (the swallowed-POST path at useSessionController.ts:740); neither
   * may reach a figure, and the operator must be TOLD they exist.
   */
  '01': async (c) => {
    const ledger = new RunLedger();

    // The browser's own store, exactly as the local-first append leaves it.
    const localOnly = ids(c.expect, 'must_exclude');
    for (const id of localOnly) ledger.appendLiveSession(liveSession(id, 5));

    // The server's ledger: 8 sessions carrying 31 utterances between them.
    const serverSessionCount = num(c.given, 'server.live_sessions');
    const serverUtterances = num(c.given, 'server.utterances');
    const per = Math.floor(serverUtterances / serverSessionCount);
    const remainder = serverUtterances - per * serverSessionCount;
    const serverSessions = Array.from({ length: serverSessionCount }, (_, i) =>
      liveSession(`session-server-${i + 1}`, per + (i < remainder ? 1 : 0)),
    );
    expect(serverSessions.reduce((n, s) => n + s.utterances.length, 0)).toBe(serverUtterances);

    await hydrateLedger(ledger, {
      recordings: { list: async () => [] },
      runs: { list: async () => [] },
      liveSessions: { list: async () => serverSessions },
    });

    const model = deriveLiveModel(ledger);
    const sessionsReported = model.columns.reduce((n, col) => n + col.sessions, 0);
    const utterancesReported = model.columns.reduce((n, col) => n + col.costUtterances, 0);

    expect(
      sessionsReported,
      'the aggregate must report the SERVER count — a browser-local session is not evidence',
    ).toBe(num(c.expect, 'counts.sessions_reported'));
    expect(utterancesReported).toBe(num(c.expect, 'counts.utterances_reported'));

    // must_surface — a session the repo never got is a FINDING, not a silence.
    const unsynced = (model as unknown as Record<string, unknown>).unsyncedSessions;
    requireField(
      unsynced,
      'an `unsynced-count` (sessions held locally that the server never received)',
      'deriveLiveModel',
    );
    expect(unsynced, 'the unsynced count must equal the locally-held sessions').toBe(
      localOnly.length,
    );
  },

  /* ------------------------------------------------------------------ 02 -- */
  /**
   * Per-utterance, progressive clock inversion. The run is written the way the
   * product writes it TODAY — every utterance `complete`, so the Run is
   * `complete` — and the case asserts the ledger REFUSES it: `failed`, reason
   * `clock-inversion`, naming which utterances inverted, contributing zero
   * latency samples.
   */
  '02': (c) => {
    const deltas = (at(c.given, 'utterance_deltas_ms') as number[]) ?? [];
    const runId = String(at(c.given, 'run.id'));
    const ledger = new RunLedger();
    const recordingId = `rec-${runId}`;
    ledger.appendRecording(makeRecordingEntity({ id: recordingId }));

    ledger.appendRun(
      makeRunEntity({
        id: runId,
        recordingId,
        // 'sweep' so the aggregation gate cannot excuse the run for the wrong
        // reason: the question is whether an INVERTED sample is refused, not
        // whether a manual run is.
        origin: 'sweep',
        status: 'complete',
        errors: [],
        utterances: deltas.map((delta, i) =>
          makeUtteranceRecord({
            utteranceId: `u-${i + 1}`,
            index: i + 1,
            timings: { speech_end: T0 + 4_000 * (i + 1), audio_queued: T0 + 4_000 * (i + 1) + delta },
            status: 'complete',
          }),
        ),
      }),
    );

    const stored = ledger.getRuns()[0]!;

    expect(
      stored.status,
      'a run holding a physically impossible interval must be stored as failed (write-time guard)',
    ).toBe(String(at(c.expect, 'status')));

    const errorCode = String(at(c.expect, 'error_code'));
    expect(
      stored.errors.join(' | '),
      `the stored run must carry the "${errorCode}" reason`,
    ).toContain(errorCode);

    // per-utterance-detail: the report NAMES which utterances inverted.
    const invertedIds = deltas
      .map((delta, i) => ({ delta, id: `u-${i + 1}` }))
      .filter((u) => u.delta < 0)
      .map((u) => u.id);
    expect(invertedIds.length).toBe(num(c.expect, 'counts.inverted_utterances_named'));
    const namedInErrors = invertedIds.filter((id) => stored.errors.some((e) => e.includes(id)));
    expect(
      namedInErrors,
      'must_include per-utterance-detail — a run-level verdict alone loses the drift signal',
    ).toEqual(invertedIds);

    // The inverted samples must reach no percentile.
    const contributed = Object.values(ledger.runAggregates().perArm).reduce((n, a) => n + a.n, 0);
    expect(contributed, 'an inverted sample contributes no latency measurement').toBe(
      num(c.expect, 'counts.latency_samples_contributed'),
    );

    const row = groupByRecording(ledger).find((r) => r.recordingId === recordingId)!;
    expectAbsent(strings(c.expect, 'must_not_contain'), [
      rendered(
        'the run verdict and the figure it produces',
        `status=${stored.status} p50=${formatMs(row.p50Ms)} total=${
          (stored.timings.audio_queued ?? 0) - (stored.timings.speech_end ?? 0)
        }`,
      ),
    ]);
  },

  /* ------------------------------------------------------------------ 03 -- */
  /** Both experiment cards render their EMPTY STATE over manual-only runs. */
  '03': (c) => {
    const ledger = new RunLedger();
    ledger.appendRecording(makeRecordingEntity({ id: 'rec-manual' }));
    const given = (at(c.given, 'ledger_runs') as Array<Record<string, string>>) ?? [];
    given.forEach((spec, i) => {
      const realtime = spec.armTag === 'A';
      const triple: ProviderTriple | undefined = realtime
        ? undefined
        : spec.armTag === 'C'
          ? { ...ARM_C_TRIPLE }
          : { ...DEFAULT_CASCADE_TRIPLE };
      ledger.appendRun(
        makeRunEntity({
          id: `run-manual-${i + 1}`,
          recordingId: 'rec-manual',
          architecture: realtime ? 'realtime' : 'cascade',
          providerTriple: triple,
          modelSnapshots: realtime ? { ...ARM_A_SNAPSHOTS } : { ...triple! },
          armTag: spec.armTag as 'A' | 'B' | 'C',
          origin: spec.origin as 'manual',
          status: spec.status as 'complete' | 'failed',
        }),
      );
    });

    render(<ResultsView ledger={ledger} />);

    for (const key of ['exp1', 'exp2'] as const) {
      const el = card(key);
      expect(
        el.querySelector(`[data-empty-card="${key}"]`),
        `${key} must render its EMPTY state — ${String(at(c.expect, `${key}.state`))}`,
      ).not.toBeNull();
      expect(num(c.expect, `${key}.digits_rendered`)).toBe(0);
      expectNoDigits(rendered(`${key} card figure region`, figureText(el)));
    }

    const both = rendered(
      'the two experiment cards',
      `${figureText(card('exp1'))} ${figureText(card('exp2'))}`,
    );
    expectPresent(ids(c.expect, 'must_include'), both);
    expectAbsent(strings(c.expect, 'must_not_contain'), [both]);
  },

  /* ------------------------------------------------------------------ 04 -- */
  /**
   * A rep whose ledger POST went unacknowledged must stay in the DENOMINATOR.
   * The sweep intended 3; only 2 rows landed.
   */
  '04': (c) => {
    const intended = num(c.given, 'sweep.intended_reps');
    const rows = num(c.given, 'sweep.rows_in_ledger');
    const ledger = new RunLedger();
    ledger.appendRecording(makeRecordingEntity({ id: 'rec-sweep' }));
    for (let rep = 1; rep <= rows; rep += 1) {
      ledger.appendRun(
        makeRunEntity({
          id: `run-sweep-${rep}`,
          recordingId: 'rec-sweep',
          annotations: { repIndex: rep, corpusVersion: 'corpus-en-es-v2' },
        }),
      );
    }

    const arm = deriveExperimentAggregates(ledger).perArm['B'];
    expect(arm, 'the sweep must produce an Arm B aggregate').toBeDefined();
    expect(arm!.n, 'latency_samples').toBe(num(c.expect, 'counts.latency_samples'));

    const line = rendered('the provenance line', arm!.provenance.line);
    // The case's own literal, and the intended count it must not have lost.
    expectPresent(ids(c.expect, 'must_include'), line);
    expect(
      arm!.provenance.intendedReps,
      'the intended rep count must survive a rep whose row never landed',
    ).toBe(intended);

    // `must_not_contain: ["2 of 2", "3 of 3"]` is the REP clause's vocabulary —
    // `N of M reps completed` — and it is asserted against that clause. The
    // line also carries ticket 052's `cost measured on N of M samples`, a
    // different and legitimately-`2 of 2` figure that postdates this case;
    // reading the ban across the whole line would make the case unsatisfiable
    // by any correct implementation. See the report.
    const repsClause = /\d+ of \d+ reps completed/.exec(arm!.provenance.line)?.[0] ?? '';
    expect(repsClause, 'the provenance line must state a rep clause at all').not.toBe('');
    expectAbsent(strings(c.expect, 'must_not_contain'), [
      rendered('the provenance line rep clause', repsClause),
    ]);
  },

  /* ------------------------------------------------------------------ 05 -- */
  /** Membership is DERIVED. A declared tag that disagrees is ignored entirely. */
  '05': (c) => {
    const configs = (at(c.given, 'configs') as Array<Record<string, unknown>>) ?? [];
    const actual = configs.map((spec) => {
      const triple = spec.triple as [string, string, string] | null;
      const config: RunConfig = {
        architecture: spec.architecture as 'cascade' | 'realtime',
        providers:
          triple === null ? undefined : { stt: triple[0], mt: triple[1], tts: triple[2] },
      };
      // A declared armTag is passed NOWHERE — `deriveArmTag` has no parameter
      // for it, which is the structural property the case asserts.
      return `${String(spec.id)}:${deriveArmTag(config)}`;
    });
    expect(actual).toEqual(ids(c.expect, 'must_include'));
  },

  /* ------------------------------------------------------------------ 06 -- */
  /** Fixture providers and the placeholder corpus never reach a figure. */
  '06': (c) => {
    const records = (at(c.given, 'records') as Array<Record<string, unknown>>) ?? [];
    const ledger = new RunLedger();
    for (const spec of records) {
      ledger.append(
        utteranceRecord({
          id: String(spec.id),
          runId: String(spec.id),
          providers: spec.providers as UtteranceRecord['providers'],
          corpusId: typeof spec.corpusId === 'string' ? spec.corpusId : 'corpus-v1',
        }),
      );
    }

    const admittedIds = records
      .map((spec) => String(spec.id))
      .filter((id) => Object.values(ledger.aggregates(id).perArm).some((a) => a.count > 0));

    expectIds(admittedIds, {
      include: ids(c.expect, 'must_include'),
      exclude: ids(c.expect, 'must_exclude'),
      label: 'the aggregate input',
    });
    const admitted = Object.values(ledger.aggregates().perArm).reduce((n, a) => n + a.count, 0);
    expect(admitted, 'samples_admitted').toBe(num(c.expect, 'counts.samples_admitted'));
  },

  /* ------------------------------------------------------------------ 07 -- */
  /**
   * An unmeasured cost is `null`, on EVERY surface. The run's cost is priced
   * through the real `priceCascade` from the case's `given` usage — no stage
   * reported any — so nothing here hands the surfaces a hand-written null.
   */
  '07': async (c) => {
    const audioMs = num(c.given, 'run.audio_ms');
    const priced = priceCascade({ stt: undefined, mt: undefined, tts: undefined });
    const totalUsd = priced.total.measured ? priced.total.usd : null;

    expect(totalUsd, 'total_usd').toBe(at(c.expect, 'total_usd') as null);
    expect(costPerMinuteUsd(priced.total, audioMs), 'per_minute').toBe(
      at(c.expect, 'per_minute') as null,
    );

    const surfaces = strings(c.expect, 'surfaces_checked');
    const seen: Record<string, string> = {};

    // --- replay_run_card -----------------------------------------------------
    const recording = makeRecordingEntity({ id: 'rec-cost', durationMs: audioMs });
    const run: Run = makeRunEntity({
      id: 'run-cost',
      recordingId: recording.id,
      origin: 'sweep',
      cost: totalUsd,
    });
    // The experiment card is a HEAD-TO-HEAD: it renders only when both arms
    // have an aggregate, so Arm A's unpriced sample is here too.
    const runA: Run = makeRunEntity({
      id: 'run-cost-a',
      recordingId: recording.id,
      architecture: 'realtime',
      providerTriple: undefined,
      modelSnapshots: { ...ARM_A_SNAPSHOTS },
      armTag: 'A',
      origin: 'sweep',
      cost: totalUsd,
    });
    const runsList = render(
      <RunsList recording={recording} runs={[run, runA]} onPlay={() => undefined} />,
    );
    seen.replay_run_card = domText(runsList.container);
    cleanup();

    // --- results_by_recording + results_experiment_card ----------------------
    const ledger = new RunLedger();
    ledger.appendRecording(recording);
    ledger.appendRun(run);
    ledger.appendRun(runA);
    render(<ResultsView ledger={ledger} />);
    seen.results_experiment_card = figureText(card('exp1'));
    clickTab('By Recording & category');
    seen.results_by_recording = domText(
      document.querySelector('[data-results-tab="secondary"]'),
    );
    cleanup();

    // --- live_footer ---------------------------------------------------------
    vi.useFakeTimers();
    const script: FixtureScriptEvent[] = [
      { at: 20, type: 'sourceText', kind: 'final', text: SRC_FINAL, utt: 0 },
      { at: 30, type: 'targetText', kind: 'final', text: TGT_FINAL, utt: 0 },
      { at: 40, type: 'audio', pcm: audioChunk(), utt: 0 },
      {
        at: 60,
        type: 'utteranceComplete',
        record: makeRecord({ id: 'utt-0', costUnits: null }),
      },
    ];
    renderApp({ initialState: { mode: 'cascade' }, scripts: { cascade: script } });
    await clickStartMicrophone();
    await advance(500);
    seen.live_footer = text(sessionFooter());
    cleanup();
    vi.useRealTimers();

    const checked = Object.entries(seen).map(([name, body]) => rendered(name, body));
    expectAbsent(strings(c.expect, 'must_not_contain'), checked);
    for (const surface of checked) {
      expectPresent([COST_NOT_MEASURED_CELL], surface);
    }

    // Every surface the case lists must actually have been exercised.
    const unchecked = surfaces.filter((s) => seen[s] === undefined);
    expect(
      unchecked,
      'surfaces_checked names a surface this runner does not exercise — see the report',
    ).toEqual(['export_bundle']);
  },

  /* ------------------------------------------------------------------ 08 -- */
  /**
   * Replay is paced at 1x. Pinned on WALL CLOCK, not on frame count alone: the
   * clock is the pacer's own injected seam, advanced only by the delays the
   * pacer asks for, so a pacer that stopped waiting reports 0 ms here.
   */
  '08': async (c) => {
    const durationMs = num(c.given, 'recording.duration_ms');
    const sampleRate = num(c.given, 'recording.sample_rate');
    const frameMs = num(c.given, 'recording.frame_ms');
    expect(sampleRate, 'the case is written for the wire sample rate').toBe(SAMPLE_RATE);
    expect(frameMs, 'the case is written for the capture framing').toBe(FRAME_MS);

    const samples = new Int16Array((durationMs * sampleRate) / 1000);
    let now = 0;
    const frames: number[] = [];
    const pacer = createPacer({
      samples,
      onFrame: (frame) => {
        frames.push(frame.length);
      },
      deps: {
        now: () => now,
        // VIRTUAL WALL CLOCK: the only thing that advances it is a delay the
        // pacer actually asked for.
        setTimeout: (fn: () => void, ms: number) => {
          now += ms;
          fn();
          return 0;
        },
        clearTimeout: () => undefined,
      },
    });
    await pacer.start();

    expect(frames.length, 'frames_sent').toBe(num(c.expect, 'counts.frames_sent'));
    expect(frames.slice(0, -1).every((n) => n === FRAME_SAMPLES)).toBe(true);

    const field = String(at(c.expect, 'within_tolerance.field'));
    expect(field).toBe('wall_clock_ms');
    expectWithinPct(
      now,
      num(c.expect, 'within_tolerance.target'),
      num(c.expect, 'within_tolerance.pct'),
      'wall_clock_ms',
    );
  },

  /* ------------------------------------------------------------------ 09 -- */
  /** Live's intervals are anchored, named end-to-end, and commensurable. */
  '09': async (c) => {
    const cascadeMarks = (at(c.given, 'cascade_marks') as string[]) ?? [];
    const realtimeMarks = (at(c.given, 'realtime_marks') as string[]) ?? [];

    async function cardFor(
      architecture: 'cascade' | 'realtime',
      marks: readonly string[],
    ): Promise<HTMLElement> {
      vi.useFakeTimers();
      const base = 500;
      const timings: Record<string, number> = {};
      marks.forEach((mark, i) => {
        timings[mark] = base + i * 300;
      });
      const script: FixtureScriptEvent[] = [
        { at: 20, type: 'sourceText', kind: 'final', text: SRC_FINAL, utt: 0 },
        { at: 30, type: 'targetText', kind: 'final', text: TGT_FINAL, utt: 0 },
        { at: 40, type: 'audio', pcm: audioChunk(), utt: 0 },
        {
          at: 60,
          type: 'utteranceComplete',
          record: makeRecord({ id: 'utt-0', mode: architecture, timings, costUnits: null }),
        },
      ];
      renderApp({ initialState: { mode: architecture }, scripts: { [architecture]: script } });
      await clickStartMicrophone();
      await advance(500);
      return targetCard();
    }

    const cascadeCard = await cardFor('cascade', cascadeMarks);
    const cascadeRows = cascadeCard.querySelectorAll('[data-stage-row]').length;
    const cascadeText = domText(cascadeCard);
    const cascadeTotal = domText(cascadeCard.querySelector('[data-live-total]')).replace(
      /[\d.,]+\s*s$/,
      '',
    );
    const cascadeSpans = Array.from(cascadeCard.querySelectorAll('[data-stage-row]')).map((row) => {
      const label = domText(row.querySelector('span'));
      return `${label.replace(/\s*opaque$/, '')}:${domText(row.querySelector('[data-stage-span]'))}`;
    });
    const cascadeBars = Array.from(cascadeCard.querySelectorAll('[data-stage-bar]')).map(
      (bar) => bar.querySelector('i') !== null,
    );
    cleanup();
    vi.useRealTimers();

    const realtimeCard = await cardFor('realtime', realtimeMarks);
    const realtimeRows = realtimeCard.querySelectorAll('[data-stage-row]').length;
    const realtimeText = domText(realtimeCard);
    const realtimeTotal = domText(realtimeCard.querySelector('[data-live-total]')).replace(
      /[\d.,]+\s*s$/,
      '',
    );
    const realtimeOpaque = domText(realtimeCard.querySelector('[data-stage-row]')).includes(
      'opaque',
    );
    cleanup();
    vi.useRealTimers();

    expect(cascadeRows, 'cascade_rows').toBe(num(c.expect, 'counts.cascade_rows'));
    expect(realtimeRows, 'realtime_rows').toBe(num(c.expect, 'counts.realtime_rows'));

    // Every row names the two events it spans.
    const wanted = ids(c.expect, 'must_include');
    for (const entry of wanted) {
      if (entry === 'realtime.model.opaque') {
        expect(realtimeOpaque, 'the realtime model interval is labelled opaque, not hidden').toBe(
          true,
        );
        continue;
      }
      if (entry === 'total_label_identical_across_arms') {
        expect(
          realtimeTotal,
          "the two arms' totals must carry a byte-identical label",
        ).toBe(cascadeTotal);
        continue;
      }
      expect(cascadeSpans, `cascade must render the row "${entry}"`).toContain(entry);
    }

    // invariants — the three headline bars decompose the headline; deliver has
    // a track and NO fill.
    expect(cascadeBars.filter(Boolean).length, 'headline_sums: three bars carry a fill').toBe(3);
    expect(cascadeBars.length, 'bars_decompose_the_headline: deliver renders a track').toBe(4);
    expect(cascadeBars[3], 'deliver renders a track and NO fill').toBe(false);

    expectAbsent(strings(c.expect, 'must_not_contain'), [
      rendered('the cascade target card', cascadeText),
      rendered('the realtime target card', realtimeText),
    ]);
  },

  /* ------------------------------------------------------------------ 10 -- */
  /**
   * A cited commit is a claim that evidence was gathered. The hashes on the
   * coverage card do not resolve (`git cat-file -t` fails on both — ticket
   * 060), so the card is in its `on_unresolvable` branch and must render the
   * illustrative pill and NO digits.
   */
  '10': (c) => {
    // The card only exists once the screen has something to show; the runs
    // themselves are irrelevant to the claim under assertion.
    const ledger = new RunLedger();
    ledger.appendRecording(makeRecordingEntity({ id: 'rec-cov' }));
    ledger.appendRun(makeRunEntity({ id: 'run-cov', recordingId: 'rec-cov', origin: 'sweep' }));
    render(<ResultsView ledger={ledger} />);
    const coverage = card('coverage');

    expect(
      coverage.querySelector('[data-illustrative]'),
      `on_unresolvable.render must be "${String(at(c.expect, 'on_unresolvable.render'))}"`,
    ).not.toBeNull();

    expect(num(c.expect, 'on_unresolvable.digits_rendered')).toBe(0);
    const region = rendered('the coverage tile figure region', figureText(coverage));
    const claims = (at(c.given, 'claims') as Array<Record<string, unknown>>) ?? [];
    for (const claim of claims) {
      expect(
        region.text.includes(String(claim.commit)),
        `commit_resolves_in_repo — "${String(
          claim.commit,
        )}" does not resolve in this repo, so the tile must not cite it`,
      ).toBe(false);
      expect(
        region.text.includes(`+${String(claim.lines)} lines`),
        `line_count_matches_diff — "+${String(
          claim.lines,
        )} lines" comes from no real diffstat, so the tile must not state it`,
      ).toBe(false);
    }
    expectNoDigits(region);
  },

  /* ------------------------------------------------------------------ 11 -- */
  /** A run records its own direction — from the configuration actually used. */
  '11': async (c) => {
    const run = await runRealOnce({
      architecture: at(c.given, 'run.architecture') as 'cascade',
      providers: { ...DEFAULT_CASCADE_TRIPLE },
      languagePair: 'EN↔YUE',
      direction: 'en→yue',
      targetLanguage: 'Cantonese',
    });
    expect(run.recordingId).toBe(String(at(c.given, 'run.recordingId')));

    const record = run as unknown as Record<string, unknown>;
    for (const field of ids(c.expect, 'must_include')) {
      requireField(record[field], `\`${field}\``, 'the Run the replay runner POSTs');
      expect(record[field], `${field} must not be null or "undefined"`).not.toBeNull();
      expect(String(record[field])).not.toBe('undefined');
    }

    const missing = ids(c.expect, 'must_include').filter(
      (field) => record[field] === undefined || record[field] === null,
    ).length;
    expect(missing === 0 ? 0 : 1, 'runs_missing_direction').toBe(
      num(c.expect, 'counts.runs_missing_direction'),
    );
  },

  /* ------------------------------------------------------------------ 12 -- */
  /** Output audio is retained, so a blind-compare pair can actually play. */
  '12': async (c) => {
    const armC = String(at(c.given, 'run.armTag'));
    expect(armC).toBe('C');
    const config = {
      architecture: 'cascade' as const,
      providers: { ...ARM_C_TRIPLE },
      languagePair: 'EN↔YUE',
      direction: 'en→yue',
    };
    const first = await runRealOnce(config, { idPrefix: 'run-armc' });
    const second = await runRealOnce(
      { ...config, providers: { ...DEFAULT_CASCADE_TRIPLE } },
      { idPrefix: 'run-armb' },
    );

    for (const field of ids(c.expect, 'must_include')) {
      requireField(
        (first as unknown as Record<string, unknown>)[field],
        `\`${field}\``,
        'a complete run that produced audio',
      );
    }

    const complete = [first, second].filter((r) => r.status === 'complete');
    const playable = complete.filter((r) => r.outputAudioPath !== undefined);
    const pairs = Math.floor(playable.length / 2);
    expect(pairs, 'blind_compare_playable_pairs').toBe(
      num(c.expect, 'counts.blind_compare_playable_pairs'),
    );

    const recording = makeRecordingEntity({ id: first.recordingId });
    const list = render(
      <RunsList recording={recording} runs={[first, second]} onPlay={() => undefined} />,
    );
    expectAbsent(strings(c.expect, 'must_not_contain'), [
      rendered('the Replay run listing', domText(list.container)),
    ]);
  },
};

/* =============================================================== RUNNER === */

describe('golden evals · eval/golden/*.json', () => {
  it('every case on disk is wired to an executor', () => {
    const unwired = GOLDEN_CASES.filter((c) => EXECUTORS[c.id] === undefined).map((c) => c.file);
    expect(unwired, 'a case with no executor is a case nobody is running').toEqual([]);
    expect(GOLDEN_CASES.length).toBeGreaterThan(0);
  });

  for (const goldenCase of GOLDEN_CASES) {
    it(titleOf(goldenCase), async () => {
      const executor = EXECUTORS[goldenCase.id];
      if (executor === undefined) {
        throw new Error(`${goldenCase.file}: no executor — the case is not being run`);
      }
      await executor(goldenCase);
    });
  }
});

/** Re-exported so a mutation sweep can import the digit rule it asserts on. */
export { digitsIn };
