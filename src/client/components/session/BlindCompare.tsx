/**
 * Ticket 014 — Blind compare (comparison mode only).
 *
 * Comparison-mode-only blind A/B rating of the arms' TTS output, per PRD §9
 * and the blind-compare section of
 * design_handoff_interpreter_workbench/interpreter-workbench.dc.html.
 * SessionView renders this component after the arm-cards grid, ONLY while
 * more than one arm is active. First component under the ticket-012
 * decomposition directory src/client/components/session/.
 *
 * Wiring: the blind-compare LOGIC (open/close, draw, scores, submit) lives
 * in useSessionController as the `blind` slice + toggleBlind / scoreBlind /
 * submitBlind / playBlindSample actions (it needs deps.ledger, deps.rng,
 * deps.now and the per-arm playbacks); this component renders that slice.
 *
 * ========================= CONTRACT (locked by BlindCompare.test.tsx) ======
 *
 * Visibility / trigger row:
 * - Rendered ONLY in comparison mode (>1 active arm): secondary button
 *   'compare blind' (label toggles to 'close blind compare' while open) and
 *   the right-aligned muted note 'utterance {N} · {M} arms · all succeeded'
 *   (N = machine utteranceCount, M = active arm count; 'all succeeded' when
 *   no arm failed the last settled utterance). Single arm → neither renders.
 *
 * Open (per open — this is what makes the blinding auditable):
 * - Draw a fresh presentation order from the ACTIVE arm order with the
 *   injected deps.rng (see SessionDeps.rng contract: Fisher–Yates, exactly
 *   one rng() value for two arms; < 0.5 keeps active order, >= 0.5 swaps).
 * - Record the draw AT OPEN TIME via ledger.recordBlindDraw({ id,
 *   utteranceId ('utt-{n}' of the current utterance), order (order[0] is
 *   Sample A), createdAt: deps.now() }).
 * - Card [data-blind-card]: title 'Compare blind', hint 'arm identity
 *   hidden until you submit', two panels [data-blind-sample="A"|"B"] each
 *   with title 'Sample A'/'Sample B', a play button named exactly 'play',
 *   and five score buttons '1'..'5' carrying aria-pressed (selected =
 *   accent-soft, keyed off aria-pressed); footer note 'rate fluency 1–5 ·
 *   order randomized · scores append to the run ledger'; submit button
 *   'submit ratings'.
 * - PRE-SUBMIT the arm identities are ABSENT from the card DOM — not hidden
 *   with CSS, absent. Ships built-but-unscored: no score is ever
 *   pre-selected.
 *
 * Submit:
 * - ledger.recordBlindScores({ drawId: <the open's draw id>, scores:
 *   { A: n, B: n }, revealedAt: deps.now() }).
 * - Identities revealed (accent text under the sample titles, matching the
 *   recorded draw order), hint becomes 'identity revealed — scores appended
 *   to ledger', submit label becomes 'submitted'.
 *
 * Reopen (also after submit): fresh draw recorded again (new id, fresh rng
 * consumption), score pickers cleared, identities hidden again, hint back
 * to the pre-submit copy. Closing is 'close blind compare'.
 * ==========================================================================
 */

import type { CSSProperties, ReactElement } from 'react';
import {
  ARM_CATALOG,
  type BlindSampleKey,
  type SessionController,
} from '../../views/useSessionController';

export interface BlindCompareProps {
  controller: SessionController;
}

const labelByArmId = new Map(ARM_CATALOG.map((d) => [d.id, d.label]));

const cardStyle: CSSProperties = {
  background: 'var(--surface-card)',
  border: '1px solid var(--border-default)',
  borderRadius: 12,
  padding: 18,
  boxShadow: '0 1px 2px rgba(0,0,0,.05)',
};

const smallSecondaryBtnStyle: CSSProperties = {
  border: '1px solid var(--border-default)',
  borderRadius: 8,
  background: 'var(--surface-card)',
  color: 'var(--text-body)',
  font: '500 12px var(--font-sans)',
  height: 32,
  padding: '0 14px',
  cursor: 'pointer',
};

const smallPrimaryBtnStyle: CSSProperties = {
  border: 'none',
  borderRadius: 8,
  background: 'var(--btn-primary-bg)',
  color: 'var(--text-inverse)',
  font: '500 12px var(--font-sans)',
  height: 32,
  padding: '0 14px',
  cursor: 'pointer',
};

function PlayGlyph(): ReactElement {
  return (
    <svg width={13} height={13} viewBox="0 0 24 24" fill="currentColor" aria-hidden>
      <path d="M7 5.5v13a1 1 0 0 0 1.54.84l10-6.5a1 1 0 0 0 0-1.68l-10-6.5A1 1 0 0 0 7 5.5z" />
    </svg>
  );
}

function SamplePanel({
  sample,
  revealed,
  identity,
  score,
  onScore,
  onPlay,
}: {
  sample: BlindSampleKey;
  revealed: boolean;
  identity: string | null;
  score: number | null;
  onScore: (n: number) => void;
  onPlay: () => void;
}): ReactElement {
  return (
    <div
      data-blind-sample={sample}
      style={{ border: '1px solid var(--border-default)', borderRadius: 10, padding: 14 }}
    >
      <div style={{ font: '600 12.5px var(--font-sans)', marginBottom: 4 }}>
        {`Sample ${sample}`}
      </div>
      {revealed && identity !== null && (
        <div style={{ font: '400 11px var(--font-sans)', color: 'var(--accent)', marginBottom: 8 }}>
          {identity}
        </div>
      )}
      <button
        onClick={onPlay}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 7,
          border: '1px solid var(--border-default)',
          borderRadius: 8,
          padding: '7px 12px',
          background: 'var(--surface-card)',
          font: '500 12px var(--font-sans)',
          cursor: 'pointer',
          width: '100%',
          marginBottom: 10,
          color: 'var(--text-body)',
        }}
      >
        <PlayGlyph />
        play
      </button>
      <div style={{ display: 'flex', gap: 5 }}>
        {[1, 2, 3, 4, 5].map((n) => {
          const selected = score === n;
          return (
            <button
              key={n}
              aria-pressed={selected}
              onClick={() => onScore(n)}
              style={{
                flex: 1,
                textAlign: 'center',
                border: `1px solid ${selected ? 'var(--accent)' : 'var(--border-default)'}`,
                borderRadius: 8,
                padding: '6px 0',
                font: '500 12px var(--font-sans)',
                cursor: 'pointer',
                background: selected ? 'var(--accent-soft)' : 'var(--surface-card)',
                color: selected ? 'var(--accent)' : 'var(--text-body)',
              }}
            >
              {n}
            </button>
          );
        })}
      </div>
    </div>
  );
}

export default function BlindCompare({ controller }: BlindCompareProps): ReactElement | null {
  const { state, actions, blind } = controller;
  if (state.arms.length <= 1) return null;

  const samples: BlindSampleKey[] = ['A', 'B'];

  return (
    <>
      {/* trigger row */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '0 4px' }}>
        <button onClick={() => actions.toggleBlind()} style={smallSecondaryBtnStyle}>
          {blind.open ? 'close blind compare' : 'compare blind'}
        </button>
        <span
          style={{
            font: '400 11.5px var(--font-sans)',
            color: 'var(--text-muted)',
            marginLeft: 'auto',
          }}
        >
          {`utterance ${state.utteranceCount} · ${state.arms.length} arms · ${
            blind.lastUtteranceFailed ? 'one arm failed' : 'all succeeded'
          }`}
        </span>
      </div>

      {/* card */}
      {blind.open && (
        <div data-blind-card style={cardStyle}>
          <div
            style={{
              display: 'flex',
              alignItems: 'baseline',
              justifyContent: 'space-between',
              marginBottom: 14,
            }}
          >
            <span style={{ font: '600 13px var(--font-sans)' }}>Compare blind</span>
            <span style={{ font: '400 11.5px var(--font-sans)', color: 'var(--text-muted)' }}>
              {blind.revealed
                ? 'identity revealed — scores appended to ledger'
                : 'arm identity hidden until you submit'}
            </span>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
            {samples.map((sample, i) => (
              <SamplePanel
                key={sample}
                sample={sample}
                revealed={blind.revealed}
                identity={labelByArmId.get(blind.order[i] ?? '') ?? null}
                score={blind.scores[sample]}
                onScore={(n) => actions.scoreBlind(sample, n)}
                onPlay={() => actions.playBlindSample(sample)}
              />
            ))}
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 14 }}>
            <button onClick={() => actions.submitBlind()} style={smallPrimaryBtnStyle}>
              {blind.revealed ? 'submitted' : 'submit ratings'}
            </button>
            <span style={{ font: '400 11.5px var(--font-sans)', color: 'var(--text-muted)' }}>
              rate fluency 1–5 · order randomized · scores append to the run ledger
            </span>
          </div>
        </div>
      )}
    </>
  );
}
