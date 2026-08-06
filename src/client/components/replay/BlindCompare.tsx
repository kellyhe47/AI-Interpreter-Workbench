/**
 * Ticket 014 — Blind compare, re-homed from Live into Replay (PRD §10,
 * §17 16b · 25d).
 *
 * MOVED, NOT COPIED: `src/client/components/session/BlindCompare.tsx` is
 * deleted. Live is one architecture per session, so there was never anything
 * to compare there; Replay never autoplays, which is precisely what makes
 * deliberate A/B listening — and therefore blind scoring — possible at all.
 *
 * ============================== DOM CONTRACT ==============================
 * Root [data-blind-card].
 *
 * PAIRWISE ONLY. Ranking three samples at once is not something a human can
 * judge, so the unit is a PAIR:
 *   - exactly 2 completed Runs → they ARE the pair; no picker is rendered
 *   - 3 or more               → [data-blind-pair-picker] with one
 *     [data-blind-pick][data-run=<id>] per Run, aria-pressed on the two
 *     chosen. Only Runs of the SAME Recording appear — a run of another
 *     Recording is not a comparison, it is a different input.
 *
 * The picker names Runs NEUTRALLY ('Run 1', 'Run 2', …). Labelling them by
 * configuration would defeat the blinding before it started.
 *
 * PLAYBACK ONLY. Per sample [data-blind-sample='A'|'B']:
 *   - title 'Sample A' / 'Sample B'
 *   - a play control named 'play' → onPlay(<the run behind that sample>)
 *   - [data-blind-dimension='adequacy'|'fluency'], each with five buttons
 *     '1'…'5' carrying aria-pressed
 * PRE-SUBMIT the component renders NEITHER run's configuration identity NOR
 * its transcript — absent from the DOM, not hidden with CSS. Showing the text
 * would let the wrong-language-pronunciation class of error pass unnoticed: a
 * TTS that reads Cantonese text aloud in Mandarin produces a transcript that
 * reads correctly and audio that is wrong (PRD §11).
 *
 * THE DRAW IS INJECTED AND PER COMPARISON. One `rng()` value per comparison:
 * < 0.5 keeps the picked order, >= 0.5 swaps it. A fixed A↔B inversion would
 * teach the evaluator the mapping after a single reveal.
 *
 * SUBMIT persists the whole thing — the two run ids, THE DRAWN ASSIGNMENT,
 * both dimensions for both samples, and the evaluator's language — and only
 * then reveals identity, from the persisted draw rather than recomputed.
 * Submit is unavailable until all four scores are in.
 * ==========================================================================
 *
 * ------------------------------- THE PICKER -------------------------------
 * With three or more Runs the two chosen ones occupy two SLOTS, filled round
 * robin: the first pick takes slot 0, the second slot 1, the third displaces
 * the longest-standing occupant, and so on. Two consequences, both deliberate:
 *
 *   - a third pick never produces a third sample — the newest joins and the
 *     longest-standing leaves, so the comparison stays pairwise at all times;
 *   - a COMPARISON is a completed pair of picks, and it is exactly then — when
 *     a pick lands in the slot that completes it — that a fresh `rng()` value
 *     is drawn. Swapping one half of a standing pair mid-comparison keeps the
 *     standing draw rather than re-rolling the assignment underneath the
 *     evaluator, who has already listened to the sample that stayed.
 *
 * Every fresh pair clears the scores and the reveal: they belonged to the
 * comparison that just ended, not to this one.
 */

import { useState, type CSSProperties, type ReactElement } from 'react';
import { armLabel } from '../../../core/arms';
import {
  runArmTag,
  type BlindComparison,
  type BlindDimension,
  type BlindSampleKey,
  type Recording,
  type Run,
} from '../../state/ledger';

export type { BlindComparison };

export interface BlindCompareProps {
  /** The Recording under comparison. Both Runs must be Runs of it. */
  recording: Recording;
  /** Its COMPLETED Runs, and nothing else — the only pairable candidates. */
  runs: Run[];
  /** The injected randomness source. NEVER `Math.random` captured directly. */
  rng: () => number;
  /** The language the evaluator judges in; persisted with the draw. */
  evaluatorLanguage: string;
  now: () => number;
  newId: () => string;
  /** On-demand playback of the Run behind a sample. Never called at render. */
  onPlay: (runId: string) => void;
  /** Appends the completed comparison to the ledger. */
  onSubmit: (comparison: BlindComparison) => void;
}

/* ------------------------------------------------------------------ copy -- */

const TITLE = 'Compare blind';

/** Verbatim from the design mock — the whole reason the mode exists. */
const BLURB =
  'Playback only — transcripts are hidden until you submit, so a wrong-language ' +
  "pronunciation can't pass by reading. Assignment drawn at random per comparison " +
  'and persisted to the ledger.';

const HINT_HIDDEN = 'configuration identity hidden until you submit';
const HINT_REVEALED = 'identity revealed — appended to ledger';

const PICKER_LABEL = 'pick two runs to compare';

const SUBMIT = 'submit ratings';
const SUBMITTED = 'submitted';

const PLAY = 'play';

const SAMPLES: readonly BlindSampleKey[] = ['A', 'B'];
const DIMENSIONS: readonly BlindDimension[] = ['adequacy', 'fluency'];
const POINTS: readonly number[] = [1, 2, 3, 4, 5];

/* ----------------------------------------------------------------- state -- */

/** The two slots. `null` while the evaluator is still choosing. */
type Slots = [string | null, string | null];
type Slot = 0 | 1;

/** One sample's ratings, either dimension still open until it is scored. */
type SampleScores = { [dimension in BlindDimension]: number | null };
type Scores = { [sample in BlindSampleKey]: SampleScores };

const NO_SCORES: Scores = {
  A: { adequacy: null, fluency: null },
  B: { adequacy: null, fluency: null },
};

/* ---------------------------------------------------------------- styles -- */

const cardStyle: CSSProperties = {
  background: 'var(--surface-card)',
  border: '1px solid var(--border-default)',
  borderRadius: 'var(--radius-lg)',
  boxShadow: 'var(--shadow-card)',
  padding: 'var(--space-4)',
  display: 'flex',
  flexDirection: 'column',
  gap: 'var(--space-3)',
};

const headRowStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'baseline',
  gap: 'var(--space-3)',
  flexWrap: 'wrap',
};

const hintStyle: CSSProperties = {
  marginLeft: 'auto',
  color: 'var(--text-muted)',
  fontSize: 'var(--text-xs)',
};

const blurbStyle: CSSProperties = {
  color: 'var(--text-secondary)',
  fontSize: 'var(--text-sm)',
  lineHeight: 'var(--leading-normal)',
  margin: 0,
};

const samplesGridStyle: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: '1fr 1fr',
  gap: 'var(--space-3)',
};

const sampleStyle: CSSProperties = {
  border: '1px solid var(--border-default)',
  borderRadius: 'var(--radius-md)',
  padding: 'var(--space-3)',
  display: 'flex',
  flexDirection: 'column',
  gap: 'var(--space-2)',
};

const playButtonStyle: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
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

const identityStyle: CSSProperties = {
  color: 'var(--accent-strong)',
  fontSize: 'var(--text-xs)',
  fontWeight: 'var(--weight-medium)',
};

function pressableStyle(pressed: boolean): CSSProperties {
  return {
    border: `1px solid ${pressed ? 'var(--accent)' : 'var(--border-default)'}`,
    borderRadius: 'var(--radius-md)',
    background: pressed ? 'var(--accent-soft)' : 'var(--surface-card)',
    color: pressed ? 'var(--accent-strong)' : 'var(--text-body)',
    fontFamily: 'inherit',
    fontSize: 'var(--text-sm)',
    fontWeight: 'var(--weight-medium)',
    padding: 'var(--space-1) var(--space-2)',
    cursor: 'pointer',
  };
}

function submitStyle(enabled: boolean): CSSProperties {
  return {
    border: 'none',
    borderRadius: 'var(--radius-md)',
    background: enabled ? 'var(--btn-primary-bg)' : 'var(--surface-sunken)',
    color: enabled ? 'var(--text-inverse)' : 'var(--text-muted)',
    fontFamily: 'inherit',
    fontSize: 'var(--text-sm)',
    fontWeight: 'var(--weight-medium)',
    padding: 'var(--space-2) var(--space-4)',
    cursor: enabled ? 'pointer' : 'not-allowed',
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

export default function BlindCompare(props: BlindCompareProps): ReactElement | null {
  const { recording, runs, rng, evaluatorLanguage, now, newId, onPlay, onSubmit } = props;

  /** Exactly two candidates ARE the pair; picking between two would be theatre. */
  const fixedPair: Slots | null =
    runs.length === 2 ? [runs[0]!.id, runs[1]!.id] : null;

  const [slots, setSlots] = useState<Slots>(() => fixedPair ?? [null, null]);
  const [nextSlot, setNextSlot] = useState<Slot>(0);
  /**
   * The draw itself: one injected value per comparison, kept as the decision it
   * produced rather than the number, so nothing downstream can re-roll it.
   */
  const [swapped, setSwapped] = useState<boolean | null>(() =>
    fixedPair === null ? null : rng() >= 0.5,
  );
  const [scores, setScores] = useState<Scores>(NO_SCORES);
  /** The comparison as it was APPENDED. The reveal reads this, never the pair. */
  const [submission, setSubmission] = useState<BlindComparison | null>(null);

  if (runs.length < 2) return null;

  const byId = new Map(runs.map((run) => [run.id, run]));
  const chosen: [string, string] | null =
    slots[0] !== null && slots[1] !== null && byId.has(slots[0]) && byId.has(slots[1]) ?
      [slots[0], slots[1]]
    : null;

  /** order[0] is Sample A. The draw decides; the pick order does not. */
  const order: [string, string] | null =
    chosen === null || swapped === null ? null
    : swapped ? [chosen[1], chosen[0]]
    : [chosen[0], chosen[1]];

  const revealedOrder = submission === null ? null : submission.order;

  const pick = (runId: string): void => {
    if (slots.includes(runId)) return;
    const slot = nextSlot;
    setSlots((previous) => (slot === 0 ? [runId, previous[1]] : [previous[0], runId]));
    setNextSlot(slot === 0 ? 1 : 0);
    // The pick that COMPLETES a pair is the start of a comparison, and a
    // comparison is exactly what one rng() value is drawn for.
    if (slot === 1) setSwapped(rng() >= 0.5);
    setScores(NO_SCORES);
    setSubmission(null);
  };

  const setScore = (sample: BlindSampleKey, dimension: BlindDimension, value: number): void => {
    setScores((previous) => ({
      ...previous,
      [sample]: { ...previous[sample], [dimension]: value },
    }));
  };

  const scored = (sample: BlindSampleKey, dimension: BlindDimension): number | null =>
    scores[sample][dimension];

  const complete = SAMPLES.every((sample) =>
    DIMENSIONS.every((dimension) => scored(sample, dimension) !== null),
  );
  const submittable = complete && order !== null && chosen !== null && submission === null;

  const submit = (): void => {
    if (!submittable || order === null || chosen === null) return;
    const at = now();
    const comparison: BlindComparison = {
      id: newId(),
      recordingId: recording.id,
      runIds: [chosen[0], chosen[1]],
      order: [order[0], order[1]],
      evaluatorLanguage,
      scores: {
        A: { adequacy: scores.A.adequacy!, fluency: scores.A.fluency! },
        B: { adequacy: scores.B.adequacy!, fluency: scores.B.fluency! },
      },
      createdAt: at,
      revealedAt: at,
    };
    setSubmission(comparison);
    onSubmit(comparison);
  };

  return (
    <div data-blind-card="" style={cardStyle}>
      <div style={headRowStyle}>
        <span style={{ fontWeight: 'var(--weight-semibold)', fontSize: 'var(--text-base)' }}>
          {TITLE}
        </span>
        <span data-blind-hint="" style={hintStyle}>
          {submission === null ? HINT_HIDDEN : HINT_REVEALED}
        </span>
      </div>

      <p data-blind-blurb="" style={blurbStyle}>
        {BLURB}
      </p>

      {fixedPair === null ? (
        <div
          data-blind-pair-picker=""
          style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)', flexWrap: 'wrap' }}
        >
          <span style={{ color: 'var(--text-muted)', fontSize: 'var(--text-xs)' }}>
            {PICKER_LABEL}
          </span>
          {runs.map((run, index) => {
            const pressed = slots.includes(run.id);
            return (
              <button
                key={run.id}
                type="button"
                data-blind-pick=""
                data-run={run.id}
                aria-pressed={pressed}
                onClick={() => pick(run.id)}
                style={pressableStyle(pressed)}
              >
                {`Run ${index + 1}`}
              </button>
            );
          })}
        </div>
      ) : null}

      {order === null ? null : (
        <div style={samplesGridStyle}>
          {SAMPLES.map((sample, index) => {
            const runId = order[index]!;
            const revealedRunId = revealedOrder === null ? null : revealedOrder[index]!;
            const revealed = revealedRunId === null ? null : byId.get(revealedRunId) ?? null;
            return (
              <div key={sample} data-blind-sample={sample} style={sampleStyle}>
                <div
                  data-blind-sample-title=""
                  style={{ fontWeight: 'var(--weight-semibold)', fontSize: 'var(--text-sm)' }}
                >
                  {`Sample ${sample}`}
                </div>

                {revealed === null || revealedRunId === null ? null : (
                  <div data-blind-identity="" data-run={revealedRunId} style={identityStyle}>
                    {armLabel(runArmTag(revealed))}
                  </div>
                )}

                <button
                  type="button"
                  onClick={() => onPlay(runId)}
                  style={playButtonStyle}
                >
                  <PlayGlyph />
                  {PLAY}
                </button>

                {DIMENSIONS.map((dimension) => (
                  <div
                    key={dimension}
                    data-blind-dimension={dimension}
                    style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)' }}
                  >
                    <span
                      style={{
                        color: 'var(--text-secondary)',
                        fontSize: 'var(--text-xs)',
                        minWidth: 'var(--space-12)',
                      }}
                    >
                      {dimension}
                    </span>
                    <div style={{ display: 'flex', gap: 'var(--space-1)', flex: 1 }}>
                      {POINTS.map((point) => {
                        const pressed = scored(sample, dimension) === point;
                        return (
                          <button
                            key={point}
                            type="button"
                            aria-pressed={pressed}
                            onClick={() => setScore(sample, dimension, point)}
                            style={{ ...pressableStyle(pressed), flex: 1 }}
                          >
                            {point}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                ))}
              </div>
            );
          })}
        </div>
      )}

      <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-3)' }}>
        <button
          type="button"
          data-blind-submit=""
          disabled={!submittable}
          onClick={submit}
          style={submitStyle(submittable)}
        >
          {submission === null ? SUBMIT : SUBMITTED}
        </button>
      </div>
    </div>
  );
}
