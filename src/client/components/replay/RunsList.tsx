/**
 * Ticket 013 — Runs of the selected Recording. Contract in ReplayView.tsx.
 *
 * NOTHING AUTOPLAYS (PRD §7). Rendering a card constructs no AudioContext,
 * fetches no audio and mounts no media element: the play control calls
 * `onPlay(runId)` and that is the only path to sound. A list that warmed up its
 * audio on render would turn "measure, then listen" into "listen, then
 * measure", and on a long runs list it would fetch megabytes nobody asked for.
 *
 * THE ARM TAG IS DERIVED, NOT READ OFF THE RECORD. Every card tags itself with
 * runArmTag(run) — the ledger's derivation over the run's recipe fields — so a
 * Run whose stored `armTag` disagrees with its configuration renders under the
 * tag its configuration actually earns.
 *
 * $/min IS NORMALIZED, NEVER COPIED. run.cost is what the run cost; the
 * comparable figure is cost per minute of source audio, so the card divides by
 * the Recording's duration. Runs over clips of different lengths are otherwise
 * not comparable at all.
 *
 * A FAILED RUN IS INFORMATION, NOT AN ERROR STATE. It stays in the list, names
 * the stage that was lost, states its exclusion, and shows no stage figures,
 * because it produced none.
 *
 * TICKET 045 — THE PLAY CONTROL IS GATED ON `outputAudioPath`, NOT ON STATUS.
 * Ticket 013 offered it on every complete run, which was a proxy for "has
 * audio" and is wrong in both directions: a complete Arm A run stores no output
 * audio at all (ticket 046) and its play button answered 404, while a run that
 * lost a stage AFTER synthesizing some output keeps partial audio that is
 * diagnostic. A control that cannot act must not look actionable (024, 044), so
 * a card with no stored audio says so instead of offering the button.
 */

import type { CSSProperties, ReactElement } from 'react';
import { armLabel } from '../../../core/arms';
import {
  deriveCascadeIntervals,
  deriveRealtimeIntervals,
  type CascadeTimestamps,
  type RealtimeTimestamps,
} from '../../../core/timing';
import { runArmTag, type Recording, type Run } from '../../state/ledger';

export interface RunsListProps {
  /** The Recording these Runs replayed — its duration normalizes $/min. */
  recording: Recording | null;
  runs: Run[];
  /** On-demand playback. Called on click, never on render. */
  onPlay: (runId: string) => void;
}

/* ------------------------------------------------------------------ copy -- */

const TITLE = 'Runs';
const SUBLINE = 'identical input — directly comparable';
const EMPTY = 'No Runs of this Recording yet.';

const PLAY = 'play';
/** What a card says in place of a play control it could not honour. */
const NO_AUDIO = 'no output audio stored';

/** The tail every failed card ends with, whatever stage was lost. */
const FAILURE_TAIL = '— run saved as failed, excluded from every aggregate';
const FAILURE_FALLBACK = 'a stage did not complete for this utterance';
const UNKNOWN_STAGE = 'unknown';

const MS_PER_MINUTE = 60_000;
const ABSENT = '—';

/* ---------------------------------------------------------------- format -- */

const formatMs = (value: number | null): string => (value === null ? ABSENT : `${value} ms`);

/**
 * Cost per minute of source audio. Without a Recording (or with a zero-length
 * one) there is no denominator, and an unnormalized figure would silently
 * compare a 30-second clip against a 60-second one.
 */
function formatPerMinute(cost: number, recording: Recording | null): string {
  if (recording === null || recording.durationMs <= 0) return ABSENT;
  const minutes = recording.durationMs / MS_PER_MINUTE;
  return `$${(cost / minutes).toFixed(3)}/min`;
}

/** run.timings stores absent marks as null; the interval helpers want gaps. */
function marks(timings: Record<string, number | null>): Record<string, number | undefined> {
  const out: Record<string, number | undefined> = {};
  for (const [key, value] of Object.entries(timings)) {
    if (typeof value === 'number') out[key] = value;
  }
  return out;
}

interface StageCell {
  label: string;
  ms: number | null;
}

/** The named intervals of a run, in pipeline order, plus its end-to-end. */
function stagesOf(run: Run): { cells: StageCell[]; total: number | null } {
  const timestamps = marks(run.timings);
  if (run.architecture === 'realtime') {
    const intervals = deriveRealtimeIntervals(timestamps as RealtimeTimestamps);
    return {
      cells: [
        { label: 'endpointing', ms: intervals.endpointing },
        { label: 'model', ms: intervals.model },
        { label: 'queue', ms: intervals.queue },
      ],
      total: intervals.endToEnd,
    };
  }
  const intervals = deriveCascadeIntervals(timestamps as CascadeTimestamps);
  return {
    cells: [
      { label: 'endpointing', ms: intervals.endpointing },
      { label: 'stt', ms: intervals.stt },
      { label: 'mt', ms: intervals.mt },
      { label: 'tts', ms: intervals.tts },
      { label: 'queue', ms: intervals.queue },
    ],
    total: intervals.endToEnd,
  };
}

/**
 * The stage a failed run lost, taken from the error it recorded
 * ('tts: stage timed out …'). A failure with no stage prefix is reported as
 * unknown rather than attributed to a stage that may not be at fault.
 */
function failureOf(run: Run): { stage: string; text: string } {
  const first = run.errors[0] ?? '';
  const separator = first.indexOf(':');
  const stage = separator > 0 ? first.slice(0, separator).trim() : '';
  const detail = separator > 0 ? first.slice(separator + 1).trim() : first.trim();
  const body = detail.length > 0 ? detail : FAILURE_FALLBACK;
  return {
    stage: stage.length > 0 ? stage : UNKNOWN_STAGE,
    text: stage.length > 0 ? `${stage} ${body} ${FAILURE_TAIL}` : `${body} ${FAILURE_TAIL}`,
  };
}

/** The configuration a run actually executed, from its model snapshots. */
function configOf(run: Run): string {
  const architecture = run.architecture === 'realtime' ? 'Realtime' : 'Cascade';
  const models = Object.values(run.modelSnapshots);
  return models.length === 0 ? architecture : `${architecture} · ${models.join(' → ')}`;
}

/** Sweep runs carry a repetition index; manual runs do not. */
function repIndexOf(run: Run): number | undefined {
  return run.annotations?.repIndex;
}

function metaOf(run: Run): string {
  const parts = [`origin ${run.origin}`];
  const rep = repIndexOf(run);
  if (rep !== undefined) parts.push(`rep ${rep}`);
  parts.push(`run ${run.id}`);
  return parts.join(' · ');
}

/* ---------------------------------------------------------------- styles -- */

const cardStyle: CSSProperties = {
  background: 'var(--surface-card)',
  border: '1px solid var(--border-default)',
  borderRadius: 'var(--radius-lg)',
  boxShadow: 'var(--shadow-card)',
  padding: 'var(--space-3) var(--space-4)',
  display: 'flex',
  flexDirection: 'column',
  gap: 'var(--space-2)',
};

const headRowStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 'var(--space-2)',
  flexWrap: 'wrap',
};

const monoStyle: CSSProperties = {
  fontFamily: 'var(--font-mono)',
  fontSize: 'var(--text-xs)',
  color: 'var(--text-muted)',
};

const figureStyle: CSSProperties = {
  fontFamily: 'var(--font-mono)',
  fontWeight: 'var(--weight-semibold)',
  color: 'var(--text-body)',
};

const playButtonStyle: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 'var(--space-2)',
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

const failureStyle: CSSProperties = {
  background: 'var(--negative-soft)',
  color: 'var(--negative)',
  borderRadius: 'var(--radius-md)',
  padding: 'var(--space-2) var(--space-3)',
  fontSize: 'var(--text-sm)',
};

function armPillStyle(named: boolean): CSSProperties {
  return {
    display: 'inline-block',
    borderRadius: 'var(--radius-pill)',
    padding: '0 var(--space-2)',
    fontSize: 'var(--text-xs)',
    fontWeight: 'var(--weight-medium)',
    background: named ? 'var(--accent-soft)' : 'var(--surface-sunken)',
    color: named ? 'var(--accent-strong)' : 'var(--text-secondary)',
  };
}

function statusPillStyle(failed: boolean): CSSProperties {
  return {
    display: 'inline-block',
    borderRadius: 'var(--radius-pill)',
    padding: '0 var(--space-2)',
    fontSize: 'var(--text-xs)',
    fontWeight: 'var(--weight-medium)',
    background: failed ? 'var(--negative-soft)' : 'var(--positive-soft)',
    color: failed ? 'var(--negative)' : 'var(--positive)',
  };
}

function PlayGlyph(): ReactElement {
  return (
    <svg width={12} height={12} viewBox="0 0 24 24" fill="currentColor" aria-hidden>
      <path d="M7 5.5v13a1 1 0 0 0 1.54.84l10-6.5a1 1 0 0 0 0-1.68l-10-6.5A1 1 0 0 0 7 5.5z" />
    </svg>
  );
}

/* ------------------------------------------------------------ component -- */

export default function RunsList(props: RunsListProps): ReactElement {
  return (
    <div
      data-runs-list=""
      style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-3)' }}
    >
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 'var(--space-2)' }}>
        <span style={{ fontWeight: 'var(--weight-semibold)', fontSize: 'var(--text-base)' }}>
          {props.recording === null ? TITLE : `Runs of “${props.recording.label}”`}
        </span>
        <span style={{ color: 'var(--text-muted)', fontSize: 'var(--text-sm)' }}>{SUBLINE}</span>
      </div>

      {props.runs.length === 0 ? (
        <div style={{ color: 'var(--text-muted)', fontSize: 'var(--text-sm)' }}>{EMPTY}</div>
      ) : null}

      {props.runs.map((run) => {
        const tag = runArmTag(run);
        const failed = run.status === 'failed';
        // TICKET 045 — stored audio, not status, decides the play control.
        const hasAudio = run.outputAudioPath !== undefined;
        const { cells, total } = stagesOf(run);
        const failure = failed ? failureOf(run) : null;

        return (
          <div
            key={run.id}
            data-run-card=""
            data-run={run.id}
            data-arm={tag}
            data-status={run.status}
            style={cardStyle}
          >
            <div style={headRowStyle}>
              <span data-run-arm-pill="" style={armPillStyle(tag !== 'ad-hoc')}>
                {armLabel(tag)}
              </span>
              <span
                data-run-config=""
                style={{ fontWeight: 'var(--weight-semibold)', fontSize: 'var(--text-sm)' }}
              >
                {configOf(run)}
              </span>
              <span data-run-meta="" data-mono="" style={monoStyle}>
                {metaOf(run)}
              </span>
              <span data-run-status="" style={statusPillStyle(failed)}>
                {run.status}
              </span>
            </div>

            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 'var(--space-4)',
                flexWrap: 'wrap',
                fontSize: 'var(--text-sm)',
                color: 'var(--text-secondary)',
              }}
            >
              {/*
                The gate is STORED AUDIO, not status (ticket 045). Absent, not
                disabled — and the card says why, rather than leaving a silent
                gap where a control used to be.
              */}
              {hasAudio ? (
                <button
                  type="button"
                  data-run-play=""
                  onClick={() => props.onPlay(run.id)}
                  style={playButtonStyle}
                >
                  <PlayGlyph />
                  {PLAY}
                </button>
              ) : (
                <span data-run-no-audio="" style={{ color: 'var(--text-muted)' }}>
                  {NO_AUDIO}
                </span>
              )}

              {failure === null ? (
                <>
                  <div style={{ display: 'flex', gap: 'var(--space-3)', flexWrap: 'wrap' }}>
                    {cells.map((cell) => (
                      <span key={cell.label} data-run-stage={cell.label}>
                        {`${cell.label} `}
                        <b style={figureStyle}>{formatMs(cell.ms)}</b>
                      </span>
                    ))}
                  </div>

                  <span style={{ marginLeft: 'auto' }}>
                    <span data-run-total="">
                      {'total '}
                      <b style={figureStyle}>{formatMs(total)}</b>
                    </span>
                    {' · '}
                    <span data-run-cost="" style={{ fontFamily: 'var(--font-mono)' }}>
                      {formatPerMinute(run.cost, props.recording)}
                    </span>
                  </span>
                </>
              ) : null}
            </div>

            {failure === null ? null : (
              <div data-run-failure="" data-failed-stage={failure.stage} style={failureStyle}>
                {failure.text}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
