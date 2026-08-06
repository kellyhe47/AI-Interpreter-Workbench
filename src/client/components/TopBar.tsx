/**
 * Ticket 012 — App-level top bar.
 *
 * 52px sticky bar per the design mock: mic glyph + 'Interpreter workbench'
 * wordmark, Session/Results segmented control, and the right-hand status
 * area. Lives at app level (not inside the Live view) because it hosts the
 * view tabs; App owns the current view and passes it down.
 *
 * DOM contract (locked by App.test.tsx + LiveView tests):
 * - Tab buttons named exactly 'Session' and 'Results', with aria-pressed
 *   reflecting the current view.
 * - Pulsing live dot + 'live' text, marked [data-live-dot], rendered ONLY
 *   while `live` is true (an active session on the Session view). Absent
 *   while idle / stopped / disconnected / reconnecting and on Results.
 * - Mono run-provenance text (e.g. 'run 2026-08-05 · corpus v1'), marked
 *   [data-provenance-run], rendered ONLY when `provenance` is non-null —
 *   App passes it on the Results view only (a live session is not a run;
 *   README calls showing provenance over it a category error). Date derives
 *   from deps.now() (ISO YYYY-MM-DD), corpus tag 'corpus v1'.
 */

import type { CSSProperties, ReactElement } from 'react';

/**
 * Ticket 016 — four tabs. 'session' was renamed 'live' so the value matches
 * the tab the user sees; Replay and Help joined it.
 */
export type WorkbenchView = 'live' | 'replay' | 'results' | 'help';

export interface TopBarProps {
  view: WorkbenchView;
  onViewChange: (view: WorkbenchView) => void;
  /** True only while a session is actively running (live dot). */
  live: boolean;
  /** Mono provenance line; null hides it (Session view). */
  provenance: string | null;
}

function tabStyle(on: boolean): CSSProperties {
  return {
    border: 'none',
    cursor: 'pointer',
    padding: '7px 16px',
    font: 'inherit',
    color: on ? 'var(--text-body)' : 'var(--text-secondary)',
    background: on ? 'var(--surface-selected)' : 'var(--surface-card)',
  };
}

export default function TopBar({ view, onViewChange, live, provenance }: TopBarProps): ReactElement {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 16,
        padding: '0 24px',
        height: 52,
        background: 'var(--surface-card)',
        borderBottom: '1px solid var(--border-default)',
        position: 'sticky',
        top: 0,
        zIndex: 20,
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 9,
          font: '600 14px var(--font-sans)',
          letterSpacing: '-0.01em',
        }}
      >
        <svg
          width={16}
          height={16}
          viewBox="0 0 24 24"
          fill="none"
          stroke="var(--accent)"
          strokeWidth={1.5}
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden
        >
          <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3z" />
          <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
          <path d="M12 19v3" />
        </svg>
        Interpreter workbench
      </div>
      <div
        style={{
          display: 'flex',
          border: '1px solid var(--border-default)',
          borderRadius: 8,
          overflow: 'hidden',
          font: '500 12.5px var(--font-sans)',
        }}
      >
        <button
          aria-pressed={view === 'live'}
          onClick={() => onViewChange('live')}
          style={tabStyle(view === 'live')}
        >
          Session
        </button>
        <button
          aria-pressed={view === 'results'}
          onClick={() => onViewChange('results')}
          style={tabStyle(view === 'results')}
        >
          Results
        </button>
      </div>
      <div
        style={{
          marginLeft: 'auto',
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          font: '400 12px var(--font-sans)',
          color: 'var(--text-secondary)',
        }}
      >
        {live && (
          <span data-live-dot style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            <i
              style={{
                width: 7,
                height: 7,
                borderRadius: 99,
                background: 'var(--accent)',
                animation: 'wb-dot 1.6s infinite',
              }}
            />
            live
          </span>
        )}
        {provenance !== null && (
          <span data-provenance-run style={{ fontFamily: 'var(--font-mono)', fontSize: 11 }}>
            {provenance}
          </span>
        )}
      </div>
    </div>
  );
}
