/**
 * Ticket 015 — Results view (v2 two-tab shape).
 *
 * `<ResultsView ledger={runLedger} />` — pure-props component (no context).
 * EVERY figure comes from src/client/components/results/derive.ts. This
 * component renders that model verbatim: it computes no metric, formats no
 * figure by hand (formatMs / formatUsd own that), and hardcodes no latency,
 * cost, WER or quality literal. Source-guard tests grep this file for money /
 * duration / percentage literals and for raw colour values, so styling is CSS
 * variables from tokens.css only.
 *
 * TWO VIEW-LEVEL RULES
 *
 * 1. EMPTY IS THE DEFAULT (PRD §8, §17 15g). The view is empty exactly when
 *    there is no LiveSession AND every groupByRecording row is fixture-only.
 *    An empty view renders 'No runs recorded' and NOTHING numeric — no card,
 *    no metric grid, no provenance line, not one digit. A fixture-only ledger
 *    therefore renders identically to a ledger with nothing in it at all: a
 *    fabricated figure must never be able to read as evidence. Once the view
 *    is non-empty the per-recording table lists EVERY group, fixture rows
 *    included and marked with why they are excluded.
 * 2. NOTHING POOLS. Each card names its own track and its own data. The
 *    conversation-length card reads LiveSessions and only LiveSessions; the
 *    experiment cards read sweep Runs and only sweep Runs. Either can be empty
 *    while the other has data, and each carries its own empty note.
 *
 * NOT-YET-DERIVABLE METRICS ARE SAID OUT LOUD. Adequacy / fluency need blind
 * scoring and the observable-interval count has no derivation yet, and this
 * component is not allowed to invent one. Those cells read 'not yet measured' —
 * never a zero, never a figure. Arm A's WER cell is additionally marked a
 * sidecar measurement, because a speech-to-speech arm has no transcript of its
 * own to score.
 *
 * TICKET 042 — WER REACHES THE SCREEN, AND IT IS STILL NOT COMPUTED HERE.
 *
 * Ticket 034 derived WER per arm and per (category × arm) and this view dropped
 * both on the floor, hardcoding 'not yet measured' into the exp 1 WER cells.
 * They now render `deriveWerByArm[arm].cell` and the by-category table gains a
 * `[data-category-wer]` column from `deriveWerByCategory`, joined to its row on
 * (category × arm) — never on the category alone, which would silently pick
 * whichever arm was appended first.
 *
 * THE CELL STRING IS THE DERIVATION'S, VERBATIM. `WerAggregate.cell` already
 * applies the precedence "a percentage when anything scored, else
 * `not applicable`, else `not yet measured`", so this view never inspects
 * `meanWer`, never formats a percentage, and cannot invent a zero. That is what
 * keeps the three distinct claims apart at the only layer an operator reads:
 *
 *   a zero percentage   the arm was PERFECT
 *   `not applicable`    the measurement is IMPOSSIBLE (PRD §9: Cantonese is
 *                       improvised from English prompt cards, so no reference)
 *   `not yet measured`  the measurement HAS NOT BEEN TAKEN
 *
 * The only string this file adds is the SIDECAR SUFFIX on column a, which is
 * provenance rather than a figure: a speech-to-speech arm has no transcript of
 * its own whether or not a sidecar pass has produced a number yet, so
 * `data-sidecar` and the suffix stay on that cell in every state.
 *
 * An arm (or a category × arm) with no aggregate at all falls back to the
 * literals above — `deriveWerByArm` yields nothing for a Run carrying no
 * per-utterance records, because WER is keyed by (runId, utteranceId).
 *
 * DOM contract (locked by ResultsView.test.tsx):
 *
 *   [data-results-tab="experiments" | "secondary"]  the mounted panel; exactly
 *                                                   one exists at a time
 *   role="tab" buttons 'Experiments' / 'By Recording & category', aria-selected
 *   [data-card="exp1"|"exp2"|"live"|"coverage"|"category"|"recording"]
 *   [data-eyebrow]                 track eyebrow inside a card
 *   [data-provenance="<card>"]     mono provenance line (also carries data-mono)
 *   [data-illustrative]            card-level 'illustrative' pill
 *   [data-takeaway]                gray takeaway box
 *   [data-empty-card="<card>"]     a card's own empty state
 *   [data-metric="<slug>"]         one metric-grid row
 *   [data-col="a"|"b"|"delta"]     cells of an exp1 / exp2 metric row
 *   [data-tone="good|bad|neutral"] on the delta cell
 *   [data-sidecar]                 exp1's Realtime WER cell
 *   [data-grid-header]             a metric grid's header row
 *   [data-live-column="realtime-default"|"realtime-trimmed"|"cascade"]
 *   [data-direction="<slug>"]      coverage row (a DIRECTION, never a pair)
 *   [data-stage="realtime"|"stt"|"mt"|"tts"]  coverage per-stage cell
 *   [data-observation]             coverage per-cell observation note
 *   [data-time-to-add]             one of the three time-to-add tiles
 *   [data-category-row][data-category="<category>"][data-n="<n>"]
 *                                  [data-direction="<direction>"]
 *   [data-category-direction]      ticket 061 — that row's direction, VISIBLE:
 *                                  the split has to be readable, not only
 *                                  machine-readable
 *   [data-category-wer]            ticket 042 — that row's WER cell
 *   [data-recording-row][data-recording="<id>"][data-arm][data-excluded]
 *   [data-failed-count][data-run-count]  on a recording row, ONLY when the
 *                                        group absorbed a failed run
 *   [data-failure-note]            that row's 'x of y attempts failed' note
 *   [data-exclusion="ad-hoc"|"manual"|"failed"|"fixture"]
 *
 * TICKET 019 — HYDRATION IS AN INJECTED, OPTIONAL SEAM.
 *
 *   [data-results-tab][data-results-hydration="loading"|"ready"|"failed"]
 *
 * The attribute exists ONLY when `hydrate` was supplied. Results used to read
 * a browser-local ledger while Replay read the server over REST — two stores
 * under one screen, so four Runs on the server rendered here as 'No runs
 * recorded' (PRD §8 allows exactly one ledger). `hydrate` loads the server's
 * Recordings and Runs into the SAME ledger instance every other view reads,
 * and it is a prop rather than a module import so no test here needs a
 * network. A host that omits it keeps today's behaviour exactly: no effect,
 * no attribute, no new DOM.
 *
 * Loading MORE data must not load data PAST the gate: hydration adds entities,
 * and `isAggregatableRun` still decides which of them reach a figure — the
 * failed, ad-hoc and fixture Runs stay out of every aggregate and stay listed,
 * marked, on the secondary tab.
 *
 * Rule 1 above gains a third state on top of empty: 'still asking' and 'could
 * not ask' are NOT emptiness and never render as it (see LOADING_/FAILED_).
 */

import { useEffect, useState, type CSSProperties, type ReactElement, type ReactNode } from 'react';
import { armLabel, type ArmTag } from '../../core/arms';
import {
  DIRECTION_ABSENT_KEY,
  WER_NOT_MEASURED_CELL,
  deriveComparison,
  deriveLiveModel,
  deriveWerByArm,
  deriveWerByCategory,
  formatMs,
  formatUsd,
  groupByCategory,
  groupByRecording,
  type CategoryGroupRow,
  type ComparisonModel,
  type LiveArmColumn,
  type LiveModel,
  type RecordingGroupRow,
  type Tone,
  type WerAggregate,
  type WerCategoryRow,
} from '../components/results/derive';
import { hydrateLedger, type LedgerHydrationSource } from '../state/hydrateLedger';
import type { RunLedger } from '../state/ledger';

export interface ResultsViewProps {
  ledger: RunLedger;
  /**
   * TICKET 019 — the injected seam that loads server-persisted Recordings and
   * Runs into `ledger` before anything is derived. OPTIONAL: a host that omits
   * it gets exactly today's behaviour (client-local ledger only) and renders
   * no hydration state at all, which is what keeps every pre-019 caller — and
   * the locked App shared-deps-bag guard — byte-identical.
   */
  hydrate?: LedgerHydrationSource;
}

/* ------------------------------------------------------------------ copy -- */

const HEADER_SUBLINE =
  'Every screen reads one append-only run ledger. Experiments aggregate only ' +
  'sweep-origin runs whose configuration matches a named arm.';

const TAB_PRIMARY = 'Experiments';
const TAB_SECONDARY = 'By Recording & category';

const EMPTY_TITLE = 'No runs recorded';
const EMPTY_SUBLINE =
  'Run a batch sweep in Replay to populate the experiments. Result cards never ' +
  'show sample data as evidence.';
const SWEEP_DISABLED_REASON = 'Sweeps require the real corpus to be loaded';

/*
 * TICKET 019 — the two states that are NOT emptiness.
 *
 * "Nothing recorded", "still asking" and "could not ask" are three different
 * claims, and only the first one is the empty state. Rendering either of the
 * other two as 'No runs recorded' would tell an operator their sweep produced
 * nothing when in fact this screen never got to look — the F3 bug, relocated.
 * Neither note carries a digit: there is no figure to report yet, and a stray
 * one here would read as a measurement.
 */
const LOADING_TITLE = 'Loading the run ledger…';
const LOADING_SUBLINE =
  'Reading the recordings and runs the server holds. Figures appear once they are ' +
  'in the ledger — none are shown before then.';

const FAILED_TITLE = 'Could not read the run ledger';
const FAILED_SUBLINE =
  'The run store did not answer, so this screen has nothing to show. That is not ' +
  'the same as an empty ledger: check that the server is reachable, then reopen ' +
  'this tab.';

/**
 * The cell a metric with no derivation behind it renders. A zero here would be
 * a measurement; this is the absence of one.
 */
const NOT_MEASURED = 'not yet measured';

/**
 * Arm A has no transcript of its own, so whatever its WER cell says, it says it
 * ABOUT A SIDECAR PASS. PROVENANCE, NOT A FIGURE: the suffix is appended in
 * every state — including once a real number exists — because the fact it
 * states is true in every state. It is the only string this file adds to a WER
 * cell; the cell itself is always the derivation's.
 */
const SIDECAR_SUFFIX = ' (sidecar transcript)';

function withSidecarProvenance(cell: string): string {
  return `${cell}${SIDECAR_SUFFIX}`;
}

const EXP1_EYEBROW = 'Experiment 1 · vendor held constant';
const EXP1_TITLE = 'Does the architecture itself cost latency?';
const EXP1_TAKEAWAY = 'Latency is a wash. Cost is not.';

const EXP2_EYEBROW = 'Experiment 2 · architecture held constant · one stage varies';
const EXP2_TITLE = 'What does swapping providers buy?';
const EXP2_TAKEAWAY =
  'One swapped stage, cleanly attributable: streaming text input is the single ' +
  'largest cascade latency lever.';

const LIVE_EYEBROW = 'Sourced from LiveSessions, not Replay runs';
const LIVE_TITLE = 'What changes as the conversation continues?';
const LIVE_TAKEAWAY =
  'The slope belongs to token billing with conversation replay, not to ' +
  'voice-to-voice. Trimming context removes most of it; cascade never had it.';
const LIVE_EMPTY = 'no live sessions recorded';

const COVERAGE_EYEBROW = 'Exploratory case study · never pooled with experiments';
const COVERAGE_TITLE = 'What does provider choice let us reach?';
const COVERAGE_PROVENANCE =
  'one operator · one pass per direction · listened to, not scored · no sweep behind it';
const COVERAGE_OBSERVATION =
  'Observation · English → Cantonese on Realtime returned Mandarin, not Cantonese, ' +
  'on every attempt — the direction is not reachable on the speech-to-speech path.';

const CATEGORY_EYEBROW = 'By utterance category — where the heterogeneity lives';
const RECORDING_EYEBROW = 'By Recording — includes ad-hoc runs, excluded from experiments';

/** The absence glyph, taken from the derivation so no literal lives here. */
const ABSENT = formatMs(null);

/* ---------------------------------------------------------------- styles -- */

const cardStyle: CSSProperties = {
  background: 'var(--surface-card)',
  border: '1px solid var(--border-default)',
  borderRadius: 'var(--radius-lg)',
  boxShadow: 'var(--shadow-card)',
  padding: 'var(--space-5) var(--space-6)',
};

const eyebrowStyle: CSSProperties = {
  fontWeight: 'var(--weight-medium)',
  fontSize: 'var(--text-xs)',
  textTransform: 'uppercase',
  letterSpacing: '.05em',
  color: 'var(--text-muted)',
  marginBottom: 'var(--space-1)',
};

const titleStyle: CSSProperties = {
  fontWeight: 'var(--weight-semibold)',
  fontSize: 'var(--text-lg)',
  letterSpacing: 'var(--tracking-heading)',
  margin: 0,
};

const monoStyle: CSSProperties = {
  fontFamily: 'var(--font-mono)',
  fontSize: 'var(--text-xs)',
  color: 'var(--text-muted)',
  margin: 'var(--space-2) 0 0',
  lineHeight: 'var(--leading-normal)',
};

const headerCellStyle: CSSProperties = {
  padding: 'var(--space-2) 0',
  fontWeight: 'var(--weight-medium)',
  fontSize: 'var(--text-xs)',
  textTransform: 'uppercase',
  letterSpacing: '.05em',
  color: 'var(--text-muted)',
};

const cellStyle: CSSProperties = { padding: 'var(--space-2) 0' };

const labelCellStyle: CSSProperties = { ...cellStyle, color: 'var(--text-secondary)' };

const takeawayStyle: CSSProperties = {
  background: 'var(--surface-sunken)',
  borderRadius: 'var(--radius-md)',
  padding: 'var(--space-3)',
  color: 'var(--text-secondary)',
  fontSize: 'var(--text-sm)',
  marginTop: 'var(--space-4)',
};

const emptyNoteStyle: CSSProperties = {
  color: 'var(--text-muted)',
  fontSize: 'var(--text-sm)',
  marginTop: 'var(--space-4)',
};

const pillStyle: CSSProperties = {
  display: 'inline-block',
  background: 'var(--warning-soft)',
  color: 'var(--text-secondary)',
  borderRadius: 'var(--radius-pill)',
  padding: 'var(--space-1) var(--space-2)',
  fontSize: 'var(--text-xs)',
  fontWeight: 'var(--weight-medium)',
  marginLeft: 'var(--space-2)',
};

const toneColor: { [tone in Tone]: string } = {
  good: 'var(--positive)',
  bad: 'var(--negative)',
  neutral: 'var(--text-muted)',
};

function gridStyle(columns: string, first: boolean): CSSProperties {
  return {
    display: 'grid',
    gridTemplateColumns: columns,
    gap: 'var(--space-3)',
    alignItems: 'baseline',
    borderTop: first ? 'none' : '1px solid var(--border-default)',
  };
}

/** Comparison and live grids share a shape: label column plus three values. */
const METRIC_COLUMNS = '1.5fr 1fr 1fr 1fr';
const COVERAGE_COLUMNS = '1.5fr 1fr 1fr 1fr 1fr';
/** Ticket 042 added the seventh track: the by-category WER cell. */
// TICKET 061 follow-up — a `direction` column sits between `arm` and `N`, in
// the same order as the row's identity triple (category × arm × direction).
// Sized like `arm`: both hold a short identity token, not a number.
const CATEGORY_COLUMNS = '1.5fr .8fr .8fr .5fr 1fr 1fr 1fr 1fr';
const RECORDING_COLUMNS = '1.3fr 1.6fr .6fr .8fr .5fr .8fr .8fr .8fr 1.4fr';

/* -------------------------------------------------------------- fragments -- */

function Card(props: {
  card: string;
  eyebrow: string;
  title: string;
  illustrative?: boolean;
  children: ReactNode;
}): ReactElement {
  return (
    <section data-card={props.card} style={cardStyle}>
      <div data-eyebrow="" style={eyebrowStyle}>
        {props.eyebrow}
      </div>
      <h2 style={titleStyle}>
        {props.title}
        {props.illustrative === true ? (
          <span data-illustrative="" style={pillStyle}>
            illustrative
          </span>
        ) : null}
      </h2>
      {props.children}
    </section>
  );
}

function Takeaway(props: { children: string }): ReactElement {
  return (
    <div data-takeaway="" style={takeawayStyle}>
      {props.children}
    </div>
  );
}

function EmptyCardNote(props: { card: string; children: string }): ReactElement {
  return (
    <div data-empty-card={props.card} style={emptyNoteStyle}>
      {props.children}
    </div>
  );
}

/* ------------------------------------------------------- experiment cards -- */

/**
 * One head-to-head card. The p50 / p95 / cost rows are the derivation's; the
 * remaining four rows are the metrics the operator has not produced yet, and
 * they say exactly that rather than showing a stand-in.
 */
function ComparisonCard(props: {
  card: 'exp1' | 'exp2';
  eyebrow: string;
  title: string;
  takeaway: string;
  armA: ArmTag;
  armB: ArmTag;
  model: ComparisonModel | null;
  /** True when column A is a speech-to-speech arm, whose WER is a sidecar. */
  sidecarWer: boolean;
  /**
   * TICKET 042 — `deriveWerByArm`'s output, passed in rather than derived here
   * so this component stays a renderer of one model. An arm with no
   * WER-bearing atom is simply absent from it.
   */
  werByArm: { [arm: string]: WerAggregate };
}): ReactElement {
  const { model } = props;

  // The DERIVATION'S cell, verbatim, or the absence literal when the arm has no
  // aggregate at all. Never `meanWer`, never a percentage formatted here — the
  // precedence between a figure, `not applicable` and `not yet measured` is
  // decided in derive.ts and nowhere else.
  const werCell = (arm: ArmTag): string => props.werByArm[arm]?.cell ?? WER_NOT_MEASURED_CELL;

  return (
    <Card card={props.card} eyebrow={props.eyebrow} title={props.title}>
      {model === null ? (
        <EmptyCardNote card={props.card}>
          {`no sweep runs recorded for ${armLabel(props.armA)} vs ${armLabel(props.armB)}`}
        </EmptyCardNote>
      ) : (
        <>
          <p data-provenance={props.card} data-mono="" style={monoStyle}>
            <span>{model.provenanceA.line}</span>
            <br />
            <span>{model.provenanceB.line}</span>
          </p>

          <div style={{ marginTop: 'var(--space-3)' }}>
            <div data-grid-header="" style={gridStyle(METRIC_COLUMNS, true)}>
              <div style={headerCellStyle}>metric</div>
              <div style={headerCellStyle}>{armLabel(model.armA)}</div>
              <div style={headerCellStyle}>{armLabel(model.armB)}</div>
              <div style={headerCellStyle}>delta</div>
            </div>

            {model.rows.map((row) => (
              <div key={row.metric} data-metric={row.metric} style={gridStyle(METRIC_COLUMNS, false)}>
                <div style={labelCellStyle}>{row.label}</div>
                <div data-col="a" style={cellStyle}>
                  {row.valueA}
                </div>
                <div data-col="b" style={cellStyle}>
                  {row.valueB}
                </div>
                <div data-col="delta" style={cellStyle}>
                  <span data-tone={row.deltaTone} style={{ color: toneColor[row.deltaTone] }}>
                    {row.delta}
                  </span>
                </div>
              </div>
            ))}

            <div data-metric="wer" style={gridStyle(METRIC_COLUMNS, false)}>
              <div style={labelCellStyle}>word error rate</div>
              {/* `data-sidecar` and the suffix are PROVENANCE and stay on this
                  cell whether or not a sidecar pass has produced a number. */}
              {props.sidecarWer ? (
                <div data-col="a" data-sidecar="" style={cellStyle}>
                  {withSidecarProvenance(werCell(props.armA))}
                </div>
              ) : (
                <div data-col="a" style={cellStyle}>
                  {werCell(props.armA)}
                </div>
              )}
              <div data-col="b" style={cellStyle}>
                {werCell(props.armB)}
              </div>
              <div data-col="delta" style={cellStyle}>
                {model.werCell}
              </div>
            </div>

            {UNMEASURED_ROWS.map((row) => (
              <div key={row.metric} data-metric={row.metric} style={gridStyle(METRIC_COLUMNS, false)}>
                <div style={labelCellStyle}>{row.label}</div>
                <div data-col="a" style={cellStyle}>
                  {NOT_MEASURED}
                </div>
                <div data-col="b" style={cellStyle}>
                  {NOT_MEASURED}
                </div>
                <div data-col="delta" style={cellStyle}>
                  {ABSENT}
                </div>
              </div>
            ))}
          </div>

          <Takeaway>{props.takeaway}</Takeaway>
        </>
      )}
    </Card>
  );
}

/**
 * Adequacy and fluency are blocked on blind scoring. The observable-interval
 * count could be read off the architecture, but there is no derivation for it
 * and this view is not allowed to compute one — so it is stated as unmeasured
 * too, and only that cell changes when a derivation arrives.
 */
const UNMEASURED_ROWS: ReadonlyArray<{ metric: string; label: string }> = [
  { metric: 'adequacy', label: 'adequacy (blind score)' },
  { metric: 'fluency', label: 'fluency (blind score)' },
  { metric: 'intervals', label: 'observable intervals' },
];

/* --------------------------------------------------- conversation length -- */

/**
 * The three columns of the conversation-length card. 'realtime · trimmed' has
 * no arm behind it: a trimmed-context policy is not something a LiveSession
 * declares yet, so the column renders absent rather than borrowing the default
 * realtime figures.
 */
const LIVE_COLUMNS: ReadonlyArray<{
  key: string;
  label: string;
  arm: ArmTag | null;
}> = [
  { key: 'realtime-default', label: 'realtime · default', arm: 'A' },
  { key: 'realtime-trimmed', label: 'realtime · trimmed', arm: null },
  { key: 'cascade', label: 'cascade', arm: 'B' },
];

const LIVE_ROWS: ReadonlyArray<{
  metric: string;
  label: string;
  value: (column: LiveArmColumn | undefined) => string;
}> = [
  {
    metric: 'utterances',
    label: 'utterances completed',
    value: (c) => (c ? String(c.utterancesCompleted) : ABSENT),
  },
  {
    metric: 'disconnects',
    label: 'disconnects',
    value: (c) => (c ? String(c.disconnects) : ABSENT),
  },
  { metric: 'p50', label: 'p50 latency', value: (c) => formatMs(c ? c.p50Ms : null) },
  { metric: 'p95', label: 'p95 latency', value: (c) => formatMs(c ? c.p95Ms : null) },
  {
    metric: 'drift',
    label: 'drift, first minute to end',
    value: (c) => formatMs(c ? c.driftMinute1ToEndMs : null),
  },
  {
    metric: 'cost-minute-1',
    label: 'cost per minute, first minute',
    value: (c) => formatUsd(c ? c.costPerMinuteMinute1 : null),
  },
  {
    metric: 'cost-final-minute',
    label: 'cost per minute, final minute',
    value: (c) => formatUsd(c ? c.costPerMinuteFinalMinute : null),
  },
];

function LiveCard(props: { model: LiveModel }): ReactElement {
  const { model } = props;
  const columnFor = (arm: ArmTag | null): LiveArmColumn | undefined =>
    arm === null ? undefined : model.columns.find((column) => column.arm === arm);

  const sessions = model.columns.reduce((sum, column) => sum + column.sessions, 0);
  const utterances = model.columns.reduce((sum, column) => sum + column.utterancesCompleted, 0);

  return (
    <Card card="live" eyebrow={LIVE_EYEBROW} title={LIVE_TITLE}>
      {model.empty ? (
        <EmptyCardNote card="live">{LIVE_EMPTY}</EmptyCardNote>
      ) : (
        <>
          <p data-provenance="live" data-mono="" style={monoStyle}>
            {`LiveSessions only · ${sessions} sessions · ${utterances} utterances completed · ` +
              // TICKET 051 R2-2 — NAME THE ANCHOR. These percentiles sit on the
              // same screen as Experiment 1's, and they are a DIFFERENT
              // QUANTITY: Replay's run from the corpus manifest's annotated
              // `speech_end`; Live has no ground truth and never will, so its
              // sample starts where the endpointer DECIDED the speaker stopped.
              // Unlabelled, side by side, the two invite exactly the comparison
              // this ticket exists to prevent.
              'latency from detected end of speech to first audio · ' +
              'no reference text, so no WER'}
          </p>

          <div style={{ marginTop: 'var(--space-3)' }}>
            <div data-grid-header="" style={gridStyle(METRIC_COLUMNS, true)}>
              <div style={headerCellStyle}>metric</div>
              {LIVE_COLUMNS.map((column) => (
                <div key={column.key} data-live-column={column.key} style={headerCellStyle}>
                  {column.label}
                </div>
              ))}
            </div>

            {LIVE_ROWS.map((row) => (
              <div key={row.metric} data-metric={row.metric} style={gridStyle(METRIC_COLUMNS, false)}>
                <div style={labelCellStyle}>{row.label}</div>
                {LIVE_COLUMNS.map((column) => (
                  <div key={column.key} data-live-column={column.key} style={cellStyle}>
                    {row.value(columnFor(column.arm))}
                  </div>
                ))}
              </div>
            ))}
          </div>

          <Takeaway>{LIVE_TAKEAWAY}</Takeaway>
        </>
      )}
    </Card>
  );
}

/* ----------------------------------------------------------- coverage card -- */

const COVERAGE_STAGES = ['realtime', 'stt', 'mt', 'tts'] as const;
type CoverageStage = (typeof COVERAGE_STAGES)[number];

const REACHED = 'reached';
const NOT_REACHED = 'not reached';
const WRONG_VARIETY = 'wrong variety';

/**
 * Rows are DIRECTIONS, not pairs: English → Cantonese and Cantonese → English
 * are separate claims and one can hold while the other does not. Every cell is
 * per-stage, so a failure is attributable to the stage that produced it. None
 * of this is measured — the card carries the illustrative pill.
 */
const COVERAGE_ROWS: ReadonlyArray<{
  direction: string;
  label: string;
  cells: { [stage in CoverageStage]: string };
}> = [
  {
    direction: 'en-es',
    label: 'English → Spanish',
    cells: { realtime: REACHED, stt: REACHED, mt: REACHED, tts: REACHED },
  },
  {
    direction: 'es-en',
    label: 'Spanish → English',
    cells: { realtime: REACHED, stt: REACHED, mt: REACHED, tts: REACHED },
  },
  {
    direction: 'en-yue',
    label: 'English → Cantonese',
    cells: { realtime: WRONG_VARIETY, stt: REACHED, mt: REACHED, tts: REACHED },
  },
  {
    direction: 'yue-en',
    label: 'Cantonese → English',
    cells: { realtime: NOT_REACHED, stt: REACHED, mt: REACHED, tts: REACHED },
  },
];

const TIME_TO_ADD: readonly string[] = [
  'Spanish → English on cascade · commit a4f21c · +11 lines · one language constant',
  'English → Cantonese on cascade · commit 9d0e77 · +14 lines · one voice id per direction',
  'English → Cantonese on Realtime · no mechanism exists at any price',
];

function CoverageCard(): ReactElement {
  return (
    <Card card="coverage" eyebrow={COVERAGE_EYEBROW} title={COVERAGE_TITLE} illustrative>
      <p data-provenance="coverage" data-mono="" style={monoStyle}>
        {COVERAGE_PROVENANCE}
      </p>

      <div style={{ marginTop: 'var(--space-3)' }}>
        <div data-grid-header="" style={gridStyle(COVERAGE_COLUMNS, true)}>
          <div style={headerCellStyle}>direction</div>
          {COVERAGE_STAGES.map((stage) => (
            <div key={stage} style={headerCellStyle}>
              {stage}
            </div>
          ))}
        </div>
        {COVERAGE_ROWS.map((row) => (
          <div
            key={row.direction}
            data-direction={row.direction}
            style={gridStyle(COVERAGE_COLUMNS, false)}
          >
            <div style={labelCellStyle}>{row.label}</div>
            {COVERAGE_STAGES.map((stage) => (
              <div key={stage} data-stage={stage} style={cellStyle}>
                {row.cells[stage]}
              </div>
            ))}
          </div>
        ))}
      </div>

      <p data-observation="" style={{ ...emptyNoteStyle, color: 'var(--text-secondary)' }}>
        {COVERAGE_OBSERVATION}
      </p>

      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(3, 1fr)',
          gap: 'var(--space-3)',
          marginTop: 'var(--space-3)',
        }}
      >
        {TIME_TO_ADD.map((tile) => (
          <div
            key={tile}
            data-time-to-add=""
            style={{
              background: 'var(--surface-sunken)',
              borderRadius: 'var(--radius-md)',
              padding: 'var(--space-3)',
              color: 'var(--text-secondary)',
              fontSize: 'var(--text-sm)',
            }}
          >
            {tile}
          </div>
        ))}
      </div>
    </Card>
  );
}

/* ------------------------------------------------------------ secondary -- */

/**
 * TICKET 042 — the by-category WER cell, joined to its row on the PAIR
 * (category × arm). A category-only lookup would silently pick whichever arm
 * was appended first, and report one arm's transcription quality under
 * another's row.
 */
function CategoryCard(props: { rows: CategoryGroupRow[]; werRows: WerCategoryRow[] }): ReactElement {
  const werByPair = new Map(props.werRows.map((row) => [`${row.category}|${row.arm}`, row]));
  // The derivation's cell, verbatim, or the absence literal when this pair has
  // no WER-bearing atom — never a zero, and never recomputed here.
  const werCell = (row: CategoryGroupRow): string =>
    werByPair.get(`${row.category}|${row.arm}`)?.cell ?? WER_NOT_MEASURED_CELL;

  return (
    <section data-card="category" style={cardStyle}>
      <div data-eyebrow="" style={eyebrowStyle}>
        {CATEGORY_EYEBROW}
      </div>
      <div style={{ marginTop: 'var(--space-3)' }}>
        <div data-grid-header="" style={gridStyle(CATEGORY_COLUMNS, true)}>
          <div style={headerCellStyle}>category</div>
          <div style={headerCellStyle}>arm</div>
          <div style={headerCellStyle}>direction</div>
          <div style={headerCellStyle}>N</div>
          <div style={headerCellStyle}>p50</div>
          <div style={headerCellStyle}>p95</div>
          <div style={headerCellStyle}>cost</div>
          <div style={headerCellStyle}>WER</div>
        </div>
        {props.rows.map((row) => (
          <div
            // TICKET 061: the DIRECTION is part of the row's identity, here as
            // well as in derive.ts. Splitting only the derivation would leave
            // two rows sharing one React key — React logs the collision and
            // then reconciles two different measurements onto one child, so the
            // pooling this ticket removes would survive in the rendered output.
            key={`${row.category}|${row.arm}|${row.direction ?? DIRECTION_ABSENT_KEY}`}
            data-category-row=""
            data-category={row.category}
            // Its own attribute, exactly as `data-n` is: the two directions have
            // to be distinguishable without parsing a concatenated text blob.
            data-direction={row.direction}
            // TICKET 032: N is the number this row exists to correct — a SAMPLE
            // count (utterances x reps), never a rep count. Exposed as its own
            // attribute so it is assertable without parsing a text blob.
            data-n={row.n}
            style={gridStyle(CATEGORY_COLUMNS, false)}
          >
            <div style={labelCellStyle}>{row.category}</div>
            <div style={cellStyle}>{armLabel(row.arm)}</div>
            {/* TICKET 061 follow-up — THE SPLIT, MADE READABLE. 061 split these
                rows on direction and showed it only in `data-direction`, so a
                mixed-direction ledger rendered two rows both reading
                "numbers-dates · Arm B" with different numbers and no on-screen
                way to tell them apart — this ticket's own complaint, one layer
                up. EN→YUE and YUE→EN are separate claims (PRD §7) and the
                asymmetry between them is the finding.
                The cell comes from the DERIVATION, exactly as `costCell` does,
                so a row whose Run recorded no direction reads `not recorded`
                and never an empty cell. */}
            <div data-category-direction="" style={cellStyle}>
              {row.directionCell}
            </div>
            <div style={cellStyle}>{row.n}</div>
            <div data-arm={row.arm} style={cellStyle}>
              {formatMs(row.p50Ms)}
            </div>
            <div style={cellStyle}>{formatMs(row.p95Ms)}</div>
            {/* TICKET 052 — the derivation renders the cell; the view never
                formats money by hand and so cannot invent a zero-dollar
                figure for a cost nobody measured. */}
            <div style={cellStyle}>{row.costCell}</div>
            <div data-category-wer="" style={cellStyle}>
              {werCell(row)}
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

function RecordingCard(props: { rows: RecordingGroupRow[] }): ReactElement {
  return (
    <section data-card="recording" style={cardStyle}>
      <div data-eyebrow="" style={eyebrowStyle}>
        {RECORDING_EYEBROW}
      </div>
      <div style={{ marginTop: 'var(--space-3)' }}>
        <div data-grid-header="" style={gridStyle(RECORDING_COLUMNS, true)}>
          <div style={headerCellStyle}>recording</div>
          <div style={headerCellStyle}>configuration</div>
          <div style={headerCellStyle}>arm</div>
          <div style={headerCellStyle}>origin</div>
          <div style={headerCellStyle}>N</div>
          <div style={headerCellStyle}>p50</div>
          <div style={headerCellStyle}>p95</div>
          <div style={headerCellStyle}>cost</div>
          <div style={headerCellStyle}>experiment status</div>
        </div>
        {props.rows.map((row) => (
          <div
            key={`${row.recordingId}|${row.configuration}`}
            data-recording-row=""
            data-recording={row.recordingId}
            data-arm={row.arm}
            data-excluded={row.excludedFromExperiments ? 'true' : 'false'}
            {...(row.failedCount > 0
              ? { 'data-failed-count': String(row.failedCount), 'data-run-count': String(row.runCount) }
              : {})}
            style={gridStyle(RECORDING_COLUMNS, false)}
          >
            <div style={labelCellStyle}>{row.recordingLabel ?? row.recordingId}</div>
            <div style={{ ...cellStyle, fontFamily: 'var(--font-mono)', fontSize: 'var(--text-xs)' }}>
              {row.configuration}
            </div>
            <div style={cellStyle}>{armLabel(row.arm)}</div>
            <div style={cellStyle}>{row.origins.join(' · ')}</div>
            <div style={cellStyle}>{row.n}</div>
            <div style={cellStyle}>{formatMs(row.p50Ms)}</div>
            <div style={cellStyle}>{formatMs(row.p95Ms)}</div>
            {/* n === 0 means nothing was measured, so there is no money to
                report: a zero cost over zero samples reads as a measurement.
                p50 / p95 already dash through formatMs's null.
                TICKET 052 — and a row WITH samples but no priced one renders
                `not measured` through the derivation's own cell. */}
            <div style={cellStyle}>{row.n === 0 ? formatUsd(null) : row.costCell}</div>
            <div style={cellStyle}>
              {row.excludedFromExperiments ? (
                <span style={{ color: 'var(--text-muted)' }}>
                  excluded
                  {row.exclusionReasons.map((reason) => (
                    <span key={reason} data-exclusion={reason}>
                      {` · ${reason}`}
                    </span>
                  ))}
                </span>
              ) : (
                <span style={{ color: 'var(--text-secondary)' }}>in experiments</span>
              )}
              {/* A failed run is absorbed into its (recording × configuration)
                  group, so without this note n = 1 over two attempts reads as
                  'one attempt, clean'. Independent of the gate: a group can be
                  both in experiments AND partially failed, and says both. */}
              {row.failedCount > 0 ? (
                <div
                  data-failure-note=""
                  style={{ color: 'var(--text-muted)', fontSize: 'var(--text-xs)' }}
                >
                  {`${row.failedCount} of ${row.runCount} attempts failed`}
                </div>
              ) : null}
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

/* ---------------------------------------------------------- empty state -- */

function EmptyState(): ReactElement {
  return (
    <div
      style={{
        ...cardStyle,
        padding: 'var(--space-12) var(--space-6)',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        textAlign: 'center',
        gap: 'var(--space-2)',
      }}
    >
      <svg
        width="26"
        height="26"
        viewBox="0 0 24 24"
        fill="none"
        stroke="var(--gray-400)"
        strokeWidth="1.5"
        strokeLinecap="round"
        aria-hidden="true"
      >
        <path d="M3 3v18h18"></path>
        <circle cx="9" cy="13" r="1.2"></circle>
        <circle cx="13" cy="9" r="1.2"></circle>
        <circle cx="17" cy="12" r="1.2"></circle>
      </svg>
      <div
        style={{
          fontWeight: 'var(--weight-semibold)',
          fontSize: 'var(--text-md)',
          marginTop: 'var(--space-1)',
        }}
      >
        {EMPTY_TITLE}
      </div>
      <p
        style={{
          color: 'var(--text-secondary)',
          fontSize: 'var(--text-sm)',
          maxWidth: 460,
          margin: 0,
        }}
      >
        {EMPTY_SUBLINE}
      </p>
      <button
        type="button"
        disabled
        title={SWEEP_DISABLED_REASON}
        style={{
          marginTop: 'var(--space-2)',
          padding: 'var(--space-2) var(--space-4)',
          borderRadius: 'var(--radius-md)',
          border: '1px solid var(--border-default)',
          background: 'var(--surface-sunken)',
          color: 'var(--text-muted)',
          fontSize: 'var(--text-sm)',
          fontWeight: 'var(--weight-medium)',
          cursor: 'not-allowed',
        }}
      >
        Run sweep
      </button>
    </div>
  );
}

/**
 * TICKET 019 — the panel body while hydration is in flight, and after it
 * failed. Deliberately the same shape as the empty state and deliberately NOT
 * the same words: the three are distinguishable to a reader, not only to a
 * test asserting on `data-results-hydration`.
 */
function HydrationNote(props: { title: string; subline: string }): ReactElement {
  return (
    <div
      style={{
        ...cardStyle,
        padding: 'var(--space-12) var(--space-6)',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        textAlign: 'center',
        gap: 'var(--space-2)',
      }}
    >
      <div style={{ fontWeight: 'var(--weight-semibold)', fontSize: 'var(--text-md)' }}>
        {props.title}
      </div>
      <p
        style={{
          color: 'var(--text-secondary)',
          fontSize: 'var(--text-sm)',
          maxWidth: 460,
          margin: 0,
        }}
      >
        {props.subline}
      </p>
    </div>
  );
}

/* ------------------------------------------------------------------ view -- */

type TabKey = 'experiments' | 'secondary';

/**
 * TICKET 019 — where the ledger's server half is, right now. `null` means the
 * host supplied no `hydrate` seam at all, and then NOTHING about this view
 * changes: no effect runs, no attribute is rendered, and a pre-019 caller is
 * byte-identical to before.
 *
 * Exported (ticket 029) because the shared predicate below now takes it: the
 * App shell has to name the same three states this view does to ask the same
 * question.
 */
export type ResultsHydrationStatus = 'loading' | 'ready' | 'failed';

/**
 * A group whose every excluded run is fixture-sourced carries no evidence at
 * all: it is a development artefact, and the view must look exactly as it does
 * with an untouched ledger.
 */
function isFixtureOnly(row: RecordingGroupRow): boolean {
  return (
    row.excludedFromExperiments &&
    row.exclusionReasons.length > 0 &&
    row.exclusionReasons.every((reason) => reason === 'fixture')
  );
}

/**
 * TICKET 025 — the ONE definition of "Results has nothing to show", exported
 * because the App shell needs the same answer: the run-provenance stamp lives
 * in the TopBar, outside this component, and a stamp over 'No runs recorded'
 * asserts a corpus version over nothing (QA F8). Two copies of this predicate
 * could drift, and the drift would be a screen claiming provenance it does not
 * have — so there is one, and the view below reads it too.
 *
 * Emptiness is decided on real content, never on record count: a ledger holding
 * nothing but fixture runs has recorded nothing.
 *
 * TICKET 029 — and it is decided on the LOAD as well as the ledger. The ledger
 * persists to localStorage, so a reload against an unreachable run store leaves
 * it populated from the previous session while this load rejects: content-only
 * said "there is evidence" while the panel below rendered "this screen has
 * nothing to show". A failed load has strictly LESS to attribute than an empty
 * one — it does not even know what it has — and an in-flight one has not
 * arrived yet, so both answer "nothing to show" whatever the cache holds.
 *
 * `hydration` is OMITTED (or `null`) by a caller with no hydration seam, and
 * then the answer is the pre-019 one: the ledger alone, with no load to wait on
 * and none that can fail.
 */
export function resultsAreEmpty(
  ledger: RunLedger,
  hydration?: ResultsHydrationStatus | null,
): boolean {
  if (hydration === 'loading' || hydration === 'failed') return true;
  return deriveLiveModel(ledger).empty && groupByRecording(ledger).every(isFixtureOnly);
}

function tabStyle(selected: boolean): CSSProperties {
  return {
    appearance: 'none',
    background: selected ? 'var(--surface-card)' : 'transparent',
    border: '1px solid',
    borderColor: selected ? 'var(--border-default)' : 'transparent',
    borderRadius: 'var(--radius-md)',
    boxShadow: selected ? 'var(--shadow-card)' : 'none',
    color: selected ? 'var(--text-body)' : 'var(--text-secondary)',
    cursor: 'pointer',
    fontFamily: 'inherit',
    fontSize: 'var(--text-sm)',
    fontWeight: 'var(--weight-medium)',
    padding: 'var(--space-2) var(--space-3)',
  };
}

export default function ResultsView(props: ResultsViewProps): ReactElement {
  const [tab, setTab] = useState<TabKey>('experiments');

  const { ledger, hydrate } = props;

  // `null` for a host with no seam — see HydrationStatus. Starts 'loading' so
  // the very first paint of a hydrating view already says so, rather than
  // flashing 'No runs recorded' for one frame before the effect runs.
  const [hydration, setHydration] = useState<ResultsHydrationStatus | null>(
    hydrate === undefined ? null : 'loading',
  );

  useEffect(() => {
    if (hydrate === undefined) return;
    let live = true;
    setHydration('loading');
    void hydrateLedger(ledger, hydrate).then(
      () => {
        // The ledger is mutated in place; this state change is what tells
        // React to re-derive from it. Same instance, no second store.
        if (live) setHydration('ready');
      },
      () => {
        // The error is deliberately not rethrown: an unreachable server is a
        // state this screen RENDERS, not a crash.
        if (live) setHydration('failed');
      },
    );
    return () => {
      live = false;
    };
  }, [ledger, hydrate]);

  const recordingRows = groupByRecording(props.ledger);
  const categoryRows = groupByCategory(props.ledger);
  const live = deriveLiveModel(props.ledger);
  // TICKET 042 — derived ONCE, here, and handed to whichever card renders it.
  const werByArm = deriveWerByArm(props.ledger);
  const werRows = deriveWerByCategory(props.ledger);

  // Emptiness is decided on real content and on the load, never on record
  // count — and by the shared predicate, so the TopBar's provenance stamp
  // cannot disagree with what this panel renders (tickets 025, 029).
  const empty = resultsAreEmpty(props.ledger, hydration);

  const exp1 = empty ? null : deriveComparison(props.ledger, 'A', 'B');
  const exp2 = empty ? null : deriveComparison(props.ledger, 'B', 'C');

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-4)' }}>
      <header>
        <h1
          style={{
            fontWeight: 'var(--weight-semibold)',
            fontSize: 'var(--text-2xl)',
            letterSpacing: 'var(--tracking-heading)',
            margin: 0,
          }}
        >
          Results
        </h1>
        <p
          style={{
            color: 'var(--text-secondary)',
            fontSize: 'var(--text-sm)',
            margin: 'var(--space-1) 0 0',
            maxWidth: 460,
          }}
        >
          {HEADER_SUBLINE}
        </p>
      </header>

      <div role="tablist" style={{ display: 'flex', gap: 'var(--space-2)' }}>
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'experiments'}
          onClick={() => setTab('experiments')}
          style={tabStyle(tab === 'experiments')}
        >
          {TAB_PRIMARY}
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'secondary'}
          onClick={() => setTab('secondary')}
          style={tabStyle(tab === 'secondary')}
        >
          {TAB_SECONDARY}
        </button>
      </div>

      {/* Exactly ONE panel is mounted: the other is unmounted, not hidden. */}
      <div
        data-results-tab={tab}
        // Rendered ONLY when a hydration seam was supplied: `undefined` makes
        // React omit the attribute entirely, which is what keeps a pre-019
        // caller's DOM byte-identical.
        data-results-hydration={hydration ?? undefined}
        role="tabpanel"
        style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-4)' }}
      >
        {hydration === 'loading' ? (
          <HydrationNote title={LOADING_TITLE} subline={LOADING_SUBLINE} />
        ) : hydration === 'failed' ? (
          <HydrationNote title={FAILED_TITLE} subline={FAILED_SUBLINE} />
        ) : empty ? (
          <EmptyState />
        ) : tab === 'experiments' ? (
          <>
            <ComparisonCard
              card="exp1"
              eyebrow={EXP1_EYEBROW}
              title={EXP1_TITLE}
              takeaway={EXP1_TAKEAWAY}
              armA="A"
              armB="B"
              model={exp1}
              sidecarWer
              werByArm={werByArm}
            />
            <ComparisonCard
              card="exp2"
              eyebrow={EXP2_EYEBROW}
              title={EXP2_TITLE}
              takeaway={EXP2_TAKEAWAY}
              armA="B"
              armB="C"
              model={exp2}
              sidecarWer={false}
              werByArm={werByArm}
            />
            <LiveCard model={live} />
            <CoverageCard />
          </>
        ) : (
          <>
            <CategoryCard rows={categoryRows} werRows={werRows} />
            <RecordingCard rows={recordingRows} />
          </>
        )}
      </div>
    </div>
  );
}
