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
}

/* ------------------------------------------------------------------ copy -- */

const TITLE = 'Run configuration';
const NO_SELECTION = 'select a Recording to run against';

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

function actionButtonStyle(primary: boolean): CSSProperties {
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
          {props.recordingLabel === null ? NO_SELECTION : `against “${props.recordingLabel}”`}
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
        <button type="button" onClick={props.onRun} style={actionButtonStyle(true)}>
          {RUN}
        </button>
        <button type="button" onClick={props.onBatchSweep} style={actionButtonStyle(false)}>
          {BATCH_SWEEP}
        </button>
        <span data-pinned-note="" style={{ ...noteStyle, flex: 1, minWidth: 240 }}>
          {PINNED_NOTE}
        </span>
      </div>

      {props.batchProgress ?? null}
    </div>
  );
}
