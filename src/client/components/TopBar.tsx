/**
 * Ticket 012/016 — App-level top bar.
 *
 * 52px sticky bar per the design mock, marked [data-topbar]: mic glyph +
 * 'Interpreter workbench' wordmark, the segmented view control, and the
 * right-hand status area. Lives at app level (not inside the Live view)
 * because it hosts the view tabs; App owns the current view and passes it
 * down.
 *
 * DOM contract (locked by App.test.tsx + LiveView tests):
 * - EXACTLY FOUR tab buttons, in this order and named exactly: 'Live',
 *   'Replay', 'Results', 'Help'. They are the only children of the segmented
 *   group, and aria-pressed reflects the current view (true on exactly one).
 *   The names are the contract — LiveView.test.tsx reaches for the button
 *   named 'Results' by name.
 * - Pulsing live dot + 'live' text, marked [data-live-dot], rendered
 *   whenever `live` is true. `live` means A SESSION IS RUNNING, and nothing
 *   else: it is emphatically NOT gated on the open tab. A running session
 *   burns its five-minute budget while the user reads Replay, Results or
 *   Help, and hiding the dot there would be a lie about the app's state.
 *   Absent while idle / stopped / disconnected / reconnecting.
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
  /**
   * True while a session is actively running — INDEPENDENT of the open tab.
   * See the header: the dot describes the session, not the navigation.
   */
  live: boolean;
  /** Mono provenance line; null hides it (every view except Results). */
  provenance: string | null;
}

/**
 * The tabs, in render order, each paired with the label the user reads. The
 * label IS the accessible name, so this table is the naming contract.
 */
const TABS: ReadonlyArray<{ view: WorkbenchView; label: string }> = [
  { view: 'live', label: 'Live' },
  { view: 'replay', label: 'Replay' },
  { view: 'results', label: 'Results' },
  { view: 'help', label: 'Help' },
];

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
      data-topbar=""
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
        {TABS.map((entry) => (
          <button
            key={entry.view}
            type="button"
            aria-pressed={view === entry.view}
            onClick={() => onViewChange(entry.view)}
            style={tabStyle(view === entry.view)}
          >
            {entry.label}
          </button>
        ))}
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
