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
 *
 * TICKET 067 — THE CLOCK TICKS, AND A TICK IS NOT A MEASUREMENT.
 *
 * `elapsedMs` / `estimatedRemainingMs` are fields on the progress event, and the
 * runner emits only at run boundaries. Replay is paced at 1×, so a one-recording
 * sweep is twelve executions over six to eight minutes and the clock advanced
 * about twelve times — between them the panel showed a stale snapshot, which is
 * indistinguishable from a hung sweep. The operator refreshed, and because the
 * batch runner is client-side the refresh killed the sweep.
 *
 * So the panel INTERPOLATES between measurements, through the injected
 * `SweepClock` and nothing else: no `setInterval`, no `Date.now`, both forbidden
 * here by a source scan because jsdom supplies them and a direct reach would
 * pass every behavioural test while leaking a timer past this panel's unmount.
 *
 * AND THE MEASUREMENT ALWAYS WINS. Every progress event RE-ANCHORS both figures
 * to the runner's own numbers — including an event whose elapsed is LOWER than
 * what the ticking accumulated. There is no monotonic guard and no `Math.max`:
 * a wrong number is worse than a stale one, and the runner is the only thing
 * here that has measured anything.
 *
 * The interpolation is computed HERE rather than in ReplayView because this is
 * the only component that renders the figure, because ticking a second hand in
 * the view would re-render the whole Replay screen once a second for a fact
 * only this cell shows, and because the subscription's lifetime is then exactly
 * this panel's mount — which ReplayView already ends on all three paths (the
 * sweep completing, cancel settling, the view unmounting).
 */

import { useEffect, useState, type CSSProperties, type ReactElement } from 'react';
import type { BatchConfiguration, BatchProgress as BatchProgressEvent } from '../../batch/runner';

/** TICKET 067 — where the sweep clock's ticks come from. */
export interface SweepClock {
  /** Wall clock in ms — the SAME units as `BatchProgress.elapsedMs`. */
  now: () => number;
  /**
   * Calls `onTick` while a sweep is in flight (production: about 1 Hz).
   * Returns the teardown, which MUST be called when the sweep ends, is
   * cancelled, or the panel unmounts.
   */
  subscribe: (onTick: () => void) => () => void;
}

export interface BatchProgressProps {
  /** Latest progress event, or null before the first one arrives. */
  progress: BatchProgressEvent | null;
  /** The sweep's matrix, so a configId can be shown by its label. */
  configurations: BatchConfiguration[];
  /** Retained reps per cell — the denominator of 'rep 3/5'. */
  reps: number;
  /**
   * TICKET 067 — the tick source, OPTIONAL. A host that supplies none gets
   * exactly the pre-067 panel: the last measurement, held until the next one.
   * Nothing is fabricated in its absence.
   */
  sweepClock?: SweepClock;
  onCancel: () => void;
}

/**
 * The measurement the interpolation runs FROM, and the clock reading it landed
 * at. `measurement` is held by IDENTITY: while it is not the event currently on
 * the props the anchor is stale, and a stale anchor interpolates nothing — the
 * render falls back to the measurement itself, never to a figure derived from a
 * previous one.
 */
interface Anchor {
  measurement: BatchProgressEvent;
  atMs: number;
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

/**
 * TICKET 067 — the honest reading once the countdown is SPENT and the sweep is
 * still running. `0:00` would claim the sweep ends this second and a negative
 * clock would claim it ended already; both are inferences dressed as
 * measurements. This says only what is known: the last estimate has run out.
 */
const FINISHING = 'finishing';

/* ---------------------------------------------------------------- format -- */

/** M:SS with unpadded minutes — the sweep clock. */
function formatClock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

/**
 * The countdown, `sinceMeasuredMs` after the runner last measured it.
 *
 * THREE READINGS, and which one applies is decided by what has been MEASURED:
 *
 * - `null` estimate → `—`. No run has settled, so there is no throughput to
 *   extrapolate from and no countdown is invented before there is one. It stays
 *   an absence however long the panel ticks (ticket 013's rule, unmoved).
 * - `sinceMeasuredMs === 0` → the runner's own figure, formatted verbatim.
 *   A MEASURED `0:00` is a measurement and stays one.
 * - otherwise the interpolation, and once it has less than a whole second left
 *   to show it stops claiming a figure and reads `finishing`. The `< 1000` (not
 *   `<= 0`) is the same rule as the sign guard: `formatClock` would print
 *   `0:00` for anything under a second, which is exactly the fabricated
 *   precision this is here to refuse.
 */
function formatRemaining(estimatedRemainingMs: number | null, sinceMeasuredMs: number): string {
  if (estimatedRemainingMs === null) return NO_ESTIMATE;
  if (sinceMeasuredMs === 0) return formatClock(estimatedRemainingMs);
  const remaining = estimatedRemainingMs - sinceMeasuredMs;
  return remaining < 1_000 ? FINISHING : formatClock(remaining);
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
  const { progress, sweepClock } = props;

  /**
   * TICKET 067 — the interpolation's two pieces of state.
   *
   * `anchor` is the last MEASUREMENT and the clock reading it arrived at;
   * `nowMs` is the seam's latest reading. Both are set from `sweepClock.now()`
   * and nothing else, so the anchor and the tick cannot drift against each
   * other — which is why `now` lives on the seam rather than being a second
   * clock the host wires separately.
   */
  const [anchor, setAnchor] = useState<Anchor | null>(null);
  const [nowMs, setNowMs] = useState(0);

  /**
   * RE-ANCHOR ON EVERY EVENT. Keyed on the event's identity, so each emission
   * resets the interpolation to the runner's figures whichever direction they
   * moved — an event measuring LESS elapsed than the ticking accumulated wins
   * just as completely as one measuring more.
   */
  useEffect(() => {
    if (sweepClock === undefined || progress === null) return;
    const atMs = sweepClock.now();
    setAnchor({ measurement: progress, atMs });
    setNowMs(atMs);
  }, [progress, sweepClock]);

  /**
   * THE TICK, and its teardown. The subscription lives exactly as long as this
   * panel does, and ReplayView unmounts the panel when the sweep completes,
   * when a cancel settles, and when the view itself goes — so all three of
   * AC6's paths are this one cleanup.
   */
  useEffect(() => {
    if (sweepClock === undefined) return undefined;
    return sweepClock.subscribe(() => setNowMs(sweepClock.now()));
  }, [sweepClock]);

  /**
   * How long since the runner last measured — 0 whenever there is no live
   * anchor for the event on screen, which renders the measurement untouched.
   * Clamped at 0 because a clock that went backwards is not evidence that a
   * sweep un-ran.
   */
  const sinceMeasuredMs =
    anchor !== null && anchor.measurement === progress ? Math.max(0, nowMs - anchor.atMs) : 0;

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
            {/* The CLOCK is the only thing a tick moves. The position line
                above and the bar below are per-run facts the runner measured;
                interpolating either would be inventing a run that has not
                happened. */}
            <span data-batch-clock="" style={{ ...monoStyle, marginLeft: 'auto' }}>
              {`elapsed ${formatClock(progress.elapsedMs + sinceMeasuredMs)} · est. remaining ` +
                formatRemaining(progress.estimatedRemainingMs, sinceMeasuredMs)}
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
