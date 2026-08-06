/**
 * Ticket 013 — Batch sweep progress. Contract in ReplayView.tsx.
 *
 * IT NEVER FABRICATES AN ESTIMATE IT DOES NOT HAVE. The batch runner reports
 * `estimatedRemainingMs: null` until a run has settled and there is a sample to
 * extrapolate from; this panel renders that absence as an absence. A synthetic
 * "about an hour" on a sweep the operator is deciding whether to leave running
 * unattended is worse than no number at all.
 *
 * THE POSITION IS THE MATRIX POSITION, not a percentage. `runIndex` is 1-based
 * among MEASURED runs and 0 for a warmup, and `totalRuns` excludes warmups, so
 * the ratio can never overshoot and the operator can see exactly which
 * recording × configuration × repetition is in flight.
 *
 * CANCEL KEEPS COMPLETED RUNS. The control says so, because the fear it has to
 * answer is losing forty minutes of good runs by stopping at minute forty-one.
 */

import type { CSSProperties, ReactElement } from 'react';
import type { BatchConfiguration, BatchProgress as BatchProgressEvent } from '../../batch/runner';

export interface BatchProgressProps {
  /** Latest progress event, or null before the first one arrives. */
  progress: BatchProgressEvent | null;
  /** The sweep's matrix, so a configId can be shown by its label. */
  configurations: BatchConfiguration[];
  /** Retained reps per cell — the denominator of 'rep 3/5'. */
  reps: number;
  onCancel: () => void;
}

/* ------------------------------------------------------------------ copy -- */

const TITLE = 'Batch sweep running';
const WAITING = 'starting — no run has been dispatched yet';

const CONTROLS_NOTE =
  'counterbalanced order · first run per configuration discarded as warmup · ' +
  'failures retried once, then the batch continues · origin: sweep';

const CANCEL = 'Cancel — keep completed runs';

/** The honest reading of an estimate the runner has not produced yet. */
const NO_ESTIMATE = '—';

/* ---------------------------------------------------------------- format -- */

/** M:SS with unpadded minutes — the sweep clock. */
function formatClock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

/* ---------------------------------------------------------------- styles -- */

const panelStyle: CSSProperties = {
  background: 'var(--surface-sunken)',
  borderRadius: 'var(--radius-md)',
  padding: 'var(--space-3)',
  display: 'flex',
  flexDirection: 'column',
  gap: 'var(--space-2)',
};

const monoStyle: CSSProperties = {
  fontFamily: 'var(--font-mono)',
  fontSize: 'var(--text-xs)',
  color: 'var(--text-secondary)',
};

const trackStyle: CSSProperties = {
  display: 'block',
  height: 5,
  background: 'var(--gray-200)',
  borderRadius: 'var(--radius-pill)',
  overflow: 'hidden',
};

const cancelButtonStyle: CSSProperties = {
  marginLeft: 'auto',
  border: '1px solid var(--border-default)',
  borderRadius: 'var(--radius-md)',
  background: 'var(--surface-card)',
  color: 'var(--text-body)',
  fontFamily: 'inherit',
  fontSize: 'var(--text-xs)',
  fontWeight: 'var(--weight-medium)',
  padding: 'var(--space-1) var(--space-3)',
  cursor: 'pointer',
};

/* ------------------------------------------------------------ component -- */

export default function BatchProgressPanel(props: BatchProgressProps): ReactElement {
  const { progress } = props;
  const configuration =
    progress === null
      ? undefined
      : props.configurations.find((entry) => entry.id === progress.configId);
  const configurationName =
    configuration === undefined ? (progress?.configId ?? '') : (configuration.label ?? configuration.id);

  const fraction =
    progress === null || progress.totalRuns <= 0
      ? 0
      : Math.min(100, Math.max(0, (progress.runIndex / progress.totalRuns) * 100));

  return (
    <div data-batch-progress="" style={panelStyle}>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 'var(--space-2)',
          flexWrap: 'wrap',
          fontSize: 'var(--text-sm)',
          color: 'var(--text-secondary)',
        }}
      >
        <span style={{ fontWeight: 'var(--weight-semibold)', color: 'var(--text-body)' }}>
          {TITLE}
        </span>
        {progress === null ? (
          <span style={{ color: 'var(--text-muted)', fontSize: 'var(--text-xs)' }}>{WAITING}</span>
        ) : (
          <>
            <span data-batch-position="" style={monoStyle}>
              {`run ${progress.runIndex} of ${progress.totalRuns} · ` +
                `${progress.recordingId} × ${configurationName} · ` +
                `rep ${progress.repIndex}/${props.reps}`}
            </span>
            <span data-batch-clock="" style={{ ...monoStyle, marginLeft: 'auto' }}>
              {`elapsed ${formatClock(progress.elapsedMs)} · est. remaining ` +
                (progress.estimatedRemainingMs === null
                  ? NO_ESTIMATE
                  : formatClock(progress.estimatedRemainingMs))}
            </span>
          </>
        )}
      </div>

      {progress === null ? null : (
        <span
          data-batch-bar=""
          role="progressbar"
          aria-valuenow={progress.runIndex}
          aria-valuemin={0}
          aria-valuemax={progress.totalRuns}
          style={trackStyle}
        >
          <i
            style={{
              display: 'block',
              height: 5,
              width: `${fraction}%`,
              borderRadius: 'var(--radius-pill)',
              background: 'var(--accent)',
            }}
          />
        </span>
      )}

      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 'var(--space-2)',
          flexWrap: 'wrap',
          fontSize: 'var(--text-xs)',
          color: 'var(--text-muted)',
        }}
      >
        <span data-batch-controls-note="">{CONTROLS_NOTE}</span>
        <button type="button" onClick={props.onCancel} style={cancelButtonStyle}>
          {CANCEL}
        </button>
      </div>
    </div>
  );
}
