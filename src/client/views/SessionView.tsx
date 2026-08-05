/**
 * Ticket 012 — Session view (STUB — tests written first).
 *
 * `<SessionView deps={sessionDeps} />` — recreates the design mock
 * (design_handoff_interpreter_workbench/interpreter-workbench.dc.html,
 * Session view) in React/TS on top of the REAL session machine, transports,
 * audio, and ledger via useSessionController(deps). Styles/copy follow the
 * mock exactly through tokens.css CSS vars, with the PRD-mandated
 * deviations below.
 *
 * Planned decomposition (src/client/components/session/):
 *   ControlsCard.tsx  — mode toggle, language button, direction swap,
 *                       support pill, autoplay switch, stop/start-new
 *   StatusStrip.tsx   — mic indicator, connection, level meter, state label,
 *                       elapsed · autoplay label
 *   Banners.tsx       — switch-queued / reconnecting / disconnected /
 *                       Cantonese warnings / stopped summary
 *   MicBlockedCard.tsx— blocking permission-denied remediation card
 *   ArmsStrip.tsx     — arm pills, add-arm pill, multi-arm autoplay note
 *   SourceCard.tsx    — shared source transcript card
 *   ArmCard.tsx       — per-arm target text, play button, stage rows, footer
 *   SessionFooter.tsx — utterance count, p50/p95/session $ from the ledger
 * (TopBar is app-level: src/client/components/TopBar.tsx.)
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

import type { ReactElement } from 'react';
import type { SessionDeps } from './useSessionController';

export interface SessionViewProps {
  deps: SessionDeps;
}

export default function SessionView(_props: SessionViewProps): ReactElement {
  throw new Error('SessionView not implemented (ticket 012)');
}
