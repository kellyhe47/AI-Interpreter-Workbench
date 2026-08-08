/**
 * Ticket 013 — Run configuration panel. Contract in ReplayView.tsx.
 *
 * The panel is a pure control surface over a RunConfig. It NEVER carries an
 * arm tag in its state: the pill is deriveArmTag(config), recomputed on every
 * render (PRD §6 quarantine). That is why the tag flips the instant a stage
 * selector moves — nothing is executed to earn it, and nothing can be typed in
 * to claim it. There is no control here, or anywhere else in the product, that
 * sets a tag: the pill is a READOUT.
 *
 * REALTIME HIDES THE STAGE SELECTORS rather than disabling them. A
 * speech-to-speech run has no STT/MT/TTS stages to choose, so a greyed-out
 * triple would imply the choice exists and is merely unavailable. The stored
 * triple survives the switch, so coming back to Cascade restores it intact.
 *
 * THE PINNED CONTROLS ARE STATED, NOT OFFERED. Replay conversation context is
 * pinned to zero — every Run of a Recording must see the same input, and a
 * carried-over context would make run 2 a different measurement from run 1 —
 * so it renders as a locked field with no operable element inside it, not as a
 * disabled select, which would read as a knob someone could unlock.
 *
 * Ticket 024 — A CONTROL THAT CANNOT ACT DOES NOT LOOK ACTIONABLE (PRD §17
 * 25c, the pattern Results' 'Run sweep' already models). Both actions need a
 * Recording to act ON, so with none selected they carry the real `disabled`
 * attribute plus a title naming the missing precondition, rather than
 * accepting a click and doing nothing — silent inaction reads as a broken
 * button.
 *
 * Ticket 044 — THE SAME PRINCIPLE, A SECOND REASON. There are now two facts
 * that make an action unable to act: no Recording to act on, and a request of
 * that kind ALREADY IN FLIGHT. Disabling during flight APPLIES 024 rather than
 * overturning it — a Replay run is billable, and an enabled button that
 * silently swallows the click is precisely the failure 024 was written
 * against. The two reasons stay distinguishable in the `title`: the
 * no-selection explanation always WINS, so it is never replaced by a busy one.
 * The in-flight state is also said out loud, as [data-run-inflight] — a
 * readout beside the button, never a control.
 */

import type { CSSProperties, ReactElement } from 'react';
import type { Mode } from '../../../core/timing';
import { MENUS, armLabel, deriveArmTag, type ProviderTriple } from '../../../core/arms';

export interface ReplayConfigState {
  architecture: Mode;
  realtimeModel: string;
  providers: ProviderTriple;
}

export interface RunConfigPanelProps {
  /** Label of the selected Recording, or null when none is selected. */
  recordingLabel: string | null;
  config: ReplayConfigState;
  onConfigChange: (next: ReplayConfigState) => void;
  onRun: () => void;
  onBatchSweep: () => void;
  /** Rendered inside the panel while a sweep is in flight. */
  batchProgress?: ReactElement | null;
  /**
   * Ticket 044 — a MANUAL run this panel started is still out. A sweep is not
   * a manual run, so this stays false for the whole of one: BatchProgress is
   * the sweep's sole indication, and two panels claiming different things
   * about what is executing is the contradiction the ticket forbids.
   */
  runInFlight?: boolean;
  /** Ticket 044 — a sweep is out. Its indication is `batchProgress`. */
  sweepInFlight?: boolean;
}

/* ------------------------------------------------------------------ copy -- */

const TITLE = 'Run configuration';
const NO_SELECTION = 'select a Recording to run against';

/** Why the actions are inert: the missing precondition, not a missing handler. */
const NO_SELECTION_HINT = 'Select a Recording in the library to run against';

/**
 * Ticket 044 — the visible in-flight indication. It names the PACING because
 * that is the honest explanation of the wait: a Replay run plays the clip at
 * 1×, so nothing is stuck, and a ≤45 s corpus take takes about 45 s.
 */
const RUN_INFLIGHT_NOTE =
  'Running — the clip is playing at 1×, so this takes about as long as the Recording.';

/** Why Run cannot act right now: the previous run, never the selection. */
const RUN_BUSY_HINT = 'A run is already in flight — the clip is playing at 1×';

/** Why Batch sweep cannot act right now. */
const BATCH_BUSY_HINT = 'A batch sweep is already in flight';

const REALTIME = 'Realtime';
const CASCADE = 'Cascade';

const RUN = 'Run';
const BATCH_SWEEP = 'Batch sweep…';

const CONTEXT_LABEL = 'replay context';
/** Says the quantity in words: a locked field, never an empty control. */
const CONTEXT_VALUE = 'zero turns · locked';

const PINNED_NOTE =
  'context pinned to zero in Replay · voice pinned per vendor · replay paced at 1× · ' +
  'manual runs are explorable but never aggregated into experiments';

const STAGES = ['stt', 'mt', 'tts'] as const;

/* ---------------------------------------------------------------- styles -- */

const panelStyle: CSSProperties = {
  background: 'var(--surface-card)',
  border: '1px solid var(--border-default)',
  borderRadius: 'var(--radius-lg)',
  boxShadow: 'var(--shadow-card)',
  padding: 'var(--space-4) var(--space-5)',
  display: 'flex',
  flexDirection: 'column',
  gap: 'var(--space-3)',
};

const rowStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 'var(--space-3)',
  flexWrap: 'wrap',
};

const fieldLabelStyle: CSSProperties = {
  fontSize: 'var(--text-xs)',
  fontWeight: 'var(--weight-medium)',
  color: 'var(--text-muted)',
  textTransform: 'uppercase',
  letterSpacing: '.05em',
};

const selectStyle: CSSProperties = {
  font: 'inherit',
  fontSize: 'var(--text-sm)',
  color: 'var(--text-body)',
  background: 'var(--surface-card)',
  border: '1px solid var(--border-default)',
  borderRadius: 'var(--radius-md)',
  padding: 'var(--space-1) var(--space-2)',
};

const lockedFieldStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 'var(--space-1)',
  background: 'var(--surface-sunken)',
  borderRadius: 'var(--radius-md)',
  padding: 'var(--space-2) var(--space-3)',
  color: 'var(--text-secondary)',
  fontSize: 'var(--text-sm)',
};

/** The in-flight readout: stated in the panel's own vocabulary, not shouted. */
const inflightNoteStyle: CSSProperties = {
  display: 'block',
  background: 'var(--surface-sunken)',
  borderRadius: 'var(--radius-md)',
  padding: 'var(--space-2) var(--space-3)',
  color: 'var(--text-secondary)',
  fontSize: 'var(--text-sm)',
  lineHeight: 'var(--leading-normal)',
};

const noteStyle: CSSProperties = {
  color: 'var(--text-muted)',
  fontSize: 'var(--text-xs)',
  lineHeight: 'var(--leading-normal)',
};

function toggleButtonStyle(active: boolean): CSSProperties {
  return {
    appearance: 'none',
    border: 'none',
    borderRight: '1px solid var(--border-default)',
    background: active ? 'var(--surface-selected)' : 'var(--surface-card)',
    color: active ? 'var(--text-body)' : 'var(--text-secondary)',
    fontFamily: 'inherit',
    fontSize: 'var(--text-sm)',
    fontWeight: 'var(--weight-medium)',
    padding: 'var(--space-2) var(--space-3)',
    cursor: 'pointer',
  };
}

function actionButtonStyle(primary: boolean, disabled: boolean): CSSProperties {
  return {
    appearance: 'none',
    border:
      primary && !disabled ? '1px solid var(--btn-primary-bg)' : '1px solid var(--border-default)',
    borderRadius: 'var(--radius-md)',
    // Disabled reads as muted-on-sunken — the same vocabulary the rest of the
    // shell uses for an inert control. The `disabled` attribute, not the look,
    // is what actually stops a click reaching an executor seam.
    background: disabled
      ? 'var(--surface-sunken)'
      : primary
        ? 'var(--btn-primary-bg)'
        : 'var(--surface-card)',
    color: disabled ? 'var(--text-muted)' : primary ? 'var(--text-inverse)' : 'var(--text-body)',
    fontFamily: 'inherit',
    fontSize: 'var(--text-sm)',
    fontWeight: 'var(--weight-medium)',
    padding: 'var(--space-2) var(--space-4)',
    cursor: disabled ? 'not-allowed' : 'pointer',
  };
}

/** Accent for a named arm, gray for ad-hoc — by derivation, never by choice. */
function tagPillStyle(named: boolean): CSSProperties {
  return {
    display: 'inline-block',
    borderRadius: 'var(--radius-pill)',
    padding: 'var(--space-1) var(--space-3)',
    fontSize: 'var(--text-xs)',
    fontWeight: 'var(--weight-medium)',
    background: named ? 'var(--accent-soft)' : 'var(--surface-sunken)',
    color: named ? 'var(--accent-strong)' : 'var(--text-secondary)',
  };
}

/* ------------------------------------------------------------ component -- */

export default function RunConfigPanel(props: RunConfigPanelProps): ReactElement {
  const { config } = props;

  /** No Recording to act on — the precondition both actions need (ticket 024). */
  const noSelection = props.recordingLabel === null;

  /* Ticket 044 — the second reason either action cannot act. The no-selection
     reason is checked FIRST everywhere below, so 024's explanation always
     wins and is never quietly replaced by a busy one. */
  const runInFlight = props.runInFlight === true;
  const sweepInFlight = props.sweepInFlight === true;

  const runDisabled = noSelection || runInFlight;
  const sweepDisabled = noSelection || sweepInFlight;

  const runHint = noSelection ? NO_SELECTION_HINT : runInFlight ? RUN_BUSY_HINT : undefined;
  const sweepHint = noSelection ? NO_SELECTION_HINT : sweepInFlight ? BATCH_BUSY_HINT : undefined;

  // The single source of truth for membership, read fresh on every render.
  const tag = deriveArmTag({
    architecture: config.architecture,
    realtimeModel: config.realtimeModel,
    providers: config.providers,
  });

  const setArchitecture = (architecture: Mode): void => {
    props.onConfigChange({ ...config, architecture });
  };

  const setStage = (stage: (typeof STAGES)[number], model: string): void => {
    props.onConfigChange({ ...config, providers: { ...config.providers, [stage]: model } });
  };

  return (
    <div data-run-config-panel="" style={panelStyle}>
      <div style={rowStyle}>
        <span style={{ fontWeight: 'var(--weight-semibold)', fontSize: 'var(--text-base)' }}>
          {TITLE}
        </span>
        <span style={{ color: 'var(--text-muted)', fontSize: 'var(--text-sm)' }}>
          {noSelection ? NO_SELECTION : `against “${props.recordingLabel}”`}
        </span>
        {/* A READOUT: not a button, and holding no control. */}
        <span data-derived-tag={tag} style={{ marginLeft: 'auto', ...tagPillStyle(tag !== 'ad-hoc') }}>
          {`derived tag: ${armLabel(tag)}`}
        </span>
      </div>

      <div style={rowStyle}>
        <div
          style={{
            display: 'flex',
            border: '1px solid var(--border-default)',
            borderRadius: 'var(--radius-md)',
            overflow: 'hidden',
          }}
        >
          <button
            type="button"
            aria-pressed={config.architecture === 'realtime'}
            onClick={() => setArchitecture('realtime')}
            style={toggleButtonStyle(config.architecture === 'realtime')}
          >
            {REALTIME}
          </button>
          <button
            type="button"
            aria-pressed={config.architecture === 'cascade'}
            onClick={() => setArchitecture('cascade')}
            style={{ ...toggleButtonStyle(config.architecture === 'cascade'), borderRight: 'none' }}
          >
            {CASCADE}
          </button>
        </div>

        {/* Realtime has no stages to choose, so it offers no selector at all. */}
        {config.architecture === 'cascade'
          ? STAGES.map((stage) => (
              <div
                key={stage}
                style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-1)' }}
              >
                <span style={fieldLabelStyle}>{stage}</span>
                <select
                  data-stage-select={stage}
                  aria-label={stage}
                  value={config.providers[stage]}
                  onChange={(event) => setStage(stage, event.target.value)}
                  style={selectStyle}
                >
                  {MENUS[stage].map((model) => (
                    <option key={model} value={model}>
                      {model}
                    </option>
                  ))}
                </select>
              </div>
            ))
          : null}

        <div data-replay-context="" data-locked="true" style={lockedFieldStyle}>
          <span style={fieldLabelStyle}>{CONTEXT_LABEL}</span>
          <span style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--text-xs)' }}>
            {CONTEXT_VALUE}
          </span>
        </div>
      </div>

      <div
        style={{
          ...rowStyle,
          borderTop: '1px solid var(--border-default)',
          paddingTop: 'var(--space-3)',
        }}
      >
        {/* Two gates, two explanations (tickets 024 + 044): no Recording to
            act on, or a request of that kind already in flight. */}
        <button
          type="button"
          data-run-button=""
          onClick={props.onRun}
          disabled={runDisabled}
          title={runHint}
          style={actionButtonStyle(true, runDisabled)}
        >
          {RUN}
        </button>
        <button
          type="button"
          data-batch-button=""
          onClick={props.onBatchSweep}
          disabled={sweepDisabled}
          title={sweepHint}
          style={actionButtonStyle(false, sweepDisabled)}
        >
          {BATCH_SWEEP}
        </button>
        <span data-pinned-note="" style={{ ...noteStyle, flex: 1, minWidth: 240 }}>
          {PINNED_NOTE}
        </span>
      </div>

      {/* A READOUT of what is happening, holding no control of its own. */}
      {runInFlight ? (
        <span data-run-inflight="" style={inflightNoteStyle}>
          {RUN_INFLIGHT_NOTE}
        </span>
      ) : null}

      {props.batchProgress ?? null}
    </div>
  );
}
