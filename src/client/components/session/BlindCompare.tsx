/**
 * Ticket 014 — Blind compare (STUB — tests written first).
 *
 * Comparison-mode-only blind A/B rating of the arms' TTS output, per PRD §9
 * and the blind-compare section of
 * design_handoff_interpreter_workbench/interpreter-workbench.dc.html.
 * SessionView renders this component after the arm-cards grid, ONLY while
 * more than one arm is active. First component under the ticket-012
 * decomposition directory src/client/components/session/.
 *
 * Wiring (implementer's choice, documented intent): the blind-compare LOGIC
 * (open/close, draw, scores, submit) belongs in useSessionController — a
 * `blind` slice on the controller — because it needs deps.ledger, deps.rng,
 * deps.now and the per-arm playbacks; this component renders that slice.
 * A component-local implementation taking those seams as props is equally
 * acceptable — the locked contract is the DOM below plus the ledger calls.
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
 * - Record the draw AT OPEN TIME via ledger.recordBlindDraw({
 *     id,            — fresh unique id per open
 *     utteranceId,   — the current utterance's record id ('utt-{n}'), so
 *                      exportRuns() attaches the draw to the session run
 *     order,         — arm ids in presented order; order[0] is Sample A
 *     createdAt,     — deps.now()
 *   }).
 * - Card [data-blind-card]: title 'Compare blind', hint 'arm identity
 *   hidden until you submit', two panels [data-blind-sample="A"|"B"] each
 *   with title 'Sample A'/'Sample B', a play button named exactly 'play',
 *   and five score buttons '1'..'5' carrying aria-pressed (selected =
 *   accent-soft, keyed off aria-pressed); footer note 'rate fluency 1–5 ·
 *   order randomized · scores append to the run ledger'; submit button
 *   'submit ratings'.
 * - PRE-SUBMIT the arm identities (labels 'Realtime', 'Cascade · OpenAI',
 *   'Cascade · best-of-breed') are ABSENT from the card DOM — not hidden
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

import type { ReactElement } from 'react';
import type { SessionController } from '../../views/useSessionController';

export interface BlindCompareProps {
  controller: SessionController;
}

export default function BlindCompare(_props: BlindCompareProps): ReactElement {
  throw new Error('BlindCompare not implemented (ticket 014)');
}
