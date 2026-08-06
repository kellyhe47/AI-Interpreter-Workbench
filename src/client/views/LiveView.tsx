/**
 * Ticket 012 — Live view (renamed from SessionView; ONE architecture).
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
 *
 * Header: 'Live' + purpose line
 *   'One architecture, voice in → voice out, up to 5 minutes. Metrics are
 *    saved; audio is discarded. Nothing here becomes experimental evidence.'
 *
 * Controls card row 1:
 *   Realtime / Cascade segmented buttons, aria-pressed = APPLIED mode.
 *   [data-arm-tag="A|B|C|ad-hoc"] pill, text 'this is Arm B' | 'ad-hoc'.
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
 *
 * Permission-denied BLOCKING card [data-denied-card]: names BOTH the site
 * permission and the OS permission layers, says browsers do not re-prompt,
 * and offers 'Retry microphone' (a machine no-op while denied).
 *
 * Session cards: [data-source-card]; exactly ONE [data-target-card] with
 * [data-target-status] in 'in-flight' | 'ready' | 'playing' | 'failed',
 * [data-target-arch] naming the architecture, [data-stage-row="<label>"]
 * rows carrying LABELLED milliseconds, and the intervals note.
 * NO arm grid, NO add-arm pill, NO audible-arm selector.
 *
 * [data-session-footer]: '{n} utterances', p50 / p95 / session $ from
 * ledger.aggregates(sessionRunId).
 * ==========================================================================
 */

import type { ReactElement } from 'react';
import type { SessionController } from './useSessionController';

export interface LiveViewProps {
  controller: SessionController;
}

/** STUB (ticket 012 red phase). */
export default function LiveView(_props: LiveViewProps): ReactElement {
  return <div data-live-view />;
}
