/**
 * Ticket 012 — Live view (renamed from the v1 session view; ONE architecture).
 *
 * `<LiveView controller={useSessionController(deps)} />` — recreates the Live
 * section of design_handoff_interpreter_workbench/interpreter-workbench-v2.dc.html
 * in React/TS on top of the REAL session machine, transport, audio and
 * ledger. Styles come from tokens.css CSS variables only.
 *
 * ========================= DOM CONTRACT (locked) ===========================
 * Locked by LiveView.test.tsx + LiveView.flow.test.tsx. Test hooks are
 * style-agnostic data attributes; user-facing copy is asserted verbatim.
 *
 * DEVIATIONS FROM THE MOCK (PRD wins — do not "fix" these back):
 * - NO "Mock state" chips row. The text 'Mock state' must never render.
 * - Mic permission is a LIVE four-value indicator, never hardcoded, never
 *   optimistic.
 * - The stopped banner shows REAL machine-summary numbers.
 * - Session footer figures come from ledger aggregates; the amber 'figures
 *   illustrative' pill NEVER renders.
 * - NO comparison grid: no arm cards, no add-arm pill, no audible-arm
 *   selector and no autoplay switch. Live runs one architecture and autoplay
 *   is unconditionally on, so there is nothing to choose between.
 *
 * Header: 'Live' + purpose line
 *   'One architecture, voice in → voice out, up to 5 minutes. Metrics are
 *    saved; audio is discarded. Nothing here becomes experimental evidence.'
 *
 * Controls card row 1:
 *   Realtime / Cascade segmented buttons, aria-pressed = APPLIED mode.
 *   [data-arm-tag="A|B|C|ad-hoc"] pill, text 'this is Arm B' | 'ad-hoc'. It
 *   is a READOUT: a span with no interactive descendant, because membership
 *   is derived from the recipe and never declared by a control.
 *   Language button labelled '{src} → {tgt}'; direction button aria-label
 *   'Swap direction'; support pill 'both modes' | 'cascade only';
 *   'Stop session' while stoppable, 'Start new session' when stopped.
 * Controls card row 2:
 *   cascade → three [data-stage-select="stt|mt|tts"] buttons, text = the
 *     selected model id, click cycles through MENUS[stage].
 *   realtime → [data-context-policy="default|trimmed"] containing buttons
 *     'default' / 'trimmed' with aria-pressed, plus the cost note.
 *
 * Status strip:
 *   [data-mic-indicator="<value>"] — 'mic not requested' | 'mic prompt open…'
 *     | 'mic allowed' | 'mic blocked'.
 *   [data-conn] 'no connection' | 'connected' | 'reconnecting…' | 'disconnected'.
 *   [data-input-meter] with five [data-meter-bar] children.
 *   [data-state-label] = stateLabel(state) (mono) — 'switch-queued' overlays.
 *   [data-elapsed] = '{M:SS} / 5:00 · autoplay on'.
 *
 * Banners (copy verbatim): switch-queued, reconnecting, disconnected +
 * 'Reconnect', Cantonese warnings (warn, never block), stopped summary.
 * Banner copy sits in DIRECT text nodes so getByText matches the banner
 * itself rather than an ancestor.
 *
 * Permission-denied BLOCKING card [data-denied-card]: names BOTH the site
 * permission and the OS permission layers, says browsers do not re-prompt,
 * and offers 'Retry microphone' (a machine no-op while denied). Ticket 036
 * moved that remediation copy into src/client/copy/micDenial.ts, which Replay's
 * record flow shows too — one wording of it exists in the product, not two.
 *
 * Session cards: [data-source-card]; exactly ONE [data-target-card] with
 * [data-target-status] in 'in-flight' | 'ready' | 'failed' (ticket 047: there
 * is no fourth value — Live has no pause state, so nothing can put the card
 * into a playing/suspended one), [data-target-arch] naming the architecture,
 * [data-stage-row="<label>"] rows carrying LABELLED milliseconds, the
 * intervals note, and [data-utterance-duration] — a readout, not a control.
 *
 * [data-session-footer]: '{n} utterances', p50 / p95 / session $ from
 * ledger.aggregates(sessionRunId).
 * ==========================================================================
 */

import type { CSSProperties, ReactElement, ReactNode } from 'react';
import { MENUS, armLabel } from '../../core/arms';
import {
  deriveCascadeIntervals,
  deriveRealtimeIntervals,
  type CascadeTimestamps,
  type RealtimeTimestamps,
} from '../../core/timing';
import {
  MIC_DENIED_HEADING,
  MIC_DENIED_NO_REPROMPT,
  MIC_DENIED_OS_SETTING,
  MIC_DENIED_SITE_PERMISSION,
} from '../copy/micDenial';
import {
  LIVE_MAX_SESSION_MS,
  MAX_RECONNECT_ATTEMPTS,
  pairs,
  stateLabel,
  supportPill,
  warnings,
  type ProviderStage,
  type SessionStatus,
} from '../state/sessionMachine';
import type { SessionController, TargetView } from './useSessionController';

export interface LiveViewProps {
  controller: SessionController;
}

const CONNECTED_STATUSES: readonly SessionStatus[] = [
  'listening',
  'processing',
  'ready',
  'playing',
];

const STOPPABLE_STATUSES: readonly SessionStatus[] = [
  'requesting-permission',
  'listening',
  'processing',
  'ready',
  'playing',
  'reconnecting',
  'disconnected',
];

// ---------------------------------------------------------------------------
// Shared styles — tokens.css CSS variables only (no colour literals)
// ---------------------------------------------------------------------------

const cardStyle: CSSProperties = {
  background: 'var(--surface-card)',
  border: '1px solid var(--border-default)',
  borderRadius: 'var(--radius-lg)',
  boxShadow: 'var(--shadow-card)',
};

const centeredCardStyle: CSSProperties = {
  ...cardStyle,
  padding: '56px 24px',
  textAlign: 'center',
};

const eyebrowStyle: CSSProperties = {
  font: '500 10.5px var(--font-sans)',
  color: 'var(--text-muted)',
  textTransform: 'uppercase',
  letterSpacing: '.05em',
};

const segWrapStyle: CSSProperties = {
  display: 'flex',
  border: '1px solid var(--border-default)',
  borderRadius: 'var(--radius-md)',
  overflow: 'hidden',
  font: '500 12.5px var(--font-sans)',
};

function segBtnStyle(on: boolean): CSSProperties {
  return {
    border: 'none',
    cursor: 'pointer',
    padding: '7px 16px',
    font: 'inherit',
    color: on ? 'var(--text-body)' : 'var(--text-secondary)',
    background: on ? 'var(--surface-selected)' : 'var(--surface-card)',
  };
}

const primaryBtnStyle: CSSProperties = {
  border: 'none',
  borderRadius: 'var(--radius-md)',
  background: 'var(--btn-primary-bg)',
  color: 'var(--text-inverse)',
  font: '500 13px var(--font-sans)',
  height: 36,
  padding: '0 18px',
  cursor: 'pointer',
};

const smallPrimaryBtnStyle: CSSProperties = {
  ...primaryBtnStyle,
  height: 32,
  font: '500 12px var(--font-sans)',
  padding: '0 14px',
};

const smallSecondaryBtnStyle: CSSProperties = {
  border: '1px solid var(--border-default)',
  borderRadius: 'var(--radius-md)',
  background: 'var(--surface-card)',
  color: 'var(--text-body)',
  font: '500 12px var(--font-sans)',
  height: 32,
  padding: '0 14px',
  cursor: 'pointer',
};

function bannerStyle(background: string, color: string): CSSProperties {
  return {
    display: 'flex',
    alignItems: 'center',
    gap: 9,
    background,
    color,
    borderRadius: 'var(--radius-md)',
    padding: '10px 14px',
    font: '400 12.5px var(--font-sans)',
  };
}

const monoStyle: CSSProperties = { fontFamily: 'var(--font-mono)', fontSize: 11 };

// ---------------------------------------------------------------------------
// Icons (Lucide-style outline, 1.5px stroke — from the design mock)
// ---------------------------------------------------------------------------

function MicIcon({ size, stroke }: { size: number; stroke: string }): ReactElement {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke={stroke}
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3z" />
      <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
      <path d="M12 19v3" />
    </svg>
  );
}

function WarnIcon(): ReactElement {
  return (
    <svg
      width={14}
      height={14}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3z" />
      <path d="M12 9v4" />
      <path d="M12 17h.01" />
    </svg>
  );
}

function ClockIcon(): ReactElement {
  return (
    <svg
      width={14}
      height={14}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      aria-hidden
    >
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3 3" />
    </svg>
  );
}

function RetryIcon(): ReactElement {
  return (
    <svg
      width={14}
      height={14}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M21 12a9 9 0 1 1-2.64-6.36" />
      <path d="M21 3v6h-6" />
    </svg>
  );
}

function CrossCircleIcon(): ReactElement {
  return (
    <svg
      width={14}
      height={14}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <circle cx="12" cy="12" r="9" />
      <path d="m9 9 6 6" />
      <path d="m15 9-6 6" />
    </svg>
  );
}

function CheckCircleIcon(): ReactElement {
  return (
    <svg
      width={14}
      height={14}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" />
      <path d="m9 11 3 3L22 4" />
    </svg>
  );
}

function ChevronIcon(): ReactElement {
  return (
    <svg
      width={14}
      height={14}
      viewBox="0 0 24 24"
      fill="none"
      stroke="var(--gray-400)"
      strokeWidth={1.5}
      strokeLinecap="round"
      aria-hidden
    >
      <path d="m6 9 6 6 6-6" />
    </svg>
  );
}

function SwapIcon(): ReactElement {
  return (
    <svg
      width={15}
      height={15}
      viewBox="0 0 24 24"
      fill="none"
      stroke="var(--gray-500)"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M8 3 4 7l4 4" />
      <path d="M4 7h16" />
      <path d="m16 21 4-4-4-4" />
      <path d="M20 17H4" />
    </svg>
  );
}

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

/** m:ss with unpadded minutes — the Live clock reads against '5:00'. */
function formatClock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

interface StageRowData {
  label: string;
  ms: number | null;
  /** Realtime's model interval: the asymmetry is the PRD finding. */
  opaque?: boolean;
}

function stageRowsFor(
  architecture: 'cascade' | 'realtime',
  target: TargetView,
): { rows: StageRowData[]; total: number | null } {
  if (architecture === 'cascade') {
    const iv = deriveCascadeIntervals(target.timings as CascadeTimestamps);
    return {
      rows: [
        { label: 'endpointing', ms: iv.endpointing },
        { label: 'stt', ms: iv.stt },
        { label: 'mt', ms: iv.mt },
        { label: 'tts', ms: iv.tts },
        { label: 'queue', ms: iv.queue },
      ],
      total: iv.endToEnd,
    };
  }
  const iv = deriveRealtimeIntervals(target.timings as RealtimeTimestamps);
  return {
    rows: [
      { label: 'endpointing', ms: iv.endpointing },
      { label: 'model', ms: iv.model, opaque: true },
      { label: 'queue', ms: iv.queue },
    ],
    total: iv.endToEnd,
  };
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function Banner({
  tone,
  children,
}: {
  tone: 'warning' | 'negative' | 'positive';
  children: ReactNode;
}): ReactElement {
  const styles: Record<string, CSSProperties> = {
    warning: bannerStyle('var(--warning-soft)', 'var(--warning)'),
    negative: bannerStyle('var(--negative-soft)', 'var(--negative)'),
    positive: bannerStyle('var(--positive-soft)', 'var(--positive)'),
  };
  return <div style={styles[tone]}>{children}</div>;
}

/**
 * The one target card. There is no grid: one architecture, one output.
 *
 * TICKET 047 — and no play/pause control. The translation sounds the instant
 * it arrives (autoplay is unconditional in Live), so the only thing the old
 * button carried that was worth keeping is the utterance duration, which is
 * information rather than a control and now sits in its own readout row.
 */
function TargetCard({
  architecture,
  recipe,
  target,
}: {
  architecture: 'cascade' | 'realtime';
  recipe: string;
  target: TargetView;
}): ReactElement {
  const failed = target.status === 'failed';
  const inFlight = target.status === 'in-flight';
  const displayStatus = failed ? 'failed' : target.status;
  const statusLabel = failed ? 'failed' : inFlight ? 'in flight' : 'ready';
  const statusColor = failed
    ? 'var(--negative)'
    : inFlight
      ? 'var(--text-secondary)'
      : 'var(--positive)';
  const archLabel = architecture === 'realtime' ? 'Realtime' : 'Cascade';
  const { rows, total } = stageRowsFor(architecture, target);
  const showDetails = !failed && !inFlight && target.hasData;

  return (
    <div
      data-target-card
      data-target-status={displayStatus}
      style={{ ...cardStyle, padding: '16px 18px', display: 'flex', flexDirection: 'column', gap: 10 }}
    >
      <div
        style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10 }}
      >
        <span data-target-arch style={{ font: '600 13px var(--font-sans)' }}>
          {archLabel}
          <span
            style={{ ...monoStyle, color: 'var(--text-muted)', fontWeight: 400, marginLeft: 8 }}
          >
            {recipe}
          </span>
        </span>
        <span
          style={{
            font: '400 11px var(--font-sans)',
            display: 'inline-flex',
            alignItems: 'center',
            gap: 5,
            color: statusColor,
          }}
        >
          {statusLabel}
        </span>
      </div>

      {inFlight && (
        <div
          data-inflight-bar
          style={{
            height: 5,
            background: 'var(--gray-100)',
            borderRadius: 3,
            overflow: 'hidden',
          }}
        >
          <i
            style={{
              display: 'block',
              height: 5,
              borderRadius: 3,
              background: 'var(--accent)',
              animation: 'wb-fill 1.4s infinite alternate ease-in-out',
            }}
          />
        </div>
      )}

      {!failed && (
        <div style={{ font: '400 14px/1.6 var(--font-sans)', minHeight: 44 }}>
          {target.targetText}
        </div>
      )}

      {failed && (
        <div
          style={{
            background: 'var(--negative-soft)',
            color: 'var(--negative)',
            borderRadius: 'var(--radius-md)',
            padding: '9px 12px',
            font: '400 12px var(--font-sans)',
          }}
        >
          {target.failMessage}
        </div>
      )}

      {/* The duration of the audio for THIS utterance — a readout, right where
          the deleted play button used to sit. Rendered whenever the card has
          data, including after the session stops (the button vanished there;
          the information should not). */}
      {showDetails && (
        <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
          <span data-utterance-duration style={{ ...monoStyle, color: 'var(--text-muted)' }}>
            {(target.durationMs / 1000).toFixed(1)} s
          </span>
        </div>
      )}

      {showDetails && (
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            gap: 6,
            borderTop: '1px solid var(--border-default)',
            paddingTop: 10,
          }}
        >
          {rows.map((row) => {
            const totalMs = total ?? rows.reduce((sum, r) => sum + (r.ms ?? 0), 0);
            const pct =
              row.ms === null || totalMs <= 0
                ? 0
                : Math.max(1, Math.round((row.ms / totalMs) * 100));
            return (
              <div
                key={row.label}
                data-stage-row={row.label}
                style={{
                  display: 'grid',
                  gridTemplateColumns: '110px 1fr 58px',
                  gap: '0 10px',
                  alignItems: 'center',
                  font: '400 11.5px var(--font-sans)',
                }}
              >
                <span style={{ color: 'var(--text-secondary)' }}>
                  {row.label}
                  {row.opaque && (
                    <span style={{ color: 'var(--text-muted)', marginLeft: 6 }}>opaque</span>
                  )}
                </span>
                <span
                  style={{
                    height: 5,
                    background: 'var(--gray-100)',
                    borderRadius: 3,
                    overflow: 'hidden',
                    display: 'block',
                  }}
                >
                  <i
                    style={{
                      display: 'block',
                      height: 5,
                      borderRadius: 3,
                      background: row.label === 'endpointing' ? 'var(--gray-400)' : 'var(--accent)',
                      width: `${pct}%`,
                    }}
                  />
                </span>
                <span style={{ textAlign: 'right', ...monoStyle }}>
                  {row.ms === null ? '—' : `${row.ms} ms`}
                </span>
              </div>
            );
          })}
        </div>
      )}

      {showDetails && (
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            font: '400 11.5px var(--font-sans)',
            color: 'var(--text-secondary)',
            borderTop: '1px solid var(--border-default)',
            paddingTop: 9,
          }}
        >
          <span>
            total{' '}
            <b
              style={{
                color: 'var(--text-body)',
                fontWeight: 600,
                fontFamily: 'var(--font-mono)',
                fontSize: 11.5,
              }}
            >
              {total === null ? '—' : `${total} ms`}
            </b>
          </span>
          <span style={{ color: 'var(--text-muted)' }}>
            {architecture === 'cascade' ? '5 intervals · all visible' : '3 intervals · 1 opaque'}
          </span>
        </div>
      )}

      {showDetails && architecture === 'realtime' && (
        <div
          style={{
            background: 'var(--surface-sunken)',
            borderRadius: 'var(--radius-md)',
            padding: '8px 11px',
            font: '400 11px/1.5 var(--font-sans)',
            color: 'var(--text-secondary)',
          }}
        >
          model interval is opaque — recognition, translation and voice happen inside one model ·
          source transcript comes from a parallel recognizer, not the model itself
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main view
// ---------------------------------------------------------------------------

export default function LiveView({ controller }: LiveViewProps): ReactElement {
  const { state, actions, footer, target, runConfig, armTag } = controller;
  const status = state.status;
  const pair = pairs[state.langIdx] ?? pairs[0]!;
  const src = state.reversed ? pair.tgt : pair.src;
  const tgt = state.reversed ? pair.src : pair.tgt;
  const modeLabel = state.mode === 'realtime' ? 'Realtime' : 'Cascade';
  const stopped = status === 'stopped';
  const idleLike = status === 'idle' || status === 'requesting-permission';
  const denied = status === 'permission-denied';
  const showSessionArea = !idleLike && !denied;
  const stoppable = STOPPABLE_STATUSES.includes(status);
  const live = CONNECTED_STATUSES.includes(status);
  const warn = warnings(state.langIdx, state.reversed, state.mode);
  const pill = supportPill(state.langIdx);
  const cascade = state.mode === 'cascade';
  const recipe = cascade
    ? `${state.providers.stt} → ${state.providers.mt} → ${state.providers.tts}`
    : (runConfig.realtimeModel ?? '');

  let connLabel: string;
  let connColor: string;
  if (status === 'reconnecting') {
    connLabel = 'reconnecting…';
    connColor = 'var(--warning)';
  } else if (status === 'disconnected') {
    connLabel = 'disconnected';
    connColor = 'var(--text-muted)';
  } else if (live) {
    connLabel = 'connected';
    connColor = 'var(--positive)';
  } else {
    connLabel = 'no connection';
    connColor = 'var(--text-muted)';
  }

  const micByPermission: Record<string, { label: string; color: string; icon: boolean }> = {
    'not-requested': { label: 'mic not requested', color: 'var(--text-muted)', icon: false },
    requesting: { label: 'mic prompt open…', color: 'var(--warning)', icon: false },
    granted: { label: 'mic allowed', color: 'var(--positive)', icon: true },
    denied: { label: 'mic blocked', color: 'var(--negative)', icon: false },
  };
  const mic = micByPermission[state.micPermission]!;

  const meterHeights = [5, 9, 13, 7, 4];
  const stages: ProviderStage[] = ['stt', 'mt', 'tts'];

  return (
    <>
      {/* header + purpose line */}
      <div style={{ padding: '0 4px' }}>
        <div style={{ font: '600 18px var(--font-sans)', letterSpacing: 'var(--tracking-heading)' }}>
          Live
        </div>
        <div
          style={{
            font: '400 12.5px/1.6 var(--font-sans)',
            color: 'var(--text-secondary)',
            marginTop: 4,
            maxWidth: 720,
          }}
        >
          One architecture, voice in → voice out, up to 5 minutes. Metrics are saved; audio is
          discarded. Nothing here becomes experimental evidence.
        </div>
      </div>

      {/* controls card — always visible per PRD */}
      <div
        style={{
          ...cardStyle,
          display: 'flex',
          flexDirection: 'column',
          gap: 12,
          padding: '14px 16px',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <div style={segWrapStyle}>
            <button
              aria-pressed={state.mode === 'realtime'}
              onClick={() => actions.requestMode('realtime')}
              style={segBtnStyle(state.mode === 'realtime')}
            >
              Realtime
            </button>
            <button
              aria-pressed={state.mode === 'cascade'}
              onClick={() => actions.requestMode('cascade')}
              style={segBtnStyle(state.mode === 'cascade')}
            >
              Cascade
            </button>
          </div>

          {/* DERIVED readout — never a picker (PRD §6, decisions 22d-22e). */}
          <span
            data-arm-tag={armTag}
            style={{
              font: '400 11px var(--font-sans)',
              borderRadius: 'var(--radius-pill)',
              padding: '4px 11px',
              background: armTag === 'ad-hoc' ? 'var(--surface-selected)' : 'var(--accent-soft)',
              color: armTag === 'ad-hoc' ? 'var(--text-secondary)' : 'var(--accent)',
            }}
          >
            {armTag === 'ad-hoc' ? 'ad-hoc' : `this is ${armLabel(armTag)}`}
          </span>

          <button
            onClick={() => actions.cycleLanguage()}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 8,
              border: '1px solid var(--border-default)',
              borderRadius: 'var(--radius-md)',
              padding: '7px 12px',
              background: 'var(--surface-card)',
              font: '400 13px var(--font-sans)',
              color: 'var(--text-body)',
              cursor: 'pointer',
            }}
          >
            {`${src} → ${tgt}`}
            <ChevronIcon />
          </button>
          <button
            aria-label="Swap direction"
            title="Swap direction"
            onClick={() => actions.swapDirection()}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              border: '1px solid var(--border-default)',
              borderRadius: 'var(--radius-md)',
              padding: '7px 9px',
              background: 'var(--surface-card)',
              cursor: 'pointer',
            }}
          >
            <SwapIcon />
          </button>
          <span
            style={{
              font: '400 10.5px var(--font-sans)',
              borderRadius: 'var(--radius-pill)',
              padding: '3px 9px',
              background:
                pill === 'cascade only' ? 'var(--warning-soft)' : 'var(--surface-selected)',
              color: pill === 'cascade only' ? 'var(--warning)' : 'var(--text-secondary)',
            }}
          >
            {pill}
          </span>

          <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 10 }}>
            {stopped && (
              <button onClick={() => actions.newSession()} style={smallPrimaryBtnStyle}>
                Start new session
              </button>
            )}
            {stoppable && (
              <button onClick={() => actions.stop()} style={smallSecondaryBtnStyle}>
                Stop session
              </button>
            )}
          </div>
        </div>

        {/* row 2 — the second control row follows the architecture */}
        {cascade ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <span style={eyebrowStyle}>Stages</span>
            {stages.map((stage) => (
              <button
                key={stage}
                data-stage-select={stage}
                onClick={() => actions.cycleProvider(stage)}
                title={`cycle ${stage} model (${MENUS[stage].length} options)`}
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 7,
                  border: '1px solid var(--border-default)',
                  borderRadius: 'var(--radius-md)',
                  padding: '5px 10px',
                  background: 'var(--surface-card)',
                  font: '400 11.5px var(--font-sans)',
                  color: 'var(--text-body)',
                  cursor: 'pointer',
                }}
              >
                <span style={{ color: 'var(--text-muted)' }}>{stage}</span>
                <span style={{ fontFamily: 'var(--font-mono)' }}>{state.providers[stage]}</span>
                <ChevronIcon />
              </button>
            ))}
          </div>
        ) : (
          <div
            data-context-policy={state.contextPolicy}
            style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}
          >
            <span style={eyebrowStyle}>Context</span>
            <div style={segWrapStyle}>
              <button
                aria-pressed={state.contextPolicy === 'default'}
                onClick={() => actions.setContextPolicy('default')}
                style={segBtnStyle(state.contextPolicy === 'default')}
              >
                default
              </button>
              <button
                aria-pressed={state.contextPolicy === 'trimmed'}
                onClick={() => actions.setContextPolicy('trimmed')}
                style={segBtnStyle(state.contextPolicy === 'trimmed')}
              >
                trimmed
              </button>
            </div>
            <span style={{ font: '400 11.5px var(--font-sans)', color: 'var(--text-secondary)' }}>
              {state.contextPolicy === 'default'
                ? 'full conversation replayed each turn — cost climbs with session length'
                : 'history deleted after each response — flat cost, measured against default'}
            </span>
          </div>
        )}
      </div>

      {/* status strip */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 16,
          flexWrap: 'wrap',
          font: '400 12px var(--font-sans)',
          color: 'var(--text-secondary)',
          padding: '0 4px',
        }}
      >
        <span
          data-mic-indicator={state.micPermission}
          style={{ display: 'inline-flex', alignItems: 'center', gap: 6, color: mic.color }}
        >
          {mic.icon && <MicIcon size={14} stroke="currentColor" />}
          {mic.label}
        </span>
        <span
          data-conn
          style={{ display: 'inline-flex', alignItems: 'center', gap: 6, color: connColor }}
        >
          {connLabel}
        </span>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          input
          <span
            data-input-meter
            style={{ display: 'flex', gap: 2, alignItems: 'flex-end', height: 14 }}
          >
            {meterHeights.map((h, i) => (
              <i
                key={i}
                data-meter-bar
                style={{
                  width: 3,
                  height: h,
                  borderRadius: 1,
                  background:
                    live && i < Math.max(controller.level, 1) ? 'var(--accent)' : 'var(--gray-300)',
                  display: 'block',
                }}
              />
            ))}
          </span>
        </span>
        <span data-state-label style={monoStyle}>
          {stateLabel(state)}
        </span>
        <span data-elapsed style={{ marginLeft: 'auto', ...monoStyle }}>
          {`${formatClock(controller.elapsedMs)} / ${formatClock(LIVE_MAX_SESSION_MS)} · autoplay on`}
        </span>
      </div>

      {/* banners */}
      {status === 'reconnecting' && (
        <Banner tone="warning">
          <RetryIcon />
          {`Reconnecting — attempt ${state.reconnectAttempts} of ${MAX_RECONNECT_ATTEMPTS} · transcript history preserved`}
        </Banner>
      )}
      {state.pending && (
        <Banner tone="warning">
          <ClockIcon />
          {`switching to ${state.pending.label} after this sentence finishes`}
        </Banner>
      )}
      {!stopped && warn.targetCantoOnRealtime && (
        <Banner tone="warning">
          <WarnIcon />
          Realtime does not list Cantonese as a supported output language — the run proceeds to
          observe the actual failure mode. Text may look correct while audio pronunciation is not.
        </Banner>
      )}
      {!stopped && warn.inputCantoOnRealtime && (
        <Banner tone="warning">
          <WarnIcon />
          Realtime does not document Cantonese speech input — recognition quality in this direction
          is unverified. The run proceeds to observe actual behavior.
        </Banner>
      )}
      {status === 'disconnected' && (
        <Banner tone="negative">
          <CrossCircleIcon />
          {`Disconnected — reconnect attempts exhausted (${MAX_RECONNECT_ATTEMPTS} of ${MAX_RECONNECT_ATTEMPTS}) · transcript history intact`}
          <button
            onClick={() => actions.reconnect()}
            style={{
              marginLeft: 'auto',
              border: '1px solid var(--negative)',
              borderRadius: 'var(--radius-md)',
              padding: '5px 12px',
              background: 'none',
              color: 'var(--negative)',
              font: '500 12px var(--font-sans)',
              cursor: 'pointer',
            }}
          >
            Reconnect
          </button>
        </Banner>
      )}
      {stopped && state.summary && (
        <Banner tone="positive">
          <CheckCircleIcon />
          {`Session ended · ${formatClock(state.summary.elapsedMs)} · ${state.summary.utterances} utterances · LiveSession metrics saved — audio discarded`}
        </Banner>
      )}

      {/* idle card */}
      {idleLike && (
        <div style={centeredCardStyle}>
          <MicIcon size={26} stroke="var(--gray-400)" />
          <div style={{ font: '600 14px var(--font-sans)', marginTop: 12 }}>No active session</div>
          <div
            style={{
              font: '400 12.5px var(--font-sans)',
              color: 'var(--text-secondary)',
              marginTop: 4,
              marginBottom: 18,
            }}
          >
            {`${src} → ${tgt} · ${modeLabel} · autoplay on · up to 5 minutes. Your browser will ask for microphone permission.`}
          </div>
          <button onClick={() => actions.start()} style={primaryBtnStyle}>
            Start microphone
          </button>
        </div>
      )}

      {/* permission-denied BLOCKING card (replaces the idle card, not dismissible) */}
      {denied && (
        <div data-denied-card style={centeredCardStyle}>
          <MicIcon size={26} stroke="var(--negative)" />
          <div style={{ font: '600 14px var(--font-sans)', marginTop: 12 }}>
            {MIC_DENIED_HEADING}
          </div>
          <div
            style={{
              font: '400 12.5px/1.7 var(--font-sans)',
              color: 'var(--text-secondary)',
              marginTop: 6,
              marginBottom: 18,
              maxWidth: 460,
              marginLeft: 'auto',
              marginRight: 'auto',
              textAlign: 'left',
            }}
          >
            <p style={{ margin: '0 0 8px' }}>
              This session cannot start until the microphone is unblocked.
            </p>
            <p style={{ margin: '0 0 8px' }}>{MIC_DENIED_SITE_PERMISSION}</p>
            <p style={{ margin: '0 0 8px' }}>{MIC_DENIED_OS_SETTING}</p>
            <p style={{ margin: 0 }}>{MIC_DENIED_NO_REPROMPT}</p>
          </div>
          <button onClick={() => actions.start()} style={primaryBtnStyle}>
            Retry microphone
          </button>
        </div>
      )}

      {showSessionArea && (
        <>
          {/* source card */}
          <div data-source-card style={{ ...cardStyle, padding: '16px 18px' }}>
            <div
              style={{
                display: 'flex',
                alignItems: 'baseline',
                justifyContent: 'space-between',
                gap: 12,
              }}
            >
              <span style={eyebrowStyle}>{`Source · ${src}`}</span>
              <span style={{ ...monoStyle, color: 'var(--text-muted)' }}>
                utterance {state.utteranceCount}
              </span>
            </div>
            <div style={{ font: '400 15px/1.6 var(--font-sans)', marginTop: 8, minHeight: 24 }}>
              {controller.sourceText}
            </div>
          </div>

          {/* THE single target card — no grid, no add pill, no audible selector */}
          <TargetCard architecture={state.mode} recipe={recipe} target={target} />
        </>
      )}

      {/* session footer — figures from ledger aggregates; NO illustrative pill */}
      <div
        data-session-footer
        style={{
          display: 'flex',
          gap: 18,
          flexWrap: 'wrap',
          font: '400 11.5px var(--font-sans)',
          color: 'var(--text-muted)',
          borderTop: '1px solid var(--border-default)',
          paddingTop: 12,
          paddingLeft: 4,
        }}
      >
        <span>{footer.utterances} utterances</span>
        <span>
          p50{' '}
          <span style={{ fontFamily: 'var(--font-mono)' }}>
            {footer.p50Ms === null ? '—' : `${(footer.p50Ms / 1000).toFixed(2)} s`}
          </span>
        </span>
        <span>
          p95{' '}
          <span style={{ fontFamily: 'var(--font-mono)' }}>
            {footer.p95Ms === null ? '—' : `${(footer.p95Ms / 1000).toFixed(2)} s`}
          </span>
        </span>
        <span>
          session{' '}
          <span style={{ fontFamily: 'var(--font-mono)' }}>{`$${footer.costUsd.toFixed(2)}`}</span>
        </span>
      </div>
    </>
  );
}
