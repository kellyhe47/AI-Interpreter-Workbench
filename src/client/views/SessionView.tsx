/**
 * Ticket 012 — Session view.
 *
 * `<SessionView controller={useSessionController(deps)} />` — recreates the
 * design mock (design_handoff_interpreter_workbench/interpreter-workbench.dc.html,
 * Session view) in React/TS on top of the REAL session machine, transports,
 * audio, and ledger. The controller hook is owned by App (it also feeds the
 * TopBar live dot); this component renders what the controller returns.
 * Styles/copy follow the mock exactly through tokens.css CSS vars, with the
 * PRD-mandated deviations below.
 *
 * ========================= DOM CONTRACT (locked) ===========================
 * Locked by SessionView.test.tsx + SessionView.flow.test.tsx. Test hooks are
 * style-agnostic data attributes; user-facing copy is asserted verbatim.
 *
 * DEVIATIONS FROM THE MOCK (PRD wins — do not "fix" these back):
 * - NO "Mock state" chips row. The text 'Mock state' must never render.
 * - Mic permission is a LIVE four-value indicator (see below), not the
 *   mock's hardcoded 'mic allowed'.
 * - The stopped banner shows REAL machine-summary numbers, never the mock's
 *   'Session stopped · 5:02 · 32 utterances · 0 dropped · $0.71' string.
 * - Session footer figures come from ledger aggregates for the live session;
 *   the amber 'figures illustrative' pill NEVER renders (it existed only for
 *   the mock's made-up figures). The utterance count still renders.
 * - Cantonese warnings render whenever warnings() fires and status is not
 *   'stopped' — including idle (see useSessionController.ts).
 *
 * Idle card (status 'idle'):
 *   'No active session' + subline
 *   '{src} → {tgt} · {Mode label} · autoplay on. Your browser will ask for
 *    microphone permission.' + primary button 'Start microphone'.
 *
 * Mic indicator — single element [data-mic-indicator="<value>"]:
 *   not-requested → 'mic not requested' (muted)
 *   requesting    → 'mic prompt open…'  (amber)
 *   granted       → 'mic allowed'       (green, mic icon)
 *   denied        → 'mic blocked'       (red)
 *
 * Permission-denied BLOCKING card [data-denied-card] (replaces the idle
 * card, idle-card visual pattern, NOT dismissible — no close control):
 *   heading 'Microphone blocked'
 *   'This session cannot start until the microphone is unblocked.'
 *   'Check the browser site permission: allow microphone access for this
 *    site (look for the mic icon in the address bar).'
 *   'Check the OS microphone setting: your system privacy settings must
 *    allow this browser to use the microphone.'
 *   'Browsers do not re-prompt after a denial — reset the site permission
 *    first, then retry.'
 *   button 'Retry microphone' (dispatches START — a machine no-op while
 *   denied, so capture is NOT re-invoked).
 *
 * Controls card (always visible): mode buttons 'Realtime' / 'Cascade' with
 * aria-pressed reflecting the APPLIED mode; language button labelled
 * '{src} → {tgt}'; direction button aria-label 'Swap direction'; support
 * pill 'both modes' | 'cascade only'; autoplay checkbox labelled 'autoplay'
 * (rendered only when exactly one arm and not stopped); 'Stop session'
 * while stoppable, 'Start new session' when stopped.
 *
 * Status strip: [data-conn] 'no connection' (idle/stopped) | 'connected' |
 * 'reconnecting…' | 'disconnected'; [data-state-label] = machine status
 * (mono); [data-elapsed] mm:ss zero-padded ('00:00' idle, frozen at stop);
 * [data-autoplay-label] 'autoplay on' | 'autoplay off'.
 *
 * Banners (copy verbatim):
 *   switch queued  'switching to {label} after this sentence finishes'
 *   reconnecting   'Reconnecting — attempt {n} of 5 · transcript history
 *                   preserved'
 *   disconnected   'Disconnected — reconnect attempts exhausted (5 of 5) ·
 *                   transcript history intact' + button 'Reconnect'
 *   canto target   'Realtime does not list Cantonese as a supported output
 *                   language — the run proceeds to observe the actual
 *                   failure mode. Text may look correct while audio
 *                   pronunciation is not.'
 *   canto input    'Realtime does not document Cantonese speech input —
 *                   recognition quality in this direction is unverified.
 *                   The run proceeds to observe actual behavior.'
 *   stopped (green)'Session stopped · {m:ss} · {n} utterances · {d} dropped
 *                   · ${costUsd.toFixed(2)}' — REAL summary numbers.
 *
 * Arms strip (visible when not idle): label 'Arms'; per-arm pill
 * [data-arm-pill="<armId>"] (Realtime accent-soft, cascades gray), remove
 * button aria-label 'remove {label}' when >1 arm; dashed add pill button
 * '+ {label} · ${cost.toFixed(3)}/min' while <3 arms; multi-arm note
 * 'autoplay off — two arms would talk over each other'.
 *
 * Source card [data-source-card]: 'Source · {srcLang}' plus
 * ' — shared by every arm' suffix only in comparison mode; accumulated
 * partial text replaced by the final transcript.
 *
 * Arm cards [data-arm-card="<armId>"] with [data-arm-status] in
 * 'in-flight' | 'ready' | 'playing' | 'failed':
 *   in-flight → indeterminate bar [data-inflight-bar]
 *   ready     → target text; play button 'play' + mono duration
 *               `${(durationMs/1000).toFixed(1)} s`; stage rows
 *               [data-stage-row="<label>"] with LABELLED mono ms
 *               (`${ms} ms`) — cascade rows endpointing/stt/mt/tts/queue,
 *               realtime rows endpointing/model/queue; footer 'total'
 *               `${totalMs} ms` + `$${costPerMinUsd.toFixed(3)}/min` +
 *               intervals note '5 intervals · all visible' (cascade) |
 *               '3 intervals · 1 opaque' (realtime); realtime additionally
 *               renders the opaque footnote 'model interval is opaque —
 *               recognition, translation and voice happen inside one model
 *               · source transcript comes from a parallel recognizer, not
 *               the model itself'.
 *   failed    → cascade: '{server message} — session still running';
 *               realtime: 'opaque failure — no stage attribution · session
 *               still running'. Session survives (status strip stays live).
 *
 * Session footer [data-session-footer]: '{utteranceCount} utterances',
 * 'p50' / 'p95' with mono `${(ms/1000).toFixed(2)} s` (or '—' with no
 * samples), 'session' with `$${costUsd.toFixed(2)}` — all from
 * ledger.aggregates(sessionRunId). NO 'figures illustrative' pill, ever.
 * ==========================================================================
 */

import type { CSSProperties, ReactElement, ReactNode } from 'react';
import {
  deriveCascadeIntervals,
  deriveRealtimeIntervals,
  type CascadeTimestamps,
  type RealtimeTimestamps,
} from '../../core/timing';
import {
  MAX_RECONNECT_ATTEMPTS,
  pairs,
  supportPill,
  warnings,
  type SessionStatus,
} from '../state/sessionMachine';
import type { ArmDef, ArmUtteranceView, SessionController } from './useSessionController';

export interface SessionViewProps {
  controller: SessionController;
}

const AMBER = 'oklch(45% 0.12 75)';

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
// Shared styles (mirroring the mock's inline styles via tokens.css vars)
// ---------------------------------------------------------------------------

const cardStyle: CSSProperties = {
  background: 'var(--surface-card)',
  border: '1px solid var(--border-default)',
  borderRadius: 12,
  boxShadow: '0 1px 2px rgba(0,0,0,.05)',
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
  borderRadius: 8,
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
  borderRadius: 8,
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
  borderRadius: 8,
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
    borderRadius: 8,
    padding: '10px 14px',
    font: '400 12.5px var(--font-sans)',
  };
}

const monoStyle: CSSProperties = { fontFamily: 'var(--font-mono)', fontSize: 11 };

// ---------------------------------------------------------------------------
// Icons (Lucide-style outline, 1.5px stroke — copied from the mock)
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

function PlayGlyph(): ReactElement {
  return (
    <svg width={14} height={14} viewBox="0 0 24 24" fill="currentColor" aria-hidden>
      <path d="M7 5.5v13a1 1 0 0 0 1.54.84l10-6.5a1 1 0 0 0 0-1.68l-10-6.5A1 1 0 0 0 7 5.5z" />
    </svg>
  );
}

function PauseGlyph(): ReactElement {
  return (
    <svg width={14} height={14} viewBox="0 0 24 24" fill="currentColor" aria-hidden>
      <rect x="6" y="5" width="4" height="14" rx="1" />
      <rect x="14" y="5" width="4" height="14" rx="1" />
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

/** mm:ss with both fields zero-padded (status strip). */
function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

/** m:ss with unpadded minutes (stopped summary banner). */
function formatSummaryElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

interface StageRow {
  label: string;
  ms: number | null;
}

function stageRowsFor(def: ArmDef, view: ArmUtteranceView): { rows: StageRow[]; total: number | null } {
  if (def.mode === 'cascade') {
    const iv = deriveCascadeIntervals(view.timings as CascadeTimestamps);
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
  const iv = deriveRealtimeIntervals(view.timings as RealtimeTimestamps);
  return {
    rows: [
      { label: 'endpointing', ms: iv.endpointing },
      { label: 'model', ms: iv.model },
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
    warning: bannerStyle('var(--warning-soft)', AMBER),
    negative: bannerStyle('var(--negative-soft)', 'var(--negative)'),
    positive: bannerStyle('var(--positive-soft)', 'var(--positive)'),
  };
  return <div style={styles[tone]}>{children}</div>;
}

function AutoplaySwitch({
  checked,
  onChange,
}: {
  checked: boolean;
  onChange: (value: boolean) => void;
}): ReactElement {
  return (
    <label
      style={{
        position: 'relative',
        display: 'inline-flex',
        alignItems: 'center',
        gap: 7,
        font: '400 12px var(--font-sans)',
        color: 'var(--text-secondary)',
        cursor: 'pointer',
      }}
    >
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        style={{
          position: 'absolute',
          opacity: 0,
          width: 36,
          height: 20,
          margin: 0,
          cursor: 'pointer',
        }}
      />
      <span
        aria-hidden
        style={{
          width: 36,
          height: 20,
          borderRadius: 999,
          background: checked ? 'var(--accent)' : 'var(--gray-300)',
          position: 'relative',
          display: 'inline-block',
          transition: 'background 150ms var(--ease-out)',
        }}
      >
        <i
          style={{
            position: 'absolute',
            top: 2,
            left: checked ? 18 : 2,
            width: 16,
            height: 16,
            borderRadius: 999,
            background: '#fff',
            boxShadow: '0 1px 2px rgba(0,0,0,.15)',
            transition: 'left 150ms var(--ease-out)',
          }}
        />
      </span>
      autoplay
    </label>
  );
}

function ArmCard({
  def,
  view,
  playing,
  stopped,
  onTogglePlay,
}: {
  def: ArmDef;
  view: ArmUtteranceView;
  playing: boolean;
  stopped: boolean;
  onTogglePlay: () => void;
}): ReactElement {
  const failed = view.status === 'failed';
  const inFlight = view.status === 'in-flight';
  const ready = !inFlight && !failed;
  const displayStatus = failed ? 'failed' : playing ? 'playing' : view.status;
  const statusLabel = failed ? 'failed' : inFlight ? 'in flight' : playing ? 'playing' : 'ready';
  const statusColor = failed
    ? 'var(--negative)'
    : inFlight
      ? 'var(--text-secondary)'
      : 'var(--positive)';
  const { rows, total } = stageRowsFor(def, view);
  const showDetails = ready && view.hasData;

  return (
    <div
      data-arm-card={def.id}
      data-arm-status={displayStatus}
      style={{
        ...cardStyle,
        padding: '16px 18px',
        display: 'flex',
        flexDirection: 'column',
        gap: 10,
      }}
    >
      <div
        style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10 }}
      >
        <span style={{ font: '600 13px var(--font-sans)' }}>{def.label}</span>
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
          style={{ height: 5, background: 'var(--gray-100)', borderRadius: 3, overflow: 'hidden' }}
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
          {view.targetText}
        </div>
      )}

      {failed && (
        <div
          style={{
            background: 'var(--negative-soft)',
            color: 'var(--negative)',
            borderRadius: 8,
            padding: '9px 12px',
            font: '400 12px var(--font-sans)',
          }}
        >
          {view.failMessage}
        </div>
      )}

      {showDetails && !stopped && (
        <button
          onClick={onTogglePlay}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 7,
            border: `1px solid ${playing ? 'var(--accent)' : 'var(--border-default)'}`,
            borderRadius: 8,
            padding: '7px 12px',
            background: 'var(--surface-card)',
            font: '500 12px var(--font-sans)',
            cursor: 'pointer',
            width: '100%',
            color: playing ? 'var(--accent)' : 'var(--text-body)',
          }}
        >
          {playing ? <PauseGlyph /> : <PlayGlyph />}
          {playing ? 'pause' : 'play'}
          <span style={{ ...monoStyle, color: 'var(--text-muted)', marginLeft: 'auto' }}>
            {(view.durationMs / 1000).toFixed(1)} s
          </span>
        </button>
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
                  gridTemplateColumns: '82px 1fr 58px',
                  gap: '0 10px',
                  alignItems: 'center',
                  font: '400 11.5px var(--font-sans)',
                }}
              >
                <span style={{ color: 'var(--text-secondary)' }}>{row.label}</span>
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
          <span style={monoStyle}>{`$${def.costPerMinUsd.toFixed(3)}/min`}</span>
          <span style={{ color: 'var(--text-muted)' }}>
            {def.mode === 'cascade' ? '5 intervals · all visible' : '3 intervals · 1 opaque'}
          </span>
        </div>
      )}

      {showDetails && def.mode === 'realtime' && (
        <div
          style={{
            background: 'var(--surface-sunken)',
            borderRadius: 8,
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

export default function SessionView({ controller }: SessionViewProps): ReactElement {
  const { state, actions, footer } = controller;
  const status = state.status;
  const pair = pairs[state.langIdx] ?? pairs[0]!;
  const src = state.reversed ? pair.tgt : pair.src;
  const tgt = state.reversed ? pair.src : pair.tgt;
  const modeLabel = state.mode === 'realtime' ? 'Realtime' : 'Cascade';
  const stopped = status === 'stopped';
  const idleLike = status === 'idle' || status === 'requesting-permission';
  const denied = status === 'permission-denied';
  const showSessionArea = !idleLike && !denied;
  const multi = state.arms.length > 1;
  const singleArm = state.arms.length === 1;
  const stoppable = STOPPABLE_STATUSES.includes(status);
  const live = CONNECTED_STATUSES.includes(status);
  const warn = warnings(
    state.langIdx,
    state.reversed,
    controller.activeArms.map((d) => d.mode),
  );
  const pill = supportPill(state.langIdx);

  // Connection label derives from machine status.
  let connLabel: string;
  let connColor: string;
  if (status === 'reconnecting') {
    connLabel = 'reconnecting…';
    connColor = AMBER;
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
    requesting: { label: 'mic prompt open…', color: AMBER, icon: false },
    granted: { label: 'mic allowed', color: 'var(--positive)', icon: true },
    denied: { label: 'mic blocked', color: 'var(--negative)', icon: false },
  };
  const mic = micByPermission[state.micPermission]!;

  const meterHeights = [5, 9, 13, 7, 4];

  return (
    <>
      {/* controls card — always visible per PRD */}
      <div
        style={{
          ...cardStyle,
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          flexWrap: 'wrap',
          padding: '14px 16px',
          boxShadow: 'var(--shadow-card, 0 1px 2px rgba(0,0,0,.05))',
        }}
      >
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
        <button
          onClick={() => actions.cycleLanguage()}
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 8,
            border: '1px solid var(--border-default)',
            borderRadius: 8,
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
            borderRadius: 8,
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
            borderRadius: 999,
            padding: '3px 9px',
            background: pill === 'cascade only' ? 'var(--warning-soft)' : 'var(--surface-selected)',
            color: pill === 'cascade only' ? AMBER : 'var(--text-secondary)',
          }}
        >
          {pill}
        </span>
        <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 10 }}>
          {singleArm && !stopped && (
            <AutoplaySwitch checked={state.autoplay} onChange={actions.setAutoplay} />
          )}
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
          <span style={{ display: 'flex', gap: 2, alignItems: 'flex-end', height: 14 }}>
            {meterHeights.map((h, i) => (
              <i
                key={i}
                style={{
                  width: 3,
                  height: h,
                  borderRadius: 1,
                  background:
                    live && i < Math.max(controller.level, 1)
                      ? 'var(--accent)'
                      : 'var(--gray-300)',
                  display: 'block',
                }}
              />
            ))}
          </span>
        </span>
        <span data-state-label style={monoStyle}>
          {status}
        </span>
        <span
          style={{
            marginLeft: 'auto',
            ...monoStyle,
            display: 'inline-flex',
            alignItems: 'center',
            gap: 4,
          }}
        >
          <span data-elapsed>{formatElapsed(controller.elapsedMs)}</span>
          {' · '}
          <span data-autoplay-label>{state.autoplay ? 'autoplay on' : 'autoplay off'}</span>
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
              borderRadius: 8,
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
          {`Session stopped · ${formatSummaryElapsed(state.summary.elapsedMs)} · ${state.summary.utterances} utterances · ${state.summary.dropped} dropped · $${state.summary.costUsd.toFixed(2)}`}
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
            {`${src} → ${tgt} · ${modeLabel} · autoplay ${state.autoplay ? 'on' : 'off'}. Your browser will ask for microphone permission.`}
          </div>
          <button onClick={() => actions.start()} style={primaryBtnStyle}>
            Start microphone
          </button>
        </div>
      )}

      {/* permission-denied blocking card (replaces the idle card, not dismissible) */}
      {denied && (
        <div data-denied-card style={centeredCardStyle}>
          <MicIcon size={26} stroke="var(--negative)" />
          <div style={{ font: '600 14px var(--font-sans)', marginTop: 12 }}>Microphone blocked</div>
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
            <p style={{ margin: '0 0 8px' }}>
              Check the browser site permission: allow microphone access for this site (look for
              the mic icon in the address bar).
            </p>
            <p style={{ margin: '0 0 8px' }}>
              Check the OS microphone setting: your system privacy settings must allow this browser
              to use the microphone.
            </p>
            <p style={{ margin: 0 }}>
              Browsers do not re-prompt after a denial — reset the site permission first, then
              retry.
            </p>
          </div>
          <button onClick={() => actions.start()} style={primaryBtnStyle}>
            Retry microphone
          </button>
        </div>
      )}

      {showSessionArea && (
        <>
          {/* arms strip */}
          <div
            style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', padding: '0 4px' }}
          >
            <span style={eyebrowStyle}>Arms</span>
            {controller.activeArms.map((def) => (
              <span
                key={def.id}
                data-arm-pill={def.id}
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  font: '400 11.5px var(--font-sans)',
                  background:
                    def.id === 'realtime' ? 'var(--accent-soft)' : 'var(--surface-selected)',
                  color: def.id === 'realtime' ? 'var(--accent)' : 'var(--text-body)',
                  borderRadius: 999,
                  padding: '4px 11px',
                }}
              >
                {def.label}
                {multi && (
                  <button
                    aria-label={`remove ${def.label}`}
                    onClick={() => actions.removeArm(def.id)}
                    style={{
                      border: 'none',
                      background: 'none',
                      cursor: 'pointer',
                      padding: 0,
                      marginLeft: 5,
                      color: 'inherit',
                      font: 'inherit',
                      lineHeight: 1,
                    }}
                  >
                    ×
                  </button>
                )}
              </span>
            ))}
            {controller.nextArm && !stopped && (
              <button
                onClick={() => actions.addArm()}
                style={{
                  font: '400 11.5px var(--font-sans)',
                  border: '1px dashed var(--border-strong)',
                  color: 'var(--text-secondary)',
                  borderRadius: 999,
                  padding: '4px 11px',
                  background: 'none',
                  cursor: 'pointer',
                }}
              >
                {`+ ${controller.nextArm.label} · $${controller.nextArm.costPerMinUsd.toFixed(3)}/min`}
              </button>
            )}
            {multi && (
              <span
                style={{
                  font: '400 11.5px var(--font-sans)',
                  color: 'var(--text-muted)',
                  marginLeft: 'auto',
                }}
              >
                autoplay off — two arms would talk over each other
              </span>
            )}
          </div>

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
              <span style={eyebrowStyle}>
                {`Source · ${src}${multi ? ' — shared by every arm' : ''}`}
              </span>
              <span style={{ ...monoStyle, color: 'var(--text-muted)' }}>
                utterance {state.utteranceCount}
              </span>
            </div>
            <div style={{ font: '400 15px/1.6 var(--font-sans)', marginTop: 8, minHeight: 24 }}>
              {controller.sourceText}
            </div>
          </div>

          {/* arm cards */}
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: `repeat(${Math.min(Math.max(state.arms.length, 1), 3)},1fr)`,
              gap: 14,
            }}
          >
            {controller.activeArms.map((def) => (
              <ArmCard
                key={def.id}
                def={def}
                view={controller.armViews[def.id] ?? { ...emptyArmView }}
                playing={state.playingArm === def.id}
                stopped={stopped}
                onTogglePlay={() => actions.togglePlay(def.id)}
              />
            ))}
          </div>
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

const emptyArmView: ArmUtteranceView = {
  utt: -1,
  status: 'ready',
  hasData: false,
  targetText: '',
  targetPartials: [],
  sourcePartials: [],
  sourceFinal: '',
  failMessage: null,
  timings: {},
  durationMs: 0,
};
