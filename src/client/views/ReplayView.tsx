/**
 * Ticket 013 — Replay view: recordings library, run config panel, runs list,
 * batch progress.
 *
 * NOTHING IS GLOBAL. The recordings client, the runs client, the single-run
 * executor, the sweep starter, the playback seam, the clock and the id minter
 * all arrive through `deps`. The view never touches the network, an
 * AudioContext or a real timer, which is what makes every rule below testable
 * rather than merely intended.
 *
 * MEMBERSHIP IS DERIVED, NEVER DECLARED (PRD §6, §17 22d-22e). The panel holds
 * a configuration and nothing else; its tag is deriveArmTag(configuration),
 * recomputed on render, and a run card's tag is runArmTag(run), recomputed
 * from the run's recipe. No control in this tree sets a tag.
 *
 * DELETION IS SOFT AND ONE-SIDED. Removing a mic Recording hides its row; its
 * Runs stay listed, and the Recording itself is kept in view state (flagged
 * deleted) so those Runs can still name the input that produced them and
 * normalize their cost by its duration.
 *
 * ============================== DOM CONTRACT ==============================
 * Root [data-replay-view]. Header: 'Replay', the verbatim subline, and a
 * [data-record-new] button named 'Record new clip · max 1 min'.
 *
 * RecordTake — ticket 036, PRD §7 step 1. [data-record-new] OPENS it; it is
 * absent until then, so nothing goes near a microphone on arrival. Offered only
 * when the host supplied BOTH capture seams (startTake, segmentTake): without
 * them the button is disabled and says so, the same rule blind compare follows.
 * The view owns opening, closing and the POST — the take, its segmentation and
 * its manifest belong to the component. A save APPENDS the created Recording,
 * so the clip is in the library without a reload. Its own DOM contract is in
 * src/client/components/replay/RecordTake.tsx.
 *
 * RecordingsLibrary [data-recordings-library]
 *   [data-recording-row][data-recording=<id>][data-origin='mic'|'corpus']
 *     [data-selected='true'|'false'], containing
 *       [data-recording-label]      the label text
 *       [data-origin-pill]          'corpus' | 'mic'
 *       [data-recording-language]   the source language code
 *       [data-recording-duration]   M:SS
 *       [data-recording-run-count]  '{n} runs' — every Run, failed included
 *       [data-edit-label]           button, accessible name 'Edit label'
 *       [data-delete-recording]     button, 'Delete recording' — MIC ONLY.
 *                                   A corpus row renders NO delete control.
 *   Editing: [data-edit-label] swaps in [data-label-input] (a textbox named
 *   'Recording label'); Enter commits through recordings.patchLabel(id, next).
 *   Empty: [data-recordings-empty] and zero [data-recording-row].
 *   FAILED (ticket 020, PRD §12): [data-recordings-error][data-error-code=…]
 *     instead — never beside — the empty state, naming the failure, quoting
 *     the underlying message, and holding [data-recordings-retry] which
 *     re-issues recordings.list(). A failure must be distinguishable from
 *     emptiness: they demand opposite next actions.
 *   Footer [data-library-footer] carries the lifecycle copy verbatim.
 *   Selection is idempotent: clicking the selected row keeps it selected.
 *
 * RunConfigPanel [data-run-config-panel]
 *   architecture toggle: buttons 'Realtime' / 'Cascade' with aria-pressed
 *   [data-stage-select='stt'|'mt'|'tts'] — <select> elements, one <option>
 *     per MENUS entry, accessible name = the stage. Cascade only; realtime
 *     renders none.
 *   [data-derived-tag='A'|'B'|'C'|'ad-hoc'] — READ-ONLY pill, text
 *     'derived tag: Arm B' | 'derived tag: ad-hoc'. Derived live from the
 *     panel state; never a control, and nothing anywhere sets a tag.
 *   [data-replay-context][data-locked='true'] — pinned to zero, contains NO
 *     enabled control of any kind.
 *   [data-pinned-note] verbatim; buttons 'Run' ([data-run-button]) and
 *     'Batch sweep…' ([data-batch-button]) — ticket 065, the ellipsis is now
 *     honest: the press opens the confirmation below and reaches NO executor —
 *     both `disabled` with an
 *     explanatory `title` while no Recording is selected (ticket 024) — and,
 *     ticket 044, ALSO while a request of their own kind is in flight, which
 *     applies 024's principle rather than overturning it: a Replay run is
 *     billable, and an enabled button that swallows the click is the failure
 *     024 exists against. The no-selection title always wins over the busy one.
 *   [data-run-inflight] — present ONLY while a MANUAL run this panel started
 *     is in flight, carrying the in-flight copy verbatim. A readout, never a
 *     control. Absent during a sweep: BatchProgress is the sweep's sole
 *     indication, and two panels claiming different things about what is
 *     executing is the contradiction ticket 044 forbids. It clears on every
 *     exit — a run that completes, a run that RESOLVES as `status: 'failed'`,
 *     and a runOnce that REJECTS — so a failure never leaves the panel
 *     looking permanently busy.
 *   Defaults: architecture 'cascade', providers DEFAULT_CASCADE_TRIPLE, so an
 *   untouched panel derives Arm B.
 *
 * RunsList [data-runs-list]
 *   [data-run-card][data-run=<id>][data-arm=<tag>][data-status=...] with
 *     [data-run-arm-pill]  armLabel(tag) — non-interactive
 *     [data-run-config]    architecture + every model id of the run
 *     [data-run-meta][data-mono]  'origin {origin} · rep {n} · …'
 *     [data-run-status]    'complete' | 'failed'
 *   STORED AUDIO only (ticket 045, superseding 013's "complete only"):
 *     [data-run-play] (button named 'play'), offered exactly when
 *     `run.outputAudioPath` is set — a complete run with no stored audio
 *     (Arm A today, ticket 046) offers [data-run-no-audio] 'no output audio
 *     stored' instead, and a FAILED run that produced partial audio DOES
 *     offer playback, because that audio is diagnostic (PRD §12). A control
 *     that cannot act must not look actionable (tickets 024, 044).
 *   complete only: [data-run-stage=<stage>] one per interval in order,
 *     '{label} {ms} ms', [data-run-total] '{ms} ms', [data-run-cost]
 *     '$0.021/min' ($/min = run.cost ÷ recording minutes).
 *   failed only: [data-run-failure][data-failed-stage=<stage>], naming the
 *     stage and ending '— run saved as failed, excluded from every aggregate'.
 *     No stage cells.
 *   NOTHING AUTOPLAYS: deps.playRun fires on click and never on render.
 *
 * SweepConfirm [data-sweep-confirm] — TICKET 065, role='dialog' with an
 *   accessible name, rendered OPEN (jsdom has no <dialog>.showModal, and a
 *   confirmation that only exists imperatively cannot be asserted). Absent
 *   until [data-batch-button] is pressed, and absent again after either of its
 *   two controls. A press of the batch button reaches NO executor: this panel
 *   is the ONLY path to deps.startBatch, because one press otherwise spent
 *   roughly $4 and ~68 minutes with nothing said first.
 *     [data-sweep-reps=<n>]         retained reps in force — the value passed
 *                                   as `reps`, so the estimate cannot describe
 *                                   a different sweep from the one that starts
 *     [data-sweep-executions=<n>]   recordings × configurations × (reps + 1),
 *                                   warmups INCLUDED — `executionCount` in
 *                                   batch/runner.ts, never `totalRuns`, which
 *                                   excludes them and is 20% short of the bill
 *     [data-sweep-wallclock-ms=<n>] the SELECTED clip's durationMs × those
 *                                   executions: replay is paced at 1×, so a
 *                                   sweep is bounded by real time
 *     [data-sweep-cost]             a '$' figure or 'not measured' — never
 *                                   '$0.00'. ROUND 2 (F3): a MEASURED zero is
 *                                   a measurement and quotes '$0.000'; only an
 *                                   unpriced clip reads 'not measured'
 *     [data-sweep-language-pair=<pair>][data-sweep-direction=<direction>]
 *       [data-sweep-target-language=<language>] — ROUND 2 (F2), the pair and
 *                                   direction baked into every configuration
 *                                   the quote will launch, so the dialog is
 *                                   self-describing about the one thing ticket
 *                                   061 made variable
 *     [data-sweep-confirm-start] / [data-sweep-confirm-cancel] buttons
 *   GENUINELY MODAL (ROUND 2, F2). While the quote is open the two regions
 *   behind it — [data-replay-background], the header and the columns — carry
 *   `inert`, and the selection and target-language handlers REFUSE. The panel
 *   used to be modal in name only (`aria-modal="true"`, no backdrop, no focus
 *   trap), so the operator could pick another clip or another target language
 *   and then confirm: the sweep ran the QUOTED pair while the screen showed the
 *   new one. `inert` is the affordance; the refusals are the fact, because
 *   jsdom implements no part of it and neither does an old browser.
 *
 * BatchProgress [data-batch-progress] — absent until the sweep is CONFIRMED
 *   [data-batch-position]  'run {i} of {n} · {recordingId} × {label} · rep i/n'
 *   [data-batch-clock]     'elapsed M:SS · est. remaining M:SS | — | finishing'
 *                          TICKET 067 — both figures TICK between progress
 *                          events, through `deps.sweepClock` and nothing else,
 *                          and every event RE-ANCHORS them to the runner's own
 *                          numbers. 'finishing' once the countdown is spent
 *                          with the sweep still running (never '0:00', never
 *                          negative); '—' unchanged while the runner has
 *                          measured no throughput to count down from.
 *   [data-batch-bar]       role=progressbar, aria-valuenow/min/max. A per-run
 *                          fact, with [data-batch-position]: NEVER interpolated.
 *   [data-batch-controls-note] verbatim
 *   button 'Cancel — keep completed runs' → handle.cancel(); when `done`
 *   settles the panel unmounts and every completed run is still listed.
 *
 * BlindCompare — ticket 014, a sibling of [data-runs-list] in this column.
 *   Trigger 'compare blind (pick 2 runs)' / 'close blind compare', offered
 *   ONLY when the selected Recording has at least two COMPLETED runs (a
 *   failed run produced no audio to listen to) AND the host supplied the
 *   blind seams — rng, evaluatorLanguage and recordBlindComparison. Without
 *   them there is no honest blind mode, so nothing occupies the slot at all:
 *   absent, not disabled.
 *   The view owns open/close and the filtering, and NOTHING else: the pair
 *   pick, the draw, the scores, the reveal and the submit all belong to the
 *   component, which is what keeps the blinding in one auditable place.
 * ==========================================================================
 */

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactElement,
} from 'react';
import { ARMS, DEFAULT_CASCADE_TRIPLE, REALTIME_MODEL } from '../../core/arms';
import {
  COST_NOT_MEASURED_CELL,
  costFromPriceSource,
  formatCostUsd,
  sumMeasuredCosts,
} from '../../core/pricing';
import { executionCount } from '../batch/runner';
import BatchProgressPanel, { type SweepClock } from '../components/replay/BatchProgress';
import BlindCompare from '../components/replay/BlindCompare';
import RecordTake from '../components/replay/RecordTake';
import RecordingsLibrary from '../components/replay/RecordingsLibrary';
import RunConfigPanel, { type ReplayConfigState } from '../components/replay/RunConfigPanel';
import RunsList from '../components/replay/RunsList';
import type { BatchConfiguration, BatchHandle, BatchProgress } from '../batch/runner';
import type {
  BlindComparisonsClient,
  NewRecordingInput,
  RecordingsClient,
  RunsClient,
} from '../replay/recordingsClient';
import type { CaptureDenied, RecordedTake, TakeRecorder } from '../replay/capture';
import type { SegmentedUtterance } from '../replay/segment';
import type { RunOnceConfig, RunOnceResult } from '../replay/runner';
import type { InterpreterTransport } from '../transport/types';
import type { BlindComparison, Recording, Run } from '../state/ledger';
import {
  languageSelectionForTarget,
  targetLanguagesForSource,
  type LanguageSelection,
} from '../state/sessionMachine';

/** One manual run request, as the view asks for it. */
export interface ReplayRunRequest {
  recordingId: string;
  config: RunOnceConfig;
  signal?: AbortSignal;
}

/** The sweep the view asks for; the executor/timeout seams belong to the host. */
export interface ReplayBatchRequest {
  recordingIds: string[];
  configurations: BatchConfiguration[];
  reps: number;
  onProgress?: (progress: BatchProgress) => void;
}

/**
 * TICKET 036 — the options the view hands the (pre-bound) take recorder. The
 * browser bits (getUserMedia, the AudioContext factory, the capture pipeline)
 * belong to the host bag, never to the view: what the view knows is the cap it
 * wants enforced and the two callbacks it renders from.
 */
export interface ReplayTakeOptions {
  /** Mic level bars 0..5 while recording. */
  onLevel?: (bars: number) => void;
  /** Fired once when the cap — not the operator — stopped the take. */
  onMaxDuration?: (take: RecordedTake) => void;
  /** Cap in ms; ticket 035 clamps it down to MAX_TAKE_MS. */
  maxDurationMs?: number;
}

/** Everything the view reaches the outside world through. Nothing is global. */
export interface ReplayDeps {
  recordings: RecordingsClient;
  runs: RunsClient;
  runOnce: (request: ReplayRunRequest) => Promise<RunOnceResult>;
  startBatch: (request: ReplayBatchRequest) => BatchHandle;
  /**
   * On-demand playback of a run's output audio. NEVER called at render.
   *
   * TICKET 049 ROUND 2 — `onUnavailable` (OPTIONAL, so every existing host and
   * test bag still typechecks) is how a press that could not build an
   * AudioContext says so. Without it the press is a silent no-op, which is
   * indistinguishable from a run whose stored audio is empty — a real
   * diagnosis the operator makes on this screen.
   */
  playRun: (runId: string, onUnavailable?: (error: unknown) => void) => void;
  now: () => number;
  newId: () => string;

  /**
   * TICKET 066 — WHERE THE RECORDING SELECTION LIVES BETWEEN MOUNTS.
   *
   * App mounts exactly one view and unmounts the one you leave, so a selection
   * held in this component's own `useState` is gone by the time the operator
   * comes back from Results — while the sidebar row still reads "3 runs". The
   * screen then contradicts itself, and the panel is the half that is wrong.
   *
   * INJECTED, exactly as `RunLedger`'s localStorage-shaped seam is
   * (`ledger.ts` StorageAdapter → `browserDeps.ts`). The view never names
   * `localStorage`: jsdom provides one, so a direct reach would pass every test
   * in this suite and still be a global the product cannot swap.
   *
   * OPTIONAL, because App is the host that fills it in — the same rule it
   * already follows for `rng`, `evaluatorLanguage` and `recordBlindComparison`.
   * A bag without one simply does not persist; a bag with one has its stored id
   * RESOLVED against the library on mount, so an id naming a Recording that is
   * gone (or soft-deleted) becomes no selection rather than a selection with no
   * row.
   */
  selectionStore?: {
    get: () => string | null;
    set: (recordingId: string | null) => void;
  };

  /**
   * TICKET 067 — WHERE THE SWEEP CLOCK'S TICKS COME FROM.
   *
   * `BatchProgress.elapsedMs` / `estimatedRemainingMs` are fields on a progress
   * event, and the runner emits only at run boundaries. Replay is paced at 1×,
   * so a one-recording sweep is twelve executions over six to eight minutes:
   * the clock advanced twelve times and showed a stale snapshot in between,
   * which is indistinguishable from a hung sweep. The operator refreshed, and
   * the client-side runner died with the page. The frozen clock cost a sweep.
   *
   * INJECTED, and both halves together: the anchor and the tick must read ONE
   * clock or the interpolation drifts against itself. Neither this view nor the
   * panel may name `setInterval` or `Date.now` — jsdom supplies both, so a
   * direct reach would pass every test in this suite while leaking a real timer
   * past the panel's unmount.
   *
   * OPTIONAL, exactly as `selectionStore` and the blind seams are: App is the
   * host that fills it in, and a bag without one simply does not tick — it
   * shows the last measurement, unmoved, which is the pre-067 behaviour.
   */
  sweepClock?: SweepClock;

  /* --- ticket 014: the blind-compare seams (PRD §10, §17 16b) --- */

  /**
   * The randomness the blind draw consumes — injected, never `Math.random`
   * captured directly, so the draw is deterministic under test.
   *
   * OPTIONAL, and the option is load-bearing: blind compare has no honest
   * affordance without a randomness source AND somewhere to persist the draw,
   * so a host that supplies neither gets no trigger rather than a fake one.
   */
  rng?: () => number;
  /** The language the evaluator judges in; persisted with every comparison. */
  evaluatorLanguage?: string;
  /** Appends a completed blind comparison to the ledger. */
  recordBlindComparison?: (comparison: BlindComparison) => void;

  /**
   * TICKET 023 — the REST seam a submitted comparison is persisted through.
   * OPTIONAL and NOT consumed by this view: like the
   * recordings/runs clients it lives on the Replay bag, but it is APP that
   * reads it, because App owns the default `recordBlindComparison` and
   * therefore owns where a judgement lands.
   */
  blindComparisons?: BlindComparisonsClient;

  /**
   * TICKET 046 ROUND 2 (R2-1) — the transport factory `runOnce` is bound to.
   *
   * OPTIONAL and NOT consumed by this view, for exactly the reason
   * `blindComparisons` above is not: it is a HOST fact. It exists because the
   * Replay transport wiring (the outbound sink, the inbound tap, the muted
   * remote sink) is the part of this ticket that lives in the product and
   * nowhere else, and a wiring assertion that reads the module's SOURCE TEXT is
   * satisfied by an import line — the property can be deleted outright and every
   * test stays green. A production bag MUST set this to the very function it
   * hands `runOnce`, so the wiring is assertable on the CONSTRUCTED object.
   */
  createTransport?: (config: RunOnceConfig) => InterpreterTransport;

  /* --- ticket 036: the record-a-corpus-take seams (PRD §7 step 1) --- */

  /**
   * Starts a microphone take, PRE-BOUND to the host's browser seams. OPTIONAL,
   * and the option is load-bearing in the same way blind compare's is: a host
   * with no capture seams gets no record affordance rather than a fake one.
   */
  startTake?: (options: ReplayTakeOptions) => Promise<TakeRecorder | CaptureDenied>;
  /** Splits a finished take into utterances the operator then confirms. */
  segmentTake?: (samples: Int16Array) => SegmentedUtterance[];
  /** On-demand playback of the recorded take. NEVER called at render.
   *  TICKET 049 ROUND 2 — same optional failure report as `playRun`. */
  playTake?: (take: RecordedTake, onUnavailable?: (error: unknown) => void) => void;
  /**
   * The corpus version stamped onto a Recording saved as corpus. It is the
   * HOST's fact, not the view's: provenance belongs to whoever assembled the
   * corpus, not to the component that happened to render the form.
   */
  corpusVersion?: string;
}

export interface ReplayViewProps {
  deps: ReplayDeps;
}

/* ------------------------------------------------------------------ copy -- */

const TITLE = 'Replay';

const HEADER_SUBLINE =
  'Record once, run it through any configuration. Runs of the same Recording ' +
  'are comparable by construction.';

const RECORD_NEW = 'Record new clip · max 1 min';

/** The blind-compare trigger. Pairwise by name: three runs are not judgeable. */
const OPEN_BLIND = 'compare blind (pick 2 runs)';
const CLOSE_BLIND = 'close blind compare';

/**
 * Ticket 036 — why the record affordance is refused on a host that supplied no
 * capture seams (fixture bags, tests, a future headless embed). It is a fact
 * about the HOST, not a promise about a feature: the flow exists, this bag just
 * cannot reach a microphone.
 */
const NO_CAPTURE_HINT =
  'This host supplied no microphone capture seams, so a clip cannot be recorded here.';

/**
 * Retained repetitions per (recording × configuration) cell.
 *
 * TICKET 065 — THREE, not five. PRD §17 22c specified five; §15A (2026-08-09)
 * cut 5-rep sweeps to 3 and postdates it, so §15A wins and the document's own
 * contradiction is resolved here rather than left for the next reader.
 *
 * The warmup is an ADDITIONAL execution the batch runner discards, never one of
 * these three — which is why the confirmation quotes `executionCount`
 * (reps + 1 per cell) and not the runner's measured `totalRuns`.
 */
const SWEEP_REPS = 3;

/* ------------------------------------------ ticket 065: the confirmation -- */

/** The dialog's accessible name, and its heading. */
const SWEEP_CONFIRM_TITLE = 'Start this batch sweep?';

/** Why the operator is being asked at all: this is the expensive press. */
const SWEEP_CONFIRM_NOTE =
  'Replay is paced at 1×, so a sweep costs its wall clock in real time. ' +
  'Nothing has started yet.';

const SWEEP_CONFIRM_START = 'Start sweep';
const SWEEP_CONFIRM_CANCEL = 'Cancel — start nothing';

/** Why no figure: no priced run of this clip exists to project from. */
const SWEEP_COST_BASIS_NONE = 'no priced run of this clip to project from';

/** M:SS, or H:MM:SS past the hour — a sweep is measured in hours. */
function formatClock(totalMs: number): string {
  const totalSeconds = Math.round(totalMs / 1_000);
  const seconds = totalSeconds % 60;
  const minutes = Math.floor(totalSeconds / 60) % 60;
  const hours = Math.floor(totalSeconds / 3_600);
  const pad = (value: number): string => String(value).padStart(2, '0');
  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(seconds)}` : `${minutes}:${pad(seconds)}`;
}

/* ---------------------------------------------------------------- styles -- */

const pageStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 'var(--space-4)',
};

const headerStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'baseline',
  gap: 'var(--space-3)',
  flexWrap: 'wrap',
};

const columnsStyle: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: '330px 1fr',
  gap: 'var(--space-4)',
  alignItems: 'start',
};

const blindToggleStyle: CSSProperties = {
  alignSelf: 'flex-start',
  border: '1px solid var(--border-default)',
  borderRadius: 'var(--radius-md)',
  background: 'var(--surface-card)',
  color: 'var(--text-body)',
  fontFamily: 'inherit',
  fontSize: 'var(--text-sm)',
  fontWeight: 'var(--weight-medium)',
  padding: 'var(--space-2) var(--space-3)',
  cursor: 'pointer',
};

/**
 * TICKET 065 — the confirmation. Rendered as an OPEN panel rather than a native
 * <dialog>: jsdom has no `showModal`, and a step that only exists imperatively
 * cannot be asserted, which is how the missing dialog survived this long.
 */
const sweepConfirmStyle: CSSProperties = {
  background: 'var(--surface-card)',
  border: '1px solid var(--border-strong)',
  borderRadius: 'var(--radius-lg)',
  boxShadow: 'var(--shadow-card)',
  padding: 'var(--space-4) var(--space-5)',
  display: 'flex',
  flexDirection: 'column',
  gap: 'var(--space-3)',
};

const sweepFigureStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 'var(--space-1)',
  minWidth: 160,
};

const sweepFigureLabelStyle: CSSProperties = {
  fontSize: 'var(--text-xs)',
  fontWeight: 'var(--weight-medium)',
  color: 'var(--text-muted)',
  textTransform: 'uppercase',
  letterSpacing: '.05em',
};

const sweepFigureValueStyle: CSSProperties = {
  fontFamily: 'var(--font-mono)',
  fontSize: 'var(--text-sm)',
  color: 'var(--text-body)',
};

const sweepRowStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'flex-start',
  gap: 'var(--space-4)',
  flexWrap: 'wrap',
};

const sweepNoteStyle: CSSProperties = {
  color: 'var(--text-muted)',
  fontSize: 'var(--text-xs)',
  lineHeight: 'var(--leading-normal)',
};

/**
 * ROUND 2 F2 — the attributes a region behind an open quote carries.
 *
 * A `const`, not an inline literal, and a STRING value: React 18 has no
 * knowledge of `inert`, so it forwards it as a custom attribute when the value
 * is a string and drops it with a warning when it is `true`.
 */
const INERT_BACKGROUND = { inert: '' };

/** Confirm is primary; dismissing is not. Same vocabulary as the run actions. */
function confirmButtonStyle(primary: boolean): CSSProperties {
  return {
    appearance: 'none',
    border: primary ? '1px solid var(--btn-primary-bg)' : '1px solid var(--border-default)',
    borderRadius: 'var(--radius-md)',
    background: primary ? 'var(--btn-primary-bg)' : 'var(--surface-card)',
    color: primary ? 'var(--text-inverse)' : 'var(--text-body)',
    fontFamily: 'inherit',
    fontSize: 'var(--text-sm)',
    fontWeight: 'var(--weight-medium)',
    padding: 'var(--space-2) var(--space-4)',
    cursor: 'pointer',
  };
}

function recordButtonStyle(enabled: boolean): CSSProperties {
  return {
    marginLeft: 'auto',
    border: '1px solid var(--border-default)',
    borderRadius: 'var(--radius-md)',
    background: 'var(--surface-card)',
    color: enabled ? 'var(--text-body)' : 'var(--text-secondary)',
    fontFamily: 'inherit',
    fontSize: 'var(--text-sm)',
    fontWeight: 'var(--weight-medium)',
    padding: 'var(--space-2) var(--space-3)',
    cursor: enabled ? 'pointer' : 'not-allowed',
  };
}

/* ----------------------------------------------------------------- state -- */

/** A sweep in flight, plus the matrix it was started over. */
interface SweepState {
  handle: BatchHandle;
  configurations: BatchConfiguration[];
  reps: number;
  progress: BatchProgress | null;
}

/**
 * TICKET 065 — a sweep the operator has been SHOWN and has not yet agreed to.
 *
 * The matrix is captured when the confirmation opens and handed to
 * `startBatch` unchanged, so the sweep that runs is the sweep that was quoted:
 * the configurations (with ticket 061's chosen target language already baked
 * in), the reps, and the three figures derived from them. Rebuilding any of it
 * at confirm time would let the screen and the executor disagree — which is the
 * failure this ticket exists against, one step further along.
 */
interface SweepPlan {
  recordingId: string;
  configurations: BatchConfiguration[];
  reps: number;
  /**
   * ROUND 2 F2 — the pair and direction baked into every configuration above,
   * kept whole so the dialog can NAME them. A quote that is silent about the
   * one thing ticket 061 made variable cannot contradict a target control that
   * has moved under it, which is precisely how it stayed silent for so long.
   */
  languages: LanguageSelection;
  /** Every execution, warmups included — `executionCount`, never `totalRuns`. */
  executions: number;
  /** durationMs × executions: replay is paced at 1×, so this is real time. */
  wallclockMs: number;
  /** Projected spend, or null when nothing priced it. NEVER a zero. */
  costUsd: number | null;
  /** How many priced prior runs the projection averaged; 0 when none. */
  costBasisRuns: number;
}

/**
 * TICKET 065 — the projected spend, or `null`.
 *
 * THE ONLY PRICE EVIDENCE IN HAND is what runs of this clip actually cost, so
 * the projection is the mean measured cost of its priced, completed runs times
 * the executions ahead. A run that declares no price source priced NOTHING
 * (ticket 059), whatever figure it stores, so `costFromPriceSource` is the gate
 * and unstamped runs contribute nothing rather than a zero.
 *
 * With no priced prior run there is no rate in force, and the answer is
 * ABSENCE — `not measured` — never `$0.00`: a sweep quoted at zero would be a
 * claim that the providers are free.
 */
function projectSweepCostUsd(
  priorRuns: readonly Run[],
  executions: number,
): { usd: number | null; basisRuns: number } {
  const priced = priorRuns
    .filter((run) => run.status === 'complete')
    .map((run) => costFromPriceSource(run.pricingVersion, run.cost));
  const sum = sumMeasuredCosts(priced);
  if (sum.usd === null || sum.measured === 0) return { usd: null, basisRuns: 0 };
  const perExecution = sum.usd / sum.measured;
  // ROUND 2 F3 — A MEASURED ZERO IS A MEASUREMENT, AND IT STAYS ONE.
  //
  // This guard read `if (!(perExecution > 0)) return { usd: null }`, which
  // reported a rate of exactly zero — stamped with a price source, written
  // today, genuinely free — as ABSENCE. That inverts the other half of ticket
  // 059 ('a Run whose measured cost really is 0 still renders $0.000') and the
  // rule under it: zero is a measurement, absence is not.
  //
  // AC4 is unharmed. The string it forbids is `$0.00`, and `formatCostUsd`
  // never produces it for a figure anyone measured — `formatAmountUsd` gives a
  // measured zero three decimals. An UNPRICED sweep still reads `not measured`,
  // above, on the `sum.measured === 0` gate that is the real absence test.
  //
  // What remains here is arithmetic hygiene only: `sum.measured` is non-zero by
  // the line above and `sumMeasuredCosts` only ever adds finite figures, so
  // this is unreachable today and is kept as the one honest reason a rate can
  // have no figure behind it.
  if (!Number.isFinite(perExecution)) return { usd: null, basisRuns: 0 };
  return { usd: perExecution * executions, basisRuns: sum.measured };
}

function initialConfig(): ReplayConfigState {
  // Arm B's recipe by construction (PRD §17 23d): a default that derived to
  // 'ad-hoc' would turn every unconfigured run into an orphan.
  return {
    architecture: 'cascade',
    realtimeModel: REALTIME_MODEL,
    providers: { ...DEFAULT_CASCADE_TRIPLE },
  };
}

/**
 * The sweep matrix: the frozen arms, named by the derivation that owns them,
 * each carrying the LANGUAGES the clip implies (ticket 062).
 *
 * A sweep from here is the same run TWELVE times — 1 clip × 3 frozen arms ×
 * (3 retained reps + 1 warmup), the count `executionCount` quotes — so an
 * omitted language field here is the defect twelve times, once per execution
 * the operator paid for. It is the shape run dbeb6d94 was produced in. The arms
 * stay frozen: `entry.config` is spread, never mutated, and languages are not
 * part of the recipe `deriveArmTag` matches on, so every leg still derives to
 * the arm it belongs to.
 */
function sweepConfigurations(languages: LanguageSelection): BatchConfiguration[] {
  return ARMS.map((entry) => ({
    id: entry.tag,
    label: entry.label,
    config: {
      ...entry.config,
      languagePair: languages.languagePair,
      direction: languages.direction,
      targetLanguage: languages.targetLanguage,
    },
  }));
}

/* ------------------------------------------------------------------ view -- */

export default function ReplayView(props: ReplayViewProps): ReactElement {
  const { deps } = props;

  const [recordings, setRecordings] = useState<Recording[]>([]);
  /**
   * Ticket 020 — the rejection the last recordings load ended in, or null.
   * A load that FAILS and a load that returns zero Recordings are different
   * facts (PRD §12), so they get different state and different renderings:
   * this is what stops a dead backend reading as an empty store.
   */
  const [recordingsError, setRecordingsError] = useState<unknown>(null);
  const [runs, setRuns] = useState<Run[]>([]);
  /**
   * TICKET 066 — SEEDED FROM THE INJECTED STORE, not from `null`.
   *
   * The id is only a claim until the library answers: `resolveRestoredSelection`
   * below settles it against the Recordings that actually loaded, so a stored id
   * naming a deleted or missing clip becomes no selection instead of a selection
   * with no row.
   */
  const [selectedRecordingId, setSelectedRecordingId] = useState<string | null>(
    () => deps.selectionStore?.get() ?? null,
  );
  /**
   * Whether the restored id is still awaiting that resolution. It is consumed
   * ONCE, by the first recordings load: a later load must not re-run the check,
   * because soft-deleting the CURRENTLY selected Recording deliberately keeps
   * the selection — its Runs stay listed and must still be able to name the
   * input that produced them.
   */
  const restorePending = useRef(deps.selectionStore !== undefined);
  const [config, setConfig] = useState<ReplayConfigState>(initialConfig);
  /**
   * TICKET 061 — the target language the OPERATOR picked, or null for "whatever
   * the selected clip's first legal target is". A name, not an index: the
   * chosen language has to survive a change of clip only when it is still legal
   * for the new one, and a name is the only form that can be checked against
   * that clip's own list.
   */
  const [chosenTarget, setChosenTarget] = useState<string | null>(null);
  const [sweep, setSweep] = useState<SweepState | null>(null);
  /** TICKET 065 — the quoted-but-unstarted sweep, or null. Opened by the press. */
  const [sweepPlan, setSweepPlan] = useState<SweepPlan | null>(null);
  /**
   * Ticket 044 — a MANUAL run this view started and has not seen settle. It
   * mirrors `sweep` deliberately: one pattern for "a request of this kind is
   * out", not two. The run's semantics are untouched — this state is read only
   * to say so on screen and to refuse a second, billable click.
   */
  const [runInFlight, setRunInFlight] = useState(false);
  const [blindOpen, setBlindOpen] = useState(false);
  /** Ticket 036 — the record flow is OPENED, never standing: no panel, no mic. */
  const [recordOpen, setRecordOpen] = useState(false);
  /**
   * TICKET 049 ROUND 2 (R2-5) — the browser's error from a play press that
   * could not build an AudioContext, or null. Replay shares ONE context per
   * deps bag, so a press that cannot build it is otherwise a silent no-op —
   * and on this screen "I pressed play and heard nothing" is how the operator
   * diagnoses a run whose stored output audio is empty. Two very different
   * findings must not look identical.
   */
  const [playbackError, setPlaybackError] = useState<unknown>(null);

  /**
   * Every play press on this screen goes through one of these two, so no arm
   * can forget to report. THREE arms feed them: the runs list, blind compare
   * (where an unexplained silence is scored as a property of the run) and the
   * record flow's "Play take".
   *
   * TICKET 049 R3-1 — `playTake` used to be handed to RecordTake RAW, which
   * narrowed it straight back to one argument, so the reporter the bag accepts
   * had no production caller at all. A press with the context cap full was a
   * silent no-op, and a freshly recorded take has no "no audio stored"
   * explanation available to fall back on.
   */
  const playRun = useCallback(
    (runId: string): void => {
      setPlaybackError(null);
      deps.playRun(runId, (error) => setPlaybackError(error));
    },
    [deps],
  );
  const playTake = useCallback(
    (take: RecordedTake): void => {
      setPlaybackError(null);
      deps.playTake?.(take, (error) => setPlaybackError(error));
    },
    [deps],
  );

  const refreshRuns = useCallback(async (): Promise<void> => {
    setRuns(await deps.runs.list());
  }, [deps]);

  /**
   * The one path that reads the recordings store — mount AND retry, so the
   * two can never drift apart. It CATCHES: an escaping rejection is what left
   * the view rendering the empty state against a dead backend, and an
   * unhandled rejection is not a UI state anyone can act on.
   *
   * `isLive` is how the mount effect abandons a load whose view has gone; the
   * retry press supplies nothing and is always live.
   */
  /**
   * TICKET 065 ROUND 2 (F2) — WHILE A QUOTE IS OPEN, THE SCREEN BEHIND IT IS
   * FROZEN TOO.
   *
   * `SweepPlan` freezes the clip and the configurations at press time and hands
   * those very objects to the executor. But `sweepInFlight` is false while a
   * quote is open and the panel was modal in NAME only — no backdrop, no focus
   * trap, no `inert` — so the operator could pick a different clip, or a
   * different target language, and then press Start sweep. The sweep ran the
   * QUOTED clip and target while the library and the target control showed the
   * new ones: a displayed value disagreeing with what runs, which is the exact
   * failure ticket 065 exists against, one step further along.
   *
   * The refusals below are the FACT and `inert` on the two background regions
   * is the affordance — the same division `run()` and `startSweep()` already
   * make between a disabled button and their own guards, and necessary for the
   * same reason: a click that arrives anyway (keyboard, a stale render, a
   * browser without `inert`) must not be able to move the screen out from under
   * a quote the operator is reading.
   */
  const quoteOpen = sweepPlan !== null;

  /**
   * TICKET 066 — the ONE path a selection changes through, so the store can
   * never fall behind the screen. A store that is only ever READ restores
   * whatever it was seeded with and never the clip the operator picked.
   */
  const selectRecording = useCallback(
    (recordingId: string | null): void => {
      if (quoteOpen) return;
      setSelectedRecordingId(recordingId);
      deps.selectionStore?.set(recordingId);
    },
    [deps, quoteOpen],
  );

  /**
   * TICKET 066 — settles a RESTORED id against the library that just loaded.
   *
   * Three outcomes, and the last two are the same one: the clip is there and
   * stays selected; the clip is absent; the clip is soft-deleted, so it has no
   * row (`visibleRecordings` excludes it) even though `selectedRecording` can
   * still find it. Both misses resolve to NO selection — a selected id with no
   * row is this ticket's own contradiction, inverted, and it would leave both
   * actions disabled while still holding the stale id.
   *
   * ONLY ON RESTORATION. A soft delete performed HERE, on the clip the operator
   * has selected, deliberately keeps the selection so its Runs stay listed.
   */
  const resolveRestoredSelection = useCallback(
    (loaded: readonly Recording[]): void => {
      if (!restorePending.current) return;
      restorePending.current = false;
      setSelectedRecordingId((current) => {
        if (current === null) return null;
        const live = loaded.some(
          (recording) => recording.id === current && recording.deletedAt === undefined,
        );
        if (live) return current;
        // The stored id named nothing selectable; forget it rather than restore
        // the same dead selection on every future mount.
        deps.selectionStore?.set(null);
        return null;
      });
    },
    [deps],
  );

  const loadRecordings = useCallback(
    async (isLive: () => boolean = () => true): Promise<void> => {
      try {
        const loaded = await deps.recordings.list();
        if (!isLive()) return;
        setRecordings(loaded);
        setRecordingsError(null);
        resolveRestoredSelection(loaded);
      } catch (cause: unknown) {
        if (!isLive()) return;
        // The library is UNKNOWN, not empty — the rows go, the error stands in
        // their place, and RecordingsLibrary renders one state or the other.
        setRecordings([]);
        setRecordingsError(() => cause);
      }
    },
    [deps, resolveRestoredSelection],
  );

  useEffect(() => {
    let live = true;
    const isLive = (): boolean => live;
    void (async () => {
      // Independent loads, each catching its own: an unreadable recordings
      // store must not also blank the runs list, and NEITHER rejection may
      // escape the effect. The escaping one is what this ticket is about.
      await Promise.all([
        loadRecordings(isLive),
        (async () => {
          try {
            const loadedRuns = await deps.runs.list();
            if (isLive()) setRuns(loadedRuns);
          } catch {
            // The runs list has no error surface of its own in this contract;
            // it stays at its last known value rather than throwing the view
            // away. What it must never do is reject into nowhere.
          }
        })(),
      ]);
    })();
    return () => {
      live = false;
    };
  }, [deps, loadRecordings]);

  /** Every Run, failed included — a failure is a Run like any other. */
  const runCounts: Record<string, number> = {};
  for (const run of runs) {
    runCounts[run.recordingId] = (runCounts[run.recordingId] ?? 0) + 1;
  }

  // A soft-deleted Recording leaves the library but stays reachable, so its
  // Runs keep a label and a duration to normalize their cost by.
  const visibleRecordings = recordings.filter((recording) => recording.deletedAt === undefined);
  const selectedRecording =
    recordings.find((recording) => recording.id === selectedRecordingId) ?? null;
  const selectedRuns = runs.filter((run) => run.recordingId === selectedRecordingId);

  const rename = (recordingId: string, label: string): void => {
    void deps.recordings.patchLabel(recordingId, label).then((next) => {
      setRecordings((previous) =>
        previous.map((recording) => (recording.id === recordingId ? next : recording)),
      );
    });
  };

  const remove = (recordingId: string): void => {
    void deps.recordings.remove(recordingId).then((next) => {
      setRecordings((previous) =>
        previous.map((recording) => (recording.id === recordingId ? next : recording)),
      );
    });
  };

  /**
   * TICKET 062 — the languages a run over the SELECTED clip must use.
   *
   * A Recording declares its own `sourceLanguage`, so the SOURCE half of the
   * direction is a property of the clip rather than a control that can be left
   * blank. A run over a clip can therefore never be language-less, and can
   * never be pointed at the language it is already in.
   *
   * TICKET 061 — THE TARGET HALF IS THE OPERATOR'S. `languageSelectionForSource`
   * returns the first pair whose source matches, and `pairs[0]` is EN↔ES, so
   * every English clip resolved to Spanish: EN→YUE was unreachable from Replay,
   * and sweeps run through Replay, so the kept Cantonese track could not be
   * produced at all. The choice is now made on a visible control (AC2) and read
   * from here, so `run()` and `startSweep()` cannot disagree about it.
   *
   * The clip's own legal targets are the authority, never the stored choice: a
   * 'Cantonese' picked for an English clip is not legal for a Spanish one, and
   * resolving it to that clip's first legal target is what stops the choice
   * leaking across a selection change.
   */
  const targetOptions = targetLanguagesForSource(selectedRecording?.sourceLanguage ?? '');
  const targetLanguage =
    chosenTarget !== null && targetOptions.includes(chosenTarget)
      ? chosenTarget
      : targetOptions[0]!;

  const runLanguages = (): LanguageSelection =>
    languageSelectionForTarget(selectedRecording?.sourceLanguage ?? '', targetLanguage);

  const run = (): void => {
    // The guard mirrors startSweep's: the disabled button is the affordance,
    // this is the fact. Both halves are needed — a click that arrives anyway
    // (keyboard, a stale render) must not spend the provider budget twice.
    if (selectedRecordingId === null || runInFlight) return;
    setRunInFlight(true);
    const languages = runLanguages();
    void deps
      .runOnce({
        recordingId: selectedRecordingId,
        config: {
          architecture: config.architecture,
          realtimeModel: config.realtimeModel,
          providers: config.providers,
          // TICKET 062 — THE OMISSION THAT SHIPPED GERMAN. This object was
          // `{ architecture, realtimeModel, providers }` and nothing else, so
          // `runOnce` filled the language fields with '' and the realtime
          // session was instructed to "translate into ".
          languagePair: languages.languagePair,
          direction: languages.direction,
          targetLanguage: languages.targetLanguage,
        },
      })
      .then((result) => {
        // A run that RESOLVES as `status: 'failed'` is a Run like any other —
        // runner.ts loses a stage by resolving, not by throwing.
        setRuns((previous) => [...previous, result.run]);
      })
      // A REJECTED runOnce is the third exit, and it must be CAUGHT: an
      // unhandled rejection is not a UI state anyone can act on, and leaving
      // it uncaught would also skip the clear below.
      .catch(() => {})
      // One rule for all three exits — complete, resolved-failed, rejected —
      // so a failure can never leave the panel looking permanently busy.
      .finally(() => {
        setRunInFlight(false);
      });
  };

  /**
   * TICKET 065 — THE PRESS QUOTES THE SWEEP. It reaches no executor.
   *
   * The gate is HERE, on the handler, not inside the launcher: a confirmation
   * added after `startSweep`'s `sweep !== null` guard would still be re-enterable
   * while `sweep` is null, so two presses could quote twice and launch twice.
   * A second press while a quote is open is a no-op.
   */
  const openSweepConfirm = (): void => {
    if (selectedRecordingId === null || sweep !== null || sweepPlan !== null) return;
    // Built ONCE, here: the arms with ticket 061's chosen target language baked
    // in. `confirmSweep` hands these very objects to the executor rather than
    // rebuilding them from a default, so the sweep that runs is the one quoted.
    const languages = runLanguages();
    const configurations = sweepConfigurations(languages);
    const executions = executionCount(1, configurations.length, SWEEP_REPS);
    const cost = projectSweepCostUsd(selectedRuns, executions);
    setSweepPlan({
      recordingId: selectedRecordingId,
      configurations,
      languages,
      reps: SWEEP_REPS,
      executions,
      // Replay is paced at 1× (PRD §7, eval 08), so the clip's own duration —
      // never a constant — is what each execution costs in wall clock.
      wallclockMs: (selectedRecording?.durationMs ?? 0) * executions,
      costUsd: cost.usd,
      costBasisRuns: cost.basisRuns,
    });
  };

  /** Dismisses the quote. Nothing was started, so there is nothing to stop. */
  const cancelSweepConfirm = (): void => setSweepPlan(null);

  /**
   * ROUND 2 F2 — the other half of the modality. Ticket 061's control is the
   * one that could change what a launched sweep TRANSLATES INTO while the
   * dialog went on naming the pair it quoted.
   */
  const chooseTarget = (language: string): void => {
    if (quoteOpen) return;
    setChosenTarget(language);
  };

  /** The ONLY path to deps.startBatch. */
  const startSweep = (): void => {
    if (sweepPlan === null || sweep !== null) return;
    const { configurations, reps } = sweepPlan;
    setSweepPlan(null);
    /**
     * THE FIRST PROGRESS EVENT ARRIVES *DURING* THE CALL BELOW.
     *
     * `startBatch` builds its `done` as an async IIFE, and an async body runs
     * SYNCHRONOUSLY until its first `await`; `emitProgress(cell)` is the first
     * statement in `runCell`. So `onProgress` fires while `deps.startBatch(...)`
     * is still on the stack — before this line's `handle` exists and before the
     * `setSweep` below has run.
     *
     * That cost the operator twenty seconds of a panel reading `starting — no
     * run has been dispatched yet` with no clock on it: the updater's
     * `previous === null` branch discarded the event (there was no sweep state
     * to fold it into yet), and the `setSweep` below would have clobbered it
     * anyway. The next event is emitted at the START of the second cell — one
     * whole 1×-paced execution later.
     *
     * So the synchronous event is CAUGHT here and the initial state is SEEDED
     * with it. This is a captured measurement, never a fabricated one: if
     * nothing was emitted during the call this stays `null` and the panel goes
     * on saying it is waiting — no invented `0:00` clock (ticket 067).
     */
    let duringStart: BatchProgress | null = null;
    const handle = deps.startBatch({
      recordingIds: [sweepPlan.recordingId],
      configurations,
      reps,
      onProgress: (progress) => {
        duringStart = progress;
        setSweep((previous) => (previous === null ? previous : { ...previous, progress }));
      },
    });
    setSweep({ handle, configurations, reps, progress: duringStart });
    // A cancelled sweep is a SHORT sweep: whatever completed is still listed.
    void handle.done.then(() => {
      setSweep(null);
      void refreshRuns();
    });
  };

  /**
   * Blind compare, ticket 014. A failed Run produced no audio, so only
   * COMPLETED runs are pairable; and without all three seams there is nothing
   * honest to offer, so the trigger is absent rather than disabled.
   */
  const completedRuns = selectedRuns.filter((run) => run.status === 'complete');
  const { rng, evaluatorLanguage, recordBlindComparison } = deps;

  let blindTrigger: ReactElement | null = null;
  let blindCard: ReactElement | null = null;
  if (
    rng !== undefined &&
    evaluatorLanguage !== undefined &&
    recordBlindComparison !== undefined &&
    selectedRecording !== null &&
    completedRuns.length >= 2
  ) {
    blindTrigger = (
      <button
        type="button"
        data-blind-toggle=""
        onClick={() => setBlindOpen((open) => !open)}
        style={blindToggleStyle}
      >
        {blindOpen ? CLOSE_BLIND : OPEN_BLIND}
      </button>
    );
    if (blindOpen) {
      blindCard = (
        <BlindCompare
          key={selectedRecording.id}
          recording={selectedRecording}
          runs={completedRuns}
          rng={rng}
          evaluatorLanguage={evaluatorLanguage}
          now={deps.now}
          newId={deps.newId}
          onPlay={playRun}
          onSubmit={recordBlindComparison}
        />
      );
    }
  }

  /**
   * Ticket 036 — the record flow. Both capture seams or nothing: a panel with a
   * Start button that cannot reach a microphone is worse than a refused button
   * that says why, so the affordance is DISABLED (with the reason) rather than
   * opening onto a dead end.
   */
  const { startTake, segmentTake } = deps;
  const canRecord = startTake !== undefined && segmentTake !== undefined;

  const saveTake = async (input: NewRecordingInput): Promise<void> => {
    const created = await deps.recordings.create(input);
    // Appended, not re-listed: the clip appears without a reload, and the rows
    // already on screen are not thrown away to get it there.
    setRecordings((previous) => [...previous, created]);
    setRecordOpen(false);
  };

  const recordPanel =
    recordOpen && startTake !== undefined && segmentTake !== undefined ? (
      /* R3-1 — `playTake` here is the FUNNEL, never `deps.playTake` raw. The
         raw forward was re-narrowed to one argument inside RecordTake and
         stranded the reporter; THIS line is what prevents that, not the prop's
         type (see RecordTake's own note).

         The `undefined` ternary is forward-looking defence only, and today it
         is INERT: [data-record-play] renders unconditionally and the funnel
         already no-ops when `deps.playTake` is absent, so passing the funnel
         unconditionally would behave identically. It is kept so the prop stays
         a truthful signal of "this host can play a take", in case that button
         is ever gated on it. */
      <RecordTake
        startTake={startTake}
        segmentTake={segmentTake}
        playTake={deps.playTake === undefined ? undefined : playTake}
        corpusVersion={deps.corpusVersion}
        now={deps.now}
        newId={deps.newId}
        onSave={saveTake}
        onClose={() => setRecordOpen(false)}
      />
    ) : null;

  const batchProgress =
    sweep === null ? null : (
      <BatchProgressPanel
        progress={sweep.progress}
        configurations={sweep.configurations}
        reps={sweep.reps}
        /* TICKET 067 — handed down the same path as `progress`, and ONLY while
           `sweep !== null`. The panel's mount is therefore the subscription's
           lifetime, and this ternary is what ends it on all three paths: the
           sweep completing, a cancel settling, and the view unmounting. */
        sweepClock={deps.sweepClock}
        onCancel={() => sweep.handle.cancel()}
      />
    );

  /**
   * TICKET 065 — the quote. EVERY FIGURE IS READ OFF THE PLAN, never recomputed
   * here: the number on screen and the number handed to the executor are the
   * same number, which is the whole point of capturing the plan at press time.
   */
  const sweepConfirm =
    sweepPlan === null ? null : (
      <div
        data-sweep-confirm=""
        role="dialog"
        aria-modal="true"
        aria-label={SWEEP_CONFIRM_TITLE}
        style={sweepConfirmStyle}
      >
        <span style={{ fontWeight: 'var(--weight-semibold)', fontSize: 'var(--text-base)' }}>
          {SWEEP_CONFIRM_TITLE}
        </span>

        <div style={sweepRowStyle}>
          <span style={sweepFigureStyle}>
            <span style={sweepFigureLabelStyle}>executions</span>
            <span
              data-sweep-executions={sweepPlan.executions}
              style={sweepFigureValueStyle}
            >
              {`${sweepPlan.executions} · 1 clip × ${sweepPlan.configurations.length} ` +
                `configurations × (${sweepPlan.reps} + 1 warmup)`}
            </span>
          </span>

          <span style={sweepFigureStyle}>
            <span style={sweepFigureLabelStyle}>retained reps</span>
            <span data-sweep-reps={sweepPlan.reps} style={sweepFigureValueStyle}>
              {`${sweepPlan.reps} per configuration`}
            </span>
          </span>

          {/* ROUND 2 F2 — THE QUOTE NAMES ITS OWN LANGUAGE PAIR. Nothing in
              the dialog used to mention the one thing ticket 061 made
              variable, so a target control that moved under it contradicted
              nothing on screen. This is read off the plan like every other
              figure, and it is what the configurations below it carry. */}
          <span style={sweepFigureStyle}>
            <span style={sweepFigureLabelStyle}>language pair</span>
            <span
              data-sweep-language-pair={sweepPlan.languages.languagePair}
              data-sweep-direction={sweepPlan.languages.direction}
              data-sweep-target-language={sweepPlan.languages.targetLanguage}
              style={sweepFigureValueStyle}
            >
              {`${sweepPlan.languages.languagePair} · ${sweepPlan.languages.direction} · ` +
                `into ${sweepPlan.languages.targetLanguage}`}
            </span>
          </span>

          <span style={sweepFigureStyle}>
            <span style={sweepFigureLabelStyle}>estimated wall clock</span>
            <span data-sweep-wallclock-ms={sweepPlan.wallclockMs} style={sweepFigureValueStyle}>
              {formatClock(sweepPlan.wallclockMs)}
            </span>
          </span>

          <span style={sweepFigureStyle}>
            <span style={sweepFigureLabelStyle}>estimated cost</span>
            {/* Absence, never a zero (ticket 059): a sweep quoted at $0.00
                would claim the providers are free. */}
            <span data-sweep-cost="" style={sweepFigureValueStyle}>
              {sweepPlan.costUsd === null
                ? COST_NOT_MEASURED_CELL
                : formatCostUsd(sweepPlan.costUsd)}
            </span>
            <span style={sweepNoteStyle}>
              {sweepPlan.costBasisRuns === 0
                ? SWEEP_COST_BASIS_NONE
                : `projected from ${sweepPlan.costBasisRuns} priced prior runs of this clip`}
            </span>
          </span>
        </div>

        <div style={sweepRowStyle}>
          <button
            type="button"
            data-sweep-confirm-start=""
            onClick={startSweep}
            style={confirmButtonStyle(true)}
          >
            {SWEEP_CONFIRM_START}
          </button>
          <button
            type="button"
            data-sweep-confirm-cancel=""
            onClick={cancelSweepConfirm}
            style={confirmButtonStyle(false)}
          >
            {SWEEP_CONFIRM_CANCEL}
          </button>
          <span style={{ ...sweepNoteStyle, flex: 1, minWidth: 240 }}>{SWEEP_CONFIRM_NOTE}</span>
        </div>
      </div>
    );

  /**
   * ROUND 2 F2 — the affordance half of the modality, on the two regions that
   * hold every control able to contradict an open quote: the header (record
   * new clip) and the columns (the library and ticket 061's target control).
   *
   * `inert` blocks the click, the focus and the accessibility tree in a real
   * browser, which is what `aria-modal="true"` on the dialog has been claiming
   * all along. jsdom implements none of that — so the handler refusals above
   * are what MAKE it true, and this is what SHOWS it. Written as a string
   * because React 18 drops `inert={true}` with a warning and passes an unknown
   * attribute through only when its value is a string.
   */
  const behindTheQuote = quoteOpen ? INERT_BACKGROUND : {};

  return (
    <div data-replay-view="" style={pageStyle}>
      <header data-replay-background="" {...behindTheQuote} style={headerStyle}>
        <h1
          style={{
            fontWeight: 'var(--weight-semibold)',
            fontSize: 'var(--text-lg)',
            letterSpacing: 'var(--tracking-heading)',
            margin: 0,
          }}
        >
          {TITLE}
        </h1>
        <p style={{ color: 'var(--text-secondary)', fontSize: 'var(--text-sm)', margin: 0 }}>
          {HEADER_SUBLINE}
        </p>
        <button
          type="button"
          data-record-new=""
          disabled={!canRecord}
          title={canRecord ? undefined : NO_CAPTURE_HINT}
          onClick={() => setRecordOpen(true)}
          style={recordButtonStyle(canRecord)}
        >
          {RECORD_NEW}
        </button>
      </header>

      {recordPanel}

      {/* TICKET 065 — the step the ellipsis promises. Nothing has started while
          it is on screen: `[data-batch-progress]` appears only after confirm. */}
      {sweepConfirm}

      <div data-replay-background="" {...behindTheQuote} style={columnsStyle}>
        <RecordingsLibrary
          recordings={visibleRecordings}
          runCounts={runCounts}
          selectedRecordingId={selectedRecordingId}
          onSelect={selectRecording}
          onRename={rename}
          onDelete={remove}
          loadError={recordingsError}
          onRetry={() => {
            void loadRecordings();
          }}
        />

        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            gap: 'var(--space-4)',
            minWidth: 0,
          }}
        >
          <RunConfigPanel
            recordingLabel={selectedRecording === null ? null : selectedRecording.label}
            config={config}
            onConfigChange={setConfig}
            /* TICKET 061 — the operator's half of the direction. The options
               are the SELECTED clip's legal targets, so the control can never
               point a clip at the language it is already in. */
            targetLanguages={selectedRecording === null ? null : targetOptions}
            targetLanguage={targetLanguage}
            onTargetLanguageChange={chooseTarget}
            onRun={run}
            onBatchSweep={openSweepConfirm}
            batchProgress={batchProgress}
            runInFlight={runInFlight}
            sweepInFlight={sweep !== null}
          />

          {blindTrigger}
          {blindCard}

          {/* TICKET 049 R2-5 — a press that produced no sound, and WHY. It sits
              with the runs it belongs to and carries the browser's own words,
              so "no output audio stored" ([data-run-no-audio]) and "this
              browser refused an audio context" read differently. A readout: it
              offers no retry, which could not work while the cap is full and
              would need a fresh gesture anyway. */}
          {playbackError !== null && (
            <div
              data-replay-playback-notice
              role="status"
              style={{
                border: '1px solid var(--border-default)',
                borderRadius: 'var(--radius-md)',
                padding: '9px 12px',
                font: '400 12px/1.6 var(--font-sans)',
                color: 'var(--text-secondary)',
              }}
            >
              No audio output — this browser refused a new audio context.{' '}
              <span data-replay-playback-reason style={{ fontFamily: 'var(--font-mono)' }}>
                {playbackError instanceof Error
                  ? `${playbackError.name}: ${playbackError.message}`
                  : String(playbackError)}
              </span>
            </div>
          )}

          <RunsList recording={selectedRecording} runs={selectedRuns} onPlay={playRun} />
        </div>
      </div>
    </div>
  );
}
