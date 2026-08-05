/**
 * Ticket 012 — App-level top bar (STUB — tests written first).
 *
 * 52px sticky bar per the design mock: mic glyph + 'Interpreter workbench'
 * wordmark, Session/Results segmented control, and the right-hand status
 * area. Lives at app level (not inside SessionView) because it hosts the
 * view tabs; App owns the current view and passes it down.
 *
 * DOM contract (locked by App.test.tsx + SessionView tests):
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

import type { ReactElement } from 'react';

export type WorkbenchView = 'session' | 'results';

export interface TopBarProps {
  view: WorkbenchView;
  onViewChange: (view: WorkbenchView) => void;
  /** True only while a session is actively running (live dot). */
  live: boolean;
  /** Mono provenance line; null hides it (Session view). */
  provenance: string | null;
}

export default function TopBar(_props: TopBarProps): ReactElement {
  throw new Error('TopBar not implemented (ticket 012)');
}
